#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const { databaseNameFromUri } = require('../config/environment');
const {
  assertMigrationDatabaseIsolation,
  createLegacyTenantMigrationService
} = require('../services/legacyTenantMigrationService');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const VALUE_OPTIONS = new Set([
  'confirm-database',
  'super-admin-username',
  'backup-manifest',
  'report',
  'planned-team-id',
  'planned-root-org-id'
]);
const FLAG_OPTIONS = new Set(['execute', 'dry-run', 'help']);

function usage() {
  return [
    'Legacy single-team migration (defaults to strict dry-run)',
    '',
    'Dry-run:',
    '  node script/migrateLegacyTenant.js --super-admin-username <username> --report <path>',
    '',
    'Execute (all guards are mandatory):',
    '  node script/migrateLegacyTenant.js --execute \\',
    '    --confirm-database <exact_v2_database_name> \\',
    '    --super-admin-username <username> \\',
    '    --backup-manifest <verified_manifest.json> \\',
    '    --report <report.json>',
    '',
    'MONGODB_URI is read from the environment. It is never written to the report.'
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
    `legacy-tenant-${stamp}.json`
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
  await fs.promises.rename(temporary, resolved);
  return resolved;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const mongodbUri = process.env.MONGODB_URI;
  if (!mongodbUri) throw new Error('MONGODB_URI is required');
  const databaseName = databaseNameFromUri(mongodbUri);
  assertMigrationDatabaseIsolation(databaseName);

  const reportPath = args.report || defaultReportPath();
  await mongoose.connect(mongodbUri, {
    dbName: databaseName,
    autoIndex: false,
    serverSelectionTimeoutMS: 10_000
  });
  try {
    const service = createLegacyTenantMigrationService({ connection: mongoose.connection });
    const report = await service.run({
      execute: args.execute,
      confirmDatabase: args.confirmDatabase,
      superAdminUsername: args.superAdminUsername,
      backupManifestPath: args.backupManifest,
      plannedTeamId: args.plannedTeamId,
      plannedRootOrgId: args.plannedRootOrgId
    });
    const writtenReportPath = await writeJsonAtomic(reportPath, report);
    process.stdout.write(`${JSON.stringify({
      status: report.status,
      mode: report.mode,
      writePerformed: report.writePerformed,
      blockerCount: report.before.anomalies.blockerCount,
      reportPath: writtenReportPath
    })}\n`);
    if (report.status === 'BLOCKED' || report.status === 'DRY_RUN_BLOCKED') {
      process.exitCode = 2;
    }
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      status: 'FAILED',
      code: error.code || 'MIGRATION_FAILED',
      message: error.message,
      details: error.details || null
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  defaultReportPath,
  main,
  parseArgs,
  usage,
  writeJsonAtomic
};
