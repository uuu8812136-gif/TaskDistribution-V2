#!/usr/bin/env node
'use strict';

const path = require('node:path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

dotenv.config({ path: process.env.ENV_FILE || path.resolve(__dirname, '../.env') });

const { loadEnvironment } = require('../config/environment');
const {
  DEFAULT_TEMPORARY_FILE_CLEANUP_LIMIT,
  createTemporaryFileCleanupService
} = require('../services/temporaryFileCleanupService');

function positiveInteger(value, name, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return parsed;
}

function parseArguments(argv, { defaultMaxAgeHours = 24 } = {}) {
  const values = {};
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') {
      apply = true;
      continue;
    }
    if (argument === '--dry-run') {
      apply = false;
      continue;
    }
    if (!['--max-age-hours', '--limit'].includes(argument)) {
      throw new TypeError(`Unsupported option: ${argument}`);
    }
    if (index + 1 >= argv.length) throw new TypeError(`${argument} requires a value`);
    values[argument.slice(2)] = argv[index + 1];
    index += 1;
  }
  return {
    apply,
    maxAgeHours: positiveInteger(
      values['max-age-hours'],
      'max-age-hours',
      defaultMaxAgeHours
    ),
    limit: positiveInteger(values.limit, 'limit', DEFAULT_TEMPORARY_FILE_CLEANUP_LIMIT)
  };
}

async function main() {
  const config = loadEnvironment();
  const options = parseArguments(process.argv.slice(2), {
    defaultMaxAgeHours: config.temporaryFileTtlHours
  });
  await mongoose.connect(config.mongodbUri);
  try {
    const service = createTemporaryFileCleanupService({ storageRoot: config.uploadPath });
    const report = await service.cleanupExpiredTemporaryFiles({
      maxAgeMs: options.maxAgeHours * 60 * 60 * 1000,
      limit: options.limit,
      apply: options.apply
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (report.failed > 0) process.exitCode = 2;
    return report;
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Temporary file cleanup failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, parseArguments };
