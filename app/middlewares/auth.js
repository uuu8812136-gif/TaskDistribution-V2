'use strict';

const authContextMiddleware = require('./authContext');
const { AUDIT_ACTOR_ROLES, MEMBERSHIP_ROLES } = require('../config/permissions');
const {
  AUTH_ERROR_CODES,
  AuthContextError,
  sendAuthContextError
} = require('../services/authContextError');

const authenticate = authContextMiddleware.authenticateContext;

function hasAdministrativeContext(context) {
  return Boolean(
    context &&
    context.authenticated === true &&
    (
      context.isSuperAdmin === true ||
      context.membership?.role === MEMBERSHIP_ROLES.PROJECT_ADMIN
    )
  );
}

function isAdmin(req, res, next) {
  if (!hasAdministrativeContext(req.authContext)) {
    return sendAuthContextError(
      res,
      new AuthContextError(
        403,
        AUTH_ERROR_CODES.PERMISSION_DENIED,
        'Project administrator access is required'
      )
    );
  }
  return next();
}

// Transitional helper for callers that already use actor-role constants. It
// intentionally does not interpret legacy User.roles values.
function authorize(...actorRoles) {
  const allowed = new Set(actorRoles);
  return function authorizeContext(req, res, next) {
    const context = req.authContext;
    const actorRole = context?.isSuperAdmin
      ? AUDIT_ACTOR_ROLES.SUPER_ADMIN
      : context?.membership?.role === MEMBERSHIP_ROLES.PROJECT_ADMIN
        ? AUDIT_ACTOR_ROLES.PROJECT_ADMIN
        : AUDIT_ACTOR_ROLES.MEMBER;

    if (!context?.authenticated || !allowed.has(actorRole)) {
      return sendAuthContextError(
        res,
        new AuthContextError(
          403,
          AUTH_ERROR_CODES.PERMISSION_DENIED,
          'Permission denied'
        )
      );
    }
    return next();
  };
}

module.exports = {
  ...authContextMiddleware,
  authenticate,
  authorize,
  hasAdministrativeContext,
  isAdmin
};
