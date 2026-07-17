'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  formatHealth,
  probeHttp,
  readBackupOperationHealth,
  readLogSignals
} = require('../../../ops/lib/healthCore');

test('HTTP probe reports status and latency without throwing', async () => {
  assert.equal((await probeHttp('http://local.test', {
    fetchImpl: async () => ({ status: 204 })
  })).ok, true);
  const degraded = await probeHttp('http://local.test', {
    fetchImpl: async () => ({ status: 503 })
  });
  assert.equal(degraded.ok, false);
  assert.equal(degraded.status, 503);
  const failure = await probeHttp('http://local.test', {
    fetchImpl: async () => { throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' }); }
  });
  assert.equal(failure.ok, false);
  assert.equal(failure.error, 'ECONNREFUSED');
});

test('latest failed backup event degrades health even while an older backup exists', async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(__dirname, '../../../.test-data/health-ops-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const logPath = path.join(directory, 'operations.jsonl');
  await fs.promises.writeFile(logPath, [
    JSON.stringify({ at: '2026-07-17T01:00:00Z', event: 'BACKUP_COMPLETED', backupId: 'backup-old' }),
    JSON.stringify({ at: '2026-07-17T02:00:00Z', event: 'BACKUP_FAILED', backupId: 'backup-new', code: 'MONGO_TOOL_FAILED' }),
    ''
  ].join('\n'));
  const result = await readBackupOperationHealth(logPath);
  assert.equal(result.ok, false);
  assert.equal(result.lastEvent, 'BACKUP_FAILED');
  assert.equal(result.error, 'MONGO_TOOL_FAILED');
});

test('log signal scan only flags decisive fatal process errors', async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(__dirname, '../../../.test-data/health-log-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const logPath = path.join(directory, 'api.log');
  await fs.promises.writeFile(logPath, 'request returned error 400\nFATAL database unavailable\n');
  const result = await readLogSignals(logPath);
  assert.equal(result.ok, false);
  assert.deepEqual(result.matches, ['FATAL database unavailable']);
});

test('health terminal formatter is stable and usable without ANSI colors', () => {
  const output = formatHealth({
    status: 'DEGRADED',
    checkedAt: '2026-07-17T00:00:00.000Z',
    checks: {
      api: { ok: true, status: 200 },
      backup: { ok: false, error: 'BACKUP_STALE' }
    }
  }, { color: false });
  assert.match(output, /DEGRADED/);
  assert.match(output, /OK\s+api/);
  assert.match(output, /FAIL backup/);
});
