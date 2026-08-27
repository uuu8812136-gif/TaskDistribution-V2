'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const appRequire = require('../helpers/appRequire');

const ExcelJS = appRequire('exceljs');
const XLSX = appRequire('xlsx');
const {
  ATTACHMENT_SHEET_NAME,
  DETAIL_HEADERS,
  createExpiryExportWorkbook,
  createSupplierExportWorkbook,
  parseSettlementWorkbook,
  parseSupplierWorkbook
} = require('../../../app/services/contractWorkbookService');

const DETAIL_SHEET = '三级细表（供应商合同管理）';
const SUPPLIER_SHEET = '主表（供应商合同管理）';
const SETTLEMENT_SHEET = '供应商结算费用表';
const CUSTOMER_DETAIL_HEADERS = [
  '序号',
  '供应商编码',
  '供应商名称',
  '托管属性',
  '供方供货情况（正常供货/已停供）',
  '是否已有开票信息',
  '开票信息（支持文字或上传图片或PDF）',
  '厂家联系人（支持增加多人）',
  '联系电话（支持增加多人）',
  '对账邮箱',
  '未签合同原因批注（批注文字）',
  '备注（批注文字）',
  '供应商物流服务协议',
  '合同编号',
  '合同生效日期',
  '合同截止日期',
  '供应商签署合同日期',
  '载信签署合同日期',
  '载信给供应商回寄合同的日期',
  '载信给供应商回寄合同的快递单号',
  '合同交付给载信商务部的日期',
  '合同交付给济南变速箱厂的日期',
  '合同PDF（上传）',
  '合同是否自动顺延',
  '物流服务费用及支付方式协定',
  '合同是否自动顺延',
  '合同生效日期',
  '合同截止日期',
  '仓储服务费率',
  '超储服务费率',
  '超储天数',
  '结算周期',
  '备注',
  '周转器具服务协议',
  '合同是否自动顺延',
  '合同编号',
  '合同生效日期',
  '合同截止日期',
  '器具类型',
  '器具服务价格\n（元/个/次）',
  '供应商签署合同日期',
  '载信签署合同日期',
  '载信给供应商回寄合同的日期',
  '载信给供应商回寄合同的快递单号',
  '合同交付给载信商务部的日期',
  '合同交付给济南变速箱厂的日期',
  '备注',
  '器具租赁合同签订',
  '合同是否自动顺延',
  '合同编号',
  '合同生效日期',
  '合同截止日期',
  '租赁器具类型',
  '租赁器具规格',
  '租赁器具生产批次',
  '租赁器具颜色',
  '租赁数量',
  '合同PDF（上传）',
  '打款凭证（上传）',
  '备注'
];
const SETTLEMENT_HEADERS = [
  '序号',
  '月份',
  '供应商名称',
  '供应商编码',
  '产品上线金额（含税）',
  '仓储物流费（元）',
  '超储产品金额（含税）',
  '超储物流费（元）',
  '是否签订合同',
  '合同是否有效',
  '备注'
];

function supplierWorkbook({
  detailHeaders = CUSTOMER_DETAIL_HEADERS,
  detailRows = [],
  supplierRows = [[1, '供应商甲', '001078', '托管', '', '']]
} = {}) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['一级主表'],
    ['序号', '供应商名称', '供应商编码', '托管属性', '是否签订合同', '合同是否有效'],
    ...supplierRows
  ]), SUPPLIER_SHEET);
  const detailSheet = XLSX.utils.aoa_to_sheet([
    Array(60).fill(''),
    detailHeaders,
    ...detailRows.map((row) => row.length === 56
      ? [...row.slice(0, 3), '托管', ...row.slice(3)]
      : row)
  ]);
  XLSX.utils.book_append_sheet(workbook, detailSheet, DETAIL_SHEET);
  return { workbook, detailSheet };
}

function workbookBuffer(workbook) {
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

function extractedMedia(imagesByRow = new Map()) {
  return {
    imagesByRow,
    summary: {
      invalidMediaReferences: 0,
      wpsImageDefinitions: imagesByRow.size,
      wpsCellReferences: imagesByRow.size,
      uniqueWpsImageReferences: imagesByRow.size,
      unusedWpsImageDefinitions: [],
      drawingImages: 0,
      rowsWithImages: imagesByRow.size,
      referencedMediaBytes: 8,
      sanitizedMediaFiles: 0,
      sanitizedMediaReferences: 0,
      sanitizedBytesRemoved: 0,
      sanitizedMediaPaths: [],
      invalidMediaFiles: 0,
      invalidMediaPaths: []
    }
  };
}

test('exported detail headers exactly match the canonical 60-column tertiary workbook', () => {
  assert.deepEqual(DETAIL_HEADERS, CUSTOMER_DETAIL_HEADERS);
});

test('overstorage days imports arbitrary text and accepts the legacy constrained header', async () => {
  for (const [header, overstorageDays] of [
    ['超储天数', '无超储费用另议'],
    ['超储天数（无超储/30+15/60+15/90+15）', '免超储费']
  ]) {
    const headers = [...CUSTOMER_DETAIL_HEADERS];
    headers[30] = header;
    const row = Array(60).fill('');
    row[1] = '001078';
    row[2] = '供应商甲';
    row[3] = '托管';
    row[24] = '已签订';
    row[30] = overstorageDays;
    const { workbook } = supplierWorkbook({ detailHeaders: headers, detailRows: [row] });
    const parsed = parseSupplierWorkbook(workbookBuffer(workbook), {
      extractWorkbookMedia: () => extractedMedia()
    });
    const logistics = parsed.rows[0].records.find((record) => (
      record.category === 'LOGISTICS_FEE_AGREEMENT'
    ));
    assert.equal(logistics.details.overstorageDays, overstorageDays);
  }

  const supplier = {
    _id: 'overstorage-supplier', code: '001078', name: '供应商甲',
    trusteeAttribute: 'HOSTED', hasSignedContract: true, contractValid: true
  };
  for (const [storedValue, exportedValue] of [['90天', '90天'], ['NONE', '无超储']]) {
    const buffer = await createSupplierExportWorkbook({
      scope: 'detail',
      suppliers: [supplier],
      records: [{
        supplierId: supplier._id,
        category: 'LOGISTICS_FEE_AGREEMENT',
        signingStatus: 'SIGNED',
        details: { overstorageDays: storedValue },
        attachments: []
      }]
    });
    const exported = new ExcelJS.Workbook();
    await exported.xlsx.load(buffer);
    assert.equal(exported.getWorksheet(DETAIL_SHEET).getRow(3).getCell(31).value, exportedValue);
  }
});

test('customer 60-column row maps every non-attachment field to canonical records', () => {
  const legacyValues = [
    1, '001078', '供应商甲', '正常供货', '是', '开票抬头文字',
    '联系人甲；联系人乙', '13800000001；13800000002', 'a@example.com；b@example.com',
    '未签原因', '基础备注',
    '已签订', 'HT-001', '2026-01-01', '2026-12-31', '2025-12-20', '2025-12-21',
    '2025-12-22', 'SF-MAIN', '2025-12-23', '2025-12-24', '', '是',
    '已签订', '', '2026-02-01', '2026-11-30', '7‰', '8‰', '30+15', '月结', '费用备注',
    '已签订', '是', 'ZZ-001', '2026-03-01', '2026-10-31', '铁网框', '10元/个/次',
    '2026-02-20', '2026-02-21', '2026-02-22', 'SF-ZZ', '2026-02-23', '2026-02-24', '周转备注',
    '已签订', '否', 'ZL-001', '2026-04-01', '2026-09-30', '塑料托盘', '1200x1000',
    '2026-A', '蓝色', '30个', '', '', '租赁备注'
  ];
  const row = [...legacyValues.slice(0, 3), '托管', ...legacyValues.slice(3)];
  assert.equal(row.length, 60);
  const { workbook } = supplierWorkbook({ detailRows: [row] });
  const parsed = parseSupplierWorkbook(workbookBuffer(workbook), {
    extractWorkbookMedia: () => extractedMedia()
  });
  const records = new Map(parsed.rows[0].records.map((record) => [record.category, record]));
  const date = (value) => value?.toISOString().slice(0, 10);

  assert.equal(parsed.rows[0].supplierCode, '001078');
  assert.equal(parsed.suppliers[0].trusteeAttribute, 'HOSTED');
  assert.deepEqual(records.get('SUPPLIER_INFO').details, {
    supplyStatus: 'NORMAL',
    hasInvoiceInfo: true,
    invoiceInfoText: '开票抬头文字',
    contacts: [
      { name: '联系人甲', phone: '13800000001' },
      { name: '联系人乙', phone: '13800000002' }
    ],
    reconciliationEmails: ['a@example.com', 'b@example.com'],
    unsignedReason: '未签原因',
    remarks: '基础备注'
  });

  const main = records.get('MAIN_SERVICE_AGREEMENT');
  assert.equal(main.signingStatus, 'SIGNED');
  assert.equal(main.contractNumber, 'HT-001');
  assert.equal(date(main.effectiveDate), '2026-01-01');
  assert.equal(date(main.expiryDate), '2026-12-31');
  assert.equal(main.autoRenew, true);
  assert.deepEqual({
    ...main.details,
    supplierSignedDate: date(main.details.supplierSignedDate),
    companySignedDate: date(main.details.companySignedDate),
    returnDate: date(main.details.returnDate),
    deliveredBusinessDate: date(main.details.deliveredBusinessDate),
    deliveredFactoryDate: date(main.details.deliveredFactoryDate)
  }, {
    supplierSignedDate: '2025-12-20',
    companySignedDate: '2025-12-21',
    returnDate: '2025-12-22',
    courierNumber: 'SF-MAIN',
    deliveredBusinessDate: '2025-12-23',
    deliveredFactoryDate: '2025-12-24'
  });

  const logistics = records.get('LOGISTICS_FEE_AGREEMENT');
  assert.equal(logistics.signingStatus, 'SIGNED');
  assert.equal(logistics.autoRenew, null);
  assert.equal(date(logistics.effectiveDate), '2026-02-01');
  assert.equal(date(logistics.expiryDate), '2026-11-30');
  assert.deepEqual(logistics.details, {
    warehouseServiceRate: '7‰',
    overstorageServiceRate: '8‰',
    overstorageDays: '30+15',
    settlementCycle: '月结',
    remarks: '费用备注'
  });

  const turnover = records.get('TURNOVER_EQUIPMENT_SERVICE');
  assert.equal(turnover.signingStatus, 'SIGNED');
  assert.equal(turnover.autoRenew, true);
  assert.equal(turnover.contractNumber, 'ZZ-001');
  assert.equal(date(turnover.effectiveDate), '2026-03-01');
  assert.equal(date(turnover.expiryDate), '2026-10-31');
  assert.deepEqual({
    ...turnover.details,
    supplierSignedDate: date(turnover.details.supplierSignedDate),
    companySignedDate: date(turnover.details.companySignedDate),
    returnDate: date(turnover.details.returnDate),
    deliveredBusinessDate: date(turnover.details.deliveredBusinessDate),
    deliveredFactoryDate: date(turnover.details.deliveredFactoryDate)
  }, {
    equipmentType: '铁网框',
    equipmentServicePrice: '10元/个/次',
    supplierSignedDate: '2026-02-20',
    companySignedDate: '2026-02-21',
    returnDate: '2026-02-22',
    courierNumber: 'SF-ZZ',
    deliveredBusinessDate: '2026-02-23',
    deliveredFactoryDate: '2026-02-24',
    remarks: '周转备注'
  });

  const rental = records.get('EQUIPMENT_RENTAL');
  assert.equal(rental.signingStatus, 'SIGNED');
  assert.equal(rental.autoRenew, false);
  assert.equal(rental.contractNumber, 'ZL-001');
  assert.equal(date(rental.effectiveDate), '2026-04-01');
  assert.equal(date(rental.expiryDate), '2026-09-30');
  assert.deepEqual(rental.details, {
    equipmentType: '塑料托盘',
    specification: '1200x1000',
    productionBatch: '2026-A',
    color: '蓝色',
    quantity: '30个',
    remarks: '租赁备注'
  });
});

test('supplier import reports the worksheet row and column for invalid contract dates', () => {
  const row = Array(60).fill('');
  row[1] = 'DATE-001';
  row[2] = '日期错误供应商';
  row[3] = '托管';
  row[12] = '已签订';
  row[13] = 'DATE-001-MAIN';
  row[14] = '2026-02-30';
  row[15] = '2026-12-31';
  const { workbook } = supplierWorkbook({ detailRows: [row] });

  assert.throws(() => parseSupplierWorkbook(workbookBuffer(workbook), {
    extractWorkbookMedia: () => extractedMedia()
  }), (error) => {
    assert.equal(error.code, 'CONTRACT_IMPORT_DATE_INVALID');
    assert.match(error.message, /三级细表（供应商合同管理）第3行第15列/);
    assert.match(error.message, /合同生效日期/);
    assert.deepEqual(error.details, {
      sheetName: DETAIL_SHEET,
      rowNumber: 3,
      columnNumber: 15,
      columnLabel: '合同生效日期'
    });
    return true;
  });
});

test('contract dates accept editor ISO values and common US short dates', () => {
  const row = Array(60).fill('');
  row[1] = 'DATE-002';
  row[2] = '日期兼容供应商';
  row[3] = '托管';
  row[12] = '已签订';
  row[14] = '2026-08-22T00:00:00.000Z';
  row[15] = '08/22/27';
  const { workbook } = supplierWorkbook({ detailRows: [row] });
  const parsed = parseSupplierWorkbook(workbookBuffer(workbook), {
    extractWorkbookMedia: () => extractedMedia()
  });
  const main = parsed.rows[0].records.find((record) => record.category === 'MAIN_SERVICE_AGREEMENT');
  assert.equal(main.effectiveDate.toISOString().slice(0, 10), '2026-08-22');
  assert.equal(main.expiryDate.toISOString().slice(0, 10), '2027-08-22');
});

test('supplier import preserves a contract expiry date before its effective date and reports a warning', () => {
  const row = Array(60).fill('');
  row[1] = 'DATE-RANGE-001';
  row[2] = '日期区间供应商';
  row[3] = '托管';
  row[12] = '已签订';
  row[14] = '2028-08-01';
  row[15] = '2027-07-31';
  const { workbook } = supplierWorkbook({ detailRows: [row] });

  const parsed = parseSupplierWorkbook(workbookBuffer(workbook), {
    extractWorkbookMedia: () => extractedMedia()
  });
  const main = parsed.rows[0].records.find((record) => record.category === 'MAIN_SERVICE_AGREEMENT');
  assert.equal(main.effectiveDate.toISOString().slice(0, 10), '2028-08-01');
  assert.equal(main.expiryDate.toISOString().slice(0, 10), '2027-07-31');
  assert.equal(parsed.warnings.length, 1);
  assert.equal(parsed.warnings[0].code, 'CONTRACT_IMPORT_DATE_RANGE_INVALID');
  assert.match(parsed.warnings[0].message, /第3行第16列/);
  assert.match(parsed.warnings[0].message, /已按原数据导入/);
  assert.deepEqual(parsed.warnings[0].details, {
      sheetName: DETAIL_SHEET,
      rowNumber: 3,
      columnNumber: 16,
      columnLabel: '合同截止日期'
  });
});

test('supplier import accepts strict ISO dates and MM/DD/YY dates', () => {
  const row = Array(60).fill('');
  row[1] = 'DATE-FORMATS';
  row[2] = '日期格式供应商';
  row[3] = '托管';
  row[12] = '已签订';
  row[13] = 'DATE-FORMATS-MAIN';
  row[14] = '2026-08-21T12:30:00Z';
  row[15] = '08/22/26';
  const { workbook } = supplierWorkbook({ detailRows: [row] });
  const parsed = parseSupplierWorkbook(workbookBuffer(workbook), {
    extractWorkbookMedia: () => extractedMedia()
  });
  const [record] = parsed.rows[0].records;
  assert.equal(record.effectiveDate.toISOString().slice(0, 10), '2026-08-21');
  assert.equal(record.expiryDate.toISOString().slice(0, 10), '2026-08-22');
});

test('supplier import annotates non-date field errors with their worksheet cell', () => {
  const cases = [
    { column: 3, value: '未知属性' },
    { column: 4, value: '未知供货状态', setup: (row) => { row[3] = '托管'; } },
    { column: 5, value: '未知是否值', setup: (row) => { row[3] = '托管'; row[4] = '正常供货'; } },
    { column: 12, value: '未知签订状态', setup: (row) => { row[3] = '托管'; } },
    { column: 23, value: '未知顺延值', setup: (row) => { row[3] = '托管'; row[12] = '已签订'; } },
    { column: 30, value: 'x'.repeat(201), setup: (row) => { row[3] = '托管'; row[24] = '已签订'; } }
  ];
  for (const item of cases) {
    const row = Array(60).fill('');
    row[1] = 'FIELD-' + item.column;
    row[2] = '字段错误供应商';
    row[item.column] = item.value;
    item.setup?.(row);
    const { workbook } = supplierWorkbook({ detailRows: [row] });
    assert.throws(() => parseSupplierWorkbook(workbookBuffer(workbook), {
      extractWorkbookMedia: () => extractedMedia()
    }), (error) => {
      assert.equal(error.details?.rowNumber, 3);
      assert.equal(error.details?.columnNumber, item.column + 1);
      assert.equal(error.details?.columnLabel, CUSTOMER_DETAIL_HEADERS[item.column]);
      assert.match(error.message, new RegExp(`第3行第${item.column + 1}列`));
      return true;
    });
  }
});

test('tertiary import rejects an identity-only row instead of creating an orphan supplier', () => {
  const row = Array(60).fill('');
  row[0] = 1;
  row[1] = 'IDENTITY-ONLY';
  row[2] = '只有身份信息';
  row[3] = '托管';
  const { workbook } = supplierWorkbook({ detailRows: [row] });

  assert.throws(() => parseSupplierWorkbook(workbookBuffer(workbook), {
    extractWorkbookMedia: () => extractedMedia()
  }), (error) => error.code === 'CONTRACT_IMPORT_DETAIL_EMPTY');
});

test('empty contract template explains that data must be filled before import', () => {
  const { workbook } = supplierWorkbook({ detailRows: [] });

  assert.throws(() => parseSupplierWorkbook(workbookBuffer(workbook), {
    extractWorkbookMedia: () => extractedMedia()
  }), (error) => {
    assert.equal(error.code, 'CONTRACT_IMPORT_EMPTY');
    assert.equal(error.status, 400);
    assert.equal(error.message, '合同导入模板只有表头，请先填写供应商和合同明细后再导入');
    return true;
  });
});

test('supplier workbook keeps repeated supplier codes as separate history rows', () => {
  const rowA = Array(59).fill('');
  rowA[1] = '001078';
  rowA[2] = '供应商甲';
  rowA[3] = '托管';
  rowA[12] = '已签订';
  rowA[13] = 'HT-001';
  rowA[14] = '2026-01-01';
  rowA[15] = '2026-12-31';
  const rowB = [...rowA];
  rowB[13] = 'HT-002';
  rowB[14] = '2027-01-01';
  rowB[15] = '2027-12-31';
  const { workbook } = supplierWorkbook({ detailRows: [rowA, rowB] });

  const parsed = parseSupplierWorkbook(workbookBuffer(workbook), {
    extractWorkbookMedia: () => extractedMedia()
  });
  assert.equal(parsed.suppliers.length, 1);
  assert.equal(parsed.suppliers[0].code, '001078');
  assert.equal(parsed.rows.length, 2);
  assert.deepEqual(parsed.rows.map(({ records }) => records[0].contractNumber), ['HT-001', 'HT-002']);
});

test('tertiary sheet is the canonical supplier source and stale main-sheet rows are ignored', () => {
  const annotation = [
    '',
    '',
    '1.F列字段，根据三级细表判断是否有效。\n2.取最新的一条，如果自动顺延也视为有效。',
    '',
    '',
    ''
  ];
  const detailRow = Array(59).fill('');
  detailRow[1] = '001078';
  detailRow[2] = '供应商甲';
  detailRow[3] = '托管';
  detailRow[4] = '正常供货';
  const { workbook } = supplierWorkbook({ detailRows: [detailRow], supplierRows: [
    [1, '过期主表名称', 'OLD-CODE', '非托', '', ''],
    [], [], [],
    annotation
  ] });
  const parsed = parseSupplierWorkbook(workbookBuffer(workbook), {
    extractWorkbookMedia: () => extractedMedia()
  });
  assert.equal(parsed.suppliers.length, 1);
  assert.equal(parsed.suppliers[0].code, '001078');
  assert.equal(parsed.suppliers[0].name, '供应商甲');
  assert.equal(parsed.suppliers[0].trusteeAttribute, 'HOSTED');
});

test('WPS DISPIMG with #NAME? display in detail column G becomes invoice media instead of text', () => {
  const row = Array(59).fill('');
  row[1] = '001078';
  row[2] = '供应商甲';
  row[3] = '托管';
  row[4] = '正常供货';
  row[5] = '是';
  row[6] = '=DISPIMG("ID_INVOICE",1)';
  const { workbook, detailSheet } = supplierWorkbook({ detailRows: [row] });
  detailSheet.G3 = {
    t: 's',
    v: '#NAME?',
    w: '#NAME?',
    f: 'DISPIMG("ID_INVOICE",1)'
  };
  const image = {
    isValid: true,
    sourceKind: 'WPS_CELL_IMAGE',
    cellAddress: 'G3',
    imageRef: 'ID_INVOICE',
    mediaPath: 'xl/media/invoice.png',
    mimeType: 'image/png',
    extension: '.png',
    buffer: Buffer.from('invoice')
  };

  const parsed = parseSupplierWorkbook(workbookBuffer(workbook), {
    extractWorkbookMedia: () => extractedMedia(new Map([
      [`${DETAIL_SHEET}\u00003`, [image]]
    ]))
  });
  const info = parsed.rows[0].records.find(({ category }) => category === 'SUPPLIER_INFO');
  assert.equal(info.details.invoiceInfoText, '');
  assert.deepEqual(info.importedMedia, [image]);
});

test('DISPIMG formula without its media is rejected instead of silently imported blank', () => {
  const row = Array(59).fill('');
  row[1] = '001078';
  row[2] = '供应商甲';
  row[3] = '托管';
  row[6] = '=DISPIMG("ID_MISSING",1)';
  const { workbook, detailSheet } = supplierWorkbook({ detailRows: [row] });
  detailSheet.G3 = {
    t: 's',
    v: '#NAME?',
    w: '#NAME?',
    f: 'DISPIMG("ID_MISSING",1)'
  };

  assert.throws(() => parseSupplierWorkbook(workbookBuffer(workbook), {
    extractWorkbookMedia: () => extractedMedia()
  }), (error) => error.code === 'CONTRACT_IMPORT_MEDIA_MISSING');
});

test('drawing images are accepted only from invoice column G and attachment columns fail closed', () => {
  const row = Array(59).fill('');
  row[1] = '001078';
  row[2] = '供应商甲';
  row[3] = '托管';
  row[4] = '正常供货';
  const { workbook } = supplierWorkbook({ detailRows: [row] });
  const invoice = {
    isValid: true,
    sourceKind: 'DRAWING',
    cellAddress: 'G3',
    imageRef: 'DRAWING:G3',
    mediaPath: 'xl/media/invoice.png',
    mimeType: 'image/png',
    extension: '.png',
    buffer: Buffer.from('invoice')
  };
  const unrelated = { ...invoice, cellAddress: 'H3', imageRef: 'DRAWING:H3' };
  const parsed = parseSupplierWorkbook(workbookBuffer(workbook), {
    extractWorkbookMedia: () => extractedMedia(new Map([[
      `${DETAIL_SHEET}\u00003`, [invoice, unrelated]
    ]]))
  });
  const info = parsed.rows[0].records.find(({ category }) => category === 'SUPPLIER_INFO');
  assert.deepEqual(info.importedMedia, [invoice]);

  const unsupported = { ...invoice, cellAddress: 'W3', imageRef: 'DRAWING:W3' };
  assert.throws(() => parseSupplierWorkbook(workbookBuffer(workbook), {
    extractWorkbookMedia: () => extractedMedia(new Map([[
      `${DETAIL_SHEET}\u00003`, [unsupported]
    ]]))
  }), (error) => error.code === 'CONTRACT_IMPORT_ATTACHMENT_UNRESOLVED');
});

test('contract workbook rejects a missing or renamed header in any of its 60 columns', () => {
  for (let columnIndex = 0; columnIndex < CUSTOMER_DETAIL_HEADERS.length; columnIndex += 1) {
    for (const invalidHeader of ['', `错误列-${columnIndex + 1}`]) {
      const headers = [...CUSTOMER_DETAIL_HEADERS];
      headers[columnIndex] = invalidHeader;
      const row = Array(59).fill('');
      row[1] = '001078';
      row[2] = '供应商甲';
      row[11] = '已签订';
      const { workbook } = supplierWorkbook({ detailHeaders: headers, detailRows: [row] });

      assert.throws(() => parseSupplierWorkbook(workbookBuffer(workbook), {
        extractWorkbookMedia: () => extractedMedia()
      }), (error) => error.code === 'CONTRACT_IMPORT_TEMPLATE_INVALID');
    }
  }
});

test('contract workbook header errors expose the exact worksheet cell', () => {
  const headers = [...CUSTOMER_DETAIL_HEADERS];
  headers[48] = '错误的顺延列名';
  const row = Array(60).fill('');
  row[1] = 'HEADER-001';
  row[2] = '表头错误供应商';
  row[3] = '托管';
  const { workbook } = supplierWorkbook({ detailHeaders: headers, detailRows: [row] });

  assert.throws(() => parseSupplierWorkbook(workbookBuffer(workbook), {
    extractWorkbookMedia: () => extractedMedia()
  }), (error) => {
    assert.equal(error.code, 'CONTRACT_IMPORT_TEMPLATE_INVALID');
    assert.deepEqual(error.details, {
      sheetName: DETAIL_SHEET,
      rowNumber: 2,
      columnNumber: 49,
      columnLabel: '合同是否自动顺延'
    });
    return true;
  });
});

test('settlement workbook rejects duplicate normalized month and supplier code as one batch', () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    SETTLEMENT_HEADERS,
    [1, '2026/8', '供应商甲', '001078', 1, 2, 3, 4, '', '', ''],
    [2, '2026-08', '供应商甲', '001078', 5, 6, 7, 8, '', '', '']
  ]), SETTLEMENT_SHEET);

  assert.throws(
    () => parseSettlementWorkbook(workbookBuffer(workbook)),
    (error) => error.code === 'CONTRACT_SETTLEMENT_DUPLICATE_IN_FILE'
  );
});

test('settlement workbook rejects a missing or renamed header in any of its 11 columns', () => {
  for (let columnIndex = 0; columnIndex < SETTLEMENT_HEADERS.length; columnIndex += 1) {
    for (const invalidHeader of ['', `错误列-${columnIndex + 1}`]) {
      const headers = [...SETTLEMENT_HEADERS];
      headers[columnIndex] = invalidHeader;
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
        headers,
        [1, '2026-08', '供应商甲', '001078', 1, 2, 3, 4, '', '', '']
      ]), SETTLEMENT_SHEET);

      assert.throws(
        () => parseSettlementWorkbook(workbookBuffer(workbook)),
        (error) => error.code === 'CONTRACT_SETTLEMENT_TEMPLATE_INVALID'
      );
    }
  }
});

test('settlement Excel serial 45870 normalizes to month 2025-08', () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    SETTLEMENT_HEADERS,
    [1, 45870, '供应商甲', '001078', 1, 2, 3, 4, '', '', '']
  ]), SETTLEMENT_SHEET);

  const rows = parseSettlementWorkbook(workbookBuffer(workbook));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].month, '2025-08');
});

test('detail supplier is imported without a matching supplier main-sheet row', () => {
  const row = Array(59).fill('');
  row[1] = '009999';
  row[2] = '明细独有供应商';
  row[3] = '托管';
  row[4] = '正常供货';
  const { workbook } = supplierWorkbook({ detailRows: [row], supplierRows: [] });

  const parsed = parseSupplierWorkbook(workbookBuffer(workbook), {
    extractWorkbookMedia: () => extractedMedia()
  });
  assert.equal(parsed.suppliers[0].code, '009999');
  assert.equal(parsed.suppliers[0].name, '明细独有供应商');
});

test('every populated contract group requires an explicit signing status', () => {
  const populatedColumns = [12, 24, 33, 47];
  for (const columnIndex of populatedColumns) {
    const row = Array(59).fill('');
    row[1] = '001078';
    row[2] = '供应商甲';
    row[3] = '托管';
      row[columnIndex === 12 ? 13 : columnIndex === 24 ? 26 : columnIndex === 33 ? 35 : 49] = columnIndex === 24 ? '2026-01-01' : `VALUE-${columnIndex}`;
    const { workbook } = supplierWorkbook({ detailRows: [row] });

    assert.throws(() => parseSupplierWorkbook(workbookBuffer(workbook), {
      extractWorkbookMedia: () => extractedMedia()
    }), (error) => error.code === 'CONTRACT_IMPORT_SIGNING_STATUS_REQUIRED');
  }
});

test('unresolved attachment cells W, BF and BG are rejected instead of silently discarded', () => {
  for (const columnIndex of [22, 57, 58]) {
    const row = Array(59).fill('');
    row[1] = '001078';
    row[2] = '供应商甲';
    row[3] = '托管';
    row[columnIndex < 44 ? 12 : 47] = '已签订';
    row[columnIndex] = `unresolved-${columnIndex + 1}.pdf`;
    const { workbook } = supplierWorkbook({ detailRows: [row] });

    assert.throws(() => parseSupplierWorkbook(workbookBuffer(workbook), {
      extractWorkbookMedia: () => extractedMedia()
    }), (error) => error.code === 'CONTRACT_IMPORT_ATTACHMENT_UNRESOLVED');
  }
});

test('expiry export localizes category and alert enums for customers', async () => {
  const buffer = await createExpiryExportWorkbook([{
    supplierCode: '001078',
    supplierName: '供应商甲',
    category: 'TURNOVER_EQUIPMENT_SERVICE',
    contractNumber: 'ZZ-001',
    effectiveDate: new Date('2025-01-01T00:00:00.000Z'),
    expiryDate: new Date('2025-12-31T00:00:00.000Z'),
    remainingDays: -1,
    autoRenew: false,
    alertLevel: 'EXPIRED'
  }]);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const row = workbook.getWorksheet('合同到期预警').getRow(2);

  assert.equal(row.getCell(4).value, '周转器具服务协议');
  assert.equal(row.getCell(10).value, '已过期');
});

test('filtered supplier export stays canonical and writes trustee attribute in column D', async () => {
  const supplier = {
    _id: 'supplier-1',
    code: '001078',
    name: '供应商甲',
    trusteeAttribute: 'HOSTED',
    hasSignedContract: true,
    contractValid: true
  };
  const buffer = await createSupplierExportWorkbook({
    scope: 'detail',
    suppliers: [supplier],
    category: 'LOGISTICS_FEE_AGREEMENT',
    records: [{
      supplierId: 'supplier-1',
      category: 'LOGISTICS_FEE_AGREEMENT',
      signingStatus: 'SIGNED',
      contractNumber: '',
      effectiveDate: new Date('2025-01-01T00:00:00.000Z'),
      expiryDate: new Date('2025-12-31T00:00:00.000Z'),
      autoRenew: true,
      details: {},
      attachments: []
    }]
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.getWorksheet(DETAIL_SHEET);

  assert.equal(sheet.columnCount, 60);
  assert.equal(sheet.getRow(2).getCell(4).value, '托管属性');
  assert.equal(sheet.getRow(3).getCell(4).value, '托管');
  assert.equal(sheet.getRow(2).getCell(60).value, '备注');
});

test('unfiltered detail export merges all categories into one supplier row without hiding history or attachments', async () => {
  const supplier = {
    _id: 'supplier-merged-detail',
    code: '001079',
    name: '汇总供应商',
    trusteeAttribute: 'HOSTED',
    hasSignedContract: true,
    contractValid: true
  };
  const base = { supplierId: supplier._id, attachments: [] };
  const records = [
    {
      ...base,
      category: 'SUPPLIER_INFO',
      details: { supplyStatus: 'NORMAL', contacts: [{ name: '张三', phone: '13800000000' }] }
    },
    {
      ...base,
      category: 'MAIN_SERVICE_AGREEMENT',
      signingStatus: 'SIGNED',
      contractNumber: 'MAIN-NEW',
      effectiveDate: new Date('2026-01-01T00:00:00.000Z'),
      expiryDate: new Date('2026-12-31T00:00:00.000Z'),
      autoRenew: true,
      details: { courierNumber: 'SF-NEW' },
      attachments: [{ purpose: 'CONTRACT_PDF', originalName: 'main-new.pdf' }]
    },
    {
      ...base,
      category: 'MAIN_SERVICE_AGREEMENT',
      signingStatus: 'SIGNED',
      contractNumber: 'MAIN-OLD',
      effectiveDate: new Date('2025-01-01T00:00:00.000Z'),
      expiryDate: new Date('2025-12-31T00:00:00.000Z'),
      autoRenew: false,
      details: { courierNumber: 'SF-OLD' },
      attachments: [{ purpose: 'CONTRACT_PDF', originalName: 'main-old.pdf' }]
    },
    {
      ...base,
      category: 'LOGISTICS_FEE_AGREEMENT',
      signingStatus: 'SIGNED',
      effectiveDate: new Date('2026-02-01T00:00:00.000Z'),
      expiryDate: new Date('2026-11-30T00:00:00.000Z'),
      autoRenew: false,
      details: { warehouseServiceRate: '10元/件', settlementCycle: '月结' }
    },
    {
      ...base,
      category: 'TURNOVER_EQUIPMENT_SERVICE',
      signingStatus: 'SIGNED',
      contractNumber: 'TURN-001',
      effectiveDate: new Date('2026-03-01T00:00:00.000Z'),
      expiryDate: new Date('2026-10-31T00:00:00.000Z'),
      autoRenew: true,
      details: { equipmentType: '周转箱' }
    },
    {
      ...base,
      category: 'EQUIPMENT_RENTAL',
      signingStatus: 'SIGNED',
      contractNumber: 'RENT-001',
      effectiveDate: new Date('2026-04-01T00:00:00.000Z'),
      expiryDate: new Date('2026-09-30T00:00:00.000Z'),
      autoRenew: false,
      details: { equipmentType: '租赁托盘', quantity: 20 }
    }
  ];
  const buffer = await createSupplierExportWorkbook({ scope: 'detail', suppliers: [supplier], records });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const details = workbook.getWorksheet(DETAIL_SHEET);
  const row = details.getRow(3);

  assert.equal(details.columnCount, 60);
  assert.equal(details.rowCount, 3);
  assert.equal(row.getCell(2).value, supplier.code);
  assert.equal(row.getCell(8).value, '张三');
  assert.equal(row.getCell(14).value, 'MAIN-NEW；MAIN-OLD');
  assert.equal(row.getCell(20).value, 'SF-NEW；SF-OLD');
  assert.equal(row.getCell(29).value, '10元/件');
  assert.equal(row.getCell(32).value, '月结');
  assert.equal(row.getCell(36).value, 'TURN-001');
  assert.equal(row.getCell(39).value, '周转箱');
  assert.equal(row.getCell(50).value, 'RENT-001');
  assert.equal(row.getCell(53).value, '租赁托盘');
  assert.equal(row.getCell(57).value, 20);

  const attachments = workbook.getWorksheet(ATTACHMENT_SHEET_NAME);
  assert.equal(attachments.rowCount, 3);
  assert.equal(attachments.getRow(2).getCell(6).value, 'main-new.pdf');
  assert.equal(attachments.getRow(3).getCell(6).value, 'main-old.pdf');
});

test('canonical 60-column supplier export can be imported back without identity or contract drift', async () => {
  const supplier = {
    _id: 'supplier-roundtrip',
    code: '000178',
    name: '往返供应商',
    trusteeAttribute: 'NON_HOSTED',
    hasSignedContract: false,
    contractValid: true
  };
  const sourceRecord = {
    supplierId: supplier._id,
    category: 'MAIN_SERVICE_AGREEMENT',
    signingStatus: 'UNSIGNED',
    contractNumber: 'ROUNDTRIP-001',
    effectiveDate: new Date('2026-01-01T00:00:00.000Z'),
    expiryDate: new Date('2027-12-31T00:00:00.000Z'),
    autoRenew: true,
    details: {
      supplierSignedDate: new Date('2025-12-20T00:00:00.000Z'),
      courierNumber: 'SF-ROUNDTRIP'
    },
    attachments: []
  };
  const buffer = await createSupplierExportWorkbook({
    scope: 'detail',
    suppliers: [supplier],
    records: [sourceRecord]
  });
  const parsed = parseSupplierWorkbook(buffer, {
    extractWorkbookMedia: () => extractedMedia()
  });

  assert.deepEqual(parsed.suppliers, [{
    code: supplier.code,
    name: supplier.name,
    trusteeAttribute: supplier.trusteeAttribute
  }]);
  assert.equal(parsed.rows.length, 1);
  const [record] = parsed.rows[0].records;
  assert.equal(record.category, sourceRecord.category);
  assert.equal(record.signingStatus, sourceRecord.signingStatus);
  assert.equal(record.contractNumber, sourceRecord.contractNumber);
  assert.equal(record.effectiveDate.toISOString().slice(0, 10), '2026-01-01');
  assert.equal(record.expiryDate.toISOString().slice(0, 10), '2027-12-31');
  assert.equal(record.autoRenew, true);
  assert.equal(record.details.courierNumber, 'SF-ROUNDTRIP');
});

test('canonical detail remains reimportable when attachments are listed on a separate non-import sheet', async () => {
  const supplier = {
    _id: 'supplier-attachment-roundtrip',
    code: '000179',
    name: '附件往返供应商',
    trusteeAttribute: 'HOSTED',
    hasSignedContract: true,
    contractValid: true
  };
  const sourceRecord = {
    supplierId: supplier._id,
    category: 'MAIN_SERVICE_AGREEMENT',
    signingStatus: 'SIGNED',
    contractNumber: 'ATTACHMENT-001',
    effectiveDate: new Date('2026-01-01T00:00:00.000Z'),
    expiryDate: new Date('2027-12-31T00:00:00.000Z'),
    autoRenew: false,
    details: {},
    attachments: [{ purpose: 'CONTRACT_PDF', originalName: 'main-contract.pdf' }]
  };
  const buffer = await createSupplierExportWorkbook({
    scope: 'detail',
    suppliers: [supplier],
    records: [sourceRecord]
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  assert.equal(workbook.getWorksheet(DETAIL_SHEET).getRow(3).getCell(23).value, '');
  const attachmentSheet = workbook.getWorksheet(ATTACHMENT_SHEET_NAME);
  assert.equal(attachmentSheet.getRow(2).getCell(1).value, supplier.code);
  assert.equal(attachmentSheet.getRow(2).getCell(6).value, 'main-contract.pdf');

  const parsed = parseSupplierWorkbook(buffer, {
    extractWorkbookMedia: () => extractedMedia()
  });
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].records[0].contractNumber, sourceRecord.contractNumber);
  assert.deepEqual(parsed.rows[0].records[0].importedMedia, []);
});

test('supplier export scopes create only the requested workbook level', async () => {
  const supplier = {
    _id: 'supplier-scoped-export',
    code: '000180',
    name: '分层导出供应商',
    trusteeAttribute: 'HOSTED',
    hasSignedContract: true,
    contractValid: true
  };
  const records = [{
    supplierId: supplier._id,
    category: 'MAIN_SERVICE_AGREEMENT',
    signingStatus: 'SIGNED',
    contractNumber: 'SCOPE-001',
    effectiveDate: new Date('2026-01-01T00:00:00.000Z'),
    expiryDate: new Date('2027-12-31T00:00:00.000Z'),
    autoRenew: false,
    details: {},
    attachments: [{ purpose: 'CONTRACT_PDF', originalName: 'scope.pdf' }]
  }];

  const overviewWorkbook = new ExcelJS.Workbook();
  await overviewWorkbook.xlsx.load(await createSupplierExportWorkbook({
    scope: 'overview', suppliers: [supplier], records
  }));
  assert.deepEqual(overviewWorkbook.worksheets.map(({ name }) => name), [SUPPLIER_SHEET]);

  const secondaryWorkbook = new ExcelJS.Workbook();
  await secondaryWorkbook.xlsx.load(await createSupplierExportWorkbook({
    scope: 'secondary', suppliers: [supplier], records
  }));
  assert.deepEqual(secondaryWorkbook.worksheets.map(({ name }) => name), [
    '二级细表（供应商合同管理）'
  ]);
  assert.equal(secondaryWorkbook.worksheets[0].getRow(3).getCell(5).value, 1);

  const detailWorkbook = new ExcelJS.Workbook();
  await detailWorkbook.xlsx.load(await createSupplierExportWorkbook({
    scope: 'detail', suppliers: [supplier], records
  }));
  assert.deepEqual(detailWorkbook.worksheets.map(({ name }) => name), [
    DETAIL_SHEET,
    ATTACHMENT_SHEET_NAME
  ]);
  assert.equal(detailWorkbook.getWorksheet(DETAIL_SHEET).columnCount, 60);
});

test('attachment sheet is omitted outside detail scope and when detail has no attachments', async () => {
  const supplier = {
    _id: 'supplier-no-attachment', code: '000181', name: '无附件供应商',
    trusteeAttribute: 'NON_HOSTED', hasSignedContract: false, contractValid: false
  };
  const records = [{
    supplierId: supplier._id,
    category: 'SUPPLIER_INFO',
    signingStatus: null,
    contractNumber: '',
    effectiveDate: null,
    expiryDate: null,
    autoRenew: false,
    details: {},
    attachments: []
  }];
  for (const scope of ['overview', 'secondary', 'detail']) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await createSupplierExportWorkbook({ scope, suppliers: [supplier], records }));
    assert.equal(workbook.getWorksheet(ATTACHMENT_SHEET_NAME), undefined);
  }
});
