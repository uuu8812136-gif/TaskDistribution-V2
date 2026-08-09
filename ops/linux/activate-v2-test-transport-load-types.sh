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
Initialize configurable transport load types and activate a V2 candidate.
The isolated V2 API and tunnel must already be stopped by create-v2-test-release-backup.sh.

Dry-run (default):
  activate-v2-test-transport-load-types.sh --release-id <id> --handoff <absolute.json> \
    --offhost-receipt <absolute.json>

Execute:
  activate-v2-test-transport-load-types.sh ... --execute \
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
if (!/^[A-Z]:$/.test(value.destinationVolume)) failures.push('destinationVolume');
if (!/^[A-Z]:$/.test(value.sourceVmVolume) || value.sourceVmVolume === value.destinationVolume) {
  failures.push('sourceVmVolume');
}
if (!Number.isInteger(value.destinationDiskNumber) || !Number.isInteger(value.sourceVmDiskNumber) ||
    value.destinationDiskNumber === value.sourceVmDiskNumber || value.physicalDiskSeparated !== true) {
  failures.push('physicalDiskSeparated');
}
const destinationPrefix = `${value.destinationVolume}\\`;
if (typeof value.destinationDirectory !== 'string' || !value.destinationDirectory.toUpperCase().startsWith(destinationPrefix)) {
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

load_dry="$evidence_dir/transport-load-types-dry-run.json"
load_execute="$evidence_dir/transport-load-types-execute.json"
load_idempotent="$evidence_dir/transport-load-types-idempotent.json"
load_live_verify="$evidence_dir/transport-load-types-live-verify.json"
load_state="$evidence_dir/transport-load-types-state.json"
activation_result="$evidence_dir/transport-load-types-activation-result.json"

validate_ready_report() {
  /usr/bin/node - "$1" <<'NODE'
const report = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
if (report.format !== 'transport-master-data-backfill/v1' ||
    report.status !== 'DRY_RUN_READY' || report.mode !== 'dry-run' ||
    report.database?.name !== 'customer_acceptance_v2_test' ||
    report.writePerformed !== false || report.activeTeamsScanned !== 2 ||
    report.defaultLoadTypeTeamsToInitialize !== 2 || report.mastersToCreate !== 28 ||
    report.defaultLoadTypesToCreate !== 28 || report.recordsToUpdate !== 0 ||
    !Array.isArray(report.conflicts) || report.conflicts.length !== 0 ||
    report.mastersCreated !== 0 || report.recordsUpdated !== 0) process.exit(1);
NODE
}

validate_zero_write_report() {
  /usr/bin/node - "$1" "$2" <<'NODE'
const report = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
const expectedMode = process.argv[3];
const expectedStatus = expectedMode === 'execute' ? 'EXECUTED' : 'DRY_RUN_READY';
if (report.format !== 'transport-master-data-backfill/v1' ||
    report.status !== expectedStatus || report.mode !== expectedMode ||
    report.database?.name !== 'customer_acceptance_v2_test' ||
    report.writePerformed !== false || report.activeTeamsScanned !== 2 ||
    report.defaultLoadTypeTeamsToInitialize !== 0 || report.mastersToCreate !== 0 ||
    report.defaultLoadTypesToCreate !== 0 || report.recordsToUpdate !== 0 ||
    !Array.isArray(report.conflicts) || report.conflicts.length !== 0 ||
    report.mastersCreated !== 0 || report.recordsUpdated !== 0) process.exit(1);
NODE
}

write_load_type_state() {
  local destination="$1"
  mongosh --quiet --host 127.0.0.1 --port 27150 --eval '
    const d=db.getSiblingDB("customer_acceptance_v2_test");
    const teams=d.projectteams.find({status:"ACTIVE"},{_id:1}).sort({_id:1}).toArray();
    const teamIds=teams.map(team=>String(team._id));
    const rows=d.transport_master_data.find({teamId:{$in:teams.map(team=>team._id)},kind:"LOAD_TYPE"},
      {_id:0,teamId:1,name:1,status:1,sortOrder:1}).sort({teamId:1,sortOrder:1,name:1}).toArray()
      .map(row=>({...row,teamId:String(row.teamId)}));
    const audits=d.audit_logs.find({action:"IMPORT",resourceType:"TRANSPORT_MASTER_DATA",
      "after.source":"transport-master-data-backfill","after.defaultLoadTypesCreated":{$gt:0}},
      {_id:0,targetTeamId:1,"after.mastersCreated":1,"after.defaultLoadTypesCreated":1,
       "after.updatedRecordCount":1}).sort({targetTeamId:1}).toArray()
      .map(row=>({...row,targetTeamId:String(row.targetTeamId)}));
    print(JSON.stringify({teamIds,rows,audits}));
  ' > "$destination"
}

validate_load_type_state() {
  /usr/bin/node - "$1" <<'NODE'
const state = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
const failures = [];
if (!Array.isArray(state.teamIds) || state.teamIds.length !== 2) failures.push('teamIds');
if (!Array.isArray(state.rows) || state.rows.length !== 28) failures.push('rows');
const byTeam = new Map((state.teamIds || []).map(id => [id, []]));
for (const row of state.rows || []) {
  if (!byTeam.has(row.teamId) || row.status !== 'ACTIVE' || typeof row.name !== 'string' || !row.name) {
    failures.push('row');
    continue;
  }
  byTeam.get(row.teamId).push(row);
}
for (const rows of byTeam.values()) {
  if (rows.length !== 14 || new Set(rows.map(row => row.name)).size !== 14 ||
      JSON.stringify(rows.map(row => row.sortOrder).sort((a, b) => a - b)) !==
        JSON.stringify(Array.from({length: 14}, (_, index) => index))) failures.push('teamRows');
}
if (!Array.isArray(state.audits) || state.audits.length !== 2 ||
    new Set(state.audits.map(row => row.targetTeamId)).size !== 2 ||
    state.audits.some(row => !byTeam.has(row.targetTeamId) || row.after?.mastersCreated !== 14 ||
      row.after?.defaultLoadTypesCreated !== 14 || row.after?.updatedRecordCount !== 0)) {
  failures.push('audits');
}
if (failures.length) {
  process.stderr.write(`Transport load-type state mismatch: ${[...new Set(failures)].join(', ')}\n`);
  process.exit(1);
}
NODE
}

if test "$execute" -ne 1; then
  v2_require_root
  test ! -e "$load_dry" && test ! -L "$load_dry" || \
    v2_die 'Transport load-type dry-run evidence already exists'
  v2_run_app_node_sealed_report "$V2_APP_ENV" \
    "$candidate/app/script/backfillTransportMasterData.js" "$load_dry" >/dev/null
  validate_ready_report "$load_dry"
  cat "$load_dry"
  exit 0
fi

v2_require_root
v2_require_confirmations "$confirm_instance" "$confirm_database"
test "$confirm_backup_id" = "$backup_id" || \
  v2_die '--confirm-backup-id must equal the stopped-state backup id'
test -f "$load_dry" || v2_die 'Transport load-type dry-run evidence is missing'
validate_ready_report "$load_dry"
for report in "$load_execute" "$load_idempotent" "$load_live_verify" "$load_state" \
  "$activation_result" "$evidence_dir/transport-load-types-started.json" \
  "$evidence_dir/transport-reference-invariants.after.json"; do
  test ! -e "$report" && test ! -L "$report" || v2_die "Evidence file already exists: $report"
done

backup_root=$(v2_operations_value "$candidate" "$operations_env" BACKUP_ROOT)
test "$backup_directory" = "${backup_root}/${backup_id}" || \
  v2_die 'Operations backup root differs from handoff'
verify_again="$evidence_dir/backup-verify-before-transport-load-types.json"
test ! -e "$verify_again" || v2_die 'Pre-migration backup verification evidence already exists'
v2_run_operations_node "$candidate/ops/verify-backup.js" \
  --env-file "$operations_env" --backup-id "$backup_id" > "$verify_again"
test "$(v2_json_field "$verify_again" manifestSha256)" = "$manifest_sha256" || \
  v2_die 'Pre-migration backup verification mismatch'
test "$(v2_migration_input_digest)" = "$expected_input_digest" || \
  v2_die 'Migration inputs changed after dry-run or backup reverification'

/usr/bin/node - "$evidence_dir/transport-load-types-started.json" "$release_id" "$backup_id" \
  "$(sha256sum "$load_dry" | awk '{print $1}')" <<'NODE'
const fs = require('node:fs');
const [file, releaseId, backupId, dryRunSha256] = process.argv.slice(2);
fs.writeFileSync(file, `${JSON.stringify({
  format: 'task-distribution-v2-transport-load-types-started/v1',
  startedAt: new Date().toISOString(), releaseId, backupId, dryRunSha256,
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
      printf 'TRANSPORT_LOAD_TYPE_MIGRATION_OR_ACTIVATION_FAILED: V2 remains stopped; restore the verified backup before rollback.\n' >&2
    fi
  fi
  exit "$status"
}
trap on_failure EXIT

v2_run_app_node_sealed_report "$V2_APP_ENV" \
  "$candidate/app/script/backfillTransportMasterData.js" "$load_execute" --execute \
  --confirm-database "$V2_EXPECTED_DATABASE" --backup-directory "$backup_directory"
/usr/bin/node - "$load_execute" "$backup_id" "$manifest_sha256" <<'NODE'
const report = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
if (report.status !== 'EXECUTED' || report.mode !== 'execute' || report.writePerformed !== true ||
    report.backup?.backupId !== process.argv[3] || report.backup?.manifestSha256 !== process.argv[4] ||
    report.activeTeamsScanned !== 2 || report.defaultLoadTypeTeamsToInitialize !== 2 ||
    report.mastersToCreate !== 28 || report.defaultLoadTypesToCreate !== 28 ||
    report.recordsToUpdate !== 0 || !Array.isArray(report.conflicts) || report.conflicts.length !== 0 ||
    report.mastersCreated !== 28 || report.recordsUpdated !== 0) process.exit(1);
NODE

v2_run_app_node_sealed_report "$V2_APP_ENV" \
  "$candidate/app/script/backfillTransportMasterData.js" "$load_idempotent" --execute \
  --confirm-database "$V2_EXPECTED_DATABASE" --backup-directory "$backup_directory"
validate_zero_write_report "$load_idempotent" execute
write_load_type_state "$load_state"
validate_load_type_state "$load_state"

test "$(v2_transport_snapshot_digest)" = "$expected_transport_snapshot" || \
  v2_die 'Transport snapshots changed during load-type initialization'
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
v2_assert_legacy_healthy

test "$(v2_transport_snapshot_digest)" = "$expected_transport_snapshot" || \
  v2_die 'Transport snapshots changed after candidate startup'
v2_verify_transport_release_state "$candidate" "$reference_baseline" >/dev/null
v2_run_app_node_sealed_report "$V2_APP_ENV" \
  "$candidate/app/script/backfillTransportMasterData.js" "$load_live_verify" >/dev/null
validate_zero_write_report "$load_live_verify" dry-run
write_load_type_state "$evidence_dir/transport-load-types-state.live.json"
validate_load_type_state "$evidence_dir/transport-load-types-state.live.json"

/usr/bin/node - "$activation_result" "$release_id" "$previous_release" "$backup_id" \
  "$manifest_sha256" <<'NODE'
const fs = require('node:fs');
const [file, releaseId, previousRelease, backupId, manifestSha256] = process.argv.slice(2);
fs.writeFileSync(file, `${JSON.stringify({
  format: 'task-distribution-v2-transport-load-types-activation-result/v1',
  activatedAt: new Date().toISOString(), status: 'ACTIVATED_AND_VERIFIED',
  releaseId, previousRelease, backupId, manifestSha256,
  activeTeams: 2, loadTypesCreated: 28, auditLogsCreated: 2,
  transportRecordsUpdated: 0
}, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o640 });
NODE

trap - EXIT
printf '{"status":"ACTIVATED_AND_VERIFIED","releaseId":"%s","previous":"%s","backupId":"%s","loadTypesCreated":28,"auditLogsCreated":2,"transportRecordsUpdated":0}\n' \
  "$release_id" "$previous_release" "$backup_id"
