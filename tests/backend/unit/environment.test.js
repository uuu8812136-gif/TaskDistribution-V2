const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  databaseNameFromUri,
  loadEnvironment
} = require('../../../app/config/environment');

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
  assert.ok(Object.isFrozen(config));
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
