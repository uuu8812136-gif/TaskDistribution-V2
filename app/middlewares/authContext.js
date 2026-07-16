'use strict';

const { verifyToken: defaultVerifyToken } = require('../utils/jwt');
const { isPermissionKey } = require('../config/permissions');
const AuthSession = require('../models/AuthSession');
const OrgUnit = require('../models/OrgUnit');
const ProjectTeam = require('../models/ProjectTeam');
const TeamMembership = require('../models/TeamMembership');
const User = require('../models/User');
const { createAuthSessionService } = require('../services/authSessionService');
const {
  assertBusinessContext,
  assertPermission,
  assertTeamContext,
  createTeamContextService,
  resolveModuleDataScope
} = require('../services/teamContextService');
const {
  AUTH_ERROR_CODES,
  AuthContextError,
  isAuthContextError,
  sendAuthContextError
} = require('../services/authContextError');

function extractBearerToken(headers = {}) {
  const header = headers.authorization;
  if (typeof header !== 'string') {
    throw new AuthContextError(
      401,
      AUTH_ERROR_CODES.TOKEN_REQUIRED,
      'A bearer authentication token is required'
    );
  }

  const match = /^Bearer ([^\s,]+)$/i.exec(header.trim());
  if (!match) {
    throw new AuthContextError(
      401,
      AUTH_ERROR_CODES.TOKEN_INVALID,
      'The bearer authentication token is invalid'
    );
  }
  return match[1];
}

function handleAuthorizationError(res, next, error) {
  if (isAuthContextError(error)) return sendAuthContextError(res, error);
  return next(error);
}

function createAuthContextMiddleware({
  verifyToken = defaultVerifyToken,
  sessionService,
  teamContextService,
  sessionServiceOptions,
  teamContextServiceOptions
} = {}) {
  if (typeof verifyToken !== 'function') {
    throw new TypeError('verifyToken must be a function');
  }

  const resolvedSessionService = sessionService || createAuthSessionService({
    AuthSession,
    ...sessionServiceOptions
  });
  const resolvedTeamContextService = teamContextService || createTeamContextService({
    User,
    ProjectTeam,
    TeamMembership,
    OrgUnit,
    ...teamContextServiceOptions
  });

  if (typeof resolvedSessionService.resolveSession !== 'function') {
    throw new TypeError('sessionService.resolveSession must be a function');
  }
  if (typeof resolvedTeamContextService.resolveContext !== 'function') {
    throw new TypeError('teamContextService.resolveContext must be a function');
  }

  return async function authContextMiddleware(req, res, next) {
    let token;
    try {
      token = extractBearerToken(req.headers);
    } catch (error) {
      return handleAuthorizationError(res, next, error);
    }

    let decoded;
    try {
      decoded = await verifyToken(token);
    } catch {
      return sendAuthContextError(
        res,
        new AuthContextError(
          401,
          AUTH_ERROR_CODES.TOKEN_INVALID,
          'The bearer authentication token is invalid'
        )
      );
    }
    if (!decoded) {
      return sendAuthContextError(
        res,
        new AuthContextError(
          401,
          AUTH_ERROR_CODES.TOKEN_INVALID,
          'The bearer authentication token is invalid'
        )
      );
    }

    try {
      const resolvedSession = await resolvedSessionService.resolveSession(decoded);
      const context = await resolvedTeamContextService.resolveContext(resolvedSession);

      req.authContext = context;
      // Transitional compatibility only. Authorization must use req.authContext.
      req.user = context.user;
      return next();
    } catch (error) {
      return handleAuthorizationError(res, next, error);
    }
  };
}

function requireBusinessContext(req, res, next) {
  try {
    assertBusinessContext(req.authContext);
    return next();
  } catch (error) {
    return handleAuthorizationError(res, next, error);
  }
}

function requireTeamContext(req, res, next) {
  try {
    assertTeamContext(req.authContext);
    return next();
  } catch (error) {
    return handleAuthorizationError(res, next, error);
  }
}

function requirePermission(permissionKey) {
  if (!isPermissionKey(permissionKey)) {
    throw new TypeError(`Unknown permission key: ${String(permissionKey)}`);
  }
  return function permissionMiddleware(req, res, next) {
    try {
      assertPermission(req.authContext, permissionKey);
      return next();
    } catch (error) {
      return handleAuthorizationError(res, next, error);
    }
  };
}

function requireModuleDataScope(moduleKey) {
  return function moduleDataScopeMiddleware(req, res, next) {
    try {
      req.dataScope = resolveModuleDataScope(req.authContext, moduleKey);
      return next();
    } catch (error) {
      return handleAuthorizationError(res, next, error);
    }
  };
}

function getTrustedActiveTeamId(req) {
  assertTeamContext(req && req.authContext);
  return req.authContext.activeTeamId;
}

const authenticateContext = createAuthContextMiddleware();

module.exports = {
  authenticateContext,
  createAuthContextMiddleware,
  extractBearerToken,
  getTrustedActiveTeamId,
  requireBusinessContext,
  requireModuleDataScope,
  requirePermission,
  requireTeamContext
};
