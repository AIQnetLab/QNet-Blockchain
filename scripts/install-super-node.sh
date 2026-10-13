#!/bin/bash
# ============================================================
# QNet Super Node — Install & Auto-Update Script
# ============================================================
# A super node is activated only with the QNet Wallet browser extension on a computer (Super, on the Activate tab of
# aiqnet.io/node or of the extension): the extension burns 1DEV from the wallet's own Solana address. The
# Overview of aiqnet.io/node then shows the activation code, the burn transaction and the burned amount for
# the wallet in any browser where it is connected (the extension keeps the code in its Settings). This server
# then runs the node with the same wallet's recovery phrase.
#
# Usage:
#   export QNET_ACTIVATION_CODE="QNET-SXXXXX-XXXXXX-XXXXXX"
#   export QNET_BURN_TX_HASH="<the Solana burn transaction signature>"
#   export QNET_BURN_AMOUNT="<the whole 1DEV amount burned>"
#   export QNET_WALLET_SEED_FILE=/path/to/qnet_seed     # a file holding the recovery phrase (preferred)
#   # or: export QNET_WALLET_SEED="word1 word2 ... word12"  (this script writes it to a 0600 file)
#   curl -fsSL https://raw.githubusercontent.com/AIQnetLab/QNet-Blockchain/testnet/scripts/install-super-node.sh | bash
#
# Options (after `bash -s --` when piped):
#   --no-public-rpc   do not publish port 443: the node serves no wallet reads (the public RPC)
#   --dry-run         check the settings and print what would run, change nothing
#
# What this does:
#   1. Installs Docker (if not present)
#   2. Pulls the latest qnet-production image from ghcr.io (public, no auth needed)
#   3. Starts your Super node, with the recovery phrase mounted as a file at /run/secrets/qnet_seed, and
#      publishes host port 443 for the public RPC (wallet reads over HTTPS) unless --no-public-rpc
#   4. Installs Watchtower — updates your node to each release once the genesis nodes run it
#      (checks every 5 minutes, zero-downtime rolling restart). It changes the image, never the port
#      mappings: an existing install re-runs this script once to publish 443.
# ============================================================

set -e

IMAGE="ghcr.io/aiqnetlab/qnet-production:latest"
WATCHTOWER_IMAGE="containrrr/watchtower"
# The genesis nodes, which tell a caller its public address (GET /api/v1/whoami).
GENESIS_NAMES="node1.aiqnet.io node2.aiqnet.io node3.aiqnet.io node4.aiqnet.io node5.aiqnet.io"

# ── Colours ─────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()  { echo -e "${RED}[ERR]${NC} $1"; exit 1; }

usage() {
  echo ""
  echo "Required before running (the Overview of aiqnet.io/node for this wallet shows the code,"
  echo "the burn and the amount):"
  echo ""
  echo "  export QNET_ACTIVATION_CODE=\"QNET-SXXXXX-XXXXXX-XXXXXX\""
  echo "  export QNET_BURN_TX_HASH=\"<the Solana burn transaction signature>\""
  echo "  export QNET_BURN_AMOUNT=\"<the whole 1DEV amount burned>\""
  echo "  export QNET_WALLET_SEED_FILE=/path/to/qnet_seed   # or QNET_WALLET_SEED=\"word1 ... word12\""
  echo ""
  echo "  bash install-super-node.sh [--no-public-rpc] [--dry-run]"
  echo ""
}

# ── Options ─────────────────────────────────────────────────
PUBLIC_RPC=1
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --no-public-rpc) PUBLIC_RPC=0 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; err "unknown option: $arg" ;;
  esac
done
# QNET_HIDE_IP keeps its meaning: no announced address, so no public RPC either.
if [ -n "${QNET_HIDE_IP:-}" ]; then
  PUBLIC_RPC=0
fi

# ── Required: code, burn and amount ─────────────────────────
[ -n "$QNET_ACTIVATION_CODE" ] || { usage; err "QNET_ACTIVATION_CODE is not set"; }
[ -n "$QNET_BURN_TX_HASH" ] || { usage; err "QNET_BURN_TX_HASH is not set"; }
case "$QNET_BURN_AMOUNT" in
  ''|*[!0-9]*) usage; err "QNET_BURN_AMOUNT must be the whole number of 1DEV burned";;
esac

# ── Optional settings ─────────────────────────────────────────
NODE_NAME="${QNET_NODE_NAME:-qnet-super-node}"
DATA_DIR="${QNET_DATA_DIR:-/opt/qnet/data}"
MAX_STORAGE_GB="${QNET_MAX_STORAGE_GB:-500}"

# ── Required: the wallet's recovery phrase, as a file only its owner can read ──
# The same wallet that burned in the extension: the node checks the code against this phrase's own Solana
# address. The phrase is passed as a file, never as an environment variable (docker inspect shows those).
if [ -n "$QNET_WALLET_SEED_FILE" ]; then
  [ -r "$QNET_WALLET_SEED_FILE" ] || err "QNET_WALLET_SEED_FILE=$QNET_WALLET_SEED_FILE is not a readable file"
  SEED_FILE="$QNET_WALLET_SEED_FILE"
elif [ -n "$QNET_WALLET_SEED" ]; then
  SEED_FILE="$(dirname "$DATA_DIR")/qnet_seed"
  if [ "$DRY_RUN" = 0 ]; then
    mkdir -p "$(dirname "$SEED_FILE")"
    (umask 077; printf %s "$QNET_WALLET_SEED" > "$SEED_FILE")
    ok "Recovery phrase written to $SEED_FILE"
  fi
else
  usage; err "QNET_WALLET_SEED_FILE (or QNET_WALLET_SEED) is not set"
fi
if [ "$DRY_RUN" = 0 ]; then
  chmod 600 "$SEED_FILE"
  SEED_FILE="$(cd "$(dirname "$SEED_FILE")" && pwd)/$(basename "$SEED_FILE")"
fi

# Whether something on this host already listens on TCP 443 (unknown counts as free).
port_443_in_use() {
  if command -v ss &>/dev/null; then
    ss -Htln 'sport = :443' 2>/dev/null | grep -q .
  elif command -v netstat &>/dev/null; then
    netstat -tln 2>/dev/null | awk '{print $4}' | grep -Eq '[:.]443$'
  else
    return 1
  fi
}

# Whether this node's own container is what holds 443: a re-run replaces it before the start, so a dry
# run must not read its mapping as the port being taken.
own_node_holds_443() {
  command -v docker &>/dev/null && docker port "$NODE_NAME" 8443/tcp 2>/dev/null | grep -Eq ':443$'
}

# Whether another container publishes host 443. Without the container runtime's userland proxy such a
# mapping has no listening socket on the host, so the socket check alone would miss it.
other_container_holds_443() {
  command -v docker &>/dev/null || return 1
  docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | awk -v me="$NODE_NAME" '$1 != me && /:443->/ { found = 1 } END { exit !found }'
}

# Whether $1 is a public unicast IPv4 in canonical form: the ranges the node itself refuses as its
# address (this network, private, shared, loopback, link-local, protocol, documentation, relay,
# benchmark, multicast and reserved) are not.
is_public_ipv4() {
  local o='(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])'
  [[ "$1" =~ ^$o\.$o\.$o\.$o$ ]] || return 1
  local a=${BASH_REMATCH[1]} b=${BASH_REMATCH[2]} c=${BASH_REMATCH[3]}
  case "$a" in 0|10|127) return 1 ;; esac
  [ "$a" -ge 224 ] && return 1
  [ "$a" = 100 ] && [ "$b" -ge 64 ] && [ "$b" -le 127 ] && return 1
  [ "$a" = 169 ] && [ "$b" = 254 ] && return 1
  [ "$a" = 172 ] && [ "$b" -ge 16 ] && [ "$b" -le 31 ] && return 1
  [ "$a" = 192 ] && [ "$b" = 0 ] && { [ "$c" = 0 ] || [ "$c" = 2 ]; } && return 1
  [ "$a" = 192 ] && [ "$b" = 88 ] && [ "$c" = 99 ] && return 1
  [ "$a" = 192 ] && [ "$b" = 168 ] && return 1
  [ "$a" = 198 ] && { [ "$b" = 18 ] || [ "$b" = 19 ]; } && return 1
  [ "$a" = 198 ] && [ "$b" = 51 ] && [ "$c" = 100 ] && return 1
  [ "$a" = 203 ] && [ "$b" = 0 ] && [ "$c" = 113 ] && return 1
  return 0
}

# This server's public IPv4 once two genesis nodes agree on it, else nothing. Each is asked by its
# name, then on its plain port when the name's terminator hides the caller (the answer is not public).
genesis_public_ip() {
  local seen="" name url ip
  for name in $GENESIS_NAMES; do
    for url in "https://$name/api/v1/whoami" "http://$name:8001/api/v1/whoami"; do
      ip=$(curl -4 -fsS --max-time 5 "$url" 2>/dev/null | sed -n 's/.*"ip":"\([0-9.]*\)".*/\1/p')
      if is_public_ipv4 "$ip"; then
        case " $seen " in *" $ip "*) echo "$ip"; return 0 ;; esac
        seen="$seen $ip"
        break
      fi
    done
  done
  return 1
}

public_rpc_notice() {
  echo ""
  echo "Public RPC: this server answers wallet reads on https://<this server's IPv4>. Its certificate"
  echo "comes from a public certificate authority for this IP address and renews itself. Publishing"
  echo "port 443 accepts that authority's subscriber terms."
  echo "  - Inbound TCP 443 must be reachable from the whole internet (the authority checks it from"
  echo "    several places; no geo-blocking)."
  echo "  - Outbound TCP 443 to the authority must stay open (its addresses are not published)."
  echo "  - A certificate lasts about 6.7 days and is renewed about every 80 hours; the first one is"
  echo "    requested within about 6 hours of the first start."
  echo "  - To turn it off: re-run with --no-public-rpc."
  echo ""
}

# ── 1. Install Docker ────────────────────────────────────────
if [ "$DRY_RUN" = 0 ]; then
  if ! command -v docker &>/dev/null; then
    warn "Docker not found — installing..."
    curl -fsSL https://get.docker.com | sh
    ok "Docker installed"
  else
    ok "Docker already installed ($(docker --version))"
  fi

  # ── 2. Create data directory ───────────────────────────────
  mkdir -p "$DATA_DIR"
  ok "Data dir: $DATA_DIR"

  # ── 3. Pull latest image ───────────────────────────────────
  echo "Pulling $IMAGE ..."
  docker pull "$IMAGE"
  ok "Image pulled"
fi

# ── 4. Public RPC: is 443 another container's? ───────────────
# Asked while the running node is still up: once it is removed, a failed start would leave none.
if [ "$PUBLIC_RPC" = 1 ] && other_container_holds_443; then
  warn "public RPC off: port 443 is in use (published by another container)"
  PUBLIC_RPC=0
fi

if [ "$DRY_RUN" = 0 ]; then
  # ── 5. Stop existing container (if any) ───────────────────
  docker stop "$NODE_NAME" 2>/dev/null && docker rm "$NODE_NAME" 2>/dev/null || true
fi

# ── 6. Public RPC: port 443 on the host ──────────────────────
# Checked after the old container is gone, so a re-run does not find its own mapping.
if [ "$PUBLIC_RPC" = 1 ] && port_443_in_use && ! { [ "$DRY_RUN" = 1 ] && own_node_holds_443; }; then
  warn "public RPC off: port 443 is in use"
  PUBLIC_RPC=0
fi
if [ "$PUBLIC_RPC" = 1 ]; then
  public_rpc_notice
  if [ "$DRY_RUN" = 0 ]; then
    if command -v ufw &>/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
      ufw allow 443/tcp >/dev/null && ok "Firewall: 443/tcp open (ufw)"
    elif command -v firewall-cmd &>/dev/null && firewall-cmd --state &>/dev/null; then
      firewall-cmd --permanent --add-port=443/tcp >/dev/null && firewall-cmd --reload >/dev/null && ok "Firewall: 443/tcp open (firewalld)"
    fi
  fi
fi

# ── 7. Start Super node ──────────────────────────────────────
RUN_ARGS=(
  -d
  --name "$NODE_NAME"
  --restart=always
  --log-opt max-size=100m
  --log-opt max-file=10
  -e QNET_PRODUCTION=1
  -e DOCKER_ENV=1
  -e QNET_ACTIVATION_CODE="$QNET_ACTIVATION_CODE"
  -e QNET_BURN_TX_HASH="$QNET_BURN_TX_HASH"
  -e QNET_BURN_AMOUNT="$QNET_BURN_AMOUNT"
  -v "$SEED_FILE":/run/secrets/qnet_seed:ro
  -e QNET_WALLET_SEED_FILE=/run/secrets/qnet_seed
  -e QNET_MAX_STORAGE_GB="$MAX_STORAGE_GB"
  -p 9876:9876
  -p 9877:9877
  # IPv4 only: an IPv6 client would reach it through the container runtime's proxy, which hides its
  # address and lets a header it wrote pass for the client.
  -p 0.0.0.0:8001:8001
  -p 10876:10876/udp
)
if [ -n "${QNET_HIDE_IP:-}" ]; then
  RUN_ARGS+=(-e QNET_HIDE_IP=1)
fi
# IPv4 on every interface, so the node sees each wallet's own address.
PUBLIC_RPC_ARGS=()
if [ "$PUBLIC_RPC" = 1 ]; then
  PUBLIC_RPC_ARGS=(-p 0.0.0.0:443:8443)
fi
VOLUME_ARGS=(-v "$DATA_DIR":/app/data "$IMAGE")

if [ "$DRY_RUN" = 1 ]; then
  echo "dry run: public_rpc=$PUBLIC_RPC"
  echo "dry run: docker run ${RUN_ARGS[*]} ${PUBLIC_RPC_ARGS[*]} ${VOLUME_ARGS[*]}"
  exit 0
fi

if ! docker run "${RUN_ARGS[@]}" "${PUBLIC_RPC_ARGS[@]}" "${VOLUME_ARGS[@]}"; then
  # A 443 mapping the checks above could not see (another container took it meanwhile): start the
  # node without the public RPC rather than leave the server with no node at all.
  [ "$PUBLIC_RPC" = 1 ] || err "the node did not start"
  warn "public RPC off: the start with port 443 failed; starting without it"
  PUBLIC_RPC=0
  docker rm -f "$NODE_NAME" >/dev/null 2>&1 || true
  docker run "${RUN_ARGS[@]}" "${VOLUME_ARGS[@]}" || err "the node did not start"
fi

ok "Super node '$NODE_NAME' started"

# ── 8. Install Watchtower (auto-updates) ─────────────────────
# Watchtower polls ghcr.io every 5 min and restarts the container when :latest moves,
# which happens only after the genesis nodes run that release (not on every push)
docker stop watchtower 2>/dev/null && docker rm watchtower 2>/dev/null || true

docker run -d \
  --name watchtower \
  --restart=always \
  -v /var/run/docker.sock:/var/run/docker.sock \
  "$WATCHTOWER_IMAGE" \
  --interval 300 \
  --cleanup \
  "$NODE_NAME"

ok "Watchtower installed — it checks every 5 min and takes each release once the genesis nodes run it"

# ── 9. Health check ──────────────────────────────────────────
echo ""
echo "Waiting for node to start..."
sleep 20
for i in $(seq 1 6); do
  H=$(curl -sf http://127.0.0.1:8001/api/v1/height 2>/dev/null) || H=""
  if [ -n "$H" ]; then
    ok "Node is UP: $H"
    break
  fi
  echo "  attempt $i/6, waiting 10s..."; sleep 10
done

# ── 10. Public RPC check ────────────────────────────────────
PUBLIC_RPC_LINE="off"
if [ "$PUBLIC_RPC" = 1 ]; then
  PUBLIC_IP=$(genesis_public_ip) || PUBLIC_IP=""
  if [ -s "$DATA_DIR/wallet_tls/cert.pem" ] && [ -n "$PUBLIC_IP" ]; then
    # A re-run with a certificate held: it is served moments after the start.
    PUBLIC_RPC_LINE="not answering yet"
    deadline=$((SECONDS + 180))
    while [ "$SECONDS" -lt "$deadline" ]; do
      if curl -fsS --max-time 5 "https://$PUBLIC_IP/healthz" >/dev/null 2>&1; then
        PUBLIC_RPC_LINE="https://$PUBLIC_IP"
        ok "Public RPC: https://$PUBLIC_IP"
        break
      fi
      sleep 5
    done
    if [ "$PUBLIC_RPC_LINE" != "https://$PUBLIC_IP" ]; then
      warn "Public RPC: not answering yet. The node's latest public RPC lines:"
      docker logs --tail 2000 "$NODE_NAME" 2>&1 | grep -E '\[(WALLETRPC|WALLETTLS)\]' | tail -5 || true
    fi
  else
    # A first start: the first certificate is requested at a random time within about 6 hours.
    PUBLIC_RPC_LINE="pending (the first certificate comes within about 6 hours)"
    echo "Public RPC: pending. The first certificate is requested within about 6 hours of this start,"
    echo "spread so that nodes do not all ask at once; nothing needs doing meanwhile."
  fi
  echo "Check it with: curl https://${PUBLIC_IP:-<public IPv4 of this server>}/healthz"
fi

# ── Summary ──────────────────────────────────────────────────
echo ""
echo "============================================"
echo "  QNet Blockchain super node installed successfully"
echo "============================================"
echo "  Container : $NODE_NAME"
echo "  Data dir  : $DATA_DIR"
echo "  Phrase    : $SEED_FILE (mode 600)"
echo "  API       : http://127.0.0.1:8001/api/v1/height"
echo "  Public RPC: $PUBLIC_RPC_LINE"
echo "  Logs      : docker logs -f $NODE_NAME"
echo "  Updates   : automatic via Watchtower, each release once the genesis nodes run it"
echo "============================================"
echo ""
echo "The node registers itself once it has caught up with the chain; the Overview of aiqnet.io/node"
echo "then shows it for this wallet. One wallet runs one node: if this wallet already has another node,"
echo "the log says wallet_has_node and nothing is registered."
echo ""
