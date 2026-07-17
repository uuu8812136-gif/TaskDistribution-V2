import assert from 'node:assert/strict'
import test from 'node:test'
import {
  REPAIR_ACTION_LABELS,
  REPAIR_STATUS_LABELS,
  REPAIR_TYPE_OPTIONS,
  emptyRepairPart,
  repairActionLabel,
  repairStatusLabel,
  repairStatusTone,
  repairTypeLabel
} from '../src/utils/equipmentRepair.js'

test('repair UI constants cover the three fixed flows and every server status', () => {
  assert.deepEqual(REPAIR_TYPE_OPTIONS.map((item) => item.value), [
    'FAULT_REPORT',
    'PARTS_REPAIR',
    'NO_PARTS_REPAIR'
  ])
  assert.equal(Object.keys(REPAIR_STATUS_LABELS).length, 9)
  assert.equal(repairTypeLabel('PARTS_REPAIR'), '需更换配件维修')
  assert.equal(repairStatusLabel('ASSET_ADMIN_PRICING_PENDING'), '待设备管理员确认配件价格')
  assert.equal(repairStatusTone('COMPLETED'), 'success')
  assert.equal(repairStatusTone('RETURNED_TO_CREATOR'), 'danger')
})

test('repair action labels include fixed approvals, rejection, void, and resubmission', () => {
  for (const action of [
    'RESUBMIT',
    'SUB_DEPARTMENT_APPROVE',
    'ACCEPT_RECEIPT',
    'CONFIRM_PRICING',
    'DEPUTY_APPROVE',
    'MANAGER_APPROVE',
    'REJECT_TO_CREATOR',
    'REJECT_TO_PREVIOUS',
    'VOID'
  ]) {
    assert.ok(REPAIR_ACTION_LABELS[action])
    assert.notEqual(repairActionLabel(action), action)
  }
})

test('new dynamic part rows receive stable non-empty keys', () => {
  const first = emptyRepairPart(0)
  const second = emptyRepairPart(1)
  assert.ok(first.itemKey)
  assert.notEqual(first.itemKey, second.itemKey)
  assert.equal(first.name, '')
})
