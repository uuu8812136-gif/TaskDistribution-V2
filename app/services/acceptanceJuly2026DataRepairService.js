'use strict';

const { createHash } = require('node:crypto');
const path = require('node:path');
const mongoose = require('mongoose');
const { verifyBackupSet } = require('../../ops/lib/backupCore');
const AttendanceDailyReview = require('../models/AttendanceDailyReview');
const AttendanceSubmission = require('../models/AttendanceSubmission');
const GeneratedDailyReport = require('../models/GeneratedDailyReport');
const OrgUnit = require('../models/OrgUnit');
const ProductionSchedule = require('../models/ProductionSchedule');
const ProjectTeam = require('../models/ProjectTeam');
const User = require('../models/User');
const {
  AUDIT_ACTIONS,
  AUDIT_RESOURCE_TYPES,
  ORG_UNIT_STATUSES,
  ORG_UNIT_TYPES
} = require('../config/permissions');
const {
  finalAttendanceReportText,
  summarizeDocuments
} = require('./attendanceSubmissionService');
const { createAuditService } = require('./auditService');
const { parseNaturalDate } = require('./reportCalendarService');
const { runWithRequiredTransaction } = require('./transactionService');

const MIGRATION_REPORT_FORMAT = 'acceptance-july-2026-data-repair/v1';
const ALLOWED_EXECUTION_DATABASE = 'customer_acceptance_v2_test';
const MIGRATION_REASON = 'Repair the verified June/July 2026 acceptance schedules and temporary-worker attendance data';
const TARGETS = Object.freeze({
  month: '2026-07',
  juneMonth: '2026-06',
  reportDate: '2026-07-24',
  canonicalScheduleId: '6a588ae29ad35af9cfd73c9c',
  duplicateScheduleId: '6a62bd82e4e630b273cd7156',
  juneCanonicalScheduleId: '6a59e5eefe119695fb20f639',
  juneDuplicateScheduleId: '6a62d614e4e630b273cfbf1f',
  juneCanonicalProductionPlanForecast: 12500,
  juneCanonicalMonthlyTotals: Object.freeze({
    aLine: 5429,
    northLine: 0,
    transferCaseLine: 223,
    bLineDay: 4686,
    bLineNight: 1662
  }),
  attendanceSubmissionId: '6a62af14e4e630b273cc3174',
  attendanceDailyReviewId: '6a62cccee4e630b273cedbcd',
  sourceRemark: '临时工2人'
});
const COLLECTIONS = Object.freeze({
  productionSchedules: 'productionschedules',
  attendanceSubmissions: 'attendancesubmissions',
  attendanceDailyReviews: 'attendancedailyreviews',
  generatedDailyReports: 'generateddailyreports'
});
const AUTH_SESSION_COLLECTION = 'authsessions';
const REQUIRED_BACKUP_COLLECTIONS = Object.freeze([
  ...Object.values(COLLECTIONS),
  AUTH_SESSION_COLLECTION
]);
const MONTHLY_TOTAL_FIELDS = Object.freeze([
  'aLine',
  'northLine',
  'transferCaseLine',
  'bLineDay',
  'bLineNight'
]);
const DAILY_QUANTITY_FIELDS = Object.freeze([
  'aLineDay',
  'aLineNight',
  'northLine',
  'transferCaseLine',
  'bLineDay',
  'bLineNight'
]);

class AcceptanceJuly2026DataRepairError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'AcceptanceJuly2026DataRepairError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = null) {
  throw new AcceptanceJuly2026DataRepairError(code, message, details);
}

function normalizeId(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') return value;
  if (typeof value.toHexString === 'function') return value.toHexString();
  if (value._id !== undefined) return normalizeId(value._id);
  return String(value);
}

function sameId(left, right) {
  const normalizedLeft = normalizeId(left);
  const normalizedRight = normalizeId(right);
  return normalizedLeft !== null && normalizedLeft === normalizedRight;
}

function shiftNaturalDate(value, deltaDays) {
  const parsed = parseNaturalDate(value);
  if (!parsed || !Number.isInteger(deltaDays)) return null;
  const shifted = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + deltaDays));
  return [
    shifted.getUTCFullYear(),
    String(shifted.getUTCMonth() + 1).padStart(2, '0'),
    String(shifted.getUTCDate()).padStart(2, '0')
  ].join('-');
}

function plain(value) {
  if (value && typeof value.toObject === 'function') {
    return value.toObject({ depopulate: true, flattenMaps: true, virtuals: false });
  }
  return value;
}

function canonicalize(value) {
  const source = plain(value);
  if (source === null || source === undefined) return source ?? null;
  if (source instanceof Date) return source.toISOString();
  if (Buffer.isBuffer(source)) return source.toString('base64');
  if (typeof source.toHexString === 'function') return source.toHexString();
  if (Array.isArray(source)) return source.map(canonicalize);
  if (typeof source !== 'object') return source;
  return Object.fromEntries(
    Object.keys(source).sort().map((key) => [key, canonicalize(source[key])])
  );
}

function snapshot(value) {
  const canonical = canonicalize(value);
  const serialized = JSON.stringify(canonical);
  return {
    value: canonical,
    sha256: createHash('sha256').update(serialized).digest('hex'),
    bytes: Buffer.byteLength(serialized, 'utf8')
  };
}

function blocker(code, message, details = null) {
  return { code, message, details };
}

function databaseNameOf(connection) {
  return connection?.name || connection?.db?.databaseName || null;
}

function withSession(query, session) {
  return session && typeof query.session === 'function' ? query.session(session) : query;
}

async function findMany(Model, filter, { session = null, sort = { _id: 1 }, projection = null } = {}) {
  let query = Model.find(filter);
  if (projection) query = query.select(projection);
  if (sort) query = query.sort(sort);
  query = withSession(query, session);
  return query.lean();
}

async function findOne(Model, filter, { session = null, projection = null } = {}) {
  let query = Model.findOne(filter);
  if (projection) query = query.select(projection);
  query = withSession(query, session);
  return query.lean();
}

function groupScheduleConflicts(schedules) {
  const grouped = new Map();
  for (const schedule of schedules) {
    const key = `${normalizeId(schedule.teamId)}:${schedule.month}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(schedule);
  }
  return [...grouped.entries()]
    .filter(([, documents]) => documents.length > 1)
    .map(([key, documents]) => ({
      key,
      teamId: normalizeId(documents[0].teamId),
      month: documents[0].month,
      scheduleIds: documents.map(({ _id }) => normalizeId(_id)).sort()
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

function monthlyTotalsAreEmpty(monthlyTotals) {
  return MONTHLY_TOTAL_FIELDS.every((field) => monthlyTotals?.[field] === null || monthlyTotals?.[field] === undefined);
}

function normalizedDailyEntries(entries) {
  return (entries || []).map((entry) => ({
    date: entry.date,
    ...Object.fromEntries(DAILY_QUANTITY_FIELDS.map((field) => [
      field,
      entry[field] === null || entry[field] === undefined ? 0 : entry[field]
    ]))
  }));
}

function dailyEntriesSemanticallyEqual(left, right) {
  return snapshot(normalizedDailyEntries(left)).sha256 === snapshot(normalizedDailyEntries(right)).sha256;
}

function namedQuantity(value, count) {
  return Boolean(
    value &&
    value.count === count &&
    Array.isArray(value.names) &&
    value.names.length === 0
  );
}

function namedQuantityUnset(value) {
  return value === null || value === undefined || namedQuantity(value, 0);
}

function attendanceBeforeState(document) {
  return Boolean(
    document &&
    document.otherRemark === TARGETS.sourceRemark &&
    namedQuantityUnset(document.dayShift?.temporaryWorker) &&
    namedQuantityUnset(document.nightShift?.temporaryWorker)
  );
}

function attendanceAfterState(document) {
  return Boolean(
    document &&
    document.otherRemark === '' &&
    namedQuantity(document.dayShift?.temporaryWorker, 2) &&
    namedQuantity(document.nightShift?.temporaryWorker, 0)
  );
}

function patchedAttendance(document, changedAt) {
  return {
    ...document,
    dayShift: {
      ...(document.dayShift || {}),
      temporaryWorker: { count: 2, names: [] }
    },
    nightShift: {
      ...(document.nightShift || {}),
      temporaryWorker: { count: 0, names: [] }
    },
    otherRemark: '',
    updatedAt: changedAt,
    __v: (document.__v ?? 0) + 1
  };
}

function idsEqual(left, right) {
  return [...left].map(normalizeId).sort().join(',') === [...right].map(normalizeId).sort().join(',');
}

function reportOperation(type, resourceId, before, after) {
  return {
    type,
    resourceId: normalizeId(resourceId),
    before: snapshot(before),
    after: snapshot(after)
  };
}

function reportAnalysis(analysis) {
  return {
    state: analysis.state,
    plannedWriteCount: analysis.operations.length,
    plannedAuditCount: analysis.operations.length,
    blockerCount: analysis.blockers.length,
    blockers: analysis.blockers,
    target: analysis.target,
    productionScheduleConflicts: analysis.productionScheduleConflicts,
    generatedDailyReportCount: analysis.generatedDailyReportCount,
    operations: analysis.operations
  };
}

async function analyzeAcceptanceJuly2026DataRepair({
  connection,
  ProductionScheduleModel = ProductionSchedule,
  AttendanceSubmissionModel = AttendanceSubmission,
  AttendanceDailyReviewModel = AttendanceDailyReview,
  GeneratedDailyReportModel = GeneratedDailyReport,
  ProjectTeamModel = ProjectTeam,
  OrgUnitModel = OrgUnit,
  UserModel = User,
  summarize = summarizeDocuments,
  renderFinalText = finalAttendanceReportText,
  now = () => new Date(),
  session = null
} = {}) {
  if (!connection?.db) throw new TypeError('A connected Mongoose connection is required');
  const changedAt = now();
  const blockers = [];
  const schedules = await findMany(ProductionScheduleModel, {} , { session });
  const scheduleById = new Map(schedules.map((document) => [normalizeId(document._id), document]));
  const canonicalSchedule = scheduleById.get(TARGETS.canonicalScheduleId) || null;
  const duplicateSchedule = scheduleById.get(TARGETS.duplicateScheduleId) || null;
  const juneCanonicalSchedule = scheduleById.get(TARGETS.juneCanonicalScheduleId) || null;
  const juneDuplicateSchedule = scheduleById.get(TARGETS.juneDuplicateScheduleId) || null;
  const productionScheduleConflicts = groupScheduleConflicts(schedules);

  if (!canonicalSchedule) {
    blockers.push(blocker('CANONICAL_SCHEDULE_NOT_FOUND', 'The fixed canonical July 2026 production schedule was not found'));
  }
  if (canonicalSchedule && canonicalSchedule.month !== TARGETS.month) {
    blockers.push(blocker('CANONICAL_SCHEDULE_MONTH_MISMATCH', 'The canonical schedule month is not the fixed July 2026 target', {
      actual: canonicalSchedule.month
    }));
  }

  const canonicalTeamId = normalizeId(canonicalSchedule?.teamId);
  const [canonicalOrgUnit, juneCanonicalOrgUnit, juneDuplicateOrgUnit] = await Promise.all([
    canonicalSchedule
      ? findOne(OrgUnitModel, { _id: canonicalSchedule.orgUnitId }, { session })
      : null,
    juneCanonicalSchedule
      ? findOne(OrgUnitModel, { _id: juneCanonicalSchedule.orgUnitId }, { session })
      : null,
    juneDuplicateSchedule
      ? findOne(OrgUnitModel, { _id: juneDuplicateSchedule.orgUnitId }, { session })
      : null
  ]);
  if (canonicalSchedule && (
    !canonicalOrgUnit ||
    !sameId(canonicalOrgUnit.teamId, canonicalSchedule.teamId) ||
    canonicalOrgUnit.type !== ORG_UNIT_TYPES.DEPARTMENT ||
    canonicalOrgUnit.level !== 1 ||
    canonicalOrgUnit.parentId !== null ||
    canonicalOrgUnit.status !== ORG_UNIT_STATUSES.ACTIVE
  )) {
    blockers.push(blocker('CANONICAL_SCHEDULE_NOT_ROOT_DEPARTMENT', 'The canonical schedule is not attached to the active root department'));
  }

  if (!juneCanonicalSchedule) {
    blockers.push(blocker('JUNE_CANONICAL_SCHEDULE_NOT_FOUND', 'The fixed canonical June 2026 production schedule was not found'));
  }
  if (juneCanonicalSchedule && (
    juneCanonicalSchedule.month !== TARGETS.juneMonth ||
    !canonicalSchedule ||
    !sameId(juneCanonicalSchedule.teamId, canonicalSchedule.teamId) ||
    !sameId(juneCanonicalSchedule.orgUnitId, canonicalSchedule.orgUnitId) ||
    !juneCanonicalOrgUnit ||
    !sameId(juneCanonicalOrgUnit._id, canonicalOrgUnit?._id)
  )) {
    blockers.push(blocker('JUNE_CANONICAL_SCHEDULE_SCOPE_MISMATCH', 'The fixed June canonical schedule is outside the active root team/month scope'));
  }
  if (
    juneCanonicalSchedule &&
    juneCanonicalSchedule.productionPlanForecast !== TARGETS.juneCanonicalProductionPlanForecast
  ) {
    blockers.push(blocker('JUNE_CANONICAL_SCHEDULE_FORECAST_MISMATCH', 'The fixed June canonical forecast changed from the verified value'));
  }
  if (
    juneCanonicalSchedule &&
    snapshot(juneCanonicalSchedule.monthlyTotals || {}).sha256 !==
      snapshot(TARGETS.juneCanonicalMonthlyTotals).sha256
  ) {
    blockers.push(blocker('JUNE_CANONICAL_SCHEDULE_TOTALS_MISMATCH', 'The fixed June canonical monthly totals changed from the verified values'));
  }

  const fixedConflictIds = new Map([
    [TARGETS.month, [TARGETS.canonicalScheduleId, TARGETS.duplicateScheduleId].sort()],
    [TARGETS.juneMonth, [TARGETS.juneCanonicalScheduleId, TARGETS.juneDuplicateScheduleId].sort()]
  ]);
  for (const conflict of productionScheduleConflicts) {
    const expectedIds = fixedConflictIds.get(conflict.month);
    const isFixedTarget = (
      canonicalSchedule &&
      conflict.teamId === canonicalTeamId &&
      expectedIds &&
      conflict.scheduleIds.join(',') === expectedIds.join(',')
    );
    if (!isFixedTarget) {
      blockers.push(blocker('UNEXPECTED_TEAM_MONTH_SCHEDULE_CONFLICT', 'A teamId + month schedule conflict exists outside the fixed migration pair', conflict));
    }
  }

  if (duplicateSchedule) {
    if (!canonicalSchedule || !sameId(duplicateSchedule.teamId, canonicalSchedule.teamId) || duplicateSchedule.month !== TARGETS.month) {
      blockers.push(blocker('DUPLICATE_SCHEDULE_SCOPE_MISMATCH', 'The fixed duplicate schedule is outside the canonical team and month'));
    }
    if (snapshot(duplicateSchedule.dailyEntries || []).sha256 !== snapshot(canonicalSchedule?.dailyEntries || []).sha256) {
      blockers.push(blocker('DUPLICATE_SCHEDULE_DAILY_VALUES_DIFFER', 'The fixed duplicate schedule does not exactly duplicate canonical daily entries'));
    }
    if (duplicateSchedule.productionPlanForecast !== null && duplicateSchedule.productionPlanForecast !== undefined) {
      blockers.push(blocker('DUPLICATE_SCHEDULE_FORECAST_NOT_EMPTY', 'The fixed duplicate schedule has a non-empty production forecast'));
    }
    if (!monthlyTotalsAreEmpty(duplicateSchedule.monthlyTotals)) {
      blockers.push(blocker('DUPLICATE_SCHEDULE_MONTHLY_TOTALS_NOT_EMPTY', 'The fixed duplicate schedule has non-empty monthly totals'));
    }
  }
  if (juneDuplicateSchedule) {
    if (
      !juneCanonicalSchedule ||
      !sameId(juneDuplicateSchedule.teamId, juneCanonicalSchedule.teamId) ||
      juneDuplicateSchedule.month !== TARGETS.juneMonth
    ) {
      blockers.push(blocker('JUNE_DUPLICATE_SCHEDULE_SCOPE_MISMATCH', 'The fixed June duplicate is outside the canonical team and month'));
    }
    if (!dailyEntriesSemanticallyEqual(
      juneDuplicateSchedule.dailyEntries,
      juneCanonicalSchedule?.dailyEntries
    )) {
      blockers.push(blocker('JUNE_DUPLICATE_SCHEDULE_DAILY_VALUES_DIFFER', 'The fixed June duplicate does not preserve the canonical daily quantities'));
    }
    if (
      juneDuplicateSchedule.productionPlanForecast !== null &&
      juneDuplicateSchedule.productionPlanForecast !== undefined
    ) {
      blockers.push(blocker('JUNE_DUPLICATE_SCHEDULE_FORECAST_NOT_EMPTY', 'The fixed June duplicate has a non-empty production forecast'));
    }
    if (!monthlyTotalsAreEmpty(juneDuplicateSchedule.monthlyTotals)) {
      blockers.push(blocker('JUNE_DUPLICATE_SCHEDULE_MONTHLY_TOTALS_NOT_EMPTY', 'The fixed June duplicate has non-empty monthly totals'));
    }
    if (
      !juneDuplicateOrgUnit ||
      !juneCanonicalOrgUnit ||
      !sameId(juneDuplicateOrgUnit.teamId, juneCanonicalSchedule?.teamId) ||
      !sameId(juneDuplicateOrgUnit.parentId, juneCanonicalOrgUnit._id) ||
      juneDuplicateOrgUnit.type !== ORG_UNIT_TYPES.SUB_DEPARTMENT ||
      juneDuplicateOrgUnit.level !== 2 ||
      juneDuplicateOrgUnit.status !== ORG_UNIT_STATUSES.ACTIVE
    ) {
      blockers.push(blocker('JUNE_DUPLICATE_SCHEDULE_ORG_MISMATCH', 'The fixed June duplicate is not attached to the verified active subdepartment scope'));
    }
  }

  const [attendanceSubmission, attendanceDailyReview, generatedDailyReports] = await Promise.all([
    findOne(AttendanceSubmissionModel, { _id: TARGETS.attendanceSubmissionId }, { session }),
    findOne(AttendanceDailyReviewModel, { _id: TARGETS.attendanceDailyReviewId }, { session }),
    findMany(GeneratedDailyReportModel, {}, { session, projection: '_id teamId reportDate version' })
  ]);
  if (!attendanceSubmission) {
    blockers.push(blocker('ATTENDANCE_SUBMISSION_NOT_FOUND', 'The fixed attendance submission was not found'));
  }
  if (!attendanceDailyReview) {
    blockers.push(blocker('ATTENDANCE_DAILY_REVIEW_NOT_FOUND', 'The fixed attendance daily review was not found'));
  }
  if (generatedDailyReports.length > 0) {
    blockers.push(blocker('GENERATED_DAILY_REPORT_EXISTS', 'Generated daily reports exist and this migration will not overwrite them', {
      count: generatedDailyReports.length,
      examples: generatedDailyReports.slice(0, 20).map((document) => ({
        _id: normalizeId(document._id),
        teamId: normalizeId(document.teamId),
        reportDate: document.reportDate,
        version: document.version
      }))
    }));
  }

  for (const [label, document] of [
    ['attendance submission', attendanceSubmission],
    ['attendance daily review', attendanceDailyReview]
  ]) {
    if (document && (
      document.reportDate !== TARGETS.reportDate ||
      !canonicalSchedule ||
      !sameId(document.teamId, canonicalSchedule.teamId)
    )) {
      blockers.push(blocker('ATTENDANCE_TARGET_SCOPE_MISMATCH', `The fixed ${label} is outside the canonical team and report date`));
    }
  }

  let targetAttendance = null;
  let targetSummary = null;
  let targetFinalText = null;
  let targetReview = null;
  let team = null;
  let reviewer = null;
  let submissions = [];
  let yesterdaySubmissions = [];
  let summaryOrgUnits = [];
  let yesterdayOrgUnits = [];
  if (canonicalSchedule && attendanceSubmission && attendanceDailyReview) {
    [team, reviewer, submissions, yesterdaySubmissions] = await Promise.all([
      findOne(ProjectTeamModel, { _id: canonicalSchedule.teamId }, { session }),
      findOne(UserModel, { _id: attendanceDailyReview.reviewedBy }, {
        session,
        projection: '_id name username status isSystemAccount'
      }),
      findMany(AttendanceSubmissionModel, {
        teamId: canonicalSchedule.teamId,
        reportDate: TARGETS.reportDate
      }, { session }),
      findMany(AttendanceSubmissionModel, {
        teamId: canonicalSchedule.teamId,
        reportDate: shiftNaturalDate(TARGETS.reportDate, -1),
        reviewStatus: AttendanceSubmission.ATTENDANCE_REVIEW_STATUSES.REVIEWED
      }, { session })
    ]);
    if (!team || !reviewer) {
      blockers.push(blocker('ATTENDANCE_REVIEW_RELATED_RESOURCE_MISSING', 'The review team or reviewer no longer exists'));
    }
    if (!idsEqual(submissions.map(({ _id }) => _id), attendanceDailyReview.submissionIds || [])) {
      blockers.push(blocker('ATTENDANCE_REVIEW_SUBMISSION_SET_MISMATCH', 'Current submissions do not exactly match the permanent review snapshot IDs'));
    }
    if (!idsEqual(submissions.map(({ orgUnitId }) => orgUnitId), attendanceDailyReview.expectedOrgUnitIds || [])) {
      blockers.push(blocker('ATTENDANCE_REVIEW_ORG_SET_MISMATCH', 'Current submission organizations do not exactly match the permanent review expectation'));
    }
    if (submissions.some(({ reviewStatus }) => reviewStatus !== AttendanceSubmission.ATTENDANCE_REVIEW_STATUSES.REVIEWED)) {
      blockers.push(blocker('ATTENDANCE_SUBMISSION_NOT_REVIEWED', 'Every submission referenced by the permanent review must remain REVIEWED'));
    }

    const summaryOrgUnitIds = [...new Set(submissions.map(({ orgUnitId }) => normalizeId(orgUnitId)))];
    const yesterdayOrgUnitIds = [...new Set(yesterdaySubmissions.map(({ orgUnitId }) => normalizeId(orgUnitId)))];
    [summaryOrgUnits, yesterdayOrgUnits] = await Promise.all([
      summaryOrgUnitIds.length > 0
        ? findMany(OrgUnitModel, {
            teamId: canonicalSchedule.teamId,
            _id: { $in: summaryOrgUnitIds }
          }, { session })
        : [],
      yesterdayOrgUnitIds.length > 0
        ? findMany(OrgUnitModel, {
            teamId: canonicalSchedule.teamId,
            _id: { $in: yesterdayOrgUnitIds }
          }, { session })
        : []
    ]);

    targetAttendance = patchedAttendance(attendanceSubmission, changedAt);
    const targetSubmissions = submissions.map((document) => (
      sameId(document._id, attendanceSubmission._id) ? targetAttendance : document
    ));
    targetSummary = summarize(targetSubmissions, TARGETS.reportDate, summaryOrgUnits);
    if (
      targetSummary?.dayShift?.temporaryWorker?.count !== 2 ||
      targetSummary?.nightShift?.temporaryWorker?.count !== 0
    ) {
      blockers.push(blocker(
        'ATTENDANCE_SHARED_SUMMARY_NOT_READY',
        'summarizeDocuments does not yet preserve temporaryWorker totals; migration execution is blocked'
      ));
    }
    if (team && reviewer && blockers.every(({ code }) => ![
      'ATTENDANCE_SHARED_SUMMARY_NOT_READY',
      'UNEXPECTED_TEAM_MONTH_SCHEDULE_CONFLICT'
    ].includes(code))) {
      const yesterdaySummary = yesterdaySubmissions.length > 0
        ? summarize(
            yesterdaySubmissions,
            shiftNaturalDate(TARGETS.reportDate, -1),
            yesterdayOrgUnits
          )
        : null;
      try {
        targetFinalText = renderFinalText({
          teamName: team.name,
          reportDate: TARGETS.reportDate,
          summary: targetSummary,
          yesterdaySummary,
          productionSchedules: schedules.filter(({ _id }) => (
            !sameId(_id, TARGETS.duplicateScheduleId) &&
            !sameId(_id, TARGETS.juneDuplicateScheduleId)
          )),
          reviewerName: reviewer.name || reviewer.username
        });
        targetReview = {
          ...attendanceDailyReview,
          summarySnapshot: targetSummary,
          finalText: targetFinalText,
          updatedAt: changedAt,
          __v: (attendanceDailyReview.__v ?? 0) + 1
        };
      } catch (error) {
        blockers.push(blocker('ATTENDANCE_RECOMPUTE_FAILED', 'Updated attendance summary or final text could not be recomputed', {
          code: error.code || null,
          message: error.message
        }));
      }
    }
  }

  const beforeAttendance = attendanceBeforeState(attendanceSubmission);
  const afterAttendance = attendanceAfterState(attendanceSubmission);
  const reviewMatchesTarget = Boolean(
    targetReview &&
    snapshot(attendanceDailyReview.summarySnapshot).sha256 === snapshot(targetSummary).sha256 &&
    attendanceDailyReview.finalText === targetFinalText
  );
  let state = 'BLOCKED';
  const operations = [];
  if (blockers.length === 0) {
    if (duplicateSchedule && juneDuplicateSchedule && beforeAttendance && !reviewMatchesTarget) {
      state = 'READY';
      operations.push(reportOperation(
        'DELETE_DUPLICATE_JUNE_PRODUCTION_SCHEDULE',
        juneDuplicateSchedule._id,
        juneDuplicateSchedule,
        { deleted: true, canonicalScheduleId: TARGETS.juneCanonicalScheduleId }
      ));
      operations.push(reportOperation(
        'DELETE_DUPLICATE_PRODUCTION_SCHEDULE',
        duplicateSchedule._id,
        duplicateSchedule,
        { deleted: true, canonicalScheduleId: TARGETS.canonicalScheduleId }
      ));
      operations.push(reportOperation(
        'MIGRATE_TEMPORARY_WORKER_ATTENDANCE',
        attendanceSubmission._id,
        attendanceSubmission,
        targetAttendance
      ));
      operations.push(reportOperation(
        'RECOMPUTE_ATTENDANCE_DAILY_REVIEW',
        attendanceDailyReview._id,
        attendanceDailyReview,
        targetReview
      ));
    } else if (!duplicateSchedule && !juneDuplicateSchedule && afterAttendance && reviewMatchesTarget) {
      state = 'ALREADY_APPLIED';
    } else {
      blockers.push(blocker('MIGRATION_STATE_PARTIAL_OR_UNEXPECTED', 'The fixed records are neither the complete known before-state nor the complete target state', {
        julyDuplicatePresent: Boolean(duplicateSchedule),
        juneDuplicatePresent: Boolean(juneDuplicateSchedule),
        attendanceBeforeState: beforeAttendance,
        attendanceAfterState: afterAttendance,
        reviewMatchesTarget
      }));
    }
  }

  return {
    state,
    operations,
    blockers,
    productionScheduleConflicts,
    generatedDailyReportCount: generatedDailyReports.length,
    documents: {
      canonicalSchedule,
      duplicateSchedule,
      juneCanonicalSchedule,
      juneDuplicateSchedule,
      attendanceSubmission,
      attendanceDailyReview,
      targetAttendance,
      targetReview
    },
    target: {
      ...TARGETS,
      teamId: canonicalTeamId,
      rootOrgUnitId: normalizeId(canonicalOrgUnit?._id),
      canonicalSchedule: canonicalSchedule ? snapshot(canonicalSchedule) : null,
      duplicateSchedule: duplicateSchedule ? snapshot(duplicateSchedule) : null,
      juneCanonicalSchedule: juneCanonicalSchedule ? snapshot(juneCanonicalSchedule) : null,
      juneDuplicateSchedule: juneDuplicateSchedule ? snapshot(juneDuplicateSchedule) : null,
      attendanceSubmission: attendanceSubmission ? snapshot(attendanceSubmission) : null,
      attendanceDailyReview: attendanceDailyReview ? snapshot(attendanceDailyReview) : null,
      targetAttendanceSubmission: targetAttendance ? snapshot(targetAttendance) : null,
      targetAttendanceDailyReview: targetReview ? snapshot(targetReview) : null
    }
  };
}

async function liveCollectionInventory(connection) {
  const entries = await connection.db.listCollections({}, { nameOnly: true }).toArray();
  const names = entries
    .map(({ name }) => name)
    .filter((name) => !name.startsWith('system.'))
    .sort();
  const collections = [];
  for (const name of names) {
    collections.push({
      name,
      documentCount: await connection.db.collection(name).countDocuments({})
    });
  }
  return collections;
}

async function verifyExecutionBackup({
  backupDirectory,
  databaseName,
  backupVerifier,
  liveCollections,
  minimumCompletedAt = null
}) {
  if (typeof backupDirectory !== 'string' || !backupDirectory.trim()) {
    fail('BACKUP_DIRECTORY_REQUIRED', '--backup-directory is required in execute mode');
  }
  if (!path.isAbsolute(backupDirectory)) {
    fail('BACKUP_DIRECTORY_NOT_ABSOLUTE', '--backup-directory must be absolute in execute mode');
  }
  const resolved = path.resolve(backupDirectory);
  const verified = await backupVerifier(resolved, { verifyFiles: true });
  const manifest = verified?.manifest;
  if (manifest?.database?.name !== databaseName) {
    fail('BACKUP_DATABASE_MISMATCH', 'Verified backup database name does not match the connected database', {
      expected: databaseName,
      actual: manifest?.database?.name || null
    });
  }
  if (
    manifest?.consistency?.restoreSet !== 'database-and-uploads' ||
    manifest?.consistency?.databaseFileAssetsVerifiedAgainstUploadBytes !== true
  ) {
    fail('BACKUP_NOT_COMPLETE_RESTORE_SET', 'Execution requires a complete database-and-uploads backup set');
  }
  const manifestCollections = new Map(
    (manifest.database.collections || []).map((collection) => [collection.name, collection])
  );
  const fileNames = new Set((manifest.files || []).map(({ file }) => file));
  const missingRequiredCollections = REQUIRED_BACKUP_COLLECTIONS.filter((name) => !manifestCollections.has(name));
  const missingLiveCollections = liveCollections.filter(({ name }) => !manifestCollections.has(name));
  const ttlCountDrifts = [];
  const countMismatches = liveCollections.flatMap(({ name, documentCount }) => {
    const backedUp = manifestCollections.get(name);
    if (!backedUp || backedUp.documentCount === documentCount) return [];
    if (name === AUTH_SESSION_COLLECTION && documentCount < backedUp.documentCount) {
      ttlCountDrifts.push({ name, live: documentCount, backup: backedUp.documentCount });
      return [];
    }
    return [{ name, live: documentCount, backup: backedUp.documentCount }];
  });
  const missingDumpFiles = liveCollections
    .map(({ name }) => `database/${databaseName}/${name}.bson`)
    .filter((file) => !fileNames.has(file));
  if (
    manifest.database.collectionCount !== manifest.database.collections.length ||
    missingRequiredCollections.length ||
    missingLiveCollections.length ||
    countMismatches.length ||
    missingDumpFiles.length
  ) {
    fail('BACKUP_DATABASE_STATE_INCOMPLETE', 'Verified backup does not satisfy the current database collection guards', {
      missingRequiredCollections,
      missingLiveCollections,
      countMismatches,
      missingDumpFiles,
      manifestCollectionCount: manifest.database.collectionCount,
      declaredCollectionCount: manifest.database.collections.length
    });
  }
  const completedAt = Date.parse(manifest.completedAt || '');
  if (!Number.isFinite(completedAt)) {
    fail('BACKUP_COMPLETED_AT_INVALID', 'Verified backup has no valid completedAt timestamp');
  }
  if (minimumCompletedAt && completedAt < minimumCompletedAt.getTime()) {
    fail('BACKUP_PREDATES_TARGET_STATE', 'Verified backup predates a fixed target record', {
      backupCompletedAt: manifest.completedAt,
      minimumTargetUpdatedAt: minimumCompletedAt.toISOString()
    });
  }
  return {
    backupDirectory: verified.backupDirectory || resolved,
    backupId: manifest.backupId || null,
    completedAt: manifest.completedAt,
    databaseName,
    manifestSha256: verified.manifestSha256,
    collectionCount: liveCollections.length,
    collectionCountsVerified: true,
    ttlCountDrifts,
    completeRestoreSetVerified: true
  };
}

function newestDocumentInstant(analysis) {
  const documents = [
    analysis.documents.canonicalSchedule,
    analysis.documents.duplicateSchedule,
    analysis.documents.juneCanonicalSchedule,
    analysis.documents.juneDuplicateSchedule,
    analysis.documents.attendanceSubmission,
    analysis.documents.attendanceDailyReview
  ].filter(Boolean);
  const instants = documents.flatMap((document) => [document.updatedAt, document.createdAt, document.reviewedAt])
    .map((value) => value instanceof Date ? value : new Date(value || Number.NaN))
    .filter((value) => Number.isFinite(value.getTime()));
  return instants.length > 0
    ? new Date(Math.max(...instants.map((value) => value.getTime())))
    : null;
}

function createAcceptanceJuly2026DataRepairService({
  connection = mongoose.connection,
  ProductionScheduleModel = ProductionSchedule,
  AttendanceSubmissionModel = AttendanceSubmission,
  AttendanceDailyReviewModel = AttendanceDailyReview,
  GeneratedDailyReportModel = GeneratedDailyReport,
  ProjectTeamModel = ProjectTeam,
  OrgUnitModel = OrgUnit,
  UserModel = User,
  summarize = summarizeDocuments,
  renderFinalText = finalAttendanceReportText,
  auditService = createAuditService(),
  backupVerifier = verifyBackupSet,
  transactionRunner = runWithRequiredTransaction,
  now = () => new Date(),
  allowedExecutionDatabaseNames = [ALLOWED_EXECUTION_DATABASE]
} = {}) {
  if (!connection?.db) throw new TypeError('A connected Mongoose connection is required');
  const allowedDatabases = new Set(allowedExecutionDatabaseNames);
  if (allowedDatabases.size === 0) throw new TypeError('allowedExecutionDatabaseNames must not be empty');
  const dependencies = {
    connection,
    ProductionScheduleModel,
    AttendanceSubmissionModel,
    AttendanceDailyReviewModel,
    GeneratedDailyReportModel,
    ProjectTeamModel,
    OrgUnitModel,
    UserModel,
    summarize,
    renderFinalText,
    now
  };

  async function analyze(session = null) {
    return analyzeAcceptanceJuly2026DataRepair({ ...dependencies, session });
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
      format: MIGRATION_REPORT_FORMAT,
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
    if (preview.operations.length === 0) return { ...base, status: 'NO_CHANGES', after: reportAnalysis(preview) };

    const backup = await verifyExecutionBackup({
      backupDirectory,
      databaseName,
      backupVerifier,
      liveCollections: await liveCollectionInventory(connection),
      minimumCompletedAt: newestDocumentInstant(preview)
    });

    return transactionRunner(async (session) => {
      const before = await analyze(session);
      const transactionalBase = {
        ...base,
        generatedAt: now().toISOString(),
        backup,
        before: reportAnalysis(before)
      };
      if (before.blockers.length > 0 || before.state !== 'READY' || before.operations.length !== 4) {
        fail('TARGET_STATE_CHANGED_BEFORE_EXECUTION', 'Fixed target records changed after backup verification', {
          backup,
          before: reportAnalysis(before),
          writePerformed: false,
          transactionRolledBack: true
        });
      }

      const {
        duplicateSchedule,
        juneDuplicateSchedule,
        attendanceSubmission,
        attendanceDailyReview,
        targetAttendance,
        targetReview
      } = before.documents;
      const juneDeleteResult = await ProductionScheduleModel.deleteOne({
        _id: juneDuplicateSchedule._id,
        teamId: juneDuplicateSchedule.teamId,
        orgUnitId: juneDuplicateSchedule.orgUnitId,
        month: TARGETS.juneMonth,
        __v: juneDuplicateSchedule.__v ?? 0
      }, { session });
      if (juneDeleteResult.deletedCount !== 1) {
        fail('JUNE_DUPLICATE_SCHEDULE_CHANGED', 'The fixed June duplicate schedule changed during migration');
      }

      const deleteResult = await ProductionScheduleModel.deleteOne({
        _id: duplicateSchedule._id,
        teamId: duplicateSchedule.teamId,
        orgUnitId: duplicateSchedule.orgUnitId,
        month: TARGETS.month,
        __v: duplicateSchedule.__v ?? 0
      }, { session });
      if (deleteResult.deletedCount !== 1) {
        fail('DUPLICATE_SCHEDULE_CHANGED', 'The fixed duplicate schedule changed during migration');
      }

      const attendanceResult = await AttendanceSubmissionModel.updateOne({
        _id: attendanceSubmission._id,
        teamId: attendanceSubmission.teamId,
        reportDate: TARGETS.reportDate,
        otherRemark: TARGETS.sourceRemark,
        __v: attendanceSubmission.__v ?? 0
      }, {
        $set: {
          'dayShift.temporaryWorker': { count: 2, names: [] },
          'nightShift.temporaryWorker': { count: 0, names: [] },
          otherRemark: '',
          updatedAt: targetAttendance.updatedAt
        },
        $inc: { __v: 1 }
      }, { session, runValidators: true });
      if (attendanceResult.matchedCount !== 1 || attendanceResult.modifiedCount !== 1) {
        fail('ATTENDANCE_SUBMISSION_CHANGED', 'The fixed attendance submission changed during migration');
      }

      const reviewResult = await AttendanceDailyReviewModel.collection.updateOne({
        _id: attendanceDailyReview._id,
        teamId: attendanceDailyReview.teamId,
        reportDate: TARGETS.reportDate,
        __v: attendanceDailyReview.__v ?? 0
      }, {
        $set: {
          summarySnapshot: targetReview.summarySnapshot,
          finalText: targetReview.finalText,
          updatedAt: targetReview.updatedAt
        },
        $inc: { __v: 1 }
      }, { session });
      if (reviewResult.matchedCount !== 1 || reviewResult.modifiedCount !== 1) {
        fail('ATTENDANCE_DAILY_REVIEW_CHANGED', 'The fixed permanent attendance review changed during migration');
      }

      const auditInputs = [
        {
          action: AUDIT_ACTIONS.DELETE,
          resourceType: AUDIT_RESOURCE_TYPES.PRODUCTION_SCHEDULE,
          resourceId: juneDuplicateSchedule._id,
          before: snapshot(juneDuplicateSchedule),
          after: snapshot({ deleted: true, canonicalScheduleId: TARGETS.juneCanonicalScheduleId })
        },
        {
          action: AUDIT_ACTIONS.DELETE,
          resourceType: AUDIT_RESOURCE_TYPES.PRODUCTION_SCHEDULE,
          resourceId: duplicateSchedule._id,
          before: snapshot(duplicateSchedule),
          after: snapshot({ deleted: true, canonicalScheduleId: TARGETS.canonicalScheduleId })
        },
        {
          action: AUDIT_ACTIONS.CORRECT,
          resourceType: AUDIT_RESOURCE_TYPES.ATTENDANCE_SUBMISSION,
          resourceId: attendanceSubmission._id,
          before: snapshot(attendanceSubmission),
          after: snapshot(targetAttendance)
        },
        {
          action: AUDIT_ACTIONS.CORRECT,
          resourceType: AUDIT_RESOURCE_TYPES.ATTENDANCE_REVIEW,
          resourceId: attendanceDailyReview._id,
          before: snapshot(attendanceDailyReview),
          after: snapshot(targetReview)
        }
      ];
      for (const input of auditInputs) {
        await auditService.recordSystem({
          ...input,
          reason: MIGRATION_REASON,
          targetTeamId: before.target.teamId,
          session
        });
      }

      const after = await analyze(session);
      if (after.blockers.length > 0 || after.state !== 'ALREADY_APPLIED' || after.operations.length !== 0) {
        fail('MIGRATION_POSTCONDITION_FAILED', 'Migration did not reach the exact idempotent target state', {
          backup,
          before: reportAnalysis(before),
          after: reportAnalysis(after),
          writePerformed: false,
          transactionRolledBack: true
        });
      }
      return {
        ...transactionalBase,
        status: 'EXECUTED',
        writePerformed: true,
        dataWrites: 4,
        auditLogsCreated: auditInputs.length,
        after: reportAnalysis(after)
      };
    }, connection, {
      code: 'ACCEPTANCE_DATA_REPAIR_TRANSACTIONS_REQUIRED',
      message: 'Acceptance data repair requires MongoDB replica-set transaction support'
    });
  }

  return Object.freeze({ analyze, run });
}

module.exports = {
  ALLOWED_EXECUTION_DATABASE,
  AcceptanceJuly2026DataRepairError,
  COLLECTIONS,
  MIGRATION_REPORT_FORMAT,
  MIGRATION_REASON,
  REQUIRED_BACKUP_COLLECTIONS,
  TARGETS,
  analyzeAcceptanceJuly2026DataRepair,
  attendanceAfterState,
  attendanceBeforeState,
  canonicalize,
  createAcceptanceJuly2026DataRepairService,
  groupScheduleConflicts,
  liveCollectionInventory,
  monthlyTotalsAreEmpty,
  normalizedDailyEntries,
  reportAnalysis,
  snapshot,
  verifyExecutionBackup
};
