#!/usr/bin/env node
'use strict';

const mongoose = require('mongoose');
const dotenv = require('dotenv');
const TeamMembership = require('../models/TeamMembership');
const User = require('../models/User');

function requiredUsername(value) {
  if (typeof value !== 'string' || value.trim().length < 3) {
    throw new Error('SUPER_ADMIN_USERNAME is required');
  }
  return value.normalize('NFKC').trim();
}

function retentionResult({ username, user, membershipCount }) {
  const normalizedUsername = User.normalizeUsername(username);
  if (!user) {
    return Object.freeze({
      ok: false,
      code: 'SUPER_ADMIN_NOT_FOUND',
      username: normalizedUsername,
      membershipCount: 0
    });
  }

  const result = {
    ok: (
      user.status === 'active' &&
      user.isSuperAdmin === true &&
      Number(membershipCount) === 0
    ),
    code: 'SUPER_ADMIN_RETAINED',
    username: normalizedUsername,
    userId: String(user._id),
    status: user.status,
    isSuperAdmin: user.isSuperAdmin === true,
    isSystemAccount: user.isSystemAccount === true,
    membershipCount: Number(membershipCount)
  };

  if (result.status !== 'active') result.code = 'SUPER_ADMIN_INACTIVE';
  else if (!result.isSuperAdmin) result.code = 'SUPER_ADMIN_FLAG_MISSING';
  else if (result.membershipCount !== 0) result.code = 'SUPER_ADMIN_MEMBERSHIP_PRESENT';
  return Object.freeze(result);
}

function assertRetention(result) {
  if (!result?.ok) {
    const error = new Error(`Super administrator retention check failed: ${result?.code || 'UNKNOWN'}`);
    error.code = result?.code || 'SUPER_ADMIN_RETENTION_FAILED';
    error.result = result;
    throw error;
  }
  return result;
}

async function verifySuperAdminRetention({
  username,
  UserModel = User,
  TeamMembershipModel = TeamMembership
} = {}) {
  const normalizedUsername = requiredUsername(username);
  const canonical = User.normalizeUsername(normalizedUsername);
  const user = await UserModel.findOne({ usernameNormalized: canonical })
    .select('_id status isSuperAdmin isSystemAccount')
    .lean();
  const membershipCount = user
    ? await TeamMembershipModel.countDocuments({ userId: user._id })
    : 0;
  return assertRetention(retentionResult({
    username: normalizedUsername,
    user,
    membershipCount
  }));
}

function resolveOptions(env = process.env) {
  const mongodbUri = typeof env.MONGODB_URI === 'string' ? env.MONGODB_URI.trim() : '';
  if (!mongodbUri) throw new Error('MONGODB_URI is required');
  return Object.freeze({
    mongodbUri,
    username: requiredUsername(
      env.SUPER_ADMIN_USERNAME || env.CUSTOMER_SUPER_ADMIN_USERNAME
    )
  });
}

async function runFromEnvironment({
  env = process.env,
  mongooseInstance = mongoose,
  output = console.log
} = {}) {
  const options = resolveOptions(env);
  await mongooseInstance.connect(options.mongodbUri);
  try {
    const result = await verifySuperAdminRetention({ username: options.username });
    output(JSON.stringify(result));
    return result;
  } finally {
    await mongooseInstance.disconnect();
  }
}

if (require.main === module) {
  dotenv.config();
  runFromEnvironment().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  assertRetention,
  requiredUsername,
  retentionResult,
  resolveOptions,
  runFromEnvironment,
  verifySuperAdminRetention
};
