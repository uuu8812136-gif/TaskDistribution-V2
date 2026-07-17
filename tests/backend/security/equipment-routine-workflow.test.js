'use strict';

const assert = require('node:assert/strict');
const { after, before, beforeEach, test } = require('node:test');
const path = require('node:path');

const APP_ROOT = path.resolve(__dirname, '../../../app');
const appRequire = (name) => require(require.resolve(name, { paths: [APP_ROOT] }));
const mongoose = appRequire('mongoose');
const XLSX = appRequire('xlsx');
const { MongoMemoryReplSet } = appRequire('mongodb-memory-server');

const AuditLog = require('../../../app/models/AuditLog');
const EquipmentAsset = require('../../../app/models/EquipmentAsset');
const EquipmentCategory = require('../../../app/models/EquipmentCategory');
const EquipmentRoutineException = require('../../../app/models/EquipmentRoutineException');
const EquipmentRoutinePlan = require('../../../app/models/EquipmentRoutinePlan');
const EquipmentRoutineRecord = require('../../../app/models/EquipmentRoutineRecord');
const EquipmentRoutineRule = require('../../../app/models/EquipmentRoutineRule');
const FileAsset = require('../../../app/models/FileAsset');
const Message = require('../../../app/models/Message');
const OrgUnit = require('../../../app/models/OrgUnit');
const ProjectTeam = require('../../../app/models/ProjectTeam');
const TeamMembership = require('../../../app/models/TeamMembership');
const User = require('../../../app/models/User');
const permissions = require('../../../app/config/permissions');
const { createEquipmentRoutineService } = require('../../../app/services/equipmentRoutineService');
const {
  createEquipmentRoutineWorkflowService
} = require('../../../app/services/equipmentRoutineWorkflowService');
const {
  createEquipmentRoutineWorkerService,
  windowBounds
} = require('../../../app/services/equipmentRoutineWorkerService');

const DATABASE_NAME = 'equipment_routine_workflow_v2_test';
const MODELS = [
  AuditLog,
  EquipmentAsset,
  EquipmentCategory,
  EquipmentRoutineException,
  EquipmentRoutinePlan,
  EquipmentRoutineRecord,
  EquipmentRoutineRule,
  FileAsset,
  Message,
  OrgUnit,
  ProjectTeam,
  TeamMembership,
  User
];

let replicaSet;
let fixture;

function objectId() {
  return new mongoose.Types.ObjectId();
}

function authContext({ ids, userId, orgUnitId, positionKey, functionalRoleKeys = [], scope = 'TEAM' }) {
  return Object.freeze({
    authenticated: true,
    sessionId: String(objectId()),
    mode: permissions.SESSION_MODES.TEAM,
    tokenVersion: 0,
    userId: String(userId),
    user: Object.freeze({ _id: String(userId), username: `routine-${userId}` }),
    isSuperAdmin: false,
    activeTeamId: String(ids.team),
    team: Object.freeze({ _id: String(ids.team), status: permissions.TEAM_STATUSES.ACTIVE }),
    membership: Object.freeze({
      _id: String(objectId()),
      teamId: String(ids.team),
      userId: String(userId),
      orgUnitId: String(orgUnitId),
      role: permissions.MEMBERSHIP_ROLES.PROJECT_ADMIN,
      positionKey,
      functionalRoleKeys,
      status: permissions.MEMBERSHIP_STATUSES.ACTIVE
    }),
    orgUnit: Object.freeze({ _id: String(orgUnitId), teamId: String(ids.team) }),
    actorRole: permissions.AUDIT_ACTOR_ROLES.PROJECT_ADMIN,
    permissionKeys: Object.freeze([
      'equipment.view',
      'equipment.edit',
      'equipment.export',
      'equipment.inspect',
      'equipment.maintain'
    ]),
    moduleDataScopes: Object.freeze({ equipment: scope }),
    readOnly: false,
    canAccessBusiness: true
  });
}

async function seed() {
  const ids = {
    team: objectId(),
    otherTeam: objectId(),
    department: objectId(),
    subDepartment: objectId(),
    group: objectId(),
    employee: objectId(),
    teamLeader: objectId(),
    subManager: objectId(),
    assetAdmin: objectId(),
    departmentManager: objectId(),
    deputy: objectId(),
    otherUser: objectId()
  };
  const users = [
    ['employee', ids.employee],
    ['team-leader', ids.teamLeader],
    ['sub-manager', ids.subManager],
    ['asset-admin', ids.assetAdmin],
    ['department-manager', ids.departmentManager],
    ['deputy', ids.deputy],
    ['other-user', ids.otherUser]
  ].map(([username, _id]) => ({
    _id,
    username,
    usernameNormalized: username,
    password: 'unused',
    name: username,
    roles: [],
    isSuperAdmin: false,
    tokenVersion: 0,
    status: 'active'
  }));
  await User.collection.insertMany(users);
  await ProjectTeam.collection.insertMany([
    {
      _id: ids.team,
      code: 'ROUTINE_WORKFLOW',
      name: 'Routine Workflow',
      status: permissions.TEAM_STATUSES.ACTIVE,
      settings: { timeZone: 'Asia/Shanghai' },
      createdBy: ids.departmentManager
    },
    {
      _id: ids.otherTeam,
      code: 'ROUTINE_OTHER',
      name: 'Other Team',
      status: permissions.TEAM_STATUSES.ACTIVE,
      settings: { timeZone: 'Asia/Shanghai' },
      createdBy: ids.otherUser
    }
  ]);
  await OrgUnit.collection.insertMany([
    {
      _id: ids.department,
      teamId: ids.team,
      parentId: null,
      type: permissions.ORG_UNIT_TYPES.DEPARTMENT,
      code: 'DEPT',
      name: '物流部',
      status: permissions.ORG_UNIT_STATUSES.ACTIVE,
      sortOrder: 0,
      level: 1,
      path: '/'
    },
    {
      _id: ids.subDepartment,
      teamId: ids.team,
      parentId: ids.department,
      type: permissions.ORG_UNIT_TYPES.SUB_DEPARTMENT,
      code: 'SUB',
      name: '一分部',
      status: permissions.ORG_UNIT_STATUSES.ACTIVE,
      sortOrder: 0,
      level: 2,
      path: `/${ids.department}/`
    },
    {
      _id: ids.group,
      teamId: ids.team,
      parentId: ids.subDepartment,
      type: permissions.ORG_UNIT_TYPES.TEAM_GROUP,
      code: 'GROUP',
      name: '一班组',
      status: permissions.ORG_UNIT_STATUSES.ACTIVE,
      sortOrder: 0,
      level: 3,
      path: `/${ids.department}/${ids.subDepartment}/`
    }
  ]);
  await TeamMembership.collection.insertMany([
    membership(ids, ids.employee, ids.group, permissions.POSITION_KEYS.EMPLOYEE),
    membership(ids, ids.teamLeader, ids.group, permissions.POSITION_KEYS.TEAM_LEADER),
    membership(ids, ids.subManager, ids.subDepartment, permissions.POSITION_KEYS.SUB_DEPARTMENT_MANAGER),
    membership(ids, ids.assetAdmin, ids.department, permissions.POSITION_KEYS.EMPLOYEE, [permissions.FUNCTIONAL_ROLE_KEYS.ASSET_ADMIN]),
    membership(ids, ids.departmentManager, ids.department, permissions.POSITION_KEYS.DEPARTMENT_MANAGER),
    membership(ids, ids.deputy, ids.department, permissions.POSITION_KEYS.DEPARTMENT_DEPUTY_MANAGER)
  ]);
  const category = await EquipmentCategory.create({
    teamId: ids.team,
    name: '测试设备',
    createdBy: ids.departmentManager,
    updatedBy: ids.departmentManager
  });
  const asset = await EquipmentAsset.create({
    teamId: ids.team,
    orgUnitId: ids.group,
    categoryId: category._id,
    assetCode: 'EQ-001',
    name: '=现场设备',
    status: EquipmentAsset.EQUIPMENT_STATUSES.IN_USE,
    createdBy: ids.departmentManager,
    updatedBy: ids.departmentManager
  });
  const contexts = {
    manager: authContext({
      ids,
      userId: ids.departmentManager,
      orgUnitId: ids.department,
      positionKey: permissions.POSITION_KEYS.DEPARTMENT_MANAGER
    }),
    employee: authContext({
      ids,
      userId: ids.employee,
      orgUnitId: ids.group,
      positionKey: permissions.POSITION_KEYS.EMPLOYEE,
      scope: 'ORG_UNIT'
    }),
    teamLeader: authContext({
      ids,
      userId: ids.teamLeader,
      orgUnitId: ids.group,
      positionKey: permissions.POSITION_KEYS.TEAM_LEADER,
      scope: 'ORG_UNIT'
    }),
    subManager: authContext({
      ids,
      userId: ids.subManager,
      orgUnitId: ids.subDepartment,
      positionKey: permissions.POSITION_KEYS.SUB_DEPARTMENT_MANAGER,
      scope: 'ORG_UNIT'
    }),
    assetAdmin: authContext({
      ids,
      userId: ids.assetAdmin,
      orgUnitId: ids.department,
      positionKey: permissions.POSITION_KEYS.EMPLOYEE,
      functionalRoleKeys: [permissions.FUNCTIONAL_ROLE_KEYS.ASSET_ADMIN]
    })
  };
  return { ids, category, asset, contexts };
}

function membership(ids, userId, orgUnitId, positionKey, functionalRoleKeys = []) {
  return {
    _id: objectId(),
    teamId: ids.team,
    userId,
    orgUnitId,
    role: permissions.MEMBERSHIP_ROLES.MEMBER,
    positionLevel: permissions.POSITION_LEVEL_BY_KEY[positionKey],
    positionKey,
    functionalRoleKeys,
    permissionKeys: [],
    moduleDataScopes: [],
    status: permissions.MEMBERSHIP_STATUSES.ACTIVE,
    joinedAt: new Date('2029-01-01T00:00:00.000Z')
  };
}

async function createRule(routineService, routineType, overrides = {}) {
  return routineService.createRule({
    authContext: fixture.contexts.manager,
    input: {
      routineType,
      categoryId: String(fixture.category._id),
      name: `${routineType}-${new mongoose.Types.ObjectId()}`,
      checklistItems: [{ name: routineType === 'INSPECTION' ? '检查温度' : '更换润滑油' }],
      schedule: overrides.schedule,
      photoPolicy: overrides.photoPolicy || 'NONE',
      executionConfig: {
        timeZone: 'Asia/Shanghai',
        windows: overrides.windows || [
          { key: 'DAY_SHIFT', name: '白班', startTime: '07:00', endTime: '09:00', enabled: true },
          { key: 'NIGHT_SHIFT', name: '夜班', startTime: '19:00', endTime: '21:00', enabled: true }
        ],
        weeklyDay: overrides.weeklyDay || 1,
        monthlyDay: overrides.monthlyDay || 1,
        inspectionEscalationMinutes: 60,
        locationPolicy: overrides.locationPolicy || 'PENDING_CONFIRMATION',
        locationPrecisionMeters: overrides.locationPrecisionMeters ?? null
      }
    }
  });
}

before(async () => {
  assert.match(DATABASE_NAME, /_v2_test$/);
  replicaSet = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    instanceOpts: [{ dbName: DATABASE_NAME }]
  });
  await mongoose.connect(replicaSet.getUri(DATABASE_NAME), { dbName: DATABASE_NAME });
  await Promise.all(MODELS.map((model) => model.syncIndexes()));
});

beforeEach(async () => {
  await Promise.all(MODELS.map((model) => model.collection.deleteMany({})));
  fixture = await seed();
});

after(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replicaSet) await replicaSet.stop();
});

test('Asia/Shanghai execution windows use configurable weekly and monthly anchors', () => {
  const monday = windowBounds(
    new Date('2030-01-16T00:00:00.000Z'),
    'WEEK',
    { key: 'DAY_SHIFT', name: '白班', startTime: '07:00', endTime: '09:00' },
    {
      timeZone: 'Asia/Shanghai',
      weeklyDay: 1,
      monthlyDay: 1
    }
  );
  assert.equal(monday.scheduledFor.toISOString(), '2030-01-13T23:00:00.000Z');
  assert.equal(monday.dueAt.toISOString(), '2030-01-14T01:00:00.000Z');

  const monthEnd = windowBounds(
    new Date('2030-02-10T00:00:00.000Z'),
    'MONTH',
    { key: 'DAY_SHIFT', name: '白班', startTime: '07:00', endTime: '09:00' },
    {
      timeZone: 'Asia/Shanghai',
      weeklyDay: 1,
      monthlyDay: 31
    }
  );
  assert.equal(monthEnd.scheduledFor.toISOString(), '2030-02-27T23:00:00.000Z');
});

test('worker time progression sends inspection and maintenance roles once', async () => {
  const baseClock = () => new Date('2030-01-15T01:30:00.000Z');
  const routineService = createEquipmentRoutineService({ clock: baseClock });
  await createRule(routineService, 'INSPECTION', {
    schedule: {
      mode: 'CALENDAR',
      calendar: { unit: 'DAY', interval: 1, firstDueAt: '2030-01-15T00:00:00.000Z' }
    }
  });
  await createRule(routineService, 'MAINTENANCE', {
    schedule: {
      mode: 'CALENDAR',
      calendar: { unit: 'MONTH', interval: 1, firstDueAt: '2030-01-10T00:00:00.000Z' }
    },
    windows: [{ key: 'MAINTENANCE', name: '保养窗口', startTime: '07:00', endTime: '09:00', enabled: true }]
  });
  const worker = createEquipmentRoutineWorkerService({ routineService, clock: baseClock });

  await worker.runOnce({ now: '2030-01-15T01:30:00.000Z', teamId: fixture.ids.team });
  assert.equal(await Message.countDocuments({ recipient: fixture.ids.employee }), 1);
  assert.equal(await Message.countDocuments({ recipient: fixture.ids.subManager }), 2);
  assert.equal(await Message.countDocuments({ recipient: fixture.ids.assetAdmin }), 1);
  assert.equal(await Message.countDocuments({ recipient: fixture.ids.deputy }), 1);
  assert.equal(await Message.countDocuments({ recipient: fixture.ids.departmentManager }), 1);

  await Promise.all([
    worker.runOnce({ now: '2030-01-15T02:30:00.000Z', teamId: fixture.ids.team }),
    worker.runOnce({ now: '2030-01-15T02:30:00.000Z', teamId: fixture.ids.team })
  ]);
  assert.equal(await Message.countDocuments({ recipient: fixture.ids.assetAdmin }), 2);
  assert.equal(await Message.countDocuments({ recipient: fixture.ids.departmentManager }), 2);
  const totalAfterConcurrentRun = await Message.countDocuments({});
  await worker.runOnce({ now: '2030-01-15T02:30:00.000Z', teamId: fixture.ids.team });
  assert.equal(await Message.countDocuments({}), totalAfterConcurrentRun);
  assert.ok(await EquipmentRoutinePlan.findOne({
    routineType: 'INSPECTION',
    windowKey: 'DAY_SHIFT',
    status: 'OVERDUE'
  }));
});

test('abnormal evidence records a server watermark and follows the fixed three-stage order', async () => {
  const now = new Date('2030-01-15T02:30:00.000Z');
  const routineService = createEquipmentRoutineService({ clock: () => new Date(now) });
  const rule = await createRule(routineService, 'INSPECTION', {
    schedule: { mode: 'MANUAL' },
    photoPolicy: 'ON_ABNORMAL'
  });
  const photo = await FileAsset.create({
    teamId: fixture.ids.team,
    ownerType: FileAsset.FILE_OWNER_TYPES.TEMPORARY,
    ownerId: null,
    storageKey: `${fixture.ids.team}/2030/01/11111111-1111-4111-8111-111111111111.jpg`,
    originalName: '现场.jpg',
    mimeType: 'image/jpeg',
    size: 128,
    sha256: 'a'.repeat(64),
    uploaderId: fixture.ids.employee,
    status: FileAsset.FILE_STATUSES.TEMPORARY
  });
  const record = await routineService.createRecord({
    authContext: fixture.contexts.employee,
    equipmentId: String(fixture.asset._id),
    input: {
      ruleId: rule._id,
      itemResults: [{
        itemKey: rule.checklistItems[0].key,
        result: 'ABNORMAL',
        note: '=温度过高'
      }],
      abnormalSummary: '=需要停机检查',
      photoFileIds: [String(photo._id)],
      photoEvidence: [{
        fileId: String(photo._id),
        sourceType: 'CAMERA',
        capturedAt: '2030-01-15T02:29:00.000Z',
        locationStatus: 'DENIED',
        longitude: null,
        latitude: null,
        accuracyMeters: null,
        address: ''
      }]
    }
  });
  assert.match(record.photoEvidence[0].watermarkText, /定位状态：DENIED/);
  assert.equal(record.ruleSnapshot.executionConfig.locationPolicy, 'PENDING_CONFIRMATION');
  let exception = await EquipmentRoutineException.findOne({ recordId: record._id }).lean();
  assert.equal(exception.currentStage, 'TEAM_LEADER');
  assert.equal(await Message.countDocuments({ recipient: fixture.ids.teamLeader }), 1);

  const workflow = createEquipmentRoutineWorkflowService({ clock: () => new Date(now) });
  await assert.rejects(workflow.transitionException({
    authContext: fixture.contexts.assetAdmin,
    exceptionId: exception._id,
    input: { action: 'ESCALATE', opinion: '越级处理', expectedRevision: 0 }
  }), (error) => error.code === 'EQUIPMENT_ROUTINE_STAGE_FORBIDDEN');

  const concurrentTransitions = await Promise.allSettled([0, 1].map(() => workflow.transitionException({
    authContext: fixture.contexts.teamLeader,
    exceptionId: exception._id,
    input: { action: 'ESCALATE', opinion: '班组无法解决', expectedRevision: 0 }
  })));
  assert.equal(concurrentTransitions.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(concurrentTransitions.filter(({ status }) => status === 'rejected').length, 1);
  assert.equal(concurrentTransitions.find(({ status }) => status === 'rejected').reason.code, 'EQUIPMENT_ROUTINE_REVISION_CONFLICT');
  exception = await EquipmentRoutineException.findById(exception._id).lean();
  assert.equal(exception.currentStage, 'SUB_DEPARTMENT_MANAGER');
  const subManagerVisible = await workflow.listExceptions({
    authContext: fixture.contexts.subManager,
    query: { status: 'OPEN' }
  });
  assert.equal(subManagerVisible.total, 1);

  await workflow.transitionException({
    authContext: fixture.contexts.subManager,
    exceptionId: exception._id,
    input: { action: 'ESCALATE', opinion: '分部无法解决', expectedRevision: 1 }
  });
  exception = await EquipmentRoutineException.findById(exception._id).lean();
  assert.equal(exception.currentStage, 'ASSET_ADMIN');

  await workflow.transitionException({
    authContext: fixture.contexts.assetAdmin,
    exceptionId: exception._id,
    input: { action: 'RESOLVE', opinion: '已完成维修并复测', expectedRevision: 2 }
  });
  exception = await EquipmentRoutineException.findById(exception._id).lean();
  assert.equal(exception.status, 'RESOLVED');
  assert.equal(exception.currentStage, 'RESOLVED');
  assert.deepEqual(exception.history.map(({ action }) => action), [
    'SUBMITTED', 'ESCALATE', 'ESCALATE', 'RESOLVE'
  ]);

  const exported = await workflow.exportRecords({ authContext: fixture.contexts.manager });
  const workbook = XLSX.read(exported.buffer, { type: 'buffer', cellDates: true });
  const [row] = XLSX.utils.sheet_to_json(workbook.Sheets['点检保养记录'], { defval: '' });
  assert.equal(row['设备名称'], "'=现场设备");
  assert.equal(row['异常摘要'], "'=需要停机检查");
});

test('required location rejects denial and scoped reads cannot cross organization or team', async () => {
  const routineService = createEquipmentRoutineService({
    clock: () => new Date('2030-01-15T02:30:00.000Z')
  });
  const rule = await createRule(routineService, 'MAINTENANCE', {
    schedule: { mode: 'MANUAL' },
    photoPolicy: 'ALWAYS',
    locationPolicy: 'REQUIRED',
    locationPrecisionMeters: 50,
    windows: [{ key: 'MAINTENANCE', name: '保养窗口', startTime: '07:00', endTime: '09:00', enabled: true }]
  });
  const photo = await FileAsset.create({
    teamId: fixture.ids.team,
    ownerType: FileAsset.FILE_OWNER_TYPES.TEMPORARY,
    ownerId: null,
    storageKey: `${fixture.ids.team}/2030/01/22222222-2222-4222-8222-222222222222.jpg`,
    originalName: 'maintenance.jpg',
    mimeType: 'image/jpeg',
    size: 128,
    sha256: 'b'.repeat(64),
    uploaderId: fixture.ids.employee,
    status: FileAsset.FILE_STATUSES.TEMPORARY
  });
  await assert.rejects(routineService.createRecord({
    authContext: fixture.contexts.employee,
    equipmentId: String(fixture.asset._id),
    input: {
      ruleId: rule._id,
      itemResults: [{ itemKey: rule.checklistItems[0].key, result: 'COMPLETED' }],
      photoFileIds: [String(photo._id)],
      photoEvidence: [{
        fileId: String(photo._id),
        sourceType: 'CAMERA',
        capturedAt: '2030-01-15T02:29:00.000Z',
        locationStatus: 'DENIED'
      }]
    }
  }), (error) => error.code === 'EQUIPMENT_ROUTINE_INPUT_INVALID');
  assert.equal(await EquipmentRoutineRecord.countDocuments({}), 0);
  assert.equal((await FileAsset.findById(photo._id).lean()).status, 'TEMPORARY');

  const crossTeamPhoto = await FileAsset.create({
    teamId: fixture.ids.otherTeam,
    ownerType: FileAsset.FILE_OWNER_TYPES.TEMPORARY,
    ownerId: null,
    storageKey: `${fixture.ids.otherTeam}/2030/01/33333333-3333-4333-8333-333333333333.jpg`,
    originalName: 'cross-team.jpg',
    mimeType: 'image/jpeg',
    size: 128,
    sha256: 'c'.repeat(64),
    uploaderId: fixture.ids.otherUser,
    status: FileAsset.FILE_STATUSES.TEMPORARY
  });
  await assert.rejects(routineService.createRecord({
    authContext: fixture.contexts.employee,
    equipmentId: String(fixture.asset._id),
    input: {
      ruleId: rule._id,
      itemResults: [{ itemKey: rule.checklistItems[0].key, result: 'COMPLETED' }],
      photoFileIds: [String(crossTeamPhoto._id)],
      photoEvidence: [{
        fileId: String(crossTeamPhoto._id),
        sourceType: 'CAMERA',
        capturedAt: '2030-01-15T02:29:00.000Z',
        locationStatus: 'GRANTED',
        longitude: 117.1,
        latitude: 36.6,
        accuracyMeters: 10
      }]
    }
  }), (error) => ['FILE_NOT_FOUND', 'FILE_ACCESS_DENIED'].includes(error.code));
  assert.equal(await EquipmentRoutineRecord.countDocuments({}), 0);

  await EquipmentRoutineException.create({
    teamId: fixture.ids.team,
    orgUnitId: fixture.ids.subDepartment,
    equipmentId: fixture.asset._id,
    recordId: objectId(),
    routineType: 'INSPECTION',
    status: 'OPEN',
    currentStage: 'TEAM_LEADER',
    summary: '其他组织异常',
    history: [{
      stage: 'TEAM_LEADER',
      action: 'SUBMITTED',
      opinion: '',
      actorId: fixture.ids.employee,
      actedAt: new Date()
    }]
  });
  const workflow = createEquipmentRoutineWorkflowService();
  const scoped = await workflow.listExceptions({ authContext: fixture.contexts.employee });
  assert.equal(scoped.total, 0);
});
