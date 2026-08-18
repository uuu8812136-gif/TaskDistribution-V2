'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  PRODUCTION_CONFIRMATION,
  READ_ONLY_PERMISSION_KEYS,
  assertProvisioningTarget,
  resolveProvisioningOptions,
  teamScopes,
  validatePassword,
  validateUsername
} = require('../../../app/script/provisionReadOnlyDemoAccount');

test('read-only demo provisioning accepts only isolated V2 databases by default', () => {
  assert.equal(assertProvisioningTarget('customer_acceptance_v2_test', ''), 'customer_acceptance_v2_test');
  assert.throws(
    () => assertProvisioningTarget('customer_production', ''),
    /Refusing read-only demo provisioning/
  );
  assert.equal(
    assertProvisioningTarget('customer_production', PRODUCTION_CONFIRMATION),
    'customer_production'
  );
});

test('read-only demo credentials and permission catalog are constrained', () => {
  assert.equal(validateUsername('  demo_readonly  '), 'demo_readonly');
  assert.throws(() => validateUsername('  '), /3-50 characters/);
  assert.doesNotThrow(() => validatePassword('Long-enough-demo-password!'));
  assert.throws(() => validatePassword('short'), /10-128/);
  assert.ok(READ_ONLY_PERMISSION_KEYS.length > 0);
  assert.ok(READ_ONLY_PERMISSION_KEYS.every((permission) => permission.endsWith('.view')));
  assert.ok(!READ_ONLY_PERMISSION_KEYS.includes('equipment.edit'));
  assert.ok(!READ_ONLY_PERMISSION_KEYS.includes('report.submit'));
  assert.ok(teamScopes().every(({ scope }) => scope === 'TEAM'));
});

test('environment options require the password but keep production confirmation separate', () => {
  const options = resolveProvisioningOptions({
    MONGODB_URI: 'mongodb://localhost/customer_acceptance_v2_test',
    READONLY_DEMO_USERNAME: ' demo_readonly ',
    READONLY_DEMO_PASSWORD: 'Long-enough-demo-password!'
  });
  assert.equal(options.username, 'demo_readonly');
  assert.equal(options.productionConfirmation, '');
  assert.equal(Object.prototype.hasOwnProperty.call(options, 'password'), true);
});
