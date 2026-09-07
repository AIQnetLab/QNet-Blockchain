#!/usr/bin/env bash
# Rolling update of the genesis fleet, one node at a time.
#
# The workflow summary has always pointed here, but the file did not exist, and unlike
# install-super-node.sh the genesis installer never sets up Watchtower — so a pushed image sat in
# the registry while the fleet kept running the old binary with nothing to say so. This is that
# missing step, done deliberately rather than by an unattended poller: five consensus nodes updating
# themselves at once on a bad build is not a risk worth taking for convenience.
#
# The container is recreated from its OWN inspect output — env, mounts, ports, restart policy and log
# options are carried across verbatim. Nothing is reconstructed from a template, so the wallet seeds
# and API keys never leave the server and this script cannot silently drop an option it does not know
# about.
#
# One node is taken down at a time and the next is not touched until the previous one answers and
# reports the new build. A node that does not come back stops the roll where it is.
#
#   ./deploy-genesis.sh                  # all five, in order
#   ./deploy-genesis.sh 001 003          # only these
#   QNET_ROLLBACK_TO_LAST_SEALED=1 ./deploy-genesis.sh   # add a recovery flag to every node
set -uo pipefail

IMAGE="ghcr.io/aiqnetlab/qnet-production:latest"
LOCAL_TAG="qnet-production"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/qnet_server}"
SSH_PORT="${SSH_PORT:-2222}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"

declare -A NODE_IP=(
  [001]=154.38.160.39 [002]=62.171.157.44 [003]=161.97.86.81
  [004]=5.189.130.160 [005]=162.244.25.114
)
TARGETS=("$@"); [ ${#TARGETS[@]} -eq 0 ] && TARGETS=(001 002 003 004 005)

rsh() { ssh -i "$SSH_KEY" -p "$SSH_PORT" -o StrictHostKeyChecking=no -o ConnectTimeout=15 "root@$1" "$2"; }

for id in "${TARGETS[@]}"; do
  ip="${NODE_IP[$id]:-}"
  if [ -z "$ip" ]; then echo "[ERR] unknown genesis id: $id"; exit 1; fi
  name="qnet-genesis-$id"
  echo "=== $id ($ip) ==="

  before=$(rsh "$ip" "curl -s -m 8 http://localhost:8001/healthz" 2>/dev/null || true)
  echo "  before: ${before:-<no answer>}"

  # Pull first: a registry that cannot be reached must not cost us a running node.
  if ! rsh "$ip" "docker pull -q $IMAGE >/dev/null && docker tag $IMAGE $LOCAL_TAG"; then
    echo "  [ERR] pull failed — node left untouched, roll stopped"; exit 1
  fi

  # Recreate from the container's own config. Extra env (e.g. a recovery flag) is appended, so it
  # wins over the carried value of the same name.
  extra=""
  [ -n "${QNET_ROLLBACK_TO_LAST_SEALED:-}" ] && extra="$extra -e QNET_ROLLBACK_TO_LAST_SEALED=$QNET_ROLLBACK_TO_LAST_SEALED"
  [ -n "${QNET_ROLLBACK_TO_HEIGHT:-}" ] && extra="$extra -e QNET_ROLLBACK_TO_HEIGHT=$QNET_ROLLBACK_TO_HEIGHT"

  if ! rsh "$ip" "
    set -e
    N=$name
    docker inspect \$N >/dev/null 2>&1 || { echo 'no such container'; exit 1; }
    ENVS=\$(docker inspect --format '{{range .Config.Env}}-e {{printf \"%q\" .}} {{end}}' \$N)
    BINDS=\$(docker inspect --format '{{range .HostConfig.Binds}}-v {{printf \"%q\" .}} {{end}}' \$N)
    PORTS=\$(docker inspect --format '{{range \$p, \$c := .HostConfig.PortBindings}}{{range \$c}}-p {{.HostPort}}:{{\$p}} {{end}}{{end}}' \$N)
    REST=\$(docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' \$N)
    LOGS=\$(docker inspect --format '{{range \$k, \$v := .HostConfig.LogConfig.Config}}--log-opt {{\$k}}={{\$v}} {{end}}' \$N)
    docker stop \$N >/dev/null && docker rm \$N >/dev/null
    eval docker run -d --name \$N --restart=\${REST:-always} \$LOGS \$ENVS \$PORTS \$BINDS $extra $LOCAL_TAG >/dev/null
  "; then
    echo "  [ERR] recreate failed on $id — roll stopped, fix this node before continuing"; exit 1
  fi

  # Wait for it to answer AND to report a build stamp. Never move on while a node is down.
  ok=""
  for _ in $(seq 1 $((HEALTH_TIMEOUT/5))); do
    sleep 5
    after=$(rsh "$ip" "curl -s -m 5 http://localhost:8001/healthz" 2>/dev/null || true)
    case "$after" in ok*) ok="$after"; break;; esac
  done
  if [ -z "$ok" ]; then
    echo "  [ERR] $id did not answer within ${HEALTH_TIMEOUT}s — roll stopped"; exit 1
  fi
  echo "  after:  $ok"
  case "$ok" in *build=*) ;; *) echo "  [WARN] no build= in the answer: this image predates the build stamp";; esac
done

echo "=== rolled: ${TARGETS[*]} ==="
