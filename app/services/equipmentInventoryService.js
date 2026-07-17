'use strict';

const mongoose = require('mongoose');
const XLSX = require('xlsx');
const EquipmentAsset = require('../models/EquipmentAsset');
const FileAsset = require('../models/FileAsset');
const InventoryApproval = require('../models/InventoryApproval');
const InventoryItem = require('../models/InventoryItem');
const InventorySession = require('../models/InventorySession');
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
  ORG_UNIT_STATUSES,
  POSITION_KEYS,
  SESSION_MODES,
  TEAM_STATUSES
} = require('../config/permissions');
const { createAuditService } = require('./auditService');
const { normalizeId } = require('./authSessionService');
const { createFileAssetService } = require('./fileAssetService');
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
const {
  runWithOptionalTransaction,
  supportsTransactions
} = require('./transactionService');

const { FILE_OWNER_TYPES } = FileAsset;
const {
  INVENTORY_APPROVAL_DECISIONS,
  INVENTORY_APPROVAL_STAGES
} = InventoryApproval;
const {
  INVENTORY_DIFFERENCE_STATUSES,
  INVENTORY_DIFFERENCE_TYPES
} = InventoryItem;
const { INVENTORY_SESSION_STATUSES } = InventorySession;

const QR_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,86}$/;
const MAX_BATCH_ITEMS = 2000;
const MAX_ITEM_PHOTOS = 10;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 500;

class EquipmentInventoryError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'EquipmentInventoryError';
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}

function inventoryError(status, code, message) {
  return new EquipmentInventoryError(status, code, message);
}

function notFound(message = 'Inventory resource does not exist') {
  return inventoryError(404, 'EQUIPMENT_INVENTORY_NOT_FOUND', message);
}

function inputInvalid(message) {
  return inventoryError(400, 'EQUIPMENT_INVENTORY_INPUT_INVALID', message);
}

function conflict(message = 'Inventory state has changed') {
  return inventoryError(409, 'EQUIPMENT_INVENTORY_STATE_CONFLICT', message);
}

function plain(document) {
  return typeof document?.toObject === 'function'
    ? document.toObject({ depopulate: true, versionKey: false })
    : document;
}

function assertOnlyKeys(input, allowedKeys, field = 'input') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw inputInvalid(`${field} must be an object`);
  }
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) throw inputInvalid(`${field}.${unknown} is not supported`);
}

function assertNoClientTeamId(input) {
  if (Object.prototype.hasOwnProperty.call(input || {}, 'teamId')) {
    throw inventoryError(
      400,
      'EQUIPMENT_TEAM_ID_IMMUTABLE',
      'teamId is derived from the authenticated team and cannot be supplied by the client'
    );
  }
}

function requiredString(value, field, max) {
  if (typeof value !== 'string' || !value.trim()) throw inputInvalid(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max) throw inputInvalid(`${field} is too long`);
  return normalized;
}

function optionalString(value, field, max, fallback = '') {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') throw inputInvalid(`${field} must be a string`);
  const normalized = value.trim();
  if (normalized.length > max) throw inputInvalid(`${field} is too long`);
  return normalized || fallback;
}

function integer(value, field, { min = 0, max = 2147483647, fallback = null } = {}) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== null) return fallback;
    throw inputInvalid(`${field} is required`);
  }
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw inputInvalid(`${field} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function nullableQuantity(value, field, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw inputInvalid(`${field} is required`);
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw inputInvalid(`${field} must be a finite non-negative number`);
  }
  return value;
}

function pagination(query = {}) {
  return {
    page: integer(query.page, 'page', { min: 1, max: 1000000, fallback: 1 }),
    pageSize: integer(query.pageSize, 'pageSize', {
      min: 1,
      max: MAX_PAGE_SIZE,
      fallback: DEFAULT_PAGE_SIZE
    })
  };
}

function relatedId(value) {
  try {
    return normalizeObjectId(value, 'related resource id');
  } catch {
    throw notFound();
  }
}

function detailId(value) {
  try {
    return normalizeObjectId(value, 'id');
  } catch {
    throw notFound();
  }
}

function normalizeIdArray(value, field, { min = 0, max = MAX_BATCH_ITEMS } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw inputInvalid(`${field} must contain between ${min} and ${max} identifiers`);
  }
  const ids = value.map((item) => {
    try {
      return normalizeObjectId(item, field);
    } catch {
      throw inputInvalid(`${field} contains an invalid identifier`);
    }
  });
  if (new Set(ids).size !== ids.length) throw inputInvalid(`${field} must not contain duplicates`);
  return ids;
}

function serializeSession(document, authContext = null) {
  const value = plain(document);
  return {
    _id: normalizeId(value._id),
    teamId: normalizeId(value.teamId),
    orgUnitId: normalizeId(value.orgUnitId),
    orgUnitNameSnapshot: value.orgUnitNameSnapshot,
    name: value.name,
    description: value.description || '',
    inventoryPersonId: normalizeId(value.inventoryPersonId),
    status: value.status,
    approvalStep: value.approvalStep,
    reviewRound: value.reviewRound,
    correctionRevision: value.correctionRevision,
    returnedRevision: value.returnedRevision,
    itemCount: value.itemCount,
    checkedCount: value.checkedCount,
    differenceCount: value.differenceCount,
    createdBy: normalizeId(value.createdBy),
    submittedAt: value.submittedAt || null,
    completedAt: value.completedAt || null,
    returnedAt: value.returnedAt || null,
    lastTransitionAt: value.lastTransitionAt || null,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    version: document?.__v ?? value.__v ?? 0,
    canApprove: authContext ? canActorApprove(authContext, value) : false,
    canInventory: Boolean(
      authContext &&
      authContext.mode === SESSION_MODES.TEAM &&
      [
        INVENTORY_SESSION_STATUSES.DRAFT,
        INVENTORY_SESSION_STATUSES.RETURNED
      ].includes(value.status) &&
      sameId(authContext.userId, value.inventoryPersonId)
    )
  };
}

function serializeItem(document) {
  const value = plain(document);
  return {
    _id: normalizeId(value._id),
    teamId: normalizeId(value.teamId),
    orgUnitId: normalizeId(value.orgUnitId),
    inventorySessionId: normalizeId(value.inventorySessionId),
    equipmentId: normalizeId(value.equipmentId),
    assetCodeSnapshot: value.assetCodeSnapshot,
    equipmentNameSnapshot: value.equipmentNameSnapshot,
    specificationSnapshot: value.specificationSnapshot || '',
    bookStatus: value.bookStatus,
    bookQuantity: value.bookQuantity ?? null,
    bookLocation: value.bookLocation || '',
    actualPresent: value.actualPresent ?? null,
    actualStatus: value.actualStatus || null,
    actualQuantity: value.actualQuantity ?? null,
    actualLocation: value.actualLocation || '',
    differenceTypes: value.differenceTypes || [],
    differenceStatus: value.differenceStatus,
    differenceNote: value.differenceNote || '',
    photoFileIds: (value.photoFileIds || []).map(normalizeId),
    checkedBy: normalizeId(value.checkedBy),
    checkedAt: value.checkedAt || null,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    version: document?.__v ?? value.__v ?? 0
  };
}

function serializeApproval(document) {
  const value = plain(document);
  return {
    _id: normalizeId(value._id),
    inventorySessionId: normalizeId(value.inventorySessionId),
    stage: value.stage,
    reviewRound: value.reviewRound,
    sequence: value.sequence,
    decision: value.decision,
    actorUserId: normalizeId(value.actorUserId),
    actorPositionKey: value.actorPositionKey || null,
    comment: value.comment || '',
    statusBefore: value.statusBefore,
    statusAfter: value.statusAfter,
    createdAt: value.createdAt
  };
}

function requiredPositionForStatus(status) {
  if (status === INVENTORY_SESSION_STATUSES.PENDING_SUB_DEPARTMENT_MANAGER) {
    return INVENTORY_APPROVAL_STAGES.SUB_DEPARTMENT_MANAGER;
  }
  if (status === INVENTORY_SESSION_STATUSES.PENDING_DEPARTMENT_DEPUTY_OR_ASSISTANT) {
    return INVENTORY_APPROVAL_STAGES.DEPARTMENT_DEPUTY_OR_ASSISTANT;
  }
  if (status === INVENTORY_SESSION_STATUSES.PENDING_DEPARTMENT_MANAGER) {
    return INVENTORY_APPROVAL_STAGES.DEPARTMENT_MANAGER;
  }
  return null;
}

function canActorApprove(authContext, inventorySession) {
  if (!authContext || authContext.mode !== SESSION_MODES.TEAM || !authContext.membership) {
    return false;
  }
  const stage = requiredPositionForStatus(inventorySession.status);
  const positionKey = authContext.membership.positionKey;
  if (stage === INVENTORY_APPROVAL_STAGES.SUB_DEPARTMENT_MANAGER) {
    return positionKey === POSITION_KEYS.SUB_DEPARTMENT_MANAGER &&
      sameId(authContext.membership.orgUnitId, inventorySession.orgUnitId);
  }
  if (stage === INVENTORY_APPROVAL_STAGES.DEPARTMENT_DEPUTY_OR_ASSISTANT) {
    return [
      POSITION_KEYS.DEPARTMENT_DEPUTY_MANAGER,
      POSITION_KEYS.DEPARTMENT_MANAGER_ASSISTANT
    ].includes(positionKey);
  }
  if (stage === INVENTORY_APPROVAL_STAGES.DEPARTMENT_MANAGER) {
    return positionKey === POSITION_KEYS.DEPARTMENT_MANAGER;
  }
  return false;
}

function transitionForStatus(status) {
  if (status === INVENTORY_SESSION_STATUSES.PENDING_SUB_DEPARTMENT_MANAGER) {
    return {
      stage: INVENTORY_APPROVAL_STAGES.SUB_DEPARTMENT_MANAGER,
      sequence: 2,
      approvedStatus: INVENTORY_SESSION_STATUSES.PENDING_DEPARTMENT_DEPUTY_OR_ASSISTANT,
      approvalStep: 2
    };
  }
  if (status === INVENTORY_SESSION_STATUSES.PENDING_DEPARTMENT_DEPUTY_OR_ASSISTANT) {
    return {
      stage: INVENTORY_APPROVAL_STAGES.DEPARTMENT_DEPUTY_OR_ASSISTANT,
      sequence: 3,
      approvedStatus: INVENTORY_SESSION_STATUSES.PENDING_DEPARTMENT_MANAGER,
      approvalStep: 3
    };
  }
  if (status === INVENTORY_SESSION_STATUSES.PENDING_DEPARTMENT_MANAGER) {
    return {
      stage: INVENTORY_APPROVAL_STAGES.DEPARTMENT_MANAGER,
      sequence: 4,
      approvedStatus: INVENTORY_SESSION_STATUSES.COMPLETED,
      approvalStep: 4
    };
  }
  throw conflict('Inventory is not waiting for approval');
}

function computeDifferences(item, result) {
  const differenceTypes = [];
  if (!result.actualPresent) {
    differenceTypes.push(INVENTORY_DIFFERENCE_TYPES.MISSING);
    return differenceTypes;
  }
  if (result.actualStatus !== item.bookStatus) {
    differenceTypes.push(INVENTORY_DIFFERENCE_TYPES.STATUS_MISMATCH);
  }
  if (
    item.bookQuantity !== null &&
    item.bookQuantity !== undefined &&
    result.actualQuantity !== item.bookQuantity
  ) {
    differenceTypes.push(INVENTORY_DIFFERENCE_TYPES.QUANTITY_MISMATCH);
  }
  const bookLocation = String(item.bookLocation || '').trim();
  const actualLocation = String(result.actualLocation || '').trim();
  if (actualLocation && actualLocation !== bookLocation) {
    differenceTypes.push(INVENTORY_DIFFERENCE_TYPES.LOCATION_MISMATCH);
  }
  return differenceTypes;
}

function safeSpreadsheetValue(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

async function execute(query, session) {
  if (session && typeof query.session === 'function') query.session(session);
  return query;
}

async function createOne(Model, values, session) {
  if (!session) return Model.create(values);
  const created = await Model.create([values], { session });
  return created[0];
}

function normalizePersistenceError(error) {
  if (error instanceof EquipmentInventoryError) return error;
  if (error?.name === 'VersionError') return conflict();
  if (error?.code === 11000) return conflict('Inventory operation has already been recorded');
  if (['ValidationError', 'StrictModeError', 'CastError'].includes(error?.name)) {
    return inputInvalid(error.message);
  }
  return error;
}

function createEquipmentInventoryService({
  EquipmentAssetModel = EquipmentAsset,
  InventoryApprovalModel = InventoryApproval,
  InventoryItemModel = InventoryItem,
  InventorySessionModel = InventorySession,
  OrgUnitModel = OrgUnit,
  ProjectTeamModel = ProjectTeam,
  TeamMembershipModel = TeamMembership,
  UserModel = User,
  auditService = createAuditService(),
  fileAssetService = null,
  connection = mongoose.connection,
  clock = () => new Date()
} = {}) {
  const managedFileService = fileAssetService || createFileAssetService({
    InventoryItemModel,
    connection
  });

  function runInventoryTransaction(work) {
    if (!supportsTransactions(connection)) {
      throw inventoryError(
        503,
        'EQUIPMENT_INVENTORY_TRANSACTIONS_REQUIRED',
        'Equipment inventory writes require MongoDB replica-set transaction support'
      );
    }
    return runWithOptionalTransaction(work, connection);
  }

  async function resolveReadTeamId(authContext, requestedTeamId) {
    const context = assertBusinessContext(authContext);
    if (context.mode === SESSION_MODES.TEAM) {
      return normalizeObjectId(context.activeTeamId, 'activeTeamId');
    }
    if (context.mode !== SESSION_MODES.GLOBAL_READ_ONLY) {
      throw inventoryError(403, 'EQUIPMENT_TEAM_CONTEXT_REQUIRED', 'Select a team first');
    }
    let teamId;
    try {
      teamId = normalizeObjectId(requestedTeamId, 'teamId');
    } catch {
      throw inputInvalid('A valid teamId is required in global read-only mode');
    }
    const team = await ProjectTeamModel.exists({ _id: teamId, status: TEAM_STATUSES.ACTIVE });
    if (!team) throw notFound();
    return teamId;
  }

  function assertInventoryPermission(authContext) {
    const context = assertBusinessContext(authContext);
    assertPermission(context, 'equipment.inventory');
    return context;
  }

  async function loadScopedSession({
    authContext,
    inventorySessionId,
    requestedTeamId,
    method = 'GET',
    session = null
  }) {
    assertInventoryPermission(authContext);
    const teamId = authContext.mode === SESSION_MODES.TEAM
      ? normalizeObjectId(authContext.activeTeamId, 'activeTeamId')
      : await resolveReadTeamId(authContext, requestedTeamId);
    const filter = buildScopedDetailFilter({
      authContext,
      moduleKey: DATA_SCOPE_MODULES.EQUIPMENT,
      id: detailId(inventorySessionId),
      globalTeamId: teamId,
      method
    });
    const inventorySession = await execute(InventorySessionModel.findOne(filter), session);
    if (!inventorySession) throw notFound();
    return inventorySession;
  }

  async function resolveCreateOrg(context, orgUnitId, session) {
    const normalizedOrgUnitId = relatedId(orgUnitId);
    const scope = resolveModuleDataScope(context, DATA_SCOPE_MODULES.EQUIPMENT);
    if (scope.scope === DATA_SCOPES.ORG_UNIT && !sameId(scope.orgUnitId, normalizedOrgUnitId)) {
      throw notFound();
    }
    const orgUnit = await execute(OrgUnitModel.findOne({
      _id: normalizedOrgUnitId,
      teamId: context.activeTeamId,
      status: ORG_UNIT_STATUSES.ACTIVE
    }), session);
    if (!orgUnit) throw notFound();
    return orgUnit;
  }

  async function resolveInventoryPerson(context, inventoryPersonId, orgUnitId, session) {
    const userId = inventoryPersonId ? relatedId(inventoryPersonId) : context.userId;
    const membership = await execute(TeamMembershipModel.findOne({
      teamId: context.activeTeamId,
      userId,
      orgUnitId,
      status: MEMBERSHIP_STATUSES.ACTIVE,
      permissionKeys: 'equipment.inventory'
    }), session);
    if (!membership) throw notFound('Inventory person is unavailable in the selected organization');
    const user = await execute(UserModel.findOne({ _id: userId, status: 'active' }), session);
    if (!user) throw notFound('Inventory person is unavailable in the selected organization');
    return { membership, user };
  }

  async function listOptions({ authContext, requestedTeamId, method = 'GET' }) {
    const context = assertInventoryPermission(authContext);
    const teamId = context.mode === SESSION_MODES.TEAM
      ? context.activeTeamId
      : await resolveReadTeamId(context, requestedTeamId);
    const scope = resolveModuleDataScope(context, DATA_SCOPE_MODULES.EQUIPMENT);
    const orgFilter = { teamId, status: ORG_UNIT_STATUSES.ACTIVE };
    if (context.mode === SESSION_MODES.TEAM && scope.scope === DATA_SCOPES.ORG_UNIT) {
      orgFilter._id = scope.orgUnitId;
    }
    const orgUnits = await OrgUnitModel.find(orgFilter).sort({ level: 1, sortOrder: 1, name: 1 }).lean();
    const orgIds = orgUnits.map(({ _id }) => _id);
    const memberships = await TeamMembershipModel.find({
      teamId,
      orgUnitId: { $in: orgIds },
      status: MEMBERSHIP_STATUSES.ACTIVE,
      permissionKeys: 'equipment.inventory'
    }).select('userId orgUnitId positionKey').lean();
    const users = await UserModel.find({
      _id: { $in: memberships.map(({ userId }) => userId) },
      status: 'active'
    }).select('name username').lean();
    const usersById = new Map(users.map((user) => [String(user._id), user]));
    return {
      orgUnits: orgUnits.map((orgUnit) => ({
        _id: normalizeId(orgUnit._id),
        name: orgUnit.name,
        code: orgUnit.code,
        level: orgUnit.level
      })),
      inventoryPeople: memberships.map((membership) => ({
        _id: normalizeId(membership.userId),
        orgUnitId: normalizeId(membership.orgUnitId),
        positionKey: membership.positionKey,
        name: usersById.get(String(membership.userId))?.name || 'Unknown user',
        username: usersById.get(String(membership.userId))?.username || ''
      }))
    };
  }

  async function createSession({ authContext, req, input = {} }) {
    assertNoClientTeamId(input);
    assertOnlyKeys(input, [
      'name',
      'description',
      'orgUnitId',
      'inventoryPersonId',
      'equipmentIds'
    ]);
    const context = assertTeamContext(authContext);
    assertPermission(context, 'equipment.inventory');
    const name = requiredString(input.name, 'name', 200);
    const description = optionalString(input.description, 'description', 2000);
    const suppliedEquipmentIds = input.equipmentIds === undefined
      ? null
      : normalizeIdArray(input.equipmentIds, 'equipmentIds', { min: 1 });
    try {
      return await runInventoryTransaction(async (session) => {
        const orgUnit = await resolveCreateOrg(context, input.orgUnitId, session);
        const inventoryPerson = await resolveInventoryPerson(
          context,
          input.inventoryPersonId,
          orgUnit._id,
          session
        );
        const assetFilter = {
          teamId: context.activeTeamId,
          orgUnitId: orgUnit._id
        };
        if (suppliedEquipmentIds) assetFilter._id = { $in: suppliedEquipmentIds };
        const assets = await execute(
          EquipmentAssetModel.find(assetFilter).sort({ assetCode: 1, _id: 1 }),
          session
        );
        if (
          assets.length < 1 ||
          assets.length > MAX_BATCH_ITEMS ||
          (suppliedEquipmentIds && assets.length !== suppliedEquipmentIds.length)
        ) {
          throw notFound('One or more selected equipment assets are unavailable in this organization');
        }

        const inventorySessionId = new mongoose.Types.ObjectId();
        const inventorySession = await createOne(InventorySessionModel, {
          _id: inventorySessionId,
          teamId: context.activeTeamId,
          orgUnitId: orgUnit._id,
          orgUnitNameSnapshot: orgUnit.name,
          name,
          description,
          inventoryPersonId: inventoryPerson.user._id,
          itemCount: assets.length,
          createdBy: context.userId
        }, session);
        await InventoryItemModel.insertMany(assets.map((asset) => ({
          teamId: context.activeTeamId,
          orgUnitId: orgUnit._id,
          inventorySessionId,
          equipmentId: asset._id,
          assetCodeSnapshot: asset.assetCode,
          equipmentNameSnapshot: asset.name,
          specificationSnapshot: asset.specification || '',
          bookStatus: asset.status,
          bookQuantity: asset.bookQuantity ?? asset.quantity ?? null,
          bookLocation: asset.location || ''
        })), { ordered: true, session });

        const after = serializeSession(inventorySession, context);
        await auditService.record({
          req,
          authContext: context,
          action: AUDIT_ACTIONS.CREATE,
          resourceType: AUDIT_RESOURCE_TYPES.INVENTORY_SESSION,
          resourceId: inventorySession._id,
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

  async function listSessions({
    authContext,
    requestedTeamId,
    method = 'GET',
    query = {}
  }) {
    assertOnlyKeys(query, [
      'teamId', 'status', 'orgUnitId', 'inventoryPersonId', 'keyword',
      'pendingOnly', 'page', 'pageSize'
    ], 'query');
    const context = assertInventoryPermission(authContext);
    const teamId = context.mode === SESSION_MODES.TEAM
      ? context.activeTeamId
      : await resolveReadTeamId(context, requestedTeamId);
    const { page, pageSize } = pagination(query);
    const userFilter = {};
    if (query.status) {
      if (!InventorySessionModel.INVENTORY_SESSION_STATUS_VALUES.includes(query.status)) {
        throw inputInvalid('status is invalid');
      }
      userFilter.status = query.status;
    }
    if (query.orgUnitId) userFilter.orgUnitId = relatedId(query.orgUnitId);
    if (query.inventoryPersonId) userFilter.inventoryPersonId = relatedId(query.inventoryPersonId);
    if (query.keyword) {
      const keyword = optionalString(query.keyword, 'keyword', 100);
      if (keyword) userFilter.name = { $regex: keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    }
    if (query.pendingOnly === 'true' || query.pendingOnly === true) {
      const statusByPosition = {
        [POSITION_KEYS.SUB_DEPARTMENT_MANAGER]: INVENTORY_SESSION_STATUSES.PENDING_SUB_DEPARTMENT_MANAGER,
        [POSITION_KEYS.DEPARTMENT_DEPUTY_MANAGER]: INVENTORY_SESSION_STATUSES.PENDING_DEPARTMENT_DEPUTY_OR_ASSISTANT,
        [POSITION_KEYS.DEPARTMENT_MANAGER_ASSISTANT]: INVENTORY_SESSION_STATUSES.PENDING_DEPARTMENT_DEPUTY_OR_ASSISTANT,
        [POSITION_KEYS.DEPARTMENT_MANAGER]: INVENTORY_SESSION_STATUSES.PENDING_DEPARTMENT_MANAGER
      };
      const pendingStatus = statusByPosition[context.membership?.positionKey];
      if (!pendingStatus) return { inventorySessions: [], total: 0, page, pageSize };
      userFilter.status = pendingStatus;
      if (context.membership.positionKey === POSITION_KEYS.SUB_DEPARTMENT_MANAGER) {
        userFilter.orgUnitId = context.membership.orgUnitId;
      }
    }
    const filter = buildScopedFilter({
      authContext: context,
      moduleKey: DATA_SCOPE_MODULES.EQUIPMENT,
      globalTeamId: teamId,
      method,
      userFilter
    });
    const [documents, total] = await Promise.all([
      InventorySessionModel.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize),
      InventorySessionModel.countDocuments(filter)
    ]);
    return {
      inventorySessions: documents.map((document) => serializeSession(document, context)),
      total,
      page,
      pageSize
    };
  }

  async function getSession({
    authContext,
    requestedTeamId,
    method = 'GET',
    inventorySessionId,
    query = {}
  }) {
    assertOnlyKeys(query, ['teamId', 'page', 'pageSize'], 'query');
    const inventorySession = await loadScopedSession({
      authContext,
      requestedTeamId,
      method,
      inventorySessionId
    });
    const { page, pageSize } = pagination(query);
    const itemFilter = {
      teamId: inventorySession.teamId,
      inventorySessionId: inventorySession._id
    };
    const [items, total, approvals] = await Promise.all([
      InventoryItemModel.find(itemFilter)
        .sort({ assetCodeSnapshot: 1, _id: 1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize),
      InventoryItemModel.countDocuments(itemFilter),
      InventoryApprovalModel.find(itemFilter).sort({ reviewRound: 1, sequence: 1 }).lean()
    ]);
    return {
      inventorySession: serializeSession(inventorySession, authContext),
      items: items.map(serializeItem),
      approvals: approvals.map(serializeApproval),
      total,
      page,
      pageSize
    };
  }

  async function updateItem({
    authContext,
    req,
    inventorySessionId,
    inventoryItemId,
    input = {}
  }) {
    assertNoClientTeamId(input);
    assertOnlyKeys(input, [
      'actualPresent', 'actualStatus', 'actualQuantity', 'actualLocation',
      'differenceNote', 'photoFileIds', 'expectedVersion'
    ]);
    const context = assertTeamContext(authContext);
    assertPermission(context, 'equipment.inventory');
    if (typeof input.actualPresent !== 'boolean') {
      throw inputInvalid('actualPresent must be a boolean');
    }
    const expectedVersion = integer(input.expectedVersion, 'expectedVersion', { min: 0 });
    const photoFileIds = normalizeIdArray(input.photoFileIds || [], 'photoFileIds', {
      min: 0,
      max: MAX_ITEM_PHOTOS
    });
    try {
      return await runInventoryTransaction(async (session) => {
        const inventorySession = await loadScopedSession({
          authContext: context,
          inventorySessionId,
          method: 'PATCH',
          session
        });
        if (
          ![
            INVENTORY_SESSION_STATUSES.DRAFT,
            INVENTORY_SESSION_STATUSES.RETURNED
          ].includes(inventorySession.status) ||
          !sameId(inventorySession.inventoryPersonId, context.userId)
        ) {
          throw conflict('Only the assigned inventory person can edit an open or returned batch');
        }
        const item = await execute(InventoryItemModel.findOne({
          _id: detailId(inventoryItemId),
          teamId: context.activeTeamId,
          orgUnitId: inventorySession.orgUnitId,
          inventorySessionId: inventorySession._id
        }), session);
        if (!item) throw notFound();
        if (item.__v !== expectedVersion) throw conflict();

        const actualStatus = input.actualPresent
          ? input.actualStatus || item.bookStatus
          : null;
        if (
          input.actualPresent &&
          !EquipmentAssetModel.EQUIPMENT_STATUS_VALUES.includes(actualStatus)
        ) {
          throw inputInvalid('actualStatus is invalid');
        }
        const actualQuantity = input.actualPresent
          ? nullableQuantity(input.actualQuantity, 'actualQuantity', {
              required: item.bookQuantity !== null && item.bookQuantity !== undefined
            })
          : null;
        const actualLocation = input.actualPresent
          ? optionalString(input.actualLocation, 'actualLocation', 500, item.bookLocation || '')
          : '';
        const differenceNote = optionalString(input.differenceNote, 'differenceNote', 5000);
        const differenceTypes = computeDifferences(item, {
          actualPresent: input.actualPresent,
          actualStatus,
          actualQuantity,
          actualLocation
        });
        if (differenceTypes.length > 0 && (!differenceNote || photoFileIds.length < 1)) {
          throw inputInvalid('Inventory differences require a note and at least one photo');
        }

        const previous = serializeItem(item);
        await managedFileService.reconcileOwnerFiles({
          authContext: context,
          req,
          attachments: photoFileIds.map((fileId) => ({ fileId })),
          previousAttachments: item.photoFileIds.map((fileId) => ({ fileId })),
          ownerType: FILE_OWNER_TYPES.INVENTORY,
          ownerId: item._id,
          method: 'PATCH',
          allowedMimeTypes: ['image/jpeg', 'image/png'],
          session
        });
        item.actualPresent = input.actualPresent;
        item.actualStatus = actualStatus;
        item.actualQuantity = actualQuantity;
        item.actualLocation = actualLocation;
        item.differenceTypes = differenceTypes;
        item.differenceStatus = differenceTypes.length > 0
          ? INVENTORY_DIFFERENCE_STATUSES.PENDING_REVIEW
          : INVENTORY_DIFFERENCE_STATUSES.NONE;
        item.differenceNote = differenceNote;
        item.photoFileIds = photoFileIds;
        item.checkedBy = context.userId;
        item.checkedAt = clock();
        await item.save({ session });

        const [checkedCount, differenceCount] = await Promise.all([
          InventoryItemModel.countDocuments({
            teamId: context.activeTeamId,
            inventorySessionId: inventorySession._id,
            checkedAt: { $ne: null }
          }).session(session),
          InventoryItemModel.countDocuments({
            teamId: context.activeTeamId,
            inventorySessionId: inventorySession._id,
            differenceTypes: { $exists: true, $ne: [] }
          }).session(session)
        ]);
        await InventorySessionModel.updateOne({
          _id: inventorySession._id,
          teamId: context.activeTeamId,
          status: inventorySession.status
        }, {
          $set: { checkedCount, differenceCount },
          ...(inventorySession.status === INVENTORY_SESSION_STATUSES.RETURNED
            ? { $inc: { correctionRevision: 1 } }
            : {})
        }, { session });

        const after = serializeItem(item);
        await auditService.record({
          req,
          authContext: context,
          action: AUDIT_ACTIONS.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPES.INVENTORY_ITEM,
          resourceId: item._id,
          before: previous,
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

  async function scanItem({
    authContext,
    inventorySessionId,
    input = {}
  }) {
    assertNoClientTeamId(input);
    assertOnlyKeys(input, ['qrToken']);
    const context = assertTeamContext(authContext);
    assertPermission(context, 'equipment.inventory');
    if (typeof input.qrToken !== 'string' || !QR_TOKEN_PATTERN.test(input.qrToken)) {
      throw notFound('Scanned equipment is not part of this inventory batch');
    }
    const inventorySession = await loadScopedSession({
      authContext: context,
      inventorySessionId,
      method: 'POST'
    });
    if (
      inventorySession.status !== INVENTORY_SESSION_STATUSES.DRAFT ||
      !sameId(inventorySession.inventoryPersonId, context.userId)
    ) {
      throw conflict('This inventory batch is not open for scanning');
    }
    const asset = await EquipmentAssetModel.findOne({
      teamId: context.activeTeamId,
      orgUnitId: inventorySession.orgUnitId,
      qrToken: input.qrToken
    }).select('_id').lean();
    if (!asset) throw notFound('Scanned equipment is not part of this inventory batch');
    const item = await InventoryItemModel.findOne({
      teamId: context.activeTeamId,
      orgUnitId: inventorySession.orgUnitId,
      inventorySessionId: inventorySession._id,
      equipmentId: asset._id
    });
    if (!item) throw notFound('Scanned equipment is not part of this inventory batch');
    return {
      inventorySession: serializeSession(inventorySession, context),
      item: serializeItem(item)
    };
  }

  async function submitSession({ authContext, req, inventorySessionId, input = {} }) {
    assertNoClientTeamId(input);
    assertOnlyKeys(input, ['comment', 'expectedVersion']);
    const context = assertTeamContext(authContext);
    assertPermission(context, 'equipment.inventory');
    const expectedVersion = integer(input.expectedVersion, 'expectedVersion', { min: 0 });
    const comment = optionalString(input.comment, 'comment', 2000);
    try {
      return await runInventoryTransaction(async (session) => {
        const current = await loadScopedSession({
          authContext: context,
          inventorySessionId,
          method: 'POST',
          session
        });
        if (
          ![
            INVENTORY_SESSION_STATUSES.DRAFT,
            INVENTORY_SESSION_STATUSES.RETURNED
          ].includes(current.status) ||
          !sameId(current.inventoryPersonId, context.userId)
        ) {
          throw conflict('Only the assigned inventory person can submit an open or returned batch');
        }
        if (current.__v !== expectedVersion) throw conflict();
        if (
          current.status === INVENTORY_SESSION_STATUSES.RETURNED &&
          current.correctionRevision <= current.returnedRevision
        ) {
          throw inputInvalid('A returned inventory batch must be corrected before resubmission');
        }
        const checkedCount = await InventoryItemModel.countDocuments({
          teamId: context.activeTeamId,
          inventorySessionId: current._id,
          checkedAt: { $ne: null }
        }).session(session);
        if (checkedCount !== current.itemCount) {
          throw inputInvalid('Every inventory item must be checked before submission');
        }
        if (current.status === INVENTORY_SESSION_STATUSES.RETURNED) {
          const unresolvedReturnedItems = await InventoryItemModel.countDocuments({
            teamId: context.activeTeamId,
            inventorySessionId: current._id,
            differenceStatus: INVENTORY_DIFFERENCE_STATUSES.RETURNED
          }).session(session);
          if (unresolvedReturnedItems > 0) {
            throw inputInvalid('Every returned difference must be rechecked before resubmission');
          }
        }
        const now = clock();
        const nextReviewRound = current.status === INVENTORY_SESSION_STATUSES.RETURNED
          ? current.reviewRound + 1
          : current.reviewRound;
        const updated = await InventorySessionModel.findOneAndUpdate({
          _id: current._id,
          teamId: context.activeTeamId,
          status: current.status,
          __v: expectedVersion
        }, {
          $set: {
            status: INVENTORY_SESSION_STATUSES.PENDING_SUB_DEPARTMENT_MANAGER,
            approvalStep: 1,
            reviewRound: nextReviewRound,
            submittedAt: now,
            returnedAt: null,
            lastTransitionAt: now,
            checkedCount
          },
          $inc: { __v: 1 }
        }, { new: true, runValidators: true, session });
        if (!updated) throw conflict();
        const approval = await createOne(InventoryApprovalModel, {
          teamId: context.activeTeamId,
          orgUnitId: current.orgUnitId,
          inventorySessionId: current._id,
          stage: INVENTORY_APPROVAL_STAGES.INVENTORY_PERSON,
          reviewRound: nextReviewRound,
          sequence: 1,
          decision: INVENTORY_APPROVAL_DECISIONS.SUBMIT,
          actorUserId: context.userId,
          actorPositionKey: context.membership?.positionKey || null,
          comment,
          statusBefore: current.status,
          statusAfter: INVENTORY_SESSION_STATUSES.PENDING_SUB_DEPARTMENT_MANAGER
        }, session);
        await auditService.record({
          req,
          authContext: context,
          action: AUDIT_ACTIONS.SUBMIT,
          resourceType: AUDIT_RESOURCE_TYPES.INVENTORY_APPROVAL,
          resourceId: approval._id,
          before: serializeSession(current, context),
          after: serializeSession(updated, context),
          reason: comment || null,
          targetTeamId: context.activeTeamId,
          session
        });
        return serializeSession(updated, context);
      });
    } catch (error) {
      throw normalizePersistenceError(error);
    }
  }

  async function reviewSession({ authContext, req, inventorySessionId, input = {} }) {
    assertNoClientTeamId(input);
    assertOnlyKeys(input, ['decision', 'comment', 'expectedVersion']);
    const context = assertTeamContext(authContext);
    assertPermission(context, 'equipment.inventory');
    const expectedVersion = integer(input.expectedVersion, 'expectedVersion', { min: 0 });
    if (![
      INVENTORY_APPROVAL_DECISIONS.APPROVE,
      INVENTORY_APPROVAL_DECISIONS.RETURN
    ].includes(input.decision)) {
      throw inputInvalid('decision must be APPROVE or RETURN');
    }
    const comment = optionalString(input.comment, 'comment', 2000);
    if (input.decision === INVENTORY_APPROVAL_DECISIONS.RETURN && !comment) {
      throw inputInvalid('A return decision requires a comment');
    }
    try {
      return await runInventoryTransaction(async (session) => {
        const current = await loadScopedSession({
          authContext: context,
          inventorySessionId,
          method: 'POST',
          session
        });
        if (current.__v !== expectedVersion) throw conflict();
        const transition = transitionForStatus(current.status);
        if (!canActorApprove(context, current)) {
          throw inventoryError(
            403,
            'EQUIPMENT_INVENTORY_APPROVAL_FORBIDDEN',
            'The current fixed position cannot approve this inventory stage'
          );
        }
        const returned = input.decision === INVENTORY_APPROVAL_DECISIONS.RETURN;
        const nextStatus = returned
          ? INVENTORY_SESSION_STATUSES.RETURNED
          : transition.approvedStatus;
        const now = clock();
        const set = {
          status: nextStatus,
          approvalStep: returned ? 0 : transition.approvalStep,
          lastTransitionAt: now
        };
        if (returned) {
          set.returnedAt = now;
          set.returnedRevision = current.correctionRevision;
        }
        if (nextStatus === INVENTORY_SESSION_STATUSES.COMPLETED) set.completedAt = now;
        const updated = await InventorySessionModel.findOneAndUpdate({
          _id: current._id,
          teamId: context.activeTeamId,
          status: current.status,
          __v: expectedVersion
        }, {
          $set: set,
          $inc: { __v: 1 }
        }, { new: true, runValidators: true, session });
        if (!updated) throw conflict();
        if (returned || nextStatus === INVENTORY_SESSION_STATUSES.COMPLETED) {
          await InventoryItemModel.updateMany({
            teamId: context.activeTeamId,
            inventorySessionId: current._id,
            differenceStatus: INVENTORY_DIFFERENCE_STATUSES.PENDING_REVIEW
          }, {
            $set: {
              differenceStatus: returned
                ? INVENTORY_DIFFERENCE_STATUSES.RETURNED
                : INVENTORY_DIFFERENCE_STATUSES.CONFIRMED
            }
          }, { session });
        }
        const approval = await createOne(InventoryApprovalModel, {
          teamId: context.activeTeamId,
          orgUnitId: current.orgUnitId,
          inventorySessionId: current._id,
          stage: transition.stage,
          reviewRound: current.reviewRound,
          sequence: transition.sequence,
          decision: input.decision,
          actorUserId: context.userId,
          actorPositionKey: context.membership.positionKey,
          comment,
          statusBefore: current.status,
          statusAfter: nextStatus
        }, session);
        await auditService.record({
          req,
          authContext: context,
          action: returned ? AUDIT_ACTIONS.RETURN : AUDIT_ACTIONS.APPROVE,
          resourceType: AUDIT_RESOURCE_TYPES.INVENTORY_APPROVAL,
          resourceId: approval._id,
          before: serializeSession(current, context),
          after: serializeSession(updated, context),
          reason: comment || null,
          targetTeamId: context.activeTeamId,
          session
        });
        return serializeSession(updated, context);
      });
    } catch (error) {
      throw normalizePersistenceError(error);
    }
  }

  async function exportSession({
    authContext,
    req,
    requestedTeamId,
    method = 'GET',
    inventorySessionId
  }) {
    const inventorySession = await loadScopedSession({
      authContext,
      requestedTeamId,
      method,
      inventorySessionId
    });
    const items = await InventoryItemModel.find({
      teamId: inventorySession.teamId,
      inventorySessionId: inventorySession._id
    }).sort({ assetCodeSnapshot: 1, _id: 1 }).lean();
    const rows = items.map((item, index) => ({
      '序号': index + 1,
      '资产编码': safeSpreadsheetValue(item.assetCodeSnapshot),
      '设备名称': safeSpreadsheetValue(item.equipmentNameSnapshot),
      '规格型号': safeSpreadsheetValue(item.specificationSnapshot),
      '账面状态': item.bookStatus,
      '实盘存在': item.actualPresent === null ? '' : item.actualPresent ? '是' : '否',
      '实盘状态': item.actualStatus || '',
      '账面数量': item.bookQuantity ?? '',
      '实盘数量': item.actualQuantity ?? '',
      '账面位置': safeSpreadsheetValue(item.bookLocation),
      '实盘位置': safeSpreadsheetValue(item.actualLocation),
      '差异类型': (item.differenceTypes || []).join(','),
      '差异状态': item.differenceStatus,
      '差异说明': safeSpreadsheetValue(item.differenceNote),
      '证据照片数': (item.photoFileIds || []).length
    }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), '盘点明细');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    await auditService.record({
      req,
      authContext,
      action: AUDIT_ACTIONS.EXPORT,
      resourceType: AUDIT_RESOURCE_TYPES.INVENTORY_SESSION,
      resourceId: inventorySession._id,
      after: { exportedCount: rows.length },
      targetTeamId: inventorySession.teamId
    });
    return {
      buffer,
      count: rows.length,
      filename: `inventory-${normalizeId(inventorySession._id)}.xlsx`
    };
  }

  return Object.freeze({
    createSession,
    exportSession,
    getSession,
    listOptions,
    listSessions,
    reviewSession,
    scanItem,
    submitSession,
    updateItem
  });
}

module.exports = {
  EquipmentInventoryError,
  MAX_BATCH_ITEMS,
  MAX_ITEM_PHOTOS,
  QR_TOKEN_PATTERN,
  canActorApprove,
  computeDifferences,
  createEquipmentInventoryService,
  serializeApproval,
  serializeItem,
  serializeSession
};
