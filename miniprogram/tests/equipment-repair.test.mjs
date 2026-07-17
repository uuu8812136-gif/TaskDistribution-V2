import assert from 'node:assert/strict'
import test from 'node:test'
import {
  REPAIR_ACTION_LABELS,
  REPAIR_STATUS_LABELS,
  REPAIR_TYPES,
  createRepairPart,
  repairLineAmount,
  repairStatusLabel,
  repairTypeLabel
} from '../utils/equipmentRepair.js'

test('mini program exposes all three fixed repair types and workflow states', () => {
  assert.deepEqual(REPAIR_TYPES.map((item) => item.value), [
    'FAULT_REPORT',
    'PARTS_REPAIR',
    'NO_PARTS_REPAIR'
  ])
  assert.equal(Object.keys(REPAIR_STATUS_LABELS).length, 9)
  assert.equal(repairTypeLabel('FAULT_REPORT'), '故障报修')
  assert.equal(repairStatusLabel('MANAGER_APPROVAL_PENDING'), '待部门经理终审')
  assert.ok(REPAIR_ACTION_LABELS.REJECT_TO_PREVIOUS)
})

test('mini program part rows and preview amounts are deterministic', () => {
  const first = createRepairPart(0)
  const second = createRepairPart(1)
  assert.notEqual(first.itemKey, second.itemKey)
  assert.equal(repairLineAmount({ quantity: 1.5, unitPrice: 12.34 }), 18.51)
})
