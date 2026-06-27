//! Block structures

use serde::{Deserialize, Serialize};
use crate::transaction::Transaction;
use sha3::{Sha3_256, Digest};
use crate::{Account, StateError};
use std::collections::HashMap;
use hex;

/// Block hash type
pub type BlockHash = [u8; 32];

/// Block type enum for micro/macro architecture
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum BlockType {
    /// Traditional block (for backward compatibility)
    Standard(Block),
    /// Microblock - created every second (legacy format with full transactions)
    Micro(MicroBlock),
    /// Efficient microblock - optimized storage with transaction hashes only
    EfficientMicro(EfficientMicroBlock),
    /// Macroblock - created every 90 seconds with consensus
    Macro(MacroBlock),
}

/// Microblock structure - fast blocks without consensus
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MicroBlock {
    /// Block height
    pub height: u64,
    /// Timestamp
    pub timestamp: u64,
    /// Transactions in this microblock
    pub transactions: Vec<Transaction>,
    /// Producer node ID
    pub producer: String,
    /// Producer's signature
    pub signature: Vec<u8>,
    /// Hash of previous microblock
    pub previous_hash: [u8; 32],
    /// Merkle root of transactions
    pub merkle_root: [u8; 32],
    /// Verifiable Time Sequence hash at block creation
    pub poh_hash: Vec<u8>,  // SHA3-512 produces 64 bytes
    /// Verifiable Time Sequence counter at block creation
    pub poh_count: u64,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // v4.0: DILITHIUM3-VRF OUTPUT + PROOF (dual purpose)
    // 1. Secret Leader Election: VRF(wallet_sk, slot_seed) → election proof
    // 2. Quantum Randomness Beacon (QRB): accumulated for epoch randomness
    // ═══════════════════════════════════════════════════════════════════════════
    
    /// VRF output: SHA3-256(Dilithium3_detached_sign(sk, slot_seed)) = 32 bytes
    /// Used for: leader election verification + QRB randomness accumulation
    #[serde(default)]
    pub vrf_output: Option<[u8; 32]>,
    
    /// VRF proof: ML-DSA-65 detached signature (~3309 bytes)
    /// Verifiable by any node with producer's registered public key
    #[serde(default)]
    pub vrf_proof: Option<Vec<u8>>,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // v3.18: DIRECT FEE COLLECTION - Pool 2 removed
    // Fees go directly to block producer, recorded here for transparency
    // ═══════════════════════════════════════════════════════════════════════════
    
    /// Total transaction fees collected in this block (nanoQNC)
    /// v3.18: Credited directly to producer's wallet, not pooled
    #[serde(default)]
    pub fees_collected: u64,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // v3.27: STATE ROOT - TOP L1 PATTERN
    // Root hash of the state Merkle tree AFTER applying all transactions + fees
    // Enables state verification: all nodes must compute identical state_root
    // If computed root != block.state_root → REJECT block as invalid!
    // ═══════════════════════════════════════════════════════════════════════════
    
    /// State Merkle root after applying this block
    /// Computed as: apply_transactions() → credit_fees() → finalize_merkle()
    /// Validators MUST verify: computed_root == block.state_root
    #[serde(default)]
    pub state_root: [u8; 32],

    // ═══════════════════════════════════════════════════════════════════════════
    // v14.0: TIMEOUT ROUND — Producer Authority Proof
    // ═══════════════════════════════════════════════════════════════════════════
    // Records which timeout_round was used for leader selection when this block
    // was produced. Enables any node to independently verify producer authority:
    //   expected = candidates[ hash(seed, height, round, timeout_round) % N ]
    //   assert(expected == block.producer)
    //
    // Without this field, nodes must rely on local timeout_round cache which
    // diverges during network stalls — causing false-positive block rejections.
    // With this field, verification is fully deterministic from on-chain state.
    //
    // Backward compatible: old blocks deserialize as timeout_round=0 (primary leader).
    // ═══════════════════════════════════════════════════════════════════════════

    /// Timeout round used for leader selection (0 = primary leader, >0 = failover)
    #[serde(default)]
    pub timeout_round: u64,

    // v14.7.2: `prev_block_qc` field REMOVED. Microblock BFT safety is
    // delivered by the canonical macroblock commit/reveal path rather
    // than a per-block pipelined QC, so the header no longer needs to
    // carry a 2f+1 certificate for its predecessor.
}

/// Macroblock structure - consensus blocks that finalize microblocks
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MacroBlock {
    /// Block height (macroblock number)
    pub height: u64,
    /// Timestamp
    pub timestamp: u64,
    /// Hashes of included microblocks
    pub micro_blocks: Vec<[u8; 32]>,
    /// State root after applying all microblocks
    pub state_root: [u8; 32],
    /// Consensus data (commit-reveal)
    pub consensus_data: ConsensusData,
    /// Previous macroblock hash
    pub previous_hash: [u8; 32],
    /// Verifiable Time Sequence hash at macroblock finalization
    pub poh_hash: Vec<u8>,  // SHA3-512 produces 64 bytes
    /// Verifiable Time Sequence counter at macroblock finalization
    pub poh_count: u64,
}

/// Consensus data for macroblocks
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ConsensusData {
    /// Commit phase data
    pub commits: HashMap<String, Vec<u8>>,
    /// Reveal phase data
    pub reveals: HashMap<String, Vec<u8>>,
    /// Selected leader for next round
    pub next_leader: String,

    /// Consensus v2: bincode of the checkpoint QuorumCertificate (2f+1 sigs over
    /// the checkpoint). Present ⇒ v2 finality; absent ⇒ legacy commit/reveal.
    #[serde(default)]
    pub checkpoint_qc: Option<Vec<u8>>,

    // ═══════════════════════════════════════════════════════════════════
    // DETERMINISTIC REPUTATION DATA (v2.21.5)
    // Stored in blockchain for all nodes to compute identical reputation
    // ═══════════════════════════════════════════════════════════════════
    
    /// v2 SCALE ANCHOR: cumulative equivocation ban-set as of THIS macroblock.
    /// Format: bincode serialized Vec<String> (sorted node_ids).
    ///
    /// Lets the next epoch's reputation fold derive the ban-set in O(window) — prev
    /// macroblock's set ∪ this window's verified proofs — instead of re-scanning every
    /// microblock from genesis (pruning-safe; scales to 100k+ nodes). NOT included in
    /// MacroBlock::hash(): each node self-computes it deterministically, and the ban
    /// EFFECT is independently re-verified every epoch via epoch_commitment (eligible
    /// excludes banned), so a stale/forged copy self-heals through content_ok fail-stop
    /// instead of forking the chain.
    #[serde(default)]
    pub banned_validators: Option<Vec<u8>>,

    // ═══════════════════════════════════════════════════════════════════
    // ELIGIBLE PRODUCERS SNAPSHOT (v2.27.0)
    // Epoch-based validator set for deterministic producer selection
    // Snapshot determines producers for next 90 blocks (next epoch)
    // ═══════════════════════════════════════════════════════════════════
    
    /// Eligible producers for next epoch (90 blocks)
    /// Format: bincode serialized Vec<EligibleProducer>
    /// All nodes use this SAME list for producer selection - NO gossip!
    /// This eliminates race conditions and guarantees determinism
    #[serde(default)]
    pub eligible_producers: Option<Vec<u8>>,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // QUANTUM RANDOMNESS BEACON (QRB) v3.0
    // Accumulated randomness from all QRB outputs in this epoch
    // Quantum-resistant randomness beacon with Dilithium signatures
    // ═══════════════════════════════════════════════════════════════════════════
    
    /// Quantum Randomness Beacon - accumulated from epoch's randomness outputs
    /// Formula: QRB = XOR(output_1, output_2, ..., output_90)
    /// Use cases: gambling, NFT mints, fair auctions, leader election
    /// Quantum-safe: All signatures use Dilithium3 (NIST FIPS 204)
    #[serde(default)]
    pub randomness_beacon: Option<[u8; 32]>,
    
    /// Number of QRB contributions in this beacon (for verification)
    /// Should equal number of microblocks in epoch (typically 90)
    /// Note: Field named vrf_contributions_count for serialization compatibility
    #[serde(default)]
    pub vrf_contributions_count: Option<u64>,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // REWARD HEARTBEATS (v2.41.0)
    // Deterministic heartbeat recording for Super node rewards.
    // Replaces gossip-based heartbeats which were non-deterministic and lossy.
    // (v3.18: the "Full" tier was removed from the protocol; only Super
    // nodes self-attest via heartbeats. Light nodes use the separate
    // ping-response attestation path.)
    // ═══════════════════════════════════════════════════════════════════════════
    
    /// Aggregated heartbeat summaries for all nodes in this epoch
    /// Format: bincode serialized Vec<HeartbeatSummary>
    /// Deterministic: all nodes see same heartbeat data from blockchain
    /// Used for reward calculation at emission blocks (every 4 hours)
    #[serde(default)]
    pub reward_heartbeats: Option<Vec<u8>>,
    
    /// Merkle root of all individual heartbeats for verification
    /// Allows light clients to verify heartbeat inclusion without full data
    #[serde(default)]
    pub heartbeats_merkle_root: Option<[u8; 32]>,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // v2.78: LIGHT NODE ATTESTATIONS - Collected from PingCommitment TXs.
    // Each Super node submits a PingCommitment TX listing the Light nodes
    // it pinged. The MacroBlock aggregates all of them to count unique
    // Light nodes for Pool 3 rewards.
    // (v3.18: only Super nodes ping Light nodes — the "Full" tier was
    // removed.)
    // ═══════════════════════════════════════════════════════════════════════════

    /// Aggregated Light node attestations from all Super-node PingCommitment TXs
    /// Format: bincode serialized HashMap<light_node_id: String, ping_count: u32>
    /// Deterministic: all nodes see same Light node data from blockchain
    /// Used for reward calculation at emission blocks (every 4 hours)
    #[serde(default)]
    pub reward_light_nodes: Option<Vec<u8>>,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // POOL 2 & POOL 3 TOTALS (v2.50.0)
    // Deterministic fee totals for reward calculation
    // Leader aggregates all transaction fees in epoch → all nodes use same value
    // ═══════════════════════════════════════════════════════════════════════════
    
    /// Pool 2: Total transaction fees collected in this emission window (4 hours)
    /// Recorded ONLY in EMISSION MacroBlocks (every 160th = 4 hours)
    /// v3.18: Pool 2 removed - fees go directly to block producer (always 0)
    /// All nodes use this SAME value for deterministic reward calculation
    #[serde(default)]
    pub pool2_total_fees: Option<u64>,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // COMMITTEE-BASED BFT (v3.36)
    // VRF-subsampled committee for scalable MacroBlock consensus (up to 1000+ validators)
    // ═══════════════════════════════════════════════════════════════════════════

    /// Committee members selected for this MacroBlock's BFT consensus
    /// When total validators > COMMITTEE_THRESHOLD, a VRF-subsampled committee
    /// of COMMITTEE_SIZE nodes handles commit-reveal. Other nodes accept the result.
    /// Format: sorted Vec<String> of node_ids
    #[serde(default)]
    pub consensus_committee: Option<Vec<String>>,

    /// Pool 3: Total activation QNC collected in this emission window (Phase 2 only)
    /// Recorded ONLY in EMISSION MacroBlocks when Phase 2 is active
    /// Distribution: Equal share to ALL eligible nodes (Light + Full + Super)
    /// Phase 1: Always None (Pool 3 disabled, 1DEV burn instead)
    /// Phase 2: Sum of all node activation QNC payments
    #[serde(default)]
    pub pool3_total_activations: Option<u64>,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // EXCLUDED PRODUCERS FOR NEXT EPOCH (v3.10)
    // Deterministic failover exclusion - stored in blockchain for consistency
    // All nodes read SAME list from MacroBlock N-2 → NO FORK!
    // ═══════════════════════════════════════════════════════════════════════════
    
    /// Producers excluded from next epoch due to failover events
    /// Format: bincode serialized Vec<ExcludedProducerEntry>
    /// Populated from failover history during MacroBlock creation
    /// Used by calculate_qualified_candidates to exclude unreliable producers
    /// CRITICAL: All nodes use SAME list from blockchain → deterministic selection!
    #[serde(default)]
    pub excluded_producers_for_next_epoch: Option<Vec<u8>>,

    // Skip-marker macroblock: when both the primary and deterministic-
    // fallback paths exhaust retries for this index, an explicit on-chain
    // placeholder must occupy it — else mb=N+1's previous_hash dangles and
    // every honest node halts permanently. When a 2f+1 TimeoutCertificate
    // exists at certified_round ≥ MAX_VIEW_CHANGE_ROUNDS, every honest node
    // deterministically builds a skip marker: occupies the index, carries
    // the AggregatedTimeoutCertificate as evidence, is_skip_marker=true,
    // no rewards / no state mutations (only preserves previous_hash linkage).
    // Validation requires: flag set; skip_certificate decodes; cert verifies
    // 2f+1 Dilithium3 votes at round ≥ MAX_VIEW_CHANGE_ROUNDS. Never
    // speculative — the 2f+1 view-change votes ARE the proof of failure.

    /// True iff this macroblock is a skip-marker placeholder produced after
    /// every fallback path failed to drive consensus to 2f+1 reveals.
    #[serde(default)]
    pub is_skip_marker: bool,

    /// Bincode-serialised AggregatedTimeoutCertificate proving 2f+1 view-change
    /// votes for this macroblock index at certified_round ≥ MAX_VIEW_CHANGE_ROUNDS.
    /// Required iff `is_skip_marker == true`. None for regular macroblocks.
    #[serde(default)]
    pub skip_certificate: Option<Vec<u8>>,

    // Snapshot binding for trustless bootstrap: SHA3-256 of the canonical
    // snapshot bytes at a snapshot-boundary macroblock. Identical across the
    // committee (deterministic apply-stage materialisation + canonical key
    // ordering) and implicitly endorsed by the 2f+1 commit-reveal that
    // finalises the macroblock. A bootstrapping node computes the digest
    // locally and accepts the downloaded snapshot only when it matches.
    /// SHA3-256 digest of the canonical snapshot artefact at this macroblock's
    /// end_height. Present only when this macroblock terminates a snapshot
    /// interval boundary AND the local snapshot was successfully created.
    #[serde(default)]
    pub snapshot_root: Option<[u8; 32]>,

    /// v32.10: SHA3-256 of the canonical SnapshotManifest bytes at the same
    /// boundary. Bound by the same 2f+1 commit-reveal as snapshot_root.
    /// Joiner verifies downloaded manifest matches this BEFORE chunk fetch —
    /// rejects byzantine manifest early, saves bandwidth.
    #[serde(default)]
    pub snapshot_manifest_hash: Option<[u8; 32]>,
}

/// Eligible producer entry for epoch-based validator set
/// Stored in macroblock, used for deterministic producer selection
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EligibleProducer {
    /// Node identifier (e.g., "genesis_node_001" or "node_abc123")
    pub node_id: String,
    /// Reputation at snapshot time as fixed-point centipercent (u32): 70.00% = 7000, max = 10000.
    /// Integer (not f64) so this consensus-committed value is bit-identical on every node.
    pub reputation: u32,
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXCLUDED PRODUCER ENTRY (v3.10)
// Deterministic failover exclusion data stored in MacroBlock
// ═══════════════════════════════════════════════════════════════════════════════

/// Excluded producer entry for deterministic failover handling
/// Stored in MacroBlock.consensus_data.excluded_producers_for_next_epoch
/// Used to exclude unreliable producers from next epoch selection
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExcludedProducerEntry {
    /// Node identifier being excluded
    pub node_id: String,
    /// Number of failover events in the epoch
    pub failover_count: u32,
    /// Block heights where failovers occurred
    pub failover_heights: Vec<u64>,
    /// Exclusion duration in blocks (typically 90 = 1 epoch)
    pub exclusion_blocks: u64,
    /// Reason for exclusion
    pub reason: String,
}

// ═══════════════════════════════════════════════════════════════════════════════
// REWARD HEARTBEAT DATA (v2.41.0)
// Deterministic heartbeat recording for Super-node rewards.
// Stored in MacroBlock for verifiable, deterministic reward calculation.
// (v3.18: the "Full" tier was removed from the protocol.)
// ═══════════════════════════════════════════════════════════════════════════════

/// Reward heartbeat entry for blockchain storage
/// Each Super node must send 10 heartbeats per 4-hour window
/// Super nodes need 9/10 (90%) for rewards.
/// (v3.18: legacy "Full" tier removed.)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RewardHeartbeat {
    /// Node identifier (pseudonym, not IP)
    pub node_id: String,
    /// Heartbeat sequence number within 4-hour window (1-10)
    pub sequence: u8,
    /// Block height when heartbeat was recorded
    pub block_height: u64,
    /// Timestamp of heartbeat
    pub timestamp: u64,
    /// Dilithium signature hash (first 8 bytes for compactness)
    pub signature_hash: [u8; 8],
}

/// Aggregated heartbeat summary for a node in a reward window
/// Used for efficient storage: one entry per node instead of 10
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HeartbeatSummary {
    /// Node identifier
    pub node_id: String,
    /// Node type tag: 0=Light, 2=Super. The value 1 ("Full") is a
    /// historical reserved code from before v3.18 and is no longer
    /// produced by any current node; readers map any legacy 1 to
    /// Super for backward compatibility.
    pub node_type: u8,
    /// Number of successful heartbeats in this epoch (0-10 for Super)
    pub heartbeat_count: u8,
    /// First heartbeat timestamp in epoch
    pub first_heartbeat: u64,
    /// Last heartbeat timestamp in epoch  
    pub last_heartbeat: u64,
    /// Whether node meets reward threshold (8/10 for Full, 9/10 for Super)
    pub is_eligible: bool,
}

/// Efficient microblock structure - stores only transaction hashes instead of full transactions
/// Optimized for distributed storage architecture with separate transaction pool
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EfficientMicroBlock {
    /// Block height
    pub height: u64,
    /// Timestamp
    pub timestamp: u64,
    /// Transaction hashes only - references to full transactions in separate pool
    pub transaction_hashes: Vec<[u8; 32]>,
    /// Producer node ID
    pub producer: String,
    /// Producer's signature
    pub signature: Vec<u8>,
    /// Hash of previous microblock
    pub previous_hash: [u8; 32],
    /// Merkle root of transaction hashes
    pub merkle_root: [u8; 32],
    /// Verifiable Time Sequence hash at block creation (SHA3-512 produces 64 bytes)
    pub poh_hash: Vec<u8>,
    /// Verifiable Time Sequence counter at block creation
    pub poh_count: u64,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // QUANTUM RANDOMNESS BEACON (QRB) v3.0
    // ═══════════════════════════════════════════════════════════════════════════
    
    /// QRB randomness output from producer (32 bytes)
    /// Note: Field named vrf_output for serialization compatibility
    #[serde(default)]
    pub vrf_output: Option<[u8; 32]>,
    
    /// Serialized QRB proof (HybridSignature: Dilithium + Ed25519)
    /// Note: Field named vrf_proof for serialization compatibility
    #[serde(default)]
    pub vrf_proof: Option<Vec<u8>>,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // v3.18: DIRECT FEE COLLECTION
    // ═══════════════════════════════════════════════════════════════════════════
    
    /// Total transaction fees collected in this block (nanoQNC)
    #[serde(default)]
    pub fees_collected: u64,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // v3.27: STATE ROOT
    // ═══════════════════════════════════════════════════════════════════════════

    /// State Merkle root after applying all transactions and fees
    #[serde(default)]
    pub state_root: [u8; 32],

    // ═══════════════════════════════════════════════════════════════════════════
    // v14.0: TIMEOUT ROUND — Producer Authority Proof
    // ═══════════════════════════════════════════════════════════════════════════

    /// Timeout round used for leader selection (0 = primary, >0 = failover)
    #[serde(default)]
    pub timeout_round: u64,
}

/// Light microblock header for mobile nodes
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LightMicroBlock {
    pub height: u64,
    pub timestamp: u64,
    pub tx_count: u32,
    pub merkle_root: [u8; 32],
    pub size_bytes: u32,
    pub producer: String,
}

// ============================================================================
// VERSIONED STORAGE FORMAT (v2.19.13)
// ============================================================================
// This enum provides explicit versioning for stored blocks, eliminating
// deserialization ambiguity between different block formats.
// 
// Architecture principles:
// 1. First byte indicates version/format
// 2. All formats can be converted to full MicroBlock when needed
// 3. PoH state is stored separately for fast validation
// ============================================================================

/// Storage format version markers
/// Used as first byte to identify stored block format
pub mod storage_version {
    /// Legacy MicroBlock with full transactions (pre-v2.19.8)
    pub const V1_FULL_MICROBLOCK: u8 = 0x01;
    /// EfficientMicroBlock with transaction hashes only (v2.19.8+)
    pub const V2_EFFICIENT_MICROBLOCK: u8 = 0x02;
    /// DEPRECATED — `LightMicroBlock` (headers-only) wire/storage form.
    /// Designed for the historical Light tier that persisted block
    /// headers locally. In v3.18+, the Light tier is a pure mobile API
    /// client with zero on-device chain storage, so this format is no
    /// longer produced or stored by Light nodes. Tag retained for
    /// backward compatibility with any legacy records or peers.
    pub const V3_LIGHT_MICROBLOCK: u8 = 0x03;
    /// Future: Compressed format with dictionary
    pub const V4_COMPRESSED: u8 = 0x04;
}

/// Versioned stored block - wraps different block formats with explicit version tag
/// This is the PRIMARY format for storing blocks in RocksDB (v2.19.13+)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum StoredMicroBlock {
    /// Version 1: Full MicroBlock with all transactions (legacy, for backward compat)
    V1Full(MicroBlock),
    /// Version 2: Efficient format - transaction hashes only, TX stored separately
    V2Efficient(EfficientMicroBlock),
    /// Version 3: DEPRECATED — `LightMicroBlock` headers-only format from the
    /// historical Light tier that persisted block headers on-device. The
    /// current Light tier (v3.18+) is a pure mobile API client with zero
    /// on-device chain storage and never emits or consumes this variant.
    /// Kept for backward compatibility with any legacy stored records.
    V3Light(LightMicroBlock),
}

impl StoredMicroBlock {
    /// Get block height regardless of format
    pub fn height(&self) -> u64 {
        match self {
            StoredMicroBlock::V1Full(b) => b.height,
            StoredMicroBlock::V2Efficient(b) => b.height,
            StoredMicroBlock::V3Light(b) => b.height,
        }
    }
    
    /// Get timestamp regardless of format
    pub fn timestamp(&self) -> u64 {
        match self {
            StoredMicroBlock::V1Full(b) => b.timestamp,
            StoredMicroBlock::V2Efficient(b) => b.timestamp,
            StoredMicroBlock::V3Light(b) => b.timestamp,
        }
    }
    
    /// Get producer regardless of format
    pub fn producer(&self) -> &str {
        match self {
            StoredMicroBlock::V1Full(b) => &b.producer,
            StoredMicroBlock::V2Efficient(b) => &b.producer,
            StoredMicroBlock::V3Light(b) => &b.producer,
        }
    }
    
    /// Get PoH state if available (not available for Light format)
    pub fn poh_state(&self) -> Option<PoHState> {
        match self {
            StoredMicroBlock::V1Full(b) => Some(PoHState {
                height: b.height,
                poh_hash: b.poh_hash.clone(),
                poh_count: b.poh_count,
                previous_hash: b.previous_hash,
            }),
            StoredMicroBlock::V2Efficient(b) => Some(PoHState {
                height: b.height,
                poh_hash: b.poh_hash.clone(),
                poh_count: b.poh_count,
                previous_hash: b.previous_hash,
            }),
            StoredMicroBlock::V3Light(_) => None, // Light nodes don't store PoH
        }
    }
    
    /// Check if this format can provide full transaction data
    pub fn has_full_transactions(&self) -> bool {
        matches!(self, StoredMicroBlock::V1Full(_))
    }
    
    /// Check if this format has transaction hashes
    pub fn has_transaction_hashes(&self) -> bool {
        matches!(self, StoredMicroBlock::V1Full(_) | StoredMicroBlock::V2Efficient(_))
    }
    
    /// Get transaction count
    pub fn tx_count(&self) -> usize {
        match self {
            StoredMicroBlock::V1Full(b) => b.transactions.len(),
            StoredMicroBlock::V2Efficient(b) => b.transaction_hashes.len(),
            StoredMicroBlock::V3Light(b) => b.tx_count as usize,
        }
    }
    
    /// Convert to EfficientMicroBlock (for V1Full, extracts hashes)
    pub fn to_efficient(&self) -> Option<EfficientMicroBlock> {
        match self {
            StoredMicroBlock::V1Full(b) => Some(EfficientMicroBlock::from_microblock(b)),
            StoredMicroBlock::V2Efficient(b) => Some(b.clone()),
            StoredMicroBlock::V3Light(_) => None,
        }
    }
    
    /// Get merkle root
    pub fn merkle_root(&self) -> [u8; 32] {
        match self {
            StoredMicroBlock::V1Full(b) => b.merkle_root,
            StoredMicroBlock::V2Efficient(b) => b.merkle_root,
            StoredMicroBlock::V3Light(b) => b.merkle_root,
        }
    }
    
    /// Get previous hash (not available for Light format)
    pub fn previous_hash(&self) -> Option<[u8; 32]> {
        match self {
            StoredMicroBlock::V1Full(b) => Some(b.previous_hash),
            StoredMicroBlock::V2Efficient(b) => Some(b.previous_hash),
            StoredMicroBlock::V3Light(_) => None,
        }
    }
}

/// VTS (Verifiable Time Sequence) state for a block
/// Stored separately for fast validation without loading full block
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PoHState {
    /// Block height this PoH state belongs to
    pub height: u64,
    /// PoH hash at block creation (SHA3-512, 64 bytes)
    pub poh_hash: Vec<u8>,
    /// PoH counter at block creation
    pub poh_count: u64,
    /// Previous block hash (for chain verification)
    pub previous_hash: [u8; 32],
}

impl PoHState {
    /// Create new PoH state
    pub fn new(height: u64, poh_hash: Vec<u8>, poh_count: u64, previous_hash: [u8; 32]) -> Self {
        Self {
            height,
            poh_hash,
            poh_count,
            previous_hash,
        }
    }
    
    /// Create from MicroBlock
    pub fn from_microblock(block: &MicroBlock) -> Self {
        Self {
            height: block.height,
            poh_hash: block.poh_hash.clone(),
            poh_count: block.poh_count,
            previous_hash: block.previous_hash,
        }
    }
    
    /// Create from EfficientMicroBlock
    pub fn from_efficient(block: &EfficientMicroBlock) -> Self {
        Self {
            height: block.height,
            poh_hash: block.poh_hash.clone(),
            poh_count: block.poh_count,
            previous_hash: block.previous_hash,
        }
    }
    
    /// Validate PoH progression from previous state
    /// Returns Ok(()) if valid, Err with reason if invalid
    pub fn validate_progression(&self, prev: &PoHState) -> Result<(), String> {
        // Height must be exactly one more than previous
        if self.height != prev.height + 1 {
            return Err(format!(
                "Invalid height progression: expected {}, got {}",
                prev.height + 1, self.height
            ));
        }
        
        // PoH count must be greater than previous (monotonic increase)
        // Allow some tolerance for network delays (30 seconds max)
        // 15M hashes at 500K/sec = 30 seconds < 90 sec macroblock interval
        const MAX_ACCEPTABLE_REGRESSION: u64 = 15_000_000; // ~30 seconds at 500K/sec
        
        if self.poh_count <= prev.poh_count {
            let regression = prev.poh_count - self.poh_count;
            if regression > MAX_ACCEPTABLE_REGRESSION {
                return Err(format!(
                    "Severe PoH regression: {} <= {} (diff: {})",
                    self.poh_count, prev.poh_count, regression
                ));
            }
            // Minor regression is acceptable due to network delays
        }
        
        Ok(())
    }
    
    /// Check if PoH data is valid (non-empty)
    pub fn is_valid(&self) -> bool {
        !self.poh_hash.is_empty() && self.poh_count > 0
    }
}

/// Block in the blockchain
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Block {
    /// Block height
    pub height: u64,
    /// Timestamp
    pub timestamp: u64,
    /// Previous block hash
    pub previous_hash: [u8; 32],
    /// Merkle root of transactions
    pub merkle_root: [u8; 32],
    /// Transactions in this block
    pub transactions: Vec<Transaction>,
    /// Block producer
    pub producer: String,
    /// Producer's signature
    pub signature: Vec<u8>,
    /// Verifiable Time Sequence hash (VTS/PoH)
    #[serde(default)]
    pub poh_hash: Vec<u8>,
    /// Verifiable Time Sequence counter
    #[serde(default)]
    pub poh_count: u64,
    /// Block type indicator
    #[serde(default)]
    pub block_type: String,
}

/// Block header (simplified)
pub type BlockHeader = Block;

/// Consensus proof
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsensusProof {
    pub round: u64,
    pub commits: Vec<String>,
    pub reveals: Vec<String>,
}

impl Block {
    /// Calculate block hash
    pub fn hash(&self) -> [u8; 32] {
        let mut hasher = Sha3_256::new();
        hasher.update(&self.height.to_le_bytes());
        hasher.update(&self.timestamp.to_le_bytes());
        hasher.update(&self.previous_hash);
        hasher.update(&self.merkle_root);
        hasher.update(self.producer.as_bytes());
        
        let result = hasher.finalize();
        let mut hash = [0u8; 32];
        hash.copy_from_slice(&result);
        hash
    }
    
    /// Create new block
    pub fn new(
        height: u64,
        timestamp: u64,
        previous_hash: [u8; 32],
        transactions: Vec<Transaction>,
        producer: String,
    ) -> Self {
        let merkle_root = Self::calculate_merkle_root(&transactions);
        
        Self {
            height,
            timestamp,
            previous_hash,
            merkle_root,
            transactions,
            producer,
            signature: vec![],
            poh_hash: vec![],
            poh_count: 0,
            block_type: String::new(),
        }
    }
    
    /// Calculate merkle root of transactions
    fn calculate_merkle_root(transactions: &[Transaction]) -> [u8; 32] {
        if transactions.is_empty() {
            return [0u8; 32];
        }
        
        let mut hashes: Vec<[u8; 32]> = transactions
            .iter()
            .map(|tx| {
                // Use calculate_hash() which returns a hex string, then convert to bytes
                let hash_str = tx.calculate_hash();
                let hash_bytes = hex::decode(&hash_str).unwrap_or_else(|_| vec![0u8; 32]);
                let mut hash_array = [0u8; 32];
                hash_array.copy_from_slice(&hash_bytes[..32.min(hash_bytes.len())]);
                hash_array
            })
            .collect();
        
        while hashes.len() > 1 {
            let mut next_level = Vec::new();
            
            for chunk in hashes.chunks(2) {
                let mut hasher = Sha3_256::new();
                hasher.update(&chunk[0]);
                if chunk.len() > 1 {
                    hasher.update(&chunk[1]);
                } else {
                    hasher.update(&chunk[0]);
                }
                
                let result = hasher.finalize();
                let mut hash = [0u8; 32];
                hash.copy_from_slice(&result);
                next_level.push(hash);
            }
            
            hashes = next_level;
        }
        
        hashes[0]
    }
    
    /// Validate block structure
    pub fn validate(&self) -> Result<(), StateError> {
        // Check timestamp
        if self.timestamp == 0 {
            return Err(StateError::InvalidBlock("Invalid timestamp".to_string()));
        }
        
        // Check height
        if self.height == 0 && self.previous_hash != [0u8; 32] {
            return Err(StateError::InvalidBlock("Genesis block must have zero previous hash".to_string()));
        }
        
        // Verify merkle root
        let calculated_root = Self::calculate_merkle_root(&self.transactions);
        if calculated_root != self.merkle_root {
            return Err(StateError::InvalidBlock("Invalid merkle root".to_string()));
        }
        
        // Validate all transactions
        for tx in &self.transactions {
            tx.validate()?;
        }
        
        Ok(())
    }
    
    /// Apply block to state
    pub fn apply_to_state(&self, accounts: &mut HashMap<String, Account>) -> Result<(), StateError> {
        for tx in &self.transactions {
            tx.apply_to_state(accounts)?;
        }
        Ok(())
    }
}

// Implement methods for MicroBlock
impl MicroBlock {
    /// Create a new microblock
    pub fn new(
        height: u64,
        timestamp: u64,
        previous_hash: [u8; 32],
        transactions: Vec<Transaction>,
        producer: String,
    ) -> Self {
        let merkle_root = Block::calculate_merkle_root(&transactions);
        
        Self {
            height,
            timestamp,
            transactions,
            producer,
            signature: vec![],
            previous_hash,
            merkle_root,
            // Default PoH values for backward compatibility
            poh_hash: vec![0u8; 64], // SHA3-512 produces 64 bytes
            poh_count: 0,
            // QRB v3.0: VRF fields (None for legacy/compatibility)
            vrf_output: None,
            vrf_proof: None,
            // v3.18: Direct fee collection (default 0)
            fees_collected: 0,
            // v3.27: State root (computed after applying TX + fees)
            state_root: [0u8; 32],
            // v14.0: Timeout round (default 0 = primary leader)
            timeout_round: 0,
        }
    }

    /// Calculate microblock hash.
    ///
    /// `timeout_round` IS bound into the hash: it is consensus-relevant
    /// (selects the elected producer and drives certified rotation for the
    /// macroblock window). Once v23 used real values, omitting it let a
    /// MITM mutate it without changing the hash → storage L4 anti-fork
    /// guard treats it as an idempotent re-save → leader divergence.
    /// Binding it turns any mutation into an L4 equivocation (reject + slash).
    pub fn hash(&self) -> [u8; 32] {
        let mut hasher = Sha3_256::new();
        hasher.update(&self.height.to_le_bytes());
        hasher.update(&self.timestamp.to_le_bytes());
        hasher.update(&self.previous_hash);
        hasher.update(&self.merkle_root);
        hasher.update(self.producer.as_bytes());
        // v23.1: bind timeout_round to block identity (see header above).
        hasher.update(&self.timeout_round.to_le_bytes());

        let result = hasher.finalize();
        let mut hash = [0u8; 32];
        hash.copy_from_slice(&result);
        hash
    }
    
    /// Convert to light header for mobile nodes
    pub fn to_light_header(&self) -> LightMicroBlock {
        LightMicroBlock {
            height: self.height,
            timestamp: self.timestamp,
            tx_count: self.transactions.len() as u32,
            merkle_root: self.merkle_root,
            size_bytes: self.estimate_size(),
            producer: self.producer.clone(),
        }
    }
    
    /// Estimate size in bytes
    fn estimate_size(&self) -> u32 {
        // Rough estimate: 250 bytes per transaction
        (self.transactions.len() * 250) as u32
    }
    
    /// Validate microblock
    pub fn validate(&self) -> Result<(), StateError> {
        // Check timestamp
        if self.timestamp == 0 {
            return Err(StateError::InvalidBlock("Invalid timestamp".to_string()));
        }
        
        // Check transaction count (max 50,000 for high-throughput mode)
        // PRODUCTION: 50K TX/block × 256 shards = 12.8M TPS theoretical max
        if self.transactions.len() > 50_000 {
            return Err(StateError::InvalidBlock("Too many transactions in microblock".to_string()));
        }
        
        // Verify merkle root
        let calculated_root = Block::calculate_merkle_root(&self.transactions);
        if calculated_root != self.merkle_root {
            return Err(StateError::InvalidBlock("Invalid merkle root".to_string()));
        }
        
        // Validate all transactions
        for tx in &self.transactions {
            tx.validate()?;
        }
        
        Ok(())
    }
}

// Implement methods for EfficientMicroBlock
impl EfficientMicroBlock {
    /// Create a new efficient microblock from transaction hashes
    pub fn new(
        height: u64,
        timestamp: u64,
        previous_hash: [u8; 32],
        transaction_hashes: Vec<[u8; 32]>,
        producer: String,
    ) -> Self {
        let merkle_root = Self::calculate_merkle_root_from_hashes(&transaction_hashes);
        
        Self {
            height,
            timestamp,
            transaction_hashes,
            producer,
            signature: vec![],
            previous_hash,
            merkle_root,
            poh_hash: vec![],
            poh_count: 0,
            // QRB v3.0: VRF fields (None for legacy/compatibility)
            vrf_output: None,
            vrf_proof: None,
            // v3.18: fees_collected for producer rewards
            fees_collected: 0,
            // v3.27: state_root (computed after applying TX + fees)
            state_root: [0u8; 32],
            // v14.0: Timeout round (default 0 = primary leader)
            timeout_round: 0,
        }
    }

    /// Create efficient microblock from full microblock (conversion for migration)
    pub fn from_microblock(microblock: &MicroBlock) -> Self {
        let transaction_hashes: Vec<[u8; 32]> = microblock.transactions
            .iter()
            .map(|tx| {
                // Convert string hash to [u8; 32] 
                if let Ok(hash_bytes) = hex::decode(&tx.hash) {
                    if hash_bytes.len() == 32 {
                        let mut hash_array = [0u8; 32];
                        hash_array.copy_from_slice(&hash_bytes);
                        hash_array
                    } else {
                        // If hex decode fails or wrong length, use blake3 hash of the transaction
                        let mut hasher = Sha3_256::new();
                        hasher.update(tx.hash.as_bytes());
                        let result = hasher.finalize();
                        let mut hash_array = [0u8; 32];
                        hash_array.copy_from_slice(&result);
                        hash_array
                    }
                } else {
                    // Fallback: hash the transaction hash string
                    let mut hasher = Sha3_256::new();
                    hasher.update(tx.hash.as_bytes());
                    let result = hasher.finalize();
                    let mut hash_array = [0u8; 32];
                    hash_array.copy_from_slice(&result);
                    hash_array
                }
            })
            .collect();
            
        Self {
            height: microblock.height,
            timestamp: microblock.timestamp,
            transaction_hashes,
            producer: microblock.producer.clone(),
            signature: microblock.signature.clone(),
            previous_hash: microblock.previous_hash,
            merkle_root: microblock.merkle_root,
            poh_hash: microblock.poh_hash.clone(),
            poh_count: microblock.poh_count,
            // QRB v3.0: Copy VRF fields from source microblock
            vrf_output: microblock.vrf_output,
            vrf_proof: microblock.vrf_proof.clone(),
            // v3.18: Copy fees_collected from source microblock
            fees_collected: microblock.fees_collected,
            // v3.27: Copy state_root from source microblock
            state_root: microblock.state_root,
            // v14.0: Copy timeout_round from source microblock
            timeout_round: microblock.timeout_round,
        }
    }

    /// Calculate merkle root from transaction hashes
    fn calculate_merkle_root_from_hashes(transaction_hashes: &[[u8; 32]]) -> [u8; 32] {
        if transaction_hashes.is_empty() {
            return [0u8; 32];
        }
        
        let mut hasher = Sha3_256::new();
        for hash in transaction_hashes {
            hasher.update(hash);
        }
        
        let result = hasher.finalize();
        let mut root = [0u8; 32];
        root.copy_from_slice(&result);
        root
    }
    
    /// Calculate efficient microblock hash
    ///
    /// v23.1: Mirror of `MicroBlock::hash` — includes `timeout_round` in the
    /// digest so that storage-layer hash identity matches between the full
    /// `MicroBlock` and its `EfficientMicroBlock` representation. Without
    /// this mirror, a block loaded as `MicroBlock` and a block loaded as
    /// `EfficientMicroBlock` would produce different hashes for the same
    /// on-disk bytes — breaking the storage-L4 anti-fork guard's identity
    /// comparison across read paths. See `MicroBlock::hash` header for the
    /// full consensus-binding rationale.
    pub fn hash(&self) -> [u8; 32] {
        let mut hasher = Sha3_256::new();
        hasher.update(&self.height.to_le_bytes());
        hasher.update(&self.timestamp.to_le_bytes());
        hasher.update(&self.previous_hash);
        hasher.update(&self.merkle_root);
        hasher.update(self.producer.as_bytes());
        // v23.1: bind timeout_round to block identity (see MicroBlock::hash header).
        hasher.update(&self.timeout_round.to_le_bytes());

        let result = hasher.finalize();
        let mut hash = [0u8; 32];
        hash.copy_from_slice(&result);
        hash
    }
    
    /// Convert to light header for mobile nodes
    pub fn to_light_header(&self) -> LightMicroBlock {
        LightMicroBlock {
            height: self.height,
            timestamp: self.timestamp,
            tx_count: self.transaction_hashes.len() as u32,
            merkle_root: self.merkle_root,
            size_bytes: self.estimate_size(),
            producer: self.producer.clone(),
        }
    }
    
    /// Estimate size in bytes for efficient microblock format
    fn estimate_size(&self) -> u32 {
        // Base size (metadata) + 32 bytes per transaction hash
        let base_size = 8 + 8 + 4 + 32 + 32; // height + timestamp + producer_len + previous_hash + merkle_root
        let hashes_size = self.transaction_hashes.len() * 32;
        (base_size + hashes_size) as u32
    }
    
    /// Validate efficient microblock
    pub fn validate(&self) -> Result<(), StateError> {
        // Check timestamp
        if self.timestamp == 0 {
            return Err(StateError::InvalidBlock("Invalid timestamp".to_string()));
        }
        
        // Check transaction count (same limit as regular microblock)
        // PRODUCTION: 50K TX/block × 256 shards = 12.8M TPS theoretical max
        if self.transaction_hashes.len() > 50_000 {
            return Err(StateError::InvalidBlock("Too many transactions in microblock".to_string()));
        }
        
        // Verify merkle root
        let calculated_root = Self::calculate_merkle_root_from_hashes(&self.transaction_hashes);
        if calculated_root != self.merkle_root {
            return Err(StateError::InvalidBlock("Invalid merkle root".to_string()));
        }
        
        // Check for duplicate transaction hashes
        use std::collections::HashSet;
        let unique_hashes: HashSet<_> = self.transaction_hashes.iter().collect();
        if unique_hashes.len() != self.transaction_hashes.len() {
            return Err(StateError::InvalidBlock("Duplicate transaction hashes".to_string()));
        }
        
        Ok(())
    }
}

// Implement methods for MacroBlock
impl MacroBlock {
    /// Create a new macroblock
    pub fn new(
        height: u64,
        timestamp: u64,
        previous_hash: [u8; 32],
        micro_blocks: Vec<[u8; 32]>,
        state_root: [u8; 32],
        consensus_data: ConsensusData,
    ) -> Self {
        Self {
            height,
            timestamp,
            micro_blocks,
            state_root,
            consensus_data,
            previous_hash,
            // Default PoH values for backward compatibility
            poh_hash: vec![0u8; 64], // SHA3-512 produces 64 bytes
            poh_count: 0,
        }
    }
    
    /// Calculate macroblock hash
    pub fn hash(&self) -> [u8; 32] {
        let mut hasher = Sha3_256::new();
        hasher.update(&self.height.to_le_bytes());
        hasher.update(&self.timestamp.to_le_bytes());
        hasher.update(&self.previous_hash);
        hasher.update(&self.state_root);
        
        // Include all microblock hashes
        for micro_hash in &self.micro_blocks {
            hasher.update(micro_hash);
        }
        
        let result = hasher.finalize();
        let mut hash = [0u8; 32];
        hash.copy_from_slice(&result);
        hash
    }
    
    /// Validate macroblock
    pub fn validate(&self) -> Result<(), StateError> {
        // Check timestamp
        if self.timestamp == 0 {
            return Err(StateError::InvalidBlock("Invalid timestamp".to_string()));
        }

        // Check microblock count (should be ~90 for 90 seconds)
        if self.micro_blocks.is_empty() || self.micro_blocks.len() > 100 {
            return Err(StateError::InvalidBlock("Invalid microblock count".to_string()));
        }

        // ═══════════════════════════════════════════════════════════════════════
        // SKIP-MARKER MACROBLOCK VALIDATION (v15.7)
        // ═══════════════════════════════════════════════════════════════════════
        // Skip-marker macroblocks substitute the commit-reveal evidence with a
        // 2f+1-signed AggregatedTimeoutCertificate carried in `skip_certificate`,
        // so the standard "≥3 reveals" check does not apply. The certificate
        // itself must be present at this layer; cryptographic verification of
        // its signatures and certified-round threshold is performed in the
        // network layer (`SimplifiedP2P::verify_skip_certificate_bytes`)
        // because that is where the active validator set is available.
        if self.consensus_data.is_skip_marker {
            if self.consensus_data.skip_certificate.is_none() {
                return Err(StateError::InvalidBlock(
                    "skip_marker_macroblock_missing_skip_certificate".to_string(),
                ));
            }
            return Ok(());
        }

        // Verify consensus data has enough participants
        if self.consensus_data.reveals.len() < 3 {
            return Err(StateError::InvalidBlock("Insufficient consensus participants".to_string()));
        }

        Ok(())
    }
}

