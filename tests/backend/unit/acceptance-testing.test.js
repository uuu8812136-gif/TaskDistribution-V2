'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  acceptanceTestModeEnabled,
  isAcceptanceTimeRestrictionBypassed,
  timeBypassExpiresAt,
  timeBypassUsernames
} = require('../../../app/config/acceptanceTesting');

const context = Object.freeze({
  user: Object.freeze({ username: 'Customer_Test_SuperAdmin' })
});

test('acceptance time bypass requires both test mode and an exact username match', () => {
  assert.equal(acceptanceTestModeEnabled({}), false);
  assert.equal(acceptanceTestModeEnabled({ ACCEPTANCE_TEST_MODE: 'TRUE' }), true);
  assert.equal(isAcceptanceTimeRestrictionBypassed(context, {
    ACCEPTANCE_TEST_MODE: 'true',
    ACCEPTANCE_TIME_BYPASS_EXPIRES_AT: '2026-07-30T15:59:59.000Z'
  }), false);
  assert.equal(isAcceptanceTimeRestrictionBypassed(context, {
    ACCEPTANCE_TIME_BYPASS_USERNAMES: 'customer_test_superadmin',
    ACCEPTANCE_TIME_BYPASS_EXPIRES_AT: '2026-07-30T15:59:59.000Z'
  }), false);
  assert.equal(isAcceptanceTimeRestrictionBypassed(context, {
    ACCEPTANCE_TEST_MODE: 'true',
    ACCEPTANCE_TIME_BYPASS_USERNAMES: ' other-user, customer_test_superadmin ',
    ACCEPTANCE_TIME_BYPASS_EXPIRES_AT: '2026-07-30T15:59:59.000Z'
  }, new Date('2026-07-23T10:00:00.000Z')), true);
  assert.equal(isAcceptanceTimeRestrictionBypassed(context, {
    ACCEPTANCE_TEST_MODE: 'true',
    ACCEPTANCE_TIME_BYPASS_USERNAMES: 'customer_test_superadmin_extra',
    ACCEPTANCE_TIME_BYPASS_EXPIRES_AT: '2026-07-30T15:59:59.000Z'
  }, new Date('2026-07-23T10:00:00.000Z')), false);
});

test('acceptance time bypass fails closed when expiry is missing, invalid, or reached', () => {
  const base = {
    ACCEPTANCE_TEST_MODE: 'true',
    ACCEPTANCE_TIME_BYPASS_USERNAMES: 'customer_test_superadmin'
  };
  assert.equal(isAcceptanceTimeRestrictionBypassed(context, base), false);
  assert.equal(isAcceptanceTimeRestrictionBypassed(context, {
    ...base,
    ACCEPTANCE_TIME_BYPASS_EXPIRES_AT: 'not-a-date'
  }), false);
  assert.equal(isAcceptanceTimeRestrictionBypassed(context, {
    ...base,
    ACCEPTANCE_TIME_BYPASS_EXPIRES_AT: '2026-07-23T10:00:00.000Z'
  }, new Date('2026-07-23T10:00:00.000Z')), false);
  assert.equal(timeBypassExpiresAt({ ACCEPTANCE_TIME_BYPASS_EXPIRES_AT: 'not-a-date' }), null);
});

test('acceptance username parser normalizes case, whitespace, and duplicates', () => {
  assert.deepEqual([...timeBypassUsernames({
    ACCEPTANCE_TIME_BYPASS_USERNAMES: ' Alice,alice, BOB ,, '
  })], ['alice', 'bob']);
});
