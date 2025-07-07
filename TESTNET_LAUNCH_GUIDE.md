# 🚀 QNet Testnet Launch Guide

## Production-Ready Testnet Deployment

This guide will help you launch a production-ready QNet testnet with **3 nodes** and **full monitoring**.

---

## 📋 Prerequisites

### Server Requirements
- **Operating System**: Ubuntu 20.04+ / CentOS 8+
- **Docker**: Latest version
- **Docker Compose**: v2.0+
- **Memory**: 8GB+ RAM
- **Storage**: 100GB+ SSD
- **Network**: 100+ Mbps connection

### Quick Setup Commands

```bash
# Install Docker (Ubuntu/Debian)
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Add user to docker group
sudo usermod -aG docker $USER

# Log out and log back in for group changes
```

---

## 🎯 Network Architecture

### **Genesis Super Node**
- **Type**: Block Producer/Leader
- **Ports**: 8545 (RPC), 9876 (P2P), 9090 (Metrics)
- **Resources**: 4GB RAM, 2 CPU cores
- **Role**: Creates blocks, manages consensus

### **Validator Node 1**
- **Type**: Full Node Validator
- **Ports**: 8546 (RPC), 9877 (P2P), 9091 (Metrics)
- **Resources**: 2GB RAM, 1 CPU core
- **Role**: Validates transactions and blocks

### **Validator Node 2**
- **Type**: Full Node Validator
- **Ports**: 8547 (RPC), 9878 (P2P), 9092 (Metrics)
- **Resources**: 2GB RAM, 1 CPU core
- **Role**: Validates transactions and blocks

---

## 🚀 Launch Instructions

### Step 1: Clone and Navigate

```bash
# Clone QNet repository
git clone https://github.com/your-repo/QNet-Project.git
cd QNet-Project

# Or navigate to existing directory
cd ~/QNet-Blockchain
```

### Step 2: Copy Files

```bash
# Copy production files to server
cp Dockerfile.production ~/QNet-Blockchain/
cp docker-compose.production.yml ~/QNet-Blockchain/
cp start_qnet_testnet.sh ~/QNet-Blockchain/
cp -r monitoring/ ~/QNet-Blockchain/

# Navigate to project directory
cd ~/QNet-Blockchain
```

### Step 3: Launch Testnet

```bash
# Make script executable
chmod +x start_qnet_testnet.sh

# Launch testnet (this will take 10-15 minutes)
./start_qnet_testnet.sh
```

### Step 4: Verify Network

```bash
# Check all nodes are running
docker compose -f docker-compose.production.yml ps

# Check node health
curl http://localhost:8545/health  # Genesis
curl http://localhost:8546/health  # Validator 1
curl http://localhost:8547/health  # Validator 2
```

---

## 📊 Monitoring & Logs

### **Real-time Monitoring**

- **Prometheus**: http://localhost:9093
- **Grafana**: http://localhost:3000 (admin/qnet2025)
- **Node Metrics**: 
  - Genesis: http://localhost:9090/metrics
  - Validator 1: http://localhost:9091/metrics
  - Validator 2: http://localhost:9092/metrics

### **Log Analysis**

```bash
# View all logs
docker compose -f docker-compose.production.yml logs -f

# View specific node logs
docker compose -f docker-compose.production.yml logs genesis
docker compose -f docker-compose.production.yml logs validator1
docker compose -f docker-compose.production.yml logs validator2

# View detailed log files
tail -f genesis-logs/qnet-node.log
tail -f validator1-logs/qnet-node.log
tail -f validator2-logs/qnet-node.log
```

---

## 🔍 Key Monitoring Metrics

### **Node Health Indicators**
- ✅ **Block Production**: Genesis node creating blocks
- ✅ **Peer Discovery**: Nodes finding each other
- ✅ **Transaction Processing**: Mempool activity
- ✅ **Consensus Participation**: All nodes validating
- ✅ **Network Stability**: Connection count stable

### **Performance Metrics**
- **Block Time**: Target 2-3 seconds
- **Transaction Throughput**: 100+ TPS
- **Network Latency**: <100ms between nodes
- **Memory Usage**: <80% of allocated
- **CPU Usage**: <70% average

---

## 🎛️ Network Management

### **Node Management**
```bash
# Stop testnet
docker compose -f docker-compose.production.yml down

# Restart specific node
docker compose -f docker-compose.production.yml restart genesis

# Scale validators (add more nodes)
docker compose -f docker-compose.production.yml up -d --scale validator=4

# View network stats
docker compose -f docker-compose.production.yml exec genesis qnet-node --stats
```

### **Backup & Recovery**
```bash
# Backup node data
tar -czf qnet-backup-$(date +%Y%m%d).tar.gz *-data/

# Restore node data
tar -xzf qnet-backup-YYYYMMDD.tar.gz
```

---

## 🐛 Troubleshooting

### **Common Issues**

1. **Node won't start**
   ```bash
   # Check logs
   docker compose -f docker-compose.production.yml logs genesis
   
   # Check ports
   sudo netstat -tlpn | grep 8545
   ```

2. **Nodes can't connect**
   ```bash
   # Check network
   docker network ls
   docker network inspect qnet-project_qnet-testnet
   ```

3. **Build fails**
   ```bash
   # Clean build
   docker system prune -a
   docker compose -f docker-compose.production.yml build --no-cache
   ```

### **Emergency Commands**
```bash
# Force stop everything
docker kill $(docker ps -q)
docker system prune -a

# Check system resources
docker stats
df -h
free -h
```

---

## 🎉 Success Indicators

### **Testnet is Ready When:**
- ✅ All 3 nodes show "Running" status
- ✅ Genesis node producing blocks every 2-3 seconds
- ✅ All validators connected to genesis
- ✅ Prometheus collecting metrics from all nodes
- ✅ Grafana dashboard showing network activity
- ✅ All health checks passing

### **Network Activity Logs:**
```
[INFO] Genesis node started, listening on 0.0.0.0:9876
[INFO] Validator connected: validator1:9877
[INFO] Validator connected: validator2:9878
[INFO] Block #1 produced, hash: 0x123...
[INFO] Block #2 produced, hash: 0x456...
[INFO] Network consensus achieved
```

---

## 📞 Support

If you encounter issues:
1. Check logs first: `docker compose -f docker-compose.production.yml logs`
2. Verify system resources: `docker stats`
3. Review network connectivity: `docker network inspect qnet-project_qnet-testnet`
4. Check official documentation and GitHub issues

---

**🎯 Your QNet testnet is now ready for production testing!** 