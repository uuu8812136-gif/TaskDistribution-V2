'use strict';

const mongoose = require('mongoose');
const ExcelJS = require('exceljs');
const FileAsset = require('../models/FileAsset');
const OrgUnit = require('../models/OrgUnit');
const ProjectTeam = require('../models/ProjectTeam');
const ReportChangeRecord = require('../models/ReportChangeRecord');
const TransportMasterData = require('../models/TransportMasterData');
const TransportRecord = require('../models/TransportRecord');
const {
  AUDIT_ACTIONS,
  AUDIT_RESOURCE_TYPES,
  DATA_SCOPE_MODULES,
  FUNCTIONAL_ROLE_KEYS
} = require('../config/permissions');
const { createAuditService } = require('./auditService');
const { createFileAssetService } = require('./fileAssetService');
const {
  businessDateInShanghai,
  daysInNaturalMonth,
  isNaturalDate,
  isNaturalMonth,
  parseNaturalMonth,
  weekdayLabel
} = require('./reportCalendarService');
const {
  assertNoClientTeamId,
  assertNoLegacyPhotoFields,
  buildReadFilter,
  createOne,
  escapeRegex,
  execute,
  formulaSafe,
  integer,
  listScopedOrgUnits,
  normalizeId,
  normalizePersistenceError,
  normalizeReason,
  normalizeRelatedId,
  notFound,
  objectId,
  optionalString,
  pagination,
  plain,
  reportError,
  requiredString,
  resolveWritableOrgUnit,
  validateTransportPhotoFiles
} = require('./reportingServiceSupport');
const {
  assertPermission,
  assertTeamContext
} = require('./teamContextService');
const { runWithOptionalTransaction } = require('./transactionService');

const { REPORT_CHANGE_TYPES } = ReportChangeRecord;
const {
  TRANSPORT_DISPATCH_TYPE_VALUES,
  TRANSPORT_LOAD_FIELDS,
  TRANSPORT_SHIFT_VALUES
} = TransportRecord;
const {
  TRANSPORT_MASTER_KINDS,
  TRANSPORT_MASTER_STATUSES
} = TransportMasterData;

const TRANSPORT_SUMMARY_COMPANY_NAME = '山东载信物流有限公司';
const TRANSPORT_SUMMARY_DISPATCH_ORDER = Object.freeze(['配送', '返架']);

function transportMasterSelectionRequired() {
  return reportError(
    400,
    'TRANSPORT_MASTER_SELECTION_REQUIRED',
    'The transport master-data selections are required; update the mini program and select them again'
  );
}

function transportMasterSelectionInvalid() {
  return reportError(
    400,
    'TRANSPORT_MASTER_SELECTION_INVALID',
    'A selected transport master-data item is inactive, invalid, or outside the active team'
  );
}

function assertTransportReporter(context) {
  assertPermission(context, 'report.submit');
  if (context.isSuperAdmin === true) return context;
  if (
    context.membership?.functionalRoleKeys?.includes(
      FUNCTIONAL_ROLE_KEYS.TRANSPORT_REPORTER
    )
  ) {
    return context;
  }
  throw reportError(
    403,
    'TRANSPORT_REPORTER_REQUIRED',
    '只有运输提报员可以新增或修改运输记录'
  );
}

function naturalDate(value, field, fallback) {
  const selected = value === undefined || value === null || value === '' ? fallback : value;
  if (!isNaturalDate(selected)) {
    throw reportError(
      400,
      'REPORT_DATE_INVALID',
      `${field} must be a real calendar date in YYYY-MM-DD format`
    );
  }
  return selected;
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

function enumValue(value, values, field, fallback) {
  const selected = value === undefined ? fallback : value;
  if (!values.includes(selected)) {
    throw reportError(400, 'REPORT_INPUT_INVALID', `${field} has an unsupported value`);
  }
  return selected;
}

function normalizeLoadDetails(input, existing = null) {
  if (input === undefined) {
    if (existing) {
      return Object.fromEntries(
        TRANSPORT_LOAD_FIELDS.map(({ key }) => [key, existing[key] ?? 0])
      );
    }
    return Object.fromEntries(TRANSPORT_LOAD_FIELDS.map(({ key }) => [key, 0]));
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw reportError(400, 'REPORT_INPUT_INVALID', 'loadDetails must be an object');
  }
  const allowedKeys = new Set(TRANSPORT_LOAD_FIELDS.map(({ key }) => key));
  const unknownKey = Object.keys(input).find((key) => !allowedKeys.has(key));
  if (unknownKey) {
    throw reportError(
      400,
      'REPORT_INPUT_INVALID',
      `loadDetails.${unknownKey} is not in the fixed transport template`
    );
  }
  return Object.fromEntries(TRANSPORT_LOAD_FIELDS.map(({ key }) => [
    key,
    Object.prototype.hasOwnProperty.call(input, key)
      ? integer(input[key], `loadDetails.${key}`, { fallback: 0 })
      : existing?.[key] ?? 0
  ]));
}

function mergeLegacyLoadDetails(loadItems, loadDetails, input) {
  if (!Array.isArray(loadItems) || loadItems.length === 0 || !input) return loadItems;
  const legacyKeyByName = new Map(
    TRANSPORT_LOAD_FIELDS.map(({ key, label }) => [label, key])
  );
  return loadItems.map((item) => {
    const legacyKey = item.legacyKey || legacyKeyByName.get(item.name);
    if (!legacyKey || !Object.prototype.hasOwnProperty.call(input, legacyKey)) return item;
    return { ...item, quantity: loadDetails[legacyKey] };
  });
}

function loadTotal(loadDetails, loadItems = []) {
  if (Array.isArray(loadItems) && loadItems.length > 0) {
    return loadItems.reduce((total, item) => total + (item.quantity || 0), 0);
  }
  return TRANSPORT_LOAD_FIELDS.reduce(
    (total, { key }) => total + (loadDetails?.[key] || 0),
    0
  );
}

function serializeTransportRecord(document) {
  const value = plain(document);
  const details = Object.fromEntries(
    TRANSPORT_LOAD_FIELDS.map(({ key }) => [key, value.loadDetails?.[key] ?? 0])
  );
  const storedLoadItems = Array.isArray(value.loadItems)
    ? value.loadItems.map((item) => ({
        typeId: normalizeId(item.typeId),
        legacyKey: item.legacyKey || '',
        name: item.name,
        quantity: item.quantity || 0
      }))
    : [];
  const loadItems = storedLoadItems.length > 0
    ? storedLoadItems
    : TRANSPORT_LOAD_FIELDS.map(({ key, label }) => ({
        typeId: null,
        legacyKey: key,
        name: label,
        quantity: details[key] || 0
      }));
  return {
    _id: normalizeId(value._id),
    teamId: normalizeId(value.teamId),
    orgUnitId: normalizeId(value.orgUnitId),
    reportDate: value.reportDate,
    shift: value.shift,
    tripMasterId: normalizeId(value.tripMasterId),
    tripLabel: value.tripLabel,
    routeMasterId: normalizeId(value.routeMasterId),
    route: value.route,
    dispatchType: value.dispatchType,
    vehiclePlateMasterId: normalizeId(value.vehiclePlateMasterId),
    vehiclePlate: value.vehiclePlate,
    vehicleTypeMasterId: normalizeId(value.vehicleTypeMasterId),
    vehicleType: value.vehicleType || '',
    driverMasterId: normalizeId(value.driverMasterId),
    driverName: value.driverName,
    loadDetails: details,
    loadItems,
    loadTotal: loadTotal(details, storedLoadItems),
    photoFileIds: (value.photoFileIds || []).map(normalizeId),
    remark: value.remark || '',
    submittedAt: value.submittedAt,
    createdBy: normalizeId(value.createdBy),
    updatedBy: normalizeId(value.updatedBy),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  };
}

function serializeReportChangeRecord(document) {
  const value = plain(document);
  return {
    _id: normalizeId(value._id),
    teamId: normalizeId(value.teamId),
    orgUnitId: normalizeId(value.orgUnitId),
    resourceType: value.resourceType,
    resourceId: normalizeId(value.resourceId),
    changeType: value.changeType,
    before: value.before || null,
    after: value.after,
    operatorId: normalizeId(value.operatorId),
    reason: value.reason || null,
    occurredAt: value.occurredAt
  };
}

function transportPayload(input, existing, defaultReportDate) {
  const created = !existing;
  const hasLegacyLoadDetails = Object.prototype.hasOwnProperty.call(input, 'loadDetails');
  const normalizedLoadDetails = normalizeLoadDetails(
    hasLegacyLoadDetails ? input.loadDetails : undefined,
    existing?.loadDetails
  );
  const existingLoadItems = Array.isArray(existing?.loadItems) ? existing.loadItems : [];
  return {
    reportDate: naturalDate(
      created || Object.prototype.hasOwnProperty.call(input, 'reportDate')
        ? input.reportDate
        : existing.reportDate,
      'reportDate',
      defaultReportDate
    ),
    shift: enumValue(
      created || Object.prototype.hasOwnProperty.call(input, 'shift')
        ? input.shift
        : existing.shift,
      TRANSPORT_SHIFT_VALUES,
      'shift'
    ),
    // These are immutable historical snapshots unless the corresponding
    // master-data selection changes. Client-supplied snapshot text is ignored.
    tripLabel: created ? '' : existing.tripLabel,
    route: created ? '' : existing.route,
    dispatchType: enumValue(
      created || Object.prototype.hasOwnProperty.call(input, 'dispatchType')
        ? input.dispatchType
        : existing.dispatchType,
      TRANSPORT_DISPATCH_TYPE_VALUES,
      'dispatchType'
    ),
    vehiclePlate: created ? '' : existing.vehiclePlate,
    vehicleType: created ? '' : existing.vehicleType || '',
    driverName: created ? '' : existing.driverName,
    loadDetails: normalizedLoadDetails,
    loadItems: !Object.prototype.hasOwnProperty.call(input, 'loadItems') && hasLegacyLoadDetails
      ? mergeLegacyLoadDetails(existingLoadItems, normalizedLoadDetails, input.loadDetails)
      : existingLoadItems,
    remark: Object.prototype.hasOwnProperty.call(input, 'remark')
      ? optionalString(input.remark, 'remark', 2000)
      : existing?.remark || ''
  };
}

function transportUserFilter(query = {}) {
  const filters = [];
  if (query.date !== undefined && query.date !== '') {
    filters.push({ reportDate: naturalDate(query.date, 'date') });
  } else {
    let from;
    let to;
    if (query.dateFrom !== undefined && query.dateFrom !== '') {
      from = naturalDate(query.dateFrom, 'dateFrom');
    }
    if (query.dateTo !== undefined && query.dateTo !== '') {
      to = naturalDate(query.dateTo, 'dateTo');
    }
    if (from && to && from > to) {
      throw reportError(400, 'REPORT_DATE_RANGE_INVALID', 'dateFrom must not be after dateTo');
    }
    if (from || to) {
      filters.push({
        reportDate: {
          ...(from ? { $gte: from } : {}),
          ...(to ? { $lte: to } : {})
        }
      });
    }
  }
  if (query.orgUnitId !== undefined && query.orgUnitId !== '') {
    filters.push({ orgUnitId: normalizeRelatedId(query.orgUnitId) });
  }
  if (query.shift !== undefined && query.shift !== '') {
    filters.push({ shift: enumValue(query.shift, TRANSPORT_SHIFT_VALUES, 'shift') });
  }
  if (query.dispatchType !== undefined && query.dispatchType !== '') {
    filters.push({
      dispatchType: enumValue(
        query.dispatchType,
        TRANSPORT_DISPATCH_TYPE_VALUES,
        'dispatchType'
      )
    });
  }
  for (const [queryKey, field, max] of [
    ['tripLabel', 'tripLabel', 50],
    ['route', 'route', 200],
    ['vehiclePlate', 'vehiclePlate', 50],
    ['driverName', 'driverName', 100]
  ]) {
    if (query[queryKey] !== undefined && query[queryKey] !== '') {
      filters.push({
        [field]: requiredString(query[queryKey], queryKey, max)
      });
    }
  }
  if (query.keyword !== undefined && query.keyword !== '') {
    const value = requiredString(query.keyword, 'keyword', 100);
    const pattern = new RegExp(escapeRegex(value), 'i');
    filters.push({
      $or: [
        { tripLabel: pattern },
        { route: pattern },
        { vehiclePlate: pattern },
        { driverName: pattern }
      ]
    });
  }
  return filters.length === 0 ? {} : { $and: filters };
}

function createTransportRecordService({
  TransportRecordModel = TransportRecord,
  TransportMasterDataModel = TransportMasterData,
  ReportChangeRecordModel = ReportChangeRecord,
  FileAssetModel = FileAsset,
  OrgUnitModel = OrgUnit,
  ProjectTeamModel = ProjectTeam,
  auditService = createAuditService(),
  fileAssetService = null,
  connection = mongoose.connection,
  clock = () => new Date()
} = {}) {
  const managedFileService = fileAssetService || createFileAssetService({
    FileAssetModel,
    TransportRecordModel,
    auditService,
    connection
  });

  async function resolveLoadItemsPayload({ context, input, existing, payload, session }) {
    if (!Object.prototype.hasOwnProperty.call(input, 'loadItems')) return payload;
    if (!Array.isArray(input.loadItems) || input.loadItems.length === 0 || input.loadItems.length > 200) {
      throw reportError(
        400,
        'TRANSPORT_LOAD_ITEMS_INVALID',
        'loadItems must contain between 1 and 200 configured load types'
      );
    }

    const normalized = input.loadItems.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw reportError(400, 'TRANSPORT_LOAD_ITEMS_INVALID', `loadItems.${index} must be an object`);
      }
      const legacyField = TRANSPORT_LOAD_FIELDS.find(({ key }) => key === item.legacyKey);
      const typeId = item.typeId ? normalizeRelatedId(item.typeId) : null;
      if (!typeId && !legacyField) {
        throw reportError(
          400,
          'TRANSPORT_LOAD_ITEMS_INVALID',
          `loadItems.${index} must identify a configured load type`
        );
      }
      return {
        typeId,
        legacyKey: typeId ? '' : legacyField.key,
        legacyName: legacyField?.label || '',
        quantity: integer(item.quantity, `loadItems.${index}.quantity`, { fallback: 0 })
      };
    });
    const tokens = normalized.map(({ typeId, legacyKey }) => (
      typeId ? `id:${normalizeId(typeId)}` : `legacy:${legacyKey}`
    ));
    if (new Set(tokens).size !== tokens.length) {
      throw reportError(400, 'TRANSPORT_LOAD_ITEMS_INVALID', 'loadItems must not contain duplicate types');
    }

    const activeMasters = await execute(TransportMasterDataModel.find({
      _id: { $in: normalized.map(({ typeId }) => typeId).filter(Boolean) },
      teamId: context.activeTeamId,
      kind: TRANSPORT_MASTER_KINDS.LOAD_TYPE,
      status: TRANSPORT_MASTER_STATUSES.ACTIVE
    }).lean(), session);
    const activeById = new Map(activeMasters.map((master) => [normalizeId(master._id), master]));
    const existingByToken = new Map((existing?.loadItems || []).map((item) => [
      item.typeId ? `id:${normalizeId(item.typeId)}` : `legacy:${item.legacyKey}`,
      item
    ]));

    payload.loadItems = normalized.map(({ typeId, legacyKey, legacyName, quantity }) => {
      const id = normalizeId(typeId);
      const master = activeById.get(id);
      const token = typeId ? `id:${id}` : `legacy:${legacyKey}`;
      const previous = existingByToken.get(token);
      if (typeId && !master && !previous) {
        throw reportError(
          400,
          'TRANSPORT_LOAD_TYPE_INVALID',
          'A selected load type is inactive, deleted, invalid, or outside the active team'
        );
      }
      return {
        typeId,
        legacyKey,
        name: previous?.name || master?.name || legacyName,
        quantity
      };
    });
    return payload;
  }

  async function resolveMasterDataPayload({ context, input, existing, payload, session }) {
    const mappings = [
      {
        idField: 'tripMasterId',
        kind: TRANSPORT_MASTER_KINDS.TRIP,
        required: true,
        apply(master) {
          payload.tripLabel = master.name;
        }
      },
      {
        idField: 'routeMasterId',
        kind: TRANSPORT_MASTER_KINDS.ROUTE,
        required: true,
        apply(master) {
          payload.route = master.name;
        }
      },
      {
        idField: 'vehiclePlateMasterId',
        kind: TRANSPORT_MASTER_KINDS.VEHICLE_PLATE,
        required: true,
        apply(master) {
          payload.vehiclePlate = master.name;
        }
      },
      {
        idField: 'vehicleTypeMasterId',
        kind: TRANSPORT_MASTER_KINDS.VEHICLE_TYPE,
        required: true,
        apply(master) {
          payload.vehicleType = master?.name || '';
        }
      },
      {
        idField: 'driverMasterId',
        kind: TRANSPORT_MASTER_KINDS.DRIVER,
        required: true,
        apply(master) {
          payload.driverName = master.name;
        }
      }
    ];

    for (const mapping of mappings) {
      const suppliesMasterId = Object.prototype.hasOwnProperty.call(input, mapping.idField);
      const currentMasterId = existing?.[mapping.idField] || null;
      let masterId = currentMasterId;
      if (suppliesMasterId) {
        masterId = normalizeRelatedId(input[mapping.idField], { optional: !mapping.required });
      } else if (!existing && mapping.required) {
        throw transportMasterSelectionRequired();
      }
      payload[mapping.idField] = masterId;
      if (!masterId) {
        if (mapping.required) throw transportMasterSelectionRequired();
        if (suppliesMasterId || !existing) mapping.apply(null);
        continue;
      }
      if (existing && (!suppliesMasterId || normalizeId(masterId) === normalizeId(currentMasterId))) {
        continue;
      }
      const master = await execute(TransportMasterDataModel.findOne({
        _id: masterId,
        teamId: context.activeTeamId,
        kind: mapping.kind,
        status: TRANSPORT_MASTER_STATUSES.ACTIVE
      }), session);
      if (!master) throw transportMasterSelectionInvalid();
      mapping.apply(master);
    }
    return resolveLoadItemsPayload({ context, input, existing, payload, session });
  }
  async function scopedRead({
    authContext,
    requestedTeamId,
    method,
    id,
    query,
    permissionKey = 'report.view'
  }) {
    return buildReadFilter({
      authContext,
      requestedTeamId,
      method,
      moduleKey: DATA_SCOPE_MODULES.REPORT_TRANSPORT,
      permissionKey,
      id,
      resourceName: 'Transport record',
      userFilter: transportUserFilter(query),
      ProjectTeamModel
    });
  }

  async function listRecords({
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
      TransportRecordModel.find(filter)
        .sort({ reportDate: -1, submittedAt: -1, _id: -1 })
        .skip(skip)
        .limit(pageSize)
        .lean(),
      TransportRecordModel.countDocuments(filter)
    ]);
    return {
      transportRecords: documents.map(serializeTransportRecord),
      total,
      page,
      pageSize
    };
  }

  async function getRecord({
    authContext,
    requestedTeamId,
    method = 'GET',
    transportRecordId
  }) {
    const { filter } = await scopedRead({
      authContext,
      requestedTeamId,
      method,
      id: transportRecordId,
      query: {}
    });
    const document = await TransportRecordModel.findOne(filter).lean();
    if (!document) throw notFound('Transport record');
    return serializeTransportRecord(document);
  }

  async function listOptions({
    authContext,
    requestedTeamId
  }) {
    return listScopedOrgUnits({
      authContext,
      requestedTeamId,
      moduleKey: DATA_SCOPE_MODULES.REPORT_TRANSPORT,
      OrgUnitModel,
      ProjectTeamModel
    });
  }

  async function getHistory({
    authContext,
    requestedTeamId,
    method = 'GET',
    transportRecordId,
    query = {}
  }) {
    const transportRecord = await getRecord({
      authContext,
      requestedTeamId,
      method,
      transportRecordId
    });
    const { page, pageSize, skip } = pagination(query);
    const filter = {
      teamId: transportRecord.teamId,
      orgUnitId: transportRecord.orgUnitId,
      resourceType: AUDIT_RESOURCE_TYPES.TRANSPORT_RECORD,
      resourceId: transportRecord._id
    };
    const [documents, total] = await Promise.all([
      ReportChangeRecordModel.find(filter)
        .sort({ occurredAt: -1, _id: -1 })
        .skip(skip)
        .limit(pageSize)
        .lean(),
      ReportChangeRecordModel.countDocuments(filter)
    ]);
    return {
      transportRecord,
      changes: documents.map(serializeReportChangeRecord),
      total,
      page,
      pageSize
    };
  }

  async function createRecord({ authContext, req, input = {} }) {
    const context = assertTeamContext(authContext);
    assertTransportReporter(context);
    assertNoClientTeamId(input);
    assertNoLegacyPhotoFields(input);
    const recordId = objectId();
    try {
      return await runWithOptionalTransaction(async (session) => {
        const orgUnit = await resolveWritableOrgUnit({
          context,
          moduleKey: DATA_SCOPE_MODULES.REPORT_TRANSPORT,
          requestedOrgUnitId: input.orgUnitId,
          OrgUnitModel,
          session
        });
        const now = clock();
        const photoFileIds = await validateTransportPhotoFiles({
          context,
          values: input.photoFileIds === undefined ? [] : input.photoFileIds,
          transportRecordId: recordId,
          FileAssetModel,
          session
        });
        const payload = await resolveMasterDataPayload({
          context,
          input,
          existing: null,
          payload: transportPayload(input, null, businessDateInShanghai(now)),
          session
        });
        const document = await createOne(TransportRecordModel, {
          _id: recordId,
          teamId: context.activeTeamId,
          orgUnitId: orgUnit._id,
          ...payload,
          photoFileIds: [],
          submittedAt: now,
          createdBy: context.userId,
          updatedBy: context.userId
        }, session);
        const managedPhotos = await managedFileService.reconcileOwnerFiles({
          authContext: context,
          req,
          attachments: photoFileIds.map((fileId) => ({ fileId })),
          previousAttachments: [],
          ownerType: FileAsset.FILE_OWNER_TYPES.TRANSPORT_REPORT,
          ownerId: document._id,
          method: 'POST',
          session
        });
        document.photoFileIds = managedPhotos.map(({ fileId }) => fileId);
        await document.save({ session: session || undefined });
        const after = serializeTransportRecord(document);
        const reason = normalizeReason(input.reason);
        await createOne(ReportChangeRecordModel, {
          teamId: context.activeTeamId,
          orgUnitId: orgUnit._id,
          resourceType: AUDIT_RESOURCE_TYPES.TRANSPORT_RECORD,
          resourceId: document._id,
          changeType: REPORT_CHANGE_TYPES.CREATE,
          before: null,
          after,
          operatorId: context.userId,
          reason,
          occurredAt: now
        }, session);
        await auditService.record({
          req,
          authContext: context,
          action: AUDIT_ACTIONS.CREATE,
          resourceType: AUDIT_RESOURCE_TYPES.TRANSPORT_RECORD,
          resourceId: document._id,
          after,
          reason,
          targetTeamId: context.activeTeamId,
          session
        });
        return after;
      }, connection);
    } catch (error) {
      throw normalizePersistenceError(error, 'TRANSPORT_RECORD_DUPLICATE');
    }
  }

  async function updateRecord({
    authContext,
    req,
    transportRecordId,
    input = {}
  }) {
    const context = assertTeamContext(authContext);
    assertTransportReporter(context);
    assertNoClientTeamId(input);
    assertNoLegacyPhotoFields(input);
    try {
      return await runWithOptionalTransaction(async (session) => {
        const { filter } = await scopedRead({
          authContext: context,
          method: 'PATCH',
          id: transportRecordId,
          query: {},
          permissionKey: 'report.submit'
        });
        const document = await execute(TransportRecordModel.findOne(filter), session);
        if (!document) throw notFound('Transport record');
        const before = serializeTransportRecord(document);
        const orgUnit = await resolveWritableOrgUnit({
          context,
          moduleKey: DATA_SCOPE_MODULES.REPORT_TRANSPORT,
          requestedOrgUnitId: input.orgUnitId,
          fallbackOrgUnitId: document.orgUnitId,
          OrgUnitModel,
          session
        });
        const replacesPhotos = Object.prototype.hasOwnProperty.call(input, 'photoFileIds');
        const photoFileIds = replacesPhotos
          ? await validateTransportPhotoFiles({
            context,
            values: input.photoFileIds,
            transportRecordId: document._id,
            FileAssetModel,
            session
          })
          : document.photoFileIds;
        if (replacesPhotos) {
          const managedPhotos = await managedFileService.reconcileOwnerFiles({
            authContext: context,
            req,
            attachments: photoFileIds.map((fileId) => ({ fileId })),
            previousAttachments: document.photoFileIds.map((fileId) => ({ fileId })),
            ownerType: FileAsset.FILE_OWNER_TYPES.TRANSPORT_REPORT,
            ownerId: document._id,
            method: 'PATCH',
            session
          });
          document.photoFileIds = managedPhotos.map(({ fileId }) => fileId);
        }
        const payload = await resolveMasterDataPayload({
          context,
          input,
          existing: plain(document),
          payload: transportPayload(
            input,
            plain(document),
            businessDateInShanghai(clock())
          ),
          session
        });
        Object.assign(document, payload, {
          orgUnitId: orgUnit._id,
          updatedBy: context.userId
        });
        await document.save({ session: session || undefined });
        const after = serializeTransportRecord(document);
        const reason = normalizeReason(input.reason);
        const now = clock();
        await createOne(ReportChangeRecordModel, {
          teamId: context.activeTeamId,
          orgUnitId: orgUnit._id,
          resourceType: AUDIT_RESOURCE_TYPES.TRANSPORT_RECORD,
          resourceId: document._id,
          changeType: REPORT_CHANGE_TYPES.UPDATE,
          before,
          after,
          operatorId: context.userId,
          reason,
          occurredAt: now
        }, session);
        await auditService.record({
          req,
          authContext: context,
          action: AUDIT_ACTIONS.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPES.TRANSPORT_RECORD,
          resourceId: document._id,
          before,
          after,
          reason,
          targetTeamId: context.activeTeamId,
          session
        });
        return after;
      }, connection);
    } catch (error) {
      throw normalizePersistenceError(error, 'TRANSPORT_RECORD_DUPLICATE');
    }
  }

  async function exportMonthlySummary({
    authContext,
    req,
    requestedTeamId,
    method = 'GET',
    query = {}
  }) {
    const month = naturalMonth(query.month);
    const parsedMonth = parseNaturalMonth(month);
    const dayCount = daysInNaturalMonth(parsedMonth.year, parsedMonth.month);
    const firstDate = `${month}-01`;
    const lastDate = `${month}-${String(dayCount).padStart(2, '0')}`;
    const exportQuery = {
      ...query,
      date: undefined,
      dateFrom: firstDate,
      dateTo: lastDate,
      page: undefined,
      pageSize: undefined
    };
    const { teamId, filter } = await scopedRead({
      authContext,
      requestedTeamId,
      method,
      query: exportQuery,
      permissionKey: 'report.export'
    });
    const [documents, team] = await Promise.all([
      TransportRecordModel.find(filter)
        .sort({ driverName: 1, route: 1, vehiclePlate: 1, dispatchType: 1, reportDate: 1 })
        .lean(),
      ProjectTeamModel.findById(teamId).lean()
    ]);
    if (!team) throw notFound('Project team');

    const dateColumns = Array.from({ length: dayCount }, (_, index) => index + 1);
    const driverGroups = new Map();
    let exportedGroupCount = 0;
    for (const document of documents) {
      const record = serializeTransportRecord(document);
      const driverKey = JSON.stringify([
        record.driverMasterId,
        record.driverName,
        record.routeMasterId,
        record.route
      ]);
      if (!driverGroups.has(driverKey)) {
        driverGroups.set(driverKey, {
          driverName: record.driverName,
          route: record.route,
          vehicles: new Map(),
          daily: new Map()
        });
      }
      const driverGroup = driverGroups.get(driverKey);
      const vehicleKey = JSON.stringify([
        record.vehiclePlateMasterId,
        record.vehiclePlate,
        record.vehicleTypeMasterId,
        record.vehicleType
      ]);
      if (!driverGroup.vehicles.has(vehicleKey)) {
        driverGroup.vehicles.set(vehicleKey, {
          vehiclePlate: record.vehiclePlate,
          vehicleType: record.vehicleType,
          dispatches: new Map()
        });
      }
      const vehicleGroup = driverGroup.vehicles.get(vehicleKey);
      if (!vehicleGroup.dispatches.has(record.dispatchType)) {
        vehicleGroup.dispatches.set(record.dispatchType, {
          daily: new Map(),
          remarks: new Set()
        });
        exportedGroupCount += 1;
      }
      const dispatchGroup = vehicleGroup.dispatches.get(record.dispatchType);
      dispatchGroup.daily.set(
        record.reportDate,
        (dispatchGroup.daily.get(record.reportDate) || 0) + 1
      );
      driverGroup.daily.set(
        record.reportDate,
        (driverGroup.daily.get(record.reportDate) || 0) + 1
      );
      if (record.remark) dispatchGroup.remarks.add(record.remark);
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Horselink V2';
    workbook.created = new Date();
    workbook.calcProperties.fullCalcOnLoad = true;
    const worksheet = workbook.addWorksheet('运输月度汇总', {
      properties: { defaultRowHeight: 22 },
      pageSetup: {
        orientation: 'landscape',
        paperSize: 9,
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
        horizontalCentered: true,
        margins: {
          left: 0.2,
          right: 0.2,
          top: 0.35,
          bottom: 0.35,
          header: 0.1,
          footer: 0.1
        }
      },
      views: [{ state: 'frozen', xSplit: 6, ySplit: 4, topLeftCell: 'G5' }]
    });
    worksheet.columns = [
      { width: 7 }, { width: 12 }, { width: 22 }, { width: 14 }, { width: 20 }, { width: 11 },
      ...dateColumns.map(() => ({ width: 4 })),
      { width: 12 }, { width: 30 }
    ];
    const totalColumn = 6 + dayCount + 1;
    const remarkColumn = totalColumn + 1;
    const lastColumnLetter = worksheet.getColumn(remarkColumn).letter;

    worksheet.addRow([TRANSPORT_SUMMARY_COMPANY_NAME]);
    worksheet.mergeCells(1, 1, 1, remarkColumn);
    worksheet.addRow([
      `${parsedMonth.year} 年 ${parsedMonth.month} 月  部门：${formulaSafe(team.name)}  货车司机计件明细表`
    ]);
    worksheet.mergeCells(2, 1, 2, remarkColumn);
    worksheet.addRow([
      '序号', '姓名', '路线', '车牌号', '车型', '出车类型',
      ...dateColumns.map((day) => weekdayLabel(`${month}-${String(day).padStart(2, '0')}`)),
      '趟数合计', '备注'
    ]);
    worksheet.addRow(['', '', '', '', '', '', ...dateColumns, '', '']);
    for (const column of [1, 2, 3, 4, 5, 6, totalColumn, remarkColumn]) {
      worksheet.mergeCells(3, column, 4, column);
    }

    const subtotalRows = new Set();
    let sequence = 0;
    for (const driverGroup of driverGroups.values()) {
      sequence += 1;
      const driverStartRow = worksheet.rowCount + 1;
      for (const vehicleGroup of driverGroup.vehicles.values()) {
        const vehicleStartRow = worksheet.rowCount + 1;
        for (const dispatchType of TRANSPORT_SUMMARY_DISPATCH_ORDER) {
          const dispatchGroup = vehicleGroup.dispatches.get(dispatchType);
          const counts = dateColumns.map((day) => (
            dispatchGroup?.daily.get(`${month}-${String(day).padStart(2, '0')}`) || 0
          ));
          worksheet.addRow([
            sequence,
            formulaSafe(driverGroup.driverName),
            formulaSafe(driverGroup.route),
            formulaSafe(vehicleGroup.vehiclePlate),
            formulaSafe(vehicleGroup.vehicleType),
            dispatchType,
            ...counts.map((count) => count || null),
            counts.reduce((total, value) => total + value, 0),
            formulaSafe([...(dispatchGroup?.remarks || [])].join('；'))
          ]);
        }
        const vehicleEndRow = worksheet.rowCount;
        worksheet.mergeCells(vehicleStartRow, 4, vehicleEndRow, 4);
        worksheet.mergeCells(vehicleStartRow, 5, vehicleEndRow, 5);
      }
      const driverEndRow = worksheet.rowCount;
      for (const column of [1, 2, 3]) {
        worksheet.mergeCells(driverStartRow, column, driverEndRow, column);
      }
      const driverDailyTotals = dateColumns.map((day) => (
        driverGroup.daily.get(`${month}-${String(day).padStart(2, '0')}`) || 0
      ));
      const subtotalRow = worksheet.addRow([
        '合计：', '', '', '', '', '',
        ...driverDailyTotals,
        driverDailyTotals.reduce((total, value) => total + value, 0),
        ''
      ]);
      worksheet.mergeCells(subtotalRow.number, 1, subtotalRow.number, 6);
      subtotalRows.add(subtotalRow.number);
    }
    if (driverGroups.size === 0) {
      const subtotalRow = worksheet.addRow([
        '合计：', '', '', '', '', '', ...dateColumns.map(() => 0), 0, ''
      ]);
      worksheet.mergeCells(subtotalRow.number, 1, subtotalRow.number, 6);
      subtotalRows.add(subtotalRow.number);
    }

    const greenFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC6E0B4' } };
    const thinBorder = {
      top: { style: 'thin', color: { argb: 'FF000000' } },
      left: { style: 'thin', color: { argb: 'FF000000' } },
      bottom: { style: 'thin', color: { argb: 'FF000000' } },
      right: { style: 'thin', color: { argb: 'FF000000' } }
    };
    for (let rowNumber = 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
      for (let column = 1; column <= remarkColumn; column += 1) {
        const cell = worksheet.getCell(rowNumber, column);
        cell.fill = greenFill;
        cell.alignment = {
          horizontal: rowNumber <= 4 || subtotalRows.has(rowNumber) ? 'center' : 'center',
          vertical: 'middle',
          wrapText: true
        };
        if (rowNumber >= 3) cell.border = thinBorder;
        if (subtotalRows.has(rowNumber)) cell.font = { bold: true };
      }
    }
    worksheet.getRow(1).height = 28;
    worksheet.getRow(2).height = 26;
    worksheet.getRow(3).height = 28;
    worksheet.getRow(4).height = 24;
    worksheet.getCell(1, 1).font = { bold: true, size: 16, name: '宋体' };
    worksheet.getCell(2, 1).font = { bold: true, size: 12, name: '宋体' };
    for (const rowNumber of [3, 4]) {
      for (let column = 1; column <= remarkColumn; column += 1) {
        worksheet.getCell(rowNumber, column).font = {
          bold: true,
          color: { argb: 'FF0070C0' },
          name: '宋体'
        };
      }
    }
    worksheet.autoFilter = `A3:${lastColumnLetter}4`;
    worksheet.pageSetup.printTitlesRow = '1:4';
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    await auditService.record({
      req,
      authContext,
      action: AUDIT_ACTIONS.EXPORT,
      resourceType: AUDIT_RESOURCE_TYPES.TRANSPORT_RECORD,
      after: {
        month,
        exportedRecordCount: documents.length,
        exportedGroupCount,
        filters: transportUserFilter(exportQuery)
      },
      targetTeamId: teamId
    });
    return {
      buffer,
      count: documents.length,
      groupCount: exportedGroupCount,
      month
    };
  }

  return Object.freeze({
    createRecord,
    exportMonthlySummary,
    getRecord,
    getHistory,
    listRecords,
    listOptions,
    updateRecord
  });
}

module.exports = {
  createTransportRecordService,
  loadTotal,
  naturalDate,
  naturalMonth,
  normalizeLoadDetails,
  serializeReportChangeRecord,
  serializeTransportRecord,
  transportUserFilter
};
