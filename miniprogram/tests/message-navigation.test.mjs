import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { hasMessageResource, messageResourceUrl } from '../utils/messageNavigation.js'

const globalOptions = { includeTeamId: true }

test('global read-only messages retain the originating team for every supported mini-program resource', () => {
  assert.equal(messageResourceUrl({
    teamId: 'team 1',
    relatedTask: { _id: 'task/1' }
  }, globalOptions), '/pages/task/detail?id=task%2F1&type=executor&teamId=team%201')

  assert.equal(messageResourceUrl({
    type: 'equipment_status',
    teamId: 'team-1',
    extraData: { statusApplicationId: 'application-1' }
  }, globalOptions), '/pages/equipment/status-application-detail?applicationId=application-1&teamId=team-1')

  assert.equal(messageResourceUrl({
    teamId: { _id: 'team-1' },
    extraData: { resourceType: 'REPAIR_ORDER', repairId: 'repair-1' }
  }, globalOptions), '/pages/equipment/repair-detail?repairId=repair-1&teamId=team-1')

  assert.equal(messageResourceUrl({
    teamId: 'team-1',
    extraData: {
      resourceType: 'EQUIPMENT_ROUTINE_EXCEPTION',
      exceptionId: 'exception-1'
    }
  }, globalOptions), '/pages/equipment/routine-exception?exceptionId=exception-1&teamId=team-1')

  assert.equal(messageResourceUrl({
    teamId: 'team-1',
    extraData: { resourceType: 'EQUIPMENT_ROUTINE_PLAN', planId: 'plan-1' }
  }, globalOptions), '/pages/equipment/routine-workbench?tab=plans&planId=plan-1&teamId=team-1')

  assert.equal(messageResourceUrl({
    type: 'attendance_missing',
    teamId: 'team-1',
    extraData: {
      page: '/pages/reporting/attendance',
      reportDate: '2026-07-21'
    }
  }, globalOptions), '/pages/reporting/attendance?teamId=team-1&reportDate=2026-07-21')
})

test('task workflow messages open the detail in the recipient workflow context', () => {
  assert.equal(messageResourceUrl({
    type: 'task_completed',
    relatedTask: 'task-1'
  }), '/pages/task/detail?id=task-1&type=cc')
  assert.equal(messageResourceUrl({
    type: 'task_reviewed',
    relatedTask: 'task-1'
  }), '/pages/task/detail?id=task-1&type=created')
  assert.equal(messageResourceUrl({
    type: 'extension_applied',
    relatedTask: 'task-1'
  }), '/pages/task/detail?id=task-1&type=created')
  assert.equal(messageResourceUrl({
    type: 'task_assigned',
    relatedTask: 'task-1'
  }), '/pages/task/detail?id=task-1&type=executor')
})

test('message navigation uses an explicit allowlist and leaves team mode URLs unscoped', () => {
  assert.equal(messageResourceUrl({
    type: 'equipment_status',
    teamId: 'team-1',
    extraData: { statusApplicationId: 'application-1' }
  }), '/pages/equipment/status-application-detail?applicationId=application-1')
  assert.equal(messageResourceUrl({
    type: 'system',
    extraData: { page: '/pages/profile/index', reportDate: '2026-07-21' }
  }), '')
  assert.equal(messageResourceUrl({
    type: 'system',
    extraData: { statusApplicationId: 'application-1' }
  }), '')
  assert.equal(hasMessageResource({
    extraData: { resourceType: 'REPAIR_ORDER' }
  }), false)
  assert.equal(messageResourceUrl({
    type: 'attendance_reviewed',
    extraData: { page: '/pages/reporting/attendance', reportDate: '2026-02-30' }
  }), '/pages/reporting/attendance')
})

test('message page delegates all business targets to the navigation allowlist', () => {
  const source = readFileSync(new URL('../pages/message/index.vue', import.meta.url), 'utf8')
  const attendance = readFileSync(new URL('../pages/reporting/attendance.vue', import.meta.url), 'utf8')
  const routineWorkbench = readFileSync(
    new URL('../pages/equipment/routine-workbench.vue', import.meta.url),
    'utf8'
  )
  assert.match(source, /messageResourceUrl\(msg, \{/)
  assert.match(source, /includeTeamId: userStore\.isGlobalReadOnly/)
  assert.equal(source.includes("extraData?.page"), false)
  assert.match(attendance, /date\.value = options\.reportDate/)
  assert.match(routineWorkbench, /focusedPlanId\.value = options\.planId \|\| ''/)
  assert.match(routineWorkbench, /getEquipmentRoutinePlan\(request\.planId, query\(request\)\)/)
  assert.match(routineWorkbench, /\[focusedPlan, \.\.\.rows\]/)
  assert.match(routineWorkbench, /String\(plan\._id\) === focusedPlanId/)
  assert.match(source, /pendingMessageClicks\.has\(messageId\)/)
  assert.match(source, /setTimeout\(\(\) => pendingMessageClicks\.delete\(messageId\), 800\)/)
  assert.match(source, /onShow\(\(\) => \{[\s\S]*refreshVisibleMessages\(\)/)
  assert.match(source, /refreshVisibleMessages[\s\S]*messageStore\.fetchUnreadCount\(\)/)
})
