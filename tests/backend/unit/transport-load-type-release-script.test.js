'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../../..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('transport load-type activation is packaged and syntax-checked as a release operation', () => {
  const scriptPath = 'ops/linux/activate-v2-test-transport-load-types.sh';
  const packageScript = read('ops/windows/New-V2TestReleasePackage.ps1');
  const prepareScript = read('ops/linux/prepare-v2-test-candidate.sh');
  const commonScript = read('ops/linux/v2-test-release-common.sh');

  assert.match(packageScript, new RegExp(scriptPath.replaceAll('/', '\\/')));
  assert.match(prepareScript, /bash -n .*activate-v2-test-transport-load-types\.sh/);
  assert.match(commonScript, /ops\/linux\/activate-v2-test-transport-load-types\.sh/);
});

test('transport load-type activation locks the exact one-time write and rollback evidence', () => {
  const source = read('ops/linux/activate-v2-test-transport-load-types.sh');

  for (const required of [
    'defaultLoadTypeTeamsToInitialize !== 2',
    'defaultLoadTypesToCreate !== 28',
    'report.recordsToUpdate !== 0',
    'report.mastersCreated !== 28',
    'report.recordsUpdated !== 0',
    'state.audits.length !== 2',
    'codeOnlyRollbackAllowed: false',
    'v2_transport_snapshot_digest',
    'v2_verify_transport_release_state'
  ]) {
    assert.ok(source.includes(required), `missing release guard: ${required}`);
  }
});
