#!/bin/bash
# ============================================================
# QNet Super Node — Install & Auto-Update Script
# ============================================================
# A super node is activated only in the QNet browser extension on a computer (Activate tab, Super): the
# extension burns 1DEV from the wallet's own Solana address and shows the activation code, the burn
# transaction and the burned amount. The Overview of aiqnet.io/node shows the same three for the wallet in
# any browser where it is connected. This server then runs the node with the same wallet's recovery phrase.
#
# Usage:
#   export QNET_ACTIVATION_CODE="QNET-SXXXXX-XXXXXX-XXXXXX"
#   export QNET_BURN_TX_HASH="<the Solana burn transaction signature>"
#   export QNET_BURN_AMOUNT="<the whole 1DEV amount burned>"
#   export QNET_WALLET_SEED_FILE=/path/to/qnet_seed     # a file holding the recovery phrase (preferred)
#   # or: export QNET_WALLET_SEED="word1 word2 ... word12"  (this script writes it to a 0600 file)
#   curl -fsSL https://raw.githubusercontent.com/AIQnetLab/QNet-Blockchain/testnet/scripts/install-super-node.sh | bash
#
# What this does:
#   1. Installs Docker (if not present)
#   2. Pulls the latest qnet-production image from ghcr.io (public, no auth needed)
#   3. Starts your Super node, with the recovery phrase mounted as a file at /run/secrets/qnet_seed
#   4. Installs Watchtower — auto-updates your node when we push a new release
#      (checks every 5 minutes, zero-downtime rolling restart)
# ============================================================

set -e

IMAGE="ghcr.io/aiqnetlab/qnet-production:latest"
WATCHTOWER_IMAGE="containrrr/watchtower"

# ── Colours ─────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()  { echo -e "${RED}[ERR]${NC} $1"; exit 1; }

usage() {
  echo ""
  echo "Required before running (the QNet browser extension's Activate tab, or the Overview of"
  echo "aiqnet.io/node for this wallet, shows the code, the burn and the amount):"
  echo ""
  echo "  export QNET_ACTIVATION_CODE=\"QNET-SXXXXX-XXXXXX-XXXXXX\""
  echo "  export QNET_BURN_TX_HASH=\"<the Solana burn transaction signature>\""
  echo "  export QNET_BURN_AMOUNT=\"<the whole 1DEV amount burned>\""
  echo "  export QNET_WALLET_SEED_FILE=/path/to/qnet_seed   # or QNET_WALLET_SEED=\"word1 ... word12\""
  echo ""
  echo "  bash install-super-node.sh"
  echo ""
}

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
  mkdir -p "$(dirname "$SEED_FILE")"
  (umask 077; printf %s "$QNET_WALLET_SEED" > "$SEED_FILE")
  ok "Recovery phrase written to $SEED_FILE"
else
  usage; err "QNET_WALLET_SEED_FILE (or QNET_WALLET_SEED) is not set"
fi
chmod 600 "$SEED_FILE"
SEED_FILE="$(cd "$(dirname "$SEED_FILE")" && pwd)/$(basename "$SEED_FILE")"

# ── 1. Install Docker ────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  warn "Docker not found — installing..."
  curl -fsSL https://get.docker.com | sh
  ok "Docker installed"
else
  ok "Docker already installed ($(docker --version))"
fi

# ── 2. Create data directory ─────────────────────────────────
mkdir -p "$DATA_DIR"
ok "Data dir: $DATA_DIR"

# ── 3. Pull latest image ─────────────────────────────────────
echo "Pulling $IMAGE ..."
docker pull "$IMAGE"
ok "Image pulled"

# ── 4. Stop existing container (if any) ─────────────────────
docker stop "$NODE_NAME" 2>/dev/null && docker rm "$NODE_NAME" 2>/dev/null || true

# ── 5. Start Super node ──────────────────────────────────────
docker run -d \
  --name "$NODE_NAME" \
  --restart=always \
  --log-opt max-size=100m \
  --log-opt max-file=10 \
  -e QNET_PRODUCTION=1 \
  -e DOCKER_ENV=1 \
  -e QNET_ACTIVATION_CODE="$QNET_ACTIVATION_CODE" \
  -e QNET_BURN_TX_HASH="$QNET_BURN_TX_HASH" \
  -e QNET_BURN_AMOUNT="$QNET_BURN_AMOUNT" \
  -v "$SEED_FILE":/run/secrets/qnet_seed:ro \
  -e QNET_WALLET_SEED_FILE=/run/secrets/qnet_seed \
  -e QNET_MAX_STORAGE_GB="$MAX_STORAGE_GB" \
  -p 9876:9876 \
  -p 9877:9877 \
  -p 8001:8001 \
  -p 10876:10876/udp \
  -v "$DATA_DIR":/app/data \
  "$IMAGE"

ok "Super node '$NODE_NAME' started"

# ── 6. Install Watchtower (auto-updates) ─────────────────────
# Watchtower polls ghcr.io every 5 min and restarts the container
# when a new :latest image is published (after every git push to testnet)
docker stop watchtower 2>/dev/null && docker rm watchtower 2>/dev/null || true

docker run -d \
  --name watchtower \
  --restart=always \
  -v /var/run/docker.sock:/var/run/docker.sock \
  "$WATCHTOWER_IMAGE" \
  --interval 300 \
  --cleanup \
  "$NODE_NAME"

ok "Watchtower installed — node auto-updates every 5 min"

# ── 7. Health check ──────────────────────────────────────────
echo ""
echo "Waiting for node to start..."
sleep 20
for i in $(seq 1 6); do
  H=$(curl -sf http://localhost:8001/api/v1/height 2>/dev/null)
  if [ -n "$H" ]; then
    ok "Node is UP: $H"
    break
  fi
  echo "  attempt $i/6, waiting 10s..."; sleep 10
done

# ── Summary ──────────────────────────────────────────────────
echo ""
echo "============================================"
echo "  QNet Super Node installed successfully"
echo "============================================"
echo "  Container : $NODE_NAME"
echo "  Data dir  : $DATA_DIR"
echo "  Phrase    : $SEED_FILE (mode 600)"
echo "  API       : http://localhost:8001/api/v1/height"
echo "  Logs      : docker logs -f $NODE_NAME"
echo "  Updates   : automatic via Watchtower (every 5 min)"
echo "============================================"
echo ""
echo "The node registers itself once it has caught up with the chain; the Overview of aiqnet.io/node"
echo "then shows it for this wallet. One wallet runs one node: if this wallet already has another node,"
echo "the log says wallet_has_node and nothing is registered."
echo ""
