'use strict';

const mongoose = require('mongoose');
const AttendanceDailyReview = require('../models/AttendanceDailyReview');
const AttendanceSubmission = require('../models/AttendanceSubmission');
const GeneratedDailyReport = require('../models/GeneratedDailyReport');
const ProjectTeam = require('../models/ProjectTeam');
const { AUDIT_ACTIONS, AUDIT_RESOURCE_TYPES, TEAM_STATUSES } = require('../config/permissions');
const { createAuditService } = require('./auditService');
const { runWithRequiredTransaction } = require('./transactionService');
const {
  liveCollectionInventory,
  snapshot,
  verifyExecutionBackup
} = require('./acceptanceJuly2026DataRepairService');

const CORRECTION_REPORT_FORMAT = 'attendance-planned-2026-07-27-correction/v1';
const ALLOWED_EXECUTION_DATABASE = 'customer_acceptance_v2_test';
const CORRECTION_REASON = 'Correct the verified 2026-07-27 planned-attendance formula in the locked attendance review text';
const TARGET = Object.freeze({
  teamCode: 'GEARBOX_LOGISTICS',
  reportDate: '2026-07-27',
  reviewId: '6a66b5700a362686bda6c1d5',
  submissionCount: 7,
  registeredHeadcount: 123,
  dayActualAttendance: 124,
  dayRest: 1,
  dayNotYetEmployed: 2,
  dayTemporaryWorker: 2,
  correctedDayPlanned: 126,
  correctedNightPlanned: 0,
  oldSentence: '今日白班安排出勤122人，夜班安排出勤0人。',
  correctedSentence: '今日白班安排出勤126人，夜班安排出勤0人。'
});

class AttendancePlannedCorrectionError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'AttendancePlannedCorrectionError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = null) {
  throw new AttendancePlannedCorrectionError(code, message, details);
}

function normalizeId(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') return value;
  if (typeof value.toHexString === 'function') return value.toHexString();
  if (value._id !== undefined) return normalizeId(value._id);
  return String(value);
}

function count(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function occurrenceCount(value, needle) {
  if (typeof value !== 'string' || !needle) return 0;
  return value.split(needle).length - 1;
}

function plannedAttendance(summary = {}, shiftName) {
  const shift = summary?.[shiftName] || {};
  const hasShiftData = count(shift.actualAttendanceCount) > 0 || [
    'leave',
    'rest',
    'sickLeave',
    'absenteeism',
    'notYetEmployed',
    'pendingDeparture',
    'temporaryWorker'
  ].some((field) => count(shift[field]?.count) > 0);
  if (!hasShiftData) return 0;
  return Math.max(
    0,
    count(summary.registeredHeadcount) -
      count(shift.rest?.count) +
      count(shift.notYetEmployed?.count) +
      count(shift.temporaryWorker?.count)
  );
}

function withSession(query, session) {
  return session && typeof query.session === 'function' ? query.session(session) : query;
}

async function findOne(Model, filter, session = null) {
  return withSession(Model.findOne(filter), session).lean();
}

async function findMany(Model, filter, session = null) {
  return withSession(Model.find(filter).sort({ _id: 1 }), session).lean();
}

function blocker(code, message, details = null) {
  return { code, message, details };
}

function databaseNameOf(connection) {
  return connection?.name || connection?.db?.databaseName || null;
}

function expectedSnapshotValues(summary = {}) {
  return {
    registeredHeadcount: count(summary.registeredHeadcount),
    dayActualAttendance: count(summary.dayShift?.actualAttendanceCount),
    dayRest: count(summary.dayShift?.rest?.count),
    dayNotYetEmployed: count(summary.dayShift?.notYetEmployed?.count),
    dayTemporaryWorker: count(summary.dayShift?.temporaryWorker?.count),
    correctedDayPlanned: plannedAttendance(summary, 'dayShift'),
    correctedNightPlanned: plannedAttendance(summary, 'nightShift')
  };
}

function expectedSnapshotMatches(values) {
  return [
    'registeredHeadcount',
    'dayActualAttendance',
    'dayRest',
    'dayNotYetEmployed',
    'dayTemporaryWorker',
    'correctedDayPlanned',
    'correctedNightPlanned'
  ].every((field) => values[field] === TARGET[field]);
}

function correctedFinalText(finalText) {
  if (
    occurrenceCount(finalText, TARGET.oldSentence) !== 1 ||
    occurrenceCount(finalText, TARGET.correctedSentence) !== 0
  ) return null;
  return finalText.replace(TARGET.oldSentence, TARGET.correctedSentence);
}

async function analyzeAttendancePlannedCorrection({
  AttendanceDailyReviewModel = AttendanceDailyReview,
  AttendanceSubmissionModel = AttendanceSubmission,
  GeneratedDailyReportModel = GeneratedDailyReport,
  ProjectTeamModel = ProjectTeam,
  session = null
} = {}) {
  const blockers = [];
  const team = await findOne(ProjectTeamModel, { code: TARGET.teamCode }, session);
  if (!team) {
    blockers.push(blocker('TARGET_TEAM_MISSING', 'The fixed GEARBOX_LOGISTICS team does not exist'));
  } else if (team.status !== TEAM_STATUSES.ACTIVE) {
    blockers.push(blocker('TARGET_TEAM_INACTIVE', 'The fixed GEARBOX_LOGISTICS team is not active'));
  }

  const teamId = team?._id || null;
  const review = await findOne(AttendanceDailyReviewModel, { _id: TARGET.reviewId }, session);
  const dateReviews = teamId
    ? await findMany(AttendanceDailyReviewModel, { teamId, reportDate: TARGET.reportDate }, session)
    : [];
  const submissions = teamId
    ? await findMany(AttendanceSubmissionModel, { teamId, reportDate: TARGET.reportDate }, session)
    : [];
  const generatedReports = teamId
    ? await findMany(GeneratedDailyReportModel, { teamId, reportDate: TARGET.reportDate }, session)
    : [];

  if (!review) {
    blockers.push(blocker('TARGET_REVIEW_MISSING', 'The fixed attendance review does not exist'));
  }
  if (dateReviews.length !== 1 || normalizeId(dateReviews[0]?._id) !== TARGET.reviewId) {
    blockers.push(blocker('TARGET_REVIEW_IDENTITY_MISMATCH', 'The team/date review does not match the fixed review ID', {
      reviewIds: dateReviews.map(({ _id }) => normalizeId(_id))
    }));
  }
  if (review && (
    normalizeId(review.teamId) !== normalizeId(teamId) ||
    review.reportDate !== TARGET.reportDate
  )) {
    blockers.push(blocker('TARGET_REVIEW_SCOPE_MISMATCH', 'The fixed review is outside the fixed team/date scope'));
  }
  if (submissions.length !== TARGET.submissionCount) {
    blockers.push(blocker('SOURCE_SUBMISSION_COUNT_MISMATCH', 'The fixed date must retain exactly seven source submissions', {
      expected: TARGET.submissionCount,
      actual: submissions.length
    }));
  }
  const reviewSubmissionIds = new Set((review?.submissionIds || []).map(normalizeId));
  const sourceSubmissionIds = submissions.map(({ _id }) => normalizeId(_id));
  if (
    reviewSubmissionIds.size !== TARGET.submissionCount ||
    sourceSubmissionIds.some((id) => !reviewSubmissionIds.has(id))
  ) {
    blockers.push(blocker('SOURCE_SUBMISSION_IDS_MISMATCH', 'The locked review source IDs no longer match the seven submissions'));
  }
  if (generatedReports.length !== 0) {
    blockers.push(blocker('GENERATED_DAILY_REPORT_EXISTS', 'The fixed date already has a generated daily report', {
      reportIds: generatedReports.map(({ _id }) => normalizeId(_id))
    }));
  }

  const snapshotValues = expectedSnapshotValues(review?.summarySnapshot);
  if (review && !expectedSnapshotMatches(snapshotValues)) {
    blockers.push(blocker('SUMMARY_SNAPSHOT_MISMATCH', 'The locked summary no longer matches the verified 123-1+2+2=126 source state', {
      expected: expectedSnapshotValues({
        registeredHeadcount: TARGET.registeredHeadcount,
        dayShift: {
          actualAttendanceCount: TARGET.dayActualAttendance,
          rest: { count: TARGET.dayRest },
          notYetEmployed: { count: TARGET.dayNotYetEmployed },
          temporaryWorker: { count: TARGET.dayTemporaryWorker }
        }
      }),
      actual: snapshotValues
    }));
  }

  let state = 'BLOCKED';
  let targetFinalText = null;
  if (review) {
    const oldOccurrences = occurrenceCount(review.finalText, TARGET.oldSentence);
    const correctedOccurrences = occurrenceCount(review.finalText, TARGET.correctedSentence);
    if (oldOccurrences === 1 && correctedOccurrences === 0) {
      state = 'READY';
      targetFinalText = correctedFinalText(review.finalText);
    } else if (oldOccurrences === 0 && correctedOccurrences === 1) {
      state = 'ALREADY_APPLIED';
      targetFinalText = review.finalText;
    } else {
      blockers.push(blocker('FINAL_TEXT_MISMATCH', 'The complete locked finalText does not contain exactly one known old or corrected sentence', {
        oldOccurrences,
        correctedOccurrences,
        finalTextSha256: snapshot(review.finalText).sha256
      }));
    }
  }
  if (blockers.length > 0) state = 'BLOCKED';

  return {
    state,
    blockers,
    operations: state === 'READY' ? [{
      type: 'CORRECT_LOCKED_ATTENDANCE_FINAL_TEXT',
      reviewId: TARGET.reviewId,
      reportDate: TARGET.reportDate,
      beforeSentence: TARGET.oldSentence,
      afterSentence: TARGET.correctedSentence
    }] : [],
    target: {
      teamId: normalizeId(teamId),
      teamCode: TARGET.teamCode,
      reportDate: TARGET.reportDate,
      reviewId: TARGET.reviewId,
      snapshotValues,
      sourceSubmissionCount: submissions.length,
      sourceSubmissionIds,
      generatedDailyReportCount: generatedReports.length
    },
    documents: {
      review,
      submissions,
      targetFinalText
    }
  };
}

function reportAnalysis(analysis) {
  return {
    state: analysis.state,
    blockerCount: analysis.blockers.length,
    blockers: analysis.blockers,
    plannedWriteCount: analysis.operations.length,
    plannedAuditCount: analysis.operations.length,
    operations: analysis.operations,
    target: analysis.target,
    evidence: {
      review: analysis.documents.review ? snapshot(analysis.documents.review) : null,
      sourceSubmissions: snapshot(analysis.documents.submissions),
      targetFinalText: analysis.documents.targetFinalText
        ? snapshot(analysis.documents.targetFinalText)
        : null
    }
  };
}

function newestTargetInstant(analysis) {
  const review = analysis.documents.review;
  const value = review?.updatedAt || review?.reviewedAt || review?.createdAt;
  const parsed = value instanceof Date ? value : new Date(value || Number.NaN);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function createAttendancePlannedCorrectionService({
  connection = mongoose.connection,
  AttendanceDailyReviewModel = AttendanceDailyReview,
  AttendanceSubmissionModel = AttendanceSubmission,
  GeneratedDailyReportModel = GeneratedDailyReport,
  ProjectTeamModel = ProjectTeam,
  auditService = createAuditService(),
  backupVerifier,
  transactionRunner = runWithRequiredTransaction,
  now = () => new Date(),
  allowedExecutionDatabaseNames = [ALLOWED_EXECUTION_DATABASE]
} = {}) {
  if (!connection?.db) throw new TypeError('A connected Mongoose connection is required');
  const allowedDatabases = new Set(allowedExecutionDatabaseNames);
  const dependencies = {
    AttendanceDailyReviewModel,
    AttendanceSubmissionModel,
    GeneratedDailyReportModel,
    ProjectTeamModel
  };

  async function analyze(session = null) {
    return analyzeAttendancePlannedCorrection({ ...dependencies, session });
  }

  async function run({ execute = false, confirmDatabase, backupDirectory } = {}) {
    const databaseName = databaseNameOf(connection);
    if (!databaseName) fail('DATABASE_NAME_MISSING', 'The connected database name is unavailable');
    if (execute && confirmDatabase !== databaseName) {
      fail('DATABASE_CONFIRMATION_MISMATCH', '--confirm-database must exactly match the connected database name', {
        expected: databaseName,
        actual: confirmDatabase || null
      });
    }
    if (execute && !allowedDatabases.has(databaseName)) {
      fail('EXECUTION_DATABASE_FORBIDDEN', 'Execution is restricted to the acceptance database allowlist', {
        actual: databaseName,
        allowed: [...allowedDatabases].sort()
      });
    }

    const preview = await analyze();
    const base = {
      format: CORRECTION_REPORT_FORMAT,
      generatedAt: now().toISOString(),
      mode: execute ? 'execute' : 'dry-run',
      database: { name: databaseName },
      backup: null,
      before: reportAnalysis(preview),
      writePerformed: false,
      dataWrites: 0,
      auditLogsCreated: 0
    };
    if (!execute) {
      return {
        ...base,
        status: preview.blockers.length > 0
          ? 'DRY_RUN_BLOCKED'
          : preview.operations.length > 0
            ? 'DRY_RUN_READY'
            : 'DRY_RUN_NO_CHANGES',
        after: null
      };
    }
    if (preview.blockers.length > 0) return { ...base, status: 'BLOCKED', after: null };
    if (preview.operations.length === 0) {
      return { ...base, status: 'NO_CHANGES', after: reportAnalysis(preview) };
    }
    if (typeof backupVerifier !== 'function') {
      fail('BACKUP_VERIFIER_REQUIRED', 'A complete backup verifier is required in execute mode');
    }

    const backup = await verifyExecutionBackup({
      backupDirectory,
      databaseName,
      backupVerifier,
      liveCollections: await liveCollectionInventory(connection),
      minimumCompletedAt: newestTargetInstant(preview)
    });

    return transactionRunner(async (session) => {
      const before = await analyze(session);
      if (before.blockers.length > 0 || before.state !== 'READY' || before.operations.length !== 1) {
        fail('TARGET_STATE_CHANGED_BEFORE_EXECUTION', 'The fixed review or its source records changed after backup verification', {
          before: reportAnalysis(before),
          writePerformed: false,
          transactionRolledBack: true
        });
      }

      const review = before.documents.review;
      const correctedAt = now();
      const correctedReview = {
        ...review,
        finalText: before.documents.targetFinalText,
        updatedAt: correctedAt,
        __v: (review.__v ?? 0) + 1
      };
      const result = await AttendanceDailyReviewModel.collection.updateOne({
        _id: review._id,
        teamId: review.teamId,
        reportDate: TARGET.reportDate,
        finalText: review.finalText,
        __v: review.__v ?? 0
      }, {
        $set: {
          finalText: correctedReview.finalText,
          updatedAt: correctedAt
        },
        $inc: { __v: 1 }
      }, { session });
      if (result.matchedCount !== 1 || result.modifiedCount !== 1) {
        fail('TARGET_REVIEW_CHANGED', 'The complete locked review changed during correction');
      }

      await auditService.recordSystem({
        action: AUDIT_ACTIONS.CORRECT,
        resourceType: AUDIT_RESOURCE_TYPES.ATTENDANCE_REVIEW,
        resourceId: review._id,
        before: snapshot(review),
        after: snapshot(correctedReview),
        reason: CORRECTION_REASON,
        targetTeamId: review.teamId,
        session
      });

      const after = await analyze(session);
      if (after.blockers.length > 0 || after.state !== 'ALREADY_APPLIED' || after.operations.length !== 0) {
        fail('CORRECTION_POSTCONDITION_FAILED', 'The correction did not reach the exact idempotent target state', {
          before: reportAnalysis(before),
          after: reportAnalysis(after),
          writePerformed: false,
          transactionRolledBack: true
        });
      }
      if (
        reportAnalysis(before).evidence.sourceSubmissions.sha256 !==
        reportAnalysis(after).evidence.sourceSubmissions.sha256
      ) {
        fail('SOURCE_SUBMISSIONS_CHANGED', 'Source attendance submissions changed during correction');
      }
      return {
        ...base,
        generatedAt: now().toISOString(),
        status: 'EXECUTED',
        backup,
        before: reportAnalysis(before),
        after: reportAnalysis(after),
        writePerformed: true,
        dataWrites: 1,
        auditLogsCreated: 1
      };
    }, connection, {
      code: 'ATTENDANCE_PLANNED_CORRECTION_TRANSACTIONS_REQUIRED',
      message: 'Attendance planned correction requires MongoDB replica-set transaction support'
    });
  }

  return Object.freeze({ analyze, run });
}

module.exports = {
  ALLOWED_EXECUTION_DATABASE,
  AttendancePlannedCorrectionError,
  CORRECTION_REASON,
  CORRECTION_REPORT_FORMAT,
  TARGET,
  analyzeAttendancePlannedCorrection,
  correctedFinalText,
  createAttendancePlannedCorrectionService,
  expectedSnapshotValues,
  occurrenceCount,
  plannedAttendance,
  reportAnalysis
};
