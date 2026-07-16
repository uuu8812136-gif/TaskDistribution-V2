'use strict';

const ProjectTeam = require('../models/ProjectTeam');
const TeamMembership = require('../models/TeamMembership');
const User = require('../models/User');
const {
  MEMBERSHIP_STATUSES,
  SESSION_MODES,
  SESSION_REVOKE_REASONS,
  TEAM_STATUSES
} = require('../config/permissions');
const { normalizeId } = require('../services/authSessionService');
const { createSessionLifecycleService } = require('../services/sessionLifecycleService');
const {
  AUTH_ERROR_CODES,
  AuthContextError,
  isAuthContextError,
  sendAuthContextError
} = require('../services/authContextError');

const sessionLifecycle = createSessionLifecycleService();
const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

const API_ERROR_CODES = Object.freeze({
  CREDENTIALS_INVALID: 'AUTH_CREDENTIALS_INVALID',
  INPUT_INVALID: 'AUTH_INPUT_INVALID',
  OLD_PASSWORD_INVALID: 'AUTH_OLD_PASSWORD_INVALID',
  REGISTRATION_MOVED: 'AUTH_REGISTRATION_MOVED',
  TEAM_ACCESS_REQUIRED: 'AUTH_TEAM_ACCESS_REQUIRED'
});

function sendError(res, status, code, message) {
  return res.status(status).json({ message, code });
}

function handleError(res, next, error) {
  if (isAuthContextError(error)) return sendAuthContextError(res, error);
  return next(error);
}

function serializeUser(user, overrides = {}) {
  return {
    _id: normalizeId(user._id),
    username: user.username,
    name: user.name,
    phone: user.phone,
    email: user.email,
    avatar: user.avatar,
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
  return {
    message: 'Login successful',
    token: issued.token,
    expiresAt: issued.expiresAt,
    mode: issued.claims.mode,
    activeTeamId: issued.claims.activeTeamId || null,
    user: serializeUser(user, { lastLoginAt }),
    teams
  };
}

function serializeRotatedSession(issued) {
  return {
    token: issued.token,
    expiresAt: issued.expiresAt,
    mode: issued.claims.mode,
    activeTeamId: issued.claims.activeTeamId || null
  };
}

exports.login = async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
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
      return sendError(
        res,
        401,
        API_ERROR_CODES.CREDENTIALS_INVALID,
        'Invalid username or password'
      );
    }

    const teams = await findAccessibleTeams({
      userId: user._id,
      isSuperAdmin: user.isSuperAdmin === true
    });

    let mode;
    let activeTeamId = null;
    if (user.isSuperAdmin === true) {
      mode = SESSION_MODES.GLOBAL_READ_ONLY;
    } else if (teams.length === 0) {
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

    const issued = await sessionLifecycle.issueSession({
      userId: user._id,
      mode,
      activeTeamId,
      tokenVersion: user.tokenVersion
    });
    const lastLoginAt = new Date();
    await User.updateOne({ _id: user._id }, { $set: { lastLoginAt } });

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

    const team = await ProjectTeam.findById(teamId)
      .select('_id status')
      .lean();
    if (!team) {
      throw new AuthContextError(404, AUTH_ERROR_CODES.TEAM_NOT_FOUND, 'The team does not exist');
    }
    if (team.status !== TEAM_STATUSES.ACTIVE) {
      throw new AuthContextError(403, AUTH_ERROR_CODES.TEAM_DISABLED, 'The team is disabled');
    }

    if (!req.authContext.isSuperAdmin) {
      const membership = await TeamMembership.findOne({
        teamId: team._id,
        userId: req.authContext.userId,
        status: MEMBERSHIP_STATUSES.ACTIVE
      })
        .select('_id')
        .lean();
      if (!membership) {
        throw new AuthContextError(
          403,
          AUTH_ERROR_CODES.MEMBERSHIP_REQUIRED,
          'An active membership is required for this team'
        );
      }
    }

    const issued = await sessionLifecycle.rotateSession({
      currentSessionId: req.authContext.sessionId,
      userId: req.authContext.userId,
      mode: SESSION_MODES.TEAM,
      activeTeamId: normalizeId(team._id),
      tokenVersion: req.authContext.tokenVersion,
      reason: SESSION_REVOKE_REASONS.TEAM_SWITCH
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

    const issued = await sessionLifecycle.rotateSession({
      currentSessionId: req.authContext.sessionId,
      userId: req.authContext.userId,
      mode: SESSION_MODES.GLOBAL_READ_ONLY,
      activeTeamId: null,
      tokenVersion: req.authContext.tokenVersion,
      reason: SESSION_REVOKE_REASONS.TOKEN_ROTATED
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

exports.logout = async (req, res, next) => {
  try {
    await sessionLifecycle.revokeSession(req.authContext.sessionId, {
      reason: SESSION_REVOKE_REASONS.LOGOUT
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

    user.password = newPassword;
    user.tokenVersion += 1;
    await user.save();
    await sessionLifecycle.revokeAllForUser(user._id, {
      reason: SESSION_REVOKE_REASONS.PASSWORD_CHANGED
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
