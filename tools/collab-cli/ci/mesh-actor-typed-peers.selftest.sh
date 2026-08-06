#!/usr/bin/env bash
# Regression test for mixed source/sink/both mesh peer routing. No containers or network are required.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
worker="$here/mesh-actor.sh"
vagrantfile="$here/../../../cleanroom/ubuntu-labview/mesh/Vagrantfile"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fake="$tmp/lbabus"
cat > "$fake" <<'FAKE'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "${LBA_FAKE_TRACE:?}"
if [ "$1" = "net" ] && [ "$2" = "listen" ]; then
  case " $* " in
    *" --tcp "*) printf 'TCP 192.168.56.11 [now] source #1 CLAIM task:mesh - hello\n' ;;
    *" --udp "*) printf 'UDP 192.168.56.11 [now] source #1 CLAIM task:mesh - hello\n' ;;
  esac
fi
FAKE
chmod +x "$fake"

source_trace="$tmp/source.trace"
LBA_FAKE_TRACE="$source_trace" LBABUS="$fake" VIHS_COLLAB_AGENT=source NODE_TYPE=source \
  MESH_PEERS=source,sink1,sink2 MESH_LISTENERS=sink1,sink2 MESH_EMITTERS= \
  TIMEOUT_SEC=2 UDP_TIMEOUT_SEC=2 SEND_RETRIES=1 SEND_RETRY_MS=1 UDP_BEACONS=1 MESH_OBSERVERS= \
  bash "$worker" >/dev/null
grep -q '^net send --hosts sink1,sink2 ' "$source_trace"

both_trace="$tmp/both.trace"
LBA_FAKE_TRACE="$both_trace" LBABUS="$fake" VIHS_COLLAB_AGENT=both NODE_TYPE=both \
  MESH_PEERS=source,both,sink MESH_LISTENERS=sink MESH_EMITTERS=source \
  TIMEOUT_SEC=2 UDP_TIMEOUT_SEC=2 SEND_RETRIES=1 SEND_RETRY_MS=1 UDP_BEACONS=1 MESH_OBSERVERS= \
  bash "$worker" >/dev/null
grep -q '^net listen --tcp 7420 --echo --count 1 ' "$both_trace"
grep -q '^net send --hosts sink ' "$both_trace"

no_emitter_trace="$tmp/no-emitter.trace"
LBA_FAKE_TRACE="$no_emitter_trace" LBABUS="$fake" VIHS_COLLAB_AGENT=both NODE_TYPE=both \
  MESH_PEERS=both,sink MESH_LISTENERS=sink MESH_EMITTERS= \
  TIMEOUT_SEC=2 UDP_TIMEOUT_SEC=2 SEND_RETRIES=1 SEND_RETRY_MS=1 UDP_BEACONS=1 MESH_OBSERVERS= \
  bash "$worker" >/dev/null
if grep -q '^net listen ' "$no_emitter_trace"; then
  echo 'typed mesh worker waited for a sink-only peer' >&2
  exit 1
fi
grep -q '^net send --hosts sink ' "$no_emitter_trace"

grep -Fq 'Environment=MESH_LISTENERS=#{listeners}' "$vagrantfile"
grep -Fq 'Environment=MESH_EMITTERS=#{emitters}' "$vagrantfile"
grep -Fq 'def normalized_mesh_node_type(actor)' "$vagrantfile"
grep -Fq 'normalized_mesh_node_type(x)' "$vagrantfile"
echo 'mesh-actor typed-peer selftest: 3/3 passed'