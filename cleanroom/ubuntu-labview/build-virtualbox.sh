#!/usr/bin/env bash
# From-scratch VirtualBox builder for the Ubuntu 24.04 + LabVIEW 2026 Community clean room (LINUX plane).
#
# Reproduces — from NOTHING but the stock public Ubuntu 24.04 ISO — the operator's working VM
# `lba-ubuntu2404-labview2026` (Ubuntu 24.04 LTS, BIOS/PIIX3, 12 GB / 6 vCPU, 128 MB VRAM vmsvga,
# SATA-AHCI system disk, NAT). Nothing pre-built is distributed: the user supplies the stock Ubuntu ISO;
# this script creates the VM + unattended-installs Ubuntu + the remote-automation base. LabVIEW 2026
# Community is then installed by provision-guest.sh (UNACTIVATED); ACTIVATION is the operator's step.
#
# This is the VirtualBox (LINUX-plane) reference. The WIN plane mirrors it on VMware (see README.md) with
# the SAME guest spec + the SAME provision-guest.sh — only the hypervisor-creation step differs.
#
# SAFE BY DEFAULT: prints the exact VBoxManage commands (dry-run). Pass --run to execute. Refuses to touch
# an existing VM of the same name, so it never clobbers the operator's real VM.
set -euo pipefail

VM_NAME="${VM_NAME:-lba-ubuntu2404-labview2026-scratch}"
ISO="${ISO:-}"                        # path to the stock Ubuntu 24.04 ISO (you download it; required for --run)
DISK_GB="${DISK_GB:-80}"              # matches build-vmware.ps1 (headroom for the full LabVIEW 2026 stack)
MEM_MB="${MEM_MB:-12288}"             # matches the operator's working VM
CPUS="${CPUS:-6}"
VRAM_MB="${VRAM_MB:-128}"
OSTYPE_ID="${OSTYPE_ID:-}"                   # set from the cleanroom manifest below (env still overrides)
BASEFOLDER="${BASEFOLDER:-$HOME/VirtualBox VMs}"
GUEST_USER="${GUEST_USER:-actor}"           # 'actor' = cross-plane identity parity with the Windows cleanroom
GUEST_FULLNAME="${GUEST_FULLNAME:-LBA Actor}"
GUEST_HOSTNAME="${GUEST_HOSTNAME:-actor}"
SSH_HOST_PORT="${SSH_HOST_PORT:-}"           # optional operator-selected host-loopback NAT forward to guest :22
START_MODE="${START_MODE:-headless}"        # headless | gui | none
DRY_RUN=1

# Provisioning FACTS from the single pinned manifest (OS ISO + VBox type); build-vmware.ps1 mirrors this read.
# Env vars still override; if jq or the manifest is absent, fall back to the pinned defaults.
MANIFEST="${CLEANROOM_MANIFEST:-$(dirname "$(readlink -f "$0")")/cleanroom-manifest.json}"
ISO_SHA256="${ISO_SHA256:-}"; ISO_URL="${ISO_URL:-}"
if [ -f "$MANIFEST" ] && command -v jq >/dev/null 2>&1; then
  OSTYPE_ID="${OSTYPE_ID:-$(jq -r '.os.vbox_ostype // empty' "$MANIFEST")}"
  ISO_SHA256="${ISO_SHA256:-$(jq -r '.os.iso.amd64.sha256 // empty' "$MANIFEST")}"
  ISO_URL="${ISO_URL:-$(jq -r '.os.iso.amd64.url // empty' "$MANIFEST")}"
fi
OSTYPE_ID="${OSTYPE_ID:-Ubuntu24_LTS_64}"   # fallback if the manifest/jq is unavailable

usage() {
  sed -n '2,13p' "$0"
  echo
  echo "Usage:  ISO=/path/ubuntu-24.04-desktop-amd64.iso $0 [--run] [--gui|--headless]"
  echo "Env overrides: VM_NAME DISK_GB MEM_MB CPUS VRAM_MB OSTYPE_ID BASEFOLDER GUEST_USER GUEST_FULLNAME GUEST_HOSTNAME"
  echo "               GUEST_PASSWORD_FILE (required for --run; disposable credential in a 0600 file)"
  echo "               SSH_HOST_PORT (optional explicit 127.0.0.1 NAT forward to guest port 22)"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --run)       DRY_RUN=0 ;;
    --dry-run)   DRY_RUN=1 ;;
    --gui)       START_MODE=gui ;;
    --headless)  START_MODE=headless ;;
    -h|--help)   usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

run() {
  if [ "$DRY_RUN" = 1 ]; then printf '  [dry-run] %s\n' "$*"; else echo "  + $*"; "$@"; fi
}

run_redacted() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '  [dry-run] %s\n' "$*"
    return
  fi
  echo "  + $*"
  set +e
  "$@" 2>&1 | sed -E 's/^([[:space:]]*(password|user-password|admin-password)[[:space:]]*[:=]).*/\1 [redacted]/I'
  command_status="${PIPESTATUS[0]}"
  set -e
  return "$command_status"
}

command -v VBoxManage >/dev/null 2>&1 || { echo "[abort] VBoxManage not found — install VirtualBox." >&2; exit 1; }

# Safety: never clobber the operator's real VM (or any existing VM of this name).
if VBoxManage list vms | grep -q "\"$VM_NAME\""; then
  echo "[abort] VM '$VM_NAME' already exists. Choose a new disposable VM_NAME." >&2
  exit 1
fi

if [ "$DRY_RUN" = 0 ]; then
  [ -n "$ISO" ]   || { echo "[abort] --run needs ISO=/path/to/ubuntu-24.04-*.iso (download it${ISO_URL:+ from $ISO_URL})." >&2; exit 1; }
  [ -f "$ISO" ]   || { echo "[abort] ISO not found: $ISO" >&2; exit 1; }
  [ -n "${GUEST_PASSWORD_FILE:-}" ] || { echo "[abort] --run needs GUEST_PASSWORD_FILE pointing to a 0600 disposable credential file." >&2; exit 1; }
  [ -f "$GUEST_PASSWORD_FILE" ] || { echo "[abort] GUEST_PASSWORD_FILE does not exist." >&2; exit 1; }
  [ -s "$GUEST_PASSWORD_FILE" ] || { echo "[abort] GUEST_PASSWORD_FILE is empty." >&2; exit 1; }
  password_mode="$(stat -c '%a' "$GUEST_PASSWORD_FILE" 2>/dev/null || stat -f '%Lp' "$GUEST_PASSWORD_FILE" 2>/dev/null || true)"
  [ -n "$password_mode" ] || { echo "[abort] could not determine GUEST_PASSWORD_FILE permissions." >&2; exit 1; }
  [ "$((8#$password_mode & 077))" -eq 0 ] ||
    { echo "[abort] GUEST_PASSWORD_FILE must not be accessible by group or other users." >&2; exit 1; }
  if [ -n "$ISO_SHA256" ] && command -v sha256sum >/dev/null 2>&1; then
    echo "   verifying ISO sha256 against the cleanroom manifest ..."
    got="$(sha256sum "$ISO" | cut -d' ' -f1)"
    [ "$got" = "$ISO_SHA256" ] || { echo "[abort] ISO sha256 mismatch: got $got; manifest pins $ISO_SHA256." >&2; exit 1; }
  fi
fi

BOOTSTRAP_SOURCE="$(dirname "$(readlink -f "$0")")/base-bootstrap.sh"
[ -f "$BOOTSTRAP_SOURCE" ] || { echo "[abort] missing unattended bootstrap template: $BOOTSTRAP_SOURCE" >&2; exit 1; }
if [ "$DRY_RUN" = 0 ] && ! VBoxManage unattended install --help 2>&1 | grep -q -- '--post-install-template'; then
  echo "[abort] this VBoxManage does not support unattended --post-install-template" >&2
  exit 1
fi
if [ -n "$SSH_HOST_PORT" ]; then
  case "$SSH_HOST_PORT" in
    *[!0-9]*|'') echo "[abort] SSH_HOST_PORT must be an integer from 1024 through 65535" >&2; exit 1 ;;
  esac
  [ "$SSH_HOST_PORT" -ge 1024 ] && [ "$SSH_HOST_PORT" -le 65535 ] ||
    { echo "[abort] SSH_HOST_PORT must be from 1024 through 65535" >&2; exit 1; }
fi

VM_DIR="$BASEFOLDER/$VM_NAME"
DISK="$VM_DIR/$VM_NAME.vdi"

echo "== From-scratch VirtualBox build: $VM_NAME =="
echo "   $OSTYPE_ID | ${MEM_MB} MB RAM | ${CPUS} vCPU | ${VRAM_MB} MB VRAM | ${DISK_GB} GB SATA-AHCI | NAT | BIOS/PIIX3"
[ "$DRY_RUN" = 1 ] && echo "   (dry-run — printing commands only; pass --run to execute)"
echo

# 1) Create + register the VM.
run VBoxManage createvm --name "$VM_NAME" --ostype "$OSTYPE_ID" --basefolder "$BASEFOLDER" --register

# 2) Match the operator's working-VM hardware profile (BIOS firmware, PIIX3 chipset, vmsvga gfx).
run VBoxManage modifyvm "$VM_NAME" \
  --memory "$MEM_MB" --cpus "$CPUS" --vram "$VRAM_MB" --graphicscontroller vmsvga \
  --chipset piix3 --firmware bios --ioapic on --rtcuseutc on --nic1 nat
if [ -n "$SSH_HOST_PORT" ]; then
  run VBoxManage modifyvm "$VM_NAME" --natpf1 "lba-ssh,tcp,127.0.0.1,$SSH_HOST_PORT,,22"
fi

# 3) SATA-AHCI system disk (matches the real VM's IntelAhci controller).
run VBoxManage createmedium disk --filename "$DISK" --size "$((DISK_GB * 1024))" --format VDI
run VBoxManage storagectl "$VM_NAME" --name SATA --add sata --controller IntelAhci --portcount 2 --bootable on
run VBoxManage storageattach "$VM_NAME" --storagectl SATA --port 0 --device 0 --type hdd --medium "$DISK"

# 4) IDE optical controller (the install ISO rides here; auto-ejected after install — as on the real VM).
run VBoxManage storagectl "$VM_NAME" --name IDE --add ide --controller PIIX4

# 5) Unattended Ubuntu 24.04 install + base bootstrap, straight from the stock ISO. The disposable guest
#    credential stays in a 0600 temporary file — never in process arguments, output, receipts, or source.
PWFILE="$(mktemp)"; chmod 600 "$PWFILE"
if [ "$DRY_RUN" = 0 ]; then
  cat "$GUEST_PASSWORD_FILE" > "$PWFILE"
fi
trap 'rm -f "$PWFILE"' EXIT

if [ "$DRY_RUN" = 0 ]; then
  VM_UUID="$(VBoxManage showvminfo "$VM_NAME" --machinereadable | sed -n 's/^UUID="\(.*\)"$/\1/p')"
  [ -n "$VM_UUID" ] || { echo "[abort] could not resolve UUID for '$VM_NAME'" >&2; exit 1; }
else
  VM_UUID=00000000-0000-0000-0000-000000000000
fi
case "$VM_NAME:$VM_UUID" in
  *[!A-Za-z0-9._:-]*) echo "[abort] VM name or UUID contains unsupported template characters" >&2; exit 1 ;;
esac
BOOTSTRAP_TEMPLATE="$(mktemp)"
sed -e "s/@@LBA_VM_NAME@@/$VM_NAME/g" -e "s/@@LBA_VM_UUID@@/$VM_UUID/g" \
  "$BOOTSTRAP_SOURCE" > "$BOOTSTRAP_TEMPLATE"
chmod 600 "$BOOTSTRAP_TEMPLATE"
trap 'rm -f "$PWFILE" "$BOOTSTRAP_TEMPLATE"' EXIT

UNATTENDED_ARGS=(
  "$VM_NAME"
  "--iso=${ISO:-/path/to/ubuntu-24.04-desktop-amd64.iso}"
  "--user=$GUEST_USER" "--user-password-file=$PWFILE" "--full-user-name=$GUEST_FULLNAME"
  --locale=en_US --country=US --time-zone=UTC
  "--hostname=${GUEST_HOSTNAME}.local"
  "--post-install-template=$BOOTSTRAP_TEMPLATE"
)
UNATTENDED_ARGS+=( --no-install-additions )
echo "   Base bootstrap: OpenSSH + Git + distro-supported virtualbox-guest-utils"
[ "$START_MODE" != none ] && UNATTENDED_ARGS+=( "--start-vm=$START_MODE" )
run_redacted VBoxManage unattended install "${UNATTENDED_ARGS[@]}"

cat <<NEXT

Next (matches the operator's real snapshot workflow):
  1) After the unattended install finishes + the guest reboots, copy provision-guest.sh into the guest and
     install LabVIEW 2026 Community (UNACTIVATED):        sudo ./provision-guest.sh
  1b) Make the box build lbabus itself on first boot:     sudo ./provision-lbabus-fromsource.sh
  2) Snapshot the clean pre-activation state:             VBoxManage snapshot "$VM_NAME" take labview2026-installed-preactivation
  3) OPERATOR activates LabVIEW Community (NI sign-in), then snapshot the activated state:
                                                          VBoxManage snapshot "$VM_NAME" take labview2026-activated-ready

WIN mirrors steps 1-3 on VMware — same guest spec + the SAME provision-guest.sh — see README.md.
NEXT
