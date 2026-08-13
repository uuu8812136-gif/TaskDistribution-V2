import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const repairsSource = readFileSync(
  new URL('../src/views/equipment/EquipmentRepairs.vue', import.meta.url),
  'utf8'
)
const statusApplicationsSource = readFileSync(
  new URL('../src/views/equipment/EquipmentStatusApplications.vue', import.meta.url),
  'utf8'
)

test('equipment repair and status lists discard stale team and search responses', () => {
  assert.match(repairsSource, /const requestId = \+\+repairsRequestId/)
  assert.match(repairsSource, /if \(requestId !== repairsRequestId\) return/)
  assert.match(repairsSource, /if \(requestId === repairsRequestId\) loading\.value = false/)

  assert.match(statusApplicationsSource, /const requestId = \+\+listRequestId/)
  assert.match(statusApplicationsSource, /!pageActive \|\|\s*requestId !== listRequestId \|\|[\s\S]*requestedContextTeamId !== currentTeamContextId\(\)[\s\S]*\) return false/)
  assert.match(statusApplicationsSource, /if \(requestId === listRequestId\) loading\.value = false/)
  assert.match(statusApplicationsSource, /const requestId = \+\+equipmentRequestId/)
  assert.match(statusApplicationsSource, /if \(requestId !== equipmentRequestId\) return/)
})
