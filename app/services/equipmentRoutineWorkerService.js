'use strict';

const mongoose = require('mongoose');
const EquipmentAsset = require('../models/EquipmentAsset');
const EquipmentRoutinePlan = require('../models/EquipmentRoutinePlan');
const EquipmentRoutineRule = require('../models/EquipmentRoutineRule');
const Message = require('../models/Message');
const OrgUnit = require('../models/OrgUnit');
const TeamMembership = require('../models/TeamMembership');
const User = require('../models/User');
const { addCalendarInterval } = require('./equipmentRoutineCalendarService');
const {
  createEquipmentRoutineService,
  serializeRule
} = require('./equipmentRoutineService');
const {
  RECIPIENT_GROUPS,
  recipientUserIds,
  upsertRoutineMessage
} = require('./equipmentRoutineWorkflowService');
const { normalizeId } = require('./authSessionService');

const { EQUIPMENT_STATUSES } = EquipmentAsset;
const {
  EQUIPMENT_ROUTINE_RULE_STATUSES,
  EQUIPMENT_ROUTINE_SCHEDULE_TYPES,
  EQUIPMENT_ROUTINE_TYPES,
  defaultExecutionWindows
} = EquipmentRoutineRule;
const { EQUIPMENT_ROUTINE_PLAN_STATUSES } = EquipmentRoutinePlan;

const DAY_MS = 24 * 60 * 60 * 1000;

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

function timeZoneParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
  return Object.fromEntries(
    formatter.formatToParts(date)
      .filter(({ type }) => type !== 'literal')
      .map(({ type, value }) => [type, Number(value)])
  );
}

function zonedDate({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone) {
  let candidate = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const rendered = timeZoneParts(new Date(candidate), timeZone);
    const renderedUtc = Date.UTC(
      rendered.year,
      rendered.month - 1,
      rendered.day,
      rendered.hour,
      rendered.minute,
      rendered.second
    );
    const desiredUtc = Date.UTC(year, month - 1, day, hour, minute, second);
    const correction = desiredUtc - renderedUtc;
    candidate += correction;
    if (correction === 0) break;
  }
  return new Date(candidate);
}

function addLocalDays(parts, days) {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate()
  };
}

function weekdayFromParts(parts) {
  const day = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  return day === 0 ? 7 : day;
}

function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
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

function calendarAnchorAtOrBefore(firstDueAt, unit, interval, now) {
  const first = validDate(firstDueAt, 'firstDueAt');
  const instant = validDate(now, 'now');
  if (first >= instant) return first;
  if (unit === 'DAY' || unit === 'WEEK') {
    const intervalMs = interval * (unit === 'WEEK' ? 7 : 1) * DAY_MS;
    return new Date(first.getTime() + Math.floor((instant - first) / intervalMs) * intervalMs);
  }
  if (unit === 'MONTH') {
    const roughMonths = (
      (instant.getUTCFullYear() - first.getUTCFullYear()) * 12 +
      instant.getUTCMonth() - first.getUTCMonth()
    );
    let cycles = Math.max(0, Math.floor(roughMonths / interval));
    let candidate = addCalendarInterval(first, 'MONTH', cycles * interval || interval);
    if (cycles === 0) candidate = first;
    while (candidate > instant && cycles > 0) {
      cycles -= 1;
      candidate = cycles === 0 ? first : addCalendarInterval(first, 'MONTH', cycles * interval);
    }
    while (addCalendarInterval(candidate, 'MONTH', interval) <= instant) {
      candidate = addCalendarInterval(candidate, 'MONTH', interval);
    }
    return candidate;
  }
  throw new TypeError('Unsupported calendar unit');
}

function configuredAnchorParts(anchor, unit, config) {
  let parts = timeZoneParts(validDate(anchor), config.timeZone);
  if (unit === 'WEEK') {
    parts = {
      ...parts,
      ...addLocalDays(parts, config.weeklyDay - weekdayFromParts(parts))
    };
  }
  if (unit === 'MONTH') {
    parts.day = Math.min(config.monthlyDay, lastDayOfMonth(parts.year, parts.month));
  }
  return parts;
}

function windowBounds(anchor, unit, window, config) {
  const anchorParts = configuredAnchorParts(anchor, unit, config);
  const [startHour, startMinute] = window.startTime.split(':').map(Number);
  const [endHour, endMinute] = window.endTime.split(':').map(Number);
  const scheduledFor = zonedDate({
    ...anchorParts,
    hour: startHour,
    minute: startMinute,
    second: 0
  }, config.timeZone);
  let dueAt = zonedDate({
    ...anchorParts,
    hour: endHour,
    minute: endMinute,
    second: 0
  }, config.timeZone);
  if (dueAt <= scheduledFor) {
    dueAt = zonedDate({
      ...addLocalDays(anchorParts, 1),
      hour: endHour,
      minute: endMinute,
      second: 0
    }, config.timeZone);
  }
  return { scheduledFor, dueAt };
}

function statusAt({ scheduledFor, dueAt }, now) {
  const instant = validDate(now);
  if (instant < scheduledFor) return EQUIPMENT_ROUTINE_PLAN_STATUSES.PLANNED;
  if (instant <= dueAt) return EQUIPMENT_ROUTINE_PLAN_STATUSES.IN_WINDOW;
  return EQUIPMENT_ROUTINE_PLAN_STATUSES.OVERDUE;
}

function cycleVersionSegment(ruleVersion) {
  const version = Number(ruleVersion);
  return Number.isInteger(version) && version > 1 ? `v${version}:` : '';
}

function cycleKeyForCalendar(anchor, ruleVersion = null) {
  return `calendar:${cycleVersionSegment(ruleVersion)}${validDate(anchor).toISOString()}`;
}

function runtimeCycleKey(nextDueRuntimeHours, ruleVersion = null) {
  return `runtime:${cycleVersionSegment(ruleVersion)}${Number(nextDueRuntimeHours).toFixed(6)}`;
}

function dueStateTriggered(status) {
  return status === 'DUE' || status === 'OVERDUE';
}

function isCombinedAnyRule(rule) {
  return rule.schedule?.mode === EQUIPMENT_ROUTINE_SCHEDULE_TYPES.COMBINED &&
    rule.schedule?.duePolicy === 'ANY';
}

function combinedAnyCycleKey(schedule, triggerKey, ruleVersion = null) {
  const recordKey = schedule.latestRecordId || 'initial';
  const calendarKey = schedule.nextDueAt
    ? validDate(schedule.nextDueAt).toISOString()
    : 'none';
  const runtimeKey = schedule.nextDueRuntimeHours === null ||
    schedule.nextDueRuntimeHours === undefined
    ? 'none'
    : Number(schedule.nextDueRuntimeHours).toFixed(6);
  return `combined:any:${recordKey}:${cycleVersionSegment(ruleVersion)}calendar:${calendarKey}:runtime:${runtimeKey}:${triggerKey}`;
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
  EquipmentRoutinePlanModel = EquipmentRoutinePlan,
  EquipmentRoutineRuleModel = EquipmentRoutineRule,
  MessageModel = Message,
  OrgUnitModel = OrgUnit,
  TeamMembershipModel = TeamMembership,
  UserModel = User,
  routineService = createEquipmentRoutineService(),
  clock = () => new Date()
} = {}) {
  async function materializePlan({ rule, asset, anchor, unit, window, now, cycleKey }) {
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
    await EquipmentRoutinePlanModel.updateOne(filter, {
      $setOnInsert: {
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
      }
    }, { upsert: true, setDefaultsOnInsert: true });
    await EquipmentRoutinePlanModel.updateOne({
      ...filter,
      status: { $in: [
        EQUIPMENT_ROUTINE_PLAN_STATUSES.PLANNED,
        EQUIPMENT_ROUTINE_PLAN_STATUSES.IN_WINDOW,
        EQUIPMENT_ROUTINE_PLAN_STATUSES.OVERDUE
      ] }
    }, { $set: { status: desiredStatus } });
    return EquipmentRoutinePlanModel.findOne(filter).lean();
  }

  async function notifyPlan(plan, asset, now) {
    if (plan.status !== EQUIPMENT_ROUTINE_PLAN_STATUSES.OVERDUE) return 0;
    const config = executionConfig(plan.ruleSnapshot || {});
    const elapsed = validDate(now).getTime() - new Date(plan.dueAt).getTime();
    const levels = [];
    if (plan.routineType === EQUIPMENT_ROUTINE_TYPES.INSPECTION) {
      levels.push({
        key: 'INITIAL',
        thresholdMs: 0,
        group: RECIPIENT_GROUPS.EXECUTORS_AND_SUB_DEPARTMENT_MANAGER
      });
      levels.push({
        key: 'ESCALATED',
        thresholdMs: config.inspectionEscalationMinutes * 60 * 1000,
        group: RECIPIENT_GROUPS.ASSET_ADMIN_AND_DEPARTMENT_MANAGER
      });
    } else {
      levels.push(
        { key: 'DAY_1', thresholdMs: DAY_MS, group: RECIPIENT_GROUPS.SUB_DEPARTMENT_MANAGER },
        { key: 'DAY_2', thresholdMs: 2 * DAY_MS, group: RECIPIENT_GROUPS.ASSET_ADMIN },
        { key: 'DAY_3', thresholdMs: 3 * DAY_MS, group: RECIPIENT_GROUPS.DEPUTY_ASSISTANT_AND_MANAGER }
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
        group: level.group
      });
      const details = messageDetails({ plan, asset, level: level.key });
      await Promise.all(recipients.map((recipient) => upsertRoutineMessage({
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
        }
      })));
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
    const firstAnchor = isCombinedAnyRule(rule) && serviceSchedule.nextDueAt
      ? serviceSchedule.nextDueAt
      : schedule.calendar.firstDueAt;
    const current = calendarAnchorAtOrBefore(
      firstAnchor,
      schedule.calendar.unit,
      schedule.calendar.interval,
      now
    );
    const next = addCalendarInterval(current, schedule.calendar.unit, schedule.calendar.interval);
    return current.getTime() === next.getTime() ? [current] : [current, next];
  }

  async function materializeRuntimePlan(rule, asset, now, calculatedSchedule = null) {
    const schedule = calculatedSchedule ||
      await routineService.calculateRuleSchedule(rule, asset, { now });
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
    await EquipmentRoutinePlanModel.updateOne(filter, {
      $setOnInsert: {
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
      }
    }, { upsert: true, setDefaultsOnInsert: true });
    return EquipmentRoutinePlanModel.findOne(filter).lean();
  }

  async function findOpenCombinedAnyRuntimePlan(rule, asset, schedule) {
    if (!isCombinedAnyRule(rule) || schedule.nextDueRuntimeHours === null) return null;
    const cycleKey = combinedAnyCycleKey(
      schedule,
      `trigger:runtime:${Number(schedule.nextDueRuntimeHours).toFixed(6)}`,
      rule.version
    );
    return EquipmentRoutinePlanModel.findOne({
      teamId: rule.teamId,
      ruleId: rule._id,
      equipmentId: asset._id,
      cycleKey,
      windowKey: 'RUNTIME',
      status: { $in: [
        EQUIPMENT_ROUTINE_PLAN_STATUSES.PLANNED,
        EQUIPMENT_ROUTINE_PLAN_STATUSES.IN_WINDOW,
        EQUIPMENT_ROUTINE_PLAN_STATUSES.OVERDUE
      ] }
    }).lean();
  }

  async function cancelOtherCombinedAnyPlans(rule, asset, keepPlans) {
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
    const keepIds = keepPlans.map(({ _id }) => _id).filter(Boolean);
    if (keepIds.length > 0) filter._id = { $nin: keepIds };
    await EquipmentRoutinePlanModel.updateMany(filter, {
      $set: { status: EQUIPMENT_ROUTINE_PLAN_STATUSES.CANCELLED }
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
      const assets = await EquipmentAssetModel.find({
        teamId: rule.teamId,
        categoryId: rule.categoryId,
        status: EQUIPMENT_STATUSES.IN_USE
      }).lean();
      for (const asset of assets) {
        const scheduleMode = rule.schedule?.mode;
        const calculatedSchedule = [
          EQUIPMENT_ROUTINE_SCHEDULE_TYPES.CALENDAR,
          EQUIPMENT_ROUTINE_SCHEDULE_TYPES.RUNTIME_HOURS,
          EQUIPMENT_ROUTINE_SCHEDULE_TYPES.COMBINED
        ].includes(scheduleMode)
          ? await routineService.calculateRuleSchedule(rule, asset, { now: instant })
          : null;
        const plans = [];
        const existingRuntimePlan = isCombinedAnyRule(rule)
          ? await findOpenCombinedAnyRuntimePlan(rule, asset, calculatedSchedule)
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
              plans.push(await materializePlan({
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
              }));
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
            calculatedSchedule
          );
          if (runtimePlan) plans.push(runtimePlan);
        }
        await cancelOtherCombinedAnyPlans(rule, asset, plans);
        plansProcessed += plans.length;
        for (const plan of plans) {
          notificationWritesAttempted += await notifyPlan(plan, asset, instant);
        }
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
