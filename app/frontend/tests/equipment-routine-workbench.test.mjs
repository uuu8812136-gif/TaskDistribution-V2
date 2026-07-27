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
const rulesSource = readFileSync(
  new URL('../src/views/equipment/EquipmentRules.vue', import.meta.url),
  'utf8'
)
const detailSource = readFileSync(
  new URL('../src/views/equipment/EquipmentDetail.vue', import.meta.url),
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

test('routine rule terms include short customer-facing explanations without changing the payload', () => {
  for (const text of [
    '点检用于检查设备状态，保养用于记录维护工作。',
    '异常超过该时间未处理，就继续通知上一级负责人。',
    '决定手机定位失败时是否允许保存照片并提交记录。',
    '决定计划是手动发起，还是按日期或运行小时自动生成。',
    '决定提交时什么时候必须拍摄现场照片。'
  ]) assert.ok(ruleDialogSource.includes(text), `missing description: ${text}`)
})

test('routine exception actions trust the server access policy instead of guessing fixed positions', () => {
  assert.match(workbenchSource, /row\.accessPolicy\?\.canHandle === true/)
  assert.doesNotMatch(workbenchSource, /membership\.positionKey === 'SUB_DEPARTMENT_MANAGER'/)
  assert.match(workbenchSource, /SUB_DEPARTMENT_MANAGER: '分部负责人处理'/)
})

test('routine record export is permission gated and protected from repeated clicks', () => {
  assert.match(workbenchSource, /v-if="activeTab === 'records' && canExport"/)
  assert.match(workbenchSource, /:loading="exporting"/)
  assert.match(workbenchSource, /const canExport = computed\(\(\) => session\.hasPermission\('equipment\.export'\)\)/)
  assert.match(workbenchSource, /async function exportRows\(\) \{\s+if \(exporting\.value\) return\s+exporting\.value = true/)
  assert.match(workbenchSource, /finally \{\s+exporting\.value = false\s+\}/)
})

test('routine workbench discards stale team and tab responses', () => {
  assert.match(workbenchSource, /let referenceRequestId = 0/)
  assert.match(workbenchSource, /let activeTabRequestId = 0/)
  assert.match(workbenchSource, /const requestId = \+\+referenceRequestId[\s\S]*if \(requestId !== referenceRequestId\) return/)
  assert.match(workbenchSource, /const requestId = \+\+activeTabRequestId[\s\S]*if \(requestId !== activeTabRequestId\) return/)
  assert.match(workbenchSource, /if \(requestId === activeTabRequestId\) loading\.value = false/)
  assert.match(workbenchSource, /plans\.value = \[\][\s\S]*records\.value = \[\][\s\S]*exceptions\.value = \[\][\s\S]*total\.value = 0/)
})

test('message focus is removed before routine filters or pagination are applied', () => {
  assert.match(workbenchSource, /async function clearMessageFocus\(\)/)
  assert.match(workbenchSource, /planId: undefined,[\s\S]*exceptionId: undefined/)
  assert.match(workbenchSource, /async function applyFilters\(\)[\s\S]*await clearMessageFocus\(\)[\s\S]*await loadActiveTab\(\)/)
  assert.match(workbenchSource, /@change="changePage"/)
  assert.match(workbenchSource, /async function changePage\(\)[\s\S]*await clearMessageFocus\(\)/)
})

test('Web makes simultaneous calendar and runtime rules visible and quick to configure', () => {
  for (const preset of ['DAY', 'WEEK', 'MONTH', 'RUNTIME_HOURS', 'COMBINED']) {
    assert.match(rulesSource, new RegExp(`value: '${preset}'`))
  }
  assert.match(rulesSource, /:default-category-id="filters\.categoryId"/)
  assert.match(rulesSource, /:schedule-preset="newRuleSchedulePreset"/)
  assert.match(ruleDialogSource, /defaultCategoryId: \{ type: String, default: '' \}/)
  assert.match(ruleDialogSource, /function defaultSchedule\(\)/)
  assert.match(detailSource, /aria-label="当前设备生效规则分布"/)
  assert.match(detailSource, /row\.summary\.DAY/)
  assert.match(detailSource, /row\.summary\.WEEK/)
  assert.match(detailSource, /row\.summary\.MONTH/)
  assert.match(detailSource, /row\.summary\.RUNTIME_HOURS/)
  assert.match(detailSource, /runtimeHoursUpdatedAt/)
  assert.match(workbenchSource, /row\.performedRuntimeHours \?\? '-'/)
  assert.match(workbenchSource, /routineScheduleLabel\(row\.ruleSnapshot\?\.schedule\)/)
})

test('routine workbench heading actions stay aligned without overflowing at 390px', () => {
  assert.match(workbenchSource, /\.page-heading, \.heading-actions, \.toolbar, \.pagination-row \{ display: flex; align-items: center; \}/)
  assert.match(workbenchSource, /\.heading-actions \{ gap: 8px; \}/)
  assert.match(workbenchSource, /@media \(max-width: 760px\) \{[\s\S]*?\.page-heading \{ align-items: flex-start; flex-direction: column; \}/)
  assert.match(workbenchSource, /\.heading-actions, \.toolbar > \*, \.team-select \{ width: 100%; \}/)
})

test('routine rule window controls keep explicit positions on narrow screens', () => {
  assert.match(ruleDialogSource, /class="window-enabled"/)
  assert.match(ruleDialogSource, /class="window-name"/)
  assert.match(ruleDialogSource, /class="window-time window-time--start"/)
  assert.match(ruleDialogSource, /class="window-time window-time--end"/)
  assert.match(ruleDialogSource, /class="window-remove"/)
  assert.match(ruleDialogSource, /\.window-row \{ grid-template-columns: 40px repeat\(4, minmax\(0, 1fr\)\) 34px; \}/)
  assert.match(ruleDialogSource, /\.window-row > \* \{ min-width: 0; \}/)
  assert.match(ruleDialogSource, /\.window-row \.window-time \{[\s\S]*?--el-date-editor-width: 100%;[\s\S]*?width: 100% !important;[\s\S]*?min-width: 0 !important;/)
  assert.match(ruleDialogSource, /\.window-time--start \{ grid-column: 1 \/ 4; grid-row: 2; \}/)
  assert.match(ruleDialogSource, /\.window-time--end \{ grid-column: 4 \/ 7; grid-row: 2; \}/)
})
