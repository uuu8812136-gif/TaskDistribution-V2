'use strict';

const mongoose = require('mongoose');
const { EQUIPMENT_ROUTINE_TYPE_VALUES } = require('./EquipmentRoutineRule');

const EQUIPMENT_ROUTINE_EXCEPTION_STATUSES = Object.freeze({
  OPEN: 'OPEN',
  RESOLVED: 'RESOLVED'
});
const EQUIPMENT_ROUTINE_EXCEPTION_STATUS_VALUES = Object.freeze(
  Object.values(EQUIPMENT_ROUTINE_EXCEPTION_STATUSES)
);

const EQUIPMENT_ROUTINE_EXCEPTION_STAGES = Object.freeze({
  TEAM_LEADER: 'TEAM_LEADER',
  SUB_DEPARTMENT_MANAGER: 'SUB_DEPARTMENT_MANAGER',
  ASSET_ADMIN: 'ASSET_ADMIN',
  RESOLVED: 'RESOLVED'
});
const EQUIPMENT_ROUTINE_EXCEPTION_STAGE_VALUES = Object.freeze(
  Object.values(EQUIPMENT_ROUTINE_EXCEPTION_STAGES)
);

const EQUIPMENT_ROUTINE_EXCEPTION_ACTIONS = Object.freeze({
  SUBMITTED: 'SUBMITTED',
  RESOLVE: 'RESOLVE',
  ESCALATE: 'ESCALATE'
});
const EQUIPMENT_ROUTINE_EXCEPTION_ACTION_VALUES = Object.freeze(
  Object.values(EQUIPMENT_ROUTINE_EXCEPTION_ACTIONS)
);

const historySchema = new mongoose.Schema({
  stage: {
    type: String,
    enum: EQUIPMENT_ROUTINE_EXCEPTION_STAGE_VALUES,
    required: true,
    immutable: true
  },
  action: {
    type: String,
    enum: EQUIPMENT_ROUTINE_EXCEPTION_ACTION_VALUES,
    required: true,
    immutable: true
  },
  opinion: {
    type: String,
    trim: true,
    maxlength: 3000,
    default: '',
    immutable: true
  },
  actorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    immutable: true
  },
  actorPositionKey: {
    type: String,
    trim: true,
    maxlength: 100,
    default: '',
    immutable: true
  },
  actedAt: {
    type: Date,
    required: true,
    immutable: true
  }
}, {
  _id: false,
  strict: 'throw'
});

const equipmentRoutineExceptionSchema = new mongoose.Schema({
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
  recordId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'EquipmentRoutineRecord',
    required: true,
    immutable: true
  },
  routineType: {
    type: String,
    enum: EQUIPMENT_ROUTINE_TYPE_VALUES,
    required: true,
    immutable: true
  },
  status: {
    type: String,
    enum: EQUIPMENT_ROUTINE_EXCEPTION_STATUS_VALUES,
    required: true,
    default: EQUIPMENT_ROUTINE_EXCEPTION_STATUSES.OPEN
  },
  currentStage: {
    type: String,
    enum: EQUIPMENT_ROUTINE_EXCEPTION_STAGE_VALUES,
    required: true,
    default: EQUIPMENT_ROUTINE_EXCEPTION_STAGES.TEAM_LEADER
  },
  summary: {
    type: String,
    trim: true,
    maxlength: 5000,
    required: true,
    immutable: true
  },
  history: {
    type: [historySchema],
    required: true,
    default: []
  },
  resolvedAt: {
    type: Date,
    default: null
  },
  resolvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  revision: {
    type: Number,
    required: true,
    min: 0,
    default: 0
  }
}, {
  timestamps: true,
  strict: 'throw',
  optimisticConcurrency: true
});

equipmentRoutineExceptionSchema.pre('validate', function validateResolution(next) {
  const resolved = this.status === EQUIPMENT_ROUTINE_EXCEPTION_STATUSES.RESOLVED;
  if (resolved && (this.currentStage !== EQUIPMENT_ROUTINE_EXCEPTION_STAGES.RESOLVED || !this.resolvedAt || !this.resolvedBy)) {
    this.invalidate('status', 'A resolved routine exception requires resolution metadata');
  }
  if (!resolved && (this.currentStage === EQUIPMENT_ROUTINE_EXCEPTION_STAGES.RESOLVED || this.resolvedAt || this.resolvedBy)) {
    this.invalidate('status', 'Resolution metadata requires RESOLVED status');
  }
  next();
});

equipmentRoutineExceptionSchema.index(
  { teamId: 1, recordId: 1 },
  { unique: true, name: 'uq_equipment_routine_exception_record' }
);
equipmentRoutineExceptionSchema.index(
  { teamId: 1, orgUnitId: 1, status: 1, currentStage: 1, createdAt: -1 },
  { name: 'ix_equipment_routine_exception_workbench' }
);

const EquipmentRoutineException = mongoose.model(
  'EquipmentRoutineException',
  equipmentRoutineExceptionSchema
);

module.exports = EquipmentRoutineException;
module.exports.EQUIPMENT_ROUTINE_EXCEPTION_STATUSES = EQUIPMENT_ROUTINE_EXCEPTION_STATUSES;
module.exports.EQUIPMENT_ROUTINE_EXCEPTION_STATUS_VALUES = EQUIPMENT_ROUTINE_EXCEPTION_STATUS_VALUES;
module.exports.EQUIPMENT_ROUTINE_EXCEPTION_STAGES = EQUIPMENT_ROUTINE_EXCEPTION_STAGES;
module.exports.EQUIPMENT_ROUTINE_EXCEPTION_STAGE_VALUES = EQUIPMENT_ROUTINE_EXCEPTION_STAGE_VALUES;
module.exports.EQUIPMENT_ROUTINE_EXCEPTION_ACTIONS = EQUIPMENT_ROUTINE_EXCEPTION_ACTIONS;
module.exports.EQUIPMENT_ROUTINE_EXCEPTION_ACTION_VALUES = EQUIPMENT_ROUTINE_EXCEPTION_ACTION_VALUES;
