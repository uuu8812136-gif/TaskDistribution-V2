#!/usr/bin/env node
'use strict';

const mongoose = require('mongoose');
const { SYSTEM_ACCOUNT_DISPLAY_NAME } = require('../config/systemAccount');
const {
  AUDIT_ACTIONS,
  AUDIT_ACTOR_MODES,
  AUDIT_ACTOR_ROLES,
  AUDIT_RESOURCE_TYPES
} = require('../config/permissions');
const AuditLog = require('../models/AuditLog');
const TeamMembership = require('../models/TeamMembership');
const User = require('../models/User');
const { createAuditService } = require('../services/auditService');

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
    throw new Error('DEVELOPER_ACCOUNT_USERNAME must contain 3-50 characters');
  }
  return username;
}

function validatePassword(value) {
  if (value.length < 6 || value.length > 128) {
    throw new Error('DEVELOPER_ACCOUNT_PASSWORD must contain 6-128 characters');
  }
  return value;
}

function resolveProvisioningOptions(env = process.env) {
  return Object.freeze({
    mongodbUri: requiredEnvironmentValue(env, 'MONGODB_URI').trim(),
    username: validateUsername(
      requiredEnvironmentValue(env, 'DEVELOPER_ACCOUNT_USERNAME')
    ),
    password: validatePassword(
      requiredEnvironmentValue(env, 'DEVELOPER_ACCOUNT_PASSWORD')
    )
  });
}

function assertSystemAccountIdentity(account, usernameNormalized) {
  if (!account || account.isSystemAccount !== true) {
    throw new Error('A non-system account already uses the requested username');
  }
  const validIdentity = (
    account.usernameNormalized === usernameNormalized &&
    Number.isInteger(account.tokenVersion) &&
    account.tokenVersion >= 0 &&
    Array.isArray(account.roles) &&
    account.roles.length === 1 &&
    account.roles[0] === 'admin' &&
    typeof account.password === 'string'
  );
  if (!validIdentity) {
    throw new Error('The existing system account does not match the required configuration');
  }
}

function auditSnapshot() {
  return {
    accountType: 'SYSTEM_DEVELOPER',
    isSystemAccount: true,
    isSuperAdmin: true,
    status: 'active',
    roles: ['admin']
  };
}

function provisioningAuditQuery(userId) {
  return {
    actorRole: AUDIT_ACTOR_ROLES.SYSTEM,
    actorMode: AUDIT_ACTOR_MODES.SYSTEM,
    action: AUDIT_ACTIONS.CREATE,
    resourceType: AUDIT_RESOURCE_TYPES.USER,
    resourceId: String(userId)
  };
}

async function disableAccount(account) {
  account.status = 'inactive';
  account.isSuperAdmin = false;
  await account.save();
}

async function reconcileDeveloperAccount({
  account,
  password,
  usernameNormalized,
  created,
  UserModel,
  TeamMembershipModel,
  AuditLogModel,
  auditService
}) {
  assertSystemAccountIdentity(account, usernameNormalized);

  if (!await account.comparePassword(password)) {
    throw new Error('Developer account password does not match the existing account');
  }

  const membershipExists = await TeamMembershipModel.exists({ userId: account._id });
  if (membershipExists) {
    throw new Error('Developer system account must not have a team membership');
  }

  const auditExists = Boolean(
    await AuditLogModel.exists(provisioningAuditQuery(account._id))
  );
  const isActive = account.status === 'active' && account.isSuperAdmin === true;
  const isPending = account.status === 'inactive' && account.isSuperAdmin === false;
  const displayNameChanged = account.name !== SYSTEM_ACCOUNT_DISPLAY_NAME;
  if (displayNameChanged) account.name = SYSTEM_ACCOUNT_DISPLAY_NAME;

  if (isActive) {
    if (auditExists) {
      if (displayNameChanged) await account.save();
      return Object.freeze({ created: false, userId: String(account._id) });
    }
    await disableAccount(account);
    throw new Error('Active developer account is missing its provisioning audit and was disabled');
  }

  if (!isPending) {
    await disableAccount(account);
    throw new Error('Developer account has an invalid provisioning state and was disabled');
  }

  if (!auditExists) {
    try {
      await auditService.recordSystem({
        action: AUDIT_ACTIONS.CREATE,
        resourceType: AUDIT_RESOURCE_TYPES.USER,
        resourceId: account._id,
        after: auditSnapshot(),
        reason: 'Provisioned system developer account'
      });
    } catch (error) {
      if (created) {
        await UserModel.deleteOne({
          _id: account._id,
          isSystemAccount: true,
          status: 'inactive',
          isSuperAdmin: false
        });
      }
      throw error;
    }
  }

  account.status = 'active';
  account.isSuperAdmin = true;
  await account.save();
  return Object.freeze({ created, userId: String(account._id) });
}

async function provisionDeveloperAccount({
  username,
  password,
  UserModel = User,
  TeamMembershipModel = TeamMembership,
  AuditLogModel = AuditLog,
  auditService = createAuditService()
}) {
  const validatedUsername = validateUsername(username);
  const validatedPassword = validatePassword(password);
  const usernameNormalized = User.normalizeUsername(validatedUsername);
  let account;
  let created = false;
  account = await UserModel.findOne({ usernameNormalized });
  if (account) {
    assertSystemAccountIdentity(account, usernameNormalized);
  }

  if (!account) {
    try {
      account = await UserModel.create({
        username: validatedUsername,
        password: validatedPassword,
        name: SYSTEM_ACCOUNT_DISPLAY_NAME,
        roles: ['admin'],
        isSystemAccount: true,
        isSuperAdmin: false,
        tokenVersion: 0,
        status: 'inactive'
      });
      created = true;
    } catch (error) {
      if (error?.code !== 11000) throw error;
      account = await UserModel.findOne({ usernameNormalized });
      if (!account) throw error;
    }
  }

  return reconcileDeveloperAccount({
    account,
    password: validatedPassword,
    usernameNormalized,
    created,
    UserModel,
    TeamMembershipModel,
    AuditLogModel,
    auditService
  });
}

async function runFromEnvironment({
  env = process.env,
  mongooseInstance = mongoose,
  output = console.log
} = {}) {
  const options = resolveProvisioningOptions(env);
  await mongooseInstance.connect(options.mongodbUri);
  try {
    const result = await provisionDeveloperAccount({
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
    process.stderr.write('Developer account provisioning failed.\n');
    process.exitCode = 1;
  });
}

module.exports = {
  auditSnapshot,
  provisioningAuditQuery,
  provisionDeveloperAccount,
  reconcileDeveloperAccount,
  resolveProvisioningOptions,
  runFromEnvironment
};
