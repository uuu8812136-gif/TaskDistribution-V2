#!/usr/bin/env node
'use strict';

const mongoose = require('mongoose');
const { databaseNameFromUri } = require('../config/environment');
const {
  DATA_SCOPES,
  MEMBERSHIP_ROLES,
  MEMBERSHIP_STATUSES,
  ORG_UNIT_TYPES,
  PERMISSION_KEYS,
  POSITION_LEVEL_BY_KEY,
  POSITION_KEYS,
  TEAM_STATUSES,
  deriveModuleDataScopes
} = require('../config/permissions');
const OrgUnit = require('../models/OrgUnit');
const ProjectTeam = require('../models/ProjectTeam');
const TeamMembership = require('../models/TeamMembership');
const User = require('../models/User');

const SAFE_DATABASE_PATTERN = /^[a-z0-9][a-z0-9_-]*_v2_(?:dev|test)$/i;
const DEFAULT_USERNAME_PREFIX = 'v2demo_';
const PROJECT_ADMIN_PERMISSIONS = Object.freeze([...PERMISSION_KEYS]);
const MEMBER_PERMISSIONS = Object.freeze([
  'task.view',
  'task.create',
  'equipment.view',
  'report.view',
  'report.submit'
]);

const VALUE_OPTIONS = new Set(['password', 'username-prefix']);
const FLAG_OPTIONS = new Set(['help']);

function usage() {
  return [
    'Seed the isolated V2 development/test database with demo identities.',
    '',
    'Required environment:',
    '  MONGODB_URI=<URI whose database ends in _v2_dev or _v2_test>',
    '  V2_DEMO_PASSWORD=<strong password used only for newly created users>',
    '',
    'Run:',
    '  node script/seedV2Demo.js [--username-prefix <prefix>]',
    '',
    'The password may instead be supplied with --password, but environment input avoids shell history.',
    'Rerunning does not reset passwords. Output contains IDs and usernames only.'
  ].join('\n');
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error('Unexpected positional argument');
    const [name, inlineValue] = token.slice(2).split(/=(.*)/s, 2);
    if (FLAG_OPTIONS.has(name)) {
      if (inlineValue !== undefined) throw new Error(`--${name} does not accept a value`);
      result[name] = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) throw new Error(`Unknown option: --${name}`);
    const value = inlineValue === undefined ? argv[++index] : inlineValue;
    if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
    const camelName = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    result[camelName] = value;
  }
  return result;
}

function assertSeedDatabaseIsolation(databaseName) {
  if (typeof databaseName !== 'string' || !SAFE_DATABASE_PATTERN.test(databaseName)) {
    throw new Error('Demo seed database name must end with _v2_dev or _v2_test');
  }
  return databaseName;
}

function assertStrongPassword(password) {
  const strong = (
    typeof password === 'string' &&
    password.length >= 14 &&
    password.length <= 128 &&
    !/\s/.test(password) &&
    /[a-z]/.test(password) &&
    /[A-Z]/.test(password) &&
    /[0-9]/.test(password) &&
    /[^A-Za-z0-9]/.test(password)
  );
  if (!strong) {
    throw new Error(
      'V2 demo password must be 14-128 characters and include upper-case, lower-case, number, and symbol characters without whitespace'
    );
  }
  return password;
}

function normalizeUsernamePrefix(prefix = DEFAULT_USERNAME_PREFIX) {
  if (typeof prefix !== 'string' || !/^[A-Za-z0-9_-]{0,30}$/.test(prefix)) {
    throw new Error('Username prefix must contain at most 30 ASCII letters, numbers, underscores, or hyphens');
  }
  return prefix;
}

function objectIdEquals(left, right) {
  if (left === null || left === undefined || right === null || right === undefined) {
    return left === right;
  }
  return String(left) === String(right);
}

function assertExistingRecord(condition, resource) {
  if (!condition) {
    throw new Error(`Existing ${resource} conflicts with the deterministic V2 demo seed`);
  }
}

async function ensureUser({ username, password, name, isSuperAdmin, roles }) {
  const usernameNormalized = User.normalizeUsername(username);
  let user = await User.findOne({ usernameNormalized });
  if (!user) {
    user = await User.create({
      username,
      password,
      name,
      isSuperAdmin,
      roles,
      status: 'active'
    });
    return user;
  }

  assertExistingRecord(user.name === name, `user ${username}`);
  assertExistingRecord(user.isSuperAdmin === isSuperAdmin, `user ${username}`);
  assertExistingRecord(user.status === 'active', `user ${username}`);
  return user;
}

async function ensureTeam({ code, name, createdBy }) {
  let team = await ProjectTeam.findOne({ code });
  if (!team) {
    team = await ProjectTeam.create({ code, name, createdBy });
    return team;
  }

  assertExistingRecord(team.name === name, `team ${code}`);
  assertExistingRecord(team.status === TEAM_STATUSES.ACTIVE, `team ${code}`);
  return team;
}

async function ensureOrgUnit({ teamId, parentId, type, code, name, level, path, sortOrder }) {
  let orgUnit = await OrgUnit.findOne({ teamId, code });
  if (!orgUnit) {
    orgUnit = await OrgUnit.create({
      teamId,
      parentId,
      type,
      code,
      name,
      level,
      path,
      sortOrder
    });
    return orgUnit;
  }

  assertExistingRecord(orgUnit.name === name, `organization unit ${code}`);
  assertExistingRecord(orgUnit.type === type, `organization unit ${code}`);
  assertExistingRecord(orgUnit.level === level, `organization unit ${code}`);
  assertExistingRecord(orgUnit.path === path, `organization unit ${code}`);
  assertExistingRecord(objectIdEquals(orgUnit.parentId, parentId), `organization unit ${code}`);
  return orgUnit;
}

async function ensureMembership({
  teamId,
  userId,
  orgUnitId,
  role,
  positionKey,
  permissionKeys
}) {
  const positionLevel = POSITION_LEVEL_BY_KEY[positionKey];
  const desiredScopes = deriveModuleDataScopes({
    positionLevel,
    functionalRoleKeys: []
  });
  let membership = await TeamMembership.findOne({ teamId, userId });
  if (!membership) {
    membership = new TeamMembership({
      teamId,
      userId,
      orgUnitId,
      role,
      positionKey,
      positionLevel,
      functionalRoleKeys: [],
      permissionKeys,
      moduleDataScopes: desiredScopes,
      status: MEMBERSHIP_STATUSES.ACTIVE
    });
  } else {
    const permissionKeysMatch = (
      membership.permissionKeys.length === permissionKeys.length &&
      membership.permissionKeys.every((permissionKey, index) => permissionKey === permissionKeys[index])
    );
    const scopesMatch = (
      membership.moduleDataScopes?.length === desiredScopes.length &&
      membership.moduleDataScopes.every(({ moduleKey, scope }, index) => (
        moduleKey === desiredScopes[index].moduleKey && scope === desiredScopes[index].scope
      ))
    );
    const alreadyMatches = (
      objectIdEquals(membership.orgUnitId, orgUnitId) &&
      membership.role === role &&
      membership.positionKey === positionKey &&
      membership.positionLevel === positionLevel &&
      membership.functionalRoleKeys.length === 0 &&
      permissionKeysMatch &&
      scopesMatch &&
      membership.status === MEMBERSHIP_STATUSES.ACTIVE
    );
    if (alreadyMatches) return membership;

    membership.orgUnitId = orgUnitId;
    membership.role = role;
    membership.positionKey = positionKey;
    membership.positionLevel = positionLevel;
    membership.functionalRoleKeys = [];
    membership.permissionKeys = [...permissionKeys];
    membership.moduleDataScopes = desiredScopes;
    membership.status = MEMBERSHIP_STATUSES.ACTIVE;
  }
  await membership.save();
  return membership;
}

async function seedV2Demo({
  password,
  usernamePrefix = DEFAULT_USERNAME_PREFIX,
  connection = mongoose.connection
} = {}) {
  assertStrongPassword(password);
  const prefix = normalizeUsernamePrefix(usernamePrefix);
  if (!connection || connection.readyState !== 1) {
    throw new Error('An active isolated MongoDB connection is required');
  }
  assertSeedDatabaseIsolation(connection.name);

  await Promise.all([User.init(), ProjectTeam.init(), OrgUnit.init(), TeamMembership.init()]);

  const usernames = {
    superAdmin: `${prefix}superadmin`,
    projectAdmin: `${prefix}projectadmin`,
    member: `${prefix}member`
  };
  if (Object.values(usernames).some((username) => username.length > 50)) {
    throw new Error('Username prefix produces a username longer than 50 characters');
  }

  const superAdmin = await ensureUser({
    username: usernames.superAdmin,
    password,
    name: 'V2演示超级管理员',
    isSuperAdmin: true,
    roles: ['admin']
  });
  const projectAdmin = await ensureUser({
    username: usernames.projectAdmin,
    password,
    name: 'V2演示项目管理员',
    isSuperAdmin: false,
    roles: ['admin']
  });
  const member = await ensureUser({
    username: usernames.member,
    password,
    name: 'V2演示普通成员',
    isSuperAdmin: false,
    roles: ['executor']
  });

  const teamA = await ensureTeam({
    code: 'GEARBOX_LOGISTICS',
    name: '变速箱物流部',
    createdBy: superAdmin._id
  });
  const teamB = await ensureTeam({
    code: 'ENGINE_LOGISTICS',
    name: '发动机物流部',
    createdBy: superAdmin._id
  });

  const teamARoot = await ensureOrgUnit({
    teamId: teamA._id,
    parentId: null,
    type: ORG_UNIT_TYPES.DEPARTMENT,
    code: 'DEPARTMENT',
    name: '变速箱物流部',
    level: 1,
    path: '/',
    sortOrder: 10
  });
  const orgDefinitions = [
    { type: ORG_UNIT_TYPES.SUB_DEPARTMENT, code: 'OPERATIONS', name: '物流运营分部' },
    { type: ORG_UNIT_TYPES.SUB_DEPARTMENT, code: 'WAREHOUSE', name: '仓储作业室' },
    { type: ORG_UNIT_TYPES.TEAM_GROUP, code: 'SHIFT_A', name: '物流一班' },
    { type: ORG_UNIT_TYPES.TEAM_GROUP, code: 'WORK_CELL_A', name: '作业单元A' }
  ];
  const teamAOrgUnits = [teamARoot];
  let parent = teamARoot;
  for (let index = 0; index < orgDefinitions.length; index += 1) {
    const definition = orgDefinitions[index];
    const orgUnit = await ensureOrgUnit({
      teamId: teamA._id,
      parentId: parent._id,
      ...definition,
      level: index + 2,
      path: `${parent.path}${parent._id}/`,
      sortOrder: (index + 2) * 10
    });
    teamAOrgUnits.push(orgUnit);
    parent = orgUnit;
  }

  const teamBRoot = await ensureOrgUnit({
    teamId: teamB._id,
    parentId: null,
    type: ORG_UNIT_TYPES.DEPARTMENT,
    code: 'DEPARTMENT',
    name: '发动机物流部',
    level: 1,
    path: '/',
    sortOrder: 10
  });

  const projectAdminMembership = await ensureMembership({
    teamId: teamA._id,
    userId: projectAdmin._id,
    orgUnitId: teamARoot._id,
    role: MEMBERSHIP_ROLES.PROJECT_ADMIN,
    positionKey: POSITION_KEYS.DEPARTMENT_MANAGER,
    permissionKeys: PROJECT_ADMIN_PERMISSIONS
  });
  const memberMembership = await ensureMembership({
    teamId: teamA._id,
    userId: member._id,
    orgUnitId: teamAOrgUnits.at(-1)._id,
    role: MEMBERSHIP_ROLES.MEMBER,
    positionKey: POSITION_KEYS.EMPLOYEE,
    permissionKeys: MEMBER_PERMISSIONS
  });

  const adminScopes = new Map(
    projectAdminMembership.moduleDataScopes.map(({ moduleKey, scope }) => [moduleKey, scope])
  );
  const memberScopes = new Map(
    memberMembership.moduleDataScopes.map(({ moduleKey, scope }) => [moduleKey, scope])
  );
  assertExistingRecord(
    [...adminScopes.values()].every((scope) => scope === DATA_SCOPES.TEAM),
    'project administrator data scopes'
  );
  assertExistingRecord(
    [...memberScopes.values()].every((scope) => scope === DATA_SCOPES.ORG_UNIT),
    'ordinary member data scopes'
  );

  return Object.freeze({
    users: Object.freeze({
      superAdmin: Object.freeze({ id: String(superAdmin._id), username: superAdmin.username }),
      projectAdmin: Object.freeze({ id: String(projectAdmin._id), username: projectAdmin.username }),
      member: Object.freeze({ id: String(member._id), username: member.username })
    }),
    teamIds: Object.freeze([String(teamA._id), String(teamB._id)]),
    orgUnitIds: Object.freeze([
      ...teamAOrgUnits.map(({ _id }) => String(_id)),
      String(teamBRoot._id)
    ]),
    membershipIds: Object.freeze([
      String(projectAdminMembership._id),
      String(memberMembership._id)
    ])
  });
}

async function main({ argv = process.argv.slice(2), env = process.env } = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (!env.MONGODB_URI) throw new Error('MONGODB_URI is required');
  const databaseName = assertSeedDatabaseIsolation(databaseNameFromUri(env.MONGODB_URI));
  const password = args.password || env.V2_DEMO_PASSWORD;
  assertStrongPassword(password);

  await mongoose.connect(env.MONGODB_URI, {
    dbName: databaseName,
    autoIndex: true,
    serverSelectionTimeoutMS: 10_000
  });
  try {
    const summary = await seedV2Demo({
      password,
      usernamePrefix: args.usernamePrefix || env.V2_DEMO_USERNAME_PREFIX
    });
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      status: 'FAILED',
      code: 'V2_DEMO_SEED_FAILED',
      message: error.message
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_USERNAME_PREFIX,
  MEMBER_PERMISSIONS,
  PROJECT_ADMIN_PERMISSIONS,
  assertSeedDatabaseIsolation,
  assertStrongPassword,
  main,
  normalizeUsernamePrefix,
  parseArgs,
  seedV2Demo,
  usage
};
