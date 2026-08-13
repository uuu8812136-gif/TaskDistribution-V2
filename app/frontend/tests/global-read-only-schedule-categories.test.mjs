import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const productionSchedulesSource = readFileSync(
  new URL('../src/views/reporting/ProductionSchedules.vue', import.meta.url),
  'utf8'
)
const equipmentCategoriesSource = readFileSync(
  new URL('../src/views/equipment/EquipmentCategories.vue', import.meta.url),
  'utf8'
)

function functionSource(source, name, nextName) {
  const start = source.indexOf(`function ${name}`)
  const end = source.indexOf(`function ${nextName}`, start + 1)
  assert.notEqual(start, -1, `${name} must exist`)
  assert.notEqual(end, -1, `${nextName} must exist after ${name}`)
  return source.slice(start, end)
}

test('production schedules invalidates and clears every team-owned result before route replacement', () => {
  const invalidation = functionSource(
    productionSchedulesSource,
    'invalidateScheduleResults',
    'loadOptions'
  )
  for (const requestId of [
    'optionsRequestId',
    'dailyRequestId',
    'monthlyRequestId',
    'dailyExportRequestId',
    'monthlyExportRequestId'
  ]) {
    assert.match(invalidation, new RegExp(`${requestId} \\+= 1`))
  }
  for (const reset of [
    'orgUnits.value = []',
    "selectedOrgUnitId.value = ''",
    "dailyMonth.value = ''",
    'applyDailySchedule(emptyDailySchedule())',
    'monthlySchedules.value = []',
    'monthlyTotal.value = 0'
  ]) {
    assert.ok(invalidation.includes(reset), `missing immediate clear: ${reset}`)
  }

  const teamChange = functionSource(productionSchedulesSource, 'handleTeamChange', 'handleTabChange')
  assert.ok(
    teamChange.indexOf('invalidateScheduleResults()') < teamChange.indexOf('await router.replace'),
    'old team data must be cleared before changing the URL'
  )
  assert.match(teamChange, /await loadScheduleContext\(\)/)
  const loadContext = functionSource(
    productionSchedulesSource,
    'loadScheduleContext',
    'syncRouteScheduleContext'
  )
  assert.match(loadContext, /if \(await loadOptions\(\) === false\) return/)
})

test('production schedule async list, option and export responses require request id and team snapshot', () => {
  const snapshot = functionSource(
    productionSchedulesSource,
    'currentScheduleTeamSnapshot',
    'scheduleRequestContext'
  )
  assert.match(snapshot, /session\.contextEpoch/)
  assert.match(snapshot, /selectedTeamId\.value/)
  assert.match(snapshot, /session\.activeTeamId/)
  assert.match(snapshot, /session\.isGlobalReadOnly/)
  assert.match(
    productionSchedulesSource,
    /function isCurrentScheduleRequest\(requestId, latestRequestId, requestedTeamSnapshot\)[\s\S]*?requestId === latestRequestId[\s\S]*?requestedTeamSnapshot === currentScheduleTeamSnapshot\(\)/
  )

  for (const [name, nextName, requestId] of [
    ['loadOptions', 'loadDaily', 'optionsRequestId'],
    ['loadDaily', 'saveDaily', 'dailyRequestId'],
    ['loadMonthly', 'applyMonthlyFilters', 'monthlyRequestId'],
    ['exportDaily', 'monthlyParams', 'dailyExportRequestId'],
    ['exportMonthly', 'handleTeamChange', 'monthlyExportRequestId']
  ]) {
    const body = functionSource(productionSchedulesSource, name, nextName)
    assert.match(body, new RegExp(`const requestId = \\+\\+${requestId}`))
    assert.match(body, /teamSnapshot: requestedTeamSnapshot/)
    assert.match(
      body,
      new RegExp(`isCurrentScheduleRequest\\(requestId, ${requestId}, requestedTeamSnapshot\\)`)
    )
  }
})

test('production schedules synchronizes route team changes and cached activation', () => {
  assert.match(
    productionSchedulesSource,
    /watch\(\(\) => \[route\.name, route\.query\.teamId\],[\s\S]*?syncRouteScheduleContext\(\)/
  )
  assert.match(
    productionSchedulesSource,
    /watch\(\(\) => session\.contextEpoch,[\s\S]*?syncRouteScheduleContext\(\{ force: true \}\)/
  )
  assert.match(
    productionSchedulesSource,
    /async function syncRouteScheduleContext\([\s\S]*?routedTeamId !== selectedTeamId\.value[\s\S]*?invalidateScheduleResults\(\)[\s\S]*?loadScheduleContext\(\)/
  )
  assert.match(productionSchedulesSource, /onActivated\(\(\) =>[\s\S]*?syncRouteScheduleContext\(\{ force \}\)/)
  assert.match(productionSchedulesSource, /onDeactivated\(deactivateProductionSchedules\)/)
  assert.match(productionSchedulesSource, /onBeforeUnmount\(deactivateProductionSchedules\)/)
})

test('equipment categories clears stale rows and protects response writes with request and team identity', () => {
  const snapshot = functionSource(
    equipmentCategoriesSource,
    'currentCategoryTeamSnapshot',
    'categoryRequestContext'
  )
  assert.match(snapshot, /session\.contextEpoch/)
  assert.match(snapshot, /route\.query\.teamId/)
  assert.match(snapshot, /session\.activeTeamId/)
  assert.match(snapshot, /session\.isGlobalReadOnly/)
  assert.match(
    equipmentCategoriesSource,
    /function isCurrentCategoryRequest\(requestId, requestedTeamSnapshot\)[\s\S]*?pageActive[\s\S]*?requestId === categoriesRequestId[\s\S]*?requestedTeamSnapshot === currentCategoryTeamSnapshot\(\)/
  )

  const invalidation = functionSource(
    equipmentCategoriesSource,
    'invalidateCategoryResults',
    'loadCategories'
  )
  assert.match(invalidation, /categoriesRequestId \+= 1/)
  assert.match(invalidation, /loadedTeamSnapshot = ''/)
  assert.match(invalidation, /categories\.value = \[\]/)
  assert.match(invalidation, /loading\.value = false/)

  const loader = functionSource(equipmentCategoriesSource, 'loadCategories', 'resetForm')
  assert.match(loader, /const requestId = \+\+categoriesRequestId/)
  assert.match(loader, /teamSnapshot: requestedTeamSnapshot/)
  assert.match(loader, /if \(!isCurrentCategoryRequest\(requestId, requestedTeamSnapshot\)\) return false/)
  assert.ok(
    loader.indexOf('if (!isCurrentCategoryRequest') < loader.indexOf('categories.value = result.categories || []'),
    'the stale response guard must run before writing rows'
  )
})

test('equipment categories synchronizes route team changes and cached activation', () => {
  const sync = functionSource(
    equipmentCategoriesSource,
    'syncRouteCategoryContext',
    'deactivateCategoriesPage'
  )
  assert.match(sync, /route\.name !== 'EquipmentCategories'/)
  assert.ok(
    sync.indexOf('invalidateCategoryResults()') < sync.indexOf('await loadCategories()'),
    'route team changes must clear old rows before loading the next team'
  )

  assert.match(
    equipmentCategoriesSource,
    /watch\(\(\) => \[route\.name, route\.query\.teamId, session\.contextEpoch\]/
  )
  assert.match(
    equipmentCategoriesSource,
    /onActivated\(\(\) => \{[\s\S]*?pageActive = true[\s\S]*?syncRouteCategoryContext\(\{ force \}\)/
  )
  assert.match(equipmentCategoriesSource, /onDeactivated\(deactivateCategoriesPage\)/)
  assert.match(equipmentCategoriesSource, /onBeforeUnmount\(deactivateCategoriesPage\)/)
})
