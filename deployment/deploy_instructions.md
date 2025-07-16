# QNet Production Server Setup Guide

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

**WARNING:** Docker is NOT recommended for production due to interactive activation requirements.

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
# Terminal 1 - First node (Full or Super only)
cd development/qnet-integration
./target/release/qnet-node

# Interactive setup will prompt for:
# 1. Activation code (format: QNET-XXXX-XXXX-XXXX) 
# 2. Node type selection (Full/Super only on servers)
# 3. Region auto-detection confirmation
# 4. Network configuration

# Example activation flow:
# > Enter activation code: QNET-F234-5678-9012
# > Select node type: [1] Full [2] Super (Light not available on servers)
# > Detected region: Europe [Y/n]
# > P2P port: 9876 (auto-detected)
# > RPC port: 9877 (auto-detected)  
# > API port: 8001 (auto-detected)

# After successful activation:
# - API server starts on port 8001 (Full/Super only)
# - RPC server starts on port 9877
# - P2P networking on port 9876
# - Node begins blockchain synchronization
```

### Multiple Nodes for High Availability

```bash
# Terminal 2 - Second node (Full/Super only)
QNET_P2P_PORT=9878 QNET_RPC_PORT=9879 QNET_API_PORT=8002 ./target/release/qnet-node
# Enter activation code: QNET-YYYY-YYYY-YYYY
# Select node type: Full or Super (Light not available)

# Terminal 3 - Third node (Full/Super only)
QNET_P2P_PORT=9880 QNET_RPC_PORT=9881 QNET_API_PORT=8003 ./target/release/qnet-node
# Enter activation code: QNET-ZZZZ-ZZZZ-ZZZZ
# Select node type: Full or Super (Light not available)
```

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

For production deployment with auto-restart:

```bash
# Node 1 Service (Full node)
sudo tee /etc/systemd/system/qnet-node-1.service > /dev/null <<EOF
[Unit]
Description=QNet Blockchain Node 1 (Full)
After=network.target

[Service]
Type=simple
User=qnet
Group=qnet
WorkingDirectory=/opt/qnet-node
ExecStart=/opt/qnet-node/target/release/qnet-node
Restart=always
RestartSec=10
Environment=RUST_LOG=info
Environment=QNET_ACTIVATION_CODE=QNET-FXXX-XXXX-XXXX
Environment=QNET_P2P_PORT=9876
Environment=QNET_RPC_PORT=9877
Environment=QNET_API_PORT=8001

[Install]
WantedBy=multi-user.target
EOF

# Node 2 Service (Super node)
sudo tee /etc/systemd/system/qnet-node-2.service > /dev/null <<EOF
[Unit]
Description=QNet Blockchain Node 2 (Super)
After=network.target

[Service]
Type=simple
User=qnet
Group=qnet
WorkingDirectory=/opt/qnet-node
ExecStart=/opt/qnet-node/target/release/qnet-node
Restart=always
RestartSec=10
Environment=RUST_LOG=info
Environment=QNET_ACTIVATION_CODE=QNET-SXXX-XXXX-XXXX
Environment=QNET_P2P_PORT=9878
Environment=QNET_RPC_PORT=9879
Environment=QNET_API_PORT=8002

[Install]
WantedBy=multi-user.target
EOF

# Enable and start services
sudo systemctl daemon-reload
sudo systemctl enable qnet-node-1 qnet-node-2
sudo systemctl start qnet-node-1 qnet-node-2

# Check status
sudo systemctl status qnet-node-1
sudo systemctl status qnet-node-2
```

### Interactive vs Environment Variables

**Interactive Mode (Recommended for Development):**
```bash
# Run without environment variables
./target/release/qnet-node
# Follow interactive prompts for activation
# Node type selection: Full or Super only
```

**Environment Variable Mode (Production):**
```bash
# Pre-configure activation
export QNET_ACTIVATION_CODE=QNET-FXXX-XXXX-XXXX
export QNET_P2P_PORT=9876
export QNET_RPC_PORT=9877
export QNET_API_PORT=8001
./target/release/qnet-node
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

✅ **Fully Decentralized**: No single point of failure
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

## Step 5: Configure Node

### Create Data Directory
```bash
# Create directories for node data
mkdir -p ~/qnet-data/{data,logs,config}

# Set proper permissions
chmod 755 ~/qnet-data
chmod 755 ~/qnet-data/data
chmod 755 ~/qnet-data/logs
chmod 755 ~/qnet-data/config
```

### Generate Wallet Key (1DEV Token Required)
```bash
# You need a 1DEV wallet private key for burn verification
# If you don't have one, create it on Solana first
echo "YOUR_1DEV_WALLET_PRIVATE_KEY" > ~/qnet-data/config/wallet.key
chmod 600 ~/qnet-data/config/wallet.key
```

## Step 6: Run Production Nodes

### Full Node (Recommended)
```bash
# Run QNet production node (Interactive)
cd development/qnet-integration
./target/release/qnet-node

# You will be prompted for:
# - Activation code: QNET-XXXX-XXXX-XXXX
# - The node will auto-detect as Full Node
# - Region will be auto-detected
# - High-performance mode enabled by default
```

### Super Node (High-End Servers)
```bash
# For powerful servers with 64GB+ RAM
cd development/qnet-integration
./target/release/qnet-node

# You will be prompted for:
# - Activation code: QNET-YYYY-YYYY-YYYY
# - The node will auto-detect as Super Node
# - Producer mode enabled automatically
# - Metrics enabled by default
```

### Light Node (Minimal Resources)
```bash
# For servers with limited resources
cd development/qnet-integration
./target/release/qnet-node

# You will be prompted for:
# - Activation code: QNET-ZZZZ-ZZZZ-ZZZZ
# - The node will auto-detect as Light Node
# - Minimal resource usage
```

### Production Systemd Service (Recommended)

For production deployment with auto-restart:

```bash
# Create systemd service file
sudo tee /etc/systemd/system/qnet-node.service > /dev/null <<EOF
[Unit]
Description=QNet Blockchain Node
After=network.target

[Service]
Type=simple
User=qnet
Group=qnet
WorkingDirectory=/opt/qnet-node
ExecStart=/opt/qnet-node/target/release/qnet-node
Restart=always
RestartSec=10
Environment=RUST_LOG=info
Environment=QNET_ACTIVATION_CODE=QNET-XXXX-XXXX-XXXX
Environment=QNET_P2P_PORT=9876
Environment=QNET_RPC_PORT=9877

[Install]
WantedBy=multi-user.target
EOF

# Enable and start service
sudo systemctl daemon-reload
sudo systemctl enable qnet-node
sudo systemctl start qnet-node

# Check status
sudo systemctl status qnet-node
```

### Distributed API Access

**Every Full/Super node provides complete REST API functionality:**
- Node 1: `http://localhost:8001/api/v1/`
- Node 2: `http://localhost:8002/api/v1/`
- Node 3: `http://localhost:8003/api/v1/`

**Multi-node architecture provides maximum availability and performance!**

## Step 7: Verify Node Operation

### Check Node Status
```bash
# Check if container is running
docker ps | grep qnet-production

# Check node logs
docker logs -f qnet-production

# Check resource usage
docker stats qnet-production
```

### Test RPC Connection
```bash
# Test local RPC
curl -X POST http://localhost:9877/rpc \
  -H "Content-Type: application/json" \
  -d '{"method":"get_node_info","params":[],"id":1}'

# Should return node information
```

### Monitor Network Connection
```bash
# Check P2P connections
curl -s http://localhost:9877/rpc \
  -H "Content-Type: application/json" \
  -d '{"method":"get_peer_count","params":[],"id":1}' | jq

# Check sync status
curl -s http://localhost:9877/rpc \
  -H "Content-Type: application/json" \
  -d '{"method":"get_sync_status","params":[],"id":1}' | jq
```

## Step 8: Security Hardening

### Configure Fail2ban
```bash
# Create QNet Fail2ban filter
sudo tee /etc/fail2ban/filter.d/qnet.conf > /dev/null << 'EOF'
[Definition]
failregex = .*\[ERROR\].*Invalid transaction.*<HOST>
            .*\[WARN\].*Rate limit exceeded.*<HOST>
            .*\[ERROR\].*Authentication failed.*<HOST>
ignoreregex =
EOF

# Create QNet Fail2ban jail
sudo tee /etc/fail2ban/jail.d/qnet.conf > /dev/null << 'EOF'
[qnet]
enabled = true
port = 9876,9877
filter = qnet
logpath = /home/qnet/qnet-data/logs/*.log
maxretry = 5
bantime = 3600
findtime = 600
EOF

# Restart Fail2ban
sudo systemctl restart fail2ban
```

### Setup Log Rotation
```bash
# Configure logrotate for QNet logs
sudo tee /etc/logrotate.d/qnet > /dev/null << 'EOF'
/home/qnet/qnet-data/logs/*.log {
    daily
    rotate 30
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
EOF
```

## Step 9: Monitoring Setup

### Install Node Exporter
```bash
# Download Node Exporter
wget https://github.com/prometheus/node_exporter/releases/download/v1.7.0/node_exporter-1.7.0.linux-amd64.tar.gz

# Extract and install
tar xvfz node_exporter-1.7.0.linux-amd64.tar.gz
sudo mv node_exporter-1.7.0.linux-amd64/node_exporter /usr/local/bin/

# Create systemd service
sudo tee /etc/systemd/system/node_exporter.service > /dev/null << 'EOF'
[Unit]
Description=Node Exporter
After=network.target

[Service]
User=qnet
Group=qnet
Type=simple
ExecStart=/usr/local/bin/node_exporter --web.listen-address=:9100

[Install]
WantedBy=multi-user.target
EOF

# Start Node Exporter
sudo systemctl daemon-reload
sudo systemctl start node_exporter
sudo systemctl enable node_exporter
```

### Health Check Script
```bash
# Create health check script
tee ~/check_qnet_health.sh > /dev/null << 'EOF'
#!/bin/bash

# Check if QNet container is running
if ! docker ps | grep -q qnet-production; then
    echo "ERROR: QNet container not running"
    exit 1
fi

# Check RPC response
if ! curl -s --max-time 10 http://localhost:9877/rpc \
    -H "Content-Type: application/json" \
    -d '{"method":"get_node_info","params":[],"id":1}' | grep -q "result"; then
    echo "ERROR: RPC not responding"
    exit 1
fi

echo "OK: QNet node healthy"
exit 0
EOF

chmod +x ~/check_qnet_health.sh

# Test health check
~/check_qnet_health.sh
```

## Step 10: Automatic Updates

### Update Script
```bash
# Create update script
tee ~/update_qnet.sh > /dev/null << 'EOF'
#!/bin/bash

echo "Updating QNet node..."

cd ~/QNet-Blockchain

# Pull latest changes
git pull origin testnet

# Rebuild Docker image
docker build -f Dockerfile.production -t qnet-node:production .

# Stop old container
docker stop qnet-production
docker rm qnet-production

# Start new container with same configuration
# (Use the same docker run command from Step 6)

echo "QNet node updated successfully"
EOF

chmod +x ~/update_qnet.sh
```

## Troubleshooting

### Common Issues

**Container won't start:**
```bash
# Check Docker logs
docker logs qnet-production

# Check available resources
free -h
df -h
```

**RPC not responding:**
```bash
# Check if port is open
netstat -tlnp | grep 9877

# Check firewall
sudo ufw status
```

**Sync issues:**
```bash
# Check peer connections
curl -s http://localhost:9877/rpc \
  -H "Content-Type: application/json" \
  -d '{"method":"get_peer_count","params":[],"id":1}'

# Restart node if needed
docker restart qnet-production
```

**Low performance:**
```bash
# Check system resources
htop
iotop

# Check Docker resource limits
docker stats qnet-production
```

## Performance Optimization

### For High-Load Servers
```bash
# Increase file descriptor limits
echo "qnet soft nofile 65536" | sudo tee -a /etc/security/limits.conf
echo "qnet hard nofile 65536" | sudo tee -a /etc/security/limits.conf

# Optimize network settings
echo "net.core.rmem_max = 16777216" | sudo tee -a /etc/sysctl.conf
echo "net.core.wmem_max = 16777216" | sudo tee -a /etc/sysctl.conf
echo "net.ipv4.tcp_rmem = 4096 65536 16777216" | sudo tee -a /etc/sysctl.conf
echo "net.ipv4.tcp_wmem = 4096 65536 16777216" | sudo tee -a /etc/sysctl.conf

sudo sysctl -p
```

## Final Verification

After completing all steps, your QNet production node should be:
- ✅ Running in Docker container
- ✅ Syncing with network
- ✅ Responding to RPC calls  
- ✅ Connected to peers
- ✅ Secured with firewall
- ✅ Monitored for health
- ✅ Ready for 100k+ TPS

Your node is now part of the QNet blockchain network and ready for production workloads! 