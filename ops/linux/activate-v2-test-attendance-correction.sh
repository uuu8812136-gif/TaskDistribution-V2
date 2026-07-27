#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=v2-test-release-common.sh
. "$SCRIPT_DIR/v2-test-release-common.sh"

release_id=''
handoff=''
offhost_receipt=''
operations_env="$V2_OPERATIONS_ENV"
confirm_instance=''
confirm_database=''
confirm_backup_id=''
execute=0

usage() {
  cat <<'EOF'
Correct the fixed 2026-07-27 planned-attendance text and activate a V2 candidate.
The isolated V2 API and tunnel must already be stopped by create-v2-test-release-backup.sh.

Dry-run (default):
  activate-v2-test-attendance-correction.sh --release-id <id> --handoff <absolute.json> \
    --offhost-receipt <absolute.json>

Execute:
  activate-v2-test-attendance-correction.sh ... --execute \
    --confirm-instance task-distribution-v2-customer-test \
    --confirm-database customer_acceptance_v2_test \
    --confirm-backup-id <backup-id>
EOF
}

while test "$#" -gt 0; do
  case "$1" in
    --release-id) release_id="${2:-}"; shift 2 ;;
    --handoff) handoff="${2:-}"; shift 2 ;;
    --offhost-receipt) offhost_receipt="${2:-}"; shift 2 ;;
    --operations-env) operations_env="${2:-}"; shift 2 ;;
    --confirm-instance) confirm_instance="${2:-}"; shift 2 ;;
    --confirm-database) confirm_database="${2:-}"; shift 2 ;;
    --confirm-backup-id) confirm_backup_id="${2:-}"; shift 2 ;;
    --execute) execute=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) v2_die "Unknown option: $1" ;;
  esac
done

v2_validate_release_id "$release_id"
test "${handoff#/}" != "$handoff" && test -f "$handoff" || \
  v2_die '--handoff must be an existing absolute file'
test "${offhost_receipt#/}" != "$offhost_receipt" && test -f "$offhost_receipt" || \
  v2_die '--offhost-receipt must be an existing absolute file'
test "${operations_env#/}" != "$operations_env" && test -f "$operations_env" || \
  v2_die '--operations-env must be an existing absolute file'
v2_assert_protected_environment_file "$operations_env"

candidate=$(v2_release_path "$release_id")
v2_assert_candidate_layout "$candidate"
v2_assert_release_metadata "$candidate" "$release_id" ''
v2_assert_app_environment
v2_assert_legacy_healthy
v2_assert_mongo_primary
v2_require_inactive "$V2_API_UNIT"
v2_require_inactive "$V2_TUNNEL_UNIT"

backup_id=$(v2_json_field "$handoff" backupId)
backup_directory=$(v2_json_field "$handoff" backupDirectory)
manifest_sha256=$(v2_json_field "$handoff" manifestSha256)
previous_release=$(v2_json_field "$handoff" previousRelease)
expected_input_digest=$(v2_json_field "$handoff" migrationInputSha256)
expected_transport_snapshot=$(v2_json_field "$handoff" transportSnapshotsSha256)
expected_reference_baseline_sha256=$(v2_json_field "$handoff" transportReferenceBaselineSha256)
test "$(v2_json_field "$handoff" format)" = 'task-distribution-v2-release-backup-handoff/v1' || \
  v2_die 'Backup handoff format mismatch'
test "$(v2_json_field "$handoff" instance)" = "$V2_EXPECTED_INSTANCE" || \
  v2_die 'Backup handoff instance mismatch'
test "$(v2_json_field "$handoff" releaseId)" = "$release_id" || \
  v2_die 'Backup handoff release mismatch'
test "$(v2_json_field "$handoff" database)" = "$V2_EXPECTED_DATABASE" || \
  v2_die 'Backup handoff database mismatch'
test "$(v2_json_field "$handoff" servicesHeldStopped)" = true || \
  v2_die 'Backup handoff does not prove that V2 services were held stopped'
v2_assert_release_directory "$previous_release"
test "$(readlink -f "$V2_CURRENT_LINK" 2>/dev/null || true)" = "$previous_release" || \
  v2_die 'Current release changed after backup handoff'
test -d "$backup_directory" || v2_die 'On-host verified backup directory is missing'

evidence_dir="${V2_EVIDENCE_ROOT}/${release_id}"
reference_baseline="$evidence_dir/transport-references.before.json"
test "$handoff" = "$evidence_dir/backup-handoff.json" || \
  v2_die 'Handoff is outside the release evidence directory'
test -f "$reference_baseline" || v2_die 'Transport reference baseline is missing'
test "$(sha256sum "$reference_baseline" | awk '{print $1}')" = \
  "$expected_reference_baseline_sha256" || v2_die 'Transport reference baseline SHA256 mismatch'

/usr/bin/node - "$offhost_receipt" "$release_id" "$backup_id" "$manifest_sha256" <<'NODE'
const fs = require('node:fs');
const [file, releaseId, backupId, manifestSha256] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(file, 'utf8'));
const requiredCollections = [
  'projectteams', 'orgunits', 'users', 'teammemberships', 'transportrecords',
  'equipmentassets', 'equipmentroutineplans', 'authsessions', 'productionschedules',
  'attendancesubmissions', 'attendancedailyreviews', 'generateddailyreports'
];
const failures = [];
if (value.format !== 'task-distribution-v2-offhost-backup-receipt/v1') failures.push('format');
if (value.instance !== 'task-distribution-v2-customer-test') failures.push('instance');
if (value.database !== 'customer_acceptance_v2_test') failures.push('database');
if (value.releaseId !== releaseId) failures.push('releaseId');
if (value.backupId !== backupId) failures.push('backupId');
if (value.manifestSha256 !== manifestSha256) failures.push('manifestSha256');
if (value.destinationVolume !== 'D:') failures.push('destinationVolume');
if (typeof value.destinationDirectory !== 'string' || !value.destinationDirectory.startsWith('D:\\')) {
  failures.push('destinationDirectory');
}
if (!Number.isInteger(value.fileCount) || value.fileCount < 1) failures.push('fileCount');
if (!Array.isArray(value.requiredMigrationCollections) ||
    value.requiredMigrationCollections.length !== requiredCollections.length ||
    value.requiredMigrationCollections.some((name, index) => name !== requiredCollections[index])) {
  failures.push('requiredMigrationCollections');
}
const verifiedAt = Date.parse(value.verifiedAt);
if (!Number.isFinite(verifiedAt) || verifiedAt > Date.now() + 300000) failures.push('verifiedAt');
if (failures.length) {
  process.stderr.write(`Off-host receipt mismatch: ${failures.join(', ')}\n`);
  process.exit(1);
}
NODE

test "$(v2_migration_input_digest)" = "$expected_input_digest" || \
  v2_die 'Migration inputs changed after the stopped-state backup'
test "$(v2_transport_snapshot_digest)" = "$expected_transport_snapshot" || \
  v2_die 'Transport snapshots changed after the stopped-state backup'
v2_verify_transport_release_state "$candidate" "$reference_baseline" >/dev/null

correction_dry="$evidence_dir/attendance-planned-correction-dry-run.json"
correction_execute="$evidence_dir/attendance-planned-correction-execute.json"
correction_idempotent="$evidence_dir/attendance-planned-correction-idempotent.json"
correction_live_verify="$evidence_dir/attendance-planned-correction-live-verify.json"
activation_result="$evidence_dir/attendance-correction-activation-result.json"

validate_ready_report() {
  /usr/bin/node - "$1" <<'NODE'
const report = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
const target = report.before?.target || {};
const values = target.snapshotValues || {};
if (report.format !== 'attendance-planned-2026-07-27-correction/v1' ||
    report.status !== 'DRY_RUN_READY' || report.writePerformed !== false ||
    report.before?.state !== 'READY' || report.before?.blockerCount !== 0 ||
    report.before?.plannedWriteCount !== 1 || report.before?.plannedAuditCount !== 1 ||
    target.teamCode !== 'GEARBOX_LOGISTICS' || target.reportDate !== '2026-07-27' ||
    target.reviewId !== '6a66b5700a362686bda6c1d5' || target.sourceSubmissionCount !== 7 ||
    target.generatedDailyReportCount !== 0 || values.registeredHeadcount !== 123 ||
    values.dayActualAttendance !== 124 || values.dayRest !== 1 ||
    values.dayNotYetEmployed !== 2 || values.dayTemporaryWorker !== 2 ||
    values.correctedDayPlanned !== 126 || values.correctedNightPlanned !== 0) process.exit(1);
NODE
}

if test "$execute" -ne 1; then
  v2_require_root
  test ! -e "$correction_dry" && test ! -L "$correction_dry" || \
    v2_die 'Attendance correction dry-run evidence already exists'
  v2_run_app_node_sealed_report "$V2_APP_ENV" \
    "$candidate/app/script/correctAttendancePlanned20260727.js" "$correction_dry" >/dev/null
  validate_ready_report "$correction_dry"
  cat "$correction_dry"
  exit 0
fi

v2_require_root
v2_require_confirmations "$confirm_instance" "$confirm_database"
test "$confirm_backup_id" = "$backup_id" || \
  v2_die '--confirm-backup-id must equal the stopped-state backup id'
test -f "$correction_dry" || v2_die 'Attendance correction dry-run evidence is missing'
validate_ready_report "$correction_dry"
for report in "$correction_execute" "$correction_idempotent" "$correction_live_verify" \
  "$activation_result" "$evidence_dir/attendance-correction-started.json" \
  "$evidence_dir/transport-reference-invariants.after.json"; do
  test ! -e "$report" && test ! -L "$report" || v2_die "Evidence file already exists: $report"
done

backup_root=$(v2_operations_value "$candidate" "$operations_env" BACKUP_ROOT)
test "$backup_directory" = "${backup_root}/${backup_id}" || \
  v2_die 'Operations backup root differs from handoff'
verify_again="$evidence_dir/backup-verify-before-attendance-correction.json"
test ! -e "$verify_again" || v2_die 'Pre-correction backup verification evidence already exists'
v2_run_operations_node "$candidate/ops/verify-backup.js" \
  --env-file "$operations_env" --backup-id "$backup_id" > "$verify_again"
test "$(v2_json_field "$verify_again" manifestSha256)" = "$manifest_sha256" || \
  v2_die 'Pre-correction backup verification mismatch'
test "$(v2_migration_input_digest)" = "$expected_input_digest" || \
  v2_die 'Migration inputs changed after dry-run or backup reverification'

/usr/bin/node - "$evidence_dir/attendance-correction-started.json" "$release_id" "$backup_id" \
  "$(sha256sum "$correction_dry" | awk '{print $1}')" <<'NODE'
const fs = require('node:fs');
const [file, releaseId, backupId, dryRunSha256] = process.argv.slice(2);
fs.writeFileSync(file, `${JSON.stringify({
  format: 'task-distribution-v2-attendance-correction-started/v1',
  startedAt: new Date().toISOString(), releaseId, backupId, dryRunSha256,
  codeOnlyRollbackAllowed: false
}, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o640 });
NODE

correction_started=1
on_failure() {
  status=$?
  trap - EXIT
  if test "$status" -ne 0; then
    systemctl stop "$V2_TUNNEL_UNIT" >/dev/null 2>&1 || true
    systemctl stop "$V2_API_UNIT" >/dev/null 2>&1 || true
    if test "$correction_started" -eq 1; then
      printf 'ATTENDANCE_CORRECTION_OR_ACTIVATION_FAILED: V2 remains stopped; restore the verified backup before rollback.\n' >&2
    fi
  fi
  exit "$status"
}
trap on_failure EXIT

v2_run_app_node_sealed_report "$V2_APP_ENV" \
  "$candidate/app/script/correctAttendancePlanned20260727.js" "$correction_execute" --execute \
  --confirm-database "$V2_EXPECTED_DATABASE" --backup-directory "$backup_directory"
/usr/bin/node - "$correction_execute" "$backup_id" "$manifest_sha256" <<'NODE'
const report = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
if (report.status !== 'EXECUTED' || report.writePerformed !== true ||
    report.backup?.backupId !== process.argv[3] || report.backup?.manifestSha256 !== process.argv[4] ||
    report.dataWrites !== 1 || report.auditLogsCreated !== 1 ||
    report.before?.state !== 'READY' || report.before?.plannedWriteCount !== 1 ||
    report.after?.state !== 'ALREADY_APPLIED' || report.after?.plannedWriteCount !== 0 ||
    report.after?.blockerCount !== 0 ||
    report.before?.evidence?.sourceSubmissions?.sha256 !==
      report.after?.evidence?.sourceSubmissions?.sha256) process.exit(1);
NODE

v2_run_app_node_sealed_report "$V2_APP_ENV" \
  "$candidate/app/script/correctAttendancePlanned20260727.js" "$correction_idempotent" --execute \
  --confirm-database "$V2_EXPECTED_DATABASE" --backup-directory "$backup_directory"
/usr/bin/node - "$correction_idempotent" <<'NODE'
const report = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
if (report.status !== 'NO_CHANGES' || report.writePerformed !== false ||
    report.dataWrites !== 0 || report.auditLogsCreated !== 0 ||
    report.before?.state !== 'ALREADY_APPLIED' || report.before?.plannedWriteCount !== 0 ||
    report.before?.blockerCount !== 0 || report.after?.state !== 'ALREADY_APPLIED') process.exit(1);
NODE

test "$(v2_transport_snapshot_digest)" = "$expected_transport_snapshot" || \
  v2_die 'Transport snapshots changed during attendance correction'
v2_verify_transport_release_state "$candidate" "$reference_baseline" > \
  "$evidence_dir/transport-reference-invariants.after.json"

new_link="${V2_RELEASE_ROOT}/current.new.${release_id}"
test ! -e "$new_link" && test ! -L "$new_link" || v2_die "Temporary current link exists: $new_link"
ln -s "$candidate" "$new_link"
mv -Tf "$new_link" "$V2_CURRENT_LINK"
systemctl start "$V2_API_UNIT"

healthy=0
for _ in $(seq 1 45); do
  if curl --fail --silent --show-error --max-time 5 http://127.0.0.1:18120/health >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 1
done
test "$healthy" -eq 1 || v2_die 'Candidate API did not become healthy'
systemctl start "$V2_TUNNEL_UNIT"
v2_require_active "$V2_TUNNEL_UNIT"
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:18130/health >/dev/null
curl --fail --silent --show-error --max-time 15 https://v2-test.horselink.cn/health >/dev/null
curl --fail --silent --show-error --max-time 15 \
  https://v2-test.horselink.cn/api/auth/login-teams >/dev/null

test "$(v2_transport_snapshot_digest)" = "$expected_transport_snapshot" || \
  v2_die 'Transport snapshots changed after candidate startup'
v2_verify_transport_release_state "$candidate" "$reference_baseline" >/dev/null
v2_run_app_node_sealed_report "$V2_APP_ENV" \
  "$candidate/app/script/correctAttendancePlanned20260727.js" "$correction_live_verify" >/dev/null
/usr/bin/node - "$correction_live_verify" <<'NODE'
const report = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
const target = report.before?.target || {};
if (report.status !== 'DRY_RUN_NO_CHANGES' || report.writePerformed !== false ||
    report.before?.state !== 'ALREADY_APPLIED' || report.before?.plannedWriteCount !== 0 ||
    report.before?.blockerCount !== 0 || target.sourceSubmissionCount !== 7 ||
    target.generatedDailyReportCount !== 0 ||
    target.snapshotValues?.correctedDayPlanned !== 126 ||
    target.snapshotValues?.correctedNightPlanned !== 0) process.exit(1);
NODE

/usr/bin/node - "$activation_result" "$release_id" "$previous_release" "$backup_id" \
  "$manifest_sha256" "$correction_execute" <<'NODE'
const fs = require('node:fs');
const [file, releaseId, previousRelease, backupId, manifestSha256, reportFile] = process.argv.slice(2);
const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
fs.writeFileSync(file, `${JSON.stringify({
  format: 'task-distribution-v2-attendance-correction-activation-result/v1',
  activatedAt: new Date().toISOString(), status: 'ACTIVATED_AND_VERIFIED',
  releaseId, previousRelease, backupId, manifestSha256,
  targetReviewId: report.after.target.reviewId,
  sourceSubmissionsSha256: report.after.evidence.sourceSubmissions.sha256,
  correctedReviewSha256: report.after.evidence.review.sha256,
  correctedDayPlanned: report.after.target.snapshotValues.correctedDayPlanned,
  dataWrites: 1, auditLogsCreated: 1
}, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o640 });
NODE

trap - EXIT
printf '{"status":"ACTIVATED_AND_VERIFIED","releaseId":"%s","previous":"%s","backupId":"%s","correctedDayPlanned":126,"dataWrites":1,"auditLogsCreated":1}\n' \
  "$release_id" "$previous_release" "$backup_id"
