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
const ProjectTeam = require('../../../app/models/ProjectTeam');
const OrgUnit = require('../../../app/models/OrgUnit');
const TeamMembership = require('../../../app/models/TeamMembership');
const User = require('../../../app/models/User');
const Task = require('../../../app/models/Task');
const TaskReview = require('../../../app/models/TaskReview');
const ExtensionRequest = require('../../../app/models/ExtensionRequest');
const AuditLog = require('../../../app/models/AuditLog');
const { createTaskController } = require('../../../app/controllers/taskController');
const { createAuditService } = require('../../../app/services/auditService');

const TEST_DATABASE_NAME = `task_controller_${randomUUID().replaceAll('-', '')}_v2_test`;
const MODELS = [
  ProjectTeam,
  OrgUnit,
  TeamMembership,
  User,
  Task,
  TaskReview,
  ExtensionRequest,
  AuditLog
];

let mongoServer;
let fixture;

function objectId() {
  return new mongoose.Types.ObjectId();
}

function authContext(
  teamId,
  orgUnitId,
  userId,
  scope = permissions.DATA_SCOPES.TEAM
) {
  const teamWide = scope === permissions.DATA_SCOPES.TEAM;
  return Object.freeze({
    authenticated: true,
    sessionId: String(objectId()),
    mode: permissions.SESSION_MODES.TEAM,
    tokenVersion: 0,
    userId: String(userId),
    user: Object.freeze({ _id: String(userId), username: 'member-a', roles: [] }),
    isSuperAdmin: false,
    activeTeamId: String(teamId),
    team: Object.freeze({ _id: String(teamId), status: permissions.TEAM_STATUSES.ACTIVE }),
    membership: Object.freeze({
      _id: String(objectId()),
      teamId: String(teamId),
      userId: String(userId),
      orgUnitId: String(orgUnitId),
      role: teamWide
        ? permissions.MEMBERSHIP_ROLES.PROJECT_ADMIN
        : permissions.MEMBERSHIP_ROLES.MEMBER,
      positionLevel: teamWide
        ? permissions.POSITION_LEVELS.DEPARTMENT_MANAGER
        : permissions.POSITION_LEVELS.EMPLOYEE,
      status: permissions.MEMBERSHIP_STATUSES.ACTIVE
    }),
    orgUnit: Object.freeze({ _id: String(orgUnitId), teamId: String(teamId) }),
    actorRole: teamWide
      ? permissions.AUDIT_ACTOR_ROLES.PROJECT_ADMIN
      : permissions.AUDIT_ACTOR_ROLES.MEMBER,
    permissionKeys: Object.freeze([
      'task.view',
      'task.create',
      'task.edit',
      'task.assign',
      'task.review',
      'task.export'
    ]),
    moduleDataScopes: Object.freeze({ task: scope }),
    readOnly: false,
    canAccessBusiness: true
  });
}

function systemAuthContext(teamId, orgUnitId, userId, username) {
  const context = authContext(teamId, orgUnitId, userId);
  return Object.freeze({
    ...context,
    userId: String(userId),
    user: Object.freeze({ _id: String(userId), username, roles: ['admin'] }),
    isSuperAdmin: true,
    membership: null,
    actorRole: permissions.AUDIT_ACTOR_ROLES.SUPER_ADMIN
  });
}

function createTestApp(context, controllerOverrides = {}) {
  const controller = createTaskController({
    mongoose,
    auditService: { record: async () => null },
    notifications: {
      notifyTaskAssigned: async () => null,
      notifyTaskUpdated: async () => null,
      notifyTaskDeleted: async () => null
    },
    ...controllerOverrides
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.authContext = context;
    req.user = context.user;
    next();
  });
  app.get('/tasks/export', controller.batchExportTasks);
  app.get('/tasks', controller.getTasks);
  app.get('/tasks/:id', controller.getTaskById);
  app.post('/tasks', controller.createTask);
  app.put('/tasks/:id', controller.updateTask);
  app.delete('/tasks/:id', controller.deleteTask);
  app.use((error, _req, res, _next) => {
    res.status(error.status || 500).json({ code: error.code, message: error.message });
  });
  return app;
}

async function seedFixture() {
  const ids = {
    teamA: objectId(),
    teamB: objectId(),
    orgA: objectId(),
    orgAOther: objectId(),
    orgB: objectId(),
    userA: objectId(),
    userAOther: objectId(),
    userB: objectId()
  };
  await User.collection.insertMany([
    {
      _id: ids.userA,
      username: 'member-a',
      usernameNormalized: 'member-a',
      password: 'not-used',
      name: 'Member A',
      roles: [],
      isSuperAdmin: false,
      tokenVersion: 0,
      status: 'active'
    },
    {
      _id: ids.userAOther,
      username: 'member-a-other',
      usernameNormalized: 'member-a-other',
      password: 'not-used',
      name: 'Member A Other Org',
      roles: [],
      isSuperAdmin: false,
      tokenVersion: 0,
      status: 'active'
    },
    {
      _id: ids.userB,
      username: 'member-b',
      usernameNormalized: 'member-b',
      password: 'not-used',
      name: 'Member B',
      roles: [],
      isSuperAdmin: false,
      tokenVersion: 0,
      status: 'active'
    }
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
      name: 'Team B',
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
      name: 'Org A',
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
      name: 'Org A Other',
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
      name: 'Org B',
      status: permissions.ORG_UNIT_STATUSES.ACTIVE,
      sortOrder: 0,
      level: 1,
      path: '/'
    }
  ]);
  await TeamMembership.collection.insertMany([
    {
      _id: objectId(),
      teamId: ids.teamA,
      userId: ids.userAOther,
      orgUnitId: ids.orgAOther,
      role: permissions.MEMBERSHIP_ROLES.MEMBER,
      positionLevel: permissions.POSITION_LEVELS.EMPLOYEE,
      positionKey: permissions.POSITION_KEYS.EMPLOYEE,
      functionalRoleKeys: [],
      permissionKeys: ['task.view'],
      moduleDataScopes: [{ moduleKey: 'task', scope: permissions.DATA_SCOPES.ORG_UNIT }],
      status: permissions.MEMBERSHIP_STATUSES.ACTIVE,
      joinedAt: new Date()
    },
    {
      _id: objectId(),
      teamId: ids.teamA,
      userId: ids.userA,
      orgUnitId: ids.orgA,
      role: permissions.MEMBERSHIP_ROLES.PROJECT_ADMIN,
      positionLevel: 1,
      positionKey: permissions.POSITION_KEYS.DEPARTMENT_MANAGER,
      functionalRoleKeys: [],
      permissionKeys: ['task.view', 'task.create', 'task.edit', 'task.assign', 'task.export'],
      moduleDataScopes: [{ moduleKey: 'task', scope: permissions.DATA_SCOPES.TEAM }],
      status: permissions.MEMBERSHIP_STATUSES.ACTIVE,
      joinedAt: new Date()
    },
    {
      _id: objectId(),
      teamId: ids.teamB,
      userId: ids.userB,
      orgUnitId: ids.orgB,
      role: permissions.MEMBERSHIP_ROLES.PROJECT_ADMIN,
      positionLevel: 1,
      positionKey: permissions.POSITION_KEYS.DEPARTMENT_MANAGER,
      functionalRoleKeys: [],
      permissionKeys: ['task.view', 'task.create', 'task.edit', 'task.assign', 'task.export'],
      moduleDataScopes: [{ moduleKey: 'task', scope: permissions.DATA_SCOPES.TEAM }],
      status: permissions.MEMBERSHIP_STATUSES.ACTIVE,
      joinedAt: new Date()
    }
  ]);
  return ids;
}

async function insertTask({ teamId, orgUnitId, userId, taskName, parentTask = null, isMainTask = true }) {
  return Task.create({
    teamId,
    orgUnitId,
    taskName,
    creator: userId,
    executor: [userId],
    mainExecutor: userId,
    ccUsers: [],
    plannedCompletionTime: new Date(Date.now() + 86400000),
    parentTask,
    isMainTask,
    status: 'in_progress',
    executorCompletions: [{ executor: userId, status: 'pending' }]
  });
}

async function insertTaskReview({ teamId, task, reviewer, content }) {
  return TaskReview.create({
    teamId,
    task,
    reviewer,
    stage: 'review',
    reviewRound: 1,
    content,
    result: 'approved'
  });
}

function binaryParser(response, callback) {
  const chunks = [];
  response.on('data', (chunk) => chunks.push(chunk));
  response.on('end', () => callback(null, Buffer.concat(chunks)));
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

test('keyword filter remains inside the active-team scope', async () => {
  await insertTask({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA,
    userId: fixture.userA,
    taskName: 'shared-keyword team A'
  });
  await insertTask({
    teamId: fixture.teamB,
    orgUnitId: fixture.orgB,
    userId: fixture.userB,
    taskName: 'shared-keyword team B secret'
  });

  const response = await request(createTestApp(
    authContext(fixture.teamA, fixture.orgA, fixture.userA)
  )).get('/tasks').query({ keyword: 'shared-keyword' }).expect(200);

  assert.equal(response.body.tasks.length, 1);
  assert.equal(response.body.tasks[0].taskName, 'shared-keyword team A');
  assert.equal(response.body.tasks[0].teamId, String(fixture.teamA));
});

test('system task creator identity is masked in create, list and detail responses', async () => {
  const systemUserId = objectId();
  const internalUsername = 'internal-task-control';
  const internalName = 'Internal Task Control';
  const internalPhone = '13800138000';
  await User.collection.insertOne({
    _id: systemUserId,
    username: internalUsername,
    usernameNormalized: internalUsername,
    password: 'not-used',
    name: internalName,
    phone: internalPhone,
    roles: ['admin'],
    isSuperAdmin: true,
    isSystemAccount: true,
    tokenVersion: 0,
    status: 'active'
  });

  const app = createTestApp(systemAuthContext(
    fixture.teamA,
    fixture.orgA,
    systemUserId,
    internalUsername
  ));
  const created = await request(app).post('/tasks').send({
    taskName: 'system-created-visible-task',
    orgUnitId: String(fixture.orgA),
    plannedCompletionTime: new Date(Date.now() + 86400000).toISOString(),
    executor: [String(fixture.userA)],
    mainExecutor: String(fixture.userA)
  }).expect(201);
  const list = await request(app).get('/tasks').expect(200);
  const detail = await request(app).get(`/tasks/${created.body.task._id}`).expect(200);

  const taskResponses = [created.body.task, list.body.tasks[0], detail.body.task];
  for (const task of taskResponses) {
    assert.equal(task.creator.name, 'System Maintenance');
    assert.equal(Object.hasOwn(task.creator, 'username'), false);
    assert.equal(Object.hasOwn(task.creator, 'phone'), false);
    assert.equal(Object.hasOwn(task.creator, 'isSystemAccount'), false);
    assert.equal(task.executor[0].name, 'Member A');
    assert.equal(task.executor[0].username, 'member-a');
  }

  const serialized = JSON.stringify({ created: created.body, list: list.body, detail: detail.body });
  assert.doesNotMatch(serialized, new RegExp(internalUsername, 'i'));
  assert.doesNotMatch(serialized, new RegExp(internalName, 'i'));
  assert.doesNotMatch(serialized, new RegExp(internalPhone));
});

test('direct access to another team task returns the same 404 as a missing task', async () => {
  const teamBTask = await insertTask({
    teamId: fixture.teamB,
    orgUnitId: fixture.orgB,
    userId: fixture.userB,
    taskName: 'team B direct access secret'
  });
  const app = createTestApp(authContext(fixture.teamA, fixture.orgA, fixture.userA));

  const crossTeam = await request(app).get(`/tasks/${teamBTask._id}`).expect(404);
  const missing = await request(app).get(`/tasks/${objectId()}`).expect(404);
  assert.equal(crossTeam.body.message, missing.body.message);
});

test('creating a task with another team member reference is rejected', async () => {
  const app = createTestApp(authContext(fixture.teamA, fixture.orgA, fixture.userA));
  const response = await request(app).post('/tasks').send({
    taskName: 'invalid assignment',
    orgUnitId: String(fixture.orgA),
    plannedCompletionTime: new Date(Date.now() + 86400000).toISOString(),
    executor: [String(fixture.userB)],
    mainExecutor: String(fixture.userB)
  }).expect(400);

  assert.equal(response.body.code, 'RELATED_RESOURCE_INVALID');
  assert.equal(await Task.countDocuments({ teamId: fixture.teamA }), 0);
});

test('TEAM scope requires an explicit task organization unit', async () => {
  const app = createTestApp(authContext(fixture.teamA, fixture.orgA, fixture.userA));
  const response = await request(app).post('/tasks').send({
    taskName: 'missing task organization',
    plannedCompletionTime: new Date(Date.now() + 86400000).toISOString(),
    executor: [String(fixture.userAOther)],
    mainExecutor: String(fixture.userAOther)
  }).expect(400);

  assert.equal(response.body.code, 'RELATED_RESOURCE_INVALID');
  assert.equal(await Task.countDocuments({ teamId: fixture.teamA }), 0);
});

test('TEAM scope can create a task owned by the selected organization', async () => {
  const managerApp = createTestApp(authContext(
    fixture.teamA,
    fixture.orgA,
    fixture.userA
  ));
  const created = await request(managerApp).post('/tasks').send({
    taskName: 'other organization visible assignment',
    orgUnitId: String(fixture.orgAOther),
    plannedCompletionTime: new Date(Date.now() + 86400000).toISOString(),
    executor: [String(fixture.userAOther)],
    mainExecutor: String(fixture.userAOther)
  }).expect(201);

  assert.equal(created.body.task.orgUnitId, String(fixture.orgAOther));
  const memberApp = createTestApp(authContext(
    fixture.teamA,
    fixture.orgAOther,
    fixture.userAOther,
    permissions.DATA_SCOPES.ORG_UNIT
  ));
  const visible = await request(memberApp)
    .get(`/tasks/${created.body.task._id}`)
    .expect(200);
  assert.equal(visible.body.task.taskName, 'other organization visible assignment');
});

test('ordinary participants must belong to the organization that owns the task', async () => {
  const app = createTestApp(authContext(fixture.teamA, fixture.orgA, fixture.userA));
  const response = await request(app).post('/tasks').send({
    taskName: 'invisible participant assignment',
    orgUnitId: String(fixture.orgA),
    plannedCompletionTime: new Date(Date.now() + 86400000).toISOString(),
    executor: [String(fixture.userAOther)],
    mainExecutor: String(fixture.userAOther)
  }).expect(400);

  assert.equal(response.body.code, 'RELATED_RESOURCE_INVALID');
  assert.equal(await Task.countDocuments({ taskName: 'invisible participant assignment' }), 0);
});

test('task organization is immutable and reassignment preserves participant visibility', async () => {
  const task = await insertTask({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA,
    userId: fixture.userA,
    taskName: 'stable task organization'
  });
  const app = createTestApp(authContext(fixture.teamA, fixture.orgA, fixture.userA));

  const moved = await request(app).put(`/tasks/${task._id}`).send({
    orgUnitId: String(fixture.orgAOther)
  }).expect(400);
  assert.equal(moved.body.code, 'TASK_ORG_UNIT_IMMUTABLE');

  const reassigned = await request(app).put(`/tasks/${task._id}`).send({
    executor: [String(fixture.userAOther)],
    mainExecutor: String(fixture.userAOther)
  }).expect(400);
  assert.equal(reassigned.body.code, 'RELATED_RESOURCE_INVALID');

  const stored = await Task.findById(task._id).lean();
  assert.equal(String(stored.orgUnitId), String(fixture.orgA));
  assert.deepEqual(stored.executor.map(String), [String(fixture.userA)]);
});

test('ORG_UNIT task assignment cannot target another organization in the same team', async () => {
  const scopedContext = authContext(
    fixture.teamA,
    fixture.orgA,
    fixture.userA,
    permissions.DATA_SCOPES.ORG_UNIT
  );
  const app = createTestApp(scopedContext);
  const rejected = await request(app).post('/tasks').send({
    taskName: 'cross organization assignment',
    plannedCompletionTime: new Date(Date.now() + 86400000).toISOString(),
    executor: [String(fixture.userAOther)],
    mainExecutor: String(fixture.userAOther)
  }).expect(400);

  assert.equal(rejected.body.code, 'RELATED_RESOURCE_INVALID');
  assert.equal(await Task.countDocuments({ teamId: fixture.teamA }), 0);
});

test('updates cannot address another team task or smuggle another team child id', async () => {
  const teamAMain = await insertTask({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA,
    userId: fixture.userA,
    taskName: 'team A immutable baseline'
  });
  const teamBTask = await insertTask({
    teamId: fixture.teamB,
    orgUnitId: fixture.orgB,
    userId: fixture.userB,
    taskName: 'team B protected task'
  });
  const app = createTestApp(authContext(fixture.teamA, fixture.orgA, fixture.userA));

  await request(app).put(`/tasks/${teamBTask._id}`).send({
    taskName: 'cross-team overwrite'
  }).expect(404);
  await request(app).put(`/tasks/${teamAMain._id}`).send({
    subTasks: [{
      _id: String(teamBTask._id),
      taskName: 'cross-team child overwrite',
      executor: String(fixture.userA)
    }]
  }).expect(404);

  assert.equal((await Task.findById(teamAMain._id)).taskName, 'team A immutable baseline');
  assert.equal((await Task.findById(teamBTask._id)).taskName, 'team B protected task');
});

test('deleting a main task only deletes children from the same team', async () => {
  const mainTask = await insertTask({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA,
    userId: fixture.userA,
    taskName: 'team A main task'
  });
  const legitimateChild = await insertTask({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA,
    userId: fixture.userA,
    taskName: 'team A child',
    parentTask: mainTask._id,
    isMainTask: false
  });
  const maliciousCrossTeamChild = await insertTask({
    teamId: fixture.teamB,
    orgUnitId: fixture.orgB,
    userId: fixture.userB,
    taskName: 'team B child with foreign parent pointer',
    parentTask: mainTask._id,
    isMainTask: false
  });
  await Promise.all([
    insertTaskReview({
      teamId: fixture.teamA,
      task: mainTask._id,
      reviewer: fixture.userA,
      content: 'main task review'
    }),
    insertTaskReview({
      teamId: fixture.teamA,
      task: legitimateChild._id,
      reviewer: fixture.userA,
      content: 'legitimate child review'
    }),
    insertTaskReview({
      teamId: fixture.teamB,
      task: maliciousCrossTeamChild._id,
      reviewer: fixture.userB,
      content: 'cross-team child review'
    })
  ]);

  await request(createTestApp(
    authContext(fixture.teamA, fixture.orgA, fixture.userA)
  )).delete(`/tasks/${mainTask._id}`).expect(200);

  assert.equal(await Task.exists({ _id: mainTask._id }), null);
  assert.equal(await Task.exists({ _id: legitimateChild._id }), null);
  assert.ok(await Task.exists({ _id: maliciousCrossTeamChild._id, teamId: fixture.teamB }));
  assert.equal(await TaskReview.countDocuments({
    teamId: fixture.teamA,
    task: { $in: [mainTask._id, legitimateChild._id] }
  }), 0);
  assert.ok(await TaskReview.exists({
    teamId: fixture.teamB,
    task: maliciousCrossTeamChild._id
  }));
});

test('removing a subtask through task editing also removes its workflow reviews', async () => {
  const mainTask = await insertTask({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA,
    userId: fixture.userA,
    taskName: 'main task with removable child'
  });
  const child = await insertTask({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA,
    userId: fixture.userA,
    taskName: 'child removed by reconciliation',
    parentTask: mainTask._id,
    isMainTask: false
  });
  await insertTaskReview({
    teamId: fixture.teamA,
    task: child._id,
    reviewer: fixture.userA,
    content: 'child review before removal'
  });

  await request(createTestApp(
    authContext(fixture.teamA, fixture.orgA, fixture.userA)
  )).put(`/tasks/${mainTask._id}`).send({ subTasks: [] }).expect(200);

  assert.equal(await Task.exists({ _id: child._id }), null);
  assert.equal(await TaskReview.exists({
    teamId: fixture.teamA,
    task: child._id
  }), null);
});

test('task deletion retains immutable review evidence in the audit log', async () => {
  const task = await insertTask({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA,
    userId: fixture.userA,
    taskName: 'task deleted after review'
  });
  const review = await insertTaskReview({
    teamId: fixture.teamA,
    task: task._id,
    reviewer: fixture.userA,
    content: 'review evidence retained in audit'
  });
  const context = authContext(fixture.teamA, fixture.orgA, fixture.userA);
  const auditService = createAuditService();
  await auditService.record({
    authContext: context,
    action: permissions.AUDIT_ACTIONS.APPROVE,
    resourceType: permissions.AUDIT_RESOURCE_TYPES.TASK_REVIEW,
    resourceId: review._id,
    after: review.toObject(),
    targetTeamId: fixture.teamA
  });

  await request(createTestApp(context, { auditService }))
    .delete(`/tasks/${task._id}`)
    .expect(200);

  assert.equal(await TaskReview.exists({ _id: review._id }), null);
  const retainedReviewAudit = await AuditLog.findOne({
    resourceType: permissions.AUDIT_RESOURCE_TYPES.TASK_REVIEW,
    resourceId: String(review._id)
  }).lean();
  assert.equal(retainedReviewAudit.after.content, 'review evidence retained in audit');
  assert.equal(await AuditLog.countDocuments({
    resourceType: permissions.AUDIT_RESOURCE_TYPES.TASK,
    resourceId: String(task._id),
    action: permissions.AUDIT_ACTIONS.DELETE
  }), 1);
});

test('task and review deletion roll back together when delete audit persistence fails', async () => {
  const task = await insertTask({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA,
    userId: fixture.userA,
    taskName: 'task protected by audit transaction'
  });
  const review = await insertTaskReview({
    teamId: fixture.teamA,
    task: task._id,
    reviewer: fixture.userA,
    content: 'review restored after rollback'
  });

  await request(createTestApp(
    authContext(fixture.teamA, fixture.orgA, fixture.userA),
    { auditService: { record: async () => { throw new Error('audit unavailable'); } } }
  )).delete(`/tasks/${task._id}`).expect(500);

  assert.ok(await Task.exists({ _id: task._id }));
  assert.ok(await TaskReview.exists({ _id: review._id }));
});

test('Excel export never includes another team task', async () => {
  await insertTask({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA,
    userId: fixture.userA,
    taskName: 'A_VISIBLE_EXPORT'
  });
  await insertTask({
    teamId: fixture.teamB,
    orgUnitId: fixture.orgB,
    userId: fixture.userB,
    taskName: 'B_SECRET_EXPORT'
  });

  const response = await request(createTestApp(
    authContext(fixture.teamA, fixture.orgA, fixture.userA)
  )).get('/tasks/export').buffer(true).parse(binaryParser).expect(200);
  const workbook = XLSX.read(response.body, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
  const serialized = JSON.stringify(rows);

  assert.match(serialized, /A_VISIBLE_EXPORT/);
  assert.doesNotMatch(serialized, /B_SECRET_EXPORT/);
});
