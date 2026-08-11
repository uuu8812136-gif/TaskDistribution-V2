'use strict';

const { createHash } = require('node:crypto');

const RELEASE_MONGO_ANCHOR_FORMAT = 'task-distribution-v2-replica-write-anchor/v2';
const EXPECTED_DATABASE = 'customer_acceptance_v2_test';
const EXPECTED_REPLICA_SET = 'customer_acceptance_v2_rs';
const RELEASE_ID_PATTERN = /^v2-\d{8}-[0-9a-f]{7}$/;
const NONCE_PATTERN = /^[0-9a-f]{64}$/;
const TTL_MANAGED_CONTENT_COLLECTIONS = Object.freeze(['authsessions']);

class ReleaseMongoAnchorError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'ReleaseMongoAnchorError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new ReleaseMongoAnchorError(code, message, details);
}

function normalizeUuid(value, collection) {
  let normalized = '';
  if (typeof value === 'string') {
    normalized = value;
  } else if (value && typeof value.toHexString === 'function') {
    normalized = value.toHexString();
  } else if (value && typeof value.toString === 'function') {
    normalized = value.toString();
  }
  normalized = normalized.trim().toLowerCase();
  if (!normalized || normalized === '[object object]') {
    fail('MONGODB_COLLECTION_UUID_INVALID', 'MongoDB dbHash returned an invalid collection UUID', {
      collection
    });
  }
  return normalized;
}

function databaseHashParts(value) {
  const md5 = String(value?.md5 || '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(md5)) {
    fail('MONGODB_DATABASE_HASH_INVALID', 'MongoDB dbHash did not return a valid database hash');
  }
  if (!value?.collections || Array.isArray(value.collections) || typeof value.collections !== 'object') {
    fail('MONGODB_COLLECTION_HASHES_INVALID', 'MongoDB dbHash did not return collection hashes');
  }

  const collections = Object.fromEntries(Object.keys(value.collections).sort().map((name) => {
    const hash = String(value.collections[name] || '').toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(hash)) {
      fail('MONGODB_COLLECTION_HASH_INVALID', 'MongoDB dbHash returned an invalid collection hash', {
        collection: name
      });
    }
    return [name, hash];
  }));
  if (!value?.uuids || Array.isArray(value.uuids) || typeof value.uuids !== 'object') {
    fail('MONGODB_COLLECTION_UUIDS_INVALID', 'MongoDB dbHash did not return collection UUIDs');
  }
  const collectionNames = Object.keys(collections).sort();
  const uuidNames = Object.keys(value.uuids).sort();
  if (JSON.stringify(uuidNames) !== JSON.stringify(collectionNames)) {
    fail('MONGODB_COLLECTION_UUIDS_INVALID', 'MongoDB dbHash collection UUIDs do not match its collection hashes', {
      collections: collectionNames,
      uuidCollections: uuidNames
    });
  }
  const uuids = Object.fromEntries(uuidNames.map((name) => [
    name,
    normalizeUuid(value.uuids[name], name)
  ]));

  if (!Array.isArray(value.capped)) {
    fail('MONGODB_CAPPED_COLLECTIONS_INVALID', 'MongoDB dbHash did not return capped collection metadata');
  }
  const capped = [...new Set(value.capped.map((name) => {
    if (typeof name !== 'string' || !name) {
      fail('MONGODB_CAPPED_COLLECTION_INVALID', 'MongoDB dbHash returned invalid capped collection metadata');
    }
    if (!Object.hasOwn(collections, name)) {
      fail('MONGODB_CAPPED_COLLECTION_INVALID', 'MongoDB dbHash returned a capped collection without a collection hash', {
        collection: name
      });
    }
    return name;
  }))].sort();

  return { md5, collections, uuids, capped };
}

function normalizeIndexValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      fail('MONGODB_INDEX_METADATA_INVALID', 'MongoDB index metadata contains a non-finite number');
    }
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      fail('MONGODB_INDEX_METADATA_INVALID', 'MongoDB index metadata contains an invalid date');
    }
    return { $date: value.toISOString() };
  }
  if (Buffer.isBuffer(value)) return { $binary: value.toString('base64') };
  if (Array.isArray(value)) return value.map(normalizeIndexValue);
  if (value && typeof value.toHexString === 'function') {
    return { $hex: String(value.toHexString()).toLowerCase() };
  }
  if (value && typeof value.toJSON === 'function') {
    const jsonValue = value.toJSON();
    if (jsonValue !== value) return normalizeIndexValue(jsonValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [
      key,
      normalizeIndexValue(value[key])
    ]));
  }
  fail('MONGODB_INDEX_METADATA_INVALID', 'MongoDB index metadata contains an unsupported value');
}

function normalizeCollectionIndexes(collection, indexes) {
  if (!Array.isArray(indexes)) {
    fail('MONGODB_INDEX_METADATA_INVALID', 'MongoDB listIndexes did not return an index array', {
      collection
    });
  }
  const normalized = indexes.map((index) => {
    if (
      !index ||
      typeof index !== 'object' ||
      Array.isArray(index) ||
      typeof index.name !== 'string' ||
      !index.name ||
      !index.key ||
      typeof index.key !== 'object' ||
      Array.isArray(index.key)
    ) {
      fail('MONGODB_INDEX_METADATA_INVALID', 'MongoDB listIndexes returned invalid index metadata', {
        collection
      });
    }
    const key = Object.entries(index.key).map(([field, direction]) => [
      field,
      normalizeIndexValue(direction)
    ]);
    if (key.length === 0) {
      fail('MONGODB_INDEX_METADATA_INVALID', 'MongoDB listIndexes returned an index without keys', {
        collection,
        index: index.name
      });
    }
    const options = Object.fromEntries(Object.keys(index)
      .filter((name) => name !== 'name' && name !== 'key')
      .sort()
      .map((name) => [name, normalizeIndexValue(index[name])]));
    return { name: index.name, key, options };
  });
  normalized.sort((left, right) => {
    const nameOrder = left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
    if (nameOrder !== 0) return nameOrder;
    const leftJson = JSON.stringify(left);
    const rightJson = JSON.stringify(right);
    return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
  });
  return normalized;
}

function stableIdentityPayload({ hello, replStatus, serverStatus }) {
  return {
    server: {
      me: hello.me || null,
      primary: hello.primary || null,
      setVersion: hello.setVersion ?? null,
      electionId: hello.electionId ? String(hello.electionId) : null,
      topologyProcessId: hello.topologyVersion?.processId
        ? String(hello.topologyVersion.processId)
        : null,
      topologyCounter: hello.topologyVersion?.counter === undefined
        ? null
        : String(hello.topologyVersion.counter),
      pid: Number(serverStatus.pid),
      process: serverStatus.process || null,
      version: serverStatus.version || null
    },
    replication: {
      term: replStatus.term === undefined ? null : String(replStatus.term)
    }
  };
}

function stableDatabaseHashParts(databaseHash, collectionIndexes) {
  for (const collection of TTL_MANAGED_CONTENT_COLLECTIONS) {
    if (!Object.hasOwn(databaseHash.collections, collection)) {
      fail('MONGODB_TTL_COLLECTION_MISSING', 'Required TTL-managed collection is missing', {
        collection
      });
    }
    const ttlIndex = collectionIndexes[collection]?.find((index) => (
      index.name === 'ttl_auth_session_expires_at' &&
      JSON.stringify(index.key) === JSON.stringify([['expiresAt', 1]]) &&
      index.options?.expireAfterSeconds === 0
    ));
    if (!ttlIndex) {
      fail(
        'MONGODB_TTL_COLLECTION_INDEX_INVALID',
        'TTL-managed collection does not have the required expiry index',
        { collection }
      );
    }
  }

  return {
    collections: Object.fromEntries(Object.entries(databaseHash.collections)
      .filter(([name]) => !TTL_MANAGED_CONTENT_COLLECTIONS.includes(name))),
    uuids: databaseHash.uuids,
    capped: databaseHash.capped,
    excludedContentCollections: [...TTL_MANAGED_CONTENT_COLLECTIONS]
  };
}

function stableAnchorPayload({ identity, databaseState }) {
  return {
    database: EXPECTED_DATABASE,
    replicaSet: EXPECTED_REPLICA_SET,
    databaseHash: stableDatabaseHashParts(
      databaseState.databaseHash,
      databaseState.collectionIndexes
    ),
    collectionIndexes: databaseState.collectionIndexes,
    server: identity.server,
    replication: identity.replication
  };
}

function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function validateIdentity({ hello, replStatus, serverStatus }) {
  if (hello.setName !== EXPECTED_REPLICA_SET || replStatus.set !== EXPECTED_REPLICA_SET) {
    fail('REPLICA_SET_IDENTITY_INVALID', 'MongoDB replica-set identity does not match the recovery target', {
      expected: EXPECTED_REPLICA_SET,
      helloSetName: hello.setName || null,
      statusSetName: replStatus.set || null
    });
  }
  if (hello.isWritablePrimary !== true || replStatus.myState !== 1) {
    fail('REPLICA_SET_PRIMARY_REQUIRED', 'MongoDB recovery member must be the writable primary', {
      isWritablePrimary: hello.isWritablePrimary === true,
      myState: replStatus.myState ?? null
    });
  }
  if (
    typeof hello.me !== 'string' ||
    hello.me.length === 0 ||
    hello.primary !== hello.me
  ) {
    fail('REPLICA_SET_PRIMARY_IDENTITY_INVALID', 'MongoDB primary identity is missing or inconsistent', {
      me: hello.me || null,
      primary: hello.primary || null
    });
  }
  if (
    hello.setVersion === undefined ||
    !hello.electionId ||
    !hello.topologyVersion?.processId ||
    hello.topologyVersion.counter === undefined ||
    hello.topologyVersion.counter === null ||
    replStatus.term === undefined ||
    replStatus.term === null
  ) {
    fail('REPLICA_SET_TOPOLOGY_IDENTITY_INVALID', 'MongoDB topology identity is incomplete');
  }
  if (!Number.isSafeInteger(Number(serverStatus.pid)) || Number(serverStatus.pid) <= 0) {
    fail('MONGODB_PROCESS_ID_INVALID', 'MongoDB serverStatus did not return a valid process id');
  }
}

async function captureIdentity(admin) {
  const hello = await admin.command({ hello: 1 });
  const replStatus = await admin.command({ replSetGetStatus: 1 });
  const serverStatus = await admin.command({ serverStatus: 1 });
  validateIdentity({ hello, replStatus, serverStatus });
  return stableIdentityPayload({ hello, replStatus, serverStatus });
}

async function captureDatabaseState(db) {
  const databaseHash = databaseHashParts(await db.command({ dbHash: 1 }));
  const collectionIndexes = {};
  for (const collection of Object.keys(databaseHash.collections).sort()) {
    const indexes = await db.collection(collection).listIndexes().toArray();
    collectionIndexes[collection] = normalizeCollectionIndexes(collection, indexes);
  }
  return { databaseHash, collectionIndexes };
}

async function captureReleaseMongoAnchor({
  connection,
  releaseId,
  handoffNonce,
  now = () => new Date()
} = {}) {
  if (!connection?.db) {
    throw new TypeError('A connected MongoDB connection is required');
  }
  if (!RELEASE_ID_PATTERN.test(String(releaseId || ''))) {
    fail('RELEASE_ID_INVALID', 'Release id is invalid');
  }
  if (!NONCE_PATTERN.test(String(handoffNonce || ''))) {
    fail('HANDOFF_NONCE_INVALID', 'Handoff nonce must be exactly 64 lowercase hexadecimal characters');
  }
  const databaseName = connection.name || connection.db.databaseName;
  if (databaseName !== EXPECTED_DATABASE) {
    fail('DATABASE_TARGET_INVALID', 'MongoDB connection is not the isolated customer acceptance database', {
      expected: EXPECTED_DATABASE,
      actual: databaseName || null
    });
  }

  const admin = connection.db.admin();
  const identityBefore = await captureIdentity(admin);
  const databaseState = await captureDatabaseState(connection.db);
  const identityAfter = await captureIdentity(admin);
  if (JSON.stringify(identityBefore) !== JSON.stringify(identityAfter)) {
    fail(
      'REPLICA_SET_IDENTITY_CHANGED_DURING_CAPTURE',
      'MongoDB identity changed while the release anchor was being captured',
      { before: identityBefore, after: identityAfter }
    );
  }

  const anchor = stableAnchorPayload({ identity: identityAfter, databaseState });
  return {
    format: RELEASE_MONGO_ANCHOR_FORMAT,
    status: 'REPLICA_WRITE_ANCHOR_CAPTURED',
    observedAt: now().toISOString(),
    releaseId,
    handoffNonce,
    writeAnchorSha256: sha256Json(anchor),
    anchor,
    databaseObservation: databaseState.databaseHash
  };
}

function assertSameReleaseMongoAnchor(before, after) {
  const observedAt = [];
  for (const report of [before, after]) {
    if (
      report?.format !== RELEASE_MONGO_ANCHOR_FORMAT ||
      report?.status !== 'REPLICA_WRITE_ANCHOR_CAPTURED' ||
      !NONCE_PATTERN.test(String(report.handoffNonce || '')) ||
      !/^[0-9a-f]{64}$/.test(String(report.writeAnchorSha256 || ''))
    ) {
      fail('REPLICA_WRITE_ANCHOR_REPORT_INVALID', 'MongoDB write-anchor report is invalid');
    }
    if (sha256Json(report.anchor) !== report.writeAnchorSha256) {
      fail('REPLICA_WRITE_ANCHOR_HASH_INVALID', 'MongoDB write-anchor report hash is invalid');
    }
    const observedAtValue = typeof report.observedAt === 'string' ? report.observedAt : '';
    const observedAtMilliseconds = Date.parse(observedAtValue);
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(observedAtValue) ||
      !Number.isFinite(observedAtMilliseconds) ||
      new Date(observedAtMilliseconds).toISOString() !== observedAtValue
    ) {
      fail('REPLICA_WRITE_ANCHOR_OBSERVED_AT_INVALID', 'MongoDB write-anchor observedAt must be a valid ISO timestamp');
    }
    observedAt.push(observedAtMilliseconds);
  }
  if (observedAt[1] < observedAt[0]) {
    fail('REPLICA_WRITE_ANCHOR_TIME_ORDER_INVALID', 'MongoDB write-anchor comparison timestamps are out of order', {
      before: before.observedAt,
      after: after.observedAt
    });
  }
  if (
    before.releaseId !== after.releaseId ||
    before.handoffNonce !== after.handoffNonce ||
    before.writeAnchorSha256 !== after.writeAnchorSha256
  ) {
    fail('REPLICA_WRITE_ANCHOR_DRIFT', 'MongoDB database final state or identity changed during the stopped backup window', {
      before: before.writeAnchorSha256,
      after: after.writeAnchorSha256
    });
  }
  return true;
}

module.exports = {
  EXPECTED_DATABASE,
  EXPECTED_REPLICA_SET,
  NONCE_PATTERN,
  RELEASE_ID_PATTERN,
  RELEASE_MONGO_ANCHOR_FORMAT,
  TTL_MANAGED_CONTENT_COLLECTIONS,
  ReleaseMongoAnchorError,
  assertSameReleaseMongoAnchor,
  captureReleaseMongoAnchor,
  databaseHashParts,
  normalizeCollectionIndexes,
  sha256Json,
  stableDatabaseHashParts,
  stableIdentityPayload,
  stableAnchorPayload
};
