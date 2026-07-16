'use strict';

const User = require('../models/User');
const TeamMembership = require('../models/TeamMembership');
const {
  DATA_SCOPES,
  MEMBERSHIP_ROLES,
  MEMBERSHIP_STATUSES
} = require('../config/permissions');
const { normalizeObjectId } = require('../services/scopedQueryService');
const { AuthContextError } = require('../services/authContextError');
const { resolveModuleDataScope } = require('../services/teamContextService');

const LEGACY_WRITE_RESPONSE = Object.freeze({
  message: 'Legacy user write API is disabled; use /api/team-members',
  code: 'LEGACY_USER_WRITE_DISABLED',
  replacement: '/api/team-members'
});

function legacyInputError(message) {
  return new AuthContextError(400, 'LEGACY_USERS_INVALID_FILTER', message);
}

function idOf(value) {
  if (value === undefined || value === null) return '';
  return String(value._id || value);
}

function sameId(left, right) {
  const leftId = idOf(left).toLowerCase();
  const rightId = idOf(right).toLowerCase();
  return Boolean(leftId && rightId && leftId === rightId);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parsePagination(query = {}) {
  const page = query.page === undefined ? 1 : Number(query.page);
  const limit = query.limit === undefined ? 10 : Number(query.limit);
  if (!Number.isInteger(page) || page < 1) {
    throw legacyInputError('page must be a positive integer');
  }
  // The existing task assignment form requests up to 1000 users in one call.
  // This remains bounded by the active team before any user document is read.
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw legacyInputError('limit must be an integer between 1 and 1000');
  }
  return { page, limit };
}

function activeTeamId(req) {
  return normalizeObjectId(req.authContext?.activeTeamId, 'activeTeamId');
}

function membershipScopeFilter(req) {
  const dataScope = resolveModuleDataScope(req.authContext, 'task');
  const filter = { teamId: activeTeamId(req) };
  if (dataScope.scope === DATA_SCOPES.ORG_UNIT) {
    filter.orgUnitId = normalizeObjectId(dataScope.orgUnitId, 'orgUnitId');
  }
  return filter;
}

function legacyRolesFor(membership, user) {
  if (membership.role === MEMBERSHIP_ROLES.PROJECT_ADMIN) return ['admin'];
  const taskRoles = Array.isArray(user.roles)
    ? user.roles.filter((role) => role === 'executor' || role === 'cc')
    : [];
  return taskRoles.length > 0 ? [...new Set(taskRoles)] : ['executor'];
}

function serializeLegacyUser(membership) {
  const user = membership.userId;
  const orgUnit = membership.orgUnitId;
  return {
    _id: user._id,
    username: user.username,
    name: user.name,
    phone: user.phone || '',
    email: user.email || '',
    roles: legacyRolesFor(membership, user),
    department: orgUnit && sameId(orgUnit.teamId, membership.teamId)
      ? orgUnit.name || ''
      : '',
    status: user.status,
    avatar: user.avatar || '',
    lastLoginAt: user.lastLoginAt || null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    membership: {
      _id: membership._id,
      teamId: membership.teamId,
      orgUnitId: orgUnit?._id || membership.orgUnitId || null,
      role: membership.role,
      positionLevel: membership.positionLevel,
      positionKey: membership.positionKey,
      functionalRoleKeys: membership.functionalRoleKeys || [],
      permissionKeys: membership.permissionKeys || [],
      status: membership.status
    }
  };
}

function membershipMatchesFilters(membership, filters) {
  const user = membership.userId;
  if (!user) return false;

  if (filters.userStatus && user.status !== filters.userStatus) return false;
  if (filters.membershipStatus && membership.status !== filters.membershipStatus) return false;

  const legacyRoles = legacyRolesFor(membership, user);
  if (filters.membershipRole && membership.role !== filters.membershipRole) return false;
  if (filters.legacyRole && !legacyRoles.includes(filters.legacyRole)) return false;

  if (filters.keywordPattern) {
    const searchable = [user.username, user.name, user.phone, user.email]
      .filter((value) => typeof value === 'string');
    if (!searchable.some((value) => filters.keywordPattern.test(value))) return false;
  }
  return true;
}

function parseFilters(query = {}) {
  const filters = {};
  if (query.status !== undefined && query.status !== '') {
    if (query.status === 'active' || query.status === 'inactive') {
      filters.userStatus = query.status;
    } else if (
      query.status === MEMBERSHIP_STATUSES.ACTIVE ||
      query.status === MEMBERSHIP_STATUSES.DISABLED
    ) {
      filters.membershipStatus = query.status;
    } else {
      throw legacyInputError('status is invalid');
    }
  }

  if (query.role !== undefined && query.role !== '') {
    if (query.role === MEMBERSHIP_ROLES.PROJECT_ADMIN || query.role === 'admin') {
      filters.membershipRole = MEMBERSHIP_ROLES.PROJECT_ADMIN;
    } else if (query.role === MEMBERSHIP_ROLES.MEMBER) {
      filters.membershipRole = MEMBERSHIP_ROLES.MEMBER;
    } else if (query.role === 'executor' || query.role === 'cc') {
      filters.legacyRole = query.role;
    } else {
      throw legacyInputError('role is invalid');
    }
  }

  if (query.keyword !== undefined && query.keyword !== '') {
    const keyword = String(query.keyword).trim();
    if (keyword.length > 100) throw legacyInputError('keyword is too long');
    filters.keywordPattern = new RegExp(escapeRegExp(keyword), 'i');
  }
  return filters;
}

function notFound(res) {
  return res.status(404).json({ message: '用户不存在', code: 'USER_NOT_FOUND' });
}

function disabledLegacyWrite(_req, res) {
  return res.status(410).json(LEGACY_WRITE_RESPONSE);
}

function createUserController(overrides = {}) {
  const UserModel = overrides.User || User;
  const TeamMembershipModel = overrides.TeamMembership || TeamMembership;

  async function getAllUsers(req, res, next) {
    try {
      const { page, limit } = parsePagination(req.query);
      const filters = parseFilters(req.query);
      const memberships = await TeamMembershipModel.find(membershipScopeFilter(req))
        .populate({
          path: 'userId',
          select: '_id username name phone email roles status avatar lastLoginAt createdAt updatedAt'
        })
        .populate({ path: 'orgUnitId', select: '_id teamId name' })
        .sort({ createdAt: -1, _id: -1 })
        .lean();
      const matchingMemberships = memberships.filter(
        (membership) => membershipMatchesFilters(membership, filters)
      );
      const total = matchingMemberships.length;
      const pageMemberships = matchingMemberships.slice((page - 1) * limit, page * limit);

      return res.json({
        users: pageMemberships.map(serializeLegacyUser),
        pagination: {
          total,
          page,
          limit,
          pages: Math.ceil(total / limit)
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  async function getUserById(req, res, next) {
    let userId;
    try {
      userId = normalizeObjectId(req.params.id, 'id');
    } catch {
      return notFound(res);
    }

    try {
      const membership = await TeamMembershipModel.findOne({
        ...membershipScopeFilter(req),
        userId
      })
        .populate({
          path: 'userId',
          select: '_id username name phone email roles status avatar lastLoginAt createdAt updatedAt'
        })
        .populate({ path: 'orgUnitId', select: '_id teamId name' })
        .lean();
      if (!membership?.userId) return notFound(res);

      // A second scoped lookup prevents a custom populate implementation from
      // substituting an unrelated global identity.
      const userExists = await UserModel.exists({ _id: userId });
      if (!userExists || !sameId(membership.userId._id, userId)) return notFound(res);
      return res.json({ user: serializeLegacyUser(membership) });
    } catch (error) {
      return next(error);
    }
  }

  return {
    getAllUsers,
    getUserById,
    createUser: disabledLegacyWrite,
    updateUser: disabledLegacyWrite,
    deleteUser: disabledLegacyWrite,
    resetPassword: disabledLegacyWrite
  };
}

const controller = createUserController();

module.exports = {
  ...controller,
  createUserController,
  LEGACY_WRITE_RESPONSE
};
