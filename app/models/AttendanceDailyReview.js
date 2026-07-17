'use strict';

const mongoose = require('mongoose');
const { isNaturalDate } = require('../services/reportCalendarService');

const attendanceDailyReviewSchema = new mongoose.Schema({
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
  expectedOrgUnitIds: {
    type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'OrgUnit' }],
    required: true,
    immutable: true,
    validate: {
      validator: (values) => values.length > 0 && new Set(values.map(String)).size === values.length,
      message: 'expectedOrgUnitIds must contain unique organization units'
    }
  },
  submissionIds: {
    type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'AttendanceSubmission' }],
    required: true,
    immutable: true,
    validate: {
      validator: (values) => values.length > 0 && new Set(values.map(String)).size === values.length,
      message: 'submissionIds must contain unique attendance submissions'
    }
  },
  summarySnapshot: {
    type: mongoose.Schema.Types.Mixed,
    required: true,
    immutable: true
  },
  finalText: {
    type: String,
    required: true,
    maxlength: 20000,
    immutable: true
  },
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    immutable: true
  },
  reviewedAt: {
    type: Date,
    required: true,
    immutable: true
  }
}, {
  timestamps: true,
  strict: 'throw',
  optimisticConcurrency: true
});

function rejectMutation(next) {
  next(new Error('AttendanceDailyReview is permanent and append-only'));
}

attendanceDailyReviewSchema.pre('save', function rejectExistingSave(next) {
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
  attendanceDailyReviewSchema.pre(operation, rejectMutation);
}

attendanceDailyReviewSchema.pre(
  'deleteOne',
  { document: true, query: true },
  rejectMutation
);

attendanceDailyReviewSchema.index(
  { teamId: 1, reportDate: 1 },
  { unique: true, name: 'uq_attendance_daily_review_team_date' }
);
attendanceDailyReviewSchema.index(
  { teamId: 1, reviewedAt: -1 },
  { name: 'ix_attendance_daily_review_team_time' }
);

module.exports = mongoose.model('AttendanceDailyReview', attendanceDailyReviewSchema);
