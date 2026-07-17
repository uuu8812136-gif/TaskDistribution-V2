'use strict';

const mongoose = require('mongoose');
const EquipmentAsset = require('../models/EquipmentAsset');
const EquipmentStatusApplication = require('../models/EquipmentStatusApplication');
const EquipmentStatusApproval = require('../models/EquipmentStatusApproval');
const FileAsset = require('../models/FileAsset');
const Message = require('../models/Message');
const OrgUnit = require('../models/OrgUnit');
const ProjectTeam = require('../models/ProjectTeam');
const TeamMembership = require('../models/TeamMembership');
const {
  AUDIT_ACTIONS,
  AUDIT_RESOURCE_TYPES,
  DATA_SCOPES,
  DATA_SCOPE_MODULES,
  FUNCTIONAL_ROLE_KEYS,
  MEMBERSHIP_STATUSES,
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

const {
  EQUIPMENT_STATUS_APPLICATION_TYPES,
  EQUIPMENT_STATUS_APPLICATION_TYPE_VALUES,
  EQUIPMENT_STATUS_APPLICATION_STATUSES,
  EQUIPMENT_STATUS_APPLICATION_STATUS_VALUES,
  EQUIPMENT_STATUS_APPLICATION_ACTIONS,
  EQUIPMENT_STATUS_APPLICATION_ACTION_VALUES
} = EquipmentStatusApplication;
const { FILE_OWNER_TYPES } = FileAsset;

const DEPUTY_POSITION_KEYS = Object.freeze([
  POSITION_KEYS.DEPARTMENT_DEPUTY_MANAGER,
  POSITION_KEYS.DEPARTMENT_MANAGER_ASSISTANT
]);
const TERMINAL_STATUSES = new Set([
  EQUIPMENT_STATUS_APPLICATION_STATUSES.APPROVED,
  EQUIPMENT_STATUS_APPLICATION_STATUSES.REJECTED,
  EQUIPMENT_STATUS_APPLICATION_STATUSES.VOIDED
]);
const REVIEW_ACTIONS = new Set([
  EQUIPMENT_STATUS_APPLICATION_ACTIONS.DEPUTY_APPROVE,
  EQUIPMENT_STATUS_APPLICATION_ACTIONS.MANAGER_APPROVE,
  EQUIPMENT_STATUS_APPLICATION_ACTIONS.RETURN_TO_CREATOR,
  EQUIPMENT_STATUS_APPLICATION_ACTIONS.REJECT
]);
const ALLOWED_ATTACHMENT_MIME_TYPES = Object.freeze([
  'image/jpeg',
  'image/png',
  'application/pdf'
]);

class EquipmentStatusApplicationError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'EquipmentStatusApplicationError';
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}

function statusError(status, code, message) {
  return new EquipmentStatusApplicationError(status, code, message);
}

function notFound() {
  return statusError(404, 'EQUIPMENT_STATUS_APPLICATION_NOT_FOUND', 'Status application does not exist');
}

function invalid(message) {
  return statusError(400, 'EQUIPMENT_STATUS_APPLICATION_INVALID', message);
}

function conflict(message = 'Status application has changed; reload before retrying') {
  return statusError(409, 'EQUIPMENT_STATUS_APPLICATION_CONFLICT', message);
}

function requiredString(value, field, maxLength) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    throw invalid(`${field} must be a non-empty string up to ${maxLength} characters`);
  }
  return value.trim();
}

function optionalString(value, field, maxLength, fallback = '') {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || value.trim().length > maxLength) {
    throw invalid(`${field} must be a string up to ${maxLength} characters`);
  }
  return value.trim();
}

function integer(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < min || normalized > max) {
    throw invalid(`${field} must be an integer between ${min} and ${max}`);
  }
  return normalized;
}

function pagination(query = {}) {
  const page = integer(query.page ?? 1, 'page', { min: 1, max: 1000000 });
  const pageSize = integer(query.pageSize ?? query.limit ?? 20, 'pageSize', { min: 1, max: 100 });
  return { page, pageSize, skip: (page - 1) * pageSize };
}

function normalizeAttachments(value, { existing = false } = {}) {
  if (value === undefined && existing) return undefined;
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 10) {
    throw invalid('attachments must be an array containing at most 10 files');
  }
  const ids = value.map((item, index) => {
    const candidate = item?.fileId || item;
    try {
      return normalizeObjectId(candidate, `attachments[${index}].fileId`);
    } catch {
      throw invalid(`attachments[${index}].fileId is invalid`);
    }
  });
  if (new Set(ids).size !== ids.length) throw invalid('attachments cannot contain duplicate files');
  return ids.map((fileId) => ({ fileId }));
}

function plain(document) {
  return document && typeof document.toObject === 'function' ? document.toObject() : document;
}

function serializeAttachment(attachment) {
  const value = plain(attachment) || {};
  return {
    fileId: normalizeId(value.fileId),
    originalName: value.originalName || '',
    mimeType: value.mimeType || '',
    size: value.size ?? null,
    uploadTime: value.uploadTime || null
  };
}

function serializeApplication(document, availableActions = []) {
  const value = plain(document);
  return {
    _id: normalizeId(value._id),
    teamId: normalizeId(value.teamId),
    orgUnitId: normalizeId(value.orgUnitId),
    equipmentId: normalizeId(value.equipmentId),
    applicationType: value.applicationType,
    sourceStatus: value.sourceStatus,
    targetStatus: value.targetStatus,
    workflowStatus: value.workflowStatus,
    reason: value.reason,
    attachments: (value.attachments || []).map(serializeAttachment),
    equipmentSnapshot: plain(value.equipmentSnapshot),
    createdBy: normalizeId(value.createdBy),
    returnedFromStatus: value.returnedFromStatus || null,
    lastActionBy: normalizeId(value.lastActionBy),
    lastActionAt: value.lastActionAt,
    submittedAt: value.submittedAt,
    finalizedAt: value.finalizedAt || null,
    revision: value.revision,
    open: value.open,
    idempotencyKey: value.idempotencyKey || null,
    availableActions: [...availableActions],
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  };
}

function serializeApproval(document) {
  const value = plain(document);
  return {
    _id: normalizeId(value._id),
    applicationId: normalizeId(value.applicationId),
    applicationRevision: value.applicationRevision,
    action: value.action,
    fromStatus: value.fromStatus || null,
    toStatus: value.toStatus,
    actorId: normalizeId(value.actorId),
    actorPositionKey: value.actorPositionKey || '',
    opinion: value.opinion || '',
    applicationSnapshot: value.applicationSnapshot,
    actedAt: value.actedAt
  };
}

function snapshot(document) {
  const value = serializeApplication(document);
  return {
    _id: value._id,
    teamId: value.teamId,
    orgUnitId: value.orgUnitId,
    equipmentId: value.equipmentId,
    applicationType: value.applicationType,
    sourceStatus: value.sourceStatus,
    targetStatus: value.targetStatus,
    workflowStatus: value.workflowStatus,
    reason: value.reason,
    attachments: value.attachments,
    equipmentSnapshot: value.equipmentSnapshot,
    createdBy: value.createdBy,
    revision: value.revision,
    open: value.open,
    submittedAt: value.submittedAt,
    finalizedAt: value.finalizedAt
  };
}

function actorPositionKey(context) {
  return context.membership?.positionKey || '';
}

function hasActiveMembership(context) {
  return Boolean(
    context.membership &&
    context.membership.status === MEMBERSHIP_STATUSES.ACTIVE &&
    sameId(context.membership.teamId, context.activeTeamId) &&
    sameId(context.membership.userId, context.userId)
  );
}

function isAssetAdmin(context) {
  return hasActiveMembership(context) &&
    context.membership.functionalRoleKeys.includes(FUNCTIONAL_ROLE_KEYS.ASSET_ADMIN) &&
    resolveModuleDataScope(context, DATA_SCOPE_MODULES.EQUIPMENT).scope === DATA_SCOPES.TEAM;
}

function isDeputyOrAssistant(context) {
  return hasActiveMembership(context) && DEPUTY_POSITION_KEYS.includes(context.membership.positionKey);
}

function isDepartmentManager(context) {
  return hasActiveMembership(context) &&
    context.membership.positionKey === POSITION_KEYS.DEPARTMENT_MANAGER;
}

function availableActions(context, application) {
  if (!context || !application || TERMINAL_STATUSES.has(application.workflowStatus)) return [];
  const actions = [];
  if (
    application.workflowStatus === EQUIPMENT_STATUS_APPLICATION_STATUSES.DEPUTY_REVIEW_PENDING &&
    isDeputyOrAssistant(context) &&
    context.permissionKeys.includes('equipment.status.approve')
  ) {
    actions.push(
      EQUIPMENT_STATUS_APPLICATION_ACTIONS.DEPUTY_APPROVE,
      EQUIPMENT_STATUS_APPLICATION_ACTIONS.RETURN_TO_CREATOR,
      EQUIPMENT_STATUS_APPLICATION_ACTIONS.REJECT
    );
  }
  if (
    application.workflowStatus === EQUIPMENT_STATUS_APPLICATION_STATUSES.MANAGER_REVIEW_PENDING &&
    isDepartmentManager(context) &&
    context.permissionKeys.includes('equipment.status.approve')
  ) {
    actions.push(
      EQUIPMENT_STATUS_APPLICATION_ACTIONS.MANAGER_APPROVE,
      EQUIPMENT_STATUS_APPLICATION_ACTIONS.RETURN_TO_CREATOR,
      EQUIPMENT_STATUS_APPLICATION_ACTIONS.REJECT
    );
  }
  if (
    sameId(context.userId, application.createdBy) &&
    isAssetAdmin(context) &&
    context.permissionKeys.includes('equipment.status.apply')
  ) {
    if (application.workflowStatus === EQUIPMENT_STATUS_APPLICATION_STATUSES.RETURNED_TO_CREATOR) {
      actions.push(EQUIPMENT_STATUS_APPLICATION_ACTIONS.RESUBMIT);
    }
    actions.push(EQUIPMENT_STATUS_APPLICATION_ACTIONS.VOID);
  }
  return [...new Set(actions)];
}

function todoFilter(context) {
  const filters = [];
  if (
    isDeputyOrAssistant(context) &&
    context.permissionKeys.includes('equipment.status.approve')
  ) {
    filters.push({
      workflowStatus: EQUIPMENT_STATUS_APPLICATION_STATUSES.DEPUTY_REVIEW_PENDING
    });
  }
  if (
    isDepartmentManager(context) &&
    context.permissionKeys.includes('equipment.status.approve')
  ) {
    filters.push({
      workflowStatus: EQUIPMENT_STATUS_APPLICATION_STATUSES.MANAGER_REVIEW_PENDING
    });
  }
  if (
    isAssetAdmin(context) &&
    context.permissionKeys.includes('equipment.status.apply')
  ) {
    filters.push({
      createdBy: context.userId,
      workflowStatus: { $nin: [...TERMINAL_STATUSES] }
    });
  }
  if (filters.length === 0) return { _id: null };
  return filters.length === 1 ? filters[0] : { $or: filters };
}

function nextWorkflowStatus(current, action) {
  const transitions = {
    [`${EQUIPMENT_STATUS_APPLICATION_STATUSES.DEPUTY_REVIEW_PENDING}:${EQUIPMENT_STATUS_APPLICATION_ACTIONS.DEPUTY_APPROVE}`]:
      EQUIPMENT_STATUS_APPLICATION_STATUSES.MANAGER_REVIEW_PENDING,
    [`${EQUIPMENT_STATUS_APPLICATION_STATUSES.MANAGER_REVIEW_PENDING}:${EQUIPMENT_STATUS_APPLICATION_ACTIONS.MANAGER_APPROVE}`]:
      EQUIPMENT_STATUS_APPLICATION_STATUSES.APPROVED,
    [`${EQUIPMENT_STATUS_APPLICATION_STATUSES.RETURNED_TO_CREATOR}:${EQUIPMENT_STATUS_APPLICATION_ACTIONS.RESUBMIT}`]:
      EQUIPMENT_STATUS_APPLICATION_STATUSES.DEPUTY_REVIEW_PENDING
  };
  if (action === EQUIPMENT_STATUS_APPLICATION_ACTIONS.RETURN_TO_CREATOR) {
    return EQUIPMENT_STATUS_APPLICATION_STATUSES.RETURNED_TO_CREATOR;
  }
  if (action === EQUIPMENT_STATUS_APPLICATION_ACTIONS.REJECT) {
    return EQUIPMENT_STATUS_APPLICATION_STATUSES.REJECTED;
  }
  if (action === EQUIPMENT_STATUS_APPLICATION_ACTIONS.VOID) {
    return EQUIPMENT_STATUS_APPLICATION_STATUSES.VOIDED;
  }
  return transitions[`${current.workflowStatus}:${action}`] || null;
}

function auditAction(action) {
  return {
    [EQUIPMENT_STATUS_APPLICATION_ACTIONS.CREATE]: AUDIT_ACTIONS.CREATE,
    [EQUIPMENT_STATUS_APPLICATION_ACTIONS.RESUBMIT]: AUDIT_ACTIONS.SUBMIT,
    [EQUIPMENT_STATUS_APPLICATION_ACTIONS.DEPUTY_APPROVE]: AUDIT_ACTIONS.APPROVE,
    [EQUIPMENT_STATUS_APPLICATION_ACTIONS.MANAGER_APPROVE]: AUDIT_ACTIONS.APPROVE,
    [EQUIPMENT_STATUS_APPLICATION_ACTIONS.RETURN_TO_CREATOR]: AUDIT_ACTIONS.RETURN,
    [EQUIPMENT_STATUS_APPLICATION_ACTIONS.REJECT]: AUDIT_ACTIONS.REJECT,
    [EQUIPMENT_STATUS_APPLICATION_ACTIONS.VOID]: AUDIT_ACTIONS.STATUS_CHANGE
  }[action];
}

function queryFilter(query = {}) {
  const filters = [];
  if (query.workflowStatus) {
    if (!EQUIPMENT_STATUS_APPLICATION_STATUS_VALUES.includes(query.workflowStatus)) {
      throw invalid('workflowStatus is invalid');
    }
    filters.push({ workflowStatus: query.workflowStatus });
  }
  if (query.applicationType) {
    if (!EQUIPMENT_STATUS_APPLICATION_TYPE_VALUES.includes(query.applicationType)) {
      throw invalid('applicationType is invalid');
    }
    filters.push({ applicationType: query.applicationType });
  }
  if (query.equipmentId) {
    filters.push({ equipmentId: normalizeObjectId(query.equipmentId, 'equipmentId') });
  }
  if (query.createdBy) {
    filters.push({ createdBy: normalizeObjectId(query.createdBy, 'createdBy') });
  }
  if (query.open === 'true' || query.open === true) filters.push({ open: true });
  if (query.open === 'false' || query.open === false) filters.push({ open: false });
  return filters.length > 1 ? { $and: filters } : filters[0] || {};
}

async function execute(query, session) {
  if (session) query.session(session);
  return query;
}

async function createOne(Model, payload, session) {
  if (!session) return Model.create(payload);
  const created = await Model.create([payload], { session });
  return created[0];
}

function createEquipmentStatusApplicationService({
  EquipmentAssetModel = EquipmentAsset,
  EquipmentStatusApplicationModel = EquipmentStatusApplication,
  EquipmentStatusApprovalModel = EquipmentStatusApproval,
  MessageModel = Message,
  OrgUnitModel = OrgUnit,
  ProjectTeamModel = ProjectTeam,
  TeamMembershipModel = TeamMembership,
  fileAssetService = null,
  auditService = createAuditService(),
  connection = mongoose.connection
} = {}) {
  const files = fileAssetService || createFileAssetService();

  function runStatusTransaction(work) {
    if (!supportsTransactions(connection)) {
      throw statusError(
        503,
        'EQUIPMENT_STATUS_TRANSACTION_REQUIRED',
        'Equipment status workflow requires a MongoDB replica set transaction'
      );
    }
    return runWithOptionalTransaction(work, connection);
  }

  async function resolveReadTeamId(authContext, requestedTeamId) {
    const context = assertBusinessContext(authContext);
    assertPermission(context, 'equipment.view');
    if (context.mode === SESSION_MODES.TEAM) return context.activeTeamId;
    if (context.mode !== SESSION_MODES.GLOBAL_READ_ONLY) throw notFound();
    const teamId = normalizeObjectId(requestedTeamId, 'teamId');
    const exists = await ProjectTeamModel.exists({ _id: teamId, status: TEAM_STATUSES.ACTIVE });
    if (!exists) throw notFound();
    return teamId;
  }

  async function readFilter({ authContext, requestedTeamId, method = 'GET', applicationId, userFilter = {} }) {
    const context = assertBusinessContext(authContext);
    assertPermission(context, 'equipment.view');
    const teamId = await resolveReadTeamId(context, requestedTeamId);
    const filter = applicationId
      ? buildScopedDetailFilter({
          authContext: context,
          moduleKey: DATA_SCOPE_MODULES.EQUIPMENT,
          id: applicationId,
          userFilter,
          globalTeamId: teamId,
          method
        })
      : buildScopedFilter({
          authContext: context,
          moduleKey: DATA_SCOPE_MODULES.EQUIPMENT,
          userFilter,
          globalTeamId: teamId,
          method
        });
    return { context, teamId, filter };
  }

  async function stageRecipientIds(application, session) {
    if (
      application.workflowStatus === EQUIPMENT_STATUS_APPLICATION_STATUSES.RETURNED_TO_CREATOR ||
      TERMINAL_STATUSES.has(application.workflowStatus)
    ) {
      return [String(application.createdBy)];
    }
    const membershipFilter = {
      teamId: application.teamId,
      status: MEMBERSHIP_STATUSES.ACTIVE
    };
    if (application.workflowStatus === EQUIPMENT_STATUS_APPLICATION_STATUSES.DEPUTY_REVIEW_PENDING) {
      membershipFilter.positionKey = { $in: DEPUTY_POSITION_KEYS };
      membershipFilter.permissionKeys = 'equipment.status.approve';
    } else if (application.workflowStatus === EQUIPMENT_STATUS_APPLICATION_STATUSES.MANAGER_REVIEW_PENDING) {
      membershipFilter.positionKey = POSITION_KEYS.DEPARTMENT_MANAGER;
      membershipFilter.permissionKeys = 'equipment.status.approve';
    } else {
      return [];
    }
    const memberships = await execute(
      TeamMembershipModel.find(membershipFilter).select('userId').lean(),
      session
    );
    return [...new Set(memberships.map((membership) => String(membership.userId)))];
  }

  async function notifyCurrentStage(application, session) {
    const recipients = await stageRecipientIds(application, session);
    if (recipients.length === 0) return;
    const typeLabel = {
      [EQUIPMENT_STATUS_APPLICATION_TYPES.IDLE]: '闲置',
      [EQUIPMENT_STATUS_APPLICATION_TYPES.STOPPED]: '停用',
      [EQUIPMENT_STATUS_APPLICATION_TYPES.SCRAPPED]: '报废'
    }[application.applicationType];
    const title = TERMINAL_STATUSES.has(application.workflowStatus)
      ? `设备${typeLabel}申请流程已更新`
      : `设备${typeLabel}申请待处理`;
    const workflowLabel = {
      [EQUIPMENT_STATUS_APPLICATION_STATUSES.DEPUTY_REVIEW_PENDING]: '待副经理或经理助理审核',
      [EQUIPMENT_STATUS_APPLICATION_STATUSES.MANAGER_REVIEW_PENDING]: '待部门经理终审',
      [EQUIPMENT_STATUS_APPLICATION_STATUSES.RETURNED_TO_CREATOR]: '已退回发起人修改',
      [EQUIPMENT_STATUS_APPLICATION_STATUSES.APPROVED]: '已通过',
      [EQUIPMENT_STATUS_APPLICATION_STATUSES.REJECTED]: '已驳回',
      [EQUIPMENT_STATUS_APPLICATION_STATUSES.VOIDED]: '已作废'
    }[application.workflowStatus];
    const content = `${application.equipmentSnapshot.assetCode} ${application.equipmentSnapshot.name}，当前状态：${workflowLabel}`;
    const messages = recipients.map((recipient) => ({
      teamId: application.teamId,
      type: 'equipment_status',
      title,
      content,
      recipient,
      sender: application.lastActionBy,
      extraData: {
        statusApplicationId: application._id,
        equipmentId: application.equipmentId,
        applicationType: application.applicationType,
        workflowStatus: application.workflowStatus
      },
      deduplicationKey: `equipment-status:${application._id}:${application.revision}:${recipient}`
    }));
    await MessageModel.insertMany(messages, { session, ordered: true });
  }

  async function appendApproval({ application, action, fromStatus, actor, opinion, req, session }) {
    const approval = await createOne(EquipmentStatusApprovalModel, {
      teamId: application.teamId,
      orgUnitId: application.orgUnitId,
      equipmentId: application.equipmentId,
      applicationId: application._id,
      applicationRevision: application.revision,
      action,
      fromStatus,
      toStatus: application.workflowStatus,
      actorId: actor.userId,
      actorPositionKey: actorPositionKey(actor),
      opinion,
      applicationSnapshot: snapshot(application),
      actedAt: application.lastActionAt
    }, session);
    await auditService.record({
      req,
      authContext: actor,
      action: auditAction(action),
      resourceType: AUDIT_RESOURCE_TYPES.EQUIPMENT_STATUS_APPROVAL,
      resourceId: approval._id,
      after: serializeApproval(approval),
      reason: opinion || null,
      targetTeamId: application.teamId,
      session
    });
    return approval;
  }

  async function listApplications({ authContext, requestedTeamId, method = 'GET', query = {} }) {
    const context = assertBusinessContext(authContext);
    const { page, pageSize, skip } = pagination(query);
    const baseFilter = queryFilter(query);
    const userFilter = query.todo === 'true' || query.todo === true
      ? { $and: [baseFilter, todoFilter(context)] }
      : baseFilter;
    const { filter } = await readFilter({
      authContext: context,
      requestedTeamId,
      method,
      userFilter
    });
    const [documents, total] = await Promise.all([
      EquipmentStatusApplicationModel.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(pageSize)
        .lean(),
      EquipmentStatusApplicationModel.countDocuments(filter)
    ]);
    let applications = documents.map((document) => (
      serializeApplication(document, availableActions(context, document))
    ));
    if (query.todo === 'true' || query.todo === true) {
      applications = applications.filter((application) => application.availableActions.length > 0);
    }
    return { applications, total, page, pageSize };
  }

  async function getApplication({ authContext, requestedTeamId, method = 'GET', applicationId }) {
    const { context, filter } = await readFilter({
      authContext,
      requestedTeamId,
      method,
      applicationId
    });
    const application = await EquipmentStatusApplicationModel.findOne(filter).lean();
    if (!application) throw notFound();
    const approvals = await EquipmentStatusApprovalModel.find({
      teamId: application.teamId,
      applicationId: application._id
    }).sort({ actedAt: 1, _id: 1 }).lean();
    return {
      application: serializeApplication(application, availableActions(context, application)),
      approvals: approvals.map(serializeApproval)
    };
  }

  async function createApplication({ authContext, req, input = {} }) {
    const context = assertTeamContext(authContext);
    assertPermission(context, 'equipment.status.apply');
    if (!isAssetAdmin(context)) {
      throw statusError(403, 'EQUIPMENT_STATUS_APPLICANT_FORBIDDEN', 'Only an active equipment administrator can create a status application');
    }
    const forbidden = ['teamId', 'orgUnitId', 'sourceStatus', 'targetStatus', 'workflowStatus', 'open', 'revision'];
    if (forbidden.some((key) => Object.prototype.hasOwnProperty.call(input, key))) {
      throw invalid('Team, organization, status snapshots, and workflow state are server controlled');
    }
    if (!EQUIPMENT_STATUS_APPLICATION_TYPE_VALUES.includes(input.applicationType)) {
      throw invalid('applicationType must be IDLE, STOPPED, or SCRAPPED');
    }
    const equipmentId = normalizeObjectId(input.equipmentId, 'equipmentId');
    const reason = requiredString(input.reason, 'reason', 5000);
    const requestedAttachments = normalizeAttachments(input.attachments);
    const idempotencyKey = optionalString(input.idempotencyKey, 'idempotencyKey', 128, null);
    const assetFilter = buildScopedDetailFilter({
      authContext: context,
      moduleKey: DATA_SCOPE_MODULES.EQUIPMENT,
      id: equipmentId,
      method: 'POST'
    });

    try {
      return await runStatusTransaction(async (session) => {
        if (idempotencyKey) {
          const existing = await execute(EquipmentStatusApplicationModel.findOne({
            teamId: context.activeTeamId,
            createdBy: context.userId,
            idempotencyKey
          }), session);
          if (existing) return serializeApplication(existing, availableActions(context, existing));
        }
        const asset = await execute(EquipmentAssetModel.findOne(assetFilter), session);
        if (!asset) throw statusError(404, 'EQUIPMENT_NOT_FOUND', 'Equipment does not exist');
        if (asset.status === EquipmentAsset.EQUIPMENT_STATUSES.SCRAPPED) {
          throw conflict('Scrapped equipment cannot enter another status application');
        }
        if (asset.status === input.applicationType) {
          throw conflict('Equipment already has the requested status');
        }
        const existingOpen = await execute(EquipmentStatusApplicationModel.exists({
          teamId: context.activeTeamId,
          equipmentId: asset._id,
          open: true
        }), session);
        if (existingOpen) throw conflict('Equipment already has an open status application');
        const orgUnit = await execute(OrgUnitModel.findOne({
          _id: asset.orgUnitId,
          teamId: context.activeTeamId
        }), session);
        if (!orgUnit) throw invalid('Equipment organization unit is invalid');
        const now = new Date();
        const application = await createOne(EquipmentStatusApplicationModel, {
          teamId: context.activeTeamId,
          orgUnitId: asset.orgUnitId,
          equipmentId: asset._id,
          applicationType: input.applicationType,
          sourceStatus: asset.status,
          targetStatus: input.applicationType,
          workflowStatus: EQUIPMENT_STATUS_APPLICATION_STATUSES.DEPUTY_REVIEW_PENDING,
          reason,
          attachments: [],
          equipmentSnapshot: {
            assetCode: asset.assetCode,
            name: asset.name,
            departmentName: context.team?.name || '',
            orgUnitName: orgUnit.name,
            location: asset.location || '',
            sourceStatus: asset.status,
            targetStatus: input.applicationType
          },
          createdBy: context.userId,
          lastActionBy: context.userId,
          lastActionAt: now,
          submittedAt: now,
          revision: 0,
          open: true,
          idempotencyKey
        }, session);
        const bound = await files.reconcileOwnerFiles({
          authContext: context,
          req,
          attachments: requestedAttachments,
          previousAttachments: [],
          ownerType: FILE_OWNER_TYPES.EQUIPMENT_STATUS_APPLICATION,
          ownerId: application._id,
          method: 'PATCH',
          allowedMimeTypes: ALLOWED_ATTACHMENT_MIME_TYPES,
          session
        });
        application.attachments = bound;
        await application.save({ session });
        const after = serializeApplication(application, availableActions(context, application));
        await auditService.record({
          req,
          authContext: context,
          action: AUDIT_ACTIONS.CREATE,
          resourceType: AUDIT_RESOURCE_TYPES.EQUIPMENT_STATUS_APPLICATION,
          resourceId: application._id,
          after,
          targetTeamId: context.activeTeamId,
          session
        });
        await appendApproval({
          application,
          action: EQUIPMENT_STATUS_APPLICATION_ACTIONS.CREATE,
          fromStatus: null,
          actor: context,
          opinion: reason,
          req,
          session
        });
        await notifyCurrentStage(application, session);
        return after;
      });
    } catch (error) {
      if (error?.code === 11000) {
        if (idempotencyKey) {
          const existing = await EquipmentStatusApplicationModel.findOne({
            teamId: context.activeTeamId,
            createdBy: context.userId,
            idempotencyKey
          });
          if (existing) return serializeApplication(existing, availableActions(context, existing));
        }
        throw conflict('Equipment already has an open status application');
      }
      throw error;
    }
  }

  async function transitionApplication({ authContext, req, applicationId, input = {} }) {
    const context = assertTeamContext(authContext);
    if (!EQUIPMENT_STATUS_APPLICATION_ACTION_VALUES.includes(input.action) ||
        input.action === EQUIPMENT_STATUS_APPLICATION_ACTIONS.CREATE) {
      throw invalid('action is invalid');
    }
    const revision = integer(input.revision, 'revision');
    const { filter } = await readFilter({
      authContext: context,
      method: 'POST',
      applicationId
    });
    const current = await EquipmentStatusApplicationModel.findOne(filter);
    if (!current) throw notFound();
    if (current.revision !== revision) throw conflict();
    const allowed = availableActions(context, current);
    if (!allowed.includes(input.action)) {
      throw statusError(403, 'EQUIPMENT_STATUS_ACTION_FORBIDDEN', 'Current role cannot perform this action');
    }
    if (REVIEW_ACTIONS.has(input.action)) {
      assertPermission(context, 'equipment.status.approve');
    } else {
      assertPermission(context, 'equipment.status.apply');
      if (!isAssetAdmin(context) || !sameId(context.userId, current.createdBy)) {
        throw statusError(403, 'EQUIPMENT_STATUS_ACTION_FORBIDDEN', 'Only the originating equipment administrator can modify this application');
      }
    }
    const opinionRequired = input.action !== EQUIPMENT_STATUS_APPLICATION_ACTIONS.RESUBMIT;
    const opinion = opinionRequired
      ? requiredString(input.opinion, 'opinion', 2000)
      : optionalString(input.opinion, 'opinion', 2000);
    const toStatus = nextWorkflowStatus(current, input.action);
    if (!toStatus) throw conflict('Action does not match the current workflow stage');

    try {
      return await runStatusTransaction(async (session) => {
        const before = serializeApplication(current, allowed);
        const now = new Date();
        const setValues = {
          workflowStatus: toStatus,
          lastActionBy: context.userId,
          lastActionAt: now,
          open: !TERMINAL_STATUSES.has(toStatus),
          finalizedAt: TERMINAL_STATUSES.has(toStatus) ? now : null
        };
        if (input.action === EQUIPMENT_STATUS_APPLICATION_ACTIONS.RETURN_TO_CREATOR) {
          setValues.returnedFromStatus = current.workflowStatus;
        } else {
          setValues.returnedFromStatus = null;
        }
        if (input.action === EQUIPMENT_STATUS_APPLICATION_ACTIONS.RESUBMIT) {
          const corrections = input.corrections;
          if (!corrections || typeof corrections !== 'object' || Array.isArray(corrections)) {
            throw invalid('corrections is required when resubmitting');
          }
          const allowedCorrectionKeys = new Set(['reason', 'attachments']);
          if (Object.keys(corrections).some((key) => !allowedCorrectionKeys.has(key))) {
            throw invalid('Only reason and attachments can be changed when resubmitting');
          }
          setValues.reason = requiredString(corrections.reason ?? current.reason, 'corrections.reason', 5000);
          setValues.submittedAt = now;
          if (Object.prototype.hasOwnProperty.call(corrections, 'attachments')) {
            const requestedAttachments = normalizeAttachments(corrections.attachments);
            setValues.attachments = await files.reconcileOwnerFiles({
              authContext: context,
              req,
              attachments: requestedAttachments,
              previousAttachments: current.attachments,
              ownerType: FILE_OWNER_TYPES.EQUIPMENT_STATUS_APPLICATION,
              ownerId: current._id,
              method: 'PATCH',
              allowedMimeTypes: ALLOWED_ATTACHMENT_MIME_TYPES,
              session
            });
          }
        }

        const updateQuery = EquipmentStatusApplicationModel.findOneAndUpdate({
          _id: current._id,
          teamId: context.activeTeamId,
          workflowStatus: current.workflowStatus,
          revision
        }, {
          $set: setValues,
          $inc: { revision: 1 }
        }, {
          new: true,
          runValidators: true
        });
        updateQuery.session(session);
        const updated = await updateQuery;
        if (!updated) throw conflict();

        let updatedAsset = null;
        if (input.action === EQUIPMENT_STATUS_APPLICATION_ACTIONS.MANAGER_APPROVE) {
          const assetQuery = EquipmentAssetModel.findOneAndUpdate({
            _id: current.equipmentId,
            teamId: context.activeTeamId,
            status: current.sourceStatus
          }, {
            $set: {
              status: current.targetStatus,
              updatedBy: context.userId
            }
          }, {
            new: true,
            runValidators: true
          });
          assetQuery.session(session);
          updatedAsset = await assetQuery;
          if (!updatedAsset) {
            throw conflict('Equipment status changed after the application was submitted');
          }
        }

        const after = serializeApplication(updated, availableActions(context, updated));
        await auditService.record({
          req,
          authContext: context,
          action: auditAction(input.action),
          resourceType: AUDIT_RESOURCE_TYPES.EQUIPMENT_STATUS_APPLICATION,
          resourceId: updated._id,
          before,
          after,
          reason: opinion || null,
          targetTeamId: context.activeTeamId,
          session
        });
        await appendApproval({
          application: updated,
          action: input.action,
          fromStatus: current.workflowStatus,
          actor: context,
          opinion,
          req,
          session
        });
        if (updatedAsset) {
          await auditService.record({
            req,
            authContext: context,
            action: AUDIT_ACTIONS.STATUS_CHANGE,
            resourceType: AUDIT_RESOURCE_TYPES.EQUIPMENT_ASSET,
            resourceId: updatedAsset._id,
            before: { status: current.sourceStatus },
            after: { status: updatedAsset.status },
            reason: `Approved status application ${updated._id}: ${updated.reason}`,
            targetTeamId: context.activeTeamId,
            session
          });
        }
        await notifyCurrentStage(updated, session);
        return after;
      });
    } catch (error) {
      if (
        error?.code === 112 ||
        error?.codeName === 'WriteConflict' ||
        error?.errorLabels?.includes?.('TransientTransactionError')
      ) {
        throw conflict();
      }
      throw error;
    }
  }

  return Object.freeze({
    createApplication,
    getApplication,
    listApplications,
    transitionApplication
  });
}

module.exports = {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  EquipmentStatusApplicationError,
  availableActions,
  createEquipmentStatusApplicationService,
  serializeApplication,
  serializeApproval
};
