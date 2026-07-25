#!/usr/bin/env bash
set -euo pipefail

readonly volume_root='/mnt/taskdistribution-v2-test-backup'
readonly volume_source='taskdistribution-v2-scheduled-backup'
readonly service_user='taskdistributionv2test'
readonly volume_size='2G'

test "$(id -u)" -eq 0 || {
  echo 'Run as root' >&2
  exit 1
}
id "$service_user" >/dev/null 2>&1 || {
  echo "Required service account is missing: $service_user" >&2
  exit 1
}
test ! -L "$volume_root" || {
  echo "Backup volume path must not be a symlink: $volume_root" >&2
  exit 1
}

service_uid="$(id -u "$service_user")"
service_gid="$(id -g "$service_user")"
install -d -o "$service_user" -g "$service_user" -m 0750 "$volume_root"

if mountpoint -q "$volume_root"; then
  filesystem="$(findmnt -n -o FSTYPE --target "$volume_root")"
  source="$(findmnt -n -o SOURCE --target "$volume_root")"
  test "$filesystem" = 'tmpfs' || {
    echo "Unexpected backup filesystem: $filesystem" >&2
    exit 1
  }
  case "$source" in
    taskdistribution-v2-maint-backup|taskdistribution-v2-scheduled-backup) ;;
    *)
      echo "Unexpected backup mount source: $source" >&2
      exit 1
      ;;
  esac
  mount -o "remount,size=${volume_size},mode=0750,uid=${service_uid},gid=${service_gid},nosuid,nodev,noexec" \
    "$volume_root"
else
  test -z "$(find "$volume_root" -mindepth 1 -print -quit)" || {
    echo "Refusing to mount over a non-empty directory: $volume_root" >&2
    exit 1
  }
  mount -t tmpfs \
    -o "size=${volume_size},mode=0750,uid=${service_uid},gid=${service_gid},nosuid,nodev,noexec" \
    "$volume_source" "$volume_root"
fi

test "$(stat -c '%d' "$volume_root")" != "$(stat -c '%d' /)" || {
  echo 'Backup volume is not isolated from the Linux system filesystem' >&2
  exit 1
}
install -d -o "$service_user" -g "$service_user" -m 0750 \
  "$volume_root/backups" "$volume_root/handoffs" "$volume_root/logs"

printf 'VOLUME_READY=%s\n' "$volume_root"
findmnt -no TARGET,SOURCE,FSTYPE,OPTIONS --target "$volume_root"
