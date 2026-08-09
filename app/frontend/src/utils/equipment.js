export const EQUIPMENT_STATUS_OPTIONS = Object.freeze([
  { value: 'IN_USE', label: '在用', type: 'success' },
  { value: 'IDLE', label: '闲置', type: 'warning' },
  { value: 'STOPPED', label: '停用', type: 'info' },
  { value: 'SCRAPPED', label: '报废', type: 'danger' }
])

export const CATEGORY_STATUS_OPTIONS = Object.freeze([
  { value: 'ACTIVE', label: '启用', type: 'success' },
  { value: 'DISABLED', label: '停用', type: 'info' }
])

export const ROUTINE_TYPE_OPTIONS = Object.freeze([
  { value: 'INSPECTION', label: '点检', type: 'primary' },
  { value: 'MAINTENANCE', label: '保养', type: 'success' }
])

export const ROUTINE_RULE_STATUS_OPTIONS = Object.freeze([
  { value: 'ACTIVE', label: '启用', type: 'success' },
  { value: 'DISABLED', label: '停用', type: 'info' }
])

export const ROUTINE_SCHEDULE_MODE_OPTIONS = Object.freeze([
  { value: 'MANUAL', label: '手动发起' },
  { value: 'CALENDAR', label: '按日历周期' },
  { value: 'RUNTIME_HOURS', label: '按运行小时' },
  { value: 'COMBINED', label: '日历与运行小时组合' }
])

export const ROUTINE_CALENDAR_UNIT_OPTIONS = Object.freeze([
  { value: 'DAY', label: '天' },
  { value: 'WEEK', label: '周' },
  { value: 'MONTH', label: '月' }
])

export const ROUTINE_DUE_POLICY_OPTIONS = Object.freeze([
  { value: 'ANY', label: '任一条件到期' },
  { value: 'ALL', label: '全部条件到期' }
])

export const ROUTINE_PHOTO_POLICY_OPTIONS = Object.freeze([
  { value: 'NONE', label: '不要求照片' },
  { value: 'ON_ABNORMAL', label: '异常时必填' },
  { value: 'ALWAYS', label: '始终必填' }
])

export const ROUTINE_ITEM_RESULT_OPTIONS = Object.freeze([
  { value: 'NORMAL', label: '正常', type: 'success' },
  { value: 'COMPLETED', label: '完成', type: 'success' },
  { value: 'ABNORMAL', label: '异常', type: 'danger' },
  { value: 'SKIPPED', label: '跳过', type: 'info' }
])

export const ROUTINE_DUE_STATE_OPTIONS = Object.freeze([
  { value: 'OVERDUE', label: '已逾期', type: 'danger' },
  { value: 'DUE', label: '已到期', type: 'warning' },
  { value: 'UPCOMING', label: '未到期', type: 'success' },
  { value: 'ON_DEMAND', label: '手动发起', type: 'info' },
  { value: 'WAITING_FOR_READING', label: '待录入运行小时', type: 'info' },
  { value: 'DUE_SOON', label: '即将到期', type: 'warning' },
  { value: 'NOT_DUE', label: '未到期', type: 'success' },
  { value: 'MANUAL', label: '手动发起', type: 'info' },
  { value: 'WAITING_RUNTIME', label: '待录入运行小时', type: 'info' },
  { value: 'NO_RUNTIME_READING', label: '待录入运行小时', type: 'info' }
])

const ROUTINE_PLAN_DUE_STATE_MAP = Object.freeze({
  PLANNED: 'UPCOMING',
  IN_WINDOW: 'DUE'
})

export function effectiveRoutineDueState(entry = {}) {
  const raw = String(entry.planStatus || entry.dueState || entry.status || 'NOT_DUE').toUpperCase()
  return ROUTINE_PLAN_DUE_STATE_MAP[raw] || raw
}

export function selectExecutableRoutinePlan(plans = [], now = new Date()) {
  const nowTimestamp = now instanceof Date ? now.getTime() : new Date(now).getTime()
  const candidates = Array.isArray(plans)
    ? plans.filter((plan) => {
        const scheduledFor = Date.parse(plan?.scheduledFor || '')
        return (
          ['OVERDUE', 'IN_WINDOW'].includes(plan?.status) &&
          (!Number.isFinite(scheduledFor) || scheduledFor <= nowTimestamp)
        )
      })
    : []
  const statusRank = { OVERDUE: 0, IN_WINDOW: 1 }
  const timestamp = (value) => {
    const parsed = Date.parse(value || '')
    return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER
  }
  return [...candidates].sort((left, right) => (
    (statusRank[left.status] - statusRank[right.status]) ||
    (timestamp(left.dueAt) - timestamp(right.dueAt)) ||
    (timestamp(left.scheduledFor) - timestamp(right.scheduledFor)) ||
    String(left._id || '').localeCompare(String(right._id || ''))
  ))[0] || null
}

export function isRoutineScheduleExecutable(entry = {}) {
  if (entry?.rule?.schedule?.mode === 'MANUAL') return true
  if (typeof entry?.executable === 'boolean') return entry.executable
  return Boolean(selectExecutableRoutinePlan(entry?.plans))
}

export function routineExecutionStatusLabel(entry = {}) {
  if (entry?.executionStatus === 'REST_DAY') return '本日休班'
  if (entry?.executionStatus === 'NOT_STARTED') return '未到开始时间'
  if (entry?.executionStatus === 'PERIOD_COMPLETED') return '本周期已完成'
  if (entry?.executionStatus === 'WAITING_FOR_READING') return '待录入运行小时'
  if (entry?.executionStatus === 'NOT_DUE') return '未到执行周期'
  return isRoutineScheduleExecutable(entry) ? '' : '当前不可执行'
}

export const IMPORT_DECISION_ACTIONS = Object.freeze({
  ACCEPT_AS_IS: 'ACCEPT_AS_IS',
  ACCEPT_SUGGESTION: 'ACCEPT_SUGGESTION',
  USE_RESOLVED_VALUE: 'USE_RESOLVED_VALUE',
  SKIP_ROW: 'SKIP_ROW'
})

const IMPORT_DECISION_LABELS = Object.freeze({
  [IMPORT_DECISION_ACTIONS.ACCEPT_AS_IS]: '原样接受',
  [IMPORT_DECISION_ACTIONS.ACCEPT_SUGGESTION]: '采用建议值',
  [IMPORT_DECISION_ACTIONS.USE_RESOLVED_VALUE]: '填写修正值',
  [IMPORT_DECISION_ACTIONS.SKIP_ROW]: '跳过整行'
})

const IMPORT_FIELD_LABELS = Object.freeze({
  sourceSequence: '序号',
  assetType: '资产类型',
  majorCategoryName: '设备所属大类',
  equipmentTypeName: '设备所属类型',
  primaryName: '设备一级名称',
  secondaryName: '设备二级名称',
  assetCode: '固定资产编号',
  sourceAssetCode: '原资产编号',
  name: '设备名称',
  productCode: '产品/品牌编码',
  plateNumber: '车牌号',
  serialNumber: '序列号',
  brandSerialNumber: '品牌编号',
  brand: '品牌',
  categoryId: '设备分类',
  specification: '规格型号',
  manufacturer: '生产厂家',
  vehicleLength: '车长',
  ratedCapacityText: '吨位',
  powerType: '设备动力类型',
  emissionStandard: '排放标准',
  quantity: '数量',
  bookQuantity: '账存数量',
  physicalQuantity: '实盘数量',
  unit: '单位',
  acquisitionDate: '购置日期',
  productionDate: '出厂日期',
  activationDate: '启用日期',
  idlePlacedAt: '闲置时间',
  originalValue: '原值',
  orgUnitId: '所属组织',
  orgUnitNameSnapshot: '所在部室',
  custodianUserId: '保管人',
  custodianDisplayName: '使用人',
  location: '存放地点',
  forkliftPosition: '高位/低位',
  environmentalRegistrationCode: '环保编号',
  conditionText: '原表状态',
  status: '设备状态',
  remark: '备注',
  photoFileIds: '设备照片',
  sourceRow: '原始行',
  _source: '原始数据',
  _sourceIdentity: '来源标识',
  _photos: '设备照片'
})

const IMPORT_EXCEPTION_LABELS = Object.freeze({
  ASSET_CODE_COLLISION_EXISTING: '固定资产编号与现有测试数据冲突',
  ASSET_CODE_GENERATED_FOR_TEST: '已生成测试固定资产编号',
  ASSET_CODE_MISSING: '固定资产编号缺失',
  ASSET_CODE_TOO_LONG: '固定资产编号过长',
  BOOK_QUANTITY_INVALID: '账存数量无效',
  CATEGORY_AMBIGUOUS: '设备分类匹配到多项',
  CATEGORY_ID_INVALID: '设备分类标识无效',
  CATEGORY_NOT_FOUND: '未找到设备分类',
  CUSTODIAN_AMBIGUOUS: '保管人匹配到多项',
  CUSTODIAN_ID_INVALID: '保管人标识无效',
  CUSTODIAN_NOT_FOUND: '未找到保管人',
  DATE_INVALID: '日期格式无效',
  DUPLICATE_ASSET_CODE: '固定资产编号重复',
  DUPLICATE_ASSET_CODE_EXISTING: '固定资产编号已存在',
  DUPLICATE_ASSET_CODE_IN_FILE: '文件内固定资产编号重复',
  DUPLICATE_SOURCE_IDENTIFIER_IN_FILE: '来源标识与文件内其他设备重复',
  FIELD_MISALIGNMENT: '字段疑似错位',
  HEADER_NOT_RECOGNIZED: '表头无法识别',
  INVALID_WORKBOOK_MEDIA: '工作簿内存在无效图片',
  MERGED_SOURCE_CELL: '合并单元格跨越多条设备记录',
  MULTI_ASSET_ROW: '一行包含多台设备',
  NAME_MISSING: '设备名称缺失',
  NAME_TOO_LONG: '设备名称过长',
  ORIGINALVALUE_INVALID: '设备原值无效',
  ORG_UNIT_AMBIGUOUS: '所属组织匹配到多项',
  ORG_UNIT_ID_INVALID: '所属组织标识无效',
  ORG_UNIT_NOT_FOUND: '未找到所属组织',
  ORG_UNIT_OUT_OF_SCOPE: '所属组织超出数据范围',
  PARTIAL_DATE: '日期信息不完整',
  PENDING_IDLE_SOURCE_ROW: '存在待确认的闲置来源记录',
  PHYSICAL_QUANTITY_INVALID: '实盘数量无效',
  PHOTO_MAPPING_COUNT_MISMATCH: '设备照片数量与来源引用不一致',
  PHOTO_MAPPING_PENDING: '照片映射待确认',
  POSSIBLE_IDLE_DUPLICATE: '闲置记录可能与在用设备重复',
  QUANTITY_UNIT_EMBEDDED: '数量中包含单位',
  QUANTITY_MISMATCH: '数量信息冲突',
  SOURCE_ASSET_CODE_DUPLICATE: '来源表中的固定资产编号重复',
  STATUS_CONFLICT: '设备状态冲突',
  STATUS_MISSING: '设备状态缺失',
  STATUS_UNRECOGNIZED: '设备状态无法识别',
  DATA_QUALITY_ISSUE: '其他数据异常'
})

const IMPORT_EXCEPTION_ACTIONS = Object.freeze({
  ASSET_CODE_COLLISION_EXISTING: '请核对并填写未被占用的固定资产编号',
  ASSET_CODE_GENERATED_FOR_TEST: '请核对来源固定资产编号，确认是否采用系统生成的测试编号',
  ASSET_CODE_MISSING: '请填写唯一的固定资产编号，或跳过该行',
  ASSET_CODE_TOO_LONG: '请缩短固定资产编号后再确认',
  BOOK_QUANTITY_INVALID: '请核对账存数量并填写有效数字',
  CATEGORY_AMBIGUOUS: '请选择正确的设备分类',
  CATEGORY_ID_INVALID: '请选择有效的设备分类',
  CATEGORY_NOT_FOUND: '请选择正确的设备分类',
  CUSTODIAN_AMBIGUOUS: '请选择该组织内正确的保管人，也可确认暂不指定',
  CUSTODIAN_ID_INVALID: '请选择有效的保管人，也可确认暂不指定',
  CUSTODIAN_NOT_FOUND: '请选择该组织内的在用成员，也可确认暂不指定',
  DATE_INVALID: '请核对原始日期并填写有效日期',
  DUPLICATE_ASSET_CODE: '请填写唯一的固定资产编号，或跳过重复记录',
  DUPLICATE_ASSET_CODE_EXISTING: '请填写新的固定资产编号，或跳过该行',
  DUPLICATE_ASSET_CODE_IN_FILE: '请为重复记录填写不同的固定资产编号，或跳过该行',
  DUPLICATE_SOURCE_IDENTIFIER_IN_FILE: '请核对重复来源标识，确认保留或跳过该行',
  FIELD_MISALIGNMENT: '请核对原始表格列位置并填写正确值',
  HEADER_NOT_RECOGNIZED: '请使用规定的设备导入模板并检查表头',
  INVALID_WORKBOOK_MEDIA: '请检查工作簿内的图片，删除损坏图片或重新插入后再导入',
  MERGED_SOURCE_CELL: '请拆分跨行合并单元格，或逐行核对后确认',
  MULTI_ASSET_ROW: '请确认该行数量，必要时拆分为一台设备一行',
  NAME_MISSING: '请填写设备名称，或跳过该行',
  NAME_TOO_LONG: '请缩短设备名称后再确认',
  ORIGINALVALUE_INVALID: '请核对设备原值并填写有效数字',
  ORG_UNIT_AMBIGUOUS: '请选择正确的所属组织',
  ORG_UNIT_ID_INVALID: '请选择有效的所属组织',
  ORG_UNIT_NOT_FOUND: '请选择正确的所属组织',
  ORG_UNIT_OUT_OF_SCOPE: '请选择当前数据范围内的所属组织',
  PARTIAL_DATE: '请核对日期精度，确认保留原值或填写完整日期',
  PENDING_IDLE_SOURCE_ROW: '请核对闲置表来源记录，确认是否更新现有设备',
  PHYSICAL_QUANTITY_INVALID: '请核对实盘数量并填写有效数字',
  PHOTO_MAPPING_COUNT_MISMATCH: '请核对来源图片与设备行的对应关系',
  PHOTO_MAPPING_PENDING: '请核对工作簿图片与设备行的对应关系',
  POSSIBLE_IDLE_DUPLICATE: '请核对是否为同一设备，确认更新或跳过重复记录',
  QUANTITY_UNIT_EMBEDDED: '请核对拆分后的数量和单位',
  QUANTITY_MISMATCH: '请核对账存数量与实盘数量后确认',
  SOURCE_ASSET_CODE_DUPLICATE: '请核对来源表中的重复固定资产编号',
  STATUS_CONFLICT: '请选择设备当前的正确状态',
  STATUS_MISSING: '请选择设备状态',
  STATUS_UNRECOGNIZED: '请选择系统支持的设备状态',
  DATA_QUALITY_ISSUE: '请核对原始数据后选择处理方式'
})

export function optionForValue(options, value) {
  return options.find((option) => option.value === value) || {
    value,
    label: value || '-',
    type: 'info'
  }
}

export function entityName(items, id, fallback = '-') {
  return items.find((item) => item._id === id)?.name || fallback
}

export function appendChecklistItem(items, item) {
  if (!Array.isArray(items)) throw new TypeError('检查项目列表格式不正确')
  items.push(item)
  return items.length
}

export function removeChecklistItemAt(items, index) {
  if (!Array.isArray(items)) throw new TypeError('检查项目列表格式不正确')
  if (!Number.isInteger(index) || index < 0 || index >= items.length || items.length <= 1) {
    return false
  }
  items.splice(index, 1)
  return true
}

export function moveChecklistItem(items, index, direction) {
  if (!Array.isArray(items)) throw new TypeError('检查项目列表格式不正确')
  if (!Number.isInteger(index) || ![-1, 1].includes(direction)) return false
  const target = index + direction
  if (index < 0 || index >= items.length || target < 0 || target >= items.length) return false

  const [item] = items.splice(index, 1)
  items.splice(target, 0, item)
  return true
}

export function buildEquipmentPayload(form) {
  const physicalQuantity = form.physicalQuantity === '' || form.physicalQuantity == null
    ? null
    : Number(form.physicalQuantity)
  const bookQuantity = form.bookQuantity === '' || form.bookQuantity == null
    ? null
    : Number(form.bookQuantity)
  const quantity = physicalQuantity ?? bookQuantity ?? Number(form.quantity ?? 1)
  return {
    orgUnitId: form.orgUnitId,
    sourceSequence: String(form.sourceSequence || '').trim(),
    assetCode: String(form.assetCode || '').trim(),
    name: String(
      form.secondaryName || form.primaryName || form.name ||
      form.equipmentTypeName || form.majorCategoryName || ''
    ).trim(),
    categoryId: form.categoryId,
    majorCategoryName: String(form.majorCategoryName || '').trim(),
    equipmentTypeName: String(form.equipmentTypeName || '').trim(),
    primaryName: String(form.primaryName || '').trim(),
    secondaryName: String(form.secondaryName || '').trim(),
    plateNumber: String(form.plateNumber || '').trim(),
    environmentalRegistrationCode: String(form.environmentalRegistrationCode || '').trim(),
    productCode: String(form.productCode || '').trim(),
    specification: String(form.specification || '').trim(),
    manufacturer: String(form.manufacturer || '').trim(),
    brand: String(form.brand || '').trim(),
    vehicleLength: String(form.vehicleLength || '').trim(),
    ratedCapacityText: String(form.ratedCapacityText || '').trim(),
    forkliftPosition: String(form.forkliftPosition || '').trim(),
    powerType: String(form.powerType || '').trim(),
    emissionStandard: String(form.emissionStandard || '').trim(),
    quantity,
    bookQuantity,
    physicalQuantity,
    unit: String(form.unit || '').trim(),
    acquisitionDate: form.activationDate || form.acquisitionDate || null,
    productionDate: form.productionDate || null,
    activationDate: form.activationDate || null,
    originalValue: form.originalValue === '' || form.originalValue == null
      ? null
      : Number(form.originalValue),
    custodianUserId: form.custodianUserId || null,
    location: String(form.location || '').trim(),
    photoFileIds: [...(form.photoFileIds || [])],
    remark: String(form.remark || '').trim(),
    reason: String(form.reason || '').trim() || null
  }
}

export function equipmentCategoryPath(categories = [], categoryId = '') {
  const byId = new Map((categories || []).map((item) => [String(item._id), item]))
  const path = []
  const visited = new Set()
  let cursor = byId.get(String(categoryId))
  while (cursor) {
    const id = String(cursor._id)
    if (visited.has(id)) return []
    visited.add(id)
    path.unshift(cursor)
    cursor = cursor.parentId ? byId.get(String(cursor.parentId)) : null
  }
  return path
}

export function equipmentCategoryChildren(categories = [], parentId = null) {
  const normalizedParent = parentId ? String(parentId) : ''
  return (categories || []).filter((item) => (
    item.status === 'ACTIVE' && String(item.parentId || '') === normalizedParent
  ))
}

function positiveInteger(value, fieldName) {
  const normalized = Number(value)
  if (!Number.isInteger(normalized) || normalized < 1) {
    throw new TypeError(`${fieldName}必须为正整数`)
  }
  return normalized
}

function positiveNumber(value, fieldName) {
  const normalized = Number(value)
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new TypeError(`${fieldName}必须大于0`)
  }
  return normalized
}

function isoDateTime(value, fieldName) {
  const date = value instanceof Date ? value : new Date(value)
  if (!value || Number.isNaN(date.getTime())) {
    throw new TypeError(`${fieldName}格式不正确`)
  }
  return date.toISOString()
}

function buildCalendarSchedule(calendar = {}) {
  if (!ROUTINE_CALENDAR_UNIT_OPTIONS.some((option) => option.value === calendar.unit)) {
    throw new TypeError('请选择有效的日历周期单位')
  }
  return {
    unit: calendar.unit,
    interval: positiveInteger(calendar.interval, '日历周期间隔'),
    firstDueAt: isoDateTime(calendar.firstDueAt, '首次到期时间')
  }
}

function buildRuntimeSchedule(runtime = {}) {
  return {
    intervalHours: positiveNumber(runtime.intervalHours, '运行小时间隔')
  }
}

export function buildRoutineSchedule(schedule = {}) {
  const mode = schedule.mode
  if (!ROUTINE_SCHEDULE_MODE_OPTIONS.some((option) => option.value === mode)) {
    throw new TypeError('请选择有效的触发方式')
  }
  if (mode === 'MANUAL') return { mode }
  if (mode === 'CALENDAR') {
    return { mode, calendar: buildCalendarSchedule(schedule.calendar) }
  }
  if (mode === 'RUNTIME_HOURS') {
    return { mode, runtime: buildRuntimeSchedule(schedule.runtime) }
  }
  if (!ROUTINE_DUE_POLICY_OPTIONS.some((option) => option.value === schedule.duePolicy)) {
    throw new TypeError('请选择组合规则的到期条件')
  }
  return {
    mode,
    duePolicy: schedule.duePolicy,
    calendar: buildCalendarSchedule(schedule.calendar),
    runtime: buildRuntimeSchedule(schedule.runtime)
  }
}

export function buildRoutineRulePayload(form) {
  const routineType = String(form.routineType || '')
  if (!ROUTINE_TYPE_OPTIONS.some((option) => option.value === routineType)) {
    throw new TypeError('请选择点检或保养业务类型')
  }
  const checklistItems = (form.checklistItems || []).map((item, index) => {
    const name = String(item.name || '').trim()
    if (!name) throw new TypeError('每个检查项目都必须填写名称')
    const normalized = {
      name,
      description: String(item.description || '').trim(),
      required: item.required !== false,
      sortOrder: index * 10
    }
    if (item.key) normalized.key = String(item.key)
    return normalized
  })
  if (!checklistItems.length) throw new TypeError('至少需要添加一个检查项目')
  if (!ROUTINE_PHOTO_POLICY_OPTIONS.some((option) => option.value === form.photoPolicy)) {
    throw new TypeError('请选择有效的拍照要求')
  }
  if (!ROUTINE_RULE_STATUS_OPTIONS.some((option) => option.value === (form.status || 'ACTIVE'))) {
    throw new TypeError('请选择有效的规则状态')
  }

    const payload = {
    routineType,
    categoryId: String(form.categoryId || ''),
    name: String(form.name || '').trim(),
    description: String(form.description || '').trim(),
    checklistItems,
    schedule: buildRoutineSchedule(form.schedule),
    photoPolicy: form.photoPolicy,
      abnormalNoteRequired: form.abnormalNoteRequired !== false
    }
    if (form.executionConfig) {
      const windows = (form.executionConfig.windows || [])
        .map((window) => ({
          key: String(window.key || '').trim().toUpperCase(),
          name: String(window.name || '').trim(),
          startTime: String(window.startTime || ''),
          endTime: String(window.endTime || ''),
          enabled: window.enabled !== false
        }))
      if (!windows.length || windows.some((window) => (
        !window.key || !window.name || !/^([01]\d|2[0-3]):[0-5]\d$/.test(window.startTime) ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(window.endTime)
      ))) {
        throw new TypeError('执行时段必须填写名称以及 HH:mm 格式的开始和结束时间')
      }
      if (!windows.some((window) => window.enabled)) {
        throw new TypeError('至少需要启用一个执行时段')
      }
      const locationPolicy = String(form.executionConfig.locationPolicy || 'PENDING_CONFIRMATION')
      if (!['PENDING_CONFIRMATION', 'OPTIONAL', 'REQUIRED'].includes(locationPolicy)) {
        throw new TypeError('请选择有效的定位要求')
      }
      const precisionSource = form.executionConfig.locationPrecisionMeters
      const locationPrecisionMeters = precisionSource === '' || precisionSource == null
        ? null
        : Number(precisionSource)
      if (locationPrecisionMeters !== null && (!Number.isFinite(locationPrecisionMeters) || locationPrecisionMeters < 1)) {
        throw new TypeError('定位精度必须为大于0的数值')
      }
      payload.executionConfig = {
        timeZone: String(form.executionConfig.timeZone || 'Asia/Shanghai'),
        windows,
        weeklyDay: Number(form.executionConfig.weeklyDay || 1),
        monthlyDay: Number(form.executionConfig.monthlyDay || 1),
        inspectionEscalationMinutes: Number(form.executionConfig.inspectionEscalationMinutes || 60),
        locationPolicy,
        locationPrecisionMeters
      }
    }
  if (!payload.categoryId || !payload.name) {
    throw new TypeError('请选择设备类型并填写规则名称')
  }
  return payload
}

function calendarScheduleLabel(calendar = {}) {
  const interval = Number(calendar.interval) || 1
  const labels = {
    DAY: interval === 1 ? '每日' : `每 ${interval} 天`,
    WEEK: interval === 1 ? '每周' : `每 ${interval} 周`,
    MONTH: interval === 1 ? '每月' : `每 ${interval} 个月`
  }
  return labels[calendar.unit] || '日历周期'
}

export function routineScheduleLabel(schedule = {}) {
  if (schedule.mode === 'MANUAL') return '手动发起'
  if (schedule.mode === 'CALENDAR') return calendarScheduleLabel(schedule.calendar)
  if (schedule.mode === 'RUNTIME_HOURS') {
    return `每运行 ${Number(schedule.runtime?.intervalHours) || '-'} 小时`
  }
  if (schedule.mode === 'COMBINED') {
    const duePolicy = schedule.duePolicy === 'ALL' ? '全部到期' : '任一到期'
    return `${calendarScheduleLabel(schedule.calendar)} + 每运行 ${Number(schedule.runtime?.intervalHours) || '-'} 小时（${duePolicy}）`
  }
  return '-'
}

export function routineScheduleSummary(entries = []) {
  const emptySummary = () => ({
    total: 0,
    DAY: 0,
    WEEK: 0,
    MONTH: 0,
    RUNTIME_HOURS: 0,
    MANUAL: 0
  })
  const summary = {
    INSPECTION: emptySummary(),
    MAINTENANCE: emptySummary()
  }

  for (const entry of entries || []) {
    const rule = entry?.rule || entry?.routineRule || entry
    const bucket = summary[rule?.routineType]
    if (!bucket) continue

    bucket.total += 1
    const schedule = rule.schedule || {}
    const calendarUnit = schedule.calendar?.unit
    if (calendarUnit && Object.prototype.hasOwnProperty.call(bucket, calendarUnit)) {
      bucket[calendarUnit] += 1
    }
    if (schedule.runtime) bucket.RUNTIME_HOURS += 1
    if (schedule.mode === 'MANUAL') bucket.MANUAL += 1
  }

  return summary
}

export function routineItemResultOptions(routineType, required = true) {
  const options = routineType === 'MAINTENANCE'
    ? [
        { value: 'COMPLETED', label: '完成', type: 'success' },
        { value: 'ABNORMAL', label: '异常', type: 'danger' }
      ]
    : [
        { value: 'NORMAL', label: '正常', type: 'success' },
        { value: 'ABNORMAL', label: '异常', type: 'danger' }
      ]
  if (!required) options.push({ value: 'SKIPPED', label: '跳过', type: 'info' })
  return options
}

export function routineAbnormalNotesComplete(itemResults = [], abnormalSummary = '', required = true) {
  if (!required) return true
  const hasSummary = String(abnormalSummary || '').trim().length > 0
  return hasSummary || !itemResults.some((item) => (
    item.result === 'ABNORMAL' && !String(item.note || '').trim()
  ))
}

export function buildRoutineRecordPayload(form) {
  const itemResults = (form.itemResults || []).map((item) => ({
    itemKey: String(item.itemKey || ''),
    result: item.result,
    note: String(item.note || '').trim()
  }))
  if (!form.ruleId || !itemResults.length || itemResults.some((item) => (
    !item.itemKey || !ROUTINE_ITEM_RESULT_OPTIONS.some((option) => option.value === item.result)
  ))) {
    throw new TypeError('请选择规则并填写所有检查项目结果')
  }
  const payload = {
    ruleId: String(form.ruleId),
    itemResults,
    abnormalSummary: String(form.abnormalSummary || '').trim(),
    photoFileIds: [...(form.photoFileIds || [])]
  }
  if (form.runtimeHours !== '' && form.runtimeHours !== null && form.runtimeHours !== undefined) {
    const runtimeHours = Number(form.runtimeHours)
    if (!Number.isFinite(runtimeHours) || runtimeHours < 0) {
      throw new TypeError('累计运行小时必须为大于或等于0的数值')
    }
    payload.runtimeHours = runtimeHours
  }
    if (form.idempotencyKey) payload.idempotencyKey = String(form.idempotencyKey)
    if (form.planId) payload.planId = String(form.planId)
    if (Array.isArray(form.photoEvidence)) {
      payload.photoEvidence = form.photoEvidence.map((evidence) => ({
        fileId: String(evidence.fileId || ''),
        sourceType: 'CAMERA',
        capturedAt: evidence.capturedAt || null,
        locationStatus: evidence.locationStatus || 'PENDING_CONFIRMATION',
        longitude: evidence.longitude ?? null,
        latitude: evidence.latitude ?? null,
        accuracyMeters: evidence.accuracyMeters ?? null,
        address: String(evidence.address || '').trim()
      }))
    }
    return payload
  }

export function buildRuntimeReadingPayload(form) {
  const hours = Number(form.hours)
  if (!Number.isFinite(hours) || hours < 0) {
    throw new TypeError('运行小时读数必须为大于或等于0的数值')
  }
  const payload = {
    hours,
    reason: String(form.reason || '').trim()
  }
  return payload
}

export function normalizeRuntimeHours(value) {
  if (value === null || value === undefined || value === '') return null
  const normalized = Number(value)
  return Number.isFinite(normalized) && normalized >= 0 ? normalized : null
}

export function buildCategoryTree(categories = []) {
  const nodes = new Map(categories.map((item) => [item._id, { ...item, children: [] }]))
  const roots = []
  for (const node of nodes.values()) {
    if (node.parentId && nodes.has(node.parentId)) nodes.get(node.parentId).children.push(node)
    else roots.push(node)
  }
  const sort = (items) => {
    items.sort((left, right) => (
      (left.sortOrder || 0) - (right.sortOrder || 0) ||
      left.name.localeCompare(right.name, 'zh-CN')
    ))
    items.forEach((item) => sort(item.children))
    return items
  }
  return sort(roots)
}

export function saveBlob(blob, fileName) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  URL.revokeObjectURL(url)
}

export function equipmentImportDecisionOptions(exception) {
  const actions = []
  if (exception?.severity === 'WARNING') actions.push(IMPORT_DECISION_ACTIONS.ACCEPT_AS_IS)
  if (exception?.hasSuggestedValue) actions.push(IMPORT_DECISION_ACTIONS.ACCEPT_SUGGESTION)
  actions.push(IMPORT_DECISION_ACTIONS.USE_RESOLVED_VALUE)
  actions.push(IMPORT_DECISION_ACTIONS.SKIP_ROW)
  return actions.map((value) => ({ value, label: IMPORT_DECISION_LABELS[value] }))
}

export function equipmentImportFieldLabel(field) {
  if (!field) return '-'
  if (IMPORT_FIELD_LABELS[field]) return IMPORT_FIELD_LABELS[field]
  return /[\u3400-\u9fff]/u.test(String(field)) ? String(field) : '其他字段'
}

export function equipmentImportExceptionLabel(exceptionType) {
  if (!exceptionType) return '其他数据异常'
  return IMPORT_EXCEPTION_LABELS[exceptionType] || '其他数据异常'
}

export function formatEquipmentImportValue(value) {
  if (value === null || value === undefined || value === '') return '空值'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export function equipmentImportOriginalValue(exception = {}) {
  if (exception?.exceptionType === 'INVALID_WORKBOOK_MEDIA') {
    return '图片内容无效或无法读取'
  }
  return formatEquipmentImportValue(exception?.originalValue)
}

export function equipmentImportSuggestedAction(exception = {}) {
  const hasSuggestedValue = exception?.hasSuggestedValue === true || (
    Object.prototype.hasOwnProperty.call(exception, 'suggestedValue') &&
    exception.suggestedValue !== null &&
    exception.suggestedValue !== undefined
  )
  if (hasSuggestedValue) {
    return `建议值：${formatEquipmentImportValue(exception.suggestedValue)}`
  }
  const exceptionType = exception?.exceptionType || exception?.code || exception?.type || 'DATA_QUALITY_ISSUE'
  if (IMPORT_EXCEPTION_ACTIONS[exceptionType]) return IMPORT_EXCEPTION_ACTIONS[exceptionType]
  const suppliedAction = String(exception?.suggestedAction || '').trim()
  if (/[\u3400-\u9fff]/u.test(suppliedAction)) return suppliedAction
  return IMPORT_EXCEPTION_ACTIONS.DATA_QUALITY_ISSUE
}

export function isEquipmentImportDecisionComplete(decision) {
  if (!decision || !Object.values(IMPORT_DECISION_ACTIONS).includes(decision.action)) return false
  if (decision.action !== IMPORT_DECISION_ACTIONS.USE_RESOLVED_VALUE) return true
  return Object.prototype.hasOwnProperty.call(decision, 'value')
}

export function buildEquipmentImportConfirmation(importJob, decisions, reason) {
  if (!importJob || importJob.status !== 'PREVIEW_READY') {
    throw new TypeError('只能确认已经生成预览的导入任务')
  }
  if (!Number.isInteger(importJob.version) || importJob.version < 0) {
    throw new TypeError('导入预览版本无效，请刷新后重试')
  }
  const normalizedReason = String(reason || '').trim()
  if (!normalizedReason || normalizedReason.length > 2000) {
    throw new TypeError('请填写1至2000个字符的确认说明')
  }
  const values = Array.isArray(decisions) ? decisions : Object.values(decisions || {})
  return {
    expectedVersion: importJob.version,
    reason: normalizedReason,
    decisions: values.map((decision) => {
      if (!decision?.exceptionId || !isEquipmentImportDecisionComplete(decision)) {
        throw new TypeError('请为每条导入异常选择有效的处理决定')
      }
      const payload = {
        exceptionId: decision.exceptionId,
        action: decision.action
      }
      if (decision.action === IMPORT_DECISION_ACTIONS.USE_RESOLVED_VALUE) {
        payload.value = decision.value
      }
      return payload
    })
  }
}
