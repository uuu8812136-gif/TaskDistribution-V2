'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { SESSION_MODES } = require('../../../app/config/permissions');
const {
  ALGORITHM,
  generateToken,
  verifyToken
} = require('../../../app/utils/jwt');

const TOKEN_OPTIONS = {
  secret: '0123456789abcdef0123456789abcdef',
  expiresIn: '15m',
  issuer: 'task-distribution-v2-test',
  audience: 'task-distribution-v2-test-client'
};
const USER_ID = '64b000000000000000000001';
const TEAM_ID = '64b000000000000000000002';
const JTI = 'test-session-jti-000000000001';

test('generates and verifies a minimal team-scoped token', () => {
  const issued = generateToken(
    {
      userId: USER_ID,
      jti: JTI,
      mode: SESSION_MODES.TEAM,
      activeTeamId: TEAM_ID,
      tokenVersion: 3
    },
    TOKEN_OPTIONS
  );
  const claims = verifyToken(issued.token, TOKEN_OPTIONS);

  assert.equal(claims.sub, USER_ID);
  assert.equal(claims.jti, JTI);
  assert.equal(claims.mode, SESSION_MODES.TEAM);
  assert.equal(claims.activeTeamId, TEAM_ID);
  assert.equal(claims.tokenVersion, 3);
  assert.equal(claims.iss, TOKEN_OPTIONS.issuer);
  assert.equal(claims.aud, TOKEN_OPTIONS.audience);
  assert.equal(issued.expiresAt > issued.issuedAt, true);
  assert.equal(Object.hasOwn(claims, 'permissions'), false);
  assert.equal(Object.hasOwn(claims, 'user'), false);
  assert.equal(ALGORITHM, 'HS256');
});

test('rejects a token signed for another secret, issuer, or audience', () => {
  const { token } = generateToken(
    {
      userId: USER_ID,
      jti: JTI,
      mode: SESSION_MODES.GLOBAL_READ_ONLY,
      activeTeamId: null,
      tokenVersion: 0
    },
    TOKEN_OPTIONS
  );

  assert.equal(verifyToken(token, { ...TOKEN_OPTIONS, secret: 'f'.repeat(32) }), null);
  assert.equal(verifyToken(token, { ...TOKEN_OPTIONS, issuer: 'other-issuer' }), null);
  assert.equal(verifyToken(token, { ...TOKEN_OPTIONS, audience: 'other-audience' }), null);
});

test('fails closed for invalid mode and active-team combinations', () => {
  assert.throws(
    () =>
      generateToken(
        {
          userId: USER_ID,
          jti: JTI,
          mode: SESSION_MODES.TEAM,
          activeTeamId: null,
          tokenVersion: 0
        },
        TOKEN_OPTIONS
      ),
    /requires an activeTeamId/
  );

  assert.throws(
    () =>
      generateToken(
        {
          userId: USER_ID,
          jti: JTI,
          mode: SESSION_MODES.TEAM_SELECTION,
          activeTeamId: TEAM_ID,
          tokenVersion: 0
        },
        TOKEN_OPTIONS
      ),
    /cannot include activeTeamId/
  );
});
