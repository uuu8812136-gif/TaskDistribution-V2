#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=v2-test-release-common.sh
. "$SCRIPT_DIR/v2-test-release-common.sh"

release_id=''
source_release_id=''
operations_env="$V2_OPERATIONS_ENV"
confirm_instance=''
confirm_database=''
confirm_backup_id=''
execute=0

usage() {
  cat <<'EOF'
Resume activation after the guarded customer-repair migrations completed but a code invariant failed.
This workflow verifies sealed source evidence and live state without rerunning any migration.

Dry-run (default):
  resume-v2-test-candidate-activation.sh --release-id <new-id> \
    --source-release-id <failed-id>

Execute:
  resume-v2-test-candidate-activation.sh ... --execute \
    --confirm-instance task-distribution-v2-customer-test \
    --confirm-database customer_acceptance_v2_test \
    --confirm-backup-id <source-backup-id>
EOF
}

while test "$#" -gt 0; do
  case "$1" in
    --release-id) release_id="${2:-}"; shift 2 ;;
    --source-release-id) source_release_id="${2:-}"; shift 2 ;;
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
v2_validate_release_id "$source_release_id"
test "$release_id" != "$source_release_id" || v2_die 'Resume candidate must differ from the failed release'
test "${operations_env#/}" != "$operations_env" && test -f "$operations_env" || \
  v2_die '--operations-env must be an existing absolute file'
v2_assert_protected_environment_file "$operations_env"

candidate=$(v2_release_path "$release_id")
source_candidate=$(v2_release_path "$source_release_id")
source_evidence_dir="${V2_EVIDENCE_ROOT}/${source_release_id}"
evidence_dir="${V2_EVIDENCE_ROOT}/${release_id}"
source_started="$source_evidence_dir/migration-started.json"
source_handoff="$source_evidence_dir/backup-handoff.json"
source_baseline="$source_evidence_dir/transport-references.before.json"

v2_assert_candidate_layout "$candidate"
v2_assert_release_metadata "$candidate" "$release_id" ''
v2_assert_app_environment
v2_assert_legacy_healthy
v2_assert_mongo_primary
v2_assert_stopped_forward_fix_evidence "$source_started"
v2_assert_customer_repair_resume_evidence "$source_release_id"
v2_validate_migration_preview_summary "$source_candidate" "$source_evidence_dir"
test ! -e "$evidence_dir" && test ! -L "$evidence_dir" || \
  v2_die "Resume evidence path already exists: $evidence_dir"

backup_id=$(v2_json_field "$source_handoff" backupId)
backup_directory=$(v2_json_field "$source_handoff" backupDirectory)
manifest_sha256=$(v2_json_field "$source_handoff" manifestSha256)
previous_release=$(v2_json_field "$source_handoff" previousRelease)
expected_transport_snapshot=$(v2_json_field "$source_handoff" transportSnapshotsSha256)
test "$(readlink -f "$V2_CURRENT_LINK" 2>/dev/null || true)" = "$previous_release" || \
  v2_die 'Current release changed after the failed migration activation'
test "$previous_release" != "$candidate" || v2_die 'Resume candidate is already current'

backup_root=$(v2_operations_value "$candidate" "$operations_env" BACKUP_ROOT)
test "$backup_directory" = "${backup_root}/${backup_id}" || \
  v2_die 'Resume backup directory differs from the protected operations configuration'
test -d "$backup_directory" || v2_die 'Resume backup directory is missing'
backup_verification=$(v2_run_operations_node "$candidate/ops/verify-backup.js" \
  --env-file "$operations_env" --backup-id "$backup_id")
test "$(printf '%s\n' "$backup_verification" | /usr/bin/node -e \
  'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).manifestSha256||"")))')" \
  = "$manifest_sha256" || v2_die 'Resume backup verification manifest SHA256 mismatch'

test "$(v2_transport_snapshot_digest)" = "$expected_transport_snapshot" || \
  v2_die 'Historical transport snapshot fields changed after the failed activation'
transport_result=$(v2_verify_transport_release_state "$candidate" "$source_baseline") || \
  v2_die 'Resume transport reference invariants failed'
customer_result=$(v2_verify_customer_repair_state "$candidate" "$source_evidence_dir") || \
  v2_die 'Resume customer repair invariants failed'

runtime_probe=$(mktemp /run/taskdistribution-v2-resume-runtime.XXXXXX)
cleanup_probe() {
  rm -f -- "$runtime_probe"
}
trap cleanup_probe EXIT
v2_write_runtime_baseline "$runtime_probe"
cmp -s "$runtime_probe" "$source_evidence_dir/migration-after.json" || \
  v2_die 'Live database counts changed after the sealed migration evidence was written'

wrong_levels=$(mongosh --quiet --host 127.0.0.1 --port 27150 --eval '
  const d=db.getSiblingDB("customer_acceptance_v2_test");
  print(d.teammemberships.countDocuments({$or:[
    {positionKey:"TEAM_LEADER",positionLevel:{$ne:5}},
    {positionKey:"EMPLOYEE",positionLevel:{$ne:6}}
  ]}));
' 2>/dev/null | tail -n 1)
test "$wrong_levels" = 0 || v2_die 'Position-level migration invariant failed during resume'

if test "$execute" -ne 1; then
  printf '{"status":"DRY_RUN_READY","action":"resume-customer-repair-activation","releaseId":"%s","sourceReleaseId":"%s","backupId":"%s","migrationWrites":0,"transportReferences":%s,"customerRepairs":%s}\n' \
    "$release_id" "$source_release_id" "$backup_id" "$transport_result" "$customer_result"
  exit 0
fi

v2_require_root
v2_require_confirmations "$confirm_instance" "$confirm_database"
test "$confirm_backup_id" = "$backup_id" || \
  v2_die '--confirm-backup-id must equal the sealed source backup id'

trap - EXIT
cleanup_probe
on_failure() {
  status=$?
  trap - EXIT
  systemctl stop "$V2_TUNNEL_UNIT" >/dev/null 2>&1 || true
  systemctl stop "$V2_API_UNIT" >/dev/null 2>&1 || true
  if test "$status" -ne 0; then
    printf 'RESUME_ACTIVATION_FAILED: V2 remains stopped; sealed migration evidence was preserved and no migration was rerun.\n' >&2
  fi
  exit "$status"
}
trap on_failure EXIT

install -d -o root -g root -m 0750 "$V2_EVIDENCE_ROOT"
install -d -o root -g root -m 0750 "$evidence_dir"
printf '%s\n' "$previous_release" > "$evidence_dir/previous-release.txt"
sha256sum "$candidate/deploy/RELEASE.json" > "$evidence_dir/release-json.sha256"
printf '%s\n' "$backup_verification" > "$evidence_dir/backup-verify-resume.json"
printf '%s\n' "$transport_result" > "$evidence_dir/transport-reference-invariants.json"
printf '%s\n' "$customer_result" > "$evidence_dir/customer-repair-invariants.json"
v2_write_runtime_baseline "$evidence_dir/runtime-before-activation.json"
chown root:root "$evidence_dir"/*
chmod 0640 "$evidence_dir"/*

/usr/bin/node - "$evidence_dir/resume-source-evidence.json" "$release_id" \
  "$source_release_id" "$source_evidence_dir" "$backup_id" "$manifest_sha256" <<'NODE'
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const [file, releaseId, sourceReleaseId, sourceEvidenceDir, backupId, manifestSha256] =
  process.argv.slice(2);
const names = [
  'backup-handoff.json',
  'migration-preview.json',
  'migration-started.json',
  'migration-after.json',
  'position-levels-execute.json',
  'transport-master-data-execute.json',
  'equipment-ownership-execute.json',
  'equipment-ownership-idempotent.json',
  'acceptance-july-2026-execute.json',
  'acceptance-july-2026-idempotent.json',
  'transport-references.before.json',
  'customer-repair-invariants.json'
];
const sha256 = name => createHash('sha256')
  .update(fs.readFileSync(path.join(sourceEvidenceDir, name))).digest('hex');
const value = {
  format: 'task-distribution-v2-resume-source-evidence/v1',
  verifiedAt: new Date().toISOString(),
  releaseId,
  sourceReleaseId,
  sourceEvidenceDirectory: sourceEvidenceDir,
  backupId,
  manifestSha256,
  migrationWritesPerformed: 0,
  sourceFiles: names.map(name => ({ file: name, sha256: sha256(name) }))
};
fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, {
  encoding: 'utf8', flag: 'wx', mode: 0o640
});
NODE
chown root:root "$evidence_dir/resume-source-evidence.json"
chmod 0640 "$evidence_dir/resume-source-evidence.json"

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
test "$healthy" -eq 1 || v2_die 'Resume candidate API did not become healthy'

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
  v2_die 'Required transport and production schedule indexes were not created during resume'

systemctl start "$V2_TUNNEL_UNIT"
v2_require_active "$V2_TUNNEL_UNIT"
/usr/bin/env bash "$candidate/ops/linux/verify-v2-test-release.sh" \
  --release-id "$release_id" \
  --migration-evidence-release-id "$source_release_id" \
  --expected-transport-snapshot "$expected_transport_snapshot" \
  --expected-reference-baseline "$source_baseline" > \
  "$evidence_dir/post-activation-verification.json"
chown root:root "$evidence_dir/post-activation-verification.json"
chmod 0640 "$evidence_dir/post-activation-verification.json"

/usr/bin/node - "$evidence_dir/activation-result.json" "$release_id" "$source_release_id" \
  "$previous_release" "$backup_id" "$manifest_sha256" <<'NODE'
const fs = require('node:fs');
const [file, releaseId, sourceReleaseId, previousRelease, backupId, manifestSha256] =
  process.argv.slice(2);
fs.writeFileSync(file, `${JSON.stringify({
  format: 'task-distribution-v2-resume-activation-result/v1',
  activatedAt: new Date().toISOString(),
  status: 'ACTIVATED_AND_VERIFIED',
  releaseId,
  sourceReleaseId,
  previousRelease,
  backupId,
  manifestSha256,
  migrationWritesPerformed: 0
}, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o640 });
NODE
chown root:root "$evidence_dir/activation-result.json"
chmod 0640 "$evidence_dir/activation-result.json"

trap - EXIT
printf '{"status":"ACTIVATED_AND_VERIFIED","releaseId":"%s","sourceReleaseId":"%s","previous":"%s","backupId":"%s","migrationWrites":0}\n' \
  "$release_id" "$source_release_id" "$previous_release" "$backup_id"
