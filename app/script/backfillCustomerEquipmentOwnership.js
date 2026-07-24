#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const { databaseNameFromUri } = require('../config/environment');
const { EQUIPMENT_IMPORT_TAG } = require('./customerEquipmentRealDataImporter');
const {
  BACKFILL_REPORT_FORMAT,
  DEFAULT_EXPECTED_ASSET_COUNT,
  createEquipmentOwnershipBackfillService
} = require('../services/equipmentOwnershipBackfillService');

dotenv.config({ path: process.env.ENV_FILE || path.resolve(__dirname, '../.env') });

const DEFAULT_TEAM_CODE = 'GEARBOX_LOGISTICS';
const VALUE_OPTIONS = new Set([
  'confirm-database',
  'backup-directory',
  'report',
  'team-code',
  'operator-username',
  'expected-assets'
]);
const FLAG_OPTIONS = new Set(['execute', 'dry-run', 'help']);

function parseArgs(argv) {
  const result = { execute: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const [rawName, inlineValue] = token.slice(2).split(/=(.*)/s, 2);
    if (FLAG_OPTIONS.has(rawName)) {
      if (inlineValue !== undefined) throw new Error(`--${rawName} does not accept a value`);
      if (rawName === 'execute') result.execute = true;
      if (rawName === 'dry-run') result.execute = false;
      if (rawName === 'help') result.help = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(rawName)) throw new Error(`Unknown option: --${rawName}`);
    const value = inlineValue === undefined ? argv[++index] : inlineValue;
    if (!value || value.startsWith('--')) throw new Error(`--${rawName} requires a value`);
    result[rawName.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  if (result.expectedAssets !== undefined) {
    const parsed = Number(result.expectedAssets);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error('--expected-assets must be a positive integer');
    }
    result.expectedAssets = parsed;
  }
  return result;
}

function usage() {
  return [
    'Backfill customer fixed-asset organization, custodian, and routine-plan ownership (dry-run by default).',
    '',
    'Preview:',
    '  node script/backfillCustomerEquipmentOwnership.js',
    '  node script/backfillCustomerEquipmentOwnership.js --report <report.json>',
    '  No report file is written unless --report is explicitly supplied.',
    '',
    'Execute after a verified backup:',
    '  node script/backfillCustomerEquipmentOwnership.js --execute \\',
    '    --confirm-database <exact_database_name> \\',
    '    --backup-directory <verified_backup_directory> \\',
    '    --operator-username <active_user> \\',
    '    --report <report.json>',
    '',
    'Exact-match rules:',
    '  - orgUnitNameSnapshot must uniquely match one active level-2 sub-department.',
    '  - custodianDisplayName must uniquely match an active member in that sub-department subtree.',
    '  - Existing non-root organization or non-empty custodian conflicts are reported, never overwritten.',
    '  - Routine plans are migrated only from a verified root organization to the resolved equipment owner.',
    `  - Execution expects ${DEFAULT_EXPECTED_ASSET_COUNT} tagged assets unless --expected-assets is supplied.`,
    '  - Execute mode is restricted to customer_acceptance_v2_test.'
  ].join('\n');
}

async function writeJsonAtomic(filePath, value) {
  const resolved = path.resolve(filePath);
  await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.tmp`;
  await fs.promises.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx'
  });
  try {
    await fs.promises.link(temporary, resolved);
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
  return resolved;
}

function failureReport({ error, execute, databaseName }) {
  return {
    format: BACKFILL_REPORT_FORMAT,
    generatedAt: new Date().toISOString(),
    status: 'FAILED',
    mode: execute ? 'execute' : 'dry-run',
    database: { name: databaseName || null },
    writePerformed: error?.details?.writePerformed === true,
    error: {
      code: error.code || 'EQUIPMENT_OWNERSHIP_BACKFILL_FAILED',
      message: error.message,
      details: error.details || null
    }
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return null;
  }
  if (args.execute && !args.report) {
    const error = new Error('--report is required in execute mode');
    error.code = 'REPORT_PATH_REQUIRED';
    throw error;
  }
  const mongodbUri = process.env.MONGODB_URI;
  if (!mongodbUri) throw new Error('MONGODB_URI is required');
  const databaseName = databaseNameFromUri(mongodbUri);
  const reportPath = args.report ? path.resolve(args.report) : null;
  let connected = false;
  try {
    await mongoose.connect(mongodbUri, { autoIndex: false, serverSelectionTimeoutMS: 10_000 });
    connected = true;
    const service = createEquipmentOwnershipBackfillService({ connection: mongoose.connection });
    const report = await service.run({
      execute: args.execute,
      confirmDatabase: args.confirmDatabase,
      backupDirectory: args.backupDirectory,
      teamCode: args.teamCode || DEFAULT_TEAM_CODE,
      importTag: EQUIPMENT_IMPORT_TAG,
      expectedAssetCount: args.expectedAssets || DEFAULT_EXPECTED_ASSET_COUNT,
      operatorUsername: args.operatorUsername
    });
    const writtenReportPath = reportPath
      ? await writeJsonAtomic(reportPath, report)
      : null;
    process.stdout.write(`${JSON.stringify({
      status: report.status,
      mode: report.mode,
      writePerformed: report.writePerformed,
      assetsScanned: report.assetsScanned,
      orgUnitMatches: report.orgUnitMatches,
      custodianMatches: report.custodianMatches,
      assetsToUpdate: report.assetsToUpdate,
      routinePlansScanned: report.routinePlansScanned,
      routinePlansEligible: report.routinePlansEligible,
      routinePlansOutsideResolvedOwnership: report.routinePlansOutsideResolvedOwnership,
      routinePlansToUpdate: report.routinePlansToUpdate,
      routinePlansUpdated: report.routinePlansUpdated,
      anomalousAssets: report.anomalousAssets,
      exceptionReasonCounts: report.exceptionReasonCounts,
      reportPath: writtenReportPath
    })}\n`);
    return report;
  } catch (error) {
    const writtenReportPath = reportPath
      ? await writeJsonAtomic(reportPath, failureReport({
          error,
          execute: args.execute,
          databaseName
        })).catch(() => null)
      : null;
    if (writtenReportPath) error.reportPath = writtenReportPath;
    throw error;
  } finally {
    if (connected) await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      status: 'FAILED',
      code: error.code || 'EQUIPMENT_OWNERSHIP_BACKFILL_FAILED',
      message: error.message,
      details: error.details || null,
      reportPath: error.reportPath || null
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  failureReport,
  main,
  parseArgs,
  usage,
  writeJsonAtomic
};
