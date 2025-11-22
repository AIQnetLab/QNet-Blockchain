# QNet v2.19 - Quick Reference Guide

## 📚 Key Concepts

### Block Structure
- **Microblocks**: Every 1 second (transactions)
- **Macroblocks**: Every 90 seconds (consensus finalization)
- **Producer Rotation**: Every 30 blocks
- **Finality Window**: 10 blocks (~10 seconds)

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

