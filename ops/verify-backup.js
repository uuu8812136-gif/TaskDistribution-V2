#!/usr/bin/env node
'use strict';

const path = require('node:path');
const {
  acquireExclusiveLock,
  ensureSafeBackupRoot,
  resolveCompletedBackupDirectory,
  verifyBackupSet
} = require('./lib/backupCore');
const {
  loadOperationsEnvironment,
  parseArgs,
  requiredAbsolutePath
} = require('./lib/operationsConfig');

function usage() {
  return [
    'Verify the manifest SHA256, every declared file, and the exact backup file set.',
    '',
    'Usage:',
    '  node ops/verify-backup.js --env-file <absolute protected env path> --backup-id <backup-id>'
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
  const safePaths = await ensureSafeBackupRoot({
    backupRoot: requiredAbsolutePath(env, 'BACKUP_ROOT'),
    backupVolumeRoot: requiredAbsolutePath(env, 'BACKUP_VOLUME_ROOT'),
    uploadRoot: requiredAbsolutePath(env, 'UPLOAD_PATH'),
    systemDrive: env.SystemDrive || env.SYSTEM_DRIVE || 'C:',
    platform: process.platform
  });
  const lock = await acquireExclusiveLock(path.join(safePaths.backupRoot, '.operations.lock'));
  try {
    const directory = await resolveCompletedBackupDirectory(
      safePaths.backupRoot,
      args['backup-id']
    );
    const result = await verifyBackupSet(directory, { verifyFiles: true });
    process.stdout.write(`${JSON.stringify({
      status: 'BACKUP_VERIFIED',
      backupId: result.manifest.backupId,
      directory: result.backupDirectory,
      manifestSha256: result.manifestSha256,
      files: result.manifest.files.length,
      databaseCollections: result.manifest.database.collectionCount,
      uploadFiles: result.manifest.uploads.fileCount,
      fileAssetReferences: result.manifest.uploads.fileAssetReferences
    }, null, 2)}\n`);
    return result;
  } finally {
    await lock.release();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      status: 'BACKUP_VERIFICATION_FAILED',
      code: error.code || 'UNEXPECTED_ERROR',
      message: error.message
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, usage };
