'use strict';

const mongoose = require('mongoose');
const EquipmentAsset = require('../models/EquipmentAsset');
const EquipmentCategory = require('../models/EquipmentCategory');
const EquipmentRoutinePlan = require('../models/EquipmentRoutinePlan');
const EquipmentRoutineRule = require('../models/EquipmentRoutineRule');
const Message = require('../models/Message');
const OrgUnit = require('../models/OrgUnit');
const TeamMembership = require('../models/TeamMembership');
const User = require('../models/User');
const {
  DAY_MS,
  calendarAnchorAtOrBefore,
  calendarAnchorsAround,
  statusAt,
  timeZoneParts,
  windowBounds,
  zonedDate
} = require('./equipmentRoutineCalendarService');
const {
  createEquipmentRoutineService,
  resolveRoutineRuleAssetCategoryIds,
  serializeRule
} = require('./equipmentRoutineService');
const {
  RECIPIENT_GROUPS,
  recipientUserIds,
  upsertRoutineMessage
} = require('./equipmentRoutineWorkflowService');
const { normalizeId } = require('./authSessionService');
const { runWithRequiredTransaction } = require('./transactionService');
const {
  EQUIPMENT_ROUTINE_PLAN_REMATERIALIZATION_SOURCES,
  combinedAnyCycleKey,
  cycleKeyForCalendar,
  materializeOpenRoutinePlan,
  runtimeCycleKey
} = require('./equipmentRoutinePlanMaterializationService');

const { EQUIPMENT_STATUSES } = EquipmentAsset;
const {
  EQUIPMENT_ROUTINE_RULE_STATUSES,
  EQUIPMENT_ROUTINE_SCHEDULE_TYPES,
  EQUIPMENT_ROUTINE_TYPES,
  defaultExecutionWindows
} = EquipmentRoutineRule;
const {
  EQUIPMENT_ROUTINE_PLAN_STATUSES,
  EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS
} = EquipmentRoutinePlan;

const OPEN_ROUTINE_PLAN_STATUSES = Object.freeze([
  EQUIPMENT_ROUTINE_PLAN_STATUSES.PLANNED,
  EQUIPMENT_ROUTINE_PLAN_STATUSES.IN_WINDOW,
  EQUIPMENT_ROUTINE_PLAN_STATUSES.OVERDUE
]);

function modelQuery(query, session) {
  if (session && typeof query.session === 'function') query.session(session);
  return query;
}

function validDate(value, field = 'date') {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${field} must be a valid date`);
  return date;
}

function validTimeZone(value) {
  const timeZone = String(value || 'Asia/Shanghai');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
  } catch {
    throw new TypeError('executionConfig.timeZone must be a valid IANA time zone');
  }
  return timeZone;
}

function executionConfig(rule) {
  const source = rule.executionConfig || {};
  const windows = Array.isArray(source.windows) && source.windows.length
    ? source.windows
    : defaultExecutionWindows();
  return {
    timeZone: validTimeZone(source.timeZone || 'Asia/Shanghai'),
    windows: windows.filter(({ enabled }) => enabled !== false).map((window) => ({
      key: String(window.key),
      name: String(window.name),
      startTime: String(window.startTime),
      endTime: String(window.endTime)
    })),
    weeklyDay: Number.isInteger(source.weeklyDay) ? source.weeklyDay : 1,
    monthlyDay: Number.isInteger(source.monthlyDay) ? source.monthlyDay : 1,
    inspectionEscalationMinutes: Number.isInteger(source.inspectionEscalationMinutes)
      ? source.inspectionEscalationMinutes
      : 60,
    locationPolicy: source.locationPolicy || 'PENDING_CONFIRMATION',
    locationPrecisionMeters: source.locationPrecisionMeters ?? null
  };
}

function dueStateTriggered(status) {
  return status === 'DUE' || status === 'OVERDUE';
}

function isCombinedAnyRule(rule) {
  return rule.schedule?.mode === EQUIPMENT_ROUTINE_SCHEDULE_TYPES.COMBINED &&
    rule.schedule?.duePolicy === 'ANY';
}

function messageDetails({ plan, asset, level }) {
  const isInspection = plan.routineType === EQUIPMENT_ROUTINE_TYPES.INSPECTION;
  return {
    title: isInspection ? '设备点检逾期提醒' : '设备保养逾期提醒',
    content: `${asset.name}（${asset.assetCode}）${plan.windowName}计划已逾期，提醒级别：${level}`
  };
}

function createEquipmentRoutineWorkerService({
  EquipmentAssetModel = EquipmentAsset,
  EquipmentCategoryModel = EquipmentCategory,
  EquipmentRoutinePlanModel = EquipmentRoutinePlan,
  EquipmentRoutineRuleModel = EquipmentRoutineRule,
  MessageModel = Message,
  OrgUnitModel = OrgUnit,
  TeamMembershipModel = TeamMembership,
  UserModel = User,
  routineService = createEquipmentRoutineService(),
  connection = mongoose.connection,
  clock = () => new Date()
} = {}) {
  async function materializePlan({ rule, asset, anchor, unit, window, now, cycleKey }, session) {
    const config = executionConfig(rule);
    const bounds = windowBounds(anchor, unit, window, config);
    const desiredStatus = statusAt(bounds, now);
    const filter = {
      teamId: rule.teamId,
      ruleId: rule._id,
      equipmentId: asset._id,
      cycleKey,
      windowKey: window.key
    };
    const completedCycle = await modelQuery(EquipmentRoutinePlanModel.findOne({
      teamId: rule.teamId,
      ruleId: rule._id,
      equipmentId: asset._id,
      cycleKey,
      windowKey: window.key,
      status: EQUIPMENT_ROUTINE_PLAN_STATUSES.COMPLETED
    }).select('_id').lean(), session);
    if (completedCycle) return null;
    return materializeOpenRoutinePlan({
      EquipmentRoutinePlanModel,
      filter,
      insert: {
        teamId: rule.teamId,
        orgUnitId: asset.orgUnitId,
        equipmentId: asset._id,
        categoryId: asset.categoryId,
        ruleId: rule._id,
        ruleVersion: rule.version,
        ruleSnapshot: serializeRule(rule),
        routineType: rule.routineType,
        cycleKey,
        windowKey: window.key,
        windowName: window.name,
        scheduledFor: bounds.scheduledFor,
        dueAt: bounds.dueAt,
        status: desiredStatus
      },
      desiredStatus,
      rematerializedAt: now,
      source: EQUIPMENT_ROUTINE_PLAN_REMATERIALIZATION_SOURCES.WORKER,
      recoverableCancellationReasons: (
        rule.schedule?.mode === EQUIPMENT_ROUTINE_SCHEDULE_TYPES.COMBINED &&
        rule.schedule?.duePolicy === 'ALL'
      )
        ? [
            EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS.EQUIPMENT_CATEGORY_CHANGED,
            EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS.SUPERSEDED,
            EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS.SIBLING_COMPLETED
          ]
        : [
            EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS.EQUIPMENT_CATEGORY_CHANGED,
            EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS.SIBLING_COMPLETED
          ],
      session
    });
  }

  async function notifyPlan(plan, asset, now, session) {
    if (plan.status !== EQUIPMENT_ROUTINE_PLAN_STATUSES.OVERDUE) return 0;
    const config = executionConfig(plan.ruleSnapshot || {});
    const elapsed = validDate(now).getTime() - new Date(plan.dueAt).getTime();
    const levels = [];
    if (plan.routineType === EQUIPMENT_ROUTINE_TYPES.INSPECTION) {
      levels.push({
        key: 'INITIAL',
        thresholdMs: 0,
        group: RECIPIENT_GROUPS.SUB_DEPARTMENT_MANAGER
      });
      levels.push({
        key: 'ESCALATED',
        thresholdMs: config.inspectionEscalationMinutes * 60 * 1000,
        group: RECIPIENT_GROUPS.SUB_DEPARTMENT_MANAGER
      });
    } else {
      levels.push(
        { key: 'DAY_1', thresholdMs: DAY_MS, group: RECIPIENT_GROUPS.SUB_DEPARTMENT_MANAGER },
        { key: 'DAY_2', thresholdMs: 2 * DAY_MS, group: RECIPIENT_GROUPS.SUB_DEPARTMENT_MANAGER },
        { key: 'DAY_3', thresholdMs: 3 * DAY_MS, group: RECIPIENT_GROUPS.SUB_DEPARTMENT_MANAGER }
      );
    }
    let attempted = 0;
    for (const level of levels.filter(({ thresholdMs }) => elapsed >= thresholdMs)) {
      const recipients = await recipientUserIds({
        TeamMembershipModel,
        OrgUnitModel,
        UserModel,
        teamId: plan.teamId,
        orgUnitId: plan.orgUnitId,
        group: level.group,
        session
      });
      const details = messageDetails({ plan, asset, level: level.key });
      for (const recipient of recipients) {
        await upsertRoutineMessage({
          MessageModel,
          payload: {
            teamId: plan.teamId,
            type: 'system',
            title: details.title,
            content: details.content,
            recipient,
            deduplicationKey: `routine-plan:${plan._id}:level:${level.key}`,
            extraData: {
              resourceType: 'EQUIPMENT_ROUTINE_PLAN',
              planId: normalizeId(plan._id),
              equipmentId: normalizeId(plan.equipmentId),
              routineType: plan.routineType,
              level: level.key,
              page: '/pages/equipment/routine-workbench'
            }
          },
          session
        });
      }
      attempted += recipients.length;
    }
    return attempted;
  }

  async function anchorsForRule(rule, asset, now, calculatedSchedule = null) {
    const schedule = rule.schedule;
    if (!schedule?.calendar) return [];
    const serviceSchedule = calculatedSchedule ||
      await routineService.calculateRuleSchedule(rule, asset, { now });
    if (
      schedule.mode === EQUIPMENT_ROUTINE_SCHEDULE_TYPES.COMBINED &&
      schedule.duePolicy === 'ALL' &&
      !dueStateTriggered(serviceSchedule.runtimeStatus)
    ) {
      return [];
    }
    if (
      isCombinedAnyRule(rule) &&
      dueStateTriggered(serviceSchedule.runtimeStatus) &&
      !dueStateTriggered(serviceSchedule.calendarStatus)
    ) {
      return [];
    }
    if (rule.routineType === EQUIPMENT_ROUTINE_TYPES.MAINTENANCE) {
      return serviceSchedule.nextDueAt ? [new Date(serviceSchedule.nextDueAt)] : [];
    }
    const firstAnchor = serviceSchedule.nextDueAt || schedule.calendar.firstDueAt;
    const config = executionConfig(rule);
    const { current, next } = calendarAnchorsAround(
      firstAnchor,
      schedule.calendar.unit,
      schedule.calendar.interval,
      now,
      config.timeZone
    );
    return current.getTime() === next.getTime() ? [current] : [current, next];
  }

  async function materializeRuntimePlan(rule, asset, now, calculatedSchedule = null, session = null) {
    const schedule = calculatedSchedule ||
      await routineService.calculateRuleSchedule(rule, asset, { now, session });
    if (schedule.nextDueRuntimeHours === null) return null;
    if (isCombinedAnyRule(rule)) {
      if (
        !dueStateTriggered(schedule.runtimeStatus) ||
        dueStateTriggered(schedule.calendarStatus)
      ) return null;
    } else if (!dueStateTriggered(schedule.status)) {
      return null;
    }
    const config = executionConfig(rule);
    const window = config.windows[0];
    const cycleKey = isCombinedAnyRule(rule)
      ? combinedAnyCycleKey(
          schedule,
          `trigger:runtime:${Number(schedule.nextDueRuntimeHours).toFixed(6)}`,
          rule.version
        )
      : runtimeCycleKey(schedule.nextDueRuntimeHours, rule.version);
    const filter = {
      teamId: rule.teamId,
      ruleId: rule._id,
      equipmentId: asset._id,
      cycleKey,
      windowKey: 'RUNTIME'
    };
    return materializeOpenRoutinePlan({
      EquipmentRoutinePlanModel,
      filter,
      insert: {
        teamId: rule.teamId,
        orgUnitId: asset.orgUnitId,
        equipmentId: asset._id,
        categoryId: asset.categoryId,
        ruleId: rule._id,
        ruleVersion: rule.version,
        ruleSnapshot: serializeRule(rule),
        routineType: rule.routineType,
        cycleKey,
        windowKey: 'RUNTIME',
        windowName: `${window.name} / ${schedule.nextDueRuntimeHours}h`,
        scheduledFor: now,
        dueAt: now,
        status: EQUIPMENT_ROUTINE_PLAN_STATUSES.OVERDUE
      },
      desiredStatus: EQUIPMENT_ROUTINE_PLAN_STATUSES.OVERDUE,
      rematerializedAt: now,
      source: EQUIPMENT_ROUTINE_PLAN_REMATERIALIZATION_SOURCES.WORKER,
      session
    });
  }

  async function findOpenCombinedAnyRuntimePlan(rule, asset, schedule, now, session = null) {
    if (!isCombinedAnyRule(rule) || schedule.nextDueRuntimeHours === null) return null;
    const cycleKey = combinedAnyCycleKey(
      schedule,
      `trigger:runtime:${Number(schedule.nextDueRuntimeHours).toFixed(6)}`,
      rule.version
    );
    const filter = {
      teamId: rule.teamId,
      ruleId: rule._id,
      equipmentId: asset._id,
      cycleKey,
      windowKey: 'RUNTIME'
    };
    const existing = await modelQuery(EquipmentRoutinePlanModel.findOne({
      ...filter,
      $or: [
        { status: { $in: OPEN_ROUTINE_PLAN_STATUSES } },
        {
          status: EQUIPMENT_ROUTINE_PLAN_STATUSES.CANCELLED,
          cancellationReason:
            EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS.EQUIPMENT_CATEGORY_CHANGED
        }
      ]
    }).lean(), session);
    if (!existing) return null;
    if (OPEN_ROUTINE_PLAN_STATUSES.includes(existing.status)) return existing;
    const recovered = await materializeOpenRoutinePlan({
      EquipmentRoutinePlanModel,
      filter: { ...filter, _id: existing._id },
      insert: null,
      desiredStatus: EQUIPMENT_ROUTINE_PLAN_STATUSES.OVERDUE,
      rematerializedAt: now,
      source: EQUIPMENT_ROUTINE_PLAN_REMATERIALIZATION_SOURCES.WORKER,
      allowInsert: false,
      session
    });
    return recovered && OPEN_ROUTINE_PLAN_STATUSES.includes(recovered.status)
      ? recovered
      : null;
  }

  async function cancelOtherCombinedAnyPlans(rule, asset, keepPlans, now, session = null) {
    if (!isCombinedAnyRule(rule)) return;
    const filter = {
      teamId: rule.teamId,
      ruleId: rule._id,
      equipmentId: asset._id,
      status: { $in: [
        EQUIPMENT_ROUTINE_PLAN_STATUSES.PLANNED,
        EQUIPMENT_ROUTINE_PLAN_STATUSES.IN_WINDOW,
        EQUIPMENT_ROUTINE_PLAN_STATUSES.OVERDUE
      ] }
    };
    const keepIds = keepPlans.filter(Boolean).map(({ _id }) => _id).filter(Boolean);
    if (keepIds.length > 0) filter._id = { $nin: keepIds };
    await EquipmentRoutinePlanModel.updateMany(filter, {
      $set: {
        status: EQUIPMENT_ROUTINE_PLAN_STATUSES.CANCELLED,
        cancellationReason: EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS.SUPERSEDED,
        cancelledAt: now,
        cancelledBy: null
      }
    }, { session });
  }

  async function materializeRuleForAsset(staleRule, assetId, instant) {
    return runWithRequiredTransaction(async (session) => {
      const rule = await EquipmentRoutineRuleModel.findOneAndUpdate({
        _id: staleRule._id,
        teamId: staleRule.teamId,
        status: EQUIPMENT_ROUTINE_RULE_STATUSES.ACTIVE,
        version: staleRule.version
      }, {
        $inc: { materializationRevision: 1 }
      }, {
        new: true,
        session,
        timestamps: false
      }).lean();
      if (!rule) {
        return { staleRule: true, plansProcessed: 0, notificationWritesAttempted: 0 };
      }

      const allowedCategoryIds = await resolveRoutineRuleAssetCategoryIds({
        EquipmentCategoryModel,
        teamId: rule.teamId,
        ruleCategoryId: rule.categoryId,
        session
      });
      const asset = await EquipmentAssetModel.findOneAndUpdate({
        _id: assetId,
        teamId: rule.teamId,
        categoryId: { $in: allowedCategoryIds },
        status: EQUIPMENT_STATUSES.IN_USE
      }, {
        $inc: { routineMaterializationRevision: 1 }
      }, {
        new: true,
        session,
        timestamps: false
      }).lean();
      if (!asset) {
        return { staleRule: false, plansProcessed: 0, notificationWritesAttempted: 0 };
      }

      const scheduleMode = rule.schedule?.mode;
      const calculatedSchedule = [
        EQUIPMENT_ROUTINE_SCHEDULE_TYPES.CALENDAR,
        EQUIPMENT_ROUTINE_SCHEDULE_TYPES.RUNTIME_HOURS,
        EQUIPMENT_ROUTINE_SCHEDULE_TYPES.COMBINED
      ].includes(scheduleMode)
        ? await routineService.calculateRuleSchedule(rule, asset, { now: instant, session })
        : null;
      const plans = [];
      const existingRuntimePlan = isCombinedAnyRule(rule)
        ? await findOpenCombinedAnyRuntimePlan(rule, asset, calculatedSchedule, instant, session)
        : null;
      const runtimeOwnsCombinedCycle = Boolean(existingRuntimePlan) || (
        isCombinedAnyRule(rule) &&
        dueStateTriggered(calculatedSchedule.runtimeStatus) &&
        !dueStateTriggered(calculatedSchedule.calendarStatus)
      );
      if ([
        EQUIPMENT_ROUTINE_SCHEDULE_TYPES.CALENDAR,
        EQUIPMENT_ROUTINE_SCHEDULE_TYPES.COMBINED
      ].includes(scheduleMode) && !runtimeOwnsCombinedCycle) {
        const anchors = await anchorsForRule(rule, asset, instant, calculatedSchedule);
        const config = executionConfig(rule);
        const windows = rule.routineType === EQUIPMENT_ROUTINE_TYPES.MAINTENANCE
          ? config.windows.slice(0, 1)
          : config.windows;
        for (const anchor of anchors) {
          for (const window of windows) {
            const plan = await materializePlan({
              rule,
              asset,
              anchor,
              unit: rule.schedule.calendar.unit,
              window,
              now: instant,
              cycleKey: isCombinedAnyRule(rule)
                ? combinedAnyCycleKey(
                    calculatedSchedule,
                    `trigger:calendar:${validDate(anchor).toISOString()}`,
                    rule.version
                  )
                : cycleKeyForCalendar(anchor, rule.version)
            }, session);
            if (plan) plans.push(plan);
          }
        }
      }
      if (
        scheduleMode === EQUIPMENT_ROUTINE_SCHEDULE_TYPES.RUNTIME_HOURS ||
        runtimeOwnsCombinedCycle
      ) {
        const runtimePlan = existingRuntimePlan || await materializeRuntimePlan(
          rule,
          asset,
          instant,
          calculatedSchedule,
          session
        );
        if (runtimePlan) plans.push(runtimePlan);
      }
      await cancelOtherCombinedAnyPlans(rule, asset, plans, instant, session);
      let notificationWritesAttempted = 0;
      for (const plan of plans) {
        notificationWritesAttempted += await notifyPlan(plan, asset, instant, session);
      }
      return {
        staleRule: false,
        plansProcessed: plans.length,
        notificationWritesAttempted
      };
    }, connection, {
      code: 'EQUIPMENT_ROUTINE_TRANSACTIONS_REQUIRED',
      message: 'Equipment routine plan materialization requires MongoDB replica-set transactions'
    });
  }

  async function reconcileRulePlanScope(staleRule, instant) {
    return runWithRequiredTransaction(async (session) => {
      const rule = await modelQuery(EquipmentRoutineRuleModel.findOne({
        _id: staleRule._id,
        teamId: staleRule.teamId,
        version: staleRule.version
      }).lean(), session);
      if (!rule) return;

      const allowedCategoryIds = await resolveRoutineRuleAssetCategoryIds({
        EquipmentCategoryModel,
        teamId: rule.teamId,
        ruleCategoryId: rule.categoryId,
        session
      });
      const openPlans = await modelQuery(EquipmentRoutinePlanModel.find({
        teamId: rule.teamId,
        ruleId: rule._id,
        status: { $in: OPEN_ROUTINE_PLAN_STATUSES }
      }).select('_id equipmentId').lean(), session);
      if (openPlans.length === 0) return;

      const ruleIsActive = rule.status === EQUIPMENT_ROUTINE_RULE_STATUSES.ACTIVE;
      let cancellationReason = allowedCategoryIds.length === 0
        ? EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS.RULE_CATEGORY_INVALID
        : EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS.RULE_DEACTIVATED;
      let planIds = openPlans.map(({ _id }) => _id);
      if (ruleIsActive && allowedCategoryIds.length > 0) {
        cancellationReason = EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS.EQUIPMENT_CATEGORY_CHANGED;
        const equipmentIds = [...new Set(openPlans.map(({ equipmentId }) => normalizeId(equipmentId)))]
          .filter(Boolean);
        const applicableAssets = await modelQuery(EquipmentAssetModel.find({
          _id: { $in: equipmentIds },
          teamId: rule.teamId,
          categoryId: { $in: allowedCategoryIds }
        }).select('_id').lean(), session);
        const applicableAssetIds = new Set(applicableAssets.map(({ _id }) => normalizeId(_id)));
        planIds = openPlans
          .filter(({ equipmentId }) => !applicableAssetIds.has(normalizeId(equipmentId)))
          .map(({ _id }) => _id);
      }
      if (planIds.length === 0) return;

      await EquipmentRoutinePlanModel.updateMany({
        _id: { $in: planIds },
        teamId: rule.teamId,
        ruleId: rule._id,
        status: { $in: OPEN_ROUTINE_PLAN_STATUSES }
      }, {
        $set: {
          status: EQUIPMENT_ROUTINE_PLAN_STATUSES.CANCELLED,
          cancellationReason,
          cancelledAt: instant,
          cancelledBy: null
        }
      }, { session });
    }, connection, {
      code: 'EQUIPMENT_ROUTINE_TRANSACTIONS_REQUIRED',
      message: 'Equipment routine plan reconciliation requires MongoDB replica-set transactions'
    });
  }

  async function runOnce({ now = clock(), teamId = null } = {}) {
    const instant = validDate(now, 'now');
    const ruleFilter = { status: EQUIPMENT_ROUTINE_RULE_STATUSES.ACTIVE };
    if (teamId) {
      if (!mongoose.isValidObjectId(teamId)) throw new TypeError('teamId must be a valid ObjectId');
      ruleFilter.teamId = teamId;
    }
    const rules = await EquipmentRoutineRuleModel.find(ruleFilter).lean();
    let plansProcessed = 0;
    let notificationWritesAttempted = 0;
    for (const rule of rules) {
      const allowedCategoryIds = await resolveRoutineRuleAssetCategoryIds({
        EquipmentCategoryModel,
        teamId: rule.teamId,
        ruleCategoryId: rule.categoryId
      });
      const assets = await EquipmentAssetModel.find({
        teamId: rule.teamId,
        categoryId: { $in: allowedCategoryIds },
        status: EQUIPMENT_STATUSES.IN_USE
      }).lean();
      for (const asset of assets) {
        const materialized = await materializeRuleForAsset(rule, asset._id, instant);
        plansProcessed += materialized.plansProcessed;
        notificationWritesAttempted += materialized.notificationWritesAttempted;
        if (materialized.staleRule) break;
      }
      await reconcileRulePlanScope(rule, instant);
    }
    const openPlanFilter = { status: { $in: OPEN_ROUTINE_PLAN_STATUSES } };
    if (teamId) openPlanFilter.teamId = teamId;
    const openRuleIds = await EquipmentRoutinePlanModel.distinct('ruleId', openPlanFilter);
    if (openRuleIds.length > 0) {
      const inactiveRuleFilter = {
        _id: { $in: openRuleIds },
        status: { $ne: EQUIPMENT_ROUTINE_RULE_STATUSES.ACTIVE }
      };
      if (teamId) inactiveRuleFilter.teamId = teamId;
      const inactiveRules = await EquipmentRoutineRuleModel.find(inactiveRuleFilter).lean();
      for (const rule of inactiveRules) {
        await reconcileRulePlanScope(rule, instant);
      }
    }
    return {
      runAt: instant,
      rulesProcessed: rules.length,
      plansProcessed,
      notificationWritesAttempted
    };
  }

  return Object.freeze({ runOnce });
}

function startEquipmentRoutineScheduler({
  enabled = process.env.EQUIPMENT_ROUTINE_WORKER_ENABLED === 'true',
  intervalMs = Number(process.env.EQUIPMENT_ROUTINE_WORKER_INTERVAL_MS || 5 * 60 * 1000),
  worker = createEquipmentRoutineWorkerService(),
  logger = console
} = {}) {
  if (!enabled) return Object.freeze({ enabled: false, stop() {} });
  if (!Number.isInteger(intervalMs) || intervalMs < 1000) {
    throw new TypeError('EQUIPMENT_ROUTINE_WORKER_INTERVAL_MS must be an integer of at least 1000');
  }
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await worker.runOnce();
    } catch (error) {
      logger.error('Equipment routine worker failed:', error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  void tick();
  return Object.freeze({
    enabled: true,
    stop() { clearInterval(timer); }
  });
}

module.exports = {
  DAY_MS,
  calendarAnchorAtOrBefore,
  createEquipmentRoutineWorkerService,
  cycleKeyForCalendar,
  executionConfig,
  startEquipmentRoutineScheduler,
  statusAt,
  timeZoneParts,
  windowBounds,
  zonedDate
};
