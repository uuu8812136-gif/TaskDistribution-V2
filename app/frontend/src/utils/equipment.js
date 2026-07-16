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
  assetCode: '资产编号',
  name: '设备名称',
  categoryId: '设备分类',
  specification: '规格型号',
  manufacturer: '生产厂家',
  quantity: '数量',
  unit: '单位',
  acquisitionDate: '购置日期',
  originalValue: '原值',
  orgUnitId: '所属组织',
  custodianUserId: '保管人',
  location: '存放地点',
  status: '设备状态',
  remark: '备注',
  sourceRow: '原始行'
})

const IMPORT_EXCEPTION_LABELS = Object.freeze({
  ASSET_CODE_MISSING: '资产编号缺失',
  ASSET_CODE_TOO_LONG: '资产编号过长',
  CATEGORY_AMBIGUOUS: '设备分类匹配到多项',
  CATEGORY_ID_INVALID: '设备分类标识无效',
  CATEGORY_NOT_FOUND: '未找到设备分类',
  CUSTODIAN_AMBIGUOUS: '保管人匹配到多项',
  CUSTODIAN_ID_INVALID: '保管人标识无效',
  CUSTODIAN_NOT_FOUND: '未找到保管人',
  DATE_INVALID: '日期格式无效',
  DUPLICATE_ASSET_CODE_EXISTING: '资产编号已存在',
  DUPLICATE_ASSET_CODE_IN_FILE: '文件内资产编号重复',
  FIELD_MISALIGNMENT: '字段疑似错位',
  HEADER_NOT_RECOGNIZED: '表头无法识别',
  MULTI_ASSET_ROW: '一行包含多台设备',
  NAME_MISSING: '设备名称缺失',
  NAME_TOO_LONG: '设备名称过长',
  ORG_UNIT_AMBIGUOUS: '所属组织匹配到多项',
  ORG_UNIT_ID_INVALID: '所属组织标识无效',
  ORG_UNIT_NOT_FOUND: '未找到所属组织',
  ORG_UNIT_OUT_OF_SCOPE: '所属组织超出数据范围',
  PARTIAL_DATE: '日期信息不完整',
  PHOTO_MAPPING_PENDING: '照片映射待确认',
  QUANTITY_MISMATCH: '数量信息冲突',
  STATUS_CONFLICT: '设备状态冲突',
  STATUS_MISSING: '设备状态缺失',
  STATUS_UNRECOGNIZED: '设备状态无法识别'
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

export function buildEquipmentPayload(form) {
  return {
    orgUnitId: form.orgUnitId,
    assetCode: form.assetCode.trim(),
    name: form.name.trim(),
    categoryId: form.categoryId,
    specification: form.specification.trim(),
    manufacturer: form.manufacturer.trim(),
    quantity: Number(form.quantity),
    unit: form.unit.trim(),
    acquisitionDate: form.acquisitionDate || null,
    originalValue: form.originalValue === '' || form.originalValue === null
      ? null
      : Number(form.originalValue),
    custodianUserId: form.custodianUserId || null,
    location: form.location.trim(),
    remark: form.remark.trim(),
    reason: form.reason.trim() || null
  }
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
  return IMPORT_FIELD_LABELS[field] || field || '-'
}

export function equipmentImportExceptionLabel(exceptionType) {
  return IMPORT_EXCEPTION_LABELS[exceptionType] || exceptionType || '-'
}

export function formatEquipmentImportValue(value) {
  if (value === null || value === undefined || value === '') return '空值'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export function isEquipmentImportDecisionComplete(decision) {
  if (!decision || !Object.values(IMPORT_DECISION_ACTIONS).includes(decision.action)) return false
  if (decision.action !== IMPORT_DECISION_ACTIONS.USE_RESOLVED_VALUE) return true
  return Object.prototype.hasOwnProperty.call(decision, 'value')
}

export function buildEquipmentImportConfirmation(importJob, decisions, reason) {
  if (!importJob || importJob.status !== 'PREVIEW_READY') {
    throw new TypeError('Only a preview-ready import can be confirmed')
  }
  if (!Number.isInteger(importJob.version) || importJob.version < 0) {
    throw new TypeError('Import preview version is invalid')
  }
  const normalizedReason = String(reason || '').trim()
  if (!normalizedReason || normalizedReason.length > 2000) {
    throw new TypeError('A confirmation reason between 1 and 2000 characters is required')
  }
  const values = Array.isArray(decisions) ? decisions : Object.values(decisions || {})
  return {
    expectedVersion: importJob.version,
    reason: normalizedReason,
    decisions: values.map((decision) => {
      if (!decision?.exceptionId || !isEquipmentImportDecisionComplete(decision)) {
        throw new TypeError('Every import exception requires a valid decision')
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
