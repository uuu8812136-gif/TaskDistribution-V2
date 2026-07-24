#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const { databaseNameFromUri } = require('../config/environment');
const {
  BACKFILL_REPORT_FORMAT,
  createTransportMasterDataBackfillService
} = require('../services/transportMasterDataBackfillService');

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
    'Backfill team transport master data and record references (dry-run by default).',
    '',
    'Preview:',
    '  node script/backfillTransportMasterData.js',
    '',
    'Execute (all guards are mandatory):',
    '  node script/backfillTransportMasterData.js --execute \\',
    '    --confirm-database <exact_database_name> \\',
    '    --backup-directory <verified_backup_directory> \\',
    '    --report <report.json>',
    '',
    'Historical trip, route, vehicle, driver and vehicle-type snapshots are never modified.'
  ].join('\n');
}

function defaultReportPath() {
  const stamp = new Date().toISOString().replaceAll(':', '-');
  return path.resolve(
    __dirname,
    '../../.test-data/migration-reports',
    `transport-master-data-${stamp}.json`
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
    format: BACKFILL_REPORT_FORMAT,
    generatedAt: new Date().toISOString(),
    status: 'FAILED',
    mode: execute ? 'execute' : 'dry-run',
    database: { name: databaseName || null },
    backup: error?.details?.backup || null,
    writePerformed: error?.details?.writePerformed === true,
    error: {
      code: error.code || 'TRANSPORT_MASTER_BACKFILL_FAILED',
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
  const reportPath = args.report || defaultReportPath();
  let connected = false;
  try {
    await mongoose.connect(mongodbUri, { autoIndex: false, serverSelectionTimeoutMS: 10_000 });
    connected = true;
    const service = createTransportMasterDataBackfillService({ connection: mongoose.connection });
    const report = await service.run({
      execute: args.execute,
      confirmDatabase: args.confirmDatabase,
      backupDirectory: args.backupDirectory
    });
    const writtenReportPath = await writeJsonAtomic(reportPath, report);
    process.stdout.write(`${JSON.stringify({
      status: report.status,
      mode: report.mode,
      writePerformed: report.writePerformed,
      mastersCreated: report.mastersCreated,
      recordsUpdated: report.recordsUpdated,
      reportPath: writtenReportPath
    })}\n`);
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
      code: error.code || 'TRANSPORT_MASTER_BACKFILL_FAILED',
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
