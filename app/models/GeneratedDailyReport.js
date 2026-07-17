'use strict';

const mongoose = require('mongoose');
const { isNaturalDate } = require('../services/reportCalendarService');

const MAX_REPORT_VERSIONS = 50;
const MAX_SOURCE_SNAPSHOT_BYTES = 180 * 1024;
const MAX_REPORT_DOCUMENT_JSON_BYTES = 12 * 1024 * 1024;

function byteLength(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

const priorVersionSchema = new mongoose.Schema({
  version: { type: Number, required: true, min: 1, max: MAX_REPORT_VERSIONS },
  finalText: { type: String, required: true, maxlength: 20000 },
  sourceFingerprint: {
    type: String,
    required: true,
    lowercase: true,
    match: /^[a-f0-9]{64}$/
  },
  sourceSnapshot: {
    type: mongoose.Schema.Types.Mixed,
    required: true,
    validate: {
      validator: (value) => byteLength(value) <= MAX_SOURCE_SNAPSHOT_BYTES,
      message: 'sourceSnapshot exceeds the 180 KB per-version limit'
    }
  },
  ruleVersion: { type: String, required: true, maxlength: 100 },
  generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  generatedByName: { type: String, required: true, maxlength: 200 },
  generatedAt: { type: Date, required: true }
}, { _id: false, strict: 'throw' });

const generatedDailyReportSchema = new mongoose.Schema({
  teamId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ProjectTeam',
    required: true,
    immutable: true
  },
  reportDate: {
    type: String,
    required: true,
    immutable: true,
    validate: {
      validator: isNaturalDate,
      message: 'reportDate must be a real calendar date in YYYY-MM-DD format'
    }
  },
  version: { type: Number, required: true, min: 1, max: MAX_REPORT_VERSIONS },
  finalText: { type: String, required: true, maxlength: 20000 },
  sourceFingerprint: {
    type: String,
    required: true,
    lowercase: true,
    match: /^[a-f0-9]{64}$/
  },
  sourceSnapshot: {
    type: mongoose.Schema.Types.Mixed,
    required: true,
    validate: {
      validator: (value) => byteLength(value) <= MAX_SOURCE_SNAPSHOT_BYTES,
      message: 'sourceSnapshot exceeds the 180 KB per-version limit'
    }
  },
  ruleVersion: { type: String, required: true, maxlength: 100 },
  generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  generatedByName: { type: String, required: true, maxlength: 200 },
  generatedAt: { type: Date, required: true },
  versions: {
    type: [priorVersionSchema],
    default: [],
    validate: {
      validator: (values) => values.length < MAX_REPORT_VERSIONS,
      message: `versions cannot contain more than ${MAX_REPORT_VERSIONS - 1} prior versions`
    }
  }
}, {
  timestamps: true,
  strict: 'throw',
  optimisticConcurrency: true
});

generatedDailyReportSchema.pre('validate', function validateVersionHistory(next) {
  const prior = this.versions || [];
  const sequential = prior.every((entry, index) => entry.version === index + 1);
  if (!sequential || this.version !== prior.length + 1) {
    this.invalidate('version', 'version history must be sequential and end at the current version');
  }
  if (byteLength(this.toObject({ depopulate: true })) > MAX_REPORT_DOCUMENT_JSON_BYTES) {
    this.invalidate('versions', 'generated daily report reached the 12 MB document safety limit');
  }
  next();
});

generatedDailyReportSchema.index(
  { teamId: 1, reportDate: 1 },
  { unique: true, name: 'uq_generated_daily_report_team_date' }
);
generatedDailyReportSchema.index(
  { teamId: 1, reportDate: -1 },
  { name: 'ix_generated_daily_report_team_date' }
);

const GeneratedDailyReport = mongoose.model(
  'GeneratedDailyReport',
  generatedDailyReportSchema
);

module.exports = GeneratedDailyReport;
module.exports.MAX_REPORT_VERSIONS = MAX_REPORT_VERSIONS;
module.exports.MAX_SOURCE_SNAPSHOT_BYTES = MAX_SOURCE_SNAPSHOT_BYTES;
