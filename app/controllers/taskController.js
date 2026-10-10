'use strict';

const mongoose = require('mongoose');
const XLSX = require('xlsx');
const Task = require('../models/Task');
const User = require('../models/User');
const TaskReview = require('../models/TaskReview');
const ExtensionRequest = require('../models/ExtensionRequest');
const TeamMembership = require('../models/TeamMembership');
const OrgUnit = require('../models/OrgUnit');
const FileAsset = require('../models/FileAsset');
const {
  AUDIT_ACTIONS,
  AUDIT_RESOURCE_TYPES,
  DATA_SCOPES,
  MEMBERSHIP_ROLES,
  MEMBERSHIP_STATUSES,
  ORG_UNIT_STATUSES
} = require('../config/permissions');
const {
  notifyTaskAssigned,
  notifyTaskUpdated,
  notifyTaskDeleted
} = require('../utils/notificationHelper');
const { createAuditService } = require('../services/auditService');
const { runWithOptionalTransaction } = require('../services/transactionService');
const { lockActiveOrgUnitReference } = require('../services/orgUnitReferenceService');
const {
  assertTaskParticipantOrgUnits,
  resolveTaskOrgUnitSubtreeIds
} = require('../services/taskAccessService');
const {
  buildTaskAggregateCapabilities,
  buildTaskCapabilities,
  dynamicLeadershipTaskFilter,
  dynamicLeadershipTaskListFilter,
  resolveTaskManagementAuthorization,
  resolveTaskReadAuthorization,
  taskBelongsToLeadershipScope,
  taskLeadershipResourceContext
} = require('../services/taskLeadershipAccessService');
const {
  createFileAssetService,
  normalizeAttachmentInput,
  preserveLegacyAttachments
} = require('../services/fileAssetService');
const {
  buildRequestScopedFilter,
  buildScopedDetailFilter,
  normalizeObjectId
} = require('../services/scopedQueryService');
const {
  assertPermission,
  resolveModuleDataScope,
  sameId
} = require('../services/teamContextService');
const {
  AuthContextError,
  isAuthContextError,
  sendAuthContextError
} = require('../services/authContextError');

const TASK_MODULE = 'task';
const RELATED_RESOURCE_ERROR = 'RELATED_RESOURCE_INVALID';
const TASK_DAY_MS = 24 * 60 * 60 * 1000;
const NON_OVERDUE_TASK_STATUSES = new Set(['finished', 'pending_confirm']);

function taskStatusConstraint(status, now = new Date()) {
  if (status === 'overdue') {
    return {
      plannedCompletionTime: { $lt: now },
      status: { $nin: [...NON_OVERDUE_TASK_STATUSES] }
    };
  }
  return status ? { status } : null;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function asSnapshot(document) {
  if (!document) return document;
  return typeof document.toObject === 'function'
    ? document.toObject({ depopulate: true, virtuals: false })
    : document;
}

function overdueDaysForTask(task, now = Date.now()) {
  if (!task || NON_OVERDUE_TASK_STATUSES.has(task.status)) return 0;
  const planned = new Date(task.plannedCompletionTime).getTime();
  const current = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(planned) || !Number.isFinite(current) || planned >= current) {
    return 0;
  }
  return Math.max(1, Math.ceil((current - planned) / TASK_DAY_MS));
}

function overdueState(task) {
  const overdueDays = overdueDaysForTask(task);
  return { isOverdue: overdueDays > 0, overdueDays };
}

function taskResponseValue(task, capabilities) {
  const value = task && typeof task.toJSON === 'function'
    ? task.toJSON()
    : { ...(task || {}) };
  const decorate = (item) => (item
    ? { ...item, ...overdueState(item) }
    : item);
  const decorated = decorate(value);
  if (Array.isArray(value.subTasks)) {
    decorated.subTasks = value.subTasks.map(decorate);
  }
  return { ...decorated, capabilities };
}

function assignableUserValue(membership) {
  const user = membership?.userId;
  const orgUnit = membership?.orgUnitId;
  const taskRoles = Array.isArray(user.roles)
    ? user.roles.filter((role) => role === 'executor' || role === 'cc')
    : [];
  return {
    _id: user._id,
    username: user.username,
    name: user.name,
    phone: user.phone || '',
    email: user.email || '',
    roles: membership.role === MEMBERSHIP_ROLES.PROJECT_ADMIN
      ? ['admin']
      : (taskRoles.length > 0 ? [...new Set(taskRoles)] : ['executor']),
    department: orgUnit.name || '',
    status: user.status,
    avatar: user.avatar || '',
    membership: {
      _id: membership._id,
      teamId: membership.teamId,
      orgUnitId: orgUnit._id,
      role: membership.role,
      positionLevel: membership.positionLevel,
      positionKey: membership.positionKey,
      functionalRoleKeys: membership.functionalRoleKeys || [],
      permissionKeys: membership.permissionKeys || [],
      status: membership.status
    }
  };
}

function assignableUsersPagination(query = {}) {
  const page = query.page === undefined ? 1 : Number(query.page);
  const limit = query.limit === undefined ? 100 : Number(query.limit);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new AuthContextError(
      400,
      'INVALID_REQUEST',
      'page must be positive and limit must be an integer between 1 and 1000'
    );
  }
  return { page, limit };
}

function normalizeInputId(value, fieldName) {
  const candidate = value && typeof value === 'object' && value._id ? value._id : value;
  return normalizeObjectId(candidate, fieldName);
}

function parseArray(value, fieldName, { allowEmpty = true } = {}) {
  if (value === undefined || value === null || value === '') return [];

  let parsed = value;
  if (typeof parsed === 'string' && parsed.trim().startsWith('[')) {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new AuthContextError(400, 'INVALID_REQUEST', `${fieldName} must be an array`);
    }
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  if (!allowEmpty && items.length === 0) {
    throw new AuthContextError(400, 'INVALID_REQUEST', `${fieldName} cannot be empty`);
  }
  return items;
}

function normalizeIdArray(value, fieldName, options = {}) {
  const unique = new Set();
  for (const item of parseArray(value, fieldName, options)) {
    unique.add(normalizeInputId(item, fieldName));
  }
  const result = [...unique];
  if (options.allowEmpty === false && result.length === 0) {
    throw new AuthContextError(400, 'INVALID_REQUEST', `${fieldName} cannot be empty`);
  }
  return result;
}

function parseSubTasks(value) {
  if (value === undefined || value === null || value === '') return [];
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new AuthContextError(400, 'INVALID_REQUEST', 'subTasks must be valid JSON');
    }
  }
  if (!Array.isArray(parsed)) {
    throw new AuthContextError(400, 'INVALID_REQUEST', 'subTasks must be an array');
  }
  return parsed;
}

function normalizeSubTaskExecutor(subTask, fallbackExecutor, fieldName) {
  const raw = subTask && subTask.executor;
  if (Array.isArray(raw)) {
    if (raw.length === 0) return fallbackExecutor;
    return normalizeInputId(raw[0], fieldName);
  }
  return raw ? normalizeInputId(raw, fieldName) : fallbackExecutor;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function keywordConstraint(keyword) {
  const normalized = typeof keyword === 'string' ? keyword.trim().slice(0, 200) : '';
  if (!normalized) return null;
  const expression = new RegExp(escapeRegExp(normalized), 'i');
  return { $or: [{ taskName: expression }, { description: expression }] };
}

function combineUserConstraints(constraints) {
  const valid = constraints.filter(Boolean);
  if (valid.length === 0) return {};
  return valid.length === 1 ? valid[0] : { $and: valid };
}

function dateConstraint(startDate, endDate, requirePair = false) {
  if (requirePair && Boolean(startDate) !== Boolean(endDate)) {
    throw new AuthContextError(
      400,
      'INVALID_DATE_RANGE',
      'Please provide both startDate and endDate, or neither'
    );
  }
  if (!startDate && !endDate) return null;

  const createdAt = {};
  if (startDate) {
    const start = new Date(startDate);
    if (Number.isNaN(start.getTime())) {
      throw new AuthContextError(400, 'INVALID_DATE_RANGE', 'startDate is invalid');
    }
    start.setHours(0, 0, 0, 0);
    createdAt.$gte = start;
  }
  if (endDate) {
    const end = new Date(endDate);
    if (Number.isNaN(end.getTime())) {
      throw new AuthContextError(400, 'INVALID_DATE_RANGE', 'endDate is invalid');
    }
    end.setHours(23, 59, 59, 999);
    createdAt.$lte = end;
  }
  return { createdAt };
}

function globalTeamId(req) {
  return req.authContext?.activeTeamId ? undefined : req.query?.teamId;
}

function scopedListFilter(req, userFilter) {
  return buildRequestScopedFilter(req, {
    moduleKey: TASK_MODULE,
    userFilter,
    globalTeamId: globalTeamId(req)
  });
}

function scopedDetailFilter(req, id, userFilter = {}) {
  return buildScopedDetailFilter({
    authContext: req.authContext,
    moduleKey: TASK_MODULE,
    id,
    userFilter,
    globalTeamId: globalTeamId(req),
    method: req.method
  });
}

function withSession(query, session) {
  return session && query && typeof query.session === 'function' ? query.session(session) : query;
}

function notFound(res) {
  return res.status(404).json({ message: '任务不存在' });
}

function relatedResourceError() {
  return new AuthContextError(
    400,
    RELATED_RESOURCE_ERROR,
    'One or more related resources are invalid for the active team'
  );
}

function sendControllerError(res, next, error, fallbackMessage) {
  if (isAuthContextError(error)) return sendAuthContextError(res, error);
  if (error?.name === 'ValidationError' || error?.name === 'CastError') {
    const message = error.name === 'ValidationError'
      ? Object.values(error.errors).map((item) => item.message).join(', ')
      : '请求参数无效';
    return res.status(400).json({ message });
  }
  if (error?.code === 11000) {
    return res.status(409).json({ message: '数据已存在或发生并发冲突' });
  }
  if (Number.isInteger(error?.status) && error.status < 500) {
    return res.status(error.status).json({ message: error.message, code: error.code });
  }
  console.error(fallbackMessage, error);
  if (typeof next === 'function') return next(error);
  return res.status(500).json({ message: '服务器错误' });
}

function createTaskController(overrides = {}) {
  const TaskModel = overrides.Task || Task;
  const UserModel = overrides.User || User;
  const TaskReviewModel = overrides.TaskReview || TaskReview;
  const ExtensionRequestModel = overrides.ExtensionRequest || ExtensionRequest;
  const TeamMembershipModel = overrides.TeamMembership || TeamMembership;
  const OrgUnitModel = overrides.OrgUnit || OrgUnit;
  const mongooseInstance = overrides.mongoose || mongoose;
  const transactionRunner = overrides.runWithOptionalTransaction || runWithOptionalTransaction;
  const auditService = overrides.auditService || createAuditService();
  const fileAssetService = overrides.fileAssetService || createFileAssetService();
  const notifications = overrides.notifications || {
    notifyTaskAssigned,
    notifyTaskUpdated,
    notifyTaskDeleted
  };

  async function runAtomic(work) {
    return transactionRunner(
      work,
      overrides.connection || mongooseInstance.connection
    );
  }

  async function deleteTaskReviews(teamId, taskIds, session) {
    if (!Array.isArray(taskIds) || taskIds.length === 0) return;
    await TaskReviewModel.deleteMany({
      teamId,
      task: { $in: taskIds }
    }, { session: session || undefined });
  }

  async function findActiveOrgUnit(teamId, orgUnitId, session) {
    return lockActiveOrgUnitReference({
      OrgUnitModel,
      teamId,
      orgUnitId: normalizeInputId(orgUnitId, 'orgUnitId'),
      session
    });
  }

  async function resolveTrustedOrgUnit(authContext, requestedOrgUnitId, session) {
    const teamId = normalizeInputId(authContext.activeTeamId, 'activeTeamId');
    const dataScope = resolveModuleDataScope(authContext, TASK_MODULE);
    let trustedOrgUnitId;
    if (dataScope.scope === DATA_SCOPES.TEAM) {
      if (!requestedOrgUnitId) throw relatedResourceError();
      trustedOrgUnitId = requestedOrgUnitId;
    } else {
      trustedOrgUnitId = dataScope.orgUnitId;
      if (requestedOrgUnitId && !sameId(requestedOrgUnitId, trustedOrgUnitId)) {
        throw relatedResourceError();
      }
    }
    if (!trustedOrgUnitId) throw relatedResourceError();
    const orgUnit = await findActiveOrgUnit(teamId, trustedOrgUnitId, session);
    if (!orgUnit) throw relatedResourceError();
    return normalizeInputId(orgUnit._id, 'orgUnitId');
  }

  async function validateActiveTeamUsers(
    authContext,
    userIds,
    session,
    taskOrgUnitId = null,
    enforceActorOrgScope = true
  ) {
    const normalizedIds = [...new Set(userIds.map((id) => normalizeInputId(id, 'userId')))];
    if (normalizedIds.length === 0) return [];

    const teamId = normalizeInputId(authContext.activeTeamId, 'activeTeamId');
    const membershipQuery = TeamMembershipModel.find({
      teamId,
      userId: { $in: normalizedIds },
      status: MEMBERSHIP_STATUSES.ACTIVE
    }).lean();
    const memberships = await withSession(membershipQuery, session);
    if (memberships.length !== normalizedIds.length) throw relatedResourceError();

    const membershipUserIds = new Set(memberships.map((membership) => String(membership.userId)));
    if (normalizedIds.some((id) => !membershipUserIds.has(id))) throw relatedResourceError();

    let allowedOrgUnitIds = null;
    if (taskOrgUnitId) {
      allowedOrgUnitIds = await resolveTaskOrgUnitSubtreeIds({
        teamId,
        orgUnitId: taskOrgUnitId,
        session
      });
    }

    assertTaskParticipantOrgUnits({
      authContext,
      memberships,
      allowedOrgUnitIds,
      taskOrgUnitId,
      enforceActorOrgScope
    });

    const orgUnitIds = [...new Set(memberships.map((membership) => String(membership.orgUnitId)))];
    const [activeOrgUnits, activeUsers] = await Promise.all([
      withSession(OrgUnitModel.find({
        _id: { $in: orgUnitIds },
        teamId,
        status: ORG_UNIT_STATUSES.ACTIVE
      }).select('_id').lean(), session),
      withSession(UserModel.find({
        _id: { $in: normalizedIds },
        status: 'active'
      }).select('_id').lean(), session)
    ]);
    if (activeOrgUnits.length !== orgUnitIds.length || activeUsers.length !== normalizedIds.length) {
      throw relatedResourceError();
    }
    return normalizedIds;
  }

  async function resolveManagementAuthorization(req, permissionKeys, session) {
    return resolveTaskManagementAuthorization({
      authContext: req.authContext,
      permissionKeys,
      TeamMembershipModel,
      OrgUnitModel,
      UserModel,
      session
    });
  }

  async function resolveReadAuthorization(req) {
    return resolveTaskReadAuthorization({
      authContext: req.authContext,
      TeamMembershipModel,
      OrgUnitModel,
      UserModel
    });
  }

  function readListFilter(req, authorization, userFilter = {}) {
    return authorization.mode === 'DYNAMIC_LEADERSHIP'
      ? dynamicLeadershipTaskListFilter(authorization, userFilter)
      : scopedListFilter(req, userFilter);
  }

  function readDetailFilter(req, authorization, taskId) {
    return authorization.mode === 'DYNAMIC_LEADERSHIP'
      ? dynamicLeadershipTaskFilter(authorization, taskId)
      : scopedDetailFilter(req, taskId);
  }

  async function pendingExtensionTaskIds(tasks) {
    const taskIds = (Array.isArray(tasks) ? tasks : [tasks])
      .filter(Boolean)
      .map((task) => task._id);
    if (taskIds.length === 0) return new Set();
    const requests = await ExtensionRequestModel.find({
      task: { $in: taskIds },
      status: 'pending'
    }).select('task').lean();
    return new Set(requests.map((request) => String(request.task)));
  }

  function serializeTasksWithCapabilities(req, authorization, tasks, pendingTaskIds) {
    return tasks.map((task) => taskResponseValue(task, buildTaskCapabilities({
      authContext: req.authContext,
      authorization,
      task,
      hasPendingExtension: pendingTaskIds.has(String(task._id))
    })));
  }

  async function findTaskForManagement(req, permissionKeys, session) {
    const authorization = await resolveManagementAuthorization(req, permissionKeys, session);
    const filter = authorization.mode === 'DYNAMIC_LEADERSHIP'
      ? dynamicLeadershipTaskFilter(authorization, req.params.id)
      : scopedDetailFilter(req, req.params.id);
    const task = await withSession(TaskModel.findOne(filter), session);
    return { authorization, task };
  }

  async function resolveCreateAuthorization(req, requestedOrgUnitId, session) {
    const authorization = await resolveManagementAuthorization(
      req,
      ['task.create', 'task.assign'],
      session
    );
    if (authorization.mode !== 'DYNAMIC_LEADERSHIP') {
      return {
        authorization,
        orgUnitId: await resolveTrustedOrgUnit(req.authContext, requestedOrgUnitId, session)
      };
    }

    const candidateOrgUnitId = requestedOrgUnitId || authorization.membership.orgUnitId;
    const orgUnit = await findActiveOrgUnit(
      authorization.teamId,
      candidateOrgUnitId,
      session
    );
    if (!orgUnit || !taskBelongsToLeadershipScope(authorization, {
      teamId: authorization.teamId,
      orgUnitId: orgUnit._id
    })) {
      throw relatedResourceError();
    }
    return {
      authorization,
      orgUnitId: normalizeInputId(orgUnit._id, 'orgUnitId')
    };
  }

  async function populateTask(task, { detail = false } = {}) {
    if (!task) return task;
    const userFields = detail
      ? 'name username phone realName isSystemAccount'
      : 'name username isSystemAccount';
    const populate = [
      { path: 'creator', select: userFields },
      { path: 'executor', select: userFields },
      { path: 'mainExecutor', select: userFields },
      { path: 'ccUsers', select: userFields }
    ];
    if (detail) {
      populate.push(
        { path: 'completedBy', select: userFields },
        { path: 'confirmedBy', select: userFields },
        { path: 'executorCompletions.executor', select: userFields },
        {
          path: 'parentTask',
          match: { teamId: task.teamId, orgUnitId: task.orgUnitId }
        },
        {
          path: 'subTasks',
          match: { teamId: task.teamId, orgUnitId: task.orgUnitId },
          populate: { path: 'executor', select: 'name username isSystemAccount' }
        }
      );
    }
    await task.populate(populate);
    return task;
  }

  async function createTask(req, res, next) {
    try {
      const body = req.body || {};
      if (!body.taskName || !body.plannedCompletionTime) {
        return res.status(400).json({ message: '任务名称和计划完成时间不能为空' });
      }

      const executorIds = normalizeIdArray(body.executor, 'executor', { allowEmpty: false });
      const mainExecutorId = body.mainExecutor
        ? normalizeInputId(body.mainExecutor, 'mainExecutor')
        : executorIds[0];
      const ccUserIds = normalizeIdArray(body.ccUsers, 'ccUsers');
      const parsedSubTasks = parseSubTasks(body.subTasks);
      const normalizedSubTasks = parsedSubTasks.map((subTask, index) => ({
        ...subTask,
        executorId: normalizeSubTaskExecutor(
          subTask,
          mainExecutorId,
          `subTasks[${index}].executor`
        )
      }));
      const participantIds = [
        ...executorIds,
        mainExecutorId,
        ...ccUserIds,
        ...normalizedSubTasks.map((subTask) => subTask.executorId)
      ];
      const attachmentInput = hasOwn(body, 'attachments') ? body.attachments : [];
      const attachmentIds = normalizeAttachmentInput(attachmentInput);

      const result = await runAtomic(async (session) => {
        const teamId = normalizeInputId(req.authContext.activeTeamId, 'activeTeamId');
        const creation = await resolveCreateAuthorization(
          req,
          body.orgUnitId,
          session
        );
        const { orgUnitId } = creation;
        await validateActiveTeamUsers(
          req.authContext,
          participantIds,
          session,
          orgUnitId,
          creation.authorization.mode !== 'DYNAMIC_LEADERSHIP'
        );

        const mainTask = new TaskModel({
          teamId,
          orgUnitId,
          taskName: body.taskName,
          taskType: body.taskType,
          taskSource: body.taskSource,
          description: body.description,
          executor: executorIds,
          mainExecutor: mainExecutorId,
          ccUsers: ccUserIds,
          creator: req.authContext.userId,
          plannedCompletionTime: body.plannedCompletionTime,
          attachments: [],
          tags: parseArray(body.tags, 'tags'),
          priority: body.priority,
          remarks: body.remarks,
          isMainTask: true,
          status: 'in_progress',
          executorCompletions: executorIds.map((executor) => ({
            executor,
            status: 'pending',
            content: null,
            attachments: [],
            completedAt: null
          }))
        });
        await mainTask.save({ session: session || undefined });

        if (attachmentIds.length > 0) {
          const fileAuthContext = creation.authorization.mode === 'DYNAMIC_LEADERSHIP'
            ? taskLeadershipResourceContext(
                req.authContext,
                creation.authorization,
                mainTask,
                ['task.create', 'task.assign', 'task.edit']
              )
            : req.authContext;
          mainTask.attachments = await fileAssetService.reconcileOwnerFiles({
            authContext: fileAuthContext,
            req,
            attachments: attachmentInput,
            previousAttachments: [],
            ownerType: FileAsset.FILE_OWNER_TYPES.TASK,
            ownerId: mainTask._id,
            method: 'POST',
            session
          });
          await mainTask.save({ session: session || undefined });
        }

        const createdSubTasks = [];
        for (const subTask of normalizedSubTasks) {
          if (!subTask.taskName) {
            throw new AuthContextError(400, 'INVALID_REQUEST', '子任务名称不能为空');
          }
          const child = new TaskModel({
            teamId,
            orgUnitId,
            taskName: subTask.taskName,
            taskType: subTask.taskType || body.taskType,
            taskSource: subTask.taskSource || body.taskSource,
            description: subTask.description,
            executor: [subTask.executorId],
            mainExecutor: subTask.executorId,
            ccUsers: ccUserIds,
            creator: req.authContext.userId,
            plannedCompletionTime: subTask.plannedCompletionTime || body.plannedCompletionTime,
            priority: subTask.priority || body.priority,
            remarks: subTask.remarks,
            parentTask: mainTask._id,
            isMainTask: false,
            status: 'in_progress',
            executorCompletions: [{
              executor: subTask.executorId,
              status: 'pending',
              content: null,
              attachments: [],
              completedAt: null
            }]
          });
          await child.save({ session: session || undefined });
          createdSubTasks.push(child);
          await auditService.record({
            req,
            action: AUDIT_ACTIONS.CREATE,
            resourceType: AUDIT_RESOURCE_TYPES.TASK,
            resourceId: child._id,
            after: asSnapshot(child),
            targetTeamId: teamId,
            session
          });
        }

        await auditService.record({
          req,
          action: AUDIT_ACTIONS.CREATE,
          resourceType: AUDIT_RESOURCE_TYPES.TASK,
          resourceId: mainTask._id,
          after: asSnapshot(mainTask),
          targetTeamId: teamId,
          session
        });
        return { mainTask, createdSubTasks, teamId };
      });

      await populateTask(result.mainTask);
      try {
        const recipients = [
          ...result.mainTask.executor.map((entry) => entry._id || entry),
          ...result.mainTask.ccUsers.map((entry) => entry._id || entry)
        ];
        await notifications.notifyTaskAssigned(
          result.mainTask,
          recipients,
          req.authContext.userId
        );
      } catch (error) {
        console.error('发送任务分配通知失败:', error);
      }

      return res.status(201).json({
        message: '任务创建成功',
        task: result.mainTask,
        subTasks: result.createdSubTasks
      });
    } catch (error) {
      return sendControllerError(res, next, error, '创建任务错误:');
    }
  }

  async function getTasks(req, res, next) {
    try {
      const authorization = await resolveReadAuthorization(req);
      const { status, priority, keyword, startDate, endDate } = req.query;
      const userFilter = combineUserConstraints([
        { isMainTask: true },
        taskStatusConstraint(status),
        priority ? { priority } : null,
        keywordConstraint(keyword),
        dateConstraint(startDate, endDate)
      ]);
      const query = readListFilter(req, authorization, userFilter);
      const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
      const limit = Math.min(500, Math.max(1, Number.parseInt(req.query.limit, 10) || 10));
      const skip = (page - 1) * limit;

      const [tasks, total] = await Promise.all([
        TaskModel.find(query)
          .populate('creator', 'name username isSystemAccount')
          .populate('executor', 'name username isSystemAccount')
          .populate('mainExecutor', 'name username isSystemAccount')
          .populate('ccUsers', 'name username isSystemAccount')
          .populate({
            path: 'subTasks',
            match: (parent) => ({
              teamId: parent.teamId,
              orgUnitId: parent.orgUnitId
            })
          })
          .skip(skip)
          .limit(limit)
          .sort({ createdAt: -1 }),
        TaskModel.countDocuments(query)
      ]);

      const pendingTaskIds = await pendingExtensionTaskIds(tasks);
      return res.json({
        tasks: serializeTasksWithCapabilities(req, authorization, tasks, pendingTaskIds),
        capabilities: buildTaskAggregateCapabilities({
          authContext: req.authContext,
          authorization
        }),
        pagination: { total, page, limit, pages: Math.ceil(total / limit) }
      });
    } catch (error) {
      return sendControllerError(res, next, error, '获取任务列表错误:');
    }
  }

  async function getTaskById(req, res, next) {
    try {
      const authorization = await resolveReadAuthorization(req);
      const task = await TaskModel.findOne(readDetailFilter(req, authorization, req.params.id));
      if (!task) return notFound(res);
      await populateTask(task, { detail: true });
      const pendingTaskIds = await pendingExtensionTaskIds(task);
      return res.json({
        task: taskResponseValue(task, buildTaskCapabilities({
          authContext: req.authContext,
          authorization,
          task,
          hasPendingExtension: pendingTaskIds.has(String(task._id))
        })),
        capabilities: buildTaskAggregateCapabilities({
          authContext: req.authContext,
          authorization
        })
      });
    } catch (error) {
      return sendControllerError(res, next, error, '获取任务详情错误:');
    }
  }

  async function getAssignableUsers(req, res, next) {
    try {
      const authorization = await resolveReadAuthorization(req);
      if (authorization.mode !== 'DYNAMIC_LEADERSHIP') {
        if (authorization.leadershipSuppressed === true) {
          throw new AuthContextError(
            403,
            'TASK_LEADERSHIP_REQUIRED',
            'Task assignment requires current sub-department leadership'
          );
        }
        assertPermission(req.authContext, 'task.assign');
        assertPermission(req.authContext, 'member.view');
      }

      const { page, limit } = assignableUsersPagination(req.query);
      const keyword = typeof req.query?.keyword === 'string'
        ? req.query.keyword.trim().slice(0, 100).toLocaleLowerCase()
        : '';
      const teamId = normalizeInputId(req.authContext.activeTeamId, 'activeTeamId');
      const requestedOrgUnitId = typeof req.query?.orgUnitId === 'string' &&
        req.query.orgUnitId.trim() !== ''
        ? req.query.orgUnitId.trim()
        : null;

      const filter = {
        teamId,
        status: MEMBERSHIP_STATUSES.ACTIVE
      };
      if (authorization.mode === 'DYNAMIC_LEADERSHIP') {
        const subtreeIds = await Promise.all(
          (authorization.orgUnitIds || []).map((orgUnitId) => resolveTaskOrgUnitSubtreeIds({
            teamId,
            orgUnitId
          }))
        );
        const orgUnitIds = [...new Set(subtreeIds.flatMap((ids) => ids || []))];
        if (orgUnitIds.length > 0) filter.orgUnitId = { $in: orgUnitIds };
      } else {
        const dataScope = resolveModuleDataScope(req.authContext, TASK_MODULE);
        if (dataScope.scope === DATA_SCOPES.ORG_UNIT) {
          const subtreeIds = await resolveTaskOrgUnitSubtreeIds({
            teamId,
            orgUnitId: dataScope.orgUnitId
          });
          filter.orgUnitId = { $in: subtreeIds || [normalizeInputId(dataScope.orgUnitId, 'orgUnitId')] };
        } else if (requestedOrgUnitId) {
          const subtreeIds = await resolveTaskOrgUnitSubtreeIds({
            teamId,
            orgUnitId: requestedOrgUnitId
          });
          filter.orgUnitId = { $in: subtreeIds || [normalizeInputId(requestedOrgUnitId, 'orgUnitId')] };
        }
      }

      const memberships = await TeamMembershipModel.find(filter)
        .populate({
          path: 'userId',
          match: { status: 'active', isSystemAccount: { $ne: true } },
          select: '_id username name phone email roles status avatar'
        })
        .populate({
          path: 'orgUnitId',
          match: {
            teamId: normalizeInputId(req.authContext.activeTeamId, 'activeTeamId'),
            status: ORG_UNIT_STATUSES.ACTIVE
          },
          select: '_id teamId name status'
        })
        .lean();
      const matching = memberships
        .filter((membership) => membership.userId && membership.orgUnitId)
        .map(assignableUserValue)
        .filter((user) => !keyword || [user.username, user.name, user.phone, user.email]
          .filter(Boolean)
          .some((value) => String(value).toLocaleLowerCase().includes(keyword)))
        .sort((left, right) => (
          left.department.localeCompare(right.department, 'zh-CN') ||
          left.name.localeCompare(right.name, 'zh-CN') ||
          String(left._id).localeCompare(String(right._id))
        ));
      const total = matching.length;
      return res.json({
        users: matching.slice((page - 1) * limit, page * limit),
        pagination: {
          total,
          page,
          limit,
          pages: Math.ceil(total / limit)
        }
      });
    } catch (error) {
      return sendControllerError(res, next, error, 'Get assignable task users failed:');
    }
  }

  async function reconcileSubTasks({
    req,
    task,
    parsedSubTasks,
    session,
    enforceActorOrgScope = true
  }) {
    const teamId = normalizeInputId(task.teamId, 'teamId');
    const orgUnitId = normalizeInputId(task.orgUnitId, 'orgUnitId');
    const fallbackExecutor = normalizeInputId(
      task.mainExecutor || task.executor?.[0],
      'mainExecutor'
    );
    const normalized = parsedSubTasks.map((subTask, index) => ({
      ...subTask,
      executorId: normalizeSubTaskExecutor(
        subTask,
        fallbackExecutor,
        `subTasks[${index}].executor`
      )
    }));
    await validateActiveTeamUsers(
      req.authContext,
      normalized.map((subTask) => subTask.executorId),
      session,
      orgUnitId,
      enforceActorOrgScope
    );

    const existingQuery = TaskModel.find({
      teamId,
      orgUnitId,
      parentTask: task._id
    });
    const existing = await withSession(existingQuery, session);
    const byId = new Map(existing.map((subTask) => [String(subTask._id), subTask]));
    const retainedIds = [];
    const changed = [];

    for (const input of normalized) {
      if (!input.taskName) {
        throw new AuthContextError(400, 'INVALID_REQUEST', '子任务名称不能为空');
      }
      let subTask;
      let before;
      if (input._id) {
        const id = normalizeInputId(input._id, 'subTask._id');
        subTask = byId.get(id);
        if (!subTask) {
          throw new AuthContextError(404, 'RESOURCE_NOT_FOUND', '任务不存在');
        }
        before = asSnapshot(subTask);
        retainedIds.push(id);
      } else {
        subTask = new TaskModel({
          teamId,
          orgUnitId,
          creator: req.authContext.userId,
          parentTask: task._id,
          isMainTask: false,
          status: 'in_progress'
        });
      }

      subTask.taskName = input.taskName;
      subTask.taskType = input.taskType || task.taskType;
      subTask.taskSource = input.taskSource || task.taskSource;
      subTask.description = input.description;
      subTask.executor = [input.executorId];
      subTask.mainExecutor = input.executorId;
      subTask.ccUsers = task.ccUsers;
      subTask.plannedCompletionTime = input.plannedCompletionTime || task.plannedCompletionTime;
      subTask.priority = input.priority || task.priority;
      subTask.remarks = input.remarks;
      const completion = (subTask.executorCompletions || []).find(
        (entry) => sameId(entry.executor, input.executorId)
      );
      subTask.executorCompletions = [completion || {
        executor: input.executorId,
        status: 'pending',
        content: null,
        attachments: [],
        completedAt: null
      }];
      await subTask.save({ session: session || undefined });
      changed.push(subTask);
      await auditService.record({
        req,
        action: before ? AUDIT_ACTIONS.UPDATE : AUDIT_ACTIONS.CREATE,
        resourceType: AUDIT_RESOURCE_TYPES.TASK,
        resourceId: subTask._id,
        before,
        after: asSnapshot(subTask),
        targetTeamId: teamId,
        session
      });
    }

    const deleted = existing.filter((subTask) => !retainedIds.includes(String(subTask._id)));
    if (deleted.length > 0) {
      const deletedTaskIds = deleted.map((subTask) => subTask._id);
      await deleteTaskReviews(teamId, deletedTaskIds, session);
      await TaskModel.deleteMany({
        teamId,
        orgUnitId,
        parentTask: task._id,
        _id: { $in: deletedTaskIds }
      }, { session: session || undefined });
      for (const subTask of deleted) {
        await auditService.record({
          req,
          action: AUDIT_ACTIONS.DELETE,
          resourceType: AUDIT_RESOURCE_TYPES.TASK,
          resourceId: subTask._id,
          before: asSnapshot(subTask),
          targetTeamId: teamId,
          session
        });
      }
    }
    return changed;
  }

  async function updateTask(req, res, next) {
    try {
      const body = req.body || {};
      if (hasOwn(body, 'attachments')) normalizeAttachmentInput(body.attachments);
      const assignmentFields = ['executor', 'mainExecutor', 'ccUsers', 'subTasks'];
      const changesAssignment = assignmentFields.some((field) => hasOwn(body, field));
      const permissionKeys = changesAssignment
        ? ['task.edit', 'task.assign']
        : ['task.edit'];

      const result = await runAtomic(async (session) => {
        const management = await findTaskForManagement(req, permissionKeys, session);
        const { task } = management;
        if (!task) return null;
        const before = asSnapshot(task);
        if (hasOwn(body, 'orgUnitId') && !sameId(body.orgUnitId, task.orgUnitId)) {
          throw new AuthContextError(
            400,
            'TASK_ORG_UNIT_IMMUTABLE',
            'Task organization unit cannot be changed after creation'
          );
        }

        let newExecutorIds = task.executor.map(String);
        if (hasOwn(body, 'executor')) {
          newExecutorIds = normalizeIdArray(body.executor, 'executor', { allowEmpty: false });
        }
        const newMainExecutorId = hasOwn(body, 'mainExecutor') && body.mainExecutor
          ? normalizeInputId(body.mainExecutor, 'mainExecutor')
          : String(task.mainExecutor || newExecutorIds[0]);
        const newCcUserIds = hasOwn(body, 'ccUsers')
          ? normalizeIdArray(body.ccUsers, 'ccUsers')
          : task.ccUsers.map(String);
        await validateActiveTeamUsers(
          req.authContext,
          [...newExecutorIds, newMainExecutorId, ...newCcUserIds],
          session,
          task.orgUnitId,
          management.authorization.mode !== 'DYNAMIC_LEADERSHIP'
        );

        const directFields = [
          'taskName',
          'taskType',
          'taskSource',
          'description',
          'plannedCompletionTime',
          'priority',
          'remarks'
        ];
        for (const field of directFields) {
          if (hasOwn(body, field)) task[field] = body[field];
        }
        if (hasOwn(body, 'tags')) task.tags = parseArray(body.tags, 'tags');

        const oldCompletions = task.executorCompletions || [];
        task.executorCompletions = newExecutorIds.map((executor) => (
          oldCompletions.find((entry) => sameId(entry.executor, executor)) || {
            executor,
            status: 'pending',
            content: null,
            attachments: [],
            completedAt: null
          }
        ));
        task.executor = newExecutorIds;
        task.mainExecutor = newMainExecutorId;
        task.ccUsers = newCcUserIds;

        if (hasOwn(body, 'attachments')) {
          const previousAttachments = [...(task.attachments || [])];
          const fileAuthContext = management.authorization.mode === 'DYNAMIC_LEADERSHIP'
            ? taskLeadershipResourceContext(
                req.authContext,
                management.authorization,
                task,
                ['task.edit']
              )
            : req.authContext;
          const managedAttachments = await fileAssetService.reconcileOwnerFiles({
            authContext: fileAuthContext,
            req,
            attachments: body.attachments,
            previousAttachments,
            ownerType: FileAsset.FILE_OWNER_TYPES.TASK,
            ownerId: task._id,
            method: 'PUT',
            session
          });
          task.attachments = [
            ...preserveLegacyAttachments(previousAttachments),
            ...managedAttachments
          ];
        }
        await task.save({ session: session || undefined });

        if (hasOwn(body, 'subTasks')) {
          await reconcileSubTasks({
            req,
            task,
            parsedSubTasks: parseSubTasks(body.subTasks),
            session,
            enforceActorOrgScope: management.authorization.mode !== 'DYNAMIC_LEADERSHIP'
          });
        }

        await auditService.record({
          req,
          action: AUDIT_ACTIONS.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPES.TASK,
          resourceId: task._id,
          before,
          after: asSnapshot(task),
          targetTeamId: task.teamId,
          session
        });
        return task;
      });

      if (!result) return notFound(res);
      await populateTask(result);
      try {
        const recipients = [
          ...result.executor.map((entry) => entry._id || entry),
          ...result.ccUsers.map((entry) => entry._id || entry)
        ];
        await notifications.notifyTaskUpdated(
          result,
          recipients,
          req.authContext.userId,
          '任务信息已更新'
        );
      } catch (error) {
        console.error('发送任务更新通知失败:', error);
      }
      return res.json({ message: '任务更新成功', task: result });
    } catch (error) {
      return sendControllerError(res, next, error, '更新任务错误:');
    }
  }

  async function deleteTask(req, res, next) {
    try {
      const deleted = await runAtomic(async (session) => {
        const { task } = await findTaskForManagement(req, ['task.edit'], session);
        if (!task) return null;
        const teamId = normalizeInputId(task.teamId, 'teamId');
        const orgUnitId = normalizeInputId(task.orgUnitId, 'orgUnitId');
        const children = task.isMainTask
          ? await withSession(TaskModel.find({
            teamId,
            orgUnitId,
            parentTask: task._id
          }), session)
          : [];
        const deletedTaskIds = [task._id, ...children.map((child) => child._id)];

        await deleteTaskReviews(teamId, deletedTaskIds, session);
        if (children.length > 0) {
          await TaskModel.deleteMany({
            teamId,
            orgUnitId,
            parentTask: task._id,
            _id: { $in: children.map((child) => child._id) }
          }, { session: session || undefined });
        }
        await TaskModel.deleteOne(
          { _id: task._id, teamId, orgUnitId },
          { session: session || undefined }
        );

        for (const child of children) {
          await auditService.record({
            req,
            action: AUDIT_ACTIONS.DELETE,
            resourceType: AUDIT_RESOURCE_TYPES.TASK,
            resourceId: child._id,
            before: asSnapshot(child),
            targetTeamId: teamId,
            session
          });
        }
        await auditService.record({
          req,
          action: AUDIT_ACTIONS.DELETE,
          resourceType: AUDIT_RESOURCE_TYPES.TASK,
          resourceId: task._id,
          before: asSnapshot(task),
          targetTeamId: teamId,
          session
        });
        return {
          teamId,
          taskName: task.taskName,
          recipients: [...task.executor.map(String), ...task.ccUsers.map(String)]
        };
      });

      if (!deleted) return notFound(res);
      try {
        await validateActiveTeamUsers(req.authContext, deleted.recipients, null);
        await notifications.notifyTaskDeleted(
          deleted.taskName,
          deleted.recipients,
          req.authContext.userId,
          deleted.teamId
        );
      } catch (error) {
        console.error('发送任务删除通知失败:', error);
      }
      return res.json({ message: '任务删除成功' });
    } catch (error) {
      return sendControllerError(res, next, error, '删除任务错误:');
    }
  }

  async function getMyTasks(req, res, next) {
    try {
      assertPermission(req.authContext, 'task.view');
      const { type = 'executor', status } = req.query;
      const ownConstraint = type === 'cc'
        ? { ccUsers: req.authContext.userId }
        : type === 'created'
          ? { creator: req.authContext.userId }
          : { executor: req.authContext.userId };
      const userFilter = combineUserConstraints([
        ownConstraint,
        taskStatusConstraint(status)
      ]);
      const tasks = await TaskModel.find(scopedListFilter(req, userFilter))
        .populate('creator', 'name username isSystemAccount')
        .populate('executor', 'name username isSystemAccount')
        .populate('mainExecutor', 'name username isSystemAccount')
        .populate('ccUsers', 'name username isSystemAccount')
        .populate({
          path: 'parentTask',
          select: 'taskName teamId orgUnitId',
          match: (child) => ({
            teamId: child.teamId,
            orgUnitId: child.orgUnitId
          })
        })
        .sort({ createdAt: -1 });
      return res.json({ tasks: tasks.map((task) => taskResponseValue(task)) });
    } catch (error) {
      return sendControllerError(res, next, error, '获取我的任务错误:');
    }
  }

  async function batchExportTasks(req, res, next) {
    try {
      assertPermission(req.authContext, 'task.export');
      const { startDate, endDate, status, priority, keyword } = req.query;
      const userFilter = combineUserConstraints([
        { isMainTask: true },
        taskStatusConstraint(status),
        priority ? { priority } : null,
        keywordConstraint(keyword),
        dateConstraint(startDate, endDate, true)
      ]);
      const mainTasks = await TaskModel.find(scopedListFilter(req, userFilter))
        .populate('creator', 'name username isSystemAccount')
        .populate('executor', 'name username isSystemAccount')
        .populate('mainExecutor', 'name username isSystemAccount')
        .populate('ccUsers', 'name username isSystemAccount')
        .populate('completedBy', 'name username isSystemAccount')
        .sort({ createdAt: 1 });

      const excelData = [];
      let rowIndex = 1;
      for (const task of mainTasks) {
        const taskTeamId = normalizeInputId(task.teamId, 'teamId');
        const [subTasks, reviews, extensions] = await Promise.all([
          TaskModel.find({
            teamId: taskTeamId,
            orgUnitId: task.orgUnitId,
            parentTask: task._id
          }).populate('executor', 'name username isSystemAccount').sort({ createdAt: 1 }),
          TaskReviewModel.find({ teamId: taskTeamId, task: task._id })
            .populate('reviewer', 'name username isSystemAccount')
            .sort({ createdAt: 1 }),
          ExtensionRequestModel.find({ teamId: taskTeamId, task: task._id })
            .sort({ applyTime: 1 })
        ]);

        excelData.push(exportRow(task, {
          rowIndex: rowIndex++,
          subTasks,
          reviews,
          extensions
        }));
        for (const subTask of subTasks) {
          excelData.push(exportSubTaskRow(subTask, task, rowIndex++));
        }
      }

      await auditService.record({
        req,
        action: AUDIT_ACTIONS.EXPORT,
        resourceType: AUDIT_RESOURCE_TYPES.TASK,
        after: {
          filters: { startDate, endDate, status, priority, keyword, teamId: req.query.teamId },
          taskCount: mainTasks.length,
          rowCount: excelData.length
        },
        targetTeamId: req.authContext.activeTeamId || req.query.teamId || null
      });

      const workbook = XLSX.utils.book_new();
      const worksheet = XLSX.utils.json_to_sheet(excelData);
      worksheet['!cols'] = exportColumnWidths();
      XLSX.utils.book_append_sheet(workbook, worksheet, '任务列表');
      const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
      const suffix = startDate && endDate
        ? `${String(startDate).slice(0, 10)}_${String(endDate).slice(0, 10)}`
        : '全部';
      const filename = `任务列表_${suffix}_${Date.now()}.xlsx`;
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
      return res.send(buffer);
    } catch (error) {
      return sendControllerError(res, next, error, '批量导出任务错误:');
    }
  }

  return Object.freeze({
    createTask,
    getTasks,
    getTaskById,
    getAssignableUsers,
    updateTask,
    deleteTask,
    getMyTasks,
    batchExportTasks
  });
}

function exportRow(task, { rowIndex, subTasks, reviews, extensions }) {
  return {
    '序号': rowIndex,
    '任务名称': task.taskName,
    '任务状态': getStatusText(task.status),
    '任务类型': task.taskType || '-',
    '任务来源': task.taskSource || '-',
    '优先级': getPriorityText(task.priority),
    '完成率': `${task.completionRate || 0}%`,
    '创建人': task.creator?.name || '-',
    '主负责人': task.mainExecutor?.name || '-',
    '执行人': names(task.executor),
    '抄送人': names(task.ccUsers),
    '创建时间': formatDate(task.createdAt),
    '开始时间': formatDate(task.startTime),
    '计划完成时间': formatDate(task.plannedCompletionTime),
    '实际完成时间': task.actualCompletionTime ? formatDate(task.actualCompletionTime) : '-',
    '是否超期': isOverdue(task) ? '是' : '否',
    '任务描述': task.description || '-',
    '备注': task.remarks || '-',
    '任务附件': attachmentNames(task.attachments),
    '完成人': task.completedBy?.name || '-',
    '完成说明': task.completionNote || '-',
    '完成附件': attachmentNames(task.completionAttachments),
    '子任务数': subTasks.length,
    '已完成子任务': subTasks.filter((item) => item.status === 'finished').length,
    '是否延期': task.hasExtensionRequest ? '是' : '否',
    '延期次数': extensions.length,
    '延期天数': extensions
      .filter((item) => item.status === 'approved')
      .reduce((sum, item) => sum + (item.approvedDays || 0), 0),
    '审核次数': reviews.length,
    '审核人': names(reviews.map((review) => review.reviewer)),
    '审核评分': reviews.length > 0
      ? (reviews.reduce((sum, review) => sum + (review.rating || 0), 0) / reviews.length).toFixed(1)
      : '-'
  };
}

function exportSubTaskRow(subTask, parentTask, rowIndex) {
  return {
    '序号': rowIndex,
    '任务名称': `└─ ${subTask.taskName} [子任务-${parentTask.taskName}]`,
    '任务状态': getStatusText(subTask.status),
    '任务类型': subTask.taskType || '-',
    '任务来源': subTask.taskSource || '-',
    '优先级': getPriorityText(subTask.priority),
    '完成率': `${subTask.completionRate || 0}%`,
    '创建人': parentTask.creator?.name || '-',
    '主负责人': '-',
    '执行人': names(subTask.executor),
    '抄送人': '-',
    '创建时间': formatDate(subTask.createdAt),
    '开始时间': formatDate(subTask.startTime),
    '计划完成时间': formatDate(subTask.plannedCompletionTime),
    '实际完成时间': subTask.actualCompletionTime ? formatDate(subTask.actualCompletionTime) : '-',
    '是否超期': isOverdue(subTask) ? '是' : '否',
    '任务描述': subTask.description || '-',
    '备注': subTask.remarks || '-',
    '任务附件': attachmentNames(subTask.attachments),
    '完成人': '-',
    '完成说明': subTask.completionNote || '-',
    '完成附件': attachmentNames(subTask.completionAttachments),
    '子任务数': 0,
    '已完成子任务': 0,
    '是否延期': subTask.hasExtensionRequest ? '是' : '否',
    '延期次数': 0,
    '延期天数': 0,
    '审核次数': 0,
    '审核人': '-',
    '审核评分': '-'
  };
}

function names(values) {
  const result = (values || []).filter(Boolean).map((value) => value.name).filter(Boolean);
  return result.length > 0 ? result.join('、') : '-';
}

function attachmentNames(values) {
  const result = (values || []).filter(Boolean).map((value) => value.originalName).filter(Boolean);
  return result.length > 0 ? result.join('; ') : '-';
}

function exportColumnWidths() {
  return [6, 30, 12, 12, 12, 10, 10, 12, 12, 20, 20, 18, 18, 18, 18, 10, 40, 30,
    40, 12, 40, 40, 10, 12, 10, 10, 10, 10, 30, 10].map((wch) => ({ wch }));
}

function formatDate(date) {
  if (!date) return '';
  const value = new Date(date);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  const hour = String(value.getHours()).padStart(2, '0');
  const minute = String(value.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function getStatusText(status) {
  return ({
    pending: '待开始',
    in_progress: '进行中',
    partial_completed: '部分完成',
    extension_pending: '延期待审批',
    extension_approved: '延期通过',
    completed: '已完成',
    pending_review: '待审核',
    pending_confirm: '待确认',
    finished: '已完结',
    overdue: '已逾期'
  })[status] || status;
}

function getPriorityText(priority) {
  return ({ low: '低', normal: '普通', high: '高', urgent: '紧急' })[priority] || priority;
}

function isOverdue(task) {
  return overdueDaysForTask(task) > 0;
}

const controller = createTaskController();

module.exports = {
  ...controller,
  createTaskController,
  isOverdue,
  overdueDaysForTask
};
