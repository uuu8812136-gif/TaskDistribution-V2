#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const { databaseNameFromUri } = require('../config/environment');
const {
  MIGRATION_REPORT_FORMAT,
  createAcceptanceJuly2026DataRepairService
} = require('../services/acceptanceJuly2026DataRepairService');

dotenv.config({ path: process.env.ENV_FILE || path.resolve(__dirname, '../.env') });

const VALUE_OPTIONS = new Set(['confirm-database', 'backup-directory', 'report']);
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
  return result;
}

function usage() {
  return [
    'Repair the fixed June/July 2026 V2 acceptance schedules and attendance records (strict dry-run by default).',
    '',
    'Dry-run:',
    '  node script/repairAcceptanceJuly2026Data.js --report <immutable-report.json>',
    '',
    'Execute after the V2 API is stopped and a complete backup is verified:',
    '  node script/repairAcceptanceJuly2026Data.js --execute \\',
    '    --confirm-database customer_acceptance_v2_test \\',
    '    --backup-directory <verified-complete-backup-directory> \\',
    '    --report <immutable-report.json>',
    '',
    'The migration is fixed to six known record IDs. Any other teamId + month conflict,',
    'partial target state, existing GeneratedDailyReport, stale backup, or missing shared',
    'temporary-worker summary support blocks execution. No index is created by this script.'
  ].join('\n');
}

function defaultReportPath() {
  const stamp = new Date().toISOString().replaceAll(':', '-');
  return path.resolve(
    __dirname,
    '../../.test-data/migration-reports',
    `acceptance-july-2026-repair-${stamp}.json`
  );
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
    format: MIGRATION_REPORT_FORMAT,
    generatedAt: new Date().toISOString(),
    status: 'FAILED',
    mode: execute ? 'execute' : 'dry-run',
    database: { name: databaseName || null },
    writePerformed: error?.details?.writePerformed === true,
    error: {
      code: error.code || 'ACCEPTANCE_JULY_2026_DATA_REPAIR_FAILED',
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
  const reportPath = args.report ? path.resolve(args.report) : defaultReportPath();
  let connected = false;
  try {
    await mongoose.connect(mongodbUri, {
      dbName: databaseName,
      autoIndex: false,
      serverSelectionTimeoutMS: 10_000
    });
    connected = true;
    const report = await createAcceptanceJuly2026DataRepairService({
      connection: mongoose.connection
    }).run({
      execute: args.execute,
      confirmDatabase: args.confirmDatabase,
      backupDirectory: args.backupDirectory
    });
    const writtenReportPath = await writeJsonAtomic(reportPath, report);
    process.stdout.write(`${JSON.stringify({
      status: report.status,
      mode: report.mode,
      writePerformed: report.writePerformed,
      plannedWriteCount: report.before?.plannedWriteCount ?? null,
      blockerCount: report.before?.blockerCount ?? null,
      dataWrites: report.dataWrites,
      auditLogsCreated: report.auditLogsCreated,
      reportPath: writtenReportPath
    })}\n`);
    if (report.status === 'BLOCKED' || report.status === 'DRY_RUN_BLOCKED') process.exitCode = 2;
    return report;
  } catch (error) {
    const writtenReportPath = await writeJsonAtomic(reportPath, failureReport({
      error,
      execute: args.execute,
      databaseName
    })).catch(() => null);
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
      code: error.code || 'ACCEPTANCE_JULY_2026_DATA_REPAIR_FAILED',
      message: error.message,
      details: error.details || null,
      reportPath: error.reportPath || null
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  defaultReportPath,
  failureReport,
  main,
  parseArgs,
  usage,
  writeJsonAtomic
};
