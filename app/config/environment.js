const path = require('path');

const NON_PRODUCTION_DATABASE_SUFFIXES = ['_v2_dev', '_v2_test', '_v2_staging'];
const FORBIDDEN_NON_PRODUCTION_PORTS = new Set([8099]);
const PLACEHOLDER_SECRETS = ['replace-me', 'change-me', 'your-secret-key'];

function parseInteger(value, fallback, name) {
  const parsed = Number.parseInt(value ?? fallback, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return parsed;
}

function parsePositiveInteger(value, fallback, name) {
  const parsed = Number.parseInt(value ?? fallback, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
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
    mongodbUri: env.MONGODB_URI,
    jwtSecret: env.JWT_SECRET,
    jwtExpire: env.JWT_EXPIRE || '8h',
    uploadPath: path.resolve(process.cwd(), env.UPLOAD_PATH || '../.test-data/uploads'),
    maxFileSize: parsePositiveInteger(env.MAX_FILE_SIZE, 10 * 1024 * 1024, 'MAX_FILE_SIZE'),
    corsOrigins: (env.CORS_ORIGINS || 'http://localhost:3101')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    enableLegacyPublicUploads: parseBoolean(env.ENABLE_LEGACY_PUBLIC_UPLOADS, false)
  };

  if (!config.mongodbUri) {
    throw new Error('MONGODB_URI is required');
  }
  assertSecret(config.jwtSecret, appEnv);

  if (appEnv !== 'production') {
    assertNonProductionIsolation(config);
  }

  return Object.freeze(config);
}

module.exports = {
  databaseNameFromUri,
  loadEnvironment
};
