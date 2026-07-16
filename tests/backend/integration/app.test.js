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

test('request ids are stable, bounded, and returned to callers', async () => {
  const app = createApp(testConfig());
  const supplied = 'client-request.20260716:001';
  await request(app)
    .get('/health')
    .set('X-Request-Id', supplied)
    .expect('X-Request-Id', supplied)
    .expect(200);

  const generated = await request(app)
    .get('/health')
    .set('X-Request-Id', 'not a valid request id')
    .expect(200);
  assert.match(
    generated.headers['x-request-id'],
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  );
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

test('transport and production schedule APIs are mounted behind authentication', async () => {
  const app = createApp(testConfig());
  for (const path of [
    '/api/transport-records',
    '/api/production-schedules/monthly'
  ]) {
    const response = await request(app).get(path).expect(401);
    assert.notEqual(response.body.message, '接口不存在');
  }
});
