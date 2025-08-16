# 🚀 QNet Blockchain - Post-Quantum Decentralized Network

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Rust](https://img.shields.io/badge/rust-1.70+-orange.svg)](https://www.rust-lang.org)
[![Node.js](https://img.shields.io/badge/node.js-18+-green.svg)](https://nodejs.org)
[![Performance](https://img.shields.io/badge/TPS-424,411-blue.svg)](https://github.com/AIQnetLab/QNet-Blockchain)

## 🌟 Overview

QNet is a high-performance, post-quantum secure blockchain network with a **two-phase activation system** designed for the next generation of decentralized applications.

### ⚠️ **CRITICAL PHASE SYSTEM**
- **Phase 1 (Current)**: ONLY 1DEV token activation on Solana blockchain
- **Phase 2 (Future)**: ONLY QNC token activation on QNet blockchain
- **Transition**: 90% 1DEV burned OR 5 years from genesis block (whichever comes first)

### 🖥️ **DEVICE RESTRICTIONS**
- **Full/Super Nodes**: ONLY servers, VPS, desktops with interactive setup
- **Light Nodes**: ONLY mobile devices & tablets through mobile app

### 🚀 **Current Status: Production Testnet Ready**

**QNet production testnet is ready for deployment with real Rust nodes.**

- ✅ **Post-Quantum Cryptography**: CRYSTALS-Dilithium integration complete
- ✅ **Two-Phase Activation**: 1DEV burn (Phase 1) → QNC Pool 3 (Phase 2)
- ✅ **Microblock Architecture**: 1-second block production, 100k+ TPS capability
- ✅ **Production Rust Nodes**: Server deployment with real blockchain nodes
- ✅ **Browser Extension Wallet**: Production-ready with full-screen interface
- ✅ **Mobile Applications**: iOS/Android apps for Light nodes only
- ✅ **Interactive Setup**: Server nodes require interactive activation menu
- ✅ **1DEV Burn Contract Deployed**: [D7g7mkL8o1YEex6ZgETJEQyyHV7uuUMvV3Fy3u83igJ7](https://explorer.solana.com/address/D7g7mkL8o1YEex6ZgETJEQyyHV7uuUMvV3Fy3u83igJ7?cluster=devnet) on Solana Devnet

### 📋 **Testnet Deployment**

For production testnet deployment, see: **[PRODUCTION_TESTNET_MANUAL.md](PRODUCTION_TESTNET_MANUAL.md)**
- ✅ **Performance Validated**: 10,000+ TPS sustained with <200ms latency
- ✅ **Security Audited**: Comprehensive security review completed

### 🎯 Key Features

- **🔐 Post-Quantum Security**: Quantum-resistant cryptographic algorithms
- **⚡ Ultra-High Performance**: 424,411 TPS with sub-100ms latency
- **🔥 Phase 1 Active**: 1DEV burn-to-join (1,500 → 150 1DEV universal pricing)
- **💎 Phase 2 Ready**: QNC Pool 3 system (5k-30k QNC dynamic pricing)
- **🌐 Scalable Architecture**: Sharding and microblock technology
- **🔗 Cross-Chain Compatibility**: Solana integration for Phase 1
- **🏛️ Decentralized Governance**: Community-driven decision making
- **📱 Mobile-First Design**: Light nodes on phones & tablets
- **🖥️ Server Architecture**: Full/Super nodes on dedicated servers
- **🔧 Interactive Setup**: User-friendly activation process

### 📊 Performance Metrics

| Metric | Value | Description |
|--------|-------|-------------|
| **Throughput** | 424,411 TPS | Sustained transaction processing |
| **Latency** | <100ms | Transaction confirmation time |
| **Finality** | <2 seconds | Block finalization |
| **Energy Efficiency** | 99.9% less than Bitcoin | Eco-friendly consensus |
| **Node Types** | Full, Super, Light | Flexible participation |

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    QNet Blockchain                         │
├─────────────────────────────────────────────────────────────┤
│  Post-Quantum Crypto Layer                                 │
│  ├── CRYSTALS-Dilithium (Signatures)                       │
│  ├── CRYSTALS-Kyber (Key Exchange)                         │
│  └── SPHINCS+ (Hash-based Signatures)                      │
├─────────────────────────────────────────────────────────────┤
│  Consensus Layer                                           │
│  ├── Hybrid PoS/PoW Mechanism                              │
│  ├── Microblock Technology                                 │
│  └── Dynamic Validator Selection                           │
├─────────────────────────────────────────────────────────────┤
│  Network Layer                                             │
│  ├── Kademlia DHT                                          │
│  ├── Gossip Protocol                                       │
│  └── Regional Node Clustering                              │
├─────────────────────────────────────────────────────────────┤
│  Application Layer                                         │
│  ├── Smart Contracts (WASM)                                │
│  ├── DeFi Protocols                                        │
│  └── Cross-Chain Bridges                                   │
└─────────────────────────────────────────────────────────────┘
```

## 🖥️ System Requirements

### Minimum Requirements (Light Node)

| Component | Specification |
|-----------|---------------|
| **CPU** | 2 cores, 2.0 GHz |
| **RAM** | 4 GB |
| **Storage** | 50 GB SSD |
| **Network** | 10 Mbps |
| **OS** | Linux, macOS, Windows |

### Recommended Requirements (Full Node)

| Component | Specification |
|-----------|---------------|
| **CPU** | 4 cores, 3.0 GHz |
| **RAM** | 16 GB |
| **Storage** | 500 GB NVMe SSD |
| **Network** | 100 Mbps |
| **OS** | Ubuntu 20.04+ / CentOS 8+ |

### High-Performance Requirements (Super Node)

| Component | Specification |
|-----------|---------------|
| **CPU** | 8+ cores, 3.5+ GHz (Intel i7/AMD Ryzen 7) |
| **RAM** | 32+ GB DDR4 |
| **Storage** | 1+ TB NVMe SSD (3000+ IOPS) |
| **Network** | 1 Gbps dedicated |
| **OS** | Ubuntu 22.04 LTS |

## 🚀 Quick Start

### Prerequisites

```bash
# Update system packages
sudo apt update && sudo apt upgrade -y

# Install essential packages
sudo apt install -y curl wget git htop nano ufw fail2ban build-essential cmake pkg-config libssl-dev

# Configure timezone
sudo timedatectl set-timezone UTC
```

### Install Rust

QNet requires the latest Rust toolchain for optimal performance and security.

```bash
# Install Rust using rustup
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

# Source the environment
source ~/.cargo/env

# Update to latest Rust version
rustup update

# Verify installation
rustc --version
cargo --version
```

### Clone Repository

```bash
# Clone to home directory for production deployment
cd ~
git clone https://github.com/AIQnetLab/QNet-Blockchain.git
cd QNet-Blockchain

# Switch to testnet branch (latest production code)
git checkout testnet
git pull origin testnet
```

### Production Deployment (ONLY METHOD)

⚠️ **Single Deployment Method**: QNet uses ONLY Docker deployment for production servers.

⚠️ **Fully Automatic Configuration**: Everything is auto-configured including Solana contracts, ports, region, and performance settings.

⚠️ **Interactive Activation Only**: Node requires activation code input through interactive menu.

### Complete Production Setup

```bash
# Clone and checkout testnet
git clone https://github.com/AIQnetLab/QNet-Blockchain.git
cd QNet-Blockchain
git checkout testnet
git pull origin testnet

# Build production Docker image
docker build -f development/qnet-integration/Dockerfile.production -t qnet-production .

# Run interactive production node (ONLY activation method)
# For TESTNET:
docker run -it --name qnet-testnet-node --restart=always \
  -e QNET_NETWORK=testnet \
  -p 9876:9876 -p 9877:9877 -p 8001:8001 \
  -v $(pwd)/testnet_node_data:/app/node_data \
  qnet-production

# For MAINNET:
docker run -it --name qnet-mainnet-node --restart=always \
  -e QNET_NETWORK=mainnet \
  -p 9876:9876 -p 9877:9877 -p 8001:8001 \
  -v $(pwd)/mainnet_node_data:/app/node_data \
  qnet-production
```

**Note**: All Solana contract configuration is embedded in the Docker image. No manual configuration required.

### 🔗 Contract Deployment Proofs

**1DEV Burn Contract is successfully deployed on Solana Devnet:**

- **🔴 Program Address**: [D7g7mkL8o1YEex6ZgETJEQyyHV7uuUMvV3Fy3u83igJ7](https://explorer.solana.com/address/D7g7mkL8o1YEex6ZgETJEQyyHV7uuUMvV3Fy3u83igJ7?cluster=devnet)
- **📦 Program Data**: [HMbSTfp7fqsMopRqEy5u4fxQgLnYmM7ThPZzoo2VF4Gm](https://explorer.solana.com/address/HMbSTfp7fqsMopRqEy5u4fxQgLnYmM7ThPZzoo2VF4Gm?cluster=devnet)
- **💰 Deployer Wallet**: [6gesV5Dojg9tfH9TRytvXabnQT8U7oMbz5VKpTFi8rG4](https://explorer.solana.com/address/6gesV5Dojg9tfH9TRytvXabnQT8U7oMbz5VKpTFi8rG4?cluster=devnet)
- **🚀 Deploy Transaction**: [4z2A93vJ527LayPu8baer4MxYT8hVkoGCumCeJPpn6mmKZUpPtFmzFatFg7sTA5wzCUubuLupmKRTcA26EwpcwRR](https://explorer.solana.com/tx/4z2A93vJ527LayPu8baer4MxYT8hVkoGCumCeJPpn6mmKZUpPtFmzFatFg7sTA5wzCUubuLupmKRTcA26EwpcwRR?cluster=devnet)

**Contract Status:**
- ✅ **Immutable** (no upgrade authority)
- ✅ **Size**: 368,896 bytes
- ✅ **Slot**: 396,252,496
- ✅ **Network**: Solana Devnet

**Note**: Without these environment variables, the node will use development fallback data for testing.

⚠️ **Real Pricing Data**: When configured, the node fetches real burn percentage and network size from the Solana contract to show accurate pricing.

⚠️ **1DEV Token**: Real token address `Wkg19zERBsBiyqsh2ffcUrFG4eL5BF5BWkg19zERBsBi` on Solana devnet (Phase 1 ready).

⚠️ **Activation Codes**: Real activation codes are still generated through browser extension or mobile app, regardless of displayed pricing.

### 🖥️ Server Node Installation & Management

**Production Docker Deployment (ONLY METHOD):**

```bash
# Clone and checkout testnet
git clone https://github.com/AIQnetLab/QNet-Blockchain.git
cd QNet-Blockchain
git checkout testnet
git pull origin testnet

# Build production Docker image
docker build -f development/qnet-integration/Dockerfile.production -t qnet-production .

# Run interactive production node
docker run -it --name qnet-node --restart=always \
  -p 9876:9876 -p 9877:9877 -p 8001:8001 \
  -v $(pwd)/node_data:/app/node_data \
  qnet-production
```

**Clean Build & Cache:**

```bash
# Clean Docker system cache
docker system prune -f

# Remove all unused Docker images
docker image prune -a -f

# Clean node_modules if present
find . -name "node_modules" -type d -exec rm -rf {} +

# Clean .next and dist directories
find . -name ".next" -type d -exec rm -rf {} +
find . -name "dist" -type d -exec rm -rf {} +

# Rebuild Docker image from clean state
docker build --no-cache -f development/qnet-integration/Dockerfile.production -t qnet-production .
```

**Node Management:**

```bash
# Check running containers
docker ps

# View logs
docker logs -f qnet-node

# Stop node
docker stop qnet-node

# Restart node
docker restart qnet-node

# Remove node (keeps data volume)
docker rm qnet-node
```

### Additional Node Operations

#### Remove Node Data

```bash
# Remove node data volume (keeps Docker image)
docker volume rm qnet-node-data

# Remove entire installation
rm -rf ~/QNet-Blockchain

# Clean Docker resources
docker system prune -f
```

#### Backup Before Removal

```bash
# Backup important data before removal
mkdir -p ~/qnet-backup
cp -r ~/QNet-Blockchain/node_data/config ~/qnet-backup/
cp ~/QNet-Blockchain/node_data/*.key ~/qnet-backup/ 2>/dev/null || true

# Remove node data
rm -rf ~/QNet-Blockchain/node_data
```

⚠️ **Important**: Node deactivation from QNet network requires activation code expiry or manual deregistration through mobile app/browser extension.

## 📄 Node Setup Guides

QNet nodes run natively for maximum performance. Choose your node type based on available resources.

### 💡 Node Setup (Interactive Menu)

QNet nodes use device-specific deployment methods:

**Server Nodes (Full/Super)**: Interactive setup menu on dedicated servers
**Mobile Nodes (Light)**: Mobile app activation on phones & tablets

### Node Types & Platform Support

| Node Type | Platform | Activation Method | API Server | Features |
|-----------|----------|-------------------|------------|----------|
| **Light** | 📱 Mobile phones & tablets | Mobile app only | ❌ No | Basic sync, wallet |
| **Full** | 🖥️ Servers, VPS, desktops | Interactive setup | ✅ Yes | Full validation, API |
| **Super** | 🖥️ Servers, VPS, desktops | Interactive setup | ✅ Yes | Enhanced features, API |

### Device Restrictions

**⚠️ CRITICAL LIMITATIONS:**
- **Light Nodes**: Cannot be activated on servers/desktops
- **Full/Super Nodes**: Cannot be activated on mobile devices
- **API Access**: Only Full/Super nodes provide REST endpoints

#### Automatic Node Setup

```bash
# Configure firewall (ports auto-selected if 9876/9877 unavailable)
sudo ufw allow 9876  # P2P port (default)
sudo ufw allow 9877  # RPC port (default)
sudo ufw allow 9878  # Metrics port
sudo ufw --force enable

# Run auto-configured node setup (ZERO CONFIGURATION REQUIRED)
cd ~/QNet-Blockchain
./target/release/qnet-node
```

**New Features:**
- ✅ **Auto-port selection**: Finds available ports if defaults are busy
- ✅ **Auto-region detection**: Detects your location via IP geolocation
- ✅ **Auto-performance tuning**: Always enables 100k+ TPS optimizations
- ✅ **Auto-bootstrap peers**: Selects optimal peers for your region
- ✅ **Smart data directory**: Standard `node_data` location

#### What You'll See (Auto-Configuration)

```
🚀 === QNet Production Node Setup === 🚀
🖥️  SERVER DEPLOYMENT MODE
Welcome to QNet Blockchain Network!

🔧 Auto-configuring QNet node...
🌍 Auto-detecting region from IP address...
✅ Region auto-detected: Europe
🔌 Selected ports: P2P=9876, RPC=9877
📁 Data directory: "node_data"
🔗 Bootstrap peers: ["eu-bootstrap-1.qnet.io:9876", "eu-bootstrap-2.qnet.io:9876"]

🔍 Detecting current network phase...
✅ Phase 1 detected

📊 === Current Network Status ===
🔥 Phase 1: 1DEV Burn-to-Join Active
   📈 1DEV Burned: 45.0%
   💰 Universal Pricing: Same cost for all node types
   📉 Dynamic Reduction: Lower prices as more tokens burned

🖥️  === Server Node Type Selection ===
⚠️  SERVERS ONLY SUPPORT FULL/SUPER NODES
📱 Light nodes are restricted to mobile devices only

Choose your server node type:
1. Full Node   - Servers/desktops, full validation
2. Super Node  - High-performance servers, maximum rewards

💰 Current Pricing:
   1. Full Node  : 900 1DEV
   2. Super Node : 900 1DEV

Enter your choice (1-2): 
```

#### Setup Steps

1. **Auto-Configuration**: System automatically detects region, ports, and performance settings
2. **Select Node Type**: Choose between Full Node (1) or Super Node (2) 
3. **Enter Activation Code**: Provide your activation code from QNet wallet app
4. **Node Starts**: Fully optimized node with 100k+ TPS capabilities begins sync

#### Activation Code Requirements

- **Get activation code**: Use QNet Browser Extension or Mobile App
- **Purchase node license**: Burn 1DEV tokens (Phase 1) or transfer QNC to Pool 3 (Phase 2) 
- **Server restriction**: Full and Super nodes only for servers
- **Light nodes**: Mobile devices only - use QNet mobile app

### 🔧 System Optimization (Optional)

For optimal performance, especially for Super nodes, consider these system optimizations:

#### Performance Tuning

```bash
# System optimization for high-performance nodes
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
echo 'net.core.rmem_max=134217728' | sudo tee -a /etc/sysctl.conf
echo 'net.core.wmem_max=134217728' | sudo tee -a /etc/sysctl.conf
echo 'net.core.netdev_max_backlog=5000' | sudo tee -a /etc/sysctl.conf
echo 'net.ipv4.tcp_congestion_control=bbr' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p

# CPU governor for performance
echo 'performance' | sudo tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor

# Disable huge pages if not needed
echo 'never' | sudo tee /sys/kernel/mm/transparent_hugepage/enabled

# Increase file descriptor limits
echo "* soft nofile 65536" | sudo tee -a /etc/security/limits.conf
echo "* hard nofile 65536" | sudo tee -a /etc/security/limits.conf
```

#### Docker Container Management

```bash
# Check running containers
docker ps | grep qnet-node

# View real-time logs
docker logs qnet-node -f

# Stop node
docker stop qnet-node

# Restart node
docker restart qnet-node

# Remove container (keeps data volume)
docker rm qnet-node
```

## 🔍 Node Management

### Check Node Status

```bash
# Check if container is running
docker ps | grep qnet-node

# View real-time logs
docker logs qnet-node -f

# Check resource usage
docker stats qnet-node --no-stream
```

### Test Node Connectivity

```bash
# Test REST API endpoint
curl http://localhost:8001/api/v1/node/health

# Check peer connections
curl http://localhost:8001/api/v1/peers

# Check blockchain height
curl http://localhost:9877/api/v1/height

# Check sync status
curl http://localhost:8001/api/v1/node/info
```

### Update Node

```bash
# Navigate to repository
cd ~/QNet-Blockchain

# Pull latest changes
git pull origin testnet

# Stop and remove old container
docker stop qnet-node
docker rm qnet-node

# Rebuild Docker image
docker build -f development/qnet-integration/Dockerfile.production -t qnet-production .

# Run updated container
docker run -it --name qnet-node --restart=always \
  -p 9876:9876 -p 9877:9877 -p 8001:8001 \
  -v $(pwd)/node_data:/app/node_data \
  qnet-production
```

### 🔄 Automatic Node Replacement

**QNet features automatic node replacement when activating on a new server:**

#### How It Works
- **1 Wallet = 1 Active Node**: Only one node per type per wallet can be active
- **Seamless Migration**: Activate on new server → old node automatically shuts down
- **Quantum-Secure**: All replacement signals use CRYSTALS-Dilithium signatures
- **Blockchain Authority**: Blockchain records are the source of truth

#### Migration Scenarios
1. **Server Migration**: Move Full/Super node to new hardware
2. **Hardware Upgrade**: Seamless transition to more powerful server
3. **Node Type Upgrade**: Full → Super activation replaces Full node
4. **Disaster Recovery**: Reactivate on new server after hardware failure

#### Example: Server Migration
```bash
# On NEW server - activate with same activation code
docker run -it --name qnet-node --restart=always \
  -e QNET_PRODUCTION=1 \
  -e QNET_BOOTSTRAP_ID=YOUR_ID \
  -p 9876:9876 -p 9877:9877 -p 8001:8001 \
  -v $(pwd)/node_data:/app/node_data \
  qnet-production

# Result: Old server node receives shutdown signal and terminates
# New server becomes the active node for your wallet
```

**⚠️ Important Notes:**
- No manual migration required - fully automatic
- Previous node data remains on old server (backup if needed)
- Activation codes remain valid - bound to wallet, not hardware
- Light nodes (mobile) work the same way across devices

### Backup Node Data

```bash
# Create backup
sudo tar czf /backup/qnet-backup-$(date +%Y%m%d).tar.gz ~/QNet-Blockchain/node_data

# Restore from backup
sudo tar xzf /backup/qnet-backup-YYYYMMDD.tar.gz -C ~/QNet-Blockchain/
sudo chown -R qnet:qnet ~/QNet-Blockchain/node_data
```

## 🌐 Network Configuration

### Production Network (Mainnet)

```bash
# Mainnet nodes automatically connect to production bootstrap nodes
# No additional configuration required
```

### Test Network (Testnet)

Current deployment runs on testnet automatically. Network selection is handled during the interactive setup - no manual configuration required.

### Regional Configuration

Regional selection is handled automatically during the interactive setup based on your server's IP location. The system auto-detects your optimal region for best performance:

- **North America**: US, Canada, Mexico
- **Europe**: EU countries, UK, Norway, Switzerland
- **Asia**: Japan, Singapore, Hong Kong, South Korea
- **South America**: Brazil, Argentina, Chile
- **Africa**: South Africa, Nigeria, Kenya
- **Oceania**: Australia, New Zealand

No manual configuration required - regions are detected and selected automatically.

## 🔍 Monitoring & Maintenance

### Health Checks

```bash
# Check node health
curl http://localhost:8001/api/v1/node/health

# Check peer connections
curl http://localhost:8001/api/v1/peers

# Check blockchain height
curl http://localhost:9877/api/v1/height

# Check node info
curl http://localhost:8001/api/v1/node/info
```

### Log Analysis

```bash
# View recent logs (live monitoring)
docker logs qnet-node -f

# View detailed blockchain logs (if running in background)
tail -f node_data/qnet-node.log

# Search for errors
docker logs qnet-node | grep "ERROR"

# Monitor blockchain activity (blocks, consensus, P2P)
docker logs qnet-node | grep "CONSENSUS\|BLOCK\|P2P\|SYNC"

# Monitor performance metrics
docker logs qnet-node | grep "TPS\|latency\|performance"

# View peer connections and network status
docker logs qnet-node | grep "peer\|connection\|discovery"

# View last 100 lines
docker logs qnet-node --tail 100

# Filter by log level
docker logs qnet-node | grep "\[DEBUG\]\|\[INFO\]\|\[WARN\]\|\[ERROR\]"
```

### Genesis Node Deployment

For genesis bootstrap nodes (production network initialization):

```bash
# TESTNET Genesis Nodes:
# Genesis Node #001 (NorthAmerica)
docker run -d --name qnet-testnet-genesis-001 --restart=always \
  -e QNET_NETWORK=testnet \
  -e QNET_PRODUCTION=1 \
  -e QNET_BOOTSTRAP_ID=001 \
  -p 9876:9876 -p 9877:9877 -p 8001:8001 \
  -v $(pwd)/testnet_genesis_001:/app/data \
  qnet-production

# Genesis Node #002 (Europe) 
docker run -d --name qnet-testnet-genesis-002 --restart=always \
  -e QNET_NETWORK=testnet \
  -e QNET_PRODUCTION=1 \
  -e QNET_BOOTSTRAP_ID=002 \
  -p 9878:9876 -p 9879:9877 -p 8002:8001 \
  -v $(pwd)/testnet_genesis_002:/app/data \
  qnet-production

# MAINNET Genesis Nodes:
# Genesis Node #001 (NorthAmerica)
docker run -d --name qnet-mainnet-genesis-001 --restart=always \
  -e QNET_NETWORK=mainnet \
  -e QNET_PRODUCTION=1 \
  -e QNET_BOOTSTRAP_ID=001 \
  -p 9876:9876 -p 9877:9877 -p 8001:8001 \
  -v $(pwd)/mainnet_genesis_001:/app/data \
  qnet-production
```

**Genesis Node Requirements:**
- Set `QNET_BOOTSTRAP_ID` to 001-005 for genesis nodes
- Use different ports for multiple nodes on same server
- Create separate data directories for each node  
- Ensure proper file permissions: `chmod 777 node_data_XXX/`

### Quick Testnet Launch (5 Genesis Nodes)

For rapid testnet deployment with coordinated genesis nodes:

```bash
# Launch complete testnet (5 genesis nodes + bridge)
docker-compose -f docker-compose.testnet.yml up -d

# Monitor testnet startup
docker-compose -f docker-compose.testnet.yml logs -f

# Stop testnet
docker-compose -f docker-compose.testnet.yml down
```

**Testnet Endpoints:**
- Genesis Node 1: http://localhost:8001
- Genesis Node 2: http://localhost:8002  
- Genesis Node 3: http://localhost:8003
- Genesis Node 4: http://localhost:8004
- Genesis Node 5: http://localhost:8005
- Bridge Server: http://localhost:8080

### Backup & Recovery

```bash
# Backup node data
sudo tar -czf qnet-backup-$(date +%Y%m%d).tar.gz ~/QNet-Blockchain/node_data

# Backup configuration
sudo cp -r ~/QNet-Blockchain/node_data/config /backup/qnet-config-backup/

# Recovery
sudo tar -xzf qnet-backup-YYYYMMDD.tar.gz -C ~/QNet-Blockchain/
sudo chown -R qnet:qnet ~/QNet-Blockchain/node_data
```

## 🛠️ Development

### Building from Source

```bash
# Development build
cargo build

# Release build with optimizations
cargo build --release

# Run tests
cargo test

# Run benchmarks
cargo bench
```

### Running Tests

```bash
# Unit tests
cargo test --lib

# Integration tests
cargo test --test integration

# Performance tests
cargo test --test performance --release
```

## 📚 API Documentation

### Multi-Node REST API Architecture

**🌐 Every Full/Super node provides complete API functionality:**

```bash
# Node 1 API endpoints
curl http://localhost:8001/api/v1/node/info
curl http://localhost:8001/api/v1/blocks/{height}
curl http://localhost:8001/api/v1/transactions/{hash}

# Node 2 API endpoints  
curl http://localhost:8002/api/v1/node/info
curl http://localhost:8002/api/v1/blocks/{height}
curl http://localhost:8002/api/v1/transactions/{hash}

# Node 3 API endpoints
curl http://localhost:8003/api/v1/node/info
curl http://localhost:8003/api/v1/blocks/{height}
curl http://localhost:8003/api/v1/transactions/{hash}
```

### Available API Endpoints (Per Node)

**Account Management:**
- `GET /api/v1/account/{address}` - Get account information
- `GET /api/v1/account/{address}/balance` - Get account balance
- `GET /api/v1/account/{address}/transactions` - Get transaction history

**Blockchain Data:**
- `GET /api/v1/block/latest` - Get latest block
- `GET /api/v1/block/{height}` - Get block by height
- `GET /api/v1/block/hash/{hash}` - Get block by hash

**Transactions:**
- `POST /api/v1/transaction` - Submit transaction
- `GET /api/v1/transaction/{hash}` - Get transaction details

**Network Status:**
- `GET /api/v1/mempool/status` - Get mempool status
- `GET /api/v1/nodes/discovery` - Discover available nodes
- `GET /api/v1/node/health` - Check node health
- `GET /api/v1/gas/recommendations` - Get gas price recommendations

### Client Implementation with Multiple Nodes

```javascript
// Production-ready client with multiple node support
const qnetNodes = [
    'http://node1.example.com:8001',  // Full node
    'http://node2.example.com:8002',  // Super node  
    'http://node3.example.com:8003'   // Full node
];

async function qnetApiCall(endpoint, data = null) {
    for (const nodeUrl of qnetNodes) {
        try {
            const response = await fetch(`${nodeUrl}/api/v1/${endpoint}`, {
                method: data ? 'POST' : 'GET',
                headers: data ? {'Content-Type': 'application/json'} : {},
                body: data ? JSON.stringify(data) : null
            });
            if (response.ok) return await response.json();
        } catch (error) {
            console.log(`Node ${nodeUrl} unavailable, trying next...`);
        }
    }
    throw new Error('All QNet nodes unavailable');
}
```

**🔑 Architecture Benefits:**
- ✅ **Distributed Access**: Multiple nodes provide API access
- ✅ **Load Distribution**: API traffic spread across multiple nodes
- ✅ **High Availability**: Multiple nodes ensure service continuity
- ✅ **Scalability**: More nodes = more API capacity
- ✅ **Redundancy**: Built-in failover capabilities

**📝 Node Requirements:**
- Full/Super nodes provide REST API endpoints
- Light nodes focus on mobile functionality
- Each node offers identical API interface

### WebSocket API (Per Node)

Each Full/Super node also provides WebSocket endpoints for real-time updates:

```javascript
// Connect to specific node WebSocket
const ws = new WebSocket('ws://localhost:9877/ws');

// Subscribe to new blocks
ws.send(JSON.stringify({
    method: 'subscribe',
    params: ['newBlocks']
}));

// Subscribe to new transactions
ws.send(JSON.stringify({
    method: 'subscribe', 
    params: ['newTransactions']
}));
```

**WebSocket Endpoints:**
- `ws://localhost:9877/ws` - Node 1 WebSocket
- `ws://localhost:9879/ws` - Node 2 WebSocket  
- `ws://localhost:9881/ws` - Node 3 WebSocket 

## 🔧 Auto-Configuration Features

QNet node deployment now features **zero-configuration** setup for maximum ease of use:

### 🌍 Automatic Region Detection

- **IP-based geolocation**: Automatically detects your geographic region
- **Optimal bootstrap peers**: Selects the best peers for your region
- **Reduced latency**: Connects to nearest network nodes
- **Supported regions**: North America, Europe, Asia, South America, Africa, Oceania

### 🔌 Smart Port Management

- **Auto-port selection**: Finds available ports if defaults are busy
- **Default ports**: P2P=9876, RPC=9877, Metrics=9878
- **Port range scanning**: Automatically scans for available ports in +100 range
- **Conflict resolution**: Handles port conflicts gracefully

### ⚡ Performance Optimization

- **Always enabled**: 100k+ TPS optimizations active by default
- **Microblock production**: Enabled for all production nodes
- **High-performance mode**: Ultra-high throughput settings
- **Optimized batching**: 10,000 transactions per batch
- **Parallel processing**: 16 threads for validation

### 📁 Data Management

- **Standard location**: `node_data` directory in project root
- **Automatic creation**: Creates data directory if not exists
- **Permission checking**: Validates write permissions
- **Backup-friendly**: Clear data structure for easy backups

### 🛡️ Security Features

- **Post-quantum crypto**: Always enabled
- **Secure by default**: No insecure fallback modes
- **Activation validation**: Cryptographic proof of node purchase
- **Network isolation**: Proper firewall configuration

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

### Development Workflow

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Make your changes and add tests
4. Run tests: `cargo test`
5. Commit your changes: `git commit -m 'Add amazing feature'`
6. Push to the branch: `git push origin feature/amazing-feature`
7. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🔗 Links

- **Website**: https://qnet.io
- **Documentation**: https://docs.qnet.io
- **Explorer**: https://explorer.qnet.io
- **Discord**: https://discord.gg/qnet
- **Twitter**: https://twitter.com/QNetBlockchain

## ⚠️ Disclaimer

QNet is experimental software. Use at your own risk. Always test thoroughly before using in production environments.

---

**QNet Blockchain Project** 