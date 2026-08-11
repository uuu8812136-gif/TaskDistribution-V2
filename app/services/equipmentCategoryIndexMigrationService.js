'use strict';

const path = require('node:path');
const { verifyBackupSet } = require('../../ops/lib/backupCore');
const {
  EXPECTED_V2_TEST_MONGO_TARGET
} = require('../../ops/lib/v2TestMongoTargetGuard');

const MIGRATION_REPORT_FORMAT = 'equipment-category-parent-name-index-migration/v1';
const COLLECTION_NAME = 'equipmentcategories';
const SCHEMA_LEDGER_COLLECTION = 'releaseschemaledger';
const SCHEMA_CAPABILITY = 'equipment-category-parent-name-index-v1';
const SCHEMA_LEDGER_ID = 'equipment-category-parent-name-index';
const LEGACY_INDEX = Object.freeze({
  name: 'uq_equipment_category_team_name',
  key: Object.freeze({ teamId: 1, name: 1 }),
  unique: true
});
const DESIRED_INDEX = Object.freeze({
  name: 'uq_equipment_category_team_parent_name',
  key: Object.freeze({ teamId: 1, parentId: 1, name: 1 }),
  unique: true
});
const EXPECTED_SCHEMA_LEDGER = Object.freeze({
  _id: SCHEMA_LEDGER_ID,
  schemaVersion: 1,
  capability: SCHEMA_CAPABILITY,
  indexName: DESIRED_INDEX.name,
  legacyIndexName: LEGACY_INDEX.name
});
const EXPECTED_BACKUP_DATABASE_TARGET = Object.freeze({
  hosts: Object.freeze([EXPECTED_V2_TEST_MONGO_TARGET.hostname]),
  servers: Object.freeze([
    `${EXPECTED_V2_TEST_MONGO_TARGET.hostname}:${EXPECTED_V2_TEST_MONGO_TARGET.port}`
  ]),
  replicaSet: EXPECTED_V2_TEST_MONGO_TARGET.replicaSet
});

class EquipmentCategoryIndexMigrationError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'EquipmentCategoryIndexMigrationError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new EquipmentCategoryIndexMigrationError(code, message, details);
}

function databaseNameOf(connection) {
  return connection?.name || connection?.db?.databaseName || null;
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

function isExactIndex(index, expected) {
  return Boolean(
    index &&
    index.name === expected.name &&
    index.unique === expected.unique &&
    index.sparse !== true &&
    !index.partialFilterExpression &&
    !index.collation &&
    sameIndexKey(index.key, expected.key)
  );
}

function isTeamWideUniqueIndex(index) {
  return Boolean(
    index &&
    index.unique === true &&
    sameIndexKey(index.key, LEGACY_INDEX.key)
  );
}

function normalizeDuplicateGroup(group) {
  return {
    teamId: group?._id?.teamId ? String(group._id.teamId) : null,
    parentId: group?._id?.parentId ? String(group._id.parentId) : null,
    name: group?._id?.name || null,
    count: group.count,
    ids: (group.ids || []).map(String)
  };
}

function serializeSchemaLedger(document) {
  if (!document) return null;
  return {
    _id: document._id,
    schemaVersion: document.schemaVersion,
    capability: document.capability,
    indexName: document.indexName,
    legacyIndexName: document.legacyIndexName
  };
}

function isExactSchemaLedger(document) {
  const serialized = serializeSchemaLedger(document);
  return Boolean(serialized && Object.entries(EXPECTED_SCHEMA_LEDGER).every(
    ([field, value]) => serialized[field] === value
  ));
}

function sameStringArray(actual, expected) {
  return Boolean(
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function migrationStateChanged(before, after) {
  if (!after) return false;
  return Boolean(
    before.desiredPresent !== after.desiredPresent ||
    before.schemaLedgerPresent !== after.schemaLedgerPresent ||
    before.legacyIndexes.map(({ name }) => name).join('\n') !==
      after.legacyIndexes.map(({ name }) => name).join('\n')
  );
}

async function analyzeMigrationState(database) {
  const collection = database.collection(COLLECTION_NAME);
  const [indexes, documentCount, duplicateGroups, schemaLedger] = await Promise.all([
    collection.indexes(),
    collection.countDocuments({}),
    collection.aggregate([
      {
        $group: {
          _id: {
            teamId: '$teamId',
            parentId: { $ifNull: ['$parentId', null] },
            name: '$name'
          },
          count: { $sum: 1 },
          ids: { $push: '$_id' }
        }
      },
      { $match: { count: { $gt: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 100 }
    ]).toArray(),
    database.collection(SCHEMA_LEDGER_COLLECTION).findOne({ _id: SCHEMA_LEDGER_ID })
  ]);
  const desiredPresent = indexes.some((index) => isExactIndex(index, DESIRED_INDEX));
  const legacyIndexes = indexes.filter((index) => isExactIndex(index, LEGACY_INDEX));
  const conflictingDesiredIndexes = indexes.filter((index) => (
    !isExactIndex(index, DESIRED_INDEX) &&
    (
      index.name === DESIRED_INDEX.name ||
      sameIndexKey(index.key, DESIRED_INDEX.key)
    )
  ));
  const unknownTeamWideUniqueIndexes = indexes.filter(
    (index) => isTeamWideUniqueIndex(index) && !isExactIndex(index, LEGACY_INDEX)
  );
  const duplicateBlockers = duplicateGroups.map((group) => ({
    code: 'EQUIPMENT_CATEGORY_SAME_PARENT_DUPLICATE',
    message: 'Two or more equipment categories have the same team, parent and name',
    duplicate: normalizeDuplicateGroup(group)
  }));
  const unknownIndexBlockers = unknownTeamWideUniqueIndexes.map((index) => ({
    code: 'EQUIPMENT_CATEGORY_UNKNOWN_TEAM_WIDE_UNIQUE_INDEX',
    message: 'An unrecognized team-wide unique category-name index must be reviewed before migration',
    index: serializeIndex(index)
  }));
  const conflictingDesiredIndexBlockers = conflictingDesiredIndexes.map((index) => ({
    code: 'EQUIPMENT_CATEGORY_CONFLICTING_DESIRED_INDEX',
    message: 'An index uses the desired name or key with unexpected options and must be reviewed before migration',
    index: serializeIndex(index)
  }));
  const schemaLedgerBlockers = schemaLedger && !isExactSchemaLedger(schemaLedger) ? [{
    code: 'EQUIPMENT_CATEGORY_SCHEMA_LEDGER_CONFLICT',
    message: 'The equipment category schema ledger contains an incompatible capability record',
    ledger: serializeSchemaLedger(schemaLedger)
  }] : [];
  return {
    documentCount,
    indexes: indexes.map(serializeIndex),
    desiredPresent,
    legacyIndexes: legacyIndexes.map(serializeIndex),
    conflictingDesiredIndexes: conflictingDesiredIndexes.map(serializeIndex),
    unknownTeamWideUniqueIndexes: unknownTeamWideUniqueIndexes.map(serializeIndex),
    duplicateGroups: duplicateGroups.map(normalizeDuplicateGroup),
    schemaLedger: serializeSchemaLedger(schemaLedger),
    schemaLedgerPresent: isExactSchemaLedger(schemaLedger),
    blockers: [
      ...duplicateBlockers,
      ...unknownIndexBlockers,
      ...conflictingDesiredIndexBlockers,
      ...schemaLedgerBlockers
    ]
  };
}

function reportAnalysis(analysis) {
  return {
    documentCount: analysis.documentCount,
    indexes: {
      desired: DESIRED_INDEX,
      desiredPresent: analysis.desiredPresent,
      legacy: analysis.legacyIndexes,
      conflictingDesired: analysis.conflictingDesiredIndexes,
      unknownTeamWideUnique: analysis.unknownTeamWideUniqueIndexes,
      current: analysis.indexes
    },
    duplicateGroups: analysis.duplicateGroups,
    schemaLedger: {
      expected: EXPECTED_SCHEMA_LEDGER,
      present: analysis.schemaLedgerPresent,
      current: analysis.schemaLedger
    },
    blockers: analysis.blockers
  };
}

async function verifyExecutionBackup({ backupDirectory, databaseName, backupVerifier }) {
  if (typeof backupDirectory !== 'string' || !backupDirectory.trim()) {
    fail('BACKUP_DIRECTORY_REQUIRED', '--backup-directory is required in execute mode');
  }
  if (!path.isAbsolute(backupDirectory)) {
    fail('BACKUP_DIRECTORY_NOT_ABSOLUTE', '--backup-directory must be absolute in execute mode');
  }
  const resolved = path.resolve(backupDirectory);
  const verified = await backupVerifier(resolved, { verifyFiles: true });
  if (verified?.manifest?.database?.name !== databaseName) {
    fail('BACKUP_DATABASE_MISMATCH', 'Verified backup database name does not match the connected database', {
      expected: databaseName,
      actual: verified?.manifest?.database?.name || null
    });
  }
  const databaseTarget = verified?.manifest?.database || {};
  if (
    !sameStringArray(databaseTarget.hosts, EXPECTED_BACKUP_DATABASE_TARGET.hosts) ||
    !sameStringArray(databaseTarget.servers, EXPECTED_BACKUP_DATABASE_TARGET.servers) ||
    databaseTarget.replicaSet !== EXPECTED_BACKUP_DATABASE_TARGET.replicaSet
  ) {
    fail('BACKUP_MONGODB_TARGET_MISMATCH', 'Verified backup does not identify the exact V2 test MongoDB target', {
      expected: EXPECTED_BACKUP_DATABASE_TARGET,
      actual: {
        hosts: databaseTarget.hosts || null,
        servers: databaseTarget.servers || null,
        replicaSet: databaseTarget.replicaSet || null
      }
    });
  }
  const collections = Array.isArray(verified?.manifest?.database?.collections)
    ? verified.manifest.database.collections
    : [];
  const files = Array.isArray(verified?.manifest?.files) ? verified.manifest.files : [];
  const expectedDump = `database/${databaseName}/${COLLECTION_NAME}.bson`;
  if (
    !collections.some((collection) => collection?.name === COLLECTION_NAME) ||
    !files.some((entry) => entry?.file === expectedDump)
  ) {
    fail(
      'BACKUP_REQUIRED_COLLECTION_MISSING',
      'Verified backup is missing the equipment category collection or BSON dump',
      { collection: COLLECTION_NAME, expectedDump }
    );
  }
  return {
    backupDirectory: verified.backupDirectory || resolved,
    backupId: verified.manifest.backupId || null,
    completedAt: verified.manifest.completedAt || null,
    databaseName,
    databaseTarget: EXPECTED_BACKUP_DATABASE_TARGET,
    manifestSha256: verified.manifestSha256 || null
  };
}

function createEquipmentCategoryIndexMigrationService({
  connection,
  backupVerifier = verifyBackupSet,
  now = () => new Date()
} = {}) {
  if (!connection?.db) throw new TypeError('A connected Mongoose connection is required');

  async function run({ execute = false, confirmDatabase, backupDirectory } = {}) {
    const databaseName = databaseNameOf(connection);
    if (!databaseName) fail('DATABASE_NAME_MISSING', 'The connected database name is unavailable');
    if (execute && confirmDatabase !== databaseName) {
      fail(
        'DATABASE_CONFIRMATION_MISMATCH',
        '--confirm-database must exactly match the connected database name',
        { expected: databaseName, actual: confirmDatabase || null }
      );
    }
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
      return {
        ...baseReport,
        status: (
          before.desiredPresent &&
          before.legacyIndexes.length === 0 &&
          before.schemaLedgerPresent
        )
          ? 'DRY_RUN_ALREADY_APPLIED'
          : 'DRY_RUN_READY',
        after: null
      };
    }

    const collection = connection.db.collection(COLLECTION_NAME);
    const steps = [];
    let writePerformed = false;
    try {
      if (!before.desiredPresent) {
        await collection.createIndex(DESIRED_INDEX.key, {
          unique: true,
          name: DESIRED_INDEX.name
        });
        writePerformed = true;
        steps.push({ step: 'CREATE_PARENT_SCOPED_UNIQUE_INDEX', status: 'CREATED' });
      } else {
        steps.push({ step: 'CREATE_PARENT_SCOPED_UNIQUE_INDEX', status: 'ALREADY_PRESENT' });
      }

      const afterCreate = await analyzeMigrationState(connection.db);
      if (!afterCreate.desiredPresent || afterCreate.blockers.length > 0) {
        fail(
          'EQUIPMENT_CATEGORY_NEW_INDEX_VERIFICATION_FAILED',
          'The parent-scoped equipment category index could not be verified after creation',
          { after: reportAnalysis(afterCreate) }
        );
      }
      steps.push({ step: 'VERIFY_PARENT_SCOPED_UNIQUE_INDEX', status: 'VERIFIED' });

      const dropped = [];
      for (const index of afterCreate.legacyIndexes) {
        await collection.dropIndex(index.name);
        writePerformed = true;
        dropped.push(index);
      }
      steps.push({
        step: 'DROP_EXACT_TEAM_WIDE_UNIQUE_INDEX',
        status: dropped.length > 0 ? 'DROPPED' : 'ALREADY_ABSENT',
        dropped
      });

      const after = await analyzeMigrationState(connection.db);
      if (!after.schemaLedgerPresent) {
        await connection.db.collection(SCHEMA_LEDGER_COLLECTION).insertOne({
          ...EXPECTED_SCHEMA_LEDGER
        });
        writePerformed = true;
        steps.push({ step: 'WRITE_SCHEMA_COMPATIBILITY_LEDGER', status: 'CREATED' });
      } else {
        steps.push({ step: 'WRITE_SCHEMA_COMPATIBILITY_LEDGER', status: 'ALREADY_PRESENT' });
      }

      const finalState = await analyzeMigrationState(connection.db);
      if (
        !finalState.desiredPresent ||
        finalState.legacyIndexes.length > 0 ||
        !finalState.schemaLedgerPresent ||
        finalState.blockers.length > 0
      ) {
        fail(
          'EQUIPMENT_CATEGORY_INDEX_FINAL_VERIFICATION_FAILED',
          'Final equipment category index verification failed',
          { after: reportAnalysis(finalState) }
        );
      }
      return {
        ...baseReport,
        status: writePerformed ? 'EXECUTED' : 'ALREADY_APPLIED',
        writePerformed,
        steps,
        after: reportAnalysis(finalState)
      };
    } catch (error) {
      let afterFailureAnalysis = null;
      let afterFailure = null;
      try {
        afterFailureAnalysis = await analyzeMigrationState(connection.db);
        afterFailure = reportAnalysis(afterFailureAnalysis);
      } catch {
        afterFailure = null;
      }
      const details = {
        backup,
        before: reportAnalysis(before),
        after: error?.details?.after || afterFailure,
        writePerformed: writePerformed || migrationStateChanged(before, afterFailureAnalysis),
        completedSteps: steps
      };
      if (error instanceof EquipmentCategoryIndexMigrationError) {
        error.details = { ...(error.details || {}), ...details };
        throw error;
      }
      throw new EquipmentCategoryIndexMigrationError(
        'EQUIPMENT_CATEGORY_INDEX_MIGRATION_FAILED',
        error.message,
        { causeCode: error.code || null, ...details }
      );
    }
  }

  return Object.freeze({ run });
}

module.exports = {
  COLLECTION_NAME,
  DESIRED_INDEX,
  EXPECTED_BACKUP_DATABASE_TARGET,
  EXPECTED_SCHEMA_LEDGER,
  EquipmentCategoryIndexMigrationError,
  LEGACY_INDEX,
  MIGRATION_REPORT_FORMAT,
  SCHEMA_CAPABILITY,
  SCHEMA_LEDGER_COLLECTION,
  SCHEMA_LEDGER_ID,
  analyzeMigrationState,
  createEquipmentCategoryIndexMigrationService,
  isExactSchemaLedger,
  isTeamWideUniqueIndex,
  sameIndexKey
};
