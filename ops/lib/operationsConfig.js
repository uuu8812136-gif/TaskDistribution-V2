'use strict';

const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv, { values = [], flags = [] } = {}) {
  const valueNames = new Set(values);
  const flagNames = new Set(flags);
  const output = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected positional argument: ${token}`);
    const equalIndex = token.indexOf('=');
    const name = token.slice(2, equalIndex < 0 ? undefined : equalIndex);
    const inlineValue = equalIndex < 0 ? undefined : token.slice(equalIndex + 1);
    if (flagNames.has(name)) {
      if (inlineValue !== undefined) throw new Error(`--${name} does not accept a value`);
      output[name] = true;
      continue;
    }
    if (!valueNames.has(name)) throw new Error(`Unknown option: --${name}`);
    const value = inlineValue === undefined ? argv[++index] : inlineValue;
    if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
    output[name] = value;
  }
  return output;
}

function parseEnvText(contents) {
  const values = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) throw new Error(`Invalid environment line for ${line.split('=', 1)[0] || '(unknown)'}`);
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    values[match[1]] = value.replace(/\\n/g, '\n');
  }
  return values;
}

async function loadOperationsEnvironment({ envFile, baseEnv = process.env, fsImpl = fs } = {}) {
  if (!envFile) return { ...baseEnv };
  if (!path.isAbsolute(envFile)) throw new Error('--env-file must be an absolute path');
  const stats = await fsImpl.promises.stat(envFile);
  if (!stats.isFile()) throw new Error('--env-file must point to a regular file');
  const fileValues = parseEnvText(await fsImpl.promises.readFile(envFile, 'utf8'));
  return { ...fileValues, ...baseEnv };
}

function requireValue(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function optionalAbsolutePath(env, name) {
  const value = env[name];
  if (!value) return '';
  if (!path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return path.resolve(value);
}

function requiredAbsolutePath(env, name) {
  const value = requireValue(env, name);
  if (!path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return path.resolve(value);
}

function parseBoolean(value, fallback = false, name = 'value') {
  if (value === undefined || value === '') return fallback;
  if (String(value).toLowerCase() === 'true') return true;
  if (String(value).toLowerCase() === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

function parseInteger(value, fallback, name, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const source = value === undefined || value === '' ? fallback : value;
  const parsed = Number.parseInt(source, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== String(source) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function backupConfigFromEnv(env) {
  const backupRoot = requiredAbsolutePath(env, 'BACKUP_ROOT');
  return Object.freeze({
    backupRoot,
    backupVolumeRoot: requiredAbsolutePath(env, 'BACKUP_VOLUME_ROOT'),
    uploadRoot: requiredAbsolutePath(env, 'UPLOAD_PATH'),
    logPath: optionalAbsolutePath(env, 'BACKUP_LOG_PATH') || path.join(backupRoot, 'operations.jsonl'),
    mongodbUri: requireValue(env, 'MONGODB_URI'),
    mongodumpPath: requiredAbsolutePath(env, 'MONGODUMP_PATH'),
    mongodumpSha256: (env.MONGODUMP_SHA256 || '').trim().toLowerCase(),
    mongorestorePath: optionalAbsolutePath(env, 'MONGORESTORE_PATH'),
    mongorestoreSha256: (env.MONGORESTORE_SHA256 || '').trim().toLowerCase(),
    allowRemote: parseBoolean(env.BACKUP_ALLOW_REMOTE, false, 'BACKUP_ALLOW_REMOTE'),
    useOplog: parseBoolean(env.BACKUP_USE_OPLOG, false, 'BACKUP_USE_OPLOG'),
    dailyKeep: parseInteger(env.BACKUP_DAILY_KEEP, 7, 'BACKUP_DAILY_KEEP', { minimum: 0, maximum: 365 }),
    weeklyKeep: parseInteger(env.BACKUP_WEEKLY_KEEP, 4, 'BACKUP_WEEKLY_KEEP', { minimum: 0, maximum: 104 }),
    weeklyDay: parseInteger(env.BACKUP_WEEKLY_DAY, 0, 'BACKUP_WEEKLY_DAY', { minimum: 0, maximum: 6 }),
    systemDrive: env.SystemDrive || env.SYSTEM_DRIVE || 'C:',
    platform: process.platform
  });
}

function restoreConfigFromEnv(env) {
  const backupRoot = requiredAbsolutePath(env, 'BACKUP_ROOT');
  return Object.freeze({
    backupRoot,
    backupVolumeRoot: requiredAbsolutePath(env, 'BACKUP_VOLUME_ROOT'),
    uploadRoot: requiredAbsolutePath(env, 'UPLOAD_PATH'),
    restoreRoot: requiredAbsolutePath(env, 'RESTORE_ROOT'),
    logPath: optionalAbsolutePath(env, 'BACKUP_LOG_PATH') || path.join(backupRoot, 'operations.jsonl'),
    mongodbUri: requireValue(env, 'RESTORE_MONGODB_URI'),
    targetDatabase: requireValue(env, 'RESTORE_DATABASE'),
    mongorestorePath: requiredAbsolutePath(env, 'MONGORESTORE_PATH'),
    mongorestoreSha256: (env.MONGORESTORE_SHA256 || '').trim().toLowerCase(),
    systemDrive: env.SystemDrive || env.SYSTEM_DRIVE || 'C:',
    platform: process.platform
  });
}

function healthConfigFromEnv(env) {
  const backupRoot = requiredAbsolutePath(env, 'BACKUP_ROOT');
  return Object.freeze({
    apiUrl: env.HEALTH_API_URL || 'http://127.0.0.1:18099/health',
    webUrl: env.HEALTH_WEB_URL || 'http://127.0.0.1:3101/',
    apiPort: parseInteger(env.HEALTH_API_PORT, 18099, 'HEALTH_API_PORT', { minimum: 1, maximum: 65535 }),
    webPort: parseInteger(env.HEALTH_WEB_PORT, 3101, 'HEALTH_WEB_PORT', { minimum: 1, maximum: 65535 }),
    mongoPort: parseInteger(env.HEALTH_MONGO_PORT, 27017, 'HEALTH_MONGO_PORT', { minimum: 1, maximum: 65535 }),
    apiLogPath: optionalAbsolutePath(env, 'HEALTH_API_LOG_PATH'),
    webLogPath: optionalAbsolutePath(env, 'HEALTH_WEB_LOG_PATH'),
    backupRoot,
    backupLogPath: optionalAbsolutePath(env, 'BACKUP_LOG_PATH') || path.join(backupRoot, 'operations.jsonl'),
    backupMaxAgeHours: parseInteger(
      env.HEALTH_BACKUP_MAX_AGE_HOURS,
      26,
      'HEALTH_BACKUP_MAX_AGE_HOURS',
      { minimum: 1, maximum: 720 }
    ),
    diskMinimumFreeGb: parseInteger(
      env.HEALTH_DISK_MIN_FREE_GB,
      10,
      'HEALTH_DISK_MIN_FREE_GB',
      { minimum: 1, maximum: 1048576 }
    ),
    intervalSeconds: parseInteger(
      env.HEALTH_INTERVAL_SECONDS,
      30,
      'HEALTH_INTERVAL_SECONDS',
      { minimum: 5, maximum: 3600 }
    )
  });
}

module.exports = {
  backupConfigFromEnv,
  healthConfigFromEnv,
  loadOperationsEnvironment,
  optionalAbsolutePath,
  parseArgs,
  parseBoolean,
  parseEnvText,
  parseInteger,
  requiredAbsolutePath,
  restoreConfigFromEnv,
  requireValue
};
