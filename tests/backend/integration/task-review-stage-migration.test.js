'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { after, before, beforeEach, test } = require('node:test');
const appRequire = require('../helpers/appRequire');

const mongoose = appRequire('mongoose');
const { MongoMemoryServer } = appRequire('mongodb-memory-server');
const {
  BACKUP_FORMAT
} = require('../../../ops/lib/backupCore');
const {
  DESIRED_INDEX,
  LEGACY_RESTRICTIVE_INDEX_KEYS,
  createTaskReviewStageMigrationService,
  sameIndexKey
} = require('../../../app/services/taskReviewStageMigrationService');

const TEST_DATABASE_NAME = `task_review_stage_${randomUUID().replaceAll('-', '')}_v2_test`;
const TEST_ROOT = path.resolve(
  __dirname,
  '../../../.test-data',
  `task-review-stage-migration-${randomUUID()}`
);

let mongoServer;

function objectId() {
  return new mongoose.Types.ObjectId();
}

async function createVerifiedBackupDirectory(
  databaseName = TEST_DATABASE_NAME,
  { includeDatabaseDump = true } = {}
) {
  const backupDirectory = path.join(TEST_ROOT, randomUUID());
  await fs.promises.mkdir(backupDirectory, { recursive: true });
  const emptySha256 = createHash('sha256').update(Buffer.alloc(0)).digest('hex');
  const collections = includeDatabaseDump
    ? ['tasks', 'taskreviews'].map((name) => ({
        name,
        file: `${name}.bson`,
        documentCount: 0,
        bytes: 0,
        sha256: emptySha256
      }))
    : [];
  const files = includeDatabaseDump
    ? collections.map(({ name }) => ({
        file: `database/${databaseName}/${name}.bson`,
        bytes: 0,
        sha256: emptySha256
      }))
    : [];
  if (includeDatabaseDump) {
    const databaseDirectory = path.join(backupDirectory, 'database', databaseName);
    await fs.promises.mkdir(databaseDirectory, { recursive: true });
    await Promise.all(collections.map(({ file }) => (
      fs.promises.writeFile(path.join(databaseDirectory, file), Buffer.alloc(0))
    )));
  }
  const manifest = {
    format: BACKUP_FORMAT,
    backupId: `test-${randomUUID()}`,
    completedAt: new Date().toISOString(),
    database: { name: databaseName, collections },
    files
  };
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  const digest = createHash('sha256').update(serialized).digest('hex');
  await fs.promises.writeFile(path.join(backupDirectory, 'manifest.json'), serialized);
  await fs.promises.writeFile(path.join(backupDirectory, 'manifest.sha256'), `${digest}  manifest.json\n`);
  return backupDirectory;
}

async function seedMissingStages({ includeEvidence = true } = {}) {
  const teamId = objectId();
  const taskId = objectId();
  const reviewId = objectId();
  const confirmationId = objectId();
  await mongoose.connection.db.collection('tasks').insertOne({
    _id: taskId,
    teamId,
    taskName: 'Legacy task without reviewRound'
  });
  await mongoose.connection.db.collection('taskreviews').insertMany([
    {
      _id: reviewId,
      teamId,
      task: taskId,
      reviewer: objectId(),
      content: 'CC review'
    },
    {
      _id: confirmationId,
      teamId,
      task: taskId,
      reviewer: objectId(),
      content: 'Final confirmation'
    }
  ]);
  if (includeEvidence) {
    await mongoose.connection.db.collection('audit_logs').insertMany([
      {
        resourceType: 'TASK_REVIEW',
        resourceId: String(reviewId),
        requestPath: `/api/tasks/${taskId}/review`
      },
      {
        resourceType: 'TASK_REVIEW',
        resourceId: String(confirmationId),
        requestPath: `/api/tasks/${taskId}/confirm`
      }
    ]);
  }
  const collection = mongoose.connection.db.collection('taskreviews');
  await collection.createIndex(
    { teamId: 1, task: 1, reviewer: 1 },
    { unique: true, name: 'legacy_team_task_reviewer' }
  );
  await collection.createIndex(
    { task: 1, reviewer: 1 },
    { unique: true, name: 'legacy_task_reviewer' }
  );
  await collection.createIndex(
    { teamId: 1, task: 1, reviewer: 1, stage: 1 },
    { unique: true, name: 'uq_task_review_stage' }
  );
  await collection.createIndex(
    { teamId: 1, task: 1, content: 1 },
    { unique: true, name: 'unrelated_unique_index' }
  );
  return { confirmationId, reviewId, taskId };
}

before(async () => {
  await fs.promises.mkdir(TEST_ROOT, { recursive: true });
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri(), {
    dbName: TEST_DATABASE_NAME,
    autoIndex: false
  });
});

beforeEach(async () => {
  await mongoose.connection.db.dropDatabase();
});

after(async () => {
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
  assert.ok(TEST_ROOT.includes(`${path.sep}.test-data${path.sep}`));
  await fs.promises.rm(TEST_ROOT, { recursive: true, force: true });
});

test('dry-run plans audit-derived stages and Task/TaskReview rounds without database writes', async () => {
  await seedMissingStages();
  const service = createTaskReviewStageMigrationService({ connection: mongoose.connection });
  const report = await service.run();

  assert.equal(report.status, 'DRY_RUN_READY');
  assert.equal(report.writePerformed, false);
  assert.equal(report.before.tasks.records.missingReviewRound, 1);
  assert.equal(report.before.tasks.plannedReviewRoundBackfills, 1);
  assert.equal(report.before.taskReviews.records.missingStage, 2);
  assert.equal(report.before.taskReviews.records.missingReviewRound, 2);
  assert.equal(report.before.taskReviews.plannedReviewRoundBackfills, 2);
  assert.deepEqual(report.before.taskReviews.plannedStageBackfills.byStage, {
    review: 1,
    confirmation: 1
  });
  assert.equal(await mongoose.connection.db.collection('taskreviews').countDocuments({
    stage: { $exists: true }
  }), 0);
  assert.equal(await mongoose.connection.db.collection('taskreviews').countDocuments({
    reviewRound: { $exists: true }
  }), 0);
  assert.equal(await mongoose.connection.db.collection('tasks').countDocuments({
    reviewRound: { $exists: true }
  }), 0);
  const indexes = await mongoose.connection.db.collection('taskreviews').indexes();
  assert.equal(indexes.some((index) => index.name === DESIRED_INDEX.name), false);
});

test('execute backfills rounds, creates the stage/round index, and drops only exact legacy unique indexes', async () => {
  const fixture = await seedMissingStages();
  const backupDirectory = await createVerifiedBackupDirectory();
  const service = createTaskReviewStageMigrationService({ connection: mongoose.connection });
  const report = await service.run({
    execute: true,
    confirmDatabase: TEST_DATABASE_NAME,
    backupDirectory
  });

  assert.equal(report.status, 'EXECUTED');
  assert.equal(report.writePerformed, true);
  const reviews = await mongoose.connection.db.collection('taskreviews').find({}).toArray();
  assert.equal(reviews.find(({ _id }) => _id.equals(fixture.reviewId)).stage, 'review');
  assert.equal(reviews.find(({ _id }) => _id.equals(fixture.confirmationId)).stage, 'confirmation');
  assert.ok(reviews.every(({ reviewRound }) => reviewRound === 1));
  const task = await mongoose.connection.db.collection('tasks').findOne({ _id: fixture.taskId });
  assert.equal(task.reviewRound, 1);

  const indexes = await mongoose.connection.db.collection('taskreviews').indexes();
  const desired = indexes.find((index) => index.name === DESIRED_INDEX.name);
  assert.ok(desired);
  assert.equal(desired.unique, true);
  assert.ok(sameIndexKey(desired.key, DESIRED_INDEX.key));
  assert.equal(indexes.some((index) => (
    index.unique === true && LEGACY_RESTRICTIVE_INDEX_KEYS.some((key) => sameIndexKey(index.key, key))
  )), false);
  assert.ok(indexes.some((index) => index.name === 'unrelated_unique_index'));
});

test('missing stage evidence blocks both dry-run readiness and execute before writes', async () => {
  await seedMissingStages({ includeEvidence: false });
  const backupDirectory = await createVerifiedBackupDirectory();
  const service = createTaskReviewStageMigrationService({ connection: mongoose.connection });
  const dryRun = await service.run();
  const execute = await service.run({
    execute: true,
    confirmDatabase: TEST_DATABASE_NAME,
    backupDirectory
  });

  assert.equal(dryRun.status, 'DRY_RUN_BLOCKED');
  assert.equal(execute.status, 'BLOCKED');
  assert.equal(execute.writePerformed, false);
  assert.equal(execute.before.blockers.length, 2);
  assert.equal(await mongoose.connection.db.collection('taskreviews').countDocuments({
    stage: { $exists: true }
  }), 0);
});

test('execute rejects database confirmation and backup database mismatches', async () => {
  await seedMissingStages();
  const service = createTaskReviewStageMigrationService({ connection: mongoose.connection });
  const backupDirectory = await createVerifiedBackupDirectory('other_database');

  await assert.rejects(
    service.run({ execute: true, confirmDatabase: 'wrong', backupDirectory }),
    (error) => error.code === 'DATABASE_CONFIRMATION_MISMATCH'
  );
  await assert.rejects(
    service.run({ execute: true, confirmDatabase: TEST_DATABASE_NAME, backupDirectory }),
    (error) => error.code === 'BACKUP_DATABASE_MISMATCH'
  );
});

test('execute rejects a verified manifest that contains no Task or TaskReview dump files', async () => {
  await seedMissingStages();
  const backupDirectory = await createVerifiedBackupDirectory(TEST_DATABASE_NAME, {
    includeDatabaseDump: false
  });
  const service = createTaskReviewStageMigrationService({ connection: mongoose.connection });

  await assert.rejects(
    service.run({ execute: true, confirmDatabase: TEST_DATABASE_NAME, backupDirectory }),
    (error) => error.code === 'BACKUP_DATABASE_DUMP_EMPTY'
  );
  assert.equal(await mongoose.connection.db.collection('tasks').countDocuments({
    reviewRound: { $exists: true }
  }), 0);
  assert.equal(await mongoose.connection.db.collection('taskreviews').countDocuments({
    stage: { $exists: true }
  }), 0);
});

test('an ambiguous post-write failure is reported as write-performed with before and after state', async () => {
  await seedMissingStages();
  const backupDirectory = await createVerifiedBackupDirectory();
  const db = mongoose.connection.db;
  const originalCollection = db.collection.bind(db);
  db.collection = (name, options) => {
    const collection = originalCollection(name, options);
    if (name === 'tasks') {
      const originalBulkWrite = collection.bulkWrite.bind(collection);
      collection.bulkWrite = async (...args) => {
        await originalBulkWrite(...args);
        throw Object.assign(new Error('simulated ambiguous network result'), { code: 89 });
      };
    }
    return collection;
  };

  try {
    const service = createTaskReviewStageMigrationService({ connection: mongoose.connection });
    await assert.rejects(
      service.run({ execute: true, confirmDatabase: TEST_DATABASE_NAME, backupDirectory }),
      (error) => {
        assert.equal(error.code, 'TASK_REVIEW_STAGE_ROUND_MIGRATION_FAILED');
        assert.equal(error.details.writePerformed, true);
        assert.ok(error.details.backup.backupId);
        assert.equal(error.details.before.tasks.records.missingReviewRound, 1);
        assert.equal(error.details.after.tasks.records.missingReviewRound, 0);
        return true;
      }
    );
  } finally {
    db.collection = originalCollection;
  }
});

test('a partial index using the desired name is blocked instead of accepted as complete uniqueness', async () => {
  await mongoose.connection.db.collection('taskreviews').insertOne({
    _id: objectId(),
    teamId: objectId(),
    task: objectId(),
    reviewer: objectId(),
    stage: 'review',
    reviewRound: 1,
    content: 'Partial-index fixture'
  });
  await mongoose.connection.db.collection('taskreviews').createIndex(
    DESIRED_INDEX.key,
    {
      unique: true,
      name: DESIRED_INDEX.name,
      partialFilterExpression: { stage: 'review' }
    }
  );

  const report = await createTaskReviewStageMigrationService({
    connection: mongoose.connection
  }).run();
  assert.equal(report.status, 'DRY_RUN_BLOCKED');
  assert.ok(report.before.blockers.some(({ code }) => (
    code === 'TASK_REVIEW_STAGE_ROUND_INDEX_NAME_CONFLICT'
  )));
});

test('invalid Task and TaskReview rounds block migration before any writes', async () => {
  const teamId = objectId();
  const taskId = objectId();
  await mongoose.connection.db.collection('tasks').insertOne({
    _id: taskId,
    reviewRound: 0
  });
  await mongoose.connection.db.collection('taskreviews').insertOne({
    _id: objectId(),
    teamId,
    task: taskId,
    reviewer: objectId(),
    stage: 'review',
    reviewRound: 1.5
  });

  const report = await createTaskReviewStageMigrationService({
    connection: mongoose.connection
  }).run();
  assert.equal(report.status, 'DRY_RUN_BLOCKED');
  assert.ok(report.before.blockers.some(({ code }) => code === 'TASK_REVIEW_ROUND_INVALID'));
  assert.ok(report.before.blockers.some(({ code }) => (
    code === 'TASK_REVIEW_REVIEW_ROUND_INVALID'
  )));
});
