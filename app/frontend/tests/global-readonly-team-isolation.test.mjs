import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function viewSource(path) {
  return readFileSync(new URL(`../src/views/${path}`, import.meta.url), 'utf8')
}

const equipment = viewSource('equipment/EquipmentList.vue')
const repairs = viewSource('equipment/EquipmentRepairs.vue')
const rules = viewSource('equipment/EquipmentRules.vue')
const inventories = viewSource('equipment/EquipmentInventoryList.vue')
const transport = viewSource('reporting/TransportRecords.vue')
const importDialog = viewSource('equipment/components/EquipmentImportDialog.vue')

test('global read-only team switches clear equipment data before route navigation', () => {
  assert.match(equipment, /function invalidateEquipmentTeamContext\(\) \{[\s\S]*assets\.value = \[\][\s\S]*categories\.value = \[\][\s\S]*total\.value = 0[\s\S]*options\.orgUnits = \[\][\s\S]*options\.custodians = \[\]/)
  assert.match(equipment, /async function handleTeamChange\(teamId\) \{\s*invalidateEquipmentTeamContext\(\)\s*await router\.replace/)
  assert.match(equipment, /requestedTeamId !== String\(requestTeamParams\.value\.teamId \|\| ''\)/)
  assert.match(equipment, /async function handleExport\(\) \{[\s\S]*requestedTeamId[\s\S]*requestId !== exportRequestId[\s\S]*requestedTeamId !== String\(requestTeamParams\.value\.teamId \|\| ''\)/)

  assert.match(repairs, /function invalidateRepairTeamContext\(\) \{[\s\S]*repairs\.value = \[\][\s\S]*equipmentOptions\.value = \[\][\s\S]*repairLocations\.value = \[\][\s\S]*total\.value = 0/)
  assert.match(repairs, /async function handleTeamChange\(teamId\) \{\s*invalidateRepairTeamContext\(\)[\s\S]*await router\.replace/)
  assert.match(repairs, /requestedTeamId !== currentTeamContextId\(\)/)

  assert.match(rules, /function invalidateRuleTeamContext\(\) \{[\s\S]*categories\.value = \[\][\s\S]*rules\.value = \[\][\s\S]*total\.value = 0/)
  assert.match(rules, /async function handleTeamChange\(teamId\) \{\s*invalidateRuleTeamContext\(\)[\s\S]*await router\.replace/)
  assert.match(rules, /requestedTeamId !== String\(requestTeamParams\.value\.teamId \|\| ''\)/)
})

test('inventory and transport switches leave an empty state if the new team load fails', () => {
  assert.match(inventories, /function invalidateInventoryTeamContext\(\) \{[\s\S]*sessions\.value = \[\][\s\S]*total\.value = 0[\s\S]*options\.orgUnits = \[\][\s\S]*options\.inventoryPeople = \[\]/)
  assert.match(inventories, /async function handleTeamChange\(teamId\) \{\s*invalidateInventoryTeamContext\(\)[\s\S]*await router\.replace/)
  assert.match(inventories, /requestId !== sessionsRequestId \|\|[\s\S]*requestedTeamId !== String\(requestTeamParams\.value\.teamId \|\| ''\)/)
  assert.match(inventories, /requestId !== optionsRequestId \|\|[\s\S]*requestedTeamId !== String\(requestTeamParams\.value\.teamId \|\| ''\)/)

  assert.match(transport, /function invalidateTransportTeamContext\(\) \{[\s\S]*records\.value = \[\][\s\S]*orgUnits\.value = \[\][\s\S]*masterData\.value = \[\][\s\S]*summaryRows\.value = \[\][\s\S]*total\.value = 0/)
  assert.match(transport, /async function handleTeamChange\(teamId\) \{\s*invalidateTransportTeamContext\(\)[\s\S]*await router\.replace/)
  for (const requestId of ['optionsRequestId', 'masterDataRequestId', 'recordsRequestId', 'summaryRequestId']) {
    assert.match(transport, new RegExp(`requestId !== ${requestId}[\\s\\S]*requestedTeamId !== String\\(requestTeamParams\\.value\\.teamId \\|\\| ''\\)`))
  }
  assert.match(transport, /async function handleSummaryExport\(\) \{[\s\S]*requestedTeamId[\s\S]*requestId !== exportRequestId[\s\S]*requestedTeamId !== String\(requestTeamParams\.value\.teamId \|\| ''\)/)
})

test('saved equipment import jobs are isolated by live user and team context', () => {
  assert.match(importDialog, /const storageKey = computed\(\(\) => equipmentImportPreviewStorageKey\(props\.contextKey\)\)/)
  assert.match(importDialog, /const jobId = keyAtStart \? localStorage\.getItem\(keyAtStart\) : ''[\s\S]*getEquipmentImportJob\(jobId,/)
  assert.match(importDialog, /if \(\[403, 404, 409\]\.includes\(error\?\.response\?\.status\)\) \{\s*removeSavedPreview\(keyAtStart\)/)
  assert.match(importDialog, /watch\(lifecycleContextKey,[\s\S]*invalidateLifecycle\(value\)[\s\S]*visible\.value = false/)
  assert.match(equipment, /:context-key="equipmentImportContextKey"/)
  assert.doesNotMatch(equipment, /invalidateEquipmentTeamContext\(\)[\s\S]{0,500}localStorage\.removeItem/)
})
