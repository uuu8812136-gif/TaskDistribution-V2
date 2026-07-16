'use strict';

const mongoose = require('mongoose');

const IMPORT_EXCEPTION_SEVERITIES = Object.freeze({
  WARNING: 'WARNING',
  ERROR: 'ERROR'
});

const IMPORT_EXCEPTION_STATUSES = Object.freeze({
  PENDING: 'PENDING',
  RESOLVED: 'RESOLVED',
  SKIPPED: 'SKIPPED'
});

const IMPORT_CUSTOMER_DECISIONS = Object.freeze({
  ACCEPT_AS_IS: 'ACCEPT_AS_IS',
  ACCEPT_SUGGESTION: 'ACCEPT_SUGGESTION',
  USE_RESOLVED_VALUE: 'USE_RESOLVED_VALUE',
  SKIP_ROW: 'SKIP_ROW'
});

const importExceptionSchema = new mongoose.Schema({
  teamId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ProjectTeam',
    required: true,
    immutable: true
  },
  importJobId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ImportJob',
    required: true,
    immutable: true
  },
  importRowId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    immutable: true
  },
  orgUnitId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'OrgUnit',
    default: null,
    immutable: true
  },
  sheetName: { type: String, required: true, maxlength: 100, immutable: true },
  rowNumber: { type: Number, required: true, min: 1, immutable: true },
  assetCode: { type: String, maxlength: 500, default: '', immutable: true },
  field: { type: String, required: true, maxlength: 100, immutable: true },
  exceptionType: { type: String, required: true, maxlength: 100, immutable: true },
  severity: {
    type: String,
    enum: Object.values(IMPORT_EXCEPTION_SEVERITIES),
    required: true,
    immutable: true
  },
  originalValue: { type: mongoose.Schema.Types.Mixed, default: null, immutable: true },
  suggestedAction: { type: String, maxlength: 1000, default: '', immutable: true },
  hasSuggestedValue: { type: Boolean, required: true, default: false, immutable: true },
  suggestedValue: { type: mongoose.Schema.Types.Mixed, default: null, immutable: true },
  customerDecision: {
    type: String,
    enum: Object.values(IMPORT_CUSTOMER_DECISIONS),
    default: null
  },
  resolvedValue: { type: mongoose.Schema.Types.Mixed, default: null },
  status: {
    type: String,
    enum: Object.values(IMPORT_EXCEPTION_STATUSES),
    required: true,
    default: IMPORT_EXCEPTION_STATUSES.PENDING
  },
  resolvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  resolvedAt: { type: Date, default: null }
}, {
  timestamps: true,
  strict: 'throw',
  optimisticConcurrency: true,
  collection: 'import_exceptions'
});

importExceptionSchema.pre('validate', function validateResolution(next) {
  const pending = this.status === IMPORT_EXCEPTION_STATUSES.PENDING;
  if (pending && (this.customerDecision || this.resolvedBy || this.resolvedAt)) {
    this.invalidate('status', 'Pending exceptions cannot contain a customer decision');
  }
  if (!pending && (!this.customerDecision || !this.resolvedBy || !this.resolvedAt)) {
    this.invalidate('status', 'Resolved exceptions require decision metadata');
  }
  next();
});

importExceptionSchema.index(
  { teamId: 1, importJobId: 1, sheetName: 1, rowNumber: 1, createdAt: 1 },
  { name: 'ix_import_exception_job_source_row' }
);
importExceptionSchema.index(
  { teamId: 1, importJobId: 1, importRowId: 1, field: 1, exceptionType: 1 },
  { unique: true, name: 'uq_import_exception_row_field_type' }
);
importExceptionSchema.index(
  { teamId: 1, orgUnitId: 1, status: 1, createdAt: -1 },
  { name: 'ix_import_exception_scope_status_created' }
);

const ImportException = mongoose.model('ImportException', importExceptionSchema);

module.exports = ImportException;
module.exports.IMPORT_CUSTOMER_DECISIONS = IMPORT_CUSTOMER_DECISIONS;
module.exports.IMPORT_EXCEPTION_SEVERITIES = IMPORT_EXCEPTION_SEVERITIES;
module.exports.IMPORT_EXCEPTION_STATUSES = IMPORT_EXCEPTION_STATUSES;
