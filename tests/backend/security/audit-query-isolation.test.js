'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { after, before, test } = require('node:test');
const appRequire = require('../helpers/appRequire');

const TEST_DATABASE_NAME = `audit_query_${randomUUID().replaceAll('-', '')}_v2_test`;
const JWT_SECRET = 'audit-query-test-secret-0123456789abcdef012345';

process.env.JWT_SECRET = JWT_SECRET;
process.env.JWT_EXPIRE = '1h';
process.env.JWT_ISSUER = 'task-distribution-v2';
process.env.JWT_AUDIENCE = 'task-distribution-v2-clients';

const mongoose = appRequire('mongoose');
const request = appRequire('supertest');
const { MongoMemoryServer } = appRequire('mongodb-memory-server');

const { createApp } = require('../../../app/app');
const {
  AUDIT_ACTIONS,
  AUDIT_ACTOR_MODES,
  AUDIT_ACTOR_ROLES,
  AUDIT_RESOURCE_TYPES,
  MEMBERSHIP_ROLES,
  ORG_UNIT_TYPES,
  POSITION_KEYS,
  SESSION_MODES
} = require('../../../app/config/permissions');
const { SYSTEM_ACCOUNT_DISPLAY_NAME } = require('../../../app/config/systemAccount');
const AuditLog = require('../../../app/models/AuditLog');
const AuthSession = require('../../../app/models/AuthSession');
const OrgUnit = require('../../../app/models/OrgUnit');
const ProjectTeam = require('../../../app/models/ProjectTeam');
const TeamMembership = require('../../../app/models/TeamMembership');
const User = require('../../../app/models/User');
const { createSessionLifecycleService } = require('../../../app/services/sessionLifecycleService');

const MODELS = [AuditLog, AuthSession, TeamMembership, OrgUnit, ProjectTeam, User];

let app;
let mongoServer;
let seeded;

function appConfig() {
  return {
    appEnv: 'test',
    nodeEnv: 'test',
    instanceName: 'audit-query-v2-test',
    port: 18097,
    mongodbUri: `mongodb://127.0.0.1:27017/${TEST_DATABASE_NAME}`,
    jwtSecret: JWT_SECRET,
    jwtExpire: '1h',
    uploadPath: path.resolve(__dirname, '../../.test-data/audit-query-uploads'),
    maxFileSize: 10 * 1024 * 1024,
    corsOrigins: ['http://localhost:3101'],
    enableLegacyPublicUploads: false
  };
}

async function createUser(username, overrides = {}) {
  return User.create({
    username,
    password: 'test-password-123',
    name: username,
    roles: ['executor'],
    ...overrides
  });
}

async function issueToken(user, mode, activeTeamId = null) {
  const issued = await createSessionLifecycleService().issueSession({
    userId: user._id,
    mode,
    activeTeamId,
    tokenVersion: user.tokenVersion
  });
  return issued.token;
}

async function seedFoundation() {
  const superAdmin = await createUser('audit-super-admin', {
    name: 'Audit Super Admin',
    isSuperAdmin: true,
    roles: ['admin']
  });
  const adminA = await createUser('audit-project-admin-a', { name: 'Project Admin A' });
  const adminWithoutPermission = await createUser('audit-admin-no-permission', { name: 'Admin Without Permission' });
  const memberA = await createUser('audit-member-a', { name: 'Member A' });
  const systemAccount = await createUser('secret.system.account', {
    name: 'Actual Internal Operator',
    phone: '13800138000',
    email: 'internal-secret@example.test',
    avatar: '/private/internal-secret.png',
    isSuperAdmin: true,
    isSystemAccount: true,
    roles: ['admin']
  });

  const [teamA, teamB] = await ProjectTeam.create([
    { code: 'AUDIT_TEAM_A', name: 'Audit Team A', createdBy: superAdmin._id },
    { code: 'AUDIT_TEAM_B', name: 'Audit Team B', createdBy: superAdmin._id }
  ]);
  const [orgA, orgB] = await OrgUnit.create([
    {
      teamId: teamA._id,
      type: ORG_UNIT_TYPES.DEPARTMENT,
      code: 'ROOT',
      name: 'Audit Team A Root',
      level: 1,
      path: '/'
    },
    {
      teamId: teamB._id,
      type: ORG_UNIT_TYPES.DEPARTMENT,
      code: 'ROOT',
      name: 'Audit Team B Root',
      level: 1,
      path: '/'
    }
  ]);
  await TeamMembership.create([
    {
      teamId: teamA._id,
      userId: adminA._id,
      orgUnitId: orgA._id,
      role: MEMBERSHIP_ROLES.PROJECT_ADMIN,
      positionKey: POSITION_KEYS.DEPARTMENT_MANAGER,
      positionLevel: 1,
      permissionKeys: ['audit.view']
    },
    {
      teamId: teamA._id,
      userId: adminWithoutPermission._id,
      orgUnitId: orgA._id,
      role: MEMBERSHIP_ROLES.PROJECT_ADMIN,
      positionKey: POSITION_KEYS.DEPARTMENT_MANAGER,
      positionLevel: 1,
      permissionKeys: []
    },
    {
      teamId: teamA._id,
      userId: memberA._id,
      orgUnitId: orgA._id,
      role: MEMBERSHIP_ROLES.MEMBER,
      permissionKeys: ['audit.view']
    }
  ]);

  const timestamps = {
    teamA: new Date('2026-07-01T01:00:00.000Z'),
    teamB: new Date('2026-07-02T02:00:00.000Z'),
    system: new Date('2026-07-03T03:00:00.000Z'),
    hidden: new Date('2026-07-04T04:00:00.000Z'),
    membership: new Date('2026-07-05T05:00:00.000Z')
  };
  const result = await AuditLog.collection.insertMany([
    {
      actorUserId: adminA._id,
      actorRole: AUDIT_ACTOR_ROLES.PROJECT_ADMIN,
      actorMode: AUDIT_ACTOR_MODES.TEAM,
      activeTeamId: teamA._id,
      targetTeamId: teamA._id,
      action: AUDIT_ACTIONS.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPES.TASK,
      resourceId: 'task-a',
      before: { status: 'OLD' },
      after: { status: 'NEW' },
      reason: 'Team A update',
      requestId: 'req-team-a',
      requestMethod: 'PATCH',
      requestPath: '/api/tasks/task-a',
      ip: '127.0.0.1',
      userAgent: 'secret-test-agent',
      createdAt: timestamps.teamA,
      updatedAt: timestamps.teamA
    },
    {
      actorUserId: superAdmin._id,
      actorRole: AUDIT_ACTOR_ROLES.SUPER_ADMIN,
      actorMode: AUDIT_ACTOR_MODES.TEAM,
      activeTeamId: teamB._id,
      targetTeamId: teamB._id,
      action: AUDIT_ACTIONS.CREATE,
      resourceType: AUDIT_RESOURCE_TYPES.EQUIPMENT_ASSET,
      resourceId: 'equipment-b',
      requestId: 'req-team-b',
      createdAt: timestamps.teamB,
      updatedAt: timestamps.teamB
    },
    {
      actorUserId: null,
      actorRole: AUDIT_ACTOR_ROLES.SYSTEM,
      actorMode: AUDIT_ACTOR_MODES.SYSTEM,
      activeTeamId: null,
      targetTeamId: null,
      action: AUDIT_ACTIONS.LOGIN_FAILURE,
      resourceType: AUDIT_RESOURCE_TYPES.SYSTEM,
      resourceId: 'authentication',
      requestId: 'req-system',
      createdAt: timestamps.system,
      updatedAt: timestamps.system
    },
    {
      actorUserId: systemAccount._id,
      actorRole: AUDIT_ACTOR_ROLES.SUPER_ADMIN,
      actorMode: AUDIT_ACTOR_MODES.TEAM,
      activeTeamId: teamA._id,
      targetTeamId: teamA._id,
      action: AUDIT_ACTIONS.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPES.USER,
      resourceId: systemAccount._id.toString(),
      before: {
        username: 'secret.system.account',
        password: 'raw-password-value',
        nested: { token: 'raw-token-value', cookie: 'raw-cookie-value' }
      },
      after: {
        owner: 'Actual Internal Operator',
        authorization: 'Bearer raw-bearer-value'
      },
      reason: 'token=raw-reason-token actor=secret.system.account',
      requestId: 'secret.system.account',
      requestMethod: 'PATCH',
      requestPath: '/internal?token=raw-path-token',
      ip: '10.0.0.9',
      userAgent: 'raw-private-agent',
      createdAt: timestamps.hidden,
      updatedAt: timestamps.hidden
    },
    {
      actorUserId: adminA._id,
      actorRole: AUDIT_ACTOR_ROLES.PROJECT_ADMIN,
      actorMode: AUDIT_ACTOR_MODES.TEAM,
      activeTeamId: teamA._id,
      targetTeamId: teamA._id,
      action: AUDIT_ACTIONS.PERMISSION_UPDATE,
      resourceType: AUDIT_RESOURCE_TYPES.TEAM_MEMBERSHIP,
      resourceId: 'membership-a',
      before: {
        linkedUserId: systemAccount._id.toString(),
        linkedUsername: 'secret.system.account',
        arbitraryResourceSnapshot: [{ ownerId: systemAccount._id }]
      },
      after: { note: 'Handled by Actual Internal Operator' },
      reason: `membership for ${systemAccount._id}`,
      requestId: 'req-membership-a',
      createdAt: timestamps.membership,
      updatedAt: timestamps.membership
    }
  ]);

  return {
    superAdmin,
    adminA,
    adminWithoutPermission,
    memberA,
    systemAccount,
    teamA,
    teamB,
    logIds: Object.fromEntries(Object.entries(result.insertedIds).map(([index, id]) => [Number(index), id.toString()])),
    globalSuperToken: await issueToken(superAdmin, SESSION_MODES.GLOBAL_READ_ONLY),
    teamSuperToken: await issueToken(superAdmin, SESSION_MODES.TEAM, teamA._id),
    selectionSuperToken: await issueToken(superAdmin, SESSION_MODES.TEAM_SELECTION),
    adminAToken: await issueToken(adminA, SESSION_MODES.TEAM, teamA._id),
    adminWithoutPermissionToken: await issueToken(adminWithoutPermission, SESSION_MODES.TEAM, teamA._id),
    memberAToken: await issueToken(memberA, SESSION_MODES.TEAM, teamA._id)
  };
}

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

before(async () => {
  assert.match(TEST_DATABASE_NAME, /_v2_test$/);
  mongoServer = await MongoMemoryServer.create({ instance: { dbName: TEST_DATABASE_NAME } });
  await mongoose.connect(mongoServer.getUri(TEST_DATABASE_NAME), { dbName: TEST_DATABASE_NAME });
  assert.equal(mongoose.connection.name, TEST_DATABASE_NAME);
  for (const model of MODELS) await model.syncIndexes();
  app = createApp(appConfig());
  seeded = await seedFoundation();
});

after(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});

test('global super administrators can read and filter cross-team and system audit logs', async () => {
  const response = await request(app)
    .get('/api/audit-logs?page=1&pageSize=2')
    .set(bearer(seeded.globalSuperToken))
    .expect(200);
  assert.equal(response.body.total, 5);
  assert.equal(response.body.auditLogs.length, 2);
  assert.deepEqual(
    response.body.auditLogs.map((log) => log.resourceId),
    ['membership-a', null]
  );

  const secondPage = await request(app)
    .get('/api/audit-logs?page=2&pageSize=2')
    .set(bearer(seeded.globalSuperToken))
    .expect(200);
  assert.equal(secondPage.body.auditLogs.length, 2);
  assert.ok(secondPage.body.auditLogs.some((log) => log.targetTeamId === null));

  const teamB = await request(app)
    .get(`/api/audit-logs?teamId=${seeded.teamB._id}`)
    .set(bearer(seeded.globalSuperToken))
    .expect(200);
  assert.equal(teamB.body.total, 1);
  assert.equal(teamB.body.auditLogs[0].targetTeam.name, 'Audit Team B');

  const system = await request(app)
    .get('/api/audit-logs?targetTeamId=SYSTEM')
    .set(bearer(seeded.globalSuperToken))
    .expect(200);
  assert.equal(system.body.total, 1);
  assert.equal(system.body.auditLogs[0].targetTeamId, null);
});

test('time, actor, target, resource, action, resource id, request id, and pagination filters compose exactly', async () => {
  const query = new URLSearchParams({
    startTime: '2026-07-01T00:00:00.000Z',
    endTime: '2026-07-01T23:59:59.999Z',
    actorUserId: seeded.adminA._id.toString(),
    targetTeamId: seeded.teamA._id.toString(),
    resourceType: AUDIT_RESOURCE_TYPES.TASK,
    action: AUDIT_ACTIONS.UPDATE,
    resourceId: 'task-a',
    requestId: 'req-team-a',
    page: '1',
    pageSize: '20'
  });
  const response = await request(app)
    .get(`/api/audit-logs?${query}`)
    .set(bearer(seeded.globalSuperToken))
    .expect(200);
  assert.equal(response.body.total, 1);
  assert.equal(response.body.auditLogs[0].resourceId, 'task-a');
  assert.equal(response.body.auditLogs[0].actor.name, 'Project Admin A');
  assert.equal(response.body.auditLogs[0].targetTeam.name, 'Audit Team A');
});

test('project administrators and team-mode super administrators are restricted to the active team', async () => {
  for (const token of [seeded.adminAToken, seeded.teamSuperToken]) {
    const response = await request(app)
      .get('/api/audit-logs?pageSize=100')
      .set(bearer(token))
      .expect(200);
    assert.equal(response.body.total, 3);
    assert.ok(response.body.auditLogs.every((log) => log.targetTeamId === seeded.teamA.id));
    assert.ok(response.body.auditLogs.every((log) => log.targetTeamId !== null));

    await request(app)
      .get(`/api/audit-logs?targetTeamId=${seeded.teamB._id}`)
      .set(bearer(token))
      .expect(403);
    await request(app)
      .get('/api/audit-logs?targetTeamId=SYSTEM')
      .set(bearer(token))
      .expect(403);
    await request(app)
      .get(`/api/audit-logs/${seeded.logIds[1]}`)
      .set(bearer(token))
      .expect(404);
  }
});

test('ordinary members stay denied even when audit.view is misconfigured, and TEAM_SELECTION is denied', async () => {
  await request(app)
    .get('/api/audit-logs')
    .set(bearer(seeded.memberAToken))
    .expect(403);
  await request(app)
    .get('/api/audit-logs')
    .set(bearer(seeded.adminWithoutPermissionToken))
    .expect(403);
  await request(app)
    .get('/api/audit-logs')
    .set(bearer(seeded.selectionSuperToken))
    .expect(403);
});

test('detail presentation hides system identities and credential-bearing fields defensively', async () => {
  const response = await request(app)
    .get(`/api/audit-logs/${seeded.logIds[3]}`)
    .set(bearer(seeded.globalSuperToken))
    .expect(200);
  const log = response.body.auditLog;
  assert.equal(log.actor.name, SYSTEM_ACCOUNT_DISPLAY_NAME);
  assert.equal(log.actorUserId, null);
  assert.equal(log.resourceId, null);
  for (const field of ['ip', 'userAgent', 'updatedAt']) {
    assert.equal(Object.hasOwn(log, field), false);
  }
  const serialized = JSON.stringify(log);
  for (const secret of [
    'secret.system.account',
    'Actual Internal Operator',
    '13800138000',
    'internal-secret@example.test',
    'raw-password-value',
    'raw-token-value',
    'raw-cookie-value',
    'raw-bearer-value',
    'raw-reason-token',
    'raw-path-token',
    'raw-private-agent',
    seeded.systemAccount._id.toString()
  ]) {
    assert.equal(serialized.includes(secret), false, `${secret} must not be exposed`);
  }
  assert.equal(log.before.password, '[REDACTED]');
  assert.equal(log.before.nested.token, '[REDACTED]');
  assert.equal(log.before.nested.cookie, '[REDACTED]');
});

test('system identity references are redacted from non-USER resource snapshots and text', async () => {
  const response = await request(app)
    .get(`/api/audit-logs/${seeded.logIds[4]}`)
    .set(bearer(seeded.globalSuperToken))
    .expect(200);
  assert.equal(response.body.auditLog.resourceType, AUDIT_RESOURCE_TYPES.TEAM_MEMBERSHIP);
  const serialized = JSON.stringify(response.body.auditLog);
  assert.equal(serialized.includes('secret.system.account'), false);
  assert.equal(serialized.includes('Actual Internal Operator'), false);
  assert.equal(serialized.includes(seeded.systemAccount._id.toString()), false);
  assert.match(serialized, /SYSTEM ACCOUNT/);
});

test('audit API exposes no POST, PATCH, DELETE, or export operation', async () => {
  const countBefore = await AuditLog.countDocuments({});
  await request(app)
    .post('/api/audit-logs')
    .set(bearer(seeded.globalSuperToken))
    .send({ action: 'DELETE' })
    .expect(404);
  await request(app)
    .patch(`/api/audit-logs/${seeded.logIds[0]}`)
    .set(bearer(seeded.globalSuperToken))
    .send({ action: 'DELETE' })
    .expect(404);
  await request(app)
    .delete(`/api/audit-logs/${seeded.logIds[0]}`)
    .set(bearer(seeded.globalSuperToken))
    .expect(404);
  await request(app)
    .get('/api/audit-logs/export')
    .set(bearer(seeded.globalSuperToken))
    .expect(400);
  assert.equal(await AuditLog.countDocuments({}), countBefore);
});
