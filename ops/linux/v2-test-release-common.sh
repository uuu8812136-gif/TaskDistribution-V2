#!/usr/bin/env bash

# Shared guards for the isolated V2 customer-test release scripts.

readonly V2_EXPECTED_INSTANCE='task-distribution-v2-customer-test'
readonly V2_EXPECTED_DATABASE='customer_acceptance_v2_test'
readonly V2_EXPECTED_API_PORT='18120'
readonly V2_EXPECTED_INNER_WEB_PORT='18130'
readonly V2_EXPECTED_MONGO_PORT='27150'
readonly V2_EXPECTED_TUNNEL_PORT='38130'
readonly V2_EXPECTED_REPLICA_SET='customer_acceptance_v2_rs'
readonly LEGACY_EXPECTED_API_PORT='8099'
readonly LEGACY_EXPECTED_TUNNEL_PORT='38080'
readonly LEGACY_PUBLIC_ORIGIN='https://www.horselink.cn'
readonly V2_RELEASE_COMMON_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly V2_MONGO_TARGET_GUARD="${V2_RELEASE_COMMON_DIR}/../lib/v2TestMongoTargetGuard.js"
readonly V2_RELEASE_ROOT='/opt/taskdistribution-v2-test'
readonly V2_RELEASES_DIR="${V2_RELEASE_ROOT}/releases"
readonly V2_CURRENT_LINK="${V2_RELEASE_ROOT}/current"
readonly V2_STATE_ROOT='/srv/taskdistribution-v2-test'
readonly V2_UPLOAD_ROOT="${V2_STATE_ROOT}/taskdistribution-v2/uploads"
readonly V2_CONFIG_ROOT='/etc/taskdistribution-v2-test'
readonly V2_APP_ENV="${V2_CONFIG_ROOT}/app.env"
readonly V2_OPERATIONS_ENV="${V2_CONFIG_ROOT}/operations.env"
readonly V2_EVIDENCE_ROOT='/var/log/taskdistribution-v2-test/releases'
readonly V2_RESTORE_ROOT="${V2_STATE_ROOT}/restore-drills"
readonly V2_API_UNIT='taskdistribution-v2-test-api.service'
readonly V2_TUNNEL_UNIT='taskdistribution-v2-test-tunnel.service'
readonly V2_MONGO_UNIT='mongod-v2-test.service'
readonly LEGACY_API_UNIT='task-distribution.service'
readonly LEGACY_MONGO_UNIT='mongod.service'
readonly NGINX_UNIT='nginx.service'

v2_die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

v2_note() {
  printf '%s\n' "$*"
}

v2_require_root() {
  test "$(id -u)" -eq 0 || v2_die 'Run this script as root'
}

v2_require_command() {
  command -v "$1" >/dev/null 2>&1 || v2_die "Required command not found: $1"
}

v2_assert_protected_environment_file() {
  local file="$1"
  test -f "$file" || v2_die "Protected environment file is missing: $file"
  test ! -L "$file" || v2_die "Protected environment file must not be a symbolic link: $file"
  test "$(stat -c '%U' "$file")" = root || v2_die "Protected environment file must be owned by root: $file"
  case "$(stat -c '%a' "$file")" in
    600|640) ;;
    *) v2_die "Protected environment file mode must be 0600 or 0640: $file" ;;
  esac
}

v2_run_operations_node() {
  sudo -u taskdistributionv2test /usr/bin/env -i \
    HOME="${V2_STATE_ROOT}/taskdistribution-v2" \
    PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' \
    NODE_ENV=production \
    /usr/bin/node "$@"
}

v2_run_app_node() {
  local environment_file="$1"
  shift
  sudo -u taskdistributionv2test /usr/bin/env -i \
    HOME="${V2_STATE_ROOT}/taskdistribution-v2" \
    PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' \
    NODE_ENV=production \
    ENV_FILE="$environment_file" \
    /usr/bin/node "$@"
}

v2_run_app_node_sealed_report() {
  local environment_file="$1"
  local script="$2"
  local destination="$3"
  shift 3
  local argument destination_parent staging_root staging report status

  v2_require_root
  for argument in "$@"; do
    case "$argument" in
      --report|--report=*) v2_die 'Sealed report helper owns the --report argument' ;;
    esac
  done
  case "$destination" in
    "${V2_EVIDENCE_ROOT}/"*.json) ;;
    *) v2_die 'Sealed report destination is outside the V2 release evidence root' ;;
  esac
  destination_parent=$(readlink -f "$(dirname -- "$destination")" 2>/dev/null || true)
  case "$destination_parent" in
    "${V2_EVIDENCE_ROOT}/"*) ;;
    *) v2_die 'Sealed report parent escaped the V2 release evidence root' ;;
  esac
  test -d "$destination_parent" && test ! -L "$(dirname -- "$destination")" || \
    v2_die 'Sealed report parent must be a real directory'
  test "$(stat -c '%U:%G' "$destination_parent")" = root:root || \
    v2_die 'Release evidence directory must be owned by root before writing sealed reports'
  test ! -e "$destination" && test ! -L "$destination" || \
    v2_die "Sealed report destination already exists: $destination"

  staging_root="${V2_STATE_ROOT}/release-report-staging"
  install -d -o root -g root -m 0711 "$staging_root"
  staging=$(mktemp -d "${staging_root}/report.XXXXXXXX")
  case "$staging" in
    "${staging_root}/report."*) ;;
    *) v2_die 'Migration report staging path escaped its protected root' ;;
  esac
  chown taskdistributionv2test:taskdistributionv2test "$staging"
  chmod 0700 "$staging"
  report="$staging/report.json"

  if v2_run_app_node "$environment_file" "$script" "$@" --report "$report"; then
    status=0
  else
    status=$?
  fi
  if test -f "$report" && test ! -L "$report" && test "$(stat -c '%h' "$report")" = 1; then
    chown root:root "$report"
    chmod 0640 "$report"
    mv -T "$report" "$destination"
  elif test "$status" -eq 0; then
    status=1
    printf 'Migration command succeeded without a sealable report: %s\n' "$script" >&2
  fi
  case "$staging" in
    "${staging_root}/report."*) rm -rf --one-file-system "$staging" ;;
    *) v2_die 'Refusing to clean an unexpected migration report staging path' ;;
  esac
  return "$status"
}

v2_validate_release_id() {
  case "${1:-}" in
    ''|*[!A-Za-z0-9._-]*|.*|-*) v2_die 'Invalid release id' ;;
  esac
  test "${#1}" -ge 6 && test "${#1}" -le 96 || v2_die 'Release id length is invalid'
}

v2_require_confirmations() {
  local instance_confirmation="${1:-}"
  local database_confirmation="${2:-}"
  test "$instance_confirmation" = "$V2_EXPECTED_INSTANCE" || \
    v2_die "--confirm-instance must equal ${V2_EXPECTED_INSTANCE}"
  if test -n "$database_confirmation"; then
    test "$database_confirmation" = "$V2_EXPECTED_DATABASE" || \
      v2_die "--confirm-database must equal ${V2_EXPECTED_DATABASE}"
  fi
}

v2_require_active() {
  local unit="$1"
  test "$(systemctl is-active "$unit" 2>/dev/null || true)" = active || \
    v2_die "Required service is not active: $unit"
}

v2_require_inactive() {
  local unit="$1"
  test "$(systemctl is-active "$unit" 2>/dev/null || true)" != active || \
    v2_die "Service must be stopped: $unit"
}

v2_assert_stopped_forward_fix_evidence() {
  local started_path="$1"
  local evidence_dir preview_path
  test "${started_path#/}" != "$started_path" || \
    v2_die 'Forward-fix migration-started evidence must be absolute'
  test -f "$started_path" && test ! -L "$started_path" || \
    v2_die 'Forward-fix migration-started evidence must be a real file'
  started_path=$(readlink -f "$started_path")
  evidence_dir=$(dirname -- "$started_path")
  case "$started_path" in
    "${V2_EVIDENCE_ROOT}/"*/migration-started.json) ;;
    *) v2_die 'Forward-fix evidence escaped the V2 release evidence root' ;;
  esac
  test "$(stat -c '%U:%G:%a' "$evidence_dir")" = root:root:750 || \
    v2_die 'Forward-fix evidence directory must be sealed and root-owned'
  test "$(stat -c '%U:%G:%a' "$started_path")" = root:root:640 || \
    v2_die 'Forward-fix migration-started evidence must be sealed and root-owned'
  preview_path="$evidence_dir/migration-preview.json"
  test -f "$preview_path" && test ! -L "$preview_path" || \
    v2_die 'Forward-fix migration preview evidence is missing'
  test "$(stat -c '%U:%G:%a' "$preview_path")" = root:root:640 || \
    v2_die 'Forward-fix migration preview evidence must be sealed and root-owned'
  v2_require_inactive "$V2_API_UNIT"
  v2_require_inactive "$V2_TUNNEL_UNIT"
  /usr/bin/node - "$started_path" "$preview_path" <<'NODE'
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
}

v2_assert_customer_repair_resume_evidence() {
  local source_release_id="$1"
  local evidence_dir="${V2_EVIDENCE_ROOT}/${source_release_id}"
  local source_candidate
  local required
  local mode

  v2_validate_release_id "$source_release_id"
  source_candidate=$(v2_release_path "$source_release_id")
  test -d "$source_candidate" && test ! -L "$source_candidate" || \
    v2_die 'Customer repair source candidate is missing or is a symbolic link'
  v2_assert_release_metadata "$source_candidate" "$source_release_id" ''
  test -d "$evidence_dir" && test ! -L "$evidence_dir" || \
    v2_die 'Customer repair source evidence directory is missing or is a symbolic link'
  test "$(stat -c '%U:%G:%a' "$evidence_dir")" = root:root:750 || \
    v2_die 'Customer repair source evidence directory must be sealed and root-owned'
  test ! -e "$evidence_dir/activation-result.json" && \
    test ! -L "$evidence_dir/activation-result.json" || \
    v2_die 'Customer repair source release already has activation evidence'

  for required in \
    backup-handoff.json migration-preview.json migration-started.json migration-after.json \
    position-levels-dry-run.json position-levels-execute.json \
    transport-master-data-dry-run.json transport-master-data-execute.json \
    equipment-ownership-dry-run.json equipment-ownership-execute.json \
    equipment-ownership-idempotent.json acceptance-july-2026-dry-run.json \
    acceptance-july-2026-execute.json acceptance-july-2026-idempotent.json \
    transport-references.before.json transport-reference-invariants.json \
    customer-repair-invariants.json; do
    test -f "$evidence_dir/$required" && test ! -L "$evidence_dir/$required" || \
      v2_die "Customer repair source evidence is missing or unsafe: $required"
    test "$(stat -c '%U:%G' "$evidence_dir/$required")" = root:root || \
      v2_die "Customer repair source evidence is not root-owned: $required"
    mode=$(stat -c '%a' "$evidence_dir/$required")
    case "$mode" in
      640|644) ;;
      *) v2_die "Customer repair source evidence mode is unsafe: $required" ;;
    esac
  done

  /usr/bin/node - "$source_release_id" "$evidence_dir" <<'NODE'
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const [sourceReleaseId, evidenceDir] = process.argv.slice(2);
const read = name => JSON.parse(fs.readFileSync(path.join(evidenceDir, name), 'utf8'));
const sha256 = name => createHash('sha256')
  .update(fs.readFileSync(path.join(evidenceDir, name))).digest('hex');
const handoff = read('backup-handoff.json');
const preview = read('migration-preview.json');
const started = read('migration-started.json');
const after = read('migration-after.json');
const position = read('position-levels-execute.json');
const transport = read('transport-master-data-execute.json');
const transportInvariant = read('transport-reference-invariants.json');
const failedInvariant = read('customer-repair-invariants.json');
const failures = [];
const expect = (condition, code) => { if (!condition) failures.push(code); };

expect(handoff.format === 'task-distribution-v2-release-backup-handoff/v1', 'handoff.format');
expect(handoff.releaseId === sourceReleaseId, 'handoff.releaseId');
expect(handoff.database === 'customer_acceptance_v2_test', 'handoff.database');
expect(handoff.servicesHeldStopped === true, 'handoff.servicesHeldStopped');
expect(started.format === 'task-distribution-v2-migration-started/v1', 'started.format');
expect(started.releaseId === sourceReleaseId, 'started.releaseId');
expect(started.backupId === handoff.backupId, 'started.backupId');
expect(started.migrationPreviewSha256 === sha256('migration-preview.json'), 'started.previewSha256');
expect(started.codeOnlyRollbackAllowed === false, 'started.codeOnlyRollbackAllowed');
expect(preview.releaseId === sourceReleaseId, 'preview.releaseId');
expect(preview.backupId === handoff.backupId, 'preview.backupId');
expect(preview.manifestSha256 === handoff.manifestSha256, 'preview.manifestSha256');
expect(after.database === 'customer_acceptance_v2_test', 'after.database');
expect(after.transportRecords === 23 && after.transportMasterData === 29, 'after.transportCounts');
expect(after.importedEquipmentAssets === 141 && after.importedEquipmentRoutinePlans === 684,
  'after.equipmentCounts');
expect(after.productionSchedules === 43 && after.attendanceDailyReviews === 1,
  'after.acceptanceCounts');
expect(position.status === 'EXECUTED', 'position.status');
expect(position.backup?.backupId === handoff.backupId, 'position.backupId');
expect(position.backup?.manifestSha256 === handoff.manifestSha256, 'position.manifestSha256');
expect(position.after?.plannedUpdateCount === 0, 'position.plannedUpdateCount');
expect(Array.isArray(position.after?.blockers) && position.after.blockers.length === 0,
  'position.blockers');
expect(transport.status === 'EXECUTED', 'transport.status');
expect(transport.backup?.backupId === handoff.backupId, 'transport.backupId');
expect(transport.backup?.manifestSha256 === handoff.manifestSha256, 'transport.manifestSha256');
expect(Array.isArray(transport.conflicts) && transport.conflicts.length === 0,
  'transport.conflicts');
expect(transportInvariant.status === 'TRANSPORT_REFERENCE_INVARIANTS_OK' &&
  transportInvariant.mismatchCount === 0, 'transport.invariants');
expect(failedInvariant.status === 'CUSTOMER_REPAIR_INVARIANTS_FAILED' &&
  failedInvariant.mismatchCount === 2, 'customerRepair.failureStatus');
const mismatchCodes = new Set((failedInvariant.mismatches || []).map(value => value.code));
expect(mismatchCodes.size === 2 && mismatchCodes.has('LIVE_ATTENDANCE_RAW_ACTUAL') &&
  mismatchCodes.has('LIVE_ATTENDANCE_NOT_EMPLOYED'), 'customerRepair.failureCodes');
expect(failedInvariant.acceptance?.attendanceRawActual === 18 &&
  failedInvariant.acceptance?.attendanceNotYetEmployed === 0,
  'customerRepair.authoritativeRawAttendance');
expect(failedInvariant.acceptance?.reviewActualAttendance === 125 &&
  failedInvariant.acceptance?.attendanceTemporaryWorker === 2,
  'customerRepair.authoritativeReview');
if (failures.length) {
  throw new Error(`Customer repair resume evidence mismatch: ${failures.join(', ')}`);
}
NODE
}

v2_assert_v2_tunnel_configuration() {
  local tunnel_exec
  tunnel_exec=$(systemctl show "$V2_TUNNEL_UNIT" -p ExecStart --value 2>/dev/null || true)
  test -n "$tunnel_exec" || v2_die "Unable to inspect V2 tunnel unit: $V2_TUNNEL_UNIT"
  case "$tunnel_exec" in
    *"-R 127.0.0.1:${V2_EXPECTED_TUNNEL_PORT}:127.0.0.1:${V2_EXPECTED_INNER_WEB_PORT}"*) ;;
    *) v2_die 'V2 tunnel unit does not use the isolated 38130 -> 18130 forwarding boundary' ;;
  esac
  case "$tunnel_exec" in
    *"${LEGACY_EXPECTED_TUNNEL_PORT}"*|*"${LEGACY_EXPECTED_API_PORT}"*)
      v2_die 'V2 tunnel unit references a legacy production port'
      ;;
  esac
}

v2_assert_legacy_healthy() {
  local cache_bust legacy_api_health legacy_local_health legacy_public_health
  v2_require_active "$LEGACY_API_UNIT"
  v2_require_active "$LEGACY_MONGO_UNIT"
  v2_require_active "$NGINX_UNIT"
  v2_assert_v2_tunnel_configuration

  cache_bust="v2-release-guard-$(date -u +%s)-$$"
  legacy_api_health=$(curl --fail --silent --show-error --max-time 10 \
    "http://127.0.0.1:${LEGACY_EXPECTED_API_PORT}/") || \
    v2_die 'Legacy API port 8099 check failed'
  legacy_local_health=$(curl --fail --silent --show-error --max-time 10 \
    "http://127.0.0.1/health?release_guard=${cache_bust}") || \
    v2_die 'Legacy local Nginx health check failed'
  legacy_public_health=$(curl --fail --silent --show-error --max-time 15 \
    -H 'Cache-Control: no-cache' -H 'Pragma: no-cache' \
    "${LEGACY_PUBLIC_ORIGIN}/health?release_guard=${cache_bust}") || \
    v2_die 'Legacy public tunnel health check failed'

  /usr/bin/node - "$legacy_api_health" "$legacy_local_health" "$legacy_public_health" <<'NODE'
const [apiText, localText, publicText] = process.argv.slice(2);
let api;
let local;
let publicHealth;
try {
  api = JSON.parse(apiText);
  local = JSON.parse(localText);
  publicHealth = JSON.parse(publicText);
} catch {
  process.stderr.write('Legacy health response is not valid JSON\n');
  process.exit(1);
}
const failures = [];
if (api.status !== 'running' || typeof api.version !== 'string' || !api.version) {
  failures.push('api8099');
}
if (local.status !== 'healthy' || typeof local.service !== 'string' || !local.service) {
  failures.push('localNginx');
}
if (publicHealth.status !== local.status || publicHealth.service !== local.service) {
  failures.push('publicTunnel38080');
}
if (failures.length) {
  process.stderr.write(`Legacy health boundary mismatch: ${failures.join(', ')}\n`);
  process.exit(1);
}
NODE
}

v2_assert_mongo_primary() {
  v2_require_active "$V2_MONGO_UNIT"
  local primary
  primary=$(mongosh --quiet --host 127.0.0.1 --port 27150 --eval \
    'const h=db.hello(); print(h.ok === 1 && h.isWritablePrimary === true && h.setName === "customer_acceptance_v2_rs")' \
    2>/dev/null | tail -n 1)
  test "$primary" = true || v2_die 'V2 MongoDB is not the expected writable replica-set primary'
}

v2_assert_mongo_environment_file() {
  local environment_file="$1"
  local label="${2:-MONGODB_URI}"
  test -f "$V2_MONGO_TARGET_GUARD" || \
    v2_die "V2 MongoDB target guard is missing: $V2_MONGO_TARGET_GUARD"
  if ! /usr/bin/node "$V2_MONGO_TARGET_GUARD" --env-file "$environment_file" >/dev/null; then
    v2_die "$label does not identify the exact isolated V2 MongoDB target"
  fi
}

v2_assert_app_environment() {
  v2_assert_protected_environment_file "$V2_APP_ENV"
  grep -Fqx "APP_INSTANCE=${V2_EXPECTED_INSTANCE}" "$V2_APP_ENV" || \
    v2_die 'APP_INSTANCE does not identify the isolated V2 customer-test instance'
  grep -Fqx "PORT=${V2_EXPECTED_API_PORT}" "$V2_APP_ENV" || \
    v2_die 'PORT does not identify the isolated V2 API port'
  v2_assert_mongo_environment_file "$V2_APP_ENV" 'Application MONGODB_URI'
  grep -Fqx "UPLOAD_PATH=${V2_UPLOAD_ROOT}" "$V2_APP_ENV" || \
    v2_die 'UPLOAD_PATH does not identify the isolated V2 uploads directory'
}

v2_release_path() {
  printf '%s/%s\n' "$V2_RELEASES_DIR" "$1"
}

v2_assert_release_directory() {
  local release_path="$1"
  local resolved
  resolved=$(readlink -f "$release_path" 2>/dev/null || true)
  case "$resolved" in
    "${V2_RELEASES_DIR}/"*) ;;
    *) v2_die "Release path is outside ${V2_RELEASES_DIR}" ;;
  esac
  test -d "$resolved" || v2_die "Release directory is missing: $resolved"
  test ! -L "$release_path" || v2_die 'Release directory must not be a symbolic link'
}

v2_assert_candidate_layout() {
  local candidate="$1"
  local required
  test -d "$candidate" || v2_die "Candidate directory is missing: $candidate"
  v2_assert_release_directory "$candidate"
  for required in \
    app/package.json \
    app/package-lock.json \
    app/app.js \
    app/frontend/dist/index.html \
    app/script/migratePositionLevels.js \
    app/script/backfillTransportMasterData.js \
    app/script/backfillCustomerEquipmentOwnership.js \
    app/services/equipmentOwnershipBackfillService.js \
    app/script/repairAcceptanceJuly2026Data.js \
    app/services/acceptanceJuly2026DataRepairService.js \
    ops/backup.js \
    ops/verify-backup.js \
    ops/restore.js \
    ops/lib/backupCore.js \
    ops/lib/customerRepairReleaseInvariant.js \
    ops/lib/operationsConfig.js \
    ops/lib/v2TestMongoTargetGuard.js \
    ops/lib/v2MigrationPreviewInvariant.js \
    ops/lib/transportReleaseInvariant.js \
    deploy/RELEASE.json \
    deploy/FILE-MANIFEST.json \
    deploy/linux/staging-server.cjs; do
    test -f "$candidate/$required" || v2_die "Candidate file is missing: $required"
  done
}

v2_assert_release_metadata() {
  local candidate="$1"
  local expected_release_id="$2"
  local expected_commit="${3:-}"
  /usr/bin/node - "$candidate/deploy/RELEASE.json" "$expected_release_id" "$expected_commit" <<'NODE'
const fs = require('node:fs');
const [file, releaseId, expectedCommit] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(file, 'utf8'));
const failures = [];
if (value.format !== 'task-distribution-v2-release/v1') failures.push('format');
if (value.releaseId !== releaseId) failures.push('releaseId');
if (expectedCommit && value.commit !== expectedCommit) failures.push('commit');
if (value.environment !== 'customer-test') failures.push('environment');
if (value.apiPort !== 18120) failures.push('apiPort');
if (value.innerWebPort !== 18130) failures.push('innerWebPort');
if (value.mongoPort !== 27150) failures.push('mongoPort');
if (value.replicaSet !== 'customer_acceptance_v2_rs') failures.push('replicaSet');
if (value.database !== 'customer_acceptance_v2_test') failures.push('database');
if (value.webApiBaseUrl !== '/api') failures.push('webApiBaseUrl');
if (!/^[a-f0-9]{40}$/.test(value.commit || '')) failures.push('commitFormat');
if (failures.length) {
  process.stderr.write(`Release metadata mismatch: ${failures.join(', ')}\n`);
  process.exit(1);
}
NODE
}

v2_verify_release_file_manifest() {
  local candidate="$1"
  local expected_release_id="$2"
  local expected_commit="$3"
  /usr/bin/node - "$candidate" "$expected_release_id" "$expected_commit" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const [root, releaseId, commit] = process.argv.slice(2);
const manifestPath = path.join(root, 'deploy', 'FILE-MANIFEST.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (manifest.format !== 'task-distribution-v2-release-files/v1' ||
    manifest.releaseId !== releaseId || manifest.commit !== commit || !Array.isArray(manifest.files)) {
  throw new Error('Release file manifest identity mismatch');
}
const declared = new Map();
for (const entry of manifest.files) {
  if (!entry || typeof entry.file !== 'string' || !Number.isInteger(entry.bytes) || entry.bytes < 0 ||
      !/^[a-f0-9]{64}$/.test(entry.sha256 || '') || declared.has(entry.file)) {
    throw new Error(`Invalid release manifest entry: ${entry?.file || '(unknown)'}`);
  }
  const segments = entry.file.split('/');
  if (entry.file.startsWith('/') || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Unsafe release manifest path: ${entry.file}`);
  }
  const file = path.resolve(root, ...segments);
  if (!file.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error(`Release path escaped root: ${entry.file}`);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.bytes) {
    throw new Error(`Release file metadata mismatch: ${entry.file}`);
  }
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (hash !== entry.sha256) throw new Error(`Release file SHA256 mismatch: ${entry.file}`);
  declared.set(entry.file, true);
}
const actual = [];
function walk(directory) {
  for (const name of fs.readdirSync(directory)) {
    const file = path.join(directory, name);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error(`Release contains symbolic link: ${file}`);
    if (stat.isDirectory()) walk(file);
    else if (stat.isFile()) {
      const relative = path.relative(root, file).split(path.sep).join('/');
      if (relative !== 'deploy/FILE-MANIFEST.json') actual.push(relative);
    } else throw new Error(`Release contains unsupported file type: ${file}`);
  }
}
walk(root);
const undeclared = actual.filter((file) => !declared.has(file));
const missing = [...declared.keys()].filter((file) => !actual.includes(file));
if (undeclared.length || missing.length) {
  throw new Error(`Release file set mismatch; undeclared=${undeclared.length}, missing=${missing.length}`);
}
NODE
}

v2_json_field() {
  local file="$1"
  local field="$2"
  /usr/bin/node - "$file" "$field" <<'NODE'
const fs = require('node:fs');
const [file, field] = process.argv.slice(2);
let value = JSON.parse(fs.readFileSync(file, 'utf8'));
for (const segment of field.split('.')) value = value?.[segment];
if (value === undefined || value === null || typeof value === 'object') process.exit(2);
process.stdout.write(String(value));
NODE
}

v2_operations_value() {
  local candidate="$1"
  local environment_file="$2"
  local key="$3"
  /usr/bin/node - "$candidate/ops/lib/operationsConfig.js" "$environment_file" "$key" <<'NODE'
const fs = require('node:fs');
const [modulePath, file, key] = process.argv.slice(2);
const { parseEnvText } = require(modulePath);
const values = parseEnvText(fs.readFileSync(file, 'utf8'));
const value = values[key];
if (typeof value !== 'string' || !value.trim()) process.exit(2);
process.stdout.write(value.trim());
NODE
}

v2_write_migration_preview_summary() {
  local candidate="$1"
  local evidence_dir="$2"
  local invariant="$candidate/ops/lib/v2MigrationPreviewInvariant.js"
  test -f "$invariant" || v2_die "Migration preview invariant is missing: $invariant"
  /usr/bin/node "$invariant" create \
    --candidate "$candidate" \
    --evidence-dir "$evidence_dir" \
    --handoff "$evidence_dir/backup-handoff.json" \
    --preview "$evidence_dir/migration-preview.json" >/dev/null
}

v2_validate_migration_preview_summary() {
  local candidate="$1"
  local evidence_dir="$2"
  local invariant="$candidate/ops/lib/v2MigrationPreviewInvariant.js"
  test -f "$invariant" || v2_die "Migration preview invariant is missing: $invariant"
  test -f "$evidence_dir/migration-preview.json" || \
    v2_die 'Migration preview is missing; run activation without --execute first'
  /usr/bin/node "$invariant" verify \
    --candidate "$candidate" \
    --evidence-dir "$evidence_dir" \
    --handoff "$evidence_dir/backup-handoff.json" \
    --preview "$evidence_dir/migration-preview.json" >/dev/null
}

v2_migration_input_digest() {
  mongosh --quiet --host 127.0.0.1 --port 27150 --eval '
    const d=db.getSiblingDB("customer_acceptance_v2_test");
    const rows=(name,filter,projection)=>d.getCollection(name)
      .find(filter||{},projection||{}).sort({_id:1}).toArray();
    const teams=rows("projectteams",{},
      {_id:1,code:1,name:1,status:1,settings:1,__v:1,updatedAt:1});
    const orgUnits=rows("orgunits",{},
      {_id:1,teamId:1,parentId:1,type:1,code:1,name:1,status:1,level:1,path:1,__v:1,updatedAt:1});
    const memberships=rows("teammemberships",{},
      {_id:1,teamId:1,userId:1,orgUnitId:1,positionKey:1,positionLevel:1,status:1,__v:1,updatedAt:1});
    const users=rows("users",{},
      {_id:1,usernameNormalized:1,name:1,status:1,isSuperAdmin:1,isSystemAccount:1,__v:1,updatedAt:1});
    const transports=rows("transportrecords",{}, {
      _id:1,teamId:1,tripLabel:1,route:1,vehiclePlate:1,vehicleType:1,driverName:1,
      tripMasterId:1,routeMasterId:1,vehiclePlateMasterId:1,vehicleTypeMasterId:1,driverMasterId:1
    });
    const equipmentAssets=rows("equipmentassets",{},
      {_id:1,teamId:1,orgUnitId:1,custodianUserId:1,assetCode:1,orgUnitNameSnapshot:1,
       custodianDisplayName:1,"dataQuality.importTag":1,__v:1,updatedAt:1});
    const equipmentRoutinePlans=rows("equipmentroutineplans",{},
      {_id:1,teamId:1,orgUnitId:1,equipmentId:1,status:1,__v:1,updatedAt:1});
    const productionSchedules=rows("productionschedules");
    const attendanceSubmissions=rows("attendancesubmissions");
    const attendanceDailyReviews=rows("attendancedailyreviews");
    const generatedDailyReports=rows("generateddailyreports");
    print(EJSON.stringify({
      teams,orgUnits,memberships,users,transports,equipmentAssets,equipmentRoutinePlans,
      productionSchedules,attendanceSubmissions,attendanceDailyReviews,generatedDailyReports
    },{relaxed:false}));
  ' 2>/dev/null | sha256sum | awk '{print $1}'
}

v2_transport_snapshot_digest() {
  mongosh --quiet --host 127.0.0.1 --port 27150 --eval '
    const d=db.getSiblingDB("customer_acceptance_v2_test");
    const rows=d.transportrecords.find({}, {
      _id:1,teamId:1,tripLabel:1,route:1,vehiclePlate:1,vehicleType:1,driverName:1
    }).sort({_id:1}).toArray();
    print(EJSON.stringify(rows,{relaxed:false}));
  ' 2>/dev/null | sha256sum | awk '{print $1}'
}

v2_write_transport_reference_baseline() {
  local destination="$1"
  mongosh --quiet --host 127.0.0.1 --port "$V2_EXPECTED_MONGO_PORT" --eval '
    const d=db.getSiblingDB("customer_acceptance_v2_test");
    const specs=[
      ["tripMasterId","TRIP","tripLabel"],
      ["routeMasterId","ROUTE","route"],
      ["vehiclePlateMasterId","VEHICLE_PLATE","vehiclePlate"],
      ["vehicleTypeMasterId","VEHICLE_TYPE","vehicleType"],
      ["driverMasterId","DRIVER","driverName"]
    ];
    const id=value=>value==null?null:String(value);
    const masters=d.transport_master_data.find({}, {_id:1,teamId:1,kind:1}).sort({_id:1}).toArray();
    const masterById=new Map(masters.map(master=>[id(master._id),master]));
    const records=d.transportrecords.find({}, {
      _id:1,teamId:1,tripLabel:1,route:1,vehiclePlate:1,vehicleType:1,driverName:1,
      tripMasterId:1,routeMasterId:1,vehiclePlateMasterId:1,vehicleTypeMasterId:1,driverMasterId:1
    }).sort({_id:1}).toArray();
    const bindings=[];
    let fullyBound=true;
    for (const record of records) {
      for (const [field,kind,snapshotField] of specs) {
        const snapshot=String(record[snapshotField]||"").trim();
        const referenceId=id(record[field]);
        if (referenceId) bindings.push({recordId:id(record._id),field,referenceId});
        if (Boolean(snapshot)!==Boolean(referenceId)) fullyBound=false;
        if (referenceId) {
          const master=masterById.get(referenceId);
          if (!master || id(master.teamId)!==id(record.teamId) || master.kind!==kind) fullyBound=false;
        }
      }
    }
    print(JSON.stringify({
      format:"task-distribution-v2-transport-reference-baseline/v1",
      database:d.getName(),
      generatedAt:new Date().toISOString(),
      fullyBound,
      bindings,
      masterIds:masters.map(master=>id(master._id)).sort()
    },null,2));
  ' > "$destination"
}

v2_transport_release_state_json() {
  mongosh --quiet --host 127.0.0.1 --port "$V2_EXPECTED_MONGO_PORT" --eval '
    const d=db.getSiblingDB("customer_acceptance_v2_test");
    const id=value=>value==null?null:String(value);
    const records=d.transportrecords.find({}, {
      _id:1,teamId:1,tripLabel:1,route:1,vehiclePlate:1,vehicleType:1,driverName:1,
      tripMasterId:1,routeMasterId:1,vehiclePlateMasterId:1,vehicleTypeMasterId:1,driverMasterId:1
    }).sort({_id:1}).toArray().map(record=>({
      id:id(record._id),teamId:id(record.teamId),
      tripLabel:record.tripLabel,route:record.route,vehiclePlate:record.vehiclePlate,
      vehicleType:record.vehicleType,driverName:record.driverName,
      tripMasterId:id(record.tripMasterId),routeMasterId:id(record.routeMasterId),
      vehiclePlateMasterId:id(record.vehiclePlateMasterId),
      vehicleTypeMasterId:id(record.vehicleTypeMasterId),driverMasterId:id(record.driverMasterId)
    }));
    const masters=d.transport_master_data.find({}, {_id:1,teamId:1,kind:1}).sort({_id:1}).toArray()
      .map(master=>({id:id(master._id),teamId:id(master.teamId),kind:master.kind}));
    print(JSON.stringify({records,masters}));
  '
}

v2_verify_transport_release_state() {
  local candidate="$1"
  local baseline="$2"
  test -f "$baseline" || v2_die "Transport reference baseline is missing: $baseline"
  v2_transport_release_state_json | \
    /usr/bin/node "$candidate/ops/lib/transportReleaseInvariant.js" --baseline "$baseline"
}

v2_customer_repair_state_json() {
  mongosh --quiet --host 127.0.0.1 --port "$V2_EXPECTED_MONGO_PORT" --eval '
    const d=db.getSiblingDB("customer_acceptance_v2_test");
    const importTag="customer-fixed-assets-2026-midyear-v1";
    const assets=d.equipmentassets.find(
      {"dataQuality.importTag":importTag},
      {_id:1,orgUnitId:1,custodianUserId:1,assetCode:1}
    ).sort({_id:1}).toArray();
    const assetById=new Map(assets.map(asset=>[String(asset._id),asset]));
    const routinePlans=d.equipmentroutineplans.find(
      {equipmentId:{$in:assets.map(asset=>asset._id)}},
      {_id:1,equipmentId:1,orgUnitId:1}
    ).sort({_id:1}).toArray();
    const ownershipMismatches=routinePlans.filter(plan=>{
      const asset=assetById.get(String(plan.equipmentId));
      return !asset || String(asset.orgUnitId)!==String(plan.orgUnitId);
    });

    const canonicalId=ObjectId("6a588ae29ad35af9cfd73c9c");
    const duplicateId=ObjectId("6a62bd82e4e630b273cd7156");
    const juneCanonicalId=ObjectId("6a59e5eefe119695fb20f639");
    const juneDuplicateId=ObjectId("6a62d614e4e630b273cfbf1f");
    const submissionId=ObjectId("6a62af14e4e630b273cc3174");
    const reviewId=ObjectId("6a62cccee4e630b273cedbcd");
    const canonical=d.productionschedules.findOne({_id:canonicalId});
    const dailyFields=["aLineDay","aLineNight","northLine","transferCaseLine","bLineDay","bLineNight"];
    const productionTotals={};
    for (const entry of canonical?.dailyEntries||[]) {
      if (entry.date==="2026-07-23" || entry.date==="2026-07-24") {
        productionTotals[entry.date]=dailyFields.reduce((sum,field)=>
          sum+(Number.isFinite(entry[field])?entry[field]:0),0);
      }
    }
    const submission=d.attendancesubmissions.findOne({_id:submissionId});
    const review=d.attendancedailyreviews.findOne({_id:reviewId});
    const conflicts=d.productionschedules.aggregate([
      {$group:{_id:{teamId:"$teamId",month:"$month"},count:{$sum:1}}},
      {$match:{count:{$gt:1}}}
    ]).toArray();
    const finalText=String(review?.finalText||"");
    print(JSON.stringify({
      database:d.getName(),
      equipment:{
        importedAssetCount:assets.length,
        routinePlanCount:routinePlans.length,
        routinePlanOwnershipMismatchCount:ownershipMismatches.length
      },
      acceptance:{
        canonicalScheduleCount:d.productionschedules.countDocuments({_id:canonicalId}),
        duplicateScheduleCount:d.productionschedules.countDocuments({_id:duplicateId}),
        juneCanonicalScheduleCount:d.productionschedules.countDocuments({_id:juneCanonicalId}),
        juneDuplicateScheduleCount:d.productionschedules.countDocuments({_id:juneDuplicateId}),
        teamMonthConflictCount:conflicts.length,
        productionTotals,
        attendanceSubmissionCount:d.attendancesubmissions.countDocuments({_id:submissionId}),
        attendanceRawActual:submission?.dayShift?.actualAttendanceCount??null,
        attendanceNotYetEmployed:submission?.dayShift?.notYetEmployed?.count??0,
        attendanceTemporaryWorker:submission?.dayShift?.temporaryWorker?.count??0,
        attendanceOtherRemark:submission?.otherRemark??null,
        attendanceReviewCount:d.attendancedailyreviews.countDocuments({_id:reviewId}),
        reviewActualAttendance:review?.summarySnapshot?.dayShift?.actualAttendanceCount??null,
        reviewTemporaryWorker:review?.summarySnapshot?.dayShift?.temporaryWorker?.count??0,
        finalTextHasTemporaryWorker:finalText.includes("\u4e34\u65f6\u5de5"),
        finalTextHasActualAttendance:finalText.includes("\u5b9e\u9645\u51fa\u52e4")
      }
    }));
  '
}

v2_verify_customer_repair_state() {
  local candidate="$1"
  local evidence_dir="$2"
  local handoff="$evidence_dir/backup-handoff.json"
  test -f "$handoff" || v2_die 'Customer repair backup handoff is missing'
  v2_customer_repair_state_json | /usr/bin/node \
    "$candidate/ops/lib/customerRepairReleaseInvariant.js" \
    --equipment-dry "$evidence_dir/equipment-ownership-dry-run.json" \
    --equipment-execute "$evidence_dir/equipment-ownership-execute.json" \
    --equipment-idempotent "$evidence_dir/equipment-ownership-idempotent.json" \
    --acceptance-dry "$evidence_dir/acceptance-july-2026-dry-run.json" \
    --acceptance-execute "$evidence_dir/acceptance-july-2026-execute.json" \
    --acceptance-idempotent "$evidence_dir/acceptance-july-2026-idempotent.json" \
    --backup-id "$(v2_json_field "$handoff" backupId)" \
    --manifest-sha256 "$(v2_json_field "$handoff" manifestSha256)"
}

v2_write_runtime_baseline() {
  local destination="$1"
  mongosh --quiet --host 127.0.0.1 --port 27150 --eval '
    const d=db.getSiblingDB("customer_acceptance_v2_test");
    const grouped=d.teammemberships.aggregate([
      {$match:{positionKey:{$in:["TEAM_LEADER","EMPLOYEE"]}}},
      {$group:{_id:{positionKey:"$positionKey",positionLevel:"$positionLevel"},count:{$sum:1}}},
      {$sort:{"_id.positionKey":1,"_id.positionLevel":1}}
    ]).toArray().map(x=>({positionKey:x._id.positionKey,positionLevel:x._id.positionLevel,count:x.count}));
    print(JSON.stringify({
      database:d.getName(),
      membershipLevels:grouped,
      transportRecords:d.transportrecords.countDocuments({}),
      transportMasterData:d.transport_master_data.countDocuments({}),
      importedEquipmentAssets:d.equipmentassets.countDocuments({
        "dataQuality.importTag":"customer-fixed-assets-2026-midyear-v1"
      }),
      importedEquipmentRoutinePlans:d.equipmentroutineplans.countDocuments({}),
      productionSchedules:d.productionschedules.countDocuments({}),
      attendanceSubmissions:d.attendancesubmissions.countDocuments({}),
      attendanceDailyReviews:d.attendancedailyreviews.countDocuments({}),
      uploadReferences:d.fileassets.countDocuments({status:{$ne:"DELETED"}})
    },null,2));
  ' > "$destination"
}

v2_assert_no_forbidden_release_files() {
  local candidate="$1"
  if find "$candidate" -xdev \
      \( -type d \( -name .git -o -name .test-data -o -name customer-data -o -name uploads \) \
      -o -type f \( -name '.env' -o -name '.env.*' -o -name 'operations.env' \
        -o -name 'app.env' -o -name '*.pem' -o -name '*.key' -o -name '*.pfx' \
        -o -name '*.p12' -o -name '*.ppk' -o -name 'id_rsa' -o -name 'id_ed25519' \) \
      -o -type l \) \
      -print -quit | grep -q .; then
    v2_die 'Candidate contains a forbidden repository, data, environment, upload, key, or link artifact'
  fi
}
