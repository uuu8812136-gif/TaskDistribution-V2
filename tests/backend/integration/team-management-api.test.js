'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { after, before, test } = require('node:test');
const appRequire = require('../helpers/appRequire');

const mongoose = appRequire('mongoose');
const { MongoMemoryReplSet } = appRequire('mongodb-memory-server');
const request = appRequire('supertest');

const { createApp } = require('../../../app/app');
const AuditLog = require('../../../app/models/AuditLog');
const AuthSession = require('../../../app/models/AuthSession');
const OrgUnit = require('../../../app/models/OrgUnit');
const ProjectTeam = require('../../../app/models/ProjectTeam');
const TeamMembership = require('../../../app/models/TeamMembership');
const User = require('../../../app/models/User');
const {
  AUDIT_ACTIONS,
  AUDIT_ACTOR_MODES,
  AUDIT_RESOURCE_TYPES,
  MEMBERSHIP_ROLES,
  MEMBERSHIP_STATUSES,
  ORG_UNIT_TYPES,
  PERMISSION_KEYS,
  POSITION_KEYS,
  SESSION_MODES,
  TEAM_STATUSES
} = require('../../../app/config/permissions');
const { createSessionLifecycleService } = require('../../../app/services/sessionLifecycleService');
const { createTeamManagementService } = require('../../../app/services/teamManagementService');

const TEST_DATABASE_NAME = `team_management_${randomUUID().replaceAll('-', '')}_v2_test`;
const JWT_SECRET = 'team-management-test-secret-0123456789abcdef';
const MODELS = [AuditLog, AuthSession, OrgUnit, ProjectTeam, TeamMembership, User];

let replSet;
let app;
let seeded;

function appConfig() {
  return {
    appEnv: 'test',
    nodeEnv: 'test',
    instanceName: 'team-management-v2-test',
    port: 18098,
    mongodbUri: `mongodb://127.0.0.1:27017/${TEST_DATABASE_NAME}`,
    jwtSecret: JWT_SECRET,
    jwtExpire: '1h',
    uploadPath: path.resolve(__dirname, '../../.test-data/team-management-uploads'),
    maxFileSize: 10 * 1024 * 1024,
    corsOrigins: ['http://localhost:3101'],
    enableLegacyPublicUploads: false
  };
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

async function createUser(username, isSuperAdmin = false) {
  return User.create({
    username,
    password: 'test-password-123',
    name: username,
    isSuperAdmin,
    roles: isSuperAdmin ? ['admin'] : ['executor']
  });
}

async function seedFoundation() {
  const superAdmin = await createUser('global-super-admin', true);
  const adminA = await createUser('project-admin-a');
  const memberA = await createUser('member-a');
  const memberB = await createUser('member-b');

  const [teamA, teamB] = await ProjectTeam.create([
    { code: 'TEAM_A', name: 'Team A', createdBy: superAdmin._id },
    { code: 'TEAM_B', name: 'Team B', createdBy: superAdmin._id }
  ]);
  const [rootA, rootB] = await OrgUnit.create([
    {
      teamId: teamA._id,
      type: ORG_UNIT_TYPES.DEPARTMENT,
      code: 'ROOT',
      name: 'Team A Root',
      level: 1,
      path: '/'
    },
    {
      teamId: teamB._id,
      type: ORG_UNIT_TYPES.DEPARTMENT,
      code: 'ROOT',
      name: 'Team B Root',
      level: 1,
      path: '/'
    }
  ]);
  const [adminMembershipA, memberMembershipA, memberMembershipB] = await TeamMembership.create([
    {
      teamId: teamA._id,
      userId: adminA._id,
      orgUnitId: rootA._id,
      role: MEMBERSHIP_ROLES.PROJECT_ADMIN,
      positionKey: POSITION_KEYS.DEPARTMENT_MANAGER,
      positionLevel: 1,
      permissionKeys: ['member.view', 'member.manage', 'org.manage']
    },
    {
      teamId: teamA._id,
      userId: memberA._id,
      orgUnitId: rootA._id,
      permissionKeys: ['task.view']
    },
    {
      teamId: teamB._id,
      userId: memberB._id,
      orgUnitId: rootB._id,
      permissionKeys: ['member.view']
    }
  ]);

  return {
    superAdmin,
    adminA,
    memberA,
    memberB,
    teamA,
    teamB,
    rootA,
    rootB,
    adminMembershipA,
    memberMembershipA,
    memberMembershipB,
    globalSuperToken: await issueToken(superAdmin, SESSION_MODES.GLOBAL_READ_ONLY),
    teamSuperToken: await issueToken(superAdmin, SESSION_MODES.TEAM, teamA._id),
    adminAToken: await issueToken(adminA, SESSION_MODES.TEAM, teamA._id),
    memberAToken: await issueToken(memberA, SESSION_MODES.TEAM, teamA._id)
  };
}

before(async () => {
  assert.match(TEST_DATABASE_NAME, /_v2_test$/);
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.JWT_EXPIRE = '1h';
  process.env.JWT_ISSUER = 'task-distribution-v2';
  process.env.JWT_AUDIENCE = 'task-distribution-v2-clients';

  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    instanceOpts: [{ dbName: TEST_DATABASE_NAME }]
  });
  await mongoose.connect(replSet.getUri(TEST_DATABASE_NAME), {
    dbName: TEST_DATABASE_NAME
  });
  assert.equal(mongoose.connection.name, TEST_DATABASE_NAME);
  for (const model of MODELS) await model.syncIndexes();

  app = createApp(appConfig());
  seeded = await seedFoundation();
});

after(async () => {
  if (mongoose.connection.readyState !== 0) {
    assert.equal(mongoose.connection.name, TEST_DATABASE_NAME);
    await mongoose.disconnect();
  }
  if (replSet) await replSet.stop();
});

test('team management APIs enforce tenant isolation, fixed privilege rules, and audit writes', async (t) => {
  await t.test('cross-team management metadata is available only in global read-only mode', async () => {
    const globalResponse = await request(app)
      .get('/api/teams')
      .set('Authorization', `Bearer ${seeded.globalSuperToken}`)
      .expect(200);
    assert.deepEqual(
      globalResponse.body.teams.map((team) => team.code),
      ['TEAM_A', 'TEAM_B']
    );

    const teamResponse = await request(app)
      .get('/api/teams')
      .set('Authorization', `Bearer ${seeded.teamSuperToken}`)
      .expect(200);
    assert.deepEqual(teamResponse.body.teams.map((team) => team.code), ['TEAM_A']);
  });

  await t.test('a project administrator lists only the active team and cannot address team B objects', async () => {
    const listResponse = await request(app)
      .get('/api/team-members')
      .set('Authorization', `Bearer ${seeded.adminAToken}`)
      .expect(200);

    assert.deepEqual(
      listResponse.body.members.map((member) => member.teamId),
      [seeded.teamA._id.toString(), seeded.teamA._id.toString()]
    );
    assert.ok(!listResponse.body.members.some(
      (member) => member.userId === seeded.memberB._id.toString()
    ));

    const crossTeamMemberResponse = await request(app)
      .patch(`/api/team-members/${seeded.memberMembershipB._id}`)
      .set('Authorization', `Bearer ${seeded.adminAToken}`)
      .send({ permissionKeys: ['task.view'] })
      .expect(404);
    assert.equal(crossTeamMemberResponse.body.code, 'MANAGEMENT_RESOURCE_NOT_FOUND');

    const crossTeamOrgResponse = await request(app)
      .patch(`/api/org-units/${seeded.rootB._id}`)
      .set('Authorization', `Bearer ${seeded.adminAToken}`)
      .send({ name: 'Leaked rename' })
      .expect(404);
    assert.equal(crossTeamOrgResponse.body.code, 'MANAGEMENT_RESOURCE_NOT_FOUND');
    assert.equal((await OrgUnit.findById(seeded.rootB._id).lean()).name, 'Team B Root');
  });

  await t.test('system identities stay outside membership listing and mutation paths', async () => {
    const systemUser = await createUser('internal-control-identity', true);
    systemUser.isSystemAccount = true;
    await systemUser.save();
    const systemMembership = await TeamMembership.create({
      teamId: seeded.teamA._id,
      userId: systemUser._id,
      orgUnitId: seeded.rootA._id,
      role: MEMBERSHIP_ROLES.PROJECT_ADMIN,
      positionKey: POSITION_KEYS.DEPARTMENT_MANAGER,
      positionLevel: 1,
      permissionKeys: ['member.view', 'member.manage']
    });

    try {
      const listResponse = await request(app)
        .get('/api/team-members')
        .query({ page: 1, limit: 1 })
        .set('Authorization', `Bearer ${seeded.adminAToken}`)
        .expect(200);
      assert.equal(listResponse.body.pagination.total, 2);
      assert.equal(listResponse.body.pagination.pages, 2);
      assert.equal(listResponse.body.members.length, 1);
      assert.ok(!listResponse.body.members.some(
        (member) => member.userId === systemUser._id.toString()
      ));

      const createResponse = await request(app)
        .post('/api/team-members')
        .set('Authorization', `Bearer ${seeded.teamSuperToken}`)
        .send({
          existingUserId: systemUser._id.toString(),
          orgUnitId: seeded.rootA._id.toString()
        })
        .expect(404);
      assert.equal(createResponse.body.code, 'MANAGEMENT_RESOURCE_NOT_FOUND');

      const updateResponse = await request(app)
        .patch(`/api/team-members/${systemMembership._id}`)
        .set('Authorization', `Bearer ${seeded.teamSuperToken}`)
        .send({ permissionKeys: ['task.view'] })
        .expect(404);
      assert.equal(updateResponse.body.code, 'MANAGEMENT_RESOURCE_NOT_FOUND');

      const unchanged = await TeamMembership.findById(systemMembership._id).lean();
      assert.deepEqual(unchanged.permissionKeys.sort(), ['member.manage', 'member.view']);
    } finally {
      await TeamMembership.deleteOne({ _id: systemMembership._id });
      await User.deleteOne({ _id: systemUser._id });
    }
  });

  await t.test('a project administrator cannot create an administrator or inject derived privilege fields', async () => {
    await request(app)
      .post('/api/team-members')
      .set('Authorization', `Bearer ${seeded.adminAToken}`)
      .send({
        username: 'forbidden-project-admin',
        password: 'test-password-123',
        name: 'Forbidden Admin',
        orgUnitId: seeded.rootA._id.toString(),
        role: MEMBERSHIP_ROLES.PROJECT_ADMIN
      })
      .expect(403);

    await request(app)
      .post('/api/team-members')
      .set('Authorization', `Bearer ${seeded.adminAToken}`)
      .send({
        username: 'forbidden-data-scope',
        password: 'test-password-123',
        name: 'Forbidden Scope',
        orgUnitId: seeded.rootA._id.toString(),
        moduleDataScopes: [{ moduleKey: 'task', scope: 'TEAM' }]
      })
      .expect(403);

    await request(app)
      .post('/api/team-members')
      .set('Authorization', `Bearer ${seeded.adminAToken}`)
      .send({
        username: 'forbidden-system-account',
        password: 'test-password-123',
        name: 'Forbidden System Account',
        orgUnitId: seeded.rootA._id.toString(),
        isSystemAccount: true
      })
      .expect(403);

    assert.equal(await User.countDocuments({
      usernameNormalized: {
        $in: ['forbidden-project-admin', 'forbidden-data-scope', 'forbidden-system-account']
      }
    }), 0);
  });

  await t.test('a project administrator creates only a team member and normalized usernames stay global', async () => {
    const createResponse = await request(app)
      .post('/api/team-members')
      .set('Authorization', `Bearer ${seeded.adminAToken}`)
      .send({
        username: ' New-Team-Member ',
        password: 'test-password-123',
        name: 'New Team Member',
        orgUnitId: seeded.rootA._id.toString(),
        positionKey: POSITION_KEYS.EMPLOYEE,
        permissionKeys: ['task.view']
      })
      .expect(201);

    assert.equal(createResponse.body.member.role, MEMBERSHIP_ROLES.MEMBER);
    assert.equal(createResponse.body.member.user.username, 'New-Team-Member');
    const storedUser = await User.findById(createResponse.body.member.userId).lean();
    assert.equal(storedUser.usernameNormalized, 'new-team-member');
    assert.equal(storedUser.isSystemAccount, false);

    const duplicateResponse = await request(app)
      .post('/api/team-members')
      .set('Authorization', `Bearer ${seeded.adminAToken}`)
      .send({
        username: 'new-team-member',
        password: 'test-password-456',
        name: 'Duplicate Identity',
        orgUnitId: seeded.rootA._id.toString()
      })
      .expect(409);
    assert.equal(duplicateResponse.body.code, 'USERNAME_EXISTS');
    assert.equal(await User.countDocuments({ usernameNormalized: 'new-team-member' }), 1);
  });

  await t.test('attendance reporter assignment is permissioned, division-only, and unique while active', async () => {
    const division = await OrgUnit.create({
      teamId: seeded.teamA._id,
      parentId: seeded.rootA._id,
      type: ORG_UNIT_TYPES.SUB_DEPARTMENT,
      code: 'ATTENDANCE_DIVISION',
      name: 'Attendance Division',
      level: 2,
      path: `/${seeded.rootA._id}/`
    });
    const otherDivision = await OrgUnit.create({
      teamId: seeded.teamA._id,
      parentId: seeded.rootA._id,
      type: ORG_UNIT_TYPES.SUB_DEPARTMENT,
      code: 'ATTENDANCE_DIVISION_OTHER',
      name: 'Attendance Division Other',
      level: 2,
      path: `/${seeded.rootA._id}/`
    });
    const reporterRole = 'ATTENDANCE_REPORTER';
    const denied = await request(app)
      .post('/api/team-members')
      .set('Authorization', `Bearer ${seeded.adminAToken}`)
      .send({
        username: 'attendance-reporter-denied',
        password: 'test-password-123',
        name: 'Attendance Reporter Denied',
        orgUnitId: division._id.toString(),
        functionalRoleKeys: [reporterRole]
      })
      .expect(403);
    assert.equal(denied.body.code, 'PERMISSION_DENIED');
    assert.equal(await User.countDocuments({ usernameNormalized: 'attendance-reporter-denied' }), 0);

    seeded.adminMembershipA.permissionKeys.push('reporter.assign');
    await seeded.adminMembershipA.save();

    const rootAssignment = await request(app)
      .post('/api/team-members')
      .set('Authorization', `Bearer ${seeded.adminAToken}`)
      .send({
        username: 'attendance-reporter-root',
        password: 'test-password-123',
        name: 'Attendance Reporter Root',
        orgUnitId: seeded.rootA._id.toString(),
        functionalRoleKeys: [reporterRole]
      })
      .expect(400);
    assert.equal(rootAssignment.body.code, 'ATTENDANCE_REPORTER_ORG_REQUIRED');

    const first = await request(app)
      .post('/api/team-members')
      .set('Authorization', `Bearer ${seeded.adminAToken}`)
      .send({
        username: 'attendance-reporter-first',
        password: 'test-password-123',
        name: 'Attendance Reporter First',
        orgUnitId: division._id.toString(),
        functionalRoleKeys: [reporterRole]
      })
      .expect(201);

    seeded.adminMembershipA.permissionKeys = seeded.adminMembershipA.permissionKeys.filter(
      (permissionKey) => permissionKey !== 'reporter.assign'
    );
    await seeded.adminMembershipA.save();
    await request(app)
      .patch(`/api/team-members/${first.body.member._id}`)
      .set('Authorization', `Bearer ${seeded.adminAToken}`)
      .send({ orgUnitId: otherDivision._id.toString() })
      .expect(403);
    seeded.adminMembershipA.permissionKeys.push('reporter.assign');
    await seeded.adminMembershipA.save();

    const duplicate = await request(app)
      .post('/api/team-members')
      .set('Authorization', `Bearer ${seeded.adminAToken}`)
      .send({
        username: 'attendance-reporter-duplicate',
        password: 'test-password-123',
        name: 'Attendance Reporter Duplicate',
        orgUnitId: division._id.toString(),
        functionalRoleKeys: [reporterRole]
      })
      .expect(409);
    assert.equal(duplicate.body.code, 'ATTENDANCE_REPORTER_EXISTS');
    assert.equal(await User.countDocuments({ usernameNormalized: 'attendance-reporter-duplicate' }), 0);

    await request(app)
      .patch(`/api/team-members/${first.body.member._id}`)
      .set('Authorization', `Bearer ${seeded.adminAToken}`)
      .send({ status: MEMBERSHIP_STATUSES.DISABLED, reason: '更换分部提报人' })
      .expect(200);

    const replacement = await request(app)
      .post('/api/team-members')
      .set('Authorization', `Bearer ${seeded.adminAToken}`)
      .send({
        username: 'attendance-reporter-replacement',
        password: 'test-password-123',
        name: 'Attendance Reporter Replacement',
        orgUnitId: division._id.toString(),
        functionalRoleKeys: [reporterRole]
      })
      .expect(201);
    assert.equal(replacement.body.member.status, MEMBERSHIP_STATUSES.ACTIVE);

    const reenable = await request(app)
      .patch(`/api/team-members/${first.body.member._id}`)
      .set('Authorization', `Bearer ${seeded.adminAToken}`)
      .send({ status: MEMBERSHIP_STATUSES.ACTIVE, reason: '验证唯一有效约束' })
      .expect(409);
    assert.equal(reenable.body.code, 'ATTENDANCE_REPORTER_EXISTS');
  });

  let createdTeam;
  await t.test('a global super administrator creates a team through the explicit control plane', async () => {
    const response = await request(app)
      .post('/api/teams')
      .set('Authorization', `Bearer ${seeded.globalSuperToken}`)
      .send({
        code: 'TEAM_C',
        name: 'Team C',
        settings: { timeZone: 'Asia/Shanghai' },
        reason: 'Customer project expansion'
      })
      .expect(201);

    createdTeam = response.body.team;
    assert.equal(createdTeam.code, 'TEAM_C');
    assert.equal(createdTeam.createdBy, seeded.superAdmin._id.toString());
    assert.equal(await ProjectTeam.countDocuments({ code: 'TEAM_C' }), 1);
  });

  await t.test('organization parents are resolved inside the active team', async () => {
    const response = await request(app)
      .post('/api/org-units')
      .set('Authorization', `Bearer ${seeded.adminAToken}`)
      .send({
        parentId: seeded.rootB._id.toString(),
        type: ORG_UNIT_TYPES.SUB_DEPARTMENT,
        code: 'CROSS_PARENT',
        name: 'Cross-team parent attempt'
      })
      .expect(404);

    assert.equal(response.body.code, 'MANAGEMENT_RESOURCE_NOT_FOUND');
    assert.equal(await OrgUnit.countDocuments({ code: 'CROSS_PARENT' }), 0);
  });

  await t.test('organization level and materialized path are generated by the server and cycles are rejected', async () => {
    const childResponse = await request(app)
      .post('/api/org-units')
      .set('Authorization', `Bearer ${seeded.adminAToken}`)
      .send({
        parentId: seeded.rootA._id.toString(),
        type: ORG_UNIT_TYPES.SUB_DEPARTMENT,
        code: 'SUB_A',
        name: 'Sub Department A'
      })
      .expect(201);
    assert.equal(childResponse.body.orgUnit.level, 2);
    assert.equal(childResponse.body.orgUnit.path, `/${seeded.rootA._id}/`);

    const grandchildResponse = await request(app)
      .post('/api/org-units')
      .set('Authorization', `Bearer ${seeded.adminAToken}`)
      .send({
        parentId: childResponse.body.orgUnit._id,
        type: ORG_UNIT_TYPES.TEAM_GROUP,
        code: 'GROUP_A',
        name: 'Group A'
      })
      .expect(201);
    assert.equal(grandchildResponse.body.orgUnit.level, 3);
    assert.equal(
      grandchildResponse.body.orgUnit.path,
      `/${seeded.rootA._id}/${childResponse.body.orgUnit._id}/`
    );

    await request(app)
      .patch(`/api/org-units/${childResponse.body.orgUnit._id}`)
      .set('Authorization', `Bearer ${seeded.adminAToken}`)
      .send({ parentId: grandchildResponse.body.orgUnit._id })
      .expect(400);
    assert.equal(
      (await OrgUnit.findById(childResponse.body.orgUnit._id).lean()).parentId.toString(),
      seeded.rootA._id.toString()
    );

    await request(app)
      .post('/api/org-units')
      .set('Authorization', `Bearer ${seeded.adminAToken}`)
      .send({
        parentId: seeded.rootA._id.toString(),
        code: 'CLIENT_PATH',
        name: 'Client Path',
        level: 5,
        path: '/'
      })
      .expect(400);
    assert.equal(await OrgUnit.countDocuments({ code: 'CLIENT_PATH' }), 0);
  });

  await t.test('permission updates take effect on the next request without replacing the JWT', async () => {
    await request(app)
      .get('/api/team-members')
      .set('Authorization', `Bearer ${seeded.memberAToken}`)
      .expect(403);

    await request(app)
      .patch(`/api/team-members/${seeded.memberMembershipA._id}`)
      .set('Authorization', `Bearer ${seeded.adminAToken}`)
      .send({ permissionKeys: ['task.view', 'member.view'] })
      .expect(200);

    const response = await request(app)
      .get('/api/team-members')
      .set('Authorization', `Bearer ${seeded.memberAToken}`)
      .expect(200);
    assert.ok(response.body.members.length >= 2);
  });

  await t.test('a super administrator inside team A can promote a member', async () => {
    const response = await request(app)
      .patch(`/api/team-members/${seeded.memberMembershipA._id}`)
      .set('Authorization', `Bearer ${seeded.teamSuperToken}`)
      .send({
        role: MEMBERSHIP_ROLES.PROJECT_ADMIN,
        permissionKeys: [...PERMISSION_KEYS]
      })
      .expect(200);

    assert.equal(response.body.member.role, MEMBERSHIP_ROLES.PROJECT_ADMIN);
    assert.equal(response.body.member.permissionKeys.length, PERMISSION_KEYS.length);
  });

  await t.test('an organization unit with active child access is not silently disabled', async () => {
    const response = await request(app)
      .patch(`/api/org-units/${seeded.rootA._id}`)
      .set('Authorization', `Bearer ${seeded.adminAToken}`)
      .send({
        status: 'DISABLED',
        reason: 'This must be rejected while active memberships remain'
      })
      .expect(409);

    assert.equal(response.body.code, 'ORG_UNIT_HAS_ACTIVE_DEPENDENCIES');
    assert.equal((await OrgUnit.findById(seeded.rootA._id).lean()).status, 'ACTIVE');
  });

  await t.test('member deletion disables only the membership and preserves the global identity', async () => {
    await request(app)
      .delete(`/api/team-members/${seeded.adminMembershipA._id}`)
      .set('Authorization', `Bearer ${seeded.teamSuperToken}`)
      .send({ reason: 'Access removed from this project only' })
      .expect(200);

    const membership = await TeamMembership.findById(seeded.adminMembershipA._id).lean();
    assert.equal(membership.status, MEMBERSHIP_STATUSES.DISABLED);
    assert.ok(await User.exists({ _id: seeded.adminA._id, status: 'active' }));
  });

  await t.test('team disable requires target-team context and global control plane can restore access', async () => {
    const disableResponse = await request(app)
      .patch(`/api/teams/${seeded.teamA._id}/status`)
      .set('Authorization', `Bearer ${seeded.teamSuperToken}`)
      .send({ status: TEAM_STATUSES.DISABLED, reason: 'Lifecycle test' })
      .expect(200);
    assert.equal(disableResponse.body.team.status, TEAM_STATUSES.DISABLED);

    const disabledContextResponse = await request(app)
      .get('/api/teams')
      .set('Authorization', `Bearer ${seeded.teamSuperToken}`)
      .expect(401);
    assert.equal(disabledContextResponse.body.code, 'AUTH_TEAM_DISABLED');

    const enableResponse = await request(app)
      .post(`/api/teams/${seeded.teamA._id}/enable`)
      .set('Authorization', `Bearer ${seeded.globalSuperToken}`)
      .send({ reason: 'Lifecycle test restore' })
      .expect(200);
    assert.equal(enableResponse.body.team.status, TEAM_STATUSES.ACTIVE);

    const restoredContextResponse = await request(app)
      .get('/api/teams')
      .set('Authorization', `Bearer ${seeded.teamSuperToken}`)
      .expect(200);
    assert.deepEqual(restoredContextResponse.body.teams.map((team) => team.code), ['TEAM_A']);
  });

  await t.test('successful sensitive writes have append-only audit evidence in the same database', async () => {
    const teamAudit = await AuditLog.findOne({
      action: AUDIT_ACTIONS.CREATE,
      resourceType: AUDIT_RESOURCE_TYPES.PROJECT_TEAM,
      resourceId: createdTeam._id
    }).lean();
    assert.ok(teamAudit);
    assert.equal(teamAudit.actorMode, AUDIT_ACTOR_MODES.GLOBAL_READ_ONLY);
    assert.equal(teamAudit.targetTeamId.toString(), createdTeam._id);

    const permissionAudit = await AuditLog.findOne({
      action: AUDIT_ACTIONS.PERMISSION_UPDATE,
      resourceType: AUDIT_RESOURCE_TYPES.TEAM_MEMBERSHIP,
      resourceId: seeded.memberMembershipA._id.toString(),
      targetTeamId: seeded.teamA._id
    }).lean();
    assert.ok(permissionAudit);
    assert.ok(permissionAudit.after.permissionKeys.includes('member.view'));

    const roleAudit = await AuditLog.findOne({
      action: AUDIT_ACTIONS.ROLE_UPDATE,
      resourceType: AUDIT_RESOURCE_TYPES.TEAM_MEMBERSHIP,
      resourceId: seeded.memberMembershipA._id.toString(),
      targetTeamId: seeded.teamA._id
    }).lean();
    assert.ok(roleAudit);
    assert.equal(roleAudit.after.role, MEMBERSHIP_ROLES.PROJECT_ADMIN);

    assert.equal(await AuditLog.countDocuments({
      resourceType: AUDIT_RESOURCE_TYPES.PROJECT_TEAM,
      resourceId: seeded.teamA._id.toString(),
      action: { $in: [AUDIT_ACTIONS.DISABLE, AUDIT_ACTIONS.ENABLE] }
    }), 2);
  });

  await t.test('an audit persistence failure rolls back the sensitive business write', async () => {
    const failingService = createTeamManagementService({
      auditService: {
        async record() {
          throw new Error('simulated audit persistence failure');
        }
      }
    });

    await assert.rejects(
      failingService.createTeam({
        authContext: {
          authenticated: true,
          userId: seeded.superAdmin._id.toString(),
          isSuperAdmin: true,
          mode: SESSION_MODES.GLOBAL_READ_ONLY
        },
        input: { code: 'ROLLBACK_TEAM', name: 'Rollback Team' }
      }),
      /simulated audit persistence failure/
    );
    assert.equal(await ProjectTeam.countDocuments({ code: 'ROLLBACK_TEAM' }), 0);
  });
});
