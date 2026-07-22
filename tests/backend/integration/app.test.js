const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const appRequire = require('../helpers/appRequire');
const request = appRequire('supertest');

const { createApp } = require('../../../app/app');
const CONNECTED_DATABASE = Object.freeze({ readyState: 1 });

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

function createTestApp(overrides = {}, databaseConnection = CONNECTED_DATABASE) {
  return createApp(testConfig(overrides), { databaseConnection });
}

test('health endpoint identifies the isolated instance', async () => {
  const response = await request(createTestApp()).get('/health').expect(200);

  assert.deepEqual(response.body, {
    status: 'ok',
    instance: 'task-distribution-v2-test'
  });
});

test('health endpoint degrades while Mongoose is not connected', async () => {
  const databaseConnection = { readyState: 1 };
  const app = createTestApp({}, databaseConnection);
  await request(app).get('/health').expect(200);

  for (const readyState of [0, 2, 3]) {
    databaseConnection.readyState = readyState;
    const response = await request(app)
      .get('/health')
      .expect(503);

    assert.deepEqual(response.body, {
      status: 'degraded',
      instance: 'task-distribution-v2-test',
      database: 'unavailable'
    });
  }
});

test('request ids are stable, bounded, and returned to callers', async () => {
  const app = createTestApp();
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
  await request(createTestApp()).get('/uploads/unknown.txt').expect(404);
});

test('CORS accepts configured origins and rejects unrelated origins', async () => {
  await request(createTestApp())
    .get('/health')
    .set('Origin', 'http://localhost:3101')
    .expect('access-control-allow-origin', 'http://localhost:3101')
    .expect(200);

  await request(createTestApp())
    .get('/health')
    .set('Origin', 'https://www.horselink.cn')
    .expect(403);
});

test('transport, attendance, and production APIs are mounted behind authentication', async () => {
  const app = createTestApp();
  for (const path of [
    '/api/transport-records',
    '/api/attendance-submissions',
    '/api/attendance-submissions/summary/monthly/export?month=2026-07',
    '/api/production-schedules/monthly',
    '/api/generated-daily-reports'
  ]) {
    const response = await request(app).get(path).expect(401);
    assert.notEqual(response.body.message, '接口不存在');
  }
});

test('equipment routine APIs are mounted behind authentication', async () => {
  const app = createTestApp();
  const equipmentId = '507f1f77bcf86cd799439011';
  const planId = '507f1f77bcf86cd799439012';
  for (const route of [
    '/api/equipment/routine-rules',
    '/api/equipment/routine-records',
    '/api/equipment/routine-records/export',
    '/api/equipment/routine-plans',
    `/api/equipment/routine-plans/${planId}`,
    '/api/equipment/routine-exceptions',
    `/api/equipment/${equipmentId}/routine-schedule`,
    `/api/equipment/${equipmentId}/runtime-readings`
  ]) {
    const response = await request(app).get(route).expect(401);
    assert.ok(response.body.code || response.body.message);
  }
});

test('equipment inventory APIs are mounted behind authentication', async () => {
  const app = createTestApp();
  const inventorySessionId = '507f1f77bcf86cd799439012';
  for (const route of [
    '/api/equipment/inventories/options',
    '/api/equipment/inventories',
    `/api/equipment/inventories/${inventorySessionId}`,
    `/api/equipment/inventories/${inventorySessionId}/export`
  ]) {
    const response = await request(app).get(route).expect(401);
    assert.ok(response.body.code || response.body.message);
  }
});

test('equipment status application APIs are mounted behind authentication', async () => {
  const app = createTestApp();
  const applicationId = '507f1f77bcf86cd799439013';
  for (const route of [
    '/api/equipment/status-applications',
    `/api/equipment/status-applications/${applicationId}`
  ]) {
    const response = await request(app).get(route).expect(401);
    assert.ok(response.body.code || response.body.message);
  }
  const response = await request(app)
    .post(`/api/equipment/status-applications/${applicationId}/actions`)
    .send({ action: 'MANAGER_APPROVE', revision: 0, opinion: 'test' })
    .expect(401);
  assert.ok(response.body.code || response.body.message);
});

test('audit query APIs are mounted read-only behind authentication', async () => {
  const app = createTestApp();
  const auditLogId = '507f1f77bcf86cd799439014';
  for (const route of ['/api/audit-logs', `/api/audit-logs/${auditLogId}`]) {
    const response = await request(app).get(route).expect(401);
    assert.ok(response.body.code || response.body.message);
  }
});
