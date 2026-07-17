#!/bin/sh
set -eu

if [ "${1:-}" != "--apply" ]; then
  echo "Dry run: install the files below only after paths and the service account are reviewed."
  printf '%s\n' \
    taskdistribution-v2-backup.service \
    taskdistribution-v2-backup.timer \
    taskdistribution-v2-health.service \
    taskdistribution-v2.logrotate
  exit 0
fi

test "$(id -u)" -eq 0 || { echo "Run as root" >&2; exit 1; }
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
install -o root -g root -m 0644 "$SCRIPT_DIR/taskdistribution-v2-backup.service" /etc/systemd/system/
install -o root -g root -m 0644 "$SCRIPT_DIR/taskdistribution-v2-backup.timer" /etc/systemd/system/
install -o root -g root -m 0644 "$SCRIPT_DIR/taskdistribution-v2-health.service" /etc/systemd/system/
install -o root -g root -m 0644 "$SCRIPT_DIR/taskdistribution-v2.logrotate" /etc/logrotate.d/taskdistribution-v2
systemctl daemon-reload
systemctl enable --now taskdistribution-v2-backup.timer taskdistribution-v2-health.service
systemctl list-timers taskdistribution-v2-backup.timer --no-pager
