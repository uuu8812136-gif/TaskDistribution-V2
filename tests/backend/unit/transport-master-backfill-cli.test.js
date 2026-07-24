'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  failureReport,
  main,
  parseArgs,
  usage,
  writeJsonAtomic
} = require('../../../app/script/backfillTransportMasterData');

test('transport master backfill CLI defaults to dry-run', () => {
  assert.deepEqual(parseArgs([]), { execute: false });
  assert.deepEqual(parseArgs(['--dry-run']), { execute: false });
  assert.match(usage(), /dry-run by default/i);
  assert.match(usage(), /Historical trip, route, vehicle, driver and vehicle-type snapshots are never modified/);
});

test('transport master backfill execution parses every database, backup and report guard', async () => {
  assert.deepEqual(
    parseArgs([
      '--execute',
      '--confirm-database=customer_v2',
      '--backup-directory',
      'E:\\backups\\backup-1',
      '--report',
      'E:\\reports\\transport-master-data.json'
    ]),
    {
      execute: true,
      confirmDatabase: 'customer_v2',
      backupDirectory: 'E:\\backups\\backup-1',
      report: 'E:\\reports\\transport-master-data.json'
    }
  );
  assert.throws(() => parseArgs(['--unknown']), /Unknown option/);
  assert.throws(() => parseArgs(['--backup-directory']), /requires a value/);
  assert.match(usage(), /--backup-directory/);
  assert.match(usage(), /--report/);
  await assert.rejects(main(['--execute']), (error) => error.code === 'REPORT_PATH_REQUIRED');
});

test('transport master backfill writes immutable JSON execution evidence', async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'transport-master-report-'));
  const reportPath = path.join(directory, 'report.json');
  try {
    const report = failureReport({
      error: Object.assign(new Error('backup missing'), { code: 'BACKUP_DIRECTORY_REQUIRED' }),
      execute: true,
      databaseName: 'customer_v2'
    });
    assert.equal(await writeJsonAtomic(reportPath, report), reportPath);
    assert.deepEqual(JSON.parse(await fs.promises.readFile(reportPath, 'utf8')), report);
    await assert.rejects(writeJsonAtomic(reportPath, report), (error) => error.code === 'EEXIST');
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});
