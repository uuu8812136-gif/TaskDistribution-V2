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
  cycleKeyForCalendar,
  windowBounds
} = require('../../../app/services/equipmentRoutineWorkerService');
const {
  calendarAnchorsAround
} = require('../../../app/services/equipmentRoutineCalendarService');
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
  const majorCategory = await EquipmentCategory.create({
    teamId: ids.team,
    name: '测试设备大类',
    createdBy: ids.departmentManager,
    updatedBy: ids.departmentManager
  });
  const categoryType = await EquipmentCategory.create({
    teamId: ids.team,
    parentId: majorCategory._id,
    name: '测试设备类型',
    createdBy: ids.departmentManager,
    updatedBy: ids.departmentManager
  });
  const category = await EquipmentCategory.create({
    teamId: ids.team,
    parentId: categoryType._id,
    name: '测试设备一级名称',
    createdBy: ids.departmentManager,
    updatedBy: ids.departmentManager
  });
  const asset = await EquipmentAsset.create({
    teamId: ids.team,
    orgUnitId: ids.group,
    categoryId: category._id,
    assetCode: 'EQ-001',
    plateNumber: 'PLATE-EQ-001',
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
  return { ids, majorCategory, categoryType, category, asset, contexts };
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

  const monthlyAnchors = [
    ['2030-02-28T12:00:00.000Z', '2030-02-28T00:00:00.000Z', '2030-03-31T00:00:00.000Z'],
    ['2030-03-31T12:00:00.000Z', '2030-03-31T00:00:00.000Z', '2030-04-30T00:00:00.000Z'],
    ['2030-04-30T12:00:00.000Z', '2030-04-30T00:00:00.000Z', '2030-05-31T00:00:00.000Z']
  ];
  for (const [now, expectedCurrent, expectedNext] of monthlyAnchors) {
    const { current, next } = calendarAnchorsAround(
      new Date('2030-01-31T00:00:00.000Z'),
      'MONTH',
      1,
      new Date(now)
    );
    assert.equal(current.toISOString(), expectedCurrent);
    assert.equal(next.toISOString(), expectedNext);
  }

  const localMonthEndAnchors = [
    ['2030-02-28T12:00:00+08:00', '2030-02-27T16:00:00.000Z', '2030-03-30T16:00:00.000Z'],
    ['2030-03-31T12:00:00+08:00', '2030-03-30T16:00:00.000Z', '2030-04-29T16:00:00.000Z'],
    ['2030-04-30T12:00:00+08:00', '2030-04-29T16:00:00.000Z', '2030-05-30T16:00:00.000Z']
  ];
  for (const [now, expectedCurrent, expectedNext] of localMonthEndAnchors) {
    const { current, next } = calendarAnchorsAround(
      new Date('2030-01-31T00:00:00+08:00'),
      'MONTH',
      1,
      new Date(now),
      'Asia/Shanghai'
    );
    assert.equal(current.toISOString(), expectedCurrent);
    assert.equal(next.toISOString(), expectedNext);
  }
});

test('level-3 primary rules cover secondary-name equipment without crossing primary branches', async () => {
  const now = new Date('2030-01-15T00:00:00.000Z');
  const routineService = createEquipmentRoutineService({ clock: () => now });
  const [secondaryCategory, siblingSecondaryCategory, otherPrimaryCategory] = await Promise.all([
    EquipmentCategory.create({
      teamId: fixture.ids.team,
      parentId: fixture.category._id,
      name: '测试设备二级名称 A',
      createdBy: fixture.ids.departmentManager,
      updatedBy: fixture.ids.departmentManager
    }),
    EquipmentCategory.create({
      teamId: fixture.ids.team,
      parentId: fixture.category._id,
      name: '测试设备二级名称 B',
      createdBy: fixture.ids.departmentManager,
      updatedBy: fixture.ids.departmentManager
    }),
    EquipmentCategory.create({
      teamId: fixture.ids.team,
      parentId: fixture.categoryType._id,
      name: '其他设备一级名称',
      createdBy: fixture.ids.departmentManager,
      updatedBy: fixture.ids.departmentManager
    })
  ]);
  const otherSecondaryCategory = await EquipmentCategory.create({
    teamId: fixture.ids.team,
    parentId: otherPrimaryCategory._id,
    name: '其他设备二级名称',
    createdBy: fixture.ids.departmentManager,
    updatedBy: fixture.ids.departmentManager
  });
  const [secondaryAsset, siblingSecondaryAsset, otherAsset] = await Promise.all([
    EquipmentAsset.create({
      teamId: fixture.ids.team,
      orgUnitId: fixture.ids.group,
      categoryId: secondaryCategory._id,
      assetCode: 'EQ-SECONDARY-A',
      name: 'Secondary equipment A',
      status: EquipmentAsset.EQUIPMENT_STATUSES.IN_USE,
      createdBy: fixture.ids.departmentManager,
      updatedBy: fixture.ids.departmentManager
    }),
    EquipmentAsset.create({
      teamId: fixture.ids.team,
      orgUnitId: fixture.ids.group,
      categoryId: siblingSecondaryCategory._id,
      assetCode: 'EQ-SECONDARY-B',
      name: 'Secondary equipment B',
      status: EquipmentAsset.EQUIPMENT_STATUSES.IN_USE,
      createdBy: fixture.ids.departmentManager,
      updatedBy: fixture.ids.departmentManager
    }),
    EquipmentAsset.create({
      teamId: fixture.ids.team,
      orgUnitId: fixture.ids.group,
      categoryId: otherSecondaryCategory._id,
      assetCode: 'EQ-OTHER-PRIMARY',
      name: 'Other primary equipment',
      status: EquipmentAsset.EQUIPMENT_STATUSES.IN_USE,
      createdBy: fixture.ids.departmentManager,
      updatedBy: fixture.ids.departmentManager
    })
  ]);
  const rule = await createRule(routineService, 'INSPECTION', {
    schedule: {
      mode: 'CALENDAR',
      calendar: { unit: 'DAY', interval: 1, firstDueAt: '2030-01-15T00:00:00.000Z' }
    }
  });
  const legacySecondaryRule = await EquipmentRoutineRule.create({
    teamId: fixture.ids.team,
    categoryId: secondaryCategory._id,
    routineType: 'INSPECTION',
    name: 'Legacy exact secondary rule',
    checklistItems: [{ key: 'legacy-check', name: 'Legacy check' }],
    schedule: {
      mode: 'CALENDAR',
      calendar: { unit: 'DAY', interval: 1, firstDueAt: now }
    },
    status: 'ACTIVE',
    version: 1,
    createdBy: fixture.ids.departmentManager,
    updatedBy: fixture.ids.departmentManager
  });
  const legacyOpenPlan = await EquipmentRoutinePlan.create({
    teamId: fixture.ids.team,
    orgUnitId: fixture.ids.group,
    equipmentId: secondaryAsset._id,
    categoryId: secondaryCategory._id,
    ruleId: legacySecondaryRule._id,
    ruleVersion: legacySecondaryRule.version,
    ruleSnapshot: legacySecondaryRule.toObject(),
    routineType: legacySecondaryRule.routineType,
    cycleKey: 'legacy-secondary-open-plan',
    windowKey: 'DAY_SHIFT',
    windowName: '白班',
    scheduledFor: new Date('2030-01-14T23:00:00.000Z'),
    dueAt: new Date('2030-01-15T01:00:00.000Z'),
    status: EquipmentRoutinePlan.EQUIPMENT_ROUTINE_PLAN_STATUSES.IN_WINDOW
  });
  const worker = createEquipmentRoutineWorkerService({ routineService, clock: () => now });

  await worker.runOnce({ now, teamId: fixture.ids.team });
  const initialPlans = await EquipmentRoutinePlan.find({ ruleId: rule._id }).lean();
  assert.ok(initialPlans.some(({ equipmentId }) => String(equipmentId) === String(fixture.asset._id)));
  assert.ok(initialPlans.some(({ equipmentId }) => String(equipmentId) === String(secondaryAsset._id)));
  assert.ok(initialPlans.some(({ equipmentId }) => String(equipmentId) === String(siblingSecondaryAsset._id)));
  assert.equal(
    initialPlans.some(({ equipmentId }) => String(equipmentId) === String(otherAsset._id)),
    false
  );
  const legacyPlans = await EquipmentRoutinePlan.find({ ruleId: legacySecondaryRule._id }).lean();
  assert.equal(legacyPlans.length, 1);
  assert.equal(legacyPlans[0].status, EquipmentRoutinePlan.EQUIPMENT_ROUTINE_PLAN_STATUSES.CANCELLED);
  assert.equal(
    legacyPlans[0].cancellationReason,
    EquipmentRoutinePlan.EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS.RULE_CATEGORY_INVALID
  );

  await worker.runOnce({ now, teamId: fixture.ids.team });
  assert.equal(await EquipmentRoutinePlan.countDocuments({ ruleId: rule._id }), initialPlans.length);
  assert.equal(
    await EquipmentRoutinePlan.countDocuments({ ruleId: legacySecondaryRule._id }),
    legacyPlans.length
  );

  const secondarySchedule = await routineService.getSchedule({
    authContext: fixture.contexts.manager,
    equipmentId: String(secondaryAsset._id)
  });
  assert.deepEqual(
    secondarySchedule.schedules.map(({ rule: scheduleRule }) => scheduleRule._id),
    [rule._id]
  );
  const siblingSchedule = await routineService.getSchedule({
    authContext: fixture.contexts.manager,
    equipmentId: String(siblingSecondaryAsset._id)
  });
  assert.deepEqual(siblingSchedule.schedules.map(({ rule: scheduleRule }) => scheduleRule._id), [rule._id]);
  const otherSchedule = await routineService.getSchedule({
    authContext: fixture.contexts.manager,
    equipmentId: String(otherAsset._id)
  });
  assert.equal(otherSchedule.schedules.length, 0);
  await assert.rejects(routineService.createRecord({
    authContext: fixture.contexts.manager,
    equipmentId: String(secondaryAsset._id),
    input: {
      ruleId: String(legacySecondaryRule._id),
      planId: String(legacyOpenPlan._id),
      itemResults: [{ itemKey: 'legacy-check', result: 'NORMAL' }]
    }
  }), (error) => error.code === 'EQUIPMENT_ROUTINE_NOT_FOUND');

  const executablePlan = secondarySchedule.schedules
    .find(({ rule: scheduleRule }) => scheduleRule._id === rule._id)
    .plans.find(({ status }) => status === EquipmentRoutinePlan.EQUIPMENT_ROUTINE_PLAN_STATUSES.IN_WINDOW);
  const record = await routineService.createRecord({
    authContext: fixture.contexts.manager,
    equipmentId: String(secondaryAsset._id),
    input: {
      ruleId: rule._id,
      planId: executablePlan._id,
      itemResults: [{ itemKey: rule.checklistItems[0].key, result: 'NORMAL' }]
    }
  });
  assert.equal(record.ruleId, rule._id);
  assert.equal(record.equipmentId, String(secondaryAsset._id));

  const openPlanIdsBeforeMove = (await EquipmentRoutinePlan.find({
    ruleId: rule._id,
    equipmentId: secondaryAsset._id,
    status: { $in: [
      EquipmentRoutinePlan.EQUIPMENT_ROUTINE_PLAN_STATUSES.PLANNED,
      EquipmentRoutinePlan.EQUIPMENT_ROUTINE_PLAN_STATUSES.IN_WINDOW,
      EquipmentRoutinePlan.EQUIPMENT_ROUTINE_PLAN_STATUSES.OVERDUE
    ] }
  }).select('_id').lean()).map(({ _id }) => _id);
  assert.ok(openPlanIdsBeforeMove.length > 0);
  secondaryCategory.parentId = otherPrimaryCategory._id;
  await secondaryCategory.save();
  await worker.runOnce({ now, teamId: fixture.ids.team });
  const movedPlans = await EquipmentRoutinePlan.find({
    ruleId: rule._id,
    equipmentId: secondaryAsset._id
  }).lean();
  assert.ok(movedPlans.some(({ status }) => status === EquipmentRoutinePlan.EQUIPMENT_ROUTINE_PLAN_STATUSES.COMPLETED));
  const cancelledMovedPlans = await EquipmentRoutinePlan.find({
    _id: { $in: openPlanIdsBeforeMove }
  }).lean();
  assert.equal(cancelledMovedPlans.length, openPlanIdsBeforeMove.length);
  assert.ok(cancelledMovedPlans.every(({ status, cancellationReason }) => (
    status === EquipmentRoutinePlan.EQUIPMENT_ROUTINE_PLAN_STATUSES.CANCELLED &&
    cancellationReason === EquipmentRoutinePlan.EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS.EQUIPMENT_CATEGORY_CHANGED
  )));
});

test('worker closes open plans for disabled legacy secondary rules without changing completed history', async () => {
  const now = new Date('2030-01-15T00:00:00.000Z');
  const secondaryCategory = await EquipmentCategory.create({
    teamId: fixture.ids.team,
    parentId: fixture.category._id,
    name: '停用历史规则二级名称',
    createdBy: fixture.ids.departmentManager,
    updatedBy: fixture.ids.departmentManager
  });
  const secondaryAsset = await EquipmentAsset.create({
    teamId: fixture.ids.team,
    orgUnitId: fixture.ids.group,
    categoryId: secondaryCategory._id,
    assetCode: 'EQ-DISABLED-LEGACY-RULE',
    name: 'Disabled legacy rule equipment',
    status: EquipmentAsset.EQUIPMENT_STATUSES.IN_USE,
    createdBy: fixture.ids.departmentManager,
    updatedBy: fixture.ids.departmentManager
  });
  const legacyRule = await EquipmentRoutineRule.create({
    teamId: fixture.ids.team,
    categoryId: secondaryCategory._id,
    routineType: 'INSPECTION',
    name: 'Disabled legacy secondary rule',
    checklistItems: [{ key: 'legacy-disabled', name: 'Legacy disabled check' }],
    schedule: {
      mode: 'CALENDAR',
      calendar: { unit: 'DAY', interval: 1, firstDueAt: now }
    },
    status: 'DISABLED',
    version: 1,
    createdBy: fixture.ids.departmentManager,
    updatedBy: fixture.ids.departmentManager
  });
  const commonPlan = {
    teamId: fixture.ids.team,
    orgUnitId: fixture.ids.group,
    equipmentId: secondaryAsset._id,
    categoryId: secondaryCategory._id,
    ruleId: legacyRule._id,
    ruleVersion: legacyRule.version,
    ruleSnapshot: legacyRule.toObject(),
    routineType: legacyRule.routineType,
    windowKey: 'DAY_SHIFT',
    windowName: '白班',
    scheduledFor: new Date('2030-01-14T23:00:00.000Z'),
    dueAt: new Date('2030-01-15T01:00:00.000Z')
  };
  const openPlan = await EquipmentRoutinePlan.create({
    ...commonPlan,
    cycleKey: 'disabled-legacy-open',
    status: EquipmentRoutinePlan.EQUIPMENT_ROUTINE_PLAN_STATUSES.IN_WINDOW
  });
  const completedPlan = await EquipmentRoutinePlan.create({
    ...commonPlan,
    cycleKey: 'disabled-legacy-completed',
    status: EquipmentRoutinePlan.EQUIPMENT_ROUTINE_PLAN_STATUSES.COMPLETED,
    completedRecordId: objectId(),
    completedAt: now,
    completedBy: fixture.ids.employee
  });
  const worker = createEquipmentRoutineWorkerService({ clock: () => now });

  await worker.runOnce({ now, teamId: fixture.ids.team });
  const cancelled = await EquipmentRoutinePlan.findById(openPlan._id).lean();
  assert.equal(cancelled.status, EquipmentRoutinePlan.EQUIPMENT_ROUTINE_PLAN_STATUSES.CANCELLED);
  assert.equal(
    cancelled.cancellationReason,
    EquipmentRoutinePlan.EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS.RULE_CATEGORY_INVALID
  );
  assert.equal(
    (await EquipmentRoutinePlan.findById(completedPlan._id).lean()).status,
    EquipmentRoutinePlan.EQUIPMENT_ROUTINE_PLAN_STATUSES.COMPLETED
  );

  await worker.runOnce({ now, teamId: fixture.ids.team });
  assert.equal(await EquipmentRoutinePlan.countDocuments({ ruleId: legacyRule._id }), 2);
  assert.equal(
    (await EquipmentRoutinePlan.findById(openPlan._id).lean()).cancellationReason,
    EquipmentRoutinePlan.EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS.RULE_CATEGORY_INVALID
  );
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

test('worker reconciles missing current calendar plans in and after the window without reviving closed plans', async () => {
  const withinWindow = new Date('2030-01-15T00:00:00.000Z');
  const afterWindow = new Date('2030-01-15T02:30:00.000Z');
  const routineService = createEquipmentRoutineService({ clock: () => withinWindow });
  const rule = await createRule(routineService, 'INSPECTION', {
    schedule: {
      mode: 'CALENDAR',
      calendar: { unit: 'DAY', interval: 1, firstDueAt: '2030-01-15T00:00:00.000Z' }
    }
  });
  const worker = createEquipmentRoutineWorkerService({ routineService, clock: () => withinWindow });

  await worker.runOnce({ now: withinWindow, teamId: fixture.ids.team });
  const initialPlans = await EquipmentRoutinePlan.find({ ruleId: rule._id })
    .sort({ scheduledFor: 1, windowKey: 1 })
    .lean();
  assert.equal(initialPlans.length, 4, 'current and next daily cycles must cover both enabled windows');
  const currentDayPlan = initialPlans.find(({ windowKey, scheduledFor }) => (
    windowKey === 'DAY_SHIFT' && scheduledFor <= withinWindow
  ));
  assert.equal(currentDayPlan.status, 'IN_WINDOW');

  await EquipmentRoutinePlan.collection.deleteOne({ _id: currentDayPlan._id });
  await worker.runOnce({ now: withinWindow, teamId: fixture.ids.team });
  const restoredInWindow = await EquipmentRoutinePlan.findOne({
    ruleId: rule._id,
    cycleKey: currentDayPlan.cycleKey,
    windowKey: currentDayPlan.windowKey
  }).lean();
  assert.ok(restoredInWindow);
  assert.equal(restoredInWindow.status, 'IN_WINDOW');

  await EquipmentRoutinePlan.collection.deleteOne({ _id: restoredInWindow._id });
  await worker.runOnce({ now: afterWindow, teamId: fixture.ids.team });
  const restoredOverdue = await EquipmentRoutinePlan.findOne({
    ruleId: rule._id,
    cycleKey: currentDayPlan.cycleKey,
    windowKey: currentDayPlan.windowKey
  }).lean();
  assert.ok(restoredOverdue);
  assert.equal(restoredOverdue.status, 'OVERDUE');
  assert.equal(await EquipmentRoutinePlan.countDocuments({ ruleId: rule._id }), 4);

  const currentNightPlan = await EquipmentRoutinePlan.findOne({
    ruleId: rule._id,
    cycleKey: currentDayPlan.cycleKey,
    windowKey: 'NIGHT_SHIFT'
  }).lean();
  const scheduleChangedPlan = await EquipmentRoutinePlan.findOne({
    ruleId: rule._id,
    scheduledFor: { $gt: afterWindow },
    windowKey: 'DAY_SHIFT'
  }).lean();
  await EquipmentRoutinePlan.collection.updateOne({ _id: restoredOverdue._id }, {
    $set: {
      status: 'COMPLETED',
      completedRecordId: objectId(),
      completedAt: afterWindow,
      completedBy: fixture.ids.employee
    }
  });
  await EquipmentRoutinePlan.collection.updateOne({ _id: currentNightPlan._id }, {
    $set: {
      status: 'CANCELLED',
      cancellationReason: 'REST_DAY',
      cancelledAt: afterWindow,
      cancelledBy: fixture.ids.employee
    }
  });
  await EquipmentRoutinePlan.collection.updateOne({ _id: scheduleChangedPlan._id }, {
    $set: {
      status: 'CANCELLED',
      cancellationReason: 'SCHEDULE_CHANGED',
      cancelledAt: afterWindow,
      cancelledBy: fixture.ids.departmentManager
    }
  });

  await worker.runOnce({ now: afterWindow, teamId: fixture.ids.team });
  await worker.runOnce({ now: afterWindow, teamId: fixture.ids.team });
  assert.equal((await EquipmentRoutinePlan.findById(restoredOverdue._id).lean()).status, 'COMPLETED');
  const stillCancelled = await EquipmentRoutinePlan.findById(currentNightPlan._id).lean();
  assert.equal(stillCancelled.status, 'CANCELLED');
  assert.equal(stillCancelled.cancellationReason, 'REST_DAY');
  const stillScheduleChanged = await EquipmentRoutinePlan.findById(scheduleChangedPlan._id).lean();
  assert.equal(stillScheduleChanged.status, 'CANCELLED');
  assert.equal(stillScheduleChanged.cancellationReason, 'SCHEDULE_CHANGED');
  assert.equal(stillScheduleChanged.rematerializationCount, 0);
  assert.deepEqual(stillScheduleChanged.rematerializationHistory, []);
  assert.equal(await EquipmentRoutinePlan.countDocuments({ ruleId: rule._id }), 4);
  assert.equal(await EquipmentRoutinePlan.countDocuments({
    ruleId: rule._id,
    ruleVersion: rule.version,
    cycleKey: currentDayPlan.cycleKey,
    windowKey: currentDayPlan.windowKey
  }), 1);

  await EquipmentRoutinePlan.collection.deleteOne({ _id: currentNightPlan._id });
  await worker.runOnce({ now: afterWindow, teamId: fixture.ids.team });
  assert.equal(await EquipmentRoutinePlan.countDocuments({
    ruleId: rule._id,
    cycleKey: currentDayPlan.cycleKey,
    windowKey: 'NIGHT_SHIFT'
  }), 0, 'a missing sibling must not be rebuilt after the cycle has a completed plan');
});

test('planless submission creates the canonical worker window and never creates a future window early', async () => {
  let currentTime = new Date('2030-01-15T01:00:00.000Z');
  const routineService = createEquipmentRoutineService({
    clock: () => new Date(currentTime)
  });
  const rule = await createRule(routineService, 'INSPECTION', {
    windows: [{
      key: 'LATE_SHIFT',
      name: '晚开始窗口',
      startTime: '11:00',
      endTime: '12:00',
      enabled: true
    }],
    schedule: {
      mode: 'CALENDAR',
      calendar: { unit: 'DAY', interval: 1, firstDueAt: '2030-01-15T00:00:00.000Z' }
    }
  });
  const submission = {
    ruleId: rule._id,
    itemResults: [{ itemKey: rule.checklistItems[0].key, result: 'NORMAL' }]
  };

  await assert.rejects(routineService.createRecord({
    authContext: fixture.contexts.manager,
    equipmentId: String(fixture.asset._id),
    input: { ...submission, idempotencyKey: 'canonical-future-window-blocked' }
  }), (error) => error.status === 409 && error.code === 'EQUIPMENT_ROUTINE_PLAN_NOT_STARTED');
  assert.equal(await EquipmentRoutinePlan.countDocuments({ ruleId: rule._id }), 0);
  assert.equal(await EquipmentRoutineRecord.countDocuments({ ruleId: rule._id }), 0);

  currentTime = new Date('2030-01-15T03:30:00.000Z');
  const record = await routineService.createRecord({
    authContext: fixture.contexts.manager,
    equipmentId: String(fixture.asset._id),
    input: { ...submission, idempotencyKey: 'canonical-window-created' }
  });
  const plan = await EquipmentRoutinePlan.findById(record.planId).lean();
  assert.equal(plan.cycleKey, 'calendar:2030-01-15T00:00:00.000Z');
  assert.equal(plan.windowKey, 'LATE_SHIFT');
  assert.equal(plan.windowName, '晚开始窗口');
  assert.equal(plan.scheduledFor.toISOString(), '2030-01-15T03:00:00.000Z');
  assert.equal(plan.dueAt.toISOString(), '2030-01-15T04:00:00.000Z');
  assert.equal(plan.status, 'COMPLETED');
  assert.doesNotMatch(plan.cycleKey, /^submission:/);
  assert.notEqual(plan.windowKey, 'PERIOD');
});

test('planless overdue completion prevents worker from rebuilding same-cycle windows', async () => {
  const now = new Date('2030-01-17T02:30:00.000Z');
  const routineService = createEquipmentRoutineService({ clock: () => new Date(now) });
  const rule = await createRule(routineService, 'INSPECTION', {
    schedule: {
      mode: 'CALENDAR',
      calendar: { unit: 'DAY', interval: 1, firstDueAt: '2030-01-15T00:00:00.000Z' }
    }
  });
  const record = await routineService.createRecord({
    authContext: fixture.contexts.manager,
    equipmentId: String(fixture.asset._id),
    input: {
      ruleId: rule._id,
      itemResults: [{ itemKey: rule.checklistItems[0].key, result: 'NORMAL' }],
      idempotencyKey: 'canonical-overdue-before-worker'
    }
  });
  const completedPlan = await EquipmentRoutinePlan.findById(record.planId).lean();
  assert.equal(completedPlan.cycleKey, 'calendar:2030-01-17T00:00:00.000Z');
  assert.equal(completedPlan.windowKey, 'DAY_SHIFT');
  assert.equal(completedPlan.status, 'COMPLETED');

  const worker = createEquipmentRoutineWorkerService({ routineService, clock: () => new Date(now) });
  await worker.runOnce({ now, teamId: fixture.ids.team });
  const sameCyclePlans = await EquipmentRoutinePlan.find({
    ruleId: rule._id,
    cycleKey: completedPlan.cycleKey
  }).lean();
  assert.deepEqual(
    sameCyclePlans.map(({ _id, status }) => [String(_id), status]),
    [[String(completedPlan._id), 'COMPLETED']]
  );
  assert.equal(await EquipmentRoutinePlan.countDocuments({
    ruleId: rule._id,
    cycleKey: completedPlan.cycleKey,
    status: { $in: ['PLANNED', 'IN_WINDOW', 'OVERDUE'] }
  }), 0);
  assert.ok((await EquipmentRoutinePlan.find({ ruleId: rule._id }).lean()).every(({ cycleKey, windowKey }) => (
    !cycleKey.startsWith('submission:') && windowKey !== 'PERIOD'
  )));
});

test('monthly worker identities remain anchored to the original month-end date', async () => {
  let currentTime = new Date('2030-02-28T02:00:00.000Z');
  const routineService = createEquipmentRoutineService({
    clock: () => new Date(currentTime)
  });
  const rule = await createRule(routineService, 'INSPECTION', {
    monthlyDay: 31,
    windows: [{
      key: 'MONTH_END',
      name: '月末窗口',
      startTime: '07:00',
      endTime: '09:00',
      enabled: true
    }],
    schedule: {
      mode: 'CALENDAR',
      calendar: { unit: 'MONTH', interval: 1, firstDueAt: '2030-01-30T16:00:00.000Z' }
    }
  });
  const worker = createEquipmentRoutineWorkerService({
    routineService,
    clock: () => new Date(currentTime)
  });

  for (const instant of [
    '2030-02-28T02:00:00.000Z',
    '2030-03-31T02:00:00.000Z',
    '2030-04-30T02:00:00.000Z'
  ]) {
    currentTime = new Date(instant);
    await worker.runOnce({ now: currentTime, teamId: fixture.ids.team });
    await worker.runOnce({ now: currentTime, teamId: fixture.ids.team });
  }

  const plans = await EquipmentRoutinePlan.find({ ruleId: rule._id })
    .sort({ cycleKey: 1 })
    .lean();
  assert.deepEqual(plans.map(({ cycleKey }) => cycleKey), [
    'calendar:2030-02-27T16:00:00.000Z',
    'calendar:2030-03-30T16:00:00.000Z',
    'calendar:2030-04-29T16:00:00.000Z',
    'calendar:2030-05-30T16:00:00.000Z'
  ]);
  assert.ok(plans.every(({ windowKey }) => windowKey === 'MONTH_END'));
  assert.equal(await EquipmentRoutinePlan.countDocuments({ ruleId: rule._id }), 4);
});

test('inspection keeps the fixed calendar cadence while maintenance rolls from actual completion', async () => {
  const now = new Date('2030-02-28T04:00:00.000Z');
  const routineService = createEquipmentRoutineService({ clock: () => new Date(now) });
  const common = {
    monthlyDay: 31,
    windows: [{
      key: 'MONTH_END',
      name: '月末窗口',
      startTime: '00:00',
      endTime: '23:59',
      enabled: true
    }],
    schedule: {
      mode: 'CALENDAR',
      calendar: { unit: 'MONTH', interval: 1, firstDueAt: '2030-01-30T16:00:00.000Z' }
    }
  };
  const inspectionRule = await createRule(routineService, 'INSPECTION', common);
  const maintenanceRule = await createRule(routineService, 'MAINTENANCE', common);
  const worker = createEquipmentRoutineWorkerService({ routineService, clock: () => new Date(now) });
  await worker.runOnce({ now, teamId: fixture.ids.team });

  const [inspectionPlan, maintenancePlan] = await Promise.all([
    EquipmentRoutinePlan.findOne({
      ruleId: inspectionRule._id,
      scheduledFor: { $lte: now },
      status: { $in: ['IN_WINDOW', 'OVERDUE'] }
    }).sort({ dueAt: 1 }).lean(),
    EquipmentRoutinePlan.findOne({
      ruleId: maintenanceRule._id,
      scheduledFor: { $lte: now },
      status: { $in: ['IN_WINDOW', 'OVERDUE'] }
    }).sort({ dueAt: 1 }).lean()
  ]);
  assert.ok(inspectionPlan);
  assert.ok(maintenancePlan);

  await routineService.createRecord({
    authContext: fixture.contexts.manager,
    equipmentId: String(fixture.asset._id),
    input: {
      ruleId: inspectionRule._id,
      planId: inspectionPlan._id,
      itemResults: [{ itemKey: inspectionRule.checklistItems[0].key, result: 'NORMAL' }],
      idempotencyKey: 'inspection-fixed-month-end-cadence'
    }
  });
  await routineService.createRecord({
    authContext: fixture.contexts.manager,
    equipmentId: String(fixture.asset._id),
    input: {
      ruleId: maintenanceRule._id,
      planId: maintenancePlan._id,
      itemResults: [{ itemKey: maintenanceRule.checklistItems[0].key, result: 'COMPLETED' }],
      idempotencyKey: 'maintenance-rolling-month-end-cadence'
    }
  });

  const schedules = await routineService.getSchedule({
    authContext: fixture.contexts.manager,
    equipmentId: String(fixture.asset._id)
  });
  const byRuleId = new Map(schedules.schedules.map((entry) => [entry.rule._id, entry]));
  assert.equal(
    new Date(byRuleId.get(String(inspectionRule._id)).nextDueAt).toISOString(),
    '2030-03-30T16:00:00.000Z'
  );
  assert.equal(
    new Date(byRuleId.get(String(maintenanceRule._id)).nextDueAt).toISOString(),
    '2030-03-28T04:00:00.000Z'
  );
});

test('worker rematerializes category-change cancellations after an A-B-A category move for every schedule mode', async () => {
  const now = new Date('2030-01-15T02:30:00.000Z');
  const routineService = createEquipmentRoutineService({ clock: () => now });
  const [movingSecondaryCategory, otherPrimaryCategory] = await Promise.all([
    EquipmentCategory.create({
      teamId: fixture.ids.team,
      parentId: fixture.category._id,
      name: 'A-B-A worker secondary category',
      createdBy: fixture.ids.departmentManager,
      updatedBy: fixture.ids.departmentManager
    }),
    EquipmentCategory.create({
      teamId: fixture.ids.team,
      parentId: fixture.categoryType._id,
      name: 'A-B-A worker other primary category',
      createdBy: fixture.ids.departmentManager,
      updatedBy: fixture.ids.departmentManager
    })
  ]);
  await EquipmentAsset.updateOne({ _id: fixture.asset._id }, {
    $set: { categoryId: movingSecondaryCategory._id }
  });
  await routineService.createRuntimeReading({
    authContext: fixture.contexts.manager,
    equipmentId: String(fixture.asset._id),
    input: { hours: 100, reason: 'A-B-A worker runtime baseline' }
  });
  const rules = [
    await createRule(routineService, 'INSPECTION', {
      schedule: {
        mode: 'CALENDAR',
        calendar: { unit: 'DAY', interval: 1, firstDueAt: '2030-01-15T00:00:00.000Z' }
      }
    }),
    await createRule(routineService, 'MAINTENANCE', {
      schedule: { mode: 'RUNTIME_HOURS', runtime: { intervalHours: 25 } }
    }),
    await createRule(routineService, 'INSPECTION', {
      schedule: {
        mode: 'COMBINED',
        calendar: { unit: 'DAY', interval: 1, firstDueAt: '2030-01-15T00:00:00.000Z' },
        runtime: { intervalHours: 25 },
        duePolicy: 'ANY'
      }
    })
  ];
  await routineService.createRuntimeReading({
    authContext: fixture.contexts.manager,
    equipmentId: String(fixture.asset._id),
    input: { hours: 150, reason: 'A-B-A worker due reading' }
  });
  const worker = createEquipmentRoutineWorkerService({ routineService, clock: () => now });

  await worker.runOnce({ now, teamId: fixture.ids.team });
  const ruleIds = rules.map(({ _id }) => _id);
  const initialPlans = await EquipmentRoutinePlan.find({
    ruleId: { $in: ruleIds },
    equipmentId: fixture.asset._id
  }).sort({ ruleId: 1, cycleKey: 1, windowKey: 1 }).lean();
  assert.ok(initialPlans.length >= rules.length);
  for (const rule of rules) {
    assert.ok(initialPlans.some(({ ruleId }) => String(ruleId) === String(rule._id)));
  }

  await EquipmentCategory.updateOne({ _id: movingSecondaryCategory._id }, {
    $set: { parentId: otherPrimaryCategory._id }
  });
  await worker.runOnce({ now, teamId: fixture.ids.team });
  const cancelledPlans = await EquipmentRoutinePlan.find({
    _id: { $in: initialPlans.map(({ _id }) => _id) }
  }).lean();
  assert.ok(cancelledPlans.every(({ status, cancellationReason }) => (
    status === 'CANCELLED' && cancellationReason === 'EQUIPMENT_CATEGORY_CHANGED'
  )));

  await EquipmentCategory.updateOne({ _id: movingSecondaryCategory._id }, {
    $set: { parentId: fixture.category._id }
  });
  await worker.runOnce({ now, teamId: fixture.ids.team });
  const rematerializedPlans = await EquipmentRoutinePlan.find({
    _id: { $in: initialPlans.map(({ _id }) => _id) }
  }).sort({ ruleId: 1, cycleKey: 1, windowKey: 1 }).lean();
  assert.equal(rematerializedPlans.length, initialPlans.length);
  assert.ok(rematerializedPlans.every(({ status }) => (
    ['PLANNED', 'IN_WINDOW', 'OVERDUE'].includes(status)
  )));
  for (const plan of rematerializedPlans) {
    assert.equal(plan.cancellationReason, null);
    assert.equal(plan.cancelledAt, null);
    assert.equal(plan.cancelledBy, null);
    assert.equal(plan.rematerializationCount, 1);
    assert.equal(plan.rematerializationHistory.length, 1);
    const [event] = plan.rematerializationHistory;
    assert.equal(event.cancellationReason, 'EQUIPMENT_CATEGORY_CHANGED');
    assert.equal(event.cancelledAt.toISOString(), now.toISOString());
    assert.equal(event.cancelledBy, null);
    assert.equal(event.rematerializedAt.toISOString(), now.toISOString());
    assert.equal(event.rematerializedBy, null);
    assert.equal(event.source, 'WORKER');
  }
  assert.equal(
    await EquipmentRoutinePlan.countDocuments({ ruleId: { $in: ruleIds } }),
    initialPlans.length,
    'rematerialization must reuse the original cycle/window identities'
  );

  await worker.runOnce({ now, teamId: fixture.ids.team });
  assert.equal(await EquipmentRoutinePlan.countDocuments({ ruleId: { $in: ruleIds } }), initialPlans.length);
  assert.equal(await EquipmentRoutinePlan.countDocuments({
    ruleId: { $in: ruleIds },
    rematerializationCount: 1
  }), initialPlans.length);
});

test('manual submission rematerializes only category-change cancellations after returning to primary A', async () => {
  const now = new Date('2030-01-15T02:30:00.000Z');
  const routineService = createEquipmentRoutineService({ clock: () => now });
  const [movingSecondaryCategory, otherPrimaryCategory] = await Promise.all([
    EquipmentCategory.create({
      teamId: fixture.ids.team,
      parentId: fixture.category._id,
      name: 'A-B-A submission secondary category',
      createdBy: fixture.ids.departmentManager,
      updatedBy: fixture.ids.departmentManager
    }),
    EquipmentCategory.create({
      teamId: fixture.ids.team,
      parentId: fixture.categoryType._id,
      name: 'A-B-A submission other primary category',
      createdBy: fixture.ids.departmentManager,
      updatedBy: fixture.ids.departmentManager
    })
  ]);
  await EquipmentAsset.updateOne({ _id: fixture.asset._id }, {
    $set: { categoryId: movingSecondaryCategory._id }
  });
  await routineService.createRuntimeReading({
    authContext: fixture.contexts.manager,
    equipmentId: String(fixture.asset._id),
    input: { hours: 100, reason: 'A-B-A submission runtime baseline' }
  });
  const recoverableRule = await createRule(routineService, 'MAINTENANCE', {
    schedule: { mode: 'RUNTIME_HOURS', runtime: { intervalHours: 25 } }
  });
  const protectedRule = await createRule(routineService, 'MAINTENANCE', {
    schedule: { mode: 'RUNTIME_HOURS', runtime: { intervalHours: 25 } }
  });
  await routineService.createRuntimeReading({
    authContext: fixture.contexts.manager,
    equipmentId: String(fixture.asset._id),
    input: { hours: 150, reason: 'A-B-A submission due reading' }
  });
  const worker = createEquipmentRoutineWorkerService({ routineService, clock: () => now });
  await worker.runOnce({ now, teamId: fixture.ids.team });
  const [recoverablePlan, protectedPlan] = await Promise.all([
    EquipmentRoutinePlan.findOne({ ruleId: recoverableRule._id }).lean(),
    EquipmentRoutinePlan.findOne({ ruleId: protectedRule._id }).lean()
  ]);
  assert.ok(recoverablePlan);
  assert.ok(protectedPlan);

  await EquipmentCategory.updateOne({ _id: movingSecondaryCategory._id }, {
    $set: { parentId: otherPrimaryCategory._id }
  });
  await worker.runOnce({ now, teamId: fixture.ids.team });
  await EquipmentRoutinePlan.updateOne({ _id: protectedPlan._id }, {
    $set: { cancellationReason: 'RULE_UPDATED' }
  });
  await EquipmentCategory.updateOne({ _id: movingSecondaryCategory._id }, {
    $set: { parentId: fixture.category._id }
  });

  const completedRecord = await routineService.createRecord({
    authContext: fixture.contexts.manager,
    equipmentId: String(fixture.asset._id),
    input: {
      ruleId: recoverableRule._id,
      runtimeHours: 150,
      itemResults: [{
        itemKey: recoverableRule.checklistItems[0].key,
        result: 'COMPLETED'
      }],
      idempotencyKey: 'category-change-submission-rematerialization'
    }
  });
  assert.equal(String(completedRecord.planId), String(recoverablePlan._id));
  const completedPlan = await EquipmentRoutinePlan.findById(recoverablePlan._id).lean();
  assert.equal(completedPlan.status, 'COMPLETED');
  assert.equal(completedPlan.cancellationReason, null);
  assert.equal(completedPlan.rematerializationCount, 1);
  assert.equal(completedPlan.rematerializationHistory.length, 1);
  assert.equal(completedPlan.rematerializationHistory[0].cancellationReason, 'EQUIPMENT_CATEGORY_CHANGED');
  assert.equal(completedPlan.rematerializationHistory[0].source, 'SUBMISSION');
  assert.equal(
    String(completedPlan.rematerializationHistory[0].rematerializedBy),
    String(fixture.ids.departmentManager)
  );
  const serializedCompletedPlan = await createEquipmentRoutineWorkflowService({
    clock: () => now
  }).getPlan({
    authContext: fixture.contexts.manager,
    planId: String(completedPlan._id)
  });
  assert.equal(serializedCompletedPlan.rematerializationCount, 1);
  assert.equal(serializedCompletedPlan.rematerializationHistory.length, 1);
  assert.equal(serializedCompletedPlan.rematerializationHistory[0].source, 'SUBMISSION');
  assert.equal(
    serializedCompletedPlan.rematerializationHistory[0].rematerializedBy,
    String(fixture.ids.departmentManager)
  );

  await assert.rejects(routineService.createRecord({
    authContext: fixture.contexts.manager,
    equipmentId: String(fixture.asset._id),
    input: {
      ruleId: protectedRule._id,
      runtimeHours: 150,
      itemResults: [{
        itemKey: protectedRule.checklistItems[0].key,
        result: 'COMPLETED'
      }],
      idempotencyKey: 'non-category-cancellation-must-not-rematerialize'
    }
  }), (error) => error.status === 409 && error.code === 'EQUIPMENT_ROUTINE_NOT_DUE');
  const stillProtected = await EquipmentRoutinePlan.findById(protectedPlan._id).lean();
  assert.equal(stillProtected.status, 'CANCELLED');
  assert.equal(stillProtected.cancellationReason, 'RULE_UPDATED');
  assert.equal(stillProtected.rematerializationCount, 0);
  assert.deepEqual(stillProtected.rematerializationHistory, []);
});

test('planless submissions reuse exact worker identities across every due mode and never bypass closed or future plans', async () => {
  const now = new Date('2030-01-15T02:30:00.000Z');
  const routineService = createEquipmentRoutineService({ clock: () => now });
  const [movingSecondaryCategory, otherPrimaryCategory] = await Promise.all([
    EquipmentCategory.create({
      teamId: fixture.ids.team,
      parentId: fixture.category._id,
      name: 'Planless exact identity secondary',
      createdBy: fixture.ids.departmentManager,
      updatedBy: fixture.ids.departmentManager
    }),
    EquipmentCategory.create({
      teamId: fixture.ids.team,
      parentId: fixture.categoryType._id,
      name: 'Planless exact identity other primary',
      createdBy: fixture.ids.departmentManager,
      updatedBy: fixture.ids.departmentManager
    })
  ]);
  await EquipmentAsset.updateOne({ _id: fixture.asset._id }, {
    $set: { categoryId: movingSecondaryCategory._id }
  });
  await routineService.createRuntimeReading({
    authContext: fixture.contexts.manager,
    equipmentId: String(fixture.asset._id),
    input: { hours: 100, reason: 'Planless exact identity baseline' }
  });

  const calendar = { unit: 'DAY', interval: 1, firstDueAt: '2030-01-15T00:00:00.000Z' };
  const rules = {
    calendar: await createRule(routineService, 'INSPECTION', {
      schedule: { mode: 'CALENDAR', calendar }
    }),
    combinedAnyCalendar: await createRule(routineService, 'INSPECTION', {
      schedule: {
        mode: 'COMBINED',
        calendar,
        runtime: { intervalHours: 1000 },
        duePolicy: 'ANY'
      }
    }),
    combinedAll: await createRule(routineService, 'INSPECTION', {
      schedule: {
        mode: 'COMBINED',
        calendar,
        runtime: { intervalHours: 25 },
        duePolicy: 'ALL'
      }
    }),
    runtime: await createRule(routineService, 'MAINTENANCE', {
      schedule: { mode: 'RUNTIME_HOURS', runtime: { intervalHours: 25 } }
    }),
    combinedAnyRuntime: await createRule(routineService, 'INSPECTION', {
      schedule: {
        mode: 'COMBINED',
        calendar: {
          unit: 'DAY',
          interval: 1,
          firstDueAt: '2030-01-16T02:30:00.000Z'
        },
        runtime: { intervalHours: 25 },
        duePolicy: 'ANY'
      }
    }),
    futureCategoryChanged: await createRule(routineService, 'INSPECTION', {
      windows: [{
        key: 'LATE_SHIFT',
        name: 'Late shift',
        startTime: '11:00',
        endTime: '12:00',
        enabled: true
      }],
      schedule: { mode: 'CALENDAR', calendar }
    }),
    futureProtected: await createRule(routineService, 'INSPECTION', {
      windows: [{
        key: 'LATE_SHIFT',
        name: 'Late shift',
        startTime: '11:00',
        endTime: '12:00',
        enabled: true
      }],
      schedule: { mode: 'CALENDAR', calendar }
    }),
    currentProtected: await createRule(routineService, 'INSPECTION', {
      schedule: { mode: 'CALENDAR', calendar }
    }),
    completedCurrent: await createRule(routineService, 'INSPECTION', {
      schedule: { mode: 'CALENDAR', calendar }
    })
  };
  await routineService.createRuntimeReading({
    authContext: fixture.contexts.manager,
    equipmentId: String(fixture.asset._id),
    input: { hours: 150, reason: 'Planless exact identity due reading' }
  });
  const worker = createEquipmentRoutineWorkerService({ routineService, clock: () => now });
  await worker.runOnce({ now, teamId: fixture.ids.team });

  const originalPlans = new Map();
  for (const [key, rule] of Object.entries(rules)) {
    originalPlans.set(key, await EquipmentRoutinePlan.find({
      ruleId: rule._id,
      equipmentId: fixture.asset._id
    }).sort({ scheduledFor: 1, dueAt: 1, _id: 1 }).lean());
    assert.ok(originalPlans.get(key).length > 0, `${key} must have worker plans`);
  }
  const startedPlan = (key) => originalPlans.get(key)
    .filter(({ scheduledFor }) => new Date(scheduledFor) <= now)
    .sort((left, right) => (
      new Date(left.dueAt) - new Date(right.dueAt) ||
      String(left._id).localeCompare(String(right._id))
    ))[0];
  for (const key of [
    'calendar',
    'combinedAnyCalendar',
    'combinedAll',
    'runtime',
    'combinedAnyRuntime',
    'currentProtected',
    'completedCurrent'
  ]) {
    assert.ok(startedPlan(key), `${key} must have a started plan`);
  }
  assert.equal(startedPlan('futureCategoryChanged'), undefined);
  assert.equal(startedPlan('futureProtected'), undefined);

  await EquipmentCategory.updateOne({ _id: movingSecondaryCategory._id }, {
    $set: { parentId: otherPrimaryCategory._id }
  });
  await worker.runOnce({ now, teamId: fixture.ids.team });
  await EquipmentCategory.updateOne({ _id: movingSecondaryCategory._id }, {
    $set: { parentId: fixture.category._id }
  });

  await EquipmentRoutinePlan.updateMany({
    ruleId: rules.futureProtected._id
  }, {
    $set: { cancellationReason: 'RULE_UPDATED' }
  });
  await EquipmentRoutinePlan.updateOne({
    _id: startedPlan('currentProtected')._id
  }, {
    $set: { cancellationReason: 'RULE_UPDATED' }
  });
  await EquipmentRoutinePlan.collection.updateOne({
    _id: startedPlan('completedCurrent')._id
  }, {
    $set: {
      status: 'COMPLETED',
      cancellationReason: null,
      cancelledAt: null,
      cancelledBy: null,
      completedRecordId: objectId(),
      completedAt: now,
      completedBy: fixture.ids.departmentManager
    }
  });

  const submitWithoutPlan = (key, sequence) => {
    const rule = rules[key];
    const input = {
      ruleId: rule._id,
      itemResults: [{
        itemKey: rule.checklistItems[0].key,
        result: rule.routineType === 'MAINTENANCE' ? 'COMPLETED' : 'NORMAL'
      }],
      idempotencyKey: `planless-exact-${sequence}`
    };
    if (['RUNTIME_HOURS', 'COMBINED'].includes(rule.schedule.mode)) input.runtimeHours = 150;
    return routineService.createRecord({
      authContext: fixture.contexts.manager,
      equipmentId: String(fixture.asset._id),
      input
    });
  };
  for (const [sequence, key] of [
    [1, 'calendar'],
    [2, 'combinedAnyCalendar'],
    [3, 'combinedAll'],
    [4, 'runtime'],
    [5, 'combinedAnyRuntime']
  ]) {
    const record = await submitWithoutPlan(key, sequence);
    const original = startedPlan(key);
    assert.equal(String(record.planId), String(original._id), `${key} must reuse the original _id`);
    const completed = await EquipmentRoutinePlan.findById(original._id).lean();
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(completed.cancellationReason, null);
    assert.equal(completed.cycleKey, original.cycleKey);
    assert.equal(completed.windowKey, original.windowKey);
    assert.equal(completed.rematerializationCount, 1);
    assert.equal(completed.rematerializationHistory[0].source, 'SUBMISSION');
    assert.equal(
      await EquipmentRoutinePlan.countDocuments({ ruleId: rules[key]._id }),
      originalPlans.get(key).length,
      `${key} must not create an ad-hoc plan`
    );
  }

  for (const [key, expectedCode] of [
    ['futureCategoryChanged', 'EQUIPMENT_ROUTINE_PLAN_NOT_STARTED'],
    ['futureProtected', 'EQUIPMENT_ROUTINE_PLAN_NOT_STARTED'],
    ['currentProtected', 'EQUIPMENT_ROUTINE_NOT_DUE'],
    ['completedCurrent', 'EQUIPMENT_ROUTINE_NOT_DUE']
  ]) {
    await assert.rejects(
      submitWithoutPlan(key, `blocked-${key}`),
      (error) => error.status === 409 && error.code === expectedCode
    );
    assert.equal(
      await EquipmentRoutinePlan.countDocuments({ ruleId: rules[key]._id }),
      originalPlans.get(key).length,
      `${key} must not create a replacement plan`
    );
  }
  const untouchedFuture = await EquipmentRoutinePlan.find({
    ruleId: rules.futureCategoryChanged._id
  }).lean();
  assert.ok(untouchedFuture.every(({ status, cancellationReason, rematerializationCount }) => (
    status === 'CANCELLED' &&
    cancellationReason === 'EQUIPMENT_CATEGORY_CHANGED' &&
    rematerializationCount === 0
  )));
  const protectedFuture = await EquipmentRoutinePlan.find({
    ruleId: rules.futureProtected._id
  }).lean();
  assert.ok(protectedFuture.every(({ status, cancellationReason, rematerializationCount }) => (
    status === 'CANCELLED' && cancellationReason === 'RULE_UPDATED' && rematerializationCount === 0
  )));
});

test('COMBINED ANY worker keeps the original runtime identity when calendar becomes due during an A-B-A move', async () => {
  let currentTime = new Date('2030-01-15T02:30:00.000Z');
  const routineService = createEquipmentRoutineService({ clock: () => new Date(currentTime) });
  const [movingSecondaryCategory, otherPrimaryCategory] = await Promise.all([
    EquipmentCategory.create({
      teamId: fixture.ids.team,
      parentId: fixture.category._id,
      name: 'Combined ANY runtime owner secondary',
      createdBy: fixture.ids.departmentManager,
      updatedBy: fixture.ids.departmentManager
    }),
    EquipmentCategory.create({
      teamId: fixture.ids.team,
      parentId: fixture.categoryType._id,
      name: 'Combined ANY runtime owner other primary',
      createdBy: fixture.ids.departmentManager,
      updatedBy: fixture.ids.departmentManager
    })
  ]);
  await EquipmentAsset.updateOne({ _id: fixture.asset._id }, {
    $set: { categoryId: movingSecondaryCategory._id }
  });
  await routineService.createRuntimeReading({
    authContext: fixture.contexts.manager,
    equipmentId: String(fixture.asset._id),
    input: { hours: 100, reason: 'Combined ANY runtime owner baseline' }
  });
  const rule = await createRule(routineService, 'INSPECTION', {
    schedule: {
      mode: 'COMBINED',
      calendar: {
        unit: 'DAY',
        interval: 1,
        firstDueAt: '2030-01-15T04:00:00.000Z'
      },
      runtime: { intervalHours: 25 },
      duePolicy: 'ANY'
    }
  });
  await routineService.createRuntimeReading({
    authContext: fixture.contexts.manager,
    equipmentId: String(fixture.asset._id),
    input: { hours: 150, reason: 'Combined ANY runtime owner trigger' }
  });
  const worker = createEquipmentRoutineWorkerService({
    routineService,
    clock: () => new Date(currentTime)
  });
  await worker.runOnce({ now: currentTime, teamId: fixture.ids.team });
  const original = await EquipmentRoutinePlan.findOne({ ruleId: rule._id }).lean();
  assert.ok(original);
  assert.equal(original.windowKey, 'RUNTIME');

  await EquipmentCategory.updateOne({ _id: movingSecondaryCategory._id }, {
    $set: { parentId: otherPrimaryCategory._id }
  });
  await worker.runOnce({ now: currentTime, teamId: fixture.ids.team });
  assert.equal((await EquipmentRoutinePlan.findById(original._id).lean()).status, 'CANCELLED');

  currentTime = new Date('2030-01-15T05:00:00.000Z');
  await EquipmentCategory.updateOne({ _id: movingSecondaryCategory._id }, {
    $set: { parentId: fixture.category._id }
  });
  await worker.runOnce({ now: currentTime, teamId: fixture.ids.team });
  const recovered = await EquipmentRoutinePlan.findById(original._id).lean();
  assert.equal(recovered.status, 'OVERDUE');
  assert.equal(recovered.windowKey, 'RUNTIME');
  assert.equal(recovered.cycleKey, original.cycleKey);
  assert.equal(recovered.rematerializationCount, 1);
  assert.equal(recovered.rematerializationHistory[0].source, 'WORKER');
  assert.equal(await EquipmentRoutinePlan.countDocuments({ ruleId: rule._id }), 1);
});

test('worker reconciles a missing cross-midnight maintenance window and advances only after completion', async () => {
  let currentTime = new Date('2030-01-15T16:00:00.000Z');
  const routineService = createEquipmentRoutineService({ clock: () => new Date(currentTime) });
  const rule = await createRule(routineService, 'MAINTENANCE', {
    windows: [{
      key: 'CROSS_MIDNIGHT',
      name: 'Cross-midnight maintenance',
      startTime: '22:00',
      endTime: '02:00',
      enabled: true
    }],
    schedule: {
      mode: 'CALENDAR',
      calendar: { unit: 'DAY', interval: 1, firstDueAt: '2030-01-15T00:00:00.000Z' }
    }
  });
  const worker = createEquipmentRoutineWorkerService({
    routineService,
    clock: () => new Date(currentTime)
  });

  await worker.runOnce({ now: currentTime, teamId: fixture.ids.team });
  let plan = await EquipmentRoutinePlan.findOne({ ruleId: rule._id }).lean();
  assert.ok(plan);
  assert.equal(plan.status, 'IN_WINDOW');
  assert.equal(plan.scheduledFor.toISOString(), '2030-01-15T14:00:00.000Z');
  assert.equal(plan.dueAt.toISOString(), '2030-01-15T18:00:00.000Z');

  await EquipmentRoutinePlan.collection.deleteOne({ _id: plan._id });
  await worker.runOnce({ now: currentTime, teamId: fixture.ids.team });
  plan = await EquipmentRoutinePlan.findOne({ ruleId: rule._id }).lean();
  assert.equal(plan.status, 'IN_WINDOW');

  await EquipmentRoutinePlan.collection.deleteOne({ _id: plan._id });
  currentTime = new Date('2030-01-15T19:00:00.000Z');
  await worker.runOnce({ now: currentTime, teamId: fixture.ids.team });
  plan = await EquipmentRoutinePlan.findOne({ ruleId: rule._id }).lean();
  assert.equal(plan.status, 'OVERDUE');
  await worker.runOnce({ now: currentTime, teamId: fixture.ids.team });
  assert.equal(await EquipmentRoutinePlan.countDocuments({
    ruleId: rule._id,
    cycleKey: plan.cycleKey,
    windowKey: plan.windowKey
  }), 1);

  await routineService.createRecord({
    authContext: fixture.contexts.manager,
    equipmentId: fixture.asset._id,
    input: {
      ruleId: rule._id,
      planId: plan._id,
      itemResults: [{ itemKey: rule.checklistItems[0].key, result: 'COMPLETED' }],
      idempotencyKey: 'cross-midnight-maintenance-completed'
    }
  });
  await worker.runOnce({ now: currentTime, teamId: fixture.ids.team });
  assert.equal((await EquipmentRoutinePlan.findById(plan._id).lean()).status, 'COMPLETED');
  assert.equal(await EquipmentRoutinePlan.countDocuments({
    ruleId: rule._id,
    cycleKey: plan.cycleKey,
    windowKey: plan.windowKey
  }), 1);
  assert.ok(await EquipmentRoutinePlan.findOne({
    ruleId: rule._id,
    cycleKey: { $ne: plan.cycleKey },
    status: { $in: ['PLANNED', 'IN_WINDOW', 'OVERDUE'] }
  }));
});

test('worker reconciliation keeps team, equipment status, and asset identities isolated', async () => {
  const now = new Date('2030-01-15T00:00:00.000Z');
  const routineService = createEquipmentRoutineService({ clock: () => now });
  const rule = await createRule(routineService, 'INSPECTION', {
    schedule: {
      mode: 'CALENDAR',
      calendar: { unit: 'DAY', interval: 1, firstDueAt: '2030-01-15T00:00:00.000Z' }
    }
  });
  const secondActiveAsset = await EquipmentAsset.create({
    teamId: fixture.ids.team,
    orgUnitId: fixture.ids.group,
    categoryId: fixture.category._id,
    assetCode: 'EQ-002',
    name: 'Second active equipment',
    status: EquipmentAsset.EQUIPMENT_STATUSES.IN_USE,
    createdBy: fixture.ids.departmentManager,
    updatedBy: fixture.ids.departmentManager
  });
  const stoppedAsset = await EquipmentAsset.create({
    teamId: fixture.ids.team,
    orgUnitId: fixture.ids.group,
    categoryId: fixture.category._id,
    assetCode: 'EQ-STOPPED',
    name: 'Stopped equipment',
    status: EquipmentAsset.EQUIPMENT_STATUSES.STOPPED,
    createdBy: fixture.ids.departmentManager,
    updatedBy: fixture.ids.departmentManager
  });
  const otherOrgUnit = await OrgUnit.create({
    teamId: fixture.ids.otherTeam,
    parentId: null,
    type: permissions.ORG_UNIT_TYPES.DEPARTMENT,
    code: 'OTHER_DEPT',
    name: 'Other department',
    status: permissions.ORG_UNIT_STATUSES.ACTIVE,
    sortOrder: 0,
    level: 1,
    path: '/'
  });
  const otherCategory = await EquipmentCategory.create({
    teamId: fixture.ids.otherTeam,
    name: 'Other team equipment',
    createdBy: fixture.ids.otherUser,
    updatedBy: fixture.ids.otherUser
  });
  const otherAsset = await EquipmentAsset.create({
    teamId: fixture.ids.otherTeam,
    orgUnitId: otherOrgUnit._id,
    categoryId: otherCategory._id,
    assetCode: 'OTHER-EQ-001',
    name: 'Other team equipment',
    status: EquipmentAsset.EQUIPMENT_STATUSES.IN_USE,
    createdBy: fixture.ids.otherUser,
    updatedBy: fixture.ids.otherUser
  });
  const otherRule = await EquipmentRoutineRule.create({
    teamId: fixture.ids.otherTeam,
    categoryId: otherCategory._id,
    routineType: rule.routineType,
    name: 'Other team daily inspection',
    checklistItems: rule.checklistItems,
    schedule: rule.schedule,
    status: 'ACTIVE',
    version: 1,
    photoPolicy: rule.photoPolicy,
    abnormalNoteRequired: rule.abnormalNoteRequired,
    executionConfig: rule.executionConfig,
    createdBy: fixture.ids.otherUser,
    updatedBy: fixture.ids.otherUser
  });
  const worker = createEquipmentRoutineWorkerService({ routineService, clock: () => now });

  await worker.runOnce({ now, teamId: fixture.ids.team });
  const currentTeamPlans = await EquipmentRoutinePlan.find({ ruleId: rule._id }).lean();
  assert.deepEqual(
    new Set(currentTeamPlans.map(({ equipmentId }) => String(equipmentId))),
    new Set([String(fixture.asset._id), String(secondActiveAsset._id)])
  );
  assert.equal(currentTeamPlans.some(({ equipmentId }) => String(equipmentId) === String(stoppedAsset._id)), false);
  assert.equal(await EquipmentRoutinePlan.countDocuments({
    teamId: fixture.ids.otherTeam,
    ruleId: otherRule._id,
    equipmentId: otherAsset._id
  }), 0);

  await worker.runOnce({ now, teamId: fixture.ids.team });
  assert.equal(await EquipmentRoutinePlan.countDocuments({ ruleId: rule._id }), currentTeamPlans.length);
});

test('worker waits for a concurrent rule update and never materializes the stale rule version', async () => {
  const now = new Date('2030-01-15T00:00:00.000Z');
  const routineService = createEquipmentRoutineService({ clock: () => now });
  const rule = await createRule(routineService, 'INSPECTION', {
    schedule: {
      mode: 'CALENDAR',
      calendar: { unit: 'DAY', interval: 1, firstDueAt: '2030-01-15T00:00:00.000Z' }
    }
  });
  const worker = createEquipmentRoutineWorkerService({ routineService, clock: () => now });
  const updateSession = await mongoose.startSession();
  let workerRun;
  try {
    updateSession.startTransaction();
    const update = await EquipmentRoutineRule.updateOne({
      _id: rule._id,
      version: 1
    }, {
      $set: { version: 2, updatedBy: fixture.ids.departmentManager }
    }, { session: updateSession });
    assert.equal(update.modifiedCount, 1);

    workerRun = worker.runOnce({ now, teamId: fixture.ids.team });
    assert.equal(await promiseStateAfterDelay(workerRun), 'pending');
    await updateSession.commitTransaction();
  } catch (error) {
    if (updateSession.inTransaction()) await updateSession.abortTransaction();
    throw error;
  } finally {
    await updateSession.endSession();
  }

  const staleRun = await workerRun;
  assert.equal(staleRun.plansProcessed, 0);
  assert.equal(await EquipmentRoutinePlan.countDocuments({
    ruleId: rule._id,
    ruleVersion: 1
  }), 0);
  await worker.runOnce({ now, teamId: fixture.ids.team });
  const currentPlans = await EquipmentRoutinePlan.find({ ruleId: rule._id }).lean();
  assert.ok(currentPlans.length > 0);
  assert.ok(currentPlans.every(({ ruleVersion, cycleKey }) => (
    ruleVersion === 2 && cycleKey.startsWith('calendar:v2:')
  )));
});

test('worker waits for a concurrent STOPPED transition and does not create plans for the equipment', async () => {
  const now = new Date('2030-01-15T00:00:00.000Z');
  const routineService = createEquipmentRoutineService({ clock: () => now });
  const rule = await createRule(routineService, 'MAINTENANCE', {
    schedule: {
      mode: 'CALENDAR',
      calendar: { unit: 'DAY', interval: 1, firstDueAt: '2030-01-15T00:00:00.000Z' }
    }
  });
  const worker = createEquipmentRoutineWorkerService({ routineService, clock: () => now });
  const statusSession = await mongoose.startSession();
  let workerRun;
  try {
    statusSession.startTransaction();
    const update = await EquipmentAsset.collection.updateOne({
      _id: fixture.asset._id,
      status: EquipmentAsset.EQUIPMENT_STATUSES.IN_USE
    }, {
      $set: {
        status: EquipmentAsset.EQUIPMENT_STATUSES.STOPPED,
        updatedBy: fixture.ids.departmentManager
      }
    }, { session: statusSession });
    assert.equal(update.modifiedCount, 1);

    workerRun = worker.runOnce({ now, teamId: fixture.ids.team });
    assert.equal(await promiseStateAfterDelay(workerRun), 'pending');
    await statusSession.commitTransaction();
  } catch (error) {
    if (statusSession.inTransaction()) await statusSession.abortTransaction();
    throw error;
  } finally {
    await statusSession.endSession();
  }

  const completedRun = await workerRun;
  assert.equal(completedRun.plansProcessed, 0);
  assert.equal((await EquipmentAsset.findById(fixture.asset._id).lean()).status, 'STOPPED');
  assert.equal(await EquipmentRoutinePlan.countDocuments({
    ruleId: rule._id,
    equipmentId: fixture.asset._id
  }), 0);
});

test('worker re-resolves the primary subtree inside the transaction after outer candidate discovery', async () => {
  const now = new Date('2030-01-15T00:00:00.000Z');
  const routineService = createEquipmentRoutineService({ clock: () => now });
  const [secondaryCategory, otherPrimaryCategory] = await Promise.all([
    EquipmentCategory.create({
      teamId: fixture.ids.team,
      parentId: fixture.category._id,
      name: 'Concurrent secondary category',
      createdBy: fixture.ids.departmentManager,
      updatedBy: fixture.ids.departmentManager
    }),
    EquipmentCategory.create({
      teamId: fixture.ids.team,
      parentId: fixture.categoryType._id,
      name: 'Concurrent other primary',
      createdBy: fixture.ids.departmentManager,
      updatedBy: fixture.ids.departmentManager
    })
  ]);
  const secondaryAsset = await EquipmentAsset.create({
    teamId: fixture.ids.team,
    orgUnitId: fixture.ids.group,
    categoryId: secondaryCategory._id,
    assetCode: 'EQ-CONCURRENT-REPARENT',
    name: 'Concurrent reparent equipment',
    status: EquipmentAsset.EQUIPMENT_STATUSES.IN_USE,
    createdBy: fixture.ids.departmentManager,
    updatedBy: fixture.ids.departmentManager
  });
  const rule = await createRule(routineService, 'INSPECTION', {
    schedule: {
      mode: 'CALENDAR',
      calendar: { unit: 'DAY', interval: 1, firstDueAt: now }
    }
  });
  let categoryMoved = false;
  const EquipmentAssetModel = new Proxy(EquipmentAsset, {
    get(target, property) {
      if (property === 'find') {
        return (filter) => {
          const query = target.find(filter);
          if (!categoryMoved && filter?.categoryId?.$in && filter?.status === 'IN_USE') {
            const lean = query.lean.bind(query);
            query.lean = async (...args) => {
              const assets = await lean(...args);
              await EquipmentCategory.updateOne({ _id: secondaryCategory._id }, {
                $set: { parentId: otherPrimaryCategory._id }
              });
              categoryMoved = true;
              return assets;
            };
          }
          return query;
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  const worker = createEquipmentRoutineWorkerService({
    EquipmentAssetModel,
    routineService,
    clock: () => now
  });

  await worker.runOnce({ now, teamId: fixture.ids.team });
  assert.equal(categoryMoved, true);
  assert.equal(await EquipmentRoutinePlan.countDocuments({
    ruleId: rule._id,
    equipmentId: secondaryAsset._id
  }), 0);
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
  assert.equal(new Date(record.scheduledFor).toISOString(), oldPlan.scheduledFor.toISOString());
  assert.equal(new Date(record.planScheduledFor).toISOString(), oldPlan.scheduledFor.toISOString());
  assert.equal(new Date(record.planDueAt).toISOString(), oldPlan.dueAt.toISOString());
  assert.equal(record.planWindowName, oldPlan.windowName);
  assert.equal(record.planCycleKey, oldPlan.cycleKey);
  assert.equal((await EquipmentRoutinePlan.findById(oldPlan._id).lean()).status, 'COMPLETED');
  assert.equal((await EquipmentRoutinePlan.findById(newerPlan._id).lean()).status, 'OVERDUE');

  const listed = await routineService.listRecords({ authContext: fixture.contexts.manager });
  const listedRecord = listed.records.find(({ _id }) => _id === record._id);
  assert.equal(listedRecord.equipment.plateNumber, 'PLATE-EQ-001');
  assert.equal(new Date(listedRecord.planScheduledFor).toISOString(), oldPlan.scheduledFor.toISOString());
  assert.equal(new Date(listedRecord.planDueAt).toISOString(), oldPlan.dueAt.toISOString());
  assert.equal(listedRecord.plan._id, String(oldPlan._id));

  const detail = await routineService.getRecord({
    authContext: fixture.contexts.employee,
    recordId: record._id
  });
  assert.equal(detail.equipment.plateNumber, 'PLATE-EQ-001');
  assert.equal(detail.planId, String(oldPlan._id));
  assert.equal(detail.performedByUser._id, String(fixture.ids.departmentManager));
  assert.equal(detail.performedByName, 'department-manager');
  assert.equal(detail.itemResults[0].itemKey, rule.checklistItems[0].key);
  assert.equal(detail.ruleSnapshot.name, rule.name);
});

test('record submission rejects non-IN_USE equipment and stale rule-version plans', async () => {
  const now = new Date('2030-01-15T01:00:00.000Z');
  const routineService = createEquipmentRoutineService({ clock: () => now });
  const rule = await createRule(routineService, 'INSPECTION', { schedule: { mode: 'MANUAL' } });
  const submission = {
    ruleId: String(rule._id),
    itemResults: [{ itemKey: rule.checklistItems[0].key, result: 'NORMAL' }]
  };

  await EquipmentAsset.updateOne({ _id: fixture.asset._id }, {
    $set: { status: EquipmentAsset.EQUIPMENT_STATUSES.STOPPED }
  });
  await assert.rejects(routineService.createRecord({
    authContext: fixture.contexts.manager,
    equipmentId: String(fixture.asset._id),
    input: { ...submission, idempotencyKey: 'stopped-equipment-submission' }
  }), (error) => (
    error.status === 409 && error.code === 'EQUIPMENT_ROUTINE_EQUIPMENT_NOT_IN_USE'
  ));
  assert.equal(await EquipmentRoutineRecord.countDocuments({ ruleId: rule._id }), 0);

  await EquipmentAsset.updateOne({ _id: fixture.asset._id }, {
    $set: { status: EquipmentAsset.EQUIPMENT_STATUSES.IN_USE }
  });
  await EquipmentRoutineRule.updateOne({ _id: rule._id }, { $set: { version: 2 } });
  const stalePlan = await EquipmentRoutinePlan.create({
    teamId: fixture.ids.team,
    orgUnitId: fixture.asset.orgUnitId,
    equipmentId: fixture.asset._id,
    categoryId: fixture.category._id,
    ruleId: rule._id,
    ruleVersion: 1,
    ruleSnapshot: rule,
    routineType: rule.routineType,
    cycleKey: 'forged-stale-rule-version-plan',
    windowKey: 'DAY_SHIFT',
    windowName: '白班',
    scheduledFor: new Date('2030-01-15T00:00:00.000Z'),
    dueAt: new Date('2030-01-15T02:00:00.000Z'),
    status: 'IN_WINDOW'
  });
  await assert.rejects(routineService.createRecord({
    authContext: fixture.contexts.manager,
    equipmentId: String(fixture.asset._id),
    input: {
      ...submission,
      planId: String(stalePlan._id),
      idempotencyKey: 'stale-rule-version-plan-submission'
    }
  }), (error) => (
    error.status === 409 && error.code === 'EQUIPMENT_ROUTINE_PLAN_NOT_OPEN'
  ));
  assert.equal((await EquipmentRoutinePlan.findById(stalePlan._id).lean()).status, 'IN_WINDOW');
  assert.equal(await EquipmentRoutineRecord.countDocuments({ ruleId: rule._id }), 0);
});

test('record submission replays the same idempotency key without duplicating history', async () => {
  const now = new Date('2030-01-15T01:00:00.000Z');
  const routineService = createEquipmentRoutineService({ clock: () => now });
  const rule = await createRule(routineService, 'MAINTENANCE', { schedule: { mode: 'MANUAL' } });
  const plan = await EquipmentRoutinePlan.create({
    teamId: fixture.ids.team,
    orgUnitId: fixture.asset.orgUnitId,
    equipmentId: fixture.asset._id,
    categoryId: fixture.category._id,
    ruleId: rule._id,
    ruleVersion: rule.version,
    ruleSnapshot: rule,
    routineType: rule.routineType,
    cycleKey: 'idempotent-record-replay',
    windowKey: 'MAINTENANCE',
    windowName: '保养窗口',
    scheduledFor: new Date('2030-01-15T00:00:00.000Z'),
    dueAt: new Date('2030-01-15T02:00:00.000Z'),
    status: 'IN_WINDOW'
  });
  const input = {
    ruleId: String(rule._id),
    planId: String(plan._id),
    itemResults: [{ itemKey: rule.checklistItems[0].key, result: 'COMPLETED' }],
    idempotencyKey: 'same-record-submission'
  };

  const first = await routineService.createRecord({
    authContext: fixture.contexts.manager,
    equipmentId: String(fixture.asset._id),
    input
  });
  const replay = await routineService.createRecord({
    authContext: fixture.contexts.manager,
    equipmentId: String(fixture.asset._id),
    input
  });

  assert.equal(replay._id, first._id);
  assert.equal(replay.planId, first.planId);
  assert.equal(await EquipmentRoutineRecord.countDocuments({
    teamId: fixture.ids.team,
    idempotencyKey: input.idempotencyKey
  }), 1);
  const completedPlan = await EquipmentRoutinePlan.findById(plan._id).lean();
  assert.equal(completedPlan.status, 'COMPLETED');
  assert.equal(String(completedPlan.completedRecordId), first._id);
});

test('record detail resolves legacy plan windows without mutating append-only history and hides other teams', async () => {
  const routineService = createEquipmentRoutineService();
  const rule = await createRule(routineService, 'INSPECTION', { schedule: { mode: 'MANUAL' } });
  const plan = await EquipmentRoutinePlan.create({
    teamId: fixture.ids.team,
    orgUnitId: fixture.asset.orgUnitId,
    equipmentId: fixture.asset._id,
    categoryId: fixture.category._id,
    ruleId: rule._id,
    ruleVersion: rule.version,
    ruleSnapshot: rule,
    routineType: rule.routineType,
    cycleKey: 'legacy-record-plan-window',
    windowKey: 'DAY_SHIFT',
    windowName: 'Day shift',
    scheduledFor: new Date('2030-01-15T00:00:00.000Z'),
    dueAt: new Date('2030-01-15T02:00:00.000Z'),
    status: 'OVERDUE'
  });
  const recordId = objectId();
  await EquipmentRoutineRecord.collection.insertOne({
    _id: recordId,
    teamId: fixture.ids.team,
    orgUnitId: fixture.asset.orgUnitId,
    equipmentId: fixture.asset._id,
    categoryId: fixture.category._id,
    ruleId: new mongoose.Types.ObjectId(rule._id),
    ruleVersion: rule.version,
    ruleSnapshot: rule,
    planId: plan._id,
    routineType: rule.routineType,
    scheduledFor: plan.dueAt,
    performedBy: fixture.ids.employee,
    performedAt: new Date('2030-01-15T01:00:00.000Z'),
    itemResults: [{ itemKey: rule.checklistItems[0].key, result: 'NORMAL', note: '' }],
    overallResult: 'NORMAL',
    abnormalSummary: '',
    photoFileIds: [],
    photoEvidence: [],
    createdAt: new Date('2030-01-15T01:00:00.000Z'),
    updatedAt: new Date('2030-01-15T01:00:00.000Z')
  });

  const detail = await routineService.getRecord({
    authContext: fixture.contexts.manager,
    recordId
  });
  assert.equal(new Date(detail.scheduledFor).toISOString(), plan.scheduledFor.toISOString());
  assert.equal(new Date(detail.planScheduledFor).toISOString(), plan.scheduledFor.toISOString());
  assert.equal(new Date(detail.planDueAt).toISOString(), plan.dueAt.toISOString());
  assert.equal(detail.planWindowName, plan.windowName);
  assert.equal(detail.planCycleKey, plan.cycleKey);
  const persisted = await EquipmentRoutineRecord.collection.findOne({ _id: recordId });
  assert.equal(persisted.scheduledFor.toISOString(), plan.dueAt.toISOString());
  assert.equal(Object.prototype.hasOwnProperty.call(persisted, 'planScheduledFor'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(persisted, 'planDueAt'), false);

  const otherTeamRecordId = objectId();
  await EquipmentRoutineRecord.collection.insertOne({
    ...persisted,
    _id: otherTeamRecordId,
    teamId: fixture.ids.otherTeam,
    orgUnitId: objectId(),
    equipmentId: objectId(),
    categoryId: objectId(),
    ruleId: objectId(),
    planId: null
  });
  await assert.rejects(routineService.getRecord({
    authContext: fixture.contexts.manager,
    recordId: otherTeamRecordId
  }), (error) => error.status === 404 && error.code === 'EQUIPMENT_ROUTINE_NOT_FOUND');

  const global = globalContext(fixture.ids.departmentManager);
  await assert.rejects(routineService.getRecord({
    authContext: global,
    requestedTeamId: String(fixture.ids.team),
    query: { teamId: String(fixture.ids.team) },
    recordId: otherTeamRecordId
  }), (error) => error.status === 404 && error.code === 'EQUIPMENT_ROUTINE_NOT_FOUND');
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
  assert.equal(new Date(completedDaily.nextDueAt).toISOString(), '2030-01-16T00:00:00.000Z');
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

test('legacy planless inspection history cannot reopen completed day week or month periods', async () => {
  const now = new Date('2030-01-15T02:30:00.000Z');
  const firstDueAt = new Date('2030-01-15T00:00:00.000Z');
  const routineService = createEquipmentRoutineService({ clock: () => now });
  const cases = [
    ['DAY', '2030-01-16T00:00:00.000Z'],
    ['WEEK', '2030-01-22T00:00:00.000Z'],
    ['MONTH', '2030-02-15T00:00:00.000Z']
  ];
  const rules = [];

  for (const [unit, expectedNextDueAt] of cases) {
    const rule = await createRule(routineService, 'INSPECTION', {
      windows: [{
        key: 'DAY_SHIFT',
        name: 'Day shift',
        startTime: '07:00',
        endTime: '09:00',
        enabled: true
      }],
      schedule: {
        mode: 'CALENDAR',
        calendar: {
          unit,
          interval: 1,
          firstDueAt
        }
      }
    });
    await EquipmentRoutineRecord.create({
      teamId: fixture.ids.team,
      orgUnitId: fixture.asset.orgUnitId,
      equipmentId: fixture.asset._id,
      categoryId: fixture.asset.categoryId,
      ruleId: rule._id,
      ruleVersion: rule.version,
      ruleSnapshot: rule,
      planId: null,
      routineType: rule.routineType,
      performedBy: fixture.ids.departmentManager,
      performedAt: now,
      itemResults: [{
        itemKey: rule.checklistItems[0].key,
        result: 'NORMAL'
      }],
      overallResult: 'NORMAL',
      idempotencyKey: `legacy-planless-${unit.toLowerCase()}`
    });
    rules.push({ unit, expectedNextDueAt, rule });
  }

  const worker = createEquipmentRoutineWorkerService({ routineService, clock: () => now });
  await worker.runOnce({ now, teamId: fixture.ids.team });

  for (const { unit, expectedNextDueAt, rule } of rules) {
    const schedule = await routineService.calculateRuleSchedule(rule, fixture.asset, { now });
    assert.equal(new Date(schedule.nextDueAt).toISOString(), expectedNextDueAt);
    const generatedPlans = await EquipmentRoutinePlan.find({ ruleId: rule._id }).lean();
    assert.ok(generatedPlans.length > 0);
    assert.equal(
      generatedPlans.some(({ cycleKey }) => (
        cycleKey === cycleKeyForCalendar(firstDueAt, rule.version)
      )),
      false,
      `${unit} worker must not recreate the completed historical period`
    );
    assert.ok(
      generatedPlans.some(({ cycleKey }) => (
        cycleKey === cycleKeyForCalendar(new Date(expectedNextDueAt), rule.version)
      )),
      `${unit} worker must materialize the next valid period`
    );

    const staleOpenPlan = await EquipmentRoutinePlan.create({
      teamId: fixture.ids.team,
      orgUnitId: fixture.asset.orgUnitId,
      equipmentId: fixture.asset._id,
      categoryId: fixture.asset.categoryId,
      ruleId: rule._id,
      ruleVersion: rule.version,
      ruleSnapshot: rule,
      routineType: rule.routineType,
      cycleKey: cycleKeyForCalendar(firstDueAt, rule.version),
      windowKey: 'DAY_SHIFT',
      windowName: 'Day shift',
      scheduledFor: new Date('2030-01-14T23:00:00.000Z'),
      dueAt: new Date('2030-01-15T01:00:00.000Z'),
      status: 'OVERDUE'
    });
    const submission = (idempotencyKey, planId = null) => ({
      ruleId: String(rule._id),
      ...(planId ? { planId: String(planId) } : {}),
      itemResults: [{
        itemKey: rule.checklistItems[0].key,
        result: 'NORMAL'
      }],
      idempotencyKey
    });

    for (const [suffix, planId] of [
      ['planless', null],
      ['explicit-open', staleOpenPlan._id]
    ]) {
      await assert.rejects(routineService.createRecord({
        authContext: fixture.contexts.manager,
        equipmentId: String(fixture.asset._id),
        input: submission(`legacy-${unit.toLowerCase()}-${suffix}`, planId)
      }), (error) => (
        error.status === 409 && error.code === 'EQUIPMENT_ROUTINE_PERIOD_COMPLETED'
      ));
    }

    await EquipmentRoutinePlan.updateOne({ _id: staleOpenPlan._id }, {
      $set: { status: 'CANCELLED' }
    });
    await assert.rejects(routineService.createRecord({
      authContext: fixture.contexts.manager,
      equipmentId: String(fixture.asset._id),
      input: submission(`legacy-${unit.toLowerCase()}-explicit-closed`, staleOpenPlan._id)
    }), (error) => (
      error.status === 409 && error.code === 'EQUIPMENT_ROUTINE_PLAN_NOT_OPEN'
    ));
    assert.equal(await EquipmentRoutineRecord.countDocuments({ ruleId: rule._id }), 1);
  }
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

  const completedPlan = await EquipmentRoutinePlan.create({
    teamId: fixture.ids.team,
    orgUnitId: fixture.asset.orgUnitId,
    equipmentId: fixture.asset._id,
    categoryId: fixture.category._id,
    ruleId: rule._id,
    ruleVersion: rule.version,
    ruleSnapshot: rule,
    routineType: rule.routineType,
    cycleKey: 'historical-completed-before-rule-update',
    windowKey: 'HISTORICAL',
    windowName: 'Historical completed window',
    scheduledFor: new Date('2029-12-15T00:00:00.000Z'),
    dueAt: new Date('2029-12-15T02:00:00.000Z'),
    status: 'COMPLETED',
    completedRecordId: objectId(),
    completedAt: new Date('2029-12-15T01:00:00.000Z'),
    completedBy: fixture.ids.employee
  });
  const openBeforeUpdate = versionOnePlans;
  assert.ok(openBeforeUpdate.length > 0);

  const updatedRule = await routineService.updateRule({
    authContext: fixture.contexts.manager,
    ruleId: String(rule._id),
    input: {
      executionConfig: {
        ...rule.executionConfig,
        windows: rule.executionConfig.windows.map((window) => ({
          ...window,
          startTime: '07:30',
          endTime: '09:30'
        }))
      }
    }
  });
  assert.equal(updatedRule.version, 2);
  assert.equal((await EquipmentRoutinePlan.findById(completedPlan._id).lean()).status, 'COMPLETED');
  assert.ok((await EquipmentRoutinePlan.find({
    _id: { $in: openBeforeUpdate.map(({ _id }) => _id) }
  }).lean()).every(({ status, cancellationReason, cancelledAt, cancelledBy }) => (
    status === 'CANCELLED' &&
    cancellationReason === 'SCHEDULE_CHANGED' &&
    cancelledAt?.toISOString() === now.toISOString() &&
    String(cancelledBy) === String(fixture.ids.departmentManager)
  )));

  const cancelledListing = await createEquipmentRoutineWorkflowService({ clock: () => now }).listPlans({
    authContext: fixture.contexts.manager,
    query: { status: 'CANCELLED' }
  });
  const scheduleChanged = cancelledListing.plans.find(({ _id }) => (
    openBeforeUpdate.some((plan) => String(plan._id) === _id)
  ));
  assert.equal(scheduleChanged.cancellationReason, 'SCHEDULE_CHANGED');
  assert.equal(
    scheduleChanged.cancellationReasonLabel,
    '规则执行周期或时间已调整，原未执行计划已作废'
  );

  await worker.runOnce({ now, teamId: fixture.ids.team });
  const versionTwoPlans = await EquipmentRoutinePlan.find({
    ruleId: rule._id,
    status: { $in: ['PLANNED', 'IN_WINDOW', 'OVERDUE'] }
  }).lean();
  assert.ok(versionTwoPlans.length > 0);
  assert.ok(versionTwoPlans.every(({ ruleVersion, cycleKey }) => (
    ruleVersion === 2 && cycleKey.startsWith('calendar:v2:')
  )));
  const versionTwoPlanIds = versionTwoPlans.map(({ _id }) => _id);

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
  assert.ok((await EquipmentRoutinePlan.find({ _id: { $in: versionTwoPlanIds } }).lean())
    .every(({ status, cancellationReason }) => (
      status === 'CANCELLED' && cancellationReason === 'RULE_DEACTIVATED'
    )));
  const planCountAfterDisable = await EquipmentRoutinePlan.countDocuments({ ruleId: rule._id });
  await worker.runOnce({ now, teamId: fixture.ids.team });
  assert.equal(await EquipmentRoutinePlan.countDocuments({ ruleId: rule._id }), planCountAfterDisable);
});

test('non-schedule rule edits persist a distinct cancellation reason for old open plans', async () => {
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
  const openPlans = await EquipmentRoutinePlan.find({
    ruleId: rule._id,
    status: { $in: ['PLANNED', 'IN_WINDOW', 'OVERDUE'] }
  }).lean();
  assert.ok(openPlans.length > 0);

  await routineService.updateRule({
    authContext: fixture.contexts.manager,
    ruleId: rule._id,
    input: {
      description: 'Updated checklist guidance only',
      schedule: rule.schedule,
      executionConfig: {
        ...rule.executionConfig,
        inspectionEscalationMinutes: 90,
        locationPolicy: 'REQUIRED',
        locationPrecisionMeters: 25
      }
    }
  });
  const cancelled = await EquipmentRoutinePlan.find({
    _id: { $in: openPlans.map(({ _id }) => _id) }
  }).lean();
  assert.ok(cancelled.every(({ status, cancellationReason }) => (
    status === 'CANCELLED' && cancellationReason === 'RULE_UPDATED'
  )));
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
  assert.ok((await EquipmentRoutinePlan.find({
    _id: { $in: initialRuntimeCalendarIds }
  }).lean()).every(({ cancellationReason, cancelledAt, cancelledBy }) => (
    cancellationReason === 'SUPERSEDED' &&
    cancelledAt?.toISOString() === now.toISOString() &&
    cancelledBy === null
  )));
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
  const cancelledSameCycleSibling = await EquipmentRoutinePlan.findById(sameCalendarCycleSibling._id).lean();
  assert.equal(cancelledSameCycleSibling.status, 'CANCELLED');
  assert.equal(cancelledSameCycleSibling.cancellationReason, 'SIBLING_COMPLETED');
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

test('COMBINED ALL rejects stale next-cycle plans until runtime is due and worker reopens them', async () => {
  let currentTime = new Date('2030-01-15T02:30:00.000Z');
  const routineService = createEquipmentRoutineService({
    clock: () => new Date(currentTime)
  });
  await routineService.createRuntimeReading({
    authContext: fixture.contexts.manager,
    equipmentId: String(fixture.asset._id),
    input: { hours: 100, reason: 'COMBINED ALL baseline' }
  });
  const rule = await createRule(routineService, 'INSPECTION', {
    schedule: {
      mode: 'COMBINED',
      calendar: { unit: 'DAY', interval: 1, firstDueAt: '2030-01-15T00:00:00.000Z' },
      runtime: { intervalHours: 25 },
      duePolicy: 'ALL'
    }
  });
  await routineService.createRuntimeReading({
    authContext: fixture.contexts.manager,
    equipmentId: String(fixture.asset._id),
    input: { hours: 125, reason: 'COMBINED ALL first threshold' }
  });
  const worker = createEquipmentRoutineWorkerService({
    routineService,
    clock: () => new Date(currentTime)
  });
  await worker.runOnce({ now: currentTime, teamId: fixture.ids.team });
  const initialPlans = await EquipmentRoutinePlan.find({ ruleId: rule._id })
    .sort({ cycleKey: 1, windowKey: 1 })
    .lean();
  const currentPlan = initialPlans.find(({ cycleKey, windowKey, scheduledFor }) => (
    cycleKey === 'calendar:2030-01-15T00:00:00.000Z' &&
    windowKey === 'DAY_SHIFT' &&
    scheduledFor <= currentTime
  ));
  const nextDayPlan = initialPlans.find(({ cycleKey, windowKey }) => (
    cycleKey === 'calendar:2030-01-16T00:00:00.000Z' && windowKey === 'DAY_SHIFT'
  ));
  assert.ok(currentPlan);
  assert.ok(nextDayPlan);

  await routineService.createRecord({
    authContext: fixture.contexts.manager,
    equipmentId: String(fixture.asset._id),
    input: {
      ruleId: rule._id,
      planId: currentPlan._id,
      runtimeHours: 125,
      itemResults: [{ itemKey: rule.checklistItems[0].key, result: 'NORMAL' }],
      idempotencyKey: 'combined-all-current-completion'
    }
  });
  const cancelledNext = await EquipmentRoutinePlan.findById(nextDayPlan._id).lean();
  assert.equal(cancelledNext.status, 'CANCELLED');
  assert.equal(cancelledNext.cancellationReason, 'SUPERSEDED');

  currentTime = new Date('2030-01-16T02:30:00.000Z');
  await EquipmentRoutinePlan.updateOne({ _id: nextDayPlan._id }, {
    $set: {
      status: 'IN_WINDOW',
      cancellationReason: null,
      cancelledAt: null,
      cancelledBy: null
    }
  });
  const staleSubmission = (idempotencyKey, withPlanId) => ({
    ruleId: rule._id,
    ...(withPlanId ? { planId: nextDayPlan._id } : {}),
    runtimeHours: 125,
    itemResults: [{ itemKey: rule.checklistItems[0].key, result: 'NORMAL' }],
    idempotencyKey
  });
  for (const [idempotencyKey, withPlanId] of [
    ['combined-all-stale-explicit', true],
    ['combined-all-stale-planless', false]
  ]) {
    await assert.rejects(routineService.createRecord({
      authContext: fixture.contexts.manager,
      equipmentId: String(fixture.asset._id),
      input: staleSubmission(idempotencyKey, withPlanId)
    }), (error) => (
      error.status === 409 &&
      ['EQUIPMENT_ROUTINE_PERIOD_COMPLETED', 'EQUIPMENT_ROUTINE_NOT_DUE'].includes(error.code)
    ));
  }
  assert.equal(await EquipmentRoutineRecord.countDocuments({ ruleId: rule._id }), 1);

  await EquipmentRoutinePlan.updateOne({ _id: nextDayPlan._id }, {
    $set: {
      status: 'CANCELLED',
      cancellationReason: 'SUPERSEDED',
      cancelledAt: currentTime,
      cancelledBy: fixture.ids.departmentManager
    }
  });
  await routineService.createRuntimeReading({
    authContext: fixture.contexts.manager,
    equipmentId: String(fixture.asset._id),
    input: { hours: 150, reason: 'COMBINED ALL second threshold' }
  });
  await worker.runOnce({ now: currentTime, teamId: fixture.ids.team });
  const reopened = await EquipmentRoutinePlan.findById(nextDayPlan._id).lean();
  assert.equal(reopened.status, 'OVERDUE');
  assert.equal(reopened.cancellationReason, null);
  assert.equal(reopened.rematerializationHistory.at(-1).cancellationReason, 'SUPERSEDED');
  assert.equal(reopened.rematerializationHistory.at(-1).source, 'WORKER');

  const secondRecord = await routineService.createRecord({
    authContext: fixture.contexts.manager,
    equipmentId: String(fixture.asset._id),
    input: {
      ruleId: rule._id,
      planId: reopened._id,
      runtimeHours: 150,
      itemResults: [{ itemKey: rule.checklistItems[0].key, result: 'NORMAL' }],
      idempotencyKey: 'combined-all-next-completion'
    }
  });
  assert.equal(String(secondRecord.planId), String(reopened._id));
  assert.equal((await EquipmentRoutinePlan.findById(reopened._id).lean()).status, 'COMPLETED');
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
  const legacyCancelledPlan = await EquipmentRoutinePlan.create({
    ...planBase,
    teamId: fixture.ids.team,
    orgUnitId: fixture.ids.group,
    equipmentId: fixture.asset._id,
    ruleId: objectId(),
    cycleKey: 'legacy-cancelled-plan',
    status: 'CANCELLED'
  });

  const visible = await workflow.getPlan({
    authContext: fixture.contexts.employee,
    planId: visiblePlan._id
  });
  assert.equal(visible._id, String(visiblePlan._id));
  const legacyCancelled = await workflow.getPlan({
    authContext: fixture.contexts.manager,
    planId: legacyCancelledPlan._id
  });
  assert.equal(legacyCancelled.cancellationReason, 'LEGACY_UNSPECIFIED');
  assert.equal(
    legacyCancelled.cancellationReasonLabel,
    '历史计划已取消，原系统未记录具体原因'
  );
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
  const [inspectionPlan, overduePlan, maintenancePlan, futurePlan, hiddenPlan, otherTeamPlan] = await EquipmentRoutinePlan.create([
    {
      ...planBase,
      ruleId: inspectionRule._id,
      ruleSnapshot: inspectionRule,
      routineType: 'INSPECTION',
      cycleKey: 'rest-day-current'
    },
    {
      ...planBase,
      ruleId: inspectionRule._id,
      ruleSnapshot: inspectionRule,
      routineType: 'INSPECTION',
      cycleKey: 'rest-day-overdue',
      dueAt: new Date('2030-01-15T01:00:00.000Z'),
      status: 'OVERDUE'
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

  const overdueCancelled = await workflow.markPlansRestDay({
    authContext: fixture.contexts.employee,
    input: { planIds: [String(overduePlan._id)] }
  });
  assert.equal(overdueCancelled.cancelledCount, 1);
  assert.equal(overdueCancelled.plans[0].status, 'CANCELLED');
  assert.equal(overdueCancelled.plans[0].cancellationReason, 'REST_DAY');

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
  assert.equal(cancelled.plans[0].cancellationReasonLabel, '本日休班，设备不需点检');
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
  assert.equal(row['车牌号'], 'PLATE-EQ-001');
  assert.equal(row['执行人'], 'employee');
  assert.equal(Object.prototype.hasOwnProperty.call(row, '计划时间'), false);
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
    dateBasis: 'EXECUTION',
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
  const maintenanceRuleId = objectId();
  const maintenanceRecordId = objectId();
  const maintenancePlan = await EquipmentRoutinePlan.create({
    teamId: fixture.ids.team,
    orgUnitId: fixture.ids.group,
    equipmentId: fixture.asset._id,
    categoryId: fixture.category._id,
    ruleId: maintenanceRuleId,
    ruleVersion: 1,
    ruleSnapshot: { name: 'Monthly maintenance' },
    routineType: 'MAINTENANCE',
    cycleKey: 'maintenance-export-cycle',
    windowKey: 'MAINTENANCE',
    windowName: 'Maintenance window',
    scheduledFor: new Date('2030-01-15T00:00:00.000Z'),
    dueAt: new Date('2030-01-15T02:00:00.000Z'),
    status: 'COMPLETED',
    completedRecordId: maintenanceRecordId,
    completedAt: recordBase.performedAt,
    completedBy: fixture.ids.employee
  });
  await EquipmentRoutineRecord.create({
    _id: maintenanceRecordId,
    ...recordBase,
    ruleId: maintenanceRuleId,
    ruleSnapshot: { name: '月度保养' },
    planId: maintenancePlan._id,
    routineType: 'MAINTENANCE',
    scheduledFor: maintenancePlan.dueAt
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
  const maintenanceWorkbook = XLSX.read(maintenanceExport.buffer, { type: 'buffer', cellDates: true });
  const [maintenanceRow] = XLSX.utils.sheet_to_json(
    maintenanceWorkbook.Sheets['点检保养记录'],
    { defval: '' }
  );
  assert.equal(maintenanceRow['关联计划编号'], String(maintenancePlan._id));
  assert.equal(
    new Date(maintenanceRow['计划开始时间']).toISOString(),
    maintenancePlan.scheduledFor.toISOString()
  );
  assert.equal(
    new Date(maintenanceRow['计划截止时间']).toISOString(),
    maintenancePlan.dueAt.toISOString()
  );
  assert.equal(maintenanceRow['车牌号'], 'PLATE-EQ-001');
  assert.equal(maintenanceRow['执行人'], 'employee');
  assert.equal(Object.prototype.hasOwnProperty.call(maintenanceRow, '计划时间'), false);
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

test('empty routine record exports preserve the complete fixed workbook header', async () => {
  const workflow = createEquipmentRoutineWorkflowService();
  const exported = await workflow.exportRecords({
    authContext: fixture.contexts.manager,
    query: {
      routineType: 'INSPECTION',
      equipmentId: String(fixture.asset._id)
    }
  });
  assert.equal(exported.count, 0);

  const workbook = XLSX.read(exported.buffer, { type: 'buffer', cellDates: true });
  const worksheet = workbook.Sheets['点检保养记录'];
  const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
  assert.deepEqual(rows, [[
    '设备编号',
    '设备名称',
    '车牌号',
    '所属组织',
    '业务类型',
    '规则名称',
    '规则版本',
    '关联计划编号',
    '计划窗口',
    '计划开始时间',
    '计划截止时间',
    '执行人',
    '执行时间',
    '执行结果',
    '异常摘要',
    '异常状态',
    '当前处理阶段',
    '现场照片数',
    '现场水印',
    '记录ID'
  ]]);
});

test('routine record exports can filter and sort by immutable plan date with legacy fallback', async () => {
  const common = {
    teamId: fixture.ids.team,
    orgUnitId: fixture.asset.orgUnitId,
    equipmentId: fixture.asset._id,
    categoryId: fixture.category._id,
    ruleId: objectId(),
    ruleVersion: 1,
    routineType: 'INSPECTION',
    performedBy: fixture.ids.employee,
    itemResults: [],
    overallResult: 'NORMAL',
    photoFileIds: [],
    photoEvidence: [],
    ruleSnapshot: { name: '计划日期导出测试' }
  };
  const plannedJanuaryPerformedFebruary = objectId();
  const plannedFebruaryPerformedJanuary = objectId();
  const legacyJanuaryPerformedMarch = objectId();
  const manualJanuary = objectId();
  const plannedEarlyJanuaryPerformedApril = objectId();
  await EquipmentRoutineRecord.collection.insertMany([
    {
      ...common,
      _id: plannedJanuaryPerformedFebruary,
      scheduledFor: new Date('2030-01-20T00:00:00.000Z'),
      planScheduledFor: new Date('2030-01-20T00:00:00.000Z'),
      performedAt: new Date('2030-02-05T00:00:00.000Z')
    },
    {
      ...common,
      _id: plannedFebruaryPerformedJanuary,
      scheduledFor: new Date('2030-02-12T00:00:00.000Z'),
      planScheduledFor: new Date('2030-02-12T00:00:00.000Z'),
      performedAt: new Date('2030-01-25T00:00:00.000Z')
    },
    {
      ...common,
      _id: legacyJanuaryPerformedMarch,
      scheduledFor: new Date('2030-01-25T00:00:00.000Z'),
      performedAt: new Date('2030-03-01T00:00:00.000Z')
    },
    {
      ...common,
      _id: manualJanuary,
      planScheduledFor: null,
      scheduledFor: null,
      performedAt: new Date('2030-01-30T00:00:00.000Z')
    },
    {
      ...common,
      _id: plannedEarlyJanuaryPerformedApril,
      scheduledFor: new Date('2030-01-05T00:00:00.000Z'),
      planScheduledFor: new Date('2030-01-05T00:00:00.000Z'),
      performedAt: new Date('2030-04-01T00:00:00.000Z')
    }
  ]);

  const workflow = createEquipmentRoutineWorkflowService();
  const exported = await workflow.exportRecords({
    authContext: fixture.contexts.manager,
    query: {
      dateBasis: 'PLAN',
      from: '2030-01-01T00:00:00+08:00',
      to: '2030-01-31T23:59:59.999+08:00'
    }
  });
  assert.equal(exported.count, 4);
  const workbook = XLSX.read(exported.buffer, { type: 'buffer', cellDates: true });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets['点检保养记录'], { defval: '' });
  assert.deepEqual(rows.map((row) => row['记录ID']), [
    String(manualJanuary),
    String(legacyJanuaryPerformedMarch),
    String(plannedJanuaryPerformedFebruary),
    String(plannedEarlyJanuaryPerformedApril)
  ]);
  const exportAudit = await AuditLog.findOne({
    action: permissions.AUDIT_ACTIONS.EXPORT,
    resourceType: permissions.AUDIT_RESOURCE_TYPES.INSPECTION_RECORD
  }).lean();
  assert.deepEqual(exportAudit.after.filters, {
    dateBasis: 'PLAN',
    routineType: null,
    equipmentId: null,
    orgUnitId: null,
    overallResult: null,
    from: '2029-12-31T16:00:00.000Z',
    to: '2030-01-31T15:59:59.999Z'
  });
  await assert.rejects(
    workflow.exportRecords({
      authContext: fixture.contexts.manager,
      query: { dateBasis: 'UNKNOWN' }
    }),
    (error) => error.code === 'EQUIPMENT_ROUTINE_WORKFLOW_INPUT_INVALID'
  );
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

test('record list can filter by the immutable plan date without changing legacy defaults', async () => {
  const routineService = createEquipmentRoutineService();
  const rule = await createRule(routineService, 'INSPECTION', { schedule: { mode: 'MANUAL' } });
  const common = {
    teamId: fixture.ids.team,
    orgUnitId: fixture.asset.orgUnitId,
    equipmentId: fixture.asset._id,
    categoryId: fixture.category._id,
    ruleId: rule._id,
    ruleVersion: rule.version,
    routineType: 'INSPECTION',
    performedBy: fixture.ids.employee,
    itemResults: [],
    overallResult: 'NORMAL',
    photoFileIds: [],
    photoEvidence: [],
    ruleSnapshot: rule
  };
  const plannedJanuaryPerformedFebruary = objectId();
  const plannedFebruaryPerformedJanuary = objectId();
  const legacyJanuaryPerformedMarch = objectId();
  const manualJanuary = objectId();
  const plannedEarlyJanuaryPerformedApril = objectId();
  await EquipmentRoutineRecord.collection.insertMany([
    {
      ...common,
      _id: plannedJanuaryPerformedFebruary,
      scheduledFor: new Date('2030-01-20T00:00:00.000Z'),
      planScheduledFor: new Date('2030-01-20T00:00:00.000Z'),
      planDueAt: new Date('2030-01-20T02:00:00.000Z'),
      performedAt: new Date('2030-02-05T00:00:00.000Z')
    },
    {
      ...common,
      _id: plannedFebruaryPerformedJanuary,
      scheduledFor: new Date('2030-02-12T00:00:00.000Z'),
      planScheduledFor: new Date('2030-02-12T00:00:00.000Z'),
      planDueAt: new Date('2030-02-12T02:00:00.000Z'),
      performedAt: new Date('2030-01-25T00:00:00.000Z')
    },
    {
      ...common,
      _id: legacyJanuaryPerformedMarch,
      scheduledFor: new Date('2030-01-25T00:00:00.000Z'),
      performedAt: new Date('2030-03-01T00:00:00.000Z')
    },
    {
      ...common,
      _id: manualJanuary,
      planScheduledFor: null,
      scheduledFor: null,
      performedAt: new Date('2030-01-30T00:00:00.000Z')
    },
    {
      ...common,
      _id: plannedEarlyJanuaryPerformedApril,
      scheduledFor: new Date('2030-01-05T00:00:00.000Z'),
      planScheduledFor: new Date('2030-01-05T00:00:00.000Z'),
      planDueAt: new Date('2030-01-05T02:00:00.000Z'),
      performedAt: new Date('2030-04-01T00:00:00.000Z')
    }
  ]);

  const byPlanDate = await routineService.listRecords({
    authContext: fixture.contexts.manager,
    query: {
      dateBasis: 'PLAN',
      from: '2030-01-01T00:00:00+08:00',
      to: '2030-01-31T23:59:59.999+08:00'
    }
  });
  assert.deepEqual(byPlanDate.records.map(({ _id }) => _id), [
    String(manualJanuary),
    String(legacyJanuaryPerformedMarch),
    String(plannedJanuaryPerformedFebruary),
    String(plannedEarlyJanuaryPerformedApril)
  ]);

  const legacyDefault = await routineService.listRecords({
    authContext: fixture.contexts.manager,
    query: {
      from: '2030-01-01T00:00:00+08:00',
      to: '2030-01-31T23:59:59.999+08:00'
    }
  });
  assert.deepEqual(legacyDefault.records.map(({ _id }) => _id), [
    String(manualJanuary),
    String(plannedFebruaryPerformedJanuary)
  ]);
  await assert.rejects(
    routineService.listRecords({
      authContext: fixture.contexts.manager,
      query: { dateBasis: 'UNKNOWN' }
    }),
    (error) => error.code === 'EQUIPMENT_ROUTINE_INPUT_INVALID'
  );
});

test('inspection calendar groups by Shanghai plan date and applies daily state priority', async () => {
  const routineService = createEquipmentRoutineService({
    clock: () => new Date('2030-08-15T00:00:00.000Z')
  });
  const rule = await createRule(routineService, 'INSPECTION', { schedule: { mode: 'MANUAL' } });
  const normalRecordId = objectId();
  const abnormalRecordId = objectId();
  const mixedNormalRecordId = objectId();
  const normalPlanId = objectId();
  const abnormalPlanId = objectId();
  const mixedNormalPlanId = objectId();
  const planCommon = {
    teamId: fixture.ids.team,
    orgUnitId: fixture.asset.orgUnitId,
    equipmentId: fixture.asset._id,
    categoryId: fixture.category._id,
    ruleId: rule._id,
    ruleVersion: rule.version,
    ruleSnapshot: rule,
    routineType: 'INSPECTION',
    windowKey: 'DAY_SHIFT',
    windowName: '白班'
  };
  await EquipmentRoutinePlan.collection.insertMany([
    {
      ...planCommon,
      _id: normalPlanId,
      cycleKey: 'calendar-normal',
      scheduledFor: new Date('2030-08-05T00:00:00.000Z'),
      dueAt: new Date('2030-08-05T02:00:00.000Z'),
      status: 'COMPLETED',
      completedRecordId: normalRecordId,
      completedAt: new Date('2030-08-05T01:00:00.000Z'),
      completedBy: fixture.ids.employee
    },
    {
      ...planCommon,
      _id: objectId(),
      cycleKey: 'calendar-pending',
      scheduledFor: new Date('2030-08-06T00:00:00.000Z'),
      dueAt: new Date('2030-08-06T02:00:00.000Z'),
      status: 'PLANNED'
    },
    {
      ...planCommon,
      _id: objectId(),
      cycleKey: 'calendar-rest',
      scheduledFor: new Date('2030-08-07T00:00:00.000Z'),
      dueAt: new Date('2030-08-07T02:00:00.000Z'),
      status: 'CANCELLED',
      cancellationReason: 'REST_DAY',
      cancelledAt: new Date('2030-08-07T00:30:00.000Z'),
      cancelledBy: fixture.ids.employee
    },
    {
      ...planCommon,
      _id: abnormalPlanId,
      cycleKey: 'calendar-abnormal',
      scheduledFor: new Date('2030-08-08T00:00:00.000Z'),
      dueAt: new Date('2030-08-08T02:00:00.000Z'),
      status: 'COMPLETED',
      completedRecordId: abnormalRecordId,
      completedAt: new Date('2030-08-08T01:00:00.000Z'),
      completedBy: fixture.ids.employee
    },
    {
      ...planCommon,
      _id: mixedNormalPlanId,
      cycleKey: 'calendar-mixed-normal',
      scheduledFor: new Date('2030-08-09T00:00:00.000Z'),
      dueAt: new Date('2030-08-09T02:00:00.000Z'),
      status: 'COMPLETED',
      completedRecordId: mixedNormalRecordId,
      completedAt: new Date('2030-08-09T01:00:00.000Z'),
      completedBy: fixture.ids.employee
    },
    {
      ...planCommon,
      _id: objectId(),
      cycleKey: 'calendar-mixed-pending',
      windowKey: 'NIGHT_SHIFT',
      windowName: '夜班',
      scheduledFor: new Date('2030-08-09T10:00:00.000Z'),
      dueAt: new Date('2030-08-09T12:00:00.000Z'),
      status: 'OVERDUE'
    }
  ]);
  const recordCommon = {
    teamId: fixture.ids.team,
    orgUnitId: fixture.asset.orgUnitId,
    equipmentId: fixture.asset._id,
    categoryId: fixture.category._id,
    ruleId: rule._id,
    ruleVersion: rule.version,
    routineType: 'INSPECTION',
    performedBy: fixture.ids.employee,
    itemResults: [],
    photoFileIds: [],
    photoEvidence: [],
    ruleSnapshot: rule
  };
  await EquipmentRoutineRecord.collection.insertMany([
    {
      ...recordCommon,
      _id: normalRecordId,
      planId: normalPlanId,
      scheduledFor: new Date('2030-08-05T00:00:00.000Z'),
      planScheduledFor: new Date('2030-08-05T00:00:00.000Z'),
      performedAt: new Date('2030-09-01T00:00:00.000Z'),
      overallResult: 'NORMAL'
    },
    {
      ...recordCommon,
      _id: abnormalRecordId,
      planId: abnormalPlanId,
      scheduledFor: new Date('2030-08-08T00:00:00.000Z'),
      planScheduledFor: new Date('2030-08-08T00:00:00.000Z'),
      performedAt: new Date('2030-08-08T01:00:00.000Z'),
      overallResult: 'ABNORMAL'
    },
    {
      ...recordCommon,
      _id: mixedNormalRecordId,
      planId: mixedNormalPlanId,
      scheduledFor: new Date('2030-08-09T00:00:00.000Z'),
      planScheduledFor: new Date('2030-08-09T00:00:00.000Z'),
      performedAt: new Date('2030-08-09T01:00:00.000Z'),
      overallResult: 'NORMAL'
    },
    {
      ...recordCommon,
      _id: objectId(),
      planId: null,
      scheduledFor: new Date('2030-08-10T00:00:00.000Z'),
      performedAt: new Date('2030-08-10T00:00:00.000Z'),
      overallResult: 'ABNORMAL'
    }
  ]);

  const calendar = await routineService.getInspectionCalendar({
    authContext: fixture.contexts.manager,
    equipmentId: String(fixture.asset._id),
    query: { month: '2030-08' }
  });
  assert.equal(calendar.days.length, 31);
  const statuses = Object.fromEntries(calendar.days.map((day) => [day.date, day.status]));
  assert.equal(statuses['2030-08-05'], 'NORMAL');
  assert.equal(statuses['2030-08-06'], 'PENDING');
  assert.equal(statuses['2030-08-07'], 'REST_DAY');
  assert.equal(statuses['2030-08-08'], 'ABNORMAL');
  assert.equal(statuses['2030-08-09'], 'PENDING');
  assert.equal(statuses['2030-08-10'], 'ABNORMAL');
  assert.equal(statuses['2030-08-11'], 'NO_PLAN');

  const global = await routineService.getInspectionCalendar({
    authContext: globalContext(fixture.ids.otherUser),
    requestedTeamId: String(fixture.ids.team),
    equipmentId: String(fixture.asset._id),
    query: { teamId: String(fixture.ids.team), month: '2030-08' }
  });
  assert.equal(global.equipment._id, String(fixture.asset._id));
  await assert.rejects(
    routineService.getInspectionCalendar({
      authContext: globalContext(fixture.ids.otherUser),
      equipmentId: String(fixture.asset._id),
      query: { month: '2030-08' }
    }),
    (error) => error.code === 'EQUIPMENT_TEAM_REQUIRED'
  );
});
