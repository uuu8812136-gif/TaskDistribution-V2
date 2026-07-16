'use strict';

const mongoose = require('mongoose');
const EquipmentAsset = require('./EquipmentAsset');
const { DATA_SCOPE_VALUES } = require('../config/permissions');

const IMPORT_TYPES = Object.freeze({
  EQUIPMENT_ASSET: 'EQUIPMENT_ASSET'
});

const IMPORT_JOB_STATUSES = Object.freeze({
  PREVIEW_READY: 'PREVIEW_READY',
  PUBLISHED: 'PUBLISHED'
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
  name: { type: String, default: '' },
  categoryId: { type: mongoose.Schema.Types.ObjectId, default: null },
  categoryName: { type: String, default: '' },
  specification: { type: String, default: '' },
  manufacturer: { type: String, default: '' },
  quantity: { type: Number, default: 1 },
  unit: { type: String, default: '' },
  acquisitionDate: { type: Date, default: null },
  originalValue: { type: Number, default: null },
  orgUnitId: { type: mongoose.Schema.Types.ObjectId, default: null },
  orgUnitName: { type: String, default: '' },
  custodianUserId: { type: mongoose.Schema.Types.ObjectId, default: null },
  custodianName: { type: String, default: '' },
  location: { type: String, default: '' },
  status: {
    type: String,
    enum: EquipmentAsset.EQUIPMENT_STATUS_VALUES,
    default: EquipmentAsset.EQUIPMENT_STATUSES.IN_USE
  },
  remark: { type: String, default: '' }
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
  publishedAt: { type: Date, default: null }
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
    if (this.confirmedBy || this.confirmedAt || this.publishedAt) {
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

const ImportJob = mongoose.model('ImportJob', importJobSchema);

module.exports = ImportJob;
module.exports.IMPORT_JOB_STATUSES = IMPORT_JOB_STATUSES;
module.exports.IMPORT_ROW_STATUSES = IMPORT_ROW_STATUSES;
module.exports.IMPORT_TYPES = IMPORT_TYPES;
