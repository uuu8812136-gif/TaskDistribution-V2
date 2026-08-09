const path = require('path');

const NON_PRODUCTION_DATABASE_SUFFIXES = ['_v2_dev', '_v2_test', '_v2_staging'];
const FORBIDDEN_NON_PRODUCTION_PORTS = new Set([8099]);
const PLACEHOLDER_SECRETS = ['replace-me', 'change-me', 'your-secret-key'];
const LOOPBACK_API_HOST = '127.0.0.1';

function parseInteger(value, fallback, name) {
  const parsed = Number.parseInt(value ?? fallback, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return parsed;
}

function parsePositiveInteger(value, fallback, name) {
  const parsed = Number.parseInt(value ?? fallback, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return parsed;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

function parseApiBindHost(value, appEnv) {
  const host = String(value || LOOPBACK_API_HOST).trim();
  if (!host) throw new Error('API_BIND_HOST is required');
  if (appEnv === 'production' && host !== LOOPBACK_API_HOST) {
    throw new Error(`Production API must bind exactly ${LOOPBACK_API_HOST}`);
  }
  return host;
}

function databaseNameFromUri(uri) {
  try {
    const parsed = new URL(uri);
    return decodeURIComponent(parsed.pathname.replace(/^\//, '').split('/')[0] || '');
  } catch {
    throw new Error('MONGODB_URI must be a valid MongoDB URI');
  }
}

function assertSecret(secret, appEnv) {
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET must contain at least 32 characters');
  }

  const normalized = secret.toLowerCase();
  if (PLACEHOLDER_SECRETS.some((placeholder) => normalized.includes(placeholder))) {
    throw new Error(`JWT_SECRET contains a placeholder value for ${appEnv}`);
  }
}

function assertNonProductionIsolation(config) {
  const databaseName = databaseNameFromUri(config.mongodbUri).toLowerCase();
  const hasSafeSuffix = NON_PRODUCTION_DATABASE_SUFFIXES.some((suffix) =>
    databaseName.endsWith(suffix)
  );

  if (!hasSafeSuffix) {
    throw new Error(
      `Non-production database name "${databaseName || '(missing)'}" must end with ` +
        NON_PRODUCTION_DATABASE_SUFFIXES.join(', ')
    );
  }

  if (FORBIDDEN_NON_PRODUCTION_PORTS.has(config.port)) {
    throw new Error(`Port ${config.port} is reserved for the existing production service`);
  }

  const normalizedUploadPath = config.uploadPath.replace(/\\/g, '/').toLowerCase();
  const isolatedUploadPath =
    normalizedUploadPath.includes('/taskdistribution-v2/') ||
    normalizedUploadPath.includes('/task-distribution-v2') ||
    normalizedUploadPath.includes('/.test-data/');

  if (!isolatedUploadPath) {
    throw new Error('UPLOAD_PATH must be inside the V2 workspace or isolated V2 service root');
  }

  if (!config.instanceName.toLowerCase().includes('v2')) {
    throw new Error('APP_INSTANCE must identify the isolated V2 instance');
  }
}

function loadEnvironment(env = process.env) {
  const appEnv = env.APP_ENV || env.NODE_ENV || 'development';
  const config = {
    appEnv,
    nodeEnv: env.NODE_ENV || 'development',
    instanceName: env.APP_INSTANCE || 'task-distribution-v2-dev',
    port: parseInteger(env.PORT, 18099, 'PORT'),
    apiBindHost: parseApiBindHost(env.API_BIND_HOST, appEnv),
    mongodbUri: env.MONGODB_URI,
    jwtSecret: env.JWT_SECRET,
    jwtExpire: env.JWT_EXPIRE || '8h',
    jwtIssuer: env.JWT_ISSUER || 'task-distribution-v2',
    jwtAudience: env.JWT_AUDIENCE || 'task-distribution-v2-clients',
    uploadPath: path.resolve(process.cwd(), env.UPLOAD_PATH || '../.test-data/uploads'),
    maxFileSize: parsePositiveInteger(env.MAX_FILE_SIZE, 10 * 1024 * 1024, 'MAX_FILE_SIZE'),
    temporaryFileUserMaxCount: parsePositiveInteger(
      env.TEMPORARY_FILE_USER_MAX_COUNT,
      20,
      'TEMPORARY_FILE_USER_MAX_COUNT'
    ),
    temporaryFileUserMaxBytes: parsePositiveInteger(
      env.TEMPORARY_FILE_USER_MAX_BYTES,
      100 * 1024 * 1024,
      'TEMPORARY_FILE_USER_MAX_BYTES'
    ),
    temporaryFileTeamMaxCount: parsePositiveInteger(
      env.TEMPORARY_FILE_TEAM_MAX_COUNT,
      200,
      'TEMPORARY_FILE_TEAM_MAX_COUNT'
    ),
    temporaryFileTeamMaxBytes: parsePositiveInteger(
      env.TEMPORARY_FILE_TEAM_MAX_BYTES,
      1024 * 1024 * 1024,
      'TEMPORARY_FILE_TEAM_MAX_BYTES'
    ),
    temporaryFileTtlHours: parsePositiveInteger(
      env.TEMPORARY_FILE_TTL_HOURS,
      24,
      'TEMPORARY_FILE_TTL_HOURS'
    ),
    corsOrigins: (env.CORS_ORIGINS || 'http://localhost:3101')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    enableLegacyPublicUploads: parseBoolean(env.ENABLE_LEGACY_PUBLIC_UPLOADS, false),
    equipmentRoutineWorkerEnabled: parseBoolean(
      env.EQUIPMENT_ROUTINE_WORKER_ENABLED,
      appEnv === 'production'
    ),
    equipmentRoutineWorkerIntervalMs: parsePositiveInteger(
      env.EQUIPMENT_ROUTINE_WORKER_INTERVAL_MS,
      5 * 60 * 1000,
      'EQUIPMENT_ROUTINE_WORKER_INTERVAL_MS'
    )
  };
  if (config.equipmentRoutineWorkerIntervalMs < 1000) {
    throw new Error('EQUIPMENT_ROUTINE_WORKER_INTERVAL_MS must be at least 1000');
  }
  if (config.temporaryFileUserMaxBytes < config.maxFileSize) {
    throw new Error('TEMPORARY_FILE_USER_MAX_BYTES must be at least MAX_FILE_SIZE');
  }
  if (config.temporaryFileTeamMaxCount < config.temporaryFileUserMaxCount) {
    throw new Error(
      'TEMPORARY_FILE_TEAM_MAX_COUNT must be at least TEMPORARY_FILE_USER_MAX_COUNT'
    );
  }
  if (config.temporaryFileTeamMaxBytes < config.temporaryFileUserMaxBytes) {
    throw new Error(
      'TEMPORARY_FILE_TEAM_MAX_BYTES must be at least TEMPORARY_FILE_USER_MAX_BYTES'
    );
  }

  if (!config.mongodbUri) {
    throw new Error('MONGODB_URI is required');
  }
  assertSecret(config.jwtSecret, appEnv);
  if (!config.jwtIssuer || !config.jwtAudience) {
    throw new Error('JWT_ISSUER and JWT_AUDIENCE are required');
  }

  if (appEnv !== 'production') {
    assertNonProductionIsolation(config);
  }

  return Object.freeze(config);
}

module.exports = {
  databaseNameFromUri,
  loadEnvironment
};
