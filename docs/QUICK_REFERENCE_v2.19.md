# QNet v2.19 - Quick Reference Guide

## 📚 Key Concepts

### Block Structure
- **Microblocks**: Every 1 second (transactions)
- **Macroblocks**: Every 90 seconds (consensus finalization)
- **Producer Rotation**: Every 30 blocks
- **Finality Window**: 10 blocks (~10 seconds)
- **Entropy Consensus**: At rotation boundaries (adaptive 200ms-2s)

### Signature Types
| Type | Size | Use Case | Certificate |
|------|------|----------|-------------|
| **Compact** | 3KB | Microblocks (high frequency) | Cached separately |
| **Full** | 12KB | Macroblocks (low frequency) | Embedded |

### Node Types
| Type | Consensus | Storage | Bandwidth | Target |
|------|-----------|---------|-----------|--------|
| **Light** | ❌ No | Minimal | Low | Mobile, IoT |
| **Full** | ⚠️ Partial | Full chain | Medium | Validators |
| **Super** | ✅ Always | Full + history | High | Producers |

## 🔄 Progressive Finalization Protocol (PFP)

### When It Activates
```
Block 90: Macroblock expected
Block 95: Check → Missing? Remember
Block 120: PFP Level 1 (30 blocks late)
Block 150: PFP Level 2 (60 blocks late)
Block 180: PFP Level 3 (90 blocks late)
Block 270+: PFP Level 4 (critical)
```

### Degradation Levels
| Level | Delay | Required Nodes | Timeout | Safety |
|-------|-------|----------------|---------|--------|
| 1 | 30-90 blocks | 80% (800 max) | 30s | ✅✅✅ High |
| 2 | 91-180 blocks | 60% (600 max) | 10s | ✅✅ Good |
| 3 | 181-270 blocks | 40% (400 max) | 5s | ⚠️ Emergency |
| 4 | 270+ blocks | 1% (10 max) | 2s | 🔴 Critical |

**Key**: Microblocks NEVER stop during recovery

## 🔐 Security

### Cryptography Stack
- **Post-Quantum**: CRYSTALS-Dilithium (NIST PQC)
- **Classical**: Ed25519
- **Hashing**: SHA3-256
- **Consensus**: Byzantine (2/3+ honest nodes)

### Verification Flow
```
Microblock arrives
    ↓
P2P Layer (node.rs)
    ├─► Structure check
    ├─► Certificate lookup
    ├─► Dilithium verify ✅
    └─► Ed25519 format ✅
    ↓
Consensus Layer (consensus_crypto.rs)
    ├─► Re-validate structure
    ├─► Byzantine consensus (2/3+)
    └─► Accept or reject
```

## 🔄 Entropy Consensus (v2.19.4)

### Adaptive Scaling
- **Sample Size**: 5 (Genesis) → 100 (1M nodes) - scales with network
- **Timeout**: 1-2s adaptive (based on network size + latency)
- **Byzantine Threshold**: 60% of sampled peers must agree
- **Trigger**: Every 30 blocks (rotation boundaries)
- **Performance**: 2-20× faster than fixed 4s timeout

### Network Efficiency
| Network Size | Sample | Bandwidth | Latency |
|--------------|--------|-----------|---------|
| 5 (Genesis) | 5 (100%) | 1 KB | 200-2000ms |
| 100 | 20 (20%) | 2 KB | 200-1000ms |
| 1000 | 50 (5%) | 4 KB | 200-1000ms |
| 1M | 100 (0.01%) | 6 KB | 200-1000ms |

## 📡 Certificate Management

### Broadcasting
- **Tracked Broadcast**: Byzantine 2/3+ threshold (critical rotations)
- **Adaptive Timeout**: 3s (≤10 peers), 5s (≤100 peers), 10s (1000 validators)
- **Periodic Intervals**: 10s (new) / 60s (medium) / 300s (old certs)
- **On Rotation**: Immediate tracked broadcast (80% lifetime)
- **Anti-Duplication**: Serial number change detection
- **Method**: HTTP POST to `/api/v1/p2p/message`

### Caching
- **Capacity**: 100,000 certificates
- **Eviction**: LRU (Least Recently Used)
- **Lifetime**: 1 hour
- **Rotation**: 80% lifetime (~48 minutes)

## 🔄 Block Buffering

### Memory Protection
- **Max Pending**: 100 blocks (~10 MB)
- **Timeout**: 30 seconds per block
- **Retry Limit**: 5 attempts
- **Eviction**: FIFO (oldest first)
- **Protection**: Current block never removed

### Purpose
Handles out-of-order block arrival in gossip P2P network while preventing memory exhaustion attacks.

## 🎯 Reputation System

### Split Reputation Model

| Score | Purpose | Threshold | Events |
|-------|---------|-----------|--------|
| **consensus_score** | Byzantine safety | ≥ 70% for consensus | Invalid blocks (-20), Valid blocks (+5) |
| **network_score** | Peer prioritization | No threshold | Timeouts (-2), Fast response (+3) |

**Key**: Network timeouts DON'T affect Byzantine eligibility!

### Peer Blacklist

| Type | Reason | Duration | Recovery |
|------|--------|----------|----------|
| **Soft** | Network issues | 15-60s (escalates) | Auto-expires |
| **Hard** | Byzantine attacks | Permanent | When consensus_score ≥ 70% |

### Reputation Events

```
CONSENSUS (consensus_score):
  ValidBlock:             +5.0
  InvalidBlock:          -20.0
  ConsensusParticipation: +2.0
  MaliciousBehavior:     -50.0

NETWORK (network_score):
  SuccessfulResponse:     +1.0
  TimeoutFailure:         -2.0
  ConnectionFailure:      -5.0
  FastResponse:           +3.0
```

### Gossip Protocol

- **Transport**: HTTP POST (NOT TCP)
- **Interval**: Every 5 minutes
- **Scope**: Super + Full nodes only
- **Signature**: SHA3-256 quantum-safe
- **URL**: `/api/v1/p2p/message`

### Byzantine Threshold

```rust
// Universal 70% threshold (ALL node types)
is_consensus_qualified() {
    if node_type == Light { return false; }  // Light NEVER in consensus
    return consensus_score >= 70.0;          // Byzantine threshold
}
```

## 🛡️ MEV Protection & Priority Mempool

### Private Bundle Submission (v2.19.3)

| Component | Value | Description |
|-----------|-------|-------------|
| **Max TXs per Bundle** | 10 | Prevents block space monopolization |
| **Reputation Gate** | 80%+ | Proven trustworthy nodes only |
| **Gas Premium** | +20% | Economic incentive for inclusion |
| **Max Lifetime** | 60s | 60 microblocks maximum |
| **Rate Limiting** | 10/min | Per-user anti-spam protection |
| **Block Allocation** | 0-20% | Dynamic, 80-100% for public TXs |
| **Signature** | Dilithium3 | Post-quantum verification |

### Priority Mempool (Public TXs)

```
BTreeMap<gas_price, Vec<TX>>  (highest gas_price first!)
├── 500,000 nano QNC  → TX_1, TX_2  (processed first)
├── 200,000 nano QNC  → TX_3, TX_4
└── 100,000 nano QNC  → TX_5, TX_6  (processed last)
```

**Min Gas Price**: 100,000 nano QNC (0.0001 QNC base fee)

### API Endpoints

```bash
# Submit MEV bundle
POST /api/v1/bundle/submit

# Check bundle status
GET /api/v1/bundle/{id}/status

# Cancel bundle
DELETE /api/v1/bundle/{id}

# Mempool status (includes MEV info)
GET /api/v1/mempool/status
```

### Block Composition

```
Dynamic Allocation (per microblock):
┌────────────────────────────────────┐
│ MEV Bundles:   0-20% (if demand)  │ ← Dynamic
│ Public TXs:    80-100% (guaranteed)│ ← Guaranteed
└────────────────────────────────────┘
Total: 100% block utilization
```

**Key**: Public transaction throughput is ALWAYS protected (80% minimum)!

## 📊 Performance

### Throughput
```
Base:           1,000 TPS (1 microblock/sec × 1000 tx)
With Sharding:  10,000 TPS (10 shards)
Max Theoretical: 100,000+ TPS (100 shards)
```

### Latency
```
Transaction → Microblock: ~1 second
Quick Confirmation:       5 seconds (5 blocks)
Near Final:               10 seconds (Finality Window)
Full Finalization:        90 seconds (Macroblock)
```

### Bandwidth
```
Per Microblock:  ~53 KB (header + signature + transactions)
Per Macroblock:  ~3 MB (validator signatures)
Node Bandwidth:  ~700 Kbps average
```

## 🛠️ Architecture Files

### Core (Structural Validation)
- `core/qnet-consensus/src/consensus_crypto.rs` - Signature format validation

### Development (Full Verification)
- `development/qnet-integration/src/node.rs` - Main node logic, PFP
- `development/qnet-integration/src/hybrid_crypto.rs` - Signature generation
- `development/qnet-integration/src/unified_p2p.rs` - Certificate broadcast
- `development/qnet-integration/src/quantum_crypto.rs` - Dilithium crypto

## 🚀 Quick Commands

### Build
```bash
cargo build --release --no-default-features
```

### Run Super Node
```bash
QNET_BOOTSTRAP_ID=001 QNET_NODE_TYPE=super cargo run --release
```

### Check Compilation
```bash
cargo check --no-default-features
```

## 📝 Key Constants

```rust
// Production constants
const ROTATION_INTERVAL_BLOCKS: u64 = 30;      // Producer rotation
const MACROBLOCK_INTERVAL: u64 = 90;           // Macroblock creation
const FINALITY_WINDOW: u64 = 10;               // Blocks for finality
const MAX_VALIDATORS_PER_ROUND: usize = 1000;  // Consensus limit
const CERTIFICATE_LIFETIME_SECS: u64 = 3600;   // 1 hour
const MAX_CACHE_SIZE: usize = 100000;          // Certificate cache
const MAX_PENDING_BLOCKS: usize = 100;         // Block buffer limit
```

## 🔗 Documentation

- **Full Architecture**: `docs/ARCHITECTURE_v2.19.md`
- **README**: `README.md`
- **API Docs**: https://docs.qnet.io (when published)

## ⚠️ Important Notes

1. **Zero Downtime**: Microblocks continue during macroblock consensus
2. **Defense in Depth**: Two-layer verification (P2P + Consensus)
3. **Byzantine Safety**: All PFP levels maintain 2/3+ requirement (except Level 4 emergency)
4. **Scalability**: Max 1000 validators regardless of total nodes
5. **NIST Compliant**: Post-quantum cryptography (CRYSTALS-Dilithium)
6. **Memory Protected**: Bounded block buffering (~10 MB max)
7. **Tracked Delivery**: Byzantine 2/3+ threshold for critical certificates

## 📞 Support

- **Email**: support@qnet.io
- **GitHub**: https://github.com/AIQnetLab/QNet-Blockchain
- **Issues**: https://github.com/AIQnetLab/QNet-Blockchain/issues

