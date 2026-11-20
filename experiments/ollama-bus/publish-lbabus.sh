#!/usr/bin/env bash
# Publish a SELF-CONTAINED, single-file lbabus so it runs in a BARE container with NO .NET runtime and NO
# downloads (WAN-free) -- the container mounts this binary and executes it directly. Mirrors the WIN plane's
# host-build + mount approach for the ollama-governed container coordinator (task cross-plane-ollama-bus).
#
# Usage: ./publish-lbabus.sh [rid]   (rid defaults to linux-x64; OUT env overrides the output dir)
set -uo pipefail
RID="${1:-linux-x64}"
OUT="${OUT:-$HOME/lba-net/publish}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

# The self-contained single-file binary is the pinned lbabus release asset (SHA-256 checked by the helper).
mkdir -p "$OUT"
case "$RID" in win-x64) EXE=lbabus.exe ;; *) EXE=lbabus ;; esac
node "$REPO/scripts/fetch-lbabus.mjs" binary --rid "$RID" --out "$OUT/$EXE" >/dev/null
echo "staged pinned self-contained lbabus ($RID) -> $OUT/$EXE"
