# 🚀 QNet Blockchain - Post-Quantum Decentralized Network

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Rust](https://img.shields.io/badge/rust-1.70+-orange.svg)](https://www.rust-lang.org)
[![Node.js](https://img.shields.io/badge/node.js-18+-green.svg)](https://nodejs.org)
[![Performance](https://img.shields.io/badge/TPS-424,411-blue.svg)](https://github.com/AIQnetLab/QNet-Blockchain)

## 🌟 Overview

QNet is a high-performance, post-quantum secure blockchain network designed for the next generation of decentralized applications. With cutting-edge cryptography and innovative consensus mechanisms, QNet delivers unprecedented performance while maintaining quantum resistance.

### 🎯 Key Features

- **🔐 Post-Quantum Security**: Quantum-resistant cryptographic algorithms
- **⚡ Ultra-High Performance**: 424,411 TPS with sub-100ms latency
- **🌐 Scalable Architecture**: Sharding and microblock technology
- **🔗 Cross-Chain Compatibility**: Seamless integration with existing networks
- **🏛️ Decentralized Governance**: Community-driven decision making
- **📱 Mobile-First Design**: Optimized for mobile and IoT devices

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
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env

# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install Git
sudo apt-get update
sudo apt-get install git
```

### Clone Repository

```bash
git clone https://github.com/AIQnetLab/QNet-Blockchain.git
cd QNet-Blockchain
```

### Build from Source

```bash
# Build Rust components
cargo build --release

# Install Node.js dependencies
npm install

# Build frontend
cd applications/qnet-explorer/frontend
npm install
npm run build
```

## 🔧 Node Setup Guides

### 💡 Light Node Setup

Light nodes provide basic network participation with minimal resources.

#### Installation

```bash
# Download light node binary
wget https://github.com/AIQnetLab/QNet-Blockchain/releases/latest/download/qnet-light-node
chmod +x qnet-light-node

# Create configuration
mkdir ~/.qnet
cat > ~/.qnet/config.toml << EOF
[node]
type = "light"
network = "mainnet"
data_dir = "~/.qnet/data"

[network]
listen_port = 8333
max_peers = 50
bootstrap_nodes = [
    "bootstrap1.qnet.io:8333",
    "bootstrap2.qnet.io:8333"
]

[logging]
level = "info"
file = "~/.qnet/logs/node.log"
EOF

# Start node
./qnet-light-node --config ~/.qnet/config.toml
```

#### Docker Setup

```bash
# Pull Docker image
docker pull qnetlab/qnet-light-node:latest

# Run container
docker run -d \
  --name qnet-light \
  -p 8333:8333 \
  -v ~/.qnet:/root/.qnet \
  qnetlab/qnet-light-node:latest
```

### 🖥️ Full Node Setup

Full nodes maintain complete blockchain state and participate in consensus.

#### System Preparation

```bash
# Update system
sudo apt-get update && sudo apt-get upgrade -y

# Install dependencies
sudo apt-get install -y \
  build-essential \
  pkg-config \
  libssl-dev \
  libclang-dev \
  cmake

# Optimize system for blockchain
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
echo 'net.core.rmem_max=134217728' | sudo tee -a /etc/sysctl.conf
echo 'net.core.wmem_max=134217728' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

#### Installation

```bash
# Clone and build
git clone https://github.com/AIQnetLab/QNet-Blockchain.git
cd QNet-Blockchain
cargo build --release --bin qnet-full-node

# Create full node configuration
mkdir -p ~/.qnet/data ~/.qnet/logs
cat > ~/.qnet/config.toml << EOF
[node]
type = "full"
network = "mainnet"
data_dir = "~/.qnet/data"
enable_mining = false
enable_api = true

[network]
listen_port = 8333
max_peers = 200
bootstrap_nodes = [
    "bootstrap1.qnet.io:8333",
    "bootstrap2.qnet.io:8333",
    "bootstrap3.qnet.io:8333"
]

[consensus]
enable_validator = true
stake_amount = 1000  # QNC tokens

[api]
listen_address = "127.0.0.1:8545"
enable_cors = true
max_connections = 100

[storage]
cache_size = "2GB"
max_open_files = 1000

[logging]
level = "info"
file = "~/.qnet/logs/node.log"
max_size = "100MB"
max_files = 10
EOF

# Generate node identity
./target/release/qnet-full-node --generate-identity

# Start full node
./target/release/qnet-full-node --config ~/.qnet/config.toml
```

#### Systemd Service

```bash
# Create service file
sudo cat > /etc/systemd/system/qnet-node.service << EOF
[Unit]
Description=QNet Full Node
After=network.target

[Service]
Type=simple
User=qnet
WorkingDirectory=/home/qnet/QNet-Blockchain
ExecStart=/home/qnet/QNet-Blockchain/target/release/qnet-full-node --config /home/qnet/.qnet/config.toml
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# Enable and start service
sudo systemctl enable qnet-node
sudo systemctl start qnet-node
sudo systemctl status qnet-node
```

### ⚡ Super Node Setup

Super nodes provide high-performance infrastructure for the network.

#### Hardware Optimization

```bash
# CPU optimization
echo 'performance' | sudo tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor

# Memory optimization
echo 'never' | sudo tee /sys/kernel/mm/transparent_hugepage/enabled
echo 'madvise' | sudo tee /sys/kernel/mm/transparent_hugepage/defrag

# Network optimization
echo 'net.core.netdev_max_backlog=5000' | sudo tee -a /etc/sysctl.conf
echo 'net.ipv4.tcp_congestion_control=bbr' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

#### Installation

```bash
# Build with optimizations
RUSTFLAGS="-C target-cpu=native" cargo build --release --bin qnet-super-node

# Create super node configuration
cat > ~/.qnet/config.toml << EOF
[node]
type = "super"
network = "mainnet"
data_dir = "~/.qnet/data"
enable_mining = true
enable_api = true
enable_metrics = true

[network]
listen_port = 8333
max_peers = 1000
bootstrap_nodes = [
    "bootstrap1.qnet.io:8333",
    "bootstrap2.qnet.io:8333",
    "bootstrap3.qnet.io:8333"
]
enable_upnp = true

[consensus]
enable_validator = true
stake_amount = 10000  # QNC tokens
max_block_size = "10MB"
target_block_time = "2s"

[mining]
enable = true
threads = 8
algorithm = "qnet-pow"

[api]
listen_address = "0.0.0.0:8545"
enable_cors = true
max_connections = 1000
enable_websocket = true

[storage]
cache_size = "8GB"
max_open_files = 10000
enable_compression = true

[metrics]
enable = true
listen_address = "127.0.0.1:9090"
export_interval = "10s"

[logging]
level = "debug"
file = "~/.qnet/logs/node.log"
max_size = "500MB"
max_files = 20
EOF

# Start super node
./target/release/qnet-super-node --config ~/.qnet/config.toml
```

#### Monitoring Setup

```bash
# Install Prometheus
wget https://github.com/prometheus/prometheus/releases/download/v2.40.0/prometheus-2.40.0.linux-amd64.tar.gz
tar xvfz prometheus-*.tar.gz
cd prometheus-*

# Configure Prometheus
cat > prometheus.yml << EOF
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: 'qnet-node'
    static_configs:
      - targets: ['localhost:9090']
EOF

# Start Prometheus
./prometheus --config.file=prometheus.yml
```

## 🌐 Network Configuration

### Mainnet

```toml
[network]
name = "mainnet"
chain_id = 1
genesis_hash = "0x..."
bootstrap_nodes = [
    "mainnet1.qnet.io:8333",
    "mainnet2.qnet.io:8333",
    "mainnet3.qnet.io:8333"
]
```

### Testnet

```toml
[network]
name = "testnet"
chain_id = 2
genesis_hash = "0x..."
bootstrap_nodes = [
    "testnet1.qnet.io:8333",
    "testnet2.qnet.io:8333"
]
```

## 🔍 Monitoring & Maintenance

### Health Checks

```bash
# Check node status
curl http://localhost:8545/health

# Check peer connections
curl http://localhost:8545/peers

# Check sync status
curl http://localhost:8545/sync

# Check validator status
curl http://localhost:8545/validator/status
```

### Log Analysis

```bash
# View recent logs
tail -f ~/.qnet/logs/node.log

# Search for errors
grep "ERROR" ~/.qnet/logs/node.log

# Monitor performance
grep "TPS\|latency" ~/.qnet/logs/node.log
```

### Backup & Recovery

```bash
# Backup node data
tar -czf qnet-backup-$(date +%Y%m%d).tar.gz ~/.qnet/data

# Backup configuration
cp ~/.qnet/config.toml ~/qnet-config-backup.toml

# Recovery
tar -xzf qnet-backup-YYYYMMDD.tar.gz -C ~/
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

### REST API

```bash
# Get node info
GET /api/v1/node/info

# Get block by height
GET /api/v1/blocks/{height}

# Get transaction by hash
GET /api/v1/transactions/{hash}

# Submit transaction
POST /api/v1/transactions
```

### WebSocket API

```javascript
const ws = new WebSocket('ws://localhost:8545/ws');

// Subscribe to new blocks
ws.send(JSON.stringify({
    method: 'subscribe',
    params: ['newBlocks']
}));
```

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

**Built with ❤️ by the QNet Team** 