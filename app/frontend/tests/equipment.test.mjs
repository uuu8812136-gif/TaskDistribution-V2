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
  equipmentCategoryChildren,
  equipmentCategoryPath,
  equipmentPrimaryCategoryId,
  fetchAllEquipmentCategories,
  equipmentImportDecisionOptions,
  equipmentImportExceptionLabel,
  equipmentImportFieldLabel,
  equipmentImportOriginalValue,
  equipmentImportSuggestedAction,
  isEquipmentImportDecisionComplete,
  isRoutineScheduleExecutable,
  moveChecklistItem,
  normalizeRuntimeHours,
  optionForValue,
  routineAbnormalNotesComplete,
  routineItemResultOptions,
  routineExecutionStatusLabel,
  routineScheduleLabel,
  routineScheduleSummary,
  effectiveRoutineDueState,
  selectExecutableRoutinePlan,
  removeChecklistItemAt,
  EQUIPMENT_STATUS_OPTIONS
} from '../src/utils/equipment.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('routine rule dialog exposes detailed and accessible contextual help', () => {
  const dialog = fs.readFileSync(
    path.join(root, 'src/views/equipment/components/EquipmentRuleDialog.vue'),
    'utf8'
  )

  assert.match(dialog, /#header="\{ titleId, titleClass \}"/)
  assert.match(dialog, /<QuestionFilled \/>/)
  assert.match(dialog, /aria-label="查看规则功能说明"/)
  assert.match(dialog, /aria-haspopup="dialog"/)
  assert.match(dialog, /:aria-expanded="helpVisible"/)
  assert.match(dialog, /title="点检\/保养规则功能说明"/)
  assert.match(dialog, /helpVisible\.value = false/)
  for (const phrase of [
    '只能选择第三级“设备一级名称”',
    '设备二级名称只作为台账名称记录',
    '该设备一级名称及其全部二级名称',
    '二维码通过隐藏令牌定位唯一设备记录',
    '默认每 5 分钟对账补计划',
    '计划生成逻辑',
    '首次到期时间”只是周期计算起点',
    '通常会提前一个周期看到明日计划',
    '截止时间不晚于开始时间时',
    '管理员可在工作台点击“立即补跑计划”',
    '不建议为补跑计划重启整台服务器',
    '任一条件到期',
    '全部条件到期',
    '同一计划或同一周期完成后不能重复提交',
    '已有执行记录或已完成计划的规则不能删除'
  ]) {
    assert.match(dialog, new RegExp(phrase))
  }
})

test('equipment import UI exposes progress, isolated timeout, cancellation, and local job recovery', () => {
  const api = fs.readFileSync(path.join(root, 'src/api/equipment.js'), 'utf8')
  const dialog = fs.readFileSync(
    path.join(root, 'src/views/equipment/components/EquipmentImportDialog.vue'),
    'utf8'
  )
  assert.match(api, /timeout: 15 \* 60 \* 1000/)
  assert.match(api, /onUploadProgress/)
  assert.match(api, /\/imports\/\$\{importJobId\}\/cancel/)
  assert.match(dialog, /equipmentImportPreviewStorageKey\(props\.contextKey\)/)
  assert.match(dialog, /localStorage\.setItem\(storageKey\.value, jobId\)/)
  assert.match(dialog, /createEquipmentImportLifecycleGate/)
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
    sourceSequence: '',
    assetCode: 'A-001',
    name: '叉车',
    categoryId: 'category-1',
    majorCategoryName: '',
    equipmentTypeName: '',
    primaryName: '',
    secondaryName: '',
    plateNumber: '',
    environmentalRegistrationCode: '',
    productCode: '',
    specification: '2T',
    manufacturer: '厂商',
    brand: '',
    vehicleLength: '',
    ratedCapacityText: '',
    forkliftPosition: '',
    powerType: '',
    emissionStandard: '',
    quantity: 2,
    bookQuantity: null,
    physicalQuantity: null,
    unit: '台',
    acquisitionDate: null,
    productionDate: null,
    activationDate: null,
    originalValue: null,
    custodianUserId: null,
    location: '一库',
    photoFileIds: [],
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

  const categories = [
    { _id: 'major', parentId: null, name: '运输装备', status: 'ACTIVE' },
    { _id: 'type', parentId: 'major', name: '车辆', status: 'ACTIVE' },
    { _id: 'primary', parentId: 'type', name: '厢式货车', status: 'ACTIVE' },
    { _id: 'secondary', parentId: 'primary', name: '4.2米轻卡', status: 'ACTIVE' }
  ]
  assert.deepEqual(
    equipmentCategoryPath(categories, 'secondary').map((item) => item._id),
    ['major', 'type', 'primary', 'secondary']
  )
  assert.deepEqual(
    equipmentCategoryChildren(categories, 'type').map((item) => item._id),
    ['primary']
  )
  assert.equal(equipmentPrimaryCategoryId(categories, 'secondary'), 'primary')
  assert.equal(equipmentPrimaryCategoryId(categories, 'primary'), 'primary')
  assert.equal(equipmentPrimaryCategoryId(categories, 'type'), '')
})

test('equipment categories load every page before resolving a cross-page hierarchy', async () => {
  const firstPageFillers = Array.from({ length: 199 }, (_, index) => ({
    _id: `first-page-${index}`,
    parentId: null,
    name: `First ${index}`,
    status: 'ACTIVE'
  }))
  const secondPageFillers = Array.from({ length: 199 }, (_, index) => ({
    _id: `second-page-${index}`,
    parentId: null,
    name: `Second ${index}`,
    status: 'ACTIVE'
  }))
  const pagedCategories = [
    { _id: 'major', parentId: null, name: 'Major', status: 'ACTIVE' },
    ...firstPageFillers,
    { _id: 'type', parentId: 'major', name: 'Type', status: 'ACTIVE' },
    ...secondPageFillers,
    { _id: 'primary', parentId: 'type', name: 'Primary', status: 'ACTIVE' },
    { _id: 'secondary', parentId: 'primary', name: 'Secondary', status: 'ACTIVE' }
  ]
  const calls = []
  const categories = await fetchAllEquipmentCategories(async (params) => {
    calls.push(params)
    const start = (params.page - 1) * params.pageSize
    return {
      categories: pagedCategories.slice(start, start + params.pageSize),
      total: pagedCategories.length,
      page: params.page,
      pageSize: params.pageSize
    }
  }, { teamId: 'team-1' })

  assert.deepEqual(calls.map(({ teamId, page, pageSize }) => ({ teamId, page, pageSize })), [
    { teamId: 'team-1', page: 1, pageSize: 200 },
    { teamId: 'team-1', page: 2, pageSize: 200 },
    { teamId: 'team-1', page: 3, pageSize: 200 }
  ])
  assert.equal(categories.length, 402)
  const majorBranch = buildCategoryTree(categories).find((category) => category._id === 'major')
  assert.equal(majorBranch.children[0]._id, 'type')
  assert.equal(majorBranch.children[0].children[0]._id, 'primary')
  assert.equal(majorBranch.children[0].children[0].children[0]._id, 'secondary')
  assert.deepEqual(
    equipmentCategoryPath(categories, 'secondary').map((item) => item._id),
    ['major', 'type', 'primary', 'secondary']
  )
  assert.equal(equipmentPrimaryCategoryId(categories, 'secondary'), 'primary')
})

test('equipment category paths reject a missing ancestor instead of shifting hierarchy levels', () => {
  const incompleteCategories = [
    { _id: 'type', parentId: 'missing-major', name: 'Type', status: 'ACTIVE' },
    { _id: 'primary', parentId: 'type', name: 'Primary', status: 'ACTIVE' },
    { _id: 'secondary', parentId: 'primary', name: 'Secondary', status: 'ACTIVE' }
  ]

  assert.deepEqual(equipmentCategoryPath(incompleteCategories, 'secondary'), [])
  assert.equal(equipmentPrimaryCategoryId(incompleteCategories, 'secondary'), '')

  const cyclicCategories = [
    { _id: 'major', parentId: null, name: 'Major', status: 'ACTIVE' },
    { _id: 'type-a', parentId: 'type-b', name: 'Type A', status: 'ACTIVE' },
    { _id: 'type-b', parentId: 'type-a', name: 'Type B', status: 'ACTIVE' },
    { _id: 'primary', parentId: 'type-a', name: 'Primary', status: 'ACTIVE' }
  ]
  assert.deepEqual(equipmentCategoryPath(cyclicCategories, 'primary'), [])
  assert.equal(equipmentPrimaryCategoryId(cyclicCategories, 'primary'), '')

  const tooDeepCategories = [
    { _id: 'major', parentId: null, name: 'Major', status: 'ACTIVE' },
    { _id: 'type', parentId: 'major', name: 'Type', status: 'ACTIVE' },
    { _id: 'primary', parentId: 'type', name: 'Primary', status: 'ACTIVE' },
    { _id: 'secondary', parentId: 'primary', name: 'Secondary', status: 'ACTIVE' },
    { _id: 'unexpected-fifth', parentId: 'secondary', name: 'Fifth', status: 'ACTIVE' }
  ]
  assert.equal(equipmentPrimaryCategoryId(tooDeepCategories, 'unexpected-fifth'), '')
})

test('equipment category pagination fails closed when total is absent or changes between pages', async () => {
  await assert.rejects(fetchAllEquipmentCategories(async () => ({
    categories: [{ _id: 'only-page', parentId: null }]
  })), /分页总数无效/)

  await assert.rejects(fetchAllEquipmentCategories(async ({ page }) => ({
    categories: Array.from({ length: page === 1 ? 200 : 1 }, (_, index) => ({
      _id: `page-${page}-${index}`,
      parentId: null
    })),
    total: page === 1 ? 201 : 202
  })), /分页结果发生变化/)
})

test('routine rule UI binds new rules and equipment-detail navigation to level-three names', () => {
  const dialog = fs.readFileSync(
    path.join(root, 'src/views/equipment/components/EquipmentRuleDialog.vue'),
    'utf8'
  )
  const rulesView = fs.readFileSync(
    path.join(root, 'src/views/equipment/EquipmentRules.vue'),
    'utf8'
  )
  const detail = fs.readFileSync(
    path.join(root, 'src/views/equipment/EquipmentDetail.vue'),
    'utf8'
  )

  assert.match(dialog, /label="设备一级名称"/)
  assert.match(dialog, /disabled: depth !== 3/)
  assert.match(dialog, /equipmentPrimaryCategoryId\(props\?\.categories, props\?\.defaultCategoryId\)/)
  assert.match(rulesView, /disabled: depth !== 3/)
  assert.match(rulesView, /equipmentPrimaryCategoryId\(categories\.value, filters\.categoryId\)/)
  assert.match(rulesView, /fetchAllEquipmentCategories\([\s\S]*?getEquipmentCategories/)
  assert.match(detail, /equipmentPrimaryCategoryId\(categories\.value, assetCategoryId\)/)
  assert.match(detail, /fetchAllEquipmentCategories\(getEquipmentCategories, requestParams\.value\)/)
  assert.match(rulesView, /v-if="categoryFilterError"/)
  assert.match(rulesView, /if \(!primaryCategoryId\) \{[\s\S]*?rules\.value = \[\][\s\S]*?return false/)
  assert.match(rulesView, /if \(categoryFilterError\.value\) \{[\s\S]*?rules\.value = \[\][\s\S]*?return/)
  assert.doesNotMatch(rulesView, /categoryId: primaryCategoryId \|\| undefined/)
  assert.match(detail, /if \(!categoryId\) \{[\s\S]*?ElMessage\.error\([\s\S]*?return[\s\S]*?\}/)
  assert.doesNotMatch(detail, /categoryId: categoryId \? String\(categoryId\) : undefined/)
  assert.doesNotMatch(rulesView, /getEquipmentCategories\(\{[\s\S]*?pageSize: 200/)
  assert.doesNotMatch(detail, /getEquipmentCategories\(\{[\s\S]*?pageSize: 200/)
  assert.doesNotMatch(dialog, /选择父级分类不会自动覆盖其下级设备/)
})

test('category maintenance stops at the fixed four-level equipment hierarchy', () => {
  const view = fs.readFileSync(
    path.join(root, 'src/views/equipment/EquipmentCategories.vue'),
    'utf8'
  )
  assert.match(view, /row\.status === 'ACTIVE' && categoryDepth\(row\) < 4/)
  assert.match(view, /if \(parent && categoryDepth\(parent\) >= 4\) return/)
})

test('equipment list avoids horizontal scrolling and expands the complete ledger fields', () => {
  const view = fs.readFileSync(
    path.join(root, 'src/views/equipment/EquipmentList.vue'),
    'utf8'
  )
  assert.match(view, /<el-table-column type="expand" width="48">/)
  assert.match(view, /v-for="group in EQUIPMENT_DETAIL_GROUPS"/)
  assert.match(view, /class="asset-card-list"/)
  assert.match(view, /@media \(max-width: 1180px\)/)
  assert.doesNotMatch(view, /:style="\{ minWidth:/)
  assert.doesNotMatch(view, /\.asset-table-shell \{ overflow-x: auto;/)
  const api = fs.readFileSync(path.join(root, 'src/api/equipment.js'), 'utf8')
  assert.match(view, /@click="handleDelete\(row\)"/)
  assert.match(view, /ElMessageBox\.confirm/)
  assert.match(api, /method: 'delete'/)
  assert.match(api, /`\/equipment\/\$\{equipmentId\}`/)
})

test('category and routine rule deletion stays behind the disabled-state permanent endpoints', () => {
  const categoryView = fs.readFileSync(
    path.join(root, 'src/views/equipment/EquipmentCategories.vue'),
    'utf8'
  )
  const ruleView = fs.readFileSync(
    path.join(root, 'src/views/equipment/EquipmentRules.vue'),
    'utf8'
  )
  const api = fs.readFileSync(path.join(root, 'src/api/equipment.js'), 'utf8')

  assert.match(categoryView, /<template v-else>[\s\S]*?@click="deleteCategory\(row\)"/)
  assert.match(categoryView, /确定永久删除分类/)
  assert.match(ruleView, /v-if="row\.status === 'DISABLED'" command="delete"/)
  assert.match(ruleView, /deleteEquipmentRoutineRule\(row\._id/)
  assert.match(api, /`\/equipment\/categories\/\$\{categoryId\}\/permanent`/)
  assert.match(api, /`\/equipment\/routine-rules\/\$\{ruleId\}\/permanent`/)
})

test('category and routine rule writes ignore stale responses after page or team context changes', () => {
  const categoryView = fs.readFileSync(
    path.join(root, 'src/views/equipment/EquipmentCategories.vue'),
    'utf8'
  )
  const ruleView = fs.readFileSync(
    path.join(root, 'src/views/equipment/EquipmentRules.vue'),
    'utf8'
  )

  for (const source of [categoryView, ruleView]) {
    assert.match(source, /let mutationContextRevision = 0/)
    assert.match(source, /import \{ isStaleContextResponseError, requestErrorMessage \} from '@\/utils\/request'/)
    assert.match(source, /const mutationRevision = mutationContextRevision\s+const context = confirmationGuard\.capture\(\)/)
    assert.match(source, /mutationRevision !== mutationContextRevision \|\| !confirmationGuard\.isCurrent\(context\)\) return/)
    assert.match(source, /confirmationGuard\.invalidate\(\)[\s\S]*mutationContextRevision \+= 1/)
    assert.match(source, /catch \(error\) \{[\s\S]*isStaleContextResponseError\(error\)/)
    assert.match(source, /ElMessage\.error\(requestErrorMessage\(error,/)
    assert.match(source, /deletingId\.value = ''/)
    assert.doesNotMatch(source, /\+\+mutationContextRevision/)
  }

  assert.match(ruleView, /async function saveRule\(payload\)[\s\S]*await (?:update|create)EquipmentRoutineRule[\s\S]*ElMessage\.success\(successMessage\)/)
  assert.match(ruleView, /async function (?:disable|enable|delete)Rule[\s\S]*const mutationRevision = mutationContextRevision/)
  assert.match(categoryView, /async function submitForm\(\)[\s\S]*confirmationGuard\.capture\(\)[\s\S]*await formRef\.value\?\.validate[\s\S]*confirmationGuard\.isCurrent\(context\)[\s\S]*await (?:update|create)EquipmentCategory/)
  assert.match(categoryView, /async function (?:disable|enable|delete)Category[\s\S]*const mutationRevision = mutationContextRevision/)

  const api = fs.readFileSync(path.join(root, 'src/api/equipment.js'), 'utf8')
  for (const method of [
    'createEquipmentCategory',
    'updateEquipmentCategory',
    'disableEquipmentCategory',
    'deleteEquipmentCategory',
    'createEquipmentRoutineRule',
    'updateEquipmentRoutineRule',
    'disableEquipmentRoutineRule',
    'deleteEquipmentRoutineRule'
  ]) {
    assert.match(api, new RegExp(`export const ${method} = [\\s\\S]*?suppressGlobalError: true`))
  }
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
  assert.equal(equipmentImportExceptionLabel('ASSET_CODE_MISSING'), '固定资产编号缺失')
})

test('equipment import issues always expose localized labels and actions', () => {
  for (const exceptionType of [
    'BOOK_QUANTITY_INVALID',
    'PHYSICAL_QUANTITY_INVALID',
    'ORIGINALVALUE_INVALID',
    'QUANTITY_UNIT_EMBEDDED',
    'MERGED_SOURCE_CELL',
    'DUPLICATE_SOURCE_IDENTIFIER_IN_FILE',
    'PHOTO_MAPPING_COUNT_MISMATCH',
    'INVALID_WORKBOOK_MEDIA',
    'ASSET_CODE_GENERATED_FOR_TEST',
    'SOURCE_ASSET_CODE_DUPLICATE',
    'POSSIBLE_IDLE_DUPLICATE',
    'PENDING_IDLE_SOURCE_ROW',
    'ASSET_CODE_COLLISION_EXISTING'
  ]) {
    assert.match(equipmentImportExceptionLabel(exceptionType), /[\u3400-\u9fff]/u)
  }

  assert.equal(equipmentImportExceptionLabel('UNKNOWN_BACKEND_CODE'), '其他数据异常')
  assert.equal(equipmentImportFieldLabel('_sourceIdentity'), '来源标识')
  assert.equal(equipmentImportFieldLabel('assetCode'), '固定资产编号')
  assert.equal(equipmentImportFieldLabel('productCode'), '产品/品牌编码')
  assert.equal(equipmentImportFieldLabel('forkliftPosition'), '高位/低位')
  assert.equal(equipmentImportFieldLabel('environmentalRegistrationCode'), '环保编号')
  assert.equal(equipmentImportFieldLabel('untrustedField'), '其他字段')
  assert.equal(equipmentImportSuggestedAction({
    exceptionType: 'DUPLICATE_ASSET_CODE_EXISTING',
    suggestedAction: 'Choose a new asset code or skip this row'
  }), '请填写新的固定资产编号，或跳过该行')
  assert.equal(equipmentImportSuggestedAction({
    exceptionType: 'UNKNOWN_BACKEND_CODE',
    suggestedAction: 'Do something technical'
  }), '请核对原始数据后选择处理方式')
  assert.equal(equipmentImportSuggestedAction({
    exceptionType: 'UNKNOWN_BACKEND_CODE',
    suggestedAction: '请联系管理员确认原始表格'
  }), '请联系管理员确认原始表格')
  assert.equal(equipmentImportOriginalValue({
    exceptionType: 'INVALID_WORKBOOK_MEDIA',
    originalValue: [{ validationError: 'Media bytes are unavailable' }]
  }), '图片内容无效或无法读取')
})

test('equipment import dialog never renders raw backend error text', () => {
  const dialog = fs.readFileSync(
    path.join(root, 'src/views/equipment/components/EquipmentImportDialog.vue'),
    'utf8'
  )
  assert.doesNotMatch(dialog, /row\.suggestedAction/)
  assert.match(dialog, /equipmentImportOriginalValue\(row\)/)
  assert.match(dialog, /equipmentImportSuggestedAction\(row\)/)
  assert.match(dialog, /\['acquisitionDate', 'productionDate', 'activationDate'\]\.includes\(row\.field\)/)
  assert.match(dialog, /prop="assetCode" label="固定资产编号"/)
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
  const executable = {
    executable: true,
    rule: { schedule: { mode: 'CALENDAR' } },
    plans: [{ _id: 'plan-1', status: 'OVERDUE' }]
  }
  assert.equal(isRoutineScheduleExecutable(executable), true)
  assert.equal(selectExecutableRoutinePlan(executable.plans)?._id, 'plan-1')
  assert.equal(isRoutineScheduleExecutable({
    executable: false,
    executionStatus: 'PERIOD_COMPLETED',
    rule: { schedule: { mode: 'CALENDAR' } }
  }), false)
  assert.equal(routineExecutionStatusLabel({ executionStatus: 'PERIOD_COMPLETED' }), '本周期已完成')
  assert.equal(isRoutineScheduleExecutable({ rule: { schedule: { mode: 'MANUAL' } } }), true)
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
  }), /运行小时间隔必须大于0/)

  assert.throws(() => buildRoutineRecordPayload({
    ruleId: 'rule-1',
    itemResults: [{ itemKey: 'item-1', result: '' }]
  }), /请选择规则并填写所有检查项目结果/)
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
