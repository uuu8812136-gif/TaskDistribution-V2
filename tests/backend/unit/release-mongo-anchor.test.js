'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  assertSameReleaseMongoAnchor,
  captureReleaseMongoAnchor,
  sha256Json
} = require('../../../app/services/releaseMongoAnchorService');
const {
  parseArgs,
  readJsonFile,
  writeJsonCreateNew
} = require('../../../app/script/captureReleaseMongoAnchor');

const RELEASE_ID = 'v2-20260811-abcdef0';
const NONCE = 'a'.repeat(64);
const EQUIPMENT_UUID = '00112233-4455-6677-8899-aabbccddeeff';
const USERS_UUID = 'ffeeddcc-bbaa-9988-7766-554433221100';

function defaultIndexes() {
  return {
    equipment: [
      { name: 'serial_1', key: { serialNumber: 1 }, unique: true, v: 2 },
      { name: '_id_', key: { _id: 1 }, v: 2 }
    ],
    users: [
      { name: '_id_', key: { _id: 1 }, v: 2 }
    ]
  };
}

function fakeTimestamp(seconds, increment) {
  return {
    getHighBitsUnsigned: () => seconds,
    getLowBitsUnsigned: () => increment
  };
}

function fakeConnection({
  capped = [],
  databaseHash = '1'.repeat(32),
  databaseUuids = { users: USERS_UUID, equipment: EQUIPMENT_UUID },
  indexesByCollection = defaultIndexes(),
  isWritablePrimary = true,
  myState = 1,
  oplogSeconds = 100,
  pid = 4321,
  primary = '127.0.0.1:27150',
  setName = 'customer_acceptance_v2_rs',
  topologyProcessId = 'aaaaaaaaaaaaaaaaaaaaaaaa',
  topologyProcessIds = null
} = {}) {
  const commandLog = [];
  let helloCount = 0;
  const command = async (input) => {
    if (input.hello) {
      commandLog.push('hello');
      const processId = topologyProcessIds
        ? topologyProcessIds[Math.min(helloCount, topologyProcessIds.length - 1)]
        : topologyProcessId;
      helloCount += 1;
      return {
        setName,
        isWritablePrimary,
        me: '127.0.0.1:27150',
        primary,
        setVersion: 1,
        electionId: '7fffffff0000000000000001',
        topologyVersion: { processId, counter: 3 }
      };
    }
    if (input.replSetGetStatus) {
      commandLog.push('replSetGetStatus');
      const opTime = { ts: fakeTimestamp(oplogSeconds, 2), t: 4 };
      return {
        set: setName,
        myState,
        term: 4,
        optimes: {
          lastCommittedOpTime: opTime,
          appliedOpTime: opTime,
          durableOpTime: opTime
        }
      };
    }
    if (input.serverStatus) {
      commandLog.push('serverStatus');
      return { pid, process: 'mongod', version: '8.0.0' };
    }
    throw new Error('unexpected command');
  };
  const connection = {
    name: 'customer_acceptance_v2_test',
    db: {
      databaseName: 'customer_acceptance_v2_test',
      admin: () => ({ command }),
      command: async (input) => {
        if (!input.dbHash) throw new Error('unexpected database command');
        commandLog.push('dbHash');
        return {
          md5: databaseHash,
          collections: {
            equipment: '2'.repeat(32),
            users: '3'.repeat(32)
          },
          uuids: databaseUuids,
          capped,
          operationTime: fakeTimestamp(oplogSeconds, 2),
          timeMillis: oplogSeconds
        };
      },
      collection: (name) => ({
        listIndexes: () => ({
          toArray: async () => {
            commandLog.push(`listIndexes:${name}`);
            return indexesByCollection[name];
          }
        })
      })
    }
  };
  connection.commandLog = commandLog;
  return connection;
}

test('captures a deterministic replica-set identity and target database hash', async () => {
  const connection = fakeConnection();
  const report = await captureReleaseMongoAnchor({
    connection,
    releaseId: RELEASE_ID,
    handoffNonce: NONCE,
    now: () => new Date('2026-08-11T00:00:00.000Z')
  });
  assert.equal(report.status, 'REPLICA_WRITE_ANCHOR_CAPTURED');
  assert.equal(report.anchor.database, 'customer_acceptance_v2_test');
  assert.equal(report.anchor.replicaSet, 'customer_acceptance_v2_rs');
  assert.deepEqual(report.anchor.databaseHash, {
    md5: '1'.repeat(32),
    collections: {
      equipment: '2'.repeat(32),
      users: '3'.repeat(32)
    },
    uuids: {
      equipment: EQUIPMENT_UUID,
      users: USERS_UUID
    },
    capped: []
  });
  assert.deepEqual(report.anchor.collectionIndexes, {
    equipment: [
      { name: '_id_', key: [['_id', 1]], options: { v: 2 } },
      { name: 'serial_1', key: [['serialNumber', 1]], options: { unique: true, v: 2 } }
    ],
    users: [
      { name: '_id_', key: [['_id', 1]], options: { v: 2 } }
    ]
  });
  assert.deepEqual(report.anchor.replication, { term: '4' });
  assert.equal('latestOplog' in report.anchor, false);
  assert.equal(report.writeAnchorSha256, sha256Json(report.anchor));
  assert.equal(JSON.stringify(report).includes('MONGODB_URI'), false);
  assert.deepEqual(connection.commandLog, [
    'hello',
    'replSetGetStatus',
    'serverStatus',
    'dbHash',
    'listIndexes:equipment',
    'listIndexes:users',
    'hello',
    'replSetGetStatus',
    'serverStatus'
  ]);

  const reorderedIndexes = defaultIndexes();
  reorderedIndexes.equipment.reverse();
  reorderedIndexes.equipment[0] = { v: 2, key: { _id: 1 }, name: '_id_' };
  reorderedIndexes.equipment[1] = {
    v: 2,
    unique: true,
    key: { serialNumber: 1 },
    name: 'serial_1'
  };
  const reordered = await captureReleaseMongoAnchor({
    connection: fakeConnection({
      databaseUuids: { equipment: EQUIPMENT_UUID, users: USERS_UUID },
      indexesByCollection: reorderedIndexes
    }),
    releaseId: RELEASE_ID,
    handoffNonce: NONCE,
    now: () => new Date('2026-08-11T00:00:00.000Z')
  });
  assert.equal(reordered.writeAnchorSha256, report.writeAnchorSha256);
});

test('rejects the wrong replica set, database, primary state, malformed nonce and invalid dbHash', async () => {
  await assert.rejects(
    captureReleaseMongoAnchor({ connection: fakeConnection({ setName: 'wrong' }), releaseId: RELEASE_ID, handoffNonce: NONCE }),
    { code: 'REPLICA_SET_IDENTITY_INVALID' }
  );
  await assert.rejects(
    captureReleaseMongoAnchor({
      connection: fakeConnection({ isWritablePrimary: false, myState: 2 }),
      releaseId: RELEASE_ID,
      handoffNonce: NONCE
    }),
    { code: 'REPLICA_SET_PRIMARY_REQUIRED' }
  );
  await assert.rejects(
    captureReleaseMongoAnchor({
      connection: fakeConnection({ primary: '127.0.0.1:27151' }),
      releaseId: RELEASE_ID,
      handoffNonce: NONCE
    }),
    { code: 'REPLICA_SET_PRIMARY_IDENTITY_INVALID' }
  );
  const wrongDatabase = fakeConnection();
  wrongDatabase.name = 'other_v2_test';
  await assert.rejects(
    captureReleaseMongoAnchor({ connection: wrongDatabase, releaseId: RELEASE_ID, handoffNonce: NONCE }),
    { code: 'DATABASE_TARGET_INVALID' }
  );
  await assert.rejects(
    captureReleaseMongoAnchor({ connection: fakeConnection(), releaseId: RELEASE_ID, handoffNonce: 'bad' }),
    { code: 'HANDOFF_NONCE_INVALID' }
  );
  await assert.rejects(
    captureReleaseMongoAnchor({
      connection: fakeConnection({ databaseHash: 'invalid' }),
      releaseId: RELEASE_ID,
      handoffNonce: NONCE
    }),
    { code: 'MONGODB_DATABASE_HASH_INVALID' }
  );
});

test('rejects identity drift while database state is being captured', async () => {
  await assert.rejects(
    captureReleaseMongoAnchor({
      connection: fakeConnection({
        topologyProcessIds: [
          'aaaaaaaaaaaaaaaaaaaaaaaa',
          'bbbbbbbbbbbbbbbbbbbbbbbb'
        ]
      }),
      releaseId: RELEASE_ID,
      handoffNonce: NONCE
    }),
    { code: 'REPLICA_SET_IDENTITY_CHANGED_DURING_CAPTURE' }
  );
});

test('anchor comparison ignores periodic no-op progress', async () => {
  const before = await captureReleaseMongoAnchor({ connection: fakeConnection(), releaseId: RELEASE_ID, handoffNonce: NONCE });
  const afterNoOp = await captureReleaseMongoAnchor({
    connection: fakeConnection({ oplogSeconds: 101 }),
    releaseId: RELEASE_ID,
    handoffNonce: NONCE
  });
  assert.equal(assertSameReleaseMongoAnchor(before, afterNoOp), true);
});

test('anchor comparison rejects database final-state, process or topology replacement, and report tampering', async () => {
  const before = await captureReleaseMongoAnchor({ connection: fakeConnection(), releaseId: RELEASE_ID, handoffNonce: NONCE });
  const changedDatabase = await captureReleaseMongoAnchor({
    connection: fakeConnection({ databaseHash: '4'.repeat(32) }),
    releaseId: RELEASE_ID,
    handoffNonce: NONCE
  });
  assert.throws(
    () => assertSameReleaseMongoAnchor(before, changedDatabase),
    (error) => {
      assert.equal(error.code, 'REPLICA_WRITE_ANCHOR_DRIFT');
      assert.match(error.message, /database final state or identity changed/);
      assert.doesNotMatch(error.message, /accepted a write/);
      return true;
    }
  );

  const changedUuid = await captureReleaseMongoAnchor({
    connection: fakeConnection({
      databaseUuids: {
        equipment: '11112233-4455-6677-8899-aabbccddeeff',
        users: USERS_UUID
      }
    }),
    releaseId: RELEASE_ID,
    handoffNonce: NONCE
  });
  assert.throws(() => assertSameReleaseMongoAnchor(before, changedUuid), { code: 'REPLICA_WRITE_ANCHOR_DRIFT' });

  const changedCappedMetadata = await captureReleaseMongoAnchor({
    connection: fakeConnection({ capped: ['equipment'] }),
    releaseId: RELEASE_ID,
    handoffNonce: NONCE
  });
  assert.throws(
    () => assertSameReleaseMongoAnchor(before, changedCappedMetadata),
    { code: 'REPLICA_WRITE_ANCHOR_DRIFT' }
  );

  const changedIndexes = defaultIndexes();
  changedIndexes.equipment[0].unique = false;
  const changedIndexOnly = await captureReleaseMongoAnchor({
    connection: fakeConnection({ indexesByCollection: changedIndexes }),
    releaseId: RELEASE_ID,
    handoffNonce: NONCE
  });
  assert.throws(() => assertSameReleaseMongoAnchor(before, changedIndexOnly), { code: 'REPLICA_WRITE_ANCHOR_DRIFT' });

  const replacedProcess = await captureReleaseMongoAnchor({
    connection: fakeConnection({ pid: 4322 }),
    releaseId: RELEASE_ID,
    handoffNonce: NONCE
  });
  assert.throws(() => assertSameReleaseMongoAnchor(before, replacedProcess), { code: 'REPLICA_WRITE_ANCHOR_DRIFT' });

  const replacedTopology = await captureReleaseMongoAnchor({
    connection: fakeConnection({ topologyProcessId: 'bbbbbbbbbbbbbbbbbbbbbbbb' }),
    releaseId: RELEASE_ID,
    handoffNonce: NONCE
  });
  assert.throws(() => assertSameReleaseMongoAnchor(before, replacedTopology), { code: 'REPLICA_WRITE_ANCHOR_DRIFT' });

  const tampered = structuredClone(before);
  tampered.anchor.server.pid = 9999;
  assert.throws(() => assertSameReleaseMongoAnchor(before, tampered), { code: 'REPLICA_WRITE_ANCHOR_HASH_INVALID' });
});

test('anchor comparison requires valid ordered ISO observation timestamps', async () => {
  const before = await captureReleaseMongoAnchor({
    connection: fakeConnection(),
    releaseId: RELEASE_ID,
    handoffNonce: NONCE,
    now: () => new Date('2026-08-11T00:01:00.000Z')
  });
  const after = await captureReleaseMongoAnchor({
    connection: fakeConnection(),
    releaseId: RELEASE_ID,
    handoffNonce: NONCE,
    now: () => new Date('2026-08-11T00:00:59.999Z')
  });
  assert.throws(
    () => assertSameReleaseMongoAnchor(before, after),
    { code: 'REPLICA_WRITE_ANCHOR_TIME_ORDER_INVALID' }
  );

  const invalidObservedAt = structuredClone(after);
  invalidObservedAt.observedAt = '2026-08-11 00:01:00';
  assert.throws(
    () => assertSameReleaseMongoAnchor(before, invalidObservedAt),
    { code: 'REPLICA_WRITE_ANCHOR_OBSERVED_AT_INVALID' }
  );
});

test('CLI parsing is explicit and reports use create-new semantics', async () => {
  assert.deepEqual(parseArgs([
    '--release-id', RELEASE_ID,
    `--handoff-nonce=${NONCE}`,
    '--confirm-database', 'customer_acceptance_v2_test',
    '--report', 'E:\\evidence\\anchor-execute.json',
    '--compare-to', 'E:\\evidence\\anchor-hold.json'
  ]), {
    releaseId: RELEASE_ID,
    handoffNonce: NONCE,
    confirmDatabase: 'customer_acceptance_v2_test',
    report: 'E:\\evidence\\anchor-execute.json',
    compareTo: 'E:\\evidence\\anchor-hold.json'
  });
  assert.throws(() => parseArgs(['--unknown', 'value']), /Unknown option/);

  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'release-anchor-'));
  const report = path.join(directory, 'anchor.json');
  await writeJsonCreateNew(report, { ok: true });
  await assert.rejects(writeJsonCreateNew(report, { ok: false }), { code: 'EEXIST' });
  assert.deepEqual(JSON.parse(await fs.promises.readFile(report, 'utf8')), { ok: true });
  assert.deepEqual(await readJsonFile(report, '--compare-to'), { ok: true });
  await assert.rejects(
    readJsonFile(path.join(directory, 'missing.json'), '--compare-to'),
    { code: 'ENOENT' }
  );
  const invalid = path.join(directory, 'invalid.json');
  await fs.promises.writeFile(invalid, '{not-json}', 'utf8');
  await assert.rejects(readJsonFile(invalid, '--compare-to'), /must contain valid JSON/);
});
