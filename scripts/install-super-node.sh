#!/bin/bash
# ============================================================
# QNet Super Node — Install & Auto-Update Script
# ============================================================
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/AIQnetLab/QNet-Blockchain/testnet/scripts/install-super-node.sh | bash
#
# What this does:
#   1. Installs Docker (if not present)
#   2. Pulls the latest qnet-production image from ghcr.io (public, no auth needed)
#   3. Starts your Super node
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

# ── Required: wallet seed ────────────────────────────────────
if [ -z "$QNET_WALLET_SEED" ]; then
  echo ""
  echo "Required env vars before running:"
  echo ""
  echo "  export QNET_WALLET_SEED=\"word1 word2 ... word12\""
  echo "  export QNET_ACTIVATION_CODE=\"QNET-XXXX-XXXX-XXXX\"  # from mobile app"
  echo ""
  echo "  bash install-super-node.sh"
  echo ""
  err "QNET_WALLET_SEED is not set"
fi

# ── Required: activation code ────────────────────────────────
if [ -z "$QNET_ACTIVATION_CODE" ]; then
  echo ""
  warn "QNET_ACTIVATION_CODE not set — node will start but won't register until code is provided."
  warn "Generate an activation code in the QNet mobile app and set it via:"
  warn "  docker exec qnet-super-node qnet-node --register --code YOUR-CODE"
  echo ""
fi

# ── Optional settings ─────────────────────────────────────────
NODE_NAME="${QNET_NODE_NAME:-qnet-super-node}"
DATA_DIR="${QNET_DATA_DIR:-/opt/qnet/data}"
MAX_STORAGE_GB="${QNET_MAX_STORAGE_GB:-500}"

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
ACTIVATION_ARG=""
[ -n "$QNET_ACTIVATION_CODE" ] && ACTIVATION_ARG="-e QNET_ACTIVATION_CODE=$QNET_ACTIVATION_CODE"

# Optional: exact 1DEV burn tx hash for precise on-chain burn verification.
# Without it the node falls back to scanning recent Solana signatures (slower,
# and fails if the burn is older than the scan window or the RPC is unreachable).
BURN_ARG=""
[ -n "$QNET_BURN_TX_HASH" ] && BURN_ARG="-e QNET_BURN_TX_HASH=$QNET_BURN_TX_HASH"

docker run -d \
  --name "$NODE_NAME" \
  --restart=always \
  --log-opt max-size=100m \
  --log-opt max-file=10 \
  -e QNET_PRODUCTION=1 \
  -e QNET_WALLET_SEED="$QNET_WALLET_SEED" \
  -e DOCKER_ENV=1 \
  -e QNET_MAX_STORAGE_GB="$MAX_STORAGE_GB" \
  $ACTIVATION_ARG \
  $BURN_ARG \
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
echo "  API       : http://localhost:8001/api/v1/height"
echo "  Logs      : docker logs -f $NODE_NAME"
echo "  Updates   : automatic via Watchtower (every 5 min)"
echo "============================================"
echo ""
if [ -z "$QNET_ACTIVATION_CODE" ]; then
  echo "NEXT STEP: Register your node with an activation code."
  echo "  1. Open QNet mobile app → Settings → Generate Node Code"
  echo "  2. Run: docker exec $NODE_NAME qnet-node --register --code YOUR-CODE"
  echo ""
fi
