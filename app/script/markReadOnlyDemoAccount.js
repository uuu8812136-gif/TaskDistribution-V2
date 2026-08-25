#!/usr/bin/env node
'use strict';

const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('node:path');
const User = require('../models/User');

dotenv.config({ path: process.env.ENV_FILE || path.join(__dirname, '..', '.env') });

async function markReadOnlyDemoAccount({
  username = process.env.READONLY_DEMO_USERNAME || 'demo_readonly',
  mongooseInstance = mongoose,
  UserModel = User,
  output = console.log
} = {}) {
  const mongodbUri = String(process.env.MONGODB_URI || '').trim();
  if (!mongodbUri) throw new Error('MONGODB_URI is required');
  const normalized = User.normalizeUsername(username);
  await mongooseInstance.connect(mongodbUri);
  try {
    const account = await UserModel.findOne({
      usernameNormalized: normalized,
      isSystemAccount: true,
      isSuperAdmin: false,
      status: 'active'
    });
    if (!account) throw new Error('Active read-only demo account was not found');
    account.isReadOnlyDemo = true;
    await account.save();
    const result = {
      status: 'READ_ONLY_DEMO_MARKED',
      userId: String(account._id),
      isReadOnlyDemo: true
    };
    output(JSON.stringify(result));
    return result;
  } finally {
    await mongooseInstance.disconnect();
  }
}

if (require.main === module) {
  markReadOnlyDemoAccount().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { markReadOnlyDemoAccount };
