import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  IMPORT_DECISION_ACTIONS,
  appendChecklistItem,
  buildRoutineRecordPayload,
  buildRoutineRulePayload,
  buildRuntimeReadingPayload,
  buildEquipmentImportConfirmation,
  buildCategoryTree,
  buildEquipmentPayload,
  entityName,
  equipmentImportDecisionOptions,
  equipmentImportExceptionLabel,
  isEquipmentImportDecisionComplete,
  moveChecklistItem,
  normalizeRuntimeHours,
  optionForValue,
  routineAbnormalNotesComplete,
  routineItemResultOptions,
  routineScheduleLabel,
  routineScheduleSummary,
  effectiveRoutineDueState,
  removeChecklistItemAt,
  EQUIPMENT_STATUS_OPTIONS
} from '../src/utils/equipment.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('equipment import UI exposes progress, isolated timeout, cancellation, and local job recovery', () => {
  const api = fs.readFileSync(path.join(root, 'src/api/equipment.js'), 'utf8')
  const dialog = fs.readFileSync(
    path.join(root, 'src/views/equipment/components/EquipmentImportDialog.vue'),
    'utf8'
  )
  assert.match(api, /timeout: 15 \* 60 \* 1000/)
  assert.match(api, /onUploadProgress/)
  assert.match(api, /\/imports\/\$\{importJobId\}\/cancel/)
  assert.match(dialog, /equipmentImportPreviewJobId/)
  assert.match(dialog, /localStorage\.setItem/)
  assert.match(dialog, /restorePreview/)
  assert.match(dialog, /cancelEquipmentImport/)
  assert.match(dialog, /<el-step title="上传"/)
  assert.match(dialog, /<el-step title="解析"/)
  assert.match(dialog, /<el-step title="写入"/)
})

test('equipment payload contains only normalized fixed fields', () => {
  const payload = buildEquipmentPayload({
    orgUnitId: 'org-1',
    assetCode: ' A-001 ',
    name: ' 叉车 ',
    categoryId: 'category-1',
    specification: ' 2T ',
    manufacturer: ' 厂商 ',
    quantity: '2',
    unit: ' 台 ',
    acquisitionDate: '',
    originalValue: '',
    custodianUserId: '',
    location: ' 一库 ',
    remark: ' 正常 ',
    reason: ' 新增 '
  })
  assert.deepEqual(payload, {
    orgUnitId: 'org-1',
    assetCode: 'A-001',
    name: '叉车',
    categoryId: 'category-1',
    specification: '2T',
    manufacturer: '厂商',
    quantity: 2,
    unit: '台',
    acquisitionDate: null,
    originalValue: null,
    custodianUserId: null,
    location: '一库',
    remark: '正常',
    reason: '新增'
  })
})

test('category tree and labels are deterministic', () => {
  const tree = buildCategoryTree([
    { _id: 'child-b', parentId: 'root', name: 'B', sortOrder: 20 },
    { _id: 'root', parentId: null, name: 'Root', sortOrder: 0 },
    { _id: 'child-a', parentId: 'root', name: 'A', sortOrder: 10 }
  ])
  assert.deepEqual(tree[0].children.map((item) => item._id), ['child-a', 'child-b'])
  assert.equal(entityName([{ _id: 'org-1', name: '一分部' }], 'org-1'), '一分部')
  assert.equal(optionForValue(EQUIPMENT_STATUS_OPTIONS, 'IN_USE').label, '在用')
})

test('checklist editor supports repeated additions, stable ordering and a one-item minimum', () => {
  const first = { _localKey: 'item-1', name: '检查制动' }
  const second = { _localKey: 'item-2', name: '检查轮胎' }
  const third = { _localKey: 'item-3', name: '检查灯光' }
  const items = [first]

  assert.equal(appendChecklistItem(items, second), 2)
  assert.equal(appendChecklistItem(items, third), 3)
  assert.deepEqual(items, [first, second, third])

  assert.equal(moveChecklistItem(items, 2, -1), true)
  assert.deepEqual(items, [first, third, second])
  assert.equal(moveChecklistItem(items, 0, -1), false)
  assert.deepEqual(items, [first, third, second])

  assert.equal(removeChecklistItemAt(items, 1), true)
  assert.equal(removeChecklistItemAt(items, 1), true)
  assert.deepEqual(items, [first])
  assert.equal(removeChecklistItemAt(items, 0), false)
  assert.deepEqual(items, [first])
})

test('equipment import decisions expose only actions accepted by the backend', () => {
  const warning = equipmentImportDecisionOptions({
    severity: 'WARNING',
    hasSuggestedValue: true
  }).map(({ value }) => value)
  assert.deepEqual(warning, [
    IMPORT_DECISION_ACTIONS.ACCEPT_AS_IS,
    IMPORT_DECISION_ACTIONS.ACCEPT_SUGGESTION,
    IMPORT_DECISION_ACTIONS.USE_RESOLVED_VALUE,
    IMPORT_DECISION_ACTIONS.SKIP_ROW
  ])

  const error = equipmentImportDecisionOptions({
    severity: 'ERROR',
    hasSuggestedValue: false
  }).map(({ value }) => value)
  assert.deepEqual(error, [
    IMPORT_DECISION_ACTIONS.USE_RESOLVED_VALUE,
    IMPORT_DECISION_ACTIONS.SKIP_ROW
  ])
  assert.equal(equipmentImportExceptionLabel('ASSET_CODE_MISSING'), '资产编号缺失')
})

test('equipment import confirmation carries the optimistic version and explicit decisions', () => {
  const decisions = {
    first: {
      exceptionId: 'exception-1',
      action: IMPORT_DECISION_ACTIONS.SKIP_ROW,
      value: ''
    },
    second: {
      exceptionId: 'exception-2',
      action: IMPORT_DECISION_ACTIONS.USE_RESOLVED_VALUE,
      value: 'A-002'
    }
  }
  assert.equal(isEquipmentImportDecisionComplete(decisions.first), true)
  assert.equal(isEquipmentImportDecisionComplete(decisions.second), true)
  assert.deepEqual(buildEquipmentImportConfirmation({
    status: 'PREVIEW_READY',
    version: 3
  }, decisions, ' 客户确认后发布 '), {
    expectedVersion: 3,
    reason: '客户确认后发布',
    decisions: [
      {
        exceptionId: 'exception-1',
        action: IMPORT_DECISION_ACTIONS.SKIP_ROW
      },
      {
        exceptionId: 'exception-2',
        action: IMPORT_DECISION_ACTIONS.USE_RESOLVED_VALUE,
        value: 'A-002'
      }
    ]
  })
})

test('routine rule payload supports calendar, runtime and combined schedules', () => {
  const base = {
    routineType: 'INSPECTION',
    categoryId: 'category-1',
    name: ' 电机皮带检查 ',
    description: ' 检查张紧度 ',
    checklistItems: [
      { key: 'belt', name: ' 检查皮带 ', description: ' 不得开裂 ', required: true },
      { name: '检查张紧度', description: '', required: false }
    ],
    photoPolicy: 'ON_ABNORMAL',
    abnormalNoteRequired: true,
    status: 'ACTIVE',
    version: 2,
    teamId: 'must-not-leak'
  }
  const calendar = buildRoutineRulePayload({
    ...base,
    schedule: {
      mode: 'CALENDAR',
      calendar: { unit: 'DAY', interval: 3, firstDueAt: '2026-07-20T08:00:00+08:00' }
    }
  })
  assert.equal(calendar.schedule.calendar.firstDueAt, '2026-07-20T00:00:00.000Z')
  assert.equal(calendar.checklistItems[0].sortOrder, 0)
  assert.equal(calendar.checklistItems[1].sortOrder, 10)
  assert.equal(calendar.checklistItems[0].key, 'belt')
  assert.equal(calendar.checklistItems[0].description, '不得开裂')
  assert.equal('version' in calendar, false)
  assert.equal('teamId' in calendar, false)
  assert.equal(routineScheduleLabel(calendar.schedule), '每 3 天')

  const runtime = buildRoutineRulePayload({
    ...base,
    schedule: { mode: 'RUNTIME_HOURS', runtime: { intervalHours: 200 } }
  })
  assert.equal(routineScheduleLabel(runtime.schedule), '每运行 200 小时')

  const combined = buildRoutineRulePayload({
    ...base,
    schedule: {
      mode: 'COMBINED',
      duePolicy: 'ANY',
      calendar: { unit: 'MONTH', interval: 1, firstDueAt: '2026-08-01T00:00:00Z' },
      runtime: { intervalHours: 500 }
    }
  })
  assert.equal(routineScheduleLabel(combined.schedule), '每月 + 每运行 500 小时（任一到期）')
  assert.equal('status' in combined, false)
})

test('one equipment may summarize simultaneous daily, weekly, monthly and runtime rules by routine type', () => {
  const summary = routineScheduleSummary([
    { rule: { routineType: 'INSPECTION', schedule: { mode: 'CALENDAR', calendar: { unit: 'DAY' } } } },
    { rule: { routineType: 'INSPECTION', schedule: { mode: 'CALENDAR', calendar: { unit: 'WEEK' } } } },
    {
      rule: {
        routineType: 'INSPECTION',
        schedule: { mode: 'COMBINED', calendar: { unit: 'MONTH' }, runtime: { intervalHours: 500 } }
      }
    },
    { rule: { routineType: 'MAINTENANCE', schedule: { mode: 'RUNTIME_HOURS', runtime: { intervalHours: 200 } } } },
    { rule: { routineType: 'MAINTENANCE', schedule: { mode: 'MANUAL' } } }
  ])

  assert.deepEqual(summary.INSPECTION, {
    total: 3,
    DAY: 1,
    WEEK: 1,
    MONTH: 1,
    RUNTIME_HOURS: 1,
    MANUAL: 0
  })
  assert.deepEqual(summary.MAINTENANCE, {
    total: 2,
    DAY: 0,
    WEEK: 0,
    MONTH: 0,
    RUNTIME_HOURS: 1,
    MANUAL: 1
  })
})

test('routine due state prefers the authoritative open-plan status', () => {
  assert.equal(effectiveRoutineDueState({ planStatus: 'OVERDUE', status: 'UPCOMING' }), 'OVERDUE')
  assert.equal(effectiveRoutineDueState({ planStatus: 'IN_WINDOW', status: 'OVERDUE' }), 'DUE')
  assert.equal(effectiveRoutineDueState({ planStatus: 'PLANNED', status: 'OVERDUE' }), 'UPCOMING')
  assert.equal(effectiveRoutineDueState({ dueState: 'WAITING_FOR_READING', status: 'UPCOMING' }), 'WAITING_FOR_READING')
})

test('routine execution and runtime reading payloads contain only accepted fields', () => {
  assert.deepEqual(buildRoutineRecordPayload({
    ruleId: 'rule-1',
    runtimeHours: '215.5',
    itemResults: [
      { itemKey: 'belt', result: 'ABNORMAL', note: ' 松动 ', photoFileIds: ['must-not-leak'] }
    ],
    abnormalSummary: ' 已安排处理 ',
    photoFileIds: [],
    idempotencyKey: 'request-1',
    teamId: 'must-not-leak'
  }), {
    ruleId: 'rule-1',
    runtimeHours: 215.5,
    itemResults: [
      { itemKey: 'belt', result: 'ABNORMAL', note: '松动' }
    ],
    abnormalSummary: '已安排处理',
    photoFileIds: [],
    idempotencyKey: 'request-1'
  })

  assert.deepEqual(buildRuntimeReadingPayload({
    hours: '220',
    recordedAt: '2026-07-20T08:00:00+08:00',
    reason: ' 交班读数 ',
    teamId: 'must-not-leak'
  }), {
    hours: 220,
    reason: '交班读数'
  })
})

test('routine builders reject incomplete schedules and checklist results', () => {
  assert.throws(() => buildRoutineRulePayload({
    routineType: 'MAINTENANCE',
    categoryId: 'category-1',
    name: '保养',
    checklistItems: [{ name: '润滑' }],
    schedule: { mode: 'RUNTIME_HOURS', runtime: { intervalHours: 0 } },
    photoPolicy: 'ALWAYS'
  }), /greater than zero/)

  assert.throws(() => buildRoutineRecordPayload({
    ruleId: 'rule-1',
    itemResults: [{ itemKey: 'item-1', result: '' }]
  }), /complete item results/)
})

test('maintenance records accept completed and skipped results without leaking item photos', () => {
  assert.deepEqual(buildRoutineRecordPayload({
    ruleId: 'maintenance-rule',
    itemResults: [
      { itemKey: 'required-item', result: 'COMPLETED', note: '', photoFileIds: ['ignored'] },
      { itemKey: 'optional-item', result: 'SKIPPED', note: '本次无需执行' }
    ],
    abnormalSummary: '',
    photoFileIds: []
  }), {
    ruleId: 'maintenance-rule',
    itemResults: [
      { itemKey: 'required-item', result: 'COMPLETED', note: '' },
      { itemKey: 'optional-item', result: 'SKIPPED', note: '本次无需执行' }
    ],
    abnormalSummary: '',
    photoFileIds: []
  })
})

test('optional inspection and maintenance items may be skipped while required items may not', () => {
  assert.deepEqual(
    routineItemResultOptions('INSPECTION', false).map((item) => item.value),
    ['NORMAL', 'ABNORMAL', 'SKIPPED']
  )
  assert.deepEqual(
    routineItemResultOptions('MAINTENANCE', false).map((item) => item.value),
    ['COMPLETED', 'ABNORMAL', 'SKIPPED']
  )
  assert.equal(routineItemResultOptions('INSPECTION', true).some((item) => item.value === 'SKIPPED'), false)
  assert.equal(routineItemResultOptions('MAINTENANCE', true).some((item) => item.value === 'SKIPPED'), false)
})

test('an abnormal item may use either its own note or the top-level summary', () => {
  const results = [{ itemKey: 'belt', result: 'ABNORMAL', note: '' }]
  assert.equal(routineAbnormalNotesComplete(results, '', true), false)
  assert.equal(routineAbnormalNotesComplete(results, '统一说明：已停机处理', true), true)
  assert.equal(routineAbnormalNotesComplete([{ ...results[0], note: '皮带松动' }], '', true), true)
  assert.equal(routineAbnormalNotesComplete(results, '', false), true)
})

test('missing runtime readings remain empty instead of becoming zero', () => {
  assert.equal(normalizeRuntimeHours(null), null)
  assert.equal(normalizeRuntimeHours(undefined), null)
  assert.equal(normalizeRuntimeHours(''), null)
  assert.equal(normalizeRuntimeHours('0'), 0)
  assert.equal(normalizeRuntimeHours(12.5), 12.5)
  assert.equal(normalizeRuntimeHours(-1), null)
  assert.equal(normalizeRuntimeHours('invalid'), null)
})
