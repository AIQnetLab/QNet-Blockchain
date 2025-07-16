# QNet Production Node Deployment Guide

## Quick Installation (Production Ready)

### System Requirements
- **Ubuntu 20.04+ / CentOS 8+ / Any Linux with Docker support**
- **4+ CPU cores, 8+ GB RAM** (Full nodes)
- **8+ CPU cores, 32+ GB RAM** (Super nodes)
- **100+ GB SSD storage**
- **Stable internet connection**

### One-Command Installation

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
cargo build --release
docker build -t qnet-production -f development/Dockerfile .

# 4. Launch node
docker run -d --name qnet-node --restart=always \
  -p 9876:9876 -p 9877:9877 -p 8001:8001 \
  -v $(pwd)/node_data:/opt/qnet/node_data \
  qnet-production

# 5. Activate node (INTERACTIVE REQUIRED)
docker exec -it qnet-node /bin/bash
./target/release/qnet-node
```

### Interactive Activation Process

When you run `./target/release/qnet-node`, you will see:

```
=== QNet Node Activation ===
Enter activation code: QNET-XXXX-XXXX-XXXX
Select node type: [1] Full [2] Super
Detected region: Europe [Y/n]: Y
P2P port: 9876 [Y/n]: Y
RPC port: 9877 [Y/n]: Y
API port: 8001 [Y/n]: Y
Activating node...
✅ Node activated successfully!
```

**IMPORTANT:** Only Full/Super nodes can be activated on servers. Light nodes are mobile-only.

## Multiple Nodes Setup

```bash
# Launch additional nodes
docker run -d --name qnet-node-2 --restart=always \
  -p 9878:9878 -p 9879:9879 -p 8002:8002 \
  -v $(pwd)/node2_data:/opt/qnet/node_data \
  qnet-production

docker run -d --name qnet-node-3 --restart=always \
  -p 9880:9880 -p 9881:9881 -p 8003:8003 \
  -v $(pwd)/node3_data:/opt/qnet/node_data \
  qnet-production

# Activate each node separately
docker exec -it qnet-node-2 /bin/bash
./target/release/qnet-node
# Exit and repeat for node-3
```

## Monitoring Commands

### Container Status
```bash
# Check running containers
docker ps

# Check container logs
docker logs -f qnet-node
docker logs -f qnet-node-2
docker logs -f qnet-node-3

# Container resource usage
docker stats qnet-node
```

### Node Health Checks
```bash
# API health endpoints
curl http://localhost:8001/api/v1/node/health
curl http://localhost:8002/api/v1/node/health
curl http://localhost:8003/api/v1/node/health

# Node information
curl http://localhost:8001/api/v1/node/info

# Network discovery
curl http://localhost:8001/api/v1/nodes/discovery
```

### Blockchain Status
```bash
# Latest block
curl http://localhost:8001/api/v1/block/latest

# Mempool status
curl http://localhost:8001/api/v1/mempool/status

# Gas recommendations
curl http://localhost:8001/api/v1/gas/recommendations
```

### Account Operations
```bash
# Check account balance
curl http://localhost:8001/api/v1/account/YOUR_ADDRESS/balance

# Account information
curl http://localhost:8001/api/v1/account/YOUR_ADDRESS

# Transaction history
curl http://localhost:8001/api/v1/account/YOUR_ADDRESS/transactions
```

### Transaction Operations
```bash
# Submit transaction
curl -X POST http://localhost:8001/api/v1/transaction \
  -H "Content-Type: application/json" \
  -d '{
    "from": "sender_address",
    "to": "recipient_address",
    "amount": 1000,
    "gas_price": 10,
    "gas_limit": 21000
  }'

# Check transaction status
curl http://localhost:8001/api/v1/transaction/TX_HASH
```

## Useful Management Commands

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

### Data Management
```bash
# Check blockchain data size
du -sh node_data/

# Backup blockchain data
tar -czf qnet-backup-$(date +%Y%m%d).tar.gz node_data/

# View node configuration
cat node_data/config.toml
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
docker stop qnet-node qnet-node-2 qnet-node-3

# Update code
git pull origin testnet
cargo build --release
docker build -t qnet-production -f development/Dockerfile .

# Start nodes
docker start qnet-node qnet-node-2 qnet-node-3
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