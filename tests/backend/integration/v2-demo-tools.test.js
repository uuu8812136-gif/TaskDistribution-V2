'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { after, before, test } = require('node:test');
const appRequire = require('../helpers/appRequire');

const mongoose = appRequire('mongoose');
const { MongoMemoryReplSet } = appRequire('mongodb-memory-server');

const OrgUnit = require('../../../app/models/OrgUnit');
const ProjectTeam = require('../../../app/models/ProjectTeam');
const TeamMembership = require('../../../app/models/TeamMembership');
const User = require('../../../app/models/User');
const {
  DATA_SCOPES,
  DATA_SCOPE_MODULE_VALUES,
  MEMBERSHIP_ROLES,
  PERMISSION_KEYS,
  POSITION_KEYS
} = require('../../../app/config/permissions');
const {
  MEMBER_PERMISSIONS,
  PROJECT_ADMIN_PERMISSIONS,
  assertSeedDatabaseIsolation,
  assertStrongPassword,
  parseArgs: parseSeedArgs,
  seedV2Demo
} = require('../../../app/script/seedV2Demo');
const {
  DEFAULT_API_PORT,
  DEFAULT_DATABASE_NAME,
  DEFAULT_MONGO_PORT,
  LOOPBACK_HOST,
  TEST_DATA_ROOT,
  applyJwtEnvironment,
  resolveLocalE2EOptions
} = require('../../../app/script/startV2LocalE2E');

const DATABASE_NAME = `demo_tools_${randomUUID().replaceAll('-', '')}_v2_test`;
const FIRST_PASSWORD = `Aa1!${randomUUID().replaceAll('-', '')}`;
const SECOND_PASSWORD = `Bb2@${randomUUID().replaceAll('-', '')}`;
const USERNAME_PREFIX = `qa_${randomUUID().slice(0, 8)}_`;
const MODELS = [OrgUnit, ProjectTeam, TeamMembership, User];

let replSet;

before(async () => {
  assertSeedDatabaseIsolation(DATABASE_NAME);
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    instanceOpts: [{ dbName: DATABASE_NAME }]
  });
  await mongoose.connect(replSet.getUri(DATABASE_NAME), { dbName: DATABASE_NAME });
  assert.equal(mongoose.connection.name, DATABASE_NAME);
  for (const model of MODELS) await model.syncIndexes();
});

after(async () => {
  if (mongoose.connection.readyState !== 0) {
    assert.equal(mongoose.connection.name, DATABASE_NAME);
    await mongoose.disconnect();
  }
  if (replSet) await replSet.stop();
});

test('demo seed and local E2E guards reject unsafe defaults before runtime startup', () => {
  assert.equal(assertSeedDatabaseIsolation('sample_v2_dev'), 'sample_v2_dev');
  assert.equal(assertSeedDatabaseIsolation('sample_v2_test'), 'sample_v2_test');
  assert.throws(() => assertSeedDatabaseIsolation('sample_v2_staging'), /_v2_dev or _v2_test/);
  assert.throws(() => assertSeedDatabaseIsolation('task_distribution'), /_v2_dev or _v2_test/);
  assert.throws(() => assertSeedDatabaseIsolation('sample_v2_test_extra'), /_v2_dev or _v2_test/);
  assert.throws(() => assertStrongPassword(undefined), /14-128 characters/);
  assert.throws(() => assertStrongPassword('only-lowercase-password'), /14-128 characters/);
  assert.deepEqual(parseSeedArgs([]), {});
  assert.throws(() => parseSeedArgs(['unlabelled-secret']), /Unexpected positional argument/);

  const options = resolveLocalE2EOptions({ env: { V2_DEMO_PASSWORD: FIRST_PASSWORD } });
  assert.equal(options.host, LOOPBACK_HOST);
  assert.equal(options.port, DEFAULT_API_PORT);
  assert.equal(options.mongoPort, DEFAULT_MONGO_PORT);
  assert.equal(options.databaseName, DEFAULT_DATABASE_NAME);
  assert.ok(options.dataDir.startsWith(`${TEST_DATA_ROOT}${path.sep}`));
  assert.ok(options.uploadDir.startsWith(`${TEST_DATA_ROOT}${path.sep}`));

  const unsafeCases = [
    [['--host', '0.0.0.0'], /bind exactly/],
    [['--host', 'www.horselink.cn'], /Production hosts/],
    [['--host', '82.156.67.62'], /Production hosts/],
    [['--port', '8099'], /reserved/],
    [['--database', 'local_e2e_v2_dev'], /must end with _v2_test/],
    [['--database', 'task_distribution'], /_v2_dev or _v2_test/],
    [['--mongo-port', '27017'], /not used/],
    [['--upload-dir', path.resolve(TEST_DATA_ROOT, '..', 'uploads')], /child directory/],
    [['--data-dir', path.resolve(TEST_DATA_ROOT, '..', 'mongodb')], /child directory/]
  ];
  for (const [argv, expected] of unsafeCases) {
    assert.throws(
      () => resolveLocalE2EOptions({ argv, env: { V2_DEMO_PASSWORD: FIRST_PASSWORD } }),
      expected
    );
  }

  const previousSecret = process.env.JWT_SECRET;
  const restore = applyJwtEnvironment({
    jwtSecret: 'x'.repeat(48),
    jwtExpire: '1h',
    jwtIssuer: 'isolated-test',
    jwtAudience: 'isolated-clients'
  });
  assert.equal(process.env.JWT_SECRET, 'x'.repeat(48));
  restore();
  assert.equal(process.env.JWT_SECRET, previousSecret);
});

test('demo seed is idempotent and creates two teams with three fixed account classes', async () => {
  const first = await seedV2Demo({
    password: FIRST_PASSWORD,
    usernamePrefix: USERNAME_PREFIX
  });
  const serialized = JSON.stringify(first);
  assert.equal(serialized.includes(FIRST_PASSWORD), false);
  assert.equal(serialized.includes('password'), false);
  assert.equal(first.teamIds.length, 2);
  assert.equal(first.orgUnitIds.length, 6);
  assert.equal(first.membershipIds.length, 2);

  const [superAdmin, projectAdmin, member] = await Promise.all([
    User.findById(first.users.superAdmin.id),
    User.findById(first.users.projectAdmin.id),
    User.findById(first.users.member.id)
  ]);
  assert.equal(superAdmin.isSuperAdmin, true);
  assert.deepEqual(superAdmin.roles, ['admin']);
  assert.equal(projectAdmin.isSuperAdmin, false);
  assert.deepEqual(projectAdmin.roles, ['admin']);
  assert.equal(member.isSuperAdmin, false);
  assert.deepEqual(member.roles, ['executor']);

  const teams = await ProjectTeam.find({}).sort({ code: 1 }).lean();
  assert.equal(teams.length, 2);
  assert.deepEqual(teams.map(({ name }) => name).sort(), ['发动机物流部', '变速箱物流部'].sort());
  const teamA = teams.find(({ name }) => name === '变速箱物流部');
  const teamB = teams.find(({ name }) => name === '发动机物流部');
  assert.ok(teamA);
  assert.ok(teamB);

  const [teamAOrgUnits, teamBOrgUnits] = await Promise.all([
    OrgUnit.find({ teamId: teamA._id }).sort({ level: 1 }).lean(),
    OrgUnit.find({ teamId: teamB._id }).sort({ level: 1 }).lean()
  ]);
  assert.deepEqual(teamAOrgUnits.map(({ level }) => level), [1, 2, 3, 4, 5]);
  assert.equal(teamAOrgUnits[0].path, '/');
  assert.equal(teamBOrgUnits.length, 1);
  for (let index = 1; index < teamAOrgUnits.length; index += 1) {
    assert.equal(String(teamAOrgUnits[index].parentId), String(teamAOrgUnits[index - 1]._id));
  }

  const memberships = await TeamMembership.find({ teamId: teamA._id });
  assert.equal(memberships.length, 2);
  assert.equal(await TeamMembership.countDocuments({ userId: superAdmin._id }), 0);
  const projectAdminMembership = memberships.find(
    ({ userId }) => String(userId) === String(projectAdmin._id)
  );
  const memberMembership = memberships.find(({ userId }) => String(userId) === String(member._id));
  assert.equal(projectAdminMembership.role, MEMBERSHIP_ROLES.PROJECT_ADMIN);
  assert.equal(projectAdminMembership.positionKey, POSITION_KEYS.DEPARTMENT_MANAGER);
  assert.deepEqual(projectAdminMembership.permissionKeys, PROJECT_ADMIN_PERMISSIONS);
  assert.deepEqual(PROJECT_ADMIN_PERMISSIONS, [...PERMISSION_KEYS]);
  assert.equal(projectAdminMembership.moduleDataScopes.length, DATA_SCOPE_MODULE_VALUES.length);
  assert.ok(projectAdminMembership.moduleDataScopes.every(({ scope }) => scope === DATA_SCOPES.TEAM));
  assert.equal(memberMembership.role, MEMBERSHIP_ROLES.MEMBER);
  assert.equal(memberMembership.positionKey, POSITION_KEYS.EMPLOYEE);
  assert.deepEqual(memberMembership.permissionKeys, MEMBER_PERMISSIONS);
  assert.equal(memberMembership.moduleDataScopes.length, DATA_SCOPE_MODULE_VALUES.length);
  assert.ok(memberMembership.moduleDataScopes.every(({ scope }) => scope === DATA_SCOPES.ORG_UNIT));
  const membershipUpdatedAt = new Map(
    memberships.map(({ _id, updatedAt }) => [String(_id), updatedAt.getTime()])
  );

  const second = await seedV2Demo({
    password: SECOND_PASSWORD,
    usernamePrefix: USERNAME_PREFIX
  });
  assert.deepEqual(second, first);
  assert.equal(await User.countDocuments({}), 3);
  assert.equal(await ProjectTeam.countDocuments({}), 2);
  assert.equal(await OrgUnit.countDocuments({}), 6);
  assert.equal(await TeamMembership.countDocuments({}), 2);
  const membershipsAfterRerun = await TeamMembership.find({ teamId: teamA._id });
  assert.ok(membershipsAfterRerun.every(
    ({ _id, updatedAt }) => membershipUpdatedAt.get(String(_id)) === updatedAt.getTime()
  ));

  const unchangedSuperAdmin = await User.findById(superAdmin._id);
  assert.equal(await unchangedSuperAdmin.comparePassword(FIRST_PASSWORD), true);
  assert.equal(await unchangedSuperAdmin.comparePassword(SECOND_PASSWORD), false);
});
