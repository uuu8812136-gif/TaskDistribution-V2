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
const activateTransportRepair = read('../linux/activate-v2-test-transport-repair.sh')
const activateAttendanceCorrection = read('../linux/activate-v2-test-attendance-correction.sh')
const activateAttendanceCumulativeCorrection = read('../linux/activate-v2-test-attendance-cumulative-correction.sh')
const resume = read('../linux/resume-v2-test-candidate-activation.sh')
const verify = read('../linux/verify-v2-test-release.sh')
const previewInvariant = read('../lib/v2MigrationPreviewInvariant.js')
const stagingLauncher = read('../../deploy/v2-test/linux/staging-server.cjs')

const migrationFiles = [
  'app/script/backfillCustomerEquipmentOwnership.js',
  'app/services/equipmentOwnershipBackfillService.js',
  'app/script/repairAcceptanceJuly2026Data.js',
  'app/script/repairAcceptanceTransportJuly2026.js',
  'app/services/acceptanceJuly2026DataRepairService.js',
  'app/script/correctAttendancePlanned20260727.js',
  'app/services/attendancePlannedCorrectionService.js',
  'app/script/correctAttendanceProductionCumulative20260806.js',
  'app/services/attendanceProductionCumulativeCorrectionService.js'
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
const requiredBackupCollections = [...migrationCollections, 'authsessions']

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
  assert.match(prepare, /node --check "\$temporary\/app\/script\/repairAcceptanceTransportJuly2026\.js"/)
  assert.match(prepare, /node --check "\$temporary\/app\/services\/acceptanceJuly2026DataRepairService\.js"/)
  assert.match(prepare, /node --check "\$temporary\/app\/script\/correctAttendancePlanned20260727\.js"/)
  assert.match(prepare, /node --check "\$temporary\/app\/services\/attendancePlannedCorrectionService\.js"/)
  assert.match(prepare, /node --check "\$temporary\/app\/script\/correctAttendanceProductionCumulative20260806\.js"/)
  assert.match(prepare, /node --check "\$temporary\/app\/services\/attendanceProductionCumulativeCorrectionService\.js"/)
  assert.match(prepare, /bash -n "\$temporary\/ops\/linux\/activate-v2-test-transport-repair\.sh"/)
  assert.match(prepare, /bash -n "\$temporary\/ops\/linux\/activate-v2-test-attendance-correction\.sh"/)
  assert.match(prepare, /bash -n "\$temporary\/ops\/linux\/activate-v2-test-attendance-cumulative-correction\.sh"/)
  assert.ok(packageBuilder.includes("'ops/lib/v2MigrationPreviewInvariant.js'"))
  assert.ok(common.includes('ops/lib/v2MigrationPreviewInvariant.js'))
  assert.match(prepare, /node --check "\$temporary\/ops\/lib\/v2MigrationPreviewInvariant\.js"/)
})

test('cumulative-production correction has a dedicated backup-gated activation path', () => {
  assert.ok(packageBuilder.includes("'ops/linux/activate-v2-test-attendance-cumulative-correction.sh'"))
  assert.match(activateAttendanceCumulativeCorrection, /v2_require_inactive "\$V2_API_UNIT"/)
  assert.match(activateAttendanceCumulativeCorrection, /physicalDiskSeparated !== true/)
  assert.match(activateAttendanceCumulativeCorrection, /value\.sourceVmVolume === value\.destinationVolume/)
  assert.match(activateAttendanceCumulativeCorrection, /v2_migration_input_digest/)
  assert.match(activateAttendanceCumulativeCorrection, /correctAttendanceProductionCumulative20260806\.js/)
  assert.match(activateAttendanceCumulativeCorrection, /report\.dataWrites !== 1/)
  assert.match(activateAttendanceCumulativeCorrection, /report\.auditLogsCreated !== 1/)
  assert.match(activateAttendanceCumulativeCorrection, /target\.sourceSubmissionCount !== 7/)
  assert.match(activateAttendanceCumulativeCorrection, /previous\.cumulativeTotal !== 64110/)
  assert.match(activateAttendanceCumulativeCorrection, /current\.cumulativeTotal !== 96137/)
  assert.match(activateAttendanceCumulativeCorrection, /ln -s "\$candidate" "\$new_link"/)
  assert.ok(
    activateAttendanceCumulativeCorrection.indexOf('report.dataWrites !== 1') <
      activateAttendanceCumulativeCorrection.indexOf('ln -s "$candidate" "$new_link"')
  )
})

test('planned-attendance correction has a dedicated backup-gated activation path', () => {
  assert.ok(packageBuilder.includes("'ops/linux/activate-v2-test-attendance-correction.sh'"))
  assert.match(activateAttendanceCorrection, /v2_require_inactive "\$V2_API_UNIT"/)
  assert.match(activateAttendanceCorrection, /physicalDiskSeparated !== true/)
  assert.match(activateAttendanceCorrection, /value\.sourceVmVolume === value\.destinationVolume/)
  assert.match(activateAttendanceCorrection, /v2_migration_input_digest/)
  assert.match(activateAttendanceCorrection, /correctAttendancePlanned20260727\.js/)
  assert.match(activateAttendanceCorrection, /report\.dataWrites !== 1/)
  assert.match(activateAttendanceCorrection, /report\.auditLogsCreated !== 1/)
  assert.match(activateAttendanceCorrection, /target\.sourceSubmissionCount !== 7/)
  assert.match(activateAttendanceCorrection, /values\.correctedDayPlanned !== 126/)
  assert.match(activateAttendanceCorrection, /ln -s "\$candidate" "\$new_link"/)
  assert.ok(
    activateAttendanceCorrection.indexOf('report.dataWrites !== 1') <
      activateAttendanceCorrection.indexOf('ln -s "$candidate" "$new_link"')
  )
})

test('the packaged staging launcher starts only the isolated API behind the existing Nginx Web listener', () => {
  assert.match(stagingLauncher, /mongoose\.connect\(config\.mongodbUri\)/)
  assert.match(stagingLauncher, /createApp\(config\)/)
  assert.match(stagingLauncher, /app\.listen\(config\.port, '127\.0\.0\.1'/)
  assert.doesNotMatch(stagingLauncher, /http\.createServer|const port = 18130|V2 test Web/)
  assert.match(common, /v2_assert_staging_api_launcher/)
  assert.match(common, /Staging API launcher mismatch/)
})

test('transport history repair has a dedicated backup-gated activation path', () => {
  assert.ok(packageBuilder.includes("'ops/linux/activate-v2-test-transport-repair.sh'"))
  assert.match(activateTransportRepair, /v2_require_inactive "\$V2_API_UNIT"/)
  assert.match(activateTransportRepair, /physicalDiskSeparated !== true/)
  assert.match(activateTransportRepair, /value\.sourceVmVolume === value\.destinationVolume/)
  assert.match(activateTransportRepair, /v2_migration_input_digest/)
  assert.match(activateTransportRepair, /repairAcceptanceTransportJuly2026\.js/)
  assert.match(activateTransportRepair, /report\.dataWrites !== 36/)
  assert.match(activateTransportRepair, /report\.auditLogsCreated !== 36/)
  assert.match(activateTransportRepair, /report\.status !== 'NO_CHANGES'/)
  assert.match(activateTransportRepair, /v2_write_transport_reference_baseline "\$reference_baseline_after"/)
  assert.match(activateTransportRepair, /ln -s "\$candidate" "\$new_link"/)
  assert.ok(
    activateTransportRepair.indexOf('report.dataWrites !== 36') <
      activateTransportRepair.indexOf('ln -s "$candidate" "$new_link"')
  )
})

test('candidate preparation accepts a stopped forward fix only with sealed migration evidence', () => {
  assert.match(prepare, /--forward-fix-migration-started/)
  assert.match(prepare, /v2_assert_stopped_forward_fix_evidence "\$forward_fix_migration_started"/)
  assert.match(backup, /--forward-fix-migration-started/)
  assert.match(backup, /v2_assert_stopped_forward_fix_evidence "\$forward_fix_migration_started"/)
  assert.match(backup, /if test -n "\$forward_fix_migration_started"; then\s+hold_stopped=1/)
  assert.match(common, /task-distribution-v2-migration-started\/v1/)
  assert.match(common, /started\.releaseId !== expectedReleaseId/)
  assert.match(common, /started\.migrationPreviewSha256 !== previewSha256/)
  assert.match(common, /started\.codeOnlyRollbackAllowed !== false/)
  assert.match(common, /v2_require_inactive "\$V2_API_UNIT"/)
  assert.match(common, /v2_require_inactive "\$V2_TUNNEL_UNIT"/)
  assert.match(common, /Forward-fix evidence directory must be sealed and root-owned/)
})

test('resume activation accepts only the sealed known customer-repair failure', () => {
  assert.match(resume, /v2_assert_stopped_forward_fix_evidence "\$source_started"/)
  assert.match(resume, /v2_assert_customer_repair_resume_evidence "\$source_release_id"/)
  assert.match(common, /Customer repair source release already has activation evidence/)
  assert.match(common, /LIVE_ATTENDANCE_RAW_ACTUAL/)
  assert.match(common, /LIVE_ATTENDANCE_NOT_EMPLOYED/)
  assert.match(common, /attendanceRawActual === 18/)
  assert.match(common, /attendanceNotYetEmployed === 0/)
  assert.match(common, /reviewActualAttendance === 125/)
  assert.match(resume, /--failed-resume-release-id/)
  assert.match(resume, /v2_assert_failed_customer_repair_resume_evidence/)
  assert.match(common, /source\.migrationWritesPerformed === 0/)
  assert.match(common, /Failed customer repair resume evidence mismatch/)
})

test('resume activation reuses sealed reports and never reruns migration scripts', () => {
  for (const migration of [
    'migratePositionLevels.js',
    'backfillTransportMasterData.js',
    'backfillCustomerEquipmentOwnership.js',
    'repairAcceptanceJuly2026Data.js'
  ]) assert.doesNotMatch(resume, new RegExp(`app/script/${migration.replace('.', '\\.')}`))
  assert.match(resume, /v2_verify_customer_repair_state "\$candidate" "\$source_evidence_dir"/)
  assert.match(resume, /v2_verify_transport_release_state "\$candidate" "\$source_baseline"/)
  assert.match(resume, /cmp -s "\$runtime_probe" "\$source_evidence_dir\/migration-after\.json"/)
  assert.match(resume, /"migrationWritesPerformed": 0|migrationWritesPerformed: 0/)
  assert.match(resume, /--migration-evidence-release-id "\$source_release_id"/)
  const customerInvariant = resume.indexOf('v2_verify_customer_repair_state')
  const switchCurrent = resume.indexOf('ln -s "$candidate" "$new_link"')
  assert.ok(customerInvariant >= 0 && switchCurrent > customerInvariant)
})

test('stopped-state digest and both on-host and D: backup gates cover all migration inputs', () => {
  for (const collection of migrationCollections) {
    assert.ok(common.includes(`"${collection}"`), `migration digest is missing ${collection}`)
  }
  for (const collection of requiredBackupCollections) {
    assert.ok(backup.includes(`'${collection}'`), `on-host backup gate is missing ${collection}`)
    assert.ok(offHostCopy.includes(`'${collection}'`), `D: receipt gate is missing ${collection}`)
    assert.ok(activate.includes(`'${collection}'`), `activation receipt gate is missing ${collection}`)
  }
  assert.match(activate, /v2_migration_input_digest/)
  assert.match(activate, /Migration inputs changed after the stopped-state backup/)
})

test('release backup grants off-host read access only after the exact backup is verified', () => {
  const directoryValidated = backup.indexOf('test "$backup_directory" = "${backup_root}/${backup_id}"')
  const backupVerified = backup.indexOf('"$candidate/ops/verify-backup.js"')
  const migrationEvidenceVerified = backup.indexOf('if (manifest.database?.name !== database || missing.length)')
  const parentAccessGranted = backup.indexOf('setfacl -m u:serveradmin:--x "$backup_volume" "$backup_root"')
  const accessGranted = backup.indexOf('setfacl -R -m u:serveradmin:rX "$backup_directory"')
  const handoffWritten = backup.indexOf('handoff="$evidence_dir/backup-handoff.json"')
  for (const position of [
    directoryValidated,
    backupVerified,
    migrationEvidenceVerified,
    parentAccessGranted,
    accessGranted,
    handoffWritten
  ]) assert.ok(position >= 0)
  assert.ok(directoryValidated < backupVerified)
  assert.ok(backupVerified < migrationEvidenceVerified)
  assert.ok(migrationEvidenceVerified < parentAccessGranted)
  assert.ok(parentAccessGranted < accessGranted)
  assert.ok(accessGranted < handoffWritten)
  assert.doesNotMatch(backup, /setfacl -R -m u:serveradmin:rX "\$backup_root"/)
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
  assert.match(verify, /--migration-evidence-release-id/)
  assert.match(verify, /v2_assert_customer_repair_resume_evidence/)
})

test('activation and verification require the unique production team-month index', () => {
  for (const script of [activate, verify]) {
    assert.match(script, /uq_production_schedule_team_month/)
    assert.match(script, /productionIndex(?:Ready|Valid)|productionScheduleIndexValid/)
    assert.match(script, /\.unique===true/)
    assert.match(script, /\.key\?\.teamId===1/)
    assert.match(script, /\.key\?\.month===1/)
    assert.match(script, /Object\.keys\([^\n]+\.key\)\.length===2/)
  }
})
