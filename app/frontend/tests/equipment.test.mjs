import assert from 'node:assert/strict'
import test from 'node:test'

import {
  IMPORT_DECISION_ACTIONS,
  buildEquipmentImportConfirmation,
  buildCategoryTree,
  buildEquipmentPayload,
  entityName,
  equipmentImportDecisionOptions,
  equipmentImportExceptionLabel,
  isEquipmentImportDecisionComplete,
  optionForValue,
  EQUIPMENT_STATUS_OPTIONS
} from '../src/utils/equipment.js'

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
