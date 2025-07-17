# QNet Production Server Setup Guide

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

# 6. Build Docker image (uses Rust 1.85 - supports edition2024)
docker build -t qnet-production -f development/Dockerfile .

# 7. Launch node
docker run -d --name qnet-node --restart=always \
  -p 9876:9876 -p 9877:9877 -p 8001:8001 \
  -v $(pwd)/node_data:/opt/qnet/node_data \
  qnet-production

# 8. Activate node (INTERACTIVE REQUIRED)
docker exec -it qnet-node /bin/bash
/usr/local/bin/qnet-node
```

### Alternative Installation (if Docker fails)

```bash
# 4. Pull latest changes
git pull origin testnet

# 5. Build with Rust 1.85 (for edition2024 support)
rustup toolchain install 1.85.0
rustup default 1.85.0
cargo build --release

# 6. Build Docker image
docker build -t qnet-production -f development/Dockerfile .
```

### Quick Monitoring Commands

```bash
# Check status
docker ps
docker logs -f qnet-node

# Health check
curl http://localhost:8001/api/v1/node/health

# Node info
curl http://localhost:8001/api/v1/node/info
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
# Connect to first node container for interactive activation
docker exec -it qnet-node-1 /bin/bash
./target/release/qnet-node
# Interactive menu will appear - enter activation code and configure

# Connect to second node container for interactive activation  
docker exec -it qnet-node-2 /bin/bash
./target/release/qnet-node
# Interactive menu will appear - enter activation code and configure

# Connect to third node container for interactive activation
docker exec -it qnet-node-3 /bin/bash
./target/release/qnet-node
# Interactive menu will appear - enter activation code and configure
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
docker build -t qnet-production -f development/Dockerfile .

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