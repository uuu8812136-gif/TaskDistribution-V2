#!/usr/bin/env node
'use strict';

const mongoose = require('mongoose');
const { databaseNameFromUri } = require('../config/environment');
const {
  AUDIT_ACTIONS,
  AUDIT_RESOURCE_TYPES,
  DATA_SCOPES,
  DATA_SCOPE_MODULE_VALUES,
  MEMBERSHIP_ROLES,
  MEMBERSHIP_STATUSES,
  ORG_UNIT_STATUSES,
  ORG_UNIT_TYPES,
  PERMISSION_KEYS,
  POSITION_KEYS,
  POSITION_LEVEL_BY_KEY,
  TEAM_STATUSES
} = require('../config/permissions');
const { SYSTEM_ACCOUNT_DISPLAY_NAME } = require('../config/systemAccount');
const OrgUnit = require('../models/OrgUnit');
const ProjectTeam = require('../models/ProjectTeam');
const TeamMembership = require('../models/TeamMembership');
const User = require('../models/User');
const { createAuditService } = require('../services/auditService');

const READ_ONLY_PERMISSION_KEYS = Object.freeze(
  PERMISSION_KEYS.filter((permissionKey) => permissionKey.endsWith('.view'))
);
const SAFE_DATABASE_PATTERN = /^[a-z0-9][a-z0-9_-]*_v2_(?:dev|test)$/i;
const PRODUCTION_CONFIRMATION = 'I_UNDERSTAND_READONLY_DEMO_PRODUCTION';

function requiredEnvironmentValue(env, name) {
  const value = env?.[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function validateUsername(value) {
  const username = value.normalize('NFKC').trim();
  if (username.length < 3 || username.length > 50) {
    throw new Error('READONLY_DEMO_USERNAME must contain 3-50 characters');
  }
  return username;
}

function validatePassword(value) {
  if (value.length < 10 || value.length > 128 || /\s/.test(value)) {
    throw new Error('READONLY_DEMO_PASSWORD must contain 10-128 non-whitespace characters');
  }
  return value;
}

function assertProvisioningTarget(databaseName, confirmation) {
  if (SAFE_DATABASE_PATTERN.test(databaseName)) return databaseName;
  if (confirmation !== PRODUCTION_CONFIRMATION) {
    throw new Error(
      `Refusing read-only demo provisioning outside an isolated V2 database; set READONLY_DEMO_PRODUCTION_CONFIRMATION=${PRODUCTION_CONFIRMATION} only after formal release approval`
    );
  }
  return databaseName;
}

function resolveProvisioningOptions(env = process.env) {
  const mongodbUri = requiredEnvironmentValue(env, 'MONGODB_URI').trim();
  return Object.freeze({
    mongodbUri,
    username: validateUsername(requiredEnvironmentValue(env, 'READONLY_DEMO_USERNAME')),
    password: validatePassword(requiredEnvironmentValue(env, 'READONLY_DEMO_PASSWORD')),
    productionConfirmation: env.READONLY_DEMO_PRODUCTION_CONFIRMATION || ''
  });
}

function teamScopes() {
  return DATA_SCOPE_MODULE_VALUES.map((moduleKey) => ({
    moduleKey,
    scope: DATA_SCOPES.TEAM
  }));
}

function sameArray(left, right) {
  return Array.isArray(left) && Array.isArray(right) &&
    left.length === right.length && left.every((value, index) => value === right[index]);
}

function membershipMatches(membership, teamId, orgUnitId) {
  return String(membership.teamId) === String(teamId) &&
    String(membership.orgUnitId) === String(orgUnitId) &&
    membership.role === MEMBERSHIP_ROLES.MEMBER &&
    membership.positionKey === POSITION_KEYS.DEPARTMENT_MANAGER_ASSISTANT &&
    membership.positionLevel === POSITION_LEVEL_BY_KEY[POSITION_KEYS.DEPARTMENT_MANAGER_ASSISTANT] &&
    membership.status === MEMBERSHIP_STATUSES.ACTIVE &&
    sameArray(membership.functionalRoleKeys, []) &&
    sameArray(membership.permissionKeys, READ_ONLY_PERMISSION_KEYS) &&
    sameArray(
      (membership.moduleDataScopes || []).map(({ moduleKey, scope }) => `${moduleKey}:${scope}`),
      teamScopes().map(({ moduleKey, scope }) => `${moduleKey}:${scope}`)
    );
}

async function ensureAccount({ username, password, UserModel = User }) {
  const normalizeUsername = UserModel.normalizeUsername || User.normalizeUsername;
  const usernameNormalized = normalizeUsername(username);
  let account = await UserModel.findOne({ usernameNormalized });
  let created = false;
  if (!account) {
    account = await UserModel.create({
      username,
      password,
      name: SYSTEM_ACCOUNT_DISPLAY_NAME,
      roles: ['executor'],
      isSuperAdmin: false,
      isSystemAccount: true,
      isReadOnlyDemo: true,
      tokenVersion: 0,
      status: 'active'
    });
    created = true;
  } else {
    if (account.isSystemAccount !== true) {
      throw new Error('A non-system account already uses the requested username');
    }
    if (account.isSuperAdmin === true || account.status !== 'active') {
      throw new Error('The existing system account is not a read-only demo account');
    }
    if (!await account.comparePassword(password)) {
      throw new Error('READONLY_DEMO_PASSWORD does not match the existing account');
    }
    if (
      account.name !== SYSTEM_ACCOUNT_DISPLAY_NAME ||
      !sameArray(account.roles, ['executor']) ||
      account.isReadOnlyDemo !== true
    ) {
      account.name = SYSTEM_ACCOUNT_DISPLAY_NAME;
      account.roles = ['executor'];
      account.isReadOnlyDemo = true;
      await account.save();
    }
  }
  return { account, created };
}

async function reconcileMemberships({
  account,
  TeamModel = ProjectTeam,
  OrgUnitModel = OrgUnit,
  MembershipModel = TeamMembership
}) {
  const teams = await TeamModel.find({ status: TEAM_STATUSES.ACTIVE }).sort({ _id: 1 });
  if (teams.length === 0) throw new Error('No active team exists for the read-only demo account');
  const activeTeamIds = new Set(teams.map((team) => String(team._id)));
  const memberships = [];
  for (const team of teams) {
    const orgUnit = await OrgUnitModel.findOne({
      teamId: team._id,
      type: ORG_UNIT_TYPES.DEPARTMENT,
      level: 1,
      status: ORG_UNIT_STATUSES.ACTIVE,
      parentId: null
    }).sort({ _id: 1 });
    if (!orgUnit) throw new Error(`No active root department exists for team ${team.code}`);
    let membership = await MembershipModel.findOne({ teamId: team._id, userId: account._id });
    if (!membership) {
      membership = new MembershipModel({
        teamId: team._id,
        userId: account._id,
        orgUnitId: orgUnit._id,
        role: MEMBERSHIP_ROLES.MEMBER,
        positionKey: POSITION_KEYS.DEPARTMENT_MANAGER_ASSISTANT,
        positionLevel: POSITION_LEVEL_BY_KEY[POSITION_KEYS.DEPARTMENT_MANAGER_ASSISTANT],
        functionalRoleKeys: [],
        permissionKeys: [...READ_ONLY_PERMISSION_KEYS],
        moduleDataScopes: teamScopes(),
        status: MEMBERSHIP_STATUSES.ACTIVE
      });
    } else if (!membershipMatches(membership, team._id, orgUnit._id)) {
      membership.orgUnitId = orgUnit._id;
      membership.role = MEMBERSHIP_ROLES.MEMBER;
      membership.positionKey = POSITION_KEYS.DEPARTMENT_MANAGER_ASSISTANT;
      membership.positionLevel = POSITION_LEVEL_BY_KEY[POSITION_KEYS.DEPARTMENT_MANAGER_ASSISTANT];
      membership.functionalRoleKeys = [];
      membership.permissionKeys = [...READ_ONLY_PERMISSION_KEYS];
      membership.moduleDataScopes = teamScopes();
      membership.status = MEMBERSHIP_STATUSES.ACTIVE;
    }
    await membership.save();
    memberships.push(membership);
  }

  const staleMemberships = await MembershipModel.find({ userId: account._id });
  for (const membership of staleMemberships) {
    if (!activeTeamIds.has(String(membership.teamId)) && membership.status !== MEMBERSHIP_STATUSES.DISABLED) {
      membership.status = MEMBERSHIP_STATUSES.DISABLED;
      await membership.save();
    }
  }
  return memberships;
}

async function provisionReadOnlyDemoAccount({
  username,
  password,
  UserModel = User,
  TeamModel = ProjectTeam,
  OrgUnitModel = OrgUnit,
  MembershipModel = TeamMembership,
  auditService = createAuditService()
}) {
  const { account, created } = await ensureAccount({ username, password, UserModel });
  if (created) {
    await auditService.recordSystem({
      action: AUDIT_ACTIONS.CREATE,
      resourceType: AUDIT_RESOURCE_TYPES.USER,
      resourceId: account._id,
      after: {
        accountType: 'READ_ONLY_DEMO',
        isSystemAccount: true,
        isSuperAdmin: false,
        status: 'active',
        roles: ['executor']
      },
      reason: 'Provisioned hidden read-only demo account'
    });
  }
  const memberships = await reconcileMemberships({
    account,
    TeamModel,
    OrgUnitModel,
    MembershipModel
  });
  return Object.freeze({
    created,
    userId: String(account._id),
    isSystemAccount: true,
    isSuperAdmin: false,
    membershipCount: memberships.length,
    permissionKeys: [...READ_ONLY_PERMISSION_KEYS]
  });
}

async function runFromEnvironment({
  env = process.env,
  mongooseInstance = mongoose,
  output = console.log
} = {}) {
  const options = resolveProvisioningOptions(env);
  const databaseName = databaseNameFromUri(options.mongodbUri);
  assertProvisioningTarget(databaseName, options.productionConfirmation);
  await mongooseInstance.connect(options.mongodbUri);
  try {
    const result = await provisionReadOnlyDemoAccount({
      username: options.username,
      password: options.password
    });
    output(JSON.stringify(result));
    return result;
  } finally {
    await mongooseInstance.disconnect();
  }
}

if (require.main === module) {
  require('dotenv').config();
  runFromEnvironment().catch(() => {
    process.stderr.write('Read-only demo account provisioning failed.\n');
    process.exitCode = 1;
  });
}

module.exports = {
  PRODUCTION_CONFIRMATION,
  READ_ONLY_PERMISSION_KEYS,
  assertProvisioningTarget,
  membershipMatches,
  provisionReadOnlyDemoAccount,
  resolveProvisioningOptions,
  teamScopes,
  validatePassword,
  validateUsername
};
