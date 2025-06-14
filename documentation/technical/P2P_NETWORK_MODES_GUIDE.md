# 🌐 QNet P2P Network Modes Guide

## P2P Modes Overview

QNet supports two P2P network modes that are **selected by administrators** when starting the node via command line arguments.

### 🔧 Simple P2P (default)
- **Purpose**: High performance, standard operations
- **Characteristics**: 275,418+ microblocks, production-ready
- **Usage**: Regular DApps, high-frequency trading, standard transactions

### 🌍 Regional P2P (optional)
- **Purpose**: Enterprise with disaster recovery
- **Characteristics**: Geographic failover, cross-region backup
- **Usage**: Banks, major exchanges, mission-critical systems

## 🚀 Launch Examples

### Standard Mode (Simple P2P)
```bash
# For regular DApps and high performance
./qnet-node --enable-microblocks --data-dir node1_data --p2p-port 9876 --rpc-port 9877

# With Bootstrap peers for network
./qnet-node --enable-microblocks --data-dir node1_data --p2p-port 9876 --rpc-port 9877 \
  --bootstrap-peers "192.168.1.100:9876,192.168.1.101:9876"
```

### Enterprise Mode (Regional P2P)
```bash
# Super-node in Europe with disaster recovery
./qnet-node --enable-microblocks --use-regional-p2p --node-type super --region europe \
  --data-dir eu_super_node --p2p-port 9876 --rpc-port 9877

# Full-node in North America
./qnet-node --enable-microblocks --use-regional-p2p --node-type full --region na \
  --data-dir na_full_node --p2p-port 9876 --rpc-port 9877

# Light-node in Asia
./qnet-node --enable-microblocks --use-regional-p2p --node-type light --region asia \
  --data-dir asia_light_node --p2p-port 9876 --rpc-port 9877
```

## 🎯 When to Use Which Mode

### Simple P2P is suitable for:
- ✅ **DeFi applications** - high transaction speed
- ✅ **NFT marketplaces** - fast confirmation
- ✅ **Gaming blockchains** - low latency
- ✅ **DEX (decentralized exchanges)** - high-frequency trading
- ✅ **Regular users** - simple setup

### Regional P2P is suitable for:
- 🏦 **Banking systems** - disaster recovery required
- 📈 **Major exchanges** - multi-region operations
- 🏢 **Enterprise DApps** - mission-critical infrastructure
- 🌍 **International payments** - geographic failover
- 🔒 **Government systems** - high fault tolerance requirements

## 🔧 Settings for Different Scenarios

### Scenario 1: DeFi Protocol (Simple P2P)
```bash
# High-performance DeFi node
export QNET_ENABLE_MICROBLOCKS=1
export QNET_IS_LEADER=1
./qnet-node --enable-microblocks --data-dir defi_node --p2p-port 9876 --rpc-port 9877
```

### Scenario 2: International Bank (Regional P2P)
```bash
# Main office in Europe
./qnet-node --enable-microblocks --use-regional-p2p --node-type super --region europe \
  --data-dir bank_eu_main --p2p-port 9876 --rpc-port 9877

# Branch in North America  
./qnet-node --enable-microblocks --use-regional-p2p --node-type full --region na \
  --data-dir bank_na_branch --p2p-port 9877 --rpc-port 9878

# Backup center in Asia
./qnet-node --enable-microblocks --use-regional-p2p --node-type full --region asia \
  --data-dir bank_asia_backup --p2p-port 9878 --rpc-port 9879
```

### Scenario 3: Gaming Platform (Simple P2P)
```bash
# Gaming nodes for fast transactions
./qnet-node --enable-microblocks --data-dir game_node1 --p2p-port 9876 --rpc-port 9877
./qnet-node --enable-microblocks --data-dir game_node2 --p2p-port 9879 --rpc-port 9880
```

## 🔄 Disaster Recovery in Regional P2P

### Automatic Failover
Regional P2P automatically switches between regions:

```
Europe (Primary) → Asia (Backup) → North America (Backup)
Asia (Primary) → Europe (Backup) → Oceania (Backup)
North America (Primary) → Europe (Backup) → South America (Backup)
```

### Disaster Scenario
1. **Europe offline** → automatic switch to Asia
2. **Asia offline** → switch to North America  
3. **Europe recovery** → gradual switch back

## 📊 Performance Comparison

| Feature | Simple P2P | Regional P2P |
|---|---|---|
| **TPS** | 275,418+ microblocks/sec | 275,418+ microblocks/sec |
| **Latency** | Minimal | Slightly higher (geographic routing) |
| **Disaster Recovery** | ❌ | ✅ |
| **Geographic Failover** | ❌ | ✅ |
| **Setup Complexity** | Simple | Medium |
| **Enterprise Features** | Basic | Full |

## 🚨 Important Notes

### Backward Compatibility
- **All existing scripts work without changes**
- **Simple P2P is used by default**
- **Regional P2P is enabled explicitly via --use-regional-p2p**

### Performance
- **Both modes support microblocks**
- **Performance is virtually identical**
- **Regional P2P adds minimal latency**

### Production Deployment
```bash
# For most applications use Simple P2P
./qnet-node --enable-microblocks --data-dir production_node

# For enterprise with disaster recovery use Regional P2P
./qnet-node --enable-microblocks --use-regional-p2p --node-type super --region europe
```

## 🔮 Future Improvements

- **Automatic mode switching** based on load
- **Hybrid P2P** - combination of Simple + Regional
- **AI-driven failover** for optimal routing
- **Cross-chain Regional P2P** for inter-blockchain operations 