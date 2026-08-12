'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const appRequire = require('../helpers/appRequire');

const XLSX = appRequire('xlsx');
const { SESSION_MODES } = require('../../../app/config/permissions');
const {
  createImportTemplateController
} = require('../../../app/controllers/importTemplateController');
const {
  createImportTemplatesRouter
} = require('../../../app/routes/importTemplates');
const {
  TEMPLATE_DEFINITIONS,
  XLSX_CONTENT_TYPE,
  createImportTemplateService
} = require('../../../app/services/importTemplateService');
const {
  EQUIPMENT_TEMPLATE_HEADERS,
  HEADER_ALIASES,
  parseEquipmentWorkbook
} = require('../../../app/services/equipmentImportParser');
const {
  DETAIL_HEADERS,
  DETAIL_SHEET_NAME,
  SETTLEMENT_HEADERS,
  SETTLEMENT_SHEET_NAME,
  parseSettlementWorkbook,
  parseSupplierWorkbook
} = require('../../../app/services/contractWorkbookService');

function context(permissionKeys, overrides = {}) {
  return {
    authenticated: true,
    mode: SESSION_MODES.TEAM,
    activeTeamId: '507f1f77bcf86cd799439011',
    permissionKeys,
    canAccessBusiness: true,
    readOnly: false,
    ...overrides
  };
}

async function download(id, permissionKeys) {
  return createImportTemplateService().download({
    authContext: context(permissionKeys),
    templateId: id
  });
}

function workbookFrom(buffer) {
  return XLSX.read(buffer, { type: 'buffer', cellDates: true });
}

function setRow(workbook, sheetName, rowIndex, values) {
  const sheet = workbook.Sheets[sheetName];
  values.forEach((value, columnIndex) => {
    sheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })] = {
      t: typeof value === 'number' ? 'n' : 's',
      v: value
    };
  });
  const oldRange = XLSX.utils.decode_range(sheet['!ref']);
  oldRange.e.r = Math.max(oldRange.e.r, rowIndex);
  oldRange.e.c = Math.max(oldRange.e.c, values.length - 1);
  sheet['!ref'] = XLSX.utils.encode_range(oldRange);
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

test('template catalog contains exactly the three real import entries and filters by view or import permission', () => {
  assert.deepEqual(
    TEMPLATE_DEFINITIONS.map(({ id }) => id),
    ['equipment-ledger', 'supplier-contract-detail', 'supplier-settlement-fee']
  );
  assert.deepEqual(
    TEMPLATE_DEFINITIONS.map(({ importPermission }) => importPermission),
    ['equipment.import', 'contract.supplier.import', 'contract.settlement.import']
  );
  assert.deepEqual(
    TEMPLATE_DEFINITIONS.map(({ importEndpoint }) => importEndpoint),
    [
      '/api/equipment/imports',
      '/api/contracts/suppliers/import',
      '/api/contracts/settlements/import'
    ]
  );
  assert.deepEqual(
    TEMPLATE_DEFINITIONS.map(({ module }) => module),
    ['设备管理', '合同管理', '合同管理']
  );
  assert.deepEqual(
    TEMPLATE_DEFINITIONS.map(({ importEntry }) => importEntry),
    [
      '设备管理 > 设备台账 > 导入 Excel',
      '合同管理 > 供应商合同管理 > 导入三级细表',
      '合同管理 > 供应商结算费用 > 导入月度费用'
    ]
  );
  const listed = createImportTemplateService().list({
    authContext: context(['equipment.view', 'contract.settlement.view'])
  });
  assert.deepEqual(listed.templates.map(({ id }) => id), [
    'equipment-ledger',
    'supplier-settlement-fee'
  ]);
  const importOnly = createImportTemplateService().list({
    authContext: context(['equipment.import', 'contract.supplier.import'])
  });
  assert.deepEqual(importOnly.templates.map(({ id }) => id), [
    'equipment-ledger',
    'supplier-contract-detail'
  ]);
  assert.equal(listed.templates.some(({ createWorkbook }) => createWorkbook), false);
});

test('template catalog and downloads require a team context and reject client team selection', async () => {
  const service = createImportTemplateService();
  assert.throws(
    () => service.list({
      authContext: context(['equipment.view'], {
        mode: SESSION_MODES.GLOBAL_READ_ONLY,
        activeTeamId: null,
        readOnly: true
      })
    }),
    (error) => error.code === 'TEAM_CONTEXT_REQUIRED' && error.status === 403
  );
  assert.throws(
    () => service.list({
      authContext: context(['equipment.view']),
      requestedTeamId: '507f1f77bcf86cd799439012'
    }),
    (error) => error.code === 'IMPORT_TEMPLATE_TEAM_ID_IMMUTABLE' && error.status === 400
  );
  await assert.rejects(
    service.download({
      authContext: context(['contract.supplier.view']),
      templateId: 'equipment-ledger'
    }),
    (error) => error.code === 'PERMISSION_DENIED' && error.status === 403
  );
  await assert.doesNotReject(
    service.download({
      authContext: context(['equipment.import']),
      templateId: 'equipment-ledger'
    })
  );
});

test('unknown template id returns a stable 404 error', async () => {
  await assert.rejects(
    download('not-a-template', ['equipment.view']),
    (error) => error.code === 'IMPORT_TEMPLATE_NOT_FOUND' && error.status === 404
  );
});

test('equipment template headers are bound to parser aliases and accept a populated row', async () => {
  assert.deepEqual(EQUIPMENT_TEMPLATE_HEADERS, [
    '序号', '设备所属大类', '设备所属类型', '设备一级名称', '设备二级名称',
    '固定资产编号', '车牌号', '环保编号', '产品/品牌编码', '型号规格', '单位',
    '出厂日期', '启用日期', '车长', '吨位', '高位/低位',
    '设备动力类型：锂电/铅酸/柴油', '排放标准', '品牌', '生产厂家',
    '账存数量', '实盘数量', '所在部室', '使用人', '状态', '存放地点',
    '设备照片（请在单元格内插入图片）', '备注'
  ]);
  assert.ok(EQUIPMENT_TEMPLATE_HEADERS.every((header) => (
    Object.values(HEADER_ALIASES).some((aliases) => aliases.includes(header))
  )));
  const template = await download('equipment-ledger', ['equipment.view']);
  assert.equal(template.contentType, XLSX_CONTENT_TYPE);
  const workbook = workbookFrom(template.buffer);
  const values = EQUIPMENT_TEMPLATE_HEADERS.map(() => '');
  Object.assign(values, {
    0: 1,
    1: '运输装备',
    2: '车辆',
    3: '厢式货车',
    4: '4.2米轻卡',
    5: 'ASSET-TEMPLATE-001',
    10: '辆',
    20: 1,
    21: 1,
    22: '综合管理室',
    24: '在用'
  });
  const parsed = parseEquipmentWorkbook(setRow(workbook, '设备台账模板', 1, values));
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].candidate.assetCode, 'ASSET-TEMPLATE-001');
});

test('supplier contract template preserves the parser-owned 57-column detail sheet', async () => {
  const template = await download('supplier-contract-detail', ['contract.supplier.view']);
  assert.equal(template.contentType, XLSX_CONTENT_TYPE);
  const workbook = workbookFrom(template.buffer);
  assert.ok(workbook.Sheets[DETAIL_SHEET_NAME]);
  assert.deepEqual(
    XLSX.utils.sheet_to_json(workbook.Sheets[DETAIL_SHEET_NAME], {
      header: 1,
      raw: true,
      defval: ''
    })[1],
    DETAIL_HEADERS
  );
  const values = DETAIL_HEADERS.map(() => '');
  Object.assign(values, {
    0: 1,
    1: 'SUP-TEMPLATE-001',
    2: '模板供应商',
    3: '托管',
    4: '正常供货',
    5: '否'
  });
  const parsed = parseSupplierWorkbook(setRow(workbook, DETAIL_SHEET_NAME, 2, values), {
    extractWorkbookMedia: () => ({
      imagesByRow: new Map(),
      summary: { invalidMediaReferences: 0 }
    })
  });
  assert.equal(parsed.suppliers.length, 1);
  assert.equal(parsed.suppliers[0].code, 'SUP-TEMPLATE-001');
});

test('settlement template preserves parser headers and accepts a populated row', async () => {
  const template = await download('supplier-settlement-fee', ['contract.settlement.view']);
  assert.equal(template.contentType, XLSX_CONTENT_TYPE);
  const workbook = workbookFrom(template.buffer);
  assert.ok(workbook.Sheets[SETTLEMENT_SHEET_NAME]);
  assert.deepEqual(
    XLSX.utils.sheet_to_json(workbook.Sheets[SETTLEMENT_SHEET_NAME], {
      header: 1,
      raw: true,
      defval: ''
    })[0],
    SETTLEMENT_HEADERS
  );
  const populated = setRow(workbook, SETTLEMENT_SHEET_NAME, 1, [
    1, '2026-08', '模板供应商', 'SUP-TEMPLATE-001', 100, 10, 20, 2, '', '', '模板行'
  ]);
  const parsed = parseSettlementWorkbook(populated);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].month, '2026-08');
  assert.equal(parsed[0].supplierCode, 'SUP-TEMPLATE-001');
});

test('download controller sends an xlsx with a UTF-8 Chinese filename', async () => {
  const service = createImportTemplateService();
  const controller = createImportTemplateController({ service });
  const headers = {};
  let sent;
  await controller.download({
    authContext: context(['equipment.view']),
    query: {},
    params: { templateId: 'equipment-ledger' }
  }, {
    setHeader(name, value) { headers[name] = value; },
    send(buffer) { sent = buffer; return this; }
  }, (error) => { throw error; });
  assert.equal(headers['Content-Type'], XLSX_CONTENT_TYPE);
  assert.match(headers['Content-Disposition'], /^attachment; filename="[^"]+"; filename\*=UTF-8''/);
  assert.match(headers['Content-Disposition'], /%E8%AE%BE%E5%A4%87%E5%8F%B0%E8%B4%A6/);
  assert.ok(Buffer.isBuffer(sent));
});

test('both template endpoints are mounted behind authentication and team context', () => {
  const router = createImportTemplatesRouter({
    service: {
      list() { return { templates: [] }; },
      async download() { return {}; }
    }
  });
  const endpoints = [
    ['/', 'list'],
    ['/:templateId/download', 'download']
  ];
  for (const [routePath, handlerName] of endpoints) {
    const layer = router.stack.find((candidate) => candidate.route?.path === routePath);
    assert.ok(layer, `${routePath} route`);
    assert.equal(layer.route.stack.at(-1).handle.name, handlerName);
  }
  const routerMiddlewareNames = router.stack
    .filter((layer) => !layer.route)
    .map((layer) => layer.handle.name);
  assert.deepEqual(routerMiddlewareNames, [
    'authContextMiddleware',
    'requireBusinessContext',
    'requireTeamContext'
  ]);
});
