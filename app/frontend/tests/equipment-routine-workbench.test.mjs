import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { buildRoutineRulePayload } from '../src/utils/equipment.js'

const workbenchSource = readFileSync(
  new URL('../src/views/equipment/EquipmentRoutineWorkbench.vue', import.meta.url),
  'utf8'
)
const ruleDialogSource = readFileSync(
  new URL('../src/views/equipment/components/EquipmentRuleDialog.vue', import.meta.url),
  'utf8'
)
const routerSource = readFileSync(
  new URL('../src/router/index.js', import.meta.url),
  'utf8'
)

test('routine rule payload retains configurable windows and pending location policy without team identity', () => {
  const payload = buildRoutineRulePayload({
    routineType: 'INSPECTION',
    categoryId: 'category-1',
    name: '班前点检',
    checklistItems: [{ name: '检查温度', required: true }],
    schedule: {
      mode: 'CALENDAR',
      calendar: { unit: 'WEEK', interval: 1, firstDueAt: '2030-01-14T23:00:00.000Z' }
    },
    photoPolicy: 'ON_ABNORMAL',
    abnormalNoteRequired: true,
    executionConfig: {
      timeZone: 'Asia/Shanghai',
      windows: [
        { key: 'DAY_SHIFT', name: '白班', startTime: '07:00', endTime: '09:00', enabled: true },
        { key: 'NIGHT_SHIFT', name: '夜班', startTime: '19:00', endTime: '21:00', enabled: true }
      ],
      weeklyDay: 1,
      monthlyDay: 1,
      inspectionEscalationMinutes: 60,
      locationPolicy: 'PENDING_CONFIRMATION',
      locationPrecisionMeters: null
    },
    teamId: 'must-not-leak'
  })
  assert.deepEqual(payload.executionConfig.windows.map(({ startTime, endTime }) => [startTime, endTime]), [
    ['07:00', '09:00'],
    ['19:00', '21:00']
  ])
  assert.equal(payload.executionConfig.weeklyDay, 1)
  assert.equal(payload.executionConfig.locationPolicy, 'PENDING_CONFIRMATION')
  assert.equal(Object.hasOwn(payload, 'teamId'), false)
})

test('Web exposes a cross-device routine workbench, fixed export, exception actions, and editable windows', () => {
  assert.match(routerSource, /path:\s*'equipment\/routines'/)
  assert.match(workbenchSource, /执行计划与提醒/)
  assert.match(workbenchSource, /getEquipmentRoutineRecords/)
  assert.match(workbenchSource, /getEquipmentRoutinePlans/)
  assert.match(workbenchSource, /getEquipmentRoutineExceptions/)
  assert.match(workbenchSource, /transitionEquipmentRoutineException/)
  assert.match(workbenchSource, /exportEquipmentRoutineRecords/)
  assert.match(workbenchSource, /getEquipmentList/)
  assert.match(workbenchSource, /getEquipmentOptions/)
  assert.match(workbenchSource, /v-model="filters\.equipmentId"/)
  assert.match(workbenchSource, /v-model="filters\.orgUnitId"/)
  assert.match(workbenchSource, /v-model="filters\.overallResult"/)
  assert.match(workbenchSource, /v-model="filters\.exceptionStatus"/)
  assert.match(workbenchSource, /params\.overallResult = filters\.overallResult/)
  assert.match(workbenchSource, /params\.status = filters\.exceptionStatus/)
  assert.match(ruleDialogSource, /添加窗口/)
  assert.match(ruleDialogSource, /inspectionEscalationMinutes/)
  assert.match(ruleDialogSource, /PENDING_CONFIRMATION/)
})
