'use strict';

const XLSX = require('xlsx');
const EquipmentAsset = require('../models/EquipmentAsset');

const MAX_IMPORT_ROWS = 1000;
const MAX_CELL_TEXT_LENGTH = 2000;
const MAX_RAW_VALUE_LENGTH = 500;

const HEADER_ALIASES = Object.freeze({
  sequence: ['序号', 'No.', 'No'],
  majorCategoryName: ['设备所属大类'],
  equipmentTypeName: ['设备所属类型'],
  primaryName: ['设备一级名称'],
  secondaryName: ['设备二级名称'],
  assetCode: ['固定资产编号', '资产编码', '资产编号', 'Asset Code'],
  productCode: ['产品/品牌编码', '产品编码SN/PN', '产品编码'],
  plateNumber: ['车牌号'],
  serialNumber: ['编号/牌号'],
  brandSerialNumber: ['品牌编号'],
  name: ['名称', '设备名称', 'Name'],
  category: ['资产类别', 'Category'],
  specification: ['型号规格', 'Specification'],
  manufacturer: ['生产厂家', 'Manufacturer'],
  brand: ['品牌'],
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
  condition: ['当前状态', '状态'],
  remark: ['备注', '备注1', '备注2', 'Remark'],
  productionDate: ['出厂日期'],
  vehicleLength: ['车长'],
  ratedCapacityText: ['吨位'],
  idlePlacedAt: ['放置日期'],
  forkliftPosition: ['高位/低位', '叉车是否高低位', '高低位'],
  environmentalRegistrationCode: ['环保编号', '叉车环保编号'],
  powerType: ['设备动力类型：锂电/铅酸/柴油', '设备动力类型', '动力类型'],
  emissionStandard: ['排放标准'],
  photo: [
    '设备照片（请在单元格内插入图片）',
    '设备照片（支持上传1-10张照片）'
  ]
});

const EQUIPMENT_TEMPLATE_FIELD_KEYS = Object.freeze([
  'sequence',
  'majorCategoryName',
  'equipmentTypeName',
  'primaryName',
  'secondaryName',
  'assetCode',
  'plateNumber',
  'environmentalRegistrationCode',
  'productCode',
  'specification',
  'unit',
  'productionDate',
  'acquisitionDate',
  'vehicleLength',
  'ratedCapacityText',
  'forkliftPosition',
  'powerType',
  'emissionStandard',
  'brand',
  'manufacturer',
  'accountQuantity',
  'quantity',
  'orgUnit',
  'custodian',
  'status',
  'location',
  'photo',
  'remark'
]);

const EQUIPMENT_TEMPLATE_HEADERS = Object.freeze(
  EQUIPMENT_TEMPLATE_FIELD_KEYS.map((fieldKey) => HEADER_ALIASES[fieldKey][0])
);

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

const ASSET_TYPE_BY_SHEET = Object.freeze({
  运输装备: 'TRANSPORT_EQUIPMENT',
  装卸装备: 'HANDLING_EQUIPMENT',
  装卸搬运设备: 'HANDLING_EQUIPMENT',
  物流信息装备: 'LOGISTICS_INFORMATION_EQUIPMENT',
  辅助设施设备: 'AUXILIARY_FACILITY',
  辅助设施: 'AUXILIARY_FACILITY',
  闲置: 'IDLE'
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

function readCellMetadata(worksheet, rowNumber, headerMap, aliases) {
  for (const alias of aliases) {
    const columnIndex = headerMap.get(normalizeHeader(alias));
    if (columnIndex === undefined) continue;
    const cell = worksheet['!data']?.[rowNumber - 1]?.[columnIndex];
    if (!cell) return { display: '', numberFormat: '' };
    return {
      display: textValue(cell.w, 200),
      numberFormat: textValue(cell.z, 200)
    };
  }
  return { display: '', numberFormat: '' };
}

function rawValuesForRow(row, headerRow) {
  const result = {};
  headerRow.forEach((header, index) => {
    const key = textValue(header, 100) || `__column_${XLSX.utils.encode_col(index)}`;
    const value = row[index];
    if (
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
  for (let index = headerRow.length; index < row.length; index += 1) {
    const value = row[index];
    if (value === null || value === undefined || textValue(value) === '') continue;
    const key = `__column_${XLSX.utils.encode_col(index)}`;
    result[key] = typeof value === 'string'
      ? value.slice(0, MAX_RAW_VALUE_LENGTH)
      : value instanceof Date ? value.toISOString() : value;
  }
  return result;
}

function worksheetRawRows(worksheet) {
  const denseRows = worksheet['!data'];
  if (!Array.isArray(denseRows)) {
    return XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      defval: null,
      raw: true,
      blankrows: true
    });
  }
  return denseRows.map((cells) => {
    if (!Array.isArray(cells)) return [];
    const row = [];
    cells.forEach((cell, index) => {
      if (!cell) {
        row[index] = null;
        return;
      }
      row[index] = cell.v !== undefined
        ? cell.v
        : cell.f ? `=${cell.f}` : null;
    });
    return row;
  });
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

function formatDateDisplay(date, precision) {
  if (!date || !precision) return '';
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  if (precision === EquipmentAsset.DATE_PRECISIONS.YEAR) return year;
  if (precision === EquipmentAsset.DATE_PRECISIONS.MONTH) return `${year}-${month}`;
  return `${year}-${month}-${day}`;
}

function dateResult({
  date = null,
  precision = null,
  raw = '',
  display = '',
  exception = null
}) {
  return {
    value: date,
    precision,
    raw,
    display: display || formatDateDisplay(date, precision),
    exception
  };
}

function dateException({ field, exceptionType, originalValue, severity = 'WARNING' }) {
  return buildException({
    field,
    exceptionType,
    originalValue,
    suggestedValue: null,
    severity
  });
}

function inferDatePrecision(numberFormat, display, fallback) {
  const format = textValue(numberFormat, 200).toLowerCase();
  const shown = textValue(display, 200);
  if (/[d日号]/.test(format) || /\d{1,2}(?:日|号)$/.test(shown)) {
    return EquipmentAsset.DATE_PRECISIONS.DAY;
  }
  if (/[m月]/.test(format) || /^\d{4}(?:年|[-/.])\d{1,2}月?$/.test(shown)) {
    return EquipmentAsset.DATE_PRECISIONS.MONTH;
  }
  if (/[y年]/.test(format) || /^\d{4}年?$/.test(shown)) {
    return EquipmentAsset.DATE_PRECISIONS.YEAR;
  }
  return fallback;
}

function parseSourceDateValue(value, {
  field = 'acquisitionDate',
  display = '',
  numberFormat = ''
} = {}) {
  const sourceDisplay = textValue(display, 200);
  if (value === null || value === undefined || value === '') {
    return dateResult({ display: sourceDisplay });
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const date = validDateParts(value.getFullYear(), value.getMonth() + 1, value.getDate());
    return dateResult({
      date,
      precision: EquipmentAsset.DATE_PRECISIONS.DAY,
      raw: value.toISOString(),
      display: sourceDisplay
    });
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value >= 10000) {
      const parsed = XLSX.SSF.parse_date_code(value);
      const date = parsed && validDateParts(parsed.y, parsed.m, parsed.d);
      const precision = inferDatePrecision(
        numberFormat,
        sourceDisplay,
        EquipmentAsset.DATE_PRECISIONS.DAY
      );
      return date
        ? dateResult({
          date,
          precision,
          raw: String(value),
          display: sourceDisplay
        })
        : dateResult({
          raw: String(value),
          display: sourceDisplay,
          exception: dateException({ field, exceptionType: 'DATE_INVALID', originalValue: value })
        });
    }
    const raw = String(value);
    const displayYearMonth = /^(\d{4})[.\-/年](\d{1,2})月?$/.exec(sourceDisplay);
    const yearMonth = displayYearMonth || /^(\d{4})\.(\d{1,2})$/.exec(raw);
    if (yearMonth) {
      const date = validDateParts(Number(yearMonth[1]), Number(yearMonth[2]), 1);
      if (date) return dateResult({
        date,
        precision: EquipmentAsset.DATE_PRECISIONS.MONTH,
        raw,
        display: sourceDisplay,
        exception: dateException({ field, exceptionType: 'PARTIAL_DATE', originalValue: value })
      });
    }
    if (Number.isInteger(value) && value >= 1900 && value <= 9999) {
      return dateResult({
        date: validDateParts(value, 1, 1),
        precision: EquipmentAsset.DATE_PRECISIONS.YEAR,
        raw,
        display: sourceDisplay,
        exception: dateException({ field, exceptionType: 'PARTIAL_DATE', originalValue: value })
      });
    }
    return dateResult({
      raw,
      display: sourceDisplay,
      exception: dateException({ field, exceptionType: 'DATE_INVALID', originalValue: value })
    });
  }

  const text = textValue(value);
  const fullMatch = /^(\d{4})[年\-/\.](\d{1,2})[月\-/\.](\d{1,2})(?:日|号)?$/.exec(text);
  if (fullMatch) {
    const date = validDateParts(Number(fullMatch[1]), Number(fullMatch[2]), Number(fullMatch[3]));
    if (date) return dateResult({
      date,
      precision: EquipmentAsset.DATE_PRECISIONS.DAY,
      raw: text,
      display: sourceDisplay
    });
  }
  const monthMatch = /^(\d{4})(?:年|[\.\-/])(\d{1,2})月?$/.exec(text);
  if (monthMatch) {
    const date = validDateParts(Number(monthMatch[1]), Number(monthMatch[2]), 1);
    if (date) return dateResult({
      date,
      precision: EquipmentAsset.DATE_PRECISIONS.MONTH,
      raw: text,
      display: sourceDisplay,
      exception: dateException({ field, exceptionType: 'PARTIAL_DATE', originalValue: text })
    });
  }
  const yearMatch = /^(\d{4})年?$/.exec(text);
  if (yearMatch) return dateResult({
    date: validDateParts(Number(yearMatch[1]), 1, 1),
    precision: EquipmentAsset.DATE_PRECISIONS.YEAR,
    raw: text,
    display: sourceDisplay,
    exception: dateException({ field, exceptionType: 'PARTIAL_DATE', originalValue: text })
  });
  return dateResult({
    raw: text,
    display: sourceDisplay,
    exception: dateException({ field, exceptionType: 'DATE_INVALID', originalValue: text })
  });
}

function parseDateValue(value) {
  const parsed = parseSourceDateValue(value, { field: 'acquisitionDate' });
  return {
    value: parsed.precision === EquipmentAsset.DATE_PRECISIONS.DAY ? parsed.value : null,
    exception: parsed.exception
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

function parseQuantity(value, { field }) {
  if (value === null || value === undefined || textValue(value) === '') {
    return { value: null, embeddedUnit: '', exception: null };
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return { value, embeddedUnit: '', exception: null };
  }
  const text = textValue(value, 200).replace(/,/g, '');
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    return { value: Number(text), embeddedUnit: '', exception: null };
  }
  const embedded = /^(\d+(?:\.\d+)?)\s*(\D.+|\D)$/.exec(text);
  if (embedded) {
    const parsed = Number(embedded[1]);
    const embeddedUnit = textValue(embedded[2], 50);
    return {
      value: parsed,
      embeddedUnit,
      exception: buildException({
        field,
        exceptionType: 'QUANTITY_UNIT_EMBEDDED',
        severity: 'WARNING',
        originalValue: value,
        suggestedValue: parsed,
        message: `Quantity contains an embedded unit: ${embeddedUnit}`
      })
    };
  }
  const exceptionType = field === 'bookQuantity'
    ? 'BOOK_QUANTITY_INVALID'
    : 'PHYSICAL_QUANTITY_INVALID';
  return {
    value: null,
    embeddedUnit: '',
    exception: buildException({
      field,
      exceptionType,
      originalValue: value,
      suggestedValue: null
    })
  };
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

function mergedSourceCells({ worksheet, headerRow, rowNumber }) {
  const zeroBasedRow = rowNumber - 1;
  return (worksheet['!merges'] || [])
    .filter((range) => (
      range.s.r !== range.e.r && zeroBasedRow >= range.s.r && zeroBasedRow <= range.e.r
    ))
    .map((range) => {
      const anchor = worksheet['!data']?.[range.s.r]?.[range.s.c];
      return {
        range: XLSX.utils.encode_range(range),
        header: textValue(headerRow[range.s.c], 100),
        column: XLSX.utils.encode_col(range.s.c),
        columnIndex: range.s.c,
        anchorRowNumber: range.s.r + 1,
        rawValue: anchor?.v ?? null,
        displayValue: textValue(anchor?.w, 500)
      };
    });
}

function parseDataRow({
  row,
  rowNumber,
  headerRow,
  headerMap,
  sheetName,
  worksheet,
  mergedCells = []
}) {
  row = [...row];
  for (const mergedCell of mergedCells) {
    if (row[mergedCell.columnIndex] === null || row[mergedCell.columnIndex] === undefined) {
      row[mergedCell.columnIndex] = mergedCell.rawValue;
    }
  }
  if (isFooterRow(row)) return null;
  const majorCategoryName = textValue(
    readAlias(row, headerMap, HEADER_ALIASES.majorCategoryName),
    100
  );
  const equipmentTypeName = textValue(
    readAlias(row, headerMap, HEADER_ALIASES.equipmentTypeName),
    100
  );
  const primaryName = textValue(readAlias(row, headerMap, HEADER_ALIASES.primaryName), 200);
  const secondaryName = textValue(
    readAlias(row, headerMap, HEADER_ALIASES.secondaryName),
    200
  );
  const explicitName = textValue(readAlias(row, headerMap, HEADER_ALIASES.name), 500);
  const name = explicitName || secondaryName || primaryName || equipmentTypeName;
  const sequence = readAlias(row, headerMap, HEADER_ALIASES.sequence);
  const sourceAssetCode = textValue(
    readAlias(row, headerMap, HEADER_ALIASES.assetCode),
    500
  );
  const assetCode = isPlaceholder(sourceAssetCode) ? '' : sourceAssetCode;
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
  for (const mergedCell of mergedCells) {
    const isAssetCode = HEADER_ALIASES.assetCode.some((alias) => (
      normalizeHeader(alias) === normalizeHeader(mergedCell.header)
    ));
    exceptions.push(buildException({
      field: isAssetCode ? 'assetCode' : '_source',
      exceptionType: 'MERGED_SOURCE_CELL',
      severity: isAssetCode ? 'ERROR' : 'WARNING',
      originalValue: mergedCell,
      message: `Source cell ${mergedCell.range} spans multiple equipment rows and requires confirmation`
    }));
  }

  const categoryName = secondaryName || primaryName || equipmentTypeName || majorCategoryName ||
    canonicalCategory(sheetName, readAlias(row, headerMap, HEADER_ALIASES.category));
  const assetTypeSource = majorCategoryName || textValue(sheetName, 100);
  const assetType = ASSET_TYPE_BY_SHEET[assetTypeSource] || assetTypeSource;
  const orgUnitName = textValue(readAlias(row, headerMap, HEADER_ALIASES.orgUnit), 200);
  const custodianName = textValue(readAlias(row, headerMap, HEADER_ALIASES.custodian), 200);
  const quantityResult = parseQuantity(
    readAlias(row, headerMap, HEADER_ALIASES.quantity),
    { field: 'physicalQuantity' }
  );
  if (quantityResult.exception) exceptions.push(quantityResult.exception);
  const accountQuantityResult = parseQuantity(
    readAlias(row, headerMap, HEADER_ALIASES.accountQuantity),
    { field: 'bookQuantity' }
  );
  if (accountQuantityResult.exception) exceptions.push(accountQuantityResult.exception);
  if (
    accountQuantityResult.value !== null &&
    quantityResult.value !== null &&
    quantityResult.value !== accountQuantityResult.value
  ) {
    exceptions.push(buildException({
      field: 'physicalQuantity',
      exceptionType: 'QUANTITY_MISMATCH',
      severity: 'WARNING',
      originalValue: {
        accountQuantity: accountQuantityResult.value,
        physicalQuantity: quantityResult.value
      },
      suggestedValue: quantityResult.value
    }));
  }
  const compatibilityQuantity = quantityResult.value ?? accountQuantityResult.value ?? 1;
  if (compatibilityQuantity > 1 || /[\/～~至]/.test(assetCode)) {
    exceptions.push(buildException({
      field: 'quantity',
      exceptionType: 'MULTI_ASSET_ROW',
      severity: 'WARNING',
      originalValue: { assetCode, quantity: compatibilityQuantity }
    }));
  }

  const activationMetadata = readCellMetadata(
    worksheet,
    rowNumber,
    headerMap,
    HEADER_ALIASES.acquisitionDate
  );
  const activationResult = parseSourceDateValue(
    readAlias(row, headerMap, HEADER_ALIASES.acquisitionDate),
    { field: 'acquisitionDate', ...activationMetadata }
  );
  if (activationResult.exception) exceptions.push(activationResult.exception);
  const acquisitionDate = activationResult.precision === EquipmentAsset.DATE_PRECISIONS.DAY
    ? activationResult.value
    : null;
  const productionMetadata = readCellMetadata(
    worksheet,
    rowNumber,
    headerMap,
    HEADER_ALIASES.productionDate
  );
  const productionResult = parseSourceDateValue(
    readAlias(row, headerMap, HEADER_ALIASES.productionDate),
    { field: 'productionDate', ...productionMetadata }
  );
  if (productionResult.exception) exceptions.push(productionResult.exception);
  const idlePlacedMetadata = readCellMetadata(
    worksheet,
    rowNumber,
    headerMap,
    HEADER_ALIASES.idlePlacedAt
  );
  const idlePlacedResult = parseSourceDateValue(
    readAlias(row, headerMap, HEADER_ALIASES.idlePlacedAt),
    { field: 'idlePlacedAt', ...idlePlacedMetadata }
  );
  if (idlePlacedResult.exception) exceptions.push(idlePlacedResult.exception);
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
  let unit = rawUnit || quantityResult.embeddedUnit || accountQuantityResult.embeddedUnit;
  if (/部$/.test(rawUnit)) {
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

  const sourceRawValues = rawValuesForRow(row, headerRow);
  for (const mergedCell of mergedCells) {
    if (mergedCell.header && mergedCell.displayValue) {
      sourceRawValues[`__display_${mergedCell.header}`] = mergedCell.displayValue;
    }
  }
  const formulas = Object.values(sourceRawValues)
    .filter((value) => typeof value === 'string' && /DISPIMG\s*\(/i.test(value));
  const sourceImageRefs = [...new Set(formulas.flatMap((formula) => (
    [...formula.matchAll(/DISPIMG\s*\(\s*["']([^"']+)["']/gi)].map((match) => match[1])
  )))];
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
  const remarks = readAllAliases(row, headerMap, HEADER_ALIASES.remark)
    .map((value) => textValue(value, 1000))
    .filter((value) => value && !/DISPIMG\s*\(/i.test(value));

  const dataQuality = {
    source: 'EXCEL_IMPORT',
    photoMappingStatus: sourceImageRefs.length > 0
      ? 'PENDING_WPS_CELL_IMAGE'
      : 'UNVERIFIED',
    exceptionTypes: [...new Set(exceptions.map(({ exceptionType }) => exceptionType))],
    mergedSourceRanges: [...new Set(mergedCells.map(({ range }) => range))],
    mergedSourceCells: mergedCells.map((cell) => ({ ...cell }))
  };

  return {
    sheetName,
    rowNumber,
    rawAssetCode: sourceAssetCode,
    rawValues: sourceRawValues,
    candidate: {
      assetCode,
      sourceAssetCode,
      sourceSequence: textValue(sequence, 100),
      assetType,
      majorCategoryName,
      equipmentTypeName,
      primaryName,
      secondaryName,
      sourceSheetName: textValue(sheetName, 100),
      sourceRowNumber: rowNumber,
      sourceRawValues,
      sourceImageRefs,
      productCode: textValue(readAlias(row, headerMap, HEADER_ALIASES.productCode), 500),
      plateNumber: textValue(readAlias(row, headerMap, HEADER_ALIASES.plateNumber), 100),
      serialNumber: textValue(readAlias(row, headerMap, HEADER_ALIASES.serialNumber), 500),
      brandSerialNumber: textValue(
        readAlias(row, headerMap, HEADER_ALIASES.brandSerialNumber),
        500
      ),
      name,
      categoryId: textValue(readAlias(row, headerMap, HEADER_ALIASES.categoryId), 100) || null,
      categoryName,
      specification,
      manufacturer: textValue(readAlias(row, headerMap, HEADER_ALIASES.manufacturer), 200),
      brand: textValue(readAlias(row, headerMap, HEADER_ALIASES.brand), 200),
      vehicleLength: textValue(readAlias(row, headerMap, HEADER_ALIASES.vehicleLength), 100),
      ratedCapacityText: textValue(
        readAlias(row, headerMap, HEADER_ALIASES.ratedCapacityText),
        100
      ),
      powerType: textValue(readAlias(row, headerMap, HEADER_ALIASES.powerType), 100),
      emissionStandard: textValue(
        readAlias(row, headerMap, HEADER_ALIASES.emissionStandard),
        100
      ),
      quantity: compatibilityQuantity,
      bookQuantity: accountQuantityResult.value,
      physicalQuantity: quantityResult.value,
      unit,
      acquisitionDate,
      productionDate: productionResult.value,
      productionDatePrecision: productionResult.precision,
      productionDateRaw: productionResult.raw,
      productionDateDisplay: productionResult.display,
      activationDate: activationResult.value,
      activationDatePrecision: activationResult.precision,
      activationDateRaw: activationResult.raw,
      activationDateDisplay: activationResult.display,
      idlePlacedAt: idlePlacedResult.value,
      idlePlacedAtRaw: idlePlacedResult.raw,
      idlePlacedAtDisplay: idlePlacedResult.display,
      originalValue: originalValueResult.value,
      orgUnitId: textValue(readAlias(row, headerMap, HEADER_ALIASES.orgUnitId), 100) || null,
      orgUnitName,
      custodianUserId: textValue(
        readAlias(row, headerMap, HEADER_ALIASES.custodianUserId),
        100
      ) || null,
      custodianName,
      custodianDisplayName: custodianName,
      orgUnitNameSnapshot: orgUnitName,
      location: textValue(readAlias(row, headerMap, HEADER_ALIASES.location), 500),
      status: statusResult.value,
      conditionText: textValue(readAlias(row, headerMap, HEADER_ALIASES.condition), 200),
      forkliftPosition: textValue(
        readAlias(row, headerMap, HEADER_ALIASES.forkliftPosition),
        100
      ),
      environmentalRegistrationCode: textValue(
        readAlias(row, headerMap, HEADER_ALIASES.environmentalRegistrationCode),
        200
      ),
      remark: remarks.join('\n').slice(0, 2000),
      photoFileIds: [],
      dataQuality
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
    cellDates: false,
    cellFormula: true,
    cellNF: true,
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
    const rows = worksheetRawRows(worksheet);
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
        sheetName,
        worksheet,
        mergedCells: mergedSourceCells({
          worksheet,
          headerRow,
          rowNumber: headerIndex + index + 2
        })
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
    sheetErrors,
    workbook
  };
}

function createEquipmentImportTemplateWorkbook() {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet([EQUIPMENT_TEMPLATE_HEADERS]);
  worksheet['!cols'] = EQUIPMENT_TEMPLATE_HEADERS.map((header) => ({
    wch: Math.min(36, Math.max(12, header.length + 2))
  }));
  XLSX.utils.book_append_sheet(workbook, worksheet, '设备台账模板');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = {
  EQUIPMENT_TEMPLATE_FIELD_KEYS,
  EQUIPMENT_TEMPLATE_HEADERS,
  HEADER_ALIASES,
  MAX_IMPORT_ROWS,
  buildException,
  canonicalCategory,
  createEquipmentImportTemplateWorkbook,
  normalizeHeader,
  parseDateValue,
  parseEquipmentWorkbook,
  parseSourceDateValue,
  textValue
};
