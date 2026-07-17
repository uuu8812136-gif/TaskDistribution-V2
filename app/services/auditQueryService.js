'use strict';

const AuditLog = require('../models/AuditLog');
const ProjectTeam = require('../models/ProjectTeam');
const User = require('../models/User');
const {
  AUDIT_ACTION_VALUES,
  AUDIT_ACTOR_ROLES,
  AUDIT_RESOURCE_TYPES,
  AUDIT_RESOURCE_TYPE_VALUES,
  MEMBERSHIP_ROLES,
  SESSION_MODES
} = require('../config/permissions');
const { SYSTEM_ACCOUNT_DISPLAY_NAME } = require('../config/systemAccount');
const { normalizeId } = require('./authSessionService');
const { sanitizeAuditSnapshot } = require('./auditService');
const {
  AUTH_ERROR_CODES,
  AuthContextError
} = require('./authContextError');
const {
  assertPermission,
  assertTeamContext,
  sameId
} = require('./teamContextService');

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const SYSTEM_TEAM_FILTERS = new Set(['NULL', 'SYSTEM']);
const actionSet = new Set(AUDIT_ACTION_VALUES);
const resourceTypeSet = new Set(AUDIT_RESOURCE_TYPE_VALUES);
const ALLOWED_QUERY_KEYS = new Set([
  'startTime',
  'endTime',
  'actorUserId',
  'targetTeamId',
  'teamId',
  'resourceType',
  'action',
  'resourceId',
  'requestId',
  'page',
  'pageSize'
]);

class AuditQueryError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'AuditQueryError';
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}

function inputError(message) {
  return new AuditQueryError(400, 'AUDIT_QUERY_INVALID', message);
}

function notFound() {
  return new AuditQueryError(404, 'AUDIT_LOG_NOT_FOUND', 'Audit log does not exist');
}

function permissionDenied(message = 'Audit access is limited to administrators') {
  return new AuthContextError(403, AUTH_ERROR_CODES.PERMISSION_DENIED, message);
}

function normalizeScalar(value, fieldName, { maxLength = 128, optional = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return undefined;
    throw inputError(`${fieldName} is required`);
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw inputError(`${fieldName} must be a scalar value`);
  }
  const normalized = String(value).trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw inputError(`${fieldName} is invalid`);
  }
  return normalized;
}

function normalizeObjectId(value, fieldName) {
  const normalized = normalizeScalar(value, fieldName, { optional: false });
  if (!OBJECT_ID_PATTERN.test(normalized)) {
    throw inputError(`${fieldName} must be a valid ObjectId`);
  }
  return normalized.toLowerCase();
}

function normalizeInteger(value, fieldName, { fallback, min, max }) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = normalizeScalar(value, fieldName, { optional: false, maxLength: 16 });
  if (!/^[0-9]+$/.test(normalized)) throw inputError(`${fieldName} must be an integer`);
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw inputError(`${fieldName} must be between ${min} and ${max}`);
  }
  return parsed;
}

function normalizeDate(value, fieldName) {
  const normalized = normalizeScalar(value, fieldName, { maxLength: 64 });
  if (normalized === undefined) return undefined;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) throw inputError(`${fieldName} must be a valid date`);
  return date;
}

function normalizeEnum(value, fieldName, values) {
  const normalized = normalizeScalar(value, fieldName);
  if (normalized === undefined) return undefined;
  if (!values.has(normalized)) throw inputError(`${fieldName} is not supported`);
  return normalized;
}

function assertKnownQueryKeys(query) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    throw inputError('query must be an object');
  }
  const unknown = Object.keys(query).find((key) => !ALLOWED_QUERY_KEYS.has(key));
  if (unknown) throw inputError(`Unsupported audit query field: ${unknown}`);
}

function normalizeRequestedTeamId(query) {
  const targetTeamId = normalizeScalar(query.targetTeamId, 'targetTeamId');
  const teamId = normalizeScalar(query.teamId, 'teamId');
  if (targetTeamId !== undefined && teamId !== undefined && targetTeamId !== teamId) {
    throw inputError('targetTeamId and teamId must match when both are supplied');
  }
  const supplied = targetTeamId ?? teamId;
  if (supplied === undefined) return undefined;
  if (SYSTEM_TEAM_FILTERS.has(supplied.toUpperCase())) return null;
  return normalizeObjectId(supplied, targetTeamId !== undefined ? 'targetTeamId' : 'teamId');
}

function parseFilters(query = {}) {
  assertKnownQueryKeys(query);
  const page = normalizeInteger(query.page, 'page', {
    fallback: 1,
    min: 1,
    max: 1000000
  });
  const pageSize = normalizeInteger(query.pageSize, 'pageSize', {
    fallback: DEFAULT_PAGE_SIZE,
    min: 1,
    max: MAX_PAGE_SIZE
  });
  const startTime = normalizeDate(query.startTime, 'startTime');
  const endTime = normalizeDate(query.endTime, 'endTime');
  if (startTime && endTime && startTime > endTime) {
    throw inputError('startTime must not be later than endTime');
  }

  return {
    page,
    pageSize,
    skip: (page - 1) * pageSize,
    startTime,
    endTime,
    actorUserId: query.actorUserId === undefined
      ? undefined
      : normalizeObjectId(query.actorUserId, 'actorUserId'),
    targetTeamId: normalizeRequestedTeamId(query),
    resourceType: normalizeEnum(query.resourceType, 'resourceType', resourceTypeSet),
    action: normalizeEnum(query.action, 'action', actionSet),
    resourceId: normalizeScalar(query.resourceId, 'resourceId'),
    requestId: normalizeScalar(query.requestId, 'requestId')
  };
}

function resolveAuditScope(authContext, requestedTargetTeamId) {
  assertPermission(authContext, 'audit.view');

  if (authContext.mode === SESSION_MODES.GLOBAL_READ_ONLY) {
    if (authContext.isSuperAdmin !== true) {
      throw permissionDenied('Only a super administrator can read audit logs globally');
    }
    return {
      filter: requestedTargetTeamId === undefined
        ? {}
        : { targetTeamId: requestedTargetTeamId },
      global: true
    };
  }

  assertTeamContext(authContext);
  if (
    authContext.isSuperAdmin !== true &&
    authContext.membership?.role !== MEMBERSHIP_ROLES.PROJECT_ADMIN
  ) {
    throw permissionDenied();
  }

  if (
    requestedTargetTeamId !== undefined &&
    (requestedTargetTeamId === null || !sameId(requestedTargetTeamId, authContext.activeTeamId))
  ) {
    throw permissionDenied('Audit logs from another team or the system scope are not accessible');
  }

  return {
    filter: { targetTeamId: authContext.activeTeamId },
    global: false
  };
}

function buildListFilter(authContext, parsed) {
  const scope = resolveAuditScope(authContext, parsed.targetTeamId);
  const filter = { ...scope.filter };
  if (parsed.actorUserId !== undefined) filter.actorUserId = parsed.actorUserId;
  if (parsed.resourceType !== undefined) filter.resourceType = parsed.resourceType;
  if (parsed.action !== undefined) filter.action = parsed.action;
  if (parsed.resourceId !== undefined) filter.resourceId = parsed.resourceId;
  if (parsed.requestId !== undefined) filter.requestId = parsed.requestId;
  if (parsed.startTime || parsed.endTime) {
    filter.createdAt = {
      ...(parsed.startTime ? { $gte: parsed.startTime } : {}),
      ...(parsed.endTime ? { $lte: parsed.endTime } : {})
    };
  }
  return filter;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactSensitiveText(value, hiddenIdentityValues = []) {
  if (value === null || value === undefined) return null;
  let output = String(value).slice(0, 4096);
  output = output
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/=:-]+/gi, '$1[REDACTED]')
    .replace(
      /\b(password|passwd|pwd|token|authorization|cookie|secret|api[_-]?key|credential)\s*([:=])\s*([^\r\n,;&]*)/gi,
      '$1$2[REDACTED]'
    );
  for (const identity of hiddenIdentityValues) {
    if (typeof identity !== 'string' || identity.length < 3) continue;
    output = output.replace(new RegExp(escapeRegExp(identity), 'gi'), '[SYSTEM ACCOUNT]');
  }
  return output;
}

function redactKnownIdentities(value, hiddenIdentityValues) {
  if (Array.isArray(value)) {
    return value.map((item) => redactKnownIdentities(item, hiddenIdentityValues));
  }
  if (!value || typeof value !== 'object') {
    return typeof value === 'string'
      ? redactSensitiveText(value, hiddenIdentityValues)
      : value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    redactSensitiveText(key, hiddenIdentityValues),
    redactKnownIdentities(item, hiddenIdentityValues)
  ]));
}

function serializeTeam(team) {
  if (!team) return null;
  return {
    _id: normalizeId(team._id),
    code: team.code,
    name: team.name
  };
}

function userIdentityValues(user) {
  if (!user || user.isSystemAccount !== true) return [];
  return [
    normalizeId(user._id),
    user.username,
    user.usernameNormalized,
    user.name,
    user.phone,
    user.email,
    user.avatar
  ].filter((value) => typeof value === 'string' && value.length >= 3);
}

function collectRelationIds(documents) {
  const userIds = new Set();
  const teamIds = new Set();
  for (const document of documents) {
    const actorUserId = normalizeId(document.actorUserId);
    if (actorUserId) userIds.add(actorUserId);
    if (
      document.resourceType === AUDIT_RESOURCE_TYPES.USER &&
      typeof document.resourceId === 'string' &&
      OBJECT_ID_PATTERN.test(document.resourceId)
    ) {
      userIds.add(document.resourceId.toLowerCase());
    }
    for (const value of [document.activeTeamId, document.targetTeamId]) {
      const teamId = normalizeId(value);
      if (teamId) teamIds.add(teamId);
    }
  }
  return { userIds: [...userIds], teamIds: [...teamIds] };
}

async function loadRelations(documents, { UserModel, ProjectTeamModel }) {
  const { userIds, teamIds } = collectRelationIds(documents);
  const userSelection = '_id username usernameNormalized name phone email avatar isSystemAccount';
  const [users, teams, systemAccounts] = await Promise.all([
    userIds.length
      ? UserModel.find({ _id: { $in: userIds } })
        .select(userSelection)
        .lean()
      : [],
    teamIds.length
      ? ProjectTeamModel.find({ _id: { $in: teamIds } })
        .select('_id code name')
        .lean()
      : [],
    UserModel.find({ isSystemAccount: true })
      .select(userSelection)
      .lean()
  ]);
  const hiddenIdentityValues = [...new Set(
    systemAccounts.flatMap(userIdentityValues)
  )];
  return {
    users: new Map(users.map((user) => [normalizeId(user._id), user])),
    teams: new Map(teams.map((team) => [normalizeId(team._id), team])),
    systemAccountIds: new Set(systemAccounts.map((user) => normalizeId(user._id))),
    hiddenIdentityValues
  };
}

function serializeAuditLog(document, relations) {
  const value = typeof document.toObject === 'function'
    ? document.toObject({ getters: false, virtuals: false })
    : document;
  const rawActorUserId = normalizeId(value.actorUserId);
  const actorUser = rawActorUserId ? relations.users.get(rawActorUserId) : null;
  const systemActor = (
    value.actorRole === AUDIT_ACTOR_ROLES.SYSTEM ||
    actorUser?.isSystemAccount === true ||
    relations.systemAccountIds.has(rawActorUserId)
  );
  const targetUser = (
    value.resourceType === AUDIT_RESOURCE_TYPES.USER &&
    typeof value.resourceId === 'string' &&
    OBJECT_ID_PATTERN.test(value.resourceId)
  ) ? relations.users.get(value.resourceId.toLowerCase()) : null;
  const hiddenIdentityValues = relations.hiddenIdentityValues;
  const activeTeamId = normalizeId(value.activeTeamId);
  const targetTeamId = normalizeId(value.targetTeamId);
  const safeSnapshot = (snapshot) => redactKnownIdentities(
    sanitizeAuditSnapshot(snapshot),
    hiddenIdentityValues
  );
  const hiddenSystemResource = (
    targetUser?.isSystemAccount === true ||
    relations.systemAccountIds.has(String(value.resourceId || '').toLowerCase())
  );

  return {
    _id: normalizeId(value._id),
    actorUserId: systemActor ? null : rawActorUserId,
    actor: systemActor
      ? { name: SYSTEM_ACCOUNT_DISPLAY_NAME }
      : {
          _id: rawActorUserId,
          name: actorUser?.name || '已删除用户'
        },
    actorRole: value.actorRole,
    actorMode: value.actorMode,
    activeTeamId,
    activeTeam: serializeTeam(activeTeamId ? relations.teams.get(activeTeamId) : null),
    targetTeamId,
    targetTeam: serializeTeam(targetTeamId ? relations.teams.get(targetTeamId) : null),
    action: value.action,
    resourceType: value.resourceType,
    resourceId: hiddenSystemResource
      ? null
      : redactSensitiveText(value.resourceId, hiddenIdentityValues),
    ...(value.before === undefined ? {} : { before: safeSnapshot(value.before) }),
    ...(value.after === undefined ? {} : { after: safeSnapshot(value.after) }),
    reason: redactSensitiveText(value.reason, hiddenIdentityValues),
    requestId: redactSensitiveText(value.requestId, hiddenIdentityValues),
    requestMethod: value.requestMethod || null,
    requestPath: redactSensitiveText(value.requestPath, hiddenIdentityValues),
    createdAt: value.createdAt
  };
}

function createAuditQueryService({
  AuditLogModel = AuditLog,
  ProjectTeamModel = ProjectTeam,
  UserModel = User
} = {}) {
  if (!AuditLogModel || typeof AuditLogModel.find !== 'function') {
    throw new TypeError('AuditLogModel with find is required');
  }
  if (!ProjectTeamModel || typeof ProjectTeamModel.find !== 'function') {
    throw new TypeError('ProjectTeamModel with find is required');
  }
  if (!UserModel || typeof UserModel.find !== 'function') {
    throw new TypeError('UserModel with find is required');
  }

  async function listAuditLogs({ authContext, query = {} }) {
    const parsed = parseFilters(query);
    const filter = buildListFilter(authContext, parsed);
    const [documents, total] = await Promise.all([
      AuditLogModel.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip(parsed.skip)
        .limit(parsed.pageSize)
        .lean(),
      AuditLogModel.countDocuments(filter)
    ]);
    const relations = await loadRelations(documents, { UserModel, ProjectTeamModel });
    return {
      auditLogs: documents.map((document) => serializeAuditLog(document, relations)),
      total,
      page: parsed.page,
      pageSize: parsed.pageSize
    };
  }

  async function getAuditLog({ authContext, auditLogId }) {
    const id = normalizeObjectId(auditLogId, 'auditLogId');
    const scope = resolveAuditScope(authContext, undefined);
    const document = await AuditLogModel.findOne({ _id: id, ...scope.filter }).lean();
    if (!document) throw notFound();
    const relations = await loadRelations([document], { UserModel, ProjectTeamModel });
    return serializeAuditLog(document, relations);
  }

  return Object.freeze({
    getAuditLog,
    listAuditLogs
  });
}

module.exports = {
  AuditQueryError,
  createAuditQueryService,
  parseFilters,
  redactSensitiveText,
  resolveAuditScope,
  serializeAuditLog
};
