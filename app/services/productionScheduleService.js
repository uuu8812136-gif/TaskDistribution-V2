'use strict';

const mongoose = require('mongoose');
const XLSX = require('xlsx');
const OrgUnit = require('../models/OrgUnit');
const ProductionSchedule = require('../models/ProductionSchedule');
const ProjectTeam = require('../models/ProjectTeam');
const ReportChangeRecord = require('../models/ReportChangeRecord');
const {
  AUDIT_ACTIONS,
  AUDIT_RESOURCE_TYPES,
  ORG_UNIT_STATUSES,
  ORG_UNIT_TYPES
} = require('../config/permissions');
const { createAuditService } = require('./auditService');
const {
  isNaturalDate,
  isNaturalMonth,
  monthForDailySlot,
  naturalDatesForMonth,
  naturalMonthFromDate,
  parseNaturalMonth
} = require('./reportCalendarService');
const {
  assertNoClientTeamId,
  createOne,
  execute,
  formulaSafe,
  integer,
  normalizeId,
  normalizePersistenceError,
  normalizeReason,
  normalizeRelatedId,
  pagination,
  plain,
  reportError,
  resolveReadTeamId
} = require('./reportingServiceSupport');
const {
  assertPermission,
  assertTeamContext
} = require('./teamContextService');
const { runWithOptionalTransaction } = require('./transactionService');

const { REPORT_CHANGE_TYPES } = ReportChangeRecord;
const DAILY_SLOT_VALUES = Object.freeze(['previous', 'current']);
const DAILY_QUANTITY_FIELDS = Object.freeze([
  'aLineDay',
  'aLineNight',
  'northLine',
  'transferCaseLine',
  'bLineDay',
  'bLineNight'
]);
const MONTHLY_QUANTITY_FIELDS = Object.freeze([
  'aLine',
  'northLine',
  'transferCaseLine',
  'bLineDay',
  'bLineNight'
]);

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

function dailySlot(value) {
  if (!DAILY_SLOT_VALUES.includes(value)) {
    throw reportError(
      400,
      'PRODUCTION_DAILY_SLOT_INVALID',
      'daily slot must be previous or current'
    );
  }
  return value;
}

function optionalQuantity(value, field, fallback = null) {
  return integer(value, field, { nullable: true, fallback });
}

function assertOnlyKeys(input, allowedKeys, field) {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) {
    throw reportError(
      400,
      'REPORT_INPUT_INVALID',
      `${field}.${unknown} is not in the fixed production template`
    );
  }
}

function normalizeDailyEntries(entries, month) {
  if (!Array.isArray(entries)) {
    throw reportError(400, 'REPORT_INPUT_INVALID', 'dailyEntries must be an array');
  }
  const monthDates = naturalDatesForMonth(month);
  if (entries.length > monthDates.length) {
    throw reportError(
      400,
      'REPORT_INPUT_INVALID',
      'dailyEntries cannot exceed the number of natural days in the month'
    );
  }
  const normalized = entries.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw reportError(400, 'REPORT_INPUT_INVALID', `dailyEntries[${index}] must be an object`);
    }
    assertOnlyKeys(entry, ['date', ...DAILY_QUANTITY_FIELDS], `dailyEntries[${index}]`);
    if (!isNaturalDate(entry.date) || naturalMonthFromDate(entry.date) !== month) {
      throw reportError(
        400,
        'REPORT_DATE_INVALID',
        `dailyEntries[${index}].date must be a real date inside ${month}`
      );
    }
    return {
      date: entry.date,
      ...Object.fromEntries(DAILY_QUANTITY_FIELDS.map((field) => [
        field,
        optionalQuantity(entry[field], `dailyEntries[${index}].${field}`)
      ]))
    };
  });
  if (new Set(normalized.map(({ date }) => date)).size !== normalized.length) {
    throw reportError(400, 'REPORT_INPUT_INVALID', 'dailyEntries must not repeat a date');
  }
  return normalized.sort((left, right) => left.date.localeCompare(right.date));
}

function normalizeMonthlyTotals(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw reportError(400, 'REPORT_INPUT_INVALID', 'monthlyTotals must be an object');
  }
  assertOnlyKeys(input, MONTHLY_QUANTITY_FIELDS, 'monthlyTotals');
  return Object.fromEntries(MONTHLY_QUANTITY_FIELDS.map((field) => [
    field,
    optionalQuantity(input[field], `monthlyTotals.${field}`)
  ]));
}

function quantityTotal(value, fields) {
  return fields.reduce((total, field) => total + (value?.[field] || 0), 0);
}

function serializeProductionSchedule(document) {
  const value = plain(document);
  const dailyEntries = (value.dailyEntries || []).map((entry) => {
    const normalized = {
      date: entry.date,
      ...Object.fromEntries(DAILY_QUANTITY_FIELDS.map((field) => [
        field,
        entry[field] ?? null
      ]))
    };
    return {
      ...normalized,
      total: quantityTotal(normalized, DAILY_QUANTITY_FIELDS)
    };
  });
  const monthlyTotals = Object.fromEntries(MONTHLY_QUANTITY_FIELDS.map((field) => [
    field,
    value.monthlyTotals?.[field] ?? null
  ]));
  return {
    _id: normalizeId(value._id),
    teamId: normalizeId(value.teamId),
    orgUnitId: normalizeId(value.orgUnitId),
    month: value.month,
    dailyEntries,
    productionPlanForecast: value.productionPlanForecast ?? null,
    monthlyTotals: {
      ...monthlyTotals,
      total: quantityTotal(monthlyTotals, MONTHLY_QUANTITY_FIELDS)
    },
    createdBy: normalizeId(value.createdBy),
    updatedBy: normalizeId(value.updatedBy),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  };
}

function completeDailyTemplate(schedule) {
  const byDate = new Map(schedule.dailyEntries.map((entry) => [entry.date, entry]));
  return {
    ...schedule,
    dailyEntries: naturalDatesForMonth(schedule.month).map((date) => (
      byDate.get(date) || {
        date,
        ...Object.fromEntries(DAILY_QUANTITY_FIELDS.map((field) => [field, null])),
        total: 0
      }
    ))
  };
}

function scheduleUserFilter(query = {}) {
  const filters = [];
  if (query.orgUnitId !== undefined && query.orgUnitId !== '') {
    filters.push({ orgUnitId: normalizeRelatedId(query.orgUnitId) });
  }
  if (query.month !== undefined && query.month !== '') {
    filters.push({ month: naturalMonth(query.month) });
  } else {
    let from;
    let to;
    if (query.fromMonth !== undefined && query.fromMonth !== '') {
      from = naturalMonth(query.fromMonth, 'fromMonth');
    }
    if (query.toMonth !== undefined && query.toMonth !== '') {
      to = naturalMonth(query.toMonth, 'toMonth');
    }
    if (from && to && from > to) {
      throw reportError(400, 'REPORT_MONTH_RANGE_INVALID', 'fromMonth must not be after toMonth');
    }
    if (from || to) {
      filters.push({
        month: {
          ...(from ? { $gte: from } : {}),
          ...(to ? { $lte: to } : {})
        }
      });
    }
  }
  return filters.length === 0 ? {} : { $and: filters };
}

function productionOrgUnitInvalid() {
  return reportError(
    400,
    'PRODUCTION_SCHEDULE_ORG_UNIT_INVALID',
    '生产排产只能由当前团队唯一的已启用一级部门维护'
  );
}

function isRetryableMaintenanceError(error) {
  return Boolean(
    error?.name === 'VersionError' ||
    error?.code === 11000 ||
    error?.code === 112 ||
    error?.hasErrorLabel?.('TransientTransactionError')
  );
}

async function retryConcurrentMaintenance(work, attempts = 5) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      lastError = error;
      if (!isRetryableMaintenanceError(error) || attempt === attempts) throw error;
    }
  }
  throw lastError;
}

function createProductionScheduleService({
  ProductionScheduleModel = ProductionSchedule,
  ReportChangeRecordModel = ReportChangeRecord,
  OrgUnitModel = OrgUnit,
  ProjectTeamModel = ProjectTeam,
  auditService = createAuditService(),
  connection = mongoose.connection,
  clock = () => new Date()
} = {}) {
  async function resolveProductionRootOrgUnit({
    teamId,
    requestedOrgUnitId,
    session = null
  }) {
    const query = OrgUnitModel.find({
      teamId,
      parentId: null,
      type: ORG_UNIT_TYPES.DEPARTMENT,
      level: 1,
      status: ORG_UNIT_STATUSES.ACTIVE
    }).sort({ sortOrder: 1, name: 1, _id: 1 }).limit(2);
    const roots = await execute(query, session);
    if (roots.length !== 1) throw productionOrgUnitInvalid();
    const root = roots[0];
    if (
      requestedOrgUnitId !== undefined &&
      requestedOrgUnitId !== null &&
      requestedOrgUnitId !== '' &&
      normalizeId(requestedOrgUnitId) !== normalizeId(root._id)
    ) {
      throw productionOrgUnitInvalid();
    }
    return root;
  }

  async function scopedRead({
    authContext,
    requestedTeamId,
    method,
    query,
    permissionKey = 'report.view'
  }) {
    assertPermission(authContext, permissionKey);
    const teamId = await resolveReadTeamId({
      authContext,
      requestedTeamId,
      ProjectTeamModel
    });
    const root = await resolveProductionRootOrgUnit({
      teamId,
      requestedOrgUnitId: query.orgUnitId
    });
    return {
      teamId,
      filter: {
        teamId,
        orgUnitId: root._id,
        ...scheduleUserFilter({ ...query, orgUnitId: undefined })
      }
    };
  }

  async function readDailySlot({
    authContext,
    requestedTeamId,
    method = 'GET',
    slot,
    query = {},
    permissionKey = 'report.view'
  }) {
    const normalizedSlot = dailySlot(slot);
    const month = monthForDailySlot(normalizedSlot, clock());
    const { teamId, filter } = await scopedRead({
      authContext,
      requestedTeamId,
      method,
      query: { ...query, month },
      permissionKey
    });
    const documents = await ProductionScheduleModel.find(filter)
      .sort({ orgUnitId: 1, _id: 1 })
      .lean();
    return {
      teamId,
      slot: normalizedSlot,
      month,
      schedules: documents.map(serializeProductionSchedule).map(completeDailyTemplate)
    };
  }

  async function getDailySlot(input) {
    const result = await readDailySlot(input);
    return {
      slot: result.slot,
      month: result.month,
      schedules: result.schedules
    };
  }

  async function listOptions({ authContext, requestedTeamId }) {
    assertPermission(authContext, 'report.view');
    const teamId = await resolveReadTeamId({
      authContext,
      requestedTeamId,
      ProjectTeamModel
    });
    const root = await resolveProductionRootOrgUnit({ teamId });
    return {
      orgUnits: [{
        _id: normalizeId(root._id),
        parentId: normalizeId(root.parentId),
        code: root.code,
        name: root.name,
        type: root.type,
        level: root.level,
        path: root.path
      }]
    };
  }

  async function listMonthlySchedules({
    authContext,
    requestedTeamId,
    method = 'GET',
    query = {}
  }) {
    const { page, pageSize, skip } = pagination(query);
    const { filter } = await scopedRead({
      authContext,
      requestedTeamId,
      method,
      query
    });
    const [documents, total] = await Promise.all([
      ProductionScheduleModel.find(filter)
        .sort({ month: -1, orgUnitId: 1, _id: 1 })
        .skip(skip)
        .limit(pageSize)
        .lean(),
      ProductionScheduleModel.countDocuments(filter)
    ]);
    return {
      productionSchedules: documents.map(serializeProductionSchedule),
      total,
      page,
      pageSize
    };
  }

  async function maintain({
    context,
    req,
    orgUnit,
    month,
    input,
    changeType,
    apply,
    now,
    session
  }) {
    const filter = {
      teamId: context.activeTeamId,
      month
    };
    let document = await execute(ProductionScheduleModel.findOne(filter), session);
    if (document && normalizeId(document.orgUnitId) !== normalizeId(orgUnit._id)) {
      throw reportError(
        409,
        'PRODUCTION_SCHEDULE_MONTH_CONFLICT',
        '当前团队该月份存在非规范组织的生产排产记录，请先完成数据修复'
      );
    }
    const created = !document;
    const before = document ? serializeProductionSchedule(document) : null;
    if (!document) {
      document = new ProductionScheduleModel({
        ...filter,
        orgUnitId: orgUnit._id,
        dailyEntries: [],
        monthlyTotals: {},
        productionPlanForecast: null,
        createdBy: context.userId,
        updatedBy: context.userId
      });
      if (session) document.$session(session);
    }
    apply(document);
    document.updatedBy = context.userId;
    await document.save({ session: session || undefined });
    const after = serializeProductionSchedule(document);
    const reason = normalizeReason(input.reason);
    await createOne(ReportChangeRecordModel, {
      teamId: context.activeTeamId,
      orgUnitId: orgUnit._id,
      resourceType: AUDIT_RESOURCE_TYPES.PRODUCTION_SCHEDULE,
      resourceId: document._id,
      changeType,
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
      resourceType: AUDIT_RESOURCE_TYPES.PRODUCTION_SCHEDULE,
      resourceId: document._id,
      before: before || undefined,
      after,
      reason,
      targetTeamId: context.activeTeamId,
      session
    });
    return after;
  }

  async function maintainDailySlot({ authContext, req, slot, input = {} }) {
    const context = assertTeamContext(authContext);
    assertPermission(context, 'report.schedule.manage');
    assertNoClientTeamId(input);
    const normalizedSlot = dailySlot(slot);
    const now = clock();
    const month = monthForDailySlot(normalizedSlot, now);
    if (
      Object.prototype.hasOwnProperty.call(input, 'month') &&
      naturalMonth(input.month) !== month
    ) {
      throw reportError(
        400,
        'PRODUCTION_DAILY_MONTH_MISMATCH',
        `${normalizedSlot} daily schedule must target ${month} in Asia/Shanghai`
      );
    }
    if (!Object.prototype.hasOwnProperty.call(input, 'dailyEntries')) {
      throw reportError(400, 'REPORT_INPUT_INVALID', 'dailyEntries is required');
    }
    const entries = normalizeDailyEntries(input.dailyEntries, month);
    const forecastSupplied = Object.prototype.hasOwnProperty.call(
      input,
      'productionPlanForecast'
    );
    const forecast = forecastSupplied
      ? optionalQuantity(input.productionPlanForecast, 'productionPlanForecast')
      : undefined;
    try {
      return await retryConcurrentMaintenance(() => runWithOptionalTransaction(async (session) => {
        const orgUnit = await resolveProductionRootOrgUnit({
          teamId: context.activeTeamId,
          requestedOrgUnitId: input.orgUnitId,
          session
        });
        const schedule = await maintain({
          context,
          req,
          orgUnit,
          month,
          input,
          changeType: REPORT_CHANGE_TYPES.DAILY_SCHEDULE_MAINTAIN,
          now,
          session,
          apply(document) {
            document.dailyEntries = entries;
            if (forecastSupplied) document.productionPlanForecast = forecast;
          }
        });
        return { slot: normalizedSlot, schedule: completeDailyTemplate(schedule) };
      }, connection));
    } catch (error) {
      throw normalizePersistenceError(error, 'PRODUCTION_SCHEDULE_MONTH_DUPLICATE');
    }
  }

  async function maintainMonthlySchedule({
    authContext,
    req,
    month,
    input = {}
  }) {
    const context = assertTeamContext(authContext);
    assertPermission(context, 'report.schedule.manage');
    assertNoClientTeamId(input);
    const normalizedMonth = naturalMonth(month);
    if (
      Object.prototype.hasOwnProperty.call(input, 'month') &&
      naturalMonth(input.month) !== normalizedMonth
    ) {
      throw reportError(400, 'PRODUCTION_MONTH_MISMATCH', 'Body month must match route month');
    }
    const monthlyTotals = normalizeMonthlyTotals(input.monthlyTotals);
    const now = clock();
    try {
      return await retryConcurrentMaintenance(() => runWithOptionalTransaction(async (session) => {
        const orgUnit = await resolveProductionRootOrgUnit({
          teamId: context.activeTeamId,
          requestedOrgUnitId: input.orgUnitId,
          session
        });
        return maintain({
          context,
          req,
          orgUnit,
          month: normalizedMonth,
          input,
          changeType: REPORT_CHANGE_TYPES.MONTHLY_SCHEDULE_MAINTAIN,
          now,
          session,
          apply(document) {
            document.monthlyTotals = monthlyTotals;
          }
        });
      }, connection));
    } catch (error) {
      throw normalizePersistenceError(error, 'PRODUCTION_SCHEDULE_MONTH_DUPLICATE');
    }
  }

  async function orgNameMap(teamId, schedules) {
    const ids = [...new Set(schedules.map(({ orgUnitId }) => orgUnitId))];
    if (ids.length === 0) return new Map();
    const orgUnits = await OrgUnitModel.find({
      _id: { $in: ids },
      teamId
    }).lean();
    return new Map(orgUnits.map((orgUnit) => [String(orgUnit._id), orgUnit.name]));
  }

  function appendDailySheet(workbook, { teamName, orgName, slot, schedule, index }) {
    const label = slot === 'previous' ? '上月' : '当月';
    const rows = [
      [formulaSafe(`${teamName}${label}-日排产明细表（${orgName}）`)],
      [
        '日期', 'A线（白班）', 'A线（夜班）', '北线',
        '分动器线（分动器、飞轮壳总成、飞轮取力器、电动箱、扭转减震器）',
        'B线（白班）', 'B线（夜班）', '合计'
      ]
    ];
    for (const entry of schedule.dailyEntries) {
      rows.push([
        entry.date,
        ...DAILY_QUANTITY_FIELDS.map((field) => entry[field] ?? ''),
        entry.total
      ]);
    }
    const totals = DAILY_QUANTITY_FIELDS.map((field) => (
      schedule.dailyEntries.reduce((total, entry) => total + (entry[field] || 0), 0)
    ));
    rows.push(['合计', ...totals, totals.reduce((total, value) => total + value, 0)]);
    rows.push(['本月生产计划（预测）：', '', '', '', schedule.productionPlanForecast ?? '']);
    const worksheet = XLSX.utils.aoa_to_sheet(rows);
    worksheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 7 } }];
    worksheet['!cols'] = [
      { wch: 14 }, { wch: 13 }, { wch: 13 }, { wch: 10 },
      { wch: 52 }, { wch: 13 }, { wch: 13 }, { wch: 12 }
    ];
    XLSX.utils.book_append_sheet(workbook, worksheet, `${label}日排产${index}`);
  }

  async function exportDailySlot({
    authContext,
    req,
    requestedTeamId,
    method = 'GET',
    slot,
    query = {}
  }) {
    const result = await readDailySlot({
      authContext,
      requestedTeamId,
      method,
      slot,
      query,
      permissionKey: 'report.export'
    });
    const team = await ProjectTeamModel.findById(result.teamId).lean();
    if (!team) throw reportError(404, 'REPORT_RECORD_NOT_FOUND', 'Project team does not exist');
    const names = await orgNameMap(result.teamId, result.schedules);
    const workbook = XLSX.utils.book_new();
    if (result.schedules.length === 0) {
      const worksheet = XLSX.utils.aoa_to_sheet([
        [formulaSafe(`${team.name}${result.slot === 'previous' ? '上月' : '当月'}-日排产明细表`)],
        ['月份', result.month],
        ['无排产记录']
      ]);
      XLSX.utils.book_append_sheet(workbook, worksheet, '日排产');
    } else {
      result.schedules.forEach((schedule, index) => appendDailySheet(workbook, {
        teamName: team.name,
        orgName: names.get(schedule.orgUnitId) || schedule.orgUnitId,
        slot: result.slot,
        schedule,
        index: index + 1
      }));
    }
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    await auditService.record({
      req,
      authContext,
      action: AUDIT_ACTIONS.EXPORT,
      resourceType: AUDIT_RESOURCE_TYPES.PRODUCTION_SCHEDULE,
      after: {
        exportType: 'DAILY',
        slot: result.slot,
        month: result.month,
        scheduleCount: result.schedules.length,
        orgUnitId: query.orgUnitId || null
      },
      targetTeamId: result.teamId
    });
    return {
      buffer,
      count: result.schedules.length,
      month: result.month,
      slot: result.slot
    };
  }

  async function exportMonthlySchedules({
    authContext,
    req,
    requestedTeamId,
    method = 'GET',
    query = {}
  }) {
    const { teamId, filter } = await scopedRead({
      authContext,
      requestedTeamId,
      method,
      query,
      permissionKey: 'report.export'
    });
    const [documents, team] = await Promise.all([
      ProductionScheduleModel.find(filter).sort({ orgUnitId: 1, month: 1 }).lean(),
      ProjectTeamModel.findById(teamId).lean()
    ]);
    if (!team) throw reportError(404, 'REPORT_RECORD_NOT_FOUND', 'Project team does not exist');
    const schedules = documents.map(serializeProductionSchedule);
    const names = await orgNameMap(teamId, schedules);
    const byOrg = new Map();
    for (const schedule of schedules) {
      if (!byOrg.has(schedule.orgUnitId)) byOrg.set(schedule.orgUnitId, []);
      byOrg.get(schedule.orgUnitId).push(schedule);
    }
    const workbook = XLSX.utils.book_new();
    if (byOrg.size === 0) {
      const worksheet = XLSX.utils.aoa_to_sheet([
        [formulaSafe(`${team.name}月排产明细表`)],
        ['日期', 'A线', '北线', '分动器线', 'B线（白）', 'B线（夜）', '合计'],
        ['无排产记录']
      ]);
      XLSX.utils.book_append_sheet(workbook, worksheet, '月排产');
    } else {
      let index = 0;
      for (const [orgUnitId, items] of byOrg) {
        index += 1;
        const rows = [
          [formulaSafe(`${team.name}月排产明细表（${names.get(orgUnitId) || orgUnitId}）`)],
          ['日期', 'A线', '北线', '分动器线', 'B线（白）', 'B线（夜）', '合计']
        ];
        for (const schedule of items) {
          rows.push([
            schedule.month,
            ...MONTHLY_QUANTITY_FIELDS.map((field) => schedule.monthlyTotals[field] ?? ''),
            schedule.monthlyTotals.total
          ]);
        }
        const worksheet = XLSX.utils.aoa_to_sheet(rows);
        worksheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 6 } }];
        worksheet['!cols'] = [
          { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 48 },
          { wch: 13 }, { wch: 13 }, { wch: 12 }
        ];
        XLSX.utils.book_append_sheet(workbook, worksheet, `月排产${index}`);
      }
    }
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    await auditService.record({
      req,
      authContext,
      action: AUDIT_ACTIONS.EXPORT,
      resourceType: AUDIT_RESOURCE_TYPES.PRODUCTION_SCHEDULE,
      after: {
        exportType: 'MONTHLY',
        scheduleCount: schedules.length,
        filters: scheduleUserFilter(query)
      },
      targetTeamId: teamId
    });
    return { buffer, count: schedules.length };
  }

  return Object.freeze({
    exportDailySlot,
    exportMonthlySchedules,
    getDailySlot,
    listOptions,
    listMonthlySchedules,
    maintainDailySlot,
    maintainMonthlySchedule
  });
}

module.exports = {
  DAILY_QUANTITY_FIELDS,
  DAILY_SLOT_VALUES,
  MONTHLY_QUANTITY_FIELDS,
  completeDailyTemplate,
  createProductionScheduleService,
  dailySlot,
  naturalMonth,
  normalizeDailyEntries,
  normalizeMonthlyTotals,
  productionOrgUnitInvalid,
  quantityTotal,
  retryConcurrentMaintenance,
  scheduleUserFilter,
  serializeProductionSchedule
};
