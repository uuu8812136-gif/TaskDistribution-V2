'use strict';

const Task = require('../models/Task');
const TaskReview = require('../models/TaskReview');
const { TASK_REVIEW_STAGES } = TaskReview;
const FileAsset = require('../models/FileAsset');
const {
  AUDIT_ACTIONS,
  AUDIT_RESOURCE_TYPES,
  MEMBERSHIP_ROLES
} = require('../config/permissions');
const {
  notifyExecutorCompleted,
  notifyTaskCompleted,
  notifyTaskConfirmed,
  notifyTaskReviewed,
  notifyTaskUpdated
} = require('../utils/notificationHelper');
const { createAuditService } = require('../services/auditService');
const {
  buildTaskDetailFilter,
  buildTaskScopedFilter,
  validateActiveTeamUsers,
  withSession
} = require('../services/taskAccessService');
const { runWithRequiredTransaction } = require('../services/transactionService');
const {
  createFileAssetService,
  normalizeAttachmentInput,
  preserveLegacyAttachments
} = require('../services/fileAssetService');
const { assertPermission, sameId } = require('../services/teamContextService');
const {
  isAuthContextError,
  sendAuthContextError
} = require('../services/authContextError');

const auditService = createAuditService();
const fileAssetService = createFileAssetService();
const TASK_TRANSACTION_OPTIONS = Object.freeze({
  code: 'TASK_FLOW_TRANSACTIONS_REQUIRED',
  message: 'Task workflow writes require MongoDB replica-set transaction support'
});
const DEFAULT_TASK_CONFIRMATION_CONTENT = '已确认任务完成';

function httpError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function notFound(resource = 'Task') {
  return httpError(404, `${resource} not found`, 'RESOURCE_NOT_FOUND');
}

function badRequest(message, code = 'TASK_FLOW_INVALID') {
  return httpError(400, message, code);
}

function idOf(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value.toHexString === 'function') return value.toHexString();
  if (value._id !== undefined) return idOf(value._id);
  return String(value);
}

function idsOf(values) {
  return (Array.isArray(values) ? values : [])
    .map(idOf)
    .filter(Boolean);
}

function uniqueIds(...groups) {
  return [...new Set(groups.flat().map(idOf).filter(Boolean))];
}

function snapshot(document) {
  return document.toObject({
    depopulate: true,
    flattenMaps: true,
    versionKey: false,
    virtuals: false
  });
}

function attachmentsFrom(input) {
  return normalizeAttachmentInput(input).map((fileId) => ({ fileId }));
}

function canAdministrateTask(authContext) {
  return authContext?.isSuperAdmin === true ||
    authContext?.membership?.role === MEMBERSHIP_ROLES.PROJECT_ADMIN;
}

function canSubmitCompletion(task) {
  return task?.status === 'in_progress' ||
    (task?.isMainTask === true && task?.status === 'partial_completed');
}

async function findScopedTask(req, taskId, session) {
  return withSession(Task.findOne(buildTaskDetailFilter(req, taskId)), session);
}

async function validateTaskUsers(req, task, fields, session) {
  const ids = uniqueIds(...fields.map((field) => {
    const value = task[field];
    return Array.isArray(value) ? value : [value];
  }));
  await validateActiveTeamUsers({
    authContext: req.authContext,
    userIds: ids,
    taskOrgUnitId: task.orgUnitId,
    enforceActorOrgScope: false,
    session
  });
}

async function recordTaskMutation({ req, task, before, action, session }) {
  await auditService.record({
    req,
    action,
    resourceType: AUDIT_RESOURCE_TYPES.TASK,
    resourceId: task._id,
    before,
    after: snapshot(task),
    targetTeamId: task.teamId,
    session
  });
}

async function updateMainTaskProgress(req, mainTaskId, session) {
  const mainTask = await findScopedTask(req, mainTaskId, session);
  if (!mainTask) throw notFound();

  const subTasks = await withSession(Task.find(buildTaskScopedFilter(req, {
    parentTask: mainTask._id
  })), session);
  if (subTasks.length === 0) return null;

  const before = snapshot(mainTask);
  const finishedCount = subTasks.filter((subTask) => subTask.status === 'finished').length;
  const completionRate = Math.round((finishedCount / subTasks.length) * 100);

  if (mainTask.status === 'finished') {
    // A terminal parent cannot be reopened by late child-state aggregation.
    mainTask.completionRate = Math.max(mainTask.completionRate || 0, completionRate);
  } else {
    const hasCcUsers = idsOf(mainTask.ccUsers).length > 0;
    let currentRoundApproved = hasCcUsers && Boolean(await withSession(TaskReview.exists({
      teamId: mainTask.teamId,
      task: mainTask._id,
      stage: TASK_REVIEW_STAGES.REVIEW,
      reviewRound: mainTask.reviewRound,
      result: 'approved'
    }), session));
    mainTask.completionRate = completionRate;
    // Also catches parents that regressed before review-round invalidation was introduced.
    const invalidatesReviewedRound = currentRoundApproved && (
      completionRate < 100 || mainTask.status === 'partial_completed'
    );
    if (invalidatesReviewedRound) {
      mainTask.reviewRound += 1;
      currentRoundApproved = false;
    }
    if (
      completionRate < 100 &&
      (completionRate > 0 || Boolean(mainTask.actualCompletionTime))
    ) {
      mainTask.status = 'partial_completed';
    } else if (completionRate === 100 && mainTask.actualCompletionTime) {
      mainTask.status = hasCcUsers && !currentRoundApproved
        ? 'pending_review'
        : 'pending_confirm';
    }
  }

  if (mainTask.isModified()) await mainTask.save({ session });
  return { task: mainTask, before, subTasks };
}

function handleError(res, error, operation) {
  if (isAuthContextError(error)) return sendAuthContextError(res, error);
  if (error?.code === TASK_TRANSACTION_OPTIONS.code && error?.status === 503) {
    return res.status(503).json({ message: error.message, code: error.code });
  }
  if (error?.name === 'VersionError') {
    return res.status(409).json({
      message: 'Task state changed; refresh and try again',
      code: 'TASK_FLOW_CONFLICT'
    });
  }
  if (error?.code === 11000) {
    return res.status(400).json({
      message: 'This review has already been submitted',
      code: 'TASK_REVIEW_DUPLICATE'
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

exports.completeTask = async (req, res) => {
  try {
    assertPermission(req.authContext, 'task.view');
    const actorId = req.authContext.userId;
    const { completionNote, attachments } = req.body || {};
    normalizeAttachmentInput(attachments);

    const result = await runWithRequiredTransaction(async (session) => {
      const task = await findScopedTask(req, req.params.id, session);
      if (!task) throw notFound();
      if (!idsOf(task.executor).some((executorId) => sameId(executorId, actorId))) {
        throw httpError(403, 'Only a task executor may submit completion', 'TASK_EXECUTOR_REQUIRED');
      }
      await validateTaskUsers(req, task, ['executor', 'ccUsers'], session);
      if (task.status === 'extension_pending') {
        throw badRequest(
          'Wait for the pending extension request to be processed',
          'TASK_EXTENSION_PENDING'
        );
      }
      const before = snapshot(task);
      if (!Array.isArray(task.executorCompletions) || task.executorCompletions.length === 0) {
        task.executorCompletions = idsOf(task.executor).map((executor) => ({
          executor,
          status: 'pending',
          content: null,
          attachments: [],
          completedAt: null
        }));
      }

      const executorCompletion = task.executorCompletions.find(
        (completion) => sameId(completion.executor, actorId)
      );
      if (!executorCompletion) throw badRequest('Executor completion record not found');
      if (executorCompletion.status === 'completed') {
        throw badRequest(
          'Completion has already been submitted; use the update endpoint to change it',
          'TASK_COMPLETION_ALREADY_SUBMITTED'
        );
      }
      if (!canSubmitCompletion(task)) {
        throw badRequest('Task is not open for completion');
      }

      if (task.isMainTask) {
        const subTasks = await withSession(Task.find(buildTaskScopedFilter(req, {
          parentTask: task._id
        })), session);
        const completedStatuses = new Set(['finished', 'pending_review', 'pending_confirm']);
        if (subTasks.length > 0 && subTasks.some(
          (subTask) => !completedStatuses.has(subTask.status)
        )) {
          throw badRequest('Complete all subtasks before completing the main task');
        }
      }

      const previousAttachments = [...(executorCompletion.attachments || [])];
      const managedAttachments = await fileAssetService.reconcileOwnerFiles({
        authContext: req.authContext,
        req,
        attachments,
        previousAttachments,
        ownerType: FileAsset.FILE_OWNER_TYPES.TASK_COMPLETION,
        ownerId: task._id,
        method: 'POST',
        session
      });
      const completionAttachments = [
        ...preserveLegacyAttachments(previousAttachments),
        ...managedAttachments
      ];

      executorCompletion.status = 'completed';
      executorCompletion.content = completionNote;
      executorCompletion.attachments = completionAttachments;
      executorCompletion.completedAt = new Date();

      const allExecutorsCompleted = task.executorCompletions.every(
        (completion) => completion.status === 'completed'
      );
      const completedCount = task.executorCompletions.filter(
        (completion) => completion.status === 'completed'
      ).length;
      const totalCount = task.executorCompletions.length;

      if (allExecutorsCompleted) {
        task.status = idsOf(task.ccUsers).length > 0 ? 'pending_review' : 'pending_confirm';
        task.actualCompletionTime = new Date();
        task.completionNote = completionNote;
        task.completionAttachments = completionAttachments;
        task.completedBy = actorId;
      } else {
        task.status = 'in_progress';
      }
      await task.save({ session });
      await recordTaskMutation({
        req,
        task,
        before,
        action: AUDIT_ACTIONS.SUBMIT,
        session
      });

      if (!task.isMainTask && task.parentTask) {
        const parentMutation = await updateMainTaskProgress(req, task.parentTask, session);
        if (parentMutation) {
          await recordTaskMutation({
            req,
            task: parentMutation.task,
            before: parentMutation.before,
            action: AUDIT_ACTIONS.UPDATE,
            session
          });
        }
      }

      return { task, allExecutorsCompleted, completedCount, totalCount };
    }, undefined, TASK_TRANSACTION_OPTIONS);

    try {
      if (result.allExecutorsCompleted) {
        const ccUserIds = idsOf(result.task.ccUsers);
        if (ccUserIds.length > 0) {
          await notifyTaskCompleted(result.task, ccUserIds, actorId);
        } else {
          await notifyTaskReviewed(result.task, idOf(result.task.creator), actorId);
        }
      } else {
        const uncompletedExecutors = result.task.executorCompletions
          .filter((completion) => completion.status === 'pending')
          .map((completion) => completion.executor);
        if (uncompletedExecutors.length > 0) {
          await notifyExecutorCompleted(
            result.task,
            uncompletedExecutors,
            actorId,
            result.completedCount,
            result.totalCount
          );
        }
      }
    } catch (notificationError) {
      console.error('Task completion notification failed:', notificationError);
    }

    return res.json({
      message: result.allExecutorsCompleted
        ? 'Task completion submitted'
        : `Completion submitted (${result.completedCount}/${result.totalCount})`,
      task: result.task,
      completionStatus: {
        completed: result.completedCount,
        total: result.totalCount,
        allCompleted: result.allExecutorsCompleted
      }
    });
  } catch (error) {
    return handleError(res, error, 'completeTask');
  }
};

exports.reviewTask = async (req, res) => {
  try {
    assertPermission(req.authContext, 'task.review');
    const actorId = req.authContext.userId;
    const { content, result = 'approved', rating, attachments } = req.body || {};
    normalizeAttachmentInput(attachments);
    if (!content || typeof content !== 'string') throw badRequest('Review content is required');
    if (!['approved', 'rejected'].includes(result)) {
      throw badRequest('Review result is invalid');
    }

    const mutation = await runWithRequiredTransaction(async (session) => {
      const task = await findScopedTask(req, req.params.id, session);
      if (!task) throw notFound();
      if (!idsOf(task.ccUsers).some((ccUserId) => sameId(ccUserId, actorId))) {
        throw httpError(403, 'Only a task CC user may review it', 'TASK_REVIEWER_REQUIRED');
      }
      await validateTaskUsers(req, task, ['ccUsers'], session);
      if (task.status !== 'pending_review') {
        throw badRequest('Task is not awaiting review');
      }

      const existingReview = await withSession(TaskReview.findOne({
        teamId: task.teamId,
        task: task._id,
        reviewer: actorId,
        stage: TASK_REVIEW_STAGES.REVIEW,
        reviewRound: task.reviewRound
      }), session);
      if (existingReview) throw badRequest('This review has already been submitted');

      const beforeTask = snapshot(task);
      const reviewAttachments = await fileAssetService.reconcileOwnerFiles({
        authContext: req.authContext,
        req,
        attachments,
        previousAttachments: [],
        ownerType: FileAsset.FILE_OWNER_TYPES.TASK_REVIEW,
        ownerId: task._id,
        method: 'POST',
        session
      });
      const review = new TaskReview({
        teamId: task.teamId,
        task: task._id,
        reviewer: actorId,
        stage: TASK_REVIEW_STAGES.REVIEW,
        reviewRound: task.reviewRound,
        content,
        result,
        rating,
        attachments: reviewAttachments
      });
      await review.save({ session });

      if (result === 'rejected') {
        task.status = 'in_progress';
        task.reviewRound += 1;
        task.actualCompletionTime = null;
        task.completedBy = null;
        task.completionNote = null;
        task.completionAttachments = [];
        for (const completion of task.executorCompletions) {
          completion.status = 'pending';
          completion.completedAt = null;
        }
      } else {
        task.status = 'pending_confirm';
      }
      await task.save({ session });

      await auditService.record({
        req,
        action: result === 'rejected' ? AUDIT_ACTIONS.REJECT : AUDIT_ACTIONS.APPROVE,
        resourceType: AUDIT_RESOURCE_TYPES.TASK_REVIEW,
        resourceId: review._id,
        after: snapshot(review),
        targetTeamId: task.teamId,
        session
      });
      await recordTaskMutation({
        req,
        task,
        before: beforeTask,
        action: AUDIT_ACTIONS.STATUS_CHANGE,
        session
      });

      if (result === 'rejected' && !task.isMainTask && task.parentTask) {
        const parentMutation = await updateMainTaskProgress(req, task.parentTask, session);
        if (!parentMutation) throw notFound();
        await recordTaskMutation({
          req,
          task: parentMutation.task,
          before: parentMutation.before,
          action: AUDIT_ACTIONS.UPDATE,
          session
        });
      }
      return { review, task };
    }, undefined, TASK_TRANSACTION_OPTIONS);

    try {
      if (mutation.review.result === 'rejected') {
        await notifyTaskUpdated(
          mutation.task,
          idsOf(mutation.task.executor),
          actorId,
          '审核未通过，请修改后重新提交'
        );
      } else {
        await notifyTaskReviewed(mutation.task, idOf(mutation.task.creator), actorId);
      }
    } catch (notificationError) {
      console.error('Task review notification failed:', notificationError);
    }

    await mutation.review.populate('reviewer', 'name username isSystemAccount');
    return res.json({
      message: mutation.review.result === 'rejected'
        ? 'Task returned for revision'
        : 'Task reviewed',
      ...mutation
    });
  } catch (error) {
    return handleError(res, error, 'reviewTask');
  }
};

exports.confirmTask = async (req, res) => {
  try {
    assertPermission(req.authContext, 'task.view');
    const actorId = req.authContext.userId;
    const { content, rating, attachments } = req.body || {};
    normalizeAttachmentInput(attachments);
    const confirmationContent = typeof content === 'string' && content.trim()
      ? content.trim()
      : DEFAULT_TASK_CONFIRMATION_CONTENT;

    const mutation = await runWithRequiredTransaction(async (session) => {
      const task = await findScopedTask(req, req.params.id, session);
      if (!task) throw notFound();
      if (!sameId(task.creator, actorId) && !canAdministrateTask(req.authContext)) {
        throw httpError(
          403,
          'Only the task creator or a project administrator may confirm it',
          'TASK_CONFIRMATION_DENIED'
        );
      }
      await validateTaskUsers(req, task, ['executor'], session);
      if (task.status !== 'pending_confirm') {
        throw badRequest('Task is not awaiting confirmation');
      }
      if (task.isMainTask) {
        const subTasks = await withSession(Task.find(buildTaskScopedFilter(req, {
          parentTask: task._id
        })), session);
        if (subTasks.some((subTask) => subTask.status !== 'finished')) {
          throw badRequest(
            'Confirm every subtask before confirming the main task',
            'TASK_SUBTASKS_UNFINISHED'
          );
        }
      }

      const beforeTask = snapshot(task);
      const reviewAttachments = await fileAssetService.reconcileOwnerFiles({
        authContext: req.authContext,
        req,
        attachments,
        previousAttachments: [],
        ownerType: FileAsset.FILE_OWNER_TYPES.TASK_REVIEW,
        ownerId: task._id,
        method: 'POST',
        session
      });
      const confirmationReview = new TaskReview({
        teamId: task.teamId,
        task: task._id,
        reviewer: actorId,
        stage: TASK_REVIEW_STAGES.CONFIRMATION,
        reviewRound: task.reviewRound,
        content: confirmationContent,
        result: 'approved',
        rating: rating || null,
        attachments: reviewAttachments
      });
      await confirmationReview.save({ session });
      await auditService.record({
        req,
        action: AUDIT_ACTIONS.APPROVE,
        resourceType: AUDIT_RESOURCE_TYPES.TASK_REVIEW,
        resourceId: confirmationReview._id,
        after: snapshot(confirmationReview),
        targetTeamId: task.teamId,
        session
      });

      task.status = 'finished';
      if (!task.actualCompletionTime) task.actualCompletionTime = new Date();
      task.confirmedBy = actorId;
      await task.save({ session });
      await recordTaskMutation({
        req,
        task,
        before: beforeTask,
        action: AUDIT_ACTIONS.APPROVE,
        session
      });

      if (!task.isMainTask && task.parentTask) {
        const parentMutation = await updateMainTaskProgress(req, task.parentTask, session);
        if (!parentMutation) throw notFound();
        const parentTask = parentMutation.task;
        await recordTaskMutation({
          req,
          task: parentTask,
          before: parentMutation.before,
          action: AUDIT_ACTIONS.UPDATE,
          session
        });
      }

      return { task, confirmationReview };
    }, undefined, TASK_TRANSACTION_OPTIONS);

    try {
      await notifyTaskConfirmed(mutation.task, idsOf(mutation.task.executor), actorId);
    } catch (notificationError) {
      console.error('Task confirmation notification failed:', notificationError);
    }
    return res.json({ message: 'Task confirmed', task: mutation.task });
  } catch (error) {
    return handleError(res, error, 'confirmTask');
  }
};

exports.getTaskReviews = async (req, res) => {
  try {
    assertPermission(req.authContext, 'task.view');
    const task = await findScopedTask(req, req.params.id, null);
    if (!task) throw notFound();
    const reviews = await TaskReview.find({
      teamId: task.teamId,
      task: task._id
    }).populate('reviewer', 'name username isSystemAccount').sort({ reviewTime: -1 });
    return res.json({ reviews });
  } catch (error) {
    return handleError(res, error, 'getTaskReviews');
  }
};

exports.updateCompletion = async (req, res) => {
  try {
    assertPermission(req.authContext, 'task.view');
    const actorId = req.authContext.userId;
    const { completionNote, attachments } = req.body || {};
    normalizeAttachmentInput(attachments);

    const mutation = await runWithRequiredTransaction(async (session) => {
      const task = await findScopedTask(req, req.params.id, session);
      if (!task) throw notFound();
      if (!idsOf(task.executor).some((executorId) => sameId(executorId, actorId))) {
        throw httpError(
          403,
          'Only a task executor may update completion',
          'TASK_EXECUTOR_REQUIRED'
        );
      }
      await validateTaskUsers(req, task, ['executor'], session);
      if (task.status === 'extension_pending') {
        throw badRequest(
          'Wait for the pending extension request to be processed',
          'TASK_EXTENSION_PENDING'
        );
      }
      if (!canSubmitCompletion(task)) {
        throw badRequest('Completion can no longer be updated');
      }

      const executorCompletion = task.executorCompletions.find(
        (completion) => sameId(completion.executor, actorId)
      );
      if (!executorCompletion || executorCompletion.status !== 'completed') {
        throw badRequest('Submit completion before updating it');
      }

      const before = snapshot(task);
      const previousAttachments = [...(executorCompletion.attachments || [])];
      const managedAttachments = await fileAssetService.reconcileOwnerFiles({
        authContext: req.authContext,
        req,
        attachments,
        previousAttachments,
        ownerType: FileAsset.FILE_OWNER_TYPES.TASK_COMPLETION,
        ownerId: task._id,
        method: 'PUT',
        session
      });
      executorCompletion.content = completionNote;
      executorCompletion.attachments = [
        ...preserveLegacyAttachments(previousAttachments),
        ...managedAttachments
      ];
      executorCompletion.completedAt = new Date();
      await task.save({ session });
      await recordTaskMutation({
        req,
        task,
        before,
        action: AUDIT_ACTIONS.UPDATE,
        session
      });
      return { task, executorCompletion };
    }, undefined, TASK_TRANSACTION_OPTIONS);

    return res.json({
      message: 'Completion updated',
      task: mutation.task,
      executorCompletion: mutation.executorCompletion
    });
  } catch (error) {
    return handleError(res, error, 'updateCompletion');
  }
};

module.exports._private = {
  attachmentsFrom,
  canSubmitCompletion,
  updateMainTaskProgress
};
