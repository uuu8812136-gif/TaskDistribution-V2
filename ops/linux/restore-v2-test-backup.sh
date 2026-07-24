#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=v2-test-release-common.sh
. "$SCRIPT_DIR/v2-test-release-common.sh"

release_id=''
handoff=''
restore_env=''
target_database=''
confirm_instance=''
confirm_source_database=''
confirm_target_database=''
confirm_backup_id=''
execute=0

usage() {
  cat <<'EOF'
Restore a stopped-state V2 backup into a new isolated *_v2_test database and restore directory.
The active database, active uploads, current release link, API, and tunnel are never changed.

Dry-run (default):
  restore-v2-test-backup.sh --release-id <id> --handoff <absolute.json> \
    --restore-env <absolute-protected-file> --target-database <new_name_v2_test>

Execute:
  restore-v2-test-backup.sh ... --execute \
    --confirm-instance task-distribution-v2-customer-test \
    --confirm-source-database customer_acceptance_v2_test \
    --confirm-target-database <new_name_v2_test> \
    --confirm-backup-id <backup-id>
EOF
}

while test "$#" -gt 0; do
  case "$1" in
    --release-id) release_id="${2:-}"; shift 2 ;;
    --handoff) handoff="${2:-}"; shift 2 ;;
    --restore-env) restore_env="${2:-}"; shift 2 ;;
    --target-database) target_database="${2:-}"; shift 2 ;;
    --confirm-instance) confirm_instance="${2:-}"; shift 2 ;;
    --confirm-source-database) confirm_source_database="${2:-}"; shift 2 ;;
    --confirm-target-database) confirm_target_database="${2:-}"; shift 2 ;;
    --confirm-backup-id) confirm_backup_id="${2:-}"; shift 2 ;;
    --execute) execute=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) v2_die "Unknown option: $1" ;;
  esac
done

v2_validate_release_id "$release_id"
case "$target_database" in
  ''|*[!A-Za-z0-9_]*) v2_die 'Target database may contain only ASCII letters, digits, and underscores' ;;
  *_v2_test) ;;
  *) v2_die 'Target database must end with _v2_test' ;;
esac
test "${#target_database}" -le 63 || v2_die 'Target database is longer than 63 characters'
test "$target_database" != "$V2_EXPECTED_DATABASE" || v2_die 'Restore target must not be the active V2 database'
test "${handoff#/}" != "$handoff" && test -f "$handoff" || \
  v2_die '--handoff must be an existing absolute file'
test "${restore_env#/}" != "$restore_env" && test -f "$restore_env" || \
  v2_die '--restore-env must be an existing absolute protected file'
v2_assert_protected_environment_file "$restore_env"

candidate=$(v2_release_path "$release_id")
v2_assert_candidate_layout "$candidate"
v2_assert_release_metadata "$candidate" "$release_id" ''
v2_assert_legacy_healthy
v2_assert_mongo_primary
v2_require_inactive "$V2_API_UNIT"
v2_require_inactive "$V2_TUNNEL_UNIT"

backup_id=$(v2_json_field "$handoff" backupId)
backup_directory=$(v2_json_field "$handoff" backupDirectory)
manifest_sha256=$(v2_json_field "$handoff" manifestSha256)
previous_release=$(v2_json_field "$handoff" previousRelease)
test "$(v2_json_field "$handoff" format)" = 'task-distribution-v2-release-backup-handoff/v1' || \
  v2_die 'Backup handoff format mismatch'
test "$(v2_json_field "$handoff" instance)" = "$V2_EXPECTED_INSTANCE" || \
  v2_die 'Backup handoff instance mismatch'
test "$(v2_json_field "$handoff" database)" = "$V2_EXPECTED_DATABASE" || \
  v2_die 'Backup handoff source database mismatch'
test "$(v2_json_field "$handoff" releaseId)" = "$release_id" || \
  v2_die 'Backup handoff release mismatch'
test "$(v2_json_field "$handoff" servicesHeldStopped)" = true || \
  v2_die 'Backup handoff does not prove that V2 services were held stopped'
v2_assert_release_directory "$previous_release"

current_release=$(readlink -f "$V2_CURRENT_LINK" 2>/dev/null || true)
if test "$current_release" != "$previous_release" && test "$current_release" != "$candidate"; then
  v2_die 'Current release is neither the pre-release version nor the failed candidate'
fi

backup_volume=$(v2_operations_value "$candidate" "$restore_env" BACKUP_VOLUME_ROOT)
backup_root=$(v2_operations_value "$candidate" "$restore_env" BACKUP_ROOT)
upload_root=$(v2_operations_value "$candidate" "$restore_env" UPLOAD_PATH)
restore_root=$(v2_operations_value "$candidate" "$restore_env" RESTORE_ROOT)
configured_target=$(v2_operations_value "$candidate" "$restore_env" RESTORE_DATABASE)
allow_remote=$(v2_operations_value "$candidate" "$restore_env" BACKUP_ALLOW_REMOTE)
test "$backup_volume" = '/mnt/taskdistribution-v2-test-backup' || \
  v2_die 'BACKUP_VOLUME_ROOT must be the dedicated V2 backup mount'
test "$backup_root" = "${backup_volume}/backups" || \
  v2_die 'BACKUP_ROOT must be below the dedicated V2 backup mount'
test "$upload_root" = "$V2_UPLOAD_ROOT" || v2_die 'UPLOAD_PATH must remain the active isolated V2 uploads path'
test "$restore_root" = "$V2_RESTORE_ROOT" || v2_die "RESTORE_ROOT must equal ${V2_RESTORE_ROOT}"
test "$configured_target" = "$target_database" || v2_die 'RESTORE_DATABASE differs from --target-database'
test "$allow_remote" = false || v2_die 'BACKUP_ALLOW_REMOTE must remain false'
test "$backup_directory" = "${backup_root}/${backup_id}" || v2_die 'Backup directory differs from protected restore config'
test -d "$backup_directory" || v2_die 'Verified on-host backup directory is missing'
mountpoint -q "$backup_volume" || v2_die 'The dedicated V2 backup volume is not mounted'
test "$(stat -c '%d' "$backup_volume")" != "$(stat -c '%d' /)" || \
  v2_die 'The V2 backup volume is on the root filesystem'

/usr/bin/node - "$candidate/ops/lib/operationsConfig.js" "$restore_env" \
  "$target_database" "$V2_EXPECTED_MONGO_PORT" "$V2_EXPECTED_REPLICA_SET" <<'NODE'
const fs = require('node:fs');
const [modulePath, envFile, targetDatabase, mongoPort, replicaSet] = process.argv.slice(2);
const { parseEnvText } = require(modulePath);
const values = parseEnvText(fs.readFileSync(envFile, 'utf8'));
const uri = new URL(values.RESTORE_MONGODB_URI || '');
const failures = [];
if (uri.protocol !== 'mongodb:') failures.push('protocol');
if (uri.hostname !== '127.0.0.1') failures.push('host');
if (uri.port !== mongoPort) failures.push('port');
if (decodeURIComponent(uri.pathname.replace(/^\//, '')) !== targetDatabase) failures.push('database');
if (uri.searchParams.get('replicaSet') !== replicaSet) failures.push('replicaSet');
if (failures.length) throw new Error(`RESTORE_MONGODB_URI mismatch: ${failures.join(', ')}`);
NODE

empty_collections=$(mongosh --quiet --host 127.0.0.1 --port "$V2_EXPECTED_MONGO_PORT" --eval \
  "print(db.getSiblingDB(\"${target_database}\").getCollectionNames().length)" 2>/dev/null | tail -n 1)
test "$empty_collections" = 0 || v2_die 'Restore target already contains collections and will not be modified'

if test "$execute" -ne 1; then
  printf '{"status":"DRY_RUN_READY","action":"restore-to-new-database","releaseId":"%s","backupId":"%s","sourceDatabase":"%s","targetDatabase":"%s","restoreRoot":"%s"}\n' \
    "$release_id" "$backup_id" "$V2_EXPECTED_DATABASE" "$target_database" "$restore_root"
  exit 0
fi

v2_require_root
v2_require_confirmations "$confirm_instance" ''
test "$confirm_source_database" = "$V2_EXPECTED_DATABASE" || \
  v2_die "--confirm-source-database must equal ${V2_EXPECTED_DATABASE}"
test "$confirm_target_database" = "$target_database" || \
  v2_die '--confirm-target-database must exactly equal the new restore database'
test "$confirm_backup_id" = "$backup_id" || \
  v2_die '--confirm-backup-id must equal the stopped-state backup id'

evidence_dir="${V2_EVIDENCE_ROOT}/${release_id}"
test -d "$evidence_dir" || v2_die 'Release evidence directory is missing'
install -d -o taskdistributionv2test -g taskdistributionv2test -m 0750 "$restore_root"
verify_result="$evidence_dir/restore-${target_database}-backup-verify.json"
restore_summary="$evidence_dir/restore-${target_database}-summary.json"
restore_handoff="$evidence_dir/restore-${target_database}-handoff.json"
for output in "$verify_result" "$restore_summary" "$restore_handoff"; do
  test ! -e "$output" && test ! -L "$output" || v2_die "Restore evidence already exists: $output"
done

v2_run_operations_node "$candidate/ops/verify-backup.js" \
  --env-file "$restore_env" --backup-id "$backup_id" > "$verify_result"
test "$(v2_json_field "$verify_result" manifestSha256)" = "$manifest_sha256" || \
  v2_die 'Backup verification differs from the stopped-state handoff'

v2_run_operations_node "$candidate/ops/restore.js" \
  --env-file "$restore_env" --backup-id "$backup_id" > "$restore_summary"
test "$(v2_json_field "$restore_summary" status)" = RESTORE_VERIFICATION_COMPLETED || \
  v2_die 'Restore did not complete verification'
test "$(v2_json_field "$restore_summary" backupId)" = "$backup_id" || v2_die 'Restore backup id mismatch'
test "$(v2_json_field "$restore_summary" targetDatabase)" = "$target_database" || \
  v2_die 'Restore target database mismatch'
test "$(v2_json_field "$restore_summary" manifestSha256)" = "$manifest_sha256" || \
  v2_die 'Restore manifest SHA256 mismatch'

restore_id=$(v2_json_field "$restore_summary" restoreId)
restore_directory=$(v2_json_field "$restore_summary" directory)
resolved_restore=$(readlink -f "$restore_directory" 2>/dev/null || true)
case "$resolved_restore" in
  "${restore_root}/restore-"*) ;;
  *) v2_die 'Restore output escaped RESTORE_ROOT' ;;
esac
test -d "$resolved_restore/uploads" || v2_die 'Restored uploads directory is missing'
restore_report="$resolved_restore/restore-report.json"
test -f "$restore_report" || v2_die 'Restore report is missing'

/usr/bin/node - "$restore_report" "$backup_directory/manifest.json" "$backup_id" \
  "$target_database" "$manifest_sha256" <<'NODE'
const fs = require('node:fs');
const [reportFile, manifestFile, backupId, targetDatabase, manifestSha256] = process.argv.slice(2);
const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
const failures = [];
if (report.format !== 'task-distribution-v2-restore-report/v1') failures.push('format');
if (report.backupId !== backupId) failures.push('backupId');
if (report.targetDatabase !== targetDatabase) failures.push('targetDatabase');
if (report.manifestSha256 !== manifestSha256) failures.push('manifestSha256');
const expected = new Map((manifest.database?.collections || []).map((entry) => [entry.name, entry.documentCount]));
const actual = new Map((report.reconciliation?.collections || []).map((entry) => [entry.name, entry.documentCount]));
for (const [name, count] of expected) if (actual.get(name) !== count) failures.push(`collection:${name}`);
if (actual.size !== expected.size) failures.push('collectionSet');
const assets = report.reconciliation?.fileAssets;
const expectedAssets = manifest.uploads?.fileAssetReferences?.referenced;
if (!assets || assets.referenced !== assets.verified) failures.push('fileAssetVerification');
if (Number.isInteger(expectedAssets) && assets?.referenced !== expectedAssets) failures.push('fileAssetCount');
if (failures.length) {
  process.stderr.write(`Restore reconciliation mismatch: ${failures.join(', ')}\n`);
  process.exit(1);
}
NODE

/usr/bin/node - "$restore_handoff" "$release_id" "$previous_release" "$backup_id" \
  "$manifest_sha256" "$restore_id" "$target_database" "$resolved_restore" "$restore_report" <<'NODE'
const fs = require('node:fs');
const [file, releaseId, previousRelease, backupId, manifestSha256, restoreId,
  targetDatabase, restoreDirectory, restoreReport] = process.argv.slice(2);
const value = {
  format: 'task-distribution-v2-restore-handoff/v1',
  completedAt: new Date().toISOString(),
  instance: 'task-distribution-v2-customer-test',
  sourceDatabase: 'customer_acceptance_v2_test',
  releaseId,
  previousRelease,
  backupId,
  manifestSha256,
  restoreId,
  targetDatabase,
  restoreDirectory,
  restoredUploadRoot: `${restoreDirectory}/uploads`,
  restoreReport,
  activeStateChanged: false,
  servicesHeldStopped: true
};
fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, {
  encoding: 'utf8', flag: 'wx', mode: 0o640
});
NODE

printf '{"status":"RESTORE_VERIFIED","releaseId":"%s","backupId":"%s","targetDatabase":"%s","restoreId":"%s","handoff":"%s","activeStateChanged":false}\n' \
  "$release_id" "$backup_id" "$target_database" "$restore_id" "$restore_handoff"
