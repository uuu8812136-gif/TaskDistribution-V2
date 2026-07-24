import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const {
  createMigrationPreview,
  validateMigrationPreview
} = require('../lib/v2MigrationPreviewInvariant.js')

const commit = 'a'.repeat(40)
const backupId = 'backup-20260724T120000Z-a1b2c3d4'
const manifestSha256 = 'b'.repeat(64)
const migrationInputSha256 = 'c'.repeat(64)
const releaseId = 'v2-20260724-preview-test'
const now = () => new Date('2026-07-24T13:00:00.000Z')

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-migration-preview-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const candidate = path.join(root, 'candidate')
  const evidenceDir = path.join(root, 'evidence')
  const handoffPath = path.join(evidenceDir, 'backup-handoff.json')
  const previewPath = path.join(evidenceDir, 'migration-preview.json')
  const releasePath = path.join(candidate, 'deploy', 'RELEASE.json')
  writeJson(releasePath, {
    format: 'task-distribution-v2-release/v1',
    releaseId,
    commit,
    environment: 'customer-test',
    mongoPort: 27150,
    replicaSet: 'customer_acceptance_v2_rs',
    database: 'customer_acceptance_v2_test'
  })
  writeJson(handoffPath, {
    format: 'task-distribution-v2-release-backup-handoff/v1',
    createdAt: '2026-07-24T12:30:00.000Z',
    instance: 'task-distribution-v2-customer-test',
    database: 'customer_acceptance_v2_test',
    releaseId,
    backupId,
    manifestSha256,
    migrationInputSha256,
    servicesHeldStopped: true
  })
  writeJson(path.join(evidenceDir, 'position-levels-dry-run.json'), {
    status: 'DRY_RUN_READY',
    mode: 'dry-run',
    database: { name: 'customer_acceptance_v2_test' },
    before: { plannedUpdateCount: 8, blockers: [] },
    writePerformed: false
  })
  writeJson(path.join(evidenceDir, 'transport-master-data-dry-run.json'), {
    status: 'DRY_RUN_READY',
    mode: 'dry-run',
    database: { name: 'customer_acceptance_v2_test' },
    mastersToCreate: 15,
    recordsToUpdate: 6,
    conflicts: [],
    writePerformed: false
  })
  writeJson(path.join(evidenceDir, 'equipment-ownership-dry-run.json'), {
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
    writePerformed: false
  })
  writeJson(path.join(evidenceDir, 'acceptance-july-2026-dry-run.json'), {
    status: 'DRY_RUN_READY',
    mode: 'dry-run',
    database: { name: 'customer_acceptance_v2_test' },
    before: { state: 'READY', plannedWriteCount: 3, blockerCount: 0 },
    writePerformed: false
  })
  return { candidate, evidenceDir, handoffPath, previewPath, releasePath }
}

test('creates and verifies a preview bound to the exact release, backup and report hashes', t => {
  const fixture = createFixture(t)
  const preview = createMigrationPreview({ ...fixture, now })
  writeJson(fixture.previewPath, preview)
  const result = validateMigrationPreview({ ...fixture, now })
  assert.equal(result.status, 'MIGRATION_PREVIEW_VERIFIED')
  assert.equal(result.releaseId, releaseId)
  assert.equal(result.backupId, backupId)
  assert.match(result.previewSha256, /^[a-f0-9]{64}$/)
  assert.equal(preview.mongoTarget.host, '127.0.0.1')
  assert.equal(preview.mongoTarget.port, 27150)
  assert.equal(preview.database, 'customer_acceptance_v2_test')
  assert.equal(preview.writePerformed, false)
})

test('rejects a semantically invalid equipment ownership preview', t => {
  const fixture = createFixture(t)
  const equipmentPath = path.join(fixture.evidenceDir, 'equipment-ownership-dry-run.json')
  const equipment = JSON.parse(fs.readFileSync(equipmentPath, 'utf8'))
  equipment.assetsToUpdate = 85
  writeJson(equipmentPath, equipment)
  assert.throws(
    () => createMigrationPreview({ ...fixture, now }),
    error => error.code === 'V2_MIGRATION_PREVIEW_INVALID' &&
      error.mismatches.includes('equipment.assetsToUpdate')
  )
})

test('rejects report drift after the preview was created even when semantics remain valid', t => {
  const fixture = createFixture(t)
  const preview = createMigrationPreview({ ...fixture, now })
  writeJson(fixture.previewPath, preview)
  const reportPath = path.join(fixture.evidenceDir, 'acceptance-july-2026-dry-run.json')
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  report.generatedAt = '2026-07-24T12:59:59.000Z'
  writeJson(reportPath, report)
  assert.throws(
    () => validateMigrationPreview({ ...fixture, now }),
    error => error.code === 'V2_MIGRATION_PREVIEW_INVALID' &&
      error.mismatches.includes('preview.reports')
  )
})

test('rejects a candidate that points at the legacy MongoDB port', t => {
  const fixture = createFixture(t)
  const release = JSON.parse(fs.readFileSync(fixture.releasePath, 'utf8'))
  release.mongoPort = 27017
  writeJson(fixture.releasePath, release)
  assert.throws(
    () => createMigrationPreview({ ...fixture, now }),
    error => error.code === 'V2_MIGRATION_PREVIEW_INVALID' &&
      error.mismatches.includes('release.mongoPort')
  )
})

test('rejects a preview copied from another backup manifest', t => {
  const fixture = createFixture(t)
  const preview = {
    ...createMigrationPreview({ ...fixture, now }),
    manifestSha256: 'd'.repeat(64)
  }
  writeJson(fixture.previewPath, preview)
  assert.throws(
    () => validateMigrationPreview({ ...fixture, now }),
    error => error.code === 'V2_MIGRATION_PREVIEW_INVALID' &&
      error.mismatches.includes('preview.manifestSha256')
  )
})
