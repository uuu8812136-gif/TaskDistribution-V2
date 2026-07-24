import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

function read(relative) {
  return fs.readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
}

const packageBuilder = read('../windows/New-V2TestReleasePackage.ps1')
const offHostCopy = read('../windows/Copy-V2TestBackupOffHost.ps1')
const common = read('../linux/v2-test-release-common.sh')
const prepare = read('../linux/prepare-v2-test-candidate.sh')
const backup = read('../linux/create-v2-test-release-backup.sh')
const activate = read('../linux/activate-v2-test-candidate.sh')
const verify = read('../linux/verify-v2-test-release.sh')
const previewInvariant = read('../lib/v2MigrationPreviewInvariant.js')

const migrationFiles = [
  'app/script/backfillCustomerEquipmentOwnership.js',
  'app/services/equipmentOwnershipBackfillService.js',
  'app/script/repairAcceptanceJuly2026Data.js',
  'app/services/acceptanceJuly2026DataRepairService.js'
]
const migrationCollections = [
  'projectteams',
  'orgunits',
  'users',
  'teammemberships',
  'transportrecords',
  'equipmentassets',
  'equipmentroutineplans',
  'productionschedules',
  'attendancesubmissions',
  'attendancedailyreviews',
  'generateddailyreports'
]

test('release package and candidate preparation require and syntax-check both protected migrations', () => {
  for (const file of migrationFiles) {
    assert.ok(packageBuilder.includes(`'${file}'`), `package builder is missing ${file}`)
    assert.ok(common.includes(file), `candidate layout is missing ${file}`)
  }
  for (const file of migrationFiles.map((value) => value.replaceAll('/', '\\'))) {
    assert.ok(packageBuilder.includes(`'${file}'`), `package syntax check is missing ${file}`)
  }
  assert.match(prepare, /node --check "\$temporary\/app\/script\/backfillCustomerEquipmentOwnership\.js"/)
  assert.match(prepare, /node --check "\$temporary\/app\/services\/equipmentOwnershipBackfillService\.js"/)
  assert.match(prepare, /node --check "\$temporary\/app\/script\/repairAcceptanceJuly2026Data\.js"/)
  assert.match(prepare, /node --check "\$temporary\/app\/services\/acceptanceJuly2026DataRepairService\.js"/)
  assert.ok(packageBuilder.includes("'ops/lib/v2MigrationPreviewInvariant.js'"))
  assert.ok(common.includes('ops/lib/v2MigrationPreviewInvariant.js'))
  assert.match(prepare, /node --check "\$temporary\/ops\/lib\/v2MigrationPreviewInvariant\.js"/)
})

test('stopped-state digest and both on-host and D: backup gates cover all migration inputs', () => {
  for (const collection of migrationCollections) {
    assert.ok(common.includes(`"${collection}"`), `migration digest is missing ${collection}`)
    assert.ok(backup.includes(`'${collection}'`), `on-host backup gate is missing ${collection}`)
    assert.ok(offHostCopy.includes(`'${collection}'`), `D: receipt gate is missing ${collection}`)
    assert.ok(activate.includes(`'${collection}'`), `activation receipt gate is missing ${collection}`)
  }
  assert.match(activate, /v2_migration_input_digest/)
  assert.match(activate, /Migration inputs changed after the stopped-state backup/)
})

test('activation runs both new migrations as dry-run, execute and idempotent replay before switching current', () => {
  const equipmentDry = activate.indexOf('"$candidate/app/script/backfillCustomerEquipmentOwnership.js" "$equipment_dry"')
  const acceptanceDry = activate.indexOf('"$candidate/app/script/repairAcceptanceJuly2026Data.js" "$acceptance_dry"')
  const migrationStarted = activate.indexOf('/usr/bin/node - "$evidence_dir/migration-started.json"')
  const acceptanceExecute = activate.indexOf('"$acceptance_execute" --execute')
  const acceptanceIdempotent = activate.indexOf('"$acceptance_idempotent" --execute')
  const equipmentExecute = activate.indexOf('"$equipment_execute" --execute')
  const equipmentIdempotent = activate.indexOf('"$equipment_idempotent" --execute')
  const customerInvariant = activate.indexOf('v2_verify_customer_repair_state')
  const switchCurrent = activate.indexOf('ln -s "$candidate" "$new_link"')
  for (const position of [
    equipmentDry,
    acceptanceDry,
    migrationStarted,
    acceptanceExecute,
    acceptanceIdempotent,
    equipmentExecute,
    equipmentIdempotent,
    customerInvariant,
    switchCurrent
  ]) assert.ok(position >= 0)
  assert.ok(equipmentDry < migrationStarted)
  assert.ok(acceptanceDry < migrationStarted)
  assert.ok(migrationStarted < acceptanceExecute)
  assert.ok(acceptanceExecute < acceptanceIdempotent)
  assert.ok(acceptanceIdempotent < equipmentExecute)
  assert.ok(equipmentExecute < equipmentIdempotent)
  assert.ok(equipmentIdempotent < customerInvariant)
  assert.ok(customerInvariant < switchCurrent)
  assert.match(activate, /migration-preview\.json/)
  assert.match(activate, /v2_write_migration_preview_summary/)
  assert.match(activate, /v2_validate_migration_preview_summary/)
  assert.match(activate, /v2_run_app_node_sealed_report/)
  assert.match(common, /Release evidence directory must be owned by root before writing sealed reports/)
  assert.match(common, /Migration preview is missing; run activation without --execute first/)
  assert.match(activate, /--equipment-operator-username/)
  assert.match(activate, /MIGRATION_OR_ACTIVATION_FAILED: V2 remains stopped/)
})

test('default activation writes an immutable preview bound to release, backup and stopped-state input', () => {
  const previewBranch = activate.indexOf('if test "$execute" -ne 1; then')
  const equipmentDry = activate.indexOf('"$candidate/app/script/backfillCustomerEquipmentOwnership.js" "$equipment_dry"')
  const acceptanceDry = activate.indexOf('"$candidate/app/script/repairAcceptanceJuly2026Data.js" "$acceptance_dry"')
  const previewWrite = activate.indexOf('v2_write_migration_preview_summary')
  const executeConfirmation = activate.indexOf('v2_require_confirmations "$confirm_instance" "$confirm_database"')
  const previewValidation = activate.indexOf('v2_validate_migration_preview_summary')
  const migrationStarted = activate.indexOf('/usr/bin/node - "$evidence_dir/migration-started.json"')
  assert.ok(previewBranch >= 0)
  assert.ok(previewBranch < equipmentDry)
  assert.ok(equipmentDry < acceptanceDry)
  assert.ok(acceptanceDry < previewWrite)
  assert.ok(previewWrite < executeConfirmation)
  assert.ok(executeConfirmation < previewValidation)
  assert.ok(previewValidation < migrationStarted)
  for (const identity of [
    'task-distribution-v2-migration-preview/v1',
    'task-distribution-v2-customer-test',
    'customer_acceptance_v2_test',
    '127.0.0.1',
    '27150',
    'customer_acceptance_v2_rs',
    'releaseJsonSha256',
    'manifestSha256',
    'migrationInputSha256'
  ]) assert.ok(previewInvariant.includes(identity), `preview identity is missing ${identity}`)
})

test('migration reports are staged as the app user and sealed into root-owned release evidence', () => {
  assert.match(backup, /install -d -o root -g root -m 0750 "\$evidence_dir"/)
  assert.match(backup, /chown root:root "\$handoff"/)
  assert.match(common, /release-report-staging/)
  assert.match(common, /chown taskdistributionv2test:taskdistributionv2test "\$staging"/)
  assert.match(common, /chown root:root "\$report"/)
  assert.match(common, /chmod 0640 "\$report"/)
  assert.match(common, /mv -T "\$report" "\$destination"/)
  assert.doesNotMatch(activate, /chown taskdistributionv2test:taskdistributionv2test.*preview_summary/s)
})

test('post-activation verification rechecks customer repair reports and live database invariants', () => {
  assert.match(common, /v2_customer_repair_state_json/)
  assert.match(common, /customerRepairReleaseInvariant\.js/)
  assert.match(verify, /v2_validate_migration_preview_summary/)
  assert.match(verify, /v2_verify_customer_repair_state/)
  assert.match(verify, /V2 customer equipment and acceptance repair invariants failed/)
})
