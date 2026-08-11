'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { createContractsRouter } = require('../../../app/routes/contracts');
const { SESSION_MODES } = require('../../../app/config/permissions');

const service = new Proxy({}, {
  get() {
    return async () => ({});
  }
});
const router = createContractsRouter({ service });

const ROUTES = Object.freeze([
  ['get', '/suppliers/export', 'contract.supplier.export'],
  ['post', '/suppliers/import', 'contract.supplier.import'],
  ['get', '/suppliers', 'contract.supplier.view'],
  ['post', '/records', 'contract.supplier.manage'],
  ['get', '/suppliers/:supplierId/records', 'contract.supplier.view'],
  ['post', '/suppliers/:supplierId/records', 'contract.supplier.manage'],
  ['get', '/suppliers/:supplierId', 'contract.supplier.view'],
  ['patch', '/suppliers/:supplierId', 'contract.supplier.manage'],
  ['get', '/records/:recordId', 'contract.supplier.view'],
  ['patch', '/records/:recordId', 'contract.supplier.manage'],
  ['delete', '/records/:recordId', 'contract.supplier.manage'],
  ['get', '/expiry-alerts/export', 'contract.expiry.export'],
  ['get', '/expiry-alerts', 'contract.expiry.view'],
  ['get', '/settlements/export', 'contract.settlement.export'],
  ['post', '/settlements/import', 'contract.settlement.import'],
  ['get', '/settlements', 'contract.settlement.view'],
  ['post', '/settlements', 'contract.settlement.manage'],
  ['get', '/settlements/:settlementId', 'contract.settlement.view'],
  ['patch', '/settlements/:settlementId', 'contract.settlement.manage'],
  ['delete', '/settlements/:settlementId', 'contract.settlement.manage']
]);

function layer(method, routePath) {
  const found = router.stack.find((candidate) => (
    candidate.route?.path === routePath && candidate.route.methods?.[method]
  ));
  assert.ok(found, `${method.toUpperCase()} ${routePath} must exist`);
  return found.route.stack;
}

function invoke(middleware, permissionKeys) {
  const result = { nextCalled: false, statusCode: 200, body: null };
  const res = {
    status(code) { result.statusCode = code; return this; },
    json(body) { result.body = body; return this; }
  };
  middleware({
    authContext: {
      authenticated: true,
      mode: SESSION_MODES.TEAM,
      activeTeamId: '507f1f77bcf86cd799439011',
      permissionKeys,
      canAccessBusiness: true,
      readOnly: false
    }
  }, res, () => { result.nextCalled = true; });
  return result;
}

test('every contract endpoint enforces its dedicated permission', () => {
  for (const [method, routePath, permission] of ROUTES) {
    const stack = layer(method, routePath);
    const permissionLayer = stack.find((item) => item.handle.name === 'permissionMiddleware');
    assert.ok(permissionLayer, `${method.toUpperCase()} ${routePath} permission middleware`);
    assert.equal(invoke(permissionLayer.handle, [permission]).nextCalled, true);
    const denied = invoke(permissionLayer.handle, ['task.view']);
    assert.equal(denied.nextCalled, false);
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.body.code, 'PERMISSION_DENIED');
  }
  assert.deepEqual(
    [...new Set(ROUTES.map((item) => item[2]))].sort(),
    [
      'contract.expiry.export', 'contract.expiry.view',
      'contract.settlement.export', 'contract.settlement.import',
      'contract.settlement.manage', 'contract.settlement.view',
      'contract.supplier.export', 'contract.supplier.import',
      'contract.supplier.manage', 'contract.supplier.view'
    ]
  );
});

test('every contract write requires team context and rejects client teamId', () => {
  for (const [method, routePath] of ROUTES.filter(([method]) => method !== 'get')) {
    const stack = layer(method, routePath);
    assert.ok(stack.some((item) => item.handle.name === 'requireTeamContext'),
      `${method.toUpperCase()} ${routePath} team context`);
    assert.ok(stack.some((item) => item.handle.name === 'rejectWriteTeamId'),
      `${method.toUpperCase()} ${routePath} immutable teamId`);
  }
});

test('app injects the validated private upload root into the contract router', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../../app/app.js'), 'utf8');
  assert.match(source, /createContractsRouter\(\{\s*storageRoot:\s*config\.uploadPath\s*\}\)/);
  assert.equal(ROUTES.length, 20);
});

test('supplier overview has no independent create or delete route', () => {
  assert.equal(router.stack.some((candidate) => (
    candidate.route?.path === '/suppliers' && candidate.route.methods?.post
  )), false);
  assert.equal(router.stack.some((candidate) => (
    candidate.route?.path === '/suppliers/:supplierId' && candidate.route.methods?.delete
  )), false);
});
