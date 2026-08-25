'use strict';

const ProjectTeam = require('../models/ProjectTeam');
const TeamMembership = require('../models/TeamMembership');
const User = require('../models/User');
const { SYSTEM_ACCOUNT_DISPLAY_NAME } = require('../config/systemAccount');
const {
  AUDIT_ACTIONS,
  AUDIT_ACTOR_ROLES,
  AUDIT_RESOURCE_TYPES,
  MEMBERSHIP_STATUSES,
  MEMBERSHIP_ROLES,
  SESSION_MODES,
  SESSION_REVOKE_REASONS,
  TEAM_STATUSES
} = require('../config/permissions');
const { createAuditService } = require('../services/auditService');
const { normalizeId } = require('../services/authSessionService');
const { createSessionLifecycleService } = require('../services/sessionLifecycleService');
const { maskDemoResponse } = require('../services/readOnlyDemoDataMaskingService');
const { runWithOptionalTransaction } = require('../services/transactionService');
const {
  AUTH_ERROR_CODES,
  AuthContextError,
  isAuthContextError,
  sendAuthContextError
} = require('../services/authContextError');

const sessionLifecycle = createSessionLifecycleService();
const auditService = createAuditService();
const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

const API_ERROR_CODES = Object.freeze({
  CREDENTIALS_INVALID: 'AUTH_CREDENTIALS_INVALID',
  INPUT_INVALID: 'AUTH_INPUT_INVALID',
  OLD_PASSWORD_INVALID: 'AUTH_OLD_PASSWORD_INVALID',
  REGISTRATION_MOVED: 'AUTH_REGISTRATION_MOVED',
  TEAM_ACCESS_REQUIRED: 'AUTH_TEAM_ACCESS_REQUIRED'
});

const PHONE_PATTERN = /^1[3-9]\d{9}$/;
const EMAIL_PATTERN = /^\S+@\S+\.\S+$/;

function sendError(res, status, code, message) {
  return res.status(status).json({ message, code });
}

function handleError(res, next, error) {
  if (isAuthContextError(error)) return sendAuthContextError(res, error);
  return next(error);
}

function withDatabaseSession(query, session) {
  return session && query && typeof query.session === 'function'
    ? query.session(session)
    : query;
}

function loginAuditContext({ user, mode, activeTeamId, teams }) {
  const team = activeTeamId
    ? teams.find((candidate) => candidate._id === normalizeId(activeTeamId))
    : null;
  const isProjectAdmin = team?.membership?.role === MEMBERSHIP_ROLES.PROJECT_ADMIN;

  return {
    userId: normalizeId(user._id),
    isSuperAdmin: user.isSuperAdmin === true,
    mode,
    activeTeamId: normalizeId(activeTeamId),
    membership: team?.membership || null,
    actorRole: user.isSuperAdmin === true
      ? AUDIT_ACTOR_ROLES.SUPER_ADMIN
      : isProjectAdmin
        ? AUDIT_ACTOR_ROLES.PROJECT_ADMIN
        : AUDIT_ACTOR_ROLES.MEMBER
  };
}

async function recordLoginFailure(req, usernameNormalized, failureReason) {
  try {
    await auditService.recordSystem({
      req,
      action: AUDIT_ACTIONS.LOGIN_FAILURE,
      resourceType: AUDIT_RESOURCE_TYPES.AUTH_SESSION,
      after: {
        usernameNormalized,
        failureReason
      }
    });
  } catch (error) {
    // Authentication responses must remain indistinguishable even if security
    // event persistence is temporarily unavailable.
    console.error('Failed to persist login failure audit event:', error);
  }
}

function serializeUser(user, overrides = {}) {
  const identity = user.isSystemAccount === true
    ? { name: SYSTEM_ACCOUNT_DISPLAY_NAME }
    : {
        username: user.username,
        name: user.name,
        phone: user.phone,
        email: user.email,
        avatar: user.avatar
      };
  return {
    _id: normalizeId(user._id),
    ...identity,
    roles: Array.isArray(user.roles) ? [...user.roles] : [],
    status: user.status,
    isSuperAdmin: user.isSuperAdmin === true,
    lastLoginAt: overrides.lastLoginAt || user.lastLoginAt || null
  };
}

function serializeTeam(team, membership = null) {
  return {
    _id: normalizeId(team._id),
    code: team.code,
    name: team.name,
    status: team.status,
    settings: team.settings
      ? { timeZone: team.settings.timeZone }
      : null,
    membership: membership
      ? {
          _id: normalizeId(membership._id),
          role: membership.role,
          orgUnitId: normalizeId(membership.orgUnitId),
          positionLevel: membership.positionLevel,
          positionKey: membership.positionKey,
          functionalRoleKeys: Array.isArray(membership.functionalRoleKeys)
            ? [...membership.functionalRoleKeys]
            : []
        }
      : null
  };
}

function serializeLoginTeam(team) {
  return {
    _id: normalizeId(team._id),
    code: team.code,
    name: team.name
  };
}

async function findAccessibleTeams({ userId, isSuperAdmin }) {
  if (isSuperAdmin) {
    const teams = await ProjectTeam.find({ status: TEAM_STATUSES.ACTIVE })
      .select('_id code name status settings')
      .sort({ name: 1, _id: 1 })
      .lean();
    return teams.map((team) => serializeTeam(team));
  }

  const memberships = await TeamMembership.find({
    userId,
    status: MEMBERSHIP_STATUSES.ACTIVE
  })
    .select(
      '_id teamId orgUnitId role positionLevel positionKey functionalRoleKeys status'
    )
    .lean();

  if (memberships.length === 0) return [];

  const membershipByTeamId = new Map(
    memberships.map((membership) => [normalizeId(membership.teamId), membership])
  );
  const teams = await ProjectTeam.find({
    _id: { $in: [...membershipByTeamId.keys()] },
    status: TEAM_STATUSES.ACTIVE
  })
    .select('_id code name status settings')
    .sort({ name: 1, _id: 1 })
    .lean();

  return teams.map((team) => (
    serializeTeam(team, membershipByTeamId.get(normalizeId(team._id)))
  ));
}

function serializeIssuedSession(issued, user, teams, lastLoginAt) {
  const response = {
    message: 'Login successful',
    token: issued.token,
    expiresAt: issued.expiresAt,
    mode: issued.claims.mode,
    activeTeamId: issued.claims.activeTeamId || null,
    user: serializeUser(user, { lastLoginAt }),
    teams
  };
  return user.isReadOnlyDemo === true ? maskDemoResponse(response) : response;
}

function serializeRotatedSession(issued) {
  return {
    token: issued.token,
    expiresAt: issued.expiresAt,
    mode: issued.claims.mode,
    activeTeamId: issued.claims.activeTeamId || null
  };
}

exports.listLoginTeams = async (req, res, next) => {
  try {
    const teams = await ProjectTeam.find({ status: TEAM_STATUSES.ACTIVE })
      .select('_id code name')
      .sort({ name: 1, _id: 1 })
      .lean();
    return res.json({ teams: teams.map(serializeLoginTeam) });
  } catch (error) {
    return handleError(res, next, error);
  }
};

exports.login = async (req, res, next) => {
  try {
    const { username, password, teamId } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
      return sendError(
        res,
        400,
        API_ERROR_CODES.INPUT_INVALID,
        'Username and password are required'
      );
    }

    const usernameNormalized = User.normalizeUsername(username);
    const user = await User.findOne({ usernameNormalized });
    const passwordMatches = user ? await user.comparePassword(password) : false;

    // Keep every credential/account-state failure indistinguishable to callers.
    if (!user || !passwordMatches || user.status !== 'active') {
      const failureReason = !user
        ? 'USER_NOT_FOUND'
        : !passwordMatches
          ? 'PASSWORD_MISMATCH'
          : 'USER_DISABLED';
      await recordLoginFailure(req, usernameNormalized, failureReason);
      return sendError(
        res,
        401,
        API_ERROR_CODES.CREDENTIALS_INVALID,
        'Invalid username or password'
      );
    }

    let requestedTeamId = null;
    if (teamId !== undefined && teamId !== null) {
      if (typeof teamId !== 'string' || !OBJECT_ID_PATTERN.test(teamId.trim())) {
        return sendError(
          res,
          400,
          API_ERROR_CODES.INPUT_INVALID,
          'teamId must be a valid project team identifier'
        );
      }
      requestedTeamId = teamId.trim().toLowerCase();
    }

    const teams = await findAccessibleTeams({
      userId: user._id,
      isSuperAdmin: user.isSuperAdmin === true
    });

    let mode;
    let activeTeamId = null;
    if (requestedTeamId) {
      const selectedTeam = teams.find(({ _id }) => _id === requestedTeamId);
      if (!selectedTeam) {
        await recordLoginFailure(req, usernameNormalized, 'SELECTED_TEAM_UNAVAILABLE');
        return sendError(
          res,
          403,
          API_ERROR_CODES.TEAM_ACCESS_REQUIRED,
          'The selected team is unavailable for this account'
        );
      }
      mode = SESSION_MODES.TEAM;
      activeTeamId = selectedTeam._id;
    } else if (user.isSuperAdmin === true) {
      mode = SESSION_MODES.GLOBAL_READ_ONLY;
    } else if (teams.length === 0) {
      await recordLoginFailure(req, usernameNormalized, 'NO_ACTIVE_TEAM');
      return sendError(
        res,
        403,
        API_ERROR_CODES.TEAM_ACCESS_REQUIRED,
        'No active team membership is available'
      );
    } else if (teams.length === 1) {
      mode = SESSION_MODES.TEAM;
      activeTeamId = teams[0]._id;
    } else {
      mode = SESSION_MODES.TEAM_SELECTION;
    }

    let issued;
    let lastLoginAt;
    await runWithOptionalTransaction(async (dbSession) => {
      issued = await sessionLifecycle.issueSession({
        userId: user._id,
        mode,
        activeTeamId,
        tokenVersion: user.tokenVersion
      }, { dbSession });
      lastLoginAt = new Date();
      await withDatabaseSession(
        User.updateOne({ _id: user._id }, { $set: { lastLoginAt } }),
        dbSession
      );
      await auditService.record({
        req,
        authContext: loginAuditContext({ user, mode, activeTeamId, teams }),
        action: AUDIT_ACTIONS.LOGIN_SUCCESS,
        resourceType: AUDIT_RESOURCE_TYPES.AUTH_SESSION,
        resourceId: issued.session._id,
        after: {
          mode,
          activeTeamId: activeTeamId || null,
          expiresAt: issued.expiresAt
        },
        targetTeamId: activeTeamId,
        session: dbSession
      });
    });

    return res.json(serializeIssuedSession(issued, user, teams, lastLoginAt));
  } catch (error) {
    return handleError(res, next, error);
  }
};

exports.listTeams = async (req, res, next) => {
  try {
    const teams = await findAccessibleTeams({
      userId: req.authContext.userId,
      isSuperAdmin: req.authContext.isSuperAdmin
    });
    return res.json({
      teams,
      mode: req.authContext.mode,
      activeTeamId: req.authContext.activeTeamId || null
    });
  } catch (error) {
    return handleError(res, next, error);
  }
};

exports.switchTeam = async (req, res, next) => {
  try {
    const { teamId } = req.body || {};
    if (typeof teamId !== 'string' || !OBJECT_ID_PATTERN.test(teamId)) {
      return sendError(res, 400, API_ERROR_CODES.INPUT_INVALID, 'A valid teamId is required');
    }

    let team;
    if (req.authContext.isSuperAdmin) {
      team = await ProjectTeam.findById(teamId)
        .select('_id status')
        .lean();
      if (!team) {
        throw new AuthContextError(404, AUTH_ERROR_CODES.TEAM_NOT_FOUND, 'The team does not exist');
      }
      if (team.status !== TEAM_STATUSES.ACTIVE) {
        throw new AuthContextError(403, AUTH_ERROR_CODES.TEAM_DISABLED, 'The team is disabled');
      }
    } else {
      const membership = await TeamMembership.findOne({
        teamId,
        userId: req.authContext.userId,
        status: MEMBERSHIP_STATUSES.ACTIVE
      })
        .select('_id')
        .lean();
      if (!membership) {
        throw new AuthContextError(
          404,
          AUTH_ERROR_CODES.TEAM_NOT_FOUND,
          'The team does not exist'
        );
      }
      team = await ProjectTeam.findOne({
        _id: teamId,
        status: TEAM_STATUSES.ACTIVE
      })
        .select('_id status')
        .lean();
      if (!team) {
        throw new AuthContextError(404, AUTH_ERROR_CODES.TEAM_NOT_FOUND, 'The team does not exist');
      }
    }

    const previousMode = req.authContext.mode;
    const previousTeamId = req.authContext.activeTeamId || null;
    const action = previousTeamId
      ? AUDIT_ACTIONS.SWITCH_TEAM
      : AUDIT_ACTIONS.ENTER_TEAM;
    const issued = await runWithOptionalTransaction(async (dbSession) => {
      const nextSession = await sessionLifecycle.rotateSession({
        currentSessionId: req.authContext.sessionId,
        userId: req.authContext.userId,
        mode: SESSION_MODES.TEAM,
        activeTeamId: normalizeId(team._id),
        tokenVersion: req.authContext.tokenVersion,
        reason: SESSION_REVOKE_REASONS.TEAM_SWITCH
      }, { dbSession });
      await auditService.record({
        req,
        action,
        resourceType: AUDIT_RESOURCE_TYPES.AUTH_SESSION,
        resourceId: nextSession.session._id,
        before: {
          mode: previousMode,
          activeTeamId: previousTeamId
        },
        after: {
          mode: SESSION_MODES.TEAM,
          activeTeamId: normalizeId(team._id)
        },
        targetTeamId: team._id,
        session: dbSession
      });
      return nextSession;
    });

    return res.json({
      message: 'Team context switched',
      ...serializeRotatedSession(issued)
    });
  } catch (error) {
    return handleError(res, next, error);
  }
};

exports.enterGlobalReadOnly = async (req, res, next) => {
  try {
    if (!req.authContext.isSuperAdmin) {
      throw new AuthContextError(
        403,
        AUTH_ERROR_CODES.SUPER_ADMIN_REQUIRED,
        'Global read-only access requires a super administrator'
      );
    }

    const previousMode = req.authContext.mode;
    const previousTeamId = req.authContext.activeTeamId || null;
    const issued = await runWithOptionalTransaction(async (dbSession) => {
      const nextSession = await sessionLifecycle.rotateSession({
        currentSessionId: req.authContext.sessionId,
        userId: req.authContext.userId,
        mode: SESSION_MODES.GLOBAL_READ_ONLY,
        activeTeamId: null,
        tokenVersion: req.authContext.tokenVersion,
        reason: SESSION_REVOKE_REASONS.TOKEN_ROTATED
      }, { dbSession });
      await auditService.record({
        req,
        action: AUDIT_ACTIONS.EXIT_TEAM,
        resourceType: AUDIT_RESOURCE_TYPES.AUTH_SESSION,
        resourceId: nextSession.session._id,
        before: {
          mode: previousMode,
          activeTeamId: previousTeamId
        },
        after: {
          mode: SESSION_MODES.GLOBAL_READ_ONLY,
          activeTeamId: null
        },
        targetTeamId: previousTeamId,
        session: dbSession
      });
      return nextSession;
    });

    return res.json({
      message: 'Global read-only context enabled',
      ...serializeRotatedSession(issued)
    });
  } catch (error) {
    return handleError(res, next, error);
  }
};

exports.getCurrentUser = async (req, res) => {
  const context = req.authContext;
  return res.json({
    user: context.user,
    context: {
      mode: context.mode,
      activeTeamId: context.activeTeamId || null,
      isSuperAdmin: context.isSuperAdmin,
      team: context.team,
      membership: context.membership,
      orgUnit: context.orgUnit,
      permissionKeys: context.permissionKeys,
      moduleDataScopes: context.moduleDataScopes,
      readOnly: context.readOnly,
      canAccessBusiness: context.canAccessBusiness
    }
  });
};

exports.updateProfile = async (req, res, next) => {
  try {
    const input = req.body || {};
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return sendError(res, 400, API_ERROR_CODES.INPUT_INVALID, 'Profile data must be an object');
    }
    const allowed = new Set(['name', 'phone', 'email']);
    const unknown = Object.keys(input).find((key) => !allowed.has(key));
    if (unknown) {
      return sendError(res, 400, API_ERROR_CODES.INPUT_INVALID, `Unsupported profile field: ${unknown}`);
    }
    if (Object.keys(input).length === 0) {
      return sendError(res, 400, API_ERROR_CODES.INPUT_INVALID, 'At least one profile field is required');
    }

    const user = await User.findById(req.authContext.userId);
    if (!user || user.status !== 'active' || user.isSystemAccount === true) {
      throw new AuthContextError(401, AUTH_ERROR_CODES.USER_NOT_FOUND, 'Authenticated user does not exist');
    }

    const before = {
      name: user.name,
      phone: user.phone || null,
      email: user.email || null
    };
    if (input.name !== undefined) {
      if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 100) {
        return sendError(res, 400, API_ERROR_CODES.INPUT_INVALID, 'Name must contain between 1 and 100 characters');
      }
      user.name = input.name.trim();
    }
    if (input.phone !== undefined) {
      if (input.phone !== null && typeof input.phone !== 'string') {
        return sendError(res, 400, API_ERROR_CODES.INPUT_INVALID, 'Phone must be a string');
      }
      const phone = input.phone === null || input.phone === '' ? null : input.phone.trim();
      if (phone !== null && !PHONE_PATTERN.test(phone)) {
        return sendError(res, 400, API_ERROR_CODES.INPUT_INVALID, 'Please enter a valid phone number');
      }
      user.phone = phone;
    }
    if (input.email !== undefined) {
      if (input.email !== null && typeof input.email !== 'string') {
        return sendError(res, 400, API_ERROR_CODES.INPUT_INVALID, 'Email must be a string');
      }
      const email = input.email === null || input.email === '' ? null : input.email.trim().toLowerCase();
      if (email !== null && (email.length > 254 || !EMAIL_PATTERN.test(email))) {
        return sendError(res, 400, API_ERROR_CODES.INPUT_INVALID, 'Please enter a valid email address');
      }
      user.email = email;
    }

    await runWithOptionalTransaction(async (dbSession) => {
      await user.save({ session: dbSession || undefined });
      await auditService.record({
        req,
        authContext: req.authContext,
        action: AUDIT_ACTIONS.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPES.USER,
        resourceId: user._id,
        before,
        after: {
          name: user.name,
          phone: user.phone || null,
          email: user.email || null
        },
        session: dbSession
      });
    });

    return res.json({
      message: 'Profile updated',
      user: serializeUser(user)
    });
  } catch (error) {
    return handleError(res, next, error);
  }
};

exports.logout = async (req, res, next) => {
  try {
    await runWithOptionalTransaction(async (dbSession) => {
      const revoked = await sessionLifecycle.revokeSession(req.authContext.sessionId, {
        reason: SESSION_REVOKE_REASONS.LOGOUT,
        dbSession
      });
      if (!revoked) {
        throw new AuthContextError(
          401,
          AUTH_ERROR_CODES.SESSION_REVOKED,
          'The authentication session has already been revoked'
        );
      }
      await auditService.record({
        req,
        action: AUDIT_ACTIONS.LOGOUT,
        resourceType: AUDIT_RESOURCE_TYPES.AUTH_SESSION,
        resourceId: req.authContext.sessionId,
        before: {
          mode: req.authContext.mode,
          activeTeamId: req.authContext.activeTeamId || null
        },
        after: { revoked: true },
        session: dbSession
      });
    });
    return res.json({ message: 'Logout successful' });
  } catch (error) {
    return handleError(res, next, error);
  }
};

exports.changePassword = async (req, res, next) => {
  try {
    const { oldPassword, newPassword } = req.body || {};
    if (typeof oldPassword !== 'string' || typeof newPassword !== 'string') {
      return sendError(
        res,
        400,
        API_ERROR_CODES.INPUT_INVALID,
        'Old password and new password are required'
      );
    }
    if (newPassword.length < 6) {
      return sendError(
        res,
        400,
        API_ERROR_CODES.INPUT_INVALID,
        'The new password must contain at least 6 characters'
      );
    }

    const user = await User.findById(req.authContext.userId);
    if (!user || user.status !== 'active') {
      throw new AuthContextError(401, AUTH_ERROR_CODES.USER_NOT_FOUND, 'Authenticated user does not exist');
    }
    if (!await user.comparePassword(oldPassword)) {
      return sendError(
        res,
        401,
        API_ERROR_CODES.OLD_PASSWORD_INVALID,
        'The old password is incorrect'
      );
    }

    const previousTokenVersion = user.tokenVersion;
    await runWithOptionalTransaction(async (dbSession) => {
      user.password = newPassword;
      user.tokenVersion += 1;
      await user.save({ session: dbSession || undefined });
      await sessionLifecycle.revokeAllForUser(user._id, {
        reason: SESSION_REVOKE_REASONS.PASSWORD_CHANGED,
        dbSession
      });
      await auditService.record({
        req,
        action: AUDIT_ACTIONS.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPES.USER,
        resourceId: user._id,
        before: { tokenVersion: previousTokenVersion },
        after: {
          tokenVersion: user.tokenVersion,
          authenticationStateChanged: true,
          sessionsRevoked: true
        },
        session: dbSession
      });
    });

    return res.json({
      message: 'Password changed; sign in again',
      requiresLogin: true
    });
  } catch (error) {
    return handleError(res, next, error);
  }
};

// Team member creation belongs to the dedicated team member API. Keeping this
// authenticated endpoint prevents the legacy self-registration path reopening.
exports.register = (req, res) => sendError(
  res,
  501,
  API_ERROR_CODES.REGISTRATION_MOVED,
  'Use the team member management API to create users'
);

module.exports.API_ERROR_CODES = API_ERROR_CODES;
module.exports.findAccessibleTeams = findAccessibleTeams;
