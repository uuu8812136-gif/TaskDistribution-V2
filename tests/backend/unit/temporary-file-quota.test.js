'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  assertTemporaryQuotaUsage,
  normalizeTemporaryFileLimits
} = require('../../../app/services/fileAssetService');
const { parseArguments } = require('../../../app/script/cleanupTemporaryFiles');

const LIMITS = Object.freeze({
  userMaxCount: 2,
  userMaxBytes: 100,
  teamMaxCount: 4,
  teamMaxBytes: 200
});

function expectQuotaCode(input, code) {
  assert.throws(
    () => assertTemporaryQuotaUsage({ limits: LIMITS, ...input }),
    (error) => error.status === 429 && error.code === code
  );
}

test('temporary upload quota enforces user and team counts and bytes independently', () => {
  assert.doesNotThrow(() => assertTemporaryQuotaUsage({
    userUsage: { count: 1, bytes: 50 },
    teamUsage: { count: 3, bytes: 150 },
    incomingBytes: 50,
    limits: LIMITS
  }));

  expectQuotaCode({
    userUsage: { count: 2, bytes: 1 },
    teamUsage: { count: 2, bytes: 1 },
    incomingBytes: 1
  }, 'TEMPORARY_FILE_USER_COUNT_LIMIT');
  expectQuotaCode({
    userUsage: { count: 0, bytes: 99 },
    teamUsage: { count: 0, bytes: 99 },
    incomingBytes: 2
  }, 'TEMPORARY_FILE_USER_BYTES_LIMIT');
  expectQuotaCode({
    userUsage: { count: 0, bytes: 0 },
    teamUsage: { count: 4, bytes: 1 },
    incomingBytes: 1
  }, 'TEMPORARY_FILE_TEAM_COUNT_LIMIT');
  expectQuotaCode({
    userUsage: { count: 0, bytes: 0 },
    teamUsage: { count: 0, bytes: 199 },
    incomingBytes: 2
  }, 'TEMPORARY_FILE_TEAM_BYTES_LIMIT');
});

test('temporary quota configuration and cleanup CLI reject unsafe values', () => {
  assert.deepEqual(normalizeTemporaryFileLimits(LIMITS), LIMITS);
  assert.throws(
    () => normalizeTemporaryFileLimits({ ...LIMITS, teamMaxCount: 1 }),
    /teamMaxCount/
  );
  assert.deepEqual(parseArguments([], { defaultMaxAgeHours: 12 }), {
    apply: false,
    maxAgeHours: 12,
    limit: 100
  });
  assert.deepEqual(parseArguments([
    '--apply',
    '--max-age-hours',
    '48',
    '--limit',
    '20'
  ]), {
    apply: true,
    maxAgeHours: 48,
    limit: 20
  });
  assert.throws(() => parseArguments(['--unknown']), /Unsupported option/);
});
