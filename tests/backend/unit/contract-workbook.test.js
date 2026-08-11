'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const appRequire = require('../helpers/appRequire');

const ExcelJS = appRequire('exceljs');
const XLSX = appRequire('xlsx');
const {
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
  '合同生效日期',
  '合同截止日期',
  '仓储服务费率',
  '超储服务费率',
  '超储天数（无超储/30+15/60+15/90+15）',
  '结算周期',
  '备注',
  '周转器具服务协议',
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
    Array(56).fill(''),
    detailHeaders,
    ...detailRows
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

test('exported detail headers exactly match the 56 headers in the customer workbook', () => {
  assert.deepEqual(DETAIL_HEADERS, CUSTOMER_DETAIL_HEADERS);
});

test('customer 56-column row maps every non-attachment field to canonical records', () => {
  const row = [
    1, '001078', '供应商甲', '正常供货', '是', '开票抬头文字',
    '联系人甲；联系人乙', '13800000001；13800000002', 'a@example.com；b@example.com',
    '未签原因', '基础备注',
    '已签订', 'HT-001', '2026-01-01', '2026-12-31', '2025-12-20', '2025-12-21',
    '2025-12-22', 'SF-MAIN', '2025-12-23', '2025-12-24', '', '是',
    '已签订', '2026-02-01', '2026-11-30', '7‰', '8‰', '30+15', '月结', '费用备注',
    '已签订', 'ZZ-001', '2026-03-01', '2026-10-31', '铁网框', '10元/个/次',
    '2026-02-20', '2026-02-21', '2026-02-22', 'SF-ZZ', '2026-02-23', '2026-02-24', '周转备注',
    '已签订', 'ZL-001', '2026-04-01', '2026-09-30', '塑料托盘', '1200x1000',
    '2026-A', '蓝色', '30个', '', '', '租赁备注'
  ];
  assert.equal(row.length, 56);
  const { workbook } = supplierWorkbook({ detailRows: [row] });
  const parsed = parseSupplierWorkbook(workbookBuffer(workbook), {
    extractWorkbookMedia: () => extractedMedia()
  });
  const records = new Map(parsed.rows[0].records.map((record) => [record.category, record]));
  const date = (value) => value?.toISOString().slice(0, 10);

  assert.equal(parsed.rows[0].supplierCode, '001078');
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

test('supplier workbook keeps repeated supplier codes as separate history rows', () => {
  const rowA = Array(56).fill('');
  rowA[1] = '001078';
  rowA[2] = '供应商甲';
  rowA[11] = '已签订';
  rowA[12] = 'HT-001';
  rowA[13] = '2026-01-01';
  rowA[14] = '2026-12-31';
  const rowB = [...rowA];
  rowB[12] = 'HT-002';
  rowB[13] = '2027-01-01';
  rowB[14] = '2027-12-31';
  const { workbook } = supplierWorkbook({ detailRows: [rowA, rowB] });

  const parsed = parseSupplierWorkbook(workbookBuffer(workbook), {
    extractWorkbookMedia: () => extractedMedia()
  });
  assert.equal(parsed.suppliers.length, 1);
  assert.equal(parsed.suppliers[0].code, '001078');
  assert.equal(parsed.rows.length, 2);
  assert.deepEqual(parsed.rows.map(({ records }) => records[0].contractNumber), ['HT-001', 'HT-002']);
});

test('customer main-sheet trailing annotation is ignored while incomplete supplier rows still fail', () => {
  const annotation = [
    '',
    '',
    '1.F列字段，根据三级细表判断是否有效。\n2.取最新的一条，如果自动顺延也视为有效。',
    '',
    '',
    ''
  ];
  const { workbook } = supplierWorkbook({ supplierRows: [
    [1, '供应商甲', '001078', '托管', '', ''],
    [], [], [],
    annotation
  ] });
  const parsed = parseSupplierWorkbook(workbookBuffer(workbook), {
    extractWorkbookMedia: () => extractedMedia()
  });
  assert.equal(parsed.suppliers.length, 1);
  assert.equal(parsed.suppliers[0].code, '001078');

  const invalid = supplierWorkbook({ supplierRows: [
    [1, '', 'SHORT-CODE', '', '', '']
  ] });
  assert.throws(() => parseSupplierWorkbook(workbookBuffer(invalid.workbook), {
    extractWorkbookMedia: () => extractedMedia()
  }), (error) => error.code === 'CONTRACT_IMPORT_SUPPLIER_INVALID');
});

test('WPS DISPIMG with #NAME? display in detail column F becomes invoice media instead of text', () => {
  const row = Array(56).fill('');
  row[1] = '001078';
  row[2] = '供应商甲';
  row[3] = '正常供货';
  row[4] = '是';
  row[5] = '=DISPIMG("ID_INVOICE",1)';
  const { workbook, detailSheet } = supplierWorkbook({ detailRows: [row] });
  detailSheet.F3 = {
    t: 's',
    v: '#NAME?',
    w: '#NAME?',
    f: 'DISPIMG("ID_INVOICE",1)'
  };
  const image = {
    isValid: true,
    sourceKind: 'WPS_CELL_IMAGE',
    cellAddress: 'F3',
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
  const row = Array(56).fill('');
  row[1] = '001078';
  row[2] = '供应商甲';
  row[5] = '=DISPIMG("ID_MISSING",1)';
  const { workbook, detailSheet } = supplierWorkbook({ detailRows: [row] });
  detailSheet.F3 = {
    t: 's',
    v: '#NAME?',
    w: '#NAME?',
    f: 'DISPIMG("ID_MISSING",1)'
  };

  assert.throws(() => parseSupplierWorkbook(workbookBuffer(workbook), {
    extractWorkbookMedia: () => extractedMedia()
  }), (error) => error.code === 'CONTRACT_IMPORT_MEDIA_MISSING');
});

test('drawing images are accepted only from invoice column F and attachment columns fail closed', () => {
  const row = Array(56).fill('');
  row[1] = '001078';
  row[2] = '供应商甲';
  row[3] = '正常供货';
  const { workbook } = supplierWorkbook({ detailRows: [row] });
  const invoice = {
    isValid: true,
    sourceKind: 'DRAWING',
    cellAddress: 'F3',
    imageRef: 'DRAWING:F3',
    mediaPath: 'xl/media/invoice.png',
    mimeType: 'image/png',
    extension: '.png',
    buffer: Buffer.from('invoice')
  };
  const unrelated = { ...invoice, cellAddress: 'G3', imageRef: 'DRAWING:G3' };
  const parsed = parseSupplierWorkbook(workbookBuffer(workbook), {
    extractWorkbookMedia: () => extractedMedia(new Map([[
      `${DETAIL_SHEET}\u00003`, [invoice, unrelated]
    ]]))
  });
  const info = parsed.rows[0].records.find(({ category }) => category === 'SUPPLIER_INFO');
  assert.deepEqual(info.importedMedia, [invoice]);

  const unsupported = { ...invoice, cellAddress: 'V3', imageRef: 'DRAWING:V3' };
  assert.throws(() => parseSupplierWorkbook(workbookBuffer(workbook), {
    extractWorkbookMedia: () => extractedMedia(new Map([[
      `${DETAIL_SHEET}\u00003`, [unsupported]
    ]]))
  }), (error) => error.code === 'CONTRACT_IMPORT_ATTACHMENT_UNRESOLVED');
});

test('contract workbook rejects a missing or renamed header in any of its 56 columns', () => {
  for (let columnIndex = 0; columnIndex < CUSTOMER_DETAIL_HEADERS.length; columnIndex += 1) {
    for (const invalidHeader of ['', `错误列-${columnIndex + 1}`]) {
      const headers = [...CUSTOMER_DETAIL_HEADERS];
      headers[columnIndex] = invalidHeader;
      const row = Array(56).fill('');
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

test('detail supplier must already exist in the supplier main sheet', () => {
  const row = Array(56).fill('');
  row[1] = '009999';
  row[2] = '明细独有供应商';
  row[3] = '正常供货';
  const { workbook } = supplierWorkbook({ detailRows: [row] });

  assert.throws(() => parseSupplierWorkbook(workbookBuffer(workbook), {
    extractWorkbookMedia: () => extractedMedia()
  }), (error) => error.code === 'CONTRACT_IMPORT_SUPPLIER_NOT_IN_MAIN');
});

test('every populated contract group requires an explicit signing status', () => {
  const populatedColumns = [12, 24, 32, 45];
  for (const columnIndex of populatedColumns) {
    const row = Array(56).fill('');
    row[1] = '001078';
    row[2] = '供应商甲';
    row[columnIndex] = columnIndex === 24 ? '2026-01-01' : `VALUE-${columnIndex}`;
    const { workbook } = supplierWorkbook({ detailRows: [row] });

    assert.throws(() => parseSupplierWorkbook(workbookBuffer(workbook), {
      extractWorkbookMedia: () => extractedMedia()
    }), (error) => error.code === 'CONTRACT_IMPORT_SIGNING_STATUS_REQUIRED');
  }
});

test('unresolved attachment cells V, BB and BC are rejected instead of silently discarded', () => {
  for (const columnIndex of [21, 53, 54]) {
    const row = Array(56).fill('');
    row[1] = '001078';
    row[2] = '供应商甲';
    row[columnIndex < 44 ? 11 : 44] = '已签订';
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

test('filtered supplier export preserves auto-renew for non-main contract categories', async () => {
  const supplier = {
    _id: 'supplier-1',
    code: '001078',
    name: '供应商甲',
    trusteeAttribute: 'HOSTED',
    hasSignedContract: true,
    contractValid: true
  };
  const buffer = await createSupplierExportWorkbook({
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
  const sheet = workbook.getWorksheet('合同明细');

  assert.equal(sheet.getRow(1).getCell(57).value, '当前记录是否自动顺延（扩展）');
  assert.equal(sheet.getRow(2).getCell(57).value, '是');
});
