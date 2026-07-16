'use strict';

const mongoose = require('mongoose');

const FILE_STATUSES = Object.freeze({
  TEMPORARY: 'TEMPORARY',
  ACTIVE: 'ACTIVE',
  DELETED: 'DELETED'
});

const FILE_OWNER_TYPES = Object.freeze({
  TEMPORARY: 'TEMPORARY',
  TASK: 'TASK',
  TASK_COMPLETION: 'TASK_COMPLETION',
  TASK_REVIEW: 'TASK_REVIEW',
  EQUIPMENT: 'EQUIPMENT',
  INVENTORY: 'INVENTORY',
  INSPECTION: 'INSPECTION',
  REPAIR: 'REPAIR',
  MAINTENANCE: 'MAINTENANCE',
  EQUIPMENT_STATUS_APPLICATION: 'EQUIPMENT_STATUS_APPLICATION',
  TRANSPORT_REPORT: 'TRANSPORT_REPORT',
  ATTENDANCE_REPORT: 'ATTENDANCE_REPORT'
});

const fileAssetSchema = new mongoose.Schema({
  teamId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ProjectTeam',
    required: true,
    immutable: true
  },
  ownerType: {
    type: String,
    enum: Object.values(FILE_OWNER_TYPES),
    required: true,
    default: FILE_OWNER_TYPES.TEMPORARY
  },
  ownerId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null
  },
  storageKey: {
    type: String,
    required: true,
    immutable: true,
    trim: true,
    minlength: 10,
    maxlength: 300,
    match: /^[0-9a-f]{24}\/\d{4}\/\d{2}\/[0-9a-f-]{36}(?:\.[a-z0-9]{1,16})?$/
  },
  originalName: {
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: 255
  },
  mimeType: {
    type: String,
    required: true,
    trim: true,
    maxlength: 150
  },
  size: {
    type: Number,
    required: true,
    min: 0,
    validate: {
      validator: Number.isInteger,
      message: 'size must be an integer'
    }
  },
  sha256: {
    type: String,
    required: true,
    immutable: true,
    lowercase: true,
    trim: true,
    match: /^[a-f0-9]{64}$/
  },
  uploaderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    immutable: true
  },
  status: {
    type: String,
    enum: Object.values(FILE_STATUSES),
    required: true,
    default: FILE_STATUSES.TEMPORARY
  },
  deletedAt: {
    type: Date,
    default: null
  },
  deletedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  }
}, {
  timestamps: true,
  strict: 'throw',
  optimisticConcurrency: true
});

fileAssetSchema.pre('validate', function validateOwnershipState(next) {
  const isTemporary = this.status === FILE_STATUSES.TEMPORARY;
  if (isTemporary && (this.ownerType !== FILE_OWNER_TYPES.TEMPORARY || this.ownerId)) {
    this.invalidate('ownerId', 'A temporary file cannot be bound to a business owner');
  }
  if (!isTemporary && this.status !== FILE_STATUSES.DELETED && !this.ownerId) {
    this.invalidate('ownerId', 'An active file requires a business owner');
  }
  if (this.status === FILE_STATUSES.ACTIVE && this.ownerType === FILE_OWNER_TYPES.TEMPORARY) {
    this.invalidate('ownerType', 'An active file requires a business owner type');
  }
  if (this.status === FILE_STATUSES.DELETED && (!this.deletedAt || !this.deletedBy)) {
    this.invalidate('deletedAt', 'A deleted file requires deletedAt and deletedBy');
  }
  if (this.status !== FILE_STATUSES.DELETED && (this.deletedAt || this.deletedBy)) {
    this.invalidate('status', 'Deletion metadata requires DELETED status');
  }
  next();
});

fileAssetSchema.index(
  { storageKey: 1 },
  { unique: true, name: 'uq_file_asset_storage_key' }
);
fileAssetSchema.index(
  { teamId: 1, ownerType: 1, ownerId: 1, status: 1 },
  { name: 'ix_file_asset_team_owner_status' }
);
fileAssetSchema.index(
  { teamId: 1, uploaderId: 1, status: 1, createdAt: -1 },
  { name: 'ix_file_asset_team_uploader_status_created' }
);
fileAssetSchema.index(
  { teamId: 1, status: 1, createdAt: 1 },
  { name: 'ix_file_asset_team_status_created' }
);

const FileAsset = mongoose.model('FileAsset', fileAssetSchema);

module.exports = FileAsset;
module.exports.FILE_OWNER_TYPES = FILE_OWNER_TYPES;
module.exports.FILE_STATUSES = FILE_STATUSES;
