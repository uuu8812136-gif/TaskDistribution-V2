'use strict';

const { isPermissionKey } = require('../config/permissions');
const {
  assertTaskPermissionOrLeadershipCandidate
} = require('../services/taskLeadershipAccessService');
const {
  isAuthContextError,
  sendAuthContextError
} = require('../services/authContextError');

function requireTaskPermissionOrLeadershipCandidate(permissionKey) {
  if (!isPermissionKey(permissionKey)) {
    throw new TypeError(`Unknown permission key: ${String(permissionKey)}`);
  }
  return function taskPermissionOrLeadershipCandidate(req, res, next) {
    try {
      assertTaskPermissionOrLeadershipCandidate(req.authContext, permissionKey);
      return next();
    } catch (error) {
      if (isAuthContextError(error)) return sendAuthContextError(res, error);
      return next(error);
    }
  };
}

module.exports = { requireTaskPermissionOrLeadershipCandidate };
