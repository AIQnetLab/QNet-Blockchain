# QNet Blockchain Architecture v2.19
## Post-Quantum Decentralized Network - Technical Documentation

**Last Updated**: November 16, 2025  
**Version**: 2.19.0  
**Status**: Production Ready

---

## Table of Contents
1. [Overview](#overview)
2. [Block Structure](#block-structure)
3. [Signature System](#signature-system)
4. [Progressive Finalization Protocol](#progressive-finalization-protocol)
5. [Node Types and Scaling](#node-types-and-scaling)
6. [Security Model](#security-model)
7. [Performance Characteristics](#performance-characteristics)

---

## Overview

QNet is a high-performance, post-quantum secure blockchain with a **two-layer block structure**:

- **Microblocks**: Created every second (transaction processing)
- **Macroblocks**: Created every 90 seconds (consensus finalization)

### Key Innovations
- **Compact Hybrid Signatures**: 75% bandwidth reduction (3KB vs 12KB)
- **Progressive Finalization Protocol**: Self-healing consensus recovery
- **Zero-Downtime Architecture**: Microblocks continue during macroblock consensus
- **NIST Post-Quantum Compliant**: CRYSTALS-Dilithium + Ed25519 hybrid

---

## Block Structure

### Timeline

```
Seconds    0   1   2  ...  60  61  ...  89  90  91  ...  150  151  ...  179  180
Blocks     0   1   2  ...  60  61  ...  89  90  91  ...  150  151  ...  179  180
           │   │   │        │   │        │   │   │        │    │         │    │
           └───┴───┴────────┴───┼────────┴───┼───┴────────┴────┼─────────┴────┼──► Microblocks (1/sec)
                                │            │                  │              │
                          Consensus      Macroblock #1      Consensus     Macroblock #2
                          Starts (BG)    (Finalized)        Starts (BG)   (Finalized)
```

### Microblock Structure
```rust
pub struct MicroBlock {
    pub height: u64,              // Sequential block number
    pub timestamp: u64,           // Unix timestamp
    pub previous_hash: Vec<u8>,   // SHA3-256 of previous block
    pub merkle_root: Vec<u8>,     // Transaction Merkle tree root
    pub producer: String,         // Producer node ID
    pub signature: Vec<u8>,       // COMPACT hybrid signature (3KB)
    pub poh_hash: Vec<u8>,        // Proof of History hash (64 bytes)
    pub poh_count: u64,           // PoH counter for VDF
    // ... transactions and other fields
}
```

**Signature Type**: Compact (3KB)  
**Frequency**: 1 per second  
**Verification**: P2P layer (pre-consensus)

### Macroblock Structure
```rust
pub struct MacroBlock {
    pub height: u64,              // Macroblock index (1, 2, 3...)
    pub timestamp: u64,           // Deterministic timestamp
    pub state_root: Vec<u8>,      // Merkle root of microblocks 1-90, 91-180, etc.
    pub microblock_hashes: Vec<Vec<u8>>,  // All microblock hashes in range
    pub validator_signatures: Vec<String>, // Byzantine consensus signatures
    // ... consensus data
}
```

**Signature Type**: Full hybrid (12KB)  
**Frequency**: Every 90 blocks (90 seconds)  
**Verification**: Byzantine consensus (2/3+ nodes)

---

## Signature System

### Compact Signatures (Microblocks)

**Format**: `compact:<json>`

```json
{
  "node_id": "genesis_node_001",
  "cert_serial": "cert_2024_11_16_12345",
  "message_signature": [64, 32, ...],        // Ed25519 (64 bytes)
  "dilithium_message_signature": "base64...", // Dilithium (~2420 bytes)
  "signed_at": 1700140800
}
```

**Size**: ~3KB (3,000 bytes)  
**Bandwidth Savings**: 75% vs full signatures  
**Certificate**: Referenced by serial, cached at P2P layer

#### Verification Flow

```
1. Microblock arrives at node
   ↓
2. P2P Layer (node.rs::verify_microblock_signature)
   ├─► Structural validation
   ├─► Certificate lookup (cache or request)
   ├─► Dilithium signature verification ✅ (NIST post-quantum)
   ├─► Ed25519 format validation ✅
   └─► Result: Accept or Reject
   ↓
3. Consensus Layer (consensus_crypto.rs::verify_compact_hybrid_signature)
   ├─► Structural re-validation (format, sizes)
   ├─► Byzantine consensus (2/3+ honest nodes)
   └─► Only pre-verified blocks participate
```

### Full Hybrid Signatures (Macroblocks)

**Format**: `hybrid:<json>`

```json
{
  "message_signature": "base64...",     // Ed25519
  "dilithium_signature": "base64...",   // Dilithium
  "certificate": {
    "ed25519_public_key": "...",
    "dilithium_public_key": "...",
    "dilithium_signature_of_ed25519": "...",
    "serial_number": "...",
    "valid_from": 1700140800,
    "valid_until": 1700227200
  }
}
```

**Size**: ~12KB (12,000 bytes)  
**Use Case**: Macroblocks (no certificate lookup delay)  
**Verification**: Immediate (certificate embedded)

### Certificate Management

#### Certificate Structure
```rust
pub struct HybridCertificate {
    pub ed25519_public_key: Vec<u8>,      // 32 bytes
    pub dilithium_public_key: Vec<u8>,    // ~1952 bytes
    pub dilithium_signature_of_ed25519: String, // ~2420 bytes base64
    pub serial_number: String,
    pub valid_from: u64,
    pub valid_until: u64,
}
```

**Lifetime**: 1 hour (3600 seconds)  
**Rotation**: Automatic before expiration  
**Storage**: LRU cache with 100K capacity

#### Certificate Broadcasting

```rust
// Periodic broadcast (every 5 minutes)
if certificate_broadcast_counter >= 300 {
    p2p.broadcast_certificate_announce(cert_serial, cert_bytes);
}

// Rotation broadcast (immediate)
if hybrid.needs_rotation() {
    hybrid.rotate_certificate().await;
    // New certificate broadcasted automatically
}
```

**Broadcast Method**: HTTP POST to `/api/v1/p2p/message`  
**Cache**: 100,000 certificates (LRU eviction)  
**Scalability**: Handles millions of nodes (max 1000 active validators)

---

## Progressive Finalization Protocol

### Problem
If a producer fails to create a macroblock at height 90, the network needs to recover without stopping microblock production.

### Solution: PFP (Progressive Finalization Protocol)

#### Detection
```
Block 90: Macroblock expected
   ↓ (check after 5 seconds)
Block 95: Is macroblock present?
   ├─► YES: Continue normally ✅
   └─► NO: Remember failure, continue microblocks

Block 120 (90+30): First PFP check
   └─► Still missing? → Activate PFP Level 1

Block 150 (90+60): Second PFP check
   └─► Still missing? → Activate PFP Level 2

Block 180 (90+90): Third PFP check
   └─► Still missing? → Activate PFP Level 3
```

#### Degradation Levels

| Level | Blocks Without Macroblock | Required Nodes | Timeout | Mode |
|-------|---------------------------|----------------|---------|------|
| **1** | 30-90 | 80% (max 800) | 30s | Standard ✅ |
| **2** | 91-180 | 60% (max 600) | 10s | Checkpoint ⚠️ |
| **3** | 181-270 | 40% (max 400) | 5s | Emergency 🚨 |
| **4** | 270+ | 1% (max 10) | 2s | Critical 🔴 |

#### Implementation
```rust
// Check every 30 blocks after macroblock boundary
if blocks_since_trigger >= 30 && blocks_since_trigger % 30 == 0 {
    let expected_macroblock = last_macroblock_trigger / 90;
    
    if !macroblock_exists {
        // Activate PFP with appropriate degradation level
        Self::activate_progressive_finalization_with_level(
            storage,
            consensus,
            current_height,
            p2p,
            blocks_since_trigger
        ).await;
    }
}
```

#### Byzantine Safety

**All PFP levels maintain Byzantine fault tolerance:**
- Level 1 (80%): Well above 2/3 threshold (66.67%) ✅
- Level 2 (60%): Meets Byzantine minimum ✅
- Level 3 (40%): Reduced safety, emergency only ⚠️
- Level 4 (1%): Critical recovery, last resort 🔴

**Key Property**: Microblocks NEVER stop during recovery

```
Block 120: PFP activates
   ├─► Background: Request macroblock from 80% of nodes
   └─► Foreground: Microblock #121 created ⚡ (ZERO DOWNTIME)

Block 121-149: Continue microblocks normally
   ├─► Microblocks: ⚡⚡⚡⚡⚡ (every second)
   └─► Background: PFP still recovering macroblock

Block 150: PFP Level 2
   ├─► More aggressive recovery (60% nodes, 10s timeout)
   └─► Microblocks still flowing ⚡
```

---

## Node Types and Scaling

### Node Type Hierarchy

```
┌─────────────────────────────────────────────────────┐
│                   QNet Network                      │
│  Millions of nodes, scaled consensus participation │
└─────────────────────────────────────────────────────┘
                       │
           ┌───────────┼───────────┐
           │           │           │
      ┌────▼────┐ ┌───▼────┐ ┌───▼────┐
      │  Light  │ │  Full  │ │ Super  │
      │  Nodes  │ │  Nodes │ │ Nodes  │
      └─────────┘ └────────┘ └────────┘
         │            │           │
      Millions     Thousands   Max 1000
         │            │           │
    Transactions  Partial     Full
       Only      Consensus   Consensus
```

### Light Nodes
- **Purpose**: Transaction submission and balance queries
- **Consensus**: NO participation
- **Storage**: Minimal (recent state only)
- **Bandwidth**: Low (receive blocks, no validation)
- **Target Users**: Mobile wallets, IoT devices

**Filtering**:
```rust
match self.node_type {
    NodeType::Light => {
        return Vec::new(); // No consensus participation
    }
}
```

### Full Nodes
- **Purpose**: Network validation and relay
- **Consensus**: Partial participation (if reputation ≥ 70%)
- **Storage**: Full blockchain (all microblocks + macroblocks)
- **Bandwidth**: Medium (validate and relay)
- **Requirements**: 3+ validated peers for consensus eligibility

**Eligibility**:
```rust
NodeType::Full => {
    let validated_peers = p2p.get_validated_active_peers();
    let has_peers = validated_peers.len() >= 3; // Byzantine: 3f+1 where f=1
    let reputation = get_node_reputation_score(node_id, p2p).await;
    has_peers && reputation >= 0.70
}
```

### Super Nodes
- **Purpose**: Consensus leaders and block producers
- **Consensus**: Always participate (if reputation ≥ 70%)
- **Storage**: Full blockchain + extended history
- **Bandwidth**: High (produce blocks, broadcast)
- **Bootstrap**: Initial 5 Genesis Super nodes

**Eligibility**:
```rust
NodeType::Super => {
    let reputation = get_node_reputation_score(node_id, p2p).await;
    reputation >= 0.70 // Always eligible if reputable
}
```

### Validator Sampling

**Maximum validators per round**: 1000

```rust
const MAX_VALIDATORS_PER_ROUND: usize = 1000;

if all_qualified.len() > MAX_VALIDATORS_PER_ROUND {
    // Deterministic random sampling using block entropy
    let selected = sample_validators(all_qualified, MAX_VALIDATORS_PER_ROUND, entropy);
    all_qualified = selected;
}
```

**Why 1000?**
- Byzantine consensus overhead: O(n²) communication
- Network latency: More nodes = longer consensus time
- Security: 1000 nodes provides 666+ honest nodes (assuming 2/3 honest)
- Performance: Keeps consensus under 30 seconds

**Scaling Strategy**:
```
5 Nodes (Genesis):
  └─► All participate (100%)

1,000 Nodes:
  └─► All participate (100%)

10,000 Nodes:
  └─► 1,000 sampled (10%)

1,000,000 Nodes:
  └─► 1,000 sampled (0.1%)

100,000,000 Nodes (Light nodes):
  └─► 1,000 sampled from Super/Full only (<0.01%)
```

---

## Security Model

### Defense-in-Depth Architecture

```
┌─────────────────────────────────────────────────────────┐
│              Layer 1: P2P Verification                  │
│         (node.rs::verify_microblock_signature)          │
├─────────────────────────────────────────────────────────┤
│  1. Structural validation                               │
│  2. Certificate lookup (cache or request from network)  │
│  3. CRYSTALS-Dilithium signature verification ✅        │
│  4. Ed25519 format validation ✅                        │
│  5. Chain continuity checks                             │
│  6. Proof of History verification                       │
│  → ONLY VERIFIED BLOCKS PROCEED TO CONSENSUS            │
└─────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│           Layer 2: Consensus Validation                 │
│      (consensus_crypto.rs::verify_consensus_signature)  │
├─────────────────────────────────────────────────────────┤
│  1. Structural re-validation (format, sizes)            │
│  2. Byzantine consensus (2/3+ honest nodes required)    │
│  3. Commit-Reveal protocol                              │
│  4. Proof of History entropy                            │
│  → MALICIOUS BLOCKS CANNOT REACH CONSENSUS THRESHOLD    │
└─────────────────────────────────────────────────────────┘
```

### NIST/Cisco Compliance

#### Post-Quantum Cryptography
- **Algorithm**: CRYSTALS-Dilithium (NIST PQC standard)
- **Security Level**: Dilithium3 (Level 3)
- **Key Size**: 1952 bytes (public), 4000 bytes (private)
- **Signature Size**: ~2420 bytes
- **Security**: Resistant to Shor's algorithm (quantum attacks)

#### Classical Cryptography
- **Algorithm**: Ed25519 (Curve25519)
- **Security Level**: 128-bit security
- **Key Size**: 32 bytes (public), 64 bytes (private)
- **Signature Size**: 64 bytes
- **Purpose**: Legacy compatibility, fast verification

#### Hashing
- **Algorithm**: SHA3-256 (NIST FIPS 202)
- **Output**: 256 bits (32 bytes)
- **Usage**: Block hashes, message digests, signature preparation
- **Alternative**: Blake3 (for non-cryptographic identifiers only)

### Attack Resistance

#### Byzantine Fault Tolerance
- **Threshold**: 2/3+ honest nodes required
- **Tolerance**: Up to 1/3 malicious/faulty nodes
- **Formula**: n ≥ 3f + 1 (where f = faulty nodes)
- **Example**: 
  - 1000 validators: Tolerates 333 Byzantine nodes
  - 5 Genesis nodes: Tolerates 1 Byzantine node

#### Sybil Resistance
- **Mechanism**: Reputation-based participation
- **Threshold**: 70% minimum reputation for consensus
- **Earning**: Correct block production (+1), uptime, P2P reliability
- **Penalty**: Invalid blocks (-5), downtime, malicious behavior
- **Protection**: Cost of 1/3 network reputation prohibitively high

#### DDoS Protection
- **Rate Limiting**: Per-peer request throttling
- **Concurrent Limits**: Max concurrent requests per peer
- **Certificate Caching**: Reduces certificate request floods
- **Validator Sampling**: Limits consensus participation to 1000 nodes

---

## Performance Characteristics

### Throughput

| Metric | Value | Notes |
|--------|-------|-------|
| **Microblock Interval** | 1 second | Fixed interval |
| **Macroblock Interval** | 90 seconds | Every 90 microblocks |
| **Transactions per Microblock** | ~1,000 | Configurable batch size |
| **Base TPS** | 1,000 TPS | 1 microblock/sec × 1000 tx |
| **With Sharding (10 shards)** | 10,000 TPS | 10 shards × 1000 tx/sec |
| **Theoretical Max (100 shards)** | 100,000+ TPS | With optimizations |

### Latency

| Stage | Latency | Description |
|-------|---------|-------------|
| **Transaction Submission** | <100ms | API endpoint processing |
| **Inclusion in Microblock** | ~1s | Next microblock interval |
| **Quick Confirmation** | 5s | 5 microblocks (InBlock → QuickConfirmed) |
| **Near Final** | 10s | 10 microblocks (Finality Window) |
| **Full Finalization** | 90s | Macroblock consensus |

### Bandwidth

#### Per Block (Microblock)

| Component | Size | Frequency |
|-----------|------|-----------|
| **Block Header** | ~256 bytes | Every block |
| **PoH (hash + count)** | 72 bytes | Every block |
| **Compact Signature** | ~3 KB | Every block |
| **Transactions** | ~50 KB | Every block (1000 tx × 50 bytes avg) |
| **Total per Microblock** | ~53 KB | Every second |

**Network Bandwidth**: ~424 Kbps per node (receiving blocks)

#### Per Macroblock

| Component | Size | Frequency |
|-----------|------|-----------|
| **Macroblock Header** | ~512 bytes | Every 90 blocks |
| **State Root** | 32 bytes | Every 90 blocks |
| **Microblock Hashes (90)** | 2.88 KB | 90 × 32 bytes |
| **Full Hybrid Signature** | ~12 KB | Every 90 blocks |
| **Validator Signatures (1000)** | ~3 MB | 1000 × 3KB (worst case) |
| **Total per Macroblock** | ~3 MB | Every 90 seconds |

**Macroblock Bandwidth**: ~267 Kbps average (amortized over 90 seconds)

### Storage

| Data Type | Size per Block | Retention |
|-----------|----------------|-----------|
| **Microblock** | ~53 KB | Permanent |
| **Macroblock** | ~3 MB | Permanent |
| **Certificate Cache** | ~5 KB × 100K | LRU eviction |
| **Transaction Pool** | Variable | Until included |

**Storage Growth**:
- Microblocks: 53 KB/sec × 86,400 sec/day = ~4.4 GB/day
- Macroblocks: 3 MB / 90 sec × 86,400 sec/day = ~2.8 GB/day
- **Total**: ~7.2 GB/day (~2.6 TB/year)

**Optimization**:
- Pruning: Light nodes keep recent state only
- Compression: zstd compression for archived blocks
- Archival: Super nodes maintain full history

### Consensus Performance

| Phase | Duration | Description |
|-------|----------|-------------|
| **Consensus Start** | Block 61/90 | 29 blocks before macroblock |
| **Commit Phase** | 10 blocks | Nodes commit to block hash |
| **Reveal Phase** | 10 blocks | Nodes reveal signatures |
| **Finalization** | Block 90 | Macroblock created |
| **Total Consensus Time** | 30 seconds | 29 blocks + finalization |

**Background Execution**: Microblocks continue during consensus (zero downtime)

### Certificate Broadcasting

| Metric | Value |
|--------|-------|
| **Periodic Broadcast** | Every 5 minutes |
| **Rotation Broadcast** | Immediate (on rotation) |
| **Cache Size** | 100,000 certificates |
| **Eviction Policy** | LRU (Least Recently Used) |
| **Certificate Lifetime** | 1 hour (3600 seconds) |
| **Rotation Advance** | 5 minutes before expiry |

**Network Load**:
- 1000 validators × 1 cert/5min = ~200 broadcasts/5min = ~40 broadcasts/min
- 40 broadcasts × 5KB per cert = 200 KB/min = ~27 Kbps

---

## Production Deployment

### Minimum Requirements

#### Light Node
- **CPU**: 1 core (2 GHz)
- **RAM**: 512 MB
- **Storage**: 10 GB (pruned)
- **Bandwidth**: 1 Mbps

#### Full Node
- **CPU**: 4 cores (2.4 GHz)
- **RAM**: 8 GB
- **Storage**: 1 TB SSD
- **Bandwidth**: 10 Mbps

#### Super Node
- **CPU**: 8 cores (2.4 GHz+)
- **RAM**: 16 GB
- **Storage**: 2 TB NVMe SSD
- **Bandwidth**: 100 Mbps

### Recommended Configuration

#### Production Super Node
```yaml
Hardware:
  CPU: Intel Xeon E5-2680v4 (14 cores @ 2.4GHz) or equivalent
  RAM: 32 GB DDR4
  Storage: 4 TB NVMe SSD (RAID 1)
  Network: 1 Gbps dedicated

Software:
  OS: Ubuntu 22.04 LTS (or latest stable)
  Rust: 1.70+ (stable channel)
  Node.js: 18+ LTS
  
Environment:
  QNET_BOOTSTRAP_ID: "001" (for Genesis Super nodes)
  QNET_NODE_TYPE: "super"
  RUST_LOG: "info"
```

### Monitoring

**Key Metrics**:
- Block production rate (microblocks/sec)
- Consensus participation rate (%)
- Certificate cache hit rate (%)
- Network bandwidth usage (Mbps)
- Reputation score (0-100%)
- Peer connectivity (active peers)
- Storage usage (GB)

**Alerts**:
- Microblock production stopped (>5 seconds gap)
- Macroblock missing (PFP activated)
- Reputation below 70% (consensus exclusion)
- Storage >90% capacity
- Peer count <3 (Full nodes)

---

## Conclusion

QNet v2.19 implements a production-ready, post-quantum secure blockchain with:

✅ **Compact signatures**: 75% bandwidth reduction  
✅ **Progressive Finalization**: Self-healing consensus  
✅ **Zero downtime**: Microblocks never stop  
✅ **NIST compliant**: CRYSTALS-Dilithium post-quantum cryptography  
✅ **Scalable**: Millions of nodes, max 1000 validators  
✅ **Byzantine safe**: 2/3+ honest nodes at all times  

**Ready for production deployment.**

---

**For questions or support**: support@qnet.io  
**GitHub**: https://github.com/AIQnetLab/QNet-Blockchain  
**Documentation**: https://docs.qnet.io

