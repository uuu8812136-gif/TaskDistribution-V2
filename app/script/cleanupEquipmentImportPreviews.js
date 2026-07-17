#!/usr/bin/env node
'use strict';

const path = require('node:path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

dotenv.config({ path: process.env.ENV_FILE || path.resolve(__dirname, '../.env') });

const { loadEnvironment } = require('../config/environment');
const {
  createEquipmentImportStagingCleanupService
} = require('../services/equipmentImportStagingCleanupService');

function positiveInteger(value, name, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw new TypeError(`${name} must be a positive integer`);
  return parsed;
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!['--max-age-hours', '--limit'].includes(argument)) {
      throw new TypeError(`Unsupported option: ${argument}`);
    }
    values[argument.slice(2)] = argv[index + 1];
    index += 1;
  }
  return {
    maxAgeHours: positiveInteger(values['max-age-hours'], 'max-age-hours', 24),
    limit: positiveInteger(values.limit, 'limit', 25)
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const config = loadEnvironment();
  await mongoose.connect(config.mongodbUri);
  try {
    const service = createEquipmentImportStagingCleanupService({
      storageRoot: config.uploadPath
    });
    const expired = await service.cleanupExpiredPreviews({
      maxAgeMs: options.maxAgeHours * 60 * 60 * 1000,
      limit: options.limit
    });
    const retried = await service.retryIncompleteCleanup({ limit: options.limit });
    process.stdout.write(`${JSON.stringify({
      cutoff: expired.cutoff.toISOString(),
      expiredMatched: expired.matched,
      cleanupRetried: retried.matched
    })}\n`);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Equipment import cleanup failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, parseArguments };
