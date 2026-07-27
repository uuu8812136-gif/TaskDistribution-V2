'use strict';

const mongoose = require('mongoose');
const EquipmentAsset = require('./EquipmentAsset');
const { DATA_SCOPE_VALUES } = require('../config/permissions');

const IMPORT_TYPES = Object.freeze({
  EQUIPMENT_ASSET: 'EQUIPMENT_ASSET'
});

const IMPORT_JOB_STATUSES = Object.freeze({
  PREVIEW_READY: 'PREVIEW_READY',
  PUBLISHED: 'PUBLISHED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED'
});

const IMPORT_STAGING_CLEANUP_STATUSES = Object.freeze({
  PENDING: 'PENDING',
  COMPLETE: 'COMPLETE',
  FAILED: 'FAILED',
  RETAINED: 'RETAINED'
});

const IMPORT_ROW_STATUSES = Object.freeze({
  VALID: 'VALID',
  WARNING: 'WARNING',
  ERROR: 'ERROR',
  SKIPPED: 'SKIPPED',
  PUBLISHED: 'PUBLISHED'
});

const candidateSchema = new mongoose.Schema({
  assetCode: { type: String, default: '' },
  sourceAssetCode: { type: String, default: '' },
  sourceSequence: { type: String, default: '' },
  assetType: { type: String, default: '' },
  majorCategoryName: { type: String, default: '' },
  equipmentTypeName: { type: String, default: '' },
  primaryName: { type: String, default: '' },
  secondaryName: { type: String, default: '' },
  sourceSheetName: { type: String, default: '' },
  sourceRowNumber: { type: Number, default: null },
  sourceRawValues: { type: mongoose.Schema.Types.Mixed, default: null },
  sourceImageRefs: [{ type: String }],
  productCode: { type: String, default: '' },
  plateNumber: { type: String, default: '' },
  serialNumber: { type: String, default: '' },
  brandSerialNumber: { type: String, default: '' },
  name: { type: String, default: '' },
  categoryId: { type: mongoose.Schema.Types.ObjectId, default: null },
  categoryName: { type: String, default: '' },
  specification: { type: String, default: '' },
  manufacturer: { type: String, default: '' },
  brand: { type: String, default: '' },
  vehicleLength: { type: String, default: '' },
  ratedCapacityText: { type: String, default: '' },
  powerType: { type: String, default: '' },
  emissionStandard: { type: String, default: '' },
  quantity: { type: Number, default: 1 },
  bookQuantity: { type: Number, default: null },
  physicalQuantity: { type: Number, default: null },
  unit: { type: String, default: '' },
  acquisitionDate: { type: Date, default: null },
  productionDate: { type: Date, default: null },
  productionDatePrecision: {
    type: String,
    enum: [...EquipmentAsset.DATE_PRECISION_VALUES, null],
    default: null
  },
  productionDateRaw: { type: String, default: '' },
  productionDateDisplay: { type: String, default: '' },
  activationDate: { type: Date, default: null },
  activationDatePrecision: {
    type: String,
    enum: [...EquipmentAsset.DATE_PRECISION_VALUES, null],
    default: null
  },
  activationDateRaw: { type: String, default: '' },
  activationDateDisplay: { type: String, default: '' },
  idlePlacedAt: { type: Date, default: null },
  idlePlacedAtRaw: { type: String, default: '' },
  idlePlacedAtDisplay: { type: String, default: '' },
  originalValue: { type: Number, default: null },
  orgUnitId: { type: mongoose.Schema.Types.ObjectId, default: null },
  orgUnitName: { type: String, default: '' },
  custodianUserId: { type: mongoose.Schema.Types.ObjectId, default: null },
  custodianName: { type: String, default: '' },
  custodianDisplayName: { type: String, default: '' },
  orgUnitNameSnapshot: { type: String, default: '' },
  location: { type: String, default: '' },
  status: {
    type: String,
    enum: EquipmentAsset.EQUIPMENT_STATUS_VALUES,
    default: EquipmentAsset.EQUIPMENT_STATUSES.IN_USE
  },
  conditionText: { type: String, default: '' },
  forkliftPosition: { type: String, default: '' },
  environmentalRegistrationCode: { type: String, default: '' },
  remark: { type: String, default: '' },
  photoFileIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'FileAsset' }],
  dataQuality: { type: mongoose.Schema.Types.Mixed, default: () => ({}) }
}, { _id: false, strict: 'throw' });

const stagedRowSchema = new mongoose.Schema({
  rowId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    immutable: true,
    default: () => new mongoose.Types.ObjectId()
  },
  sheetName: { type: String, required: true, maxlength: 100, immutable: true },
  rowNumber: { type: Number, required: true, min: 1, immutable: true },
  rawAssetCode: { type: String, maxlength: 500, default: '', immutable: true },
  rawValues: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },
  candidate: { type: candidateSchema, required: true },
  validationStatus: {
    type: String,
    enum: Object.values(IMPORT_ROW_STATUSES),
    required: true
  },
  publishedEquipmentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'EquipmentAsset',
    default: null
  }
}, { _id: false, strict: 'throw' });

const importJobSchema = new mongoose.Schema({
  teamId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ProjectTeam',
    required: true,
    immutable: true
  },
  type: {
    type: String,
    enum: Object.values(IMPORT_TYPES),
    required: true,
    immutable: true
  },
  sourceFileId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'FileAsset',
    default: null,
    immutable: true
  },
  sourceFileName: {
    type: String,
    required: true,
    maxlength: 255,
    immutable: true
  },
  sourceFileSize: {
    type: Number,
    required: true,
    min: 1,
    immutable: true
  },
  sourceSha256: {
    type: String,
    required: true,
    match: /^[a-f0-9]{64}$/,
    immutable: true
  },
  sourceSheetNames: [{ type: String, maxlength: 100, immutable: true }],
  mediaSummary: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
    immutable: true
  },
  dataScope: {
    type: String,
    enum: DATA_SCOPE_VALUES,
    required: true,
    immutable: true
  },
  scopeOrgUnitId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'OrgUnit',
    default: null,
    immutable: true
  },
  status: {
    type: String,
    enum: Object.values(IMPORT_JOB_STATUSES),
    required: true,
    default: IMPORT_JOB_STATUSES.PREVIEW_READY
  },
  totalRows: { type: Number, required: true, min: 0 },
  validRows: { type: Number, required: true, min: 0 },
  warningRows: { type: Number, required: true, min: 0 },
  errorRows: { type: Number, required: true, min: 0 },
  skippedRows: { type: Number, required: true, min: 0, default: 0 },
  publishedRows: { type: Number, required: true, min: 0, default: 0 },
  stagedRows: { type: [stagedRowSchema], required: true },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    immutable: true
  },
  confirmedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  confirmedAt: { type: Date, default: null },
  publishedAt: { type: Date, default: null },
  cancelledBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  cancelledAt: { type: Date, default: null },
  cancelReason: { type: String, maxlength: 2000, default: null },
  expiredAt: { type: Date, default: null },
  stagingCleanupStatus: {
    type: String,
    enum: Object.values(IMPORT_STAGING_CLEANUP_STATUSES),
    default: IMPORT_STAGING_CLEANUP_STATUSES.PENDING
  },
  stagingCleanupAttempts: { type: Number, min: 0, default: 0 },
  stagingCleanupLastAttemptAt: { type: Date, default: null },
  stagingCleanupCompletedAt: { type: Date, default: null },
  stagingCleanupLastError: { type: String, maxlength: 1000, default: null }
}, {
  timestamps: true,
  strict: 'throw',
  optimisticConcurrency: true,
  collection: 'import_jobs'
});

importJobSchema.pre('validate', function validateScopeAndCounts(next) {
  if (this.dataScope === 'ORG_UNIT' && !this.scopeOrgUnitId) {
    this.invalidate('scopeOrgUnitId', 'ORG_UNIT imports require scopeOrgUnitId');
  }
  if (this.dataScope === 'TEAM' && this.scopeOrgUnitId) {
    this.invalidate('scopeOrgUnitId', 'TEAM imports cannot set scopeOrgUnitId');
  }
  if (this.totalRows !== this.validRows + this.warningRows + this.errorRows) {
    this.invalidate('totalRows', 'Import row counters must add up to totalRows');
  }
  if (this.stagedRows.length !== this.totalRows) {
    this.invalidate('stagedRows', 'Every import row must be staged');
  }
  if (this.status === IMPORT_JOB_STATUSES.PREVIEW_READY) {
    if (this.publishedRows !== 0 || this.skippedRows !== 0) {
      this.invalidate('status', 'A preview cannot contain published or skipped rows');
    }
    if (
      this.confirmedBy || this.confirmedAt || this.publishedAt ||
      this.cancelledBy || this.cancelledAt || this.cancelReason || this.expiredAt
    ) {
      this.invalidate('status', 'A preview cannot contain confirmation metadata');
    }
  }
  if (this.status === IMPORT_JOB_STATUSES.PUBLISHED) {
    if (this.publishedRows + this.skippedRows !== this.totalRows) {
      this.invalidate('status', 'Published and skipped rows must account for every staged row');
    }
    if (!this.confirmedBy || !this.confirmedAt || !this.publishedAt) {
      this.invalidate('status', 'A published import requires confirmation metadata');
    }
    if (this.cancelledBy || this.cancelledAt || this.cancelReason || this.expiredAt) {
      this.invalidate('status', 'A published import cannot contain cancellation metadata');
    }
  }
  if (this.status === IMPORT_JOB_STATUSES.CANCELLED) {
    if (this.publishedRows !== 0 || this.skippedRows !== 0) {
      this.invalidate('status', 'A cancelled import cannot contain published or skipped rows');
    }
    if (this.confirmedBy || this.confirmedAt || this.publishedAt) {
      this.invalidate('status', 'A cancelled import cannot contain publication metadata');
    }
    if (!this.cancelledBy || !this.cancelledAt || !this.cancelReason) {
      this.invalidate('status', 'A cancelled import requires cancellation metadata');
    }
    if (this.expiredAt) this.invalidate('expiredAt', 'A cancelled import cannot be expired');
  }
  if (this.status === IMPORT_JOB_STATUSES.EXPIRED) {
    if (this.publishedRows !== 0 || this.skippedRows !== 0) {
      this.invalidate('status', 'An expired import cannot contain published or skipped rows');
    }
    if (
      this.confirmedBy || this.confirmedAt || this.publishedAt ||
      this.cancelledBy || this.cancelledAt || this.cancelReason
    ) {
      this.invalidate('status', 'An expired import cannot contain publication or cancellation metadata');
    }
    if (!this.expiredAt) this.invalidate('expiredAt', 'An expired import requires expiredAt');
  }
  if (this.stagingCleanupStatus === IMPORT_STAGING_CLEANUP_STATUSES.COMPLETE) {
    if (!this.stagingCleanupCompletedAt || this.stagingCleanupLastError) {
      this.invalidate('stagingCleanupStatus', 'Completed cleanup requires completion metadata');
    }
  } else if (this.stagingCleanupCompletedAt) {
    this.invalidate('stagingCleanupCompletedAt', 'Only completed cleanup has a completion timestamp');
  }
  next();
});

importJobSchema.index(
  { teamId: 1, type: 1, createdAt: -1 },
  { name: 'ix_import_job_team_type_created' }
);
importJobSchema.index(
  { teamId: 1, scopeOrgUnitId: 1, status: 1, createdAt: -1 },
  { name: 'ix_import_job_scope_status_created' }
);
importJobSchema.index(
  { teamId: 1, sourceSha256: 1, createdAt: -1 },
  { name: 'ix_import_job_team_source_hash_created' }
);
importJobSchema.index(
  { type: 1, status: 1, createdAt: 1 },
  { name: 'ix_import_job_type_status_created' }
);

const ImportJob = mongoose.model('ImportJob', importJobSchema);

module.exports = ImportJob;
module.exports.IMPORT_JOB_STATUSES = IMPORT_JOB_STATUSES;
module.exports.IMPORT_ROW_STATUSES = IMPORT_ROW_STATUSES;
module.exports.IMPORT_STAGING_CLEANUP_STATUSES = IMPORT_STAGING_CLEANUP_STATUSES;
module.exports.IMPORT_TYPES = IMPORT_TYPES;
