import dayjs from 'dayjs'
import {
  equipmentImportExceptionLabel,
  equipmentImportFieldLabel,
  equipmentImportOriginalValue,
  equipmentImportSuggestedAction
} from './equipment.js'

export const EQUIPMENT_ASSET_TYPE_OPTIONS = Object.freeze([
  { value: 'TRANSPORT_EQUIPMENT', label: '运输装备', sheetName: '运输装备' },
  { value: 'HANDLING_EQUIPMENT', label: '装卸搬运设备', sheetName: '装卸搬运设备' },
  { value: 'LOGISTICS_INFORMATION_EQUIPMENT', label: '物流信息装备', sheetName: '物流信息装备' },
  { value: 'AUXILIARY_FACILITY', label: '辅助设施设备', sheetName: '辅助设施设备' },
  { value: 'IDLE', label: '闲置', sheetName: '闲置' }
])

const ASSET_TYPE_ALIASES = Object.freeze({
  TRANSPORT_EQUIPMENT: 'TRANSPORT_EQUIPMENT',
  '运输装备': 'TRANSPORT_EQUIPMENT',
  HANDLING_EQUIPMENT: 'HANDLING_EQUIPMENT',
  '装卸装备': 'HANDLING_EQUIPMENT',
  '装卸搬运设备': 'HANDLING_EQUIPMENT',
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

const EQUIPMENT_STATUS_LABELS = Object.freeze({
  IN_USE: '在用',
  IDLE: '闲置',
  STOPPED: '停用',
  SCRAPPED: '报废'
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

const EQUIPMENT_TEMPLATE_COLUMNS = Object.freeze([
  { key: 'sourceSequence', label: '序号', width: 76, align: 'center' },
  { key: 'majorCategoryName', label: '设备所属大类', minWidth: 138 },
  { key: 'equipmentTypeName', label: '设备所属类型', minWidth: 138 },
  { key: 'primaryName', label: '设备一级名称', minWidth: 145 },
  { key: 'secondaryName', label: '设备二级名称', minWidth: 150 },
  { key: 'assetCode', label: '固定资产编号', minWidth: 150 },
  { key: 'plateNumber', label: '车牌号', minWidth: 120 },
  { key: 'environmentalRegistrationCode', label: '环保编号', minWidth: 135 },
  { key: 'productCode', label: '产品/品牌编码', minWidth: 165 },
  { key: 'specification', label: '型号规格', minWidth: 145 },
  { key: 'unit', label: '单位', width: 76 },
  { key: 'productionDate', label: '出厂日期', minWidth: 120 },
  { key: 'activationDate', label: '启用日期', minWidth: 120 },
  { key: 'vehicleLength', label: '车长', minWidth: 90 },
  { key: 'ratedCapacityText', label: '吨位', minWidth: 90 },
  { key: 'forkliftPosition', label: '高位/低位', minWidth: 100 },
  { key: 'powerType', label: '设备动力类型', minWidth: 125 },
  { key: 'emissionStandard', label: '排放标准', minWidth: 105 },
  { key: 'brand', label: '品牌', minWidth: 105 },
  { key: 'manufacturer', label: '生产厂家', minWidth: 135 },
  { key: 'bookQuantity', label: '账存数量', width: 96, align: 'right' },
  { key: 'physicalQuantity', label: '实盘数量', width: 96, align: 'right' },
  { key: 'orgUnitNameSnapshot', label: '所在部室', minWidth: 125 },
  { key: 'custodianDisplayName', label: '使用人', minWidth: 105 },
  { key: 'status', label: '状态', minWidth: 90 },
  { key: 'location', label: '存放地点', minWidth: 125 },
  { key: 'photoCount', label: '设备照片', width: 90, align: 'center' },
  { key: 'remark', label: '备注', minWidth: 180 }
])

export const EQUIPMENT_DETAIL_GROUPS = Object.freeze([
  {
    title: '分类与标识',
    fields: [
      { key: 'sourceSequence', label: '序号' },
      { key: 'majorCategoryName', label: '设备所属大类' },
      { key: 'equipmentTypeName', label: '设备所属类型' },
      { key: 'primaryName', label: '设备一级名称' },
      { key: 'secondaryName', label: '设备二级名称' },
      { key: 'assetCode', label: '固定资产编号' },
      { key: 'plateNumber', label: '车牌号' },
      { key: 'environmentalRegistrationCode', label: '环保编号' },
      { key: 'productCode', label: '产品/品牌编码' }
    ]
  },
  {
    title: '技术参数',
    fields: [
      { key: 'specification', label: '型号规格' },
      { key: 'unit', label: '单位' },
      { key: 'productionDate', label: '出厂日期' },
      { key: 'activationDate', label: '启用日期' },
      { key: 'vehicleLength', label: '车长' },
      { key: 'ratedCapacityText', label: '吨位' },
      { key: 'forkliftPosition', label: '高位/低位' },
      { key: 'powerType', label: '设备动力类型' },
      { key: 'emissionStandard', label: '排放标准' },
      { key: 'brand', label: '品牌' },
      { key: 'manufacturer', label: '生产厂家' }
    ]
  },
  {
    title: '数量与使用信息',
    fields: [
      { key: 'bookQuantity', label: '账存数量' },
      { key: 'physicalQuantity', label: '实盘数量' },
      { key: 'orgUnitNameSnapshot', label: '所在部室' },
      { key: 'custodianDisplayName', label: '使用人' },
      { key: 'status', label: '状态' },
      { key: 'location', label: '存放地点' },
      { key: 'photoCount', label: '设备照片' }
    ]
  },
  {
    title: '历史来源补充信息',
    fields: [
      { key: 'assetType', label: '原资产类型' },
      { key: 'sourceSheetName', label: '来源 Sheet' },
      { key: 'sourceRowNumber', label: '来源行号' },
      { key: 'sourceAssetCode', label: '原资产编号' },
      { key: 'name', label: '原设备名称' },
      { key: 'serialNumber', label: 'SN/序列号' },
      { key: 'brandSerialNumber', label: '品牌编号' },
      { key: 'productionDateDisplay', label: '出厂日期显示值' },
      { key: 'productionDateRaw', label: '出厂日期原值' },
      { key: 'productionDatePrecision', label: '出厂日期精度' },
      { key: 'activationDateDisplay', label: '启用日期显示值' },
      { key: 'activationDateRaw', label: '启用日期原值' },
      { key: 'activationDatePrecision', label: '启用日期精度' },
      { key: 'idlePlacedAt', label: '闲置时间' },
      { key: 'idlePlacedAtRaw', label: '闲置时间原值' },
      { key: 'idlePlacedAtDisplay', label: '闲置时间显示值' },
      { key: 'conditionText', label: '原表状态' }
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
  return EQUIPMENT_TEMPLATE_COLUMNS
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
  if (key === 'majorCategoryName') {
    return record.majorCategoryName || equipmentAssetTypeLabel(record.assetType, record.sourceSheetName)
  }
  if (key === 'equipmentTypeName') return record.equipmentTypeName || '-'
  if (key === 'primaryName') return record.primaryName || '-'
  if (key === 'secondaryName') return record.secondaryName || record.name || '-'
  if (key === 'status') {
    return record.conditionText || EQUIPMENT_STATUS_LABELS[record.status] || record.status || '-'
  }
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
    const title = /[\u3400-\u9fff]/u.test(issue) ? issue : '其他数据异常'
    return {
      key: `${index}-${issue}`,
      severity: 'WARNING',
      title,
      field: '-',
      detail: '请核对原始数据后选择处理方式'
    }
  }
  const severity = String(issue?.severity || issue?.level || 'WARNING').toUpperCase()
  const code = issue?.exceptionType || issue?.code || issue?.type || 'DATA_QUALITY_ISSUE'
  const mappedTitle = equipmentImportExceptionLabel(code)
  const suppliedTitle = [issue?.message, issue?.label]
    .map((value) => String(value || '').trim())
    .find((value) => /[\u3400-\u9fff]/u.test(value))
  const mappedDetail = equipmentImportSuggestedAction({ ...issue, exceptionType: code })
  const suppliedDetail = [issue?.detail, issue?.description, issue?.suggestedAction]
    .map((value) => String(value || '').trim())
    .find((value) => /[\u3400-\u9fff]/u.test(value))
  return {
    key: issue?._id || issue?.id || `${index}-${code}`,
    severity,
    title: mappedTitle === '其他数据异常' && suppliedTitle ? suppliedTitle : mappedTitle,
    field: equipmentImportFieldLabel(issue?.field),
    detail: mappedDetail === '请核对原始数据后选择处理方式' && suppliedDetail
      ? suppliedDetail
      : mappedDetail,
    originalValue: equipmentImportOriginalValue({ ...issue, exceptionType: code })
  }
}
