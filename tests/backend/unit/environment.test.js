const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  databaseNameFromUri,
  loadEnvironment
} = require('../../../app/config/environment');
const {
  startEquipmentRoutineScheduler
} = require('../../../app/services/equipmentRoutineWorkerService');

const SAFE_SECRET = '0123456789abcdef0123456789abcdef';

function validEnvironment(overrides = {}) {
  return {
    APP_ENV: 'test',
    NODE_ENV: 'test',
    APP_INSTANCE: 'task-distribution-v2-test',
    PORT: '18099',
    MONGODB_URI: 'mongodb://127.0.0.1:27017/task_distribution_v2_test',
    JWT_SECRET: SAFE_SECRET,
    UPLOAD_PATH: path.join(__dirname, '../../../.test-data/uploads'),
    ...overrides
  };
}

test('extracts a database name from standard and SRV MongoDB URIs', () => {
  assert.equal(
    databaseNameFromUri('mongodb://127.0.0.1:27017/task_distribution_v2_test'),
    'task_distribution_v2_test'
  );
  assert.equal(
    databaseNameFromUri('mongodb+srv://example.invalid/task_distribution_v2_staging'),
    'task_distribution_v2_staging'
  );
});

test('accepts an isolated non-production configuration', () => {
  const config = loadEnvironment(validEnvironment());

  assert.equal(config.appEnv, 'test');
  assert.equal(config.port, 18099);
  assert.equal(config.enableLegacyPublicUploads, false);
  assert.equal(config.temporaryFileUserMaxCount, 20);
  assert.equal(config.temporaryFileUserMaxBytes, 100 * 1024 * 1024);
  assert.equal(config.temporaryFileTeamMaxCount, 200);
  assert.equal(config.temporaryFileTeamMaxBytes, 1024 * 1024 * 1024);
  assert.equal(config.temporaryFileTtlHours, 24);
  assert.equal(config.equipmentRoutineWorkerEnabled, false);
  assert.equal(config.equipmentRoutineWorkerIntervalMs, 300000);
  assert.ok(Object.isFrozen(config));
});

test('routine worker defaults on in production and can be explicitly disabled', async () => {
  const production = loadEnvironment(validEnvironment({
    APP_ENV: 'production',
    NODE_ENV: 'production',
    MONGODB_URI: 'mongodb://127.0.0.1:27017/task_distribution_v2_production'
  }));
  const disabled = loadEnvironment(validEnvironment({
    APP_ENV: 'production',
    NODE_ENV: 'production',
    MONGODB_URI: 'mongodb://127.0.0.1:27017/task_distribution_v2_production',
    EQUIPMENT_ROUTINE_WORKER_ENABLED: 'false'
  }));
  assert.equal(production.equipmentRoutineWorkerEnabled, true);
  assert.equal(disabled.equipmentRoutineWorkerEnabled, false);

  let calls = 0;
  const scheduler = startEquipmentRoutineScheduler({
    enabled: false,
    worker: { runOnce: async () => { calls += 1; } }
  });
  assert.equal(scheduler.enabled, false);
  scheduler.stop();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 0);
});

test('rejects the existing production database name outside production', () => {
  assert.throws(
    () =>
      loadEnvironment(
        validEnvironment({
          MONGODB_URI: 'mongodb://127.0.0.1:27017/task_distribution'
        })
      ),
    /must end with/
  );
});

test('rejects the existing production service port outside production', () => {
  assert.throws(() => loadEnvironment(validEnvironment({ PORT: '8099' })), /reserved/);
});

test('rejects weak and placeholder JWT secrets', () => {
  assert.throws(
    () => loadEnvironment(validEnvironment({ JWT_SECRET: 'short' })),
    /at least 32/
  );
  assert.throws(
    () =>
      loadEnvironment(
        validEnvironment({ JWT_SECRET: 'replace-me-with-a-real-secret-value' })
      ),
    /placeholder/
  );
});

test('rejects a non-isolated upload directory outside production', () => {
  assert.throws(
    () => loadEnvironment(validEnvironment({ UPLOAD_PATH: 'C:\\shared\\uploads' })),
    /isolated V2 service root/
  );
});

test('validates temporary file quotas against file and team limits', () => {
  assert.throws(
    () => loadEnvironment(validEnvironment({
      TEMPORARY_FILE_USER_MAX_BYTES: '1048575'
    })),
    /must be at least MAX_FILE_SIZE/
  );
  assert.throws(
    () => loadEnvironment(validEnvironment({
      TEMPORARY_FILE_USER_MAX_COUNT: '21',
      TEMPORARY_FILE_TEAM_MAX_COUNT: '20'
    })),
    /TEAM_MAX_COUNT must be at least/
  );
  assert.throws(
    () => loadEnvironment(validEnvironment({
      TEMPORARY_FILE_USER_MAX_BYTES: '20971520',
      TEMPORARY_FILE_TEAM_MAX_BYTES: '10485760'
    })),
    /TEAM_MAX_BYTES must be at least/
  );
});
