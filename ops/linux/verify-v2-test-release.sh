#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=v2-test-release-common.sh
. "$SCRIPT_DIR/v2-test-release-common.sh"

release_id=''
expected_transport_snapshot=''
expected_reference_baseline=''
public_origin='https://v2-test.horselink.cn'
skip_public=0

usage() {
  cat <<'EOF'
Read-only verification for an activated isolated V2 customer-test release.

  verify-v2-test-release.sh --release-id <id> \
    --expected-transport-snapshot <sha256> \
    --expected-reference-baseline <absolute.json> [--skip-public]
EOF
}

while test "$#" -gt 0; do
  case "$1" in
    --release-id) release_id="${2:-}"; shift 2 ;;
    --expected-transport-snapshot) expected_transport_snapshot="${2:-}"; shift 2 ;;
    --expected-reference-baseline) expected_reference_baseline="${2:-}"; shift 2 ;;
    --public-origin) public_origin="${2:-}"; shift 2 ;;
    --skip-public) skip_public=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) v2_die "Unknown option: $1" ;;
  esac
done

v2_validate_release_id "$release_id"
case "$expected_transport_snapshot" in
  *[!a-f0-9]*|'') v2_die 'Expected transport snapshot must be lowercase SHA256' ;;
esac
test "${#expected_transport_snapshot}" -eq 64 || v2_die 'Expected transport snapshot must be lowercase SHA256'
test "${expected_reference_baseline#/}" != "$expected_reference_baseline" && \
  test -f "$expected_reference_baseline" || \
  v2_die 'Expected transport reference baseline must be an existing absolute file'

candidate=$(v2_release_path "$release_id")
evidence_dir="${V2_EVIDENCE_ROOT}/${release_id}"
test "$expected_reference_baseline" = \
  "${V2_EVIDENCE_ROOT}/${release_id}/transport-references.before.json" || \
  v2_die 'Transport reference baseline is outside the release evidence directory'
test "$(readlink -f "$V2_CURRENT_LINK" 2>/dev/null || true)" = "$candidate" || \
  v2_die 'Current V2 release does not match the expected release'
v2_assert_candidate_layout "$candidate"
v2_assert_release_metadata "$candidate" "$release_id" ''
v2_assert_app_environment
v2_assert_legacy_healthy
v2_assert_mongo_primary
v2_require_active "$V2_API_UNIT"
v2_require_active "$V2_TUNNEL_UNIT"

curl --fail --silent --show-error --max-time 10 http://127.0.0.1:18120/health >/dev/null
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:18130/health >/dev/null
test "$(v2_transport_snapshot_digest)" = "$expected_transport_snapshot" || \
  v2_die 'Historical transport snapshot fields changed during release'
transport_reference_result=$(v2_verify_transport_release_state \
  "$candidate" "$expected_reference_baseline") || \
  v2_die 'V2 transport reference invariants failed'
v2_validate_migration_preview_summary "$candidate" "$evidence_dir" || \
  v2_die 'V2 migration preview evidence is invalid'
customer_repair_result=$(v2_verify_customer_repair_state \
  "$candidate" "$evidence_dir") || \
  v2_die 'V2 customer equipment and acceptance repair invariants failed'

database_result=$(mongosh --quiet --host 127.0.0.1 --port 27150 --eval '
  const d=db.getSiblingDB("customer_acceptance_v2_test");
  const wrongPositionLevels=d.teammemberships.countDocuments({$or:[
    {positionKey:"TEAM_LEADER",positionLevel:{$ne:5}},
    {positionKey:"EMPLOYEE",positionLevel:{$ne:6}}
  ]});
  const indexNames=d.transport_master_data.getIndexes().map(x=>x.name);
  const requiredIndexes=["uq_transport_master_team_kind_key","ix_transport_master_team_kind_status_sort"];
  const missingIndexes=requiredIndexes.filter(name=>!indexNames.includes(name));
  const productionScheduleIndex=d.productionschedules.getIndexes()
    .find(x=>x.name==="uq_production_schedule_team_month");
  const productionScheduleIndexValid=productionScheduleIndex?.unique===true &&
    productionScheduleIndex.key?.teamId===1 && productionScheduleIndex.key?.month===1 &&
    Object.keys(productionScheduleIndex.key).length===2;
  const result={
    database:d.getName(),
    wrongPositionLevels,
    transportRecords:d.transportrecords.countDocuments({}),
    transportMasterData:d.transport_master_data.countDocuments({}),
    missingIndexes,
    productionScheduleIndexValid
  };
  print(JSON.stringify(result));
  if (wrongPositionLevels || missingIndexes.length || !productionScheduleIndexValid) quit(2);
' 2>/dev/null) || v2_die 'V2 database invariant verification failed'

if test "$skip_public" -ne 1; then
  case "$public_origin" in https://v2-test.horselink.cn) ;; *) v2_die 'Public origin is not the isolated V2 host' ;; esac
  curl --fail --silent --show-error --max-time 15 "$public_origin/health" >/dev/null
  curl --fail --silent --show-error --max-time 15 "$public_origin/api/auth/login-teams" >/dev/null
fi

api_restarts=$(systemctl show "$V2_API_UNIT" -p NRestarts --value)
tunnel_restarts=$(systemctl show "$V2_TUNNEL_UNIT" -p NRestarts --value)
printf '{"status":"V2_RELEASE_VERIFIED","releaseId":"%s","apiRestarts":%s,"tunnelRestarts":%s,"transportReferences":%s,"customerRepairs":%s,"database":%s}\n' \
  "$release_id" "${api_restarts:-0}" "${tunnel_restarts:-0}" \
  "$transport_reference_result" "$customer_repair_result" "$database_result"
