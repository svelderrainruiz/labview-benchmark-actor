#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo 'usage: provision-autonomous-linux-actor.sh --host IP --actor-id ID --requester-keys FILE --source-commit SHA --source-tree SHA --bundle-sha256 SHA [--ssh-key FILE] [--tcp-port PORT]' >&2
  exit 2
}

HOST=''
ACTOR_ID=''
REQUESTER_KEYS=''
SOURCE_COMMIT=''
SOURCE_TREE=''
BUNDLE_SHA256=''
SSH_KEY="${HOME}/.ssh/lba-autonomous-provisioning-ed25519"
TCP_PORT=7430
while (($#)); do
  case "$1" in
    --host) HOST="${2:-}"; shift 2 ;;
    --actor-id) ACTOR_ID="${2:-}"; shift 2 ;;
    --requester-keys) REQUESTER_KEYS="${2:-}"; shift 2 ;;
    --source-commit) SOURCE_COMMIT="${2:-}"; shift 2 ;;
    --source-tree) SOURCE_TREE="${2:-}"; shift 2 ;;
    --bundle-sha256) BUNDLE_SHA256="${2:-}"; shift 2 ;;
    --ssh-key) SSH_KEY="${2:-}"; shift 2 ;;
    --tcp-port) TCP_PORT="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

[[ -n "$HOST" && "$ACTOR_ID" =~ ^[A-Za-z0-9._-]+$ ]] || usage
[[ -f "$REQUESTER_KEYS" && -f "$SSH_KEY" ]] || usage
[[ "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ && "$SOURCE_TREE" =~ ^[0-9a-f]{40}$ ]] || usage
[[ "$BUNDLE_SHA256" =~ ^[0-9a-f]{64}$ && "$TCP_PORT" =~ ^[0-9]+$ ]] || usage

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SSH=(ssh -i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "actor@${HOST}")
SCP=(scp -q -i "$SSH_KEY" -o BatchMode=yes)
REMOTE_STAGE="/tmp/lba-autonomous-actor-${ACTOR_ID}"
FILES=(
  experiments/acg-provenance/attest.mjs
  experiments/acg-quorum/compare-witnesses.mjs
  experiments/activation/buildActivationReceipt.mjs
  experiments/activation/probe-activation.sh
  experiments/mesh-fulfillment/autonomousActorProtocol.mjs
  experiments/mesh-fulfillment/autonomousActorService.mjs
  experiments/mesh-fulfillment/autonomousActorDaemon.mjs
  experiments/mesh-fulfillment/runLabviewKnownAnswer.mjs
)

"${SSH[@]}" "test \"\$(node --version)\" = v24.19.0 && test -x /usr/local/bin/lbabus"
"${SSH[@]}" "rm -rf '$REMOTE_STAGE' && mkdir -p '$REMOTE_STAGE/experiments/acg-provenance' '$REMOTE_STAGE/experiments/acg-quorum' '$REMOTE_STAGE/experiments/activation' '$REMOTE_STAGE/experiments/mesh-fulfillment'"
for relative in "${FILES[@]}"; do
  "${SCP[@]}" "$REPO_ROOT/$relative" "actor@${HOST}:${REMOTE_STAGE}/${relative}"
done
"${SCP[@]}" "$REQUESTER_KEYS" "actor@${HOST}:${REMOTE_STAGE}/requesters.json"

CONFIG=$(node -e 'const [actorId,commit,tree,bundle,port]=process.argv.slice(1); process.stdout.write(JSON.stringify({schema:"labview-benchmark-actor/autonomous-actor-service-config@1",actorId,plane:"LINUX",privateKeyPath:"/var/lib/lba-autonomous-actor/actor-private.pem",requesterKeysPath:"/etc/lba-autonomous-actor/requesters.json",expectedCandidate:{sourceCommit:commit,sourceTree:tree,bundleSha256:bundle},statePath:"/var/lib/lba-autonomous-actor/state.json",artifactDir:"/var/lib/lba-autonomous-actor/cas",workloads:{"labviewcli-known-answer-v1":{executable:"/usr/local/bin/node",args:["/opt/lba-autonomous-actor/experiments/mesh-fulfillment/runLabviewKnownAnswer.mjs"],timeoutMs:300000}},bus:{lbabusPath:"/usr/local/bin/lbabus",logPath:"/var/lib/lba-autonomous-actor/bus.jsonl",cursorPath:"/var/lib/lba-autonomous-actor/cursor.json",runtimeDir:"/var/lib/lba-autonomous-actor/run",hosts:"192.168.56.1",tcpPort:Number(port),bind:"0.0.0.0",session:"autonomous-n3",pollMs:250}},null,2)+"\n")' "$ACTOR_ID" "$SOURCE_COMMIT" "$SOURCE_TREE" "$BUNDLE_SHA256" "$TCP_PORT")
UNIT='[Unit]
Description=LabVIEW Benchmark Autonomous Actor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=actor
Group=actor
WorkingDirectory=/home/actor
ExecStart=/usr/local/bin/node /opt/lba-autonomous-actor/experiments/mesh-fulfillment/autonomousActorDaemon.mjs --config /etc/lba-autonomous-actor/actor.json
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/lba-autonomous-actor /home/actor /tmp /usr/local/natinst/share/nilvcli

[Install]
WantedBy=multi-user.target'

printf '%s' "$CONFIG" | "${SSH[@]}" "cat > '$REMOTE_STAGE/actor.json'"
printf '%s\n' "$UNIT" | "${SSH[@]}" "cat > '$REMOTE_STAGE/lba-autonomous-actor.service'"
"${SSH[@]}" "set -eu
  sudo systemctl stop lba-autonomous-actor.service 2>/dev/null || true
  sudo rm -rf /opt/lba-autonomous-actor
  sudo mv '$REMOTE_STAGE' /opt/lba-autonomous-actor
  sudo install -d -o actor -g actor -m 700 /var/lib/lba-autonomous-actor
  if [[ ! -s /var/lib/lba-autonomous-actor/actor-private.pem ]]; then
    sudo -u actor /usr/local/bin/node -e \"const{generateKeyPairSync}=require('node:crypto'),{writeFileSync}=require('node:fs');const{k}= {k:generateKeyPairSync('ed25519')};writeFileSync('/var/lib/lba-autonomous-actor/actor-private.pem',k.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});writeFileSync('/var/lib/lba-autonomous-actor/actor-public.pem',k.publicKey.export({type:'spki',format:'pem'}),{mode:0o644})\"
  fi
  sudo install -d -m 755 /etc/lba-autonomous-actor
  sudo install -o root -g actor -m 640 /opt/lba-autonomous-actor/actor.json /etc/lba-autonomous-actor/actor.json
  sudo install -o root -g actor -m 640 /opt/lba-autonomous-actor/requesters.json /etc/lba-autonomous-actor/requesters.json
  sudo install -o root -g root -m 644 /opt/lba-autonomous-actor/lba-autonomous-actor.service /etc/systemd/system/lba-autonomous-actor.service
  sudo systemctl daemon-reload
  sudo systemctl enable --now lba-autonomous-actor.service
  timeout 10 bash -c \"until [[ \\\"\\\$(systemctl is-active lba-autonomous-actor.service)\\\" = active ]] && ss -ltn | grep -q ':${TCP_PORT} '; do systemctl show lba-autonomous-actor.service >/dev/null; done\"
  rm -f /opt/lba-autonomous-actor/actor.json /opt/lba-autonomous-actor/requesters.json /opt/lba-autonomous-actor/lba-autonomous-actor.service"

"${SSH[@]}" "printf 'actor=%s node=%s service=%s key=' '$ACTOR_ID' \"\$(node --version)\" \"\$(systemctl is-active lba-autonomous-actor.service)\"; sha256sum /var/lib/lba-autonomous-actor/actor-public.pem | cut -d' ' -f1"