'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const EquipmentAsset = require('../models/EquipmentAsset');
const EquipmentCategory = require('../models/EquipmentCategory');
const EquipmentChangeRecord = require('../models/EquipmentChangeRecord');
const FileAsset = require('../models/FileAsset');
const ImportException = require('../models/ImportException');
const ImportJob = require('../models/ImportJob');
const OrgUnit = require('../models/OrgUnit');
const ProjectTeam = require('../models/ProjectTeam');
const TeamMembership = require('../models/TeamMembership');
const User = require('../models/User');
const {
  AUDIT_ACTIONS,
  AUDIT_RESOURCE_TYPES,
  DATA_SCOPES,
  DATA_SCOPE_MODULES,
  MEMBERSHIP_STATUSES,
  ORG_UNIT_TYPES,
  ORG_UNIT_STATUSES,
  TEAM_STATUSES
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
  JPEG_TRAILING_DATA_SANITIZATION,
  extractEquipmentWorkbookMedia,
  rowKey
} = require('./equipmentWorkbookMediaExtractor');
const {
  createStorageKey,
  normalizeOriginalName,
  resolveStoragePath,
  validateFileContent,
  validatedExtension
} = require('./fileStorageService');
const {
  isOrgUnitInDataScope,
  normalizeObjectId
} = require('./scopedQueryService');
const {
  assertPermission,
  assertTeamContext,
  resolveModuleDataScope,
  sameId
} = require('./teamContextService');
const {
  runWithOptionalTransaction,
  runWithRequiredTransaction
} = require('./transactionService');
const { lockActiveOrgUnitReferences } = require('./orgUnitReferenceService');
const {
  createEquipmentImportStagingCleanupService
} = require('./equipmentImportStagingCleanupService');

const MAX_EQUIPMENT_IMPORT_FILE_SIZE = 128 * 1024 * 1024;
const MAX_STAGED_MEDIA_BYTES = 256 * 1024 * 1024;
const EXCEL_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const MAX_EQUIPMENT_CATEGORY_DEPTH = 4;
const EQUIPMENT_REGISTRY_TRANSACTION_OPTIONS = Object.freeze({
  code: 'EQUIPMENT_REGISTRY_TRANSACTIONS_REQUIRED',
  message: 'Equipment category and asset snapshot writes require MongoDB replica-set transaction support'
});
const EQUIPMENT_CATEGORY_STRUCTURE_CONFLICT = Object.freeze({
  code: 'EQUIPMENT_CATEGORY_STRUCTURE_CONFLICT',
  message: 'Equipment category structure changed concurrently; retry the operation'
});

const { EQUIPMENT_CHANGE_TYPES } = EquipmentChangeRecord;
const { FILE_OWNER_TYPES, FILE_STATUSES } = FileAsset;

// Import publication is the only client-reachable internal path allowed to seed
// a non-IN_USE status. Interactive writes must use the status-approval service.
function trustedImportEquipmentStatus(value) {
  if (!EquipmentAsset.EQUIPMENT_STATUS_VALUES.includes(value)) {
    throw confirmationInvalid('Imported equipment status is invalid');
  }
  return value;
}
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
  'majorCategoryName',
  'equipmentTypeName',
  'primaryName',
  'secondaryName',
  'specification',
  'manufacturer',
  'powerType',
  'emissionStandard',
  'quantity',
  'unit',
  'acquisitionDate',
  'productionDate',
  'activationDate',
  'idlePlacedAt',
  'bookQuantity',
  'physicalQuantity',
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

function categoryStructureConflict(error) {
  return (
    error?.code === 112 ||
    error?.codeName === 'WriteConflict' ||
    error?.hasErrorLabel?.('TransientTransactionError') ||
    error?.errorLabels?.includes?.('TransientTransactionError')
  );
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

// Customer workbooks may contain a closing bracket that was omitted from an
// older category name. Keep stored names unchanged and only normalize this
// harmless punctuation typo while resolving an import path.
function normalizeCategoryLookupText(value) {
  let normalized = normalizeLookupText(value);
  for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
    const opens = [...normalized].filter((character) => character === open).length;
    const closes = [...normalized].filter((character) => character === close).length;
    if (opens === closes + 1 && !normalized.endsWith(close)) normalized += close;
  }
  return normalized;
}

function candidateCategoryHierarchy(candidate = {}) {
  return [
    candidate.majorCategoryName,
    candidate.equipmentTypeName,
    candidate.primaryName,
    candidate.secondaryName
  ].map((value) => textValue(value, 200)).filter(Boolean);
}

function categoryHierarchy(category, categoriesById) {
  if (!category) return [];
  const path = [];
  const visited = new Set();
  let cursor = category;
  while (cursor) {
    const id = String(cursor._id || '');
    if (!id || visited.has(id)) return [];
    visited.add(id);
    path.unshift(cursor);
    cursor = cursor.parentId ? categoriesById.get(String(cursor.parentId)) : null;
  }
  return path;
}

function categoryHierarchyMatches(candidate, category, categoriesById) {
  const expected = candidateCategoryHierarchy(candidate).map(normalizeCategoryLookupText);
  if (expected.length === 0) return false;
  const actual = categoryHierarchy(category, categoriesById)
    .map(({ name }) => normalizeCategoryLookupText(name));
  return actual.length === expected.length && actual.every((value, index) => (
    value === expected[index]
  ));
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
    sourceAssetCode: value.sourceAssetCode || '',
    sourceSequence: value.sourceSequence || '',
    assetType: value.assetType || '',
    majorCategoryName: value.majorCategoryName || '',
    equipmentTypeName: value.equipmentTypeName || '',
    primaryName: value.primaryName || '',
    secondaryName: value.secondaryName || '',
    sourceSheetName: value.sourceSheetName || '',
    sourceRowNumber: value.sourceRowNumber ?? null,
    sourceRawValues: value.sourceRawValues || null,
    sourceImageRefs: Array.isArray(value.sourceImageRefs) ? [...value.sourceImageRefs] : [],
    productCode: value.productCode || '',
    plateNumber: value.plateNumber || '',
    serialNumber: value.serialNumber || '',
    brandSerialNumber: value.brandSerialNumber || '',
    name: value.name || '',
    categoryId: normalizeId(value.categoryId),
    categoryName: value.categoryName || '',
    specification: value.specification || '',
    manufacturer: value.manufacturer || '',
    brand: value.brand || '',
    vehicleLength: value.vehicleLength || '',
    ratedCapacityText: value.ratedCapacityText || '',
    powerType: value.powerType || '',
    emissionStandard: value.emissionStandard || '',
    quantity: value.quantity,
    bookQuantity: value.bookQuantity ?? null,
    physicalQuantity: value.physicalQuantity ?? null,
    unit: value.unit || '',
    acquisitionDate: value.acquisitionDate || null,
    productionDate: value.productionDate || null,
    productionDatePrecision: value.productionDatePrecision || null,
    productionDateRaw: value.productionDateRaw || '',
    productionDateDisplay: value.productionDateDisplay || '',
    activationDate: value.activationDate || null,
    activationDatePrecision: value.activationDatePrecision || null,
    activationDateRaw: value.activationDateRaw || '',
    activationDateDisplay: value.activationDateDisplay || '',
    idlePlacedAt: value.idlePlacedAt || null,
    idlePlacedAtRaw: value.idlePlacedAtRaw || '',
    idlePlacedAtDisplay: value.idlePlacedAtDisplay || '',
    originalValue: value.originalValue ?? null,
    orgUnitId: normalizeId(value.orgUnitId),
    orgUnitName: value.orgUnitName || '',
    custodianUserId: normalizeId(value.custodianUserId),
    custodianName: value.custodianName || '',
    custodianDisplayName: value.custodianDisplayName || '',
    orgUnitNameSnapshot: value.orgUnitNameSnapshot || '',
    location: value.location || '',
    status: value.status,
    conditionText: value.conditionText || '',
    forkliftPosition: value.forkliftPosition || '',
    environmentalRegistrationCode: value.environmentalRegistrationCode || '',
    remark: value.remark || '',
    photoFileIds: Array.isArray(value.photoFileIds)
      ? value.photoFileIds.map(normalizeId).filter(Boolean)
      : [],
    dataQuality: value.dataQuality || {}
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
    mediaSummary: value.mediaSummary || null,
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
    cancelledBy: normalizeId(value.cancelledBy),
    cancelledAt: value.cancelledAt || null,
    cancelReason: value.cancelReason || null,
    expiredAt: value.expiredAt || null,
    stagingCleanupStatus: value.stagingCleanupStatus,
    stagingCleanupAttempts: value.stagingCleanupAttempts || 0,
    stagingCleanupLastAttemptAt: value.stagingCleanupLastAttemptAt || null,
    stagingCleanupCompletedAt: value.stagingCleanupCompletedAt || null,
    stagingCleanupLastError: value.stagingCleanupLastError || null,
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
  FileAssetModel = FileAsset,
  ImportExceptionModel = ImportException,
  ImportJobModel = ImportJob,
  OrgUnitModel = OrgUnit,
  ProjectTeamModel = ProjectTeam,
  TeamMembershipModel = TeamMembership,
  UserModel = User,
  auditService = createAuditService(),
  connection = mongoose.connection,
  parseWorkbook = parseEquipmentWorkbook,
  extractWorkbookMedia = extractEquipmentWorkbookMedia,
  storageRoot = process.env.UPLOAD_PATH,
  stagingCleanupService = null
} = {}) {
  const resolvedStorageRoot = typeof storageRoot === 'string' && storageRoot.trim()
    ? path.resolve(storageRoot)
    : null;

  function requireStorageRoot() {
    if (!resolvedStorageRoot) {
      throw importError(
        500,
        'EQUIPMENT_IMPORT_STORAGE_UNAVAILABLE',
        'Private equipment import storage is not configured'
      );
    }
    return resolvedStorageRoot;
  }
  const cleanupService = stagingCleanupService || createEquipmentImportStagingCleanupService({
    FileAssetModel,
    ImportExceptionModel,
    ImportJobModel,
    auditService,
    connection,
    storageRoot
  });
  const runRegistryWriteTransaction = (work) => runWithRequiredTransaction(
    work,
    connection,
    EQUIPMENT_REGISTRY_TRANSACTION_OPTIONS
  );

  async function lockEquipmentCategoryStructure(context, session) {
    const team = await ProjectTeamModel.findOneAndUpdate({
      _id: context.activeTeamId,
      status: TEAM_STATUSES.ACTIVE
    }, {
      $inc: { equipmentCategoryStructureRevision: 1 }
    }, {
      new: true,
      projection: { _id: 1, equipmentCategoryStructureRevision: 1 },
      session
    });
    if (!team) {
      throw importError(
        409,
        'EQUIPMENT_TEAM_CONTEXT_STALE',
        'The active equipment team is no longer available'
      );
    }
    return team;
  }

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

  function subDepartmentIdForOrgUnit(orgUnitId, orgUnitsById) {
    const orgUnit = orgUnitsById.get(String(orgUnitId));
    if (!orgUnit) return null;
    if (orgUnit.level === 2 && orgUnit.type === ORG_UNIT_TYPES.SUB_DEPARTMENT) {
      return String(orgUnit._id);
    }
    for (const ancestorId of String(orgUnit.path || '/').split('/').filter(Boolean)) {
      const ancestor = orgUnitsById.get(ancestorId);
      if (ancestor?.level === 2 && ancestor.type === ORG_UNIT_TYPES.SUB_DEPARTMENT) {
        return String(ancestor._id);
      }
    }
    return null;
  }

  function orgUnitsShareSubDepartment(leftOrgUnitId, rightOrgUnitId, orgUnitsById) {
    if (sameId(leftOrgUnitId, rightOrgUnitId)) return true;
    const leftSubDepartmentId = subDepartmentIdForOrgUnit(leftOrgUnitId, orgUnitsById);
    const rightSubDepartmentId = subDepartmentIdForOrgUnit(rightOrgUnitId, orgUnitsById);
    return Boolean(
      leftSubDepartmentId &&
      rightSubDepartmentId &&
      leftSubDepartmentId === rightSubDepartmentId
    );
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
        !isOrgUnitInDataScope(scope, orgUnit._id)
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
        const hierarchyNames = candidateCategoryHierarchy(candidate);
        const matches = hierarchyNames.length > 0
          ? refs.categories.filter((item) => categoryHierarchyMatches(
            candidate,
            item,
            categoriesById
          ))
          : categoriesByText.get(normalizeLookupText(candidate.categoryName)) || [];
        if (matches.length === 1) category = matches[0];
        else {
          addException(row, {
            field: 'categoryId',
            exceptionType: matches.length > 1 ? 'CATEGORY_AMBIGUOUS' : 'CATEGORY_NOT_FOUND',
            originalValue: hierarchyNames.length > 0
              ? hierarchyNames.join(' / ')
              : candidate.categoryName || null
          });
        }
      }
      candidate.categoryId = category?._id || null;
      if (category) {
        const resolvedNames = categoryHierarchy(category, categoriesById)
          .map(({ name }) => name);
        candidate.majorCategoryName = candidate.majorCategoryName || resolvedNames[0] || '';
        candidate.equipmentTypeName = candidate.equipmentTypeName || resolvedNames[1] || '';
        candidate.primaryName = candidate.primaryName || resolvedNames[2] || '';
        candidate.secondaryName = candidate.secondaryName || resolvedNames[3] || '';
      }

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
            return orgUnit && membership && orgUnitsShareSubDepartment(
              membership.orgUnitId,
              orgUnit._id,
              orgsById
            );
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

    const sourceIdentityOwners = new Map();
    for (const row of rows) {
      const sourceIdentifiers = [
        ['productCode', row.candidate.productCode],
        ['serialNumber', row.candidate.serialNumber],
        ['brandSerialNumber', row.candidate.brandSerialNumber]
      ];
      for (const [field, value] of sourceIdentifiers) {
        const normalized = normalizeLookupText(value);
        if (!normalized || ['无', '暂无', '不详', '/', '-', '--'].includes(normalized)) continue;
        const first = sourceIdentityOwners.get(normalized);
        if (!first) {
          sourceIdentityOwners.set(normalized, {
            rowId: String(row.rowId),
            field,
            sheetName: row.sheetName,
            rowNumber: row.rowNumber,
            value
          });
          continue;
        }
        if (String(first.rowId) === String(row.rowId)) continue;
        if (row.sheetName === '闲置' && first.sheetName !== '闲置') {
          addException(row, {
            field: '_sourceIdentity',
            exceptionType: 'DUPLICATE_SOURCE_IDENTIFIER_IN_FILE',
            originalValue: {
              field,
              value,
              duplicateOf: {
                field: first.field,
                sheetName: first.sheetName,
                rowNumber: first.rowNumber
              }
            },
            message: 'The idle-register row matches an earlier active-register source identifier; skip or confirm it before publishing'
          });
        }
      }
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
      row.candidate.dataQuality = {
        ...(row.candidate.dataQuality || {}),
        exceptionTypes: [...new Set(row.exceptions.map(({ exceptionType }) => exceptionType))]
      };
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

  function mediaOriginalName(row, image, imageIndex) {
    const extension = image.extension === '.jpeg' ? '.jpg' : image.extension;
    if (!['.jpg', '.png'].includes(extension)) {
      throw new TypeError(`Unsupported equipment import image extension: ${extension}`);
    }
    return `equipment-import-${row.rowNumber}-${imageIndex + 1}${extension}`;
  }

  function filePlan({
    context,
    jobId,
    ownerType,
    originalName,
    mimeType,
    buffer
  }) {
    validateFileContent(buffer, mimeType);
    const _id = new mongoose.Types.ObjectId();
    const storageKey = createStorageKey({
      teamId: context.activeTeamId,
      originalName,
      mimeType
    });
    return {
      _id,
      buffer,
      storagePath: resolveStoragePath(requireStorageRoot(), storageKey),
      document: {
        _id,
        teamId: context.activeTeamId,
        ownerType,
        ownerId: jobId,
        storageKey,
        originalName,
        mimeType,
        size: buffer.length,
        sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
        uploaderId: context.userId,
        status: FILE_STATUSES.ACTIVE
      }
    };
  }

  function prepareWorkbookFiles({
    parsed,
    extractedMedia,
    context,
    jobId,
    upload,
    originalName
  }) {
    if (!extractedMedia || !(extractedMedia.imagesByRow instanceof Map)) {
      throw new TypeError('Equipment workbook media extractor returned an invalid row map');
    }
    const parsedRowKeys = new Set(parsed.rows.map((row) => rowKey(row.sheetName, row.rowNumber)));
    const unmatchedMediaRows = [...extractedMedia.imagesByRow.keys()].filter(
      (key) => !parsedRowKeys.has(key)
    );
    if (unmatchedMediaRows.length > 0) {
      throw new TypeError('One or more workbook images do not map to a recognized equipment row');
    }

    const plans = [filePlan({
      context,
      jobId,
      ownerType: FILE_OWNER_TYPES.EQUIPMENT_IMPORT_SOURCE,
      originalName,
      mimeType: EXCEL_MIME_TYPE,
      buffer: upload.buffer
    })];
    let stagedMediaBytes = 0;
    let stagedMediaFiles = 0;

    for (const row of parsed.rows) {
      const images = extractedMedia.imagesByRow.get(rowKey(row.sheetName, row.rowNumber)) || [];
      const validImages = images.filter(({ isValid, buffer }) => (
        isValid !== false && Buffer.isBuffer(buffer)
      ));
      const invalidImages = images.filter(({ isValid, buffer }) => (
        isValid === false || !Buffer.isBuffer(buffer)
      ));
      const sanitizedImages = validImages.filter(
        ({ sanitizationType }) => sanitizationType === JPEG_TRAILING_DATA_SANITIZATION
      );
      const expectedWpsRefs = [...new Set(row.candidate.sourceImageRefs || [])].sort();
      const mappedWpsRefs = [...new Set(images
        .filter(({ sourceKind }) => sourceKind === 'WPS_CELL_IMAGE')
        .map(({ imageRef }) => imageRef))].sort();
      const refsMatch = expectedWpsRefs.length === mappedWpsRefs.length &&
        expectedWpsRefs.every((value, index) => value === mappedWpsRefs[index]);

      const resolvedPhotoIssues = row.exceptions.filter(
        ({ exceptionType }) => exceptionType === 'PHOTO_MAPPING_PENDING'
      );
      row.exceptions = row.exceptions.filter(
        ({ exceptionType }) => exceptionType !== 'PHOTO_MAPPING_PENDING'
      );
      if (!refsMatch) {
        row.exceptions.push(buildException({
          field: '_photos',
          exceptionType: 'PHOTO_MAPPING_COUNT_MISMATCH',
          originalValue: { expectedWpsRefs, mappedWpsRefs },
          message: 'Workbook image references do not match the parsed equipment row'
        }));
      }
      if (invalidImages.length > 0) {
        row.exceptions.push(buildException({
          field: '_photos',
          exceptionType: 'INVALID_WORKBOOK_MEDIA',
          originalValue: invalidImages.map((image) => ({
            imageRef: image.imageRef,
            mediaPath: image.mediaPath,
            mimeType: image.mimeType,
            byteLength: image.byteLength ?? null,
            validationError: image.validationError || 'Media bytes are unavailable'
          })),
          message: 'One or more embedded images failed content validation and were not staged'
        }));
      }

      const photoFileIds = [];
      validImages.forEach((image, imageIndex) => {
        stagedMediaBytes += image.buffer.length;
        stagedMediaFiles += 1;
        if (stagedMediaBytes > MAX_STAGED_MEDIA_BYTES) {
          throw new RangeError('Workbook row image associations exceed the safe staging limit');
        }
        const plan = filePlan({
          context,
          jobId,
          ownerType: FILE_OWNER_TYPES.EQUIPMENT_IMPORT_MEDIA,
          originalName: mediaOriginalName(row, image, imageIndex),
          mimeType: image.mimeType,
          buffer: image.buffer
        });
        plans.push(plan);
        photoFileIds.push(plan._id);
      });
      row.candidate.photoFileIds = photoFileIds;
      const existingMediaNotices = Array.isArray(row.candidate.dataQuality?.mediaNotices)
        ? row.candidate.dataQuality.mediaNotices
        : [];
      const sanitizationNotices = sanitizedImages.map((image) => ({
        code: 'SANITIZED_WORKBOOK_MEDIA',
        sanitizationType: image.sanitizationType,
        imageRef: image.imageRef,
        sourceKind: image.sourceKind,
        mediaPath: image.mediaPath,
        mimeType: image.mimeType,
        originalByteLength: image.originalByteLength,
        normalizedByteLength: image.normalizedByteLength,
        removedTrailingBytes: image.removedTrailingBytes
      }));
      row.candidate.dataQuality = {
        ...(row.candidate.dataQuality || {}),
        photoMappingStatus: invalidImages.length > 0
          ? validImages.length > 0 ? 'PARTIALLY_STAGED' : 'INVALID_SOURCE_MEDIA'
          : validImages.length > 0 ? 'STAGED' : 'NO_SOURCE_PHOTO',
        photoCount: validImages.length,
        sourcePhotoCount: images.length,
        invalidPhotoCount: invalidImages.length,
        sanitizedPhotoCount: sanitizedImages.length,
        photoSourceKinds: [...new Set(images.map(({ sourceKind }) => sourceKind))],
        mediaNotices: [...existingMediaNotices, ...sanitizationNotices],
        resolvedPhotoMappingIssues: resolvedPhotoIssues.map(({ exceptionType }) => exceptionType)
      };
    }

    return {
      plans,
      sourceFileId: plans[0]._id,
      mediaSummary: {
        ...(extractedMedia.summary || {}),
        stagedMediaFiles,
        stagedMediaBytes
      }
    };
  }

  async function writeFilePlans(plans) {
    const written = [];
    try {
      for (const plan of plans) {
        await fs.promises.mkdir(path.dirname(plan.storagePath), {
          recursive: true,
          mode: 0o700
        });
        await fs.promises.writeFile(plan.storagePath, plan.buffer, {
          flag: 'wx',
          mode: 0o600
        });
        written.push(plan);
      }
      return written;
    } catch (error) {
      await Promise.all(written.map((plan) => (
        fs.promises.rm(plan.storagePath, { force: true }).catch(() => {})
      )));
      throw error;
    }
  }

  async function removeFilePlans(plans) {
    await Promise.all(plans.map((plan) => (
      fs.promises.rm(plan.storagePath, { force: true }).catch(() => {})
    )));
  }

  async function cleanupFailedPreview({ context, jobId, plans }) {
    await Promise.all([
      typeof FileAssetModel.deleteMany === 'function'
        ? FileAssetModel.deleteMany({
          _id: { $in: plans.map(({ _id }) => _id) },
          teamId: context.activeTeamId,
          ownerId: jobId
        }).catch(() => {})
        : Promise.resolve(),
      typeof ImportExceptionModel.deleteMany === 'function'
        ? ImportExceptionModel.deleteMany({
          teamId: context.activeTeamId,
          importJobId: jobId
        }).catch(() => {})
        : Promise.resolve(),
      typeof ImportJobModel.deleteOne === 'function'
        ? ImportJobModel.deleteOne({
          _id: jobId,
          teamId: context.activeTeamId
        }).catch(() => {})
        : Promise.resolve()
    ]);
    await removeFilePlans(plans);
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
    let extractedMedia;
    try {
      extractedMedia = extractWorkbookMedia(upload.buffer, { workbook: parsed.workbook || null });
    } catch (error) {
      if (error instanceof RangeError) {
        throw importError(413, 'EQUIPMENT_IMPORT_MEDIA_LIMIT', error.message);
      }
      throw importError(400, 'EQUIPMENT_IMPORT_MEDIA_INVALID', error.message);
    }

    const jobId = new mongoose.Types.ObjectId();
    let staging;
    try {
      staging = prepareWorkbookFiles({
        parsed,
        extractedMedia,
        context,
        jobId,
        upload,
        originalName
      });
      await writeFilePlans(staging.plans);
    } catch (error) {
      if (error instanceof EquipmentImportError) throw error;
      if (error instanceof RangeError) {
        throw importError(413, 'EQUIPMENT_IMPORT_MEDIA_LIMIT', error.message);
      }
      throw importError(500, 'EQUIPMENT_IMPORT_STORAGE_WRITE_FAILED', error.message);
    }

    try {
      return await runWithOptionalTransaction(async (session) => {
        const rows = await enrichRows({ parsed, context, scope, session });
        const referencedOrgUnitIds = [
          scope.scope === DATA_SCOPES.ORG_UNIT ? scope.orgUnitId : null,
          ...rows.map(({ candidate }) => candidate.orgUnitId)
        ].filter(Boolean);
        const lockedOrgUnits = await lockActiveOrgUnitReferences({
          OrgUnitModel,
          teamId: context.activeTeamId,
          orgUnitIds: referencedOrgUnitIds,
          session
        });
        if (!lockedOrgUnits) {
          throw importError(
            409,
            'EQUIPMENT_IMPORT_REFERENCE_CHANGED',
            'One or more organization units changed during preview creation'
          );
        }
        const counters = {
          totalRows: rows.length,
          validRows: rows.filter(({ validationStatus }) => validationStatus === IMPORT_ROW_STATUSES.VALID).length,
          warningRows: rows.filter(({ validationStatus }) => validationStatus === IMPORT_ROW_STATUSES.WARNING).length,
          errorRows: rows.filter(({ validationStatus }) => validationStatus === IMPORT_ROW_STATUSES.ERROR).length
        };
        const job = new ImportJobModel({
          _id: jobId,
          teamId: context.activeTeamId,
          type: IMPORT_TYPES.EQUIPMENT_ASSET,
          sourceFileId: staging.sourceFileId,
          sourceFileName: originalName,
          sourceFileSize: upload.size,
          sourceSha256,
          sourceSheetNames: parsed.sheetNames,
          mediaSummary: staging.mediaSummary,
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
        await FileAssetModel.insertMany(
          staging.plans.map(({ document }) => document),
          { ordered: true, session: session || undefined }
        );

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
            exceptionCount: exceptions.length,
            stagedMediaFiles: staging.mediaSummary.stagedMediaFiles
          },
          targetTeamId: context.activeTeamId,
          session
        });
        return {
          importJob: serializeJob(job, { includeRows: true }),
          exceptionCount: exceptions.length
        };
      }, connection);
    } catch (error) {
      await cleanupFailedPreview({ context, jobId, plans: staging.plans });
      throw error;
    }
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

  function optionalCandidateDate(value, field) {
    if (value === null || value === undefined || value === '') return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw confirmationInvalid(`${field} must be a valid date`);
    return date;
  }

  function optionalCandidateNumber(value, field, fallback = null) {
    if (value === null || value === undefined || value === '') return fallback;
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) {
      throw confirmationInvalid(`${field} must be a non-negative number`);
    }
    return number;
  }

  function optionalDatePrecision(value, field) {
    if (value === null || value === undefined || value === '') return null;
    if (!EquipmentAsset.DATE_PRECISION_VALUES.includes(value)) {
      throw confirmationInvalid(`${field} must be a supported date precision`);
    }
    return value;
  }

  function sourceImageRefs(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map((item) => optionalText(item, 'sourceImageRefs', 200)).filter(Boolean))]
      .slice(0, 500);
  }

  function photoFileIds(value) {
    if (!Array.isArray(value)) return [];
    const ids = value.map((item) => normalizeRelatedId(item, 'photoFileIds'));
    if (ids.length > 500 || new Set(ids.map(String)).size !== ids.length) {
      throw confirmationInvalid('photoFileIds must contain at most 500 unique file ids');
    }
    return ids;
  }

  function currentCategorySnapshots(category, categoriesById) {
    const path = [];
    const visited = new Set();
    let cursor = category;
    while (cursor) {
      const categoryId = String(cursor._id || '');
      if (!categoryId || visited.has(categoryId)) {
        throw confirmationInvalid('A confirmed category path is invalid');
      }
      visited.add(categoryId);
      path.unshift(cursor);
      if (!cursor.parentId) break;
      cursor = categoriesById.get(String(cursor.parentId));
      if (!cursor) {
        throw confirmationInvalid('A confirmed category path is no longer complete');
      }
    }
    if (path.length > MAX_EQUIPMENT_CATEGORY_DEPTH) {
      throw confirmationInvalid(
        `Equipment categories support at most ${MAX_EQUIPMENT_CATEGORY_DEPTH} levels`
      );
    }
    const names = path.map(({ name }) => name || '');
    return {
      majorCategoryName: names[0] || '',
      equipmentTypeName: names[1] || '',
      primaryName: names[2] || '',
      secondaryName: names[3] || ''
    };
  }

  async function finalAssetPayloads({ context, scope, rows, skippedRowIds, job, session }) {
    const activeRows = [...rows.entries()].filter(([rowId]) => !skippedRowIds.has(rowId));
    const codes = new Set();
    const orgIds = new Set();
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
      if (scope.scope === DATA_SCOPES.ORG_UNIT && !isOrgUnitInDataScope(scope, orgUnitId)) {
        throw confirmationInvalid('A confirmed row is outside the importer organization scope');
      }
      orgIds.add(String(orgUnitId));
      if (custodianUserId) custodianIds.add(String(custodianUserId));
      const quantity = Number(candidate.quantity);
      if (!Number.isFinite(quantity) || quantity < 0) {
        throw confirmationInvalid('quantity must be a non-negative number');
      }
      if (!EquipmentAsset.EQUIPMENT_STATUS_VALUES.includes(candidate.status)) {
        throw confirmationInvalid('status must be a supported equipment status');
      }
      const acquisitionDate = optionalCandidateDate(candidate.acquisitionDate, 'acquisitionDate');
      const productionDate = optionalCandidateDate(candidate.productionDate, 'productionDate');
      const activationDate = optionalCandidateDate(candidate.activationDate, 'activationDate');
      const idlePlacedAt = optionalCandidateDate(candidate.idlePlacedAt, 'idlePlacedAt');
      const originalValue = optionalCandidateNumber(candidate.originalValue, 'originalValue');
      const bookQuantity = optionalCandidateNumber(candidate.bookQuantity, 'bookQuantity');
      const physicalQuantity = optionalCandidateNumber(
        candidate.physicalQuantity,
        'physicalQuantity',
        quantity
      );
      return {
        rowId,
        payload: {
          teamId: context.activeTeamId,
          orgUnitId,
          assetCode,
          sourceAssetCode: optionalText(candidate.sourceAssetCode, 'sourceAssetCode', 500),
          sourceSequence: optionalText(candidate.sourceSequence, 'sourceSequence', 100),
          assetType: optionalText(candidate.assetType, 'assetType', 100),
          sourceSheetName: optionalText(state.row.sheetName, 'sourceSheetName', 100),
          sourceRowNumber: state.row.rowNumber,
          sourceRawValues: state.row.rawValues || null,
          sourceImageRefs: sourceImageRefs(candidate.sourceImageRefs),
          productCode: optionalText(candidate.productCode, 'productCode', 500),
          plateNumber: optionalText(candidate.plateNumber, 'plateNumber', 100),
          serialNumber: optionalText(candidate.serialNumber, 'serialNumber', 500),
          brandSerialNumber: optionalText(candidate.brandSerialNumber, 'brandSerialNumber', 500),
          name: requiredText(candidate.name, 'name', 200),
          categoryId,
          specification: optionalText(candidate.specification, 'specification', 500),
          manufacturer: optionalText(candidate.manufacturer, 'manufacturer', 200),
          brand: optionalText(candidate.brand, 'brand', 200),
          vehicleLength: optionalText(candidate.vehicleLength, 'vehicleLength', 100),
          ratedCapacityText: optionalText(candidate.ratedCapacityText, 'ratedCapacityText', 100),
          powerType: optionalText(candidate.powerType, 'powerType', 100),
          emissionStandard: optionalText(
            candidate.emissionStandard,
            'emissionStandard',
            100
          ),
          quantity,
          bookQuantity,
          physicalQuantity,
          unit: optionalText(candidate.unit, 'unit', 50),
          acquisitionDate,
          productionDate,
          productionDatePrecision: optionalDatePrecision(
            candidate.productionDatePrecision,
            'productionDatePrecision'
          ),
          productionDateRaw: optionalText(candidate.productionDateRaw, 'productionDateRaw', 200),
          productionDateDisplay: optionalText(
            candidate.productionDateDisplay,
            'productionDateDisplay',
            200
          ),
          activationDate,
          activationDatePrecision: optionalDatePrecision(
            candidate.activationDatePrecision,
            'activationDatePrecision'
          ),
          activationDateRaw: optionalText(candidate.activationDateRaw, 'activationDateRaw', 200),
          activationDateDisplay: optionalText(
            candidate.activationDateDisplay,
            'activationDateDisplay',
            200
          ),
          idlePlacedAt,
          idlePlacedAtRaw: optionalText(candidate.idlePlacedAtRaw, 'idlePlacedAtRaw', 200),
          idlePlacedAtDisplay: optionalText(
            candidate.idlePlacedAtDisplay,
            'idlePlacedAtDisplay',
            200
          ),
          originalValue,
          custodianUserId,
          custodianDisplayName: optionalText(
            candidate.custodianDisplayName || candidate.custodianName,
            'custodianDisplayName',
            200
          ),
          orgUnitNameSnapshot: optionalText(
            candidate.orgUnitNameSnapshot || candidate.orgUnitName,
            'orgUnitNameSnapshot',
            200
          ),
          location: optionalText(candidate.location, 'location', 500),
          status: trustedImportEquipmentStatus(candidate.status),
          conditionText: optionalText(candidate.conditionText, 'conditionText', 200),
          forkliftPosition: optionalText(candidate.forkliftPosition, 'forkliftPosition', 100),
          environmentalRegistrationCode: optionalText(
            candidate.environmentalRegistrationCode,
            'environmentalRegistrationCode',
            200
          ),
          sourceImportJobId: job._id,
          remark: optionalText(candidate.remark, 'remark', 2000),
          photoFileIds: photoFileIds(candidate.photoFileIds),
          dataQuality: candidate.dataQuality && typeof candidate.dataQuality === 'object'
            ? {
              ...candidate.dataQuality,
              photoMappingStatus: Number(candidate.dataQuality.invalidPhotoCount || 0) > 0
                ? Array.isArray(candidate.photoFileIds) && candidate.photoFileIds.length > 0
                  ? 'PARTIALLY_MAPPED_CONFIRMED'
                  : 'INVALID_SOURCE_MEDIA_CONFIRMED'
                : Array.isArray(candidate.photoFileIds) && candidate.photoFileIds.length > 0
                  ? 'MAPPED'
                  : 'NO_SOURCE_PHOTO'
            }
            : {},
          createdBy: context.userId,
          updatedBy: context.userId
        }
      };
    });

    const orgUnits = await lockActiveOrgUnitReferences({
      OrgUnitModel,
      teamId: context.activeTeamId,
      orgUnitIds: [...orgIds],
      session
    });
    const categories = await execute(EquipmentCategoryModel.find({
      teamId: context.activeTeamId
    }).select('_id name parentId status').lean(), session);
    const memberships = custodianIds.size === 0
      ? []
      : await execute(TeamMembershipModel.find({
        teamId: context.activeTeamId,
        userId: { $in: [...custodianIds] },
        status: MEMBERSHIP_STATUSES.ACTIVE
      }).select('userId orgUnitId').lean(), session);
    const activeCustodians = custodianIds.size === 0
      ? []
      : await execute(UserModel.find({
        _id: { $in: [...custodianIds] },
        status: 'active'
      }).select('_id').lean(), session);
    const existingAssets = codes.size === 0
      ? []
      : await execute(EquipmentAssetModel.find({
        teamId: context.activeTeamId,
        assetCode: { $in: [...codes] }
      }).select('assetCode').lean(), session);
    const activeTeamOrgUnits = await execute(OrgUnitModel.find({
      teamId: context.activeTeamId,
      status: ORG_UNIT_STATUSES.ACTIVE
    }).select('_id type level path').lean(), session);
    if (!orgUnits || orgUnits.length !== orgIds.size) {
      throw confirmationInvalid('One or more organization units are no longer active in this team');
    }
    const categoriesById = new Map(categories.map((category) => [String(category._id), category]));
    for (const { payload } of normalized) {
      const category = categoriesById.get(String(payload.categoryId));
      if (category?.status !== EquipmentCategory.EQUIPMENT_CATEGORY_STATUSES.ACTIVE) {
        throw confirmationInvalid('One or more categories are no longer active in this team');
      }
      Object.assign(payload, currentCategorySnapshots(category, categoriesById));
    }
    if (existingAssets.length > 0) {
      throw confirmationInvalid(`assetCode ${existingAssets[0].assetCode} already exists in this team`);
    }
    if (activeCustodians.length !== custodianIds.size) {
      throw confirmationInvalid('One or more custodians are no longer active');
    }
    const membershipByUser = new Map(memberships.map((item) => [String(item.userId), item]));
    const orgUnitsById = new Map(activeTeamOrgUnits.map((item) => [String(item._id), item]));
    for (const { payload } of normalized) {
      if (!payload.custodianUserId) continue;
      const membership = membershipByUser.get(String(payload.custodianUserId));
      if (
        !membership ||
        !orgUnitsShareSubDepartment(membership.orgUnitId, payload.orgUnitId, orgUnitsById)
      ) {
        throw confirmationInvalid('A custodian is no longer active in the selected organization');
      }
    }
    return normalized;
  }

  async function assertStagedImportFiles({ context, job, rows, session }) {
    const expectedMediaIds = [];
    for (const { candidate } of rows.values()) {
      expectedMediaIds.push(...(candidate.photoFileIds || []).map(String));
    }
    if (new Set(expectedMediaIds).size !== expectedMediaIds.length) {
      throw confirmationInvalid('A staged equipment image is referenced by more than one row');
    }
    const files = await execute(FileAssetModel.find({
      teamId: context.activeTeamId,
      ownerId: job._id,
      ownerType: {
        $in: [
          FILE_OWNER_TYPES.EQUIPMENT_IMPORT_SOURCE,
          FILE_OWNER_TYPES.EQUIPMENT_IMPORT_MEDIA
        ]
      },
      status: FILE_STATUSES.ACTIVE
    }).lean(), session);
    const sourceFiles = files.filter(
      ({ ownerType }) => ownerType === FILE_OWNER_TYPES.EQUIPMENT_IMPORT_SOURCE
    );
    const mediaFiles = files.filter(
      ({ ownerType }) => ownerType === FILE_OWNER_TYPES.EQUIPMENT_IMPORT_MEDIA
    );
    if (
      sourceFiles.length !== 1 ||
      !job.sourceFileId ||
      !sameId(sourceFiles[0]._id, job.sourceFileId)
    ) {
      throw confirmationInvalid('The staged source workbook is missing or has changed');
    }
    const actualMediaIds = new Set(mediaFiles.map(({ _id }) => String(_id)));
    if (
      actualMediaIds.size !== expectedMediaIds.length ||
      expectedMediaIds.some((fileId) => !actualMediaIds.has(fileId))
    ) {
      throw confirmationInvalid('One or more staged equipment images are missing or have changed');
    }
  }

  async function bindPublishedMedia({
    context,
    job,
    rows,
    skippedRowIds,
    createdByRowId,
    resolvedAt,
    session
  }) {
    const operations = [];
    for (const [rowId, state] of rows.entries()) {
      const ids = state.candidate.photoFileIds || [];
      if (skippedRowIds.has(rowId)) {
        ids.forEach((fileId) => operations.push({
          updateOne: {
            filter: {
              _id: fileId,
              teamId: context.activeTeamId,
              ownerType: FILE_OWNER_TYPES.EQUIPMENT_IMPORT_MEDIA,
              ownerId: job._id,
              status: FILE_STATUSES.ACTIVE
            },
            update: {
              $set: {
                status: FILE_STATUSES.DELETED,
                deletedAt: resolvedAt,
                deletedBy: context.userId
              }
            }
          }
        }));
        continue;
      }
      const equipment = createdByRowId.get(rowId);
      if (!equipment) throw confirmationInvalid('Published equipment media lost its target asset');
      ids.forEach((fileId) => operations.push({
        updateOne: {
          filter: {
            _id: fileId,
            teamId: context.activeTeamId,
            ownerType: FILE_OWNER_TYPES.EQUIPMENT_IMPORT_MEDIA,
            ownerId: job._id,
            status: FILE_STATUSES.ACTIVE
          },
          update: {
            $set: {
              ownerType: FILE_OWNER_TYPES.EQUIPMENT,
              ownerId: equipment._id
            }
          }
        }
      }));
    }
    if (operations.length === 0) return;
    const result = await FileAssetModel.bulkWrite(operations, {
      ordered: true,
      session: session || undefined
    });
    if (result.matchedCount !== operations.length) {
      throw confirmationInvalid('One or more staged equipment images changed during publication');
    }
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
    const { context: transactionContext } = contextAndScope(authContext);

    try {
      return await runRegistryWriteTransaction(async (session) => {
        await lockEquipmentCategoryStructure(transactionContext, session);
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
          throw importError(
            409,
            job.status === IMPORT_JOB_STATUSES.CANCELLED
              ? 'EQUIPMENT_IMPORT_CANCELLED'
              : 'EQUIPMENT_IMPORT_ALREADY_PUBLISHED',
            job.status === IMPORT_JOB_STATUSES.CANCELLED
              ? 'Equipment import has been cancelled'
              : 'Equipment import is already published'
          );
        }
        const exceptions = await execute(ImportExceptionModel.find({
          teamId: context.activeTeamId,
          importJobId: job._id,
          status: IMPORT_EXCEPTION_STATUSES.PENDING
        }), session);
        const decisionState = applyDecisions({ job, exceptions, input });
        await assertStagedImportFiles({
          context,
          job,
          rows: decisionState.rows,
          session
        });
        const payloads = await finalAssetPayloads({
          context,
          scope,
          rows: decisionState.rows,
          skippedRowIds: decisionState.skippedRowIds,
          job,
          session
        });
        const canonicalPayloadByRowId = new Map(
          payloads.map(({ rowId, payload }) => [String(rowId), payload])
        );
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
        await bindPublishedMedia({
          context,
          job,
          rows: decisionState.rows,
          skippedRowIds: decisionState.skippedRowIds,
          createdByRowId,
          resolvedAt,
          session
        });
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
          const canonicalPayload = canonicalPayloadByRowId.get(rowId);
          if (!canonicalPayload) {
            throw confirmationInvalid('Published equipment lost its canonical category snapshot');
          }
          Object.assign(stagedRow.candidate, {
            majorCategoryName: canonicalPayload.majorCategoryName,
            equipmentTypeName: canonicalPayload.equipmentTypeName,
            primaryName: canonicalPayload.primaryName,
            secondaryName: canonicalPayload.secondaryName
          });
          stagedRow.validationStatus = IMPORT_ROW_STATUSES.PUBLISHED;
          stagedRow.publishedEquipmentId = equipment._id;
        }
        job.status = IMPORT_JOB_STATUSES.PUBLISHED;
        job.stagingCleanupStatus = ImportJob.IMPORT_STAGING_CLEANUP_STATUSES.RETAINED;
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
      });
    } catch (error) {
      if (error?.code === 11000) {
        throw confirmationInvalid('An asset code or import exception became duplicated during confirmation');
      }
      if (categoryStructureConflict(error)) {
        throw importError(
          409,
          EQUIPMENT_CATEGORY_STRUCTURE_CONFLICT.code,
          EQUIPMENT_CATEGORY_STRUCTURE_CONFLICT.message
        );
      }
      throw error;
    }
  }

  async function cancelImport({ authContext, req, importJobId, input = {} }) {
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
    const cancelled = await runWithOptionalTransaction(async (session) => {
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
        if (unversioned.job.status === IMPORT_JOB_STATUSES.CANCELLED) {
          throw importError(409, 'EQUIPMENT_IMPORT_ALREADY_CANCELLED', 'Equipment import is already cancelled');
        }
        if (unversioned.job.status === IMPORT_JOB_STATUSES.PUBLISHED) {
          throw importError(409, 'EQUIPMENT_IMPORT_ALREADY_PUBLISHED', 'Published imports cannot be cancelled');
        }
        throw importError(409, 'EQUIPMENT_IMPORT_VERSION_CONFLICT', 'Equipment import preview has changed');
      }
      const { context, job } = visible;
      if (job.status !== IMPORT_JOB_STATUSES.PREVIEW_READY) {
        throw importError(
          409,
          job.status === IMPORT_JOB_STATUSES.CANCELLED
            ? 'EQUIPMENT_IMPORT_ALREADY_CANCELLED'
            : 'EQUIPMENT_IMPORT_ALREADY_PUBLISHED',
          job.status === IMPORT_JOB_STATUSES.CANCELLED
            ? 'Equipment import is already cancelled'
            : 'Published imports cannot be cancelled'
        );
      }
      const cancelledAt = new Date();
      await FileAssetModel.updateMany({
        teamId: context.activeTeamId,
        ownerId: job._id,
        ownerType: {
          $in: [
            FILE_OWNER_TYPES.EQUIPMENT_IMPORT_SOURCE,
            FILE_OWNER_TYPES.EQUIPMENT_IMPORT_MEDIA
          ]
        },
        status: FILE_STATUSES.ACTIVE
      }, {
        $set: {
          status: FILE_STATUSES.DELETED,
          deletedAt: cancelledAt,
          deletedBy: context.userId
        }
      }, { session: session || undefined });
      await ImportExceptionModel.updateMany({
        teamId: context.activeTeamId,
        importJobId: job._id,
        status: IMPORT_EXCEPTION_STATUSES.PENDING
      }, {
        $set: {
          customerDecision: IMPORT_CUSTOMER_DECISIONS.SKIP_ROW,
          status: IMPORT_EXCEPTION_STATUSES.SKIPPED,
          resolvedBy: context.userId,
          resolvedAt: cancelledAt
        }
      }, { session: session || undefined });
      job.status = IMPORT_JOB_STATUSES.CANCELLED;
      job.cancelledBy = context.userId;
      job.cancelledAt = cancelledAt;
      job.cancelReason = reason;
      await auditService.record({
        req,
        authContext: context,
        action: AUDIT_ACTIONS.STATUS_CHANGE,
        resourceType: AUDIT_RESOURCE_TYPES.IMPORT_JOB,
        resourceId: job._id,
        before: { status: IMPORT_JOB_STATUSES.PREVIEW_READY },
        after: { status: IMPORT_JOB_STATUSES.CANCELLED },
        reason,
        targetTeamId: context.activeTeamId,
        session
      });
      await job.save({ session: session || undefined });
      return {
        context,
        jobId: job._id,
        teamId: job.teamId
      };
    }, connection);
    let finalized;
    try {
      finalized = await cleanupService.finalizeCleanup({
        jobId: cancelled.jobId,
        teamId: cancelled.teamId,
        req,
        authContext: cancelled.context
      });
    } catch {
      const job = await ImportJobModel.findOne({
        _id: cancelled.jobId,
        teamId: cancelled.teamId,
        status: IMPORT_JOB_STATUSES.CANCELLED
      }).lean();
      if (!job) throw importNotFound();
      return {
        importJob: serializeJob(job),
        stagingCleanup: {
          status: job.stagingCleanupStatus,
          retryRequired: true
        }
      };
    }
    return {
      importJob: serializeJob(finalized.job),
      stagingCleanup: finalized.cleanup
    };
  }

  async function retryImportCleanup({ authContext, req, importJobId }) {
    const { context, job } = await findVisibleJob({ authContext, importJobId });
    if (![IMPORT_JOB_STATUSES.CANCELLED, IMPORT_JOB_STATUSES.EXPIRED].includes(job.status)) {
      throw importError(
        409,
        job.status === IMPORT_JOB_STATUSES.PUBLISHED
          ? 'EQUIPMENT_IMPORT_ALREADY_PUBLISHED'
          : 'EQUIPMENT_IMPORT_NOT_CLEANABLE',
        job.status === IMPORT_JOB_STATUSES.PUBLISHED
          ? 'Published imports cannot be cleaned'
          : 'The import preview must be cancelled before cleanup'
      );
    }
    const finalized = await cleanupService.finalizeCleanup({
      jobId: job._id,
      teamId: job.teamId,
      req,
      authContext: context
    });
    return {
      importJob: serializeJob(finalized.job),
      stagingCleanup: finalized.cleanup
    };
  }

  return Object.freeze({
    cancelImport,
    confirmImport,
    createPreview,
    getImportJob,
    listExceptions,
    retryImportCleanup
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
