import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SESSION_MODES,
  canUsePermission,
  getSessionEntryRoute,
  normalizeSessionContext
} from '../utils/sessionPolicy.js'
import {
  createRequestContextTracker,
  createScopedCacheKey,
  belongsToScopedIdentity,
  isStaleContextResponseError
} from '../utils/sessionCore.js'
import { formatDate, parseDate } from '../utils/format.js'
import { joinHttpUrl } from '../utils/url.js'

test('normalizes authoritative team permissions and scopes', () => {
  const context = normalizeSessionContext({
    mode: SESSION_MODES.TEAM,
    activeTeamId: 'team-a',
    permissionKeys: ['task.view', 'task.view', 'task.edit'],
    moduleDataScopes: [{ moduleKey: 'task', scope: 'ORG_UNIT' }]
  })

  assert.deepEqual(context.permissionKeys, ['task.view', 'task.edit'])
  assert.deepEqual(context.moduleDataScopes, { task: 'ORG_UNIT' })
  assert.equal(canUsePermission(context, 'task.edit', { write: true }), true)
})

test('global read-only context never exposes write capability', () => {
  const context = normalizeSessionContext({
    mode: SESSION_MODES.GLOBAL_READ_ONLY,
    permissionKeys: ['task.view', 'task.edit'],
    readOnly: true
  })

  assert.equal(canUsePermission(context, 'task.view'), true)
  assert.equal(canUsePermission(context, 'task.edit', { write: true }), false)
  assert.equal(canUsePermission(context, 'task.view', { teamRequired: true }), false)
})

test('team super administrators keep feature access when the permission list is empty', () => {
  const context = normalizeSessionContext({
    mode: SESSION_MODES.TEAM,
    activeTeamId: 'team-a',
    isSuperAdmin: true,
    permissionKeys: [],
    readOnly: false,
    canAccessBusiness: true
  })

  assert.equal(canUsePermission(context, 'contract.settlement.manage', { write: true }), true)
  assert.equal(canUsePermission(context, 'new.feature.permission'), true)
})

test('global read-only super administrators remain read-only without a read grant', () => {
  const context = normalizeSessionContext({
    mode: SESSION_MODES.GLOBAL_READ_ONLY,
    isSuperAdmin: true,
    permissionKeys: [],
    readOnly: true,
    canAccessBusiness: true
  })

  assert.equal(canUsePermission(context, 'task.view'), false)
  assert.equal(canUsePermission(context, 'task.create', { write: true }), false)
})

test('team selection routes to the mandatory team chooser', () => {
  assert.equal(getSessionEntryRoute(SESSION_MODES.TEAM_SELECTION), '/pages/team/select')
  assert.equal(getSessionEntryRoute(SESSION_MODES.TEAM), '/pages/task/received')
})

test('late responses are rejected after a token rotation', () => {
  let token = 'old-token'
  const tracker = createRequestContextTracker(() => token)
  const oldRequest = tracker.capture()

  tracker.advance()
  token = 'new-token'

  assert.throws(
    () => tracker.assertCurrent(oldRequest),
    (error) => isStaleContextResponseError(error)
  )
  assert.doesNotThrow(() => tracker.assertCurrent(tracker.capture()))
})

test('a stale token is rejected even before an epoch advance', () => {
  let token = 'old-token'
  const tracker = createRequestContextTracker(() => token)
  const request = tracker.capture()
  token = 'unexpected-token'
  assert.throws(() => tracker.assertCurrent(request), /登录状态已变更/)
})

test('non-context login responses are not coupled to the previous session', () => {
  let token = ''
  const tracker = createRequestContextTracker(() => token)
  const loginRequest = tracker.capture(false)
  tracker.advance()
  token = 'new-token'
  assert.doesNotThrow(() => tracker.assertCurrent(loginRequest))
})

test('business cache keys always include user and active team identity', () => {
  const identity = { userId: 'user/a', activeTeamId: 'team/b' }
  const key = createScopedCacheKey('messages:unread-count', identity)
  assert.match(key, /^v2:business:user%2Fa:team%2Fb:/)
  assert.equal(belongsToScopedIdentity(key, identity), true)
  assert.equal(belongsToScopedIdentity(key, { ...identity, activeTeamId: 'team-c' }), false)
  assert.throws(() => createScopedCacheKey('tasks', { userId: 'user-a' }), /会话缓存标识不完整/)
})

test('timezone-less extension dates use an iOS-compatible parse path', () => {
  const parsed = parseDate('2026-07-16 09:30:00')
  assert.equal(Number.isNaN(parsed.getTime()), false)
  assert.equal(formatDate(parsed, 'YYYY-MM-DD HH:mm'), '2026-07-16 09:30')
})

test('attachment URL joining removes boundary double slashes', () => {
  assert.equal(
    joinHttpUrl('http://127.0.0.1:18099/', '/uploads/team/file.png'),
    'http://127.0.0.1:18099/uploads/team/file.png'
  )
  assert.equal(
    joinHttpUrl('http://127.0.0.1:18099', '\\uploads\\team\\file.png'),
    'http://127.0.0.1:18099/uploads/team/file.png'
  )
})
