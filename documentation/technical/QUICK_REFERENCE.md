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

### 🔧 Quick Commands

```bash
# Build the node
cd qnet-integration
cargo build --release --bin qnet-node

# Start first node
.\target\release\qnet-node.exe --p2p-port 9876 --rpc-port 9877 --data-dir node1_data

# Start second node with bootstrap
.\target\release\qnet-node.exe --p2p-port 9878 --rpc-port 9879 --data-dir node2_data --bootstrap-peers 127.0.0.1:9876

# Check peer count
curl -X POST http://localhost:9877/rpc -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"node_getInfo","params":[],"id":1}'
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
- **All Node Types**: 1,500 → 150 1DEV (same price for all, decreases as tokens burned)
- **Light/Full/Super**: Equal access, price based on burn progress only
- **Mechanism**: Tokens burned on Solana, permanently removed

#### Phase 2 (QNC Token Spending) 
- **Light**: 2,500-15,000 QNC (base: 5,000, varies by network size)
- **Full**: 3,750-22,500 QNC (base: 7,500, varies by network size)  
- **Super**: 5,000-30,000 QNC (base: 10,000, varies by network size)
- **Mechanism**: QNC → Network Pool → Activation Code → Active Node

### Network Size Multipliers (Phase 2)
- **0-100K nodes**: 0.5x (early discount)
- **100K-1M nodes**: 1.0x (standard rate)
- **1M-10M nodes**: 2.0x (high demand)
- **10M+ nodes**: 3.0x (mature network)

### Three-Pool Reward System

#### Pool 1: Base Emission
- Source: New token emission every 4 hours
- Distribution: 245,100.67 QNC initially (halving every 4 years)
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
