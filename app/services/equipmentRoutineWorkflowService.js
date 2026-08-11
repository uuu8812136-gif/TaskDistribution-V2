'use strict';

const mongoose = require('mongoose');
const XLSX = require('xlsx');
const EquipmentAsset = require('../models/EquipmentAsset');
const EquipmentRoutineException = require('../models/EquipmentRoutineException');
const EquipmentRoutinePlan = require('../models/EquipmentRoutinePlan');
const EquipmentRoutineRecord = require('../models/EquipmentRoutineRecord');
const Message = require('../models/Message');
const OrgUnit = require('../models/OrgUnit');
const ProjectTeam = require('../models/ProjectTeam');
const TeamMembership = require('../models/TeamMembership');
const User = require('../models/User');
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
const {
  normalizeObjectId,
  resolveScopedOrgUnitIds
} = require('./scopedQueryService');
const {
  assertBusinessContext,
  assertPermission,
  assertTeamContext,
  resolveModuleDataScope
} = require('./teamContextService');
const {
  runWithOptionalTransaction,
  supportsTransactions
} = require('./transactionService');
const { EquipmentRegistryError } = require('./equipmentRegistryService');
const {
  actingSubDepartmentLeaderPositionKeys,
  canMembershipActAsSubDepartmentLeader,
  leadershipOrgUnitIds,
  lockSubDepartmentLeadership,
  subDepartmentOrgUnitIds
} = require('./subDepartmentLeadershipService');

const {
  EQUIPMENT_ROUTINE_EXCEPTION_ACTIONS,
  EQUIPMENT_ROUTINE_EXCEPTION_ACTION_VALUES,
  EQUIPMENT_ROUTINE_EXCEPTION_STAGES,
  EQUIPMENT_ROUTINE_EXCEPTION_STAGE_VALUES,
  EQUIPMENT_ROUTINE_EXCEPTION_STATUSES,
  EQUIPMENT_ROUTINE_EXCEPTION_STATUS_VALUES
} = EquipmentRoutineException;
const {
  EQUIPMENT_ROUTINE_PLAN_STATUSES,
  EQUIPMENT_ROUTINE_PLAN_STATUS_VALUES,
  EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS,
  effectiveRoutinePlanStatus,
  isRoutinePlanCurrentBusinessDate,
  isRoutinePlanRestDayEligible,
  routinePlanCancellationReason,
  routinePlanCancellationReasonLabel,
  routinePlanWindowName
} = EquipmentRoutinePlan;

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 200;

const RECIPIENT_GROUPS = Object.freeze({
  EXECUTORS_AND_SUB_DEPARTMENT_MANAGER: 'EXECUTORS_AND_SUB_DEPARTMENT_MANAGER',
  ASSET_ADMIN_AND_DEPARTMENT_MANAGER: 'ASSET_ADMIN_AND_DEPARTMENT_MANAGER',
  TEAM_LEADER: 'TEAM_LEADER',
  SUB_DEPARTMENT_MANAGER: 'SUB_DEPARTMENT_MANAGER',
  ASSET_ADMIN: 'ASSET_ADMIN',
  DEPUTY_ASSISTANT_AND_MANAGER: 'DEPUTY_ASSISTANT_AND_MANAGER'
});

function workflowError(status, code, message) {
  return new EquipmentRegistryError(status, code, message);
}

function inputInvalid(message) {
  return workflowError(400, 'EQUIPMENT_ROUTINE_WORKFLOW_INPUT_INVALID', message);
}

function notFound() {
  return workflowError(404, 'EQUIPMENT_ROUTINE_WORKFLOW_NOT_FOUND', 'Routine workflow item does not exist');
}

function plain(value) {
  return typeof value?.toObject === 'function'
    ? value.toObject({ depopulate: true, versionKey: false })
    : value;
}

function assertOnlyKeys(value, allowed, field = 'input') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw inputInvalid(`${field} must be an object`);
  }
  const accepted = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !accepted.has(key));
  if (unknown) throw inputInvalid(`${field}.${unknown} is not supported`);
}

function requiredString(value, field, max) {
  if (typeof value !== 'string' || !value.trim()) throw inputInvalid(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max) throw inputInvalid(`${field} is too long`);
  return normalized;
}

function optionalString(value, field, max) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw inputInvalid(`${field} must be a string`);
  const normalized = value.trim();
  if (normalized.length > max) throw inputInvalid(`${field} is too long`);
  return normalized;
}

function integer(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback = null } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(normalized) || normalized < min || normalized > max) {
    throw inputInvalid(`${field} must be an integer between ${min} and ${max}`);
  }
  return normalized;
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

function normalizeDate(value, field) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw inputInvalid(`${field} must be a valid date`);
  return date;
}

function normalizeRelatedId(value) {
  try {
    return normalizeObjectId(value, 'id');
  } catch {
    throw notFound();
  }
}

function serializePlan(document, now = new Date()) {
  const value = plain(document);
  const cancellationReason = routinePlanCancellationReason(value);
  const rematerializationHistory = (value.rematerializationHistory || []).map((event) => ({
    cancellationReason: event.cancellationReason,
    cancelledAt: event.cancelledAt || null,
    cancelledBy: normalizeId(event.cancelledBy),
    rematerializedAt: event.rematerializedAt,
    rematerializedBy: normalizeId(event.rematerializedBy),
    source: event.source
  }));
  return {
    _id: normalizeId(value._id),
    teamId: normalizeId(value.teamId),
    orgUnitId: normalizeId(value.orgUnitId),
    equipmentId: normalizeId(value.equipmentId),
    categoryId: normalizeId(value.categoryId),
    ruleId: normalizeId(value.ruleId),
    ruleVersion: value.ruleVersion,
    routineType: value.routineType,
    cycleKey: value.cycleKey,
    windowKey: value.windowKey,
    windowName: routinePlanWindowName(value),
    originalWindowName: value.windowName,
    scheduledFor: value.scheduledFor,
    dueAt: value.dueAt,
    status: effectiveRoutinePlanStatus(value, now),
    completedRecordId: normalizeId(value.completedRecordId),
    completedAt: value.completedAt || null,
    completedBy: normalizeId(value.completedBy),
    cancellationReason,
    cancellationReasonLabel: routinePlanCancellationReasonLabel(value),
    cancelledAt: value.cancelledAt || null,
    cancelledBy: normalizeId(value.cancelledBy),
    rematerializationCount: Number(value.rematerializationCount || 0),
    rematerializationHistory,
    restDayEligible: isRoutinePlanRestDayEligible(value, now),
    ruleSnapshot: value.ruleSnapshot,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  };
}

function serializeException(document) {
  const value = plain(document);
  return {
    _id: normalizeId(value._id),
    teamId: normalizeId(value.teamId),
    orgUnitId: normalizeId(value.orgUnitId),
    equipmentId: normalizeId(value.equipmentId),
    recordId: normalizeId(value.recordId),
    routineType: value.routineType,
    status: value.status,
    currentStage: value.currentStage,
    summary: value.summary,
    history: (value.history || []).map((item) => ({
      stage: item.stage,
      action: item.action,
      opinion: item.opinion || '',
      actorId: normalizeId(item.actorId),
      actorPositionKey: item.actorPositionKey || '',
      actedAt: item.actedAt
    })),
    resolvedAt: value.resolvedAt || null,
    resolvedBy: normalizeId(value.resolvedBy),
    revision: value.revision,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  };
}

function formulaSafe(value) {
  if (typeof value !== 'string') return value;
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

function modelQuery(query, session) {
  if (session && typeof query.session === 'function') query.session(session);
  return query;
}

async function organizationScopeIds({ OrgUnitModel, teamId, orgUnitId, session = null }) {
  const target = await modelQuery(OrgUnitModel.findOne({ _id: orgUnitId, teamId }).lean(), session);
  if (!target) return { ancestorsAndSelf: [orgUnitId], descendantsAndSelf: [orgUnitId] };
  const ancestors = String(target.path || '/')
    .split('/')
    .filter((value) => mongoose.isValidObjectId(value))
    .map((value) => new mongoose.Types.ObjectId(value));
  const descendantQuery = OrgUnitModel.find({
    teamId,
    $or: [
      { _id: target._id },
      { path: { $regex: `/${String(target._id)}/` } }
    ]
  }).select('_id').lean();
  const descendants = await modelQuery(descendantQuery, session);
  return {
    ancestorsAndSelf: [...ancestors, target._id],
    descendantsAndSelf: descendants.map(({ _id }) => _id)
  };
}

async function recipientUserIds({
  TeamMembershipModel = TeamMembership,
  OrgUnitModel = OrgUnit,
  UserModel = User,
  teamId,
  orgUnitId,
  group,
  session = null
}) {
  if (!Object.values(RECIPIENT_GROUPS).includes(group)) {
    throw new TypeError('Unsupported routine recipient group');
  }
  const { ancestorsAndSelf, descendantsAndSelf } = await organizationScopeIds({
    OrgUnitModel,
    teamId,
    orgUnitId,
    session
  });
  const needsSubDepartmentLeader = [
    RECIPIENT_GROUPS.EXECUTORS_AND_SUB_DEPARTMENT_MANAGER,
    RECIPIENT_GROUPS.SUB_DEPARTMENT_MANAGER
  ].includes(group);
  const subDepartmentIds = needsSubDepartmentLeader
    ? await subDepartmentOrgUnitIds({
        OrgUnitModel,
        teamId,
        orgUnitId,
        session
      })
    : [];
  const subDepartmentLeaderPositionKeys = needsSubDepartmentLeader
    ? await actingSubDepartmentLeaderPositionKeys({
        TeamMembershipModel,
        OrgUnitModel,
        teamId,
        orgUnitIds: subDepartmentIds,
        session
      })
    : [];
  const leadershipOrgUnitScope = needsSubDepartmentLeader
    ? await leadershipOrgUnitIds({
        OrgUnitModel,
        teamId,
        orgUnitIds: subDepartmentIds,
        session
      })
    : [];
  const clauses = [];
  if (group === RECIPIENT_GROUPS.EXECUTORS_AND_SUB_DEPARTMENT_MANAGER) {
    clauses.push({
      positionKey: POSITION_KEYS.EMPLOYEE,
      orgUnitId: { $in: descendantsAndSelf }
    });
    clauses.push({
      positionKey: { $in: subDepartmentLeaderPositionKeys },
      orgUnitId: { $in: leadershipOrgUnitScope }
    });
  } else if (group === RECIPIENT_GROUPS.ASSET_ADMIN_AND_DEPARTMENT_MANAGER) {
    clauses.push({ functionalRoleKeys: FUNCTIONAL_ROLE_KEYS.ASSET_ADMIN });
    clauses.push({ positionKey: POSITION_KEYS.DEPARTMENT_MANAGER });
  } else if (group === RECIPIENT_GROUPS.TEAM_LEADER) {
    clauses.push({
      positionKey: POSITION_KEYS.TEAM_LEADER,
      orgUnitId: { $in: [...ancestorsAndSelf, ...descendantsAndSelf] }
    });
  } else if (group === RECIPIENT_GROUPS.SUB_DEPARTMENT_MANAGER) {
    clauses.push({
      positionKey: { $in: subDepartmentLeaderPositionKeys },
      orgUnitId: { $in: leadershipOrgUnitScope }
    });
  } else if (group === RECIPIENT_GROUPS.ASSET_ADMIN) {
    clauses.push({ functionalRoleKeys: FUNCTIONAL_ROLE_KEYS.ASSET_ADMIN });
  } else if (group === RECIPIENT_GROUPS.DEPUTY_ASSISTANT_AND_MANAGER) {
    clauses.push({
      positionKey: {
        $in: [
          POSITION_KEYS.DEPARTMENT_DEPUTY_MANAGER,
          POSITION_KEYS.DEPARTMENT_MANAGER_ASSISTANT,
          POSITION_KEYS.DEPARTMENT_MANAGER
        ]
      }
    });
  }
  const membershipQuery = TeamMembershipModel.find({
    teamId,
    status: MEMBERSHIP_STATUSES.ACTIVE,
    $or: clauses
  }).select('userId').lean();
  const memberships = await modelQuery(membershipQuery, session);
  const userIds = [...new Set(memberships.map(({ userId }) => normalizeId(userId)).filter(Boolean))];
  if (userIds.length === 0) return [];
  const userQuery = UserModel.find({ _id: { $in: userIds }, status: 'active' }).select('_id').lean();
  const users = await modelQuery(userQuery, session);
  return users.map(({ _id }) => normalizeId(_id));
}

async function upsertRoutineMessage({ MessageModel = Message, payload, session = null }) {
  const options = { upsert: true, setDefaultsOnInsert: true };
  if (session) options.session = session;
  return MessageModel.updateOne({
    teamId: payload.teamId,
    recipient: payload.recipient,
    deduplicationKey: payload.deduplicationKey
  }, {
    $setOnInsert: payload
  }, options);
}

function exceptionRecipientGroup(stage) {
  if (stage === EQUIPMENT_ROUTINE_EXCEPTION_STAGES.TEAM_LEADER) {
    return RECIPIENT_GROUPS.TEAM_LEADER;
  }
  if (stage === EQUIPMENT_ROUTINE_EXCEPTION_STAGES.SUB_DEPARTMENT_MANAGER) {
    return RECIPIENT_GROUPS.SUB_DEPARTMENT_MANAGER;
  }
  if (stage === EQUIPMENT_ROUTINE_EXCEPTION_STAGES.ASSET_ADMIN) {
    return RECIPIENT_GROUPS.ASSET_ADMIN;
  }
  return null;
}

function nextExceptionStage(stage) {
  if (stage === EQUIPMENT_ROUTINE_EXCEPTION_STAGES.TEAM_LEADER) {
    return EQUIPMENT_ROUTINE_EXCEPTION_STAGES.SUB_DEPARTMENT_MANAGER;
  }
  if (stage === EQUIPMENT_ROUTINE_EXCEPTION_STAGES.SUB_DEPARTMENT_MANAGER) {
    return EQUIPMENT_ROUTINE_EXCEPTION_STAGES.ASSET_ADMIN;
  }
  return null;
}

function exceptionAuditResource(routineType) {
  return routineType === 'INSPECTION'
    ? AUDIT_RESOURCE_TYPES.INSPECTION_EXCEPTION
    : AUDIT_RESOURCE_TYPES.MAINTENANCE_EXCEPTION;
}

function recordExportAuditResource(requestedRoutineType, routineTypes) {
  const distinctTypes = [...new Set(routineTypes.filter(Boolean))];
  const effectiveType = requestedRoutineType || (distinctTypes.length === 1 ? distinctTypes[0] : null);
  if (effectiveType === 'INSPECTION') return AUDIT_RESOURCE_TYPES.INSPECTION_RECORD;
  if (effectiveType === 'MAINTENANCE') return AUDIT_RESOURCE_TYPES.MAINTENANCE_RECORD;
  return AUDIT_RESOURCE_TYPES.SYSTEM;
}

function createEquipmentRoutineWorkflowService({
  EquipmentAssetModel = EquipmentAsset,
  EquipmentRoutineExceptionModel = EquipmentRoutineException,
  EquipmentRoutinePlanModel = EquipmentRoutinePlan,
  EquipmentRoutineRecordModel = EquipmentRoutineRecord,
  MessageModel = Message,
  OrgUnitModel = OrgUnit,
  ProjectTeamModel = ProjectTeam,
  TeamMembershipModel = TeamMembership,
  UserModel = User,
  auditService = createAuditService(),
  connection = mongoose.connection,
  clock = () => new Date()
} = {}) {
  function runWorkflowTransaction(work) {
    if (!supportsTransactions(connection)) {
      throw workflowError(
        503,
        'EQUIPMENT_ROUTINE_TRANSACTIONS_REQUIRED',
        'Routine workflow writes require MongoDB replica-set transaction support'
      );
    }
    return runWithOptionalTransaction(work, connection);
  }

  async function resolveReadTeamId(authContext, requestedTeamId) {
    const context = assertBusinessContext(authContext);
    if (context.mode === SESSION_MODES.TEAM) return normalizeObjectId(context.activeTeamId, 'activeTeamId');
    if (context.mode !== SESSION_MODES.GLOBAL_READ_ONLY) {
      throw workflowError(403, 'EQUIPMENT_TEAM_CONTEXT_REQUIRED', 'Select a team first');
    }
    let teamId;
    try {
      teamId = normalizeObjectId(requestedTeamId, 'teamId');
    } catch {
      throw inputInvalid('A valid teamId is required in global read-only mode');
    }
    const exists = await ProjectTeamModel.exists({ _id: teamId, status: TEAM_STATUSES.ACTIVE });
    if (!exists) throw notFound();
    return teamId;
  }

  async function exceptionAccessPolicy({
    authContext,
    exception,
    session = null,
    recipientCache = null
  }) {
    const context = assertBusinessContext(authContext);
    const value = plain(exception);
    if (
      context.mode !== SESSION_MODES.TEAM ||
      context.readOnly === true ||
      value.status !== EQUIPMENT_ROUTINE_EXCEPTION_STATUSES.OPEN
    ) {
      return Object.freeze({ canHandle: false });
    }
    const group = exceptionRecipientGroup(value.currentStage);
    if (!group) return Object.freeze({ canHandle: false });
    const cacheKey = [
      normalizeId(value.teamId),
      normalizeId(value.orgUnitId),
      group
    ].join(':');
    let recipientsPromise = recipientCache?.get(cacheKey);
    if (!recipientsPromise) {
      recipientsPromise = recipientUserIds({
        TeamMembershipModel,
        OrgUnitModel,
        UserModel,
        teamId: value.teamId,
        orgUnitId: value.orgUnitId,
        group,
        session
      });
      recipientCache?.set(cacheKey, recipientsPromise);
    }
    const recipients = await recipientsPromise;
    return Object.freeze({
      canHandle: recipients.includes(normalizeId(context.userId))
    });
  }

  async function serializeExceptionForContext(
    document,
    authContext,
    { session = null, recipientCache = null } = {}
  ) {
    return {
      ...serializeException(document),
      accessPolicy: await exceptionAccessPolicy({
        authContext,
        exception: document,
        session,
        recipientCache
      })
    };
  }

  async function notifyExceptionStage(exceptionDocument, session = null) {
    const exception = plain(exceptionDocument);
    const group = exceptionRecipientGroup(exception.currentStage);
    if (!group) return [];
    const recipients = await recipientUserIds({
      TeamMembershipModel,
      OrgUnitModel,
      UserModel,
      teamId: exception.teamId,
      orgUnitId: exception.orgUnitId,
      group,
      session
    });
    for (const recipient of recipients) {
      await upsertRoutineMessage({
        MessageModel,
        session,
        payload: {
          teamId: exception.teamId,
          type: 'system',
          title: '设备例行异常待处理',
          content: exception.summary,
          recipient,
          deduplicationKey: `routine-exception:${exception._id}:revision:${exception.revision}:stage:${exception.currentStage}`,
          extraData: {
            resourceType: 'EQUIPMENT_ROUTINE_EXCEPTION',
            exceptionId: normalizeId(exception._id),
            equipmentId: normalizeId(exception.equipmentId),
            currentStage: exception.currentStage,
            page: '/pages/equipment/routine-exception'
          }
        }
      });
    }
    return recipients;
  }

  async function createExceptionForRecord({
    record,
    asset,
    actorId,
    actorPositionKey = '',
    summary,
    session
  }) {
    const now = clock();
    const payload = {
      teamId: record.teamId,
      orgUnitId: asset.orgUnitId,
      equipmentId: asset._id,
      recordId: record._id,
      routineType: record.routineType,
      status: EQUIPMENT_ROUTINE_EXCEPTION_STATUSES.OPEN,
      currentStage: EQUIPMENT_ROUTINE_EXCEPTION_STAGES.TEAM_LEADER,
      summary: summary || '设备例行执行发现异常，请及时处理。',
      history: [{
        stage: EQUIPMENT_ROUTINE_EXCEPTION_STAGES.TEAM_LEADER,
        action: EQUIPMENT_ROUTINE_EXCEPTION_ACTIONS.SUBMITTED,
        opinion: summary || '',
        actorId,
        actorPositionKey,
        actedAt: now
      }],
      revision: 0
    };
    let exception;
    try {
      const created = await EquipmentRoutineExceptionModel.create([payload], { session });
      exception = created[0];
    } catch (error) {
      if (error?.code !== 11000) throw error;
      exception = await modelQuery(EquipmentRoutineExceptionModel.findOne({
        teamId: record.teamId,
        recordId: record._id
      }), session);
    }
    await notifyExceptionStage(exception, session);
    return exception;
  }

  async function readFilter({ authContext, teamId, method, userFilter = {}, id = null }) {
    const context = assertBusinessContext(authContext);
    if (context.mode === SESSION_MODES.GLOBAL_READ_ONLY && method !== 'GET') {
      throw workflowError(403, 'EQUIPMENT_ROUTINE_READ_ONLY', 'Global mode is read-only');
    }
    const scopeFilter = { teamId };
    if (context.mode === SESSION_MODES.TEAM) {
      const dataScope = resolveModuleDataScope(context, DATA_SCOPE_MODULES.EQUIPMENT);
      if (dataScope.scope === DATA_SCOPES.ORG_UNIT) {
        if (
          Array.isArray(context.equipmentOrgUnitScopeIds) &&
          context.equipmentOrgUnitScopeIds.length > 0
        ) {
          scopeFilter.orgUnitId = { $in: [...resolveScopedOrgUnitIds(dataScope)] };
        } else {
          const scope = await organizationScopeIds({
            OrgUnitModel,
            teamId,
            orgUnitId: dataScope.orgUnitId
          });
          scopeFilter.orgUnitId = { $in: scope.descendantsAndSelf };
        }
      }
    }
    if (id) scopeFilter._id = id;
    return { $and: [scopeFilter, userFilter] };
  }

  async function actingLeadershipScope(context, teamId, session = null) {
    if (
      context.mode !== SESSION_MODES.TEAM ||
      ![
        POSITION_KEYS.SUB_DEPARTMENT_MANAGER,
        POSITION_KEYS.SUB_DEPARTMENT_DEPUTY_MANAGER,
        POSITION_KEYS.SUPERVISOR
      ].includes(context.membership?.positionKey)
    ) {
      return [];
    }
    const subDepartmentIds = await subDepartmentOrgUnitIds({
      OrgUnitModel,
      teamId,
      orgUnitId: context.membership.orgUnitId,
      session
    });
    if (!(await canMembershipActAsSubDepartmentLeader({
      TeamMembershipModel,
      OrgUnitModel,
      membership: context.membership,
      teamId,
      orgUnitIds: subDepartmentIds,
      session
    }))) {
      return [];
    }
    return leadershipOrgUnitIds({
      OrgUnitModel,
      teamId,
      orgUnitIds: subDepartmentIds,
      session
    });
  }

  function rangeFilter(query, field) {
    const from = normalizeDate(query.from, 'from');
    const to = normalizeDate(query.to, 'to');
    if (from && to && from > to) throw inputInvalid('from must be on or before to');
    if (!from && !to) return {};
    return { [field]: { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } };
  }

  async function enrichRows(documents, {
    includeException = false,
    includePlan = false,
    includePerformer = false
  } = {}) {
    const teamIds = [...new Set(documents.map(({ teamId }) => normalizeId(teamId)).filter(Boolean))];
    const equipmentIds = [...new Set(documents.map(({ equipmentId }) => normalizeId(equipmentId)).filter(Boolean))];
    const orgUnitIds = [...new Set(documents.map(({ orgUnitId }) => normalizeId(orgUnitId)).filter(Boolean))];
    const planIds = [...new Set(documents.map(({ planId }) => normalizeId(planId)).filter(Boolean))];
    const performerIds = [...new Set(documents.map(({ performedBy }) => normalizeId(performedBy)).filter(Boolean))];
    const [assets, orgUnits, plans, performers, exceptions] = await Promise.all([
      EquipmentAssetModel.find({
        _id: { $in: equipmentIds },
        teamId: { $in: teamIds }
      }).select('_id assetCode name location plateNumber').lean(),
      OrgUnitModel.find({
        _id: { $in: orgUnitIds },
        teamId: { $in: teamIds }
      }).select('_id name').lean(),
      includePlan
        ? EquipmentRoutinePlanModel.find({
          _id: { $in: planIds },
          teamId: { $in: teamIds }
        })
          .select('_id cycleKey windowKey windowName scheduledFor dueAt status')
          .lean()
        : [],
      includePerformer
        ? UserModel.find({ _id: { $in: performerIds } }).select('_id name username').lean()
        : [],
      includeException
        ? EquipmentRoutineExceptionModel.find({
          recordId: { $in: documents.map(({ _id }) => _id) },
          teamId: { $in: teamIds }
        }).lean()
        : []
    ]);
    const assetById = new Map(assets.map((item) => [normalizeId(item._id), item]));
    const orgById = new Map(orgUnits.map((item) => [normalizeId(item._id), item]));
    const planById = new Map(plans.map((item) => [normalizeId(item._id), item]));
    const performerById = new Map(performers.map((item) => [normalizeId(item._id), item]));
    const exceptionByRecord = new Map(exceptions.map((item) => [normalizeId(item.recordId), item]));
    return documents.map((document) => {
      const value = plain(document);
      return {
        ...value,
        equipment: assetById.get(normalizeId(value.equipmentId)) || null,
        orgUnit: orgById.get(normalizeId(value.orgUnitId)) || null,
        plan: planById.get(normalizeId(value.planId)) || null,
        performedByUser: performerById.get(normalizeId(value.performedBy)) || null,
        exception: exceptionByRecord.get(normalizeId(value._id)) || null
      };
    });
  }

  async function listPlans({ authContext, requestedTeamId, method = 'GET', query = {} }) {
    assertOnlyKeys(query, [
      'teamId', 'page', 'pageSize', 'routineType', 'status', 'equipmentId', 'orgUnitId', 'from', 'to'
    ], 'query');
    assertPermission(authContext, 'equipment.view');
    const teamId = await resolveReadTeamId(authContext, requestedTeamId);
    const now = clock();
    const userFilter = { ...rangeFilter(query, 'dueAt') };
    if (query.routineType) userFilter.routineType = requiredString(query.routineType, 'routineType', 50);
    if (query.status) {
      if (!EQUIPMENT_ROUTINE_PLAN_STATUS_VALUES.includes(query.status)) throw inputInvalid('status is invalid');
      if (query.status === EQUIPMENT_ROUTINE_PLAN_STATUSES.PLANNED) {
        userFilter.$and = [
          { status: { $in: [
            EQUIPMENT_ROUTINE_PLAN_STATUSES.PLANNED,
            EQUIPMENT_ROUTINE_PLAN_STATUSES.IN_WINDOW,
            EQUIPMENT_ROUTINE_PLAN_STATUSES.OVERDUE
          ] } },
          { scheduledFor: { $gt: now } }
        ];
      } else if (query.status === EQUIPMENT_ROUTINE_PLAN_STATUSES.IN_WINDOW) {
        userFilter.$and = [
          { status: { $in: [
            EQUIPMENT_ROUTINE_PLAN_STATUSES.PLANNED,
            EQUIPMENT_ROUTINE_PLAN_STATUSES.IN_WINDOW,
            EQUIPMENT_ROUTINE_PLAN_STATUSES.OVERDUE
          ] } },
          { scheduledFor: { $lte: now } },
          { dueAt: { $gte: now } }
        ];
      } else if (query.status === EQUIPMENT_ROUTINE_PLAN_STATUSES.OVERDUE) {
        userFilter.$and = [
          { status: { $in: [
            EQUIPMENT_ROUTINE_PLAN_STATUSES.PLANNED,
            EQUIPMENT_ROUTINE_PLAN_STATUSES.IN_WINDOW,
            EQUIPMENT_ROUTINE_PLAN_STATUSES.OVERDUE
          ] } },
          { dueAt: { $lt: now } }
        ];
      } else {
        userFilter.status = query.status;
      }
    }
    if (query.equipmentId) userFilter.equipmentId = normalizeRelatedId(query.equipmentId);
    if (query.orgUnitId) userFilter.orgUnitId = normalizeRelatedId(query.orgUnitId);
    const filter = await readFilter({ authContext, teamId, method, userFilter });
    const { page, pageSize, skip } = pagination(query);
    const [documents, total] = await Promise.all([
      EquipmentRoutinePlanModel.find(filter).sort({ dueAt: -1, _id: -1 }).skip(skip).limit(pageSize).lean(),
      EquipmentRoutinePlanModel.countDocuments(filter)
    ]);
    const enriched = await enrichRows(documents);
    return { plans: enriched.map((value) => ({
      ...serializePlan(value, now),
      equipment: value.equipment,
      orgUnit: value.orgUnit
    })), total, page, pageSize };
  }

  async function getPlan({ authContext, requestedTeamId, method = 'GET', planId, query = {} }) {
    assertOnlyKeys(query, ['teamId'], 'query');
    assertPermission(authContext, 'equipment.view');
    const teamId = await resolveReadTeamId(authContext, requestedTeamId);
    const filter = await readFilter({
      authContext,
      teamId,
      method,
      id: normalizeRelatedId(planId)
    });
    const document = await EquipmentRoutinePlanModel.findOne(filter).lean();
    if (!document) throw notFound();
    const [enriched] = await enrichRows([document]);
    return {
      ...serializePlan(enriched, clock()),
      equipment: enriched.equipment,
      orgUnit: enriched.orgUnit
    };
  }

  async function markPlansRestDay({ authContext, req, input = {} }) {
    assertOnlyKeys(input, ['planIds', 'reason']);
    const context = assertTeamContext(authContext);
    assertPermission(context, 'equipment.inspect');
    if (!Array.isArray(input.planIds) || input.planIds.length < 1 || input.planIds.length > 200) {
      throw inputInvalid('planIds must contain between 1 and 200 plan ids');
    }
    const planIds = input.planIds.map((planId, index) => {
      try {
        return normalizeObjectId(planId, `planIds[${index}]`);
      } catch {
        throw inputInvalid(`planIds[${index}] must be a valid ObjectId`);
      }
    });
    const uniqueIds = [...new Map(planIds.map((planId) => [String(planId), planId])).values()];
    if (uniqueIds.length !== planIds.length) throw inputInvalid('planIds must be unique');
    const reason = optionalString(input.reason, 'reason', 500) || '本日休班，设备不需点检';

    try {
      return await runWorkflowTransaction(async (session) => {
        const now = clock();
        const filter = await readFilter({
          authContext: context,
          teamId: normalizeObjectId(context.activeTeamId, 'activeTeamId'),
          method: 'POST',
          userFilter: { _id: { $in: uniqueIds } }
        });
        const plans = await modelQuery(
          EquipmentRoutinePlanModel.find(filter).sort({ scheduledFor: 1, dueAt: 1, _id: 1 }),
          session
        );
        if (plans.length !== uniqueIds.length) throw notFound();

        for (const plan of plans) {
          if (plan.routineType !== 'INSPECTION') {
            throw workflowError(
              409,
              'EQUIPMENT_ROUTINE_REST_DAY_INSPECTION_ONLY',
              'Only inspection plans can be marked as an equipment rest day'
            );
          }
          if (!isRoutinePlanCurrentBusinessDate(plan, now)) {
            throw workflowError(
              409,
              'EQUIPMENT_ROUTINE_REST_DAY_CURRENT_DATE_ONLY',
              'Only inspection plans for the current business date can be marked as a rest day'
            );
          }
          const alreadyCancelled = (
            plan.status === EQUIPMENT_ROUTINE_PLAN_STATUSES.CANCELLED &&
            plan.cancellationReason === EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS.REST_DAY
          );
          if (!alreadyCancelled && !isRoutinePlanRestDayEligible(plan, now)) {
            throw workflowError(
              409,
              'EQUIPMENT_ROUTINE_PLAN_NOT_OPEN',
              'Only open inspection plans can be marked as a rest day'
            );
          }
        }

        let cancelledCount = 0;
        let alreadyCancelledCount = 0;
        const responseById = new Map();
        for (const plan of plans) {
          if (
            plan.status === EQUIPMENT_ROUTINE_PLAN_STATUSES.CANCELLED &&
            plan.cancellationReason === EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS.REST_DAY
          ) {
            alreadyCancelledCount += 1;
            responseById.set(String(plan._id), serializePlan(plan, now));
            continue;
          }
          const before = serializePlan(plan, now);
          plan.status = EQUIPMENT_ROUTINE_PLAN_STATUSES.CANCELLED;
          plan.cancellationReason = EQUIPMENT_ROUTINE_PLAN_CANCELLATION_REASONS.REST_DAY;
          plan.cancelledAt = now;
          plan.cancelledBy = context.userId;
          await plan.save({ session });
          const after = serializePlan(plan, now);
          await auditService.record({
            req,
            authContext: context,
            action: AUDIT_ACTIONS.STATUS_CHANGE,
            resourceType: AUDIT_RESOURCE_TYPES.INSPECTION_PLAN,
            resourceId: plan._id,
            before,
            after,
            reason,
            targetTeamId: context.activeTeamId,
            session
          });
          cancelledCount += 1;
          responseById.set(String(plan._id), after);
        }
        return {
          plans: uniqueIds.map((planId) => responseById.get(String(planId))),
          cancelledCount,
          alreadyCancelledCount
        };
      });
    } catch (error) {
      if (error?.name === 'VersionError') {
        throw workflowError(
          409,
          'EQUIPMENT_ROUTINE_PLAN_CONFLICT',
          'An inspection plan changed while it was being marked as a rest day; refresh and retry'
        );
      }
      throw error;
    }
  }

  async function listExceptions({ authContext, requestedTeamId, method = 'GET', query = {} }) {
    assertOnlyKeys(query, [
      'teamId', 'page', 'pageSize', 'routineType', 'status', 'stage', 'equipmentId', 'orgUnitId', 'from', 'to'
    ], 'query');
    assertPermission(authContext, 'equipment.view');
    const teamId = await resolveReadTeamId(authContext, requestedTeamId);
    const userFilter = { ...rangeFilter(query, 'createdAt') };
    if (query.routineType) userFilter.routineType = requiredString(query.routineType, 'routineType', 50);
    if (query.status) {
      if (!EQUIPMENT_ROUTINE_EXCEPTION_STATUS_VALUES.includes(query.status)) throw inputInvalid('status is invalid');
      userFilter.status = query.status;
    }
    if (query.stage) {
      if (!EQUIPMENT_ROUTINE_EXCEPTION_STAGE_VALUES.includes(query.stage)) throw inputInvalid('stage is invalid');
      userFilter.currentStage = query.stage;
    }
    if (query.equipmentId) userFilter.equipmentId = normalizeRelatedId(query.equipmentId);
    if (query.orgUnitId) userFilter.orgUnitId = normalizeRelatedId(query.orgUnitId);
    const scopedFilter = await readFilter({ authContext, teamId, method, userFilter });
    const leadershipScope = await actingLeadershipScope(authContext, teamId);
    const filter = leadershipScope.length
      ? {
          $or: [
            scopedFilter,
            {
              $and: [
                userFilter,
                {
                  teamId,
                  orgUnitId: { $in: leadershipScope },
                  status: EQUIPMENT_ROUTINE_EXCEPTION_STATUSES.OPEN,
                  currentStage: EQUIPMENT_ROUTINE_EXCEPTION_STAGES.SUB_DEPARTMENT_MANAGER
                }
              ]
            }
          ]
        }
      : scopedFilter;
    const { page, pageSize, skip } = pagination(query);
    const [documents, total] = await Promise.all([
      EquipmentRoutineExceptionModel.find(filter).sort({ updatedAt: -1, _id: -1 }).skip(skip).limit(pageSize).lean(),
      EquipmentRoutineExceptionModel.countDocuments(filter)
    ]);
    const enriched = await enrichRows(documents);
    const recipientCache = new Map();
    const exceptions = await Promise.all(enriched.map(async (value) => ({
      ...await serializeExceptionForContext(value, authContext, { recipientCache }),
      equipment: value.equipment,
      orgUnit: value.orgUnit
    })));
    return { exceptions, total, page, pageSize };
  }

  async function getException({ authContext, requestedTeamId, method = 'GET', exceptionId, query = {} }) {
    assertOnlyKeys(query, ['teamId'], 'query');
    assertPermission(authContext, 'equipment.view');
    const teamId = await resolveReadTeamId(authContext, requestedTeamId);
    const filter = await readFilter({
      authContext,
      teamId,
      method,
      id: normalizeRelatedId(exceptionId)
    });
    let document = await EquipmentRoutineExceptionModel.findOne(filter).lean();
    if (!document && authContext.mode === SESSION_MODES.TEAM) {
      const candidate = await EquipmentRoutineExceptionModel.findOne({
        _id: normalizeRelatedId(exceptionId),
        teamId
      }).lean();
      if (candidate && (await exceptionAccessPolicy({
        authContext,
        exception: candidate
      })).canHandle) {
        document = candidate;
      }
    }
    if (!document) throw notFound();
    const [enriched] = await enrichRows([document]);
    return {
      ...await serializeExceptionForContext(enriched, authContext),
      equipment: enriched.equipment,
      orgUnit: enriched.orgUnit
    };
  }

  async function transitionException({ authContext, req, exceptionId, input = {} }) {
    assertOnlyKeys(input, ['action', 'opinion', 'expectedRevision']);
    const context = assertTeamContext(authContext);
    assertPermission(context, 'equipment.view');
    if (!EQUIPMENT_ROUTINE_EXCEPTION_ACTION_VALUES.includes(input.action) || input.action === 'SUBMITTED') {
      throw inputInvalid('action must be RESOLVE or ESCALATE');
    }
    const opinion = requiredString(input.opinion, 'opinion', 3000);
    const expectedRevision = integer(input.expectedRevision, 'expectedRevision', { min: 0 });
    if (expectedRevision === null) throw inputInvalid('expectedRevision is required');
    try {
      return await runWorkflowTransaction(async (session) => {
      const filter = await readFilter({
        authContext: context,
        teamId: normalizeObjectId(context.activeTeamId, 'activeTeamId'),
        method: 'POST',
        id: normalizeRelatedId(exceptionId),
        userFilter: { status: EQUIPMENT_ROUTINE_EXCEPTION_STATUSES.OPEN }
      });
      let exception = await modelQuery(EquipmentRoutineExceptionModel.findOne(filter), session);
      const candidate = exception || await modelQuery(EquipmentRoutineExceptionModel.findOne({
          _id: normalizeRelatedId(exceptionId),
          teamId: context.activeTeamId,
          status: EQUIPMENT_ROUTINE_EXCEPTION_STATUSES.OPEN
        }), session);
      if (
        candidate?.currentStage === EQUIPMENT_ROUTINE_EXCEPTION_STAGES.SUB_DEPARTMENT_MANAGER
      ) {
        await lockSubDepartmentLeadership({
          OrgUnitModel,
          teamId: candidate.teamId,
          orgUnitIds: [candidate.orgUnitId],
          session
        });
      }
      if (!exception) {
        if (candidate && (await exceptionAccessPolicy({
          authContext: context,
          exception: candidate,
          session
        })).canHandle) {
          exception = candidate;
        }
      }
      if (!exception) throw notFound();
      assertPermission(context, exception.routineType === 'INSPECTION' ? 'equipment.inspect' : 'equipment.maintain');
      if (exception.revision !== expectedRevision) {
        throw workflowError(409, 'EQUIPMENT_ROUTINE_REVISION_CONFLICT', 'The exception was changed; refresh and retry');
      }
      const group = exceptionRecipientGroup(exception.currentStage);
      const recipients = await recipientUserIds({
        TeamMembershipModel,
        OrgUnitModel,
        UserModel,
        teamId: exception.teamId,
        orgUnitId: exception.orgUnitId,
        group,
        session
      });
      if (!recipients.includes(normalizeId(context.userId))) {
        throw workflowError(403, 'EQUIPMENT_ROUTINE_STAGE_FORBIDDEN', 'Only the current processing position can handle this exception');
      }
      if (
        input.action === EQUIPMENT_ROUTINE_EXCEPTION_ACTIONS.ESCALATE &&
        exception.currentStage === EQUIPMENT_ROUTINE_EXCEPTION_STAGES.ASSET_ADMIN
      ) {
        throw inputInvalid('The equipment administrator is the final processing stage and must resolve the exception');
      }
      const before = serializeException(exception);
      const actedAt = clock();
      const previousStage = exception.currentStage;
      exception.history.push({
        stage: previousStage,
        action: input.action,
        opinion,
        actorId: context.userId,
        actorPositionKey: context.membership?.positionKey || '',
        actedAt
      });
      if (input.action === EQUIPMENT_ROUTINE_EXCEPTION_ACTIONS.RESOLVE) {
        exception.status = EQUIPMENT_ROUTINE_EXCEPTION_STATUSES.RESOLVED;
        exception.currentStage = EQUIPMENT_ROUTINE_EXCEPTION_STAGES.RESOLVED;
        exception.resolvedAt = actedAt;
        exception.resolvedBy = context.userId;
      } else {
        exception.currentStage = nextExceptionStage(previousStage);
      }
      exception.revision += 1;
      await exception.save({ session });
      if (exception.status === EQUIPMENT_ROUTINE_EXCEPTION_STATUSES.OPEN) {
        await notifyExceptionStage(exception, session);
      }
       const after = serializeException(exception);
       const response = await serializeExceptionForContext(exception, context, { session });
      await auditService.record({
        req,
        authContext: context,
        action: input.action === EQUIPMENT_ROUTINE_EXCEPTION_ACTIONS.RESOLVE
          ? AUDIT_ACTIONS.STATUS_CHANGE
          : AUDIT_ACTIONS.RETURN,
        resourceType: exceptionAuditResource(exception.routineType),
        resourceId: exception._id,
        before,
        after,
        reason: opinion,
        targetTeamId: context.activeTeamId,
        session
      });
         return response;
      });
    } catch (error) {
      if (error?.name === 'VersionError') {
        throw workflowError(409, 'EQUIPMENT_ROUTINE_REVISION_CONFLICT', 'The exception was changed; refresh and retry');
      }
      throw error;
    }
  }

  async function exportRecords({ authContext, req, requestedTeamId, method = 'GET', query = {} }) {
    assertOnlyKeys(query, [
      'teamId', 'routineType', 'equipmentId', 'orgUnitId', 'overallResult', 'from', 'to', 'dateBasis'
    ], 'query');
    assertPermission(authContext, 'equipment.view');
    assertPermission(authContext, 'equipment.export');
    const teamId = await resolveReadTeamId(authContext, requestedTeamId);
    const dateBasis = String(query.dateBasis || 'EXECUTION').trim().toUpperCase();
    if (!['EXECUTION', 'PLAN'].includes(dateBasis)) {
      throw inputInvalid('dateBasis must be EXECUTION or PLAN');
    }
    const dateRange = rangeFilter(query, 'performedAt').performedAt || null;
    const userFilter = {};
    if (dateRange && dateBasis === 'PLAN') {
      userFilter.$or = [
        { planScheduledFor: dateRange },
        {
          $and: [
            {
              $or: [
                { planScheduledFor: { $exists: false } },
                { planScheduledFor: null }
              ]
            },
            { scheduledFor: dateRange }
          ]
        },
        {
          $and: [
            {
              $or: [
                { planScheduledFor: { $exists: false } },
                { planScheduledFor: null }
              ]
            },
            {
              $or: [
                { scheduledFor: { $exists: false } },
                { scheduledFor: null }
              ]
            },
            { performedAt: dateRange }
          ]
        }
      ];
    } else if (dateRange) {
      userFilter.performedAt = dateRange;
    }
    if (query.routineType) userFilter.routineType = requiredString(query.routineType, 'routineType', 50);
    if (query.equipmentId) userFilter.equipmentId = normalizeRelatedId(query.equipmentId);
    if (query.orgUnitId) userFilter.orgUnitId = normalizeRelatedId(query.orgUnitId);
    if (query.overallResult) userFilter.overallResult = requiredString(query.overallResult, 'overallResult', 50);
    const filter = await readFilter({ authContext, teamId, method, userFilter });
    const records = dateBasis === 'PLAN'
      ? await EquipmentRoutineRecordModel.aggregate([
        { $match: EquipmentRoutineRecordModel.find(filter).cast() },
        {
          $addFields: {
            __planSortAt: {
              $ifNull: [
                '$planScheduledFor',
                { $ifNull: ['$scheduledFor', '$performedAt'] }
              ]
            }
          }
        },
        { $sort: { __planSortAt: -1, performedAt: -1, _id: -1 } },
        { $project: { __planSortAt: 0 } }
      ])
      : await EquipmentRoutineRecordModel.find(filter).sort({ performedAt: -1, _id: -1 }).lean();
    const enriched = await enrichRows(records, {
      includeException: true,
      includePlan: true,
      includePerformer: true
    });
    const rows = enriched.map((record) => {
      const planScheduledFor = record.plan?.scheduledFor || record.planScheduledFor || (
        record.planId ? null : record.scheduledFor
      );
      const planDueAt = record.plan?.dueAt || record.planDueAt || null;
      const performer = record.performedByUser;
      return {
        '设备编号': formulaSafe(record.equipment?.assetCode || ''),
        '设备名称': formulaSafe(record.equipment?.name || ''),
        '车牌号': formulaSafe(record.equipment?.plateNumber || ''),
        '所属组织': formulaSafe(record.orgUnit?.name || ''),
        '业务类型': record.routineType === 'INSPECTION' ? '点检' : '保养',
        '规则名称': formulaSafe(record.ruleSnapshot?.name || ''),
        '规则版本': record.ruleVersion,
        '关联计划编号': normalizeId(record.planId) || '',
        '计划窗口': formulaSafe(record.plan?.windowName || ''),
        '计划开始时间': planScheduledFor || '',
        '计划截止时间': planDueAt || '',
        '执行人': formulaSafe(performer?.name || performer?.username || normalizeId(record.performedBy) || ''),
        '执行时间': record.performedAt,
        '执行结果': record.overallResult,
        '异常摘要': formulaSafe(record.abnormalSummary || ''),
        '异常状态': record.exception?.status || '',
        '当前处理阶段': record.exception?.currentStage || '',
        '现场照片数': Array.isArray(record.photoFileIds) ? record.photoFileIds.length : 0,
        '现场水印': formulaSafe((record.photoEvidence || []).map(({ watermarkText }) => watermarkText).join('；')),
        '记录ID': normalizeId(record._id)
      };
    });
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(rows, {
      cellDates: true,
      header: [
        '设备编号',
        '设备名称',
        '车牌号',
        '所属组织',
        '业务类型',
        '规则名称',
        '规则版本',
        '关联计划编号',
        '计划窗口',
        '计划开始时间',
        '计划截止时间',
        '执行人',
        '执行时间',
        '执行结果',
        '异常摘要',
        '异常状态',
        '当前处理阶段',
        '现场照片数',
        '现场水印',
        '记录ID'
      ]
    });
    XLSX.utils.book_append_sheet(workbook, worksheet, '点检保养记录');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', cellDates: true });
    const routineTypes = [...new Set(records.map(({ routineType }) => routineType).filter(Boolean))].sort();
    await auditService.record({
      req,
      authContext,
      action: AUDIT_ACTIONS.EXPORT,
      resourceType: recordExportAuditResource(userFilter.routineType, routineTypes),
      after: {
        routineTypes,
        filters: {
          dateBasis,
          routineType: userFilter.routineType || null,
          equipmentId: userFilter.equipmentId ? normalizeId(userFilter.equipmentId) : null,
          orgUnitId: userFilter.orgUnitId ? normalizeId(userFilter.orgUnitId) : null,
          overallResult: userFilter.overallResult || null,
          from: dateRange?.$gte?.toISOString() || null,
          to: dateRange?.$lte?.toISOString() || null
        },
        count: rows.length
      },
      targetTeamId: teamId
    });
    return {
      buffer,
      count: rows.length,
      fileName: `equipment-routines-${new Date().toISOString().slice(0, 10)}.xlsx`
    };
  }

  return Object.freeze({
    createExceptionForRecord,
    exportRecords,
    getException,
    getPlan,
    listExceptions,
    listPlans,
    markPlansRestDay,
    notifyExceptionStage,
    transitionException
  });
}

module.exports = {
  RECIPIENT_GROUPS,
  createEquipmentRoutineWorkflowService,
  exceptionRecipientGroup,
  formulaSafe,
  nextExceptionStage,
  recipientUserIds,
  serializeException,
  serializePlan,
  upsertRoutineMessage
};
