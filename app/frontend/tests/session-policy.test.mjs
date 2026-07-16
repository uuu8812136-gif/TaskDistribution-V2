import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SESSION_MODES,
  canUsePermission,
  hasPermission,
  normalizeModuleDataScopes,
  normalizeSessionContext
} from '../src/utils/sessionPolicy.js'

test('normalizes the authoritative context response', () => {
  const context = normalizeSessionContext({
    mode: SESSION_MODES.TEAM,
    activeTeamId: 'team-a',
    permissionKeys: ['task.view', 'task.view', 'task.edit'],
    moduleDataScopes: [
      { moduleKey: 'task', scope: 'ORG_UNIT' },
      { moduleKey: 'equipment', scope: 'TEAM' }
    ]
  })

  assert.deepEqual(context.permissionKeys, ['task.view', 'task.edit'])
  assert.deepEqual(context.moduleDataScopes, { task: 'ORG_UNIT', equipment: 'TEAM' })
  assert.equal(context.readOnly, false)
  assert.equal(context.canAccessBusiness, true)
})

test('global context permits configured reads but never write guards', () => {
  const context = normalizeSessionContext({
    mode: SESSION_MODES.GLOBAL_READ_ONLY,
    permissionKeys: ['task.view'],
    readOnly: true,
    canAccessBusiness: true
  })

  assert.equal(canUsePermission(context, 'task.view'), true)
  assert.equal(canUsePermission(context, 'task.view', { write: true }), false)
  assert.equal(canUsePermission(context, 'task.view', { teamRequired: true }), false)
})

test('permission matching supports explicit all and any policies', () => {
  const permissions = ['task.view', 'task.export']
  assert.equal(hasPermission(permissions, ['task.view', 'task.export']), true)
  assert.equal(hasPermission(permissions, ['task.edit', 'task.export'], 'any'), true)
  assert.equal(hasPermission(permissions, ['task.edit', 'task.create'], 'any'), false)
})

test('invalid scope payloads normalize to an empty map', () => {
  assert.deepEqual(normalizeModuleDataScopes(null), {})
  assert.deepEqual(normalizeModuleDataScopes('TEAM'), {})
})

test('an empty logged-out context cannot access business data', () => {
  assert.equal(normalizeSessionContext().canAccessBusiness, false)
})
