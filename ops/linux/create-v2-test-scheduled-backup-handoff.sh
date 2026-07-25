#!/usr/bin/env bash
set -euo pipefail

readonly current_link='/opt/taskdistribution-v2-test/current'
readonly volume_root='/mnt/taskdistribution-v2-test-backup'
readonly backup_root="${volume_root}/backups"
readonly handoff_root="${volume_root}/handoffs"
readonly operations_log="${volume_root}/logs/operations.jsonl"

current="$(readlink -f "$current_link")"
test -d "$current" || {
  echo 'Current V2 release cannot be resolved' >&2
  exit 1
}
source_release_id="$(basename "$current")"
mkdir -p "$handoff_root"

/usr/bin/node - "$backup_root" "$handoff_root" "$operations_log" "$source_release_id" <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const [backupRoot, handoffRoot, operationsLog, sourceReleaseId] = process.argv.slice(2);
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{5,95}$/.test(sourceReleaseId)) {
  throw new Error('Current release id is invalid');
}
const events = fs.readFileSync(operationsLog, 'utf8').trim().split(/\r?\n/)
  .map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  })
  .filter((entry) => entry && ['BACKUP_COMPLETED', 'BACKUP_FAILED'].includes(entry.event));
const latest = events.at(-1);
if (!latest || latest.event !== 'BACKUP_COMPLETED') {
  throw new Error('Latest backup operation did not complete successfully');
}
const backupId = String(latest.backupId || '');
if (!/^backup-\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(backupId)) {
  throw new Error('Latest backup id is invalid');
}
const directory = path.join(backupRoot, backupId);
const manifestPath = path.join(directory, 'manifest.json');
const digestPath = path.join(directory, 'manifest.sha256');
const manifestBytes = fs.readFileSync(manifestPath);
const manifestSha256 = crypto.createHash('sha256').update(manifestBytes).digest('hex');
const digestMatch = /^([a-f0-9]{64})\s+manifest\.json\s*$/i.exec(fs.readFileSync(digestPath, 'utf8'));
if (!digestMatch || digestMatch[1].toLowerCase() !== manifestSha256) {
  throw new Error('Latest backup manifest digest mismatch');
}
const manifest = JSON.parse(manifestBytes);
const completionLagMs = Date.parse(latest.at) - Date.parse(manifest.completedAt);
if (manifest.format !== 'task-distribution-v2-backup/v1' ||
    manifest.backupId !== backupId || latest.manifestSha256 !== manifestSha256 ||
    !Number.isFinite(completionLagMs) || completionLagMs < 0 || completionLagMs > 300000) {
  throw new Error('Latest backup operation and manifest do not match');
}
const handoff = {
  format: 'task-distribution-v2-scheduled-backup-handoff/v1',
  createdAt: new Date().toISOString(),
  sourceReleaseId,
  backupId,
  completedAt: manifest.completedAt,
  manifestSha256,
  database: manifest.database?.name || null,
  files: Array.isArray(manifest.files) ? manifest.files.length : null,
  bytes: Array.isArray(manifest.files)
    ? manifest.files.reduce((total, entry) => total + Number(entry.bytes || 0), 0)
    : null
};
const target = path.join(handoffRoot, `${backupId}.json`);
const temporary = `${target}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(handoff, null, 2)}\n`, { mode: 0o640 });
fs.renameSync(temporary, target);
process.stdout.write(`${JSON.stringify(handoff)}\n`);
NODE

setfacl -m u:serveradmin:--x "$volume_root"
setfacl -R -m u:serveradmin:rX "$backup_root" "$handoff_root"
setfacl -m u:serveradmin:r "$operations_log"
