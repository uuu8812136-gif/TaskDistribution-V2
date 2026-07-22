'use strict';

const fs = require('node:fs');
const path = require('node:path');
const FileAsset = require('../models/FileAsset');
const { resolveStoragePath } = require('./fileStorageService');

const DEFAULT_TEMPORARY_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TEMPORARY_FILE_CLEANUP_LIMIT = 100;
const DEFAULT_TEMPORARY_FILE_CLAIM_TIMEOUT_MS = 15 * 60 * 1000;

function validateCleanupOptions({ now, maxAgeMs, claimTimeoutMs, limit }) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 60 * 1000) {
    throw new TypeError('maxAgeMs must be a safe integer of at least one minute');
  }
  if (!Number.isSafeInteger(claimTimeoutMs) || claimTimeoutMs < 60 * 1000) {
    throw new TypeError('claimTimeoutMs must be a safe integer of at least one minute');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new TypeError('limit must be between 1 and 1000');
  }
}

function cleanupFailure(fileId, error) {
  return {
    fileId: String(fileId),
    code: String(error?.code || error?.name || 'TEMPORARY_FILE_CLEANUP_FAILED').slice(0, 80),
    message: String(error?.message || 'Temporary file cleanup failed').slice(0, 300)
  };
}

function createTemporaryFileCleanupService({
  FileAssetModel = FileAsset,
  storageRoot = process.env.UPLOAD_PATH,
  fsPromises = fs.promises
} = {}) {
  const resolvedStorageRoot = typeof storageRoot === 'string' && storageRoot.trim()
    ? path.resolve(storageRoot)
    : null;

  function requireStorageRoot() {
    if (!resolvedStorageRoot) throw new TypeError('Private file storage root is required');
    return resolvedStorageRoot;
  }

  async function recoverAbandonedClaims({
    now,
    claimTimeoutMs,
    limit = DEFAULT_TEMPORARY_FILE_CLEANUP_LIMIT
  }) {
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new TypeError('now must be a valid Date');
    }
    if (!Number.isSafeInteger(claimTimeoutMs) || claimTimeoutMs < 60 * 1000) {
      throw new TypeError('claimTimeoutMs must be a safe integer of at least one minute');
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new TypeError('limit must be between 1 and 1000');
    }
    const claimCutoff = new Date(now.getTime() - claimTimeoutMs);
    const claims = await FileAssetModel.find({
      ownerType: FileAsset.FILE_OWNER_TYPES.TEMPORARY,
      ownerId: null,
      status: FileAsset.FILE_STATUSES.PURGING,
      cleanupStartedAt: { $lt: claimCutoff }
    })
      .select('_id storageKey size cleanupStartedAt')
      .sort({ cleanupStartedAt: 1, _id: 1 })
      .limit(limit)
      .lean();
    const report = {
      matched: claims.length,
      releasedToTemporary: 0,
      metadataDeleted: 0,
      skippedChanged: 0,
      failed: 0,
      failures: []
    };

    for (const claim of claims) {
      const claimFilter = {
        _id: claim._id,
        ownerType: FileAsset.FILE_OWNER_TYPES.TEMPORARY,
        ownerId: null,
        status: FileAsset.FILE_STATUSES.PURGING,
        cleanupStartedAt: claim.cleanupStartedAt
      };
      try {
        const storagePath = resolveStoragePath(requireStorageRoot(), claim.storageKey);
        let storageExists = true;
        try {
          const stat = await fsPromises.stat(storagePath);
          if (!stat.isFile()) throw new Error('Cleanup claim storage path is not a file');
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
          storageExists = false;
        }

        if (storageExists) {
          const released = await FileAssetModel.updateOne(claimFilter, {
            $set: {
              status: FileAsset.FILE_STATUSES.TEMPORARY,
              cleanupStartedAt: null
            },
            $inc: { __v: 1 }
          }, { runValidators: true });
          if (released.modifiedCount === 1) report.releasedToTemporary += 1;
          else report.skippedChanged += 1;
          continue;
        }

        const removed = await FileAssetModel.deleteOne(claimFilter);
        if (removed.deletedCount === 1) report.metadataDeleted += 1;
        else report.skippedChanged += 1;
      } catch (error) {
        report.failed += 1;
        report.failures.push(cleanupFailure(claim._id, error));
      }
    }
    return report;
  }

  async function cleanupExpiredTemporaryFiles({
    now = new Date(),
    maxAgeMs = DEFAULT_TEMPORARY_FILE_MAX_AGE_MS,
    claimTimeoutMs = DEFAULT_TEMPORARY_FILE_CLAIM_TIMEOUT_MS,
    limit = DEFAULT_TEMPORARY_FILE_CLEANUP_LIMIT,
    apply = false
  } = {}) {
    validateCleanupOptions({ now, maxAgeMs, claimTimeoutMs, limit });
    if (typeof apply !== 'boolean') throw new TypeError('apply must be a boolean');
    requireStorageRoot();

    const cutoff = new Date(now.getTime() - maxAgeMs);
    const recovery = apply
      ? await recoverAbandonedClaims({ now, claimTimeoutMs, limit })
      : {
          matched: 0,
          releasedToTemporary: 0,
          metadataDeleted: 0,
          skippedChanged: 0,
          failed: 0,
          failures: []
        };
    const candidates = await FileAssetModel.find({
      ownerType: FileAsset.FILE_OWNER_TYPES.TEMPORARY,
      ownerId: null,
      status: FileAsset.FILE_STATUSES.TEMPORARY,
      createdAt: { $lt: cutoff }
    })
      .select('_id storageKey size teamId uploaderId createdAt')
      .sort({ createdAt: 1, _id: 1 })
      .limit(limit)
      .lean();

    const report = {
      mode: apply ? 'apply' : 'dry-run',
      cutoff,
      matched: candidates.length,
      matchedBytes: candidates.reduce((sum, file) => sum + Number(file.size || 0), 0),
      recoveredClaims: recovery.matched,
      recoveredToTemporary: recovery.releasedToTemporary,
      recoveredMetadataDeleted: recovery.metadataDeleted,
      recoverySkippedChanged: recovery.skippedChanged,
      recoveryFailed: recovery.failed,
      claimed: 0,
      skippedChanged: 0,
      deleted: 0,
      deletedBytes: 0,
      failed: recovery.failed,
      failures: [...recovery.failures]
    };
    if (!apply) return report;

    for (const candidate of candidates) {
      const claimed = await FileAssetModel.findOneAndUpdate({
        _id: candidate._id,
        ownerType: FileAsset.FILE_OWNER_TYPES.TEMPORARY,
        ownerId: null,
        status: FileAsset.FILE_STATUSES.TEMPORARY,
        createdAt: { $lt: cutoff }
      }, {
        $set: {
          status: FileAsset.FILE_STATUSES.PURGING,
          cleanupStartedAt: now
        },
        $inc: { __v: 1 }
      }, { new: true, runValidators: true }).lean();
      if (!claimed) {
        report.skippedChanged += 1;
        continue;
      }

      report.claimed += 1;
      let bytesRemoved = false;
      try {
        const storagePath = resolveStoragePath(requireStorageRoot(), claimed.storageKey);
        await fsPromises.rm(storagePath, { force: true });
        bytesRemoved = true;
        const removed = await FileAssetModel.deleteOne({
          _id: claimed._id,
          ownerType: FileAsset.FILE_OWNER_TYPES.TEMPORARY,
          ownerId: null,
          status: FileAsset.FILE_STATUSES.PURGING,
          cleanupStartedAt: now
        });
        if (removed.deletedCount !== 1) {
          throw new Error('Cleanup claim changed before metadata deletion');
        }
        report.deleted += 1;
        report.deletedBytes += Number(claimed.size || 0);
      } catch (error) {
        if (!bytesRemoved) {
          await FileAssetModel.updateOne({
            _id: claimed._id,
            ownerType: FileAsset.FILE_OWNER_TYPES.TEMPORARY,
            ownerId: null,
            status: FileAsset.FILE_STATUSES.PURGING,
            cleanupStartedAt: now
          }, {
            $set: {
              status: FileAsset.FILE_STATUSES.TEMPORARY,
              cleanupStartedAt: null
            },
            $inc: { __v: 1 }
          }, { runValidators: true }).catch(() => {});
        }
        report.failed += 1;
        report.failures.push(cleanupFailure(claimed._id, error));
      }
    }
    return report;
  }

  return Object.freeze({ cleanupExpiredTemporaryFiles, recoverAbandonedClaims });
}

module.exports = {
  DEFAULT_TEMPORARY_FILE_CLAIM_TIMEOUT_MS,
  DEFAULT_TEMPORARY_FILE_CLEANUP_LIMIT,
  DEFAULT_TEMPORARY_FILE_MAX_AGE_MS,
  createTemporaryFileCleanupService
};
