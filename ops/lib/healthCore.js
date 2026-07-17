'use strict';

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { discoverCompletedBackups, verifyBackupSet } = require('./backupCore');

async function probeHttp(url, { fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  const started = Date.now();
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    return {
      ok: response.status >= 200 && response.status < 400,
      status: response.status,
      latencyMs: Date.now() - started
    };
  } catch (error) {
    return { ok: false, error: error.code || error.name || error.message, latencyMs: Date.now() - started };
  }
}

function probeTcp(host, port, { timeoutMs = 3000, netImpl = net } = {}) {
  const started = Date.now();
  return new Promise((resolve) => {
    const socket = netImpl.createConnection({ host, port });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ...result, latencyMs: Date.now() - started });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ ok: true }));
    socket.once('timeout', () => finish({ ok: false, error: 'TIMEOUT' }));
    socket.once('error', (error) => finish({ ok: false, error: error.code || error.message }));
  });
}

async function readLogSignals(filePath, { fsImpl = fs, tailBytes = 128 * 1024 } = {}) {
  if (!filePath) return { ok: true, configured: false, matches: [] };
  try {
    const stats = await fsImpl.promises.stat(filePath);
    const length = Math.min(stats.size, tailBytes);
    const handle = await fsImpl.promises.open(filePath, 'r');
    const buffer = Buffer.alloc(length);
    try {
      if (length) await handle.read(buffer, 0, length, stats.size - length);
    } finally {
      await handle.close();
    }
    const matches = buffer.toString('utf8').split(/\r?\n/)
      .filter((line) => /\b(?:fatal|unhandled|uncaught|panic)\b/i.test(line))
      .slice(-5);
    return { ok: matches.length === 0, configured: true, matches, modifiedAt: stats.mtime.toISOString() };
  } catch (error) {
    return { ok: false, configured: true, error: error.code || error.message, matches: [] };
  }
}

async function readBackupOperationHealth(filePath, { fsImpl = fs, tailBytes = 256 * 1024 } = {}) {
  try {
    const stats = await fsImpl.promises.stat(filePath);
    const length = Math.min(stats.size, tailBytes);
    const handle = await fsImpl.promises.open(filePath, 'r');
    const buffer = Buffer.alloc(length);
    try {
      if (length) await handle.read(buffer, 0, length, stats.size - length);
    } finally {
      await handle.close();
    }
    const records = buffer.toString('utf8').split(/\r?\n/)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter((record) => record && ['BACKUP_COMPLETED', 'BACKUP_FAILED'].includes(record.event));
    if (!records.length) return { ok: false, error: 'NO_BACKUP_OPERATION_EVENT' };
    const latest = records.at(-1);
    return {
      ok: latest.event === 'BACKUP_COMPLETED',
      lastEvent: latest.event,
      at: latest.at,
      backupId: latest.backupId,
      error: latest.event === 'BACKUP_FAILED' ? latest.code || 'BACKUP_FAILED' : undefined
    };
  } catch (error) {
    return { ok: false, error: error.code || error.message };
  }
}

async function backupHealth(backupRoot, maxAgeHours, { fsImpl = fs, now = () => new Date() } = {}) {
  try {
    const backups = await discoverCompletedBackups(backupRoot, fsImpl);
    if (!backups.length) return { ok: false, error: 'NO_COMPLETED_BACKUP' };
    backups.sort((left, right) => Date.parse(right.completedAt) - Date.parse(left.completedAt));
    const latest = backups[0];
    const verified = await verifyBackupSet(latest.directory, { fsImpl, verifyFiles: false });
    const ageHours = (now().getTime() - Date.parse(latest.completedAt)) / 3600000;
    return {
      ok: ageHours >= 0 && ageHours <= maxAgeHours,
      backupId: latest.backupId,
      completedAt: latest.completedAt,
      ageHours: Number(ageHours.toFixed(2)),
      manifestSha256: verified.manifestSha256,
      error: ageHours > maxAgeHours ? 'BACKUP_STALE' : undefined
    };
  } catch (error) {
    return { ok: false, error: error.code || error.message };
  }
}

async function diskHealth(targetPath, minimumFreeGb, { fsImpl = fs } = {}) {
  try {
    const stats = await fsImpl.promises.statfs(targetPath, { bigint: true });
    const freeBytes = stats.bavail * stats.bsize;
    const totalBytes = stats.blocks * stats.bsize;
    const minimumBytes = BigInt(minimumFreeGb) * 1024n * 1024n * 1024n;
    return {
      ok: freeBytes >= minimumBytes,
      freeGb: Number(freeBytes / (1024n * 1024n * 1024n)),
      totalGb: Number(totalBytes / (1024n * 1024n * 1024n)),
      minimumFreeGb
    };
  } catch (error) {
    return { ok: false, error: error.code || error.message, minimumFreeGb };
  }
}

async function collectHealth(config, dependencies = {}) {
  const [api, web, mongo, backup, disk, apiLog, webLog, backupOperation] = await Promise.all([
    probeHttp(config.apiUrl, dependencies),
    probeHttp(config.webUrl, dependencies),
    probeTcp('127.0.0.1', config.mongoPort, dependencies),
    backupHealth(config.backupRoot, config.backupMaxAgeHours, dependencies),
    diskHealth(config.backupRoot, config.diskMinimumFreeGb, dependencies),
    readLogSignals(config.apiLogPath, dependencies),
    readLogSignals(config.webLogPath, dependencies),
    readBackupOperationHealth(config.backupLogPath, dependencies)
  ]);
  const memory = {
    ok: os.freemem() / os.totalmem() >= 0.05,
    freeMb: Math.round(os.freemem() / 1024 / 1024),
    totalMb: Math.round(os.totalmem() / 1024 / 1024)
  };
  const checks = { api, web, mongo, backup, backupOperation, disk, memory, apiLog, webLog };
  return {
    status: Object.values(checks).every((check) => check.ok) ? 'HEALTHY' : 'DEGRADED',
    checkedAt: new Date().toISOString(),
    host: os.hostname(),
    checks
  };
}

function formatHealth(report, { color = process.stdout.isTTY } = {}) {
  const paint = (ok, value) => color
    ? `\u001b[${ok ? '32' : '31'}m${value}\u001b[0m`
    : value;
  const lines = [
    `TaskDistribution V2 Operations  ${report.checkedAt}  ${paint(report.status === 'HEALTHY', report.status)}`,
    ''.padEnd(88, '-')
  ];
  for (const [name, check] of Object.entries(report.checks)) {
    const details = Object.entries(check)
      .filter(([key, value]) => key !== 'ok' && value !== undefined && !Array.isArray(value))
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
    lines.push(`${paint(check.ok, check.ok ? 'OK  ' : 'FAIL')} ${name.padEnd(10)} ${details}`.trimEnd());
  }
  return `${lines.join('\n')}\n`;
}

module.exports = {
  backupHealth,
  collectHealth,
  diskHealth,
  formatHealth,
  probeHttp,
  probeTcp,
  readBackupOperationHealth,
  readLogSignals
};
