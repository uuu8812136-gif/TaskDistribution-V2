#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { parseEnvText } = require('./operationsConfig');

const EXPECTED_V2_TEST_MONGO_TARGET = Object.freeze({
  protocol: 'mongodb:',
  hostname: '127.0.0.1',
  port: '27150',
  database: 'customer_acceptance_v2_test',
  replicaSet: 'customer_acceptance_v2_rs'
});

class V2TestMongoTargetError extends Error {
  constructor(fields) {
    super(`MongoDB target does not match the isolated V2 test instance: ${fields.join(', ')}`);
    this.name = 'V2TestMongoTargetError';
    this.code = 'V2_TEST_MONGODB_TARGET_INVALID';
    this.fields = fields;
  }
}

function assertV2TestMongoTarget(uri) {
  let parsed;
  try {
    parsed = new URL(String(uri || '').trim());
  } catch {
    throw new V2TestMongoTargetError(['uri']);
  }

  const expected = EXPECTED_V2_TEST_MONGO_TARGET;
  const failures = [];
  if (parsed.protocol !== expected.protocol) failures.push('protocol');
  if (parsed.hostname !== expected.hostname) failures.push('hostname');
  if (parsed.port !== expected.port) failures.push('port');

  let database = '';
  try {
    database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  } catch {
    failures.push('databaseEncoding');
  }
  if (database !== expected.database) failures.push('database');

  const replicaSets = [...parsed.searchParams.entries()]
    .filter(([name]) => name.toLowerCase() === 'replicaset')
    .map(([, value]) => value);
  if (replicaSets.length !== 1 || replicaSets[0] !== expected.replicaSet) {
    failures.push('replicaSet');
  }
  if (parsed.hash) failures.push('hash');

  if (failures.length) throw new V2TestMongoTargetError([...new Set(failures)]);
  return Object.freeze({ ...expected });
}

function readMongoUriFromEnvironmentFile(file, { fsImpl = fs } = {}) {
  let values;
  try {
    values = parseEnvText(fsImpl.readFileSync(file, 'utf8'));
  } catch {
    throw new V2TestMongoTargetError(['environmentFile']);
  }
  const uri = values.MONGODB_URI;
  if (typeof uri !== 'string' || !uri.trim()) {
    throw new V2TestMongoTargetError(['MONGODB_URI']);
  }
  return uri.trim();
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function main(argv = process.argv.slice(2)) {
  let uri;
  if (argv.length === 1 && argv[0] === '--stdin') {
    uri = await readStdin();
  } else if (argv.length === 2 && argv[0] === '--env-file') {
    uri = readMongoUriFromEnvironmentFile(argv[1]);
  } else {
    throw new Error('Usage: node v2TestMongoTargetGuard.js (--stdin | --env-file <file>)');
  }
  const target = assertV2TestMongoTarget(uri);
  process.stdout.write(`${JSON.stringify({ status: 'V2_TEST_MONGODB_TARGET_OK', target })}\n`);
  return target;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      status: 'V2_TEST_MONGODB_TARGET_INVALID',
      code: error.code || 'V2_TEST_MONGODB_TARGET_GUARD_FAILED',
      message: error.message,
      fields: error.fields || undefined
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  EXPECTED_V2_TEST_MONGO_TARGET,
  V2TestMongoTargetError,
  assertV2TestMongoTarget,
  main,
  readMongoUriFromEnvironmentFile,
  readStdin
};
