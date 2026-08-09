'use strict';

const mongoose = require('mongoose');
const {
  EQUIPMENT_ROUTINE_TYPE_VALUES
} = require('./EquipmentRoutineRule');

const EQUIPMENT_ROUTINE_PLAN_STATUSES = Object.freeze({
  PLANNED: 'PLANNED',
  IN_WINDOW: 'IN_WINDOW',
  OVERDUE: 'OVERDUE',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED'
});
const EQUIPMENT_ROUTINE_PLAN_STATUS_VALUES = Object.freeze(
  Object.values(EQUIPMENT_ROUTINE_PLAN_STATUSES)
);
const EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS = Object.freeze({
  REST_DAY: 'REST_DAY'
});
const EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASON_VALUES = Object.freeze(
  Object.values(EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS)
);

function validDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function planTimeZone(plan) {
  const timeZone = String(plan?.ruleSnapshot?.executionConfig?.timeZone || 'Asia/Shanghai');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return 'Asia/Shanghai';
  }
}

function localDateKey(value, timeZone) {
  const date = validDate(value);
  if (!date) return '';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(date)
      .filter(({ type }) => type !== 'literal')
      .map(({ type, value: partValue }) => [type, partValue])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function isRoutinePlanCurrentBusinessDate(plan, now = new Date()) {
  const timeZone = planTimeZone(plan);
  const scheduledDateKey = localDateKey(plan?.scheduledFor, timeZone);
  return Boolean(
    scheduledDateKey &&
    scheduledDateKey === localDateKey(now, timeZone)
  );
}

function effectiveRoutinePlanStatus(plan, now = new Date()) {
  if (![
    EQUIPMENT_ROUTINE_PLAN_STATUSES.PLANNED,
    EQUIPMENT_ROUTINE_PLAN_STATUSES.IN_WINDOW,
    EQUIPMENT_ROUTINE_PLAN_STATUSES.OVERDUE
  ].includes(plan?.status)) {
    return plan?.status;
  }
  const instant = validDate(now);
  const scheduledFor = validDate(plan?.scheduledFor);
  const dueAt = validDate(plan?.dueAt);
  if (!instant || !scheduledFor || !dueAt) return plan?.status;
  if (instant < scheduledFor) return EQUIPMENT_ROUTINE_PLAN_STATUSES.PLANNED;
  if (instant <= dueAt) return EQUIPMENT_ROUTINE_PLAN_STATUSES.IN_WINDOW;
  return EQUIPMENT_ROUTINE_PLAN_STATUSES.OVERDUE;
}

function isRoutinePlanRestDayEligible(plan, now = new Date()) {
  if (plan?.routineType !== 'INSPECTION') return false;
  if (![
    EQUIPMENT_ROUTINE_PLAN_STATUSES.PLANNED,
    EQUIPMENT_ROUTINE_PLAN_STATUSES.IN_WINDOW,
    EQUIPMENT_ROUTINE_PLAN_STATUSES.OVERDUE
  ].includes(plan?.status)) {
    return false;
  }
  return isRoutinePlanCurrentBusinessDate(plan, now);
}

function routinePlanWindowName(plan) {
  return plan?.cancellationReason === EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS.REST_DAY
    ? '休班'
    : plan?.windowName;
}

const equipmentRoutinePlanSchema = new mongoose.Schema({
  teamId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ProjectTeam',
    required: true,
    immutable: true
  },
  orgUnitId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'OrgUnit',
    required: true,
    immutable: true
  },
  equipmentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'EquipmentAsset',
    required: true,
    immutable: true
  },
  categoryId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'EquipmentCategory',
    required: true,
    immutable: true
  },
  ruleId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'EquipmentRoutineRule',
    required: true,
    immutable: true
  },
  ruleVersion: {
    type: Number,
    min: 1,
    required: true,
    immutable: true
  },
  ruleSnapshot: {
    type: mongoose.Schema.Types.Mixed,
    required: true,
    immutable: true
  },
  routineType: {
    type: String,
    enum: EQUIPMENT_ROUTINE_TYPE_VALUES,
    required: true,
    immutable: true
  },
  cycleKey: {
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: 220,
    immutable: true
  },
  windowKey: {
    type: String,
    required: true,
    trim: true,
    maxlength: 50,
    immutable: true
  },
  windowName: {
    type: String,
    required: true,
    trim: true,
    maxlength: 100,
    immutable: true
  },
  scheduledFor: {
    type: Date,
    required: true,
    immutable: true
  },
  dueAt: {
    type: Date,
    required: true,
    immutable: true
  },
  status: {
    type: String,
    enum: EQUIPMENT_ROUTINE_PLAN_STATUS_VALUES,
    required: true,
    default: EQUIPMENT_ROUTINE_PLAN_STATUSES.PLANNED
  },
  completedRecordId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'EquipmentRoutineRecord',
    default: null
  },
  completedAt: {
    type: Date,
    default: null
  },
  completedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  cancellationReason: {
    type: String,
    enum: EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASON_VALUES,
    default: null
  },
  cancelledAt: {
    type: Date,
    default: null
  },
  cancelledBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  }
}, {
  timestamps: true,
  strict: 'throw',
  optimisticConcurrency: true
});

equipmentRoutinePlanSchema.pre('validate', function validateCompletion(next) {
  const completed = this.status === EQUIPMENT_ROUTINE_PLAN_STATUSES.COMPLETED;
  if (completed && (!this.completedRecordId || !this.completedAt || !this.completedBy)) {
    this.invalidate('status', 'A completed routine plan requires completion metadata');
  }
  if (!completed && (this.completedRecordId || this.completedAt || this.completedBy)) {
    this.invalidate('status', 'Completion metadata requires COMPLETED status');
  }
  const cancelled = this.status === EQUIPMENT_ROUTINE_PLAN_STATUSES.CANCELLED;
  const hasCancellationMetadata = Boolean(
    this.cancellationReason || this.cancelledAt || this.cancelledBy
  );
  if (!cancelled && hasCancellationMetadata) {
    this.invalidate('status', 'Cancellation metadata requires CANCELLED status');
  }
  if (
    this.cancellationReason === EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS.REST_DAY &&
    (!this.cancelledAt || !this.cancelledBy)
  ) {
    this.invalidate('cancellationReason', 'REST_DAY cancellation requires actor and time metadata');
  }
  if (this.scheduledFor && this.dueAt && this.scheduledFor > this.dueAt) {
    this.invalidate('dueAt', 'dueAt must be on or after scheduledFor');
  }
  next();
});

equipmentRoutinePlanSchema.index(
  { teamId: 1, ruleId: 1, equipmentId: 1, cycleKey: 1, windowKey: 1 },
  { unique: true, name: 'uq_equipment_routine_plan_cycle_window' }
);
equipmentRoutinePlanSchema.index(
  { teamId: 1, orgUnitId: 1, routineType: 1, status: 1, dueAt: 1 },
  { name: 'ix_equipment_routine_plan_workbench' }
);
equipmentRoutinePlanSchema.index(
  { teamId: 1, equipmentId: 1, ruleId: 1, status: 1, dueAt: 1 },
  { name: 'ix_equipment_routine_plan_asset_rule_status' }
);

const EquipmentRoutinePlan = mongoose.model('EquipmentRoutinePlan', equipmentRoutinePlanSchema);

module.exports = EquipmentRoutinePlan;
module.exports.EQUIPMENT_ROUTINE_PLAN_STATUSES = EQUIPMENT_ROUTINE_PLAN_STATUSES;
module.exports.EQUIPMENT_ROUTINE_PLAN_STATUS_VALUES = EQUIPMENT_ROUTINE_PLAN_STATUS_VALUES;
module.exports.EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS = EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS;
module.exports.EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASON_VALUES = EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASON_VALUES;
module.exports.effectiveRoutinePlanStatus = effectiveRoutinePlanStatus;
module.exports.isRoutinePlanCurrentBusinessDate = isRoutinePlanCurrentBusinessDate;
module.exports.isRoutinePlanRestDayEligible = isRoutinePlanRestDayEligible;
module.exports.localDateKey = localDateKey;
module.exports.routinePlanWindowName = routinePlanWindowName;
