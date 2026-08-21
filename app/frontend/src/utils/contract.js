import dayjs from 'dayjs'

export const CONTRACT_RECORD_CATEGORIES = Object.freeze({
  SUPPLIER_INFO: 'SUPPLIER_INFO',
  MAIN_SERVICE_AGREEMENT: 'MAIN_SERVICE_AGREEMENT',
  LOGISTICS_FEE_AGREEMENT: 'LOGISTICS_FEE_AGREEMENT',
  TURNOVER_EQUIPMENT_SERVICE: 'TURNOVER_EQUIPMENT_SERVICE',
  EQUIPMENT_RENTAL: 'EQUIPMENT_RENTAL'
})

export const SUPPLIER_TRUSTEE_ATTRIBUTE_OPTIONS = Object.freeze([
  { value: 'HOSTED', label: '托管' },
  { value: 'NON_HOSTED', label: '非托' }
])

export const SIGNING_STATUS_OPTIONS = Object.freeze([
  { value: 'SIGNED', label: '已签订' },
  { value: 'UNSIGNED', label: '未签订' }
])

export const YES_NO_OPTIONS = Object.freeze([
  { value: true, label: '是' },
  { value: false, label: '否' }
])

export const AUTO_RENEW_OPTIONS = Object.freeze([
  { value: true, label: '是' },
  { value: false, label: '否' },
  { value: null, label: '未设置' }
])

export const AUTO_RENEW_FILTER_OPTIONS = Object.freeze([
  { value: true, label: '是' },
  { value: false, label: '否' },
  { value: 'unset', label: '未设置' }
])

const field = (key, label, type = 'text', extra = {}) => Object.freeze({ key, label, type, ...extra })
const rootField = (key, label, type = 'text', extra = {}) => field(key, label, type, { ...extra, root: true })

export const CONTRACT_CATEGORY_CONFIGS = Object.freeze([
  {
    value: CONTRACT_RECORD_CATEGORIES.SUPPLIER_INFO,
    label: '供应商基本信息',
    shortLabel: '基础信息',
    attachmentGroups: [{ purpose: 'INVOICE_INFO', label: '开票资料附件', accept: '.jpg,.jpeg,.png,.pdf' }],
    summaryKeys: ['supplyStatus', 'hasInvoiceInfo', 'reconciliationEmails'],
    fields: [
      field('supplyStatus', '供方供货情况', 'select', {
        options: [
          { value: 'NORMAL', label: '正常供货' },
          { value: 'STOPPED', label: '已停供' }
        ]
      }),
      field('hasInvoiceInfo', '是否已有开票信息', 'boolean'),
      field('invoiceInfoText', '开票信息', 'textarea', { span: 2, maxlength: 5000 }),
      field('contacts', '厂家联系人及电话', 'contacts', { span: 2 }),
      field('reconciliationEmails', '对账邮箱', 'tags', { span: 2, placeholder: '输入邮箱后按回车，可添加多个' }),
      field('unsignedReason', '未签合同原因', 'textarea', { span: 2, maxlength: 2000 }),
      field('remarks', '备注', 'textarea', { span: 2, maxlength: 5000 })
    ]
  },
  {
    value: CONTRACT_RECORD_CATEGORIES.MAIN_SERVICE_AGREEMENT,
    label: '主合同签订情况',
    shortLabel: '主合同',
    attachmentGroups: [{ purpose: 'CONTRACT_PDF', label: '合同 PDF', accept: '.pdf' }],
    summaryKeys: ['signingStatus', 'contractNumber', 'effectiveDate', 'expiryDate', 'autoRenew'],
    fields: [
      rootField('signingStatus', '签订状态', 'signingStatus'),
      rootField('contractNumber', '合同编号'),
      rootField('effectiveDate', '生效日期', 'date'),
      rootField('expiryDate', '截止日期', 'date'),
      field('supplierSignedDate', '供应商签署日期', 'date'),
      field('companySignedDate', '载信签署日期', 'date'),
      field('returnDate', '回寄日期', 'date'),
      field('courierNumber', '快递单号'),
      field('deliveredBusinessDate', '交付载信商务部日期', 'date'),
      field('deliveredFactoryDate', '交付济南变速箱厂日期', 'date'),
      rootField('autoRenew', '合同是否自动顺延', 'boolean')
    ]
  },
  {
    value: CONTRACT_RECORD_CATEGORIES.LOGISTICS_FEE_AGREEMENT,
    label: '物流服务费用及支付方式协定',
    shortLabel: '物流费用',
    attachmentGroups: [{ purpose: 'GENERAL', label: '协议附件', accept: '.jpg,.jpeg,.png,.pdf,.doc,.docx,.xls,.xlsx' }],
    summaryKeys: ['signingStatus', 'effectiveDate', 'expiryDate', 'autoRenew', 'settlementCycle'],
    fields: [
      rootField('signingStatus', '签订状态', 'signingStatus'),
      rootField('effectiveDate', '生效日期', 'date'),
      rootField('expiryDate', '截止日期', 'date'),
      field('warehouseServiceRate', '仓储服务费率'),
      field('overstorageServiceRate', '超储服务费率'),
      field('overstorageDays', '超储天数', 'text', { maxlength: 200, placeholder: '如：60天、90天、免超储费' }),
      field('settlementCycle', '结算周期'),
      rootField('autoRenew', '合同是否自动顺延', 'boolean'),
      field('remarks', '备注', 'textarea', { span: 2, maxlength: 5000 })
    ]
  },
  {
    value: CONTRACT_RECORD_CATEGORIES.TURNOVER_EQUIPMENT_SERVICE,
    label: '周转器具服务协议',
    shortLabel: '周转器具',
    attachmentGroups: [{ purpose: 'GENERAL', label: '协议附件', accept: '.jpg,.jpeg,.png,.pdf,.doc,.docx,.xls,.xlsx' }],
    summaryKeys: ['signingStatus', 'contractNumber', 'equipmentType', 'expiryDate', 'autoRenew'],
    fields: [
      rootField('signingStatus', '签订状态', 'signingStatus'),
      rootField('contractNumber', '合同编号'),
      rootField('effectiveDate', '生效日期', 'date'),
      rootField('expiryDate', '截止日期', 'date'),
      field('equipmentType', '器具类型'),
      field('equipmentServicePrice', '器具服务价格'),
      field('supplierSignedDate', '供应商签署日期', 'date'),
      field('companySignedDate', '载信签署日期', 'date'),
      field('returnDate', '回寄日期', 'date'),
      field('courierNumber', '快递单号'),
      field('deliveredBusinessDate', '交付载信商务部日期', 'date'),
      field('deliveredFactoryDate', '交付济南变速箱厂日期', 'date'),
      rootField('autoRenew', '合同是否自动顺延', 'boolean'),
      field('remarks', '备注', 'textarea', { span: 2, maxlength: 5000 })
    ]
  },
  {
    value: CONTRACT_RECORD_CATEGORIES.EQUIPMENT_RENTAL,
    label: '器具租赁',
    shortLabel: '器具租赁',
    attachmentGroups: [
      { purpose: 'CONTRACT_PDF', label: '合同 PDF', accept: '.pdf' },
      { purpose: 'PAYMENT_RECEIPT', label: '打款凭证', accept: '.jpg,.jpeg,.png,.pdf' }
    ],
    summaryKeys: ['signingStatus', 'contractNumber', 'equipmentType', 'quantity', 'expiryDate', 'autoRenew'],
    fields: [
      rootField('signingStatus', '签订状态', 'signingStatus'),
      rootField('contractNumber', '合同编号'),
      rootField('effectiveDate', '生效日期', 'date'),
      rootField('expiryDate', '截止日期', 'date'),
      field('equipmentType', '器具类型'),
      field('specification', '规格'),
      field('productionBatch', '生产批次'),
      field('color', '颜色'),
      field('quantity', '数量'),
      rootField('autoRenew', '合同是否自动顺延', 'boolean'),
      field('remarks', '备注', 'textarea', { span: 2, maxlength: 5000 })
    ]
  }
].map((config) => Object.freeze({
  ...config,
  summaryKeys: Object.freeze(config.summaryKeys),
  attachmentGroups: Object.freeze(config.attachmentGroups.map((group) => Object.freeze(group))),
  fields: Object.freeze(config.fields)
})))

export const SETTLEMENT_AMOUNT_FIELDS = Object.freeze([
  { key: 'productLaunchAmount', label: '产品上线金额（含税）' },
  { key: 'warehousingLogisticsFee', label: '仓储物流费' },
  { key: 'overstorageProductAmount', label: '超储产品金额（含税）' },
  { key: 'overstorageLogisticsFee', label: '超储物流费' }
])

export function optionLabel(options, value, fallback = '-') {
  const match = options.find((item) => item.value === value)
  return match?.label || (value === undefined || value === null || value === '' ? fallback : String(value))
}

export function booleanLabel(value) {
  if (value === true || value === 'true' || value === 'YES') return '是'
  if (value === false || value === 'false' || value === 'NO') return '否'
  return '-'
}

export function autoRenewLabel(value) {
  if (value === null || value === undefined || value === '' || value === 'unset') return '未设置'
  return booleanLabel(value)
}

export function normalizeRecord(record = {}) {
  const normalized = {
    ...record,
    ...(record.details && typeof record.details === 'object' ? record.details : {})
  }
  if (normalized.overstorageDays === 'NONE') normalized.overstorageDays = '无超储'
  return normalized
}

export function emptyRecordDetails(config) {
  return Object.fromEntries(config.fields.map((item) => {
    if (item.type === 'boolean') return [item.key, null]
    if (item.type === 'number' || item.type === 'money') return [item.key, null]
    if (item.type === 'tags') return [item.key, []]
    if (item.type === 'contacts') return [item.key, [{ name: '', phone: '' }]]
    return [item.key, '']
  }))
}

export function buildRecordDetails(config, source = {}) {
  return Object.fromEntries(config.fields.filter((item) => !item.root).map((item) => {
    let value = source[item.key]
    if (item.type === 'tags') {
      value = Array.isArray(value)
        ? value.map((entry) => String(entry).trim()).filter(Boolean)
        : String(value || '').split(/[，,;；]/).map((entry) => entry.trim()).filter(Boolean)
    }
    if (item.type === 'contacts') {
      value = (Array.isArray(value) ? value : [])
        .map((entry) => ({ name: String(entry?.name || '').trim(), phone: String(entry?.phone || '').trim() }))
        .filter((entry) => entry.name || entry.phone)
    }
    if (item.type === 'date') {
      value = value ? String(value).trim() : null
    }
    if (item.type === 'money' || item.type === 'number') {
      value = value === '' || value === null || value === undefined ? null : Number(value)
    }
    return [item.key, value === undefined ? '' : value]
  }))
}

export function buildRecordPayload(config, source = {}, attachments = []) {
  const root = Object.fromEntries(config.fields.filter((item) => item.root).map((item) => [
    item.key,
    item.type === 'boolean'
      ? (source[item.key] === null || source[item.key] === undefined ? null : source[item.key] === true)
      : item.type === 'date'
        ? (source[item.key] ? String(source[item.key]).trim() : null)
        : String(source[item.key] ?? '').trim()
  ]))
  return {
    category: config.value,
    trusteeAttribute: String(source.trusteeAttribute || '').trim(),
    ...root,
    details: buildRecordDetails(config, source),
    attachments
  }
}

export function formatContractField(value, item) {
  if (item.key === 'overstorageDays' && value === 'NONE') return '无超储'
  if (item.type === 'boolean') return item.key === 'autoRenew' ? autoRenewLabel(value) : booleanLabel(value)
  if (item.type === 'signingStatus') return optionLabel(SIGNING_STATUS_OPTIONS, value)
  if (item.type === 'date') return value && dayjs(value).isValid() ? dayjs(value).format('YYYY-MM-DD') : '-'
  if (item.type === 'money') return formatMoney(value)
  if (item.type === 'tags') return Array.isArray(value) ? value.join('、') || '-' : value || '-'
  if (item.type === 'contacts') {
    return Array.isArray(value)
      ? value.map((entry) => [entry?.name, entry?.phone].filter(Boolean).join(' ')).filter(Boolean).join('；') || '-'
      : '-'
  }
  if (item.type === 'select') return optionLabel(item.options || [], value)
  if (value === undefined || value === null || value === '') return '-'
  return String(value)
}

export function formatMoney(value) {
  const number = Number(value)
  return Number.isFinite(number)
    ? number.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '0.00'
}

export function expiryAlertRowClass({ row }) {
  if (row?.autoRenew === true) return ''
  const days = Number(row?.remainingDays)
  if (!Number.isFinite(days)) return ''
  if (days < 0) return 'contract-alert-row--expired'
  if (days <= 30) return 'contract-alert-row--warning'
  return ''
}

export function saveContractBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
