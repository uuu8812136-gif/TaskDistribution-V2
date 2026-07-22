import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  buildRoutineRecordPayload,
  buildRuntimeReadingPayload,
  classifyEquipmentScanFailure,
  equipmentBusinessMonthRange,
  equipmentLookupFailureMessage,
  equipmentScanFailureMessage,
  effectiveRoutineDueState,
  groupRoutineSchedules,
  lookupEquipmentFromQr,
  loadEquipmentMonthlyActivity,
  normalizeRoutineSchedules,
  parseEquipmentQrPayload,
  resultOptionsFor,
  scheduleDescription,
  selectExecutableRoutinePlan
} from '../utils/equipment.js'

const objectId = '507f1f77bcf86cd799439011'
const executePageSource = readFileSync(
  new URL('../pages/equipment/execute.vue', import.meta.url),
  'utf8'
)
const equipmentListSource = readFileSync(
  new URL('../pages/equipment/index.vue', import.meta.url),
  'utf8'
)
const equipmentScanSource = readFileSync(
  new URL('../pages/equipment/scan.vue', import.meta.url),
  'utf8'
)
const equipmentDetailSource = readFileSync(
  new URL('../pages/equipment/detail.vue', import.meta.url),
  'utf8'
)
const runtimeReadingSource = readFileSync(
  new URL('../pages/equipment/runtime-reading.vue', import.meta.url),
  'utf8'
)
const workbenchSource = readFileSync(
  new URL('../pages/workbench/index.vue', import.meta.url),
  'utf8'
)
const pagesConfig = JSON.parse(readFileSync(
  new URL('../pages.json', import.meta.url),
  'utf8'
))

test('equipment QR parser accepts V1 payload, raw token and system URL formats', () => {
  const token = 'A'.repeat(43)
  assert.deepEqual(parseEquipmentQrPayload(JSON.stringify({
    v: 1,
    type: 'EQUIPMENT_ASSET',
    token
  })), { token })
  assert.deepEqual(parseEquipmentQrPayload(token), { token })
  assert.deepEqual(
    parseEquipmentQrPayload(`https://example.invalid/equipment/scan/${token}`),
    { token }
  )
  assert.deepEqual(
    parseEquipmentQrPayload(`/equipment/detail?qrToken=${token}`),
    { token }
  )
  assert.throws(() => parseEquipmentQrPayload('{"v":2}'), /无法识别/)
  assert.throws(() => parseEquipmentQrPayload(JSON.stringify({
    v: 1,
    type: 'EQUIPMENT_ASSET',
    token,
    teamId: objectId
  })), /无法识别/)
  assert.throws(() => parseEquipmentQrPayload(
    `https://example.invalid/equipment?token=${token}&qrToken=${'B'.repeat(43)}`
  ), /无法识别/)
  assert.throws(() => parseEquipmentQrPayload('https://example.invalid/not-equipment'), /无法识别/)
})

test('equipment scan failures distinguish cancellation, camera denial and tenant lookup', () => {
  assert.equal(equipmentScanFailureMessage({ errMsg: 'scanCode:fail cancel' }), '')
  assert.deepEqual(classifyEquipmentScanFailure({ errMsg: 'scanCode:fail cancel' }), {
    status: 'cancelled',
    message: '已取消扫码',
    permissionDenied: false
  })
  assert.match(
    equipmentScanFailureMessage({ errMsg: 'scanCode:fail auth deny camera' }),
    /相机权限/
  )
  assert.equal(
    classifyEquipmentScanFailure({ errMsg: 'scanCode:fail permission denied' }).permissionDenied,
    true
  )
  assert.match(equipmentScanFailureMessage({ errMsg: 'scanCode:fail unavailable' }), /手动粘贴/)
  assert.match(equipmentLookupFailureMessage({ statusCode: 404 }), /不属于当前团队/)
  assert.match(equipmentLookupFailureMessage({ statusCode: 403 }), /无权/)
})

test('equipment QR lookup executes the real two-step API flow with one team context', async () => {
  const token = 'Q'.repeat(43)
  const calls = []
  const result = await lookupEquipmentFromQr(token, {
    teamId: objectId,
    fetchEquipment: async (...args) => {
      calls.push(['equipment', ...args])
      return { equipment: { _id: objectId, name: '测试设备' } }
    },
    fetchSchedule: async (...args) => {
      calls.push(['schedule', ...args])
      return {
        equipment: { currentRuntimeHours: 126.5, runtimeHoursUpdatedAt: '2030-02-15T08:00:00.000Z' },
        schedules: [{
          rule: { _id: '507f1f77bcf86cd799439012', routineType: 'INSPECTION' },
          status: 'DUE'
        }]
      }
    }
  })
  assert.equal(result.equipment._id, objectId)
  assert.equal(result.equipment.currentRuntimeHours, 126.5)
  assert.equal(result.schedules[0].dueState, 'DUE')
  assert.equal(calls[0][1], token)
  assert.deepEqual(calls[0][2], { teamId: objectId })
  assert.deepEqual(calls[1][2], { teamId: objectId })
  assert.deepEqual(calls[0][3], { showLoading: false, silentError: true })
  assert.equal(calls[1][1], objectId)
})

test('equipment QR lookup rejects invalid and missing assets before schedule loading', async () => {
  let equipmentCalls = 0
  let scheduleCalls = 0
  await assert.rejects(lookupEquipmentFromQr('not-a-valid-code', {
    fetchEquipment: async () => { equipmentCalls += 1 },
    fetchSchedule: async () => { scheduleCalls += 1 }
  }), /无法识别/)
  assert.equal(equipmentCalls, 0)
  await assert.rejects(lookupEquipmentFromQr('R'.repeat(43), {
    fetchEquipment: async () => {
      equipmentCalls += 1
      return { equipment: null }
    },
    fetchSchedule: async () => { scheduleCalls += 1 }
  }), (error) => error.statusCode === 404)
  assert.equal(equipmentCalls, 1)
  assert.equal(scheduleCalls, 0)
})

test('mini-program exposes the scanner from workbench and equipment module', () => {
  assert.ok(pagesConfig.pages.some(({ path }) => path === 'pages/equipment/scan'))
  assert.match(workbenchSource, /扫码查设备/)
  assert.match(workbenchSource, /\/pages\/equipment\/scan/)
  assert.match(equipmentListSource, /class="scan-entry"/)
  assert.match(equipmentListSource, /openScanner/)
  assert.match(equipmentScanSource, /uni\.scanCode\(/)
  assert.match(equipmentScanSource, /onlyFromCamera: false/)
  assert.match(
    equipmentScanSource,
    /success:\s*\(\{\s*result\s*\}\)\s*=>\s*lookup\(result\)/,
    'scanCode success must forward the decoded result into the real lookup flow'
  )
  assert.match(
    equipmentScanSource,
    /fail:\s*handleScanFailure/,
    'scanCode failure must classify cancellation and camera-permission errors'
  )
  assert.match(equipmentScanSource, /classifyEquipmentScanFailure\(error\)/)
  assert.match(equipmentScanSource, /lookupManualCode/)
})

test('scanned equipment remains read-only unless a team permission allows execution', () => {
  assert.match(equipmentScanSource, /userStore\.isTeamMode && userStore\.can\(/)
  assert.match(equipmentScanSource, /'equipment\.maintain' : 'equipment\.inspect'/)
  assert.match(equipmentScanSource, /当前账号仅可查看设备信息/)
  assert.match(equipmentScanSource, /fetchEquipment: getEquipmentByQrToken/)
  assert.match(equipmentScanSource, /fetchSchedule: getEquipmentRoutineSchedule/)
  assert.match(equipmentScanSource, /openCameraSettings/)
  assert.match(equipmentScanSource, /version !== requestVersion \|\| requestedTeamId !== requestTeamId\(\)/)
})

test('scan and detail load current Shanghai-month routine and repair activity with scoped ids', async () => {
  assert.deepEqual(equipmentBusinessMonthRange('2030-01-31T16:30:00.000Z'), {
    month: '2030-02',
    from: '2030-02-01T00:00:00+08:00',
    to: '2030-02-28T23:59:59.999+08:00'
  })
  const calls = []
  const activity = await loadEquipmentMonthlyActivity(objectId, {
    teamId: '507f1f77bcf86cd799439099',
    now: '2030-02-15T08:00:00.000Z',
    fetchRecords: async (params) => {
      calls.push(['records', params])
      return { records: [{ _id: 'record-1' }], total: 1 }
    },
    fetchRepairs: async (params) => {
      calls.push(['repairs', params])
      return { repairs: [{ _id: 'repair-1' }], total: 1 }
    }
  })
  assert.equal(activity.month, '2030-02')
  assert.equal(calls[0][1].equipmentId, objectId)
  assert.equal(calls[0][1].teamId, '507f1f77bcf86cd799439099')
  assert.equal(calls[1][1].equipmentId, objectId)
  assert.equal(calls[1][1].startDate, '2030-02-01T00:00:00+08:00')
  assert.match(equipmentScanSource, /loadEquipmentMonthlyActivity/)
  assert.match(equipmentScanSource, /fetchRecords:\s*getEquipmentRoutineRecords/)
  assert.match(equipmentScanSource, /fetchRepairs:\s*getEquipmentRepairs/)
  assert.match(equipmentDetailSource, /userStore\.isGlobalReadOnly && teamId\.value/)
  assert.match(equipmentDetailSource, /本月稽查情况/)
})

test('routine schedule descriptions retain dynamic calendar, meter and combination rules', () => {
  assert.equal(scheduleDescription({ mode: 'MANUAL' }), '按需执行')
  assert.equal(scheduleDescription({
    mode: 'CALENDAR',
    calendar: { unit: 'WEEK', interval: 2 }
  }), '每 2 周')
  assert.equal(scheduleDescription({
    mode: 'COMBINED',
    duePolicy: 'ANY',
    calendar: { unit: 'MONTH', interval: 1 },
    runtime: { intervalHours: 200 }
  }), '每 1 月；每运行 200 小时（任一先到）')
})

test('one equipment keeps independent daily, weekly, monthly and runtime inspection/maintenance rules', () => {
  const rule = (id, routineType, name, schedule) => ({
    rule: { _id: id, routineType, name, schedule },
    status: 'UPCOMING'
  })
  const schedules = normalizeRoutineSchedules({
    schedules: [
      rule('507f1f77bcf86cd799439101', 'INSPECTION', '日点检', {
        mode: 'CALENDAR', calendar: { unit: 'DAY', interval: 1 }
      }),
      rule('507f1f77bcf86cd799439102', 'INSPECTION', '周点检', {
        mode: 'CALENDAR', calendar: { unit: 'WEEK', interval: 1 }
      }),
      rule('507f1f77bcf86cd799439103', 'INSPECTION', '月点检', {
        mode: 'CALENDAR', calendar: { unit: 'MONTH', interval: 1 }
      }),
      rule('507f1f77bcf86cd799439104', 'MAINTENANCE', '日保养', {
        mode: 'CALENDAR', calendar: { unit: 'DAY', interval: 1 }
      }),
      rule('507f1f77bcf86cd799439105', 'MAINTENANCE', '月保养', {
        mode: 'CALENDAR', calendar: { unit: 'MONTH', interval: 1 }
      }),
      rule('507f1f77bcf86cd799439106', 'MAINTENANCE', '小时保养', {
        mode: 'RUNTIME_HOURS', runtime: { intervalHours: 200 }
      })
    ]
  })
  assert.equal(schedules.length, 6)
  assert.deepEqual(schedules.map(({ ruleId }) => ruleId), [
    '507f1f77bcf86cd799439101',
    '507f1f77bcf86cd799439102',
    '507f1f77bcf86cd799439103',
    '507f1f77bcf86cd799439104',
    '507f1f77bcf86cd799439105',
    '507f1f77bcf86cd799439106'
  ])
  const groups = groupRoutineSchedules(schedules)
  assert.deepEqual(groups.map(({ routineType, entries }) => [routineType, entries.length]), [
    ['INSPECTION', 3],
    ['MAINTENANCE', 3]
  ])
  assert.deepEqual(groups.flatMap(({ entries }) => entries.map(({ ruleId }) => ruleId)), schedules.map(({ ruleId }) => ruleId))
})

test('open plans override calculated due state and execution selects the most urgent plan', () => {
  assert.equal(effectiveRoutineDueState({ status: 'UPCOMING', planStatus: 'OVERDUE' }), 'OVERDUE')
  assert.equal(effectiveRoutineDueState({ status: 'UPCOMING', planStatus: 'IN_WINDOW' }), 'DUE')
  assert.equal(effectiveRoutineDueState({ status: 'OVERDUE', planStatus: 'PLANNED' }), 'UPCOMING')

  const selected = selectExecutableRoutinePlan([
    {
      _id: '507f1f77bcf86cd799439205',
      status: 'PLANNED',
      dueAt: '2030-01-01T01:00:00.000Z'
    },
    {
      _id: '507f1f77bcf86cd799439204',
      status: 'IN_WINDOW',
      dueAt: '2030-01-01T02:00:00.000Z'
    },
    {
      _id: '507f1f77bcf86cd799439203',
      status: 'OVERDUE',
      dueAt: '2030-01-01T00:30:00.000Z'
    },
    {
      _id: '507f1f77bcf86cd799439202',
      status: 'OVERDUE',
      dueAt: '2030-01-01T00:15:00.000Z'
    }
  ])
  assert.equal(selected?._id, '507f1f77bcf86cd799439202')
  assert.equal(selectExecutableRoutinePlan([{ status: 'PLANNED' }]), null)
  assert.match(executePageSource, /selectExecutableRoutinePlan\(entry\.plans\)/)
})

test('mini-program surfaces schedule periods and the authoritative runtime reading history', () => {
  assert.match(equipmentScanSource, /scheduleDescription\(entry\.rule\.schedule\)/)
  assert.match(equipmentScanSource, /groupRoutineSchedules\(schedules\.value\)/)
  assert.match(equipmentScanSource, /currentRuntimeHours == null \? '待录入'/)
  assert.match(equipmentScanSource, /openRuntimeReading/)
  assert.match(equipmentDetailSource, /groupRoutineSchedules\(schedules\.value\)/)
  assert.match(equipmentDetailSource, /currentHours=\$\{encodeURIComponent\(currentRuntimeHours\.value\)\}/)
  assert.match(runtimeReadingSource, /getEquipmentRuntimeReadings/)
  assert.match(runtimeReadingSource, /buildRuntimeReadingPayload\(\{[\s\S]*currentHours: currentHours\.value/)
  assert.match(runtimeReadingSource, /sourceLabel\(reading\.source\)/)
})

test('routine payload is derived from the server rule and rejects missing abnormal evidence', () => {
  const rule = {
    _id: objectId,
    routineType: 'INSPECTION',
    photoPolicy: 'ON_ABNORMAL',
    abnormalNoteRequired: true,
    checklistItems: [
      { key: 'belt', name: '检查磨损', required: true },
      { key: 'noise', name: '检查异响', required: true }
    ]
  }
  assert.throws(() => buildRoutineRecordPayload({
    rule,
    results: {
      belt: { result: 'ABNORMAL', note: '' },
      noise: { result: 'NORMAL' }
    }
  }), /异常说明/)

  const payload = buildRoutineRecordPayload({
    rule,
    runtimeHours: '200.5',
    photoFileIds: ['507f1f77bcf86cd799439012'],
    results: {
      belt: { result: 'ABNORMAL', note: '磨损超限' },
      noise: { result: 'NORMAL', note: '客户端多余说明仍按白名单保留' }
    }
  })
  assert.equal(payload.ruleId, objectId)
  assert.equal(payload.runtimeHours, 200.5)
  assert.equal(payload.itemResults.length, 2)
  assert.deepEqual(Object.keys(payload.itemResults[0]).sort(), ['itemKey', 'note', 'result'])
  assert.equal(Object.hasOwn(payload, 'note'), false)
  assert.equal(payload.abnormalSummary, '')
  assert.equal(Object.hasOwn(payload, 'teamId'), false)

  const summarized = buildRoutineRecordPayload({
    rule,
    abnormalSummary: '皮带磨损，已停机等待更换',
    photoFileIds: ['507f1f77bcf86cd799439012'],
    results: {
      belt: { result: 'ABNORMAL', note: '' },
      noise: { result: 'NORMAL', note: '' }
    }
  })
  assert.equal(summarized.abnormalSummary, '皮带磨损，已停机等待更换')
})

test('maintenance required items cannot be skipped and meter payload cannot move below zero', () => {
  const rule = {
    _id: objectId,
    routineType: 'MAINTENANCE',
    photoPolicy: 'NONE',
    checklistItems: [{ key: 'oil', name: '更换润滑油', required: true }]
  }
  assert.throws(() => buildRoutineRecordPayload({
    rule,
    results: { oil: { result: 'SKIPPED' } }
  }), /必填项目/)
  assert.deepEqual(buildRuntimeReadingPayload({
    hours: '321.5',
    reason: ' 班后读数 '
  }), {
    hours: 321.5,
    reason: '班后读数'
  })
  assert.throws(() => buildRuntimeReadingPayload({ hours: -1 }), /非负数字/)
  assert.throws(() => buildRuntimeReadingPayload({ hours: '' }), /请填写累计运行小时/)
  assert.throws(() => buildRuntimeReadingPayload({
    hours: 321,
    currentHours: 321.5
  }), /不能小于当前读数 321\.5/)
})

test('runtime-based routine validation rejects a missing meter value before photo upload', () => {
  const rule = {
    _id: objectId,
    routineType: 'INSPECTION',
    photoPolicy: 'ALWAYS',
    schedule: { mode: 'RUNTIME_HOURS', runtime: { intervalHours: 200 } },
    checklistItems: [{ key: 'bearing', name: '检查轴承', required: true }]
  }
  assert.throws(() => buildRoutineRecordPayload({
    rule,
    runtimeHours: '',
    photoFileIds: ['507f1f77bcf86cd799439012'],
    results: { bearing: { result: 'NORMAL' } }
  }), /请填写本次累计运行小时/)
})

test('optional inspection items can be skipped while required items cannot', () => {
  const rule = {
    _id: objectId,
    routineType: 'INSPECTION',
    photoPolicy: 'NONE',
    checklistItems: [
      { key: 'required', name: '必检项', required: true },
      { key: 'optional', name: '选检项', required: false }
    ]
  }
  assert.deepEqual(
    resultOptionsFor('INSPECTION', rule.checklistItems[0]).map(({ value }) => value),
    ['NORMAL', 'ABNORMAL']
  )
  assert.deepEqual(
    resultOptionsFor('INSPECTION', rule.checklistItems[1]).map(({ value }) => value),
    ['NORMAL', 'ABNORMAL', 'SKIPPED']
  )
  const payload = buildRoutineRecordPayload({
    rule,
    results: {
      required: { result: 'NORMAL' },
      optional: { result: 'SKIPPED', note: '本次不适用' }
    }
  })
  assert.equal(payload.itemResults[1].result, 'SKIPPED')
  assert.throws(() => buildRoutineRecordPayload({
    rule,
    results: {
      required: { result: 'SKIPPED' },
      optional: { result: 'SKIPPED' }
    }
  }), /必填项目/)
})

test('schedule response normalization accepts the authoritative schedules wrapper', () => {
  const schedules = normalizeRoutineSchedules({
    schedules: [{
      rule: { _id: objectId, routineType: 'INSPECTION' },
      status: 'DUE',
      latestRecord: { _id: '507f1f77bcf86cd799439013', performedAt: '2026-07-17T08:00:00.000Z' }
    }]
  })
  assert.equal(schedules[0].ruleId, objectId)
  assert.equal(schedules[0].dueState, 'DUE')
  assert.equal(schedules[0].lastRecord._id, '507f1f77bcf86cd799439013')
})

test('routine execution validates before upload and cleans only temporary files after failure', () => {
  const validationIndex = executePageSource.indexOf('buildRoutineRecordPayload({')
  const uploadIndex = executePageSource.indexOf('for (const photo of photos.value)')
  assert.ok(validationIndex >= 0 && validationIndex < uploadIndex)
  assert.match(executePageSource, /file\.status === 'TEMPORARY'/)
  assert.match(executePageSource, /if \(!photo\.fileId\) photo\.fileId = await uploadEquipmentRoutinePhoto\(photo\)/)
  assert.match(executePageSource, /const alreadyCommitted = await cleanupTemporaryUploads\(\)/)
  assert.match(executePageSource, /statuses\.includes\('ACTIVE'\)/)
})

test('routine execution blocks duplicate submission and photo changes while submitting', () => {
  assert.match(executePageSource, /const submit = async \(\) => \{\s*if \(submitting\.value\) return/)
  assert.match(executePageSource, /const takePhoto = \(\) => \{\s*if \(submitting\.value\) return/)
  assert.match(executePageSource, /const removePhoto = async \(index\) => \{\s*if \(submitting\.value\) return/)
  assert.match(executePageSource, /class="submit-button"[^>]*:disabled="submitting"/)
  assert.match(executePageSource, /class="remove-photo"[^>]*:disabled="submitting"/)
  assert.match(executePageSource, /<button v-if="!submitting && photos\.length < 10" class="add-photo"/)
})

test('routine camera photos are burned into a canvas file before upload without raw-photo fallback', () => {
  assert.ok(pagesConfig.pages.some(({ path }) => path === 'pages/equipment/routine-workbench'))
  assert.ok(pagesConfig.pages.some(({ path }) => path === 'pages/equipment/routine-exception'))
  assert.match(executePageSource, /sourceType:\s*\['camera'\]/)
  assert.match(executePageSource, /canvas-id="routineWatermarkCanvas"/)
  assert.match(executePageSource, /uni\.canvasToTempFilePath\(/)
  assert.match(executePageSource, /const watermarkedPath = await burnWatermark\(file\.tempFilePath/)
  assert.match(executePageSource, /path:\s*watermarkedPath/)
  assert.doesNotMatch(executePageSource, /path:\s*file\.tempFilePath/)
  assert.match(executePageSource, /title:\s*'水印照片生成失败'/)
  assert.match(executePageSource, /if \(!photo\.fileId\) photo\.fileId = await uploadEquipmentRoutinePhoto\(photo\)/)
})

test('routine payload carries camera capture and location evidence without client team identity', () => {
  const rule = {
    _id: objectId,
    routineType: 'MAINTENANCE',
    photoPolicy: 'ALWAYS',
    schedule: { mode: 'CALENDAR' },
    checklistItems: [{ key: 'oil', name: '更换润滑油', required: true }]
  }
  const fileId = '507f1f77bcf86cd799439012'
  const payload = buildRoutineRecordPayload({
    rule,
    results: { oil: { result: 'COMPLETED', note: '' } },
    photoFileIds: [fileId],
    photoEvidence: [{
      capturedAt: '2030-01-15T02:29:00.000Z',
      locationStatus: 'DENIED'
    }],
    planId: '507f1f77bcf86cd799439013'
  })
  assert.equal(payload.photoEvidence[0].fileId, fileId)
  assert.equal(payload.photoEvidence[0].sourceType, 'CAMERA')
  assert.equal(payload.photoEvidence[0].locationStatus, 'DENIED')
  assert.equal(payload.planId, '507f1f77bcf86cd799439013')
  assert.equal(Object.hasOwn(payload, 'teamId'), false)
})

test('global read-only equipment switching discards stale team responses', () => {
  assert.match(equipmentListSource, /const version = \+\+requestVersion/)
  assert.match(equipmentListSource, /if \(version !== requestVersion\) return/)
  assert.match(equipmentListSource, /equipment\.value = \[\][\s\S]*total\.value = 0[\s\S]*refresh\(\)/)
})
