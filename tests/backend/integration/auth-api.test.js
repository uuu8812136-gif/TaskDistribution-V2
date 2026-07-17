'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { after, before, beforeEach, test } = require('node:test');
const appRequire = require('../helpers/appRequire');

const TEST_DATABASE_NAME = `auth_api_${randomUUID().replaceAll('-', '')}_v2_test`;
const JWT_ENV = Object.freeze({
  JWT_SECRET: 'auth-api-test-secret-0123456789abcdef0123456789',
  JWT_EXPIRE: '15m',
  JWT_ISSUER: 'task-distribution-v2-auth-api-test',
  JWT_AUDIENCE: 'task-distribution-v2-auth-api-test-client'
});

Object.assign(process.env, JWT_ENV);

const express = appRequire('express');
const mongoose = appRequire('mongoose');
const request = appRequire('supertest');
const { MongoMemoryServer } = appRequire('mongodb-memory-server');

const permissions = require('../../../app/config/permissions');
const { SYSTEM_ACCOUNT_DISPLAY_NAME } = require('../../../app/config/systemAccount');
const AuditLog = require('../../../app/models/AuditLog');
const AuthSession = require('../../../app/models/AuthSession');
const OrgUnit = require('../../../app/models/OrgUnit');
const ProjectTeam = require('../../../app/models/ProjectTeam');
const TeamMembership = require('../../../app/models/TeamMembership');
const User = require('../../../app/models/User');
const authRouter = require('../../../app/routes/auth');

const MODELS = [AuditLog, AuthSession, TeamMembership, OrgUnit, ProjectTeam, User];

let app;
let mongoServer;
let sequence = 0;

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

function responseHasSecretKeys(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => (
    key === 'password' || key === 'jtiHash' || responseHasSecretKeys(child)
  ));
}

function assertSystemAccountPresentation(user) {
  assert.equal(user.name, SYSTEM_ACCOUNT_DISPLAY_NAME);
  for (const field of ['username', 'phone', 'email', 'avatar', 'isSystemAccount']) {
    assert.equal(Object.hasOwn(user, field), false, `${field} must not be exposed`);
  }
}

function createTestApp() {
  const testApp = express();
  testApp.use(express.json());
  testApp.use('/api/auth', authRouter);
  testApp.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    return res.status(error.status || 500).json({
      message: error.message,
      code: error.code || 'TEST_UNEXPECTED_ERROR'
    });
  });
  return testApp;
}

async function createUser(overrides = {}) {
  sequence += 1;
  return User.create({
    username: `authuser${sequence}`,
    password: 'initial-password',
    name: `Auth User ${sequence}`,
    ...overrides
  });
}

async function createTeam({ createdBy, member = null, membership = {} } = {}) {
  sequence += 1;
  const suffix = String(sequence).padStart(3, '0');
  const team = await ProjectTeam.create({
    code: `AUTH_TEAM_${suffix}`,
    name: `Auth Team ${suffix}`,
    createdBy
  });
  const orgUnit = await OrgUnit.create({
    teamId: team._id,
    type: permissions.ORG_UNIT_TYPES.DEPARTMENT,
    code: `AUTH_ORG_${suffix}`,
    name: `Auth Org ${suffix}`,
    level: 1,
    path: '/'
  });

  let membershipDocument = null;
  if (member) {
    membershipDocument = await TeamMembership.create({
      teamId: team._id,
      userId: member._id,
      orgUnitId: orgUnit._id,
      permissionKeys: ['task.view'],
      ...membership
    });
  }

  return { team, orgUnit, membership: membershipDocument };
}

function login(username, password = 'initial-password', options = {}) {
  return request(app)
    .post('/api/auth/login')
    .send({ username, password, ...options });
}

before(async () => {
  assert.match(TEST_DATABASE_NAME, /_v2_test$/);
  mongoServer = await MongoMemoryServer.create({
    instance: { dbName: TEST_DATABASE_NAME }
  });
  await mongoose.connect(mongoServer.getUri(TEST_DATABASE_NAME), {
    dbName: TEST_DATABASE_NAME
  });
  assert.equal(mongoose.connection.name, TEST_DATABASE_NAME);

  for (const model of MODELS) await model.syncIndexes();
  app = createTestApp();
});

beforeEach(async () => {
  assert.equal(mongoose.connection.name, TEST_DATABASE_NAME);
  for (const model of MODELS) await model.collection.deleteMany({});
  sequence = 0;
});

after(async () => {
  if (mongoose.connection.readyState !== 0) {
    assert.equal(mongoose.connection.name, TEST_DATABASE_NAME);
    await mongoose.disconnect();
  }
  if (mongoServer) await mongoServer.stop();
});

test('login team options are public, active-only, minimal, and sorted', async () => {
  const creator = await createUser({ username: 'team.options.owner' });
  const second = await createTeam({ createdBy: creator._id });
  const first = await createTeam({ createdBy: creator._id });
  const disabled = await createTeam({ createdBy: creator._id });
  await ProjectTeam.updateOne(
    { _id: second.team._id },
    { $set: { name: 'Zulu Team' } }
  );
  await ProjectTeam.updateOne(
    { _id: first.team._id },
    { $set: { name: 'Alpha Team' } }
  );
  await ProjectTeam.updateOne(
    { _id: disabled.team._id },
    { $set: { status: permissions.TEAM_STATUSES.DISABLED } }
  );

  const response = await request(app)
    .get('/api/auth/login-teams')
    .expect(200);

  assert.deepEqual(response.body.teams.map(({ name }) => name), ['Alpha Team', 'Zulu Team']);
  assert.deepEqual(
    new Set(response.body.teams.map(({ _id }) => _id)),
    new Set([first.team.id, second.team.id])
  );
  for (const team of response.body.teams) {
    assert.deepEqual(Object.keys(team).sort(), ['_id', 'code', 'name']);
  }
});

test('super administrator login starts in GLOBAL_READ_ONLY without leaking secrets', async () => {
  const superAdmin = await createUser({
    username: 'Root.Admin',
    name: 'Root Admin',
    isSuperAdmin: true,
    roles: ['executor']
  });
  await createTeam({ createdBy: superAdmin._id });

  const response = await login('  ROOT.ADMIN  ').expect(200);

  assert.equal(response.body.mode, permissions.SESSION_MODES.GLOBAL_READ_ONLY);
  assert.equal(response.body.activeTeamId, null);
  assert.equal(response.body.user.isSuperAdmin, true);
  assert.equal(response.body.user.username, 'Root.Admin');
  assert.equal(response.body.user.name, 'Root Admin');
  assert.equal(response.body.teams.length, 1);
  assert.equal(responseHasSecretKeys(response.body), false);

  const current = await request(app)
    .get('/api/auth/me')
    .set(bearer(response.body.token))
    .expect(200);
  assert.equal(current.body.context.mode, permissions.SESSION_MODES.GLOBAL_READ_ONLY);
  assert.equal(current.body.context.readOnly, true);
  assert.equal(current.body.user.username, 'Root.Admin');
  assert.equal(current.body.user.name, 'Root Admin');
  assert.equal(responseHasSecretKeys(current.body), false);
});

test('system super administrator identity stays redacted through login and team switching', async () => {
  const systemAccount = await createUser({
    username: 'internal.system.account',
    name: 'Internal Operator Identity',
    phone: '13800000000',
    email: 'internal-operator@example.test',
    avatar: 'https://example.test/private-avatar.png',
    isSuperAdmin: true,
    isSystemAccount: true,
    roles: ['admin']
  });
  const { team } = await createTeam({ createdBy: systemAccount._id });

  assert.equal(await TeamMembership.countDocuments({ userId: systemAccount._id }), 0);

  const signedIn = await login(systemAccount.username).expect(200);
  assert.equal(signedIn.body.mode, permissions.SESSION_MODES.GLOBAL_READ_ONLY);
  assertSystemAccountPresentation(signedIn.body.user);
  assert.equal(JSON.stringify(signedIn.body).includes('Internal Operator Identity'), false);

  const globalCurrent = await request(app)
    .get('/api/auth/me')
    .set(bearer(signedIn.body.token))
    .expect(200);
  assert.equal(globalCurrent.body.context.membership, null);
  assertSystemAccountPresentation(globalCurrent.body.user);

  const switched = await request(app)
    .post('/api/auth/switch-team')
    .set(bearer(signedIn.body.token))
    .send({ teamId: team.id })
    .expect(200);
  assert.equal(switched.body.mode, permissions.SESSION_MODES.TEAM);
  assert.equal(JSON.stringify(switched.body).includes(systemAccount.username), false);
  assert.equal(JSON.stringify(switched.body).includes('Internal Operator Identity'), false);

  const teamCurrent = await request(app)
    .get('/api/auth/me')
    .set(bearer(switched.body.token))
    .expect(200);
  assert.equal(teamCurrent.body.context.membership, null);
  assert.equal(teamCurrent.body.context.readOnly, false);
  assertSystemAccountPresentation(teamCurrent.body.user);
});

test('ordinary login with one active team enters TEAM directly', async () => {
  const user = await createUser({ username: 'single.team' });
  const { team } = await createTeam({ createdBy: user._id, member: user });

  const response = await login('SINGLE.TEAM').expect(200);

  assert.equal(response.body.mode, permissions.SESSION_MODES.TEAM);
  assert.equal(response.body.activeTeamId, team.id);
  assert.equal(response.body.teams.length, 1);

  const current = await request(app)
    .get('/api/auth/me')
    .set(bearer(response.body.token))
    .expect(200);
  assert.equal(current.body.context.activeTeamId, team.id);
  assert.equal(current.body.context.readOnly, false);
  assert.equal(current.body.context.permissionKeys.includes('task.view'), true);
});

test('ordinary login with multiple active teams starts in TEAM_SELECTION', async () => {
  const user = await createUser({ username: 'many.teams' });
  const first = await createTeam({ createdBy: user._id, member: user });
  const second = await createTeam({ createdBy: user._id, member: user });

  const response = await login(user.username).expect(200);

  assert.equal(response.body.mode, permissions.SESSION_MODES.TEAM_SELECTION);
  assert.equal(response.body.activeTeamId, null);
  assert.deepEqual(
    new Set(response.body.teams.map(({ _id }) => _id)),
    new Set([first.team.id, second.team.id])
  );
  await request(app)
    .get('/api/auth/me')
    .set(bearer(response.body.token))
    .expect(200)
    .expect(({ body }) => {
      assert.equal(body.context.canAccessBusiness, false);
  });
});

test('ordinary login can select an active membership and enter TEAM directly', async () => {
  const user = await createUser({ username: 'selected.team' });
  const first = await createTeam({ createdBy: user._id, member: user });
  const second = await createTeam({ createdBy: user._id, member: user });

  const response = await login(
    user.username,
    'initial-password',
    { teamId: second.team.id.toUpperCase() }
  ).expect(200);

  assert.equal(response.body.mode, permissions.SESSION_MODES.TEAM);
  assert.equal(response.body.activeTeamId, second.team.id);
  assert.deepEqual(
    new Set(response.body.teams.map(({ _id }) => _id)),
    new Set([first.team.id, second.team.id])
  );

  await request(app)
    .get('/api/auth/me')
    .set(bearer(response.body.token))
    .expect(200)
    .expect(({ body }) => {
      assert.equal(body.context.mode, permissions.SESSION_MODES.TEAM);
      assert.equal(body.context.activeTeamId, second.team.id);
    });
});

test('super administrator login can select any active team and enter TEAM directly', async () => {
  const superAdmin = await createUser({
    username: 'selected.root',
    isSuperAdmin: true
  });
  const { team } = await createTeam({ createdBy: superAdmin._id });

  const response = await login(
    superAdmin.username,
    'initial-password',
    { teamId: team.id }
  ).expect(200);

  assert.equal(response.body.mode, permissions.SESSION_MODES.TEAM);
  assert.equal(response.body.activeTeamId, team.id);
  assert.equal(response.body.user.isSuperAdmin, true);
});

test('selected login team hides missing, disabled, and unauthorized team differences', async () => {
  const user = await createUser({ username: 'selected.scope' });
  await createTeam({ createdBy: user._id, member: user });
  const unowned = await createTeam({ createdBy: user._id });
  const disabled = await createTeam({ createdBy: user._id, member: user });
  await ProjectTeam.updateOne(
    { _id: disabled.team._id },
    { $set: { status: permissions.TEAM_STATUSES.DISABLED } }
  );

  const responses = [];
  for (const teamId of [
    unowned.team.id,
    disabled.team.id,
    new mongoose.Types.ObjectId().toString()
  ]) {
    responses.push(await login(
      user.username,
      'initial-password',
      { teamId }
    ).expect(403));
  }

  assert.deepEqual(responses[0].body, responses[1].body);
  assert.deepEqual(responses[1].body, responses[2].body);
  assert.equal(responses[0].body.code, 'AUTH_TEAM_ACCESS_REQUIRED');
  assert.equal(await AuthSession.countDocuments(), 0);
});

test('credential failures take precedence over malformed selected team input', async () => {
  const user = await createUser({ username: 'selected.credentials' });

  const wrongPassword = await login(
    user.username,
    'wrong-password',
    { teamId: 'not-an-object-id' }
  ).expect(401);
  const unknownUser = await login(
    'unknown.selected.credentials',
    'wrong-password',
    { teamId: 'not-an-object-id' }
  ).expect(401);

  assert.deepEqual(unknownUser.body, wrongPassword.body);
  assert.equal(wrongPassword.body.code, 'AUTH_CREDENTIALS_INVALID');

  const validCredentials = await login(
    user.username,
    'initial-password',
    { teamId: 'not-an-object-id' }
  ).expect(400);
  assert.equal(validCredentials.body.code, 'AUTH_INPUT_INVALID');
  assert.equal(await AuthSession.countDocuments(), 0);
});

test('ordinary login rejects users with no active team and creates no session', async () => {
  const user = await createUser({ username: 'no.team' });

  const response = await login(user.username).expect(403);

  assert.equal(response.body.code, 'AUTH_TEAM_ACCESS_REQUIRED');
  assert.equal(await AuthSession.countDocuments(), 0);
});

test('unknown username and wrong password have the same failure response', async () => {
  const user = await createUser({ username: 'known.user' });

  const wrongPassword = await login(user.username, 'wrong-password').expect(401);
  const unknownUser = await login('unknown.user', 'wrong-password').expect(401);

  assert.deepEqual(unknownUser.body, wrongPassword.body);
  assert.equal(wrongPassword.body.code, 'AUTH_CREDENTIALS_INVALID');
});

test('switch-team rotates the session and invalidates the old token', async () => {
  const user = await createUser({ username: 'switch.user' });
  const first = await createTeam({ createdBy: user._id, member: user });
  const second = await createTeam({ createdBy: user._id, member: user });
  const signedIn = await login(user.username).expect(200);

  const switched = await request(app)
    .post('/api/auth/switch-team')
    .set(bearer(signedIn.body.token))
    .send({ teamId: second.team.id })
    .expect(200);

  assert.equal(switched.body.mode, permissions.SESSION_MODES.TEAM);
  assert.equal(switched.body.activeTeamId, second.team.id);
  await request(app)
    .get('/api/auth/me')
    .set(bearer(signedIn.body.token))
    .expect(401);
  await request(app)
    .get('/api/auth/me')
    .set(bearer(switched.body.token))
    .expect(200)
    .expect(({ body }) => {
      assert.equal(body.context.activeTeamId, second.team.id);
    });

  assert.equal(await AuthSession.countDocuments({ revokedAt: null }), 1);
  assert.equal(
    await AuthSession.countDocuments({ revokeReason: permissions.SESSION_REVOKE_REASONS.TEAM_SWITCH }),
    1
  );
  assert.notEqual(first.team.id, second.team.id);
});

test('ordinary users cannot distinguish an unowned team from a missing team', async () => {
  const user = await createUser({ username: 'scope.probe' });
  await createTeam({ createdBy: user._id, member: user });
  const unowned = await createTeam({ createdBy: user._id });
  const signedIn = await login(user.username).expect(200);

  const unownedResponse = await request(app)
    .post('/api/auth/switch-team')
    .set(bearer(signedIn.body.token))
    .send({ teamId: unowned.team.id })
    .expect(404);
  const missingResponse = await request(app)
    .post('/api/auth/switch-team')
    .set(bearer(signedIn.body.token))
    .send({ teamId: new mongoose.Types.ObjectId().toString() })
    .expect(404);

  assert.deepEqual(unownedResponse.body, missingResponse.body);
  assert.equal(unownedResponse.body.code, 'AUTH_TEAM_NOT_FOUND');
  await request(app)
    .get('/api/auth/me')
    .set(bearer(signedIn.body.token))
    .expect(200);
});

test('concurrent team switches allow exactly one successor session', async () => {
  const user = await createUser({ username: 'race.user' });
  await createTeam({ createdBy: user._id, member: user });
  const target = await createTeam({ createdBy: user._id, member: user });
  const signedIn = await login(user.username).expect(200);

  const attempts = await Promise.all([
    request(app)
      .post('/api/auth/switch-team')
      .set(bearer(signedIn.body.token))
      .send({ teamId: target.team.id }),
    request(app)
      .post('/api/auth/switch-team')
      .set(bearer(signedIn.body.token))
      .send({ teamId: target.team.id })
  ]);

  assert.deepEqual(attempts.map(({ status }) => status).sort(), [200, 401]);
  assert.equal(await AuthSession.countDocuments({ revokedAt: null }), 1);
  assert.equal(
    await AuthSession.countDocuments({ revokeReason: permissions.SESSION_REVOKE_REASONS.TEAM_SWITCH }),
    1
  );
});

test('global-readonly rejects ordinary users without rotating their session', async () => {
  const user = await createUser({ username: 'ordinary.user' });
  await createTeam({ createdBy: user._id, member: user });
  const signedIn = await login(user.username).expect(200);

  const denied = await request(app)
    .post('/api/auth/global-readonly')
    .set(bearer(signedIn.body.token))
    .expect(403);

  assert.equal(denied.body.code, 'AUTH_SUPER_ADMIN_REQUIRED');
  await request(app)
    .get('/api/auth/me')
    .set(bearer(signedIn.body.token))
    .expect(200);
  assert.equal(await AuthSession.countDocuments({ revokedAt: null }), 1);
});

test('logout revokes only the current session', async () => {
  const user = await createUser({ username: 'logout.user' });
  await createTeam({ createdBy: user._id, member: user });
  const first = await login(user.username).expect(200);
  const second = await login(user.username).expect(200);

  await request(app)
    .post('/api/auth/logout')
    .set(bearer(first.body.token))
    .expect(200);

  await request(app)
    .get('/api/auth/me')
    .set(bearer(first.body.token))
    .expect(401);
  await request(app)
    .get('/api/auth/me')
    .set(bearer(second.body.token))
    .expect(200);
  assert.equal(await AuthSession.countDocuments({ revokedAt: null }), 1);
  assert.equal(
    await AuthSession.countDocuments({ revokeReason: permissions.SESSION_REVOKE_REASONS.LOGOUT }),
    1
  );
});

test('change-password increments tokenVersion and revokes every active session', async () => {
  const user = await createUser({ username: 'password.user' });
  await createTeam({ createdBy: user._id, member: user });
  const first = await login(user.username).expect(200);
  const second = await login(user.username).expect(200);

  await request(app)
    .post('/api/auth/change-password')
    .set(bearer(first.body.token))
    .send({
      oldPassword: 'initial-password',
      newPassword: 'replacement-password'
    })
    .expect(200);

  const storedUser = await User.findById(user._id);
  assert.equal(storedUser.tokenVersion, 1);
  assert.equal(await storedUser.comparePassword('replacement-password'), true);
  assert.equal(await AuthSession.countDocuments({ revokedAt: null }), 0);
  assert.equal(
    await AuthSession.countDocuments({
      revokeReason: permissions.SESSION_REVOKE_REASONS.PASSWORD_CHANGED
    }),
    2
  );
  const audit = await AuditLog.findOne({
    action: permissions.AUDIT_ACTIONS.UPDATE,
    resourceType: permissions.AUDIT_RESOURCE_TYPES.USER,
    resourceId: user.id
  }).lean();
  assert.ok(audit);
  assert.deepEqual(audit.before, { tokenVersion: '[REDACTED]' });
  assert.equal(audit.after.tokenVersion, '[REDACTED]');
  assert.equal(audit.after.authenticationStateChanged, true);
  assert.equal(JSON.stringify(audit).includes('replacement-password'), false);

  await request(app).get('/api/auth/me').set(bearer(first.body.token)).expect(401);
  await request(app).get('/api/auth/me').set(bearer(second.body.token)).expect(401);
  await login(user.username, 'initial-password').expect(401);
  await login(user.username, 'replacement-password').expect(200);
});

test('authentication lifecycle writes sanitized audit evidence', async () => {
  const superAdmin = await createUser({
    username: 'audit.root',
    isSuperAdmin: true
  });
  const { team } = await createTeam({ createdBy: superAdmin._id });

  await login('missing.audit.user', 'wrong-password').expect(401);
  const signedIn = await login(superAdmin.username).expect(200);
  const entered = await request(app)
    .post('/api/auth/switch-team')
    .set(bearer(signedIn.body.token))
    .send({ teamId: team.id })
    .expect(200);
  const global = await request(app)
    .post('/api/auth/global-readonly')
    .set(bearer(entered.body.token))
    .expect(200);
  await request(app)
    .post('/api/auth/logout')
    .set(bearer(global.body.token))
    .expect(200);

  const events = await AuditLog.find({}).sort({ createdAt: 1 }).lean();
  assert.deepEqual(
    events.map(({ action }) => action),
    [
      permissions.AUDIT_ACTIONS.LOGIN_FAILURE,
      permissions.AUDIT_ACTIONS.LOGIN_SUCCESS,
      permissions.AUDIT_ACTIONS.ENTER_TEAM,
      permissions.AUDIT_ACTIONS.EXIT_TEAM,
      permissions.AUDIT_ACTIONS.LOGOUT
    ]
  );
  assert.equal(events[0].actorRole, permissions.AUDIT_ACTOR_ROLES.SYSTEM);
  assert.equal(events[0].after.usernameNormalized, 'missing.audit.user');
  assert.equal(events[1].actorUserId.toString(), superAdmin.id);
  assert.equal(events[1].actorMode, permissions.SESSION_MODES.GLOBAL_READ_ONLY);
  assert.equal(events[2].targetTeamId.toString(), team.id);
  assert.equal(events[3].before.activeTeamId, team.id);
  assert.equal(JSON.stringify(events).includes('wrong-password'), false);
});

test('legacy register is team-scoped and cannot create a global identity', async () => {
  const projectAdmin = await createUser({
    username: 'project.admin',
    roles: ['executor']
  });
  await createTeam({
    createdBy: projectAdmin._id,
    member: projectAdmin,
    membership: { role: permissions.MEMBERSHIP_ROLES.PROJECT_ADMIN }
  });
  const signedIn = await login(projectAdmin.username).expect(200);

  const response = await request(app)
    .post('/api/auth/register')
    .set(bearer(signedIn.body.token))
    .send({
      username: 'must.not.exist',
      password: 'some-password',
      name: 'Must Not Exist',
      roles: ['admin'],
      isSuperAdmin: true
    })
    .expect(501);

  assert.equal(response.body.code, 'AUTH_REGISTRATION_MOVED');
  assert.equal(await User.exists({ usernameNormalized: 'must.not.exist' }), null);
});
