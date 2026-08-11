'use strict'

const path = require('node:path')

const repoRoot = path.resolve(__dirname, '../..')
const dotenv = require(path.join(repoRoot, 'app/node_modules/dotenv'))
const mongoose = require(path.join(repoRoot, 'app/node_modules/mongoose'))

dotenv.config({ path: process.env.ENV_FILE })

const { loadEnvironment } = require(path.join(repoRoot, 'app/config/environment'))
const { createApp } = require(path.join(repoRoot, 'app/app'))
const { connectDatabaseForServer } = require(path.join(repoRoot, 'app/server'))
const { SCHEMA_CAPABILITY } = require(
  path.join(repoRoot, 'app/services/equipmentCategoryIndexMigrationService')
)
const { startEquipmentRoutineScheduler } = require(
  path.join(repoRoot, 'app/services/equipmentRoutineWorkerService')
)

async function main() {
  const config = loadEnvironment()
  await connectDatabaseForServer(config, {
    requiredSchemaCapabilities: SCHEMA_CAPABILITY
  })
  const scheduler = startEquipmentRoutineScheduler({
    enabled: config.equipmentRoutineWorkerEnabled,
    intervalMs: config.equipmentRoutineWorkerIntervalMs
  })
  const app = createApp(config)
  const server = app.listen(config.port, '127.0.0.1', () => {
    process.stdout.write(`API listening on 127.0.0.1:${config.port}\n`)
    process.stdout.write(`Instance: ${config.instanceName} (${config.appEnv})\n`)
  })

  let closing = false
  async function shutdown(signal) {
    if (closing) return
    closing = true
    process.stdout.write(`${signal} received, shutting down\n`)
    server.close(async () => {
      scheduler.stop()
      await mongoose.disconnect()
      process.exit(0)
    })
  }
  process.once('SIGINT', () => shutdown('SIGINT'))
  process.once('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((error) => {
  process.stderr.write(`Failed to start staging API: ${error.stack || error.message}\n`)
  process.exitCode = 1
})
