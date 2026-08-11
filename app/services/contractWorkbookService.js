'use strict';

const ExcelJS = require('exceljs');
const XLSX = require('xlsx');
const { extractEquipmentWorkbookMedia } = require('./equipmentWorkbookMediaExtractor');

const DETAIL_SHEET_NAME = '三级细表（供应商合同管理）';
const SUPPLIER_SHEET_NAME = '主表（供应商合同管理）';
const ATTACHMENT_SHEET_NAME = '附件清单（不可回导）';
const SETTLEMENT_SHEET_NAME = '供应商结算费用表';

const DETAIL_HEADERS = Object.freeze([
  '序号', '供应商编码', '供应商名称', '托管属性', '供方供货情况（正常供货/已停供）', '是否已有开票信息',
  '开票信息（支持文字或上传图片或PDF）', '厂家联系人（支持增加多人）', '联系电话（支持增加多人）', '对账邮箱', '未签合同原因批注（批注文字）', '备注（批注文字）',
  '供应商物流服务协议', '合同编号', '合同生效日期', '合同截止日期',
  '供应商签署合同日期', '载信签署合同日期', '载信给供应商回寄合同的日期',
  '载信给供应商回寄合同的快递单号', '合同交付给载信商务部的日期',
  '合同交付给济南变速箱厂的日期', '合同PDF（上传）', '合同是否自动顺延',
  '物流服务费用及支付方式协定', '合同生效日期', '合同截止日期',
  '仓储服务费率', '超储服务费率', '超储天数（无超储/30+15/60+15/90+15）', '结算周期', '备注',
  '周转器具服务协议', '合同编号', '合同生效日期', '合同截止日期',
  '器具类型', '器具服务价格\n（元/个/次）', '供应商签署合同日期', '载信签署合同日期',
  '载信给供应商回寄合同的日期', '载信给供应商回寄合同的快递单号',
  '合同交付给载信商务部的日期', '合同交付给济南变速箱厂的日期', '备注',
  '器具租赁合同签订', '合同编号', '合同生效日期', '合同截止日期',
  '租赁器具类型', '租赁器具规格', '租赁器具生产批次', '租赁器具颜色',
  '租赁数量', '合同PDF（上传）', '打款凭证（上传）', '备注'
]);

const SUPPLIER_HEADERS = Object.freeze([
  '序号', '供应商名称', '供应商编码', '托管属性', '是否签订合同', '合同是否有效'
]);

const SETTLEMENT_HEADERS = Object.freeze([
  '序号', '月份', '供应商名称', '供应商编码', '产品上线金额（含税）',
  '仓储物流费（元）', '超储产品金额（含税）', '超储物流费（元）',
  '是否签订合同', '合同是否有效', '备注'
]);

const CATEGORY_LABELS = Object.freeze({
  MAIN_SERVICE_AGREEMENT: '主合同签订情况',
  LOGISTICS_FEE_AGREEMENT: '物流服务费用及支付方式协定',
  TURNOVER_EQUIPMENT_SERVICE: '周转器具服务协议',
  EQUIPMENT_RENTAL: '器具租赁'
});

const ALERT_LEVEL_LABELS = Object.freeze({
  NORMAL: '正常',
  WARNING: '30天内到期',
  EXPIRED: '已过期'
});

class ContractWorkbookError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.name = 'ContractWorkbookError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = true;
  }
}

function workbookError(code, message, details = null) {
  return new ContractWorkbookError(400, code, message, details);
}

function formulaSafe(value) {
  return typeof value === 'string' && /^[=+\-@]/.test(value) ? `'${value}` : value;
}

function text(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function splitMulti(value) {
  return text(value).split(/[\n\r,，;；、/]+/).map((item) => item.trim()).filter(Boolean);
}

function parseBoolean(value, { nullable = false } = {}) {
  const normalized = text(value).toLowerCase();
  if (!normalized && nullable) return null;
  if (['是', '有', 'true', 'yes', 'y', '1', '自动顺延'].includes(normalized)) return true;
  if (['否', '无', 'false', 'no', 'n', '0', '不顺延'].includes(normalized) || !normalized) return false;
  throw workbookError('CONTRACT_IMPORT_BOOLEAN_INVALID', `无法识别布尔值：${text(value)}`);
}

function parseSigningStatus(value) {
  const normalized = text(value);
  if (!normalized) return null;
  if (/已签|签订$|^是$/.test(normalized) && !/未签|未订/.test(normalized)) return 'SIGNED';
  if (/未签|未订|^否$/.test(normalized)) return 'UNSIGNED';
  throw workbookError('CONTRACT_IMPORT_SIGNING_STATUS_INVALID', `无法识别合同签订状态：${normalized}`);
}

function parseTrusteeAttribute(value) {
  const normalized = text(value);
  if (/非托/.test(normalized)) return 'NON_HOSTED';
  if (/托管|^托$/.test(normalized)) return 'HOSTED';
  if (!normalized) return null;
  throw workbookError('CONTRACT_IMPORT_TRUSTEE_INVALID', `无法识别托管属性：${normalized}`);
}

function parseSupplyStatus(value) {
  const normalized = text(value);
  if (!normalized) return null;
  if (/停供/.test(normalized)) return 'STOPPED';
  if (/正常/.test(normalized)) return 'NORMAL';
  throw workbookError('CONTRACT_IMPORT_SUPPLY_STATUS_INVALID', `无法识别供货状态：${normalized}`);
}

function parseOverstorageDays(value) {
  const normalized = text(value).replace('无超期', '无超储');
  if (!normalized) return null;
  if (/无超储|^无$/.test(normalized)) return 'NONE';
  if (normalized.includes('30+15')) return '30+15';
  if (normalized.includes('60+15')) return '60+15';
  if (normalized.includes('90+15')) return '90+15';
  throw workbookError('CONTRACT_IMPORT_OVERSTORAGE_DAYS_INVALID', `无法识别超储天数：${normalized}`);
}

function dateOnlyFromParts(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return null;
  return date;
}

function parseDateOnly(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return dateOnlyFromParts(value.getFullYear(), value.getMonth() + 1, value.getDate());
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = XLSX.SSF.parse_date_code(value);
    return parsed ? dateOnlyFromParts(parsed.y, parsed.m, parsed.d) : null;
  }
  const normalized = text(value);
  const match = /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})(?:\s.*)?$/.exec(normalized);
  if (!match) throw workbookError('CONTRACT_IMPORT_DATE_INVALID', `无法识别日期：${normalized}`);
  const date = dateOnlyFromParts(Number(match[1]), Number(match[2]), Number(match[3]));
  if (!date) throw workbookError('CONTRACT_IMPORT_DATE_INVALID', `无效日期：${normalized}`);
  return date;
}

function parseMonth(value) {
  if (value === null || value === undefined || value === '') return '';
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}`;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (!parsed) throw workbookError('CONTRACT_SETTLEMENT_MONTH_INVALID', `无法识别月份：${value}`);
    return `${parsed.y}-${String(parsed.m).padStart(2, '0')}`;
  }
  const normalized = text(value);
  const match = /^(\d{4})[./-](\d{1,2})(?:[./-]\d{1,2})?$/.exec(normalized);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) {
    throw workbookError('CONTRACT_SETTLEMENT_MONTH_INVALID', `无法识别月份：${normalized}`);
  }
  return `${match[1]}-${String(Number(match[2])).padStart(2, '0')}`;
}

function parseAmount(value, field) {
  if (value === null || value === undefined || text(value) === '') return 0;
  const normalized = typeof value === 'number'
    ? value
    : Number(text(value).replace(/[,，￥¥\s]/g, ''));
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw workbookError('CONTRACT_SETTLEMENT_AMOUNT_INVALID', `${field}必须是非负金额`);
  }
  return normalized;
}

function cellValue(sheet, rowIndex, columnIndex, { formatted = true } = {}) {
  const cell = sheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })];
  if (!cell) return '';
  if (!formatted) return cell.v;
  if (cell.w !== undefined) return cell.w;
  return cell.v;
}

function assertHeader(
  sheet,
  rowIndex,
  columnIndex,
  expected,
  label,
  errorCode = 'CONTRACT_IMPORT_TEMPLATE_INVALID'
) {
  const actual = text(cellValue(sheet, rowIndex, columnIndex));
  if (actual !== expected) {
    throw workbookError(
      errorCode,
      `${label}表头不匹配：第${rowIndex + 1}行第${columnIndex + 1}列应为“${expected}”`
    );
  }
}

function rowHasAny(values) {
  return values.some((value) => value !== null && value !== undefined && text(value) !== '');
}

function contactsFromColumns(namesValue, phonesValue) {
  const names = splitMulti(namesValue);
  const phones = splitMulti(phonesValue);
  const count = Math.max(names.length, phones.length);
  return Array.from({ length: count }, (_, index) => ({
    name: names[index] || '',
    phone: phones[index] || ''
  })).filter(({ name, phone }) => name || phone);
}

function normalizeInvoiceText(value) {
  const normalized = text(value);
  return /DISPIMG\s*\(/i.test(normalized) ? '' : normalized;
}

function parseSupplierWorkbook(buffer, { extractWorkbookMedia = extractEquipmentWorkbookMedia } = {}) {
  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true, cellFormula: true });
  } catch (error) {
    throw workbookError('CONTRACT_IMPORT_WORKBOOK_INVALID', `无法读取Excel文件：${error.message}`);
  }
  const detailSheet = workbook.Sheets[DETAIL_SHEET_NAME];
  if (!detailSheet) {
    throw workbookError(
      'CONTRACT_IMPORT_TEMPLATE_INVALID',
      `Excel必须包含“${DETAIL_SHEET_NAME}”工作表`
    );
  }
  DETAIL_HEADERS.forEach((expected, columnIndex) => (
    assertHeader(detailSheet, 1, columnIndex, expected, DETAIL_SHEET_NAME)
  ));

  let extracted;
  try {
    extracted = extractWorkbookMedia(buffer, { workbook });
  } catch (error) {
    throw workbookError('CONTRACT_IMPORT_MEDIA_INVALID', `Excel内嵌图片无效：${error.message}`);
  }
  if (extracted.summary.invalidMediaReferences > 0) {
    throw workbookError('CONTRACT_IMPORT_MEDIA_INVALID', 'Excel包含无效或不安全的内嵌图片');
  }

  const suppliersByCode = new Map();
  const rows = [];
  const detailRange = XLSX.utils.decode_range(detailSheet['!ref'] || 'A1:A1');
  for (let rowIndex = 2; rowIndex <= detailRange.e.r; rowIndex += 1) {
    const values = Array.from({ length: 57 }, (_, columnIndex) => (
      cellValue(detailSheet, rowIndex, columnIndex)
    ));
    const code = text(values[1]);
    const name = text(values[2]);
    if (!code && !name) continue;
    if (!code || !name) throw workbookError('CONTRACT_IMPORT_DETAIL_INVALID', `三级细表第${rowIndex + 1}行缺少供应商名称或编码`);
    const trusteeAttribute = parseTrusteeAttribute(values[3]);
    if (!trusteeAttribute) throw workbookError('CONTRACT_IMPORT_DETAIL_INVALID', `三级细表第${rowIndex + 1}行缺少托管属性`);
    if ([22, 54, 55].some((columnIndex) => text(values[columnIndex]) !== '')) {
      throw workbookError(
        'CONTRACT_IMPORT_ATTACHMENT_UNRESOLVED',
        `三级细表第${rowIndex + 1}行合同PDF或打款凭证无法从Excel安全绑定，请导入后在页面手工上传`
      );
    }
    const existingSupplier = suppliersByCode.get(code);
    if (existingSupplier && (
      existingSupplier.name !== name || existingSupplier.trusteeAttribute !== trusteeAttribute
    )) {
      throw workbookError(
        'CONTRACT_IMPORT_SUPPLIER_CONFLICT',
        `三级细表第${rowIndex + 1}行供应商编码${code}的名称或托管属性与前面行不一致`
      );
    }
    suppliersByCode.set(code, { code, name, trusteeAttribute });
    const embeddedRowImages = extracted.imagesByRow.get(
      `${DETAIL_SHEET_NAME}\u0000${rowIndex + 1}`
    ) || [];
    if (embeddedRowImages.some((image) => /^(?:W|BC|BD)\d+$/i.test(image.cellAddress || ''))) {
      throw workbookError(
        'CONTRACT_IMPORT_ATTACHMENT_UNRESOLVED',
        `三级细表第${rowIndex + 1}行合同PDF或打款凭证无法从Excel安全绑定，请导入后在页面手工上传`
      );
    }

    const records = [];
    if (rowHasAny(values.slice(4, 12))) {
      const invoiceImages = embeddedRowImages
        .filter((image) => image.isValid && /^G\d+$/i.test(image.cellAddress || ''));
      const invoiceCell = detailSheet[XLSX.utils.encode_cell({ r: rowIndex, c: 6 })];
      const invoiceFormula = text(invoiceCell?.f || invoiceCell?.v);
      const invoiceDisplay = text(values[6]);
      if (
        (/DISPIMG\s*\(/i.test(invoiceFormula) || /^#(?:NAME|UNKNOWN)[!?]?$/i.test(invoiceDisplay)) &&
        invoiceImages.length === 0
      ) {
        throw workbookError(
          'CONTRACT_IMPORT_MEDIA_MISSING',
          `三级细表第${rowIndex + 1}行开票图片引用无法解析`
        );
      }
      const invoiceInfoText = (
        invoiceImages.length > 0 ||
        /DISPIMG\s*\(/i.test(invoiceFormula) ||
        /^#(?:NAME|UNKNOWN)[!?]?$/i.test(invoiceDisplay)
      ) ? '' : normalizeInvoiceText(invoiceDisplay);
      records.push({
        category: 'SUPPLIER_INFO',
        signingStatus: null,
        contractNumber: '',
        effectiveDate: null,
        expiryDate: null,
        autoRenew: false,
        details: {
          supplyStatus: parseSupplyStatus(values[4]),
          hasInvoiceInfo: parseBoolean(values[5], { nullable: true }),
          invoiceInfoText,
          contacts: contactsFromColumns(values[7], values[8]),
          reconciliationEmails: splitMulti(values[9]),
          unsignedReason: text(values[10]),
          remarks: text(values[11])
        },
        importedMedia: invoiceImages
      });
    }
    if (rowHasAny(values.slice(12, 24))) records.push({
      category: 'MAIN_SERVICE_AGREEMENT',
      signingStatus: parseSigningStatus(values[12]),
      contractNumber: text(values[13]),
      effectiveDate: parseDateOnly(values[14]),
      expiryDate: parseDateOnly(values[15]),
      autoRenew: parseBoolean(values[23]),
      details: {
        supplierSignedDate: parseDateOnly(values[16]), companySignedDate: parseDateOnly(values[17]),
        returnDate: parseDateOnly(values[18]), courierNumber: text(values[19]),
        deliveredBusinessDate: parseDateOnly(values[20]), deliveredFactoryDate: parseDateOnly(values[21])
      },
      importedMedia: []
    });
    if (rowHasAny(values.slice(24, 32))) records.push({
      category: 'LOGISTICS_FEE_AGREEMENT',
      signingStatus: parseSigningStatus(values[24]),
      contractNumber: '', effectiveDate: parseDateOnly(values[25]), expiryDate: parseDateOnly(values[26]),
      autoRenew: false,
      details: {
        warehouseServiceRate: text(values[27]), overstorageServiceRate: text(values[28]),
        overstorageDays: parseOverstorageDays(values[29]), settlementCycle: text(values[30]), remarks: text(values[31])
      },
      importedMedia: []
    });
    if (rowHasAny(values.slice(32, 45))) records.push({
      category: 'TURNOVER_EQUIPMENT_SERVICE',
      signingStatus: parseSigningStatus(values[32]), contractNumber: text(values[33]),
      effectiveDate: parseDateOnly(values[34]), expiryDate: parseDateOnly(values[35]), autoRenew: false,
      details: {
        equipmentType: text(values[36]), equipmentServicePrice: text(values[37]),
        supplierSignedDate: parseDateOnly(values[38]), companySignedDate: parseDateOnly(values[39]),
        returnDate: parseDateOnly(values[40]), courierNumber: text(values[41]),
        deliveredBusinessDate: parseDateOnly(values[42]), deliveredFactoryDate: parseDateOnly(values[43]),
        remarks: text(values[44])
      },
      importedMedia: []
    });
    if (rowHasAny(values.slice(45, 57))) records.push({
      category: 'EQUIPMENT_RENTAL',
      signingStatus: parseSigningStatus(values[45]), contractNumber: text(values[46]),
      effectiveDate: parseDateOnly(values[47]), expiryDate: parseDateOnly(values[48]), autoRenew: false,
      details: {
        equipmentType: text(values[49]), specification: text(values[50]), productionBatch: text(values[51]),
        color: text(values[52]), quantity: text(values[53]), remarks: text(values[56])
      },
      importedMedia: []
    });
    const missingStatus = records.find((record) => (
      record.category !== 'SUPPLIER_INFO' && !record.signingStatus
    ));
    if (missingStatus) {
      throw workbookError(
        'CONTRACT_IMPORT_SIGNING_STATUS_REQUIRED',
        `三级细表第${rowIndex + 1}行${CATEGORY_LABELS[missingStatus.category]}缺少签订状态`
      );
    }
    if (records.length === 0) {
      throw workbookError(
        'CONTRACT_IMPORT_DETAIL_EMPTY',
        `三级细表第${rowIndex + 1}行没有可导入的供应商信息或合同内容`
      );
    }
    rows.push({ rowNumber: rowIndex + 1, supplierCode: code, records });
  }

  if (suppliersByCode.size === 0) throw workbookError('CONTRACT_IMPORT_EMPTY', 'Excel中没有可导入的供应商数据');
  return {
    suppliers: [...suppliersByCode.values()],
    rows,
    mediaSummary: extracted.summary
  };
}

function parseSettlementWorkbook(buffer) {
  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  } catch (error) {
    throw workbookError('CONTRACT_SETTLEMENT_WORKBOOK_INVALID', `无法读取Excel文件：${error.message}`);
  }
  const sheet = workbook.Sheets[SETTLEMENT_SHEET_NAME] || workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw workbookError('CONTRACT_SETTLEMENT_TEMPLATE_INVALID', 'Excel中没有工作表');
  SETTLEMENT_HEADERS.forEach((expected, columnIndex) => (
    assertHeader(
      sheet,
      0,
      columnIndex,
      expected,
      SETTLEMENT_SHEET_NAME,
      'CONTRACT_SETTLEMENT_TEMPLATE_INVALID'
    )
  ));
  const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1:A1');
  const rows = [];
  const keys = new Set();
  for (let rowIndex = 1; rowIndex <= range.e.r; rowIndex += 1) {
    const rawMonth = cellValue(sheet, rowIndex, 1, { formatted: false });
    const name = text(cellValue(sheet, rowIndex, 2));
    const code = text(cellValue(sheet, rowIndex, 3));
    if ((rawMonth === '' || rawMonth === null || rawMonth === undefined) && !name && !code) continue;
    if (!name || !code) throw workbookError('CONTRACT_SETTLEMENT_ROW_INVALID', `结算表第${rowIndex + 1}行缺少供应商名称或编码`);
    const month = parseMonth(rawMonth);
    const key = `${month}\u0000${code}`;
    if (keys.has(key)) throw workbookError('CONTRACT_SETTLEMENT_DUPLICATE_IN_FILE', `结算表存在重复月份和供应商编码：${month}/${code}`);
    keys.add(key);
    rows.push({
      rowNumber: rowIndex + 1,
      month,
      supplierName: name,
      supplierCode: code,
      productLaunchAmount: parseAmount(cellValue(sheet, rowIndex, 4, { formatted: false }), '产品上线金额'),
      warehousingLogisticsFee: parseAmount(cellValue(sheet, rowIndex, 5, { formatted: false }), '仓储物流费'),
      overstorageProductAmount: parseAmount(cellValue(sheet, rowIndex, 6, { formatted: false }), '超储产品金额'),
      overstorageLogisticsFee: parseAmount(cellValue(sheet, rowIndex, 7, { formatted: false }), '超储物流费'),
      remarks: text(cellValue(sheet, rowIndex, 10))
    });
  }
  if (rows.length === 0) throw workbookError('CONTRACT_SETTLEMENT_IMPORT_EMPTY', 'Excel中没有可导入的结算数据');
  return rows;
}

function dateText(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '';
}

function recordExportRow(record, supplier, index) {
  const row = Array(57).fill('');
  row[0] = index;
  row[1] = supplier.code;
  row[2] = supplier.name;
  row[3] = supplier.trusteeAttribute === 'HOSTED' ? '托管' : '非托';
  const d = record.details || {};
  if (record.category === 'SUPPLIER_INFO') {
    row[4] = d.supplyStatus === 'NORMAL' ? '正常供货' : d.supplyStatus === 'STOPPED' ? '已停供' : '';
    row[5] = d.hasInvoiceInfo === null || d.hasInvoiceInfo === undefined ? '' : d.hasInvoiceInfo ? '是' : '否';
    row[6] = d.invoiceInfoText || '';
    row[7] = (d.contacts || []).map((item) => item.name).filter(Boolean).join('；');
    row[8] = (d.contacts || []).map((item) => item.phone).filter(Boolean).join('；');
    row[9] = (d.reconciliationEmails || []).join('；'); row[10] = d.unsignedReason || ''; row[11] = d.remarks || '';
  } else if (record.category === 'MAIN_SERVICE_AGREEMENT') {
    row[12] = record.signingStatus === 'SIGNED' ? '已签订' : '未签订'; row[13] = record.contractNumber || '';
    row[14] = dateText(record.effectiveDate); row[15] = dateText(record.expiryDate);
    row[16] = dateText(d.supplierSignedDate); row[17] = dateText(d.companySignedDate); row[18] = dateText(d.returnDate);
    row[19] = d.courierNumber || ''; row[20] = dateText(d.deliveredBusinessDate); row[21] = dateText(d.deliveredFactoryDate);
    row[23] = record.autoRenew ? '是' : '否';
  } else if (record.category === 'LOGISTICS_FEE_AGREEMENT') {
    row[24] = record.signingStatus === 'SIGNED' ? '已签订' : '未签订'; row[25] = dateText(record.effectiveDate);
    row[26] = dateText(record.expiryDate); row[27] = d.warehouseServiceRate || ''; row[28] = d.overstorageServiceRate || '';
    row[29] = d.overstorageDays === 'NONE' ? '无超储' : d.overstorageDays || ''; row[30] = d.settlementCycle || ''; row[31] = d.remarks || '';
  } else if (record.category === 'TURNOVER_EQUIPMENT_SERVICE') {
    row[32] = record.signingStatus === 'SIGNED' ? '已签订' : '未签订'; row[33] = record.contractNumber || '';
    row[34] = dateText(record.effectiveDate); row[35] = dateText(record.expiryDate); row[36] = d.equipmentType || '';
    row[37] = d.equipmentServicePrice || ''; row[38] = dateText(d.supplierSignedDate); row[39] = dateText(d.companySignedDate);
    row[40] = dateText(d.returnDate); row[41] = d.courierNumber || ''; row[42] = dateText(d.deliveredBusinessDate);
    row[43] = dateText(d.deliveredFactoryDate); row[44] = d.remarks || '';
  } else if (record.category === 'EQUIPMENT_RENTAL') {
    row[45] = record.signingStatus === 'SIGNED' ? '已签订' : '未签订'; row[46] = record.contractNumber || '';
    row[47] = dateText(record.effectiveDate); row[48] = dateText(record.expiryDate); row[49] = d.equipmentType || '';
    row[50] = d.specification || ''; row[51] = d.productionBatch || ''; row[52] = d.color || ''; row[53] = d.quantity || '';
    row[56] = d.remarks || '';
  }
  return row.map(formulaSafe);
}

function styleWorksheet(sheet, { headerRow = 1 } = {}) {
  sheet.views = [{ state: 'frozen', ySplit: headerRow }];
  const header = sheet.getRow(headerRow);
  sheet.autoFilter = {
    from: header.getCell(1).address,
    to: header.getCell(sheet.columnCount).address
  };
  header.font = { bold: true };
  header.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  sheet.columns.forEach((column) => { column.width = Math.min(30, Math.max(12, column.header?.length || 12)); });
}

async function createSupplierExportWorkbook({ suppliers, records, category = null }) {
  const workbook = new ExcelJS.Workbook();
  const overview = workbook.addWorksheet(SUPPLIER_SHEET_NAME);
  overview.addRow(['一级主表']);
  overview.addRow(SUPPLIER_HEADERS);
  suppliers.forEach((supplier, index) => overview.addRow([
    index + 1, formulaSafe(supplier.name), formulaSafe(supplier.code),
    supplier.trusteeAttribute === 'HOSTED' ? '托管' : '非托',
    supplier.hasSignedContract ? '是' : '否', supplier.contractValid ? '有效' : '到期'
  ]));
  styleWorksheet(overview, { headerRow: 2 });

  const recordsBySupplier = new Map();
  for (const record of records) {
    const key = String(record.supplierId);
    const grouped = recordsBySupplier.get(key) || [];
    grouped.push(record);
    recordsBySupplier.set(key, grouped);
  }
  const secondary = workbook.addWorksheet('二级细表（供应商合同管理）');
  secondary.addRow(['二级汇总']);
  secondary.addRow([
    '供应商编码', '供应商名称', '托管属性',
    '供应商基本信息', '主合同签订情况',
    '物流服务费用及支付方式协定', '周转器具服务协议', '器具租赁'
  ]);
  suppliers.forEach((supplier) => {
    const supplierRecords = recordsBySupplier.get(String(supplier._id)) || [];
    const count = (recordCategory) => supplierRecords.filter(
      (record) => record.category === recordCategory
    ).length;
    secondary.addRow([
      formulaSafe(supplier.code), formulaSafe(supplier.name),
      supplier.trusteeAttribute === 'HOSTED' ? '托管' : '非托',
      count('SUPPLIER_INFO'), count('MAIN_SERVICE_AGREEMENT'),
      count('LOGISTICS_FEE_AGREEMENT'), count('TURNOVER_EQUIPMENT_SERVICE'),
      count('EQUIPMENT_RENTAL')
    ]);
  });
  styleWorksheet(secondary, { headerRow: 2 });

  const details = workbook.addWorksheet(DETAIL_SHEET_NAME);
  details.addRow([]);
  details.addRow(DETAIL_HEADERS);
  const suppliersById = new Map(suppliers.map((supplier) => [String(supplier._id), supplier]));
  let index = 1;
  records.filter((record) => !category || record.category === category).forEach((record) => {
    const supplier = suppliersById.get(String(record.supplierId));
    if (supplier) details.addRow(recordExportRow(record, supplier, index++));
  });
  styleWorksheet(details, { headerRow: 2 });

  const attachmentRows = [];
  for (const record of records.filter((item) => !category || item.category === category)) {
    const supplier = suppliersById.get(String(record.supplierId));
    if (!supplier) continue;
    for (const attachment of record.attachments || []) {
      attachmentRows.push([
        formulaSafe(supplier.code),
        formulaSafe(supplier.name),
        CATEGORY_LABELS[record.category] || record.category,
        formulaSafe(record.contractNumber || ''),
        attachment.purpose,
        formulaSafe(attachment.originalName || '')
      ]);
    }
  }
  if (attachmentRows.length) {
    const attachmentSheet = workbook.addWorksheet(ATTACHMENT_SHEET_NAME);
    attachmentSheet.addRow(['供应商编码', '供应商名称', '明细类别', '合同编号', '附件用途', '文件名']);
    attachmentRows.forEach((row) => attachmentSheet.addRow(row));
    styleWorksheet(attachmentSheet);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function createExpiryExportWorkbook(alerts) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('合同到期预警');
  sheet.addRow(['序号', '供应商编码', '供应商名称', '合同类型', '合同编号', '生效日期', '截止日期', '剩余有效天数', '是否顺延', '预警状态']);
  alerts.forEach((item, index) => sheet.addRow([
    index + 1, formulaSafe(item.supplierCode), formulaSafe(item.supplierName), CATEGORY_LABELS[item.category] || item.category,
    formulaSafe(item.contractNumber), dateText(item.effectiveDate), dateText(item.expiryDate),
    item.remainingDays, item.autoRenew ? '是' : '否', ALERT_LEVEL_LABELS[item.alertLevel] || item.alertLevel
  ]));
  styleWorksheet(sheet);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function createSettlementExportWorkbook(settlements) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(SETTLEMENT_SHEET_NAME);
  sheet.addRow(SETTLEMENT_HEADERS);
  settlements.forEach((item, index) => sheet.addRow([
    index + 1, item.month, formulaSafe(item.supplierName), formulaSafe(item.supplierCode),
    item.productLaunchAmount, item.warehousingLogisticsFee, item.overstorageProductAmount,
    item.overstorageLogisticsFee, item.hasSignedContract ? '是' : '否',
    item.contractValid ? '有效' : '到期/未生效', formulaSafe(item.remarks)
  ]));
  styleWorksheet(sheet);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

module.exports = {
  ContractWorkbookError,
  DETAIL_HEADERS,
  ATTACHMENT_SHEET_NAME,
  SETTLEMENT_HEADERS,
  createExpiryExportWorkbook,
  createSettlementExportWorkbook,
  createSupplierExportWorkbook,
  parseDateOnly,
  parseMonth,
  parseSettlementWorkbook,
  parseSupplierWorkbook
};
