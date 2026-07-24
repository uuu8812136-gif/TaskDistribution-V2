'use strict';

const { createHash } = require('node:crypto');
const mongoose = require('mongoose');
const AttendanceDailyReview = require('../models/AttendanceDailyReview');
const AttendanceSubmission = require('../models/AttendanceSubmission');
const GeneratedDailyReport = require('../models/GeneratedDailyReport');
const ProductionSchedule = require('../models/ProductionSchedule');
const ProjectTeam = require('../models/ProjectTeam');
const User = require('../models/User');
const {
  AUDIT_ACTIONS,
  AUDIT_RESOURCE_TYPES,
  SESSION_MODES
} = require('../config/permissions');
const { createAuditService } = require('./auditService');
const {
  daysInNaturalMonth,
  isNaturalDate,
  naturalDatesForMonth,
  naturalMonthFromDate,
  parseNaturalDate,
  shiftNaturalMonth
} = require('./reportCalendarService');
const {
  assertNoClientTeamId,
  normalizeId,
  pagination,
  plain,
  reportError,
  resolveReadTeamId
} = require('./reportingServiceSupport');
const { assertPermission, assertTeamContext } = require('./teamContextService');
const { runWithOptionalTransaction } = require('./transactionService');

const { ATTENDANCE_REVIEW_STATUSES } = AttendanceSubmission;
const { MAX_REPORT_VERSIONS, MAX_SOURCE_SNAPSHOT_BYTES } = GeneratedDailyReport;

const REPORT_RULE_VERSION = 'production-daily-text-v2-2026-07-24';
const REPORT_TIME_ZONE = 'Asia/Shanghai';
const EXPECTED_ATTENDANCE_UNIT_COUNT = 7;
const PERSIST_RETRY_ATTEMPTS = 5;
const DAILY_FIELDS = Object.freeze([
  'aLineDay',
  'aLineNight',
  'northLine',
  'transferCaseLine',
  'bLineDay',
  'bLineNight'
]);
const MONTHLY_FIELDS = Object.freeze([
  'aLine',
  'northLine',
  'transferCaseLine',
  'bLineDay',
  'bLineNight'
]);
const NAMED_ATTENDANCE_FIELDS = Object.freeze([
  'leave',
  'rest',
  'sickLeave',
  'absenteeism',
  'notYetEmployed',
  'pendingDeparture',
  'temporaryWorker'
]);

function naturalDate(value, field = 'reportDate') {
  if (!isNaturalDate(value)) {
    throw reportError(
      400,
      'DAILY_REPORT_DATE_INVALID',
      `${field} must be a real calendar date in YYYY-MM-DD format`
    );
  }
  return value;
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

function dateRange(from, to) {
  if (from > to) return [];
  const values = [];
  for (let value = from; value <= to; value = shiftNaturalDate(value, 1)) {
    values.push(value);
    if (values.length > 370) {
      throw reportError(500, 'DAILY_REPORT_RANGE_INVALID', 'Daily report range is unexpectedly large');
    }
  }
  return values;
}

function sessionQuery(query, session) {
  if (session && typeof query.session === 'function') query.session(session);
  return query;
}

function stableClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function safeInlineText(value, fallback = '', maxLength = 200) {
  const normalized = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
  return normalized || fallback;
}

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function count(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw reportError(
      409,
      'DAILY_REPORT_SOURCE_INVALID',
      `${field} must be a non-negative integer in the reviewed source`
    );
  }
  return value;
}

function summaryCount(summary, path, fallback = undefined) {
  let current = summary;
  for (const segment of path.split('.')) current = current?.[segment];
  if (current === undefined && fallback !== undefined) return fallback;
  return count(current, path);
}

function plannedAttendanceCount(summary = {}, shiftName) {
  const shift = summary[shiftName] || {};
  const hasShiftData = (
    Number(shift.actualAttendanceCount || 0) > 0 ||
    NAMED_ATTENDANCE_FIELDS.some((field) => Number(shift[field]?.count || 0) > 0)
  );
  if (!hasShiftData) return 0;
  return Math.max(
    0,
    summaryCount(summary, 'registeredHeadcount') - summaryCount(summary, `${shiftName}.rest.count`)
  );
}

function shiftSnapshot(shift = {}) {
  return {
    actualAttendanceCount: count(
      shift.actualAttendanceCount ?? 0,
      'shift.actualAttendanceCount'
    ),
    ...Object.fromEntries(NAMED_ATTENDANCE_FIELDS.map((field) => [
      field,
      { count: count(shift[field]?.count ?? 0, `shift.${field}.count`) }
    ]))
  };
}

function attendanceSubmissionSnapshot(document) {
  return {
    submissionId: normalizeId(document._id),
    orgUnitId: normalizeId(document.orgUnitId),
    reportDate: document.reportDate,
    reviewStatus: document.reviewStatus,
    reviewedAt: iso(document.reviewedAt),
    updatedAt: iso(document.updatedAt),
    authorizedHeadcount: count(document.authorizedHeadcount, 'authorizedHeadcount'),
    registeredHeadcount: count(document.registeredHeadcount, 'registeredHeadcount'),
    dayShift: shiftSnapshot(document.dayShift),
    nightShift: shiftSnapshot(document.nightShift),
    support: {
      destination: safeInlineText(document.support?.destination, '', 200),
      count: count(document.support?.count ?? 0, 'support.count')
    }
  };
}

function assertReviewedSummary(summary, reportDate) {
  if (!summary || summary.reportDate !== reportDate) {
    throw reportError(
      409,
      'DAILY_REPORT_ATTENDANCE_SOURCE_INVALID',
      `Reviewed attendance snapshot is invalid for ${reportDate}`
    );
  }
  if (summaryCount(summary, 'submissionCount') !== EXPECTED_ATTENDANCE_UNIT_COUNT) {
    throw reportError(
      409,
      'DAILY_REPORT_ATTENDANCE_INCOMPLETE',
      `${reportDate} reviewed attendance must contain all seven organization units`
    );
  }
  for (const field of ['registeredHeadcount', 'pendingDepartureCount']) {
    summaryCount(summary, field);
  }
  for (const shift of ['dayShift', 'nightShift']) {
    summaryCount(summary, `${shift}.actualAttendanceCount`);
    for (const field of ['rest', 'leave', 'sickLeave', 'pendingDeparture']) {
      summaryCount(summary, `${shift}.${field}.count`);
    }
    summaryCount(summary, `${shift}.temporaryWorker.count`, 0);
  }
  if (!Array.isArray(summary.support)) {
    throw reportError(
      409,
      'DAILY_REPORT_ATTENDANCE_SOURCE_INVALID',
      `${reportDate} reviewed attendance support summary is invalid`
    );
  }
  if (summary.otherRemarks !== undefined && !Array.isArray(summary.otherRemarks)) {
    throw reportError(
      409,
      'DAILY_REPORT_ATTENDANCE_SOURCE_INVALID',
      `${reportDate} reviewed attendance remarks summary is invalid`
    );
  }
}

async function reviewedAttendanceSource({
  teamId,
  reportDate,
  AttendanceDailyReviewModel,
  AttendanceSubmissionModel,
  UserModel,
  session
}) {
  const review = await sessionQuery(
    AttendanceDailyReviewModel.findOne({ teamId, reportDate }).lean(),
    session
  );
  if (!review) {
    throw reportError(
      409,
      'DAILY_REPORT_ATTENDANCE_REVIEW_REQUIRED',
      `${reportDate} attendance must be reviewed before the production daily report can be generated`
    );
  }
  const expectedIds = (review.expectedOrgUnitIds || []).map(normalizeId);
  const submissionIds = (review.submissionIds || []).map(normalizeId);
  if (
    expectedIds.length !== EXPECTED_ATTENDANCE_UNIT_COUNT ||
    submissionIds.length !== EXPECTED_ATTENDANCE_UNIT_COUNT ||
    new Set(expectedIds).size !== EXPECTED_ATTENDANCE_UNIT_COUNT ||
    new Set(submissionIds).size !== EXPECTED_ATTENDANCE_UNIT_COUNT
  ) {
    throw reportError(
      409,
      'DAILY_REPORT_ATTENDANCE_INCOMPLETE',
      `${reportDate} reviewed attendance does not contain seven unique source records`
    );
  }
  assertReviewedSummary(review.summarySnapshot, reportDate);

  const [submissions, reviewer] = await Promise.all([
    sessionQuery(AttendanceSubmissionModel.find({
      _id: { $in: review.submissionIds },
      teamId,
      reportDate,
      reviewStatus: ATTENDANCE_REVIEW_STATUSES.REVIEWED
    }).sort({ orgUnitId: 1, _id: 1 }).lean(), session),
    sessionQuery(UserModel.findById(review.reviewedBy).select('_id username name').lean(), session)
  ]);
  const actualIds = new Set(submissions.map(({ _id }) => normalizeId(_id)));
  if (
    submissions.length !== EXPECTED_ATTENDANCE_UNIT_COUNT ||
    submissionIds.some((id) => !actualIds.has(id))
  ) {
    throw reportError(
      409,
      'DAILY_REPORT_ATTENDANCE_SOURCE_MISSING',
      `${reportDate} reviewed attendance source records are missing or no longer valid`
    );
  }
  if (!reviewer) {
    throw reportError(
      409,
      'DAILY_REPORT_ATTENDANCE_SOURCE_MISSING',
      `${reportDate} attendance reviewer no longer exists`
    );
  }
  return {
    summary: stableClone(review.summarySnapshot),
    snapshot: {
      reviewId: normalizeId(review._id),
      reportDate,
      reviewedBy: normalizeId(review.reviewedBy),
      reviewedByName: safeInlineText(reviewer.name || reviewer.username, '未知提报人', 200),
      reviewedAt: iso(review.reviewedAt),
      expectedOrgUnitIds: expectedIds,
      summary: stableClone(review.summarySnapshot),
      submissions: submissions.map(attendanceSubmissionSnapshot)
    }
  };
}

function dailyValues(entry) {
  return Object.fromEntries(DAILY_FIELDS.map((field) => [field, entry?.[field] ?? null]));
}

function monthlyValues(schedule) {
  return Object.fromEntries(MONTHLY_FIELDS.map((field) => [
    field,
    schedule.monthlyTotals?.[field] ?? null
  ]));
}

function hasMaintainedValues(value, fields) {
  return fields.some((field) => Number.isInteger(value?.[field]) && value[field] >= 0);
}

function sumFields(value, fields) {
  return fields.reduce((total, field) => total + (Number(value?.[field]) || 0), 0);
}

function addDailyTotals(target, value) {
  for (const field of DAILY_FIELDS) target[field] += Number(value?.[field]) || 0;
}

function productionSourceError(message, details = {}) {
  const error = reportError(409, 'DAILY_REPORT_PRODUCTION_SCHEDULE_REQUIRED', message);
  error.details = details;
  return error;
}

function productionSourceConflictError(month, scheduleIds) {
  const error = reportError(
    409,
    'DAILY_REPORT_PRODUCTION_SCHEDULE_CONFLICT',
    `${month} 同一团队存在多条生产排产记录，请先完成数据修复`
  );
  error.details = { month, scheduleIds };
  return error;
}

async function productionSource({ teamId, reportDate, ProductionScheduleModel, session }) {
  const parsed = parseNaturalDate(reportDate);
  const currentMonth = naturalMonthFromDate(reportDate);
  const previousMonth = shiftNaturalMonth(currentMonth, -1);
  const yesterday = shiftNaturalDate(reportDate, -1);
  const previousMonthStart = parseNaturalDate(`${previousMonth}-01`);
  const previousMonthLastDay = daysInNaturalMonth(
    previousMonthStart.year,
    previousMonthStart.month
  );
  const comparisonDay = Math.min(Number(yesterday.slice(-2)), previousMonthLastDay);
  const previousPeriodEnd = `${previousMonth}-${String(comparisonDay).padStart(2, '0')}`;
  const currentPeriodDates = dateRange(`${currentMonth}-01`, yesterday);
  const previousPeriodDates = dateRange(`${previousMonth}-01`, previousPeriodEnd);
  const dailyDates = new Set([
    reportDate,
    yesterday,
    ...currentPeriodDates,
    ...previousPeriodDates
  ]);
  const halfYearMonths = [];
  for (const year of [parsed.year - 1, parsed.year]) {
    for (let month = 1; month <= 6; month += 1) {
      halfYearMonths.push(`${year}-${String(month).padStart(2, '0')}`);
    }
  }
  const requiredMonths = [...new Set([
    currentMonth,
    previousMonth,
    ...halfYearMonths
  ])].sort();
  const schedules = await sessionQuery(
    ProductionScheduleModel.find({ teamId, month: { $in: requiredMonths } })
      .sort({ month: 1, orgUnitId: 1, _id: 1 })
      .lean(),
    session
  );
  const byMonth = new Map();
  for (const schedule of schedules) {
    if (!byMonth.has(schedule.month)) byMonth.set(schedule.month, []);
    byMonth.get(schedule.month).push(schedule);
  }
  for (const [month, monthSchedules] of byMonth) {
    if (monthSchedules.length > 1) {
      throw productionSourceConflictError(
        month,
        monthSchedules.map(({ _id }) => normalizeId(_id))
      );
    }
  }
  for (const month of requiredMonths) {
    if (!(byMonth.get(month) || []).length) {
      throw productionSourceError(`${month} production schedule is missing`, { month });
    }
  }
  const currentSchedules = byMonth.get(currentMonth) || [];
  if (currentSchedules.some(({ productionPlanForecast }) => !Number.isInteger(productionPlanForecast))) {
    throw productionSourceError(`${currentMonth} production plan forecast is not maintained`, {
      month: currentMonth,
      field: 'productionPlanForecast'
    });
  }

  for (const date of [...dailyDates].sort()) {
    const monthSchedules = byMonth.get(naturalMonthFromDate(date)) || [];
    for (const schedule of monthSchedules) {
      const entry = (schedule.dailyEntries || []).find((item) => item.date === date);
      if (!entry || !hasMaintainedValues(entry, DAILY_FIELDS)) {
        throw productionSourceError(`${date} production schedule is not maintained`, {
          date,
          orgUnitId: normalizeId(schedule.orgUnitId)
        });
      }
    }
  }
  for (const month of halfYearMonths) {
    for (const schedule of byMonth.get(month) || []) {
      if (!hasMaintainedValues(schedule.monthlyTotals, MONTHLY_FIELDS)) {
        throw productionSourceError(`${month} monthly production schedule is not maintained`, {
          month,
          orgUnitId: normalizeId(schedule.orgUnitId)
        });
      }
    }
  }

  function dayTotals(date) {
    const totals = Object.fromEntries(DAILY_FIELDS.map((field) => [field, 0]));
    for (const schedule of byMonth.get(naturalMonthFromDate(date)) || []) {
      const entry = (schedule.dailyEntries || []).find((item) => item.date === date);
      addDailyTotals(totals, entry);
    }
    return { ...totals, total: sumFields(totals, DAILY_FIELDS) };
  }

  function rangeTotal(dates) {
    return dates.reduce((total, date) => total + dayTotals(date).total, 0);
  }

  function halfYearTotal(year) {
    return schedules.reduce((total, schedule) => (
      schedule.month >= `${year}-01` && schedule.month <= `${year}-06`
        ? total + sumFields(schedule.monthlyTotals, MONTHLY_FIELDS)
        : total
    ), 0);
  }

  const today = dayTotals(reportDate);
  const previousDay = dayTotals(yesterday);
  const derived = {
    forecast: currentSchedules.reduce(
      (total, schedule) => total + schedule.productionPlanForecast,
      0
    ),
    today,
    yesterday: previousDay,
    currentMonthCumulative: rangeTotal(currentPeriodDates),
    previousMonthSamePeriod: rangeTotal(previousPeriodDates),
    previousYearHalf: halfYearTotal(parsed.year - 1),
    currentYearHalf: halfYearTotal(parsed.year),
    previousMonthSamePeriodEnd: previousPeriodEnd,
    actualCompletionSource: {
      sourceDate: yesterday,
      sourceRule: 'PREVIOUS_NATURAL_DAY_REPORT_ITEM_3_TODAY_SCHEDULE',
      quantity: previousDay.total
    }
  };
  const snapshotSchedules = schedules.map((schedule) => ({
    scheduleId: normalizeId(schedule._id),
    orgUnitId: normalizeId(schedule.orgUnitId),
    month: schedule.month,
    updatedAt: iso(schedule.updatedAt),
    productionPlanForecast: schedule.productionPlanForecast ?? null,
    dailyEntries: (schedule.dailyEntries || [])
      .filter(({ date }) => dailyDates.has(date))
      .sort((left, right) => left.date.localeCompare(right.date))
      .map((entry) => ({ date: entry.date, ...dailyValues(entry) })),
    monthlyTotals: monthlyValues(schedule)
  }));
  return {
    derived,
    snapshot: {
      currentDate: reportDate,
      previousNaturalDate: yesterday,
      currentMonth,
      previousMonth,
      requiredMonths,
      schedules: snapshotSchedules,
      derived
    }
  };
}

function buildFinalText({ teamName, reportDate, todayAttendance, yesterdayAttendance, production }) {
  const parsed = parseNaturalDate(reportDate);
  const today = production.today;
  const hasNightProduction = today.aLineNight > 0 || today.bLineNight > 0;
  const breakdown = hasNightProduction
    ? [
        `A线白班${today.aLineDay}台`,
        `A线夜班${today.aLineNight}台`,
        `B线白班${today.bLineDay}台`,
        `B线夜班${today.bLineNight}台`,
        `分动器线${today.transferCaseLine}台`
      ]
    : [
        `A线${today.aLineDay}台`,
        `B线${today.bLineDay}台`,
        `分动器线${today.transferCaseLine}台`
      ];
  if (today.northLine > 0) breakdown.push(`北线${today.northLine}台`);

  const registered = summaryCount(todayAttendance, 'registeredHeadcount');
  const pendingDeparture = summaryCount(todayAttendance, 'pendingDepartureCount');
  const todayDayPlanned = plannedAttendanceCount(todayAttendance, 'dayShift');
  const todayNightPlanned = plannedAttendanceCount(todayAttendance, 'nightShift');
  const yesterdayDayPlanned = plannedAttendanceCount(yesterdayAttendance, 'dayShift');
  const yesterdayNightPlanned = plannedAttendanceCount(yesterdayAttendance, 'nightShift');
  const todayActual = (
    summaryCount(todayAttendance, 'dayShift.actualAttendanceCount') +
    summaryCount(todayAttendance, 'nightShift.actualAttendanceCount')
  );
  const todayLeave = (
    summaryCount(todayAttendance, 'dayShift.leave.count') +
    summaryCount(todayAttendance, 'nightShift.leave.count')
  );
  const otherSituationLines = todayAttendance.support.length > 0
    ? todayAttendance.support.map((item, index) => {
        const destination = safeInlineText(item.destination, '未填写去向', 200);
        const supportCount = count(item.count ?? 0, 'support.count');
        const names = Array.isArray(item.names)
          ? item.names.map((name) => safeInlineText(name, '', 100)).filter(Boolean)
          : [];
        return `${String.fromCodePoint(0x2460 + index)}、到${destination}帮产${supportCount}人` +
          `${names.length ? `（${names.join('、')}）` : ''}；`;
      })
    : ['①、无帮产情况；'];
  const temporaryWorkerCount = (
    summaryCount(todayAttendance, 'dayShift.temporaryWorker.count', 0) +
    summaryCount(todayAttendance, 'nightShift.temporaryWorker.count', 0)
  );
  const temporaryWorkerNames = [...new Set([
    ...(todayAttendance.dayShift?.temporaryWorker?.names || []),
    ...(todayAttendance.nightShift?.temporaryWorker?.names || [])
  ].map((name) => safeInlineText(name, '', 100)).filter(Boolean))];
  if (temporaryWorkerCount > 0 || temporaryWorkerNames.length > 0) {
    otherSituationLines.push(
      `${String.fromCodePoint(0x2460 + otherSituationLines.length)}、临时工${temporaryWorkerCount}人` +
      `${temporaryWorkerNames.length ? `（${temporaryWorkerNames.join('、')}）` : ''}；`
    );
  }
  for (const item of todayAttendance.otherRemarks || []) {
    const remark = safeInlineText(typeof item === 'string' ? item : item?.remark, '', 2000);
    if (!remark) continue;
    const orgUnitName = safeInlineText(typeof item === 'string' ? '' : item?.orgUnitName, '', 200);
    otherSituationLines.push(
      `${String.fromCodePoint(0x2460 + otherSituationLines.length)}、` +
      `${orgUnitName ? `${orgUnitName}：` : ''}${remark}；`
    );
  }
  otherSituationLines.push(
    `${String.fromCodePoint(0x2460 + otherSituationLines.length)}、今日实际出勤${todayActual}人，请假${todayLeave}人。`
  );

  return [
    `${parsed.month}月${parsed.day}日${safeInlineText(teamName, '当前团队', 200)}生产日报`,
    `1.本月生产计划${production.forecast}台。`,
    `2.昨日排产计划${production.yesterday.total}台，实际完成${production.yesterday.total}台，本月累计完成${production.currentMonthCumulative}台，上月同期累计完成${production.previousMonthSamePeriod}台。`,
    `3.今日排产计划${today.total}台（${breakdown.join('、')}）。`,
    `4.${parsed.year - 1}年1-6月实际生产${production.previousYearHalf}台，${parsed.year}年1-6月实际生产${production.currentYearHalf}台。`,
    `5.人员情况:在册人数${registered}人，待离职${pendingDeparture}人。` +
      `昨日白班安排出勤${yesterdayDayPlanned}人，实际出勤${summaryCount(yesterdayAttendance, 'dayShift.actualAttendanceCount')}人，` +
      `昨日夜班安排出勤${yesterdayNightPlanned}人，实际出勤${summaryCount(yesterdayAttendance, 'nightShift.actualAttendanceCount')}人；` +
      `今日白班安排出勤${todayDayPlanned}人，夜班安排出勤${todayNightPlanned}人。`,
    '6.其他情况：',
    ...otherSituationLines
  ].join('\n');
}

function fingerprint(snapshot) {
  return createHash('sha256').update(JSON.stringify(snapshot), 'utf8').digest('hex');
}

function currentVersionEntry(value) {
  return {
    version: value.version,
    finalText: value.finalText,
    sourceFingerprint: value.sourceFingerprint,
    sourceSnapshot: value.sourceSnapshot,
    ruleVersion: value.ruleVersion,
    generatedBy: value.generatedBy,
    generatedByName: value.generatedByName,
    generatedAt: value.generatedAt
  };
}

function versionMetadata(entry) {
  return {
    version: entry.version,
    sourceFingerprint: entry.sourceFingerprint,
    ruleVersion: entry.ruleVersion,
    generatedBy: normalizeId(entry.generatedBy),
    generatedByName: entry.generatedByName,
    generatedAt: entry.generatedAt
  };
}

function serializeGeneratedDailyReport(document, selectedVersion) {
  if (!document) return null;
  const value = plain(document);
  const entries = [...(value.versions || []), currentVersionEntry(value)];
  const selected = selectedVersion === undefined
    ? entries[entries.length - 1]
    : entries.find(({ version }) => version === selectedVersion);
  if (!selected) return null;
  return {
    _id: normalizeId(value._id),
    teamId: normalizeId(value.teamId),
    reportDate: value.reportDate,
    version: selected.version,
    latestVersion: value.version,
    finalText: selected.finalText,
    sourceFingerprint: selected.sourceFingerprint,
    sourceSnapshot: selected.sourceSnapshot,
    ruleVersion: selected.ruleVersion,
    generatedBy: normalizeId(selected.generatedBy),
    generatedByName: selected.generatedByName,
    generatedAt: selected.generatedAt,
    availableVersions: entries.map(versionMetadata).reverse(),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  };
}

function listItem(document) {
  const value = plain(document);
  return {
    _id: normalizeId(value._id),
    teamId: normalizeId(value.teamId),
    reportDate: value.reportDate,
    version: value.version,
    finalText: value.finalText,
    sourceFingerprint: value.sourceFingerprint,
    ruleVersion: value.ruleVersion,
    generatedBy: normalizeId(value.generatedBy),
    generatedByName: value.generatedByName,
    generatedAt: value.generatedAt,
    versionCount: (value.versions || []).length + 1,
    updatedAt: value.updatedAt
  };
}

function parseVersion(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_REPORT_VERSIONS) {
    throw reportError(400, 'DAILY_REPORT_VERSION_INVALID', 'version is invalid');
  }
  return parsed;
}

function retryable(error) {
  return error?.name === 'VersionError' || error?.code === 11000;
}

function createGeneratedDailyReportService({
  AttendanceDailyReviewModel = AttendanceDailyReview,
  AttendanceSubmissionModel = AttendanceSubmission,
  GeneratedDailyReportModel = GeneratedDailyReport,
  ProductionScheduleModel = ProductionSchedule,
  ProjectTeamModel = ProjectTeam,
  UserModel = User,
  auditService = createAuditService(),
  connection = mongoose.connection,
  clock = () => new Date()
} = {}) {
  async function collectSources(context, reportDate, session) {
    const yesterday = shiftNaturalDate(reportDate, -1);
    const [team, generator, todayAttendance, previousAttendance, production] = await Promise.all([
      sessionQuery(ProjectTeamModel.findById(context.activeTeamId).select('_id name status').lean(), session),
      sessionQuery(UserModel.findById(context.userId).select('_id username name').lean(), session),
      reviewedAttendanceSource({
        teamId: context.activeTeamId,
        reportDate,
        AttendanceDailyReviewModel,
        AttendanceSubmissionModel,
        UserModel,
        session
      }),
      reviewedAttendanceSource({
        teamId: context.activeTeamId,
        reportDate: yesterday,
        AttendanceDailyReviewModel,
        AttendanceSubmissionModel,
        UserModel,
        session
      }),
      productionSource({
        teamId: context.activeTeamId,
        reportDate,
        ProductionScheduleModel,
        session
      })
    ]);
    if (!team || !generator) {
      throw reportError(
        409,
        'DAILY_REPORT_RELATED_RESOURCE_INVALID',
        'Team or generator no longer exists'
      );
    }
    const fingerprintSource = {
      rule: {
        version: REPORT_RULE_VERSION,
        timeZone: REPORT_TIME_ZONE,
        sourceFile: '提报类（开发）(3).xlsx',
        sourceSheet: '2.出勤日报-部门汇总',
        sourceRange: 'D4:D13'
      },
      team: {
        teamId: normalizeId(team._id),
        teamName: safeInlineText(team.name, '当前团队', 200)
      },
      attendance: {
        currentDate: todayAttendance.snapshot,
        previousNaturalDate: previousAttendance.snapshot
      },
      production: production.snapshot
    };
    const sourceFingerprint = fingerprint(fingerprintSource);
    const sourceSnapshot = {
      ...fingerprintSource,
      generation: {
        generatedBy: normalizeId(generator._id),
        generatedByName: safeInlineText(generator.name || generator.username, '未知生成者', 200)
      }
    };
    if (Buffer.byteLength(JSON.stringify(sourceSnapshot), 'utf8') > MAX_SOURCE_SNAPSHOT_BYTES) {
      throw reportError(
        409,
        'DAILY_REPORT_SOURCE_SNAPSHOT_TOO_LARGE',
        'Daily report source snapshot exceeds the 180 KB safety limit'
      );
    }
    const finalText = [
      buildFinalText({
        teamName: team.name,
        reportDate,
        todayAttendance: todayAttendance.summary,
        yesterdayAttendance: previousAttendance.summary,
        production: production.derived
      }),
      `提报人:${todayAttendance.snapshot.reviewedByName}`
    ].join('\n');
    return {
      finalText,
      sourceSnapshot,
      sourceFingerprint,
      generatedBy: generator._id,
      generatedByName: safeInlineText(generator.name || generator.username, '未知生成者', 200)
    };
  }

  async function generateDailyReport({ authContext, req, reportDate, input = {} }) {
    const context = assertTeamContext(authContext);
    assertPermission(context, 'report.daily.generate');
    assertNoClientTeamId(input);
    if (Object.keys(input).length > 0) {
      throw reportError(
        400,
        'DAILY_REPORT_INPUT_FIXED',
        'Production daily report generation does not accept custom fields'
      );
    }
    const date = naturalDate(reportDate);
    let lastError;
    for (let attempt = 1; attempt <= PERSIST_RETRY_ATTEMPTS; attempt += 1) {
      try {
        return await runWithOptionalTransaction(async (session) => {
          const sources = await collectSources(context, date, session);
          let report = await sessionQuery(GeneratedDailyReportModel.findOne({
            teamId: context.activeTeamId,
            reportDate: date
          }), session);
          if (report && report.sourceFingerprint === sources.sourceFingerprint) {
            return {
              dailyReport: serializeGeneratedDailyReport(report),
              idempotent: true,
              versionCreated: false
            };
          }
          if (report?.version >= MAX_REPORT_VERSIONS) {
            throw reportError(
              409,
              'DAILY_REPORT_VERSION_LIMIT_REACHED',
              `Daily report reached the ${MAX_REPORT_VERSIONS}-version safety limit`
            );
          }
          const now = clock();
          const before = report ? listItem(report) : null;
          if (!report) {
            report = new GeneratedDailyReportModel({
              teamId: context.activeTeamId,
              reportDate: date,
              version: 1,
              versions: [],
              ...sources,
              ruleVersion: REPORT_RULE_VERSION,
              generatedAt: now
            });
          } else {
            report.versions.push(currentVersionEntry(report));
            report.version += 1;
            report.finalText = sources.finalText;
            report.sourceFingerprint = sources.sourceFingerprint;
            report.sourceSnapshot = sources.sourceSnapshot;
            report.ruleVersion = REPORT_RULE_VERSION;
            report.generatedBy = sources.generatedBy;
            report.generatedByName = sources.generatedByName;
            report.generatedAt = now;
          }
          if (session) report.$session(session);
          await report.save({ session: session || undefined });
          const after = listItem(report);
          await auditService.record({
            req,
            authContext: context,
            action: AUDIT_ACTIONS.GENERATE,
            resourceType: AUDIT_RESOURCE_TYPES.GENERATED_DAILY_REPORT,
            resourceId: report._id,
            before: before || undefined,
            after,
            targetTeamId: context.activeTeamId,
            session
          });
          return {
            dailyReport: serializeGeneratedDailyReport(report),
            idempotent: false,
            versionCreated: true
          };
        }, connection);
      } catch (error) {
        lastError = error;
        if (!retryable(error) || attempt === PERSIST_RETRY_ATTEMPTS) throw error;
      }
    }
    throw lastError;
  }

  async function getDailyReport({
    authContext,
    requestedTeamId,
    reportDate,
    query = {}
  }) {
    assertPermission(authContext, 'report.view');
    const teamId = await resolveReadTeamId({
      authContext,
      requestedTeamId,
      ProjectTeamModel
    });
    const date = naturalDate(reportDate);
    const version = parseVersion(query.version);
    const report = await GeneratedDailyReportModel.findOne({ teamId, reportDate: date }).lean();
    if (!report) {
      throw reportError(404, 'DAILY_REPORT_NOT_FOUND', 'Production daily report does not exist');
    }
    const serialized = serializeGeneratedDailyReport(report, version);
    if (!serialized) {
      throw reportError(404, 'DAILY_REPORT_VERSION_NOT_FOUND', 'Production daily report version does not exist');
    }
    return { dailyReport: serialized };
  }

  async function listDailyReports({
    authContext,
    requestedTeamId,
    query = {}
  }) {
    assertPermission(authContext, 'report.view');
    const teamId = await resolveReadTeamId({
      authContext,
      requestedTeamId,
      ProjectTeamModel
    });
    const { page, pageSize, skip } = pagination(query);
    const filter = { teamId };
    if (query.dateFrom) filter.reportDate = { $gte: naturalDate(query.dateFrom, 'dateFrom') };
    if (query.dateTo) {
      filter.reportDate = {
        ...(filter.reportDate || {}),
        $lte: naturalDate(query.dateTo, 'dateTo')
      };
    }
    if (filter.reportDate?.$gte && filter.reportDate?.$lte && filter.reportDate.$gte > filter.reportDate.$lte) {
      throw reportError(400, 'DAILY_REPORT_DATE_RANGE_INVALID', 'dateFrom cannot be after dateTo');
    }
    const [reports, total] = await Promise.all([
      GeneratedDailyReportModel.find(filter)
        .select([
          '_id', 'teamId', 'reportDate', 'version', 'finalText',
          'sourceFingerprint', 'ruleVersion', 'generatedBy', 'generatedByName',
          'generatedAt', 'versions.version', 'updatedAt'
        ].join(' '))
        .sort({ reportDate: -1, _id: -1 })
        .skip(skip)
        .limit(pageSize)
        .lean(),
      GeneratedDailyReportModel.countDocuments(filter)
    ]);
    return {
      dailyReports: reports.map(listItem),
      total,
      page,
      pageSize
    };
  }

  return Object.freeze({
    generateDailyReport,
    getDailyReport,
    listDailyReports
  });
}

module.exports = {
  DAILY_FIELDS,
  EXPECTED_ATTENDANCE_UNIT_COUNT,
  MONTHLY_FIELDS,
  REPORT_RULE_VERSION,
  REPORT_TIME_ZONE,
  buildFinalText,
  createGeneratedDailyReportService,
  plannedAttendanceCount,
  productionSource,
  serializeGeneratedDailyReport,
  shiftNaturalDate
};
