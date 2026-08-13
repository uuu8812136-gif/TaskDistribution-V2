import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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

test('mini program repair controls stay compact and expose locations, album photos, and readable history', () => {
  const form = readFileSync(new URL('../pages/equipment/repair-form.vue', import.meta.url), 'utf8')
  const detail = readFileSync(new URL('../pages/equipment/repair-detail.vue', import.meta.url), 'utf8')
  const list = readFileSync(new URL('../pages/equipment/repair-list.vue', import.meta.url), 'utf8')
  const workbench = readFileSync(new URL('../pages/workbench/index.vue', import.meta.url), 'utf8')

  assert.deepEqual(REPAIR_TYPES.map((item) => item.shortLabel), [
    '故障报修',
    '更换配件',
    '无需换件'
  ])
  assert.match(form, /class="type-option"[\s\S]*:class="\{ active: form\.type === item\.value \}"[\s\S]*@click="form\.type = item\.value"/)
  assert.match(form, /\.type-segment \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);[^}]*gap: 12rpx;/)
  assert.match(form, /\.type-option \{[^}]*border: 1px solid #cbd5e1;[^}]*border-radius: 10rpx;[^}]*white-space: nowrap;[^}]*overflow: hidden;/)
  assert.match(form, /\.type-option\.active \{[^}]*border-color: #1677ff;[^}]*color: #fff;[^}]*background: #1677ff;[^}]*box-shadow:/)
  assert.doesNotMatch(form, /\.type-option \+ \.type-option/)
  assert.match(form, /sourceType: \['camera', 'album'\]/)
  assert.match(form, /拍照\/相册/)
  assert.match(form, /getEquipmentRepairLocations/)
  assert.match(detail, /维修摘要/)
  assert.match(detail, /copyRepairSummary/)
  assert.match(detail, /action === primaryAction/)
  assert.match(detail, /grid-column: 1 \/ -1/)
  assert.match(detail, /item\.actorName \|\| '未知操作人'/)
  assert.match(detail, /repairPositionLabel\(item\.actorPositionKey\)/)
  assert.match(list, /class="empty-icon">修<\/text>/)
  assert.match(list, /新的审批任务会显示在这里/)
  assert.match(list, /维修记录加载失败/)
  assert.match(list, /未找到匹配记录/)
  assert.match(list, /class="retry-button" @click="refresh"/)
  assert.match(list, /<view v-if="mode === 'all'" class="search-band">/)
  assert.match(list, /todo: request\.mode === 'todo' \? true : undefined/)
  assert.match(list, /keyword: request\.mode === 'all' \? request\.keyword \|\| undefined : undefined/)
  assert.match(list, /mode\.value = value\s+if \(value === 'todo'\) keyword\.value = ''\s+refresh\(\)/)
  assert.match(list, /onShow\(refresh\)/)
  assert.match(list, /\.mode-segment \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);[^}]*gap: 12rpx;/)
  assert.match(list, /\.mode-segment button \{[^}]*border: 1px solid #cbd5e1;[^}]*border-radius: 10rpx;/)
  assert.match(list, /\.mode-segment button\.active \{[^}]*border-color: #1677ff;[^}]*color: #fff;[^}]*background: #1677ff;[^}]*box-shadow:/)
  assert.doesNotMatch(list, /\.mode-segment button \+ button/)
  assert.match(workbench, /v-if="canRepair" class="module-row" @click="openRepairs"/)
})

test('global read-only repair navigation carries an explicit team through list, detail, and files', () => {
  const workbench = readFileSync(new URL('../pages/workbench/index.vue', import.meta.url), 'utf8')
  const list = readFileSync(new URL('../pages/equipment/repair-list.vue', import.meta.url), 'utf8')
  const detail = readFileSync(new URL('../pages/equipment/repair-detail.vue', import.meta.url), 'utf8')

  assert.match(workbench, /openRepairs: \(\) => uni\.navigateTo\(\{ url: '\/pages\/equipment\/repair-list' \}\)/)
  assert.match(list, /v-if="userStore\.isGlobalReadOnly" class="team-band"/)
  assert.match(list, /userStore\.isGlobalReadOnly \? \{ teamId: request\.teamId \} : \{\}/)
  assert.match(list, /&teamId=\$\{encodeURIComponent\(teamId\.value\)\}/)
  assert.match(detail, /getEquipmentRepair\([\s\S]*teamId\.value \? \{ teamId: teamId\.value \} : \{\}/)
  assert.match(detail, /downloadPrivateFile\([\s\S]*teamId\.value \? \{ teamId: teamId\.value \} : \{\}/)
  assert.match(detail, /teamId\.value = options\.teamId \|\| ''/)
})
