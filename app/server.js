const path = require('path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

dotenv.config({ path: process.env.ENV_FILE || path.join(__dirname, '.env') });

const { loadEnvironment } = require('./config/environment');
const { createApp } = require('./app');
const { ensureContractIndexes } = require('./services/contractIndexService');
const { startEquipmentRoutineScheduler } = require('./services/equipmentRoutineWorkerService');
const { ensureWechatNotificationIndexes } = require('./services/wechatNotificationIndexService');
const { createWechatServiceNotificationService } = require('./services/wechatServiceNotificationService');
const {
  createWechatServiceNotificationWorker,
  startWechatServiceNotificationScheduler
} = require('./services/wechatServiceNotificationWorker');
const {
  EXPECTED_SCHEMA_LEDGER,
  SCHEMA_CAPABILITY,
  SCHEMA_LEDGER_COLLECTION,
  isExactSchemaLedger
} = require('./services/equipmentCategoryIndexMigrationService');

function listenForHttpRequests(app, config, logger = console) {
  return app.listen(config.port, config.apiBindHost, () => {
    logger.log(`API listening on http://${config.apiBindHost}:${config.port}`);
    logger.log(`Instance: ${config.instanceName} (${config.appEnv})`);
  });
}

function buildMongoConnectOptions(config) {
  return {
    autoIndex: config.appEnv !== 'production' && config.nodeEnv !== 'production'
  };
}

async function assertRequiredSchemaCapabilities(database, rawCapabilities = '') {
  const required = [...new Set(String(rawCapabilities || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean))];
  if (required.length === 0) return [];
  const unsupported = required.filter((capability) => capability !== SCHEMA_CAPABILITY);
  if (unsupported.length > 0) {
    const error = new Error(`Required database schema capability is unsupported: ${unsupported.join(', ')}`);
    error.code = 'DATABASE_SCHEMA_CAPABILITY_UNSUPPORTED';
    throw error;
  }
  const ledger = await database.collection(SCHEMA_LEDGER_COLLECTION).findOne({
    _id: EXPECTED_SCHEMA_LEDGER._id
  });
  if (!isExactSchemaLedger(ledger)) {
    const error = new Error(`Required database schema capability is missing or incompatible: ${SCHEMA_CAPABILITY}`);
    error.code = 'DATABASE_SCHEMA_CAPABILITY_MISSING';
    throw error;
  }
  return required;
}

async function connectDatabaseForServer(config, {
  mongooseClient = mongoose,
  requiredSchemaCapabilities = process.env.REQUIRED_SCHEMA_CAPABILITIES,
  ensureRuntimeIndexes = ensureContractIndexes,
  ensureWechatIndexes = ensureWechatNotificationIndexes
} = {}) {
  let connected = false;
  try {
    const connectOptions = buildMongoConnectOptions(config);
    await mongooseClient.connect(config.mongodbUri, connectOptions);
    connected = true;
    const schemaCapabilities = await assertRequiredSchemaCapabilities(
      mongooseClient.connection.db,
      requiredSchemaCapabilities
    );
    const contractIndexes = connectOptions.autoIndex === false
      ? await ensureRuntimeIndexes(mongooseClient.connection.db)
      : null;
    const wechatNotificationIndexes = connectOptions.autoIndex === false
      ? await ensureWechatIndexes(mongooseClient.connection.db)
      : null;
    return { schemaCapabilities, contractIndexes, wechatNotificationIndexes };
  } catch (error) {
    if (connected || mongooseClient.connection?.readyState !== 0) {
      try { await mongooseClient.disconnect(); }
      catch (disconnectError) { error.disconnectError = disconnectError; }
    }
    throw error;
  }
}

async function startServer() {
  const config = loadEnvironment();
  const databaseReadiness = await connectDatabaseForServer(config);
  if (databaseReadiness.contractIndexes) {
    console.log(`Contract indexes verified: ${databaseReadiness.contractIndexes.indexes.length}`);
  }
  if (databaseReadiness.wechatNotificationIndexes) {
    console.log(`WeChat notification indexes verified: ${databaseReadiness.wechatNotificationIndexes.indexes.length}`);
  }

  const wechatService = createWechatServiceNotificationService(config.wechatServiceNotification);
  const app = createApp(config, { wechatServiceNotificationService: wechatService });
  const routineScheduler = startEquipmentRoutineScheduler({
    enabled: config.equipmentRoutineWorkerEnabled,
    intervalMs: config.equipmentRoutineWorkerIntervalMs
  });
  const wechatWorker = config.wechatServiceNotification.enabled
    ? createWechatServiceNotificationWorker({
        service: wechatService,
        activatedAt: config.wechatServiceNotification.activatedAt
      })
    : null;
  const wechatScheduler = startWechatServiceNotificationScheduler({
    enabled: config.wechatServiceNotification.enabled,
    intervalMs: config.wechatServiceNotification.workerIntervalMs,
    worker: wechatWorker
  });
  const server = listenForHttpRequests(app, config);

  const shutdown = async (signal) => {
    console.log(`${signal} received, shutting down`);
    server.close(async () => {
      routineScheduler.stop();
      wechatScheduler.stop();
      await mongoose.disconnect();
      process.exit(0);
    });
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  return { app, config, server, routineScheduler, wechatScheduler };
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error('Failed to start API:', error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  assertRequiredSchemaCapabilities,
  buildMongoConnectOptions,
  connectDatabaseForServer,
  listenForHttpRequests,
  startServer
};
