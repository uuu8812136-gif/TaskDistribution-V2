'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { after, before, beforeEach, test } = require('node:test');
const appRequire = require('../helpers/appRequire');

const mongoose = appRequire('mongoose');
const { MongoMemoryServer } = appRequire('mongodb-memory-server');

const permissions = require('../../../app/config/permissions');
const ProjectTeam = require('../../../app/models/ProjectTeam');
const OrgUnit = require('../../../app/models/OrgUnit');
const TeamMembership = require('../../../app/models/TeamMembership');
const AuthSession = require('../../../app/models/AuthSession');
const AuditLog = require('../../../app/models/AuditLog');

const TEST_DATABASE_NAME = `foundation_${randomUUID().replaceAll('-', '')}_v2_test`;
const MODELS = [ProjectTeam, OrgUnit, TeamMembership, AuthSession, AuditLog];

let mongoServer;

function objectId() {
  return new mongoose.Types.ObjectId();
}

function scopeMap(scopes) {
  return new Map(scopes.map(({ moduleKey, scope }) => [moduleKey, scope]));
}

function isDuplicateKeyError(error) {
  assert.equal(error?.code, 11000);
  return true;
}

async function clearModelCollections() {
  // Native collection cleanup is intentionally confined to the disposable test DB.
  await Promise.all(MODELS.map((model) => model.collection.deleteMany({})));
}

before(async () => {
  assert.match(TEST_DATABASE_NAME, /_v2_test$/);

  mongoServer = await MongoMemoryServer.create({
    instance: { dbName: TEST_DATABASE_NAME }
  });
  const uri = mongoServer.getUri(TEST_DATABASE_NAME);

  await mongoose.connect(uri, { dbName: TEST_DATABASE_NAME });
  assert.equal(mongoose.connection.name, TEST_DATABASE_NAME);

  for (const model of MODELS) {
    await model.syncIndexes();
  }
});

beforeEach(async () => {
  assert.equal(mongoose.connection.name, TEST_DATABASE_NAME);
  await clearModelCollections();
});

after(async () => {
  if (mongoose.connection.readyState !== 0) {
    assert.equal(mongoose.connection.name, TEST_DATABASE_NAME);
    await mongoose.disconnect();
  }
  if (mongoServer) {
    await mongoServer.stop();
  }
});

test('fixed permissions and module-specific data scopes match the design', () => {
  const expectedPermissionKeys = [
    'task.view',
    'task.create',
    'task.edit',
    'task.assign',
    'task.review',
    'task.export',
    'equipment.view',
    'equipment.create',
    'equipment.edit',
    'equipment.import',
    'equipment.export',
    'equipment.qrcode',
    'equipment.inventory',
    'equipment.inspect',
    'equipment.repair',
    'equipment.maintain',
    'equipment.status.apply',
    'equipment.status.approve',
    'report.view',
    'report.submit',
    'report.review',
    'report.correct',
    'report.export',
    'report.schedule.manage',
    'report.daily.generate',
    'report.monthly.generate',
    'member.view',
    'member.manage',
    'org.manage',
    'reporter.assign',
    'audit.view'
  ];

  assert.deepEqual(permissions.PERMISSION_KEYS, expectedPermissionKeys);
  assert.equal(new Set(permissions.PERMISSION_KEYS).size, expectedPermissionKeys.length);

  const employeeScopes = scopeMap(
    permissions.deriveModuleDataScopes({ positionLevel: 5 })
  );
  assert.deepEqual(
    [...employeeScopes.values()],
    ['ORG_UNIT', 'ORG_UNIT', 'ORG_UNIT', 'ORG_UNIT', 'ORG_UNIT']
  );

  const departmentManagerScopes = scopeMap(
    permissions.deriveModuleDataScopes({ positionLevel: 1 })
  );
  assert.ok([...departmentManagerScopes.values()].every((scope) => scope === 'TEAM'));

  const attendanceOfficerScopes = scopeMap(
    permissions.deriveModuleDataScopes({
      positionLevel: 5,
      functionalRoleKeys: [permissions.FUNCTIONAL_ROLE_KEYS.ATTENDANCE_OFFICER]
    })
  );
  assert.equal(attendanceOfficerScopes.get('report.attendance'), 'TEAM');
  assert.equal(attendanceOfficerScopes.get('report.transport'), 'ORG_UNIT');
  assert.equal(attendanceOfficerScopes.get('report.production'), 'ORG_UNIT');
  assert.equal(attendanceOfficerScopes.get('task'), 'ORG_UNIT');
  assert.equal(attendanceOfficerScopes.get('equipment'), 'ORG_UNIT');

  const assetAdminScopes = scopeMap(
    permissions.deriveModuleDataScopes({
      positionLevel: 5,
      functionalRoleKeys: [permissions.FUNCTIONAL_ROLE_KEYS.ASSET_ADMIN]
    })
  );
  assert.equal(assetAdminScopes.get('equipment'), 'TEAM');
  assert.equal(assetAdminScopes.get('report.attendance'), 'ORG_UNIT');
  assert.equal(assetAdminScopes.get('task'), 'ORG_UNIT');
});

test('foundation model validation rejects invalid hierarchy, scope, and session state', async () => {
  const teamId = objectId();
  const userId = objectId();
  const orgUnitId = objectId();

  const root = new OrgUnit({
    teamId,
    type: permissions.ORG_UNIT_TYPES.DEPARTMENT,
    code: 'ROOT',
    name: 'Root',
    level: 1,
    path: '/'
  });
  await root.validate();

  await assert.rejects(
    new OrgUnit({
      teamId,
      parentId: root._id,
      type: permissions.ORG_UNIT_TYPES.SUB_DEPARTMENT,
      code: 'CHILD',
      name: 'Child',
      level: 2,
      path: '/'
    }).validate(),
    /ancestor path/
  );

  const membership = new TeamMembership({ teamId, userId, orgUnitId });
  await membership.validate();
  assert.equal(membership.moduleDataScopes.length, 5);

  await assert.rejects(
    new TeamMembership({
      teamId,
      userId: objectId(),
      orgUnitId,
      positionKey: permissions.POSITION_KEYS.DEPARTMENT_MANAGER,
      positionLevel: 5
    }).validate(),
    /positionLevel must be 1/
  );

  await assert.rejects(
    new TeamMembership({
      teamId,
      userId: objectId(),
      orgUnitId,
      permissionKeys: ['task.unknown']
    }).validate(),
    /not a valid enum value/
  );

  await assert.rejects(
    new TeamMembership({
      teamId,
      userId: objectId(),
      orgUnitId,
      moduleDataScopes: [{ moduleKey: 'task', scope: 'TEAM' }]
    }).validate(),
    /must be derived/
  );

  await new AuthSession({
    jtiHash: 'a'.repeat(64),
    userId,
    mode: permissions.SESSION_MODES.TEAM_SELECTION,
    tokenVersion: 0,
    expiresAt: new Date(Date.now() + 60_000)
  }).validate();

  await assert.rejects(
    new AuthSession({
      jtiHash: 'b'.repeat(64),
      userId,
      mode: permissions.SESSION_MODES.TEAM,
      tokenVersion: 0,
      expiresAt: new Date(Date.now() + 60_000)
    }).validate(),
    /requires activeTeamId/
  );

  assert.throws(
    () => new ProjectTeam({ unknownField: true }),
    /strict mode/
  );
});

test('ProjectTeam code is globally unique after syncIndexes', async () => {
  await ProjectTeam.create({
    code: 'TEAM_ALPHA',
    name: 'Team Alpha',
    createdBy: objectId()
  });

  await assert.rejects(
    ProjectTeam.create({
      code: ' team_alpha ',
      name: 'Duplicate Alpha',
      createdBy: objectId()
    }),
    isDuplicateKeyError
  );
});

test('OrgUnit code is unique within a team and reusable in another team', async () => {
  const firstTeamId = objectId();
  const secondTeamId = objectId();

  const unit = {
    type: permissions.ORG_UNIT_TYPES.SUB_DEPARTMENT,
    code: 'SUB_01',
    name: 'Sub Department 01',
    level: 2,
    path: '/'
  };

  await OrgUnit.create({ ...unit, teamId: firstTeamId });
  await OrgUnit.create({ ...unit, teamId: secondTeamId });

  await assert.rejects(
    OrgUnit.create({ ...unit, teamId: firstTeamId, name: 'Duplicate Sub Department' }),
    isDuplicateKeyError
  );
});

test('TeamMembership has one membership per team and user', async () => {
  const teamId = objectId();
  const userId = objectId();
  const orgUnitId = objectId();

  await TeamMembership.create({ teamId, userId, orgUnitId });
  await TeamMembership.create({ teamId, userId: objectId(), orgUnitId });
  await TeamMembership.create({ teamId: objectId(), userId, orgUnitId });

  await assert.rejects(
    TeamMembership.create({ teamId, userId, orgUnitId }),
    isDuplicateKeyError
  );
});

test('TeamMembership permits only one active attendance reporter per division', async () => {
  const teamId = objectId();
  const divisionId = objectId();
  const role = permissions.FUNCTIONAL_ROLE_KEYS.ATTENDANCE_REPORTER;

  await TeamMembership.create({
    teamId,
    userId: objectId(),
    orgUnitId: divisionId,
    functionalRoleKeys: [role]
  });
  await TeamMembership.create({
    teamId,
    userId: objectId(),
    orgUnitId: divisionId,
    status: permissions.MEMBERSHIP_STATUSES.DISABLED,
    functionalRoleKeys: [role]
  });
  await TeamMembership.create({
    teamId,
    userId: objectId(),
    orgUnitId: divisionId,
    functionalRoleKeys: [permissions.FUNCTIONAL_ROLE_KEYS.ASSET_ADMIN]
  });

  await assert.rejects(
    TeamMembership.create({
      teamId,
      userId: objectId(),
      orgUnitId: divisionId,
      functionalRoleKeys: [role]
    }),
    isDuplicateKeyError
  );
});

test('AuthSession stores globally unique jti hashes', async () => {
  const session = {
    jtiHash: 'c'.repeat(64),
    mode: permissions.SESSION_MODES.TEAM,
    activeTeamId: objectId(),
    tokenVersion: 0,
    expiresAt: new Date(Date.now() + 60_000)
  };

  await AuthSession.create({ ...session, userId: objectId() });

  await assert.rejects(
    AuthSession.create({ ...session, userId: objectId() }),
    isDuplicateKeyError
  );
});

test('AuditLog permits append but rejects updates and deletes', async () => {
  const auditLog = await AuditLog.create({
    actorRole: permissions.AUDIT_ACTOR_ROLES.SYSTEM,
    actorMode: permissions.AUDIT_ACTOR_MODES.SYSTEM,
    action: permissions.AUDIT_ACTIONS.CREATE,
    resourceType: permissions.AUDIT_RESOURCE_TYPES.PROJECT_TEAM,
    resourceId: objectId().toString(),
    reason: 'foundation test',
    requestId: randomUUID(),
    requestMethod: 'POST',
    requestPath: '/api/teams',
    ip: '127.0.0.1',
    userAgent: 'node:test'
  });

  await assert.rejects(
    AuditLog.updateOne(
      { _id: auditLog._id },
      { $set: { reason: 'mutated' } }
    ).exec(),
    /append-only/
  );
  await assert.rejects(
    AuditLog.deleteOne({ _id: auditLog._id }).exec(),
    /append-only/
  );
  await assert.rejects(
    AuditLog.bulkWrite([{
      updateOne: {
        filter: { _id: auditLog._id },
        update: { $set: { reason: 'mutated by bulkWrite' } }
      }
    }]),
    /append-only/
  );

  const persisted = await AuditLog.findById(auditLog._id).lean();
  assert.equal(persisted.reason, 'foundation test');
  assert.equal(await AuditLog.countDocuments({ _id: auditLog._id }), 1);
});
