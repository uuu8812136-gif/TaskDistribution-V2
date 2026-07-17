const path = require('path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

dotenv.config({ path: process.env.ENV_FILE || path.join(__dirname, '.env') });

const { loadEnvironment } = require('./config/environment');
const { createApp } = require('./app');
const { startEquipmentRoutineScheduler } = require('./services/equipmentRoutineWorkerService');

async function startServer() {
  const config = loadEnvironment();
  await mongoose.connect(config.mongodbUri);

  const app = createApp(config);
  const routineScheduler = startEquipmentRoutineScheduler({
    enabled: config.equipmentRoutineWorkerEnabled,
    intervalMs: config.equipmentRoutineWorkerIntervalMs
  });
  const server = app.listen(config.port, () => {
    console.log(`API listening on port ${config.port}`);
    console.log(`Instance: ${config.instanceName} (${config.appEnv})`);
  });

  const shutdown = async (signal) => {
    console.log(`${signal} received, shutting down`);
    server.close(async () => {
      routineScheduler.stop();
      await mongoose.disconnect();
      process.exit(0);
    });
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  return { app, config, server, routineScheduler };
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error('Failed to start API:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { startServer };
