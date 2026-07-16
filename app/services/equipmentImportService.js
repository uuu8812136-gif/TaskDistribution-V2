'use strict';

const crypto = require('node:crypto');
const mongoose = require('mongoose');
const EquipmentAsset = require('../models/EquipmentAsset');
const EquipmentCategory = require('../models/EquipmentCategory');
const EquipmentChangeRecord = require('../models/EquipmentChangeRecord');
const ImportException = require('../models/ImportException');
const ImportJob = require('../models/ImportJob');
const OrgUnit = require('../models/OrgUnit');
const TeamMembership = require('../models/TeamMembership');
const User = require('../models/User');
const {
  AUDIT_ACTIONS,
  AUDIT_RESOURCE_TYPES,
  DATA_SCOPES,
  DATA_SCOPE_MODULES,
  MEMBERSHIP_STATUSES,
  ORG_UNIT_STATUSES
} = require('../config/permissions');
const { createAuditService } = require('./auditService');
const { normalizeId } = require('./authSessionService');
const {
  MAX_IMPORT_ROWS,
  buildException,
  parseEquipmentWorkbook,
  textValue
} = require('./equipmentImportParser');
const {
  normalizeOriginalName,
  validateFileContent,
  validatedExtension
} = require('./fileStorageService');
const { normalizeObjectId } = require('./scopedQueryService');
const {
  assertPermission,
  assertTeamContext,
  resolveModuleDataScope,
  sameId
} = require('./teamContextService');
const { runWithOptionalTransaction } = require('./transactionService');

const MAX_EQUIPMENT_IMPORT_FILE_SIZE = 128 * 1024 * 1024;
const EXCEL_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

const { EQUIPMENT_CHANGE_TYPES } = EquipmentChangeRecord;
const {
  IMPORT_CUSTOMER_DECISIONS,
  IMPORT_EXCEPTION_SEVERITIES,
  IMPORT_EXCEPTION_STATUSES
} = ImportException;
const { IMPORT_JOB_STATUSES, IMPORT_ROW_STATUSES, IMPORT_TYPES } = ImportJob;

const CANDIDATE_FIELDS = new Set([
  'assetCode',
  'name',
  'categoryId',
  'specification',
  'manufacturer',
  'quantity',
  'unit',
  'acquisitionDate',
  'originalValue',
  'orgUnitId',
  'custodianUserId',
  'location',
  'status',
  'remark'
]);

class EquipmentImportError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'EquipmentImportError';
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}

function importError(status, code, message) {
  return new EquipmentImportError(status, code, message);
}

function importNotFound() {
  return importError(404, 'EQUIPMENT_IMPORT_NOT_FOUND', 'Equipment import does not exist');
}

function confirmationInvalid(message) {
  return importError(409, 'EQUIPMENT_IMPORT_CONFIRMATION_INVALID', message);
}

function normalizeImportId(value) {
  try {
    return normalizeObjectId(value, 'importJobId');
  } catch {
    throw importNotFound();
  }
}

function normalizeRelatedId(value, field) {
  try {
    return normalizeObjectId(value, field);
  } catch {
    throw confirmationInvalid(`${field} must identify an active resource in the import team`);
  }
}

function normalizeLookupText(value) {
  return textValue(value, 500).normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase('zh-CN');
}

function plain(document) {
  return typeof document?.toObject === 'function'
    ? document.toObject({ depopulate: true, versionKey: false })
    : document;
}

function serializeCandidate(candidate) {
  const value = plain(candidate) || {};
  return {
    assetCode: value.assetCode || '',
    name: value.name || '',
    categoryId: normalizeId(value.categoryId),
    categoryName: value.categoryName || '',
    specification: value.specification || '',
    manufacturer: value.manufacturer || '',
    quantity: value.quantity,
    unit: value.unit || '',
    acquisitionDate: value.acquisitionDate || null,
    originalValue: value.originalValue ?? null,
    orgUnitId: normalizeId(value.orgUnitId),
    orgUnitName: value.orgUnitName || '',
    custodianUserId: normalizeId(value.custodianUserId),
    custodianName: value.custodianName || '',
    location: value.location || '',
    status: value.status,
    remark: value.remark || ''
  };
}

function serializeRow(row) {
  const value = plain(row);
  return {
    rowId: normalizeId(value.rowId),
    sheetName: value.sheetName,
    rowNumber: value.rowNumber,
    rawAssetCode: value.rawAssetCode,
    rawValues: value.rawValues,
    candidate: serializeCandidate(value.candidate),
    validationStatus: value.validationStatus,
    publishedEquipmentId: normalizeId(value.publishedEquipmentId)
  };
}

function serializeJob(document, { includeRows = false, page = 1, pageSize = DEFAULT_PAGE_SIZE } = {}) {
  const value = plain(document);
  const result = {
    _id: normalizeId(value._id),
    teamId: normalizeId(value.teamId),
    type: value.type,
    sourceFileId: normalizeId(value.sourceFileId),
    sourceFileName: value.sourceFileName,
    sourceFileSize: value.sourceFileSize,
    sourceSha256: value.sourceSha256,
    sourceSheetNames: value.sourceSheetNames || [],
    dataScope: value.dataScope,
    scopeOrgUnitId: normalizeId(value.scopeOrgUnitId),
    status: value.status,
    totalRows: value.totalRows,
    validRows: value.validRows,
    warningRows: value.warningRows,
    errorRows: value.errorRows,
    skippedRows: value.skippedRows,
    publishedRows: value.publishedRows,
    createdBy: normalizeId(value.createdBy),
    confirmedBy: normalizeId(value.confirmedBy),
    confirmedAt: value.confirmedAt || null,
    publishedAt: value.publishedAt || null,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    version: document?.__v ?? value.__v ?? 0
  };
  if (includeRows) {
    const rows = value.stagedRows || [];
    const start = (page - 1) * pageSize;
    result.rows = rows.slice(start, start + pageSize).map(serializeRow);
    result.page = page;
    result.pageSize = pageSize;
  }
  return result;
}

function serializeException(document) {
  const value = plain(document);
  return {
    _id: normalizeId(value._id),
    importJobId: normalizeId(value.importJobId),
    importRowId: normalizeId(value.importRowId),
    orgUnitId: normalizeId(value.orgUnitId),
    sheetName: value.sheetName,
    rowNumber: value.rowNumber,
    assetCode: value.assetCode,
    field: value.field,
    exceptionType: value.exceptionType,
    severity: value.severity,
    originalValue: value.originalValue,
    suggestedAction: value.suggestedAction,
    hasSuggestedValue: value.hasSuggestedValue,
    suggestedValue: value.hasSuggestedValue ? value.suggestedValue : undefined,
    customerDecision: value.customerDecision,
    resolvedValue: value.status === IMPORT_EXCEPTION_STATUSES.PENDING
      ? undefined
      : value.resolvedValue,
    status: value.status,
    resolvedBy: normalizeId(value.resolvedBy),
    resolvedAt: value.resolvedAt || null
  };
}

function integer(value, field, { min = 0, max = 2147483647, fallback } = {}) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    throw importError(400, 'EQUIPMENT_IMPORT_INPUT_INVALID', `${field} is required`);
  }
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw importError(400, 'EQUIPMENT_IMPORT_INPUT_INVALID', `${field} must be an integer`);
  }
  return parsed;
}

function pagination(query = {}) {
  const page = integer(query.page, 'page', { min: 1, max: 1000000, fallback: 1 });
  const pageSize = integer(query.pageSize, 'pageSize', {
    min: 1,
    max: MAX_PAGE_SIZE,
    fallback: DEFAULT_PAGE_SIZE
  });
  return { page, pageSize, skip: (page - 1) * pageSize };
}

function assertNoClientTeamId(input) {
  if (Object.prototype.hasOwnProperty.call(input || {}, 'teamId')) {
    throw importError(
      400,
      'EQUIPMENT_IMPORT_TEAM_ID_IMMUTABLE',
      'teamId is derived from the authenticated team and cannot be supplied by the client'
    );
  }
}

function createEquipmentImportService({
  EquipmentAssetModel = EquipmentAsset,
  EquipmentCategoryModel = EquipmentCategory,
  EquipmentChangeRecordModel = EquipmentChangeRecord,
  ImportExceptionModel = ImportException,
  ImportJobModel = ImportJob,
  OrgUnitModel = OrgUnit,
  TeamMembershipModel = TeamMembership,
  UserModel = User,
  auditService = createAuditService(),
  connection = mongoose.connection,
  parseWorkbook = parseEquipmentWorkbook
} = {}) {
  function contextAndScope(authContext) {
    const context = assertTeamContext(authContext);
    assertPermission(context, 'equipment.import');
    const scope = resolveModuleDataScope(context, DATA_SCOPE_MODULES.EQUIPMENT);
    return { context, scope };
  }

  function visibleJobFilter(authContext, importJobId) {
    const { context, scope } = contextAndScope(authContext);
    const filter = {
      _id: normalizeImportId(importJobId),
      teamId: normalizeRelatedId(context.activeTeamId, 'activeTeamId'),
      type: IMPORT_TYPES.EQUIPMENT_ASSET
    };
    if (scope.scope === DATA_SCOPES.ORG_UNIT) {
      filter.scopeOrgUnitId = normalizeRelatedId(scope.orgUnitId, 'orgUnitId');
    }
    return { context, scope, filter };
  }

  async function execute(query, session) {
    if (session && typeof query.session === 'function') query.session(session);
    return query;
  }

  async function referenceData(context, session) {
    const [orgUnits, categories, memberships] = await Promise.all([
      execute(OrgUnitModel.find({
        teamId: context.activeTeamId,
        status: ORG_UNIT_STATUSES.ACTIVE
      }).lean(), session),
      execute(EquipmentCategoryModel.find({
        teamId: context.activeTeamId,
        status: EquipmentCategory.EQUIPMENT_CATEGORY_STATUSES.ACTIVE
      }).lean(), session),
      execute(TeamMembershipModel.find({
        teamId: context.activeTeamId,
        status: MEMBERSHIP_STATUSES.ACTIVE
      }).lean(), session)
    ]);
    const userIds = [...new Set(memberships.map(({ userId }) => String(userId)))];
    const users = userIds.length === 0
      ? []
      : await execute(UserModel.find({ _id: { $in: userIds }, status: 'active' })
        .select('_id username name')
        .lean(), session);
    return { orgUnits, categories, memberships, users };
  }

  function indexBy(values, keys) {
    const map = new Map();
    for (const value of values) {
      const seenKeys = new Set();
      for (const keyValue of keys(value)) {
        const key = normalizeLookupText(keyValue);
        if (!key || seenKeys.has(key)) continue;
        seenKeys.add(key);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(value);
      }
    }
    return map;
  }

  function addException(row, input) {
    row.exceptions.push(buildException(input));
  }

  function resolveDirectId(value, valuesById) {
    if (!value) return { supplied: false, value: null };
    if (!mongoose.isValidObjectId(value)) return { supplied: true, value: null };
    return { supplied: true, value: valuesById.get(String(value)) || null };
  }

  async function enrichRows({ parsed, context, scope, session }) {
    const refs = await referenceData(context, session);
    const orgsById = new Map(refs.orgUnits.map((item) => [String(item._id), item]));
    const categoriesById = new Map(refs.categories.map((item) => [String(item._id), item]));
    const usersById = new Map(refs.users.map((item) => [String(item._id), item]));
    const orgsByText = indexBy(refs.orgUnits, (item) => [item.name, item.code]);
    const categoriesByText = indexBy(refs.categories, (item) => [item.name]);
    const membershipsByUserId = new Map(
      refs.memberships.map((membership) => [String(membership.userId), membership])
    );
    const usersByText = indexBy(refs.users, (item) => [item.name, item.username]);

    const existingCodes = [...new Set(parsed.rows.map((row) => row.candidate.assetCode).filter(Boolean))];
    const existingAssets = existingCodes.length === 0
      ? []
      : await execute(EquipmentAssetModel.find({
        teamId: context.activeTeamId,
        assetCode: { $in: existingCodes }
      }).select('assetCode').lean(), session);
    const existingCodeSet = new Set(existingAssets.map(({ assetCode }) => assetCode));

    const rows = parsed.rows.map((sourceRow) => ({
      ...sourceRow,
      rowId: new mongoose.Types.ObjectId(),
      candidate: { ...sourceRow.candidate },
      exceptions: [...sourceRow.exceptions]
    }));
    const codeCounts = new Map();
    for (const row of rows) {
      const candidate = row.candidate;
      if (candidate.assetCode) {
        codeCounts.set(candidate.assetCode, (codeCounts.get(candidate.assetCode) || 0) + 1);
        if (existingCodeSet.has(candidate.assetCode)) {
          addException(row, {
            field: 'assetCode',
            exceptionType: 'DUPLICATE_ASSET_CODE_EXISTING',
            originalValue: candidate.assetCode,
            message: 'Choose a new asset code or skip this row'
          });
        }
      }

      const directOrg = resolveDirectId(candidate.orgUnitId, orgsById);
      let orgUnit = directOrg.value;
      if (directOrg.supplied && !orgUnit) {
        addException(row, {
          field: 'orgUnitId',
          exceptionType: 'ORG_UNIT_ID_INVALID',
          originalValue: candidate.orgUnitId
        });
      }
      if (!directOrg.supplied) {
        const matches = orgsByText.get(normalizeLookupText(candidate.orgUnitName)) || [];
        if (matches.length === 1) orgUnit = matches[0];
        else {
          addException(row, {
            field: 'orgUnitId',
            exceptionType: matches.length > 1 ? 'ORG_UNIT_AMBIGUOUS' : 'ORG_UNIT_NOT_FOUND',
            originalValue: candidate.orgUnitName || null
          });
        }
      }
      candidate.orgUnitId = orgUnit?._id || null;
      if (
        orgUnit &&
        scope.scope === DATA_SCOPES.ORG_UNIT &&
        !sameId(orgUnit._id, scope.orgUnitId)
      ) {
        addException(row, {
          field: 'orgUnitId',
          exceptionType: 'ORG_UNIT_OUT_OF_SCOPE',
          originalValue: candidate.orgUnitName || normalizeId(orgUnit._id)
        });
      }

      const directCategory = resolveDirectId(candidate.categoryId, categoriesById);
      let category = directCategory.value;
      if (directCategory.supplied && !category) {
        addException(row, {
          field: 'categoryId',
          exceptionType: 'CATEGORY_ID_INVALID',
          originalValue: candidate.categoryId
        });
      }
      if (!directCategory.supplied) {
        const matches = categoriesByText.get(normalizeLookupText(candidate.categoryName)) || [];
        if (matches.length === 1) category = matches[0];
        else {
          addException(row, {
            field: 'categoryId',
            exceptionType: matches.length > 1 ? 'CATEGORY_AMBIGUOUS' : 'CATEGORY_NOT_FOUND',
            originalValue: candidate.categoryName || null
          });
        }
      }
      candidate.categoryId = category?._id || null;

      const directCustodian = resolveDirectId(candidate.custodianUserId, usersById);
      let custodian = directCustodian.value;
      if (directCustodian.supplied && !custodian) {
        addException(row, {
          field: 'custodianUserId',
          exceptionType: 'CUSTODIAN_ID_INVALID',
          severity: 'WARNING',
          originalValue: candidate.custodianUserId,
          suggestedValue: null
        });
      }
      if (!directCustodian.supplied && candidate.custodianName) {
        const matches = (usersByText.get(normalizeLookupText(candidate.custodianName)) || [])
          .filter((user) => {
            const membership = membershipsByUserId.get(String(user._id));
            return orgUnit && membership && sameId(membership.orgUnitId, orgUnit._id);
          });
        if (matches.length === 1) custodian = matches[0];
        else {
          addException(row, {
            field: 'custodianUserId',
            exceptionType: matches.length > 1 ? 'CUSTODIAN_AMBIGUOUS' : 'CUSTODIAN_NOT_FOUND',
            severity: 'WARNING',
            originalValue: candidate.custodianName,
            suggestedValue: null,
            message: 'Select one active team member in this organization or import without a custodian'
          });
        }
      }
      candidate.custodianUserId = custodian?._id || null;
    }

    for (const row of rows) {
      if (row.candidate.assetCode && codeCounts.get(row.candidate.assetCode) > 1) {
        addException(row, {
          field: 'assetCode',
          exceptionType: 'DUPLICATE_ASSET_CODE_IN_FILE',
          originalValue: row.candidate.assetCode,
          message: 'Choose a unique asset code or skip this row'
        });
      }
      row.validationStatus = row.exceptions.some(({ severity }) => (
        severity === IMPORT_EXCEPTION_SEVERITIES.ERROR
      ))
        ? IMPORT_ROW_STATUSES.ERROR
        : row.exceptions.length > 0
          ? IMPORT_ROW_STATUSES.WARNING
          : IMPORT_ROW_STATUSES.VALID;
    }
    return rows;
  }

  function validateUpload(upload) {
    if (!upload || !Buffer.isBuffer(upload.buffer)) {
      throw importError(400, 'EQUIPMENT_IMPORT_FILE_REQUIRED', 'An Excel file is required');
    }
    if (upload.size !== upload.buffer.length || upload.size < 1) {
      throw importError(400, 'EQUIPMENT_IMPORT_FILE_INVALID', 'The uploaded file size is invalid');
    }
    if (upload.size > MAX_EQUIPMENT_IMPORT_FILE_SIZE) {
      throw importError(413, 'EQUIPMENT_IMPORT_FILE_TOO_LARGE', 'The Excel file exceeds 128 MB');
    }
    let originalName;
    const mimeType = upload.mimetype;
    try {
      originalName = normalizeOriginalName(upload.originalname);
      validatedExtension(originalName, mimeType);
      if (mimeType !== EXCEL_MIME_TYPE) throw new TypeError('Only .xlsx workbooks are supported');
      validateFileContent(upload.buffer, mimeType);
    } catch (error) {
      throw importError(415, 'EQUIPMENT_IMPORT_FILE_UNSUPPORTED', error.message);
    }
    return { originalName, mimeType };
  }

  async function createPreview({ authContext, req, upload, input = {} }) {
    const { context, scope } = contextAndScope(authContext);
    assertNoClientTeamId(input);
    const { originalName } = validateUpload(upload);
    let parsed;
    try {
      parsed = parseWorkbook(upload.buffer);
    } catch (error) {
      if (error instanceof RangeError) {
        throw importError(413, 'EQUIPMENT_IMPORT_ROW_LIMIT', error.message);
      }
      throw importError(400, 'EQUIPMENT_IMPORT_WORKBOOK_INVALID', error.message);
    }
    if (parsed.rows.length > MAX_IMPORT_ROWS) {
      throw importError(413, 'EQUIPMENT_IMPORT_ROW_LIMIT', `Import limit is ${MAX_IMPORT_ROWS} rows`);
    }
    const sourceSha256 = crypto.createHash('sha256').update(upload.buffer).digest('hex');

    return runWithOptionalTransaction(async (session) => {
      const rows = await enrichRows({ parsed, context, scope, session });
      const counters = {
        totalRows: rows.length,
        validRows: rows.filter(({ validationStatus }) => validationStatus === IMPORT_ROW_STATUSES.VALID).length,
        warningRows: rows.filter(({ validationStatus }) => validationStatus === IMPORT_ROW_STATUSES.WARNING).length,
        errorRows: rows.filter(({ validationStatus }) => validationStatus === IMPORT_ROW_STATUSES.ERROR).length
      };
      const job = new ImportJobModel({
        teamId: context.activeTeamId,
        type: IMPORT_TYPES.EQUIPMENT_ASSET,
        sourceFileName: originalName,
        sourceFileSize: upload.size,
        sourceSha256,
        sourceSheetNames: parsed.sheetNames,
        dataScope: scope.scope,
        scopeOrgUnitId: scope.scope === DATA_SCOPES.ORG_UNIT ? scope.orgUnitId : null,
        status: IMPORT_JOB_STATUSES.PREVIEW_READY,
        ...counters,
        stagedRows: rows.map((row) => ({
          rowId: row.rowId,
          sheetName: row.sheetName,
          rowNumber: row.rowNumber,
          rawAssetCode: row.rawAssetCode,
          rawValues: row.rawValues,
          candidate: row.candidate,
          validationStatus: row.validationStatus
        })),
        createdBy: context.userId
      });
      await job.save({ session: session || undefined });

      const exceptions = rows.flatMap((row) => row.exceptions.map((exception) => ({
        teamId: context.activeTeamId,
        importJobId: job._id,
        importRowId: row.rowId,
        orgUnitId: row.candidate.orgUnitId || null,
        sheetName: row.sheetName,
        rowNumber: row.rowNumber,
        assetCode: row.candidate.assetCode || '',
        field: exception.field,
        exceptionType: exception.exceptionType,
        severity: exception.severity,
        originalValue: exception.originalValue,
        suggestedAction: exception.message || exception.exceptionType,
        hasSuggestedValue: exception.hasSuggestedValue,
        suggestedValue: exception.hasSuggestedValue ? exception.suggestedValue : null
      })));
      if (exceptions.length > 0) {
        await ImportExceptionModel.insertMany(exceptions, {
          ordered: true,
          session: session || undefined
        });
      }
      await auditService.record({
        req,
        authContext: context,
        action: AUDIT_ACTIONS.IMPORT,
        resourceType: AUDIT_RESOURCE_TYPES.IMPORT_JOB,
        resourceId: job._id,
        after: {
          phase: 'PREVIEW',
          sourceFileName: originalName,
          sourceSha256,
          ...counters,
          exceptionCount: exceptions.length
        },
        targetTeamId: context.activeTeamId,
        session
      });
      return {
        importJob: serializeJob(job, { includeRows: true }),
        exceptionCount: exceptions.length
      };
    }, connection);
  }

  async function findVisibleJob({ authContext, importJobId, session = null, version }) {
    const { context, scope, filter } = visibleJobFilter(authContext, importJobId);
    if (version !== undefined) filter.__v = version;
    const job = await execute(ImportJobModel.findOne(filter), session);
    if (!job) throw importNotFound();
    return { context, scope, job };
  }

  async function getImportJob({ authContext, importJobId, query = {} }) {
    const { page, pageSize } = pagination(query);
    const { job } = await findVisibleJob({ authContext, importJobId });
    return serializeJob(job, { includeRows: true, page, pageSize });
  }

  async function listExceptions({ authContext, importJobId, query = {} }) {
    const { page, pageSize, skip } = pagination(query);
    const { context, job } = await findVisibleJob({ authContext, importJobId });
    const filter = { teamId: context.activeTeamId, importJobId: job._id };
    if (query.status) {
      if (!Object.values(IMPORT_EXCEPTION_STATUSES).includes(query.status)) {
        throw importError(400, 'EQUIPMENT_IMPORT_INPUT_INVALID', 'Invalid exception status');
      }
      filter.status = query.status;
    }
    const [documents, total] = await Promise.all([
      ImportExceptionModel.find(filter)
        .sort({ sheetName: 1, rowNumber: 1, createdAt: 1, _id: 1 })
        .skip(skip)
        .limit(pageSize)
        .lean(),
      ImportExceptionModel.countDocuments(filter)
    ]);
    return {
      exceptions: documents.map(serializeException),
      total,
      page,
      pageSize
    };
  }

  function decisionMap(input, exceptions) {
    if (!Array.isArray(input.decisions)) {
      throw importError(400, 'EQUIPMENT_IMPORT_INPUT_INVALID', 'decisions must be an array');
    }
    if (input.decisions.length > Math.max(exceptions.length, 1)) {
      throw importError(400, 'EQUIPMENT_IMPORT_INPUT_INVALID', 'Too many exception decisions');
    }
    const exceptionById = new Map(exceptions.map((item) => [String(item._id), item]));
    const result = new Map();
    for (const decision of input.decisions) {
      if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
        throw importError(400, 'EQUIPMENT_IMPORT_INPUT_INVALID', 'Invalid exception decision');
      }
      const exception = exceptionById.get(String(decision.exceptionId || ''));
      if (!exception) {
        throw importError(400, 'EQUIPMENT_IMPORT_INPUT_INVALID', 'Decision references an unknown exception');
      }
      if (result.has(String(exception._id))) {
        throw importError(400, 'EQUIPMENT_IMPORT_INPUT_INVALID', 'Duplicate exception decision');
      }
      if (!Object.values(IMPORT_CUSTOMER_DECISIONS).includes(decision.action)) {
        throw importError(400, 'EQUIPMENT_IMPORT_INPUT_INVALID', 'Invalid customer decision action');
      }
      if (
        decision.action === IMPORT_CUSTOMER_DECISIONS.USE_RESOLVED_VALUE &&
        !Object.prototype.hasOwnProperty.call(decision, 'value')
      ) {
        throw importError(400, 'EQUIPMENT_IMPORT_INPUT_INVALID', 'Resolved value is required');
      }
      result.set(String(exception._id), { ...decision, exception });
    }
    return result;
  }

  function applyDecisions({ job, exceptions, input }) {
    const decisions = decisionMap(input, exceptions);
    const skippedRowIds = new Set();
    for (const { action, exception } of decisions.values()) {
      if (action === IMPORT_CUSTOMER_DECISIONS.SKIP_ROW) {
        skippedRowIds.add(String(exception.importRowId));
      }
    }

    const rows = new Map(job.stagedRows.map((row) => [String(row.rowId), {
      row,
      candidate: serializeCandidate(row.candidate)
    }]));
    const exceptionUpdates = [];
    for (const exception of exceptions) {
      const rowId = String(exception.importRowId);
      const rowState = rows.get(rowId);
      if (!rowState) throw confirmationInvalid('The staged row for an exception no longer exists');
      const supplied = decisions.get(String(exception._id));
      let action;
      let resolvedValue = null;
      if (skippedRowIds.has(rowId)) {
        action = IMPORT_CUSTOMER_DECISIONS.SKIP_ROW;
      } else {
        if (!supplied) {
          throw confirmationInvalid('Every pending exception must receive a customer decision');
        }
        action = supplied.action;
        if (action === IMPORT_CUSTOMER_DECISIONS.SKIP_ROW) {
          throw confirmationInvalid('Skip decisions must apply consistently to the entire row');
        }
        if (action === IMPORT_CUSTOMER_DECISIONS.ACCEPT_AS_IS) {
          if (exception.severity === IMPORT_EXCEPTION_SEVERITIES.ERROR) {
            throw confirmationInvalid('Error exceptions cannot be accepted as-is');
          }
          resolvedValue = rowState.candidate[exception.field] ?? null;
        } else if (action === IMPORT_CUSTOMER_DECISIONS.ACCEPT_SUGGESTION) {
          if (!exception.hasSuggestedValue) {
            throw confirmationInvalid('This exception does not contain a suggested value');
          }
          resolvedValue = exception.suggestedValue;
        } else if (action === IMPORT_CUSTOMER_DECISIONS.USE_RESOLVED_VALUE) {
          resolvedValue = supplied.value;
        }
        if (CANDIDATE_FIELDS.has(exception.field)) {
          rowState.candidate[exception.field] = resolvedValue;
        }
      }
      exceptionUpdates.push({
        exception,
        action,
        resolvedValue,
        status: skippedRowIds.has(rowId)
          ? IMPORT_EXCEPTION_STATUSES.SKIPPED
          : IMPORT_EXCEPTION_STATUSES.RESOLVED
      });
    }
    return { rows, skippedRowIds, exceptionUpdates };
  }

  function requiredText(value, field, maxLength) {
    if (typeof value !== 'string' || !value.trim()) {
      throw confirmationInvalid(`${field} is required for every published row`);
    }
    const normalized = value.trim();
    if (normalized.length > maxLength) {
      throw confirmationInvalid(`${field} exceeds its maximum length`);
    }
    return normalized;
  }

  function optionalText(value, field, maxLength) {
    if (value === null || value === undefined) return '';
    if (typeof value !== 'string' || value.trim().length > maxLength) {
      throw confirmationInvalid(`${field} is invalid`);
    }
    return value.trim();
  }

  async function finalAssetPayloads({ context, scope, rows, skippedRowIds, job, session }) {
    const activeRows = [...rows.entries()].filter(([rowId]) => !skippedRowIds.has(rowId));
    const codes = new Set();
    const orgIds = new Set();
    const categoryIds = new Set();
    const custodianIds = new Set();
    const normalized = activeRows.map(([rowId, state]) => {
      const candidate = state.candidate;
      const assetCode = requiredText(candidate.assetCode, 'assetCode', 100);
      if (codes.has(assetCode)) {
        throw confirmationInvalid(`assetCode ${assetCode} is duplicated in the confirmed rows`);
      }
      codes.add(assetCode);
      const orgUnitId = normalizeRelatedId(candidate.orgUnitId, 'orgUnitId');
      const categoryId = normalizeRelatedId(candidate.categoryId, 'categoryId');
      const custodianUserId = candidate.custodianUserId
        ? normalizeRelatedId(candidate.custodianUserId, 'custodianUserId')
        : null;
      if (scope.scope === DATA_SCOPES.ORG_UNIT && !sameId(orgUnitId, scope.orgUnitId)) {
        throw confirmationInvalid('A confirmed row is outside the importer organization scope');
      }
      orgIds.add(String(orgUnitId));
      categoryIds.add(String(categoryId));
      if (custodianUserId) custodianIds.add(String(custodianUserId));
      const quantity = Number(candidate.quantity);
      if (!Number.isFinite(quantity) || quantity < 0) {
        throw confirmationInvalid('quantity must be a non-negative number');
      }
      if (!EquipmentAsset.EQUIPMENT_STATUS_VALUES.includes(candidate.status)) {
        throw confirmationInvalid('status must be a supported equipment status');
      }
      let acquisitionDate = null;
      if (candidate.acquisitionDate) {
        acquisitionDate = new Date(candidate.acquisitionDate);
        if (Number.isNaN(acquisitionDate.getTime())) {
          throw confirmationInvalid('acquisitionDate must be a valid date');
        }
      }
      let originalValue = null;
      if (candidate.originalValue !== null && candidate.originalValue !== undefined && candidate.originalValue !== '') {
        originalValue = Number(candidate.originalValue);
        if (!Number.isFinite(originalValue) || originalValue < 0) {
          throw confirmationInvalid('originalValue must be a non-negative number');
        }
      }
      return {
        rowId,
        payload: {
          teamId: context.activeTeamId,
          orgUnitId,
          assetCode,
          name: requiredText(candidate.name, 'name', 200),
          categoryId,
          specification: optionalText(candidate.specification, 'specification', 500),
          manufacturer: optionalText(candidate.manufacturer, 'manufacturer', 200),
          quantity,
          unit: optionalText(candidate.unit, 'unit', 50),
          acquisitionDate,
          originalValue,
          custodianUserId,
          location: optionalText(candidate.location, 'location', 500),
          status: candidate.status,
          sourceImportJobId: job._id,
          remark: optionalText(candidate.remark, 'remark', 2000),
          createdBy: context.userId,
          updatedBy: context.userId
        }
      };
    });

    const [orgUnits, categories, memberships, activeCustodians, existingAssets] = await Promise.all([
      execute(OrgUnitModel.find({
        _id: { $in: [...orgIds] },
        teamId: context.activeTeamId,
        status: ORG_UNIT_STATUSES.ACTIVE
      }).select('_id').lean(), session),
      execute(EquipmentCategoryModel.find({
        _id: { $in: [...categoryIds] },
        teamId: context.activeTeamId,
        status: EquipmentCategory.EQUIPMENT_CATEGORY_STATUSES.ACTIVE
      }).select('_id').lean(), session),
      custodianIds.size === 0
        ? []
        : execute(TeamMembershipModel.find({
          teamId: context.activeTeamId,
          userId: { $in: [...custodianIds] },
          status: MEMBERSHIP_STATUSES.ACTIVE
        }).select('userId orgUnitId').lean(), session),
      custodianIds.size === 0
        ? []
        : execute(UserModel.find({
          _id: { $in: [...custodianIds] },
          status: 'active'
        }).select('_id').lean(), session),
      codes.size === 0
        ? []
        : execute(EquipmentAssetModel.find({
          teamId: context.activeTeamId,
          assetCode: { $in: [...codes] }
        }).select('assetCode').lean(), session)
    ]);
    if (orgUnits.length !== orgIds.size) {
      throw confirmationInvalid('One or more organization units are no longer active in this team');
    }
    if (categories.length !== categoryIds.size) {
      throw confirmationInvalid('One or more categories are no longer active in this team');
    }
    if (existingAssets.length > 0) {
      throw confirmationInvalid(`assetCode ${existingAssets[0].assetCode} already exists in this team`);
    }
    if (activeCustodians.length !== custodianIds.size) {
      throw confirmationInvalid('One or more custodians are no longer active');
    }
    const membershipByUser = new Map(memberships.map((item) => [String(item.userId), item]));
    for (const { payload } of normalized) {
      if (!payload.custodianUserId) continue;
      const membership = membershipByUser.get(String(payload.custodianUserId));
      if (!membership || !sameId(membership.orgUnitId, payload.orgUnitId)) {
        throw confirmationInvalid('A custodian is no longer active in the selected organization');
      }
    }
    return normalized;
  }

  async function confirmImport({ authContext, req, importJobId, input = {} }) {
    assertNoClientTeamId(input);
    const expectedVersion = integer(input.expectedVersion, 'expectedVersion', { min: 0 });
    if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.trim().length > 2000) {
      throw importError(
        400,
        'EQUIPMENT_IMPORT_INPUT_INVALID',
        'reason must contain between 1 and 2000 characters'
      );
    }
    const reason = input.reason.trim();

    try {
      return await runWithOptionalTransaction(async (session) => {
        let visible;
        try {
          visible = await findVisibleJob({
            authContext,
            importJobId,
            session,
            version: expectedVersion
          });
        } catch (error) {
          if (error.code !== 'EQUIPMENT_IMPORT_NOT_FOUND') throw error;
          const unversioned = await findVisibleJob({ authContext, importJobId, session });
          if (unversioned.job.status === IMPORT_JOB_STATUSES.PUBLISHED) {
            throw importError(409, 'EQUIPMENT_IMPORT_ALREADY_PUBLISHED', 'Equipment import is already published');
          }
          throw importError(409, 'EQUIPMENT_IMPORT_VERSION_CONFLICT', 'Equipment import preview has changed');
        }
        const { context, scope, job } = visible;
        if (job.status !== IMPORT_JOB_STATUSES.PREVIEW_READY) {
          throw importError(409, 'EQUIPMENT_IMPORT_ALREADY_PUBLISHED', 'Equipment import is already published');
        }
        const exceptions = await execute(ImportExceptionModel.find({
          teamId: context.activeTeamId,
          importJobId: job._id,
          status: IMPORT_EXCEPTION_STATUSES.PENDING
        }), session);
        const decisionState = applyDecisions({ job, exceptions, input });
        const payloads = await finalAssetPayloads({
          context,
          scope,
          rows: decisionState.rows,
          skippedRowIds: decisionState.skippedRowIds,
          job,
          session
        });
        const created = payloads.length === 0
          ? []
          : await EquipmentAssetModel.insertMany(
            payloads.map(({ payload }) => payload),
            { ordered: true, session: session || undefined }
          );
        const createdByRowId = new Map();
        payloads.forEach(({ rowId }, index) => createdByRowId.set(rowId, created[index]));
        if (created.length > 0) {
          await EquipmentChangeRecordModel.insertMany(created.map((equipment) => ({
            teamId: context.activeTeamId,
            orgUnitId: equipment.orgUnitId,
            equipmentId: equipment._id,
            changeType: EQUIPMENT_CHANGE_TYPES.CREATE,
            before: null,
            after: {
              _id: normalizeId(equipment._id),
              teamId: normalizeId(equipment.teamId),
              orgUnitId: normalizeId(equipment.orgUnitId),
              assetCode: equipment.assetCode,
              name: equipment.name,
              categoryId: normalizeId(equipment.categoryId),
              status: equipment.status,
              sourceImportJobId: normalizeId(job._id)
            },
            operatorId: context.userId,
            reason
          })), { ordered: true, session: session || undefined });
        }

        const resolvedAt = new Date();
        if (decisionState.exceptionUpdates.length > 0) {
          const resolutionResult = await ImportExceptionModel.bulkWrite(
            decisionState.exceptionUpdates.map((update) => ({
              updateOne: {
                filter: {
                  _id: update.exception._id,
                  teamId: context.activeTeamId,
                  importJobId: job._id,
                  status: IMPORT_EXCEPTION_STATUSES.PENDING
                },
                update: {
                  $set: {
                    customerDecision: update.action,
                    resolvedValue: update.resolvedValue,
                    status: update.status,
                    resolvedBy: context.userId,
                    resolvedAt
                  }
                }
              }
            })),
            { ordered: true, session: session || undefined }
          );
          if (resolutionResult.matchedCount !== decisionState.exceptionUpdates.length) {
            throw confirmationInvalid('One or more import exceptions changed during confirmation');
          }
        }
        for (const stagedRow of job.stagedRows) {
          const rowId = String(stagedRow.rowId);
          if (decisionState.skippedRowIds.has(rowId)) {
            stagedRow.validationStatus = IMPORT_ROW_STATUSES.SKIPPED;
            continue;
          }
          const equipment = createdByRowId.get(rowId);
          stagedRow.validationStatus = IMPORT_ROW_STATUSES.PUBLISHED;
          stagedRow.publishedEquipmentId = equipment._id;
        }
        job.status = IMPORT_JOB_STATUSES.PUBLISHED;
        job.skippedRows = decisionState.skippedRowIds.size;
        job.publishedRows = created.length;
        job.confirmedBy = context.userId;
        job.confirmedAt = resolvedAt;
        job.publishedAt = resolvedAt;

        await auditService.record({
          req,
          authContext: context,
          action: AUDIT_ACTIONS.IMPORT_EXCEPTION_CONFIRM,
          resourceType: AUDIT_RESOURCE_TYPES.IMPORT_JOB,
          resourceId: job._id,
          after: {
            decisionCount: decisionState.exceptionUpdates.length,
            skippedRows: decisionState.skippedRowIds.size
          },
          reason,
          targetTeamId: context.activeTeamId,
          session
        });
        await auditService.record({
          req,
          authContext: context,
          action: AUDIT_ACTIONS.PUBLISH,
          resourceType: AUDIT_RESOURCE_TYPES.IMPORT_JOB,
          resourceId: job._id,
          after: { publishedRows: created.length, skippedRows: decisionState.skippedRowIds.size },
          reason,
          targetTeamId: context.activeTeamId,
          session
        });
        await job.save({ session: session || undefined });
        return {
          importJob: serializeJob(job),
          equipmentIds: created.map(({ _id }) => normalizeId(_id))
        };
      }, connection);
    } catch (error) {
      if (error?.code === 11000) {
        throw confirmationInvalid('An asset code or import exception became duplicated during confirmation');
      }
      throw error;
    }
  }

  return Object.freeze({
    confirmImport,
    createPreview,
    getImportJob,
    listExceptions
  });
}

module.exports = {
  EXCEL_MIME_TYPE,
  EquipmentImportError,
  MAX_EQUIPMENT_IMPORT_FILE_SIZE,
  createEquipmentImportService,
  serializeException,
  serializeJob,
  serializeRow
};
