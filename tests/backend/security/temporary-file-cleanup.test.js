'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { after, before, test } = require('node:test');
const appRequire = require('../helpers/appRequire');

const mongoose = appRequire('mongoose');
const { MongoMemoryServer } = appRequire('mongodb-memory-server');
const FileAsset = require('../../../app/models/FileAsset');
const {
  createStorageKey,
  resolveStoragePath
} = require('../../../app/services/fileStorageService');
const {
  createTemporaryFileCleanupService
} = require('../../../app/services/temporaryFileCleanupService');

const TEST_DATABASE_NAME = `temporary_cleanup_${randomUUID().replaceAll('-', '')}_v2_test`;
const NOW = new Date('2026-07-21T12:00:00.000Z');
const teamId = new mongoose.Types.ObjectId();
const uploaderId = new mongoose.Types.ObjectId();
let mongo;
let storageRoot;

async function createStoredAsset({
  status = FileAsset.FILE_STATUSES.TEMPORARY,
  ownerType = FileAsset.FILE_OWNER_TYPES.TEMPORARY,
  ownerId = null,
  ageHours = 48,
  cleanupAgeMinutes = null,
  content = Buffer.from('temporary-file-cleanup')
} = {}) {
  const storageKey = createStorageKey({
    teamId,
    originalName: 'cleanup.txt',
    mimeType: 'text/plain',
    now: NOW
  });
  const storagePath = resolveStoragePath(storageRoot, storageKey);
  await fs.promises.mkdir(path.dirname(storagePath), { recursive: true });
  await fs.promises.writeFile(storagePath, content);
  const file = await FileAsset.create({
    teamId,
    ownerType,
    ownerId,
    storageKey,
    originalName: 'cleanup.txt',
    mimeType: 'text/plain',
    size: content.length,
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
    uploaderId,
    status,
    cleanupStartedAt: cleanupAgeMinutes === null
      ? null
      : new Date(NOW.getTime() - cleanupAgeMinutes * 60 * 1000)
  });
  const createdAt = new Date(NOW.getTime() - ageHours * 60 * 60 * 1000);
  await FileAsset.collection.updateOne({ _id: file._id }, { $set: { createdAt } });
  return { file: await FileAsset.findById(file._id).lean(), storagePath };
}

before(async () => {
  storageRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'temporary-cleanup-v2-'));
  mongo = await MongoMemoryServer.create({ instance: { dbName: TEST_DATABASE_NAME } });
  await mongoose.connect(mongo.getUri(TEST_DATABASE_NAME), { dbName: TEST_DATABASE_NAME });
  await FileAsset.syncIndexes();
});

after(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (mongo) await mongo.stop();
  if (storageRoot) await fs.promises.rm(storageRoot, { recursive: true, force: true });
});

test('temporary cleanup expires only unbound assets and atomically skips a newly bound file', async () => {
  const expired = await createStoredAsset();
  const active = await createStoredAsset({
    status: FileAsset.FILE_STATUSES.ACTIVE,
    ownerType: FileAsset.FILE_OWNER_TYPES.TASK,
    ownerId: new mongoose.Types.ObjectId(),
    ageHours: 72
  });
  const recent = await createStoredAsset({ ageHours: 1 });
  const abandonedClaim = await createStoredAsset({
    status: FileAsset.FILE_STATUSES.PURGING,
    ageHours: 72,
    cleanupAgeMinutes: 30
  });
  const activeClaim = await createStoredAsset({
    status: FileAsset.FILE_STATUSES.PURGING,
    ageHours: 72,
    cleanupAgeMinutes: 5
  });
  const service = createTemporaryFileCleanupService({ storageRoot });

  const preview = await service.cleanupExpiredTemporaryFiles({
    now: NOW,
    maxAgeMs: 24 * 60 * 60 * 1000
  });
  assert.equal(preview.mode, 'dry-run');
  assert.equal(preview.matched, 1);
  assert.ok(await fs.promises.stat(expired.storagePath));

  const applied = await service.cleanupExpiredTemporaryFiles({
    now: NOW,
    maxAgeMs: 24 * 60 * 60 * 1000,
    apply: true
  });
  assert.equal(applied.recoveredClaims, 1);
  assert.equal(applied.matched, 2);
  assert.equal(applied.deleted, 2);
  assert.equal(applied.failed, 0);
  assert.equal(await FileAsset.findById(expired.file._id), null);
  assert.equal(await FileAsset.findById(abandonedClaim.file._id), null);
  await assert.rejects(fs.promises.stat(expired.storagePath), { code: 'ENOENT' });
  await assert.rejects(fs.promises.stat(abandonedClaim.storagePath), { code: 'ENOENT' });

  for (const retained of [active, recent, activeClaim]) {
    assert.ok(await FileAsset.findById(retained.file._id));
    assert.ok(await fs.promises.stat(retained.storagePath));
  }
  assert.equal(
    (await FileAsset.findById(activeClaim.file._id).lean()).status,
    FileAsset.FILE_STATUSES.PURGING
  );

  const staleBinding = await createStoredAsset({ ageHours: 48 });
  const staleDocument = await FileAsset.findById(staleBinding.file._id);
  let releaseRemoval;
  let signalRemovalStarted;
  const removalStarted = new Promise((resolve) => { signalRemovalStarted = resolve; });
  const removalReleased = new Promise((resolve) => { releaseRemoval = resolve; });
  const delayedCleanup = createTemporaryFileCleanupService({
    storageRoot,
    fsPromises: {
      async rm(target, options) {
        signalRemovalStarted();
        await removalReleased;
        return fs.promises.rm(target, options);
      }
    }
  }).cleanupExpiredTemporaryFiles({
    now: NOW,
    maxAgeMs: 24 * 60 * 60 * 1000,
    apply: true
  });
  await removalStarted;
  staleDocument.ownerType = FileAsset.FILE_OWNER_TYPES.TASK;
  staleDocument.ownerId = new mongoose.Types.ObjectId();
  staleDocument.status = FileAsset.FILE_STATUSES.ACTIVE;
  let staleSaveError;
  try {
    await staleDocument.save();
  } catch (error) {
    staleSaveError = error;
  } finally {
    releaseRemoval();
  }
  const delayedReport = await delayedCleanup;
  assert.equal(staleSaveError?.name, 'VersionError');
  assert.equal(delayedReport.deleted, 1);
  assert.equal(await FileAsset.findById(staleBinding.file._id), null);
  await assert.rejects(fs.promises.stat(staleBinding.storagePath), { code: 'ENOENT' });

  const racing = await createStoredAsset({ ageHours: 48 });
  const racingOwnerId = new mongoose.Types.ObjectId();
  const racingModel = {
    find: (...args) => FileAsset.find(...args),
    updateMany: (...args) => FileAsset.updateMany(...args),
    updateOne: (...args) => FileAsset.updateOne(...args),
    deleteOne: (...args) => FileAsset.deleteOne(...args),
    findOneAndUpdate(filter, update, options) {
      return {
        async lean() {
          if (String(filter._id) === String(racing.file._id)) {
            await FileAsset.updateOne({
              _id: racing.file._id,
              status: FileAsset.FILE_STATUSES.TEMPORARY
            }, {
              $set: {
                ownerType: FileAsset.FILE_OWNER_TYPES.TASK,
                ownerId: racingOwnerId,
                status: FileAsset.FILE_STATUSES.ACTIVE
              }
            });
          }
          return FileAsset.findOneAndUpdate(filter, update, options).lean();
        }
      };
    }
  };
  const racingService = createTemporaryFileCleanupService({
    FileAssetModel: racingModel,
    storageRoot
  });
  const raceReport = await racingService.cleanupExpiredTemporaryFiles({
    now: NOW,
    maxAgeMs: 24 * 60 * 60 * 1000,
    apply: true
  });
  assert.equal(raceReport.claimed, 0);
  assert.equal(raceReport.skippedChanged, 1);
  assert.equal(raceReport.deleted, 0);
  const boundDuringScan = await FileAsset.findById(racing.file._id).lean();
  assert.equal(boundDuringScan.status, FileAsset.FILE_STATUSES.ACTIVE);
  assert.equal(String(boundDuringScan.ownerId), String(racingOwnerId));
  assert.ok(await fs.promises.stat(racing.storagePath));

  await FileAsset.deleteOne({ _id: activeClaim.file._id });
  await fs.promises.rm(activeClaim.storagePath, { force: true });
  const strandedClaim = await createStoredAsset({ ageHours: 48 });
  let injectedDeleteFailure = true;
  const deleteFailingModel = {
    find: (...args) => FileAsset.find(...args),
    updateOne: (...args) => FileAsset.updateOne(...args),
    findOneAndUpdate: (...args) => FileAsset.findOneAndUpdate(...args),
    deleteOne(filter) {
      if (
        injectedDeleteFailure &&
        String(filter._id) === String(strandedClaim.file._id) &&
        filter.status === FileAsset.FILE_STATUSES.PURGING
      ) {
        injectedDeleteFailure = false;
        return Promise.reject(new Error('Injected metadata delete failure'));
      }
      return FileAsset.deleteOne(filter);
    }
  };
  const failedDeleteReport = await createTemporaryFileCleanupService({
    FileAssetModel: deleteFailingModel,
    storageRoot
  }).cleanupExpiredTemporaryFiles({
    now: NOW,
    maxAgeMs: 24 * 60 * 60 * 1000,
    apply: true
  });
  assert.equal(failedDeleteReport.failed, 1);
  assert.equal(failedDeleteReport.deleted, 0);
  await assert.rejects(fs.promises.stat(strandedClaim.storagePath), { code: 'ENOENT' });
  const strandedMetadata = await FileAsset.findById(strandedClaim.file._id).lean();
  assert.equal(strandedMetadata.status, FileAsset.FILE_STATUSES.PURGING);
  assert.equal(strandedMetadata.cleanupStartedAt.toISOString(), NOW.toISOString());

  const recoveryReport = await createTemporaryFileCleanupService({
    storageRoot
  }).cleanupExpiredTemporaryFiles({
    now: new Date(NOW.getTime() + 16 * 60 * 1000),
    maxAgeMs: 24 * 60 * 60 * 1000,
    apply: true
  });
  assert.equal(recoveryReport.recoveredClaims, 1);
  assert.equal(recoveryReport.recoveredMetadataDeleted, 1);
  assert.equal(recoveryReport.recoveredToTemporary, 0);
  assert.equal(recoveryReport.recoveryFailed, 0);
  assert.equal(recoveryReport.failed, 0);
  assert.equal(await FileAsset.findById(strandedClaim.file._id), null);
});
