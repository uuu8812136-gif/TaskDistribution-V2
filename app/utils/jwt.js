'use strict';

const jwt = require('jsonwebtoken');
const { SESSION_MODE_VALUES, SESSION_MODES } = require('../config/permissions');

const ALGORITHM = 'HS256';
const modeSet = new Set(SESSION_MODE_VALUES);

function jwtOptions(overrides = {}) {
  return {
    secret: overrides.secret || process.env.JWT_SECRET,
    expiresIn: overrides.expiresIn || process.env.JWT_EXPIRE || '8h',
    issuer: overrides.issuer || process.env.JWT_ISSUER || 'task-distribution-v2',
    audience: overrides.audience || process.env.JWT_AUDIENCE || 'task-distribution-v2-clients'
  };
}

function assertTokenInput({ userId, jti, mode, activeTeamId = null, tokenVersion }) {
  if (typeof userId !== 'string' || !/^[0-9a-fA-F]{24}$/.test(userId)) {
    throw new TypeError('userId must be a 24-character ObjectId string');
  }
  if (typeof jti !== 'string' || jti.length < 16 || jti.length > 256) {
    throw new TypeError('jti must contain between 16 and 256 characters');
  }
  if (!modeSet.has(mode)) {
    throw new TypeError('mode is invalid');
  }
  if (!Number.isInteger(tokenVersion) || tokenVersion < 0) {
    throw new TypeError('tokenVersion must be a non-negative integer');
  }
  if (
    mode === SESSION_MODES.TEAM &&
    (typeof activeTeamId !== 'string' || !/^[0-9a-fA-F]{24}$/.test(activeTeamId))
  ) {
    throw new TypeError('TEAM mode requires an activeTeamId');
  }
  if (mode !== SESSION_MODES.TEAM && activeTeamId !== null) {
    throw new TypeError(`${mode} mode cannot include activeTeamId`);
  }
}

function generateToken(input, overrides = {}) {
  assertTokenInput(input);
  const options = jwtOptions(overrides);
  if (!options.secret) throw new Error('JWT_SECRET is required');

  const payload = {
    mode: input.mode,
    activeTeamId: input.activeTeamId || null,
    tokenVersion: input.tokenVersion
  };
  const token = jwt.sign(payload, options.secret, {
    algorithm: ALGORITHM,
    expiresIn: options.expiresIn,
    issuer: options.issuer,
    audience: options.audience,
    subject: input.userId.toLowerCase(),
    jwtid: input.jti
  });
  const claims = jwt.decode(token);

  return Object.freeze({
    token,
    claims: Object.freeze(claims),
    issuedAt: new Date(claims.iat * 1000),
    expiresAt: new Date(claims.exp * 1000)
  });
}

function verifyToken(token, overrides = {}) {
  try {
    const options = jwtOptions(overrides);
    if (!options.secret) return null;
    return jwt.verify(token, options.secret, {
      algorithms: [ALGORITHM],
      issuer: options.issuer,
      audience: options.audience
    });
  } catch {
    return null;
  }
}

module.exports = {
  ALGORITHM,
  assertTokenInput,
  generateToken,
  verifyToken
};
