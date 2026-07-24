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
equipment_operator_username=''
execute=0

usage() {
  cat <<'EOF'
Verify the off-host D: receipt, run guarded migrations, and atomically activate a V2 candidate.
The isolated V2 API and tunnel must already be stopped by create-v2-test-release-backup.sh.

Dry-run (default):
  activate-v2-test-candidate.sh --release-id <id> --handoff <absolute.json> \
    --offhost-receipt <absolute.json>

Execute:
  activate-v2-test-candidate.sh ... --execute \
    --confirm-instance task-distribution-v2-customer-test \
    --confirm-database customer_acceptance_v2_test \
    --confirm-backup-id <backup-id> \
    --equipment-operator-username <active-audit-operator>
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
    --equipment-operator-username) equipment_operator_username="${2:-}"; shift 2 ;;
    --execute) execute=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) v2_die "Unknown option: $1" ;;
  esac
done

v2_validate_release_id "$release_id"
test "${handoff#/}" != "$handoff" && test -f "$handoff" || v2_die '--handoff must be an existing absolute file'
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
test "$(v2_json_field "$handoff" releaseId)" = "$release_id" || v2_die 'Backup handoff release mismatch'
test "$(v2_json_field "$handoff" database)" = "$V2_EXPECTED_DATABASE" || v2_die 'Backup handoff database mismatch'
test "$(v2_json_field "$handoff" servicesHeldStopped)" = true || \
  v2_die 'Backup handoff does not prove that V2 services were held stopped'
v2_assert_release_directory "$previous_release"
test "$(readlink -f "$V2_CURRENT_LINK" 2>/dev/null || true)" = "$previous_release" || \
  v2_die 'Current release changed after backup handoff'
test -d "$previous_release" || v2_die 'Previous release no longer exists'
test -d "$backup_directory" || v2_die 'On-host verified backup directory is missing'
evidence_dir="${V2_EVIDENCE_ROOT}/${release_id}"
reference_baseline="$evidence_dir/transport-references.before.json"
test -f "$reference_baseline" || v2_die 'Transport reference baseline is missing'
test "$(sha256sum "$reference_baseline" | awk '{print $1}')" = "$expected_reference_baseline_sha256" || \
  v2_die 'Transport reference baseline SHA256 mismatch'

/usr/bin/node - "$offhost_receipt" "$release_id" "$backup_id" "$manifest_sha256" <<'NODE'
const fs = require('node:fs');
const [file, releaseId, backupId, manifestSha256] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(file, 'utf8'));
const failures = [];
const requiredCollections = [
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
];
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

test "$handoff" = "$evidence_dir/backup-handoff.json" || v2_die 'Handoff is outside the release evidence directory'
position_dry="$evidence_dir/position-levels-dry-run.json"
position_execute="$evidence_dir/position-levels-execute.json"
transport_dry="$evidence_dir/transport-master-data-dry-run.json"
transport_execute="$evidence_dir/transport-master-data-execute.json"
equipment_dry="$evidence_dir/equipment-ownership-dry-run.json"
equipment_execute="$evidence_dir/equipment-ownership-execute.json"
equipment_idempotent="$evidence_dir/equipment-ownership-idempotent.json"
acceptance_dry="$evidence_dir/acceptance-july-2026-dry-run.json"
acceptance_execute="$evidence_dir/acceptance-july-2026-execute.json"
acceptance_idempotent="$evidence_dir/acceptance-july-2026-idempotent.json"
preview_summary="$evidence_dir/migration-preview.json"

if test "$execute" -ne 1; then
  v2_require_root
  for report in \
    position-levels-dry-run.json transport-master-data-dry-run.json \
    equipment-ownership-dry-run.json acceptance-july-2026-dry-run.json \
    migration-preview.json; do
    test ! -e "$evidence_dir/$report" && test ! -L "$evidence_dir/$report" || \
      v2_die "Migration preview evidence already exists: $report"
  done

  v2_run_app_node_sealed_report "$V2_APP_ENV" \
    "$candidate/app/script/migratePositionLevels.js" "$position_dry" >/dev/null
  v2_run_app_node_sealed_report "$V2_APP_ENV" \
    "$candidate/app/script/backfillTransportMasterData.js" "$transport_dry" >/dev/null
  v2_run_app_node_sealed_report "$V2_APP_ENV" \
    "$candidate/app/script/backfillCustomerEquipmentOwnership.js" "$equipment_dry" >/dev/null
  v2_run_app_node_sealed_report "$V2_APP_ENV" \
    "$candidate/app/script/repairAcceptanceJuly2026Data.js" "$acceptance_dry" >/dev/null
  v2_write_migration_preview_summary "$candidate" "$evidence_dir"
  cat "$preview_summary"
  exit 0
fi

v2_require_root
v2_require_confirmations "$confirm_instance" "$confirm_database"
test "$confirm_backup_id" = "$backup_id" || v2_die '--confirm-backup-id must equal the stopped-state backup id'
case "$equipment_operator_username" in
  ''|*[!A-Za-z0-9._@-]*) v2_die '--equipment-operator-username must be a safe non-empty username' ;;
esac
test "${#equipment_operator_username}" -le 128 || v2_die '--equipment-operator-username is too long'
v2_validate_migration_preview_summary "$candidate" "$evidence_dir"

for report in \
  position-levels-execute.json transport-master-data-execute.json \
  equipment-ownership-execute.json \
  equipment-ownership-idempotent.json \
  acceptance-july-2026-execute.json \
  acceptance-july-2026-idempotent.json customer-repair-invariants.json \
  transport-reference-invariants.json \
  migration-started.json migration-after.json activation-result.json; do
  test ! -e "$evidence_dir/$report" && test ! -L "$evidence_dir/$report" || \
    v2_die "Evidence file already exists: $report"
done

backup_root=$(v2_operations_value "$candidate" "$operations_env" BACKUP_ROOT)
test "$backup_directory" = "${backup_root}/${backup_id}" || v2_die 'Operations backup root differs from handoff'
verify_again="$evidence_dir/backup-verify-before-migration.json"
test ! -e "$verify_again" || v2_die 'Pre-migration backup verification evidence already exists'
v2_run_operations_node "$candidate/ops/verify-backup.js" \
  --env-file "$operations_env" --backup-id "$backup_id" > "$verify_again"
test "$(v2_json_field "$verify_again" manifestSha256)" = "$manifest_sha256" || \
  v2_die 'Pre-migration backup verification mismatch'
test "$(v2_migration_input_digest)" = "$expected_input_digest" || \
  v2_die 'Migration inputs changed after preview or backup reverification'
v2_validate_migration_preview_summary "$candidate" "$evidence_dir"

/usr/bin/node - "$evidence_dir/migration-started.json" "$release_id" "$backup_id" \
  "$(sha256sum "$preview_summary" | awk '{print $1}')" <<'NODE'
const fs = require('node:fs');
const [file, releaseId, backupId, migrationPreviewSha256] = process.argv.slice(2);
fs.writeFileSync(file, `${JSON.stringify({
  format: 'task-distribution-v2-migration-started/v1',
  startedAt: new Date().toISOString(),
  releaseId,
  backupId,
  migrationPreviewSha256,
  codeOnlyRollbackAllowed: false
}, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o640 });
NODE

migration_started=1
on_failure() {
  status=$?
  trap - EXIT
  if test "$status" -ne 0; then
    systemctl stop "$V2_TUNNEL_UNIT" >/dev/null 2>&1 || true
    systemctl stop "$V2_API_UNIT" >/dev/null 2>&1 || true
    if test "$migration_started" -eq 1; then
      printf 'MIGRATION_OR_ACTIVATION_FAILED: V2 remains stopped; code-only rollback is forbidden. Use the verified backup restore workflow.\n' >&2
    fi
  fi
  exit "$status"
}
trap on_failure EXIT

v2_run_app_node_sealed_report "$V2_APP_ENV" \
  "$candidate/app/script/repairAcceptanceJuly2026Data.js" "$acceptance_execute" --execute \
  --confirm-database "$V2_EXPECTED_DATABASE" --backup-directory "$backup_directory"
/usr/bin/node - "$acceptance_execute" "$backup_id" "$manifest_sha256" <<'NODE'
const report = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
if (report.status !== 'EXECUTED' || report.writePerformed !== true ||
    report.backup?.backupId !== process.argv[3] ||
    report.backup?.manifestSha256 !== process.argv[4] || report.dataWrites !== 4 ||
    report.auditLogsCreated !== 4 || report.after?.state !== 'ALREADY_APPLIED' ||
    report.after?.plannedWriteCount !== 0 || report.after?.blockerCount !== 0) process.exit(1);
NODE

v2_run_app_node_sealed_report "$V2_APP_ENV" \
  "$candidate/app/script/repairAcceptanceJuly2026Data.js" "$acceptance_idempotent" --execute \
  --confirm-database "$V2_EXPECTED_DATABASE" --backup-directory "$backup_directory"
/usr/bin/node - "$acceptance_idempotent" <<'NODE'
const report = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
if (report.status !== 'NO_CHANGES' || report.writePerformed !== false ||
    report.dataWrites !== 0 || report.auditLogsCreated !== 0 ||
    report.before?.state !== 'ALREADY_APPLIED' || report.before?.plannedWriteCount !== 0 ||
    report.before?.blockerCount !== 0 || report.after?.state !== 'ALREADY_APPLIED') process.exit(1);
NODE

v2_run_app_node_sealed_report "$V2_APP_ENV" \
  "$candidate/app/script/migratePositionLevels.js" "$position_execute" --execute \
  --confirm-database "$V2_EXPECTED_DATABASE" --backup-directory "$backup_directory"
/usr/bin/node - "$position_execute" "$backup_id" "$manifest_sha256" <<'NODE'
const report = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
if (report.status !== 'EXECUTED' || report.backup?.backupId !== process.argv[3] ||
    report.backup?.manifestSha256 !== process.argv[4] || report.after?.plannedUpdateCount !== 0 ||
    report.after?.blockers?.length !== 0) process.exit(1);
NODE

v2_run_app_node_sealed_report "$V2_APP_ENV" \
  "$candidate/app/script/backfillTransportMasterData.js" "$transport_execute" --execute \
  --confirm-database "$V2_EXPECTED_DATABASE" --backup-directory "$backup_directory"
/usr/bin/node - "$transport_execute" "$backup_id" "$manifest_sha256" <<'NODE'
const report = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
if (report.status !== 'EXECUTED' || report.backup?.backupId !== process.argv[3] ||
    report.backup?.manifestSha256 !== process.argv[4] || !Array.isArray(report.conflicts) ||
    report.conflicts.length !== 0) process.exit(1);
NODE

v2_run_app_node_sealed_report "$V2_APP_ENV" \
  "$candidate/app/script/backfillCustomerEquipmentOwnership.js" "$equipment_execute" --execute \
  --confirm-database "$V2_EXPECTED_DATABASE" --backup-directory "$backup_directory" \
  --operator-username "$equipment_operator_username"
/usr/bin/node - "$equipment_execute" "$backup_id" "$manifest_sha256" <<'NODE'
const report = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
if (report.status !== 'EXECUTED' || report.writePerformed !== true ||
    report.backup?.backupId !== process.argv[3] ||
    report.backup?.manifestSha256 !== process.argv[4] || report.assetsUpdated !== 86 ||
    report.routinePlansUpdated !== 630 || report.changeRecordsCreated !== 86 ||
    report.auditLogsCreated !== 86 || report.routinePlanOrgUnitConflicts !== 0) process.exit(1);
NODE

v2_run_app_node_sealed_report "$V2_APP_ENV" \
  "$candidate/app/script/backfillCustomerEquipmentOwnership.js" "$equipment_idempotent" --execute \
  --confirm-database "$V2_EXPECTED_DATABASE" --backup-directory "$backup_directory" \
  --operator-username "$equipment_operator_username"
/usr/bin/node - "$equipment_idempotent" "$backup_id" "$manifest_sha256" <<'NODE'
const report = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
if (report.status !== 'EXECUTED' || report.writePerformed !== false ||
    report.backup?.backupId !== process.argv[3] ||
    report.backup?.manifestSha256 !== process.argv[4] || report.assetsToUpdate !== 0 ||
    report.routinePlansToUpdate !== 0 || report.assetsUpdated !== 0 ||
    report.routinePlansUpdated !== 0 || report.auditLogsCreated !== 0) process.exit(1);
NODE

test "$(v2_transport_snapshot_digest)" = "$expected_transport_snapshot" || \
  v2_die 'Historical transport snapshot fields changed during migration'
v2_verify_transport_release_state "$candidate" "$reference_baseline" > \
  "$evidence_dir/transport-reference-invariants.json"

v2_write_runtime_baseline "$evidence_dir/migration-after.json"
v2_verify_customer_repair_state "$candidate" "$evidence_dir" > \
  "$evidence_dir/customer-repair-invariants.json"
wrong_levels=$(mongosh --quiet --host 127.0.0.1 --port 27150 --eval '
  const d=db.getSiblingDB("customer_acceptance_v2_test");
  print(d.teammemberships.countDocuments({$or:[
    {positionKey:"TEAM_LEADER",positionLevel:{$ne:5}},
    {positionKey:"EMPLOYEE",positionLevel:{$ne:6}}
  ]}));
' 2>/dev/null | tail -n 1)
test "$wrong_levels" = 0 || v2_die 'Position-level migration invariant failed'

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

indexes_ready=0
for _ in $(seq 1 30); do
  if mongosh --quiet --host 127.0.0.1 --port 27150 --eval '
      const d=db.getSiblingDB("customer_acceptance_v2_test");
      const transportNames=d.transport_master_data.getIndexes().map(x=>x.name);
      const productionIndex=d.productionschedules.getIndexes()
        .find(x=>x.name==="uq_production_schedule_team_month");
      const productionIndexReady=productionIndex?.unique===true &&
        productionIndex.key?.teamId===1 && productionIndex.key?.month===1 &&
        Object.keys(productionIndex.key).length===2;
      quit(transportNames.includes("uq_transport_master_team_kind_key") &&
        transportNames.includes("ix_transport_master_team_kind_status_sort") &&
        productionIndexReady ? 0 : 2);
    ' >/dev/null 2>&1; then
    indexes_ready=1
    break
  fi
  sleep 1
done
test "$indexes_ready" -eq 1 || \
  v2_die 'Required transport and production schedule indexes were not created'

systemctl start "$V2_TUNNEL_UNIT"
v2_require_active "$V2_TUNNEL_UNIT"
/usr/bin/env bash "$candidate/ops/linux/verify-v2-test-release.sh" --release-id "$release_id" \
  --expected-transport-snapshot "$expected_transport_snapshot" \
  --expected-reference-baseline "$reference_baseline"

/usr/bin/node - "$evidence_dir/activation-result.json" "$release_id" "$previous_release" \
  "$backup_id" "$manifest_sha256" "$(sha256sum "$preview_summary" | awk '{print $1}')" <<'NODE'
const fs = require('node:fs');
const [file, releaseId, previousRelease, backupId, manifestSha256,
  migrationPreviewSha256] = process.argv.slice(2);
fs.writeFileSync(file, `${JSON.stringify({
  format: 'task-distribution-v2-activation-result/v1',
  activatedAt: new Date().toISOString(),
  status: 'ACTIVATED_AND_VERIFIED',
  releaseId,
  previousRelease,
  backupId,
  manifestSha256,
  migrationPreviewSha256
}, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o640 });
NODE

trap - EXIT
printf '{"status":"ACTIVATED_AND_VERIFIED","releaseId":"%s","previous":"%s","backupId":"%s"}\n' \
  "$release_id" "$previous_release" "$backup_id"
