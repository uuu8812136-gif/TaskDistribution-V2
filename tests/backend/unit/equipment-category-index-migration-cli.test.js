'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  assertMigrationMongoTarget,
  parseArgs,
  usage
} = require('../../../app/script/migrateEquipmentCategoryIndex');

test('equipment category index migration CLI defaults to dry-run and parses guarded execute options', () => {
  assert.deepEqual(parseArgs([]), { execute: false });
  assert.deepEqual(parseArgs([
    '--execute',
    '--confirm-database', 'equipment_test',
    '--backup-directory=E:\\backup',
    '--report', 'E:\\reports\\equipment-category.json'
  ]), {
    execute: true,
    confirmDatabase: 'equipment_test',
    backupDirectory: 'E:\\backup',
    report: 'E:\\reports\\equipment-category.json'
  });
  assert.match(usage(), /defaults to strict dry-run/);
  assert.match(usage(), /--confirm-database/);
  assert.match(usage(), /--backup-directory/);
});

test('equipment category index migration never uses broad syncIndexes', () => {
  for (const relative of [
    'app/services/equipmentCategoryIndexMigrationService.js',
    'app/script/migrateEquipmentCategoryIndex.js'
  ]) {
    const source = fs.readFileSync(path.resolve(__dirname, '../../..', relative), 'utf8');
    assert.doesNotMatch(source, /syncIndexes\s*\(/, relative);
  }
});

test('equipment category migration CLI accepts only the exact V2 test MongoDB target', () => {
  assert.deepEqual(assertMigrationMongoTarget(
    'mongodb://127.0.0.1:27150/customer_acceptance_v2_test?replicaSet=customer_acceptance_v2_rs'
  ), {
    protocol: 'mongodb:',
    hostname: '127.0.0.1',
    port: '27150',
    database: 'customer_acceptance_v2_test',
    replicaSet: 'customer_acceptance_v2_rs'
  });
  assert.throws(
    () => assertMigrationMongoTarget(
      'mongodb://127.0.0.1:27017/customer_acceptance_v2_test?replicaSet=customer_acceptance_v2_rs'
    ),
    (error) => error.code === 'V2_TEST_MONGODB_TARGET_INVALID' && error.fields.includes('port')
  );
});
