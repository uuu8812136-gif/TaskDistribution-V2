'use strict';

const mongoose = require('mongoose');
const XLSX = require('xlsx');
const EquipmentAsset = require('../models/EquipmentAsset');
const EquipmentCategory = require('../models/EquipmentCategory');
const EquipmentChangeRecord = require('../models/EquipmentChangeRecord');
const OrgUnit = require('../models/OrgUnit');
const ProjectTeam = require('../models/ProjectTeam');
const TeamMembership = require('../models/TeamMembership');
const User = require('../models/User');
const {
  AUDIT_ACTIONS,
  AUDIT_RESOURCE_TYPES,
  DATA_SCOPES,
  DATA_SCOPE_MODULES,
  MEMBERSHIP_ROLES,
  MEMBERSHIP_STATUSES,
  ORG_UNIT_STATUSES,
  SESSION_MODES,
  TEAM_STATUSES
} = require('../config/permissions');
const { createAuditService } = require('./auditService');
const { normalizeId } = require('./authSessionService');
const {
  buildScopedDetailFilter,
  buildScopedFilter,
  normalizeObjectId
} = require('./scopedQueryService');
const {
  assertBusinessContext,
  assertPermission,
  assertTeamContext,
  resolveModuleDataScope,
  sameId
} = require('./teamContextService');
const { runWithOptionalTransaction } = require('./transactionService');

const { EQUIPMENT_STATUSES, EQUIPMENT_STATUS_VALUES } = EquipmentAsset;
const {
  EQUIPMENT_CATEGORY_STATUSES,
  EQUIPMENT_CATEGORY_STATUS_VALUES
} = EquipmentCategory;
const { EQUIPMENT_CHANGE_TYPES } = EquipmentChangeRecord;

const QR_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,86}$/;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 200;

class EquipmentRegistryError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'EquipmentRegistryError';
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}

function registryError(status, code, message) {
  return new EquipmentRegistryError(status, code, message);
}

function notFound(resource = 'Equipment') {
  return registryError(404, 'EQUIPMENT_NOT_FOUND', `${resource} does not exist`);
}

function relatedInvalid() {
  return registryError(
    400,
    'EQUIPMENT_RELATED_RESOURCE_INVALID',
    'One or more related resources are invalid for the active team and organization unit'
  );
}

function normalizeDetailId(value) {
  try {
    return normalizeObjectId(value, 'id');
  } catch {
    throw notFound();
  }
}

function normalizeRelatedId(value, { optional = false } = {}) {
  if (optional && (value === null || value === undefined || value === '')) return null;
  try {
    return normalizeObjectId(value, 'related resource id');
  } catch {
    throw relatedInvalid();
  }
}

function requiredString(value, field, max) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw registryError(400, 'EQUIPMENT_INPUT_INVALID', `${field} is required`);
  }
  const normalized = value.trim();
  if (normalized.length > max) {
    throw registryError(400, 'EQUIPMENT_INPUT_INVALID', `${field} is too long`);
  }
  return normalized;
}

function optionalString(value, field, max, fallback = '') {
  if (value === undefined) return fallback;
  if (value === null) return fallback;
  if (typeof value !== 'string') {
    throw registryError(400, 'EQUIPMENT_INPUT_INVALID', `${field} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length > max) {
    throw registryError(400, 'EQUIPMENT_INPUT_INVALID', `${field} is too long`);
  }
  return normalized;
}

function optionalNumber(value, field, { min = 0, fallback = null } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    throw registryError(400, 'EQUIPMENT_INPUT_INVALID', `${field} must be a valid number`);
  }
  return value;
}

function optionalDate(value, field, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw registryError(400, 'EQUIPMENT_INPUT_INVALID', `${field} must be a valid date`);
  }
  return date;
}

function integer(value, field, { min = 0, max = 2147483647, fallback = 0 } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw registryError(400, 'EQUIPMENT_INPUT_INVALID', `${field} must be an integer`);
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

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function plain(document) {
  return typeof document?.toObject === 'function'
    ? document.toObject({ depopulate: true, versionKey: false })
    : document;
}

function serializeCategory(document) {
  const value = plain(document);
  return {
    _id: normalizeId(value._id),
    teamId: normalizeId(value.teamId),
    name: value.name,
    parentId: normalizeId(value.parentId),
    sortOrder: value.sortOrder,
    status: value.status,
    createdBy: normalizeId(value.createdBy),
    updatedBy: normalizeId(value.updatedBy),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  };
}

function serializeAsset(document) {
  const value = plain(document);
  return {
    _id: normalizeId(value._id),
    teamId: normalizeId(value.teamId),
    orgUnitId: normalizeId(value.orgUnitId),
    assetCode: value.assetCode,
    sourceAssetCode: value.sourceAssetCode || '',
    sourceSequence: value.sourceSequence || '',
    assetType: value.assetType || '',
    sourceSheetName: value.sourceSheetName || '',
    sourceRowNumber: value.sourceRowNumber ?? null,
    sourceRawValues: value.sourceRawValues || null,
    sourceImageRefs: Array.isArray(value.sourceImageRefs) ? [...value.sourceImageRefs] : [],
    productCode: value.productCode || '',
    plateNumber: value.plateNumber || '',
    serialNumber: value.serialNumber || '',
    brandSerialNumber: value.brandSerialNumber || '',
    name: value.name,
    categoryId: normalizeId(value.categoryId),
    specification: value.specification,
    manufacturer: value.manufacturer,
    brand: value.brand || '',
    vehicleLength: value.vehicleLength || '',
    ratedCapacityText: value.ratedCapacityText || '',
    quantity: value.quantity,
    bookQuantity: value.bookQuantity ?? null,
    physicalQuantity: value.physicalQuantity ?? null,
    unit: value.unit,
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
    custodianUserId: normalizeId(value.custodianUserId),
    custodianDisplayName: value.custodianDisplayName || '',
    orgUnitNameSnapshot: value.orgUnitNameSnapshot || '',
    location: value.location,
    status: value.status,
    conditionText: value.conditionText || '',
    forkliftPosition: value.forkliftPosition || '',
    environmentalRegistrationCode: value.environmentalRegistrationCode || '',
    currentRuntimeHours: value.currentRuntimeHours ?? null,
    runtimeHoursUpdatedAt: value.runtimeHoursUpdatedAt || null,
    lastRuntimeReadingId: normalizeId(value.lastRuntimeReadingId),
    sourceImportJobId: normalizeId(value.sourceImportJobId),
    remark: value.remark,
    photoFileIds: Array.isArray(value.photoFileIds)
      ? value.photoFileIds.map(normalizeId).filter(Boolean)
      : [],
    dataQuality: value.dataQuality || {},
    createdBy: normalizeId(value.createdBy),
    updatedBy: normalizeId(value.updatedBy),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  };
}

function serializeChangeRecord(document) {
  const value = plain(document);
  return {
    _id: normalizeId(value._id),
    teamId: normalizeId(value.teamId),
    orgUnitId: normalizeId(value.orgUnitId),
    equipmentId: normalizeId(value.equipmentId),
    changeType: value.changeType,
    before: value.before || null,
    after: value.after,
    operatorId: normalizeId(value.operatorId),
    reason: value.reason || null,
    occurredAt: value.occurredAt
  };
}

function normalizePersistenceError(error) {
  if (error?.code === 11000) {
    const assetCodeDuplicate = Object.prototype.hasOwnProperty.call(
      error.keyPattern || {},
      'assetCode'
    );
    return registryError(
      409,
      assetCodeDuplicate ? 'EQUIPMENT_ASSET_CODE_DUPLICATE' : 'EQUIPMENT_CATEGORY_DUPLICATE',
      assetCodeDuplicate
        ? 'assetCode must be unique within the team'
        : 'Equipment category name must be unique within the team'
    );
  }
  return error;
}

async function execute(query, session) {
  if (session && typeof query.session === 'function') query.session(session);
  return query;
}

async function createOne(Model, payload, session) {
  if (!session) return Model.create(payload);
  const documents = await Model.create([payload], { session });
  return documents[0];
}

function formulaSafe(value) {
  if (typeof value !== 'string') return value;
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

function assertNoClientTeamId(input) {
  if (Object.prototype.hasOwnProperty.call(input || {}, 'teamId')) {
    throw registryError(
      400,
      'EQUIPMENT_TEAM_ID_IMMUTABLE',
      'teamId is derived from the authenticated team and cannot be supplied by the client'
    );
  }
}

function createEquipmentRegistryService({
  EquipmentAssetModel = EquipmentAsset,
  EquipmentCategoryModel = EquipmentCategory,
  EquipmentChangeRecordModel = EquipmentChangeRecord,
  OrgUnitModel = OrgUnit,
  ProjectTeamModel = ProjectTeam,
  TeamMembershipModel = TeamMembership,
  UserModel = User,
  auditService = createAuditService(),
  connection = mongoose.connection
} = {}) {
  async function resolveReadTeamId(authContext, requestedTeamId) {
    const context = assertBusinessContext(authContext);
    if (context.mode === SESSION_MODES.TEAM) {
      return normalizeObjectId(context.activeTeamId, 'activeTeamId');
    }
    if (context.mode !== SESSION_MODES.GLOBAL_READ_ONLY) {
      throw registryError(403, 'EQUIPMENT_TEAM_CONTEXT_REQUIRED', 'Select a team first');
    }

    let teamId;
    try {
      teamId = normalizeObjectId(requestedTeamId, 'teamId');
    } catch {
      throw registryError(
        400,
        'EQUIPMENT_TEAM_REQUIRED',
        'A valid teamId is required in global read-only mode'
      );
    }
    const exists = await ProjectTeamModel.exists({
      _id: teamId,
      status: TEAM_STATUSES.ACTIVE
    });
    if (!exists) throw notFound();
    return teamId;
  }

  async function buildReadFilter({
    authContext,
    requestedTeamId,
    method,
    id,
    userFilter = {},
    permissionKey = 'equipment.view'
  }) {
    assertPermission(authContext, permissionKey);
    const teamId = await resolveReadTeamId(authContext, requestedTeamId);
    if (id) {
      return {
        teamId,
        filter: buildScopedDetailFilter({
          authContext,
          moduleKey: DATA_SCOPE_MODULES.EQUIPMENT,
          id: normalizeDetailId(id),
          userFilter,
          globalTeamId: teamId,
          method
        })
      };
    }
    return {
      teamId,
      filter: buildScopedFilter({
        authContext,
        moduleKey: DATA_SCOPE_MODULES.EQUIPMENT,
        userFilter,
        globalTeamId: teamId,
        method
      })
    };
  }

  async function buildCategoryReadFilter({
    authContext,
    requestedTeamId,
    id,
    userFilter = {}
  }) {
    assertPermission(authContext, 'equipment.view');
    const teamId = await resolveReadTeamId(authContext, requestedTeamId);
    return {
      teamId,
      filter: {
        $and: [
          { teamId },
          ...(id ? [{ _id: normalizeDetailId(id) }] : []),
          userFilter
        ]
      }
    };
  }

  function assertCanManageCategories(context, permissionKey) {
    assertTeamContext(context);
    assertPermission(context, permissionKey);
    const scope = resolveModuleDataScope(context, DATA_SCOPE_MODULES.EQUIPMENT);
    if (
      scope.scope !== DATA_SCOPES.TEAM &&
      context.isSuperAdmin !== true &&
      context.membership?.role !== MEMBERSHIP_ROLES.PROJECT_ADMIN
    ) {
      throw registryError(
        403,
        'EQUIPMENT_CATEGORY_TEAM_SCOPE_REQUIRED',
        'Managing the shared equipment category dictionary requires team scope'
      );
    }
    return context;
  }

  async function resolveWritableOrgUnit({ context, requestedOrgUnitId, fallbackOrgUnitId, session }) {
    const scope = resolveModuleDataScope(context, DATA_SCOPE_MODULES.EQUIPMENT);
    let orgUnitId;
    if (scope.scope === DATA_SCOPES.ORG_UNIT) {
      orgUnitId = normalizeRelatedId(scope.orgUnitId);
      if (
        requestedOrgUnitId !== undefined &&
        requestedOrgUnitId !== null &&
        requestedOrgUnitId !== '' &&
        !sameId(requestedOrgUnitId, orgUnitId)
      ) {
        throw relatedInvalid();
      }
    } else {
      orgUnitId = normalizeRelatedId(
        requestedOrgUnitId === undefined ? fallbackOrgUnitId : requestedOrgUnitId
      );
    }
    const orgUnit = await execute(OrgUnitModel.findOne({
      _id: orgUnitId,
      teamId: context.activeTeamId,
      status: ORG_UNIT_STATUSES.ACTIVE
    }), session);
    if (!orgUnit) throw relatedInvalid();
    return orgUnit;
  }

  async function resolveCategory({ context, categoryId, session }) {
    const category = await execute(EquipmentCategoryModel.findOne({
      _id: normalizeRelatedId(categoryId),
      teamId: context.activeTeamId,
      status: EQUIPMENT_CATEGORY_STATUSES.ACTIVE
    }), session);
    if (!category) throw relatedInvalid();
    return category;
  }

  async function resolveCustodian({ context, custodianUserId, orgUnitId, session }) {
    const userId = normalizeRelatedId(custodianUserId, { optional: true });
    if (!userId) return null;
    const [user, membership] = await Promise.all([
      execute(UserModel.findOne({ _id: userId, status: 'active' }), session),
      execute(TeamMembershipModel.findOne({
        teamId: context.activeTeamId,
        userId,
        orgUnitId,
        status: MEMBERSHIP_STATUSES.ACTIVE
      }), session)
    ]);
    if (!user || !membership) throw relatedInvalid();
    return user;
  }

  async function assertCategoryParent({
    context,
    parentId,
    currentCategoryId = null,
    session
  }) {
    const normalizedParentId = normalizeRelatedId(parentId, { optional: true });
    if (!normalizedParentId) return null;
    if (currentCategoryId && sameId(normalizedParentId, currentCategoryId)) {
      throw relatedInvalid();
    }
    const parent = await execute(EquipmentCategoryModel.findOne({
      _id: normalizedParentId,
      teamId: context.activeTeamId,
      status: EQUIPMENT_CATEGORY_STATUSES.ACTIVE
    }), session);
    if (!parent) throw relatedInvalid();

    const visited = new Set();
    let cursor = parent;
    while (cursor?.parentId) {
      const cursorId = normalizeId(cursor._id);
      if (visited.has(cursorId) || (currentCategoryId && sameId(cursor.parentId, currentCategoryId))) {
        throw registryError(409, 'EQUIPMENT_CATEGORY_CYCLE', 'Category hierarchy cannot contain a cycle');
      }
      visited.add(cursorId);
      cursor = await execute(EquipmentCategoryModel.findOne({
        _id: cursor.parentId,
        teamId: context.activeTeamId
      }), session);
      if (!cursor) throw relatedInvalid();
    }
    return parent;
  }

  function categoryUserFilter(query = {}) {
    const filters = [];
    if (query.status) {
      if (!EQUIPMENT_CATEGORY_STATUS_VALUES.includes(query.status)) {
        throw registryError(400, 'EQUIPMENT_INPUT_INVALID', 'Invalid category status');
      }
      filters.push({ status: query.status });
    }
    if (query.parentId === 'root') filters.push({ parentId: null });
    else if (query.parentId) filters.push({ parentId: normalizeRelatedId(query.parentId) });
    if (query.keyword) {
      const keyword = requiredString(query.keyword, 'keyword', 100);
      filters.push({ name: { $regex: escapeRegex(keyword), $options: 'i' } });
    }
    return filters.length > 0 ? { $and: filters } : {};
  }

  function assetUserFilter(query = {}) {
    const filters = [];
    if (query.status) {
      if (!EQUIPMENT_STATUS_VALUES.includes(query.status)) {
        throw registryError(400, 'EQUIPMENT_INPUT_INVALID', 'Invalid equipment status');
      }
      filters.push({ status: query.status });
    }
    if (query.assetType) {
      filters.push({ assetType: requiredString(query.assetType, 'assetType', 100) });
    }
    if (query.orgUnitId) filters.push({ orgUnitId: normalizeRelatedId(query.orgUnitId) });
    if (query.categoryId) filters.push({ categoryId: normalizeRelatedId(query.categoryId) });
    if (query.custodianUserId) {
      filters.push({ custodianUserId: normalizeRelatedId(query.custodianUserId) });
    }
    if (query.keyword) {
      const keyword = requiredString(query.keyword, 'keyword', 100);
      const pattern = { $regex: escapeRegex(keyword), $options: 'i' };
      filters.push({ $or: [
        { assetCode: pattern },
        { sourceAssetCode: pattern },
        { sourceSequence: pattern },
        { assetType: pattern },
        { productCode: pattern },
        { plateNumber: pattern },
        { serialNumber: pattern },
        { brandSerialNumber: pattern },
        { name: pattern },
        { specification: pattern },
        { manufacturer: pattern },
        { brand: pattern },
        { location: pattern },
        { conditionText: pattern },
        { forkliftPosition: pattern },
        { custodianDisplayName: pattern },
        { orgUnitNameSnapshot: pattern },
        { environmentalRegistrationCode: pattern }
      ] });
    }
    return filters.length > 0 ? { $and: filters } : {};
  }

  async function listCategories({ authContext, requestedTeamId, method = 'GET', query = {} }) {
    const { page, pageSize, skip } = pagination(query);
    const { filter } = await buildCategoryReadFilter({
      authContext,
      requestedTeamId,
      userFilter: categoryUserFilter(query)
    });
    const [documents, total] = await Promise.all([
      EquipmentCategoryModel.find(filter)
        .sort({ sortOrder: 1, name: 1, _id: 1 })
        .skip(skip)
        .limit(pageSize)
        .lean(),
      EquipmentCategoryModel.countDocuments(filter)
    ]);
    return { categories: documents.map(serializeCategory), total, page, pageSize };
  }

  async function getCategory({ authContext, requestedTeamId, method = 'GET', categoryId }) {
    const { filter } = await buildCategoryReadFilter({
      authContext,
      requestedTeamId,
      id: categoryId
    });
    const category = await EquipmentCategoryModel.findOne(filter).lean();
    if (!category) throw notFound('Equipment category');
    return serializeCategory(category);
  }

  async function createCategory({ authContext, req, input = {} }) {
    const context = assertCanManageCategories(authContext, 'equipment.create');
    assertNoClientTeamId(input);
    try {
      return await runWithOptionalTransaction(async (session) => {
        const parent = await assertCategoryParent({
          context,
          parentId: input.parentId,
          session
        });
        const category = await createOne(EquipmentCategoryModel, {
          teamId: context.activeTeamId,
          name: requiredString(input.name, 'name', 100),
          parentId: parent?._id || null,
          sortOrder: integer(input.sortOrder, 'sortOrder'),
          status: EQUIPMENT_CATEGORY_STATUSES.ACTIVE,
          createdBy: context.userId,
          updatedBy: context.userId
        }, session);
        const after = serializeCategory(category);
        await auditService.record({
          req,
          authContext: context,
          action: AUDIT_ACTIONS.CREATE,
          resourceType: AUDIT_RESOURCE_TYPES.EQUIPMENT_CATEGORY,
          resourceId: category._id,
          after,
          targetTeamId: context.activeTeamId,
          session
        });
        return after;
      }, connection);
    } catch (error) {
      throw normalizePersistenceError(error);
    }
  }

  async function updateCategory({ authContext, req, categoryId, input = {} }) {
    const context = assertCanManageCategories(authContext, 'equipment.edit');
    assertNoClientTeamId(input);
    try {
      return await runWithOptionalTransaction(async (session) => {
        const filter = {
          _id: normalizeDetailId(categoryId),
          teamId: context.activeTeamId
        };
        const category = await execute(EquipmentCategoryModel.findOne(filter), session);
        if (!category) throw notFound('Equipment category');
        const before = serializeCategory(category);

        if (Object.prototype.hasOwnProperty.call(input, 'name')) {
          category.name = requiredString(input.name, 'name', 100);
        }
        if (Object.prototype.hasOwnProperty.call(input, 'sortOrder')) {
          category.sortOrder = integer(input.sortOrder, 'sortOrder');
        }
        if (Object.prototype.hasOwnProperty.call(input, 'parentId')) {
          const parent = await assertCategoryParent({
            context,
            parentId: input.parentId,
            currentCategoryId: category._id,
            session
          });
          category.parentId = parent?._id || null;
        }
        if (Object.prototype.hasOwnProperty.call(input, 'status')) {
          if (!EQUIPMENT_CATEGORY_STATUS_VALUES.includes(input.status)) {
            throw registryError(400, 'EQUIPMENT_INPUT_INVALID', 'Invalid category status');
          }
          if (input.status === EQUIPMENT_CATEGORY_STATUSES.DISABLED) {
            const [child, asset] = await Promise.all([
              execute(EquipmentCategoryModel.exists({
                teamId: context.activeTeamId,
                parentId: category._id,
                status: EQUIPMENT_CATEGORY_STATUSES.ACTIVE
              }), session),
              execute(EquipmentAssetModel.exists({
                teamId: context.activeTeamId,
                categoryId: category._id
              }), session)
            ]);
            if (child || asset) {
              throw registryError(
                409,
                'EQUIPMENT_CATEGORY_IN_USE',
                'Category cannot be disabled while active children or equipment reference it'
              );
            }
          } else if (category.parentId) {
            await assertCategoryParent({
              context,
              parentId: category.parentId,
              currentCategoryId: category._id,
              session
            });
          }
          category.status = input.status;
        }
        category.updatedBy = context.userId;
        await category.save({ session: session || undefined });
        const after = serializeCategory(category);
        await auditService.record({
          req,
          authContext: context,
          action: before.status !== after.status
            ? after.status === EQUIPMENT_CATEGORY_STATUSES.ACTIVE
              ? AUDIT_ACTIONS.ENABLE
              : AUDIT_ACTIONS.DISABLE
            : AUDIT_ACTIONS.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPES.EQUIPMENT_CATEGORY,
          resourceId: category._id,
          before,
          after,
          reason: optionalString(input.reason, 'reason', 2000, null),
          targetTeamId: context.activeTeamId,
          session
        });
        return after;
      }, connection);
    } catch (error) {
      throw normalizePersistenceError(error);
    }
  }

  async function disableCategory(input) {
    return updateCategory({
      ...input,
      input: { ...(input.input || {}), status: EQUIPMENT_CATEGORY_STATUSES.DISABLED }
    });
  }

  function assetPayload(input, existing = null) {
    const created = existing === null;
    if (created && input.status && input.status !== EQUIPMENT_STATUSES.IN_USE) {
      throw registryError(
        409,
        'EQUIPMENT_STATUS_APPROVAL_REQUIRED',
        'Equipment must be created in IN_USE status'
      );
    }
    if (
      !created &&
      Object.prototype.hasOwnProperty.call(input, 'status') &&
      input.status !== existing.status
    ) {
      throw registryError(
        409,
        'EQUIPMENT_STATUS_APPROVAL_REQUIRED',
        'Equipment status changes require the dedicated approval workflow'
      );
    }
    return {
      assetCode: created || Object.prototype.hasOwnProperty.call(input, 'assetCode')
        ? requiredString(input.assetCode, 'assetCode', 100)
        : existing?.assetCode,
      name: created || Object.prototype.hasOwnProperty.call(input, 'name')
        ? requiredString(input.name, 'name', 200)
        : existing?.name,
      specification: Object.prototype.hasOwnProperty.call(input, 'specification')
        ? optionalString(input.specification, 'specification', 500)
        : existing?.specification || '',
      manufacturer: Object.prototype.hasOwnProperty.call(input, 'manufacturer')
        ? optionalString(input.manufacturer, 'manufacturer', 200)
        : existing?.manufacturer || '',
      quantity: Object.prototype.hasOwnProperty.call(input, 'quantity')
        ? optionalNumber(input.quantity, 'quantity', { min: 0, fallback: 1 })
        : existing?.quantity ?? 1,
      unit: Object.prototype.hasOwnProperty.call(input, 'unit')
        ? optionalString(input.unit, 'unit', 50)
        : existing?.unit || '',
      acquisitionDate: Object.prototype.hasOwnProperty.call(input, 'acquisitionDate')
        ? optionalDate(input.acquisitionDate, 'acquisitionDate')
        : existing?.acquisitionDate || null,
      originalValue: Object.prototype.hasOwnProperty.call(input, 'originalValue')
        ? optionalNumber(input.originalValue, 'originalValue')
        : existing?.originalValue ?? null,
      location: Object.prototype.hasOwnProperty.call(input, 'location')
        ? optionalString(input.location, 'location', 500)
        : existing?.location || '',
      remark: Object.prototype.hasOwnProperty.call(input, 'remark')
        ? optionalString(input.remark, 'remark', 2000)
        : existing?.remark || '',
      status: created ? EQUIPMENT_STATUSES.IN_USE : existing.status
    };
  }

  async function listAssets({ authContext, requestedTeamId, method = 'GET', query = {} }) {
    const { page, pageSize, skip } = pagination(query);
    const { filter } = await buildReadFilter({
      authContext,
      requestedTeamId,
      method,
      userFilter: assetUserFilter(query)
    });
    const [documents, total] = await Promise.all([
      EquipmentAssetModel.find(filter)
        .sort({ assetCode: 1, _id: 1 })
        .skip(skip)
        .limit(pageSize)
        .lean(),
      EquipmentAssetModel.countDocuments(filter)
    ]);
    return { equipment: documents.map(serializeAsset), total, page, pageSize };
  }

  async function listOptions({
    authContext,
    requestedTeamId,
    method = 'GET'
  }) {
    assertPermission(authContext, 'equipment.view');
    const teamId = await resolveReadTeamId(authContext, requestedTeamId);
    const dataScope = resolveModuleDataScope(authContext, DATA_SCOPE_MODULES.EQUIPMENT);
    const orgUnitFilter = {
      teamId,
      status: ORG_UNIT_STATUSES.ACTIVE
    };
    if (dataScope.scope === DATA_SCOPES.ORG_UNIT) {
      orgUnitFilter._id = normalizeRelatedId(dataScope.orgUnitId);
    }

    const orgUnits = await OrgUnitModel.find(orgUnitFilter)
      .sort({ level: 1, sortOrder: 1, name: 1, _id: 1 })
      .lean();
    const orgUnitIds = orgUnits.map(({ _id }) => _id);
    const memberships = orgUnitIds.length === 0
      ? []
      : await TeamMembershipModel.find({
        teamId,
        orgUnitId: { $in: orgUnitIds },
        status: MEMBERSHIP_STATUSES.ACTIVE
      }).lean();
    const userIds = [...new Set(memberships.map(({ userId }) => String(userId)))];
    const users = userIds.length === 0
      ? []
      : await UserModel.find({
        _id: { $in: userIds },
        status: 'active'
      }).select('_id username name').lean();
    const usersById = new Map(users.map((user) => [String(user._id), user]));

    return {
      orgUnits: orgUnits.map((orgUnit) => ({
        _id: normalizeId(orgUnit._id),
        parentId: normalizeId(orgUnit.parentId),
        code: orgUnit.code,
        name: orgUnit.name,
        type: orgUnit.type,
        level: orgUnit.level,
        path: orgUnit.path
      })),
      custodians: memberships
        .map((membership) => {
          const user = usersById.get(String(membership.userId));
          if (!user) return null;
          return {
            _id: normalizeId(user._id),
            username: user.username,
            name: user.name,
            orgUnitId: normalizeId(membership.orgUnitId)
          };
        })
        .filter(Boolean)
        .sort((left, right) => (
          left.name.localeCompare(right.name, 'zh-CN') || left.username.localeCompare(right.username)
        ))
    };
  }

  async function getAsset({ authContext, requestedTeamId, method = 'GET', equipmentId }) {
    const { filter } = await buildReadFilter({
      authContext,
      requestedTeamId,
      method,
      id: equipmentId
    });
    const equipment = await EquipmentAssetModel.findOne(filter).lean();
    if (!equipment) throw notFound();
    return serializeAsset(equipment);
  }

  async function createAsset({ authContext, req, input = {} }) {
    const context = assertTeamContext(authContext);
    assertPermission(context, 'equipment.create');
    assertNoClientTeamId(input);
    try {
      return await runWithOptionalTransaction(async (session) => {
        const orgUnit = await resolveWritableOrgUnit({
          context,
          requestedOrgUnitId: input.orgUnitId,
          session
        });
        const category = await resolveCategory({
          context,
          categoryId: input.categoryId,
          session
        });
        const custodian = await resolveCustodian({
          context,
          custodianUserId: input.custodianUserId,
          orgUnitId: orgUnit._id,
          session
        });
        const equipment = await createOne(EquipmentAssetModel, {
          teamId: context.activeTeamId,
          orgUnitId: orgUnit._id,
          categoryId: category._id,
          custodianUserId: custodian?._id || null,
          ...assetPayload(input),
          createdBy: context.userId,
          updatedBy: context.userId
        }, session);
        const after = serializeAsset(equipment);
        await createOne(EquipmentChangeRecordModel, {
          teamId: context.activeTeamId,
          orgUnitId: orgUnit._id,
          equipmentId: equipment._id,
          changeType: EQUIPMENT_CHANGE_TYPES.CREATE,
          before: null,
          after,
          operatorId: context.userId,
          reason: optionalString(input.reason, 'reason', 2000, null)
        }, session);
        await auditService.record({
          req,
          authContext: context,
          action: AUDIT_ACTIONS.CREATE,
          resourceType: AUDIT_RESOURCE_TYPES.EQUIPMENT_ASSET,
          resourceId: equipment._id,
          after,
          reason: optionalString(input.reason, 'reason', 2000, null),
          targetTeamId: context.activeTeamId,
          session
        });
        return after;
      }, connection);
    } catch (error) {
      throw normalizePersistenceError(error);
    }
  }

  async function updateAsset({ authContext, req, equipmentId, input = {} }) {
    const context = assertTeamContext(authContext);
    assertPermission(context, 'equipment.edit');
    assertNoClientTeamId(input);
    try {
      return await runWithOptionalTransaction(async (session) => {
        const filter = buildScopedDetailFilter({
          authContext: context,
          moduleKey: DATA_SCOPE_MODULES.EQUIPMENT,
          id: normalizeDetailId(equipmentId),
          method: 'PATCH'
        });
        const equipment = await execute(EquipmentAssetModel.findOne(filter), session);
        if (!equipment) throw notFound();
        const before = serializeAsset(equipment);
        const orgUnit = await resolveWritableOrgUnit({
          context,
          requestedOrgUnitId: input.orgUnitId,
          fallbackOrgUnitId: equipment.orgUnitId,
          session
        });
        const category = await resolveCategory({
          context,
          categoryId: Object.prototype.hasOwnProperty.call(input, 'categoryId')
            ? input.categoryId
            : equipment.categoryId,
          session
        });
        const custodian = await resolveCustodian({
          context,
          custodianUserId: Object.prototype.hasOwnProperty.call(input, 'custodianUserId')
            ? input.custodianUserId
            : equipment.custodianUserId,
          orgUnitId: orgUnit._id,
          session
        });
        Object.assign(equipment, assetPayload(input, equipment), {
          orgUnitId: orgUnit._id,
          categoryId: category._id,
          custodianUserId: custodian?._id || null,
          updatedBy: context.userId
        });
        await equipment.save({ session: session || undefined });
        const after = serializeAsset(equipment);
        await createOne(EquipmentChangeRecordModel, {
          teamId: context.activeTeamId,
          orgUnitId: orgUnit._id,
          equipmentId: equipment._id,
          changeType: EQUIPMENT_CHANGE_TYPES.UPDATE,
          before,
          after,
          operatorId: context.userId,
          reason: optionalString(input.reason, 'reason', 2000, null)
        }, session);
        await auditService.record({
          req,
          authContext: context,
          action: AUDIT_ACTIONS.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPES.EQUIPMENT_ASSET,
          resourceId: equipment._id,
          before,
          after,
          reason: optionalString(input.reason, 'reason', 2000, null),
          targetTeamId: context.activeTeamId,
          session
        });
        return after;
      }, connection);
    } catch (error) {
      throw normalizePersistenceError(error);
    }
  }

  async function getHistory({
    authContext,
    requestedTeamId,
    method = 'GET',
    equipmentId,
    query = {}
  }) {
    const equipment = await getAsset({
      authContext,
      requestedTeamId,
      method,
      equipmentId
    });
    const { page, pageSize, skip } = pagination(query);
    const filter = {
      teamId: equipment.teamId,
      equipmentId: equipment._id
    };
    const [documents, total] = await Promise.all([
      EquipmentChangeRecordModel.find(filter)
        .sort({ occurredAt: -1, _id: -1 })
        .skip(skip)
        .limit(pageSize)
        .lean(),
      EquipmentChangeRecordModel.countDocuments(filter)
    ]);
    return {
      equipment,
      changes: documents.map(serializeChangeRecord),
      total,
      page,
      pageSize
    };
  }

  async function getQrPayload({ authContext, req, equipmentId }) {
    const context = assertTeamContext(authContext);
    assertPermission(context, 'equipment.qrcode');
    const filter = buildScopedDetailFilter({
      authContext: context,
      moduleKey: DATA_SCOPE_MODULES.EQUIPMENT,
      id: normalizeDetailId(equipmentId),
      method: 'POST'
    });
    const equipment = await EquipmentAssetModel.findOne(filter).select('+qrToken');
    if (!equipment) throw notFound();
    const payload = JSON.stringify({
      v: 1,
      type: 'EQUIPMENT_ASSET',
      token: equipment.qrToken
    });
    await auditService.record({
      req,
      authContext: context,
      action: AUDIT_ACTIONS.GENERATE,
      resourceType: AUDIT_RESOURCE_TYPES.EQUIPMENT_ASSET,
      resourceId: equipment._id,
      after: {
        qrPayloadVersion: 1,
        assetCode: equipment.assetCode
      },
      targetTeamId: context.activeTeamId
    });
    return {
      equipmentId: normalizeId(equipment._id),
      assetCode: equipment.assetCode,
      payload
    };
  }

  async function getAssetByQrToken({
    authContext,
    requestedTeamId,
    method = 'GET',
    qrToken
  }) {
    if (typeof qrToken !== 'string' || !QR_TOKEN_PATTERN.test(qrToken)) throw notFound();
    const { filter } = await buildReadFilter({
      authContext,
      requestedTeamId,
      method,
      userFilter: { qrToken }
    });
    const equipment = await EquipmentAssetModel.findOne(filter).lean();
    if (!equipment) throw notFound();
    return serializeAsset(equipment);
  }

  async function exportAssets({ authContext, req, requestedTeamId, method = 'GET', query = {} }) {
    assertPermission(authContext, 'equipment.export');
    const { teamId, filter } = await buildReadFilter({
      authContext,
      requestedTeamId,
      method,
      userFilter: assetUserFilter(query),
      permissionKey: 'equipment.export'
    });
    const documents = await EquipmentAssetModel.find(filter)
      .sort({ assetCode: 1, _id: 1 })
      .lean();
    const rows = documents.map((document) => {
      const item = serializeAsset(document);
      return {
        'Asset Code': formulaSafe(item.assetCode),
        'Source Asset Code': formulaSafe(item.sourceAssetCode),
        'Source Sequence': formulaSafe(item.sourceSequence),
        'Asset Type': formulaSafe(item.assetType),
        'Source Sheet': formulaSafe(item.sourceSheetName),
        'Source Row': item.sourceRowNumber ?? '',
        'Product Code': formulaSafe(item.productCode),
        'Plate Number': formulaSafe(item.plateNumber),
        'Serial Number': formulaSafe(item.serialNumber),
        'Brand Serial Number': formulaSafe(item.brandSerialNumber),
        Name: formulaSafe(item.name),
        Status: item.status,
        'Condition Text': formulaSafe(item.conditionText),
        Specification: formulaSafe(item.specification),
        Manufacturer: formulaSafe(item.manufacturer),
        Brand: formulaSafe(item.brand),
        'Vehicle Length': formulaSafe(item.vehicleLength),
        'Rated Capacity': formulaSafe(item.ratedCapacityText),
        Quantity: item.quantity,
        'Book Quantity': item.bookQuantity ?? '',
        'Physical Quantity': item.physicalQuantity ?? '',
        Unit: formulaSafe(item.unit),
        'Acquisition Date': item.acquisitionDate || '',
        'Production Date': item.productionDate || '',
        'Production Date Precision': item.productionDatePrecision || '',
        'Production Date Raw': formulaSafe(item.productionDateRaw),
        'Production Date Display': formulaSafe(item.productionDateDisplay),
        'Activation Date': item.activationDate || '',
        'Activation Date Precision': item.activationDatePrecision || '',
        'Activation Date Raw': formulaSafe(item.activationDateRaw),
        'Activation Date Display': formulaSafe(item.activationDateDisplay),
        'Idle Placed At': item.idlePlacedAt || '',
        'Idle Placed At Raw': formulaSafe(item.idlePlacedAtRaw),
        'Original Value': item.originalValue ?? '',
        Custodian: formulaSafe(item.custodianDisplayName),
        'Organization Unit': formulaSafe(item.orgUnitNameSnapshot),
        Location: formulaSafe(item.location),
        'Forklift Position': formulaSafe(item.forkliftPosition),
        'Environmental Registration Code': formulaSafe(item.environmentalRegistrationCode),
        Remark: formulaSafe(item.remark),
        'Organization Unit ID': item.orgUnitId,
        'Category ID': item.categoryId,
        'Custodian User ID': item.custodianUserId || ''
      };
    });
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(rows, { cellDates: true });
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Equipment');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    await auditService.record({
      req,
      authContext,
      action: AUDIT_ACTIONS.EXPORT,
      resourceType: AUDIT_RESOURCE_TYPES.EQUIPMENT_ASSET,
      after: { count: documents.length, filters: assetUserFilter(query) },
      targetTeamId: teamId
    });
    return { buffer, count: documents.length };
  }

  return Object.freeze({
    createAsset,
    createCategory,
    disableCategory,
    exportAssets,
    getAsset,
    getAssetByQrToken,
    getCategory,
    getHistory,
    getQrPayload,
    listAssets,
    listCategories,
    listOptions,
    updateAsset,
    updateCategory
  });
}

module.exports = {
  EquipmentRegistryError,
  createEquipmentRegistryService,
  formulaSafe,
  serializeAsset,
  serializeCategory,
  serializeChangeRecord
};
