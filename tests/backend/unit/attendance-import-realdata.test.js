'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const appRequire = require('../helpers/appRequire');

const XLSX = appRequire('xlsx');
const AttendanceSubmission = require('../../../app/models/AttendanceSubmission');
const {
  IMPORT_TAG,
  SOURCE_SHEET,
  parseAttendanceWorkbook,
  parseMongoTarget,
  resolveImportUsername,
  usage: attendanceImportUsage,
  summarizeFixtures
} = require('../../../app/script/importCustomerAttendanceTestData');

const SOURCE_FILE = path.resolve(
  __dirname,
  '../../../references/提报类（开发）(3).xlsx'
);
const CUSTOMER_SOURCE_TEST_OPTIONS = Object.freeze({
  skip: fs.existsSync(SOURCE_FILE) ? false : 'customer source workbook is intentionally excluded from Git'
});

test('customer attendance workbook preserves all seven 2026-07-14 division rows', CUSTOMER_SOURCE_TEST_OPTIONS, () => {
  const workbook = XLSX.readFile(SOURCE_FILE, { cellFormula: true, cellDates: false });
  const fixtures = parseAttendanceWorkbook(workbook, 'a'.repeat(64));

  assert.equal(fixtures.length, 7);
  assert.deepEqual(fixtures.map(({ orgUnitName }) => orgUnitName), [
    '仓配一分部',
    '仓配二分部',
    '仓配三分部',
    '综合管理室-综合组',
    '综合管理室-技术组',
    '现场配送分部',
    '立体库仓配分部'
  ]);
  assert.ok(fixtures.every(({ reportDate }) => reportDate === '2026-07-14'));
  assert.deepEqual(summarizeFixtures(fixtures), {
    authorizedHeadcount: 123,
    registeredHeadcount: 125,
    dayActualAttendance: 125,
    pendingDeparture: 2,
    supportCount: 1
  });

  const warehouseTwo = fixtures.find(({ orgUnitName }) => orgUnitName === '仓配二分部');
  assert.equal(warehouseTwo.dayShift.pendingDeparture.count, 1);
  assert.equal(warehouseTwo.dayShift.pendingDeparture.names.length, 1);
  const delivery = fixtures.find(({ orgUnitName }) => orgUnitName === '现场配送分部');
  assert.equal(delivery.dayShift.notYetEmployed.count, 1);
  assert.equal(delivery.dayShift.notYetEmployed.names.length, 1);
  assert.equal(delivery.dayShift.pendingDeparture.count, 1);
  assert.equal(delivery.dayShift.pendingDeparture.names.length, 1);
  const warehouse = fixtures.find(({ orgUnitName }) => orgUnitName === '立体库仓配分部');
  assert.equal(warehouse.support.destination, '物流技术部');
  assert.equal(warehouse.support.count, 1);
  assert.equal(warehouse.support.names.length, 1);
  assert.equal(warehouse.source.sheetName, SOURCE_SHEET);
  assert.equal(warehouse.source.importTag, IMPORT_TAG);
});

test('contradictory source summary remains pending confirmation instead of replacing division rows', CUSTOMER_SOURCE_TEST_OPTIONS, () => {
  const workbook = XLSX.readFile(SOURCE_FILE, { cellFormula: true, cellDates: false });
  const fixtures = parseAttendanceWorkbook(workbook, 'b'.repeat(64));
  const first = fixtures[0];

  assert.equal(
    first.dataQualityStatus,
    AttendanceSubmission.ATTENDANCE_QUALITY_STATUSES.PENDING_CONFIRMATION
  );
  assert.deepEqual(first.dataQualityIssues.map(({ code, sourceValue, calculatedValue }) => ({
    code,
    sourceValue,
    calculatedValue
  })), [
    { code: 'SOURCE_REGISTERED_TOTAL_MISMATCH', sourceValue: 126, calculatedValue: 125 },
    { code: 'SOURCE_DAY_ACTUAL_TOTAL_MISMATCH', sourceValue: 126, calculatedValue: 125 },
    { code: 'SOURCE_PENDING_DEPARTURE_TOTAL_MISMATCH', sourceValue: 3, calculatedValue: 2 }
  ]);
});

test('attendance importer rejects remote and non-test MongoDB targets', () => {
  assert.throws(
    () => parseMongoTarget('mongodb://82.156.67.62:27017/customer_v2_test'),
    /loopback/
  );
  assert.throws(
    () => parseMongoTarget('mongodb://127.0.0.1:27140/customer'),
    /_v2_test/
  );
  assert.equal(
    parseMongoTarget('mongodb://127.0.0.1:27140/customer_v2_test').databaseName,
    'customer_v2_test'
  );
});

test('attendance importer requires an explicit normalized username', () => {
  assert.throws(
    () => resolveImportUsername(),
    /username is required via --username or CUSTOMER_TEST_USERNAME/
  );
  assert.throws(
    () => resolveImportUsername({ env: { CUSTOMER_TEST_USERNAME: '   ' } }),
    /username is required via --username or CUSTOMER_TEST_USERNAME/
  );
  assert.equal(
    resolveImportUsername({ env: { CUSTOMER_TEST_USERNAME: '  Attendance.Env.User  ' } }),
    'attendance.env.user'
  );
  assert.equal(
    resolveImportUsername({
      cliValue: '  Attendance.Cli.User  ',
      env: { CUSTOMER_TEST_USERNAME: 'env-user' }
    }),
    'attendance.cli.user'
  );
  assert.match(attendanceImportUsage(), /--username <local-test-user>/);
  assert.match(attendanceImportUsage(), /CUSTOMER_TEST_USERNAME/);
});
