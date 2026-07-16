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
  orgB: new mongoose.Types.ObjectId(),
  executorA: new mongoose.Types.ObjectId(),
  reviewerA: new mongoose.Types.ObjectId(),
  creatorA: new mongoose.Types.ObjectId(),
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
    body: { content: 'legacy rejection behavior', result: 'rejected' }
  }), reviewed);
  assert.equal(reviewed.statusCode, 200);
  const review = await TaskReview.findOne({ task: taskA._id });
  assert.equal(review.teamId.toString(), IDS.teamA.toString());
  // Frozen legacy behavior: a rejection still advances pending_confirm for now.
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
