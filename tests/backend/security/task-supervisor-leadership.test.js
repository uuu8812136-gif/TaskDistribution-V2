'use strict';

const assert = require('node:assert/strict');
const { after, before, beforeEach, test } = require('node:test');
const appRequire = require('../helpers/appRequire');

const mongoose = appRequire('mongoose');
const { MongoMemoryReplSet } = appRequire('mongodb-memory-server');

const taskController = require('../../../app/controllers/taskController');
const taskFlowController = require('../../../app/controllers/taskFlowController');
const extensionController = require('../../../app/controllers/extensionController');
const AuditLog = require('../../../app/models/AuditLog');
const ExtensionRequest = require('../../../app/models/ExtensionRequest');
const Message = require('../../../app/models/Message');
const OrgUnit = require('../../../app/models/OrgUnit');
const Task = require('../../../app/models/Task');
const TaskReview = require('../../../app/models/TaskReview');
const TeamMembership = require('../../../app/models/TeamMembership');
const User = require('../../../app/models/User');
const {
  lockSubDepartmentLeadership
} = require('../../../app/services/subDepartmentLeadershipService');
const {
  DATA_SCOPES,
  DATA_SCOPE_MODULE_VALUES,
  MEMBERSHIP_ROLES,
  MEMBERSHIP_STATUSES,
  ORG_UNIT_STATUSES,
  ORG_UNIT_TYPES,
  POSITION_KEYS,
  POSITION_LEVEL_BY_KEY,
  SESSION_MODES
} = require('../../../app/config/permissions');

const TEST_DATABASE_NAME = 'task_supervisor_leadership';
const ALL_TASK_MANAGEMENT_PERMISSIONS = Object.freeze([
  'task.view',
  'task.create',
  'task.edit',
  'task.assign',
  'task.review'
]);

let replicaSet;
let fixture;

function objectId() {
  return new mongoose.Types.ObjectId();
}

function moduleDataScopes(scope = DATA_SCOPES.ORG_UNIT) {
  return DATA_SCOPE_MODULE_VALUES.map((moduleKey) => ({ moduleKey, scope }));
}

function orgDocument({ _id, teamId, parentId = null, type, level, path, code }) {
  return {
    _id,
    teamId,
    parentId,
    type,
    level,
    path,
    code,
    name: code,
    status: ORG_UNIT_STATUSES.ACTIVE
  };
}

function membershipDocument({
  _id = objectId(),
  teamId,
  userId,
  orgUnitId,
  positionKey,
  status = MEMBERSHIP_STATUSES.ACTIVE,
  permissionKeys = []
}) {
  return {
    _id,
    teamId,
    userId,
    orgUnitId,
    role: MEMBERSHIP_ROLES.MEMBER,
    positionKey,
    positionLevel: POSITION_LEVEL_BY_KEY[positionKey],
    functionalRoleKeys: [],
    permissionKeys,
    moduleDataScopes: moduleDataScopes(),
    status
  };
}

function contextFor(membership, permissionKeys = membership.permissionKeys) {
  return {
    authenticated: true,
    mode: SESSION_MODES.TEAM,
    activeTeamId: String(membership.teamId),
    userId: String(membership.userId),
    isSuperAdmin: false,
    membership: {
      _id: String(membership._id),
      teamId: String(membership.teamId),
      userId: String(membership.userId),
      orgUnitId: String(membership.orgUnitId),
      role: membership.role,
      positionKey: membership.positionKey,
      positionLevel: membership.positionLevel,
      status: membership.status
    },
    permissionKeys: [...permissionKeys],
    moduleDataScopes: Object.fromEntries(
      membership.moduleDataScopes.map(({ moduleKey, scope }) => [moduleKey, scope])
    ),
    readOnly: false,
    canAccessBusiness: true
  };
}

function request({ authContext, method, params = {}, body = {}, query = {} }) {
  return {
    authContext,
    method,
    params,
    body,
    query,
    headers: {},
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' }
  };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    setHeader() {},
    send(body) {
      this.body = body;
      return this;
    }
  };
}

async function call(handler, options) {
  const target = response();
  await handler(request(options), target);
  return target;
}

async function createUser(_id, username, status = 'active') {
  return User.create({
    _id,
    username,
    password: 'testing-only-password',
    name: username,
    status,
    roles: ['executor'],
    isSuperAdmin: false,
    isSystemAccount: false
  });
}

async function createTask({
  teamId = fixture.teamA,
  orgUnitId = fixture.groupA,
  creator = fixture.creator,
  executor = fixture.executor,
  ccUsers = [],
  status = 'in_progress',
  name = 'Leadership task'
} = {}) {
  return Task.create({
    teamId,
    orgUnitId,
    taskName: name,
    creator,
    executor: [executor],
    mainExecutor: executor,
    ccUsers,
    plannedCompletionTime: new Date('2026-08-01T00:00:00.000Z'),
    status,
    isMainTask: true,
    executorCompletions: [{
      executor,
      status: status === 'pending_review' || status === 'pending_confirm' ? 'completed' : 'pending',
      content: null,
      attachments: [],
      completedAt: status === 'pending_review' || status === 'pending_confirm' ? new Date() : null
    }]
  });
}

async function seedFoundation() {
  const ids = {
    teamA: objectId(),
    teamB: objectId(),
    departmentA: objectId(),
    subDepartmentA: objectId(),
    groupA: objectId(),
    groupA2: objectId(),
    subDepartmentA2: objectId(),
    departmentB: objectId(),
    subDepartmentB: objectId(),
    supervisor: objectId(),
    manager: objectId(),
    executor: objectId(),
    secondExecutor: objectId(),
    otherDivisionExecutor: objectId(),
    creator: objectId()
  };

  await OrgUnit.insertMany([
    orgDocument({
      _id: ids.departmentA,
      teamId: ids.teamA,
      type: ORG_UNIT_TYPES.DEPARTMENT,
      level: 1,
      path: '/',
      code: 'DEPARTMENT_A'
    }),
    orgDocument({
      _id: ids.subDepartmentA,
      teamId: ids.teamA,
      parentId: ids.departmentA,
      type: ORG_UNIT_TYPES.SUB_DEPARTMENT,
      level: 2,
      path: `/${ids.departmentA}/`,
      code: 'SUB_A'
    }),
    orgDocument({
      _id: ids.groupA,
      teamId: ids.teamA,
      parentId: ids.subDepartmentA,
      type: ORG_UNIT_TYPES.TEAM_GROUP,
      level: 3,
      path: `/${ids.departmentA}/${ids.subDepartmentA}/`,
      code: 'GROUP_A'
    }),
    orgDocument({
      _id: ids.groupA2,
      teamId: ids.teamA,
      parentId: ids.subDepartmentA,
      type: ORG_UNIT_TYPES.TEAM_GROUP,
      level: 3,
      path: `/${ids.departmentA}/${ids.subDepartmentA}/`,
      code: 'GROUP_A2'
    }),
    orgDocument({
      _id: ids.subDepartmentA2,
      teamId: ids.teamA,
      parentId: ids.departmentA,
      type: ORG_UNIT_TYPES.SUB_DEPARTMENT,
      level: 2,
      path: `/${ids.departmentA}/`,
      code: 'SUB_A2'
    }),
    orgDocument({
      _id: ids.departmentB,
      teamId: ids.teamB,
      type: ORG_UNIT_TYPES.DEPARTMENT,
      level: 1,
      path: '/',
      code: 'DEPARTMENT_B'
    }),
    orgDocument({
      _id: ids.subDepartmentB,
      teamId: ids.teamB,
      parentId: ids.departmentB,
      type: ORG_UNIT_TYPES.SUB_DEPARTMENT,
      level: 2,
      path: `/${ids.departmentB}/`,
      code: 'SUB_B'
    })
  ]);

  await Promise.all([
    createUser(ids.supervisor, 'task-supervisor'),
    createUser(ids.manager, 'task-manager'),
    createUser(ids.executor, 'task-executor'),
    createUser(ids.secondExecutor, 'task-second-executor'),
    createUser(ids.otherDivisionExecutor, 'other-division-executor'),
    createUser(ids.creator, 'task-creator')
  ]);

  const memberships = await TeamMembership.insertMany([
    membershipDocument({
      teamId: ids.teamA,
      userId: ids.supervisor,
      orgUnitId: ids.groupA,
      positionKey: POSITION_KEYS.SUPERVISOR,
      permissionKeys: [...ALL_TASK_MANAGEMENT_PERMISSIONS]
    }),
    membershipDocument({
      teamId: ids.teamA,
      userId: ids.executor,
      orgUnitId: ids.groupA,
      positionKey: POSITION_KEYS.EMPLOYEE,
      permissionKeys: ['task.view']
    }),
    membershipDocument({
      teamId: ids.teamA,
      userId: ids.secondExecutor,
      orgUnitId: ids.groupA,
      positionKey: POSITION_KEYS.EMPLOYEE,
      permissionKeys: ['task.view']
    }),
    membershipDocument({
      teamId: ids.teamA,
      userId: ids.otherDivisionExecutor,
      orgUnitId: ids.subDepartmentA2,
      positionKey: POSITION_KEYS.EMPLOYEE,
      permissionKeys: ['task.view']
    }),
    membershipDocument({
      teamId: ids.teamA,
      userId: ids.creator,
      orgUnitId: ids.groupA,
      positionKey: POSITION_KEYS.EMPLOYEE,
      permissionKeys: ['task.view']
    })
  ]);
  return {
    ...ids,
    supervisorMembership: memberships[0],
    executorMembership: memberships[1]
  };
}

async function installPrimaryLeader({
  userStatus = 'active',
  membershipStatus = MEMBERSHIP_STATUSES.ACTIVE
} = {}) {
  await User.updateOne({ _id: fixture.manager }, { $set: { status: userStatus } });
  return TeamMembership.create(membershipDocument({
    teamId: fixture.teamA,
    userId: fixture.manager,
    orgUnitId: fixture.subDepartmentA,
    positionKey: POSITION_KEYS.SUB_DEPARTMENT_MANAGER,
    status: membershipStatus,
    permissionKeys: []
  }));
}

before(async () => {
  replicaSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' }
  });
  await mongoose.connect(replicaSet.getUri(TEST_DATABASE_NAME), {
    dbName: TEST_DATABASE_NAME
  });
  await Promise.all([
    AuditLog.syncIndexes(),
    ExtensionRequest.syncIndexes(),
    Message.syncIndexes(),
    OrgUnit.syncIndexes(),
    Task.syncIndexes(),
    TaskReview.syncIndexes(),
    TeamMembership.syncIndexes(),
    User.syncIndexes()
  ]);
});

beforeEach(async () => {
  await Promise.all([
    AuditLog.collection.deleteMany({}),
    ExtensionRequest.deleteMany({}),
    Message.deleteMany({}),
    OrgUnit.collection.deleteMany({}),
    Task.deleteMany({}),
    TaskReview.deleteMany({}),
    TeamMembership.deleteMany({}),
    User.deleteMany({})
  ]);
  fixture = await seedFoundation();
});

after(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replicaSet) await replicaSet.stop();
});

test('runtime leadership read access covers sibling groups and returns authoritative capabilities', async () => {
  const supervisorContext = contextFor(fixture.supervisorMembership, []);
  const localTask = await createTask({ name: 'Local branch task' });
  const siblingTask = await createTask({
    orgUnitId: fixture.groupA2,
    name: 'Sibling branch task'
  });
  const reviewTask = await createTask({
    orgUnitId: fixture.groupA2,
    status: 'pending_review',
    name: 'Sibling review task'
  });
  const confirmTask = await createTask({
    orgUnitId: fixture.groupA2,
    status: 'pending_confirm',
    name: 'Sibling confirmation task'
  });
  const extensionTask = await createTask({
    orgUnitId: fixture.groupA2,
    status: 'extension_pending',
    name: 'Sibling extension task'
  });
  extensionTask.hasExtensionRequest = true;
  await extensionTask.save();
  const otherDivisionTask = await createTask({
    orgUnitId: fixture.subDepartmentA2,
    executor: fixture.otherDivisionExecutor,
    name: 'Other sub-department task'
  });
  await createTask({
    teamId: fixture.teamB,
    orgUnitId: fixture.subDepartmentB,
    name: 'Other team task'
  });
  await TaskReview.create({
    teamId: fixture.teamA,
    task: localTask._id,
    reviewer: fixture.creator,
    stage: 'review',
    reviewRound: 1,
    content: 'Visible review evidence',
    result: 'approved'
  });
  const extension = await ExtensionRequest.create({
    teamId: fixture.teamA,
    task: extensionTask._id,
    applicant: fixture.executor,
    approver: fixture.creator,
    requestType: 'main_task',
    reason: 'Visible to acting leader',
    requestedDays: 2,
    originalCompletionTime: extensionTask.plannedCompletionTime
  });

  const listed = await call(taskController.getTasks, {
    authContext: supervisorContext,
    method: 'GET',
    query: { page: '1', limit: '20' }
  });
  assert.equal(listed.statusCode, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.capabilities.canCreate, true);
  assert.equal(listed.body.pagination.total, 5);
  const byName = new Map(listed.body.tasks.map((task) => [task.taskName, task]));
  assert.deepEqual([...byName.keys()].sort(), [
    'Local branch task',
    'Sibling branch task',
    'Sibling confirmation task',
    'Sibling extension task',
    'Sibling review task'
  ].sort());
  assert.equal(byName.get('Sibling branch task').capabilities.canEdit, true);
  assert.equal(byName.get('Sibling branch task').capabilities.canDelete, true);
  assert.equal(byName.get('Sibling review task').capabilities.canReview, true);
  assert.equal(byName.get('Sibling confirmation task').capabilities.canConfirm, true);
  assert.equal(byName.get('Sibling extension task').capabilities.canApproveExtension, true);

  const detail = await call(taskController.getTaskById, {
    authContext: supervisorContext,
    method: 'GET',
    params: { id: siblingTask._id.toString() }
  });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.body.task.taskName, 'Sibling branch task');
  assert.equal(detail.body.task.capabilities.canEdit, true);

  const reviews = await call(taskFlowController.getTaskReviews, {
    authContext: supervisorContext,
    method: 'GET',
    params: { id: localTask._id.toString() }
  });
  assert.equal(reviews.statusCode, 200);
  assert.equal(reviews.body.reviews.length, 1);
  assert.equal(reviews.body.reviews[0].content, 'Visible review evidence');

  const extensions = await call(extensionController.getExtensionRequests, {
    authContext: supervisorContext,
    method: 'GET',
    query: { status: 'pending' }
  });
  assert.equal(extensions.statusCode, 200, JSON.stringify(extensions.body));
  assert.equal(extensions.body.requests.length, 1);
  assert.equal(extensions.body.requests[0]._id.toString(), extension._id.toString());
  assert.equal(extensions.body.requests[0].capabilities.canApprove, true);

  const extensionDetail = await call(extensionController.getExtensionRequestById, {
    authContext: supervisorContext,
    method: 'GET',
    params: { id: extension._id.toString() }
  });
  assert.equal(extensionDetail.statusCode, 200);
  assert.equal(extensionDetail.body.request.capabilities.canApprove, true);

  const history = await call(extensionController.getTaskExtensionHistory, {
    authContext: supervisorContext,
    method: 'GET',
    params: { taskId: extensionTask._id.toString() }
  });
  assert.equal(history.statusCode, 200);
  assert.equal(history.body.history.length, 1);
  assert.equal(history.body.history[0].capabilities.canApprove, true);

  const denied = await call(taskController.getTaskById, {
    authContext: supervisorContext,
    method: 'GET',
    params: { id: otherDivisionTask._id.toString() }
  });
  assert.equal(denied.statusCode, 404);
});

test('restoring a primary leader removes acting read capabilities on the next request', async () => {
  const noPermissionContext = contextFor(fixture.supervisorMembership, []);
  const storedPermissionContext = contextFor(
    fixture.supervisorMembership,
    ALL_TASK_MANAGEMENT_PERMISSIONS
  );
  await createTask({ name: 'Supervisor own group visibility' });
  const siblingTask = await createTask({
    orgUnitId: fixture.groupA2,
    name: 'Supervisor sibling visibility'
  });

  const beforeRestore = await call(taskController.getTasks, {
    authContext: noPermissionContext,
    method: 'GET',
    query: { limit: '20' }
  });
  assert.equal(beforeRestore.statusCode, 200);
  assert.equal(beforeRestore.body.pagination.total, 2);
  assert.equal(beforeRestore.body.capabilities.canCreate, true);

  const managerMembership = await installPrimaryLeader();

  const deniedAfterRestore = await call(taskController.getTasks, {
    authContext: noPermissionContext,
    method: 'GET',
    query: { limit: '20' }
  });
  assert.equal(deniedAfterRestore.statusCode, 403);
  assert.equal(deniedAfterRestore.body.code, 'PERMISSION_DENIED');

  const scopedAfterRestore = await call(taskController.getTasks, {
    authContext: storedPermissionContext,
    method: 'GET',
    query: { limit: '20' }
  });
  assert.equal(scopedAfterRestore.statusCode, 200);
  assert.equal(scopedAfterRestore.body.pagination.total, 1);
  assert.deepEqual(scopedAfterRestore.body.tasks.map((task) => task.taskName), [
    'Supervisor own group visibility'
  ]);
  assert.equal(scopedAfterRestore.body.capabilities.canCreate, false);
  assert.equal(scopedAfterRestore.body.tasks[0].capabilities.canEdit, false);
  assert.equal(scopedAfterRestore.body.tasks[0].capabilities.canDelete, false);

  const siblingAfterRestore = await call(taskController.getTaskById, {
    authContext: storedPermissionContext,
    method: 'GET',
    params: { id: siblingTask._id.toString() }
  });
  assert.equal(siblingAfterRestore.statusCode, 404);

  const managerRead = await call(taskController.getTasks, {
    authContext: contextFor(managerMembership, []),
    method: 'GET',
    query: { limit: '20' }
  });
  assert.equal(managerRead.statusCode, 200);
  assert.equal(managerRead.body.pagination.total, 2);
  assert.equal(managerRead.body.capabilities.canCreate, true);
  assert.equal(managerRead.body.tasks.every((task) => task.capabilities.canEdit), true);
});

test('runtime leadership reads reject stale inactive users and disabled memberships', async () => {
  const staleContext = contextFor(
    fixture.supervisorMembership,
    ALL_TASK_MANAGEMENT_PERMISSIONS
  );
  await createTask({ name: 'Fresh actor state required' });

  await User.updateOne(
    { _id: fixture.supervisor },
    { $set: { status: 'inactive' } }
  );
  const inactiveUserRead = await call(taskController.getTasks, {
    authContext: staleContext,
    method: 'GET',
    query: { limit: '20' }
  });
  assert.equal(inactiveUserRead.statusCode, 403);
  assert.equal(inactiveUserRead.body.code, 'TASK_LEADERSHIP_REQUIRED');

  await User.updateOne(
    { _id: fixture.supervisor },
    { $set: { status: 'active' } }
  );
  await TeamMembership.updateOne(
    { _id: fixture.supervisorMembership._id },
    { $set: { status: MEMBERSHIP_STATUSES.DISABLED } }
  );
  const disabledMembershipRead = await call(taskController.getTasks, {
    authContext: staleContext,
    method: 'GET',
    query: { limit: '20' }
  });
  assert.equal(disabledMembershipRead.statusCode, 403);
  assert.equal(disabledMembershipRead.body.code, 'TASK_LEADERSHIP_REQUIRED');
});

test('assignable task users stay inside the live leadership branch and preserve stored permission rules', async () => {
  const participantIds = {
    sibling: objectId(),
    inactive: objectId(),
    disabled: objectId(),
    system: objectId(),
    otherTeam: objectId()
  };
  await Promise.all([
    createUser(participantIds.sibling, 'sibling-group-user'),
    createUser(participantIds.inactive, 'inactive-scope-user', 'inactive'),
    createUser(participantIds.disabled, 'disabled-membership-user'),
    createUser(participantIds.system, 'system-scope-user'),
    createUser(participantIds.otherTeam, 'other-team-user')
  ]);
  await User.updateOne(
    { _id: participantIds.system },
    { $set: { isSystemAccount: true } }
  );
  await TeamMembership.insertMany([
    membershipDocument({
      teamId: fixture.teamA,
      userId: participantIds.sibling,
      orgUnitId: fixture.groupA2,
      positionKey: POSITION_KEYS.EMPLOYEE,
      permissionKeys: []
    }),
    membershipDocument({
      teamId: fixture.teamA,
      userId: participantIds.inactive,
      orgUnitId: fixture.groupA2,
      positionKey: POSITION_KEYS.EMPLOYEE,
      permissionKeys: []
    }),
    membershipDocument({
      teamId: fixture.teamA,
      userId: participantIds.disabled,
      orgUnitId: fixture.groupA2,
      positionKey: POSITION_KEYS.EMPLOYEE,
      status: MEMBERSHIP_STATUSES.DISABLED,
      permissionKeys: []
    }),
    membershipDocument({
      teamId: fixture.teamA,
      userId: participantIds.system,
      orgUnitId: fixture.groupA2,
      positionKey: POSITION_KEYS.EMPLOYEE,
      permissionKeys: []
    }),
    membershipDocument({
      teamId: fixture.teamB,
      userId: participantIds.otherTeam,
      orgUnitId: fixture.subDepartmentB,
      positionKey: POSITION_KEYS.EMPLOYEE,
      permissionKeys: []
    })
  ]);

  const actingResponse = await call(taskController.getAssignableUsers, {
    authContext: contextFor(fixture.supervisorMembership, []),
    method: 'GET',
    query: { page: '1', limit: '1000' }
  });
  assert.equal(actingResponse.statusCode, 200, JSON.stringify(actingResponse.body));
  assert.equal(actingResponse.body.pagination.total, 5);
  const actingUsernames = new Set(actingResponse.body.users.map(({ username }) => username));
  for (const username of [
    'task-supervisor',
    'task-executor',
    'task-second-executor',
    'task-creator',
    'sibling-group-user'
  ]) {
    assert.equal(actingUsernames.has(username), true, username);
  }
  for (const username of [
    'other-division-executor',
    'inactive-scope-user',
    'disabled-membership-user',
    'system-scope-user',
    'other-team-user'
  ]) {
    assert.equal(actingUsernames.has(username), false, username);
  }
  assert.equal(
    actingResponse.body.users.find(({ username }) => username === 'sibling-group-user').department,
    'GROUP_A2'
  );

  const missingMemberView = await call(taskController.getAssignableUsers, {
    authContext: contextFor(fixture.executorMembership, ['task.view', 'task.assign']),
    method: 'GET',
    query: { limit: '1000' }
  });
  assert.equal(missingMemberView.statusCode, 403);
  assert.equal(missingMemberView.body.code, 'PERMISSION_DENIED');

  const storedPermissionResponse = await call(taskController.getAssignableUsers, {
    authContext: contextFor(
      fixture.executorMembership,
      ['task.view', 'task.assign', 'member.view']
    ),
    method: 'GET',
    query: { limit: '1000' }
  });
  assert.equal(storedPermissionResponse.statusCode, 200, JSON.stringify(storedPermissionResponse.body));
  assert.equal(
    storedPermissionResponse.body.users.every(({ membership }) => (
      String(membership.orgUnitId) === String(fixture.groupA)
    )),
    true
  );
  assert.equal(
    storedPermissionResponse.body.users.some(({ username }) => username === 'sibling-group-user'),
    false
  );

  await installPrimaryLeader();
  const revokedResponse = await call(taskController.getAssignableUsers, {
    authContext: contextFor(fixture.supervisorMembership, []),
    method: 'GET',
    query: { limit: '1000' }
  });
  assert.equal(revokedResponse.statusCode, 403);
  assert.equal(revokedResponse.body.code, 'PERMISSION_DENIED');
});

test('a supervisor with no stored task permissions can host the complete task workflow when no primary leader is active', async () => {
  const supervisorContext = contextFor(fixture.supervisorMembership, []);
  const created = await call(taskController.createTask, {
    authContext: supervisorContext,
    method: 'POST',
    body: {
      taskName: 'Supervisor-created task',
      orgUnitId: String(fixture.groupA),
      executor: [String(fixture.executor)],
      mainExecutor: String(fixture.executor),
      ccUsers: [String(fixture.creator)],
      plannedCompletionTime: '2026-08-01T00:00:00.000Z'
    }
  });
  assert.equal(created.statusCode, 201);
  const taskId = created.body.task._id.toString();

  const updated = await call(taskController.updateTask, {
    authContext: supervisorContext,
    method: 'PUT',
    params: { id: taskId },
    body: {
      description: 'managed by acting supervisor',
      executor: [String(fixture.secondExecutor)],
      mainExecutor: String(fixture.secondExecutor)
    }
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.body.task.description, 'managed by acting supervisor');
  assert.deepEqual(updated.body.task.executor.map((entry) => entry._id.toString()), [
    String(fixture.secondExecutor)
  ]);

  await Task.updateOne({ _id: taskId }, {
    $set: {
      status: 'pending_review',
      actualCompletionTime: new Date(),
      'executorCompletions.0.status': 'completed',
      'executorCompletions.0.completedAt': new Date()
    }
  });
  const reviewed = await call(taskFlowController.reviewTask, {
    authContext: supervisorContext,
    method: 'POST',
    params: { id: taskId },
    body: { content: 'acting supervisor review', result: 'approved' }
  });
  assert.equal(reviewed.statusCode, 200, JSON.stringify(reviewed.body));
  assert.equal((await Task.findById(taskId)).status, 'pending_confirm');

  const confirmed = await call(taskFlowController.confirmTask, {
    authContext: supervisorContext,
    method: 'POST',
    params: { id: taskId },
    body: { content: 'acting supervisor confirmation' }
  });
  assert.equal(confirmed.statusCode, 200);
  assert.equal((await Task.findById(taskId)).status, 'finished');

  const extensionTask = await createTask({
    status: 'extension_pending',
    name: 'Supervisor extension approval'
  });
  extensionTask.hasExtensionRequest = true;
  await extensionTask.save();
  const extension = await ExtensionRequest.create({
    teamId: fixture.teamA,
    task: extensionTask._id,
    applicant: fixture.executor,
    approver: fixture.creator,
    requestType: 'main_task',
    reason: 'one more day',
    requestedDays: 1,
    originalCompletionTime: extensionTask.plannedCompletionTime
  });
  const approved = await call(extensionController.approveExtension, {
    authContext: supervisorContext,
    method: 'POST',
    params: { id: extension._id.toString() },
    body: { status: 'approved', approvedDays: 1, approvalNote: 'approved by acting supervisor' }
  });
  assert.equal(approved.statusCode, 200);
  assert.equal((await ExtensionRequest.findById(extension._id)).status, 'approved');

  const deletable = await createTask({ name: 'Supervisor-managed deletion' });
  const deleted = await call(taskController.deleteTask, {
    authContext: supervisorContext,
    method: 'DELETE',
    params: { id: deletable._id.toString() }
  });
  assert.equal(deleted.statusCode, 200);
  assert.equal(await Task.exists({ _id: deletable._id }), null);
});

test('an active primary leader revokes supervisor management even when every task permission remains stored', async () => {
  const supervisorContext = contextFor(
    fixture.supervisorMembership,
    ALL_TASK_MANAGEMENT_PERMISSIONS
  );
  const task = await createTask({ name: 'Must be protected after manager restore' });
  const reviewTask = await createTask({
    status: 'pending_review',
    ccUsers: [fixture.creator],
    name: 'Manager-only review'
  });
  const confirmTask = await createTask({
    status: 'pending_confirm',
    name: 'Manager-only confirmation'
  });
  const extensionTask = await createTask({
    status: 'extension_pending',
    name: 'Manager-only extension approval'
  });
  extensionTask.hasExtensionRequest = true;
  await extensionTask.save();
  const extension = await ExtensionRequest.create({
    teamId: fixture.teamA,
    task: extensionTask._id,
    applicant: fixture.executor,
    approver: fixture.creator,
    requestType: 'main_task',
    reason: 'manager must decide',
    requestedDays: 1,
    originalCompletionTime: extensionTask.plannedCompletionTime
  });
  const managerMembership = await installPrimaryLeader();

  const deniedCreate = await call(taskController.createTask, {
    authContext: supervisorContext,
    method: 'POST',
    body: {
      taskName: 'Static permission must not create',
      orgUnitId: String(fixture.groupA),
      executor: [String(fixture.executor)],
      plannedCompletionTime: '2026-08-01T00:00:00.000Z'
    }
  });
  assert.equal(deniedCreate.statusCode, 403);
  assert.equal(deniedCreate.body.code, 'TASK_LEADERSHIP_REQUIRED');

  const deniedEdit = await call(taskController.updateTask, {
    authContext: supervisorContext,
    method: 'PUT',
    params: { id: task._id.toString() },
    body: {
      description: 'must not change',
      executor: [String(fixture.secondExecutor)],
      mainExecutor: String(fixture.secondExecutor)
    }
  });
  assert.equal(deniedEdit.statusCode, 403);
  assert.equal(deniedEdit.body.code, 'TASK_LEADERSHIP_REQUIRED');
  assert.equal((await Task.findById(task._id)).description, undefined);

  const deniedReview = await call(taskFlowController.reviewTask, {
    authContext: supervisorContext,
    method: 'POST',
    params: { id: reviewTask._id.toString() },
    body: { content: 'must not review', result: 'approved' }
  });
  assert.equal(deniedReview.statusCode, 403);
  assert.equal(deniedReview.body.code, 'TASK_LEADERSHIP_REQUIRED');
  assert.equal((await Task.findById(reviewTask._id)).status, 'pending_review');

  const deniedConfirmation = await call(taskFlowController.confirmTask, {
    authContext: supervisorContext,
    method: 'POST',
    params: { id: confirmTask._id.toString() },
    body: { content: 'must not confirm' }
  });
  assert.equal(deniedConfirmation.statusCode, 403);
  assert.equal(deniedConfirmation.body.code, 'TASK_LEADERSHIP_REQUIRED');
  assert.equal((await Task.findById(confirmTask._id)).status, 'pending_confirm');

  const deniedExtension = await call(extensionController.approveExtension, {
    authContext: supervisorContext,
    method: 'POST',
    params: { id: extension._id.toString() },
    body: { status: 'approved', approvedDays: 1 }
  });
  assert.equal(deniedExtension.statusCode, 403);
  assert.equal(deniedExtension.body.code, 'TASK_LEADERSHIP_REQUIRED');
  assert.equal((await ExtensionRequest.findById(extension._id)).status, 'pending');

  const managerContext = contextFor(managerMembership, []);
  const managerEdit = await call(taskController.updateTask, {
    authContext: managerContext,
    method: 'PUT',
    params: { id: task._id.toString() },
    body: { description: 'managed by restored primary leader' }
  });
  assert.equal(managerEdit.statusCode, 200);
  assert.equal(managerEdit.body.task.description, 'managed by restored primary leader');
});

test('inactive primary-leader users and disabled primary memberships do not suppress supervisor fallback', async () => {
  const supervisorContext = contextFor(fixture.supervisorMembership, []);
  const inactiveUserTask = await createTask({ name: 'Inactive manager user fallback' });
  await installPrimaryLeader({ userStatus: 'inactive' });
  const afterInactiveUser = await call(taskController.updateTask, {
    authContext: supervisorContext,
    method: 'PUT',
    params: { id: inactiveUserTask._id.toString() },
    body: { description: 'supervisor acts because manager user is inactive' }
  });
  assert.equal(afterInactiveUser.statusCode, 200);

  await TeamMembership.deleteMany({ userId: fixture.manager });
  await installPrimaryLeader({
    userStatus: 'active',
    membershipStatus: MEMBERSHIP_STATUSES.DISABLED
  });
  const disabledMembershipTask = await createTask({ name: 'Disabled membership fallback' });
  const afterDisabledMembership = await call(taskController.updateTask, {
    authContext: supervisorContext,
    method: 'PUT',
    params: { id: disabledMembershipTask._id.toString() },
    body: { description: 'supervisor acts because manager membership is disabled' }
  });
  assert.equal(afterDisabledMembership.statusCode, 200);
});

test('acting leadership cannot cross another sub-department or another team', async () => {
  const supervisorContext = contextFor(fixture.supervisorMembership, []);
  const otherDivisionTask = await createTask({
    orgUnitId: fixture.subDepartmentA2,
    executor: fixture.otherDivisionExecutor,
    name: 'Other division task'
  });
  const otherTeamTask = await createTask({
    teamId: fixture.teamB,
    orgUnitId: fixture.subDepartmentB,
    name: 'Other team task'
  });

  for (const task of [otherDivisionTask, otherTeamTask]) {
    const denied = await call(taskController.updateTask, {
      authContext: supervisorContext,
      method: 'PUT',
      params: { id: task._id.toString() },
      body: { description: 'must remain isolated' }
    });
    assert.equal(denied.statusCode, 404);
  }
  assert.equal((await Task.findById(otherDivisionTask._id)).description, undefined);
  assert.equal((await Task.findById(otherTeamTask._id)).description, undefined);
});

test('a concurrent primary-leader restoration wins the shared branch lock and rejects the retried supervisor write', async () => {
  const supervisorContext = contextFor(fixture.supervisorMembership, []);
  const task = await createTask({ name: 'Concurrent manager restoration' });
  let releaseManager;
  let managerHasLock;
  const managerLockReady = new Promise((resolve) => {
    managerHasLock = resolve;
  });
  const managerMayCommit = new Promise((resolve) => {
    releaseManager = resolve;
  });

  const managerSession = await mongoose.startSession();
  const managerWrite = managerSession.withTransaction(async () => {
    await lockSubDepartmentLeadership({
      teamId: fixture.teamA,
      orgUnitIds: [fixture.subDepartmentA],
      session: managerSession
    });
    await TeamMembership.create([membershipDocument({
      teamId: fixture.teamA,
      userId: fixture.manager,
      orgUnitId: fixture.subDepartmentA,
      positionKey: POSITION_KEYS.SUB_DEPARTMENT_MANAGER,
      permissionKeys: []
    })], { session: managerSession });
    managerHasLock();
    await managerMayCommit;
  });

  await managerLockReady;
  const supervisorWrite = call(taskController.updateTask, {
    authContext: supervisorContext,
    method: 'PUT',
    params: { id: task._id.toString() },
    body: { description: 'must lose the concurrent race' }
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  releaseManager();
  await managerWrite;
  await managerSession.endSession();

  const denied = await supervisorWrite;
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.body.code, 'TASK_LEADERSHIP_REQUIRED');
  assert.equal((await Task.findById(task._id)).description, undefined);
  assert.equal(await TeamMembership.countDocuments({
    teamId: fixture.teamA,
    userId: fixture.manager,
    status: MEMBERSHIP_STATUSES.ACTIVE
  }), 1);
});
