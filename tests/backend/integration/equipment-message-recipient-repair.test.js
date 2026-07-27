'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { after, before, beforeEach, test } = require('node:test');
const appRequire = require('../helpers/appRequire');

const mongoose = appRequire('mongoose');
const { MongoMemoryReplSet } = appRequire('mongodb-memory-server');

const AuditLog = require('../../../app/models/AuditLog');
const EquipmentRepairOrder = require('../../../app/models/EquipmentRepairOrder');
const EquipmentRoutinePlan = require('../../../app/models/EquipmentRoutinePlan');
const Message = require('../../../app/models/Message');
const OrgUnit = require('../../../app/models/OrgUnit');
const ProjectTeam = require('../../../app/models/ProjectTeam');
const TeamMembership = require('../../../app/models/TeamMembership');
const User = require('../../../app/models/User');
const permissions = require('../../../app/config/permissions');
const {
  createEquipmentMessageRepairService
} = require('../../../app/services/equipmentMessageRepairService');
const {
  parseArgs,
  usage
} = require('../../../app/script/repairEquipmentMessages');

const DATABASE_NAME = `equipment_msg_${randomUUID().replaceAll('-', '').slice(0, 20)}_v2_test`;
const MODELS = [
  AuditLog,
  EquipmentRepairOrder,
  EquipmentRoutinePlan,
  Message,
  OrgUnit,
  ProjectTeam,
  TeamMembership,
  User
];

let replicaSet;

function objectId() {
  return new mongoose.Types.ObjectId();
}

async function insertUser(_id, username, name) {
  await User.collection.insertOne({
    _id,
    username,
    usernameNormalized: username,
    password: 'unused-hash',
    name,
    roles: [],
    isSuperAdmin: false,
    isSystemAccount: false,
    tokenVersion: 0,
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date()
  });
}

async function insertMembership({ teamId, userId, orgUnitId, positionKey }) {
  const positionLevel = permissions.POSITION_LEVEL_BY_KEY[positionKey];
  return TeamMembership.create({
    teamId,
    userId,
    orgUnitId,
    role: permissions.MEMBERSHIP_ROLES.MEMBER,
    positionLevel,
    positionKey,
    functionalRoleKeys: [],
    permissionKeys: ['equipment.view'],
    moduleDataScopes: permissions.deriveModuleDataScopes({ positionLevel }),
    status: permissions.MEMBERSHIP_STATUSES.ACTIVE
  });
}

async function seed() {
  const adminId = objectId();
  const managerId = objectId();
  const employeeId = objectId();
  await Promise.all([
    insertUser(adminId, 'message-admin', '系统管理员'),
    insertUser(managerId, 'message-manager', '分部经理'),
    insertUser(employeeId, 'message-employee', '普通员工')
  ]);
  const team = await ProjectTeam.create({
    code: 'MESSAGE_REPAIR',
    name: '消息修复测试团队',
    createdBy: adminId
  });
  const orgUnit = await OrgUnit.create({
    teamId: team._id,
    code: 'BRANCH_A',
    name: '仓配一分部',
    type: permissions.ORG_UNIT_TYPES.SUB_DEPARTMENT,
    level: 2,
    path: '/'
  });
  await Promise.all([
    insertMembership({
      teamId: team._id,
      userId: managerId,
      orgUnitId: orgUnit._id,
      positionKey: permissions.POSITION_KEYS.SUB_DEPARTMENT_MANAGER
    }),
    insertMembership({
      teamId: team._id,
      userId: employeeId,
      orgUnitId: orgUnit._id,
      positionKey: permissions.POSITION_KEYS.EMPLOYEE
    })
  ]);

  const equipmentId = objectId();
  const categoryId = objectId();
  const plan = await EquipmentRoutinePlan.create({
    teamId: team._id,
    orgUnitId: orgUnit._id,
    equipmentId,
    categoryId,
    ruleId: objectId(),
    ruleVersion: 1,
    ruleSnapshot: {},
    routineType: 'INSPECTION',
    cycleKey: 'calendar:2030-01-01T00:00:00.000Z',
    windowKey: 'DAY_SHIFT',
    windowName: '白班',
    scheduledFor: new Date('2030-01-01T00:00:00.000Z'),
    dueAt: new Date('2030-01-01T01:00:00.000Z'),
    status: 'OVERDUE'
  });
  const routineMessages = await Message.create([
    {
      teamId: team._id,
      type: 'system',
      title: '设备点检逾期提醒',
      content: '保留给分部经理',
      recipient: managerId,
      deduplicationKey: `routine-plan:${plan._id}:level:INITIAL`,
      extraData: {
        resourceType: 'EQUIPMENT_ROUTINE_PLAN',
        planId: String(plan._id),
        level: 'INITIAL'
      }
    },
    {
      teamId: team._id,
      type: 'system',
      title: '设备点检逾期提醒',
      content: '错误发送给普通员工',
      recipient: employeeId,
      deduplicationKey: `routine-plan:${plan._id}:level:ESCALATED`,
      extraData: {
        resourceType: 'EQUIPMENT_ROUTINE_PLAN',
        planId: String(plan._id),
        level: 'ESCALATED'
      }
    }
  ]);

  const order = await EquipmentRepairOrder.create({
    teamId: team._id,
    orgUnitId: orgUnit._id,
    equipmentId,
    categoryId,
    type: 'NO_PARTS_REPAIR',
    status: 'DEPUTY_APPROVAL_PENDING',
    equipmentSnapshot: {
      assetCode: 'TEST-EQ-001',
      name: '测试叉车',
      orgUnitName: '仓配一分部'
    },
    createdBy: employeeId,
    repairDate: new Date('2026-07-27T00:00:00.000Z'),
    repairerName: '维修人员',
    lastActionBy: employeeId,
    revision: 2
  });
  const repairMessage = await Message.create({
    teamId: team._id,
    type: 'system',
    title: '设备维修待办',
    content: '测试叉车（TEST-EQ-001）维修单状态：DEPUTY_APPROVAL_PENDING',
    recipient: managerId,
    deduplicationKey: `repair:${order._id}:revision:2`,
    extraData: {
      resourceType: 'REPAIR_ORDER',
      repairId: String(order._id),
      status: 'DEPUTY_APPROVAL_PENDING'
    }
  });
  return {
    team,
    planId: plan._id,
    managerId,
    employeeId,
    retainedRoutineMessageId: routineMessages[0]._id,
    deletedRoutineMessageId: routineMessages[1]._id,
    repairMessageId: repairMessage._id
  };
}

before(async () => {
  assert.match(DATABASE_NAME, /_v2_test$/);
  replicaSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    instanceOpts: [{ dbName: DATABASE_NAME }]
  });
  await mongoose.connect(replicaSet.getUri(DATABASE_NAME), { dbName: DATABASE_NAME });
  for (const model of MODELS) await model.syncIndexes();
});

beforeEach(async () => {
  await Promise.all(MODELS.map((model) => model.collection.deleteMany({})));
});

after(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replicaSet) await replicaSet.stop();
});

test('CLI stays dry-run by default and requires explicit execution values', () => {
  assert.deepEqual(parseArgs([]), { execute: false });
  assert.deepEqual(parseArgs([
    '--execute',
    `--confirm-database=${DATABASE_NAME}`,
    '--backup-directory',
    'E:\\backup',
    '--report',
    'E:\\report.json'
  ]), {
    execute: true,
    confirmDatabase: DATABASE_NAME,
    backupDirectory: 'E:\\backup',
    report: 'E:\\report.json'
  });
  assert.throws(() => parseArgs(['--unknown']), /Unknown option/);
  assert.match(usage(), /strict dry-run by default/i);
});

test('execution deletes only invalid routine recipients and localizes repair messages idempotently', async () => {
  const fixture = await seed();
  let backupGuardCalls = 0;
  const service = createEquipmentMessageRepairService({
    connection: mongoose.connection,
    allowedExecutionDatabaseNames: [DATABASE_NAME],
    backupVerifier: async () => ({}),
    collectionInventory: async () => [],
    backupGuard: async ({ databaseName, minimumCompletedAt }) => {
      backupGuardCalls += 1;
      assert.equal(databaseName, DATABASE_NAME);
      assert.ok(minimumCompletedAt instanceof Date);
      return {
        backupDirectory: 'E:\\verified-backup',
        backupId: 'backup-test',
        databaseName,
        collectionCountsVerified: true,
        completeRestoreSetVerified: true
      };
    }
  });

  const dryRun = await service.run();
  assert.equal(dryRun.status, 'DRY_RUN_READY');
  assert.equal(dryRun.before.plannedWriteCount, 2);
  assert.equal(await Message.countDocuments({}), 3);

  const executed = await service.run({
    execute: true,
    confirmDatabase: DATABASE_NAME,
    backupDirectory: 'E:\\verified-backup'
  });
  assert.equal(executed.status, 'EXECUTED');
  assert.equal(executed.dataWrites, 2);
  assert.equal(executed.auditLogsCreated, 2);
  assert.equal(backupGuardCalls, 1);
  assert.ok(await Message.exists({ _id: fixture.retainedRoutineMessageId }));
  assert.equal(await Message.exists({ _id: fixture.deletedRoutineMessageId }), null);
  assert.match(
    (await Message.findById(fixture.repairMessageId).lean()).content,
    /待副经理\/经理助理审批$/
  );
  assert.equal(await AuditLog.countDocuments({ resourceType: 'MESSAGE' }), 2);

  const replay = await service.run({
    execute: true,
    confirmDatabase: DATABASE_NAME,
    backupDirectory: 'E:\\verified-backup'
  });
  assert.equal(replay.status, 'NO_CHANGES');
  assert.equal(replay.writePerformed, false);
  assert.equal(backupGuardCalls, 1);
});

test('bulk execution handles the observed 4291-message cleanup volume atomically', async () => {
  const fixture = await seed();
  const createdAt = new Date('2026-07-27T12:00:00.000Z');
  await Message.collection.insertMany(Array.from({ length: 4289 }, (_, index) => ({
    teamId: fixture.team._id,
    type: 'system',
    title: '设备点检逾期提醒',
    content: `错误批量提醒 ${index}`,
    recipient: fixture.employeeId,
    isRead: false,
    deduplicationKey: `routine-plan:${fixture.planId}:bulk:${index}`,
    extraData: {
      resourceType: 'EQUIPMENT_ROUTINE_PLAN',
      planId: String(fixture.planId),
      level: 'ESCALATED'
    },
    createdAt,
    updatedAt: createdAt,
    __v: 0
  })));

  const service = createEquipmentMessageRepairService({
    connection: mongoose.connection,
    allowedExecutionDatabaseNames: [DATABASE_NAME],
    backupVerifier: async () => ({}),
    collectionInventory: async () => [],
    backupGuard: async ({ databaseName }) => ({
      backupDirectory: 'E:\\verified-backup',
      backupId: 'backup-bulk-test',
      databaseName,
      collectionCountsVerified: true,
      completeRestoreSetVerified: true
    })
  });

  const dryRun = await service.run();
  assert.equal(dryRun.before.plannedWriteCount, 4291);

  const executed = await service.run({
    execute: true,
    confirmDatabase: DATABASE_NAME,
    backupDirectory: 'E:\\verified-backup'
  });
  assert.equal(executed.status, 'EXECUTED');
  assert.equal(executed.dataWrites, 4291);
  assert.equal(executed.auditLogsCreated, 4291);
  assert.equal(await Message.countDocuments({}), 2);
  assert.equal(await AuditLog.countDocuments({ resourceType: 'MESSAGE' }), 4291);
});
