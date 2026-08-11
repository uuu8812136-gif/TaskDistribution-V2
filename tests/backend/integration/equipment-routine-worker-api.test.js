'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { after, before, test } = require('node:test');
const appRequire = require('../helpers/appRequire');

const mongoose = appRequire('mongoose');
const { MongoMemoryReplSet } = appRequire('mongodb-memory-server');
const request = appRequire('supertest');

const { createApp } = require('../../../app/app');
const AuthSession = require('../../../app/models/AuthSession');
const EquipmentAsset = require('../../../app/models/EquipmentAsset');
const EquipmentCategory = require('../../../app/models/EquipmentCategory');
const EquipmentRoutinePlan = require('../../../app/models/EquipmentRoutinePlan');
const EquipmentRoutineRecord = require('../../../app/models/EquipmentRoutineRecord');
const EquipmentRoutineRule = require('../../../app/models/EquipmentRoutineRule');
const EquipmentRuntimeReading = require('../../../app/models/EquipmentRuntimeReading');
const Message = require('../../../app/models/Message');
const OrgUnit = require('../../../app/models/OrgUnit');
const ProjectTeam = require('../../../app/models/ProjectTeam');
const TeamMembership = require('../../../app/models/TeamMembership');
const User = require('../../../app/models/User');
const {
  FUNCTIONAL_ROLE_KEYS,
  ORG_UNIT_TYPES,
  POSITION_KEYS,
  POSITION_LEVEL_BY_KEY,
  SESSION_MODES
} = require('../../../app/config/permissions');
const { createSessionLifecycleService } = require('../../../app/services/sessionLifecycleService');

const TEST_DATABASE_NAME = `routine_worker_api_${randomUUID().replaceAll('-', '')}_v2_test`;
const JWT_SECRET = 'routine-worker-api-test-secret-0123456789abcdef';
const RUN_AT = '2030-01-15T02:30:00.000Z';
const MODELS = [
  AuthSession,
  EquipmentAsset,
  EquipmentCategory,
  EquipmentRoutinePlan,
  EquipmentRoutineRecord,
  EquipmentRoutineRule,
  EquipmentRuntimeReading,
  Message,
  OrgUnit,
  ProjectTeam,
  TeamMembership,
  User
];

let replSet;
let app;
let fixture;

function config() {
  return {
    appEnv: 'test',
    nodeEnv: 'test',
    instanceName: 'routine-worker-api-v2-test',
    port: 18096,
    mongodbUri: `mongodb://127.0.0.1:27017/${TEST_DATABASE_NAME}`,
    jwtSecret: JWT_SECRET,
    jwtExpire: '1h',
    uploadPath: path.resolve(__dirname, '../../../work/test-temp/routine-worker-api-uploads'),
    maxFileSize: 10 * 1024 * 1024,
    corsOrigins: ['http://localhost:3101'],
    enableLegacyPublicUploads: false
  };
}

async function createUser(username, { isSuperAdmin = false } = {}) {
  return User.create({
    username,
    password: 'test-password-123',
    name: username,
    isSuperAdmin,
    roles: isSuperAdmin ? ['admin'] : ['executor']
  });
}

async function createMembership({
  teamId,
  userId,
  orgUnitId,
  positionKey = POSITION_KEYS.EMPLOYEE,
  functionalRoleKeys = [],
  permissionKeys = []
}) {
  return TeamMembership.create({
    teamId,
    userId,
    orgUnitId,
    positionKey,
    positionLevel: POSITION_LEVEL_BY_KEY[positionKey],
    functionalRoleKeys,
    permissionKeys
  });
}

async function issueTeamToken(user, teamId) {
  const issued = await createSessionLifecycleService().issueSession({
    userId: user._id,
    mode: SESSION_MODES.TEAM,
    activeTeamId: teamId,
    tokenVersion: user.tokenVersion
  });
  return issued.token;
}

async function createOrganization(teamId, prefix) {
  const root = await OrgUnit.create({
    teamId,
    type: ORG_UNIT_TYPES.DEPARTMENT,
    code: `${prefix}_ROOT`,
    name: `${prefix} Root`,
    level: 1,
    path: '/'
  });
  const subDepartment = await OrgUnit.create({
    teamId,
    parentId: root._id,
    type: ORG_UNIT_TYPES.SUB_DEPARTMENT,
    code: `${prefix}_SUB`,
    name: `${prefix} Sub-department`,
    level: 2,
    path: `/${root._id}/`
  });
  const group = await OrgUnit.create({
    teamId,
    parentId: subDepartment._id,
    type: ORG_UNIT_TYPES.TEAM_GROUP,
    code: `${prefix}_GROUP`,
    name: `${prefix} Group`,
    level: 3,
    path: `/${root._id}/${subDepartment._id}/`
  });
  return { root, subDepartment, group };
}

async function createRoutineFixture({ team, org, createdBy, suffix }) {
  const majorCategory = await EquipmentCategory.create({
    teamId: team._id,
    name: `${suffix} Major`,
    createdBy,
    updatedBy: createdBy
  });
  const categoryType = await EquipmentCategory.create({
    teamId: team._id,
    parentId: majorCategory._id,
    name: `${suffix} Type`,
    createdBy,
    updatedBy: createdBy
  });
  const category = await EquipmentCategory.create({
    teamId: team._id,
    parentId: categoryType._id,
    name: `${suffix} Primary`,
    createdBy,
    updatedBy: createdBy
  });
  const secondaryCategory = await EquipmentCategory.create({
    teamId: team._id,
    parentId: category._id,
    name: `${suffix} Secondary`,
    createdBy,
    updatedBy: createdBy
  });
  const asset = await EquipmentAsset.create({
    teamId: team._id,
    orgUnitId: org.group._id,
    categoryId: secondaryCategory._id,
    assetCode: `${suffix}-EQ-001`,
    name: `${suffix} Equipment`,
    status: 'IN_USE',
    createdBy,
    updatedBy: createdBy
  });
  const rule = await EquipmentRoutineRule.create({
    teamId: team._id,
    categoryId: category._id,
    routineType: 'INSPECTION',
    name: `${suffix} Daily Inspection`,
    checklistItems: [{ key: 'temperature', name: 'Check temperature' }],
    schedule: {
      mode: 'CALENDAR',
      calendar: {
        unit: 'DAY',
        interval: 1,
        firstDueAt: new Date('2030-01-15T00:00:00.000Z')
      }
    },
    executionConfig: {
      timeZone: 'Asia/Shanghai',
      windows: [
        { key: 'DAY_SHIFT', name: 'Day shift', startTime: '07:00', endTime: '09:00', enabled: true },
        { key: 'NIGHT_SHIFT', name: 'Night shift', startTime: '19:00', endTime: '21:00', enabled: true }
      ],
      weeklyDay: 1,
      monthlyDay: 1,
      inspectionEscalationMinutes: 60,
      locationPolicy: 'PENDING_CONFIRMATION',
      locationPrecisionMeters: null
    },
    createdBy,
    updatedBy: createdBy
  });
  return { majorCategory, categoryType, category, secondaryCategory, asset, rule };
}

async function seed() {
  const superAdmin = await createUser('routine-worker-super', { isSuperAdmin: true });
  const ordinary = await createUser('routine-worker-ordinary');
  const manager = await createUser('routine-worker-manager');
  const assetAdmin = await createUser('routine-worker-asset-admin');
  const foreignBranchManager = await createUser('routine-worker-foreign-branch-manager');
  const [teamA, teamB] = await ProjectTeam.create([
    { code: 'ROUTINE_WORKER_A', name: 'Routine Worker Team A', createdBy: superAdmin._id },
    { code: 'ROUTINE_WORKER_B', name: 'Routine Worker Team B', createdBy: superAdmin._id }
  ]);
  const orgA = await createOrganization(teamA._id, 'RWA');
  const orgB = await createOrganization(teamB._id, 'RWB');

  await createMembership({
    teamId: teamA._id,
    userId: ordinary._id,
    orgUnitId: orgA.group._id,
    permissionKeys: ['equipment.edit']
  });
  await createMembership({
    teamId: teamA._id,
    userId: manager._id,
    orgUnitId: orgA.root._id,
    positionKey: POSITION_KEYS.DEPARTMENT_MANAGER,
    permissionKeys: ['equipment.edit']
  });
  await createMembership({
    teamId: teamA._id,
    userId: assetAdmin._id,
    orgUnitId: orgA.root._id,
    functionalRoleKeys: [FUNCTIONAL_ROLE_KEYS.ASSET_ADMIN],
    permissionKeys: ['equipment.edit']
  });
  await createMembership({
    teamId: teamB._id,
    userId: foreignBranchManager._id,
    orgUnitId: orgB.subDepartment._id,
    positionKey: POSITION_KEYS.SUB_DEPARTMENT_MANAGER
  });

  const routineA = await createRoutineFixture({
    team: teamA,
    org: orgA,
    createdBy: superAdmin._id,
    suffix: 'RWA'
  });
  const routineB = await createRoutineFixture({
    team: teamB,
    org: orgB,
    createdBy: superAdmin._id,
    suffix: 'RWB'
  });

  assert.equal(await TeamMembership.countDocuments({ userId: superAdmin._id }), 0);
  return {
    superAdmin,
    ordinary,
    manager,
    assetAdmin,
    foreignBranchManager,
    teamA,
    teamB,
    orgA,
    orgB,
    routineA,
    routineB,
    ordinaryToken: await issueTeamToken(ordinary, teamA._id),
    managerToken: await issueTeamToken(manager, teamA._id),
    assetAdminToken: await issueTeamToken(assetAdmin, teamA._id),
    teamSuperToken: await issueTeamToken(superAdmin, teamA._id)
  };
}

function postWorker(token, { query = '', body = {} } = {}) {
  return request(app)
    .post(`/api/equipment/routine-worker/run${query}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ now: RUN_AT, ...body });
}

async function foreignState() {
  return {
    plans: await EquipmentRoutinePlan.countDocuments({ teamId: fixture.teamB._id }),
    messages: await Message.countDocuments({ teamId: fixture.teamB._id }),
    ruleRevision: (await EquipmentRoutineRule.findById(fixture.routineB.rule._id).lean())
      .materializationRevision,
    assetRevision: (await EquipmentAsset.findById(fixture.routineB.asset._id).lean())
      .routineMaterializationRevision
  };
}

before(async () => {
  assert.match(TEST_DATABASE_NAME, /_v2_test$/);
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.JWT_EXPIRE = '1h';
  process.env.JWT_ISSUER = 'task-distribution-v2';
  process.env.JWT_AUDIENCE = 'task-distribution-v2-clients';

  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    instanceOpts: [{ dbName: TEST_DATABASE_NAME }]
  });
  await mongoose.connect(replSet.getUri(TEST_DATABASE_NAME), { dbName: TEST_DATABASE_NAME });
  assert.equal(mongoose.connection.name, TEST_DATABASE_NAME);
  for (const model of MODELS) await model.syncIndexes();
  app = createApp(config());
  fixture = await seed();
});

after(async () => {
  if (mongoose.connection.readyState !== 0) {
    assert.equal(mongoose.connection.name, TEST_DATABASE_NAME);
    await mongoose.disconnect();
  }
  if (replSet) await replSet.stop();
});

test('routine worker HTTP endpoint enforces manager identities and active-team isolation', async (t) => {
  const initialForeignState = await foreignState();
  assert.deepEqual(initialForeignState, {
    plans: 0,
    messages: 0,
    ruleRevision: 0,
    assetRevision: 0
  });

  await t.test('an ordinary employee with equipment.edit but ORG_UNIT scope is rejected', async () => {
    const response = await postWorker(fixture.ordinaryToken).expect(403);
    assert.equal(response.body.code, 'EQUIPMENT_ROUTINE_MANAGER_REQUIRED');
    assert.equal(await EquipmentRoutinePlan.countDocuments({ teamId: fixture.teamA._id }), 0);
    assert.deepEqual(await foreignState(), initialForeignState);
  });

  await t.test('a query teamId is rejected before it can override the active team', async () => {
    const response = await postWorker(fixture.managerToken, {
      query: `?teamId=${fixture.teamB.id}`
    }).expect(400);
    assert.equal(response.body.code, 'EQUIPMENT_TEAM_ID_IMMUTABLE');
    assert.equal(await EquipmentRoutinePlan.countDocuments({ teamId: fixture.teamA._id }), 0);
    assert.deepEqual(await foreignState(), initialForeignState);
  });

  await t.test('a body teamId is rejected before it can silently run the active team', async () => {
    const response = await postWorker(fixture.managerToken, {
      body: { teamId: fixture.teamB.id }
    }).expect(400);
    assert.equal(response.body.code, 'EQUIPMENT_TEAM_ID_IMMUTABLE');
    assert.equal(await EquipmentRoutinePlan.countDocuments({ teamId: fixture.teamA._id }), 0);
    assert.deepEqual(await foreignState(), initialForeignState);
  });

  await t.test('TEAM department manager, ASSET_ADMIN, and team-mode SUPER_ADMIN are allowed', async () => {
    const planCountBefore = await EquipmentRoutinePlan.countDocuments({ teamId: fixture.teamA._id });
    const managerResponse = await postWorker(fixture.managerToken).expect(200);
    assert.equal(managerResponse.body.result.rulesProcessed, 1);
    const planCountAfterManager = await EquipmentRoutinePlan.countDocuments({ teamId: fixture.teamA._id });
    assert.ok(planCountAfterManager > planCountBefore);
    for (const token of [
      fixture.assetAdminToken,
      fixture.teamSuperToken
    ]) {
      const response = await postWorker(token).expect(200);
      assert.equal(response.body.result.rulesProcessed, 1);
    }
    assert.equal(
      await EquipmentRoutinePlan.countDocuments({ teamId: fixture.teamA._id }),
      planCountAfterManager,
      'repeated authorized runs must remain idempotent'
    );
    assert.deepEqual(await foreignState(), initialForeignState);
  });
});
