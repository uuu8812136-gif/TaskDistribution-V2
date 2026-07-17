import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildInventoryItemPayload,
  inventoryDifferenceText,
  inventoryPendingStatusForPosition,
  inventoryProgress,
  inventoryStatusOption
} from '../src/utils/equipmentInventory.js'

test('inventory status and fixed position mappings remain explicit', () => {
  assert.equal(inventoryStatusOption('RETURNED').label, '已退回修改')
  assert.equal(
    inventoryPendingStatusForPosition('DEPARTMENT_MANAGER_ASSISTANT'),
    'PENDING_DEPARTMENT_DEPUTY_OR_ASSISTANT'
  )
  assert.equal(
    inventoryPendingStatusForPosition('DEPARTMENT_DEPUTY_MANAGER'),
    'PENDING_DEPARTMENT_DEPUTY_OR_ASSISTANT'
  )
  assert.equal(inventoryPendingStatusForPosition('EMPLOYEE'), '')
})

test('inventory progress and difference labels are stable', () => {
  assert.deepEqual(inventoryProgress({ checkedCount: 3, itemCount: 4 }), {
    checkedCount: 3,
    itemCount: 4,
    percent: 75
  })
  assert.equal(
    inventoryDifferenceText(['MISSING', 'LOCATION_MISMATCH']),
    '现场未找到、位置不一致'
  )
})

test('inventory item payload strips fields that do not apply to a missing asset', () => {
  assert.deepEqual(buildInventoryItemPayload({
    actualPresent: false,
    actualStatus: 'IN_USE',
    actualQuantity: 2,
    actualLocation: 'Area A',
    differenceNote: '  Not found  ',
    expectedVersion: 3
  }, ['507f1f77bcf86cd799439011']), {
    actualPresent: false,
    actualStatus: null,
    actualQuantity: null,
    actualLocation: '',
    differenceNote: 'Not found',
    photoFileIds: ['507f1f77bcf86cd799439011'],
    expectedVersion: 3
  })
})
