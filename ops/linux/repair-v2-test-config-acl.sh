#!/usr/bin/env bash
set -euo pipefail

# Recovery tool for the isolated customer acceptance instance only. It grants
# mongodb-v2 directory traversal without exposing app.env or tunnel secrets.
config_root=/etc/taskdistribution-v2-test
mongo_config="$config_root/mongod-v2-test.conf"
app_env="$config_root/app.env"
mongo_unit=mongod-v2-test.service
api_unit=taskdistribution-v2-test-api.service
tunnel_unit=taskdistribution-v2-test-tunnel.service
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
evidence_dir="/var/log/taskdistribution-v2-test/incident-config-acl-${timestamp}"

install -d -o root -g taskdistributionv2test -m 0750 "$evidence_dir"

capture_state() {
  local suffix=$1
  {
    date --iso-8601=seconds
    systemctl show "$mongo_unit" "$api_unit" "$tunnel_unit" \
      -p Id -p ActiveState -p SubState -p NRestarts -p ExecMainStatus \
      -p User -p Group --no-pager
    stat -c '%A|%a|%U|%G|%n' "$config_root" "$mongo_config" "$app_env"
    namei -l "$mongo_config"
    ss -lntp | grep -E ':(18120|18130|27150)[[:space:]]' || true
  } >"$evidence_dir/state.${suffix}.txt" 2>&1
  journalctl -u "$mongo_unit" --no-pager -n 80 \
    >"$evidence_dir/mongo-journal.${suffix}.txt" 2>&1 || true
}

wait_active() {
  local unit=$1
  for _ in $(seq 1 40); do
    systemctl is-active --quiet "$unit" && return 0
    sleep 1
  done
  systemctl status "$unit" --no-pager -l >&2 || true
  return 1
}

wait_http() {
  local url=$1
  shift
  for _ in $(seq 1 40); do
    if curl --silent --fail --max-time 5 "$@" "$url" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  curl --silent --show-error --include --max-time 10 "$@" "$url" >&2 || true
  return 1
}

test "$(systemctl show "$mongo_unit" -p User --value)" = mongodb-v2
test "$(systemctl show "$mongo_unit" -p Group --value)" = mongodb-v2
test -f "$mongo_config"
test -f "$app_env"
capture_state before

systemctl stop "$tunnel_unit" "$api_unit" "$mongo_unit"

if ! command -v setfacl >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y acl \
    >"$evidence_dir/apt-install-acl.txt" 2>&1
fi

setfacl -m u:mongodb-v2:--x "$config_root"
getfacl -p "$config_root" >"$evidence_dir/config-root.acl.txt"

runuser -u mongodb-v2 -- test -x "$config_root"
runuser -u mongodb-v2 -- test -r "$mongo_config"
if runuser -u mongodb-v2 -- test -r "$app_env"; then
  echo 'mongodb-v2 unexpectedly gained read access to app.env' >&2
  exit 1
fi

systemctl reset-failed "$mongo_unit" "$api_unit" "$tunnel_unit" || true
systemctl start "$mongo_unit"
wait_active "$mongo_unit"

for _ in $(seq 1 40); do
  if ss -lnt | grep -qE '127\.0\.0\.1:27150[[:space:]]'; then break; fi
  sleep 1
done
ss -lnt | grep -qE '127\.0\.0\.1:27150[[:space:]]'
mongosh --quiet --host 127.0.0.1 --port 27150 --eval \
  'const h=db.hello(); if(h.ok!==1 || h.setName!=="customer_acceptance_v2_rs") quit(2); print(JSON.stringify({ok:h.ok,setName:h.setName,isWritablePrimary:h.isWritablePrimary}));' \
  >"$evidence_dir/mongo-hello.json"

systemctl start "$api_unit"
wait_active "$api_unit"
wait_http http://127.0.0.1:18120/health

systemctl restart "$tunnel_unit"
wait_active "$tunnel_unit"
wait_http http://127.0.0.1:18130/health
wait_http http://127.0.0.1:18130/api/auth/login-teams \
  -H 'Host: v2-test.horselink.cn' \
  -H 'Origin: https://v2-test.horselink.cn'

# The legacy production service must remain healthy throughout this V2 repair.
wait_http http://127.0.0.1/health

capture_state after
curl --silent --show-error --fail --max-time 10 \
  http://127.0.0.1:18130/health >"$evidence_dir/v2-health.json"
curl --silent --show-error --fail --max-time 10 \
  -H 'Host: v2-test.horselink.cn' \
  -H 'Origin: https://v2-test.horselink.cn' \
  http://127.0.0.1:18130/api/auth/login-teams \
  >"$evidence_dir/v2-login-teams.json"

chown -R root:taskdistributionv2test "$evidence_dir"
chmod -R g=rX,o= "$evidence_dir"

printf 'REPAIR_OK\nEVIDENCE_DIR=%s\n' "$evidence_dir"
cat "$evidence_dir/mongo-hello.json"
cat "$evidence_dir/v2-health.json"
