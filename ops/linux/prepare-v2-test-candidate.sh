#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=v2-test-release-common.sh
. "$SCRIPT_DIR/v2-test-release-common.sh"

archive=''
archive_sha256=''
release_id=''
source_commit=''
confirm_instance=''
forward_fix_migration_started=''
execute=0

usage() {
  cat <<'EOF'
Prepare an immutable V2 customer-test candidate without switching current or restarting services.

Dry-run (default):
  prepare-v2-test-candidate.sh --archive <absolute.tar.gz> --archive-sha256 <sha256> \
    --release-id <id> --source-commit <40-hex-commit> \
    [--forward-fix-migration-started <absolute migration-started.json>]

Execute:
  prepare-v2-test-candidate.sh ... --execute \
    --confirm-instance task-distribution-v2-customer-test
EOF
}

while test "$#" -gt 0; do
  case "$1" in
    --archive) archive="${2:-}"; shift 2 ;;
    --archive-sha256) archive_sha256="${2:-}"; shift 2 ;;
    --release-id) release_id="${2:-}"; shift 2 ;;
    --source-commit) source_commit="${2:-}"; shift 2 ;;
    --forward-fix-migration-started) forward_fix_migration_started="${2:-}"; shift 2 ;;
    --confirm-instance) confirm_instance="${2:-}"; shift 2 ;;
    --execute) execute=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) v2_die "Unknown option: $1" ;;
  esac
done

test -n "$archive" && test "${archive#/}" != "$archive" || v2_die '--archive must be absolute'
test -f "$archive" || v2_die "Archive not found: $archive"
test "$archive_sha256" != '' && test "${#archive_sha256}" -eq 64 || v2_die 'A SHA256 is required'
case "$archive_sha256" in *[!a-fA-F0-9]*) v2_die 'Archive SHA256 is invalid' ;; esac
case "$source_commit" in *[!a-f0-9]*|'') v2_die 'Source commit must be lowercase 40-hex' ;; esac
test "${#source_commit}" -eq 40 || v2_die 'Source commit must be lowercase 40-hex'
v2_validate_release_id "$release_id"

candidate=$(v2_release_path "$release_id")
actual_sha256=$(sha256sum "$archive" | awk '{print $1}')
test "$actual_sha256" = "${archive_sha256,,}" || v2_die 'Candidate archive SHA256 mismatch'
test ! -e "$candidate" && test ! -L "$candidate" || v2_die "Release already exists: $candidate"

v2_assert_legacy_healthy
v2_assert_mongo_primary
v2_assert_app_environment
if test -z "$forward_fix_migration_started"; then
  v2_require_active "$V2_API_UNIT"
  v2_require_active "$V2_TUNNEL_UNIT"
else
  test "${forward_fix_migration_started#/}" != "$forward_fix_migration_started" || \
    v2_die '--forward-fix-migration-started must be absolute'
  test -f "$forward_fix_migration_started" && test ! -L "$forward_fix_migration_started" || \
    v2_die 'Forward-fix migration-started evidence must be a real file'
  forward_fix_migration_started=$(readlink -f "$forward_fix_migration_started")
  forward_fix_evidence_dir=$(dirname -- "$forward_fix_migration_started")
  case "$forward_fix_migration_started" in
    "${V2_EVIDENCE_ROOT}/"*/migration-started.json) ;;
    *) v2_die 'Forward-fix evidence escaped the V2 release evidence root' ;;
  esac
  test "$(stat -c '%U:%G' "$forward_fix_evidence_dir")" = root:root || \
    v2_die 'Forward-fix evidence directory must be root-owned'
  test -f "$forward_fix_evidence_dir/migration-preview.json" && \
    test ! -L "$forward_fix_evidence_dir/migration-preview.json" || \
    v2_die 'Forward-fix migration preview evidence is missing'
  v2_require_inactive "$V2_API_UNIT"
  v2_require_inactive "$V2_TUNNEL_UNIT"
  /usr/bin/node - "$forward_fix_migration_started" "$forward_fix_evidence_dir/migration-preview.json" <<'NODE'
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const [startedPath, previewPath] = process.argv.slice(2);
const started = JSON.parse(fs.readFileSync(startedPath, 'utf8'));
const expectedReleaseId = path.basename(path.dirname(startedPath));
const previewSha256 = createHash('sha256').update(fs.readFileSync(previewPath)).digest('hex');
if (
  started.format !== 'task-distribution-v2-migration-started/v1' ||
  started.releaseId !== expectedReleaseId ||
  !/^backup-\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(started.backupId || '') ||
  !/^[a-f0-9]{64}$/.test(started.migrationPreviewSha256 || '') ||
  started.migrationPreviewSha256 !== previewSha256 ||
  started.codeOnlyRollbackAllowed !== false
) throw new Error('Forward-fix migration-started evidence is invalid');
NODE
fi

if test "$execute" -ne 1; then
  printf '{"status":"DRY_RUN_READY","action":"prepare-candidate","releaseId":"%s","candidate":"%s","archiveSha256":"%s"}\n' \
    "$release_id" "$candidate" "$actual_sha256"
  exit 0
fi

v2_require_root
v2_require_confirmations "$confirm_instance" ''
v2_require_command tar
v2_require_command npm

temporary="${V2_RELEASES_DIR}/.candidate-${release_id}-$$"
case "$temporary" in
  "${V2_RELEASES_DIR}/.candidate-${release_id}-"*) ;;
  *) v2_die 'Temporary candidate path escaped the release directory' ;;
esac
test ! -e "$temporary" && test ! -L "$temporary" || v2_die "Temporary path already exists: $temporary"
cleanup() {
  status=$?
  trap - EXIT
  if test "$status" -ne 0 && test -d "$temporary"; then
    case "$temporary" in
      "${V2_RELEASES_DIR}/.candidate-${release_id}-"*) ;;
      *) v2_die 'Refusing to clean an unexpected temporary path' ;;
    esac
    rm -rf --one-file-system "$temporary"
  fi
  exit "$status"
}
trap cleanup EXIT

install -d -o root -g root -m 0755 "$V2_RELEASES_DIR"
install -d -o taskdistributionv2test -g taskdistributionv2test -m 0755 "$temporary"
/usr/bin/node - "$archive" <<'NODE'
const { spawnSync } = require('node:child_process');
const archive = process.argv[2];
const listed = spawnSync('/usr/bin/tar', ['-tzf', archive], { encoding: 'utf8' });
if (listed.status !== 0) throw new Error(`Unable to list candidate archive: ${listed.stderr}`);
const members = listed.stdout.split(/\r?\n/).filter(Boolean);
if (!members.length) throw new Error('Candidate archive is empty');
for (const raw of members) {
  if (raw === './') continue;
  const value = raw.replace(/^\.\//, '');
  const segments = value.split('/').filter(Boolean);
  if (!value || value.startsWith('/') || value.startsWith('\\') ||
      /^[A-Za-z]:/.test(value) || segments.includes('..')) {
    throw new Error(`Unsafe candidate archive member: ${raw}`);
  }
}
const detailed = spawnSync('/usr/bin/tar', ['-tvzf', archive], { encoding: 'utf8' });
if (detailed.status !== 0) throw new Error(`Unable to inspect candidate archive types: ${detailed.stderr}`);
for (const line of detailed.stdout.split(/\r?\n/).filter(Boolean)) {
  if (!['-', 'd'].includes(line[0])) throw new Error('Candidate archive contains a link or special file');
}
NODE
tar -xzf "$archive" -C "$temporary" --no-same-owner --no-same-permissions
v2_assert_candidate_layout "$temporary"
v2_assert_no_forbidden_release_files "$temporary"
v2_assert_release_metadata "$temporary" "$release_id" "$source_commit"
v2_verify_release_file_manifest "$temporary" "$release_id" "$source_commit"

chown -R taskdistributionv2test:taskdistributionv2test "$temporary"
sudo -u taskdistributionv2test /usr/bin/env -i \
  HOME="${V2_STATE_ROOT}/taskdistribution-v2" \
  PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' \
  NODE_ENV=production \
  npm_config_cache="${V2_STATE_ROOT}/npm-cache" \
  /usr/bin/npm --prefix "$temporary/app" ci --omit=dev --no-audit --no-fund
/usr/bin/node --check "$temporary/deploy/linux/staging-server.cjs"
/usr/bin/node --check "$temporary/app/script/migratePositionLevels.js"
/usr/bin/node --check "$temporary/app/script/backfillTransportMasterData.js"
/usr/bin/node --check "$temporary/app/script/backfillCustomerEquipmentOwnership.js"
/usr/bin/node --check "$temporary/app/services/equipmentOwnershipBackfillService.js"
/usr/bin/node --check "$temporary/app/script/repairAcceptanceJuly2026Data.js"
/usr/bin/node --check "$temporary/app/services/acceptanceJuly2026DataRepairService.js"
/usr/bin/node --check "$temporary/ops/lib/customerRepairReleaseInvariant.js"
/usr/bin/node --check "$temporary/ops/lib/v2MigrationPreviewInvariant.js"

chown -R root:root "$temporary"
find "$temporary" -type d -exec chmod 0755 {} +
find "$temporary" -type f -exec chmod 0644 {} +
mv -T "$temporary" "$candidate"
trap - EXIT

printf '{"status":"CANDIDATE_READY","releaseId":"%s","candidate":"%s","archiveSha256":"%s","sourceCommit":"%s"}\n' \
  "$release_id" "$candidate" "$actual_sha256" "$source_commit"
