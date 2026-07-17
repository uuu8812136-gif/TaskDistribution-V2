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
