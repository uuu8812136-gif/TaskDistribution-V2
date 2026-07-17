#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const XLSX = require('xlsx');
const AttendanceSubmission = require('../models/AttendanceSubmission');
const OrgUnit = require('../models/OrgUnit');
const ProjectTeam = require('../models/ProjectTeam');
const User = require('../models/User');
const {
  ORG_UNIT_STATUSES,
  ORG_UNIT_TYPES,
  TEAM_STATUSES
} = require('../config/permissions');

const WORKSPACE_ROOT = path.resolve(__dirname, '../..');
const CUSTOMER_DATA_ROOT = path.join(WORKSPACE_ROOT, 'customer-data');
const DEFAULT_SOURCE_DIR = path.join(
  CUSTOMER_DATA_ROOT,
  '2026-07-17-customer-real-data'
);
const SOURCE_FILE = '提报类（开发）(3).xlsx';
const SOURCE_SHEET = '2.出勤日报-分部模板';
const SOURCE_SUMMARY_SHEET = '2.出勤日报-部门汇总';
const IMPORT_TAG = 'customer-attendance-test-data-2026-07-14-v1';
const DEFAULT_TEAM_CODE = 'GEARBOX_LOGISTICS';
const DEFAULT_PARENT_ORG_CODE = 'DEPARTMENT';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const EXPECTED_ORG_UNITS = Object.freeze([
  Object.freeze({ name: '仓配一分部', code: 'ATTENDANCE_01', sortOrder: 10 }),
  Object.freeze({ name: '仓配二分部', code: 'ATTENDANCE_02', sortOrder: 20 }),
  Object.freeze({ name: '仓配三分部', code: 'ATTENDANCE_03', sortOrder: 30 }),
  Object.freeze({ name: '综合管理室-综合组', code: 'ATTENDANCE_04', sortOrder: 40 }),
  Object.freeze({ name: '综合管理室-技术组', code: 'ATTENDANCE_05', sortOrder: 50 }),
  Object.freeze({ name: '现场配送分部', code: 'ATTENDANCE_06', sortOrder: 60 }),
  Object.freeze({ name: '立体库仓配分部', code: 'ATTENDANCE_07', sortOrder: 70 })
]);
const VALUE_OPTIONS = new Set([
  'mongo-uri',
  'source-dir',
  'team-code',
  'parent-org-code',
  'username'
]);
const FLAG_OPTIONS = new Set(['apply', 'help']);

function usage() {
  return [
    'Idempotently import the seven customer attendance rows into a local V2 test database.',
    '',
    'Dry-run (default, read-only):',
    '  node script/importCustomerAttendanceTestData.js --username <local-test-user> --mongo-uri mongodb://127.0.0.1:27140/task_distribution_v2_test',
    '',
    'Apply only after a database backup:',
    '  node script/importCustomerAttendanceTestData.js --username <local-test-user> --mongo-uri mongodb://127.0.0.1:27140/task_distribution_v2_test --apply',
    '',
    'Safety rules:',
    '  - Import username is required via --username or CUSTOMER_TEST_USERNAME; no default account is used.',
    '  - MongoDB must be loopback and the database name must end with _v2_test.',
    '  - Customer source files must remain under the E-drive customer-data directory.',
    '  - Dry-run is the default.',
    '  - Existing MANUAL records or records from another import tag are never overwritten.'
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
  const candidate = path.resolve(WORKSPACE_ROOT, value || DEFAULT_SOURCE_DIR);
  assertEDrive(candidate, 'source-dir');
  if (!isInside(CUSTOMER_DATA_ROOT, candidate, false)) {
    throw new Error('source-dir must be a child of the workspace customer-data directory');
  }
  const realRoot = fs.realpathSync(CUSTOMER_DATA_ROOT);
  const realCandidate = fs.realpathSync(candidate);
  if (!isInside(realRoot, realCandidate, false)) {
    throw new Error('source-dir resolves outside the workspace customer-data directory');
  }
  return realCandidate;
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
  return Object.freeze({
    help: false,
    apply: Boolean(args.apply),
    mongoTarget: parseMongoTarget(
      args.mongoUri || env.CUSTOMER_TEST_MONGODB_URI || env.MONGODB_URI
    ),
    sourceDir: resolveSourceDirectory(args.sourceDir),
    teamCode: (args.teamCode || DEFAULT_TEAM_CODE).trim().toUpperCase(),
    parentOrgCode: (args.parentOrgCode || DEFAULT_PARENT_ORG_CODE).trim().toUpperCase(),
    username
  });
}

function sha256File(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function deterministicObjectId(seed) {
  return new mongoose.Types.ObjectId(
    crypto.createHash('sha256').update(`${IMPORT_TAG}:${seed}`).digest('hex').slice(0, 24)
  );
}

function parseNames(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  return [...new Set(text.split(/[、,，;；\s]+/).map((item) => item.trim()).filter(Boolean))];
}

function parseNamedLine(lines, prefix) {
  const line = lines.find((item) => item.replace(/\s+/g, '').startsWith(prefix));
  if (!line) throw new Error(`Missing attendance source line: ${prefix}`);
  const match = line.match(/（\s*(\d+)\s*）\s*人\s*[（(]\s*([^）)]*)\s*[）)]/);
  if (!match) throw new Error(`Invalid attendance source line: ${line}`);
  return { count: Number(match[1]), names: parseNames(match[2]) };
}

function parseActualAttendance(lines, shiftLabel) {
  const line = lines.find((item) => item.replace(/\s+/g, '').includes(`${shiftLabel}实际出勤（`));
  if (!line) throw new Error(`Missing ${shiftLabel} actual attendance line`);
  const match = line.match(/实际出勤（\s*(\d+)\s*）人/);
  if (!match) throw new Error(`Invalid ${shiftLabel} actual attendance line: ${line}`);
  return Number(match[1]);
}

function parseShift(lines, shiftLabel) {
  return {
    actualAttendanceCount: parseActualAttendance(lines, shiftLabel),
    leave: parseNamedLine(lines, `${shiftLabel}请假`),
    rest: parseNamedLine(lines, `${shiftLabel}休班`),
    sickLeave: parseNamedLine(lines, `${shiftLabel}病假`),
    absenteeism: parseNamedLine(lines, `${shiftLabel}旷工`),
    notYetEmployed: parseNamedLine(lines, `${shiftLabel}未入职`),
    pendingDeparture: parseNamedLine(lines, `${shiftLabel}待离职`)
  };
}

function parseSupport(lines) {
  const line = lines.find((item) => item.trim().startsWith('去（'));
  if (!line) return { destination: '', count: 0, names: [] };
  const match = line.match(/^去（\s*([^）]*)\s*）帮产（\s*(\d+)\s*）人[（(]\s*([^）)]*)\s*[）)]/);
  if (!match) throw new Error(`Invalid support source line: ${line}`);
  return {
    destination: match[1].trim(),
    count: Number(match[2]),
    names: parseNames(match[3])
  };
}

function parseAttendanceText({ orgUnitName, rawText, cellReference }) {
  const lines = String(rawText || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const dateMatch = lines[0]?.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/);
  if (!dateMatch) throw new Error(`Invalid attendance date at ${cellReference}`);
  const headcountLine = lines.find((line) => line.includes('编制（') && line.includes('在册（'));
  const headcountMatch = headcountLine?.match(/编制（\s*(\d+)\s*）人，在册（\s*(\d+)\s*）人/);
  if (!headcountMatch) throw new Error(`Invalid attendance headcount at ${cellReference}`);
  const reportDate = `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`;
  const titleLine = lines.find((line) => line.includes('出勤日报')) || '';
  if (!titleLine.includes(orgUnitName)) {
    throw new Error(`Attendance title does not match ${orgUnitName} at ${cellReference}`);
  }
  return {
    orgUnitName,
    reportDate,
    authorizedHeadcount: Number(headcountMatch[1]),
    registeredHeadcount: Number(headcountMatch[2]),
    dayShift: parseShift(lines, '白班'),
    nightShift: parseShift(lines, '夜班'),
    support: parseSupport(lines),
    otherRemark: '',
    cellReference,
    rawText
  };
}

function parseAttendanceWorkbook(workbook, sourceSha256 = '') {
  const worksheet = workbook.Sheets[SOURCE_SHEET];
  if (!worksheet) throw new Error(`Source workbook is missing ${SOURCE_SHEET}`);
  const expectedNames = new Set(EXPECTED_ORG_UNITS.map(({ name }) => name));
  const rows = [];
  for (const [cellReference, cell] of Object.entries(worksheet)) {
    if (cellReference.startsWith('!') || !expectedNames.has(String(cell?.v || '').trim())) continue;
    const position = XLSX.utils.decode_cell(cellReference);
    const textCellReference = XLSX.utils.encode_cell({ r: position.r, c: position.c + 1 });
    const rawText = worksheet[textCellReference]?.v;
    rows.push(parseAttendanceText({
      orgUnitName: String(cell.v).trim(),
      rawText,
      cellReference: `${SOURCE_SHEET}!${textCellReference}`
    }));
  }
  rows.sort((left, right) => (
    EXPECTED_ORG_UNITS.findIndex(({ name }) => name === left.orgUnitName) -
    EXPECTED_ORG_UNITS.findIndex(({ name }) => name === right.orgUnitName)
  ));
  if (rows.length !== EXPECTED_ORG_UNITS.length) {
    throw new Error(`Expected seven attendance rows, received ${rows.length}`);
  }
  if (new Set(rows.map(({ orgUnitName }) => orgUnitName)).size !== rows.length) {
    throw new Error('Attendance source contains duplicate divisions');
  }
  if (rows.some(({ reportDate }) => reportDate !== '2026-07-14')) {
    throw new Error('All attendance source rows must use 2026-07-14');
  }
  const totals = summarizeFixtures(rows);
  const expectedTotals = {
    authorizedHeadcount: 123,
    registeredHeadcount: 125,
    dayActualAttendance: 125,
    pendingDeparture: 2,
    supportCount: 1
  };
  if (JSON.stringify(totals) !== JSON.stringify(expectedTotals)) {
    throw new Error(`Attendance source totals changed: ${JSON.stringify(totals)}`);
  }
  const dataQualityIssues = Object.freeze([
    Object.freeze({
      code: 'SOURCE_REGISTERED_TOTAL_MISMATCH',
      message: '七个分部原始行在册合计为125，部门汇总模板写为126，等待客户确认。',
      sourceValue: 126,
      calculatedValue: 125,
      sourceReference: `${SOURCE_SUMMARY_SHEET}!D9`
    }),
    Object.freeze({
      code: 'SOURCE_DAY_ACTUAL_TOTAL_MISMATCH',
      message: '七个分部原始行白班实际出勤合计为125，部门汇总模板“今日实际出勤”写为126，等待客户确认。',
      sourceValue: 126,
      calculatedValue: 125,
      sourceReference: `${SOURCE_SUMMARY_SHEET}!D12`
    }),
    Object.freeze({
      code: 'SOURCE_PENDING_DEPARTURE_TOTAL_MISMATCH',
      message: '七个分部原始行待离职合计为2，部门汇总模板写为3，等待客户确认。',
      sourceValue: 3,
      calculatedValue: 2,
      sourceReference: `${SOURCE_SUMMARY_SHEET}!D9`
    })
  ]);
  return rows.map((row) => ({
    ...row,
    dataQualityStatus: AttendanceSubmission.ATTENDANCE_QUALITY_STATUSES.PENDING_CONFIRMATION,
    dataQualityIssues,
    source: {
      type: AttendanceSubmission.ATTENDANCE_SOURCE_TYPES.EXCEL_IMPORT,
      fileName: SOURCE_FILE,
      sheetName: SOURCE_SHEET,
      cellReference: row.cellReference,
      rawText: row.rawText,
      importTag: IMPORT_TAG,
      sourceSha256
    }
  }));
}

function summarizeFixtures(rows) {
  return {
    authorizedHeadcount: rows.reduce((sum, row) => sum + row.authorizedHeadcount, 0),
    registeredHeadcount: rows.reduce((sum, row) => sum + row.registeredHeadcount, 0),
    dayActualAttendance: rows.reduce(
      (sum, row) => sum + row.dayShift.actualAttendanceCount,
      0
    ),
    pendingDeparture: rows.reduce((sum, row) => (
      sum + row.dayShift.pendingDeparture.count + row.nightShift.pendingDeparture.count
    ), 0),
    supportCount: rows.reduce((sum, row) => sum + row.support.count, 0)
  };
}

function buildAttendanceFixtures(sourceDir) {
  const filename = path.join(sourceDir, 'spreadsheets', SOURCE_FILE);
  if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) {
    throw new Error(`Expected customer source file is missing: ${SOURCE_FILE}`);
  }
  const sourceSha256 = sha256File(filename);
  const workbook = XLSX.readFile(filename, { cellFormula: true, cellDates: false });
  return {
    filename,
    sourceSha256,
    fixtures: parseAttendanceWorkbook(workbook, sourceSha256)
  };
}

function sameBusinessRecord(existing, fixture, orgUnitId) {
  const normalized = (value) => JSON.parse(JSON.stringify(value));
  const expected = normalized({
    orgUnitId: String(orgUnitId),
    reportDate: fixture.reportDate,
    authorizedHeadcount: fixture.authorizedHeadcount,
    registeredHeadcount: fixture.registeredHeadcount,
    dayShift: fixture.dayShift,
    nightShift: fixture.nightShift,
    support: fixture.support,
    otherRemark: fixture.otherRemark,
    dataQualityStatus: fixture.dataQualityStatus,
    dataQualityIssues: fixture.dataQualityIssues,
    source: fixture.source
  });
  const actual = normalized({
    orgUnitId: String(existing.orgUnitId),
    reportDate: existing.reportDate,
    authorizedHeadcount: existing.authorizedHeadcount,
    registeredHeadcount: existing.registeredHeadcount,
    dayShift: existing.dayShift,
    nightShift: existing.nightShift,
    support: existing.support,
    otherRemark: existing.otherRemark,
    dataQualityStatus: existing.dataQualityStatus,
    dataQualityIssues: existing.dataQualityIssues,
    source: existing.source
  });
  return JSON.stringify(actual) === JSON.stringify(expected);
}

async function resolveScope(options, fixtures) {
  const team = await ProjectTeam.findOne({
    code: options.teamCode,
    status: TEAM_STATUSES.ACTIVE
  }).lean();
  if (!team) throw new Error(`Active test team not found: ${options.teamCode}`);
  const user = await User.findOne({ usernameNormalized: options.username, status: 'active' }).lean();
  if (!user) throw new Error(`Active import user not found: ${options.username}`);
  const parent = await OrgUnit.findOne({
    teamId: team._id,
    code: options.parentOrgCode,
    status: ORG_UNIT_STATUSES.ACTIVE
  }).lean();
  if (!parent) throw new Error(`Active parent organization not found: ${options.parentOrgCode}`);
  if (parent.level >= 5) throw new Error('Parent organization cannot contain another hierarchy level');

  const existingOrgUnits = await OrgUnit.find({
    teamId: team._id,
    $or: [
      { name: { $in: fixtures.map(({ orgUnitName }) => orgUnitName) } },
      { code: { $in: EXPECTED_ORG_UNITS.map(({ code }) => code) } }
    ]
  }).lean();
  const orgPlans = EXPECTED_ORG_UNITS.map((definition) => {
    const byName = existingOrgUnits.find(({ name }) => name === definition.name);
    const byCode = existingOrgUnits.find(({ code }) => code === definition.code);
    if (byName && byCode && String(byName._id) !== String(byCode._id)) {
      throw new Error(`Organization name/code collision for ${definition.name}`);
    }
    const existing = byName || byCode || null;
    if (existing && existing.name !== definition.name) {
      throw new Error(`Organization code ${definition.code} belongs to ${existing.name}`);
    }
    return {
      definition,
      existing,
      _id: existing?._id || deterministicObjectId(`org:${definition.code}`)
    };
  });
  return { team, user, parent, orgPlans };
}

async function preflightRecords(scope, fixtures) {
  const keys = fixtures.map((fixture) => {
    const orgPlan = scope.orgPlans.find(({ definition }) => definition.name === fixture.orgUnitName);
    return { teamId: scope.team._id, orgUnitId: orgPlan._id, reportDate: fixture.reportDate };
  });
  const existing = await AttendanceSubmission.find({ $or: keys }).lean();
  const plans = fixtures.map((fixture) => {
    const orgPlan = scope.orgPlans.find(({ definition }) => definition.name === fixture.orgUnitName);
    const current = existing.find((item) => (
      String(item.orgUnitId) === String(orgPlan._id) && item.reportDate === fixture.reportDate
    ));
    if (current && (
      current.source?.type !== AttendanceSubmission.ATTENDANCE_SOURCE_TYPES.EXCEL_IMPORT ||
      current.source?.importTag !== IMPORT_TAG
    )) {
      return { fixture, orgPlan, current, action: 'CONFLICT' };
    }
    return {
      fixture,
      orgPlan,
      current,
      action: !current
        ? 'CREATE'
        : sameBusinessRecord(current, fixture, orgPlan._id) ? 'UNCHANGED' : 'UPDATE'
    };
  });
  const conflicts = plans.filter(({ action }) => action === 'CONFLICT');
  if (conflicts.length > 0) {
    throw new Error(
      `Refusing to overwrite ${conflicts.length} manual or foreign attendance record(s): ` +
      conflicts.map(({ fixture }) => fixture.orgUnitName).join(', ')
    );
  }
  return plans;
}

async function applyOrgPlans(scope) {
  for (const plan of scope.orgPlans) {
    if (plan.existing) continue;
    await OrgUnit.create({
      _id: plan._id,
      teamId: scope.team._id,
      parentId: scope.parent._id,
      type: ORG_UNIT_TYPES.SUB_DEPARTMENT,
      code: plan.definition.code,
      name: plan.definition.name,
      status: ORG_UNIT_STATUSES.ACTIVE,
      sortOrder: plan.definition.sortOrder,
      level: scope.parent.level + 1,
      path: `${scope.parent.path}${scope.parent._id}/`
    });
  }
}

async function applyRecordPlans(scope, plans) {
  const submittedAt = new Date('2026-07-14T00:30:00.000Z');
  for (const plan of plans) {
    if (plan.action === 'UNCHANGED') continue;
    const fixture = plan.fixture;
    const payload = {
      teamId: scope.team._id,
      orgUnitId: plan.orgPlan._id,
      reportDate: fixture.reportDate,
      authorizedHeadcount: fixture.authorizedHeadcount,
      registeredHeadcount: fixture.registeredHeadcount,
      dayShift: fixture.dayShift,
      nightShift: fixture.nightShift,
      support: fixture.support,
      otherRemark: fixture.otherRemark,
      reviewStatus: AttendanceSubmission.ATTENDANCE_REVIEW_STATUSES.PENDING_REVIEW,
      reviewedAt: null,
      reviewedBy: null,
      dataQualityStatus: fixture.dataQualityStatus,
      dataQualityIssues: fixture.dataQualityIssues,
      source: fixture.source,
      submittedAt,
      updatedBy: scope.user._id
    };
    if (plan.action === 'CREATE') {
      await AttendanceSubmission.create({
        _id: deterministicObjectId(`attendance:${fixture.orgUnitName}:${fixture.reportDate}`),
        ...payload,
        createdBy: scope.user._id
      });
    } else {
      await AttendanceSubmission.updateOne(
        { _id: plan.current._id, 'source.importTag': IMPORT_TAG },
        { $set: payload },
        { runValidators: true }
      );
    }
  }
}

async function verifyApplied(scope, fixtures) {
  const orgIds = scope.orgPlans.map(({ _id }) => _id);
  const records = await AttendanceSubmission.find({
    teamId: scope.team._id,
    orgUnitId: { $in: orgIds },
    reportDate: '2026-07-14',
    'source.importTag': IMPORT_TAG
  }).lean();
  if (records.length !== 7) throw new Error(`Persisted attendance count is ${records.length}, expected 7`);
  const totals = summarizeFixtures(records);
  if (JSON.stringify(totals) !== JSON.stringify(summarizeFixtures(fixtures))) {
    throw new Error('Persisted attendance totals do not match source fixtures');
  }
  if (records.some(({ dataQualityStatus, dataQualityIssues }) => (
    dataQualityStatus !== AttendanceSubmission.ATTENDANCE_QUALITY_STATUSES.PENDING_CONFIRMATION ||
    dataQualityIssues.length !== 3
  ))) {
    throw new Error('Persisted source-summary contradictions are not marked pending confirmation');
  }
  return { recordCount: records.length, totals, pendingConfirmationCount: records.length };
}

async function runImport(options) {
  const bundle = buildAttendanceFixtures(options.sourceDir);
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
    const scope = await resolveScope(options, bundle.fixtures);
    const plans = await preflightRecords(scope, bundle.fixtures);
    const changes = {
      orgUnits: {
        create: scope.orgPlans.filter(({ existing }) => !existing).length,
        unchanged: scope.orgPlans.filter(({ existing }) => existing).length
      },
      attendanceSubmissions: {
        create: plans.filter(({ action }) => action === 'CREATE').length,
        update: plans.filter(({ action }) => action === 'UPDATE').length,
        unchanged: plans.filter(({ action }) => action === 'UNCHANGED').length
      }
    };
    if (options.apply) {
      await applyOrgPlans(scope);
      await applyRecordPlans(scope, plans);
    }
    return {
      status: options.apply ? 'APPLIED' : 'DRY_RUN_OK',
      importTag: IMPORT_TAG,
      target: {
        host: options.mongoTarget.host,
        port: options.mongoTarget.port,
        database: mongoose.connection.name,
        teamCode: scope.team.code,
        parentOrgCode: scope.parent.code,
        username: scope.user.username
      },
      source: {
        filename: bundle.filename,
        sha256: bundle.sourceSha256,
        sheet: SOURCE_SHEET,
        reportDate: '2026-07-14'
      },
      sourceVerification: {
        recordCount: bundle.fixtures.length,
        organizationNames: bundle.fixtures.map(({ orgUnitName }) => orgUnitName),
        totals: summarizeFixtures(bundle.fixtures),
        qualityStatus: AttendanceSubmission.ATTENDANCE_QUALITY_STATUSES.PENDING_CONFIRMATION,
        contradictionCount: 3
      },
      changes,
      persistedVerification: options.apply
        ? await verifyApplied(scope, bundle.fixtures)
        : null
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
      code: 'CUSTOMER_ATTENDANCE_TEST_DATA_IMPORT_FAILED',
      message: error.message
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_SOURCE_DIR,
  EXPECTED_ORG_UNITS,
  IMPORT_TAG,
  SOURCE_FILE,
  SOURCE_SHEET,
  buildAttendanceFixtures,
  main,
  parseArgs,
  parseAttendanceText,
  parseAttendanceWorkbook,
  parseMongoTarget,
  resolveImportUsername,
  resolveOptions,
  runImport,
  summarizeFixtures,
  usage
};
