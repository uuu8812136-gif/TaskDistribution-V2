#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const { assertV2TestMongoTarget } = require('../../ops/lib/v2TestMongoTargetGuard');
const {
  EXPECTED_DATABASE,
  assertSameReleaseMongoAnchor,
  captureReleaseMongoAnchor
} = require('../services/releaseMongoAnchorService');

dotenv.config({ path: process.env.ENV_FILE || path.resolve(__dirname, '../.env') });

const VALUE_OPTIONS = new Set([
  'release-id',
  'handoff-nonce',
  'confirm-database',
  'report',
  'compare-to'
]);

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const [name, inlineValue] = token.slice(2).split(/=(.*)/s, 2);
    if (!VALUE_OPTIONS.has(name)) throw new Error(`Unknown option: --${name}`);
    const value = inlineValue === undefined ? argv[++index] : inlineValue;
    if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
    result[name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  return result;
}

async function writeJsonCreateNew(file, value) {
  if (!path.isAbsolute(file)) throw new Error('--report must be an absolute path');
  const parent = path.dirname(file);
  const stat = await fs.promises.stat(parent);
  if (!stat.isDirectory()) throw new Error('--report parent must be an existing directory');
  const handle = await fs.promises.open(file, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readJsonFile(file, optionName) {
  if (!path.isAbsolute(file)) throw new Error(`${optionName} must be an absolute path`);
  const text = await fs.promises.readFile(file, 'utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${optionName} must contain valid JSON`);
  }
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.confirmDatabase !== EXPECTED_DATABASE) {
    const error = new Error(`--confirm-database must exactly equal ${EXPECTED_DATABASE}`);
    error.code = 'DATABASE_CONFIRMATION_MISMATCH';
    throw error;
  }
  if (!args.report) throw new Error('--report is required');
  const mongodbUri = process.env.MONGODB_URI;
  assertV2TestMongoTarget(mongodbUri);

  let connected = false;
  try {
    await mongoose.connect(mongodbUri, {
      dbName: EXPECTED_DATABASE,
      autoIndex: false,
      serverSelectionTimeoutMS: 10_000
    });
    connected = true;
    const report = await captureReleaseMongoAnchor({
      connection: mongoose.connection,
      releaseId: args.releaseId,
      handoffNonce: args.handoffNonce
    });
    const reportPath = path.resolve(args.report);
    await writeJsonCreateNew(reportPath, report);
    if (args.compareTo) {
      const comparePath = path.resolve(args.compareTo);
      if (comparePath === reportPath) throw new Error('--compare-to must differ from --report');
      const baseline = await readJsonFile(comparePath, '--compare-to');
      assertSameReleaseMongoAnchor(baseline, report);
    }
    process.stdout.write(`${JSON.stringify({
      status: args.compareTo ? 'REPLICA_WRITE_ANCHOR_UNCHANGED' : report.status,
      report: reportPath,
      comparedTo: args.compareTo ? path.resolve(args.compareTo) : null,
      writeAnchorSha256: report.writeAnchorSha256
    })}\n`);
    return report;
  } finally {
    if (connected) await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      status: 'REPLICA_WRITE_ANCHOR_FAILED',
      code: error.code || 'REPLICA_WRITE_ANCHOR_FAILED',
      message: error.message,
      details: error.details || null
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  parseArgs,
  readJsonFile,
  writeJsonCreateNew
};
