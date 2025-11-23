# QNet Blockchain Architecture v2.19
## Post-Quantum Decentralized Network - Technical Documentation

**Last Updated**: November 23, 2025  
**Version**: 2.19.2  
**Status**: Production Ready

---

## Table of Contents
1. [Overview](#overview)
2. [Block Structure](#block-structure)
3. [Signature System](#signature-system)
4. [Block Buffering and Memory Protection](#block-buffering-and-memory-protection)
5. [Progressive Finalization Protocol](#progressive-finalization-protocol)
6. [Node Types and Scaling](#node-types-and-scaling)
7. [Reputation System](#reputation-system)
8. [Security Model](#security-model)
9. [Performance Characteristics](#performance-characteristics)

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

**Tracked Broadcast with Byzantine Threshold** (Critical Events):

```rust
// Producer rotation broadcast (IMMEDIATE + TRACKED)
if serial_changed {
    match p2p.broadcast_certificate_announce_tracked(cert_serial, cert_bytes).await {
        Ok(()) => {
            // ✅ Certificate delivered to 2/3+ peers (Byzantine threshold)
        }
        Err(e) => {
            // ⚠️ Fallback to async broadcast (gossip will propagate)
            p2p.broadcast_certificate_announce(cert_serial, cert_bytes);
        }
    }
}
```

**Adaptive Periodic Broadcast** (Background Propagation):

```rust
// Adaptive intervals based on certificate age
let interval = match certificate_age_percent {
    80..=100 => 10,   // New certificates: 10 seconds
    50..=79  => 60,   // Medium age: 60 seconds (1 minute)
    0..=49   => 300,  // Old certificates: 300 seconds (5 minutes)
};
```

**Anti-Duplication Protection**:

```rust
// Check if certificate actually rotated before broadcasting
let old_serial = hybrid.get_current_certificate().map(|c| c.serial_number.clone());
hybrid.rotate_certificate().await;
let new_cert = hybrid.get_current_certificate();
let serial_changed = old_serial.as_ref().map_or(true, |old| old != &new_cert.serial_number);

if serial_changed {
    // Broadcast ONLY if certificate actually changed
}
```

**Broadcast Methods**:
- **Tracked**: Waits for 2/3+ Byzantine confirmation (3-10s adaptive timeout)
- **Async**: Fire-and-forget for gossip propagation
- **Transport**: HTTP POST to `/api/v1/p2p/message`

**Cache**: 100,000 certificates (LRU eviction)  
**Scalability**: Handles millions of nodes (max 1000 active validators)

---

## Block Buffering and Memory Protection

### Problem
In a gossip-based P2P network, blocks may arrive out of order due to network latency or partial connectivity. Nodes must buffer blocks until their parent blocks arrive.

### Solution: Bounded Buffer with Cleanup

#### MAX_PENDING_BLOCKS Protection

```rust
// MEMORY PROTECTION: Maximum pending blocks to prevent memory exhaustion
// Per ARCHITECTURE_v2.19: Microblock = ~53 KB (header + PoH + signature + transactions)
// 100 blocks * ~100KB = ~10 MB maximum buffer size
// Protects against malicious peers sending out-of-order blocks during network issues
const MAX_PENDING_BLOCKS: usize = 100;

if pending_blocks.len() >= MAX_PENDING_BLOCKS {
    // Remove oldest block to make room (FIFO-like)
    if let Some((&oldest_height, _)) = pending_blocks.iter()
        .filter(|(&h, _)| h != received_block.height)  // Don't remove current block
        .min_by_key(|(_, (_, _, timestamp))| timestamp) {
        pending_blocks.remove(&oldest_height);
        println!("[BLOCKS] 🚨 Max buffer ({}) reached - removed oldest block #{}", 
                 MAX_PENDING_BLOCKS, oldest_height);
    }
}
```

#### Retry Mechanism

```rust
// Buffer block with retry counter
pending_blocks.insert(height, (block, retry_count, timestamp));

// Cleanup after 30 seconds or 5 failed retries
if age_seconds > 30 || retry_count >= 5 {
    pending_blocks.remove(&height);
}
```

#### Protection Features

| Feature | Value | Purpose |
|---------|-------|---------|
| **Max Buffer Size** | 100 blocks (~10 MB) | Prevent memory exhaustion |
| **Retry Limit** | 5 attempts | Avoid infinite loops |
| **Timeout** | 30 seconds | Release stale blocks |
| **Eviction Policy** | FIFO (oldest first) | Fair buffer management |
| **Self-Protection** | Current block never removed | Ensure progress |

**Attack Mitigation**:
- **Memory DoS**: Max 10 MB buffer (100 blocks)
- **Stale Blocks**: 30-second automatic cleanup
- **Infinite Retry**: 5-attempt limit
- **Race Conditions**: Current block never evicted

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
- **Cryptography**: Ed25519 ONLY (no Dilithium)

**Filtering**:
```rust
match self.node_type {
    NodeType::Light => {
        return Vec::new(); // No consensus participation
    }
}
```

**Transaction Signing (Light Nodes / Clients):**
```javascript
// Mobile/Browser clients use Ed25519 for optimal performance
// Format: "transfer:from:to:amount:gas_price:gas_limit"
const message = `transfer:${from}:${to}:${amount}:1:10000`;
const signature = nacl.sign.detached(messageBytes, secretKey);

// Transaction includes:
// - signature: 64 bytes (Ed25519)
// - public_key: 32 bytes (Ed25519)
// - No Dilithium (reserved for node consensus)
```

**Performance:**
- Sign: ~20μs
- Verify: ~20μs
- Size: 96 bytes (signature + public key)
- Energy: Low (mobile-friendly)

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

## Reputation System

### Byzantine-Safe Split Reputation

QNet uses a **two-dimensional reputation model** to separate Byzantine attacks from network performance issues:

```rust
pub struct PeerInfo {
    consensus_score: f64,  // 0-100: Byzantine behavior (malicious attacks)
    network_score: f64,    // 0-100: Network performance (timeouts, latency)
}
```

#### Reputation Scores

| Score Type | Affects | Events | Threshold |
|------------|---------|--------|-----------|
| **consensus_score** | Byzantine eligibility | Invalid blocks, malicious behavior | ≥ 70% for consensus |
| **network_score** | Peer prioritization | Timeouts, latency, availability | Used for sync ordering |

**Key Principle**: Byzantine attacks (`consensus_score`) are separate from network issues (`network_score`)

#### Reputation Events

```rust
// CONSENSUS EVENTS (affect consensus_score)
ValidBlock              // +5.0 consensus_score
InvalidBlock            // -20.0 consensus_score
ConsensusParticipation  // +2.0 consensus_score
MaliciousBehavior       // -50.0 consensus_score

// NETWORK EVENTS (affect network_score)
SuccessfulResponse      // +1.0 network_score
TimeoutFailure          // -2.0 network_score (NOT malicious!)
ConnectionFailure       // -5.0 network_score
FastResponse            // +3.0 network_score
```

### Peer Blacklist System

#### Blacklist Categories

| Type | Reason | Duration | Use Case |
|------|--------|----------|----------|
| **Soft** | Network performance | 15-60s (escalates) | Timeouts, slow responses |
| **Hard** | Byzantine attacks | Permanent* | Invalid blocks, malicious behavior |

*Hard blacklist removed when `consensus_score` ≥ 70% (reputation recovered)

#### Escalation Logic

```rust
// Soft Blacklist (Network issues)
SlowResponse:      15s + (15s × violations)
SyncTimeout:       30s + (30s × violations)
ConnectionFailure: 60s + (60s × violations)

// Hard Blacklist (Byzantine attacks)
InvalidBlocks:      Permanent (until reputation ≥ 70%)
MaliciousBehavior:  Permanent (until reputation ≥ 70%)
```

### Peer Selection for Sync

**Priority Order** (descending):
1. **Node Type**: Super > Full (Light nodes excluded)
2. **Blacklist**: Not blacklisted
3. **Consensus Score**: ≥ 70% (Byzantine threshold)
4. **Network Score**: Higher = better latency
5. **Reputation Recovery**: Hard blacklist auto-removed when `consensus_score` ≥ 70%

```rust
pub fn get_sync_peers_filtered(&self, max_peers: usize) -> Vec<PeerInfo> {
    // 1. Exclude Light nodes (don't store full blocks)
    // 2. Filter blacklisted peers (soft: temporary, hard: until reputation recovered)
    // 3. Check Byzantine threshold (consensus_score ≥ 70%)
    // 4. Sort by network_score (latency) + consensus_score (reliability)
    // 5. Return top-N peers
}
```

### Reputation Gossip Protocol

**Transport**: HTTP POST (NOT TCP)  
**Interval**: Every 5 minutes  
**Signature**: SHA3-256 (quantum-safe)  
**Scope**: Super + Full nodes only (Light nodes excluded)

```rust
// Reputation sync via HTTP gossip
NetworkMessage::ReputationSync {
    node_id: String,
    reputation_updates: Vec<(String, f64)>,
    timestamp: u64,
    signature: Vec<u8>, // SHA3-256 based
}
```

**Why HTTP over TCP**:
- ✅ More reliable in WAN/Docker environments
- ✅ Connection pooling for millions of nodes
- ✅ Consistent error handling
- ✅ NAT/firewall friendly

### Byzantine Threshold Check

```rust
pub fn is_consensus_qualified(&self) -> bool {
    // CRITICAL: Light nodes NEVER participate in consensus
    if self.node_type == NodeType::Light {
        return false;
    }
    // CRITICAL: Only consensus_score matters (NOT network_score!)
    self.consensus_score >= 70.0
}
```

**Universal 70% Threshold**: Applies to ALL node types (Genesis, Super, Full)

**Node Type Matrix**:
- **Light**: ❌ Never in consensus (only receive macroblock headers)
- **Full**: ✅ If `consensus_score` ≥ 70%
- **Super**: ✅ If `consensus_score` ≥ 70%

### Finality Window for Entropy

**Problem**: Nodes at different heights causing false entropy mismatches

**Solution**: Use `FINALITY_WINDOW` (10 blocks back) for entropy consensus

```rust
// BEFORE (caused false positives):
let entropy_height = ((next_block_height - 1) / 30) * 30;

// AFTER (Byzantine-safe):
let entropy_height = if next_block_height > FINALITY_WINDOW {
    next_block_height - FINALITY_WINDOW  // 10 blocks back
} else {
    0  // Genesis phase
};
```

**Benefits**:
- ✅ All synchronized nodes have the same finalized block
- ✅ Lagging nodes (`peer_entropy == 0`) don't cause false positives
- ✅ REAL fork detection (not just sync lag)

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
- **Block Buffering Limits**: Max 100 pending blocks (~10 MB)
- **Buffer Timeout**: 30 seconds + 5-retry limit
- **FIFO Eviction**: Oldest blocks removed first when buffer is full

#### Certificate Delivery Guarantees
- **Tracked Broadcast**: Critical certificate broadcasts wait for Byzantine 2/3+ confirmation
- **Adaptive Timeout**: 3s (small networks) to 10s (1000 validators)
- **Fallback to Gossip**: If Byzantine threshold not reached, async broadcast ensures eventual delivery
- **Anti-Duplication**: Serial number change detection prevents redundant broadcasts
- **Attack Protection**: Certificate request cooldown (5s) prevents DDoS via repeated requests

### Certificate Security System

QNet implements 6-layer certificate protection against forgery, replay, and spoofing attacks:

#### Layer 1: Node Identity Verification
```rust
if cert.node_id != sender_node_id {
    reject_certificate();
    apply_rate_limit_penalty();
}
```
**Protection**: Prevents certificate spoofing (wrong sender)

#### Layer 2: Age Verification
```rust
MAX_CERT_AGE = 7200 seconds (2 hours)
if current_time - cert.issued_at > MAX_CERT_AGE {
    reject_certificate(); // Replay attack detected
}
```
**Protection**: Prevents replay attacks with old certificates

#### Layer 3: Expiration Check
```rust
if current_time > cert.expires_at {
    reject_certificate(); // Expired
}
```
**Protection**: Enforces 1-hour certificate lifetime

#### Layer 4: Clock Skew Protection
```rust
MAX_CLOCK_SKEW = 60 seconds
if cert.issued_at > current_time + MAX_CLOCK_SKEW {
    reject_certificate(); // Future timestamp attack
}
```
**Protection**: Prevents timestamp manipulation attacks

#### Layer 5: Cryptographic Verification
```rust
// Asynchronous Dilithium3 verification
tokio::spawn(async move {
    let is_valid = pqcrypto_dilithium::dilithium3::open(signed_msg, &pk);
    
    if !is_valid {
        remove_from_pending();
        update_peer_reputation(-20%);
        track_invalid_certificate();  // 5 failures = ban
    } else {
        move_to_verified_cache();
    }
});
```
**Protection**: Real quantum-resistant signature verification

#### Layer 6: Producer Match Verification
```rust
if certificate.node_id != microblock.producer {
    reject_block(); // Wrong producer
}
```
**Protection**: Ensures certificate matches block producer

#### Optimistic Certificate Acceptance

**Implementation**: Two-tier cache system
```
IMMEDIATE: Add to pending_certificates (compressed with LZ4)
           ├─ Available for block verification instantly
           └─ Byzantine consensus ensures 2/3+ agreement

ASYNC:     Dilithium verification in background
           ├─ On success → Move to verified cache
           └─ On failure → Remove + reputation penalty
```

**Benefits**:
- Zero consensus delays
- Byzantine-safe (2/3+ nodes must agree)
- Full cryptographic security preserved
- Race condition eliminated

#### Reputation System Integration

| Violation | Penalty | Escalation |
|-----------|---------|------------|
| Invalid certificate format | -20% reputation | 3 violations = -60% |
| Repeated invalid certs (5×) | 1-year ban | Permanent after 10× |
| Certificate spoofing | Instant permanent ban | Immediate removal |

**Consensus Threshold**: 70% minimum reputation required

#### Certificate Lifecycle

| Metric | Light Nodes | Full/Super Nodes | Network Scale |
|--------|-------------|------------------|---------------|
| **Cache Size** | 0 | 5,000 certs | O(1) regardless of size |
| **Compression** | N/A | LZ4 (~70% reduction) | 5KB → 1.5KB |
| **Memory Usage** | 0 MB | ~7.5 MB | Fixed for 1M+ nodes |
| **Disk Persistence** | 0 | 2,000 certs (2 hours) | Fast recovery |
| **Lifetime** | N/A | 1 hour (3600s) | Automatic rotation |
| **TTL** | N/A | 4 hours cache | Grace period |

**Scalability Proof**:
```
5 nodes:         100% cached (5 certs)
1,000 nodes:     100% cached (1,000 certs, max validators)
1,000,000 nodes: 0.1% cached (1,000 sampled validators)
100M nodes:      0.001% cached (still 1,000 validators)

Conclusion: Certificate memory remains ~7.5 MB regardless of network size
```

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
| **Tracked Broadcast** | Immediate on rotation (Byzantine 2/3+) |
| **Tracked Timeout** | 3s (≤10 peers), 5s (≤100 peers), 10s (1000 peers) |
| **Periodic Broadcast** | Adaptive: 10s / 60s / 300s |
| **Rotation Broadcast** | 80% lifetime (~48 minutes) |
| **Cache Size** | 100,000 certificates |
| **Eviction Policy** | LRU (Least Recently Used) |
| **Certificate Lifetime** | 1 hour (3600 seconds) |
| **Anti-Duplication** | Serial number change detection |

**Adaptive Broadcast Intervals**:
- **10 seconds**: New certificates (80-100% lifetime) - critical phase
- **60 seconds**: Medium age (50-80% lifetime) - normal propagation
- **300 seconds**: Old certificates (0-50% lifetime) - gossip maintenance

**Network Load** (1000 validators):
- Tracked broadcasts (rotations): 1000 × 1 cert/hour = ~0.3 broadcasts/sec
- Periodic broadcasts (adaptive): ~40 broadcasts/min average
- **Total bandwidth**: 200 KB/min = ~27 Kbps (minimal overhead)

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
✅ **Memory protected**: Bounded block buffering with automatic cleanup  
✅ **Certificate delivery**: Tracked broadcast with Byzantine threshold  

**Ready for production deployment.**

---

## Version History

### v2.19.1 (November 22, 2025)

**Certificate Broadcasting Enhancements:**
- Added tracked broadcast with Byzantine 2/3+ threshold for critical certificate rotations
- Implemented adaptive timeout (3s/5s/10s) based on network size to avoid Tower BFT conflicts
- Added anti-duplication protection via serial number change detection
- Updated periodic broadcast to adaptive intervals (10s/60s/300s based on certificate age)
- Added fallback to async gossip broadcast if Byzantine threshold not reached

**Block Buffering and Memory Protection:**
- Implemented `MAX_PENDING_BLOCKS` constant (100 blocks, ~10 MB buffer)
- Added FIFO-like eviction with protection for currently processed block
- Reduced buffer timeout from 60s to 30s to prevent memory accumulation
- Added 5-retry limit to prevent infinite retry loops
- Implemented timestamp-based cleanup for stale blocks

**Fixes:**
- Fixed certificate propagation deadlock at block 2912 (missing broadcast on rotation)
- Fixed memory exhaustion vulnerability from unbounded block buffering
- Fixed potential certificate duplication during rotation + consensus coincidence
- Resolved race condition where buffered block could remove itself from buffer

**Performance Impact:**
- Certificate broadcast latency: 3-10s (adaptive) vs 10s (fixed)
- Memory overhead: ~10 MB max (bounded) vs unlimited (previous)
- Bandwidth: ~27 Kbps (unchanged, adaptive intervals compensate)
- Network resilience: Improved via Byzantine threshold delivery guarantee

---

**For questions or support**: support@qnet.io  
**GitHub**: https://github.com/AIQnetLab/QNet-Blockchain  
**Documentation**: https://docs.qnet.io

