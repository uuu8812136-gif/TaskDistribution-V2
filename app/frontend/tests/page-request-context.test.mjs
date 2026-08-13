import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createPageConfirmationGuard,
  isSamePageRequestContext,
  pageRequestContextSnapshot
} from '../src/utils/pageRequestContext.js'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function context(overrides = {}) {
  return pageRequestContextSnapshot({
    route: { name: 'SupplierContractDetail', fullPath: '/contracts/suppliers/s1?teamId=t1' },
    session: { contextEpoch: 7, isGlobalReadOnly: true, activeTeamId: null },
    teamId: 't1',
    pageActive: true,
    ...overrides
  })
}

test('page request context stays current only in the same active route, auth epoch and team', () => {
  const original = context()
  assert.equal(isSamePageRequestContext(original, context()), true)
  assert.equal(isSamePageRequestContext(original, context({ teamId: 't2' })), false)
  assert.equal(isSamePageRequestContext(original, context({ pageActive: false })), false)
  assert.equal(isSamePageRequestContext(original, context({
    route: { name: 'SupplierContracts', fullPath: '/contracts/suppliers?teamId=t1' }
  })), false)
  assert.equal(isSamePageRequestContext(original, context({
    session: { contextEpoch: 8, isGlobalReadOnly: true, activeTeamId: null }
  })), false)
})

test('team mode snapshots use the authenticated active team instead of a query parameter', () => {
  const original = context({
    session: { contextEpoch: 3, isGlobalReadOnly: false, activeTeamId: 'active-team' },
    teamId: 'query-team'
  })
  assert.equal(original.teamId, 'active-team')
})

test('confirmation opened in team A cannot mutate after switching to team B', async () => {
  const state = {
    route: { name: 'MessageList', fullPath: '/messages' },
    session: { contextEpoch: 1, isGlobalReadOnly: false, activeTeamId: 'team-a' },
    pageActive: true
  }
  const confirm = deferred()
  let mutationCount = 0
  const guard = createPageConfirmationGuard(() => pageRequestContextSnapshot(state))

  const pending = guard.run({
    confirm: () => confirm.promise,
    mutate: async () => { mutationCount += 1 }
  })
  await Promise.resolve()
  state.session = { ...state.session, contextEpoch: 2, activeTeamId: 'team-b' }
  guard.invalidate()
  confirm.resolve()

  const outcome = await pending
  assert.equal(outcome.executed, false)
  assert.equal(outcome.current, false)
  assert.equal(outcome.isCurrent(), false)
  assert.equal(mutationCount, 0)
})

test('confirmation executes exactly once while route, session and team context stay unchanged', async () => {
  const state = {
    route: { name: 'AttendanceReports', fullPath: '/reporting/attendance?teamId=team-a' },
    session: { contextEpoch: 7, isGlobalReadOnly: true, activeTeamId: null },
    teamId: 'team-a',
    pageActive: true
  }
  let mutationCount = 0
  const guard = createPageConfirmationGuard(() => pageRequestContextSnapshot(state))

  const outcome = await guard.run({
    confirm: async () => {},
    mutate: async () => {
      mutationCount += 1
      return 'reviewed'
    }
  })

  assert.equal(outcome.executed, true)
  assert.equal(outcome.current, true)
  assert.equal(outcome.isCurrent(), true)
  assert.equal(outcome.value, 'reviewed')
  assert.equal(mutationCount, 1)
})

test('deactivation permanently invalidates an open confirmation even after the same page reactivates', async () => {
  const state = {
    route: { name: 'MessageList', fullPath: '/messages' },
    session: { contextEpoch: 1, isGlobalReadOnly: false, activeTeamId: 'team-a' },
    pageActive: true
  }
  const confirm = deferred()
  let mutationCount = 0
  const guard = createPageConfirmationGuard(() => pageRequestContextSnapshot(state))
  const pending = guard.run({
    confirm: () => confirm.promise,
    mutate: async () => { mutationCount += 1 }
  })

  state.pageActive = false
  guard.invalidate()
  state.pageActive = true
  confirm.resolve()

  const outcome = await pending
  assert.equal(outcome.executed, false)
  assert.equal(outcome.current, false)
  assert.equal(outcome.isCurrent(), false)
  assert.equal(mutationCount, 0)
})

test('context changes during a mutation mark its result stale for page-side success effects', async () => {
  const state = {
    route: { name: 'AttendanceReports', fullPath: '/reporting/attendance?teamId=team-a' },
    session: { contextEpoch: 4, isGlobalReadOnly: true, activeTeamId: null },
    teamId: 'team-a',
    pageActive: true
  }
  const response = deferred()
  let mutationCount = 0
  const guard = createPageConfirmationGuard(() => pageRequestContextSnapshot(state))
  const pending = guard.run({
    confirm: async () => {},
    mutate: async () => {
      mutationCount += 1
      return response.promise
    }
  })

  await Promise.resolve()
  state.teamId = 'team-b'
  state.route = { ...state.route, fullPath: '/reporting/attendance?teamId=team-b' }
  guard.invalidate()
  response.resolve('old-team-result')

  const outcome = await pending
  assert.equal(outcome.executed, true)
  assert.equal(outcome.current, false)
  assert.equal(outcome.isCurrent(), false)
  assert.equal(outcome.value, 'old-team-result')
  assert.equal(mutationCount, 1)
})
