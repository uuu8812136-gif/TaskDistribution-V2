'use strict';

const mongoose = require('mongoose');
const AttendanceDailyReview = require('../models/AttendanceDailyReview');
const AttendanceSubmission = require('../models/AttendanceSubmission');
const GeneratedDailyReport = require('../models/GeneratedDailyReport');
const ProductionSchedule = require('../models/ProductionSchedule');
const ProjectTeam = require('../models/ProjectTeam');
const { AUDIT_ACTIONS, AUDIT_RESOURCE_TYPES, TEAM_STATUSES } = require('../config/permissions');
const { createAuditService } = require('./auditService');
const { runWithRequiredTransaction } = require('./transactionService');
const {
  liveCollectionInventory,
  snapshot,
  verifyExecutionBackup
} = require('./acceptanceJuly2026DataRepairService');

const CORRECTION_REPORT_FORMAT = 'attendance-production-cumulative-2026-08-06-correction/v1';
const ALLOWED_EXECUTION_DATABASE = 'customer_acceptance_v2_test';
const CORRECTION_REASON =
  'Correct the verified 2026-08-06 cumulative production period in the locked attendance review text';
const MONTHLY_TOTAL_FIELDS = Object.freeze([
  'aLine',
  'northLine',
  'transferCaseLine',
  'bLineDay',
  'bLineNight'
]);
const TARGET = Object.freeze({
  teamCode: 'GEARBOX_LOGISTICS',
  reportDate: '2026-08-06',
  reviewId: '6a73db77f49ec77bbc86dca0',
  submissionCount: 7,
  previousYear: 2025,
  currentYear: 2026,
  cumulativeEndMonth: 7,
  previousYearFirstHalfTotal: 53200,
  currentYearFirstHalfTotal: 84407,
  previousYearJulyTotal: 10910,
  currentYearJulyTotal: 11730,
  previousYearCumulativeTotal: 64110,
  currentYearCumulativeTotal: 96137,
  oldLine: '4.2025年1-6月实际生产53200台，2026年1-6月实际生产84407台。',
  correctedLine: '4.2025年1-7月实际生产64110台，2026年1-7月实际生产96137台。'
});

class AttendanceProductionCumulativeCorrectionError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'AttendanceProductionCumulativeCorrectionError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = null) {
  throw new AttendanceProductionCumulativeCorrectionError(code, message, details);
}

function normalizeId(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') return value;
  if (typeof value.toHexString === 'function') return value.toHexString();
  if (value._id !== undefined) return normalizeId(value._id);
  return String(value);
}

function occurrenceCount(value, needle) {
  if (typeof value !== 'string' || !needle) return 0;
  return value.split(needle).length - 1;
}

function correctedFinalText(finalText) {
  if (
    occurrenceCount(finalText, TARGET.oldLine) !== 1 ||
    occurrenceCount(finalText, TARGET.correctedLine) !== 0
  ) return null;
  return finalText.replace(TARGET.oldLine, TARGET.correctedLine);
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

function expectedMonths(year) {
  return Array.from({ length: TARGET.cumulativeEndMonth }, (_, index) => (
    `${year}-${String(index + 1).padStart(2, '0')}`
  ));
}

function monthlyTotal(schedule = {}) {
  return MONTHLY_TOTAL_FIELDS.reduce(
    (total, field) => total + (Number(schedule.monthlyTotals?.[field]) || 0),
    0
  );
}

function productionYearEvidence(schedules, year) {
  const months = expectedMonths(year);
  const byMonth = new Map(schedules.map((schedule) => [schedule.month, schedule]));
  const rows = months.map((month) => ({
    month,
    total: byMonth.has(month) ? monthlyTotal(byMonth.get(month)) : null
  }));
  return {
    year,
    months: rows,
    firstHalfTotal: rows.slice(0, 6).reduce((total, row) => total + (row.total || 0), 0),
    julyTotal: rows[6]?.total ?? null,
    cumulativeTotal: rows.reduce((total, row) => total + (row.total || 0), 0)
  };
}

function productionEvidenceMatches(previous, current) {
  return (
    previous.months.every(({ total }) => total !== null) &&
    current.months.every(({ total }) => total !== null) &&
    previous.firstHalfTotal === TARGET.previousYearFirstHalfTotal &&
    current.firstHalfTotal === TARGET.currentYearFirstHalfTotal &&
    previous.julyTotal === TARGET.previousYearJulyTotal &&
    current.julyTotal === TARGET.currentYearJulyTotal &&
    previous.cumulativeTotal === TARGET.previousYearCumulativeTotal &&
    current.cumulativeTotal === TARGET.currentYearCumulativeTotal
  );
}

async function analyzeAttendanceProductionCumulativeCorrection({
  AttendanceDailyReviewModel = AttendanceDailyReview,
  AttendanceSubmissionModel = AttendanceSubmission,
  GeneratedDailyReportModel = GeneratedDailyReport,
  ProductionScheduleModel = ProductionSchedule,
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
  const requiredMonths = [
    ...expectedMonths(TARGET.previousYear),
    ...expectedMonths(TARGET.currentYear)
  ];
  const productionSchedules = teamId
    ? await findMany(ProductionScheduleModel, { teamId, month: { $in: requiredMonths } }, session)
    : [];

  if (!review) {
    blockers.push(blocker('TARGET_REVIEW_MISSING', 'The fixed attendance review does not exist'));
  }
  if (dateReviews.length !== 1 || normalizeId(dateReviews[0]?._id) !== TARGET.reviewId) {
    blockers.push(blocker(
      'TARGET_REVIEW_IDENTITY_MISMATCH',
      'The team/date review does not match the fixed review ID',
      { reviewIds: dateReviews.map(({ _id }) => normalizeId(_id)) }
    ));
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

  const scheduleMonths = productionSchedules.map(({ month }) => month);
  if (
    productionSchedules.length !== requiredMonths.length ||
    new Set(scheduleMonths).size !== requiredMonths.length ||
    requiredMonths.some((month) => !scheduleMonths.includes(month))
  ) {
    blockers.push(blocker('PRODUCTION_SCHEDULE_SET_MISMATCH', 'The fixed cumulative period must contain exactly fourteen monthly schedules', {
      expectedMonths: requiredMonths,
      actualMonths: scheduleMonths
    }));
  }
  const previousProduction = productionYearEvidence(productionSchedules, TARGET.previousYear);
  const currentProduction = productionYearEvidence(productionSchedules, TARGET.currentYear);
  if (!productionEvidenceMatches(previousProduction, currentProduction)) {
    blockers.push(blocker('PRODUCTION_TOTALS_MISMATCH', 'The maintained January-July production totals no longer match the verified source values', {
      previousProduction,
      currentProduction
    }));
  }

  let state = 'BLOCKED';
  let targetFinalText = null;
  if (review) {
    const oldOccurrences = occurrenceCount(review.finalText, TARGET.oldLine);
    const correctedOccurrences = occurrenceCount(review.finalText, TARGET.correctedLine);
    if (oldOccurrences === 1 && correctedOccurrences === 0) {
      state = 'READY';
      targetFinalText = correctedFinalText(review.finalText);
    } else if (oldOccurrences === 0 && correctedOccurrences === 1) {
      state = 'ALREADY_APPLIED';
      targetFinalText = review.finalText;
    } else {
      blockers.push(blocker('FINAL_TEXT_MISMATCH', 'The complete locked finalText does not contain exactly one known old or corrected line', {
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
      type: 'CORRECT_LOCKED_ATTENDANCE_CUMULATIVE_PRODUCTION_TEXT',
      reviewId: TARGET.reviewId,
      reportDate: TARGET.reportDate,
      beforeLine: TARGET.oldLine,
      afterLine: TARGET.correctedLine
    }] : [],
    target: {
      teamId: normalizeId(teamId),
      teamCode: TARGET.teamCode,
      reportDate: TARGET.reportDate,
      reviewId: TARGET.reviewId,
      sourceSubmissionCount: submissions.length,
      sourceSubmissionIds,
      generatedDailyReportCount: generatedReports.length,
      previousProduction,
      currentProduction
    },
    documents: {
      review,
      submissions,
      productionSchedules,
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
      summarySnapshot: analysis.documents.review
        ? snapshot(analysis.documents.review.summarySnapshot)
        : null,
      sourceSubmissions: snapshot(analysis.documents.submissions),
      productionSchedules: snapshot(analysis.documents.productionSchedules),
      targetFinalText: analysis.documents.targetFinalText
        ? snapshot(analysis.documents.targetFinalText)
        : null
    }
  };
}

function newestTargetInstant(analysis) {
  const documents = [
    analysis.documents.review,
    ...analysis.documents.submissions,
    ...analysis.documents.productionSchedules
  ];
  return documents.reduce((newest, document) => {
    const parsed = new Date(document?.updatedAt || document?.createdAt || Number.NaN);
    if (!Number.isFinite(parsed.getTime())) return newest;
    return !newest || parsed > newest ? parsed : newest;
  }, null);
}

function createAttendanceProductionCumulativeCorrectionService({
  connection = mongoose.connection,
  AttendanceDailyReviewModel = AttendanceDailyReview,
  AttendanceSubmissionModel = AttendanceSubmission,
  GeneratedDailyReportModel = GeneratedDailyReport,
  ProductionScheduleModel = ProductionSchedule,
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
    ProductionScheduleModel,
    ProjectTeamModel
  };

  async function analyze(session = null) {
    return analyzeAttendanceProductionCumulativeCorrection({ ...dependencies, session });
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
        reviewedAt: review.reviewedAt,
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
      const beforeReport = reportAnalysis(before);
      const afterReport = reportAnalysis(after);
      for (const field of ['summarySnapshot', 'sourceSubmissions', 'productionSchedules']) {
        if (beforeReport.evidence[field].sha256 !== afterReport.evidence[field].sha256) {
          fail('CORRECTION_SOURCE_CHANGED', `Correction source changed during execution: ${field}`);
        }
      }
      return {
        ...base,
        generatedAt: now().toISOString(),
        status: 'EXECUTED',
        backup,
        before: beforeReport,
        after: afterReport,
        writePerformed: true,
        dataWrites: 1,
        auditLogsCreated: 1
      };
    }, connection, {
      code: 'ATTENDANCE_PRODUCTION_CUMULATIVE_CORRECTION_TRANSACTIONS_REQUIRED',
      message: 'Attendance production cumulative correction requires MongoDB replica-set transaction support'
    });
  }

  return Object.freeze({ analyze, run });
}

module.exports = {
  ALLOWED_EXECUTION_DATABASE,
  AttendanceProductionCumulativeCorrectionError,
  CORRECTION_REASON,
  CORRECTION_REPORT_FORMAT,
  MONTHLY_TOTAL_FIELDS,
  TARGET,
  analyzeAttendanceProductionCumulativeCorrection,
  correctedFinalText,
  createAttendanceProductionCumulativeCorrectionService,
  expectedMonths,
  monthlyTotal,
  occurrenceCount,
  productionEvidenceMatches,
  productionYearEvidence,
  reportAnalysis
};
