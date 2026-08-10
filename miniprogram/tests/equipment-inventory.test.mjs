import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  approvalStageLabel,
  inventoryDifferenceText,
  inventoryItemPayload,
  inventoryStatusLabel,
  inventoryStatusTone
} from '../utils/equipmentInventory.js'

test('inventory labels cover the fixed workflow and difference types', () => {
  assert.equal(inventoryStatusLabel('DRAFT'), '盘点中')
  assert.equal(inventoryStatusLabel('RETURNED'), '已退回修改')
  assert.equal(inventoryStatusTone('COMPLETED'), 'success')
  assert.equal(inventoryStatusTone('RETURNED'), 'danger')
  assert.equal(
    inventoryDifferenceText(['MISSING', 'LOCATION_MISMATCH']),
    '现场未找到、位置不一致'
  )
  assert.equal(
    approvalStageLabel('DEPARTMENT_DEPUTY_OR_ASSISTANT'),
    '部门副经理/经理助理审核'
  )
})

test('inventory item payload removes inapplicable values for a missing asset', () => {
  assert.deepEqual(inventoryItemPayload({
    actualPresent: false,
    actualStatus: 'IN_USE',
    actualQuantity: '2',
    actualLocation: 'A区',
    differenceNote: '  现场未找到  ',
    expectedVersion: '3'
  }, ['507f1f77bcf86cd799439011']), {
    actualPresent: false,
    actualStatus: null,
    actualQuantity: null,
    actualLocation: '',
    differenceNote: '现场未找到',
    photoFileIds: ['507f1f77bcf86cd799439011'],
    expectedVersion: 3
  })
})

test('mini-program inventory pages are registered and use private camera uploads', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const apiSource = fs.readFileSync(`${root}/api/index.js`, 'utf8')
  const equipmentIndexSource = fs.readFileSync(`${root}/pages/equipment/index.vue`, 'utf8')
  const listSource = fs.readFileSync(`${root}/pages/equipment/inventory-list.vue`, 'utf8')
  const detailSource = fs.readFileSync(`${root}/pages/equipment/inventory-detail.vue`, 'utf8')
  const pages = JSON.parse(fs.readFileSync(`${root}/pages.json`, 'utf8'))
  const registered = new Set(pages.pages.map(({ path }) => path))

  assert.equal(registered.has('pages/equipment/inventory-list'), true)
  assert.equal(registered.has('pages/equipment/inventory-detail'), true)
  assert.match(equipmentIndexSource, /openInventory/)
  assert.match(listSource, /getEquipmentInventorySessions/)
  assert.match(listSource, /placeholder="请输入盘点批次名称后点击搜索"/)
  assert.match(listSource, /class="search-button"[\s\S]*@click="refresh">搜索<\/button>/)
  assert.match(detailSource, /onlyFromCamera:\s*true/)
  assert.match(detailSource, /sourceType:\s*\['camera'\]/)
  assert.match(detailSource, /scanEquipmentInventoryItem/)
  assert.match(detailSource, /deleteTemporaryPrivateFile/)
  assert.match(apiSource, /post\(`\/equipment\/inventories\/\$\{inventorySessionId\}\/scan`/)
  assert.match(apiSource, /upload\('\/files'/)
  assert.doesNotMatch(detailSource, /\/uploads\//)
})
