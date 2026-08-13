import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { createMutationAwareListRefreshTracker } from '../src/utils/mutationAwareListRefresh.js'
import { SUCCESSFUL_MUTATION_SCOPES as S } from '../src/utils/successfulMutationRevision.js'

const pageCases = [
  {
    file: '../src/views/equipment/EquipmentRepairs.vue',
    scope: 'EQUIPMENT_REPAIRS',
    load: 'loadRepairs'
  },
  {
    file: '../src/views/equipment/EquipmentStatusApplications.vue',
    scope: 'EQUIPMENT_STATUS_APPLICATIONS',
    load: 'load'
  },
  {
    file: '../src/views/equipment/EquipmentList.vue',
    scope: 'EQUIPMENT',
    load: 'loadAssets'
  },
  {
    file: '../src/views/equipment/EquipmentRoutineWorkbench.vue',
    scope: 'EQUIPMENT_ROUTINES',
    load: 'loadActiveTab'
  }
].map((item) => ({
  ...item,
  source: readFileSync(new URL(item.file, import.meta.url), 'utf8')
}))

function functionSource(source, name) {
  const start = source.indexOf(`async function ${name}(`)
  assert.ok(start >= 0, `missing ${name}`)
  const bodyStart = source.indexOf('{', start)
  let depth = 0
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    if (source[index] !== '}') continue
    depth -= 1
    if (depth === 0) return source.slice(start, index + 1)
  }
  assert.fail(`unterminated ${name}`)
}

test('equipment keep-alive lists subscribe to their own mutation scope', () => {
  for (const { file, scope, load, source } of pageCases) {
    assert.match(source, /import \{ createMutationAwareListRefreshTracker \} from '@\/utils\/mutationAwareListRefresh'/, file)
    assert.match(source, /import \{ SUCCESSFUL_MUTATION_SCOPES \} from '@\/utils\/successfulMutationRevision'/, file)
    assert.ok(
      source.includes(`scopes: SUCCESSFUL_MUTATION_SCOPES.${scope}`),
      `${file} must subscribe to ${scope}`
    )
    assert.ok(
      source.includes(`mutationRefresh.refreshIfNeeded(${load})`),
      `${file} must refresh ${load} when activated`
    )
  }
})

test('equipment list loads acknowledge revisions only after current request and team checks', () => {
  for (const { file, load, source } of pageCases) {
    const body = functionSource(source, load)
    const revisionIndex = body.indexOf('const loadStartRevision = mutationRefresh.currentRevision()')
    const requestGuardIndex = body.indexOf('requestId !==')
    const teamGuard = body.match(/requested(?:Context)?TeamId !== currentTeamContextId\(\)/)
    const teamGuardIndex = teamGuard?.index ?? -1
    const acknowledgeIndex = body.indexOf('mutationRefresh.markThrough(loadStartRevision)')
    const successIndex = body.indexOf('return true', acknowledgeIndex)

    assert.ok(revisionIndex >= 0, `${file} must snapshot the revision before loading`)
    assert.ok(requestGuardIndex > revisionIndex, `${file} must reject stale requests`)
    assert.ok(teamGuardIndex > revisionIndex, `${file} must reject stale team responses`)
    assert.ok(acknowledgeIndex > requestGuardIndex, `${file} must not acknowledge a stale request`)
    assert.ok(acknowledgeIndex > teamGuardIndex, `${file} must not acknowledge a stale team response`)
    assert.ok(successIndex > acknowledgeIndex, `${file} must report only an acknowledged success`)
    assert.equal(
      source.match(/mutationRefresh\.markThrough\(loadStartRevision\)/g)?.length,
      1,
      `${file} must not acknowledge revisions during team changes or invalidation`
    )
  }
})

test('failed or stale refresh remains pending and concurrent activations share one request for every equipment scope', async () => {
  for (const scope of [
    S.EQUIPMENT_REPAIRS,
    S.EQUIPMENT_STATUS_APPLICATIONS,
    S.EQUIPMENT,
    S.EQUIPMENT_ROUTINES
  ]) {
    let revision = 10
    let releaseRefresh
    let refreshCount = 0
    const tracker = createMutationAwareListRefreshTracker({
      scopes: scope,
      readRevision: () => revision
    })

    revision += 1
    assert.equal(await tracker.refreshIfNeeded(() => false), false, scope)
    assert.equal(tracker.shouldRefresh(), true, `${scope} must retry after a failed or stale load`)

    const first = tracker.refreshIfNeeded(() => {
      refreshCount += 1
      return new Promise((resolve) => {
        releaseRefresh = () => resolve(true)
      })
    })
    const second = tracker.refreshIfNeeded(() => {
      refreshCount += 1
      return true
    })

    assert.equal(first, second, `${scope} must deduplicate concurrent activation refreshes`)
    await Promise.resolve()
    assert.equal(refreshCount, 1, scope)
    releaseRefresh()
    assert.equal(await first, true, scope)
    assert.equal(await second, true, scope)
    assert.equal(tracker.shouldRefresh(), false, scope)
  }
})
