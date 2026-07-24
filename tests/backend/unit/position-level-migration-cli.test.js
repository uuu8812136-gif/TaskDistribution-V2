'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  main,
  parseArgs,
  usage
} = require('../../../app/script/migratePositionLevels');

test('position migration CLI defaults to dry-run and parses every execute guard', () => {
  assert.deepEqual(parseArgs([]), { execute: false });
  assert.deepEqual(parseArgs([
    '--execute',
    '--confirm-database=customer_acceptance_v2_test',
    '--backup-directory',
    'E:\\backups\\backup-1',
    '--report',
    'E:\\reports\\position-levels.json'
  ]), {
    execute: true,
    confirmDatabase: 'customer_acceptance_v2_test',
    backupDirectory: 'E:\\backups\\backup-1',
    report: 'E:\\reports\\position-levels.json'
  });
  assert.deepEqual(parseArgs(['--execute', '--dry-run']), { execute: false });
  assert.throws(() => parseArgs(['--unknown']), /Unknown option/);
  assert.match(usage(), /defaults to strict dry-run/);
  assert.match(usage(), /TEAM_LEADER 4 -> 5/);
  assert.match(usage(), /--backup-directory/);
});

test('position migration execute rejects a missing report before database access', async () => {
  await assert.rejects(main(['--execute']), (error) => error.code === 'REPORT_PATH_REQUIRED');
});
