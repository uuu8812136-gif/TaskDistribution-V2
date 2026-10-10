'use strict';

const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const mongoose = require('mongoose');
const EquipmentAsset = require('../models/EquipmentAsset');
const EquipmentCategory = require('../models/EquipmentCategory');
const EquipmentRoutineRule = require('../models/EquipmentRoutineRule');
const EquipmentRoutineRecord = require('../models/EquipmentRoutineRecord');
const EquipmentRoutinePlan = require('../models/EquipmentRoutinePlan');
const EquipmentRoutineException = require('../models/EquipmentRoutineException');
const EquipmentRuntimeReading = require('../models/EquipmentRuntimeReading');
const ProjectTeam = require('../models/ProjectTeam');
const OrgUnit = require('../models/OrgUnit');
const User = require('../models/User');
const FileAsset = require('../models/FileAsset');
const {
  AUDIT_ACTIONS,
  AUDIT_RESOURCE_TYPES,
  DATA_SCOPES,
  DATA_SCOPE_MODULES,
  SESSION_MODES,
  TEAM_STATUSES
} = require('../config/permissions');
const { createAuditService } = require('./auditService');
const { normalizeId } = require('./authSessionService');
const { createFileAssetService } = require('./fileAssetService');
const {
  buildScopedDetailFilter,
  buildScopedFilter,
  buildScopedOrgUnitIdConstraint,
  normalizeObjectId
} = require('./scopedQueryService');
const {
  assertBusinessContext,
  assertPermission,
  assertTeamContext,
  resolveModuleDataScope,
  sameId
} = require('./teamContextService');
const {
  runWithOptionalTransaction,
  supportsTransactions
} = require('./transactionService');
const {
  addCalendarInterval,
  calendarAnchorsAround,
  classifyCalendarDue,
  classifyRuntimeDue,
  combineDueStates,
  statusAt,
  windowBounds
} = require('./equipmentRoutineCalendarService');
const { EquipmentRegistryError } = require('./equipmentRegistryService');
const {
  createEquipmentRoutineWorkflowService
} = require('./equipmentRoutineWorkflowService');
const {
  EQUIPMENT_ROUTINE_PLAN_REMATERIALIZATION_SOURCES,
  combinedAnyCycleKey,
  combinedAnyGenerationPrefix,
  cycleKeyForCalendar,
  materializeOpenRoutinePlan,
  runtimeCycleKey
} = require('./equipmentRoutinePlanMaterializationService');

const {
  EQUIPMENT_ROUTINE_TYPES,
  EQUIPMENT_ROUTINE_TYPE_VALUES,
  EQUIPMENT_ROUTINE_RULE_STATUSES,
  EQUIPMENT_ROUTINE_RULE_STATUS_VALUES,
  EQUIPMENT_ROUTINE_SCHEDULE_TYPES,
  EQUIPMENT_ROUTINE_SCHEDULE_TYPE_VALUES,
  EQUIPMENT_ROUTINE_CALENDAR_UNIT_VALUES,
  EQUIPMENT_ROUTINE_DUE_POLICY_VALUES,
  EQUIPMENT_ROUTINE_PHOTO_POLICIES,
  EQUIPMENT_ROUTINE_PHOTO_POLICY_VALUES,
  EQUIPMENT_ROUTINE_LOCATION_POLICIES,
  EQUIPMENT_ROUTINE_LOCATION_POLICY_VALUES,
  defaultExecutionWindows
} = EquipmentRoutineRule;
const { FILE_OWNER_TYPES } = FileAsset;
const {
  EQUIPMENT_ROUTINE_LOCATION_STATUSES,
  EQUIPMENT_ROUTINE_LOCATION_STATUS_VALUES,
  EQUIPMENT_ROUTINE_OVERALL_RESULTS,
  EQUIPMENT_ROUTINE_OVERALL_RESULT_VALUES
} = EquipmentRoutineRecord;
const {
  EQUIPMENT_ROUTINE_PLAN_STATUSES,
  EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS,
  effectiveRoutinePlanStatus,
  isRoutinePlanCurrentBusinessDate,
  isRoutinePlanRestDayEligible,
  routinePlanCancellationReason,
  routinePlanCancellationReasonLabel,
  routinePlanWindowName
} = EquipmentRoutinePlan;
const { EQUIPMENT_STATUSES } = EquipmentAsset;
const { EQUIPMENT_CATEGORY_STATUSES } = EquipmentCategory;

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 200;
const MAX_CHECKLIST_ITEMS = 500;
const MAX_PHOTOS = 10;
const ROUTINE_PRIMARY_CATEGORY_DEPTH = 3;
const EQUIPMENT_CATEGORY_STRUCTURE_CONFLICT = Object.freeze({
  code: 'EQUIPMENT_CATEGORY_STRUCTURE_CONFLICT',
  message: 'Equipment category structure changed concurrently; retry the operation'
});
const OPEN_ROUTINE_PLAN_STATUSES = Object.freeze([
  EQUIPMENT_ROUTINE_PLAN_STATUSES.PLANNED,
  EQUIPMENT_ROUTINE_PLAN_STATUSES.IN_WINDOW,
  EQUIPMENT_ROUTINE_PLAN_STATUSES.OVERDUE
]);

function routineTypeAllowedForEquipmentStatus(routineType, status) {
  if (routineType === EQUIPMENT_ROUTINE_TYPES.MAINTENANCE) {
    return [
      EQUIPMENT_STATUSES.IN_USE,
      EQUIPMENT_STATUSES.IDLE,
      EQUIPMENT_STATUSES.STOPPED
    ].includes(status);
  }
  return status === EQUIPMENT_STATUSES.IN_USE;
}

function routineError(status, code, message) {
  return new EquipmentRegistryError(status, code, message);
}

function notFound(resource = 'Equipment routine resource') {
  return routineError(404, 'EQUIPMENT_ROUTINE_NOT_FOUND', `${resource} does not exist`);
}

function inputInvalid(message) {
  return routineError(400, 'EQUIPMENT_ROUTINE_INPUT_INVALID', message);
}

function plain(document) {
  return typeof document?.toObject === 'function'
    ? document.toObject({ depopulate: true, versionKey: false })
    : document;
}

function requiredString(value, field, max) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw inputInvalid(`${field} is required`);
  }
  const normalized = value.trim();
  if (normalized.length > max) throw inputInvalid(`${field} is too long`);
  return normalized;
}

function optionalString(value, field, max, fallback = '') {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') throw inputInvalid(`${field} must be a string`);
  const normalized = value.trim();
  if (normalized.length > max) throw inputInvalid(`${field} is too long`);
  return normalized || fallback;
}

function booleanValue(value, field, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw inputInvalid(`${field} must be a boolean`);
  return value;
}

function finiteNumber(value, field, { min = 0, required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw inputInvalid(`${field} is required`);
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    throw inputInvalid(`${field} must be a finite number greater than or equal to ${min}`);
  }
  return value;
}

function integer(value, field, { min = 0, max = 2147483647, fallback = 0 } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw inputInvalid(`${field} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function pagination(query = {}) {
  const page = integer(query.page, 'page', { min: 1, max: 1000000, fallback: 1 });
  const pageSize = integer(query.pageSize, 'pageSize', {
    min: 1,
    max: MAX_PAGE_SIZE,
    fallback: DEFAULT_PAGE_SIZE
  });
  return { page, pageSize, skip: (page - 1) * pageSize };
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ROUTINE_CALENDAR_TIME_ZONE = 'Asia/Shanghai';
const ROUTINE_CALENDAR_MONTH_PATTERN = /^(\d{4})-(\d{2})$/;

function routineCalendarMonthRange(value) {
  const match = ROUTINE_CALENDAR_MONTH_PATTERN.exec(String(value || '').trim());
  if (!match) throw inputInvalid('month must use YYYY-MM format');
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw inputInvalid('month must use YYYY-MM format');
  // Shanghai has a fixed +08:00 offset. Use half-open UTC boundaries so
  // records at the exact next-month midnight are not included twice.
  const start = new Date(Date.UTC(year, month - 1, 1) - (8 * 60 * 60 * 1000));
  const nextStart = new Date(Date.UTC(year, month, 1) - (8 * 60 * 60 * 1000));
  const days = Math.round((nextStart.getTime() - start.getTime()) / 86400000);
  return { month: `${match[1]}-${match[2]}`, start, nextStart, days };
}

function routineCalendarDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: ROUTINE_CALENDAR_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(date)
      .filter(({ type }) => type !== 'literal')
      .map(({ type, value: partValue }) => [type, partValue])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function calendarAnchorFromCycleKey(cycleKey) {
  const value = String(cycleKey || '');
  const match = value.match(/^calendar:(?:v\d+:)?(.+)$/) ||
    value.match(/:trigger:calendar:(.+)$/);
  if (!match) return null;
  const anchor = new Date(match[1]);
  return Number.isNaN(anchor.getTime()) ? null : anchor;
}

function nextFixedCalendarAnchor(
  calendar,
  referenceAt,
  completedAnchor = null,
  timeZone = 'UTC'
) {
  const firstDueAt = new Date(calendar.firstDueAt);
  if (completedAnchor) {
    const aroundCompleted = calendarAnchorsAround(
      firstDueAt,
      calendar.unit,
      calendar.interval,
      completedAnchor,
      timeZone
    );
    if (aroundCompleted.current.getTime() === completedAnchor.getTime()) {
      return aroundCompleted.next;
    }
  }
  const reference = new Date(referenceAt);
  const aroundReference = calendarAnchorsAround(
    firstDueAt,
    calendar.unit,
    calendar.interval,
    reference,
    timeZone
  );
  return aroundReference.current > reference
    ? aroundReference.current
    : aroundReference.next;
}

function submissionRuntimeState(rule, schedule, runtimeHours) {
  let runtimeState = schedule.runtimeStatus;
  if (
    runtimeHours !== null &&
    schedule.nextDueRuntimeHours !== null &&
    schedule.nextDueRuntimeHours !== undefined &&
    rule.schedule.runtime
  ) {
    runtimeState = classifyRuntimeDue({
      currentHours: runtimeHours,
      nextDueHours: schedule.nextDueRuntimeHours,
      intervalHours: rule.schedule.runtime.intervalHours
    });
  }
  return runtimeState;
}

function dueStateTriggered(status) {
  return status === 'DUE' || status === 'OVERDUE';
}

function submissionCalendarAnchors(rule, schedule, performedAt) {
  const calendar = rule.schedule?.calendar;
  if (!calendar || !schedule.nextDueAt) return [];
  if (rule.routineType === EQUIPMENT_ROUTINE_TYPES.MAINTENANCE) {
    return [new Date(schedule.nextDueAt)];
  }
  const firstAnchor = schedule.nextDueAt || calendar.firstDueAt;
  const timeZone = serializeExecutionConfig(rule.executionConfig).timeZone;
  const { current, next } = calendarAnchorsAround(
    firstAnchor,
    calendar.unit,
    calendar.interval,
    performedAt,
    timeZone
  );
  return current.getTime() === next.getTime() ? [current] : [current, next];
}

function submissionMaterializationTargets(
  rule,
  schedule,
  performedAt,
  runtimeHours
) {
  const targets = new Map();
  const addTarget = (target) => {
    if (!target.cycleKey || !target.windowKey) return;
    targets.set(`${target.cycleKey}\u0000${target.windowKey}`, target);
  };
  const addRuntimeIdentity = (combinedAny = false) => {
    if (schedule.nextDueRuntimeHours === null || schedule.nextDueRuntimeHours === undefined) return;
    const threshold = Number(schedule.nextDueRuntimeHours).toFixed(6);
    const cycleKey = combinedAny
        ? combinedAnyCycleKey(schedule, `trigger:runtime:${threshold}`, rule.version)
        : runtimeCycleKey(schedule.nextDueRuntimeHours, rule.version);
    const config = serializeExecutionConfig(rule.executionConfig);
    const window = config.windows.find(({ enabled }) => enabled !== false) || config.windows[0];
    addTarget({
      cycleKey,
      windowKey: 'RUNTIME',
      windowName: `${window.name} / ${schedule.nextDueRuntimeHours}h`,
      scheduledFor: performedAt,
      dueAt: performedAt,
      status: EQUIPMENT_ROUTINE_PLAN_STATUSES.OVERDUE
    });
  };
  const addCalendarIdentities = (combinedAny = false) => {
    const config = serializeExecutionConfig(rule.executionConfig);
    const enabledWindows = config.windows.filter(({ enabled }) => enabled !== false);
    const windows = rule.routineType === EQUIPMENT_ROUTINE_TYPES.MAINTENANCE
      ? enabledWindows.slice(0, 1)
      : enabledWindows;
    for (const anchor of submissionCalendarAnchors(rule, schedule, performedAt)) {
      const cycleKey = combinedAny
        ? combinedAnyCycleKey(
            schedule,
            `trigger:calendar:${anchor.toISOString()}`,
            rule.version
          )
        : cycleKeyForCalendar(anchor, rule.version);
      for (const window of windows) {
        const bounds = windowBounds(anchor, rule.schedule.calendar.unit, window, config);
        addTarget({
          cycleKey,
          windowKey: window.key,
          windowName: window.name,
          scheduledFor: bounds.scheduledFor,
          dueAt: bounds.dueAt,
          status: statusAt(bounds, performedAt)
        });
      }
    }
  };

  if (rule.schedule.mode === EQUIPMENT_ROUTINE_SCHEDULE_TYPES.CALENDAR) {
    addCalendarIdentities();
  } else if (rule.schedule.mode === EQUIPMENT_ROUTINE_SCHEDULE_TYPES.RUNTIME_HOURS) {
    if (dueStateTriggered(submissionRuntimeState(rule, schedule, runtimeHours))) {
      addRuntimeIdentity();
    }
  } else if (rule.schedule.mode === EQUIPMENT_ROUTINE_SCHEDULE_TYPES.COMBINED) {
    const runtimeTriggered = dueStateTriggered(
      submissionRuntimeState(rule, schedule, runtimeHours)
    );
    if (rule.schedule.duePolicy === 'ANY') {
      addCalendarIdentities(true);
      if (runtimeTriggered) addRuntimeIdentity(true);
    } else {
      addCalendarIdentities();
    }
  }
  return [...targets.values()];
}

function submissionPlanTriggerSatisfied(rule, plan, schedule, runtimeHours, performedAt) {
  if (rule.schedule.mode === EQUIPMENT_ROUTINE_SCHEDULE_TYPES.MANUAL) return true;
  const calendarWindowStarted = Boolean(
    plan &&
    plan.windowKey !== 'RUNTIME' &&
    new Date(plan.scheduledFor) <= performedAt
  );
  const runtimeTriggered = dueStateTriggered(
    submissionRuntimeState(rule, schedule, runtimeHours)
  );
  if (rule.schedule.mode === EQUIPMENT_ROUTINE_SCHEDULE_TYPES.CALENDAR) {
    return calendarWindowStarted;
  }
  if (rule.schedule.mode === EQUIPMENT_ROUTINE_SCHEDULE_TYPES.RUNTIME_HOURS) {
    return runtimeTriggered;
  }
  if (rule.schedule.duePolicy === 'ANY') {
    return plan?.windowKey === 'RUNTIME' ? runtimeTriggered : calendarWindowStarted;
  }
  return calendarWindowStarted && runtimeTriggered;
}

function legacyPlanlessRecordCoversPlan(schedule, plan) {
  if (!schedule?.latestRecord || schedule.latestRecord.planId || !plan) return false;
  const performedAt = new Date(schedule.latestRecord.performedAt);
  const scheduledFor = new Date(plan.scheduledFor);
  return !Number.isNaN(performedAt.getTime()) &&
    !Number.isNaN(scheduledFor.getTime()) &&
    scheduledFor <= performedAt;
}

function normalizeRelatedId(value) {
  try {
    return normalizeObjectId(value, 'related resource id');
  } catch {
    throw notFound();
  }
}

function normalizeDetailId(value) {
  try {
    return normalizeObjectId(value, 'id');
  } catch {
    throw notFound();
  }
}

function assertOnlyKeys(input, allowedKeys, field = 'input') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw inputInvalid(`${field} must be an object`);
  }
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) throw inputInvalid(`${field}.${unknown} is not supported`);
}

function assertNoClientTeamId(input) {
  if (Object.prototype.hasOwnProperty.call(input || {}, 'teamId')) {
    throw routineError(
      400,
      'EQUIPMENT_TEAM_ID_IMMUTABLE',
      'teamId is derived from the authenticated team and cannot be supplied by the client'
    );
  }
}

function serializeRule(document) {
  const value = plain(document);
  return {
    _id: normalizeId(value._id),
    teamId: normalizeId(value.teamId),
    categoryId: normalizeId(value.categoryId),
    routineType: value.routineType,
    name: value.name,
    description: value.description || '',
    checklistItems: (value.checklistItems || []).map((item) => ({
      key: item.key,
      name: item.name,
      description: item.description || '',
      required: item.required === true,
      sortOrder: item.sortOrder
    })),
    schedule: value.schedule,
    status: value.status,
    version: value.version,
    photoPolicy: value.photoPolicy,
    abnormalNoteRequired: value.abnormalNoteRequired === true,
    executionConfig: serializeExecutionConfig(value.executionConfig),
    createdBy: normalizeId(value.createdBy),
    updatedBy: normalizeId(value.updatedBy),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  };
}

function serializeRecord(document) {
  const value = plain(document);
  const linkedPlan = value.plan ? plain(value.plan) : null;
  const planScheduledFor = linkedPlan?.scheduledFor || value.planScheduledFor || value.scheduledFor || null;
  const planDueAt = linkedPlan?.dueAt || value.planDueAt || null;
  const plan = linkedPlan ? {
    _id: normalizeId(linkedPlan._id),
    cycleKey: linkedPlan.cycleKey,
    windowKey: linkedPlan.windowKey,
    windowName: routinePlanWindowName(linkedPlan),
    originalWindowName: linkedPlan.windowName,
    scheduledFor: linkedPlan.scheduledFor,
    dueAt: linkedPlan.dueAt,
    status: linkedPlan.status,
    cancellationReason: routinePlanCancellationReason(linkedPlan),
    cancellationReasonLabel: routinePlanCancellationReasonLabel(linkedPlan)
  } : null;
  return {
    _id: normalizeId(value._id),
    teamId: normalizeId(value.teamId),
    orgUnitId: normalizeId(value.orgUnitId),
    equipmentId: normalizeId(value.equipmentId),
    categoryId: normalizeId(value.categoryId),
    ruleId: normalizeId(value.ruleId),
    ruleVersion: value.ruleVersion,
    planId: normalizeId(value.planId),
    routineType: value.routineType,
    scheduledFor: planScheduledFor,
    planScheduledFor,
    planDueAt,
    planWindowName: plan?.windowName || null,
    planCycleKey: plan?.cycleKey || null,
    plan,
    dueRuntimeHours: value.dueRuntimeHours ?? null,
    performedBy: normalizeId(value.performedBy),
    performedAt: value.performedAt,
    performedRuntimeHours: value.performedRuntimeHours ?? null,
    itemResults: (value.itemResults || []).map((item) => ({
      itemKey: item.itemKey,
      result: item.result,
      note: item.note || ''
    })),
    overallResult: value.overallResult,
    abnormalSummary: value.abnormalSummary || '',
    photoFileIds: (value.photoFileIds || []).map(normalizeId),
    photoEvidence: (value.photoEvidence || []).map((evidence) => ({
      fileId: normalizeId(evidence.fileId),
      sourceType: evidence.sourceType,
      capturedAt: evidence.capturedAt || null,
      locationStatus: evidence.locationStatus,
      longitude: evidence.longitude ?? null,
      latitude: evidence.latitude ?? null,
      accuracyMeters: evidence.accuracyMeters ?? null,
      address: evidence.address || '',
      watermarkText: evidence.watermarkText || ''
    })),
    idempotencyKey: value.idempotencyKey || null,
    ruleSnapshot: value.ruleSnapshot,
    createdAt: value.createdAt
  };
}

function serializeExecutionConfig(value = {}) {
  const windows = Array.isArray(value?.windows) && value.windows.length
    ? value.windows
    : defaultExecutionWindows();
  return {
    timeZone: value?.timeZone || 'Asia/Shanghai',
    windows: windows.map((window) => ({
      key: window.key,
      name: window.name,
      startTime: window.startTime,
      endTime: window.endTime,
      enabled: window.enabled !== false
    })),
    weeklyDay: value?.weeklyDay ?? 1,
    monthlyDay: value?.monthlyDay ?? 1,
    inspectionEscalationMinutes: value?.inspectionEscalationMinutes ?? 60,
    locationPolicy: value?.locationPolicy || EQUIPMENT_ROUTINE_LOCATION_POLICIES.PENDING_CONFIRMATION,
    locationPrecisionMeters: value?.locationPrecisionMeters ?? null
  };
}

function planMaterializationConfiguration(rule) {
  const executionConfig = serializeExecutionConfig(rule?.executionConfig);
  return {
    schedule: rule?.schedule || null,
    executionConfig: {
      timeZone: executionConfig.timeZone,
      windows: executionConfig.windows,
      weeklyDay: executionConfig.weeklyDay,
      monthlyDay: executionConfig.monthlyDay
    }
  };
}

function validTimeZone(value) {
  const timeZone = requiredString(value, 'executionConfig.timeZone', 64);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
  } catch {
    throw inputInvalid('executionConfig.timeZone must be a valid IANA time zone');
  }
  return timeZone;
}

function normalizeExecutionConfig(value) {
  if (value === undefined || value === null) return serializeExecutionConfig();
  assertOnlyKeys(value, [
    'timeZone',
    'windows',
    'weeklyDay',
    'monthlyDay',
    'inspectionEscalationMinutes',
    'locationPolicy',
    'locationPrecisionMeters'
  ], 'executionConfig');
  const windows = value.windows === undefined ? defaultExecutionWindows() : value.windows;
  if (!Array.isArray(windows) || windows.length < 1 || windows.length > 8) {
    throw inputInvalid('executionConfig.windows must contain between 1 and 8 items');
  }
  const normalizedWindows = windows.map((window, index) => {
    assertOnlyKeys(window, ['key', 'name', 'startTime', 'endTime', 'enabled'], `executionConfig.windows[${index}]`);
    const key = requiredString(window.key, `executionConfig.windows[${index}].key`, 50).toUpperCase();
    if (!/^[A-Z0-9](?:[A-Z0-9_-]{0,48}[A-Z0-9])?$/.test(key)) {
      throw inputInvalid(`executionConfig.windows[${index}].key is invalid`);
    }
    const startTime = requiredString(window.startTime, `executionConfig.windows[${index}].startTime`, 5);
    const endTime = requiredString(window.endTime, `executionConfig.windows[${index}].endTime`, 5);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime)) {
      throw inputInvalid('execution window times must use HH:mm');
    }
    return {
      key,
      name: requiredString(window.name, `executionConfig.windows[${index}].name`, 100),
      startTime,
      endTime,
      enabled: booleanValue(window.enabled, `executionConfig.windows[${index}].enabled`, true)
    };
  });
  if (new Set(normalizedWindows.map(({ key }) => key)).size !== normalizedWindows.length) {
    throw inputInvalid('execution window keys must be unique');
  }
  if (!normalizedWindows.some(({ enabled }) => enabled)) {
    throw inputInvalid('At least one execution window must be enabled');
  }
  const locationPolicy = value.locationPolicy || EQUIPMENT_ROUTINE_LOCATION_POLICIES.PENDING_CONFIRMATION;
  if (!EQUIPMENT_ROUTINE_LOCATION_POLICY_VALUES.includes(locationPolicy)) {
    throw inputInvalid('executionConfig.locationPolicy is invalid');
  }
  const precision = finiteNumber(
    value.locationPrecisionMeters,
    'executionConfig.locationPrecisionMeters',
    { min: 1 }
  );
  return {
    timeZone: validTimeZone(value.timeZone || 'Asia/Shanghai'),
    windows: normalizedWindows,
    weeklyDay: integer(value.weeklyDay, 'executionConfig.weeklyDay', { min: 1, max: 7, fallback: 1 }),
    monthlyDay: integer(value.monthlyDay, 'executionConfig.monthlyDay', { min: 1, max: 31, fallback: 1 }),
    inspectionEscalationMinutes: integer(
      value.inspectionEscalationMinutes,
      'executionConfig.inspectionEscalationMinutes',
      { min: 1, max: 10080, fallback: 60 }
    ),
    locationPolicy,
    locationPrecisionMeters: precision
  };
}

function serializeReading(document) {
  const value = plain(document);
  return {
    _id: normalizeId(value._id),
    teamId: normalizeId(value.teamId),
    orgUnitId: normalizeId(value.orgUnitId),
    equipmentId: normalizeId(value.equipmentId),
    hours: value.hours,
    previousHours: value.previousHours ?? null,
    recordedAt: value.recordedAt,
    operatorId: normalizeId(value.operatorId),
    source: value.source,
    sourceRecordId: normalizeId(value.sourceRecordId),
    reason: value.reason || null
  };
}

function normalizeSchedule(value) {
  assertOnlyKeys(value, ['mode', 'calendar', 'runtime', 'duePolicy'], 'schedule');
  const mode = value.mode;
  if (!EQUIPMENT_ROUTINE_SCHEDULE_TYPE_VALUES.includes(mode)) {
    throw inputInvalid('schedule.mode is invalid');
  }
  const result = { mode };
  if (value.calendar !== undefined) {
    assertOnlyKeys(value.calendar, ['unit', 'interval', 'firstDueAt'], 'schedule.calendar');
    if (!EQUIPMENT_ROUTINE_CALENDAR_UNIT_VALUES.includes(value.calendar.unit)) {
      throw inputInvalid('schedule.calendar.unit is invalid');
    }
    if (
      value.calendar.firstDueAt === undefined ||
      value.calendar.firstDueAt === null ||
      value.calendar.firstDueAt === ''
    ) {
      throw inputInvalid('schedule.calendar.firstDueAt is required');
    }
    const firstDueAt = new Date(value.calendar.firstDueAt);
    if (Number.isNaN(firstDueAt.getTime())) {
      throw inputInvalid('schedule.calendar.firstDueAt must be a valid date');
    }
    result.calendar = {
      unit: value.calendar.unit,
      interval: integer(value.calendar.interval, 'schedule.calendar.interval', {
        min: 1,
        max: 10000,
        fallback: 0
      }),
      firstDueAt
    };
  }
  if (value.runtime !== undefined) {
    assertOnlyKeys(value.runtime, ['intervalHours'], 'schedule.runtime');
    result.runtime = {
      intervalHours: finiteNumber(value.runtime.intervalHours, 'schedule.runtime.intervalHours', {
        min: Number.EPSILON,
        required: true
      })
    };
  }
  if (value.duePolicy !== undefined) {
    if (!EQUIPMENT_ROUTINE_DUE_POLICY_VALUES.includes(value.duePolicy)) {
      throw inputInvalid('schedule.duePolicy is invalid');
    }
    result.duePolicy = value.duePolicy;
  }

  const hasCalendar = Boolean(result.calendar);
  const hasRuntime = Boolean(result.runtime);
  const hasPolicy = Boolean(result.duePolicy);
  if (mode === EQUIPMENT_ROUTINE_SCHEDULE_TYPES.MANUAL && (hasCalendar || hasRuntime || hasPolicy)) {
    throw inputInvalid('MANUAL schedule cannot contain calendar, runtime, or duePolicy');
  }
  if (mode === EQUIPMENT_ROUTINE_SCHEDULE_TYPES.CALENDAR && (!hasCalendar || hasRuntime || hasPolicy)) {
    throw inputInvalid('CALENDAR schedule requires only calendar');
  }
  if (mode === EQUIPMENT_ROUTINE_SCHEDULE_TYPES.RUNTIME_HOURS && (hasCalendar || !hasRuntime || hasPolicy)) {
    throw inputInvalid('RUNTIME_HOURS schedule requires only runtime');
  }
  if (mode === EQUIPMENT_ROUTINE_SCHEDULE_TYPES.COMBINED && (!hasCalendar || !hasRuntime || !hasPolicy)) {
    throw inputInvalid('COMBINED schedule requires calendar, runtime, and duePolicy');
  }
  return result;
}

function normalizeChecklistItems(items, existingItems = null) {
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_CHECKLIST_ITEMS) {
    throw inputInvalid(`checklistItems must contain between 1 and ${MAX_CHECKLIST_ITEMS} items`);
  }
  const existingKeys = existingItems
    ? new Set(existingItems.map((item) => item.key))
    : null;
  const normalized = items.map((item, index) => {
    assertOnlyKeys(item, ['key', 'name', 'description', 'required', 'sortOrder'], `checklistItems[${index}]`);
    let key;
    if (existingKeys && item.key !== undefined) {
      key = requiredString(item.key, `checklistItems[${index}].key`, 128);
      if (!existingKeys.has(key)) {
        throw inputInvalid('Existing checklist item keys may be retained, but client-generated keys are not accepted');
      }
    } else {
      key = crypto.randomUUID();
    }
    return {
      key,
      name: requiredString(item.name, `checklistItems[${index}].name`, 200),
      description: optionalString(item.description, `checklistItems[${index}].description`, 2000),
      required: booleanValue(item.required, `checklistItems[${index}].required`, true),
      sortOrder: integer(item.sortOrder, `checklistItems[${index}].sortOrder`, {
        min: 0,
        fallback: index
      })
    };
  });
  if (new Set(normalized.map((item) => item.key)).size !== normalized.length) {
    throw inputInvalid('checklist item keys must be unique');
  }
  return normalized.sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name));
}

function routinePermission(routineType) {
  if (routineType === EQUIPMENT_ROUTINE_TYPES.INSPECTION) return 'equipment.inspect';
  if (routineType === EQUIPMENT_ROUTINE_TYPES.MAINTENANCE) return 'equipment.maintain';
  throw inputInvalid('routineType is invalid');
}

function ruleAuditResource(routineType) {
  return routineType === EQUIPMENT_ROUTINE_TYPES.INSPECTION
    ? AUDIT_RESOURCE_TYPES.INSPECTION_TEMPLATE
    : AUDIT_RESOURCE_TYPES.MAINTENANCE_PLAN;
}

function recordAuditResource(routineType) {
  return routineType === EQUIPMENT_ROUTINE_TYPES.INSPECTION
    ? AUDIT_RESOURCE_TYPES.INSPECTION_RECORD
    : AUDIT_RESOURCE_TYPES.MAINTENANCE_RECORD;
}

function fileOwnerType(routineType) {
  return routineType === EQUIPMENT_ROUTINE_TYPES.INSPECTION
    ? FILE_OWNER_TYPES.INSPECTION
    : FILE_OWNER_TYPES.MAINTENANCE;
}

async function execute(query, session) {
  if (session && typeof query.session === 'function') query.session(session);
  return query;
}

async function loadRoutineCategoryPath({
  EquipmentCategoryModel = EquipmentCategory,
  teamId,
  categoryId,
  session = null
}) {
  const path = [];
  const visited = new Set();
  let cursorId = categoryId;
  while (cursorId) {
    const normalizedCursorId = normalizeId(cursorId);
    if (!normalizedCursorId || visited.has(normalizedCursorId)) return null;
    visited.add(normalizedCursorId);
    const category = await execute(EquipmentCategoryModel.findOne({
      _id: cursorId,
      teamId
    }).select('_id parentId status').lean(), session);
    if (!category) return null;
    path.unshift(category);
    cursorId = category.parentId;
  }
  return path;
}

async function resolveRoutineRuleAssetCategoryIds({
  EquipmentCategoryModel = EquipmentCategory,
  teamId,
  ruleCategoryId,
  session = null
}) {
  const path = await loadRoutineCategoryPath({
    EquipmentCategoryModel,
    teamId,
    categoryId: ruleCategoryId,
    session
  });
  if (
    !path ||
    path.length !== ROUTINE_PRIMARY_CATEGORY_DEPTH ||
    path.some(({ status }) => status !== EQUIPMENT_CATEGORY_STATUSES.ACTIVE)
  ) {
    return [];
  }

  const categories = await execute(EquipmentCategoryModel.find({
    teamId,
    status: EQUIPMENT_CATEGORY_STATUSES.ACTIVE
  })
    .select('_id parentId status')
    .lean(), session);
  const childrenByParent = new Map();
  for (const category of categories) {
    const parentId = normalizeId(category.parentId);
    if (!parentId) continue;
    const children = childrenByParent.get(parentId) || [];
    children.push(category._id);
    childrenByParent.set(parentId, children);
  }

  const categoryIds = [];
  const queue = [path[path.length - 1]._id];
  const visited = new Set();
  while (queue.length > 0) {
    const categoryId = queue.shift();
    const normalizedCategoryId = normalizeId(categoryId);
    if (!normalizedCategoryId || visited.has(normalizedCategoryId)) continue;
    visited.add(normalizedCategoryId);
    categoryIds.push(categoryId);
    queue.push(...(childrenByParent.get(normalizedCategoryId) || []));
  }
  return categoryIds;
}

async function resolveRoutineRuleLookupCategoryIds({
  EquipmentCategoryModel = EquipmentCategory,
  teamId,
  assetCategoryId,
  session = null
}) {
  const path = await loadRoutineCategoryPath({
    EquipmentCategoryModel,
    teamId,
    categoryId: assetCategoryId,
    session
  });
  if (
    !path ||
    path.length < ROUTINE_PRIMARY_CATEGORY_DEPTH ||
    path.some(({ status }) => status !== EQUIPMENT_CATEGORY_STATUSES.ACTIVE)
  ) return [];
  return [path[ROUTINE_PRIMARY_CATEGORY_DEPTH - 1]._id];
}

async function createOne(Model, payload, session) {
  if (!session) return Model.create(payload);
  const created = await Model.create([payload], { session });
  return created[0];
}

function normalizePersistenceError(error) {
  if (error instanceof EquipmentRegistryError) return error;
  if (error?.code === 11000) {
    const idempotency = Object.prototype.hasOwnProperty.call(error.keyPattern || {}, 'idempotencyKey');
    return routineError(
      409,
      idempotency ? 'EQUIPMENT_ROUTINE_IDEMPOTENCY_CONFLICT' : 'EQUIPMENT_ROUTINE_RULE_DUPLICATE',
      idempotency
        ? 'idempotencyKey has already been used'
        : 'A routine rule with the same name already exists for this equipment category'
    );
  }
  if (['ValidationError', 'StrictModeError', 'CastError'].includes(error?.name)) {
    return inputInvalid(error.message);
  }
  if (
    error?.code === 112 ||
    error?.codeName === 'WriteConflict' ||
    error?.hasErrorLabel?.('TransientTransactionError') ||
    error?.errorLabels?.includes?.('TransientTransactionError')
  ) {
    return routineError(
      409,
      EQUIPMENT_CATEGORY_STRUCTURE_CONFLICT.code,
      EQUIPMENT_CATEGORY_STRUCTURE_CONFLICT.message
    );
  }
  return error;
}

function createEquipmentRoutineService({
  EquipmentAssetModel = EquipmentAsset,
  EquipmentCategoryModel = EquipmentCategory,
  EquipmentRoutineRuleModel = EquipmentRoutineRule,
  EquipmentRoutineRecordModel = EquipmentRoutineRecord,
  EquipmentRoutinePlanModel = EquipmentRoutinePlan,
  EquipmentRoutineExceptionModel = EquipmentRoutineException,
  EquipmentRuntimeReadingModel = EquipmentRuntimeReading,
  ProjectTeamModel = ProjectTeam,
  OrgUnitModel = OrgUnit,
  UserModel = User,
  auditService = createAuditService(),
  fileAssetService = createFileAssetService(),
  workflowService = null,
  connection = mongoose.connection,
  clock = () => new Date()
} = {}) {
  const routineWorkflowService = workflowService || createEquipmentRoutineWorkflowService({
    EquipmentAssetModel,
    EquipmentRoutineRecordModel,
    EquipmentRoutinePlanModel,
    auditService,
    connection,
    clock
  });
  function runRoutineTransaction(work) {
    if (!supportsTransactions(connection)) {
      throw routineError(
        503,
        'EQUIPMENT_ROUTINE_TRANSACTIONS_REQUIRED',
        'Equipment routine writes require MongoDB replica-set transaction support'
      );
    }
    return runWithOptionalTransaction(work, connection);
  }

  async function lockEquipmentCategoryStructure(context, session) {
    const team = await ProjectTeamModel.findOneAndUpdate({
      _id: context.activeTeamId,
      status: TEAM_STATUSES.ACTIVE
    }, {
      $inc: { equipmentCategoryStructureRevision: 1 }
    }, {
      new: true,
      projection: { _id: 1, equipmentCategoryStructureRevision: 1 },
      session
    });
    if (!team) {
      throw routineError(
        409,
        'EQUIPMENT_TEAM_CONTEXT_STALE',
        'The active equipment team is no longer available'
      );
    }
    return team;
  }

  async function cancelOpenPlansForRule({ rule, cancellationReason, cancelledBy }, session) {
    return execute(EquipmentRoutinePlanModel.updateMany({
      teamId: rule.teamId,
      ruleId: rule._id,
      status: { $in: OPEN_ROUTINE_PLAN_STATUSES }
    }, {
      $set: {
        status: EQUIPMENT_ROUTINE_PLAN_STATUSES.CANCELLED,
        cancellationReason,
        cancelledAt: clock(),
        cancelledBy: cancelledBy || null
      }
    }), session);
  }

  async function materializeSubmissionPlan({
    rule,
    asset,
    schedule,
    performedAt,
    runtimeHours,
    rematerializedBy,
    session
  }) {
    const targets = submissionMaterializationTargets(
      rule,
      schedule,
      performedAt,
      runtimeHours
    );
    const executableTargets = targets
      .filter(({ status }) => status !== EQUIPMENT_ROUTINE_PLAN_STATUSES.PLANNED)
      .sort((left, right) => {
        const statusRank = {
          [EQUIPMENT_ROUTINE_PLAN_STATUSES.OVERDUE]: 0,
          [EQUIPMENT_ROUTINE_PLAN_STATUSES.IN_WINDOW]: 1
        };
        return (statusRank[left.status] ?? 2) - (statusRank[right.status] ?? 2) ||
          new Date(left.dueAt) - new Date(right.dueAt) ||
          left.cycleKey.localeCompare(right.cycleKey) ||
          left.windowKey.localeCompare(right.windowKey);
      });
    const target = executableTargets[0];
    if (!target && targets.some(({ status }) => (
      status === EQUIPMENT_ROUTINE_PLAN_STATUSES.PLANNED
    ))) {
      throw routineError(
        409,
        'EQUIPMENT_ROUTINE_PLAN_NOT_STARTED',
        'The routine plan cannot be executed before its start time'
      );
    }
    if (!target) return null;
    const filter = {
      teamId: rule.teamId,
      ruleId: rule._id,
      equipmentId: asset._id,
      cycleKey: target.cycleKey,
      windowKey: target.windowKey
    };
    const plan = await materializeOpenRoutinePlan({
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
        cycleKey: target.cycleKey,
        windowKey: target.windowKey,
        windowName: target.windowName,
        scheduledFor: target.scheduledFor,
        dueAt: target.dueAt,
        status: target.status
      },
      desiredStatus: target.status,
      rematerializedAt: performedAt,
      rematerializedBy,
      source: EQUIPMENT_ROUTINE_PLAN_REMATERIALIZATION_SOURCES.SUBMISSION,
      session
    });
    return plan && OPEN_ROUTINE_PLAN_STATUSES.includes(plan.status) ? plan : null;
  }

  async function recoverCancelledSubmissionPlan({
    rule,
    asset,
    schedule,
    performedAt,
    runtimeHours,
    rematerializedBy,
    session
  }) {
    const targets = submissionMaterializationTargets(
      rule,
      schedule,
      performedAt,
      runtimeHours
    );
    const identities = targets.map(({ cycleKey, windowKey }) => ({ cycleKey, windowKey }));
    if (identities.length === 0) return { matched: false, plan: null };

    const targetPlans = await execute(EquipmentRoutinePlanModel.find({
      teamId: rule.teamId,
      orgUnitId: asset.orgUnitId,
      equipmentId: asset._id,
      ruleId: rule._id,
      ruleVersion: rule.version,
      $or: identities
    }).sort({ dueAt: 1, _id: 1 }).lean(), session);
    if (targetPlans.length === 0) return { matched: false, plan: null };

    const completedPlans = await execute(EquipmentRoutinePlanModel.find({
      teamId: rule.teamId,
      equipmentId: asset._id,
      ruleId: rule._id,
      ruleVersion: rule.version,
      status: EQUIPMENT_ROUTINE_PLAN_STATUSES.COMPLETED
    }).select('cycleKey windowKey').lean(), session);
    const completedRequirementKeys = new Set(completedPlans.map(({ cycleKey, windowKey }) => (
      `${cycleKey}\u0000${windowKey}`
    )));
    const completedGenerationPrefixes = new Set(
      completedPlans.map(({ cycleKey, windowKey }) => {
        const prefix = combinedAnyGenerationPrefix(cycleKey);
        return prefix ? `${prefix}\u0000${windowKey}` : null;
      }).filter(Boolean)
    );
    const sameCompletedRequirement = (candidate) => {
      const generationPrefix = combinedAnyGenerationPrefix(candidate.cycleKey);
      return generationPrefix
        ? completedGenerationPrefixes.has(`${generationPrefix}\u0000${candidate.windowKey}`)
        : completedRequirementKeys.has(`${candidate.cycleKey}\u0000${candidate.windowKey}`);
    };
    const startedTargetPlans = targetPlans.filter((candidate) => (
      new Date(candidate.scheduledFor) <= performedAt
    ));
    const recoverable = startedTargetPlans
      .filter((candidate) => (
        candidate.status === EQUIPMENT_ROUTINE_PLAN_STATUSES.CANCELLED &&
        [
          EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS.EQUIPMENT_CATEGORY_CHANGED,
          EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS.EQUIPMENT_STATUS_CHANGED,
          EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS.SIBLING_COMPLETED
        ].includes(candidate.cancellationReason) &&
        !sameCompletedRequirement(candidate)
      ))
      .sort((left, right) => {
        const leftOverdue = new Date(left.dueAt) < performedAt ? 0 : 1;
        const rightOverdue = new Date(right.dueAt) < performedAt ? 0 : 1;
        return leftOverdue - rightOverdue ||
          new Date(left.dueAt) - new Date(right.dueAt) ||
          String(left._id).localeCompare(String(right._id));
      });
    const selected = recoverable[0];
    if (!selected) {
      return {
        matched: true,
        notStarted: startedTargetPlans.length === 0 && targetPlans.some((candidate) => (
          new Date(candidate.scheduledFor) > performedAt
        )),
        plan: null
      };
    }

    const desiredStatus = new Date(selected.dueAt) < performedAt
      ? EQUIPMENT_ROUTINE_PLAN_STATUSES.OVERDUE
      : EQUIPMENT_ROUTINE_PLAN_STATUSES.IN_WINDOW;
    const plan = await materializeOpenRoutinePlan({
      EquipmentRoutinePlanModel,
      filter: {
        _id: selected._id,
        teamId: rule.teamId,
        ruleId: rule._id,
        equipmentId: asset._id,
        cycleKey: selected.cycleKey,
        windowKey: selected.windowKey
      },
      insert: null,
      desiredStatus,
      rematerializedAt: performedAt,
      rematerializedBy,
      source: EQUIPMENT_ROUTINE_PLAN_REMATERIALIZATION_SOURCES.SUBMISSION,
      allowInsert: false,
      recoverableCancellationReasons: [
        EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS.EQUIPMENT_CATEGORY_CHANGED,
        EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS.EQUIPMENT_STATUS_CHANGED,
        EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS.SIBLING_COMPLETED
      ],
      session
    });
    return {
      matched: true,
      notStarted: false,
      plan: plan && OPEN_ROUTINE_PLAN_STATUSES.includes(plan.status) ? plan : null
    };
  }

  async function resolveReadTeamId(authContext, requestedTeamId) {
    const context = assertBusinessContext(authContext);
    if (context.mode === SESSION_MODES.TEAM) {
      return normalizeObjectId(context.activeTeamId, 'activeTeamId');
    }
    if (context.mode !== SESSION_MODES.GLOBAL_READ_ONLY) {
      throw routineError(403, 'EQUIPMENT_TEAM_CONTEXT_REQUIRED', 'Select a team first');
    }
    let teamId;
    try {
      teamId = normalizeObjectId(requestedTeamId, 'teamId');
    } catch {
      throw routineError(
        400,
        'EQUIPMENT_TEAM_REQUIRED',
        'A valid teamId is required in global read-only mode'
      );
    }
    const exists = await ProjectTeamModel.exists({ _id: teamId, status: TEAM_STATUSES.ACTIVE });
    if (!exists) throw notFound();
    return teamId;
  }

  function assertRuleManager(authContext, routineType) {
    const context = assertTeamContext(authContext);
    assertPermission(context, 'equipment.edit');
    assertPermission(context, routinePermission(routineType));
    const membership = context.membership || {};
    const hasFixedIdentity = Boolean(
      membership.positionKey || Array.isArray(membership.functionalRoleKeys)
    );
    const fixedIdentityAllowed = (
      context.isSuperAdmin === true ||
      membership.positionKey === 'DEPARTMENT_MANAGER' ||
      membership.functionalRoleKeys?.includes('ASSET_ADMIN')
    );
    if (hasFixedIdentity && !fixedIdentityAllowed) {
      throw routineError(
        403,
        'EQUIPMENT_ROUTINE_MANAGER_REQUIRED',
        'Only a department manager or equipment administrator can manage routine rules'
      );
    }
    const scope = resolveModuleDataScope(context, DATA_SCOPE_MODULES.EQUIPMENT);
    if (scope.scope !== DATA_SCOPES.TEAM) {
      throw routineError(
        403,
        'EQUIPMENT_ROUTINE_TEAM_SCOPE_REQUIRED',
        'Managing routine rules requires TEAM equipment data scope'
      );
    }
    return context;
  }

  async function ruleVisibilityConstraint(authContext, teamId) {
    const dataScope = resolveModuleDataScope(authContext, DATA_SCOPE_MODULES.EQUIPMENT);
    if (authContext.mode !== SESSION_MODES.TEAM || dataScope.scope !== DATA_SCOPES.ORG_UNIT) {
      return {};
    }
    const categoryIds = await EquipmentAssetModel.distinct('categoryId', {
      teamId,
      orgUnitId: buildScopedOrgUnitIdConstraint(dataScope)
    });
    const matchingCategoryIds = await Promise.all(categoryIds.map((assetCategoryId) => (
      resolveRoutineRuleLookupCategoryIds({
        EquipmentCategoryModel,
        teamId,
        assetCategoryId
      })
    )));
    return { categoryId: { $in: matchingCategoryIds.flat() } };
  }

  async function loadCategory(context, categoryId, session) {
    const category = await execute(EquipmentCategoryModel.findOne({
      _id: normalizeRelatedId(categoryId),
      teamId: context.activeTeamId,
      status: EquipmentCategoryModel.EQUIPMENT_CATEGORY_STATUSES.ACTIVE
    }), session);
    if (!category) throw notFound('Equipment category');
    return category;
  }

  async function assertPrimaryRoutineCategory(context, category, session) {
    const path = await loadRoutineCategoryPath({
      EquipmentCategoryModel,
      teamId: context.activeTeamId,
      categoryId: category._id,
      session
    });
    if (
      !path ||
      path.length !== ROUTINE_PRIMARY_CATEGORY_DEPTH ||
      path.some(({ status }) => status !== EQUIPMENT_CATEGORY_STATUSES.ACTIVE)
    ) {
      throw routineError(
        400,
        'EQUIPMENT_ROUTINE_PRIMARY_CATEGORY_REQUIRED',
        'Routine rules can only be assigned to a level-3 primary equipment name category'
      );
    }
    return category;
  }

  async function loadScopedAsset({
    authContext,
    requestedTeamId,
    method,
    equipmentId,
    session = null
  }) {
    assertPermission(authContext, 'equipment.view');
    const teamId = authContext.mode === SESSION_MODES.TEAM
      ? normalizeObjectId(authContext.activeTeamId, 'activeTeamId')
      : await resolveReadTeamId(authContext, requestedTeamId);
    const filter = buildScopedDetailFilter({
      authContext,
      moduleKey: DATA_SCOPE_MODULES.EQUIPMENT,
      id: normalizeDetailId(equipmentId),
      globalTeamId: teamId,
      method
    });
    const asset = await execute(EquipmentAssetModel.findOne(filter), session);
    if (!asset) throw notFound('Equipment');
    return asset;
  }

  function ruleUserFilter(query = {}) {
    const filters = [];
    if (query.routineType) {
      if (!EQUIPMENT_ROUTINE_TYPE_VALUES.includes(query.routineType)) {
        throw inputInvalid('routineType is invalid');
      }
      filters.push({ routineType: query.routineType });
    }
    if (query.status) {
      if (!EQUIPMENT_ROUTINE_RULE_STATUS_VALUES.includes(query.status)) {
        throw inputInvalid('status is invalid');
      }
      filters.push({ status: query.status });
    }
    if (query.categoryId) filters.push({ categoryId: normalizeRelatedId(query.categoryId) });
    if (query.scheduleMode) {
      if (!EQUIPMENT_ROUTINE_SCHEDULE_TYPE_VALUES.includes(query.scheduleMode)) {
        throw inputInvalid('scheduleMode is invalid');
      }
      filters.push({ 'schedule.mode': query.scheduleMode });
    }
    if (query.keyword) {
      const pattern = {
        $regex: escapeRegex(requiredString(query.keyword, 'keyword', 100)),
        $options: 'i'
      };
      filters.push({ $or: [{ name: pattern }, { description: pattern }] });
    }
    return filters.length > 0 ? { $and: filters } : {};
  }

  async function listRules({ authContext, requestedTeamId, query = {} }) {
    assertOnlyKeys(query, [
      'teamId',
      'page',
      'pageSize',
      'routineType',
      'status',
      'categoryId',
      'scheduleMode',
      'keyword'
    ], 'query');
    assertPermission(authContext, 'equipment.view');
    const teamId = await resolveReadTeamId(authContext, requestedTeamId);
    const { page, pageSize, skip } = pagination(query);
    const visibility = await ruleVisibilityConstraint(authContext, teamId);
    const filter = { $and: [{ teamId }, visibility, ruleUserFilter(query)] };
    const [documents, total] = await Promise.all([
      EquipmentRoutineRuleModel.find(filter)
        .sort({ routineType: 1, name: 1, _id: 1 })
        .skip(skip)
        .limit(pageSize)
        .lean(),
      EquipmentRoutineRuleModel.countDocuments(filter)
    ]);
    return { rules: documents.map(serializeRule), total, page, pageSize };
  }

  async function getRule({ authContext, requestedTeamId, ruleId, query = {} }) {
    assertOnlyKeys(query, ['teamId'], 'query');
    assertPermission(authContext, 'equipment.view');
    const teamId = await resolveReadTeamId(authContext, requestedTeamId);
    const visibility = await ruleVisibilityConstraint(authContext, teamId);
    const rule = await EquipmentRoutineRuleModel.findOne({
      $and: [{ _id: normalizeDetailId(ruleId), teamId }, visibility]
    }).lean();
    if (!rule) throw notFound('Equipment routine rule');
    return serializeRule(rule);
  }

  function normalizedRuleCreateInput(input) {
    assertOnlyKeys(input, [
      'routineType',
      'categoryId',
      'name',
      'description',
      'checklistItems',
      'schedule',
      'photoPolicy',
      'abnormalNoteRequired',
      'executionConfig',
      'reason'
    ]);
    if (!EQUIPMENT_ROUTINE_TYPE_VALUES.includes(input.routineType)) {
      throw inputInvalid('routineType is invalid');
    }
    const photoPolicy = input.photoPolicy ?? EQUIPMENT_ROUTINE_PHOTO_POLICIES.NONE;
    if (!EQUIPMENT_ROUTINE_PHOTO_POLICY_VALUES.includes(photoPolicy)) {
      throw inputInvalid('photoPolicy is invalid');
    }
    return {
      routineType: input.routineType,
      categoryId: normalizeRelatedId(input.categoryId),
      name: requiredString(input.name, 'name', 200),
      description: optionalString(input.description, 'description', 2000),
      checklistItems: normalizeChecklistItems(input.checklistItems),
      schedule: normalizeSchedule(input.schedule),
      photoPolicy,
      abnormalNoteRequired: booleanValue(input.abnormalNoteRequired, 'abnormalNoteRequired', true),
      executionConfig: normalizeExecutionConfig(input.executionConfig)
    };
  }

  async function createRule({ authContext, req, input = {} }) {
    assertNoClientTeamId(input);
    const payload = normalizedRuleCreateInput(input);
    const context = assertRuleManager(authContext, payload.routineType);
    try {
      return await runRoutineTransaction(async (session) => {
        await lockEquipmentCategoryStructure(context, session);
        const category = await loadCategory(context, payload.categoryId, session);
        await assertPrimaryRoutineCategory(context, category, session);
        const rule = await createOne(EquipmentRoutineRuleModel, {
          ...payload,
          categoryId: category._id,
          teamId: context.activeTeamId,
          status: EQUIPMENT_ROUTINE_RULE_STATUSES.ACTIVE,
          version: 1,
          createdBy: context.userId,
          updatedBy: context.userId
        }, session);
        const after = serializeRule(rule);
        await auditService.record({
          req,
          authContext: context,
          action: AUDIT_ACTIONS.CREATE,
          resourceType: ruleAuditResource(rule.routineType),
          resourceId: rule._id,
          after,
          reason: optionalString(input.reason, 'reason', 2000, null),
          targetTeamId: context.activeTeamId,
          session
        });
        return after;
      });
    } catch (error) {
      throw normalizePersistenceError(error);
    }
  }

  async function updateRule({ authContext, req, ruleId, input = {} }) {
    assertNoClientTeamId(input);
    assertOnlyKeys(input, [
      'routineType',
      'categoryId',
      'name',
      'description',
      'checklistItems',
      'schedule',
      'status',
      'photoPolicy',
      'abnormalNoteRequired',
      'executionConfig',
      'reason'
    ]);
    const context = assertTeamContext(authContext);
    try {
      return await runRoutineTransaction(async (session) => {
        await lockEquipmentCategoryStructure(context, session);
        const rule = await execute(EquipmentRoutineRuleModel.findOne({
          _id: normalizeDetailId(ruleId),
          teamId: context.activeTeamId
        }), session);
        if (!rule) throw notFound('Equipment routine rule');
        assertRuleManager(context, rule.routineType);
        if (
          Object.prototype.hasOwnProperty.call(input, 'routineType') &&
          input.routineType !== rule.routineType
        ) {
          throw inputInvalid('routineType is immutable');
        }
        if (
          Object.prototype.hasOwnProperty.call(input, 'categoryId') &&
          !sameId(input.categoryId, rule.categoryId)
        ) {
          throw inputInvalid('categoryId is immutable');
        }
        if (
          Object.prototype.hasOwnProperty.call(input, 'status') &&
          !EQUIPMENT_ROUTINE_RULE_STATUS_VALUES.includes(input.status)
        ) {
          throw inputInvalid('status is invalid');
        }
        const nextStatus = Object.prototype.hasOwnProperty.call(input, 'status')
          ? input.status
          : rule.status;
        const category = await execute(EquipmentCategoryModel.findOne({
          _id: rule.categoryId,
          teamId: context.activeTeamId
        }), session);
        const categoryPath = category
          ? await loadRoutineCategoryPath({
              EquipmentCategoryModel,
              teamId: context.activeTeamId,
              categoryId: category._id,
              session
            })
          : null;
        if (
          nextStatus === EQUIPMENT_ROUTINE_RULE_STATUSES.ACTIVE &&
          (
            !categoryPath ||
            categoryPath.length !== ROUTINE_PRIMARY_CATEGORY_DEPTH ||
            categoryPath.some(({ status }) => status !== EQUIPMENT_CATEGORY_STATUSES.ACTIVE)
          )
        ) {
          throw routineError(
            409,
            'EQUIPMENT_ROUTINE_PRIMARY_CATEGORY_REQUIRED',
            'A legacy rule outside level 3 must be disabled before it can be retained'
          );
        }
        const before = serializeRule(rule);
        if (Object.prototype.hasOwnProperty.call(input, 'name')) {
          rule.name = requiredString(input.name, 'name', 200);
        }
        if (Object.prototype.hasOwnProperty.call(input, 'description')) {
          rule.description = optionalString(input.description, 'description', 2000);
        }
        if (Object.prototype.hasOwnProperty.call(input, 'checklistItems')) {
          rule.checklistItems = normalizeChecklistItems(input.checklistItems, rule.checklistItems);
        }
        if (Object.prototype.hasOwnProperty.call(input, 'schedule')) {
          rule.schedule = normalizeSchedule(input.schedule);
        }
        if (Object.prototype.hasOwnProperty.call(input, 'status')) {
          rule.status = input.status;
        }
        if (Object.prototype.hasOwnProperty.call(input, 'photoPolicy')) {
          if (!EQUIPMENT_ROUTINE_PHOTO_POLICY_VALUES.includes(input.photoPolicy)) {
            throw inputInvalid('photoPolicy is invalid');
          }
          rule.photoPolicy = input.photoPolicy;
        }
        if (Object.prototype.hasOwnProperty.call(input, 'abnormalNoteRequired')) {
          rule.abnormalNoteRequired = booleanValue(
            input.abnormalNoteRequired,
            'abnormalNoteRequired',
            rule.abnormalNoteRequired
          );
        }
        if (Object.prototype.hasOwnProperty.call(input, 'executionConfig')) {
          rule.executionConfig = normalizeExecutionConfig(input.executionConfig);
        }
        rule.version += 1;
        rule.updatedBy = context.userId;
        await rule.save({ session: session || undefined });
        const after = serializeRule(rule);
        const scheduleChanged = !isDeepStrictEqual(
          planMaterializationConfiguration(before),
          planMaterializationConfiguration(after)
        );
        let cancellationReason = EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS.RULE_UPDATED;
        if (rule.status === EQUIPMENT_ROUTINE_RULE_STATUSES.DISABLED) {
          cancellationReason = EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS.RULE_DEACTIVATED;
        } else if (scheduleChanged) {
          cancellationReason = EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS.SCHEDULE_CHANGED;
        }
        await cancelOpenPlansForRule({
          rule,
          cancellationReason,
          cancelledBy: context.userId
        }, session);
        await auditService.record({
          req,
          authContext: context,
          action: AUDIT_ACTIONS.UPDATE,
          resourceType: ruleAuditResource(rule.routineType),
          resourceId: rule._id,
          before,
          after,
          reason: optionalString(input.reason, 'reason', 2000, null),
          targetTeamId: context.activeTeamId,
          session
        });
        return after;
      });
    } catch (error) {
      throw normalizePersistenceError(error);
    }
  }

  async function disableRule({ authContext, req, ruleId, input = {} }) {
    assertNoClientTeamId(input);
    assertOnlyKeys(input, ['reason']);
    const context = assertTeamContext(authContext);
    try {
      return await runRoutineTransaction(async (session) => {
        const rule = await execute(EquipmentRoutineRuleModel.findOne({
          _id: normalizeDetailId(ruleId),
          teamId: context.activeTeamId
        }), session);
        if (!rule) throw notFound('Equipment routine rule');
        assertRuleManager(context, rule.routineType);
        if (rule.status === EQUIPMENT_ROUTINE_RULE_STATUSES.DISABLED) {
          await cancelOpenPlansForRule({
            rule,
            cancellationReason: EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS.RULE_DEACTIVATED,
            cancelledBy: context.userId
          }, session);
          return serializeRule(rule);
        }
        const before = serializeRule(rule);
        rule.status = EQUIPMENT_ROUTINE_RULE_STATUSES.DISABLED;
        rule.version += 1;
        rule.updatedBy = context.userId;
        await rule.save({ session: session || undefined });
        await cancelOpenPlansForRule({
          rule,
          cancellationReason: EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS.RULE_DEACTIVATED,
          cancelledBy: context.userId
        }, session);
        const after = serializeRule(rule);
        await auditService.record({
          req,
          authContext: context,
          action: AUDIT_ACTIONS.DISABLE,
          resourceType: ruleAuditResource(rule.routineType),
          resourceId: rule._id,
          before,
          after,
          reason: optionalString(input.reason, 'reason', 2000, null),
          targetTeamId: context.activeTeamId,
          session
        });
        return after;
      });
    } catch (error) {
      throw normalizePersistenceError(error);
    }
  }

  async function deleteRule({ authContext, req, ruleId, input = {} }) {
    assertNoClientTeamId(input);
    assertOnlyKeys(input, ['reason']);
    const context = assertTeamContext(authContext);
    try {
      return await runRoutineTransaction(async (session) => {
        const filter = {
          _id: normalizeDetailId(ruleId),
          teamId: context.activeTeamId
        };
        const rule = await execute(EquipmentRoutineRuleModel.findOne(filter), session);
        if (!rule) throw notFound('Equipment routine rule');
        assertRuleManager(context, rule.routineType);
        if (rule.status !== EQUIPMENT_ROUTINE_RULE_STATUSES.DISABLED) {
          throw routineError(
            409,
            'EQUIPMENT_ROUTINE_RULE_DELETE_REQUIRES_DISABLED',
            'Equipment routine rule must be disabled before deletion'
          );
        }

        const dependencyFilter = {
          teamId: context.activeTeamId,
          ruleId: rule._id
        };
        const record = await execute(EquipmentRoutineRecordModel.exists(dependencyFilter), session);
        const completedPlan = await execute(EquipmentRoutinePlanModel.exists({
          ...dependencyFilter,
          status: EQUIPMENT_ROUTINE_PLAN_STATUSES.COMPLETED
        }), session);
        if (record || completedPlan) {
          throw routineError(
            409,
            'EQUIPMENT_ROUTINE_RULE_DELETE_HAS_HISTORY',
            'Equipment routine rule with execution history cannot be deleted'
          );
        }

        const before = serializeRule(rule);
        await execute(EquipmentRoutinePlanModel.deleteMany(dependencyFilter), session);
        const deleted = await execute(EquipmentRoutineRuleModel.deleteOne(filter), session);
        if (deleted.deletedCount !== 1) throw notFound('Equipment routine rule');
        await auditService.record({
          req,
          authContext: context,
          action: AUDIT_ACTIONS.DELETE,
          resourceType: ruleAuditResource(rule.routineType),
          resourceId: rule._id,
          before,
          after: { deleted: true },
          reason: optionalString(input.reason, 'reason', 2000, 'Deleted from routine rules'),
          targetTeamId: context.activeTeamId,
          session
        });
        return before;
      });
    } catch (error) {
      throw normalizePersistenceError(error);
    }
  }

  async function latestRoutineRecord(rule, equipmentId, session) {
    return execute(EquipmentRoutineRecordModel.findOne({
      teamId: rule.teamId,
      equipmentId,
      ruleId: rule._id
    }).sort({ performedAt: -1, _id: -1 }), session);
  }

  async function initialRuntimeReading(rule, equipmentId, session) {
    const effectiveAt = rule.createdAt || new Date(0);
    let reading = await execute(EquipmentRuntimeReadingModel.findOne({
      teamId: rule.teamId,
      equipmentId,
      recordedAt: { $lte: effectiveAt }
    }).sort({ recordedAt: -1, _id: -1 }), session);
    if (!reading) {
      reading = await execute(EquipmentRuntimeReadingModel.findOne({
        teamId: rule.teamId,
        equipmentId,
        recordedAt: { $gt: effectiveAt }
      }).sort({ recordedAt: 1, _id: 1 }), session);
    }
    return reading;
  }

  async function inspectionCalendarProgress(rule, latestRecord, session) {
    if (!latestRecord) {
      return {
        nextDueAt: new Date(rule.schedule.calendar.firstDueAt),
        materializationRecordKey: null
      };
    }
    let completedAnchor = null;
    let materializationRecordKey = null;
    if (latestRecord.planId) {
      const completedPlan = await execute(EquipmentRoutinePlanModel.findOne({
        _id: latestRecord.planId,
        teamId: rule.teamId,
        equipmentId: latestRecord.equipmentId,
        ruleId: rule._id,
        ruleVersion: rule.version
      }).select('cycleKey windowKey').lean(), session);
      completedAnchor = calendarAnchorFromCycleKey(completedPlan?.cycleKey);
      const generationPrefix = combinedAnyGenerationPrefix(completedPlan?.cycleKey);
      materializationRecordKey = generationPrefix
        ? generationPrefix.slice('combined:any:'.length, -1)
        : null;
      if (completedAnchor && completedPlan?.windowKey !== 'RUNTIME') {
        const requiredWindowKeys = serializeExecutionConfig(rule.executionConfig).windows
          .filter(({ enabled }) => enabled !== false)
          .map(({ key }) => key);
        const cyclePlans = await execute(EquipmentRoutinePlanModel.find({
          teamId: rule.teamId,
          equipmentId: latestRecord.equipmentId,
          ruleId: rule._id,
          ruleVersion: rule.version,
          cycleKey: completedPlan.cycleKey,
          windowKey: { $in: requiredWindowKeys },
          $or: [
            { status: EQUIPMENT_ROUTINE_PLAN_STATUSES.COMPLETED },
            {
              status: EQUIPMENT_ROUTINE_PLAN_STATUSES.CANCELLED,
              cancellationReason: EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS.REST_DAY
            }
          ]
        }).select('windowKey').lean(), session);
        const satisfiedWindowKeys = new Set(cyclePlans.map(({ windowKey }) => windowKey));
        if (requiredWindowKeys.some((windowKey) => !satisfiedWindowKeys.has(windowKey))) {
          return { nextDueAt: completedAnchor, materializationRecordKey };
        }
      }
    }
    return {
      nextDueAt: nextFixedCalendarAnchor(
        rule.schedule.calendar,
        latestRecord.performedAt,
        completedAnchor,
        serializeExecutionConfig(rule.executionConfig).timeZone
      ),
      materializationRecordKey: null
    };
  }

  async function calculateRuleSchedule(ruleDocument, asset, { session = null, now = clock() } = {}) {
    const rule = plain(ruleDocument);
    const schedule = plain(rule.schedule);
    const latestRecord = await latestRoutineRecord(rule, asset._id, session);
    const result = {
      rule: serializeRule(rule),
      status: 'ON_DEMAND',
      nextDueAt: null,
      nextDueRuntimeHours: null,
      calendarStatus: null,
      runtimeStatus: null,
      currentRuntimeHours: asset.currentRuntimeHours ?? null,
      materializationRecordKey: null,
      latestRecordId: normalizeId(latestRecord?._id),
      latestRecord: latestRecord
        ? {
            _id: normalizeId(latestRecord._id),
            planId: normalizeId(latestRecord.planId),
            performedAt: latestRecord.performedAt,
            overallResult: latestRecord.overallResult,
            performedRuntimeHours: latestRecord.performedRuntimeHours ?? null
          }
        : null
    };
    if (schedule.mode === EQUIPMENT_ROUTINE_SCHEDULE_TYPES.MANUAL) return result;

    let calendarState = null;
    if (schedule.calendar) {
      if (rule.routineType === EQUIPMENT_ROUTINE_TYPES.INSPECTION) {
        const progress = await inspectionCalendarProgress(rule, latestRecord, session);
        result.nextDueAt = progress.nextDueAt;
        result.materializationRecordKey = progress.materializationRecordKey;
      } else {
        result.nextDueAt = latestRecord
          ? addCalendarInterval(
              latestRecord.performedAt,
              schedule.calendar.unit,
              schedule.calendar.interval,
              serializeExecutionConfig(rule.executionConfig).timeZone
            )
          : new Date(schedule.calendar.firstDueAt);
      }
      calendarState = classifyCalendarDue({
        now,
        nextDueAt: result.nextDueAt,
        unit: schedule.calendar.unit,
        interval: schedule.calendar.interval,
        timeZone: serializeExecutionConfig(rule.executionConfig).timeZone
      });
    }

    let runtimeState = null;
    if (schedule.runtime) {
      let baselineHours = latestRecord?.performedRuntimeHours;
      if (baselineHours === null || baselineHours === undefined) {
        const baselineReading = await initialRuntimeReading(rule, asset._id, session);
        baselineHours = baselineReading?.hours;
      }
      if (baselineHours === null || baselineHours === undefined) {
        runtimeState = 'WAITING_FOR_READING';
      } else {
        result.nextDueRuntimeHours = baselineHours + schedule.runtime.intervalHours;
        runtimeState = classifyRuntimeDue({
          currentHours: asset.currentRuntimeHours ?? null,
          nextDueHours: result.nextDueRuntimeHours,
          intervalHours: schedule.runtime.intervalHours
        });
      }
    }

    result.calendarStatus = calendarState;
    result.runtimeStatus = runtimeState;

    if (schedule.mode === EQUIPMENT_ROUTINE_SCHEDULE_TYPES.CALENDAR) result.status = calendarState;
    else if (schedule.mode === EQUIPMENT_ROUTINE_SCHEDULE_TYPES.RUNTIME_HOURS) {
      result.status = runtimeState;
    } else {
      result.status = combineDueStates(calendarState, runtimeState, schedule.duePolicy);
    }
    return result;
  }

  async function getSchedule({
    authContext,
    requestedTeamId,
    method = 'GET',
    equipmentId,
    query = {}
  }) {
    assertOnlyKeys(query, ['teamId'], 'query');
    const asset = await loadScopedAsset({
      authContext,
      requestedTeamId,
      method,
      equipmentId
    });
    const matchingCategoryIds = await resolveRoutineRuleLookupCategoryIds({
      EquipmentCategoryModel,
      teamId: asset.teamId,
      assetCategoryId: asset.categoryId
    });
    const rules = await EquipmentRoutineRuleModel.find({
      teamId: asset.teamId,
      categoryId: { $in: matchingCategoryIds },
      status: EQUIPMENT_ROUTINE_RULE_STATUSES.ACTIVE
    }).sort({ routineType: 1, name: 1, _id: 1 });
    const schedules = await Promise.all(
      rules.map((rule) => calculateRuleSchedule(rule, asset))
    );
    const now = clock();
    const plans = await EquipmentRoutinePlanModel.find({
      teamId: asset.teamId,
      orgUnitId: asset.orgUnitId,
      equipmentId: asset._id,
      ruleId: { $in: rules.map(({ _id }) => _id) },
      $or: [
        { status: { $in: OPEN_ROUTINE_PLAN_STATUSES } },
        {
          status: EQUIPMENT_ROUTINE_PLAN_STATUSES.CANCELLED,
          cancellationReason: EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS.REST_DAY,
          scheduledFor: {
            $gte: new Date(now.getTime() - (48 * 60 * 60 * 1000)),
            $lte: new Date(now.getTime() + (48 * 60 * 60 * 1000))
          }
        }
      ]
    }).sort({ scheduledFor: 1, dueAt: 1, _id: 1 }).lean();
    const plansByRule = new Map();
    for (const plan of plans) {
      if (
        plan.status === EQUIPMENT_ROUTINE_PLAN_STATUSES.CANCELLED &&
        !isRoutinePlanCurrentBusinessDate(plan, now)
      ) {
        continue;
      }
      const key = normalizeId(plan.ruleId);
      if (!plansByRule.has(key)) plansByRule.set(key, []);
      const status = effectiveRoutinePlanStatus(plan, now);
      const cancellationReason = routinePlanCancellationReason(plan);
      plansByRule.get(key).push({
        _id: normalizeId(plan._id),
        windowKey: plan.windowKey,
        windowName: routinePlanWindowName(plan),
        originalWindowName: plan.windowName,
        scheduledFor: plan.scheduledFor,
        dueAt: plan.dueAt,
        status,
        cycleKey: plan.cycleKey,
        cancellationReason,
        cancellationReasonLabel: routinePlanCancellationReasonLabel(plan),
        cancelledAt: plan.cancelledAt || null,
        cancelledBy: normalizeId(plan.cancelledBy),
        restDayEligible: isRoutinePlanRestDayEligible(plan, now)
      });
    }
    for (const schedule of schedules) {
      schedule.plans = plansByRule.get(schedule.rule._id) || [];
      const restDayCancelled = schedule.plans.some(({ status, cancellationReason }) => (
        status === EQUIPMENT_ROUTINE_PLAN_STATUSES.CANCELLED &&
        cancellationReason === EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS.REST_DAY
      ));
      schedule.planStatus = schedule.plans.some(({ status }) => status === 'OVERDUE')
        ? 'OVERDUE'
        : schedule.plans.some(({ status }) => status === 'IN_WINDOW')
          ? 'IN_WINDOW'
          : schedule.plans.some(({ status }) => status === 'PLANNED')
            ? 'PLANNED'
            : restDayCancelled ? 'CANCELLED' : schedule.status;
      const manual = schedule.rule.schedule.mode === EQUIPMENT_ROUTINE_SCHEDULE_TYPES.MANUAL;
      const hasExecutablePlan = schedule.plans.some(({ status }) => (
        status === EQUIPMENT_ROUTINE_PLAN_STATUSES.IN_WINDOW ||
        status === EQUIPMENT_ROUTINE_PLAN_STATUSES.OVERDUE
      ));
      const calculatedDue = schedule.plans.length === 0 && (
        schedule.status === 'DUE' || schedule.status === 'OVERDUE'
      );
      schedule.executable = manual || hasExecutablePlan || calculatedDue;
      schedule.executionStatus = restDayCancelled
        ? 'REST_DAY'
        : schedule.executable
        ? 'READY'
        : schedule.plans.some(({ status }) => status === EQUIPMENT_ROUTINE_PLAN_STATUSES.PLANNED)
            ? 'NOT_STARTED'
          : schedule.latestRecord && schedule.status === 'UPCOMING'
            ? 'PERIOD_COMPLETED'
          : schedule.status === 'WAITING_FOR_READING'
            ? 'WAITING_FOR_READING'
            : 'NOT_DUE';
    }
    return {
      equipment: {
        _id: normalizeId(asset._id),
        teamId: normalizeId(asset.teamId),
        orgUnitId: normalizeId(asset.orgUnitId),
        categoryId: normalizeId(asset.categoryId),
        assetCode: asset.assetCode,
        plateNumber: asset.plateNumber || '',
        name: asset.name,
        location: asset.location || '',
        currentRuntimeHours: asset.currentRuntimeHours ?? null,
        runtimeHoursUpdatedAt: asset.runtimeHoursUpdatedAt || null
      },
      schedules
    };
  }

  function recordUserFilter(query = {}) {
    const filters = [];
    const dateBasis = String(query.dateBasis || 'EXECUTION').trim().toUpperCase();
    if (!['EXECUTION', 'PLAN'].includes(dateBasis)) {
      throw inputInvalid('dateBasis must be EXECUTION or PLAN');
    }
    if (query.routineType) {
      if (!EQUIPMENT_ROUTINE_TYPE_VALUES.includes(query.routineType)) {
        throw inputInvalid('routineType is invalid');
      }
      filters.push({ routineType: query.routineType });
    }
    if (query.equipmentId) filters.push({ equipmentId: normalizeRelatedId(query.equipmentId) });
    if (query.orgUnitId) filters.push({ orgUnitId: normalizeRelatedId(query.orgUnitId) });
    if (query.categoryId) filters.push({ categoryId: normalizeRelatedId(query.categoryId) });
    if (query.ruleId) filters.push({ ruleId: normalizeRelatedId(query.ruleId) });
    if (query.overallResult) {
      if (!EQUIPMENT_ROUTINE_OVERALL_RESULT_VALUES.includes(query.overallResult)) {
        throw inputInvalid('overallResult is invalid');
      }
      filters.push({ overallResult: query.overallResult });
    }
    if (query.from || query.to) {
      const range = {};
      if (query.from) {
        const from = new Date(query.from);
        if (Number.isNaN(from.getTime())) throw inputInvalid('from must be a valid date');
        range.$gte = from;
      }
      if (query.to) {
        const to = new Date(query.to);
        if (Number.isNaN(to.getTime())) throw inputInvalid('to must be a valid date');
        range.$lte = to;
      }
      if (range.$gte && range.$lte && range.$gte > range.$lte) {
        throw inputInvalid('from must be less than or equal to to');
      }
      if (dateBasis === 'PLAN') {
        // Planned records carry the immutable plan start separately. Keep a
        // scheduledFor fallback for older records, then performedAt for
        // manual records that never had a plan or scheduled timestamp.
        filters.push({
          $or: [
            { planScheduledFor: range },
            {
              $and: [
                {
                  $or: [
                    { planScheduledFor: { $exists: false } },
                    { planScheduledFor: null }
                  ]
                },
                { scheduledFor: range }
              ]
            },
            {
              $and: [
                {
                  $or: [
                    { planScheduledFor: { $exists: false } },
                    { planScheduledFor: null }
                  ]
                },
                {
                  $or: [
                    { scheduledFor: { $exists: false } },
                    { scheduledFor: null }
                  ]
                },
                { performedAt: range }
              ]
            }
          ]
        });
      } else {
        filters.push({ performedAt: range });
      }
    }
    return filters.length > 0 ? { $and: filters } : {};
  }

  async function enrichRecords(documents, teamId, session = null) {
    const values = documents.map(plain);
    const equipmentIds = [...new Set(values.map(({ equipmentId }) => normalizeId(equipmentId)).filter(Boolean))];
    const orgUnitIds = [...new Set(values.map(({ orgUnitId }) => normalizeId(orgUnitId)).filter(Boolean))];
    const planIds = [...new Set(values.map(({ planId }) => normalizeId(planId)).filter(Boolean))];
    const performerIds = [...new Set(values.map(({ performedBy }) => normalizeId(performedBy)).filter(Boolean))];
    const recordIds = values.map(({ _id }) => _id);
    const [assets, orgUnits, plans, performers, exceptions] = await Promise.all([
      execute(EquipmentAssetModel.find({ _id: { $in: equipmentIds }, teamId })
        .select('_id assetCode name location plateNumber')
        .lean(), session),
      execute(OrgUnitModel.find({ _id: { $in: orgUnitIds }, teamId }).select('_id name').lean(), session),
      execute(EquipmentRoutinePlanModel.find({ _id: { $in: planIds }, teamId })
        .select([
          '_id',
          'cycleKey',
          'windowKey',
          'windowName',
          'scheduledFor',
          'dueAt',
          'status',
          'cancellationReason'
        ].join(' '))
        .lean(), session),
      execute(UserModel.find({ _id: { $in: performerIds } })
        .select('_id name username')
        .lean(), session),
      execute(EquipmentRoutineExceptionModel.find({ teamId, recordId: { $in: recordIds } })
        .select('recordId status currentStage revision')
        .lean(), session)
    ]);
    const assetById = new Map(assets.map((asset) => [normalizeId(asset._id), asset]));
    const orgById = new Map(orgUnits.map((unit) => [normalizeId(unit._id), unit]));
    const planById = new Map(plans.map((plan) => [normalizeId(plan._id), plan]));
    const performerById = new Map(performers.map((user) => [normalizeId(user._id), user]));
    const exceptionByRecord = new Map(exceptions.map((item) => [normalizeId(item.recordId), item]));
    return values.map((value) => {
      const performer = performerById.get(normalizeId(value.performedBy)) || null;
      return {
        ...serializeRecord({
          ...value,
          plan: planById.get(normalizeId(value.planId)) || null
        }),
        equipment: assetById.get(normalizeId(value.equipmentId)) || null,
        orgUnit: orgById.get(normalizeId(value.orgUnitId)) || null,
        performedByUser: performer ? {
          _id: normalizeId(performer._id),
          name: performer.name || '',
          username: performer.username || ''
        } : null,
        performedByName: performer?.name || '',
        exception: exceptionByRecord.get(normalizeId(value._id)) || null
      };
    });
  }

  async function listRecords({ authContext, requestedTeamId, method = 'GET', query = {} }) {
    assertOnlyKeys(query, [
      'teamId',
      'page',
      'pageSize',
      'routineType',
      'equipmentId',
      'orgUnitId',
      'categoryId',
      'ruleId',
      'overallResult',
      'from',
      'to',
      'dateBasis'
    ], 'query');
    assertPermission(authContext, 'equipment.view');
    const teamId = await resolveReadTeamId(authContext, requestedTeamId);
    const filter = buildScopedFilter({
      authContext,
      moduleKey: DATA_SCOPE_MODULES.EQUIPMENT,
      userFilter: recordUserFilter(query),
      globalTeamId: teamId,
      method
    });
    const { page, pageSize, skip } = pagination(query);
    const dateBasis = String(query.dateBasis || 'EXECUTION').trim().toUpperCase();
    if (!['EXECUTION', 'PLAN'].includes(dateBasis)) {
      throw inputInvalid('dateBasis must be EXECUTION or PLAN');
    }
    const planDateFilter = dateBasis === 'PLAN'
      ? EquipmentRoutineRecordModel.find(filter).cast()
      : null;
    const recordQuery = dateBasis === 'PLAN'
      ? EquipmentRoutineRecordModel.aggregate([
        { $match: planDateFilter },
        {
          $addFields: {
            __planSortAt: {
              $ifNull: [
                '$planScheduledFor',
                { $ifNull: ['$scheduledFor', '$performedAt'] }
              ]
            }
          }
        },
        { $sort: { __planSortAt: -1, performedAt: -1, _id: -1 } },
        { $skip: skip },
        { $limit: pageSize },
        { $project: { __planSortAt: 0 } }
      ])
      : EquipmentRoutineRecordModel.find(filter)
        .sort({ performedAt: -1, _id: -1 })
        .skip(skip)
        .limit(pageSize)
        .lean();
    const [documents, total] = await Promise.all([
      recordQuery,
      EquipmentRoutineRecordModel.countDocuments(filter)
    ]);
    const records = await enrichRecords(documents, teamId);
    return { records, total, page, pageSize };
  }

  async function getInspectionCalendar({
    authContext,
    requestedTeamId,
    method = 'GET',
    equipmentId,
    query = {}
  }) {
    assertOnlyKeys(query, ['teamId', 'month'], 'query');
    const range = routineCalendarMonthRange(query.month);
    const asset = await loadScopedAsset({
      authContext,
      requestedTeamId,
      method,
      equipmentId
    });
    const teamId = asset.teamId;
    const plans = await EquipmentRoutinePlanModel.find({
      teamId,
      equipmentId: asset._id,
      routineType: EQUIPMENT_ROUTINE_TYPES.INSPECTION,
      scheduledFor: { $gte: range.start, $lt: range.nextStart }
    }).sort({ scheduledFor: 1, windowKey: 1, _id: 1 }).lean();
    const planIds = plans.map((plan) => plan._id);
    const completedRecordIds = plans
      .map((plan) => plan.completedRecordId)
      .filter(Boolean);
    const recordFilter = {
      teamId,
      equipmentId: asset._id,
      routineType: EQUIPMENT_ROUTINE_TYPES.INSPECTION,
      $or: [
        ...(planIds.length ? [{ planId: { $in: planIds } }] : []),
        { planId: null, performedAt: { $gte: range.start, $lt: range.nextStart } },
        ...(completedRecordIds.length ? [{ _id: { $in: completedRecordIds } }] : [])
      ]
    };
    const records = await EquipmentRoutineRecordModel.find(recordFilter)
      .select('_id planId overallResult performedAt planScheduledFor scheduledFor')
      .lean();
    const recordsById = new Map(records.map((record) => [String(record._id), record]));
    const recordsByPlanId = new Map(
      records.filter((record) => record.planId).map((record) => [String(record.planId), record])
    );
    const days = [];
    const dayByDate = new Map();
    for (let index = 0; index < range.days; index += 1) {
      const date = routineCalendarDateKey(new Date(range.start.getTime() + index * 86400000));
      const day = {
        date,
        status: 'NO_PLAN',
        planCount: 0,
        pendingCount: 0,
        normalCount: 0,
        abnormalCount: 0,
        restDayCount: 0
      };
      days.push(day);
      dayByDate.set(date, day);
    }
    const refreshStatus = (day) => {
      if (day.abnormalCount > 0) day.status = 'ABNORMAL';
      else if (day.pendingCount > 0) day.status = 'PENDING';
      else if (day.normalCount > 0) day.status = 'NORMAL';
      else if (day.restDayCount > 0) day.status = 'REST_DAY';
      else day.status = 'NO_PLAN';
    };
    for (const plan of plans) {
      const day = dayByDate.get(routineCalendarDateKey(plan.scheduledFor));
      if (!day) continue;
      day.planCount += 1;
      const status = effectiveRoutinePlanStatus(plan, clock());
      if (OPEN_ROUTINE_PLAN_STATUSES.includes(status)) {
        day.pendingCount += 1;
      } else if (status === EQUIPMENT_ROUTINE_PLAN_STATUSES.COMPLETED) {
        const record = (plan.completedRecordId && recordsById.get(String(plan.completedRecordId)))
          || recordsByPlanId.get(String(plan._id));
        if (!record) day.pendingCount += 1;
        else if (record.overallResult === EQUIPMENT_ROUTINE_OVERALL_RESULTS.ABNORMAL) {
          day.abnormalCount += 1;
        } else {
          day.normalCount += 1;
        }
      } else if (
        status === EQUIPMENT_ROUTINE_PLAN_STATUSES.CANCELLED &&
        routinePlanCancellationReason(plan) === EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS.REST_DAY
      ) {
        day.restDayCount += 1;
      }
      refreshStatus(day);
    }
    // Manual records are not attached to a materialized plan. They still
    // belong on the calendar by their actual execution date.
    for (const record of records) {
      if (record.planId) continue;
      const day = dayByDate.get(routineCalendarDateKey(record.performedAt));
      if (!day) continue;
      if (record.overallResult === EQUIPMENT_ROUTINE_OVERALL_RESULTS.ABNORMAL) {
        day.abnormalCount += 1;
      } else {
        day.normalCount += 1;
      }
      refreshStatus(day);
    }
    return {
      equipment: {
        _id: normalizeId(asset._id),
        teamId: normalizeId(asset.teamId),
        assetCode: asset.assetCode,
        plateNumber: asset.plateNumber || '',
        name: asset.name,
        location: asset.location || ''
      },
      month: range.month,
      timeZone: ROUTINE_CALENDAR_TIME_ZONE,
      days
    };
  }

  async function getRecord({
    authContext,
    requestedTeamId,
    method = 'GET',
    recordId,
    query = {}
  }) {
    assertOnlyKeys(query, ['teamId'], 'query');
    assertPermission(authContext, 'equipment.view');
    const teamId = await resolveReadTeamId(authContext, requestedTeamId);
    const filter = buildScopedDetailFilter({
      authContext,
      moduleKey: DATA_SCOPE_MODULES.EQUIPMENT,
      id: normalizeDetailId(recordId),
      globalTeamId: teamId,
      method
    });
    const document = await EquipmentRoutineRecordModel.findOne(filter).lean();
    if (!document) throw notFound('Equipment routine record');
    const [record] = await enrichRecords([document], teamId);
    return record;
  }

  function normalizePhotoFileIds(value) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > MAX_PHOTOS) {
      throw inputInvalid(`photoFileIds must be an array containing at most ${MAX_PHOTOS} file ids`);
    }
    const ids = value.map((fileId) => {
      try {
        return normalizeObjectId(fileId, 'photoFileId');
      } catch {
        throw inputInvalid('photoFileIds must contain valid ObjectIds');
      }
    });
    if (new Set(ids).size !== ids.length) throw inputInvalid('photoFileIds must be unique');
    return ids;
  }

  function normalizePhotoEvidence(value, photoFileIds) {
    if (value === undefined || value === null) {
      return photoFileIds.map((fileId) => ({
        fileId,
        sourceType: 'CAMERA',
        capturedAt: null,
        locationStatus: EQUIPMENT_ROUTINE_LOCATION_STATUSES.PENDING_CONFIRMATION,
        longitude: null,
        latitude: null,
        accuracyMeters: null,
        address: ''
      }));
    }
    if (!Array.isArray(value) || value.length > MAX_PHOTOS) {
      throw inputInvalid(`photoEvidence must contain at most ${MAX_PHOTOS} items`);
    }
    const normalized = value.map((evidence, index) => {
      assertOnlyKeys(evidence, [
        'fileId',
        'sourceType',
        'capturedAt',
        'locationStatus',
        'longitude',
        'latitude',
        'accuracyMeters',
        'address'
      ], `photoEvidence[${index}]`);
      let fileId;
      try {
        fileId = normalizeObjectId(evidence.fileId, 'fileId');
      } catch {
        throw inputInvalid('photoEvidence.fileId must be a valid ObjectId');
      }
      if (evidence.sourceType !== 'CAMERA') {
        throw inputInvalid('Routine evidence can only come from the camera');
      }
      const locationStatus = evidence.locationStatus || EQUIPMENT_ROUTINE_LOCATION_STATUSES.PENDING_CONFIRMATION;
      if (!EQUIPMENT_ROUTINE_LOCATION_STATUS_VALUES.includes(locationStatus)) {
        throw inputInvalid('photoEvidence.locationStatus is invalid');
      }
      let capturedAt = null;
      if (evidence.capturedAt !== undefined && evidence.capturedAt !== null && evidence.capturedAt !== '') {
        capturedAt = new Date(evidence.capturedAt);
        if (Number.isNaN(capturedAt.getTime())) throw inputInvalid('photoEvidence.capturedAt must be a valid date');
      }
      const longitude = finiteNumber(evidence.longitude, 'photoEvidence.longitude', { min: -180 });
      const latitude = finiteNumber(evidence.latitude, 'photoEvidence.latitude', { min: -90 });
      if (longitude !== null && longitude > 180) throw inputInvalid('photoEvidence.longitude is invalid');
      if (latitude !== null && latitude > 90) throw inputInvalid('photoEvidence.latitude is invalid');
      const accuracyMeters = finiteNumber(evidence.accuracyMeters, 'photoEvidence.accuracyMeters', { min: 0 });
      if (accuracyMeters !== null && accuracyMeters > 100000) {
        throw inputInvalid('photoEvidence.accuracyMeters is invalid');
      }
      if (locationStatus === EQUIPMENT_ROUTINE_LOCATION_STATUSES.GRANTED && (longitude === null || latitude === null)) {
        throw inputInvalid('A granted location requires longitude and latitude');
      }
      if (locationStatus !== EQUIPMENT_ROUTINE_LOCATION_STATUSES.GRANTED && (longitude !== null || latitude !== null)) {
        throw inputInvalid('Coordinates require GRANTED location status');
      }
      return {
        fileId,
        sourceType: 'CAMERA',
        capturedAt,
        locationStatus,
        longitude,
        latitude,
        accuracyMeters,
        address: optionalString(evidence.address, 'photoEvidence.address', 500)
      };
    });
    const evidenceIds = normalized.map(({ fileId }) => String(fileId));
    if (new Set(evidenceIds).size !== evidenceIds.length) {
      throw inputInvalid('photoEvidence must not contain duplicate files');
    }
    if (
      evidenceIds.length !== photoFileIds.length ||
      evidenceIds.some((fileId, index) => fileId !== String(photoFileIds[index]))
    ) {
      throw inputInvalid('photoEvidence must correspond to photoFileIds in the same order');
    }
    return normalized;
  }

  function watermarkTime(date, timeZone) {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    }).format(date).replace(/\//g, '-');
  }

  function finalizePhotoEvidence(values, rule, performedAt, equipmentLocation = '') {
    const config = serializeExecutionConfig(rule.executionConfig);
    const locationName = String(equipmentLocation || '').trim() || '设备地点未维护';
    return values.map((evidence) => {
      const capturedAt = evidence.capturedAt || performedAt;
      if (capturedAt > new Date(performedAt.getTime() + 5 * 60 * 1000)) {
        throw inputInvalid('Photo capture time cannot be in the future');
      }
      const precisionExceeded = (
        config.locationPrecisionMeters !== null &&
        evidence.accuracyMeters !== null &&
        evidence.accuracyMeters > config.locationPrecisionMeters
      );
      if (
        config.locationPolicy === EQUIPMENT_ROUTINE_LOCATION_POLICIES.REQUIRED &&
        (evidence.locationStatus !== EQUIPMENT_ROUTINE_LOCATION_STATUSES.GRANTED || precisionExceeded)
      ) {
        throw inputInvalid('This rule requires an available location within the configured precision');
      }
      const coordinateText = evidence.locationStatus === EQUIPMENT_ROUTINE_LOCATION_STATUSES.GRANTED
        ? `${evidence.latitude.toFixed(6)}, ${evidence.longitude.toFixed(6)}`
        : `定位状态：${evidence.locationStatus}`;
      return {
        ...evidence,
        capturedAt,
        address: locationName,
        watermarkText: `${watermarkTime(capturedAt, config.timeZone)} | 设备地点：${locationName} | GPS：${coordinateText}`
      };
    });
  }

  function normalizeSubmittedItemResults(values) {
    if (!Array.isArray(values) || values.length < 1 || values.length > MAX_CHECKLIST_ITEMS) {
      throw inputInvalid(`itemResults must contain between 1 and ${MAX_CHECKLIST_ITEMS} items`);
    }
    return values.map((value, index) => {
      assertOnlyKeys(value, ['itemKey', 'result', 'note'], `itemResults[${index}]`);
      return {
        itemKey: requiredString(value.itemKey, `itemResults[${index}].itemKey`, 128),
        result: requiredString(value.result, `itemResults[${index}].result`, 50),
        note: optionalString(value.note, `itemResults[${index}].note`, 2000)
      };
    });
  }

  function normalizeRecordSubmission(input) {
    const photoFileIds = normalizePhotoFileIds(input.photoFileIds);
    return {
      itemResults: normalizeSubmittedItemResults(input.itemResults),
      abnormalSummary: optionalString(input.abnormalSummary, 'abnormalSummary', 2000),
      photoFileIds,
      photoEvidence: normalizePhotoEvidence(input.photoEvidence, photoFileIds),
      photoEvidenceSupplied: input.photoEvidence !== undefined && input.photoEvidence !== null,
      runtimeHours: finiteNumber(input.runtimeHours, 'runtimeHours', { min: 0 }),
      planId: input.planId ? normalizeRelatedId(input.planId) : null
    };
  }

  function sameRoutineSubmission(recordDocument, submission) {
    const record = serializeRecord(recordDocument);
    const normalizedExistingItems = record.itemResults.map(({ itemKey, result, note }) => ({
      itemKey,
      result,
      note: note || ''
    }));
    return (
      JSON.stringify(normalizedExistingItems) === JSON.stringify(submission.itemResults) &&
      (record.performedRuntimeHours ?? null) === submission.runtimeHours &&
      (record.abnormalSummary || '') === submission.abnormalSummary &&
      JSON.stringify(record.photoFileIds) === JSON.stringify(submission.photoFileIds) &&
      (!submission.planId || (record.planId || null) === String(submission.planId)) &&
      (!submission.photoEvidenceSupplied || JSON.stringify(record.photoEvidence.map((evidence) => ({
        fileId: evidence.fileId,
        sourceType: evidence.sourceType,
        capturedAt: evidence.capturedAt ? new Date(evidence.capturedAt).toISOString() : null,
        locationStatus: evidence.locationStatus,
        longitude: evidence.longitude,
        latitude: evidence.latitude,
        accuracyMeters: evidence.accuracyMeters,
        address: evidence.address
      }))) === JSON.stringify(submission.photoEvidence.map((evidence) => ({
        ...evidence,
        fileId: String(evidence.fileId),
        capturedAt: evidence.capturedAt ? evidence.capturedAt.toISOString() : null
      }))))
    );
  }

  function normalizeItemResults(rule, values, abnormalSummary) {
    if (!Array.isArray(values) || values.length !== rule.checklistItems.length) {
      throw inputInvalid('itemResults must contain exactly one result for every checklist item');
    }
    const expected = new Map(rule.checklistItems.map((item) => [item.key, item]));
    const seen = new Set();
    let abnormal = false;
    const results = values.map((value, index) => {
      const itemKey = value.itemKey;
      const item = expected.get(itemKey);
      if (!item || seen.has(itemKey)) {
        throw inputInvalid('itemResults contain a forged, duplicate, or unknown itemKey');
      }
      seen.add(itemKey);
      const allowed = rule.routineType === EQUIPMENT_ROUTINE_TYPES.INSPECTION
        ? ['NORMAL', 'ABNORMAL', 'SKIPPED']
        : ['COMPLETED', 'ABNORMAL', 'SKIPPED'];
      if (!allowed.includes(value.result)) {
        throw inputInvalid(`Invalid result for ${rule.routineType.toLowerCase()} checklist item`);
      }
      if (item.required && value.result === 'SKIPPED') {
        throw inputInvalid('Required checklist items cannot be skipped');
      }
      const note = value.note;
      if (value.result === 'ABNORMAL') {
        abnormal = true;
        if (rule.abnormalNoteRequired && !note && !abnormalSummary) {
          throw inputInvalid('An abnormal checklist result requires a note or abnormalSummary');
        }
      }
      return { itemKey, result: value.result, note };
    });
    if (seen.size !== expected.size) {
      throw inputInvalid('itemResults must contain every configured checklist item');
    }
    return {
      results,
      abnormal,
      overallResult: abnormal
        ? 'ABNORMAL'
        : rule.routineType === EQUIPMENT_ROUTINE_TYPES.INSPECTION ? 'NORMAL' : 'COMPLETED'
    };
  }

  async function appendRuntimeReading({
    context,
    req,
    asset,
    hours,
    source,
    sourceRecordId = null,
    reason = null,
    recordedAt,
    session
  }) {
    const previousHours = asset.currentRuntimeHours ?? null;
    if (previousHours !== null && hours < previousHours) {
      throw routineError(
        409,
        'EQUIPMENT_RUNTIME_HOURS_DECREASED',
        'Runtime hours cannot be less than the current equipment reading'
      );
    }
    const reading = await createOne(EquipmentRuntimeReadingModel, {
      teamId: context.activeTeamId,
      orgUnitId: asset.orgUnitId,
      equipmentId: asset._id,
      hours,
      previousHours,
      recordedAt,
      operatorId: context.userId,
      source,
      sourceRecordId,
      reason
    }, session);
    asset.currentRuntimeHours = hours;
    asset.runtimeHoursUpdatedAt = recordedAt;
    asset.lastRuntimeReadingId = reading._id;
    asset.updatedBy = context.userId;
    await asset.save({ session: session || undefined });
    await auditService.record({
      req,
      authContext: context,
      action: AUDIT_ACTIONS.CREATE,
      resourceType: AUDIT_RESOURCE_TYPES.EQUIPMENT_RUNTIME_READING,
      resourceId: reading._id,
      after: serializeReading(reading),
      reason,
      targetTeamId: context.activeTeamId,
      session
    });
    return reading;
  }

  async function createRecord({ authContext, req, equipmentId, input = {} }) {
    assertNoClientTeamId(input);
    assertOnlyKeys(input, [
      'ruleId',
      'itemResults',
      'abnormalSummary',
      'photoFileIds',
      'photoEvidence',
      'runtimeHours',
      'planId',
      'idempotencyKey'
    ]);
    const context = assertTeamContext(authContext);
    const idempotencyKey = input.idempotencyKey === undefined || input.idempotencyKey === null
      ? null
      : requiredString(input.idempotencyKey, 'idempotencyKey', 128);
    const requestedRuleId = normalizeRelatedId(input.ruleId);
    const submission = normalizeRecordSubmission(input);
    try {
      return await runRoutineTransaction(async (session) => {
        let asset = await loadScopedAsset({
          authContext: context,
          method: 'POST',
          equipmentId,
          session
        });

        if (idempotencyKey) {
          const existing = await execute(EquipmentRoutineRecordModel.findOne({
            teamId: context.activeTeamId,
            idempotencyKey
          }), session);
          if (existing) {
            if (
              !sameId(existing.equipmentId, asset._id) ||
              !sameId(existing.ruleId, requestedRuleId) ||
              !sameId(existing.performedBy, context.userId) ||
              !sameRoutineSubmission(existing, submission)
            ) {
              throw routineError(
                409,
                'EQUIPMENT_ROUTINE_IDEMPOTENCY_CONFLICT',
                'idempotencyKey has already been used with a different routine submission'
              );
            }
            assertPermission(context, routinePermission(existing.routineType));
            const linkedPlan = existing.planId
              ? await execute(EquipmentRoutinePlanModel.findOne({
                  _id: existing.planId,
                  teamId: context.activeTeamId
                }), session)
              : null;
            return serializeRecord({ ...plain(existing), plan: linkedPlan });
          }
        }

        asset = await execute(EquipmentAssetModel.findOneAndUpdate({
          _id: asset._id,
          teamId: context.activeTeamId,
          status: {
            $in: [
              EQUIPMENT_STATUSES.IN_USE,
              EQUIPMENT_STATUSES.IDLE,
              EQUIPMENT_STATUSES.STOPPED
            ]
          }
        }, {
          $inc: { routineMaterializationRevision: 1 }
        }, {
          new: true,
          timestamps: false
        }), session);
        if (!asset) {
          throw routineError(
            409,
            'EQUIPMENT_ROUTINE_EQUIPMENT_NOT_IN_USE',
            'Inspection and maintenance can only be submitted for equipment that is in use'
          );
        }

        const matchingCategoryIds = await resolveRoutineRuleLookupCategoryIds({
          EquipmentCategoryModel,
          teamId: context.activeTeamId,
          assetCategoryId: asset.categoryId,
          session
        });
        const rule = await execute(EquipmentRoutineRuleModel.findOne({
          _id: requestedRuleId,
          teamId: context.activeTeamId,
          categoryId: { $in: matchingCategoryIds },
          status: EQUIPMENT_ROUTINE_RULE_STATUSES.ACTIVE
        }), session);
        if (!rule) throw notFound('Equipment routine rule');
        assertPermission(context, routinePermission(rule.routineType));
        if (!routineTypeAllowedForEquipmentStatus(rule.routineType, asset.status)) {
          throw routineError(
            409,
            'EQUIPMENT_ROUTINE_EQUIPMENT_NOT_IN_USE',
            rule.routineType === EQUIPMENT_ROUTINE_TYPES.INSPECTION
              ? 'Inspection can only be submitted for equipment that is in use'
              : 'Maintenance cannot be submitted for scrapped equipment'
          );
        }

        const runtimeRequired = [
          EQUIPMENT_ROUTINE_SCHEDULE_TYPES.RUNTIME_HOURS,
          EQUIPMENT_ROUTINE_SCHEDULE_TYPES.COMBINED
        ].includes(rule.schedule.mode);
        const runtimeHours = submission.runtimeHours;
        if (runtimeRequired && runtimeHours === null) {
          throw inputInvalid('runtimeHours is required');
        }
        if (
          runtimeHours !== null &&
          asset.currentRuntimeHours !== null &&
          asset.currentRuntimeHours !== undefined &&
          runtimeHours < asset.currentRuntimeHours
        ) {
          throw routineError(
            409,
            'EQUIPMENT_RUNTIME_HOURS_DECREASED',
            'Runtime hours cannot be less than the current equipment reading'
          );
        }

        const schedule = await calculateRuleSchedule(rule, asset, { session });
        const performedAt = clock();
        let completedCurrentPeriod = Boolean(schedule.latestRecord) &&
          schedule.status === 'UPCOMING';
        let plan = null;
        let futureOpenPlanExists = false;
        let recoveryMatched = false;
        let recoveryNotStarted = false;
        if (submission.planId) {
          const selectedPlan = await execute(EquipmentRoutinePlanModel.findOne({
            _id: submission.planId,
            teamId: context.activeTeamId,
            orgUnitId: asset.orgUnitId,
            equipmentId: asset._id,
            ruleId: rule._id,
            ruleVersion: rule.version
          }), session);
          if (!selectedPlan || !OPEN_ROUTINE_PLAN_STATUSES.includes(selectedPlan.status)) {
            throw routineError(
              409,
              'EQUIPMENT_ROUTINE_PLAN_NOT_OPEN',
              'The selected routine plan is no longer open'
            );
          }
          if (new Date(selectedPlan.scheduledFor) > performedAt) {
            throw routineError(
              409,
              'EQUIPMENT_ROUTINE_PLAN_NOT_STARTED',
              'The selected routine plan cannot be executed before its start time'
            );
          }
          plan = selectedPlan;
        } else {
          // Older clients may omit planId. Resolve an open requirement
          // deterministically, but never turn a future cycle into an ad-hoc run.
          const candidatePlans = await execute(EquipmentRoutinePlanModel.find({
            teamId: context.activeTeamId,
            orgUnitId: asset.orgUnitId,
            equipmentId: asset._id,
            ruleId: rule._id,
            ruleVersion: rule.version,
            $or: [
              { status: { $in: OPEN_ROUTINE_PLAN_STATUSES } },
              {
                status: EQUIPMENT_ROUTINE_PLAN_STATUSES.CANCELLED,
                cancellationReason: EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS.REST_DAY,
                scheduledFor: {
                  $gte: new Date(performedAt.getTime() - (48 * 60 * 60 * 1000)),
                  $lte: new Date(performedAt.getTime() + (48 * 60 * 60 * 1000))
                }
              }
            ]
          }).sort({ dueAt: 1, _id: 1 }), session);
          const restDayCancelled = candidatePlans.some((candidate) => (
            candidate.status === EQUIPMENT_ROUTINE_PLAN_STATUSES.CANCELLED &&
            candidate.cancellationReason === EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS.REST_DAY &&
            isRoutinePlanCurrentBusinessDate(candidate, performedAt)
          ));
          const executablePlans = candidatePlans
            .filter((candidate) => (
              OPEN_ROUTINE_PLAN_STATUSES.includes(candidate.status) &&
              new Date(candidate.scheduledFor) <= performedAt
            ))
            .sort((left, right) => {
              const statusRank = { OVERDUE: 0, IN_WINDOW: 1, PLANNED: 2 };
              return (
                statusRank[effectiveRoutinePlanStatus(left, performedAt)] -
                  statusRank[effectiveRoutinePlanStatus(right, performedAt)] ||
                new Date(left.dueAt) - new Date(right.dueAt) ||
                String(left._id).localeCompare(String(right._id))
              );
            });
          plan = executablePlans[0] || null;
          futureOpenPlanExists = candidatePlans.some((candidate) => (
            OPEN_ROUTINE_PLAN_STATUSES.includes(candidate.status) &&
            new Date(candidate.scheduledFor) > performedAt
          ));
          if (!plan && restDayCancelled) {
            throw routineError(
              409,
              'EQUIPMENT_ROUTINE_REST_DAY_CANCELLED',
              'This inspection plan was cancelled because the equipment is off duty today'
            );
          }
        }
        if (plan && legacyPlanlessRecordCoversPlan(schedule, plan)) {
          throw routineError(
            409,
            'EQUIPMENT_ROUTINE_PERIOD_COMPLETED',
            'This routine has already been completed for the current period'
          );
        }
        if (plan || (futureOpenPlanExists && schedule.latestRecord?.planId)) {
          completedCurrentPeriod = false;
        }
        if (
          !submission.planId &&
          !plan &&
          rule.schedule.mode !== EQUIPMENT_ROUTINE_SCHEDULE_TYPES.MANUAL
        ) {
          const recovery = await recoverCancelledSubmissionPlan({
            rule,
            asset,
            schedule,
            performedAt,
            runtimeHours,
            rematerializedBy: context.userId,
            session
          });
          plan = recovery.plan;
          recoveryMatched = recovery.matched;
          recoveryNotStarted = recovery.notStarted === true;
        }
        if (!plan && recoveryNotStarted) {
          throw routineError(
            409,
            completedCurrentPeriod
              ? 'EQUIPMENT_ROUTINE_PERIOD_COMPLETED'
              : 'EQUIPMENT_ROUTINE_PLAN_NOT_STARTED',
            completedCurrentPeriod
              ? 'This routine has already been completed for the current period'
              : 'The routine plan cannot be executed before its start time'
          );
        }
        if (
          !submission.planId &&
          !plan &&
          !recoveryMatched &&
          futureOpenPlanExists
        ) {
          throw routineError(
            409,
            completedCurrentPeriod
              ? 'EQUIPMENT_ROUTINE_PERIOD_COMPLETED'
              : 'EQUIPMENT_ROUTINE_PLAN_NOT_STARTED',
            completedCurrentPeriod
              ? 'This routine has already been completed for the current period'
              : 'The routine plan cannot be executed before its start time'
          );
        }
        if (rule.schedule.mode !== EQUIPMENT_ROUTINE_SCHEDULE_TYPES.MANUAL && !plan) {
          if (!recoveryMatched) {
            try {
              plan = await materializeSubmissionPlan({
                rule,
                asset,
                schedule,
                performedAt,
                runtimeHours,
                rematerializedBy: context.userId,
                session
              });
            } catch (error) {
              if (
                completedCurrentPeriod &&
                error?.code === 'EQUIPMENT_ROUTINE_PLAN_NOT_STARTED'
              ) {
                throw routineError(
                  409,
                  'EQUIPMENT_ROUTINE_PERIOD_COMPLETED',
                  'This routine has already been completed for the current period'
                );
              }
              throw error;
            }
          }
        }
        if (
          plan &&
          !submissionPlanTriggerSatisfied(rule, plan, schedule, runtimeHours, performedAt)
        ) {
          throw routineError(
            409,
            completedCurrentPeriod
              ? 'EQUIPMENT_ROUTINE_PERIOD_COMPLETED'
              : 'EQUIPMENT_ROUTINE_NOT_DUE',
            completedCurrentPeriod
              ? 'This routine has already been completed for the current period'
              : 'This routine is not currently due'
          );
        }
        if (rule.schedule.mode !== EQUIPMENT_ROUTINE_SCHEDULE_TYPES.MANUAL && !plan) {
          throw routineError(
            409,
            completedCurrentPeriod
              ? 'EQUIPMENT_ROUTINE_PERIOD_COMPLETED'
              : 'EQUIPMENT_ROUTINE_NOT_DUE',
            completedCurrentPeriod
              ? 'This routine has already been completed for the current period'
              : 'This routine is not currently due'
          );
        }

        const abnormalSummary = submission.abnormalSummary;
        const itemResult = normalizeItemResults(rule, submission.itemResults, abnormalSummary);
        const photoFileIds = submission.photoFileIds;
        if (
          rule.photoPolicy === EQUIPMENT_ROUTINE_PHOTO_POLICIES.ALWAYS &&
          photoFileIds.length === 0
        ) {
          throw inputInvalid('This routine rule requires at least one photo');
        }
        if (
          rule.photoPolicy === EQUIPMENT_ROUTINE_PHOTO_POLICIES.ON_ABNORMAL &&
          itemResult.abnormal &&
          photoFileIds.length === 0
        ) {
          throw inputInvalid('An abnormal result requires at least one photo');
        }

        const photoEvidence = finalizePhotoEvidence(
          submission.photoEvidence,
          rule,
          performedAt,
          asset.location
        );
        const recordId = new mongoose.Types.ObjectId();
        const record = await createOne(EquipmentRoutineRecordModel, {
          _id: recordId,
          teamId: context.activeTeamId,
          orgUnitId: asset.orgUnitId,
          equipmentId: asset._id,
          categoryId: asset.categoryId,
          ruleId: rule._id,
          ruleVersion: rule.version,
          planId: plan?._id || null,
          routineType: rule.routineType,
          scheduledFor: plan?.scheduledFor || schedule.nextDueAt,
          planScheduledFor: plan?.scheduledFor || null,
          planDueAt: plan?.dueAt || null,
          dueRuntimeHours: schedule.nextDueRuntimeHours,
          performedBy: context.userId,
          performedAt,
          performedRuntimeHours: runtimeHours,
          itemResults: itemResult.results,
          overallResult: itemResult.overallResult,
          abnormalSummary,
          photoFileIds,
          photoEvidence,
          idempotencyKey,
          ruleSnapshot: serializeRule(rule)
        }, session);

        if (runtimeHours !== null) {
          await appendRuntimeReading({
            context,
            req,
            asset,
            hours: runtimeHours,
            source: rule.routineType,
            sourceRecordId: record._id,
            reason: `${rule.routineType} routine submission`,
            recordedAt: performedAt,
            session
          });
        }

        if (photoFileIds.length > 0) {
          await fileAssetService.reconcileOwnerFiles({
            authContext: context,
            req,
            attachments: photoFileIds.map((fileId) => ({ fileId })),
            previousAttachments: [],
            ownerType: fileOwnerType(rule.routineType),
            ownerId: record._id,
            method: 'POST',
            allowedMimeTypes: ['image/jpeg', 'image/png', 'image/gif'],
            session
          });
        }

        if (plan) {
          const completed = await EquipmentRoutinePlanModel.updateOne({
            _id: plan._id,
            status: { $in: [
              EQUIPMENT_ROUTINE_PLAN_STATUSES.PLANNED,
              EQUIPMENT_ROUTINE_PLAN_STATUSES.IN_WINDOW,
              EQUIPMENT_ROUTINE_PLAN_STATUSES.OVERDUE
            ] }
          }, {
            $set: {
              status: EQUIPMENT_ROUTINE_PLAN_STATUSES.COMPLETED,
              completedRecordId: record._id,
              completedAt: performedAt,
              completedBy: context.userId
            }
          }, { session });
          if (completed.modifiedCount !== 1) {
            throw routineError(
              409,
              'EQUIPMENT_ROUTINE_PLAN_NOT_OPEN',
              'The selected routine plan was completed concurrently'
            );
          }
          await execute(EquipmentRoutinePlanModel.updateMany({
            teamId: context.activeTeamId,
            equipmentId: asset._id,
            ruleId: rule._id,
            ruleVersion: rule.version,
            cycleKey: plan.cycleKey,
            windowKey: plan.windowKey,
            _id: { $ne: plan._id },
            $or: [
              { status: { $in: OPEN_ROUTINE_PLAN_STATUSES } },
              {
                status: EQUIPMENT_ROUTINE_PLAN_STATUSES.CANCELLED,
                cancellationReason:
                  EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS.EQUIPMENT_CATEGORY_CHANGED
              }
            ]
          }, {
            $set: {
              status: EQUIPMENT_ROUTINE_PLAN_STATUSES.CANCELLED,
              cancellationReason: EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS.SIBLING_COMPLETED,
              cancelledAt: performedAt,
              cancelledBy: context.userId
            }
          }), session);
        }

        if (
          plan &&
          rule.schedule.mode === EQUIPMENT_ROUTINE_SCHEDULE_TYPES.COMBINED &&
          rule.schedule.duePolicy === 'ALL'
        ) {
          await execute(EquipmentRoutinePlanModel.updateMany({
            teamId: context.activeTeamId,
            equipmentId: asset._id,
            ruleId: rule._id,
            ruleVersion: rule.version,
            cycleKey: { $ne: plan.cycleKey },
            _id: { $ne: plan._id },
            status: { $in: OPEN_ROUTINE_PLAN_STATUSES }
          }, {
            $set: {
              status: EQUIPMENT_ROUTINE_PLAN_STATUSES.CANCELLED,
              cancellationReason: EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS.SUPERSEDED,
              cancelledAt: performedAt,
              cancelledBy: context.userId
            }
          }), session);
        }

        if (
          rule.schedule.mode === EQUIPMENT_ROUTINE_SCHEDULE_TYPES.COMBINED &&
          rule.schedule.duePolicy === 'ANY'
        ) {
          const siblingPlanFilter = {
            teamId: context.activeTeamId,
            equipmentId: asset._id,
            ruleId: rule._id,
            $or: [
              { status: { $in: OPEN_ROUTINE_PLAN_STATUSES } },
              {
                status: EQUIPMENT_ROUTINE_PLAN_STATUSES.CANCELLED,
                cancellationReason:
                  EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS.EQUIPMENT_CATEGORY_CHANGED
              }
            ]
          };
          const generationPrefix = combinedAnyGenerationPrefix(plan?.cycleKey);
          if (generationPrefix) {
            siblingPlanFilter.cycleKey = {
              $regex: `^${escapeRegex(generationPrefix)}`,
              $ne: plan.cycleKey
            };
          } else if (plan?.cycleKey) {
            siblingPlanFilter.cycleKey = { $ne: plan.cycleKey };
          }
          await execute(EquipmentRoutinePlanModel.updateMany(siblingPlanFilter, {
            $set: {
              status: EQUIPMENT_ROUTINE_PLAN_STATUSES.CANCELLED,
              cancellationReason: EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS.SIBLING_COMPLETED,
              cancelledAt: performedAt,
              cancelledBy: context.userId
            }
          }), session);
        }

        if (itemResult.abnormal) {
          await routineWorkflowService.createExceptionForRecord({
            record,
            asset,
            actorId: context.userId,
            actorPositionKey: context.membership?.positionKey || '',
            summary: abnormalSummary || itemResult.results
              .filter(({ result }) => result === 'ABNORMAL')
              .map(({ note }) => note)
              .filter(Boolean)
              .join('；'),
            session
          });
        }

        const serializedPlan = plan ? {
          ...plain(plan),
          status: EQUIPMENT_ROUTINE_PLAN_STATUSES.COMPLETED
        } : null;
        const after = serializeRecord({ ...plain(record), plan: serializedPlan });
        await auditService.record({
          req,
          authContext: context,
          action: AUDIT_ACTIONS.SUBMIT,
          resourceType: recordAuditResource(rule.routineType),
          resourceId: record._id,
          after,
          targetTeamId: context.activeTeamId,
          session
        });
        return after;
      });
    } catch (error) {
      throw normalizePersistenceError(error);
    }
  }

  async function listRuntimeReadings({
    authContext,
    requestedTeamId,
    method = 'GET',
    equipmentId,
    query = {}
  }) {
    assertOnlyKeys(query, ['teamId', 'page', 'pageSize'], 'query');
    const asset = await loadScopedAsset({
      authContext,
      requestedTeamId,
      method,
      equipmentId
    });
    const { page, pageSize, skip } = pagination(query);
    const filter = { teamId: asset.teamId, equipmentId: asset._id };
    const [documents, total] = await Promise.all([
      EquipmentRuntimeReadingModel.find(filter)
        .sort({ recordedAt: -1, _id: -1 })
        .skip(skip)
        .limit(pageSize)
        .lean(),
      EquipmentRuntimeReadingModel.countDocuments(filter)
    ]);
    return { readings: documents.map(serializeReading), total, page, pageSize };
  }

  async function createRuntimeReading({ authContext, req, equipmentId, input = {} }) {
    assertNoClientTeamId(input);
    assertOnlyKeys(input, ['hours', 'reason']);
    const context = assertTeamContext(authContext);
    assertPermission(context, 'equipment.edit');
    const hours = finiteNumber(input.hours, 'hours', { min: 0, required: true });
    const reason = optionalString(input.reason, 'reason', 2000, null);
    try {
      return await runRoutineTransaction(async (session) => {
        const asset = await loadScopedAsset({
          authContext: context,
          method: 'POST',
          equipmentId,
          session
        });
        const reading = await appendRuntimeReading({
          context,
          req,
          asset,
          hours,
          source: 'MANUAL',
          reason,
          recordedAt: clock(),
          session
        });
        return serializeReading(reading);
      });
    } catch (error) {
      throw normalizePersistenceError(error);
    }
  }

  return Object.freeze({
    calculateRuleSchedule,
    createRecord,
    createRule,
    createRuntimeReading,
    deleteRule,
    disableRule,
    getRecord,
    getRule,
    getSchedule,
    getInspectionCalendar,
    listRecords,
    listRules,
    listRuntimeReadings,
    updateRule
  });
}

module.exports = {
  createEquipmentRoutineService,
  normalizeChecklistItems,
  normalizeExecutionConfig,
  normalizeSchedule,
  resolveRoutineRuleAssetCategoryIds,
  resolveRoutineRuleLookupCategoryIds,
  serializeExecutionConfig,
  serializeReading,
  serializeRecord,
  serializeRule
};
