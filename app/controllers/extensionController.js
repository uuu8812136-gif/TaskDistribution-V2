'use strict';

const ExtensionRequest = require('../models/ExtensionRequest');
const Task = require('../models/Task');
const {
  AUDIT_ACTIONS,
  AUDIT_RESOURCE_TYPES,
  MEMBERSHIP_ROLES,
  SESSION_MODES
} = require('../config/permissions');
const {
  notifyExtensionApplied,
  notifyExtensionApproved,
  notifyExtensionRejected
} = require('../utils/notificationHelper');
const { createAuditService } = require('../services/auditService');
const {
  buildTaskDetailFilter,
  buildTaskScopedFilter,
  validateActiveTeamUsers,
  withSession
} = require('../services/taskAccessService');
const { normalizeObjectId } = require('../services/scopedQueryService');
const { runWithRequiredTransaction } = require('../services/transactionService');
const { assertPermission, sameId } = require('../services/teamContextService');
const {
  assertTaskPermissionOrLeadershipCandidate,
  buildTaskAggregateCapabilities,
  buildTaskCapabilities,
  dynamicLeadershipTaskFilter,
  dynamicLeadershipTaskListFilter,
  hasTaskPermission,
  isTaskLeadershipCandidate,
  resolveTaskManagementAuthorization,
  resolveTaskReadAuthorization,
  taskBelongsToLeadershipScope
} = require('../services/taskLeadershipAccessService');
const {
  isAuthContextError,
  sendAuthContextError
} = require('../services/authContextError');

const auditService = createAuditService();
const REQUEST_STATUSES = new Set(['pending', 'approved', 'rejected']);
const EXTENDABLE_TASK_STATUSES = new Set(['in_progress']);
const EXTENSION_TRANSACTION_OPTIONS = Object.freeze({
  code: 'EXTENSION_TRANSACTIONS_REQUIRED',
  message: 'Extension workflow writes require MongoDB replica-set transaction support'
});

function httpError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function notFound() {
  return httpError(404, 'Extension request not found', 'RESOURCE_NOT_FOUND');
}

function taskNotFound() {
  return httpError(404, 'Task not found', 'RESOURCE_NOT_FOUND');
}

function badRequest(message, code = 'EXTENSION_INVALID') {
  return httpError(400, message, code);
}

function idOf(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value.toHexString === 'function') return value.toHexString();
  if (value._id !== undefined) return idOf(value._id);
  return String(value);
}

function snapshot(document) {
  return document.toObject({
    depopulate: true,
    flattenMaps: true,
    versionKey: false,
    virtuals: false
  });
}

function responseValue(document, capabilities) {
  const value = document && typeof document.toJSON === 'function'
    ? document.toJSON()
    : { ...(document || {}) };
  return { ...value, capabilities };
}

function canAdministrateTask(authContext) {
  return authContext?.isSuperAdmin === true ||
    authContext?.membership?.role === MEMBERSHIP_ROLES.PROJECT_ADMIN;
}

function hasCompletedExecutor(task) {
  return Array.isArray(task?.executorCompletions) &&
    task.executorCompletions.some((completion) => completion.status === 'completed');
}

function assertTaskCanRequestExtension(task) {
  if (!EXTENDABLE_TASK_STATUSES.has(task?.status) || hasCompletedExecutor(task)) {
    throw badRequest(
      'Task is not open for an extension request',
      'EXTENSION_TASK_STATE_INVALID'
    );
  }
}

function assertTaskCanProcessExtension(task) {
  if (
    task?.status !== 'extension_pending' ||
    task?.hasExtensionRequest !== true ||
    hasCompletedExecutor(task)
  ) {
    throw badRequest(
      'Task state no longer permits extension approval',
      'EXTENSION_TASK_STATE_INVALID'
    );
  }
}

async function findScopedTask(req, taskId, session) {
  return withSession(Task.findOne(buildTaskDetailFilter(req, taskId)), session);
}

async function resolveReadAuthorization(req) {
  return resolveTaskReadAuthorization({ authContext: req.authContext });
}

function readableTaskFilter(req, authorization, taskId = null) {
  if (authorization.mode === 'DYNAMIC_LEADERSHIP') {
    return taskId
      ? dynamicLeadershipTaskFilter(authorization, taskId)
      : dynamicLeadershipTaskListFilter(authorization);
  }
  return taskId
    ? buildTaskDetailFilter(req, taskId)
    : buildTaskScopedFilter(req);
}

async function findReadableTask(req, authorization, taskId) {
  return Task.findOne(readableTaskFilter(req, authorization, taskId));
}

function extensionCapabilities(req, authorization, extensionRequest, task) {
  const taskCapabilities = buildTaskCapabilities({
    authContext: req.authContext,
    authorization,
    task,
    hasPendingExtension: extensionRequest?.status === 'pending'
  });
  return Object.freeze({ canApprove: taskCapabilities.canApproveExtension });
}

function extensionIdentityFilter(req, requestId) {
  const filter = { _id: normalizeObjectId(requestId, 'extensionRequestId') };
  if (req.authContext.mode === SESSION_MODES.TEAM) {
    filter.teamId = req.authContext.activeTeamId;
  }
  return filter;
}

async function findScopedExtension(req, requestId, session) {
  const extensionRequest = await withSession(
    ExtensionRequest.findOne(extensionIdentityFilter(req, requestId)),
    session
  );
  if (!extensionRequest) return null;

  const task = await findScopedTask(req, extensionRequest.task, session);
  if (!task || !sameId(extensionRequest.teamId, task.teamId)) return null;
  return { extensionRequest, task };
}

async function findLeadershipExtension(req, requestId, session) {
  const authorization = await resolveTaskManagementAuthorization({
    authContext: req.authContext,
    permissionKeys: ['task.review'],
    session
  });
  if (authorization.mode !== 'DYNAMIC_LEADERSHIP') {
    return { authorization, extensionRequest: null, task: null };
  }
  const extensionRequest = await withSession(ExtensionRequest.findOne({
    _id: normalizeObjectId(requestId, 'extensionRequestId'),
    teamId: authorization.teamId
  }), session);
  if (!extensionRequest) return { authorization, extensionRequest: null, task: null };
  const task = await withSession(Task.findOne(
    dynamicLeadershipTaskFilter(authorization, extensionRequest.task)
  ), session);
  if (!task || !sameId(extensionRequest.teamId, task.teamId)) {
    return { authorization, extensionRequest: null, task: null };
  }
  return { authorization, extensionRequest, task };
}

async function recordTaskMutation({ req, task, before, session }) {
  await auditService.record({
    req,
    action: AUDIT_ACTIONS.UPDATE,
    resourceType: AUDIT_RESOURCE_TYPES.TASK,
    resourceId: task._id,
    before,
    after: snapshot(task),
    targetTeamId: task.teamId,
    session
  });
}

async function recordExtensionMutation({
  req,
  extensionRequest,
  before,
  action,
  session
}) {
  await auditService.record({
    req,
    action,
    resourceType: AUDIT_RESOURCE_TYPES.EXTENSION_REQUEST,
    resourceId: extensionRequest._id,
    before,
    after: snapshot(extensionRequest),
    targetTeamId: extensionRequest.teamId,
    session
  });
}

function handleError(res, error, operation) {
  if (isAuthContextError(error)) return sendAuthContextError(res, error);
  if (error?.code === EXTENSION_TRANSACTION_OPTIONS.code && error?.status === 503) {
    return res.status(503).json({ message: error.message, code: error.code });
  }
  if (error?.name === 'VersionError') {
    return res.status(409).json({
      message: 'Extension state changed; refresh and try again',
      code: 'EXTENSION_CONFLICT'
    });
  }
  if (error?.code === 11000) {
    return res.status(409).json({
      message: 'An extension request already exists for this task',
      code: 'EXTENSION_ALREADY_REQUESTED'
    });
  }
  if (Number.isInteger(error?.status) && error.status < 500) {
    return res.status(error.status).json({ message: error.message, code: error.code });
  }
  if (error?.name === 'ValidationError' || error?.name === 'CastError') {
    return res.status(400).json({ message: error.message, code: 'VALIDATION_FAILED' });
  }
  console.error(`${operation} failed:`, error);
  return res.status(500).json({ message: 'Server error' });
}

exports.applyExtension = async (req, res) => {
  try {
    assertPermission(req.authContext, 'task.view');
    const actorId = req.authContext.userId;
    const { reason, requestedDays } = req.body || {};
    if (!reason || typeof reason !== 'string') throw badRequest('Extension reason is required');
    if (!Number.isInteger(requestedDays) || requestedDays < 1) {
      throw badRequest('requestedDays must be a positive integer');
    }

    const mutation = await runWithRequiredTransaction(async (session) => {
      const task = await findScopedTask(req, req.params.id, session);
      if (!task) throw taskNotFound();

      let responsibleUserId = idOf(task.mainExecutor);
      if (!task.isMainTask) {
        if (!task.parentTask) throw taskNotFound();
        const parentTask = await findScopedTask(req, task.parentTask, session);
        if (!parentTask) throw taskNotFound();
        responsibleUserId = idOf(parentTask.mainExecutor);
      }
      if (!responsibleUserId || !sameId(responsibleUserId, actorId)) {
        throw httpError(
          403,
          'Only the responsible task owner may request an extension',
          'EXTENSION_APPLICANT_DENIED'
        );
      }
      await validateActiveTeamUsers({
        authContext: req.authContext,
        userIds: [actorId],
        taskOrgUnitId: task.orgUnitId,
        enforceActorOrgScope: false,
        session
      });

      assertTaskCanRequestExtension(task);
      if (task.hasExtensionRequest) {
        throw badRequest('An extension has already been requested for this task');
      }

      const beforeTask = snapshot(task);
      const extensionRequest = new ExtensionRequest({
        teamId: task.teamId,
        task: task._id,
        applicant: actorId,
        requestType: task.isMainTask ? 'main_task' : 'sub_task',
        reason,
        requestedDays,
        originalCompletionTime: task.plannedCompletionTime,
        approver: task.creator
      });
      await extensionRequest.save({ session });
      task.status = 'extension_pending';
      task.hasExtensionRequest = true;
      await task.save({ session });

      await recordExtensionMutation({
        req,
        extensionRequest,
        action: AUDIT_ACTIONS.SUBMIT,
        session
      });
      await recordTaskMutation({ req, task, before: beforeTask, session });
      return { task, extensionRequest };
    }, undefined, EXTENSION_TRANSACTION_OPTIONS);

    try {
      await notifyExtensionApplied(
        mutation.task,
        mutation.extensionRequest,
        idOf(mutation.task.creator),
        actorId
      );
    } catch (notificationError) {
      console.error('Extension application notification failed:', notificationError);
    }

    await mutation.extensionRequest.populate([
      { path: 'applicant', select: 'name username isSystemAccount' },
      { path: 'approver', select: 'name username isSystemAccount' },
      { path: 'task', select: 'taskName' }
    ]);
    return res.status(201).json({
      message: 'Extension request submitted',
      extensionRequest: mutation.extensionRequest
    });
  } catch (error) {
    return handleError(res, error, 'applyExtension');
  }
};

exports.approveExtension = async (req, res) => {
  try {
    assertTaskPermissionOrLeadershipCandidate(req.authContext, 'task.review');
    const actorId = req.authContext.userId;
    const { status, approvedDays, approvalNote } = req.body || {};
    if (!['approved', 'rejected'].includes(status)) {
      throw badRequest('Approval status is invalid');
    }
    if (status === 'approved' && (!Number.isInteger(approvedDays) || approvedDays < 1)) {
      throw badRequest('approvedDays must be a positive integer');
    }

    const mutation = await runWithRequiredTransaction(async (session) => {
      let scoped = hasTaskPermission(req.authContext, 'task.review')
        ? await findScopedExtension(req, req.params.id, session)
        : null;
      let actingAsLeader = false;
      let leadershipAuthorization = null;
      const intrinsicallyAuthorized = scoped && (
        sameId(scoped.task.creator, actorId) || canAdministrateTask(req.authContext)
      );
      if (!intrinsicallyAuthorized && isTaskLeadershipCandidate(req.authContext)) {
        const leadership = await findLeadershipExtension(req, req.params.id, session);
        if (leadership.authorization.mode === 'DYNAMIC_LEADERSHIP') {
          actingAsLeader = true;
          leadershipAuthorization = leadership.authorization;
          if (
            !scoped ||
            !taskBelongsToLeadershipScope(leadership.authorization, scoped.task)
          ) {
            scoped = leadership.extensionRequest && leadership.task
              ? {
                  extensionRequest: leadership.extensionRequest,
                  task: leadership.task
                }
              : null;
          }
        }
      }
      if (!scoped) throw notFound();
      const { extensionRequest, task } = scoped;
      if (
        !sameId(task.creator, actorId) &&
        !canAdministrateTask(req.authContext) &&
        !actingAsLeader
      ) {
        throw httpError(
          403,
          'Only the task creator or a project administrator may approve extensions',
          'EXTENSION_APPROVAL_DENIED'
        );
      }
      await validateActiveTeamUsers({
        authContext: req.authContext,
        userIds: [extensionRequest.applicant],
        taskOrgUnitId: task.orgUnitId,
        enforceActorOrgScope: leadershipAuthorization?.mode !== 'DYNAMIC_LEADERSHIP',
        session
      });
      if (extensionRequest.status !== 'pending') {
        throw badRequest('Extension request has already been processed');
      }
      assertTaskCanProcessExtension(task);

      const beforeRequest = snapshot(extensionRequest);
      const beforeTask = snapshot(task);
      extensionRequest.status = status;
      extensionRequest.approvalTime = new Date();
      extensionRequest.approvalNote = approvalNote;

      const childMutations = [];
      if (status === 'approved') {
        const originalTime = new Date(extensionRequest.originalCompletionTime);
        const newTime = new Date(
          originalTime.getTime() + approvedDays * 24 * 60 * 60 * 1000
        );
        extensionRequest.approvedDays = approvedDays;
        extensionRequest.newCompletionTime = newTime;
        task.plannedCompletionTime = newTime;
        task.extendedCompletionTime = newTime;
        task.status = 'in_progress';

        if (task.isMainTask) {
          const subTaskFilter = leadershipAuthorization?.mode === 'DYNAMIC_LEADERSHIP'
            ? {
                teamId: task.teamId,
                orgUnitId: task.orgUnitId,
                parentTask: task._id
              }
            : buildTaskScopedFilter(req, { parentTask: task._id });
          const subTasks = await withSession(Task.find(subTaskFilter), session);
          for (const subTask of subTasks) {
            const beforeSubTask = snapshot(subTask);
            const originalSubTaskTime = new Date(subTask.plannedCompletionTime);
            const newSubTaskTime = new Date(
              originalSubTaskTime.getTime() + approvedDays * 24 * 60 * 60 * 1000
            );
            subTask.plannedCompletionTime = newSubTaskTime;
            subTask.extendedCompletionTime = newSubTaskTime;
            await subTask.save({ session });
            childMutations.push({ task: subTask, before: beforeSubTask });
          }
        }
      } else {
        task.status = 'in_progress';
      }

      await task.save({ session });
      await extensionRequest.save({ session });
      for (const childMutation of childMutations) {
        await recordTaskMutation({ req, ...childMutation, session });
      }
      await recordTaskMutation({ req, task, before: beforeTask, session });
      await recordExtensionMutation({
        req,
        extensionRequest,
        before: beforeRequest,
        action: status === 'approved' ? AUDIT_ACTIONS.APPROVE : AUDIT_ACTIONS.REJECT,
        session
      });
      return { task, extensionRequest };
    }, undefined, EXTENSION_TRANSACTION_OPTIONS);

    try {
      if (status === 'approved') {
        await notifyExtensionApproved(
          mutation.task,
          mutation.extensionRequest,
          idOf(mutation.extensionRequest.applicant),
          actorId
        );
      } else {
        await notifyExtensionRejected(
          mutation.task,
          mutation.extensionRequest,
          idOf(mutation.extensionRequest.applicant),
          actorId
        );
      }
    } catch (notificationError) {
      console.error('Extension approval notification failed:', notificationError);
    }

    await mutation.extensionRequest.populate([
      { path: 'applicant', select: 'name username isSystemAccount' },
      { path: 'approver', select: 'name username isSystemAccount' }
    ]);
    return res.json({
      message: status === 'approved' ? 'Extension approved' : 'Extension rejected',
      extensionRequest: mutation.extensionRequest
    });
  } catch (error) {
    return handleError(res, error, 'approveExtension');
  }
};

exports.getExtensionRequests = async (req, res) => {
  try {
    const authorization = await resolveReadAuthorization(req);
    const { status, taskId } = req.query || {};
    if (status && !REQUEST_STATUSES.has(status)) throw badRequest('Status is invalid');

    let taskIds;
    if (taskId) {
      const task = await findReadableTask(req, authorization, taskId);
      taskIds = task ? [task._id] : [];
    } else {
      const tasks = await Task.find(readableTaskFilter(req, authorization)).select('_id');
      taskIds = tasks.map((task) => task._id);
    }

    const query = { task: { $in: taskIds } };
    if (req.authContext.mode === SESSION_MODES.TEAM) {
      query.teamId = req.authContext.activeTeamId;
    }
    if (status) query.status = status;
    if (
      authorization.mode !== 'DYNAMIC_LEADERSHIP' &&
      !canAdministrateTask(req.authContext)
    ) {
      query.$or = [
        { applicant: req.authContext.userId },
        { approver: req.authContext.userId }
      ];
    }

    const requests = await ExtensionRequest.find(query)
      .populate(
        'task',
        'taskName status teamId orgUnitId creator hasExtensionRequest executorCompletions isMainTask'
      )
      .populate('applicant', 'name username isSystemAccount')
      .populate('approver', 'name username isSystemAccount')
      .sort({ applyTime: -1 });
    return res.json({
      requests: requests.map((request) => responseValue(
        request,
        extensionCapabilities(req, authorization, request, request.task)
      )),
      capabilities: buildTaskAggregateCapabilities({
        authContext: req.authContext,
        authorization
      })
    });
  } catch (error) {
    return handleError(res, error, 'getExtensionRequests');
  }
};

exports.getExtensionRequestById = async (req, res) => {
  try {
    const authorization = await resolveReadAuthorization(req);
    const extensionRequest = await ExtensionRequest.findOne(
      extensionIdentityFilter(req, req.params.id)
    );
    if (!extensionRequest) throw notFound();
    const task = await findReadableTask(req, authorization, extensionRequest.task);
    if (!task || !sameId(extensionRequest.teamId, task.teamId)) throw notFound();
    await extensionRequest.populate([
      { path: 'task' },
      { path: 'applicant', select: 'name username phone isSystemAccount' },
      { path: 'approver', select: 'name username phone isSystemAccount' }
    ]);
    return res.json({
      request: responseValue(
        extensionRequest,
        extensionCapabilities(req, authorization, extensionRequest, task)
      )
    });
  } catch (error) {
    return handleError(res, error, 'getExtensionRequestById');
  }
};

exports.getTaskExtensionHistory = async (req, res) => {
  try {
    const authorization = await resolveReadAuthorization(req);
    const task = await findReadableTask(req, authorization, req.params.taskId);
    if (!task) throw taskNotFound();
    const history = await ExtensionRequest.find({
      teamId: task.teamId,
      task: task._id
    }).populate('applicant', 'name username isSystemAccount')
      .populate('approver', 'name username isSystemAccount')
      .sort({ applyTime: -1 });
    return res.json({
      history: history.map((request) => responseValue(
        request,
        extensionCapabilities(req, authorization, request, task)
      ))
    });
  } catch (error) {
    return handleError(res, error, 'getTaskExtensionHistory');
  }
};

module.exports._private = {
  assertTaskCanProcessExtension,
  assertTaskCanRequestExtension,
  extensionIdentityFilter,
  findScopedExtension,
  hasCompletedExecutor
};
