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
# Per-milestone budget for the re-entry gate below. The procedure allows 5-15 min per node against a
# live chain; a milestone that has not been met by then is a fault, not slowness, so the roll stops.
REENTRY_TIMEOUT="${REENTRY_TIMEOUT:-600}"
# Signer count a healthy seal carries. MEASURED from the fleet before the roll, never guessed: it is
# n-f over the committee, so it changes with committee size (6 members => 5, 5 => 4) and a hardcoded
# number would either hang the gate on a healthy node or accept a seal that is short of quorum.
QUORUM="${QUORUM:-}"

declare -A NODE_IP=(
  [001]=154.38.160.39 [002]=62.171.157.44 [003]=161.97.86.81
  [004]=5.189.130.160 [005]=162.244.25.114 [006]=62.171.138.98
)
# 006 is a user-run super node: different container name and the default SSH port. It is in the
# consensus committee like the rest, so a fleet roll that skips it leaves the committee mixed-version.
declare -A NODE_CONTAINER=([006]=qnet-super-node)
declare -A NODE_PORT=([006]=22)
TARGETS=("$@"); [ ${#TARGETS[@]} -eq 0 ] && TARGETS=(001 002 003 004 005 006)

port_of() { echo "${NODE_PORT[$1]:-$SSH_PORT}"; }
container_of() { echo "${NODE_CONTAINER[$1]:-qnet-genesis-$1}"; }
rsh()  { ssh -i "$SSH_KEY" -p "$2" -o StrictHostKeyChecking=no -o ConnectTimeout=15 "root@$1" "$3"; }
# The recreate runs from a script fed on stdin, not from a quoted argument: nesting docker templates,
# grep patterns and shell quoting inside an ssh argument is how the first version of this broke.
rsh_script() { ssh -i "$SSH_KEY" -p "$2" -o StrictHostKeyChecking=no -o ConnectTimeout=15 "root@$1" "bash -s -- $3 $4 $5"; }

# Measure the healthy signer count once, from the first reachable node, unless it was given.
#
# Anchored to the SEAL line, and to " signers=" with the leading space. `signers=` is not unique:
# a rejected certificate logs `qc_rejected ... signers=3 committee=6 quorum=5` and `catchup_rejected
# ... signers=5 ... foreign_signers=0`, and `foreign_signers=0` CONTAINS the substring `signers=0`.
# An unanchored `grep -o` returns that last, so one rejected QC in the window measured the quorum as
# 0 - a non-empty string, so the emptiness guard passed - and every later `signers >= QUORUM` test
# was then vacuously true. The gate would have reported "measured" while checking nothing.
if [ -z "$QUORUM" ]; then
  for probe in "${TARGETS[@]}"; do
    pip="${NODE_IP[$probe]:-}"; [ -z "$pip" ] && continue
    QUORUM=$(rsh "$pip" "$(port_of "$probe")" \
      "docker logs $(container_of "$probe") --since 30m 2>&1 | grep macroblock_sealed | tail -1" 2>/dev/null \
      | sed -n 's/.* signers=\([0-9]*\).*/\1/p')
    [ -n "$QUORUM" ] && break
  done
fi
# A measurement that is not a plausible quorum is a broken measurement, not a small committee: n-f is
# at least 2 for any committee that can seal at all. Refuse to roll on it rather than disarm the gate.
case "$QUORUM" in
  ''|*[!0-9]*) echo "[ERR] could not measure the signer count of a healthy seal — pass QUORUM=<n> explicitly"; exit 1;;
esac
if [ "$QUORUM" -lt 2 ]; then
  echo "[ERR] measured signer count $QUORUM is below any real quorum — pass QUORUM=<n> explicitly"; exit 1
fi
echo "=== signer count for a healthy seal: $QUORUM (measured) ==="

for id in "${TARGETS[@]}"; do
  ip="${NODE_IP[$id]:-}"
  if [ -z "$ip" ]; then echo "[ERR] unknown node id: $id"; exit 1; fi
  port="$(port_of "$id")"; cont="$(container_of "$id")"
  echo "=== $id ($ip:$port $cont) ==="
  echo "  before: $(rsh "$ip" "$port" "curl -s -m 8 http://localhost:8001/healthz" 2>/dev/null || echo '<no answer>')"

  # Pull first: a registry that cannot be reached must not cost us a running node.
  if ! rsh "$ip" "$port" "docker pull -q $IMAGE >/dev/null && docker tag $IMAGE $LOCAL_TAG"; then
    echo "  [ERR] pull failed — node left untouched, roll stopped"; exit 1
  fi

  if ! rsh_script "$ip" "$port" "$cont" "$LOCAL_TAG" "${QNET_ROLLBACK_TO_LAST_SEALED:-}${QNET_ROLLBACK_TO_HEIGHT:+H$QNET_ROLLBACK_TO_HEIGHT}" <<'INNER'
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

  # ── Re-entry gate. The next node is not touched until this one is BACK IN CONSENSUS, not merely
  # answering. An ungated roll takes nodes out faster than they re-enter and the quorum margin
  # evaporates: at six members the quorum is five, so one node down is the whole margin.
  #
  #   1 RPC up            — replay finished
  #   2 converged         — gap to the network tip < 10
  #   3 finality re-entry — a macroblock seals ABOVE the restart height with a full-quorum signer set
  #   4 production re-entry — a rotation window passes with zero failovers
  ok=""
  for _ in $(seq 1 $((HEALTH_TIMEOUT/5))); do
    sleep 5
    a=$(rsh "$ip" "$port" "curl -s -m 5 http://localhost:8001/healthz" 2>/dev/null || true)
    case "$a" in ok*) ok="$a"; break;; esac
  done
  if [ -z "$ok" ]; then echo "  [ERR] $id did not answer within ${HEALTH_TIMEOUT}s — roll stopped"; exit 1; fi
  echo "  M1 rpc:      $ok"
  case "$ok" in *build=*) ;; *) echo "  [WARN] no build= in the answer: this image predates the build stamp";; esac

  restart_h=$(echo "$ok" | sed -n 's/.*h=\([0-9]*\).*/\1/p')

  # M2 — converged.
  conv=""
  for _ in $(seq 1 $((REENTRY_TIMEOUT/10))); do
    h=$(rsh "$ip" "$port" "curl -s -m 8 http://localhost:8001/api/v1/node/health" 2>/dev/null || true)
    local_h=$(echo "$h" | tr ',' '\n' | sed -n 's/.*"height":\([0-9]*\).*/\1/p' | head -1)
    net_h=$(echo "$h" | tr ',' '\n' | sed -n 's/.*"network_height":\([0-9]*\).*/\1/p' | head -1)
    # peers>0 as well: on an isolated node network_height falls back to the node's OWN height, so the
    # gap is 0 and "converged" would pass on a node that has not spoken to anyone.
    peers=$(echo "$h" | tr ',' '\n' | sed -n 's/.*"validated_peers":\([0-9]*\).*/\1/p' | head -1)
    if [ -n "$local_h" ] && [ -n "$net_h" ] && [ -n "$peers" ] \
       && [ "$peers" -gt 0 ] && [ $((net_h - local_h)) -lt 10 ]; then
      conv="$local_h/$net_h peers=$peers"; break
    fi
    sleep 10
  done
  if [ -z "$conv" ]; then echo "  [ERR] $id did not converge within ${REENTRY_TIMEOUT}s — roll stopped"; exit 1; fi
  echo "  M2 converged: gap<10 ($conv)"

  # M3 — finality re-entry. TWO signals, because a seal alone does not name its signers: the node
  # must have re-entered a checkpoint as a participating validator, and a window at or above that one
  # must have sealed with a full quorum, above the restart height. `role=replica` on a seal line only
  # says the node watched it happen; at six members with a quorum of five, a seal can exclude us.
  # The container is recreated, so its log starts empty — no line here predates the restart.
  seal=""
  for _ in $(seq 1 $((REENTRY_TIMEOUT/10))); do
    part=$(rsh "$ip" "$port" "docker logs $cont 2>&1 | grep 'validator=true' | tail -1" 2>/dev/null || true)
    pmb=$(echo "$part" | sed -n 's/.*mb=\([0-9]*\).*/\1/p')
    line=$(rsh "$ip" "$port" "docker logs $cont 2>&1 | grep macroblock_sealed | tail -1" 2>/dev/null || true)
    hh=$(echo "$line" | sed -n 's/.*head_h=\([0-9]*\).*/\1/p')
    sg=$(echo "$line" | sed -n 's/.*signers=\([0-9]*\).*/\1/p')
    sw=$(echo "$line" | sed -n 's/.*window=\([0-9]*\).*/\1/p')
    if [ -n "$hh" ] && [ -n "$sg" ] && [ -n "$sw" ] \
       && [ "$hh" -gt "${restart_h:-0}" ] && [ "$sg" -ge "$QUORUM" ] \
       && { [ -n "${REENTRY_SKIP_PARTICIPATION:-}" ] || { [ -n "$pmb" ] && [ "$sw" -ge "$pmb" ]; }; }; then
      seal="window=$sw head_h=$hh signers=$sg participated_mb=${pmb:-skipped}"; break
    fi
    sleep 10
  done
  if [ -z "$seal" ]; then
    echo "  [ERR] $id: no full-quorum seal above h=${restart_h:-?} that this node took part in, within ${REENTRY_TIMEOUT}s"
    echo "        (a node outside the consensus committee never logs validator=true — rerun with REENTRY_SKIP_PARTICIPATION=1)"
    echo "        roll stopped"; exit 1
  fi
  echo "  M3 finality:  $seal"

  # M4 — no failover in the last metrics window, and the node has advanced at least a rotation's worth
  # of blocks since it answered. That is what the metrics line proves; it does not single out this
  # node's own producer slot, so read it as "the fleet ran clean while this node was back", which is
  # the property the roll needs before taking the next node out.
  prod=""
  for _ in $(seq 1 $((REENTRY_TIMEOUT/10))); do
    m=$(rsh "$ip" "$port" "docker logs $cont --since 6m 2>&1 | grep '\[METRICS\]\[FAILOVER\]' | tail -1" 2>/dev/null || true)
    now_h=$(rsh "$ip" "$port" "curl -s -m 5 http://localhost:8001/healthz" 2>/dev/null | sed -n 's/.*h=\([0-9]*\).*/\1/p')
    case "$m" in
      *failover_events=0*max_timeout_round=0*|*max_timeout_round=0*failover_events=0*)
        if [ -n "$now_h" ] && [ $((now_h - ${restart_h:-0})) -ge 30 ]; then prod="$m"; break; fi;;
    esac
    sleep 10
  done
  if [ -z "$prod" ]; then
    echo "  [ERR] $id did not pass a clean rotation window within ${REENTRY_TIMEOUT}s — roll stopped"; exit 1
  fi
  echo "  M4 production: no failover, +$(( ${now_h:-0} - ${restart_h:-0} )) blocks since re-entry"
done

echo "=== rolled: ${TARGETS[*]} ==="
