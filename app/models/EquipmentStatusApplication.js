'use strict';

const mongoose = require('mongoose');
const EquipmentAsset = require('./EquipmentAsset');

const EQUIPMENT_STATUS_APPLICATION_TYPES = Object.freeze({
  IN_USE: EquipmentAsset.EQUIPMENT_STATUSES.IN_USE,
  IDLE: EquipmentAsset.EQUIPMENT_STATUSES.IDLE,
  STOPPED: EquipmentAsset.EQUIPMENT_STATUSES.STOPPED,
  SCRAPPED: EquipmentAsset.EQUIPMENT_STATUSES.SCRAPPED
});
const EQUIPMENT_STATUS_APPLICATION_TYPE_VALUES = Object.freeze(
  Object.values(EQUIPMENT_STATUS_APPLICATION_TYPES)
);

const EQUIPMENT_STATUS_APPLICATION_STATUSES = Object.freeze({
  DEPUTY_REVIEW_PENDING: 'DEPUTY_REVIEW_PENDING',
  MANAGER_REVIEW_PENDING: 'MANAGER_REVIEW_PENDING',
  RETURNED_TO_CREATOR: 'RETURNED_TO_CREATOR',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  VOIDED: 'VOIDED'
});
const EQUIPMENT_STATUS_APPLICATION_STATUS_VALUES = Object.freeze(
  Object.values(EQUIPMENT_STATUS_APPLICATION_STATUSES)
);

const EQUIPMENT_STATUS_APPLICATION_ACTIONS = Object.freeze({
  CREATE: 'CREATE',
  RESUBMIT: 'RESUBMIT',
  DEPUTY_APPROVE: 'DEPUTY_APPROVE',
  MANAGER_APPROVE: 'MANAGER_APPROVE',
  RETURN_TO_CREATOR: 'RETURN_TO_CREATOR',
  REJECT: 'REJECT',
  VOID: 'VOID'
});
const EQUIPMENT_STATUS_APPLICATION_ACTION_VALUES = Object.freeze(
  Object.values(EQUIPMENT_STATUS_APPLICATION_ACTIONS)
);

const attachmentSchema = new mongoose.Schema({
  fileId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'FileAsset',
    required: true
  },
  originalName: { type: String, trim: true, maxlength: 255, default: '' },
  mimeType: { type: String, trim: true, maxlength: 150, default: '' },
  size: { type: Number, min: 0, default: null },
  uploadTime: { type: Date, default: null }
}, {
  _id: false,
  strict: 'throw'
});

const equipmentSnapshotSchema = new mongoose.Schema({
  assetCode: { type: String, required: true, trim: true, maxlength: 100 },
  name: { type: String, required: true, trim: true, maxlength: 200 },
  departmentName: { type: String, trim: true, maxlength: 200, default: '' },
  orgUnitName: { type: String, trim: true, maxlength: 200, default: '' },
  location: { type: String, trim: true, maxlength: 500, default: '' },
  sourceStatus: {
    type: String,
    enum: EquipmentAsset.EQUIPMENT_STATUS_VALUES,
    required: true
  },
  targetStatus: {
    type: String,
    enum: EQUIPMENT_STATUS_APPLICATION_TYPE_VALUES,
    required: true
  }
}, {
  _id: false,
  strict: 'throw'
});

const equipmentStatusApplicationSchema = new mongoose.Schema({
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
  applicationType: {
    type: String,
    enum: EQUIPMENT_STATUS_APPLICATION_TYPE_VALUES,
    required: true,
    immutable: true
  },
  sourceStatus: {
    type: String,
    enum: EquipmentAsset.EQUIPMENT_STATUS_VALUES,
    required: true,
    immutable: true
  },
  targetStatus: {
    type: String,
    enum: EQUIPMENT_STATUS_APPLICATION_TYPE_VALUES,
    required: true,
    immutable: true
  },
  workflowStatus: {
    type: String,
    enum: EQUIPMENT_STATUS_APPLICATION_STATUS_VALUES,
    required: true,
    default: EQUIPMENT_STATUS_APPLICATION_STATUSES.DEPUTY_REVIEW_PENDING
  },
  reason: {
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: 5000
  },
  attachments: {
    type: [attachmentSchema],
    default: [],
    validate: [
      {
        validator: (items) => Array.isArray(items) && items.length <= 10,
        message: 'attachments cannot contain more than 10 files'
      },
      {
        validator: (items) => new Set(items.map((item) => String(item.fileId))).size === items.length,
        message: 'attachments fileId values must be unique'
      }
    ]
  },
  equipmentSnapshot: {
    type: equipmentSnapshotSchema,
    required: true,
    immutable: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    immutable: true
  },
  returnedFromStatus: {
    type: String,
    enum: [...EQUIPMENT_STATUS_APPLICATION_STATUS_VALUES, null],
    default: null
  },
  lastActionBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  lastActionAt: {
    type: Date,
    required: true,
    default: Date.now
  },
  submittedAt: {
    type: Date,
    required: true,
    default: Date.now
  },
  finalizedAt: {
    type: Date,
    default: null
  },
  revision: {
    type: Number,
    required: true,
    min: 0,
    default: 0,
    validate: {
      validator: Number.isInteger,
      message: 'revision must be an integer'
    }
  },
  open: {
    type: Boolean,
    required: true,
    default: true
  },
  idempotencyKey: {
    type: String,
    trim: true,
    maxlength: 128,
    default: null,
    immutable: true
  }
}, {
  timestamps: true,
  strict: 'throw',
  versionKey: false
});

equipmentStatusApplicationSchema.pre('validate', function validateWorkflowState(next) {
  if (this.applicationType !== this.targetStatus) {
    this.invalidate('targetStatus', 'targetStatus must equal applicationType');
  }
  const terminal = new Set([
    EQUIPMENT_STATUS_APPLICATION_STATUSES.APPROVED,
    EQUIPMENT_STATUS_APPLICATION_STATUSES.REJECTED,
    EQUIPMENT_STATUS_APPLICATION_STATUSES.VOIDED
  ]);
  if (terminal.has(this.workflowStatus) === this.open) {
    this.invalidate('open', 'open must be false exactly when workflowStatus is terminal');
  }
  if (terminal.has(this.workflowStatus) && !this.finalizedAt) {
    this.invalidate('finalizedAt', 'terminal applications require finalizedAt');
  }
  if (!terminal.has(this.workflowStatus) && this.finalizedAt) {
    this.invalidate('finalizedAt', 'non-terminal applications cannot have finalizedAt');
  }
  next();
});

equipmentStatusApplicationSchema.index(
  { teamId: 1, orgUnitId: 1, workflowStatus: 1, createdAt: -1 },
  { name: 'ix_equipment_status_application_scope_workflow_created' }
);
equipmentStatusApplicationSchema.index(
  { teamId: 1, equipmentId: 1, createdAt: -1 },
  { name: 'ix_equipment_status_application_equipment_created' }
);
equipmentStatusApplicationSchema.index(
  { teamId: 1, equipmentId: 1, open: 1 },
  {
    unique: true,
    partialFilterExpression: { open: true },
    name: 'uq_equipment_status_application_one_open_per_equipment'
  }
);
equipmentStatusApplicationSchema.index(
  { teamId: 1, createdBy: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: 'string' } },
    name: 'uq_equipment_status_application_creator_idempotency'
  }
);

const EquipmentStatusApplication = mongoose.model(
  'EquipmentStatusApplication',
  equipmentStatusApplicationSchema
);

module.exports = EquipmentStatusApplication;
module.exports.EQUIPMENT_STATUS_APPLICATION_TYPES = EQUIPMENT_STATUS_APPLICATION_TYPES;
module.exports.EQUIPMENT_STATUS_APPLICATION_TYPE_VALUES = EQUIPMENT_STATUS_APPLICATION_TYPE_VALUES;
module.exports.EQUIPMENT_STATUS_APPLICATION_STATUSES = EQUIPMENT_STATUS_APPLICATION_STATUSES;
module.exports.EQUIPMENT_STATUS_APPLICATION_STATUS_VALUES = EQUIPMENT_STATUS_APPLICATION_STATUS_VALUES;
module.exports.EQUIPMENT_STATUS_APPLICATION_ACTIONS = EQUIPMENT_STATUS_APPLICATION_ACTIONS;
module.exports.EQUIPMENT_STATUS_APPLICATION_ACTION_VALUES = EQUIPMENT_STATUS_APPLICATION_ACTION_VALUES;
