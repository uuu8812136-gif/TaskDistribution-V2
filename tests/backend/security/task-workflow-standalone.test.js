'use strict';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const appRequire = require('../helpers/appRequire');

const mongoose = appRequire('mongoose');
const { MongoMemoryServer } = appRequire('mongodb-memory-server');
const extensionController = require('../../../app/controllers/extensionController');
const taskFlowController = require('../../../app/controllers/taskFlowController');
const AuditLog = require('../../../app/models/AuditLog');
const ExtensionRequest = require('../../../app/models/ExtensionRequest');
const Task = require('../../../app/models/Task');
const TaskReview = require('../../../app/models/TaskReview');
const {
  DATA_SCOPES,
  MEMBERSHIP_ROLES,
  MEMBERSHIP_STATUSES,
  SESSION_MODES
} = require('../../../app/config/permissions');
const { supportsTransactions } = require('../../../app/services/transactionService');

const TEST_DATABASE_NAME = 'task_workflow_standalone_v2_test';
let mongoServer;

function objectId() {
  return new mongoose.Types.ObjectId().toString();
}

function authContext() {
  const userId = objectId();
  const teamId = objectId();
  const orgUnitId = objectId();
  return {
    authenticated: true,
    mode: SESSION_MODES.TEAM,
    activeTeamId: teamId,
    userId,
    isSuperAdmin: false,
    membership: {
      _id: objectId(),
      teamId,
      userId,
      orgUnitId,
      role: MEMBERSHIP_ROLES.PROJECT_ADMIN,
      status: MEMBERSHIP_STATUSES.ACTIVE
    },
    permissionKeys: ['task.view', 'task.review'],
    moduleDataScopes: { task: DATA_SCOPES.TEAM },
    readOnly: false,
    canAccessBusiness: true
  };
}

function request(body = {}) {
  return {
    method: 'POST',
    authContext: authContext(),
    params: { id: objectId() },
    query: {},
    body,
    headers: {},
    path: '/test',
    baseUrl: '/api',
    get() { return undefined; }
  };
}

function response() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

before(async () => {
  assert.match(TEST_DATABASE_NAME, /_v2_test$/);
  mongoServer = await MongoMemoryServer.create({ instance: { dbName: TEST_DATABASE_NAME } });
  await mongoose.connect(mongoServer.getUri(TEST_DATABASE_NAME), { dbName: TEST_DATABASE_NAME });
  assert.equal(supportsTransactions(mongoose.connection), false);
});

after(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});

test('standalone MongoDB rejects task and extension workflow writes before persistence', async () => {
  const cases = [
    [taskFlowController.completeTask, request({ completionNote: 'not persisted' }), 'TASK_FLOW_TRANSACTIONS_REQUIRED'],
    [taskFlowController.updateCompletion, request({ completionNote: 'not persisted' }), 'TASK_FLOW_TRANSACTIONS_REQUIRED'],
    [taskFlowController.reviewTask, request({ content: 'not persisted', result: 'approved' }), 'TASK_FLOW_TRANSACTIONS_REQUIRED'],
    [taskFlowController.confirmTask, request(), 'TASK_FLOW_TRANSACTIONS_REQUIRED'],
    [extensionController.applyExtension, request({ reason: 'not persisted', requestedDays: 1 }), 'EXTENSION_TRANSACTIONS_REQUIRED'],
    [extensionController.approveExtension, request({ status: 'approved', approvedDays: 1 }), 'EXTENSION_TRANSACTIONS_REQUIRED']
  ];

  for (const [handler, req, code] of cases) {
    const res = response();
    await handler(req, res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.code, code);
  }

  assert.equal(await Task.countDocuments({}), 0);
  assert.equal(await ExtensionRequest.countDocuments({}), 0);
  assert.equal(await TaskReview.countDocuments({}), 0);
  assert.equal(await AuditLog.countDocuments({}), 0);
});
