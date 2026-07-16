const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const appRequire = require('../helpers/appRequire');
const request = appRequire('supertest');

const { createApp } = require('../../../app/app');

function testConfig(overrides = {}) {
  return {
    appEnv: 'test',
    nodeEnv: 'test',
    instanceName: 'task-distribution-v2-test',
    port: 18099,
    mongodbUri: 'mongodb://127.0.0.1:27017/task_distribution_v2_test',
    jwtSecret: '0123456789abcdef0123456789abcdef',
    jwtExpire: '8h',
    uploadPath: path.resolve(__dirname, '../../.test-data/uploads'),
    maxFileSize: 10 * 1024 * 1024,
    corsOrigins: ['http://localhost:3101'],
    enableLegacyPublicUploads: false,
    ...overrides
  };
}

test('health endpoint identifies the isolated instance', async () => {
  const response = await request(createApp(testConfig())).get('/health').expect(200);

  assert.deepEqual(response.body, {
    status: 'ok',
    instance: 'task-distribution-v2-test'
  });
});

test('legacy public upload paths stay disabled by default', async () => {
  await request(createApp(testConfig())).get('/uploads/unknown.txt').expect(404);
});

test('CORS accepts configured origins and rejects unrelated origins', async () => {
  await request(createApp(testConfig()))
    .get('/health')
    .set('Origin', 'http://localhost:3101')
    .expect('access-control-allow-origin', 'http://localhost:3101')
    .expect(200);

  await request(createApp(testConfig()))
    .get('/health')
    .set('Origin', 'https://www.horselink.cn')
    .expect(403);
});
