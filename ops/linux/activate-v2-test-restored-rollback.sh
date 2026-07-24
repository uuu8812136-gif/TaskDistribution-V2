#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=v2-test-release-common.sh
. "$SCRIPT_DIR/v2-test-release-common.sh"

release_id=''
restore_handoff=''
replacement_app_env=''
operations_env="$V2_OPERATIONS_ENV"
public_origin='https://v2-test.horselink.cn'
confirm_instance=''
confirm_target_database=''
confirm_previous_release_id=''
confirm_backup_id=''
execute=0

usage() {
  cat <<'EOF'
Activate the pre-release code against a verified restored *_v2_test database and restored uploads.
This is the guarded rollback path after migration has started; it never points old code at the
mutated active database and never deletes or overwrites the active database/uploads.

Dry-run (default):
  activate-v2-test-restored-rollback.sh --release-id <failed-candidate-id> \
    --restore-handoff <absolute.json> --replacement-app-env <absolute-protected-file> \
    [--operations-env <absolute-protected-file>]

Execute:
  activate-v2-test-restored-rollback.sh ... --execute \
    --confirm-instance task-distribution-v2-customer-test \
    --confirm-target-database <restored_name_v2_test> \
    --confirm-previous-release-id <previous-release-id> \
    --confirm-backup-id <backup-id>
EOF
}

while test "$#" -gt 0; do
  case "$1" in
    --release-id) release_id="${2:-}"; shift 2 ;;
    --restore-handoff) restore_handoff="${2:-}"; shift 2 ;;
    --replacement-app-env) replacement_app_env="${2:-}"; shift 2 ;;
    --operations-env) operations_env="${2:-}"; shift 2 ;;
    --public-origin) public_origin="${2:-}"; shift 2 ;;
    --confirm-instance) confirm_instance="${2:-}"; shift 2 ;;
    --confirm-target-database) confirm_target_database="${2:-}"; shift 2 ;;
    --confirm-previous-release-id) confirm_previous_release_id="${2:-}"; shift 2 ;;
    --confirm-backup-id) confirm_backup_id="${2:-}"; shift 2 ;;
    --execute) execute=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) v2_die "Unknown option: $1" ;;
  esac
done

v2_validate_release_id "$release_id"
test "${restore_handoff#/}" != "$restore_handoff" && test -f "$restore_handoff" || \
  v2_die '--restore-handoff must be an existing absolute file'
test "${replacement_app_env#/}" != "$replacement_app_env" && test -f "$replacement_app_env" || \
  v2_die '--replacement-app-env must be an existing absolute protected file'
test "${operations_env#/}" != "$operations_env" && test -f "$operations_env" || \
  v2_die '--operations-env must be an existing absolute protected file'
v2_assert_protected_environment_file "$replacement_app_env"
v2_assert_protected_environment_file "$operations_env"
case "$replacement_app_env" in
  "${V2_CONFIG_ROOT}/rollback-envs/"*) ;;
  *) v2_die "Replacement app environment must be below ${V2_CONFIG_ROOT}/rollback-envs" ;;
esac
case "$public_origin" in
  https://v2-test.horselink.cn) ;;
  *) v2_die 'Public origin must remain the isolated V2 customer-test host' ;;
esac

candidate=$(v2_release_path "$release_id")
v2_assert_candidate_layout "$candidate"
v2_assert_release_metadata "$candidate" "$release_id" ''
v2_assert_legacy_healthy
v2_assert_mongo_primary
v2_require_inactive "$V2_API_UNIT"
v2_require_inactive "$V2_TUNNEL_UNIT"

test "$(v2_json_field "$restore_handoff" format)" = 'task-distribution-v2-restore-handoff/v1' || \
  v2_die 'Restore handoff format mismatch'
test "$(v2_json_field "$restore_handoff" instance)" = "$V2_EXPECTED_INSTANCE" || \
  v2_die 'Restore handoff instance mismatch'
test "$(v2_json_field "$restore_handoff" sourceDatabase)" = "$V2_EXPECTED_DATABASE" || \
  v2_die 'Restore handoff source database mismatch'
test "$(v2_json_field "$restore_handoff" releaseId)" = "$release_id" || \
  v2_die 'Restore handoff release mismatch'
test "$(v2_json_field "$restore_handoff" activeStateChanged)" = false || \
  v2_die 'Restore handoff unexpectedly reports active-state changes'
test "$(v2_json_field "$restore_handoff" servicesHeldStopped)" = true || \
  v2_die 'Restore handoff does not prove that V2 services were held stopped'

backup_id=$(v2_json_field "$restore_handoff" backupId)
manifest_sha256=$(v2_json_field "$restore_handoff" manifestSha256)
target_database=$(v2_json_field "$restore_handoff" targetDatabase)
previous_release=$(v2_json_field "$restore_handoff" previousRelease)
restore_directory=$(v2_json_field "$restore_handoff" restoreDirectory)
restored_upload_root=$(v2_json_field "$restore_handoff" restoredUploadRoot)
restore_report=$(v2_json_field "$restore_handoff" restoreReport)
case "$target_database" in
  ''|*[!A-Za-z0-9_]*|"$V2_EXPECTED_DATABASE") v2_die 'Restore target database is invalid' ;;
  *_v2_test) ;;
  *) v2_die 'Restore target database must end with _v2_test' ;;
esac
v2_assert_release_directory "$previous_release"
previous_release_id=$(basename "$previous_release")
v2_validate_release_id "$previous_release_id"
test -f "$previous_release/app/package.json" || v2_die 'Previous release package.json is missing'
test -f "$previous_release/app/server.js" || v2_die 'Previous release API entrypoint is missing'
test -f "$previous_release/app/frontend/dist/index.html" || v2_die 'Previous release Web build is missing'

resolved_restore=$(readlink -f "$restore_directory" 2>/dev/null || true)
resolved_uploads=$(readlink -f "$restored_upload_root" 2>/dev/null || true)
case "$resolved_restore" in "${V2_RESTORE_ROOT}/restore-"*) ;; *) v2_die 'Restore directory escaped RESTORE_ROOT' ;; esac
test "$resolved_uploads" = "$resolved_restore/uploads" || v2_die 'Restored upload path mismatch'
test -f "$restore_report" && test "$(readlink -f "$restore_report")" = "$resolved_restore/restore-report.json" || \
  v2_die 'Restore report path mismatch'
test "$(v2_json_field "$restore_report" backupId)" = "$backup_id" || v2_die 'Restore report backup mismatch'
test "$(v2_json_field "$restore_report" targetDatabase)" = "$target_database" || \
  v2_die 'Restore report target database mismatch'
test "$(v2_json_field "$restore_report" manifestSha256)" = "$manifest_sha256" || \
  v2_die 'Restore report manifest mismatch'

configured_instance=$(v2_operations_value "$candidate" "$replacement_app_env" APP_INSTANCE)
configured_port=$(v2_operations_value "$candidate" "$replacement_app_env" PORT)
configured_uploads=$(v2_operations_value "$candidate" "$replacement_app_env" UPLOAD_PATH)
configured_node_env=$(v2_operations_value "$candidate" "$replacement_app_env" NODE_ENV)
test "$configured_instance" = "$V2_EXPECTED_INSTANCE" || v2_die 'Replacement APP_INSTANCE mismatch'
test "$configured_port" = "$V2_EXPECTED_API_PORT" || v2_die 'Replacement PORT mismatch'
test "$configured_uploads" = "$resolved_uploads" || v2_die 'Replacement UPLOAD_PATH is not the restored uploads path'
test "$configured_node_env" = production || v2_die 'Replacement NODE_ENV must be production'

/usr/bin/node - "$candidate/ops/lib/operationsConfig.js" "$replacement_app_env" \
  "$target_database" "$V2_EXPECTED_MONGO_PORT" "$V2_EXPECTED_REPLICA_SET" <<'NODE'
const fs = require('node:fs');
const [modulePath, envFile, targetDatabase, mongoPort, replicaSet] = process.argv.slice(2);
const { parseEnvText } = require(modulePath);
const values = parseEnvText(fs.readFileSync(envFile, 'utf8'));
const uri = new URL(values.MONGODB_URI || '');
const failures = [];
if (uri.protocol !== 'mongodb:') failures.push('protocol');
if (uri.hostname !== '127.0.0.1') failures.push('host');
if (uri.port !== mongoPort) failures.push('port');
if (decodeURIComponent(uri.pathname.replace(/^\//, '')) !== targetDatabase) failures.push('database');
if (uri.searchParams.get('replicaSet') !== replicaSet) failures.push('replicaSet');
if (failures.length) throw new Error(`Replacement MONGODB_URI mismatch: ${failures.join(', ')}`);
NODE

current_release=$(readlink -f "$V2_CURRENT_LINK" 2>/dev/null || true)
if test "$current_release" != "$candidate" && test "$current_release" != "$previous_release"; then
  v2_die 'Current release is neither the failed candidate nor the pre-release version'
fi

if test "$execute" -ne 1; then
  printf '{"status":"DRY_RUN_READY","action":"activate-restored-rollback","failedReleaseId":"%s","previousReleaseId":"%s","backupId":"%s","targetDatabase":"%s","restoredUploadRoot":"%s"}\n' \
    "$release_id" "$previous_release_id" "$backup_id" "$target_database" "$resolved_uploads"
  exit 0
fi

v2_require_root
v2_require_confirmations "$confirm_instance" ''
test "$confirm_target_database" = "$target_database" || \
  v2_die '--confirm-target-database must exactly equal the restored database'
test "$confirm_previous_release_id" = "$previous_release_id" || \
  v2_die '--confirm-previous-release-id must exactly equal the pre-release id'
test "$confirm_backup_id" = "$backup_id" || \
  v2_die '--confirm-backup-id must equal the restored backup id'

backup_root=$(v2_operations_value "$candidate" "$operations_env" BACKUP_ROOT)
backup_directory="${backup_root}/${backup_id}"
test "$backup_root" = '/mnt/taskdistribution-v2-test-backup/backups' || \
  v2_die 'Operations backup root is not the isolated V2 backup mount'
test -d "$backup_directory" || v2_die 'On-host backup directory is missing'

evidence_dir="${V2_EVIDENCE_ROOT}/${release_id}/rollback-${target_database}"
test ! -e "$evidence_dir" && test ! -L "$evidence_dir" || v2_die 'Rollback evidence directory already exists'
install -d -o root -g root -m 0750 "$evidence_dir"
verify_result="$evidence_dir/backup-verify.json"
v2_run_operations_node "$candidate/ops/verify-backup.js" \
  --env-file "$operations_env" --backup-id "$backup_id" > "$verify_result"
test "$(v2_json_field "$verify_result" manifestSha256)" = "$manifest_sha256" || \
  v2_die 'Rollback backup verification mismatch'

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
environment_backup="${V2_CONFIG_ROOT}/rollback-envs/app.env.before-${release_id}-${timestamp}"
temporary_environment="${V2_CONFIG_ROOT}/.app.env.rollback-${target_database}-$$"
test ! -e "$environment_backup" && test ! -L "$environment_backup" || \
  v2_die 'Protected pre-rollback environment backup already exists'
test ! -e "$temporary_environment" && test ! -L "$temporary_environment" || \
  v2_die 'Temporary replacement environment already exists'
install -o root -g root -m 0600 "$V2_APP_ENV" "$environment_backup"
sha256sum "$V2_APP_ENV" > "$evidence_dir/app-env-before.sha256"
sha256sum "$replacement_app_env" > "$evidence_dir/app-env-replacement.sha256"
printf '%s\n' "$environment_backup" > "$evidence_dir/protected-environment-backup-path.txt"

state_switched=0
temporary_link=''
cleanup_on_failure() {
  status=$?
  trap - EXIT
  rm -f "$temporary_environment" >/dev/null 2>&1 || true
  if test -n "$temporary_link"; then rm -f "$temporary_link" >/dev/null 2>&1 || true; fi
  if test "$status" -ne 0; then
    systemctl stop "$V2_TUNNEL_UNIT" >/dev/null 2>&1 || true
    systemctl stop "$V2_API_UNIT" >/dev/null 2>&1 || true
    if test "$state_switched" -eq 1; then
      printf 'ROLLBACK_ACTIVATION_FAILED: V2 remains stopped with the restored rollback state selected; do not reconnect the active database.\n' >&2
    fi
  fi
  exit "$status"
}
trap cleanup_on_failure EXIT

install -o root -g taskdistributionv2test -m 0640 "$replacement_app_env" "$temporary_environment"
mv -Tf "$temporary_environment" "$V2_APP_ENV"
state_switched=1
temporary_link="${V2_RELEASE_ROOT}/current.rollback.${previous_release_id}.$$"
test ! -e "$temporary_link" && test ! -L "$temporary_link" || v2_die 'Temporary rollback link already exists'
ln -s "$previous_release" "$temporary_link"
mv -Tf "$temporary_link" "$V2_CURRENT_LINK"
temporary_link=''

systemctl start "$V2_API_UNIT"
healthy=0
for _ in $(seq 1 45); do
  if curl --fail --silent --show-error --max-time 5 http://127.0.0.1:18120/health >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 1
done
test "$healthy" -eq 1 || v2_die 'Restored rollback API did not become healthy'

systemctl start "$V2_TUNNEL_UNIT"
v2_require_active "$V2_TUNNEL_UNIT"
v2_assert_legacy_healthy
curl --fail --silent --show-error --max-time 15 "$public_origin/health" >/dev/null
curl --fail --silent --show-error --max-time 15 "$public_origin/api/auth/login-teams" >/dev/null

/usr/bin/node - "$evidence_dir/rollback-activation-result.json" "$release_id" \
  "$previous_release_id" "$backup_id" "$manifest_sha256" "$target_database" \
  "$resolved_uploads" "$environment_backup" <<'NODE'
const fs = require('node:fs');
const [file, failedReleaseId, previousReleaseId, backupId, manifestSha256,
  targetDatabase, restoredUploadRoot, protectedEnvironmentBackup] = process.argv.slice(2);
fs.writeFileSync(file, `${JSON.stringify({
  format: 'task-distribution-v2-restored-rollback-activation/v1',
  activatedAt: new Date().toISOString(),
  status: 'RESTORED_ROLLBACK_ACTIVATED',
  failedReleaseId,
  previousReleaseId,
  backupId,
  manifestSha256,
  targetDatabase,
  restoredUploadRoot,
  protectedEnvironmentBackup,
  originalDatabasePreserved: true,
  originalUploadsPreserved: true
}, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o640 });
NODE

trap - EXIT
printf '{"status":"RESTORED_ROLLBACK_ACTIVATED","failedReleaseId":"%s","previousReleaseId":"%s","backupId":"%s","targetDatabase":"%s","originalStatePreserved":true}\n' \
  "$release_id" "$previous_release_id" "$backup_id" "$target_database"
