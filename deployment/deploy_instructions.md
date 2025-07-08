# QNet Production Server Setup Guide

## Server Requirements

### Minimum Specifications
- **CPU**: 8 cores (16 threads recommended)
- **RAM**: 32 GB minimum (64 GB recommended)
- **Storage**: 1 TB NVMe SSD (2 TB recommended)
- **Network**: 1 Gbps connection, static IP
- **OS**: Ubuntu 22.04 LTS (clean installation)

### Recommended Cloud Providers
- AWS: c6i.2xlarge or higher
- Google Cloud: c3-standard-8 or higher  
- DigitalOcean: CPU-Optimized 8 vCPU / 32 GB
- Hetzner: CCX33 or higher

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
# Build production Docker image
docker build -f Dockerfile.production -t qnet-node:production .

# Verify build success
docker images | grep qnet-node
```

### Expected Build Output
```bash
# Should see successful build with ~7MB binary
Successfully built qnet-node:production
REPOSITORY    TAG         IMAGE ID       CREATED        SIZE
qnet-node     production  abc123def456   2 minutes ago  150MB
```

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

## Step 6: Run Production Node

### Full Node (Recommended)
```bash
# Run QNet production node
docker run -d \
  --name qnet-production \
  --restart unless-stopped \
  -p 9876:9876 \
  -p 9877:9877 \
  -v ~/qnet-data:/app/data \
  qnet-node:production \
  --node-type full \
  --region na \
  --high-performance \
  --enable-metrics \
  --wallet-key "$(cat ~/qnet-data/config/wallet.key)"
```

### Super Node (High-End Servers)
```bash
# For powerful servers with 64GB+ RAM
docker run -d \
  --name qnet-production \
  --restart unless-stopped \
  -p 9876:9876 \
  -p 9877:9877 \
  -p 9878:9878 \
  -v ~/qnet-data:/app/data \
  qnet-node:production \
  --node-type super \
  --region na \
  --high-performance \
  --producer \
  --enable-metrics \
  --wallet-key "$(cat ~/qnet-data/config/wallet.key)"
```

### Light Node (Minimal Resources)
```bash
# For servers with limited resources
docker run -d \
  --name qnet-production \
  --restart unless-stopped \
  -p 9876:9876 \
  -p 9877:9877 \
  -v ~/qnet-data:/app/data \
  qnet-node:production \
  --node-type light \
  --region na \
  --wallet-key "$(cat ~/qnet-data/config/wallet.key)"
```

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