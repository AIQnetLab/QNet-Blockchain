#!/usr/bin/env bash
# Rolling update of the genesis fleet, one node at a time.
#
# The workflow summary has always pointed here, but the file did not exist, and unlike
# install-super-node.sh the genesis installer never sets up Watchtower — so a pushed image sat in the
# registry while the fleet kept running the old binary with nothing to say so. This is that missing
# step, done deliberately rather than by an unattended poller: five consensus nodes updating
# themselves at once on a bad build is not a risk worth taking for convenience.
#
# Each container is recreated from its OWN inspect output, so seeds and API keys never leave the
# server and no option can be silently dropped. One node is taken down at a time and the next is not
# touched until the previous one answers.
#
#   ./deploy-genesis.sh                                  # all five, in order
#   ./deploy-genesis.sh 001 003                          # only these
#   QNET_ROLLBACK_TO_LAST_SEALED=1 ./deploy-genesis.sh   # recover to the last sealed macroblock
#   QNET_ROLLBACK_TO_HEIGHT=627483 ./deploy-genesis.sh   # or to an exact height
set -uo pipefail

IMAGE="ghcr.io/aiqnetlab/qnet-production:latest"
LOCAL_TAG="qnet-production"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/qnet_server}"
SSH_PORT="${SSH_PORT:-2222}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-240}"

declare -A NODE_IP=(
  [001]=154.38.160.39 [002]=62.171.157.44 [003]=161.97.86.81
  [004]=5.189.130.160 [005]=162.244.25.114
)
TARGETS=("$@"); [ ${#TARGETS[@]} -eq 0 ] && TARGETS=(001 002 003 004 005)

rsh()  { ssh -i "$SSH_KEY" -p "$SSH_PORT" -o StrictHostKeyChecking=no -o ConnectTimeout=15 "root@$1" "$2"; }
# The recreate runs from a script fed on stdin, not from a quoted argument: nesting docker templates,
# grep patterns and shell quoting inside an ssh argument is how the first version of this broke.
rsh_script() { ssh -i "$SSH_KEY" -p "$SSH_PORT" -o StrictHostKeyChecking=no -o ConnectTimeout=15 "root@$1" "bash -s -- $2 $3 $4"; }

for id in "${TARGETS[@]}"; do
  ip="${NODE_IP[$id]:-}"
  if [ -z "$ip" ]; then echo "[ERR] unknown genesis id: $id"; exit 1; fi
  echo "=== $id ($ip) ==="
  echo "  before: $(rsh "$ip" "curl -s -m 8 http://localhost:8001/healthz" 2>/dev/null || echo '<no answer>')"

  # Pull first: a registry that cannot be reached must not cost us a running node.
  if ! rsh "$ip" "docker pull -q $IMAGE >/dev/null && docker tag $IMAGE $LOCAL_TAG"; then
    echo "  [ERR] pull failed — node left untouched, roll stopped"; exit 1
  fi

  if ! rsh_script "$ip" "qnet-genesis-$id" "$LOCAL_TAG" "${QNET_ROLLBACK_TO_LAST_SEALED:-}${QNET_ROLLBACK_TO_HEIGHT:+H$QNET_ROLLBACK_TO_HEIGHT}" <<'INNER'
set -e
N="$1"; TAG="$2"; RECOVER="${3:-}"
docker inspect "$N" >/dev/null 2>&1 || { echo "no such container: $N"; exit 1; }

# Carry the container's env MINUS two kinds of entry that must not survive a roll:
#   QNET_ROLLBACK_*  one-shot recovery flags; carried forward they silently re-truncate every restart.
#   QNET_BUILD_ID    belongs to the IMAGE, not the container. Carried over it pins the OLD stamp on
#                    the new binary, so /healthz reports the build we just replaced — the stamp lies
#                    exactly where it is needed, and a roll cannot be told from a no-op.
ENVS=""
while IFS= read -r e; do
  case "$e" in ''|QNET_ROLLBACK_*|QNET_BUILD_ID=*) continue;; esac
  ENVS="$ENVS -e $(printf '%q' "$e")"
done < <(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$N")

case "$RECOVER" in
  H*) ENVS="$ENVS -e QNET_ROLLBACK_TO_HEIGHT=${RECOVER#H}" ;;
  ?*) ENVS="$ENVS -e QNET_ROLLBACK_TO_LAST_SEALED=$RECOVER" ;;
esac

BINDS=""
while IFS= read -r b; do [ -n "$b" ] && BINDS="$BINDS -v $(printf '%q' "$b")"; done \
  < <(docker inspect --format '{{range .HostConfig.Binds}}{{println .}}{{end}}' "$N")
PORTS=$(docker inspect --format '{{range $p, $c := .HostConfig.PortBindings}}{{range $c}}-p {{.HostPort}}:{{$p}} {{end}}{{end}}' "$N")
REST=$(docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$N")
LOGS=$(docker inspect --format '{{range $k, $v := .HostConfig.LogConfig.Config}}--log-opt {{$k}}={{$v}} {{end}}' "$N")

docker stop "$N" >/dev/null && docker rm "$N" >/dev/null
eval docker run -d --name "$N" --restart="${REST:-always}" $LOGS $ENVS $PORTS $BINDS "$TAG" >/dev/null
INNER
  then
    echo "  [ERR] recreate failed on $id — roll stopped, fix this node before continuing"; exit 1
  fi

  # Wait for it to answer. Never move on while a node is down.
  ok=""
  for _ in $(seq 1 $((HEALTH_TIMEOUT/5))); do
    sleep 5
    a=$(rsh "$ip" "curl -s -m 5 http://localhost:8001/healthz" 2>/dev/null || true)
    case "$a" in ok*) ok="$a"; break;; esac
  done
  if [ -z "$ok" ]; then echo "  [ERR] $id did not answer within ${HEALTH_TIMEOUT}s — roll stopped"; exit 1; fi
  echo "  after:  $ok"
  case "$ok" in *build=*) ;; *) echo "  [WARN] no build= in the answer: this image predates the build stamp";; esac
done

echo "=== rolled: ${TARGETS[*]} ==="
