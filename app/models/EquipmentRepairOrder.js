'use strict';

const mongoose = require('mongoose');

const EQUIPMENT_REPAIR_TYPES = Object.freeze({
  FAULT_REPORT: 'FAULT_REPORT',
  PARTS_REPAIR: 'PARTS_REPAIR',
  NO_PARTS_REPAIR: 'NO_PARTS_REPAIR'
});
const EQUIPMENT_REPAIR_TYPE_VALUES = Object.freeze(Object.values(EQUIPMENT_REPAIR_TYPES));

const EQUIPMENT_REPAIR_STATUSES = Object.freeze({
  SUB_DEPARTMENT_REVIEW_PENDING: 'SUB_DEPARTMENT_REVIEW_PENDING',
  SUB_DEPARTMENT_ACCEPTANCE_PENDING: 'SUB_DEPARTMENT_ACCEPTANCE_PENDING',
  ASSET_ADMIN_RECEIPT_PENDING: 'ASSET_ADMIN_RECEIPT_PENDING',
  ASSET_ADMIN_PRICING_PENDING: 'ASSET_ADMIN_PRICING_PENDING',
  DEPUTY_APPROVAL_PENDING: 'DEPUTY_APPROVAL_PENDING',
  MANAGER_APPROVAL_PENDING: 'MANAGER_APPROVAL_PENDING',
  RETURNED_TO_CREATOR: 'RETURNED_TO_CREATOR',
  COMPLETED: 'COMPLETED',
  VOIDED: 'VOIDED'
});
const EQUIPMENT_REPAIR_STATUS_VALUES = Object.freeze(Object.values(EQUIPMENT_REPAIR_STATUSES));

const EQUIPMENT_REPAIR_ACTIONS = Object.freeze({
  CREATE: 'CREATE',
  RESUBMIT: 'RESUBMIT',
  SUB_DEPARTMENT_APPROVE: 'SUB_DEPARTMENT_APPROVE',
  ACCEPT_RECEIPT: 'ACCEPT_RECEIPT',
  CONFIRM_PRICING: 'CONFIRM_PRICING',
  DEPUTY_APPROVE: 'DEPUTY_APPROVE',
  MANAGER_APPROVE: 'MANAGER_APPROVE',
  REJECT_TO_CREATOR: 'REJECT_TO_CREATOR',
  REJECT_TO_PREVIOUS: 'REJECT_TO_PREVIOUS',
  VOID: 'VOID'
});
const EQUIPMENT_REPAIR_ACTION_VALUES = Object.freeze(Object.values(EQUIPMENT_REPAIR_ACTIONS));

const partItemSchema = new mongoose.Schema({
  itemKey: {
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: 64
  },
  name: {
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: 200
  },
  specification: {
    type: String,
    trim: true,
    maxlength: 300,
    default: ''
  },
  remark: {
    type: String,
    trim: true,
    maxlength: 1000,
    default: ''
  },
  quantity: {
    type: Number,
    min: 0.000001,
    max: 1000000000,
    default: null
  },
  unitPriceCents: {
    type: Number,
    min: 0,
    max: 9007199254740991,
    default: null,
    validate: {
      validator: (value) => value === null || Number.isSafeInteger(value),
      message: 'unitPriceCents must be a safe integer or null'
    }
  },
  amountCents: {
    type: Number,
    min: 0,
    max: 9007199254740991,
    default: null,
    validate: {
      validator: (value) => value === null || Number.isSafeInteger(value),
      message: 'amountCents must be a safe integer or null'
    }
  }
}, {
  _id: false,
  strict: 'throw'
});

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

const actionLogSchema = new mongoose.Schema({
  action: {
    type: String,
    enum: EQUIPMENT_REPAIR_ACTION_VALUES,
    required: true,
    immutable: true
  },
  fromStatus: {
    type: String,
    enum: [...EQUIPMENT_REPAIR_STATUS_VALUES, null],
    default: null,
    immutable: true
  },
  toStatus: {
    type: String,
    enum: EQUIPMENT_REPAIR_STATUS_VALUES,
    required: true,
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
  note: {
    type: String,
    trim: true,
    maxlength: 2000,
    default: '',
    immutable: true
  },
  corrections: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
    immutable: true
  },
  actedAt: {
    type: Date,
    required: true,
    default: Date.now,
    immutable: true
  }
}, {
  _id: true,
  strict: 'throw'
});

const equipmentSnapshotSchema = new mongoose.Schema({
  assetCode: { type: String, required: true, trim: true, maxlength: 100 },
  name: { type: String, required: true, trim: true, maxlength: 200 },
  departmentName: { type: String, trim: true, maxlength: 200, default: '' },
  orgUnitName: { type: String, trim: true, maxlength: 200, default: '' },
  location: { type: String, trim: true, maxlength: 500, default: '' },
  plateNumber: { type: String, trim: true, maxlength: 100, default: '' }
}, {
  _id: false,
  strict: 'throw'
});

const equipmentRepairOrderSchema = new mongoose.Schema({
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
  type: {
    type: String,
    enum: EQUIPMENT_REPAIR_TYPE_VALUES,
    required: true,
    immutable: true
  },
  status: {
    type: String,
    enum: EQUIPMENT_REPAIR_STATUS_VALUES,
    required: true
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
  reportTime: { type: Date, default: null },
  reportLocation: { type: String, trim: true, maxlength: 500, default: '' },
  plateNumber: { type: String, trim: true, maxlength: 100, default: '' },
  contactName: { type: String, trim: true, maxlength: 100, default: '' },
  contactPhone: { type: String, trim: true, maxlength: 50, default: '' },
  faultDescription: { type: String, trim: true, maxlength: 5000, default: '' },
  repairDate: { type: Date, default: null },
  repairerName: { type: String, trim: true, maxlength: 200, default: '' },
  repairDescription: { type: String, trim: true, maxlength: 5000, default: '' },
  partItems: {
    type: [partItemSchema],
    default: [],
    validate: [
      {
        validator: (items) => Array.isArray(items) && items.length <= 100,
        message: 'partItems cannot contain more than 100 rows'
      },
      {
        validator: (items) => new Set(items.map((item) => item.itemKey)).size === items.length,
        message: 'partItems itemKey values must be unique'
      }
    ]
  },
  totalAmountCents: {
    type: Number,
    min: 0,
    max: 9007199254740991,
    required: true,
    default: 0,
    validate: {
      validator: Number.isSafeInteger,
      message: 'totalAmountCents must be a safe integer'
    }
  },
  photoAttachments: {
    type: [attachmentSchema],
    default: [],
    validate: [
      {
        validator: (items) => Array.isArray(items) && items.length <= 5,
        message: 'photoAttachments cannot contain more than 5 files'
      },
      {
        validator: (items) => new Set(items.map((item) => String(item.fileId))).size === items.length,
        message: 'photoAttachments fileId values must be unique'
      }
    ]
  },
  returnedFromStatus: {
    type: String,
    enum: [...EQUIPMENT_REPAIR_STATUS_VALUES, null],
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
  actionLogs: {
    type: [actionLogSchema],
    default: []
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

equipmentRepairOrderSchema.pre('validate', function validateTypeSpecificFields(next) {
  const isFault = this.type === EQUIPMENT_REPAIR_TYPES.FAULT_REPORT;
  const isParts = this.type === EQUIPMENT_REPAIR_TYPES.PARTS_REPAIR;
  if (isFault) {
    if (!this.reportTime || !this.reportLocation || !this.contactName ||
        !this.contactPhone || !this.faultDescription) {
      this.invalidate('type', 'FAULT_REPORT requires all fault report fields');
    }
    if (!Array.isArray(this.photoAttachments) || this.photoAttachments.length < 1) {
      this.invalidate('photoAttachments', 'FAULT_REPORT requires between 1 and 5 photos');
    }
    if (this.partItems.length > 0 || this.totalAmountCents !== 0) {
      this.invalidate('partItems', 'FAULT_REPORT cannot contain part pricing');
    }
  } else {
    if (!this.repairDate || !this.repairerName) {
      this.invalidate('type', 'Repair orders require repairDate and repairerName');
    }
    if (isParts && this.partItems.length < 1) {
      this.invalidate('partItems', 'PARTS_REPAIR requires at least one part row');
    }
    if (!isParts && (this.partItems.length > 0 || this.totalAmountCents !== 0)) {
      this.invalidate('partItems', 'NO_PARTS_REPAIR cannot contain part pricing');
    }
  }
  next();
});

equipmentRepairOrderSchema.index(
  { teamId: 1, orgUnitId: 1, status: 1, createdAt: -1 },
  { name: 'ix_equipment_repair_scope_status_created' }
);
equipmentRepairOrderSchema.index(
  { teamId: 1, equipmentId: 1, createdAt: -1 },
  { name: 'ix_equipment_repair_team_equipment_created' }
);
equipmentRepairOrderSchema.index(
  { teamId: 1, type: 1, status: 1, createdAt: -1 },
  { name: 'ix_equipment_repair_team_type_status_created' }
);
equipmentRepairOrderSchema.index(
  { teamId: 1, createdBy: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: 'string' } },
    name: 'uq_equipment_repair_team_creator_idempotency'
  }
);

const EquipmentRepairOrder = mongoose.model('EquipmentRepairOrder', equipmentRepairOrderSchema);

module.exports = EquipmentRepairOrder;
module.exports.EQUIPMENT_REPAIR_TYPES = EQUIPMENT_REPAIR_TYPES;
module.exports.EQUIPMENT_REPAIR_TYPE_VALUES = EQUIPMENT_REPAIR_TYPE_VALUES;
module.exports.EQUIPMENT_REPAIR_STATUSES = EQUIPMENT_REPAIR_STATUSES;
module.exports.EQUIPMENT_REPAIR_STATUS_VALUES = EQUIPMENT_REPAIR_STATUS_VALUES;
module.exports.EQUIPMENT_REPAIR_ACTIONS = EQUIPMENT_REPAIR_ACTIONS;
module.exports.EQUIPMENT_REPAIR_ACTION_VALUES = EQUIPMENT_REPAIR_ACTION_VALUES;
