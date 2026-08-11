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
const AUTH_SESSIONS_UUID = '12345678-90ab-cdef-1234-567890abcdef';
const EQUIPMENT_UUID = '00112233-4455-6677-8899-aabbccddeeff';
const USERS_UUID = 'ffeeddcc-bbaa-9988-7766-554433221100';

function defaultCollectionHashes() {
  return {
    authsessions: '4'.repeat(32),
    equipment: '2'.repeat(32),
    users: '3'.repeat(32)
  };
}

function defaultDatabaseUuids() {
  return {
    authsessions: AUTH_SESSIONS_UUID,
    equipment: EQUIPMENT_UUID,
    users: USERS_UUID
  };
}

function defaultIndexes() {
  return {
    authsessions: [
      { name: 'uq_auth_session_jti_hash', key: { jtiHash: 1 }, unique: true, v: 2 },
      {
        name: 'ttl_auth_session_expires_at',
        key: { expiresAt: 1 },
        expireAfterSeconds: 0,
        v: 2
      },
      { name: '_id_', key: { _id: 1 }, v: 2 }
    ],
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
  collectionHashes = defaultCollectionHashes(),
  databaseHash = '1'.repeat(32),
  databaseUuids = defaultDatabaseUuids(),
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
          collections: collectionHashes,
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
  assert.equal(report.format, 'task-distribution-v2-replica-write-anchor/v2');
  assert.equal(report.anchor.database, 'customer_acceptance_v2_test');
  assert.equal(report.anchor.replicaSet, 'customer_acceptance_v2_rs');
  assert.deepEqual(report.anchor.databaseHash, {
    collections: {
      equipment: '2'.repeat(32),
      users: '3'.repeat(32)
    },
    uuids: {
      authsessions: AUTH_SESSIONS_UUID,
      equipment: EQUIPMENT_UUID,
      users: USERS_UUID
    },
    capped: [],
    excludedContentCollections: ['authsessions']
  });
  assert.deepEqual(report.anchor.collectionIndexes, {
    authsessions: [
      { name: '_id_', key: [['_id', 1]], options: { v: 2 } },
      {
        name: 'ttl_auth_session_expires_at',
        key: [['expiresAt', 1]],
        options: { expireAfterSeconds: 0, v: 2 }
      },
      {
        name: 'uq_auth_session_jti_hash',
        key: [['jtiHash', 1]],
        options: { unique: true, v: 2 }
      }
    ],
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
    'listIndexes:authsessions',
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
      databaseUuids: {
        equipment: EQUIPMENT_UUID,
        users: USERS_UUID,
        authsessions: AUTH_SESSIONS_UUID
      },
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

test('rejects a missing authsessions collection or an invalid TTL expiry index', async () => {
  const collectionHashesWithoutAuthSessions = defaultCollectionHashes();
  delete collectionHashesWithoutAuthSessions.authsessions;
  const databaseUuidsWithoutAuthSessions = defaultDatabaseUuids();
  delete databaseUuidsWithoutAuthSessions.authsessions;
  await assert.rejects(
    captureReleaseMongoAnchor({
      connection: fakeConnection({
        collectionHashes: collectionHashesWithoutAuthSessions,
        databaseUuids: databaseUuidsWithoutAuthSessions
      }),
      releaseId: RELEASE_ID,
      handoffNonce: NONCE
    }),
    { code: 'MONGODB_TTL_COLLECTION_MISSING' }
  );

  const missingTtlIndex = defaultIndexes();
  missingTtlIndex.authsessions = missingTtlIndex.authsessions.filter(
    (index) => index.name !== 'ttl_auth_session_expires_at'
  );
  await assert.rejects(
    captureReleaseMongoAnchor({
      connection: fakeConnection({ indexesByCollection: missingTtlIndex }),
      releaseId: RELEASE_ID,
      handoffNonce: NONCE
    }),
    { code: 'MONGODB_TTL_COLLECTION_INDEX_INVALID' }
  );

  for (const mutate of [
    (index) => { index.name = 'ttl_auth_session_wrong_name'; },
    (index) => { index.key = { deletedAt: 1 }; },
    (index) => { index.expireAfterSeconds = 60; }
  ]) {
    const invalidIndexes = defaultIndexes();
    const ttlIndex = invalidIndexes.authsessions.find(
      (index) => index.name === 'ttl_auth_session_expires_at'
    );
    mutate(ttlIndex);
    await assert.rejects(
      captureReleaseMongoAnchor({
        connection: fakeConnection({ indexesByCollection: invalidIndexes }),
        releaseId: RELEASE_ID,
        handoffNonce: NONCE
      }),
      { code: 'MONGODB_TTL_COLLECTION_INDEX_INVALID' }
    );
  }
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

test('anchor comparison tolerates authsessions TTL content expiry while retaining a stable business anchor', async () => {
  const before = await captureReleaseMongoAnchor({
    connection: fakeConnection({
      collectionHashes: {
        ...defaultCollectionHashes(),
        authsessions: '4'.repeat(32)
      },
      databaseHash: '1'.repeat(32)
    }),
    releaseId: RELEASE_ID,
    handoffNonce: NONCE
  });
  const afterTtlExpiry = await captureReleaseMongoAnchor({
    connection: fakeConnection({
      collectionHashes: {
        ...defaultCollectionHashes(),
        authsessions: '5'.repeat(32)
      },
      databaseHash: '6'.repeat(32)
    }),
    releaseId: RELEASE_ID,
    handoffNonce: NONCE
  });

  assert.equal(before.anchor.databaseHash.collections.authsessions, undefined);
  assert.equal(afterTtlExpiry.anchor.databaseHash.collections.authsessions, undefined);
  assert.notDeepEqual(before.databaseObservation, afterTtlExpiry.databaseObservation);
  assert.equal(before.databaseObservation.collections.authsessions, '4'.repeat(32));
  assert.equal(afterTtlExpiry.databaseObservation.collections.authsessions, '5'.repeat(32));
  assert.equal(before.anchor.databaseHash.uuids.authsessions, AUTH_SESSIONS_UUID);
  assert.deepEqual(
    before.anchor.collectionIndexes.authsessions,
    afterTtlExpiry.anchor.collectionIndexes.authsessions
  );
  assert.equal(before.writeAnchorSha256, afterTtlExpiry.writeAnchorSha256);
  assert.equal(assertSameReleaseMongoAnchor(before, afterTtlExpiry), true);
});

test('anchor comparison rejects business data, collection UUID, index, process or topology drift', async () => {
  const before = await captureReleaseMongoAnchor({ connection: fakeConnection(), releaseId: RELEASE_ID, handoffNonce: NONCE });
  const changedDatabase = await captureReleaseMongoAnchor({
    connection: fakeConnection({
      collectionHashes: {
        ...defaultCollectionHashes(),
        equipment: '7'.repeat(32)
      },
      databaseHash: '8'.repeat(32)
    }),
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
        authsessions: AUTH_SESSIONS_UUID,
        equipment: '11112233-4455-6677-8899-aabbccddeeff',
        users: USERS_UUID
      }
    }),
    releaseId: RELEASE_ID,
    handoffNonce: NONCE
  });
  assert.throws(() => assertSameReleaseMongoAnchor(before, changedUuid), { code: 'REPLICA_WRITE_ANCHOR_DRIFT' });

  const changedAuthSessionUuid = await captureReleaseMongoAnchor({
    connection: fakeConnection({
      databaseUuids: {
        ...defaultDatabaseUuids(),
        authsessions: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
      }
    }),
    releaseId: RELEASE_ID,
    handoffNonce: NONCE
  });
  assert.throws(
    () => assertSameReleaseMongoAnchor(before, changedAuthSessionUuid),
    { code: 'REPLICA_WRITE_ANCHOR_DRIFT' }
  );

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

  const changedAuthSessionIndexes = defaultIndexes();
  changedAuthSessionIndexes.authsessions.find(
    (index) => index.name === 'uq_auth_session_jti_hash'
  ).unique = false;
  const changedAuthSessionIndexOnly = await captureReleaseMongoAnchor({
    connection: fakeConnection({ indexesByCollection: changedAuthSessionIndexes }),
    releaseId: RELEASE_ID,
    handoffNonce: NONCE
  });
  assert.throws(
    () => assertSameReleaseMongoAnchor(before, changedAuthSessionIndexOnly),
    { code: 'REPLICA_WRITE_ANCHOR_DRIFT' }
  );

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

test('anchor comparison rejects legacy v1 reports after the TTL-aware format bump', async () => {
  const before = await captureReleaseMongoAnchor({
    connection: fakeConnection(),
    releaseId: RELEASE_ID,
    handoffNonce: NONCE
  });
  const after = await captureReleaseMongoAnchor({
    connection: fakeConnection(),
    releaseId: RELEASE_ID,
    handoffNonce: NONCE
  });
  const legacy = structuredClone(before);
  legacy.format = 'task-distribution-v2-replica-write-anchor/v1';

  assert.throws(
    () => assertSameReleaseMongoAnchor(legacy, after),
    { code: 'REPLICA_WRITE_ANCHOR_REPORT_INVALID' }
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
