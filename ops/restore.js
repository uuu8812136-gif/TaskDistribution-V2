#!/usr/bin/env node
'use strict';

const { restoreBackup } = require('./lib/backupCore');
const {
  loadOperationsEnvironment,
  parseArgs,
  restoreConfigFromEnv
} = require('./lib/operationsConfig');

function usage() {
  return [
    'Restore and reconcile one backup into an isolated loopback test database and directory.',
    '',
    'Usage:',
    '  node ops/restore.js --env-file <absolute protected env path> --backup-id <backup-id>',
    '',
    'The target database must end with _restore_test or _v2_test. Active uploads are never changed.'
  ].join('\n');
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv, { values: ['env-file', 'backup-id'], flags: ['help'] });
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return null;
  }
  if (!args['backup-id']) throw new Error('--backup-id is required');
  const env = await loadOperationsEnvironment({ envFile: args['env-file'] });
  const result = await restoreBackup(restoreConfigFromEnv(env), args['backup-id']);
  process.stdout.write(`${JSON.stringify({
    status: 'RESTORE_VERIFICATION_COMPLETED',
    restoreId: result.restoreId,
    backupId: result.report.backupId,
    targetDatabase: result.report.targetDatabase,
    directory: result.finalDirectory,
    manifestSha256: result.report.manifestSha256,
    reconciliation: result.report.reconciliation
  }, null, 2)}\n`);
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      status: 'RESTORE_VERIFICATION_FAILED',
      code: error.code || 'UNEXPECTED_ERROR',
      message: error.message,
      details: error.details || undefined
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, usage };
