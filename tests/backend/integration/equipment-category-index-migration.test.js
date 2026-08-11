'use strict';

const assert = require('node:assert/strict');
const { after, before, beforeEach, test } = require('node:test');
const path = require('node:path');

const APP_ROOT = path.resolve(__dirname, '../../../app');
const appRequire = (moduleName) => require(require.resolve(moduleName, { paths: [APP_ROOT] }));
const mongoose = appRequire('mongoose');
const { MongoMemoryServer } = appRequire('mongodb-memory-server');
const {
  COLLECTION_NAME,
  DESIRED_INDEX,
  EXPECTED_SCHEMA_LEDGER,
  EXPECTED_BACKUP_DATABASE_TARGET,
  LEGACY_INDEX,
  SCHEMA_LEDGER_COLLECTION,
  createEquipmentCategoryIndexMigrationService
} = require('../../../app/services/equipmentCategoryIndexMigrationService');

const DATABASE_NAME = 'equipment_category_index_migration_test';
const BACKUP_DIRECTORY = path.resolve(__dirname, '../../../.test-data/fake-equipment-category-backup');

let mongoServer;
let fixture;

function objectId() {
  return new mongoose.Types.ObjectId();
}

async function seedLegacyState() {
  const collection = mongoose.connection.db.collection(COLLECTION_NAME);
  const teamId = objectId();
  const actorId = objectId();
  const majorId = objectId();
  const typeId = objectId();
  const primaryAId = objectId();
  const primaryBId = objectId();
  await collection.insertMany([
    { _id: majorId, teamId, parentId: null, name: '装卸搬运设备', createdBy: actorId, updatedBy: actorId },
    { _id: typeId, teamId, parentId: majorId, name: '叉车', createdBy: actorId, updatedBy: actorId },
    { _id: primaryAId, teamId, parentId: typeId, name: '铅酸电池叉车', createdBy: actorId, updatedBy: actorId },
    { _id: primaryBId, teamId, parentId: typeId, name: '锂电池叉车', createdBy: actorId, updatedBy: actorId }
  ]);
  return { teamId, actorId, majorId, typeId, primaryAId, primaryBId };
}

function backupVerifier(directory, options) {
  assert.equal(directory, BACKUP_DIRECTORY);
  assert.deepEqual(options, { verifyFiles: true });
  return Promise.resolve(backupVerificationResult());
}

function backupVerificationResult(databaseOverrides = {}) {
  return {
    backupDirectory: BACKUP_DIRECTORY,
    manifestSha256: 'test-manifest-sha256',
    manifest: {
      backupId: 'test-equipment-category-backup',
      completedAt: '2030-01-01T00:00:00.000Z',
      database: {
        name: DATABASE_NAME,
        hosts: [...EXPECTED_BACKUP_DATABASE_TARGET.hosts],
        servers: [...EXPECTED_BACKUP_DATABASE_TARGET.servers],
        replicaSet: EXPECTED_BACKUP_DATABASE_TARGET.replicaSet,
        collections: [{ name: COLLECTION_NAME, documentCount: 4 }],
        ...databaseOverrides
      },
      files: [{ file: `database/${DATABASE_NAME}/${COLLECTION_NAME}.bson` }]
    }
  };
}

function injectedFault(phase) {
  const error = new Error(`Injected migration fault: ${phase}`);
  error.code = `INJECTED_${phase.toUpperCase()}`;
  return error;
}

function faultingConnection(phase) {
  const realDatabase = mongoose.connection.db;
  let fired = false;
  let ledgerReads = 0;

  function wrapCollection(name) {
    const realCollection = realDatabase.collection(name);
    return new Proxy(realCollection, {
      get(target, property) {
        if (name === COLLECTION_NAME && property === 'createIndex') {
          return async (...args) => {
            const result = await target.createIndex(...args);
            if (!fired && phase === 'createIndex') {
              fired = true;
              throw injectedFault(phase);
            }
            return result;
          };
        }
        if (name === COLLECTION_NAME && property === 'dropIndex') {
          return async (...args) => {
            const result = await target.dropIndex(...args);
            if (!fired && phase === 'dropIndex') {
              fired = true;
              throw injectedFault(phase);
            }
            return result;
          };
        }
        if (name === SCHEMA_LEDGER_COLLECTION && property === 'insertOne') {
          return async (...args) => {
            const result = await target.insertOne(...args);
            if (!fired && phase === 'insertOne') {
              fired = true;
              throw injectedFault(phase);
            }
            return result;
          };
        }
        if (name === SCHEMA_LEDGER_COLLECTION && property === 'findOne') {
          return async (...args) => {
            ledgerReads += 1;
            const result = await target.findOne(...args);
            if (!fired && phase === 'finalLedgerRead' && ledgerReads === 4) {
              fired = true;
              throw injectedFault(phase);
            }
            return result;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  }

  return {
    name: mongoose.connection.name,
    db: {
      collection: wrapCollection
    }
  };
}

async function prepareFaultPhase(phase) {
  if (phase === 'createIndex') return;
  const collection = mongoose.connection.db.collection(COLLECTION_NAME);
  await collection.createIndex(DESIRED_INDEX.key, {
    unique: true,
    name: DESIRED_INDEX.name
  });
  if (phase === 'insertOne' || phase === 'finalLedgerRead') {
    await collection.dropIndex(LEGACY_INDEX.name);
  }
}

async function assertForwardConvergenceAfterFault(phase) {
  await prepareFaultPhase(phase);
  const service = createEquipmentCategoryIndexMigrationService({
    connection: faultingConnection(phase),
    backupVerifier
  });
  let firstError = null;
  try {
    await service.run({
      execute: true,
      confirmDatabase: DATABASE_NAME,
      backupDirectory: BACKUP_DIRECTORY
    });
  } catch (error) {
    firstError = error;
  }

  assert.ok(firstError, `${phase} must surface the injected failure`);
  assert.equal(firstError.code, 'EQUIPMENT_CATEGORY_INDEX_MIGRATION_FAILED');
  assert.equal(firstError.details.writePerformed, true);

  const retry = await createEquipmentCategoryIndexMigrationService({
    connection: mongoose.connection,
    backupVerifier
  }).run({
    execute: true,
    confirmDatabase: DATABASE_NAME,
    backupDirectory: BACKUP_DIRECTORY
  });
  assert.ok(['EXECUTED', 'ALREADY_APPLIED'].includes(retry.status), retry.status);

  const indexes = await mongoose.connection.db.collection(COLLECTION_NAME).indexes();
  assert.ok(indexes.some(({ name }) => name === DESIRED_INDEX.name));
  assert.ok(!indexes.some(({ name }) => name === LEGACY_INDEX.name));
  assert.deepEqual(
    await mongoose.connection.db.collection(SCHEMA_LEDGER_COLLECTION).findOne({
      _id: EXPECTED_SCHEMA_LEDGER._id
    }),
    EXPECTED_SCHEMA_LEDGER
  );
}

before(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri(), {
    dbName: DATABASE_NAME,
    autoIndex: false
  });
});

beforeEach(async () => {
  await mongoose.connection.db.dropDatabase();
  await mongoose.connection.db.createCollection(COLLECTION_NAME);
  await mongoose.connection.db.collection(COLLECTION_NAME).createIndex(
    LEGACY_INDEX.key,
    { unique: true, name: LEGACY_INDEX.name }
  );
  fixture = await seedLegacyState();
});

after(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});

test('dry-run reports the exact index change without writing', async () => {
  const service = createEquipmentCategoryIndexMigrationService({
    connection: mongoose.connection,
    backupVerifier
  });
  const beforeIndexes = await mongoose.connection.db.collection(COLLECTION_NAME).indexes();
  const report = await service.run();
  const afterIndexes = await mongoose.connection.db.collection(COLLECTION_NAME).indexes();

  assert.equal(report.status, 'DRY_RUN_READY');
  assert.equal(report.mode, 'dry-run');
  assert.equal(report.writePerformed, false);
  assert.equal(report.before.indexes.desiredPresent, false);
  assert.deepEqual(report.before.indexes.unknownTeamWideUnique, []);
  assert.deepEqual(
    afterIndexes.map(({ name }) => name).sort(),
    beforeIndexes.map(({ name }) => name).sort()
  );
});

test('execute creates and verifies the parent-scoped index before removing the exact legacy index', async () => {
  const service = createEquipmentCategoryIndexMigrationService({
    connection: mongoose.connection,
    backupVerifier
  });
  const report = await service.run({
    execute: true,
    confirmDatabase: DATABASE_NAME,
    backupDirectory: BACKUP_DIRECTORY
  });
  const collection = mongoose.connection.db.collection(COLLECTION_NAME);
  const indexes = await collection.indexes();

  assert.equal(report.status, 'EXECUTED');
  assert.equal(report.writePerformed, true);
  assert.ok(indexes.some(({ name }) => name === DESIRED_INDEX.name));
  assert.ok(!indexes.some(({ name }) => name === LEGACY_INDEX.name));
  assert.equal(report.after.indexes.desiredPresent, true);
  assert.equal(report.after.indexes.legacy.length, 0);
  assert.deepEqual(report.after.indexes.unknownTeamWideUnique, []);
  assert.deepEqual(
    await mongoose.connection.db.collection(SCHEMA_LEDGER_COLLECTION).findOne({
      _id: EXPECTED_SCHEMA_LEDGER._id
    }),
    EXPECTED_SCHEMA_LEDGER
  );

  await collection.insertMany([
    {
      _id: objectId(),
      teamId: fixture.teamId,
      parentId: fixture.primaryAId,
      name: '电动叉车',
      createdBy: fixture.actorId,
      updatedBy: fixture.actorId
    },
    {
      _id: objectId(),
      teamId: fixture.teamId,
      parentId: fixture.primaryBId,
      name: '电动叉车',
      createdBy: fixture.actorId,
      updatedBy: fixture.actorId
    }
  ]);
  await assert.rejects(collection.insertOne({
    _id: objectId(),
    teamId: fixture.teamId,
    parentId: fixture.primaryAId,
    name: '电动叉车',
    createdBy: fixture.actorId,
    updatedBy: fixture.actorId
  }), (error) => error.code === 11000);
});

test('execute is idempotent after the desired index is active and the legacy index is absent', async () => {
  const service = createEquipmentCategoryIndexMigrationService({
    connection: mongoose.connection,
    backupVerifier
  });
  await service.run({
    execute: true,
    confirmDatabase: DATABASE_NAME,
    backupDirectory: BACKUP_DIRECTORY
  });
  const second = await service.run({
    execute: true,
    confirmDatabase: DATABASE_NAME,
    backupDirectory: BACKUP_DIRECTORY
  });

  assert.equal(second.status, 'ALREADY_APPLIED');
  assert.equal(second.writePerformed, false);
  assert.equal(second.after.indexes.desiredPresent, true);
  assert.equal(second.after.indexes.legacy.length, 0);
  assert.deepEqual(second.after.indexes.unknownTeamWideUnique, []);
  assert.equal(second.after.schemaLedger.present, true);
});

test('an incompatible schema ledger blocks migration before index writes', async () => {
  await mongoose.connection.db.collection(SCHEMA_LEDGER_COLLECTION).insertOne({
    _id: EXPECTED_SCHEMA_LEDGER._id,
    schemaVersion: 999,
    capability: 'unexpected-capability'
  });
  const collection = mongoose.connection.db.collection(COLLECTION_NAME);
  const service = createEquipmentCategoryIndexMigrationService({
    connection: mongoose.connection,
    backupVerifier
  });

  const report = await service.run({
    execute: true,
    confirmDatabase: DATABASE_NAME,
    backupDirectory: BACKUP_DIRECTORY
  });

  assert.equal(report.status, 'BLOCKED');
  assert.equal(report.writePerformed, false);
  assert.equal(
    report.before.blockers.some(({ code }) => code === 'EQUIPMENT_CATEGORY_SCHEMA_LEDGER_CONFLICT'),
    true
  );
  assert.ok(!(await collection.indexes()).some(({ name }) => name === DESIRED_INDEX.name));
});

test('unknown team-wide unique index blocks migration even when the desired index already exists', async () => {
  const collection = mongoose.connection.db.collection(COLLECTION_NAME);
  const unknownIndexName = 'uq_equipment_category_unexpected_team_name';
  await collection.dropIndex(LEGACY_INDEX.name);
  await collection.createIndex(LEGACY_INDEX.key, {
    unique: true,
    name: unknownIndexName
  });
  await collection.createIndex(DESIRED_INDEX.key, {
    unique: true,
    name: DESIRED_INDEX.name
  });
  const beforeIndexes = await collection.indexes();
  const service = createEquipmentCategoryIndexMigrationService({
    connection: mongoose.connection,
    backupVerifier
  });

  const dryRun = await service.run();
  const execute = await service.run({
    execute: true,
    confirmDatabase: DATABASE_NAME,
    backupDirectory: BACKUP_DIRECTORY
  });
  const afterIndexes = await collection.indexes();

  assert.equal(dryRun.status, 'DRY_RUN_BLOCKED');
  assert.equal(dryRun.writePerformed, false);
  assert.equal(dryRun.before.indexes.desiredPresent, true);
  assert.equal(dryRun.before.indexes.legacy.length, 0);
  assert.deepEqual(dryRun.before.indexes.unknownTeamWideUnique, [{
    name: unknownIndexName,
    key: { teamId: 1, name: 1 },
    unique: true,
    sparse: false,
    partialFilterExpression: null,
    collation: null
  }]);
  assert.equal(dryRun.before.blockers.length, 1);
  assert.equal(
    dryRun.before.blockers[0].code,
    'EQUIPMENT_CATEGORY_UNKNOWN_TEAM_WIDE_UNIQUE_INDEX'
  );
  assert.equal(dryRun.before.blockers[0].index.name, unknownIndexName);
  assert.equal(execute.status, 'BLOCKED');
  assert.equal(execute.writePerformed, false);
  assert.deepEqual(
    afterIndexes.map(({ name }) => name).sort(),
    beforeIndexes.map(({ name }) => name).sort()
  );
});

test('unexpected indexes using the desired key or name block dry-run before any write', async () => {
  const cases = [
    {
      name: 'same key under another name',
      key: DESIRED_INDEX.key,
      options: { unique: true, name: 'uq_equipment_category_parent_name_unexpected' }
    },
    {
      name: 'desired name on another key',
      key: { teamId: 1, _id: 1 },
      options: { unique: true, name: DESIRED_INDEX.name }
    }
  ];

  for (const fixtureCase of cases) {
    await mongoose.connection.db.dropDatabase();
    await mongoose.connection.db.createCollection(COLLECTION_NAME);
    const collection = mongoose.connection.db.collection(COLLECTION_NAME);
    await collection.createIndex(LEGACY_INDEX.key, {
      unique: true,
      name: LEGACY_INDEX.name
    });
    await seedLegacyState();
    await collection.createIndex(fixtureCase.key, fixtureCase.options);
    const beforeIndexes = await collection.indexes();
    const service = createEquipmentCategoryIndexMigrationService({
      connection: mongoose.connection,
      backupVerifier
    });

    const dryRun = await service.run();
    const execute = await service.run({
      execute: true,
      confirmDatabase: DATABASE_NAME,
      backupDirectory: BACKUP_DIRECTORY
    });
    const afterIndexes = await collection.indexes();

    assert.equal(dryRun.status, 'DRY_RUN_BLOCKED', fixtureCase.name);
    assert.equal(execute.status, 'BLOCKED', fixtureCase.name);
    assert.equal(execute.writePerformed, false, fixtureCase.name);
    assert.equal(
      dryRun.before.blockers.some(({ code }) => (
        code === 'EQUIPMENT_CATEGORY_CONFLICTING_DESIRED_INDEX'
      )),
      true,
      fixtureCase.name
    );
    assert.deepEqual(
      afterIndexes.map(({ name }) => name).sort(),
      beforeIndexes.map(({ name }) => name).sort(),
      fixtureCase.name
    );
  }
});

test('an extra stricter index on the desired key blocks an otherwise applied state', async () => {
  const collection = mongoose.connection.db.collection(COLLECTION_NAME);
  await collection.dropIndex(LEGACY_INDEX.name);
  await collection.createIndex(DESIRED_INDEX.key, {
    unique: true,
    name: DESIRED_INDEX.name
  });
  await collection.createIndex(DESIRED_INDEX.key, {
    unique: true,
    name: 'uq_equipment_category_parent_name_case_insensitive',
    collation: { locale: 'en', strength: 2 }
  });
  const service = createEquipmentCategoryIndexMigrationService({
    connection: mongoose.connection,
    backupVerifier
  });

  const dryRun = await service.run();
  const execute = await service.run({
    execute: true,
    confirmDatabase: DATABASE_NAME,
    backupDirectory: BACKUP_DIRECTORY
  });

  assert.equal(dryRun.before.indexes.desiredPresent, true);
  assert.equal(dryRun.status, 'DRY_RUN_BLOCKED');
  assert.equal(execute.status, 'BLOCKED');
  assert.equal(execute.writePerformed, false);
  assert.equal(dryRun.before.indexes.conflictingDesired.length, 1);
  assert.equal(
    dryRun.before.indexes.conflictingDesired[0].name,
    'uq_equipment_category_parent_name_case_insensitive'
  );
});

test('same-parent duplicate categories block both dry-run readiness and index writes', async () => {
  const collection = mongoose.connection.db.collection(COLLECTION_NAME);
  await collection.dropIndex(LEGACY_INDEX.name);
  await collection.insertMany([
    {
      _id: objectId(),
      teamId: fixture.teamId,
      parentId: fixture.primaryAId,
      name: '重复二级名称',
      createdBy: fixture.actorId,
      updatedBy: fixture.actorId
    },
    {
      _id: objectId(),
      teamId: fixture.teamId,
      parentId: fixture.primaryAId,
      name: '重复二级名称',
      createdBy: fixture.actorId,
      updatedBy: fixture.actorId
    }
  ]);
  const service = createEquipmentCategoryIndexMigrationService({
    connection: mongoose.connection,
    backupVerifier
  });

  const dryRun = await service.run();
  const execute = await service.run({
    execute: true,
    confirmDatabase: DATABASE_NAME,
    backupDirectory: BACKUP_DIRECTORY
  });

  assert.equal(dryRun.status, 'DRY_RUN_BLOCKED');
  assert.equal(execute.status, 'BLOCKED');
  assert.equal(execute.writePerformed, false);
  assert.equal(execute.before.blockers[0].code, 'EQUIPMENT_CATEGORY_SAME_PARENT_DUPLICATE');
  assert.ok(!(await collection.indexes()).some(({ name }) => name === DESIRED_INDEX.name));
});

test('execute requires the exact database confirmation before checking the backup', async () => {
  let backupCalls = 0;
  const service = createEquipmentCategoryIndexMigrationService({
    connection: mongoose.connection,
    backupVerifier: async (...args) => {
      backupCalls += 1;
      return backupVerifier(...args);
    }
  });
  await assert.rejects(service.run({
    execute: true,
    confirmDatabase: 'wrong_database',
    backupDirectory: BACKUP_DIRECTORY
  }), (error) => error.code === 'DATABASE_CONFIRMATION_MISMATCH');
  assert.equal(backupCalls, 0);
});

test('execute rejects a backup from any non-exact MongoDB target before index writes', async () => {
  const cases = [
    {
      name: 'wrong host',
      databaseOverrides: { hosts: ['localhost'] }
    },
    {
      name: 'wrong server port',
      databaseOverrides: { servers: ['127.0.0.1:27017'] }
    },
    {
      name: 'wrong replica set',
      databaseOverrides: { replicaSet: 'unexpected_replica_set' }
    },
    {
      name: 'missing target fields',
      databaseOverrides: {
        hosts: undefined,
        servers: undefined,
        replicaSet: undefined
      }
    }
  ];
  const collection = mongoose.connection.db.collection(COLLECTION_NAME);
  const beforeIndexes = await collection.indexes();

  for (const fixtureCase of cases) {
    const service = createEquipmentCategoryIndexMigrationService({
      connection: mongoose.connection,
      backupVerifier: async (directory, options) => {
        assert.equal(directory, BACKUP_DIRECTORY);
        assert.deepEqual(options, { verifyFiles: true });
        return backupVerificationResult(fixtureCase.databaseOverrides);
      }
    });
    await assert.rejects(service.run({
      execute: true,
      confirmDatabase: DATABASE_NAME,
      backupDirectory: BACKUP_DIRECTORY
    }), (error) => {
      assert.equal(error.code, 'BACKUP_MONGODB_TARGET_MISMATCH');
      return true;
    }, fixtureCase.name);
    assert.deepEqual(
      (await collection.indexes()).map(({ name }) => name).sort(),
      beforeIndexes.map(({ name }) => name).sort(),
      fixtureCase.name
    );
    assert.equal(
      await mongoose.connection.db.collection(SCHEMA_LEDGER_COLLECTION).findOne({
        _id: EXPECTED_SCHEMA_LEDGER._id
      }),
      null,
      fixtureCase.name
    );
  }
});

test('retry converges after createIndex succeeds and its caller receives an error', async () => {
  await assertForwardConvergenceAfterFault('createIndex');
});

test('retry converges after dropIndex succeeds and its caller receives an error', async () => {
  await assertForwardConvergenceAfterFault('dropIndex');
});

test('retry converges after schema ledger insert succeeds and its caller receives an error', async () => {
  await assertForwardConvergenceAfterFault('insertOne');
});

test('retry converges after the final schema ledger read fails once', async () => {
  await assertForwardConvergenceAfterFault('finalLedgerRead');
});
