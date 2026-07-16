'use strict';

const XLSX = require('xlsx');
const EquipmentAsset = require('../models/EquipmentAsset');

const MAX_IMPORT_ROWS = 1000;
const MAX_CELL_TEXT_LENGTH = 2000;
const MAX_RAW_VALUE_LENGTH = 500;

const HEADER_ALIASES = Object.freeze({
  sequence: ['序号', 'No.', 'No'],
  assetCode: [
    '资产编码',
    '资产编号',
    'Asset Code',
    '产品编码SN/PN',
    '产品编码',
    '编号/牌号',
    '品牌编号',
    '车牌号'
  ],
  name: ['名称', '设备名称', 'Name'],
  category: ['资产类别', 'Category'],
  specification: ['型号规格', 'Specification'],
  manufacturer: ['生产厂家', '品牌', 'Manufacturer'],
  quantity: ['实盘数量', '数量', 'Quantity'],
  accountQuantity: ['账存数量'],
  unit: ['单位', 'Unit'],
  acquisitionDate: ['启用日期', 'Acquisition Date'],
  originalValue: ['原值', 'Original Value'],
  custodian: ['使用人', 'Custodian'],
  orgUnit: ['所在部室', '存放地点', 'Organization Unit'],
  orgUnitId: ['Organization Unit ID'],
  categoryId: ['Category ID'],
  custodianUserId: ['Custodian User ID'],
  location: ['存放地点', '所在部室', 'Location'],
  status: ['状态', '当前状态', 'Status'],
  remark: ['备注', '备注1', '备注2', 'Remark'],
  productionDate: ['出厂日期'],
  extraSpecification: ['吨位', '车长'],
  plateNumber: ['车牌号']
});

const HEADER_KEYS = new Set(
  Object.values(HEADER_ALIASES).flat().map((value) => normalizeHeader(value))
);

const CATEGORY_BY_SHEET = Object.freeze({
  运输装备: '运输装备',
  装卸装备: '装卸装备',
  物流信息装备: '物流信息装备',
  辅助设施设备: '辅助设施',
  辅助设施: '辅助设施',
  闲置: '闲置设备'
});

const CATEGORY_ALIASES = Object.freeze({
  物流信息设备: '物流信息装备',
  辅助设施设备: '辅助设施',
  闲置设备: '闲置设备'
});

const STATUS_BY_TEXT = Object.freeze({
  在用: EquipmentAsset.EQUIPMENT_STATUSES.IN_USE,
  使用中: EquipmentAsset.EQUIPMENT_STATUSES.IN_USE,
  闲置: EquipmentAsset.EQUIPMENT_STATUSES.IDLE,
  停用: EquipmentAsset.EQUIPMENT_STATUSES.STOPPED,
  封存: EquipmentAsset.EQUIPMENT_STATUSES.STOPPED,
  待修: EquipmentAsset.EQUIPMENT_STATUSES.STOPPED,
  报废: EquipmentAsset.EQUIPMENT_STATUSES.SCRAPPED,
  IN_USE: EquipmentAsset.EQUIPMENT_STATUSES.IN_USE,
  IDLE: EquipmentAsset.EQUIPMENT_STATUSES.IDLE,
  STOPPED: EquipmentAsset.EQUIPMENT_STATUSES.STOPPED,
  SCRAPPED: EquipmentAsset.EQUIPMENT_STATUSES.SCRAPPED
});

function normalizeHeader(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\s：:]+/g, '')
    .trim();
}

function textValue(value, maxLength = MAX_CELL_TEXT_LENGTH) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  const normalized = String(value).normalize('NFKC').trim();
  return normalized.slice(0, maxLength);
}

function isPlaceholder(value) {
  return ['', '无', '暂无', '不详', '/', '-', '--'].includes(textValue(value));
}

function rowHeaderMap(headerRow) {
  const map = new Map();
  headerRow.forEach((value, index) => {
    const normalized = normalizeHeader(value);
    if (normalized && !map.has(normalized)) map.set(normalized, index);
  });
  return map;
}

function headerScore(row) {
  return row.reduce((score, value) => (
    HEADER_KEYS.has(normalizeHeader(value)) ? score + 1 : score
  ), 0);
}

function locateHeaderRow(rows) {
  let best = { index: -1, score: 0 };
  rows.slice(0, 20).forEach((row, index) => {
    const score = headerScore(row);
    if (score > best.score) best = { index, score };
  });
  return best.score >= 3 ? best.index : -1;
}

function readAlias(row, headerMap, aliases) {
  for (const alias of aliases) {
    const index = headerMap.get(normalizeHeader(alias));
    if (index !== undefined && row[index] !== null && row[index] !== undefined) {
      return row[index];
    }
  }
  return null;
}

function readAllAliases(row, headerMap, aliases) {
  const values = [];
  for (const alias of aliases) {
    const index = headerMap.get(normalizeHeader(alias));
    if (index === undefined) continue;
    const value = row[index];
    if (value !== null && value !== undefined && textValue(value)) values.push(value);
  }
  return values;
}

function rawValuesForRow(row, headerRow) {
  const result = {};
  headerRow.forEach((header, index) => {
    const key = textValue(header, 100);
    const value = row[index];
    if (
      !key ||
      key === '__proto__' ||
      key === 'prototype' ||
      key === 'constructor' ||
      value === null ||
      value === undefined ||
      textValue(value) === ''
    ) return;
    const normalizedValue = value instanceof Date
      ? value.toISOString()
      : typeof value === 'string'
        ? value.slice(0, MAX_RAW_VALUE_LENGTH)
        : value;
    if (!Object.prototype.hasOwnProperty.call(result, key)) result[key] = normalizedValue;
  });
  return result;
}

function buildException(input) {
  const {
    field,
    exceptionType,
    severity = 'ERROR',
    originalValue = null,
    suggestedValue,
    message
  } = input;
  const hasSuggestedValue = Object.prototype.hasOwnProperty.call(input, 'suggestedValue');
  return {
    field,
    exceptionType,
    severity,
    originalValue,
    hasSuggestedValue,
    suggestedValue: hasSuggestedValue ? suggestedValue : null,
    message: message || exceptionType
  };
}

function validDateParts(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? date
    : null;
}

function parseDateValue(value) {
  if (value === null || value === undefined || value === '') {
    return { value: null, exception: null };
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return {
      value: validDateParts(value.getFullYear(), value.getMonth() + 1, value.getDate()),
      exception: null
    };
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value >= 10000) {
      const parsed = XLSX.SSF.parse_date_code(value);
      const date = parsed && validDateParts(parsed.y, parsed.m, parsed.d);
      return date
        ? { value: date, exception: null }
        : { value: null, exception: buildException({
          field: 'acquisitionDate',
          exceptionType: 'DATE_INVALID',
          originalValue: value,
          suggestedValue: null,
          severity: 'WARNING'
        }) };
    }
    return {
      value: null,
      exception: buildException({
        field: 'acquisitionDate',
        exceptionType: 'PARTIAL_DATE',
        originalValue: value,
        suggestedValue: null,
        severity: 'WARNING'
      })
    };
  }

  const text = textValue(value);
  const fullMatch = /^(\d{4})[年\-/\.](\d{1,2})[月\-/\.](\d{1,2})(?:日|号)?$/.exec(text);
  if (fullMatch) {
    const date = validDateParts(Number(fullMatch[1]), Number(fullMatch[2]), Number(fullMatch[3]));
    if (date) return { value: date, exception: null };
  }
  if (/^\d{4}年?$/.test(text) || /^\d{4}[\.\-/]\d{1,2}$/.test(text)) {
    return {
      value: null,
      exception: buildException({
        field: 'acquisitionDate',
        exceptionType: 'PARTIAL_DATE',
        originalValue: text,
        suggestedValue: null,
        severity: 'WARNING'
      })
    };
  }
  return {
    value: null,
    exception: buildException({
      field: 'acquisitionDate',
      exceptionType: 'DATE_INVALID',
      originalValue: text,
      suggestedValue: null,
      severity: 'WARNING'
    })
  };
}

function parseNumber(value, { fallback, field, min = 0, severity = 'ERROR' }) {
  if (value === null || value === undefined || textValue(value) === '') {
    return { value: fallback, exception: null };
  }
  const parsed = typeof value === 'number' ? value : Number(textValue(value).replace(/,/g, ''));
  if (!Number.isFinite(parsed) || parsed < min) {
    return {
      value: fallback,
      exception: buildException({
        field,
        exceptionType: `${field.toUpperCase()}_INVALID`,
        severity,
        originalValue: value,
        suggestedValue: fallback
      })
    };
  }
  return { value: parsed, exception: null };
}

function chooseAssetCode(row, headerMap) {
  for (const alias of HEADER_ALIASES.assetCode) {
    const value = readAlias(row, headerMap, [alias]);
    if (!isPlaceholder(value)) return textValue(value, 500);
  }
  return '';
}

function canonicalCategory(sheetName, explicitCategory) {
  const explicit = textValue(explicitCategory, 100);
  if (explicit) return CATEGORY_ALIASES[explicit] || explicit;
  return CATEGORY_BY_SHEET[textValue(sheetName, 100)] || textValue(sheetName, 100);
}

function parseStatus(rawStatus, sheetName) {
  const text = textValue(rawStatus, 100);
  const idleSheet = sheetName === '闲置';
  if (idleSheet && (text === '正常' || text === '在用' || text === '')) {
    return {
      value: EquipmentAsset.EQUIPMENT_STATUSES.IDLE,
      exception: buildException({
        field: 'status',
        exceptionType: 'STATUS_CONFLICT',
        severity: 'WARNING',
        originalValue: { sheetName, status: text || null },
        suggestedValue: EquipmentAsset.EQUIPMENT_STATUSES.IDLE
      })
    };
  }
  const mapped = STATUS_BY_TEXT[text];
  if (mapped) return { value: mapped, exception: null };
  const suggestion = idleSheet
    ? EquipmentAsset.EQUIPMENT_STATUSES.IDLE
    : EquipmentAsset.EQUIPMENT_STATUSES.IN_USE;
  return {
    value: suggestion,
    exception: buildException({
      field: 'status',
      exceptionType: text ? 'STATUS_UNRECOGNIZED' : 'STATUS_MISSING',
      severity: text ? 'ERROR' : 'WARNING',
      originalValue: text || null,
      suggestedValue: suggestion
    })
  };
}

function isFooterRow(row) {
  return row.some((value) => /盘点人|分部经理|部门副经理|部门经理\/日期/.test(textValue(value)));
}

function parseDataRow({ row, rowNumber, headerRow, headerMap, sheetName }) {
  if (isFooterRow(row)) return null;
  const name = textValue(readAlias(row, headerMap, HEADER_ALIASES.name), 500);
  const sequence = readAlias(row, headerMap, HEADER_ALIASES.sequence);
  const assetCode = chooseAssetCode(row, headerMap);
  if (!name && !assetCode && (sequence === null || sequence === undefined || sequence === '')) {
    return null;
  }

  const exceptions = [];
  if (!assetCode) {
    exceptions.push(buildException({
      field: 'assetCode',
      exceptionType: 'ASSET_CODE_MISSING',
      originalValue: null
    }));
  } else if (assetCode.length > 100) {
    exceptions.push(buildException({
      field: 'assetCode',
      exceptionType: 'ASSET_CODE_TOO_LONG',
      originalValue: assetCode
    }));
  }
  if (!name) {
    exceptions.push(buildException({ field: 'name', exceptionType: 'NAME_MISSING' }));
  } else if (name.length > 200) {
    exceptions.push(buildException({
      field: 'name',
      exceptionType: 'NAME_TOO_LONG',
      originalValue: name
    }));
  }

  const categoryName = canonicalCategory(
    sheetName,
    readAlias(row, headerMap, HEADER_ALIASES.category)
  );
  const orgUnitName = textValue(readAlias(row, headerMap, HEADER_ALIASES.orgUnit), 200);
  const custodianName = textValue(readAlias(row, headerMap, HEADER_ALIASES.custodian), 200);
  const quantityResult = parseNumber(
    readAlias(row, headerMap, HEADER_ALIASES.quantity),
    { fallback: 1, field: 'quantity' }
  );
  if (quantityResult.exception) exceptions.push(quantityResult.exception);
  const accountQuantityResult = parseNumber(
    readAlias(row, headerMap, HEADER_ALIASES.accountQuantity),
    { fallback: null, field: 'accountQuantity', severity: 'WARNING' }
  );
  if (accountQuantityResult.exception) exceptions.push(accountQuantityResult.exception);
  if (
    accountQuantityResult.value !== null &&
    quantityResult.value !== accountQuantityResult.value
  ) {
    exceptions.push(buildException({
      field: 'quantity',
      exceptionType: 'QUANTITY_MISMATCH',
      severity: 'WARNING',
      originalValue: {
        accountQuantity: accountQuantityResult.value,
        physicalQuantity: quantityResult.value
      },
      suggestedValue: quantityResult.value
    }));
  }
  if (quantityResult.value > 1 || /[\/～~至]/.test(assetCode)) {
    exceptions.push(buildException({
      field: 'quantity',
      exceptionType: 'MULTI_ASSET_ROW',
      severity: 'WARNING',
      originalValue: { assetCode, quantity: quantityResult.value }
    }));
  }

  const acquisitionResult = parseDateValue(
    readAlias(row, headerMap, HEADER_ALIASES.acquisitionDate)
  );
  if (acquisitionResult.exception) exceptions.push(acquisitionResult.exception);
  const originalValueResult = parseNumber(
    readAlias(row, headerMap, HEADER_ALIASES.originalValue),
    { fallback: null, field: 'originalValue' }
  );
  if (originalValueResult.exception) exceptions.push(originalValueResult.exception);
  const statusResult = parseStatus(
    readAlias(row, headerMap, HEADER_ALIASES.status),
    sheetName
  );
  if (statusResult.exception) exceptions.push(statusResult.exception);

  const rawUnit = textValue(readAlias(row, headerMap, HEADER_ALIASES.unit), 100);
  let unit = rawUnit;
  if (/部$/.test(rawUnit) || rawUnit === '变速箱物流部') {
    const suggestedUnit = /运输|装卸/.test(categoryName) ? '辆' : '台';
    exceptions.push(buildException({
      field: 'unit',
      exceptionType: 'FIELD_MISALIGNMENT',
      severity: 'WARNING',
      originalValue: rawUnit,
      suggestedValue: suggestedUnit
    }));
    unit = rawUnit;
  }

  const formulas = Object.values(rawValuesForRow(row, headerRow))
    .filter((value) => typeof value === 'string' && /DISPIMG\s*\(/i.test(value));
  if (formulas.length > 0) {
    exceptions.push(buildException({
      field: '_photos',
      exceptionType: 'PHOTO_MAPPING_PENDING',
      severity: 'WARNING',
      originalValue: formulas,
      message: 'WPS cell images require separate relationship mapping and customer verification'
    }));
  }

  const specification = textValue(
    readAlias(row, headerMap, HEADER_ALIASES.specification),
    500
  );
  const extraSpecification = readAllAliases(
    row,
    headerMap,
    HEADER_ALIASES.extraSpecification
  ).map((value) => textValue(value, 100)).filter(Boolean);
  const remarks = readAllAliases(row, headerMap, HEADER_ALIASES.remark)
    .map((value) => textValue(value, 1000))
    .filter((value) => value && !/DISPIMG\s*\(/i.test(value));
  if (extraSpecification.length > 0) {
    remarks.unshift(`补充规格: ${extraSpecification.join(' / ')}`);
  }

  return {
    sheetName,
    rowNumber,
    rawAssetCode: assetCode,
    rawValues: rawValuesForRow(row, headerRow),
    candidate: {
      assetCode,
      name,
      categoryId: textValue(readAlias(row, headerMap, HEADER_ALIASES.categoryId), 100) || null,
      categoryName,
      specification,
      manufacturer: textValue(readAlias(row, headerMap, HEADER_ALIASES.manufacturer), 200),
      quantity: quantityResult.value,
      unit,
      acquisitionDate: acquisitionResult.value,
      originalValue: originalValueResult.value,
      orgUnitId: textValue(readAlias(row, headerMap, HEADER_ALIASES.orgUnitId), 100) || null,
      orgUnitName,
      custodianUserId: textValue(
        readAlias(row, headerMap, HEADER_ALIASES.custodianUserId),
        100
      ) || null,
      custodianName,
      location: textValue(readAlias(row, headerMap, HEADER_ALIASES.location), 500),
      status: statusResult.value,
      remark: remarks.join('\n').slice(0, 2000)
    },
    exceptions
  };
}

function parseEquipmentWorkbook(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new TypeError('A non-empty Excel buffer is required');
  }
  const workbook = XLSX.read(buffer, {
    type: 'buffer',
    cellDates: true,
    cellFormula: true,
    dense: true,
    sheetRows: MAX_IMPORT_ROWS + 22
  });
  if (!Array.isArray(workbook.SheetNames) || workbook.SheetNames.length === 0) {
    throw new TypeError('The workbook does not contain any worksheets');
  }

  const parsedRows = [];
  const sheetErrors = [];
  for (const sheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      defval: null,
      raw: true,
      blankrows: false
    });
    if (rows.length === 0) continue;
    const headerIndex = locateHeaderRow(rows);
    if (headerIndex < 0) {
      sheetErrors.push({ sheetName, exceptionType: 'HEADER_NOT_RECOGNIZED' });
      continue;
    }
    const headerRow = rows[headerIndex];
    const headerMap = rowHeaderMap(headerRow);
    rows.slice(headerIndex + 1).forEach((row, index) => {
      const parsed = parseDataRow({
        row,
        rowNumber: headerIndex + index + 2,
        headerRow,
        headerMap,
        sheetName
      });
      if (parsed) parsedRows.push(parsed);
    });
    if (parsedRows.length > MAX_IMPORT_ROWS) {
      throw new RangeError(`The workbook exceeds the ${MAX_IMPORT_ROWS} row import limit`);
    }
  }
  if (parsedRows.length === 0) {
    throw new TypeError('The workbook does not contain recognizable equipment rows');
  }
  if (sheetErrors.length > 0) {
    throw new TypeError(
      `Unrecognized worksheet headers: ${sheetErrors.map(({ sheetName }) => sheetName).join(', ')}`
    );
  }
  return {
    sheetNames: [...workbook.SheetNames],
    rows: parsedRows,
    sheetErrors
  };
}

module.exports = {
  HEADER_ALIASES,
  MAX_IMPORT_ROWS,
  buildException,
  canonicalCategory,
  normalizeHeader,
  parseDateValue,
  parseEquipmentWorkbook,
  textValue
};
