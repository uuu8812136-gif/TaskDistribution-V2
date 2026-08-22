import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  CONTRACT_CATEGORY_CONFIGS,
  CONTRACT_RECORD_CATEGORIES,
  SETTLEMENT_AMOUNT_FIELDS,
  buildRecordDetails,
  buildRecordPayload,
  expiryAlertRowClass,
  formatContractField,
  normalizeRecord
} from '../src/utils/contract.js'

const categoryByValue = new Map(
  CONTRACT_CATEGORY_CONFIGS.map((category) => [category.value, category])
)

test('contract detail configuration covers the five Excel groups without duplicate categories', () => {
  assert.equal(CONTRACT_CATEGORY_CONFIGS.length, 5)
  assert.equal(categoryByValue.size, 5)
  assert.deepEqual([...categoryByValue.keys()], [
    CONTRACT_RECORD_CATEGORIES.SUPPLIER_INFO,
    CONTRACT_RECORD_CATEGORIES.MAIN_SERVICE_AGREEMENT,
    CONTRACT_RECORD_CATEGORIES.LOGISTICS_FEE_AGREEMENT,
    CONTRACT_RECORD_CATEGORIES.TURNOVER_EQUIPMENT_SERVICE,
    CONTRACT_RECORD_CATEGORIES.EQUIPMENT_RENTAL
  ])

  const expectedFields = new Map([
    [CONTRACT_RECORD_CATEGORIES.SUPPLIER_INFO, [
      'supplyStatus',
      'hasInvoiceInfo',
      'invoiceInfoText',
      'contacts',
      'reconciliationEmails',
      'unsignedReason',
      'remarks'
    ]],
    [CONTRACT_RECORD_CATEGORIES.MAIN_SERVICE_AGREEMENT, [
      'signingStatus',
      'contractNumber',
      'effectiveDate',
      'expiryDate',
      'supplierSignedDate',
      'companySignedDate',
      'returnDate',
      'courierNumber',
      'deliveredBusinessDate',
      'deliveredFactoryDate',
      'autoRenew'
    ]],
    [CONTRACT_RECORD_CATEGORIES.LOGISTICS_FEE_AGREEMENT, [
      'signingStatus',
      'effectiveDate',
      'expiryDate',
      'warehouseServiceRate',
      'overstorageServiceRate',
      'overstorageDays',
      'settlementCycle',
      'autoRenew',
      'remarks'
    ]],
    [CONTRACT_RECORD_CATEGORIES.TURNOVER_EQUIPMENT_SERVICE, [
      'signingStatus',
      'contractNumber',
      'effectiveDate',
      'expiryDate',
      'equipmentType',
      'equipmentServicePrice',
      'supplierSignedDate',
      'companySignedDate',
      'returnDate',
      'courierNumber',
      'deliveredBusinessDate',
      'deliveredFactoryDate',
      'autoRenew',
      'remarks'
    ]],
    [CONTRACT_RECORD_CATEGORIES.EQUIPMENT_RENTAL, [
      'signingStatus',
      'contractNumber',
      'effectiveDate',
      'expiryDate',
      'equipmentType',
      'specification',
      'productionBatch',
      'color',
      'quantity',
      'autoRenew',
      'remarks'
    ]]
  ])

  for (const [category, keys] of expectedFields) {
    const config = categoryByValue.get(category)
    assert.ok(config, `missing category ${category}`)
    assert.deepEqual(config.fields.map((field) => field.key), keys)
    assert.equal(new Set(keys).size, keys.length)
  }
})

test('overstorage days is maintained as ordinary text', () => {
  const logistics = categoryByValue.get(CONTRACT_RECORD_CATEGORIES.LOGISTICS_FEE_AGREEMENT)
  const overstorageDays = logistics.fields.find((field) => field.key === 'overstorageDays')
  assert.equal(overstorageDays.type, 'text')
  assert.equal(overstorageDays.maxlength, 200)
  assert.equal(overstorageDays.options, undefined)
  assert.equal(formatContractField('NONE', overstorageDays), '无超储')
  assert.equal(normalizeRecord({ details: { overstorageDays: 'NONE' } }).overstorageDays, '无超储')
})

test('settlement filters send an inclusive month range', () => {
  const source = readFileSync(new URL('../src/views/contracts/SupplierSettlementFees.vue', import.meta.url), 'utf8')
  assert.match(source, /type="monthrange"/)
  assert.match(source, /startMonth:\s*filters\.monthRange\?\.\[0\]/)
  assert.match(source, /endMonth:\s*filters\.monthRange\?\.\[1\]/)
  assert.doesNotMatch(source, /month:\s*filters\.month\s*\|\|\s*undefined/)
})

test('contract attachment groups preserve the private Excel evidence types', () => {
  assert.deepEqual(
    categoryByValue.get(CONTRACT_RECORD_CATEGORIES.SUPPLIER_INFO).attachmentGroups,
    [{ purpose: 'INVOICE_INFO', label: '开票资料附件', accept: '.jpg,.jpeg,.png,.pdf' }]
  )
  assert.deepEqual(
    categoryByValue.get(CONTRACT_RECORD_CATEGORIES.MAIN_SERVICE_AGREEMENT).attachmentGroups,
    [{ purpose: 'CONTRACT_PDF', label: '合同 PDF', accept: '.pdf' }]
  )
  assert.deepEqual(
    categoryByValue.get(CONTRACT_RECORD_CATEGORIES.EQUIPMENT_RENTAL).attachmentGroups,
    [
      { purpose: 'CONTRACT_PDF', label: '合同 PDF', accept: '.pdf' },
      { purpose: 'PAYMENT_RECEIPT', label: '打款凭证', accept: '.jpg,.jpeg,.png,.pdf' }
    ]
  )
})

test('record payload normalization keeps paired contacts and Excel text values', () => {
  const supplierInfo = categoryByValue.get(CONTRACT_RECORD_CATEGORIES.SUPPLIER_INFO)
  const rental = categoryByValue.get(CONTRACT_RECORD_CATEGORIES.EQUIPMENT_RENTAL)

  const supplierDetails = buildRecordDetails(supplierInfo, {
    contacts: [
      { name: ' 张三 ', phone: ' 13800000000 ' },
      { name: '', phone: '' },
      { name: '李四', phone: '13900000000' }
    ],
    reconciliationEmails: [' account@example.com ', ''],
    hasInvoiceInfo: false
  })
  assert.deepEqual(supplierDetails.contacts, [
    { name: '张三', phone: '13800000000' },
    { name: '李四', phone: '13900000000' }
  ])
  assert.deepEqual(supplierDetails.reconciliationEmails, ['account@example.com'])
  assert.equal(supplierDetails.hasInvoiceInfo, false)

  assert.equal(buildRecordDetails(rental, { quantity: '30个' }).quantity, '30个')
})

test('contract status fields stay at the record root and are not duplicated in details', () => {
  const mainContract = categoryByValue.get(CONTRACT_RECORD_CATEGORIES.MAIN_SERVICE_AGREEMENT)
  const payload = buildRecordPayload(mainContract, {
    trusteeAttribute: 'HOSTED',
    signingStatus: 'SIGNED',
    contractNumber: ' HT-001 ',
    effectiveDate: '2026-08-01',
    expiryDate: '2027-07-31',
    autoRenew: true,
    companySignedDate: '2026-07-30'
  })

  assert.equal(payload.trusteeAttribute, 'HOSTED')
  assert.equal(payload.signingStatus, 'SIGNED')
  assert.equal(payload.contractNumber, 'HT-001')
  assert.equal(payload.effectiveDate, '2026-08-01')
  assert.equal(payload.expiryDate, '2027-07-31')
  assert.equal(payload.autoRenew, true)
  assert.equal(payload.details.companySignedDate, '2026-07-30')
  for (const key of ['signingStatus', 'contractNumber', 'effectiveDate', 'expiryDate', 'autoRenew']) {
    assert.equal(Object.hasOwn(payload.details, key), false)
  }
})

test('manual renewal choices are serialized as boolean or null at the record root', () => {
  const mainContract = categoryByValue.get(CONTRACT_RECORD_CATEGORIES.MAIN_SERVICE_AGREEMENT)
  assert.equal(buildRecordPayload(mainContract, { autoRenew: true }).autoRenew, true)
  assert.equal(buildRecordPayload(mainContract, { autoRenew: false }).autoRenew, false)
  assert.equal(buildRecordPayload(mainContract, { autoRenew: null }).autoRenew, null)
  assert.equal(buildRecordPayload(mainContract, {}).autoRenew, null)
})

test('third-level details are the only supplier maintenance surface', () => {
  const apiSource = readFileSync(new URL('../src/api/contract.js', import.meta.url), 'utf8')
  const supplierSource = readFileSync(new URL('../src/views/contracts/SupplierContracts.vue', import.meta.url), 'utf8')
  const detailSource = readFileSync(new URL('../src/views/contracts/SupplierContractDetail.vue', import.meta.url), 'utf8')

  assert.match(apiSource, /url: '\/contracts\/records'[\s\S]*method: 'post'/)
  assert.doesNotMatch(apiSource, /export function createSupplier\(/)
  assert.doesNotMatch(apiSource, /export function deleteSupplier\(/)

  assert.match(supplierSource, /新增三级明细/)
  assert.match(supplierSource, /createSupplierFirstRecord\(payload\)/)
  assert.match(supplierSource, /supplierIdentity: \{ name: supplierName, code: supplierCode \}/)
  assert.match(supplierSource, /请使用60列三级细表模板（D列为托管属性）/)
  assert.match(supplierSource, /return row\?\.contractValid \? '有效' : '到期'/)
  assert.doesNotMatch(supplierSource, /if \(!row\?\.hasSignedContract\) return '无主合同'/)
  assert.doesNotMatch(supplierSource, /新建供应商|编辑供应商|删除供应商/)
  assert.doesNotMatch(supplierSource, /\bcreateSupplier\(|\bupdateSupplier\(|\bdeleteSupplier\(/)

  assert.match(detailSource, /维护供应商信息/)
  assert.match(detailSource, /await updateSupplier\(supplierId\.value/)
  assert.match(detailSource, /v-model="recordForm\.trusteeAttribute"/)
  assert.match(detailSource, /合同是否有效：\{\{ supplier\?\.contractValid \? '有效' : '到期' \}\}/)
  assert.match(detailSource, /请使用60列三级细表模板（D列为托管属性）/)
  assert.match(detailSource, /const formBusy = computed\(\(\) => submitting\.value \|\| Boolean\(deletingId\.value\)\)/)
  assert.match(detailSource, /维护明细/)
  assert.doesNotMatch(detailSource, /@click="handleDeleteRecord\(record\)"/)
  assert.match(detailSource, /删除本条三级明细/)
})

test('expiry row classes implement the workbook colors and automatic-renewal exception', () => {
  assert.equal(expiryAlertRowClass({ row: { remainingDays: -1, autoRenew: false } }), 'contract-alert-row--expired')
  assert.equal(expiryAlertRowClass({ row: { remainingDays: 0, autoRenew: false } }), 'contract-alert-row--warning')
  assert.equal(expiryAlertRowClass({ row: { remainingDays: 30, autoRenew: false } }), 'contract-alert-row--warning')
  assert.equal(expiryAlertRowClass({ row: { remainingDays: 31, autoRenew: false } }), '')
  assert.equal(expiryAlertRowClass({ row: { remainingDays: -30, autoRenew: true } }), '')
})

test('settlement totals use the four exact Excel amount columns', () => {
  assert.deepEqual(SETTLEMENT_AMOUNT_FIELDS, [
    { key: 'productLaunchAmount', label: '产品上线金额（含税）' },
    { key: 'warehousingLogisticsFee', label: '仓储物流费' },
    { key: 'overstorageProductAmount', label: '超储产品金额（含税）' },
    { key: 'overstorageLogisticsFee', label: '超储物流费' }
  ])
})

test('contract validity display stays independent from signing status in every contract view', () => {
  const supplierSource = readFileSync(new URL('../src/views/contracts/SupplierContracts.vue', import.meta.url), 'utf8')
  const detailSource = readFileSync(new URL('../src/views/contracts/SupplierContractDetail.vue', import.meta.url), 'utf8')
  const settlementSource = readFileSync(new URL('../src/views/contracts/SupplierSettlementFees.vue', import.meta.url), 'utf8')

  assert.match(supplierSource, /return row\?\.contractValid \? '有效' : '到期'/)
  assert.match(detailSource, /supplier\?\.contractValid \? '有效' : '到期'/)
  assert.match(settlementSource, /row\.contractValid \? '有效' : '到期'/)
  assert.match(settlementSource, /contractValid: option\.contractValid \? '有效' : '到期'/)
  for (const source of [supplierSource, detailSource, settlementSource]) {
    assert.doesNotMatch(source, /!row\.hasSignedContract\s*\?[^\n]*(?:contractValid|无主合同)/)
    assert.doesNotMatch(source, /option\.hasSignedContract\s*\?\s*\(option\.contractValid/)
  }
})

test('contract API keeps the three independent menu exports and private file transport', () => {
  const apiSource = readFileSync(new URL('../src/api/contract.js', import.meta.url), 'utf8')
  assert.match(apiSource, /url: '\/contracts\/suppliers\/export'[\s\S]*responseType: 'blob'/)
  assert.match(apiSource, /url: '\/contracts\/expiry-alerts\/export'[\s\S]*responseType: 'blob'/)
  assert.match(apiSource, /url: '\/contracts\/settlements\/export'[\s\S]*responseType: 'blob'/)
  assert.doesNotMatch(apiSource, /\/uploads\//)
})

test('contract supplier page exposes independent payment receipt ZIP import', () => {
  const supplierSource = readFileSync(new URL('../src/views/contracts/SupplierContracts.vue', import.meta.url), 'utf8')
  const apiSource = readFileSync(new URL('../src/api/contract.js', import.meta.url), 'utf8')
  assert.match(supplierSource, /批量导入打款凭证/)
  assert.match(supplierSource, /importSupplierPaymentReceipts/)
  assert.match(supplierSource, /供应商编码__合同编号\.扩展名/)
  assert.match(apiSource, /\/contracts\/suppliers\/payment-receipts\/import/)
})

test('new contract validation errors have direct customer-facing messages', () => {
  const errorSource = readFileSync(new URL('../src/utils/requestErrorMessages.js', import.meta.url), 'utf8')
  assert.match(errorSource, /CONTRACT_EXPORT_SCOPE_INVALID: '供应商合同导出范围不正确，请刷新页面后重试'/)
  assert.match(errorSource, /CONTRACT_EXPORT_PARAMETER_INVALID: '当前导出层级包含不支持的筛选条件'/)
  assert.match(errorSource, /CONTRACT_EXPORT_SUPPLIER_REQUIRED: '导出二级汇总时必须选择当前供应商'/)
  assert.match(errorSource, /CONTRACT_EXPORT_CATEGORY_NOT_ALLOWED: '当前导出层级不能指定合同类型'/)
  assert.match(errorSource, /CONTRACT_EXPORT_DETAIL_CONTEXT_INVALID: '导出三级明细时，请同时选择供应商和合同类型'/)
  assert.match(errorSource, /CONTRACT_IMPORT_OVERSTORAGE_DAYS_INVALID: '合同导入文件中的超储天数不能超过 200 个字符'/)
  assert.match(errorSource, /CONTRACT_SETTLEMENT_MONTH_RANGE_INVALID: '开始月份不能晚于结束月份'/)
  assert.match(errorSource, /CONTRACT_SETTLEMENT_MONTH_FILTER_CONFLICT: '单月筛选不能与月份区间同时使用'/)
})

test('supplier contract export buttons request an explicit workbook level', () => {
  const supplierSource = readFileSync(new URL('../src/views/contracts/SupplierContracts.vue', import.meta.url), 'utf8')
  const detailSource = readFileSync(new URL('../src/views/contracts/SupplierContractDetail.vue', import.meta.url), 'utf8')

  assert.match(supplierSource, /导出主表汇总/)
  assert.match(supplierSource, /导出汇总/)
  assert.match(supplierSource, /scope: 'overview'/)
  assert.match(supplierSource, /scope: 'detail'/)
  assert.match(detailSource, /scope: category \? 'detail' : 'secondary'/)
  assert.match(detailSource, /supplierId: supplierId\.value/)
  assert.match(detailSource, /category: category \|\| undefined/)
})

test('contract text fields honor their field-specific input limits and guidance', () => {
  const contractUtilsSource = readFileSync(new URL('../src/utils/contract.js', import.meta.url), 'utf8')
  const detailSource = readFileSync(new URL('../src/views/contracts/SupplierContractDetail.vue', import.meta.url), 'utf8')

  assert.match(contractUtilsSource, /field\('overstorageDays', '超储天数', 'text', \{ maxlength: 200, placeholder: '如：60天、90天、免超储费' \}\)/)
  assert.match(detailSource, /:maxlength="item\.maxlength \|\| 500"/)
  assert.match(detailSource, /:placeholder="item\.placeholder \|\| ''"/)
})

test('contract routes and menu entries use three independent view permissions', () => {
  const routerSource = readFileSync(new URL('../src/router/index.js', import.meta.url), 'utf8')
  const layoutSource = readFileSync(new URL('../src/layouts/MainLayout.vue', import.meta.url), 'utf8')

  assert.match(routerSource, /path: 'contracts\/suppliers'[\s\S]*?permission: 'contract\.supplier\.view'/)
  assert.match(routerSource, /path: 'contracts\/expiry-alerts'[\s\S]*?permission: 'contract\.expiry\.view'/)
  assert.match(routerSource, /path: 'contracts\/settlements'[\s\S]*?permission: 'contract\.settlement\.view'/)
  assert.match(layoutSource, /session\.hasPermission\('contract\.supplier\.view'\)[\s\S]*?index="\/contracts\/suppliers"/)
  assert.match(layoutSource, /session\.hasPermission\('contract\.expiry\.view'\)[\s\S]*?index="\/contracts\/expiry-alerts"/)
  assert.match(layoutSource, /session\.hasPermission\('contract\.settlement\.view'\)[\s\S]*?index="\/contracts\/settlements"/)
})

test('contract pages replace wide tables and tabs with complete narrow-screen controls', () => {
  const supplierSource = readFileSync(new URL('../src/views/contracts/SupplierContracts.vue', import.meta.url), 'utf8')
  const detailSource = readFileSync(new URL('../src/views/contracts/SupplierContractDetail.vue', import.meta.url), 'utf8')
  const expirySource = readFileSync(new URL('../src/views/contracts/ContractExpiryAlerts.vue', import.meta.url), 'utf8')
  const settlementSource = readFileSync(new URL('../src/views/contracts/SupplierSettlementFees.vue', import.meta.url), 'utf8')

  assert.match(supplierSource, /class="mobile-supplier-list"/)
  assert.match(supplierSource, /@media \(max-width: 1180px\)[\s\S]*?\.desktop-supplier-table \{ display: none; \}/)
  assert.match(expirySource, /class="mobile-alert-list"/)
  assert.match(expirySource, /@media \(max-width: 1180px\)[\s\S]*?\.desktop-alert-table \{ display: none; \}/)
  assert.match(settlementSource, /class="mobile-settlement-list"/)
  assert.match(settlementSource, /@media \(max-width: 1180px\)[\s\S]*?\.desktop-settlement-table \{ display: none; \}/)
  assert.match(detailSource, /class="mobile-category-select"/)
  assert.match(detailSource, /@media \(max-width: 1024px\)[\s\S]*?\.contract-tabs \{ display: none; \}/)
  for (const source of [supplierSource, detailSource, settlementSource]) {
    const dialogCount = source.match(/<el-dialog\b/g)?.length || 0
    const bodyDialogCount = source.match(/\bappend-to-body\b/g)?.length || 0
    assert.equal(bodyDialogCount, dialogCount)
  }
  for (const source of [supplierSource, detailSource, expirySource, settlementSource]) {
    assert.doesNotMatch(source, /overflow-x:\s*auto/)
  }
})

test('contract detail loads all five totals and enforces record-wide attachment limits', () => {
  const detailSource = readFileSync(new URL('../src/views/contracts/SupplierContractDetail.vue', import.meta.url), 'utf8')
  const uploadSource = readFileSync(new URL('../src/views/contracts/components/ContractFileUpload.vue', import.meta.url), 'utf8')

  assert.match(detailSource, /CONTRACT_CATEGORY_CONFIGS\.map\(\(config\) => loadRecords\(config\.value\)\)/)
  assert.match(detailSource, /totalAttachments > 10/)
  assert.match(detailSource, /同一条记录最多上传 10 个附件/)
  assert.match(detailSource, /截止日期不能早于生效日期/)
  assert.match(detailSource, /对账邮箱.*格式不正确/)
  assert.match(uploadSource, /:disabled="disabled"/)
  assert.match(uploadSource, /allowedExtensions/)
})

test('settlement table summary consumes backend totals instead of reducing the visible page', () => {
  const settlementSource = readFileSync(new URL('../src/views/contracts/SupplierSettlementFees.vue', import.meta.url), 'utf8')
  assert.match(settlementSource, /show-summary/)
  assert.match(settlementSource, /:summary-method="getSummaries"/)
  assert.match(settlementSource, /totals\[item\.key\] = Number\(result\.totals\?\.\[item\.key\]\) \|\| 0/)
  assert.doesNotMatch(settlementSource, /settlements\.value\.reduce/)
})

test('settlement desktop table keeps its header and totals visible while long pages scroll internally', () => {
  const settlementSource = readFileSync(new URL('../src/views/contracts/SupplierSettlementFees.vue', import.meta.url), 'utf8')
  assert.match(
    settlementSource,
    /<el-table[\s\S]*?max-height="clamp\(320px, calc\(100dvh - 390px\), 680px\)"[\s\S]*?show-summary/
  )
  assert.match(settlementSource, /@media \(max-width: 1180px\)[\s\S]*?\.desktop-settlement-table \{ display: none; \}/)
  assert.doesNotMatch(settlementSource, /position:\s*sticky/)
})

test('settlement edits keep the supplier immutable and omit server-derived names', () => {
  const settlementSource = readFileSync(new URL('../src/views/contracts/SupplierSettlementFees.vue', import.meta.url), 'utf8')
  assert.match(settlementSource, /:disabled="Boolean\(editingId\)"/)
  assert.match(settlementSource, /supplierId: form\.supplierId/)
  assert.doesNotMatch(settlementSource, /supplierName: form\.supplierName/)
})

test('expiry filters use the final short remaining-days query keys', () => {
  const expirySource = readFileSync(new URL('../src/views/contracts/ContractExpiryAlerts.vue', import.meta.url), 'utf8')
  assert.match(expirySource, /remainingDaysGt: filters\.remainingDaysGt/)
  assert.match(expirySource, /remainingDaysLt: filters\.remainingDaysLt/)
  assert.doesNotMatch(expirySource, /remainingDaysGreaterThan|remainingDaysLessThan/)
  assert.match(expirySource, /function alertLabel\(row\) \{\s*if \(row\.autoRenew\) return '正常'/)
  assert.match(expirySource, /function alertTagType\(row\) \{\s*if \(row\.autoRenew\) return 'success'/)
})

test('contract lists discard visible data and in-flight responses when the team context changes', () => {
  const supplierSource = readFileSync(new URL('../src/views/contracts/SupplierContracts.vue', import.meta.url), 'utf8')
  const expirySource = readFileSync(new URL('../src/views/contracts/ContractExpiryAlerts.vue', import.meta.url), 'utf8')
  const settlementSource = readFileSync(new URL('../src/views/contracts/SupplierSettlementFees.vue', import.meta.url), 'utf8')

  assert.match(supplierSource, /function invalidateSupplierResults\(\) \{[\s\S]*listRequestId \+= 1[\s\S]*exportRequestId \+= 1[\s\S]*suppliers\.value = \[\][\s\S]*total\.value = 0/)
  assert.match(supplierSource, /async function handleTeamChange\(teamId\) \{\s*invalidateSupplierResults\(\)[\s\S]*await router\.replace/)
  assert.match(supplierSource, /watch\(\(\) => \[route\.name, route\.query\.teamId\][\s\S]*syncRouteTeamContext\(\)/)
  assert.match(supplierSource, /watch\(\(\) => session\.contextEpoch[\s\S]*syncRouteTeamContext\(\{ force: true \}\)/)

  assert.match(expirySource, /function invalidateAlertResults\(\) \{[\s\S]*requestId \+= 1[\s\S]*exportRequestId \+= 1[\s\S]*alerts\.value = \[\][\s\S]*total\.value = 0/)
  assert.match(expirySource, /async function handleTeamChange\(teamId\) \{\s*invalidateAlertResults\(\)[\s\S]*await router\.replace/)
  assert.match(expirySource, /watch\(\(\) => \[route\.name, route\.query\.teamId\][\s\S]*syncRouteTeamContext\(\)/)
  assert.match(expirySource, /watch\(\(\) => session\.contextEpoch[\s\S]*syncRouteTeamContext\(\{ force: true \}\)/)

  assert.match(settlementSource, /function invalidateSettlementResults\(\) \{[\s\S]*listRequestId \+= 1[\s\S]*supplierOptionsRequestId \+= 1[\s\S]*exportRequestId \+= 1[\s\S]*settlements\.value = \[\][\s\S]*supplierOptions\.value = \[\][\s\S]*total\.value = 0/)
  assert.match(settlementSource, /for \(const item of SETTLEMENT_AMOUNT_FIELDS\) totals\[item\.key\] = 0/)
  assert.match(settlementSource, /async function handleTeamChange\(teamId\) \{\s*invalidateSettlementResults\(\)[\s\S]*await router\.replace/)
  assert.match(settlementSource, /watch\(\(\) => \[route\.name, route\.query\.teamId\][\s\S]*syncRouteTeamContext\(\)/)
  assert.match(settlementSource, /watch\(\(\) => session\.contextEpoch[\s\S]*syncRouteTeamContext\(\{ force: true \}\)/)
})

test('settlement supplier options cannot be repopulated by a previous team request', () => {
  const settlementSource = readFileSync(new URL('../src/views/contracts/SupplierSettlementFees.vue', import.meta.url), 'utf8')

  assert.match(settlementSource, /let supplierOptionsRequestId = 0/)
  assert.match(settlementSource, /const requestId = \+\+supplierOptionsRequestId\s*const teamParams = \{ \.\.\.requestTeamParams\.value \}\s*const context = currentPageContext\(\)/)
  assert.match(settlementSource, /getSuppliers\(\{ \.\.\.teamParams, page, pageSize \}\)\s*if \(requestId !== supplierOptionsRequestId \|\| !isCurrentPageContext\(context\)\) return false/)
  assert.match(settlementSource, /if \(requestId !== supplierOptionsRequestId \|\| !isCurrentPageContext\(context\)\) return false\s*supplierOptions\.value = collected/)
})

test('contract exports are discarded after route, team, session, or lifecycle context changes', () => {
  const sources = [
    readFileSync(new URL('../src/views/contracts/SupplierContracts.vue', import.meta.url), 'utf8'),
    readFileSync(new URL('../src/views/contracts/ContractExpiryAlerts.vue', import.meta.url), 'utf8'),
    readFileSync(new URL('../src/views/contracts/SupplierSettlementFees.vue', import.meta.url), 'utf8')
  ]

  for (const source of sources) {
    assert.match(source, /function currentPageContext\(\)/)
    assert.ok(
      /pageRequestContextSnapshot\(\{[\s\S]*route,[\s\S]*session,[\s\S]*teamId:[\s\S]*pageActive/.test(source) ||
      /routeName:[\s\S]*routeTeamId:[\s\S]*contextEpoch: session\.contextEpoch[\s\S]*teamId:/.test(source),
      'contract export context must freeze route, session, team, and lifecycle ownership'
    )
    assert.ok(
      /isSamePageRequestContext\(context, currentPageContext\(\)\)/.test(source) ||
      /function isCurrentPageContext\(context\) \{[\s\S]*pageActive[\s\S]*current\.routeName === context\.routeName[\s\S]*current\.routeTeamId === context\.routeTeamId[\s\S]*current\.contextEpoch === context\.contextEpoch[\s\S]*current\.teamId === context\.teamId/.test(source),
      'contract export response must be rejected outside its captured page context'
    )
    assert.match(source, /const (?:requestId|currentId) = \+\+exportRequestId[\s\S]*const context = currentPageContext\(\)[\s\S]*await export/)
    assert.match(source, /(?:requestId|currentId) !== exportRequestId \|\| !isCurrentPageContext\(context\)\) return[\s\S]*saveContractBlob/)
    assert.match(source, /onDeactivated\(/)
    assert.match(source, /onBeforeUnmount\(/)
  }
})

test('supplier first-record submission cannot update or navigate a stale team page', () => {
  const source = readFileSync(new URL('../src/views/contracts/SupplierContracts.vue', import.meta.url), 'utf8')

  assert.match(source, /const submitRequestId = \+\+firstRecordSubmitRequestId\s*const submitContext = currentPageContext\(\)\s*const submittedTeamParams = \{ \.\.\.requestTeamParams\.value \}/)
  assert.match(source, /prepareAttachmentReferences[\s\S]*submitRequestId !== firstRecordSubmitRequestId \|\|[\s\S]*!isCurrentPageContext\(submitContext\)[\s\S]*cleanupTemporaryFiles\(uploadedFileIds, deleteFile\)[\s\S]*return/)
  assert.match(source, /createSupplierFirstRecord\(payload\)[\s\S]*submitRequestId !== firstRecordSubmitRequestId \|\|[\s\S]*!isCurrentPageContext\(submitContext\)[\s\S]*return[\s\S]*ElMessage\.success/)
  assert.match(source, /name: 'SupplierContractDetail'[\s\S]*query: submittedTeamParams/)
})

test('contract list deactivation cancels async effects without discarding remembered rows', () => {
  const cases = [
    ['SupplierContracts.vue', 'deactivateSupplierContracts', 'suppliers'],
    ['ContractExpiryAlerts.vue', 'deactivateContractExpiryAlerts', 'alerts'],
    ['SupplierSettlementFees.vue', 'deactivateSupplierSettlementFees', 'settlements']
  ]

  for (const [file, functionName, rowsName] of cases) {
    const source = readFileSync(new URL(`../src/views/contracts/${file}`, import.meta.url), 'utf8')
    const start = source.indexOf(`function ${functionName}()`)
    const end = source.indexOf('\n}', start) + 2
    const body = source.slice(start, end)
    assert.ok(start >= 0, `missing ${functionName}`)
    assert.match(body, /pageActive = false/)
    assert.doesNotMatch(body, new RegExp(`${rowsName}\\.value = \\[\\]`))
  }
})

test('settlement writes cannot update a page after its route or team context changes', () => {
  const source = readFileSync(new URL('../src/views/contracts/SupplierSettlementFees.vue', import.meta.url), 'utf8')

  assert.match(source, /let mutationRequestId = 0/)
  assert.match(source, /async function submitForm\(\)[\s\S]*const requestId = \+\+mutationRequestId[\s\S]*const context = currentPageContext\(\)[\s\S]*await (?:update|create)SupplierSettlement[\s\S]*requestId !== mutationRequestId \|\| !isCurrentPageContext\(context\)\) return[\s\S]*ElMessage\.success/)
  assert.match(source, /async function handleDelete\(row\)[\s\S]*const confirmation = confirmationGuard\.capture\(\)[\s\S]*await ElMessageBox\.confirm[\s\S]*if \(!confirmationGuard\.isCurrent\(confirmation\)\) return/)
  assert.match(source, /const requestId = \+\+mutationRequestId\s*const context = currentPageContext\(\)[\s\S]*await deleteSupplierSettlement/)
  assert.match(source, /requestId !== mutationRequestId \|\|[\s\S]*!isCurrentPageContext\(context\) \|\|[\s\S]*!confirmationGuard\.isCurrent\(confirmation\)[\s\S]*\) return[\s\S]*ElMessage\.success/)
  assert.match(source, /function invalidateSettlementResults\(\)[\s\S]*mutationRequestId \+= 1/)
  assert.match(source, /function deactivateSupplierSettlementFees\(\)[\s\S]*mutationRequestId \+= 1/)
})

test('contract detail drops every read, write, export and import effect after leaving its team context', () => {
  const source = readFileSync(new URL('../src/views/contracts/SupplierContractDetail.vue', import.meta.url), 'utf8')

  assert.match(source, /function currentPageContext\(\)[\s\S]*pageRequestContextSnapshot/)
  assert.match(source, /function invalidateDetailPage\(\)[\s\S]*supplierRequestId \+= 1[\s\S]*detailRequestId \+= 1[\s\S]*mutationRequestId \+= 1[\s\S]*exportRequestId \+= 1[\s\S]*importRequestId \+= 1/)
  assert.match(source, /async function loadSupplier\(\)[\s\S]*requestId !== supplierRequestId \|\| !isCurrentPageContext\(context\)\) return false/)
  assert.match(source, /async function loadRecords[\s\S]*requestId !== state\.requestId \|\| !isCurrentPageContext\(context\)\) return false/)
  assert.match(source, /async function submitRecord\(\)[\s\S]*const requestId = \+\+mutationRequestId[\s\S]*prepareAttachmentReferences[\s\S]*!isCurrentPageContext\(context\)[\s\S]*cleanupTemporaryFiles[\s\S]*await (?:updateSupplierRecord|createSupplierRecord)[\s\S]*!isCurrentPageContext\(context\)\) return[\s\S]*ElMessage\.success/)
  assert.match(source, /async function handleDeleteRecord[\s\S]*await deleteSupplierRecord[\s\S]*!isCurrentPageContext\(context\)\) return[\s\S]*ElMessage\.success/)
  assert.match(source, /async function handleExport[\s\S]*await exportSuppliers[\s\S]*!isCurrentPageContext\(context\)\) return[\s\S]*saveContractBlob/)
  assert.match(source, /async function submitImport[\s\S]*await importSuppliers[\s\S]*!isCurrentPageContext\(context\)\) return[\s\S]*ElMessage\.success/)
  assert.match(source, /onBeforeUnmount\(invalidateDetailPage\)/)
})
