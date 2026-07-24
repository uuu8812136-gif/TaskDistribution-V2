'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { after, before, beforeEach, test } = require('node:test');
const appRequire = require('../helpers/appRequire');

const express = appRequire('express');
const mongoose = appRequire('mongoose');
const request = appRequire('supertest');
const XLSX = appRequire('xlsx');
const { MongoMemoryReplSet } = appRequire('mongodb-memory-server');

const permissions = require('../../../app/config/permissions');
const { SYSTEM_ACCOUNT_DISPLAY_NAME } = require('../../../app/config/systemAccount');
const ProjectTeam = require('../../../app/models/ProjectTeam');
const OrgUnit = require('../../../app/models/OrgUnit');
const TeamMembership = require('../../../app/models/TeamMembership');
const User = require('../../../app/models/User');
const Task = require('../../../app/models/Task');
const TaskReview = require('../../../app/models/TaskReview');
const ExtensionRequest = require('../../../app/models/ExtensionRequest');
const {
  createStatisticsController
} = require('../../../app/controllers/statisticsController');
const { createUserController } = require('../../../app/controllers/userController');

const TEST_DATABASE_NAME = `statistics_users_${randomUUID().replaceAll('-', '')}_v2_test`;
const MODELS = [
  ProjectTeam,
  OrgUnit,
  TeamMembership,
  User,
  Task,
  TaskReview,
  ExtensionRequest
];

let mongoServer;
let fixture;

function objectId() {
  return new mongoose.Types.ObjectId();
}

function teamContext(teamId, orgUnitId, userId, scope = permissions.DATA_SCOPES.TEAM) {
  return Object.freeze({
    authenticated: true,
    sessionId: String(objectId()),
    mode: permissions.SESSION_MODES.TEAM,
    tokenVersion: 0,
    userId: String(userId),
    user: Object.freeze({ _id: String(userId), username: 'actor-a', roles: [] }),
    isSuperAdmin: false,
    activeTeamId: String(teamId),
    team: Object.freeze({ _id: String(teamId), status: permissions.TEAM_STATUSES.ACTIVE }),
    membership: Object.freeze({
      _id: String(objectId()),
      teamId: String(teamId),
      userId: String(userId),
      orgUnitId: String(orgUnitId),
      role: permissions.MEMBERSHIP_ROLES.PROJECT_ADMIN,
      positionLevel: 1,
      status: permissions.MEMBERSHIP_STATUSES.ACTIVE
    }),
    orgUnit: Object.freeze({ _id: String(orgUnitId), teamId: String(teamId) }),
    actorRole: permissions.AUDIT_ACTOR_ROLES.PROJECT_ADMIN,
    permissionKeys: Object.freeze(['task.view', 'task.export', 'member.view', 'member.manage']),
    moduleDataScopes: Object.freeze({ task: scope }),
    readOnly: false,
    canAccessBusiness: true
  });
}

function globalReadContext(userId) {
  return Object.freeze({
    authenticated: true,
    sessionId: String(objectId()),
    mode: permissions.SESSION_MODES.GLOBAL_READ_ONLY,
    tokenVersion: 0,
    userId: String(userId),
    user: Object.freeze({ _id: String(userId), username: 'super-reader', roles: [] }),
    isSuperAdmin: true,
    activeTeamId: null,
    team: null,
    membership: null,
    orgUnit: null,
    actorRole: permissions.AUDIT_ACTOR_ROLES.SUPER_ADMIN,
    permissionKeys: Object.freeze(['task.view', 'member.view']),
    moduleDataScopes: Object.freeze({}),
    readOnly: true,
    canAccessBusiness: true
  });
}

function createTestApp(context) {
  const statistics = createStatisticsController();
  const users = createUserController();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.authContext = context;
    req.user = context.user;
    next();
  });
  app.get('/statistics/overview', statistics.getStatisticsOverview);
  app.get('/statistics/export/tasks', statistics.exportTasksToExcel);
  app.get('/statistics/export/users', statistics.exportUserStatistics);
  app.get('/users', users.getAllUsers);
  app.get('/users/:id', users.getUserById);
  app.post('/users', users.createUser);
  app.put('/users/:id', users.updateUser);
  app.delete('/users/:id', users.deleteUser);
  app.post('/users/:id/reset-password', users.resetPassword);
  app.use((error, _req, res, _next) => {
    res.status(error.status || 500).json({ code: error.code, message: error.message });
  });
  return app;
}

function userDocument(_id, username, name, options = {}) {
  return {
    _id,
    username,
    usernameNormalized: username,
    password: options.password || `hash-${username}`,
    name,
    roles: options.roles || ['executor'],
    isSuperAdmin: options.isSuperAdmin === true,
    isSystemAccount: options.isSystemAccount === true,
    tokenVersion: 0,
    status: options.status || 'active',
    createdAt: new Date('2030-01-01T00:00:00.000Z'),
    updatedAt: new Date('2030-01-01T00:00:00.000Z')
  };
}

function membershipDocument({ _id = objectId(), teamId, userId, orgUnitId, role }) {
  const isAdmin = role === permissions.MEMBERSHIP_ROLES.PROJECT_ADMIN;
  return {
    _id,
    teamId,
    userId,
    orgUnitId,
    role,
    positionLevel: isAdmin
      ? permissions.POSITION_LEVELS.DEPARTMENT_MANAGER
      : permissions.POSITION_LEVELS.EMPLOYEE,
    positionKey: isAdmin
      ? permissions.POSITION_KEYS.DEPARTMENT_MANAGER
      : permissions.POSITION_KEYS.EMPLOYEE,
    functionalRoleKeys: [],
    permissionKeys: isAdmin
      ? ['task.view', 'task.export', 'member.view', 'member.manage']
      : ['task.view', 'member.view'],
    moduleDataScopes: [{ moduleKey: 'task', scope: permissions.DATA_SCOPES.TEAM }],
    status: permissions.MEMBERSHIP_STATUSES.ACTIVE,
    joinedAt: new Date('2030-01-01T00:00:00.000Z'),
    createdAt: new Date('2030-01-01T00:00:00.000Z'),
    updatedAt: new Date('2030-01-01T00:00:00.000Z')
  };
}

function taskDocument({
  _id = objectId(),
  teamId,
  orgUnitId,
  userId,
  taskName,
  status,
  priority,
  hasExtensionRequest = false,
  parentTask = null,
  isMainTask = true
}) {
  return {
    _id,
    teamId,
    orgUnitId,
    taskName,
    taskType: 'Test',
    taskSource: 'Fixture',
    creator: userId,
    executor: [userId],
    mainExecutor: userId,
    ccUsers: [],
    startTime: new Date('2030-01-01T08:00:00.000Z'),
    plannedCompletionTime: new Date('2030-01-02T08:00:00.000Z'),
    parentTask,
    isMainTask,
    status,
    priority,
    completionRate: status === 'finished' ? 100 : 0,
    hasExtensionRequest,
    createdAt: new Date('2030-01-01T00:00:00.000Z'),
    updatedAt: new Date('2030-01-01T00:00:00.000Z')
  };
}

async function seedFixture() {
  const ids = {
    teamA: objectId(),
    teamB: objectId(),
    orgA: objectId(),
    orgAOther: objectId(),
    orgB: objectId(),
    userA: objectId(),
    userAColleague: objectId(),
    userB: objectId()
  };

  await User.collection.insertMany([
    userDocument(ids.userA, 'actor-a', 'A_VISIBLE_ACTOR', { roles: ['admin'] }),
    userDocument(ids.userAColleague, 'colleague-a', 'A_VISIBLE_COLLEAGUE'),
    userDocument(ids.userB, 'b-secret-user', 'B_SECRET_USER', {
      roles: ['admin'],
      isSuperAdmin: true
    })
  ]);
  await ProjectTeam.collection.insertMany([
    {
      _id: ids.teamA,
      code: 'TEAM_A',
      name: 'Team A',
      status: permissions.TEAM_STATUSES.ACTIVE,
      settings: { timeZone: 'Asia/Shanghai' },
      createdBy: ids.userA
    },
    {
      _id: ids.teamB,
      code: 'TEAM_B',
      name: 'B_SECRET_TEAM',
      status: permissions.TEAM_STATUSES.ACTIVE,
      settings: { timeZone: 'Asia/Shanghai' },
      createdBy: ids.userB
    }
  ]);
  await OrgUnit.collection.insertMany([
    {
      _id: ids.orgA,
      teamId: ids.teamA,
      parentId: null,
      type: permissions.ORG_UNIT_TYPES.DEPARTMENT,
      code: 'ORG_A',
      name: 'A Visible Department',
      status: permissions.ORG_UNIT_STATUSES.ACTIVE,
      sortOrder: 0,
      level: 1,
      path: '/'
    },
    {
      _id: ids.orgAOther,
      teamId: ids.teamA,
      parentId: null,
      type: permissions.ORG_UNIT_TYPES.DEPARTMENT,
      code: 'ORG_A_OTHER',
      name: 'A Other Department',
      status: permissions.ORG_UNIT_STATUSES.ACTIVE,
      sortOrder: 1,
      level: 1,
      path: '/'
    },
    {
      _id: ids.orgB,
      teamId: ids.teamB,
      parentId: null,
      type: permissions.ORG_UNIT_TYPES.DEPARTMENT,
      code: 'ORG_B',
      name: 'B_SECRET_DEPARTMENT',
      status: permissions.ORG_UNIT_STATUSES.ACTIVE,
      sortOrder: 0,
      level: 1,
      path: '/'
    }
  ]);
  await TeamMembership.collection.insertMany([
    membershipDocument({
      teamId: ids.teamA,
      userId: ids.userA,
      orgUnitId: ids.orgA,
      role: permissions.MEMBERSHIP_ROLES.PROJECT_ADMIN
    }),
    membershipDocument({
      teamId: ids.teamA,
      userId: ids.userAColleague,
      orgUnitId: ids.orgAOther,
      role: permissions.MEMBERSHIP_ROLES.MEMBER
    }),
    membershipDocument({
      teamId: ids.teamB,
      userId: ids.userB,
      orgUnitId: ids.orgB,
      role: permissions.MEMBERSHIP_ROLES.PROJECT_ADMIN
    })
  ]);

  const aInProgress = taskDocument({
    teamId: ids.teamA,
    orgUnitId: ids.orgA,
    userId: ids.userA,
    taskName: 'A_VISIBLE_IN_PROGRESS',
    status: 'in_progress',
    priority: 'low',
    hasExtensionRequest: true
  });
  const aFinished = taskDocument({
    teamId: ids.teamA,
    orgUnitId: ids.orgA,
    userId: ids.userA,
    taskName: 'A_VISIBLE_FINISHED',
    status: 'finished',
    priority: 'normal'
  });
  const aPartial = taskDocument({
    teamId: ids.teamA,
    orgUnitId: ids.orgA,
    userId: ids.userA,
    taskName: 'A_VISIBLE_PARTIAL',
    status: 'partial_completed',
    priority: 'high'
  });
  const aPendingReview = taskDocument({
    teamId: ids.teamA,
    orgUnitId: ids.orgA,
    userId: ids.userA,
    taskName: 'A_VISIBLE_PENDING_REVIEW',
    status: 'pending_review',
    priority: 'urgent'
  });
  const aPendingConfirm = taskDocument({
    teamId: ids.teamA,
    orgUnitId: ids.orgA,
    userId: ids.userA,
    taskName: 'A_VISIBLE_PENDING_CONFIRM',
    status: 'pending_confirm',
    priority: 'normal'
  });
  const aOtherOrg = taskDocument({
    teamId: ids.teamA,
    orgUnitId: ids.orgAOther,
    userId: ids.userAColleague,
    taskName: 'A_OTHER_ORG_TASK',
    status: 'finished',
    priority: 'low',
    hasExtensionRequest: true
  });
  const bSecret = taskDocument({
    teamId: ids.teamB,
    orgUnitId: ids.orgB,
    userId: ids.userB,
    taskName: 'B_SECRET_TASK',
    status: 'finished',
    priority: 'urgent',
    hasExtensionRequest: true
  });
  const aChild = taskDocument({
    teamId: ids.teamA,
    orgUnitId: ids.orgA,
    userId: ids.userA,
    taskName: 'A_VISIBLE_CHILD',
    status: 'finished',
    priority: 'normal',
    parentTask: aInProgress._id,
    isMainTask: false
  });
  const bForeignChild = taskDocument({
    teamId: ids.teamB,
    orgUnitId: ids.orgB,
    userId: ids.userB,
    taskName: 'B_SECRET_FOREIGN_CHILD',
    status: 'finished',
    priority: 'normal',
    parentTask: aInProgress._id,
    isMainTask: false
  });
  await Task.collection.insertMany([
    aInProgress,
    aFinished,
    aPartial,
    aPendingReview,
    aPendingConfirm,
    aOtherOrg,
    bSecret,
    aChild,
    bForeignChild
  ]);

  await TaskReview.collection.insertMany([
    {
      _id: objectId(),
      teamId: ids.teamA,
      task: aInProgress._id,
      reviewer: ids.userAColleague,
      content: 'A_VISIBLE_REVIEW',
      result: 'approved',
      reviewTime: new Date('2030-01-03T00:00:00.000Z')
    },
    {
      _id: objectId(),
      teamId: ids.teamA,
      task: aOtherOrg._id,
      reviewer: ids.userA,
      content: 'A_OTHER_ORG_REVIEW',
      result: 'approved',
      reviewTime: new Date('2030-01-03T00:00:00.000Z')
    },
    {
      _id: objectId(),
      teamId: ids.teamB,
      task: bSecret._id,
      reviewer: ids.userB,
      content: 'B_SECRET_REVIEW',
      result: 'approved',
      reviewTime: new Date('2030-01-03T00:00:00.000Z')
    },
    {
      _id: objectId(),
      teamId: ids.teamB,
      task: aInProgress._id,
      reviewer: ids.userB,
      content: 'B_SECRET_CROSS_TEAM_REVIEW',
      result: 'approved',
      reviewTime: new Date('2030-01-04T00:00:00.000Z')
    }
  ]);
  await ExtensionRequest.collection.insertMany([
    {
      _id: objectId(),
      teamId: ids.teamA,
      task: aInProgress._id,
      applicant: ids.userA,
      requestType: 'main_task',
      reason: 'A visible extension',
      applyTime: new Date('2030-01-02T00:00:00.000Z'),
      originalCompletionTime: new Date('2030-01-02T08:00:00.000Z'),
      requestedDays: 2,
      approvedDays: 2,
      status: 'pending'
    },
    {
      _id: objectId(),
      teamId: ids.teamA,
      task: aOtherOrg._id,
      applicant: ids.userAColleague,
      requestType: 'main_task',
      reason: 'A other org extension',
      applyTime: new Date('2030-01-02T00:00:00.000Z'),
      originalCompletionTime: new Date('2030-01-02T08:00:00.000Z'),
      requestedDays: 3,
      approvedDays: 3,
      status: 'pending'
    },
    {
      _id: objectId(),
      teamId: ids.teamB,
      task: bSecret._id,
      applicant: ids.userB,
      requestType: 'main_task',
      reason: 'B_SECRET_EXTENSION',
      applyTime: new Date('2030-01-02T00:00:00.000Z'),
      originalCompletionTime: new Date('2030-01-02T08:00:00.000Z'),
      requestedDays: 9,
      approvedDays: 9,
      status: 'pending'
    },
    {
      _id: objectId(),
      teamId: ids.teamB,
      task: aInProgress._id,
      applicant: ids.userB,
      requestType: 'main_task',
      reason: 'B_SECRET_CROSS_TEAM_EXTENSION',
      applyTime: new Date('2030-01-05T00:00:00.000Z'),
      originalCompletionTime: new Date('2030-01-02T08:00:00.000Z'),
      requestedDays: 99,
      approvedDays: 99,
      status: 'pending'
    }
  ]);

  return { ...ids, aInProgress, aOtherOrg, bSecret };
}

function binaryParser(response, callback) {
  const chunks = [];
  response.on('data', (chunk) => chunks.push(chunk));
  response.on('end', () => callback(null, Buffer.concat(chunks)));
}

function workbookRows(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  return XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
}

before(async () => {
  assert.match(TEST_DATABASE_NAME, /_v2_test$/);
  mongoServer = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    instanceOpts: [{ dbName: TEST_DATABASE_NAME }]
  });
  await mongoose.connect(mongoServer.getUri(TEST_DATABASE_NAME), { dbName: TEST_DATABASE_NAME });
  assert.equal(mongoose.connection.name, TEST_DATABASE_NAME);
});

beforeEach(async () => {
  assert.equal(mongoose.connection.name, TEST_DATABASE_NAME);
  await Promise.all(MODELS.map((model) => model.collection.deleteMany({})));
  fixture = await seedFixture();
});

after(async () => {
  if (mongoose.connection.readyState !== 0) {
    assert.equal(mongoose.connection.name, TEST_DATABASE_NAME);
    await mongoose.disconnect();
  }
  if (mongoServer) await mongoServer.stop();
});

test('TEAM overview scopes every counter and pending extension to team A', async () => {
  const response = await request(createTestApp(
    teamContext(fixture.teamA, fixture.orgA, fixture.userA)
  )).get('/statistics/overview').expect(200);

  assert.deepEqual(response.body.overview, {
    totalTasks: 6,
    inProgressTasks: 2,
    finishedTasks: 2,
    delayedTasks: 2,
    pendingReviewTasks: 1,
    pendingConfirmTasks: 1,
    pendingExtensions: 2,
    totalUsers: 2,
    completionRate: 33,
    priorityStats: { low: 2, normal: 2, high: 1, urgent: 1 }
  });
});

test('ORG_UNIT overview and related records are derived from visible task ids', async () => {
  const app = createTestApp(teamContext(
    fixture.teamA,
    fixture.orgA,
    fixture.userA,
    permissions.DATA_SCOPES.ORG_UNIT
  ));
  const overview = await request(app).get('/statistics/overview').expect(200);

  assert.deepEqual(overview.body.overview, {
    totalTasks: 5,
    inProgressTasks: 2,
    finishedTasks: 1,
    delayedTasks: 1,
    pendingReviewTasks: 1,
    pendingConfirmTasks: 1,
    pendingExtensions: 1,
    totalUsers: 1,
    completionRate: 20,
    priorityStats: { low: 1, normal: 2, high: 1, urgent: 1 }
  });

  const exported = await request(app)
    .get('/statistics/export/tasks')
    .buffer(true)
    .parse(binaryParser)
    .expect(200);
  const serialized = JSON.stringify(workbookRows(exported.body));
  assert.match(serialized, /A_VISIBLE_IN_PROGRESS/);
  assert.match(serialized, /A_VISIBLE_REVIEW/);
  assert.doesNotMatch(serialized, /A_OTHER_ORG/);
  assert.doesNotMatch(serialized, /B_SECRET/);

  const userExport = await request(app)
    .get('/statistics/export/users')
    .buffer(true)
    .parse(binaryParser)
    .expect(200);
  const serializedUsers = JSON.stringify(workbookRows(userExport.body));
  assert.match(serializedUsers, /A_VISIBLE_ACTOR/);
  assert.doesNotMatch(serializedUsers, /A_VISIBLE_COLLEAGUE/);

  const users = await request(app).get('/users').query({ limit: 1000 }).expect(200);
  assert.equal(users.body.pagination.total, 1);
  assert.equal(users.body.users[0].username, 'actor-a');
  const crossOrg = await request(app).get(`/users/${fixture.userAColleague}`).expect(404);
  const missing = await request(app).get(`/users/${objectId()}`).expect(404);
  assert.deepEqual(crossOrg.body, missing.body);
});

test('GLOBAL_READ_ONLY accepts an explicit team filter without mixing team B', async () => {
  const app = createTestApp(globalReadContext(fixture.userB));
  const response = await request(app)
    .get('/statistics/overview')
    .query({ teamId: String(fixture.teamA) })
    .expect(200);
  assert.equal(response.body.overview.totalTasks, 6);
  assert.equal(response.body.overview.totalUsers, 2);
  assert.equal(response.body.overview.pendingExtensions, 2);

  const allTeams = await request(app).get('/statistics/overview').expect(200);
  assert.equal(allTeams.body.overview.totalTasks, 7);
  assert.equal(allTeams.body.overview.totalUsers, 3);
  assert.equal(allTeams.body.overview.pendingExtensions, 3);
});

test('task and personnel XLSX exports contain no team B cell values', async () => {
  const app = createTestApp(teamContext(fixture.teamA, fixture.orgA, fixture.userA));
  const taskExport = await request(app)
    .get('/statistics/export/tasks')
    .buffer(true)
    .parse(binaryParser)
    .expect(200);
  const taskRows = workbookRows(taskExport.body);
  const serializedTasks = JSON.stringify(taskRows);
  assert.match(serializedTasks, /A_VISIBLE_IN_PROGRESS/);
  assert.match(serializedTasks, /A_VISIBLE_REVIEW/);
  assert.doesNotMatch(serializedTasks, /B_SECRET/);
  const inProgressRow = taskRows.find((row) => row['任务名称'] === 'A_VISIBLE_IN_PROGRESS');
  assert.equal(inProgressRow['子任务数'], 1);
  assert.equal(inProgressRow['延期天数'], 2);

  const userExport = await request(app)
    .get('/statistics/export/users')
    .buffer(true)
    .parse(binaryParser)
    .expect(200);
  const userRows = workbookRows(userExport.body);
  const serializedUsers = JSON.stringify(userRows);
  assert.match(serializedUsers, /A_VISIBLE_ACTOR/);
  assert.match(serializedUsers, /A_VISIBLE_COLLEAGUE/);
  assert.doesNotMatch(serializedUsers, /B_SECRET/);
  assert.equal(userRows.length, 2);

  const colleague = userRows.find((row) => row['用户名'] === 'colleague-a');
  assert.equal(colleague['执行任务数'], 1);
  assert.equal(colleague['已完成任务数'], 1);
  assert.equal(colleague['已审核任务数'], 1);
});

test('task XLSX export redacts a disabled system member used as creator and reviewer', async () => {
  const systemUserId = objectId();
  const internalUsername = 'internal-statistics-identity';
  const internalName = 'INTERNAL_STATISTICS_IDENTITY';
  await User.collection.insertOne(userDocument(
    systemUserId,
    internalUsername,
    internalName,
    { roles: ['admin'], isSuperAdmin: true, isSystemAccount: true }
  ));
  const systemMembership = membershipDocument({
    teamId: fixture.teamA,
    userId: systemUserId,
    orgUnitId: fixture.orgA,
    role: permissions.MEMBERSHIP_ROLES.PROJECT_ADMIN
  });
  systemMembership.status = permissions.MEMBERSHIP_STATUSES.DISABLED;
  await TeamMembership.collection.insertOne(systemMembership);

  const systemTask = taskDocument({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA,
    userId: fixture.userA,
    taskName: 'SYSTEM_REFERENCE_TASK',
    status: 'finished',
    priority: 'normal'
  });
  systemTask.creator = systemUserId;
  await Task.collection.insertOne(systemTask);
  await TaskReview.collection.insertOne({
    _id: objectId(),
    teamId: fixture.teamA,
    task: systemTask._id,
    reviewer: systemUserId,
    content: 'System account review',
    result: 'approved',
    reviewTime: new Date('2030-01-03T00:00:00.000Z')
  });

  const response = await request(createTestApp(
    teamContext(fixture.teamA, fixture.orgA, fixture.userA)
  ))
    .get('/statistics/export/tasks')
    .buffer(true)
    .parse(binaryParser)
    .expect(200);
  const row = workbookRows(response.body).find(
    (candidate) => Object.values(candidate).includes('SYSTEM_REFERENCE_TASK')
  );
  assert.ok(row);
  const serialized = JSON.stringify(row);
  assert.equal(serialized.includes(internalName), false);
  assert.equal(serialized.includes(internalUsername), false);
  assert.equal(
    (serialized.match(new RegExp(SYSTEM_ACCOUNT_DISPLAY_NAME, 'g')) || []).length,
    2
  );
});

test('legacy users list and detail expose current-team memberships only', async () => {
  const systemUserId = objectId();
  await User.collection.insertOne(userDocument(
    systemUserId,
    'internal-directory-identity',
    'INTERNAL_DIRECTORY_IDENTITY',
    { roles: ['admin'], isSuperAdmin: true, isSystemAccount: true }
  ));
  await TeamMembership.collection.insertOne(membershipDocument({
    teamId: fixture.teamA,
    userId: systemUserId,
    orgUnitId: fixture.orgA,
    role: permissions.MEMBERSHIP_ROLES.PROJECT_ADMIN
  }));

  const app = createTestApp(teamContext(fixture.teamA, fixture.orgA, fixture.userA));
  const list = await request(app).get('/users').query({
    limit: 1000,
    teamId: String(fixture.teamB)
  }).expect(200);
  assert.equal(list.body.pagination.total, 2);
  assert.equal(list.body.users.length, 2);
  assert.deepEqual(
    new Set(list.body.users.map((user) => user.username)),
    new Set(['actor-a', 'colleague-a'])
  );
  assert.equal(JSON.stringify(list.body).includes('B_SECRET'), false);
  assert.equal(Object.hasOwn(list.body.users[0], 'isSuperAdmin'), false);
  assert.equal(Object.hasOwn(list.body.users[0], 'tokenVersion'), false);
  assert.equal(JSON.stringify(list.body).includes('INTERNAL_DIRECTORY_IDENTITY'), false);

  const detail = await request(app).get(`/users/${fixture.userAColleague}`).expect(200);
  assert.equal(detail.body.user.username, 'colleague-a');
  assert.equal(detail.body.user.membership.teamId, String(fixture.teamA));

  const crossTeam = await request(app).get(`/users/${fixture.userB}`).expect(404);
  const systemAccount = await request(app).get(`/users/${systemUserId}`).expect(404);
  const missing = await request(app).get(`/users/${objectId()}`).expect(404);
  assert.equal(crossTeam.body.code, missing.body.code);
  assert.equal(crossTeam.body.message, missing.body.message);
  assert.equal(systemAccount.body.code, missing.body.code);
  assert.equal(systemAccount.body.message, missing.body.message);
});

test('legacy write endpoints cannot mutate User or TeamMembership state', async () => {
  const app = createTestApp(teamContext(fixture.teamA, fixture.orgA, fixture.userA));
  const usersBefore = await User.find({}).sort({ _id: 1 }).lean();
  const membershipsBefore = await TeamMembership.find({}).sort({ _id: 1 }).lean();

  const createResponse = await request(app).post('/users').send({
    username: 'attacker-created',
    password: 'changed-password',
    name: 'Attacker',
    roles: ['admin'],
    isSuperAdmin: true,
    teamId: String(fixture.teamB)
  }).expect(410);
  assert.equal(createResponse.body.code, 'LEGACY_USER_WRITE_DISABLED');

  await request(app).put(`/users/${fixture.userAColleague}`).send({
    name: 'B_SECRET_OVERWRITE',
    roles: ['admin'],
    isSuperAdmin: true,
    teamId: String(fixture.teamB)
  }).expect(410);
  await request(app).delete(`/users/${fixture.userAColleague}`).expect(410);
  await request(app).post(`/users/${fixture.userAColleague}/reset-password`).send({
    newPassword: 'changed-password'
  }).expect(410);

  const usersAfter = await User.find({}).sort({ _id: 1 }).lean();
  const membershipsAfter = await TeamMembership.find({}).sort({ _id: 1 }).lean();
  assert.deepEqual(usersAfter, usersBefore);
  assert.deepEqual(membershipsAfter, membershipsBefore);
});
