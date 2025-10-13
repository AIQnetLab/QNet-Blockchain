# QNet Project Quick Reference

## Project Status: ~45% Complete ✅ P2P FIXED!

### ✅ Completed Components
1. **Core State Management** (qnet-state) - 100%
2. **Consensus Engine** (qnet-consensus) - 100%
3. **Memory Pool** (qnet-mempool) - 100%
4. **Node Integration** (qnet-integration) - 60%
   - ✅ Storage with RocksDB
   - ✅ RPC Server (10 methods)
   - ✅ Block production
   - ✅ **P2P Networking (FIXED!)** 
   - ✅ Command line arguments
   - ⏳ Transaction propagation
   - ⏳ Block synchronization

### 🚀 Recent Achievements
- **P2P connections now working!** Nodes maintain peer connections
- Added command line argument support
- Implemented P2P handshake protocol
- Fixed RPC methods to show real peer count
- Added automatic reconnection logic

### 📊 Current Network Status
- Nodes can discover and connect to each other
- Peer count correctly reported via RPC
- TCP connections established and maintained
- Ready for block/transaction propagation

### 🔧 Production Commands (ONLY METHOD)

```bash
# Clone and build QNet
git clone https://github.com/AIQnetLab/QNet-Blockchain.git
cd QNet-Blockchain
git checkout testnet

# Build Rust binary first
cd development/qnet-integration
cargo build --release
cd ../../

# Build production Docker image
docker build -t qnet-production -f Dockerfile.production .

# Run interactive production node (single deployment method)
docker run -it --name qnet-node --restart=always \
  -p 9876:9876 -p 9877:9877 -p 8001:8001 \
  -v $(pwd)/node_data:/app/node_data \
  qnet-production

# Check node status
curl http://localhost:8001/health
```

### 📁 Key Files
- `qnet-integration/src/simple_p2p.rs` - P2P implementation
- `qnet-integration/src/node.rs` - Node coordination
- `qnet-integration/src/rpc.rs` - RPC methods
- `qnet-integration/src/bin/qnet-node.rs` - Main executable

### 🎯 Next Steps
1. Implement block propagation over P2P
2. Add transaction broadcasting
3. Implement chain synchronization
4. Add peer discovery mechanism
5. Create wallet functionality

### 💡 Important Notes
- P2P uses TCP sockets directly (no libp2p)
- Handshake protocol exchanges P2P ports
- Nodes reconnect to bootstrap peers every 60 seconds
- RPC server runs on separate port from P2P

### 🐛 Known Issues
- None! P2P is working correctly 🎉

### 📈 Progress Tracking
- Core modules: 100% ✅
- Integration: 60% 🔄
- P2P networking: 100% ✅
- RPC API: 80% 🔄
- Overall: ~45% complete

## 🚀 Current Status: 40% Complete ✅

### ✅ What's Working
- **Node BUILDS and RUNS!** `.\target\release\qnet-node.exe`
- **Block production working!** (creating blocks every ~90s)
- **RPC server fully operational!** All methods tested ✅
- RocksDB storage integrated
- Ed25519 cryptography
- Commit-reveal consensus
- Transaction mempool (accepts transactions)
- Block validation
- **Simple P2P networking (Rust implementation)**
- **No external dependencies (Go not needed!)**

### ⏳ In Progress
- **P2P Connection Issue**: Nodes accept connections but don't maintain them
  - Both nodes running (Height 0+)
  - Both listening on P2P ports (9876, 9878, 9880, 9882)
  - Can send/receive messages (Ping/Pong works!)
  - But connections not saved in peer list
  - Fixed clone() issue but still 0 peers
  - Added reconnection logic but still not working
- Transaction processing in blocks
- State persistence between blocks

### ❌ What's Missing
- Reward distribution
- Sharding implementation
- Dynamic pricing
- API server full integration

### 📊 Performance
- **Current**: ~1 block/90s (single node)
- **Transactions**: Can submit to mempool
- **Target**: 1,000,000 TPS

## 🏃 Quick Start

```bash
# Build
cd qnet-integration
cargo build --release --bin qnet-node

# Run first node
cd ..
.\target\release\qnet-node.exe

# Test RPC (works!)
python test_rpc.py

# Run second node (in new terminal)
.\start_second_node.ps1
```

## 🎯 Latest Achievements
- **2025-01-28 09:21**: RPC server confirmed working! ✅
  - All RPC methods respond correctly
  - Transactions can be submitted
  - Node info, chain height, stats all accessible
- **2025-01-28 10:51**: P2P issue identified
  - Both nodes running independently
  - P2P ports accepting connections
  - But connections not maintained after initial handshake
- **2025-01-28 13:36**: P2P partially fixed
  - Ping/Pong messages work
  - But peer count still shows 0
- **2025-01-28 17:47**: Multiple fixes attempted
  - Fixed clone() method to preserve P2P reference
  - Added periodic reconnection logic
  - Added better logging
  - But peers still not connecting
- Block production: Working independently on each node
- Simple P2P implementation in Rust (no Go needed)

## 📡 Working RPC Methods
- ✅ `node_getInfo` - Returns node information
- ✅ `node_getStatus` - Node status
- ✅ `node_getPeers` - Peer list (currently 0)
- ✅ `chain_getHeight` - Current blockchain height
- ✅ `chain_getBlock` - Get block by height
- ✅ `chain_getBlocks` - Get multiple blocks
- ✅ `mempool_getTransactions` - List mempool txs
- ✅ `account_getBalance` - Check account balance
- ✅ `stats_get` - Blockchain statistics
- ✅ `tx_submit` - Submit new transaction

## 🏗️ Architecture

| Module | Language | Status | Purpose |
|--------|----------|--------|---------|
| qnet-state | Rust | ✅ | State management |
| qnet-mempool | Rust | ✅ | Transaction pool |
| qnet-consensus | Rust | ✅ | Commit-reveal |
| qnet-integration | Rust | ✅ | Connects everything |
| qnet-simple-p2p | Rust | ✅ | P2P networking |
| qnet-rpc | Rust | ✅ | JSON-RPC server |
| qnet-api | Python | ❌ | REST API |
| qnet-wallet | JavaScript | ✅ | Browser extension |
| qnet-sharding | Rust | ⏳ | Advanced sharding |

## 💰 Economics

**DISCLAIMER**: QNet is experimental research technology. No guarantees of network operation or rewards. Participate only with funds you can afford to lose completely.

### Node Activation Costs

#### Phase 1 (1DEV Token Spending)
- **All Node Types**: 1,500 → 300 1DEV (same price for all, decreases as tokens burned, min at 80-90%)
- **Light/Full/Super**: Equal access, price based on burn progress only
- **Mechanism**: Tokens burned on Solana, permanently removed
- **At 90% burned**: Transition to Phase 2 (QNC activation)

#### Phase 2 (QNC Token Spending) 
- **Light**: 2,500-15,000 QNC (base: 5,000, varies by network size)
- **Full**: 3,750-22,500 QNC (base: 7,500, varies by network size)  
- **Super**: 5,000-30,000 QNC (base: 10,000, varies by network size)
- **Mechanism**: QNC → Network Pool → Activation Code → Active Node

### Network Size Multipliers (Phase 2)
- **0-100K nodes**: 0.5x (early discount)
- **100K-300K nodes**: 1.0x (standard rate)
- **300K-1M nodes**: 2.0x (high demand)
- **1M+ nodes**: 3.0x (mature network)

### Three-Pool Reward System

#### Pool 1: Base Emission
- Source: New token emission every 4 hours
- Distribution: 251,432.34 QNC initially (halving every 4 years)
- Allocation: Equal share to all active nodes

#### Pool 2: Transaction Fees
- Source: Network transaction fees
- Allocation: 70% Super nodes, 30% Full nodes, 0% Light nodes

#### Pool 3: Activation Pool (NEW!)
- Source: QNC tokens spent on Phase 2 activations
- Allocation: Equal bonus distributed to all active nodes
- Innovation: Network growth rewards existing participants

### Network Ping System
- **Frequency**: Every 4 hours automatically
- **Method**: Network randomly pings active nodes
- **Requirement**: Must respond to receive rewards
- **Missed Ping**: No rewards for that period

### Sharp Drop Innovation (Year 20)
- Normal halving: ÷2 every 4 years for 20 years
- **Sharp Drop**: ÷10 at year 20-24 (instead of ÷2)
- Resume normal halving: ÷2 from year 24+
- **Benefit**: 107M QNC saved over 100 years

**RISK WARNING**: Economic parameters subject to governance changes. Token values may fluctuate significantly. Network may be discontinued without notice.

## Network Parameters & Reputation

### Core Network Parameters
| Parameter | Value | Description |
|-----------|-------|-------------|
| Microblock Time | 1 second | Fast transaction processing |
| Macroblock Time | 90 seconds | Byzantine consensus finalization |
| Rotation Period | 30 blocks | Producer rotation with entropy |
| Maximum Validators | 1000 | Per consensus round |
| Reputation Threshold | 70% | Minimum for consensus |
| Full Snapshot | 10,000 blocks | Complete state backup |
| Incremental Snapshot | 1,000 blocks | Delta state backup |
| Fast Sync Trigger | 50 blocks | Parallel download activation |
| Sync Timeout | 60s/30s | Fast sync/Normal sync |
| IPFS Integration | Optional | Set IPFS_API_URL env var |

### Reputation System
| Action | Reward/Penalty | Frequency |
|--------|----------------|-----------|
| **Microblock Production** | +1 per block | Every second |
| **Macroblock Leader** | +10 | Every 90 seconds |
| **Macroblock Participant** | +5 | Every 90 seconds |
| **Emergency Producer** | +5 | On failover |
| **Failed Microblock** | -20 | On failure |
| **Failed Macroblock** | -30 | On failure |
| **Successful Ping** | +1 | Every 4 hours |
| **Missed Ping** | -1 | Every 4 hours |
| **Maximum Reputation** | 100 | Hard cap |

### Entropy-Based Selection
```rust
// Producer selection with unpredictability
selection_hash = SHA3_256(
    round_number +
    previous_block_hash +  // Entropy source
    eligible_nodes         // Rep >= 70%
)
```

### Synchronization Features
- **State Snapshots**: LZ4 compressed, SHA3-256 verified
- **Parallel Downloads**: Multiple workers, 100-block chunks
- **Deadlock Prevention**: Guard pattern with auto-reset
- **IPFS Distribution**: Optional P2P snapshot sharing
- **Auto Cleanup**: Keep only latest 5 snapshots

## 📝 Next Steps

1. **Today**
   - [x] Build successful
   - [x] Node runs and produces blocks
   - [x] Replace Go with Rust P2P
   - [x] RPC server working
   - [ ] Fix second node startup
   - [ ] Test multi-node connection

2. **This Week**
   - [ ] Transaction processing in blocks
   - [ ] State persistence verification
   - [ ] Block synchronization between nodes

3. **This Month**
   - [ ] Reward system
   - [ ] Monitoring tools
   - [ ] Testnet deployment

## 📚 Documentation

**Main Guide**: [docs/QNET_COMPLETE_GUIDE.md](docs/QNET_COMPLETE_GUIDE.md)
- [P2P Issue Resolution](docs/P2P_ISSUE_RESOLVED.md)
- [Post-Quantum Plan](docs/POST_QUANTUM_PLAN.md)
- [Economic Model](docs/COMPLETE_ECONOMIC_MODEL.md)

---
*Last updated: 2025-01-28*
