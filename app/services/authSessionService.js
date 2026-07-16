'use strict';

const crypto = require('node:crypto');
const {
  SESSION_MODES,
  SESSION_MODE_VALUES
} = require('../config/permissions');
const {
  AUTH_ERROR_CODES,
  AuthContextError
} = require('./authContextError');

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;
const sessionModeSet = new Set(SESSION_MODE_VALUES);

function normalizeId(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value.toHexString === 'function') return value.toHexString();
  if (value._id !== undefined) return normalizeId(value._id);

  const converted = typeof value.toString === 'function' ? value.toString() : '';
  return converted && converted !== '[object Object]' ? converted : null;
}

function hashJti(jti) {
  if (typeof jti !== 'string' || jti.length === 0) {
    throw new TypeError('jti must be a non-empty string');
  }
  return crypto.createHash('sha256').update(jti, 'utf8').digest('hex');
}

function invalidClaims() {
  return new AuthContextError(
    401,
    AUTH_ERROR_CODES.TOKEN_CLAIMS_INVALID,
    'Authentication token claims are invalid'
  );
}

function validateTokenClaims(decoded) {
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw invalidClaims();
  }

  const { sub, jti, mode, activeTeamId = null, tokenVersion } = decoded;
  if (
    typeof sub !== 'string' ||
    !OBJECT_ID_PATTERN.test(sub) ||
    typeof jti !== 'string' ||
    jti.length < 16 ||
    jti.length > 256 ||
    !sessionModeSet.has(mode) ||
    !Number.isInteger(tokenVersion) ||
    tokenVersion < 0
  ) {
    throw invalidClaims();
  }

  const normalizedActiveTeamId = normalizeId(activeTeamId);
  if (mode === SESSION_MODES.TEAM) {
    if (!normalizedActiveTeamId || !OBJECT_ID_PATTERN.test(normalizedActiveTeamId)) {
      throw invalidClaims();
    }
  } else if (activeTeamId !== null && activeTeamId !== undefined) {
    throw invalidClaims();
  }

  return Object.freeze({
    sub: sub.toLowerCase(),
    jti,
    mode,
    activeTeamId: normalizedActiveTeamId
      ? normalizedActiveTeamId.toLowerCase()
      : null,
    tokenVersion
  });
}

function sessionMismatch() {
  return new AuthContextError(
    401,
    AUTH_ERROR_CODES.SESSION_MISMATCH,
    'Authentication session does not match the token'
  );
}

function validateStoredSession(session, claims, currentTime = new Date()) {
  if (!session) {
    throw new AuthContextError(
      401,
      AUTH_ERROR_CODES.SESSION_NOT_FOUND,
      'Authentication session does not exist'
    );
  }

  if (session.revokedAt) {
    throw new AuthContextError(
      401,
      AUTH_ERROR_CODES.SESSION_REVOKED,
      'Authentication session has been revoked'
    );
  }

  const expiresAt = new Date(session.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) {
    throw sessionMismatch();
  }
  if (expiresAt.getTime() <= currentTime.getTime()) {
    throw new AuthContextError(
      401,
      AUTH_ERROR_CODES.SESSION_EXPIRED,
      'Authentication session has expired'
    );
  }

  const storedUserId = normalizeId(session.userId);
  const storedTeamId = normalizeId(session.activeTeamId);
  if (
    !storedUserId ||
    storedUserId.toLowerCase() !== claims.sub ||
    session.mode !== claims.mode ||
    (storedTeamId ? storedTeamId.toLowerCase() : null) !== claims.activeTeamId ||
    !Number.isInteger(session.tokenVersion) ||
    session.tokenVersion !== claims.tokenVersion
  ) {
    throw sessionMismatch();
  }

  return session;
}

async function executeQuery(query, { select } = {}) {
  if (!query) return query;
  let result = query;
  if (select && typeof result.select === 'function') result = result.select(select);
  if (typeof result.lean === 'function') result = result.lean();
  if (typeof result.exec === 'function') return result.exec();
  return result;
}

function buildPersistableSession({
  claims: rawClaims,
  issuedAt,
  expiresAt
}) {
  const claims = validateTokenClaims(rawClaims);
  return Object.freeze({
    jtiHash: hashJti(claims.jti),
    userId: claims.sub,
    mode: claims.mode,
    activeTeamId: claims.activeTeamId,
    tokenVersion: claims.tokenVersion,
    issuedAt,
    expiresAt
  });
}

function createAuthSessionService({
  AuthSession,
  findSessionByJtiHash,
  now = () => new Date()
} = {}) {
  const finder = findSessionByJtiHash || (AuthSession
    ? (jtiHash) => executeQuery(
      AuthSession.findOne({ jtiHash }),
      { select: '+jtiHash' }
    )
    : null);

  if (typeof finder !== 'function') {
    throw new TypeError('AuthSession model or findSessionByJtiHash is required');
  }

  return Object.freeze({
    async resolveSession(rawClaims) {
      const claims = validateTokenClaims(rawClaims);
      const jtiHash = hashJti(claims.jti);
      const session = await finder(jtiHash);
      validateStoredSession(session, claims, now());
      return Object.freeze({ claims, session, jtiHash });
    }
  });
}

module.exports = {
  buildPersistableSession,
  createAuthSessionService,
  executeQuery,
  hashJti,
  normalizeId,
  validateStoredSession,
  validateTokenClaims
};
