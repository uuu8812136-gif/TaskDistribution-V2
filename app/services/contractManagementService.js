'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const Supplier = require('../models/Supplier');
const SupplierContractRecord = require('../models/SupplierContractRecord');
const SupplierSettlementFee = require('../models/SupplierSettlementFee');
const FileAsset = require('../models/FileAsset');
const {
  AUDIT_ACTIONS,
  AUDIT_RESOURCE_TYPES
} = require('../config/permissions');
const { createAuditService } = require('./auditService');
const { createFileAssetService } = require('./fileAssetService');
const {
  createStorageKey,
  resolveStoragePath
} = require('./fileStorageService');
const { extractZipEntries, extractPaymentReceiptEntries } = require('./zipArchiveService');
const { normalizeObjectId } = require('./scopedQueryService');
const { resolveReadTeamId } = require('./reportingServiceSupport');
const {
  assertPermission,
  assertTeamContext
} = require('./teamContextService');
const { runWithRequiredTransaction } = require('./transactionService');
const {
  createExpiryExportWorkbook,
  createSettlementExportWorkbook,
  createSupplierExportWorkbook,
  parseDateOnly,
  parseMonth,
  parseSettlementWorkbook,
  parseSupplierWorkbook
} = require('./contractWorkbookService');

const {
  CONTRACT_ATTACHMENT_PURPOSES,
  CONTRACT_RECORD_CATEGORIES,
  CONTRACT_SIGNING_STATUSES
} = SupplierContractRecord;
const { FILE_OWNER_TYPES, FILE_STATUSES } = FileAsset;

const CATEGORY_VALUES = Object.freeze(Object.values(CONTRACT_RECORD_CATEGORIES));
const CONTRACT_CATEGORIES = Object.freeze(CATEGORY_VALUES.filter(
  (category) => category !== CONTRACT_RECORD_CATEGORIES.SUPPLIER_INFO
));
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_IMPORT_FILE_SIZE = 20 * 1024 * 1024;
const MAX_CONTRACT_PDF_ZIP_SIZE = 220 * 1024 * 1024;
const EXCEL_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const SUPPLIER_EXPORT_QUERY_KEYS = Object.freeze({
  overview: new Set([
    'scope', 'teamId', 'supplierId', 'code', 'name', 'trusteeAttribute',
    'hasSignedContract', 'contractValid', 'category'
  ]),
  secondary: new Set(['scope', 'teamId', 'supplierId', 'category']),
  detail: new Set(['scope', 'teamId', 'supplierId', 'category'])
});

const DETAIL_FIELDS_BY_CATEGORY = Object.freeze({
  [CONTRACT_RECORD_CATEGORIES.SUPPLIER_INFO]: Object.freeze([
    'supplyStatus', 'hasInvoiceInfo', 'invoiceInfoText', 'contacts',
    'reconciliationEmails', 'unsignedReason', 'remarks'
  ]),
  [CONTRACT_RECORD_CATEGORIES.MAIN_SERVICE_AGREEMENT]: Object.freeze([
    'supplierSignedDate', 'companySignedDate', 'returnDate', 'courierNumber',
    'deliveredBusinessDate', 'deliveredFactoryDate', 'remarks'
  ]),
  [CONTRACT_RECORD_CATEGORIES.LOGISTICS_FEE_AGREEMENT]: Object.freeze([
    'warehouseServiceRate', 'overstorageServiceRate', 'overstorageDays',
    'settlementCycle', 'remarks'
  ]),
  [CONTRACT_RECORD_CATEGORIES.TURNOVER_EQUIPMENT_SERVICE]: Object.freeze([
    'equipmentType', 'equipmentServicePrice', 'supplierSignedDate',
    'companySignedDate', 'returnDate', 'courierNumber', 'deliveredBusinessDate',
    'deliveredFactoryDate', 'remarks'
  ]),
  [CONTRACT_RECORD_CATEGORIES.EQUIPMENT_RENTAL]: Object.freeze([
    'equipmentType', 'specification', 'productionBatch', 'color', 'quantity', 'remarks'
  ])
});

const DATE_DETAIL_FIELDS = new Set([
  'supplierSignedDate', 'companySignedDate', 'returnDate',
  'deliveredBusinessDate', 'deliveredFactoryDate'
]);

const PURPOSES_BY_CATEGORY = Object.freeze({
  [CONTRACT_RECORD_CATEGORIES.SUPPLIER_INFO]: new Set([
    CONTRACT_ATTACHMENT_PURPOSES.INVOICE_INFO,
    CONTRACT_ATTACHMENT_PURPOSES.GENERAL
  ]),
  [CONTRACT_RECORD_CATEGORIES.MAIN_SERVICE_AGREEMENT]: new Set([
    CONTRACT_ATTACHMENT_PURPOSES.CONTRACT_PDF,
    CONTRACT_ATTACHMENT_PURPOSES.GENERAL
  ]),
  [CONTRACT_RECORD_CATEGORIES.LOGISTICS_FEE_AGREEMENT]: new Set([
    CONTRACT_ATTACHMENT_PURPOSES.GENERAL
  ]),
  [CONTRACT_RECORD_CATEGORIES.TURNOVER_EQUIPMENT_SERVICE]: new Set([
    CONTRACT_ATTACHMENT_PURPOSES.GENERAL
  ]),
  [CONTRACT_RECORD_CATEGORIES.EQUIPMENT_RENTAL]: new Set([
    CONTRACT_ATTACHMENT_PURPOSES.CONTRACT_PDF,
    CONTRACT_ATTACHMENT_PURPOSES.PAYMENT_RECEIPT,
    CONTRACT_ATTACHMENT_PURPOSES.GENERAL
  ])
});

const IMAGE_OR_PDF_MIMES = new Set(['image/jpeg', 'image/png', 'application/pdf']);
const ALL_SAFE_MIMES = Object.freeze([
  'image/jpeg', 'image/png', 'image/gif', 'application/pdf', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain'
]);

class ContractManagementError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ContractManagementError';
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}

function contractError(status, code, message) {
  return new ContractManagementError(status, code, message);
}

function requiredText(value, field, max = 200) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw contractError(400, 'CONTRACT_INPUT_INVALID', `${field}不能为空`);
  }
  const normalized = String(value).trim();
  if (!normalized || normalized.length > max) {
    throw contractError(400, 'CONTRACT_INPUT_INVALID', `${field}不能为空且不能超过${max}个字符`);
  }
  return normalized;
}

function optionalText(value, field, max = 5000) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw contractError(400, 'CONTRACT_INPUT_INVALID', `${field}格式不正确`);
  }
  const normalized = String(value).trim();
  if (normalized.length > max) {
    throw contractError(400, 'CONTRACT_INPUT_INVALID', `${field}不能超过${max}个字符`);
  }
  return normalized;
}

function booleanValue(value, field, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined || value === '')) return null;
  if (value === true || value === false) return value;
  throw contractError(400, 'CONTRACT_INPUT_INVALID', `${field}必须是布尔值`);
}

function normalizeDate(value, field) {
  try {
    return parseDateOnly(value);
  } catch {
    throw contractError(400, 'CONTRACT_DATE_INVALID', `${field}必须是有效日期`);
  }
}

function normalizeId(value, resource = '记录') {
  try {
    return normalizeObjectId(value, 'id');
  } catch {
    throw contractError(404, 'CONTRACT_RECORD_NOT_FOUND', `${resource}不存在`);
  }
}

function plain(document) {
  return typeof document?.toObject === 'function'
    ? document.toObject({ depopulate: true, versionKey: false })
    : document;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeAttachmentMatchText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function contractPdfPurposeAllowed(record) {
  return record?.category === CONTRACT_RECORD_CATEGORIES.MAIN_SERVICE_AGREEMENT ||
    record?.category === CONTRACT_RECORD_CATEGORIES.EQUIPMENT_RENTAL;
}

function matchContractPdfEntry(entry, suppliers, records, recordAllowed = contractPdfPurposeAllowed) {
  const stem = String(entry.name || '').replace(/\.[^.]+$/i, '');
  const recordById = records.find((record) => (
    new RegExp(`(?:^|[^a-f0-9])${String(record._id)}(?:$|[^a-f0-9])`, 'i').test(stem)
  ));
  if (recordById && recordAllowed(recordById)) return { record: recordById };

  const separatorIndex = stem.indexOf('__');
  const supplierHint = normalizeAttachmentMatchText(
    separatorIndex >= 0 ? stem.slice(0, separatorIndex) : stem
  );
  const supplierCandidates = suppliers.filter((supplier) => {
    const code = normalizeAttachmentMatchText(supplier.code);
    return code && code === supplierHint;
  });
  if (supplierCandidates.length !== 1) {
    return supplierCandidates.length > 1
      ? { status: 'ambiguous', reason: '文件名同时匹配多个供应商编码' }
      : { status: 'unmatched', reason: '文件名未使用唯一供应商编码' };
  }
  const supplier = supplierCandidates[0];
  const supplierRecords = records.filter((record) => (
    String(record.supplierId) === String(supplier._id) && recordAllowed(record)
  ));
  if (!supplierRecords.length) return { status: 'unmatched', reason: '该供应商没有可绑定合同记录' };

  const contractHint = separatorIndex >= 0
    ? normalizeAttachmentMatchText(stem.slice(separatorIndex + 2))
    : '';
  if (separatorIndex >= 0) {
    if (!contractHint) return { status: 'unmatched', reason: '文件名缺少合同编号' };
    const byContractNumber = supplierRecords.filter((record) => (
      normalizeAttachmentMatchText(record.contractNumber) === contractHint
    ));
    if (byContractNumber.length === 1) return { record: byContractNumber[0] };
    return byContractNumber.length > 1
      ? { status: 'ambiguous', reason: '同一供应商和合同编号对应多条记录' }
      : { status: 'unmatched', reason: '文件名中的合同编号不存在' };
  }
  if (supplierRecords.length === 1) return { record: supplierRecords[0] };
  return { status: 'ambiguous', reason: '同一供应商有多条合同记录，请在文件名中加入__合同编号' };
}

function pagination(query = {}) {
  const page = Number(query.page || 1);
  const pageSize = Number(query.pageSize || 20);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) {
    throw contractError(400, 'CONTRACT_PAGINATION_INVALID', '分页参数不正确');
  }
  return { page, pageSize };
}

function queryBoolean(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  throw contractError(400, 'CONTRACT_FILTER_INVALID', `${field}筛选值不正确`);
}

function queryInteger(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || Math.abs(parsed) > 1000000) {
    throw contractError(400, 'CONTRACT_FILTER_INVALID', `${field}筛选值不正确`);
  }
  return parsed;
}

function todayShanghai(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
}

function derivedContractState(latestMain, today = todayShanghai()) {
  const signed = latestMain?.signingStatus === CONTRACT_SIGNING_STATUSES.SIGNED;
  const expiry = latestMain?.expiryDate ? new Date(latestMain.expiryDate) : null;
  const expiryReady = Boolean(expiry && Number.isFinite(expiry.getTime()));
  return {
    hasSignedContract: signed,
    contractValid: Boolean(expiryReady && (today <= expiry || latestMain.autoRenew === true))
  };
}

function assertNoFields(input, fields, code = 'CONTRACT_COMPUTED_FIELD_READ_ONLY') {
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(input || {}, field)) {
      throw contractError(400, code, `${field}由系统计算，不能手工填写`);
    }
  }
}

function normalizeTrusteeAttribute(value) {
  if (!['HOSTED', 'NON_HOSTED'].includes(value)) {
    throw contractError(400, 'CONTRACT_INPUT_INVALID', '托管属性必须是HOSTED或NON_HOSTED');
  }
  return value;
}

function normalizeSupplierInput(input, { partial = false, current = null } = {}) {
  assertNoFields(input, ['teamId', 'hasSignedContract', 'contractValid']);
  const allowed = new Set(['name', 'code', 'trusteeAttribute']);
  if (Object.keys(input || {}).some((key) => !allowed.has(key))) {
    throw contractError(400, 'CONTRACT_INPUT_INVALID', '供应商包含不支持的字段');
  }
  const source = { ...(current || {}), ...(input || {}) };
  const trusteeAttribute = normalizeTrusteeAttribute(source.trusteeAttribute);
  const result = {
    name: requiredText(source.name, '供应商名称'),
    code: requiredText(source.code, '供应商编码', 100),
    trusteeAttribute
  };
  if (partial && Object.keys(input || {}).length === 0) {
    throw contractError(400, 'CONTRACT_INPUT_INVALID', '至少修改一个字段');
  }
  return result;
}

function normalizeContacts(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 100) {
    throw contractError(400, 'CONTRACT_INPUT_INVALID', '联系人必须是数组且不能超过100人');
  }
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
      Object.keys(item).some((key) => !['name', 'phone'].includes(key))) {
      throw contractError(400, 'CONTRACT_INPUT_INVALID', '联系人格式不正确');
    }
    const contact = {
      name: optionalText(item.name, '联系人姓名', 100),
      phone: optionalText(item.phone, '联系电话', 100)
    };
    if (!contact.name && !contact.phone) {
      throw contractError(400, 'CONTRACT_INPUT_INVALID', '联系人姓名和电话至少填写一项');
    }
    return contact;
  });
}

function normalizeDetails(category, value) {
  const details = value === undefined || value === null ? {} : value;
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    throw contractError(400, 'CONTRACT_INPUT_INVALID', 'details格式不正确');
  }
  const allowed = new Set(DETAIL_FIELDS_BY_CATEGORY[category] || []);
  if (Object.keys(details).some((key) => !allowed.has(key))) {
    throw contractError(400, 'CONTRACT_DETAIL_FIELD_INVALID', '当前合同类型包含不支持的明细字段');
  }
  const normalized = {};
  for (const field of allowed) {
    const fieldValue = details[field];
    if (field === 'contacts') normalized[field] = normalizeContacts(fieldValue);
    else if (field === 'reconciliationEmails') {
      if (fieldValue === undefined || fieldValue === null) normalized[field] = [];
      else if (!Array.isArray(fieldValue) || fieldValue.length > 100) {
        throw contractError(400, 'CONTRACT_INPUT_INVALID', '对账邮箱格式不正确');
      } else normalized[field] = fieldValue.map((email) => requiredText(email, '对账邮箱', 254));
    } else if (field === 'hasInvoiceInfo') normalized[field] = booleanValue(fieldValue, '是否已有开票信息', { nullable: true });
    else if (DATE_DETAIL_FIELDS.has(field)) normalized[field] = normalizeDate(fieldValue, field);
    else if (field === 'supplyStatus') {
      if (fieldValue === undefined || fieldValue === null || fieldValue === '') normalized[field] = null;
      else if (!['NORMAL', 'STOPPED'].includes(fieldValue)) throw contractError(400, 'CONTRACT_INPUT_INVALID', '供货状态不正确');
      else normalized[field] = fieldValue;
    } else if (field === 'overstorageDays') {
      if (fieldValue === undefined || fieldValue === null || fieldValue === '') normalized[field] = null;
      else normalized[field] = optionalText(fieldValue, '超储天数', 200);
    } else normalized[field] = optionalText(fieldValue, field, field === 'remarks' ? 5000 : 2000);
  }
  return normalized;
}

function normalizeAttachmentInput(category, value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 10) {
    throw contractError(400, 'CONTRACT_ATTACHMENT_INVALID', '附件不能超过10个');
  }
  const allowedPurposes = PURPOSES_BY_CATEGORY[category];
  const seen = new Set();
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
      Object.keys(item).some((key) => !['fileId', 'purpose'].includes(key))) {
      throw contractError(400, 'CONTRACT_ATTACHMENT_INVALID', '附件必须包含fileId和purpose');
    }
    const fileId = normalizeId(item.fileId, '附件');
    if (!allowedPurposes.has(item.purpose)) {
      throw contractError(400, 'CONTRACT_ATTACHMENT_PURPOSE_INVALID', '附件用途不适用于当前合同类型');
    }
    if (seen.has(fileId)) throw contractError(400, 'CONTRACT_ATTACHMENT_DUPLICATE', '同一附件不能重复绑定');
    seen.add(fileId);
    return { fileId, purpose: item.purpose };
  });
}

function normalizeRecordInput(input, { current = null, partial = false } = {}) {
  assertNoFields(input, ['teamId', 'supplierId', 'hasSignedContract', 'contractValid']);
  const allowed = new Set([
    'category', 'signingStatus', 'contractNumber', 'effectiveDate', 'expiryDate',
    'autoRenew', 'details', 'attachments', 'trusteeAttribute'
  ]);
  if (Object.keys(input || {}).some((key) => !allowed.has(key))) {
    throw contractError(400, 'CONTRACT_INPUT_INVALID', '合同记录包含不支持的字段');
  }
  const category = current?.category || input.category;
  if (!CATEGORY_VALUES.includes(category)) throw contractError(400, 'CONTRACT_CATEGORY_INVALID', '合同类型不正确');
  if (current && Object.prototype.hasOwnProperty.call(input, 'category') && input.category !== current.category) {
    throw contractError(400, 'CONTRACT_CATEGORY_IMMUTABLE', '合同类型创建后不能修改');
  }
  const source = { ...(current || {}), ...(input || {}) };
  const isInfo = category === CONTRACT_RECORD_CATEGORIES.SUPPLIER_INFO;
  const signingStatus = isInfo ? null : source.signingStatus;
  if (!isInfo && !Object.values(CONTRACT_SIGNING_STATUSES).includes(signingStatus)) {
    throw contractError(400, 'CONTRACT_SIGNING_STATUS_INVALID', '合同签订状态必须是SIGNED或UNSIGNED');
  }
  const effectiveDate = isInfo ? null : normalizeDate(source.effectiveDate, '合同生效日期');
  const expiryDate = isInfo ? null : normalizeDate(source.expiryDate, '合同截止日期');
  if (effectiveDate && expiryDate && effectiveDate > expiryDate) {
    throw contractError(400, 'CONTRACT_DATE_RANGE_INVALID', '合同截止日期不能早于生效日期');
  }
  if (partial && Object.keys(input || {}).length === 0) throw contractError(400, 'CONTRACT_INPUT_INVALID', '至少修改一个字段');
  const currentDetails = current
    ? Object.fromEntries((DETAIL_FIELDS_BY_CATEGORY[category] || []).map(
      (field) => [field, current.details?.[field]]
    ))
    : {};
  return {
    category,
    trusteeAttribute: Object.prototype.hasOwnProperty.call(input || {}, 'trusteeAttribute')
      ? normalizeTrusteeAttribute(input.trusteeAttribute)
      : null,
    signingStatus,
    contractNumber: isInfo ? '' : optionalText(source.contractNumber, '合同编号', 200),
    effectiveDate,
    expiryDate,
    autoRenew: isInfo ? false : booleanValue(source.autoRenew ?? false, '是否自动顺延'),
    details: normalizeDetails(
      category,
      current && Object.prototype.hasOwnProperty.call(input || {}, 'details')
        ? { ...currentDetails, ...(input.details || {}) }
        : current ? currentDetails : source.details
    ),
    attachments: Object.prototype.hasOwnProperty.call(input || {}, 'attachments')
      ? normalizeAttachmentInput(category, input.attachments)
      : null
  };
}

function normalizePersistenceError(error) {
  if (error instanceof ContractManagementError) return error;
  if (error?.code === 11000) {
    const monthDuplicate = Boolean(error?.keyPattern?.month || error?.keyValue?.month);
    return monthDuplicate
      ? contractError(409, 'CONTRACT_SETTLEMENT_DUPLICATE', '同一月份和供应商编码的结算费用已存在')
      : contractError(409, 'CONTRACT_SUPPLIER_CODE_DUPLICATE', '当前团队已存在相同供应商编码');
  }
  if (error?.name === 'ValidationError' || error?.name === 'StrictModeError') {
    return contractError(400, 'CONTRACT_INPUT_INVALID', error.message);
  }
  return error;
}

async function execute(query, session) {
  if (session && typeof query.session === 'function') query.session(session);
  return query;
}

async function createOne(Model, values, session) {
  const created = await Model.create([values], { session });
  return created[0];
}

function createContractManagementService({
  SupplierModel = Supplier,
  ContractRecordModel = SupplierContractRecord,
  SettlementModel = SupplierSettlementFee,
  FileAssetModel = FileAsset,
  auditService = createAuditService(),
  fileAssetService = createFileAssetService({ storageRoot: process.env.UPLOAD_PATH }),
  connection = mongoose.connection,
  now = () => new Date(),
  storageRoot = process.env.UPLOAD_PATH
} = {}) {
  const runWrite = (work) => runWithRequiredTransaction(work, connection, {
    code: 'CONTRACT_TRANSACTIONS_REQUIRED',
    message: '合同管理写入需要MongoDB事务支持，请先启用副本集后重试'
  });

  async function teamForRead(authContext, requestedTeamId, permissionKey) {
    assertPermission(authContext, permissionKey);
    return resolveReadTeamId({ authContext, requestedTeamId });
  }

  function teamForWrite(authContext, permissionKey) {
    const context = assertTeamContext(authContext);
    assertPermission(context, permissionKey);
    return { context, teamId: normalizeObjectId(context.activeTeamId, 'activeTeamId') };
  }

  async function lockSupplierForMutation({ teamId, filter, context, session }) {
    return execute(SupplierModel.findOneAndUpdate(
      { teamId, ...filter },
      { $set: { updatedBy: context.userId }, $currentDate: { updatedAt: true } },
      { new: true }
    ), session);
  }

  async function latestMainBySupplier(teamId, supplierIds) {
    if (!supplierIds.length) return new Map();
    const records = await ContractRecordModel.find({
      teamId,
      supplierId: { $in: supplierIds },
      category: CONTRACT_RECORD_CATEGORIES.MAIN_SERVICE_AGREEMENT
    }).sort({ expiryDate: -1, createdAt: -1, _id: -1 }).lean();
    const result = new Map();
    for (const record of records) {
      const key = String(record.supplierId);
      if (!result.has(key)) result.set(key, record);
    }
    return result;
  }

  async function attachDerivedStates(teamId, suppliers) {
    const latest = await latestMainBySupplier(teamId, suppliers.map((supplier) => supplier._id));
    return suppliers.map((supplier) => {
      const latestContract = latest.get(String(supplier._id));
      return {
        ...plain(supplier),
        ...derivedContractState(latestContract, todayShanghai(now())),
        latestContractNumber: latestContract?.contractNumber || '',
        latestContractExpiryDate: latestContract?.expiryDate || null
      };
    });
  }

  async function listSuppliers({ authContext, requestedTeamId, query = {} }) {
    const teamId = await teamForRead(authContext, requestedTeamId, 'contract.supplier.view');
    const filter = { teamId };
    if (query.code) filter.code = requiredText(query.code, '供应商编码', 100);
    if (query.name) filter.name = { $regex: escapeRegex(requiredText(query.name, '供应商名称')), $options: 'i' };
    if (query.trusteeAttribute) {
      if (!['HOSTED', 'NON_HOSTED'].includes(query.trusteeAttribute)) throw contractError(400, 'CONTRACT_FILTER_INVALID', '托管属性筛选值不正确');
      filter.trusteeAttribute = query.trusteeAttribute;
    }
    const linkedSupplierIds = await ContractRecordModel.distinct('supplierId', { teamId });
    filter._id = { $in: linkedSupplierIds };
    const suppliers = await SupplierModel.find(filter).sort({ name: 1, code: 1, _id: 1 }).lean();
    const withStates = await attachDerivedStates(teamId, suppliers);
    const hasSigned = queryBoolean(query.hasSignedContract, '是否签订合同');
    const contractValid = queryBoolean(query.contractValid, '合同是否有效');
    const filtered = withStates.filter((supplier) => (
      (hasSigned === null || supplier.hasSignedContract === hasSigned) &&
      (contractValid === null || supplier.contractValid === contractValid)
    ));
    const { page, pageSize } = pagination(query);
    return {
      suppliers: filtered.slice((page - 1) * pageSize, page * pageSize),
      page,
      pageSize,
      total: filtered.length
    };
  }

  async function getSupplier({ authContext, requestedTeamId, supplierId }) {
    const teamId = await teamForRead(authContext, requestedTeamId, 'contract.supplier.view');
    const supplier = await SupplierModel.findOne({ _id: normalizeId(supplierId, '供应商'), teamId }).lean();
    if (!supplier) throw contractError(404, 'CONTRACT_SUPPLIER_NOT_FOUND', '供应商不存在');
    const records = await ContractRecordModel.find({ teamId, supplierId: supplier._id })
      .sort({ category: 1, expiryDate: -1, createdAt: -1, _id: -1 }).lean();
    if (records.length === 0) {
      throw contractError(404, 'CONTRACT_SUPPLIER_NOT_FOUND', '供应商不存在');
    }
    const [withState] = await attachDerivedStates(teamId, [supplier]);
    const summaries = {};
    for (const category of CATEGORY_VALUES) {
      const categoryRecords = records.filter((record) => record.category === category);
      summaries[category] = {
        count: categoryRecords.length,
        latest: categoryRecords[0] || null
      };
    }
    return { ...withState, categorySummaries: summaries };
  }

  async function updateSupplier({ authContext, req, supplierId, input }) {
    const { context, teamId } = teamForWrite(authContext, 'contract.supplier.manage');
    try {
      return await runWrite(async (session) => {
        const supplier = await lockSupplierForMutation({
          teamId,
          filter: { _id: normalizeId(supplierId, '供应商') },
          context,
          session
        });
        if (!supplier) throw contractError(404, 'CONTRACT_SUPPLIER_NOT_FOUND', '供应商不存在');
        const hasTertiaryRecord = await execute(ContractRecordModel.exists({
          teamId,
          supplierId: supplier._id
        }), session);
        if (!hasTertiaryRecord) {
          throw contractError(
            409,
            'CONTRACT_SUPPLIER_TERTIARY_RECORD_REQUIRED',
            '供应商必须先通过三级明细创建，不能从一级总览单独维护'
          );
        }
        const before = plain(supplier);
        const values = normalizeSupplierInput(input, { partial: true, current: before });
        Object.assign(supplier, values, { updatedBy: context.userId });
        await supplier.save({ session });
        await SettlementModel.updateMany({ teamId, supplierId: supplier._id }, {
          $set: { supplierName: supplier.name, supplierCode: supplier.code, updatedBy: context.userId }
        }, { session });
        await auditService.record({ req, authContext: context, action: AUDIT_ACTIONS.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPES.SUPPLIER, resourceId: supplier._id,
          before, after: plain(supplier), targetTeamId: teamId, session });
        const [result] = await attachDerivedStates(teamId, [plain(supplier)]);
        return result;
      });
    } catch (error) { throw normalizePersistenceError(error); }
  }

  async function reconcileRecordAttachments({ context, req, record, requested, previous, session }) {
    if (requested === null) return previous || [];
    const ownerType = record.category === CONTRACT_RECORD_CATEGORIES.SUPPLIER_INFO
      ? FILE_OWNER_TYPES.SUPPLIER_PROFILE
      : FILE_OWNER_TYPES.SUPPLIER_CONTRACT;
    const references = await fileAssetService.reconcileOwnerFiles({
      authContext: context, req,
      attachments: requested.map(({ fileId }) => ({ fileId })),
      previousAttachments: previous || [], ownerType, ownerId: record._id,
      allowedMimeTypes: ALL_SAFE_MIMES, session
    });
    const purposeById = new Map(requested.map((item) => [String(item.fileId), item.purpose]));
    return references.map((reference) => {
      const purpose = purposeById.get(String(reference.fileId));
      const mime = String(reference.mimeType).toLowerCase();
      if (purpose === CONTRACT_ATTACHMENT_PURPOSES.CONTRACT_PDF && mime !== 'application/pdf') {
        throw contractError(415, 'CONTRACT_ATTACHMENT_MIME_INVALID', '合同PDF附件只能上传PDF文件');
      }
      if ([CONTRACT_ATTACHMENT_PURPOSES.INVOICE_INFO, CONTRACT_ATTACHMENT_PURPOSES.PAYMENT_RECEIPT].includes(purpose) && !IMAGE_OR_PDF_MIMES.has(mime)) {
        throw contractError(415, 'CONTRACT_ATTACHMENT_MIME_INVALID', '开票资料和打款凭证只能上传JPEG、PNG或PDF');
      }
      return { ...reference, purpose };
    });
  }

  async function listRecords({ authContext, requestedTeamId, supplierId, query = {} }) {
    const teamId = await teamForRead(authContext, requestedTeamId, 'contract.supplier.view');
    const normalizedSupplierId = normalizeId(supplierId, '供应商');
    if (!await SupplierModel.exists({ _id: normalizedSupplierId, teamId })) throw contractError(404, 'CONTRACT_SUPPLIER_NOT_FOUND', '供应商不存在');
    if (!await ContractRecordModel.exists({ teamId, supplierId: normalizedSupplierId })) {
      throw contractError(404, 'CONTRACT_SUPPLIER_NOT_FOUND', '供应商不存在');
    }
    const filter = { teamId, supplierId: normalizedSupplierId };
    if (query.category) {
      if (!CATEGORY_VALUES.includes(query.category)) throw contractError(400, 'CONTRACT_CATEGORY_INVALID', '合同类型不正确');
      filter.category = query.category;
    }
    const { page, pageSize } = pagination(query);
    const [records, total] = await Promise.all([
      ContractRecordModel.find(filter).sort({ expiryDate: -1, createdAt: -1, _id: -1 })
        .skip((page - 1) * pageSize).limit(pageSize).lean(),
      ContractRecordModel.countDocuments(filter)
    ]);
    return { records, page, pageSize, total };
  }

  async function getRecord({ authContext, requestedTeamId, recordId }) {
    const teamId = await teamForRead(authContext, requestedTeamId, 'contract.supplier.view');
    const record = await ContractRecordModel.findOne({ _id: normalizeId(recordId, '合同记录'), teamId }).lean();
    if (!record) throw contractError(404, 'CONTRACT_RECORD_NOT_FOUND', '合同记录不存在');
    return record;
  }

  async function createRecordDocument({ context, req, teamId, supplier, values, session }) {
    if (values.trusteeAttribute && supplier.trusteeAttribute !== values.trusteeAttribute) {
      const beforeSupplier = plain(supplier);
      supplier.trusteeAttribute = values.trusteeAttribute;
      supplier.updatedBy = context.userId;
      await supplier.save({ session });
      await auditService.record({ req, authContext: context, action: AUDIT_ACTIONS.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPES.SUPPLIER, resourceId: supplier._id,
        before: beforeSupplier, after: plain(supplier), targetTeamId: teamId, session });
    }
    const record = await createOne(ContractRecordModel, {
      teamId, supplierId: supplier._id, category: values.category,
      signingStatus: values.signingStatus, contractNumber: values.contractNumber,
      effectiveDate: values.effectiveDate, expiryDate: values.expiryDate,
      autoRenew: values.autoRenew, details: values.details, attachments: [],
      createdBy: context.userId, updatedBy: context.userId
    }, session);
    record.attachments = await reconcileRecordAttachments({ context, req, record,
      requested: values.attachments || [], previous: [], session });
    await record.save({ session });
    await auditService.record({ req, authContext: context, action: AUDIT_ACTIONS.CREATE,
      resourceType: AUDIT_RESOURCE_TYPES.SUPPLIER_CONTRACT_RECORD, resourceId: record._id,
      after: plain(record), targetTeamId: teamId, session });
    return record;
  }

  async function createFirstRecord({ authContext, req, input }) {
    const { context, teamId } = teamForWrite(authContext, 'contract.supplier.manage');
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const { supplierIdentity, ...recordInput } = source;
    if (!supplierIdentity || typeof supplierIdentity !== 'object' || Array.isArray(supplierIdentity)) {
      throw contractError(400, 'CONTRACT_SUPPLIER_IDENTITY_REQUIRED', '新增三级明细必须填写供应商名称和编码');
    }
    const supplierValues = normalizeSupplierInput({
      name: supplierIdentity.name,
      code: supplierIdentity.code,
      trusteeAttribute: source.trusteeAttribute
    });
    const values = normalizeRecordInput(recordInput);
    try {
      return await runWrite(async (session) => {
        const existing = await execute(SupplierModel.findOne({ teamId, code: supplierValues.code }), session);
        if (existing) {
          throw contractError(409, 'CONTRACT_SUPPLIER_ALREADY_EXISTS', '该供应商编码已存在，请进入三级详情新增明细');
        }
        const supplier = await createOne(SupplierModel, {
          teamId, ...supplierValues, createdBy: context.userId, updatedBy: context.userId
        }, session);
        await auditService.record({ req, authContext: context, action: AUDIT_ACTIONS.CREATE,
          resourceType: AUDIT_RESOURCE_TYPES.SUPPLIER, resourceId: supplier._id,
          after: plain(supplier), targetTeamId: teamId, session });
        const record = await createRecordDocument({ context, req, teamId, supplier, values, session });
        return {
          supplier: { ...plain(supplier), hasSignedContract: false, contractValid: false },
          record: plain(record)
        };
      });
    } catch (error) { throw normalizePersistenceError(error); }
  }

  async function createRecord({ authContext, req, supplierId, input }) {
    const { context, teamId } = teamForWrite(authContext, 'contract.supplier.manage');
    const normalizedSupplierId = normalizeId(supplierId, '供应商');
    const values = normalizeRecordInput(input);
    try {
      return await runWrite(async (session) => {
        const supplier = await lockSupplierForMutation({
          teamId,
          filter: { _id: normalizedSupplierId },
          context,
          session
        });
        if (!supplier) throw contractError(404, 'CONTRACT_SUPPLIER_NOT_FOUND', '供应商不存在');
        const record = await createRecordDocument({ context, req, teamId, supplier, values, session });
        return plain(record);
      });
    } catch (error) { throw normalizePersistenceError(error); }
  }

  async function updateRecord({ authContext, req, recordId, input }) {
    const { context, teamId } = teamForWrite(authContext, 'contract.supplier.manage');
    try {
      return await runWrite(async (session) => {
        const record = await execute(ContractRecordModel.findOne({ _id: normalizeId(recordId, '合同记录'), teamId }), session);
        if (!record) throw contractError(404, 'CONTRACT_RECORD_NOT_FOUND', '合同记录不存在');
        const before = plain(record);
        const values = normalizeRecordInput(input, { current: before, partial: true });
        if (values.trusteeAttribute) {
          const supplier = await execute(SupplierModel.findOne({ _id: record.supplierId, teamId }), session);
          if (!supplier) throw contractError(404, 'CONTRACT_SUPPLIER_NOT_FOUND', '供应商不存在');
          if (supplier.trusteeAttribute !== values.trusteeAttribute) {
            const beforeSupplier = plain(supplier);
            supplier.trusteeAttribute = values.trusteeAttribute;
            supplier.updatedBy = context.userId;
            await supplier.save({ session });
            await auditService.record({ req, authContext: context, action: AUDIT_ACTIONS.UPDATE,
              resourceType: AUDIT_RESOURCE_TYPES.SUPPLIER, resourceId: supplier._id,
              before: beforeSupplier, after: plain(supplier), targetTeamId: teamId, session });
          }
        }
        Object.assign(record, {
          signingStatus: values.signingStatus, contractNumber: values.contractNumber,
          effectiveDate: values.effectiveDate, expiryDate: values.expiryDate,
          autoRenew: values.autoRenew, details: values.details, updatedBy: context.userId
        });
        await record.validate();
        record.attachments = await reconcileRecordAttachments({ context, req, record,
          requested: values.attachments, previous: before.attachments, session });
        await record.save({ session });
        await auditService.record({ req, authContext: context, action: AUDIT_ACTIONS.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPES.SUPPLIER_CONTRACT_RECORD, resourceId: record._id,
          before, after: plain(record), targetTeamId: teamId, session });
        return plain(record);
      });
    } catch (error) { throw normalizePersistenceError(error); }
  }

  async function deleteRecord({ authContext, req, recordId }) {
    const { context, teamId } = teamForWrite(authContext, 'contract.supplier.manage');
    try {
      return await runWrite(async (session) => {
        const record = await execute(ContractRecordModel.findOne({ _id: normalizeId(recordId, '合同记录'), teamId }), session);
        if (!record) throw contractError(404, 'CONTRACT_RECORD_NOT_FOUND', '合同记录不存在');
        const lockedSupplier = await lockSupplierForMutation({
          teamId,
          filter: { _id: record.supplierId },
          context,
          session
        });
        if (!lockedSupplier) throw contractError(404, 'CONTRACT_SUPPLIER_NOT_FOUND', '供应商不存在');
        const isLastRecord = await execute(ContractRecordModel.countDocuments({
          teamId,
          supplierId: record.supplierId
        }), session) === 1;
        if (isLastRecord) {
          const settlementExists = await execute(SettlementModel.exists({
            teamId,
            supplierId: record.supplierId
          }), session);
          if (settlementExists) {
            throw contractError(
              409,
              'CONTRACT_SUPPLIER_LAST_RECORD_HAS_SETTLEMENTS',
              '该供应商已有结算数据，不能删除最后一条三级明细'
            );
          }
        }
        const before = plain(record);
        await reconcileRecordAttachments({ context, req, record, requested: [], previous: before.attachments, session });
        await record.deleteOne({ session });
        await auditService.record({ req, authContext: context, action: AUDIT_ACTIONS.DELETE,
          resourceType: AUDIT_RESOURCE_TYPES.SUPPLIER_CONTRACT_RECORD, resourceId: record._id,
          before, targetTeamId: teamId, session });
        if (isLastRecord) {
          const supplier = await execute(SupplierModel.findOne({ _id: record.supplierId, teamId }), session);
          if (supplier) {
            const beforeSupplier = plain(supplier);
            await supplier.deleteOne({ session });
            await auditService.record({ req, authContext: context, action: AUDIT_ACTIONS.DELETE,
              resourceType: AUDIT_RESOURCE_TYPES.SUPPLIER, resourceId: supplier._id,
              before: beforeSupplier, targetTeamId: teamId, session });
          }
        }
        return { ...before, supplierDeleted: isLastRecord };
      });
    } catch (error) { throw normalizePersistenceError(error); }
  }

  async function supplierExport({ authContext, req, requestedTeamId, query = {} }) {
    const teamId = await teamForRead(authContext, requestedTeamId, 'contract.supplier.export');
    const scope = String(query.scope || '').trim();
    if (!['overview', 'secondary', 'detail'].includes(scope)) {
      throw contractError(400, 'CONTRACT_EXPORT_SCOPE_INVALID', '供应商合同导出范围不正确');
    }
    const unexpectedParameter = Object.keys(query).find(
      (key) => !SUPPLIER_EXPORT_QUERY_KEYS[scope].has(key)
    );
    if (unexpectedParameter) {
      throw contractError(
        400,
        'CONTRACT_EXPORT_PARAMETER_INVALID',
        `当前导出范围不支持参数：${unexpectedParameter}`
      );
    }
    if (scope === 'secondary' && !query.supplierId) {
      throw contractError(400, 'CONTRACT_EXPORT_SUPPLIER_REQUIRED', '导出二级汇总必须指定供应商');
    }
    if (scope !== 'detail' && query.category) {
      throw contractError(400, 'CONTRACT_EXPORT_CATEGORY_NOT_ALLOWED', '当前导出范围不能指定合同类型');
    }
    if (scope === 'detail' && Boolean(query.supplierId) !== Boolean(query.category)) {
      throw contractError(
        400,
        'CONTRACT_EXPORT_DETAIL_CONTEXT_INVALID',
        '导出三级明细时，供应商和合同类型必须同时指定或同时留空'
      );
    }
    const supplierFilter = { teamId };
    const linkedSupplierIds = await ContractRecordModel.distinct('supplierId', { teamId });
    if (query.supplierId) {
      const requestedSupplierId = normalizeId(query.supplierId, '供应商');
      if (!linkedSupplierIds.some((item) => String(item) === requestedSupplierId)) {
        throw contractError(404, 'CONTRACT_SUPPLIER_NOT_FOUND', '供应商不存在');
      }
      supplierFilter._id = requestedSupplierId;
    } else {
      supplierFilter._id = { $in: linkedSupplierIds };
    }
    if (query.code) supplierFilter.code = requiredText(query.code, '供应商编码', 100);
    if (query.name) supplierFilter.name = { $regex: escapeRegex(requiredText(query.name, '供应商名称')), $options: 'i' };
    if (query.trusteeAttribute) {
      if (!['HOSTED', 'NON_HOSTED'].includes(query.trusteeAttribute)) {
        throw contractError(400, 'CONTRACT_FILTER_INVALID', '托管属性筛选值不正确');
      }
      supplierFilter.trusteeAttribute = query.trusteeAttribute;
    }
    if (query.category && !CATEGORY_VALUES.includes(query.category)) {
      throw contractError(400, 'CONTRACT_CATEGORY_INVALID', '合同类型不正确');
    }
    const suppliers = await SupplierModel.find(supplierFilter).sort({ name: 1, code: 1, _id: 1 }).lean();
    if (query.supplierId && suppliers.length === 0) throw contractError(404, 'CONTRACT_SUPPLIER_NOT_FOUND', '供应商不存在');
    const withStates = await attachDerivedStates(teamId, suppliers);
    const hasSigned = queryBoolean(query.hasSignedContract, '是否签订合同');
    const contractValid = queryBoolean(query.contractValid, '合同是否有效');
    const filteredSuppliers = withStates.filter((supplier) => (
      (hasSigned === null || supplier.hasSignedContract === hasSigned) &&
      (contractValid === null || supplier.contractValid === contractValid)
    ));
    const needsRecords = scope !== 'overview';
    const recordFilter = { teamId, supplierId: { $in: filteredSuppliers.map((supplier) => supplier._id) } };
    const records = needsRecords && filteredSuppliers.length
      ? await ContractRecordModel.find(recordFilter).sort({ supplierId: 1, category: 1, effectiveDate: -1, createdAt: -1 }).lean()
      : [];
    const exportedRecordCount = scope === 'overview'
      ? 0
      : query.category
      ? records.filter((record) => record.category === query.category).length
      : records.length;
    const buffer = await createSupplierExportWorkbook({
      scope,
      suppliers: filteredSuppliers,
      records,
      category: query.category || null
    });
    await auditService.record({ req, authContext, action: AUDIT_ACTIONS.EXPORT,
      resourceType: AUDIT_RESOURCE_TYPES.SUPPLIER_CONTRACT_RECORD,
      targetTeamId: teamId, after: { supplierCount: filteredSuppliers.length, recordCount: exportedRecordCount,
        scope, supplierId: query.supplierId || null, category: query.category || null } });
    const exportedCount = scope === 'detail' ? exportedRecordCount : filteredSuppliers.length;
    return {
      buffer,
      scope,
      exportedCount,
      supplierCount: filteredSuppliers.length,
      recordCount: exportedRecordCount
    };
  }

  function importedMediaStorageRoot() {
    if (typeof storageRoot !== 'string' || !storageRoot.trim()) {
      throw contractError(503, 'CONTRACT_FILE_STORAGE_UNAVAILABLE', '合同附件存储目录未配置');
    }
    return path.resolve(storageRoot);
  }

  async function stageImportedInvoiceMedia({ media, code, rowNumber, index, teamId }) {
    const originalName = `invoice-${String(code).replace(/[^A-Za-z0-9_-]/g, '_')}-${rowNumber}-${index + 1}${media.extension}`;
    const storageKey = createStorageKey({ teamId, originalName, mimeType: media.mimeType });
    const storagePath = resolveStoragePath(importedMediaStorageRoot(), storageKey);
    await fs.promises.mkdir(path.dirname(storagePath), { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(storagePath, media.buffer, { flag: 'wx', mode: 0o600 });
    return { storageKey, storagePath, originalName, mimeType: media.mimeType,
      size: media.buffer.length, sha256: crypto.createHash('sha256').update(media.buffer).digest('hex') };
  }

  async function persistImportedInvoiceMedia({ staged, context, req, teamId, record, session }) {
    const file = await createOne(FileAssetModel, {
      teamId,
      ownerType: FILE_OWNER_TYPES.SUPPLIER_PROFILE,
      ownerId: record._id,
      storageKey: staged.storageKey,
      originalName: staged.originalName,
      mimeType: staged.mimeType,
      size: staged.size,
      sha256: staged.sha256,
      uploaderId: context.userId,
      status: FILE_STATUSES.ACTIVE
    }, session);
    await auditService.record({ req, authContext: context, action: AUDIT_ACTIONS.CREATE,
      resourceType: AUDIT_RESOURCE_TYPES.FILE_ASSET, resourceId: file._id,
      after: { _id: file._id, ownerType: file.ownerType, ownerId: file.ownerId,
        originalName: file.originalName, mimeType: file.mimeType, size: file.size, status: file.status },
      targetTeamId: teamId, session });
    return {
      fileId: file._id,
      originalName: file.originalName,
      mimeType: file.mimeType,
      size: file.size,
      uploadTime: file.createdAt,
      purpose: CONTRACT_ATTACHMENT_PURPOSES.INVOICE_INFO
    };
  }

  async function stageContractPdf({ entry, teamId }) {
    const storageName = `contract-${crypto.randomUUID()}.pdf`;
    const storageKey = createStorageKey({
      teamId,
      originalName: storageName,
      mimeType: 'application/pdf'
    });
    const storagePath = resolveStoragePath(importedMediaStorageRoot(), storageKey);
    await fs.promises.mkdir(path.dirname(storagePath), { recursive: true, mode: 0o700 });
    try {
      await fs.promises.writeFile(storagePath, entry.buffer, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      await fs.promises.rm(storagePath, { force: true }).catch(() => {});
      throw error;
    }
    return {
      storageKey,
      storagePath,
      originalName: entry.name,
      mimeType: 'application/pdf',
      size: entry.buffer.length,
      sha256: crypto.createHash('sha256').update(entry.buffer).digest('hex'),
      entryName: entry.name
    };
  }

  async function removeStagedContractPdfs(stagedFiles, retainedStorageKeys = null) {
    if (!stagedFiles.length) return;
    let retained = retainedStorageKeys && new Set([...retainedStorageKeys].map(String));
    if (!retained) {
      const bound = await FileAssetModel.find({
        storageKey: { $in: stagedFiles.map(({ storageKey }) => storageKey) },
        status: FILE_STATUSES.ACTIVE
      }).select('storageKey').lean();
      retained = new Set(bound.map(({ storageKey }) => String(storageKey)));
    }
    await Promise.all(stagedFiles
      .filter(({ storageKey }) => !retained.has(String(storageKey)))
      .map(({ storagePath }) => fs.promises.rm(storagePath, { force: true })));
  }

  async function persistContractPdf({ staged, context, req, teamId, record, session }) {
    const file = await createOne(FileAssetModel, {
      teamId,
      ownerType: FILE_OWNER_TYPES.SUPPLIER_CONTRACT,
      ownerId: record._id,
      storageKey: staged.storageKey,
      originalName: staged.originalName,
      mimeType: staged.mimeType,
      size: staged.size,
      sha256: staged.sha256,
      uploaderId: context.userId,
      status: FILE_STATUSES.ACTIVE
    }, session);
    await auditService.record({
      req,
      authContext: context,
      action: AUDIT_ACTIONS.CREATE,
      resourceType: AUDIT_RESOURCE_TYPES.FILE_ASSET,
      resourceId: file._id,
      after: {
        _id: file._id,
        ownerType: file.ownerType,
        ownerId: file.ownerId,
        originalName: file.originalName,
        mimeType: file.mimeType,
        size: file.size,
        status: file.status
      },
      targetTeamId: teamId,
      session
    });
    return {
      fileId: file._id,
      originalName: file.originalName,
      mimeType: file.mimeType,
      size: file.size,
      uploadTime: file.createdAt,
      purpose: CONTRACT_ATTACHMENT_PURPOSES.CONTRACT_PDF
    };
  }

  async function importContractPdfs({ authContext, req, file }) {
    const { context, teamId } = teamForWrite(authContext, 'contract.supplier.import');
    if (!file || !Buffer.isBuffer(file.buffer)) {
      throw contractError(400, 'CONTRACT_PDF_ZIP_REQUIRED', '请选择包含PDF文件的ZIP压缩包');
    }
    if (file.buffer.length > MAX_CONTRACT_PDF_ZIP_SIZE) {
      throw contractError(413, 'CONTRACT_PDF_ZIP_TOO_LARGE', 'PDF压缩包不能超过220MB');
    }
    const entries = extractZipEntries(file.buffer);
    const [suppliers, records] = await Promise.all([
      SupplierModel.find({ teamId }).lean(),
      ContractRecordModel.find({
        teamId,
        category: {
          $in: [
            CONTRACT_RECORD_CATEGORIES.MAIN_SERVICE_AGREEMENT,
            CONTRACT_RECORD_CATEGORIES.EQUIPMENT_RENTAL
          ]
        }
      }).lean()
    ]);
    const matches = entries.map((entry) => ({
      entry,
      match: matchContractPdfEntry(entry, suppliers, records)
    }));
    const unresolved = matches.filter(({ match }) => !match.record);
    if (unresolved.length) {
      const unresolvedNames = unresolved.slice(0, 3).map(({ entry }) => entry.name).join('、');
      throw contractError(
        409,
        'CONTRACT_PDF_MATCH_FAILED',
        `部分PDF无法唯一匹配合同记录：${unresolvedNames}${unresolved.length > 3 ? '等' : ''}。请按“供应商编码__合同编号.pdf”重命名后重试`
      );
    }

    const recordIds = [...new Set(matches.map(({ match }) => String(match.record._id)))];
    const existingFiles = await FileAssetModel.find({
      teamId,
      ownerType: FILE_OWNER_TYPES.SUPPLIER_CONTRACT,
      ownerId: { $in: recordIds },
      status: FILE_STATUSES.ACTIVE
    }).lean();
    const existingByRecord = new Map();
    for (const existing of existingFiles) {
      const key = String(existing.ownerId);
      const list = existingByRecord.get(key) || [];
      list.push(existing);
      existingByRecord.set(key, list);
    }
    const toStage = [];
    const scheduledHashesByRecord = new Map();
    let skippedExisting = 0;
    for (const { entry, match } of matches) {
      const recordKey = String(match.record._id);
      const existing = existingByRecord.get(recordKey) || [];
      const scheduledHashes = scheduledHashesByRecord.get(recordKey) || new Set();
      const hash = crypto.createHash('sha256').update(entry.buffer).digest('hex');
      if (existing.some((item) => item.sha256 === hash) || scheduledHashes.has(hash)) {
        skippedExisting += 1;
        continue;
      }
      const stagedCount = toStage.filter((item) => String(item.record._id) === String(match.record._id)).length;
      if (existing.length + stagedCount >= 10) {
        throw contractError(409, 'CONTRACT_ATTACHMENT_LIMIT', `合同记录“${match.record.contractNumber || match.record._id}”附件不能超过10个`);
      }
      scheduledHashes.add(hash);
      scheduledHashesByRecord.set(recordKey, scheduledHashes);
      toStage.push({ entry, record: match.record });
    }

    const stagedFiles = [];
    try {
      for (const item of toStage) {
        item.staged = await stageContractPdf({ entry: item.entry, teamId });
        stagedFiles.push(item.staged);
      }
      const result = await runWrite(async (session) => {
        const imported = [];
        const retainedStorageKeys = [];
        let skippedExistingDuringWrite = 0;
        for (const item of toStage) {
          const record = await execute(ContractRecordModel.findOne({
            _id: item.record._id,
            teamId
          }), session);
          if (!record || !contractPdfPurposeAllowed(record)) {
            throw contractError(409, 'CONTRACT_PDF_RECORD_CHANGED', '合同记录在导入过程中发生变化，请刷新后重试');
          }
          const before = plain(record);
          const duplicate = await execute(FileAssetModel.findOne({
            teamId,
            ownerType: FILE_OWNER_TYPES.SUPPLIER_CONTRACT,
            ownerId: record._id,
            sha256: item.staged.sha256,
            status: FILE_STATUSES.ACTIVE
          }), session);
          if (duplicate) {
            skippedExistingDuringWrite += 1;
            continue;
          }
          if ((record.attachments || []).length >= 10) {
            throw contractError(409, 'CONTRACT_ATTACHMENT_LIMIT', `合同记录“${record.contractNumber || record._id}”附件不能超过10个`);
          }
          const attachment = await persistContractPdf({
            staged: item.staged,
            context,
            req,
            teamId,
            record,
            session
          });
          record.attachments.push(attachment);
          record.updatedBy = context.userId;
          await record.save({ session });
          await auditService.record({
            req,
            authContext: context,
            action: AUDIT_ACTIONS.IMPORT,
            resourceType: AUDIT_RESOURCE_TYPES.SUPPLIER_CONTRACT_RECORD,
            resourceId: record._id,
            before,
            after: plain(record),
            targetTeamId: teamId,
            session
          });
          retainedStorageKeys.push(item.staged.storageKey);
          imported.push({ fileName: item.entry.name, recordId: String(record._id) });
        }
        return { importedCount: imported.length, imported, retainedStorageKeys, skippedExistingDuringWrite };
      });
      await removeStagedContractPdfs(stagedFiles, result.retainedStorageKeys).catch(() => {});
      return {
        matchedCount: matches.length,
        importedCount: result.importedCount,
        skippedExisting: skippedExisting + result.skippedExistingDuringWrite,
        imported: result.imported
      };
    } catch (error) {
      await removeStagedContractPdfs(stagedFiles).catch(() => {});
      throw normalizePersistenceError(error);
    }
  }

  async function stagePaymentReceipt({ entry, teamId }) {
    const extension = entry.extension || path.extname(entry.name).toLocaleLowerCase('en-US');
    const storageName = `payment-${crypto.randomUUID()}${extension}`;
    const storageKey = createStorageKey({ teamId, originalName: storageName, mimeType: entry.mimeType });
    const storagePath = resolveStoragePath(importedMediaStorageRoot(), storageKey);
    await fs.promises.mkdir(path.dirname(storagePath), { recursive: true, mode: 0o700 });
    try {
      await fs.promises.writeFile(storagePath, entry.buffer, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      await fs.promises.rm(storagePath, { force: true }).catch(() => {});
      throw error;
    }
    return { storageKey, storagePath, originalName: entry.name, mimeType: entry.mimeType,
      size: entry.buffer.length, sha256: crypto.createHash('sha256').update(entry.buffer).digest('hex') };
  }

  async function persistPaymentReceipt({ staged, context, req, teamId, record, session }) {
    const file = await createOne(FileAssetModel, {
      teamId, ownerType: FILE_OWNER_TYPES.SUPPLIER_CONTRACT, ownerId: record._id,
      storageKey: staged.storageKey, originalName: staged.originalName, mimeType: staged.mimeType,
      size: staged.size, sha256: staged.sha256, uploaderId: context.userId, status: FILE_STATUSES.ACTIVE
    }, session);
    await auditService.record({ req, authContext: context, action: AUDIT_ACTIONS.CREATE,
      resourceType: AUDIT_RESOURCE_TYPES.FILE_ASSET, resourceId: file._id,
      after: { _id: file._id, ownerType: file.ownerType, ownerId: file.ownerId,
        originalName: file.originalName, mimeType: file.mimeType, size: file.size, status: file.status },
      targetTeamId: teamId, session });
    return { fileId: file._id, originalName: file.originalName, mimeType: file.mimeType,
      size: file.size, uploadTime: file.createdAt, purpose: CONTRACT_ATTACHMENT_PURPOSES.PAYMENT_RECEIPT };
  }

  async function importPaymentReceipts({ authContext, req, file }) {
    const { context, teamId } = teamForWrite(authContext, 'contract.supplier.import');
    if (!file || !Buffer.isBuffer(file.buffer)) throw contractError(400, 'CONTRACT_PAYMENT_ZIP_REQUIRED', '请选择包含打款凭证的ZIP压缩包');
    if (file.buffer.length > MAX_CONTRACT_PDF_ZIP_SIZE) throw contractError(413, 'CONTRACT_PAYMENT_ZIP_TOO_LARGE', '打款凭证压缩包不能超过220MB');
    const entries = extractPaymentReceiptEntries(file.buffer);
    const [suppliers, records] = await Promise.all([
      SupplierModel.find({ teamId }).lean(),
      ContractRecordModel.find({ teamId, category: CONTRACT_RECORD_CATEGORIES.EQUIPMENT_RENTAL }).lean()
    ]);
    const matches = entries.map((entry) => ({ entry, match: matchContractPdfEntry(
      entry, suppliers, records, (record) => record.category === CONTRACT_RECORD_CATEGORIES.EQUIPMENT_RENTAL
    ) }));
    const unresolved = matches.filter(({ match }) => !match.record);
    if (unresolved.length) {
      const names = unresolved.slice(0, 3).map(({ entry }) => entry.name).join('、');
      throw contractError(409, 'CONTRACT_PAYMENT_MATCH_FAILED', `部分打款凭证无法唯一匹配器具租赁记录：${names}${unresolved.length > 3 ? '等' : ''}。请按“供应商编码__合同编号.扩展名”重命名后重试`);
    }
    const recordIds = [...new Set(matches.map(({ match }) => String(match.record._id)))];
    const existingFiles = await FileAssetModel.find({ teamId, ownerType: FILE_OWNER_TYPES.SUPPLIER_CONTRACT,
      ownerId: { $in: recordIds }, status: FILE_STATUSES.ACTIVE }).lean();
    const existingByRecord = new Map();
    for (const existing of existingFiles) {
      const key = String(existing.ownerId); const list = existingByRecord.get(key) || [];
      list.push(existing); existingByRecord.set(key, list);
    }
    const toStage = []; const scheduled = new Map(); let skippedExisting = 0;
    for (const { entry, match } of matches) {
      const key = String(match.record._id); const existing = existingByRecord.get(key) || [];
      const hashes = scheduled.get(key) || new Set();
      const hash = crypto.createHash('sha256').update(entry.buffer).digest('hex');
      if (existing.some((item) => item.sha256 === hash) || hashes.has(hash)) { skippedExisting += 1; continue; }
      const stagedCount = toStage.filter((item) => String(item.record._id) === key).length;
      if (existing.length + stagedCount >= 10) throw contractError(409, 'CONTRACT_ATTACHMENT_LIMIT', `合同记录“${match.record.contractNumber || match.record._id}”附件不能超过10个`);
      hashes.add(hash); scheduled.set(key, hashes); toStage.push({ entry, record: match.record });
    }
    const stagedFiles = [];
    try {
      for (const item of toStage) { item.staged = await stagePaymentReceipt({ entry: item.entry, teamId }); stagedFiles.push(item.staged); }
      const result = await runWrite(async (session) => {
        const imported = []; const retainedStorageKeys = []; let skippedExistingDuringWrite = 0;
        for (const item of toStage) {
          const record = await execute(ContractRecordModel.findOne({ _id: item.record._id, teamId }), session);
          if (!record || record.category !== CONTRACT_RECORD_CATEGORIES.EQUIPMENT_RENTAL) throw contractError(409, 'CONTRACT_PAYMENT_RECORD_CHANGED', '器具租赁记录在导入过程中发生变化，请刷新后重试');
          const duplicate = await execute(FileAssetModel.findOne({ teamId, ownerType: FILE_OWNER_TYPES.SUPPLIER_CONTRACT, ownerId: record._id, sha256: item.staged.sha256, status: FILE_STATUSES.ACTIVE }), session);
          if (duplicate) { skippedExistingDuringWrite += 1; continue; }
          if ((record.attachments || []).length >= 10) throw contractError(409, 'CONTRACT_ATTACHMENT_LIMIT', `合同记录“${record.contractNumber || record._id}”附件不能超过10个`);
          const before = plain(record);
          record.attachments.push(await persistPaymentReceipt({ staged: item.staged, context, req, teamId, record, session }));
          record.updatedBy = context.userId; await record.save({ session });
          await auditService.record({ req, authContext: context, action: AUDIT_ACTIONS.IMPORT, resourceType: AUDIT_RESOURCE_TYPES.SUPPLIER_CONTRACT_RECORD, resourceId: record._id, before, after: plain(record), targetTeamId: teamId, session });
          retainedStorageKeys.push(item.staged.storageKey); imported.push({ fileName: item.entry.name, recordId: String(record._id) });
        }
        return { importedCount: imported.length, imported, retainedStorageKeys, skippedExistingDuringWrite };
      });
      await removeStagedContractPdfs(stagedFiles, result.retainedStorageKeys).catch(() => {});
      return { matchedCount: matches.length, importedCount: result.importedCount, skippedExisting: skippedExisting + result.skippedExistingDuringWrite, imported: result.imported };
    } catch (error) { await removeStagedContractPdfs(stagedFiles).catch(() => {}); throw normalizePersistenceError(error); }
  }

  async function importSuppliers({ authContext, req, file, supplierId = null }) {
    const { context, teamId } = teamForWrite(authContext, 'contract.supplier.import');
    if (!file || !Buffer.isBuffer(file.buffer)) throw contractError(400, 'CONTRACT_IMPORT_FILE_REQUIRED', '请选择合同Excel文件');
    if (file.buffer.length > MAX_IMPORT_FILE_SIZE) throw contractError(413, 'CONTRACT_IMPORT_FILE_TOO_LARGE', '合同Excel文件不能超过20MB');
    const parsed = parseSupplierWorkbook(file.buffer);
    let targetSupplier = null;
    if (supplierId) {
      targetSupplier = await SupplierModel.findOne({ _id: normalizeId(supplierId, '供应商'), teamId }).lean();
      if (!targetSupplier) throw contractError(404, 'CONTRACT_SUPPLIER_NOT_FOUND', '供应商不存在');
      if (parsed.suppliers.some((supplier) => supplier.code !== targetSupplier.code)) {
        throw contractError(409, 'CONTRACT_IMPORT_SUPPLIER_MISMATCH', '导入文件中的供应商编码与当前供应商不一致');
      }
    }

    const dummySupplierIds = new Map(parsed.suppliers.map((supplier) => [supplier.code, new mongoose.Types.ObjectId()]));
    for (const supplier of parsed.suppliers) {
      await new SupplierModel({ teamId, name: supplier.name, code: supplier.code,
        trusteeAttribute: supplier.trusteeAttribute, createdBy: context.userId, updatedBy: context.userId }).validate();
    }
    for (const row of parsed.rows) {
      for (const record of row.records) {
        await new ContractRecordModel({ teamId, supplierId: dummySupplierIds.get(row.supplierCode),
          category: record.category, signingStatus: record.signingStatus,
          contractNumber: record.contractNumber, effectiveDate: record.effectiveDate,
          expiryDate: record.expiryDate, autoRenew: record.autoRenew,
          details: record.details, attachments: [],
          createdBy: context.userId, updatedBy: context.userId }).validate();
      }
    }

    const stagedByMedia = new Map();
    const stagedFiles = [];
    try {
      for (const row of parsed.rows) {
        for (const record of row.records) {
          for (const [index, media] of (record.importedMedia || []).entries()) {
            const staged = await stageImportedInvoiceMedia({ media, code: row.supplierCode,
              rowNumber: row.rowNumber, index, teamId });
            stagedByMedia.set(media, staged);
            stagedFiles.push(staged);
          }
        }
      }
      const result = await runWrite(async (session) => {
        const supplierByCode = new Map();
        let createdSuppliers = 0;
        let updatedSuppliers = 0;
        for (const input of parsed.suppliers) {
          let supplier = await lockSupplierForMutation({
            teamId,
            filter: { code: input.code },
            context,
            session
          });
          if (supplier) {
            const before = plain(supplier);
            supplier.name = input.name;
            supplier.trusteeAttribute = input.trusteeAttribute;
            supplier.updatedBy = context.userId;
            await supplier.save({ session });
            updatedSuppliers += 1;
            await auditService.record({ req, authContext: context, action: AUDIT_ACTIONS.UPDATE,
              resourceType: AUDIT_RESOURCE_TYPES.SUPPLIER, resourceId: supplier._id,
              before, after: plain(supplier), targetTeamId: teamId, session });
          } else {
            supplier = await createOne(SupplierModel, { teamId, name: input.name, code: input.code,
              trusteeAttribute: input.trusteeAttribute, createdBy: context.userId, updatedBy: context.userId }, session);
            createdSuppliers += 1;
            await auditService.record({ req, authContext: context, action: AUDIT_ACTIONS.CREATE,
              resourceType: AUDIT_RESOURCE_TYPES.SUPPLIER, resourceId: supplier._id,
              after: plain(supplier), targetTeamId: teamId, session });
          }
          supplierByCode.set(input.code, supplier);
        }

        let createdRecords = 0;
        let importedImages = 0;
        for (const row of parsed.rows) {
          const supplier = supplierByCode.get(row.supplierCode);
          for (const input of row.records) {
            const record = await createOne(ContractRecordModel, {
              teamId, supplierId: supplier._id, category: input.category,
              signingStatus: input.signingStatus, contractNumber: input.contractNumber,
              effectiveDate: input.effectiveDate, expiryDate: input.expiryDate,
              autoRenew: input.autoRenew, details: input.details, attachments: [],
              createdBy: context.userId, updatedBy: context.userId
            }, session);
            for (const [index, media] of (input.importedMedia || []).entries()) {
              record.attachments.push(await persistImportedInvoiceMedia({
                staged: stagedByMedia.get(media), context, req, teamId, record, session
              }));
              importedImages += 1;
            }
            await record.save({ session });
            createdRecords += 1;
            await auditService.record({ req, authContext: context, action: AUDIT_ACTIONS.IMPORT,
              resourceType: AUDIT_RESOURCE_TYPES.SUPPLIER_CONTRACT_RECORD, resourceId: record._id,
              after: plain(record), targetTeamId: teamId, session });
          }
        }
        return { createdSuppliers, updatedSuppliers, createdRecords, importedImages,
          mediaSummary: parsed.mediaSummary };
      });
      return result;
    } catch (error) {
      await Promise.all(stagedFiles.map(async (staged) => {
        const bound = await FileAssetModel.exists({ storageKey: staged.storageKey, status: FILE_STATUSES.ACTIVE }).catch(() => null);
        if (!bound) await fs.promises.rm(staged.storagePath, { force: true }).catch(() => {});
      }));
      throw normalizePersistenceError(error);
    }
  }

  async function buildExpiryAlerts({ authContext, requestedTeamId, query = {}, permissionKey = 'contract.expiry.view' }) {
    const teamId = await teamForRead(authContext, requestedTeamId, permissionKey);
    const supplierFilter = { teamId };
    if (query.supplierCode) supplierFilter.code = requiredText(query.supplierCode, '供应商编码', 100);
    if (query.supplierName) supplierFilter.name = { $regex: escapeRegex(requiredText(query.supplierName, '供应商名称')), $options: 'i' };
    const suppliers = await SupplierModel.find(supplierFilter).lean();
    const supplierById = new Map(suppliers.map((supplier) => [String(supplier._id), supplier]));
    const autoRenew = queryBoolean(query.autoRenew, '是否顺延');
    const recordFilter = {
      teamId,
      supplierId: { $in: suppliers.map((supplier) => supplier._id) },
      category: { $in: CONTRACT_CATEGORIES },
      signingStatus: CONTRACT_SIGNING_STATUSES.SIGNED,
      effectiveDate: { $ne: null },
      expiryDate: { $ne: null }
    };
    if (autoRenew !== null) recordFilter.autoRenew = autoRenew;
    const records = suppliers.length ? await ContractRecordModel.find(recordFilter).lean() : [];
    const today = todayShanghai(now());
    const gt = queryInteger(query.remainingDaysGt, '有效期大于');
    const lt = queryInteger(query.remainingDaysLt, '有效期小于');
    const alerts = records.map((record) => {
      const supplier = supplierById.get(String(record.supplierId));
      const remainingDays = Math.round((new Date(record.expiryDate).getTime() - today.getTime()) / DAY_MS);
      return {
        _id: record._id,
        recordId: record._id,
        supplierId: record.supplierId,
        supplierName: supplier.name,
        supplierCode: supplier.code,
        category: record.category,
        signingStatus: record.signingStatus,
        contractNumber: record.contractNumber,
        effectiveDate: record.effectiveDate,
        expiryDate: record.expiryDate,
        remainingDays,
        autoRenew: record.autoRenew,
        alertLevel: record.autoRenew ? 'NORMAL' : remainingDays < 0 ? 'EXPIRED' : remainingDays <= 30 ? 'WARNING' : 'NORMAL'
      };
    }).filter((item) => (gt === null || item.remainingDays > gt) && (lt === null || item.remainingDays < lt))
      .sort((left, right) => left.remainingDays - right.remainingDays || left.supplierCode.localeCompare(right.supplierCode));
    return { teamId, alerts };
  }

  async function listExpiryAlerts(input) {
    const { alerts } = await buildExpiryAlerts(input);
    const { page, pageSize } = pagination(input.query || {});
    return { alerts: alerts.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total: alerts.length };
  }

  async function expiryExport({ authContext, req, requestedTeamId, query = {} }) {
    const { teamId, alerts } = await buildExpiryAlerts({ authContext, requestedTeamId, query,
      permissionKey: 'contract.expiry.export' });
    const buffer = await createExpiryExportWorkbook(alerts);
    await auditService.record({ req, authContext, action: AUDIT_ACTIONS.EXPORT,
      resourceType: AUDIT_RESOURCE_TYPES.SUPPLIER_CONTRACT_RECORD,
      after: { alertCount: alerts.length }, targetTeamId: teamId });
    return { buffer, count: alerts.length };
  }

  function amount(value, field, fallback = 0) {
    const resolved = value === undefined || value === null || value === '' ? fallback : Number(value);
    if (!Number.isFinite(resolved) || resolved < 0) throw contractError(400, 'CONTRACT_SETTLEMENT_AMOUNT_INVALID', `${field}必须是非负金额`);
    return resolved;
  }

  async function resolveSettlementSupplier({
    teamId,
    input,
    current = null,
    session = null,
    context = null,
    lock = false,
    requireTertiary = false
  }) {
    let filter;
    if (input.supplierId) filter = { _id: normalizeId(input.supplierId, '供应商'), teamId };
    else if (input.supplierCode) filter = { code: requiredText(input.supplierCode, '供应商编码', 100), teamId };
    else if (current) filter = { _id: current.supplierId, teamId };
    else throw contractError(400, 'CONTRACT_SETTLEMENT_SUPPLIER_REQUIRED', '请选择供应商');
    const supplier = lock
      ? await lockSupplierForMutation({ teamId, filter, context, session })
      : await execute(SupplierModel.findOne(filter), session);
    if (!supplier) throw contractError(404, 'CONTRACT_SUPPLIER_NOT_FOUND', '供应商不存在');
    if (requireTertiary && !await execute(ContractRecordModel.exists({
      teamId,
      supplierId: supplier._id
    }), session)) {
      throw contractError(409, 'CONTRACT_SUPPLIER_TERTIARY_RECORD_REQUIRED', '供应商必须先通过三级明细创建');
    }
    if (current && String(current.supplierId) !== String(supplier._id)) {
      throw contractError(400, 'CONTRACT_SETTLEMENT_SUPPLIER_IMMUTABLE', '结算记录创建后不能更换供应商');
    }
    return supplier;
  }

  function normalizeSettlementValues(input, current = null) {
    assertNoFields(input, ['teamId', 'supplierName', 'hasSignedContract', 'contractValid']);
    const allowed = new Set(['supplierId', 'supplierCode', 'month', 'productLaunchAmount',
      'warehousingLogisticsFee', 'overstorageProductAmount', 'overstorageLogisticsFee', 'remarks']);
    if (Object.keys(input || {}).some((key) => !allowed.has(key))) throw contractError(400, 'CONTRACT_INPUT_INVALID', '结算记录包含不支持的字段');
    let month;
    try { month = parseMonth(input.month === undefined ? current?.month : input.month); }
    catch { throw contractError(400, 'CONTRACT_SETTLEMENT_MONTH_INVALID', '月份格式必须是YYYY-MM'); }
    return {
      month,
      productLaunchAmount: amount(input.productLaunchAmount, '产品上线金额', current?.productLaunchAmount || 0),
      warehousingLogisticsFee: amount(input.warehousingLogisticsFee, '仓储物流费', current?.warehousingLogisticsFee || 0),
      overstorageProductAmount: amount(input.overstorageProductAmount, '超储产品金额', current?.overstorageProductAmount || 0),
      overstorageLogisticsFee: amount(input.overstorageLogisticsFee, '超储物流费', current?.overstorageLogisticsFee || 0),
      remarks: optionalText(input.remarks === undefined ? current?.remarks : input.remarks, '备注')
    };
  }

  async function settlementRows({ authContext, requestedTeamId, query = {}, permissionKey = 'contract.settlement.view' }) {
    const teamId = await teamForRead(authContext, requestedTeamId, permissionKey);
    const filter = { teamId };
    if (query.month && (query.startMonth || query.endMonth)) {
      throw contractError(
        400,
        'CONTRACT_SETTLEMENT_MONTH_FILTER_CONFLICT',
        '单月筛选不能与月份区间同时使用'
      );
    }
    let startMonth;
    let endMonth;
    try {
      startMonth = query.startMonth ? parseMonth(query.startMonth) : null;
      endMonth = query.endMonth ? parseMonth(query.endMonth) : null;
    } catch {
      throw contractError(400, 'CONTRACT_SETTLEMENT_MONTH_INVALID', '月份格式必须是YYYY-MM');
    }
    if (startMonth && endMonth && startMonth > endMonth) {
      throw contractError(400, 'CONTRACT_SETTLEMENT_MONTH_RANGE_INVALID', '开始月份不能晚于结束月份');
    }
    if (query.month) {
      try { filter.month = parseMonth(query.month); }
      catch { throw contractError(400, 'CONTRACT_SETTLEMENT_MONTH_INVALID', '月份格式必须是YYYY-MM'); }
    } else if (startMonth || endMonth) {
      filter.month = {
        ...(startMonth ? { $gte: startMonth } : {}),
        ...(endMonth ? { $lte: endMonth } : {})
      };
    }
    if (query.supplierCode) filter.supplierCode = requiredText(query.supplierCode, '供应商编码', 100);
    if (query.supplierName) filter.supplierName = { $regex: escapeRegex(requiredText(query.supplierName, '供应商名称')), $options: 'i' };
    const settlements = await SettlementModel.find(filter).sort({ month: -1, supplierName: 1, supplierCode: 1, _id: 1 }).lean();
    const latest = await latestMainBySupplier(teamId, [...new Set(settlements.map((item) => String(item.supplierId)))]);
    const today = todayShanghai(now());
    const rows = settlements.map((item) => ({ ...item,
      ...derivedContractState(latest.get(String(item.supplierId)), today) }));
    const hasSigned = queryBoolean(query.hasSignedContract, '是否签订合同');
    const valid = queryBoolean(query.contractValid, '合同是否有效');
    return { teamId, rows: rows.filter((item) =>
      (hasSigned === null || item.hasSignedContract === hasSigned) &&
      (valid === null || item.contractValid === valid)) };
  }

  async function listSettlements(input) {
    const { rows } = await settlementRows(input);
    const { page, pageSize } = pagination(input.query || {});
    const totals = rows.reduce((result, item) => ({
      productLaunchAmount: result.productLaunchAmount + item.productLaunchAmount,
      warehousingLogisticsFee: result.warehousingLogisticsFee + item.warehousingLogisticsFee,
      overstorageProductAmount: result.overstorageProductAmount + item.overstorageProductAmount,
      overstorageLogisticsFee: result.overstorageLogisticsFee + item.overstorageLogisticsFee
    }), { productLaunchAmount: 0, warehousingLogisticsFee: 0,
      overstorageProductAmount: 0, overstorageLogisticsFee: 0 });
    return { settlements: rows.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total: rows.length, totals };
  }

  async function getSettlement({ authContext, requestedTeamId, settlementId }) {
    const teamId = await teamForRead(authContext, requestedTeamId, 'contract.settlement.view');
    const settlement = await SettlementModel.findOne({ _id: normalizeId(settlementId, '结算记录'), teamId }).lean();
    if (!settlement) throw contractError(404, 'CONTRACT_SETTLEMENT_NOT_FOUND', '结算记录不存在');
    const latest = await latestMainBySupplier(teamId, [settlement.supplierId]);
    return { ...settlement, ...derivedContractState(latest.get(String(settlement.supplierId)), todayShanghai(now())) };
  }

  async function createSettlement({ authContext, req, input }) {
    const { context, teamId } = teamForWrite(authContext, 'contract.settlement.manage');
    const values = normalizeSettlementValues(input);
    try {
      return await runWrite(async (session) => {
        const supplier = await resolveSettlementSupplier({
          teamId,
          input,
          session,
          context,
          lock: true,
          requireTertiary: true
        });
        const settlement = await createOne(SettlementModel, { teamId, supplierId: supplier._id,
          supplierName: supplier.name, supplierCode: supplier.code, ...values,
          createdBy: context.userId, updatedBy: context.userId }, session);
        await auditService.record({ req, authContext: context, action: AUDIT_ACTIONS.CREATE,
          resourceType: AUDIT_RESOURCE_TYPES.SUPPLIER_SETTLEMENT_FEE, resourceId: settlement._id,
          after: plain(settlement), targetTeamId: teamId, session });
        const latest = await latestMainBySupplier(teamId, [supplier._id]);
        return { ...plain(settlement), ...derivedContractState(latest.get(String(supplier._id)), todayShanghai(now())) };
      });
    } catch (error) { throw normalizePersistenceError(error); }
  }

  async function updateSettlement({ authContext, req, settlementId, input }) {
    const { context, teamId } = teamForWrite(authContext, 'contract.settlement.manage');
    try {
      return await runWrite(async (session) => {
        const settlement = await execute(SettlementModel.findOne({ _id: normalizeId(settlementId, '结算记录'), teamId }), session);
        if (!settlement) throw contractError(404, 'CONTRACT_SETTLEMENT_NOT_FOUND', '结算记录不存在');
        const before = plain(settlement);
        const supplier = await resolveSettlementSupplier({
          teamId,
          input,
          current: before,
          session,
          context,
          lock: true
        });
        Object.assign(settlement, normalizeSettlementValues(input, before), {
          supplierName: supplier.name, supplierCode: supplier.code, updatedBy: context.userId
        });
        await settlement.save({ session });
        await auditService.record({ req, authContext: context, action: AUDIT_ACTIONS.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPES.SUPPLIER_SETTLEMENT_FEE, resourceId: settlement._id,
          before, after: plain(settlement), targetTeamId: teamId, session });
        const latest = await latestMainBySupplier(teamId, [supplier._id]);
        return { ...plain(settlement), ...derivedContractState(latest.get(String(supplier._id)), todayShanghai(now())) };
      });
    } catch (error) { throw normalizePersistenceError(error); }
  }

  async function deleteSettlement({ authContext, req, settlementId }) {
    const { context, teamId } = teamForWrite(authContext, 'contract.settlement.manage');
    try {
      return await runWrite(async (session) => {
        const settlement = await execute(SettlementModel.findOne({ _id: normalizeId(settlementId, '结算记录'), teamId }), session);
        if (!settlement) throw contractError(404, 'CONTRACT_SETTLEMENT_NOT_FOUND', '结算记录不存在');
        const before = plain(settlement);
        await settlement.deleteOne({ session });
        await auditService.record({ req, authContext: context, action: AUDIT_ACTIONS.DELETE,
          resourceType: AUDIT_RESOURCE_TYPES.SUPPLIER_SETTLEMENT_FEE, resourceId: settlement._id,
          before, targetTeamId: teamId, session });
        return before;
      });
    } catch (error) { throw normalizePersistenceError(error); }
  }

  async function importSettlements({ authContext, req, file }) {
    const { context, teamId } = teamForWrite(authContext, 'contract.settlement.import');
    if (!file || !Buffer.isBuffer(file.buffer)) throw contractError(400, 'CONTRACT_IMPORT_FILE_REQUIRED', '请选择结算Excel文件');
    if (file.buffer.length > MAX_IMPORT_FILE_SIZE) throw contractError(413, 'CONTRACT_IMPORT_FILE_TOO_LARGE', '结算Excel文件不能超过20MB');
    const rows = parseSettlementWorkbook(file.buffer);
    const codes = [...new Set(rows.map((row) => row.supplierCode))];
    const suppliers = await SupplierModel.find({ teamId, code: { $in: codes } }).lean();
    const supplierByCode = new Map(suppliers.map((supplier) => [supplier.code, supplier]));
    for (const row of rows) {
      const supplier = supplierByCode.get(row.supplierCode);
      if (!supplier) throw contractError(400, 'CONTRACT_SETTLEMENT_SUPPLIER_NOT_FOUND', `结算表第${row.rowNumber}行供应商编码不存在`);
      if (supplier.name !== row.supplierName) throw contractError(409, 'CONTRACT_SETTLEMENT_SUPPLIER_MISMATCH', `结算表第${row.rowNumber}行供应商名称与编码不匹配`);
      await new SettlementModel({ teamId, supplierId: supplier._id,
        month: row.month, supplierName: supplier.name, supplierCode: supplier.code,
        productLaunchAmount: row.productLaunchAmount,
        warehousingLogisticsFee: row.warehousingLogisticsFee,
        overstorageProductAmount: row.overstorageProductAmount,
        overstorageLogisticsFee: row.overstorageLogisticsFee,
        remarks: row.remarks, createdBy: context.userId, updatedBy: context.userId }).validate();
    }
    try {
      return await runWrite(async (session) => {
        const lockedByCode = new Map();
        for (const code of [...codes].sort()) {
          const supplier = await lockSupplierForMutation({
            teamId,
            filter: { code },
            context,
            session
          });
          if (supplier) lockedByCode.set(supplier.code, supplier);
        }
        for (const row of rows) {
          const supplier = lockedByCode.get(row.supplierCode);
          if (!supplier) throw contractError(400, 'CONTRACT_SETTLEMENT_SUPPLIER_NOT_FOUND', `结算表第${row.rowNumber}行供应商编码不存在`);
          if (supplier.name !== row.supplierName) throw contractError(409, 'CONTRACT_SETTLEMENT_SUPPLIER_MISMATCH', `结算表第${row.rowNumber}行供应商名称与编码不匹配`);
          if (!await execute(ContractRecordModel.exists({ teamId, supplierId: supplier._id }), session)) {
            throw contractError(409, 'CONTRACT_SUPPLIER_TERTIARY_RECORD_REQUIRED', `结算表第${row.rowNumber}行供应商没有三级明细`);
          }
        }
        const created = [];
        for (const row of rows) {
          const supplier = lockedByCode.get(row.supplierCode);
          const settlement = await createOne(SettlementModel, { teamId, supplierId: supplier._id,
            month: row.month, supplierName: supplier.name, supplierCode: supplier.code,
            productLaunchAmount: row.productLaunchAmount,
            warehousingLogisticsFee: row.warehousingLogisticsFee,
            overstorageProductAmount: row.overstorageProductAmount,
            overstorageLogisticsFee: row.overstorageLogisticsFee,
            remarks: row.remarks, createdBy: context.userId, updatedBy: context.userId }, session);
          created.push(settlement);
          await auditService.record({ req, authContext: context, action: AUDIT_ACTIONS.IMPORT,
            resourceType: AUDIT_RESOURCE_TYPES.SUPPLIER_SETTLEMENT_FEE, resourceId: settlement._id,
            after: plain(settlement), targetTeamId: teamId, session });
        }
        return { importedCount: created.length };
      });
    } catch (error) { throw normalizePersistenceError(error); }
  }

  async function settlementExport({ authContext, req, requestedTeamId, query = {} }) {
    const { teamId, rows } = await settlementRows({ authContext, requestedTeamId, query,
      permissionKey: 'contract.settlement.export' });
    const buffer = await createSettlementExportWorkbook(rows);
    await auditService.record({ req, authContext, action: AUDIT_ACTIONS.EXPORT,
      resourceType: AUDIT_RESOURCE_TYPES.SUPPLIER_SETTLEMENT_FEE,
      after: { count: rows.length }, targetTeamId: teamId });
    return { buffer, count: rows.length };
  }

  return Object.freeze({
    createFirstRecord,
    createRecord,
    createSettlement,
    deleteRecord,
    deleteSettlement,
    expiryExport,
    getRecord,
    getSettlement,
    getSupplier,
    importContractPdfs,
    importPaymentReceipts,
    importSettlements,
    importSuppliers,
    listExpiryAlerts,
    listRecords,
    listSettlements,
    listSuppliers,
    settlementExport,
    supplierExport,
    updateRecord,
    updateSettlement,
    updateSupplier
  });
}

module.exports = {
  ContractManagementError,
  EXCEL_MIME_TYPE,
  MAX_CONTRACT_PDF_ZIP_SIZE,
  MAX_IMPORT_FILE_SIZE,
  createContractManagementService,
  derivedContractState,
  normalizeAttachmentInput,
  normalizeRecordInput,
  normalizeSupplierInput,
  todayShanghai
};
