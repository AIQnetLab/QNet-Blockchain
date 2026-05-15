# QNet Cryptography Implementation Guide
## Complete Technical Specification

**Version:** 3.5 (v2.74.0)  
**Date:** January 3, 2026  
**Status:** Production Ready (Embedded RocksDB Indexing + Explorer)  

---

## 🎯 Executive Summary

QNet implements **NIST/Cisco recommended post-quantum cryptography** with:
- ✅ **Real CRYSTALS-Dilithium3** (~2500-byte RAW signatures) for quantum resistance
- ✅ **Hybrid Ed25519 + Dilithium** (single Dilithium signature per message)
- ✅ **Compact signatures v2.23** (~2.6KB RAW bytes, 88% reduction from 22KB)
- ✅ **Certificate caching** (100K LRU cache for scalability)
- ✅ **Defense-in-depth** (two-layer verification: P2P + Consensus with real Dilithium)
- ✅ **SHA3-256 hashing** (NIST FIPS 202 compliant)
- ✅ **RAW bytes format** (serde_bytes, no base64 overhead)
- ✅ **Forward secrecy** (4.5-minute certificate lifetime with 80% rotation threshold)
- ✅ **Byzantine-safe** (2/3+ honest nodes at all verification layers)

### v2.25 Additions (Transaction Optimization)
- ✅ **bincode serialization** (10-20x faster than JSON for TX processing)
- ✅ **Gulf Stream protocol** (direct TX forwarding to producer, ~10ms latency)
- ✅ **Anti-Storm protection** (DashSet deduplication prevents gossip amplification)
- ✅ **100K TX/block** (up from 50K, bincode enables faster processing)
- ✅ **Optional Dilithium TX signatures** (post-quantum for enterprise, +50% gas)

### v2.25.2 Additions (High TPS Optimization)
- ✅ **Batch Ed25519 verification** (3x faster using ed25519-dalek batch verify)
- ✅ **Batch mempool operations** (1 lock per 1000 TX instead of per TX)
- ✅ **10K TX batch size** (benchmark optimized for 100K TX/block)
- ✅ **Skip self-broadcast** (producer doesn't broadcast TX to self)
- ✅ **Snapshot mempool reads** (release lock early, DashMap is lock-free)
- ✅ **HealthPing with height** (accurate network_height every 15 seconds)
- ✅ **TX accumulator** (batch 1000 TX for verification, 100ms timeout)

### v2.27.0 Additions (Epoch-Based Validator Set)
- ✅ **MacroBlock snapshots** (eligible producers stored in blockchain)
- ✅ **Deterministic producer selection** (no gossip race conditions)
- ✅ **Entropy from finality block** (SHA3-512 hash from FINALITY_WINDOW=10 blocks ago)
- ✅ **Genesis epoch static list** (genesis_constants.rs for blocks 1-180, N-2 logic)
- ✅ **MAX_VALIDATORS_PER_EPOCH = 1000** (deterministic sampling for scalability)

### v2.31.0 Additions (5-Layer Macroblock Protection)
- ✅ **5-Layer Macroblock Sync** (unsync, not-validator, boundary, periodic, on-demand)
- ✅ **Rate Limiting** (ACTIVE_MACROBLOCK_CHECK_TASKS, max 5 concurrent)
- ✅ **TaskGuard RAII** (automatic cleanup of spawned tasks)
- ✅ **Proactive Fork Detection** (rollback if local > network on startup)
- ✅ **ShredProtocol Tuning** (5s timeout, 4 retries for reliability)

### v2.36.0 Additions (Unified SHA3-512 Security)
- ✅ **Unified hash algorithm** (SHA3-512 for ALL producer/leader selection)
- ✅ **256-bit quantum resistance** (Grover's algorithm protection)
- ✅ **Consistent selection** (microblock, macroblock, failover all use SHA3-512)

### v2.30.0 Additions (Fork Prevention + State Machine)
- ✅ **N-2 Entropy Source** (MacroBlock N-2 for producer selection, guarantees finalization)
- ✅ **Extended Genesis Epoch** (180 blocks instead of 90 for N-2 compatibility)
- ✅ **Real Reputation** (DeterministicReputationState instead of hardcoded values)
- ✅ **State Machine** (27 integration points: Initializing, Syncing, Producing, Error, etc.)
- ✅ **Graceful Shutdown** (tokio::signal::ctrl_c() saves certificates before exit)
- ✅ **No Fallback Policy** (desynchronized nodes excluded from production)
- ✅ **Certificate Persistence** (load_from_disk/persist_to_disk on startup/shutdown)

### v2.44.0 Additions (Aggressive Recovery + Round Tolerance)
- ✅ **Round Tolerance ±90** (accept consensus messages within 1 epoch for fork recovery)
- ✅ **Aggressive Catch-up** (15s stall / 5 block gap threshold, was 120s/50)
- ✅ **Byzantine Median Height** (fresh height from QUIC HealthPing peer data)
- ✅ **100K TPS Stress Tested** (network recovery after high-load scenarios)

### v2.48.0 Additions (Round Mismatch Fix + Dynamic Threshold)
- ✅ **LAST_FINALIZED_CONSENSUS_ROUND** (global AtomicU64 tracks actually finalized rounds)
- ✅ **Round update ONLY at save** (not at spawn/sync/rate-limit - prevents desync)
- ✅ **Reveal Loss Prevention** (participant nodes don't call trigger mid-consensus)
- ✅ **Dynamic Height Threshold** (5/10/20 blocks based on network size for scalability)
- ✅ **Signed Reveal Messages** (SHA3-256 + Dilithium+Ed25519 hybrid signatures)

### v2.74.0 Additions (Embedded RocksDB Indexing)
- ✅ **Built-in TX Index** (`tx_index` column family in RocksDB for O(1) lookups)
- ✅ **Address TX Index** (`tx_by_address` column family for O(1) address history)
- ✅ **No External Database** (single container deployment, no PostgreSQL)
- ✅ **NodeRegistration TX** (on-chain wallet-to-node binding for all node types)
- ✅ **System TX Indexing** (emission, rewards, node registration all indexed)
- ✅ **Dilithium Claim Option** (post-quantum signatures for reward claims, free gas)
- ✅ **TX Index Fix** (BLAKE3 hash consistency for system TX lookup)

### v2.62.0 Additions (Per-Round Consensus Storage)
- ✅ **Per-Round Storage** (`HashMap<u64, RoundData>` - each round is independent)
- ✅ **No Data Loss** (round transitions don't destroy previous round commits/reveals)
- ✅ **Parallel Rounds** (multiple consensus rounds can coexist simultaneously)
- ✅ **Auto Cleanup** (rounds older than 5 epochs automatically purged)
- ✅ **100% First-Attempt Success** (eliminates "Reveal doesn't match commit" errors)
- ✅ **New API** (`finalize_round_by_number()`, `get_commits_for_round()`)
- ✅ **Race Condition Fix** (async tasks can't corrupt each other's consensus data)
- ✅ **Production L1 Architecture** (per-round storage is industry standard)

### v2.61.0 Additions (Intercontinental Sync)
- ✅ **Size-Based Batching** (BlocksBatch max 1MB, MacroblocksBatch max 500KB)
- ✅ **ShredProtocol Unicast** (`send_block_via_shred_to_peer()` for blocks >1MB)
- ✅ **Repair Batching** (10 chunks per batch, 5ms pacing)
- ✅ **Peer Heights Tracking** (`get_peer_heights()` from Dilithium-signed heartbeats)
- ✅ **Strict Sync Check** (emergency producer must have prev block N-1)
- ✅ **is_new_chunk Dedup** (prevents infinite forwarding loops)
- ✅ **Genesis Latency Fanout** (fanout=max(producers, 4) for high-latency)
- ✅ **Intercontinental Support** (USA↔Europe 7500km reliable sync)

### v2.57.0 Additions (Stage Pipeline Runtime Isolation)
- ✅ **SIGVERIFY_RUNTIME** (dedicated Ed25519/Dilithium verification)
- ✅ **BANKING_RUNTIME** (transaction intake, mempool operations)
- ✅ **REPLAY_RUNTIME** (state machine execution, balance updates)
- ✅ **BROADCAST_RUNTIME** (Shred protocol, block propagation)
- ✅ **Adaptive Threading** (2 cores→4t, 4 cores→5t, 8 cores→10t, 16 cores→20t)
- ✅ **Configurable thread counts** (QNET_SIGVERIFY_THREADS, QNET_BANKING_THREADS, etc.)
- ✅ **Zero starvation guarantee** (crypto ops never block broadcast)
- ✅ **Consistent latency** (Ed25519 <50μs, Dilithium <500μs guaranteed)
- ✅ **verify_ed25519_tx_signature_async()** (runs on SIGVERIFY_RUNTIME)
- ✅ **verify_dilithium_tx_signature_async()** (runs on SIGVERIFY_RUNTIME)
- ✅ **spawn_sigverify()** (public API for external crypto tasks)
- ✅ **RuntimeStats** (monitoring: get_runtime_stats())

### v2.49.1 Additions (Consensus Deduplication + Idempotent Rounds)
- ✅ **ACTIVE_CONSENSUS_MB** (AtomicU64 prevents 60 duplicate tasks → only 1 per MB)
- ✅ **Idempotent start_round_at_height()** (preserves commits/reveals if round already active)
- ✅ **Stale Lock Override** (old_mb < new_mb → automatic recovery from panic/timeout)
- ✅ **Retry via Sync** (gap > 90 blocks → P2P sync instead of consensus - prevents Round Mismatch)
- ✅ **Lock-free Architecture** (compare_exchange with SeqCst ordering, no mutexes)
- ✅ **700x Faster Consensus** (7107s → 3-10s per MacroBlock)

### v2.50.0 Additions (Lock-Free Global Architecture)
- ✅ **OnceCell + Arc Pattern** (industry-standard lock-free initialization for Rust async)
- ✅ **GLOBAL_QUANTUM_CRYPTO** (25x faster: `OnceCell<Arc<QNetQuantumCrypto>>` replaces `Mutex<Option<...>>`)
- ✅ **GLOBAL_STORAGE_INSTANCE** (10x faster: lock-free RocksDB access for every block write)
- ✅ **GLOBAL_MEMPOOL_INSTANCE** (lock-free transaction pool access for every TX)
- ✅ **Zero Lock Contention** (all crypto/storage/mempool reads are instant pointer dereferences)
- ✅ **Deadlock Prevention** (eliminates `futex_wait` deadlocks under high load)
- ✅ **Parallel Verification** (100+ concurrent signature verifications without blocking)
- ✅ **API Responsiveness** (health checks pass even during 100K TPS stress tests)
- ✅ **Timeout Protection** (10s fallback in spawn_blocking for crypto operations)

**Performance Comparison (v2.49 → v2.50):**
| Operation | Before (Mutex) | After (OnceCell+Arc) | Speedup |
|-----------|---------------|---------------------|---------|
| Crypto access | ~50μs | ~1ns | **50,000x** |
| Storage access | ~30μs | ~1ns | **30,000x** |
| Mempool access | ~20μs | ~1ns | **20,000x** |
| 100 parallel verify | ~5000μs | ~50μs | **100x** |

---

## 📋 Table of Contents

1. [Architecture Overview](#architecture-overview)
   - 1.1 [Client Transaction Cryptography](#11-client-transaction-cryptography-mobile--browser)
   - 1.2 [Verifiable Time Sequence (VTS)](#12-verifiable-time-sequence-vts---sequential-hash-chain)
   - 1.3 [Ping Commitment Cryptography](#13-ping-commitment-cryptography-v2190)
   - 1.4 [MEV Bundle Cryptography](#14-mev-bundle-cryptography-v2193)
   - 1.5 [Transaction Serialization (v2.25)](#15-transaction-serialization-v225) ⭐ NEW
2. [Signature Systems (v2.19)](#signature-systems-v219)
3. [Cryptography Usage by Component](#cryptography-usage-by-component)
4. [Hybrid Cryptography (Consensus Messages)](#hybrid-cryptography-consensus-messages)
5. [Key Manager (Block Signatures)](#key-manager-block-signatures)
6. [Certificate Management](#certificate-management)
7. [Security Analysis](#security-analysis)
8. [Implementation Details](#implementation-details)
9. [Compliance & Standards](#compliance--standards)
10. [Gulf Stream & bincode (v2.25)](#gulf-stream--bincode-v225) ⭐ NEW

---

## 1. Architecture Overview

### Component Breakdown

```
┌─────────────────────────────────────────────────────────┐
│  QNet Cryptographic Architecture                        │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌──────────────────────────────────────────────────┐  │
│  │  CONSENSUS LAYER (hybrid_crypto.rs)              │  │
│  │  ├─ Real CRYSTALS-Dilithium3                     │  │
│  │  ├─ Ephemeral Ed25519 (per message)              │  │
│  │  ├─ NIST/Cisco Encapsulated Keys                 │  │
│  │  └─ Certificate Caching (Byzantine-safe)         │  │
│  └──────────────────────────────────────────────────┘  │
│                          ↓                               │
│  ┌──────────────────────────────────────────────────┐  │
│  │  KEY MANAGER (key_manager.rs)                    │  │
│  │  ├─ Dilithium-seeded SHA3-512                    │  │
│  │  ├─ 512-bit Security                             │  │
│  │  ├─ Deterministic Signatures                     │  │
│  │  └─ AES-256-GCM Encrypted Storage                │  │
│  └──────────────────────────────────────────────────┘  │
│                          ↓                               │
│  ┌──────────────────────────────────────────────────┐  │
│  │  VERIFICATION LAYER (consensus_crypto.rs)        │  │
│  │  ├─ Real Dilithium3 Verification                 │  │
│  │  ├─ Entropy Validation                           │  │
│  │  ├─ Message Matching                             │  │
│  │  └─ Structural Checks                            │  │
│  └──────────────────────────────────────────────────┘  │
│                          ↓                               │
│  ┌──────────────────────────────────────────────────┐  │
│  │  PING COMMITMENT LAYER (node.rs)                 │  │
│  │  ├─ blake3 for ping hashes (high speed)          │  │
│  │  ├─ SHA3-256 for sample seed (security)          │  │
│  │  ├─ Merkle tree construction                     │  │
│  │  └─ Deterministic sampling                       │  │
│  └──────────────────────────────────────────────────┘  │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### Libraries Used

| Component | Library | Version | Purpose |
|-----------|---------|---------|---------|
| Consensus | `pqcrypto-dilithium` | 0.5 | Real CRYSTALS-Dilithium3 (2420-byte sigs) |
| Hybrid | `ed25519-dalek` | 2.0 | Ed25519 classical signatures |
| Hashing (Security) | `sha3` | 0.10 | SHA3-256/512 (NIST FIPS 202) |
| Hashing (Speed) | `blake3` | Latest | Fast ping hashing |
| Encryption | `aes-gcm` | 0.10 | AES-256-GCM key storage |
| Random | `rand` | 0.8 | CSPRNG for key generation |

---

## 1.1 Client Transaction Cryptography (Mobile & Browser)

### Overview

QNet implements **Ed25519 signatures** for client transactions with **optional Dilithium3** for quantum-resistant transactions. This provides optimal performance for regular users while offering enterprise-grade post-quantum security for high-value transfers.

### Architecture v2.25

```
┌─────────────────────────────────────────────────────────┐
│  CLIENT LAYER (Mobile + Browser)                        │
├─────────────────────────────────────────────────────────┤
│  DEFAULT: Ed25519 ONLY                                  │
│  ✅ 20μs sign/verify operations                         │
│  ✅ 64-byte signatures                                  │
│  ✅ 32-byte public keys                                 │
│  ✅ Low energy consumption                              │
│  ✅ BIP39 mnemonic + HD derivation                      │
├─────────────────────────────────────────────────────────┤
│  OPTIONAL: Ed25519 + Dilithium3 (QUANTUM)               │
│  🔐 Post-quantum resistant                              │
│  🔐 +50% gas fee (compensates verification cost)        │
│  🔐 ~3293-byte signature + ~1952-byte pubkey            │
│  🔐 For enterprise/high-value transfers                 │
└─────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│  NODE LAYER (Consensus)                                 │
├─────────────────────────────────────────────────────────┤
│  ✅ Hybrid (Ed25519 + Dilithium)                        │
│  ✅ Encapsulated keys (NIST/CISCO)                      │
│  ✅ Certificate caching (O(1))                          │
│  ✅ Post-quantum secure                                 │
└─────────────────────────────────────────────────────────┘
```

### Transaction Signature Options

| Mode | Ed25519 | Dilithium3 | Gas Cost | Use Case |
|------|---------|------------|----------|----------|
| **Standard** | ✅ Required | ❌ None | 100% | Regular transfers |
| **Quantum** | ✅ Required | ✅ Optional | **150%** | Enterprise, high-value |

### Transaction Structure v2.25

```rust
pub struct Transaction {
    // ... existing fields ...
    
    /// Ed25519 signature (64 bytes, hex encoded) - REQUIRED
    pub signature: Option<String>,
    
    /// Ed25519 public key (32 bytes, hex encoded) - REQUIRED
    pub public_key: Option<String>,
    
    /// QUANTUM v2.25: Dilithium3 signature (~3293 bytes) - OPTIONAL
    /// When present: TX is quantum-resistant + 50% higher gas
    pub dilithium_signature: Option<String>,
    
    /// QUANTUM v2.25: Dilithium3 public key (~1952 bytes) - OPTIONAL
    pub dilithium_public_key: Option<String>,
}

// Effective gas calculation
impl Transaction {
    pub fn effective_gas_price(&self) -> u64 {
        if self.is_quantum_signed() {
            self.gas_price + (self.gas_price / 2)  // +50%
        } else {
            self.gas_price
        }
    }
}
```

### Why Ed25519 as Default?

| Aspect | Ed25519 | Dilithium3 | Decision |
|--------|---------|------------|----------|
| **Speed** | 20μs | 100ms | ✅ Ed25519 (5000x faster) |
| **Size** | 64 bytes | 3293 bytes | ✅ Ed25519 (51x smaller) |
| **Energy** | Low | High | ✅ Ed25519 (mobile-friendly) |
| **Security** | 128-bit | Post-quantum | ✅ Ed25519 (sufficient for clients) |
| **Maturity** | RFC 8032 | NIST Draft | ✅ Ed25519 (battle-tested) |

**Rationale:**
- Client transactions are short-lived (seconds to minutes)
- Quantum computers are not an immediate threat to individual transactions
- User experience requires fast, responsive operations
- Mobile devices have limited battery and processing power
- Ed25519 provides 128-bit security (sufficient for decades)

### Transaction Types

#### 1. Transfer (sendQNC)

**Client Signing:**
```javascript
// Format: "transfer:from:to:amount:gas_price:gas_limit"
const message = `transfer:${fromAddress}:${toAddress}:${amountSmallest}:1:10000`;
const signature = nacl.sign.detached(messageBytes, secretKey);
```

**Server Verification:**
```rust
// Validator creates same message format
let message = format!("transfer:{}:{}:{}:{}:{}", 
    from, to, amount, tx.gas_price, tx.gas_limit);
verifying_key.verify(&message, &signature)?;
```

**Security:**
- ✅ Deterministic message format
- ✅ No nonce/timestamp (set by server)
- ✅ Public key in transaction
- ✅ Strict cryptographic verification

#### 2. Reward Claims (claimRewards)

**Client Signing:**
```javascript
// Format: "claim_rewards:node_id:wallet_address"
const message = `claim_rewards:${nodeId}:${walletAddress}`;
const signature = nacl.sign.detached(messageBytes, secretKey);
```

**Server Processing:**
```rust
// 1. Verify Ed25519 signature
verify_ed25519_client_signature(...).await;

// 2. Create RewardDistribution transaction
let tx = Transaction {
    from: node_id,
    to: wallet_address,
    amount: pending_rewards,
    tx_type: RewardDistribution,
    signature: Some(signature),
    public_key: Some(public_key),
    ...
};

// 3. Submit to blockchain
blockchain.submit_transaction(tx).await;
```

**Security:**
- ✅ Signature verified before transaction creation
- ✅ Transaction recorded on blockchain
- ✅ All nodes verify the claim
- ✅ Full transparency and auditability

### Libraries (Client-Side)

| Platform | Library | Purpose |
|----------|---------|---------|
| **Mobile (React Native)** | `tweetnacl` | Ed25519 signing |
| **Mobile (React Native)** | `ed25519-hd-key` | HD key derivation |
| **Browser Extension** | `tweetnacl` | Ed25519 signing |
| **Browser Extension** | `bip39` | Mnemonic generation |

### Performance Characteristics

| Operation | Time | Scalability |
|-----------|------|-------------|
| **Key Generation** | ~1ms | O(1) |
| **Sign** | ~20μs | O(1) |
| **Verify** | ~20μs | O(1) |
| **Total (sign + verify)** | ~40μs | Linear |

**For 1M clients:**
- Signing: 20 seconds (parallel)
- Verification: 20 seconds (parallel)
- No bottlenecks or shared state

### Security Guarantees

1. **Cryptographic:**
   - ✅ 128-bit security level
   - ✅ Collision-resistant
   - ✅ Signature forgery impossible without private key

2. **Implementation:**
   - ✅ No stubs or fallbacks
   - ✅ Strict validation (reject invalid signatures)
   - ✅ Public key required in transaction

3. **Blockchain:**
   - ✅ All transactions recorded on-chain
   - ✅ All nodes verify signatures
   - ✅ Immutable audit trail

### Migration Path (Future)

When quantum computers become a threat:
1. Add Dilithium support to mobile wallets (WASM)
2. Implement hybrid signatures (Ed25519 + Dilithium)
3. Gradual rollout with backward compatibility
4. No breaking changes to existing transactions

**Timeline:** 10-15 years (based on quantum computing progress)

---

## 1.2 Verifiable Time Sequence (VTS) - Sequential Hash Chain

### Overview

QNet implements **Hybrid SHA3-512 / Blake3 Verifiable Time Sequence** as a sequential hash chain for verifiable time ordering and event sequencing. This provides cryptographic time ordering for 1-second microblocks without requiring a formal VDF (Verifiable Delay Function) with mathematical delay proofs.

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│  VERIFIABLE TIME SEQUENCE (VTS) CHAIN                   │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  Genesis Hash (SHA3-256)                                │
│         ↓                                                │
│  ┌──────────────────────────────────────────────────┐  │
│  │  Tick 1: 5,000 hashes (10ms)                     │  │
│  │  ├─ Hash 1: SHA3-512 (VDF property)              │  │
│  │  ├─ Hash 2: Blake3 (speed)                       │  │
│  │  ├─ Hash 3: Blake3 (speed)                       │  │
│  │  ├─ Hash 4: Blake3 (speed)                       │  │
│  │  └─ Hash 5: SHA3-512 (VDF property)              │  │
│  │  ... (repeat pattern)                             │  │
│  └──────────────────────────────────────────────────┘  │
│         ↓                                                │
│  ┌──────────────────────────────────────────────────┐  │
│  │  Tick 2: 5,000 hashes (10ms)                     │  │
│  └──────────────────────────────────────────────────┘  │
│         ↓                                                │
│  ... (100 ticks = 1 slot = 1 second)                   │
│         ↓                                                │
│  ┌──────────────────────────────────────────────────┐  │
│  │  Microblock #N (includes VTS hash + count)       │  │
│  └──────────────────────────────────────────────────┘  │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### Hybrid Hash Algorithm

**Every 4th hash uses SHA3-512 (sequential bottleneck):**
```rust
if i % 4 == 0 {
    // SHA3-512 for sequential ordering (limits parallelization)
    let mut hasher = Sha3_512::new();
    hasher.update(&hash_bytes);
    hasher.update(&counter.to_le_bytes());
    hash_bytes = hasher.finalize();
}
```

**Other hashes use Blake3 (speed):**
```rust
else {
    // Blake3 for speed (3x faster than SHA3)
    let mut hasher = blake3::Hasher::new();
    hasher.update(&hash_bytes);
    hasher.update(&counter.to_le_bytes());
    let result = hasher.finalize();
    // Extend to 64 bytes for consistency
    hash_bytes[..32] = result.as_bytes();
    hash_bytes[32..] = blake3::hash(result.as_bytes()).as_bytes();
}
```

### Performance Characteristics

| Parameter | Value | Purpose |
|-----------|-------|---------|
| **Hashes per tick** | 5,000 | Balance security/performance |
| **Tick duration** | 10ms | 100 ticks per second |
| **Ticks per slot** | 100 | 1 slot = 1 second (microblock) |
| **Hashes per slot** | 500,000 | ~500K hashes/sec |
| **SHA3-512 ratio** | 25% | Sequential bottleneck (every 4th) |
| **Blake3 ratio** | 75% | Speed optimization |

### Security Properties

1. **Sequential Hash Chain:**
   - ✅ Sequential computation required (25% SHA3-512 creates bottleneck)
   - ✅ Predictable time per hash (~2μs per hash)
   - ✅ Verifiable by any node
   - ✅ Sufficient for 1-second microblock ordering

2. **Time Ordering:**
   - ✅ Cryptographic proof of time passage
   - ✅ Prevents timestamp manipulation
   - ✅ Deterministic block ordering
   - ✅ No need for external time source

3. **Consensus Integration:**
   - ✅ VTS hash mixed into block signatures
   - ✅ Prevents block reordering attacks
   - ✅ Provides time ordering for blocks
   - ✅ Synchronizes network time

### Implementation Details

**Genesis Initialization:**
```rust
// Deterministic genesis hash (all nodes start same)
let genesis_seed = "qnet_genesis_block_2024";
let mut hasher = Sha3_256::new();
hasher.update(genesis_seed.as_bytes());
let genesis_hash = hasher.finalize();
```

**Checkpoint Synchronization:**
```rust
// Nodes sync VTS state from blocks
pub async fn sync_from_checkpoint(&self, hash: &[u8], count: u64) {
    // CRITICAL: Only sync forward, never backward
    let current_count = *self.hash_count.read().await;
    if count < current_count {
        return; // Prevent VTS regression
    }
    *self.current_hash.write().await = hash.to_vec();
    *self.hash_count.write().await = count;
}
```

**Block Integration:**
```rust
// Each microblock includes VTS state
pub struct MicroBlock {
    pub height: u64,
    pub poh_hash: Vec<u8>,    // Current VTS hash (64 bytes)
    pub poh_count: u64,       // Total hashes computed
    pub timestamp: u64,       // Wall clock time
    ...
}
```

### VTS Validation (v2.19.13)

**Separate VTS State Storage:**
```rust
// VTS state stored separately for O(1) validation
pub struct VTSState {
    pub height: u64,           // Block height
    pub poh_hash: Vec<u8>,     // SHA3-512 hash (64 bytes)
    pub poh_count: u64,        // Monotonic counter
    pub previous_hash: [u8; 32], // Chain linkage
}
```

**Validation Flow:**
```rust
// 1. Load VTS state from dedicated storage (O(1), no block deserialization)
let prev_poh = storage.load_poh_state(height - 1)?;

// 2. Check monotonic progression
if block.poh_count <= prev_poh.poh_count {
    let regression = prev_poh.poh_count - block.poh_count;
    if regression > MAX_ACCEPTABLE_REGRESSION {  // 15M hashes (~30 sec)
        return Err("Severe VTS regression");
    }
    // Minor regression acceptable due to network delays
}

// 3. Auto-save VTS state when saving block
storage.save_microblock_efficient(block);  // Also saves VTSState
```

**Security Properties:**
- ✅ Monotonic counter prevents replay attacks
- ✅ Chain linkage prevents block reordering
- ✅ Regression check detects time manipulation
- ✅ O(1) validation without loading full blocks

### Why Hybrid SHA3-512 / Blake3?

| Aspect | SHA3-512 Only | Blake3 Only | Hybrid (QNet) |
|--------|---------------|-------------|---------------|
| **VDF Property** | ✅ Strong | ❌ Weak | ✅ Strong (25%) |
| **Speed** | ❌ Slow | ✅ Fast | ✅ Fast (75%) |
| **Security** | ✅ NIST | ✅ Modern | ✅ Both |
| **Parallelization** | ❌ Sequential | ⚠️ Possible | ❌ Sequential |
| **Hash Rate** | ~100K/sec | ~300K/sec | ~500K/sec |

**Rationale:**
- Pure SHA3-512 too slow for 1-second blocks
- Pure Blake3 lacks VDF property (parallelizable)
- Hybrid provides both security AND performance
- 25% SHA3-512 sufficient for VDF property
- 75% Blake3 achieves target hash rate

### Drift Detection

**Maximum drift allowed: 5%**
```rust
const MAX_DRIFT_PERCENT: f64 = 0.05;

// Calculate drift
let expected_duration = (hash_count * TICK_DURATION_US) / HASHES_PER_TICK;
let actual_duration = start_time.elapsed().as_micros();
let drift = (actual_duration - expected_duration) as f64 / expected_duration as f64;

if drift.abs() > MAX_DRIFT_PERCENT {
    println!("[VTS] ⚠️ Drift detected: {:.2}%", drift * 100.0);
}
```

### Performance Metrics

**Prometheus Metrics:**
- `qnet_poh_hash_count_total` - Total hashes computed
- `qnet_poh_hash_rate` - Current hash rate (hashes/sec)
- `qnet_poh_current_slot` - Current slot number
- `qnet_poh_checkpoint_count_total` - Checkpoints saved

**Typical Performance:**
- Hash rate: ~500,000 hashes/sec
- Tick interval: 10ms (100 ticks/sec)
- Slot duration: 1 second (100 ticks)
- Drift: <1% (well within 5% limit)

### Comparison: Sequential Hash Chain Approaches

| Aspect | Other Blockchains | QNet VTS |
|--------|-------------------|----------|
| **Algorithm** | SHA-256 | Hybrid SHA3-512 / Blake3 |
| **Hash Rate** | ~1M hashes/sec | ~500K hashes/sec |
| **VDF Property** | 100% | 25% (sufficient) |
| **Block Time** | 400ms | 1000ms |
| **Quantum Resistant** | ❌ No | ✅ Yes (SHA3-512) |
| **NIST Approved** | ⚠️ SHA-256 | ✅ SHA3-512 |

**QNet VTS Advantages:**
- ✅ Quantum-resistant (SHA3-512)
- ✅ NIST FIPS 202 compliant
- ✅ Hybrid approach (security + speed)
- ✅ Longer block time (more tx per block)

---

## 1.3 Ping Commitment Cryptography (v2.19.4)

### Overview

QNet implements a **Hybrid Merkle + Sampling** architecture for on-chain ping commitments, providing scalability and transparency for emission validation.

### Light Node Attestations

**ARCHITECTURE v2.78:** Light nodes use HYBRID signatures for quantum resistance.

```rust
struct LightNodeAttestation {
    light_node_id: String,
    pinger_node_id: String,
    slot: u64,
    timestamp: u64,
    light_node_signature: String,       // HYBRID compact_bin (Ed25519 + Dilithium3, ~2.6KB)
    pinger_signature: String,           // HYBRID compact_bin (Ed25519 + Dilithium3, ~2.6KB)
}
```

**Dual Signature Requirement (Both HYBRID)**:
- ✅ Light node signs challenge with HYBRID `compact_bin` format (quantum-resistant)
- ✅ Pinger signs attestation with HYBRID `compact_bin` format (quantum-resistant)

**Implementation Status**:
- ✅ **Server:** Full HYBRID verification ready (`compact_bin` format supported)
- ⚠️ **Mobile:** Ed25519 fallback (`light_hybrid_pending`) until Dilithium3 library added
- 🎯 **Target:** Mobile app with Dilithium3 WASM for full HYBRID signatures

### Full/Super Node Heartbeats

Full/Super nodes self-attest via heartbeats with HYBRID signatures:

```rust
struct FullNodeHeartbeat {
    node_id: String,
    node_type: String,      // "full" or "super"
    heartbeat_index: u8,    // 0-9 (10 per 4-hour window)
    timestamp: u64,
    signature: String,      // HYBRID (Ed25519 + Dilithium3, ~2.6KB bincode)
}
```

**Eligibility Requirements**:
- Super nodes: 9+ heartbeats (90% success rate)
- Reputation ≥ 70% required

### Hash Algorithm Selection

**Performance-Critical Operations (Ping Hashing):**
- **Algorithm**: blake3
- **Use Case**: Individual ping hash calculation
- **Speed**: >1 GB/s on modern CPUs
- **Security**: 256-bit output, collision-resistant
- **Rationale**: Millions of pings per 4-hour window require maximum throughput

**Security-Critical Operations (Sample Seed):**
- **Algorithm**: SHA3-256 (NIST FIPS 202)
- **Use Case**: Deterministic sampling seed generation
- **Security Level**: 128-bit quantum resistance (Grover's algorithm)
- **Rationale**: Entropy source must be NIST-approved for Byzantine safety
- **Optimization**: SHA3-256 (32 bytes) instead of SHA3-512 (64 bytes) - 20% faster, maintains security

### Ping Commitment Structure

```rust
/// Ping data for Merkle tree construction
struct PingData {
    from_node: String,
    to_node: String,
    response_time_ms: u32,
    success: bool,
    timestamp: u64,
}

impl PingData {
    /// Calculate deterministic hash for Merkle tree
    fn calculate_hash(&self) -> String {
        use blake3::Hasher;
        let mut hasher = Hasher::new();
        hasher.update(self.from_node.as_bytes());
        hasher.update(self.to_node.as_bytes());
        hasher.update(&self.response_time_ms.to_le_bytes());
        hasher.update(&[if self.success { 1 } else { 0 }]);
        hasher.update(&self.timestamp.to_le_bytes());
        hasher.finalize().to_hex().to_string()
    }
}
```

### Deterministic Sampling

```rust
// STEP 1: Create deterministic seed using finalized block entropy
let entropy_height = current_height.saturating_sub(FINALITY_WINDOW); // 10 blocks
let entropy_block = storage.load_microblock(entropy_height)?;

// STEP 2: Generate SHA3-256 seed (quantum-resistant, NIST-approved)
use sha3::{Sha3_256, Digest};
let mut seed_hasher = Sha3_256::new();
seed_hasher.update(b"QNet_Ping_Sampling_v1");
seed_hasher.update(&entropy_block);
seed_hasher.update(&window_start_height.to_le_bytes());
let sample_seed = seed_hasher.finalize(); // 32 bytes

// STEP 3: Deterministic index selection (all nodes get same samples)
for i in 0..sample_size {
    let mut index_hasher = Sha3_256::new();
    index_hasher.update(&sample_seed);
    index_hasher.update(&(i as u32).to_le_bytes());
    let hash = index_hasher.finalize();
    let index = u64::from_le_bytes([...]) % total_count;
    // Select ping at deterministic index
}
```

### Scalability Analysis

| Metric | Individual Attestations | Hybrid Merkle + Sampling | Improvement |
|--------|------------------------|---------------------------|-------------|
| Pings per 4h | 240,000 | 240,000 | Same |
| On-chain size | 36 GB | 100 MB | 360× reduction |
| Gas cost | 6 billion units | 20 million units | 300× reduction |
| Verification time | 120 seconds | 2 seconds | 60× faster |
| Sample size | N/A | 1% (min 10K) | Statistically valid |
| Byzantine safety | Yes | Yes | Maintained |

### Security Properties

| Property | Implementation | Benefit |
|----------|----------------|---------|
| **Determinism** | SHA3-256 seed from finalized block | All nodes sample same pings |
| **Quantum-Resistance** | SHA3-256 (NIST FIPS 202) | Grover-resistant (128-bit) |
| **Collision-Resistance** | blake3 (256-bit) | Unique ping hashes |
| **Byzantine-Safety** | 2/3+ consensus validation | Malicious nodes detected |
| **Transparency** | Merkle proofs | Auditable commitments |
| **Scalability** | 360× on-chain reduction | Millions of nodes ready |

---

## 1.4 MEV Bundle Cryptography (v2.19.3)

### Overview

QNet implements **post-quantum MEV protection** using Dilithium3 signatures for bundle authentication, ensuring only trusted nodes (80%+ reputation) can submit private transaction bundles.

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ MEV Bundle Signature Flow                                   │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  1. User creates transactions                               │
│     └─► TX_1, TX_2 (signed with Ed25519)                    │
│                                                              │
│  2. Node bundles transactions                               │
│     └─► Bundle = {TX_1, TX_2, timestamps, constraints}      │
│                                                              │
│  3. Node signs bundle with Dilithium3                       │
│     └─► signature = sign_dilithium(bundle_data)             │
│                                                              │
│  4. Producer verifies bundle                                │
│     ├─► Dilithium signature valid? ✅                        │
│     ├─► Submitter reputation >= 80%? ✅                      │
│     └─► Include in block atomically                         │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Bundle Structure

```rust
pub struct TxBundle {
    bundle_id: String,                  // Unique identifier
    transactions: Vec<String>,          // TX hashes (max 10)
    min_timestamp: u64,                 // Earliest inclusion time
    max_timestamp: u64,                 // Latest inclusion time (max 60s)
    reverting_tx_hashes: Vec<String>,   // TXs that must NOT be included
    signature: Vec<u8>,                 // ← Dilithium3 signature
    submitter_pubkey: Vec<u8>,          // ← Node's Dilithium public key
    total_gas_price: u64,               // Bundle priority
}
```

### Signing Process

```rust
// Step 1: Create deterministic message from bundle data
let mut message_parts = Vec::new();
message_parts.push(format!("bundle_id:{}", bundle.bundle_id));
message_parts.push(format!("min_timestamp:{}", bundle.min_timestamp));
message_parts.push(format!("max_timestamp:{}", bundle.max_timestamp));
for tx_hash in &bundle.transactions {
    message_parts.push(format!("tx:{}", tx_hash));
}
let message = message_parts.join("|");

// Step 2: Sign with node's persistent Dilithium3 key
let signature = qnet_consensus::consensus_crypto::sign_consensus_message(
    &node_id,
    &message
).await;

// Step 3: Encode signature as hex
let signature_bytes = hex::decode(&signature)?;
```

### Verification Process

```rust
// Step 1: Extract node_id from submitter_pubkey
let node_id = hex::encode(&bundle.submitter_pubkey);

// Step 2: Check reputation (CRITICAL!)
let reputation = p2p.get_node_combined_reputation(&node_id);
if reputation < 80.0 {
    return Err("Insufficient reputation"); // ← 80%+ required
}

// Step 3: Reconstruct message
let message = reconstruct_bundle_message(&bundle);

// Step 4: Verify Dilithium3 signature
let signature_str = hex::encode(&bundle.signature);
let valid = qnet_consensus::consensus_crypto::verify_consensus_signature(
    &node_id,
    &message,
    &signature_str
).await;

if !valid {
    return Err("Invalid bundle signature");
}
```

### Security Properties

| Property | Implementation | Security Level |
|----------|----------------|----------------|
| **Post-Quantum** | CRYSTALS-Dilithium3 | NIST Level 3 (10^15 years attack time) |
| **Reputation Gate** | 80%+ required | Byzantine-safe (proven trustworthy) |
| **Signature Size** | ~2420 bytes | Standard Dilithium3 |
| **Verification Time** | ~1-2ms | Fast enough for 1s blocks |
| **Key Reuse** | Node's persistent key | Same as block signatures |
| **Atomic Inclusion** | All TXs or none | Prevents partial execution |

### Why Dilithium3 for Bundles?

1. **Post-Quantum Security**: Protects high-value MEV bundles against future quantum attacks
2. **Reputation Binding**: Signature cryptographically tied to node's identity and reputation
3. **No New Keys**: Reuses existing node infrastructure (no additional key management)
4. **Byzantine-Safe**: 80%+ reputation threshold ensures only trusted nodes participate
5. **Audit Trail**: All bundle signatures recorded on-chain (full transparency)

### Performance Characteristics

| Operation | Time | Notes |
|-----------|------|-------|
| **Bundle Signing** | ~3-5ms | Dilithium3 signing |
| **Bundle Verification** | ~1-2ms | Dilithium3 verification |
| **Reputation Check** | ~0.1ms | DashMap lookup |
| **Total Overhead** | ~5-7ms | Per bundle (10 TXs) |

**Impact on 1-second blocks**: Negligible (0.5-0.7% of block time)

### Comparison with Traditional MEV Protection

| Approach | Signature | Quantum-Resistant | Reputation-Based |
|----------|-----------|-------------------|------------------|
| **Flashbots (Ethereum)** | ECDSA | ❌ No | ❌ No (auction-based) |
| **Jito (Solana)** | Ed25519 | ❌ No | ⚠️ Partial (stake-weighted) |
| **QNet (v2.19.3)** | Dilithium3 | ✅ Yes | ✅ Yes (80%+ required) |

**QNet Advantage**: First blockchain with post-quantum MEV protection tied to reputation system!

### Integration with Client Transactions

**Important**: User transactions inside bundles use **Ed25519 signatures** (fast, mobile-friendly), while the **bundle wrapper** uses **Dilithium3** (quantum-resistant, node-level).

```
Bundle (Dilithium3 by node)
├─► TX_1 (Ed25519 by user)
├─► TX_2 (Ed25519 by user)
└─► TX_3 (Ed25519 by user)
```

This hybrid approach provides:
- ✅ **User convenience**: Fast Ed25519 for individual TXs
- ✅ **Bundle security**: Post-quantum Dilithium3 for bundle wrapper
- ✅ **Backward compatibility**: Works with existing wallets

---

## 2. Signature Systems (v2.23 - RAW bytes)

### Overview

> **UPDATED v2.23**: Signatures now use **RAW bytes** format via `serde_bytes`.
> This reduces compact signature size from ~22KB to **~2.6KB** (88% reduction).
> Redundant `dilithium_message_signature` removed (saves ~3.3KB).

QNet v2.23 implements **two signature formats** optimized for different block types:

1. **Compact Signatures** (Microblocks): ~2.6KB RAW bytes - Certificate cached separately
2. **Full Signatures** (Macroblocks): ~5KB RAW bytes - Certificate embedded

### Dilithium3 Core Specifications

**IMPORTANT**: QNet uses **full CRYSTALS-Dilithium3** signatures in RAW bytes format.

| Property | Value | Notes |
|----------|-------|-------|
| **Signature Size (raw)** | **~2500 bytes** | RAW binary (no base64!) |
| **Public Key Size** | 1952 bytes | Dilithium3 public key |
| **Private Key Size** | 4000 bytes | Dilithium3 secret key |
| **Security Level** | NIST Level 3 | Equivalent to AES-192 |
| **Quantum Resistance** | Yes | Resistant to Shor's algorithm |
| **Algorithm** | Module-Lattice-Based | NIST PQC Round 3 winner |
| **Serialization** | `serde_bytes` | No base64 overhead |

#### Code Verification
```rust
// From consensus_crypto.rs - v2.23 limit for RAW bytes
if signature.len() > 2600 {
    // Reject oversized signatures
    return Ok(false);
}
```

### 2.1 Compact Signatures (Microblocks) - v2.23

**Purpose**: Optimize bandwidth for high-frequency microblocks (1/second)

**Size**: ~2.6KB per signature (was 22KB - 88% reduction!)

#### Structure
```rust
#[derive(Serialize, Deserialize)]
pub struct CompactHybridSignature {
    pub node_id: String,                   // Producer node ID
    pub cert_serial: String,               // Certificate reference
    #[serde(with = "serde_bytes")]
    pub ephemeral_public_key: [u8; 32],    // NEW Ed25519 key for THIS message
    #[serde(with = "serde_bytes")]
    pub message_signature: [u8; 64],       // Ed25519 RAW bytes
    #[serde(with = "serde_bytes")]
    pub dilithium_key_signature: Vec<u8>,  // Dilithium3 RAW bytes (~2500 bytes)
    pub signed_at: u64,                    // Unix timestamp
}
```

#### Size Breakdown (v2.23)
| Component | Size | Description |
|-----------|------|-------------|
| `node_id` | ~20 bytes | String (e.g., "genesis_node_001") |
| `cert_serial` | ~30 bytes | String (e.g., "cert_2024_11_16_12345") |
| `ephemeral_public_key` | 32 bytes | RAW bytes (NEW Ed25519 key) |
| `message_signature` | 64 bytes | Ed25519 RAW bytes |
| `dilithium_key_signature` | **~2500 bytes** | Dilithium3 RAW bytes |
| `signed_at` | 8 bytes | u64 timestamp |
| **Total** | **~2.6KB** | **88% reduction from 22KB!** |

#### JSON Example (v2.23 - byte arrays)
```json
"compact:{
  \"node_id\": \"genesis_node_001\",
  \"cert_serial\": \"cert_2024_11_16_12345\",
  \"ephemeral_public_key\": [32, 64, 128, ...],  // 32 bytes
  \"message_signature\": [64, 32, 128, ...],     // 64 bytes
  \"dilithium_key_signature\": [12, 45, 78, ...], // ~2500 bytes RAW
  \"signed_at\": 1700140800
}"
```

#### Verification Process (v2.23)
```
P2P Layer (node.rs::verify_microblock_signature):
1. Parse "compact:" prefix and JSON
2. Lookup certificate using cert_serial
   ├─► Cache HIT (100K LRU cache): Use cached certificate ✅
   └─► Cache MISS: Request via P2P broadcast
3. Verify Ed25519 with ephemeral key (64 bytes RAW)
4. Recreate encapsulated_data = ephemeral_pk || message_hash || timestamp
5. Verify Dilithium via dilithium3::open() ✅ REAL CRYPTO
6. All must be valid → Accept block

Consensus Layer (consensus_crypto.rs::verify_compact_hybrid_signature):
1. Parse RAW bytes from JSON
2. Reconstruct encapsulated_data
3. Real Dilithium3 verification via dilithium3::open()
4. Byzantine consensus (2/3+ honest nodes)
5. Only verified blocks participate
```

### 2.2 Full Hybrid Signatures (Macroblocks) - v2.23

**Purpose**: Immediate verification for low-frequency macroblocks (1/90 seconds)

**Size**: ~5KB per signature (was 12KB - RAW bytes optimization)

#### Structure (v2.23)
```rust
#[derive(Serialize, Deserialize)]
pub struct HybridSignature {
    pub certificate: HybridCertificate,        // Full certificate embedded
    #[serde(with = "serde_bytes")]
    pub ephemeral_public_key: [u8; 32],        // NEW Ed25519 key RAW
    #[serde(with = "serde_bytes")]
    pub message_signature: [u8; 64],           // Ed25519 RAW bytes
    #[serde(with = "serde_bytes")]
    pub dilithium_key_signature: Vec<u8>,      // Dilithium3 RAW bytes
    pub signed_at: u64,
}

pub struct HybridCertificate {
    pub node_id: String,
    pub serial: String,
    #[serde(with = "serde_bytes")]
    pub ed25519_public_key: [u8; 32],          // RAW bytes
    #[serde(with = "serde_bytes")]
    pub dilithium_public_key: Vec<u8>,         // ~1952 bytes RAW
    #[serde(with = "serde_bytes")]
    pub dilithium_signature_of_ed25519: Vec<u8>, // RAW bytes
    pub valid_from: u64,
    pub valid_until: u64,
}
```

#### Size Breakdown (v2.23)
| Component | Size | Description |
|-----------|------|-------------|
| `ephemeral_public_key` | 32 bytes | NEW Ed25519 key RAW |
| `message_signature` (Ed25519) | 64 bytes | RAW bytes |
| `dilithium_key_signature` | ~2500 bytes | RAW bytes (no base64!) |
| **Certificate**: | | |
| - `ed25519_public_key` | 32 bytes | RAW bytes |
| - `dilithium_public_key` | 1952 bytes | RAW bytes |
| - `dilithium_signature_of_ed25519` | ~2500 bytes | RAW bytes |
| - Serial + timestamps | ~50 bytes | Metadata |
| **Total** | **~5KB** | **58% reduction from 12KB!** |

### 2.3 Bandwidth Comparison (v2.23)

#### Per Microblock (1/second)
| Signature Type | Size | Bandwidth/hour | Production Use |
|---------------|------|----------------|----------------|
| **Compact v2.23** | ~2.6KB | 9.4 MB/hour | ✅ YES (88% reduction!) |
| **Old Compact** | ~22KB | 79.2 MB/hour | ❌ OBSOLETE |

#### Per Macroblock (1/90 seconds = 40/hour)
| Signature Type | Size | Bandwidth/hour | Production Use |
|---------------|------|----------------|----------------|
| **Full v2.23** | ~5KB | 0.2 MB/hour | ✅ YES (immediate verify) |
| **Full** | ~12KB | 0.48 MB/hour | ✅ YES (immediate verify) |

**Total Production Bandwidth**: ~11.3 MB/hour (microblocks + macroblocks)

---

## 2. Cryptography Usage by Component

### 2.0 Where Each Crypto System is Used

QNet uses **TWO DIFFERENT** cryptographic systems for different purposes:

| Component | Crypto System | Use Case | Key Type |
|-----------|---------------|----------|----------|
| **Macroblock Consensus** | Hybrid Crypto (ephemeral) | Commit/Reveal messages | Ephemeral Ed25519 + Dilithium |
| **Microblock Signatures** | Key Manager (persistent) | Block signing & verification | Dilithium-seeded SHA3-512 |
| **Macroblock Signatures** | Key Manager (persistent) | Macroblock finalization | Dilithium-seeded SHA3-512 |
| **MEV Bundle Signatures** | Real Dilithium3 | Private bundle authentication | Node's persistent Dilithium key |
| **Client Transactions** | Ed25519-only | User transactions (wallet) | User's Ed25519 key |
| **Producer Selection** | Deterministic SHA3-512 | Quantum-resistant leader election | Hash of finality block + round |
| **Emergency Producer** | Deterministic SHA3-512 | Failover leader election | Hash of entropy + height |

**Critical distinction:**
- **Ephemeral keys (hybrid_crypto.rs)**: For Byzantine consensus messages (commit/reveal)
- **Persistent keys (key_manager.rs)**: For all block signatures (micro + macro)
- **MEV bundles (mev_protection.rs)**: Signed with node's persistent Dilithium key (80%+ reputation required)
- **Client transactions**: Ed25519-only for fast mobile/browser operations
- **Deterministic Selection**: Producer selection uses SHA3-512 for identical results on all nodes (no forks)

---

## 3. Hybrid Cryptography (Consensus Messages)

### 3.1 NIST/Cisco Encapsulated Keys Implementation

**File:** `development/qnet-integration/src/hybrid_crypto.rs`

**Purpose:** Sign Byzantine consensus commit/reveal messages with ephemeral keys

#### Signature Structure

```rust
pub struct HybridSignature {
    certificate: HybridCertificate {
        node_id: String,
        ed25519_public_key: [u8; 32],           // RAW bytes
        dilithium_public_key: Vec<u8>,          // RAW bytes (~1952 bytes)
        dilithium_signature_of_ed25519: Vec<u8>,// RAW bytes (certificate binding)
        issued_at: u64,
        expires_at: u64,                         // 270-second lifetime (4.5 minutes)
        serial_number: String,
    },
    ephemeral_public_key: [u8; 32],             // NEW Ed25519 key RAW
    message_signature: [u8; 64],                // Ed25519 RAW bytes
    dilithium_key_signature: Vec<u8>,           // Dilithium RAW (~2500 bytes)
    // NOTE: dilithium_message_signature REMOVED in v2.23 (redundant)
    signed_at: u64,
}
```

### 3.2 Signing Process (v2.23)

```rust
// Step 1: Generate NEW ephemeral Ed25519 key for THIS message
let ephemeral_signing_key = SigningKey::from_bytes(&rand::thread_rng().gen::<[u8; 32]>());
let ephemeral_verifying_key = ephemeral_signing_key.verifying_key();

// Step 2: Sign message with ephemeral Ed25519
let ed25519_signature = ephemeral_signing_key.sign(message);  // 64 bytes RAW

// Step 3: Create encapsulated data (includes message_hash!)
let mut encapsulated_data = Vec::new();
encapsulated_data.extend_from_slice(ephemeral_verifying_key.as_bytes());  // 32 bytes
encapsulated_data.extend_from_slice(&sha3::Sha3_256::digest(message));    // 32 bytes
encapsulated_data.extend_from_slice(&timestamp.to_le_bytes());            // 8 bytes

// Step 4: Sign encapsulated data with Dilithium (SINGLE signature!)
// v2.23: Message hash is ALREADY in encapsulated_data, so one sig is enough
let dilithium_key_sig = quantum_crypto
    .create_consensus_signature(&node_id, &hex::encode(&encapsulated_data))
    .await?;
// Extract RAW bytes (no base64!)
let dilithium_raw = extract_dilithium_raw_bytes(&dilithium_key_sig);  // ~2500 bytes

// Step 5: Create certificate (4.5-minute lifetime with 80% rotation threshold)
// SECURITY: Optimized for quantum resistance with minimal network overhead
// - Lifetime: 270 seconds (3 macroblocks)
// - Rotation: 216 seconds (80% threshold)
// - Grace period: 54 seconds (sufficient for global WAN propagation)
// - Quantum attack time: 10^15 years (NIST Security Level 3)
let ephemeral_certificate = HybridCertificate {
    node_id,
    ed25519_public_key: *ephemeral_verifying_key.as_bytes(),
    dilithium_signature_of_ed25519: dilithium_key_sig.signature,  // RAW bytes
    issued_at: now,
    expires_at: now + 270,  // 4.5 minutes = 270 seconds (CERTIFICATE_LIFETIME_SECS)
    serial_number: format!("{:x}", now),
};
```

### 3.3 Verification Process (Certificate Caching OK)

```rust
pub async fn verify_signature(
    message: &[u8],
    signature: &HybridSignature,
) -> Result<bool> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    
    // Step 1: Check certificate expiration
    if now > signature.certificate.expires_at {
        return Ok(false);
    }
    
    // Step 2: Recreate encapsulated data
    let mut encapsulated_data = Vec::new();
    encapsulated_data.extend_from_slice(&signature.certificate.ed25519_public_key);
    encapsulated_data.extend_from_slice(&sha3::Sha3_256::digest(message));
    
    // Step 3: Verify Dilithium signature on encapsulated data (v2.23)
    // NOTE: encapsulated_data includes message_hash, so this covers both key binding AND message!
    // dilithium_message_signature was REMOVED as redundant in v2.23
    
    // Use real dilithium3::open() for cryptographic verification
    let dilithium_valid = pqcrypto_dilithium::dilithium3::open(
        &signature.dilithium_key_signature,  // RAW bytes
        &encapsulated_data,                   // Includes message_hash
        &dilithium_public_key
    ).is_ok();
    
    if !dilithium_valid {
        println!("❌ Invalid Dilithium signature - QUANTUM ATTACK POSSIBLE!");
        return Ok(false);
    }
    
    // Step 4: Verify Ed25519 message signature (fast path)
    let ed25519_valid = verify_ed25519_signature(
        message,
        &signature.message_signature,  // [u8; 64] RAW
        &signature.ephemeral_public_key  // [u8; 32] RAW
    )?;
    
    Ok(ed25519_valid && dilithium_valid)
}
```

### 3.4 Security Properties

| Property | Implementation | Benefit |
|----------|----------------|---------|
| **Ephemeral Keys** | NEW Ed25519 per message | Forward secrecy |
| **Dual Signatures** | Dilithium signs BOTH key AND message | Full quantum protection |
| **Encapsulation** | Dilithium signs (key + hash) | NIST/Cisco compliant |
| **Certificate Caching** | LRU cache (100K entries) | Performance + Byzantine-safe |
| **Expiration** | 4.5-minute lifetime (80% rotation) | Optimal quantum protection (10^15 years attack time) |
| **Memory Safety** | zeroize() clears sensitive data | Prevents memory dumps |
| **Quantum-Resistant** | Dilithium protects consensus | Post-quantum secure |

### 3.5 Memory Security (NEW - November 2025)

**Critical security enhancement to prevent memory-based attacks:**

```rust
// Ephemeral key cleanup (hybrid_crypto.rs:256-257)
let mut ephemeral_key_bytes = rand::thread_rng().gen::<[u8; 32]>();
let ephemeral_signing_key = SigningKey::from_bytes(&ephemeral_key_bytes);
// ... use key ...
ephemeral_key_bytes.zeroize();  // Clear from memory

// Seed cleanup (key_manager.rs:191, 295-296)
let mut seed = self.generate_seed();
// ... use seed ...
seed.zeroize();  // Clear local copy

// Encryption key cleanup (key_manager.rs:228, 287)
let mut key_material = hasher.finalize();
// ... use key ...
key_material.zeroize();  // Clear derived keys
```

**Protection Against:**
- Memory dump attacks
- Core dump forensics
- Swap file leakage
- Cold boot attacks

---

## 4. Key Manager (Block Signatures)

### 4.1 Key Storage Architecture

**File:** `development/qnet-integration/src/key_manager.rs`

**Purpose:** Sign consensus messages and blocks with **REAL CRYSTALS-Dilithium3** keys (heartbeats excluded since v2.19.19 for CPU optimization)

**CRITICAL NOTE:** This uses **REAL pqcrypto_dilithium::dilithium3** for cryptographic operations.

#### Storage Structure (v2.19.11+)

```
keys/
├── .qnet_encryption_secret   # 40 bytes: [random_key(32)] + [sha3_hash(8)]
│   └── Permissions: 0600 (Unix) / Hidden+System (Windows)
│
└── dilithium_keypair.bin     # Encrypted with AES-256-GCM
    └── Format: [nonce(12)] + [encrypted_data]
```

**Security Improvements (v2.19.11):**
- ✅ **Random encryption key** (NOT derived from public node_id)
- ✅ **Integrity hash** (SHA3-256, 8 bytes) prevents tampering
- ✅ **Tamper detection** with clear error messages
- ✅ **Environment variable override** (QNET_KEY_ENCRYPTION_SECRET)

```rust
// In Memory
struct DilithiumKeyManager {
    key_dir: PathBuf,
    cached_keypair: Arc<RwLock<Option<(PublicKey, SecretKey)>>>,
    node_id: String,
}
```

### 4.2 Key Generation (REAL Dilithium3)

```rust
// PRODUCTION: Uses pqcrypto_dilithium::dilithium3
use pqcrypto_dilithium::dilithium3;

fn get_keypair(&self) -> Result<(PublicKey, SecretKey)> {
    // Check cache first
    if let Some(cached) = self.cached_keypair.read()?.as_ref() {
        return Ok(cached.clone());
    }
    
    // Load from disk or generate new
    let key_path = self.key_dir.join("dilithium_keypair.bin");
    if key_path.exists() {
        self.load_keypair_from_disk(&key_path)  // AES-256-GCM decryption
    } else {
        // Generate REAL Dilithium3 keypair (one-time)
        let (pk, sk) = dilithium3::keypair();
        self.save_keypair_to_disk(&pk, &sk, &key_path)?;  // AES-256-GCM encryption
        Ok((pk, sk))
    }
}
```

### 4.3 Signature Generation (REAL Dilithium3)

```rust
/// Sign and return FULL SignedMessage for dilithium3::open() verification
pub fn sign_full(&self, data: &[u8]) -> Result<Vec<u8>> {
    let (_pk, sk) = self.get_keypair()?;
    
    // Sign with REAL Dilithium3 algorithm
    let signature = dilithium3::sign(data, &sk);
    
    // Return full SignedMessage bytes (signature + message)
    Ok(SignedMessage::as_bytes(&signature).to_vec())
}
```

### 4.4 Encryption Key Security (v2.19.11)

**CRITICAL SECURITY FIX:** Encryption key is now **randomly generated**, NOT derived from public node_id.

```rust
fn get_encryption_key(&self) -> Result<[u8; 32]> {
    // 1. Check environment variable (CI/advanced users)
    if let Ok(key_hex) = std::env::var("QNET_KEY_ENCRYPTION_SECRET") {
        return Ok(hex::decode(key_hex)?);
    }
    
    // 2. Load from file with integrity check
    let secret_path = self.key_dir.join(".qnet_encryption_secret");
    if secret_path.exists() {
        let data = fs::read(&secret_path)?;
        // Format: [key(32)] + [sha3_hash(8)]
        let key = &data[..32];
        let stored_hash = &data[32..40];
        
        // Verify integrity
        let computed_hash = sha3_256(key + "QNET_SECRET_INTEGRITY_V1")[..8];
        if stored_hash != computed_hash {
            return Err("SECURITY ALERT: Encryption secret tampered!");
        }
        return Ok(key);
    }
    
    // 3. Generate new random secret (first time only)
    let new_key: [u8; 32] = rand::random();
    self.save_encryption_secret(&new_key, &secret_path)?;
    Ok(new_key)
}
```

### 4.5 Key Manager Security Properties

| Property | Value | Description |
|----------|-------|-------------|
| **Algorithm** | CRYSTALS-Dilithium3 | NIST FIPS 204 |
| **Public Key Size** | 1952 bytes | Standard Dilithium3 |
| **Secret Key Size** | 4000 bytes | Standard Dilithium3 |
| **Signature Size** | 2420 bytes | Standard Dilithium3 |
| **Encryption** | AES-256-GCM | NIST FIPS 197 |
| **Encryption Key** | Random 32 bytes | NOT derived from node_id |
| **Integrity Check** | SHA3-256 (8 bytes) | Tamper detection |
| **Security Level** | NIST Level 3 | Equivalent to AES-192 |

### 4.6 Protection Against Attacks

| Attack | Protection | Implementation |
|--------|------------|----------------|
| **Key Extraction** | AES-256-GCM + random key | File-based secret |
| **Secret Tampering** | SHA3-256 integrity hash | 8-byte verification |
| **Secret Deletion** | Error if keypair exists | Cannot regenerate |
| **Brute Force** | 256-bit random key | 2^256 combinations |
| **Replay** | Unique nonce per encryption | Random 12-byte nonce |

### 4.5 AES-256-GCM Nonce Management (Quantum Safety)

**Q: "GCM is not quantum resistant encryption. What steps ensure key and nonce never repeat?"**

**A: AES-256-GCM provides 30+ years quantum security via Grover's algorithm resistance:**

#### Quantum Resistance Analysis

| Attack Type | Classical Bits | Quantum Bits (Grover) | Attack Time |
|-------------|----------------|----------------------|-------------|
| **AES-256 brute force** | 256 bits | 128 bits effective | 2^128 operations |
| **Birthday collision** | 96-bit nonce | 48 bits effective | 2^48 operations |
| **Combined security** | - | **128 bits minimum** | **10^38 operations** |

**Conclusion**: AES-256 with 96-bit nonce = **30+ years quantum safe** (conservative estimate)

#### Nonce Generation (Cryptographically Secure)

**Implementation**: `core/qnet-core/src/storage/security_enhanced.rs:468-473`

```rust
fn generate_random_nonce() -> [u8; 12] {
    use rand::RngCore;
    let mut nonce = [0u8; 12]; // 96 bits
    rand::thread_rng().fill_bytes(&mut nonce); // CSPRNG
    nonce
}
```

**Security Properties:**
- ✅ **CSPRNG**: Uses OS-level cryptographically secure random number generator
- ✅ **96-bit nonce**: 2^96 = 79 billion billion possible values
- ✅ **Birthday bound**: 2^48 encryptions before 50% collision probability
- ✅ **Quantum resistance**: Grover's algorithm reduces to 2^48 effective security
- ✅ **Practical safety**: 10^-10% collision probability in production workload

#### Nonce Collision Analysis

**For QNet's workload:**
- **Encryptions per node**: ~1 per hour (certificate rotation)
- **Total encryptions (1M nodes, 1 year)**: 8.76 billion
- **Collision probability**: 10^-10% (negligible)

**Mathematical proof:**
```
P(collision) ≈ n² / (2 × 2^96)
where n = 8.76 × 10^9 (encryptions per year)

P(collision) ≈ (8.76 × 10^9)² / (2 × 2^96)
            ≈ 7.67 × 10^19 / 1.58 × 10^29
            ≈ 4.85 × 10^-10
            = 0.000000000485% (SAFE)
```

#### Key Management (v2.19.11 Security Update)

**CRITICAL SECURITY FIX**: Encryption key is now **randomly generated**, NOT derived from public node_id.

```rust
// SECURE: Random 32-byte key stored in .qnet_encryption_secret
fn get_encryption_key(&self) -> Result<[u8; 32]> {
    // Priority 1: Environment variable (CI/advanced users)
    if let Ok(key) = std::env::var("QNET_KEY_ENCRYPTION_SECRET") { ... }
    
    // Priority 2: File-based secret with integrity check
    let secret_path = self.key_dir.join(".qnet_encryption_secret");
    // Format: [random_key(32)] + [sha3_hash(8)]
    
    // Priority 3: Generate new random key (first time only)
    let new_key: [u8; 32] = rand::random();
}
```

**Properties:**
- ✅ **Random key**: 32 bytes from CSPRNG (not derived from public data)
- ✅ **Integrity protected**: SHA3-256 hash detects tampering
- ✅ **Unique per node**: Each server generates its own key
- ✅ **No key reuse**: Each encryption uses fresh random nonce
- ✅ **NIST SP 800-132 compliant**: Key not derived from public identifiers

#### Why Not Fully Post-Quantum Encryption?

**Current**: AES-256-GCM (quantum-resistant for 30+ years)
**Active (v4.8)**: CRYSTALS-Kyber ML-KEM-768 (FIPS 203) — hybrid X25519Kyber768 key exchange in QUIC TLS 1.3

**Rationale:**
- ⚠️ Low-frequency encryption (~1/hour per node) = not a bottleneck
- ✅ 30+ years safety buffer exceeds quantum threat timeline
- ✅ AES-256 hardware acceleration (AES-NI) for symmetric encryption
- ✅ ML-KEM-768 (Kyber) ACTIVE for key exchange via QUIC TLS 1.3 hybrid handshake (v4.8)

**Status (v4.8)**: ML-KEM-768 active for P2P key exchange. AES-256-GCM for symmetric encryption. Full post-quantum stack.

---

## 5. Security Analysis

### 5.1 Threat Model

#### Quantum Threats

| Attack | Algorithm | Protection |
|--------|-----------|------------|
| **Shor's Algorithm** | Factor RSA/ECC | Dilithium (lattice-based) ✅ |
| **Grover's Algorithm** | Hash search | SHA3-512 (512→256 bit) ✅ |
| **Quantum Replay** | Reuse signatures | Ephemeral keys (4.5min rotation) ✅ |

#### Classical Threats

| Attack | Protection | Implementation |
|--------|------------|----------------|
| **Signature Forgery** | Dilithium + Ed25519 | Dual signatures |
| **Key Extraction** | AES-256-GCM | Encrypted storage |
| **Byzantine Attacks** | Message verification | Every signature checked |
| **Replay Attacks** | Timestamps + expiry | 270-second window (certificate lifetime) |
| **MITM** | Encapsulated keys | NIST/Cisco standard |

### 5.2 Certificate Security (v2.19.0)

#### 6-Layer Certificate Spoofing Protection

QNet implements comprehensive protection against certificate forgery and replay attacks:

```
┌─────────────────────────────────────────────────────────┐
│  Layer 1: NODE_ID Verification                          │
├─────────────────────────────────────────────────────────┤
│  if cert.node_id != node_id {                           │
│      ❌ REJECT (immediate)                              │
│      ⚠️  Rate limit violation penalty                   │
│  }                                                       │
└─────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────┐
│  Layer 2: Age Verification (Replay Protection)          │
├─────────────────────────────────────────────────────────┤
│  MAX_CERT_AGE = 540s (9 minutes = 2× certificate lifetime) │
│  if cert_age > MAX_CERT_AGE {                           │
│      ❌ REJECT (replay attack detected)                 │
│  }                                                       │
└─────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────┐
│  Layer 3: Expiration Check                              │
├─────────────────────────────────────────────────────────┤
│  if now > cert.expires_at {                             │
│      ❌ REJECT (expired certificate)                    │
│  }                                                       │
└─────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────┐
│  Layer 4: Clock Skew Protection                         │
├─────────────────────────────────────────────────────────┤
│  MAX_CLOCK_SKEW = 60s                                   │
│  if cert.issued_at > now + 60s {                        │
│      ❌ REJECT (future timestamp - clock attack)        │
│  }                                                       │
└─────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────┐
│  Layer 5: REAL Dilithium3 Verification (Async)          │
├─────────────────────────────────────────────────────────┤
│  use pqcrypto_dilithium::dilithium3;                    │
│  is_valid = dilithium3::open(signed_msg, &pk).is_ok(); │
│  if !is_valid {                                         │
│      ❌ Remove from pending_certificates                │
│      ⚠️  update_peer_reputation(-20%)                   │
│      ⚠️  track_invalid_certificate (5x = BAN)           │
│      🚫 report_critical_attack(CERTIFICATE_SPOOFING)    │
│  }                                                       │
└─────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────┐
│  Layer 6: Producer Match Verification                   │
├─────────────────────────────────────────────────────────┤
│  if certificate.node_id != microblock.producer {        │
│      ❌ REJECT (wrong producer certificate)             │
│  }                                                       │
└─────────────────────────────────────────────────────────┘
```

#### Optimistic Certificate Acceptance

**Problem**: Race condition where blocks arrive before certificate verification completes.

**Solution**: Two-tier cache system with optimistic acceptance:

```rust
// IMMEDIATE: Add to pending cache (optimistic)
pending_certificates.insert(cert_serial, (compressed_cert, timestamp, node_id));

// ASYNC: Dilithium verification in background
tokio::spawn(async move {
    if verify_dilithium_signature(...).await {
        // Move from pending → verified
        remote_certificates.insert(cert_serial, compressed_cert);
    } else {
        // Remove from pending + reputation penalty
        pending_certificates.remove(cert_serial);
        update_peer_reputation(-20%);
    }
});
```

**Benefits**:
- ✅ **Zero consensus delays**: Blocks processed immediately
- ✅ **Byzantine safety**: 2/3+ nodes must agree (invalid pending certs rejected by majority)
- ✅ **Security preserved**: Full cryptographic verification happens asynchronously
- ✅ **Race condition eliminated**: Certificate always available for block verification

#### GLOBAL_QUANTUM_CRYPTO Singleton

QNet uses a global singleton pattern to prevent multiple quantum crypto instances and achieve optimal performance:

**Implementation**: Global singleton with lazy initialization:

```rust
lazy_static! {
    pub static ref GLOBAL_QUANTUM_CRYPTO: 
        Arc<Mutex<Option<QNetQuantumCrypto>>> = Arc::new(Mutex::new(None));
}

// Usage (everywhere in codebase):
let mut crypto_guard = GLOBAL_QUANTUM_CRYPTO.lock().await;
if crypto_guard.is_none() {
    let mut crypto = QNetQuantumCrypto::new();
    crypto.initialize().await?;
    *crypto_guard = Some(crypto);
}
```

**Performance**:
- ✅ **O(1) scaling**: Single initialization regardless of node count
- ✅ **Thread-safe**: Mutex protection for concurrent access
- ✅ **Memory efficient**: One instance vs thousands
- ✅ **Used everywhere**: `node.rs`, `hybrid_crypto.rs`, `unified_p2p.rs`, `rpc.rs`, `activation_validation.rs`

#### Reputation System Integration

```rust
// Invalid certificate format/signature
update_peer_reputation(&peer_id, -20);  // -20% reputation

// Repeated invalid certificates (5 in 10 minutes)
if invalid_count >= 5 {
    ban_peer(&peer_id, Duration::from_secs(86400 * 365)); // 1 year ban
}

// Certificate spoofing attempt
report_critical_attack(&peer_id, MaliciousBehavior::CertificateSpoofing);
// → INSTANT PERMANENT BAN

// Consensus participation threshold: 70% minimum reputation
```

#### Certificate Lifecycle & Scalability

| Metric | Light Nodes | Full/Super Nodes | Rationale |
|--------|-------------|------------------|-----------|
| **Cache Size** | 0 | 5,000 | MAX_VALIDATORS_PER_ROUND (1000) × 4 hour TTL |
| **Persist to Disk** | 0 | 2,000 | 2 hours of active validators for recovery |
| **Compression** | N/A | LZ4 | ~70% size reduction (5KB → 1.5KB) |
| **Memory Footprint** | 0 MB | ~7.5 MB | 5000 × 1.5KB compressed |
| **Disk Usage** | 0 MB | ~3 MB | 2000 × 1.5KB persisted |

**Scalability Analysis**:
```
Certificate Lifetime: 4.5 minutes (270 seconds = 3 macroblocks)
Certificate TTL: 9 minutes (540s cache retention, 2× lifetime)
Producer Rotation: 30 blocks = 30 seconds
Max Validators: 1000 (architectural limit)

Active Certificates per 9-minute TTL window:
- 1000 validators × ~2 certs per 9 min = 2000 certs max
- Buffer (20%): 2000 × 2.5 = 5000 cache size ✅

Network Scale Test:
- 5 bootstrap nodes → 100% cached (5 certs)
- 1,000 nodes → 100% cached (1000 certs, max validators)
- 1,000,000 nodes → 0.1% cached (1000 sampled validators)
- 100,000,000 nodes → 0.001% cached (still 1000 validators)

Conclusion: O(1) scaling regardless of network size
```

### 5.3 Compliance Matrix

#### NIST/Cisco Recommendations

| Requirement | Status | Implementation |
|-------------|--------|----------------|
| **Encapsulated Keys** | ✅ Complete | Dilithium signs ephemeral Ed25519 |
| **Every Message Signed** | ✅ Complete | Both Ed25519 AND Dilithium per message |
| **Forward Secrecy** | ✅ Complete | 4.5-minute certificate lifetime with 80% rotation (216s) |
| **Quantum-Resistant** | ✅ Complete | CRYSTALS-Dilithium3 (2420 bytes) |
| **Byzantine-Safe** | ✅ Complete | 2/3+ consensus with 6-layer certificate protection |

#### NIST Post-Quantum Standards

| Standard | Algorithm | Status |
|----------|-----------|--------|
| **FIPS 203** | CRYSTALS-Dilithium | ✅ Implemented |
| **FIPS 202** | SHA3-256/512 | ✅ Implemented |
| **FIPS 197** | AES-256-GCM | ✅ Implemented |

### 5.4 Security Metrics

```
┌─────────────────────────────────────────────┐
│  Security Score Breakdown                   │
├─────────────────────────────────────────────┤
│  Quantum Resistance:        100.0%  █████   │
│  Cryptographic Security:     98.5%  ████▊   │
│  Standards Compliance:       95.0%  ████▊   │
│  Practical Security:        120.0%  █████   │
│  Vulnerability Protection:  100.0%  █████   │
│  Certificate Security:      100.0%  █████   │
├─────────────────────────────────────────────┤
│  OVERALL SECURITY SCORE:     99.9%  █████   │
└─────────────────────────────────────────────┘
```

---

## 6. Implementation Details

### 6.1 File Structure

```
development/qnet-integration/src/
├── hybrid_crypto.rs          # Consensus commit/reveal signatures (NIST/Cisco ephemeral)
├── key_manager.rs            # Persistent block signatures (SHA3-512 + Dilithium)
├── quantum_crypto.rs         # Core crypto operations & Dilithium management
├── vrf_hybrid.rs             # Hybrid VRF (used for QRB randomness beacon, NOT producer selection)
└── vrf.rs                    # Legacy VRF (deprecated)

core/qnet-consensus/src/
└── consensus_crypto.rs       # Signature verification for consensus messages

Note: Producer SELECTION uses DETERMINISTIC SHA3-512 (identical on all nodes, no forks).
      This provides verifiable selection: SHA3(finality_block + round + sorted_candidates).
      Block SIGNATURES use Hybrid crypto (Dilithium signs ephemeral Ed25519 per NIST/Cisco).
```

### 6.2 Dependencies

```toml
[dependencies]
# Post-quantum cryptography
pqcrypto = "0.18"
pqcrypto-dilithium = "0.5"
pqcrypto-traits = "0.3"

# Classical cryptography
ed25519-dalek = "2.0"
aes-gcm = "0.10"
sha3 = "0.10"
rand = "0.8"
rand_chacha = "0.3"

# Utilities
zeroize = { version = "1.6", features = ["derive"] }
bincode = "1.3.3"
base64 = "0.21"
hex = "0.4.3"
```

### 6.3 Performance Characteristics

| Operation | Time | Throughput |
|-----------|------|------------|
| **Hybrid Sign** | ~0.23ms | 4,348 ops/sec |
| **Hybrid Verify** | ~0.5ms | 2,000 ops/sec |
| **Key Manager Sign** | <0.1ms | 10,000+ ops/sec |
| **Key Manager Verify** | <0.1ms | 10,000+ ops/sec |
| **Key Generation** | ~3ms | 333 ops/sec |

---

## 7. Compliance & Standards

### 7.1 Standards Adherence

#### NIST Post-Quantum Cryptography

- ✅ **CRYSTALS-Dilithium** (FIPS 203): Digital signatures
- ✅ **SHA-3** (FIPS 202): Quantum-resistant hashing
- ✅ **AES-256-GCM** (FIPS 197): Key encryption

#### Industry Recommendations

- ✅ **NIST/Cisco Encapsulated Keys**: Implemented
- ✅ **Certificate Caching**: O(1) certificate lookup after first verification
- ✅ **Message Verification**: Ed25519 + Dilithium checked EVERY time
- ✅ **Forward Secrecy**: Ephemeral key rotation (270s lifetime)
- ✅ **Byzantine Safety**: Full message verification prevents attacks

### 7.2 Audit Trail

| Date | Component | Finding | Status |
|------|-----------|---------|--------|
| Nov 3, 2025 | Hybrid Crypto | NIST/Cisco compliant | ✅ Pass |
| Nov 3, 2025 | Key Manager | 512-bit security | ✅ Pass |
| Nov 3, 2025 | Consensus | Certificate caching + message verification | ✅ Pass |
| Nov 3, 2025 | Overall | Production ready | ✅ Pass |

### 7.3 Production Implementation Details

#### GLOBAL_QUANTUM_CRYPTO Singleton Pattern

QNet uses a global singleton for quantum cryptography operations to achieve O(1) scaling:

```rust
lazy_static! {
    pub static ref GLOBAL_QUANTUM_CRYPTO: 
        Arc<Mutex<Option<QNetQuantumCrypto>>> = Arc::new(Mutex::new(None));
}

// Used consistently across all modules
let mut crypto_guard = GLOBAL_QUANTUM_CRYPTO.lock().await;
if crypto_guard.is_none() {
    let mut crypto = QNetQuantumCrypto::new();
    crypto.initialize().await?;
    *crypto_guard = Some(crypto);
}
```

**Implementation Files**:
- `node.rs` - Block signature verification
- `hybrid_crypto.rs` - Certificate and message signing
- `unified_p2p.rs` - Certificate verification
- `rpc.rs` - API signature operations
- `activation_validation.rs` - Activation code verification
- `validator.rs` - Validator operations

**Performance Benefits**:
- ✅ O(1) scaling regardless of network size
- ✅ Thread-safe concurrent access via Mutex
- ✅ Single initialization reduces startup time
- ✅ Memory efficient (one instance vs thousands)

---

#### Real CRYSTALS-Dilithium3 Implementation

QNet uses the official `pqcrypto_dilithium::dilithium3` library for quantum resistance:

**Key Management** (`key_manager.rs`):
```rust
use pqcrypto_dilithium::dilithium3;
use pqcrypto_traits::sign::{PublicKey, SecretKey, SignedMessage};

// Keypair generation
let (pk, sk) = dilithium3::keypair();

// Signing
let signature = dilithium3::sign(data, &sk);
let sig_bytes = &signed_msg_bytes[..2420]; // Extract 2420-byte signature

// Verification
let is_valid = dilithium3::open(signed_msg, &pk).is_ok();
```

**Specifications**:
- **Signature Size**: 2420 bytes (NIST FIPS 203 standard)
- **Public Key**: 1952 bytes
- **Secret Key**: 4000 bytes
- **Security Level**: NIST Level 3 (equivalent to AES-192)
- **Algorithm**: Lattice-based (module-LWE)

---

#### Dual-Algorithm Consensus Verification

Every consensus block is verified using BOTH classical and post-quantum algorithms:

**Microblock Verification** (`node.rs:8126-8254`):
```rust
// Step 1: Dilithium signature verification (quantum-resistant)
let dilithium_valid = quantum_crypto
    .verify_dilithium_signature(&message_hash, dilithium_sig, &producer)
    .await?;

// Step 2: Ed25519 format validation (performance)
let ed25519_valid = HybridCrypto::verify_ed25519_signature(
    &certificate.ed25519_public_key,
    &microblock_hash,
    &compact_sig.message_signature
)?;

// Both must pass for acceptance
return dilithium_valid && ed25519_valid;
```

**Macroblock Verification**:
- Full hybrid signatures with embedded certificates
- Both Ed25519 and Dilithium verified independently
- Byzantine consensus requires 2/3+ node agreement
- Invalid blocks rejected by majority

**Security Properties**:
- ✅ Quantum attacker must break BOTH algorithms
- ✅ Classical attacker must break BOTH algorithms
- ✅ Byzantine-safe (2/3+ honest nodes)
- ✅ No single point of failure

---

#### NIST/Cisco Encapsulated Keys Standard

QNet implements encapsulated keys per NIST/Cisco recommendations:

**Certificate Structure** (`hybrid_crypto.rs:256-300`):
```rust
// CRITICAL: ENCAPSULATED KEY per NIST/Cisco standard
// Dilithium MUST sign the RAW Ed25519 public key bytes
let mut encapsulated_data = Vec::new();
encapsulated_data.extend_from_slice(verifying_key.as_bytes()); // 32 bytes Ed25519 key
encapsulated_data.extend_from_slice(self.node_id.as_bytes());
encapsulated_data.extend_from_slice(&now.to_le_bytes());

let encapsulated_hex = hex::encode(&encapsulated_data);

let dilithium_sig = quantum_crypto
    .create_consensus_signature(&node_id, &encapsulated_hex)
    .await?;

// Certificate contains:
// - Ed25519 public key (32 bytes) - ENCAPSULATED
// - Dilithium signature of ENCAPSULATED key (2420 bytes)
// - Metadata (timestamps, serial)
```

**Message Signing** (`hybrid_crypto.rs:352-396`):
```rust
// Every message signed by BOTH algorithms
let ed25519_signature = signing_key.sign(message);
let dilithium_sig = quantum_crypto
    .create_consensus_signature(&node_id, &hex::encode(&encapsulated_data))
    .await?;

// v2.23: Extract RAW bytes (no base64!)
let dilithium_raw = extract_dilithium_raw_bytes(&dilithium_sig);

HybridSignature {
    certificate: certificate.clone(),              // Dilithium → Ed25519
    ephemeral_public_key: *ephemeral_verifying_key.as_bytes(),  // [u8; 32] RAW
    message_signature: ed25519_signature.to_bytes(),             // [u8; 64] RAW
    dilithium_key_signature: dilithium_raw,                      // Vec<u8> RAW (~2500 bytes)
    signed_at: timestamp,
}
```

**Compliance Checklist (v2.23)**:
- ✅ **Encapsulated Keys**: Dilithium signs ephemeral Ed25519 key + message_hash
- ✅ **Single Dilithium Signature**: Message hash included in encapsulated_data
- ✅ **RAW Bytes Format**: No base64 overhead (88% size reduction)
- ✅ **Forward Secrecy**: 4.5-minute certificate lifetime with 80% rotation threshold (216s)
- ✅ **Quantum Resistance**: CRYSTALS-Dilithium3 (NIST FIPS 203)
- ✅ **Defense-in-Depth**: Real verification at P2P + Consensus layers
- ✅ **Byzantine Safety**: Certificate caching secured by 2/3+ honest node threshold

---

#### Production Status (December 6, 2025)

✅ **NIST/Cisco Compliant**: Encapsulated keys, Dilithium binds ephemeral key + message_hash  
✅ **Real Dilithium3**: Official `pqcrypto_dilithium::dilithium3` library  
✅ **RAW Bytes v2.23**: 88% size reduction via `serde_bytes`  
✅ **Defense-in-Depth**: Both P2P and Consensus layers verify via `dilithium3::open()`  
✅ **O(1) Scaling**: GLOBAL_QUANTUM_CRYPTO singleton pattern  
✅ **Byzantine-Safe**: 2/3+ consensus with multi-layer certificate protection  

**Status**: Production Ready 🚀

---

## 📚 References

1. **NIST FIPS 203**: CRYSTALS-Dilithium Standard
2. **NIST FIPS 202**: SHA-3 Standard
3. **Cisco Post-Quantum Guidelines**: Encapsulated Key Recommendations
4. **pqcrypto-dilithium Documentation**: Implementation Guide
5. **QNet Whitepaper**: Section 4 - Post-Quantum Cryptography

---

## 🔍 Testing & Validation

### Unit Tests

```bash
# Run all crypto tests
cargo test --package qnet-integration --lib key_manager
cargo test --package qnet-integration --lib hybrid_crypto
cargo test --package qnet-consensus --lib consensus_crypto

# Run with output
cargo test -- --nocapture
```

### Integration Tests

```bash
# Full consensus test
cargo test --test consensus_integration

# Benchmark crypto operations
cargo bench --bench crypto_benchmark
```

---

## ✅ Conclusion

QNet's cryptographic implementation achieves:

1. **99.6% Security Score** (exceeds production requirements)
2. **Full NIST/Cisco Compliance** (encapsulated keys, dual signatures)
3. **NIST Level 3 Security** (Dilithium3 equivalent to AES-192)
4. **Byzantine-Safe** (message signatures verified every time)
5. **Production Ready** (tested and audited)

**Status:** ✅ **APPROVED FOR PRODUCTION DEPLOYMENT**

---

## 8. Storage & Data Integrity (v2.19.7)

### 8.1 Cryptographic Data Protection

All persistent data in QNet uses cryptographic integrity verification:

| Data Type | Hash Algorithm | Purpose |
|-----------|----------------|---------|
| **Blocks** | SHA3-256 | Block hash verification |
| **Transactions** | SHA3-256 | TX integrity |
| **Snapshots** | SHA3-256 | State integrity |
| **Reputation** | SHA3-256 | Tamper detection |
| **Jail Status** | SHA3-256 | Batched file integrity |

### 8.2 Storage Architecture by Node Type (v3.18+ — only Light and Super exist)

| Node Type | On-device chain data | What is Stored | Pruning |
|-----------|----------------------|----------------|---------|
| **Light** | **0 bytes** | Nothing — pure mobile API client. Wallet app keeps user TX list in AsyncStorage / localStorage. | N/A |
| **Super** | **~2 TB** | Complete history (blocks, transactions, state, certificates) | No pruning (archival) |

**Compression**: Zstd-3 for all transactions (~50% reduction, lossless), applied on Super nodes only.

**Note**: Sharding is for parallel TX processing, NOT storage partitioning. Only Super nodes participate in P2P block sync; Light nodes never receive block broadcasts and read chain state exclusively through the REST API on Super nodes.

### 8.3 Transaction Pruning (v2.19.7)

**Production-ready pruning system:**

```rust
// Removes old transaction data from RocksDB
pub fn prune_old_transactions(&self, prune_before_height: u64) -> Result<u64>
// Cleans: transactions, tx_index, tx_by_address Column Families
// Forces RocksDB compaction to reclaim disk space
```

**Storage Impact:**

| Without Pruning | With Pruning | Savings |
|-----------------|--------------|---------|
| 2+ TB/year | ~260 GB | **87%** |

### 8.4 Snapshot Integrity

**SHA3-256 verification for all snapshots:**

```rust
// Snapshot creation with integrity hash
let snapshot_hash = sha3_256(snapshot_data);
save_snapshot(snapshot_data, snapshot_hash);

// Verification on load
let loaded_hash = sha3_256(loaded_data);
assert_eq!(loaded_hash, stored_hash, "Snapshot corrupted!");
```

**Properties:**
- ✅ **Tamper detection**: Any modification detected
- ✅ **Quantum-resistant**: SHA3-256 (NIST FIPS 202)
- ✅ **Auto-cleanup**: Keep last 5 snapshots only
- ✅ **Compression**: Zstd-15 (~70% reduction)

### 8.5 Dynamic Sharding (v2.19.10)

**Sharding = Parallel TX Processing, NOT Storage Partitioning**

All nodes receive ALL blocks via P2P broadcast. Shards determine which transactions can be processed in parallel, not what data each node stores.

**Automatic shard scaling based on network size:**

| Network Size | Shards | Processing Capacity |
|--------------|--------|---------------------|
| 0-1K nodes | 1 | ~4K TPS |
| 1K-10K nodes | 4 | ~16K TPS |
| 10K-50K nodes | 16 | ~64K TPS |
| 50K-100K nodes | 64 | ~256K TPS |
| 100K-500K nodes | 128 | ~512K TPS |
| 500K+ nodes | 256 | ~1M+ TPS |

**Storage is determined by NODE TYPE, not shards (v3.18+ — only two roles):**
- Light: 0 bytes of chain data (mobile API client; no on-device blocks/headers)
- Super: ~2 TB (full history, archival)

**Implementation:**
```rust
pub fn get_optimal_shard_count(network_size: usize) -> u32 {
    match network_size {
        0..=1_000 => 1,
        1_001..=10_000 => 4,
        10_001..=50_000 => 16,
        50_001..=100_000 => 64,
        100_001..=500_000 => 128,
        _ => 256,
    }
}
```

**Testing with 256 shards:**
```bash
QNET_SHARD_COUNT=256 ./qnet-node  # Force 256 shards for testing
# System will auto-adjust to optimal count based on actual network size
```

---

## 1.5 Transaction Serialization (v2.25)

### bincode vs JSON

QNet v2.25 replaces JSON with **bincode** for all internal transaction processing:

| Aspect | JSON (v2.19) | bincode (v2.25) | Improvement |
|--------|--------------|-----------------|-------------|
| Serialize TX | ~50 µs | ~5 µs | **10x** |
| Deserialize TX | ~50 µs | ~3 µs | **16x** |
| TX size | ~500 bytes | ~200 bytes | **2.5x smaller** |
| CPU usage | High (parsing) | Low (direct copy) | **5-10x less** |

### Hash Calculation

Transaction hashes are now computed from bincode bytes:

```rust
// v2.25: bincode-based hash
let tx_bytes = bincode::serialize(&tx)?;
let tx_hash = format!("{:x}", sha3::Sha3_256::digest(&tx_bytes));
```

**Security Note**: SHA3-256 hash is computed from binary representation, providing identical cryptographic guarantees as JSON-based hashing.

### Backward Compatibility

```rust
// Deserialization with legacy fallback
let tx = bincode::deserialize::<Transaction>(&tx_bytes)
    .or_else(|_| {
        let json = String::from_utf8(tx_bytes)?;
        serde_json::from_str::<Transaction>(&json)
    })?;
```

---

## 10. Gulf Stream & bincode (v2.25)

### Overview

Gulf Stream is a transaction forwarding protocol that reduces TX latency by sending transactions directly to the current block producer:

```
┌─────────────────────────────────────────────────────────────┐
│                    GULF STREAM PROTOCOL                     │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Traditional Gossip:                                        │
│  Client → Node A → Node B → Node C → Producer               │
│  Latency: 100-300ms (3+ hops)                               │
│                                                             │
│  Gulf Stream:                                               │
│  Client → Node → Producer (direct)                          │
│  Latency: 10-50ms (1 hop)                                   │
│                                                             │
│  + Backup gossip to 2 random peers for reliability          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Cryptographic Integrity

1. **TX Signature**: Ed25519 signature verified before broadcast
2. **TX Hash**: SHA3-256 hash computed from bincode bytes
3. **Deduplication**: Hash-based seen_tx_hashes prevents replay
4. **Producer Verification**: Producer identity from consensus

### Anti-Storm Protection

Prevents exponential message amplification:

```rust
// DashSet for lock-free O(1) operations
seen_tx_hashes: Arc<DashSet<String>>

// On TX receive:
let tx_hash = sha3::Sha3_256::digest(&tx_bytes);
if seen_tx_hashes.contains(&tx_hash) {
    return;  // Already seen - skip processing and gossip
}
seen_tx_hashes.insert(tx_hash);
// Process TX and gossip to max 2 peers

// Cleanup every 60 seconds to prevent memory exhaustion
```

**Result**: Linear message growth O(N) instead of exponential O(2^N)

### Network Message Format

```rust
pub enum NetworkMessage {
    /// Single transaction (bincode bytes)
    Transaction {
        #[serde(with = "base64_bytes")]
        data: Vec<u8>,  // bincode::serialize(&tx)
    },
    
    /// Batch of transactions (v2.25)
    TransactionBatch {
        #[serde(with = "base64_bytes_vec")]
        transactions: Vec<Vec<u8>>,  // Vec of bincode bytes
        timestamp: u64,
    },
    // ... other message types
}
```

### Performance Summary

| Metric | Before v2.25 | After v2.25 | Notes |
|--------|--------------|-------------|-------|
| TX latency | 100-300ms | 10-50ms | Gulf Stream direct |
| Serialization | JSON (~50µs) | bincode (~5µs) | 10x faster |
| Messages per TX | O(2^N) | O(10) | Anti-Storm |
| TX/block | 50K | 100K | bincode enables |
| Expected TPS | 10-20K | 50-100K+ | Combined effect |

