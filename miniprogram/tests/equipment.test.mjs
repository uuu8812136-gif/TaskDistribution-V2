import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  buildRoutineRecordPayload,
  buildRuntimeReadingPayload,
  normalizeRoutineSchedules,
  parseEquipmentQrPayload,
  resultOptionsFor,
  scheduleDescription
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

test('equipment QR parser accepts only the opaque V1 asset payload', () => {
  const token = 'A'.repeat(43)
  assert.deepEqual(parseEquipmentQrPayload(JSON.stringify({
    v: 1,
    type: 'EQUIPMENT_ASSET',
    token
  })), { token })
  assert.throws(() => parseEquipmentQrPayload('{"v":2}'), /无法识别/)
  assert.throws(() => parseEquipmentQrPayload(JSON.stringify({
    v: 1,
    type: 'EQUIPMENT_ASSET',
    token,
    teamId: objectId
  })), /无法识别/)
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

test('global read-only equipment switching discards stale team responses', () => {
  assert.match(equipmentListSource, /const version = \+\+requestVersion/)
  assert.match(equipmentListSource, /if \(version !== requestVersion\) return/)
  assert.match(equipmentListSource, /equipment\.value = \[\][\s\S]*total\.value = 0[\s\S]*refresh\(\)/)
})
