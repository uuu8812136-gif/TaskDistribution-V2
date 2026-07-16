'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { after, test } = require('node:test');

const TEST_ROOT = path.resolve(
  __dirname,
  '../../../.test-data',
  `legacy-migration-cli-${randomUUID()}`
);

// Importing the CLI is itself part of this test: the main routine must not run.
const {
  parseArgs,
  writeJsonAtomic
} = require('../../../app/script/migrateLegacyTenant');

after(async () => {
  assert.ok(TEST_ROOT.includes(`${path.sep}.test-data${path.sep}`));
  await fs.promises.rm(TEST_ROOT, { recursive: true, force: true });
});

test('CLI parser defaults to dry-run and supports separated and inline values', () => {
  assert.deepEqual(parseArgs([]), { execute: false });
  assert.deepEqual(
    parseArgs([
      '--execute',
      '--confirm-database=sample_v2_staging',
      '--super-admin-username',
      'admin'
    ]),
    {
      execute: true,
      confirmDatabase: 'sample_v2_staging',
      superAdminUsername: 'admin'
    }
  );
  assert.deepEqual(parseArgs(['--execute', '--dry-run']), { execute: false });
  assert.throws(() => parseArgs(['--unknown']), /Unknown option/);
  assert.throws(() => parseArgs(['--confirm-database']), /requires a value/);
});

test('CLI report writer creates valid JSON atomically', async () => {
  const reportPath = path.join(TEST_ROOT, 'nested', 'report.json');
  const resolved = await writeJsonAtomic(reportPath, {
    status: 'DRY_RUN_READY',
    writePerformed: false
  });
  assert.equal(resolved, path.resolve(reportPath));
  assert.deepEqual(JSON.parse(await fs.promises.readFile(reportPath, 'utf8')), {
    status: 'DRY_RUN_READY',
    writePerformed: false
  });
  assert.equal(
    (await fs.promises.readdir(path.dirname(reportPath))).some((name) => name.endsWith('.tmp')),
    false
  );
});
