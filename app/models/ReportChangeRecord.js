'use strict';

const mongoose = require('mongoose');
const { AUDIT_RESOURCE_TYPES } = require('../config/permissions');

const REPORT_CHANGE_TYPES = Object.freeze({
  CREATE: 'CREATE',
  UPDATE: 'UPDATE',
  DAILY_SCHEDULE_MAINTAIN: 'DAILY_SCHEDULE_MAINTAIN',
  MONTHLY_SCHEDULE_MAINTAIN: 'MONTHLY_SCHEDULE_MAINTAIN'
});
const REPORT_CHANGE_TYPE_VALUES = Object.freeze(Object.values(REPORT_CHANGE_TYPES));
const REPORT_RESOURCE_TYPE_VALUES = Object.freeze([
  AUDIT_RESOURCE_TYPES.TRANSPORT_RECORD,
  AUDIT_RESOURCE_TYPES.PRODUCTION_SCHEDULE
]);

const reportChangeRecordSchema = new mongoose.Schema({
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
  resourceType: {
    type: String,
    enum: REPORT_RESOURCE_TYPE_VALUES,
    required: true,
    immutable: true
  },
  resourceId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    immutable: true
  },
  changeType: {
    type: String,
    enum: REPORT_CHANGE_TYPE_VALUES,
    required: true,
    immutable: true
  },
  before: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
    immutable: true
  },
  after: {
    type: mongoose.Schema.Types.Mixed,
    required: true,
    immutable: true
  },
  operatorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    immutable: true
  },
  reason: {
    type: String,
    trim: true,
    maxlength: 2000,
    default: null,
    immutable: true
  },
  occurredAt: {
    type: Date,
    required: true,
    default: Date.now,
    immutable: true
  }
}, {
  timestamps: false,
  strict: 'throw',
  versionKey: false
});

function rejectMutation(next) {
  next(new Error('ReportChangeRecord is append-only'));
}

reportChangeRecordSchema.pre('save', function rejectExistingSave(next) {
  if (!this.isNew) return rejectMutation(next);
  return next();
});

for (const operation of [
  'updateOne',
  'updateMany',
  'replaceOne',
  'findOneAndUpdate',
  'findOneAndReplace',
  'findOneAndDelete',
  'deleteMany'
]) {
  reportChangeRecordSchema.pre(operation, rejectMutation);
}

reportChangeRecordSchema.pre(
  'deleteOne',
  { document: true, query: true },
  rejectMutation
);

reportChangeRecordSchema.pre('bulkWrite', function allowInsertOnly(next, operations) {
  if (operations.some((operation) => !operation.insertOne)) return rejectMutation(next);
  return next();
});

reportChangeRecordSchema.index(
  { teamId: 1, orgUnitId: 1, resourceType: 1, resourceId: 1, occurredAt: -1 },
  { name: 'ix_report_change_scope_resource_time' }
);
reportChangeRecordSchema.index(
  { teamId: 1, operatorId: 1, occurredAt: -1 },
  { name: 'ix_report_change_team_operator_time' }
);

const ReportChangeRecord = mongoose.model('ReportChangeRecord', reportChangeRecordSchema);

module.exports = ReportChangeRecord;
module.exports.REPORT_CHANGE_TYPES = REPORT_CHANGE_TYPES;
module.exports.REPORT_CHANGE_TYPE_VALUES = REPORT_CHANGE_TYPE_VALUES;
