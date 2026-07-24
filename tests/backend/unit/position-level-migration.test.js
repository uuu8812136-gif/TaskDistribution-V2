'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  POSITION_LEVEL_MIGRATIONS,
  analyzePositionLevelMigrationState,
  createPositionLevelMigrationService
} = require('../../../app/services/positionLevelMigrationService');

function fakeConnection(seed) {
  const documents = seed.map((value) => ({ ...value }));
  const collection = {
    find() {
      return {
        sort() { return this; },
        async toArray() { return documents.map((value) => ({ ...value })); }
      };
    },
    async bulkWrite(operations) {
      let matchedCount = 0;
      let modifiedCount = 0;
      for (const { updateOne } of operations) {
        const document = documents.find((value) => (
          value._id === updateOne.filter._id &&
          value.positionKey === updateOne.filter.positionKey &&
          value.positionLevel === updateOne.filter.positionLevel &&
          value.__v === updateOne.filter.__v
        ));
        if (!document) continue;
        matchedCount += 1;
        document.positionLevel = updateOne.update.$set.positionLevel;
        document.updatedAt = updateOne.update.$set.updatedAt;
        document.__v += updateOne.update.$inc.__v;
        modifiedCount += 1;
      }
      return { matchedCount, modifiedCount };
    }
  };
  return {
    name: 'customer_acceptance_v2_test',
    client: {
      topology: { description: { type: 'ReplicaSetWithPrimary' } }
    },
    async startSession() {
      return {
        async withTransaction(work) { return work(); },
        async endSession() {}
      };
    },
    db: {
      databaseName: 'customer_acceptance_v2_test',
      collection(name) {
        assert.equal(name, 'teammemberships');
        return collection;
      }
    },
    documents
  };
}

const legacySeed = () => [
  { _id: 'leader-1', positionKey: 'TEAM_LEADER', positionLevel: 4, __v: 0 },
  { _id: 'employee-1', positionKey: 'EMPLOYEE', positionLevel: 5, __v: 2 },
  { _id: 'employee-2', positionKey: 'EMPLOYEE', positionLevel: 6, __v: 1 }
];

test('position migration plan is fixed to TEAM_LEADER 4->5 and EMPLOYEE 5->6', () => {
  assert.deepEqual(POSITION_LEVEL_MIGRATIONS.map(({ positionKey, from, to }) => ({ positionKey, from, to })), [
    { positionKey: 'TEAM_LEADER', from: 4, to: 5 },
    { positionKey: 'EMPLOYEE', from: 5, to: 6 }
  ]);
});

test('dry-run reports legacy rows and never writes', async () => {
  const connection = fakeConnection(legacySeed());
  const report = await createPositionLevelMigrationService({ connection }).run();
  assert.equal(report.status, 'DRY_RUN_READY');
  assert.equal(report.writePerformed, false);
  assert.equal(report.before.plannedUpdateCount, 2);
  assert.deepEqual(connection.documents.map(({ positionLevel }) => positionLevel), [4, 5, 6]);
});

test('execute requires exact database confirmation and verified membership backup evidence', async () => {
  const connection = fakeConnection(legacySeed());
  const backupVerifier = async () => ({
    backupDirectory: 'E:\\backup',
    manifestSha256: 'abc',
    manifest: {
      backupId: 'backup-1',
      completedAt: '2026-07-23T00:00:00.000Z',
      database: {
        name: connection.name,
        collections: [{ name: 'teammemberships' }]
      },
      files: [{ file: `database/${connection.name}/teammemberships.bson` }]
    }
  });
  const service = createPositionLevelMigrationService({ connection, backupVerifier });
  await assert.rejects(
    service.run({ execute: true, confirmDatabase: 'wrong', backupDirectory: 'E:\\backup' }),
    (error) => error.code === 'DATABASE_CONFIRMATION_MISMATCH'
  );
  const report = await service.run({
    execute: true,
    confirmDatabase: connection.name,
    backupDirectory: 'E:\\backup'
  });
  assert.equal(report.status, 'EXECUTED');
  assert.equal(report.result.modifiedCount, 2);
  assert.deepEqual(connection.documents.map(({ positionLevel }) => positionLevel), [5, 6, 6]);
  assert.equal((await analyzePositionLevelMigrationState(connection.db)).updates.length, 0);
});

test('unexpected fixed-position levels block both dry-run and execute before writes', async () => {
  const connection = fakeConnection([
    { _id: 'invalid-1', positionKey: 'TEAM_LEADER', positionLevel: 2, __v: 0 }
  ]);
  const report = await createPositionLevelMigrationService({ connection }).run();
  assert.equal(report.status, 'DRY_RUN_BLOCKED');
  assert.equal(report.before.blockers[0].code, 'POSITION_LEVEL_UNEXPECTED');
  assert.equal(report.writePerformed, false);
});
