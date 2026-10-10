import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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

test('repair pages expose maintained locations, readable actors, and a copyable completion summary', () => {
  const list = readFileSync(new URL('../src/views/equipment/EquipmentRepairs.vue', import.meta.url), 'utf8')
  const detail = readFileSync(new URL('../src/views/equipment/EquipmentRepairDetail.vue', import.meta.url), 'utf8')

  assert.match(list, /维护报修地点/)
  assert.match(list, /allow-create/)
  assert.match(list, /filterable/)
  assert.match(detail, /维修摘要/)
  assert.match(detail, /复制摘要/)
  assert.match(detail, /item\.actorName \|\| '未知操作人'/)
  assert.match(detail, /repairPositionLabel\(item\.actorPositionKey\)/)
})

test('repair list loads permission-scoped todos by default in team context', () => {
  const list = readFileSync(new URL('../src/views/equipment/EquipmentRepairs.vue', import.meta.url), 'utf8')

  assert.match(list, /canViewRepairTodos/)
  assert.match(list, /filters\.todo = defaultTodoFilter\(\)/)
  assert.match(list, /session\.contextEpoch, session\.mode, session\.activeTeamId/)
  assert.match(list, /todo: defaultTodoFilter\(\)/)
})

test('web repair workflow exposes merged rows, pending follow-ups, and linked creation', () => {
  const list = readFileSync(new URL('../src/views/equipment/EquipmentRepairs.vue', import.meta.url), 'utf8')
  const detail = readFileSync(new URL('../src/views/equipment/EquipmentRepairDetail.vue', import.meta.url), 'utf8')
  const navigation = readFileSync(new URL('../src/utils/messageNavigation.js', import.meta.url), 'utf8')
  const helpers = readFileSync(new URL('../src/utils/equipmentRepair.js', import.meta.url), 'utf8')

  assert.match(list, /view: 'merged'/)
  assert.match(list, /待补后续/)
  assert.match(list, /换件维修/)
  assert.match(list, /row\.needsFollowup/)
  assert.match(list, /createForm\.sourceRepairId/)
  assert.match(list, /followupTypeSegments/)
  assert.match(list, /label="维修进度" min-width="420"/)
  assert.match(list, /class="repair-flow-item no-parts-flow"/)
  assert.match(list, /class="repair-flow-item parts-flow"/)
  assert.match(list, /followupRepairOfType\(row, 'NO_PARTS_REPAIR'\)/)
  assert.match(list, /followupRepairOfType\(row, 'PARTS_REPAIR'\)/)
  assert.doesNotMatch(list, /<el-table-column label="换件维修"/)
  assert.match(list, /sourceRepairId: undefined/)
  assert.match(detail, /关联单据/)
  assert.match(detail, /canFollowupNow/)
  assert.match(detail, /补录后续维修/)
  assert.match(detail, /sourceRepairId/)
  assert.match(navigation, /FOLLOWUP_CHOICE/)
  assert.match(navigation, /followupChoice/)
  assert.match(helpers, /REPAIR_FOLLOWUP_FILTER_OPTIONS/)
})
