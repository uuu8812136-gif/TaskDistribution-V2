#!/usr/bin/env bash
set -euo pipefail

readonly expected_instance='task-distribution-v2-customer-test'
readonly current_link='/opt/taskdistribution-v2-test/current'
readonly operations_env='/etc/taskdistribution-v2-test/operations.env'
readonly service_user='taskdistributionv2test'
readonly libexec_root='/usr/local/libexec/taskdistribution-v2-test'

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
files=(
  taskdistribution-v2-test-backup-volume.service
  taskdistribution-v2-test-backup.service
  taskdistribution-v2-test-backup.timer
  taskdistribution-v2-test-health.service
  taskdistribution-v2-test-health.timer
)

if [[ "${1:-}" != '--apply' ]]; then
  printf 'DRY_RUN_READY instance=%s\n' "$expected_instance"
  printf '%s\n' "${files[@]}"
  exit 0
fi

test "$(id -u)" -eq 0 || {
  echo 'Run as root' >&2
  exit 1
}
id "$service_user" >/dev/null 2>&1 || {
  echo "Required service account is missing: $service_user" >&2
  exit 1
}
current="$(readlink -f "$current_link")"
test -d "$current" || {
  echo 'Current V2 test release cannot be resolved' >&2
  exit 1
}
for relative in ops/backup.js ops/lib/backupCore.js ops/lib/operationsConfig.js; do
  test -f "$current/$relative" || {
    echo "Current release file is missing: $relative" >&2
    exit 1
  }
done
for relative in health-terminal.js lib/healthCore.js lib/backupCore.js lib/operationsConfig.js; do
  test -f "$script_dir/$relative" || {
    echo "Scheduled health asset is missing: $relative" >&2
    exit 1
  }
done
test "$(stat -c '%U:%G:%a' "$operations_env")" = 'root:taskdistributionv2test:640' || {
  echo 'Operations environment ownership or mode is invalid' >&2
  exit 1
}

install -d -o root -g root -m 0755 "$libexec_root"
install -o root -g root -m 0755 \
  "$script_dir/ensure-v2-test-backup-volume.sh" \
  "$libexec_root/ensure-backup-volume.sh"
install -o root -g root -m 0755 \
  "$script_dir/create-v2-test-scheduled-backup-handoff.sh" \
  "$libexec_root/create-scheduled-backup-handoff.sh"
install -d -o root -g root -m 0755 "$libexec_root/health/lib"
install -o root -g root -m 0644 "$script_dir/health-terminal.js" "$libexec_root/health/"
install -o root -g root -m 0644 \
  "$script_dir/lib/healthCore.js" \
  "$script_dir/lib/backupCore.js" \
  "$script_dir/lib/operationsConfig.js" \
  "$libexec_root/health/lib/"
for file in "${files[@]}"; do
  install -o root -g root -m 0644 "$script_dir/$file" "/etc/systemd/system/$file"
done

systemd-analyze verify "${files[@]/#//etc/systemd/system/}"
systemctl daemon-reload
systemctl enable --now taskdistribution-v2-test-backup-volume.service
systemctl enable --now taskdistribution-v2-test-backup.timer taskdistribution-v2-test-health.timer

printf 'SCHEDULED_OPERATIONS_INSTALLED=true\n'
printf 'CURRENT_RELEASE=%s\n' "$current"
systemctl list-timers taskdistribution-v2-test-backup.timer taskdistribution-v2-test-health.timer \
  --all --no-pager
