'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  assertRetention,
  requiredUsername,
  retentionResult,
  resolveOptions
} = require('../../../app/script/verifySuperAdminRetention');

test('super-admin retention requires an explicit username and database URI', () => {
  assert.throws(() => requiredUsername('  '), /SUPER_ADMIN_USERNAME is required/);
  assert.throws(() => resolveOptions({}), /MONGODB_URI is required/);
  assert.throws(
    () => resolveOptions({ MONGODB_URI: 'mongodb://localhost/test' }),
    /SUPER_ADMIN_USERNAME is required/
  );
  assert.deepEqual(
    resolveOptions({
      MONGODB_URI: 'mongodb://localhost/test',
      CUSTOMER_SUPER_ADMIN_USERNAME: ' customer_test_superadmin '
    }),
    {
      mongodbUri: 'mongodb://localhost/test',
      username: 'customer_test_superadmin'
    }
  );
});

test('super-admin retention accepts an active membership-free identity', () => {
  const result = retentionResult({
    username: 'customer_test_superadmin',
    user: {
      _id: 'user-a',
      status: 'active',
      isSuperAdmin: true,
      isSystemAccount: false
    },
    membershipCount: 0
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, 'SUPER_ADMIN_RETAINED');
  assert.doesNotThrow(() => assertRetention(result));
});

test('super-admin retention fails closed for missing, inactive, downgraded, or member identities', () => {
  const cases = [
    retentionResult({ username: 'missing', user: null, membershipCount: 0 }),
    retentionResult({
      username: 'inactive',
      user: { _id: 'user-b', status: 'inactive', isSuperAdmin: true },
      membershipCount: 0
    }),
    retentionResult({
      username: 'downgraded',
      user: { _id: 'user-c', status: 'active', isSuperAdmin: false },
      membershipCount: 0
    }),
    retentionResult({
      username: 'member',
      user: { _id: 'user-d', status: 'active', isSuperAdmin: true },
      membershipCount: 1
    })
  ];

  for (const result of cases) {
    assert.equal(result.ok, false);
    assert.throws(
      () => assertRetention(result),
      (error) => error.code === result.code
    );
  }
});
