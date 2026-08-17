'use strict';

const mongoose = require('mongoose');
const OrgUnit = require('../models/OrgUnit');
const ProjectTeam = require('../models/ProjectTeam');
const TeamMembership = require('../models/TeamMembership');
const User = require('../models/User');
const {
  AUDIT_ACTIONS,
  AUDIT_RESOURCE_TYPES,
  FUNCTIONAL_ROLE_KEYS,
  FUNCTIONAL_ROLE_KEY_VALUES,
  MEMBERSHIP_ROLES,
  MEMBERSHIP_ROLE_VALUES,
  MEMBERSHIP_STATUSES,
  ORG_UNIT_TYPES,
  ORG_UNIT_STATUSES,
  ORG_UNIT_TYPE_VALUES,
  PERMISSION_KEYS,
  POSITION_KEY_VALUES,
  POSITION_KEYS,
  POSITION_LEVEL_BY_KEY,
  SESSION_MODES,
  TEAM_STATUSES,
  TEAM_STATUS_VALUES,
  deriveModuleDataScopes
} = require('../config/permissions');
const { normalizeId } = require('./authSessionService');
const { createAuditService } = require('./auditService');
const { findOrgUnitDependency } = require('./orgUnitDependencyService');
const { lockActiveOrgUnitReference } = require('./orgUnitReferenceService');
const { lockSubDepartmentLeadership } = require('./subDepartmentLeadershipService');
const {
  AUTH_ERROR_CODES,
  AuthContextError
} = require('./authContextError');
const { hasEffectivePermission } = require('./teamContextService');

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;
const permissionKeySet = new Set(PERMISSION_KEYS);
const functionalRoleKeySet = new Set(FUNCTIONAL_ROLE_KEY_VALUES);
const membershipRoleSet = new Set(MEMBERSHIP_ROLE_VALUES);
const positionKeySet = new Set(POSITION_KEY_VALUES);
const teamStatusSet = new Set(TEAM_STATUS_VALUES);
const manageableOrgStatusSet = new Set([
  ORG_UNIT_STATUSES.ACTIVE,
  ORG_UNIT_STATUSES.DISABLED
]);
const orgTypeSet = new Set(ORG_UNIT_TYPE_VALUES);
const repairRecipientPositionKeys = new Set([
  POSITION_KEYS.DEPARTMENT_MANAGER,
  POSITION_KEYS.DEPARTMENT_DEPUTY_MANAGER,
  POSITION_KEYS.DEPARTMENT_MANAGER_ASSISTANT,
  POSITION_KEYS.SUB_DEPARTMENT_MANAGER,
  POSITION_KEYS.SUB_DEPARTMENT_DEPUTY_MANAGER,
  POSITION_KEYS.SUPERVISOR
]);

const DEFAULT_PROJECT_ADMIN_PERMISSIONS = Object.freeze([
  'member.view',
  'member.manage',
  'org.manage',
  'reporter.assign',
  'audit.view'
]);

const PRIVILEGE_FIELDS = new Set([
  'isSuperAdmin',
  'isSystemAccount',
  'tokenVersion',
  'moduleDataScopes',
  'positionLevel',
  'roles'
]);

class TeamManagementError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'TeamManagementError';
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}

function managementError(status, code, message) {
  return new TeamManagementError(status, code, message);
}

function inputError(message, code = 'MANAGEMENT_INPUT_INVALID') {
  return managementError(400, code, message);
}

function notFound(resourceName) {
  return managementError(404, 'MANAGEMENT_RESOURCE_NOT_FOUND', `${resourceName} does not exist`);
}

function permissionDenied(message = 'Permission denied') {
  return new AuthContextError(403, AUTH_ERROR_CODES.PERMISSION_DENIED, message);
}

function assertPlainObject(value, fieldName = 'request body') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw inputError(`${fieldName} must be an object`);
  }
  return value;
}

function assertAllowedKeys(value, allowedKeys, fieldName = 'request body') {
  assertPlainObject(value, fieldName);
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) {
    throw inputError(`Unsupported ${fieldName} field: ${unknown[0]}`);
  }
}

function rejectPrivilegeFields(value) {
  const supplied = Object.keys(value || {}).find((key) => PRIVILEGE_FIELDS.has(key));
  if (supplied) {
    throw permissionDenied(`The ${supplied} field is controlled by the server`);
  }
}

function membershipMayReceiveRepairTodo(membership) {
  return membership?.status === MEMBERSHIP_STATUSES.ACTIVE &&
    membership.permissionKeys?.includes('equipment.repair') === true &&
    (
      repairRecipientPositionKeys.has(membership.positionKey) ||
      membership.functionalRoleKeys?.includes(FUNCTIONAL_ROLE_KEYS.ASSET_ADMIN) === true
    );
}

function repairRecipientFieldsChanged(before, after) {
  const sorted = (values) => [...new Set(Array.isArray(values) ? values : [])].sort();
  return normalizeId(before?.orgUnitId) !== normalizeId(after?.orgUnitId) ||
    before?.positionKey !== after?.positionKey ||
    before?.status !== after?.status ||
    JSON.stringify(sorted(before?.permissionKeys)) !== JSON.stringify(sorted(after?.permissionKeys)) ||
    JSON.stringify(sorted(before?.functionalRoleKeys)) !== JSON.stringify(sorted(after?.functionalRoleKeys));
}

function requiredString(value, fieldName, { min = 1, max = 100 } = {}) {
  if (typeof value !== 'string') throw inputError(`${fieldName} is required`);
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) {
    throw inputError(`${fieldName} must contain between ${min} and ${max} characters`);
  }
  return normalized;
}

function optionalString(value, fieldName, { max = 100 } = {}) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > max) {
    throw inputError(`${fieldName} must contain at most ${max} characters`);
  }
  return value.trim();
}

function normalizeCode(value, fieldName = 'code') {
  const code = requiredString(value, fieldName, { min: 1, max: 50 }).toUpperCase();
  if (!/^[A-Z0-9](?:[A-Z0-9_-]{0,48}[A-Z0-9])?$/.test(code)) {
    throw inputError(`${fieldName} contains unsupported characters`);
  }
  return code;
}

function normalizeObjectId(value, resourceName) {
  const id = normalizeId(value);
  if (!id || !OBJECT_ID_PATTERN.test(id)) throw notFound(resourceName);
  return id.toLowerCase();
}

function normalizeUniqueEnumArray(value, allowedValues, fieldName) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw inputError(`${fieldName} must be an array`);
  if (
    new Set(value).size !== value.length ||
    value.some((item) => typeof item !== 'string' || !allowedValues.has(item))
  ) {
    throw inputError(`${fieldName} contains an unsupported or duplicate value`);
  }
  return [...value];
}

function normalizePermissionKeys(value) {
  return normalizeUniqueEnumArray(value, permissionKeySet, 'permissionKeys');
}

function normalizeFunctionalRoleKeys(value) {
  return normalizeUniqueEnumArray(value, functionalRoleKeySet, 'functionalRoleKeys');
}

function normalizePositionKey(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !positionKeySet.has(value)) {
    throw inputError('positionKey is invalid');
  }
  return value;
}

function normalizeMembershipRole(value, defaultValue = undefined) {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'string' || !membershipRoleSet.has(value)) {
    throw inputError('role is invalid');
  }
  return value;
}

function serializeTeam(team) {
  const value = typeof team.toObject === 'function' ? team.toObject() : team;
  return {
    _id: normalizeId(value._id),
    code: value.code,
    name: value.name,
    status: value.status,
    settings: value.settings ? { timeZone: value.settings.timeZone } : null,
    createdBy: normalizeId(value.createdBy),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  };
}

function serializeOrgUnit(orgUnit) {
  const value = typeof orgUnit.toObject === 'function' ? orgUnit.toObject() : orgUnit;
  return {
    _id: normalizeId(value._id),
    teamId: normalizeId(value.teamId),
    parentId: normalizeId(value.parentId),
    type: value.type,
    code: value.code,
    name: value.name,
    status: value.status,
    sortOrder: value.sortOrder,
    level: value.level,
    path: value.path,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  };
}

function serializeOrgUnitTombstone(orgUnit) {
  const value = typeof orgUnit.toObject === 'function' ? orgUnit.toObject() : orgUnit;
  return {
    ...serializeOrgUnit(value),
    deletedAt: value.deletedAt,
    deletedBy: normalizeId(value.deletedBy),
    deletionReason: value.deletionReason
  };
}

function serializeUser(user) {
  if (!user) return null;
  const value = typeof user.toObject === 'function'
    ? user.toObject({ getters: false, virtuals: false })
    : user;
  return {
    _id: normalizeId(value._id),
    username: value.username,
    name: value.name,
    phone: value.phone,
    email: value.email,
    avatar: value.avatar,
    status: value.status
  };
}

function serializeMembership(membership, { user = null, orgUnit = null } = {}) {
  const value = typeof membership.toObject === 'function'
    ? membership.toObject({ getters: false, virtuals: false })
    : membership;
  return {
    _id: normalizeId(value._id),
    teamId: normalizeId(value.teamId),
    userId: normalizeId(value.userId),
    orgUnitId: normalizeId(value.orgUnitId),
    role: value.role,
    positionLevel: value.positionLevel,
    positionKey: value.positionKey,
    functionalRoleKeys: [...(value.functionalRoleKeys || [])],
    permissionKeys: [...(value.permissionKeys || [])],
    moduleDataScopes: (value.moduleDataScopes || []).map(({ moduleKey, scope }) => ({
      moduleKey,
      scope
    })),
    status: value.status,
    joinedAt: value.joinedAt,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    user: serializeUser(user || value.userId),
    orgUnit: orgUnit ? serializeOrgUnit(orgUnit) : (
      value.orgUnitId && typeof value.orgUnitId === 'object' && value.orgUnitId.name
        ? serializeOrgUnit(value.orgUnitId)
        : null
    )
  };
}

function assertSuperAdmin(context) {
  if (!context?.authenticated || context.isSuperAdmin !== true) {
    throw new AuthContextError(
      403,
      AUTH_ERROR_CODES.SUPER_ADMIN_REQUIRED,
      'A super administrator is required'
    );
  }
  return context;
}

function assertGlobalTeamControl(context) {
  assertSuperAdmin(context);
  if (context.mode !== SESSION_MODES.GLOBAL_READ_ONLY) {
    throw permissionDenied('Enter global read-only mode to manage the team control plane');
  }
}

function assertTeamContext(context) {
  if (!context?.authenticated || context.mode !== SESSION_MODES.TEAM || !context.activeTeamId) {
    throw new AuthContextError(
      403,
      AUTH_ERROR_CODES.TEAM_CONTEXT_REQUIRED,
      'An active team context is required'
    );
  }
  return context;
}

function assertTeamAdministrativePermission(context, permissionKey) {
  assertTeamContext(context);
  if (context.isSuperAdmin === true) return context;
  if (
    context.membership?.role !== MEMBERSHIP_ROLES.PROJECT_ADMIN ||
    !context.permissionKeys?.includes(permissionKey)
  ) {
    throw permissionDenied('Project administrator access is required');
  }
  return context;
}

function activeTeamId(context) {
  assertTeamContext(context);
  return normalizeObjectId(context.activeTeamId, 'Team');
}

function applyDerivedMembershipFields(membership) {
  membership.positionLevel = POSITION_LEVEL_BY_KEY[membership.positionKey];
  membership.moduleDataScopes = deriveModuleDataScopes({
    positionLevel: membership.positionLevel,
    functionalRoleKeys: membership.functionalRoleKeys
  });
}

function memberAuditSnapshot(membership, user = null) {
  const serialized = serializeMembership(membership, { user });
  if (serialized.user) delete serialized.user.status;
  return serialized;
}

function duplicateError(error) {
  if (error?.code !== 11000) return error;
  if (error.keyPattern?.orgUnitId && !error.keyPattern?.userId) {
    return managementError(
      409,
      'ATTENDANCE_REPORTER_EXISTS',
      'This division already has an active attendance reporter'
    );
  }
  const key = Object.keys(error.keyPattern || error.keyValue || {})[0] || 'value';
  const messages = {
    username: ['USERNAME_EXISTS', 'The username already exists'],
    usernameNormalized: ['USERNAME_EXISTS', 'The username already exists'],
    code: ['CODE_EXISTS', 'The code already exists'],
    teamId: ['MEMBERSHIP_EXISTS', 'The user already belongs to this team']
  };
  const [code, message] = messages[key] || ['MANAGEMENT_CONFLICT', 'The record already exists'];
  return managementError(409, code, message);
}

function normalizePersistenceError(error) {
  if (error instanceof TeamManagementError || error instanceof AuthContextError) return error;
  if (error?.code === 11000) return duplicateError(error);
  if (error?.name === 'ValidationError' || error?.name === 'StrictModeError') {
    return inputError(error.message, 'MANAGEMENT_VALIDATION_FAILED');
  }
  if (error?.name === 'VersionError') {
    return managementError(409, 'MANAGEMENT_CONCURRENT_UPDATE', '数据已被其他人修改，请刷新后重试');
  }
  return error;
}

function createTeamManagementService({
  connection = mongoose.connection,
  UserModel = User,
  ProjectTeamModel = ProjectTeam,
  OrgUnitModel = OrgUnit,
  TeamMembershipModel = TeamMembership,
  orgUnitDependencyFinder = findOrgUnitDependency,
  repairTodoSynchronizer = null,
  auditService = createAuditService(),
  clock = () => new Date()
} = {}) {
  async function transaction(work) {
    const session = await connection.startSession();
    let result;
    try {
      await session.withTransaction(async () => {
        result = await work(session);
      });
      return result;
    } catch (error) {
      throw normalizePersistenceError(error);
    } finally {
      await session.endSession();
    }
  }

  async function listTeams({ authContext, status } = {}) {
    assertSuperAdmin(authContext);
    const query = {};
    if (authContext.mode === SESSION_MODES.TEAM) {
      query._id = activeTeamId(authContext);
    } else if (authContext.mode !== SESSION_MODES.GLOBAL_READ_ONLY) {
      throw permissionDenied('Global or active team context is required');
    }
    if (status !== undefined) {
      if (!teamStatusSet.has(status)) throw inputError('status is invalid');
      query.status = status;
    }
    const teams = await ProjectTeamModel.find(query).sort({ name: 1, _id: 1 }).lean();
    return teams.map(serializeTeam);
  }

  async function createTeam({ authContext, req, input } = {}) {
    assertGlobalTeamControl(authContext);
    assertAllowedKeys(input, new Set(['code', 'name', 'settings', 'reason']));
    const settings = input.settings === undefined ? {} : assertPlainObject(input.settings, 'settings');
    assertAllowedKeys(settings, new Set(['timeZone']), 'settings');
    const payload = {
      code: normalizeCode(input.code),
      name: requiredString(input.name, 'name'),
      settings: {
        timeZone: settings.timeZone === undefined
          ? 'Asia/Shanghai'
          : requiredString(settings.timeZone, 'settings.timeZone', { min: 1, max: 64 })
      },
      createdBy: authContext.userId
    };

    return transaction(async (session) => {
      const team = new ProjectTeamModel(payload);
      await team.save({ session });
      const serialized = serializeTeam(team);
      await auditService.record({
        req,
        authContext,
        action: AUDIT_ACTIONS.CREATE,
        resourceType: AUDIT_RESOURCE_TYPES.PROJECT_TEAM,
        resourceId: team._id,
        after: serialized,
        reason: optionalString(input.reason, 'reason', { max: 2000 }),
        targetTeamId: team._id,
        session
      });
      return serialized;
    });
  }

  async function updateTeamStatus({ authContext, req, teamId, input } = {}) {
    assertSuperAdmin(authContext);
    const trustedTeamId = activeTeamId(authContext);
    const requestedTeamId = normalizeObjectId(teamId, 'Team');
    if (trustedTeamId !== requestedTeamId) throw notFound('Team');
    assertAllowedKeys(input, new Set(['status', 'reason']));
    if (input.status !== TEAM_STATUSES.DISABLED) {
      throw inputError('This endpoint only disables the active team; use the control plane to enable it');
    }

    return transaction(async (session) => {
      const team = await ProjectTeamModel.findOne({ _id: requestedTeamId }).session(session);
      if (!team) throw notFound('Team');
      if (team.status === TEAM_STATUSES.DISABLED) {
        throw managementError(409, 'TEAM_ALREADY_DISABLED', 'The team is already disabled');
      }
      const before = serializeTeam(team);
      team.status = input.status;
      await team.save({ session });
      const after = serializeTeam(team);
      await auditService.record({
        req,
        authContext,
        action: input.status === TEAM_STATUSES.ACTIVE
          ? AUDIT_ACTIONS.ENABLE
          : AUDIT_ACTIONS.DISABLE,
        resourceType: AUDIT_RESOURCE_TYPES.PROJECT_TEAM,
        resourceId: team._id,
        before,
        after,
        reason: optionalString(input.reason, 'reason', { max: 2000 }),
        targetTeamId: team._id,
        session
      });
      return after;
    });
  }

  async function enableTeam({ authContext, req, teamId, input = {} } = {}) {
    assertGlobalTeamControl(authContext);
    const requestedTeamId = normalizeObjectId(teamId, 'Team');
    assertAllowedKeys(input, new Set(['reason']));

    return transaction(async (session) => {
      const team = await ProjectTeamModel.findOne({ _id: requestedTeamId }).session(session);
      if (!team) throw notFound('Team');
      if (team.status !== TEAM_STATUSES.DISABLED) {
        throw managementError(409, 'TEAM_ALREADY_ACTIVE', 'The team is already active');
      }
      const before = serializeTeam(team);
      team.status = TEAM_STATUSES.ACTIVE;
      await team.save({ session });
      const after = serializeTeam(team);
      await auditService.record({
        req,
        authContext,
        action: AUDIT_ACTIONS.ENABLE,
        resourceType: AUDIT_RESOURCE_TYPES.PROJECT_TEAM,
        resourceId: team._id,
        before,
        after,
        reason: optionalString(input.reason, 'reason', { max: 2000 }),
        targetTeamId: team._id,
        session
      });
      return after;
    });
  }

  async function listOrgUnits({ authContext, status } = {}) {
    assertTeamAdministrativePermission(authContext, 'org.manage');
    const teamId = activeTeamId(authContext);
    const query = {
      teamId,
      status: { $in: [...manageableOrgStatusSet] }
    };
    if (status !== undefined) {
      if (!manageableOrgStatusSet.has(status)) throw inputError('status is invalid');
      query.status = status;
    }
    const units = await OrgUnitModel.find(query)
      .sort({ level: 1, path: 1, sortOrder: 1, name: 1, _id: 1 })
      .lean();
    return units.map(serializeOrgUnit);
  }

  async function resolveParent({ teamId, parentId, session, movingUnit = null }) {
    if (parentId === null || parentId === undefined || parentId === '') return null;
    const normalizedParentId = normalizeObjectId(parentId, 'Parent organization unit');
    const parent = await OrgUnitModel.findOne({
      _id: normalizedParentId,
      teamId,
      status: { $in: [...manageableOrgStatusSet] }
    }).session(session);
    if (!parent) throw notFound('Parent organization unit');
    if (parent.status !== ORG_UNIT_STATUSES.ACTIVE) {
      throw inputError('parentId must reference an active organization unit');
    }
    const lockedParent = await lockActiveOrgUnitReference({
      OrgUnitModel,
      teamId,
      orgUnitId: parent._id,
      session
    });
    if (!lockedParent) throw notFound('Parent organization unit');
    if (movingUnit) {
      const movingId = normalizeId(movingUnit._id);
      if (normalizeId(parent._id) === movingId || parent.path.includes(`/${movingId}/`)) {
        throw inputError('An organization unit cannot be moved below itself');
      }
    }
    return lockedParent;
  }

  async function createOrgUnit({ authContext, req, input } = {}) {
    assertTeamAdministrativePermission(authContext, 'org.manage');
    const teamId = activeTeamId(authContext);
    assertAllowedKeys(input, new Set([
      'parentId', 'type', 'code', 'name', 'status', 'sortOrder', 'reason'
    ]));
    if (input.type !== undefined && !orgTypeSet.has(input.type)) {
      throw inputError('type is invalid');
    }
    if (input.status !== undefined && !manageableOrgStatusSet.has(input.status)) {
      throw inputError('status is invalid');
    }
    if (
      input.sortOrder !== undefined &&
      (!Number.isInteger(input.sortOrder) || input.sortOrder < 0)
    ) {
      throw inputError('sortOrder must be a non-negative integer');
    }

    return transaction(async (session) => {
      const parent = await resolveParent({ teamId, parentId: input.parentId, session });
      const level = parent ? parent.level + 1 : 1;
      if (level > 5) throw inputError('Organization hierarchy cannot exceed five levels');
      const orgUnit = new OrgUnitModel({
        teamId,
        parentId: parent?._id || null,
        type: input.type || (parent ? ORG_UNIT_TYPES.SUB_DEPARTMENT : ORG_UNIT_TYPES.DEPARTMENT),
        code: normalizeCode(input.code),
        name: requiredString(input.name, 'name'),
        status: input.status,
        sortOrder: input.sortOrder,
        level,
        path: parent ? `${parent.path}${normalizeId(parent._id)}/` : '/'
      });
      await orgUnit.save({ session });
      const after = serializeOrgUnit(orgUnit);
      await auditService.record({
        req,
        authContext,
        action: AUDIT_ACTIONS.CREATE,
        resourceType: AUDIT_RESOURCE_TYPES.ORG_UNIT,
        resourceId: orgUnit._id,
        after,
        reason: optionalString(input.reason, 'reason', { max: 2000 }),
        targetTeamId: teamId,
        session
      });
      return after;
    });
  }

  async function updateOrgUnit({ authContext, req, orgUnitId, input } = {}) {
    assertTeamAdministrativePermission(authContext, 'org.manage');
    const teamId = activeTeamId(authContext);
    const requestedOrgUnitId = normalizeObjectId(orgUnitId, 'Organization unit');
    assertAllowedKeys(input, new Set([
      'parentId', 'type', 'code', 'name', 'status', 'sortOrder', 'reason'
    ]));
    if (Object.keys(input).every((key) => key === 'reason')) {
      throw inputError('At least one organization unit field must be supplied');
    }
    if (input.type !== undefined && !orgTypeSet.has(input.type)) throw inputError('type is invalid');
    if (input.status !== undefined && !manageableOrgStatusSet.has(input.status)) {
      throw inputError('status is invalid');
    }
    if (
      input.sortOrder !== undefined &&
      (!Number.isInteger(input.sortOrder) || input.sortOrder < 0)
    ) {
      throw inputError('sortOrder must be a non-negative integer');
    }

    return transaction(async (session) => {
      const orgUnit = await OrgUnitModel.findOne({
        _id: requestedOrgUnitId,
        teamId,
        status: { $in: [...manageableOrgStatusSet] }
      }).session(session);
      if (!orgUnit) throw notFound('Organization unit');
      const before = serializeOrgUnit(orgUnit);
      const parentId = Object.prototype.hasOwnProperty.call(input, 'parentId')
        ? input.parentId
        : orgUnit.parentId;
      const parent = await resolveParent({
        teamId,
        parentId,
        session,
        movingUnit: orgUnit
      });
      const nextLevel = parent ? parent.level + 1 : 1;
      const nextPath = parent ? `${parent.path}${normalizeId(parent._id)}/` : '/';
      const levelDelta = nextLevel - orgUnit.level;
      const oldDescendantPrefix = `${orgUnit.path}${normalizeId(orgUnit._id)}/`;
      const descendants = await OrgUnitModel.find({
        teamId,
        status: { $in: [...manageableOrgStatusSet] },
        path: { $regex: `^${oldDescendantPrefix}` }
      }).session(session);
      const deepestLevel = descendants.reduce(
        (maximum, descendant) => Math.max(maximum, descendant.level),
        orgUnit.level
      );
      if (deepestLevel + levelDelta > 5) {
        throw inputError('Moving this organization unit would exceed five levels');
      }
      if (
        input.status === ORG_UNIT_STATUSES.DISABLED &&
        orgUnit.status !== ORG_UNIT_STATUSES.DISABLED
      ) {
        const activeDescendant = descendants.some(
          (descendant) => descendant.status === ORG_UNIT_STATUSES.ACTIVE
        );
        const subtreeIds = [orgUnit._id, ...descendants.map((descendant) => descendant._id)];
        const activeMembershipExists = await TeamMembershipModel.exists({
          teamId,
          orgUnitId: { $in: subtreeIds },
          status: MEMBERSHIP_STATUSES.ACTIVE
        }).session(session);
        if (activeDescendant || activeMembershipExists) {
          throw managementError(
            409,
            'ORG_UNIT_HAS_ACTIVE_DEPENDENCIES',
            'Disable active child units and memberships before disabling this organization unit'
          );
        }
      }

      orgUnit.parentId = parent?._id || null;
      orgUnit.level = nextLevel;
      orgUnit.path = nextPath;
      if (input.type !== undefined) orgUnit.type = input.type;
      if (input.code !== undefined) orgUnit.code = normalizeCode(input.code);
      if (input.name !== undefined) orgUnit.name = requiredString(input.name, 'name');
      if (input.status !== undefined) orgUnit.status = input.status;
      if (input.sortOrder !== undefined) orgUnit.sortOrder = input.sortOrder;
      await orgUnit.save({ session });

      const newDescendantPrefix = `${nextPath}${normalizeId(orgUnit._id)}/`;
      for (const descendant of descendants) {
        descendant.path = `${newDescendantPrefix}${descendant.path.slice(oldDescendantPrefix.length)}`;
        descendant.level += levelDelta;
        await descendant.save({ session });
      }

      const after = serializeOrgUnit(orgUnit);
      await auditService.record({
        req,
        authContext,
        action: input.status === ORG_UNIT_STATUSES.ACTIVE && before.status !== input.status
          ? AUDIT_ACTIONS.ENABLE
          : input.status === ORG_UNIT_STATUSES.DISABLED && before.status !== input.status
            ? AUDIT_ACTIONS.DISABLE
            : AUDIT_ACTIONS.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPES.ORG_UNIT,
        resourceId: orgUnit._id,
        before,
        after: { ...after, movedDescendantCount: descendants.length },
        reason: optionalString(input.reason, 'reason', { max: 2000 }),
        targetTeamId: teamId,
        session
      });
      return after;
    });
  }

  async function deleteOrgUnit({ authContext, req, orgUnitId, input = {} } = {}) {
    assertTeamAdministrativePermission(authContext, 'org.manage');
    const teamId = activeTeamId(authContext);
    const requestedOrgUnitId = normalizeObjectId(orgUnitId, 'Organization unit');
    assertAllowedKeys(input, new Set(['reason']));
    const reason = requiredString(input.reason, 'reason', { max: 2000 });

    return transaction(async (session) => {
      const orgUnit = await OrgUnitModel.findOne({
        _id: requestedOrgUnitId,
        teamId,
        status: { $in: [...manageableOrgStatusSet] }
      }).session(session);
      if (!orgUnit) throw notFound('Organization unit');

      const childExists = await OrgUnitModel.exists({
        teamId,
        parentId: orgUnit._id,
        status: { $in: [...manageableOrgStatusSet] }
      }).session(session);
      if (childExists) {
        throw managementError(
          409,
          'ORG_UNIT_DELETE_HAS_CHILDREN',
          '该组织仍有下级组织，请先删除下级组织'
        );
      }

      const dependency = await orgUnitDependencyFinder({
        teamId,
        orgUnitId: orgUnit._id,
        session
      });
      if (dependency) {
        throw managementError(
          409,
          'ORG_UNIT_DELETE_HAS_REFERENCES',
          '该组织仍有关联成员或业务数据，不能删除'
        );
      }

      const before = serializeOrgUnit(orgUnit);
      orgUnit.status = ORG_UNIT_STATUSES.DELETED;
      orgUnit.deletedAt = clock();
      orgUnit.deletedBy = authContext.userId;
      orgUnit.deletionReason = reason;
      orgUnit.$locals.allowOrgUnitSoftDelete = true;
      await orgUnit.save({ session });
      const after = serializeOrgUnitTombstone(orgUnit);
      await auditService.record({
        req,
        authContext,
        action: AUDIT_ACTIONS.DELETE,
        resourceType: AUDIT_RESOURCE_TYPES.ORG_UNIT,
        resourceId: orgUnit._id,
        before,
        after,
        reason,
        targetTeamId: teamId,
        session
      });
      return before;
    });
  }

  async function listMembers({ authContext, filters = {} } = {}) {
    assertTeamContext(authContext);
    if (!hasEffectivePermission(authContext, 'member.view')) {
      throw permissionDenied();
    }
    const teamId = activeTeamId(authContext);
    const query = { teamId };
    if (filters.status !== undefined) {
      if (![MEMBERSHIP_STATUSES.ACTIVE, MEMBERSHIP_STATUSES.DISABLED].includes(filters.status)) {
        throw inputError('status is invalid');
      }
      query.status = filters.status;
    }
    if (filters.role !== undefined) {
      if (!membershipRoleSet.has(filters.role)) throw inputError('role is invalid');
      query.role = filters.role;
    }
    const page = filters.page === undefined ? 1 : Number(filters.page);
    const limit = filters.limit === undefined ? 50 : Number(filters.limit);
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw inputError('page and limit are invalid');
    }

    const systemUserIds = await UserModel.distinct('_id', { isSystemAccount: true });
    if (systemUserIds.length > 0) {
      query.userId = { $nin: systemUserIds };
    }

    const [memberships, total] = await Promise.all([
      TeamMembershipModel.find(query)
        .populate({ path: 'userId', select: '_id username name phone email avatar status' })
        .populate({ path: 'orgUnitId', select: '_id teamId parentId type code name status sortOrder level path' })
        .sort({ createdAt: 1, _id: 1 })
        .skip((page - 1) * limit)
        .limit(limit),
      TeamMembershipModel.countDocuments(query)
    ]);
    return {
      members: memberships.map((membership) => {
        const populatedUser = membership.populated('userId') ? membership.userId : null;
        const populatedOrgUnit = membership.populated('orgUnitId') ? membership.orgUnitId : null;
        const raw = membership.toObject({ depopulate: true });
        return serializeMembership(raw, { user: populatedUser, orgUnit: populatedOrgUnit });
      }),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    };
  }

  function assertManageMember(context, targetMembership = null, requestedRole = undefined) {
    assertTeamAdministrativePermission(context, 'member.manage');
    if (context.isSuperAdmin === true) return;
    if (targetMembership && targetMembership.role !== MEMBERSHIP_ROLES.MEMBER) {
      throw permissionDenied('Project administrators can maintain members only');
    }
    if (requestedRole !== undefined && requestedRole !== MEMBERSHIP_ROLES.MEMBER) {
      throw permissionDenied('Project administrators cannot grant the project administrator role');
    }
  }

  async function findActiveOrgUnit(teamId, orgUnitId, session) {
    const requestedOrgId = normalizeObjectId(orgUnitId, 'Organization unit');
    const orgUnit = await lockActiveOrgUnitReference({
      OrgUnitModel,
      teamId,
      orgUnitId: requestedOrgId,
      session
    });
    if (!orgUnit) throw notFound('Organization unit');
    return orgUnit;
  }

  function changesFunctionalRoleAssignment(
    role,
    beforeRoles = [],
    afterRoles = [],
    beforeStatus = null,
    afterStatus = null,
    beforeOrgUnitId = null,
    afterOrgUnitId = null
  ) {
    const beforeAssigned = beforeRoles.includes(role);
    const afterAssigned = afterRoles.includes(role);
    const beforeEffective = beforeAssigned && beforeStatus === MEMBERSHIP_STATUSES.ACTIVE;
    const afterEffective = afterAssigned && afterStatus === MEMBERSHIP_STATUSES.ACTIVE;
    const effectiveOrgChanged = (
      beforeEffective &&
      afterEffective &&
      normalizeId(beforeOrgUnitId) !== normalizeId(afterOrgUnitId)
    );
    return (
      beforeAssigned !== afterAssigned ||
      beforeEffective !== afterEffective ||
      effectiveOrgChanged
    );
  }

  function assertReporterRoleAssignment({
    context,
    beforeRoles,
    afterRoles,
    beforeStatus,
    afterStatus,
    beforeOrgUnitId,
    afterOrgUnitId,
    orgUnit
  }) {
    const afterAssigned = afterRoles.includes(FUNCTIONAL_ROLE_KEYS.ATTENDANCE_REPORTER);
    if (
      afterAssigned &&
      (orgUnit?.type !== ORG_UNIT_TYPES.SUB_DEPARTMENT || orgUnit?.level !== 2)
    ) {
      throw inputError(
        'An attendance reporter must be assigned to a sub-department',
        'ATTENDANCE_REPORTER_ORG_REQUIRED'
      );
    }
    const protectedReporterRoleChanged = [
      FUNCTIONAL_ROLE_KEYS.ATTENDANCE_REPORTER,
      FUNCTIONAL_ROLE_KEYS.TRANSPORT_REPORTER
    ].some((role) => changesFunctionalRoleAssignment(
      role,
      beforeRoles,
      afterRoles,
      beforeStatus,
      afterStatus,
      beforeOrgUnitId,
      afterOrgUnitId
    ));
    if (
      protectedReporterRoleChanged &&
      context.isSuperAdmin !== true &&
      !context.permissionKeys?.includes('reporter.assign')
    ) {
      throw permissionDenied('The reporter.assign permission is required');
    }
  }

  async function createMember({ authContext, req, input } = {}) {
    rejectPrivilegeFields(input);
    assertAllowedKeys(input, new Set([
      'username', 'password', 'name', 'phone', 'email', 'existingUserId',
      'orgUnitId', 'role', 'positionKey', 'functionalRoleKeys', 'permissionKeys',
      'status', 'reason'
    ]));
    const requestedRole = normalizeMembershipRole(input.role, MEMBERSHIP_ROLES.MEMBER);
    assertManageMember(authContext, null, requestedRole);
    const teamId = activeTeamId(authContext);
    if (input.existingUserId !== undefined && authContext.isSuperAdmin !== true) {
      throw permissionDenied('Only a super administrator can add an existing global identity');
    }
    const positionKey = normalizePositionKey(input.positionKey) || POSITION_KEYS.EMPLOYEE;
    const functionalRoleKeys = normalizeFunctionalRoleKeys(input.functionalRoleKeys) || [];
    const permissionKeys = normalizePermissionKeys(input.permissionKeys) || (
      requestedRole === MEMBERSHIP_ROLES.PROJECT_ADMIN
        ? [...DEFAULT_PROJECT_ADMIN_PERMISSIONS]
        : []
    );
    if (
      input.status !== undefined &&
      ![MEMBERSHIP_STATUSES.ACTIVE, MEMBERSHIP_STATUSES.DISABLED].includes(input.status)
    ) {
      throw inputError('status is invalid');
    }

    return transaction(async (session) => {
      const orgUnit = await findActiveOrgUnit(teamId, input.orgUnitId, session);
      assertReporterRoleAssignment({
        context: authContext,
        beforeRoles: [],
        afterRoles: functionalRoleKeys,
        beforeStatus: null,
        afterStatus: input.status || MEMBERSHIP_STATUSES.ACTIVE,
        beforeOrgUnitId: null,
        afterOrgUnitId: orgUnit._id,
        orgUnit
      });
      let user;
      let createdUser = false;
      if (input.existingUserId !== undefined) {
        const existingUserId = normalizeObjectId(input.existingUserId, 'User');
        user = await UserModel.findOne({
          _id: existingUserId,
          status: 'active',
          isSystemAccount: { $ne: true },
          // A user-level super administrator is deliberately membership-free.
          // Keep the identity global instead of silently turning it into a
          // team member with a second, potentially stale permission source.
          isSuperAdmin: false
        }).session(session);
        if (!user) throw notFound('User');
      } else {
        const username = requiredString(input.username, 'username', { min: 3, max: 50 });
        const password = requiredString(input.password, 'password', { min: 6, max: 200 });
        const name = requiredString(input.name, 'name');
        user = new UserModel({
          username,
          password,
          name,
          phone: optionalString(input.phone, 'phone', { max: 30 }),
          email: optionalString(input.email, 'email', { max: 254 }),
          roles: ['executor'],
          isSuperAdmin: false,
          isSystemAccount: false,
          tokenVersion: 0,
          status: 'active'
        });
        await user.save({ session });
        createdUser = true;
        await auditService.record({
          req,
          authContext,
          action: AUDIT_ACTIONS.CREATE,
          resourceType: AUDIT_RESOURCE_TYPES.USER,
          resourceId: user._id,
          after: serializeUser(user),
          reason: optionalString(input.reason, 'reason', { max: 2000 }),
          targetTeamId: teamId,
          session
        });
      }

      const membership = new TeamMembershipModel({
        teamId,
        userId: user._id,
        orgUnitId: orgUnit._id,
        role: requestedRole,
        positionKey,
        positionLevel: POSITION_LEVEL_BY_KEY[positionKey],
        functionalRoleKeys,
        permissionKeys,
        status: input.status || MEMBERSHIP_STATUSES.ACTIVE
      });
      applyDerivedMembershipFields(membership);
      await lockSubDepartmentLeadership({
        OrgUnitModel,
        teamId,
        orgUnitIds: [membership.orgUnitId],
        session
      });
      await membership.save({ session });
      const after = serializeMembership(membership, { user, orgUnit });
      if (
        typeof repairTodoSynchronizer === 'function' &&
        membershipMayReceiveRepairTodo(after)
      ) {
        await repairTodoSynchronizer({ teamId, session });
      }
      await auditService.record({
        req,
        authContext,
        action: AUDIT_ACTIONS.CREATE,
        resourceType: AUDIT_RESOURCE_TYPES.TEAM_MEMBERSHIP,
        resourceId: membership._id,
        after: memberAuditSnapshot(membership, user),
        reason: optionalString(input.reason, 'reason', { max: 2000 }),
        targetTeamId: teamId,
        session
      });
      return { member: after, createdUser };
    });
  }

  async function updateMember({ authContext, req, membershipId, input } = {}) {
    rejectPrivilegeFields(input);
    assertAllowedKeys(input, new Set([
      'orgUnitId', 'role', 'positionKey', 'functionalRoleKeys', 'permissionKeys',
      'status', 'reason'
    ]));
    if (Object.keys(input).every((key) => key === 'reason')) {
      throw inputError('At least one membership field must be supplied');
    }
    const teamId = activeTeamId(authContext);
    const requestedMembershipId = normalizeObjectId(membershipId, 'Team membership');
    const requestedRole = normalizeMembershipRole(input.role);
    const positionKey = normalizePositionKey(input.positionKey);
    const functionalRoleKeys = normalizeFunctionalRoleKeys(input.functionalRoleKeys);
    const permissionKeys = normalizePermissionKeys(input.permissionKeys);
    if (
      input.status !== undefined &&
      ![MEMBERSHIP_STATUSES.ACTIVE, MEMBERSHIP_STATUSES.DISABLED].includes(input.status)
    ) {
      throw inputError('status is invalid');
    }

    return transaction(async (session) => {
      const membership = await TeamMembershipModel.findOne({
        _id: requestedMembershipId,
        teamId
      }).session(session);
      if (!membership) throw notFound('Team membership');
      assertManageMember(authContext, membership, requestedRole);
      const user = await UserModel.findOne({
        _id: membership.userId,
        isSystemAccount: { $ne: true }
      }).session(session);
      if (!user) throw notFound('Team membership');
      const before = memberAuditSnapshot(membership, user);
      const beforeOrgUnitId = membership.orgUnitId;
      let orgUnit = null;
      if (input.orgUnitId !== undefined) {
        orgUnit = await findActiveOrgUnit(teamId, input.orgUnitId, session);
        membership.orgUnitId = orgUnit._id;
      }
      if (requestedRole !== undefined) membership.role = requestedRole;
      if (positionKey !== undefined) membership.positionKey = positionKey;
      if (functionalRoleKeys !== undefined) membership.functionalRoleKeys = functionalRoleKeys;
      if (permissionKeys !== undefined) membership.permissionKeys = permissionKeys;
      if (input.status !== undefined) membership.status = input.status;
      if (!orgUnit) {
        orgUnit = await OrgUnitModel.findOne({
          _id: membership.orgUnitId,
          teamId,
          status: ORG_UNIT_STATUSES.ACTIVE
        }).session(session);
      }
      if (!orgUnit) throw notFound('Organization unit');
      assertReporterRoleAssignment({
        context: authContext,
        beforeRoles: before.functionalRoleKeys,
        afterRoles: membership.functionalRoleKeys,
        beforeStatus: before.status,
        afterStatus: membership.status,
        beforeOrgUnitId: before.orgUnitId,
        afterOrgUnitId: membership.orgUnitId,
        orgUnit
      });
      applyDerivedMembershipFields(membership);
      await lockSubDepartmentLeadership({
        OrgUnitModel,
        teamId,
        orgUnitIds: [beforeOrgUnitId, membership.orgUnitId],
        session
      });
      await membership.save({ session });
      const after = memberAuditSnapshot(membership, user);
      if (
        typeof repairTodoSynchronizer === 'function' &&
        repairRecipientFieldsChanged(before, after) &&
        (membershipMayReceiveRepairTodo(before) || membershipMayReceiveRepairTodo(after))
      ) {
        await repairTodoSynchronizer({ teamId, session });
      }

      const auditEntries = [];
      if (before.role !== after.role) {
        auditEntries.push({ action: AUDIT_ACTIONS.ROLE_UPDATE, before, after });
      }
      if (JSON.stringify(before.permissionKeys) !== JSON.stringify(after.permissionKeys)) {
        auditEntries.push({ action: AUDIT_ACTIONS.PERMISSION_UPDATE, before, after });
      }
      if (before.status !== after.status) {
        auditEntries.push({
          action: after.status === MEMBERSHIP_STATUSES.ACTIVE
            ? AUDIT_ACTIONS.ENABLE
            : AUDIT_ACTIONS.DISABLE,
          before,
          after
        });
      }
      if (auditEntries.length === 0) {
        auditEntries.push({ action: AUDIT_ACTIONS.UPDATE, before, after });
      }
      for (const entry of auditEntries) {
        await auditService.record({
          req,
          authContext,
          ...entry,
          resourceType: AUDIT_RESOURCE_TYPES.TEAM_MEMBERSHIP,
          resourceId: membership._id,
          reason: optionalString(input.reason, 'reason', { max: 2000 }),
          targetTeamId: teamId,
          session
        });
      }

      return serializeMembership(membership, { user, orgUnit });
    });
  }

  async function disableMember({ authContext, req, membershipId, reason = null } = {}) {
    return updateMember({
      authContext,
      req,
      membershipId,
      input: { status: MEMBERSHIP_STATUSES.DISABLED, reason }
    });
  }

  return Object.freeze({
    createMember,
    createOrgUnit,
    createTeam,
    deleteOrgUnit,
    disableMember,
    enableTeam,
    listMembers,
    listOrgUnits,
    listTeams,
    updateMember,
    updateOrgUnit,
    updateTeamStatus
  });
}

module.exports = {
  DEFAULT_PROJECT_ADMIN_PERMISSIONS,
  TeamManagementError,
  createTeamManagementService,
  serializeMembership,
  serializeOrgUnit,
  serializeTeam
};
