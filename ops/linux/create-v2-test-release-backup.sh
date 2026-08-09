#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=v2-test-release-common.sh
. "$SCRIPT_DIR/v2-test-release-common.sh"

release_id=''
operations_env="$V2_OPERATIONS_ENV"
confirm_instance=''
confirm_database=''
forward_fix_migration_started=''
execute=0

usage() {
  cat <<'EOF'
Stop only the isolated V2 API/tunnel, create a fresh verified backup, and leave V2 stopped.
The next phase is blocked until the backup is copied to a physical-host disk
that is separate from the Linux VM storage disk and verified there.

Dry-run (default):
  create-v2-test-release-backup.sh --release-id <id> [--operations-env <absolute-file>] \
    [--forward-fix-migration-started <absolute migration-started.json>]

Execute:
  create-v2-test-release-backup.sh ... --execute \
    --confirm-instance task-distribution-v2-customer-test \
    --confirm-database customer_acceptance_v2_test
EOF
}

while test "$#" -gt 0; do
  case "$1" in
    --release-id) release_id="${2:-}"; shift 2 ;;
    --operations-env) operations_env="${2:-}"; shift 2 ;;
    --confirm-instance) confirm_instance="${2:-}"; shift 2 ;;
    --confirm-database) confirm_database="${2:-}"; shift 2 ;;
    --forward-fix-migration-started) forward_fix_migration_started="${2:-}"; shift 2 ;;
    --execute) execute=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) v2_die "Unknown option: $1" ;;
  esac
done

v2_validate_release_id "$release_id"
test "${operations_env#/}" != "$operations_env" || v2_die '--operations-env must be absolute'
v2_assert_protected_environment_file "$operations_env"
candidate=$(v2_release_path "$release_id")
v2_assert_candidate_layout "$candidate"
v2_assert_release_metadata "$candidate" "$release_id" ''
v2_assert_app_environment
v2_assert_legacy_healthy
v2_assert_mongo_primary
if test -z "$forward_fix_migration_started"; then
  v2_require_active "$V2_API_UNIT"
  v2_require_active "$V2_TUNNEL_UNIT"
else
  v2_assert_stopped_forward_fix_evidence "$forward_fix_migration_started"
fi

current_before=$(readlink -f "$V2_CURRENT_LINK" 2>/dev/null || true)
test -d "$current_before" || v2_die 'Current V2 release cannot be resolved'
test "$current_before" != "$candidate" || v2_die 'Candidate is already current; backup phase must precede activation'

backup_volume=$(v2_operations_value "$candidate" "$operations_env" BACKUP_VOLUME_ROOT)
backup_root=$(v2_operations_value "$candidate" "$operations_env" BACKUP_ROOT)
upload_root=$(v2_operations_value "$candidate" "$operations_env" UPLOAD_PATH)
allow_remote=$(v2_operations_value "$candidate" "$operations_env" BACKUP_ALLOW_REMOTE)
test "$backup_volume" = '/mnt/taskdistribution-v2-test-backup' || \
  v2_die 'BACKUP_VOLUME_ROOT must be /mnt/taskdistribution-v2-test-backup'
test "$backup_root" = "${backup_volume}/backups" || \
  v2_die 'BACKUP_ROOT must be the backups directory below the dedicated V2 backup mount'
test "$upload_root" = "$V2_UPLOAD_ROOT" || v2_die 'Operations UPLOAD_PATH is not the isolated V2 path'
v2_assert_mongo_environment_file "$operations_env" 'Operations MONGODB_URI'
test "$allow_remote" = false || v2_die 'BACKUP_ALLOW_REMOTE must remain false'
mountpoint -q "$backup_volume" || v2_die 'The dedicated V2 backup volume is not mounted'
test "$(stat -c '%d' "$backup_volume")" != "$(stat -c '%d' /)" || \
  v2_die 'The V2 backup volume is on the root filesystem'

evidence_dir="${V2_EVIDENCE_ROOT}/${release_id}"
test ! -e "$evidence_dir" && test ! -L "$evidence_dir" || \
  v2_die "Release evidence path already exists: $evidence_dir"

if test "$execute" -ne 1; then
  printf '{"status":"DRY_RUN_READY","action":"stop-and-backup","releaseId":"%s","previous":"%s","backupRoot":"%s"}\n' \
    "$release_id" "$current_before" "$backup_root"
  exit 0
fi

v2_require_root
v2_require_confirmations "$confirm_instance" "$confirm_database"

stopped=0
hold_stopped=0
if test -n "$forward_fix_migration_started"; then
  hold_stopped=1
fi
recover_before_migration() {
  status=$?
  trap - EXIT
  if test "$status" -ne 0 && test "$stopped" -eq 1 && test "$hold_stopped" -eq 0; then
    systemctl start "$V2_API_UNIT" || true
    systemctl start "$V2_TUNNEL_UNIT" || true
  fi
  exit "$status"
}
trap recover_before_migration EXIT

install -d -o root -g root -m 0750 "$V2_EVIDENCE_ROOT"
install -d -o root -g root -m 0750 "$evidence_dir"
printf '%s\n' "$current_before" > "$evidence_dir/previous-release.txt"
sha256sum "$candidate/deploy/RELEASE.json" > "$evidence_dir/release-json.sha256"

systemctl stop "$V2_TUNNEL_UNIT"
systemctl stop "$V2_API_UNIT"
stopped=1
v2_require_inactive "$V2_TUNNEL_UNIT"
v2_require_inactive "$V2_API_UNIT"
v2_assert_legacy_healthy
v2_assert_mongo_primary

v2_migration_input_digest > "$evidence_dir/migration-input.before.sha256"
v2_transport_snapshot_digest > "$evidence_dir/transport-snapshots.before.sha256"
v2_write_transport_reference_baseline "$evidence_dir/transport-references.before.json"
v2_write_runtime_baseline "$evidence_dir/runtime-before.json"

backup_result="$evidence_dir/backup-result.json"
backup_verify_result="$evidence_dir/backup-verify-result.json"
v2_run_operations_node "$candidate/ops/backup.js" \
  --env-file "$operations_env" > "$backup_result"

backup_id=$(v2_json_field "$backup_result" backupId)
backup_directory=$(v2_json_field "$backup_result" directory)
manifest_sha256=$(v2_json_field "$backup_result" manifestSha256)
backup_database=$(v2_json_field "$backup_result" database)
test "$backup_database" = "$V2_EXPECTED_DATABASE" || v2_die 'Backup result database mismatch'
test "$backup_directory" = "${backup_root}/${backup_id}" || v2_die 'Backup result directory mismatch'

v2_run_operations_node "$candidate/ops/verify-backup.js" \
  --env-file "$operations_env" --backup-id "$backup_id" > "$backup_verify_result"
test "$(v2_json_field "$backup_verify_result" manifestSha256)" = "$manifest_sha256" || \
  v2_die 'Backup verification manifest SHA256 mismatch'

/usr/bin/node - "$backup_directory/manifest.json" "$V2_EXPECTED_DATABASE" <<'NODE'
const fs = require('node:fs');
const [file, database] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
const collections = new Set((manifest.database?.collections || []).map(({ name }) => name));
const files = new Set((manifest.files || []).map(({ file: name }) => name));
const required = [
  'projectteams',
  'orgunits',
  'users',
  'teammemberships',
  'transportrecords',
  'equipmentassets',
  'equipmentroutineplans',
  'authsessions',
  'productionschedules',
  'attendancesubmissions',
  'attendancedailyreviews',
  'generateddailyreports'
];
const missing = required.filter((name) => (
  !collections.has(name) || !files.has(`database/${database}/${name}.bson`)
));
if (manifest.database?.name !== database || missing.length) {
  process.stderr.write(`Backup migration evidence missing: ${missing.join(', ')}\n`);
  process.exit(1);
}
NODE

setfacl -m u:serveradmin:--x "$backup_volume" "$backup_root"
setfacl -R -m u:serveradmin:rX "$backup_directory"

handoff="$evidence_dir/backup-handoff.json"
/usr/bin/node - "$handoff" "$release_id" "$current_before" "$backup_id" \
  "$backup_directory" "$manifest_sha256" \
  "$(cat "$evidence_dir/migration-input.before.sha256")" \
  "$(cat "$evidence_dir/transport-snapshots.before.sha256")" \
  "$(sha256sum "$evidence_dir/transport-references.before.json" | awk '{print $1}')" <<'NODE'
const fs = require('node:fs');
const [file, releaseId, previousRelease, backupId, backupDirectory, manifestSha256,
  migrationInputSha256, transportSnapshotsSha256, transportReferenceBaselineSha256] = process.argv.slice(2);
const value = {
  format: 'task-distribution-v2-release-backup-handoff/v1',
  createdAt: new Date().toISOString(),
  instance: 'task-distribution-v2-customer-test',
  database: 'customer_acceptance_v2_test',
  releaseId,
  previousRelease,
  backupId,
  backupDirectory,
  manifestSha256,
  migrationInputSha256,
  transportSnapshotsSha256,
  transportReferenceBaselineSha256,
  servicesHeldStopped: true
};
fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o640 });
NODE
chown root:root "$handoff"
chmod 0640 "$handoff"

hold_stopped=1
trap - EXIT
printf '{"status":"BACKUP_HANDOFF_READY","releaseId":"%s","backupId":"%s","manifestSha256":"%s","handoff":"%s","v2Services":"stopped"}\n' \
  "$release_id" "$backup_id" "$manifest_sha256" "$handoff"
