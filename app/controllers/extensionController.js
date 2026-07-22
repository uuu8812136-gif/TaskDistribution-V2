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
    assertPermission(req.authContext, 'task.review');
    const actorId = req.authContext.userId;
    const { status, approvedDays, approvalNote } = req.body || {};
    if (!['approved', 'rejected'].includes(status)) {
      throw badRequest('Approval status is invalid');
    }
    if (status === 'approved' && (!Number.isInteger(approvedDays) || approvedDays < 1)) {
      throw badRequest('approvedDays must be a positive integer');
    }

    const mutation = await runWithRequiredTransaction(async (session) => {
      const scoped = await findScopedExtension(req, req.params.id, session);
      if (!scoped) throw notFound();
      const { extensionRequest, task } = scoped;
      if (!sameId(task.creator, actorId) && !canAdministrateTask(req.authContext)) {
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
          const subTasks = await withSession(Task.find(buildTaskScopedFilter(req, {
            parentTask: task._id
          })), session);
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
    assertPermission(req.authContext, 'task.view');
    const { status, taskId } = req.query || {};
    if (status && !REQUEST_STATUSES.has(status)) throw badRequest('Status is invalid');

    let taskIds;
    if (taskId) {
      const task = await findScopedTask(req, taskId, null);
      taskIds = task ? [task._id] : [];
    } else {
      const tasks = await Task.find(buildTaskScopedFilter(req)).select('_id');
      taskIds = tasks.map((task) => task._id);
    }

    const query = { task: { $in: taskIds } };
    if (req.authContext.mode === SESSION_MODES.TEAM) {
      query.teamId = req.authContext.activeTeamId;
    }
    if (status) query.status = status;
    if (!canAdministrateTask(req.authContext)) {
      query.$or = [
        { applicant: req.authContext.userId },
        { approver: req.authContext.userId }
      ];
    }

    const requests = await ExtensionRequest.find(query)
      .populate('task', 'taskName status teamId orgUnitId')
      .populate('applicant', 'name username isSystemAccount')
      .populate('approver', 'name username isSystemAccount')
      .sort({ applyTime: -1 });
    return res.json({ requests });
  } catch (error) {
    return handleError(res, error, 'getExtensionRequests');
  }
};

exports.getExtensionRequestById = async (req, res) => {
  try {
    assertPermission(req.authContext, 'task.view');
    const scoped = await findScopedExtension(req, req.params.id, null);
    if (!scoped) throw notFound();
    await scoped.extensionRequest.populate([
      { path: 'task' },
      { path: 'applicant', select: 'name username phone isSystemAccount' },
      { path: 'approver', select: 'name username phone isSystemAccount' }
    ]);
    return res.json({ request: scoped.extensionRequest });
  } catch (error) {
    return handleError(res, error, 'getExtensionRequestById');
  }
};

exports.getTaskExtensionHistory = async (req, res) => {
  try {
    assertPermission(req.authContext, 'task.view');
    const task = await findScopedTask(req, req.params.taskId, null);
    if (!task) throw taskNotFound();
    const history = await ExtensionRequest.find({
      teamId: task.teamId,
      task: task._id
    }).populate('applicant', 'name username isSystemAccount')
      .populate('approver', 'name username isSystemAccount')
      .sort({ applyTime: -1 });
    return res.json({ history });
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
