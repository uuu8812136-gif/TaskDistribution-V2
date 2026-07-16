'use strict';

const { SESSION_MODES } = require('../config/permissions');
const {
  assertAuthContext,
  assertBusinessContext
} = require('../services/teamContextService');
const {
  AUTH_ERROR_CODES,
  AuthContextError,
  isAuthContextError,
  sendAuthContextError
} = require('../services/authContextError');

const CONTROL_PLANE_OPERATION = Symbol('controlPlaneOperation');
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function isBusinessWriteMethod(method) {
  return !READ_METHODS.has(String(method || '').toUpperCase());
}

function markControlPlaneOperation(operationKey) {
  if (typeof operationKey !== 'string' || operationKey.trim().length === 0) {
    throw new TypeError('operationKey must be a non-empty string');
  }
  const normalizedOperationKey = operationKey.trim();

  return function controlPlaneOperationMarker(req, res, next) {
    Object.defineProperty(req, CONTROL_PLANE_OPERATION, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: normalizedOperationKey
    });
    return next();
  };
}

function createBusinessWriteGuard({ allowedControlPlaneOperations = [] } = {}) {
  if (!Array.isArray(allowedControlPlaneOperations)) {
    throw new TypeError('allowedControlPlaneOperations must be an array');
  }
  const controlPlaneAllowlist = new Set(allowedControlPlaneOperations);
  if (
    controlPlaneAllowlist.size !== allowedControlPlaneOperations.length ||
    allowedControlPlaneOperations.some(
      (operationKey) => typeof operationKey !== 'string' || operationKey.length === 0
    )
  ) {
    throw new TypeError('allowedControlPlaneOperations must contain unique non-empty strings');
  }

  return function businessWriteGuardMiddleware(req, res, next) {
    try {
      const context = assertAuthContext(req.authContext);
      const controlPlaneOperation = req[CONTROL_PLANE_OPERATION];

      if (controlPlaneOperation) {
        if (!controlPlaneAllowlist.has(controlPlaneOperation)) {
          throw new AuthContextError(
            403,
            AUTH_ERROR_CODES.CONTROL_PLANE_OPERATION_DENIED,
            'The control-plane operation is not allowed by this route'
          );
        }
        return next();
      }

      assertBusinessContext(context);
      if (
        context.mode === SESSION_MODES.GLOBAL_READ_ONLY &&
        isBusinessWriteMethod(req.method)
      ) {
        throw new AuthContextError(
          403,
          AUTH_ERROR_CODES.GLOBAL_READ_ONLY,
          'Global mode is read-only; enter a team before modifying business data'
        );
      }
      return next();
    } catch (error) {
      if (isAuthContextError(error)) return sendAuthContextError(res, error);
      return next(error);
    }
  };
}

const businessWriteGuard = createBusinessWriteGuard();

module.exports = {
  businessWriteGuard,
  createBusinessWriteGuard,
  isBusinessWriteMethod,
  markControlPlaneOperation
};
