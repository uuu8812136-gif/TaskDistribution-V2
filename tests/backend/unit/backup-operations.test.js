'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  BACKUP_FORMAT,
  OperationsError,
  assertBackupPathPolicy,
  assertRestoreDatabaseEmpty,
  assertRestoreTarget,
  computeRetentionPlan,
  mongoServerUri,
  restoreBackup,
  verifyBackupSet
} = require('../../../ops/lib/backupCore');

const testRoot = path.resolve(__dirname, '../../../.test-data/backup-operations-tests');

async function isolatedDirectory(t) {
  await fs.promises.mkdir(testRoot, { recursive: true });
  const directory = await fs.promises.mkdtemp(path.join(testRoot, 'case-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function writeBackupSet(directory, {
  backupId = 'backup-20260717T020000Z-abcdef12',
  sourceDatabase = 'task_distribution_v2'
} = {}) {
  const databaseDirectory = path.join(directory, 'database', sourceDatabase);
  await fs.promises.mkdir(databaseDirectory, { recursive: true });
  await fs.promises.mkdir(path.join(directory, 'uploads'), { recursive: true });
  const bsonPath = path.join(databaseDirectory, 'items.bson');
  await fs.promises.writeFile(bsonPath, Buffer.alloc(0));
  const relative = `database/${sourceDatabase}/items.bson`;
  const manifest = {
    format: BACKUP_FORMAT,
    backupId,
    createdAt: '2026-07-17T02:00:00.000Z',
    completedAt: '2026-07-17T02:00:01.000Z',
    retentionTags: ['daily'],
    database: {
      name: sourceDatabase,
      hosts: ['127.0.0.1'],
      collectionCount: 1,
      collections: [{
        name: 'items',
        file: 'items.bson',
        documentCount: 0,
        bytes: 0,
        sha256: createHash('sha256').update(Buffer.alloc(0)).digest('hex')
      }]
    },
    uploads: {
      fileCount: 0,
      bytes: 0,
      fileAssetReferences: { referenced: 0, verified: 0 }
    },
    consistency: {
      restoreSet: 'database-and-uploads',
      databaseFileAssetsVerifiedAgainstUploadBytes: true
    },
    files: [{
      file: relative,
      bytes: 0,
      sha256: createHash('sha256').update(Buffer.alloc(0)).digest('hex')
    }]
  };
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  await fs.promises.writeFile(path.join(directory, 'manifest.json'), serialized);
  await fs.promises.writeFile(
    path.join(directory, 'manifest.sha256'),
    `${createHash('sha256').update(serialized).digest('hex')}  manifest.json\n`
  );
  return manifest;
}

test('backup paths require a dedicated non-system volume and cannot overlap uploads', () => {
  assert.deepEqual(assertBackupPathPolicy({
    backupRoot: 'E:\\ops\\backups',
    backupVolumeRoot: 'E:\\ops',
    uploadRoot: 'E:\\state\\uploads',
    platform: 'win32',
    systemDrive: 'C:'
  }), {
    backupRoot: 'E:\\ops\\backups',
    backupVolumeRoot: 'E:\\ops',
    uploadRoot: 'E:\\state\\uploads'
  });
  assert.throws(() => assertBackupPathPolicy({
    backupRoot: 'C:\\ops\\backups',
    backupVolumeRoot: 'C:\\ops',
    uploadRoot: 'E:\\state\\uploads',
    platform: 'win32',
    systemDrive: 'C:'
  }), (error) => error instanceof OperationsError && error.code === 'BACKUP_SYSTEM_VOLUME_FORBIDDEN');
  assert.throws(() => assertBackupPathPolicy({
    backupRoot: 'E:\\state\\uploads\\backups',
    backupVolumeRoot: 'E:\\state',
    uploadRoot: 'E:\\state\\uploads',
    platform: 'win32',
    systemDrive: 'C:'
  }), (error) => error.code === 'BACKUP_UPLOAD_PATH_OVERLAP');
});

test('retention keeps the newest seven daily and four weekly recovery points', () => {
  const backups = Array.from({ length: 35 }, (_, index) => ({
    backupId: `backup-${index}`,
    completedAt: new Date(Date.UTC(2026, 6, 17 - index)).toISOString(),
    tags: index % 7 === 0 ? ['daily', 'weekly'] : ['daily']
  }));
  const plan = computeRetentionPlan(backups, { dailyKeep: 7, weeklyKeep: 4 });
  const kept = new Set(plan.filter((entry) => entry.action === 'KEEP').map((entry) => entry.backupId));
  for (let index = 0; index < 7; index += 1) assert.equal(kept.has(`backup-${index}`), true);
  for (const index of [0, 7, 14, 21]) assert.equal(kept.has(`backup-${index}`), true);
  assert.equal(kept.has('backup-28'), false);
});

test('backup verification rejects any file changed after manifest publication', async (t) => {
  const directory = await isolatedDirectory(t);
  await writeBackupSet(directory);
  await verifyBackupSet(directory, { verifyFiles: true });
  await fs.promises.writeFile(path.join(directory, 'database/task_distribution_v2/items.bson'), 'tampered');
  await assert.rejects(
    verifyBackupSet(directory, { verifyFiles: true }),
    (error) => error.code === 'BACKUP_FILE_SIZE_MISMATCH'
  );
});

test('restore target is limited to loopback disposable database names', () => {
  assert.equal(assertRestoreTarget({
    uri: 'mongodb://127.0.0.1:27017/task_distribution_restore_test',
    sourceDatabase: 'task_distribution_v2',
    targetDatabase: 'task_distribution_restore_test'
  }).targetDatabase, 'task_distribution_restore_test');
  assert.throws(() => assertRestoreTarget({
    uri: 'mongodb://db.example.test:27017/task_distribution_restore_test',
    sourceDatabase: 'task_distribution_v2',
    targetDatabase: 'task_distribution_restore_test'
  }), (error) => error.code === 'RESTORE_LOOPBACK_REQUIRED');
  assert.throws(() => assertRestoreTarget({
    uri: 'mongodb://127.0.0.1:27017/task_distribution',
    sourceDatabase: 'task_distribution_v2',
    targetDatabase: 'task_distribution'
  }), (error) => error.code === 'RESTORE_DATABASE_NAME_FORBIDDEN');
  assert.throws(() => assertRestoreTarget({
    uri: 'mongodb://127.0.0.1:27017/task_distribution_v2',
    sourceDatabase: 'task_distribution_v2',
    targetDatabase: 'task_distribution_restore_test'
  }), (error) => error.code === 'RESTORE_SOURCE_OVERWRITE_FORBIDDEN');
  assert.throws(() => assertRestoreTarget({
    uri: 'mongodb://127.0.0.1:27017/admin',
    sourceDatabase: 'task_distribution_v2',
    targetDatabase: 'task_distribution_restore_test'
  }), (error) => error.code === 'RESTORE_TARGET_URI_MISMATCH');
});

test('restore tool URI removes only the default database and preserves server options', () => {
  assert.equal(
    mongoServerUri('mongodb://127.0.0.1:27140/admin?replicaSet=v2_local_e2e_rs'),
    'mongodb://127.0.0.1:27140/?replicaSet=v2_local_e2e_rs'
  );
});

test('restore refuses to touch an existing target database', async () => {
  class ExistingDatabaseClient {
    async connect() {}
    db() {
      return { listCollections: () => ({ toArray: async () => [{ name: 'users' }] }) };
    }
    async close() {}
  }
  await assert.rejects(assertRestoreDatabaseEmpty({
    mongodbUri: 'mongodb://127.0.0.1:27017/admin',
    targetDatabase: 'task_distribution_restore_test',
    MongoClientImpl: ExistingDatabaseClient
  }), (error) => error.code === 'RESTORE_TARGET_NOT_EMPTY');
});

test('restore publishes an atomic isolated report after mocked database reconciliation', async (t) => {
  const root = await isolatedDirectory(t);
  const backupVolumeRoot = path.join(root, 'backup-volume');
  const backupRoot = path.join(backupVolumeRoot, 'backups');
  const uploadRoot = path.join(root, 'active-uploads');
  const restoreRoot = path.join(root, 'restore-drills');
  const backupId = 'backup-20260717T020000Z-abcdef12';
  const backupDirectory = path.join(backupRoot, backupId);
  await fs.promises.mkdir(backupDirectory, { recursive: true });
  await fs.promises.mkdir(uploadRoot, { recursive: true });
  await writeBackupSet(backupDirectory, { backupId });
  const toolDirectory = path.join(root, 'tools');
  await fs.promises.mkdir(toolDirectory);
  const mongorestorePath = path.join(toolDirectory, 'mongorestore.exe');
  await fs.promises.writeFile(mongorestorePath, 'mock');

  let clientNumber = 0;
  class RestoreClient {
    constructor() { this.number = clientNumber++; }
    async connect() {}
    db() {
      if (this.number === 0) {
        return { listCollections: () => ({ toArray: async () => [] }) };
      }
      return {
        listCollections: () => ({ toArray: async () => [{ name: 'items' }] }),
        collection: (name) => {
          assert.equal(name, 'items');
          return { countDocuments: async () => 0 };
        }
      };
    }
    async close() {}
  }
  const spawnImpl = (_executable, args) => {
    const directoryIndex = args.indexOf('--dir');
    assert.notEqual(directoryIndex, -1);
    assert.equal(args[directoryIndex + 1], path.join(backupDirectory, 'database'));
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => child.emit('close', 0, null));
    return child;
  };

  const targetDatabase = `task_distribution_${randomUUID().slice(0, 8)}_restore_test`;
  const result = await restoreBackup({
    backupRoot,
    backupVolumeRoot,
    uploadRoot,
    restoreRoot,
    logPath: path.join(backupVolumeRoot, 'operations.jsonl'),
    mongodbUri: `mongodb://127.0.0.1:27017/${targetDatabase}`,
    targetDatabase,
    mongorestorePath,
    mongorestoreSha256: '',
    platform: 'win32',
    systemDrive: 'C:'
  }, backupId, { spawnImpl, MongoClientImpl: RestoreClient });

  assert.equal(result.report.backupId, backupId);
  assert.equal(result.report.reconciliation.collections[0].documentCount, 0);
  assert.equal((await fs.promises.stat(result.finalDirectory)).isDirectory(), true);
  assert.equal((await fs.promises.stat(path.join(result.finalDirectory, 'restore-report.json'))).isFile(), true);
  assert.equal((await fs.promises.readdir(restoreRoot)).some((name) => name.includes('.tmp-')), false);
});
