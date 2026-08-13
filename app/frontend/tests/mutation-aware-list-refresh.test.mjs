import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { createMutationAwareListRefreshTracker } from '../src/utils/mutationAwareListRefresh.js'
import {
  SUCCESSFUL_MUTATION_SCOPES as S,
  getSuccessfulMutationRevision,
  isBusinessMutationRequest,
  recordSuccessfulMutationRequest,
  resolveSuccessfulMutationScopes
} from '../src/utils/successfulMutationRevision.js'

test('successful writes resolve to explicit resource scopes', () => {
  const cases = [
    ['/contracts/suppliers/1', 'patch', [S.CONTRACT_SUPPLIERS, S.CONTRACT_EXPIRY_ALERTS, S.CONTRACT_SETTLEMENTS]],
    ['/contracts/records/1', 'delete', [S.CONTRACT_SUPPLIERS, S.CONTRACT_EXPIRY_ALERTS, S.CONTRACT_SETTLEMENTS]],
    ['/contracts/settlements/1', 'patch', [S.CONTRACT_SETTLEMENTS]],
    ['/equipment', 'post', [S.EQUIPMENT]],
    ['/equipment/categories/1', 'patch', [S.EQUIPMENT_CATEGORIES, S.EQUIPMENT_RULES]],
    ['/equipment/routine-rules/1', 'patch', [S.EQUIPMENT_RULES, S.EQUIPMENT_ROUTINES]],
    ['/equipment/routine-worker/run', 'post', [S.EQUIPMENT_ROUTINES]],
    ['/equipment/1/routine-records', 'post', [S.EQUIPMENT_ROUTINES]],
    ['/equipment/inventories/1/submit', 'post', [S.EQUIPMENT_INVENTORIES]],
    ['/equipment/repairs/1/actions', 'post', [S.EQUIPMENT_REPAIRS]],
    ['/tasks/1/complete', 'post', [S.TASKS]],
    ['/extensions/approve/1', 'post', [S.EXTENSIONS, S.TASKS]],
    ['/transport-records/1', 'patch', [S.TRANSPORT_RECORDS]],
    ['/attendance-submissions/summary/daily/2026-08-13/review', 'post', [S.ATTENDANCE_REPORTS]],
    ['/production-schedules/monthly/2026-08', 'put', [S.PRODUCTION_SCHEDULES]],
    ['/generated-daily-reports/2026-08-13/generate', 'post', [S.GENERATED_DAILY_REPORTS]],
    ['/team-members/1', 'patch', [S.TEAM_MEMBERS]],
    ['/org-units/1', 'delete', [S.ORGANIZATION]],
    ['/teams/1/status', 'patch', [S.TEAMS]],
    ['/users/1', 'put', [S.USERS]],
    ['/messages/1', 'delete', [S.MESSAGES]]
  ]

  for (const [url, method, scopes] of cases) {
    assert.deepEqual(resolveSuccessfulMutationScopes({ method, url }), scopes, `${method} ${url}`)
  }
})

test('status-application transitions invalidate every affected list scope in one sequence', () => {
  const config = { method: 'post', url: '/api/equipment/status-applications/1/actions?teamId=t1' }
  assert.deepEqual(resolveSuccessfulMutationScopes(config), [
    S.EQUIPMENT_STATUS_APPLICATIONS,
    S.EQUIPMENT,
    S.EQUIPMENT_ROUTINES
  ])

  const beforeStatus = getSuccessfulMutationRevision(S.EQUIPMENT_STATUS_APPLICATIONS)
  const beforeEquipment = getSuccessfulMutationRevision(S.EQUIPMENT)
  const beforeRoutines = getSuccessfulMutationRevision(S.EQUIPMENT_ROUTINES)
  assert.equal(recordSuccessfulMutationRequest(config), true)
  const after = getSuccessfulMutationRevision(S.EQUIPMENT_STATUS_APPLICATIONS)
  assert.ok(after > beforeStatus)
  assert.equal(getSuccessfulMutationRevision(S.EQUIPMENT), after)
  assert.equal(getSuccessfulMutationRevision(S.EQUIPMENT_ROUTINES), after)
  assert.ok(after > beforeEquipment)
  assert.ok(after > beforeRoutines)
})

test('view and auxiliary requests do not invalidate business scopes', () => {
  const requests = [
    { method: 'get', url: '/tasks' },
    { method: 'post', url: '/auth/login' },
    { method: 'post', url: '/auth/switch-team' },
    { method: 'post', url: '/files' },
    { method: 'delete', url: '/files/1' },
    { method: 'post', url: '/equipment/1/qrcode' },
    { method: 'post', url: '/equipment/imports' },
    { method: 'post', url: '/equipment/imports/1/cancel' },
    { method: 'post', url: '/tasks/export' }
  ]
  for (const config of requests) {
    assert.deepEqual(resolveSuccessfulMutationScopes(config), [], `${config.method} ${config.url}`)
    assert.equal(isBusinessMutationRequest(config), false)
  }
})

test('unknown writes are isolated in global and explicit overrides remain available', () => {
  assert.deepEqual(resolveSuccessfulMutationScopes({ method: 'post', url: '/future-resource/1' }), [S.GLOBAL])
  assert.deepEqual(resolveSuccessfulMutationScopes({ method: 'post', url: '/tasks', trackSuccessfulMutation: false }), [])
  assert.deepEqual(resolveSuccessfulMutationScopes({
    method: 'post',
    url: '/files',
    trackSuccessfulMutation: true,
    successfulMutationScopes: [S.TASKS, S.EXTENSIONS]
  }), [S.TASKS, S.EXTENSIONS])
  assert.deepEqual(resolveSuccessfulMutationScopes({
    method: 'post',
    url: '/future-resource/1',
    trackSuccessfulMutation: S.USERS
  }), [S.USERS])
})

test('trackers require explicit scopes and ignore unrelated mutations', async () => {
  assert.throws(() => createMutationAwareListRefreshTracker(), /at least one mutation scope/)
  const tracker = createMutationAwareListRefreshTracker({ scopes: S.TASKS })
  let refreshes = 0

  recordSuccessfulMutationRequest({ method: 'post', url: '/contracts/records' })
  recordSuccessfulMutationRequest({ method: 'post', url: '/future-resource' })
  assert.equal(tracker.shouldRefresh(), false)
  assert.equal(await tracker.refreshIfNeeded(() => { refreshes += 1; return true }), false)

  recordSuccessfulMutationRequest({ method: 'post', url: '/tasks' })
  assert.equal(tracker.shouldRefresh(), true)
  assert.equal(await tracker.refreshIfNeeded(() => { refreshes += 1; return true }), true)
  assert.equal(refreshes, 1)
  assert.equal(await tracker.refreshIfNeeded(() => { refreshes += 1; return true }), false)
})

test('a tracker can subscribe to multiple related scopes', async () => {
  const tracker = createMutationAwareListRefreshTracker({ scopes: [S.TASKS, S.EXTENSIONS, S.TASKS] })
  assert.deepEqual(tracker.scopes(), [S.TASKS, S.EXTENSIONS])
  let refreshes = 0

  recordSuccessfulMutationRequest({ method: 'post', url: '/extensions/apply/1' })
  assert.equal(await tracker.refreshIfNeeded(() => { refreshes += 1; return true }), true)
  assert.equal(refreshes, 1)
})

test('failed refresh stays pending and concurrent activation keeps later mutations', async () => {
  let revision = 10
  let releaseRefresh
  let refreshes = 0
  const tracker = createMutationAwareListRefreshTracker({
    scopes: S.TASKS,
    readRevision: () => revision
  })

  revision += 1
  await assert.rejects(tracker.refreshIfNeeded(() => Promise.reject(new Error('load failed'))), /load failed/)
  assert.equal(tracker.shouldRefresh(), true)

  const first = tracker.refreshIfNeeded(() => {
    refreshes += 1
    return new Promise((resolve) => {
      releaseRefresh = () => resolve(true)
    })
  })
  const second = tracker.refreshIfNeeded(() => { refreshes += 1; return true })
  await Promise.resolve()
  revision += 1
  releaseRefresh()

  assert.equal(await first, true)
  assert.equal(await second, true)
  assert.equal(refreshes, 1)
  assert.equal(tracker.shouldRefresh(), true)
  assert.equal(await tracker.refreshIfNeeded(() => { refreshes += 1; return true }), true)
  assert.equal(refreshes, 2)
})

test('successful loads acknowledge only the revision visible when loading began', () => {
  let revision = 30
  const tracker = createMutationAwareListRefreshTracker({
    scopes: S.CONTRACT_SETTLEMENTS,
    readRevision: () => revision
  })
  revision += 1
  const loadStartRevision = tracker.currentRevision()
  revision += 1
  tracker.markThrough(loadStartRevision)
  assert.equal(tracker.handledRevision(), 31)
  assert.equal(tracker.shouldRefresh(), true)
})

test('request interceptor records successful config only after stale-context validation', () => {
  const source = readFileSync(new URL('../src/utils/request.js', import.meta.url), 'utf8')
  const assertionIndex = source.indexOf('assertCurrentContext(response.config)')
  const mutationIndex = source.indexOf('recordSuccessfulMutationRequest(response.config)')
  assert.ok(assertionIndex >= 0)
  assert.ok(mutationIndex > assertionIndex)
})
