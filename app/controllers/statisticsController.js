'use strict';

const XLSX = require('xlsx');
const Task = require('../models/Task');
const User = require('../models/User');
const TaskReview = require('../models/TaskReview');
const ExtensionRequest = require('../models/ExtensionRequest');
const TeamMembership = require('../models/TeamMembership');
const { SYSTEM_ACCOUNT_DISPLAY_NAME } = require('../config/systemAccount');
const {
  DATA_SCOPES,
  MEMBERSHIP_STATUSES,
  SESSION_MODES
} = require('../config/permissions');
const {
  buildRequestScopedFilter,
  normalizeObjectId
} = require('../services/scopedQueryService');
const { AuthContextError } = require('../services/authContextError');
const { resolveModuleDataScope } = require('../services/teamContextService');

const TASK_STATUSES = new Set([
  'pending',
  'in_progress',
  'partial_completed',
  'extension_pending',
  'extension_approved',
  'completed',
  'pending_review',
  'pending_confirm',
  'finished'
]);

const STATUS_TEXT = Object.freeze({
  pending: '待开始',
  in_progress: '进行中',
  partial_completed: '部分完成',
  extension_pending: '待延期审批',
  extension_approved: '延期通过',
  completed: '已完成',
  pending_review: '待审核',
  pending_confirm: '待确认',
  finished: '已完结'
});

const PRIORITY_TEXT = Object.freeze({
  low: '低',
  normal: '普通',
  high: '高',
  urgent: '紧急'
});

function statisticsError(message) {
  return new AuthContextError(400, 'STATISTICS_INVALID_FILTER', message);
}

function idOf(value) {
  if (value === undefined || value === null) return '';
  return String(value._id || value);
}

function sameId(left, right) {
  const leftId = idOf(left).toLowerCase();
  const rightId = idOf(right).toLowerCase();
  return Boolean(leftId && rightId && leftId === rightId);
}

function pairKey(teamId, userId) {
  return `${idOf(teamId).toLowerCase()}:${idOf(userId).toLowerCase()}`;
}

function parseDate(value, fieldName) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw statisticsError(`${fieldName} is not a valid date`);
  }
  return parsed;
}

function buildDateFilter(query = {}) {
  const startDate = parseDate(query.startDate, 'startDate');
  const endDate = parseDate(query.endDate, 'endDate');
  if (startDate && endDate && startDate > endDate) {
    throw statisticsError('startDate must not be later than endDate');
  }
  if (!startDate && !endDate) return {};

  const createdAt = {};
  if (startDate) createdAt.$gte = startDate;
  if (endDate) createdAt.$lte = endDate;
  return { createdAt };
}

function requestedGlobalTeamId(req) {
  return req.authContext?.mode === SESSION_MODES.GLOBAL_READ_ONLY
    ? req.query?.teamId
    : undefined;
}

function buildTaskFilter(req, userFilter = {}) {
  return buildRequestScopedFilter(req, {
    moduleKey: 'task',
    userFilter,
    globalTeamId: requestedGlobalTeamId(req)
  });
}

function membershipTeamFilter(req) {
  if (req.authContext?.mode === SESSION_MODES.TEAM) {
    const dataScope = resolveModuleDataScope(req.authContext, 'task');
    const filter = {
      teamId: normalizeObjectId(req.authContext.activeTeamId, 'activeTeamId')
    };
    if (dataScope.scope === DATA_SCOPES.ORG_UNIT) {
      filter.orgUnitId = normalizeObjectId(dataScope.orgUnitId, 'orgUnitId');
    }
    return filter;
  }
  if (
    req.authContext?.mode === SESSION_MODES.GLOBAL_READ_ONLY &&
    req.query?.teamId !== undefined &&
    req.query.teamId !== ''
  ) {
    return { teamId: normalizeObjectId(req.query.teamId, 'teamId') };
  }
  return {};
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

function sendWorkbook(res, xlsx, rows, sheetName, filenamePrefix, columns) {
  const workbook = xlsx.utils.book_new();
  const worksheet = xlsx.utils.json_to_sheet(rows);
  worksheet['!cols'] = columns;
  xlsx.utils.book_append_sheet(workbook, worksheet, sheetName);

  const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const filename = `${filenamePrefix}_${Date.now()}.xlsx`;
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
  );
  return res.send(buffer);
}

function indexBy(items, keySelector) {
  const result = new Map();
  for (const item of items) {
    const key = keySelector(item);
    if (!result.has(key)) result.set(key, []);
    result.get(key).push(item);
  }
  return result;
}

function collectUserIds(tasks, reviews) {
  const ids = new Set();
  for (const task of tasks) {
    [task.creator, task.mainExecutor, ...(task.executor || []), ...(task.ccUsers || [])]
      .map(idOf)
      .filter(Boolean)
      .forEach((id) => ids.add(id));
  }
  for (const review of reviews) {
    const reviewerId = idOf(review.reviewer);
    if (reviewerId) ids.add(reviewerId);
  }
  return [...ids];
}

async function loadTeamUserNames({ TeamMembershipModel, UserModel, tasks, reviews }) {
  const teamIds = [...new Set(tasks.map((task) => idOf(task.teamId)).filter(Boolean))];
  const userIds = collectUserIds(tasks, reviews);
  if (teamIds.length === 0 || userIds.length === 0) return new Map();

  const memberships = await TeamMembershipModel.find({
    teamId: { $in: teamIds },
    userId: { $in: userIds }
  }).select('teamId userId').lean();
  const allowedUserIds = [...new Set(memberships.map((item) => idOf(item.userId)))];
  const users = await UserModel.find({ _id: { $in: allowedUserIds } })
    .select('_id name username isSystemAccount')
    .lean();
  const displayNamesById = new Map(users.map((user) => [
    idOf(user._id),
    user.isSystemAccount === true
      ? SYSTEM_ACCOUNT_DISPLAY_NAME
      : user.name || user.username || ''
  ]));
  const namesByTeamAndUser = new Map();

  for (const membership of memberships) {
    const name = displayNamesById.get(idOf(membership.userId));
    if (name !== undefined) {
      namesByTeamAndUser.set(
        pairKey(membership.teamId, membership.userId),
        name
      );
    }
  }
  return namesByTeamAndUser;
}

function displayName(namesByTeamAndUser, teamId, userId) {
  return namesByTeamAndUser.get(pairKey(teamId, userId)) || '';
}

function exactRelatedRecords(records, tasksById) {
  return records.filter((record) => {
    const task = tasksById.get(idOf(record.task));
    return task && sameId(record.teamId, task.teamId);
  });
}

function createStatisticsController(overrides = {}) {
  const TaskModel = overrides.Task || Task;
  const UserModel = overrides.User || User;
  const TaskReviewModel = overrides.TaskReview || TaskReview;
  const ExtensionRequestModel = overrides.ExtensionRequest || ExtensionRequest;
  const TeamMembershipModel = overrides.TeamMembership || TeamMembership;
  const xlsx = overrides.XLSX || XLSX;

  async function exportTasksToExcel(req, res, next) {
    try {
      const userFilter = {
        isMainTask: true,
        ...buildDateFilter(req.query)
      };
      if (req.query.status !== undefined && req.query.status !== '') {
        if (!TASK_STATUSES.has(req.query.status)) {
          throw statisticsError('status is invalid');
        }
        userFilter.status = req.query.status;
      }
      if (req.query.executor !== undefined && req.query.executor !== '') {
        userFilter.executor = normalizeObjectId(req.query.executor, 'executor');
      }

      const tasks = await TaskModel.find(buildTaskFilter(req, userFilter))
        .sort({ createdAt: -1, _id: -1 })
        .lean();
      const mainTaskIds = tasks.map((task) => task._id);
      if (mainTaskIds.length === 0) {
        return sendWorkbook(
          res,
          xlsx,
          [],
          '任务统计',
          '任务统计',
          TASK_EXPORT_COLUMNS
        );
      }

      const [subTasks, reviewCandidates, extensionCandidates] = await Promise.all([
        TaskModel.find(buildTaskFilter(req, { parentTask: { $in: mainTaskIds } }))
          .select('_id teamId parentTask status')
          .lean(),
        TaskReviewModel.find({ task: { $in: mainTaskIds } })
          .select('teamId task reviewer content reviewTime')
          .sort({ reviewTime: 1, _id: 1 })
          .lean(),
        ExtensionRequestModel.find({ task: { $in: mainTaskIds } })
          .select('teamId task approvedDays applyTime')
          .sort({ applyTime: -1, _id: -1 })
          .lean()
      ]);

      const tasksById = new Map(tasks.map((task) => [idOf(task._id), task]));
      const reviews = exactRelatedRecords(reviewCandidates, tasksById);
      const extensions = exactRelatedRecords(extensionCandidates, tasksById);
      const subTasksByParent = indexBy(subTasks, (task) => idOf(task.parentTask));
      const reviewsByTask = indexBy(reviews, (review) => idOf(review.task));
      const extensionsByTask = indexBy(extensions, (extension) => idOf(extension.task));
      const names = await loadTeamUserNames({
        TeamMembershipModel,
        UserModel,
        tasks,
        reviews
      });

      const rows = tasks.map((task) => {
        const taskSubTasks = subTasksByParent.get(idOf(task._id)) || [];
        const taskReviews = reviewsByTask.get(idOf(task._id)) || [];
        const latestExtension = (extensionsByTask.get(idOf(task._id)) || [])[0];
        return {
          '任务名称': task.taskName,
          '任务类型': task.taskType || '',
          '任务来源': task.taskSource || '',
          '创建人': displayName(names, task.teamId, task.creator),
          '执行人': (task.executor || [])
            .map((userId) => displayName(names, task.teamId, userId))
            .filter(Boolean)
            .join(', '),
          '主负责人': displayName(names, task.teamId, task.mainExecutor),
          '抄送人': (task.ccUsers || [])
            .map((userId) => displayName(names, task.teamId, userId))
            .filter(Boolean)
            .join(', '),
          '开始时间': formatDate(task.startTime),
          '计划完成时间': formatDate(task.plannedCompletionTime),
          '实际完成时间': formatDate(task.actualCompletionTime),
          '任务状态': STATUS_TEXT[task.status] || task.status,
          '完成率': `${task.completionRate || 0}%`,
          '优先级': PRIORITY_TEXT[task.priority] || task.priority,
          '子任务数': taskSubTasks.length,
          '已完成子任务': taskSubTasks.filter((item) => item.status === 'finished').length,
          '是否延期': task.hasExtensionRequest ? '是' : '否',
          '延期天数': latestExtension?.approvedDays || '',
          '审核人': taskReviews
            .map((review) => displayName(names, task.teamId, review.reviewer))
            .filter(Boolean)
            .join(', '),
          '审核评价': taskReviews.map((review) => review.content || '').filter(Boolean).join('; '),
          '创建时间': formatDate(task.createdAt),
          '备注': task.remarks || ''
        };
      });

      return sendWorkbook(
        res,
        xlsx,
        rows,
        '任务统计',
        '任务统计',
        TASK_EXPORT_COLUMNS
      );
    } catch (error) {
      return next(error);
    }
  }

  async function exportUserStatistics(req, res, next) {
    try {
      const tasks = await TaskModel.find(buildTaskFilter(req, buildDateFilter(req.query)))
        .select(
          '_id teamId creator executor ccUsers status hasExtensionRequest createdAt'
        )
        .lean();
      const taskIds = tasks.map((task) => task._id);
      const tasksById = new Map(tasks.map((task) => [idOf(task._id), task]));
      const memberships = await TeamMembershipModel.find({
        ...membershipTeamFilter(req),
        status: MEMBERSHIP_STATUSES.ACTIVE
      })
        .select('teamId userId orgUnitId role status')
        .populate({ path: 'orgUnitId', select: '_id teamId name' })
        .sort({ createdAt: 1, _id: 1 })
        .lean();
      const membershipUserIds = [...new Set(
        memberships.map((membership) => idOf(membership.userId))
      )];
      const users = await UserModel.find({
        _id: { $in: membershipUserIds },
        status: 'active'
      }).select('_id name username status').lean();
      const usersById = new Map(users.map((user) => [idOf(user._id), user]));

      const reviewCandidates = taskIds.length === 0 || membershipUserIds.length === 0
        ? []
        : await TaskReviewModel.find({
          task: { $in: taskIds },
          reviewer: { $in: membershipUserIds }
        }).select('teamId task reviewer').lean();
      const reviews = exactRelatedRecords(reviewCandidates, tasksById);
      const reviewCounts = new Map();
      for (const review of reviews) {
        const key = pairKey(review.teamId, review.reviewer);
        reviewCounts.set(key, (reviewCounts.get(key) || 0) + 1);
      }

      const taskCounters = new Map();
      function counter(teamId, userId) {
        const key = pairKey(teamId, userId);
        if (!taskCounters.has(key)) {
          taskCounters.set(key, {
            executed: 0,
            finished: 0,
            delayed: 0,
            cc: 0,
            created: 0
          });
        }
        return taskCounters.get(key);
      }

      for (const task of tasks) {
        const teamId = task.teamId;
        const uniqueExecutors = new Set((task.executor || []).map(idOf).filter(Boolean));
        for (const userId of uniqueExecutors) {
          const values = counter(teamId, userId);
          values.executed += 1;
          if (task.status === 'finished') values.finished += 1;
          if (task.hasExtensionRequest) values.delayed += 1;
        }
        for (const userId of new Set((task.ccUsers || []).map(idOf).filter(Boolean))) {
          counter(teamId, userId).cc += 1;
        }
        if (task.creator) counter(teamId, task.creator).created += 1;
      }

      const rows = [];
      for (const membership of memberships) {
        const user = usersById.get(idOf(membership.userId));
        if (!user) continue;
        const key = pairKey(membership.teamId, membership.userId);
        const values = taskCounters.get(key) || {
          executed: 0,
          finished: 0,
          delayed: 0,
          cc: 0,
          created: 0
        };
        const populatedOrgUnit = membership.orgUnitId;
        const department = populatedOrgUnit && sameId(populatedOrgUnit.teamId, membership.teamId)
          ? populatedOrgUnit.name || ''
          : '';
        rows.push({
          '姓名': user.name,
          '用户名': user.username,
          '部门': department,
          '执行任务数': values.executed,
          '已完成任务数': values.finished,
          '完成率': values.executed > 0
            ? `${Math.round(values.finished / values.executed * 100)}%`
            : '0%',
          '延期任务数': values.delayed,
          '抄送任务数': values.cc,
          '已审核任务数': reviewCounts.get(key) || 0,
          '创建任务数': values.created
        });
      }

      return sendWorkbook(
        res,
        xlsx,
        rows,
        '人员统计',
        '人员统计',
        USER_EXPORT_COLUMNS
      );
    } catch (error) {
      return next(error);
    }
  }

  async function getStatisticsOverview(req, res, next) {
    try {
      const tasks = await TaskModel.find(buildTaskFilter(req))
        .select('_id teamId isMainTask status hasExtensionRequest priority')
        .lean();
      const taskIds = tasks.map((task) => task._id);
      const mainTasks = tasks.filter((task) => task.isMainTask === true);
      const totalTasks = mainTasks.length;
      const inProgressTasks = mainTasks.filter(
        (task) => task.status === 'in_progress' || task.status === 'partial_completed'
      ).length;
      const finishedTasks = mainTasks.filter((task) => task.status === 'finished').length;
      const delayedTasks = mainTasks.filter((task) => task.hasExtensionRequest === true).length;
      const pendingReviewTasks = tasks.filter((task) => task.status === 'pending_review').length;
      const pendingConfirmTasks = tasks.filter((task) => task.status === 'pending_confirm').length;
      const pendingExtensionCandidates = taskIds.length === 0
        ? []
        : await ExtensionRequestModel.find({
          task: { $in: taskIds },
          status: 'pending'
        }).select('teamId task').lean();
      const tasksById = new Map(tasks.map((task) => [idOf(task._id), task]));
      const pendingExtensions = exactRelatedRecords(
        pendingExtensionCandidates,
        tasksById
      ).length;

      const membershipUserIds = await TeamMembershipModel.distinct('userId', {
        ...membershipTeamFilter(req),
        status: MEMBERSHIP_STATUSES.ACTIVE
      });
      const totalUsers = membershipUserIds.length === 0
        ? 0
        : await UserModel.countDocuments({
          _id: { $in: membershipUserIds },
          status: 'active'
        });

      const priorityStats = { low: 0, normal: 0, high: 0, urgent: 0 };
      for (const task of mainTasks) {
        if (Object.prototype.hasOwnProperty.call(priorityStats, task.priority)) {
          priorityStats[task.priority] += 1;
        }
      }

      return res.json({
        overview: {
          totalTasks,
          inProgressTasks,
          finishedTasks,
          delayedTasks,
          pendingReviewTasks,
          pendingConfirmTasks,
          pendingExtensions,
          totalUsers,
          completionRate: totalTasks > 0
            ? Math.round(finishedTasks / totalTasks * 100)
            : 0,
          priorityStats
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  return {
    exportTasksToExcel,
    exportUserStatistics,
    getStatisticsOverview
  };
}

const TASK_EXPORT_COLUMNS = [
  { wch: 20 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 15 },
  { wch: 10 }, { wch: 15 }, { wch: 18 }, { wch: 18 }, { wch: 18 },
  { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 12 },
  { wch: 10 }, { wch: 10 }, { wch: 15 }, { wch: 30 }, { wch: 18 },
  { wch: 20 }
];

const USER_EXPORT_COLUMNS = [
  { wch: 10 }, { wch: 15 }, { wch: 12 }, { wch: 12 }, { wch: 14 },
  { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 12 }
];

const controller = createStatisticsController();

module.exports = {
  ...controller,
  createStatisticsController
};
