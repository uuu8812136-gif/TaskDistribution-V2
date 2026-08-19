'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  assertRequiredSchemaCapabilities,
  buildMongoConnectOptions,
  connectDatabaseForServer
} = require('../../../app/server');
const {
  EXPECTED_SCHEMA_LEDGER,
  SCHEMA_CAPABILITY
} = require('../../../app/services/equipmentCategoryIndexMigrationService');

test('production startup disables automatic index changes', () => {
  assert.deepEqual(buildMongoConnectOptions({ appEnv: 'production', nodeEnv: 'production' }), {
    autoIndex: false
  });
  assert.deepEqual(buildMongoConnectOptions({ appEnv: 'production', nodeEnv: 'development' }), {
    autoIndex: false
  });
  assert.deepEqual(buildMongoConnectOptions({ appEnv: 'staging', nodeEnv: 'production' }), {
    autoIndex: false
  });
});

test('development and test startup retain automatic index creation', () => {
  assert.deepEqual(buildMongoConnectOptions({ appEnv: 'development', nodeEnv: 'development' }), {
    autoIndex: true
  });
  assert.deepEqual(buildMongoConnectOptions({ appEnv: 'test', nodeEnv: 'test' }), {
    autoIndex: true
  });
});

test('production runner can require an explicit database schema capability', async () => {
  const database = {
    collection(name) {
      assert.equal(name, 'releaseschemaledger');
      return {
        async findOne(filter) {
          assert.deepEqual(filter, { _id: EXPECTED_SCHEMA_LEDGER._id });
          return { ...EXPECTED_SCHEMA_LEDGER };
        }
      };
    }
  };
  assert.deepEqual(await assertRequiredSchemaCapabilities(
    database,
    SCHEMA_CAPABILITY
  ), [SCHEMA_CAPABILITY]);
  assert.deepEqual(await assertRequiredSchemaCapabilities(database, ''), []);
});

test('startup rejects a missing required database schema capability', async () => {
  const database = {
    collection() {
      return {
        findOne: async () => null
      };
    }
  };
  await assert.rejects(
    assertRequiredSchemaCapabilities(database, SCHEMA_CAPABILITY),
    (error) => error.code === 'DATABASE_SCHEMA_CAPABILITY_MISSING'
  );
});

test('startup rejects a capability-only or field-drifted schema ledger', async () => {
  for (const ledger of [
    { capability: SCHEMA_CAPABILITY },
    { ...EXPECTED_SCHEMA_LEDGER, schemaVersion: 2 },
    { ...EXPECTED_SCHEMA_LEDGER, indexName: 'wrong_index' },
    { ...EXPECTED_SCHEMA_LEDGER, legacyIndexName: 'wrong_legacy_index' }
  ]) {
    const database = {
      collection: () => ({ findOne: async () => ledger })
    };
    await assert.rejects(
      assertRequiredSchemaCapabilities(database, SCHEMA_CAPABILITY),
      (error) => error.code === 'DATABASE_SCHEMA_CAPABILITY_MISSING'
    );
  }
});

test('schema validation failure disconnects MongoDB before startup returns an error', async () => {
  let disconnectCalls = 0;
  const mongooseClient = {
    connection: {
      readyState: 0,
      db: { collection: () => ({ findOne: async () => null }) }
    },
    async connect() { this.connection.readyState = 1; },
    async disconnect() {
      disconnectCalls += 1;
      this.connection.readyState = 0;
    }
  };
  await assert.rejects(
    connectDatabaseForServer({
      mongodbUri: 'mongodb://127.0.0.1/test',
      appEnv: 'production',
      nodeEnv: 'production'
    }, { mongooseClient, requiredSchemaCapabilities: SCHEMA_CAPABILITY }),
    (error) => error.code === 'DATABASE_SCHEMA_CAPABILITY_MISSING'
  );
  assert.equal(disconnectCalls, 1);
  assert.equal(mongooseClient.connection.readyState, 0);
});

test('production startup ensures contract indexes before reporting database readiness', async () => {
  const database = { collection: () => ({ findOne: async () => null }) };
  const mongooseClient = {
    connection: { readyState: 0, db: database },
    async connect(uri, options) {
      assert.equal(uri, 'mongodb://127.0.0.1/test');
      assert.deepEqual(options, { autoIndex: false });
      this.connection.readyState = 1;
    },
    async disconnect() { this.connection.readyState = 0; }
  };
  let ensuredDatabase = null;
  const result = await connectDatabaseForServer({
    mongodbUri: 'mongodb://127.0.0.1/test',
    appEnv: 'production',
    nodeEnv: 'production'
  }, {
    mongooseClient,
    requiredSchemaCapabilities: '',
    ensureRuntimeIndexes: async (value) => {
      ensuredDatabase = value;
      return { format: 'contract-index-test/v1', indexes: ['suppliers.unique'] };
    },
    ensureWechatIndexes: async (value) => {
      assert.equal(value, database);
      return { format: 'wechat-index-test/v1', indexes: ['bindings.user'] };
    }
  });

  assert.equal(ensuredDatabase, database);
  assert.deepEqual(result, {
    schemaCapabilities: [],
    contractIndexes: { format: 'contract-index-test/v1', indexes: ['suppliers.unique'] },
    wechatNotificationIndexes: { format: 'wechat-index-test/v1', indexes: ['bindings.user'] }
  });
});

test('development startup relies on automatic indexes and skips production index mutation', async () => {
  const mongooseClient = {
    connection: { readyState: 0, db: {} },
    async connect(uri, options) {
      assert.deepEqual(options, { autoIndex: true });
      this.connection.readyState = 1;
    },
    async disconnect() { this.connection.readyState = 0; }
  };
  const result = await connectDatabaseForServer({
    mongodbUri: 'mongodb://127.0.0.1/test',
    appEnv: 'test',
    nodeEnv: 'test'
  }, {
    mongooseClient,
    requiredSchemaCapabilities: '',
    ensureRuntimeIndexes: async () => assert.fail('development should not force production indexes')
  });

  assert.deepEqual(result, {
    schemaCapabilities: [],
    contractIndexes: null,
    wechatNotificationIndexes: null
  });
});
