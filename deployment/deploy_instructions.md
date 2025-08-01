# QNet Production Server Setup Guide

## ⚡ Quick Start (Updated Daemon Mode)

### 🚀 One-Command Production Deployment
```bash
# 1. Update and build
cd ~/QNet-Project && git pull origin testnet
docker build -f development/qnet-integration/Dockerfile.production -t qnet-production .

# 2. Interactive setup (first time)
docker run -it --name qnet-node-setup --rm \
  -p 9876:9876 -p 9877:9877 -p 8001:8001 \
  -v $(pwd)/node_data:/app/node_data \
  qnet-production

# 3. Start daemon mode (24/7)
docker run -d --name qnet-node --restart=always \
  -p 9876:9876 -p 9877:9877 -p 8001:8001 \
  -v $(pwd)/node_data:/app/node_data \
  qnet-production

# 4. Monitor
docker logs qnet-node -f  # Ctrl+C to exit, node keeps running
```

### 🔧 Key Features
- **Interactive Setup**: One-time configuration (node type + activation)
- **True Daemon Mode**: Background operation, terminal-independent
- **Auto-Restart**: Docker handles crashes and reboots
- **Log Management**: `docker logs qnet-node -f` (Ctrl+C safe)
- **Zero Downtime**: Dynamic leadership with auto-failover

---

## 🚀 Complete Setup from Scratch

### Prerequisites
- Ubuntu 20.04+ / CentOS 8+ / Debian 11+
- 4+ GB RAM, 50+ GB SSD
- Stable internet connection
- Open ports: 9876 (P2P), 8001 (API)

### Step 1: System Preparation
```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install required packages
sudo apt install -y curl git build-essential pkg-config libssl-dev

# Configure firewall
sudo ufw allow 9876  # P2P port
sudo ufw allow 8001  # API port
sudo ufw --force enable
```

### Step 2: Install Dependencies
```bash
# Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source ~/.cargo/env
```

### Step 3: Download and Build QNet
```bash
# Clone repository
git clone https://github.com/AIQnetLab/QNet-Blockchain.git
cd QNet-Blockchain
git checkout testnet

# Build Rust binary first (from project root)
cargo build --release --bin qnet-node

# Build production Docker image using correct Dockerfile path
docker build -t qnet-production -f development/qnet-integration/Dockerfile.production .
```

### Step 3B: Dynamic Leadership Network (Production)
QNet uses **Dynamic Leadership with Auto-Failover** for maximum reliability:

**Leadership Priority (Auto-Failover):**
- **Priority 1: 154.38.160.39:9876** - Primary Leader (North America)
- **Priority 2: 62.171.157.44:9877** - Backup Leader (Europe)  
- **Priority 3: 161.97.86.81:9877** - Backup Leader (Europe)

**🔄 Failover Scenarios:**
- If Primary goes offline → Backup #2 automatically becomes leader
- If Primary returns → Leadership automatically returns to Primary  
- If all Genesis nodes offline → Any node can become leader
- **Zero downtime** during server transitions

**✅ No manual configuration needed!** New nodes automatically discover the network through genesis bootstrap, then switch to full decentralized peer exchange with dynamic leadership failover.

### Step 4: Launch Node (Interactive Setup + Daemon Mode)

#### Step 4A: First Time Setup (Interactive)
```bash
# Initial interactive setup (required once per server)
docker run -it --name qnet-node-setup --rm \
  -p 9876:9876 -p 9877:9877 -p 8001:8001 \
  -v $(pwd)/node_data:/app/node_data \
  qnet-production

# Follow the interactive setup:
# 1. Select node type (Full Node=1, Super Node=2 for servers)
# 2. Enter activation code (format: QNET-XXXX-XXXX-XXXX)
# 3. Node will show daemon management commands
# 4. Press Enter to continue or Ctrl+C to setup daemon mode

# After setup, you'll see instructions for proper daemon mode
```

#### Step 4B: Production Daemon Mode (24/7 Operation)
```bash
# Option 1: Docker Daemon (Recommended)
docker run -d --name qnet-node --restart=always \
  -p 9876:9876 -p 9877:9877 -p 8001:8001 \
  -v $(pwd)/node_data:/app/node_data \
  qnet-production

# Option 2: Native Daemon (Advanced)
nohup ./target/release/qnet-node > qnet-node.log 2>&1 &
```

### Step 4C: Complete Production Workflow
```bash
# 1. Clean previous installations
docker stop qnet-node 2>/dev/null || true
docker rm qnet-node 2>/dev/null || true

# 2. Run interactive setup (first time only)
docker run -it --name qnet-node-setup --rm \
  -p 9876:9876 -p 9877:9877 -p 8001:8001 \
  -v $(pwd)/node_data:/app/node_data \
  qnet-production

# 3. After setup completes, start in daemon mode
docker run -d --name qnet-node --restart=always \
  -p 9876:9876 -p 9877:9877 -p 8001:8001 \
  -v $(pwd)/node_data:/app/node_data \
  qnet-production

# ✅ Node now runs 24/7 in background with auto-restart
```

### Step 5: Node Management & Monitoring

#### Docker Daemon Management (Default)
```bash
# View real-time logs
docker logs qnet-node -f
# Press Ctrl+C to exit log viewer (node continues running)

# Check node status and health
curl http://localhost:9877/api/v1/status
curl http://localhost:8001/api/v1/info

# Monitor peer connections
curl http://localhost:8001/api/v1/peers

# Check blockchain height
curl http://localhost:9877/api/v1/height

# Stop node
docker stop qnet-node

# Restart node (preserves configuration)
docker restart qnet-node

# View container status
docker ps | grep qnet-node
```

#### Native Daemon Management (Advanced)
```bash
# Start native daemon
nohup ./target/release/qnet-node > qnet-node.log 2>&1 &

# View logs
tail -f qnet-node.log
# Press Ctrl+C to exit log viewer (node continues running)

# Check process status
ps aux | grep qnet-node

# Monitor log file size
ls -lh qnet-node.log

# Stop node
pkill -f qnet-node

# Restart node
nohup ./target/release/qnet-node > qnet-node.log 2>&1 &
```

#### Health Monitoring Commands
```bash
# Complete node health check
echo "=== QNet Node Health Check ===" && \
curl -s http://localhost:9877/api/v1/status | jq . && \
echo -e "\n=== Peer Connections ===" && \
curl -s http://localhost:8001/api/v1/peers | jq length && \
echo -e "\n=== Blockchain Height ===" && \
curl -s http://localhost:9877/api/v1/height

# Check if all required ports are open
netstat -tuln | grep -E ':(9876|9877|8001)'

# View recent logs (last 50 lines)
docker logs qnet-node --tail 50
```

### Step 6: Server Replacement & Failover (Production)

#### Replacing Genesis Servers (Zero Downtime)
```bash
# Option 1: Same IP replacement (Recommended)
# 1. Setup new server with same IP as old one
# 2. Run standard installation (Steps 1-4)
# 3. Network automatically recognizes and restores leadership

# Option 2: Different IP replacement  
# 1. Update genesis node IPs in network configuration
# 2. Deploy updated config to all nodes
# 3. Restart nodes to load new configuration
```

#### Testing Failover
```bash
# Simulate Primary Leader failure
docker stop qnet-node  # On 154.38.160.39

# Check logs on Backup Leader (62.171.157.44)
docker logs qnet-node -f
# Expected: "[LEADERSHIP] 🔄 LEADERSHIP CHANGE: 154.38.160.39 -> 62.171.157.44 (Priority 2)"

# Restore Primary Leader  
docker start qnet-node  # On 154.38.160.39

# Check logs - leadership should return to Primary
# Expected: "[LEADERSHIP] 🔄 LEADERSHIP CHANGE: 62.171.157.44 -> 154.38.160.39 (Priority 1)"
```

#### Network Health Monitoring
```bash
# Check current leader
curl http://localhost:9877/api/v1/leader

# Monitor leadership changes
docker logs qnet-node -f | grep "LEADERSHIP"

# Check failover readiness
curl http://localhost:9877/api/v1/consensus/health
```

## 🏗️ Node Types & Architecture

### **Server Nodes (Full/Super)**
```bash
# Server deployment only
docker run -it --name qnet-node --restart=always \
  -p 9876:9876 -p 8001:8001 \
  -v $(pwd)/node_data:/app/node_data \
  qnet-node:latest
```

**Features:**
- ✅ **Full blockchain validation**
- ✅ **REST API endpoints** (`http://localhost:8001/api/v1/`)
- ✅ **P2P network participation**
- ✅ **Automatic peer discovery**
- ✅ **Consensus participation**

### **Mobile Nodes (Light)**
```bash
# Mobile app deployment only
# Download QNet Mobile App from App Store/Play Store
# Activate through mobile interface
```

**Features:**
- ✅ **Lightweight validation**
- ✅ **Mobile-optimized**
- ✅ **Battery-efficient**
- ❌ **No API endpoints**
- ❌ **No server deployment**

### **Node Discovery Process**

**How nodes find each other:**
1. **Local Network**: Automatic scanning of subnet (192.168.x.x)
2. **DNS Seeds**: Lookup of bootstrap.qnet.network, node1.qnet.network
3. **Bootstrap Nodes**: Connection to hardcoded nodes (95.164.7.199, 173.212.219.226)
4. **Manual Configuration**: Optional `QNET_PEER_IPS` environment variable
5. **Peer Sharing**: Nodes share discovered peers with each other

**Network Hierarchy:**
```
Internet
   ↓
Super Nodes (Servers) - Core mesh network
   ↓
Full Nodes (Servers) - Regional validators
   ↓
Light Nodes (Mobile) - End users
```

## 🔐 Node Activation

### **Activation Code Format**
```bash
# Valid activation codes MUST use this format:
QNET-XXXX-XXXX-XXXX

# Examples:
QNET-1234-5678-9012
QNET-A1B2-C3D4-E5F6
```

### **Phase 1: 1DEV Token Burn (Current)**
```bash
# Universal pricing for all node types:
Light Node:  1,500 1DEV → 150 1DEV (decreases as tokens burned)
Full Node:   1,500 1DEV → 150 1DEV (decreases as tokens burned)
Super Node:  1,500 1DEV → 150 1DEV (decreases as tokens burned)

# Price reduction mechanism:
# 0% burned: 1,500 1DEV per node
# 50% burned: ~750 1DEV per node  
# 90% burned: 150 1DEV per node (minimum)
```

### **Interactive Setup Process**
```bash
# When you run the node, you'll see:
🚀 === QNet Production Node Setup === 🚀
🖥️  SERVER DEPLOYMENT MODE

📊 Phase 1: Universal activation cost
💰 Current cost: 1,500 1DEV (burn)
⚖️  Same price for all node types

🔧 Select node type:
[1] Full Node - Complete validation + API
[2] Super Node - Enhanced validation + API

🔐 Enter activation code (format: QNET-XXXX-XXXX-XXXX):
```

### **Node Activation Examples**

**Full Node Activation:**
```bash
docker run -it --name qnet-full-node --restart=always \
  -p 9876:9876 -p 8001:8001 \
  -v $(pwd)/node_data:/app/node_data \
  qnet-node:latest

# In interactive menu:
# 1. Choose [1] Full Node
# 2. Enter: QNET-1234-5678-9012
# 3. Confirm: ✅ Node activated successfully
```

**Super Node Activation:**
```bash
docker run -it --name qnet-super-node --restart=always \
  -p 9876:9876 -p 8001:8001 \
  -v $(pwd)/node_data:/app/node_data \
  qnet-node:latest

# In interactive menu:
# 1. Choose [2] Super Node
# 2. Enter: QNET-A1B2-C3D4-E5F6
# 3. Confirm: ✅ Node activated successfully
```

## 🚀 Quick Installation Guide (Simplified)

### Docker Cleanup Commands (if needed)

```bash
# Clean up failed builds and cache
docker system prune -f
docker builder prune -f
docker image prune -f

# Remove all stopped containers
docker container prune -f

# Remove all unused images
docker image prune -a -f

# Complete cleanup (WARNING: removes all unused Docker data)
docker system prune -a -f
```

### One-Command Installation (Production Ready)

```bash
# 1. Install dependencies
apt update && apt install -y curl git
curl -fsSL https://get.docker.com | sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

# 2. Restart terminal or:
source ~/.cargo/env

# 3. Build QNet
git clone https://github.com/AIQnetLab/QNet-Blockchain.git
cd QNet-Blockchain && git checkout testnet

# 4. Pull latest changes
git pull origin testnet

# 5. Build with latest Rust (requires rebuild after updates)
cargo build --release

# 6. Build Docker image (uses Rust 1.86 - latest production)
docker build -f Dockerfile.production -t qnet-production .

# 7. Stop and remove old container if exists
docker stop qnet-node || true
docker rm qnet-node || true

# 8. Launch node in interactive mode for initial setup
docker run -it --name qnet-node --restart=always \
  -p 9876:9876 -p 9877:9877 -p 8001:8001 \
  -v $(pwd)/node_data:/app/node_data \
  qnet-production

# Note: Interactive setup will prompt for:
# - Node type selection (Full/Super for servers)
# - Activation code input (format: QNET-XXXX-XXXX-XXXX or DEV_XXX)
# - Network configuration (auto-configured)

# 9. After setup, restart in background mode
docker restart qnet-node
```

## 🌐 Automatic Node Discovery

**QNet nodes automatically discover each other on the network!**

### Method 1: Local Network Discovery (Automatic)
Nodes running on the same local network will automatically discover each other:

```bash
# Start first node
docker run -d --name qnet-node1 --restart=always \
  -p 9876:9876 -p 8001:8001 \
  -v $(pwd)/node1_data:/app/node_data \
  qnet-production

# Start second node (will automatically discover first node)
docker run -d --name qnet-node2 --restart=always \
  -p 9877:9876 -p 8002:8001 \
  -v $(pwd)/node2_data:/app/node_data \
  qnet-production

# Start third node (will automatically discover other nodes)
docker run -d --name qnet-node3 --restart=always \
  -p 9878:9876 -p 8003:8001 \
  -v $(pwd)/node3_data:/app/node_data \
  qnet-production
```

### Method 2: Internet-Wide Discovery (Automatic + Manual)
For nodes on different servers across the internet:

#### **🌐 Automatic Discovery (No IP needed!)**
```bash
# Server 1 - First node (automatic DNS seeds + bootstrap nodes)
docker run -d --name qnet-node --restart=always \
  -p 9876:9876 -p 8001:8001 \
  -v $(pwd)/node_data:/app/node_data \
  qnet-production

# Server 2 - Automatic discovery (finds other nodes via DNS/bootstrap)
docker run -d --name qnet-node --restart=always \
  -p 9876:9876 -p 8001:8001 \
  -v $(pwd)/node_data:/app/node_data \
  qnet-production

# Server 3 - Also automatic discovery
docker run -d --name qnet-node --restart=always \
  -p 9876:9876 -p 8001:8001 \
  -v $(pwd)/node_data:/app/node_data \
  qnet-production
```

#### **🎯 Manual Peer Configuration (Faster connection)**
```bash
# Server 1 (IP: 1.2.3.4) - First node
docker run -d --name qnet-node --restart=always \
  -p 9876:9876 -p 8001:8001 \
  -v $(pwd)/node_data:/app/node_data \
  qnet-production

# Server 2 (IP: 5.6.7.8) - Connect to Server 1
docker run -d --name qnet-node --restart=always \
  -p 9876:9876 -p 8001:8001 \
  -e QNET_PEER_IPS="1.2.3.4" \
  -v $(pwd)/node_data:/app/node_data \
  qnet-production

# Server 3 (IP: 9.10.11.12) - Connect to both servers
docker run -d --name qnet-node --restart=always \
  -p 9876:9876 -p 8001:8001 \
  -e QNET_PEER_IPS="1.2.3.4,5.6.7.8" \
  -v $(pwd)/node_data:/app/node_data \
  qnet-production
```

### Discovery Features

**Automatic Discovery Methods:**
- **Local Network Scanning**: Nodes scan subnet (192.168.x.x) for other QNet nodes
- **Port Discovery**: Checks common QNet ports (9876-9880) automatically  
- **DNS Seeds**: Automatic lookup of bootstrap.qnet.network, node1.qnet.network, etc.
- **Bootstrap Nodes**: Connects to hardcoded known QNet nodes (95.164.7.199, 173.212.219.226)
- **External IP Detection**: Nodes announce their external IP for internet connectivity
- **Passive Discovery**: Nodes can announce themselves and wait for connections
- **Dynamic Peer Lists**: Nodes share discovered peers with each other

**Manual Configuration (Optional):**
```bash
# Specify exact peer IPs for faster connection
-e QNET_PEER_IPS="server1.example.com:9876,server2.example.com:9876"

# Or use IP addresses directly
-e QNET_PEER_IPS="95.164.7.199:9876,173.212.219.226:9876"
```

**Connection Verification:**
```bash
# Check node's discovered peers
docker exec qnet-node curl -s http://localhost:8001/api/peers | jq

# Monitor automatic discovery process
docker logs qnet-node | grep "🔍 Discovered QNet node"          # Local discovery
docker logs qnet-node | grep "🌐 Found QNet node via DNS"       # DNS seeds
docker logs qnet-node | grep "🔗 Connected to hardcoded"        # Bootstrap nodes
docker logs qnet-node | grep "🎯 No external nodes found"       # Passive mode
docker logs qnet-node | grep "🌐 External IP detected"          # IP announcement

# Check manual peer configuration (if used)
docker logs qnet-node | grep "🌐 Using provided peer IPs"

# Monitor internet discovery methods
docker logs qnet-node | grep "🌍 No local nodes found, trying internet"
```

### Alternative Installation (if Docker fails)

```bash
# 4. Pull latest changes
git pull origin testnet

# 5. Build with latest Rust from project root
cargo build --release --bin qnet-node

# 6. Build Docker image with correct path
docker build -f development/qnet-integration/Dockerfile.production -t qnet-production .
```

### Step-by-Step Commands for Complete Deployment

```bash
# 1. Get latest changes
cd ~/QNet-Blockchain
git pull origin testnet

# 2. Stop and remove old container
docker stop qnet-node || true
docker rm qnet-node || true
docker rmi qnet-production || true

# 3. Build new production container
docker build -f development/qnet-integration/Dockerfile.production -t qnet-production .

# 4. Launch container in interactive mode
docker run -it --name qnet-node --restart=always \
  -p 9876:9876 -p 9877:9877 -p 8001:8001 \
  -v $(pwd)/node_data:/app/node_data \
  qnet-production

# 5. Follow the interactive setup:
#    - Select node type (Full/Super for servers)
#    - Enter activation code (QNET-XXXX-XXXX-XXXX or DEV_XXX)
#    - Node will start automatically after setup

# 6. To access running container (in another terminal)
docker exec -it qnet-node /bin/bash

# 7. View logs
docker logs -f qnet-node
```

### Quick Monitoring Commands

```bash
# Check status
docker ps
docker logs -f qnet-node

# Health check
curl http://localhost:9877/health

# Node info
curl http://localhost:9877/info

# Check P2P connections
curl http://localhost:9877/peers
```

---

## 📖 Complete Documentation

## Node Hardware Requirements

### Light Nodes (Mobile Only)
**Device Requirements:**
- **CPU**: ARM64 or x86_64 mobile processor (minimum 4 cores)
- **RAM**: 4 GB minimum (8 GB recommended)
- **Storage**: 8 GB available space minimum (16 GB recommended)
- **Network**: 4G/5G or WiFi connection (minimum 10 Mbps)
- **OS**: Android 8.0+ / iOS 12.0+ / iPadOS 13.0+
- **Devices**: Smartphones, tablets (NOT servers/desktops)

### Full Nodes (Server/Desktop Only)
**Minimum Specifications:**
- **CPU**: 4 cores (8 threads recommended) - Intel i5/AMD Ryzen 5 or higher
- **RAM**: 8 GB minimum (16 GB recommended)
- **Storage**: 100 GB SSD (500 GB recommended for blockchain growth)
- **Network**: 100 Mbps connection, static IP preferred
- **OS**: Ubuntu 20.04+ LTS, Windows 10+, macOS 10.15+
- **Devices**: Servers, VPS, desktops, laptops

### Super Nodes (High-Performance Server Only)
**Minimum Specifications:**
- **CPU**: 8 cores (16 threads recommended) - Intel Xeon/AMD EPYC preferred
- **RAM**: 32 GB minimum (64 GB recommended)
- **Storage**: 1 TB NVMe SSD (2 TB recommended)
- **Network**: 1 Gbps connection, static IP required
- **OS**: Ubuntu 22.04 LTS (clean installation)
- **Devices**: Dedicated servers, high-performance VPS only

## Step 1: Initial Server Setup

### Update System
```bash
# Update package list and upgrade system
sudo apt update && sudo apt upgrade -y

# Install essential packages
sudo apt install -y curl wget git htop nano ufw fail2ban

# Configure timezone
sudo timedatectl set-timezone UTC

# Set up firewall
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow ssh
sudo ufw allow 9876  # P2P port
sudo ufw allow 9877  # RPC port
sudo ufw --force enable
```

### Create QNet User
```bash
# Create dedicated user for QNet
sudo adduser qnet

# Add to docker group (will be created later)
sudo usermod -aG sudo qnet

# Switch to qnet user
sudo su - qnet
```

## Step 2: Install Docker

### Install Docker Engine
```bash
# Remove old Docker versions
sudo apt remove docker docker-engine docker.io containerd runc

# Install dependencies
sudo apt install -y apt-transport-https ca-certificates curl gnupg lsb-release

# Add Docker GPG key
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg

# Add Docker repository
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install Docker
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io

# Add user to docker group
sudo usermod -aG docker qnet

# Start and enable Docker
sudo systemctl start docker
sudo systemctl enable docker

# Logout and login again to apply group changes
exit
sudo su - qnet
```

### Verify Docker Installation
```bash
# Test Docker
docker --version
docker run hello-world
```

## Step 3: Clone QNet Repository

### Clone and Setup
```bash
# Clone the repository
git clone https://github.com/AIQnetLab/QNet-Blockchain.git
cd QNet-Blockchain

# Switch to testnet branch
git checkout testnet

# Pull latest changes
git pull origin testnet

# Verify we have the latest production fixes
git log --oneline -n 5
```

## Step 4: Build Production Docker Image

### Build QNet Node
```bash
# Build production Rust binaries
cd development/qnet-integration
cargo build --release

# Verify build success
ls -la development/qnet-integration/target/release/qnet-node
```

### Expected Build Output
```
✅ qnet-node binary ready for production
```

### Production Deployment Architecture

**CRITICAL:** QNet uses fully decentralized architecture with interactive activation.

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│ Web/Mobile Apps │    │   QNet Wallet   │    │   CLI Tools     │
│ (browsers)      │    │   (extension)   │    │   (terminal)    │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 │
                     ┌───────────┼───────────┐
                     │           │           │
           ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
           │   Full Node 1   │ │   Full Node 2   │ │   Super Node 1  │
           │   API: 8001     │ │   API: 8002     │ │   API: 8003     │
           │   RPC: 9877     │ │   RPC: 9879     │ │   RPC: 9881     │
           │   P2P: 9876     │ │   P2P: 9878     │ │   P2P: 9880     │
           └─────────────────┘ └─────────────────┘ └─────────────────┘
```

### Launch QNet Nodes (Interactive Setup Required)

**CRITICAL:** Each node requires interactive activation with activation codes. Only Full and Super nodes can be activated on servers.

**🖥️ SERVER RESTRICTIONS:**
- ✅ **Full Nodes**: Can be activated on servers via interactive menu
- ✅ **Super Nodes**: Can be activated on servers via interactive menu
- ❌ **Light Nodes**: CANNOT be activated on servers (mobile devices only)

**📱 MOBILE RESTRICTIONS:**
- ✅ **Light Nodes**: Can ONLY be activated on mobile devices
- ❌ **Full Nodes**: Cannot be activated on mobile devices
- ❌ **Super Nodes**: Cannot be activated on mobile devices

```bash
# Launch first node - NO ENVIRONMENT VARIABLES
docker run -d \
  --name qnet-node-1 \
  --restart=always \
  -p 9876:9876 \
  -p 9877:9877 \
  -p 8001:8001 \
  -v $(pwd)/node_data:/opt/qnet/node_data \
  qnet-production

# Launch second node - NO ENVIRONMENT VARIABLES
docker run -d \
  --name qnet-node-2 \
  --restart=always \
  -p 9878:9878 \
  -p 9879:9879 \
  -p 8002:8002 \
  -v $(pwd)/node2_data:/opt/qnet/node_data \
  qnet-production

# Launch third node - NO ENVIRONMENT VARIABLES
docker run -d \
  --name qnet-node-3 \
  --restart=always \
  -p 9880:9880 \
  -p 9881:9881 \
  -p 8003:8003 \
  -v $(pwd)/node3_data:/opt/qnet/node_data \
  qnet-production
```

**INTERACTIVE ACTIVATION REQUIRED:**
Each node will present an interactive menu where you must:
1. Enter activation code (QNET-XXXX-XXXX-XXXX)
2. Select node type (Full/Super only on servers)
3. Confirm detected region
4. Confirm network ports
5. Complete cryptographic setup

**NO AUTOMATIC CONFIGURATION** - All settings determined through interactive menu!

### Multiple Nodes for High Availability

```bash
# Run multiple production nodes (ONLY METHOD)
docker run -it --name qnet-node-1 --restart=always \
  -p 9876:9876 -p 9877:9877 -p 8001:8001 \
  -v $(pwd)/node1_data:/app/node_data \
  qnet-production

# Run second node on different ports
docker run -it --name qnet-node-2 --restart=always \
  -p 9878:9876 -p 9879:9877 -p 8002:8001 \
  -v $(pwd)/node2_data:/app/node_data \
  qnet-production

# Run third node on different ports  
docker run -it --name qnet-node-3 --restart=always \
  -p 9880:9876 -p 9881:9877 -p 8003:8001 \
  -v $(pwd)/node3_data:/app/node_data \
  qnet-production
```

**IMPORTANT:** Each node must be activated through its own interactive menu session. No environment variables or automatic configuration allowed!

### Activation Code Requirements

**CRITICAL:** Valid activation codes are required for production node deployment

**Two-Phase System:**
- **Phase 1**: 1DEV burn on Solana → Universal pricing (1500→150 1DEV)
- **Phase 2**: QNC to Pool 3 → Dynamic pricing (5k-30k QNC)

**Code Format:** QNET-XXXX-XXXX-XXXX (17 characters)
**Node Type Binding:** 
- QNET-L... = Light node (mobile only)
- QNET-F... = Full node (server only)
- QNET-S... = Super node (server only)

**Validation:** Codes are validated against Solana/QNet blockchain
**Single Use:** Each activation code can only be used once
**Network Phase:** Codes are valid for specific network phases

### Node Configuration Process

Each **server** node goes through this activation process:

1. **Code Validation**: Activation code is verified against blockchain
2. **Economic Phase Detection**: System detects current network phase (1 or 2)
3. **Node Type Selection**: User selects Full or Super (Light blocked)
4. **Region Detection**: Network region is auto-detected
5. **Port Configuration**: Ports are auto-configured or manually set
6. **Blockchain Sync**: Node begins synchronization with network
7. **API Server Launch**: REST API endpoints become available (Full/Super only)

### Light Node Activation (Mobile Only)

**Light nodes cannot be activated on servers.** Use mobile app:

1. Install QNet Mobile App
2. Import/Create wallet
3. Select Light node activation
4. Complete Phase 1 (1DEV burn) or Phase 2 (QNC to Pool 3)
5. Receive activation code
6. Light node runs on mobile device with no API server

### Verify Decentralized Network

```bash
# Check server node health (Full/Super only)
curl http://localhost:8001/api/v1/node/health
curl http://localhost:8002/api/v1/node/health
curl http://localhost:8003/api/v1/node/health

# Discover all available nodes
curl http://localhost:8001/api/v1/nodes/discovery

# Test API endpoints on any server node
curl http://localhost:8001/api/v1/block/latest
curl http://localhost:8002/api/v1/mempool/status
curl http://localhost:8003/api/v1/gas/recommendations

# Submit transaction to any server node
curl -X POST http://localhost:8001/api/v1/transaction \
  -H "Content-Type: application/json" \
  -d '{"from":"addr1","to":"addr2","amount":1000,"gas_price":10,"gas_limit":21000,"nonce":1}'
```

### Production Systemd Services

**IMPORTANT:** All nodes must be activated interactively before creating systemd services.

```bash
# Create systemd service for Node 1 (after interactive activation)
sudo tee /etc/systemd/system/qnet-node-1.service > /dev/null <<EOF
[Unit]
Description=QNet Blockchain Node 1
After=docker.service
Requires=docker.service

[Service]
Type=simple
User=qnet
Group=qnet
Restart=always
RestartSec=10
ExecStart=/usr/bin/docker start -a qnet-node-1
ExecStop=/usr/bin/docker stop qnet-node-1

[Install]
WantedBy=multi-user.target
EOF

# Create systemd service for Node 2 (after interactive activation)
sudo tee /etc/systemd/system/qnet-node-2.service > /dev/null <<EOF
[Unit]
Description=QNet Blockchain Node 2
After=docker.service
Requires=docker.service

[Service]
Type=simple
User=qnet
Group=qnet
Restart=always
RestartSec=10
ExecStart=/usr/bin/docker start -a qnet-node-2
ExecStop=/usr/bin/docker stop qnet-node-2

[Install]
WantedBy=multi-user.target
EOF
```

### Node Types and Activation

**Full Node (Server):**
- Complete blockchain data and validation
- REST API server on port 8001
- Activation code: QNET-FXXX-XXXX-XXXX
- Can be activated on servers

**Super Node (Server):**
- All Full node features + enhanced capabilities
- REST API server on port 8001
- Activation code: QNET-SXXX-XXXX-XXXX
- Can be activated on servers

**Light Node (Mobile):**
- Basic blockchain sync and wallet functionality
- NO API server, NO public endpoints
- Activation code: QNET-LXXX-XXXX-XXXX
- Can ONLY be activated on mobile devices

### Manual Setup (Alternative)

**CRITICAL:** Interactive activation is required for all nodes.

```bash
# Navigate to project directory
cd /opt/qnet-blockchain/development/qnet-integration

# Launch node - INTERACTIVE ACTIVATION REQUIRED
./target/release/qnet-node

# Interactive menu will guide you through:
# 1. Enter activation code (QNET-XXXX-XXXX-XXXX)
# 2. Select node type (Full/Super only on servers)
# 3. Confirm detected region
# 4. Automatic port selection
# 5. Complete activation process
```

**Node Configuration:**
- Full/Super nodes provide complete functionality
- API server automatically starts after activation
- All ports determined during interactive setup
- Region detection and peer discovery automatic

### Troubleshooting Activation

**Common Issues:**
- Invalid activation code format
- Code already used
- Network phase mismatch
- Port conflicts
- Region detection failure
- Trying to activate Light node on server

**Solutions:**
```bash
# Check activation code format
echo "QNET-XXXX-XXXX-XXXX" | grep -E "^QNET-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$"

# Check port availability
netstat -lan | grep :9876
netstat -lan | grep :9877
netstat -lan | grep :8001

# Manual region override
QNET_REGION=Europe ./target/release/qnet-node

# Check node type compatibility
# Light nodes: Use mobile app only
# Full/Super nodes: Use server deployment only
```

### Architecture Benefits

✅ **Fully Decentralized**: Multiple nodes provide API access
✅ **High Availability**: If one node fails, others continue
✅ **Load Distribution**: API traffic spread across server nodes
✅ **Censorship Resistant**: Cannot block all nodes
✅ **Scalable**: More server nodes = more API capacity
✅ **Self-Healing**: Network discovers and routes around failures
✅ **Interactive Setup**: User-friendly activation process
✅ **Secure Activation**: Code-based node authorization
✅ **Device-Appropriate**: Light nodes on mobile, Full/Super on servers

### Client Integration

Applications should use multiple server node endpoints for redundancy:

```javascript
// Example client-side failover (server nodes only)
const qnetNodes = [
    'http://node1.example.com:8001',  // Full node
    'http://node2.example.com:8002',  // Super node
    'http://node3.example.com:8003'   // Full node
];

async function qnetApiCall(endpoint, data = null) {
    for (const nodeUrl of qnetNodes) {
        try {
            const url = `${nodeUrl}/api/v1/${endpoint}`;
            const options = data ? {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(data)
            } : {method: 'GET'};
            
            const response = await fetch(url, options);
            if (response.ok) {
                return await response.json();
            }
        } catch (error) {
            console.log(`Server node ${nodeUrl} unavailable, trying next...`);
        }
    }
    throw new Error('All QNet server nodes unavailable');
}

// Usage examples (server nodes only)
const balance = await qnetApiCall('account/ADDRESS/balance');
const block = await qnetApiCall('block/latest');
const txHash = await qnetApiCall('transaction', {
    from: 'addr1',
    to: 'addr2', 
    amount: 1000,
    gas_price: 10,
    gas_limit: 21000,
    nonce: 1
});
```

**Note:** Light nodes do not provide API endpoints and cannot be included in client failover logic.

### Distributed API Access

**Every Full/Super node provides complete REST API functionality:**
- Node 1: `http://localhost:8001/api/v1/`
- Node 2: `http://localhost:8002/api/v1/`
- Node 3: `http://localhost:8003/api/v1/`

**Multi-node architecture provides maximum availability and performance!**

## Advanced Monitoring Commands

### Container Management
```bash
# Stop node
docker stop qnet-node

# Start node
docker start qnet-node

# Restart node
docker restart qnet-node

# Remove container (data preserved)
docker rm qnet-node

# View container details
docker inspect qnet-node
```

### Performance Monitoring
```bash
# Real-time resource usage
docker exec -it qnet-node top

# Network connections
docker exec -it qnet-node netstat -tulpn

# Disk usage inside container
docker exec -it qnet-node df -h
```

### Log Analysis
```bash
# View recent logs
docker logs --tail 100 qnet-node

# Follow logs with timestamps
docker logs -f -t qnet-node

# Search logs for errors
docker logs qnet-node 2>&1 | grep -i error

# Export logs to file
docker logs qnet-node > qnet-node.log 2>&1
```

## Troubleshooting Commands

### Network Issues
```bash
# Test P2P connectivity
telnet localhost 9876

# Test RPC connectivity
curl -X POST http://localhost:9877 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"node_info","id":1}'

# Test API connectivity
curl -v http://localhost:8001/api/v1/node/health
```

### Performance Issues
```bash
# Check system resources
htop
free -h
df -h

# Check Docker resources
docker system df
docker system prune -f

# Monitor network traffic
iftop
```

### Node Synchronization
```bash
# Check sync status
curl http://localhost:8001/api/v1/node/info | grep -i sync

# Force resync (if needed)
docker exec -it qnet-node ./target/release/qnet-node --resync
```

## Production Maintenance

### Regular Health Checks
```bash
# Create health check script
cat > health_check.sh << 'EOF'
#!/bin/bash
for port in 8001 8002 8003; do
  if curl -s http://localhost:$port/api/v1/node/health > /dev/null; then
    echo "✅ Node on port $port is healthy"
  else
    echo "❌ Node on port $port is down"
  fi
done
EOF

chmod +x health_check.sh
./health_check.sh
```

### Automated Backups
```bash
# Create backup script
cat > backup_nodes.sh << 'EOF'
#!/bin/bash
DATE=$(date +%Y%m%d_%H%M%S)
mkdir -p backups
tar -czf backups/qnet-backup-$DATE.tar.gz node_data/ node2_data/ node3_data/
echo "Backup created: backups/qnet-backup-$DATE.tar.gz"
EOF

chmod +x backup_nodes.sh
./backup_nodes.sh
```

### Update Procedure
```bash
# Stop nodes
docker stop qnet-node-1 qnet-node-2 qnet-node-3

# Update code
git pull origin testnet
cargo build --release
docker build -t qnet-production -f Dockerfile.production .

# Start nodes
docker start qnet-node-1 qnet-node-2 qnet-node-3
```

## Security Best Practices

### Firewall Configuration
```bash
# Basic firewall setup
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw allow 9876:9885/tcp  # P2P ports
ufw allow 9877:9887/tcp  # RPC ports  
ufw allow 8001:8010/tcp  # API ports
ufw --force enable
```

### System Monitoring
```bash
# Install monitoring tools
apt install -y htop iftop nethogs

# Monitor system continuously
watch -n 5 'docker stats --no-stream'
```
**⚠️ IMPORTANT NOTES:**
- All nodes require interactive activation with valid codes
- Only Full/Super nodes can run on servers
- Light nodes are mobile-only
- Each node provides identical API endpoints
- Use multiple nodes for high availability
- Regular backups are essential for production 
