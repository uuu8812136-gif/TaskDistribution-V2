'use strict';

const { randomUUID } = require('node:crypto');
const AuthSession = require('../models/AuthSession');
const {
  SESSION_REVOKE_REASON_VALUES,
  SESSION_REVOKE_REASONS
} = require('../config/permissions');
const { generateToken } = require('../utils/jwt');
const { buildPersistableSession, normalizeId } = require('./authSessionService');
const {
  AUTH_ERROR_CODES,
  AuthContextError
} = require('./authContextError');

const revokeReasonSet = new Set(SESSION_REVOKE_REASON_VALUES);

function assertRevokeReason(reason) {
  if (!revokeReasonSet.has(reason)) {
    throw new TypeError(`Unknown session revoke reason: ${reason}`);
  }
}

function attachSession(query, dbSession) {
  if (dbSession && query && typeof query.session === 'function') {
    return query.session(dbSession);
  }
  return query;
}

function createSessionLifecycleService({
  SessionModel = AuthSession,
  tokenSigner = generateToken,
  createJti = randomUUID,
  now = () => new Date()
} = {}) {
  async function issueSession({
    userId,
    mode,
    activeTeamId = null,
    tokenVersion
  }, { dbSession = null } = {}) {
    const normalizedUserId = normalizeId(userId);
    const normalizedTeamId = normalizeId(activeTeamId);
    const jti = createJti();
    const issued = tokenSigner({
      userId: normalizedUserId,
      jti,
      mode,
      activeTeamId: normalizedTeamId,
      tokenVersion
    });
    const record = buildPersistableSession({
      claims: issued.claims,
      issuedAt: issued.issuedAt,
      expiresAt: issued.expiresAt
    });
    const session = new SessionModel(record);
    await session.save({ session: dbSession || undefined });

    return Object.freeze({
      token: issued.token,
      claims: issued.claims,
      session,
      expiresAt: issued.expiresAt
    });
  }

  async function revokeSession(sessionId, {
    reason = SESSION_REVOKE_REASONS.OTHER,
    detail = null,
    dbSession = null
  } = {}) {
    assertRevokeReason(reason);
    const revokedAt = now();
    let query = SessionModel.findOneAndUpdate(
      {
        _id: sessionId,
        revokedAt: null,
        expiresAt: { $gt: revokedAt }
      },
      {
        $set: {
          revokedAt,
          revokeReason: reason,
          revokeDetail: detail
        }
      },
      { new: true, runValidators: true }
    );
    query = attachSession(query, dbSession);
    return query.exec();
  }

  async function rotateSession({
    currentSessionId,
    userId,
    mode,
    activeTeamId = null,
    tokenVersion,
    reason = SESSION_REVOKE_REASONS.TOKEN_ROTATED,
    detail = null
  }, { dbSession = null } = {}) {
    const revoked = await revokeSession(currentSessionId, {
      reason,
      detail,
      dbSession
    });
    if (!revoked) {
      throw new AuthContextError(
        401,
        AUTH_ERROR_CODES.SESSION_REVOKED,
        'The authentication session has already been replaced or revoked'
      );
    }

    return issueSession(
      { userId, mode, activeTeamId, tokenVersion },
      { dbSession }
    );
  }

  async function revokeAllForUser(userId, {
    reason,
    detail = null,
    dbSession = null
  } = {}) {
    assertRevokeReason(reason);
    const revokedAt = now();
    let query = SessionModel.updateMany(
      {
        userId,
        revokedAt: null,
        expiresAt: { $gt: revokedAt }
      },
      {
        $set: {
          revokedAt,
          revokeReason: reason,
          revokeDetail: detail
        }
      },
      { runValidators: true }
    );
    query = attachSession(query, dbSession);
    return query.exec();
  }

  return Object.freeze({
    issueSession,
    revokeAllForUser,
    revokeSession,
    rotateSession
  });
}

module.exports = {
  attachSession,
  createSessionLifecycleService
};
