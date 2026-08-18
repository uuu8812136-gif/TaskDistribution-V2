'use strict';

const mongoose = require('mongoose');
const XLSX = require('xlsx');
const EquipmentAsset = require('../models/EquipmentAsset');
const EquipmentRepairOrder = require('../models/EquipmentRepairOrder');
const Message = require('../models/Message');
const OrgUnit = require('../models/OrgUnit');
const ProjectTeam = require('../models/ProjectTeam');
const TeamMembership = require('../models/TeamMembership');
const User = require('../models/User');
const {
  AUDIT_ACTIONS,
  AUDIT_RESOURCE_TYPES,
  DATA_SCOPE_MODULES,
  FUNCTIONAL_ROLE_KEYS,
  MEMBERSHIP_STATUSES,
  POSITION_KEYS,
  SESSION_MODES,
  TEAM_STATUSES
} = require('../config/permissions');
const { FILE_OWNER_TYPES } = require('../models/FileAsset');
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
  hasEffectivePermission,
  assertPermission,
  assertTeamContext,
  sameId
} = require('./teamContextService');
const { runWithOptionalTransaction, supportsTransactions } = require('./transactionService');
const {
  leadershipOrgUnitIds,
  lockSubDepartmentLeadership,
  PRIMARY_SUB_DEPARTMENT_LEADER_POSITION_KEYS,
  subDepartmentOrgUnitIds
} = require('./subDepartmentLeadershipService');

const {
  EQUIPMENT_REPAIR_ACTIONS,
  EQUIPMENT_REPAIR_ACTION_VALUES,
  EQUIPMENT_REPAIR_STATUSES,
  EQUIPMENT_REPAIR_STATUS_VALUES,
  EQUIPMENT_REPAIR_TYPES,
  EQUIPMENT_REPAIR_TYPE_VALUES
} = EquipmentRepairOrder;

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 200;
const IMAGE_MIME_TYPES = Object.freeze(['image/jpeg', 'image/png']);
const SUB_DEPARTMENT_POSITION_KEYS = new Set([
  POSITION_KEYS.SUB_DEPARTMENT_MANAGER,
  POSITION_KEYS.SUB_DEPARTMENT_DEPUTY_MANAGER,
  POSITION_KEYS.SUPERVISOR
]);
const DEPUTY_POSITION_KEYS = new Set([
  POSITION_KEYS.DEPARTMENT_DEPUTY_MANAGER,
  POSITION_KEYS.DEPARTMENT_MANAGER_ASSISTANT
]);
const REPAIR_STATUS_MESSAGE_LABELS = Object.freeze({
  [EQUIPMENT_REPAIR_STATUSES.SUB_DEPARTMENT_REVIEW_PENDING]: '待分部负责人审核',
  [EQUIPMENT_REPAIR_STATUSES.SUB_DEPARTMENT_ACCEPTANCE_PENDING]: '待分部负责人验收',
  [EQUIPMENT_REPAIR_STATUSES.ASSET_ADMIN_RECEIPT_PENDING]: '待设备管理员接单',
  [EQUIPMENT_REPAIR_STATUSES.ASSET_ADMIN_PRICING_PENDING]: '待设备管理员确认配件价格',
  [EQUIPMENT_REPAIR_STATUSES.DEPUTY_APPROVAL_PENDING]: '待副经理/经理助理审批',
  [EQUIPMENT_REPAIR_STATUSES.MANAGER_APPROVAL_PENDING]: '待部门经理终审',
  [EQUIPMENT_REPAIR_STATUSES.RETURNED_TO_CREATOR]: '已退回创建人',
  [EQUIPMENT_REPAIR_STATUSES.COMPLETED]: '已完成',
  [EQUIPMENT_REPAIR_STATUSES.VOIDED]: '已作废'
});
const REPAIR_TODO_STATES = Object.freeze({
  ACTIVE: 'ACTIVE',
  TRANSFERRED: 'TRANSFERRED',
  INVALIDATED: 'INVALIDATED'
});
const TERMINAL_REPAIR_STATUSES = new Set([
  EQUIPMENT_REPAIR_STATUSES.COMPLETED,
  EQUIPMENT_REPAIR_STATUSES.VOIDED
]);

class EquipmentRepairError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'EquipmentRepairError';
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}

function repairError(status, code, message) {
  return new EquipmentRepairError(status, code, message);
}

function notFound() {
  return repairError(404, 'EQUIPMENT_REPAIR_NOT_FOUND', 'Repair order does not exist');
}

function inputError(message) {
  return repairError(400, 'EQUIPMENT_REPAIR_INPUT_INVALID', message);
}

function normalizeDetailId(value) {
  try {
    return normalizeObjectId(value, 'id');
  } catch {
    throw notFound();
  }
}

function normalizeRelatedId(value, field) {
  try {
    return normalizeObjectId(value, field);
  } catch {
    throw inputError(`${field} must be a valid ObjectId`);
  }
}

function requiredString(value, field, maxLength) {
  if (typeof value !== 'string' || !value.trim()) throw inputError(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw inputError(`${field} is too long`);
  return normalized;
}

function optionalString(value, field, maxLength, fallback = '') {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') throw inputError(`${field} must be a string`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw inputError(`${field} is too long`);
  return normalized;
}

// Older mini-program builds serialized an omitted keyword as the literal string
// "undefined". Treat that compatibility value as an empty filter so those builds
// can still load the user's todo list while the fixed client rolls out.
function normalizeRepairQueryKeyword(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw inputError('keyword must be a string');
  const normalized = value.trim();
  if (!normalized || normalized.toLowerCase() === 'undefined') return null;
  if (normalized.length > 100) throw inputError('keyword is too long');
  return normalized;
}

function normalizeRepairLocations(values) {
  if (!Array.isArray(values) || values.length > 100) {
    throw inputError('locations must contain at most 100 entries');
  }
  const locations = values.map((value, index) => (
    requiredString(value, `locations[${index}]`, 500)
  ));
  if (new Set(locations).size !== locations.length) {
    throw inputError('locations must not contain duplicates');
  }
  return locations;
}

function requiredDate(value, field) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!value || Number.isNaN(date.getTime())) throw inputError(`${field} must be a valid date`);
  return date;
}

function integer(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback } = {}) {
  if ((value === undefined || value === null || value === '') && fallback !== undefined) return fallback;
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw inputError(`${field} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function positiveNumber(value, field) {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed <= 0 || parsed > 1000000000) {
    throw inputError(`${field} must be a positive number`);
  }
  return parsed;
}

function moneyToCents(value, field) {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed < 0) {
    throw inputError(`${field} must be a non-negative amount`);
  }
  const cents = Math.round((parsed + Number.EPSILON) * 100);
  if (!Number.isSafeInteger(cents)) throw inputError(`${field} is too large`);
  return cents;
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

function formulaSafe(value) {
  return typeof value === 'string' && /^[=+\-@]/.test(value) ? `'${value}` : value;
}

function plain(document) {
  return typeof document?.toObject === 'function'
    ? document.toObject({ depopulate: true, versionKey: false })
    : document;
}

function serializeAttachment(item) {
  return {
    fileId: normalizeId(item.fileId),
    originalName: item.originalName || '',
    mimeType: item.mimeType || '',
    size: item.size ?? null,
    uploadTime: item.uploadTime || null
  };
}

function serializePartItem(item) {
  return {
    itemKey: item.itemKey,
    name: item.name,
    specification: item.specification || '',
    remark: item.remark || '',
    quantity: item.quantity ?? null,
    unitPrice: item.unitPriceCents === null || item.unitPriceCents === undefined
      ? null
      : item.unitPriceCents / 100,
    amount: item.amountCents === null || item.amountCents === undefined
      ? null
      : item.amountCents / 100
  };
}

function serializeActionLog(item, actorNames = new Map()) {
  const actorId = normalizeId(item.actorId);
  return {
    _id: normalizeId(item._id),
    action: item.action,
    fromStatus: item.fromStatus || null,
    toStatus: item.toStatus,
    actorId,
    actorName: actorNames.get(actorId) || '',
    actorPositionKey: item.actorPositionKey || '',
    note: item.note || '',
    corrections: item.corrections || null,
    actedAt: item.actedAt
  };
}

const summaryDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
});

function summaryDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return summaryDateFormatter.format(date).replaceAll('/', '-');
}

function repairSummaryText(value) {
  if (value.status !== EQUIPMENT_REPAIR_STATUSES.COMPLETED) return '';
  const snapshot = value.equipmentSnapshot || {};
  const lines = [
    `报修部门：${snapshot.departmentName || '-'}`,
    `报修分部：${snapshot.orgUnitName || '-'}`,
    `设备编码：${snapshot.assetCode || '-'}`,
    `设备名称：${snapshot.name || '-'}`,
    `存放地点：${snapshot.location || '-'}`,
    `车牌号：${value.plateNumber || snapshot.plateNumber || '-'}`
  ];
  if (value.type === EQUIPMENT_REPAIR_TYPES.FAULT_REPORT) {
    lines.push(
      `报修时间：${summaryDate(value.reportTime)}`,
      `报修地点：${value.reportLocation || '-'}`,
      `联系人：${value.contactName || '-'}`,
      `联系电话：${value.contactPhone || '-'}`,
      `故障描述：${value.faultDescription || '-'}`
    );
  } else {
    lines.push(
      `维修日期：${value.repairDate ? summaryDate(value.repairDate).slice(0, 10) : '-'}`,
      `维修人：${value.repairerName || '-'}`,
      `维修说明：${value.repairDescription || '-'}`
    );
    if (value.type === EQUIPMENT_REPAIR_TYPES.PARTS_REPAIR) {
      lines.push(`维修金额：${((value.totalAmountCents || 0) / 100).toFixed(2)}元`);
    }
  }
  return lines.join('\n');
}

function serializeRepair(document, availableActions = [], actorNames = new Map()) {
  const value = plain(document);
  return {
    _id: normalizeId(value._id),
    teamId: normalizeId(value.teamId),
    orgUnitId: normalizeId(value.orgUnitId),
    equipmentId: normalizeId(value.equipmentId),
    categoryId: normalizeId(value.categoryId),
    type: value.type,
    status: value.status,
    equipmentSnapshot: value.equipmentSnapshot || {},
    createdBy: normalizeId(value.createdBy),
    reportTime: value.reportTime || null,
    reportLocation: value.reportLocation || '',
    plateNumber: value.plateNumber || '',
    contactName: value.contactName || '',
    contactPhone: value.contactPhone || '',
    faultDescription: value.faultDescription || '',
    repairDate: value.repairDate || null,
    repairerName: value.repairerName || '',
    repairDescription: value.repairDescription || '',
    partItems: (value.partItems || []).map(serializePartItem),
    totalAmount: (value.totalAmountCents || 0) / 100,
    photoAttachments: (value.photoAttachments || []).map(serializeAttachment),
    returnedFromStatus: value.returnedFromStatus || null,
    lastActionBy: normalizeId(value.lastActionBy),
    lastActionAt: value.lastActionAt,
    actionLogs: (value.actionLogs || []).map((item) => serializeActionLog(item, actorNames)),
    summaryText: repairSummaryText(value),
    revision: value.revision,
    availableActions,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  };
}

function assertNoClientScope(input) {
  for (const field of ['teamId', 'orgUnitId', 'categoryId', 'createdBy', 'status', 'revision']) {
    if (Object.prototype.hasOwnProperty.call(input || {}, field)) {
      throw inputError(`${field} is controlled by the server`);
    }
  }
}

function normalizeAttachmentInput(attachments, { required = false } = {}) {
  if (!Array.isArray(attachments) || attachments.length > 5 || (required && attachments.length < 1)) {
    throw inputError(required
      ? 'photoAttachments must contain between 1 and 5 photos'
      : 'photoAttachments must contain at most 5 photos');
  }
  const normalized = attachments.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw inputError('Each photo attachment must contain a fileId');
    }
    return { fileId: normalizeRelatedId(item.fileId, 'photoAttachments.fileId') };
  });
  if (new Set(normalized.map((item) => item.fileId)).size !== normalized.length) {
    throw inputError('photoAttachments must not contain duplicate fileIds');
  }
  return normalized;
}

function normalizePartDrafts(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 100) {
    throw inputError('partItems must contain between 1 and 100 rows');
  }
  const keys = new Set();
  return items.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw inputError(`partItems[${index}] must be an object`);
    }
    const itemKey = optionalString(item.itemKey, `partItems[${index}].itemKey`, 64) || `part-${index + 1}`;
    if (keys.has(itemKey)) throw inputError('partItems itemKey values must be unique');
    keys.add(itemKey);
    return {
      itemKey,
      name: requiredString(item.name, `partItems[${index}].name`, 200),
      specification: optionalString(item.specification, `partItems[${index}].specification`, 300),
      remark: optionalString(item.remark, `partItems[${index}].remark`, 1000),
      quantity: null,
      unitPriceCents: null,
      amountCents: null
    };
  });
}

function normalizePricedParts(items, existingItems) {
  if (!Array.isArray(items) || items.length !== existingItems.length) {
    throw inputError('Pricing must include every existing part row exactly once');
  }
  const existingMap = new Map(existingItems.map((item) => [item.itemKey, item]));
  const seen = new Set();
  let totalAmountCents = 0;
  const partItems = items.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw inputError(`partItems[${index}] must be an object`);
    }
    const itemKey = requiredString(item.itemKey, `partItems[${index}].itemKey`, 64);
    const existing = existingMap.get(itemKey);
    if (!existing || seen.has(itemKey)) {
      throw inputError('Pricing cannot add, remove, duplicate, or replace part rows');
    }
    seen.add(itemKey);
    const quantity = positiveNumber(item.quantity, `partItems[${index}].quantity`);
    const unitPriceCents = moneyToCents(item.unitPrice, `partItems[${index}].unitPrice`);
    const amountCents = Math.round(unitPriceCents * quantity);
    if (!Number.isSafeInteger(amountCents)) throw inputError('Part amount is too large');
    totalAmountCents += amountCents;
    if (!Number.isSafeInteger(totalAmountCents)) throw inputError('Total amount is too large');
    return {
      itemKey,
      name: existing.name,
      specification: existing.specification || '',
      remark: existing.remark || '',
      quantity,
      unitPriceCents,
      amountCents
    };
  });
  return { partItems, totalAmountCents };
}

function initialStatus(type) {
  return type === EQUIPMENT_REPAIR_TYPES.FAULT_REPORT
    ? EQUIPMENT_REPAIR_STATUSES.SUB_DEPARTMENT_REVIEW_PENDING
    : EQUIPMENT_REPAIR_STATUSES.SUB_DEPARTMENT_ACCEPTANCE_PENDING;
}

function actorPositionKey(context) {
  if (context.isSuperAdmin === true) return 'SUPER_ADMIN';
  return context.membership?.positionKey || '';
}

function isAssetAdmin(context) {
  return context.isSuperAdmin === true ||
    context.membership?.functionalRoleKeys?.includes(FUNCTIONAL_ROLE_KEYS.ASSET_ADMIN);
}

function isDeputyOrAssistant(context) {
  return context.isSuperAdmin === true || DEPUTY_POSITION_KEYS.has(context.membership?.positionKey);
}

function isDepartmentManager(context) {
  return context.isSuperAdmin === true ||
    context.membership?.positionKey === POSITION_KEYS.DEPARTMENT_MANAGER;
}

function stageActorAllowed(context, order, { subDepartmentLeaderAllowed = null } = {}) {
  switch (order.status) {
    case EQUIPMENT_REPAIR_STATUSES.SUB_DEPARTMENT_REVIEW_PENDING:
    case EQUIPMENT_REPAIR_STATUSES.SUB_DEPARTMENT_ACCEPTANCE_PENDING:
      return typeof subDepartmentLeaderAllowed === 'boolean'
        ? subDepartmentLeaderAllowed
        : context.isSuperAdmin === true;
    case EQUIPMENT_REPAIR_STATUSES.ASSET_ADMIN_RECEIPT_PENDING:
    case EQUIPMENT_REPAIR_STATUSES.ASSET_ADMIN_PRICING_PENDING:
      return isAssetAdmin(context);
    case EQUIPMENT_REPAIR_STATUSES.DEPUTY_APPROVAL_PENDING:
      return isDeputyOrAssistant(context);
    case EQUIPMENT_REPAIR_STATUSES.MANAGER_APPROVAL_PENDING:
      return isDepartmentManager(context);
    case EQUIPMENT_REPAIR_STATUSES.RETURNED_TO_CREATOR:
      return sameId(context.userId, order.createdBy);
    default:
      return false;
  }
}

function allowedActions(context, order, options = {}) {
  if (context.mode !== SESSION_MODES.TEAM || context.readOnly === true) return [];
  if (!stageActorAllowed(context, order, options)) return [];
  if (order.status === EQUIPMENT_REPAIR_STATUSES.RETURNED_TO_CREATOR) {
    return [EQUIPMENT_REPAIR_ACTIONS.RESUBMIT, EQUIPMENT_REPAIR_ACTIONS.VOID];
  }
  const common = [
    EQUIPMENT_REPAIR_ACTIONS.REJECT_TO_CREATOR,
    EQUIPMENT_REPAIR_ACTIONS.REJECT_TO_PREVIOUS,
    EQUIPMENT_REPAIR_ACTIONS.VOID
  ];
  const primary = {
    [EQUIPMENT_REPAIR_STATUSES.SUB_DEPARTMENT_REVIEW_PENDING]:
      EQUIPMENT_REPAIR_ACTIONS.SUB_DEPARTMENT_APPROVE,
    [EQUIPMENT_REPAIR_STATUSES.SUB_DEPARTMENT_ACCEPTANCE_PENDING]:
      EQUIPMENT_REPAIR_ACTIONS.SUB_DEPARTMENT_APPROVE,
    [EQUIPMENT_REPAIR_STATUSES.ASSET_ADMIN_RECEIPT_PENDING]:
      EQUIPMENT_REPAIR_ACTIONS.ACCEPT_RECEIPT,
    [EQUIPMENT_REPAIR_STATUSES.ASSET_ADMIN_PRICING_PENDING]:
      EQUIPMENT_REPAIR_ACTIONS.CONFIRM_PRICING,
    [EQUIPMENT_REPAIR_STATUSES.DEPUTY_APPROVAL_PENDING]:
      EQUIPMENT_REPAIR_ACTIONS.DEPUTY_APPROVE,
    [EQUIPMENT_REPAIR_STATUSES.MANAGER_APPROVAL_PENDING]:
      EQUIPMENT_REPAIR_ACTIONS.MANAGER_APPROVE
  }[order.status];
  return primary ? [primary, ...common] : common;
}

function nextStatusForPrimary(order, action) {
  const key = `${order.status}:${action}`;
  const transitions = {
    [`${EQUIPMENT_REPAIR_STATUSES.SUB_DEPARTMENT_REVIEW_PENDING}:${EQUIPMENT_REPAIR_ACTIONS.SUB_DEPARTMENT_APPROVE}`]:
      EQUIPMENT_REPAIR_STATUSES.ASSET_ADMIN_RECEIPT_PENDING,
    [`${EQUIPMENT_REPAIR_STATUSES.SUB_DEPARTMENT_ACCEPTANCE_PENDING}:${EQUIPMENT_REPAIR_ACTIONS.SUB_DEPARTMENT_APPROVE}`]:
      order.type === EQUIPMENT_REPAIR_TYPES.PARTS_REPAIR
        ? EQUIPMENT_REPAIR_STATUSES.ASSET_ADMIN_PRICING_PENDING
        : EQUIPMENT_REPAIR_STATUSES.DEPUTY_APPROVAL_PENDING,
    [`${EQUIPMENT_REPAIR_STATUSES.ASSET_ADMIN_RECEIPT_PENDING}:${EQUIPMENT_REPAIR_ACTIONS.ACCEPT_RECEIPT}`]:
      EQUIPMENT_REPAIR_STATUSES.COMPLETED,
    [`${EQUIPMENT_REPAIR_STATUSES.ASSET_ADMIN_PRICING_PENDING}:${EQUIPMENT_REPAIR_ACTIONS.CONFIRM_PRICING}`]:
      EQUIPMENT_REPAIR_STATUSES.DEPUTY_APPROVAL_PENDING,
    [`${EQUIPMENT_REPAIR_STATUSES.DEPUTY_APPROVAL_PENDING}:${EQUIPMENT_REPAIR_ACTIONS.DEPUTY_APPROVE}`]:
      EQUIPMENT_REPAIR_STATUSES.MANAGER_APPROVAL_PENDING,
    [`${EQUIPMENT_REPAIR_STATUSES.MANAGER_APPROVAL_PENDING}:${EQUIPMENT_REPAIR_ACTIONS.MANAGER_APPROVE}`]:
      EQUIPMENT_REPAIR_STATUSES.COMPLETED
  };
  return transitions[key] || null;
}

function previousStatus(order) {
  switch (order.status) {
    case EQUIPMENT_REPAIR_STATUSES.SUB_DEPARTMENT_REVIEW_PENDING:
    case EQUIPMENT_REPAIR_STATUSES.SUB_DEPARTMENT_ACCEPTANCE_PENDING:
      return EQUIPMENT_REPAIR_STATUSES.RETURNED_TO_CREATOR;
    case EQUIPMENT_REPAIR_STATUSES.ASSET_ADMIN_RECEIPT_PENDING:
      return EQUIPMENT_REPAIR_STATUSES.SUB_DEPARTMENT_REVIEW_PENDING;
    case EQUIPMENT_REPAIR_STATUSES.ASSET_ADMIN_PRICING_PENDING:
      return EQUIPMENT_REPAIR_STATUSES.SUB_DEPARTMENT_ACCEPTANCE_PENDING;
    case EQUIPMENT_REPAIR_STATUSES.DEPUTY_APPROVAL_PENDING:
      return order.type === EQUIPMENT_REPAIR_TYPES.PARTS_REPAIR
        ? EQUIPMENT_REPAIR_STATUSES.ASSET_ADMIN_PRICING_PENDING
        : EQUIPMENT_REPAIR_STATUSES.SUB_DEPARTMENT_ACCEPTANCE_PENDING;
    case EQUIPMENT_REPAIR_STATUSES.MANAGER_APPROVAL_PENDING:
      return EQUIPMENT_REPAIR_STATUSES.DEPUTY_APPROVAL_PENDING;
    default:
      return null;
  }
}

function auditAction(action) {
  if (action === EQUIPMENT_REPAIR_ACTIONS.REJECT_TO_CREATOR ||
      action === EQUIPMENT_REPAIR_ACTIONS.REJECT_TO_PREVIOUS) return AUDIT_ACTIONS.REJECT;
  if (action === EQUIPMENT_REPAIR_ACTIONS.VOID) return AUDIT_ACTIONS.STATUS_CHANGE;
  if (action === EQUIPMENT_REPAIR_ACTIONS.RESUBMIT) return AUDIT_ACTIONS.SUBMIT;
  return AUDIT_ACTIONS.APPROVE;
}

function queryFilters(query = {}) {
  const filters = [];
  if (query.type) {
    if (!EQUIPMENT_REPAIR_TYPE_VALUES.includes(query.type)) throw inputError('Invalid repair type');
    filters.push({ type: query.type });
  }
  if (query.status) {
    const statuses = String(query.status).split(',').filter(Boolean);
    if (statuses.length === 0 || statuses.some((status) => !EQUIPMENT_REPAIR_STATUS_VALUES.includes(status))) {
      throw inputError('Invalid repair status');
    }
    filters.push({ status: { $in: statuses } });
  }
  if (query.equipmentId) filters.push({ equipmentId: normalizeRelatedId(query.equipmentId, 'equipmentId') });
  if (query.orgUnitId) filters.push({ orgUnitId: normalizeRelatedId(query.orgUnitId, 'orgUnitId') });
  if (query.createdBy) filters.push({ createdBy: normalizeRelatedId(query.createdBy, 'createdBy') });
  const keyword = normalizeRepairQueryKeyword(query.keyword);
  if (keyword) {
    const pattern = { $regex: escapeRegex(keyword), $options: 'i' };
    filters.push({ $or: [
      { 'equipmentSnapshot.assetCode': pattern },
      { 'equipmentSnapshot.name': pattern },
      { repairerName: pattern },
      { contactName: pattern },
      { contactPhone: pattern },
      { plateNumber: pattern },
      { faultDescription: pattern }
    ] });
  }
  if (query.startDate || query.endDate) {
    const createdAt = {};
    if (query.startDate) createdAt.$gte = requiredDate(query.startDate, 'startDate');
    if (query.endDate) createdAt.$lte = requiredDate(query.endDate, 'endDate');
    filters.push({ createdAt });
  }
  return filters.length ? { $and: filters } : {};
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

function createEquipmentRepairService({
  EquipmentAssetModel = EquipmentAsset,
  EquipmentRepairOrderModel = EquipmentRepairOrder,
  MessageModel = Message,
  OrgUnitModel = OrgUnit,
  ProjectTeamModel = ProjectTeam,
  TeamMembershipModel = TeamMembership,
  UserModel = User,
  auditService = createAuditService(),
  fileAssetService = null,
  connection = mongoose.connection
} = {}) {
  const files = fileAssetService || createFileAssetService({
    storageRoot: process.env.UPLOAD_PATH,
    EquipmentRepairOrderModel
  });

  function runRepairTransaction(work) {
    if (!supportsTransactions(connection)) {
      throw repairError(
        503,
        'EQUIPMENT_REPAIR_TRANSACTIONS_REQUIRED',
        'Equipment repair writes require MongoDB replica-set transaction support'
      );
    }
    return runWithOptionalTransaction(work, connection);
  }

  function isSubDepartmentStage(order) {
    return [
      EQUIPMENT_REPAIR_STATUSES.SUB_DEPARTMENT_REVIEW_PENDING,
      EQUIPMENT_REPAIR_STATUSES.SUB_DEPARTMENT_ACCEPTANCE_PENDING
    ].includes(order.status);
  }

  async function actorNameMap(documents, session = null) {
    const actorIds = [...new Set(
      (Array.isArray(documents) ? documents : [documents])
        .flatMap((document) => (plain(document)?.actionLogs || []).map(({ actorId }) => normalizeId(actorId)))
        .filter(Boolean)
    )];
    if (actorIds.length === 0) return new Map();
    const query = UserModel.find({ _id: { $in: actorIds } }).select('_id name').lean();
    if (session) query.session(session);
    const users = await query;
    return new Map(users.map((user) => [normalizeId(user._id), user.name || '']));
  }

  async function serializeRepairWithActors(document, availableActions = [], session = null) {
    return serializeRepair(document, availableActions, await actorNameMap(document, session));
  }

  async function activeMembershipUserIds(filter, session = null) {
    const membershipQuery = TeamMembershipModel.find({
      ...filter,
      status: MEMBERSHIP_STATUSES.ACTIVE,
      permissionKeys: 'equipment.repair'
    }).select('userId').lean();
    if (session) membershipQuery.session(session);
    const memberships = await membershipQuery;
    const userIds = [...new Set(
      memberships.map(({ userId }) => normalizeId(userId)).filter(Boolean)
    )];
    if (userIds.length === 0) return [];

    const userQuery = UserModel.find({
      _id: { $in: userIds },
      status: 'active'
    }).select('_id').lean();
    if (session) userQuery.session(session);
    const activeUsers = await userQuery;
    const activeUserIds = new Set(activeUsers.map(({ _id }) => normalizeId(_id)));
    return userIds.filter((userId) => activeUserIds.has(userId));
  }

  async function belongsToOrderSubDepartment(context, order, session = null) {
    if (
      context.mode !== SESSION_MODES.TEAM ||
      !SUB_DEPARTMENT_POSITION_KEYS.has(context.membership?.positionKey) ||
      !sameId(context.activeTeamId, order.teamId)
    ) {
      return false;
    }
    const [orderSubDepartmentIds, actorSubDepartmentIds] = await Promise.all([
      subDepartmentOrgUnitIds({
        OrgUnitModel,
        teamId: order.teamId,
        orgUnitId: order.orgUnitId,
        session
      }),
      subDepartmentOrgUnitIds({
        OrgUnitModel,
        teamId: order.teamId,
        orgUnitId: context.membership.orgUnitId,
        session
      })
    ]);
    return orderSubDepartmentIds.some((orderId) => actorSubDepartmentIds.some(
      (actorId) => sameId(actorId, orderId)
    ));
  }

  async function resolveSubDepartmentStageHandlers(order, session = null, candidateContext = null) {
    const subDepartmentIds = await subDepartmentOrgUnitIds({
      OrgUnitModel,
      teamId: order.teamId,
      orgUnitId: order.orgUnitId,
      session
    });
    if (subDepartmentIds.length === 0) {
      return { orgUnitIds: [], positionKeys: [], userIds: [] };
    }
    const orgUnitIds = await leadershipOrgUnitIds({
      OrgUnitModel,
      teamId: order.teamId,
      orgUnitIds: subDepartmentIds,
      session
    });
    const primaryFilter = {
      teamId: order.teamId,
      orgUnitId: { $in: orgUnitIds },
      positionKey: { $in: [...PRIMARY_SUB_DEPARTMENT_LEADER_POSITION_KEYS] }
    };
    const primaryUserIds = await activeMembershipUserIds(primaryFilter, session);
    const candidateIsPrimary = Boolean(
      candidateContext &&
      hasEffectivePermission(candidateContext, 'equipment.repair') &&
      PRIMARY_SUB_DEPARTMENT_LEADER_POSITION_KEYS.includes(
        candidateContext.membership?.positionKey
      ) &&
      await belongsToOrderSubDepartment(candidateContext, order, session)
    );
    if (primaryUserIds.length > 0 || candidateIsPrimary) {
      return {
        orgUnitIds,
        positionKeys: [...PRIMARY_SUB_DEPARTMENT_LEADER_POSITION_KEYS],
        userIds: primaryUserIds
      };
    }
    return {
      orgUnitIds,
      positionKeys: [POSITION_KEYS.SUPERVISOR],
      userIds: await activeMembershipUserIds({
        teamId: order.teamId,
        orgUnitId: { $in: orgUnitIds },
        positionKey: POSITION_KEYS.SUPERVISOR
      }, session)
    };
  }

  async function canActAsSubDepartmentLeader(context, order, session = null) {
    if (context.isSuperAdmin === true) return true;
    if (
      !hasEffectivePermission(context, 'equipment.repair') ||
      !await belongsToOrderSubDepartment(context, order, session)
    ) {
      return false;
    }
    const handlers = await resolveSubDepartmentStageHandlers(order, session, context);
    return handlers.positionKeys.includes(context.membership?.positionKey);
  }

  async function resolveCurrentStageHandlers(order, session = null) {
    switch (order.status) {
      case EQUIPMENT_REPAIR_STATUSES.SUB_DEPARTMENT_REVIEW_PENDING:
      case EQUIPMENT_REPAIR_STATUSES.SUB_DEPARTMENT_ACCEPTANCE_PENDING:
        return (await resolveSubDepartmentStageHandlers(order, session)).userIds;
      case EQUIPMENT_REPAIR_STATUSES.ASSET_ADMIN_RECEIPT_PENDING:
      case EQUIPMENT_REPAIR_STATUSES.ASSET_ADMIN_PRICING_PENDING:
        return activeMembershipUserIds({
          teamId: order.teamId,
          functionalRoleKeys: FUNCTIONAL_ROLE_KEYS.ASSET_ADMIN
        }, session);
      case EQUIPMENT_REPAIR_STATUSES.DEPUTY_APPROVAL_PENDING:
        return activeMembershipUserIds({
          teamId: order.teamId,
          positionKey: { $in: [...DEPUTY_POSITION_KEYS] }
        }, session);
      case EQUIPMENT_REPAIR_STATUSES.MANAGER_APPROVAL_PENDING:
        return activeMembershipUserIds({
          teamId: order.teamId,
          positionKey: POSITION_KEYS.DEPARTMENT_MANAGER
        }, session);
      case EQUIPMENT_REPAIR_STATUSES.RETURNED_TO_CREATOR:
        return [normalizeId(order.createdBy)].filter(Boolean);
      default:
        return [];
    }
  }

  async function isCurrentStageHandler(context, order, session = null) {
    if (context.isSuperAdmin === true) return true;
    if (
      context.mode !== SESSION_MODES.TEAM ||
      context.readOnly === true ||
      !sameId(context.activeTeamId, order.teamId) ||
      !hasEffectivePermission(context, 'equipment.repair')
    ) {
      return false;
    }
    switch (order.status) {
      case EQUIPMENT_REPAIR_STATUSES.SUB_DEPARTMENT_REVIEW_PENDING:
      case EQUIPMENT_REPAIR_STATUSES.SUB_DEPARTMENT_ACCEPTANCE_PENDING:
        return canActAsSubDepartmentLeader(context, order, session);
      case EQUIPMENT_REPAIR_STATUSES.ASSET_ADMIN_RECEIPT_PENDING:
      case EQUIPMENT_REPAIR_STATUSES.ASSET_ADMIN_PRICING_PENDING:
        return isAssetAdmin(context);
      case EQUIPMENT_REPAIR_STATUSES.DEPUTY_APPROVAL_PENDING:
        return isDeputyOrAssistant(context);
      case EQUIPMENT_REPAIR_STATUSES.MANAGER_APPROVAL_PENDING:
        return isDepartmentManager(context);
      case EQUIPMENT_REPAIR_STATUSES.RETURNED_TO_CREATOR:
        return sameId(context.userId, order.createdBy);
      default:
        return false;
    }
  }

  async function resolveAllowedActions(context, order, session = null) {
    if (!await isCurrentStageHandler(context, order, session)) return [];
    return allowedActions(context, order, {
      subDepartmentLeaderAllowed: isSubDepartmentStage(order) ? true : null
    });
  }

  async function createCurrentStageMessages(order, recipients, session) {
    if (recipients.length === 0) return;
    const title = order.status === EQUIPMENT_REPAIR_STATUSES.RETURNED_TO_CREATOR
      ? '设备维修单已退回'
      : '设备维修待办';
    const content = `${order.equipmentSnapshot?.name || '设备'}（${order.equipmentSnapshot?.assetCode || '-'}）维修单状态：${REPAIR_STATUS_MESSAGE_LABELS[order.status] || order.status}`;
    const deduplicationKey = `repair:${order._id}:revision:${order.revision}`;
    for (const recipient of recipients) {
      const updateOptions = { upsert: true };
      if (session) updateOptions.session = session;
      await MessageModel.updateOne({
        teamId: order.teamId,
        recipient,
        deduplicationKey
      }, {
        $setOnInsert: {
          teamId: order.teamId,
          type: 'system',
          recipient,
          deduplicationKey
        },
        $set: {
          title,
          content,
          isRead: false,
          extraData: {
            resourceType: 'REPAIR_ORDER',
            repairId: normalizeId(order._id),
            status: order.status,
            revision: order.revision,
            todoState: REPAIR_TODO_STATES.ACTIVE
          }
        },
        $unset: {
          readAt: 1
        }
      }, updateOptions);
    }
  }

  async function invalidateStaleStageMessages(order, recipients, session) {
    const repairId = normalizeId(order._id);
    const currentRecipients = new Set(recipients);
    const currentDeduplicationKey = `repair:${order._id}:revision:${order.revision}`;
    const query = MessageModel.find({
      teamId: order.teamId,
      type: 'system',
      'extraData.resourceType': 'REPAIR_ORDER',
      'extraData.repairId': repairId,
      $or: [
        { 'extraData.todoState': REPAIR_TODO_STATES.ACTIVE },
        {
          title: { $in: ['设备维修待办', '设备维修单已退回'] },
          'extraData.todoState': { $exists: false }
        }
      ]
    }).select('_id recipient title isRead readAt extraData deduplicationKey').lean();
    if (session) query.session(session);
    const activeMessages = await query;
    const actionable = !TERMINAL_REPAIR_STATUSES.has(order.status);
    const now = new Date();
    const audits = [];

    for (const message of activeMessages) {
      const recipient = normalizeId(message.recipient);
      const remainsCurrent = actionable &&
        currentRecipients.has(recipient) &&
        message.deduplicationKey === currentDeduplicationKey &&
        message.extraData?.status === order.status &&
        Number(message.extraData?.revision) === Number(order.revision);
      if (remainsCurrent) continue;

      const sameStage = actionable &&
        message.extraData?.status === order.status &&
        Number(message.extraData?.revision) === Number(order.revision);
      const todoState = sameStage && recipients.length > 0
        ? REPAIR_TODO_STATES.TRANSFERRED
        : REPAIR_TODO_STATES.INVALIDATED;
      const invalidatedReason = TERMINAL_REPAIR_STATUSES.has(order.status)
        ? 'WORKFLOW_CLOSED'
        : sameStage
          ? 'HANDLER_CHANGED'
          : recipients.length > 0
            ? 'WORKFLOW_STAGE_CHANGED'
            : 'NO_ELIGIBLE_HANDLER';
      const nextExtraData = {
        ...(message.extraData || {}),
        todoState,
        invalidatedAt: now,
        invalidatedReason,
        transferredTo: todoState === REPAIR_TODO_STATES.TRANSFERRED
          ? [...recipients]
          : []
      };
      const nextTitle = todoState === REPAIR_TODO_STATES.TRANSFERRED
        ? '设备维修待办已转交'
        : '设备维修待办已处理';
      const nextContent = todoState === REPAIR_TODO_STATES.TRANSFERRED
        ? `${order.equipmentSnapshot?.name || '设备'}（${order.equipmentSnapshot?.assetCode || '-'}）维修待办已转交给当前负责人，无需您处理。`
        : `${order.equipmentSnapshot?.name || '设备'}（${order.equipmentSnapshot?.assetCode || '-'}）维修待办已失效，无需您处理。`;
      const updateOptions = {};
      if (session) updateOptions.session = session;
      const result = await MessageModel.updateOne({
        _id: message._id,
        $or: [
          { 'extraData.todoState': REPAIR_TODO_STATES.ACTIVE },
          { 'extraData.todoState': { $exists: false } }
        ]
      }, {
        $set: {
          title: nextTitle,
          content: nextContent,
          extraData: nextExtraData,
          isRead: true,
          readAt: message.readAt || now
        }
      }, updateOptions);
      if (result.modifiedCount !== 1) continue;
      audits.push({
        action: AUDIT_ACTIONS.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPES.MESSAGE,
        resourceId: message._id,
        before: {
          repairId,
          recipient,
          status: message.extraData?.status || null,
          revision: message.extraData?.revision ?? null,
          todoState: message.extraData?.todoState || REPAIR_TODO_STATES.ACTIVE,
          isRead: message.isRead === true
        },
        after: {
          repairId,
          recipient,
          status: message.extraData?.status || null,
          revision: message.extraData?.revision ?? null,
          todoState,
          invalidatedReason,
          transferredTo: nextExtraData.transferredTo,
          isRead: true
        },
        reason: `Repair todo ${invalidatedReason.toLowerCase()}`,
        targetTeamId: order.teamId
      });
    }
    if (audits.length > 0) {
      await auditService.recordManySystem(audits, { session });
    }
  }

  async function createTerminalNotification(order, session) {
    if (!TERMINAL_REPAIR_STATUSES.has(order.status)) return;
    const recipient = normalizeId(order.createdBy);
    if (!recipient) return;
    const updateOptions = { upsert: true };
    if (session) updateOptions.session = session;
    await MessageModel.updateOne({
      teamId: order.teamId,
      recipient,
      deduplicationKey: `repair:${order._id}:revision:${order.revision}`
    }, {
      $setOnInsert: {
        teamId: order.teamId,
        type: 'system',
        title: order.status === EQUIPMENT_REPAIR_STATUSES.COMPLETED
          ? '设备维修流程已完成'
          : '设备维修流程已作废',
        content: `${order.equipmentSnapshot?.name || '设备'}（${order.equipmentSnapshot?.assetCode || '-'}）维修单状态：${REPAIR_STATUS_MESSAGE_LABELS[order.status] || order.status}`,
        recipient,
        extraData: {
          resourceType: 'REPAIR_ORDER',
          repairId: normalizeId(order._id),
          status: order.status,
          revision: order.revision
        },
        deduplicationKey: `repair:${order._id}:revision:${order.revision}`
      }
    }, updateOptions);
  }

  async function syncCurrentStageMessages(order, session = null) {
    const recipients = await resolveCurrentStageHandlers(order, session);
    await createCurrentStageMessages(order, recipients, session);
    await invalidateStaleStageMessages(order, recipients, session);
    await createTerminalNotification(order, session);
    return recipients;
  }

  async function syncOpenRepairMessages({ teamId, session = null } = {}) {
    const normalizedTeamId = normalizeObjectId(teamId, 'teamId');
    const query = EquipmentRepairOrderModel.find({
      teamId: normalizedTeamId,
      status: {
        $nin: [
          EQUIPMENT_REPAIR_STATUSES.COMPLETED,
          EQUIPMENT_REPAIR_STATUSES.VOIDED
        ]
      }
    }).sort({ _id: 1 }).lean();
    if (session) query.session(session);
    const orders = await query;
    let recipientCount = 0;
    for (const order of orders) {
      recipientCount += (await syncCurrentStageMessages(order, session)).length;
    }
    return { orderCount: orders.length, recipientCount };
  }

  async function resolveReadTeamId(authContext, requestedTeamId) {
    const context = assertBusinessContext(authContext);
    if (context.mode === SESSION_MODES.TEAM) return normalizeObjectId(context.activeTeamId, 'activeTeamId');
    if (context.mode !== SESSION_MODES.GLOBAL_READ_ONLY) {
      throw repairError(403, 'EQUIPMENT_REPAIR_TEAM_CONTEXT_REQUIRED', 'Select a team first');
    }
    let teamId;
    try {
      teamId = normalizeObjectId(requestedTeamId, 'teamId');
    } catch {
      throw inputError('A valid teamId is required in global read-only mode');
    }
    const exists = await ProjectTeamModel.exists({ _id: teamId, status: TEAM_STATUSES.ACTIVE });
    if (!exists) throw notFound();
    return teamId;
  }

  async function readFilter({
    authContext,
    requestedTeamId,
    method,
    repairId,
    userFilter = {},
    permissionKey = 'equipment.view'
  }) {
    assertPermission(authContext, permissionKey);
    const teamId = await resolveReadTeamId(authContext, requestedTeamId);
    const filter = repairId
      ? buildScopedDetailFilter({
          authContext,
          moduleKey: DATA_SCOPE_MODULES.EQUIPMENT,
          id: normalizeDetailId(repairId),
          userFilter,
          globalTeamId: teamId,
          method
        })
      : buildScopedFilter({
          authContext,
          moduleKey: DATA_SCOPE_MODULES.EQUIPMENT,
          userFilter,
          globalTeamId: teamId,
          method
        });
    return { teamId, filter };
  }

  // Build actor-specific todo clauses separately from the scoped read filter.
  // The final query must keep readFilter()'s team/organization constraint so
  // an approval-stage OR cannot widen an ORG_UNIT data scope.
  async function buildTodoFilter(context, teamId) {
    const todoClauses = [];
    if (context.isSuperAdmin === true) {
      todoClauses.push({
        status: {
          $in: EQUIPMENT_REPAIR_STATUS_VALUES.filter((status) => (
            status !== EQUIPMENT_REPAIR_STATUSES.COMPLETED &&
            status !== EQUIPMENT_REPAIR_STATUSES.VOIDED &&
            status !== EQUIPMENT_REPAIR_STATUSES.RETURNED_TO_CREATOR
          ))
        }
      });
      todoClauses.push({
        status: EQUIPMENT_REPAIR_STATUSES.RETURNED_TO_CREATOR,
        createdBy: context.userId
      });
      return { $or: todoClauses };
    }

    todoClauses.push({
      status: EQUIPMENT_REPAIR_STATUSES.RETURNED_TO_CREATOR,
      createdBy: context.userId
    });
    if (SUB_DEPARTMENT_POSITION_KEYS.has(context.membership?.positionKey)) {
      const subDepartmentIds = await subDepartmentOrgUnitIds({
        OrgUnitModel,
        teamId,
        orgUnitId: context.membership.orgUnitId
      });
      const canLead = subDepartmentIds.length > 0 && await canActAsSubDepartmentLeader(context, {
        teamId,
        orgUnitId: subDepartmentIds[0],
        status: EQUIPMENT_REPAIR_STATUSES.SUB_DEPARTMENT_REVIEW_PENDING
      });
      if (canLead) {
        todoClauses.push({
          orgUnitId: { $in: await leadershipOrgUnitIds({
            OrgUnitModel,
            teamId,
            orgUnitIds: subDepartmentIds
          }) },
          status: { $in: [
            EQUIPMENT_REPAIR_STATUSES.SUB_DEPARTMENT_REVIEW_PENDING,
            EQUIPMENT_REPAIR_STATUSES.SUB_DEPARTMENT_ACCEPTANCE_PENDING
          ] }
        });
      }
    }
    if (isAssetAdmin(context)) {
      todoClauses.push({ status: { $in: [
        EQUIPMENT_REPAIR_STATUSES.ASSET_ADMIN_RECEIPT_PENDING,
        EQUIPMENT_REPAIR_STATUSES.ASSET_ADMIN_PRICING_PENDING
      ] } });
    }
    if (isDeputyOrAssistant(context)) {
      todoClauses.push({ status: EQUIPMENT_REPAIR_STATUSES.DEPUTY_APPROVAL_PENDING });
    }
    if (isDepartmentManager(context)) {
      todoClauses.push({ status: EQUIPMENT_REPAIR_STATUSES.MANAGER_APPROVAL_PENDING });
    }
    return { $or: todoClauses };
  }

  async function listRepairs({ authContext, requestedTeamId, method = 'GET', query = {} }) {
    const context = assertBusinessContext(authContext);
    const todoOnly = query.todo === 'true' || query.todo === true;
    if (todoOnly && context.mode !== SESSION_MODES.TEAM) {
      throw repairError(403, 'EQUIPMENT_REPAIR_TEAM_CONTEXT_REQUIRED', 'Select a team before viewing repair todos');
    }
    const permissionKey = todoOnly ? 'equipment.repair' : 'equipment.view';
    const { page, pageSize, skip } = pagination(query);
    const baseFilter = queryFilters(query);
    const { teamId, filter: scopedFilter } = await readFilter({
      authContext: context,
      requestedTeamId,
      method,
      userFilter: baseFilter,
      permissionKey
    });
    let filter = scopedFilter;
    if (todoOnly) {
      filter = {
        $and: [
          scopedFilter,
          await buildTodoFilter(context, teamId)
        ]
      };
    }
    const [documents, total] = await Promise.all([
      EquipmentRepairOrderModel.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(pageSize).lean(),
      EquipmentRepairOrderModel.countDocuments(filter)
    ]);
    const [availableActions, names] = await Promise.all([
      Promise.all(documents.map((document) => resolveAllowedActions(context, document))),
      actorNameMap(documents)
    ]);
    const repairs = documents.map((document, index) => (
      serializeRepair(document, availableActions[index], names)
    ));
    return { repairs, total, page, pageSize };
  }

  async function getRepair({ authContext, requestedTeamId, method = 'GET', repairId }) {
    const context = assertBusinessContext(authContext);
    const canViewEquipment = hasEffectivePermission(context, 'equipment.view');
    const permissionKey = canViewEquipment ? 'equipment.view' : 'equipment.repair';
    const { filter } = await readFilter({
      authContext: context,
      requestedTeamId,
      method,
      repairId,
      permissionKey
    });
    let document = await EquipmentRepairOrderModel.findOne(filter).lean();
    if (document && !canViewEquipment && (await resolveAllowedActions(context, document)).length === 0) {
      document = null;
    }
    if (!document) throw notFound();
    return serializeRepairWithActors(document, await resolveAllowedActions(context, document));
  }

  async function listRepairLocations({ authContext, requestedTeamId, method = 'GET' }) {
    const context = assertBusinessContext(authContext);
    assertPermission(context, 'equipment.view');
    const teamId = await resolveReadTeamId(context, requestedTeamId);
    const team = await ProjectTeamModel.findOne({ _id: teamId, status: TEAM_STATUSES.ACTIVE })
      .select('settings.repairLocations')
      .lean();
    if (!team) throw notFound();
    return { locations: team.settings?.repairLocations || [] };
  }

  async function updateRepairLocations({ authContext, req, input = {} }) {
    const context = assertTeamContext(authContext);
    assertPermission(context, 'equipment.edit');
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some((key) => !['locations', 'reason'].includes(key))) {
      throw inputError('Only locations and reason can be updated');
    }
    const locations = normalizeRepairLocations(input.locations);
    const reason = optionalString(input.reason, 'reason', 2000);
    return runRepairTransaction(async (session) => {
      const team = await execute(ProjectTeamModel.findOne({
        _id: context.activeTeamId,
        status: TEAM_STATUSES.ACTIVE
      }), session);
      if (!team) throw notFound();
      const before = { repairLocations: [...(team.settings?.repairLocations || [])] };
      team.settings = team.settings || {};
      team.settings.repairLocations = locations;
      await team.save({ session: session || undefined });
      await auditService.record({
        req,
        authContext: context,
        action: AUDIT_ACTIONS.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPES.PROJECT_TEAM,
        resourceId: team._id,
        before,
        after: { repairLocations: locations },
        reason: reason || null,
        targetTeamId: context.activeTeamId,
        session
      });
      return locations;
    });
  }

  function createPayload(input, type) {
    if (type === EQUIPMENT_REPAIR_TYPES.FAULT_REPORT) {
      return {
        reportTime: requiredDate(input.reportTime, 'reportTime'),
        reportLocation: requiredString(input.reportLocation, 'reportLocation', 500),
        plateNumber: optionalString(input.plateNumber, 'plateNumber', 100),
        contactName: requiredString(input.contactName, 'contactName', 100),
        contactPhone: requiredString(input.contactPhone, 'contactPhone', 50),
        faultDescription: requiredString(input.faultDescription, 'faultDescription', 5000),
        repairDate: null,
        repairerName: '',
        repairDescription: '',
        partItems: [],
        totalAmountCents: 0,
        photoAttachments: normalizeAttachmentInput(input.photoAttachments, { required: true })
      };
    }
    return {
      reportTime: null,
      reportLocation: '',
      plateNumber: '',
      contactName: '',
      contactPhone: '',
      faultDescription: '',
      repairDate: requiredDate(input.repairDate, 'repairDate'),
      repairerName: requiredString(input.repairerName, 'repairerName', 200),
      repairDescription: optionalString(input.repairDescription, 'repairDescription', 5000),
      partItems: type === EQUIPMENT_REPAIR_TYPES.PARTS_REPAIR
        ? normalizePartDrafts(input.partItems)
        : [],
      totalAmountCents: 0,
      photoAttachments: []
    };
  }

  async function createRepair({ authContext, req, input = {} }) {
    const context = assertTeamContext(authContext);
    assertPermission(context, 'equipment.repair');
    assertNoClientScope(input);
    if (!EQUIPMENT_REPAIR_TYPE_VALUES.includes(input.type)) throw inputError('Invalid repair type');
    const idempotencyKey = optionalString(input.idempotencyKey, 'idempotencyKey', 128, null) || null;
    const equipmentId = normalizeRelatedId(input.equipmentId, 'equipmentId');
    const assetFilter = buildScopedDetailFilter({
      authContext: context,
      moduleKey: DATA_SCOPE_MODULES.EQUIPMENT,
      id: equipmentId,
      method: 'POST'
    });

    try {
      return await runRepairTransaction(async (session) => {
        if (idempotencyKey) {
          const existing = await execute(EquipmentRepairOrderModel.findOne({
            teamId: context.activeTeamId,
            createdBy: context.userId,
            idempotencyKey
          }), session);
          if (existing) return serializeRepairWithActors(
            existing,
            await resolveAllowedActions(context, existing, session),
            session
          );
        }
        const asset = await execute(EquipmentAssetModel.findOne(assetFilter), session);
        if (!asset) throw repairError(404, 'EQUIPMENT_NOT_FOUND', 'Equipment does not exist');
        const orgUnit = await execute(OrgUnitModel.findOne({
          _id: asset.orgUnitId,
          teamId: context.activeTeamId
        }), session);
        if (!orgUnit) throw inputError('Equipment organization unit is invalid');
        const typeFields = createPayload(input, input.type);
        const status = initialStatus(input.type);
        const now = new Date();
        const document = await createOne(EquipmentRepairOrderModel, {
          teamId: context.activeTeamId,
          orgUnitId: asset.orgUnitId,
          equipmentId: asset._id,
          categoryId: asset.categoryId,
          type: input.type,
          status,
          equipmentSnapshot: {
            assetCode: asset.assetCode,
            name: asset.name,
            departmentName: context.team?.name || '',
            orgUnitName: orgUnit.name,
            location: asset.location || '',
            plateNumber: asset.plateNumber || ''
          },
          createdBy: context.userId,
          ...typeFields,
          lastActionBy: context.userId,
          lastActionAt: now,
          revision: 0,
          idempotencyKey,
          actionLogs: [{
            action: EQUIPMENT_REPAIR_ACTIONS.CREATE,
            fromStatus: null,
            toStatus: status,
            actorId: context.userId,
            actorPositionKey: actorPositionKey(context),
            note: optionalString(input.note, 'note', 2000),
            actedAt: now
          }]
        }, session);

        if (input.type === EQUIPMENT_REPAIR_TYPES.FAULT_REPORT) {
          const bound = await files.reconcileOwnerFiles({
            authContext: context,
            req,
            attachments: typeFields.photoAttachments,
            previousAttachments: [],
            ownerType: FILE_OWNER_TYPES.REPAIR,
            ownerId: document._id,
            method: 'PATCH',
            allowedMimeTypes: IMAGE_MIME_TYPES,
            session
          });
          document.photoAttachments = bound;
          await document.save({ session: session || undefined });
        }
        await syncCurrentStageMessages(document, session);
        const after = await serializeRepairWithActors(
          document,
          await resolveAllowedActions(context, document, session),
          session
        );
        await auditService.record({
          req,
          authContext: context,
          action: AUDIT_ACTIONS.CREATE,
          resourceType: AUDIT_RESOURCE_TYPES.REPAIR_ORDER,
          resourceId: document._id,
          after,
          targetTeamId: context.activeTeamId,
          session
        });
        return after;
      });
    } catch (error) {
      if (error?.code === 11000 && idempotencyKey) {
        const existing = await EquipmentRepairOrderModel.findOne({
          teamId: context.activeTeamId,
          createdBy: context.userId,
          idempotencyKey
        });
        if (existing) return serializeRepairWithActors(
          existing,
          await resolveAllowedActions(context, existing)
        );
      }
      throw error;
    }
  }

  function acceptanceCorrections(order, corrections) {
    if (corrections === undefined || corrections === null) return { values: {}, snapshot: null };
    if (!corrections || typeof corrections !== 'object' || Array.isArray(corrections)) {
      throw inputError('corrections must be an object');
    }
    const allowed = new Set(['repairDate', 'repairerName', 'repairDescription', 'partItems']);
    if (Object.keys(corrections).some((key) => !allowed.has(key))) {
      throw inputError('corrections contains unsupported fields');
    }
    const values = {};
    if (Object.prototype.hasOwnProperty.call(corrections, 'repairDate')) {
      values.repairDate = requiredDate(corrections.repairDate, 'corrections.repairDate');
    }
    if (Object.prototype.hasOwnProperty.call(corrections, 'repairerName')) {
      values.repairerName = requiredString(corrections.repairerName, 'corrections.repairerName', 200);
    }
    if (Object.prototype.hasOwnProperty.call(corrections, 'repairDescription')) {
      values.repairDescription = optionalString(
        corrections.repairDescription,
        'corrections.repairDescription',
        5000
      );
    }
    if (Object.prototype.hasOwnProperty.call(corrections, 'partItems')) {
      if (order.type !== EQUIPMENT_REPAIR_TYPES.PARTS_REPAIR) {
        throw inputError('NO_PARTS_REPAIR cannot contain partItems');
      }
      values.partItems = normalizePartDrafts(corrections.partItems);
      values.totalAmountCents = 0;
    }
    return { values, snapshot: Object.keys(values).length ? values : null };
  }

  function returnedCorrections(order, input) {
    const corrections = input.corrections && typeof input.corrections === 'object'
      ? input.corrections
      : {};
    if (order.type === EQUIPMENT_REPAIR_TYPES.FAULT_REPORT) {
      return {
        reportTime: requiredDate(corrections.reportTime ?? order.reportTime, 'corrections.reportTime'),
        reportLocation: requiredString(
          corrections.reportLocation ?? order.reportLocation,
          'corrections.reportLocation',
          500
        ),
        plateNumber: optionalString(
          corrections.plateNumber ?? order.plateNumber,
          'corrections.plateNumber',
          100
        ),
        contactName: requiredString(
          corrections.contactName ?? order.contactName,
          'corrections.contactName',
          100
        ),
        contactPhone: requiredString(
          corrections.contactPhone ?? order.contactPhone,
          'corrections.contactPhone',
          50
        ),
        faultDescription: requiredString(
          corrections.faultDescription ?? order.faultDescription,
          'corrections.faultDescription',
          5000
        )
      };
    }
    return acceptanceCorrections(order, {
      repairDate: corrections.repairDate ?? order.repairDate,
      repairerName: corrections.repairerName ?? order.repairerName,
      repairDescription: corrections.repairDescription ?? order.repairDescription,
      ...(order.type === EQUIPMENT_REPAIR_TYPES.PARTS_REPAIR
        ? { partItems: corrections.partItems ?? order.partItems }
        : {})
    }).values;
  }

  async function transitionRepair({ authContext, req, repairId, input = {} }) {
    const context = assertTeamContext(authContext);
    assertPermission(context, 'equipment.repair');
    if (!EQUIPMENT_REPAIR_ACTION_VALUES.includes(input.action) ||
        input.action === EQUIPMENT_REPAIR_ACTIONS.CREATE) {
      throw inputError('Invalid repair action');
    }
    const revision = integer(input.revision, 'revision', { min: 0 });
    const { filter } = await readFilter({
      authContext: context,
      method: 'POST',
      repairId,
      permissionKey: 'equipment.repair'
    });
    const noteRequired = [
      EQUIPMENT_REPAIR_ACTIONS.DEPUTY_APPROVE,
      EQUIPMENT_REPAIR_ACTIONS.MANAGER_APPROVE,
      EQUIPMENT_REPAIR_ACTIONS.REJECT_TO_CREATOR,
      EQUIPMENT_REPAIR_ACTIONS.REJECT_TO_PREVIOUS,
      EQUIPMENT_REPAIR_ACTIONS.VOID
    ].includes(input.action);
    const note = noteRequired
      ? requiredString(input.note, 'note', 2000)
      : optionalString(input.note, 'note', 2000);

    try {
      return await runRepairTransaction(async (session) => {
      let current = await execute(EquipmentRepairOrderModel.findOne(filter), session);
      if (current && isSubDepartmentStage(current)) {
        await lockSubDepartmentLeadership({
          OrgUnitModel,
          teamId: current.teamId,
          orgUnitIds: [current.orgUnitId],
          session
        });
      }
      if (!current) throw notFound();
      if (current.revision !== revision) {
        throw repairError(409, 'EQUIPMENT_REPAIR_CONFLICT', 'Repair order has changed; reload before retrying');
      }
      const available = await resolveAllowedActions(context, current, session);
      if (!available.includes(input.action)) {
        throw repairError(403, 'EQUIPMENT_REPAIR_ACTION_FORBIDDEN', 'Current role cannot perform this repair action');
      }
      const before = await serializeRepairWithActors(current, available, session);
      let toStatus;
      let setValues = {};
      let correctionSnapshot = null;

      if (input.action === EQUIPMENT_REPAIR_ACTIONS.RESUBMIT) {
        toStatus = initialStatus(current.type);
        setValues = returnedCorrections(current, input);
        correctionSnapshot = setValues;
        if (current.type === EQUIPMENT_REPAIR_TYPES.FAULT_REPORT &&
            Object.prototype.hasOwnProperty.call(input, 'photoAttachments')) {
          const requestedAttachments = normalizeAttachmentInput(input.photoAttachments, { required: true });
          const bound = await files.reconcileOwnerFiles({
            authContext: context,
            req,
            attachments: requestedAttachments,
            previousAttachments: current.photoAttachments,
            ownerType: FILE_OWNER_TYPES.REPAIR,
            ownerId: current._id,
            method: 'PATCH',
            allowedMimeTypes: IMAGE_MIME_TYPES,
            session
          });
          setValues.photoAttachments = bound;
          correctionSnapshot = { ...correctionSnapshot, photoAttachments: bound };
        }
      } else if (input.action === EQUIPMENT_REPAIR_ACTIONS.REJECT_TO_CREATOR) {
        toStatus = EQUIPMENT_REPAIR_STATUSES.RETURNED_TO_CREATOR;
        setValues.returnedFromStatus = current.status;
      } else if (input.action === EQUIPMENT_REPAIR_ACTIONS.REJECT_TO_PREVIOUS) {
        toStatus = previousStatus(current);
        if (!toStatus) throw repairError(409, 'EQUIPMENT_REPAIR_TRANSITION_INVALID', 'No previous stage exists');
        if (toStatus === EQUIPMENT_REPAIR_STATUSES.RETURNED_TO_CREATOR) {
          setValues.returnedFromStatus = current.status;
        }
      } else if (input.action === EQUIPMENT_REPAIR_ACTIONS.VOID) {
        toStatus = EQUIPMENT_REPAIR_STATUSES.VOIDED;
      } else {
        toStatus = nextStatusForPrimary(current, input.action);
        if (!toStatus) throw repairError(409, 'EQUIPMENT_REPAIR_TRANSITION_INVALID', 'Action does not match the current stage');
        if (current.status === EQUIPMENT_REPAIR_STATUSES.SUB_DEPARTMENT_ACCEPTANCE_PENDING) {
          const corrected = acceptanceCorrections(current, input.corrections);
          setValues = { ...setValues, ...corrected.values };
          correctionSnapshot = corrected.snapshot;
        }
        if (input.action === EQUIPMENT_REPAIR_ACTIONS.CONFIRM_PRICING) {
          if (current.type !== EQUIPMENT_REPAIR_TYPES.PARTS_REPAIR) {
            throw repairError(409, 'EQUIPMENT_REPAIR_TRANSITION_INVALID', 'Only parts repairs have pricing');
          }
          const priced = normalizePricedParts(input.partItems, current.partItems);
          setValues = { ...setValues, ...priced };
          correctionSnapshot = {
            partItems: priced.partItems,
            totalAmountCents: priced.totalAmountCents
          };
        }
      }

      const now = new Date();
      const actionLog = {
        action: input.action,
        fromStatus: current.status,
        toStatus,
        actorId: context.userId,
        actorPositionKey: actorPositionKey(context),
        note,
        corrections: correctionSnapshot,
        actedAt: now
      };
      const update = {
        $set: {
          ...setValues,
          status: toStatus,
          lastActionBy: context.userId,
          lastActionAt: now,
          ...(toStatus !== EQUIPMENT_REPAIR_STATUSES.RETURNED_TO_CREATOR
            ? { returnedFromStatus: null }
            : {})
        },
        $push: { actionLogs: actionLog },
        $inc: { revision: 1 }
      };
      const query = EquipmentRepairOrderModel.findOneAndUpdate({
        _id: current._id,
        teamId: context.activeTeamId,
        status: current.status,
        revision
      }, update, {
        new: true,
        runValidators: true
      });
      if (session) query.session(session);
      const updated = await query;
      if (!updated) {
        throw repairError(409, 'EQUIPMENT_REPAIR_CONFLICT', 'Repair order changed concurrently');
      }
      await syncCurrentStageMessages(updated, session);
      const after = await serializeRepairWithActors(
        updated,
        await resolveAllowedActions(context, updated, session),
        session
      );
      await auditService.record({
        req,
        authContext: context,
        action: auditAction(input.action),
        resourceType: AUDIT_RESOURCE_TYPES.REPAIR_ORDER,
        resourceId: updated._id,
        before,
        after,
        reason: note || null,
        targetTeamId: context.activeTeamId,
        session
      });
      return after;
      });
    } catch (error) {
      if (
        error?.code === 112 ||
        error?.codeName === 'WriteConflict' ||
        error?.errorLabels?.includes?.('TransientTransactionError')
      ) {
        throw repairError(409, 'EQUIPMENT_REPAIR_CONFLICT', 'Repair order changed concurrently');
      }
      throw error;
    }
  }

  async function exportRepairs({ authContext, req, requestedTeamId, method = 'GET', query = {} }) {
    const userFilter = queryFilters(query);
    const { teamId, filter } = await readFilter({
      authContext,
      requestedTeamId,
      method,
      userFilter,
      permissionKey: 'equipment.export'
    });
    const documents = await EquipmentRepairOrderModel.find(filter).sort({ createdAt: -1, _id: -1 }).lean();
    const typeLabels = {
      [EQUIPMENT_REPAIR_TYPES.FAULT_REPORT]: '故障报修',
      [EQUIPMENT_REPAIR_TYPES.PARTS_REPAIR]: '需更换配件维修',
      [EQUIPMENT_REPAIR_TYPES.NO_PARTS_REPAIR]: '不需换件维修'
    };
    const rows = documents.map((document) => {
      const value = serializeRepair(document);
      const row = {
        '维修单号': value._id,
        '类型': typeLabels[value.type] || value.type,
        '状态': value.status,
        '设备编码': value.equipmentSnapshot.assetCode || '',
        '设备名称': value.equipmentSnapshot.name || '',
        '部门': value.equipmentSnapshot.departmentName || '',
        '分部': value.equipmentSnapshot.orgUnitName || '',
        '报修时间': value.reportTime || '',
        '报修地点': value.reportLocation,
        '车牌号': value.plateNumber,
        '联系人': value.contactName,
        '联系电话': value.contactPhone,
        '故障描述': value.faultDescription,
        '维修日期': value.repairDate || '',
        '维修人': value.repairerName,
        '维修说明': value.repairDescription,
        '配件明细': value.partItems.map((item) => (
          `${item.name}${item.specification ? `(${item.specification})` : ''}` +
          `${item.quantity == null ? '' : ` x ${item.quantity}`}` +
          `${item.amount == null ? '' : ` = ${item.amount.toFixed(2)}元`}`
        )).join('\n'),
        '总金额（元）': value.totalAmount.toFixed(2),
        '照片数量': value.photoAttachments.length,
        '创建时间': value.createdAt || '',
        '完成时间': value.status === EQUIPMENT_REPAIR_STATUSES.COMPLETED ? value.lastActionAt : ''
      };
      return Object.fromEntries(
        Object.entries(row).map(([key, cellValue]) => [key, formulaSafe(cellValue)])
      );
    });
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(rows.length ? rows : [{ '维修单号': '' }]);
    XLSX.utils.book_append_sheet(workbook, worksheet, '维修记录');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    await auditService.record({
      req,
      authContext,
      action: AUDIT_ACTIONS.EXPORT,
      resourceType: AUDIT_RESOURCE_TYPES.REPAIR_ORDER,
      after: {
        count: rows.length,
        filters: {
          type: query.type || null,
          statuses: query.status ? String(query.status).split(',').filter(Boolean) : [],
          equipmentId: query.equipmentId
            ? normalizeId(normalizeRelatedId(query.equipmentId, 'equipmentId'))
            : null,
          orgUnitId: query.orgUnitId
            ? normalizeId(normalizeRelatedId(query.orgUnitId, 'orgUnitId'))
            : null,
          createdBy: query.createdBy
            ? normalizeId(normalizeRelatedId(query.createdBy, 'createdBy'))
            : null,
          keyword: normalizeRepairQueryKeyword(query.keyword),
          startDate: query.startDate ? requiredDate(query.startDate, 'startDate').toISOString() : null,
          endDate: query.endDate ? requiredDate(query.endDate, 'endDate').toISOString() : null
        }
      },
      targetTeamId: teamId
    });
    return buffer;
  }

  return Object.freeze({
    createRepair,
    exportRepairs,
    getRepair,
    listRepairLocations,
    listRepairs,
    syncOpenRepairMessages,
    transitionRepair,
    updateRepairLocations
  });
}

module.exports = {
  EquipmentRepairError,
  allowedActions,
  createEquipmentRepairService,
  normalizeRepairLocations,
  normalizePricedParts,
  normalizeRepairQueryKeyword,
  repairSummaryText,
  serializeRepair
};
