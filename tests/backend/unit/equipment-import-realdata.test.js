'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const appRequire = require('../helpers/appRequire');

const XLSX = appRequire('xlsx');
const EquipmentAsset = require('../../../app/models/EquipmentAsset');
const {
  parseEquipmentWorkbook,
  parseSourceDateValue
} = require('../../../app/services/equipmentImportParser');
const {
  resolveImportUsername,
  usage: customerImportUsage
} = require('../../../app/script/importCustomerRealTestData');

function workbookBuffer(sheets) {
  const workbook = XLSX.utils.book_new();
  for (const [name, rows, merges = []] of sheets) {
    const worksheet = XLSX.utils.aoa_to_sheet(rows);
    worksheet['!merges'] = merges;
    XLSX.utils.book_append_sheet(workbook, worksheet, name);
  }
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

test('real fixed-asset headers remain distinct and preserve source-only columns', () => {
  const buffer = workbookBuffer([
    ['运输装备', [
      ['序号', '名称', '车牌号', '产品编码', '型号规格', '车长', '出厂日期', '单位', '账存数量', '实盘数量', '启用日期', '使用人', '所在部室', '状态', '生产厂家', '叉车环保编号', '备注'],
      [1, '9.6米飞翼车', 'TEST-PLATE-01', 'VIN-001', '9.6米飞翼车', '9.6米', '2018年4月2日', '辆', 1, 1, '2018年5月25日', '测试保管人甲', '综合管理室', '在用', '豪瀚', 'TEST-ENV-001', '正常']
    ]],
    ['装卸装备', [
      ['序号', '名称', '车牌号', '产品编码', '型号规格', '吨位', '出厂日期', '单位', '账存数量', '实盘数量', '启用日期', '使用人', '所在部室', '叉车是否高低位', '状态', '资产编码', '生产厂家', '叉车环保编号', '备注1', '备注2', null],
      [1, '电动叉车', 'TEST-PLATE-02', '41BD00133', 'CPDS', '2吨', '2024年', '辆', 1, 1, '2024年', '测试保管人乙', '仓配三分部', '高位', '在用', 'FORK-001', '杭叉', 'TEST-ENV-002', '=DISPIMG("ID_A",1)', null, '=DISPIMG("ID_U",1)'],
      [2, '电动叉车', 'TEST-PLATE-03', '41BD00134', 'CPDS', '2吨', '2024年', '辆', 1, 1, '2024年', '测试保管人丙', '仓配三分部', '低位', '在用', null, '杭叉', 'TEST-ENV-003', null, null, null]
    ], [{ s: { r: 1, c: 15 }, e: { r: 2, c: 15 } }]],
    ['物流信息装备', [
      ['序号', '设备名称', '产品编码SN/PN', '品牌', '型号规格', '单位', '账存数量', '实盘数量', '启用日期', '使用人', '所在部室', '状态', '资产编号', '备注1', '备注2'],
      [1, '手持终端', 'AE4089452', '海康威视', 'DS-MDT301', '台', 1, 1, '2023年7月31日', '测试保管人丁', '仓配三分部', '在用', 'BSXX-SMQ-008', null, null]
    ]],
    ['辅助设施设备', [
      ['序号', '名称', '品牌编号', '型号规格', '单位', '账存数量', '实盘数量', '启用日期', '使用人', '所在部室', '状态', '资产编号', null],
      [1, '洗地机', 'C23040385', 'XD100-AC6J', null, '5个', '215平米', '2023年5月31日', '测试保管人戊', '综合管理室', '在用', 'BSFZ-XDC-001', '=DISPIMG("ID_M",1)']
    ]],
    ['闲置', [
      ['序号', '资产类别', '名称', '品牌', '型号规格', '编号/牌号', '数量', '放置日期', '存放地点', '当前状态', '备注'],
      [1, '物流信息设备', '手持终端', '海康威视', 'DS-MDT301', 'AE4781203', 1, 2026.3, '综合管理室', '正常', null]
    ]]
  ]);

  const parsed = parseEquipmentWorkbook(buffer);
  assert.equal(parsed.rows.length, 6);

  const transport = parsed.rows.find(({ sheetName }) => sheetName === '运输装备').candidate;
  assert.equal(transport.assetCode, '');
  assert.equal(transport.sourceAssetCode, '');
  assert.equal(transport.assetType, 'TRANSPORT_EQUIPMENT');
  assert.equal(transport.productCode, 'VIN-001');
  assert.equal(transport.plateNumber, 'TEST-PLATE-01');
  assert.equal(transport.vehicleLength, '9.6米');
  assert.equal(transport.manufacturer, '豪瀚');

  const forkliftRow = parsed.rows.find(({ sheetName, rowNumber }) => (
    sheetName === '装卸装备' && rowNumber === 2
  ));
  assert.equal(forkliftRow.candidate.sourceAssetCode, 'FORK-001');
  assert.equal(forkliftRow.candidate.assetType, 'HANDLING_EQUIPMENT');
  assert.equal(forkliftRow.candidate.productCode, '41BD00133');
  assert.equal(forkliftRow.candidate.ratedCapacityText, '2吨');
  assert.equal(forkliftRow.candidate.forkliftPosition, '高位');
  assert.equal(forkliftRow.candidate.environmentalRegistrationCode, 'TEST-ENV-002');
  assert.deepEqual(forkliftRow.candidate.sourceImageRefs.sort(), ['ID_A', 'ID_U']);
  assert.equal(forkliftRow.candidate.sourceRawValues.__column_U, '=DISPIMG("ID_U",1)');
  assert.ok(forkliftRow.exceptions.some(({ exceptionType }) => (
    exceptionType === 'MERGED_SOURCE_CELL'
  )));
  const mergedFollower = parsed.rows.find(({ sheetName, rowNumber }) => (
    sheetName === '装卸装备' && rowNumber === 3
  ));
  assert.equal(mergedFollower.candidate.sourceAssetCode, 'FORK-001');
  assert.equal(mergedFollower.candidate.sourceRawValues['资产编码'], 'FORK-001');
  assert.equal(mergedFollower.candidate.sourceRawValues.__display_资产编码, 'FORK-001');
  assert.ok(mergedFollower.exceptions.some(({ exceptionType }) => (
    exceptionType === 'MERGED_SOURCE_CELL'
  )));

  const information = parsed.rows.find(({ sheetName }) => (
    sheetName === '物流信息装备'
  )).candidate;
  assert.equal(information.assetCode, 'BSXX-SMQ-008');
  assert.equal(information.assetType, 'LOGISTICS_INFORMATION_EQUIPMENT');
  assert.equal(information.productCode, 'AE4089452');
  assert.equal(information.brand, '海康威视');

  const auxiliary = parsed.rows.find(({ sheetName }) => (
    sheetName === '辅助设施设备'
  )).candidate;
  assert.equal(auxiliary.brandSerialNumber, 'C23040385');
  assert.equal(auxiliary.assetType, 'AUXILIARY_FACILITY');
  assert.equal(auxiliary.bookQuantity, 5);
  assert.equal(auxiliary.physicalQuantity, 215);
  assert.equal(auxiliary.quantity, 215);
  assert.equal(auxiliary.unit, '平米');
  assert.equal(auxiliary.sourceRawValues.__column_M, '=DISPIMG("ID_M",1)');
  assert.equal(parsed.rows.find(({ sheetName }) => (
    sheetName === '辅助设施设备'
  )).exceptions.filter(({ exceptionType }) => (
    exceptionType === 'QUANTITY_UNIT_EMBEDDED'
  )).length, 2);

  const idle = parsed.rows.find(({ sheetName }) => sheetName === '闲置').candidate;
  assert.equal(idle.serialNumber, 'AE4781203');
  assert.equal(idle.assetType, 'IDLE');
  assert.equal(idle.assetCode, '');
  assert.equal(idle.status, EquipmentAsset.EQUIPMENT_STATUSES.IDLE);
  assert.equal(idle.conditionText, '正常');
  assert.equal(idle.idlePlacedAtDisplay, '2026.3');
  assert.equal(idle.idlePlacedAtRaw, '2026.3');
});

test('partial source dates retain value, precision and exact raw text', () => {
  const year = parseSourceDateValue('2024年', { field: 'activationDate' });
  assert.equal(year.precision, EquipmentAsset.DATE_PRECISIONS.YEAR);
  assert.equal(year.display, '2024');
  assert.equal(year.raw, '2024年');
  assert.equal(year.exception.exceptionType, 'PARTIAL_DATE');

  const month = parseSourceDateValue(2026.3, { field: 'idlePlacedAt' });
  assert.equal(month.precision, EquipmentAsset.DATE_PRECISIONS.MONTH);
  assert.equal(month.display, '2026-03');
  assert.equal(month.raw, '2026.3');
});

test('Excel display and number format determine source date precision without losing raw values', () => {
  const workbook = XLSX.utils.book_new();
  const transport = XLSX.utils.aoa_to_sheet([
    ['序号', '名称', '车牌号', '产品编码', '型号规格', '车长', '出厂日期', '单位', '账存数量', '实盘数量', '启用日期', '使用人', '所在部室', '状态', '生产厂家'],
    [1, '轻卡', 'TEST-PLATE-DATE', 'VIN-DATE', '4.2米', '4.2米', 43739, '辆', 1, 1, 43739, '测试保管人己', '综合管理室', '在用', '豪沃']
  ]);
  transport.G2.z = 'yyyy"年"m"月";@';
  transport.K2.z = 'm/d/yy';
  XLSX.utils.book_append_sheet(workbook, transport, '运输装备');

  const idle = XLSX.utils.aoa_to_sheet([
    ['序号', '资产类别', '名称', '品牌', '型号规格', '编号/牌号', '数量', '放置日期', '存放地点', '当前状态', '备注'],
    [1, '辅助设施设备', '吸尘器', null, null, 'IDLE-DATE', 1, 2025.1, '综合管理室', '正常', null]
  ]);
  idle.H2.z = '0.00_ ';
  XLSX.utils.book_append_sheet(workbook, idle, '闲置');

  const parsed = parseEquipmentWorkbook(XLSX.write(workbook, {
    type: 'buffer',
    bookType: 'xlsx'
  }));
  const transportCandidate = parsed.rows.find(({ sheetName }) => (
    sheetName === '运输装备'
  )).candidate;
  assert.equal(transportCandidate.productionDateRaw, '43739');
  assert.equal(transportCandidate.productionDateDisplay, '2019年10月');
  assert.equal(
    transportCandidate.productionDatePrecision,
    EquipmentAsset.DATE_PRECISIONS.MONTH
  );
  assert.equal(transportCandidate.activationDateDisplay, '10/1/19');
  assert.equal(transportCandidate.activationDatePrecision, EquipmentAsset.DATE_PRECISIONS.DAY);

  const idleCandidate = parsed.rows.find(({ sheetName }) => sheetName === '闲置').candidate;
  assert.equal(idleCandidate.idlePlacedAtRaw, '2025.1');
  assert.equal(idleCandidate.idlePlacedAtDisplay, '2025.10');
  assert.equal(idleCandidate.idlePlacedAt.toISOString(), '2025-10-01T00:00:00.000Z');
});

test('customer fixture importer requires an explicit normalized username', () => {
  assert.throws(
    () => resolveImportUsername(),
    /username is required via --username or CUSTOMER_TEST_USERNAME/
  );
  assert.throws(
    () => resolveImportUsername({ env: { CUSTOMER_TEST_USERNAME: '   ' } }),
    /username is required via --username or CUSTOMER_TEST_USERNAME/
  );
  assert.equal(
    resolveImportUsername({ env: { CUSTOMER_TEST_USERNAME: '  ENV.Import.User  ' } }),
    'env.import.user'
  );
  assert.equal(
    resolveImportUsername({
      cliValue: '  CLI.Import.User  ',
      env: { CUSTOMER_TEST_USERNAME: 'env-user' }
    }),
    'cli.import.user'
  );
  assert.match(customerImportUsage(), /--username <local-test-user>/);
  assert.match(customerImportUsage(), /CUSTOMER_TEST_USERNAME/);
});
