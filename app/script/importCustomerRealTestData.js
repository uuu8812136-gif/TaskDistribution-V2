#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const XLSX = require('xlsx');
const { MEMBERSHIP_STATUSES } = require('../config/permissions');
const { validateFileContent } = require('../services/fileStorageService');

const FileAsset = require('../models/FileAsset');
const OrgUnit = require('../models/OrgUnit');
const ProductionSchedule = require('../models/ProductionSchedule');
const ProjectTeam = require('../models/ProjectTeam');
const TransportRecord = require('../models/TransportRecord');
const TeamMembership = require('../models/TeamMembership');
const User = require('../models/User');
const {
  buildEquipmentFixtures,
  upsertEquipmentFixtures,
  verifyEquipmentApplied
} = require('./customerEquipmentRealDataImporter');

const WORKSPACE_ROOT = path.resolve(__dirname, '../..');
const CUSTOMER_DATA_ROOT = path.join(WORKSPACE_ROOT, 'customer-data');
const DEFAULT_SOURCE_DIR = path.join(
  CUSTOMER_DATA_ROOT,
  '2026-07-17-customer-real-data'
);
const TEST_DATA_ROOT = path.join(WORKSPACE_ROOT, '.test-data');
const DEFAULT_TEAM_CODE = 'GEARBOX_LOGISTICS';
const DEFAULT_ORG_CODE = 'DEPARTMENT';
const IMPORT_TAG = 'customer-real-test-data-2026-07-17-v1';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const VALUE_OPTIONS = new Set([
  'mongo-uri',
  'upload-dir',
  'source-dir',
  'team-code',
  'org-code',
  'username'
]);
const FLAG_OPTIONS = new Set(['apply', 'help']);
const MAX_TRANSPORT_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_TRANSPORT_PHOTO_TOTAL_BYTES = 100 * 1024 * 1024;

const PRODUCTION_HISTORY_FILE = '产量(1).xlsx';
const JUNE_DAILY_FILE = '（2）2026年6月份产量.xlsx';
const TRANSPORT_JSON_FILE = 'transport-records-2026-07-16-to-17.json';
const SOURCE_FILE_DISPOSITIONS = Object.freeze([
  Object.freeze({ file: '产量(1).xlsx', status: 'IMPORTED', reason: '月度历史和2026年7月日数据权威来源' }),
  Object.freeze({ file: '（2）2026年6月份产量.xlsx', status: 'IMPORTED', reason: '2026年6月日数据权威来源' }),
  Object.freeze({ file: '变速箱物流部2026年中固定资产盘点表(1).xlsx', status: 'IMPORTED', reason: '固定资产台账权威来源' }),
  Object.freeze({ file: '（3）2026年6月份产量报表（变速箱物流部）(1).xlsx', status: 'REFERENCE_ONLY', reason: '日数据与权威来源重复，原文件入库数未填写' }),
  Object.freeze({ file: '提报类（开发）(3).xlsx', status: 'REFERENCE_ONLY', reason: '需求模板和示例数据；其中排产值与权威来源逐行一致，不重复导入' }),
  Object.freeze({ file: '注释(3).xlsx', status: 'REFERENCE_ONLY', reason: '字段注释和开发要求，不是业务记录' }),
  Object.freeze({ file: '提报类（开发）(1).xlsx', status: 'SUPERSEDED', reason: '旧版需求模板，已由(3)替代' }),
  Object.freeze({ file: '注释(1).xlsx', status: 'SUPERSEDED', reason: '旧版字段注释，已由(3)替代' })
]);
const TRANSPORT_FIELDS = Object.freeze([
  'orgUnitId', 'reportDate', 'shift', 'tripLabel', 'route', 'dispatchType',
  'vehiclePlate', 'vehicleType', 'driverName', 'loadDetails', 'photoFileIds', 'remark'
]);
const TRANSPORT_SOURCE_LOAD_KEYS = Object.freeze([
  '塑料托盘',
  '铁托',
  '木托',
  '木箱',
  '铁笼',
  '铁架',
  '壳体黑色塑盘（卓普厂家）',
  '壳体专用循环托（载信租赁）',
  '壳体出内衬托盘（制造部供）'
]);

// This is the customer's original send order. The temporary association was
// explicitly approved for test display as 3 + 2 + 2 + 2 + 2 + 2 photos.
const TRANSPORT_PHOTO_GROUPS = Object.freeze([
  Object.freeze([
    'codex-clipboard-c1362e12-8538-4c23-a2f2-c591495b61d4.jpg',
    'codex-clipboard-b10f8288-1d14-4eb6-9943-9c54ed2f7db5.jpg',
    'codex-clipboard-67a15524-f9a5-4d65-8e7d-e325511afc80.jpg'
  ]),
  Object.freeze([
    'codex-clipboard-27bca3ef-cb4f-47c3-9faf-9c4038c0ee8e.jpg',
    'codex-clipboard-5e2157b5-acaf-4adb-b42d-9144065f4137.jpg'
  ]),
  Object.freeze([
    'codex-clipboard-8d898afd-2ea4-4adf-8813-103bdfe88ec4.jpg',
    'codex-clipboard-03e1106f-e106-461f-8678-a9c39ecc3014.jpg'
  ]),
  Object.freeze([
    'codex-clipboard-9060c618-31f7-4926-91d2-675dcf1da505.jpg',
    'codex-clipboard-ec197378-6ae3-4d32-b6a9-676f321ed471.jpg'
  ]),
  Object.freeze([
    'codex-clipboard-33ba8ecc-3a67-4039-99be-131e98547bbd.jpg',
    'codex-clipboard-1643b06e-5694-4559-9c79-9c36cb4032b4.jpg'
  ]),
  Object.freeze([
    'codex-clipboard-d8e5bad5-f541-402b-b0d2-867bf51efea1.jpg',
    'codex-clipboard-e8d59d1a-319f-4950-afdf-522faa8dcba1.jpg'
  ])
]);

function usage() {
  return [
    'Idempotently import customer-provided equipment, production, and transport fixtures into local V2 test data.',
    '',
    'Dry-run (read-only):',
    '  node script/importCustomerRealTestData.js --username <local-test-user> --mongo-uri <loopback-uri> --upload-dir <.test-data-child>',
    '',
    'Apply after a database backup:',
    '  node script/importCustomerRealTestData.js --username <local-test-user> --mongo-uri <loopback-uri> --upload-dir <.test-data-child> --apply',
    '',
    'Safety rules:',
    '  - Import username is required via --username or CUSTOMER_TEST_USERNAME; no default account is used.',
    '  - MongoDB host must be loopback and database name must end with _v2_test.',
    '  - Source must be inside E:\\...\\TaskDistribution-V2\\customer-data.',
    '  - Upload target must be inside E:\\...\\TaskDistribution-V2\\.test-data.',
    '  - Without --apply the script performs parsing and database comparison only.'
  ].join('\n');
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected positional argument: ${token}`);
    const [name, inlineValue] = token.slice(2).split(/=(.*)/s, 2);
    if (FLAG_OPTIONS.has(name)) {
      if (inlineValue !== undefined) throw new Error(`--${name} does not accept a value`);
      result[name] = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) throw new Error(`Unknown option: --${name}`);
    const value = inlineValue === undefined ? argv[++index] : inlineValue;
    if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
    result[name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  return result;
}

function isInside(root, candidate, allowRoot = false) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!relative) return allowRoot;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertEDrive(candidate, fieldName) {
  if (path.parse(path.resolve(candidate)).root.toUpperCase() !== 'E:\\') {
    throw new Error(`${fieldName} must resolve to the E drive`);
  }
}

function resolveSourceDirectory(value) {
  const sourceDir = path.resolve(WORKSPACE_ROOT, value || DEFAULT_SOURCE_DIR);
  assertEDrive(sourceDir, 'source-dir');
  if (!isInside(CUSTOMER_DATA_ROOT, sourceDir, false)) {
    throw new Error('source-dir must be a child of the workspace customer-data directory');
  }
  const realCustomerRoot = fs.realpathSync(CUSTOMER_DATA_ROOT);
  const realSourceDir = fs.realpathSync(sourceDir);
  if (!isInside(realCustomerRoot, realSourceDir, false)) {
    throw new Error('source-dir resolves outside the workspace customer-data directory');
  }
  return realSourceDir;
}

function resolveUploadDirectory(value) {
  if (!value) throw new Error('upload-dir is required');
  const uploadDir = path.resolve(WORKSPACE_ROOT, value);
  assertEDrive(uploadDir, 'upload-dir');
  if (!isInside(TEST_DATA_ROOT, uploadDir, false)) {
    throw new Error('upload-dir must be a child of the workspace .test-data directory');
  }
  if (!fs.existsSync(uploadDir) || !fs.statSync(uploadDir).isDirectory()) {
    throw new Error('upload-dir must already exist as a directory');
  }
  const realTestDataRoot = fs.realpathSync(TEST_DATA_ROOT);
  const realUploadDir = fs.realpathSync(uploadDir);
  if (!isInside(realTestDataRoot, realUploadDir, false)) {
    throw new Error('upload-dir resolves outside the workspace .test-data directory');
  }
  return realUploadDir;
}

function parseMongoTarget(uri) {
  if (!uri) throw new Error('mongo-uri is required');
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error('mongo-uri is invalid');
  }
  if (parsed.protocol !== 'mongodb:') {
    throw new Error('Only a direct mongodb:// loopback URI is accepted');
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error('MongoDB host must be loopback; production and remote hosts are forbidden');
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!databaseName || databaseName.includes('/') || !databaseName.toLowerCase().endsWith('_v2_test')) {
    throw new Error('MongoDB database name must end with _v2_test');
  }
  return Object.freeze({
    uri,
    host: parsed.hostname,
    port: parsed.port || '27017',
    databaseName
  });
}

function resolveImportUsername({ cliValue, env = {} } = {}) {
  const rawValue = cliValue !== undefined ? cliValue : env.CUSTOMER_TEST_USERNAME;
  if (typeof rawValue !== 'string' || !rawValue.normalize('NFKC').trim()) {
    throw new Error('username is required via --username or CUSTOMER_TEST_USERNAME');
  }
  return rawValue.normalize('NFKC').trim().toLowerCase();
}

function resolveOptions({ argv = process.argv.slice(2), env = process.env } = {}) {
  const args = parseArgs(argv);
  if (args.help) return Object.freeze({ help: true });
  const username = resolveImportUsername({ cliValue: args.username, env });
  const mongoTarget = parseMongoTarget(
    args.mongoUri || env.CUSTOMER_TEST_MONGODB_URI || env.MONGODB_URI
  );
  return Object.freeze({
    help: false,
    apply: Boolean(args.apply),
    mongoTarget,
    uploadDir: resolveUploadDirectory(
      args.uploadDir || env.CUSTOMER_TEST_UPLOAD_DIR || env.UPLOAD_PATH
    ),
    sourceDir: resolveSourceDirectory(args.sourceDir),
    teamCode: (args.teamCode || DEFAULT_TEAM_CODE).trim().toUpperCase(),
    orgCode: (args.orgCode || DEFAULT_ORG_CODE).trim().toUpperCase(),
    username
  });
}

function sha256File(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function sourceFileDisposition(sourceDir) {
  const spreadsheets = path.join(sourceDir, 'spreadsheets');
  return SOURCE_FILE_DISPOSITIONS.map((item) => {
    const filename = path.join(spreadsheets, item.file);
    if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) {
      throw new Error(`Expected customer source file is missing: ${item.file}`);
    }
    return { ...item, sha256: sha256File(filename), size: fs.statSync(filename).size };
  });
}

function deterministicObjectId(seed) {
  return new mongoose.Types.ObjectId(
    crypto.createHash('sha256').update(`${IMPORT_TAG}:${seed}`).digest('hex').slice(0, 24)
  );
}

function deterministicUuid(seed) {
  const hex = crypto.createHash('sha256').update(`${IMPORT_TAG}:${seed}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function nullableQuantity(value, fieldName) {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`${fieldName} must be a non-negative integer or null`);
  }
  return number;
}

function requiredQuantity(value, fieldName) {
  const number = nullableQuantity(value, fieldName);
  if (number === null) throw new Error(`${fieldName} is required`);
  return number;
}

function naturalMonthFromCell(value, fieldName) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  const text = String(value || '').trim();
  let match = text.match(/^(\d{4})年(\d{1,2})月$/);
  if (match) return `${match[1]}-${match[2].padStart(2, '0')}`;
  match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (match) {
    const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
    return `${year}-${match[1].padStart(2, '0')}`;
  }
  throw new Error(`${fieldName} is not a supported month value`);
}

function naturalDateFromCell(value, fieldName) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return [
      value.getUTCFullYear(),
      String(value.getUTCMonth() + 1).padStart(2, '0'),
      String(value.getUTCDate()).padStart(2, '0')
    ].join('-');
  }
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (!match) throw new Error(`${fieldName} is not a supported date value`);
  return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
}

function nextMonth(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, monthNumber, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function readWorkbook(filename) {
  if (!fs.statSync(filename).isFile()) throw new Error(`Source workbook is not a file: ${filename}`);
  return XLSX.readFile(filename, { cellDates: true, cellFormula: true });
}

function rowsOf(worksheet) {
  // SheetJS applies the process timezone when raw Date cells are materialized
  // through sheet_to_json. The customer's month-start cells can therefore
  // appear as the previous UTC month. Formatted cell text preserves the
  // workbook's authoritative calendar labels and is also accepted by the
  // quantity parser below.
  return XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: null, raw: false });
}

function parseMonthlyHistory(workbook) {
  const worksheet = workbook.Sheets['月明细'];
  if (!worksheet) throw new Error('The production history workbook is missing 月明细');
  const rows = rowsOf(worksheet).slice(1).filter((row) => row[0] !== null);
  if (rows.length !== 42) throw new Error(`Expected 42 monthly history rows, received ${rows.length}`);
  let expectedMonth = '2023-01';
  const schedules = rows.map((row, index) => {
    const month = naturalMonthFromCell(row[0], `monthly row ${index + 2}`);
    if (month !== expectedMonth) {
      throw new Error(`Monthly history is not continuous: expected ${expectedMonth}, received ${month}`);
    }
    expectedMonth = nextMonth(expectedMonth);
    const monthlyTotals = {
      aLine: nullableQuantity(row[1], `${month}.aLine`),
      northLine: nullableQuantity(row[2], `${month}.northLine`),
      transferCaseLine: nullableQuantity(row[3], `${month}.transferCaseLine`),
      bLineDay: nullableQuantity(row[4], `${month}.bLineDay`),
      bLineNight: nullableQuantity(row[5], `${month}.bLineNight`)
    };
    const calculatedTotal = Object.values(monthlyTotals).reduce(
      (sum, value) => sum + (value || 0),
      0
    );
    const sourceTotal = requiredQuantity(row[6], `${month}.total`);
    if (calculatedTotal !== sourceTotal) {
      throw new Error(`${month} monthly total mismatch: ${calculatedTotal} != ${sourceTotal}`);
    }
    return {
      month,
      dailyEntries: [],
      productionPlanForecast: null,
      monthlyTotals
    };
  });
  if (expectedMonth !== '2026-07') throw new Error('Monthly history must end at 2026-06');
  return schedules;
}

function parseDailySchedule(worksheet, month, expectedDayCount) {
  if (!worksheet) throw new Error(`Missing daily production worksheet for ${month}`);
  const entries = [];
  for (const [rowOffset, row] of rowsOf(worksheet).slice(1).entries()) {
    if (row[0] === null) continue;
    let date;
    try {
      date = naturalDateFromCell(row[0], `${month} row ${rowOffset + 2}`);
    } catch {
      continue;
    }
    if (!date.startsWith(`${month}-`)) continue;
    const entry = {
      date,
      aLineDay: nullableQuantity(row[1], `${date}.aLineDay`),
      aLineNight: null,
      northLine: nullableQuantity(row[2], `${date}.northLine`),
      transferCaseLine: nullableQuantity(row[3], `${date}.transferCaseLine`),
      bLineDay: nullableQuantity(row[4], `${date}.bLineDay`),
      bLineNight: nullableQuantity(row[5], `${date}.bLineNight`)
    };
    const lineValues = Object.entries(entry)
      .filter(([key]) => key !== 'date')
      .map(([, value]) => value);
    const calculatedTotal = lineValues.reduce((sum, value) => sum + (value || 0), 0);
    const sourceTotal = nullableQuantity(row[6], `${date}.total`);
    if (sourceTotal !== null && calculatedTotal !== sourceTotal) {
      throw new Error(`${date} daily total mismatch: ${calculatedTotal} != ${sourceTotal}`);
    }
    entries.push(entry);
  }
  entries.sort((left, right) => left.date.localeCompare(right.date));
  if (entries.length !== expectedDayCount) {
    throw new Error(`Expected ${expectedDayCount} daily rows for ${month}, received ${entries.length}`);
  }
  const dates = new Set(entries.map(({ date }) => date));
  if (dates.size !== expectedDayCount) throw new Error(`${month} contains duplicate daily rows`);
  for (let day = 1; day <= expectedDayCount; day += 1) {
    const expectedDate = `${month}-${String(day).padStart(2, '0')}`;
    if (!dates.has(expectedDate)) throw new Error(`${month} is missing ${expectedDate}`);
  }
  return entries;
}

function aggregateDaily(entries) {
  const sum = (fields) => entries.reduce(
    (total, entry) => total + fields.reduce((value, field) => value + (entry[field] || 0), 0),
    0
  );
  return {
    aLine: sum(['aLineDay', 'aLineNight']),
    northLine: sum(['northLine']),
    transferCaseLine: sum(['transferCaseLine']),
    bLineDay: sum(['bLineDay']),
    bLineNight: sum(['bLineNight'])
  };
}

function totalMonthly(monthlyTotals) {
  return Object.values(monthlyTotals).reduce((sum, value) => sum + (value || 0), 0);
}

function buildProductionFixtures(sourceDir) {
  const historyWorkbook = readWorkbook(path.join(sourceDir, 'spreadsheets', PRODUCTION_HISTORY_FILE));
  const schedules = parseMonthlyHistory(historyWorkbook);
  const juneWorkbook = readWorkbook(path.join(sourceDir, 'spreadsheets', JUNE_DAILY_FILE));
  const juneEntries = parseDailySchedule(
    juneWorkbook.Sheets[juneWorkbook.SheetNames[0]],
    '2026-06',
    30
  );
  const julyEntries = parseDailySchedule(historyWorkbook.Sheets['日明细'], '2026-07', 31);
  const june = schedules.find(({ month }) => month === '2026-06');
  const juneFromDaily = aggregateDaily(juneEntries);
  if (JSON.stringify(june.monthlyTotals) !== JSON.stringify(juneFromDaily)) {
    throw new Error('2026-06 monthly and daily production totals do not match');
  }
  june.dailyEntries = juneEntries;
  june.productionPlanForecast = 12500;

  const julyTotals = aggregateDaily(julyEntries);
  schedules.push({
    month: '2026-07',
    dailyEntries: julyEntries,
    productionPlanForecast: 12000,
    monthlyTotals: julyTotals
  });
  if (totalMonthly(june.monthlyTotals) !== 12000) throw new Error('2026-06 must total 12000');
  if (totalMonthly(julyTotals) !== 6263) throw new Error('2026-07 through day 16 must total 6263');
  const pendingJulyEntries = julyEntries.filter(({ date }) => date >= '2026-07-17');
  if (pendingJulyEntries.length !== 15 || pendingJulyEntries.some((entry) => (
    Object.entries(entry).some(([key, value]) => key !== 'date' && value !== null)
  ))) {
    throw new Error('2026-07 days 17-31 must contain null production quantities');
  }
  return schedules;
}

function buildTransportFixtures(sourceDir) {
  const jsonPath = path.join(sourceDir, 'transport-records', TRANSPORT_JSON_FILE);
  const source = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  if (!Array.isArray(source.records) || source.records.length !== 6) {
    throw new Error('Expected exactly six customer transport records');
  }
  const photoDir = path.join(sourceDir, 'transport-photos');
  const expectedPhotos = TRANSPORT_PHOTO_GROUPS.flat();
  if (new Set(expectedPhotos).size !== 13) throw new Error('Photo mapping contains duplicates');
  const actualPhotos = fs.readdirSync(photoDir).filter((name) => /\.(?:jpe?g|png)$/i.test(name));
  const missing = expectedPhotos.filter((name) => !actualPhotos.includes(name));
  const unexpected = actualPhotos.filter((name) => !expectedPhotos.includes(name));
  if (missing.length || unexpected.length) {
    throw new Error(`Transport photo set mismatch; missing=${missing.join(',')}; unexpected=${unexpected.join(',')}`);
  }
  let totalPhotoBytes = 0;
  return source.records.map((record, index) => {
    const actualLoadKeys = Object.keys(record.loads || {}).sort();
    const expectedLoadKeys = [...TRANSPORT_SOURCE_LOAD_KEYS].sort();
    if (!sameValue(actualLoadKeys, expectedLoadKeys)) {
      throw new Error(`Transport record ${index + 1} has an unexpected load-field set`);
    }
    const loadValues = TRANSPORT_SOURCE_LOAD_KEYS.map((key) => (
      requiredQuantity(record.loads[key], `transport[${index}].loads[${key}]`)
    ));
    const photoFiles = TRANSPORT_PHOTO_GROUPS[index].map((name) => {
      const sourcePath = path.join(photoDir, name);
      const buffer = fs.readFileSync(sourcePath);
      if (buffer.length > MAX_TRANSPORT_PHOTO_BYTES) throw new Error(`${name} exceeds the photo size limit`);
      totalPhotoBytes += buffer.length;
      if (totalPhotoBytes > MAX_TRANSPORT_PHOTO_TOTAL_BYTES) {
        throw new Error('Transport photos exceed the total size limit');
      }
      validateFileContent(buffer, 'image/jpeg');
      return {
        name,
        sourcePath,
        mimeType: 'image/jpeg',
        size: fs.statSync(sourcePath).size,
        sha256: crypto.createHash('sha256').update(buffer).digest('hex')
      };
    });
    return {
      sourceIndex: index + 1,
      reportDate: record.date,
      tripLabel: record.tripLabel,
      vehiclePlate: record.plateNumber,
      loadDetails: {
        standardPlasticPallet: loadValues[0],
        standardIronPallet: loadValues[1],
        woodenPallet: loadValues[2],
        woodenBox: loadValues[3],
        ironCage: loadValues[4],
        ironRack: loadValues[5],
        housingPlasticPallet: loadValues[7],
        housingIronPallet: 0,
        housingLinerPallet: loadValues[8],
        housingBlackPlasticTray: loadValues[6],
        turnoverBoxBlue: 0,
        turnoverBoxGray: 0,
        turnoverBoxWhite: 0,
        other: 0
      },
      photoFiles
    };
  });
}

function canonical(value) {
  if (value instanceof mongoose.Types.ObjectId) return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])])
    );
  }
  return value === undefined ? null : value;
}

function sameValue(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function selected(document, fields) {
  const plain = document?.toObject ? document.toObject() : document;
  return Object.fromEntries(fields.map((field) => [field, plain?.[field]]));
}

function newChangeCounter() {
  return { created: 0, updated: 0, unchanged: 0 };
}

async function resolveScope(options) {
  const team = await ProjectTeam.findOne({ code: options.teamCode, status: 'ACTIVE' });
  if (!team) throw new Error(`Active team does not exist: ${options.teamCode}`);
  const orgUnit = await OrgUnit.findOne({
    teamId: team._id,
    code: options.orgCode,
    status: 'ACTIVE'
  });
  if (!orgUnit) throw new Error(`Active organization unit does not exist: ${options.orgCode}`);
  const user = await User.findOne({ usernameNormalized: options.username, status: 'active' });
  if (!user) throw new Error(`Active import user does not exist: ${options.username}`);
  if (!user.isSuperAdmin) {
    const membership = await TeamMembership.exists({
      teamId: team._id,
      userId: user._id,
      status: MEMBERSHIP_STATUSES.ACTIVE
    });
    if (!membership) throw new Error(`Import user is not an active member of team ${options.teamCode}`);
  }
  return { team, orgUnit, user };
}

async function upsertProductionFixtures({ fixtures, scope, apply, changes }) {
  const fields = ['dailyEntries', 'productionPlanForecast', 'monthlyTotals'];
  for (const fixture of fixtures) {
    const filter = {
      teamId: scope.team._id,
      orgUnitId: scope.orgUnit._id,
      month: fixture.month
    };
    const existing = await ProductionSchedule.findOne(filter);
    const desired = {
      dailyEntries: fixture.dailyEntries,
      productionPlanForecast: fixture.productionPlanForecast,
      monthlyTotals: fixture.monthlyTotals
    };
    if (existing && sameValue(selected(existing, fields), desired)) {
      changes.unchanged += 1;
      continue;
    }
    const document = existing || new ProductionSchedule({
      ...filter,
      createdBy: scope.user._id,
      updatedBy: scope.user._id
    });
    Object.assign(document, desired, { updatedBy: scope.user._id });
    await document.validate();
    changes[existing ? 'updated' : 'created'] += 1;
    if (apply) await document.save();
  }
}

function storagePath(uploadDir, storageKey) {
  const resolved = path.resolve(uploadDir, ...storageKey.split('/'));
  if (!isInside(uploadDir, resolved, false)) throw new Error('FileAsset storageKey escapes upload-dir');
  let existingAncestor = resolved;
  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) throw new Error('Cannot resolve FileAsset storage target');
    existingAncestor = parent;
  }
  const realUploadDir = fs.realpathSync(uploadDir);
  const realAncestor = fs.realpathSync(existingAncestor);
  if (!isInside(realUploadDir, realAncestor, true)) {
    throw new Error('FileAsset storage target resolves outside upload-dir');
  }
  const realTarget = path.resolve(realAncestor, path.relative(existingAncestor, resolved));
  if (!isInside(realUploadDir, realTarget, false)) {
    throw new Error('FileAsset storage target escapes upload-dir through a reparse point');
  }
  return resolved;
}

function existingFileHash(filename) {
  return fs.existsSync(filename) && fs.statSync(filename).isFile() ? sha256File(filename) : null;
}

async function copyPhotoIfNeeded({ photo, targetPath, apply, storageChanges }) {
  const targetHash = existingFileHash(targetPath);
  if (targetHash) {
    if (targetHash !== photo.sha256) throw new Error(`Upload target hash mismatch: ${targetPath}`);
    storageChanges.alreadyPresent += 1;
    return;
  }
  storageChanges.missing += 1;
  if (!apply) return;
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${process.pid}.tmp`;
  try {
    await fs.promises.copyFile(photo.sourcePath, temporaryPath, fs.constants.COPYFILE_EXCL);
    if (sha256File(temporaryPath) !== photo.sha256) throw new Error(`Copied photo hash mismatch: ${photo.name}`);
    await fs.promises.rename(temporaryPath, targetPath);
    storageChanges.copied += 1;
  } finally {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function upsertPhotoAsset({
  photo,
  recordId,
  reportDate,
  scope,
  options,
  changes,
  storageChanges
}) {
  const deterministicId = deterministicObjectId(`photo:${scope.team._id}:${photo.name}`);
  const existing = await FileAsset.findById(deterministicId);
  if (existing && String(existing.teamId) !== String(scope.team._id)) {
    throw new Error(`FileAsset team mismatch for ${photo.name}`);
  }
  if (existing && existing.status === 'ACTIVE' && (
    existing.ownerType !== FileAsset.FILE_OWNER_TYPES.TRANSPORT_REPORT ||
    String(existing.ownerId) !== String(recordId)
  )) {
    throw new Error(`Active FileAsset is already bound to a different owner: ${photo.name}`);
  }
  const extension = '.jpg';
  const generatedStorageKey = [
    String(scope.team._id),
    reportDate.slice(0, 4),
    reportDate.slice(5, 7),
    `${deterministicUuid(`storage:${scope.team._id}:${photo.sha256}`)}${extension}`
  ].join('/');
  const desired = {
    teamId: scope.team._id,
    ownerType: FileAsset.FILE_OWNER_TYPES.TRANSPORT_REPORT,
    ownerId: recordId,
    storageKey: existing?.storageKey || generatedStorageKey,
    originalName: photo.name,
    mimeType: photo.mimeType,
    size: photo.size,
    sha256: photo.sha256,
    uploaderId: existing?.uploaderId || scope.user._id,
    status: FileAsset.FILE_STATUSES.ACTIVE,
    deletedAt: null,
    deletedBy: null
  };
  const fields = Object.keys(desired);
  const unchanged = existing && sameValue(selected(existing, fields), desired);
  changes[existing ? (unchanged ? 'unchanged' : 'updated') : 'created'] += 1;
  const document = existing || new FileAsset({ _id: deterministicId, ...desired });
  if (existing && (
    existing.storageKey !== desired.storageKey ||
    existing.sha256 !== desired.sha256 ||
    String(existing.uploaderId) !== String(desired.uploaderId)
  )) {
    throw new Error(`Immutable FileAsset metadata mismatch for ${photo.name}`);
  }
  Object.assign(document, desired);
  await document.validate();
  await copyPhotoIfNeeded({
    photo,
    targetPath: storagePath(options.uploadDir, desired.storageKey),
    apply: options.apply,
    storageChanges
  });
  if (options.apply && !unchanged) await document.save();
  return document._id;
}

function transportRemark(scope) {
  return [
    `[${IMPORT_TAG}] 客户原始数据仅提供日期、车次、车牌号和装载明细。`,
    `以下均为待客户确认的测试占位值：组织=${scope.orgUnit.name}(${scope.orgUnit.code})、`,
    '班次=白班、路线=待客户确认（测试占位）、配送类型=配送、司机=待客户确认。',
    '照片按客户资料发送顺序临时关联，仅用于网站测试，客户确认后方可作为正式数据。'
  ].join('');
}

async function resolveTransportDocument(fixture, scope) {
  const naturalFilter = {
    teamId: scope.team._id,
    reportDate: fixture.reportDate,
    tripLabel: fixture.tripLabel,
    vehiclePlate: fixture.vehiclePlate
  };
  const deterministicId = deterministicObjectId(
    `transport:${scope.team._id}:${fixture.reportDate}:${fixture.tripLabel}:${fixture.vehiclePlate}`
  );
  const byId = await TransportRecord.findById(deterministicId);
  if (byId) {
    if (
      String(byId.teamId) !== String(scope.team._id) ||
      !String(byId.remark || '').includes(`[${IMPORT_TAG}]`)
    ) {
      throw new Error(`Deterministic transport ID collision: ${deterministicId}`);
    }
    return { document: byId, naturalFilter };
  }
  const naturalMatches = await TransportRecord.find(naturalFilter).limit(2);
  if (naturalMatches.length > 0) {
    const tagged = naturalMatches.filter((record) => (
      String(record.remark || '').includes(`[${IMPORT_TAG}]`)
    ));
    if (naturalMatches.length !== 1 || tagged.length !== 1) {
      throw new Error(
        `Customer import refuses to overwrite an existing transport record: ${fixture.reportDate} ${fixture.tripLabel}`
      );
    }
    return { document: tagged[0], naturalFilter };
  }
  return {
    document: new TransportRecord({ _id: deterministicId, ...naturalFilter }),
    naturalFilter
  };
}

async function upsertTransportFixtures({ fixtures, scope, options, changes, fileChanges, storageChanges }) {
  const recordIds = [];
  const fileIds = [];
  const expectedRecords = [];
  for (const fixture of fixtures) {
    const { document } = await resolveTransportDocument(fixture, scope);
    const existing = !document.isNew;
    const photoFileIds = [];
    for (const photo of fixture.photoFiles) {
      const fileId = await upsertPhotoAsset({
        photo,
        recordId: document._id,
        reportDate: fixture.reportDate,
        scope,
        options,
        changes: fileChanges,
        storageChanges
      });
      photoFileIds.push(fileId);
      fileIds.push(fileId);
    }
    const desired = {
      orgUnitId: scope.orgUnit._id,
      reportDate: fixture.reportDate,
      shift: TransportRecord.TRANSPORT_SHIFTS.DAY,
      tripLabel: fixture.tripLabel,
      route: '待客户确认（测试占位）',
      dispatchType: TransportRecord.TRANSPORT_DISPATCH_TYPES.DELIVERY,
      vehiclePlate: fixture.vehiclePlate,
      vehicleType: '',
      driverName: '待客户确认',
      loadDetails: fixture.loadDetails,
      photoFileIds,
      remark: transportRemark(scope)
    };
    const unchanged = existing && sameValue(selected(document, TRANSPORT_FIELDS), desired);
    changes[existing ? (unchanged ? 'unchanged' : 'updated') : 'created'] += 1;
    Object.assign(document, desired, { updatedBy: scope.user._id });
    if (!existing) {
      document.createdBy = scope.user._id;
      document.submittedAt = new Date(`${fixture.reportDate}T04:00:00.000Z`);
    }
    await document.validate();
    if (options.apply && !unchanged) await document.save();
    recordIds.push(document._id);
    expectedRecords.push({ _id: document._id, desired: canonical(desired) });
  }
  return { recordIds, fileIds, expectedRecords };
}

async function verifyApplied({
  productionFixtures,
  transportFixtures,
  scope,
  recordIds,
  fileIds,
  expectedRecords,
  uploadDir
}) {
  const verification = {
    productionSchedules: 0,
    transportRecords: 0,
    fileAssets: 0,
    fileBytes: 0
  };
  for (const fixture of productionFixtures) {
    const document = await ProductionSchedule.findOne({
      teamId: scope.team._id,
      orgUnitId: scope.orgUnit._id,
      month: fixture.month
    }).lean();
    if (!document || !sameValue(selected(document, [
      'dailyEntries', 'productionPlanForecast', 'monthlyTotals'
    ]), {
      dailyEntries: fixture.dailyEntries,
      productionPlanForecast: fixture.productionPlanForecast,
      monthlyTotals: fixture.monthlyTotals
    })) throw new Error(`Persisted production verification failed: ${fixture.month}`);
    verification.productionSchedules += 1;
  }
  const records = await TransportRecord.find({ _id: { $in: recordIds } }).lean();
  if (records.length !== transportFixtures.length) throw new Error('Persisted transport count verification failed');
  const recordsById = new Map(records.map((record) => [String(record._id), record]));
  for (const expected of expectedRecords) {
    const persisted = recordsById.get(String(expected._id));
    if (!persisted || !sameValue(selected(persisted, TRANSPORT_FIELDS), expected.desired)) {
      throw new Error(`Persisted transport field verification failed: ${expected._id}`);
    }
  }
  verification.transportRecords = records.length;
  const assets = await FileAsset.find({ _id: { $in: fileIds }, status: 'ACTIVE' }).lean();
  if (assets.length !== new Set(fileIds.map(String)).size) throw new Error('Persisted FileAsset count verification failed');
  for (const asset of assets) {
    const filename = storagePath(uploadDir, asset.storageKey);
    if (existingFileHash(filename) !== asset.sha256) {
      throw new Error(`Persisted file byte verification failed: ${asset.originalName}`);
    }
    verification.fileBytes += 1;
  }
  verification.fileAssets = assets.length;
  return verification;
}

async function runImport(options) {
  const sourceFiles = sourceFileDisposition(options.sourceDir);
  const productionFixtures = buildProductionFixtures(options.sourceDir);
  const transportFixtures = buildTransportFixtures(options.sourceDir);
  const equipmentBundle = buildEquipmentFixtures(options.sourceDir);
  await mongoose.connect(options.mongoTarget.uri, {
    dbName: options.mongoTarget.databaseName,
    autoIndex: false,
    autoCreate: false,
    serverSelectionTimeoutMS: 5000
  });
  try {
    if (!mongoose.connection.name.toLowerCase().endsWith('_v2_test')) {
      throw new Error('Connected database is not an isolated _v2_test database');
    }
    if (!LOOPBACK_HOSTS.has(String(mongoose.connection.host).toLowerCase())) {
      throw new Error('Connected MongoDB server is not loopback');
    }
    const scope = await resolveScope(options);
    const changes = {
      productionSchedules: newChangeCounter(),
      transportRecords: newChangeCounter(),
      fileAssets: newChangeCounter(),
      storage: { missing: 0, copied: 0, alreadyPresent: 0 },
      equipmentCategories: newChangeCounter(),
      equipmentAssets: newChangeCounter(),
      equipmentFileAssets: newChangeCounter(),
      equipmentStorage: { missing: 0, copied: 0, alreadyPresent: 0 }
    };
    await upsertProductionFixtures({
      fixtures: productionFixtures,
      scope,
      apply: options.apply,
      changes: changes.productionSchedules
    });
    const ids = await upsertTransportFixtures({
      fixtures: transportFixtures,
      scope,
      options,
      changes: changes.transportRecords,
      fileChanges: changes.fileAssets,
      storageChanges: changes.storage
    });
    const equipmentIds = await upsertEquipmentFixtures({
      bundle: equipmentBundle,
      scope,
      options,
      changes: {
        categories: changes.equipmentCategories,
        assets: changes.equipmentAssets,
        fileAssets: changes.equipmentFileAssets,
        storage: changes.equipmentStorage
      }
    });
    const sourceVerification = {
      productionMonths: productionFixtures.length,
      productionMonthRange: [productionFixtures[0].month, productionFixtures.at(-1).month],
      juneDailyRows: productionFixtures.find(({ month }) => month === '2026-06').dailyEntries.length,
      juneTotal: totalMonthly(
        productionFixtures.find(({ month }) => month === '2026-06').monthlyTotals
      ),
      juneForecast: 12500,
      julyDailyRows: productionFixtures.find(({ month }) => month === '2026-07').dailyEntries.length,
      julyActualThroughDay16: totalMonthly(
        productionFixtures.find(({ month }) => month === '2026-07').monthlyTotals
      ),
      julyPendingNullDays: 15,
      julyForecast: 12000,
      transportRecords: transportFixtures.length,
      transportPhotos: transportFixtures.reduce((sum, record) => sum + record.photoFiles.length, 0),
      equipmentRows: equipmentBundle.fixtures.length,
      equipmentPublishedAssets: equipmentBundle.publishableFixtures.length,
      equipmentPendingDuplicateRows: equipmentBundle.pendingDuplicateRows.length,
      equipmentSheets: [...new Set(equipmentBundle.fixtures.map(({ sheetName }) => sheetName))],
      equipmentPhotoAssociations: equipmentBundle.photoAssociations,
      equipmentMedia: equipmentBundle.mediaSummary
    };
    const persistedVerification = options.apply
      ? {
        reporting: await verifyApplied({
          productionFixtures,
          transportFixtures,
          scope,
          ...ids,
          uploadDir: options.uploadDir
        }),
        equipment: await verifyEquipmentApplied({
          bundle: equipmentBundle,
          scope,
          ids: equipmentIds,
          uploadDir: options.uploadDir
        })
      }
      : null;
    return {
      status: options.apply ? 'APPLIED' : 'DRY_RUN_OK',
      importTag: IMPORT_TAG,
      target: {
        host: options.mongoTarget.host,
        port: options.mongoTarget.port,
        database: mongoose.connection.name,
        teamId: String(scope.team._id),
        teamCode: scope.team.code,
        orgUnitId: String(scope.orgUnit._id),
        orgCode: scope.orgUnit.code,
        importUserId: String(scope.user._id),
        importUsername: scope.user.username,
        uploadDir: options.uploadDir
      },
      source: {
        directory: options.sourceDir,
        files: sourceFiles,
        productionHistorySha256: sha256File(
          path.join(options.sourceDir, 'spreadsheets', PRODUCTION_HISTORY_FILE)
        ),
        juneDailySha256: sha256File(
          path.join(options.sourceDir, 'spreadsheets', JUNE_DAILY_FILE)
        ),
        transportJsonSha256: sha256File(
          path.join(options.sourceDir, 'transport-records', TRANSPORT_JSON_FILE)
        ),
        equipmentWorkbookSha256: equipmentBundle.sourceDocumentSha256
      },
      changes,
      sourceVerification,
      persistedVerification
    };
  } finally {
    await mongoose.disconnect();
  }
}

async function main({ argv = process.argv.slice(2), env = process.env } = {}) {
  const options = resolveOptions({ argv, env });
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await runImport(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  main().catch(async (error) => {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect().catch(() => {});
    process.stderr.write(`${JSON.stringify({
      status: 'FAILED',
      code: 'CUSTOMER_REAL_TEST_DATA_IMPORT_FAILED',
      message: error.message
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  CUSTOMER_DATA_ROOT,
  DEFAULT_SOURCE_DIR,
  IMPORT_TAG,
  TEST_DATA_ROOT,
  TRANSPORT_PHOTO_GROUPS,
  buildProductionFixtures,
  buildTransportFixtures,
  main,
  parseArgs,
  parseMongoTarget,
  resolveImportUsername,
  resolveOptions,
  runImport,
  usage
};
