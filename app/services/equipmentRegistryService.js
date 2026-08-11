'use strict';

const mongoose = require('mongoose');
const XLSX = require('xlsx');
const EquipmentAsset = require('../models/EquipmentAsset');
const EquipmentCategory = require('../models/EquipmentCategory');
const EquipmentChangeRecord = require('../models/EquipmentChangeRecord');
const EquipmentRepairOrder = require('../models/EquipmentRepairOrder');
const EquipmentRoutineException = require('../models/EquipmentRoutineException');
const EquipmentRoutinePlan = require('../models/EquipmentRoutinePlan');
const EquipmentRoutineRecord = require('../models/EquipmentRoutineRecord');
const EquipmentRoutineRule = require('../models/EquipmentRoutineRule');
const EquipmentRuntimeReading = require('../models/EquipmentRuntimeReading');
const EquipmentStatusApplication = require('../models/EquipmentStatusApplication');
const EquipmentStatusApproval = require('../models/EquipmentStatusApproval');
const FileAsset = require('../models/FileAsset');
const InventoryItem = require('../models/InventoryItem');
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
const { createFileAssetService } = require('./fileAssetService');
const {
  buildScopedDetailFilter,
  buildScopedFilter,
  buildScopedOrgUnitIdConstraint,
  isOrgUnitInDataScope,
  normalizeObjectId
} = require('./scopedQueryService');
const {
  assertBusinessContext,
  assertPermission,
  assertTeamContext,
  resolveModuleDataScope,
  sameId
} = require('./teamContextService');
const {
  runWithOptionalTransaction,
  runWithRequiredTransaction
} = require('./transactionService');
const { lockActiveOrgUnitReference } = require('./orgUnitReferenceService');
const { orgUnitsShareSubDepartment } = require('./subDepartmentLeadershipService');

const { EQUIPMENT_STATUSES, EQUIPMENT_STATUS_VALUES } = EquipmentAsset;
const {
  EQUIPMENT_CATEGORY_STATUSES,
  EQUIPMENT_CATEGORY_STATUS_VALUES
} = EquipmentCategory;
const { EQUIPMENT_CHANGE_TYPES } = EquipmentChangeRecord;
const {
  EQUIPMENT_ROUTINE_PLAN_STATUSES,
  EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS
} = EquipmentRoutinePlan;
const { EQUIPMENT_ROUTINE_RULE_STATUSES } = EquipmentRoutineRule;
const OPEN_ROUTINE_PLAN_STATUSES = Object.freeze([
  EQUIPMENT_ROUTINE_PLAN_STATUSES.PLANNED,
  EQUIPMENT_ROUTINE_PLAN_STATUSES.IN_WINDOW,
  EQUIPMENT_ROUTINE_PLAN_STATUSES.OVERDUE
]);
const EQUIPMENT_REGISTRY_TRANSACTION_OPTIONS = Object.freeze({
  code: 'EQUIPMENT_REGISTRY_TRANSACTIONS_REQUIRED',
  message: 'Equipment category and asset snapshot writes require MongoDB replica-set transaction support'
});
const EQUIPMENT_CATEGORY_STRUCTURE_CONFLICT = Object.freeze({
  code: 'EQUIPMENT_CATEGORY_STRUCTURE_CONFLICT',
  message: 'Equipment category structure changed concurrently; retry the operation'
});

const QR_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,86}$/;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 200;
const MAX_EQUIPMENT_CATEGORY_DEPTH = 4;
const MAX_INTERACTIVE_EQUIPMENT_PHOTOS = 10;
const EQUIPMENT_PHOTO_MIME_TYPES = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif'
]);
const ASSET_TYPE_BY_MAJOR_CATEGORY = Object.freeze({
  运输装备: 'TRANSPORT_EQUIPMENT',
  装卸装备: 'HANDLING_EQUIPMENT',
  装卸搬运设备: 'HANDLING_EQUIPMENT',
  物流信息装备: 'LOGISTICS_INFORMATION_EQUIPMENT',
  辅助设施设备: 'AUXILIARY_FACILITY',
  辅助设施: 'AUXILIARY_FACILITY',
  闲置: 'IDLE'
});
const EQUIPMENT_STATUS_LABELS = Object.freeze({
  IN_USE: '在用',
  IDLE: '闲置',
  STOPPED: '停用',
  SCRAPPED: '报废'
});

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

function interactivePhotoFileIds(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw registryError(400, 'EQUIPMENT_INPUT_INVALID', 'photoFileIds must be an array');
  }
  const ids = value.map((item) => {
    try {
      return normalizeObjectId(item, 'photoFileIds');
    } catch {
      throw registryError(
        400,
        'EQUIPMENT_INPUT_INVALID',
        'photoFileIds must contain valid file ids'
      );
    }
  });
  if (
    ids.length > MAX_INTERACTIVE_EQUIPMENT_PHOTOS ||
    new Set(ids.map(String)).size !== ids.length
  ) {
    throw registryError(
      400,
      'EQUIPMENT_INPUT_INVALID',
      `photoFileIds must contain at most ${MAX_INTERACTIVE_EQUIPMENT_PHOTOS} unique files`
    );
  }
  return ids;
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
    name: value.name,
    categoryId: normalizeId(value.categoryId),
    specification: value.specification,
    manufacturer: value.manufacturer,
    brand: value.brand || '',
    vehicleLength: value.vehicleLength || '',
    ratedCapacityText: value.ratedCapacityText || '',
    powerType: value.powerType || '',
    emissionStandard: value.emissionStandard || '',
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
        : 'Equipment category name must be unique under the same parent'
    );
  }
  if (
    error?.code === 112 ||
    error?.codeName === 'WriteConflict' ||
    error?.hasErrorLabel?.('TransientTransactionError') ||
    error?.errorLabels?.includes?.('TransientTransactionError')
  ) {
    return registryError(
      409,
      EQUIPMENT_CATEGORY_STRUCTURE_CONFLICT.code,
      EQUIPMENT_CATEGORY_STRUCTURE_CONFLICT.message
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
  EquipmentRoutinePlanModel = EquipmentRoutinePlan,
  EquipmentRoutineRuleModel = EquipmentRoutineRule,
  equipmentDependencyModels = [
    EquipmentRepairOrder,
    EquipmentRoutineException,
    EquipmentRoutineRecord,
    EquipmentRuntimeReading,
    EquipmentStatusApplication,
    EquipmentStatusApproval,
    InventoryItem
  ],
  OrgUnitModel = OrgUnit,
  ProjectTeamModel = ProjectTeam,
  TeamMembershipModel = TeamMembership,
  UserModel = User,
  auditService = createAuditService(),
  fileAssetService = null,
  connection = mongoose.connection
} = {}) {
  const files = fileAssetService || createFileAssetService({ connection });
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
      throw registryError(
        409,
        'EQUIPMENT_TEAM_CONTEXT_STALE',
        'The active equipment team is no longer available'
      );
    }
    return team;
  }

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
      const requested = requestedOrgUnitId === undefined ||
        requestedOrgUnitId === null ||
        requestedOrgUnitId === ''
        ? fallbackOrgUnitId || scope.orgUnitId
        : requestedOrgUnitId;
      orgUnitId = normalizeRelatedId(requested);
      if (!isOrgUnitInDataScope(scope, orgUnitId)) throw relatedInvalid();
    } else {
      orgUnitId = normalizeRelatedId(
        requestedOrgUnitId === undefined ? fallbackOrgUnitId : requestedOrgUnitId
      );
    }
    const orgUnit = await lockActiveOrgUnitReference({
      OrgUnitModel,
      teamId: context.activeTeamId,
      orgUnitId,
      session
    });
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

  async function loadCategoryPath({ context, category, session }) {
    const path = [];
    const visited = new Set();
    let cursor = category;
    while (cursor) {
      const cursorId = normalizeId(cursor._id);
      if (!cursorId || visited.has(cursorId)) throw relatedInvalid();
      visited.add(cursorId);
      path.unshift(cursor);
      if (!cursor.parentId) break;
      cursor = await execute(EquipmentCategoryModel.findOne({
        _id: cursor.parentId,
        teamId: context.activeTeamId
      }), session);
      if (!cursor) throw relatedInvalid();
    }
    if (path.length > MAX_EQUIPMENT_CATEGORY_DEPTH) {
      throw registryError(
        409,
        'EQUIPMENT_CATEGORY_DEPTH_LIMIT',
        `Equipment categories support at most ${MAX_EQUIPMENT_CATEGORY_DEPTH} levels`
      );
    }
    return path;
  }

  async function categorySnapshots({ context, category, session }) {
    const path = await loadCategoryPath({ context, category, session });
    const names = path.map(({ name }) => name);
    return {
      majorCategoryName: names[0] || '',
      equipmentTypeName: names[1] || '',
      primaryName: names[2] || '',
      secondaryName: names[3] || ''
    };
  }

  async function routinePrimaryCategoryId({ context, category, session }) {
    const path = await loadCategoryPath({ context, category, session });
    return normalizeId(path[2]?._id);
  }

  async function refreshAssetCategorySnapshots({ context, assets, session }) {
    const assetIdsByCategoryId = new Map();
    for (const asset of assets) {
      const assetCategoryId = normalizeId(asset.categoryId);
      if (!assetCategoryId) throw relatedInvalid();
      const assetIds = assetIdsByCategoryId.get(assetCategoryId) || [];
      assetIds.push(asset._id);
      assetIdsByCategoryId.set(assetCategoryId, assetIds);
    }

    for (const [assetCategoryId, assetIds] of assetIdsByCategoryId) {
      const assetCategory = await execute(EquipmentCategoryModel.findOne({
        _id: assetCategoryId,
        teamId: context.activeTeamId
      }), session);
      if (!assetCategory) throw relatedInvalid();
      const snapshots = await categorySnapshots({
        context,
        category: assetCategory,
        session
      });
      await execute(EquipmentAssetModel.updateMany({
        _id: { $in: assetIds },
        teamId: context.activeTeamId,
        categoryId: assetCategoryId
      }, {
        $set: snapshots
      }), session);
    }
  }

  async function resolveCustodian({ context, custodianUserId, orgUnitId, session }) {
    const userId = normalizeRelatedId(custodianUserId, { optional: true });
    if (!userId) return null;
    const [user, membership] = await Promise.all([
      execute(UserModel.findOne({ _id: userId, status: 'active' }), session),
      execute(TeamMembershipModel.findOne({
        teamId: context.activeTeamId,
        userId,
        status: MEMBERSHIP_STATUSES.ACTIVE
      }), session)
    ]);
    if (
      !user ||
      !membership ||
      !(await orgUnitsShareSubDepartment({
        OrgUnitModel,
        teamId: context.activeTeamId,
        leftOrgUnitId: orgUnitId,
        rightOrgUnitId: membership.orgUnitId,
        requireActiveOrgUnits: true,
        session
      }))
    ) {
      throw relatedInvalid();
    }
    return user;
  }

  async function assertCategoryParent({
    context,
    parentId,
    currentCategoryId = null,
    session
  }) {
    const normalizedParentId = normalizeRelatedId(parentId, { optional: true });
    if (!normalizedParentId) return { parent: null, parentDepth: 0 };
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
    let parentDepth = 1;
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
      parentDepth += 1;
    }
    if (parentDepth >= MAX_EQUIPMENT_CATEGORY_DEPTH) {
      throw registryError(
        409,
        'EQUIPMENT_CATEGORY_DEPTH_LIMIT',
        `Equipment categories support at most ${MAX_EQUIPMENT_CATEGORY_DEPTH} levels`
      );
    }
    return { parent, parentDepth };
  }

  async function loadCategorySubtree({ context, categoryId, session }) {
    const categories = await execute(EquipmentCategoryModel.find({
      teamId: context.activeTeamId
    }).select('_id parentId').lean(), session);
    const childrenByParent = new Map();
    for (const item of categories) {
      const parentId = normalizeId(item.parentId);
      if (!parentId) continue;
      const children = childrenByParent.get(parentId) || [];
      children.push(normalizeId(item._id));
      childrenByParent.set(parentId, children);
    }
    let maximumDepth = 1;
    const queue = [{ id: normalizeId(categoryId), depth: 1 }];
    const visited = new Set();
    const depthByCategoryId = new Map();
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current.id || visited.has(current.id)) {
        throw registryError(409, 'EQUIPMENT_CATEGORY_CYCLE', 'Category hierarchy cannot contain a cycle');
      }
      visited.add(current.id);
      depthByCategoryId.set(current.id, current.depth);
      maximumDepth = Math.max(maximumDepth, current.depth);
      for (const childId of childrenByParent.get(current.id) || []) {
        queue.push({ id: childId, depth: current.depth + 1 });
      }
    }
    return {
      categoryIds: [...visited],
      depthByCategoryId,
      height: maximumDepth
    };
  }

  async function categorySubtreeHeight({ context, categoryId, session }) {
    return (await loadCategorySubtree({ context, categoryId, session })).height;
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
        { majorCategoryName: pattern },
        { equipmentTypeName: pattern },
        { primaryName: pattern },
        { secondaryName: pattern },
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
        { powerType: pattern },
        { emissionStandard: pattern },
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
      return await runRegistryWriteTransaction(async (session) => {
        await lockEquipmentCategoryStructure(context, session);
        const { parent } = await assertCategoryParent({
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
      });
    } catch (error) {
      throw normalizePersistenceError(error);
    }
  }

  async function updateCategory({ authContext, req, categoryId, input = {} }) {
    const context = assertCanManageCategories(authContext, 'equipment.edit');
    assertNoClientTeamId(input);
    try {
      return await runRegistryWriteTransaction(async (session) => {
        await lockEquipmentCategoryStructure(context, session);
        const filter = {
          _id: normalizeDetailId(categoryId),
          teamId: context.activeTeamId
        };
        const category = await execute(EquipmentCategoryModel.findOne(filter), session);
        if (!category) throw notFound('Equipment category');
        const before = serializeCategory(category);
        let changedSubtreeAssets = null;
        let categoryParentChanged = false;
        const previousPrimaryByCategoryId = new Map();

        if (Object.prototype.hasOwnProperty.call(input, 'name')) {
          category.name = requiredString(input.name, 'name', 100);
        }
        if (Object.prototype.hasOwnProperty.call(input, 'sortOrder')) {
          category.sortOrder = integer(input.sortOrder, 'sortOrder');
        }
        if (Object.prototype.hasOwnProperty.call(input, 'parentId')) {
          const { parent, parentDepth } = await assertCategoryParent({
            context,
            parentId: input.parentId,
            currentCategoryId: category._id,
            session
          });
          const subtree = await loadCategorySubtree({
            context,
            categoryId: category._id,
            session
          });
          if (parentDepth + subtree.height > MAX_EQUIPMENT_CATEGORY_DEPTH) {
            throw registryError(
              409,
              'EQUIPMENT_CATEGORY_DEPTH_LIMIT',
              `Equipment categories support at most ${MAX_EQUIPMENT_CATEGORY_DEPTH} levels`
            );
          }
          const previousParentId = normalizeId(category.parentId) || null;
          const nextParentId = normalizeId(parent?._id) || null;
          if (previousParentId !== nextParentId) {
            categoryParentChanged = true;
            const activeRules = await execute(EquipmentRoutineRuleModel.find({
              teamId: context.activeTeamId,
              categoryId: { $in: subtree.categoryIds },
              status: EQUIPMENT_ROUTINE_RULE_STATUSES.ACTIVE
            }).select('categoryId').lean(), session);
            const invalidRule = activeRules.find(({ categoryId: ruleCategoryId }) => (
              parentDepth + (subtree.depthByCategoryId.get(normalizeId(ruleCategoryId)) || 0) !== 3
            ));
            if (invalidRule) {
              throw registryError(
                409,
                'EQUIPMENT_CATEGORY_ACTIVE_RULE_DEPTH_CONFLICT',
                'Category move would place an active routine rule outside level 3'
              );
            }
            changedSubtreeAssets = await execute(EquipmentAssetModel.find({
              teamId: context.activeTeamId,
              categoryId: { $in: subtree.categoryIds }
            }).select('_id categoryId').lean(), session);
            const assetCategoryIds = [...new Set(
              changedSubtreeAssets
                .map(({ categoryId: assetCategoryId }) => normalizeId(assetCategoryId))
            )].filter(Boolean);
            for (const assetCategoryId of assetCategoryIds) {
              const assetCategory = sameId(assetCategoryId, category._id)
                ? category
                : await execute(EquipmentCategoryModel.findOne({
                    _id: assetCategoryId,
                    teamId: context.activeTeamId
                  }), session);
              previousPrimaryByCategoryId.set(
                assetCategoryId,
                assetCategory
                  ? await routinePrimaryCategoryId({ context, category: assetCategory, session })
                  : null
              );
            }
          }
          category.parentId = parent?._id || null;
        }
        if (Object.prototype.hasOwnProperty.call(input, 'status')) {
          if (!EQUIPMENT_CATEGORY_STATUS_VALUES.includes(input.status)) {
            throw registryError(400, 'EQUIPMENT_INPUT_INVALID', 'Invalid category status');
          }
          if (input.status === EQUIPMENT_CATEGORY_STATUSES.DISABLED) {
            const [child, asset, activeRule] = await Promise.all([
              execute(EquipmentCategoryModel.exists({
                teamId: context.activeTeamId,
                parentId: category._id,
                status: EQUIPMENT_CATEGORY_STATUSES.ACTIVE
              }), session),
              execute(EquipmentAssetModel.exists({
                teamId: context.activeTeamId,
                categoryId: category._id
              }), session),
              execute(EquipmentRoutineRuleModel.exists({
                teamId: context.activeTeamId,
                categoryId: category._id,
                status: EQUIPMENT_ROUTINE_RULE_STATUSES.ACTIVE
              }), session)
            ]);
            if (child || asset || activeRule) {
              throw registryError(
                409,
                'EQUIPMENT_CATEGORY_IN_USE',
                'Category cannot be disabled while active children, equipment, or active routine rules reference it'
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
        const categoryNameChanged = before.name !== category.name;
        if (categoryNameChanged && changedSubtreeAssets === null) {
          const subtree = await loadCategorySubtree({
            context,
            categoryId: category._id,
            session
          });
          changedSubtreeAssets = await execute(EquipmentAssetModel.find({
            teamId: context.activeTeamId,
            categoryId: { $in: subtree.categoryIds }
          }).select('_id categoryId').lean(), session);
        }
        category.updatedBy = context.userId;
        await category.save({ session: session || undefined });
        if (categoryParentChanged && changedSubtreeAssets.length > 0) {
          const nextPrimaryByCategoryId = new Map();
          for (const assetCategoryId of previousPrimaryByCategoryId.keys()) {
            const assetCategory = await execute(EquipmentCategoryModel.findOne({
              _id: assetCategoryId,
              teamId: context.activeTeamId
            }), session);
            nextPrimaryByCategoryId.set(
              assetCategoryId,
              assetCategory
                ? await routinePrimaryCategoryId({ context, category: assetCategory, session })
                : null
            );
          }
          const affectedAssetIds = changedSubtreeAssets
            .filter(({ categoryId: assetCategoryId }) => {
              const normalizedCategoryId = normalizeId(assetCategoryId);
              const previousPrimaryId = previousPrimaryByCategoryId.get(normalizedCategoryId) || null;
              const nextPrimaryId = nextPrimaryByCategoryId.get(normalizedCategoryId) || null;
              return (
                !previousPrimaryId ||
                !nextPrimaryId ||
                previousPrimaryId !== nextPrimaryId
              );
            })
            .map(({ _id }) => _id);
          if (affectedAssetIds.length > 0) {
            await execute(EquipmentRoutinePlanModel.updateMany({
              teamId: context.activeTeamId,
              equipmentId: { $in: affectedAssetIds },
              status: { $in: OPEN_ROUTINE_PLAN_STATUSES }
            }, {
              $set: {
                status: EQUIPMENT_ROUTINE_PLAN_STATUSES.CANCELLED,
                cancellationReason:
                  EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS.EQUIPMENT_CATEGORY_CHANGED,
                cancelledAt: new Date(),
                cancelledBy: context.userId
              }
            }), session);
          }
        }
        if (changedSubtreeAssets?.length > 0) {
          await refreshAssetCategorySnapshots({
            context,
            assets: changedSubtreeAssets,
            session
          });
        }
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
      });
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

  async function deleteCategory({ authContext, req, categoryId, input = {} }) {
    const context = assertCanManageCategories(authContext, 'equipment.edit');
    assertNoClientTeamId(input);
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw registryError(400, 'EQUIPMENT_CATEGORY_DELETE_INPUT_INVALID', 'input must be an object');
    }
    const unsupportedKey = Object.keys(input).find((key) => key !== 'reason');
    if (unsupportedKey) {
      throw registryError(
        400,
        'EQUIPMENT_CATEGORY_DELETE_INPUT_INVALID',
        `input.${unsupportedKey} is not supported`
      );
    }
    const reason = optionalString(input.reason, 'reason', 2000, 'Deleted from equipment categories');

    try {
      return await runRegistryWriteTransaction(async (session) => {
        await lockEquipmentCategoryStructure(context, session);
        const filter = {
          _id: normalizeDetailId(categoryId),
          teamId: context.activeTeamId
        };
        const category = await execute(EquipmentCategoryModel.findOne(filter), session);
        if (!category) throw notFound('Equipment category');
        if (category.status !== EQUIPMENT_CATEGORY_STATUSES.DISABLED) {
          throw registryError(
            409,
            'EQUIPMENT_CATEGORY_DELETE_REQUIRES_DISABLED',
            'Equipment category must be disabled before deletion'
          );
        }

        const dependencyFilter = {
          teamId: context.activeTeamId,
          categoryId: category._id
        };
        const [child, asset, rule] = await Promise.all([
          execute(EquipmentCategoryModel.exists({
            teamId: context.activeTeamId,
            parentId: category._id
          }), session),
          execute(EquipmentAssetModel.exists(dependencyFilter), session),
          execute(EquipmentRoutineRuleModel.exists(dependencyFilter), session)
        ]);
        if (child) {
          throw registryError(
            409,
            'EQUIPMENT_CATEGORY_DELETE_HAS_CHILDREN',
            'Equipment category cannot be deleted while child categories exist'
          );
        }
        if (asset) {
          throw registryError(
            409,
            'EQUIPMENT_CATEGORY_DELETE_HAS_EQUIPMENT',
            'Equipment category cannot be deleted while equipment references it'
          );
        }
        if (rule) {
          throw registryError(
            409,
            'EQUIPMENT_CATEGORY_DELETE_HAS_RULES',
            'Equipment category cannot be deleted while routine rules reference it'
          );
        }

        const before = serializeCategory(category);
        const deleted = await execute(EquipmentCategoryModel.deleteOne(filter), session);
        if (deleted.deletedCount !== 1) throw notFound('Equipment category');
        await auditService.record({
          req,
          authContext: context,
          action: AUDIT_ACTIONS.DELETE,
          resourceType: AUDIT_RESOURCE_TYPES.EQUIPMENT_CATEGORY,
          resourceId: category._id,
          before,
          after: { deleted: true },
          reason,
          targetTeamId: context.activeTeamId,
          session
        });
        return before;
      });
    } catch (error) {
      throw normalizePersistenceError(error);
    }
  }

  function assetPayload(input, existing = null) {
    const created = existing === null;
    const supplied = (field) => Object.prototype.hasOwnProperty.call(input, field);
    const stringValue = (field, max) => supplied(field)
      ? optionalString(input[field], field, max)
      : existing?.[field] || '';
    const numberValue = (field, fallback = null) => supplied(field)
      ? optionalNumber(input[field], field, { min: 0, fallback })
      : existing?.[field] ?? fallback;
    const dateValue = (field) => supplied(field)
      ? optionalDate(input[field], field)
      : existing?.[field] || null;
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
    const productionDate = dateValue('productionDate');
    const activationDate = dateValue('activationDate');
    return {
      assetCode: created || supplied('assetCode')
        ? requiredString(input.assetCode, 'assetCode', 100)
        : existing?.assetCode,
      name: created || supplied('name')
        ? requiredString(input.name, 'name', 200)
        : existing?.name,
      sourceSequence: stringValue('sourceSequence', 100),
      assetType: stringValue('assetType', 100),
      productCode: stringValue('productCode', 500),
      plateNumber: stringValue('plateNumber', 100),
      specification: stringValue('specification', 500),
      manufacturer: stringValue('manufacturer', 200),
      brand: stringValue('brand', 200),
      vehicleLength: stringValue('vehicleLength', 100),
      ratedCapacityText: stringValue('ratedCapacityText', 100),
      powerType: stringValue('powerType', 100),
      emissionStandard: stringValue('emissionStandard', 100),
      quantity: numberValue('quantity', 1),
      bookQuantity: numberValue('bookQuantity'),
      physicalQuantity: numberValue('physicalQuantity'),
      unit: stringValue('unit', 50),
      acquisitionDate: dateValue('acquisitionDate'),
      productionDate,
      productionDatePrecision: supplied('productionDate')
        ? productionDate ? EquipmentAsset.DATE_PRECISIONS.DAY : null
        : existing?.productionDatePrecision || null,
      productionDateRaw: supplied('productionDate') ? '' : existing?.productionDateRaw || '',
      productionDateDisplay: supplied('productionDate')
        ? ''
        : existing?.productionDateDisplay || '',
      activationDate,
      activationDatePrecision: supplied('activationDate')
        ? activationDate ? EquipmentAsset.DATE_PRECISIONS.DAY : null
        : existing?.activationDatePrecision || null,
      activationDateRaw: supplied('activationDate') ? '' : existing?.activationDateRaw || '',
      activationDateDisplay: supplied('activationDate')
        ? ''
        : existing?.activationDateDisplay || '',
      originalValue: numberValue('originalValue'),
      location: stringValue('location', 500),
      conditionText: stringValue('conditionText', 200),
      forkliftPosition: stringValue('forkliftPosition', 100),
      environmentalRegistrationCode: stringValue('environmentalRegistrationCode', 200),
      remark: stringValue('remark', 2000),
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
      orgUnitFilter._id = buildScopedOrgUnitIdConstraint(dataScope);
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
    const requestedPhotoFileIds = interactivePhotoFileIds(input.photoFileIds);
    try {
      return await runRegistryWriteTransaction(async (session) => {
        await lockEquipmentCategoryStructure(context, session);
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
        const snapshots = await categorySnapshots({ context, category, session });
        const normalizedPayload = assetPayload(input);
        if (!normalizedPayload.assetType && snapshots.majorCategoryName) {
          normalizedPayload.assetType = ASSET_TYPE_BY_MAJOR_CATEGORY[snapshots.majorCategoryName] ||
            snapshots.majorCategoryName;
        }
        const equipment = await createOne(EquipmentAssetModel, {
          teamId: context.activeTeamId,
          orgUnitId: orgUnit._id,
          categoryId: category._id,
          custodianUserId: custodian?._id || null,
          custodianDisplayName: custodian?.name || '',
          orgUnitNameSnapshot: orgUnit.name || '',
          ...snapshots,
          ...normalizedPayload,
          photoFileIds: [],
          createdBy: context.userId,
          updatedBy: context.userId
        }, session);
        if (requestedPhotoFileIds !== undefined) {
          const bound = await files.reconcileOwnerFiles({
            authContext: context,
            req,
            attachments: requestedPhotoFileIds.map((fileId) => ({ fileId })),
            previousAttachments: [],
            ownerType: FileAsset.FILE_OWNER_TYPES.EQUIPMENT,
            ownerId: equipment._id,
            method: 'POST',
            allowedMimeTypes: EQUIPMENT_PHOTO_MIME_TYPES,
            session
          });
          equipment.photoFileIds = bound.map(({ fileId }) => fileId);
          await equipment.save({ session: session || undefined });
        }
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
      });
    } catch (error) {
      throw normalizePersistenceError(error);
    }
  }

  async function updateAsset({ authContext, req, equipmentId, input = {} }) {
    const context = assertTeamContext(authContext);
    assertPermission(context, 'equipment.edit');
    assertNoClientTeamId(input);
    const requestedPhotoFileIds = interactivePhotoFileIds(input.photoFileIds);
    try {
      return await runRegistryWriteTransaction(async (session) => {
        await lockEquipmentCategoryStructure(context, session);
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
        const orgUnitChanged = !sameId(equipment.orgUnitId, orgUnit._id);
        const categoryChanged = !sameId(equipment.categoryId, category._id);
        let routineScopeChanged = false;
        if (categoryChanged) {
          const previousCategory = await execute(EquipmentCategoryModel.findOne({
            _id: equipment.categoryId,
            teamId: context.activeTeamId
          }), session);
          const previousPrimaryCategoryId = previousCategory
            ? await routinePrimaryCategoryId({ context, category: previousCategory, session })
            : null;
          const nextPrimaryCategoryId = await routinePrimaryCategoryId({
            context,
            category,
            session
          });
          routineScopeChanged = (
            !previousPrimaryCategoryId ||
            !nextPrimaryCategoryId ||
            previousPrimaryCategoryId !== nextPrimaryCategoryId
          );
        }
        const custodian = await resolveCustodian({
          context,
          custodianUserId: Object.prototype.hasOwnProperty.call(input, 'custodianUserId')
            ? input.custodianUserId
            : equipment.custodianUserId,
          orgUnitId: orgUnit._id,
          session
        });
        const snapshots = await categorySnapshots({ context, category, session });
        const normalizedPayload = assetPayload(input, equipment);
        if (!sameId(equipment.categoryId, category._id)) {
          normalizedPayload.assetType = ASSET_TYPE_BY_MAJOR_CATEGORY[snapshots.majorCategoryName] ||
            snapshots.majorCategoryName || normalizedPayload.assetType;
        }
        let nextPhotoFileIds = equipment.photoFileIds || [];
        if (requestedPhotoFileIds !== undefined) {
          const bound = await files.reconcileOwnerFiles({
            authContext: context,
            req,
            attachments: requestedPhotoFileIds.map((fileId) => ({ fileId })),
            previousAttachments: (equipment.photoFileIds || []).map((fileId) => ({ fileId })),
            ownerType: FileAsset.FILE_OWNER_TYPES.EQUIPMENT,
            ownerId: equipment._id,
            method: 'PATCH',
            allowedMimeTypes: EQUIPMENT_PHOTO_MIME_TYPES,
            session
          });
          nextPhotoFileIds = bound.map(({ fileId }) => fileId);
        }
        Object.assign(equipment, normalizedPayload, {
          orgUnitId: orgUnit._id,
          categoryId: category._id,
          custodianUserId: custodian?._id || null,
          custodianDisplayName: custodian?.name || '',
          orgUnitNameSnapshot: orgUnit.name || '',
          ...snapshots,
          photoFileIds: nextPhotoFileIds,
          updatedBy: context.userId
        });
        await equipment.save({ session: session || undefined });
        if (orgUnitChanged) {
          await EquipmentRoutinePlanModel.collection.updateMany({
            teamId: equipment.teamId,
            equipmentId: equipment._id,
            status: { $in: OPEN_ROUTINE_PLAN_STATUSES }
          }, {
            $set: { orgUnitId: orgUnit._id }
          }, { session });
        }
        if (routineScopeChanged) {
          await execute(EquipmentRoutinePlanModel.updateMany({
            teamId: context.activeTeamId,
            equipmentId: equipment._id,
            status: { $in: OPEN_ROUTINE_PLAN_STATUSES }
          }, {
            $set: {
              status: EQUIPMENT_ROUTINE_PLAN_STATUSES.CANCELLED,
              cancellationReason:
                EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS.EQUIPMENT_CATEGORY_CHANGED,
              cancelledAt: new Date(),
              cancelledBy: context.userId
            }
          }), session);
        }
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
      });
    } catch (error) {
      throw normalizePersistenceError(error);
    }
  }

  async function deleteAsset({ authContext, req, equipmentId, input = {} }) {
    const context = assertTeamContext(authContext);
    assertPermission(context, 'equipment.edit');
    assertNoClientTeamId(input);
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw registryError(400, 'EQUIPMENT_DELETE_INPUT_INVALID', 'input must be an object');
    }
    const unsupportedKey = Object.keys(input).find((key) => key !== 'reason');
    if (unsupportedKey) {
      throw registryError(
        400,
        'EQUIPMENT_DELETE_INPUT_INVALID',
        `input.${unsupportedKey} is not supported`
      );
    }
    const reason = optionalString(input.reason, 'reason', 2000, 'Deleted from equipment ledger');

    return runWithOptionalTransaction(async (session) => {
      const filter = buildScopedDetailFilter({
        authContext: context,
        moduleKey: DATA_SCOPE_MODULES.EQUIPMENT,
        id: normalizeDetailId(equipmentId),
        method: 'DELETE'
      });
      const equipment = await execute(EquipmentAssetModel.findOne(filter), session);
      if (!equipment) throw notFound();

      const dependencyFilter = {
        teamId: context.activeTeamId,
        equipmentId: equipment._id
      };
      const dependencies = await Promise.all(
        equipmentDependencyModels.map((Model) => execute(Model.exists(dependencyFilter), session))
      );
      if (dependencies.some(Boolean)) {
        throw registryError(
          409,
          'EQUIPMENT_DELETE_HAS_HISTORY',
          'Equipment with inspection, maintenance, repair, inventory, runtime, or status history cannot be deleted'
        );
      }

      const before = serializeAsset(equipment);
      if ((equipment.photoFileIds || []).length > 0) {
        await files.reconcileOwnerFiles({
          authContext: context,
          req,
          attachments: [],
          previousAttachments: equipment.photoFileIds.map((fileId) => ({ fileId })),
          ownerType: FileAsset.FILE_OWNER_TYPES.EQUIPMENT,
          ownerId: equipment._id,
          method: 'DELETE',
          allowedMimeTypes: EQUIPMENT_PHOTO_MIME_TYPES,
          session
        });
      }
      await execute(EquipmentRoutinePlanModel.deleteMany(dependencyFilter), session);
      const deleted = await execute(EquipmentAssetModel.deleteOne({
        _id: equipment._id,
        teamId: context.activeTeamId
      }), session);
      if (deleted.deletedCount !== 1) throw notFound();

      await createOne(EquipmentChangeRecordModel, {
        teamId: context.activeTeamId,
        orgUnitId: equipment.orgUnitId,
        equipmentId: equipment._id,
        changeType: EQUIPMENT_CHANGE_TYPES.DELETE,
        before,
        after: { deleted: true },
        operatorId: context.userId,
        reason
      }, session);
      await auditService.record({
        req,
        authContext: context,
        action: AUDIT_ACTIONS.DELETE,
        resourceType: AUDIT_RESOURCE_TYPES.EQUIPMENT_ASSET,
        resourceId: equipment._id,
        before,
        after: { deleted: true },
        reason,
        targetTeamId: context.activeTeamId,
        session
      });
      return before;
    }, connection);
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
    const rows = documents.map((document, index) => {
      const item = serializeAsset(document);
      return {
        序号: item.sourceSequence || index + 1,
        设备所属大类: formulaSafe(item.majorCategoryName),
        设备所属类型: formulaSafe(item.equipmentTypeName),
        设备一级名称: formulaSafe(item.primaryName),
        设备二级名称: formulaSafe(item.secondaryName || item.name),
        固定资产编号: formulaSafe(item.assetCode),
        车牌号: formulaSafe(item.plateNumber),
        环保编号: formulaSafe(item.environmentalRegistrationCode),
        '产品/品牌编码': formulaSafe(item.productCode),
        型号规格: formulaSafe(item.specification),
        单位: formulaSafe(item.unit),
        出厂日期: item.productionDateDisplay || item.productionDate || '',
        启用日期: item.activationDateDisplay || item.activationDate || '',
        车长: formulaSafe(item.vehicleLength),
        吨位: formulaSafe(item.ratedCapacityText),
        '高位/低位': formulaSafe(item.forkliftPosition),
        '设备动力类型：锂电/铅酸/柴油': formulaSafe(item.powerType),
        排放标准: formulaSafe(item.emissionStandard),
        品牌: formulaSafe(item.brand),
        生产厂家: formulaSafe(item.manufacturer),
        账存数量: item.bookQuantity ?? item.quantity,
        实盘数量: item.physicalQuantity ?? item.quantity,
        所在部室: formulaSafe(item.orgUnitNameSnapshot),
        使用人: formulaSafe(item.custodianDisplayName),
        状态: formulaSafe(item.conditionText || EQUIPMENT_STATUS_LABELS[item.status] || item.status),
        存放地点: formulaSafe(item.location),
        '设备照片（支持上传1-10张照片）': item.photoFileIds.length
          ? `${item.photoFileIds.length}张`
          : '',
        备注: formulaSafe(item.remark)
      };
    });
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(rows, { cellDates: true });
    XLSX.utils.book_append_sheet(workbook, worksheet, '设备台账');
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
    deleteCategory,
    disableCategory,
    deleteAsset,
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
