#!/usr/bin/env node
'use strict';

const path = require('node:path');
const {
  acquireExclusiveLock,
  applyRetention,
  ensureSafeBackupRoot
} = require('./lib/backupCore');
const {
  backupConfigFromEnv,
  loadOperationsEnvironment,
  parseArgs
} = require('./lib/operationsConfig');

function usage() {
  return [
    'Preview or apply backup retention.',
    '',
    'Usage:',
    '  node ops/retention.js --env-file <absolute path> --dry-run',
    '  node ops/retention.js --env-file <absolute path> --apply',
    '',
    'No deletion occurs unless --apply is explicitly provided.'
  ].join('\n');
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv, { values: ['env-file'], flags: ['help', 'dry-run', 'apply'] });
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return null;
  }
  if (args.apply && args['dry-run']) throw new Error('--apply and --dry-run are mutually exclusive');
  const env = await loadOperationsEnvironment({ envFile: args['env-file'] });
  const config = backupConfigFromEnv(env);
  const safePaths = await ensureSafeBackupRoot(config);
  const lock = await acquireExclusiveLock(path.join(safePaths.backupRoot, '.operations.lock'));
  try {
    const plan = await applyRetention({
      backupRoot: safePaths.backupRoot,
      logPath: config.logPath,
      dailyKeep: config.dailyKeep,
      weeklyKeep: config.weeklyKeep,
      dryRun: !args.apply
    });
    process.stdout.write(`${JSON.stringify({
      status: args.apply ? 'RETENTION_APPLIED' : 'RETENTION_DRY_RUN',
      plan: plan.map(({ backupId, tags, action, reason }) => ({ backupId, tags, action, reason }))
    }, null, 2)}\n`);
    return plan;
  } finally {
    await lock.release();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      status: 'RETENTION_FAILED',
      code: error.code || 'UNEXPECTED_ERROR',
      message: error.message
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, usage };
