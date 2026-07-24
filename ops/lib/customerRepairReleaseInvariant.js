'use strict';

const fs = require('node:fs');

const EXPECTED_DATABASE = 'customer_acceptance_v2_test';
const EXPECTED_BACKFILL = Object.freeze({
  assetsScanned: 141,
  orgUnitMatches: 86,
  custodianMatches: 20,
  assetsToUpdate: 86,
  routinePlansScanned: 684,
  routinePlansEligible: 630,
  routinePlansOutsideResolvedOwnership: 54,
  routinePlansToUpdate: 630
});

function addMismatch(mismatches, code, expected, actual) {
  mismatches.push({ code, expected, actual });
}

function expectEqual(mismatches, code, actual, expected) {
  if (actual !== expected) addMismatch(mismatches, code, expected, actual ?? null);
}

function expectBackup(mismatches, prefix, report, backupId, manifestSha256) {
  expectEqual(mismatches, `${prefix}_BACKUP_ID`, report?.backup?.backupId, backupId);
  expectEqual(
    mismatches,
    `${prefix}_BACKUP_MANIFEST_SHA256`,
    report?.backup?.manifestSha256,
    manifestSha256
  );
  expectEqual(mismatches, `${prefix}_BACKUP_DATABASE`, report?.backup?.databaseName, EXPECTED_DATABASE);
}

function validateEquipmentReports({ dryRun, execute, idempotent, backupId, manifestSha256 }, mismatches) {
  expectEqual(mismatches, 'EQUIPMENT_DRY_STATUS', dryRun?.status, 'DRY_RUN_READY');
  expectEqual(mismatches, 'EQUIPMENT_DRY_MODE', dryRun?.mode, 'dry-run');
  expectEqual(mismatches, 'EQUIPMENT_DRY_WRITE', dryRun?.writePerformed, false);
  expectEqual(mismatches, 'EQUIPMENT_DRY_DATABASE', dryRun?.database?.name, EXPECTED_DATABASE);
  expectEqual(mismatches, 'EQUIPMENT_DRY_COUNT_MATCH', dryRun?.target?.countMatchesExpected, true);
  for (const [field, expected] of Object.entries(EXPECTED_BACKFILL)) {
    expectEqual(mismatches, `EQUIPMENT_DRY_${field.toUpperCase()}`, dryRun?.[field], expected);
  }
  expectEqual(mismatches, 'EQUIPMENT_DRY_ROUTINE_CONFLICTS', dryRun?.routinePlanOrgUnitConflicts, 0);

  expectEqual(mismatches, 'EQUIPMENT_EXECUTE_STATUS', execute?.status, 'EXECUTED');
  expectEqual(mismatches, 'EQUIPMENT_EXECUTE_MODE', execute?.mode, 'execute');
  expectEqual(mismatches, 'EQUIPMENT_EXECUTE_WRITE', execute?.writePerformed, true);
  expectEqual(mismatches, 'EQUIPMENT_EXECUTE_ASSETS_UPDATED', execute?.assetsUpdated, 86);
  expectEqual(mismatches, 'EQUIPMENT_EXECUTE_ROUTINE_PLANS_UPDATED', execute?.routinePlansUpdated, 630);
  expectEqual(mismatches, 'EQUIPMENT_EXECUTE_CHANGE_RECORDS', execute?.changeRecordsCreated, 86);
  expectEqual(mismatches, 'EQUIPMENT_EXECUTE_AUDITS', execute?.auditLogsCreated, 86);
  expectBackup(mismatches, 'EQUIPMENT_EXECUTE', execute, backupId, manifestSha256);

  expectEqual(mismatches, 'EQUIPMENT_IDEMPOTENT_STATUS', idempotent?.status, 'EXECUTED');
  expectEqual(mismatches, 'EQUIPMENT_IDEMPOTENT_MODE', idempotent?.mode, 'execute');
  expectEqual(mismatches, 'EQUIPMENT_IDEMPOTENT_WRITE', idempotent?.writePerformed, false);
  expectEqual(mismatches, 'EQUIPMENT_IDEMPOTENT_ASSETS_TO_UPDATE', idempotent?.assetsToUpdate, 0);
  expectEqual(mismatches, 'EQUIPMENT_IDEMPOTENT_PLANS_TO_UPDATE', idempotent?.routinePlansToUpdate, 0);
  expectEqual(mismatches, 'EQUIPMENT_IDEMPOTENT_ASSETS_UPDATED', idempotent?.assetsUpdated, 0);
  expectEqual(mismatches, 'EQUIPMENT_IDEMPOTENT_PLANS_UPDATED', idempotent?.routinePlansUpdated, 0);
  expectEqual(mismatches, 'EQUIPMENT_IDEMPOTENT_AUDITS', idempotent?.auditLogsCreated, 0);
  expectBackup(mismatches, 'EQUIPMENT_IDEMPOTENT', idempotent, backupId, manifestSha256);
}

function validateAcceptanceReports({ dryRun, execute, idempotent, backupId, manifestSha256 }, mismatches) {
  expectEqual(mismatches, 'ACCEPTANCE_DRY_STATUS', dryRun?.status, 'DRY_RUN_READY');
  expectEqual(mismatches, 'ACCEPTANCE_DRY_MODE', dryRun?.mode, 'dry-run');
  expectEqual(mismatches, 'ACCEPTANCE_DRY_WRITE', dryRun?.writePerformed, false);
  expectEqual(mismatches, 'ACCEPTANCE_DRY_DATABASE', dryRun?.database?.name, EXPECTED_DATABASE);
  expectEqual(mismatches, 'ACCEPTANCE_DRY_STATE', dryRun?.before?.state, 'READY');
  expectEqual(mismatches, 'ACCEPTANCE_DRY_PLANNED_WRITES', dryRun?.before?.plannedWriteCount, 4);
  expectEqual(mismatches, 'ACCEPTANCE_DRY_BLOCKERS', dryRun?.before?.blockerCount, 0);

  expectEqual(mismatches, 'ACCEPTANCE_EXECUTE_STATUS', execute?.status, 'EXECUTED');
  expectEqual(mismatches, 'ACCEPTANCE_EXECUTE_MODE', execute?.mode, 'execute');
  expectEqual(mismatches, 'ACCEPTANCE_EXECUTE_WRITE', execute?.writePerformed, true);
  expectEqual(mismatches, 'ACCEPTANCE_EXECUTE_DATA_WRITES', execute?.dataWrites, 4);
  expectEqual(mismatches, 'ACCEPTANCE_EXECUTE_AUDITS', execute?.auditLogsCreated, 4);
  expectEqual(mismatches, 'ACCEPTANCE_EXECUTE_AFTER_STATE', execute?.after?.state, 'ALREADY_APPLIED');
  expectEqual(mismatches, 'ACCEPTANCE_EXECUTE_AFTER_WRITES', execute?.after?.plannedWriteCount, 0);
  expectEqual(mismatches, 'ACCEPTANCE_EXECUTE_AFTER_BLOCKERS', execute?.after?.blockerCount, 0);
  expectBackup(mismatches, 'ACCEPTANCE_EXECUTE', execute, backupId, manifestSha256);

  expectEqual(mismatches, 'ACCEPTANCE_IDEMPOTENT_STATUS', idempotent?.status, 'NO_CHANGES');
  expectEqual(mismatches, 'ACCEPTANCE_IDEMPOTENT_MODE', idempotent?.mode, 'execute');
  expectEqual(mismatches, 'ACCEPTANCE_IDEMPOTENT_WRITE', idempotent?.writePerformed, false);
  expectEqual(mismatches, 'ACCEPTANCE_IDEMPOTENT_DATA_WRITES', idempotent?.dataWrites, 0);
  expectEqual(mismatches, 'ACCEPTANCE_IDEMPOTENT_AUDITS', idempotent?.auditLogsCreated, 0);
  expectEqual(mismatches, 'ACCEPTANCE_IDEMPOTENT_BEFORE_STATE', idempotent?.before?.state, 'ALREADY_APPLIED');
  expectEqual(mismatches, 'ACCEPTANCE_IDEMPOTENT_BEFORE_WRITES', idempotent?.before?.plannedWriteCount, 0);
  expectEqual(mismatches, 'ACCEPTANCE_IDEMPOTENT_BEFORE_BLOCKERS', idempotent?.before?.blockerCount, 0);
  expectEqual(mismatches, 'ACCEPTANCE_IDEMPOTENT_AFTER_STATE', idempotent?.after?.state, 'ALREADY_APPLIED');
}

function validateLiveState(state, mismatches) {
  expectEqual(mismatches, 'LIVE_DATABASE', state?.database, EXPECTED_DATABASE);
  expectEqual(mismatches, 'LIVE_IMPORTED_ASSETS', state?.equipment?.importedAssetCount, 141);
  expectEqual(mismatches, 'LIVE_ROUTINE_PLANS', state?.equipment?.routinePlanCount, 684);
  expectEqual(
    mismatches,
    'LIVE_ROUTINE_PLAN_OWNERSHIP_MISMATCHES',
    state?.equipment?.routinePlanOwnershipMismatchCount,
    0
  );
  expectEqual(mismatches, 'LIVE_CANONICAL_SCHEDULE', state?.acceptance?.canonicalScheduleCount, 1);
  expectEqual(mismatches, 'LIVE_DUPLICATE_SCHEDULE', state?.acceptance?.duplicateScheduleCount, 0);
  expectEqual(mismatches, 'LIVE_JUNE_CANONICAL_SCHEDULE', state?.acceptance?.juneCanonicalScheduleCount, 1);
  expectEqual(mismatches, 'LIVE_JUNE_DUPLICATE_SCHEDULE', state?.acceptance?.juneDuplicateScheduleCount, 0);
  expectEqual(mismatches, 'LIVE_TEAM_MONTH_CONFLICTS', state?.acceptance?.teamMonthConflictCount, 0);
  expectEqual(mismatches, 'LIVE_PRODUCTION_2026_07_23', state?.acceptance?.productionTotals?.['2026-07-23'], 466);
  expectEqual(mismatches, 'LIVE_PRODUCTION_2026_07_24', state?.acceptance?.productionTotals?.['2026-07-24'], 461);
  expectEqual(mismatches, 'LIVE_ATTENDANCE_SUBMISSION', state?.acceptance?.attendanceSubmissionCount, 1);
  expectEqual(mismatches, 'LIVE_ATTENDANCE_RAW_ACTUAL', state?.acceptance?.attendanceRawActual, 18);
  expectEqual(mismatches, 'LIVE_ATTENDANCE_NOT_EMPLOYED', state?.acceptance?.attendanceNotYetEmployed, 0);
  expectEqual(mismatches, 'LIVE_ATTENDANCE_TEMPORARY', state?.acceptance?.attendanceTemporaryWorker, 2);
  expectEqual(mismatches, 'LIVE_ATTENDANCE_REMARK', state?.acceptance?.attendanceOtherRemark, '');
  expectEqual(mismatches, 'LIVE_ATTENDANCE_REVIEW', state?.acceptance?.attendanceReviewCount, 1);
  expectEqual(mismatches, 'LIVE_REVIEW_ACTUAL', state?.acceptance?.reviewActualAttendance, 125);
  expectEqual(mismatches, 'LIVE_REVIEW_TEMPORARY', state?.acceptance?.reviewTemporaryWorker, 2);
  expectEqual(mismatches, 'LIVE_REVIEW_TEXT_TEMPORARY', state?.acceptance?.finalTextHasTemporaryWorker, true);
  expectEqual(mismatches, 'LIVE_REVIEW_TEXT_ACTUAL', state?.acceptance?.finalTextHasActualAttendance, true);
}

function validateCustomerRepairReleaseState({ state, equipment, acceptance, backupId, manifestSha256 } = {}) {
  if (!/^backup-\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(backupId || '')) {
    throw new Error('backupId is invalid');
  }
  if (!/^[a-f0-9]{64}$/.test(manifestSha256 || '')) {
    throw new Error('manifestSha256 is invalid');
  }
  const mismatches = [];
  validateEquipmentReports({ ...equipment, backupId, manifestSha256 }, mismatches);
  validateAcceptanceReports({ ...acceptance, backupId, manifestSha256 }, mismatches);
  validateLiveState(state, mismatches);
  return Object.freeze({
    status: mismatches.length > 0
      ? 'CUSTOMER_REPAIR_INVARIANTS_FAILED'
      : 'CUSTOMER_REPAIR_INVARIANTS_OK',
    database: state?.database || null,
    backupId,
    mismatchCount: mismatches.length,
    mismatches,
    equipment: state?.equipment || null,
    acceptance: state?.acceptance || null
  });
}

function parseArgs(argv) {
  const expected = new Set([
    'equipment-dry',
    'equipment-execute',
    'equipment-idempotent',
    'acceptance-dry',
    'acceptance-execute',
    'acceptance-idempotent',
    'backup-id',
    'manifest-sha256'
  ]);
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--') || !expected.has(token.slice(2)) || !argv[index + 1]) {
      throw new Error(`Invalid argument: ${token || '(missing)'}`);
    }
    const name = token.slice(2);
    if (Object.hasOwn(values, name)) throw new Error(`Duplicate argument: ${token}`);
    values[name] = argv[++index];
  }
  const missing = [...expected].filter((name) => !values[name]);
  if (missing.length > 0) throw new Error(`Missing arguments: ${missing.join(', ')}`);
  return values;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = validateCustomerRepairReleaseState({
    state: JSON.parse(fs.readFileSync(0, 'utf8')),
    backupId: args['backup-id'],
    manifestSha256: args['manifest-sha256'],
    equipment: {
      dryRun: readJson(args['equipment-dry']),
      execute: readJson(args['equipment-execute']),
      idempotent: readJson(args['equipment-idempotent'])
    },
    acceptance: {
      dryRun: readJson(args['acceptance-dry']),
      execute: readJson(args['acceptance-execute']),
      idempotent: readJson(args['acceptance-idempotent'])
    }
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.mismatchCount > 0) process.exitCode = 2;
  return result;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  EXPECTED_BACKFILL,
  EXPECTED_DATABASE,
  validateCustomerRepairReleaseState
};
