'use strict';

const fs = require('node:fs');
const mongoose = require('mongoose');
const FileAsset = require('../models/FileAsset');
const ImportException = require('../models/ImportException');
const ImportJob = require('../models/ImportJob');
const { AUDIT_ACTIONS, AUDIT_RESOURCE_TYPES } = require('../config/permissions');
const { createAuditService } = require('./auditService');
const { resolveStoragePath } = require('./fileStorageService');
const { runWithOptionalTransaction } = require('./transactionService');

const DEFAULT_PREVIEW_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CLEANUP_LIMIT = 25;
const IMPORT_OWNER_TYPES = Object.freeze([
  FileAsset.FILE_OWNER_TYPES.EQUIPMENT_IMPORT_SOURCE,
  FileAsset.FILE_OWNER_TYPES.EQUIPMENT_IMPORT_MEDIA
]);
const CLEANABLE_JOB_STATUSES = Object.freeze([
  ImportJob.IMPORT_JOB_STATUSES.CANCELLED,
  ImportJob.IMPORT_JOB_STATUSES.EXPIRED
]);

function cleanupErrorSummary(errors) {
  return errors.map(({ fileId, error }) => {
    const code = String(error?.code || error?.name || 'DELETE_FAILED').slice(0, 80);
    return `${fileId}:${code}`;
  }).join(', ').slice(0, 1000);
}

function createEquipmentImportStagingCleanupService({
  FileAssetModel = FileAsset,
  ImportExceptionModel = ImportException,
  ImportJobModel = ImportJob,
  auditService = createAuditService(),
  connection = mongoose.connection,
  storageRoot = process.env.UPLOAD_PATH,
  fsPromises = fs.promises
} = {}) {
  const resolvedStorageRoot = typeof storageRoot === 'string' && storageRoot.trim()
    ? require('node:path').resolve(storageRoot)
    : null;

  function requireStorageRoot() {
    if (!resolvedStorageRoot) throw new TypeError('Private equipment import storage is not configured');
    return resolvedStorageRoot;
  }

  async function execute(query, session) {
    if (session && typeof query.session === 'function') query.session(session);
    return query;
  }

  async function stagingFiles(jobId, teamId) {
    return FileAssetModel.find({
      teamId,
      ownerId: jobId,
      ownerType: { $in: IMPORT_OWNER_TYPES },
      status: FileAsset.FILE_STATUSES.DELETED
    }).select('_id storageKey ownerId ownerType').lean();
  }

  async function auditCleanup({ job, result, req = null, authContext = null }) {
    const input = {
      req,
      authContext,
      action: AUDIT_ACTIONS.FILE_DELETE,
      resourceType: AUDIT_RESOURCE_TYPES.IMPORT_JOB,
      resourceId: job._id,
      before: { stagingCleanupStatus: job.stagingCleanupStatus },
      after: {
        stagingCleanupStatus: result.status,
        attemptedFiles: result.attemptedFiles,
        deletedFiles: result.deletedFiles,
        failedFiles: result.failedFiles,
        attempt: result.attempt
      },
      reason: result.status === ImportJob.IMPORT_STAGING_CLEANUP_STATUSES.COMPLETE
        ? 'Equipment import staging bytes physically deleted'
        : 'Equipment import staging byte deletion requires retry',
      targetTeamId: job.teamId
    };
    if (authContext) return auditService.record(input);
    return auditService.recordSystem(input);
  }

  async function finalizeCleanup({ jobId, teamId, req = null, authContext = null }) {
    requireStorageRoot();
    const job = await ImportJobModel.findOne({
      _id: jobId,
      teamId,
      status: { $in: CLEANABLE_JOB_STATUSES }
    }).lean();
    if (!job) throw new TypeError('Only cancelled or expired equipment imports can be cleaned');

    const files = await stagingFiles(job._id, job.teamId);
    const errors = [];
    let deletedFiles = 0;
    for (const file of files) {
      try {
        if (!IMPORT_OWNER_TYPES.includes(file.ownerType) || String(file.ownerId) !== String(job._id)) {
          throw new TypeError('Staged file ownership changed before cleanup');
        }
        const storagePath = resolveStoragePath(requireStorageRoot(), file.storageKey);
        await fsPromises.rm(storagePath, { force: true });
        deletedFiles += 1;
      } catch (error) {
        errors.push({ fileId: String(file._id), error });
      }
    }

    const attemptedAt = new Date();
    const status = errors.length === 0
      ? ImportJob.IMPORT_STAGING_CLEANUP_STATUSES.COMPLETE
      : ImportJob.IMPORT_STAGING_CLEANUP_STATUSES.FAILED;
    const update = {
      $set: {
        stagingCleanupStatus: status,
        stagingCleanupLastAttemptAt: attemptedAt,
        stagingCleanupCompletedAt: errors.length === 0 ? attemptedAt : null,
        stagingCleanupLastError: errors.length === 0 ? null : cleanupErrorSummary(errors)
      },
      $inc: { stagingCleanupAttempts: 1 }
    };
    const updatedJob = await ImportJobModel.findOneAndUpdate({
      _id: job._id,
      teamId: job.teamId,
      status: { $in: CLEANABLE_JOB_STATUSES }
    }, update, { new: true, runValidators: true }).lean();
    if (!updatedJob) throw new TypeError('Equipment import changed during staging cleanup');

    const result = {
      status,
      attemptedFiles: files.length,
      deletedFiles,
      failedFiles: errors.length,
      attempt: updatedJob.stagingCleanupAttempts,
      lastError: updatedJob.stagingCleanupLastError || null
    };
    await auditCleanup({ job, result, req, authContext });
    return { job: updatedJob, cleanup: result };
  }

  async function expirePreview({ jobId, now = new Date() }) {
    const expired = await runWithOptionalTransaction(async (session) => {
      const job = await execute(ImportJobModel.findOne({
        _id: jobId,
        status: ImportJob.IMPORT_JOB_STATUSES.PREVIEW_READY
      }), session);
      if (!job) return null;
      job.status = ImportJob.IMPORT_JOB_STATUSES.EXPIRED;
      job.expiredAt = now;
      job.stagingCleanupStatus = ImportJob.IMPORT_STAGING_CLEANUP_STATUSES.PENDING;
      await FileAssetModel.updateMany({
        teamId: job.teamId,
        ownerId: job._id,
        ownerType: { $in: IMPORT_OWNER_TYPES },
        status: FileAsset.FILE_STATUSES.ACTIVE
      }, {
        $set: {
          status: FileAsset.FILE_STATUSES.DELETED,
          deletedAt: now,
          deletedBy: job.createdBy
        }
      }, { session: session || undefined });
      await ImportExceptionModel.updateMany({
        teamId: job.teamId,
        importJobId: job._id,
        status: ImportException.IMPORT_EXCEPTION_STATUSES.PENDING
      }, {
        $set: {
          customerDecision: ImportException.IMPORT_CUSTOMER_DECISIONS.SKIP_ROW,
          status: ImportException.IMPORT_EXCEPTION_STATUSES.SKIPPED,
          resolvedBy: job.createdBy,
          resolvedAt: now
        }
      }, { session: session || undefined });
      await auditService.recordSystem({
        action: AUDIT_ACTIONS.STATUS_CHANGE,
        resourceType: AUDIT_RESOURCE_TYPES.IMPORT_JOB,
        resourceId: job._id,
        before: { status: ImportJob.IMPORT_JOB_STATUSES.PREVIEW_READY },
        after: { status: ImportJob.IMPORT_JOB_STATUSES.EXPIRED },
        reason: 'Equipment import preview retention period elapsed',
        targetTeamId: job.teamId,
        session
      });
      await job.save({ session: session || undefined });
      return { _id: job._id, teamId: job.teamId };
    }, connection);
    if (!expired) return { expired: false };
    return { expired: true, ...(await finalizeCleanup({ jobId: expired._id, teamId: expired.teamId })) };
  }

  async function cleanupExpiredPreviews({
    now = new Date(),
    maxAgeMs = DEFAULT_PREVIEW_MAX_AGE_MS,
    limit = DEFAULT_CLEANUP_LIMIT
  } = {}) {
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('now must be a valid Date');
    if (!Number.isInteger(maxAgeMs) || maxAgeMs < 60 * 1000) {
      throw new TypeError('maxAgeMs must be at least one minute');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new TypeError('limit must be between 1 and 500');
    }
    const cutoff = new Date(now.getTime() - maxAgeMs);
    const jobs = await ImportJobModel.find({
      type: ImportJob.IMPORT_TYPES.EQUIPMENT_ASSET,
      status: ImportJob.IMPORT_JOB_STATUSES.PREVIEW_READY,
      createdAt: { $lt: cutoff }
    }).select('_id').sort({ createdAt: 1 }).limit(limit).lean();
    const results = [];
    for (const job of jobs) results.push(await expirePreview({ jobId: job._id, now }));
    return { cutoff, matched: jobs.length, results };
  }

  async function retryIncompleteCleanup({ limit = DEFAULT_CLEANUP_LIMIT } = {}) {
    const jobs = await ImportJobModel.find({
      type: ImportJob.IMPORT_TYPES.EQUIPMENT_ASSET,
      status: { $in: CLEANABLE_JOB_STATUSES },
      stagingCleanupStatus: {
        $in: [
          ImportJob.IMPORT_STAGING_CLEANUP_STATUSES.PENDING,
          ImportJob.IMPORT_STAGING_CLEANUP_STATUSES.FAILED
        ]
      }
    }).select('_id teamId').sort({ stagingCleanupLastAttemptAt: 1, updatedAt: 1 }).limit(limit).lean();
    const results = [];
    for (const job of jobs) {
      results.push(await finalizeCleanup({ jobId: job._id, teamId: job.teamId }));
    }
    return { matched: jobs.length, results };
  }

  return Object.freeze({ cleanupExpiredPreviews, expirePreview, finalizeCleanup, retryIncompleteCleanup });
}

module.exports = {
  CLEANABLE_JOB_STATUSES,
  DEFAULT_CLEANUP_LIMIT,
  DEFAULT_PREVIEW_MAX_AGE_MS,
  IMPORT_OWNER_TYPES,
  createEquipmentImportStagingCleanupService
};
