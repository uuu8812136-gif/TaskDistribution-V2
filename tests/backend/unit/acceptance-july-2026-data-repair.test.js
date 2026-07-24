'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  TARGETS,
  attendanceAfterState,
  attendanceBeforeState,
  canonicalize,
  groupScheduleConflicts,
  monthlyTotalsAreEmpty,
  normalizedDailyEntries,
  snapshot,
  verifyExecutionBackup
} = require('../../../app/services/acceptanceJuly2026DataRepairService');
const {
  failureReport,
  parseArgs,
  usage
} = require('../../../app/script/repairAcceptanceJuly2026Data');

function createBackupVerifier({
  databaseName,
  collections,
  files = collections.map(({ name }) => ({
    file: `database/${databaseName}/${name}.bson`
  })),
  manifestSha256 = 'a'.repeat(64)
}) {
  return async () => ({
    backupDirectory: path.resolve(os.tmpdir(), 'acceptance-repair-backup'),
    manifestSha256,
    manifest: {
      backupId: 'backup-20260724T120000Z-12345678',
      completedAt: '2026-07-24T12:00:00.000Z',
      database: {
        name: databaseName,
        collectionCount: collections.length,
        collections
      },
      uploads: { fileCount: 0, bytes: 0 },
      consistency: {
        restoreSet: 'database-and-uploads',
        databaseFileAssetsVerifiedAgainstUploadBytes: true
      },
      files
    }
  });
}

test('acceptance repair is fixed to the six audited record IDs', () => {
  assert.deepEqual(TARGETS, {
    month: '2026-07',
    juneMonth: '2026-06',
    reportDate: '2026-07-24',
    canonicalScheduleId: '6a588ae29ad35af9cfd73c9c',
    duplicateScheduleId: '6a62bd82e4e630b273cd7156',
    juneCanonicalScheduleId: '6a59e5eefe119695fb20f639',
    juneDuplicateScheduleId: '6a62d614e4e630b273cfbf1f',
    juneCanonicalProductionPlanForecast: 12500,
    juneCanonicalMonthlyTotals: {
      aLine: 5429,
      northLine: 0,
      transferCaseLine: 223,
      bLineDay: 4686,
      bLineNight: 1662
    },
    attendanceSubmissionId: '6a62af14e4e630b273cc3174',
    attendanceDailyReviewId: '6a62cccee4e630b273cedbcd',
    sourceRemark: '临时工2人'
  });
});

test('canonical snapshots are stable across object key order and preserve array order', () => {
  const first = snapshot({ z: 1, nested: { b: 2, a: 1 }, rows: [{ y: 2, x: 1 }] });
  const second = snapshot({ rows: [{ x: 1, y: 2 }], nested: { a: 1, b: 2 }, z: 1 });
  const reversed = snapshot({ rows: [{ x: 2, y: 1 }], nested: { a: 1, b: 2 }, z: 1 });
  assert.equal(first.sha256, second.sha256);
  assert.notEqual(first.sha256, reversed.sha256);
  assert.deepEqual(canonicalize({ b: 2, a: 1 }), { a: 1, b: 2 });
});

test('temporary-worker state recognizers accept only the complete before or after shape', () => {
  assert.equal(attendanceBeforeState({
    otherRemark: '临时工2人',
    dayShift: {},
    nightShift: {}
  }), true);
  assert.equal(attendanceBeforeState({
    otherRemark: '临时工2人',
    dayShift: { temporaryWorker: { count: 0, names: [] } },
    nightShift: { temporaryWorker: { count: 0, names: [] } }
  }), true);
  assert.equal(attendanceAfterState({
    otherRemark: '',
    dayShift: { temporaryWorker: { count: 2, names: [] } },
    nightShift: { temporaryWorker: { count: 0, names: [] } }
  }), true);
  assert.equal(attendanceAfterState({
    otherRemark: '',
    dayShift: { temporaryWorker: { count: 2, names: ['unknown'] } },
    nightShift: { temporaryWorker: { count: 0, names: [] } }
  }), false);
});

test('schedule conflicts are grouped strictly by teamId and month', () => {
  const conflicts = groupScheduleConflicts([
    { _id: 'a', teamId: 'team-a', month: '2026-07' },
    { _id: 'b', teamId: 'team-a', month: '2026-07' },
    { _id: 'c', teamId: 'team-b', month: '2026-07' },
    { _id: 'd', teamId: 'team-a', month: '2026-08' }
  ]);
  assert.deepEqual(conflicts, [{
    key: 'team-a:2026-07',
    teamId: 'team-a',
    month: '2026-07',
    scheduleIds: ['a', 'b']
  }]);
  assert.equal(monthlyTotalsAreEmpty({
    aLine: null,
    northLine: null,
    transferCaseLine: null,
    bLineDay: null,
    bLineNight: null
  }), true);
  assert.equal(monthlyTotalsAreEmpty({ aLine: 0 }), false);
});

test('June daily comparison normalizes only missing quantities to numeric zero', () => {
  assert.deepEqual(normalizedDailyEntries([{
    date: '2026-06-01',
    aLineDay: null,
    aLineNight: undefined,
    northLine: 0,
    transferCaseLine: 7,
    bLineDay: '0',
    bLineNight: '7'
  }]), [{
    date: '2026-06-01',
    aLineDay: 0,
    aLineNight: 0,
    northLine: 0,
    transferCaseLine: 7,
    bLineDay: '0',
    bLineNight: '7'
  }]);
});

test('CLI is dry-run by default and rejects unknown or missing values', () => {
  assert.deepEqual(parseArgs([]), { execute: false });
  assert.deepEqual(parseArgs([
    '--execute',
    '--confirm-database=customer_acceptance_v2_test',
    '--backup-directory',
    'E:\\backup',
    '--report',
    'E:\\report.json'
  ]), {
    execute: true,
    confirmDatabase: 'customer_acceptance_v2_test',
    backupDirectory: 'E:\\backup',
    report: 'E:\\report.json'
  });
  assert.throws(() => parseArgs(['--unexpected']), /Unknown option/);
  assert.throws(() => parseArgs(['--report']), /requires a value/);
  assert.match(usage(), /strict dry-run by default/i);
  assert.match(usage(), /No index is created/);
  const failed = failureReport({
    error: Object.assign(new Error('blocked'), { code: 'BLOCKED' }),
    execute: true,
    databaseName: 'customer_acceptance_v2_test'
  });
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.writePerformed, false);
});

test('execute backup guard requires a complete current database-and-uploads restore set', async () => {
  const databaseName = 'customer_acceptance_v2_test';
  const liveCollections = [
    { name: 'authsessions', documentCount: 19 },
    { name: 'attendancedailyreviews', documentCount: 1 },
    { name: 'attendancesubmissions', documentCount: 2 },
    { name: 'generateddailyreports', documentCount: 0 },
    { name: 'productionschedules', documentCount: 2 }
  ];
  const backupCollections = liveCollections.map((collection) => (
    collection.name === 'authsessions'
      ? { ...collection, documentCount: 21 }
      : { ...collection }
  ));
  const backupVerifier = createBackupVerifier({
    databaseName,
    collections: backupCollections
  });
  const result = await verifyExecutionBackup({
    backupDirectory: path.resolve(os.tmpdir(), 'acceptance-repair-backup'),
    databaseName,
    backupVerifier,
    liveCollections,
    minimumCompletedAt: new Date('2026-07-24T11:59:59.000Z')
  });
  assert.equal(result.collectionCountsVerified, true);
  assert.equal(result.completeRestoreSetVerified, true);
  assert.deepEqual(result.ttlCountDrifts, [
    { name: 'authsessions', live: 19, backup: 21 }
  ]);

  await assert.rejects(verifyExecutionBackup({
    backupDirectory: path.resolve(os.tmpdir(), 'acceptance-repair-backup'),
    databaseName,
    backupVerifier: async () => {
      const verified = await backupVerifier();
      verified.manifest.database.collections = verified.manifest.database.collections.slice(1);
      return verified;
    },
    liveCollections
  }), (error) => error.code === 'BACKUP_DATABASE_STATE_INCOMPLETE');
});

test('execute backup guard blocks authsessions growth after backup', async () => {
  const databaseName = 'customer_acceptance_v2_test';
  const backupCollections = [
    { name: 'authsessions', documentCount: 21 },
    { name: 'attendancedailyreviews', documentCount: 1 },
    { name: 'attendancesubmissions', documentCount: 2 },
    { name: 'generateddailyreports', documentCount: 0 },
    { name: 'productionschedules', documentCount: 2 }
  ];
  const backupVerifier = createBackupVerifier({
    databaseName,
    collections: backupCollections,
    manifestSha256: 'b'.repeat(64)
  });

  await assert.rejects(verifyExecutionBackup({
    backupDirectory: path.resolve(os.tmpdir(), 'acceptance-repair-backup'),
    databaseName,
    backupVerifier,
    liveCollections: backupCollections.map((collection) => (
      collection.name === 'authsessions'
        ? { ...collection, documentCount: 22 }
        : { ...collection }
    ))
  }), (error) => {
    assert.equal(error.code, 'BACKUP_DATABASE_STATE_INCOMPLETE');
    assert.deepEqual(error.details.countMismatches, [
      { name: 'authsessions', live: 22, backup: 21 }
    ]);
    return true;
  });
});

test('execute backup guard blocks every business collection count change', async () => {
  const databaseName = 'customer_acceptance_v2_test';
  const backupCollections = [
    { name: 'authsessions', documentCount: 21 },
    { name: 'attendancedailyreviews', documentCount: 1 },
    { name: 'attendancesubmissions', documentCount: 2 },
    { name: 'generateddailyreports', documentCount: 0 },
    { name: 'productionschedules', documentCount: 2 }
  ];
  const backupVerifier = createBackupVerifier({
    databaseName,
    collections: backupCollections,
    manifestSha256: 'c'.repeat(64)
  });

  for (const documentCount of [1, 3]) {
    await assert.rejects(verifyExecutionBackup({
      backupDirectory: path.resolve(os.tmpdir(), 'acceptance-repair-backup'),
      databaseName,
      backupVerifier,
      liveCollections: backupCollections.map((collection) => (
        collection.name === 'attendancesubmissions'
          ? { ...collection, documentCount }
          : { ...collection }
      ))
    }), (error) => {
      assert.equal(error.code, 'BACKUP_DATABASE_STATE_INCOMPLETE');
      assert.deepEqual(error.details.countMismatches, [
        { name: 'attendancesubmissions', live: documentCount, backup: 2 }
      ]);
      return true;
    });
  }
});

test('execute backup guard requires the authsessions BSON restore asset', async () => {
  const databaseName = 'customer_acceptance_v2_test';
  const liveCollections = [
    { name: 'authsessions', documentCount: 0 },
    { name: 'attendancedailyreviews', documentCount: 1 },
    { name: 'attendancesubmissions', documentCount: 2 },
    { name: 'generateddailyreports', documentCount: 0 },
    { name: 'productionschedules', documentCount: 2 }
  ];
  const missingFile = `database/${databaseName}/authsessions.bson`;
  const backupVerifier = createBackupVerifier({
    databaseName,
    collections: liveCollections,
    manifestSha256: 'd'.repeat(64),
    files: liveCollections
      .map(({ name }) => ({ file: `database/${databaseName}/${name}.bson` }))
      .filter(({ file }) => file !== missingFile)
  });

  await assert.rejects(verifyExecutionBackup({
    backupDirectory: path.resolve(os.tmpdir(), 'acceptance-repair-backup'),
    databaseName,
    backupVerifier,
    liveCollections
  }), (error) => {
    assert.equal(error.code, 'BACKUP_DATABASE_STATE_INCOMPLETE');
    assert.deepEqual(error.details.missingDumpFiles, [missingFile]);
    return true;
  });
});
