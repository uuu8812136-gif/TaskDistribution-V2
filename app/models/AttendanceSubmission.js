'use strict';

const mongoose = require('mongoose');
const { isNaturalDate } = require('../services/reportCalendarService');

const ATTENDANCE_QUALITY_STATUSES = Object.freeze({
  CONFIRMED: 'CONFIRMED',
  PENDING_CONFIRMATION: 'PENDING_CONFIRMATION'
});
const ATTENDANCE_QUALITY_STATUS_VALUES = Object.freeze(
  Object.values(ATTENDANCE_QUALITY_STATUSES)
);

const ATTENDANCE_REVIEW_STATUSES = Object.freeze({
  PENDING_REVIEW: 'PENDING_REVIEW',
  REVIEWED: 'REVIEWED'
});
const ATTENDANCE_REVIEW_STATUS_VALUES = Object.freeze(
  Object.values(ATTENDANCE_REVIEW_STATUSES)
);

const ATTENDANCE_SOURCE_TYPES = Object.freeze({
  MANUAL: 'MANUAL',
  EXCEL_IMPORT: 'EXCEL_IMPORT'
});
const ATTENDANCE_SOURCE_TYPE_VALUES = Object.freeze(
  Object.values(ATTENDANCE_SOURCE_TYPES)
);

function quantityField() {
  return {
    type: Number,
    required: true,
    default: 0,
    min: 0,
    max: 2147483647,
    validate: {
      validator: Number.isInteger,
      message: 'attendance quantity must be a non-negative integer'
    }
  };
}

const namedQuantitySchema = new mongoose.Schema({
  count: quantityField(),
  names: {
    type: [{ type: String, trim: true, maxlength: 100 }],
    default: [],
    validate: [
      {
        validator: (values) => values.length <= 200,
        message: 'attendance names cannot contain more than 200 values'
      },
      {
        validator: (values) => new Set(values).size === values.length,
        message: 'attendance names must not contain duplicates'
      }
    ]
  }
}, { _id: false, strict: 'throw' });

const shiftSchema = new mongoose.Schema({
  actualAttendanceCount: quantityField(),
  leave: { type: namedQuantitySchema, required: true, default: () => ({}) },
  rest: { type: namedQuantitySchema, required: true, default: () => ({}) },
  sickLeave: { type: namedQuantitySchema, required: true, default: () => ({}) },
  absenteeism: { type: namedQuantitySchema, required: true, default: () => ({}) },
  notYetEmployed: { type: namedQuantitySchema, required: true, default: () => ({}) },
  pendingDeparture: { type: namedQuantitySchema, required: true, default: () => ({}) }
}, { _id: false, strict: 'throw' });

const supportSchema = new mongoose.Schema({
  destination: { type: String, trim: true, maxlength: 200, default: '' },
  count: quantityField(),
  names: {
    type: [{ type: String, trim: true, maxlength: 100 }],
    default: [],
    validate: {
      validator: (values) => new Set(values).size === values.length,
      message: 'support names must not contain duplicates'
    }
  }
}, { _id: false, strict: 'throw' });

const qualityIssueSchema = new mongoose.Schema({
  code: { type: String, required: true, trim: true, maxlength: 100 },
  message: { type: String, required: true, trim: true, maxlength: 1000 },
  sourceValue: { type: mongoose.Schema.Types.Mixed, default: null },
  calculatedValue: { type: mongoose.Schema.Types.Mixed, default: null },
  sourceReference: { type: String, trim: true, maxlength: 500, default: '' }
}, { _id: false, strict: 'throw' });

const sourceSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ATTENDANCE_SOURCE_TYPE_VALUES,
    required: true,
    default: ATTENDANCE_SOURCE_TYPES.MANUAL
  },
  fileName: { type: String, trim: true, maxlength: 300, default: '' },
  sheetName: { type: String, trim: true, maxlength: 100, default: '' },
  cellReference: { type: String, trim: true, maxlength: 50, default: '' },
  rawText: { type: String, maxlength: 10000, default: '' },
  importTag: { type: String, trim: true, maxlength: 200, default: '' },
  sourceSha256: {
    type: String,
    trim: true,
    lowercase: true,
    maxlength: 64,
    match: /^(?:[a-f0-9]{64})?$/,
    default: ''
  }
}, { _id: false, strict: 'throw' });

const attendanceSubmissionSchema = new mongoose.Schema({
  teamId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ProjectTeam',
    required: true,
    immutable: true
  },
  orgUnitId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'OrgUnit',
    required: true
  },
  reportDate: {
    type: String,
    required: true,
    validate: {
      validator: isNaturalDate,
      message: 'reportDate must be a real calendar date in YYYY-MM-DD format'
    }
  },
  authorizedHeadcount: quantityField(),
  registeredHeadcount: quantityField(),
  dayShift: { type: shiftSchema, required: true, default: () => ({}) },
  nightShift: { type: shiftSchema, required: true, default: () => ({}) },
  support: { type: supportSchema, required: true, default: () => ({}) },
  otherRemark: { type: String, trim: true, maxlength: 2000, default: '' },
  reviewStatus: {
    type: String,
    enum: ATTENDANCE_REVIEW_STATUS_VALUES,
    required: true,
    default: ATTENDANCE_REVIEW_STATUSES.PENDING_REVIEW
  },
  reviewedAt: { type: Date, default: null },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  dataQualityStatus: {
    type: String,
    enum: ATTENDANCE_QUALITY_STATUS_VALUES,
    required: true,
    default: ATTENDANCE_QUALITY_STATUSES.CONFIRMED
  },
  dataQualityIssues: { type: [qualityIssueSchema], default: [] },
  source: { type: sourceSchema, required: true, default: () => ({}) },
  submittedAt: { type: Date, required: true, default: Date.now },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    immutable: true
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true,
  strict: 'throw',
  optimisticConcurrency: true
});

attendanceSubmissionSchema.index(
  { teamId: 1, orgUnitId: 1, reportDate: 1 },
  { unique: true, name: 'uq_attendance_scope_org_date' }
);
attendanceSubmissionSchema.index(
  { teamId: 1, reportDate: -1, orgUnitId: 1 },
  { name: 'ix_attendance_team_date_org' }
);
attendanceSubmissionSchema.index(
  { teamId: 1, dataQualityStatus: 1, reportDate: -1 },
  { name: 'ix_attendance_quality_date' }
);

const AttendanceSubmission = mongoose.model(
  'AttendanceSubmission',
  attendanceSubmissionSchema
);

module.exports = AttendanceSubmission;
module.exports.ATTENDANCE_QUALITY_STATUSES = ATTENDANCE_QUALITY_STATUSES;
module.exports.ATTENDANCE_QUALITY_STATUS_VALUES = ATTENDANCE_QUALITY_STATUS_VALUES;
module.exports.ATTENDANCE_REVIEW_STATUSES = ATTENDANCE_REVIEW_STATUSES;
module.exports.ATTENDANCE_REVIEW_STATUS_VALUES = ATTENDANCE_REVIEW_STATUS_VALUES;
module.exports.ATTENDANCE_SOURCE_TYPES = ATTENDANCE_SOURCE_TYPES;
module.exports.ATTENDANCE_SOURCE_TYPE_VALUES = ATTENDANCE_SOURCE_TYPE_VALUES;
