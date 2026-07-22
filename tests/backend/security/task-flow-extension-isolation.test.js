'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { after, before, beforeEach, test } = require('node:test');
const appRequire = require('../helpers/appRequire');

const mongoose = appRequire('mongoose');
const { MongoMemoryReplSet } = appRequire('mongodb-memory-server');
const {
  DATA_SCOPES,
  DATA_SCOPE_MODULE_VALUES,
  MEMBERSHIP_ROLES,
  MEMBERSHIP_STATUSES,
  ORG_UNIT_STATUSES,
  ORG_UNIT_TYPES,
  POSITION_KEYS,
  SESSION_MODES
} = require('../../../app/config/permissions');
const extensionController = require('../../../app/controllers/extensionController');
const taskFlowController = require('../../../app/controllers/taskFlowController');
const AuditLog = require('../../../app/models/AuditLog');
const ExtensionRequest = require('../../../app/models/ExtensionRequest');
const Message = require('../../../app/models/Message');
const OrgUnit = require('../../../app/models/OrgUnit');
const Task = require('../../../app/models/Task');
const TaskReview = require('../../../app/models/TaskReview');
const TeamMembership = require('../../../app/models/TeamMembership');
const User = require('../../../app/models/User');

const TEST_DATABASE_NAME = `task_flow_${randomUUID().replaceAll('-', '')}_v2_test`;
const IDS = Object.freeze({
  teamA: new mongoose.Types.ObjectId(),
  teamB: new mongoose.Types.ObjectId(),
  orgA: new mongoose.Types.ObjectId(),
  managerOrgA: new mongoose.Types.ObjectId(),
  orgB: new mongoose.Types.ObjectId(),
  executorA: new mongoose.Types.ObjectId(),
  reviewerA: new mongoose.Types.ObjectId(),
  creatorA: new mongoose.Types.ObjectId(),
  systemCreatorA: new mongoose.Types.ObjectId(),
  executorB: new mongoose.Types.ObjectId(),
  reviewerB: new mongoose.Types.ObjectId(),
  creatorB: new mongoose.Types.ObjectId()
});

const ALL_TASK_PERMISSIONS = Object.freeze([
  'task.view',
  'task.create',
  'task.edit',
  'task.assign',
  'task.review',
  'task.export'
]);

let replicaSet;

function moduleScopes(taskScope = DATA_SCOPES.ORG_UNIT) {
  return Object.freeze(Object.fromEntries(DATA_SCOPE_MODULE_VALUES.map((moduleKey) => [
    moduleKey,
    moduleKey === 'task' ? taskScope : DATA_SCOPES.ORG_UNIT
  ])));
}

function teamContext(userId, teamId, orgUnitId, overrides = {}) {
  return {
    authenticated: true,
    mode: SESSION_MODES.TEAM,
    activeTeamId: teamId.toString(),
    userId: userId.toString(),
    isSuperAdmin: false,
    membership: {
      _id: new mongoose.Types.ObjectId().toString(),
      teamId: teamId.toString(),
      userId: userId.toString(),
      orgUnitId: orgUnitId.toString(),
      role: MEMBERSHIP_ROLES.MEMBER,
      status: MEMBERSHIP_STATUSES.ACTIVE,
      positionLevel: 5,
      positionKey: POSITION_KEYS.EMPLOYEE
    },
    permissionKeys: [...ALL_TASK_PERMISSIONS],
    moduleDataScopes: moduleScopes(),
    ...overrides
  };
}

function superAdminTeamContext(userId, teamId) {
  return {
    authenticated: true,
    mode: SESSION_MODES.TEAM,
    activeTeamId: teamId.toString(),
    userId: userId.toString(),
    isSuperAdmin: true,
    membership: null,
    permissionKeys: [...ALL_TASK_PERMISSIONS],
    moduleDataScopes: moduleScopes(DATA_SCOPES.TEAM)
  };
}

function globalContext(userId) {
  return {
    authenticated: true,
    mode: SESSION_MODES.GLOBAL_READ_ONLY,
    activeTeamId: null,
    userId: userId.toString(),
    isSuperAdmin: true,
    membership: null,
    permissionKeys: [...ALL_TASK_PERMISSIONS],
    moduleDataScopes: Object.freeze({})
  };
}

function request({ method = 'GET', authContext, params = {}, query = {}, body = {} }) {
  return {
    method,
    authContext,
    params,
    query,
    body,
    headers: {},
    path: '/test',
    baseUrl: '/api',
    get() {
      return undefined;
    }
  };
}

function response() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

function userDocument(_id, username) {
  return {
    _id,
    username,
    usernameNormalized: username,
    password: 'not-used-by-controller-tests',
    name: username,
    roles: ['executor'],
    isSuperAdmin: false,
    tokenVersion: 0,
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date()
  };
}

function orgDocument(_id, teamId, code) {
  return {
    _id,
    teamId,
    parentId: null,
    type: ORG_UNIT_TYPES.DEPARTMENT,
    code,
    name: code,
    status: ORG_UNIT_STATUSES.ACTIVE,
    sortOrder: 0,
    level: 1,
    path: '/',
    createdAt: new Date(),
    updatedAt: new Date()
  };
}

function membershipDocument(teamId, orgUnitId, userId) {
  return {
    _id: new mongoose.Types.ObjectId(),
    teamId,
    orgUnitId,
    userId,
    role: MEMBERSHIP_ROLES.MEMBER,
    positionLevel: 5,
    positionKey: POSITION_KEYS.EMPLOYEE,
    functionalRoleKeys: [],
    permissionKeys: [...ALL_TASK_PERMISSIONS],
    moduleDataScopes: DATA_SCOPE_MODULE_VALUES.map((moduleKey) => ({
      moduleKey,
      scope: DATA_SCOPES.ORG_UNIT
    })),
    status: MEMBERSHIP_STATUSES.ACTIVE,
    joinedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date()
  };
}

async function seedIdentityFoundation() {
  await User.collection.insertMany([
    userDocument(IDS.executorA, 'executor-a'),
    userDocument(IDS.reviewerA, 'reviewer-a'),
    userDocument(IDS.creatorA, 'creator-a'),
    userDocument(IDS.executorB, 'executor-b'),
    userDocument(IDS.reviewerB, 'reviewer-b'),
    userDocument(IDS.creatorB, 'creator-b')
  ]);
  await OrgUnit.collection.insertMany([
    orgDocument(IDS.orgA, IDS.teamA, 'TEAM_A'),
    orgDocument(IDS.orgB, IDS.teamB, 'TEAM_B')
  ]);
  await TeamMembership.collection.insertMany([
    membershipDocument(IDS.teamA, IDS.orgA, IDS.executorA),
    membershipDocument(IDS.teamA, IDS.orgA, IDS.reviewerA),
    membershipDocument(IDS.teamA, IDS.orgA, IDS.creatorA),
    membershipDocument(IDS.teamB, IDS.orgB, IDS.executorB),
    membershipDocument(IDS.teamB, IDS.orgB, IDS.reviewerB),
    membershipDocument(IDS.teamB, IDS.orgB, IDS.creatorB)
  ]);
}

async function createTask({
  teamId,
  orgUnitId,
  executor,
  reviewer,
  creator,
  status = 'in_progress',
  isMainTask = true,
  parentTask = null,
  executorCompletionStatus = 'pending',
  name = 'Test task'
}) {
  return Task.create({
    teamId,
    orgUnitId,
    taskName: name,
    parentTask,
    isMainTask,
    creator,
    executor: [executor],
    mainExecutor: executor,
    ccUsers: reviewer ? [reviewer] : [],
    plannedCompletionTime: new Date('2026-08-01T00:00:00.000Z'),
    status,
    executorCompletions: [{
      executor,
      status: executorCompletionStatus,
      content: executorCompletionStatus === 'completed' ? 'initial' : null,
      attachments: [],
      completedAt: executorCompletionStatus === 'completed' ? new Date() : null
    }]
  });
}

async function moveCreatorToTeamWideManagerOrg() {
  await OrgUnit.create(orgDocument(IDS.managerOrgA, IDS.teamA, 'TEAM_A_MANAGER'));
  await TeamMembership.updateOne({
    teamId: IDS.teamA,
    userId: IDS.creatorA
  }, {
    $set: {
      orgUnitId: IDS.managerOrgA,
      role: MEMBERSHIP_ROLES.PROJECT_ADMIN,
      positionLevel: 1,
      positionKey: POSITION_KEYS.DEPARTMENT_MANAGER,
      moduleDataScopes: DATA_SCOPE_MODULE_VALUES.map((moduleKey) => ({
        moduleKey,
        scope: DATA_SCOPES.TEAM
      }))
    }
  });
}

before(async () => {
  replicaSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' }
  });
  await mongoose.connect(replicaSet.getUri(TEST_DATABASE_NAME), {
    dbName: TEST_DATABASE_NAME
  });
  await Promise.all([
    Task.syncIndexes(),
    TaskReview.syncIndexes(),
    ExtensionRequest.syncIndexes(),
    Message.syncIndexes(),
    AuditLog.syncIndexes()
  ]);
});

beforeEach(async () => {
  await Promise.all([
    AuditLog.collection.deleteMany({}),
    ExtensionRequest.collection.deleteMany({}),
    Message.collection.deleteMany({}),
    OrgUnit.collection.deleteMany({}),
    Task.collection.deleteMany({}),
    TaskReview.collection.deleteMany({}),
    TeamMembership.collection.deleteMany({}),
    User.collection.deleteMany({})
  ]);
  await seedIdentityFoundation();
});

after(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replicaSet) await replicaSet.stop();
});

test('completion and completion updates cannot mutate a task in team B', async () => {
  const taskA = await createTask({
    teamId: IDS.teamA,
    orgUnitId: IDS.orgA,
    executor: IDS.executorA,
    reviewer: IDS.reviewerA,
    creator: IDS.creatorA,
    name: 'A completion'
  });
  const taskB = await createTask({
    teamId: IDS.teamB,
    orgUnitId: IDS.orgB,
    executor: IDS.executorB,
    reviewer: IDS.reviewerB,
    creator: IDS.creatorB,
    name: 'B completion'
  });
  const executorContext = teamContext(IDS.executorA, IDS.teamA, IDS.orgA);

  const deniedComplete = response();
  await taskFlowController.completeTask(request({
    method: 'POST',
    authContext: executorContext,
    params: { id: taskB._id.toString() },
    body: { completionNote: 'must not cross teams' }
  }), deniedComplete);
  assert.equal(deniedComplete.statusCode, 404);
  assert.equal((await Task.findById(taskB._id)).status, 'in_progress');
  assert.equal(await Message.countDocuments({ teamId: IDS.teamB }), 0);

  const completed = response();
  await taskFlowController.completeTask(request({
    method: 'POST',
    authContext: executorContext,
    params: { id: taskA._id.toString() },
    body: { completionNote: 'done in A' }
  }), completed);
  assert.equal(completed.statusCode, 200);
  assert.equal((await Task.findById(taskA._id)).status, 'pending_review');
  assert.equal(await Message.countDocuments({ teamId: IDS.teamA }), 1);

  const editableA = await createTask({
    teamId: IDS.teamA,
    orgUnitId: IDS.orgA,
    executor: IDS.executorA,
    reviewer: IDS.reviewerA,
    creator: IDS.creatorA,
    executorCompletionStatus: 'completed',
    name: 'A editable completion'
  });
  const editableB = await createTask({
    teamId: IDS.teamB,
    orgUnitId: IDS.orgB,
    executor: IDS.executorB,
    reviewer: IDS.reviewerB,
    creator: IDS.creatorB,
    executorCompletionStatus: 'completed',
    name: 'B editable completion'
  });

  const deniedUpdate = response();
  await taskFlowController.updateCompletion(request({
    method: 'PUT',
    authContext: executorContext,
    params: { id: editableB._id.toString() },
    body: { completionNote: 'cross-team overwrite' }
  }), deniedUpdate);
  assert.equal(deniedUpdate.statusCode, 404);
  assert.equal((await Task.findById(editableB._id)).executorCompletions[0].content, 'initial');

  const allowedUpdate = response();
  await taskFlowController.updateCompletion(request({
    method: 'PUT',
    authContext: executorContext,
    params: { id: editableA._id.toString() },
    body: { completionNote: 'updated in A' }
  }), allowedUpdate);
  assert.equal(allowedUpdate.statusCode, 200);
  assert.equal((await Task.findById(editableA._id)).executorCompletions[0].content, 'updated in A');
});

test('child-organization task workflows accept a team-wide creator in another organization', async () => {
  await moveCreatorToTeamWideManagerOrg();

  const extensionTask = await createTask({
    teamId: IDS.teamA,
    orgUnitId: IDS.orgA,
    executor: IDS.executorA,
    reviewer: IDS.reviewerA,
    creator: IDS.creatorA,
    name: 'Team manager extension task'
  });
  const executorContext = teamContext(IDS.executorA, IDS.teamA, IDS.orgA);
  const applied = response();
  await extensionController.applyExtension(request({
    method: 'POST',
    authContext: executorContext,
    params: { id: extensionTask._id.toString() },
    body: { reason: 'valid child organization request', requestedDays: 2 }
  }), applied);
  assert.equal(applied.statusCode, 201);
  assert.equal((await Task.findById(extensionTask._id)).status, 'extension_pending');

  const workflowTask = await createTask({
    teamId: IDS.teamA,
    orgUnitId: IDS.orgA,
    executor: IDS.executorA,
    reviewer: IDS.reviewerA,
    creator: IDS.creatorA,
    name: 'Team manager completion task'
  });
  const completed = response();
  await taskFlowController.completeTask(request({
    method: 'POST',
    authContext: executorContext,
    params: { id: workflowTask._id.toString() },
    body: { completionNote: 'completed below a team-wide creator' }
  }), completed);
  assert.equal(completed.statusCode, 200);
  assert.equal((await Task.findById(workflowTask._id)).status, 'pending_review');

  const reviewed = response();
  await taskFlowController.reviewTask(request({
    method: 'POST',
    authContext: teamContext(IDS.reviewerA, IDS.teamA, IDS.orgA),
    params: { id: workflowTask._id.toString() },
    body: { result: 'approved', content: 'approved in child organization' }
  }), reviewed);
  assert.equal(reviewed.statusCode, 200);
  assert.equal((await Task.findById(workflowTask._id)).status, 'pending_confirm');
});

test('tasks created by a team-mode super administrator do not require creator membership', async () => {
  await User.collection.insertOne({
    ...userDocument(IDS.systemCreatorA, 'system-creator-a'),
    roles: ['admin'],
    isSuperAdmin: true,
    isSystemAccount: true
  });
  assert.equal(await TeamMembership.countDocuments({ userId: IDS.systemCreatorA }), 0);

  const task = await createTask({
    teamId: IDS.teamA,
    orgUnitId: IDS.orgA,
    executor: IDS.executorA,
    reviewer: IDS.reviewerA,
    creator: IDS.systemCreatorA,
    name: 'System-created workflow task'
  });
  const executorContext = teamContext(IDS.executorA, IDS.teamA, IDS.orgA);
  const reviewerContext = teamContext(IDS.reviewerA, IDS.teamA, IDS.orgA);
  const creatorContext = superAdminTeamContext(IDS.systemCreatorA, IDS.teamA);

  const applied = response();
  await extensionController.applyExtension(request({
    method: 'POST',
    authContext: executorContext,
    params: { id: task._id.toString() },
    body: { reason: 'System creator has no membership', requestedDays: 1 }
  }), applied);
  assert.equal(applied.statusCode, 201);

  const extensionRequest = await ExtensionRequest.findOne({ task: task._id });
  const approved = response();
  await extensionController.approveExtension(request({
    method: 'POST',
    authContext: creatorContext,
    params: { id: extensionRequest._id.toString() },
    body: { status: 'approved', approvedDays: 1, approvalNote: 'approved by creator' }
  }), approved);
  assert.equal(approved.statusCode, 200);
  assert.equal((await Task.findById(task._id)).status, 'in_progress');

  const completed = response();
  await taskFlowController.completeTask(request({
    method: 'POST',
    authContext: executorContext,
    params: { id: task._id.toString() },
    body: { completionNote: 'completed under a system creator' }
  }), completed);
  assert.equal(completed.statusCode, 200);
  assert.equal((await Task.findById(task._id)).status, 'pending_review');

  const reviewed = response();
  await taskFlowController.reviewTask(request({
    method: 'POST',
    authContext: reviewerContext,
    params: { id: task._id.toString() },
    body: { result: 'approved', content: 'reviewed under a system creator' }
  }), reviewed);
  assert.equal(reviewed.statusCode, 200);
  assert.equal((await Task.findById(task._id)).status, 'pending_confirm');

  const confirmed = response();
  await taskFlowController.confirmTask(request({
    method: 'POST',
    authContext: creatorContext,
    params: { id: task._id.toString() }
  }), confirmed);
  assert.equal(confirmed.statusCode, 200);
  assert.equal((await Task.findById(task._id)).status, 'finished');
  assert.equal((await ExtensionRequest.findById(extensionRequest._id)).status, 'approved');

  const messageTypes = await Message.find({ teamId: IDS.teamA }).distinct('type');
  assert.deepEqual(new Set(messageTypes), new Set([
    'extension_applied',
    'extension_approved',
    'task_completed',
    'task_reviewed',
    'task_confirmed'
  ]));
});

test('a view-only executor can complete only their own assignment without task.edit', async () => {
  const assignedTask = await createTask({
    teamId: IDS.teamA,
    orgUnitId: IDS.orgA,
    executor: IDS.executorA,
    reviewer: IDS.reviewerA,
    creator: IDS.creatorA,
    name: 'View-only executor assignment'
  });
  const otherTask = await createTask({
    teamId: IDS.teamA,
    orgUnitId: IDS.orgA,
    executor: IDS.reviewerA,
    reviewer: null,
    creator: IDS.creatorA,
    name: 'Another executor assignment'
  });
  const executorContext = teamContext(IDS.executorA, IDS.teamA, IDS.orgA, {
    permissionKeys: ['task.view']
  });

  const completed = response();
  await taskFlowController.completeTask(request({
    method: 'POST',
    authContext: executorContext,
    params: { id: assignedTask._id.toString() },
    body: { completionNote: 'completed without task.edit' }
  }), completed);
  assert.equal(completed.statusCode, 200);
  assert.equal((await Task.findById(assignedTask._id)).status, 'pending_review');

  const denied = response();
  await taskFlowController.completeTask(request({
    method: 'POST',
    authContext: executorContext,
    params: { id: otherTask._id.toString() },
    body: { completionNote: 'must not complete another assignment' }
  }), denied);
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.body.code, 'TASK_EXECUTOR_REQUIRED');
  assert.equal((await Task.findById(otherTask._id)).status, 'in_progress');

  const duplicate = response();
  await taskFlowController.completeTask(request({
    method: 'POST',
    authContext: executorContext,
    params: { id: assignedTask._id.toString() },
    body: { completionNote: 'must not resubmit' }
  }), duplicate);
  assert.equal(duplicate.statusCode, 400);
  assert.equal(duplicate.body.code, 'TASK_COMPLETION_ALREADY_SUBMITTED');
});

test('a view-only executor can update their submitted record while another executor is pending', async () => {
  const task = await createTask({
    teamId: IDS.teamA,
    orgUnitId: IDS.orgA,
    executor: IDS.executorA,
    reviewer: null,
    creator: IDS.creatorA,
    name: 'Multi-executor completion update'
  });
  task.executor = [IDS.executorA, IDS.reviewerA];
  task.executorCompletions = [
    { executor: IDS.executorA, status: 'pending', attachments: [] },
    { executor: IDS.reviewerA, status: 'pending', attachments: [] }
  ];
  await task.save();

  const executorContext = teamContext(IDS.executorA, IDS.teamA, IDS.orgA, {
    permissionKeys: ['task.view']
  });
  const completed = response();
  await taskFlowController.completeTask(request({
    method: 'POST',
    authContext: executorContext,
    params: { id: task._id.toString() },
    body: { completionNote: 'first submission' }
  }), completed);
  assert.equal(completed.statusCode, 200);
  assert.equal(completed.body.completionStatus.allCompleted, false);

  const updated = response();
  await taskFlowController.updateCompletion(request({
    method: 'PUT',
    authContext: executorContext,
    params: { id: task._id.toString() },
    body: { completionNote: 'corrected submission' }
  }), updated);
  assert.equal(updated.statusCode, 200);
  const stored = await Task.findById(task._id);
  const ownCompletion = stored.executorCompletions.find(
    (entry) => entry.executor.toString() === IDS.executorA.toString()
  );
  assert.equal(ownCompletion.content, 'corrected submission');
});

test('a rejected CC review reopens a new round that can be resubmitted and reviewed again', async () => {
  const task = await createTask({
    teamId: IDS.teamA,
    orgUnitId: IDS.orgA,
    executor: IDS.executorA,
    reviewer: IDS.reviewerA,
    creator: IDS.creatorA,
    status: 'pending_review',
    executorCompletionStatus: 'completed',
    name: 'Strict review sequence'
  });
  const reviewerContext = teamContext(IDS.reviewerA, IDS.teamA, IDS.orgA);
  const creatorContext = teamContext(IDS.creatorA, IDS.teamA, IDS.orgA);
  const executorContext = teamContext(IDS.executorA, IDS.teamA, IDS.orgA, {
    permissionKeys: ['task.view']
  });
  task.actualCompletionTime = new Date('2026-07-18T08:00:00.000Z');
  task.completedBy = IDS.executorA;
  task.completionNote = 'Initial submitted completion';
  await task.save();
  const initialCompletedAt = task.executorCompletions[0].completedAt;

  const invalidDecision = response();
  await taskFlowController.reviewTask(request({
    method: 'POST',
    authContext: reviewerContext,
    params: { id: task._id.toString() },
    body: { content: 'must not create a pending review', result: 'pending' }
  }), invalidDecision);
  assert.equal(invalidDecision.statusCode, 400);
  assert.equal(invalidDecision.body.code, 'TASK_FLOW_INVALID');
  assert.equal(await TaskReview.countDocuments({ task: task._id }), 0);
  assert.equal((await Task.findById(task._id)).status, 'pending_review');

  const bypassedConfirmation = response();
  await taskFlowController.confirmTask(request({
    method: 'POST',
    authContext: creatorContext,
    params: { id: task._id.toString() }
  }), bypassedConfirmation);
  assert.equal(bypassedConfirmation.statusCode, 400);
  assert.equal(bypassedConfirmation.body.code, 'TASK_FLOW_INVALID');
  assert.equal((await Task.findById(task._id)).status, 'pending_review');

  const rejected = response();
  await taskFlowController.reviewTask(request({
    method: 'POST',
    authContext: reviewerContext,
    params: { id: task._id.toString() },
    body: { content: 'Please correct the completion evidence', result: 'rejected' }
  }), rejected);
  assert.equal(rejected.statusCode, 200);
  assert.equal(rejected.body.message, 'Task returned for revision');

  let stored = await Task.findById(task._id);
  assert.equal(stored.status, 'in_progress');
  assert.equal(stored.reviewRound, 2);
  assert.equal(stored.executorCompletions[0].status, 'pending');
  assert.equal(stored.executorCompletions[0].content, 'initial');
  assert.equal(stored.executorCompletions[0].completedAt, null);
  assert.equal(stored.actualCompletionTime, null);
  assert.equal(stored.completedBy, null);
  assert.equal(stored.completionNote, null);
  assert.deepEqual(stored.completionAttachments, []);
  const rejectedReview = await TaskReview.findOne({ task: task._id, result: 'rejected' }).lean();
  assert.equal(rejectedReview.stage, 'review');
  assert.equal(rejectedReview.reviewRound, 1);
  assert.equal(await AuditLog.countDocuments({
    resourceType: 'TASK_REVIEW',
    resourceId: rejectedReview._id,
    action: 'REJECT'
  }), 1);
  assert.equal(await Message.countDocuments({
    teamId: IDS.teamA,
    type: 'task_updated',
    recipient: IDS.executorA,
    relatedTask: task._id
  }), 1);
  const taskRejectionAudit = await AuditLog.findOne({
    resourceType: 'TASK',
    resourceId: task._id,
    action: 'STATUS_CHANGE'
  }).lean();
  assert.equal(
    new Date(taskRejectionAudit.before.executorCompletions[0].completedAt).getTime(),
    initialCompletedAt.getTime()
  );
  assert.equal(taskRejectionAudit.after.executorCompletions[0].completedAt, null);

  const rejectedConfirmation = response();
  await taskFlowController.confirmTask(request({
    method: 'POST',
    authContext: creatorContext,
    params: { id: task._id.toString() }
  }), rejectedConfirmation);
  assert.equal(rejectedConfirmation.statusCode, 400);
  assert.equal((await Task.findById(task._id)).status, 'in_progress');

  const resubmitted = response();
  await taskFlowController.completeTask(request({
    method: 'POST',
    authContext: executorContext,
    params: { id: task._id.toString() },
    body: { completionNote: 'Corrected completion evidence' }
  }), resubmitted);
  assert.equal(resubmitted.statusCode, 200);
  stored = await Task.findById(task._id);
  assert.equal(stored.status, 'pending_review');
  assert.equal(stored.reviewRound, 2);
  assert.equal(stored.executorCompletions[0].status, 'completed');
  assert.ok(stored.executorCompletions[0].completedAt instanceof Date);

  const approved = response();
  await taskFlowController.reviewTask(request({
    method: 'POST',
    authContext: reviewerContext,
    params: { id: task._id.toString() },
    body: { content: 'Corrected evidence accepted', result: 'approved' }
  }), approved);
  assert.equal(approved.statusCode, 200);
  assert.equal((await Task.findById(task._id)).status, 'pending_confirm');

  const confirmed = response();
  await taskFlowController.confirmTask(request({
    method: 'POST',
    authContext: creatorContext,
    params: { id: task._id.toString() },
    body: { content: 'Final confirmation after correction' }
  }), confirmed);
  assert.equal(confirmed.statusCode, 200);
  assert.equal((await Task.findById(task._id)).status, 'finished');

  const reviews = await TaskReview.find({ task: task._id })
    .sort({ reviewRound: 1, reviewTime: 1 })
    .lean();
  assert.deepEqual(
    reviews.map(({ reviewRound, stage, result }) => `${reviewRound}:${stage}:${result}`),
    [
      '1:review:rejected',
      '2:review:approved',
      '2:confirmation:approved'
    ]
  );
});

test('final confirmation uses creator or administrator resource authorization without task.review', async () => {
  const createPendingConfirmationTask = (name) => createTask({
    teamId: IDS.teamA,
    orgUnitId: IDS.orgA,
    executor: IDS.executorA,
    reviewer: IDS.reviewerA,
    creator: IDS.creatorA,
    status: 'pending_confirm',
    executorCompletionStatus: 'completed',
    name
  });

  const creatorTask = await createPendingConfirmationTask('Creator confirms without review permission');
  const creatorContext = teamContext(IDS.creatorA, IDS.teamA, IDS.orgA, {
    permissionKeys: ['task.view', 'task.create']
  });
  const creatorConfirmation = response();
  await taskFlowController.confirmTask(request({
    method: 'POST',
    authContext: creatorContext,
    params: { id: creatorTask._id.toString() }
  }), creatorConfirmation);
  assert.equal(creatorConfirmation.statusCode, 200);
  assert.equal((await Task.findById(creatorTask._id)).status, 'finished');

  const deniedTask = await createPendingConfirmationTask('Member cannot confirm another creator task');
  const memberContext = teamContext(IDS.reviewerA, IDS.teamA, IDS.orgA, {
    permissionKeys: ['task.view']
  });
  const deniedConfirmation = response();
  await taskFlowController.confirmTask(request({
    method: 'POST',
    authContext: memberContext,
    params: { id: deniedTask._id.toString() }
  }), deniedConfirmation);
  assert.equal(deniedConfirmation.statusCode, 403);
  assert.equal(deniedConfirmation.body.code, 'TASK_CONFIRMATION_DENIED');
  assert.equal((await Task.findById(deniedTask._id)).status, 'pending_confirm');

  const projectAdminTask = await createPendingConfirmationTask('Project admin confirms without review permission');
  const projectAdminContext = teamContext(IDS.reviewerA, IDS.teamA, IDS.orgA, {
    permissionKeys: ['task.view']
  });
  projectAdminContext.membership.role = MEMBERSHIP_ROLES.PROJECT_ADMIN;
  const projectAdminConfirmation = response();
  await taskFlowController.confirmTask(request({
    method: 'POST',
    authContext: projectAdminContext,
    params: { id: projectAdminTask._id.toString() }
  }), projectAdminConfirmation);
  assert.equal(projectAdminConfirmation.statusCode, 200);
  assert.equal((await Task.findById(projectAdminTask._id)).status, 'finished');

  const superAdminTask = await createPendingConfirmationTask('Super admin confirms without review permission');
  const superAdminContext = {
    ...superAdminTeamContext(IDS.reviewerA, IDS.teamA),
    permissionKeys: ['task.view']
  };
  const superAdminConfirmation = response();
  await taskFlowController.confirmTask(request({
    method: 'POST',
    authContext: superAdminContext,
    params: { id: superAdminTask._id.toString() }
  }), superAdminConfirmation);
  assert.equal(superAdminConfirmation.statusCode, 200);
  assert.equal((await Task.findById(superAdminTask._id)).status, 'finished');
});

test('extension requests cannot interleave with completion or later workflow states', async () => {
  const applicantContext = teamContext(IDS.executorA, IDS.teamA, IDS.orgA);
  const creatorContext = teamContext(IDS.creatorA, IDS.teamA, IDS.orgA);

  for (const status of [
    'partial_completed',
    'completed',
    'pending_review',
    'pending_confirm',
    'finished'
  ]) {
    const task = await createTask({
      teamId: IDS.teamA,
      orgUnitId: IDS.orgA,
      executor: IDS.executorA,
      reviewer: IDS.reviewerA,
      creator: IDS.creatorA,
      status,
      name: `Extension blocked from ${status}`
    });
    const denied = response();
    await extensionController.applyExtension(request({
      method: 'POST',
      authContext: applicantContext,
      params: { id: task._id.toString() },
      body: { reason: `invalid state ${status}`, requestedDays: 1 }
    }), denied);
    assert.equal(denied.statusCode, 400, status);
    assert.equal(denied.body.code, 'EXTENSION_TASK_STATE_INVALID', status);
    assert.equal((await Task.findById(task._id)).status, status);
  }

  const previouslyCompleted = await createTask({
    teamId: IDS.teamA,
    orgUnitId: IDS.orgA,
    executor: IDS.executorA,
    reviewer: IDS.reviewerA,
    creator: IDS.creatorA,
    executorCompletionStatus: 'completed',
    name: 'Extension blocked by completion record'
  });
  const completedRecordDenied = response();
  await extensionController.applyExtension(request({
    method: 'POST',
    authContext: applicantContext,
    params: { id: previouslyCompleted._id.toString() },
    body: { reason: 'completion already submitted', requestedDays: 1 }
  }), completedRecordDenied);
  assert.equal(completedRecordDenied.statusCode, 400);
  assert.equal(completedRecordDenied.body.code, 'EXTENSION_TASK_STATE_INVALID');
  assert.equal(await ExtensionRequest.countDocuments({ task: previouslyCompleted._id }), 0);

  const pendingExtensionTask = await createTask({
    teamId: IDS.teamA,
    orgUnitId: IDS.orgA,
    executor: IDS.executorA,
    reviewer: IDS.reviewerA,
    creator: IDS.creatorA,
    name: 'Pending extension completion lock'
  });
  const applied = response();
  await extensionController.applyExtension(request({
    method: 'POST',
    authContext: applicantContext,
    params: { id: pendingExtensionTask._id.toString() },
    body: { reason: 'valid pending extension', requestedDays: 2 }
  }), applied);
  assert.equal(applied.statusCode, 201);

  const completionDuringExtension = response();
  await taskFlowController.completeTask(request({
    method: 'POST',
    authContext: applicantContext,
    params: { id: pendingExtensionTask._id.toString() },
    body: { completionNote: 'must wait for extension decision' }
  }), completionDuringExtension);
  assert.equal(completionDuringExtension.statusCode, 400);
  assert.equal(completionDuringExtension.body.code, 'TASK_EXTENSION_PENDING');
  assert.equal((await Task.findById(pendingExtensionTask._id)).status, 'extension_pending');

  const pendingRequest = await ExtensionRequest.findOne({ task: pendingExtensionTask._id });
  await Task.updateOne({ _id: pendingExtensionTask._id }, {
    $set: {
      'executorCompletions.0.status': 'completed',
      'executorCompletions.0.completedAt': new Date(),
      'executorCompletions.0.content': 'legacy inconsistent completion'
    }
  });
  const originalTime = pendingExtensionTask.plannedCompletionTime.getTime();
  const unsafeApproval = response();
  await extensionController.approveExtension(request({
    method: 'POST',
    authContext: creatorContext,
    params: { id: pendingRequest._id.toString() },
    body: { status: 'approved', approvedDays: 2 }
  }), unsafeApproval);
  assert.equal(unsafeApproval.statusCode, 400);
  assert.equal(unsafeApproval.body.code, 'EXTENSION_TASK_STATE_INVALID');
  const unchangedTask = await Task.findById(pendingExtensionTask._id);
  assert.equal(unchangedTask.status, 'extension_pending');
  assert.equal(unchangedTask.plannedCompletionTime.getTime(), originalTime);
  assert.equal((await ExtensionRequest.findById(pendingRequest._id)).status, 'pending');
});

test('a view-only responsible owner can request an extension only for their own task', async () => {
  const ownedTask = await createTask({
    teamId: IDS.teamA,
    orgUnitId: IDS.orgA,
    executor: IDS.executorA,
    reviewer: IDS.reviewerA,
    creator: IDS.creatorA,
    name: 'View-only owner extension'
  });
  const otherTask = await createTask({
    teamId: IDS.teamA,
    orgUnitId: IDS.orgA,
    executor: IDS.reviewerA,
    reviewer: IDS.executorA,
    creator: IDS.creatorA,
    name: 'Another owner extension'
  });
  const applicantContext = teamContext(IDS.executorA, IDS.teamA, IDS.orgA, {
    permissionKeys: ['task.view']
  });

  const applied = response();
  await extensionController.applyExtension(request({
    method: 'POST',
    authContext: applicantContext,
    params: { id: ownedTask._id.toString() },
    body: { reason: 'Need one more day', requestedDays: 1 }
  }), applied);
  assert.equal(applied.statusCode, 201);
  assert.equal((await Task.findById(ownedTask._id)).status, 'extension_pending');

  const denied = response();
  await extensionController.applyExtension(request({
    method: 'POST',
    authContext: applicantContext,
    params: { id: otherTask._id.toString() },
    body: { reason: 'Must not request for another owner', requestedDays: 1 }
  }), denied);
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.body.code, 'EXTENSION_APPLICANT_DENIED');
  assert.equal((await Task.findById(otherTask._id)).status, 'in_progress');
});

test('concurrent completion, confirmation, and extension submissions commit once', async () => {
  const executorContext = teamContext(IDS.executorA, IDS.teamA, IDS.orgA, {
    permissionKeys: ['task.view']
  });
  const creatorContext = teamContext(IDS.creatorA, IDS.teamA, IDS.orgA);
  const completionTask = await createTask({
    teamId: IDS.teamA,
    orgUnitId: IDS.orgA,
    executor: IDS.executorA,
    reviewer: null,
    creator: IDS.creatorA,
    name: 'Concurrent completion task'
  });

  const completionResponses = [response(), response()];
  await Promise.all(completionResponses.map((targetResponse) => (
    taskFlowController.completeTask(request({
      method: 'POST',
      authContext: executorContext,
      params: { id: completionTask._id.toString() },
      body: { completionNote: 'single committed completion' }
    }), targetResponse)
  )));
  assert.equal(completionResponses.filter(({ statusCode }) => statusCode === 200).length, 1);
  assert.equal(completionResponses.some(({ statusCode }) => statusCode >= 500), false);
  assert.equal((await Task.findById(completionTask._id)).status, 'pending_confirm');
  assert.equal(await AuditLog.countDocuments({
    resourceType: 'TASK',
    resourceId: completionTask._id,
    action: 'SUBMIT'
  }), 1);

  const confirmationResponses = [response(), response()];
  await Promise.all(confirmationResponses.map((targetResponse) => (
    taskFlowController.confirmTask(request({
      method: 'POST',
      authContext: creatorContext,
      params: { id: completionTask._id.toString() }
    }), targetResponse)
  )));
  assert.equal(confirmationResponses.filter(({ statusCode }) => statusCode === 200).length, 1);
  assert.equal(confirmationResponses.some(({ statusCode }) => statusCode >= 500), false);
  assert.equal((await Task.findById(completionTask._id)).status, 'finished');

  const extensionTask = await createTask({
    teamId: IDS.teamA,
    orgUnitId: IDS.orgA,
    executor: IDS.executorA,
    reviewer: null,
    creator: IDS.creatorA,
    name: 'Concurrent extension task'
  });
  const extensionResponses = [response(), response()];
  await Promise.all(extensionResponses.map((targetResponse) => (
    extensionController.applyExtension(request({
      method: 'POST',
      authContext: executorContext,
      params: { id: extensionTask._id.toString() },
      body: { reason: 'single extension request', requestedDays: 1 }
    }), targetResponse)
  )));
  assert.equal(extensionResponses.filter(({ statusCode }) => statusCode === 201).length, 1);
  assert.equal(extensionResponses.some(({ statusCode }) => statusCode >= 500), false);
  assert.equal(await ExtensionRequest.countDocuments({ task: extensionTask._id }), 1);
  assert.equal((await Task.findById(extensionTask._id)).status, 'extension_pending');
});

test('review, review history and confirmation stay inside the active team', async () => {
  const taskA = await createTask({
    teamId: IDS.teamA,
    orgUnitId: IDS.orgA,
    executor: IDS.executorA,
    reviewer: IDS.reviewerA,
    creator: IDS.creatorA,
    status: 'pending_review',
    executorCompletionStatus: 'completed',
    name: 'A review'
  });
  const taskB = await createTask({
    teamId: IDS.teamB,
    orgUnitId: IDS.orgB,
    executor: IDS.executorB,
    reviewer: IDS.reviewerB,
    creator: IDS.creatorB,
    status: 'pending_review',
    executorCompletionStatus: 'completed',
    name: 'B review'
  });
  const reviewerContext = teamContext(IDS.reviewerA, IDS.teamA, IDS.orgA);

  const deniedReview = response();
  await taskFlowController.reviewTask(request({
    method: 'POST',
    authContext: reviewerContext,
    params: { id: taskB._id.toString() },
    body: { content: 'must not review B', result: 'approved' }
  }), deniedReview);
  assert.equal(deniedReview.statusCode, 404);
  assert.equal(await TaskReview.countDocuments({ teamId: IDS.teamB }), 0);
  assert.equal((await Task.findById(taskB._id)).status, 'pending_review');

  const reviewed = response();
  await taskFlowController.reviewTask(request({
    method: 'POST',
    authContext: reviewerContext,
    params: { id: taskA._id.toString() },
    body: { content: 'approved inside team A', result: 'approved' }
  }), reviewed);
  assert.equal(reviewed.statusCode, 200);
  const review = await TaskReview.findOne({ task: taskA._id });
  assert.equal(review.teamId.toString(), IDS.teamA.toString());
  assert.equal((await Task.findById(taskA._id)).status, 'pending_confirm');

  const deniedHistory = response();
  await taskFlowController.getTaskReviews(request({
    authContext: reviewerContext,
    params: { id: taskB._id.toString() }
  }), deniedHistory);
  assert.equal(deniedHistory.statusCode, 404);

  const history = response();
  await taskFlowController.getTaskReviews(request({
    authContext: reviewerContext,
    params: { id: taskA._id.toString() }
  }), history);
  assert.equal(history.statusCode, 200);
  assert.equal(history.body.reviews.length, 1);
  assert.equal(history.body.reviews[0].teamId.toString(), IDS.teamA.toString());

  const creatorContext = teamContext(IDS.creatorA, IDS.teamA, IDS.orgA);
  const deniedConfirm = response();
  await taskFlowController.confirmTask(request({
    method: 'POST',
    authContext: creatorContext,
    params: { id: taskB._id.toString() }
  }), deniedConfirm);
  assert.equal(deniedConfirm.statusCode, 404);
  assert.equal((await Task.findById(taskB._id)).status, 'pending_review');

  const confirmed = response();
  await taskFlowController.confirmTask(request({
    method: 'POST',
    authContext: creatorContext,
    params: { id: taskA._id.toString() }
  }), confirmed);
  assert.equal(confirmed.statusCode, 200);
  assert.equal((await Task.findById(taskA._id)).status, 'finished');
  assert.equal(await Message.countDocuments({ teamId: IDS.teamB }), 0);
});

test('the same actor may review as a CC user and then perform final confirmation', async () => {
  const task = await createTask({
    teamId: IDS.teamA,
    orgUnitId: IDS.orgA,
    executor: IDS.executorA,
    reviewer: IDS.creatorA,
    creator: IDS.creatorA,
    status: 'pending_review',
    executorCompletionStatus: 'completed',
    name: 'Same reviewer and confirmer'
  });
  const actorContext = teamContext(IDS.creatorA, IDS.teamA, IDS.orgA);

  const reviewed = response();
  await taskFlowController.reviewTask(request({
    method: 'POST',
    authContext: actorContext,
    params: { id: task._id.toString() },
    body: { content: 'CC review approved', result: 'approved', rating: 4 }
  }), reviewed);
  assert.equal(reviewed.statusCode, 200);
  assert.equal((await Task.findById(task._id)).status, 'pending_confirm');

  const confirmed = response();
  await taskFlowController.confirmTask(request({
    method: 'POST',
    authContext: actorContext,
    params: { id: task._id.toString() },
    body: { content: 'Final confirmation approved', rating: 5 }
  }), confirmed);
  assert.equal(confirmed.statusCode, 200);
  assert.equal((await Task.findById(task._id)).status, 'finished');

  const reviews = await TaskReview.find({ task: task._id }).sort({ reviewTime: 1 }).lean();
  assert.deepEqual(reviews.map(({ stage }) => stage), ['review', 'confirmation']);
  assert.deepEqual(reviews.map(({ reviewer }) => reviewer.toString()), [
    IDS.creatorA.toString(),
    IDS.creatorA.toString()
  ]);
});

test('final confirmation always records the current review round without client content', async () => {
  const task = await createTask({
    teamId: IDS.teamA,
    orgUnitId: IDS.orgA,
    executor: IDS.executorA,
    reviewer: null,
    creator: IDS.creatorA,
    status: 'pending_confirm',
    executorCompletionStatus: 'completed',
    name: 'Confirmation with default content'
  });
  task.reviewRound = 3;
  await task.save();

  const confirmed = response();
  await taskFlowController.confirmTask(request({
    method: 'POST',
    authContext: teamContext(IDS.creatorA, IDS.teamA, IDS.orgA),
    params: { id: task._id.toString() },
    body: {}
  }), confirmed);

  assert.equal(confirmed.statusCode, 200);
  const confirmation = await TaskReview.findOne({
    task: task._id,
    stage: 'confirmation'
  }).lean();
  assert.equal(confirmation.reviewRound, 3);
  assert.equal(confirmation.reviewer.toString(), IDS.creatorA.toString());
  assert.equal(confirmation.result, 'approved');
  assert.equal(confirmation.content, '已确认任务完成');
});

test('child completion only advances a parent to confirmation and never replaces explicit confirmation', async () => {
  const parent = await createTask({
    teamId: IDS.teamA,
    orgUnitId: IDS.orgA,
    executor: IDS.executorA,
    reviewer: null,
    creator: IDS.creatorA,
    status: 'pending_confirm',
    executorCompletionStatus: 'completed',
    name: 'Parent requiring explicit confirmation'
  });
  parent.actualCompletionTime = new Date('2026-07-20T08:00:00.000Z');
  await parent.save();
  const child = await createTask({
    teamId: IDS.teamA,
    orgUnitId: IDS.orgA,
    executor: IDS.executorA,
    reviewer: IDS.reviewerA,
    creator: IDS.creatorA,
    status: 'pending_review',
    isMainTask: false,
    parentTask: parent._id,
    executorCompletionStatus: 'completed',
    name: 'Child awaiting review'
  });
  const creatorContext = teamContext(IDS.creatorA, IDS.teamA, IDS.orgA);
  const reviewerContext = teamContext(IDS.reviewerA, IDS.teamA, IDS.orgA);
  const executorContext = teamContext(IDS.executorA, IDS.teamA, IDS.orgA, {
    permissionKeys: ['task.view']
  });

  const prematureParentConfirmation = response();
  await taskFlowController.confirmTask(request({
    method: 'POST',
    authContext: creatorContext,
    params: { id: parent._id.toString() }
  }), prematureParentConfirmation);
  assert.equal(prematureParentConfirmation.statusCode, 400);
  assert.equal(prematureParentConfirmation.body.code, 'TASK_SUBTASKS_UNFINISHED');
  assert.equal((await Task.findById(parent._id)).status, 'pending_confirm');

  const rejectedChild = response();
  await taskFlowController.reviewTask(request({
    method: 'POST',
    authContext: reviewerContext,
    params: { id: child._id.toString() },
    body: { content: 'Child needs correction', result: 'rejected' }
  }), rejectedChild);
  assert.equal(rejectedChild.statusCode, 200);
  let storedParent = await Task.findById(parent._id);
  assert.equal(storedParent.status, 'partial_completed');
  assert.equal(storedParent.completionRate, 0);

  const resubmittedChild = response();
  await taskFlowController.completeTask(request({
    method: 'POST',
    authContext: executorContext,
    params: { id: child._id.toString() },
    body: { completionNote: 'Corrected child submission' }
  }), resubmittedChild);
  assert.equal(resubmittedChild.statusCode, 200);
  assert.equal((await Task.findById(parent._id)).status, 'partial_completed');

  const approvedChild = response();
  await taskFlowController.reviewTask(request({
    method: 'POST',
    authContext: reviewerContext,
    params: { id: child._id.toString() },
    body: { content: 'Child correction accepted', result: 'approved' }
  }), approvedChild);
  assert.equal(approvedChild.statusCode, 200);
  assert.equal((await Task.findById(parent._id)).status, 'partial_completed');

  const childConfirmation = response();
  await taskFlowController.confirmTask(request({
    method: 'POST',
    authContext: creatorContext,
    params: { id: child._id.toString() }
  }), childConfirmation);
  assert.equal(childConfirmation.statusCode, 200);

  storedParent = await Task.findById(parent._id);
  assert.equal(storedParent.status, 'pending_confirm');
  assert.equal(storedParent.completionRate, 100);
  assert.equal(storedParent.confirmedBy, undefined);
  assert.equal(await TaskReview.countDocuments({
    task: parent._id,
    stage: 'confirmation'
  }), 0);
  assert.equal(await Message.countDocuments({
    type: 'task_confirmed',
    relatedTask: parent._id
  }), 0);

  const parentConfirmation = response();
  await taskFlowController.confirmTask(request({
    method: 'POST',
    authContext: creatorContext,
    params: { id: parent._id.toString() },
    body: { content: 'Explicit parent confirmation' }
  }), parentConfirmation);
  assert.equal(parentConfirmation.statusCode, 200);
  storedParent = await Task.findById(parent._id);
  assert.equal(storedParent.status, 'finished');
  assert.equal(storedParent.confirmedBy.toString(), IDS.creatorA.toString());
  assert.equal(await TaskReview.countDocuments({
    task: parent._id,
    stage: 'confirmation',
    reviewRound: 1
  }), 1);
  assert.equal(await Message.countDocuments({
    type: 'task_confirmed',
    recipient: IDS.executorA,
    relatedTask: parent._id
  }), 1);
});

test('a child confirmed after the parent review cannot reopen the reviewed parent', async () => {
  const parent = await createTask({
    teamId: IDS.teamA,
    orgUnitId: IDS.orgA,
    executor: IDS.executorA,
    reviewer: IDS.reviewerA,
    creator: IDS.creatorA,
    status: 'pending_review',
    executorCompletionStatus: 'completed',
    name: 'Reviewed parent awaiting child confirmation'
  });
  parent.actualCompletionTime = new Date('2026-07-20T08:00:00.000Z');
  await parent.save();
  const child = await createTask({
    teamId: IDS.teamA,
    orgUnitId: IDS.orgA,
    executor: IDS.executorA,
    reviewer: null,
    creator: IDS.creatorA,
    status: 'pending_confirm',
    isMainTask: false,
    parentTask: parent._id,
    executorCompletionStatus: 'completed',
    name: 'Child awaiting final confirmation'
  });
  const creatorContext = teamContext(IDS.creatorA, IDS.teamA, IDS.orgA);
  const reviewerContext = teamContext(IDS.reviewerA, IDS.teamA, IDS.orgA);

  const reviewedParent = response();
  await taskFlowController.reviewTask(request({
    method: 'POST',
    authContext: reviewerContext,
    params: { id: parent._id.toString() },
    body: { content: 'Parent review approved', result: 'approved' }
  }), reviewedParent);
  assert.equal(reviewedParent.statusCode, 200);
  assert.equal((await Task.findById(parent._id)).status, 'pending_confirm');

  const confirmedChild = response();
  await taskFlowController.confirmTask(request({
    method: 'POST',
    authContext: creatorContext,
    params: { id: child._id.toString() }
  }), confirmedChild);
  assert.equal(confirmedChild.statusCode, 200);

  let storedParent = await Task.findById(parent._id);
  assert.equal(storedParent.status, 'pending_confirm');
  assert.equal(storedParent.completionRate, 100);

  const confirmedParent = response();
  await taskFlowController.confirmTask(request({
    method: 'POST',
    authContext: creatorContext,
    params: { id: parent._id.toString() }
  }), confirmedParent);
  assert.equal(confirmedParent.statusCode, 200);
  storedParent = await Task.findById(parent._id);
  assert.equal(storedParent.status, 'finished');
  assert.equal(await TaskReview.countDocuments({
    task: parent._id,
    reviewRound: 1
  }), 2);
});

test('a rejected child invalidates the parent review round before corrected work can advance', async () => {
  const parent = await createTask({
    teamId: IDS.teamA,
    orgUnitId: IDS.orgA,
    executor: IDS.executorA,
    reviewer: IDS.reviewerA,
    creator: IDS.creatorA,
    status: 'pending_review',
    executorCompletionStatus: 'completed',
    name: 'Parent review must not survive child rework'
  });
  parent.actualCompletionTime = new Date('2026-07-20T08:00:00.000Z');
  await parent.save();
  const child = await createTask({
    teamId: IDS.teamA,
    orgUnitId: IDS.orgA,
    executor: IDS.executorA,
    reviewer: IDS.reviewerA,
    creator: IDS.creatorA,
    status: 'pending_review',
    isMainTask: false,
    parentTask: parent._id,
    executorCompletionStatus: 'completed',
    name: 'Child requiring rework'
  });
  child.actualCompletionTime = new Date('2026-07-20T08:05:00.000Z');
  await child.save();

  const reviewerContext = teamContext(IDS.reviewerA, IDS.teamA, IDS.orgA);
  const creatorContext = teamContext(IDS.creatorA, IDS.teamA, IDS.orgA);
  const executorContext = teamContext(IDS.executorA, IDS.teamA, IDS.orgA, {
    permissionKeys: ['task.view']
  });

  const reviewedParent = response();
  await taskFlowController.reviewTask(request({
    method: 'POST',
    authContext: reviewerContext,
    params: { id: parent._id.toString() },
    body: { content: 'Parent round one approved', result: 'approved' }
  }), reviewedParent);
  assert.equal(reviewedParent.statusCode, 200);
  assert.equal((await Task.findById(parent._id)).status, 'pending_confirm');

  const rejectedChild = response();
  await taskFlowController.reviewTask(request({
    method: 'POST',
    authContext: reviewerContext,
    params: { id: child._id.toString() },
    body: { content: 'Child evidence needs correction', result: 'rejected' }
  }), rejectedChild);
  assert.equal(rejectedChild.statusCode, 200);

  let storedParent = await Task.findById(parent._id);
  assert.equal(storedParent.status, 'partial_completed');
  assert.equal(storedParent.reviewRound, 2);

  const resubmittedChild = response();
  await taskFlowController.completeTask(request({
    method: 'POST',
    authContext: executorContext,
    params: { id: child._id.toString() },
    body: { completionNote: 'Corrected child evidence' }
  }), resubmittedChild);
  assert.equal(resubmittedChild.statusCode, 200);

  const approvedChild = response();
  await taskFlowController.reviewTask(request({
    method: 'POST',
    authContext: reviewerContext,
    params: { id: child._id.toString() },
    body: { content: 'Corrected child evidence accepted', result: 'approved' }
  }), approvedChild);
  assert.equal(approvedChild.statusCode, 200);

  const confirmedChild = response();
  await taskFlowController.confirmTask(request({
    method: 'POST',
    authContext: creatorContext,
    params: { id: child._id.toString() },
    body: { content: 'Child correction confirmed' }
  }), confirmedChild);
  assert.equal(confirmedChild.statusCode, 200);

  storedParent = await Task.findById(parent._id);
  assert.equal(storedParent.completionRate, 100);
  assert.equal(storedParent.status, 'pending_review');
  assert.equal(storedParent.reviewRound, 2);
  assert.equal(await TaskReview.countDocuments({
    task: parent._id,
    stage: 'review',
    reviewRound: 1,
    result: 'approved'
  }), 1);
  assert.equal(await TaskReview.countDocuments({
    task: parent._id,
    stage: 'review',
    reviewRound: 2
  }), 0);

  const prematureParentConfirmation = response();
  await taskFlowController.confirmTask(request({
    method: 'POST',
    authContext: creatorContext,
    params: { id: parent._id.toString() },
    body: { content: 'Must wait for parent re-review' }
  }), prematureParentConfirmation);
  assert.equal(prematureParentConfirmation.statusCode, 400);
  assert.equal((await Task.findById(parent._id)).status, 'pending_review');

  const rereviewedParent = response();
  await taskFlowController.reviewTask(request({
    method: 'POST',
    authContext: reviewerContext,
    params: { id: parent._id.toString() },
    body: { content: 'Parent re-reviewed after child correction', result: 'approved' }
  }), rereviewedParent);
  assert.equal(rereviewedParent.statusCode, 200);
  storedParent = await Task.findById(parent._id);
  assert.equal(storedParent.status, 'pending_confirm');
  assert.equal(storedParent.reviewRound, 2);

  const confirmedParent = response();
  await taskFlowController.confirmTask(request({
    method: 'POST',
    authContext: creatorContext,
    params: { id: parent._id.toString() },
    body: { content: 'Parent round two confirmed' }
  }), confirmedParent);
  assert.equal(confirmedParent.statusCode, 200);
  assert.equal((await Task.findById(parent._id)).status, 'finished');

  const parentReviews = await TaskReview.find({ task: parent._id })
    .sort({ reviewRound: 1, reviewTime: 1 })
    .lean();
  assert.deepEqual(
    parentReviews.map(({ reviewRound, stage, result }) => `${reviewRound}:${stage}:${result}`),
    [
      '1:review:approved',
      '2:review:approved',
      '2:confirmation:approved'
    ]
  );
});

test('a legacy partial parent invalidates its stale approval when the last child finishes', async () => {
  const parent = await createTask({
    teamId: IDS.teamA,
    orgUnitId: IDS.orgA,
    executor: IDS.executorA,
    reviewer: IDS.reviewerA,
    creator: IDS.creatorA,
    status: 'partial_completed',
    executorCompletionStatus: 'completed',
    name: 'Legacy partial parent with stale approval'
  });
  parent.actualCompletionTime = new Date('2026-07-20T08:00:00.000Z');
  parent.completionRate = 0;
  await parent.save();
  await TaskReview.create({
    teamId: IDS.teamA,
    task: parent._id,
    reviewer: IDS.reviewerA,
    stage: 'review',
    reviewRound: 1,
    content: 'Approval recorded before child regression',
    result: 'approved'
  });

  const child = await createTask({
    teamId: IDS.teamA,
    orgUnitId: IDS.orgA,
    executor: IDS.executorA,
    reviewer: null,
    creator: IDS.creatorA,
    status: 'pending_confirm',
    isMainTask: false,
    parentTask: parent._id,
    executorCompletionStatus: 'completed',
    name: 'Last corrected child awaiting confirmation'
  });

  const confirmedChild = response();
  await taskFlowController.confirmTask(request({
    method: 'POST',
    authContext: teamContext(IDS.creatorA, IDS.teamA, IDS.orgA),
    params: { id: child._id.toString() },
    body: { content: 'Corrected child confirmed' }
  }), confirmedChild);
  assert.equal(confirmedChild.statusCode, 200);

  const storedParent = await Task.findById(parent._id);
  assert.equal(storedParent.completionRate, 100);
  assert.equal(storedParent.reviewRound, 2);
  assert.equal(storedParent.status, 'pending_review');
});

test('a finished parent remains terminal when legacy child state is confirmed later', async () => {
  const parent = await createTask({
    teamId: IDS.teamA,
    orgUnitId: IDS.orgA,
    executor: IDS.executorA,
    reviewer: IDS.reviewerA,
    creator: IDS.creatorA,
    status: 'finished',
    executorCompletionStatus: 'completed',
    name: 'Terminal parent'
  });
  const confirmedAt = new Date('2026-07-19T08:00:00.000Z');
  parent.actualCompletionTime = confirmedAt;
  parent.confirmedBy = IDS.creatorA;
  parent.completionRate = 100;
  await parent.save();
  const child = await createTask({
    teamId: IDS.teamA,
    orgUnitId: IDS.orgA,
    executor: IDS.executorA,
    reviewer: null,
    creator: IDS.creatorA,
    status: 'pending_confirm',
    isMainTask: false,
    parentTask: parent._id,
    executorCompletionStatus: 'completed',
    name: 'Legacy late child'
  });

  const confirmed = response();
  await taskFlowController.confirmTask(request({
    method: 'POST',
    authContext: teamContext(IDS.creatorA, IDS.teamA, IDS.orgA),
    params: { id: child._id.toString() }
  }), confirmed);
  assert.equal(confirmed.statusCode, 200);

  const storedParent = await Task.findById(parent._id);
  assert.equal(storedParent.status, 'finished');
  assert.equal(storedParent.completionRate, 100);
  assert.equal(storedParent.confirmedBy.toString(), IDS.creatorA.toString());
  assert.equal(storedParent.actualCompletionTime.getTime(), confirmedAt.getTime());
});

test('extension apply, detail, history, list and approval cannot cross teams', async () => {
  const taskA = await createTask({
    teamId: IDS.teamA,
    orgUnitId: IDS.orgA,
    executor: IDS.executorA,
    reviewer: IDS.reviewerA,
    creator: IDS.creatorA,
    name: 'A extension'
  });
  const taskB = await createTask({
    teamId: IDS.teamB,
    orgUnitId: IDS.orgB,
    executor: IDS.executorB,
    reviewer: IDS.reviewerB,
    creator: IDS.creatorB,
    name: 'B extension'
  });
  const childA = await createTask({
    teamId: IDS.teamA,
    orgUnitId: IDS.orgA,
    executor: IDS.executorA,
    reviewer: IDS.reviewerA,
    creator: IDS.creatorA,
    isMainTask: false,
    parentTask: taskA._id,
    name: 'A child'
  });
  const corruptCrossTeamChild = await createTask({
    teamId: IDS.teamB,
    orgUnitId: IDS.orgB,
    executor: IDS.executorB,
    reviewer: IDS.reviewerB,
    creator: IDS.creatorB,
    isMainTask: false,
    parentTask: taskA._id,
    name: 'B child referencing A parent'
  });
  const applicantContext = teamContext(IDS.executorA, IDS.teamA, IDS.orgA);

  const deniedApply = response();
  await extensionController.applyExtension(request({
    method: 'POST',
    authContext: applicantContext,
    params: { id: taskB._id.toString() },
    body: { reason: 'must not apply to B', requestedDays: 2 }
  }), deniedApply);
  assert.equal(deniedApply.statusCode, 404);
  assert.equal((await Task.findById(taskB._id)).hasExtensionRequest, false);

  const applied = response();
  await extensionController.applyExtension(request({
    method: 'POST',
    authContext: applicantContext,
    params: { id: taskA._id.toString() },
    body: { reason: 'valid A request', requestedDays: 2 }
  }), applied);
  assert.equal(applied.statusCode, 201);
  const extensionA = await ExtensionRequest.findOne({ task: taskA._id });
  assert.equal(extensionA.teamId.toString(), IDS.teamA.toString());

  const extensionB = await ExtensionRequest.create({
    teamId: IDS.teamB,
    task: taskB._id,
    applicant: IDS.executorB,
    requestType: 'main_task',
    reason: 'B request',
    requestedDays: 3,
    originalCompletionTime: taskB.plannedCompletionTime,
    approver: IDS.creatorB
  });
  await Task.updateOne({ _id: taskB._id }, {
    $set: { status: 'extension_pending', hasExtensionRequest: true }
  });

  const deniedDetail = response();
  await extensionController.getExtensionRequestById(request({
    authContext: applicantContext,
    params: { id: extensionB._id.toString() }
  }), deniedDetail);
  assert.equal(deniedDetail.statusCode, 404);

  const deniedHistory = response();
  await extensionController.getTaskExtensionHistory(request({
    authContext: applicantContext,
    params: { taskId: taskB._id.toString() }
  }), deniedHistory);
  assert.equal(deniedHistory.statusCode, 404);

  const listed = response();
  await extensionController.getExtensionRequests(request({
    authContext: applicantContext
  }), listed);
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(
    listed.body.requests.map((item) => item._id.toString()),
    [extensionA._id.toString()]
  );

  const creatorContext = teamContext(IDS.creatorA, IDS.teamA, IDS.orgA);
  const deniedApproval = response();
  await extensionController.approveExtension(request({
    method: 'POST',
    authContext: creatorContext,
    params: { id: extensionB._id.toString() },
    body: { status: 'approved', approvedDays: 3 }
  }), deniedApproval);
  assert.equal(deniedApproval.statusCode, 404);
  assert.equal((await ExtensionRequest.findById(extensionB._id)).status, 'pending');

  const childATimeBefore = (await Task.findById(childA._id)).plannedCompletionTime.getTime();
  const corruptChildTimeBefore = (
    await Task.findById(corruptCrossTeamChild._id)
  ).plannedCompletionTime.getTime();
  const approved = response();
  await extensionController.approveExtension(request({
    method: 'POST',
    authContext: creatorContext,
    params: { id: extensionA._id.toString() },
    body: { status: 'approved', approvedDays: 2, approvalNote: 'approved in A' }
  }), approved);
  assert.equal(approved.statusCode, 200);
  assert.equal((await ExtensionRequest.findById(extensionA._id)).status, 'approved');
  assert.equal(
    (await Task.findById(childA._id)).plannedCompletionTime.getTime(),
    childATimeBefore + 2 * 24 * 60 * 60 * 1000
  );
  assert.equal(
    (await Task.findById(corruptCrossTeamChild._id)).plannedCompletionTime.getTime(),
    corruptChildTimeBefore
  );
  assert.equal(await Message.countDocuments({ teamId: IDS.teamB }), 0);
});

test('GLOBAL_READ_ONLY writes do not change task, extension or message state', async () => {
  const task = await createTask({
    teamId: IDS.teamA,
    orgUnitId: IDS.orgA,
    executor: IDS.executorA,
    reviewer: IDS.reviewerA,
    creator: IDS.creatorA,
    name: 'Global read-only task'
  });
  const extensionRequest = await ExtensionRequest.create({
    teamId: IDS.teamA,
    task: task._id,
    applicant: IDS.executorA,
    requestType: 'main_task',
    reason: 'pending request',
    requestedDays: 1,
    originalCompletionTime: task.plannedCompletionTime,
    approver: IDS.creatorA
  });
  const context = globalContext(IDS.creatorA);

  const completion = response();
  await taskFlowController.completeTask(request({
    method: 'POST',
    authContext: context,
    params: { id: task._id.toString() },
    body: { completionNote: 'must remain read only' }
  }), completion);
  assert.equal(completion.statusCode, 403);
  assert.equal(completion.body.code, 'GLOBAL_READ_ONLY');

  const approval = response();
  await extensionController.approveExtension(request({
    method: 'POST',
    authContext: context,
    params: { id: extensionRequest._id.toString() },
    body: { status: 'approved', approvedDays: 1 }
  }), approval);
  assert.equal(approval.statusCode, 403);
  assert.equal(approval.body.code, 'GLOBAL_READ_ONLY');

  assert.equal((await Task.findById(task._id)).status, 'in_progress');
  assert.equal((await ExtensionRequest.findById(extensionRequest._id)).status, 'pending');
  assert.equal(await Message.countDocuments({}), 0);
  assert.equal(await AuditLog.countDocuments({}), 0);
});
