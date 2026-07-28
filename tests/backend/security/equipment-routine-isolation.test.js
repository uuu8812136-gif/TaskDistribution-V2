'use strict';

const assert = require('node:assert/strict');
const { after, before, beforeEach, test } = require('node:test');
const path = require('node:path');

const APP_ROOT = path.resolve(__dirname, '../../../app');
const appRequire = (name) => require(require.resolve(name, { paths: [APP_ROOT] }));
const mongoose = appRequire('mongoose');
const { MongoMemoryReplSet } = appRequire('mongodb-memory-server');

const AuditLog = require('../../../app/models/AuditLog');
const EquipmentAsset = require('../../../app/models/EquipmentAsset');
const EquipmentCategory = require('../../../app/models/EquipmentCategory');
const EquipmentRoutineRecord = require('../../../app/models/EquipmentRoutineRecord');
const EquipmentRoutineRule = require('../../../app/models/EquipmentRoutineRule');
const EquipmentRuntimeReading = require('../../../app/models/EquipmentRuntimeReading');
const FileAsset = require('../../../app/models/FileAsset');
const OrgUnit = require('../../../app/models/OrgUnit');
const ProjectTeam = require('../../../app/models/ProjectTeam');
const User = require('../../../app/models/User');
const permissions = require('../../../app/config/permissions');
const {
  createEquipmentRoutineService
} = require('../../../app/services/equipmentRoutineService');

const TEST_DATABASE_NAME = 'equipment_routine_isolation_v2_test';
const NOW = new Date('2030-01-15T12:00:00.000Z');
const MODELS = [
  AuditLog,
  EquipmentAsset,
  EquipmentCategory,
  EquipmentRoutineRecord,
  EquipmentRoutineRule,
  EquipmentRuntimeReading,
  FileAsset,
  OrgUnit,
  ProjectTeam,
  User
];
const ALL_ROUTINE_PERMISSIONS = Object.freeze([
  'equipment.view',
  'equipment.create',
  'equipment.edit',
  'equipment.inspect',
  'equipment.maintain'
]);

let replicaSet;
let fixture;

function objectId() {
  return new mongoose.Types.ObjectId();
}

function teamContext({
  teamId,
  orgUnitId,
  userId,
  scope = permissions.DATA_SCOPES.TEAM,
  permissionKeys = ALL_ROUTINE_PERMISSIONS
}) {
  return Object.freeze({
    authenticated: true,
    sessionId: String(objectId()),
    mode: permissions.SESSION_MODES.TEAM,
    tokenVersion: 0,
    userId: String(userId),
    user: Object.freeze({ _id: String(userId), username: `routine-${userId}` }),
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
    permissionKeys,
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

async function seedFixture() {
  const ids = {
    teamA: objectId(),
    teamB: objectId(),
    orgA1: objectId(),
    orgA2: objectId(),
    orgB1: objectId(),
    userA: objectId(),
    userB: objectId(),
    superAdmin: objectId()
  };
  await User.collection.insertMany([
    {
      _id: ids.userA,
      username: 'routine-a',
      usernameNormalized: 'routine-a',
      password: 'unused',
      name: 'Routine A',
      roles: [],
      isSuperAdmin: false,
      tokenVersion: 0,
      status: 'active'
    },
    {
      _id: ids.userB,
      username: 'routine-b',
      usernameNormalized: 'routine-b',
      password: 'unused',
      name: 'Routine B',
      roles: [],
      isSuperAdmin: false,
      tokenVersion: 0,
      status: 'active'
    },
    {
      _id: ids.superAdmin,
      username: 'routine-super',
      usernameNormalized: 'routine-super',
      password: 'unused',
      name: 'Routine Super',
      roles: [],
      isSuperAdmin: true,
      tokenVersion: 0,
      status: 'active'
    }
  ]);
  await ProjectTeam.collection.insertMany([
    {
      _id: ids.teamA,
      code: 'ROUTINE_A',
      name: 'Routine Team A',
      status: permissions.TEAM_STATUSES.ACTIVE,
      settings: { timeZone: 'Asia/Shanghai' },
      createdBy: ids.superAdmin
    },
    {
      _id: ids.teamB,
      code: 'ROUTINE_B',
      name: 'Routine Team B',
      status: permissions.TEAM_STATUSES.ACTIVE,
      settings: { timeZone: 'Asia/Shanghai' },
      createdBy: ids.superAdmin
    }
  ]);
  await OrgUnit.collection.insertMany([
    {
      _id: ids.orgA1,
      teamId: ids.teamA,
      parentId: null,
      type: permissions.ORG_UNIT_TYPES.DEPARTMENT,
      code: 'A1',
      name: 'A1',
      status: permissions.ORG_UNIT_STATUSES.ACTIVE,
      sortOrder: 0,
      level: 1,
      path: '/'
    },
    {
      _id: ids.orgA2,
      teamId: ids.teamA,
      parentId: null,
      type: permissions.ORG_UNIT_TYPES.DEPARTMENT,
      code: 'A2',
      name: 'A2',
      status: permissions.ORG_UNIT_STATUSES.ACTIVE,
      sortOrder: 0,
      level: 1,
      path: '/'
    },
    {
      _id: ids.orgB1,
      teamId: ids.teamB,
      parentId: null,
      type: permissions.ORG_UNIT_TYPES.DEPARTMENT,
      code: 'B1',
      name: 'B1',
      status: permissions.ORG_UNIT_STATUSES.ACTIVE,
      sortOrder: 0,
      level: 1,
      path: '/'
    }
  ]);

  const contextA = teamContext({
    teamId: ids.teamA,
    orgUnitId: ids.orgA1,
    userId: ids.userA
  });
  const contextB = teamContext({
    teamId: ids.teamB,
    orgUnitId: ids.orgB1,
    userId: ids.userB
  });
  const [categoryA1, categoryA2, categoryB] = await Promise.all([
    EquipmentCategory.create({
      teamId: ids.teamA,
      name: 'Motor',
      createdBy: ids.userA,
      updatedBy: ids.userA
    }),
    EquipmentCategory.create({
      teamId: ids.teamA,
      name: 'Forklift',
      createdBy: ids.userA,
      updatedBy: ids.userA
    }),
    EquipmentCategory.create({
      teamId: ids.teamB,
      name: 'Motor',
      createdBy: ids.userB,
      updatedBy: ids.userB
    })
  ]);
  const [assetA1, assetA2, assetB] = await Promise.all([
    EquipmentAsset.create({
      teamId: ids.teamA,
      orgUnitId: ids.orgA1,
      assetCode: 'A1-MOTOR',
      name: 'A1 Motor',
      categoryId: categoryA1._id,
      createdBy: ids.userA,
      updatedBy: ids.userA
    }),
    EquipmentAsset.create({
      teamId: ids.teamA,
      orgUnitId: ids.orgA2,
      assetCode: 'A2-FORKLIFT',
      name: 'A2 Forklift',
      categoryId: categoryA2._id,
      createdBy: ids.userA,
      updatedBy: ids.userA
    }),
    EquipmentAsset.create({
      teamId: ids.teamB,
      orgUnitId: ids.orgB1,
      assetCode: 'B-MOTOR',
      name: 'B Motor',
      categoryId: categoryB._id,
      createdBy: ids.userB,
      updatedBy: ids.userB
    })
  ]);
  return {
    ...ids,
    contextA,
    contextB,
    categoryA1,
    categoryA2,
    categoryB,
    assetA1,
    assetA2,
    assetB
  };
}

function service(options = {}) {
  return createEquipmentRoutineService({ clock: () => new Date(NOW), ...options });
}

function item(name = 'Bearing temperature') {
  return { name, description: `${name} requirement`, required: true };
}

async function createRule(routineService, context, categoryId, overrides = {}) {
  return routineService.createRule({
    authContext: context,
    input: {
      routineType: 'INSPECTION',
      categoryId: String(categoryId),
      name: overrides.name || `Rule ${new mongoose.Types.ObjectId()}`,
      checklistItems: overrides.checklistItems || [item()],
      schedule: overrides.schedule || { mode: 'MANUAL' },
      photoPolicy: overrides.photoPolicy || 'NONE',
      abnormalNoteRequired: overrides.abnormalNoteRequired ?? true
    }
  });
}

before(async () => {
  assert.match(TEST_DATABASE_NAME, /_v2_test$/);
  replicaSet = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    instanceOpts: [{ dbName: TEST_DATABASE_NAME }]
  });
  await mongoose.connect(replicaSet.getUri(TEST_DATABASE_NAME), { dbName: TEST_DATABASE_NAME });
  await Promise.all(MODELS.map((model) => model.syncIndexes()));
});

beforeEach(async () => {
  await Promise.all(MODELS.map((model) => model.collection.deleteMany({})));
  fixture = await seedFixture();
});

after(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replicaSet) await replicaSet.stop();
});

test('routine rules persist and return more than two checklist items after additions and reordering', async () => {
  const routineService = service();
  const initialItems = [
    'Emergency stop',
    'Safety guard',
    'Lubrication level',
    'Electrical cabinet',
    'Fasteners',
    'Abnormal noise'
  ].map((name, index) => ({ ...item(name), sortOrder: index * 10 }));

  const created = await createRule(
    routineService,
    fixture.contextA,
    fixture.categoryA1._id,
    {
      name: 'Multi-item inspection rule',
      checklistItems: initialItems
    }
  );
  assert.equal(created.checklistItems.length, 6);
  assert.deepEqual(created.checklistItems.map((entry) => entry.name), initialItems.map((entry) => entry.name));
  assert.equal(new Set(created.checklistItems.map((entry) => entry.key)).size, 6);

  const persistedAfterCreate = await EquipmentRoutineRule.findById(created._id).lean();
  assert.equal(persistedAfterCreate.checklistItems.length, 6);

  const updatedItems = [
    { key: created.checklistItems[5].key, ...item('Abnormal noise'), sortOrder: 0 },
    { ...item('Hydraulic pressure'), sortOrder: 10 },
    { key: created.checklistItems[0].key, ...item('Emergency stop'), sortOrder: 20 },
    { key: created.checklistItems[2].key, ...item('Lubrication level'), sortOrder: 30 },
    { ...item('Cooling system'), sortOrder: 40 },
    { key: created.checklistItems[3].key, ...item('Electrical cabinet'), sortOrder: 50 },
    { key: created.checklistItems[4].key, ...item('Fasteners'), sortOrder: 60 },
    { ...item('Work area cleanliness'), sortOrder: 70 }
  ];
  const updated = await routineService.updateRule({
    authContext: fixture.contextA,
    ruleId: created._id,
    input: { checklistItems: updatedItems }
  });
  const expectedNames = updatedItems.map((entry) => entry.name);
  assert.equal(updated.version, 2);
  assert.equal(updated.checklistItems.length, 8);
  assert.deepEqual(updated.checklistItems.map((entry) => entry.name), expectedNames);
  assert.ok(!updated.checklistItems.some((entry) => entry.name === 'Safety guard'));
  assert.equal(new Set(updated.checklistItems.map((entry) => entry.key)).size, 8);

  const persistedAfterUpdate = await EquipmentRoutineRule.findById(created._id).lean();
  assert.equal(persistedAfterUpdate.checklistItems.length, 8);
  assert.deepEqual(persistedAfterUpdate.checklistItems.map((entry) => entry.name), expectedNames);

  const detail = await routineService.getRule({
    authContext: fixture.contextA,
    ruleId: created._id
  });
  assert.deepEqual(detail.checklistItems, updated.checklistItems);

  const listed = await routineService.listRules({ authContext: fixture.contextA });
  assert.equal(listed.total, 1);
  assert.deepEqual(listed.rules[0].checklistItems, updated.checklistItems);

  const schedule = await routineService.getSchedule({
    authContext: fixture.contextA,
    equipmentId: String(fixture.assetA1._id)
  });
  assert.deepEqual(schedule.schedules[0].rule.checklistItems, updated.checklistItems);
});

test('dynamic checklist, photo policy, version snapshot, and next calendar due stay consistent', async () => {
  const routineService = service();
  const rule = await createRule(routineService, fixture.contextA, fixture.categoryA1._id, {
    name: 'Daily motor inspection',
    checklistItems: [{ key: 'client-forged', ...item('Inspect bearing') }],
    schedule: {
      mode: 'CALENDAR',
      calendar: {
        unit: 'DAY',
        interval: 1,
        firstDueAt: '2030-01-15T08:00:00.000Z'
      }
    },
    photoPolicy: 'ON_ABNORMAL'
  });
  assert.notEqual(rule.checklistItems[0].key, 'client-forged');

  await assert.rejects(routineService.createRecord({
    authContext: fixture.contextA,
    equipmentId: String(fixture.assetA1._id),
    input: {
      ruleId: rule._id,
      itemResults: [{
        itemKey: rule.checklistItems[0].key,
        result: 'ABNORMAL',
        note: 'Bearing is hot'
      }]
    }
  }), (error) => error.code === 'EQUIPMENT_ROUTINE_INPUT_INVALID');
  assert.equal(await EquipmentRoutineRecord.countDocuments({}), 0);

  const photo = await FileAsset.create({
    teamId: fixture.teamA,
    ownerType: FileAsset.FILE_OWNER_TYPES.TEMPORARY,
    ownerId: null,
    storageKey: `${fixture.teamA}/2030/01/${cryptoRandomUuid()}.jpg`,
    originalName: 'inspection.jpg',
    mimeType: 'image/jpeg',
    size: 128,
    sha256: 'a'.repeat(64),
    uploaderId: fixture.userA,
    status: FileAsset.FILE_STATUSES.TEMPORARY
  });
  const record = await routineService.createRecord({
    authContext: fixture.contextA,
    equipmentId: String(fixture.assetA1._id),
    input: {
      ruleId: rule._id,
      itemResults: [{
        itemKey: rule.checklistItems[0].key,
        result: 'ABNORMAL',
        note: 'Bearing is hot'
      }],
      photoFileIds: [String(photo._id)]
    }
  });
  assert.equal(record.ruleVersion, 1);
  assert.equal(record.ruleSnapshot.checklistItems[0].name, 'Inspect bearing');
  const boundPhoto = await FileAsset.findById(photo._id).lean();
  assert.equal(boundPhoto.status, FileAsset.FILE_STATUSES.ACTIVE);
  assert.equal(boundPhoto.ownerType, FileAsset.FILE_OWNER_TYPES.INSPECTION);
  assert.equal(String(boundPhoto.ownerId), record._id);

  const updated = await routineService.updateRule({
    authContext: fixture.contextA,
    ruleId: rule._id,
    input: {
      checklistItems: [{
        key: rule.checklistItems[0].key,
        ...item('Inspect bearing and belt')
      }]
    }
  });
  assert.equal(updated.version, 2);
  const persisted = await EquipmentRoutineRecord.findById(record._id).lean();
  assert.equal(persisted.ruleSnapshot.version, 1);
  assert.equal(persisted.ruleSnapshot.checklistItems[0].name, 'Inspect bearing');

  const schedule = await routineService.getSchedule({
    authContext: fixture.contextA,
    equipmentId: String(fixture.assetA1._id)
  });
  assert.equal(schedule.schedules[0].status, 'UPCOMING');
  assert.equal(schedule.schedules[0].nextDueAt.toISOString(), '2030-01-16T12:00:00.000Z');
  assert.equal(schedule.schedules[0].latestRecord._id, record._id);
  assert.equal(schedule.schedules[0].latestRecord.overallResult, 'ABNORMAL');
  const filteredRules = await routineService.listRules({
    authContext: fixture.contextA,
    query: { scheduleMode: 'CALENDAR' }
  });
  assert.deepEqual(filteredRules.rules.map((entry) => entry._id), [rule._id]);
  await assert.rejects(
    routineService.listRules({ authContext: fixture.contextA, query: { unsupported: 'x' } }),
    (error) => error.code === 'EQUIPMENT_ROUTINE_INPUT_INVALID'
  );
  assert.ok(await AuditLog.findOne({
    action: permissions.AUDIT_ACTIONS.SUBMIT,
    resourceType: permissions.AUDIT_RESOURCE_TYPES.INSPECTION_RECORD,
    resourceId: record._id
  }));
});

test('a 200-hour rule uses the activation reading, rejects rollback, and replays idempotently', async () => {
  const routineService = service();
  const rule = await createRule(routineService, fixture.contextA, fixture.categoryA1._id, {
    name: 'Motor 200 hour inspection',
    schedule: { mode: 'RUNTIME_HOURS', runtime: { intervalHours: 200 } }
  });
  let schedule = await routineService.getSchedule({
    authContext: fixture.contextA,
    equipmentId: String(fixture.assetA1._id)
  });
  assert.equal(schedule.schedules[0].status, 'WAITING_FOR_READING');
  assert.equal(schedule.schedules[0].nextDueRuntimeHours, null);
  await routineService.createRuntimeReading({
    authContext: fixture.contextA,
    equipmentId: String(fixture.assetA1._id),
    input: { hours: 100, reason: 'Initial meter reading' }
  });
  schedule = await routineService.getSchedule({
    authContext: fixture.contextA,
    equipmentId: String(fixture.assetA1._id)
  });
  assert.equal(schedule.schedules[0].status, 'UPCOMING');
  assert.equal(schedule.schedules[0].nextDueRuntimeHours, 300);

  const payload = {
    ruleId: rule._id,
    runtimeHours: 300,
    idempotencyKey: 'runtime-200-cycle-1',
    itemResults: [{
      itemKey: rule.checklistItems[0].key,
      result: 'NORMAL'
    }]
  };
  const first = await routineService.createRecord({
    authContext: fixture.contextA,
    equipmentId: String(fixture.assetA1._id),
    input: payload
  });
  const replay = await routineService.createRecord({
    authContext: fixture.contextA,
    equipmentId: String(fixture.assetA1._id),
    input: payload
  });
  assert.equal(replay._id, first._id);
  for (const changed of [
    {
      ...payload,
      itemResults: [{
        itemKey: rule.checklistItems[0].key,
        result: 'NORMAL',
        note: 'different note'
      }]
    },
    { ...payload, runtimeHours: 301 },
    { ...payload, abnormalSummary: 'different summary' },
    { ...payload, photoFileIds: [String(objectId())] }
  ]) {
    await assert.rejects(routineService.createRecord({
      authContext: fixture.contextA,
      equipmentId: String(fixture.assetA1._id),
      input: changed
    }), (error) => error.code === 'EQUIPMENT_ROUTINE_IDEMPOTENCY_CONFLICT');
  }
  assert.equal(await EquipmentRoutineRecord.countDocuments({}), 1);
  assert.equal(await EquipmentRuntimeReading.countDocuments({}), 2);

  await assert.rejects(routineService.createRuntimeReading({
    authContext: fixture.contextA,
    equipmentId: String(fixture.assetA1._id),
    input: { hours: 299 }
  }), (error) => error.code === 'EQUIPMENT_RUNTIME_HOURS_DECREASED');
  const asset = await EquipmentAsset.findById(fixture.assetA1._id).lean();
  assert.equal(asset.currentRuntimeHours, 300);
  assert.equal(await EquipmentRuntimeReading.countDocuments({}), 2);

  schedule = await routineService.getSchedule({
    authContext: fixture.contextA,
    equipmentId: String(fixture.assetA1._id)
  });
  assert.equal(schedule.schedules[0].nextDueRuntimeHours, 500);
  assert.equal(schedule.schedules[0].status, 'UPCOMING');
  await routineService.disableRule({
    authContext: fixture.contextA,
    ruleId: rule._id,
    input: { reason: 'Retired after cycle' }
  });
  const replayAfterDisable = await routineService.createRecord({
    authContext: fixture.contextA,
    equipmentId: String(fixture.assetA1._id),
    input: payload
  });
  assert.equal(replayAfterDisable._id, first._id);
});

test('concurrent submissions without a pre-generated plan create only one record for the period', async () => {
  const routineService = service();
  const rule = await createRule(routineService, fixture.contextA, fixture.categoryA1._id, {
    name: 'Concurrent daily inspection',
    schedule: {
      mode: 'CALENDAR',
      calendar: {
        unit: 'DAY',
        interval: 1,
        firstDueAt: '2030-01-15T08:00:00.000Z'
      }
    }
  });
  const payload = (idempotencyKey) => ({
    ruleId: rule._id,
    idempotencyKey,
    itemResults: [{
      itemKey: rule.checklistItems[0].key,
      result: 'NORMAL'
    }]
  });

  const submissions = await Promise.allSettled([
    routineService.createRecord({
      authContext: fixture.contextA,
      equipmentId: String(fixture.assetA1._id),
      input: payload('concurrent-period-a')
    }),
    routineService.createRecord({
      authContext: fixture.contextA,
      equipmentId: String(fixture.assetA1._id),
      input: payload('concurrent-period-b')
    })
  ]);

  assert.equal(submissions.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(submissions.filter(({ status }) => status === 'rejected').length, 1);
  assert.ok([
    'EQUIPMENT_ROUTINE_PERIOD_COMPLETED',
    'EQUIPMENT_ROUTINE_PLAN_NOT_OPEN'
  ].includes(submissions.find(({ status }) => status === 'rejected').reason.code));
  assert.equal(await EquipmentRoutineRecord.countDocuments({
    equipmentId: fixture.assetA1._id,
    ruleId: rule._id
  }), 1);
});

test('combined schedules distinguish ANY from ALL as runtime readings cross the threshold', async () => {
  const routineService = service();
  await routineService.createRuntimeReading({
    authContext: fixture.contextA,
    equipmentId: String(fixture.assetA1._id),
    input: { hours: 100 }
  });
  const common = {
    calendar: {
      unit: 'MONTH',
      interval: 1,
      firstDueAt: '2030-01-15T08:00:00.000Z'
    },
    runtime: { intervalHours: 200 }
  };
  await createRule(routineService, fixture.contextA, fixture.categoryA1._id, {
    name: 'Combined ANY',
    schedule: { mode: 'COMBINED', ...common, duePolicy: 'ANY' }
  });
  await createRule(routineService, fixture.contextA, fixture.categoryA1._id, {
    name: 'Combined ALL',
    schedule: { mode: 'COMBINED', ...common, duePolicy: 'ALL' }
  });
  let schedule = await routineService.getSchedule({
    authContext: fixture.contextA,
    equipmentId: String(fixture.assetA1._id)
  });
  const byName = new Map(schedule.schedules.map((entry) => [entry.rule.name, entry]));
  assert.equal(byName.get('Combined ANY').status, 'DUE');
  assert.equal(byName.get('Combined ALL').status, 'UPCOMING');
  assert.equal(byName.get('Combined ALL').nextDueRuntimeHours, 300);

  await routineService.createRuntimeReading({
    authContext: fixture.contextA,
    equipmentId: String(fixture.assetA1._id),
    input: { hours: 300 }
  });
  schedule = await routineService.getSchedule({
    authContext: fixture.contextA,
    equipmentId: String(fixture.assetA1._id)
  });
  const afterReading = new Map(schedule.schedules.map((entry) => [entry.rule.name, entry]));
  assert.equal(afterReading.get('Combined ANY').status, 'DUE');
  assert.equal(afterReading.get('Combined ALL').status, 'DUE');

  await createRule(routineService, fixture.contextA, fixture.categoryA2._id, {
    name: 'Missing runtime ANY future calendar',
    schedule: {
      mode: 'COMBINED',
      calendar: { unit: 'MONTH', interval: 1, firstDueAt: '2030-02-15T08:00:00.000Z' },
      runtime: { intervalHours: 200 },
      duePolicy: 'ANY'
    }
  });
  await createRule(routineService, fixture.contextA, fixture.categoryA2._id, {
    name: 'Missing runtime ANY due calendar',
    schedule: {
      mode: 'COMBINED',
      calendar: { unit: 'MONTH', interval: 1, firstDueAt: '2030-01-15T08:00:00.000Z' },
      runtime: { intervalHours: 200 },
      duePolicy: 'ANY'
    }
  });
  const missingReadingSchedule = await routineService.getSchedule({
    authContext: fixture.contextA,
    equipmentId: String(fixture.assetA2._id)
  });
  const missingByName = new Map(
    missingReadingSchedule.schedules.map((entry) => [entry.rule.name, entry])
  );
  assert.equal(missingByName.get('Missing runtime ANY future calendar').calendarStatus, 'UPCOMING');
  assert.equal(
    missingByName.get('Missing runtime ANY future calendar').runtimeStatus,
    'WAITING_FOR_READING'
  );
  assert.equal(
    missingByName.get('Missing runtime ANY future calendar').status,
    'WAITING_FOR_READING'
  );
  assert.equal(missingByName.get('Missing runtime ANY due calendar').calendarStatus, 'DUE');
  assert.equal(missingByName.get('Missing runtime ANY due calendar').status, 'DUE');
});

test('maintenance execution requires its own permission, completed required items, and ALWAYS photos', async () => {
  const routineService = service();
  const rule = await routineService.createRule({
    authContext: fixture.contextA,
    input: {
      routineType: 'MAINTENANCE',
      categoryId: String(fixture.categoryA1._id),
      name: 'Motor lubrication',
      checklistItems: [item('Lubricate bearing')],
      schedule: { mode: 'MANUAL' },
      photoPolicy: 'ALWAYS'
    }
  });
  const inspectOnly = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA,
    permissionKeys: Object.freeze(['equipment.view', 'equipment.inspect'])
  });
  await assert.rejects(routineService.createRecord({
    authContext: inspectOnly,
    equipmentId: String(fixture.assetA1._id),
    input: {
      ruleId: rule._id,
      itemResults: [{ itemKey: rule.checklistItems[0].key, result: 'COMPLETED' }]
    }
  }), (error) => error.status === 403);
  await assert.rejects(routineService.createRecord({
    authContext: fixture.contextA,
    equipmentId: String(fixture.assetA1._id),
    input: {
      ruleId: rule._id,
      itemResults: [{ itemKey: rule.checklistItems[0].key, result: 'SKIPPED' }]
    }
  }), (error) => error.code === 'EQUIPMENT_ROUTINE_INPUT_INVALID');
  await assert.rejects(routineService.createRecord({
    authContext: fixture.contextA,
    equipmentId: String(fixture.assetA1._id),
    input: {
      ruleId: rule._id,
      itemResults: [{ itemKey: rule.checklistItems[0].key, result: 'COMPLETED' }]
    }
  }), (error) => error.code === 'EQUIPMENT_ROUTINE_INPUT_INVALID');

  const pdf = await FileAsset.create({
    teamId: fixture.teamA,
    ownerType: FileAsset.FILE_OWNER_TYPES.TEMPORARY,
    ownerId: null,
    storageKey: `${fixture.teamA}/2030/01/${cryptoRandomUuid()}.pdf`,
    originalName: 'not-a-photo.pdf',
    mimeType: 'application/pdf',
    size: 128,
    sha256: 'c'.repeat(64),
    uploaderId: fixture.userA,
    status: FileAsset.FILE_STATUSES.TEMPORARY
  });
  await assert.rejects(routineService.createRecord({
    authContext: fixture.contextA,
    equipmentId: String(fixture.assetA1._id),
    input: {
      ruleId: rule._id,
      itemResults: [{ itemKey: rule.checklistItems[0].key, result: 'COMPLETED' }],
      photoFileIds: [String(pdf._id)]
    }
  }), (error) => error.code === 'FILE_MIME_TYPE_NOT_ALLOWED' && error.status === 415);
  const unchangedPdf = await FileAsset.findById(pdf._id).lean();
  assert.equal(unchangedPdf.status, FileAsset.FILE_STATUSES.TEMPORARY);
  assert.equal(await EquipmentRoutineRecord.countDocuments({}), 0);
});

test('optional inspection items may be skipped but required items may not', async () => {
  const routineService = service();
  const rule = await createRule(routineService, fixture.contextA, fixture.categoryA1._id, {
    name: 'Inspection with optional item',
    checklistItems: [
      { ...item('Required check'), required: true },
      { ...item('Optional check'), required: false }
    ]
  });
  const successful = await routineService.createRecord({
    authContext: fixture.contextA,
    equipmentId: String(fixture.assetA1._id),
    input: {
      ruleId: rule._id,
      itemResults: [
        { itemKey: rule.checklistItems[0].key, result: 'NORMAL' },
        { itemKey: rule.checklistItems[1].key, result: 'SKIPPED' }
      ]
    }
  });
  assert.equal(successful.overallResult, 'NORMAL');
  await assert.rejects(routineService.createRecord({
    authContext: fixture.contextA,
    equipmentId: String(fixture.assetA1._id),
    input: {
      ruleId: rule._id,
      itemResults: [
        { itemKey: rule.checklistItems[0].key, result: 'SKIPPED' },
        { itemKey: rule.checklistItems[1].key, result: 'NORMAL' }
      ]
    }
  }), (error) => error.code === 'EQUIPMENT_ROUTINE_INPUT_INVALID');
});

test('team, organization, and global read-only boundaries apply to rules, schedules, and records', async () => {
  const routineService = service();
  const ruleA1 = await createRule(routineService, fixture.contextA, fixture.categoryA1._id, {
    name: 'Team A motor rule'
  });
  const ruleA2 = await createRule(routineService, fixture.contextA, fixture.categoryA2._id, {
    name: 'Team A forklift rule'
  });
  const ruleB = await createRule(routineService, fixture.contextB, fixture.categoryB._id, {
    name: 'Team B motor rule'
  });
  const orgA1 = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA,
    scope: permissions.DATA_SCOPES.ORG_UNIT
  });
  await assert.rejects(routineService.getSchedule({
    authContext: orgA1,
    equipmentId: String(fixture.assetA2._id)
  }), (error) => error.status === 404);
  await assert.rejects(
    createRule(routineService, orgA1, fixture.categoryA1._id, { name: 'Forbidden org rule' }),
    (error) => error.code === 'EQUIPMENT_ROUTINE_TEAM_SCOPE_REQUIRED'
  );
  const visibleRules = await routineService.listRules({ authContext: orgA1 });
  assert.deepEqual(visibleRules.rules.map((rule) => rule.name), ['Team A motor rule']);
  await routineService.createRecord({
    authContext: fixture.contextA,
    equipmentId: String(fixture.assetA2._id),
    input: {
      ruleId: ruleA2._id,
      itemResults: [{ itemKey: ruleA2.checklistItems[0].key, result: 'NORMAL' }]
    }
  });
  const recordsInA2 = await routineService.listRecords({
    authContext: fixture.contextA,
    query: { orgUnitId: String(fixture.orgA2) }
  });
  const recordsInA1 = await routineService.listRecords({
    authContext: fixture.contextA,
    query: { orgUnitId: String(fixture.orgA1) }
  });
  assert.equal(recordsInA2.total, 1);
  assert.equal(recordsInA1.total, 0);
  const hiddenRecords = await routineService.listRecords({ authContext: orgA1 });
  assert.equal(hiddenRecords.total, 0);
  await assert.rejects(routineService.createRecord({
    authContext: fixture.contextA,
    equipmentId: String(fixture.assetA1._id),
    input: {
      ruleId: ruleB._id,
      itemResults: [{ itemKey: ruleA1.checklistItems[0].key, result: 'NORMAL' }]
    }
  }), (error) => error.status === 404);

  const global = globalContext(fixture.superAdmin);
  await assert.rejects(
    routineService.listRules({ authContext: global }),
    (error) => error.code === 'EQUIPMENT_TEAM_REQUIRED'
  );
  const teamAOnly = await routineService.listRules({
    authContext: global,
    requestedTeamId: String(fixture.teamA)
  });
  assert.deepEqual(
    new Set(teamAOnly.rules.map((rule) => rule.name)),
    new Set(['Team A forklift rule', 'Team A motor rule'])
  );
  await assert.rejects(routineService.createRule({
    authContext: global,
    input: {
      routineType: 'INSPECTION',
      categoryId: String(fixture.categoryA1._id),
      name: 'Forbidden',
      checklistItems: [item()],
      schedule: { mode: 'MANUAL' }
    }
  }), (error) => error.status === 403);
});

test('audit failures roll back readings, asset cache changes, and routine records', async () => {
  const normalService = service();
  const rule = await createRule(normalService, fixture.contextA, fixture.categoryA1._id, {
    name: 'Rollback rule'
  });
  const failingService = service({
    auditService: {
      async record() {
        throw new Error('forced audit failure');
      }
    }
  });
  await assert.rejects(failingService.createRuntimeReading({
    authContext: fixture.contextA,
    equipmentId: String(fixture.assetA1._id),
    input: { hours: 50 }
  }), /forced audit failure/);
  let asset = await EquipmentAsset.findById(fixture.assetA1._id).lean();
  assert.equal(asset.currentRuntimeHours, null);
  assert.equal(await EquipmentRuntimeReading.countDocuments({}), 0);

  const photo = await FileAsset.create({
    teamId: fixture.teamA,
    ownerType: FileAsset.FILE_OWNER_TYPES.TEMPORARY,
    ownerId: null,
    storageKey: `${fixture.teamA}/2030/01/${cryptoRandomUuid()}.jpg`,
    originalName: 'rollback.jpg',
    mimeType: 'image/jpeg',
    size: 128,
    sha256: 'b'.repeat(64),
    uploaderId: fixture.userA,
    status: FileAsset.FILE_STATUSES.TEMPORARY
  });

  await assert.rejects(failingService.createRecord({
    authContext: fixture.contextA,
    equipmentId: String(fixture.assetA1._id),
    input: {
      ruleId: rule._id,
      itemResults: [{ itemKey: rule.checklistItems[0].key, result: 'NORMAL' }],
      photoFileIds: [String(photo._id)]
    }
  }), /forced audit failure/);
  assert.equal(await EquipmentRoutineRecord.countDocuments({}), 0);
  const rolledBackPhoto = await FileAsset.findById(photo._id).lean();
  assert.equal(rolledBackPhoto.status, FileAsset.FILE_STATUSES.TEMPORARY);
  assert.equal(rolledBackPhoto.ownerId, null);
  asset = await EquipmentAsset.findById(fixture.assetA1._id).lean();
  assert.equal(asset.currentRuntimeHours, null);
});

function cryptoRandomUuid() {
  return require('node:crypto').randomUUID();
}
