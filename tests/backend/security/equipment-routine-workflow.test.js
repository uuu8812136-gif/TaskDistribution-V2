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
const EquipmentRuntimeReading = require('../../../app/models/EquipmentRuntimeReading');
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
const {
  holdLeaderRestoration,
  promiseStateAfterDelay
} = require('../helpers/leadershipConcurrency');

const DATABASE_NAME = 'equipment_routine_workflow_v2_test';
const MODELS = [
  AuditLog,
  EquipmentAsset,
  EquipmentCategory,
  EquipmentRoutineException,
  EquipmentRoutinePlan,
  EquipmentRoutineRecord,
  EquipmentRoutineRule,
  EquipmentRuntimeReading,
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

function globalContext(userId) {
  return Object.freeze({
    authenticated: true,
    sessionId: String(objectId()),
    mode: permissions.SESSION_MODES.GLOBAL_READ_ONLY,
    tokenVersion: 0,
    userId: String(userId),
    user: Object.freeze({ _id: String(userId), username: 'routine-super' }),
    isSuperAdmin: true,
    activeTeamId: null,
    team: null,
    membership: null,
    orgUnit: null,
    actorRole: permissions.AUDIT_ACTOR_ROLES.SUPER_ADMIN,
    permissionKeys: Object.freeze(['equipment.view']),
    moduleDataScopes: Object.freeze({}),
    readOnly: true,
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
    siblingGroup: objectId(),
    employee: objectId(),
    teamLeader: objectId(),
    subManager: objectId(),
    subDeputy: objectId(),
    supervisor: objectId(),
    assetAdmin: objectId(),
    departmentManager: objectId(),
    deputy: objectId(),
    otherUser: objectId()
  };
  const users = [
    ['employee', ids.employee],
    ['team-leader', ids.teamLeader],
    ['sub-manager', ids.subManager],
    ['sub-deputy', ids.subDeputy],
    ['supervisor', ids.supervisor],
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
    },
    {
      _id: ids.siblingGroup,
      teamId: ids.team,
      parentId: ids.subDepartment,
      type: permissions.ORG_UNIT_TYPES.TEAM_GROUP,
      code: 'SIBLING_GROUP',
      name: '二班组',
      status: permissions.ORG_UNIT_STATUSES.ACTIVE,
      sortOrder: 1,
      level: 3,
      path: `/${ids.department}/${ids.subDepartment}/`
    }
  ]);
  await TeamMembership.collection.insertMany([
    membership(ids, ids.employee, ids.group, permissions.POSITION_KEYS.EMPLOYEE),
    membership(ids, ids.teamLeader, ids.group, permissions.POSITION_KEYS.TEAM_LEADER),
    membership(ids, ids.subManager, ids.subDepartment, permissions.POSITION_KEYS.SUB_DEPARTMENT_MANAGER),
    membership(ids, ids.subDeputy, ids.subDepartment, permissions.POSITION_KEYS.SUB_DEPARTMENT_DEPUTY_MANAGER),
    membership(ids, ids.supervisor, ids.group, permissions.POSITION_KEYS.SUPERVISOR),
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
    subDeputy: authContext({
      ids,
      userId: ids.subDeputy,
      orgUnitId: ids.subDepartment,
      positionKey: permissions.POSITION_KEYS.SUB_DEPARTMENT_DEPUTY_MANAGER,
      scope: 'ORG_UNIT'
    }),
    supervisor: authContext({
      ids,
      userId: ids.supervisor,
      orgUnitId: ids.group,
      positionKey: permissions.POSITION_KEYS.SUPERVISOR,
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

test('worker time progression sends branch-scoped inspection and maintenance reminders once', async () => {
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
  assert.equal(await Message.countDocuments({ recipient: fixture.ids.employee }), 0);
  assert.equal(await Message.countDocuments({ recipient: fixture.ids.subManager }), 4);
  assert.equal(await Message.countDocuments({ recipient: fixture.ids.subDeputy }), 4);
  assert.equal(await Message.countDocuments({ recipient: fixture.ids.assetAdmin }), 0);
  assert.equal(await Message.countDocuments({ recipient: fixture.ids.deputy }), 0);
  assert.equal(await Message.countDocuments({ recipient: fixture.ids.departmentManager }), 0);

  await Promise.all([
    worker.runOnce({ now: '2030-01-15T02:30:00.000Z', teamId: fixture.ids.team }),
    worker.runOnce({ now: '2030-01-15T02:30:00.000Z', teamId: fixture.ids.team })
  ]);
  assert.equal(await Message.countDocuments({ recipient: fixture.ids.subManager }), 5);
  assert.equal(await Message.countDocuments({ recipient: fixture.ids.subDeputy }), 5);
  assert.equal(await Message.countDocuments({ recipient: fixture.ids.employee }), 0);
  const totalAfterConcurrentRun = await Message.countDocuments({});
  await worker.runOnce({ now: '2030-01-15T02:30:00.000Z', teamId: fixture.ids.team });
  assert.equal(await Message.countDocuments({}), totalAfterConcurrentRun);
  assert.ok(await EquipmentRoutinePlan.findOne({
    routineType: 'INSPECTION',
    windowKey: 'DAY_SHIFT',
    status: 'OVERDUE'
  }));
});

test('one equipment materializes independent inspection and maintenance plans for every schedule dimension', async () => {
  const now = new Date('2030-01-15T02:30:00.000Z');
  const routineService = createEquipmentRoutineService({ clock: () => now });
  await routineService.createRuntimeReading({
    authContext: fixture.contexts.manager,
    equipmentId: String(fixture.asset._id),
    input: { hours: 100, reason: 'Initial runtime baseline' }
  });

  const calendarSchedules = [
    ['DAY', { mode: 'CALENDAR', calendar: {
      unit: 'DAY', interval: 1, firstDueAt: '2030-01-15T00:00:00.000Z'
    } }],
    ['WEEK', { mode: 'CALENDAR', calendar: {
      unit: 'WEEK', interval: 1, firstDueAt: '2030-01-15T00:00:00.000Z'
    } }],
    ['MONTH', { mode: 'CALENDAR', calendar: {
      unit: 'MONTH', interval: 1, firstDueAt: '2030-01-15T00:00:00.000Z'
    } }]
  ];
  const createdRules = [];
  for (const routineType of ['INSPECTION', 'MAINTENANCE']) {
    for (const [, schedule] of calendarSchedules) {
      createdRules.push(await createRule(routineService, routineType, { schedule }));
    }
    createdRules.push(await createRule(routineService, routineType, {
      schedule: { mode: 'RUNTIME_HOURS', runtime: { intervalHours: 25 } }
    }));
    for (const duePolicy of ['ANY', 'ALL']) {
      createdRules.push(await createRule(routineService, routineType, {
        schedule: {
          mode: 'COMBINED',
          calendar: {
            unit: 'DAY', interval: 1, firstDueAt: '2030-01-15T00:00:00.000Z'
          },
          runtime: { intervalHours: 25 },
          duePolicy
        }
      }));
    }
  }

  await routineService.createRuntimeReading({
    authContext: fixture.contexts.manager,
    equipmentId: String(fixture.asset._id),
    input: { hours: 150, reason: 'Cross every runtime threshold' }
  });

  const scheduleResponse = await routineService.getSchedule({
    authContext: fixture.contexts.manager,
    equipmentId: String(fixture.asset._id)
  });
  assert.equal(scheduleResponse.schedules.length, 12);
  assert.equal(scheduleResponse.equipment.currentRuntimeHours, 150);
  for (const routineType of ['INSPECTION', 'MAINTENANCE']) {
    const applicable = scheduleResponse.schedules.filter(
      ({ rule }) => rule.routineType === routineType
    );
    assert.equal(applicable.length, 6);
    assert.deepEqual(
      new Set(applicable.filter(({ rule }) => rule.schedule.mode === 'CALENDAR')
        .map(({ rule }) => rule.schedule.calendar.unit)),
      new Set(['DAY', 'WEEK', 'MONTH'])
    );
    assert.equal(
      applicable.filter(({ rule }) => rule.schedule.mode === 'RUNTIME_HOURS').length,
      1
    );
    assert.equal(
      applicable.filter(({ rule }) => rule.schedule.mode === 'COMBINED').length,
      2
    );
    assert.deepEqual(
      new Set(applicable.filter(({ rule }) => rule.schedule.mode === 'COMBINED')
        .map(({ rule }) => rule.schedule.duePolicy)),
      new Set(['ANY', 'ALL'])
    );
  }
  for (const schedule of scheduleResponse.schedules.filter(
    ({ rule }) => ['RUNTIME_HOURS', 'COMBINED'].includes(rule.schedule.mode)
  )) {
    assert.equal(schedule.currentRuntimeHours, 150);
    assert.equal(schedule.nextDueRuntimeHours, 125);
    assert.ok(['DUE', 'OVERDUE'].includes(schedule.runtimeStatus));
  }

  const worker = createEquipmentRoutineWorkerService({ routineService, clock: () => now });
  const firstRun = await worker.runOnce({ now, teamId: fixture.ids.team });
  const plans = await EquipmentRoutinePlan.find({ equipmentId: fixture.asset._id }).lean();
  assert.equal(firstRun.rulesProcessed, createdRules.length);
  assert.equal(firstRun.plansProcessed, plans.length);
  assert.equal(new Set(plans.map((plan) => String(plan.ruleId))).size, createdRules.length);
  for (const rule of createdRules) {
    assert.ok(plans.some((plan) => String(plan.ruleId) === String(rule._id)));
  }
  assert.equal(
    new Set(plans.map((plan) => [
      plan.teamId,
      plan.ruleId,
      plan.equipmentId,
      plan.cycleKey,
      plan.windowKey
    ].map(String).join(':'))).size,
    plans.length
  );

  await worker.runOnce({ now, teamId: fixture.ids.team });
  assert.equal(
    await EquipmentRoutinePlan.countDocuments({ equipmentId: fixture.asset._id }),
    plans.length
  );
});

test('record submission without planId completes the oldest overdue plan first', async () => {
  const now = new Date('2030-01-15T02:30:00.000Z');
  const routineService = createEquipmentRoutineService({ clock: () => now });
  const rule = await createRule(routineService, 'INSPECTION', {
    schedule: { mode: 'MANUAL' },
    windows: [{
      key: 'DAY_SHIFT',
      name: 'Day shift',
      startTime: '07:00',
      endTime: '09:00',
      enabled: true
    }]
  });
  const planBase = {
    teamId: fixture.ids.team,
    orgUnitId: fixture.asset.orgUnitId,
    equipmentId: fixture.asset._id,
    categoryId: fixture.category._id,
    ruleId: rule._id,
    ruleVersion: rule.version,
    ruleSnapshot: rule,
    routineType: rule.routineType,
    windowKey: 'DAY_SHIFT',
    windowName: 'Day shift',
    status: 'OVERDUE'
  };
  const [oldPlan, newerPlan] = await EquipmentRoutinePlan.create([
    {
      ...planBase,
      cycleKey: 'manual-overdue-old',
      scheduledFor: new Date('2030-01-15T00:00:00.000Z'),
      dueAt: new Date('2030-01-15T01:00:00.000Z')
    },
    {
      ...planBase,
      cycleKey: 'manual-overdue-new',
      scheduledFor: new Date('2030-01-15T00:30:00.000Z'),
      dueAt: new Date('2030-01-15T02:00:00.000Z')
    }
  ]);

  const record = await routineService.createRecord({
    authContext: fixture.contexts.manager,
    equipmentId: String(fixture.asset._id),
    input: {
      ruleId: String(rule._id),
      itemResults: [{
        itemKey: rule.checklistItems[0].key,
        result: 'NORMAL'
      }],
      idempotencyKey: 'no-plan-id-oldest-overdue'
    }
  });

  assert.equal(String(record.planId), String(oldPlan._id));
  assert.equal((await EquipmentRoutinePlan.findById(oldPlan._id).lean()).status, 'COMPLETED');
  assert.equal((await EquipmentRoutinePlan.findById(newerPlan._id).lean()).status, 'OVERDUE');
});

test('completing a daily inspection leaves weekly and monthly plans unchanged', async () => {
  const now = new Date('2030-01-15T02:30:00.000Z');
  const routineService = createEquipmentRoutineService({ clock: () => now });
  const oneWindow = [{
    key: 'DAY_SHIFT',
    name: 'Day shift',
    startTime: '07:00',
    endTime: '09:00',
    enabled: true
  }];
  const rules = {};
  for (const unit of ['DAY', 'WEEK', 'MONTH']) {
    rules[unit] = await createRule(routineService, 'INSPECTION', {
      windows: unit === 'DAY'
        ? [
            ...oneWindow,
            {
              key: 'NIGHT_SHIFT',
              name: 'Night shift',
              startTime: '19:00',
              endTime: '21:00',
              enabled: true
            }
          ]
        : oneWindow,
      schedule: {
        mode: 'CALENDAR',
        calendar: {
          unit,
          interval: 1,
          firstDueAt: '2030-01-15T00:00:00.000Z'
        }
      }
    });
  }
  const worker = createEquipmentRoutineWorkerService({ routineService, clock: () => now });
  await worker.runOnce({ now, teamId: fixture.ids.team });

  const dailyPlan = await EquipmentRoutinePlan.findOne({
    ruleId: rules.DAY._id,
    status: 'OVERDUE'
  }).sort({ dueAt: 1 }).lean();
  assert.ok(dailyPlan);
  const unrelatedRuleIds = [rules.WEEK._id, rules.MONTH._id];
  const unrelatedBefore = await EquipmentRoutinePlan.find({
    ruleId: { $in: unrelatedRuleIds }
  }).sort({ ruleId: 1, cycleKey: 1, windowKey: 1 }).lean();

  const record = await routineService.createRecord({
    authContext: fixture.contexts.manager,
    equipmentId: String(fixture.asset._id),
    input: {
      ruleId: String(rules.DAY._id),
      planId: String(dailyPlan._id),
      itemResults: [{
        itemKey: rules.DAY.checklistItems[0].key,
        result: 'NORMAL'
      }],
      idempotencyKey: 'daily-does-not-complete-week-month'
    }
  });
  assert.equal(String(record.planId), String(dailyPlan._id));
  assert.equal((await EquipmentRoutinePlan.findById(dailyPlan._id).lean()).status, 'COMPLETED');
  assert.ok((await EquipmentRoutinePlan.find({
    ruleId: rules.DAY._id,
    cycleKey: dailyPlan.cycleKey,
    _id: { $ne: dailyPlan._id }
  }).lean()).every(({ status }) => status === 'CANCELLED'));

  const completedSchedule = await routineService.getSchedule({
    authContext: fixture.contexts.manager,
    equipmentId: String(fixture.asset._id)
  });
  const completedDaily = completedSchedule.schedules.find(({ rule }) => (
    String(rule._id) === String(rules.DAY._id)
  ));
  assert.equal(completedDaily.executable, false);
  assert.equal(completedDaily.executionStatus, 'PERIOD_COMPLETED');

  await assert.rejects(routineService.createRecord({
    authContext: fixture.contexts.manager,
    equipmentId: String(fixture.asset._id),
    input: {
      ruleId: String(rules.DAY._id),
      itemResults: [{
        itemKey: rules.DAY.checklistItems[0].key,
        result: 'NORMAL'
      }],
      idempotencyKey: 'daily-period-second-submission'
    }
  }), (error) => (
    error.status === 409 && error.code === 'EQUIPMENT_ROUTINE_PERIOD_COMPLETED'
  ));
  await assert.rejects(routineService.createRecord({
    authContext: fixture.contexts.manager,
    equipmentId: String(fixture.asset._id),
    input: {
      ruleId: String(rules.DAY._id),
      planId: String(dailyPlan._id),
      itemResults: [{
        itemKey: rules.DAY.checklistItems[0].key,
        result: 'NORMAL'
      }],
      idempotencyKey: 'daily-completed-plan-second-submission'
    }
  }), (error) => (
    error.status === 409 && error.code === 'EQUIPMENT_ROUTINE_PLAN_NOT_OPEN'
  ));
  assert.equal(await EquipmentRoutineRecord.countDocuments({
    equipmentId: fixture.asset._id,
    ruleId: rules.DAY._id
  }), 1);

  const unrelatedAfter = await EquipmentRoutinePlan.find({
    ruleId: { $in: unrelatedRuleIds }
  }).sort({ ruleId: 1, cycleKey: 1, windowKey: 1 }).lean();
  assert.deepEqual(
    unrelatedAfter.map(({ _id, status }) => [String(_id), status]),
    unrelatedBefore.map(({ _id, status }) => [String(_id), status])
  );
});

test('rule update replaces open plans with a new version and disable closes them permanently', async () => {
  const now = new Date('2030-01-15T02:30:00.000Z');
  const routineService = createEquipmentRoutineService({ clock: () => now });
  const rule = await createRule(routineService, 'MAINTENANCE', {
    windows: [{
      key: 'MAINTENANCE',
      name: 'Maintenance window',
      startTime: '07:00',
      endTime: '09:00',
      enabled: true
    }],
    schedule: {
      mode: 'CALENDAR',
      calendar: {
        unit: 'DAY',
        interval: 1,
        firstDueAt: '2030-01-15T00:00:00.000Z'
      }
    }
  });
  const worker = createEquipmentRoutineWorkerService({ routineService, clock: () => now });
  await worker.runOnce({ now, teamId: fixture.ids.team });
  const versionOnePlans = await EquipmentRoutinePlan.find({ ruleId: rule._id }).lean();
  assert.ok(versionOnePlans.length > 0);
  assert.ok(versionOnePlans.every(({ ruleVersion }) => ruleVersion === 1));

  const updatedRule = await routineService.updateRule({
    authContext: fixture.contexts.manager,
    ruleId: String(rule._id),
    input: { name: `${rule.name} version 2` }
  });
  assert.equal(updatedRule.version, 2);
  assert.ok((await EquipmentRoutinePlan.find({
    _id: { $in: versionOnePlans.map(({ _id }) => _id) }
  }).lean()).every(({ status }) => status === 'CANCELLED'));

  await worker.runOnce({ now, teamId: fixture.ids.team });
  const versionTwoPlans = await EquipmentRoutinePlan.find({
    ruleId: rule._id,
    status: { $in: ['PLANNED', 'IN_WINDOW', 'OVERDUE'] }
  }).lean();
  assert.ok(versionTwoPlans.length > 0);
  assert.ok(versionTwoPlans.every(({ ruleVersion, cycleKey }) => (
    ruleVersion === 2 && cycleKey.startsWith('calendar:v2:')
  )));

  const disabledRule = await routineService.disableRule({
    authContext: fixture.contexts.manager,
    ruleId: String(rule._id),
    input: { reason: 'Retired test rule' }
  });
  assert.equal(disabledRule.status, 'DISABLED');
  assert.equal(await EquipmentRoutinePlan.countDocuments({
    ruleId: rule._id,
    status: { $in: ['PLANNED', 'IN_WINDOW', 'OVERDUE'] }
  }), 0);
  const planCountAfterDisable = await EquipmentRoutinePlan.countDocuments({ ruleId: rule._id });
  await worker.runOnce({ now, teamId: fixture.ids.team });
  assert.equal(await EquipmentRoutinePlan.countDocuments({ ruleId: rule._id }), planCountAfterDisable);
});

test('rule deletion requires disabled status, removes derived plans, and preserves audit evidence', async () => {
  const now = new Date('2030-01-15T02:30:00.000Z');
  const routineService = createEquipmentRoutineService({ clock: () => now });
  const rule = await createRule(routineService, 'INSPECTION', {
    schedule: {
      mode: 'CALENDAR',
      calendar: { unit: 'DAY', interval: 1, firstDueAt: '2030-01-15T00:00:00.000Z' }
    }
  });
  const worker = createEquipmentRoutineWorkerService({ routineService, clock: () => now });
  await worker.runOnce({ now, teamId: fixture.ids.team });
  assert.ok(await EquipmentRoutinePlan.exists({ ruleId: rule._id }));

  await assert.rejects(routineService.deleteRule({
    authContext: fixture.contexts.manager,
    ruleId: rule._id,
    input: {}
  }), (error) => (
    error.status === 409 && error.code === 'EQUIPMENT_ROUTINE_RULE_DELETE_REQUIRES_DISABLED'
  ));

  await routineService.disableRule({
    authContext: fixture.contexts.manager,
    ruleId: rule._id,
    input: { reason: 'Prepare deletion' }
  });
  const deleted = await routineService.deleteRule({
    authContext: fixture.contexts.manager,
    ruleId: rule._id,
    input: { reason: 'Created by mistake' }
  });
  assert.equal(deleted.name, rule.name);
  assert.equal(await EquipmentRoutineRule.countDocuments({ _id: rule._id }), 0);
  assert.equal(await EquipmentRoutinePlan.countDocuments({ ruleId: rule._id }), 0);
  assert.equal(await AuditLog.countDocuments({
    resourceId: rule._id,
    action: permissions.AUDIT_ACTIONS.DELETE
  }), 1);
});

test('rule deletion rejects rules with execution history', async () => {
  const routineService = createEquipmentRoutineService();
  const rule = await createRule(routineService, 'MAINTENANCE', {
    schedule: { mode: 'MANUAL' }
  });
  await routineService.disableRule({
    authContext: fixture.contexts.manager,
    ruleId: rule._id,
    input: { reason: 'Retired rule' }
  });
  await EquipmentRoutineRecord.collection.insertOne({
    teamId: fixture.ids.team,
    orgUnitId: fixture.ids.subDepartment,
    equipmentId: fixture.asset._id,
    categoryId: fixture.category._id,
    ruleId: new mongoose.Types.ObjectId(rule._id),
    ruleVersion: 1,
    ruleSnapshot: { name: rule.name },
    planId: null,
    routineType: 'MAINTENANCE',
    scheduledFor: null,
    dueRuntimeHours: null,
    performedBy: fixture.ids.departmentManager,
    performedAt: new Date('2030-01-14T00:00:00.000Z'),
    performedRuntimeHours: null,
    itemResults: [{ itemKey: 'item-1', result: 'COMPLETED', note: '' }],
    overallResult: 'NORMAL',
    abnormalSummary: '',
    photoFileIds: [],
    photoEvidence: [],
    idempotencyKey: null,
    createdAt: new Date('2030-01-14T00:00:00.000Z'),
    updatedAt: new Date('2030-01-14T00:00:00.000Z')
  });

  await assert.rejects(routineService.deleteRule({
    authContext: fixture.contexts.manager,
    ruleId: rule._id,
    input: {}
  }), (error) => (
    error.status === 409 && error.code === 'EQUIPMENT_ROUTINE_RULE_DELETE_HAS_HISTORY'
  ));
  assert.equal(await EquipmentRoutineRule.countDocuments({ _id: rule._id }), 1);
});

test('COMBINED ANY keeps only the first due dimension and advances idempotently after completion', async () => {
  const now = new Date('2030-01-15T02:30:00.000Z');
  const routineService = createEquipmentRoutineService({ clock: () => now });
  const equipmentId = String(fixture.asset._id);
  const oneWindow = [{
    key: 'DAY_SHIFT',
    name: 'Day shift',
    startTime: '07:00',
    endTime: '09:00',
    enabled: true
  }];
  const calendarWindows = [
    ...oneWindow,
    {
      key: 'NIGHT_SHIFT',
      name: 'Night shift',
      startTime: '19:00',
      endTime: '21:00',
      enabled: true
    }
  ];

  await routineService.createRuntimeReading({
    authContext: fixture.contexts.manager,
    equipmentId,
    input: { hours: 100, reason: 'Combined ANY baseline' }
  });
  const runtimeFirstRule = await createRule(routineService, 'INSPECTION', {
    windows: oneWindow,
    schedule: {
      mode: 'COMBINED',
      calendar: { unit: 'DAY', interval: 1, firstDueAt: '2030-01-16T02:30:00.000Z' },
      runtime: { intervalHours: 25 },
      duePolicy: 'ANY'
    }
  });
  const calendarFirstRule = await createRule(routineService, 'INSPECTION', {
    windows: calendarWindows,
    schedule: {
      mode: 'COMBINED',
      calendar: { unit: 'DAY', interval: 1, firstDueAt: '2030-01-15T00:00:00.000Z' },
      runtime: { intervalHours: 1000 },
      duePolicy: 'ANY'
    }
  });

  const worker = createEquipmentRoutineWorkerService({ routineService, clock: () => now });
  await worker.runOnce({ now, teamId: fixture.ids.team });
  const initialRuntimeCalendarPlans = await EquipmentRoutinePlan.find({
    ruleId: runtimeFirstRule._id
  }).sort({ scheduledFor: 1 }).lean();
  assert.equal(initialRuntimeCalendarPlans.length, 2);
  assert.ok(initialRuntimeCalendarPlans.every(({ windowKey, status }) => (
    windowKey === 'DAY_SHIFT' && status === 'PLANNED'
  )));
  const initialRuntimeCalendarIds = initialRuntimeCalendarPlans.map(({ _id }) => String(_id));
  const initialRuntimeCalendarCycleKeys = initialRuntimeCalendarPlans.map(({ cycleKey }) => cycleKey);
  const calendarFirstPlans = await EquipmentRoutinePlan.find({
    ruleId: calendarFirstRule._id
  }).sort({ scheduledFor: 1, windowKey: 1 }).lean();
  assert.equal(calendarFirstPlans.length, 4);
  const calendarPlan = calendarFirstPlans.find(({ windowKey, status }) => (
    windowKey === 'DAY_SHIFT' && status === 'OVERDUE'
  ));
  assert.ok(calendarPlan);
  const sameCalendarCycleSibling = calendarFirstPlans.find(({ cycleKey, windowKey }) => (
    cycleKey === calendarPlan.cycleKey && windowKey === 'NIGHT_SHIFT'
  ));
  assert.ok(sameCalendarCycleSibling);
  const laterCalendarCyclePlans = calendarFirstPlans.filter(({ cycleKey }) => (
    cycleKey !== calendarPlan.cycleKey
  ));
  assert.equal(laterCalendarCyclePlans.length, 2);
  assert.equal(await EquipmentRoutinePlan.countDocuments({
    ruleId: calendarFirstRule._id,
    windowKey: 'RUNTIME'
  }), 0, 'calendar-first due state must not also create a runtime plan');

  const calendarPlanId = String(calendarPlan._id);
  await worker.runOnce({ now, teamId: fixture.ids.team });
  assert.deepEqual(
    (await EquipmentRoutinePlan.find({ ruleId: runtimeFirstRule._id })
      .sort({ scheduledFor: 1 }).lean()).map(({ _id }) => String(_id)),
    initialRuntimeCalendarIds,
    'repeated worker runs must reuse pre-generated calendar plans'
  );
  assert.deepEqual(
    (await EquipmentRoutinePlan.find({ ruleId: calendarFirstRule._id })
      .sort({ scheduledFor: 1, windowKey: 1 }).lean()).map(({ _id }) => String(_id)),
    calendarFirstPlans.map(({ _id }) => String(_id)),
    'repeated worker runs must reuse the calendar-first plan'
  );

  await routineService.createRuntimeReading({
    authContext: fixture.contexts.manager,
    equipmentId,
    input: { hours: 125, reason: 'Runtime reaches the first trigger' }
  });
  await worker.runOnce({ now, teamId: fixture.ids.team });
  const [runtimePlan] = await EquipmentRoutinePlan.find({
    ruleId: runtimeFirstRule._id,
    status: { $in: ['PLANNED', 'IN_WINDOW', 'OVERDUE'] }
  }).lean();
  assert.ok(runtimePlan, 'runtime-only due state must materialize immediately');
  assert.equal(runtimePlan.windowKey, 'RUNTIME');
  assert.equal(runtimePlan.scheduledFor.toISOString(), now.toISOString());
  assert.equal(runtimePlan.dueAt.toISOString(), now.toISOString());
  assert.equal(await EquipmentRoutinePlan.countDocuments({
    ruleId: runtimeFirstRule._id,
    status: { $in: ['PLANNED', 'IN_WINDOW', 'OVERDUE'] }
  }), 1);
  assert.deepEqual(
    (await EquipmentRoutinePlan.find({
      _id: { $in: initialRuntimeCalendarIds }
    }).sort({ scheduledFor: 1 }).lean()).map(({ status }) => status),
    ['CANCELLED', 'CANCELLED'],
    'runtime-first materialization must close the pre-generated calendar requirements'
  );
  assert.equal(await EquipmentRoutinePlan.countDocuments({
    ruleId: calendarFirstRule._id,
    windowKey: 'RUNTIME'
  }), 0);

  const runtimePlanId = String(runtimePlan._id);
  const runtimeCycleKey = runtimePlan.cycleKey;
  await worker.runOnce({ now, teamId: fixture.ids.team });
  assert.deepEqual(
    (await EquipmentRoutinePlan.find({
      ruleId: runtimeFirstRule._id,
      status: { $in: ['PLANNED', 'IN_WINDOW', 'OVERDUE'] }
    }).lean()).map(({ _id }) => String(_id)),
    [runtimePlanId],
    'repeated worker runs must reuse the runtime-first plan'
  );

  await routineService.createRecord({
    authContext: fixture.contexts.manager,
    equipmentId,
    input: {
      ruleId: String(runtimeFirstRule._id),
      planId: runtimePlanId,
      runtimeHours: 125,
      idempotencyKey: 'combined-any-runtime-first-completion',
      itemResults: [{
        itemKey: runtimeFirstRule.checklistItems[0].key,
        result: 'NORMAL'
      }]
    }
  });
  const calendarCompletion = await routineService.createRecord({
    authContext: fixture.contexts.manager,
    equipmentId,
    input: {
      ruleId: String(calendarFirstRule._id),
      planId: calendarPlanId,
      runtimeHours: 125,
      idempotencyKey: 'combined-any-calendar-first-completion',
      itemResults: [{
        itemKey: calendarFirstRule.checklistItems[0].key,
        result: 'NORMAL'
      }]
    }
  });
  assert.ok(calendarCompletion);
  assert.equal((await EquipmentRoutinePlan.findById(sameCalendarCycleSibling._id).lean()).status, 'CANCELLED');
  assert.deepEqual(
    (await EquipmentRoutinePlan.find({
      _id: { $in: laterCalendarCyclePlans.map(({ _id }) => _id) }
    }).sort({ scheduledFor: 1, windowKey: 1 }).lean()).map(({ status }) => status),
    ['CANCELLED', 'CANCELLED'],
    'calendar completion must cancel the remaining plans from the old generation'
  );
  await worker.runOnce({ now, teamId: fixture.ids.team });
  const nextCyclePlans = await EquipmentRoutinePlan.find({
    ruleId: runtimeFirstRule._id,
    status: { $in: ['PLANNED', 'IN_WINDOW', 'OVERDUE'] }
  }).sort({ scheduledFor: 1 }).lean();
  assert.equal(nextCyclePlans.length, 2);
  assert.ok(nextCyclePlans.every(({ windowKey }) => windowKey === 'DAY_SHIFT'));
  assert.ok(nextCyclePlans.every(({ cycleKey }) => (
    !initialRuntimeCalendarCycleKeys.includes(cycleKey) && cycleKey !== runtimeCycleKey
  )), 'the next cycle must use fresh identities even when its calendar anchor is unchanged');
  assert.equal(await EquipmentRoutinePlan.countDocuments({
    ruleId: runtimeFirstRule._id,
    cycleKey: { $in: [...initialRuntimeCalendarCycleKeys, runtimeCycleKey] },
    status: { $in: ['PLANNED', 'IN_WINDOW', 'OVERDUE'] }
  }), 0, 'completion must leave no open requirement from the completed combined cycle');
  assert.equal(await EquipmentRoutinePlan.countDocuments({
    ruleId: runtimeFirstRule._id,
    status: 'COMPLETED'
  }), 1);
  assert.equal((await EquipmentRoutinePlan.findById(sameCalendarCycleSibling._id).lean()).status, 'CANCELLED');
  const nextCalendarFirstPlans = await EquipmentRoutinePlan.find({
    ruleId: calendarFirstRule._id,
    status: { $in: ['PLANNED', 'IN_WINDOW', 'OVERDUE'] }
  }).lean();
  assert.equal(nextCalendarFirstPlans.length, 4);
  assert.ok(nextCalendarFirstPlans.every(({ cycleKey }) => (
    cycleKey !== calendarPlan.cycleKey &&
    !laterCalendarCyclePlans.some((oldPlan) => oldPlan.cycleKey === cycleKey)
  )));
  const nextCycleIds = nextCyclePlans.map(({ _id }) => String(_id));
  await worker.runOnce({ now, teamId: fixture.ids.team });
  assert.deepEqual(
    (await EquipmentRoutinePlan.find({
      ruleId: runtimeFirstRule._id,
      status: { $in: ['PLANNED', 'IN_WINDOW', 'OVERDUE'] }
    }).sort({ scheduledFor: 1 }).lean()).map(({ _id }) => String(_id)),
    nextCycleIds,
    'the post-completion cycle must also remain idempotent'
  );
});

test('routine plan detail preserves team, organization, and global read-only isolation', async () => {
  const workflow = createEquipmentRoutineWorkflowService();
  const planBase = {
    categoryId: fixture.category._id,
    ruleVersion: 1,
    ruleSnapshot: { name: '消息定位计划' },
    routineType: 'INSPECTION',
    windowKey: 'DAY_SHIFT',
    windowName: '白班',
    scheduledFor: new Date('2030-01-15T00:00:00.000Z'),
    dueAt: new Date('2030-01-15T02:00:00.000Z'),
    status: 'PLANNED'
  };
  const [visiblePlan, hiddenOrgPlan, otherTeamPlan] = await EquipmentRoutinePlan.create([
    {
      ...planBase,
      teamId: fixture.ids.team,
      orgUnitId: fixture.ids.group,
      equipmentId: fixture.asset._id,
      ruleId: objectId(),
      cycleKey: 'visible-plan'
    },
    {
      ...planBase,
      teamId: fixture.ids.team,
      orgUnitId: fixture.ids.subDepartment,
      equipmentId: fixture.asset._id,
      ruleId: objectId(),
      cycleKey: 'hidden-org-plan'
    },
    {
      ...planBase,
      teamId: fixture.ids.otherTeam,
      orgUnitId: objectId(),
      equipmentId: objectId(),
      categoryId: objectId(),
      ruleId: objectId(),
      cycleKey: 'other-team-plan'
    }
  ]);

  const visible = await workflow.getPlan({
    authContext: fixture.contexts.employee,
    planId: visiblePlan._id
  });
  assert.equal(visible._id, String(visiblePlan._id));
  assert.equal(visible.equipment.name, '=现场设备');
  assert.equal(visible.orgUnit.name, '一班组');

  await assert.rejects(workflow.getPlan({
    authContext: fixture.contexts.employee,
    planId: hiddenOrgPlan._id
  }), (error) => error.status === 404 && error.code === 'EQUIPMENT_ROUTINE_WORKFLOW_NOT_FOUND');
  await assert.rejects(workflow.getPlan({
    authContext: fixture.contexts.manager,
    requestedTeamId: String(fixture.ids.otherTeam),
    planId: otherTeamPlan._id
  }), (error) => error.status === 404 && error.code === 'EQUIPMENT_ROUTINE_WORKFLOW_NOT_FOUND');

  const global = globalContext(fixture.ids.departmentManager);
  await assert.rejects(workflow.getPlan({
    authContext: global,
    planId: visiblePlan._id
  }), (error) => error.status === 400 && error.code === 'EQUIPMENT_ROUTINE_WORKFLOW_INPUT_INVALID');
  const globallyVisible = await workflow.getPlan({
    authContext: global,
    requestedTeamId: String(fixture.ids.otherTeam),
    query: { teamId: String(fixture.ids.otherTeam) },
    planId: otherTeamPlan._id
  });
  assert.equal(globallyVisible._id, String(otherTeamPlan._id));
  await assert.rejects(workflow.getPlan({
    authContext: global,
    requestedTeamId: String(fixture.ids.team),
    query: { teamId: String(fixture.ids.team) },
    planId: otherTeamPlan._id
  }), (error) => error.status === 404 && error.code === 'EQUIPMENT_ROUTINE_WORKFLOW_NOT_FOUND');
});

test('future plans stay blocked and a stale PLANNED status becomes executable only after start time', async () => {
  const beforeStart = new Date('2030-01-15T00:00:00.000Z');
  const rule = await createRule(
    createEquipmentRoutineService({ clock: () => new Date(beforeStart) }),
    'INSPECTION',
    {
      schedule: {
        mode: 'CALENDAR',
        calendar: { unit: 'DAY', interval: 1, firstDueAt: '2030-01-15T01:00:00.000Z' }
      }
    }
  );
  await EquipmentAsset.updateOne(
    { _id: fixture.asset._id },
    { $set: { location: '仓配二分部叉车区' } }
  );
  const plan = await EquipmentRoutinePlan.create({
    teamId: fixture.ids.team,
    orgUnitId: fixture.ids.group,
    equipmentId: fixture.asset._id,
    categoryId: fixture.category._id,
    ruleId: rule._id,
    ruleVersion: rule.version,
    ruleSnapshot: rule,
    routineType: 'INSPECTION',
    cycleKey: 'future-plan-hard-gate',
    windowKey: 'DAY_SHIFT',
    windowName: '白班',
    scheduledFor: new Date('2030-01-15T01:00:00.000Z'),
    dueAt: new Date('2030-01-15T03:00:00.000Z'),
    status: 'PLANNED'
  });
  const submission = {
    ruleId: rule._id,
    itemResults: [{ itemKey: rule.checklistItems[0].key, result: 'NORMAL', note: '' }],
    abnormalSummary: '',
    photoFileIds: []
  };
  const beforeService = createEquipmentRoutineService({ clock: () => new Date(beforeStart) });
  const beforeSchedule = await beforeService.getSchedule({
    authContext: fixture.contexts.employee,
    equipmentId: fixture.asset._id
  });
  assert.equal(beforeSchedule.equipment.location, '仓配二分部叉车区');
  assert.equal(beforeSchedule.schedules[0].plans[0].status, 'PLANNED');
  assert.equal(beforeSchedule.schedules[0].executable, false);
  assert.equal(beforeSchedule.schedules[0].executionStatus, 'NOT_STARTED');
  await assert.rejects(beforeService.createRecord({
    authContext: fixture.contexts.employee,
    equipmentId: fixture.asset._id,
    input: { ...submission, planId: String(plan._id) }
  }), (error) => error.status === 409 && error.code === 'EQUIPMENT_ROUTINE_PLAN_NOT_STARTED');
  await assert.rejects(beforeService.createRecord({
    authContext: fixture.contexts.employee,
    equipmentId: fixture.asset._id,
    input: submission
  }), (error) => error.status === 409 && error.code === 'EQUIPMENT_ROUTINE_PLAN_NOT_STARTED');
  assert.equal(await EquipmentRoutineRecord.countDocuments({ ruleId: rule._id }), 0);

  const insideWindow = new Date('2030-01-15T01:30:00.000Z');
  const insideService = createEquipmentRoutineService({ clock: () => new Date(insideWindow) });
  const insideSchedule = await insideService.getSchedule({
    authContext: fixture.contexts.employee,
    equipmentId: fixture.asset._id
  });
  assert.equal(insideSchedule.schedules[0].plans[0].status, 'IN_WINDOW');
  assert.equal(insideSchedule.schedules[0].executable, true);
  const record = await insideService.createRecord({
    authContext: fixture.contexts.employee,
    equipmentId: fixture.asset._id,
    input: { ...submission, planId: String(plan._id) }
  });
  assert.equal(record.planId, String(plan._id));
  assert.equal((await EquipmentRoutinePlan.findById(plan._id).lean()).status, 'COMPLETED');
});

test('rest day cancellation is current-day inspection only, scoped, idempotent, and audited', async () => {
  const now = new Date('2030-01-15T02:00:00.000Z');
  const inspectionRule = await createRule(
    createEquipmentRoutineService({ clock: () => new Date(now) }),
    'INSPECTION',
    {
      schedule: {
        mode: 'CALENDAR',
        calendar: { unit: 'DAY', interval: 1, firstDueAt: '2030-01-15T00:00:00.000Z' }
      }
    }
  );
  const maintenanceRule = await createRule(
    createEquipmentRoutineService({ clock: () => new Date(now) }),
    'MAINTENANCE',
    {
      schedule: {
        mode: 'CALENDAR',
        calendar: { unit: 'DAY', interval: 1, firstDueAt: '2030-01-15T00:00:00.000Z' }
      }
    }
  );
  const planBase = {
    teamId: fixture.ids.team,
    orgUnitId: fixture.ids.group,
    equipmentId: fixture.asset._id,
    categoryId: fixture.category._id,
    ruleVersion: 1,
    windowKey: 'DAY_SHIFT',
    windowName: '白班',
    scheduledFor: new Date('2030-01-15T00:00:00.000Z'),
    dueAt: new Date('2030-01-15T04:00:00.000Z'),
    status: 'PLANNED'
  };
  const [inspectionPlan, maintenancePlan, futurePlan, hiddenPlan, otherTeamPlan] = await EquipmentRoutinePlan.create([
    {
      ...planBase,
      ruleId: inspectionRule._id,
      ruleSnapshot: inspectionRule,
      routineType: 'INSPECTION',
      cycleKey: 'rest-day-current'
    },
    {
      ...planBase,
      ruleId: maintenanceRule._id,
      ruleSnapshot: maintenanceRule,
      routineType: 'MAINTENANCE',
      cycleKey: 'rest-day-maintenance'
    },
    {
      ...planBase,
      ruleId: inspectionRule._id,
      ruleSnapshot: inspectionRule,
      routineType: 'INSPECTION',
      cycleKey: 'rest-day-future',
      scheduledFor: new Date('2030-01-16T00:00:00.000Z'),
      dueAt: new Date('2030-01-16T04:00:00.000Z')
    },
    {
      ...planBase,
      orgUnitId: fixture.ids.subDepartment,
      ruleId: inspectionRule._id,
      ruleSnapshot: inspectionRule,
      routineType: 'INSPECTION',
      cycleKey: 'rest-day-hidden-org'
    },
    {
      ...planBase,
      teamId: fixture.ids.otherTeam,
      orgUnitId: objectId(),
      equipmentId: objectId(),
      categoryId: objectId(),
      ruleId: objectId(),
      ruleSnapshot: inspectionRule,
      routineType: 'INSPECTION',
      cycleKey: 'rest-day-other-team'
    }
  ]);
  const workflow = createEquipmentRoutineWorkflowService({ clock: () => new Date(now) });
  await assert.rejects(workflow.markPlansRestDay({
    authContext: fixture.contexts.manager,
    input: { planIds: [String(maintenancePlan._id)] }
  }), (error) => error.status === 409 && error.code === 'EQUIPMENT_ROUTINE_REST_DAY_INSPECTION_ONLY');
  await assert.rejects(workflow.markPlansRestDay({
    authContext: fixture.contexts.manager,
    input: { planIds: [String(futurePlan._id)] }
  }), (error) => error.status === 409 && error.code === 'EQUIPMENT_ROUTINE_REST_DAY_CURRENT_DATE_ONLY');
  await assert.rejects(workflow.markPlansRestDay({
    authContext: fixture.contexts.employee,
    input: { planIds: [String(hiddenPlan._id)] }
  }), (error) => error.status === 404 && error.code === 'EQUIPMENT_ROUTINE_WORKFLOW_NOT_FOUND');
  await assert.rejects(workflow.markPlansRestDay({
    authContext: fixture.contexts.manager,
    input: { planIds: [String(otherTeamPlan._id)] }
  }), (error) => error.status === 404 && error.code === 'EQUIPMENT_ROUTINE_WORKFLOW_NOT_FOUND');
  await assert.rejects(workflow.markPlansRestDay({
    authContext: globalContext(fixture.ids.departmentManager),
    input: { planIds: [String(inspectionPlan._id)] }
  }), (error) => error.status === 403);

  const cancelled = await workflow.markPlansRestDay({
    authContext: fixture.contexts.employee,
    input: { planIds: [String(inspectionPlan._id)] }
  });
  assert.equal(cancelled.cancelledCount, 1);
  assert.equal(cancelled.alreadyCancelledCount, 0);
  assert.equal(cancelled.plans[0].status, 'CANCELLED');
  assert.equal(cancelled.plans[0].windowName, '休班');
  assert.equal(cancelled.plans[0].originalWindowName, '白班');
  assert.equal(cancelled.plans[0].cancellationReason, 'REST_DAY');
  assert.equal(cancelled.plans[0].cancelledBy, String(fixture.ids.employee));
  const persisted = await EquipmentRoutinePlan.findById(inspectionPlan._id).lean();
  assert.equal(persisted.windowName, '白班');
  assert.equal(persisted.status, 'CANCELLED');
  assert.equal(persisted.cancellationReason, 'REST_DAY');
  assert.equal(await AuditLog.countDocuments({
    action: permissions.AUDIT_ACTIONS.STATUS_CHANGE,
    resourceType: permissions.AUDIT_RESOURCE_TYPES.INSPECTION_PLAN,
    resourceId: String(inspectionPlan._id)
  }), 1);
  const replay = await workflow.markPlansRestDay({
    authContext: fixture.contexts.employee,
    input: { planIds: [String(inspectionPlan._id)] }
  });
  assert.equal(replay.cancelledCount, 0);
  assert.equal(replay.alreadyCancelledCount, 1);
  assert.equal(await AuditLog.countDocuments({ resourceId: String(inspectionPlan._id) }), 1);

  const routineService = createEquipmentRoutineService({ clock: () => new Date(now) });
  await assert.rejects(routineService.createRecord({
    authContext: fixture.contexts.employee,
    equipmentId: fixture.asset._id,
    input: {
      ruleId: inspectionRule._id,
      itemResults: [{
        itemKey: inspectionRule.checklistItems[0].key,
        result: 'NORMAL',
        note: ''
      }],
      abnormalSummary: '',
      photoFileIds: []
    }
  }), (error) => error.status === 409 && error.code === 'EQUIPMENT_ROUTINE_REST_DAY_CANCELLED');
});

test('sub-department deputy is primary and supervisor acts only when that exact branch has no primary leader', async () => {
  const otherSubDepartment = objectId();
  const otherSubManager = objectId();
  const rootMisassignedManager = objectId();
  await OrgUnit.collection.insertOne({
    _id: otherSubDepartment,
    teamId: fixture.ids.team,
    parentId: fixture.ids.department,
    type: permissions.ORG_UNIT_TYPES.SUB_DEPARTMENT,
    code: 'OTHER_SUB',
    name: '二分部',
    status: permissions.ORG_UNIT_STATUSES.ACTIVE,
    sortOrder: 1,
    level: 2,
    path: `/${fixture.ids.department}/`
  });
  await User.collection.insertMany([
    {
      _id: otherSubManager,
      username: 'other-sub-manager',
      usernameNormalized: 'other-sub-manager',
      password: 'unused',
      name: 'other-sub-manager',
      roles: [],
      isSuperAdmin: false,
      tokenVersion: 0,
      status: 'active'
    },
    {
      _id: rootMisassignedManager,
      username: 'root-misassigned-manager',
      usernameNormalized: 'root-misassigned-manager',
      password: 'unused',
      name: 'root-misassigned-manager',
      roles: [],
      isSuperAdmin: false,
      tokenVersion: 0,
      status: 'active'
    }
  ]);
  await TeamMembership.collection.insertMany([
    membership(
      fixture.ids,
      otherSubManager,
      otherSubDepartment,
      permissions.POSITION_KEYS.SUB_DEPARTMENT_MANAGER
    ),
    membership(
      fixture.ids,
      rootMisassignedManager,
      fixture.ids.department,
      permissions.POSITION_KEYS.SUB_DEPARTMENT_MANAGER
    )
  ]);

  const exception = await EquipmentRoutineException.create({
    teamId: fixture.ids.team,
    orgUnitId: fixture.ids.siblingGroup,
    equipmentId: fixture.asset._id,
    recordId: objectId(),
    routineType: 'INSPECTION',
    status: 'OPEN',
    currentStage: 'SUB_DEPARTMENT_MANAGER',
    summary: '主管兜底测试',
    history: [{
      stage: 'TEAM_LEADER',
      action: 'ESCALATE',
      opinion: '升级处理',
      actorId: fixture.ids.teamLeader,
      actedAt: new Date('2030-01-15T01:00:00.000Z')
    }],
    revision: 0
  });
  const workflow = createEquipmentRoutineWorkflowService({ connection: mongoose.connection });

  const deputyView = await workflow.getException({
    authContext: fixture.contexts.subDeputy,
    exceptionId: exception._id,
    query: {}
  });
  assert.equal(deputyView.accessPolicy.canHandle, true);
  await assert.rejects(workflow.getException({
    authContext: fixture.contexts.supervisor,
    exceptionId: exception._id,
    query: {}
  }), (error) => error.status === 404);
  assert.equal((await workflow.listExceptions({
    authContext: fixture.contexts.supervisor,
    query: { status: 'OPEN' }
  })).total, 0);
  await workflow.notifyExceptionStage(exception);
  assert.equal(await Message.countDocuments({ recipient: otherSubManager }), 0);
  assert.equal(await Message.countDocuments({ recipient: rootMisassignedManager }), 0);
  assert.equal(await Message.countDocuments({ recipient: fixture.ids.supervisor }), 0);

  await TeamMembership.updateMany({
    userId: { $in: [fixture.ids.subManager, fixture.ids.subDeputy] }
  }, { $set: { status: permissions.MEMBERSHIP_STATUSES.DISABLED } });
  const supervisorFallback = await workflow.getException({
    authContext: fixture.contexts.supervisor,
    exceptionId: exception._id,
    query: {}
  });
  assert.equal(supervisorFallback.accessPolicy.canHandle, true);
  const supervisorTodo = await workflow.listExceptions({
    authContext: fixture.contexts.supervisor,
    query: { status: 'OPEN', stage: 'SUB_DEPARTMENT_MANAGER' }
  });
  assert.equal(supervisorTodo.total, 1);
  assert.equal(supervisorTodo.exceptions[0]._id, String(exception._id));
  assert.equal(supervisorTodo.exceptions[0].accessPolicy.canHandle, true);
  await workflow.notifyExceptionStage(exception);
  assert.equal(await Message.countDocuments({ recipient: fixture.ids.supervisor }), 1);

  const resolved = await workflow.transitionException({
    authContext: fixture.contexts.supervisor,
    exceptionId: exception._id,
    input: {
      action: 'RESOLVE',
      opinion: '主管兜底处理完成',
      expectedRevision: 0
    }
  });
  assert.equal(resolved.status, 'RESOLVED');
  assert.equal(resolved.accessPolicy.canHandle, false);
  assert.equal(
    resolved.history.at(-1).actorPositionKey,
    permissions.POSITION_KEYS.SUPERVISOR
  );
  const supervisorAudit = await AuditLog.findOne({
    actorUserId: fixture.ids.supervisor,
    resourceId: String(exception._id)
  }).lean();
  assert.equal(
    supervisorAudit.after.history.at(-1).actorPositionKey,
    permissions.POSITION_KEYS.SUPERVISOR
  );
});

test('concurrent leader restoration serializes before supervisor routine handling', async () => {
  const managerMembership = await TeamMembership.findOne({ userId: fixture.ids.subManager });
  await TeamMembership.updateMany({
    userId: { $in: [fixture.ids.subManager, fixture.ids.subDeputy] }
  }, { $set: { status: permissions.MEMBERSHIP_STATUSES.DISABLED } });
  const exception = await EquipmentRoutineException.create({
    teamId: fixture.ids.team,
    orgUnitId: fixture.ids.group,
    equipmentId: fixture.asset._id,
    recordId: objectId(),
    routineType: 'INSPECTION',
    status: 'OPEN',
    currentStage: 'SUB_DEPARTMENT_MANAGER',
    summary: 'Concurrent leader restoration',
    history: [{
      stage: 'TEAM_LEADER',
      action: 'ESCALATE',
      opinion: 'Escalated for concurrency test',
      actorId: fixture.ids.teamLeader,
      actedAt: new Date('2030-01-15T01:00:00.000Z')
    }],
    revision: 0
  });
  const workflow = createEquipmentRoutineWorkflowService({ connection: mongoose.connection });
  const supervisorView = await workflow.getException({
    authContext: fixture.contexts.supervisor,
    exceptionId: exception._id,
    query: {}
  });
  assert.equal(supervisorView.accessPolicy.canHandle, true);

  const held = await holdLeaderRestoration({
    authContext: fixture.contexts.supervisor,
    membershipId: managerMembership._id
  });
  const handling = workflow.transitionException({
    authContext: fixture.contexts.supervisor,
    exceptionId: exception._id,
    input: {
      action: 'RESOLVE',
      opinion: 'Supervisor must not win after restoration',
      expectedRevision: 0
    }
  });
  assert.equal(await promiseStateAfterDelay(handling), 'pending');
  held.release();
  const [restorationResult, handlingResult] = await Promise.allSettled([
    held.restoration,
    handling
  ]);
  assert.equal(restorationResult.status, 'fulfilled');
  assert.equal(handlingResult.status, 'rejected');

  const persisted = await EquipmentRoutineException.findById(exception._id).lean();
  assert.equal(persisted.status, 'OPEN');
  assert.equal(persisted.currentStage, 'SUB_DEPARTMENT_MANAGER');
  assert.equal(persisted.revision, 0);
  assert.equal(persisted.history.length, 1);
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

  const exportQuery = {
    routineType: 'INSPECTION',
    equipmentId: String(fixture.asset._id),
    orgUnitId: String(fixture.ids.group),
    overallResult: 'ABNORMAL',
    from: '2030-01-15T00:00:00.000Z',
    to: '2030-01-16T00:00:00.000Z'
  };
  const exported = await workflow.exportRecords({
    authContext: fixture.contexts.manager,
    req: {
      method: 'GET',
      originalUrl: '/api/equipment/routine-records/export?routineType=INSPECTION'
    },
    query: exportQuery
  });
  const workbook = XLSX.read(exported.buffer, { type: 'buffer', cellDates: true });
  const [row] = XLSX.utils.sheet_to_json(workbook.Sheets['点检保养记录'], { defval: '' });
  assert.equal(row['设备名称'], "'=现场设备");
  assert.equal(row['异常摘要'], "'=需要停机检查");
  const exportAudit = await AuditLog.findOne({
    action: permissions.AUDIT_ACTIONS.EXPORT,
    resourceType: permissions.AUDIT_RESOURCE_TYPES.INSPECTION_RECORD
  }).lean();
  assert.ok(exportAudit);
  assert.equal(String(exportAudit.actorUserId), fixture.contexts.manager.userId);
  assert.equal(String(exportAudit.activeTeamId), String(fixture.ids.team));
  assert.equal(String(exportAudit.targetTeamId), String(fixture.ids.team));
  assert.equal(exportAudit.requestMethod, 'GET');
  assert.equal(exportAudit.requestPath, '/api/equipment/routine-records/export');
  assert.equal(exportAudit.after.count, exported.count);
  assert.deepEqual(exportAudit.after.routineTypes, ['INSPECTION']);
  assert.deepEqual(exportAudit.after.filters, {
    routineType: 'INSPECTION',
    equipmentId: String(fixture.asset._id),
    orgUnitId: String(fixture.ids.group),
    overallResult: 'ABNORMAL',
    from: '2030-01-15T00:00:00.000Z',
    to: '2030-01-16T00:00:00.000Z'
  });
});

test('routine record exports classify maintenance and mixed audit resources accurately', async () => {
  const recordBase = {
    teamId: fixture.ids.team,
    orgUnitId: fixture.ids.group,
    equipmentId: fixture.asset._id,
    categoryId: fixture.category._id,
    ruleVersion: 1,
    performedBy: fixture.ids.employee,
    performedAt: new Date('2030-01-15T02:30:00.000Z'),
    itemResults: [{ itemKey: 'check-1', result: 'COMPLETED', note: '' }],
    overallResult: 'COMPLETED'
  };
  await EquipmentRoutineRecord.create({
    ...recordBase,
    ruleId: objectId(),
    ruleSnapshot: { name: '月度保养' },
    routineType: 'MAINTENANCE'
  });

  const workflow = createEquipmentRoutineWorkflowService();
  const maintenanceExport = await workflow.exportRecords({
    authContext: fixture.contexts.manager,
    req: {
      method: 'GET',
      originalUrl: '/api/equipment/routine-records/export?routineType=MAINTENANCE'
    },
    query: { routineType: 'MAINTENANCE' }
  });
  assert.equal(maintenanceExport.count, 1);
  const maintenanceAudit = await AuditLog.findOne({
    action: permissions.AUDIT_ACTIONS.EXPORT,
    resourceType: permissions.AUDIT_RESOURCE_TYPES.MAINTENANCE_RECORD
  }).lean();
  assert.ok(maintenanceAudit);
  assert.deepEqual(maintenanceAudit.after.routineTypes, ['MAINTENANCE']);
  assert.equal(maintenanceAudit.after.filters.routineType, 'MAINTENANCE');

  await EquipmentRoutineRecord.create({
    ...recordBase,
    ruleId: objectId(),
    ruleSnapshot: { name: '班前点检' },
    routineType: 'INSPECTION'
  });
  const mixedExport = await workflow.exportRecords({
    authContext: fixture.contexts.manager,
    req: {
      method: 'GET',
      originalUrl: '/api/equipment/routine-records/export'
    }
  });
  assert.equal(mixedExport.count, 2);
  const mixedAudit = await AuditLog.findOne({
    action: permissions.AUDIT_ACTIONS.EXPORT,
    resourceType: permissions.AUDIT_RESOURCE_TYPES.SYSTEM
  }).lean();
  assert.ok(mixedAudit);
  assert.deepEqual(mixedAudit.after.routineTypes, ['INSPECTION', 'MAINTENANCE']);
  assert.equal(mixedAudit.after.filters.routineType, null);
  assert.equal(await AuditLog.countDocuments({
    action: permissions.AUDIT_ACTIONS.EXPORT,
    resourceType: permissions.AUDIT_RESOURCE_TYPES.INSPECTION_RECORD
  }), 0);
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

  await EquipmentAsset.updateOne(
    { _id: fixture.asset._id },
    { $set: { location: '仓配二分部叉车区' } }
  );
  const locatedRecord = await routineService.createRecord({
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
        locationStatus: 'GRANTED',
        longitude: 117.382989,
        latitude: 36.683908,
        accuracyMeters: 10,
        address: '客户端不得覆盖的地址'
      }]
    }
  });
  assert.equal(locatedRecord.photoEvidence[0].address, '仓配二分部叉车区');
  assert.match(locatedRecord.photoEvidence[0].watermarkText, /设备地点：仓配二分部叉车区/);
  assert.match(locatedRecord.photoEvidence[0].watermarkText, /GPS：36\.683908, 117\.382989/);
  assert.doesNotMatch(locatedRecord.photoEvidence[0].watermarkText, /客户端不得覆盖的地址/);

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
