#!/usr/bin/env node
'use strict';

const path = require('node:path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const { databaseNameFromUri } = require('../config/environment');
const {
  ALLOWED_DATABASE_NAME,
  assertAllowedDatabaseName,
  createEquipmentRoutineBusinessAuditService
} = require('../services/equipmentRoutineBusinessAuditService');

dotenv.config({ path: process.env.ENV_FILE || path.resolve(__dirname, '../.env') });

const VALUE_OPTIONS = new Set(['team-code', 'primary-name', 'expect-primary']);
const FLAG_OPTIONS = new Set(['dry-run', 'help']);

function parseExpectedPrimary(value) {
  const separator = value.lastIndexOf('=');
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error('--expect-primary must use the form <primary-name>=<in-use-count>');
  }
  const name = value.slice(0, separator).trim();
  const countText = value.slice(separator + 1).trim();
  if (!name || !/^\d+$/.test(countText)) {
    throw new Error('--expect-primary must use the form <primary-name>=<in-use-count>');
  }
  const expectedInUse = Number(countText);
  if (!Number.isSafeInteger(expectedInUse)) {
    throw new Error('--expect-primary count must be a non-negative safe integer');
  }
  return { name, expectedInUse };
}

function parseArgs(argv) {
  const result = {
    dryRun: true,
    teamCode: null,
    primaryNames: [],
    expectedPrimaries: []
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const [name, inlineValue] = token.slice(2).split(/=(.*)/s, 2);
    if (FLAG_OPTIONS.has(name)) {
      if (inlineValue !== undefined) throw new Error(`--${name} does not accept a value`);
      if (name === 'help') result.help = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) throw new Error(`Unknown option: --${name}`);
    const value = inlineValue === undefined ? argv[++index] : inlineValue;
    if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
    if (name === 'team-code') {
      if (result.teamCode) throw new Error('--team-code may only be supplied once');
      result.teamCode = value.trim().toUpperCase();
    }
    if (name === 'primary-name') result.primaryNames.push(value.trim());
    if (name === 'expect-primary') result.expectedPrimaries.push(parseExpectedPrimary(value));
  }

  const duplicateExpectation = result.expectedPrimaries.find((expectation, index, values) => (
    values.findIndex(({ name }) => name === expectation.name) !== index
  ));
  if (duplicateExpectation) {
    throw new Error(`Duplicate --expect-primary name: ${duplicateExpectation.name}`);
  }
  if (
    (result.primaryNames.length > 0 || result.expectedPrimaries.length > 0) &&
    !result.teamCode
  ) {
    throw new Error('--team-code is required with --primary-name or --expect-primary');
  }
  return result;
}

function usage() {
  return [
    'Read-only equipment routine rule and open-plan business audit.',
    '',
    'Audit every team:',
    '  node script/auditEquipmentRoutineBusiness.js --dry-run',
    '',
    'Audit one team and report selected primary equipment names:',
    '  node script/auditEquipmentRoutineBusiness.js --team-code GEARBOX_LOGISTICS \\',
    '    --primary-name "电动叉车（分类：铅酸电池）"',
    '',
    'Release gate for the current customer fixture:',
    '  node script/auditEquipmentRoutineBusiness.js --team-code GEARBOX_LOGISTICS \\',
    '    --expect-primary "电动叉车（分类：铅酸电池）=6" \\',
    '    --expect-primary "电动叉车（分类：锂离子电池）=5" \\',
    '    --expect-primary "辊子输送机=1"',
    '  The last gate covers the level-4 输送链 equipment under 辊子输送机.',
    '',
    `MONGODB_URI must target exactly ${ALLOWED_DATABASE_NAME}.`,
    'The command has no execute mode, performs no writes, emits one JSON report,',
    'and exits 2 when a business gate fails.'
  ].join('\n');
}

function exitCodeForReport(report) {
  return report?.status === 'PASSED' ? 0 : 2;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return null;
  }
  const mongodbUri = process.env.MONGODB_URI;
  if (!mongodbUri) throw new Error('MONGODB_URI is required');
  const databaseName = databaseNameFromUri(mongodbUri);
  assertAllowedDatabaseName(databaseName);
  let connected = false;
  try {
    await mongoose.connect(mongodbUri, {
      dbName: databaseName,
      autoIndex: false,
      serverSelectionTimeoutMS: 10_000
    });
    connected = true;
    assertAllowedDatabaseName(mongoose.connection.name);
    const report = await createEquipmentRoutineBusinessAuditService({
      connection: mongoose.connection
    }).run({
      teamCode: args.teamCode,
      primaryNames: args.primaryNames,
      expectedPrimaries: args.expectedPrimaries
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return report;
  } finally {
    if (connected) await mongoose.disconnect();
  }
}

if (require.main === module) {
  main()
    .then((report) => {
      if (report) process.exitCode = exitCodeForReport(report);
    })
    .catch((error) => {
      process.stderr.write(`${JSON.stringify({
        status: 'ERROR',
        mode: 'read-only',
        writePerformed: false,
        code: error.code || 'EQUIPMENT_ROUTINE_AUDIT_FAILED',
        message: error.message,
        details: error.details || null
      })}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  exitCodeForReport,
  main,
  parseArgs,
  parseExpectedPrimary,
  usage
};
