'use strict';

const mongoose = require('mongoose');
const EquipmentRoutinePlan = require('../models/EquipmentRoutinePlan');

const {
  EQUIPMENT_ROUTINE_PLAN_STATUSES,
  EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS,
  EQUIPMENT_ROUTINE_PLAN_REMATERIALIZATION_SOURCES,
  EQUIPMENT_ROUTINE_PLAN_REMATERIALIZATION_SOURCE_VALUES
} = EquipmentRoutinePlan;

const OPEN_ROUTINE_PLAN_STATUSES = Object.freeze([
  EQUIPMENT_ROUTINE_PLAN_STATUSES.PLANNED,
  EQUIPMENT_ROUTINE_PLAN_STATUSES.IN_WINDOW,
  EQUIPMENT_ROUTINE_PLAN_STATUSES.OVERDUE
]);
const MAX_REMATERIALIZATION_HISTORY = 50;

function cycleVersionSegment(ruleVersion) {
  const version = Number(ruleVersion);
  return Number.isInteger(version) && version > 1 ? `v${version}:` : '';
}

function cycleKeyForCalendar(anchor, ruleVersion = null) {
  return `calendar:${cycleVersionSegment(ruleVersion)}${validDate(anchor, 'anchor').toISOString()}`;
}

function runtimeCycleKey(nextDueRuntimeHours, ruleVersion = null) {
  return `runtime:${cycleVersionSegment(ruleVersion)}${Number(nextDueRuntimeHours).toFixed(6)}`;
}

function combinedAnyCycleKey(schedule, triggerKey, ruleVersion = null) {
  const recordKey = schedule.materializationRecordKey || schedule.latestRecordId || 'initial';
  const calendarKey = schedule.nextDueAt
    ? validDate(schedule.nextDueAt, 'nextDueAt').toISOString()
    : 'none';
  const runtimeKey = schedule.nextDueRuntimeHours === null ||
    schedule.nextDueRuntimeHours === undefined
    ? 'none'
    : Number(schedule.nextDueRuntimeHours).toFixed(6);
  return `combined:any:${recordKey}:${cycleVersionSegment(ruleVersion)}calendar:${calendarKey}:runtime:${runtimeKey}:${triggerKey}`;
}

function combinedAnyGenerationPrefix(cycleKey) {
  const match = String(cycleKey || '').match(/^(combined:any:[^:]+:)/);
  return match ? match[1] : null;
}

function validDate(value, field) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${field} must be a valid date`);
  return date;
}

function actorId(value) {
  if (value === null || value === undefined || value === '') return null;
  if (!mongoose.isValidObjectId(value)) {
    throw new TypeError('rematerializedBy must be a valid ObjectId or null');
  }
  return new mongoose.Types.ObjectId(String(value));
}

function withSession(query, session) {
  if (session && typeof query.session === 'function') query.session(session);
  return query;
}

async function materializeOpenRoutinePlan({
  EquipmentRoutinePlanModel = EquipmentRoutinePlan,
  filter,
  insert,
  desiredStatus,
  rematerializedAt,
  rematerializedBy = null,
  source,
  allowInsert = true,
  recoverableCancellationReasons = [
    EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS.EQUIPMENT_CATEGORY_CHANGED
  ],
  session = null
}) {
  if (!OPEN_ROUTINE_PLAN_STATUSES.includes(desiredStatus)) {
    throw new TypeError('desiredStatus must be an open equipment routine plan status');
  }
  if (!EQUIPMENT_ROUTINE_PLAN_REMATERIALIZATION_SOURCE_VALUES.includes(source)) {
    throw new TypeError('source must be a valid equipment routine plan rematerialization source');
  }
  if (
    !Array.isArray(recoverableCancellationReasons) ||
    recoverableCancellationReasons.some((reason) => (
      !Object.values(EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS).includes(reason)
    ))
  ) {
    throw new TypeError('recoverableCancellationReasons must contain valid cancellation reasons');
  }
  const instant = validDate(rematerializedAt, 'rematerializedAt');
  const userId = actorId(rematerializedBy);
  if (allowInsert) {
    const options = { upsert: true, setDefaultsOnInsert: true };
    if (session) options.session = session;
    await EquipmentRoutinePlanModel.updateOne(filter, {
      $setOnInsert: insert
    }, options);
  }
  const statusOptions = {};
  if (session) statusOptions.session = session;
  await EquipmentRoutinePlanModel.updateOne({
    ...filter,
    status: { $in: OPEN_ROUTINE_PLAN_STATUSES }
  }, {
    $set: { status: desiredStatus }
  }, statusOptions);

  const rematerializationEvent = {
    cancellationReason: '$cancellationReason',
    cancelledAt: '$cancelledAt',
    cancelledBy: '$cancelledBy',
    rematerializedAt: { $literal: instant },
    rematerializedBy: { $literal: userId },
    source: { $literal: source }
  };
  const rematerializationOptions = { timestamps: false };
  if (session) rematerializationOptions.session = session;
  await EquipmentRoutinePlanModel.updateOne({
    ...filter,
    status: EQUIPMENT_ROUTINE_PLAN_STATUSES.CANCELLED,
    cancellationReason: { $in: recoverableCancellationReasons }
  }, [{
    $set: {
      status: desiredStatus,
      cancellationReason: null,
      cancelledAt: null,
      cancelledBy: null,
      rematerializationCount: {
        $add: [{ $ifNull: ['$rematerializationCount', 0] }, 1]
      },
      rematerializationHistory: {
        $slice: [{
          $concatArrays: [
            { $cond: [{ $isArray: '$rematerializationHistory' }, '$rematerializationHistory', []] },
            [rematerializationEvent]
          ]
        }, -MAX_REMATERIALIZATION_HISTORY]
      },
      updatedAt: { $literal: instant }
    }
  }], rematerializationOptions);

  return withSession(EquipmentRoutinePlanModel.findOne(filter).lean(), session);
}

module.exports = {
  EQUIPMENT_ROUTINE_PLAN_REMATERIALIZATION_SOURCES,
  MAX_REMATERIALIZATION_HISTORY,
  combinedAnyCycleKey,
  combinedAnyGenerationPrefix,
  cycleKeyForCalendar,
  materializeOpenRoutinePlan,
  runtimeCycleKey
};
