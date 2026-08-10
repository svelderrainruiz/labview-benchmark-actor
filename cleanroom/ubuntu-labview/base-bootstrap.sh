#!/usr/bin/env bash
# VirtualBox unattended post-install template for the remotely automatable Ubuntu cleanroom base.
# The builder replaces the two LBA placeholders in a private temporary copy before giving it to VirtualBox.
set -euo pipefail

VM_NAME='@@LBA_VM_NAME@@'
VM_UUID='@@LBA_VM_UUID@@'
RECEIPT_DIR=/var/lib/lba-cleanroom
RECEIPT="$RECEIPT_DIR/base-bootstrap-receipt.json"
STATE="$RECEIPT_DIR/base-bootstrap-state.json"
FINALIZER=/usr/local/sbin/lba-base-bootstrap-finalize
SERVICE=/etc/systemd/system/lba-base-bootstrap-receipt.service
TIMER=/etc/systemd/system/lba-base-bootstrap-receipt.timer
started_wall="$(date --utc +%Y-%m-%dT%H:%M:%S.%NZ)"
started_ns="$(python3 -c 'import time; print(time.monotonic_ns())')"

on_error() {
  exit_code=$?
  trap - ERR
  install -d -m 0755 "$RECEIPT_DIR" 2>/dev/null || true
  failed_wall="$(date --utc +%Y-%m-%dT%H:%M:%S.%NZ)"
  failed_ns="$(python3 -c 'import time; print(time.monotonic_ns())' 2>/dev/null || printf '0')"
  [ "$failed_ns" -ge "$started_ns" ] || failed_ns="$started_ns"
  python3 - "$RECEIPT" "$VM_NAME" "$VM_UUID" "$started_wall" "$failed_wall" \
    "$((failed_ns - started_ns))" "$exit_code" "${BASH_LINENO[0]:-unknown}" 2>/dev/null <<'PY' || true
import json
import sys

destination, vm_name, vm_uuid, started_wall, finished_wall, duration_ns, exit_code, line = sys.argv[1:]
record = {
    "schema": "labview-benchmark-actor/ubuntu-base-bootstrap@1",
    "os": {"name": None, "version": None},
    "vm": {"name": vm_name, "uuid": vm_uuid},
    "tools": {},
    "services": {},
    "timings": {
        "install": {
            "startedWallTime": started_wall,
            "finishedWallTime": finished_wall,
            "monotonicClockSource": "python.time.monotonic_ns",
            "durationNs": duration_ns,
        },
    },
    "failures": [f"bootstrap command failed at line {line} with exit code {exit_code}"],
    "outcome": "FAIL",
}
with open(destination, "w", encoding="utf-8") as handle:
    json.dump(record, handle, indent=2, sort_keys=True)
    handle.write("\n")
PY
  exit "$exit_code"
}
trap on_error ERR

fail() {
  printf 'base-bootstrap: %s\n' "$*" >&2
  return 1
}

[ "$(id -u)" = 0 ] || fail 'must run as root'
case "$VM_NAME" in *'@@'*) fail 'VM name placeholder was not materialized' ;; esac
case "$VM_UUID" in *'@@'*) fail 'VM UUID placeholder was not materialized' ;; esac
[ -r /etc/os-release ] || fail '/etc/os-release is required'
. /etc/os-release
[ "${ID:-}" = ubuntu ] || fail "unsupported OS: ${ID:-unknown}"
[ "${VERSION_ID:-}" = 24.04 ] || fail "unsupported Ubuntu version: ${VERSION_ID:-unknown}"

case "$(cat /sys/class/dmi/id/sys_vendor 2>/dev/null || true)" in
  *Oracle*|*innotek*) ;;
  *) fail 'VirtualBox guest hardware was not detected' ;;
esac

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends openssh-server git virtualbox-guest-utils
systemctl enable ssh.service
systemctl enable virtualbox-guest-utils.service

install -d -m 0755 "$RECEIPT_DIR"
finished_wall="$(date --utc +%Y-%m-%dT%H:%M:%S.%NZ)"
finished_ns="$(python3 -c 'import time; print(time.monotonic_ns())')"
python3 - "$STATE" "$VM_NAME" "$VM_UUID" "$started_wall" "$finished_wall" \
  "$((finished_ns - started_ns))" "${PRETTY_NAME:-Ubuntu 24.04 LTS}" "${VERSION_ID}" <<'PY'
import json
import sys

(
    destination, vm_name, vm_uuid, started_wall, finished_wall,
    duration_ns, os_name, os_version,
) = sys.argv[1:]
record = {
    "vm": {"name": vm_name, "uuid": vm_uuid},
    "os": {"name": os_name, "version": os_version},
    "installTiming": {
        "startedWallTime": started_wall,
        "finishedWallTime": finished_wall,
        "monotonicClockSource": "python.time.monotonic_ns",
        "durationNs": duration_ns,
    },
}
with open(destination, "w", encoding="utf-8") as handle:
    json.dump(record, handle, indent=2, sort_keys=True)
    handle.write("\n")
PY

cat > "$FINALIZER" <<'FINALIZER'
#!/usr/bin/env bash
set -euo pipefail

STATE=/var/lib/lba-cleanroom/base-bootstrap-state.json
RECEIPT=/var/lib/lba-cleanroom/base-bootstrap-receipt.json
started_wall="$(date --utc +%Y-%m-%dT%H:%M:%S.%NZ)"
started_ns="$(python3 -c 'import time; print(time.monotonic_ns())')"

[ -r "$STATE" ]
systemctl restart virtualbox-guest-utils.service 2>/dev/null || true
ssh_state="$(systemctl is-active ssh.service 2>/dev/null || true)"
guest_state="$(systemctl is-active virtualbox-guest-utils.service 2>/dev/null || true)"
ssh_enabled="$(systemctl is-enabled ssh.service 2>/dev/null || true)"
guest_enabled="$(systemctl is-enabled virtualbox-guest-utils.service 2>/dev/null || true)"
git_path="$(command -v git || true)"
sshd_path="$(command -v sshd || true)"
vbox_path="$(command -v VBoxService || true)"
failures=()
[ "$ssh_state" = active ] || failures+=("ssh.service is not active")
[ -n "$git_path" ] || failures+=("git is not installed")
[ -n "$sshd_path" ] || failures+=("sshd is not installed")
[ "$ssh_enabled" = enabled ] || failures+=("ssh.service is not enabled")
[ "$guest_state" = active ] || failures+=("virtualbox-guest-utils.service is not active")
[ "$guest_enabled" = enabled ] || failures+=("virtualbox-guest-utils.service is not enabled")
[ -n "$vbox_path" ] || failures+=("VBoxService is not installed")

git_version="$("$git_path" --version 2>/dev/null || true)"
sshd_version="$(dpkg-query -W -f='${Version}' openssh-server 2>/dev/null || true)"
vbox_version="$("$vbox_path" --version 2>/dev/null || true)"
finished_wall="$(date --utc +%Y-%m-%dT%H:%M:%S.%NZ)"
finished_ns="$(python3 -c 'import time; print(time.monotonic_ns())')"
failure_text="$(printf '%s\n' "${failures[@]:-}")"

python3 - "$STATE" "$RECEIPT" "$started_wall" "$finished_wall" "$((finished_ns - started_ns))" \
  "$git_path" "$git_version" "$sshd_path" "$sshd_version" "$vbox_path" "$vbox_version" \
  "$ssh_state" "$ssh_enabled" "$guest_state" "$guest_enabled" "$failure_text" <<'PY'
import json
import sys

(
    state_path, destination, started_wall, finished_wall, duration_ns,
    git_path, git_version, sshd_path, sshd_version, vbox_path, vbox_version,
    ssh_state, ssh_enabled, guest_state, guest_enabled, failure_text,
) = sys.argv[1:]
with open(state_path, encoding="utf-8") as handle:
    state = json.load(handle)
failures = [line for line in failure_text.splitlines() if line]
record = {
    "schema": "labview-benchmark-actor/ubuntu-base-bootstrap@1",
    "os": state["os"],
    "vm": state["vm"],
    "tools": {
        "git": {"path": git_path or None, "version": git_version or None},
        "sshd": {"path": sshd_path or None, "version": sshd_version or None},
        "virtualBoxGuestService": {"path": vbox_path or None, "version": vbox_version or None},
    },
    "services": {
        "ssh": {"activeState": ssh_state, "enabledState": ssh_enabled},
        "virtualBoxGuestUtils": {"activeState": guest_state, "enabledState": guest_enabled},
    },
    "timings": {
        "install": state["installTiming"],
        "firstBootValidation": {
            "startedWallTime": started_wall,
            "finishedWallTime": finished_wall,
            "monotonicClockSource": "python.time.monotonic_ns",
            "durationNs": duration_ns,
        },
    },
    "failures": failures,
    "outcome": "PASS" if not failures else "FAIL",
}
with open(destination, "w", encoding="utf-8") as handle:
    json.dump(record, handle, indent=2, sort_keys=True)
    handle.write("\n")
PY

[ "${#failures[@]}" -eq 0 ]
FINALIZER
chmod 0755 "$FINALIZER"

cat > "$SERVICE" <<'UNIT'
[Unit]
Description=Validate the LBA Ubuntu base bootstrap and write its receipt
After=network-online.target ssh.service
Wants=network-online.target ssh.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/lba-base-bootstrap-finalize
UNIT

cat > "$TIMER" <<'UNIT'
[Unit]
Description=Delay LBA Ubuntu base validation until installer cleanup has settled

[Timer]
OnBootSec=30s
AccuracySec=1s
Unit=lba-base-bootstrap-receipt.service

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable lba-base-bootstrap-receipt.timer
printf 'base-bootstrap: packages installed; first-boot receipt validation enabled\n'
