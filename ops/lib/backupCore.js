'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');

const BACKUP_FORMAT = 'task-distribution-v2-backup/v1';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RESTORE_DATABASE_PATTERN = /(?:_restore_test|_v2_test)$/i;
const BACKUP_ID_PATTERN = /^backup-\d{8}T\d{6}Z-[a-f0-9]{8}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

class OperationsError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'OperationsError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new OperationsError(code, message, details);
}

function pathApi(platform = process.platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function isContained(parent, child, { allowSame = false, platform = process.platform } = {}) {
  const api = pathApi(platform);
  const resolvedParent = api.resolve(parent);
  const resolvedChild = api.resolve(child);
  const relative = api.relative(resolvedParent, resolvedChild);
  if (!relative) return allowSame;
  return relative !== '..' && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative);
}

function assertBackupPathPolicy({
  backupRoot,
  backupVolumeRoot,
  uploadRoot,
  platform = process.platform,
  systemDrive = process.env.SystemDrive || 'C:'
} = {}) {
  const api = pathApi(platform);
  for (const [name, value] of Object.entries({ backupRoot, backupVolumeRoot, uploadRoot })) {
    if (typeof value !== 'string' || !value.trim() || !api.isAbsolute(value)) {
      fail('BACKUP_PATH_NOT_ABSOLUTE', `${name} must be an explicitly configured absolute path`, {
        name
      });
    }
  }

  const resolved = Object.freeze({
    backupRoot: api.resolve(backupRoot),
    backupVolumeRoot: api.resolve(backupVolumeRoot),
    uploadRoot: api.resolve(uploadRoot)
  });

  if (!isContained(resolved.backupVolumeRoot, resolved.backupRoot, {
    allowSame: true,
    platform
  })) {
    fail('BACKUP_ROOT_OUTSIDE_VOLUME', 'BACKUP_ROOT must be inside BACKUP_VOLUME_ROOT');
  }

  if (
    isContained(resolved.uploadRoot, resolved.backupRoot, { allowSame: true, platform }) ||
    isContained(resolved.backupRoot, resolved.uploadRoot, { allowSame: true, platform })
  ) {
    fail('BACKUP_UPLOAD_PATH_OVERLAP', 'BACKUP_ROOT and UPLOAD_PATH must not overlap');
  }

  if (platform === 'win32') {
    const backupDrive = api.parse(resolved.backupVolumeRoot).root.replace(/[\\/]$/, '').toLowerCase();
    const normalizedSystemDrive = String(systemDrive).replace(/[\\/]$/, '').toLowerCase();
    if (!backupDrive || backupDrive === normalizedSystemDrive) {
      fail('BACKUP_SYSTEM_VOLUME_FORBIDDEN', 'Backups must be stored on a non-system drive', {
        backupDrive,
        systemDrive: normalizedSystemDrive
      });
    }
  } else if (resolved.backupVolumeRoot === '/') {
    fail(
      'BACKUP_SYSTEM_VOLUME_FORBIDDEN',
      'BACKUP_VOLUME_ROOT must identify a dedicated non-root mount point'
    );
  }

  return resolved;
}

async function ensureSafeBackupRoot(options, fsImpl = fs) {
  const resolved = assertBackupPathPolicy(options);
  await fsImpl.promises.mkdir(resolved.backupVolumeRoot, { recursive: true });
  await fsImpl.promises.mkdir(resolved.backupRoot, { recursive: true });

  const [realVolume, realBackup, realUploads] = await Promise.all([
    fsImpl.promises.realpath(resolved.backupVolumeRoot),
    fsImpl.promises.realpath(resolved.backupRoot),
    fsImpl.promises.realpath(resolved.uploadRoot)
  ]);
  assertBackupPathPolicy({
    backupRoot: realBackup,
    backupVolumeRoot: realVolume,
    uploadRoot: realUploads,
    platform: options.platform,
    systemDrive: options.systemDrive
  });

  if (process.platform !== 'win32') {
    const [rootStats, volumeStats] = await Promise.all([
      fsImpl.promises.stat('/'),
      fsImpl.promises.stat(realVolume)
    ]);
    if (rootStats.dev === volumeStats.dev) {
      fail(
        'BACKUP_DEDICATED_MOUNT_REQUIRED',
        'BACKUP_VOLUME_ROOT must be mounted on a different filesystem from /'
      );
    }
  }

  return Object.freeze({ backupRoot: realBackup, backupVolumeRoot: realVolume, uploadRoot: realUploads });
}

async function hashFile(filePath, fsImpl = fs) {
  const digest = createHash('sha256');
  const stream = fsImpl.createReadStream(filePath);
  for await (const chunk of stream) digest.update(chunk);
  return digest.digest('hex');
}

async function writeJsonAtomic(filePath, value, fsImpl = fs) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  await fsImpl.promises.writeFile(temporaryPath, serialized, { mode: 0o600, flag: 'wx' });
  try {
    await fsImpl.promises.rename(temporaryPath, filePath);
  } catch (error) {
    await fsImpl.promises.rm(temporaryPath, { force: true });
    throw error;
  }
  return serialized;
}

async function appendOperationLog(logPath, event, fsImpl = fs) {
  const record = {
    at: new Date().toISOString(),
    ...event
  };
  await fsImpl.promises.mkdir(path.dirname(logPath), { recursive: true });
  await fsImpl.promises.appendFile(logPath, `${JSON.stringify(record)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  return record;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function acquireExclusiveLock(lockPath, {
  fsImpl = fs,
  now = () => new Date(),
  pid = process.pid,
  staleMs = 6 * 60 * 60 * 1000,
  isProcessAlive = processIsAlive
} = {}) {
  const token = randomUUID();
  const tryCreate = async () => {
    const handle = await fsImpl.promises.open(lockPath, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ token, pid, createdAt: now().toISOString() })}\n`);
    } finally {
      await handle.close();
    }
  };

  try {
    await tryCreate();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let existing = null;
    let stats = null;
    try {
      [existing, stats] = await Promise.all([
        fsImpl.promises.readFile(lockPath, 'utf8').then(JSON.parse),
        fsImpl.promises.stat(lockPath)
      ]);
    } catch {
      fail('BACKUP_LOCK_CORRUPT', 'Backup lock exists but cannot be validated', { lockPath });
    }
    const ageMs = now().getTime() - stats.mtimeMs;
    if (ageMs <= staleMs || isProcessAlive(existing.pid)) {
      fail('BACKUP_ALREADY_RUNNING', 'Another backup or retention process holds the lock', {
        lockPath,
        pid: existing.pid,
        createdAt: existing.createdAt
      });
    }
    const stalePath = `${lockPath}.stale-${Date.now()}-${randomUUID()}`;
    await fsImpl.promises.rename(lockPath, stalePath);
    await fsImpl.promises.rm(stalePath, { force: true });
    await tryCreate();
  }

  let released = false;
  return Object.freeze({
    lockPath,
    token,
    async release() {
      if (released) return;
      released = true;
      let existing;
      try {
        existing = JSON.parse(await fsImpl.promises.readFile(lockPath, 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
      if (existing.token !== token) {
        fail('BACKUP_LOCK_OWNERSHIP_LOST', 'Backup lock ownership changed before release');
      }
      await fsImpl.promises.rm(lockPath, { force: true });
    }
  });
}

function trustedToolBasenames(toolName, platform = process.platform) {
  return platform === 'win32' ? [`${toolName}.exe`] : [toolName];
}

async function resolveTrustedExecutable(filePath, {
  toolName,
  expectedSha256 = '',
  platform = process.platform,
  fsImpl = fs
} = {}) {
  const api = pathApi(platform);
  if (typeof filePath !== 'string' || !api.isAbsolute(filePath)) {
    fail('MONGO_TOOL_PATH_NOT_ABSOLUTE', `${toolName} path must be absolute`);
  }
  const realPath = await fsImpl.promises.realpath(filePath);
  const stats = await fsImpl.promises.stat(realPath);
  if (!stats.isFile()) fail('MONGO_TOOL_NOT_FILE', `${toolName} path must be a regular file`);
  const allowedNames = trustedToolBasenames(toolName, platform);
  if (!allowedNames.includes(api.basename(realPath).toLowerCase())) {
    fail('MONGO_TOOL_NAME_INVALID', `${toolName} executable has an unexpected filename`, {
      allowedNames
    });
  }
  if (expectedSha256) {
    const normalized = expectedSha256.toLowerCase();
    if (!SHA256_PATTERN.test(normalized)) {
      fail('MONGO_TOOL_HASH_INVALID', `${toolName} expected SHA256 is invalid`);
    }
    const actual = await hashFile(realPath, fsImpl);
    if (actual !== normalized) {
      fail('MONGO_TOOL_HASH_MISMATCH', `${toolName} executable SHA256 does not match configuration`, {
        expected: normalized,
        actual
      });
    }
  }
  return realPath;
}

function parseMongoUri(uri) {
  if (typeof uri !== 'string' || !/^mongodb(?:\+srv)?:\/\//i.test(uri)) {
    fail('MONGODB_URI_INVALID', 'MONGODB_URI must be a valid MongoDB connection URI');
  }
  const schemeEnd = uri.indexOf('://') + 3;
  const pathStart = uri.indexOf('/', schemeEnd);
  if (pathStart < 0) fail('MONGODB_DATABASE_REQUIRED', 'MONGODB_URI must include a database name');
  const authority = uri.slice(schemeEnd, pathStart).split('@').at(-1);
  const hosts = authority.split(',').map((entry) => {
    const value = entry.trim();
    if (value.startsWith('[')) return value.slice(1, value.indexOf(']')).toLowerCase();
    return value.split(':')[0].toLowerCase();
  });
  const databaseName = decodeURIComponent(uri.slice(pathStart + 1).split(/[?/#]/, 1)[0]);
  if (!databaseName || !/^[A-Za-z0-9_.-]+$/.test(databaseName)) {
    fail('MONGODB_DATABASE_INVALID', 'MONGODB_URI database name is missing or unsafe');
  }
  return Object.freeze({
    databaseName,
    hosts: Object.freeze(hosts),
    isSrv: /^mongodb\+srv:/i.test(uri),
    loopbackOnly: !/^mongodb\+srv:/i.test(uri) && hosts.every((host) => LOOPBACK_HOSTS.has(host))
  });
}

function mongoServerUri(uri) {
  parseMongoUri(uri);
  const schemeEnd = uri.indexOf('://') + 3;
  const pathStart = uri.indexOf('/', schemeEnd);
  const queryStart = uri.indexOf('?', pathStart);
  const fragmentStart = uri.indexOf('#', pathStart);
  const suffixStart = [queryStart, fragmentStart]
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  const suffix = suffixStart === undefined ? '' : uri.slice(suffixStart);
  return `${uri.slice(0, pathStart + 1)}${suffix}`;
}

function assertMongoBackupScope(uri, { allowRemote = false } = {}) {
  const parsed = parseMongoUri(uri);
  if (!parsed.loopbackOnly && allowRemote !== true) {
    fail(
      'REMOTE_BACKUP_NOT_AUTHORIZED',
      'Remote MongoDB backup requires BACKUP_ALLOW_REMOTE=true in the protected operations environment'
    );
  }
  return parsed;
}

function assertRestoreTarget({ uri, sourceDatabase, targetDatabase }) {
  const parsed = parseMongoUri(uri);
  if (!parsed.loopbackOnly) {
    fail('RESTORE_LOOPBACK_REQUIRED', 'Restore verification only permits loopback MongoDB targets');
  }
  if (typeof targetDatabase !== 'string' || !RESTORE_DATABASE_PATTERN.test(targetDatabase)) {
    fail(
      'RESTORE_DATABASE_NAME_FORBIDDEN',
      'Restore verification database must end with _restore_test or _v2_test'
    );
  }
  if (targetDatabase === sourceDatabase || parsed.databaseName === sourceDatabase) {
    fail('RESTORE_SOURCE_OVERWRITE_FORBIDDEN', 'Restore verification cannot target the source database');
  }
  if (parsed.databaseName !== targetDatabase) {
    fail(
      'RESTORE_TARGET_URI_MISMATCH',
      'RESTORE_MONGODB_URI database must match RESTORE_DATABASE',
      { uriDatabase: parsed.databaseName, targetDatabase }
    );
  }
  return Object.freeze({ ...parsed, targetDatabase });
}

function buildMongoDumpArgs({ configPath, outputDirectory, useOplog = false }) {
  const args = [
    '--config', configPath,
    '--out', outputDirectory,
    '--numParallelCollections', '1'
  ];
  if (useOplog) args.push('--oplog');
  return args;
}

function buildMongoRestoreArgs({ configPath, dumpDirectory, sourceDatabase, targetDatabase }) {
  return [
    '--config', configPath,
    '--dir', dumpDirectory,
    '--nsInclude', `${sourceDatabase}.*`,
    '--nsFrom', `${sourceDatabase}.*`,
    '--nsTo', `${targetDatabase}.*`,
    '--numParallelCollections', '1',
    '--stopOnError'
  ];
}

async function writeMongoToolConfig(configPath, uri, fsImpl = fs) {
  const contents = `uri: ${JSON.stringify(uri)}\n`;
  await fsImpl.promises.writeFile(configPath, contents, { mode: 0o600, flag: 'wx' });
  await fsImpl.promises.chmod(configPath, 0o600).catch(() => {});
}

function runProcess(executable, args, {
  spawnImpl = spawn,
  cwd,
  env = process.env,
  maxOutputBytes = 1024 * 1024
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(executable, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const collect = (current, chunk) => (current + chunk.toString('utf8')).slice(-maxOutputBytes);
    child.stdout?.on('data', (chunk) => { stdout = collect(stdout, chunk); });
    child.stderr?.on('data', (chunk) => { stderr = collect(stderr, chunk); });
    child.once('error', (error) => reject(error));
    child.once('close', (code, signal) => {
      if (code === 0) return resolve({ code, signal, stdout, stderr });
      return reject(new OperationsError(
        'MONGO_TOOL_FAILED',
        `${path.basename(executable)} exited unsuccessfully`,
        { code, signal, stderr: stderr.slice(-4000) }
      ));
    });
  });
}

function safeRelativePath(root, candidate) {
  const resolved = path.resolve(root, candidate);
  const relative = path.relative(root, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail('BACKUP_FILE_PATH_ESCAPE', 'Backup file path resolves outside its root', { candidate });
  }
  return Object.freeze({ resolved, relative: relative.replaceAll('\\', '/') });
}

async function listFilesRecursive(root, fsImpl = fs) {
  const output = [];
  async function visit(directory) {
    const entries = await fsImpl.promises.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        fail('BACKUP_SOURCE_LINK_FORBIDDEN', 'Symbolic links and junctions are forbidden in backup data', {
          path: fullPath
        });
      }
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile()) output.push(fullPath);
      else fail('BACKUP_SOURCE_TYPE_FORBIDDEN', 'Only regular files and directories can be backed up');
    }
  }
  await visit(root);
  return output;
}

async function copyUploadsStable(sourceRoot, destinationRoot, fsImpl = fs) {
  await fsImpl.promises.mkdir(destinationRoot, { recursive: false });
  const files = await listFilesRecursive(sourceRoot, fsImpl);
  const copied = [];
  for (const sourcePath of files) {
    const sourceEntry = safeRelativePath(sourceRoot, sourcePath);
    const destinationPath = path.join(destinationRoot, sourceEntry.relative);
    await fsImpl.promises.mkdir(path.dirname(destinationPath), { recursive: true });
    const before = await fsImpl.promises.stat(sourcePath);
    if (!before.isFile()) fail('UPLOAD_SOURCE_NOT_FILE', 'Upload source changed during backup');
    await fsImpl.promises.copyFile(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
    const [after, sourceSha256, destinationSha256] = await Promise.all([
      fsImpl.promises.stat(sourcePath),
      hashFile(sourcePath, fsImpl),
      hashFile(destinationPath, fsImpl)
    ]);
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      sourceSha256 !== destinationSha256
    ) {
      fail('UPLOAD_CHANGED_DURING_BACKUP', 'An upload changed while it was being copied', {
        file: sourceEntry.relative
      });
    }
    copied.push({ file: sourceEntry.relative, bytes: after.size, sha256: destinationSha256 });
  }
  return copied;
}

async function forEachBsonDocument(filePath, visitor, fsImpl = fs) {
  const handle = await fsImpl.promises.open(filePath, 'r');
  let position = 0;
  let count = 0;
  try {
    const stats = await handle.stat();
    while (position < stats.size) {
      const lengthBuffer = Buffer.allocUnsafe(4);
      const lengthRead = await handle.read(lengthBuffer, 0, 4, position);
      if (lengthRead.bytesRead !== 4) fail('BSON_TRUNCATED', 'BSON backup ended inside a length header');
      const documentLength = lengthBuffer.readInt32LE(0);
      if (documentLength < 5 || position + documentLength > stats.size) {
        fail('BSON_LENGTH_INVALID', 'BSON backup contains an invalid document length', {
          filePath,
          position,
          documentLength
        });
      }
      if (visitor) {
        const buffer = Buffer.allocUnsafe(documentLength);
        const result = await handle.read(buffer, 0, documentLength, position);
        if (result.bytesRead !== documentLength) fail('BSON_TRUNCATED', 'BSON document is truncated');
        await visitor(buffer, count);
      }
      position += documentLength;
      count += 1;
    }
  } finally {
    await handle.close();
  }
  return count;
}

async function databaseCollectionMetadata(databaseDumpDirectory, fsImpl = fs) {
  const bsonFiles = (await listFilesRecursive(databaseDumpDirectory, fsImpl))
    .filter((filePath) => filePath.toLowerCase().endsWith('.bson'));
  const collections = [];
  for (const filePath of bsonFiles) {
    const relative = path.relative(databaseDumpDirectory, filePath).replaceAll('\\', '/');
    const name = relative.replace(/\.bson$/i, '');
    const stats = await fsImpl.promises.stat(filePath);
    collections.push({
      name,
      file: relative,
      documentCount: await forEachBsonDocument(filePath, null, fsImpl),
      bytes: stats.size,
      sha256: await hashFile(filePath, fsImpl)
    });
  }
  collections.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  return collections;
}

function loadBsonModule() {
  try {
    return require('bson');
  } catch {
    return require('../../app/node_modules/bson');
  }
}

async function verifyFileAssetReferences({ fileAssetsBsonPath, uploadBackupRoot, fsImpl = fs }) {
  let BSON;
  try {
    BSON = loadBsonModule();
  } catch (error) {
    fail('BSON_MODULE_UNAVAILABLE', 'The installed app dependencies must include bson', {
      cause: error.message
    });
  }
  let referenced = 0;
  let verified = 0;
  const failures = [];
  await forEachBsonDocument(fileAssetsBsonPath, async (buffer) => {
    const record = BSON.deserialize(buffer, { promoteBuffers: true });
    if (record.status === 'DELETED') return;
    referenced += 1;
    if (typeof record.storageKey !== 'string') {
      failures.push({ id: String(record._id || ''), reason: 'storageKey missing' });
      return;
    }
    let contained;
    try {
      contained = safeRelativePath(uploadBackupRoot, record.storageKey);
    } catch (error) {
      failures.push({ id: String(record._id || ''), reason: error.code });
      return;
    }
    try {
      const stats = await fsImpl.promises.stat(contained.resolved);
      const actualSha256 = await hashFile(contained.resolved, fsImpl);
      if (!stats.isFile() || stats.size !== record.size || actualSha256 !== record.sha256) {
        failures.push({
          id: String(record._id || ''),
          storageKey: record.storageKey,
          reason: 'size or SHA256 mismatch'
        });
        return;
      }
      verified += 1;
    } catch (error) {
      failures.push({
        id: String(record._id || ''),
        storageKey: record.storageKey,
        reason: error.code || error.message
      });
    }
  }, fsImpl);
  if (failures.length > 0) {
    fail(
      'FILE_ASSET_BACKUP_INCONSISTENT',
      'Database FileAsset records do not match the upload backup',
      { referenced, verified, failures: failures.slice(0, 25) }
    );
  }
  return Object.freeze({ referenced, verified });
}

async function buildFileEntries(backupDirectory, fsImpl = fs) {
  const entries = [];
  for (const filePath of await listFilesRecursive(backupDirectory, fsImpl)) {
    const relative = path.relative(backupDirectory, filePath).replaceAll('\\', '/');
    if (relative === 'manifest.json' || relative === 'manifest.sha256') continue;
    const stats = await fsImpl.promises.stat(filePath);
    entries.push({ file: relative, bytes: stats.size, sha256: await hashFile(filePath, fsImpl) });
  }
  entries.sort((left, right) => left.file.localeCompare(right.file, 'en'));
  return entries;
}

async function verifyBackupSet(backupDirectory, { fsImpl = fs, verifyFiles = true } = {}) {
  const resolvedRoot = path.resolve(backupDirectory);
  const manifestPath = path.join(resolvedRoot, 'manifest.json');
  const digestPath = path.join(resolvedRoot, 'manifest.sha256');
  const [rawManifest, rawDigest] = await Promise.all([
    fsImpl.promises.readFile(manifestPath, 'utf8'),
    fsImpl.promises.readFile(digestPath, 'utf8')
  ]);
  const expectedManifestSha256 = rawDigest.trim().split(/\s+/, 1)[0].toLowerCase();
  const actualManifestSha256 = createHash('sha256').update(rawManifest).digest('hex');
  if (!SHA256_PATTERN.test(expectedManifestSha256) || expectedManifestSha256 !== actualManifestSha256) {
    fail('BACKUP_MANIFEST_HASH_MISMATCH', 'manifest.json does not match manifest.sha256');
  }
  let manifest;
  try {
    manifest = JSON.parse(rawManifest);
  } catch (error) {
    fail('BACKUP_MANIFEST_JSON_INVALID', 'Backup manifest is invalid JSON', { cause: error.message });
  }
  if (manifest.format !== BACKUP_FORMAT || !Array.isArray(manifest.files)) {
    fail('BACKUP_MANIFEST_FORMAT_INVALID', `Backup manifest must use ${BACKUP_FORMAT}`);
  }
  const declared = new Set();
  for (const entry of manifest.files) {
    if (
      !entry || typeof entry.file !== 'string' || !Number.isInteger(entry.bytes) || entry.bytes < 0 ||
      !SHA256_PATTERN.test(entry.sha256 || '')
    ) {
      fail('BACKUP_MANIFEST_FILE_INVALID', 'Backup manifest contains an invalid file entry');
    }
    const contained = safeRelativePath(resolvedRoot, entry.file);
    if (declared.has(contained.relative)) {
      fail('BACKUP_MANIFEST_FILE_DUPLICATE', 'Backup manifest declares a file more than once');
    }
    declared.add(contained.relative);
    if (verifyFiles) {
      const stats = await fsImpl.promises.stat(contained.resolved);
      if (!stats.isFile() || stats.size !== entry.bytes) {
        fail('BACKUP_FILE_SIZE_MISMATCH', 'Backup file size does not match manifest', {
          file: entry.file
        });
      }
      const actual = await hashFile(contained.resolved, fsImpl);
      if (actual !== entry.sha256) {
        fail('BACKUP_FILE_HASH_MISMATCH', 'Backup file hash does not match manifest', {
          file: entry.file
        });
      }
    }
  }
  if (verifyFiles) {
    const actualFiles = (await listFilesRecursive(resolvedRoot, fsImpl))
      .map((filePath) => path.relative(resolvedRoot, filePath).replaceAll('\\', '/'))
      .filter((relative) => relative !== 'manifest.json' && relative !== 'manifest.sha256');
    const undeclared = actualFiles.filter((relative) => !declared.has(relative));
    const missing = [...declared].filter((relative) => !actualFiles.includes(relative));
    if (undeclared.length || missing.length) {
      fail('BACKUP_FILE_SET_MISMATCH', 'Backup file set differs from manifest', { undeclared, missing });
    }
  }
  return Object.freeze({ manifest, manifestSha256: actualManifestSha256, backupDirectory: resolvedRoot });
}

function computeRetentionPlan(backups, { dailyKeep = 7, weeklyKeep = 4 } = {}) {
  if (!Number.isInteger(dailyKeep) || dailyKeep < 0 || !Number.isInteger(weeklyKeep) || weeklyKeep < 0) {
    fail('BACKUP_RETENTION_INVALID', 'Retention counts must be non-negative integers');
  }
  const sorted = [...backups].sort((left, right) =>
    Date.parse(right.completedAt) - Date.parse(left.completedAt)
  );
  const keep = new Set();
  sorted.filter((entry) => entry.tags?.includes('daily')).slice(0, dailyKeep)
    .forEach((entry) => keep.add(entry.backupId));
  sorted.filter((entry) => entry.tags?.includes('weekly')).slice(0, weeklyKeep)
    .forEach((entry) => keep.add(entry.backupId));
  return sorted.map((entry) => Object.freeze({
    ...entry,
    action: keep.has(entry.backupId) ? 'KEEP' : 'DELETE',
    reason: keep.has(entry.backupId)
      ? (entry.tags?.includes('weekly') ? 'daily-or-weekly-retention' : 'daily-retention')
      : 'outside-retention-window'
  }));
}

async function discoverCompletedBackups(backupRoot, fsImpl = fs) {
  const entries = await fsImpl.promises.readdir(backupRoot, { withFileTypes: true });
  const backups = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('backup-') || entry.name.includes('.tmp-')) continue;
    const directory = path.join(backupRoot, entry.name);
    try {
      const { manifest } = await verifyBackupSet(directory, { fsImpl, verifyFiles: false });
      if (manifest.backupId !== entry.name || !Number.isFinite(Date.parse(manifest.completedAt))) {
        throw new Error('manifest identity mismatch');
      }
      backups.push({
        backupId: manifest.backupId,
        completedAt: manifest.completedAt,
        tags: Array.isArray(manifest.retentionTags) ? manifest.retentionTags : ['daily'],
        directory
      });
    } catch {
      // Unknown, incomplete, or corrupt directories are never deleted automatically.
    }
  }
  return backups;
}

async function applyRetention({
  backupRoot,
  logPath,
  dailyKeep = 7,
  weeklyKeep = 4,
  dryRun = false,
  fsImpl = fs
}) {
  const backups = await discoverCompletedBackups(backupRoot, fsImpl);
  const plan = computeRetentionPlan(backups, { dailyKeep, weeklyKeep });
  for (const item of plan.filter((entry) => entry.action === 'DELETE')) {
    const contained = safeRelativePath(backupRoot, item.directory);
    if (!contained.relative.startsWith('backup-') || contained.relative.includes('/')) {
      fail('BACKUP_RETENTION_PATH_FORBIDDEN', 'Retention can only delete direct backup children');
    }
    if (!dryRun) await fsImpl.promises.rm(item.directory, { recursive: true, force: false });
  }
  await appendOperationLog(logPath, {
    event: 'RETENTION_COMPLETED',
    dryRun,
    dailyKeep,
    weeklyKeep,
    plan: plan.map(({ backupId, action, reason, tags }) => ({ backupId, action, reason, tags }))
  }, fsImpl);
  return plan;
}

function makeBackupId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `backup-${stamp}-${randomUUID().slice(0, 8)}`;
}

async function createBackup(config, {
  fsImpl = fs,
  spawnImpl = spawn,
  now = () => new Date()
} = {}) {
  const startedAt = now();
  const safePaths = await ensureSafeBackupRoot({
    backupRoot: config.backupRoot,
    backupVolumeRoot: config.backupVolumeRoot,
    uploadRoot: config.uploadRoot,
    platform: config.platform,
    systemDrive: config.systemDrive
  }, fsImpl);
  const logPath = config.logPath || path.join(safePaths.backupRoot, 'operations.jsonl');
  const lock = await acquireExclusiveLock(path.join(safePaths.backupRoot, '.operations.lock'), {
    fsImpl,
    now
  });
  const backupId = makeBackupId(startedAt);
  const temporaryDirectory = path.join(safePaths.backupRoot, `.${backupId}.tmp-${randomUUID()}`);
  const finalDirectory = path.join(safePaths.backupRoot, backupId);
  let completed = false;
  try {
    const mongo = assertMongoBackupScope(config.mongodbUri, { allowRemote: config.allowRemote });
    const mongodumpPath = await resolveTrustedExecutable(config.mongodumpPath, {
      toolName: 'mongodump',
      expectedSha256: config.mongodumpSha256,
      platform: config.platform,
      fsImpl
    });
    await fsImpl.promises.mkdir(temporaryDirectory, { recursive: false });
    const databaseRoot = path.join(temporaryDirectory, 'database');
    const uploadBackupRoot = path.join(temporaryDirectory, 'uploads');
    await fsImpl.promises.mkdir(databaseRoot, { recursive: false });
    const mongoConfigPath = path.join(temporaryDirectory, '.mongo-tools.yml');
    await writeMongoToolConfig(mongoConfigPath, config.mongodbUri, fsImpl);
    try {
      await runProcess(mongodumpPath, buildMongoDumpArgs({
        configPath: mongoConfigPath,
        outputDirectory: databaseRoot,
        useOplog: config.useOplog === true
      }), { spawnImpl, cwd: temporaryDirectory });
    } finally {
      await fsImpl.promises.rm(mongoConfigPath, { force: true });
    }

    const databaseDumpDirectory = path.join(databaseRoot, mongo.databaseName);
    const databaseStats = await fsImpl.promises.stat(databaseDumpDirectory);
    if (!databaseStats.isDirectory()) {
      fail('MONGODUMP_OUTPUT_MISSING', 'mongodump did not create the expected database directory');
    }
    await copyUploadsStable(safePaths.uploadRoot, uploadBackupRoot, fsImpl);
    const collections = await databaseCollectionMetadata(databaseDumpDirectory, fsImpl);
    const fileAssetCollection = collections.find((entry) => entry.name === 'fileassets');
    const fileAssetConsistency = fileAssetCollection
      ? await verifyFileAssetReferences({
        fileAssetsBsonPath: path.join(databaseDumpDirectory, fileAssetCollection.file),
        uploadBackupRoot,
        fsImpl
      })
      : Object.freeze({ referenced: 0, verified: 0 });
    const files = await buildFileEntries(temporaryDirectory, fsImpl);
    const uploadFiles = files.filter((entry) => entry.file.startsWith('uploads/'));
    const completedAt = now();
    const retentionTags = ['daily'];
    if (completedAt.getDay() === config.weeklyDay) retentionTags.push('weekly');
    const manifest = {
      format: BACKUP_FORMAT,
      backupId,
      createdAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      retentionTags,
      database: {
        name: mongo.databaseName,
        hosts: mongo.hosts,
        remoteExplicitlyAuthorized: !mongo.loopbackOnly,
        oplogCaptured: config.useOplog === true,
        collectionCount: collections.length,
        collections
      },
      uploads: {
        sourceRootLabel: path.basename(safePaths.uploadRoot),
        fileCount: uploadFiles.length,
        bytes: uploadFiles.reduce((sum, entry) => sum + entry.bytes, 0),
        fileAssetReferences: fileAssetConsistency
      },
      consistency: {
        restoreSet: 'database-and-uploads',
        databaseFileAssetsVerifiedAgainstUploadBytes: true
      },
      files
    };
    const serialized = await writeJsonAtomic(path.join(temporaryDirectory, 'manifest.json'), manifest, fsImpl);
    const manifestSha256 = createHash('sha256').update(serialized).digest('hex');
    await fsImpl.promises.writeFile(
      path.join(temporaryDirectory, 'manifest.sha256'),
      `${manifestSha256}  manifest.json\n`,
      { mode: 0o600, flag: 'wx' }
    );
    await verifyBackupSet(temporaryDirectory, { fsImpl, verifyFiles: true });
    await fsImpl.promises.rename(temporaryDirectory, finalDirectory);
    completed = true;
    await appendOperationLog(logPath, {
      event: 'BACKUP_COMPLETED',
      backupId,
      directory: finalDirectory,
      manifestSha256,
      database: mongo.databaseName,
      files: files.length,
      bytes: files.reduce((sum, entry) => sum + entry.bytes, 0),
      durationMs: completedAt.getTime() - startedAt.getTime()
    }, fsImpl);
    const retention = await applyRetention({
      backupRoot: safePaths.backupRoot,
      logPath,
      dailyKeep: config.dailyKeep,
      weeklyKeep: config.weeklyKeep,
      dryRun: false,
      fsImpl
    });
    return Object.freeze({ backupId, finalDirectory, manifestSha256, manifest, retention });
  } catch (error) {
    await appendOperationLog(logPath, {
      event: 'BACKUP_FAILED',
      backupId,
      code: error.code || 'UNEXPECTED_ERROR',
      message: error.message
    }, fsImpl).catch(() => {});
    throw error;
  } finally {
    if (!completed) await fsImpl.promises.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
    await lock.release();
  }
}

async function resolveCompletedBackupDirectory(backupRoot, backupId, fsImpl = fs) {
  if (typeof backupId !== 'string' || !BACKUP_ID_PATTERN.test(backupId)) {
    fail('BACKUP_ID_INVALID', 'backupId must identify a completed backup directory');
  }
  const candidate = path.join(backupRoot, backupId);
  const contained = safeRelativePath(backupRoot, candidate);
  if (contained.relative !== backupId) {
    fail('BACKUP_DIRECTORY_FORBIDDEN', 'Backup must be a direct child of BACKUP_ROOT');
  }
  const realRoot = await fsImpl.promises.realpath(backupRoot);
  const realCandidate = await fsImpl.promises.realpath(candidate);
  if (path.dirname(realCandidate) !== realRoot || path.basename(realCandidate) !== backupId) {
    fail('BACKUP_DIRECTORY_FORBIDDEN', 'Backup directory cannot traverse links or leave BACKUP_ROOT');
  }
  const stats = await fsImpl.promises.stat(realCandidate);
  if (!stats.isDirectory()) fail('BACKUP_DIRECTORY_INVALID', 'Backup path must be a directory');
  return realCandidate;
}

async function ensureSafeRestoreRoot({
  restoreRoot,
  backupRoot,
  uploadRoot,
  platform = process.platform,
  systemDrive = process.env.SystemDrive || 'C:'
}, fsImpl = fs) {
  const api = pathApi(platform);
  if (typeof restoreRoot !== 'string' || !api.isAbsolute(restoreRoot)) {
    fail('RESTORE_PATH_NOT_ABSOLUTE', 'RESTORE_ROOT must be an explicitly configured absolute path');
  }
  const resolvedRestore = api.resolve(restoreRoot);
  for (const forbidden of [api.resolve(backupRoot), api.resolve(uploadRoot)]) {
    if (
      isContained(forbidden, resolvedRestore, { allowSame: true, platform }) ||
      isContained(resolvedRestore, forbidden, { allowSame: true, platform })
    ) {
      fail('RESTORE_PATH_OVERLAP', 'RESTORE_ROOT must not overlap backups or active uploads');
    }
  }
  if (platform === 'win32') {
    const restoreDrive = api.parse(resolvedRestore).root.replace(/[\\/]$/, '').toLowerCase();
    const normalizedSystemDrive = String(systemDrive).replace(/[\\/]$/, '').toLowerCase();
    if (!restoreDrive || restoreDrive === normalizedSystemDrive) {
      fail('RESTORE_SYSTEM_VOLUME_FORBIDDEN', 'RESTORE_ROOT must be stored on a non-system drive');
    }
  }
  await fsImpl.promises.mkdir(resolvedRestore, { recursive: true });
  const realRestore = await fsImpl.promises.realpath(resolvedRestore);
  for (const forbiddenPath of [backupRoot, uploadRoot]) {
    const realForbidden = await fsImpl.promises.realpath(forbiddenPath);
    if (
      isContained(realForbidden, realRestore, { allowSame: true, platform }) ||
      isContained(realRestore, realForbidden, { allowSame: true, platform })
    ) {
      fail('RESTORE_PATH_OVERLAP', 'RESTORE_ROOT resolves into backups or active uploads');
    }
  }
  return realRestore;
}

function loadMongoClient() {
  try {
    return require('mongodb').MongoClient;
  } catch {
    return require('../../app/node_modules/mongodb').MongoClient;
  }
}

async function assertRestoreDatabaseEmpty({ mongodbUri, targetDatabase, MongoClientImpl }) {
  const MongoClient = MongoClientImpl || loadMongoClient();
  const client = new MongoClient(mongodbUri, {
    appName: 'task-distribution-v2-restore-preflight',
    serverSelectionTimeoutMS: 5000
  });
  try {
    await client.connect();
    const collections = await client.db(targetDatabase)
      .listCollections({}, { nameOnly: true })
      .toArray();
    if (collections.length > 0) {
      fail(
        'RESTORE_TARGET_NOT_EMPTY',
        'Restore target database already contains collections and will not be modified',
        { targetDatabase, collections: collections.map((entry) => entry.name).slice(0, 25) }
      );
    }
  } finally {
    await client.close().catch(() => {});
  }
}

async function verifyRestoredState({
  mongodbUri,
  targetDatabase,
  manifest,
  restoredUploadRoot,
  fsImpl = fs,
  MongoClientImpl
}) {
  const MongoClient = MongoClientImpl || loadMongoClient();
  const client = new MongoClient(mongodbUri, {
    appName: 'task-distribution-v2-restore-verifier',
    serverSelectionTimeoutMS: 5000
  });
  const collectionResults = [];
  let fileAssets = { referenced: 0, verified: 0 };
  try {
    await client.connect();
    const database = client.db(targetDatabase);
    const actualNames = new Set(
      (await database.listCollections({}, { nameOnly: true }).toArray()).map((entry) => entry.name)
    );
    for (const expected of manifest.database.collections) {
      if (!actualNames.has(expected.name)) {
        fail('RESTORE_COLLECTION_MISSING', 'Restored database is missing a collection', {
          collection: expected.name
        });
      }
      const actualCount = await database.collection(expected.name).countDocuments({});
      if (actualCount !== expected.documentCount) {
        fail('RESTORE_DOCUMENT_COUNT_MISMATCH', 'Restored collection count differs from backup', {
          collection: expected.name,
          expected: expected.documentCount,
          actual: actualCount
        });
      }
      collectionResults.push({ name: expected.name, documentCount: actualCount });
    }

    if (actualNames.has('fileassets')) {
      const cursor = database.collection('fileassets').find(
        { status: { $ne: 'DELETED' } },
        { projection: { _id: 1, storageKey: 1, size: 1, sha256: 1 } }
      );
      for await (const record of cursor) {
        fileAssets.referenced += 1;
        const contained = safeRelativePath(restoredUploadRoot, record.storageKey);
        const stats = await fsImpl.promises.stat(contained.resolved).catch(() => null);
        if (
          !stats || !stats.isFile() || stats.size !== record.size ||
          await hashFile(contained.resolved, fsImpl) !== record.sha256
        ) {
          fail('RESTORE_FILE_ASSET_MISMATCH', 'Restored FileAsset does not match restored uploads', {
            id: String(record._id || ''),
            storageKey: record.storageKey
          });
        }
        fileAssets.verified += 1;
      }
      const expectedReferences = manifest.uploads.fileAssetReferences?.referenced;
      if (Number.isInteger(expectedReferences) && fileAssets.referenced !== expectedReferences) {
        fail('RESTORE_FILE_ASSET_COUNT_MISMATCH', 'Restored FileAsset count differs from backup', {
          expected: expectedReferences,
          actual: fileAssets.referenced
        });
      }
    }
  } finally {
    await client.close().catch(() => {});
  }
  return Object.freeze({ collections: collectionResults, fileAssets });
}

async function restoreBackup(config, backupId, {
  fsImpl = fs,
  spawnImpl = spawn,
  now = () => new Date(),
  MongoClientImpl
} = {}) {
  const startedAt = now();
  const safePaths = await ensureSafeBackupRoot({
    backupRoot: config.backupRoot,
    backupVolumeRoot: config.backupVolumeRoot,
    uploadRoot: config.uploadRoot,
    platform: config.platform,
    systemDrive: config.systemDrive
  }, fsImpl);
  const restoreRoot = await ensureSafeRestoreRoot({
    restoreRoot: config.restoreRoot,
    backupRoot: safePaths.backupRoot,
    uploadRoot: safePaths.uploadRoot,
    platform: config.platform,
    systemDrive: config.systemDrive
  }, fsImpl);
  const backupDirectory = await resolveCompletedBackupDirectory(safePaths.backupRoot, backupId, fsImpl);
  const verified = await verifyBackupSet(backupDirectory, { fsImpl, verifyFiles: true });
  if (verified.manifest.backupId !== backupId) {
    fail('BACKUP_MANIFEST_ID_MISMATCH', 'Backup directory and manifest identities differ');
  }
  assertRestoreTarget({
    uri: config.mongodbUri,
    sourceDatabase: verified.manifest.database.name,
    targetDatabase: config.targetDatabase
  });

  const lock = await acquireExclusiveLock(path.join(safePaths.backupRoot, '.operations.lock'), {
    fsImpl,
    now
  });
  const restoreId = `restore-${backupId.slice('backup-'.length)}-${randomUUID().slice(0, 8)}`;
  const temporaryDirectory = path.join(restoreRoot, `.${restoreId}.tmp-${randomUUID()}`);
  const finalDirectory = path.join(restoreRoot, restoreId);
  const logPath = config.logPath || path.join(safePaths.backupRoot, 'operations.jsonl');
  let completed = false;
  try {
    await fsImpl.promises.mkdir(temporaryDirectory, { recursive: false });
    const restoredUploadRoot = path.join(temporaryDirectory, 'uploads');
    await copyUploadsStable(path.join(backupDirectory, 'uploads'), restoredUploadRoot, fsImpl);
    await assertRestoreDatabaseEmpty({
      mongodbUri: config.mongodbUri,
      targetDatabase: config.targetDatabase,
      MongoClientImpl
    });
    const mongorestorePath = await resolveTrustedExecutable(config.mongorestorePath, {
      toolName: 'mongorestore',
      expectedSha256: config.mongorestoreSha256,
      platform: config.platform,
      fsImpl
    });
    const mongoConfigPath = path.join(temporaryDirectory, '.mongo-tools.yml');
    await writeMongoToolConfig(mongoConfigPath, mongoServerUri(config.mongodbUri), fsImpl);
    try {
      await runProcess(mongorestorePath, buildMongoRestoreArgs({
        configPath: mongoConfigPath,
        dumpDirectory: path.join(backupDirectory, 'database'),
        sourceDatabase: verified.manifest.database.name,
        targetDatabase: config.targetDatabase
      }), { spawnImpl, cwd: temporaryDirectory });
    } finally {
      await fsImpl.promises.rm(mongoConfigPath, { force: true });
    }

    const reconciliation = await verifyRestoredState({
      mongodbUri: config.mongodbUri,
      targetDatabase: config.targetDatabase,
      manifest: verified.manifest,
      restoredUploadRoot,
      fsImpl,
      MongoClientImpl
    });
    const completedAt = now();
    const report = {
      format: 'task-distribution-v2-restore-report/v1',
      restoreId,
      backupId,
      manifestSha256: verified.manifestSha256,
      targetDatabase: config.targetDatabase,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startedAt.getTime(),
      reconciliation
    };
    await writeJsonAtomic(path.join(temporaryDirectory, 'restore-report.json'), report, fsImpl);
    await fsImpl.promises.rename(temporaryDirectory, finalDirectory);
    completed = true;
    await appendOperationLog(logPath, {
      event: 'RESTORE_VERIFICATION_COMPLETED',
      restoreId,
      backupId,
      targetDatabase: config.targetDatabase,
      directory: finalDirectory,
      manifestSha256: verified.manifestSha256,
      durationMs: report.durationMs
    }, fsImpl);
    return Object.freeze({ restoreId, finalDirectory, report, manifest: verified.manifest });
  } catch (error) {
    await appendOperationLog(logPath, {
      event: 'RESTORE_VERIFICATION_FAILED',
      restoreId,
      backupId,
      targetDatabase: config.targetDatabase,
      code: error.code || 'UNEXPECTED_ERROR',
      message: error.message
    }, fsImpl).catch(() => {});
    throw error;
  } finally {
    if (!completed) await fsImpl.promises.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
    await lock.release();
  }
}

module.exports = {
  BACKUP_ID_PATTERN,
  BACKUP_FORMAT,
  LOOPBACK_HOSTS,
  OperationsError,
  RESTORE_DATABASE_PATTERN,
  acquireExclusiveLock,
  appendOperationLog,
  applyRetention,
  assertBackupPathPolicy,
  assertMongoBackupScope,
  assertRestoreDatabaseEmpty,
  assertRestoreTarget,
  buildFileEntries,
  buildMongoDumpArgs,
  buildMongoRestoreArgs,
  computeRetentionPlan,
  copyUploadsStable,
  createBackup,
  databaseCollectionMetadata,
  discoverCompletedBackups,
  ensureSafeBackupRoot,
  ensureSafeRestoreRoot,
  forEachBsonDocument,
  hashFile,
  isContained,
  listFilesRecursive,
  makeBackupId,
  mongoServerUri,
  parseMongoUri,
  resolveTrustedExecutable,
  resolveCompletedBackupDirectory,
  restoreBackup,
  runProcess,
  safeRelativePath,
  verifyBackupSet,
  verifyFileAssetReferences,
  verifyRestoredState,
  writeMongoToolConfig
};
