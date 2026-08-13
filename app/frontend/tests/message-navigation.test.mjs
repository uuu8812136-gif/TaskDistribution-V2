import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { hasMessageResource, messageResourceLocation } from '../src/utils/messageNavigation.js'

const workbenchSource = readFileSync(
  new URL('../src/views/equipment/EquipmentRoutineWorkbench.vue', import.meta.url),
  'utf8'
)
const messageListSource = readFileSync(
  new URL('../src/views/messages/MessageList.vue', import.meta.url),
  'utf8'
)
const attendanceSource = readFileSync(
  new URL('../src/views/reporting/AttendanceReports.vue', import.meta.url),
  'utf8'
)
const equipmentApiSource = readFileSync(
  new URL('../src/api/equipment.js', import.meta.url),
  'utf8'
)

const globalOptions = { includeTeamId: true }

test('global read-only message navigation retains the originating team for every Web resource', () => {
  assert.deepEqual(messageResourceLocation({
    teamId: 'team-1',
    relatedTask: { _id: 'task-1' }
  }, globalOptions), {
    name: 'TaskDetail',
    params: { id: 'task-1' },
    query: { teamId: 'team-1' }
  })

  assert.deepEqual(messageResourceLocation({
    teamId: 'team-1',
    type: 'equipment_status',
    extraData: { statusApplicationId: 'application-1' }
  }, globalOptions), {
    name: 'EquipmentStatusApplicationDetail',
    params: { applicationId: 'application-1' },
    query: { teamId: 'team-1' }
  })

  assert.deepEqual(messageResourceLocation({
    teamId: { _id: 'team-1' },
    extraData: { resourceType: 'REPAIR_ORDER', repairId: 'repair-1' }
  }, globalOptions), {
    name: 'EquipmentRepairDetail',
    params: { repairId: 'repair-1' },
    query: { teamId: 'team-1' }
  })

  assert.deepEqual(messageResourceLocation({
    teamId: 'team-1',
    extraData: {
      resourceType: 'EQUIPMENT_ROUTINE_EXCEPTION',
      exceptionId: 'exception-1',
      equipmentId: 'equipment-1'
    }
  }, globalOptions), {
    name: 'EquipmentRoutineWorkbench',
    query: {
      teamId: 'team-1',
      tab: 'exceptions',
      exceptionId: 'exception-1',
      equipmentId: 'equipment-1'
    }
  })

  assert.deepEqual(messageResourceLocation({
    teamId: 'team-1',
    extraData: {
      resourceType: 'EQUIPMENT_ROUTINE_PLAN',
      planId: 'plan-1',
      equipmentId: 'equipment-1'
    }
  }, globalOptions), {
    name: 'EquipmentRoutineWorkbench',
    query: {
      teamId: 'team-1',
      tab: 'plans',
      planId: 'plan-1',
      equipmentId: 'equipment-1'
    }
  })

  assert.deepEqual(messageResourceLocation({
    teamId: 'team-1',
    type: 'attendance_reviewed',
    extraData: {
      reportDate: '2026-07-16',
      page: '/pages/reporting/attendance'
    }
  }, globalOptions), {
    name: 'AttendanceReports',
    query: { teamId: 'team-1', reportDate: '2026-07-16' }
  })
})

test('message navigation keeps team mode URLs clean and rejects incomplete metadata', () => {
  assert.deepEqual(messageResourceLocation({
    teamId: 'team-1',
    relatedTask: { _id: 'task-1' }
  }), {
    name: 'TaskDetail',
    params: { id: 'task-1' },
    query: {}
  })
  assert.equal(hasMessageResource({ extraData: { resourceType: 'REPAIR_ORDER' } }), false)
  assert.equal(hasMessageResource({ extraData: { resourceType: 'EQUIPMENT_ROUTINE_PLAN' } }), false)
  assert.equal(hasMessageResource({
    type: 'system',
    extraData: { statusApplicationId: 'application-1' }
  }), false)
  assert.equal(hasMessageResource({
    type: 'attendance_missing',
    extraData: { reportDate: '2026-07-16', page: '/untrusted/path' }
  }), false)
  assert.equal(hasMessageResource({
    type: 'attendance_reviewed',
    extraData: { reportDate: 'not-a-date', page: '/pages/reporting/attendance' }
  }), false)
  assert.equal(messageResourceLocation({ title: 'ordinary message' }), null)
})

test('routine workbench loads off-page message targets and visually locates plans and exceptions', () => {
  assert.match(workbenchSource, /const requestedTab = String\(route\.query\.tab \|\| ''\)/)
  assert.match(workbenchSource, /const selectedTeamId = ref\(String\(route\.query\.teamId \|\| ''\)\)/)
  assert.match(workbenchSource, /equipmentId: String\(route\.query\.equipmentId \|\| ''\)/)
  assert.match(workbenchSource, /const focusedPlanId = ref\(String\(route\.query\.planId \|\| ''\)\)/)
  assert.match(equipmentApiSource, /url: `\/equipment\/routine-plans\/\$\{planId\}`/)
  assert.match(workbenchSource, /getEquipmentRoutinePlan\(/)
  assert.match(workbenchSource, /plans\.value = \[focusedResult\.plan, \.\.\.listedPlans\]/)
  assert.match(workbenchSource, /getEquipmentRoutineException\(/)
  assert.match(workbenchSource, /focusedResult\?\.exception/)
  assert.match(workbenchSource, /:row-class-name="planRowClass"/)
  assert.match(workbenchSource, /:row-class-name="exceptionRowClass"/)
  assert.match(workbenchSource, /focused-message-row/)
  assert.match(workbenchSource, /session\.isGlobalReadOnly && !selectedTeamId\.value/)
})

test('message titles expose real links as keyboard-operable buttons', () => {
  assert.match(messageListSource, /v-if="hasMessageResource\(row\)"/)
  assert.match(messageListSource, /type="button"/)
  assert.match(messageListSource, /messageResourceLocation\(row, \{ includeTeamId: session\.isGlobalReadOnly \}\)/)
  assert.match(messageListSource, /\.message-title-link:focus-visible/)
})

test('cached message center refreshes on return without duplicating its first load', () => {
  assert.match(messageListSource, /import \{[^}]*onActivated[^}]*onBeforeUnmount[^}]*onDeactivated[^}]*onMounted[^}]*\} from 'vue'/s)
  assert.match(messageListSource, /let wasDeactivated = false/)
  assert.match(messageListSource, /onMounted\(\(\) => \{\s*fetchData\(\)\s*\}\)/)
  assert.match(messageListSource, /onActivated\(\(\) => \{\s*pageActive = true\s*if \(!wasDeactivated\) return\s*wasDeactivated = false\s*fetchData\(\)/)
  assert.match(messageListSource, /onDeactivated\(\(\) => \{[\s\S]*wasDeactivated = true[\s\S]*listRequestId \+= 1[\s\S]*loading\.value = false/)
})

test('message confirmations are invalidated by context and lifecycle changes', () => {
  assert.match(messageListSource, /createPageConfirmationGuard/)
  assert.equal((messageListSource.match(/confirmationGuard\.run\(/g) || []).length, 3)
  assert.match(messageListSource, /watch\(\(\) => session\.contextEpoch, invalidateConfirmationActions\)/)
  assert.match(messageListSource, /watch\(\(\) => \[route\.name, route\.fullPath\], invalidateConfirmationActions\)/)
  assert.match(messageListSource, /onDeactivated\([\s\S]*invalidateConfirmationActions\(\)/)
  assert.match(messageListSource, /onBeforeUnmount\([\s\S]*invalidateConfirmationActions\(\)/)
})

test('attendance message navigation initializes the requested team and daily report date', () => {
  assert.match(attendanceSource, /const requestedReportDate = String\(route\.query\.reportDate \|\| ''\)/)
  assert.match(attendanceSource, /const currentLocalDate = dayjs\(\)\.format\('YYYY-MM-DD'\)/)
  assert.match(attendanceSource, /const viewMode = ref\(requestedReportDate \? 'daily' : 'records'\)/)
  assert.match(attendanceSource, /const selectedTeamId = ref\(String\(route\.query\.teamId \|\| ''\)\)/)
  assert.match(attendanceSource, /const dailyDate = ref\(requestedReportDate \|\| currentLocalDate\)/)
  assert.match(attendanceSource, /const summaryMonth = ref\(\(requestedReportDate \|\| currentLocalDate\)\.slice\(0, 7\)\)/)
  assert.doesNotMatch(attendanceSource, /requestedReportDate \|\| '2026-/)
  assert.match(attendanceSource, /await loadOptions\(\)\s+await loadActiveView\(\)/)
})
