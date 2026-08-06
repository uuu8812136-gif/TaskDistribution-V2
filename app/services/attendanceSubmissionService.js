'use strict';

const mongoose = require('mongoose');
const XLSX = require('xlsx');
const AttendanceDailyReview = require('../models/AttendanceDailyReview');
const AttendanceSubmission = require('../models/AttendanceSubmission');
const Message = require('../models/Message');
const OrgUnit = require('../models/OrgUnit');
const ProductionSchedule = require('../models/ProductionSchedule');
const ProjectTeam = require('../models/ProjectTeam');
const ReportChangeRecord = require('../models/ReportChangeRecord');
const TeamMembership = require('../models/TeamMembership');
const User = require('../models/User');
const {
  AUDIT_ACTIONS,
  AUDIT_RESOURCE_TYPES,
  DATA_SCOPES,
  DATA_SCOPE_MODULES,
  FUNCTIONAL_ROLE_KEYS,
  MEMBERSHIP_STATUSES,
  ORG_UNIT_STATUSES,
  ORG_UNIT_TYPES,
  POSITION_KEYS,
  SESSION_MODES
} = require('../config/permissions');
const { createAuditService } = require('./auditService');
const {
  businessDateInShanghai,
  daysInNaturalMonth,
  isNaturalDate,
  isNaturalMonth,
  naturalDatesForMonth,
  parseNaturalDate,
  parseNaturalMonth,
  shiftNaturalMonth
} = require('./reportCalendarService');
const {
  assertNoClientTeamId,
  buildReadFilter,
  createOne,
  execute,
  formulaSafe,
  integer,
  listScopedOrgUnits,
  normalizeId,
  normalizePersistenceError,
  normalizeReason,
  normalizeRelatedId,
  optionalString,
  pagination,
  plain,
  reportError,
  resolveWritableOrgUnit
} = require('./reportingServiceSupport');
const {
  assertPermission,
  assertTeamContext,
  resolveModuleDataScope,
  sameId
} = require('./teamContextService');
const { runWithOptionalTransaction } = require('./transactionService');
const { productionCumulativeEndMonth } = require('./productionReportPeriodService');
const {
  isAcceptanceTimeRestrictionBypassed
} = require('../config/acceptanceTesting');

const { REPORT_CHANGE_TYPES } = ReportChangeRecord;
const {
  ATTENDANCE_QUALITY_STATUSES,
  ATTENDANCE_REVIEW_STATUSES,
  ATTENDANCE_SOURCE_TYPES
} = AttendanceSubmission;

const NAMED_QUANTITY_FIELDS = Object.freeze([
  'leave',
  'rest',
  'sickLeave',
  'absenteeism',
  'notYetEmployed',
  'pendingDeparture',
  'temporaryWorker'
]);
const SHIFT_FIELDS = Object.freeze(['actualAttendanceCount', ...NAMED_QUANTITY_FIELDS]);
const INPUT_FIELDS = Object.freeze([
  'orgUnitId',
  'reportDate',
  'authorizedHeadcount',
  'registeredHeadcount',
  'dayShift',
  'nightShift',
  'support',
  'otherRemark',
  'reason'
]);
const ATTENDANCE_DEADLINE_HOUR = 9;
const ATTENDANCE_ORG_UNIT_LEVEL = 2;
const REVIEW_RETRY_ATTEMPTS = 5;
const ACCEPTANCE_TIME_BYPASS_AUDIT_REASON = '验收测试账号临时关闭出勤时间限制';
const ATTENDANCE_MONTHLY_EXPORT_HEADERS = Object.freeze([
  '日期', '部门', '编制人数', '在册人数',
  '实际出勤', '休班', '请假', '未入职', '待离职', '旷工',
  '实际出勤', '休班', '请假', '未入职', '待离职', '旷工',
  '帮产人员', '其他情况备注'
]);

function assertOnlyKeys(input, allowedKeys, field = 'body') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw reportError(400, 'REPORT_INPUT_INVALID', `${field} must be an object`);
  }
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) {
    throw reportError(
      400,
      'REPORT_INPUT_INVALID',
      `${field}.${unknown} is not in the fixed attendance template`
    );
  }
}

function naturalDate(value, field = 'reportDate') {
  if (!isNaturalDate(value)) {
    throw reportError(
      400,
      'REPORT_DATE_INVALID',
      `${field} must be a real calendar date in YYYY-MM-DD format`
    );
  }
  return value;
}

function naturalMonth(value, field = 'month') {
  if (!isNaturalMonth(value)) {
    throw reportError(
      400,
      'REPORT_MONTH_INVALID',
      `${field} must be a real calendar month in YYYY-MM format`
    );
  }
  return value;
}

function shanghaiDeadlineInstant(reportDate) {
  const parsed = parseNaturalDate(reportDate);
  if (!parsed) naturalDate(reportDate);
  return new Date(Date.UTC(
    parsed.year,
    parsed.month - 1,
    parsed.day,
    ATTENDANCE_DEADLINE_HOUR - 8,
    0,
    0,
    0
  ));
}

function isAttendanceDeadlineReached(reportDate, now = new Date()) {
  const instant = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(instant.getTime())) throw new TypeError('now must be a valid instant');
  return instant.getTime() >= shanghaiDeadlineInstant(reportDate).getTime();
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

function attendanceActorPolicy(context) {
  const roles = new Set(context?.membership?.functionalRoleKeys || []);
  const isSuperAdmin = context?.isSuperAdmin === true;
  return Object.freeze({
    isSuperAdmin,
    isReporter: roles.has(FUNCTIONAL_ROLE_KEYS.ATTENDANCE_REPORTER),
    isOfficer: isSuperAdmin || roles.has(FUNCTIONAL_ROLE_KEYS.ATTENDANCE_OFFICER),
    reporterOrgUnitId: roles.has(FUNCTIONAL_ROLE_KEYS.ATTENDANCE_REPORTER)
      ? normalizeId(context?.membership?.orgUnitId)
      : null
  });
}

function isAttendanceOrgUnitShape(orgUnit) {
  return (
    orgUnit?.type === ORG_UNIT_TYPES.SUB_DEPARTMENT &&
    orgUnit?.level === ATTENDANCE_ORG_UNIT_LEVEL
  );
}

function attendanceOrgUnitInvalid() {
  return reportError(
    400,
    'ATTENDANCE_ORG_UNIT_INVALID',
    '所属分部只能选择当前团队已启用的二级分部'
  );
}

function assertAttendanceSubmitActor(context) {
  const policy = attendanceActorPolicy(context);
  if (!policy.isReporter && !policy.isOfficer) {
    throw reportError(
      403,
      'ATTENDANCE_SUBMITTER_ROLE_REQUIRED',
      'Only an assigned division attendance reporter or department attendance officer may submit attendance'
    );
  }
  return policy;
}

function assertAttendanceReviewActor(context) {
  const policy = attendanceActorPolicy(context);
  if (!policy.isOfficer) {
    throw reportError(
      403,
      'ATTENDANCE_OFFICER_REQUIRED',
      'Only the department attendance officer may review the daily attendance summary'
    );
  }
  const scope = resolveModuleDataScope(context, DATA_SCOPE_MODULES.REPORT_ATTENDANCE);
  if (scope.scope !== DATA_SCOPES.TEAM) {
    throw reportError(
      403,
      'ATTENDANCE_TEAM_SCOPE_REQUIRED',
      'Attendance review requires department-wide attendance scope'
    );
  }
  return policy;
}

function assertSubmissionTiming({
  context,
  policy,
  reportDate,
  input,
  now,
  timeRestrictionsBypassed = false
}) {
  const deadlineReached = isAttendanceDeadlineReached(reportDate, now);
  if (!policy.isOfficer) {
    if (!sameId(context.membership?.orgUnitId, input.orgUnitId || context.membership?.orgUnitId)) {
      throw reportError(
        400,
        'REPORT_RELATED_RESOURCE_INVALID',
        'Division attendance reporters may submit only for their assigned division'
      );
    }
    if (!timeRestrictionsBypassed && reportDate !== businessDateInShanghai(now)) {
      throw reportError(
        409,
        'ATTENDANCE_REPORTER_DATE_LOCKED',
        'Division attendance reporters may submit only the current business date'
      );
    }
    if (!timeRestrictionsBypassed && deadlineReached) {
      throw reportError(
        409,
        'ATTENDANCE_REPORTER_DEADLINE_LOCKED',
        'Division attendance is locked for reporters at 09:00 Asia/Shanghai'
      );
    }
  }
  if (
    !timeRestrictionsBypassed &&
    policy.isOfficer &&
    deadlineReached &&
    !normalizeReason(input.reason)
  ) {
    throw reportError(
      400,
      'ATTENDANCE_LATE_REASON_REQUIRED',
      'A correction reason is required for attendance officer changes at or after 09:00'
    );
  }
  return { deadlineReached, timeRestrictionsBypassed };
}

function isRetryableWriteError(error) {
  return Boolean(
    error?.code === 11000 ||
    error?.code === 112 ||
    error?.hasErrorLabel?.('TransientTransactionError') ||
    error?.hasErrorLabel?.('UnknownTransactionCommitResult')
  );
}

async function retryConcurrentWrite(work, attempts = REVIEW_RETRY_ATTEMPTS) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      lastError = error;
      if (!isRetryableWriteError(error) || attempt === attempts) throw error;
    }
  }
  throw lastError;
}

function names(value, field, fallback = []) {
  if (value === undefined || value === null) return [...fallback];
  if (!Array.isArray(value)) {
    throw reportError(400, 'REPORT_INPUT_INVALID', `${field} must be an array`);
  }
  if (value.length > 200) {
    throw reportError(400, 'REPORT_INPUT_INVALID', `${field} is too long`);
  }
  const normalized = value.map((item, index) => {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw reportError(
        400,
        'REPORT_INPUT_INVALID',
        `${field}[${index}] must be a non-empty string`
      );
    }
    const result = item.trim();
    if (result.length > 100) {
      throw reportError(400, 'REPORT_INPUT_INVALID', `${field}[${index}] is too long`);
    }
    return result;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw reportError(400, 'REPORT_INPUT_INVALID', `${field} must not contain duplicates`);
  }
  return normalized;
}

function normalizeNamedQuantity(value, field, fallback = {}) {
  if (value === undefined || value === null) {
    return {
      count: fallback.count || 0,
      names: names(undefined, `${field}.names`, fallback.names || [])
    };
  }
  assertOnlyKeys(value, ['count', 'names'], field);
  return {
    count: integer(value.count, `${field}.count`, { fallback: fallback.count || 0 }),
    names: names(value.names, `${field}.names`, fallback.names || [])
  };
}

function normalizeShift(value, field, fallback = {}) {
  if (value === undefined || value === null) value = {};
  assertOnlyKeys(value, SHIFT_FIELDS, field);
  return {
    actualAttendanceCount: integer(
      value.actualAttendanceCount,
      `${field}.actualAttendanceCount`,
      { fallback: fallback.actualAttendanceCount || 0 }
    ),
    ...Object.fromEntries(NAMED_QUANTITY_FIELDS.map((name) => [
      name,
      normalizeNamedQuantity(value[name], `${field}.${name}`, fallback[name] || {})
    ]))
  };
}

function normalizeSupport(value, fallback = {}) {
  if (value === undefined || value === null) value = {};
  assertOnlyKeys(value, ['destination', 'count', 'names'], 'support');
  return {
    destination: optionalString(
      value.destination,
      'support.destination',
      200,
      fallback.destination || ''
    ),
    count: integer(value.count, 'support.count', { fallback: fallback.count || 0 }),
    names: names(value.names, 'support.names', fallback.names || [])
  };
}

function sourceValue(value) {
  return value ? plain(value) : {};
}

function attendancePayload(input, existing, defaultDate) {
  assertOnlyKeys(input, INPUT_FIELDS);
  const previous = existing || {};
  const reportDate = input.reportDate === undefined
    ? previous.reportDate || defaultDate
    : naturalDate(input.reportDate);
  return {
    reportDate,
    authorizedHeadcount: integer(input.authorizedHeadcount, 'authorizedHeadcount', {
      fallback: previous.authorizedHeadcount || 0
    }),
    registeredHeadcount: integer(input.registeredHeadcount, 'registeredHeadcount', {
      fallback: previous.registeredHeadcount || 0
    }),
    dayShift: normalizeShift(input.dayShift, 'dayShift', sourceValue(previous.dayShift)),
    nightShift: normalizeShift(input.nightShift, 'nightShift', sourceValue(previous.nightShift)),
    support: normalizeSupport(input.support, sourceValue(previous.support)),
    otherRemark: optionalString(
      input.otherRemark,
      'otherRemark',
      2000,
      previous.otherRemark || ''
    )
  };
}

function serializeNamedQuantity(value = {}) {
  return {
    count: value.count || 0,
    names: [...(value.names || [])]
  };
}

function serializeShift(value = {}) {
  return {
    actualAttendanceCount: value.actualAttendanceCount || 0,
    effectiveActualAttendanceCount: effectiveActualAttendanceCount(value),
    ...Object.fromEntries(NAMED_QUANTITY_FIELDS.map((field) => [
      field,
      serializeNamedQuantity(value[field])
    ]))
  };
}

function effectiveActualAttendanceCount(value = {}) {
  return (
    (value.actualAttendanceCount || 0) +
    (value.notYetEmployed?.count || 0) +
    (value.temporaryWorker?.count || 0)
  );
}

function serializeAttendanceSubmission(document) {
  const value = plain(document);
  return {
    _id: normalizeId(value._id),
    teamId: normalizeId(value.teamId),
    orgUnitId: normalizeId(value.orgUnitId),
    reportDate: value.reportDate,
    authorizedHeadcount: value.authorizedHeadcount || 0,
    registeredHeadcount: value.registeredHeadcount || 0,
    dayShift: serializeShift(value.dayShift),
    nightShift: serializeShift(value.nightShift),
    support: {
      destination: value.support?.destination || '',
      count: value.support?.count || 0,
      names: [...(value.support?.names || [])]
    },
    otherRemark: value.otherRemark || '',
    reviewStatus: value.reviewStatus,
    reviewedAt: value.reviewedAt || null,
    reviewedBy: normalizeId(value.reviewedBy),
    dataQualityStatus: value.dataQualityStatus,
    dataQualityIssues: (value.dataQualityIssues || []).map((issue) => ({
      code: issue.code,
      message: issue.message,
      sourceValue: issue.sourceValue ?? null,
      calculatedValue: issue.calculatedValue ?? null,
      sourceReference: issue.sourceReference || ''
    })),
    source: {
      type: value.source?.type || ATTENDANCE_SOURCE_TYPES.MANUAL,
      fileName: value.source?.fileName || '',
      sheetName: value.source?.sheetName || '',
      cellReference: value.source?.cellReference || '',
      rawText: value.source?.rawText || '',
      importTag: value.source?.importTag || '',
      sourceSha256: value.source?.sourceSha256 || ''
    },
    submittedAt: value.submittedAt,
    createdBy: normalizeId(value.createdBy),
    updatedBy: normalizeId(value.updatedBy),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    pendingDepartureCount: (
      (value.dayShift?.pendingDeparture?.count || 0) +
      (value.nightShift?.pendingDeparture?.count || 0)
    ),
    actualAttendanceCount: (
      effectiveActualAttendanceCount(value.dayShift) +
      effectiveActualAttendanceCount(value.nightShift)
    )
  };
}

function serializeAttendanceDailyReview(document) {
  if (!document) return null;
  const value = plain(document);
  return {
    _id: normalizeId(value._id),
    teamId: normalizeId(value.teamId),
    reportDate: value.reportDate,
    expectedOrgUnitIds: (value.expectedOrgUnitIds || []).map(normalizeId),
    submissionIds: (value.submissionIds || []).map(normalizeId),
    summarySnapshot: value.summarySnapshot,
    finalText: value.finalText,
    reviewedBy: normalizeId(value.reviewedBy),
    reviewedAt: value.reviewedAt,
    createdAt: value.createdAt
  };
}

function submissionAccessPolicy(
  document,
  authContext,
  now,
  { timeRestrictionsBypassed = false } = {}
) {
  const value = serializeAttendanceSubmission(document);
  const actor = attendanceActorPolicy(authContext);
  if (value.reviewStatus === ATTENDANCE_REVIEW_STATUSES.REVIEWED) {
    return { editable: false, lockReason: 'REVIEWED_PERMANENT_LOCK' };
  }
  if (
    !timeRestrictionsBypassed &&
    !actor.isOfficer &&
    actor.isReporter &&
    isAttendanceDeadlineReached(value.reportDate, now)
  ) {
    return { editable: false, lockReason: 'REPORTER_09_00_LOCK' };
  }
  if (!actor.isOfficer && !actor.isReporter) {
    return { editable: false, lockReason: 'ATTENDANCE_ROLE_REQUIRED' };
  }
  return {
    editable: true,
    lockReason: null,
    lateReasonRequired: (
      !timeRestrictionsBypassed &&
      actor.isOfficer &&
      isAttendanceDeadlineReached(value.reportDate, now)
    ),
    timeRestrictionsBypassed
  };
}

function attendanceUserFilter(query = {}) {
  const filters = [];
  if (query.orgUnitId !== undefined && query.orgUnitId !== '') {
    filters.push({ orgUnitId: normalizeRelatedId(query.orgUnitId) });
  }
  if (query.date !== undefined && query.date !== '') {
    filters.push({ reportDate: naturalDate(query.date, 'date') });
  } else {
    const range = {};
    if (query.dateFrom !== undefined && query.dateFrom !== '') {
      range.$gte = naturalDate(query.dateFrom, 'dateFrom');
    }
    if (query.dateTo !== undefined && query.dateTo !== '') {
      range.$lte = naturalDate(query.dateTo, 'dateTo');
    }
    if (Object.keys(range).length > 0) filters.push({ reportDate: range });
  }
  if (query.dataQualityStatus !== undefined && query.dataQualityStatus !== '') {
    if (!Object.values(ATTENDANCE_QUALITY_STATUSES).includes(query.dataQualityStatus)) {
      throw reportError(400, 'REPORT_INPUT_INVALID', 'dataQualityStatus is invalid');
    }
    filters.push({ dataQualityStatus: query.dataQualityStatus });
  }
  if (query.reviewStatus !== undefined && query.reviewStatus !== '') {
    if (!Object.values(ATTENDANCE_REVIEW_STATUSES).includes(query.reviewStatus)) {
      throw reportError(400, 'REPORT_INPUT_INVALID', 'reviewStatus is invalid');
    }
    filters.push({ reviewStatus: query.reviewStatus });
  }
  if (filters.length === 0) return {};
  return filters.length === 1 ? filters[0] : { $and: filters };
}

function uniqueNames(values) {
  return [...new Set(values.filter(Boolean))];
}

function plannedAttendanceCount(summary = {}, field) {
  const shift = summary[field] || {};
  const hasShiftData = (
    (shift.actualAttendanceCount || 0) > 0 ||
    NAMED_QUANTITY_FIELDS.some((key) => (shift[key]?.count || 0) > 0)
  );
  if (!hasShiftData) return 0;
  return Math.max(
    0,
    (shift.actualAttendanceCount || 0) +
      (shift.leave?.count || 0) +
      (shift.absenteeism?.count || 0)
  );
}

function summarizeShift(documents, field) {
  const shift = (document) => document[field] || {};
  const named = Object.fromEntries(NAMED_QUANTITY_FIELDS.map((category) => [
    category,
    {
      count: documents.reduce(
        (sum, document) => sum + (shift(document)[category]?.count || 0),
        0
      ),
      names: uniqueNames(documents.flatMap(
        (document) => shift(document)[category]?.names || []
      ))
    }
  ]));
  const reportedActualAttendanceCount = documents.reduce(
      (sum, document) => sum + (shift(document).actualAttendanceCount || 0),
      0
    );
  return {
    reportedActualAttendanceCount,
    actualAttendanceCount: (
      reportedActualAttendanceCount +
      named.notYetEmployed.count +
      named.temporaryWorker.count
    ),
    ...named,
    leaveWithSickCount: named.leave.count + named.sickLeave.count
  };
}

function qualitySummary(documents) {
  const issues = [];
  const keys = new Set();
  for (const document of documents) {
    for (const issue of document.dataQualityIssues || []) {
      const key = JSON.stringify([
        issue.code,
        issue.sourceValue,
        issue.calculatedValue,
        issue.sourceReference
      ]);
      if (keys.has(key)) continue;
      keys.add(key);
      issues.push({
        code: issue.code,
        message: issue.message,
        sourceValue: issue.sourceValue ?? null,
        calculatedValue: issue.calculatedValue ?? null,
        sourceReference: issue.sourceReference || ''
      });
    }
  }
  return {
    status: documents.some(
      ({ dataQualityStatus }) => dataQualityStatus === ATTENDANCE_QUALITY_STATUSES.PENDING_CONFIRMATION
    )
      ? ATTENDANCE_QUALITY_STATUSES.PENDING_CONFIRMATION
      : ATTENDANCE_QUALITY_STATUSES.CONFIRMED,
    issues
  };
}

function summarizeDocuments(documents, reportDate, orgUnits = []) {
  const dayShift = summarizeShift(documents, 'dayShift');
  const nightShift = summarizeShift(documents, 'nightShift');
  const orgUnitNames = new Map(orgUnits.map((orgUnit) => [
    normalizeId(orgUnit._id),
    orgUnit.name || ''
  ]));
  const supportGroups = new Map();
  for (const document of documents) {
    const support = document.support || {};
    if (!support.destination && !support.count && !(support.names || []).length) continue;
    const destination = support.destination || '未填写去向';
    if (!supportGroups.has(destination)) {
      supportGroups.set(destination, { destination, count: 0, names: [] });
    }
    const group = supportGroups.get(destination);
    group.count += support.count || 0;
    group.names.push(...(support.names || []));
  }
  return {
    reportDate,
    submissionCount: documents.length,
    orgUnitIds: documents.map(({ orgUnitId }) => normalizeId(orgUnitId)),
    authorizedHeadcount: documents.reduce(
      (sum, document) => sum + (document.authorizedHeadcount || 0),
      0
    ),
    registeredHeadcount: documents.reduce(
      (sum, document) => sum + (document.registeredHeadcount || 0),
      0
    ),
    dayShift,
    nightShift,
    pendingDepartureCount: (
      dayShift.pendingDeparture.count + nightShift.pendingDeparture.count
    ),
    support: [...supportGroups.values()].map((group) => ({
      ...group,
      names: uniqueNames(group.names)
    })),
    otherRemarks: documents
      .filter(({ otherRemark }) => Boolean(otherRemark))
      .map(({ orgUnitId, otherRemark }) => ({
        orgUnitId: normalizeId(orgUnitId),
        orgUnitName: orgUnitNames.get(normalizeId(orgUnitId)) || '',
        remark: otherRemark
      })),
    dataQuality: qualitySummary(documents)
  };
}

function attendanceSupportExportText(groups = []) {
  return formulaSafe(groups.map((group) => {
    const namesText = (group.names || []).join('、');
    const destination = group.destination || '未填写去向';
    return `${destination}帮产${group.count || 0}人${namesText ? `（${namesText}）` : ''}`;
  }).join('；'));
}

function attendanceMonthlyExportRows({ teamName, month, summaries = [] }) {
  const parsed = parseNaturalMonth(month);
  if (!parsed) naturalMonth(month);
  const summariesByDate = new Map(summaries.map((summary) => [summary.reportDate, summary]));
  const safeTeamName = formulaSafe(teamName);
  const rows = [
    [`${safeTeamName} ${parsed.year}年${parsed.month}月份 日出勤报表（月度汇总）`],
    ['', '', '', '', '白班', '', '', '', '', '', '夜班', '', '', '', '', '', '', ''],
    [...ATTENDANCE_MONTHLY_EXPORT_HEADERS]
  ];
  for (const date of naturalDatesForMonth(month)) {
    const summary = summariesByDate.get(date);
    const parsedDate = parseNaturalDate(date);
    const dateValue = new Date(Date.UTC(parsedDate.year, parsedDate.month - 1, parsedDate.day));
    if (!summary) {
      rows.push([dateValue, safeTeamName, ...Array(16).fill('')]);
      continue;
    }
    rows.push([
      dateValue,
      safeTeamName,
      summary.authorizedHeadcount,
      summary.registeredHeadcount,
      summary.dayShift.actualAttendanceCount,
      summary.dayShift.rest.count,
      summary.dayShift.leaveWithSickCount,
      summary.dayShift.notYetEmployed.count,
      summary.dayShift.pendingDeparture.count,
      summary.dayShift.absenteeism.count,
      summary.nightShift.actualAttendanceCount,
      summary.nightShift.rest.count,
      summary.nightShift.leaveWithSickCount,
      summary.nightShift.notYetEmployed.count,
      summary.nightShift.pendingDeparture.count,
      summary.nightShift.absenteeism.count,
      attendanceSupportExportText(summary.support),
      formulaSafe((summary.otherRemarks || []).map((item) => (
        typeof item === 'string'
          ? item
          : `${item.orgUnitName ? `${item.orgUnitName}：` : ''}${item.remark || ''}`
      )).filter(Boolean).join('；'))
    ]);
  }
  return rows;
}

const PRODUCTION_DAILY_FIELDS = Object.freeze([
  'aLineDay',
  'aLineNight',
  'northLine',
  'transferCaseLine',
  'bLineDay',
  'bLineNight'
]);
const PRODUCTION_MONTHLY_FIELDS = Object.freeze([
  'aLine',
  'northLine',
  'transferCaseLine',
  'bLineDay',
  'bLineNight'
]);

function sumValues(value, fields) {
  return fields.reduce((sum, field) => sum + (Number(value?.[field]) || 0), 0);
}

function productionDayTotals(schedules, date) {
  const totals = Object.fromEntries(PRODUCTION_DAILY_FIELDS.map((field) => [field, 0]));
  for (const schedule of schedules) {
    const entry = (schedule.dailyEntries || []).find((item) => item.date === date);
    if (!entry) continue;
    for (const field of PRODUCTION_DAILY_FIELDS) totals[field] += Number(entry[field]) || 0;
  }
  return { ...totals, total: sumValues(totals, PRODUCTION_DAILY_FIELDS) };
}

function productionRangeTotal(schedules, dateFrom, dateTo) {
  return schedules.reduce((total, schedule) => (
    total + (schedule.dailyEntries || []).reduce((subtotal, entry) => (
      entry.date >= dateFrom && entry.date <= dateTo
        ? subtotal + sumValues(entry, PRODUCTION_DAILY_FIELDS)
        : subtotal
    ), 0)
  ), 0);
}

function productionMonthlyRangeTotal(schedules, fromMonth, toMonth) {
  return schedules.reduce((total, schedule) => (
    schedule.month >= fromMonth && schedule.month <= toMonth
      ? total + sumValues(schedule.monthlyTotals, PRODUCTION_MONTHLY_FIELDS)
      : total
  ), 0);
}

function assertUniqueProductionScheduleMonths(schedules = []) {
  const counts = new Map();
  for (const schedule of schedules) {
    counts.set(schedule.month, (counts.get(schedule.month) || 0) + 1);
  }
  const duplicateMonths = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([month]) => month)
    .sort();
  if (duplicateMonths.length > 0) {
    throw reportError(
      409,
      'PRODUCTION_SCHEDULE_MONTH_CONFLICT',
      `同一团队同一月份只能有一条生产排产记录：${duplicateMonths.join('、')}`
    );
  }
}

function finalAttendanceReportText({
  teamName,
  reportDate,
  summary,
  yesterdaySummary,
  productionSchedules,
  reviewerName
}) {
  assertUniqueProductionScheduleMonths(productionSchedules);
  const parsed = parseNaturalDate(reportDate);
  const month = reportDate.slice(0, 7);
  const previousMonth = shiftNaturalMonth(month, -1);
  const yesterday = shiftNaturalDate(reportDate, -1);
  const yesterdayDayNumber = Number(yesterday.slice(-2));
  const todayProduction = productionDayTotals(productionSchedules, reportDate);
  const yesterdayProduction = productionDayTotals(productionSchedules, yesterday);
  const currentMonthCumulative = productionRangeTotal(
    productionSchedules,
    `${month}-01`,
    yesterday
  );
  const previousMonthSamePeriod = productionRangeTotal(
    productionSchedules,
    `${previousMonth}-01`,
    `${previousMonth}-${String(yesterdayDayNumber).padStart(2, '0')}`
  );
  const forecast = productionSchedules
    .filter((schedule) => schedule.month === month)
    .reduce((total, schedule) => total + (Number(schedule.productionPlanForecast) || 0), 0);
  const previousYear = parsed.year - 1;
  const cumulativeEndMonth = productionCumulativeEndMonth(parsed.month);
  const cumulativeEndMonthCode = String(cumulativeEndMonth).padStart(2, '0');
  const previousYearCumulative = productionMonthlyRangeTotal(
    productionSchedules,
    `${previousYear}-01`,
    `${previousYear}-${cumulativeEndMonthCode}`
  );
  const currentYearCumulative = productionMonthlyRangeTotal(
    productionSchedules,
    `${parsed.year}-01`,
    `${parsed.year}-${cumulativeEndMonthCode}`
  );
  const hasNightProduction = todayProduction.aLineNight > 0 || todayProduction.bLineNight > 0;
  const breakdown = hasNightProduction
    ? [
      `A线白班${todayProduction.aLineDay}台`,
      `A线夜班${todayProduction.aLineNight}台`,
      `B线白班${todayProduction.bLineDay}台`,
      `B线夜班${todayProduction.bLineNight}台`,
      `分动器线${todayProduction.transferCaseLine}台`
    ]
    : [
      `A线${todayProduction.aLineDay}台`,
      `B线${todayProduction.bLineDay}台`,
      `分动器线${todayProduction.transferCaseLine}台`
    ];
  if (todayProduction.northLine > 0) breakdown.push(`北线${todayProduction.northLine}台`);

  const todayDayPlanned = plannedAttendanceCount(summary, 'dayShift');
  const todayNightPlanned = plannedAttendanceCount(summary, 'nightShift');
  const yesterdayDayPlanned = yesterdaySummary
    ? plannedAttendanceCount(yesterdaySummary, 'dayShift')
    : '--';
  const yesterdayNightPlanned = yesterdaySummary
    ? plannedAttendanceCount(yesterdaySummary, 'nightShift')
    : '--';
  const yesterdayDayActual = yesterdaySummary?.dayShift.actualAttendanceCount ?? '--';
  const yesterdayNightActual = yesterdaySummary?.nightShift.actualAttendanceCount ?? '--';
  const todayActual = summary.dayShift.actualAttendanceCount + summary.nightShift.actualAttendanceCount;
  const todayLeave = summary.dayShift.leaveWithSickCount + summary.nightShift.leaveWithSickCount;
  const otherSituationLines = summary.support.length > 0
    ? summary.support.map((item, index) => (
      `${String.fromCodePoint(0x2460 + index)}、到${item.destination}帮产${item.count}人` +
      `${item.names.length ? `（${item.names.join('、')}）` : ''}；`
    ))
    : ['①、无帮产情况；'];
  const temporaryWorkerCount = (
    (summary.dayShift.temporaryWorker?.count || 0) +
    (summary.nightShift.temporaryWorker?.count || 0)
  );
  const temporaryWorkerNames = uniqueNames([
    ...(summary.dayShift.temporaryWorker?.names || []),
    ...(summary.nightShift.temporaryWorker?.names || [])
  ]);
  if (temporaryWorkerCount > 0 || temporaryWorkerNames.length > 0) {
    otherSituationLines.push(
      `${String.fromCodePoint(0x2460 + otherSituationLines.length)}、临时工${temporaryWorkerCount}人` +
      `${temporaryWorkerNames.length ? `（${temporaryWorkerNames.join('、')}）` : ''}；`
    );
  }
  for (const item of summary.otherRemarks || []) {
    const remark = typeof item === 'string' ? item : item?.remark;
    if (!remark) continue;
    const orgUnitName = typeof item === 'string' ? '' : item.orgUnitName;
    otherSituationLines.push(
      `${String.fromCodePoint(0x2460 + otherSituationLines.length)}、` +
      `${orgUnitName ? `${orgUnitName}：` : ''}${remark}；`
    );
  }
  otherSituationLines.push(
    `${String.fromCodePoint(0x2460 + otherSituationLines.length)}、今日实际出勤${todayActual}人，请假${todayLeave}人。`
  );

  return [
    `${parsed.month}月${parsed.day}日${teamName}生产日报`,
    `1.本月生产计划${forecast}台。`,
    `2.昨日排产计划${yesterdayProduction.total}台，实际完成${yesterdayProduction.total}台，本月累计完成${currentMonthCumulative}台，上月同期累计完成${previousMonthSamePeriod}台。`,
    `3.今日排产计划${todayProduction.total}台（${breakdown.join('、')}）。`,
    `4.${previousYear}年1-${cumulativeEndMonth}月实际生产${previousYearCumulative}台，` +
      `${parsed.year}年1-${cumulativeEndMonth}月实际生产${currentYearCumulative}台。`,
    `5.人员情况:在册人数${summary.registeredHeadcount}人，待离职${summary.pendingDepartureCount}人。` +
      `昨日白班安排出勤${yesterdayDayPlanned}人，实际出勤${yesterdayDayActual}人，` +
      `昨日夜班安排出勤${yesterdayNightPlanned}人，实际出勤${yesterdayNightActual}人；` +
      `今日白班安排出勤${todayDayPlanned}人，夜班安排出勤${todayNightPlanned}人。`,
    '6.其他情况：',
    ...otherSituationLines,
    `提报人:${reviewerName}`
  ].join('\n');
}

function createAttendanceSubmissionService({
  AttendanceDailyReviewModel = AttendanceDailyReview,
  AttendanceSubmissionModel = AttendanceSubmission,
  MessageModel = Message,
  ReportChangeRecordModel = ReportChangeRecord,
  OrgUnitModel = OrgUnit,
  ProductionScheduleModel = ProductionSchedule,
  ProjectTeamModel = ProjectTeam,
  TeamMembershipModel = TeamMembership,
  UserModel = User,
  auditService = createAuditService(),
  connection = mongoose.connection,
  clock = () => new Date(),
  timeRestrictionBypass = (authContext, now) => (
    isAcceptanceTimeRestrictionBypassed(authContext, process.env, now)
  )
} = {}) {
  if (typeof timeRestrictionBypass !== 'function') {
    throw new TypeError('timeRestrictionBypass must be a function');
  }
  async function expectedOrgUnits(teamId, session = null) {
    const query = OrgUnitModel.find({
      teamId,
      type: ORG_UNIT_TYPES.SUB_DEPARTMENT,
      level: ATTENDANCE_ORG_UNIT_LEVEL,
      status: ORG_UNIT_STATUSES.ACTIVE
    }).sort({ sortOrder: 1, name: 1, _id: 1 });
    const units = await execute(query, session);
    if (units.length === 0) {
      throw reportError(
        409,
        'ATTENDANCE_REPORTING_UNITS_NOT_CONFIGURED',
        'No active attendance divisions are configured for the team'
      );
    }
    return units;
  }

  async function resolveAttendanceOrgUnit(options) {
    try {
      const orgUnit = await resolveWritableOrgUnit({
        ...options,
        moduleKey: DATA_SCOPE_MODULES.REPORT_ATTENDANCE,
        OrgUnitModel
      });
      if (
        orgUnit.status !== ORG_UNIT_STATUSES.ACTIVE ||
        !isAttendanceOrgUnitShape(orgUnit)
      ) {
        throw attendanceOrgUnitInvalid();
      }
      return orgUnit;
    } catch (error) {
      if (error?.code === 'REPORT_RELATED_RESOURCE_INVALID') {
        throw attendanceOrgUnitInvalid();
      }
      throw error;
    }
  }

  async function activeUsers(userIds, session = null) {
    const ids = [...new Set(userIds.map(normalizeId).filter(Boolean))];
    if (ids.length === 0) return [];
    const query = UserModel.find({ _id: { $in: ids }, status: 'active' }).select('_id name');
    return execute(query, session);
  }

  async function attendanceRecipients(teamId, missingOrgUnitIds, actorUserId, session = null) {
    const query = TeamMembershipModel.find({
      teamId,
      status: MEMBERSHIP_STATUSES.ACTIVE,
      $or: [
        {
          functionalRoleKeys: FUNCTIONAL_ROLE_KEYS.ATTENDANCE_REPORTER,
          orgUnitId: { $in: missingOrgUnitIds }
        },
        { functionalRoleKeys: FUNCTIONAL_ROLE_KEYS.ATTENDANCE_OFFICER }
      ]
    });
    const memberships = await execute(query, session);
    const users = await activeUsers([
      ...memberships.map(({ userId }) => userId),
      actorUserId
    ], session);
    const activeIds = new Set(users.map(({ _id }) => normalizeId(_id)));
    return {
      reporters: memberships.filter((membership) => (
        membership.functionalRoleKeys.includes(FUNCTIONAL_ROLE_KEYS.ATTENDANCE_REPORTER) &&
        activeIds.has(normalizeId(membership.userId))
      )),
      officerUserIds: uniqueNames([
        ...memberships
          .filter(({ functionalRoleKeys }) => (
            functionalRoleKeys.includes(FUNCTIONAL_ROLE_KEYS.ATTENDANCE_OFFICER)
          ))
          .map(({ userId }) => normalizeId(userId)),
        activeIds.has(normalizeId(actorUserId)) ? normalizeId(actorUserId) : null
      ])
    };
  }

  async function upsertMessage(payload, session = null) {
    const options = { upsert: true, setDefaultsOnInsert: true };
    if (session) options.session = session;
    return MessageModel.updateOne(
      {
        teamId: payload.teamId,
        recipient: payload.recipient,
        deduplicationKey: payload.deduplicationKey
      },
      { $setOnInsert: payload },
      options
    );
  }

  async function notifyMissingAttendance({ context, reportDate, missingOrgUnits }) {
    const missingIds = missingOrgUnits.map(({ _id }) => _id);
    const recipients = await attendanceRecipients(
      context.activeTeamId,
      missingIds,
      context.userId
    );
    const missingNameById = new Map(
      missingOrgUnits.map((unit) => [normalizeId(unit._id), unit.name])
    );
    const writes = [];
    for (const membership of recipients.reporters) {
      const orgUnitId = normalizeId(membership.orgUnitId);
      writes.push(upsertMessage({
        teamId: context.activeTeamId,
        type: 'attendance_missing',
        title: '出勤日报缺报提醒',
        content: `${reportDate} ${missingNameById.get(orgUnitId) || '所属分部'}尚未提交出勤日报，请尽快补报。`,
        recipient: membership.userId,
        sender: context.userId,
        deduplicationKey: `attendance:missing:${reportDate}:reporter:${orgUnitId}`,
        extraData: {
          reportDate,
          orgUnitId,
          page: '/pages/reporting/attendance'
        }
      }));
    }
    const missingNames = missingOrgUnits.map(({ name }) => name).join('、');
    for (const userId of recipients.officerUserIds) {
      writes.push(upsertMessage({
        teamId: context.activeTeamId,
        type: 'attendance_missing',
        title: '出勤日报汇总暂不可审核',
        content: `${reportDate} 缺少以下分部日报：${missingNames}。已阻止生成和审核。`,
        recipient: userId,
        sender: context.userId,
        deduplicationKey: `attendance:missing:${reportDate}:officer`,
        extraData: {
          reportDate,
          missingOrgUnitIds: missingIds.map(normalizeId),
          page: '/pages/reporting/attendance'
        }
      }));
    }
    await Promise.all(writes);
    return { reporterCount: recipients.reporters.length, officerCount: recipients.officerUserIds.length };
  }

  async function departmentManagerUserIds(teamId, session = null) {
    const query = TeamMembershipModel.find({
      teamId,
      status: MEMBERSHIP_STATUSES.ACTIVE,
      positionKey: POSITION_KEYS.DEPARTMENT_MANAGER
    }).select('userId');
    const memberships = await execute(query, session);
    const users = await activeUsers(memberships.map(({ userId }) => userId), session);
    return users.map(({ _id }) => normalizeId(_id));
  }
  async function scopedRead({
    authContext,
    requestedTeamId,
    method = 'GET',
    query = {},
    id,
    permissionKey = 'report.view'
  }) {
    return buildReadFilter({
      authContext,
      requestedTeamId,
      method,
      moduleKey: DATA_SCOPE_MODULES.REPORT_ATTENDANCE,
      permissionKey,
      id,
      resourceName: 'Attendance submission',
      userFilter: attendanceUserFilter(query),
      ProjectTeamModel
    });
  }

  async function listOptions({ authContext, requestedTeamId }) {
    const result = await listScopedOrgUnits({
      authContext,
      requestedTeamId,
      moduleKey: DATA_SCOPE_MODULES.REPORT_ATTENDANCE,
      OrgUnitModel,
      ProjectTeamModel
    });
    const orgUnits = result.orgUnits
      .filter(isAttendanceOrgUnitShape)
      .map((orgUnit) => ({ ...orgUnit, status: ORG_UNIT_STATUSES.ACTIVE }));
    const actor = attendanceActorPolicy(authContext);
    const now = clock();
    const currentBusinessDate = businessDateInShanghai(now);
    const deadlineReached = isAttendanceDeadlineReached(currentBusinessDate, now);
    const timeRestrictionsBypassed = Boolean(timeRestrictionBypass(authContext, now));
    return {
      ...result,
      orgUnits,
      attendancePolicy: {
        isReporter: actor.isReporter,
        isOfficer: actor.isOfficer,
        reporterOrgUnitId: actor.reporterOrgUnitId,
        deadlineLocalTime: '09:00',
        timeZone: 'Asia/Shanghai',
        currentBusinessDate,
        deadlineReached,
        lateReasonRequired: !timeRestrictionsBypassed && actor.isOfficer && deadlineReached,
        canCreate: (
          actor.isOfficer ||
          (actor.isReporter && (timeRestrictionsBypassed || !deadlineReached))
        ),
        timeRestrictionsBypassed
      }
    };
  }

  async function listSubmissions({
    authContext,
    requestedTeamId,
    method = 'GET',
    query = {}
  }) {
    const { page, pageSize, skip } = pagination(query);
    const { filter } = await scopedRead({ authContext, requestedTeamId, method, query });
    const [documents, total] = await Promise.all([
      AttendanceSubmissionModel.find(filter)
        .sort({ reportDate: -1, orgUnitId: 1, _id: 1 })
        .skip(skip)
        .limit(pageSize)
        .lean(),
      AttendanceSubmissionModel.countDocuments(filter)
    ]);
    const now = clock();
    const timeRestrictionsBypassed = Boolean(timeRestrictionBypass(authContext, now));
    return {
      attendanceSubmissions: documents.map((document) => ({
        ...serializeAttendanceSubmission(document),
        accessPolicy: submissionAccessPolicy(document, authContext, now, {
          timeRestrictionsBypassed
        })
      })),
      total,
      page,
      pageSize
    };
  }

  async function getSubmission({
    authContext,
    requestedTeamId,
    method = 'GET',
    attendanceSubmissionId
  }) {
    const { filter } = await scopedRead({
      authContext,
      requestedTeamId,
      method,
      id: attendanceSubmissionId
    });
    const document = await AttendanceSubmissionModel.findOne(filter).lean();
    if (!document) {
      throw reportError(404, 'REPORT_RECORD_NOT_FOUND', 'Attendance submission does not exist');
    }
    const now = clock();
    const timeRestrictionsBypassed = Boolean(timeRestrictionBypass(authContext, now));
    return {
      ...serializeAttendanceSubmission(document),
      accessPolicy: submissionAccessPolicy(document, authContext, now, {
        timeRestrictionsBypassed
      })
    };
  }

  async function listSummaryDocuments({
    authContext,
    requestedTeamId,
    method,
    query,
    permissionKey = 'report.view'
  }) {
    const { teamId, filter } = await scopedRead({
      authContext,
      requestedTeamId,
      method,
      query,
      permissionKey
    });
    const documents = await AttendanceSubmissionModel.find(filter)
      .sort({ reportDate: 1, orgUnitId: 1, _id: 1 })
      .lean();
    return { teamId, documents };
  }

  async function getDailySummary({
    authContext,
    requestedTeamId,
    method = 'GET',
    query = {}
  }) {
    const date = query.date
      ? naturalDate(query.date, 'date')
      : businessDateInShanghai(clock());
    const { teamId, documents } = await listSummaryDocuments({
      authContext,
      requestedTeamId,
      method,
      query: { orgUnitId: query.orgUnitId, date }
    });
    const actor = attendanceActorPolicy(authContext);
    const departmentView = actor.isOfficer || authContext?.mode === 'GLOBAL_READ_ONLY';
    const expectedUnits = departmentView
      ? await expectedOrgUnits(teamId)
      : await OrgUnitModel.find({
        _id: { $in: documents.map(({ orgUnitId }) => orgUnitId) },
        teamId,
        status: ORG_UNIT_STATUSES.ACTIVE
      }).sort({ sortOrder: 1, name: 1, _id: 1 });
    const submittedIds = new Set(documents.map(({ orgUnitId }) => normalizeId(orgUnitId)));
    const missingOrgUnits = expectedUnits
      .filter(({ _id }) => !submittedIds.has(normalizeId(_id)))
      .map((unit) => ({ _id: normalizeId(unit._id), code: unit.code, name: unit.name }));
    const review = await AttendanceDailyReviewModel.findOne({ teamId, reportDate: date }).lean();
    return {
      attendanceSummary: {
        ...summarizeDocuments(documents, date, expectedUnits),
        expectedOrgUnitCount: expectedUnits.length,
        isComplete: expectedUnits.length > 0 && missingOrgUnits.length === 0,
        missingOrgUnits,
        review: serializeAttendanceDailyReview(review),
        canReview: actor.isOfficer && !review
      }
    };
  }

  async function getMonthlySummary({
    authContext,
    requestedTeamId,
    method = 'GET',
    query = {}
  }) {
    const month = naturalMonth(query.month, 'month');
    const [year, monthNumber] = month.split('-').map(Number);
    const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    const { teamId, documents } = await listSummaryDocuments({
      authContext,
      requestedTeamId,
      method,
      query: {
        orgUnitId: query.orgUnitId,
        dateFrom: `${month}-01`,
        dateTo: `${month}-${String(lastDay).padStart(2, '0')}`,
        reviewStatus: ATTENDANCE_REVIEW_STATUSES.REVIEWED
      }
    });
    const orgUnits = await expectedOrgUnits(teamId);
    const byDate = new Map();
    for (const document of documents) {
      if (!byDate.has(document.reportDate)) byDate.set(document.reportDate, []);
      byDate.get(document.reportDate).push(document);
    }
    return {
      month,
      attendanceSummaries: [...byDate.entries()].map(([date, rows]) => (
        summarizeDocuments(rows, date, orgUnits)
      )),
      submissionCount: documents.length
    };
  }

  async function exportMonthlySummary({
    authContext,
    req,
    requestedTeamId,
    method = 'GET',
    query = {}
  }) {
    assertPermission(authContext, 'report.export');
    if (authContext?.mode !== SESSION_MODES.GLOBAL_READ_ONLY) {
      const scope = resolveModuleDataScope(authContext, DATA_SCOPE_MODULES.REPORT_ATTENDANCE);
      if (scope.scope !== DATA_SCOPES.TEAM) {
        throw reportError(
          403,
          'ATTENDANCE_TEAM_SCOPE_REQUIRED',
          'Department attendance export requires department-wide attendance scope'
        );
      }
    }
    const month = naturalMonth(query.month, 'month');
    const parsed = parseNaturalMonth(month);
    const dayCount = daysInNaturalMonth(parsed.year, parsed.month);
    const { teamId, documents } = await listSummaryDocuments({
      authContext,
      requestedTeamId,
      method,
      permissionKey: 'report.export',
      query: {
        dateFrom: `${month}-01`,
        dateTo: `${month}-${String(dayCount).padStart(2, '0')}`,
        reviewStatus: ATTENDANCE_REVIEW_STATUSES.REVIEWED
      }
    });
    const team = await ProjectTeamModel.findById(teamId).lean();
    if (!team) {
      throw reportError(404, 'REPORT_RELATED_RESOURCE_NOT_FOUND', 'Project team does not exist');
    }
    const orgUnits = await expectedOrgUnits(teamId);
    const byDate = new Map();
    for (const document of documents) {
      if (!byDate.has(document.reportDate)) byDate.set(document.reportDate, []);
      byDate.get(document.reportDate).push(document);
    }
    const summaries = [...byDate.entries()].map(([date, rows]) => (
      summarizeDocuments(rows, date, orgUnits)
    ));
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.aoa_to_sheet(attendanceMonthlyExportRows({
      teamName: team.name,
      month,
      summaries
    }), { cellDates: true });
    worksheet['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 17 } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: 3 } },
      { s: { r: 1, c: 4 }, e: { r: 1, c: 9 } },
      { s: { r: 1, c: 10 }, e: { r: 1, c: 15 } },
      { s: { r: 1, c: 16 }, e: { r: 1, c: 17 } }
    ];
    worksheet['!cols'] = [
      { wch: 14 }, { wch: 20 },
      ...Array.from({ length: 14 }, () => ({ wch: 11 })),
      { wch: 36 }, { wch: 42 }
    ];
    worksheet['!rows'] = [{ hpt: 28 }, { hpt: 22 }, { hpt: 32 }];
    worksheet['!autofilter'] = { ref: `A3:R${dayCount + 3}` };
    for (let row = 4; row <= dayCount + 3; row += 1) {
      if (worksheet[`A${row}`]) worksheet[`A${row}`].z = 'yyyy"年"m"月"d"日"';
    }
    XLSX.utils.book_append_sheet(workbook, worksheet, '出勤月报-部门汇总');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', cellDates: true });
    await auditService.record({
      req,
      authContext,
      action: AUDIT_ACTIONS.EXPORT,
      resourceType: AUDIT_RESOURCE_TYPES.ATTENDANCE_MONTHLY_SUMMARY,
      after: {
        month,
        naturalDayCount: dayCount,
        reviewedDateCount: summaries.length,
        exportedSubmissionCount: documents.length,
        columns: 'A:R'
      },
      targetTeamId: teamId
    });
    return {
      buffer,
      month,
      dayCount,
      reviewedDateCount: summaries.length,
      submissionCount: documents.length
    };
  }

  async function appendChange({
    context,
    req,
    document,
    orgUnit,
    before,
    after,
    input,
    created,
    now,
    session
  }) {
    const reason = normalizeReason(input.reason);
    await createOne(ReportChangeRecordModel, {
      teamId: context.activeTeamId,
      orgUnitId: orgUnit._id,
      resourceType: AUDIT_RESOURCE_TYPES.ATTENDANCE_SUBMISSION,
      resourceId: document._id,
      changeType: created ? REPORT_CHANGE_TYPES.CREATE : REPORT_CHANGE_TYPES.UPDATE,
      before,
      after,
      operatorId: context.userId,
      reason,
      occurredAt: now
    }, session);
    await auditService.record({
      req,
      authContext: context,
      action: created ? AUDIT_ACTIONS.CREATE : AUDIT_ACTIONS.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPES.ATTENDANCE_SUBMISSION,
      resourceId: document._id,
      before: before || undefined,
      after,
      reason,
      targetTeamId: context.activeTeamId,
      session
    });
  }

  async function createSubmission({ authContext, req, input = {} }) {
    const context = assertTeamContext(authContext);
    assertPermission(context, 'report.submit');
    const policy = assertAttendanceSubmitActor(context);
    assertNoClientTeamId(input);
    const now = clock();
    const timeRestrictionsBypassed = Boolean(timeRestrictionBypass(context, now));
    const requestedDate = input.reportDate === undefined
      ? businessDateInShanghai(now)
      : naturalDate(input.reportDate);
    try {
      return await retryConcurrentWrite(() => runWithOptionalTransaction(async (session) => {
        const orgUnit = await resolveAttendanceOrgUnit({
          context,
          requestedOrgUnitId: input.orgUnitId,
          session
        });
        assertSubmissionTiming({
          context,
          policy,
          reportDate: requestedDate,
          input: { ...input, orgUnitId: normalizeId(orgUnit._id) },
          now,
          timeRestrictionsBypassed
        });
        const permanentReview = await execute(AttendanceDailyReviewModel.findOne({
          teamId: context.activeTeamId,
          reportDate: requestedDate
        }), session);
        if (permanentReview) {
          throw reportError(
            409,
            'ATTENDANCE_SUBMISSION_REVIEWED',
            'Reviewed attendance dates are permanently locked'
          );
        }
        const key = {
          teamId: context.activeTeamId,
          orgUnitId: orgUnit._id,
          reportDate: requestedDate
        };
        let document = await execute(AttendanceSubmissionModel.findOne(key), session);
        const created = !document;
        const before = document ? serializeAttendanceSubmission(document) : null;
        if (document?.reviewStatus === ATTENDANCE_REVIEW_STATUSES.REVIEWED) {
          throw reportError(
            409,
            'ATTENDANCE_SUBMISSION_REVIEWED',
            'Reviewed attendance submissions cannot be changed'
          );
        }
        if (!document) {
          document = new AttendanceSubmissionModel({
            ...key,
            reviewStatus: ATTENDANCE_REVIEW_STATUSES.PENDING_REVIEW,
            dataQualityStatus: ATTENDANCE_QUALITY_STATUSES.CONFIRMED,
            dataQualityIssues: [],
            source: { type: ATTENDANCE_SOURCE_TYPES.MANUAL },
            createdBy: context.userId
          });
          if (session) document.$session(session);
        }
        Object.assign(document, attendancePayload(input, document, requestedDate));
        document.submittedAt = now;
        document.updatedBy = context.userId;
        await document.save({ session: session || undefined });
        const after = serializeAttendanceSubmission(document);
        await appendChange({
          context,
          req,
          document,
          orgUnit,
          before,
          after,
          input: (
            timeRestrictionsBypassed && !normalizeReason(input.reason)
              ? { ...input, reason: ACCEPTANCE_TIME_BYPASS_AUDIT_REASON }
              : input
          ),
          created,
          now,
          session
        });
        return {
          ...after,
          accessPolicy: submissionAccessPolicy(document, context, now, {
            timeRestrictionsBypassed
          }),
          overwritten: !created
        };
      }, connection));
    } catch (error) {
      throw normalizePersistenceError(error, 'ATTENDANCE_SUBMISSION_DUPLICATE');
    }
  }

  async function updateSubmission({
    authContext,
    req,
    attendanceSubmissionId,
    input = {}
  }) {
    const context = assertTeamContext(authContext);
    assertPermission(context, 'report.submit');
    const policy = assertAttendanceSubmitActor(context);
    assertNoClientTeamId(input);
    const { filter } = await scopedRead({
      authContext: context,
      method: 'PATCH',
      id: attendanceSubmissionId,
      permissionKey: 'report.submit'
    });
    const now = clock();
    const timeRestrictionsBypassed = Boolean(timeRestrictionBypass(context, now));
    try {
      return await retryConcurrentWrite(() => runWithOptionalTransaction(async (session) => {
        const document = await execute(AttendanceSubmissionModel.findOne(filter), session);
        if (!document) {
          throw reportError(404, 'REPORT_RECORD_NOT_FOUND', 'Attendance submission does not exist');
        }
        if (document.reviewStatus === ATTENDANCE_REVIEW_STATUSES.REVIEWED) {
          throw reportError(
            409,
            'ATTENDANCE_SUBMISSION_REVIEWED',
            'Reviewed attendance submissions cannot be changed'
          );
        }
        const before = serializeAttendanceSubmission(document);
        const targetDate = input.reportDate === undefined
          ? document.reportDate
          : naturalDate(input.reportDate);
        const orgUnit = await resolveAttendanceOrgUnit({
          context,
          requestedOrgUnitId: input.orgUnitId,
          fallbackOrgUnitId: document.orgUnitId,
          session
        });
        assertSubmissionTiming({
          context,
          policy,
          reportDate: targetDate,
          input: { ...input, orgUnitId: normalizeId(orgUnit._id) },
          now,
          timeRestrictionsBypassed
        });
        const permanentReview = await execute(AttendanceDailyReviewModel.findOne({
          teamId: context.activeTeamId,
          reportDate: { $in: [...new Set([document.reportDate, targetDate])] }
        }), session);
        if (permanentReview) {
          throw reportError(
            409,
            'ATTENDANCE_SUBMISSION_REVIEWED',
            'Reviewed attendance dates are permanently locked'
          );
        }
        Object.assign(document, attendancePayload(input, document, document.reportDate));
        document.orgUnitId = orgUnit._id;
        document.submittedAt = now;
        document.updatedBy = context.userId;
        if (session) document.$session(session);
        await document.save({ session: session || undefined });
        const after = serializeAttendanceSubmission(document);
        await appendChange({
          context,
          req,
          document,
          orgUnit,
          before,
          after,
          input: (
            timeRestrictionsBypassed && !normalizeReason(input.reason)
              ? { ...input, reason: ACCEPTANCE_TIME_BYPASS_AUDIT_REASON }
              : input
          ),
          created: false,
          now,
          session
        });
        return {
          ...after,
          accessPolicy: submissionAccessPolicy(document, context, now, {
            timeRestrictionsBypassed
          }),
          overwritten: true
        };
      }, connection));
    } catch (error) {
      throw normalizePersistenceError(error, 'ATTENDANCE_SUBMISSION_DUPLICATE');
    }
  }

  async function reviewInputs(context, reportDate, session = null) {
    const units = await expectedOrgUnits(context.activeTeamId, session);
    const unitIds = units.map(({ _id }) => _id);
    const query = AttendanceSubmissionModel.find({
      teamId: context.activeTeamId,
      reportDate,
      orgUnitId: { $in: unitIds }
    }).sort({ orgUnitId: 1, _id: 1 });
    const submissions = await execute(query, session);
    const submitted = new Set(submissions.map(({ orgUnitId }) => normalizeId(orgUnitId)));
    const missingOrgUnits = units.filter(({ _id }) => !submitted.has(normalizeId(_id)));
    return { units, submissions, missingOrgUnits };
  }

  async function reviewDailySummary({
    authContext,
    req,
    reportDate,
    input = {}
  }) {
    const context = assertTeamContext(authContext);
    assertPermission(context, 'report.review');
    assertAttendanceReviewActor(context);
    assertNoClientTeamId(input);
    assertOnlyKeys(input, ['reason'], 'body');
    const date = naturalDate(reportDate);
    const now = clock();

    const preflight = await reviewInputs(context, date);
    if (preflight.missingOrgUnits.length > 0) {
      await notifyMissingAttendance({
        context,
        reportDate: date,
        missingOrgUnits: preflight.missingOrgUnits
      });
      const error = reportError(
        409,
        'ATTENDANCE_DAILY_INCOMPLETE',
        `Daily attendance is incomplete: ${preflight.missingOrgUnits.map(({ name }) => name).join('、')}`
      );
      error.missingOrgUnits = preflight.missingOrgUnits.map(({ _id, name }) => ({
        _id: normalizeId(_id),
        name
      }));
      throw error;
    }

    try {
      const result = await retryConcurrentWrite(() => runWithOptionalTransaction(async (session) => {
        const existing = await execute(AttendanceDailyReviewModel.findOne({
          teamId: context.activeTeamId,
          reportDate: date
        }), session);
        if (existing) {
          return {
            attendanceReview: serializeAttendanceDailyReview(existing),
            idempotent: true,
            managerNotificationCount: 0
          };
        }

        const { units, submissions, missingOrgUnits } = await reviewInputs(context, date, session);
        if (missingOrgUnits.length > 0) {
          return { incomplete: true, missingOrgUnits };
        }
        if (submissions.some(({ reviewStatus }) => reviewStatus === ATTENDANCE_REVIEW_STATUSES.REVIEWED)) {
          throw reportError(
            409,
            'ATTENDANCE_REVIEW_STATE_INVALID',
            'Attendance review state is inconsistent and cannot be reopened'
          );
        }

        const [team, reviewer, productionSchedules, yesterdayRows] = await Promise.all([
          execute(ProjectTeamModel.findById(context.activeTeamId), session),
          execute(UserModel.findById(context.userId).select('_id name username'), session),
          execute(ProductionScheduleModel.find({ teamId: context.activeTeamId }).lean(), session),
          execute(AttendanceSubmissionModel.find({
            teamId: context.activeTeamId,
            reportDate: shiftNaturalDate(date, -1),
            reviewStatus: ATTENDANCE_REVIEW_STATUSES.REVIEWED
          }).lean(), session)
        ]);
        if (!team || !reviewer) {
          throw reportError(409, 'REPORT_RELATED_RESOURCE_INVALID', 'Team or reviewer no longer exists');
        }
        const summary = summarizeDocuments(submissions, date, units);
        const yesterdaySummary = yesterdayRows.length > 0
          ? summarizeDocuments(yesterdayRows, shiftNaturalDate(date, -1))
          : null;
        const finalText = finalAttendanceReportText({
          teamName: team.name,
          reportDate: date,
          summary,
          yesterdaySummary,
          productionSchedules,
          reviewerName: reviewer.name || reviewer.username
        });
        const review = await createOne(AttendanceDailyReviewModel, {
          teamId: context.activeTeamId,
          reportDate: date,
          expectedOrgUnitIds: units.map(({ _id }) => _id),
          submissionIds: submissions.map(({ _id }) => _id),
          summarySnapshot: summary,
          finalText,
          reviewedBy: context.userId,
          reviewedAt: now
        }, session);
        const updateResult = await AttendanceSubmissionModel.updateMany(
          {
            _id: { $in: submissions.map(({ _id }) => _id) },
            teamId: context.activeTeamId,
            reportDate: date,
            reviewStatus: ATTENDANCE_REVIEW_STATUSES.PENDING_REVIEW
          },
          {
            $set: {
              reviewStatus: ATTENDANCE_REVIEW_STATUSES.REVIEWED,
              reviewedAt: now,
              reviewedBy: context.userId
            }
          },
          { session: session || undefined, runValidators: true }
        );
        if (updateResult.modifiedCount !== submissions.length) {
          throw reportError(
            409,
            'ATTENDANCE_CONCURRENT_REVIEW_CONFLICT',
            'Attendance changed while the daily review was being confirmed'
          );
        }

        const managerIds = await departmentManagerUserIds(context.activeTeamId, session);
        for (const managerId of managerIds) {
          await upsertMessage({
            teamId: context.activeTeamId,
            type: 'attendance_reviewed',
            title: '出勤日报已审核',
            content: `${date} 部门出勤日报已由考勤员审核确认，请查看。`,
            recipient: managerId,
            sender: context.userId,
            deduplicationKey: `attendance:reviewed:${date}:manager`,
            extraData: {
              reportDate: date,
              attendanceDailyReviewId: normalizeId(review._id),
              page: '/pages/reporting/attendance'
            }
          }, session);
        }
        await auditService.record({
          req,
          authContext: context,
          action: AUDIT_ACTIONS.APPROVE,
          resourceType: AUDIT_RESOURCE_TYPES.ATTENDANCE_REVIEW,
          resourceId: review._id,
          after: serializeAttendanceDailyReview(review),
          reason: normalizeReason(input.reason),
          targetTeamId: context.activeTeamId,
          session
        });
        return {
          attendanceReview: serializeAttendanceDailyReview(review),
          idempotent: false,
          managerNotificationCount: managerIds.length
        };
      }, connection));
      if (result?.incomplete) {
        await notifyMissingAttendance({
          context,
          reportDate: date,
          missingOrgUnits: result.missingOrgUnits
        });
        throw reportError(
          409,
          'ATTENDANCE_DAILY_INCOMPLETE',
          `Daily attendance is incomplete: ${result.missingOrgUnits.map(({ name }) => name).join('、')}`
        );
      }
      return result;
    } catch (error) {
      throw normalizePersistenceError(error, 'ATTENDANCE_DAILY_REVIEW_DUPLICATE');
    }
  }

  return Object.freeze({
    createSubmission,
    exportMonthlySummary,
    getDailySummary,
    getMonthlySummary,
    getSubmission,
    listOptions,
    listSubmissions,
    reviewDailySummary,
    updateSubmission
  });
}

module.exports = {
  ACCEPTANCE_TIME_BYPASS_AUDIT_REASON,
  ATTENDANCE_DEADLINE_HOUR,
  INPUT_FIELDS,
  NAMED_QUANTITY_FIELDS,
  SHIFT_FIELDS,
  attendancePayload,
  attendanceActorPolicy,
  attendanceMonthlyExportRows,
  attendanceUserFilter,
  createAttendanceSubmissionService,
  effectiveActualAttendanceCount,
  finalAttendanceReportText,
  assertUniqueProductionScheduleMonths,
  isAttendanceDeadlineReached,
  plannedAttendanceCount,
  serializeAttendanceSubmission,
  shanghaiDeadlineInstant,
  summarizeDocuments
};
