# 🚀 QNet Blockchain - Post-Quantum Decentralized Network

[![License](https://img.shields.io/badge/License-BSL_1.1-blue.svg)](LICENSE)
[![Rust](https://img.shields.io/badge/rust-1.70+-orange.svg)](https://www.rust-lang.org)
[![Node.js](https://img.shields.io/badge/node.js-18+-green.svg)](https://nodejs.org)
[![Performance](https://img.shields.io/badge/TPS-424,411-blue.svg)](https://github.com/AIQnetLab/QNet-Blockchain)

## 🌟 Overview

QNet is a high-performance, post-quantum secure blockchain network with a **two-phase activation system** designed for the next generation of decentralized applications.

## 📜 Licensing

This project uses **dual licensing**:

### 🔐 Blockchain Infrastructure (BSL 1.1)
- **Components**: 
  - `core/` - Consensus, mempool, state management, sharding
  - `development/` - Node implementation, integration, contracts, VM
  - `audit/` - Security audit tools and compliance tests
  - `governance/` - DAO and governance mechanisms
  - `deployment/` - Node deployment and orchestration
  - `infrastructure/` - API, node infrastructure, backend services
  - `testing/` - Integration tests, testnet tools
  - `monitoring/` - Production monitoring and metrics
- **License**: [Business Source License 1.1](LICENSE) - **Perpetual Proprietary**
- **Usage**: 
  - ✅ **Non-production use** (testing, development, evaluation) - **FREE**
  - ⚠️ **Production use** requires commercial license from AIQnetLab
  - 🔒 **Proprietary license** - remains under BSL 1.1 indefinitely

### 📱 Client Applications (Apache-2.0)
- **Components**: 
  - `applications/qnet-mobile/` - Mobile wallet (F-Droid compatible)
  - `applications/qnet-wallet/` - Browser extension wallet
  - `applications/qnet-explorer/` - Blockchain explorer
  - `applications/qnet-cli/` - Command-line tools
- **License**: [Apache License 2.0](applications/qnet-mobile/LICENSE)
- **Usage**: **Fully open-source** - use, modify, distribute freely
- **Note**: All applications connect to blockchain nodes via HTTP API only. No proprietary blockchain code is included.

### ⚠️ **CRITICAL PHASE SYSTEM**
- **Phase 1 (Current)**: ONLY 1DEV token activation on Solana blockchain
- **Phase 2 (Future)**: ONLY QNC token activation on QNet blockchain
- **Transition**: 90% 1DEV burned OR 5 years from genesis block (whichever comes first)

### 🛡️ **LATEST UPDATES (v2.19.0 - November 18, 2025)**
- **Hybrid Merkle + Sampling**: Scalable on-chain ping commitments (NEW!)
  - 360× on-chain size reduction (100 MB vs 36 GB)
  - Merkle root commitment to ALL pings (blake3 hashing)
  - Deterministic sampling: 1% of pings (minimum 10,000 samples)
  - SHA3-256 for sample seed generation (quantum-resistant)
  - Byzantine-safe verification through Merkle proofs
  - Production-ready for millions of nodes
- **Bitcoin-Style Emission Validation**: Decentralized emission without central authority (NEW!)
  - No system key or single point of control
  - Range-based validation with halving support
  - All nodes independently validate emission amounts
  - Conservative estimates for Pool 2 & Pool 3
  - Partial determinism by design (±1-5% acceptable)
  - Byzantine consensus ensures security
- **Compact Hybrid Signatures**: Optimized microblock signatures (3KB vs 12KB)
  - Ed25519 + CRYSTALS-Dilithium hybrid cryptography
  - Certificate caching for 4x bandwidth reduction
  - Separate verification: structural (consensus) + cryptographic (P2P)
  - NIST/Cisco post-quantum compliance
- **Progressive Finalization Protocol (PFP)**: Self-healing macroblock recovery
  - Degradation levels: 80% → 60% → 40% → 1% node requirements
  - Checks every 30 blocks with accelerating timeouts (30s → 2s)
  - Zero-downtime: microblocks continue during recovery
  - Byzantine-safe at all levels (2/3+ honest nodes)
- **Certificate Broadcasting**: Automatic P2P certificate distribution
  - Periodic broadcast every 5 minutes
  - Rotation broadcast on certificate renewal
  - LRU cache with 100K certificate capacity
  - Scalable from 5 bootstrap to millions of nodes
- **Node Type Filtering**: Consensus participation optimization
  - Light nodes: transactions only (no consensus)
  - Full nodes: partial consensus participation
  - Super nodes: full consensus (max 1000 validators)
  - Validator sampling for network scaling
- **Architectural Cleanup**: Resolved circular dependencies
  - Core modules: structural validation only
  - Development modules: full cryptographic verification
  - Clean separation: consensus trusts pre-verified blocks
  - Defense-in-depth security model

### **Previous Updates (v2.18.0 - November 1, 2025)**
- **Fast Finality Indicators**: 5-level transaction confirmation system (Pending → InBlock → QuickConfirmed → NearFinal → FullyFinalized)
  - Real-time safety percentage calculation (0% - 100%)
  - Time to finality countdown (seconds until macroblock)
  - Risk assessment for exchanges and bridges (safe_for_amounts_under_X_qnc)
  - Optimized for 4.29B QNC supply with conservative thresholds
  - Zero storage overhead (calculated on-the-fly)
  - Backward compatible (optional fields)
- **PoH Synchronization**: Synchronized Proof of History for deterministic producer selection
  - PoH state from last confirmed block (all nodes agree)
  - Local PoH generator syncs with received blocks
  - Prevents consensus failures from diverging PoH states
  - Macroblock PoH sourced from last microblock in range
- **Fork Detection & Resolution**: PoH counter regression checks prevent malicious forks

### **Previous Updates (v2.17.0)**
- **Chain Reorganization (Chain Reorg)**: Byzantine-safe fork resolution with 2/3 majority consensus
- **Advanced Block Synchronization**: Out-of-order block buffering with active missing block requests
- **DDoS-Protected P2P**: Rate limiting and concurrent request management for network stability
- **Quantum-Resistant Genesis**: CRYSTALS-Dilithium3 Genesis block with encapsulated keys
- **Parallel Block Processing**: High-performance consecutive block processing (up to 10 blocks)
- **Reputation-Based Chain Weight**: Byzantine weight calculation using validator reputation scores

### **Previous Updates (v2.16.0)**
- **Turbine Block Propagation**: 85% bandwidth reduction with Reed-Solomon erasure coding
- **Quantum Proof of History (PoH)**: 500K hashes/sec with hybrid SHA3-512/Blake3 (25%/75%)
  - Production config: 5,000 hashes per tick × 100 ticks/sec = 500K hashes/sec
  - 100 ticks per second (10ms intervals) for smooth entropy generation
  - 5,000 hashes per tick (optimized for 1-second microblocks)
  - VDF properties via SHA3-512 every 4th hash (prevents parallelization)
  - Integrated into producer selection for unpredictable leader election
  - Checkpoint persistence with zstd compression (every 1M hashes)
  - Clock drift: 5-7% (excellent for production)
  - 72 bytes overhead per block (poh_hash: 64B + poh_count: 8B) = ~2-3%
  - Hardware: Intel Xeon E5-2680v4 @ 2.4GHz
- **Quantum-Resistant Producer Selection**: Threshold VRF with Dilithium + Ed25519 hybrid cryptography for Byzantine-safe leader election
- **Hybrid Sealevel Execution**: 5-stage pipeline with 10,000 parallel transactions
- **Tower BFT Adaptive Timeouts**: Dynamic 7s base to 20s max (1.5x multiplier) based on network conditions
- **Pre-Execution Cache**: Speculative execution with 10,000 transaction cache
- **Comprehensive Benchmark Harness**: Full performance testing suite for all components
- **57 API Endpoints**: Complete monitoring and control interface for all features

### **Current Session Updates (October 31, 2025)**
- **Emergency Producer System**: EMERGENCY_PRODUCER_FLAG for automatic failover
- **Global Synchronization Control**: Atomic flags preventing race conditions
- **Entropy Consensus Verification**: ENTROPY_RESPONSES cryptographic validation
- **Quantum Crypto Singleton**: GLOBAL_QUANTUM_CRYPTO instance management
- **Actor-Based Cache System**: CacheActor with versioning and epoch tracking
- **Real-Time Peer Discovery**: Immediate PeerDiscovery broadcast
- **Base64 Network Serialization**: Efficient binary data over JSON
- **PhaseAwareRewardManager**: Integrated reward system with ping tracking
- **Direct Node Connections**: getRandomBootstrapNode() decentralized access
- **Complete API Decentralization**: Removed all api.qnet.io dependencies

### **Previous Updates (v2.15.0)**
- **AES-256-GCM Database Encryption**: Quantum-resistant protection for activation codes
- **No Encryption Keys in Database**: Keys derived from activation code only
- **Critical Attack Protection**: Instant 1-year ban for database attacks (substitution, deletion, fork)
- **Privacy-Preserving Pseudonyms**: Enhanced network topology protection (14 log locations)
- **Genesis Bootstrap Grace**: 15-second timeout for first block (prevents false failover)
- **Genesis Wallet Synchronization**: Unified wallet format across all modules
- **Comprehensive Security Tests**: 52 total tests (9 new activation security tests)

### **Previous Updates (v2.14.0)**
- **Chain Integrity Validation**: Full verification of previous_hash in all blocks
- **Database Substitution Protection**: Detects and rejects forked/manipulated chains
- **Enhanced Synchronization Protection**: New nodes must fully sync before consensus participation
- **Storage Failure Handling**: Immediate failover if database fails during block production
- **Data Persistence Fix**: Removed /tmp fallback, enforces persistent Docker volumes

### **Previous Updates (v2.13.0)**
- **Atomic Rotation Rewards**: One +30 reward per full 30-block rotation (not 30x +1)
- **Activity-Based Recovery**: Reputation only recovers if node had recent ping activity
- **Self-Penalty Fix**: All failovers now apply -20 penalty, even voluntary ones
- **95% Decentralization**: Minimal Genesis protection for network stability
- **Jail System**: Progressive suspension with Genesis safeguard (no permanent ban)
- **Double-Sign Detection**: Automatic tracking and evidence collection (-50 reputation + jail)
- **Critical Failure Protection**: Genesis nodes get 30-day jail instead of ban at <10%
- **Anti-DDoS Protection**: Rate limiting and network flooding detection

### 🖥️ **DEVICE RESTRICTIONS**
- **Full/Super Nodes**: ONLY servers, VPS, desktops with interactive setup
- **Light Nodes**: ONLY mobile devices & tablets through mobile app

### 🚀 **Current Status: Production Testnet Ready (v2.12.0)**

**QNet production testnet is ready for deployment with advanced consensus and synchronization.**

- ✅ **Post-Quantum Cryptography**: CRYSTALS-Dilithium3 with NIST/Cisco encapsulated keys
- ✅ **Entropy-Based Consensus**: True decentralization with unpredictable producer rotation
- ✅ **Reputation System**: Economic incentives for network participation
- ✅ **State Snapshots**: Full & incremental snapshots with LZ4 compression
- ✅ **Parallel Synchronization**: Multi-worker downloads for fast sync
- ✅ **Deadlock Prevention**: Guard patterns & health monitors implemented
- ✅ **Two-Phase Activation**: 1DEV burn (Phase 1) → QNC Pool 3 (Phase 2)
- ✅ **Microblock Architecture**: 1-second blocks, 400k+ TPS (256 shards)
- ✅ **Production Rust Nodes**: Server deployment with real blockchain nodes
- ✅ **Browser Extension Wallet**: Production-ready with full-screen interface
- ✅ **Mobile Applications**: iOS/Android apps for Light nodes only
- ✅ **Interactive Setup**: Server nodes require interactive activation menu
- ✅ **IPFS Integration**: Optional P2P snapshot distribution
- ✅ **1DEV Burn Contract**: [D7g7mkL8o1YEex6ZgETJEQyyHV7uuUMvV3Fy3u83igJ7](https://explorer.solana.com/address/D7g7mkL8o1YEex6ZgETJEQyyHV7uuUMvV3Fy3u83igJ7?cluster=devnet) on Solana Devnet

### 📋 **Testnet Deployment**

For production testnet deployment, see: **[PRODUCTION_TESTNET_MANUAL.md](PRODUCTION_TESTNET_MANUAL.md)**
- ✅ **Performance Validated**: 10,000+ TPS sustained with <200ms latency
- ✅ **Security Audited**: Comprehensive security review completed

### 🎯 Key Features

- **🔐 Post-Quantum Security**: NIST/Cisco encapsulated keys with Dilithium3 + ephemeral Ed25519
- **⚡ Ultra-High Performance**: 424,411 TPS with zero-downtime consensus
- **🎲 True Decentralization**: VRF-based producer selection with deterministic fairness and quantum resistance
- **💰 Reputation Economics**: Rewards for block production (+1 micro, +10/+5 macro)
- **🔄 Advanced Synchronization**: State snapshots with parallel downloads & IPFS
- **🔥 Phase 1 Active**: 1DEV burn-to-join (1,500 → 300 1DEV minimum, universal pricing)
- **💎 Phase 2 Ready**: QNC Pool 3 system (5k-30k QNC dynamic pricing)
- **🌐 Scalable Architecture**: 256 shards, microblocks, lock-free operations (10M+ nodes)
- **🔗 Cross-Chain Compatibility**: Solana integration for Phase 1
- **🏛️ Decentralized Governance**: Community-driven decision making
- **📱 Mobile-First Design**: Light nodes on phones & tablets
- **🖥️ Server Architecture**: Full/Super nodes on dedicated servers
- **🔧 Interactive Setup**: User-friendly activation process
- **🛡️ Deadlock Prevention**: Guard patterns & health monitors for stability

#### **Advanced Performance Features**
- **🌪️ Turbine Protocol**: 85% bandwidth savings with chunked block propagation
- **⏱️ Quantum PoH**: 500K hashes/sec cryptographic clock for precise timing
- **⚙️ Hybrid Sealevel**: 10,000 parallel transactions with 5-stage pipeline
- **🎯 Tower BFT**: Adaptive timeouts (7s base to 20s max, 1.5x multiplier) for optimal consensus
- **🚀 Pre-Execution**: Speculative transaction processing with 10,000 cache size

### 📊 Performance Metrics

| Metric | Value | Description |
|--------|-------|-------------|
| **Throughput** | 424,411 TPS | 256 shards × 10k batch × zero-downtime |
| **Latency** | <100ms | Transaction confirmation time |
| **Finality** | <2 seconds | Block finalization |
| **Downtime** | ZERO | Swiss watch precision, continuous flow |
| **Energy Efficiency** | 99.9% less than Bitcoin | Eco-friendly consensus |
| **Node Types** | Full, Super, Light | Flexible participation |
| **Storage Efficiency** | 50-100 GB typical | Sliding window + snapshots |

### 💾 Ultra-Modern Storage Architecture

**QNet implements revolutionary storage system with temporal compression and delta encoding.**

#### 🎯 **Storage Features:**
- **Adaptive Temporal Compression**: Blocks age like wine - stronger compression over time
  - Day 0-1: No compression (hot data)
  - Day 2-7: Zstd-3 (light compression)
  - Day 8-30: Zstd-9 (medium compression)
  - Day 31-365: Zstd-15 (heavy compression)
  - Year 1+: Zstd-22 (extreme compression)
- **Delta Encoding**: Store only differences between blocks (95% space saving)
- **Pattern Recognition**: Smart compression for common transactions
  - Simple transfers: 300 → 16 bytes (95% reduction)
  - Node activations: 500 → 10 bytes (98% reduction)
  - Rewards: 400 → 13 bytes (97% reduction)
- **RocksDB Transaction Index**: O(1) transaction lookups with native key-value indexing
- **Hardware Auto-Tuning**: Automatically optimizes for available resources
  - **CPU Detection**: Uses all available cores (minimum 4 threads)
  - **Smart Validation**: Auto-enables parallel validation on 8+ core systems
  - **Adaptive Mempool**: Scales from 100k (test) to 2M (production) based on network size
  - Works on any hardware: 4-core VPS → 64-core server
  - No manual configuration - detects and adapts automatically
- **Dynamic Shard Auto-Scaling**: Automatically adjusts shard count based on real network size
  - Genesis (5 nodes): 1 shard
  - Growth (75k nodes): 2 shards
  - Scale (150k nodes): 4 shards
  - Max (19M+ nodes): 256 shards
  - **Blockchain Registry Integration**: Reads actual activated node count from storage
  - Multi-source detection: Monitoring → Genesis → Blockchain → Default
  - **Recalculation on restart**: Every node startup reads fresh network size
  - No manual configuration - system adapts to network growth automatically
- **EfficientMicroBlocks**: Store transaction hashes instead of full transactions
- **Sliding Window Storage**: Full nodes keep only last 100K blocks (~1 day) + snapshots
- **Smart Pruning**: Automatic deletion of blocks outside retention window
- **Snapshot-Based Sync**: New nodes bootstrap in minutes, not hours
- **Node-Specific Storage**:
  - Light nodes: ~100 MB (headers only)
  - Full nodes: ~50 GB (100K blocks + snapshots)
  - Super nodes: 400-500 GB for 100 years of history (with full compression)
- **Distributed Archival**: Full/Super nodes archive 3-8 chunks each as network obligation
- **Triple Replication**: Every data chunk replicated across 3+ nodes minimum
- **Automatic Compliance**: Network enforces archival obligations for fault tolerance
- **Backward Compatible**: Seamless migration from legacy storage format

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    QNet Blockchain                         │
├─────────────────────────────────────────────────────────────┤
│  Post-Quantum Crypto Layer                                 │
│  ├── CRYSTALS-Dilithium (Signatures)                       │
│  ├── CRYSTALS-Kyber (Key Exchange)                         │
│  └── SPHINCS+ (Hash-based Signatures)                      │
├─────────────────────────────────────────────────────────────┤
│  Consensus Layer with VRF-Based Selection                  │
│  ├── Microblock Production (1s intervals)                  │
│  │   ├── Threshold VRF with quantum-resistant crypto       │
│  │   ├── Dilithium + Ed25519 hybrid signatures             │
│  │   ├── 30-block rotation with deterministic selection    │
│  │   ├── Race-free at boundaries (no delays)               │
│  │   ├── Producer rewards: +1 reputation per block         │
│  │   └── Full/Super nodes only (reputation >= 70%)        │
│  ├── Macroblock Consensus (90s intervals)                  │
│  │   ├── Byzantine consensus with 1000 validators          │
│  │   ├── Active listener on all Full/Super nodes (1s poll) │
│  │   ├── Consensus window: blocks 61-90 (early start)      │
│  │   ├── Leader: +10 reputation, Participants: +5 each     │
│  │   ├── Deterministic initiator selection                 │
│  │   └── 67% honest validator requirement                  │
│  └── Advanced Synchronization                              │
│      ├── State snapshots: Full (10k blocks) & Incremental  │
│      ├── Parallel downloads with 100-block chunks          │
│      ├── IPFS integration for P2P snapshot distribution    │
│      └── Deadlock prevention with guard pattern            │
├─────────────────────────────────────────────────────────────┤
│  Performance Optimization Layer                   │
│  ├── Turbine Block Propagation                             │
│  │   ├── 1KB chunks with Reed-Solomon erasure coding       │
│  │   ├── Fanout-4 exponential propagation (Genesis optimized) │
│  │   └── 85% bandwidth reduction                           │
│  ├── Quantum Proof of History (QPoH)                       │
│  │   ├── 500K hashes/sec cryptographic clock               │
│  │   ├── SHA3-512 + Blake3 hybrid (25%/75%)                │
│  │   └── Verifiable delay function                         │
│  ├── Hybrid Sealevel Execution                             │
│  │   ├── 5-stage pipeline processing                       │
│  │   ├── 10,000 parallel transactions                      │
│  │   └── Dependency graph analysis                         │
│  ├── Tower BFT Adaptive Timeouts                           │
│  │   ├── Dynamic 20s/10s/7s timeouts                       │
│  │   └── Network condition awareness                       │
│  └── Pre-Execution Cache                                   │
│      ├── Speculative transaction execution                 │
│      ├── 10,000 transaction cache                          │
│      └── 3-block lookahead                                 │
├─────────────────────────────────────────────────────────────┤
│  Network Layer (Optimized for 10M+ nodes)                  │
│  ├── Kademlia DHT with K-bucket management                 │
│  ├── Lock-Free DashMap for O(1) operations                 │
│  ├── Dual Indexing (by address & ID)                       │
│  ├── 256 Shards with Cross-Shard Routing                   │
│  ├── Auto-Scaling (5→100→10K→1M+ nodes)                    │
│  ├── Gossip Protocol                                       │
│  ├── Regional Node Clustering                              │
│  └── Emergency Producer Change Broadcasting                │
├─────────────────────────────────────────────────────────────┤
│  Application Layer                                         │
│  ├── Smart Contracts (WASM)                                │
│  ├── DeFi Protocols                                        │
│  └── Cross-Chain Bridges                                   │
└─────────────────────────────────────────────────────────────┘
```

## 🔄 Chain Reorganization & Synchronization

QNet implements advanced chain reorganization and synchronization mechanisms for network consistency:

### **Chain Reorganization (Byzantine-Safe)**
- **Fork Detection**: Automatic detection of competing blockchain forks
- **Byzantine Weight Calculation**: Reputation-based chain weight with unique validator counting
- **2/3 Majority Consensus**: Requires 67% Byzantine threshold for reorganization
- **Deep Reorg Protection**: Maximum 100 blocks reorganization depth (51% attack prevention)
- **Race Condition Prevention**: Single concurrent reorg with lock-free coordination
- **DoS Protection**: Rate limiting (1 fork attempt per 60 seconds maximum)
- **Reputation Capping**: Maximum 95% reputation to prevent single-node dominance
- **Async Processing**: Non-blocking fork analysis in background tasks
- **Automatic Rollback**: Full backup and restore on reorganization failure

### **Advanced Block Synchronization**
- **Out-of-Order Buffering**: Temporary storage for blocks received before their dependencies
- **Active Block Requests**: DDoS-protected requests for missing blocks (max 10 concurrent)
- **Parallel Block Processing**: Processes up to 10 consecutive blocks simultaneously
- **Request Cooldown**: 10-second minimum between requests for same block (max 3 attempts)
- **Automatic Retry**: Re-queues buffered blocks when dependencies arrive
- **Memory Management**: Automatic cleanup of blocks older than 60 seconds
- **Genesis Coordination**: Only node_001 creates Genesis block in bootstrap mode
- **Quantum-Resistant Genesis**: CRYSTALS-Dilithium signature ensures identical Genesis across all nodes

### **Proof of History (PoH) Integration**
- **Cryptographic Clock**: 500K hashes/sec SHA3-512 + Blake3 hybrid (25%/75%)
- **Verifiable Delay Function**: Time-stamped block ordering without central authority
- **Block Time Synchronization**: Sub-second precision across distributed network
- **Historical Proof**: Cryptographic evidence of event ordering and timing
- **Fork Prevention**: PoH creates immutable timeline making forks computationally expensive

### **Network Synchronization Metrics**
- **Sync Speed**: Up to 10,000 blocks/second with parallel processing
- **Fork Resolution**: <5 seconds for Byzantine weight calculation
- **Missing Block Request**: <100ms average request latency
- **Reorg Execution**: 50-200ms for typical reorganizations (background)
- **Memory Overhead**: <10MB for block buffering and request tracking

## 🆘 Enterprise Failover System

QNet implements production-grade failover mechanisms for zero-downtime operation:

### **Microblock Producer Failover**
- **Rotation Schedule**: Every 30 blocks (30 seconds) for stability
- **Participant Filter**: Only Full and Super nodes (Light nodes excluded for mobile optimization)
- **Producer Readiness Validation**: Pre-creation checks (reputation ≥70%, network health, connectivity)
- **Fixed Timeout Detection**: 5 seconds (deterministic for consensus safety across all nodes)
- **Emergency Selection**: Deterministic fallback selection from qualified backup producers (SHA3-256 hash)
- **Enhanced Status Visibility**: Comprehensive failover dashboard with recovery metrics
- **Network Recovery**: <7 seconds automatic recovery time with full broadcast success tracking
- **Reputation Impact**: -20.0 penalty for failed producer, +5.0 reward for emergency takeover

### **Emergency Mode (Network-Wide Degradation)**
When all nodes fall below 70% reputation threshold:
- **Progressive Degradation**: Tries thresholds 50% → 40% → 30% → 20%
- **Emergency Boost**: +30% reputation to Genesis nodes, +50% to regular nodes
- **Forced Recovery**: Selects any responding node as emergency producer
- **Genesis Protection**: Always tries to recover with Genesis nodes first
- **Network Continuity**: Ensures blockchain never halts completely

### **Macroblock Leader Failover**
- **Byzantine Consensus**: Full commit-reveal with 67% honest assumption
- **Timeout Detection**: 30-second threshold for macroblock creation
- **Emergency Re-consensus**: Automatic restart excluding failed leader
- **Leader Exclusion**: Failed leaders temporarily excluded from future rounds
- **Network Recovery**: <45 seconds automatic consensus restart
- **Reputation Impact**: -30.0 penalty for failed macroblock leader

### **Zero Single Points of Failure**
- **No Producer Dependency**: Any qualified node can become emergency producer
- **Automatic Recovery**: No human intervention required for network restoration
- **Progressive Penalties**: Escalating reputation penalties prevent repeated failures
- **Network Transparency**: All failover events logged and broadcast to peers

## 💎 Reputation System

QNet implements an economic reputation system that incentivizes network participation:

### **Reputation Rewards (Atomic System)**
| Action | Reward | Frequency |
|--------|--------|-----------|
| **Complete Full Rotation** | +30 | Every 30 blocks (one atomic reward) |
| **Partial Rotation** | Proportional | Based on blocks created before failover |
| **Lead Macroblock Consensus** | +10 | Every 90 seconds |
| **Participate in Consensus** | +5 | Every 90 seconds |
| **Emergency Producer** | +5 | On failover events |
| **Successful Ping** | +1 | Every 4 hours |

### **Reputation System (Atomic Rewards)**
| Action | Penalty/Reward | Impact |
|--------|----------------|--------|
| **Full Rotation (30 blocks)** | +30.0 | Complete producer rotation |
| **Partial Rotation** | Proportional | e.g., 15 blocks = +15.0 |
| **Failed Microblock** | -20.0 | Lost producer slot (applies to self) |
| **Successful Macroblock Leader** | +10.0 | Consensus leadership |
| **Successful Macroblock Participant** | +5.0 | Consensus participation |
| **Failed Macroblock** | -30.0 | Consensus failure |
| **Failed Ping** | -2.0 | Connection issue |
| **Double-Sign** | -50.0 | Byzantine fault |
| **Emergency Producer** | +5.0 | Network service |
| **Recovery Rate** | +0.7%/hour | ONLY if active (had ping) |

### **Reputation Thresholds**
- **70+ points**: Eligible for consensus participation (70% minimum)
- **40+ points**: Eligible for rewards from all pools
- **10-39 points**: Network access only, no rewards
- **<10 points**: Network ban (7-day recovery period)
- **Maximum**: 100 points (hard cap)

### **Anti-Malicious Protection System**

#### **Jail System (Temporary Suspension)**
Progressive penalties for repeat offenders:

| Offense Count | Jail Duration | Recovery After Jail |
|--------------|---------------|---------------------|
| 1st offense | 1 hour | Restore to 30% |
| 2nd offense | 24 hours | Restore to 25% |
| 3rd offense | 7 days | Restore to 20% |
| 4th offense | 30 days | Restore to 15% |
| 5th offense | 3 months | Restore to 10% |
| 6+ offenses | 1 year maximum | Governance review |

**Stability Protection (Minimal):**
- Genesis nodes: Cannot be permanently banned (network stability)
- Critical failure (<10%): 30-day jail instead of ban
- After jail: Restore to 10% (alive but no consensus)
- Regular nodes: Full ban at <10% (true penalties)
- Balance: 95% decentralization with 5% stability safeguard

#### **Malicious Behavior Detection**

| Attack Type | Detection Method | Penalty |
|-------------|-----------------|---------|
| **Double-Sign** | Multiple signatures at same height | -50.0 points |
| **Invalid Block** | Failed cryptographic verification | -30.0 points |
| **Time Manipulation** | Block timestamp >5s in future | -20.0 points |
| **Network Flooding** | >100 msgs/sec from single node | -10.0 points |
| **Invalid Consensus** | Malformed commit/reveal | -5.0 points |

### **VRF-Based Producer Selection**
```rust
// Quantum-resistant threshold VRF for fair producer selection
// Each qualified node computes VRF output independently
vrf_input = SHA3_256(
    leadership_round + 
    sorted_candidates +
    macroblock_hash  // or deterministic fallback
);

// Node evaluates VRF using Dilithium + Ed25519 hybrid crypto
vrf_output = hybrid_vrf.evaluate(vrf_input).await?;
threshold = u64::MAX / candidates.len();

// Node becomes producer if VRF output below threshold
if vrf_output.value < threshold {
    selected_producer = current_node;
} else {
    // Deterministic fallback if no node passes threshold
    fallback_producer = SHA3_256(vrf_input) % candidates.len();
}
```

## 🔄 Advanced Synchronization

QNet implements state-of-the-art synchronization for rapid network joining:

### **State Snapshots**
- **Full Snapshots**: Every 10,000 blocks (complete blockchain state)
- **Incremental Snapshots**: Every 1,000 blocks (delta changes only)
- **Compression**: LZ4 for efficient storage (~70% reduction)
- **Verification**: SHA3-256 integrity checks
- **Auto-Cleanup**: Keep only latest 5 snapshots

### **P2P Distribution**
- **IPFS Integration**: Optional decentralized snapshot sharing
- **Multiple Gateways**: Redundant download sources
- **Peer Announcements**: Automatic broadcast of new snapshots
- **Pin on Upload**: Ensures persistence in IPFS network

### **Parallel Synchronization**
- **Fast Sync Trigger**: Activates when >50 blocks behind
- **Multiple Workers**: Concurrent block downloads
- **Chunk Processing**: 100-block batches for efficiency
- **Timeout Protection**: 60s fast sync, 30s normal sync
- **Deadlock Prevention**: Guard pattern with automatic reset

### **Configuration**
```bash
# Optional IPFS integration
export IPFS_API_URL="http://your-ipfs-node:5001"

# Sync parameters (defaults)
FAST_SYNC_THRESHOLD=50
SYNC_CHUNK_SIZE=100
SYNC_WORKERS=4
```

## 🖥️ System Requirements

### Minimum Requirements (Light Node)

| Component | Specification |
|-----------|---------------|
| **CPU** | 2 cores, 2.0 GHz |
| **RAM** | 4 GB |
| **Storage** | 50 GB SSD |
| **Network** | 10 Mbps |
| **OS** | Linux, macOS, Windows |

### Recommended Requirements (Full Node)

| Component | Specification |
|-----------|---------------|
| **CPU** | 4 cores, 3.0 GHz |
| **RAM** | 16 GB |
| **Storage** | 500 GB NVMe SSD |
| **Network** | 100 Mbps |
| **OS** | Ubuntu 20.04+ / CentOS 8+ |

### High-Performance Requirements (Super Node)

| Component | Specification |
|-----------|---------------|
| **CPU** | 8+ cores, 3.5+ GHz (Intel i7/AMD Ryzen 7) |
| **RAM** | 32+ GB DDR4 |
| **Storage** | 1+ TB NVMe SSD (3000+ IOPS) |
| **Network** | 1 Gbps dedicated |
| **OS** | Ubuntu 22.04 LTS |

## 🚀 Quick Start

### ⚠️ MANDATORY EXECUTION POLICY

**SECURITY CRITICAL: Node execution is strictly controlled**

| Node Type | Allowed Execution Method | Prohibited |
|-----------|-------------------------|------------|
| **Genesis Nodes** | ✅ Docker containers only | ❌ Direct binary execution |
| **Full/Super Nodes** | ✅ Docker containers only | ❌ Direct binary execution |
| **Light Nodes** | ✅ Official mobile apps only | ❌ Server execution |

**IMPORTANT:**
- Direct execution of `qnet-node.exe` or `qnet-node` binary is **BLOCKED**
- The binary will refuse to run outside Docker environment
- This is enforced for security and network integrity

### Prerequisites

```bash
# Update system packages
sudo apt update && sudo apt upgrade -y

# Install essential packages
sudo apt install -y curl wget git htop nano ufw fail2ban build-essential cmake pkg-config libssl-dev

# Configure timezone
sudo timedatectl set-timezone UTC
```

### Install Rust

QNet requires the latest Rust toolchain for optimal performance and security.

```bash
# Install Rust using rustup
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

# Source the environment
source ~/.cargo/env

# Update to latest Rust version
rustup update

# Verify installation
rustc --version
cargo --version
```

### Clone Repository

```bash
# Clone to home directory for production deployment
cd ~
git clone https://github.com/AIQnetLab/QNet-Blockchain.git
cd QNet-Blockchain

# Switch to testnet branch (latest production code)
git checkout testnet
git pull origin testnet
```

### Production Deployment (ONLY METHOD)

⚠️ **Single Deployment Method**: QNet uses ONLY Docker deployment for production servers.

⚠️ **Fully Automatic Configuration**: Everything is auto-configured including Solana contracts, ports, region, and performance settings.

⚠️ **Interactive Activation Only**: Node requires activation code input through interactive menu.

### Complete Production Setup

```bash
# Clone and checkout testnet
git clone https://github.com/AIQnetLab/QNet-Blockchain.git
cd QNet-Blockchain
git checkout testnet
git pull origin testnet

# Build production Docker image
docker build -f development/qnet-integration/Dockerfile.production -t qnet-production .

# Run interactive production node (ONLY command needed)
docker run -it --name qnet-node --restart=always \
  -p 9876:9876 -p 9877:9877 -p 8001:8001 \
  -v $(pwd)/node_data:/app/node_data \
  qnet-production

# During interactive setup:
# 1. Select network (testnet/mainnet) 
# 2. Enter activation code from wallet extension
# 3. Node activates automatically

# Get activation codes via QNet wallet extension or mobile app (P2P decentralized system)
```

**Note**: All Solana contract configuration is embedded in the Docker image. No manual configuration required.

### 🔗 Contract Deployment Proofs

**1DEV Burn Contract is successfully deployed on Solana Devnet:**

- **🔴 Program Address**: [D7g7mkL8o1YEex6ZgETJEQyyHV7uuUMvV3Fy3u83igJ7](https://explorer.solana.com/address/D7g7mkL8o1YEex6ZgETJEQyyHV7uuUMvV3Fy3u83igJ7?cluster=devnet)
- **📦 Program Data**: [HMbSTfp7fqsMopRqEy5u4fxQgLnYmM7ThPZzoo2VF4Gm](https://explorer.solana.com/address/HMbSTfp7fqsMopRqEy5u4fxQgLnYmM7ThPZzoo2VF4Gm?cluster=devnet)
- **💰 Deployer Wallet**: [6gesV5Dojg9tfH9TRytvXabnQT8U7oMbz5VKpTFi8rG4](https://explorer.solana.com/address/6gesV5Dojg9tfH9TRytvXabnQT8U7oMbz5VKpTFi8rG4?cluster=devnet)
- **🚀 Deploy Transaction**: [4z2A93vJ527LayPu8baer4MxYT8hVkoGCumCeJPpn6mmKZUpPtFmzFatFg7sTA5wzCUubuLupmKRTcA26EwpcwRR](https://explorer.solana.com/tx/4z2A93vJ527LayPu8baer4MxYT8hVkoGCumCeJPpn6mmKZUpPtFmzFatFg7sTA5wzCUubuLupmKRTcA26EwpcwRR?cluster=devnet)

**Contract Status:**
- ✅ **Immutable** (no upgrade authority)
- ✅ **Size**: 368,896 bytes
- ✅ **Slot**: 396,252,496
- ✅ **Network**: Solana Devnet

**Note**: Without these environment variables, the node will use development fallback data for testing.

⚠️ **Real Pricing Data**: When configured, the node fetches real burn percentage and network size from the Solana contract to show accurate pricing.

⚠️ **1DEV Token**: Real token address `Wkg19zERBsBiyqsh2ffcUrFG4eL5BF5BWkg19zERBsBi` on Solana devnet (Phase 1 ready).

⚠️ **Activation Codes**: Real activation codes are still generated through browser extension or mobile app, regardless of displayed pricing.

### 🖥️ Server Node Installation & Management

**Production Docker Deployment (ONLY METHOD):**

```bash
# Clone and checkout testnet
git clone https://github.com/AIQnetLab/QNet-Blockchain.git
cd QNet-Blockchain
git checkout testnet
git pull origin testnet

# Build production Docker image
docker build -f development/qnet-integration/Dockerfile.production -t qnet-production .

# Run interactive production node
docker run -it --name qnet-node --restart=always \
  -p 9876:9876 -p 9877:9877 -p 8001:8001 \
  -v $(pwd)/node_data:/app/node_data \
  qnet-production
```

**Clean Build & Cache:**

```bash
# Clean Docker system cache
docker system prune -f

# Remove all unused Docker images
docker image prune -a -f

# Clean node_modules if present
find . -name "node_modules" -type d -exec rm -rf {} +

# Clean .next and dist directories
find . -name ".next" -type d -exec rm -rf {} +
find . -name "dist" -type d -exec rm -rf {} +

# Rebuild Docker image from clean state
docker build --no-cache -f development/qnet-integration/Dockerfile.production -t qnet-production .
```

**Node Management:**

```bash
# Check running containers
docker ps

# View logs
docker logs -f qnet-node

# Stop node
docker stop qnet-node

# Restart node
docker restart qnet-node

# Remove node (keeps data volume)
docker rm qnet-node
```

### Additional Node Operations

#### Remove Node Data

```bash
# Remove node data volume (keeps Docker image)
docker volume rm qnet-node-data

# Remove entire installation
rm -rf ~/QNet-Blockchain

# Clean Docker resources
docker system prune -f
```

#### Backup Before Removal

```bash
# Backup important data before removal
mkdir -p ~/qnet-backup
cp -r ~/QNet-Blockchain/node_data/config ~/qnet-backup/
cp ~/QNet-Blockchain/node_data/*.key ~/qnet-backup/ 2>/dev/null || true

# Remove node data
rm -rf ~/QNet-Blockchain/node_data
```

⚠️ **Important**: Node deactivation from QNet network requires activation code expiry or manual deregistration through mobile app/browser extension.

## 📄 Node Setup Guides

QNet nodes run natively for maximum performance. Choose your node type based on available resources.

### 💡 Node Setup (Interactive Menu)

QNet nodes use device-specific deployment methods:

**Server Nodes (Full/Super)**: Interactive setup menu on dedicated servers
**Mobile Nodes (Light)**: Mobile app activation on phones & tablets

### Node Types & Platform Support

| Node Type | Platform | Activation Method | API Server | Features |
|-----------|----------|-------------------|------------|----------|
| **Light** | 📱 Mobile phones & tablets | Mobile app only | ❌ No | Basic sync, wallet |
| **Full** | 🖥️ Servers, VPS, desktops | Interactive setup | ✅ Yes | Full validation, API |
| **Super** | 🖥️ Servers, VPS, desktops | Interactive setup | ✅ Yes | Enhanced features, API |

### Device Restrictions

**⚠️ CRITICAL LIMITATIONS:**
- **Light Nodes**: Cannot be activated on servers/desktops
- **Full/Super Nodes**: Cannot be activated on mobile devices
- **API Access**: Only Full/Super nodes provide REST endpoints

#### Automatic Node Setup

```bash
# Configure firewall (ports auto-selected if 9876/9877 unavailable)
sudo ufw allow 9876  # P2P port (default)
sudo ufw allow 9877  # RPC port (default)
sudo ufw allow 9878  # Metrics port
sudo ufw --force enable

# Run auto-configured node setup (ZERO CONFIGURATION REQUIRED)
cd ~/QNet-Blockchain
./target/release/qnet-node
```

**New Features:**
- ✅ **Auto-port selection**: Finds available ports if defaults are busy
- ✅ **Auto-region detection**: Detects your location via IP geolocation
- ✅ **Auto-performance tuning**: Always enables 100k+ TPS optimizations
- ✅ **Auto-bootstrap peers**: Selects optimal peers for your region
- ✅ **Smart data directory**: Standard `node_data` location

#### What You'll See (Auto-Configuration)

```
🚀 === QNet Production Node Setup === 🚀
🖥️  SERVER DEPLOYMENT MODE
Welcome to QNet Blockchain Network!

🔧 Auto-configuring QNet node...
🌍 Auto-detecting region from IP address...
✅ Region auto-detected: Europe
🔌 Selected ports: P2P=9876, RPC=9877
📁 Data directory: "node_data"
🔗 Bootstrap peers: ["eu-bootstrap-1.qnet.io:9876", "eu-bootstrap-2.qnet.io:9876"]

🔍 Detecting current network phase...
✅ Phase 1 detected

📊 === Current Network Status ===
🔥 Phase 1: 1DEV Burn-to-Join Active
   📈 1DEV Burned: 45.0%
   💰 Universal Pricing: Same cost for all node types
   📉 Dynamic Reduction: Lower prices as more tokens burned

🖥️  === Server Node Type Selection ===
⚠️  SERVERS ONLY SUPPORT FULL/SUPER NODES
📱 Light nodes are restricted to mobile devices only

Choose your server node type:
1. Full Node   - Servers/desktops, full validation
2. Super Node  - High-performance servers, maximum rewards

💰 Current Pricing:
   1. Full Node  : 900 1DEV
   2. Super Node : 900 1DEV

Enter your choice (1-2): 
```

#### Setup Steps

1. **Auto-Configuration**: System automatically detects region, ports, and performance settings
2. **Select Node Type**: Choose between Full Node (1) or Super Node (2) 
3. **Enter Activation Code**: Provide your activation code from QNet wallet app
4. **Node Starts**: Fully optimized node with 100k+ TPS capabilities begins sync

#### Activation Code Requirements

- **Get activation code**: Use QNet Browser Extension or Mobile App
- **Purchase node license**: Burn 1DEV tokens (Phase 1) or transfer QNC to Pool 3 (Phase 2) 
- **Server restriction**: Full and Super nodes only for servers
- **Light nodes**: Mobile devices only - use QNet mobile app

### 🔧 System Optimization (Optional)

For optimal performance, especially for Super nodes, consider these system optimizations:

#### Performance Tuning

```bash
# System optimization for high-performance nodes
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
echo 'net.core.rmem_max=134217728' | sudo tee -a /etc/sysctl.conf
echo 'net.core.wmem_max=134217728' | sudo tee -a /etc/sysctl.conf
echo 'net.core.netdev_max_backlog=5000' | sudo tee -a /etc/sysctl.conf
echo 'net.ipv4.tcp_congestion_control=bbr' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p

# Optional: CPU governor for performance (not required by QNet)
# echo 'performance' | sudo tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor

# Disable huge pages if not needed
echo 'never' | sudo tee /sys/kernel/mm/transparent_hugepage/enabled

# Increase file descriptor limits
echo "* soft nofile 65536" | sudo tee -a /etc/security/limits.conf
echo "* hard nofile 65536" | sudo tee -a /etc/security/limits.conf
```

#### Docker Container Management

```bash
# Check running containers
docker ps | grep qnet-node

# View real-time logs
docker logs qnet-node -f

# Stop node
docker stop qnet-node

# Restart node
docker restart qnet-node

# Remove container (keeps data volume)
docker rm qnet-node
```

## 🔍 Node Management

### Check Node Status

```bash
# Check if container is running
docker ps | grep qnet-node

# View real-time logs
docker logs qnet-node -f

# Check resource usage
docker stats qnet-node --no-stream
```

### Test Node Connectivity

```bash
# Test REST API endpoint
curl http://localhost:8001/api/v1/node/health

# Check peer connections
curl http://localhost:8001/api/v1/peers

# Check blockchain height
curl http://localhost:9877/api/v1/height

# Check sync status
curl http://localhost:8001/api/v1/node/info
```

### Update Node

```bash
# Navigate to repository
cd ~/QNet-Blockchain

# Pull latest changes
git pull origin testnet

# Stop and remove old container
docker stop qnet-node
docker rm qnet-node

# Rebuild Docker image
docker build -f development/qnet-integration/Dockerfile.production -t qnet-production .

# Run updated container
docker run -it --name qnet-node --restart=always \
  -p 9876:9876 -p 9877:9877 -p 8001:8001 \
  -v $(pwd)/node_data:/app/node_data \
  qnet-production
```

**🔄 Automatic Optimization on Restart:**
- **Shard count** recalculates based on current network size
- **Storage window** adjusts automatically for optimal performance
- **No manual configuration needed** - node adapts to network growth
- Example: Network grew 5k→150k nodes → restarts with 4 shards instead of 1

### 🔄 Automatic Node Replacement

**QNet features automatic node replacement when activating on a new server:**

#### How It Works
- **1 Wallet = 1 Active Node**: Only one node per type per wallet can be active
- **Seamless Migration**: Activate on new server → old node automatically shuts down
- **Quantum-Secure**: All replacement signals use CRYSTALS-Dilithium signatures
- **Blockchain Authority**: Blockchain records are the source of truth

#### Migration Scenarios
1. **Server Migration**: Move Full/Super node to new hardware
2. **Hardware Upgrade**: Seamless transition to more powerful server
3. **Node Type Upgrade**: Full → Super activation replaces Full node
4. **Disaster Recovery**: Reactivate on new server after hardware failure

#### Example: Server Migration
```bash
# On NEW server - activate with same activation code
docker run -it --name qnet-node --restart=always \
  -e QNET_PRODUCTION=1 \
  -e QNET_BOOTSTRAP_ID=YOUR_ID \
  -p 9876:9876 -p 9877:9877 -p 8001:8001 \
  -v $(pwd)/node_data:/app/node_data \
  qnet-production

# Result: Old server node receives shutdown signal and terminates
# New server becomes the active node for your wallet
```

**⚠️ Important Notes:**
- No manual migration required - fully automatic
- Previous node data remains on old server (backup if needed)
- Activation codes remain valid - bound to wallet, not hardware
- Light nodes (mobile) work the same way across devices

### Backup Node Data

```bash
# Create backup
sudo tar czf /backup/qnet-backup-$(date +%Y%m%d).tar.gz ~/QNet-Blockchain/node_data

# Restore from backup
sudo tar xzf /backup/qnet-backup-YYYYMMDD.tar.gz -C ~/QNet-Blockchain/
sudo chown -R qnet:qnet ~/QNet-Blockchain/node_data
```

## 🌐 Network Configuration

### Production Network (Mainnet)

```bash
# Mainnet nodes automatically connect to production bootstrap nodes
# No additional configuration required
```

### Test Network (Testnet)

Current deployment runs on testnet automatically. Network selection is handled during the interactive setup - no manual configuration required.

### Regional Configuration

Regional selection is handled automatically during the interactive setup based on your server's IP location. The system auto-detects your optimal region for best performance:

- **North America**: US, Canada, Mexico
- **Europe**: EU countries, UK, Norway, Switzerland
- **Asia**: Japan, Singapore, Hong Kong, South Korea
- **South America**: Brazil, Argentina, Chile
- **Africa**: South Africa, Nigeria, Kenya
- **Oceania**: Australia, New Zealand

No manual configuration required - regions are detected and selected automatically.

## 🔍 Monitoring & Maintenance

### Health Checks

```bash
# Check node health
curl http://localhost:8001/api/v1/node/health

# Check peer connections
curl http://localhost:8001/api/v1/peers

# Check blockchain height
curl http://localhost:9877/api/v1/height

# Check node info
curl http://localhost:8001/api/v1/node/info
```

### Log Analysis

```bash
# View recent logs (live monitoring)
docker logs qnet-node -f

# View detailed blockchain logs (if running in background)
tail -f node_data/qnet-node.log

# Search for errors
docker logs qnet-node | grep "ERROR"

# Monitor blockchain activity (blocks, consensus, P2P)
docker logs qnet-node | grep "CONSENSUS\|BLOCK\|P2P\|SYNC"

# Monitor performance metrics
docker logs qnet-node | grep "TPS\|latency\|performance"

# View peer connections and network status
docker logs qnet-node | grep "peer\|connection\|discovery"

# View last 100 lines
docker logs qnet-node --tail 100

# Filter by log level
docker logs qnet-node | grep "\[DEBUG\]\|\[INFO\]\|\[WARN\]\|\[ERROR\]"
```

### Genesis Node Deployment

For genesis bootstrap nodes (production network initialization):

```bash
# TESTNET Genesis Nodes:
# Genesis Node #001 (NorthAmerica)
docker run -d --name qnet-testnet-genesis-001 --restart=always \
  -e QNET_NETWORK=testnet \
  -e QNET_PRODUCTION=1 \
  -e QNET_BOOTSTRAP_ID=001 \
  -p 9876:9876 -p 9877:9877 -p 8001:8001 \
  -v $(pwd)/testnet_genesis_001:/app/data \
  qnet-production

# Genesis Node #002 (Europe) 
docker run -d --name qnet-testnet-genesis-002 --restart=always \
  -e QNET_NETWORK=testnet \
  -e QNET_PRODUCTION=1 \
  -e QNET_BOOTSTRAP_ID=002 \
  -p 9878:9876 -p 9879:9877 -p 8002:8001 \
  -v $(pwd)/testnet_genesis_002:/app/data \
  qnet-production

# MAINNET Genesis Nodes:
# Genesis Node #001 (NorthAmerica)
docker run -d --name qnet-mainnet-genesis-001 --restart=always \
  -e QNET_NETWORK=mainnet \
  -e QNET_PRODUCTION=1 \
  -e QNET_BOOTSTRAP_ID=001 \
  -p 9876:9876 -p 9877:9877 -p 8001:8001 \
  -v $(pwd)/mainnet_genesis_001:/app/data \
  qnet-production
```

**Genesis Node Requirements:**
- Set `QNET_BOOTSTRAP_ID` to 001-005 for genesis nodes
- Use different ports for multiple nodes on same server
- Create separate data directories for each node  
- Ensure proper file permissions: `chmod 777 node_data_XXX/`

**🔒 Genesis Node Security (IP-Based Authorization):**
- **IP Restriction**: Genesis nodes can ONLY run from pre-authorized IP addresses
- **Duplicate Prevention**: System blocks attempts to run duplicate Genesis nodes from unauthorized IPs
- **Auto-Detection**: Node automatically detects server IP and validates against authorized list
- **Manual Override**: Use `QNET_MANUAL_IP=your.server.ip` for custom IP specification
- **Migration Ready**: Easy to update authorized IP list for server migrations (VPS→VDS)

**Authorized Genesis IPs (Default):**
```bash
154.38.160.39   # Genesis Node 001
62.171.157.44   # Genesis Node 002  
161.97.86.81    # Genesis Node 003
173.212.219.226 # Genesis Node 004
164.68.108.218  # Genesis Node 005
```

**Custom Genesis IPs:**
```bash
# Override default IPs via environment variable
export QNET_GENESIS_NODES="ip1,ip2,ip3,ip4,ip5"
# Or create genesis-nodes.json config file
```

### Quick Testnet Launch (5 Genesis Nodes)

For rapid testnet deployment with coordinated genesis nodes:

```bash
# Quick testnet startup for developers
# Note: This is for QNet team development only
# Regular users should only run individual nodes (see commands above)

# Start 5 genesis nodes manually:
docker build -f development/qnet-integration/Dockerfile.production -t qnet-production .

# Genesis Node 1
docker run -d --name qnet-genesis-001 --restart=always \
  -e QNET_NETWORK=testnet \
  -e QNET_PRODUCTION=1 \
  -e QNET_BOOTSTRAP_ID=001 \
  -p 9876:9876 -p 9877:9877 -p 8001:8001 \
  -v $(pwd)/genesis_001:/app/data \
  qnet-production

# Genesis Node 2  
docker run -d --name qnet-genesis-002 --restart=always \
  -e QNET_NETWORK=testnet \
  -e QNET_PRODUCTION=1 \
  -e QNET_BOOTSTRAP_ID=002 \
  -p 9878:9876 -p 9879:9877 -p 8002:8001 \
  -v $(pwd)/genesis_002:/app/data \
  qnet-production

# Repeat for nodes 003, 004, 005...

# Monitor nodes
docker logs -f qnet-genesis-001

# Stop all
docker stop qnet-genesis-001 qnet-genesis-002 qnet-genesis-003 qnet-genesis-004 qnet-genesis-005
docker rm qnet-genesis-001 qnet-genesis-002 qnet-genesis-003 qnet-genesis-004 qnet-genesis-005
```

**Genesis Node Endpoints:**
- Genesis Node 1: http://localhost:8001
- Genesis Node 2: http://localhost:8002  
- Genesis Node 3: http://localhost:8003
- Genesis Node 4: http://localhost:8004
- Genesis Node 5: http://localhost:8005

**Note**: Activation codes are generated automatically by QNet consensus when burn transactions are detected on Solana.

---

## ⚛️ Quantum Decentralized Activation System

### 🔬 **How Quantum Blockchain Generates Codes:**

#### **1️⃣ Autonomous Solana Monitoring:**
```rust
// Every QNet node independently monitors Solana blockchain
let burn_transactions = monitor_solana_burns().await;
for burn_tx in burn_transactions {
    if burn_tx.amount >= required_1dev && burn_tx.target == INCINERATOR {
        // Detected valid burn - process activation
        process_burn_for_activation(&burn_tx).await;
    }
}
```

#### **2️⃣ Consensus-Based Code Generation:**
```rust
// Quantum-secure deterministic generation via consensus
let consensus_leader = consensus.select_leader_for_burn(&burn_tx_hash);
if consensus_leader == self.node_id {
    let activation_code = quantum_crypto.generate_activation_code(
        &burn_tx_hash, 
        &wallet_address, 
        node_type
    );
    // Store only hash in blockchain for security
    let code_hash = blake3::hash(activation_code.as_bytes());
    blockchain.store_activation_hash(code_hash, &burn_tx).await;
}
```

#### **3️⃣ Secure Hash Storage:**
```rust
// Only activation code HASH stored on blockchain (not full code)
let activation_record = ActivationRecord {
    code_hash: blake3::hash(activation_code.as_bytes()),
    wallet_address: burn_tx.wallet,
    node_type: burn_tx.node_type,
    is_active: true,
};
blockchain.submit_activation_record(activation_record).await;
```

### 🔐 **Cryptographic Security:**

#### **✅ Tamper-Proof Code Generation:**
- **CRYSTALS-Dilithium signatures** - quantum-resistant  
- **BLAKE3 + SHA3-512 hashing** - deterministic from burn data
- **Consensus verification** - multiple nodes must agree
- **Blockchain immutability** - codes recorded on-chain

#### **✅ Impossible to Forge:**
```rust  
// Code generation requires:
// 1. Valid Solana burn transaction (on-chain proof)
// 2. Consensus agreement from QNet validators  
// 3. Quantum-secure cryptographic binding
// 4. Blockchain recording with distributed validation

// Even if attacker runs "fake bridge":
// - Can't forge Solana burn transactions ❌
// - Can't bypass quantum crypto validation ❌  
// - Can't fake consensus signatures ❌
// - Can't write to QNet blockchain without validation ❌
```

### 🌐 **How Users Get Codes:**

#### **Method 1: Wallet Extension (Recommended)**
```javascript
// QNet wallet extension generates codes locally after burn
const burnTx = await solanaBurn.burn1DEV(amount, nodeType);
const activationCode = await qnetWallet.generateActivationCode(burnTx);
// Code stored locally in wallet, hash stored on blockchain
```

#### **Method 2: Mobile App Generation**
```javascript
// Mobile app generates codes after Solana burn transaction
const activationCode = await qnetMobile.generateFromBurn(burnTxHash);
// User keeps full code, only hash goes to blockchain
```

#### **Method 3: Node API (Secure)**  
```bash
# Query local node for your activation code (authenticated)
curl http://localhost:8001/api/v1/node/secure-info \
  -H "Authorization: Bearer <wallet_signature>"
```

### 🎯 **Why This Is Superior:**

- ✅ **True Decentralization**: No centralized code generation servers
- ✅ **Quantum Security**: Post-quantum cryptography throughout  
- ✅ **Hash-Only Storage**: Codes cannot be recovered from blockchain
- ✅ **Blockchain Native**: Only hashes stored on immutable ledger
- ✅ **Privacy Enhanced**: Full codes never leave user's device
- ✅ **Forgery Impossible**: Cryptographic proofs at every layer
- ✅ **User Experience**: Secure, private, reliable

### Backup & Recovery

```bash
# Backup node data
sudo tar -czf qnet-backup-$(date +%Y%m%d).tar.gz ~/QNet-Blockchain/node_data

# Backup configuration
sudo cp -r ~/QNet-Blockchain/node_data/config /backup/qnet-config-backup/

# Recovery
sudo tar -xzf qnet-backup-YYYYMMDD.tar.gz -C ~/QNet-Blockchain/
sudo chown -R qnet:qnet ~/QNet-Blockchain/node_data
```

## 🛠️ Development

### Building from Source

```bash
# Development build
cargo build

# Release build with optimizations
cargo build --release

# Run tests
cargo test

# Run benchmarks
cargo bench
```

### Running Tests

```bash
# Unit tests
cargo test --lib

# Integration tests
cargo test --test integration

# Performance tests
cargo test --test performance --release
```

## 📚 API Documentation

### Multi-Node REST API Architecture

**🌐 Every Full/Super node provides complete API functionality:**

```bash
# Node 1 API endpoints
curl http://localhost:8001/api/v1/node/info
curl http://localhost:8001/api/v1/blocks/{height}
curl http://localhost:8001/api/v1/transactions/{hash}

# Node 2 API endpoints  
curl http://localhost:8002/api/v1/node/info
curl http://localhost:8002/api/v1/blocks/{height}
curl http://localhost:8002/api/v1/transactions/{hash}

# Node 3 API endpoints
curl http://localhost:8003/api/v1/node/info
curl http://localhost:8003/api/v1/blocks/{height}
curl http://localhost:8003/api/v1/transactions/{hash}
```

### Available API Endpoints (Per Node)

**Account Management:**
- `GET /api/v1/account/{address}` - Get account information
- `GET /api/v1/account/{address}/balance` - Get account balance
- `GET /api/v1/account/{address}/transactions` - Get transaction history

**Blockchain Data:**
- `GET /api/v1/block/latest` - Get latest block
- `GET /api/v1/block/{height}` - Get block by height
- `GET /api/v1/block/hash/{hash}` - Get block by hash
- `GET /api/v1/microblock/{height}` - Get microblock by height
- `GET /api/v1/macroblock/{index}` - Get macroblock by index (finalized every 90 blocks)

**Transactions:**
- `POST /api/v1/transaction` - Submit transaction
- `GET /api/v1/transaction/{hash}` - Get transaction details with Fast Finality Indicators
  - Returns: `finality_indicators` with level, safety_percentage, confirmations, time_to_finality, risk_assessment

**Network Status:**
- `GET /api/v1/mempool/status` - Get mempool status
- `GET /api/v1/nodes/discovery` - Discover available nodes
- `GET /api/v1/node/health` - Check node health
- `GET /api/v1/gas/recommendations` - Get gas price recommendations

### Client Implementation with Multiple Nodes

```javascript
// Production-ready client with multiple node support
const qnetNodes = [
    'http://node1.example.com:8001',  // Full node
    'http://node2.example.com:8002',  // Super node  
    'http://node3.example.com:8003'   // Full node
];

async function qnetApiCall(endpoint, data = null) {
    for (const nodeUrl of qnetNodes) {
        try {
            const response = await fetch(`${nodeUrl}/api/v1/${endpoint}`, {
                method: data ? 'POST' : 'GET',
                headers: data ? {'Content-Type': 'application/json'} : {},
                body: data ? JSON.stringify(data) : null
            });
            if (response.ok) return await response.json();
        } catch (error) {
            console.log(`Node ${nodeUrl} unavailable, trying next...`);
        }
    }
    throw new Error('All QNet nodes unavailable');
}
```

**🔑 Architecture Benefits:**
- ✅ **Distributed Access**: Multiple nodes provide API access
- ✅ **Load Distribution**: API traffic spread across multiple nodes
- ✅ **High Availability**: Multiple nodes ensure service continuity
- ✅ **Scalability**: More nodes = more API capacity
- ✅ **Redundancy**: Built-in failover capabilities

**📝 Node Requirements:**
- Full/Super nodes provide REST API endpoints
- Light nodes focus on mobile functionality
- Each node offers identical API interface

### WebSocket API (Per Node)

Each Full/Super node also provides WebSocket endpoints for real-time updates:

```javascript
// Connect to specific node WebSocket
const ws = new WebSocket('ws://localhost:9877/ws');

// Subscribe to new blocks
ws.send(JSON.stringify({
    method: 'subscribe',
    params: ['newBlocks']
}));

// Subscribe to new transactions
ws.send(JSON.stringify({
    method: 'subscribe', 
    params: ['newTransactions']
}));
```

**WebSocket Endpoints:**
- `ws://localhost:9877/ws` - Node 1 WebSocket
- `ws://localhost:9879/ws` - Node 2 WebSocket  
- `ws://localhost:9881/ws` - Node 3 WebSocket 

## 🔧 Auto-Configuration Features

QNet node deployment now features **zero-configuration** setup for maximum ease of use:

### 🌍 Automatic Region Detection

- **IP-based geolocation**: Automatically detects your geographic region
- **Optimal bootstrap peers**: Selects the best peers for your region
- **Reduced latency**: Connects to nearest network nodes
- **Supported regions**: North America, Europe, Asia, South America, Africa, Oceania

### 🔌 Smart Port Management

- **Auto-port selection**: Finds available ports if defaults are busy
- **Default ports**: P2P=9876, RPC=9877, Metrics=9878
- **Port range scanning**: Automatically scans for available ports in +100 range
- **Conflict resolution**: Handles port conflicts gracefully

### ⚡ Performance Optimization (Hardware Auto-Tuning)

**🎯 NEW: Automatic Hardware Detection & Optimization**
- **CPU Auto-Detection**: Uses all available cores (4-64+ cores automatically detected)
- **Smart Parallel Validation**: Auto-enables on 8+ core systems, disables on <8 cores
- **Adaptive Mempool**: Scales 100k→2M transactions based on network size
- **Zero Configuration**: Works optimally on any hardware without manual tuning

**Always Enabled:**
- **High-performance mode**: 100k+ TPS optimizations active by default
- **Microblock production**: Enabled for all production nodes
- **Optimized batching**: 10,000 transactions per batch
- **Dynamic thread allocation**: Matches your CPU cores

**Examples (automatic):**
- 4-core VPS: 4 threads, parallel validation OFF
- 8-core server: 8 threads, parallel validation AUTO-ON
- 32-core server: 32 threads, parallel validation ON
- 64-core beast: 64 threads, maximum throughput

**Optional CPU Limiting (for shared servers):**
```bash
# Use only 50% of CPU (great for shared hosting)
docker run ... -e QNET_CPU_LIMIT_PERCENT=50 ...

# Cap at 8 threads (leave resources for other apps)
docker run ... -e QNET_MAX_THREADS=8 ...

# Examples:
# 32-core + 50% limit → 16 threads used
# 64-core + QNET_MAX_THREADS=16 → 16 threads max
# 16-core + no limit → all 16 threads (default)
```

### 🔐 Quantum-Resistant P2P Network (UPDATED - December 2025)

#### Advanced Scalability Features:
- **Lock-Free Operations**: DashMap for concurrent access without blocking (10M+ nodes)
- **Auto-Scaling Mode**: Automatic switching between HashMap (5 nodes) → DashMap (100+ nodes)
- **O(1) Performance**: Dual indexing by address and node ID for instant lookups
- **256 Shards**: Distributed load across shards with cross-shard routing
- **K-bucket Management**: Max 20 peers per bucket with reputation-based replacement

#### Core Features:
- **Post-quantum cryptography**: CRYSTALS-Dilithium peer verification
- **Adaptive peer limits**: 8-500 connections per region based on network size
- **Real-time topology**: 1-second rebalancing intervals
- **Blockchain peer registry**: Immutable peer records in distributed ledger
- **Zero file dependencies**: Pure in-memory quantum-resistant protocols
- **Bootstrap trust mechanism**: Genesis nodes bypass verification for instant connectivity
- **Byzantine safety**: Strict 4-node minimum for decentralized consensus
- **Emergency bootstrap**: Cold-start fallback with cryptographic validation

#### Auto-Scaling Thresholds:
| Node Type | Lock-Free Activation | Sharding Activation | Max Capacity |
|-----------|---------------------|---------------------|--------------|
| Light | 500+ peers | 10,000+ peers | 1M+ peers |
| Full | 100+ peers | 5,000+ peers | 10M+ peers |
| Super | 50+ peers | 5,000+ peers | 10M+ peers |

### 📁 Distributed Data Management

**QNet implements efficient archival system for long-term blockchain scalability.**

#### 🎯 **Node Storage Requirements:**

| Node Type | Storage Size | Data Retention | Sync Time |
|-----------|-------------|----------------|-----------|
| **Light** | ~50-100 MB | Headers + minimal state | <1 minute |
| **Full** | 50-100 GB | Sliding window (~18-74 days) | ~5 minutes |
| **Super** | 500 GB - 1 TB | Complete history forever | ~15 minutes |

- **Smart Defaults**: Automatically detects node type via `QNET_NODE_TYPE` environment variable
- **Adaptive Sliding Window**: Full nodes auto-scale storage window with network growth (100K × active_shards)
- **Growth Pattern**: **~36 GB/year** for Super nodes (full history with advanced compression)
- **Automatic Pruning**: Full nodes prune old blocks every 10,000 blocks (~2.7 hours)
- **Emergency Handling**: Automatic cleanup when storage reaches 70-85-95% thresholds
- **Advanced Compression**: 5-level adaptive temporal compression (Zstd 0-22) based on block age (80% savings)
- **Delta Encoding**: ~95% space savings for sequential blocks (every 1000th block = checkpoint)
- **State Snapshots**: Efficient state recovery without storing all microblocks
- **Long-term projection**: 
  - **1 year**: 37 GB
  - **10 years**: 360 GB
  - **50 years**: 1.8 TB ✅

#### 📦 **Adaptive Archival Responsibilities by Network Size:**

| Network Size | Full Node Quota | Super Node Quota | Min Replicas |
|--------------|-----------------|------------------|--------------|
| **5-15 nodes** (Emergency) | 8 chunks | 15 chunks | 1 replica |
| **16-30 nodes** (Small) | 6 chunks | 12 chunks | 2 replicas |
| **31-50 nodes** (Medium) | 4 chunks | 10 chunks | 3 replicas |
| **50+ nodes** (Large) | 3 chunks | 8 chunks | 3 replicas |

- **Light Nodes**: Always 0 chunks (mobile-optimized)
- **Genesis Nodes**: Variable based on network critical needs
- **Automatic Scaling**: System adapts quotas based on active node count

#### ⚙️ **Aggressive Pruning (Optional):**

**Environment Variable:** `QNET_AGGRESSIVE_PRUNING=1` (default: `0`)

⚠️ **Use with EXTREME caution!** This mode deletes microblocks immediately after macroblock finalization.

**Safety Features:**
- ✅ **Auto-disable**: Automatically disabled if network has < 10 Super nodes
- ✅ **Genesis protection**: Cannot enable during Genesis phase (5 nodes)
- ✅ **Super node immunity**: Super nodes cannot enable (archival role)
- ✅ **Startup warning**: Clear warnings about risks and network status

**When to Consider:**
```bash
# Only enable if ALL conditions are met:
✅ Disk space critically low (< 50 GB available)
✅ Network has 50+ Super nodes maintaining full archive
✅ Full node type (not Light or Super)
✅ You understand dependency on Super nodes for historical data

# Check network status first:
curl http://localhost:8001/api/v1/storage/stats
# Verify "super_nodes_in_network" >= 50
```

**Recommendation:** Leave `QNET_AGGRESSIVE_PRUNING=0` (default) unless absolutely necessary. Sliding window pruning is sufficient for most deployments.

#### 🔄 **Data Lifecycle Management:**
- **Hot Storage**: Recent data on local SSD for immediate access
- **Warm Storage**: Compressed local cache for verification
- **Cold Archive**: Distributed across network nodes with replication
- **Automatic Cleanup**: Multi-tier cleanup system prevents storage overflow

#### 🚨 **Storage Overflow Protection:**

**IMPORTANT**: Blockchain history is NEVER deleted - only cache optimization occurs

| Usage Level | Action | What Gets Cleaned |
|-------------|--------|-------------------|
| **70-85%** | Standard Cleanup | Transaction pool cache (duplicates older than 24h) + RocksDB compression |
| **85-95%** | Aggressive Cleanup | Transaction pool cache (duplicates older than 6h) + maximum compression |
| **95%+** | Emergency Cleanup | Transaction pool cache (duplicates older than 1h) + emergency compression |

#### 🔒 **What is NEVER Deleted:**
- **Complete blockchain history**: All blocks preserved forever
- **All transactions**: Full transaction records maintained in blockchain storage
- **All microblocks**: Complete microblock chain maintained
- **Account states**: All account history preserved
- **Consensus data**: All validation records kept

#### 🔄 **What Gets Optimized:**
- **Transaction pool cache**: Temporary duplicates for fast access (TTL cleanup)
- **RocksDB compression**: Automatic compression of older data (reversible)
- **Storage layout**: Database compaction for optimal disk usage
- **Memory usage**: In-RAM caches cleared to free memory

#### ⚙️ **Production Configuration:**
- **Testnet Start**: 300 GB per node (QNET_MAX_STORAGE_GB=300)
- **Mainnet Growth**: 400-500 GB per node for large networks  
- **Genesis Nodes**: 1 TB recommended for critical infrastructure

#### 📈 **Long-Term Storage Planning:**

**Storage Growth Projection:**
```
Year 1-2:   ~25-50 GB   ✅ 300 GB sufficient
Year 3-5:   ~120-150 GB ✅ 300 GB sufficient  
Year 6-8:   ~200-250 GB ⚠️  Consider 400-500 GB
Year 10+:   ~300+ GB    🔧 Increase to 500-1000 GB
```

**What happens when storage limit is reached:**

1. **95% Full (285+ GB)**: 
   - Emergency cleanup automatically triggered
   - Transaction cache cleared (duplicates only)
   - Database compression applied
   - **Blockchain history preserved**

2. **100% Full (300 GB)**:
   - System attempts emergency cleanup first
   - If still full, **new blocks cannot be saved**
   - Node logs critical warnings
   - Admin must increase `QNET_MAX_STORAGE_GB` or add disk space

3. **Automatic Protection**:
   - System will never delete blockchain history
   - Only cache and duplicate data is cleaned
   - Full transaction records always preserved
   - All consensus data maintained

**Recommended Actions by Network Age:**
- **Year 1**: 300 GB default ✅
- **Year 3+**: Set `QNET_MAX_STORAGE_GB=500`
- **Year 5+**: Set `QNET_MAX_STORAGE_GB=750`  
- **Year 10+**: Set `QNET_MAX_STORAGE_GB=1000`
- **Emergency Handling**: Automatic cleanup maintains operation at 95%+ usage
- **Admin Alerts**: Hourly monitoring with critical storage notifications

#### 🛡️ **Fault Tolerance & Security:**
- Minimum 3 replicas per archive chunk across different nodes
- Automatic rebalancing when nodes disconnect or migrate
- Background compliance monitoring every 4 hours
- Mandatory archival participation for Full/Super nodes

#### 🚫 **Advanced Reputation & Penalty System:**

**Reputation System Details:**
| Behavior | Change | Description |
|----------|--------|-------------|
| **Double-Sign Detection** | -50.0 points | Major Byzantine fault - immediate ban if < 10% |
| **Failed Block Production** | -20.0 points | Microblock production failure |
| **Failed Consensus Lead** | -30.0 points | Macroblock consensus failure |
| **Successful Operation** | +1.0 points | Regular successful interaction |
| **Emergency Recovery** | +5.0 to +50.0 | Bonus for saving the network |
| **Ban Threshold** | < 10% | Node removed from network (7-day recovery for regular nodes) |
| **Consensus Threshold** | ≥ 70% | Minimum to participate in consensus |

**Reputation Consequences:**
- **<70% Reputation**: Excluded from consensus participation
- **<10% Reputation**: Automatically banned from network
- **Hourly Decay**: -1% automatic reputation decay for inactive nodes

**Universal Node Security (Full Decentralization):**
- **Starting Reputation**: 70% for ALL nodes (consensus threshold)
- **No Special Protection**: Genesis nodes = Regular nodes
- **Full Penalties Apply**: Any node can be reduced to 0% and banned
- **Merit-Based System**: ALL nodes must maintain good behavior
- **Consensus Participation**: ≥70% required for everyone
- **True Equality**: No privileged nodes in the network

#### 🔧 **Node Migration Support:**
- **Data Transfer**: Archive responsibilities transfer with node migration
- **Network Continuity**: Distributed system continues during node changes
- **Integrity Verification**: Cryptographic verification of all data transfers
- **Compliance Inheritance**: New device inherits previous archival obligations

### 🛡️ Security Features

- **Post-quantum crypto**: Always enabled (CRYSTALS-Dilithium, AES-256-GCM)
- **AES-256-GCM Database Encryption**: Activation codes encrypted, key never stored
- **Database Theft Protection**: Cannot decrypt without activation code
- **Critical Attack Protection**: Instant 1-year ban for database/chain attacks
- **Privacy-Preserving Pseudonyms**: Network topology protection in all logs
- **Secure by default**: No insecure fallback modes
- **Activation validation**: Cryptographic proof of node purchase
- **Device Migration Security**: Automatic old device deactivation, rate limiting
- **Network isolation**: Proper firewall configuration
- **Privacy Protection**: All IP addresses hashed (SHA3-256), never exposed
- **No System Metrics**: Removed CPU/memory monitoring for privacy
- **Deterministic Consensus**: Cryptographic selection prevents forks
- **Enhanced Concurrency**: RwLock for better parallel performance

## 📈 Latest Updates (v2.6.0)

**November 15, 2025 - "VRF-Based Selection & Macroblock Consensus Listener"**

This release introduces critical improvements for quantum-resistant consensus:
- **Threshold VRF Producer Selection** with Dilithium + Ed25519 hybrid cryptography
- **Race-Free Rotation**: No delays at block boundaries (31, 61, 91)
- **Active Macroblock Consensus**: All Full/Super nodes run 1-second polling listener
- **Deterministic Validator Selection**: 1000 validators per macroblock round
- **Improved Failover**: Consensus state cleanup prevents stuck states
- **Reputation Rewards** incentivize active network participation
- **State Snapshots** enable rapid node synchronization
- **Parallel Downloads** accelerate blockchain sync by 3-5x
- **Deadlock Prevention** ensures network stability

See [CHANGELOG.md](documentation/CHANGELOG.md) for detailed release notes.

## 📄 License

**Blockchain Infrastructure** (BSL 1.1 - Perpetual Proprietary):
- Core blockchain components, node software, consensus, and infrastructure
- **Non-production use**: FREE (testing, development, evaluation)
- **Production use**: Requires commercial license from AIQnetLab
- **Proprietary**: Remains under BSL 1.1 indefinitely (no open-source conversion)
- **Protected**: Cannot be used for competing networks or hosted services
- See [LICENSE](LICENSE) for complete terms

**Client Applications** (Apache 2.0):
- Mobile wallet, browser extension, explorer, CLI tools
- **Fully open-source** with no restrictions
- See individual application LICENSE files for details

## 🔗 Links

Website: https://aiqnet.io
Telegram: https://t.me/AiQnetLab
Twitter: https://x.com/AIQnetLab

## ⚠️ Disclaimer

QNet is experimental software. Use at your own risk. Always test thoroughly before using in production environments.

---

**QNet Blockchain Project** 
