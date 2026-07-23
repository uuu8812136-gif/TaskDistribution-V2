import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EQUIPMENT_ASSET_TYPE_OPTIONS,
  EQUIPMENT_DETAIL_GROUPS,
  equipmentAssetTableColumns,
  equipmentAssetTypeLabel,
  equipmentFieldValue,
  equipmentImportCandidate,
  equipmentQualityIssues,
  equipmentQualityIssueView,
  equipmentSourceRawEntries,
  formatEquipmentDate,
  normalizeEquipmentAssetType,
  normalizeEquipmentPhotoIds
} from '../src/utils/equipmentAssetDisplay.js'

test('asset types support backend enums and original Chinese sheet names', () => {
  assert.deepEqual(EQUIPMENT_ASSET_TYPE_OPTIONS.map((item) => item.value), [
    'TRANSPORT_EQUIPMENT',
    'HANDLING_EQUIPMENT',
    'LOGISTICS_INFORMATION_EQUIPMENT',
    'AUXILIARY_FACILITY',
    'IDLE'
  ])
  assert.equal(normalizeEquipmentAssetType('', '运输装备'), 'TRANSPORT_EQUIPMENT')
  assert.equal(normalizeEquipmentAssetType('辅助设施设备'), 'AUXILIARY_FACILITY')
  assert.equal(equipmentAssetTypeLabel('HANDLING_EQUIPMENT'), '装卸装备')
  assert.equal(equipmentAssetTypeLabel('', '闲置'), '闲置')
})

test('each asset type exposes a fixed, source-specific table layout', () => {
  const transportKeys = equipmentAssetTableColumns('TRANSPORT_EQUIPMENT').map((item) => item.key)
  assert.ok(transportKeys.includes('plateNumber'))
  assert.ok(transportKeys.includes('vehicleLength'))
  assert.ok(transportKeys.includes('ratedCapacityText'))

  const handlingKeys = equipmentAssetTableColumns('装卸装备').map((item) => item.key)
  assert.ok(handlingKeys.includes('forkliftPosition'))
  assert.ok(handlingKeys.includes('environmentalRegistrationCode'))

  const idleKeys = equipmentAssetTableColumns('IDLE').map((item) => item.key)
  assert.ok(idleKeys.includes('sourceAssetCode'))
  assert.ok(idleKeys.includes('idlePlacedAt'))
  assert.ok(idleKeys.includes('remark'))
})

test('detail groups cover every imported fixed-asset source field', () => {
  const keys = new Set(EQUIPMENT_DETAIL_GROUPS.flatMap((group) => group.fields.map((field) => field.key)))
  for (const required of [
    'sourceSequence', 'assetType', 'sourceSheetName', 'sourceRowNumber',
    'assetCode', 'sourceAssetCode', 'name', 'productCode', 'plateNumber',
    'serialNumber', 'brandSerialNumber', 'brand', 'manufacturer', 'specification',
    'vehicleLength', 'ratedCapacityText', 'productionDate', 'productionDateDisplay', 'productionDateRaw',
    'productionDatePrecision', 'activationDate', 'activationDateDisplay', 'activationDateRaw',
    'activationDatePrecision', 'idlePlacedAt', 'idlePlacedAtRaw',
    'idlePlacedAtDisplay', 'bookQuantity', 'physicalQuantity', 'unit',
    'custodianDisplayName', 'orgUnitNameSnapshot', 'location', 'conditionText',
    'forkliftPosition', 'environmentalRegistrationCode', 'remark'
  ]) {
    assert.ok(keys.has(required), `missing detail field: ${required}`)
  }
})

test('source dates retain partial precision and fall back to original values', () => {
  assert.equal(formatEquipmentDate('2026-07-16T00:00:00.000Z', '', 'DAY'), '2026-07-16')
  assert.equal(formatEquipmentDate('2026-07-01T00:00:00.000Z', '2026年7月', 'MONTH'), '2026-07')
  assert.equal(formatEquipmentDate(null, '待客户确认'), '待客户确认')
  assert.equal(equipmentFieldValue({
    productionDate: '2026-01-01T00:00:00.000Z',
    productionDatePrecision: 'YEAR'
  }, 'productionDate'), '2026')
  assert.equal(equipmentFieldValue({
    productionDate: '2026-07-01T00:00:00.000Z',
    productionDateDisplay: '2026年7月（原表）',
    productionDateRaw: 46204,
    productionDatePrecision: 'MONTH'
  }, 'productionDate'), '2026年7月（原表）')
  assert.equal(equipmentFieldValue({
    activationDate: '2020-01-01T00:00:00.000Z',
    activationDateDisplay: '2020年启用'
  }, 'activationDate'), '2020年启用')
})

test('legacy quantities, file ids and both data-quality shapes remain readable', () => {
  const legacy = { quantity: 12, photoFileIds: ['file-1', { _id: 'file-2' }, 'file-1'] }
  assert.equal(equipmentFieldValue(legacy, 'bookQuantity'), '12')
  assert.equal(equipmentFieldValue(legacy, 'physicalQuantity'), '12')
  assert.deepEqual(normalizeEquipmentPhotoIds(legacy.photoFileIds), ['file-1', 'file-2'])

  const nested = { dataQuality: { issues: [{ code: 'DUPLICATE_ASSET_CODE', severity: 'ERROR' }] } }
  assert.equal(equipmentQualityIssues(nested).length, 1)
  assert.equal(equipmentQualityIssueView(equipmentQualityIssues(nested)[0]).severity, 'ERROR')
  assert.equal(equipmentQualityIssues({ dataQualityIssues: ['待确认'] })[0], '待确认')
})

test('equipment quality issues localize persisted English descriptions', () => {
  const generatedCode = equipmentQualityIssueView({
    exceptionType: 'ASSET_CODE_GENERATED_FOR_TEST',
    severity: 'WARNING',
    field: 'assetCode',
    suggestedValue: 'CUST26-HDL-001',
    message: 'Source asset code is missing, too long, or duplicated'
  })
  assert.equal(generatedCode.title, '已生成测试资产编号')
  assert.equal(generatedCode.field, '资产编号')
  assert.equal(generatedCode.detail, '建议值：CUST26-HDL-001')
  assert.doesNotMatch(JSON.stringify(generatedCode), /Source asset code/u)

  const invalidMedia = equipmentQualityIssueView({
    exceptionType: 'INVALID_WORKBOOK_MEDIA',
    field: '_photos',
    originalValue: [{ validationError: 'Media bytes are unavailable' }],
    suggestedAction: 'Replace the invalid media'
  })
  assert.equal(invalidMedia.title, '工作簿内存在无效图片')
  assert.equal(invalidMedia.field, '设备照片')
  assert.equal(invalidMedia.originalValue, '图片内容无效或无法读取')
  assert.doesNotMatch(JSON.stringify(invalidMedia), /Media bytes|Replace the invalid/u)

  const unknownEnglish = equipmentQualityIssueView('Unknown source issue')
  assert.equal(unknownEnglish.title, '其他数据异常')
  assert.match(unknownEnglish.detail, /[\u3400-\u9fff]/u)

  const unknownChinese = equipmentQualityIssueView({
    code: 'FUTURE_QUALITY_ISSUE',
    field: 'futureField',
    message: '客户补充数据需要确认',
    detail: '请核对客户原表'
  })
  assert.equal(unknownChinese.title, '客户补充数据需要确认')
  assert.equal(unknownChinese.field, '其他字段')
  assert.equal(unknownChinese.detail, '请核对客户原表')
})

test('import preview candidates retain sheet and row provenance', () => {
  const candidate = equipmentImportCandidate({
    sheetName: '物流信息装备',
    rowNumber: 18,
    candidate: { name: '显示器', quantity: 1 }
  })
  assert.equal(candidate.sourceSheetName, '物流信息装备')
  assert.equal(candidate.sourceRowNumber, 18)
  assert.equal(equipmentFieldValue(candidate, 'sourceLocation'), '物流信息装备 · 第 18 行')
})

test('raw source values preserve the original remark columns and unknown headers', () => {
  assert.deepEqual(equipmentSourceRawEntries({
    sourceRawValues: {
      '备注1': '待维修',
      '备注2': '客户确认',
      '设备照片': 'DISPIMG-001'
    }
  }), [
    { key: '备注1', label: '备注1', value: '待维修' },
    { key: '备注2', label: '备注2', value: '客户确认' },
    { key: '设备照片', label: '设备照片', value: 'DISPIMG-001' }
  ])
})
