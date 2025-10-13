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

# 3. Run interactive setup (ONLY activation method)
docker run -it --name qnet-node --restart=always \
  -p 9876:9876 -p 9877:9877 -p 8001:8001 \
  -v $(pwd)/node_data:/app/node_data \
  qnet-production
```

**The interactive menu handles all activation automatically:**
- Region detection
- Node type selection (Full/Super)
- Activation code input
- Network configuration
- Daemon mode startup

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

## Step 4: Run Interactive Setup (ONLY Method)

```bash
docker run -it --name qnet-node --restart=always \
  -p 9876:9876 -p 9877:9877 -p 8001:8001 \
  -v $(pwd)/node_data:/app/node_data \
  qnet-production
```

**The interactive setup will:**
1. **Auto-detect region** based on your IP
2. **Choose node type** (Full Node or Super Node for servers)
3. **Enter activation code** (QNET-XXXXXX-XXXXXX-XXXXXX format, 26 characters)
4. **Generate quantum-resistant keys**
5. **Configure P2P network**
6. **Start daemon mode** automatically
7. **Begin consensus participation**

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
- **Format:** QNET-XXXXXX-XXXXXX-XXXXXX (26 characters)
- **Phase 1:** 1DEV burn on Solana (1,500 → 300 1DEV minimum pricing)
- **Phase 2:** QNC transfer to Pool 3 (5k-30k QNC pricing)
- **Node Types:** Full/Super for servers, Light for mobile only

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
docker stop qnet-node || true
docker rm qnet-node || true

# Run fresh container
docker run -it --name qnet-node --restart=always \
  -p 9876:9876 -p 9877:9877 -p 8001:8001 \
  -v $(pwd)/node_data:/app/node_data \
  qnet-production
```

**For support:** https://github.com/AIQnetLab/QNet-Blockchain/issues 
