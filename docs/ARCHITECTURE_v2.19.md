# QNet Blockchain Architecture v2.62
## Post-Quantum Decentralized Network - Technical Documentation

**Last Updated**: December 30, 2025  
**Version**: 2.62.0  
**Status**: Production Ready (Per-Round Consensus + Stage Pipeline + Intercontinental Sync)

> ⚠️ **CONSENSUS UPDATED in v2.40.0**  
> Phases now determined by block height (deterministic), not message counts.  
> See [docs/REPUTATION_SYSTEM.md](REPUTATION_SYSTEM.md) for updated slashing/jailing policies.

> ⚠️ **REPUTATION SYSTEM UPDATED in v2.21.0**  
> The reputation section in this document describes the OLD P2P gossip-based system.  
> See [docs/REPUTATION_SYSTEM.md](REPUTATION_SYSTEM.md) for the current deterministic blockchain-based system.

---

## Table of Contents
1. [Overview](#overview)
2. [Block Structure](#block-structure)
3. [Signature System](#signature-system)
4. [Transaction Architecture v2.25](#transaction-architecture-v225)
5. [Optional Quantum TX v2.26](#optional-quantum-resistant-transactions-v226) ⭐ NEW
6. [Gulf Stream Protocol](#gulf-stream-protocol)
7. [Block Buffering and Memory Protection](#block-buffering-and-memory-protection)
8. [Progressive Finalization Protocol](#progressive-finalization-protocol)
9. [Node Types and Scaling](#node-types-and-scaling)
10. [Reputation System](#reputation-system)
11. [Reward System](#reward-system)
12. [MEV Protection & Priority Mempool](#mev-protection--priority-mempool)
13. [Security Model](#security-model)
14. [Performance Characteristics](#performance-characteristics)

---

## Overview

QNet is a high-performance, post-quantum secure blockchain with a **two-layer block structure**:

- **Microblocks**: Created every second (transaction processing)
- **Macroblocks**: Created every 90 seconds (consensus finalization)

### Key Innovations
- **Per-Round Consensus Storage v2.62.0**: Independent HashMap for each round (no data loss!)
- **100% First-Attempt Consensus v2.62.0**: Eliminates "Reveal doesn't match commit" errors
- **Parallel Rounds v2.62.0**: Multiple consensus rounds can work simultaneously
- **Stage Pipeline v2.57.0**: 4 isolated runtimes (BROADCAST, SIGVERIFY, BANKING, REPLAY)
- **Zero Fork Guarantee v2.27.1**: No fallbacks, 100% deterministic producer selection
- **Epoch-Based Validator Set v2.27.0**: Deterministic producer selection from blockchain snapshots
- **Compact Hybrid Signatures v2.23**: 88% bandwidth reduction (~2.6KB RAW bytes)
- **Progressive Finalization Protocol**: Self-healing consensus recovery
- **Zero-Downtime Architecture**: Microblocks continue during macroblock consensus
- **NIST Post-Quantum Compliant**: CRYSTALS-Dilithium + Ed25519 hybrid
- **Batch Ed25519 Verification v2.25.2**: 3x faster signature verification

### v2.57.0: Stage Pipeline (Adaptive Threading)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    ISOLATED STAGE PIPELINE (v2.57.0)                     │
├─────────────────┬─────────────────┬─────────────────┬───────────────────┤
│  MAIN RUNTIME   │ SIGVERIFY_RT    │ BROADCAST_RT    │ BANKING/REPLAY    │
│  (Heartbeat,    │ (adaptive)      │ (adaptive)      │ (adaptive)        │
│   P2P, API)     │                 │                 │                   │
│                 │ Ed25519 verify  │ Shred protocol  │ TX validation     │
│                 │ Dilithium verify│ Block propagate │ State updates     │
└─────────────────┴─────────────────┴─────────────────┴───────────────────┘
```

**Adaptive Thread Distribution:**

| CPU Cores | BROADCAST | SIGVERIFY | BANKING | REPLAY | TOTAL |
|-----------|-----------|-----------|---------|--------|-------|
| 2 cores   | 1t        | 1t        | 1t      | 1t     | **4t** |
| 4 cores   | 2t        | 1t        | 1t      | 1t     | **5t** |
| 8 cores   | 4t        | 2t        | 2t      | 2t     | **10t** |
| 16 cores  | 8t        | 4t        | 4t      | 4t     | **20t** |

**Environment Variables (override defaults):**
- `QNET_BROADCAST_THREADS`: Shred protocol threads
- `QNET_SIGVERIFY_THREADS`: Crypto verification threads
- `QNET_BANKING_THREADS`: Transaction processing threads
- `QNET_REPLAY_THREADS`: State machine threads
- **Batch Mempool Operations v2.25.2**: 1 lock per 1000 TX (1000x reduction)
- **TX Accumulator v2.25.2**: Batch 1000 TX with 100ms timeout
- **Round Tolerance ±90 v2.44.0**: Fork recovery accepts messages within 1 epoch
- **Aggressive Catch-up v2.44.0**: 15s/5 blocks threshold for fast resync (was 120s/50)
- **100K TPS Recovery v2.44.0**: Network self-heals after high-load stress tests
- **LAST_FINALIZED_CONSENSUS_ROUND v2.48.0**: Global atomic tracks actually finalized rounds
- **Dynamic Height Threshold v2.48.0**: 5/10/20 blocks based on network size (scalable)
- **Reveal Loss Prevention v2.48.0**: Participant nodes don't reset consensus engine mid-round
- **ACTIVE_CONSENSUS_MB v2.49.1**: Prevents 60 duplicate tasks → only 1 per MacroBlock
- **Idempotent Rounds v2.49.1**: start_round_at_height() preserves commits/reveals if active
- **Stale Lock Recovery v2.49.1**: Automatic override for panic/timeout (old_mb < new_mb)
- **Retry via Sync v2.49.1**: Gap > 90 blocks → P2P sync instead of consensus (no Round Mismatch)

---

## Epoch-Based Validator Set (v2.27.0)

### Problem Solved

Previous gossip-based producer selection caused **network forks** when different nodes had different views of active peers at the moment of QRDS (Quantum-Resistant Deterministic Selection).

### Solution: MacroBlock Snapshots

All eligible producers for an epoch (90 blocks) are stored in the MacroBlock:

```rust
pub struct ConsensusData {
    // ... other fields ...
    
    /// Eligible producers for next epoch (90 blocks)
    /// Format: bincode serialized Vec<EligibleProducer>
    pub eligible_producers: Option<Vec<u8>>,
}

pub struct EligibleProducer {
    pub node_id: String,      // Node identifier
    pub reputation: f64,      // Reputation score (0.0 - 1.0)
}
```

### Epoch Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    EPOCH-BASED VALIDATOR SET (v2.30)                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  GENESIS EPOCH (blocks 1-180):  ← Extended from 90 for N-2 logic!      │
│  └── Source: genesis_constants.rs (static hardcoded list)              │
│                                                                         │
│  EPOCH N (blocks 181+):                                                │
│  └── Source: MacroBlock N-2.eligible_producers (blockchain)            │
│  └── WHY N-2? N-1 may not be finalized yet! N-2 has 90+ blocks buffer │
│                                                                         │
│  PRODUCER SELECTION (QRDS - Quantum-Resistant Deterministic Selection):│
│  └── calculate_qualified_candidates() → read snapshot from blockchain  │
│  └── SHA3-512 deterministic selection from snapshot                    │
│  └── All nodes use SAME snapshot → DETERMINISM!                        │
│                                                                         │
│  EMERGENCY SELECTION:                                                   │
│  └── Same snapshot, excluding failed producer                          │
│  └── Same SHA3 entropy → DETERMINISM!                                   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Guarantees

| Property | Status |
|----------|--------|
| Determinism | ✅ All nodes read same snapshot from blockchain |
| Scalability | ✅ MAX_VALIDATORS_PER_EPOCH = 1000 |
| Genesis compatibility | ✅ Static list for blocks 1-180 (N-2 extended) |
| N-2 finalization | ✅ 90+ blocks buffer guarantees readiness |
| Emergency failover | ✅ Uses same snapshot |
| No gossip races | ✅ Blockchain is source of truth |

---

## Network Recovery (v2.44.0)

### Problem: Round Mismatch Deadlock

After high-TPS stress tests (100K+ TPS), nodes can desync:
- Different nodes have different consensus round numbers
- `Round Mismatch` error rejects ALL consensus messages
- Emergency failover changes producer but NOT rounds
- Network stalls indefinitely

### Solution: 3 Key Mechanisms

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    NETWORK RECOVERY (v2.44)                             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  1. ROUND TOLERANCE ±90:                                                │
│     └── Accept consensus messages within 1 epoch difference            │
│     └── commit_reveal.rs: diff ≤ 90 → ACCEPT with warning              │
│     └── diff > 90 → REJECT (too far = attack or severe desync)         │
│                                                                          │
│  2. AGGRESSIVE CATCH-UP (15s/5 blocks):                                 │
│     └── Stall detection: 15 seconds (was 120s)                          │
│     └── Gap threshold: 5 blocks (was 50)                                │
│     └── Force rollback to last macroblock boundary                     │
│                                                                          │
│  3. BYZANTINE MEDIAN HEIGHT:                                            │
│     └── sync_blockchain_height() gets fresh median from peers           │
│     └── HealthPing updates peer heights every 15 seconds               │
│     └── Prevents stale cache issues                                     │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Intercontinental Sync (v2.61)

### Problem: Large Block Sync Failure

High-TPS tests (50K+ TPS) produce large blocks (10-20MB). QUIC messages >1MB fail due to UDP fragmentation:

```
Problem Chain:
1. 50K TX → Single block = ~12.5MB
2. BlocksBatch message = 10MB+
3. QUIC fragments into UDP packets
4. ANY packet loss = "Message too short" error
5. Node cannot sync → network stall
```

### Solution: Size-Based Batching + ShredProtocol Unicast

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    INTERCONTINENTAL SYNC (v2.61)                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  1. SIZE-BASED BATCHING:                                                │
│     └── BlocksBatch: max 1MB per QUIC message                           │
│     └── MacroblocksBatch: max 500KB per QUIC message                    │
│     └── Pacing: 5-10ms between batches                                  │
│                                                                          │
│  2. SHREDPROTOCOL UNICAST (blocks >1MB):                                │
│     └── send_block_via_shred_to_peer() for large blocks                 │
│     └── 256KB chunks + Reed-Solomon parity (50% redundancy)             │
│     └── 5ms pacing between chunks                                       │
│     └── Same receiver logic as broadcast (handle_shred_protocol_chunk)  │
│     └── v2.63: Max block size 43.5MB (170 × 256KB) for 100K+ TPS        │
│                                                                          │
│  3. REPAIR BATCHING:                                                    │
│     └── MissingChunksResponse: 10 chunks per batch                      │
│     └── 5ms delay between batches                                       │
│     └── Prevents single large repair message loss                       │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Key Methods (v2.61)

| Method | File | Purpose |
|--------|------|---------|
| `send_block_via_shred_to_peer()` | unified_p2p.rs | Unicast large block via ShredProtocol |
| `get_peer_heights()` | unified_p2p.rs | Get heights from Dilithium-signed heartbeats |
| `handle_sync_request()` | node.rs | Size-based microblock sync |
| `handle_macroblock_sync_request()` | node.rs | Size-based macroblock sync |

### Constants

```rust
// Sync batching (node.rs)
const MAX_BATCH_SIZE_BYTES: usize = 1_000_000;       // 1MB max for BlocksBatch
const MAX_MACROBLOCK_BATCH_SIZE_BYTES: usize = 500_000; // 500KB for MacroblocksBatch
const SHRED_THRESHOLD_BYTES: usize = 1_000_000;      // Blocks >1MB use ShredProtocol
const SYNC_BATCH_DELAY_MS: u64 = 5;                  // Pacing between batches

// Repair batching (unified_p2p.rs)
const REPAIR_BATCH_SIZE: usize = 10;                 // Chunks per repair batch
const REPAIR_BATCH_DELAY_MS: u64 = 5;                // Pacing between repair batches
```

---

## Emergency Producer Selection (v2.61)

### Problem: Lagging Node Selected as Emergency

When network stalls, emergency failover could select a lagging node that cannot produce:

```
Deadlock Scenario (pre-v2.61):
1. Producer Node 2 is lagging (height=911, network=1175)
2. Node 2 skips production (correctly)
3. Emergency failover triggered
4. SHA3-512 selects Node 1 (height=1171, needs=1175)
5. Node 1 cannot produce (missing blocks 1172-1175)
6. Repeat → Network stalled
```

### Solution: Strict Sync Check (N-1)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    EMERGENCY PRODUCER SELECTION (v2.61)                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  STRICT SYNC CHECK:                                                     │
│  └── To create block N, node MUST have block N-1                        │
│  └── sync_threshold = current_height - 1                                │
│  └── No time for sync during emergency - need immediate production      │
│                                                                          │
│  OWN NODE CHECK:                                                        │
│  └── stored_height >= current_height.saturating_sub(1)                  │
│                                                                          │
│  PEER CHECK (via get_peer_heights):                                     │
│  └── peer_height >= sync_threshold                                      │
│  └── Heights from Dilithium-signed HealthPing (Byzantine-resistant)     │
│                                                                          │
│  FALLBACK:                                                              │
│  └── If no synced candidates → Progressive Degradation Protocol         │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Comparison: Normal vs Emergency Sync Thresholds

| Check | Threshold | Context |
|-------|-----------|---------|
| Normal producer skip | 5 blocks lag | Time to catch up between blocks |
| Emergency producer | 1 block lag (N-1) | Must produce immediately |

---

## MacroBlock Consensus (v2.36.0)

### Architecture: Leader-Based Consensus

**CRITICAL**: Only ONE node (Leader) creates MacroBlock. All other validators wait and receive it.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    MACROBLOCK CONSENSUS FLOW (v2.40)                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  STEP 1: LEADER SELECTION (Deterministic + Quantum-Resistant)              │
│  └── should_initiate_consensus() selects ONE leader from N-2 snapshot     │
│  └── Uses SHA3-512 + entropy + round_number for unpredictability          │
│  └── 256-bit quantum resistance (Grover's algorithm)                      │
│  └── ALL nodes compute SAME leader (determinism!)                         │
│                                                                             │
│  STEP 2: BLOCK-BASED CONSENSUS PHASES (v2.40)                              │
│  ├── Blocks 61-72: COMMIT PHASE (12 seconds)                              │
│  │   └── All validators submit COMMIT (cryptographic commitment)          │
│  │   └── Phase determined by get_phase_for_block(height)                  │
│  ├── Blocks 73-84: REVEAL PHASE (12 seconds)                              │
│  │   └── All validators submit REVEAL (open commitment)                   │
│  │   └── Grace periods: accepts late commits (73-78), early reveals (69-72)│
│  └── Blocks 85-90: FINALIZE PHASE (6 seconds)                             │
│      └── Leader collects commits/reveals, prepares MacroBlock             │
│                                                                             │
│  STEP 3: LEADER CREATES MACROBLOCK                                         │
│  └── ONLY Leader calls trigger_macroblock_consensus()                     │
│  └── eligible_producers = ONLY consensus participants (commit+reveal)     │
│  └── NO automatic jails (v2.40) - timing issues are not offenses          │
│                                                                             │
│  STEP 4: BROADCAST (v2.37)                                                 │
│  └── Leader broadcasts MacroBlock via dedicated QUIC channel              │
│  └── NOT ShredProtocol! (avoids height collision with microblocks)        │
│  └── All nodes receive and validate                                       │
│                                                                             │
│  STEP 5: PARTICIPANTS RECEIVE                                              │
│  └── participate_in_macroblock_consensus() WAITS for Leader's MacroBlock  │
│  └── Validates and stores (does NOT create own MacroBlock!)               │
│  └── Timeout → sync fallback                                              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Per-Round Consensus Storage (v2.62.0)

**Problem Solved**: Round transitions would destroy commits/reveals data, causing race conditions.

```
OLD (v2.61 and earlier):
┌─────────────────────────────────────────┐
│ CommitRevealConsensus                   │
│   current_round: Option<RoundState>     │ ← Single round, data loss on transition!
└─────────────────────────────────────────┘

NEW (v2.62.0):
┌─────────────────────────────────────────┐
│ CommitRevealConsensus                   │
│   rounds: HashMap<u64, RoundData>       │ ← Each round independent!
│   active_round: Option<u64>             │
└─────────────────────────────────────────┘
```

**RoundData Structure**:
```rust
pub struct RoundData {
    pub round_number: u64,           // e.g., 3420, 3510, 3600...
    pub epoch: u64,                  // round_number / 90
    pub participants: Vec<String>,
    pub commits: HashMap<String, Commit>,
    pub reveals: HashMap<String, Reveal>,
    pub randomness_beacon: Option<[u8; 32]>,
    pub is_finalized: bool,
    pub finalized_leader: Option<String>,
}
```

**Benefits**:
| Metric | Before v2.62 | After v2.62 |
|--------|--------------|-------------|
| First-attempt success | ~87% | ~100% |
| Data loss on transition | Yes | No |
| Parallel rounds | No | Yes |
| Race conditions | Yes | No |

### Cryptographic Signatures

MacroBlock consensus uses the same hybrid cryptography as microblocks:

| Component | Algorithm | Purpose |
|-----------|-----------|---------|
| **Dilithium3** | CRYSTALS-Dilithium (NIST PQC) | Post-quantum signature |
| **Ed25519** | Ephemeral keys per message | Forward secrecy |
| **Signature Size** | ~5KB (Full) for MacroBlocks | Includes certificate |

```rust
// MacroBlock signature (Full type with embedded certificate)
generate_consensus_signature(
    message: &[u8],
    is_macroblock: true,  // → Full signature (~5KB)
)

// Microblock signature (Compact type)
generate_consensus_signature(
    message: &[u8],
    is_macroblock: false, // → Compact signature (~2.6KB)
)
```

---

## Zero Fork Guarantee (v2.27.1)

### Problem Solved

Even with epoch-based validator sets, three sources of non-determinism caused forks:

| Bug | Impact |
|-----|--------|
| Skip self +1 in peer list | Each node saw different peer count |
| Entropy fallback to macroblock | Different entropy seed if macroblock not synced |
| Producer list fallback to gossip | Different producers from gossip registry |

### Solution: No Fallback Policy

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    ZERO FORK GUARANTEE                                   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  PRODUCER LIST:                                                         │
│  ├── if macroblock_available: use MacroBlock.eligible_producers        │
│  └── else: return [] (empty list - node cannot participate!)           │
│                                                                         │
│  ENTROPY:                                                               │
│  └── ALWAYS use microblock[height - FINALITY_WINDOW]                   │
│  └── NO fallback to macroblock (may not be synced)                     │
│                                                                         │
│  LAGGING NODES:                                                         │
│  └── Cannot be producer (empty list)                                    │
│  └── Must sync first                                                    │
│  └── Network continues without them (standard blockchain behavior)     │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Alignment with Top L1 Blockchains

| Aspect | Solana | Ethereum 2.0 | QNet v3.0 |
|--------|--------|--------------|--------------|
| Validator Set | Epoch snapshot | Epoch snapshot | MacroBlock snapshot ✅ |
| Entropy | VRF + blockhash | RANDAO | **QRB (Quantum Randomness Beacon)** ✅ |
| True Randomness | Chainlink VRF | RANDAO accumulator | **Native QRB API** ✅ |
| Fallback | ❌ None | ❌ None | **❌ None** ✅ |
| Lagging nodes | Must sync | Must sync | **Must sync** ✅ |
| Determinism | 100% | 100% | **100%** ✅ |
| Quantum Safe | ❌ No | ❌ No | **✅ Dilithium3 VRF** |

### Fork Risk

```
Before v2.27.1:                After v2.27.1:
- Peers list: ~70%             - Peers list: 100% ✅
- Entropy: ~80%                - Entropy: 100% ✅
- Producer list: ~90%          - Producer list: 100% ✅
- Fork risk: ~30%              - Fork risk: 0% ✅
```

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
    pub signature: Vec<u8>,       // COMPACT hybrid signature v2.23 (~2.6KB RAW)
    pub poh_hash: Vec<u8>,        // Verifiable Time Sequence hash (64 bytes)
    pub poh_count: u64,           // VTS counter for time ordering
    // ... transactions and other fields
}
```

**Signature Type**: Compact v2.23 (~2.6KB RAW bytes)  
**Frequency**: 1 per second  
**Verification**: P2P layer + Consensus layer (defense-in-depth)

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

**Signature Type**: Full hybrid v2.23 (~5KB RAW bytes)  
**Frequency**: Every 90 blocks (90 seconds)  
**Verification**: Byzantine consensus (2/3+ nodes)

---

## Quantum Randomness Beacon (QRB) v3.0

### Overview

QNet v3.0 introduces a native **Quantum Randomness Beacon** - a RANDAO-style accumulated randomness system with quantum-resistant VRF. This provides "true unpredictability" for:
- 🎰 On-chain gambling and lotteries
- 🎨 Fair NFT mints and drops
- 🎲 Gaming applications
- ⚖️ Fair auctions and leader election

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│               QUANTUM RANDOMNESS BEACON (QRB) v3.0                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  EPOCH (90 microblocks) - Each producer contributes:                        │
│                                                                             │
│  Block 1:  Producer A → VRF_output_A (Dilithium3 signature)                │
│  Block 2:  Producer B → VRF_output_B                                        │
│  ...                                                                        │
│  Block 90: Producer E → VRF_output_E                                        │
│                                                                             │
│  ═══════════════════════════════════════════════════════════════════════   │
│  MacroBlock: randomness_beacon = XOR(VRF_1, VRF_2, ..., VRF_90)            │
│  ═══════════════════════════════════════════════════════════════════════   │
│                                                                             │
│  Result: NOBODY knows randomness_beacon until MacroBlock finalization!     │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### VRF Generation (per Microblock)

```rust
// Input (deterministic, same on all nodes):
vrf_input = SHA3-256(
    "QNet_QRB_v3" ||
    prev_block_hash ||
    block_height ||
    producer_id
)

// Output (quantum-resistant):
vrf_output = HybridVRF.evaluate(vrf_input)
// → 32 bytes random output
// → Proof: Dilithium3 + Ed25519 signature
```

### Beacon Accumulation (per MacroBlock)

```rust
// RANDAO-style XOR accumulation:
randomness_beacon = VRF_1 ⊕ VRF_2 ⊕ ... ⊕ VRF_90

// Stored in MacroBlock.consensus_data:
pub randomness_beacon: Option<[u8; 32]>,
pub vrf_contributions_count: Option<u64>,
```

### RPC API

| Method | Description | Params |
|--------|-------------|--------|
| `qrb_getRandomness` | Get beacon for epoch | `{ epoch: u64 }` |
| `qrb_getLatestRandomness` | Get latest beacon | none |
| `qrb_getRandomnessWithSeed` | Combine beacon with seed | `{ epoch: u64, seed: "0x..." }` |

**Example Response:**
```json
{
  "randomness": "0x7a3f9c...",
  "epoch": 42,
  "vrf_contributions": 90,
  "verified": true,
  "quantum_safe": true,
  "algorithm": "XOR(VRF_Dilithium3_1...VRF_Dilithium3_N)"
}
```

### Security Properties

| Property | Value | Notes |
|----------|-------|-------|
| Unpredictability | ✅ 100% | No one knows beacon until finalization |
| Quantum Resistance | ✅ Yes | Dilithium3 VRF (NIST FIPS 204) |
| Manipulation Resistance | ✅ Yes | Requires controlling >50% of producers |
| Last Revealer Attack | ⚠️ Mitigated | Withholding = lost rewards + slashing |
| Verification | ✅ On-chain | Any node can verify VRF proofs |

### Comparison with Other L1s

| Feature | Ethereum 2.0 | Solana | Chainlink VRF | QNet QRB |
|---------|--------------|--------|---------------|----------|
| Native | ✅ Yes | ❌ No | ❌ No (oracle) | ✅ Yes |
| Quantum Safe | ❌ No | ❌ No | ❌ No | ✅ **Dilithium3** |
| Verifiable | ✅ Yes | ⚠️ Limited | ✅ Yes | ✅ Yes |
| True Random | ✅ Yes | ⚠️ VRF only | ✅ Yes | ✅ Yes |
| Cost | Gas fees | Minimal | High (oracle) | **Free** |

---

## Signature System

### NIST/Cisco Compliant Hybrid Signatures (v2.23 - RAW bytes)

> **UPDATED v2.23**: Signatures now use RAW bytes format via `serde_bytes` instead of base64/JSON.
> This reduces compact signature size from ~22KB to **~2.6KB** (88% reduction).

**Critical Security**: Per NIST SP 800-208 and Cisco recommendations, every message uses a **NEW ephemeral Ed25519 key** signed by the persistent Dilithium key.

```
┌─────────────────────────────────────────────────────────────────────┐
│ HYBRID SIGNATURE ARCHITECTURE (NIST/Cisco Compliant) - v2.23       │
├─────────────────────────────────────────────────────────────────────┤
│ For EACH message:                                                   │
│   1. Generate NEW ephemeral Ed25519 keypair                        │
│   2. Sign message with ephemeral Ed25519 → message_signature       │
│   3. Create encapsulated_data = ephemeral_pk || hash || timestamp  │
│   4. Sign encapsulated_data with Dilithium → dilithium_key_sig     │
│   (dilithium_message_signature REMOVED - redundant, saves ~3.3KB)  │
├─────────────────────────────────────────────────────────────────────┤
│ Quantum Attack Protection:                                          │
│   - Attacker breaks Ed25519? → Dilithium still protects!           │
│   - Attacker breaks one message? → Other messages use NEW keys!    │
│   - Forward secrecy via ephemeral keys                             │
└─────────────────────────────────────────────────────────────────────┘
```

### Compact Signatures (Microblocks) - v2.23

**Format**: `compact:<json>` with RAW bytes via `serde_bytes`

```rust
CompactHybridSignature {
    node_id: String,                     // "genesis_node_001"
    cert_serial: String,                 // "cert_2024_11_16_12345"
    ephemeral_public_key: [u8; 32],      // RAW bytes (NEW Ed25519 key)
    message_signature: [u8; 64],         // RAW bytes (Ed25519 signature)
    dilithium_key_signature: Vec<u8>,    // RAW bytes (~2500 bytes, NOT base64!)
    signed_at: u64,                      // Unix timestamp
}
```

**Size**: ~2.6KB (was 22KB - **88% reduction**)  
**Format**: RAW bytes via `serde_bytes` (no base64 overhead)  
**Certificate**: Referenced by serial, cached at P2P layer  
**Ephemeral Keys**: NEW key generated for EACH message (NIST/Cisco requirement)

#### Verification Flow

```
1. Microblock arrives at node
   ↓
2. P2P Layer (node.rs::verify_microblock_signature)
   ├─► Structural validation (ephemeral_public_key present?)
   ├─► Certificate lookup (cache or request)
   ├─► Ed25519 verify with EPHEMERAL key ✅
   ├─► Recreate encapsulated_data = ephemeral_pk || hash || timestamp
   ├─► Dilithium verify encapsulated_data (key binding) ✅
   └─► Result: Accept (all pass) or Reject (any fail)
   ↓
3. Consensus Layer (consensus_crypto.rs::verify_compact_hybrid_signature)
   ├─► Parse RAW bytes from JSON
   ├─► Reconstruct encapsulated_data
   ├─► Real Dilithium3 verification via dilithium3::open()
   ├─► Byzantine consensus (2/3+ honest nodes)
   └─► Only verified blocks participate
```

### Full Hybrid Signatures (Macroblocks) - v2.23

**Format**: `hybrid:<json>` with RAW bytes

```rust
HybridSignature {
    certificate: HybridCertificate,      // Full certificate embedded
    ephemeral_public_key: [u8; 32],      // RAW bytes
    message_signature: [u8; 64],          // RAW bytes (Ed25519)
    dilithium_key_signature: Vec<u8>,    // RAW bytes (~2500 bytes)
    signed_at: u64,
}

// Certificate structure:
HybridCertificate {
    node_id: String,
    serial: String,
    ed25519_public_key: [u8; 32],        // RAW bytes
    dilithium_public_key: Vec<u8>,       // RAW bytes (~1952 bytes)
    dilithium_signature_of_ed25519: Vec<u8>, // Certificate binding
    "serial_number": "...",
    "valid_from": 1700140800,
    "valid_until": 1700227200
  }
}
```

**Size**: ~5KB RAW bytes (was 12KB - 58% reduction)  
**Use Case**: Macroblocks (no certificate lookup delay)  
**Verification**: Immediate (certificate embedded) + real Dilithium  
**Ephemeral Keys**: Same NIST/Cisco requirement as compact signatures

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

**Lifetime**: 4.5 minutes (270 seconds = 3 macroblocks)  
**Rotation**: Automatic at 80% threshold (216 seconds)  
**Grace Period**: 54 seconds (sufficient for global WAN propagation)  
**Storage**: LRU cache with 100K capacity  
**Quantum Security**: 10^15 years attack time (NIST Security Level 3)

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
- **Transport**: QUIC (UDP 10876) - binary protocol

**Cache**: 100,000 certificates (LRU eviction)  
**Scalability**: Handles millions of nodes (max 1000 active validators)

---

## Transaction Architecture v2.25

### Serialization: bincode (10-20x faster than JSON)

All internal transaction storage and network transmission uses **bincode** serialization:

```rust
// Serialization (submit_transaction)
let tx_bytes = bincode::serialize(&tx)?;
let tx_hash = sha3::Sha3_256::digest(&tx_bytes);
mempool.add_binary_transaction(tx_bytes, tx_hash, tx.gas_price);

// Deserialization (block building)
let tx_bytes_list = mempool.get_pending_binary_transactions(100_000);
for tx_bytes in tx_bytes_list {
    let tx: Transaction = bincode::deserialize(&tx_bytes)?;
    // Process transaction
}
```

### Key Methods

| Method | Description | Format |
|--------|-------------|--------|
| `add_binary_transaction(bytes, hash, gas_price)` | Add TX to mempool | bincode |
| `get_binary_transaction(hash)` | Get single TX | bincode |
| `get_pending_binary_transactions(limit)` | Get TXs for block | bincode |
| `submit_transaction(tx)` | Client submission | bincode + Gulf Stream |
| `broadcast_transaction(bytes)` | P2P broadcast | bincode over QUIC |
| `broadcast_transaction_batch(bytes_vec)` | Batch broadcast | bincode over QUIC |

### Backward Compatibility

JSON fallback for legacy nodes:

```rust
// Deserialization with fallback
let tx = bincode::deserialize::<Transaction>(&tx_bytes)
    .or_else(|_| {
        let json = String::from_utf8(tx_bytes)?;
        serde_json::from_str::<Transaction>(&json)
    })?;
```

### Optional Quantum-Resistant Transactions (v2.26)

Standard transactions use **Ed25519** signatures (fast, ~64 bytes). For high-value transfers, users can opt-in to **CRYSTALS-Dilithium3** quantum-resistant signatures:

```rust
pub struct Transaction {
    // ... standard fields ...
    pub dilithium_signature: Option<String>,   // Optional quantum signature
    pub dilithium_public_key: Option<String>,  // Optional quantum public key
}

impl Transaction {
    /// Check if transaction has quantum-resistant signature
    pub fn is_quantum_signed(&self) -> bool {
        self.dilithium_signature.is_some() && self.dilithium_public_key.is_some()
    }
    
    /// Quantum transactions pay +50% gas premium
    pub fn effective_gas_price(&self) -> u64 {
        if self.is_quantum_signed() {
            self.gas_price + (self.gas_price / 2)  // +50%
        } else {
            self.gas_price
        }
    }
}
```

| Type | Signature | Size | Gas Cost | Security |
|------|-----------|------|----------|----------|
| **Standard TX** | Ed25519 only | ~64 bytes | Base | Classical |
| **Quantum TX** | Ed25519 + Dilithium3 | ~2.5KB | +50% premium | Post-quantum |

**API Usage**:
```json
{
  "from": "EON1...",
  "to": "EON1...",
  "amount": 1000000000,
  "dilithium_signature": "base64...",  // Optional
  "dilithium_public_key": "base64..."  // Optional
}
```

---

## Gulf Stream Protocol

QNet v2.25 implements **direct producer forwarding**:

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    GULF STREAM v2.25                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Client                                                     │
│    │                                                        │
│    ▼ submit_transaction(tx)                                 │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ 1. Validate & serialize (bincode)                   │    │
│  │ 2. Add to local mempool                             │    │
│  │ 3. Gulf Stream broadcast:                           │    │
│  │    ├── PRIORITY: Direct to current producer (0 hop)│    │
│  │    └── BACKUP: Gossip to 2 random peers            │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ PRODUCER (known via consensus)                       │    │
│  │ • Receives TX in ~10-50ms (vs 100-300ms gossip)     │    │
│  │ • Includes in next block immediately                │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ BACKUP PEERS (2 random)                             │    │
│  │ • Reliability if producer fails                     │    │
│  │ • TX propagates via gossip as fallback             │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Implementation

```rust
// unified_p2p.rs
pub fn broadcast_transaction(&self, tx_data: Vec<u8>) -> Result<(), String> {
    let tx_msg = NetworkMessage::Transaction { data: tx_data };
    
    // GULF STREAM: Priority path to producer
    if let Some((producer_id, producer_addr)) = self.get_current_producer() {
        if producer_id != self.node_id {
            self.send_network_message(&producer_addr, tx_msg.clone());
        }
    }
    
    // BACKUP: Gossip to 2 random peers
    self.gossip_to_random_peers(tx_msg, 2);
    Ok(())
}
```

### Anti-Storm Protection

Prevents exponential message amplification:

```rust
// Each node tracks seen TX hashes
seen_tx_hashes: Arc<DashSet<String>>  // Capacity: 1M hashes

// On TX receive:
if seen_tx_hashes.contains(&tx_hash) {
    return;  // Already processed - skip
}
seen_tx_hashes.insert(tx_hash.clone());
// Process TX and forward to 2 peers

// Cleanup every 60 seconds:
seen_tx_hashes.clear();
```

**Result**: Linear message growth instead of exponential (2^N → ~10)

### Transaction Batching

High-throughput batch submission:

```rust
// Single QUIC stream for entire batch (100-1000x fewer streams)
pub fn broadcast_transaction_batch(&self, transactions: Vec<Vec<u8>>) -> Result<(), String> {
    let batch_msg = NetworkMessage::TransactionBatch {
        transactions,
        timestamp: current_time(),
    };
    
    // Gulf Stream: batch to producer + 2 backup
    // ...
}
```

### Performance Comparison

| Metric | Before v2.25 | After v2.25 | Improvement |
|--------|--------------|-------------|-------------|
| TX latency to producer | 100-300ms | 10-50ms | **6-10x** |
| Network messages per TX | 2^N (exponential) | ~10 (linear) | **Massive** |
| Serialization speed | JSON | bincode | **10-20x** |
| QUIC streams per batch | N | 1 | **100-1000x** |
| TX/block limit | 50K | 100K | **2x** |
| Mempool size | 5M | 10M | **2x** |
| **Expected TPS** | 3-10K | **50-100K+** | **10-30x** |

---

## Block Buffering and Memory Protection

### Problem
In a gossip-based P2P network, blocks may arrive out of order due to network latency or partial connectivity. Nodes must buffer blocks until their parent blocks arrive.

### Solution: Bounded Buffer with Cleanup (v2.19.20)

#### Adaptive Buffer Size by Node Type

```rust
// MEMORY PROTECTION v2.19.20: Adaptive buffer size by node type
// Full/Super nodes: 500 blocks (~50MB) - covers 8+ minutes of network issues
// Light nodes: 100 blocks (~10MB) - minimal memory footprint
// Protects against malicious peers sending out-of-order blocks
let max_pending_blocks: usize = match node_type {
    NodeType::Light => 100,  // Light nodes: minimal memory (~10MB)
    NodeType::Full | NodeType::Super => 500,  // Full/Super: larger buffer (~50MB)
};

if pending_blocks.len() >= max_pending_blocks {
    // Remove oldest block to make room (FIFO-like)
    if let Some((&oldest_height, _)) = pending_blocks.iter()
        .filter(|(&h, _)| h != received_block.height)  // Don't remove current block
        .min_by_key(|(_, (_, _, timestamp))| timestamp) {
        pending_blocks.remove(&oldest_height);
        println!("[BLOCKS] 🚨 Max buffer ({}) reached - removed oldest block #{}", 
                 max_pending_blocks, oldest_height);
    }
}
```

#### Pseudo-Infinite Retry Mechanism (v2.19.20)

```rust
// CRITICAL v2.19.20: PSEUDO-INFINITE retries for block reliability
// Blocks are critical data - NEVER discard them!
// Protection layers:
// 1. max_pending_blocks = 500 Full/Super, 100 Light (memory protection)
// 2. Exponential backoff after 10 retries (network protection)
// 3. Rate limiting on requests (CPU protection)
// 4. Background sync every 30s (persistent recovery)

// Backoff schedule:
// - Retries 0-9: 10s cooldown (aggressive)
// - Retries 10+: exponential (30s, 60s, 120s, 240s, 300s max)
let backoff_secs = if retry_count < 10 {
    10u64  // Aggressive: 10 seconds for first 10 retries
} else {
    // Exponential: 30 * 2^(retry-10), max 300s (5 minutes)
    std::cmp::min(30 * (1u64 << (retry_count - 10).min(4)), 300)
};

// ALWAYS buffer - never discard! (pseudo-infinite)
pending_blocks.insert(height, (block, retry_count, timestamp));
```

#### Protection Features (v2.19.20)

| Feature | Light Nodes | Full/Super Nodes | Purpose |
|---------|-------------|------------------|---------|
| **Max Buffer Size** | 100 blocks (~10 MB) | 500 blocks (~50 MB) | Prevent memory exhaustion |
| **Retry Limit** | **Pseudo-infinite** | **Pseudo-infinite** | Never lose blocks |
| **Backoff (0-9)** | 10 seconds | 10 seconds | Aggressive recovery |
| **Backoff (10+)** | 30s → 300s max | 30s → 300s max | Network protection |
| **Eviction Policy** | FIFO (oldest first) | FIFO (oldest first) | Fair buffer management |
| **Self-Protection** | Current block never removed | Current block never removed | Ensure progress |

**Attack Mitigation**:
- **Memory DoS**: Adaptive buffer (10-50 MB based on node type)
- **Stale Blocks**: Background re-request every 30s with exponential backoff
- **Infinite Retry**: Pseudo-infinite with backoff (never discard critical data)
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
- **Reputation**: Fixed at 70 (immutable, not affected by network events)
- **Rewards**: Eligible for Pool 1 base emission (equal share with all nodes)

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
FullRotationComplete    // +2.0 consensus_score (for completing all 30 blocks)
InvalidBlock            // -20.0 consensus_score
ConsensusParticipation  // +1.0 consensus_score
MaliciousBehavior       // -50.0 consensus_score

// NETWORK EVENTS (PENALTIES ONLY - no bonuses!)
TimeoutFailure          // -2.0 network_score (NOT malicious!)
ConnectionFailure       // -5.0 network_score

// PASSIVE RECOVERY (once per 4h, if score [10, 70), NOT jailed)
// +1.0 reputation

// PROGRESSIVE JAIL (6 chances for regular offenses):
// 1st: 1h → 30%    4th: 30d → 15%
// 2nd: 24h → 25%   5th: 3m → 12%
// 3rd: 7d → 20%    6+: 1y → 10% (can return!)
//
// CRITICAL ATTACKS → PERMANENT BAN (no return):
// DatabaseSubstitution, ChainFork, StorageDeletion
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

### Reputation Gossip Protocol (v2.19.22)

**Complexity**: O(log n) exponential propagation (NOT O(n) broadcast!)  
**Transport**: QUIC (UDP 10876) - binary protocol  
**Interval**: Every 5 minutes  
**Signature**: SHA3-256 (quantum-safe)  
**Scope**: Super + Full nodes only (Light nodes excluded)  
**Fanout**: Adaptive 4-32 (same as Shred Protocol)

```rust
// Reputation sync via QUIC gossip
NetworkMessage::ReputationSync {
    node_id: String,
    reputation_updates: Vec<(String, f64)>,
    timestamp: u64,
    signature: Vec<u8>, // SHA3-256 based
}
```

**Gossip Propagation (v2.19.19)**:
1. **Initial Send**: Node gossips to K closest neighbors by Kademlia distance (K=3)
2. **Re-gossip**: Each recipient re-gossips to K neighbors (exclude sender)
3. **Exponential Growth**: 1 → 3 → 9 → 27 → 81 → 243 → 729 (7 hops for 729 nodes)
4. **Convergence**: Weighted average (70% local, 30% remote) ensures eventual consistency

**v2.19.19 Optimizations**:
- **Kademlia K-neighbors**: Heartbeats use DHT distance for efficient routing
- **Shred Protocol ALWAYS**: Block propagation uses Shred Protocol for ALL network sizes
- **Heartbeat with HYBRID signatures (v2.23)**: Full quantum protection (Ed25519 + Dilithium)
- **Exponential backoff failover**: 3s → 6s → 12s → 24s → 30s max

**Why Gossip O(log n) vs Broadcast O(n)**:
- ✅ **Scalability**: 1M nodes = ~20 hops vs 1M requests
- ✅ **Bandwidth**: 99.999% reduction for millions of nodes
- ✅ **Fork Prevention**: All nodes converge to same reputation view
- ✅ **Byzantine Safety**: Signature verification at each hop

**Why QUIC over HTTP (v2.19.22)**:
- ✅ No Head-of-Line Blocking (independent streams)
- ✅ 0-RTT handshake for repeat connections
- ✅ Connection multiplexing (100+ streams/connection)
- ✅ Built-in TLS 1.3 encryption
- ✅ Binary protocol (~50% bandwidth reduction)

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

### Light Node Reputation (Fixed)

**IMPORTANT**: Light node reputation is **always 70** and cannot be changed.

```rust
pub fn update_reputation_by_delta(&self, node_id: &str, delta: f64) {
    if node_id.starts_with("light_") {
        return; // Light nodes: reputation is always 70, no changes allowed
    }
    // ... rest of reputation update logic
}

pub fn set_node_reputation(&self, node_id: &str, reputation: f64) {
    let final_reputation = if node_id.starts_with("light_") {
        70.0 // Light nodes: always 70, ignore requested value
    } else {
        reputation
    };
    // ... rest of reputation set logic
}
```

**Rationale**:
- Light nodes are mobile devices (unstable connectivity)
- Network issues should not affect reward eligibility
- Light nodes don't participate in consensus (no Byzantine risk)
- Simplifies reward calculation (no reputation tracking needed)

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
    0  // Initial blocks (use Genesis as entropy)
};
```

**Benefits**:
- ✅ All synchronized nodes have the same finalized block
- ✅ Lagging nodes (`peer_entropy == 0`) don't cause false positives
- ✅ REAL fork detection (not just sync lag)

---

### Adaptive Entropy Consensus (v2.19.4)

**Problem**: Fixed sample size (5 peers) and fixed timeout (4s) don't scale from 5 Genesis nodes to 1M+ network

**Solution**: Adaptive sample size and dynamic wait with Byzantine threshold

```rust
// ADAPTIVE SAMPLE SIZE: Scales with network size
let qualified_producers = p2p.get_qualified_producers_count();
let sample_size = match qualified_producers {
    0..=50 => std::cmp::min(peers.len(), 50),    // Genesis: sample all (100%)
    51..=200 => std::cmp::min(peers.len(), 20),  // Small: 10%
    201..=1000 => std::cmp::min(peers.len(), 50),// Medium: 5%
    _ => std::cmp::min(peers.len(), 100),        // Large: 10% of active producers
};

// ADAPTIVE TIMEOUT: Based on network size and latency
let avg_latency = p2p.get_average_peer_latency();
let max_consensus_wait = match (qualified_producers, avg_latency) {
    (0..=50, _) => Duration::from_millis(2000),        // Genesis WAN: 2s
    (51..=200, 0..=50) => Duration::from_millis(1000), // Small LAN: 1s
    (51..=200, _) => Duration::from_millis(2000),      // Small WAN: 2s
    (201..=1000, 0..=50) => Duration::from_millis(1000), // Medium LAN: 1s
    (201..=1000, _) => Duration::from_millis(1500),    // Medium WAN: 1.5s
    _ => Duration::from_millis(1000),                  // Large: 1s
};

// DYNAMIC WAIT: Exit early when Byzantine threshold reached
let byzantine_threshold = ((sample_size as f64 * 0.6).ceil() as usize).max(1);
loop {
    if matches >= byzantine_threshold { break; } // Fast exit!
    if timeout { break; }
    tokio::time::sleep(Duration::from_millis(100)).await;
}
```

**Benefits**:
- ✅ **Scalability**: 5 nodes → 1M nodes without degradation
- ✅ **Speed**: 2-20× faster (200-1000ms vs 4000ms fixed)
- ✅ **Byzantine-safe**: 60% threshold for consensus
- ✅ **Network-efficient**: < 1 KB/s bandwidth even for 1M nodes
- ✅ **Low overhead**: 0.002% CPU, < 100 KB memory

**Performance Comparison**:

| Network Size | Old Code | New Code (avg) | Improvement |
|--------------|----------|----------------|-------------|
| Genesis (5) | 4000ms | 500-2000ms | 2-8× faster |
| Small (100) | 4000ms | 200-1000ms | 4-20× faster |
| Medium (500) | 4000ms | 200-1000ms | 4-20× faster |
| Large (1M) | 4000ms | 200-1000ms | 4-20× faster |

**Scaling Efficiency**:
- Sample size: O(log log n) - grows slowly with network size
- Bandwidth: O(log n) - 1 KB (5 nodes) → 6 KB (1M nodes)
- Latency: O(1) - constant regardless of network size

---

## Reward System

### Overview

QNet implements a **Phase-Aware Three-Pool Reward System** with lazy reward accumulation:

```
┌─────────────────────────────────────────────────────────────┐
│ REWARD POOLS (4-hour emission window)                       │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ POOL 1: Base Emission                                │   │
│  │ • 251,432 QNC per 4-hour window (initial)           │   │
│  │ • Halving every 4 years (sharp drop at year 20)     │   │
│  │ • Divided EQUALLY among ALL eligible nodes          │   │
│  │ • Light + Full + Super all receive equal share      │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ POOL 2: Transaction Fees                             │   │
│  │ • 70% to Super nodes (divided equally among Super)  │   │
│  │ • 30% to Full nodes (divided equally among Full)    │   │
│  │ • 0% to Light nodes (don't process transactions)    │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ POOL 3: Activation Bonus (Phase 2 only)             │   │
│  │ • Funded by 1DEV token burns                        │   │
│  │ • Distributed to newly activated nodes              │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Lazy Rewards

**Key Feature**: Rewards accumulate automatically and can be claimed at any time.

```rust
// Rewards accumulate in pending_rewards (RocksDB)
struct PendingReward {
    node_id: String,
    wallet_address: String,
    pool1_base_emission: u64,
    pool2_transaction_fees: u64,
    pool3_activation_bonus: u64,
    total_reward: u64,
    last_updated: u64,
}

// User claims via API when ready
POST /api/v1/rewards/claim
{
    "node_id": "light_abc123",
    "wallet_address": "QNet...",
    "signature": "ed25519_signature",
    "public_key": "ed25519_pubkey"
}
```

**Benefits**:
- ✅ No missed reward windows
- ✅ No gas wars for claiming
- ✅ Claim when gas is cheap
- ✅ Batch multiple windows

### Ping/Attestation System (Light Nodes)

**Architecture**: 256-shard deterministic pinging

```
┌─────────────────────────────────────────────────────────────┐
│ SHARDED PING SYSTEM                                         │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Light Node ID → SHA3-256 → First byte → Shard (0-255)     │
│                                                              │
│  Each shard:                                                │
│  • Assigned to specific Full/Super nodes (deterministic)   │
│  • Pinger rotates every 4-hour window                      │
│  • Max 100K Light nodes per shard (LRU eviction)           │
│                                                              │
│  Ping Flow:                                                 │
│  1. Full/Super node sends FCM push to Light node           │
│  2. Light node wakes, signs challenge with Ed25519         │
│  3. Light node returns signed response                     │
│  4. Full/Super creates attestation (dual Dilithium sigs)   │
│  5. Attestation gossiped to network                        │
│  6. Stored in RocksDB for reward calculation               │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

**Attestation Structure**:
```rust
struct LightNodeAttestation {
    light_node_id: String,
    pinger_node_id: String,
    slot: u64,
    timestamp: u64,
    light_node_signature: Vec<u8>,    // Ed25519 (Light node)
    pinger_dilithium_signature: String, // Dilithium (Pinger)
}
```

**Eligibility**: Light node needs at least 1 successful attestation per 4-hour window.

### Heartbeat System (Full/Super Nodes)

**Architecture**: Self-attestation for Full/Super nodes

```
┌─────────────────────────────────────────────────────────────┐
│ HEARTBEAT SYSTEM                                            │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Full/Super nodes send 10 heartbeats per 4-hour window     │
│                                                              │
│  Heartbeat Flow:                                            │
│  1. Node creates heartbeat with current timestamp          │
│  2. Signs with Dilithium (quantum-resistant)               │
│  3. Broadcasts via P2P gossip                              │
│  4. Other nodes verify and store                           │
│  5. At reward time, count heartbeats per node              │
│                                                              │
│  Eligibility:                                               │
│  • Full: 8+ heartbeats (80% success rate)                  │
│  • Super: 9+ heartbeats (90% success rate)                 │
│  • Reputation >= 70% required                              │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

**Heartbeat Structure**:
```rust
struct FullNodeHeartbeat {
    node_id: String,
    node_type: String,  // "full" or "super"
    heartbeat_index: u8, // 0-9 (10 per window)
    timestamp: u64,
    dilithium_signature: String,
}
```

### FCM Push Notifications (Light Nodes)

**Architecture**: Only Genesis nodes send FCM notifications

```
┌─────────────────────────────────────────────────────────────┐
│ FCM V1 API Integration                                      │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Authentication:                                            │
│  • OAuth2 with Service Account JSON                        │
│  • Access token cached for 55 minutes                      │
│  • Environment: GOOGLE_APPLICATION_CREDENTIALS             │
│                                                              │
│  Rate Limiting:                                             │
│  • 500 requests/second (FCM limit)                         │
│  • Semaphore-based concurrency control                     │
│                                                              │
│  Message Format:                                            │
│  {                                                          │
│    "message": {                                             │
│      "token": "device_fcm_token",                          │
│      "data": {                                              │
│        "type": "ping_challenge",                           │
│        "node_id": "light_abc123",                          │
│        "challenge": "random_challenge_string",             │
│        "timestamp": "1700000000"                           │
│      }                                                      │
│    }                                                        │
│  }                                                          │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Reward Calculation

**Deterministic Merkle + Sampling**:

```rust
// STEP 1: Collect all attestations/heartbeats for window
let attestations = storage.get_attestations_for_window(window_start);
let heartbeats = storage.get_heartbeats_for_window(window_start);

// STEP 2: Build Merkle tree (parallel with rayon)
let ping_hashes: Vec<String> = all_pings.par_iter()
    .map(|ping| ping.calculate_hash())  // blake3
    .collect();
let merkle_root = build_merkle_tree(&ping_hashes);

// STEP 3: Deterministic sampling (SHA3-256 seed)
let entropy_block = storage.load_microblock(current_height - FINALITY_WINDOW)?;
let sample_seed = sha3_256(b"QNet_Ping_Sampling_v1" || entropy_block || window_start);
let sampled_pings = deterministic_sample(&all_pings, sample_seed, SAMPLE_SIZE);

// STEP 4: Calculate rewards per node
let pool1_per_node = pool1_emission / eligible_nodes_count;
let pool2_super = (pool2_fees * 70 / 100) / super_nodes_count;
let pool2_full = (pool2_fees * 30 / 100) / full_nodes_count;

// STEP 5: Store pending rewards (lazy accumulation)
for node in eligible_nodes {
    let reward = match node.node_type {
        Light => pool1_per_node,
        Full => pool1_per_node + pool2_full,
        Super => pool1_per_node + pool2_super,
    };
    storage.save_pending_reward(&node.id, reward)?;
}
```

### Halving Schedule

| Years | Pool 1 Emission (per 4h) | Halving Factor |
|-------|--------------------------|----------------|
| 0-4 | 251,432 QNC | 1x |
| 4-8 | 125,716 QNC | ÷2 |
| 8-12 | 62,858 QNC | ÷2 |
| 12-16 | 31,429 QNC | ÷2 |
| 16-20 | 15,714 QNC | ÷2 |
| **20-24** | **1,571 QNC** | **÷10 (sharp drop)** |
| 24+ | Resume ÷2 | Normal halving |

### Grace Period

**3-minute grace period** before marking nodes offline:

- Accounts for network latency
- Prevents false negatives from temporary disconnects
- Applied to both Light attestations and Full/Super heartbeats

### Storage (RocksDB)

| Data Type | Column Family | Retention |
|-----------|---------------|-----------|
| Microblocks | `microblocks` | Sliding window (100K) |
| Macroblocks | `macroblocks` | Full history |
| Transactions | `transactions` | Pruned after macroblock |
| **VTS State** | `poh_state` | Full history |
| Light attestations | `attestations` | 4 hours + 1 window buffer |
| Full/Super heartbeats | `heartbeats` | 4 hours + 1 window buffer |
| Pending rewards | `pending_rewards` | Until claimed |
| Reputation history | `reputation_history` | 30 days |

#### VTS State Storage (v2.19.13)

**Architecture**: VTS state is stored **separately** from blocks for O(1) validation.

```rust
pub struct VTSState {
    pub height: u64,           // Block height
    pub poh_hash: Vec<u8>,     // SHA3-512 hash (64 bytes)
    pub poh_count: u64,        // Monotonic counter
    pub previous_hash: [u8; 32], // Chain linkage
}
```

**Benefits**:
- ✅ O(1) VTS validation (no block deserialization)
- ✅ Format-agnostic (works with MicroBlock, EfficientMicroBlock)
- ✅ Backward compatible (auto-migration from existing blocks)
- ✅ Minimal overhead (~112 bytes/block = ~3.5 GB/year)

**Migration**: On node startup, `migrate_all_poh_states()` extracts VTS data from existing blocks.

### Storage Optimization & Pruning (v2.19.7)

**Node-Specific Storage Requirements:**

| Node Type | Storage | Data Stored |
|-----------|---------|-------------|
| **Light** | **50-100 MB** | Headers only, NO blocks/transactions |
| **Full** | ~50 GB | Sliding window (100K blocks) + snapshots |
| **Super** | 400+ GB | Full history with archival |

**Pruning System (production):**

```rust
// Block pruning - removes old microblocks/macroblocks
pub fn prune_old_blocks(&self, keep_blocks: u64) -> Result<u64>

// Transaction pruning (v2.19.7) - removes old TX data
pub fn prune_old_transactions(&self, prune_before_height: u64) -> Result<u64>
// Cleans: transactions, tx_index, tx_by_address Column Families

// Microblock pruning after macroblock finalization
pub fn prune_finalized_microblocks(&self, macroblock_height: u64) -> Result<u64>

// Snapshot cleanup - keeps only last 5 snapshots
pub fn cleanup_old_snapshots(&self) -> Result<u64>
```

**Storage Savings with Transaction Pruning:**

| Component | Without Pruning | With Pruning | Savings |
|-----------|-----------------|--------------|---------|
| transactions CF | ∞ (grows forever) | ~200 GB | 90%+ |
| tx_index CF | ∞ (grows forever) | ~20 GB | 90%+ |
| tx_by_address CF | ∞ (grows forever) | ~40 GB | 90%+ |
| **Total** | **2+ TB/year** | **~260 GB** | **~87%** |

**Snapshot System:**
- Full state snapshots every 12 hours
- Incremental snapshots every 1 hour
- Zstd-15 compression (~70% reduction)
- SHA3-256 integrity verification
- Auto-cleanup: keeps last 5 snapshots only

### Scalability

| Metric | Value | Notes |
|--------|-------|-------|
| Max Light nodes | 25.6M | 256 shards × 100K per shard |
| Attestations per window | 240K+ | 1M Light nodes × 1 ping × 24% online |
| Merkle tree depth | ~18 levels | log2(240K) |
| Sample size | 1% (min 10K) | Statistically valid |
| On-chain commitment | ~100 MB | vs 36 GB individual attestations |

---

## MEV Protection & Priority Mempool

### Architecture Overview

QNet implements **dual-layer transaction processing** to prevent MEV (Maximal Extractable Value) exploitation while maintaining public transaction throughput:

```
┌─────────────────────────────────────────────────────────────┐
│ MEMPOOL ARCHITECTURE (v2.19.3)                              │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────────┐         ┌──────────────────┐          │
│  │ Public Mempool  │         │  MEV Mempool     │          │
│  │                 │         │  (Private        │          │
│  │ Priority Queue  │         │   Bundles)       │          │
│  │ by gas_price    │         │                  │          │
│  └────────┬────────┘         └────────┬─────────┘          │
│           │                           │                     │
│           │                           │                     │
│           ▼                           ▼                     │
│  ┌────────────────────────────────────────────┐            │
│  │       Block Producer                       │            │
│  │  ┌──────────────────────────────────────┐  │            │
│  │  │ Dynamic Allocation (per microblock): │  │            │
│  │  │ • 0-20%: MEV bundles (if demand)     │  │            │
│  │  │ • 80-100%: Public TXs (guaranteed)   │  │            │
│  │  └──────────────────────────────────────┘  │            │
│  └────────────────────┬───────────────────────┘            │
│                       │                                     │
│                       ▼                                     │
│              ┌────────────────┐                             │
│              │  Microblock    │                             │
│              │  (1 second)    │                             │
│              └────────────────┘                             │
└─────────────────────────────────────────────────────────────┘
```

### Priority Mempool (Public Transactions)

**Implementation**: BTreeMap-based priority queue

```rust
pub struct SimpleMempool {
    by_gas_price: BTreeMap<u64, VecDeque<String>>,  // Priority queue
    transactions: DashMap<String, TxStorage>,        // Fast lookup
}
```

**Features**:
- ✅ **Gas-Price Ordering**: Highest gas price processed first
- ✅ **Anti-Spam Protection**: Low-gas TXs cannot block high-value TXs
- ✅ **FIFO within Same Price**: Fair ordering for identical gas prices
- ✅ **O(log n) Insertion**: Efficient priority queue operations
- ✅ **Binary + JSON Support**: Flexible storage formats

**Algorithm**:
```rust
// Get pending transactions (HIGHEST gas_price first)
priority_queue.iter()
    .rev()  // Reverse iteration: highest → lowest
    .flat_map(|(gas_price, txs)| txs.iter())
    .take(limit)
```

### MEV Protection (Private Bundles)

**Architecture**: Flashbots-style private submission

```rust
pub struct TxBundle {
    bundle_id: String,
    transactions: Vec<String>,      // TX hashes (max 10)
    min_timestamp: u64,             // Earliest inclusion time
    max_timestamp: u64,             // Latest inclusion time (max 60s)
    reverting_tx_hashes: Vec<String>,  // TXs that must NOT be included
    signature: Vec<u8>,             // Dilithium3 signature
    submitter_pubkey: Vec<u8>,      // Submitter identity
    total_gas_price: u64,           // Bundle priority
}
```

**Constraints (Production Tested)**:

| Constraint | Value | Enforcement | Purpose |
|------------|-------|-------------|---------|
| Max TXs per Bundle | 10 | Rejected at submission | Prevent block space monopolization |
| Reputation Gate | 80%+ | Checked via P2P layer | Proven trustworthy nodes only |
| Gas Premium | +20% | Validated per TX | Economic incentive for inclusion |
| Max Lifetime | 60 seconds | Time window check | Prevent stale bundles (60 microblocks) |
| Rate Limiting | 10 bundles/min | Per-user counter | Anti-spam protection |
| Block Allocation | 0-20% dynamic | Calculated per block | 80-100% guaranteed for public TXs |
| Signature | Dilithium3 | Post-quantum verification | Byzantine-safe authentication |

**Dynamic Allocation Algorithm**:

```rust
// Calculate bundle demand
let total_bundle_txs: usize = valid_bundles.iter()
    .map(|b| b.transactions.len())
    .sum();

// Calculate demand as % of block
let demand_ratio = total_bundle_txs as f64 / max_txs_per_block as f64;

// Apply dynamic allocation with cap
let allocation_ratio = if demand_ratio <= 0.0 {
    0.0  // No bundles → 0% allocation → 100% public TXs
} else if demand_ratio <= 0.20 {
    demand_ratio  // Use actual demand (0-20%)
} else {
    0.20  // Cap at maximum (20%)
};
```

**Block Building Process**:

```
STEP 1: Dynamic Bundle Allocation (0-20%)
├── Get valid bundles (time window + reputation check)
├── Calculate demand ratio
├── Apply dynamic allocation (cap at 20%)
└── Include bundles atomically (all TXs or none)

STEP 2: Public Mempool (fill remaining 80-100%)
├── Get high-priority TXs (highest gas_price first)
├── Fill remaining block space
└── Guarantee minimum 80% for public TXs

RESULT: Balanced block composition
├── 0-20% MEV-protected bundles (optional, based on demand)
├── 80-100% public transactions (guaranteed throughput)
└── Total: 100% block utilization
```

### API Endpoints

**Bundle Submission**:
```bash
POST /api/v1/bundle/submit
Content-Type: application/json

{
  "bundle_id": "bundle_12345",
  "transactions": ["tx_hash_1", "tx_hash_2"],
  "min_timestamp": 1700000000,
  "max_timestamp": 1700000060,
  "reverting_tx_hashes": [],
  "signature": "base64_dilithium_signature",
  "submitter_pubkey": "base64_public_key",
  "total_gas_price": 500000
}
```

**Bundle Status**:
```bash
GET /api/v1/bundle/{bundle_id}/status

Response:
{
  "bundle_id": "bundle_12345",
  "status": "pending" | "included" | "expired" | "rejected",
  "included_in_block": 12345 (if included),
  "rejection_reason": "..." (if rejected)
}
```

**Bundle Cancellation**:
```bash
DELETE /api/v1/bundle/{bundle_id}
```

### Security Properties

**Byzantine Safety**:
- ✅ **Post-Quantum Signatures**: All bundles verified with Dilithium3
- ✅ **Reputation Gate**: Only 80%+ reputation nodes can submit
- ✅ **Multi-Producer Submission**: 3 producers for redundancy
- ✅ **Atomic Inclusion**: All bundle TXs verified before inclusion
- ✅ **Public TX Protection**: 80-100% guaranteed allocation

**Economic Incentives**:
- ✅ **Gas Premium**: +20% payment for bundle inclusion
- ✅ **Priority Queue**: Bundles compete by total_gas_price
- ✅ **Rate Limiting**: Prevents spam from single users
- ✅ **Auto-Fallback**: Failed bundles → public mempool

**Scalability**:
- ✅ **Light Nodes**: NOT affected (don't produce blocks)
- ✅ **Full Nodes**: Can submit bundles if reputation ≥80%
- ✅ **Super Nodes**: Full MEV protection capabilities
- ✅ **Lock-Free**: DashMap for concurrent bundle operations

### Testing & Validation

**Production Test Suite (11/11 Passed)** ✅:
1. ✅ Bundle size validation (empty/oversized rejected)
2. ✅ Reputation check (70% rejected, 80%+ accepted)
3. ✅ Time window validation (max 60s enforced)
4. ✅ Gas premium validation (+20% required)
5. ✅ Rate limiting (10 bundles/min per user)
6. ✅ Bundle priority queue (by total_gas_price)
7. ✅ Dynamic allocation (0-20% based on demand)
8. ✅ Bundle validity check (time window enforcement)
9. ✅ Bundle cleanup (expired bundles removed)
10. ✅ Config defaults (all values correct)
11. ✅ Priority mempool integration (highest gas first)

**Real-World Validation**:
- ✅ Reputation gate: default 70% → rejected (no bypass!)
- ✅ Priority ordering: 500k → 200k → 100k gas_price
- ✅ Dynamic allocation: 0% (no demand) → 100% public TXs
- ✅ Bundle lifetime: 60s = 60 microblocks < 90s macroblock

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
│  6. Verifiable Time Sequence verification                       │
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
│  4. Verifiable Time Sequence entropy                            │
│  → MALICIOUS BLOCKS CANNOT REACH CONSENSUS THRESHOLD    │
└─────────────────────────────────────────────────────────┘
```

### NIST/Cisco Compliance (v2.19.22)

#### Hybrid Signature Architecture (CRITICAL)

Per **NIST SP 800-208** and **Cisco Post-Quantum Recommendations**:

```
┌─────────────────────────────────────────────────────────────────────┐
│ EVERY MESSAGE uses:                                                 │
│   1. NEW ephemeral Ed25519 key (generated per message)             │
│   2. Dilithium signs: ephemeral_key || message_hash || timestamp   │
│   3. Dilithium signs: message_hash (independent verification)      │
├─────────────────────────────────────────────────────────────────────┤
│ WHY EPHEMERAL KEYS?                                                 │
│   • Forward secrecy: compromise one message ≠ compromise all       │
│   • Key binding: Dilithium cryptographically binds ephemeral key   │
│   • Quantum resistance: Ed25519 broken? Dilithium still protects!  │
└─────────────────────────────────────────────────────────────────────┘
```

#### Post-Quantum Cryptography
- **Algorithm**: CRYSTALS-Dilithium (NIST FIPS 204 / ML-DSA)
- **Security Level**: Dilithium3 (Level 3)
- **Key Size**: 1952 bytes (public), 4000 bytes (private)
- **Signature Size**: ~2420 bytes
- **Security**: Resistant to Shor's algorithm (quantum attacks)
- **Usage**: Signs BOTH ephemeral key binding AND message hash

#### Classical Cryptography  
- **Algorithm**: Ed25519 (Curve25519)
- **Security Level**: 128-bit security
- **Key Size**: 32 bytes (public), 64 bytes (private)
- **Signature Size**: 64 bytes
- **Purpose**: Fast verification, EPHEMERAL keys per message
- **CRITICAL**: Ed25519 keys are NOT reused between messages!

#### Hashing
- **Algorithm**: SHA3-256 (NIST FIPS 202) - quantum-resistant
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
**Protection**: Enforces 4.5-minute certificate lifetime (optimal quantum resistance)

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
| **Disk Persistence** | 0 | 2,000 certs (9 min) | Fast recovery |
| **Lifetime** | N/A | 4.5 min (270s) | Automatic rotation at 80% (216s) |
| **TTL** | N/A | 9 min cache (540s) | 2× lifetime grace period |

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
| **With Sharding (10 shards)** | 1,000,000 TPS | 10 shards × 100K tx/sec |
| **Theoretical Max (256 shards)** | 25,600,000 TPS | v2.64: 100K per shard |

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
| **VTS (hash + count)** | 72 bytes | Every block |
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
| **Full Hybrid Signature v2.23** | ~5 KB | Every 90 blocks |
| **Validator Signatures (1000)** | ~2.6 MB | 1000 × ~2.6KB (v2.23) |
| **Total per Macroblock** | ~2.6 MB | Every 90 seconds |

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
| **Rotation Broadcast** | 80% lifetime (216 seconds) |
| **Cache Size** | 100,000 certificates |
| **Eviction Policy** | LRU (Least Recently Used) |
| **Certificate Lifetime** | 4.5 minutes (270 seconds = 3 macroblocks) |
| **Rotation Threshold** | 80% of lifetime (216 seconds) |
| **Grace Period** | 54 seconds (sufficient for global propagation) |
| **Anti-Duplication** | Serial number change detection |

**Adaptive Broadcast Intervals** (based on node uptime):
- **10 seconds**: First 2 minutes (0-120s) - critical initial propagation
- **30 seconds**: Minutes 2-5 (120-300s) - covers 1+ certificate lifetime
- **120 seconds**: After 5 minutes (300s+) - maintenance mode (~50% of lifetime)

**Network Load** (1000 validators):
- Tracked broadcasts (rotations): 1000 × 1 cert/hour = ~0.3 broadcasts/sec
- Periodic broadcasts (adaptive): ~40 broadcasts/min average
- **Total bandwidth**: 200 KB/min = ~27 Kbps (minimal overhead)

---

## Production Deployment

### Sharding vs Storage Architecture

**IMPORTANT**: QNet uses **Transaction/Compute Sharding** for parallel processing, NOT State Sharding for storage division.

```
┌─────────────────────────────────────────────────────────────────┐
│                    QNET ARCHITECTURE                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  SHARDING = Parallel transaction PROCESSING (CPU cores)         │
│  - Transactions distributed across shards for parallel execution│
│  - 1 shard ≈ 100,000 TPS (v2.64: increased from 10K)            │
│  - Dynamic scaling: 1-256 shards based on network size          │
│                                                                  │
│  STORAGE = Tiered by node type (Light/Full/Super)               │
│  - ALL nodes receive ALL blocks via P2P broadcast               │
│  - Storage differs by WHAT is kept and for HOW LONG             │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Tiered Storage Model

| Node Type | What is Stored | Pruning | Max Storage |
|-----------|----------------|---------|-------------|
| **Light** | Block headers only | Last 1,000 blocks | ~100 MB |
| **Full** | Full blocks | Last 30 days | ~500 GB |
| **Super/Bootstrap** | Full history | Never | ~2 TB |

### Minimum Requirements

#### Light Node
- **CPU**: 1 core (2 GHz)
- **RAM**: 512 MB
- **Storage**: 100 MB SSD (headers only)
- **Bandwidth**: 1 Mbps
- **Use case**: Mobile wallets, IoT devices

#### Full Node
- **CPU**: 4 cores (2.4 GHz)
- **RAM**: 8 GB
- **Storage**: 500 GB SSD (30 days history)
- **Bandwidth**: 10 Mbps
- **Use case**: Desktop/server nodes, consensus participation

#### Super/Bootstrap Node
- **CPU**: 8 cores (2.4 GHz+)
- **RAM**: 16 GB
- **Storage**: 2 TB NVMe SSD (full history)
- **Bandwidth**: 100 Mbps
- **Use case**: Network backbone, historical data serving

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

QNet v2.23 implements a production-ready, post-quantum secure blockchain with:

✅ **Compact signatures v2.23**: 88% bandwidth reduction (~2.6KB RAW bytes)  
✅ **Defense-in-depth**: Real Dilithium verification at P2P + Consensus layers  
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

### v2.19.14 (November 28, 2025)

**Fork Resolution Simplification:**
- Removed complex Byzantine weight calculation (calculate_fork_chain_weight, calculate_our_chain_weight)
- Removed unused perform_chain_reorganization method (~250 lines of dead code)
- Simplified fork resolution to three clear cases:
  - Network ahead: rollback + sync
  - Same height: resync if ≥3 high-rep validators connected
  - We're ahead: keep our chain
- Added MIN_PEERS_FOR_RESYNC = 3 threshold for same-height fork decisions

**Security Enhancements:**
- Reputation manipulation detection in ActiveNodeAnnouncement handler
- Escalating punishment for reputation inflation/deflation (1h → 1d → 1w → 1y ban)
- Empty response attack protection (5 empty responses = -5% reputation)
- Consensus message timestamp validation (±5 minutes tolerance)
- Consensus signature format pre-validation
- Dual peer lookup (DashMap + RwLock fallback) for Genesis nodes

**P2P Improvements:**
- Fixed Genesis node peer discovery (check both connected_peers_lockfree and connected_peers)
- Added else branch for empty peers during P2P initialization

---

### v2.19.4 (November 25, 2025)

**Reward System Complete Implementation:**
- Implemented sharded ping system (256 shards) for Light node pinging
- Added deterministic pinger selection algorithm
- Light node attestations with dual Dilithium signatures
- Full/Super node heartbeats (10 per 4-hour window)
- Grace period (3 minutes) before marking nodes offline
- Lazy rewards accumulation for all node types
- Parallel Merkle hashing with rayon

**P2P & Gossip Enhancements:**
- Light node registry gossip synchronization
- Full/Super node registration gossip on API calls
- Active node announcements broadcast
- System events P2P broadcast (reorg, etc.)
- LRU eviction for scalability (100K Light nodes max per shard)

**Storage Improvements:**
- Attestations persistence in RocksDB
- Heartbeats persistence in RocksDB
- Pending rewards persistence
- Transaction indexing by address (tx_by_address CF)
- Reputation history storage and cleanup

**FCM V1 API Migration:**
- Migrated from legacy FCM to V1 API
- OAuth2 authentication with Service Account JSON
- Access token caching (55 min TTL)
- Rate limiting (500 req/sec)
- Only Genesis nodes send FCM notifications

**Mobile Integration:**
- Firebase SDK integration (iOS + Android)
- FCM message handling for ping challenges
- Ping response with Ed25519 signature
- Token refresh and registration

---

## Network Ports

### Required Ports

| Port | Protocol | Purpose | Firewall |
|------|----------|---------|----------|
| **9876** | TCP | P2P network (peer discovery, legacy) | REQUIRED |
| **9877** | TCP | P2P gossip (reputation sync) | REQUIRED |
| **8001** | TCP | REST API (JSON-RPC, monitoring) | REQUIRED |
| **10876** | UDP/QUIC | QUIC transport (blocks, consensus) | **REQUIRED v2.19.22+** |

### QUIC Transport (v2.19.22+)

QNet uses QUIC for high-performance P2P communication:

```
QUIC Port = 10876 (fixed for all nodes)
Docker: -p 10876:10876/udp
```

**Note:** Internal offset calculation: API port (8001) + 2875 = 10876

**Features:**
- TLS 1.3 encryption (NIST SP 800-52 compliant)
- Binary protocol (bincode) - 50% less bandwidth than JSON
- Connection multiplexing (100 streams per connection)
- Keep-alive: 30s, Idle timeout: 90s

**Messages via QUIC:**
- Block broadcast (micro/macro)
- Genesis block distribution
- Shred Protocol chunks
- Certificate announcements
- Consensus commit/reveal

**Messages via HTTP (REST API):**
- Security alerts
- Audit storage
- External client queries

---

**Fixes:**
- Light node reputation fixed at 70 (immutable by design)
- Removed all TODO/placeholder comments
- Mempool error conversion implemented
- Certificate request via P2P
- Activation phase real logic (not placeholder)

---

### v2.19.1 (November 22, 2025)

**Certificate Broadcasting Enhancements:**
- Added tracked broadcast with Byzantine 2/3+ threshold for critical certificate rotations
- Implemented adaptive timeout (3s/5s/10s) based on network size to avoid Adaptive BFT conflicts
- Added anti-duplication protection via serial number change detection
- Updated periodic broadcast to adaptive intervals (10s/30s/120s based on node uptime)
- Reduced certificate lifetime from 1 hour to 4.5 minutes (optimal quantum protection)
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

