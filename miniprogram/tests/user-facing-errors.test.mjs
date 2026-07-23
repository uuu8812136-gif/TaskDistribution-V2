import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  buildRoutineRecordPayload,
  equipmentBusinessMonthRange,
  equipmentLookupFailureMessage,
  loadEquipmentMonthlyActivity
} from '../utils/equipment.js'
import { businessNaturalDate } from '../utils/reporting.js'
import { requestErrorMessage } from '../utils/requestErrorMessages.js'
import { taskDetailUrl } from '../utils/taskPolicy.js'

const chineseCharacterPattern = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u

function assertChineseError(run) {
  assert.throws(run, (error) => (
    typeof error?.message === 'string' && chineseCharacterPattern.test(error.message)
  ))
}

test('mini-program client validation errors use Chinese messages', async () => {
  assertChineseError(() => taskDetailUrl(null))
  assertChineseError(() => equipmentBusinessMonthRange('not-a-date'))
  assertChineseError(() => businessNaturalDate('not-a-date'))
  assertChineseError(() => buildRoutineRecordPayload({
    rule: {
      _id: 'invalid-rule-id',
      routineType: 'INSPECTION',
      checklistItems: []
    }
  }))
  await assert.rejects(
    loadEquipmentMonthlyActivity('507f1f77bcf86cd799439011'),
    (error) => chineseCharacterPattern.test(error?.message || '')
  )
})

test('unknown native English errors are replaced with a Chinese operation fallback', () => {
  const nativeError = new Error('request:fail timeout')
  assert.equal(requestErrorMessage(nativeError, '操作失败，请稍后重试'), '操作失败，请稍后重试')
  assert.equal(
    equipmentLookupFailureMessage(nativeError),
    '设备查询失败，请检查网络后重试'
  )
})

test('user-facing pages localize errors instead of rendering native error.message', () => {
  const pagePaths = [
    '../pages/equipment/execute.vue',
    '../pages/equipment/inventory-detail.vue',
    '../pages/equipment/repair-list.vue',
    '../pages/equipment/runtime-reading.vue',
    '../pages/reporting/attendance-form.vue',
    '../pages/reporting/daily-report.vue',
    '../pages/reporting/transport-form.vue',
    '../pages/task/approve-extension.vue',
    '../pages/task/complete.vue',
    '../pages/task/review.vue'
  ]

  for (const pagePath of pagePaths) {
    const source = readFileSync(new URL(pagePath, import.meta.url), 'utf8')
    assert.match(source, /requestErrorMessage\(/, `${pagePath} should use the shared error localizer`)
    assert.doesNotMatch(
      source,
      /(?:title|content):\s*(?:error|err)(?:\?\.|\.)message/,
      `${pagePath} must not render a native error message directly`
    )
  }

  const dailyReportSource = readFileSync(
    new URL('../pages/reporting/daily-report.vue', import.meta.url),
    'utf8'
  )
  assert.doesNotMatch(dailyReportSource, /return\s+error\?\.(?:data\?\.)?message/)
})

test('runtime source no longer contains the audited English validation messages', () => {
  const sourcePaths = [
    '../api/index.js',
    '../stores/user.js',
    '../utils/equipment.js',
    '../utils/reporting.js',
    '../utils/sessionCore.js',
    '../utils/taskPolicy.js'
  ]
  const source = sourcePaths
    .map((sourcePath) => readFileSync(new URL(sourcePath, import.meta.url), 'utf8'))
    .join('\n')
  const removedMessages = [
    'Authentication context changed while loading',
    'Authentication token is missing',
    'Daily production slot must be previous or current',
    'Equipment QR lookup dependencies are required',
    'Invalid date',
    'Managed attachment fileId is required',
    'Managed fileId is required',
    'Monthly activity APIs are required',
    'Photo file ids are invalid',
    'Response belongs to an inactive authentication context',
    'Routine type is invalid',
    'Scoped cache keys require namespace, userId and activeTeamId',
    'Task id is required',
    'readToken must be a function'
  ]

  for (const message of removedMessages) {
    assert.equal(source.includes(message), false, `English validation remains: ${message}`)
  }
})
