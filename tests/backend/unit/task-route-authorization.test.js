'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const taskRouter = require('../../../app/routes/tasks');
const extensionRouter = require('../../../app/routes/extensions');
const { SESSION_MODES } = require('../../../app/config/permissions');

function routeLayer(path, method) {
  const layer = taskRouter.stack.find((candidate) => (
    candidate.route?.path === path && candidate.route.methods?.[method] === true
  ));
  assert.ok(layer, `${method.toUpperCase()} ${path} route must exist`);
  return layer.route.stack;
}

function extensionRouteLayer(path, method) {
  const layer = extensionRouter.stack.find((candidate) => (
    candidate.route?.path === path && candidate.route.methods?.[method] === true
  ));
  assert.ok(layer, `${method.toUpperCase()} ${path} route must exist`);
  return layer.route.stack;
}

function viewOnlyContext() {
  return {
    authenticated: true,
    mode: SESSION_MODES.TEAM,
    activeTeamId: '507f1f77bcf86cd799439011',
    userId: '507f1f77bcf86cd799439012',
    permissionKeys: ['task.view'],
    membership: { orgUnitId: '507f1f77bcf86cd799439013' },
    moduleDataScopes: { task: 'ORG_UNIT' },
    canAccessBusiness: true,
    readOnly: false
  };
}

function invokeMiddleware(middleware, authContext) {
  const result = { nextCalled: false, statusCode: 200, body: null };
  const response = {
    status(code) {
      result.statusCode = code;
      return this;
    },
    json(body) {
      result.body = body;
      return this;
    }
  };
  middleware({ authContext }, response, () => {
    result.nextCalled = true;
  });
  return result;
}

test('completion routes accept task.view before controller resource authorization', () => {
  for (const method of ['post', 'put']) {
    const stack = routeLayer('/:id/complete', method);
    assert.equal(stack[0].handle.name, 'requireTeamContext');
    const result = invokeMiddleware(stack[1].handle, viewOnlyContext());
    assert.equal(result.nextCalled, true);
    assert.equal(result.statusCode, 200);
  }
});

test('final confirmation accepts task.view before controller resource authorization', () => {
  const stack = routeLayer('/:id/confirm', 'post');
  assert.equal(stack[0].handle.name, 'requireTeamContext');
  const result = invokeMiddleware(stack[1].handle, viewOnlyContext());
  assert.equal(result.nextCalled, true);
  assert.equal(result.statusCode, 200);
});

test('CC review still requires task.review at the route boundary', () => {
  const stack = routeLayer('/:id/review', 'post');
  assert.equal(stack[0].handle.name, 'requireTeamContext');
  const result = invokeMiddleware(stack[1].handle, viewOnlyContext());
  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 403);
  assert.equal(result.body.code, 'PERMISSION_DENIED');
});

test('extension application accepts task.view before controller owner authorization', () => {
  const stack = extensionRouteLayer('/apply/:id', 'post');
  assert.equal(stack[0].handle.name, 'requireTeamContext');
  const result = invokeMiddleware(stack[1].handle, viewOnlyContext());
  assert.equal(result.nextCalled, true);
  assert.equal(result.statusCode, 200);
});

test('task editing and deletion still reject a view-only executor', () => {
  for (const [method, path] of [['put', '/:id'], ['delete', '/:id']]) {
    const stack = routeLayer(path, method);
    const result = invokeMiddleware(stack[1].handle, viewOnlyContext());
    assert.equal(result.nextCalled, false);
    assert.equal(result.statusCode, 403);
    assert.equal(result.body.code, 'PERMISSION_DENIED');
  }
});
