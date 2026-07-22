'use strict';

const path = require('node:path');
const { verifyBackupSet } = require('../../ops/lib/backupCore');

const MIGRATION_REPORT_FORMAT = 'task-review-stage-round-migration/v1';
const TASK_COLLECTION = 'tasks';
const TASK_REVIEW_COLLECTION = 'taskreviews';
const AUDIT_LOG_COLLECTION = 'audit_logs';
const TASK_REVIEW_STAGES = Object.freeze({
  REVIEW: 'review',
  CONFIRMATION: 'confirmation'
});
const TASK_REVIEW_STAGE_VALUES = Object.freeze(Object.values(TASK_REVIEW_STAGES));
const TASK_REVIEW_STAGE_SET = new Set(TASK_REVIEW_STAGE_VALUES);
const REQUIRED_BACKUP_COLLECTIONS = Object.freeze([TASK_COLLECTION, TASK_REVIEW_COLLECTION]);
const DESIRED_INDEX = Object.freeze({
  name: 'uq_task_review_stage_round',
  key: Object.freeze({ teamId: 1, task: 1, reviewer: 1, stage: 1, reviewRound: 1 }),
  unique: true
});
const LEGACY_RESTRICTIVE_INDEX_KEYS = Object.freeze([
  Object.freeze({ task: 1, reviewer: 1 }),
  Object.freeze({ teamId: 1, task: 1, reviewer: 1 }),
  Object.freeze({ teamId: 1, task: 1, reviewer: 1, stage: 1 })
]);

class TaskReviewStageMigrationError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'TaskReviewStageMigrationError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new TaskReviewStageMigrationError(code, message, details);
}

function databaseNameOf(connection) {
  return connection?.name || connection?.db?.databaseName || null;
}

function isMissing(value) {
  return value === undefined || value === null || value === '';
}

function isValidReviewRound(value) {
  return Number.isInteger(value) && value >= 1;
}

function sameIndexKey(actual, expected) {
  if (!actual || !expected) return false;
  const actualEntries = Object.entries(actual);
  const expectedEntries = Object.entries(expected);
  return actualEntries.length === expectedEntries.length && actualEntries.every(
    ([field, direction], index) => (
      expectedEntries[index]?.[0] === field && expectedEntries[index]?.[1] === direction
    )
  );
}

function serializeIndex(index) {
  return {
    name: index.name,
    key: { ...(index.key || {}) },
    unique: index.unique === true,
    sparse: index.sparse === true,
    partialFilterExpression: index.partialFilterExpression || null,
    collation: index.collation || null
  };
}

function isExactDesiredIndex(index) {
  return Boolean(
    index &&
    index.name === DESIRED_INDEX.name &&
    index.unique === true &&
    index.sparse !== true &&
    !index.partialFilterExpression &&
    !index.collation &&
    sameIndexKey(index.key, DESIRED_INDEX.key)
  );
}

function stageFromRequestPath(requestPath) {
  if (typeof requestPath !== 'string') return null;
  const cleanPath = requestPath.split(/[?#]/, 1)[0].replace(/\/+$/, '');
  const finalSegment = cleanPath.slice(cleanPath.lastIndexOf('/') + 1).toLowerCase();
  if (finalSegment === 'review') return TASK_REVIEW_STAGES.REVIEW;
  if (finalSegment === 'confirm') return TASK_REVIEW_STAGES.CONFIRMATION;
  return null;
}

function stageEvidence(audit) {
  const evidence = new Set();
  const pathStage = stageFromRequestPath(audit?.requestPath);
  if (pathStage) evidence.add(pathStage);
  if (TASK_REVIEW_STAGE_SET.has(audit?.after?.stage)) evidence.add(audit.after.stage);
  return evidence;
}

async function collectionIndexes(collection) {
  try {
    return await collection.indexes();
  } catch (error) {
    if (error?.code === 26 || error?.codeName === 'NamespaceNotFound') return [];
    throw error;
  }
}

function addBlocker(blockers, code, message, details = null) {
  blockers.push({ code, message, details });
}

function candidateKey(review, stage, reviewRound) {
  if (!review.teamId || !review.task || !review.reviewer || !stage || !isValidReviewRound(reviewRound)) {
    return null;
  }
  return [review.teamId, review.task, review.reviewer, stage, reviewRound].map(String).join(':');
}

function missingFieldCondition(field) {
  return {
    $or: [
      { [field]: { $exists: false } },
      { [field]: null },
      { [field]: '' }
    ]
  };
}

function guardedMissingFilter(_id, fields) {
  const conditions = fields.map(missingFieldCondition);
  if (conditions.length === 1) return { _id, ...conditions[0] };
  return { _id, $and: conditions };
}

async function loadAuditEvidence(db, reviewIds) {
  const byReviewId = new Map();
  const stringIds = reviewIds.map(String);
  const chunkSize = 1000;
  for (let offset = 0; offset < stringIds.length; offset += chunkSize) {
    const ids = stringIds.slice(offset, offset + chunkSize);
    const audits = await db.collection(AUDIT_LOG_COLLECTION).find({
      resourceType: 'TASK_REVIEW',
      resourceId: { $in: ids }
    }, {
      projection: { resourceId: 1, requestPath: 1, 'after.stage': 1, createdAt: 1 }
    }).toArray();
    for (const audit of audits) {
      const reviewId = String(audit.resourceId || '');
      if (!byReviewId.has(reviewId)) byReviewId.set(reviewId, []);
      byReviewId.get(reviewId).push(audit);
    }
  }
  return byReviewId;
}

async function analyzeMigrationState(db) {
  const taskCollection = db.collection(TASK_COLLECTION);
  const reviewCollection = db.collection(TASK_REVIEW_COLLECTION);
  const [tasks, reviews, indexes] = await Promise.all([
    taskCollection.find({}, { projection: { reviewRound: 1 } }).sort({ _id: 1 }).toArray(),
    reviewCollection.find({}, {
      projection: { teamId: 1, task: 1, reviewer: 1, stage: 1, reviewRound: 1 }
    }).sort({ _id: 1 }).toArray(),
    collectionIndexes(reviewCollection)
  ]);
  const missingStageReviews = reviews.filter((review) => isMissing(review.stage));
  const auditEvidenceByReview = await loadAuditEvidence(
    db,
    missingStageReviews.map((review) => review._id)
  );
  const blockers = [];
  const taskRoundUpdates = [];
  const reviewUpdates = [];
  const candidates = [];

  for (const task of tasks) {
    if (isMissing(task.reviewRound)) {
      taskRoundUpdates.push({ _id: task._id, reviewRound: 1 });
    } else if (!isValidReviewRound(task.reviewRound)) {
      addBlocker(
        blockers,
        'TASK_REVIEW_ROUND_INVALID',
        'Task.reviewRound must be an integer greater than or equal to one',
        { taskId: String(task._id), reviewRound: task.reviewRound }
      );
    }
  }

  for (const review of reviews) {
    const set = {};
    const missingFields = [];
    let plannedStage = review.stage;
    let plannedReviewRound = review.reviewRound;
    let stageValid = true;
    let roundValid = true;

    if (isMissing(review.stage)) {
      const audits = auditEvidenceByReview.get(String(review._id)) || [];
      const inferredStages = new Set();
      for (const audit of audits) {
        for (const stage of stageEvidence(audit)) inferredStages.add(stage);
      }
      if (inferredStages.size === 0) {
        addBlocker(
          blockers,
          'TASK_REVIEW_STAGE_EVIDENCE_MISSING',
          'A TaskReview without stage has no review/confirm audit evidence',
          { reviewId: String(review._id) }
        );
        stageValid = false;
      } else if (inferredStages.size !== 1) {
        addBlocker(
          blockers,
          'TASK_REVIEW_STAGE_EVIDENCE_CONFLICT',
          'Audit evidence assigns more than one stage to a TaskReview',
          { reviewId: String(review._id), stages: [...inferredStages].sort() }
        );
        stageValid = false;
      } else {
        [plannedStage] = inferredStages;
        set.stage = plannedStage;
        missingFields.push('stage');
      }
    } else if (!TASK_REVIEW_STAGE_SET.has(review.stage)) {
      addBlocker(
        blockers,
        'TASK_REVIEW_STAGE_INVALID',
        'TaskReview.stage contains a value outside the supported enum',
        { reviewId: String(review._id), stage: review.stage }
      );
      stageValid = false;
    }

    if (isMissing(review.reviewRound)) {
      plannedReviewRound = 1;
      set.reviewRound = 1;
      missingFields.push('reviewRound');
    } else if (!isValidReviewRound(review.reviewRound)) {
      addBlocker(
        blockers,
        'TASK_REVIEW_REVIEW_ROUND_INVALID',
        'TaskReview.reviewRound must be an integer greater than or equal to one',
        { reviewId: String(review._id), reviewRound: review.reviewRound }
      );
      roundValid = false;
    }

    if (Object.keys(set).length > 0) {
      reviewUpdates.push({ _id: review._id, set, missingFields });
    }
    if (!stageValid || !roundValid) continue;

    const key = candidateKey(review, plannedStage, plannedReviewRound);
    if (!key) {
      addBlocker(
        blockers,
        'TASK_REVIEW_UNIQUE_KEY_INCOMPLETE',
        'TaskReview is missing a field required by the stage/round unique index',
        { reviewId: String(review._id) }
      );
      continue;
    }
    candidates.push({
      key,
      reviewId: String(review._id),
      stage: plannedStage,
      reviewRound: plannedReviewRound
    });
  }

  const candidateGroups = new Map();
  for (const candidate of candidates) {
    if (!candidateGroups.has(candidate.key)) candidateGroups.set(candidate.key, []);
    candidateGroups.get(candidate.key).push(candidate);
  }
  for (const duplicates of candidateGroups.values()) {
    if (duplicates.length > 1) {
      addBlocker(
        blockers,
        'TASK_REVIEW_STAGE_ROUND_DUPLICATE',
        'More than one TaskReview would share the same stage/round unique key',
        {
          reviewIds: duplicates.map(({ reviewId }) => reviewId),
          stage: duplicates[0].stage,
          reviewRound: duplicates[0].reviewRound
        }
      );
    }
  }

  const desiredByName = indexes.find((index) => index.name === DESIRED_INDEX.name) || null;
  const desiredKeyIndexes = indexes.filter((index) => sameIndexKey(index.key, DESIRED_INDEX.key));
  const desiredPresent = isExactDesiredIndex(desiredByName);
  if (desiredByName && !desiredPresent) {
    addBlocker(
      blockers,
      'TASK_REVIEW_STAGE_ROUND_INDEX_NAME_CONFLICT',
      `${DESIRED_INDEX.name} exists with an unexpected definition`,
      { index: serializeIndex(desiredByName) }
    );
  }
  for (const index of desiredKeyIndexes) {
    if (!isExactDesiredIndex(index)) {
      addBlocker(
        blockers,
        'TASK_REVIEW_STAGE_ROUND_INDEX_DEFINITION_CONFLICT',
        'The desired stage/round index key exists with a different name or options',
        { index: serializeIndex(index) }
      );
    }
  }

  const legacyRestrictiveIndexes = indexes.filter((index) => (
    index.unique === true && LEGACY_RESTRICTIVE_INDEX_KEYS.some((key) => sameIndexKey(index.key, key))
  ));
  const stagePlanCounts = Object.fromEntries(TASK_REVIEW_STAGE_VALUES.map((stage) => [stage, 0]));
  for (const update of reviewUpdates) {
    if (update.set.stage) stagePlanCounts[update.set.stage] += 1;
  }

  return {
    tasks: {
      total: tasks.length,
      validReviewRound: tasks.filter((task) => isValidReviewRound(task.reviewRound)).length,
      missingReviewRound: tasks.filter((task) => isMissing(task.reviewRound)).length,
      invalidReviewRound: tasks.filter(
        (task) => !isMissing(task.reviewRound) && !isValidReviewRound(task.reviewRound)
      ).length
    },
    reviews: {
      total: reviews.length,
      validStage: reviews.filter((review) => TASK_REVIEW_STAGE_SET.has(review.stage)).length,
      missingStage: missingStageReviews.length,
      invalidStage: reviews.filter(
        (review) => !isMissing(review.stage) && !TASK_REVIEW_STAGE_SET.has(review.stage)
      ).length,
      validReviewRound: reviews.filter((review) => isValidReviewRound(review.reviewRound)).length,
      missingReviewRound: reviews.filter((review) => isMissing(review.reviewRound)).length,
      invalidReviewRound: reviews.filter(
        (review) => !isMissing(review.reviewRound) && !isValidReviewRound(review.reviewRound)
      ).length
    },
    taskRoundUpdates,
    reviewUpdates,
    stagePlanCounts,
    indexes: indexes.map(serializeIndex),
    desiredIndexPresent: desiredPresent,
    legacyRestrictiveIndexes: legacyRestrictiveIndexes.map(serializeIndex),
    blockers
  };
}

function reportAnalysis(analysis) {
  return {
    tasks: {
      records: analysis.tasks,
      plannedReviewRoundBackfills: analysis.taskRoundUpdates.length
    },
    taskReviews: {
      records: analysis.reviews,
      plannedStageBackfills: {
        total: Object.values(analysis.stagePlanCounts).reduce((sum, count) => sum + count, 0),
        byStage: analysis.stagePlanCounts
      },
      plannedReviewRoundBackfills: analysis.reviewUpdates.filter(
        (update) => Object.hasOwn(update.set, 'reviewRound')
      ).length
    },
    indexes: {
      desired: DESIRED_INDEX,
      desiredPresent: analysis.desiredIndexPresent,
      legacyRestrictive: analysis.legacyRestrictiveIndexes,
      current: analysis.indexes
    },
    blockers: analysis.blockers
  };
}

async function verifyExecutionBackup({ backupDirectory, databaseName, backupVerifier }) {
  if (typeof backupDirectory !== 'string' || !backupDirectory.trim()) {
    fail('BACKUP_DIRECTORY_REQUIRED', '--backup-directory is required in execute mode');
  }
  if (!path.isAbsolute(backupDirectory)) {
    fail(
      'BACKUP_DIRECTORY_NOT_ABSOLUTE',
      '--backup-directory must be an absolute path in execute mode'
    );
  }
  const resolved = path.resolve(backupDirectory);
  const verified = await backupVerifier(resolved, { verifyFiles: true });
  if (verified?.manifest?.database?.name !== databaseName) {
    fail(
      'BACKUP_DATABASE_MISMATCH',
      'Verified backup database name does not match the connected database',
      { expected: databaseName, actual: verified?.manifest?.database?.name || null }
    );
  }
  const manifestFiles = Array.isArray(verified?.manifest?.files) ? verified.manifest.files : [];
  const collections = Array.isArray(verified?.manifest?.database?.collections)
    ? verified.manifest.database.collections
    : [];
  if (manifestFiles.length === 0 || collections.length === 0) {
    fail(
      'BACKUP_DATABASE_DUMP_EMPTY',
      'Verified backup does not contain a database dump file set',
      { fileCount: manifestFiles.length, collectionCount: collections.length }
    );
  }
  const collectionNames = new Set(collections.map((collection) => collection?.name));
  const manifestFileNames = new Set(manifestFiles.map((entry) => entry?.file));
  const missingCollections = [];
  const missingDumpFiles = [];
  for (const collectionName of REQUIRED_BACKUP_COLLECTIONS) {
    if (!collectionNames.has(collectionName)) missingCollections.push(collectionName);
    const relativePath = `database/${databaseName}/${collectionName}.bson`;
    if (!manifestFileNames.has(relativePath)) missingDumpFiles.push(relativePath);
  }
  if (missingCollections.length > 0 || missingDumpFiles.length > 0) {
    fail(
      'BACKUP_REQUIRED_COLLECTIONS_MISSING',
      'Verified backup is missing Task or TaskReview database dump evidence',
      { missingCollections, missingDumpFiles }
    );
  }
  return {
    backupDirectory: verified.backupDirectory || resolved,
    backupId: verified.manifest.backupId || null,
    completedAt: verified.manifest.completedAt || null,
    databaseName: verified.manifest.database.name,
    manifestSha256: verified.manifestSha256
  };
}

function assertExecutionGuards({ execute, confirmDatabase, databaseName }) {
  if (execute !== true) return;
  if (confirmDatabase !== databaseName) {
    fail(
      'DATABASE_CONFIRMATION_MISMATCH',
      '--confirm-database must exactly match the connected database name',
      { expected: databaseName, actual: confirmDatabase || null }
    );
  }
}

function createTaskReviewStageMigrationService({
  connection,
  backupVerifier = verifyBackupSet,
  now = () => new Date()
} = {}) {
  if (!connection?.db) throw new TypeError('A connected Mongoose connection is required');

  async function run({ execute = false, confirmDatabase, backupDirectory } = {}) {
    const databaseName = databaseNameOf(connection);
    if (!databaseName) fail('DATABASE_NAME_MISSING', 'The connected database name is unavailable');
    assertExecutionGuards({ execute, confirmDatabase, databaseName });
    const backup = execute
      ? await verifyExecutionBackup({ backupDirectory, databaseName, backupVerifier })
      : null;
    const before = await analyzeMigrationState(connection.db);
    const baseReport = {
      format: MIGRATION_REPORT_FORMAT,
      generatedAt: now().toISOString(),
      mode: execute ? 'execute' : 'dry-run',
      database: { name: databaseName },
      backup,
      before: reportAnalysis(before),
      writePerformed: false,
      steps: []
    };

    if (before.blockers.length > 0) {
      return {
        ...baseReport,
        status: execute ? 'BLOCKED' : 'DRY_RUN_BLOCKED',
        after: null
      };
    }
    if (!execute) {
      return { ...baseReport, status: 'DRY_RUN_READY', after: null };
    }

    const taskCollection = connection.db.collection(TASK_COLLECTION);
    const reviewCollection = connection.db.collection(TASK_REVIEW_COLLECTION);
    const steps = [];
    let writePerformed = false;
    try {
      let taskResult = { matchedCount: 0, modifiedCount: 0 };
      let reviewResult = { matchedCount: 0, modifiedCount: 0 };
      if (before.taskRoundUpdates.length > 0) {
        writePerformed = true;
        taskResult = await taskCollection.bulkWrite(before.taskRoundUpdates.map(({ _id }) => ({
          updateOne: {
            filter: guardedMissingFilter(_id, ['reviewRound']),
            update: { $set: { reviewRound: 1 } }
          }
        })), { ordered: true });
        if (taskResult.matchedCount !== before.taskRoundUpdates.length) {
          fail(
            'TASK_CHANGED_DURING_MIGRATION',
            'A Task changed after preflight and before reviewRound backfill completed',
            { expected: before.taskRoundUpdates.length, matched: taskResult.matchedCount }
          );
        }
      }
      if (before.reviewUpdates.length > 0) {
        writePerformed = true;
        reviewResult = await reviewCollection.bulkWrite(before.reviewUpdates.map((update) => ({
          updateOne: {
            filter: guardedMissingFilter(update._id, update.missingFields),
            update: { $set: update.set }
          }
        })), { ordered: true });
        if (reviewResult.matchedCount !== before.reviewUpdates.length) {
          fail(
            'TASK_REVIEW_CHANGED_DURING_MIGRATION',
            'A TaskReview changed after preflight and before stage/round backfill completed',
            { expected: before.reviewUpdates.length, matched: reviewResult.matchedCount }
          );
        }
      }
      steps.push({
        step: 'BACKFILL_AND_VALIDATE_STAGE_ROUNDS',
        status: writePerformed ? 'APPLIED' : 'NO_CHANGES',
        tasks: { matched: taskResult.matchedCount, modified: taskResult.modifiedCount },
        taskReviews: { matched: reviewResult.matchedCount, modified: reviewResult.modifiedCount }
      });

      const afterBackfill = await analyzeMigrationState(connection.db);
      if (
        afterBackfill.blockers.length > 0 ||
        afterBackfill.tasks.missingReviewRound > 0 ||
        afterBackfill.tasks.invalidReviewRound > 0 ||
        afterBackfill.reviews.missingStage > 0 ||
        afterBackfill.reviews.invalidStage > 0 ||
        afterBackfill.reviews.missingReviewRound > 0 ||
        afterBackfill.reviews.invalidReviewRound > 0
      ) {
        fail(
          'TASK_REVIEW_STAGE_ROUND_VALIDATION_FAILED',
          'Task and TaskReview stage/round validation failed after backfill',
          { after: reportAnalysis(afterBackfill) }
        );
      }

      if (!afterBackfill.desiredIndexPresent) {
        writePerformed = true;
        await reviewCollection.createIndex(DESIRED_INDEX.key, {
          unique: true,
          name: DESIRED_INDEX.name
        });
        steps.push({
          step: 'CREATE_STAGE_ROUND_UNIQUE_INDEX',
          status: 'CREATED',
          index: DESIRED_INDEX.name
        });
      } else {
        steps.push({
          step: 'CREATE_STAGE_ROUND_UNIQUE_INDEX',
          status: 'ALREADY_PRESENT',
          index: DESIRED_INDEX.name
        });
      }

      const indexesAfterCreate = await collectionIndexes(reviewCollection);
      if (!indexesAfterCreate.some(isExactDesiredIndex)) {
        fail(
          'TASK_REVIEW_STAGE_ROUND_INDEX_VERIFICATION_FAILED',
          'The new stage/round unique index could not be verified after creation'
        );
      }
      steps.push({
        step: 'VERIFY_STAGE_ROUND_UNIQUE_INDEX',
        status: 'VERIFIED',
        index: DESIRED_INDEX.name
      });

      const legacyIndexes = indexesAfterCreate.filter((index) => (
        index.unique === true && LEGACY_RESTRICTIVE_INDEX_KEYS.some((key) => sameIndexKey(index.key, key))
      ));
      const dropped = [];
      for (const index of legacyIndexes) {
        writePerformed = true;
        await reviewCollection.dropIndex(index.name);
        dropped.push(serializeIndex(index));
      }
      steps.push({ step: 'DROP_EXACT_LEGACY_RESTRICTIVE_INDEXES', status: 'VERIFIED', dropped });

      const after = await analyzeMigrationState(connection.db);
      if (
        after.blockers.length > 0 ||
        !after.desiredIndexPresent ||
        after.legacyRestrictiveIndexes.length > 0 ||
        after.tasks.missingReviewRound > 0 ||
        after.tasks.invalidReviewRound > 0 ||
        after.reviews.missingStage > 0 ||
        after.reviews.invalidStage > 0 ||
        after.reviews.missingReviewRound > 0 ||
        after.reviews.invalidReviewRound > 0
      ) {
        fail(
          'TASK_REVIEW_FINAL_VERIFICATION_FAILED',
          'Final Task and TaskReview stage/round verification failed',
          { after: reportAnalysis(after) }
        );
      }
      return {
        ...baseReport,
        status: 'EXECUTED',
        writePerformed,
        steps,
        after: reportAnalysis(after)
      };
    } catch (error) {
      let afterFailure = null;
      let afterFailureError = null;
      try {
        afterFailure = reportAnalysis(await analyzeMigrationState(connection.db));
      } catch (analysisError) {
        afterFailureError = {
          code: analysisError.code || null,
          message: analysisError.message
        };
      }
      const operationalDetails = {
        backup,
        before: reportAnalysis(before),
        after: error?.details?.after || afterFailure,
        afterAnalysisError: afterFailureError,
        writePerformed,
        completedSteps: steps
      };
      if (error instanceof TaskReviewStageMigrationError) {
        error.details = {
          ...(error.details || {}),
          ...operationalDetails
        };
        throw error;
      }
      throw new TaskReviewStageMigrationError(
        'TASK_REVIEW_STAGE_ROUND_MIGRATION_FAILED',
        error.message,
        {
          causeCode: error.code || null,
          ...operationalDetails
        }
      );
    }
  }

  return Object.freeze({ analyze: () => analyzeMigrationState(connection.db), run });
}

module.exports = {
  AUDIT_LOG_COLLECTION,
  DESIRED_INDEX,
  LEGACY_RESTRICTIVE_INDEX_KEYS,
  MIGRATION_REPORT_FORMAT,
  REQUIRED_BACKUP_COLLECTIONS,
  TASK_COLLECTION,
  TASK_REVIEW_COLLECTION,
  TASK_REVIEW_STAGES,
  TASK_REVIEW_STAGE_VALUES,
  TaskReviewStageMigrationError,
  analyzeMigrationState,
  createTaskReviewStageMigrationService,
  isExactDesiredIndex,
  isValidReviewRound,
  sameIndexKey,
  stageFromRequestPath
};
