#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const { databaseNameFromUri } = require('../config/environment');
const {
  MIGRATION_REPORT_FORMAT,
  createTaskReviewStageMigrationService
} = require('../services/taskReviewStageMigrationService');

dotenv.config({ path: process.env.ENV_FILE || path.resolve(__dirname, '../.env') });

const VALUE_OPTIONS = new Set(['confirm-database', 'backup-directory', 'report']);
const FLAG_OPTIONS = new Set(['execute', 'dry-run', 'help']);

function usage() {
  return [
    'Task and TaskReview stage/round index migration (defaults to strict dry-run)',
    '',
    'Dry-run:',
    '  node script/migrateTaskReviewStages.js --report <report.json>',
    '',
    'Execute (all guards are mandatory):',
    '  node script/migrateTaskReviewStages.js --execute \\',
    '    --confirm-database <exact_database_name> \\',
    '    --backup-directory <verified_backup_directory> \\',
    '    --report <report.json>',
    '',
    'MONGODB_URI is read from the environment and is never written to the report.'
  ].join('\n');
}

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
    const camelName = rawName.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    result[camelName] = value;
  }
  return result;
}

function defaultReportPath() {
  const stamp = new Date().toISOString().replaceAll(':', '-');
  return path.resolve(
    __dirname,
    '../../.test-data/migration-reports',
    `task-review-stages-${stamp}.json`
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
    backup: error?.details?.backup || null,
    before: error?.details?.before || null,
    after: error?.details?.after || null,
    writePerformed: error?.details?.writePerformed === true,
    completedSteps: error?.details?.completedSteps || [],
    error: {
      code: error.code || 'MIGRATION_FAILED',
      message: error.message,
      details: error.details || null
    }
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
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
    await mongoose.connect(mongodbUri, {
      dbName: databaseName,
      autoIndex: false,
      serverSelectionTimeoutMS: 10_000
    });
    connected = true;
    const service = createTaskReviewStageMigrationService({ connection: mongoose.connection });
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
      blockerCount: report.before.blockers.length,
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
      code: error.code || 'MIGRATION_FAILED',
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
