'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  exitCodeForReport,
  parseArgs,
  parseExpectedPrimary,
  usage
} = require('../../../app/script/auditEquipmentRoutineBusiness');
const {
  ALLOWED_DATABASE_NAME,
  assertAllowedDatabaseName,
  normalizeOptions
} = require('../../../app/services/equipmentRoutineBusinessAuditService');

test('equipment routine business audit CLI is read-only and parses repeatable release gates', () => {
  assert.deepEqual(parseArgs([]), {
    dryRun: true,
    teamCode: null,
    primaryNames: [],
    expectedPrimaries: []
  });
  assert.deepEqual(parseArgs([
    '--dry-run',
    '--team-code=gearbox_logistics',
    '--primary-name', '监控设备',
    '--expect-primary', '电动叉车（分类：铅酸电池）=6',
    '--expect-primary=电动叉车（分类：锂离子电池）=5',
    '--expect-primary', '辊子输送机=1'
  ]), {
    dryRun: true,
    teamCode: 'GEARBOX_LOGISTICS',
    primaryNames: ['监控设备'],
    expectedPrimaries: [
      { name: '电动叉车（分类：铅酸电池）', expectedInUse: 6 },
      { name: '电动叉车（分类：锂离子电池）', expectedInUse: 5 },
      { name: '辊子输送机', expectedInUse: 1 }
    ]
  });
  assert.deepEqual(parseExpectedPrimary('一级名称=0'), {
    name: '一级名称',
    expectedInUse: 0
  });
  assert.match(usage(), /has no execute mode/);
  assert.match(usage(), /customer_acceptance_v2_test/);
  assert.match(usage(), /输送链 equipment under 辊子输送机/);
});

test('equipment routine business audit CLI rejects ambiguous or write-like arguments', () => {
  assert.throws(() => parseArgs(['--execute']), /Unknown option: --execute/);
  assert.throws(() => parseArgs(['--primary-name', '叉车']), /--team-code is required/);
  assert.throws(() => parseArgs([
    '--team-code', 'GEARBOX_LOGISTICS',
    '--expect-primary', '叉车=6',
    '--expect-primary', '叉车=5'
  ]), /Duplicate --expect-primary name/);
  assert.throws(() => parseExpectedPrimary('叉车=-1'), /must use the form/);
  assert.throws(() => parseExpectedPrimary('叉车'), /must use the form/);
});

test('equipment routine business audit hard-pins the customer acceptance database and exit codes', () => {
  assert.equal(ALLOWED_DATABASE_NAME, 'customer_acceptance_v2_test');
  assert.equal(assertAllowedDatabaseName('customer_acceptance_v2_test'), 'customer_acceptance_v2_test');
  for (const rejected of [
    '',
    'customer_acceptance_v2_dev',
    'customer_acceptance_v2_test_backup',
    'Customer_Acceptance_V2_Test'
  ]) {
    assert.throws(
      () => assertAllowedDatabaseName(rejected),
      (error) => error.code === 'EQUIPMENT_ROUTINE_AUDIT_DATABASE_REJECTED'
    );
  }
  assert.equal(exitCodeForReport({ status: 'PASSED' }), 0);
  assert.equal(exitCodeForReport({ status: 'FAILED' }), 2);
  assert.equal(exitCodeForReport(null), 2);
});

test('equipment routine business audit normalizes target gates without weakening exact names', () => {
  const normalized = normalizeOptions({
    teamCode: ' gearbox_logistics ',
    primaryNames: ['电动叉车（分类：铅酸电池）', '电动叉车（分类：铅酸电池）'],
    expectedPrimaries: [{ name: '辊子输送机', expectedInUse: 1 }]
  });
  assert.equal(normalized.teamCode, 'GEARBOX_LOGISTICS');
  assert.deepEqual(normalized.primaryNames, [
    '电动叉车（分类：铅酸电池）',
    '辊子输送机'
  ]);
  assert.equal(normalized.expectedByName.get('辊子输送机'), 1);
});

test('equipment routine business audit implementation contains no database mutation API', () => {
  const root = path.resolve(__dirname, '../../..');
  const sources = [
    'app/services/equipmentRoutineBusinessAuditService.js',
    'app/script/auditEquipmentRoutineBusiness.js'
  ].map((relative) => fs.readFileSync(path.join(root, relative), 'utf8'));
  const combined = sources.join('\n');
  assert.doesNotMatch(
    combined,
    /\.(?:create|save|insertOne|insertMany|updateOne|updateMany|findOneAndUpdate|replaceOne|deleteOne|deleteMany|bulkWrite|createIndex|dropIndex|syncIndexes)\s*\(/
  );
  assert.doesNotMatch(combined, /https?:\/\/|ssh|82\.156\./i);
});
