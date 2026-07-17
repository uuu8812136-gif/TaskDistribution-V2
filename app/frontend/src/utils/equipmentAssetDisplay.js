import dayjs from 'dayjs'

export const EQUIPMENT_ASSET_TYPE_OPTIONS = Object.freeze([
  { value: 'TRANSPORT_EQUIPMENT', label: '运输装备', sheetName: '运输装备' },
  { value: 'HANDLING_EQUIPMENT', label: '装卸装备', sheetName: '装卸装备' },
  { value: 'LOGISTICS_INFORMATION_EQUIPMENT', label: '物流信息装备', sheetName: '物流信息装备' },
  { value: 'AUXILIARY_FACILITY', label: '辅助设施设备', sheetName: '辅助设施设备' },
  { value: 'IDLE', label: '闲置', sheetName: '闲置' }
])

const ASSET_TYPE_ALIASES = Object.freeze({
  TRANSPORT_EQUIPMENT: 'TRANSPORT_EQUIPMENT',
  '运输装备': 'TRANSPORT_EQUIPMENT',
  HANDLING_EQUIPMENT: 'HANDLING_EQUIPMENT',
  '装卸装备': 'HANDLING_EQUIPMENT',
  LOGISTICS_INFORMATION_EQUIPMENT: 'LOGISTICS_INFORMATION_EQUIPMENT',
  '物流信息装备': 'LOGISTICS_INFORMATION_EQUIPMENT',
  AUXILIARY_FACILITY: 'AUXILIARY_FACILITY',
  AUXILIARY_FACILITY_EQUIPMENT: 'AUXILIARY_FACILITY',
  '辅助设施设备': 'AUXILIARY_FACILITY',
  '辅助设施': 'AUXILIARY_FACILITY',
  IDLE: 'IDLE',
  '闲置': 'IDLE'
})

const DATE_PRECISION_LABELS = Object.freeze({
  DAY: '精确到日',
  DATE: '精确到日',
  EXACT: '精确到日',
  MONTH: '精确到月',
  YEAR: '精确到年',
  RAW: '保留原值',
  UNKNOWN: '精度未知'
})

const COMMON_START_COLUMNS = Object.freeze([
  { key: 'sourceSequence', label: '序号', width: 76, align: 'center' },
  { key: 'assetCode', label: '资产编码', minWidth: 142 },
  { key: 'name', label: '名称', minWidth: 168 },
  { key: 'assetType', label: '资产类型', minWidth: 124 },
  { key: 'categoryName', label: '系统分类', minWidth: 120 }
])

const TYPE_COLUMNS = Object.freeze({
  TRANSPORT_EQUIPMENT: [
    { key: 'plateNumber', label: '车牌号', minWidth: 120 },
    { key: 'brand', label: '品牌', minWidth: 110 },
    { key: 'specification', label: '型号规格', minWidth: 150 },
    { key: 'vehicleLength', label: '车长', minWidth: 96 },
    { key: 'ratedCapacityText', label: '吨位', minWidth: 96 },
    { key: 'productionDate', label: '出厂日期', minWidth: 125 },
    { key: 'bookQuantity', label: '账存数量', width: 96, align: 'right' },
    { key: 'physicalQuantity', label: '实盘数量', width: 96, align: 'right' },
    { key: 'unit', label: '单位', width: 76 },
    { key: 'activationDate', label: '启用日期', minWidth: 125 },
    { key: 'custodianDisplayName', label: '使用人', minWidth: 112 },
    { key: 'location', label: '所在部室', minWidth: 130 },
    { key: 'conditionText', label: '状态', minWidth: 92 }
  ],
  HANDLING_EQUIPMENT: [
    { key: 'productCode', label: '产品编码/SN/PN', minWidth: 156 },
    { key: 'brand', label: '品牌', minWidth: 110 },
    { key: 'brandSerialNumber', label: '品牌编号', minWidth: 130 },
    { key: 'specification', label: '型号规格', minWidth: 150 },
    { key: 'ratedCapacityText', label: '吨位', minWidth: 96 },
    { key: 'productionDate', label: '出厂日期', minWidth: 125 },
    { key: 'bookQuantity', label: '账存数量', width: 96, align: 'right' },
    { key: 'physicalQuantity', label: '实盘数量', width: 96, align: 'right' },
    { key: 'unit', label: '单位', width: 76 },
    { key: 'activationDate', label: '启用日期', minWidth: 125 },
    { key: 'custodianDisplayName', label: '使用人', minWidth: 112 },
    { key: 'forkliftPosition', label: '高低位', minWidth: 92 },
    { key: 'conditionText', label: '状态', minWidth: 92 },
    { key: 'manufacturer', label: '生产厂家', minWidth: 145 },
    { key: 'environmentalRegistrationCode', label: '叉车环保编号', minWidth: 160 }
  ],
  LOGISTICS_INFORMATION_EQUIPMENT: [
    { key: 'productCode', label: '产品编码/SN/PN', minWidth: 156 },
    { key: 'brand', label: '品牌', minWidth: 110 },
    { key: 'brandSerialNumber', label: '品牌编号', minWidth: 130 },
    { key: 'specification', label: '型号规格', minWidth: 150 },
    { key: 'bookQuantity', label: '账存数量', width: 96, align: 'right' },
    { key: 'physicalQuantity', label: '实盘数量', width: 96, align: 'right' },
    { key: 'unit', label: '单位', width: 76 },
    { key: 'activationDate', label: '启用日期', minWidth: 125 },
    { key: 'custodianDisplayName', label: '使用人', minWidth: 112 },
    { key: 'orgUnitNameSnapshot', label: '所在部室', minWidth: 130 },
    { key: 'location', label: '存放地点', minWidth: 130 },
    { key: 'conditionText', label: '状态', minWidth: 92 }
  ],
  AUXILIARY_FACILITY: [
    { key: 'productCode', label: '产品编码/SN/PN', minWidth: 156 },
    { key: 'brand', label: '品牌', minWidth: 110 },
    { key: 'brandSerialNumber', label: '品牌编号', minWidth: 130 },
    { key: 'specification', label: '型号规格', minWidth: 150 },
    { key: 'manufacturer', label: '生产厂家', minWidth: 145 },
    { key: 'bookQuantity', label: '账存数量', width: 96, align: 'right' },
    { key: 'physicalQuantity', label: '实盘数量', width: 96, align: 'right' },
    { key: 'unit', label: '单位', width: 76 },
    { key: 'activationDate', label: '启用日期', minWidth: 125 },
    { key: 'custodianDisplayName', label: '使用人', minWidth: 112 },
    { key: 'location', label: '所在部室', minWidth: 130 },
    { key: 'conditionText', label: '状态', minWidth: 92 }
  ],
  IDLE: [
    { key: 'sourceAssetCode', label: '原资产编码', minWidth: 142 },
    { key: 'productCode', label: '产品编码/SN/PN', minWidth: 156 },
    { key: 'brand', label: '品牌', minWidth: 110 },
    { key: 'specification', label: '型号规格', minWidth: 150 },
    { key: 'bookQuantity', label: '账存数量', width: 96, align: 'right' },
    { key: 'physicalQuantity', label: '实盘数量', width: 96, align: 'right' },
    { key: 'unit', label: '单位', width: 76 },
    { key: 'custodianDisplayName', label: '使用人', minWidth: 112 },
    { key: 'location', label: '存放地点', minWidth: 130 },
    { key: 'idlePlacedAt', label: '闲置时间', minWidth: 125 },
    { key: 'conditionText', label: '状态', minWidth: 92 },
    { key: 'remark', label: '备注', minWidth: 180 }
  ]
})

const COMMON_END_COLUMNS = Object.freeze([
  { key: 'sourceLocation', label: '来源', minWidth: 135 },
  { key: 'photoCount', label: '照片', width: 76, align: 'center' },
  { key: 'issueCount', label: '异常', width: 76, align: 'center' }
])

export const EQUIPMENT_DETAIL_GROUPS = Object.freeze([
  {
    title: '来源信息',
    fields: [
      { key: 'sourceSheetName', label: '来源 Sheet' },
      { key: 'sourceRowNumber', label: '来源行号' },
      { key: 'sourceSequence', label: '序号' },
      { key: 'assetType', label: '资产类型' }
    ]
  },
  {
    title: '设备标识',
    fields: [
      { key: 'assetCode', label: '资产编码' },
      { key: 'sourceAssetCode', label: '原资产编码' },
      { key: 'name', label: '名称' },
      { key: 'productCode', label: '产品编码/SN/PN' },
      { key: 'plateNumber', label: '车牌号' },
      { key: 'serialNumber', label: 'SN/序列号' },
      { key: 'brandSerialNumber', label: '品牌编号' }
    ]
  },
  {
    title: '技术参数',
    fields: [
      { key: 'brand', label: '品牌' },
      { key: 'specification', label: '型号规格' },
      { key: 'manufacturer', label: '生产厂家' },
      { key: 'vehicleLength', label: '车长' },
      { key: 'ratedCapacityText', label: '吨位/额定载重' },
      { key: 'environmentalRegistrationCode', label: '叉车环保编号' }
    ]
  },
  {
    title: '数量与使用状态',
    fields: [
      { key: 'bookQuantity', label: '账存数量' },
      { key: 'physicalQuantity', label: '实盘数量' },
      { key: 'quantity', label: '系统数量' },
      { key: 'unit', label: '单位' },
      { key: 'custodianDisplayName', label: '使用人' },
      { key: 'orgUnitNameSnapshot', label: '所在部室' },
      { key: 'location', label: '存放地点' },
      { key: 'forkliftPosition', label: '高低位' },
      { key: 'conditionText', label: '原表状态' },
      { key: 'status', label: '系统状态' }
    ]
  },
  {
    title: '日期信息',
    fields: [
      { key: 'productionDate', label: '出厂日期' },
      { key: 'productionDateDisplay', label: '出厂日期显示值' },
      { key: 'productionDateRaw', label: '出厂日期原值' },
      { key: 'productionDatePrecision', label: '出厂日期精度' },
      { key: 'activationDate', label: '启用日期' },
      { key: 'activationDateDisplay', label: '启用日期显示值' },
      { key: 'activationDateRaw', label: '启用日期原值' },
      { key: 'activationDatePrecision', label: '启用日期精度' },
      { key: 'idlePlacedAt', label: '闲置时间' },
      { key: 'idlePlacedAtRaw', label: '闲置时间原值' },
      { key: 'idlePlacedAtDisplay', label: '闲置时间显示值' },
      { key: 'acquisitionDate', label: '系统购置日期' }
    ]
  },
  {
    title: '备注',
    fields: [
      { key: 'remark', label: '备注', span: 2 }
    ]
  }
])

export function normalizeEquipmentAssetType(value, sourceSheetName = '') {
  const raw = String(value || sourceSheetName || '').trim()
  return ASSET_TYPE_ALIASES[raw] || raw
}

export function equipmentAssetTypeLabel(value, sourceSheetName = '') {
  const normalized = normalizeEquipmentAssetType(value, sourceSheetName)
  return EQUIPMENT_ASSET_TYPE_OPTIONS.find((item) => item.value === normalized)?.label || sourceSheetName || value || '-'
}

export function equipmentAssetTableColumns(value) {
  const normalized = normalizeEquipmentAssetType(value)
  const typeColumns = TYPE_COLUMNS[normalized] || [
    { key: 'specification', label: '型号规格', minWidth: 150 },
    { key: 'manufacturer', label: '生产厂家', minWidth: 145 },
    { key: 'bookQuantity', label: '账存数量', width: 96, align: 'right' },
    { key: 'physicalQuantity', label: '实盘数量', width: 96, align: 'right' },
    { key: 'unit', label: '单位', width: 76 },
    { key: 'custodianDisplayName', label: '使用人', minWidth: 112 },
    { key: 'location', label: '存放地点', minWidth: 130 },
    { key: 'conditionText', label: '状态', minWidth: 92 }
  ]
  return [...COMMON_START_COLUMNS, ...typeColumns, ...COMMON_END_COLUMNS]
}

export function equipmentTableMinWidth(columns = []) {
  return columns.reduce((total, column) => total + Number(column.width || column.minWidth || 120), 0) + 150
}

function valuePresent(value) {
  return value !== null && value !== undefined && value !== ''
}

function formatNumber(value) {
  if (!valuePresent(value)) return '-'
  const number = Number(value)
  return Number.isFinite(number) ? new Intl.NumberFormat('zh-CN').format(number) : String(value)
}

export function formatEquipmentDate(value, rawValue = '', precision = '') {
  if (valuePresent(rawValue) && !valuePresent(value)) return String(rawValue)
  if (!valuePresent(value)) return '-'
  const parsed = dayjs(value)
  if (!parsed.isValid()) return String(rawValue || value)
  if (precision === 'YEAR') return parsed.format('YYYY')
  if (precision === 'MONTH') return parsed.format('YYYY-MM')
  return parsed.format('YYYY-MM-DD')
}

export function equipmentDatePrecisionLabel(value) {
  return DATE_PRECISION_LABELS[String(value || '').toUpperCase()] || value || '-'
}

export function equipmentQualityIssues(record = {}) {
  if (Array.isArray(record.dataQuality?.issues)) return record.dataQuality.issues
  return Array.isArray(record.dataQualityIssues) ? record.dataQualityIssues : []
}

export function normalizeEquipmentPhotoIds(value = []) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((item) => String(item?._id || item?.fileId || item || '')).filter(Boolean))]
}

export function equipmentSourceRawEntries(record = {}) {
  const source = record.sourceRawValues
  if (!source) return []
  if (Array.isArray(source)) {
    return source.map((item, index) => ({
      key: item?.key || item?.field || `source-${index}`,
      label: item?.label || item?.field || item?.key || `原始字段 ${index + 1}`,
      value: item?.value ?? item?.rawValue ?? ''
    }))
  }
  if (typeof source !== 'object') return []
  return Object.entries(source).map(([key, value]) => ({ key, label: key, value }))
}

export function equipmentFieldValue(record = {}, key) {
  if (key === 'assetType') return equipmentAssetTypeLabel(record.assetType, record.sourceSheetName)
  if (key === 'productionDate') {
    return record.productionDateDisplay || formatEquipmentDate(
      record.productionDate,
      record.productionDateRaw,
      record.productionDatePrecision
    )
  }
  if (key === 'activationDate') {
    return record.activationDateDisplay || formatEquipmentDate(
      record.activationDate,
      record.activationDateRaw,
      record.activationDatePrecision
    )
  }
  if (key === 'idlePlacedAt') {
    return record.idlePlacedAtDisplay || formatEquipmentDate(record.idlePlacedAt, record.idlePlacedAtRaw)
  }
  if (key.endsWith('Precision')) return equipmentDatePrecisionLabel(record[key])
  if (key === 'bookQuantity') {
    return formatNumber(Object.prototype.hasOwnProperty.call(record, 'bookQuantity') ? record.bookQuantity : record.quantity)
  }
  if (key === 'physicalQuantity') {
    return formatNumber(Object.prototype.hasOwnProperty.call(record, 'physicalQuantity') ? record.physicalQuantity : record.quantity)
  }
  if (key === 'quantity') return formatNumber(record.quantity)
  if (key === 'custodianDisplayName') return record.custodianDisplayName || record.custodianName || '-'
  if (key === 'orgUnitNameSnapshot') return record.orgUnitNameSnapshot || record.orgUnitName || '-'
  if (key === 'categoryName') return record.categoryName || '-'
  if (key === 'sourceLocation') {
    const sheet = record.sourceSheetName || equipmentAssetTypeLabel(record.assetType)
    return record.sourceRowNumber ? `${sheet} · 第 ${record.sourceRowNumber} 行` : sheet
  }
  if (key === 'photoCount') return normalizeEquipmentPhotoIds(record.photoFileIds).length
  if (key === 'issueCount') return equipmentQualityIssues(record).length
  const value = record[key]
  return valuePresent(value) ? String(value) : '-'
}

export function equipmentImportCandidate(row = {}) {
  return {
    ...(row.candidate || row.preview || {}),
    sourceSheetName: row.candidate?.sourceSheetName || row.preview?.sourceSheetName || row.sheetName,
    sourceRowNumber: row.candidate?.sourceRowNumber || row.preview?.sourceRowNumber || row.rowNumber,
    dataQuality: row.candidate?.dataQuality || row.preview?.dataQuality || row.dataQuality,
    dataQualityIssues: row.candidate?.dataQualityIssues || row.preview?.dataQualityIssues || row.dataQualityIssues || row.issues || []
  }
}

export function equipmentQualityIssueView(issue, index = 0) {
  if (typeof issue === 'string') {
    return { key: `${index}-${issue}`, severity: 'WARNING', title: issue, field: '-', detail: '' }
  }
  const severity = String(issue?.severity || issue?.level || 'WARNING').toUpperCase()
  const code = issue?.exceptionType || issue?.code || issue?.type || 'DATA_QUALITY_ISSUE'
  return {
    key: issue?._id || issue?.id || `${index}-${code}`,
    severity,
    title: issue?.message || issue?.label || code,
    field: issue?.field || '-',
    detail: issue?.detail || issue?.description || issue?.suggestedAction || '',
    originalValue: issue?.originalValue
  }
}
