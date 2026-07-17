#!/usr/bin/env node
'use strict';

const { createBackup } = require('./lib/backupCore');
const {
  backupConfigFromEnv,
  loadOperationsEnvironment,
  parseArgs
} = require('./lib/operationsConfig');

function usage() {
  return [
    'Create one database + uploads recovery point.',
    '',
    'Usage:',
    '  node ops/backup.js --env-file <absolute protected env path>',
    '',
    'Credentials are read from the environment file and are never accepted as CLI options.'
  ].join('\n');
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv, { values: ['env-file'], flags: ['help'] });
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return null;
  }
  const env = await loadOperationsEnvironment({ envFile: args['env-file'] });
  const result = await createBackup(backupConfigFromEnv(env));
  const summary = {
    status: 'BACKUP_COMPLETED',
    backupId: result.backupId,
    directory: result.finalDirectory,
    manifestSha256: result.manifestSha256,
    database: result.manifest.database.name,
    files: result.manifest.files.length,
    uploadFiles: result.manifest.uploads.fileCount
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      status: 'BACKUP_FAILED',
      code: error.code || 'UNEXPECTED_ERROR',
      message: error.message,
      details: error.details || undefined
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, usage };
