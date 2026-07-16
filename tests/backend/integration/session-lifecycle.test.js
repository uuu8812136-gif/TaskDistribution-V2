'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { after, before, beforeEach, test } = require('node:test');
const appRequire = require('../helpers/appRequire');

const mongoose = appRequire('mongoose');
const { MongoMemoryServer } = appRequire('mongodb-memory-server');
const { SESSION_MODES, SESSION_REVOKE_REASONS } = require('../../../app/config/permissions');
const AuthSession = require('../../../app/models/AuthSession');
const { hashJti } = require('../../../app/services/authSessionService');
const { createSessionLifecycleService } = require('../../../app/services/sessionLifecycleService');
const { generateToken, verifyToken } = require('../../../app/utils/jwt');

const TEST_DATABASE_NAME = `sessions_${randomUUID().replaceAll('-', '')}_v2_test`;
const TOKEN_OPTIONS = {
  secret: '0123456789abcdef0123456789abcdef',
  expiresIn: '15m',
  issuer: 'task-distribution-v2-test',
  audience: 'task-distribution-v2-test-client'
};
const USER_ID = '64b000000000000000000001';
const TEAM_A_ID = '64b000000000000000000002';
const TEAM_B_ID = '64b000000000000000000003';

let mongoServer;
let jtiCounter;
let service;

before(async () => {
  mongoServer = await MongoMemoryServer.create({
    instance: { dbName: TEST_DATABASE_NAME }
  });
  await mongoose.connect(mongoServer.getUri(TEST_DATABASE_NAME), {
    dbName: TEST_DATABASE_NAME
  });
  assert.equal(mongoose.connection.name, TEST_DATABASE_NAME);
  await AuthSession.syncIndexes();
});

beforeEach(async () => {
  await AuthSession.collection.deleteMany({});
  jtiCounter = 0;
  service = createSessionLifecycleService({
    tokenSigner: (input) => generateToken(input, TOKEN_OPTIONS),
    createJti: () => `test-session-jti-${String(++jtiCounter).padStart(20, '0')}`
  });
});

after(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});

test('issues a verifiable token while persisting only the jti hash', async () => {
  const issued = await service.issueSession({
    userId: USER_ID,
    mode: SESSION_MODES.TEAM,
    activeTeamId: TEAM_A_ID,
    tokenVersion: 2
  });
  const claims = verifyToken(issued.token, TOKEN_OPTIONS);
  const stored = await AuthSession.findById(issued.session._id).select('+jtiHash').lean();

  assert.equal(claims.sub, USER_ID);
  assert.equal(claims.activeTeamId, TEAM_A_ID);
  assert.equal(stored.jtiHash, hashJti(claims.jti));
  assert.equal(stored.jtiHash.includes(claims.jti), false);
  assert.equal(stored.revokedAt, null);
});

test('concurrent team rotation produces exactly one valid successor session', async () => {
  const current = await service.issueSession({
    userId: USER_ID,
    mode: SESSION_MODES.TEAM,
    activeTeamId: TEAM_A_ID,
    tokenVersion: 0
  });

  const attempts = await Promise.allSettled([
    service.rotateSession({
      currentSessionId: current.session._id,
      userId: USER_ID,
      mode: SESSION_MODES.TEAM,
      activeTeamId: TEAM_B_ID,
      tokenVersion: 0,
      reason: SESSION_REVOKE_REASONS.TEAM_SWITCH
    }),
    service.rotateSession({
      currentSessionId: current.session._id,
      userId: USER_ID,
      mode: SESSION_MODES.TEAM,
      activeTeamId: TEAM_B_ID,
      tokenVersion: 0,
      reason: SESSION_REVOKE_REASONS.TEAM_SWITCH
    })
  ]);

  assert.equal(attempts.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(({ status }) => status === 'rejected').length, 1);
  assert.equal(await AuthSession.countDocuments({ revokedAt: null }), 1);
  assert.equal(await AuthSession.countDocuments({ revokeReason: 'TEAM_SWITCH' }), 1);
});

test('password reset style revocation invalidates every active user session', async () => {
  await service.issueSession({
    userId: USER_ID,
    mode: SESSION_MODES.TEAM,
    activeTeamId: TEAM_A_ID,
    tokenVersion: 0
  });
  await service.issueSession({
    userId: USER_ID,
    mode: SESSION_MODES.TEAM,
    activeTeamId: TEAM_B_ID,
    tokenVersion: 0
  });

  const result = await service.revokeAllForUser(USER_ID, {
    reason: SESSION_REVOKE_REASONS.PASSWORD_CHANGED
  });

  assert.equal(result.modifiedCount, 2);
  assert.equal(await AuthSession.countDocuments({ revokedAt: null }), 0);
});
