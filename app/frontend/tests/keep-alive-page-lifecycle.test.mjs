import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function source(path) {
  return readFileSync(new URL(`../src/views/${path}`, import.meta.url), 'utf8')
}

const audit = source('audit/AuditLogs.vue')
const equipment = source('equipment/EquipmentList.vue')
const transport = source('reporting/TransportRecords.vue')
const workbench = source('equipment/EquipmentRoutineWorkbench.vue')
const repairs = source('equipment/EquipmentRepairs.vue')
const statusApplications = source('equipment/EquipmentStatusApplications.vue')
const rules = source('equipment/EquipmentRules.vue')
const attendance = source('reporting/AttendanceReports.vue')

test('keep-alive pages release listeners, stale requests, object URLs, and photo requests when hidden', () => {
  assert.match(audit, /onDeactivated\(deactivateAuditPage\)/)
  assert.match(audit, /removeEventListener\('change', syncDetailLayout\)/)
  assert.match(audit, /listRequestId \+= 1[\s\S]*detailRequestId \+= 1/)

  for (const page of [equipment, transport]) {
    assert.match(page, /onDeactivated\(deactivate/)
    assert.match(page, /clear(?:Photo)?Preview\(\)/)
    assert.match(page, /if \(!pageActive \|\| requestId !== .*RequestId\)/)
    assert.match(page, /URL\.revokeObjectURL\(url\)/)
  }

  assert.match(workbench, /onDeactivated\(deactivateRoutineWorkbench\)/)
  assert.match(workbench, /deactivateRoutineWorkbench\(\)[\s\S]*activeTabRequestId \+= 1[\s\S]*referenceRequestId \+= 1[\s\S]*closeRecordDetail\(\)/)
})

test('stable list instances consume every supported route action after activation', () => {
  assert.match(equipment, /watch\(\(\) => \[route\.name, route\.query\.teamId, route\.query\.edit\]/)
  assert.match(equipment, /async function syncRouteEditAction\(\)/)
  assert.match(equipment, /getEquipmentDetail\(editId, requestTeamParams\.value\)/)

  assert.match(transport, /watch\(\(\) => \[route\.name, route\.query\.teamId, route\.query\.edit\]/)
  assert.match(transport, /async function syncRouteEditAction\(\)/)
  assert.match(transport, /await openEdit\(editId\)/)

  for (const page of [repairs, statusApplications]) {
    assert.match(page, /watch\(\(\) => \[route\.name, route\.query\.teamId, route\.query\.create, route\.query\.equipmentId\]/)
    assert.match(page, /async function syncRouteCreateAction\(\)/)
    assert.match(page, /create: undefined, equipmentId: undefined/)
    assert.match(page, /onActivated\(\(\) =>/)
  }

  assert.match(rules, /watch\(\(\) => \[route\.name, route\.query\.teamId, route\.query\.categoryId, route\.query\.routineType\]/)
  assert.match(rules, /async function syncRouteRuleContext\(\)/)
  assert.match(rules, /activeRoutineType\.value = nextType[\s\S]*filters\.categoryId = nextCategoryId/)

  assert.match(workbench, /route\.query\.exceptionId,[\s\S]*route\.query\.equipmentId/)
  assert.match(workbench, /filters\.equipmentId = nextEquipmentId/)
  assert.match(workbench, /onActivated\(\(\) =>[\s\S]*syncRouteFocus\(\)/)

  assert.match(attendance, /watch\(\(\) => \[route\.name, route\.query\.teamId, route\.query\.reportDate\]/)
  assert.match(attendance, /async function syncRouteReportDate\(\)/)
  assert.match(attendance, /viewMode\.value = 'daily'[\s\S]*dailyDate\.value = requestedDate[\s\S]*loadDailySummary\(\)/)
})
