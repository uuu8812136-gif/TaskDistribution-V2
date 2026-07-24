import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const {
  validateCustomerRepairReleaseState
} = require('../lib/customerRepairReleaseInvariant.js')

const backupId = 'backup-20260724T120000Z-a1b2c3d4'
const manifestSha256 = 'a'.repeat(64)

function equipmentReport(overrides = {}) {
  return {
    status: 'DRY_RUN_READY',
    mode: 'dry-run',
    database: { name: 'customer_acceptance_v2_test' },
    target: { countMatchesExpected: true },
    assetsScanned: 141,
    orgUnitMatches: 86,
    custodianMatches: 20,
    assetsToUpdate: 86,
    routinePlansScanned: 684,
    routinePlansEligible: 630,
    routinePlansOutsideResolvedOwnership: 54,
    routinePlansToUpdate: 630,
    routinePlanOrgUnitConflicts: 0,
    writePerformed: false,
    ...overrides
  }
}

function acceptanceReport(overrides = {}) {
  return {
    status: 'DRY_RUN_READY',
    mode: 'dry-run',
    database: { name: 'customer_acceptance_v2_test' },
    before: { state: 'READY', plannedWriteCount: 3, blockerCount: 0 },
    writePerformed: false,
    dataWrites: 0,
    auditLogsCreated: 0,
    ...overrides
  }
}

function baseInput() {
  const backup = {
    backupId,
    manifestSha256,
    databaseName: 'customer_acceptance_v2_test'
  }
  return {
    backupId,
    manifestSha256,
    equipment: {
      dryRun: equipmentReport(),
      execute: equipmentReport({
        status: 'EXECUTED',
        mode: 'execute',
        backup,
        writePerformed: true,
        assetsUpdated: 86,
        routinePlansUpdated: 630,
        changeRecordsCreated: 86,
        auditLogsCreated: 86
      }),
      idempotent: equipmentReport({
        status: 'EXECUTED',
        mode: 'execute',
        backup,
        assetsToUpdate: 0,
        routinePlansToUpdate: 0,
        assetsUpdated: 0,
        routinePlansUpdated: 0,
        auditLogsCreated: 0
      })
    },
    acceptance: {
      dryRun: acceptanceReport(),
      execute: acceptanceReport({
        status: 'EXECUTED',
        mode: 'execute',
        backup,
        writePerformed: true,
        dataWrites: 3,
        auditLogsCreated: 3,
        after: { state: 'ALREADY_APPLIED', plannedWriteCount: 0, blockerCount: 0 }
      }),
      idempotent: acceptanceReport({
        status: 'NO_CHANGES',
        mode: 'execute',
        before: { state: 'ALREADY_APPLIED', plannedWriteCount: 0, blockerCount: 0 },
        after: { state: 'ALREADY_APPLIED', plannedWriteCount: 0, blockerCount: 0 }
      })
    },
    state: {
      database: 'customer_acceptance_v2_test',
      equipment: {
        importedAssetCount: 141,
        routinePlanCount: 684,
        routinePlanOwnershipMismatchCount: 0
      },
      acceptance: {
        canonicalScheduleCount: 1,
        duplicateScheduleCount: 0,
        teamMonthConflictCount: 0,
        productionTotals: { '2026-07-23': 466, '2026-07-24': 461 },
        attendanceSubmissionCount: 1,
        attendanceRawActual: 122,
        attendanceNotYetEmployed: 1,
        attendanceTemporaryWorker: 2,
        attendanceOtherRemark: '',
        attendanceReviewCount: 1,
        reviewActualAttendance: 125,
        reviewTemporaryWorker: 2,
        finalTextHasTemporaryWorker: true,
        finalTextHasActualAttendance: true
      }
    }
  }
}

test('accepts the exact dry-run, execute, idempotent and live customer repair state', () => {
  const result = validateCustomerRepairReleaseState(baseInput())
  assert.equal(result.status, 'CUSTOMER_REPAIR_INVARIANTS_OK')
  assert.equal(result.mismatchCount, 0)
})

test('rejects equipment ownership, production and attendance drift', () => {
  const input = baseInput()
  input.state.equipment.routinePlanOwnershipMismatchCount = 1
  input.state.acceptance.productionTotals['2026-07-24'] = 922
  input.state.acceptance.reviewActualAttendance = 122
  const result = validateCustomerRepairReleaseState(input)
  assert.equal(result.status, 'CUSTOMER_REPAIR_INVARIANTS_FAILED')
  assert.deepEqual(
    new Set(result.mismatches.map(({ code }) => code)),
    new Set([
      'LIVE_ROUTINE_PLAN_OWNERSHIP_MISMATCHES',
      'LIVE_PRODUCTION_2026_07_24',
      'LIVE_REVIEW_ACTUAL'
    ])
  )
})

test('rejects a migration that was not proven idempotent', () => {
  const input = baseInput()
  input.equipment.idempotent.writePerformed = true
  input.acceptance.idempotent.status = 'EXECUTED'
  const result = validateCustomerRepairReleaseState(input)
  assert.ok(result.mismatches.some(({ code }) => code === 'EQUIPMENT_IDEMPOTENT_WRITE'))
  assert.ok(result.mismatches.some(({ code }) => code === 'ACCEPTANCE_IDEMPOTENT_STATUS'))
})

test('rejects an invalid backup identity before evaluating reports', () => {
  const input = baseInput()
  input.backupId = 'stale-backup'
  assert.throws(
    () => validateCustomerRepairReleaseState(input),
    /backupId is invalid/
  )
})
