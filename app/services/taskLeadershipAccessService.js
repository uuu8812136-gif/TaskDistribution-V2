'use strict';

const OrgUnit = require('../models/OrgUnit');
const Task = require('../models/Task');
const TeamMembership = require('../models/TeamMembership');
const User = require('../models/User');
const {
  DATA_SCOPES,
  MEMBERSHIP_ROLES,
  MEMBERSHIP_STATUSES,
  ORG_UNIT_STATUSES,
  POSITION_KEYS,
  SESSION_MODES
} = require('../config/permissions');
const { buildScopedDetailFilter, normalizeObjectId } = require('./scopedQueryService');
const {
  assertPermission,
  hasEffectivePermission,
  assertTeamContext,
  resolveModuleDataScope,
  sameId
} = require('./teamContextService');
const {
  canMembershipActAsSubDepartmentLeader,
  leadershipOrgUnitIds,
  lockSubDepartmentLeadership,
  subDepartmentOrgUnitIds
} = require('./subDepartmentLeadershipService');
const { AuthContextError } = require('./authContextError');

const TASK_LEADERSHIP_POSITION_KEYS = Object.freeze([
  POSITION_KEYS.SUB_DEPARTMENT_MANAGER,
  POSITION_KEYS.SUB_DEPARTMENT_DEPUTY_MANAGER,
  POSITION_KEYS.SUPERVISOR
]);

const TASK_LEADERSHIP_PERMISSION_KEYS = Object.freeze([
  'task.create',
  'task.edit',
  'task.assign',
  'task.review'
]);

function execute(query, session = null) {
  if (session && query && typeof query.session === 'function') query.session(session);
  return query;
}

function leadershipDenied() {
  return new AuthContextError(
    403,
    'TASK_LEADERSHIP_REQUIRED',
    'Task management requires an active leader for the task sub-department'
  );
}

function isTaskLeadershipCandidate(authContext) {
  return authContext?.mode === SESSION_MODES.TEAM &&
    Boolean(authContext.activeTeamId) &&
    authContext.membership?.status === MEMBERSHIP_STATUSES.ACTIVE &&
    TASK_LEADERSHIP_POSITION_KEYS.includes(authContext.membership.positionKey);
}

function requiresDynamicTaskLeadership(authContext) {
  return isTaskLeadershipCandidate(authContext) &&
    authContext.isSuperAdmin !== true &&
    authContext.membership.role !== MEMBERSHIP_ROLES.PROJECT_ADMIN;
}

function hasTaskPermission(authContext, permissionKey) {
  try {
    return hasEffectivePermission(authContext, permissionKey);
  } catch {
    return false;
  }
}

function storedTaskReadAuthorization(authContext, { leadershipSuppressed = false } = {}) {
  return Object.freeze({
    mode: 'STORED_PERMISSION',
    teamId: authContext?.activeTeamId ? String(authContext.activeTeamId) : null,
    subDepartmentId: null,
    orgUnitIds: Object.freeze([]),
    membership: authContext?.membership || null,
    leadershipSuppressed
  });
}

function assertTaskPermissionOrLeadershipCandidate(authContext, permissionKey) {
  if (isTaskLeadershipCandidate(authContext)) return assertTeamContext(authContext);
  return assertPermission(authContext, permissionKey);
}

async function findFreshActorMembership({
  authContext,
  TeamMembershipModel,
  UserModel,
  session
}) {
  const [membership, activeUser] = await Promise.all([
    execute(TeamMembershipModel.findOne({
      teamId: authContext.activeTeamId,
      userId: authContext.userId,
      status: MEMBERSHIP_STATUSES.ACTIVE
    }).lean(), session),
    execute(UserModel.exists({
      _id: authContext.userId,
      status: 'active'
    }), session)
  ]);
  if (!membership || !activeUser || !TASK_LEADERSHIP_POSITION_KEYS.includes(membership.positionKey)) {
    throw leadershipDenied();
  }
  return membership;
}

async function resolveDynamicTaskLeadership({
  authContext,
  TeamMembershipModel = TeamMembership,
  OrgUnitModel = OrgUnit,
  UserModel = User,
  session = null,
  lockForWrite = false,
  returnNullWhenSuperseded = false
} = {}) {
  const context = assertTeamContext(authContext);
  if (!requiresDynamicTaskLeadership(context)) throw leadershipDenied();

  const membership = await findFreshActorMembership({
    authContext: context,
    TeamMembershipModel,
    UserModel,
    session
  });
  const subDepartmentIds = await subDepartmentOrgUnitIds({
    OrgUnitModel,
    teamId: context.activeTeamId,
    orgUnitId: membership.orgUnitId,
    session
  });
  if (subDepartmentIds.length !== 1) throw leadershipDenied();

  if (lockForWrite && !session) {
    throw new AuthContextError(
      503,
      'TASK_LEADERSHIP_TRANSACTIONS_REQUIRED',
      'Acting task leadership writes require transaction support'
    );
  }
  if (lockForWrite) {
    await lockSubDepartmentLeadership({
      OrgUnitModel,
      teamId: context.activeTeamId,
      orgUnitIds: subDepartmentIds,
      session
    });
  }

  const canLead = await canMembershipActAsSubDepartmentLeader({
    TeamMembershipModel,
    OrgUnitModel,
    UserModel,
    membership,
    teamId: context.activeTeamId,
    orgUnitIds: subDepartmentIds,
    session
  });
  if (!canLead) {
    if (returnNullWhenSuperseded) return null;
    throw leadershipDenied();
  }

  const orgUnitIds = await leadershipOrgUnitIds({
    OrgUnitModel,
    teamId: context.activeTeamId,
    orgUnitIds: subDepartmentIds,
    session
  });
  if (orgUnitIds.length === 0) throw leadershipDenied();
  return Object.freeze({
    mode: 'DYNAMIC_LEADERSHIP',
    teamId: String(context.activeTeamId),
    subDepartmentId: String(subDepartmentIds[0]),
    orgUnitIds: Object.freeze(orgUnitIds.map(String)),
    membership
  });
}

async function resolveDynamicTaskLeadershipScope(options = {}) {
  return resolveDynamicTaskLeadership({ ...options, lockForWrite: true });
}

async function resolveDynamicTaskLeadershipReadScope(options = {}) {
  return resolveDynamicTaskLeadership({ ...options, lockForWrite: false });
}

async function resolveTaskReadAuthorization({
  authContext,
  TeamMembershipModel = TeamMembership,
  OrgUnitModel = OrgUnit,
  UserModel = User
} = {}) {
  if (
    authContext?.mode !== SESSION_MODES.TEAM ||
    !authContext?.activeTeamId
  ) {
    assertPermission(authContext, 'task.view');
    return storedTaskReadAuthorization(authContext);
  }

  if (requiresDynamicTaskLeadership(authContext)) {
    const leadership = await resolveDynamicTaskLeadership({
      authContext,
      TeamMembershipModel,
      OrgUnitModel,
      UserModel,
      lockForWrite: false,
      returnNullWhenSuperseded: true
    });
    if (leadership) return leadership;
    assertPermission(authContext, 'task.view');
    return storedTaskReadAuthorization(authContext, { leadershipSuppressed: true });
  }

  assertPermission(authContext, 'task.view');
  return storedTaskReadAuthorization(authContext);
}

async function resolveTaskManagementAuthorization({
  authContext,
  permissionKeys,
  TeamMembershipModel = TeamMembership,
  OrgUnitModel = OrgUnit,
  UserModel = User,
  session = null
} = {}) {
  const context = assertTeamContext(authContext);
  const requiredPermissionKeys = Array.isArray(permissionKeys)
    ? [...new Set(permissionKeys)]
    : [permissionKeys];
  if (
    requiredPermissionKeys.length === 0 ||
    requiredPermissionKeys.some((key) => !TASK_LEADERSHIP_PERMISSION_KEYS.includes(key))
  ) {
    throw new TypeError('Unsupported task leadership permission');
  }

  // Fixed sub-department leadership is runtime authority. Stored checkboxes
  // must neither be required while acting nor preserve authority after a
  // supervisor is superseded by an active manager/deputy.
  if (requiresDynamicTaskLeadership(context)) {
    return resolveDynamicTaskLeadershipScope({
      authContext: context,
      TeamMembershipModel,
      OrgUnitModel,
      UserModel,
      session
    });
  }

  for (const permissionKey of requiredPermissionKeys) {
    assertPermission(context, permissionKey);
  }
  return Object.freeze({
    mode: 'STORED_PERMISSION',
    teamId: String(context.activeTeamId),
    subDepartmentId: null,
    orgUnitIds: Object.freeze([]),
    membership: context.membership
  });
}

function dynamicLeadershipTaskFilter(authorization, taskId) {
  if (authorization?.mode !== 'DYNAMIC_LEADERSHIP') {
    throw new TypeError('Dynamic task leadership authorization is required');
  }
  return {
    _id: normalizeObjectId(taskId, 'taskId'),
    teamId: authorization.teamId,
    orgUnitId: { $in: authorization.orgUnitIds }
  };
}

function dynamicLeadershipTaskListFilter(authorization, userFilter = {}) {
  if (authorization?.mode !== 'DYNAMIC_LEADERSHIP') {
    throw new TypeError('Dynamic task leadership authorization is required');
  }
  const scopeFilter = {
    teamId: authorization.teamId,
    orgUnitId: { $in: authorization.orgUnitIds }
  };
  return userFilter && Object.keys(userFilter).length > 0
    ? { $and: [scopeFilter, userFilter] }
    : scopeFilter;
}

function taskBelongsToLeadershipScope(authorization, task) {
  return authorization?.mode === 'DYNAMIC_LEADERSHIP' &&
    sameId(task?.teamId, authorization.teamId) &&
    authorization.orgUnitIds.some((orgUnitId) => sameId(task?.orgUnitId, orgUnitId));
}

function taskLeadershipResourceContext(authContext, authorization, task, permissionKeys) {
  if (!taskBelongsToLeadershipScope(authorization, task)) throw leadershipDenied();
  return {
    ...authContext,
    membership: {
      ...authContext.membership,
      orgUnitId: String(task.orgUnitId)
    },
    permissionKeys: [
      ...new Set([
        ...(Array.isArray(authContext.permissionKeys) ? authContext.permissionKeys : []),
        ...(Array.isArray(permissionKeys) ? permissionKeys : [permissionKeys])
      ])
    ]
  };
}

function taskActorMatches(task, field, actorId) {
  const value = task?.[field];
  if (Array.isArray(value)) return value.some((entry) => sameId(entry, actorId));
  return sameId(value, actorId);
}

function canAdministrateTask(authContext) {
  return authContext?.isSuperAdmin === true ||
    authContext?.membership?.role === MEMBERSHIP_ROLES.PROJECT_ADMIN;
}

function taskWriteContext(authContext, task) {
  return authContext?.mode === SESSION_MODES.TEAM &&
    authContext?.readOnly !== true &&
    Boolean(authContext?.activeTeamId) &&
    sameId(authContext.activeTeamId, task?.teamId);
}

function storedManagementAllowed(authorization) {
  return authorization?.mode === 'STORED_PERMISSION' &&
    authorization.leadershipSuppressed !== true;
}

function buildTaskCapabilities({
  authContext,
  authorization,
  task,
  hasPendingExtension = null
} = {}) {
  const writable = taskWriteContext(authContext, task);
  const dynamicLeader = writable && taskBelongsToLeadershipScope(authorization, task);
  const storedManagement = writable && storedManagementAllowed(authorization);
  const actorId = authContext?.userId;
  const administrator = canAdministrateTask(authContext);
  const isCreator = taskActorMatches(task, 'creator', actorId);
  const isCcUser = taskActorMatches(task, 'ccUsers', actorId);
  const allSubTasksFinished = task?.isMainTask !== true || (
    Array.isArray(task?.subTasks) &&
    task.subTasks.every((subTask) => subTask?.status === 'finished')
  );
  const hasCompletedExecutor = Array.isArray(task?.executorCompletions) &&
    task.executorCompletions.some((completion) => completion?.status === 'completed');
  const extensionPending = hasPendingExtension === null
    ? task?.hasExtensionRequest === true
    : hasPendingExtension === true;

  return Object.freeze({
    canEdit: Boolean(
      writable && (
        dynamicLeader ||
        (storedManagement && hasTaskPermission(authContext, 'task.edit'))
      )
    ),
    canDelete: Boolean(
      writable && (
        dynamicLeader ||
        (storedManagement && hasTaskPermission(authContext, 'task.edit'))
      )
    ),
    canReview: Boolean(
      writable &&
      task?.status === 'pending_review' &&
      (
        dynamicLeader ||
        (hasTaskPermission(authContext, 'task.review') && isCcUser)
      )
    ),
    canConfirm: Boolean(
      writable &&
      task?.status === 'pending_confirm' &&
      allSubTasksFinished &&
      (
        dynamicLeader ||
        (hasTaskPermission(authContext, 'task.view') && (isCreator || administrator))
      )
    ),
    canApproveExtension: Boolean(
      writable &&
      task?.status === 'extension_pending' &&
      task?.hasExtensionRequest === true &&
      extensionPending &&
      !hasCompletedExecutor &&
      (
        dynamicLeader ||
        (hasTaskPermission(authContext, 'task.review') && (isCreator || administrator))
      )
    )
  });
}

function buildTaskAggregateCapabilities({ authContext, authorization } = {}) {
  const writable = authContext?.mode === SESSION_MODES.TEAM &&
    authContext?.readOnly !== true &&
    Boolean(authContext?.activeTeamId);
  return Object.freeze({
    canCreate: Boolean(
      writable && (
        authorization?.mode === 'DYNAMIC_LEADERSHIP' ||
        (
          storedManagementAllowed(authorization) &&
          hasTaskPermission(authContext, 'task.create') &&
          hasTaskPermission(authContext, 'task.assign')
        )
      )
    )
  });
}

function taskTemporaryUploadDenied() {
  return new AuthContextError(
    403,
    'TASK_FILE_UPLOAD_DENIED',
    'Task attachment upload is not allowed for the requested scope'
  );
}

function taskTemporaryUploadContext(authContext) {
  return {
    ...authContext,
    permissionKeys: [
      ...new Set([
        ...(Array.isArray(authContext?.permissionKeys) ? authContext.permissionKeys : []),
        'task.view'
      ])
    ]
  };
}

async function resolveTaskTemporaryUploadContext({
  authContext,
  taskId,
  orgUnitId,
  TaskModel = Task,
  TeamMembershipModel = TeamMembership,
  OrgUnitModel = OrgUnit,
  UserModel = User
} = {}) {
  const context = assertTeamContext(authContext);
  if (Boolean(taskId) === Boolean(orgUnitId)) {
    throw new AuthContextError(
      400,
      'TASK_FILE_SCOPE_REQUIRED',
      'Provide exactly one of taskId or orgUnitId'
    );
  }
  const authorization = await resolveTaskReadAuthorization({
    authContext: context,
    TeamMembershipModel,
    OrgUnitModel,
    UserModel
  });

  if (taskId) {
    const filter = authorization.mode === 'DYNAMIC_LEADERSHIP'
      ? dynamicLeadershipTaskFilter(authorization, taskId)
      : buildScopedDetailFilter({
          authContext: context,
          moduleKey: 'task',
          id: taskId,
          method: 'GET'
        });
    const task = await TaskModel.findOne(filter).populate({
      path: 'subTasks',
      select: 'status teamId orgUnitId',
      match: (parent) => ({
        teamId: parent.teamId,
        orgUnitId: parent.orgUnitId
      })
    });
    if (!task) throw taskTemporaryUploadDenied();
    const capabilities = buildTaskCapabilities({
      authContext: context,
      authorization,
      task
    });
    if (![
      capabilities.canEdit,
      capabilities.canReview,
      capabilities.canConfirm,
      capabilities.canApproveExtension
    ].some(Boolean)) {
      throw taskTemporaryUploadDenied();
    }
    return taskTemporaryUploadContext(context);
  }

  const aggregateCapabilities = buildTaskAggregateCapabilities({
    authContext: context,
    authorization
  });
  if (!aggregateCapabilities.canCreate) throw taskTemporaryUploadDenied();
  let normalizedOrgUnitId;
  try {
    normalizedOrgUnitId = normalizeObjectId(orgUnitId, 'orgUnitId');
  } catch {
    throw taskTemporaryUploadDenied();
  }
  if (
    authorization.mode === 'DYNAMIC_LEADERSHIP' &&
    !authorization.orgUnitIds.some((candidate) => sameId(candidate, normalizedOrgUnitId))
  ) {
    throw taskTemporaryUploadDenied();
  }
  if (authorization.mode !== 'DYNAMIC_LEADERSHIP') {
    const dataScope = resolveModuleDataScope(context, 'task');
    if (
      dataScope.scope === DATA_SCOPES.ORG_UNIT &&
      !sameId(dataScope.orgUnitId, normalizedOrgUnitId)
    ) {
      throw taskTemporaryUploadDenied();
    }
  }
  const orgUnit = await OrgUnitModel.exists({
    _id: normalizedOrgUnitId,
    teamId: context.activeTeamId,
    status: ORG_UNIT_STATUSES.ACTIVE
  });
  if (!orgUnit) throw taskTemporaryUploadDenied();
  return taskTemporaryUploadContext(context);
}

module.exports = {
  TASK_LEADERSHIP_PERMISSION_KEYS,
  TASK_LEADERSHIP_POSITION_KEYS,
  assertTaskPermissionOrLeadershipCandidate,
  buildTaskAggregateCapabilities,
  buildTaskCapabilities,
  dynamicLeadershipTaskFilter,
  dynamicLeadershipTaskListFilter,
  hasTaskPermission,
  isTaskLeadershipCandidate,
  leadershipDenied,
  requiresDynamicTaskLeadership,
  resolveDynamicTaskLeadershipScope,
  resolveDynamicTaskLeadershipReadScope,
  resolveTaskManagementAuthorization,
  resolveTaskReadAuthorization,
  resolveTaskTemporaryUploadContext,
  taskBelongsToLeadershipScope,
  taskLeadershipResourceContext
};
