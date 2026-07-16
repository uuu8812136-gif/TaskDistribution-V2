#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { createApp } = require('../app');
const { loadEnvironment } = require('../config/environment');
const {
  DEFAULT_USERNAME_PREFIX,
  assertSeedDatabaseIsolation,
  assertStrongPassword,
  normalizeUsernamePrefix,
  seedV2Demo
} = require('./seedV2Demo');

const WORKSPACE_ROOT = path.resolve(__dirname, '../..');
const TEST_DATA_ROOT = path.join(WORKSPACE_ROOT, '.test-data');
const DEFAULT_DATABASE_NAME = 'local_e2e_v2_test';
const DEFAULT_API_PORT = 18099;
const DEFAULT_MONGO_PORT = 27028;
const LOOPBACK_HOST = '127.0.0.1';
const PRODUCTION_HOSTS = new Set(['www.horselink.cn', '82.156.67.62']);
const VALUE_OPTIONS = new Set([
  'host',
  'port',
  'mongo-port',
  'database',
  'data-dir',
  'upload-dir',
  'password',
  'username-prefix'
]);
const FLAG_OPTIONS = new Set(['help']);
const JWT_ENVIRONMENT_KEYS = Object.freeze([
  'JWT_SECRET',
  'JWT_EXPIRE',
  'JWT_ISSUER',
  'JWT_AUDIENCE'
]);

function usage() {
  return [
    'Start an isolated local V2 E2E API with a persistent MongoMemoryReplSet.',
    '',
    'Required environment:',
    '  V2_DEMO_PASSWORD=<strong password used only for newly created demo users>',
    '',
    'Run:',
    '  node script/startV2LocalE2E.js [--username-prefix <prefix>]',
    '',
    `Defaults: API http://${LOOPBACK_HOST}:${DEFAULT_API_PORT}, MongoDB ${DEFAULT_MONGO_PORT},`,
    `database ${DEFAULT_DATABASE_NAME}, state under ${TEST_DATA_ROOT}.`,
    'The API cannot bind a non-loopback host, use port 8099, use a production host,',
    'use a non-_v2_test database, or store runtime files outside .test-data.'
  ].join('\n');
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error('Unexpected positional argument');
    const [name, inlineValue] = token.slice(2).split(/=(.*)/s, 2);
    if (FLAG_OPTIONS.has(name)) {
      if (inlineValue !== undefined) throw new Error(`--${name} does not accept a value`);
      result[name] = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) throw new Error(`Unknown option: --${name}`);
    const value = inlineValue === undefined ? argv[++index] : inlineValue;
    if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
    const camelName = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    result[camelName] = value;
  }
  return result;
}

function parsePort(value, fallback, fieldName) {
  const parsed = Number.parseInt(value ?? fallback, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535 || String(parsed) !== String(value ?? fallback)) {
    throw new Error(`${fieldName} must be an integer between 1 and 65535`);
  }
  return parsed;
}

function resolveWorkspacePath(value, fallback) {
  if (!value) return fallback;
  return path.resolve(WORKSPACE_ROOT, value);
}

function assertPathInsideTestData(candidate, fieldName) {
  const resolved = path.resolve(candidate);
  const relative = path.relative(TEST_DATA_ROOT, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${fieldName} must be a child directory of the workspace .test-data directory`);
  }
  return resolved;
}

function assertDistinctRuntimePaths(dataDir, uploadDir) {
  const dataToUploads = path.relative(dataDir, uploadDir);
  const uploadsToData = path.relative(uploadDir, dataDir);
  const dataContainsUploads = dataToUploads && !dataToUploads.startsWith(`..${path.sep}`) && dataToUploads !== '..';
  const uploadsContainData = uploadsToData && !uploadsToData.startsWith(`..${path.sep}`) && uploadsToData !== '..';
  if (dataDir === uploadDir || dataContainsUploads || uploadsContainData) {
    throw new Error('MongoDB data and upload directories must be separate sibling paths');
  }
}

function resolveLocalE2EOptions({ argv = [], env = {} } = {}) {
  const args = parseArgs(argv);
  if (args.help) return Object.freeze({ help: true });

  const host = (args.host || LOOPBACK_HOST).toLowerCase();
  if (PRODUCTION_HOSTS.has(host)) throw new Error('Production hosts are forbidden for local E2E');
  if (host !== LOOPBACK_HOST) {
    throw new Error(`Local E2E must bind exactly ${LOOPBACK_HOST}`);
  }

  const port = parsePort(args.port, DEFAULT_API_PORT, 'port');
  if (port === 8099) throw new Error('Port 8099 is reserved for the existing production service');
  const mongoPort = parsePort(args.mongoPort, DEFAULT_MONGO_PORT, 'mongo-port');
  if (mongoPort === 27017) throw new Error('MongoDB port 27017 is not used by the isolated E2E runtime');
  if (mongoPort === port) throw new Error('API and MongoDB ports must be different');

  const databaseName = args.database || DEFAULT_DATABASE_NAME;
  assertSeedDatabaseIsolation(databaseName);
  if (!databaseName.toLowerCase().endsWith('_v2_test')) {
    throw new Error('Local E2E database name must end with _v2_test');
  }

  const dataDir = assertPathInsideTestData(
    resolveWorkspacePath(args.dataDir, path.join(TEST_DATA_ROOT, 'v2-local-e2e', 'mongodb')),
    'data-dir'
  );
  const uploadDir = assertPathInsideTestData(
    resolveWorkspacePath(args.uploadDir, path.join(TEST_DATA_ROOT, 'v2-local-e2e', 'uploads')),
    'upload-dir'
  );
  assertDistinctRuntimePaths(dataDir, uploadDir);

  const password = args.password || env.V2_DEMO_PASSWORD;
  assertStrongPassword(password);

  return Object.freeze({
    help: false,
    host,
    port,
    mongoPort,
    databaseName,
    dataDir,
    uploadDir,
    password,
    usernamePrefix: normalizeUsernamePrefix(
      args.usernamePrefix || env.V2_DEMO_USERNAME_PREFIX || DEFAULT_USERNAME_PREFIX
    )
  });
}

async function ensureIsolatedDirectory(directory, fieldName) {
  await fs.promises.mkdir(TEST_DATA_ROOT, { recursive: true });
  await fs.promises.mkdir(directory, { recursive: true });
  const [realRoot, realDirectory] = await Promise.all([
    fs.promises.realpath(TEST_DATA_ROOT),
    fs.promises.realpath(directory)
  ]);
  const relative = path.relative(realRoot, realDirectory);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${fieldName} resolves outside the workspace .test-data directory`);
  }
  return realDirectory;
}

async function listen(app, port, host) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host);
    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function applyJwtEnvironment(config) {
  const previous = Object.fromEntries(
    JWT_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]])
  );
  process.env.JWT_SECRET = config.jwtSecret;
  process.env.JWT_EXPIRE = config.jwtExpire;
  process.env.JWT_ISSUER = config.jwtIssuer;
  process.env.JWT_AUDIENCE = config.jwtAudience;

  return () => {
    for (const key of JWT_ENVIRONMENT_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  };
}

async function startLocalE2E({
  argv = process.argv.slice(2),
  env = process.env,
  registerSignalHandlers = true
} = {}) {
  const options = resolveLocalE2EOptions({ argv, env });
  if (options.help) return Object.freeze({ help: true });
  if (mongoose.connection.readyState !== 0) {
    throw new Error('Local E2E refuses to replace an existing Mongoose connection');
  }

  const [dataDir, uploadDir] = await Promise.all([
    ensureIsolatedDirectory(options.dataDir, 'data-dir'),
    ensureIsolatedDirectory(options.uploadDir, 'upload-dir')
  ]);

  let replSet;
  let server;
  let restoreJwtEnvironment = null;
  let stopped = false;
  const signalHandlers = new Map();
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    const failures = [];
    try {
      await closeServer(server);
    } catch (error) {
      failures.push(error);
    }
    try {
      if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    } catch (error) {
      failures.push(error);
    }
    try {
      if (replSet) await replSet.stop({ doCleanup: false, force: false });
    } catch (error) {
      failures.push(error);
    }
    try {
      if (restoreJwtEnvironment) restoreJwtEnvironment();
      restoreJwtEnvironment = null;
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Local E2E shutdown did not complete cleanly');
  };

  try {
    replSet = await MongoMemoryReplSet.create({
      instanceOpts: [{
        dbName: options.databaseName,
        dbPath: dataDir,
        ip: LOOPBACK_HOST,
        port: options.mongoPort,
        storageEngine: 'wiredTiger'
      }],
      replSet: {
        count: 1,
        name: 'v2_local_e2e_rs',
        storageEngine: 'wiredTiger'
      }
    });
    const mongodbUri = replSet.getUri(options.databaseName);
    const config = loadEnvironment({
      APP_ENV: 'test',
      NODE_ENV: 'test',
      APP_INSTANCE: 'task-distribution-v2-local-e2e',
      PORT: String(options.port),
      MONGODB_URI: mongodbUri,
      JWT_SECRET: randomBytes(48).toString('base64url'),
      JWT_EXPIRE: '8h',
      JWT_ISSUER: 'task-distribution-v2-local-e2e',
      JWT_AUDIENCE: 'task-distribution-v2-local-clients',
      UPLOAD_PATH: uploadDir,
      MAX_FILE_SIZE: String(10 * 1024 * 1024),
      CORS_ORIGINS: 'http://127.0.0.1:3101,http://localhost:3101',
      ENABLE_LEGACY_PUBLIC_UPLOADS: 'false'
    });
    restoreJwtEnvironment = applyJwtEnvironment(config);

    await mongoose.connect(config.mongodbUri, {
      dbName: options.databaseName,
      autoIndex: true,
      serverSelectionTimeoutMS: 10_000
    });
    assertSeedDatabaseIsolation(mongoose.connection.name);
    const seed = await seedV2Demo({
      password: options.password,
      usernamePrefix: options.usernamePrefix,
      connection: mongoose.connection
    });
    server = await listen(createApp(config), options.port, options.host);

    if (registerSignalHandlers) {
      for (const signal of ['SIGINT', 'SIGTERM']) {
        const handler = () => {
          stop().catch((error) => {
            process.stderr.write(`${JSON.stringify({
              status: 'SHUTDOWN_FAILED',
              code: 'V2_LOCAL_E2E_SHUTDOWN_FAILED',
              message: error.message
            })}\n`);
            process.exitCode = 1;
          });
        };
        signalHandlers.set(signal, handler);
        process.once(signal, handler);
      }
    }

    return Object.freeze({
      help: false,
      url: `http://${options.host}:${options.port}`,
      seed,
      stop
    });
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  }
}

async function main() {
  const runtime = await startLocalE2E();
  if (runtime.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({
    status: 'READY',
    url: runtime.url,
    users: runtime.seed.users,
    teamIds: runtime.seed.teamIds
  })}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      status: 'FAILED',
      code: 'V2_LOCAL_E2E_START_FAILED',
      message: error.message
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_API_PORT,
  DEFAULT_DATABASE_NAME,
  DEFAULT_MONGO_PORT,
  LOOPBACK_HOST,
  TEST_DATA_ROOT,
  applyJwtEnvironment,
  assertPathInsideTestData,
  ensureIsolatedDirectory,
  main,
  parseArgs,
  resolveLocalE2EOptions,
  startLocalE2E,
  usage
};
