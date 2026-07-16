'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const BACKUP_MANIFEST_FORMAT = 'task-distribution-v2-migration-backup/v1';
const REQUIRED_BACKUP_COLLECTIONS = Object.freeze([
  'users',
  'tasks',
  'taskreviews',
  'extensionrequests',
  'messages',
  'fileassets'
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

class BackupManifestError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'BackupManifestError';
    this.code = code;
    this.details = details;
  }
}

function failure(code, message, details) {
  throw new BackupManifestError(code, message, details);
}

async function hashFile(filePath, fsImpl = fs) {
  const digest = createHash('sha256');
  const stream = fsImpl.createReadStream(filePath);
  for await (const chunk of stream) digest.update(chunk);
  return digest.digest('hex');
}

function resolveContainedFile(manifestDirectory, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    failure('BACKUP_FILE_PATH_INVALID', 'Each backup file must have a relative path');
  }

  const resolved = path.resolve(manifestDirectory, relativePath);
  const relative = path.relative(manifestDirectory, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    failure(
      'BACKUP_FILE_OUTSIDE_MANIFEST_DIRECTORY',
      'Backup files must be stored under the manifest directory',
      { file: relativePath }
    );
  }
  return resolved;
}

function parseManifest(raw, manifestPath) {
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    failure('BACKUP_MANIFEST_JSON_INVALID', 'Backup manifest is not valid JSON', {
      manifestPath,
      cause: error.message
    });
  }

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    failure('BACKUP_MANIFEST_INVALID', 'Backup manifest must be a JSON object');
  }
  return manifest;
}

async function verifyBackupManifest({
  manifestPath,
  databaseName,
  fsImpl = fs
} = {}) {
  if (typeof manifestPath !== 'string' || !manifestPath.trim()) {
    failure('BACKUP_MANIFEST_REQUIRED', 'A backup manifest path is required');
  }
  if (typeof databaseName !== 'string' || !databaseName) {
    failure('BACKUP_DATABASE_REQUIRED', 'The exact database name is required');
  }

  const resolvedManifestPath = path.resolve(manifestPath);
  let stats;
  try {
    stats = await fsImpl.promises.stat(resolvedManifestPath);
  } catch (error) {
    failure('BACKUP_MANIFEST_NOT_FOUND', 'Backup manifest was not found', {
      manifestPath: resolvedManifestPath,
      cause: error.code
    });
  }
  if (!stats.isFile()) {
    failure('BACKUP_MANIFEST_NOT_FILE', 'Backup manifest path must be a regular file');
  }

  const raw = await fsImpl.promises.readFile(resolvedManifestPath, 'utf8');
  const manifestSha256 = createHash('sha256').update(raw).digest('hex');
  const manifest = parseManifest(raw, resolvedManifestPath);

  if (manifest.format !== BACKUP_MANIFEST_FORMAT) {
    failure(
      'BACKUP_MANIFEST_FORMAT_UNSUPPORTED',
      `Backup manifest format must be ${BACKUP_MANIFEST_FORMAT}`
    );
  }
  if (manifest.databaseName !== databaseName) {
    failure(
      'BACKUP_DATABASE_MISMATCH',
      'Backup manifest databaseName does not exactly match the connected database',
      { expected: databaseName, actual: manifest.databaseName }
    );
  }
  if (
    typeof manifest.completedAt !== 'string' ||
    !Number.isFinite(Date.parse(manifest.completedAt))
  ) {
    failure('BACKUP_COMPLETION_INVALID', 'Backup manifest requires a valid completedAt value');
  }
  if (!Array.isArray(manifest.collections)) {
    failure('BACKUP_COLLECTIONS_INVALID', 'Backup manifest collections must be an array');
  }

  const entries = new Map();
  for (const entry of manifest.collections) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      failure('BACKUP_COLLECTION_ENTRY_INVALID', 'Backup collection entries must be objects');
    }
    if (!REQUIRED_BACKUP_COLLECTIONS.includes(entry.name)) {
      continue;
    }
    if (entries.has(entry.name)) {
      failure('BACKUP_COLLECTION_DUPLICATE', 'Backup collection appears more than once', {
        collection: entry.name
      });
    }
    if (!Number.isInteger(entry.documentCount) || entry.documentCount < 0) {
      failure('BACKUP_DOCUMENT_COUNT_INVALID', 'Backup documentCount must be a non-negative integer', {
        collection: entry.name
      });
    }
    if (!Number.isInteger(entry.bytes) || entry.bytes < 0) {
      failure('BACKUP_FILE_SIZE_INVALID', 'Backup bytes must be a non-negative integer', {
        collection: entry.name
      });
    }
    if (typeof entry.sha256 !== 'string' || !SHA256_PATTERN.test(entry.sha256)) {
      failure('BACKUP_FILE_HASH_INVALID', 'Backup sha256 must be a lowercase SHA-256 digest', {
        collection: entry.name
      });
    }
    entries.set(entry.name, entry);
  }

  const missingCollections = REQUIRED_BACKUP_COLLECTIONS.filter((name) => !entries.has(name));
  if (missingCollections.length > 0) {
    failure('BACKUP_COLLECTION_MISSING', 'Backup manifest is missing required collections', {
      collections: missingCollections
    });
  }

  const manifestDirectory = path.dirname(resolvedManifestPath);
  const verifiedCollections = {};
  for (const name of REQUIRED_BACKUP_COLLECTIONS) {
    const entry = entries.get(name);
    const backupFile = resolveContainedFile(manifestDirectory, entry.file);
    let fileStats;
    try {
      fileStats = await fsImpl.promises.stat(backupFile);
    } catch (error) {
      failure('BACKUP_FILE_NOT_FOUND', 'A declared backup file was not found', {
        collection: name,
        file: entry.file,
        cause: error.code
      });
    }
    if (!fileStats.isFile()) {
      failure('BACKUP_FILE_NOT_REGULAR', 'A declared backup path is not a regular file', {
        collection: name,
        file: entry.file
      });
    }
    if (fileStats.size !== entry.bytes) {
      failure('BACKUP_FILE_SIZE_MISMATCH', 'Backup file size does not match its manifest', {
        collection: name,
        expected: entry.bytes,
        actual: fileStats.size
      });
    }
    const actualSha256 = await hashFile(backupFile, fsImpl);
    if (actualSha256 !== entry.sha256) {
      failure('BACKUP_FILE_HASH_MISMATCH', 'Backup file hash does not match its manifest', {
        collection: name,
        expected: entry.sha256,
        actual: actualSha256
      });
    }
    verifiedCollections[name] = Object.freeze({
      documentCount: entry.documentCount,
      file: path.relative(manifestDirectory, backupFile).replaceAll('\\', '/'),
      bytes: entry.bytes,
      sha256: entry.sha256
    });
  }

  return Object.freeze({
    format: manifest.format,
    databaseName: manifest.databaseName,
    completedAt: new Date(manifest.completedAt).toISOString(),
    manifestPath: resolvedManifestPath,
    manifestSha256,
    collections: Object.freeze(verifiedCollections)
  });
}

module.exports = {
  BACKUP_MANIFEST_FORMAT,
  BackupManifestError,
  REQUIRED_BACKUP_COLLECTIONS,
  hashFile,
  verifyBackupManifest
};
