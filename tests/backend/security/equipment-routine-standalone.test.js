'use strict';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const path = require('node:path');

const APP_ROOT = path.resolve(__dirname, '../../../app');
const appRequire = (name) => require(require.resolve(name, { paths: [APP_ROOT] }));
const mongoose = appRequire('mongoose');
const { MongoMemoryServer } = appRequire('mongodb-memory-server');

const AuditLog = require('../../../app/models/AuditLog');
const EquipmentRoutineRecord = require('../../../app/models/EquipmentRoutineRecord');
const EquipmentRoutineRule = require('../../../app/models/EquipmentRoutineRule');
const EquipmentRuntimeReading = require('../../../app/models/EquipmentRuntimeReading');
const permissions = require('../../../app/config/permissions');
const {
  createEquipmentRoutineService
} = require('../../../app/services/equipmentRoutineService');
const { supportsTransactions } = require('../../../app/services/transactionService');

const TEST_DATABASE_NAME = 'equipment_routine_standalone_v2_test';
let mongoServer;

function objectId() {
  return new mongoose.Types.ObjectId();
}

function context() {
  const teamId = objectId();
  const orgUnitId = objectId();
  const userId = objectId();
  return Object.freeze({
    authenticated: true,
    sessionId: String(objectId()),
    mode: permissions.SESSION_MODES.TEAM,
    tokenVersion: 0,
    userId: String(userId),
    user: Object.freeze({ _id: String(userId), username: 'standalone-user' }),
    isSuperAdmin: false,
    activeTeamId: String(teamId),
    team: Object.freeze({ _id: String(teamId), status: permissions.TEAM_STATUSES.ACTIVE }),
    membership: Object.freeze({
      _id: String(objectId()),
      teamId: String(teamId),
      userId: String(userId),
      orgUnitId: String(orgUnitId),
      role: permissions.MEMBERSHIP_ROLES.PROJECT_ADMIN,
      status: permissions.MEMBERSHIP_STATUSES.ACTIVE
    }),
    orgUnit: Object.freeze({ _id: String(orgUnitId), teamId: String(teamId) }),
    actorRole: permissions.AUDIT_ACTOR_ROLES.PROJECT_ADMIN,
    permissionKeys: Object.freeze([
      'equipment.view',
      'equipment.edit',
      'equipment.inspect',
      'equipment.maintain'
    ]),
    moduleDataScopes: Object.freeze({ equipment: permissions.DATA_SCOPES.TEAM }),
    readOnly: false,
    canAccessBusiness: true
  });
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

test('standalone MongoDB rejects every routine write before persisting partial state', async () => {
  const authContext = context();
  const routineService = createEquipmentRoutineService();
  const categoryId = objectId();
  const ruleId = objectId();
  const equipmentId = objectId();
  const expected = (error) => (
    error.status === 503 && error.code === 'EQUIPMENT_ROUTINE_TRANSACTIONS_REQUIRED'
  );

  await assert.rejects(routineService.createRule({
    authContext,
    input: {
      routineType: 'INSPECTION',
      categoryId: String(categoryId),
      name: 'Must not persist',
      checklistItems: [{ name: 'Check' }],
      schedule: { mode: 'MANUAL' }
    }
  }), expected);
  await assert.rejects(routineService.createRuntimeReading({
    authContext,
    equipmentId: String(equipmentId),
    input: { hours: 10 }
  }), expected);
  await assert.rejects(routineService.createRecord({
    authContext,
    equipmentId: String(equipmentId),
    input: {
      ruleId: String(ruleId),
      itemResults: [{ itemKey: 'check', result: 'NORMAL' }]
    }
  }), expected);

  assert.equal(await EquipmentRoutineRule.countDocuments({}), 0);
  assert.equal(await EquipmentRoutineRecord.countDocuments({}), 0);
  assert.equal(await EquipmentRuntimeReading.countDocuments({}), 0);
  assert.equal(await AuditLog.countDocuments({}), 0);
});
