# QNet Node Deployment Guide

## Quick Start

```bash
# 1. Clone and update
git clone https://github.com/AIQnetLab/QNet-Blockchain.git
cd QNet-Blockchain
git checkout testnet
git pull origin testnet

# 2. Build Docker image
docker build -f development/qnet-integration/Dockerfile.production -t qnet-production .

# 3. Run Super Node (env vars — same architecture as Genesis nodes)
docker run -d --name qnet-super --restart=always \
  --log-opt max-size=200m --log-opt max-file=50 \
  -e QNET_PRODUCTION=1 \
  -e DOCKER_ENV=1 \
  -e QNET_WALLET_SEED="your twelve word mnemonic phrase here" \
  -e QNET_ACTIVATION_CODE="QNET-SXXXXX-YYYYYY-ZZZZZZ" \
  -e QNET_BURN_TX_HASH="your_solana_burn_tx_signature" \
  -e QNET_BURN_AMOUNT="1500" \
  -p 9876:9876 -p 9877:9877 -p 8001:8001 -p 10876:10876/udp \
  -v $(pwd)/node_data:/app/data \
  qnet-production
```

**Single deployment method: Docker detached mode with environment variables.**
No interactive menu — all configuration via `-e` flags (identical to Genesis node architecture).

Get activation data from QNet Mobile App: **Settings > Export Activation Codes**

> **⚠️ Handling `QNET_WALLET_SEED` (and burn data) securely**
> - The seed is your 12-word mnemonic — anyone who reads it controls the wallet. **Never** echo it, paste it into chat/tickets, or commit it to a file. Prefer an `--env-file` with `600` permissions, or inject it from a secrets manager, over an inline `-e` flag (inline values are visible in shell history and `docker inspect`).
> - `QNET_WALLET_SEED`, `QNET_BURN_TX_HASH`, and `QNET_BURN_AMOUNT` are **not** trusted blindly by the node: on startup it derives the address from the seed, XOR-verifies the activation code binds to that seed, and validates the burn transaction on-chain (amount + fee-payer) via the network quorum. A forged or mismatched value fails activation — it cannot be used to impersonate another wallet.
> - Rotate/clear these vars from the environment after the container is running; they are only needed at first activation.

---

## System Requirements

**Minimum:**
- **OS:** Linux (Ubuntu 20.04+, CentOS 8+)
- **CPU:** 4 cores, 2.5+ GHz
- **RAM:** 8 GB (16 GB recommended)
- **Storage:** 100 GB SSD
- **Network:** Stable internet, open ports 9876, 9877, 8001

## Step 1: Install Dependencies

**Ubuntu/Debian:**
```bash
sudo apt update
sudo apt install -y curl git
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# Log out and back in for group changes
```

**CentOS/RHEL:**
```bash
sudo yum update -y
sudo yum install -y curl git
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# Log out and back in for group changes
```

## Step 2: Clone Repository

```bash
git clone https://github.com/AIQnetLab/QNet-Blockchain.git
cd QNet-Blockchain
git checkout testnet
git pull origin testnet
```

## Step 3: Build Docker Image

```bash
docker build -f development/qnet-integration/Dockerfile.production -t qnet-production .
```

## Step 4: Run Super Node

```bash
docker run -d --name qnet-super --restart=always \
  --log-opt max-size=200m --log-opt max-file=50 \
  -e QNET_PRODUCTION=1 \
  -e DOCKER_ENV=1 \
  -e QNET_WALLET_SEED="your twelve word mnemonic phrase here" \
  -e QNET_ACTIVATION_CODE="QNET-SXXXXX-YYYYYY-ZZZZZZ" \
  -e QNET_BURN_TX_HASH="your_solana_burn_tx_signature" \
  -e QNET_BURN_AMOUNT="1500" \
  -p 9876:9876 -p 9877:9877 -p 8001:8001 -p 10876:10876/udp \
  -v $(pwd)/node_data:/app/data \
  qnet-production
```

**Required environment variables:**
| Variable | Description |
|----------|-------------|
| `QNET_WALLET_SEED` | 12-word BIP39 mnemonic (same as mobile app) |
| `QNET_ACTIVATION_CODE` | `QNET-SXXXXX-YYYYYY-ZZZZZZ` (25 chars, from mobile app) |
| `QNET_BURN_TX_HASH` | Solana burn transaction signature |
| `QNET_BURN_AMOUNT` | Exact 1DEV amount burned (e.g. `1500`) |
| `QNET_PRODUCTION` | Set to `1` |
| `DOCKER_ENV` | Set to `1` |

**On startup the node will:**
1. Derive Solana address from mnemonic (BIP39 → SLIP-10 → Ed25519)
2. XOR-verify activation code belongs to this mnemonic
3. Verify burn TX on Solana (amount + feePayer check)
4. Generate quantum-resistant Dilithium3 keys
5. Register on-chain via NodeRegistration TX
6. Begin consensus participation

## Node Management

**Check status:**
```bash
# View real-time logs
docker logs qnet-node -f

# Check container status
docker ps | grep qnet-node

# Stop node
docker stop qnet-node

# Restart node
docker restart qnet-node

# Remove container (keeps data)
docker rm qnet-node
```

**Health monitoring:**
```bash
# Node health
curl http://localhost:8001/api/v1/node/health

# Peer connections
curl http://localhost:8001/api/v1/peers

# Blockchain height
curl http://localhost:9877/api/v1/height
```

**Daemon mode features:**
- Runs 24/7 in background
- Auto-restart on crashes (`--restart=always`)
- Logs accessible via `docker logs`
- Secure container isolation
- Easy updates and management

## Activation Requirements

**Valid activation codes required:**
- **Format:** QNET-XXXXXX-XXXXXX-XXXXXX (25 characters)
- **Phase 1:** 1DEV burn on Solana (1,500 -> 300 1DEV dynamic pricing)
- **Phase 2:** QNC transfer to Pool 3 (5k-30k QNC pricing)
- **Node Types:** Super for servers only, Light for mobile only (Full removed in v3.18)
- **Required env vars:** `QNET_ACTIVATION_CODE`, `QNET_BURN_TX_HASH`, `QNET_BURN_AMOUNT`, `QNET_WALLET_SEED`

**Get activation codes:**
- QNet Browser Extension
- QNet Mobile App
- Purchase through 1DEV token burn

## Network Ports

**Required open ports:**
```bash
sudo ufw allow 9876  # P2P networking
sudo ufw allow 9877  # RPC endpoint  
sudo ufw allow 8001  # REST API
sudo ufw --force enable
```

## Super Node Server Migration

**To migrate your Super Node to a new server**, simply run the same Docker command on the new server with the same environment variables:

```bash
docker run -d --name qnet-super --restart=always \
  --log-opt max-size=200m --log-opt max-file=50 \
  -e QNET_PRODUCTION=1 \
  -e DOCKER_ENV=1 \
  -e QNET_WALLET_SEED="your twelve word mnemonic phrase here" \
  -e QNET_ACTIVATION_CODE="QNET-SXXXXX-YYYYYY-ZZZZZZ" \
  -e QNET_BURN_TX_HASH="your_solana_burn_tx_signature" \
  -e QNET_BURN_AMOUNT="1500" \
  -p 9876:9876 -p 9877:9877 -p 8001:8001 -p 10876:10876/udp \
  -v $(pwd)/node_data:/app/data \
  qnet-production
```

**What happens automatically:**
1. New server registers its `device_id` with genesis nodes
2. Old server detects the change within ~30 seconds
3. Old server performs graceful shutdown (stops QUIC, clears activation, exits)
4. Node reputation is **preserved** — no penalty for migration
5. No duplicate on-chain transactions created

**Limitations:**
- Max **1 migration per 24 hours** per wallet (rate limited)
- Same activation code + mnemonic required
- Genesis nodes are **not affected** — they use IP-based authentication

**NOTE:** You do NOT need to stop the old server manually. It will shut down automatically after detecting the migration.

## Troubleshooting

**Build issues:**
```bash
# Clean Docker cache
docker system prune -f
docker build --no-cache -f development/qnet-integration/Dockerfile.production -t qnet-production .
```

**Network issues:**
```bash
# Check ports
netstat -tuln | grep -E ':(9876|9877|8001)'

# Test connectivity
telnet localhost 9876
curl http://localhost:8001/api/v1/node/health
```

**Container issues:**
```bash
# Remove old container
docker stop qnet-super || true
docker rm qnet-super || true

# Run fresh container with env vars
docker run -d --name qnet-super --restart=always \
  --log-opt max-size=200m --log-opt max-file=50 \
  -e QNET_PRODUCTION=1 -e DOCKER_ENV=1 \
  -e QNET_WALLET_SEED="your mnemonic" \
  -e QNET_ACTIVATION_CODE="QNET-SXXXXX-YYYYYY-ZZZZZZ" \
  -e QNET_BURN_TX_HASH="solana_tx" -e QNET_BURN_AMOUNT="1500" \
  -p 9876:9876 -p 9877:9877 -p 8001:8001 -p 10876:10876/udp \
  -v $(pwd)/node_data:/app/data \
  qnet-production
```

**For support:** https://github.com/AIQnetLab/QNet-Blockchain/issues 
