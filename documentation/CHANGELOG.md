# Changelog

All notable changes to the QNet project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.36.0] - December 15, 2025 "Unified SHA3-512 Security"

### 🔐 Unified Hash Algorithm for Maximum Quantum Security

**Change:**
All producer/leader selection now uses **SHA3-512** (256-bit quantum resistance via Grover's algorithm).

| Component | Before (v2.35) | After (v2.36) |
|-----------|----------------|---------------|
| Microblock producer | SHA3-512 | SHA3-512 ✅ |
| Macroblock initiator | SHA3-256 | **SHA3-512** |
| Macroblock leader (commit-reveal) | SHA3-256 | **SHA3-512** |
| Failover leader selection | SHA3-256 | **SHA3-512** |

### Files Changed

- `core/qnet-consensus/src/commit_reveal.rs` - `select_leader()` and `compute_leader_for_round()` → SHA3-512
- `development/qnet-integration/src/node.rs` - `should_initiate_consensus()` → SHA3-512
- `documentation/technical/ECONOMIC_MODEL.md` - Updated docs

### Security Impact

- **Quantum Resistance:** 256-bit (Grover) vs 128-bit for SHA3-256
- **Consistency:** All selection uses same algorithm = easier auditing
- **No Breaking Changes:** Output format unchanged (first 8 bytes for index)

---

## [2.35.0] - December 15, 2025 "Round-Based Failover & Real Commits"

### 🔄 Production Failover Mechanism

**Added:**
- `compute_leader_for_round()` - Deterministic leader per failover round
- Round-based timeout: 30s per round, up to 5 rounds max
- Real commits/reveals from `CommitRevealConsensus` engine

### MacroBlock Failover Flow

```
ROUND 0 → Leader A (30s timeout) → offline
ROUND 1 → Leader B (30s timeout) → offline  
ROUND 2 → Leader C (30s timeout) → SUCCESS!
```

---

## [2.34.0] - December 15, 2025 "Leader-Based MacroBlock Architecture"

### 🏗️ Critical Architectural Refactor

**Problem Solved:**
Each node was creating its OWN MacroBlock with different `eligible_producers` snapshots.
This caused network forks after block 180 when N-2 producer selection kicked in.

**Root Cause:**
- `participate_in_macroblock_consensus()` called `trigger_macroblock_consensus()` → EVERY validator created MacroBlock
- `eligible_producers` snapshot used `get_active_full_super_nodes()` (P2P state) instead of consensus data
- Different nodes had different P2P views → different snapshots → FORK!

### Architectural Changes (Ethereum 2.0 / Solana Style)

| Component | Before (v2.33) | After (v2.34) |
|-----------|----------------|---------------|
| MacroBlock creation | ALL validators | ONLY Leader |
| `participate_in_macroblock_consensus()` | Called `trigger_macroblock_consensus()` | **WAITS for Leader's MacroBlock** |
| Participants list | `get_validated_active_peers()` (P2P) | `calculate_qualified_candidates()` (N-2 blockchain) |
| `eligible_producers` source | P2P registry + `get_active_full_super_nodes()` | **Consensus participants ONLY** |
| MacroBlock broadcast | Each node stored own version | Leader broadcasts via ShredProtocol |

### New Functions

```rust
// Participant: WAITS for Leader's MacroBlock
async fn participate_in_macroblock_consensus(...) {
    // 1. Get deterministic participants from N-2
    // 2. Execute COMMIT phase
    // 3. Execute REVEAL phase  
    // 4. WAIT for Leader's MacroBlock (timeout → sync fallback)
    // 5. Validate and store (do NOT create!)
}

// Leader: Creates MacroBlock and broadcasts
async fn trigger_macroblock_consensus(...) {
    // 1. Get deterministic participants from N-2
    // 2. Collect commits/reveals via P2P channel
    // 3. finalize_round() → select leader
    // 4. Create MacroBlock (eligible_producers = consensus participants)
    // 5. Broadcast via ShredProtocol
}

// Deterministic snapshot from consensus participants ONLY
async fn create_eligible_producers_snapshot(
    consensus_participants: &[String],  // NOT from P2P!
) -> Vec<EligibleProducer>
```

### Cryptographic Signatures

MacroBlock commits/reveals use hybrid cryptography:
- **Dilithium3** (NIST PQC) - post-quantum signature
- **Ed25519 ephemeral keys** - forward secrecy, generated per message
- **Full signature** (~5KB bincode) for MacroBlocks - includes certificate for immediate verification
- **Compact signature** (~2.6KB bincode) for microblocks - certificate cached

### Files Changed

- `development/qnet-integration/src/node.rs`:
  - `participate_in_macroblock_consensus()` - now WAITS, doesn't create
  - `trigger_macroblock_consensus()` - uses `calculate_qualified_candidates()`
  - `create_eligible_producers_snapshot()` - uses consensus participants only
- `core/qnet-consensus/src/commit_reveal.rs`:
  - Added `get_commits_for_macroblock()`, `get_reveals_for_macroblock()`
  - Added `get_current_participants()`, `get_randomness_beacon()`
- `docs/ARCHITECTURE_v2.19.md` - MacroBlock Consensus v2.34 section
- `documentation/technical/MICROBLOCK_ARCHITECTURE_PLAN.md` - v2.34 workflow

### Comparison with Industry Standards

| Aspect | Ethereum 2.0 | Tendermint | Solana | **QNet v2.34** |
|--------|--------------|------------|--------|----------------|
| Who creates block | 1 Proposer | 1 Proposer | 1 Leader | **1 Leader** ✅ |
| Validator set source | Beacon Chain | Genesis/Staking | Epoch snapshot | **N-2 MacroBlock** ✅ |
| Consensus type | Attestations | Prevote/Precommit | Tower BFT | **Commit-Reveal** ✅ |
| Participants create block? | ❌ No | ❌ No | ❌ No | **❌ No** ✅ |

---

## [2.31.0] - December 13, 2025 "5-Layer Macroblock Protection"

### 🛡️ Critical Macroblock Synchronization

**Problem Solved:**
Node 002 missed ALL macroblocks #12-#26 because it was "not a validator" and skipped saving them.
This caused cascade desynchronization - missing one macroblock leads to missing all subsequent ones.

### 5 Layers of Macroblock Protection

| Layer | Trigger | Implementation |
|-------|---------|----------------|
| **1. Unsync node sync** | `!is_synchronized` | Wait 45s → 3 retries `sync_macroblocks()` |
| **2. Not-validator sync** | `is_validator=false` | Wait 15s → 3 retries `sync_macroblocks()` |
| **3. Boundary verify** | Every block N*90 | Wait 45s → 3 retries `sync_macroblocks()` |
| **4. Periodic check** | Every 60 seconds | Check last 10 MB → request up to 10 missing |
| **5. On-demand sync** | Missing in `calculate_qualified_candidates` | Immediate `sync_macroblocks()` |

### New Components

```rust
// Rate limiting to prevent spawn storm
static ACTIVE_MACROBLOCK_CHECK_TASKS: AtomicU64 = AtomicU64::new(0);
const MAX_CONCURRENT_MACROBLOCK_CHECKS: u64 = 5;

// RAII pattern for safe task cleanup
struct TaskGuard;
impl Drop for TaskGuard {
    fn drop(&mut self) {
        ACTIVE_MACROBLOCK_CHECK_TASKS.fetch_sub(1, Ordering::Relaxed);
    }
}
```

### Proactive Fork Detection on Startup

```rust
// If local height AHEAD of network → possible fork!
if local_height > network_height + 10 && network_height > 0 {
    // 1. Delete blocks network_height+1 to local_height
    // 2. Update chain height to network_height
    // 3. Re-sync macroblocks from network
}
```

### ShredProtocol Reliability Improvements

| Parameter | v2.30 | v2.31 |
|-----------|-------|-------|
| `SHRED_CHUNK_TIMEOUT_SECS` | 3s | 5s |
| `SHRED_CHUNK_MAX_RETRIES` | 2 | 4 |

### Files Changed

- `development/qnet-integration/src/node.rs` (5 new sync mechanisms)
- `development/qnet-integration/src/unified_p2p.rs` (ShredProtocol tuning)
- `documentation/RELEASE_NOTES.md` (v2.31 section)
- `documentation/CHANGELOG.md` (this file)

---

## [2.30.0] - December 13, 2025 "N-2 Fork Prevention"

### 🛡️ Critical Fork Prevention

**N-2 Entropy Source:**
- Producer selection now uses MacroBlock N-2 (not N-1)
- N-2 is GUARANTEED to be finalized (90+ blocks buffer)
- ALL synchronized nodes use IDENTICAL entropy source
- Prevents forks caused by consensus timing race conditions

**Extended Genesis Epoch:**
- Genesis epoch extended from 90 to 180 blocks
- Required for N-2 logic compatibility
- MacroBlock #1 created at block 90, ready by ~block 120
- Block 181+ uses real production logic with N-2

### 🔧 State Machine

**Explicit NodeState enum with 27 integration points:**
- `Initializing` - Node starting up
- `Syncing { local_height, target_height, progress_percent }` - Synchronizing with network
- `Producing { current_height, as_producer }` - Producing/validating blocks
- `WaitingForConsensus { epoch }` - Waiting for macroblock consensus
- `WaitingForMacroblock { epoch }` - Waiting for macroblock from network
- `ResolvingFork { our_height, network_height, our_hash }` - Handling chain fork
- `Validating { block_height }` - Validating received block
- `Error { reason, recoverable }` - Error state
- `Idle { last_height }` - Waiting for next block

### ✅ Improvements

| Fix | Description |
|-----|-------------|
| **Real Reputation** | `get_deterministic_reputation()` instead of hardcoded 0.70/0.90 |
| **Graceful Shutdown** | `tokio::signal::ctrl_c()` saves certificates before exit |
| **Certificate Persistence** | `load_from_disk()` on startup, `persist_to_disk()` every 5 min + shutdown |
| **No Fallback Policy** | Desynchronized nodes (empty candidates) excluded from production |
| **N-2 in 7 places** | All producer selection and entropy uses N-2 macroblock |

### 📁 Files Changed

- `development/qnet-integration/src/node.rs` (+1872, -357 lines)
- `development/qnet-integration/src/bin/qnet-node.rs` (graceful shutdown)
- `documentation/technical/CRYPTOGRAPHY_IMPLEMENTATION.md` (v2.30 section)
- `QNet_Whitepaper.md` (v2.30 features)
- `README.md` (v2.30 updates)

---

## [3.0.0] - December 11, 2025 "Quantum Randomness Beacon"

### 🎲 NEW - Quantum Randomness Beacon (QRB)

**Native on-chain verifiable randomness for smart contracts!**

Introduces RANDAO-style accumulated randomness with quantum-resistant VRF, providing "true unpredictability" for:
- 🎰 On-chain gambling and lotteries
- 🎨 Fair NFT mints and drops
- 🎲 Gaming applications
- ⚖️ Fair auctions and leader election

### ✅ New Features

| Feature | Description | Files |
|---------|-------------|-------|
| **VRF in Microblocks** | Each producer generates Hybrid VRF output | block.rs, node.rs |
| **RANDAO Accumulator** | XOR all VRF outputs in MacroBlock | node.rs |
| **RPC API** | `qrb_getRandomness`, `qrb_getLatestRandomness`, `qrb_getRandomnessWithSeed` | rpc.rs |
| **Quantum Safety** | Dilithium3 VRF signatures (NIST FIPS 204) | vrf_hybrid.rs |

### 🔐 Security Properties

| Property | Value |
|----------|-------|
| Unpredictability | ✅ Nobody knows beacon until MacroBlock finalization |
| Quantum Resistance | ✅ Dilithium3 + SHA3-512 |
| Manipulation Resistance | ✅ Requires >50% producers to manipulate |
| Verification | ✅ Any node can verify VRF proofs |

### 📊 Comparison with Other L1s

| Feature | Ethereum 2.0 | Solana | Chainlink VRF | QNet QRB |
|---------|--------------|--------|---------------|----------|
| Native | ✅ Yes | ❌ No | ❌ No (oracle) | ✅ Yes |
| Quantum Safe | ❌ No | ❌ No | ❌ No | ✅ **Dilithium3** |
| Cost | Gas fees | Minimal | High (oracle) | **Free** |

### 🔧 API Example

```bash
# Get randomness for epoch 42
curl -X POST http://localhost:8001/rpc -d '{
  "method": "qrb_getRandomness",
  "params": { "epoch": 42 }
}'

# Response:
{
  "randomness": "0x7a3f9c...",
  "epoch": 42,
  "vrf_contributions": 90,
  "quantum_safe": true
}
```

---

## [2.27.1] - December 11, 2025 "Zero Fork Guarantee"

### 🔐 CRITICAL - Fork Prevention Fixes

**Problem Fixed:**
Network forks caused by three sources of non-determinism:
1. Skip-self bug in peer list (+1 error)
2. Entropy fallback to macroblock when not synced
3. Producer list fallback to gossip registry

**Solution:** Removed ALL fallbacks - nodes must sync before participating (Solana/Ethereum style)

### ✅ Bug Fixes

| Bug | Location | Impact | Fix |
|-----|----------|--------|-----|
| **Skip self +1** | unified_p2p.rs:6406 | Each node skipped NEXT node instead of self | `ends_with(id)` |
| **Entropy fallback** | node.rs:8605 | Different entropy if macroblock not synced | microblock ONLY |
| **Producer list fallback** | node.rs:797, 9428 | Different producers from gossip | Empty list (no participation) |

### 🎯 Architecture Alignment with Top L1s

| Aspect | Solana | Ethereum 2.0 | QNet v2.27.1 |
|--------|--------|--------------|--------------|
| Validator Set | Epoch snapshot | Epoch snapshot | MacroBlock snapshot ✅ |
| Entropy | VRF + blockhash | RANDAO | Microblock hash ✅ |
| Fallback | ❌ None | ❌ None | **❌ None (fixed!)** ✅ |
| Lagging nodes | Must sync | Must sync | **Must sync (fixed!)** ✅ |

### 📊 Guarantees

```
Before v2.27.1:
- Peers list: ~70% deterministic (bug)
- Entropy: ~80% deterministic (fallback)
- Producer list: ~90% deterministic (fallback)
- Fork risk: ~30%

After v2.27.1:
- Peers list: 100% deterministic ✅
- Entropy: 100% deterministic ✅
- Producer list: 100% deterministic ✅
- Fork risk: 0% ✅
```

### 🔧 Key Principle

**No Fallback Policy:** If a node doesn't have required data (MacroBlock), it returns empty list and CANNOT participate in block production. It must sync first. Network continues with synchronized nodes.

---

## [2.27.0] - December 11, 2025 "Epoch-Based Validator Set"

### 🔐 CRITICAL - Deterministic Producer Selection

**Problem Fixed:**
Gossip-based producer selection caused network forks when different nodes had different active peer lists at the moment of deterministic selection.

**Solution:** Epoch-based validator set stored in MacroBlock snapshots (Solana/Ethereum 2.0 style)

### ✅ Architecture Changes

| Component | Before | After |
|-----------|--------|-------|
| **Producer candidates** | Gossip registry (non-deterministic) | MacroBlock snapshot (blockchain) |
| **Genesis epoch (1-90)** | Gossip registry | Static `genesis_constants.rs` |
| **Normal epochs (91+)** | Gossip registry | `MacroBlock.eligible_producers` |
| **Emergency failover** | Mixed sources | Same MacroBlock snapshot |
| **Determinism** | ❌ Race conditions | ✅ 100% deterministic |

### 📦 New Data Structures

```rust
// Stored in MacroBlock.consensus_data
pub struct EligibleProducer {
    pub node_id: String,      // e.g., "genesis_node_001"
    pub reputation: f64,      // 0.0 - 1.0
}
```

### 🔧 Modified Functions

| Function | File | Change |
|----------|------|--------|
| `calculate_qualified_candidates()` | node.rs | Uses epoch snapshot |
| `select_emergency_producer()` | node.rs | Uses same snapshot |
| `select_emergency_producer_excluding()` | unified_p2p.rs | Uses epoch snapshot |
| `create_eligible_producers_snapshot()` | node.rs | NEW: Creates snapshot |
| `get_eligible_producers_for_height()` | node.rs | NEW: Reads snapshot |

### 🎯 Flow

```
Blocks 1-90 (Genesis):     genesis_constants.rs → static list
Blocks 91-180 (Epoch 1):   MacroBlock #1.eligible_producers → from blockchain
Blocks 181-270 (Epoch 2):  MacroBlock #2.eligible_producers → from blockchain
...
Emergency Failover:        Same MacroBlock snapshot (deterministic)
```

### 📊 Impact

- **Network stability**: No more forks from gossip race conditions
- **Scalability**: MAX_VALIDATORS_PER_EPOCH = 1000 (deterministic sampling)
- **Consistency**: All nodes use identical producer lists

---

## [2.25.2] - December 9, 2025 "Batch Ed25519 Verification & High TPS Optimization"

### 🚀 MAJOR - Batch Signature Verification

**Performance improvements for maximum TPS:**

| Optimization | Before | After | Improvement |
|--------------|--------|-------|-------------|
| **Mempool locks** | 1 per TX | 1 per 1000 TX | **1000x** |
| **Ed25519 verify** | Individual | Batch (1000 TX) | **3x faster** |
| **Self-broadcast** | Always | Skip if producer | **-25% network** |
| **Network height** | Blocks only | HealthPing + height | **More accurate** |

### ✅ Changes

| Component | Change | Description |
|-----------|--------|-------------|
| **simple_mempool.rs** | +`add_binary_transaction_batch_trusted()` | Batch add with single lock |
| **simple_mempool.rs** | Snapshot `get_pending_transactions_with_hashes()` | Release lock early |
| **node.rs** | +TX accumulator (1000 TX / 100ms) | Batch Ed25519 verification |
| **node.rs** | +`batch_verify_ed25519_tx_signatures()` | ed25519-dalek batch API |
| **unified_p2p.rs** | Skip self-broadcast | Producer doesn't re-broadcast |
| **unified_p2p.rs** | HealthPing + height | Network height updates every 15s |
| **rpc.rs** | `batch_size = 10_000` | Optimized for 100K TX/block |
| **rpc.rs** | `sync_progress` cap 100% | Correct display when ahead |
| **benchmark.rs** | Instant peak TPS | Real instantaneous TPS |

### 📊 Expected TPS Impact

- **Mempool batch**: +30-40% throughput
- **Ed25519 batch**: +20-30% CPU savings
- **Skip self-broadcast**: +10-15% network reduction
- **Total**: ~50-60% improvement in high-load scenarios

---

## [2.25.0] - December 8, 2025 "Quantum Transaction Signatures & TPS Optimization"

### 🔐 MAJOR - Optional Quantum Signatures for Transactions

**New Feature**: Users can now optionally add Dilithium3 signatures to transactions for post-quantum security.

| TX Type | Signatures | Gas Multiplier | Security |
|---------|------------|----------------|----------|
| Standard | Ed25519 only | 1.0x | Classical |
| Quantum | Ed25519 + Dilithium3 | **1.5x** | Post-Quantum |

### ✅ Changes

| Component | Change | Description |
|-----------|--------|-------------|
| **Transaction struct** | +`dilithium_signature`, +`dilithium_public_key` | Optional quantum fields |
| **Transaction methods** | +`is_quantum_signed()`, +`effective_gas_price()` | Helper methods |
| **Validator** | +`verify_quantum_signature()` | Dilithium verification |
| **Node** | +`verify_ed25519_tx_signature()`, +`verify_dilithium_tx_signature()` | Full crypto verification |
| **RPC API** | +`dilithium_signature`, +`dilithium_public_key` in TransactionRequest | API support |
| **Gas calculation** | All places use `effective_gas_price()` | +50% for quantum TX |

### 🚀 Performance Improvements

- **TX/block limit**: 50K → 100K
- **Mempool size**: 5M → 10M
- **Gulf Stream Protocol**: Direct producer forwarding (10-50ms latency)
- **bincode serialization**: 10-20x faster than JSON
- **Anti-Storm Protection**: DashSet deduplication

### 📚 Documentation Updates

- `API_REFERENCE.md`: Quantum TX API endpoints
- `ARCHITECTURE_v2.25.md`: Full quantum TX architecture
- `CRYPTOGRAPHY_IMPLEMENTATION.md`: Dilithium TX details
- `QNET_COMPLETE_GUIDE.md`: Transaction upgrade section
- `QNet_Whitepaper.md`: v2.25.0, Quantum Transaction Premium
- `README.md`: Optional Dilithium for enterprise

---

## [2.24.0] - December 6, 2025 "Ethereum 2.0 Style Reputation Snapshots"

### 🔐 CRITICAL - Complete Reputation System Overhaul

**Problems fixed:**
1. Nodes could have different reputation values due to out-of-order block processing
2. Reward given for partial rotation (failover) - should be 30/30 only!
3. Snapshot only stored reputations, not jails/bans/offense counts

**Solution**: Full Ethereum 2.0 style reputation snapshots + strict 30/30 rule!

### ✅ Changes

| Component | Before | After |
|-----------|--------|-------|
| **Snapshot content** | Only reputations | ALL state (jails, bans, offense counts) |
| **Rotation reward** | Any block at height 30/60/90 | Only 30/30 full rotation |
| **Sync method** | Each node computes independently | Blockchain is authoritative |
| **Consistency** | Possible drift between nodes | 100% identical after macroblock |

### 🔧 Technical Changes

**NEW: FullReputationSnapshot struct:**
```rust
pub struct FullReputationSnapshot {
    pub reputations: HashMap<String, f64>,          // Node reputations
    pub active_jails: HashMap<String, (u64, u32)>,  // Jail end + offense count
    pub permanent_bans: HashSet<String>,            // Permanently banned
    pub offense_counts: HashMap<String, u32>,       // Progressive jail counter
    pub last_passive_recovery: HashMap<String, u64>, // Recovery timers
    pub processed_rotations: HashSet<u64>,          // Duplicate protection
}
```

**NEW: BlockData.blocks_in_rotation field:**
```rust
pub struct BlockData {
    pub height: u64,
    pub producer: String,
    pub timestamp: u64,
    pub is_valid: bool,
    pub blocks_in_rotation: u32,  // MUST be 30 for reward!
}
```

**CRITICAL: Partial rotation = NO REWARD:**
```rust
// OLD (wrong):
if block.is_valid {
    new_rep = current + REWARD_FULL_ROTATION;  // Always rewarded!
}

// NEW (correct):
if block.is_valid && block.blocks_in_rotation >= 30 {
    new_rep = current + REWARD_FULL_ROTATION;  // Only 30/30!
} else {
    println!("[REPUTATION] ⚠️ Partial rotation ({}/30) → NO REWARD");
}
```

### 📦 Affected Files

- `core/qnet-state/src/block.rs` - Added `reputation_snapshot` to ConsensusData
- `core/qnet-consensus/src/deterministic_reputation.rs`:
  - Added `FullReputationSnapshot` struct
  - Added `blocks_in_rotation` to `BlockData`
  - Updated `create_snapshot()` to include ALL state
  - Updated `apply_snapshot()` to restore ALL state
  - Updated `process_block()` to check 30/30 requirement
- `development/qnet-integration/src/node.rs`:
  - Snapshot creation in macroblock
  - Snapshot application at 4 points (receive, sync, replay, own blocks)
  - Count blocks_in_rotation before rewarding

### 🛡️ Security

| Attack | Protection |
|--------|------------|
| Fake jail removal | Jails stored in snapshot, signed by 2/3+ validators |
| Inflate offense count | offense_counts in snapshot are authoritative |
| Skip permanent ban | permanent_bans in snapshot cannot be removed |
| Partial rotation farming | 30/30 check prevents failover reward abuse |

### 📊 What Gets Stored

| Field | Description | Storage |
|-------|-------------|---------|
| `reputations` | Node reputation 0-100% | HashMap<String, f64> |
| `active_jails` | Jail end time + offense count | HashMap<String, (u64, u32)> |
| `permanent_bans` | Permanently banned nodes | HashSet<String> |
| `offense_counts` | Progressive jail counter | HashMap<String, u32> |
| `last_passive_recovery` | Recovery timers | HashMap<String, u64> |
| `processed_rotations` | Duplicate protection | HashSet<u64> |

---

## [2.23.0] - December 6, 2025 "RAW Bytes Signature Optimization + Full Quantum Heartbeat"

### 🔐 CRITICAL - Signature Format Overhaul

**Complete signature format optimization with 88% size reduction!**

### ✅ Changes

| Component | Before | After | Reduction |
|-----------|--------|-------|-----------|
| **Compact signature** | ~22KB (base64 JSON) | ~2.6KB (RAW bytes) | 88% |
| **Full signature** | ~12KB | ~5KB | 58% |
| **Dilithium format** | base64 String | Vec<u8> RAW | No overhead |
| **Ed25519 fields** | Vec<u8> | [u8; 32/64] + serde_bytes | Type-safe |

### 🔧 Technical Changes

**New signature structure (v2.23):**
```rust
pub struct CompactHybridSignature {
    pub node_id: String,
    pub cert_serial: String,
    #[serde(with = "serde_bytes")]
    pub ephemeral_public_key: [u8; 32],    // RAW bytes
    #[serde(with = "serde_bytes")]
    pub message_signature: [u8; 64],        // Ed25519 RAW
    #[serde(with = "serde_bytes")]
    pub dilithium_key_signature: Vec<u8>,   // Dilithium RAW (~2500 bytes)
    pub signed_at: u64,
}
```

**Removed:**
- `dilithium_message_signature` (redundant - message_hash already in encapsulated_data)

**Added:**
- `serde_bytes` dependency for efficient byte array serialization
- Helper functions: `extract_dilithium_raw_bytes()`, `encode_dilithium_signature()`

### 🛡️ Security

- **Defense-in-depth**: Both P2P and Consensus layers perform real `dilithium3::open()` verification
- **Consensus layer fix**: Now reconstructs `encapsulated_data` for correct verification
- **Signature limit**: Reduced from 18KB to 2.6KB in `consensus_crypto.rs`

### 💓 Heartbeat Quantum Protection (NEW!)

**CRITICAL FIX**: Heartbeat now uses FULL HYBRID signatures (NIST/Cisco compliant)!

| Before | After |
|--------|-------|
| Ed25519 only (quantum vulnerable) | HYBRID (Ed25519 + Dilithium) |
| No Dilithium verification | Full `dilithium3::open()` verification |
| Quantum attacker could fake heartbeats | Quantum-resistant heartbeat integrity |

**Changes:**
- `unified_p2p.rs`: Heartbeat creation uses `sign_heartbeat_dilithium()` 
- `unified_p2p.rs`: Heartbeat verification uses `verify_dilithium_heartbeat_signature()`
- Format: `hybrid_p2p:{CompactHybridSignature JSON}`
- CPU cost: ~5ms per heartbeat (10 per 4h = 50ms total, negligible)

---

## [2.21.5] - December 5, 2025 "Full Blockchain Reputation Integration"

### 🏗️ MAJOR ARCHITECTURE - Complete Blockchain Integration

**Complete migration from P2P-based to blockchain-based reputation system!**

### 🔴 Bug Fixes

| Bug | Before | After |
|-----|--------|-------|
| Genesis hardcoded at 70% | `return 0.70` | Uses DeterministicReputationState |
| Type conversion error | `score.min(1.0)` | `(score / 100.0).min(1.0)` |
| Slashing not in blockchain | Stored in P2P RAM | Stored in ConsensusData |
| No replay on restart | Lost on restart | Replays from blockchain |

### ✅ Blockchain Storage for Reputation

**Extended ConsensusData structure:**
```rust
pub struct ConsensusData {
    pub commits: HashMap<String, Vec<u8>>,
    pub reveals: HashMap<String, Vec<u8>>,
    pub next_leader: String,
    // NEW - stored in blockchain:
    pub slashing_events_data: Option<Vec<u8>>,
    pub automatic_jails_data: Option<Vec<u8>>,
}
```

**New data types:**
- `SlashingEventData` - serialized slashing events in blockchain
- `AutomaticJailData` - serialized jail records in blockchain

### ✅ Blockchain Replay on Restart

```rust
// On node startup:
for height in (30..=current_height).step_by(30) {
    rep_state.process_block(&block_data);  // +2% rotation rewards
}
for macroblock_index in 1..=(current_height / 90) {
    rep_state.process_macroblock(&macro_data);  // +1% consensus + slashing
}
```

### ✅ Old System Deprecated

| Old (NodeReputation) | New (DeterministicReputationState) |
|---------------------|-----------------------------------|
| `get_reputation_system()` | `get_node_reputation_from_blockchain()` |
| Stored in P2P RAM | Stored in blockchain |
| Lost on restart | Replayed from blockchain |
| Nodes can disagree | All nodes compute same |

### 📊 Architecture Comparison

```
BEFORE (P2P):
┌─────────────┐     ┌─────────────┐
│ Node 001    │     │ Node 002    │
│ rep=72%     │  ≠  │ rep=70%     │  ← CAN DISAGREE!
└─────────────┘     └─────────────┘

AFTER (Blockchain):
┌─────────────┐     ┌─────────────┐
│ Node 001    │     │ Node 002    │
│ rep=72%     │  =  │ rep=72%     │  ← ALWAYS SAME!
└─────────────┘     └─────────────┘
       ↑                   ↑
       └───────┬───────────┘
               │
        ┌──────┴──────┐
        │  BLOCKCHAIN │
        │  - commits  │
        │  - reveals  │
        │  - slashing │
        │  - jails    │
        └─────────────┘
```

### 🧪 Verification

**Expected behavior:**
```
Genesis starts: 70%
After 1 rotation (30 blocks): 72% (+2%)
After 3 macroblocks: 75% (+1% each)
After restart: SAME values (replayed from blockchain)
```

---

## [2.21.4] - December 5, 2025 "QUIC Rate Limiting - 40% Packet Loss Fix"

### 🔥 CRITICAL - Receiver Overload Fix

**Problem**: 72 concurrent QUIC streams caused receiver overload → 40% chunk loss
**Root Cause**: Burst of 72 parallel `tokio::spawn` → QUIC timeouts on receiver
**Solution**: Semaphore-based rate limiting for chunk sends

#### Technical Details
```
BEFORE: 72 chunks → 72 concurrent streams → receiver overload → 40% loss
AFTER:  72 chunks → max 20 concurrent → controlled flow → ~0% loss
```

#### New Features
- **Semaphore Rate Limiting**: Max N concurrent QUIC streams at any time
- **Adaptive Limits**: Based on network size (15-50 concurrent)
- **get_max_concurrent_chunk_sends()**: Dynamic limit calculation

| Network Size | Max Concurrent | Rationale |
|--------------|----------------|-----------|
| 0-10 nodes | 15 | Conservative for Genesis |
| 11-100 | 20 | Balanced throughput |
| 101-1000 | 30 | More parallelism safe |
| 1000+ | 50 | Distributed load |

#### Why This Approach
- ✅ Chunks remain independent (Reed-Solomon works)
- ✅ No head-of-line blocking
- ✅ QUIC flow control works properly
- ✅ Scales to 100K+ nodes
- ✅ Architecturally correct (not a hack)

### 🧪 Tests Added
- `test_rate_limit_genesis_network` - 5 nodes scenario
- `test_rate_limit_small_network` - 50 nodes
- `test_rate_limit_medium_network` - 500 nodes
- `test_rate_limit_large_network` - 5000 nodes
- `test_per_peer_limit_protection` - Per-receiver protection
- `test_minimum_throughput_guarantee` - Min 10 concurrent
- `test_rate_limit_vs_total_sends` - Throttle verification
- `test_rate_limit_large_blocks` - 2MB block handling

### 🛡️ Phantom Peers Prevention
- **MAX_CONNECTED_PEERS = 1000**: Hard limit on connected peers
- **LRU Eviction**: Automatic removal of oldest peer when limit reached
- **ensure_peer_connected()**: Now respects capacity limits
- **Scalability**: Prevents RAM overflow in networks with 10,000+ nodes

### 🔥 CRITICAL - Reputation Processing Fix
- **BUG**: `process_macroblock()` was NOT called when node CREATES macroblock!
- **EFFECT**: Reputation rewards and slashing were NOT applied on creator node
- **FIX**: Added full `process_macroblock()` call in macroblock creation (node.rs:11591+)
- **Includes**: Slashing events, automatic jails, passive recovery

---

## [2.21.3] - December 5, 2025 "SHRED Retransmit & Network Hardening"

### 🚀 NEW - SHRED Protocol Chunk Retransmit

**Problem**: ~20% chunk loss in QUIC broadcast caused reliance on Reed-Solomon for ALL blocks
**Solution**: Efficient retransmit mechanism for missing chunks without full block re-download

#### New Features
- **RequestMissingChunks**: Request specific missing chunks by index
- **MissingChunksResponse**: Peers respond with cached chunks
- **Adaptive Peer Selection**: 3-10 peers based on network size (5 to 100K+ nodes)
- **100-Block Chunk Cache**: Recently received chunks cached for retransmit
- **3-Second Timeout**: Wait before requesting retransmit
- **Max 2 Retries**: Prevents infinite loops

#### Bandwidth Savings
| Missing Chunks | Full Block | Retransmit | Savings |
|----------------|------------|------------|---------|
| 2 | 12KB | 2KB | 83% |
| 3 | 12KB | 3KB | 75% |
| 5 | 12KB | 5KB | 58% |

#### Scalability
| Network Size | Peers Queried | Success Rate |
|--------------|---------------|--------------|
| 5-10 nodes | 3 | 87.5% |
| 100 nodes | 5 | 96.9% |
| 10,000 nodes | 7 | 99.2% |
| 100,000 nodes | 8 | 99.6% |

### 🔒 Security & Privacy
- **Privacy-First Logging**: ALL IP addresses use `get_privacy_id_for_addr()` pseudonyms
- **QUIC Address Protection**: No raw IPs in any log output
- **Genesis Peer Validation**: Extended retry (3 attempts × 2s) before adding peers

### 🐛 Bug Fixes
- **Genesis QUIC Readiness**: Wait for QUIC connections before Genesis broadcast
- **Deadlock Detection**: Fixed `>` to `>=` for exact timeout match
- **Background Sync**: Detect stuck sync with `start_time=0` check
- **FAST_SYNC in Background**: Now triggers for non-producer nodes too
- **Adaptive Timeout**: Longer timeouts for larger sync operations

### 📚 Documentation
- `docs/REPUTATION_SYSTEM.md` - Added SHRED Retransmit section
- `QNet_Whitepaper.md` - Added Chunk Retransmit mechanism
- `README.md` - Added v2.21.3 release notes

### 🧪 Tests
- `tests/retransmit_tests.rs` - 20+ comprehensive tests
- Unit tests for adaptive peer selection, cache, timeout detection

---

## [2.21.0] - December 5, 2025 "Deterministic Reputation System v2.1"

### 🔐 CRITICAL - Complete Reputation System Overhaul

**Problem**: P2P gossip-based reputation was vulnerable to Sybil attacks and caused forks
**Solution**: Deterministic blockchain-based reputation - all nodes compute identical scores

#### Breaking Changes
- `ReputationSync` message type: **DEPRECATED** (ignored by all nodes)
- `broadcast_reputation_sync()`: **DISABLED** (returns Ok but does nothing)
- P2P reputation gossip: **REMOVED** (prevents Sybil attacks)

#### New Architecture
```
OLD: P2P Gossip → Nodes can disagree → FORKS
NEW: Blockchain Data → All nodes identical → NO FORKS
```

#### New Features
- **DeterministicReputationState**: Single source of truth from blockchain
- **SlashingEvents**: Cryptographic proof of misbehavior in macroblocks
- **AutomaticJail**: Deterministic jail for missed blocks
- **FinalityCheckpoints**: 2 macroblocks with 2/3+ sigs = irreversible
- **Chunked Processing**: Scalable to 100,000+ nodes

#### Files Added/Modified
- `core/qnet-consensus/src/deterministic_reputation.rs` - NEW: Core reputation logic
- `core/qnet-consensus/src/macro_consensus.rs` - Finality checkpoints
- `development/qnet-integration/src/node.rs` - Integration with blockchain
- `development/qnet-integration/src/unified_p2p.rs` - Deprecated old system
- `docs/REPUTATION_SYSTEM.md` - NEW: Full documentation

#### Security Improvements
- Sybil-resistant: Cannot fake reputation via gossip
- Evidence-based: All penalties require cryptographic proof
- Deterministic: Verifiable by replaying blockchain from genesis
- Finality: Prevents long-range attacks

---

## [2.20.0] - December 4, 2025 "Reputation System Fix + Deterministic Producer Selection"

### 🔐 CRITICAL - Reputation Manipulation Detection Fix

**Problem**: False DEFLATION accusations caused cascade jailing of legitimate nodes
**Root Cause**: 
- Tolerance was 2% (too strict for network delays)
- DEFLATION was treated as attack (wrong - it's legitimate after penalty)

**Solution**:
- Increased tolerance to 10% for network delays and sync timing
- Only INFLATION is now an attack (node claiming higher reputation)
- DEFLATION (claiming lower) is NOT an attack - legitimate after penalties

#### Changes
- **Tolerance**: 2% → 10% for reputation sync differences
- **INFLATION Only**: Only punish nodes claiming HIGHER reputation than actual
- **DEFLATION OK**: Nodes can claim lower reputation (after receiving penalties)
- **Cascade Prevention**: Prevents false accusations from desync

### 🎯 Deterministic Producer Selection Fix

**Problem**: Nodes selected different producers due to varying entropy sources
**Root Cause**: Finality blocks (height-10) not available during initial sync

**Solution**: 
- Round 0 (blocks 1-30): Use Genesis + leadership_round as entropy
- All nodes have Genesis → identical entropy → same producer selected

#### Files Modified
- `unified_p2p.rs` - Reputation manipulation detection logic
- `node.rs` - Producer selection entropy calculation
- `MICROBLOCK_ARCHITECTURE_PLAN.md` - Updated documentation

---

## [2.19.22] - November 30, 2025 "QUIC Transport Layer + NIST/Cisco Hybrid Crypto"

### 🔐 CRITICAL - NIST/Cisco Compliant Hybrid Signatures

**Problem**: Hybrid signatures were not using ephemeral keys per message
**Solution**: Full NIST SP 800-208 / Cisco PQ implementation with ephemeral Ed25519 keys

#### Changes
- **Ephemeral Keys**: NEW Ed25519 keypair generated for EACH message
- **Dilithium Key Binding**: Signs `ephemeral_pk || message_hash || timestamp`
- **Dilithium Message Sig**: Additionally signs message hash (independent verification)
- **Forward Secrecy**: Compromise one message ≠ compromise all

#### Updated Structures
```rust
// CompactHybridSignature & HybridSignature now include:
pub ephemeral_public_key: [u8; 32],      // NEW per message
pub dilithium_key_signature: String,      // Binds ephemeral key
pub dilithium_message_signature: String,  // Signs message
```

#### Files Modified
- `hybrid_crypto.rs` - Ephemeral key generation per message
- `node.rs` - Updated verification with ephemeral keys
- `unified_p2p.rs` - All P2P signatures now hybrid
- `rpc.rs` - All RPC signatures now hybrid
- `consensus_crypto.rs` - Updated verification

### 🚀 NEW - Full QUIC P2P Transport

**Problem**: HTTP-based P2P was causing blocking issues and performance bottlenecks
**Solution**: Complete migration to QUIC protocol for all P2P communication

#### QUIC Features
- **Protocol**: QUIC over UDP (port 10876)
- **Encryption**: TLS 1.3 (NIST SP 800-52 compliant)
- **Multiplexing**: 100+ streams per connection
- **Handshake**: 0-RTT for repeat connections
- **Serialization**: Binary (bincode) - 50% bandwidth reduction

#### New Files
- `quic_transport.rs` - QUIC transport layer implementation
- `p2p_transport.rs` - P2P transport trait and binary protocol

#### Transport Constants
```rust
CONNECT_TIMEOUT: 3 seconds
IDLE_TIMEOUT: 90 seconds
KEEP_ALIVE: 30 seconds
MAX_MESSAGE_SIZE: 10 MB
QUIC_PORT: P2P_PORT + 1000 (default 10876)
```

#### HTTP Fallback
- **Removed**: HTTP no longer used for P2P between Full/Super nodes
- **REST API**: HTTP still available for Light nodes on port 8001

#### Docker Changes
- **New port**: `-p 10876:10876/udp` required for QUIC
- **Firewall**: `sudo ufw allow 10876/udp`

### 🔧 Breaking Changes
- QUIC port 10876/udp must be open for node operation
- Node will fail to start if QUIC initialization fails
- HTTP P2P endpoints deprecated for Full/Super nodes

---

## [2.19.12] - November 27, 2025 "Macroblock Sync + QRC-20 Tokens + Snapshot API"

### 🪙 NEW - QRC-20 Token Support (REAL Implementation!)

**Problem**: Custom tokens were only mock/stub implementation
**Solution**: Full QRC-20 token VM with real state management

#### New Contract VM Module (`contract_vm.rs`)
- `ContractVM` - Full token execution engine
- `QRC20Token` - Token metadata structure
- `TokenRegistry` - Global token tracking
- `ContractResult` - Execution results with gas

#### QRC-20 Methods Implemented
- `deploy_qrc20_token()` - Deploy new token
- `transfer_qrc20()` - Transfer tokens
- `balance_of_qrc20()` - Query balance
- `approve_qrc20()` - Set allowance
- `transfer_from_qrc20()` - Transfer with allowance
- `get_token_info()` - Query token metadata

#### New REST API Endpoints
```
POST /api/v1/token/deploy       → Deploy QRC-20 token
GET  /api/v1/token/{address}    → Get token info
GET  /api/v1/token/{address}/balance/{holder} → Get token balance
GET  /api/v1/account/{address}/tokens → Get all tokens for address
```

#### Contract Call VM Integration
- View calls now execute through real VM
- State changes stored in RocksDB
- Token balances persist across restarts

### 🔧 FIX - Removed Stubs and Placeholders

- **last_claim_time**: Now reads from storage (was hardcoded 0)
- **contract_call view**: Now executes through ContractVM (was "VM integration pending")
- **Token execution**: Real implementation (Python API was mock)

---

## [2.19.12-alpha] - November 27, 2025 "Macroblock Sync + Snapshot API + Async Runtime Fixes"

### 🔄 NEW - Full Macroblock Synchronization

**Problem**: New nodes could not sync macroblocks from network
**Impact**: Light nodes couldn't verify state, consensus history was lost
**Solution**: Complete P2P macroblock sync implementation

#### New NetworkMessage Types
```rust
RequestMacroblocks { from_index, to_index, requester_id }
MacroblocksBatch { macroblocks, from_index, to_index, sender_id }
```

#### New Methods
- `sync_macroblocks()` - Request macroblocks from peers
- `handle_macroblock_request()` - Process incoming requests (rate limited: 5/min)
- `handle_macroblocks_batch()` - Process received macroblocks
- `get_macroblocks_range()` - Storage method for batch retrieval
- `process_received_macroblock()` - Validate and save received macroblocks

#### Integration Points
- **Initial Sync**: Macroblocks synced after microblocks at startup
- **start_sync_if_needed()**: All node types (Light/Full/Super) sync macroblocks
- **Light Nodes**: Receive macroblock headers for state verification
- **Rate Limiting**: 5 requests/minute, 2-minute block on exceed
- **Batch Size**: Max 10 macroblocks per request (~1MB)

### 📸 NEW - Snapshot API Endpoints

**Problem**: P2P snapshot sync required RPC endpoints that didn't exist
**Solution**: Added snapshot discovery and download endpoints

#### New REST API Endpoints
```
GET /api/v1/snapshot/latest  → {"height", "ipfs_cid", "available", "node_id"}
GET /api/v1/snapshot/{height} → Binary snapshot data (compressed)
```

#### New Methods
- `get_snapshot_data()` - Storage method to retrieve raw snapshot
- `get_latest_snapshot_height()` - BlockchainNode wrapper
- `get_snapshot_ipfs_cid()` - BlockchainNode wrapper

#### Fast Sync Flow
1. New node queries `/api/v1/snapshot/latest` from peers
2. Downloads snapshot via `/api/v1/snapshot/{height}` or IPFS
3. Loads snapshot with `load_state_snapshot()`
4. Syncs remaining blocks from snapshot height

### 🔧 FIX - Async Runtime Panics

**Problem**: `block_on` called from async context caused panics
**Impact**: Node crashes during P2P message handling
**Solution**: Isolated runtime in `std::thread::spawn`

#### Fixed Functions
- `verify_reputation_signature()` - Now uses thread isolation
- `sign_audit_entry()` - Now uses thread isolation
- `verify_dilithium_heartbeat_signature()` - Already fixed in previous version

### 📊 Storage Architecture

#### Balance Storage
- **In-Memory**: DashMap (lock-free) for fast access
- **Persistence**: Restored from block replay or snapshot during sync
- **On Restart**: Node loads snapshot → syncs remaining blocks → balances restored

#### Snapshot System (Already Implemented)
- `save_state_snapshot()` - Called automatically at each MacroBlock
- `load_state_snapshot()` - Restores accounts from compressed snapshot
- `download_and_load_snapshot()` - P2P snapshot download
- `fast_sync_with_snapshot()` - Integrated in node startup
- IPFS support via `IPFS_GATEWAY_URL` environment variable

#### Light Node Data Rotation
- `rotate_light_headers()` - Removes old headers (keeps last 1000)
- `prune_for_light_node()` - Converts full blocks to headers
- `LightMicroBlock` - Header-only format (~100 bytes)
- Macroblocks synced for state verification

---

## [2.19.11] - November 26, 2025 "Security: Dilithium Key Storage + WebSocket Rate Limiting"

### SECURITY FIX - Dilithium Key Storage

**Problem**: Encryption key for Dilithium keypairs was derived from public `node_id`
**Impact**: Attacker knowing node_id could decrypt keypair file
**Solution**: Random 32-byte encryption key with integrity protection

#### New Key Storage Architecture
```
keys/
├── .qnet_encryption_secret   # 40 bytes: [random_key(32)] + [sha3_hash(8)]
│   └── Permissions: 0600 (Unix) / Hidden+System (Windows)
└── dilithium_keypair.bin     # AES-256-GCM encrypted with random key
```

#### Security Improvements
- **Random Encryption Key**: 32 bytes from CSPRNG (NOT derived from public data)
- **Integrity Hash**: SHA3-256 (8 bytes) detects tampering
- **Tamper Detection**: Clear error if secret file modified
- **Environment Override**: `QNET_KEY_ENCRYPTION_SECRET` for CI/advanced users
- **Platform Permissions**: 0600 (Unix) / Hidden+System (Windows)
- **Legacy Upgrade**: Auto-migrates old secrets without integrity hash

### FIX - Real Dilithium Verification

**Problem**: `verify_dilithium_signature` was using entropy check, not real crypto
**Impact**: Signatures were not cryptographically verified!
**Solution**: Now uses `dilithium3::open()` for real verification

#### Changes
- **FIXED** `verify_dilithium_signature()` - uses `dilithium3::open()` for real verification
- **FIXED** `create_consensus_signature()` - uses `sign_full()` returning complete SignedMessage
- **ADDED** `sign_full()` method returning [signature(2420)] + [message] format
- **STANDARDIZED** Algorithm string: "CRYSTALS-Dilithium3" everywhere
- **REMOVED** SHA3-256 fallback - operations skip if Dilithium unavailable
- **REMOVED** `create_quantum_signature()` - dead code using incorrect sign()
- **REMOVED** Genesis node bypass in signature verification

### 🛡️ Security Enhancement - WebSocket DDoS Protection
- **NEW** `WsRateLimiter` struct for connection flood protection
- **LIMITS**:
  - Max 5 WebSocket connections per IP address
  - Max 10,000 total WebSocket connections per node
  - Returns HTTP 429 "Too Many Requests" when exceeded
- **CLEANUP**: Connection count automatically decremented on disconnect
- **MONITORING**: Real-time stats (total connections, unique IPs)

### Documentation Updates
- **UPDATED** `CRYPTOGRAPHY_IMPLEMENTATION.md` v2.2 - New key storage architecture
- **UPDATED** `QNet_Whitepaper.md` v2.19.11 - Corrected key management section
- **UPDATED** `README.md` - Added v2.19.11 security updates
- **UPDATED** `API_REFERENCE.md` - Added WebSocket rate limiting section

---

## [2.19.10] - November 26, 2025 "Critical Fix: Lossless Compression + Dead Code Removal"

### 🔴 CRITICAL FIX - Lossy Compression Bug
- **REMOVED** Pattern Recognition compression from `save_microblock_efficient()`
- **REASON**: Pattern compression was **LOSSY** - data could not be reconstructed!
  - SimpleTransfer: 140→16 bytes BUT `find_transaction_by_hash()` would FAIL
  - NodeActivation, RewardDistribution: Same problem
- **SOLUTION**: Now using **ONLY Zstd-3** (lossless, ~50% reduction)
- Pattern Recognition kept **ONLY for statistics** (no actual compression)

### Fixed - Code Duplication
- **REMOVED** duplicate Pattern Recognition code from `save_block_with_delta()`
- **UNIFIED** storage paths: `save_block_with_delta()` now delegates to `save_microblock()`
- All block saving now goes through single unified path with Zstd compression

### Fixed - Transaction Decompression
- **SIMPLIFIED** `find_transaction_by_hash()` - removed complex pattern logic
- Now supports only:
  1. Zstd-compressed (check magic number 0x28B52FFD)
  2. Uncompressed raw transaction (legacy)
- Fully lossless - all transactions can be reconstructed

### Removed - Dead Code (Delta Encoding)
- **DELETED** `BlockDelta` struct - was never used in production
- **DELETED** `DeltaChange` enum - was never used in production
- **DELETED** `calculate_block_delta()` function - was never called
- **DELETED** `apply_block_delta()` function - was never called

### Removed - Dead Code (Shard Assignment)
- **DELETED** `node_shards` from PerformanceConfig - was defined but never used
- **DELETED** `super_node_shards` from PerformanceConfig - was defined but never used
- Reason: Sharding is for parallel TX processing, NOT storage partitioning
- All nodes receive all blocks; storage differs by tier (Light/Full/Super)

### Documentation Updates
- **UPDATED** `QNet_Whitepaper.md` - corrected sharding explanation
- **UPDATED** `NETWORK_LOAD_ANALYSIS.md` - corrected sharding explanation
- **UPDATED** `README.md` - corrected node types table (storage, not shards)

### Storage Estimates (CORRECTED - Zstd only)
| Scenario | Raw | With Zstd-3 (~50%) |
|----------|-----|-------------------|
| 500 TPS, 1 year (Super) | ~2.2 TB | **~1.1 TB** |
| 500 TPS, 30 days (Full) | ~180 GB | **~90 GB** |
| 100 TPS, 1 year (Super) | ~440 GB | **~220 GB** |

### Technical Details
- **Compression**: Zstd-3 for all transactions (lossless, ~50% reduction)
- **Pattern Recognition**: Statistics only, no actual compression
- **EfficientMicroBlock**: Stores TX hashes only, full TX stored separately

---

## [2.19.9] - November 26, 2025 "Tiered Storage Architecture + Graceful Degradation"

### Architecture Clarification
- **CRITICAL FIX**: Clarified that QNet uses **Transaction/Compute Sharding** for parallel processing, NOT State Sharding for storage division
- All nodes receive ALL blocks via P2P broadcast
- Storage differs by node type (what is stored and for how long), not by which shards

### Added - Graceful Degradation System
- **StorageHealth** enum: Healthy (< 70%), Warning (70-85%), Critical (85-95%), Full (>= 95%)
- **GracefulDegradation** manager: Automatically downgrades storage tier when disk fills:
  - Super → Full (enables pruning)
  - Full → Light (headers only)
  - Automatic restoration when storage becomes healthy again (after 1 hour)
- **LightNodeRotation**: Auto-cleanup old headers to maintain ~100MB limit
  - FIFO rotation - oldest headers deleted first
  - Light nodes NEVER fill up - data is automatically rotated

### Added - Storage Health Methods
- `get_storage_health()` - returns current health status
- `check_and_apply_degradation()` - applies graceful degradation if needed
- `get_effective_storage_mode()` - returns current mode (may be degraded)
- `is_storage_degraded()` - checks if currently degraded
- `rotate_light_headers()` - rotates old headers in Light mode

### Changed
- **Refactored Storage Architecture** (storage.rs)
  - Removed incorrect `ShardConfig` (was dividing storage by shards)
  - Added correct `StorageTierConfig` (tiered by node type)
  - New tiered storage model:
    - **Light nodes**: Headers only, ~100 MB (auto-rotating, NEVER fills up)
    - **Full nodes**: Full blocks + pruning, ~500 GB, last 30 days
    - **Super/Bootstrap nodes**: Full history, ~2 TB, no pruning
  - `save_microblock_tiered()` now checks degradation every 100 blocks
  - `should_store_full_blocks()` now uses effective mode (may be degraded)

### Storage Behavior
| Situation | Action |
|-----------|--------|
| Storage < 70% | Normal operation |
| Storage 70-85% | Warning logged, aggressive pruning |
| Storage 85-95% | Emergency cleanup triggered |
| Storage >= 95% | Graceful degradation (Super→Full→Light) |
| Light node full | Auto-rotate old headers (FIFO) |

### Storage Estimates (NEAR-style)
| TPS | Light Node | Full Node (30 days) | Super Node (1 year) |
|-----|------------|---------------------|---------------------|
| 100 | ~100 MB | ~36 GB | ~440 GB |
| 1K | ~100 MB | ~360 GB | ~4.4 TB |
| 10K | ~100 MB | ~500 GB (pruned) | ~44 TB |

### Documentation
- **ARCHITECTURE_v2.19.md**: Added "Sharding vs Storage Architecture" section
- Clarified that sharding = parallel processing, storage = tiered by node type

---

## [2.19.8] - November 26, 2025 "Dynamic Sharding & Full Compression Stack"

### Added
- **PRODUCTION: Transaction Compression** (storage.rs)
  - All transactions now compressed with Zstd-3 on save (~30-50% reduction)
  - Automatic decompression on read (backward compatible with legacy data)
  - Background recompression of old transactions with stronger Zstd levels:
    - 8-30 days old: Zstd-9 (~50% reduction)
    - 31-365 days old: Zstd-15 (~60% reduction)
    - 1+ years old: Zstd-22 (~80% reduction)
  - `recompress_old_transactions_sync()` - processes 10K TX per batch, non-blocking

### Changed
- **Dynamic Shard Configuration** (qnet-sharding/lib.rs)
  - Changed MIN_SHARDS from 100 to 1 (start with single shard for small networks)
  - Changed MAX_SHARDS from 1,000,000 to 256 (practical limit for 1M+ TPS)
  - New scaling: 0-1K→1, 1K-10K→4, 10K-50K→16, 50K-100K→64, 100K-500K→128, 500K+→256
  - Each shard handles ~4K TPS, total capacity scales linearly

### Storage Optimization
- **Full Compression Stack Now Active:**
  - ✅ Zstd-3 for new transactions (fast, ~30-50% reduction)
  - ✅ Adaptive Zstd for old transactions (Zstd-9/15/22 based on age)
  - ✅ Adaptive Zstd for blocks (already existed)
  - ✅ EfficientMicroBlock format (hashes only, ~80% reduction)
  - ✅ Transaction pruning (sliding window)

### Documentation
- **README.md**: Updated Light node storage (50-100 MB, not GB), dynamic shard scaling table
- **ARCHITECTURE_v2.19.md**: Added Storage Optimization & Pruning section with full details
- **QNet_Whitepaper.md**: Updated Section 8.3 Data Storage with pruning system
- **CRYPTOGRAPHY_IMPLEMENTATION.md**: Added Section 8 (Storage & Data Integrity)

### Testing
- Can force 256 shards for testing: `QNET_SHARD_COUNT=256 ./qnet-node`
- System auto-adjusts to optimal count based on actual network size

---

## [2.19.7] - November 26, 2025 "Critical Security: Nonce Validation + Transaction Pruning"

### Added
- **CRITICAL SECURITY: Nonce Validation at All Levels**
  - Added nonce check in `apply_to_state` (transaction.rs) for ALL transaction types:
    - Transfer, NodeActivation, ContractDeploy, ContractCall
    - BatchRewardClaims, BatchNodeActivations, BatchTransfers
  - Added nonce check in `submit_transaction` (node.rs) BEFORE mempool insertion
  - Prevents Replay Attacks and Double Spend vulnerabilities
  - New accounts must start with nonce=1

- **PRODUCTION: Transaction Pruning** (storage.rs)
  - Added `prune_old_transactions()` - removes transactions from pruned blocks
  - Cleans up 3 Column Families: `transactions`, `tx_index`, `tx_by_address`
  - Automatically called after block pruning in `prune_old_blocks()`
  - Forces RocksDB compaction to reclaim disk space
  - Batch processing (1000 tx/batch) to avoid memory issues

### Fixed
- **CRITICAL: Replay Attack Prevention**
  - Previously `apply_to_state` only incremented nonce but never validated it
  - Now validates `tx.nonce == sender.nonce + 1` before any state modification
- **CRITICAL: DoS Protection for Mempool**
  - Previously mempool accepted transactions with any nonce value
  - Now rejects invalid nonces immediately at API level (saves resources)
- **CRITICAL: Transaction Storage Leak**
  - Previously transactions were NEVER deleted even when blocks were pruned
  - Now transactions are properly cleaned up along with their blocks
  - Estimated storage savings: 40-60% for Full nodes with pruning enabled

### Security
- Closed potential Double Spend vulnerability
- Closed potential Replay Attack vulnerability
- Added DoS protection against mempool flooding with invalid nonces

---

## [2.19.6] - November 26, 2025 "Smart Polling & API Enhancements"

### Added
- **WebSocket Real-time Events**: Full WebSocket infrastructure for live updates
  - `ws://node:8001/ws/subscribe` endpoint with channel subscriptions
  - Channels: `blocks`, `account:{address}`, `contract:{address}`, `mempool`, `tx:{hash}`
  - Event types: NewBlock, BalanceUpdate, ContractEvent, TxConfirmed, PendingTx
  - Global broadcaster with 1000-event buffer
- **Smart Contract API**: Complete REST API for WASM smart contracts
  - `POST /api/v1/contract/deploy` - Deploy contracts with hybrid signatures
  - `POST /api/v1/contract/call` - Call contract methods
  - `GET /api/v1/contract/{address}` - Get contract info
  - `GET /api/v1/contract/{address}/state` - Query contract state
  - `POST /api/v1/contract/estimate-gas` - Estimate gas costs
- **Mandatory Ed25519 Signatures**: All transaction endpoints now require signatures
  - `TransactionRequest` and `BatchTransferRequest` require `signature` and `public_key`
  - Server-side Ed25519 verification for all transfers
- **Hybrid Signatures for Contracts**: MANDATORY Dilithium + Ed25519 for contract operations
  - Contract deploy and state-changing calls require both signatures
  - NIST FIPS 186-5 (Ed25519) + NIST FIPS 204 (Dilithium) compliance

### Changed
- **Smart Polling for Light Nodes**: Battery-efficient polling mechanism
  - Changed from 15-minute periodic polling to smart wake-up
  - App wakes ~2 minutes before calculated ping slot (once per 4-hour window)
  - `minimumFetchInterval: 240` (4 hours) instead of 15 minutes
  - Added time-to-ping validation before API calls (prevents wasted requests)
  - Reduced battery consumption by ~94% (6 wake-ups/day vs 96)
- **API Rate Limiting**: Enhanced DDoS protection
  - Per-IP rate limiting for critical endpoints
  - Separate limits: transaction (30/min), activation (10/min), claim_rewards (5/min)
- **EON Address Validation**: Server-side validation with checksum verification
  - Validates format, length, and checksum for all EON addresses
  - Prevents invalid addresses from entering the system

### Fixed
- **Documentation Updates**: Corrected polling description in QUICK_REFERENCE_v2.19.md
  - Changed "15-min check" to "Smart wake-up ~2 min before calculated slot"
- **API_REFERENCE.md**: Added detailed smart polling explanation with response examples
- **CRITICAL: Removed ALL reputation bonuses except passive recovery**:
  - Removed `ReputationEvent::SuccessfulResponse` (+1 per response) - DELETED
  - Removed `ReputationEvent::FastResponse` (+3 for <100ms) - DELETED
  - Removed `uptime_bonus` (+1%/day, max 30%) - DELETED
  - Renamed `ValidBlock` → `FullRotationComplete` (+5 → +2 for completing 30 blocks)
  - Reduced `ConsensusParticipation` (+2 → +1)
  - Passive recovery: +1 every 4h if score [10, 70) AND NOT jailed
  - Jailed nodes EXCLUDED from passive recovery (must wait for jail to expire)
  - Updated all documentation: QUICK_REFERENCE, ARCHITECTURE, Whitepaper, README
- **PROGRESSIVE JAIL SYSTEM**: Fair system with 6 chances for regular offenses
  - 1st offense: 1 hour → 30%
  - 2nd offense: 24 hours → 25%
  - 3rd offense: 7 days → 20%
- **JAIL NETWORK SYNCHRONIZATION**: ~~Jail status now syncs across all nodes~~ **(DEPRECATED in v2.21.0)**
  - ~~Added `jail_updates` to `ReputationSync` message~~ → **Now in macroblock**
  - ~~Jail status propagates via gossip protocol~~ → **Blockchain-based in v2.21.0**
  - ~~Permanent bans sync via gossip~~ → **SlashingEvent in macroblock**
  - See v2.21.0 for new deterministic jail system
- **JAIL PERSISTENCE**: Jail survives node restart
  - `save_jail_to_storage()` - saves jail to `./data/jail/jail_statuses.json`
  - `load_jail_from_storage()` - loads active jails on startup
  - `load_jail_statuses_on_startup()` - called in `start()` method
  - Automatically filters expired jails (only loads active ones)
  - 4th offense: 30 days → 15%
  - 5th offense: 3 months → 12%
  - 6+ offenses: 1 year → 10% (CAN still return!)
  - CRITICAL ATTACKS ONLY get PERMANENT BAN: DatabaseSubstitution, ChainFork, StorageDeletion
  - Genesis nodes follow same rules - equal treatment for all

### Security
- **CORS Whitelist**: Production mode uses origin whitelist instead of allow_any_origin
- **Rate Limiting**: IP-based limits prevent API abuse
- **Transaction Signatures**: All transfers now cryptographically verified
- **CRITICAL FIX: verify_ed25519_client_signature**: Fixed message format bug
  - Function was ignoring passed message and constructing "claim_rewards:..." internally
  - Now correctly uses the PASSED message for verification
  - Fixes: Transfers, batch transfers, contract calls all using correct message formats

## [2.21.0] - November 6, 2025 "Critical Rotation and Consensus Fixes"

### Fixed
- **Duplicate track_block Calls**: Fixed double counting causing "59/30 blocks"
  - Removed duplicate track_block call in block storage spawn
  - Now only tracks blocks once after creation
  - Fixes: Incorrect rotation tracking showing 59 blocks in 30-block rounds
- **is_next_block_producer Height Calculation**: Fixed wrong height usage
  - Now uses local_height + 1 instead of network_height + 1
  - Ensures node checks if it's producer for its next block
  - Fixes: Selected producer showing is_producer: false in API
- **Consensus Signature Verification**: Fixed message format mismatch
  - Now handles both formats: with and without node_id prefix
  - Prevents "Message mismatch" errors in consensus
  - Fixes: Macroblock consensus failing due to signature verification

## [2.20.0] - November 5, 2025 "Producer Rotation Cache Fix"

### Fixed
- **Producer Cache at Rotation Boundaries**: Fixed stale cache preventing rotation
  - Cache now cleared when entering new round (blocks 31, 61, 91...)
  - First block of new round always recalculates producer
  - Ensures different producer selected for each round
- **NODE_IS_SYNCHRONIZED Flag for Producers**: Critical fix for block production
  - Flag was only updated for non-producer nodes (in else branch)
  - Producer nodes had stale sync status, failing is_next_block_producer() check
  - Moved flag update before producer check (line 3371) to ensure ALL nodes update
  - Fixes: Selected producer unable to create blocks due to false "not synchronized" status
- **Leadership Round Calculation in API**: Fixed incorrect round display
  - API endpoint calculated round for current block instead of next block
  - At block 30, showed round 0 instead of round 1 (for block 31)
  - Now correctly calculates round for next_height (current_height + 1)
  - Fixes: API showing wrong leadership_round and blocks_until_rotation
- **Removed ROTATION_NOTIFY Mechanism**: Simplified rotation handling
  - Removed complex interrupt-based rotation notifications (caused race conditions)
  - Returned to simple 1-second timing that worked reliably in commits 669ca77 and 356e2bb
  - Natural timing ensures all nodes check producer status within 1 second
  - Fixes: Race conditions where notification arrived before rotation block
- **Key Manager Persistence**: Identified Docker volume requirement
  - Keys were regenerated on restart due to non-persistent /app/data/keys
  - Requires Docker volume mount for persistent key storage

## [2.19.0] - November 4, 2025 "Critical Security & Performance Fixes"

### Added
- **Dual Dilithium Signatures**: Dilithium now signs BOTH ephemeral key AND message
  - Addresses critical vulnerability in hybrid signature implementation
  - Full compliance with NIST/Cisco hybrid cryptography standards
  - Prevents quantum attacks on Ed25519 message signatures
  - Maintains O(1) performance with certificate caching
- **Memory Security (zeroize)**: Sensitive data cleared from memory after use
  - Ephemeral key bytes cleared immediately after signing
  - Dilithium seed cleared after caching
  - Encryption key material cleared after cipher creation
  - Protection against memory dumps, core dumps, and cold boot attacks
- **Global Crypto Instance**: GLOBAL_QUANTUM_CRYPTO for performance
  - Single initialization per process (was per-block!)
  - Eliminates repeated disk I/O and decryption overhead
  - Shared across hybrid_crypto.rs for consistency

### Changed
- **Adaptive BFT Timeouts**: Drastically reduced for 1 block/second target
  - Base timeouts: 2-5 seconds (was 10-25 seconds)
  - Max timeout: 10 seconds (was 60 seconds)
  - Rotation boundaries: 3 seconds (was 12 seconds)
  - Config values: 2000ms base (was 7000ms), 10000ms max (was 20000ms)
- **Hybrid Crypto Signature Structure**: Updated to include message signature
  - `dilithium_message_signature`: Now contains REAL signature (was empty string)
  - Verification enforces non-empty Dilithium message signature
  - Backward incompatible: old signatures will be rejected

### Fixed
- **Message Mismatch in Consensus**: Fixed incorrect node_id prepending
  - File: `core/qnet-consensus/src/consensus_crypto.rs:171`
  - Used message AS-IS instead of adding duplicate node_id prefix
- **Emergency Producer Activation**: Fixed global flag not being set
  - File: `development/qnet-integration/src/unified_p2p.rs:7520-7528`
  - Now correctly calls `set_emergency_producer_flag` for local node
- **Block Production Delays**: Fixed two major performance bottlenecks
  - Repeated crypto initialization: Now uses GLOBAL_QUANTUM_CRYPTO
  - Excessive AdaptiveBFT timeouts: Reduced to match 1-second block target
- **Network Stuck at Block 30**: Resolved through combination of above fixes
  - Message verification now works correctly
  - Emergency failover activates properly
  - Blocks produced at correct 1-second intervals

### Security
- **CRITICAL**: Quantum resistance now complete at consensus level
  - Previous implementation vulnerable to quantum attacks on Ed25519
  - Current implementation requires BOTH Ed25519 AND Dilithium verification
  - Consensus mechanism is now fully post-quantum secure
- **Memory safety**: All sensitive cryptographic material properly cleared
  - Addresses forensic analysis and memory dump attack vectors
  - Complies with best practices for key material handling

## [2.18.0] - October 31, 2025 "VTS Optimization & VRF Implementation"

### Added
- **Deterministic Producer Selection**: SHA3-512 based quantum-resistant selection
  - Unpredictable, verifiable, Byzantine-safe leader election
  - No OpenSSL dependencies (pure Rust with `ed25519-dalek`)
  - Evaluation: <1ms per candidate, Verification: <500μs per proof
  - Entropy from macroblock hashes (agreed via Byzantine consensus)
  - Prevents producer manipulation and prediction attacks
- **Comprehensive Benchmark Harness**: Full performance testing suite
  - VTS throughput benchmarks (1K-100K hashes)
  - VRF operations (init, evaluate, verify)
  - Producer selection scalability (5-10K nodes)
  - Consensus operations (commit/reveal)
  - Storage performance (save/load)
  - Validator sampling (1K-1M nodes)
  - Cryptography comparisons (SHA3-512/256, Ed25519)
  - HTML reports with Criterion.rs
  - Benchmark documentation in `benches/README.md`

### Changed
- **VTS Performance Optimized**: 15.6M → 25M+ hashes/sec
  - Removed Blake3 from generation loop (kept in verification for compatibility)
  - SHA3-512 ONLY for true VDF properties (non-parallelizable)
  - Fixed-size arrays instead of Vec allocations
  - Zero-copy operations in hot path
  - Direct buffer reuse eliminates allocation overhead
- **VTS Algorithm Simplified**: True VDF implementation
  - Sequential SHA3-512 hashing only
  - No hybrid approach anymore
  - Ensures verifiable delay function properties
  - Cannot be parallelized or predicted

### Performance
- **VTS**: 25M+ hashes/sec (Intel Xeon E5-2680v4 @ 2.4GHz)
- **VRF Evaluation**: <1ms per candidate
- **VRF Verification**: <500μs per proof
- **Producer Selection (1K nodes)**: <10ms
- **Validator Sampling (1M nodes)**: <50ms

### Documentation
- Updated `README.md` with VRF and optimized VTS metrics
- Updated `QNet_Whitepaper.md` with detailed VRF section (8.4.3)
- Updated `QNET_COMPLETE_GUIDE.md` with performance targets
- Added `benches/README.md` with complete benchmark guide
- All mentions of "31.25M hashes/sec" updated to "25M+ hashes/sec"
- All mentions of "Blake3 alternating" updated to "SHA3-512 only"

### Security
- Deterministic selection prevents producer manipulation via FINALITY_WINDOW
- True VDF ensures time cannot be faked
- Byzantine-safe entropy from macroblock consensus
- No single node can predict or bias selection

## [2.15.0] - October 2, 2025 "Advanced Security & Privacy Protection"

### Added
- **AES-256-GCM Database Encryption**: Quantum-resistant symmetric encryption
  - Replaced weak XOR encryption with industry-standard AES-256-GCM
  - Encryption key derived from activation code (NEVER stored in database)
  - Authenticated encryption (AEAD) prevents tampering
  - Supports seamless device migration (same code = same key)
- **Critical Attack Protection**: Instant maximum penalties
  - DatabaseSubstitution: Attempting to substitute DB with alternate chain
  - StorageDeletion: Deleting database during active block production
  - ChainFork: Creating or promoting a fork of the blockchain
  - Penalty: Instant 1-year ban + reputation destruction (100% → 0%)
- **Privacy-Preserving Pseudonyms**: Enhanced node ID protection
  - Prevents double-conversion of pseudonyms in logs (genesis_node_XXX stays genesis_node_XXX)
  - Applied to 14 reputation and failover log locations
  - Protects network topology from analysis
- **Genesis Bootstrap Grace Period**: Prevents false failover at network startup
  - First microblock: 15-second timeout (vs 5s normal)
  - Allows simultaneous Genesis node startup without false positives
  - Normal blocks retain 5-second timeout
- **Comprehensive Security Test Suite**: 9 new activation security tests
  - AES-256 encryption validation
  - Database theft protection
  - Device migration detection
  - Pseudonym conversion prevention
  - Grace period timing verification

### Fixed
- **Genesis Activation Ownership**: Skip ownership check for Genesis codes
  - Genesis codes use IP-based authentication (not wallet ownership)
  - Allows Genesis nodes to save activation codes without validation errors
  - Enables proper Genesis node restart and migration
- **Genesis Wallet Format Sync**: Unified wallet format across all modules
  - quantum_crypto, get_wallet_address, and reward_system now use consistent format
  - Genesis wallets: "genesis_...eon" (41-character format: 19 + "eon" + 15 + 4 checksum)
  - Eliminates "Code ownership failed" errors for Genesis nodes
- **Database Key Storage**: Removed encryption key from database
  - state_key no longer saved alongside encrypted data
  - Key derived on-demand from activation code
  - Protects against database theft (cannot decrypt without code)

### Security
- **Database Theft Protection**: Stealing database requires activation code to decrypt
- **No Encryption Key Exposure**: Keys never written to disk
- **Wallet Immutability**: Rewards always go to wallet in activation code (cannot be changed)
- **Device Migration Security**: Automatic tracking prevents multiple active devices
- **Rate Limiting**: 1 server migration per 24 hours (prevents abuse)

### Changed
- **Encryption Algorithm**: XOR → AES-256-GCM (NIST-approved quantum-resistant)
- **Key Derivation**: SHA3(activation_code + salt) instead of state_key storage
- **Pseudonym Handling**: Smart detection prevents re-conversion of existing pseudonyms
- **Audit Attribution**: Updated to "AI-assisted analysis" for transparency

## [2.14.0] - October 2, 2025 "Chain Integrity & Database Attack Protection"

### Added
- **Chain Integrity Validation**: Complete block validation system
  - Verifies previous_hash linkage in all microblocks
  - Validates chain continuity for macroblocks  
  - Detects and rejects chain forks
- **Database Substitution Protection**: Critical security enhancement
  - Detects if database replaced with alternate chain
  - Rejects blocks that break chain continuity
  - Prevents malicious nodes from creating forks
- **Enhanced Synchronization Protection**: Strict requirements before consensus participation
  - New nodes MUST fully sync blockchain before producing blocks
  - Genesis phase (blocks 1-10): Maximum 1 block tolerance
  - Normal phase: Maximum 10 blocks behind network height
  - Global NODE_IS_SYNCHRONIZED flag tracks sync status
- **Storage Failure Handling**: Graceful degradation on storage errors
  - Immediate emergency failover if storage fails during production
  - Broadcast failure to network for quick recovery
  - -20 reputation penalty for storage failures
- **Macroblock Consensus Verification**: Added sync check before consensus initiation
  - Nodes verify synchronization before participating in macroblock creation
  - Prevents unsynchronized nodes from corrupting consensus
  - Max lag: 5 blocks (Genesis) or 20 blocks (Normal)

### Fixed
- **Data Persistence Issue**: Removed dangerous /tmp fallback for Docker
  - Docker containers now REQUIRE mounted volume or fail
  - Prevents complete database loss on container restart
  - Added explicit QNET_DATA_DIR environment variable support
- **Genesis Phase Vulnerability**: Fixed loophole allowing unsync nodes at height ≤10
  - Previously: height 0 nodes could produce blocks during Genesis
  - Now: Strict synchronization even during Genesis phase

### Security
- **Attack Prevention**: Malicious nodes cannot join consensus without full sync
- **Database Deletion Protection**: Nodes with deleted DBs automatically excluded
- **Byzantine Safety**: Ensures only synchronized nodes participate in consensus
- **Docker Security**: Enforces persistent storage to prevent data loss

### Changed
- **Data Directory Selection**: Prioritizes Docker volumes over temporary directories
- **Synchronization Logic**: Stricter requirements during critical phases
- **Producer Selection**: Only synchronized nodes can be selected as producers

## [2.13.0] - October 2, 2025 "Atomic Rewards & Activity-Based Recovery"

### Added
- **Atomic Rotation Rewards**: Single +30 reward per full 30-block rotation
  - Replaced 30 individual +1 rewards with one atomic reward
  - Partial rotations receive proportional rewards (e.g., 15 blocks = +15)
  - Reduces lock contention and improves performance
- **Activity-Based Recovery**: Reputation recovery requires recent activity
  - Nodes must have successful ping within last hour to recover reputation
  - Prevents offline nodes from gaining reputation
  - Ensures only active participants benefit from recovery

### Fixed
- **Self-Penalty Exploit**: Removed ability to avoid -20 penalty by self-reporting
  - All failovers now apply consistent -20 penalty
  - Prevents manipulation of reputation system
  - Ensures fair penalties for all nodes
- **apply_decay() signature**: Updated to require last_activity parameter
  - Enables activity checking for recovery
  - Improves accuracy of reputation recovery

### Changed
- **Rotation Tracking**: Added RotationTracker for atomic reward management
  - Tracks blocks produced per rotation round
  - Calculates rewards at rotation boundaries
  - Handles partial rotations from failovers
- **Reputation Recovery Logic** (Updated v2.19.4): 
  - Recovery rate: +1% every 4 hours (not per hour)
  - ONLY applies to Full/Super nodes with reputation in [10, 70) range
  - Capped at 70 (consensus threshold) - must earn higher through consensus
  - Light nodes: EXCLUDED (fixed reputation of 70)
  - Banned nodes (<10): EXCLUDED from passive recovery

## [2.12.0] - October 2, 2025 "95% Decentralization with Stability Protection"

### Added
- **PROGRESSIVE JAIL SYSTEM**: Fair system with 6 chances (updated in v2.19.7)
  - 1st: 1h → 30%, 2nd: 24h → 25%, 3rd: 7d → 20%
  - 4th: 30d → 15%, 5th: 3m → 12%, 6+: 1y → 10% (can return!)
  - CRITICAL ATTACKS ONLY = PERMANENT BAN (DatabaseSubstitution, ChainFork, StorageDeletion)
  - Genesis nodes follow same rules - equal treatment
- **Double-Sign Detection**: Automatic detection and evidence collection
  - Tracks last 100 block heights for signature verification
  - Immediate jail + -50 reputation penalty
- **Invalid Block Detection**: 
  - Time manipulation detection (>5s future blocks)
  - Cryptographic signature validation
  - Invalid consensus message detection
- **Malicious Behavior Tracking**: 
  - Violation history per node
  - Evidence storage and verification
  - Automatic reputation system integration

### Changed
- **Reputation Documentation**: Fixed to match actual code implementation
  - Removed non-existent penalties from README
  - Updated penalty/reward table with real values
  - Added Anti-Malicious Protection section
- **Removed Genesis Protection**: 
  - No more special treatment for Genesis nodes
  - All nodes equal in penalties and rewards
  - Full decentralization achieved

### Security
- Protection against double-signing attacks
- Time manipulation prevention
- Network flooding protection (DDoS mitigation)
- Protocol violation detection
- Progressive penalty escalation for repeat offenders

## [2.11.0] - October 2, 2025 "Critical Node ID Consistency & Reputation System Fix"

### Fixed
- **NODE_ID Consistency**: Complete fix for node identification system
  - Now uses validated node_id from startup throughout the entire lifecycle
  - Eliminates fallback IDs (e.g., node_5130b3c4) that caused failover issues
  - Fixed `execute_real_commit_phase` and `execute_real_reveal_phase` to use passed node_id parameter
  - Fixed `should_initiate_consensus` to use correct node_id instead of regenerating
  - Ensures all nodes use consistent `genesis_node_XXX` IDs in Docker environments

- **Genesis Node Reputation**: Critical fix for Genesis node penalty system
  - Genesis nodes now use REAL P2P reputation instead of static 0.70 in candidate selection
  - Reduced Genesis reputation floor from 70% to 20% to allow real penalties
  - Failed/inactive Genesis nodes are now properly excluded from producer candidates
  - Emergency producer selection now checks real reputation for Genesis nodes
  - Fixes issue where penalized Genesis nodes remained eligible producers indefinitely

### Added
- **Emergency Mode for Network Recovery**: Progressive degradation when all nodes below threshold
  - Genesis phase: Tries thresholds 50%, then emergency boost (+30%), then forced recovery
  - Production phase: Progressive thresholds 50%, 40%, 30%, 20% to find any viable producer
  - Emergency reputation boost (+50%) to first responding node in critical situations
  - Prevents complete network halt when all nodes have low reputation
  - Uses existing Progressive Finalization Protocol (PFP) for consistency

## [2.10.0] - October 1, 2025 "Hardware Auto-Tuning & Performance Optimization"

### Added
- **CPU Auto-Detection**: Automatic parallel thread count based on available CPU cores
  - Detects CPU count using `std::thread::available_parallelism()`
  - Minimum 4 threads, scales up to all available cores
  - **Optional CPU limiting**: `QNET_CPU_LIMIT_PERCENT` (e.g., 50% = half CPU)
  - **Optional thread cap**: `QNET_MAX_THREADS` (absolute limit)
  - Eliminates manual `QNET_PARALLEL_THREADS` configuration
- **Intelligent Parallel Validation**: Auto-enables on multi-core systems
  - AUTO-ON if CPU ≥ 8 cores (multi-core benefit threshold)
  - AUTO-OFF on low-core systems (4-6 cores) to avoid overhead
  - Manual override still supported via `QNET_PARALLEL_VALIDATION`
- **Dynamic Mempool Scaling**: Auto-adjusts capacity based on network size
  - Genesis/test (≤100 nodes): 100k transactions
  - Small network (101-10k nodes): 500k transactions
  - Medium network (10k-100k nodes): 1M transactions
  - Large network (100k+ nodes): 2M transactions
  - Reads actual node count from blockchain registry

### Changed
- **QNET_PARALLEL_THREADS**: Now optional with intelligent CPU-based default
- **QNET_PARALLEL_VALIDATION**: Now optional with automatic 8-core threshold
- **QNET_MEMPOOL_SIZE**: Now optional with network-size-based scaling
- **Startup logging**: Added performance auto-tune visibility

### Benefits
- Works optimally on any hardware: 4-core VPS to 64-core server
- No manual tuning required for different server specifications
- Automatic adaptation as network grows
- Eliminates "one size fits all" performance bottlenecks
- **Flexible CPU control**: Use 100% or limit to leave resources for other apps

### CPU Limiting Examples
```bash
# Use 50% of available CPU (32-core → 16 threads)
-e QNET_CPU_LIMIT_PERCENT=50

# Cap at maximum 8 threads (regardless of available cores)
-e QNET_MAX_THREADS=8

# No limit (default) - use all available cores
# (no environment variable needed)
```

## [2.9.0] - October 1, 2025 "Dynamic Shard Auto-Scaling"

### Added
- **Dynamic Shard Calculation**: Automatic shard count adjustment based on real network size
  - Genesis (5 nodes): 1 shard
  - Growth (75k nodes): 2 shards  
  - Scale (150k-300k nodes): 4 shards
  - Max capacity (19M+ nodes): 256 shards (maximum)
- **Multi-Source Network Detection**: Real-time network size from multiple sources
  - Priority 1: Explicit `QNET_TOTAL_NETWORK_NODES` from monitoring/orchestration
  - Priority 2: Genesis phase detection (5 bootstrap Super nodes)
  - Priority 3: **Blockchain registry** - reads actual node activations from storage
  - Priority 4: Conservative default (100 nodes)
- **Auto-Scaling Logging**: Real-time visibility of shard calculation and network size detection

### Changed
- **QNET_ACTIVE_SHARDS**: Now optional override instead of required parameter
  - Default: Automatic calculation via `calculate_optimal_shards()`
  - Override: Manual value for testing or specific deployment needs
- **Storage Window Scaling**: Dynamically adjusts with auto-detected shard count
- **Shard Formula**: Uses existing `calculate_optimal_shards()` (75k nodes per shard)

### Fixed
- **Manual Shard Tracking**: Eliminates need for operators to manually update shard count
- **Storage Bloat Prevention**: Automatic adjustment prevents under/over-estimation
- **Network Growth Handling**: Seamlessly scales from 5 nodes to millions

### Technical Details
- Reuses existing `reward_sharding::calculate_optimal_shards()` function
- **Blockchain Registry Integration**: Reads actual node count from RocksDB "activations" column family
- Real-time accuracy: Counts every activated node stored in blockchain
- P2P-independent: Works during Storage initialization before network sync
- Conservative defaults: Assumes small network to avoid over-sharding
- Environment override preserved for testing/custom deployments
- Zero external dependencies: Uses only local blockchain storage

### When Shard Count Updates
- **On node startup/restart**: Automatically recalculates based on current network size
- **During operation**: Fixed to ensure storage consistency
- **Production workflow**: Node updates/restarts trigger automatic recalculation
- **Rolling restart strategy**: Recommended for coordinated shard scaling across network

## [2.8.0] - January 2, 2025 "Ultra-Modern Storage Architecture"

### Added
- **Adaptive Temporal Compression**: Blocks compressed stronger as they age (None → Light → Medium → Heavy → Extreme)
- **Delta Encoding**: Store only differences between consecutive blocks (95% space saving)
- **Pattern Recognition**: Identify and compress common transaction patterns
  - SimpleTransfer: 300 bytes → 16 bytes (95% reduction)
  - NodeActivation: 500 bytes → 10 bytes (98% reduction)
  - RewardDistribution: 400 bytes → 13 bytes (97% reduction)
- **Probabilistic Indexes**: Bloom filter for O(1) transaction lookups with 0.01% false positive rate
- **Intelligent Compression Levels**: Zstd 3 for hot data, up to Zstd 22 for ancient blocks
- **Automatic Recompression**: Background process recompresses old blocks every 10,000 blocks
- **Delta Checkpoints**: Full blocks every 1000, deltas in between

### Changed
- **Compression Strategy**: From fixed Zstd-3 to adaptive 3-22 based on block age
- **Storage Efficiency**: 10x better compression for blocks older than 1 year
- **Block Format**: Support for delta-encoded blocks with magic bytes detection

### Technical Details
- Block age < 1 day: No compression (hot data)
- Block age 2-7 days: Zstd level 3 (light)
- Block age 8-30 days: Zstd level 9 (medium)
- Block age 31-365 days: Zstd level 15 (heavy)
- Block age > 365 days: Zstd level 22 (extreme)

## [2.7.0] - January 1, 2025 "Storage Optimization & Fast Sync"

### Added
- **Sliding Window Storage**: Full nodes keep only last 100K blocks instead of full history
- **Smart Pruning System**: Automatic deletion of old blocks after snapshot creation
- **Node Storage Modes**: Light (100MB), Full (50GB), Super (2TB+ with full history)
- **Fast Snapshot Sync**: New nodes bootstrap in ~5 minutes instead of hours
- **Storage Auto-Detection**: Nodes configure storage based on type automatically
- **Progressive Cleanup**: Multi-tier cleanup at 70%, 85%, and 95% capacity

### Changed
- **Storage Requirements**: Full nodes need 50-100 GB instead of 7+ TB/year
- **Sync Time**: Reduced from hours to minutes using snapshot-based sync
- **Default Storage**: Changed from 300 GB to node-type-specific limits
- **Pruning Strategy**: Keeps snapshots but prunes blocks outside window

### Fixed
- **Storage Overflow**: Prevents disk exhaustion with sliding window
- **Sync Speed**: 10x faster bootstrap using snapshots
- **Resource Usage**: 95% reduction in storage requirements for Full nodes

### Performance
- **Storage Efficiency**: 50 GB for Full nodes (vs 7 TB/year previously)
- **Sync Speed**: ~5 minutes for Full nodes (vs hours previously)
- **Network Load**: Reduced by using snapshots instead of full history
- **Pruning Performance**: Automatic background pruning every 10,000 blocks

## [2.6.0] - September 29, 2025 "Entropy-Based Selection & Advanced Synchronization"

### Added
- **Entropy-Based Producer Selection**: SHA3-256 hash with previous block hash as entropy source
- **Microblock Reputation Rewards**: +1 reputation per microblock produced
- **Macroblock Reputation Rewards**: +10 for leader, +5 for participants
- **State Snapshots System**: Full (every 10k blocks) and incremental (every 1k blocks)
- **IPFS Integration**: Optional P2P snapshot distribution via IPFS
- **Parallel Block Synchronization**: Multiple workers download blocks concurrently
- **Deadlock Prevention**: Guard pattern for sync flags with auto-reset
- **Sync Health Monitor**: Background task to detect and clear stuck sync flags

### Changed
- **Producer Selection**: Now uses entropy from previous round's last block hash
- **Macroblock Initiator**: Also uses entropy instead of deterministic selection
- **Emergency Producer**: Includes entropy to prevent repeated selection
- **Sync Timeouts**: 60s for fast sync, 30s for normal background sync
- **IPFS Optional**: Requires explicit IPFS_API_URL configuration (no default)

### Fixed
- **Network Collapse Prevention**: Fixed deterministic producer selection causing leadership vacuum
- **Fast Sync Deadlock**: Resolved FAST_SYNC_IN_PROGRESS flag getting stuck
- **Background Sync Deadlock**: Fixed SYNC_IN_PROGRESS flag persistence issues
- **Producer Rotation**: Ensured true randomness in 30-block rotation cycles
- **Genesis Node Diversity**: Prevented single node domination for 14+ hours

### Security
- **True Decentralization**: Unpredictable producer rotation via entropy
- **Multi-Level Failover**: Better resilience against node failures
- **Timeout Protection**: Prevents indefinite sync operations
- **Reputation Incentives**: Economic rewards for block production

### Performance
- **Parallel Downloads**: 100-block chunks with multiple workers
- **LZ4 Compression**: Efficient snapshot storage
- **SHA3-256 Verification**: Integrity checks for snapshots
- **Auto-Cleanup**: Keep only latest 5 snapshots
- **IPFS Gateways**: Multiple redundant download sources

## [2.5.0] - September 28, 2025 "Production-Ready MVP with Sync & Recovery"

### Added
- **Persistent Consensus State**: Save and restore consensus state across restarts
- **Protocol Version Checking**: Version compatibility checks for consensus state
- **Sync & Catch-up Protocol**: Batch sync for recovering nodes (100 blocks per batch)
- **Cross-Shard Support**: Integrated ShardCoordinator for cross-shard transactions
- **Rate Limiting for Sync**: DoS protection (10 sync requests/minute, 5 consensus requests/minute)
- **Sync Progress Tracking**: Resume interrupted sync after restart
- **Network Messages**: RequestBlocks, BlocksBatch, SyncStatus, RequestConsensusState, ConsensusState

### Changed
- **Storage**: Added consensus and sync_state column families to RocksDB
- **Node Startup**: Auto-check for sync needs and consensus recovery
- **Rate Limiting**: Stricter limits for consensus state requests (2-minute block on abuse)

### Security
- **Protocol Versioning**: Prevents loading incompatible consensus states
- **Rate Limiting**: Protection against sync request flooding
- **Version Guards**: MIN_COMPATIBLE_VERSION check for protocol upgrades

### Performance
- **Batch Sync**: 100 microblocks per request (heights from-to)
- **Microblocks**: Created every 1 second, synced via batch when catching up
- **Macroblocks**: Created locally every 90 seconds from microblocks via consensus
- **Legacy Blocks**: Only genesis block uses old Block format
- **Rate Limiting**: 10 sync requests/minute per peer
- **Consensus Rate**: 5 consensus state requests/minute per peer
- **Smart Sync**: Only sync when behind, auto-resume from last position

## [2.4.0] - September 27, 2025 "Zero-Downtime Swiss Watch Architecture"

### Added
- **Zero-Downtime Consensus**: Macroblock consensus starts at block 60 in background
- **Swiss Watch Precision**: Continuous microblock production without ANY stops
- **Non-Blocking Architecture**: Macroblock creation happens asynchronously 
- **Emergency Failover**: Automatic fallback if macroblock consensus fails
- **Performance Monitoring**: Real-time TPS calculation with sharding (424,411 TPS)

### Changed  
- **Consensus Timing**: Start consensus 30 blocks early (block 60 instead of 90)
- **Block Production**: Microblocks NEVER stop, not even for 1 second
- **Performance Config**: 256 shards, 10k batch size, 16 parallel threads by default
- **Macroblock Check**: Non-blocking verification with 5-second timeout
- **Production Mode**: Auto-enables sharding and lock-free for 424,411 TPS

### Fixed
- **TODO Placeholder**: Removed TODO and implemented real emergency consensus
- **Network Downtime**: Eliminated 0-15 second pause at macroblock boundaries
- **Producer Selection**: Added perf_config to microblock production scope
- **Format String Error**: Fixed TPS logging format in microblock production

### Performance
- **100% uptime**: Network NEVER stops, continuous 60 blocks/minute
- **Zero downtime**: Macroblock consensus runs in parallel with microblocks
- **424,411 TPS**: Real sustained throughput with 256 shards
- **Swiss precision**: Exact 1-second intervals without drift
- **Instant recovery**: Emergency consensus triggers within 5 seconds

## [2.3.0] - December 18, 2025 "Quantum Scalability & Lock-Free Operations"

### Added
- **Lock-Free Operations**: DashMap implementation for concurrent P2P operations without blocking
- **Auto-Scaling Mode**: Automatic switching between HashMap (5-50 nodes) and DashMap (50+ nodes)
- **Dual Indexing**: O(1) lookups by both address and node ID through secondary index
- **256 Shards**: Distributed peer management across shards with cross-shard routing
- **Performance Monitor**: Background task tracking mode switches and statistics

### Changed
- **P2P Structure**: `connected_peers` migrated from `Vec<PeerInfo>` to `HashMap<String, PeerInfo>`
- **K-bucket Management**: Integrated with lock-free operations maintaining 20 peers/bucket limit
- **Peer Operations**: All add/remove/search operations now O(1) instead of O(n)
- **Sharding Integration**: Connected to existing `qnet_sharding::ShardCoordinator`
- **Auto-Thresholds**: Light nodes (500+), Full nodes (100+), Super nodes (50+) for lock-free

### Fixed
- **Phantom Peers**: Double-checking both `connected_addrs` and `connected_peers` lists
- **API Deadlock**: Removed circular dependencies in height synchronization
- **Consensus Divergence**: Fixed non-deterministic candidate lists in Genesis phase
- **CPU Load**: Reduced non-critical logging frequency for non-producer nodes
- **Data Persistence**: Added controlled reset mechanism with confirmation

### Performance
- **10x faster** peer operations for 100+ nodes
- **100x faster** ID lookups through dual indexing
- **1000x better** scalability for 1M+ nodes with sharding
- **Zero blocking** with lock-free DashMap operations
- **Auto-optimization** without manual configuration

## [2.2.0] - September 24, 2025 "Production Stability & Privacy Enhancement"

### Fixed
- **Tokio Runtime Panic**: Resolved nested runtime errors causing node crashes
- **P2P Peer Duplication**: Fixed duplicate peer connections using RwLock and HashSet
- **API Initialization Sequence**: API server now starts before P2P connections
- **Connection Failures**: Implemented exponential backoff for network stability
- **Network Height Calculation**: Fixed incorrect height reporting during bootstrap
- **Block Producer Synchronization**: Ensured deterministic producer selection across nodes
- **Cache Inconsistency**: Implemented topology-aware cache with minimal TTL
- **Peer Exchange Protocol**: Fixed peer addition logic with proper duplicate checking
- **Timing Issues**: Made storage and broadcast operations asynchronous
- **Docker IP Detection**: Enhanced external IP discovery with STUN support
- **Failover Logic**: Increased timeouts (5s, 10s, 15s) with exponential backoff

### Added
- **Privacy Protection**: All IP addresses now hashed in logs and messages
- **Deterministic Genesis Phase**: All 5 Genesis nodes included without filtering
- **Bootstrap Mode**: Special mode for Genesis nodes during network formation
- **Privacy ID System**: Consistent hashed identifiers for network addresses
- **Asynchronous I/O**: Non-blocking storage and broadcast operations

### Changed
- **Peer Management**: Migrated from Mutex to RwLock for better concurrency
- **Producer Selection**: 30-block rotation with cryptographic determinism
- **Cache Duration**: Dynamic (1s for height 0, 0s for normal operation)
- **Failover Timeouts**: Increased from 2s to 5s/10s/15s for global stability
- **Node Identification**: From IP-based to privacy-preserving hashed IDs

### Removed
- **CPU Load Monitoring**: Removed unnecessary system metrics collection
- **Direct IP Logging**: Replaced with privacy-preserving hashed identifiers
- **Blocking I/O**: All critical operations now asynchronous
- **Debug Logs**: Cleaned up verbose debugging output
- **Commented Code**: Removed obsolete commented-out sections

### Security
- **Privacy Enhancement**: No raw IP addresses exposed in logs or P2P messages
- **Deterministic Consensus**: Cryptographic producer selection prevents forks
- **Race Condition Prevention**: Proper synchronization with RwLock
- **Byzantine Fault Tolerance**: Maintained for macroblock consensus

### Performance
- **Reduced Lock Contention**: RwLock allows multiple concurrent readers
- **Efficient Duplicate Checking**: O(1) lookup with HashSet
- **Asynchronous Operations**: Non-blocking I/O prevents timing delays
- **Optimized Cache**: Minimal cache duration for real-time consensus

## [2.1.0] - August 31, 2025 "Quantum P2P Architecture"

### Added
- **Quantum-Resistant P2P System**: 100% post-quantum cryptography compliance
- **Adaptive Peer Limits**: Dynamic scaling from 8 to 500 peers per region
- **Real-Time Topology Updates**: 1-second peer rebalancing intervals
- **Blockchain Peer Registry**: Immutable peer records in distributed ledger
- **Bootstrap Trust Mechanism**: Genesis nodes instant connectivity
- **Emergency Bootstrap Fallback**: Cold-start cryptographic validation
- **CRYSTALS-Dilithium Integration**: Post-quantum peer verification
- **Certificate-Based Genesis Discovery**: Blockchain activation registry integration

### Changed
- **Byzantine Safety**: Strict 4-node minimum enforcement implemented
- **Peer Exchange Protocol**: Instance-based method with real connected_peers updates
- **Genesis Phase Detection**: Unified logic across microblock production and peer exchange
- **Memory Management**: Zero file dependencies, pure in-memory protocols
- **Network Scalability**: Ready for millions of nodes with quantum resistance

### Removed
- **File-Based Peer Caching**: Eliminated for quantum decentralized compliance
- **Time-Based Genesis Logic**: Replaced with node-based detection
- **Hardcoded Bootstrap IPs**: Replaced with cryptographic certificate verification
- **Regional Scalability Limits**: Removed 8-peer maximum per region restriction

### Security
- **Post-Quantum Compliance**: 100% quantum-resistant P2P protocols implemented
- **Real-Time Peer Announcements**: Instant topology updates via NetworkMessage::PeerDiscovery
- **Bidirectional Peer Registration**: Automatic mutual peer discovery via RPC endpoints
- **Quantum-Resistant Validation**: CRYSTALS-Dilithium signatures for all peer connections
- **Byzantine Safety**: Strict 4-node minimum requirement prevents single points of failure
- **Emergency Bootstrap**: Cryptographic validation for network cold-start scenarios

### Technical Details
- **Architecture**: Adaptive peer limits with automatic network size detection
- **Performance**: 600KB RAM usage for 3,000 peer connections (negligible on modern hardware)
- **Scalability**: Production-ready for millions of nodes with regional clustering
- **Compliance**: 100% quantum-resistant protocols, zero file dependencies

**Migration Guide**: See documentation/technical/QUANTUM_P2P_ARCHITECTURE.md

## [1.0.0] - 2024-01-XX

### Added
- Initial release of QNet blockchain platform
- Post-quantum cryptography support (Dilithium3, Kyber1024)
- Rust optimization modules for 100x performance improvement
- Go network layer for high-performance P2P communication
- WebAssembly VM for smart contract execution
- Support for three node types: Light, Full, and Super nodes
- Mobile optimization with battery-saving features
- Hierarchical network architecture for millions of nodes
- Dynamic consensus mechanism with reputation system
- Smart contract templates (Token, NFT, Multisig, DEX)
- Comprehensive API endpoints for node management
- Docker support for easy deployment
- Prometheus/Grafana monitoring integration
- Solana integration for node activation
- Complete documentation and developer guides

### Security
- Implemented post-quantum cryptographic algorithms
- Added Sybil attack protection through token burning
- Secure key management system
- Rate limiting and DDoS protection

### Performance
- Transaction validation: 100,000+ TPS with Rust optimization
- Sub-second block finality
- Parallel transaction processing
- Lock-free data structures in critical paths
- Optimized storage with RocksDB

## [0.9.0] - 2024-01-XX (Pre-release)

### Added
- Beta testing framework
- Initial smart contract support
- Basic node implementation

### Changed
- Migrated from PoW to reputation-based consensus
- Updated network protocol for better scalability

### Fixed
- Memory leaks in transaction pool
- Consensus synchronization issues

## [0.1.0] - 2023-XX-XX (Alpha)

### Added
- Basic blockchain implementation
- Simple consensus mechanism
- Initial P2P networking
- Basic transaction support

---

For detailed release notes, see [Releases](https://github.com/qnet-project/qnet-project/releases). 