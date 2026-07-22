'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { after, test } = require('node:test');

const TEST_ROOT = path.resolve(
  __dirname,
  '../../../.test-data',
  `task-review-stage-cli-${randomUUID()}`
);
const {
  failureReport,
  main,
  parseArgs,
  usage,
  writeJsonAtomic
} = require('../../../app/script/migrateTaskReviewStages');

after(async () => {
  assert.ok(TEST_ROOT.includes(`${path.sep}.test-data${path.sep}`));
  await fs.promises.rm(TEST_ROOT, { recursive: true, force: true });
});

test('CLI defaults to dry-run and parses every execute guard', () => {
  assert.deepEqual(parseArgs([]), { execute: false });
  assert.deepEqual(parseArgs([
    '--execute',
    '--confirm-database=task_distribution_v2',
    '--backup-directory',
    'E:\\backups\\backup-1',
    '--report',
    'E:\\reports\\migration.json'
  ]), {
    execute: true,
    confirmDatabase: 'task_distribution_v2',
    backupDirectory: 'E:\\backups\\backup-1',
    report: 'E:\\reports\\migration.json'
  });
  assert.deepEqual(parseArgs(['--execute', '--dry-run']), { execute: false });
  assert.throws(() => parseArgs(['--unknown']), /Unknown option/);
  assert.throws(() => parseArgs(['--backup-directory']), /requires a value/);
  assert.match(usage(), /defaults to strict dry-run/);
  assert.match(usage(), /--confirm-database/);
  assert.match(usage(), /--backup-directory/);
  assert.match(usage(), /--report/);
});

test('execute mode rejects a missing report path before connecting to MongoDB', async () => {
  await assert.rejects(
    main(['--execute']),
    (error) => error.code === 'REPORT_PATH_REQUIRED'
  );
});

test('failure report and atomic writer preserve operational evidence without a MongoDB URI', async () => {
  const error = Object.assign(new Error('index failed'), {
    code: 'INDEX_FAILED',
    details: {
      backup: { backupId: 'backup-1' },
      before: { blockers: [] },
      after: { blockers: [{ code: 'INDEX_FAILED' }] },
      writePerformed: true,
      completedSteps: [{ step: 'BACKFILL' }]
    }
  });
  const report = failureReport({
    error,
    execute: true,
    databaseName: 'task_distribution_v2'
  });
  const reportPath = path.join(TEST_ROOT, 'nested', 'report.json');
  await writeJsonAtomic(reportPath, report);
  const serialized = await fs.promises.readFile(reportPath, 'utf8');

  assert.equal(JSON.parse(serialized).writePerformed, true);
  assert.equal(JSON.parse(serialized).backup.backupId, 'backup-1');
  assert.deepEqual(JSON.parse(serialized).before, { blockers: [] });
  assert.deepEqual(JSON.parse(serialized).after, { blockers: [{ code: 'INDEX_FAILED' }] });
  assert.equal(serialized.includes('mongodb://'), false);
  assert.equal(
    (await fs.promises.readdir(path.dirname(reportPath))).some((name) => name.endsWith('.tmp')),
    false
  );
});

test('atomic writer never overwrites an existing report path', async () => {
  const reportPath = path.join(TEST_ROOT, 'immutable', 'report.json');
  await writeJsonAtomic(reportPath, { sequence: 1 });
  await assert.rejects(
    writeJsonAtomic(reportPath, { sequence: 2 }),
    (error) => error.code === 'EEXIST'
  );
  assert.deepEqual(JSON.parse(await fs.promises.readFile(reportPath, 'utf8')), { sequence: 1 });
  assert.equal(
    (await fs.promises.readdir(path.dirname(reportPath))).some((name) => name.endsWith('.tmp')),
    false
  );
});

test('migration implementation never invokes syncIndexes', async () => {
  const files = [
    '../../../app/server.js',
    '../../../app/models/TaskReview.js',
    '../../../app/services/taskReviewStageMigrationService.js',
    '../../../app/script/migrateTaskReviewStages.js'
  ];
  for (const relative of files) {
    const source = await fs.promises.readFile(path.resolve(__dirname, relative), 'utf8');
    assert.doesNotMatch(source, /syncIndexes\s*\(/, relative);
    assert.doesNotMatch(source, /ensureStageIndex/, relative);
  }
});
