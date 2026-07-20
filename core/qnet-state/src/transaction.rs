//! Transaction types and processing

use serde::{Deserialize, Serialize};
use blake3::Hasher;
use sha3::{Sha3_256, Digest};
use hex;
use crate::errors::StateResult;
use crate::StateError;
use std::collections::HashMap;
use crate::Account;
use std::collections::HashSet;
use crate::account::{NodeType, ActivationPhase};
use std::sync::{Arc, RwLock};
use std::sync::atomic::{AtomicU8, Ordering};
use once_cell::sync::Lazy;

/// QRC-20 wallet→token ownership transition emitted by apply, drained by the persist layer into the
/// wallet_token reverse index (NON-consensus, never in state_root). Set = a holder's balance went
/// 0→nonzero for a contract; Clear = nonzero→0. Keyed on the HOLDER in `balance:{holder}`, not the
/// tx sender (transferFrom credits `to` and drains `from`, neither of which is the spender).
#[derive(Debug, Clone)]
pub enum OwnsDelta {
    Set { wallet: String, contract: String },
    Clear { wallet: String, contract: String },
}

/// v3.35: Conditional logging -- only log in DEBUG/INFO mode, not in production hot path
/// Controlled by LOG_LEVEL env var (default: "info")
/// 0=none, 1=error, 2=warn, 3=info, 4=debug
static LOG_LEVEL: Lazy<AtomicU8> = Lazy::new(|| {
    let level = std::env::var("LOG_LEVEL")
        .map(|l| match l.to_lowercase().as_str() {
            "none" | "off" => 0u8,
            "error" => 1,
            "warn" => 2,
            "info" => 3,
            "debug" | "trace" => 4,
            _ => 3,
        })
        .unwrap_or(3);
    AtomicU8::new(level)
});

// ═══════════════════════════════════════════════════════════════════════════════
// SENDER ADDRESS FORMAT WHITELIST
// ═══════════════════════════════════════════════════════════════════════════════
// The set of identifier patterns that may legitimately appear in `tx.from`.
// Any sender outside this set is rejected by `Transaction::validate()` —
// closing the address-impersonation vector that allowed attackers to set
// `tx.from = "system"` and pass apply-time string-match authority checks.
//
// Three legitimate formats:
//
//   1. EON wallet address — 45 chars, "eon" marker at position 19,
//      SHA3-256 4-byte checksum (validated by `is_valid_eon_address`).
//      This is the format produced by client wallets for human users.
//
//   2. Reserved protocol identifiers — produced by block-construction code
//      paths only. They appear as `tx.from` for system-emitted transactions
//      (RewardDistribution, ping commitments, genesis bootstrap). The
//      `validate_and_add_network_transaction` path explicitly rejects
//      these senders for transaction types that should not arrive via
//      gossip — preventing forged "system" transactions from peers.
//
//   3. Node identifier pseudonyms — `genesis_node_NNN`, `super_*`, `light_*`.
//      Used as `tx.from` for HeartbeatCommitment / NodeReactivation /
//      similar node-bound system messages.
//
// Adding a new sender format MUST update this whitelist AND the corresponding
// gossip-path tx_type whitelist to keep both invariants aligned.
// ═══════════════════════════════════════════════════════════════════════════════

/// Reserved protocol identifiers that produce transactions internally.
/// Must NEVER appear as `tx.from` of a transaction received via gossip
/// or RPC — only block-construction paths set these.
const RESERVED_PROTOCOL_IDENTIFIERS: &[&str] = &[
    "system",
    "genesis",
    "system_emission",
    "system_rewards_pool",
    "system_ping_commitment",
    "system_slashing", // EquivocationProof sender — block-construction only, never gossiped
];

/// Validate whether the `tx.from` value matches one of the three accepted
/// formats: EON wallet address, reserved protocol identifier, or node
/// identifier pseudonym. Returns true on match, false otherwise.
///
/// SCALABILITY: O(1) — constant-bounded checks. Independent of network size.
pub fn is_valid_sender_format(sender: &str) -> bool {
    if sender.is_empty() {
        return false;
    }

    // Format 1: EON wallet address (45 chars).
    if is_valid_eon_address(sender) {
        return true;
    }

    // Format 2: Reserved protocol identifier (exact match).
    if RESERVED_PROTOCOL_IDENTIFIERS.contains(&sender) {
        return true;
    }

    // Format 3: Node identifier pseudonyms.
    if sender.starts_with("genesis_node_")
        || sender.starts_with("super_")
        || sender.starts_with("light_")
    {
        // Length sanity bound: pseudonyms are typically short. Reject overly
        // long or empty-prefix variants to prevent storage-bloat attacks.
        return sender.len() >= 8 && sender.len() <= 128;
    }

    false
}

/// Validate full EON wallet address format:
///   * 45 chars total
///   * lowercase hex chars 0-18 (part1, 19 chars)
///   * "eon" literal at positions 19-21
///   * lowercase hex chars 22-36 (part2, 15 chars)
///   * SHA3-256(part1 + "eon" + part2)[..4] hex at positions 37-44
///
/// Returns true ONLY for fully valid checksummed addresses. Invalid format,
/// wrong length, or bad checksum all return false.
fn is_valid_eon_address(addr: &str) -> bool {
    if addr.len() != 45 {
        return false;
    }
    if &addr[19..22] != "eon" {
        return false;
    }
    let part1 = &addr[0..19];
    let part2 = &addr[22..37];
    let checksum_claim = &addr[37..45];

    let is_lower_hex = |s: &str| s.chars().all(|c| c.is_ascii_hexdigit() && !c.is_uppercase());
    if !is_lower_hex(part1) || !is_lower_hex(part2) || !is_lower_hex(checksum_claim) {
        return false;
    }

    let address_without_checksum = format!("{}eon{}", part1, part2);
    let computed = hex::encode(&Sha3_256::digest(address_without_checksum.as_bytes())[..4]);
    checksum_claim == computed
}

fn is_info_log() -> bool {
    LOG_LEVEL.load(Ordering::Relaxed) >= 3
}

fn is_debug_log() -> bool {
    LOG_LEVEL.load(Ordering::Relaxed) >= 4
}

/// QNet native transaction fee units (OPTIMIZED for mobile)
pub const QNC_DECIMALS: u8 = 9; // 1 QNC = 10^9 smallest units (nanoQNC)
pub const BASE_FEE_NANO_QNC: u64 = 100_000; // 0.0001 QNC base fee (5x cheaper!)
pub const PRIORITY_MULTIPLIER: u64 = 10; // 10x for priority transactions

/// v3.36: Gas metering activation height (EIP-1559 style gas refund)
/// Below this height: charge gas_limit * gas_price (legacy, preserves consensus)
/// At and above: charge gas_used * gas_price + refund unused gas to sender
/// ACTIVATED: block 100_000 — change if current chain is above this height
pub const GAS_METERING_ACTIVATION_HEIGHT: u64 = 100_000;

/// Minimum gas PRICE (nanoQNC per gas unit) accepted from a user transaction — the single source of
/// truth for the fee floor, used by the mempool admission filter, the /gas-price hint endpoint, and the
/// RPC submit path. Derived so the floor is self-consistent: a standard transfer (`gas_limits::TRANSFER`
/// gas) at this price costs exactly `BASE_FEE_NANO_QNC` = 0.0001 QNC. Fee = `effective_gas_price *
/// gas_limit`; a Dilithium-signed (quantum) TX pays 1.5× via `effective_gas_price` (larger TX + verify
/// cost). Anti-spam is layered (per-sender cap + per-IP rate limit + balance check), so the floor stays
/// mobile-cheap rather than punitive. System TXs (activation/heartbeat/reward) bypass the floor.
pub const MIN_GAS_PRICE: u64 = BASE_FEE_NANO_QNC / gas_limits::TRANSFER;

/// Anti-OOM backstop ONLY — not the economic anti-spam mechanism. State-growth spam is
/// bounded economically by STORAGE_DEPOSIT_PER_ENTRY_NANO_QNC (a refundable per-entry deposit);
/// this cap sits far above any reachable honest holder count so it never bricks a real token.
pub const MAX_CONTRACT_STORAGE_ENTRIES: usize = 50_000_000;

/// Refundable deposit moved sender→escrow when a NEW contract_storage entry (balance/allowance)
/// is created, and escrow→sender when a balance entry is removed (goes to zero). Pure native-QNC
/// account MOVE — conservation preserved, never minted or burned. 0.01 QNC per entry.
pub const STORAGE_DEPOSIT_PER_ENTRY_NANO_QNC: u64 = 10_000_000;

/// Reserved system escrow holding storage-rent deposits. Not a valid user (eon) sender address,
/// so no user can own it or derive its key — verified against is_valid_sender_format at test time.
pub const STORAGE_RENT_ESCROW_ADDR: &str = "system_storage_rent_escrow";

/// Canonical burn address — a well-known, provably-unspendable EON (nothing-up-my-sleeve all-zeros
/// body + valid checksum). No pubkey's SHA512 can yield an all-zeros body, so no key ever maps here.
/// Transferring a token here is a REAL burn: QRC-20/721 destroy supply/ownership on-chain (below);
/// native QNC accumulates here unspendably and is excluded from circulating supply (off-consensus).
pub const CANONICAL_BURN_ADDR: &str = "0000000000000000000eon00000000000000036877022";

/// Gas price in nanoQNC (QNet native units)
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct GasPrice(pub u64);

impl GasPrice {
    /// Create gas price from QNC amount
    pub fn from_qnc(qnc: f64) -> Self {
        Self((qnc * 10_f64.powi(QNC_DECIMALS as i32)) as u64)
    }
    
    /// Convert to QNC
    pub fn to_qnc(&self) -> f64 {
        self.0 as f64 / 10_f64.powi(QNC_DECIMALS as i32)
    }
    
    /// Mobile-optimized gas price (0.0001 QNC) - 5x cheaper!
    pub fn mobile() -> Self {
        Self(BASE_FEE_NANO_QNC)
    }
    
    /// Standard gas price (0.0002 QNC)
    pub fn standard() -> Self {
        Self(BASE_FEE_NANO_QNC * 2)
    }
    
    /// Fast gas price (0.0005 QNC)
    pub fn fast() -> Self {
        Self(BASE_FEE_NANO_QNC * 5)
    }
    
    /// Priority gas price (0.001 QNC)
    pub fn priority() -> Self {
        Self(BASE_FEE_NANO_QNC * PRIORITY_MULTIPLIER)
    }
}

/// Calculate total transaction cost in QNC
pub fn calculate_tx_cost(gas_price: GasPrice, gas_limit: u64) -> Result<f64, String> {
    let total_nano_qnc = gas_price.0.checked_mul(gas_limit)
        .ok_or_else(|| format!(
            "[REJECT][TX] gas_fee_overflow gas_price={} gas_limit={}",
            gas_price.0, gas_limit
        ))?;
    Ok(total_nano_qnc as f64 / 10_f64.powi(QNC_DECIMALS as i32))
}

/// QNet-optimized gas limits (mobile-friendly)
pub mod gas_limits {
    /// Simple QNC transfer (cheaper)
    pub const TRANSFER: u64 = 10_000; // Reduced from 21,000
    
    /// Node activation (optimized)
    pub const NODE_ACTIVATION: u64 = 50_000; // Reduced from 100,000
    
    /// Reward claim (very cheap)
    pub const REWARD_CLAIM: u64 = 25_000; // Reduced from 50,000
    
    /// Contract deployment (mobile-optimized)
    pub const CONTRACT_DEPLOY: u64 = 500_000; // Reduced from 1M
    
    /// Contract interaction (cheap)
    pub const CONTRACT_CALL: u64 = 100_000; // Reduced from 200,000
    
    /// Ping transaction (FREE - system operation)
    pub const PING: u64 = 0; // FREE! No cost for ping responses
    
    /// Batch operations (efficient)
    pub const BATCH_OPERATION: u64 = 150_000; // New: for batch claims
    
    /// Maximum gas limit per transaction
    pub const MAX_GAS_LIMIT: u64 = 1_000_000; // Reduced from 2M

    /// FIX R22-B5: Maximum cumulative gas per block (protocol constant)
    /// Limits computational work per block independently of byte size.
    /// 200K TX × avg 10K gas ≈ 2B gas. Set to 10B for headroom with contract calls.
    /// Defense-in-depth: block byte limit (80MB) + block gas limit (10B) together
    /// prevent both size-based and computation-based DoS.
    pub const BLOCK_GAS_LIMIT: u64 = 10_000_000_000; // 10 billion gas units

    /// Maximum cumulative WASM fuel a block may RESERVE (protocol constant).
    /// The intrinsic gas (BLOCK_GAS_LIMIT) prices bytes/base cost, but a metered WASM call can burn
    /// up to `gas_limit - intrinsic` fuel of real CPU while contributing only its flat intrinsic to
    /// the gas total — so gas alone does NOT bound compute. This is a SEPARATE budget over the fuel
    /// each contract call reserves (see `Transaction::reserved_fuel`): the producer stops filling and
    /// every validator rejects once a block's summed reserved fuel exceeds this ceiling. Because
    /// wasmi fuel is a deterministic instruction count, the bound is identical on every node (no fork)
    /// and needs no execution to enforce — it reads only the signed `gas_limit`.
    /// CALIBRATION: sized so a fully-fuel-packed block still executes AND re-validates well inside the
    /// ~1s microblock slot on the weakest permitted node. Conservative starting value; the live-soak
    /// fuel/sec benchmark on reference hardware is the authority for the final number. With per-tx
    /// MAX_GAS_LIMIT=1M (≤~0.9M reserved fuel/call), 50M admits ~55 max-compute calls per block.
    pub const BLOCK_FUEL_LIMIT: u64 = 50_000_000;
}

/// Transaction hash type
pub type TxHash = String;

/// One side of an equivocation proof: the per-block signable header fields of a
/// microblock (height + producer are shared across both sides, kept on the TX).
/// Carries enough to reconstruct the exact `Block_Sig_v23.1` signing digest and
/// re-verify the producer's Dilithium3 signature on-chain — no trust in the reporter.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EquivocationHeader {
    pub timestamp: u64,
    pub merkle_root: [u8; 32],
    pub previous_hash: [u8; 32],
    pub state_root: [u8; 32],
    pub vrf_output: Option<[u8; 32]>,
    pub timeout_round: u64,
    // Carried rotation baseline: the paired half of abs = timeout_round + carried_baseline.
    // Bound into Block_Sig_v23.1 alongside timeout_round so the equivocation proof re-verifies
    // the SAME signed digest (both fields are consensus-relevant and cryptographically bound).
    #[serde(default)]
    pub carried_baseline: u64,
    pub signature: Vec<u8>,
}

/// Transaction types
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum TransactionType {
    /// Transfer QNC between accounts
    Transfer {
        from: String,
        to: String,
        amount: u64,
    },

    /// Cryptographic proof that `offender` signed two DIFFERENT microblocks at the
    /// same `height` — provable equivocation. Both `EquivocationHeader.signature`s are
    /// the offender's Dilithium3 sigs over the `Block_Sig_v23.1` digest of their fields;
    /// unforgeable. Verified on-chain against the offender's registry PK and applied
    /// deterministically in the reputation fold (offender → reputation 0 + ban). No
    /// balance effect. Fail-safe: an invalid/forged proof simply fails verification.
    EquivocationProof {
        offender: String,
        height: u64,
        block_a: EquivocationHeader,
        block_b: EquivocationHeader,
    },

    /// Cryptographic proof that `offender` signed two DIFFERENT checkpoint votes at the SAME
    /// consensus round `index` — provable BFT vote equivocation (accountable safety: a
    /// committee member double-voting is what an attacker would do to violate finality
    /// safety). Both signatures are the offender's consensus-key sigs over the canonical
    /// `QNET_BFT2_VOTE:<hex(checkpoint_hash)>` message; unforgeable. Verified on-chain against
    /// the offender's registry PK and applied in the reputation fold (offender → ban). No
    /// balance effect. Fail-safe: an invalid/forged proof simply fails verification.
    VoteEquivocationProof {
        offender: String,
        /// bincode of BOTH conflicting checkpoints (qnet_consensus Checkpoint). SOUNDNESS:
        /// the vote signature covers ONLY the checkpoint hash, NOT the round, so the full
        /// preimages are REQUIRED — the fold re-derives each hash and reads each round `index`,
        /// then bans ONLY if `index_a == index_b` (a same-round double-vote) and the hashes
        /// differ and both sigs verify. Carrying only hashes would let a forger pair two honest
        /// votes from DIFFERENT rounds and falsely slash an honest node.
        checkpoint_a: Vec<u8>,
        signature_a: Vec<u8>,
        checkpoint_b: Vec<u8>,
        signature_b: Vec<u8>,
    },

    /// Token swap via DEX smart contract
    /// Fee: standard gas fee goes directly to block producer (v3.18: Pool 2 removed)
    Swap {
        /// Address initiating the swap
        from: String,
        /// Token being sold (e.g., "QNC", contract address for custom tokens)
        token_in: String,
        /// Token being bought
        token_out: String,
        /// Amount of token_in being swapped
        amount_in: u64,
        /// Minimum amount of token_out expected (slippage protection)
        amount_out_min: u64,
        /// Actual amount of token_out received (filled after execution)
        amount_out: u64,
        /// DEX pool/contract address
        pool_address: String,
    },
    
    /// Node activation (Phase 1: 1DEV burn on Solana, Phase 2: QNC transfer to Pool 3)
    NodeActivation {
        node_type: NodeType,
        amount: u64,  // Phase 1: 0 (1DEV burned externally), Phase 2: QNC transferred to Pool 3
        phase: ActivationPhase,
    },
    
    /// Contract deployment
    ContractDeploy,
    
    /// Contract call
    ContractCall,
    
    /// Reward distribution
    RewardDistribution,
    
    /// Node registration (ON-CHAIN binding of node_id → wallet)
    /// All nodes must register on-chain to receive rewards
    /// Genesis: predefined wallets, Super/Full: from activation, Light: from mobile app
    NodeRegistration {
        node_id: String,
        node_type: NodeType,
        wallet_address: String,
        /// For Genesis: "genesis", For activated: activation_code hash, For Light: device signature hash
        registration_proof: String,
        /// v3.35: Public API endpoint for mobile app discovery
        /// Super/Genesis: IP is PUBLIC by default (auto-detected from connection)
        /// Set to empty string "" to explicitly HIDE your IP
        /// Light nodes: always empty (privacy protection - mobile apps!)
        #[serde(default)]
        api_endpoint: String,
        /// Phase-1 proof-of-burn carrier. The external Solana 1DEV burn is non-deterministic (live
        /// RPC) and cannot be re-checked in apply, so the burn fact is brought ON-CHAIN as a committee
        /// quorum: `burn_attestors` carries ≥2f+1 distinct committee Dilithium signatures over
        /// `burn_attestation_message(burn_tx, wallet_address, burn_amount, node_type, burn_cost, attest_epoch)`,
        /// re-verified from these bytes at block validation (deterministic, snapshot-independent).
        /// Empty for genesis identities (registration_proof=="genesis") and when the gate is inactive.
        #[serde(default)]
        burn_tx: String,
        #[serde(default)]
        burn_amount: u64,
        /// Required Phase-1 cost the committee attested (whole 1DEV). Carried so the verifier rebuilds
        /// the exact signed message + asserts burn_amount >= burn_cost with NO Solana re-read.
        #[serde(default)]
        burn_cost: u64,
        /// (committee_id, dilithium_sig) attestation quorum. Verified, never trusted blindly.
        #[serde(default)]
        burn_attestors: Vec<(String, String)>,
        /// Epoch whose consensus committee produced `burn_attestors` (== epoch(arm_tip) at collection).
        /// Bound into the signed message so the apply-time verifier resolves the SAME committee the
        /// attestors used — closes the arm-tip/apply-height straddle (M-5). Verifier bounds it recent
        /// and forbids a genesis-committee downgrade for a post-genesis registration.
        #[serde(default)]
        attest_epoch: u64,
    },

    /// Create new account
    CreateAccount {
        address: String,
        initial_balance: u64,
    },
    
    
    
    /// Batch reward claims (DEPRECATED — never instantiated, dead code)
    /// Architecture: 1 wallet = 1 node → batch claim unnecessary.
    /// handle_batch_claim_rewards() creates individual RewardDistribution TXs directly.
    /// Kept in enum ONLY for backward-compatible deserialization of historical blocks.
    BatchRewardClaims {
        node_ids: Vec<String>,
        batch_id: String,
    },
    
    /// Batch node activations (DEPRECATED — no route, no handler, never instantiated)
    /// Architecture: 1 wallet = 1 node → user activates via single NodeActivation TX.
    /// Kept in enum ONLY for backward-compatible deserialization.
    BatchNodeActivations {
        activation_data: Vec<BatchNodeActivationData>,
        batch_id: String,
    },
    
    /// Batch transfers (UNUSED — handler exists but mobile app never calls it)
    /// Potentially useful for multi-recipient transfers in future.
    /// Kept in enum for forward/backward compatibility.
    BatchTransfers {
        transfers: Vec<BatchTransferData>,
        batch_id: String,
    },
    
    /// Ping attestation (FREE - system operation for deterministic emission)
    /// Records node ping response on-chain for Byzantine-resistant reward calculation
    PingAttestation {
        from_node: String,
        to_node: String,
        response_time_ms: u32,
        success: bool,
    },
    
    /// Ping Commitment with Merkle Tree + Sampling (PRODUCTION-READY SCALABILITY)
    /// Instead of storing ALL pings on-chain (millions), stores:
    /// - Merkle root (32 bytes) of all pings
    /// - Random deterministic sample (1% or 10K pings, whichever is larger)
    /// - Each sample includes Merkle proof for verification
    /// This scales to millions of nodes while maintaining Byzantine security
    PingCommitmentWithSampling {
        window_start_height: u64,           // Start height of 4-hour window (e.g., 14400)
        window_end_height: u64,             // End height of window
        merkle_root: String,                // Merkle root of ALL ping hashes (hex)
        total_ping_count: u32,              // Total number of pings in window
        successful_ping_count: u32,         // Number of successful pings
        sample_seed: String,                // Deterministic sampling seed (hex)
        ping_samples: Vec<PingSampleData>,  // Random sample with proofs (1% or 10K min)
    },
    
    /// Heartbeat Commitment with Merkle Tree + Sampling (PRODUCTION-READY SCALABILITY)
    /// Self-attestation for Super nodes (10 heartbeats per 4-hour epoch).
    /// (v3.18: the "Full" tier was removed; only Super nodes self-attest.)
    /// Similar to PingCommitment but for node liveness tracking instead of ping responses
    /// ARCHITECTURE: Each node submits ONE commitment TX per epoch containing:
    /// - Merkle root of all 10 heartbeats (deterministically timed)
    /// - Samples with proofs for Byzantine verification
    /// This scales to 10M+ nodes (694 TX/block) while maintaining deterministic rewards
    HeartbeatCommitment {
        node_id: String,                           // Node submitting commitment
        window_start_height: u64,                  // Start of epoch (e.g., 0, 14400, 28800)
        window_end_height: u64,                    // End of epoch (e.g., 14400, 28800, 43200)
        merkle_root: String,                       // Merkle root of ALL heartbeat hashes (hex)
        heartbeat_count: u8,                       // Total heartbeats in window (0-10)
        first_heartbeat_time: u64,                 // Timestamp of first heartbeat
        last_heartbeat_time: u64,                  // Timestamp of last heartbeat
        sample_seed: String,                       // Deterministic sampling seed (hex)
        heartbeat_samples: Vec<HeartbeatSampleData>, // Samples with Merkle proofs
    },

    /// v34: UNFORGEABLE liveness heartbeat — replaces the self-attested HeartbeatCommitment.
    /// One tiny TX per ~1440-block subwindow of the 14400-block epoch. Bound to a recent
    /// canonical block hash (cannot be pre-signed) and included near its anchor (cannot be
    /// backfilled into immutable past blocks); the sender's per-epoch subwindow bitmask in
    /// account-state increments on apply. Reward eligibility = popcount(bitmask) >= 9.
    /// `from` (Transaction.from) = node wallet (the account whose counter increments);
    /// `node_id` = consensus pseudonym for PK lookup. The Dilithium `signature` is verified at
    /// block validation against the node's registry PK (apply trusts validated blocks).
    Heartbeat {
        node_id: String,        // genesis_node_00X / super_xxx — consensus identity (PK lookup)
        anchor_height: u64,     // recent block height: epoch = /14400, subwindow = (%14400)/1440
        anchor_hash: String,    // canonical hash of block at anchor_height (hex) — anti-pre-sign
        signature: String,      // Dilithium sig by node over node_id:anchor_height:anchor_hash
    },

    /// PRODUCTION v2.89: Light Node Eligibility Bitmap
    /// Ultra-compact representation of eligible Light nodes using bitmap + zstd compression
    /// 
    /// SCALABILITY:
    /// - 2M Light nodes = 250KB bitmap (1 bit per node)
    /// - zstd compression: ~50KB per TX
    /// - 5 Genesis × 50KB = 250KB total for 10M Light nodes!
    /// 
    /// ARCHITECTURE:
    /// - Genesis nodes ping their assigned shard (2M Light nodes each)
    /// - At epoch end, create ONE bitmap TX with all eligible nodes
    /// - MacroBlock collects all 5 bitmap TX and merges for reward distribution
    /// 
    /// VERIFICATION:
    /// - eligible_count must match popcount of decompressed bitmap
    /// - bitmap size must match (total_assigned + 7) / 8 bytes
    LightNodeEligibilityBitmap {
        genesis_id: String,              // Genesis node ID (genesis_node_001, etc.)
        epoch: u64,                      // Epoch number
        total_assigned: u32,             // Total Light nodes assigned to this Genesis (e.g., 2M)
        eligible_count: u32,             // Count of eligible nodes (popcount of bitmap)
        bitmap_compressed: Vec<u8>,      // zstd-compressed bitmap (1 bit per Light node)
    },
    /// v9.4: Node reactivation after offline period
    /// Sent by returning nodes after sync to re-enter eligible producers set.
    /// Similar to Cosmos MsgUnjail — explicit on-chain signal that node is back online and synced.
    /// Free system TX (gas_limit = 0), deduplicated per macroblock-epoch.
    NodeReactivation {
        node_id: String,
        /// Current chain height at time of reactivation (proves node is synced)
        current_height: u64,
        /// Hash of latest macroblock the node has (proves sync completeness)
        last_macroblock_hash: String,
        /// Macroblock index of the latest macroblock
        #[serde(default)]
        last_macroblock_index: u64,
    },

    /// FIX R23-K1: Key rotation transaction — allows nodes to rotate their Dilithium3
    /// public key on-chain. Required for post-quantum key hygiene and key compromise recovery.
    /// The old key signs the rotation TX (proving ownership), the new key is registered.
    /// Signature verification ensures only the current key owner can rotate.
    KeyRotation {
        /// Node ID performing the rotation
        node_id: String,
        /// New Dilithium3 public key (hex-encoded, 1952 bytes decoded)
        new_dilithium_pk: String,
        /// Signature of new_dilithium_pk by the OLD key (proves ownership transition)
        old_key_signature: String,
        /// Block height at which the new key becomes active (allows grace period)
        #[serde(default)]
        effective_height: u64,
    },

    // PURE DILITHIUM (F0.1): SetPQRequirement removed — post-quantum signing is now
    // mandatory network-wide, so a per-wallet opt-in upgrade TX is obsolete.
}

/// Individual ping sample with Merkle proof
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PingSampleData {
    pub from_node: String,
    pub to_node: String,
    pub response_time_ms: u32,
    pub success: bool,
    pub timestamp: u64,
    pub merkle_proof: Vec<(String, bool)>, // (hash, is_left) - proof of inclusion
}

/// Individual heartbeat sample with Merkle proof
/// Used in HeartbeatCommitment TX for Byzantine-safe verification
/// ARCHITECTURE v2.78: All server nodes use HYBRID signatures
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HeartbeatSampleData {
    pub heartbeat_index: u8,               // Index in epoch (0-9)
    pub timestamp: u64,                    // Unix timestamp
    pub block_height: u64,                 // Block height when sent
    pub signature: String,                 // HYBRID signature (Ed25519 + Dilithium3, ~2.6KB bincode)
    pub merkle_proof: Vec<(String, bool)>, // (hash, is_left) - proof of inclusion
}

/// PRODUCTION v2.77: Shard-aggregated heartbeat summary for SCALABILITY
/// Instead of storing 10M+ individual HeartbeatSummary in MacroBlock,
/// aggregate by 256 shards (shard_id = sha3_256(node_id)[0])
/// This reduces MacroBlock from 1 GB to 1.3 MB for 10M nodes!
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ShardHeartbeatSummary {
    pub shard_id: u8,                      // Shard 0-255
    pub total_nodes: u32,                  // Total nodes in shard
    pub eligible_light: u32,               // Eligible Light nodes
    pub eligible_full: u32,                // v3.18: Always 0 (Full nodes removed)  
    pub eligible_super: u32,               // Eligible Super nodes
    pub total_eligible: u32,               // Sum of eligible nodes
    pub commitments_merkle_root: String,   // Merkle root of all HeartbeatCommitment TXs in shard
    pub sample_commitment_hashes: Vec<String>, // Sample of 10-20 commitment hashes for verification
}

/// Batch node activation data for transactions
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BatchNodeActivationData {
    pub node_id: String,
    pub owner_address: String,
    pub node_type: NodeType,
    pub activation_amount: u64,
    pub tx_hash: String,
}

/// Batch transfer data for transactions
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BatchTransferData {
    pub to_address: String,
    pub amount: u64,
    pub memo: Option<String>,
}

/// Transaction in the blockchain
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Transaction {
    /// Transaction hash
    pub hash: TxHash,
    
    /// Sender address
    pub from: String,
    
    /// Recipient address
    pub to: Option<String>,
    
    /// Amount to transfer
    pub amount: u64,
    
    /// Nonce
    pub nonce: u64,
    
    /// Gas price
    pub gas_price: u64,
    
    /// Gas limit
    pub gas_limit: u64,
    
    /// Timestamp
    pub timestamp: u64,
    
    /// Signature (Ed25519 or Hybrid format)
    pub signature: Option<String>,
    
    /// Public key for signature verification (Ed25519 32 bytes, hex encoded)
    /// Required for client transactions to verify signature
    pub public_key: Option<String>,
    
    /// Transaction type
    pub tx_type: TransactionType,
    
    /// Call data
    pub data: Option<String>,
    
    /// QUANTUM v2.25: Optional CRYSTALS-Dilithium3 signature for post-quantum security
    /// When present: TX is quantum-resistant + 50% higher gas cost
    /// Format: hex-encoded ML-DSA-65 signature (~3309 bytes = 6618 hex chars)
    /// Use case: High-value transfers, enterprise, paranoid users
    /// NOTE: No skip_serializing_if - bincode requires all fields to be serialized
    #[serde(default)]
    pub dilithium_signature: Option<String>,
    
    /// QUANTUM v2.25: Dilithium public key for signature verification
    /// Required when dilithium_signature is present
    /// Format: hex-encoded Dilithium public key (~1952 bytes = 3904 hex chars)
    /// NOTE: No skip_serializing_if - bincode requires all fields to be serialized
    #[serde(default)]
    pub dilithium_public_key: Option<String>,

    /// FIX R23-M1: Chain ID for cross-chain replay protection.
    /// Testnet=1337, Mainnet=1, Devnet=31337. Included in canonical_bytes() so
    /// signatures are chain-specific — a TX signed for testnet is invalid on mainnet.
    /// Default 0 for backward compat with pre-R23 TXs (accepted on any chain).
    #[serde(default)]
    pub chain_id: u64,
}

/// Transaction receipt (simplified)
pub type TransactionReceipt = Transaction;

/// Transaction execution status
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum TxStatus {
    /// Successfully executed
    Success,
    /// Failed with reason
    Failed(String),
    /// Reverted by contract
    Reverted(String),
}

/// Transaction finalization status for microblock architecture
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum FinalizationStatus {
    /// Pending in mempool
    Pending,
    /// Included in microblock (locally finalized for small amounts)
    LocallyFinalized { microblock_height: u64 },
    /// Finalized in macroblock (globally finalized)
    GloballyFinalized { macroblock_height: u64 },
}

/// Local finalization configuration
#[derive(Debug, Clone)]
pub struct LocalFinalizationConfig {
    /// Maximum amount for instant local finalization (in smallest units)
    pub max_instant_amount: u64,
    /// Maximum gas price for instant finalization
    pub max_instant_gas_price: u64,
    /// Trusted sender whitelist for instant finalization
    pub trusted_senders: HashSet<String>,
    /// Minimum confirmations for full finalization
    pub min_confirmations: u64,
}

impl Default for LocalFinalizationConfig {
    fn default() -> Self {
        Self {
            max_instant_amount: 100_000_000_000, // 100 QNC (100 * 10^9 nanoQNC)
            max_instant_gas_price: 100,     // Standard gas price
            trusted_senders: HashSet::new(),
            min_confirmations: 6,           // ~90 seconds for macroblock
        }
    }
}

/// Deterministic contract address in eon format, from the authenticated deployer + monotonic nonce
/// with a domain separator. SINGLE SOURCE OF TRUTH — apply and every deploy-side caller (RPC/producer)
/// derive with this exact fn so the client-returned address equals the on-chain address. Never
/// caller-supplied (no address squatting). Eon shape keeps it valid for downstream address validation.
pub fn derive_contract_address(from: &str, nonce: u64) -> String {
    let mut hasher = Sha3_256::new();
    hasher.update(b"qnet_contract_v1");
    hasher.update(from.as_bytes());
    hasher.update(nonce.to_le_bytes());
    let hash = hex::encode(hasher.finalize());
    let part1 = &hash[0..19];
    let part2 = &hash[19..34];
    let checksum = hex::encode(&Sha3_256::digest(format!("{}eon{}", part1, part2).as_bytes())[..4]);
    format!("{}eon{}{}", part1, part2, checksum)
}

/// Fail-loud read of a numeric contract_storage entry (QRC-20 balance/allowance).
/// Absent key = 0 (never held). Present-but-unparseable = corruption: reject, NEVER coerce to 0,
/// so silent data corruption can never mint or mask a loss. u128 so callers use checked u128 math.
fn read_balance(store: &HashMap<String, String>, key: &str) -> Result<u128, StateError> {
    match store.get(key) {
        None => Ok(0),
        Some(val) => val.parse::<u128>().map_err(|_| {
            StateError::InvalidTransaction(format!("[REJECT][QRC20] corrupted_balance key={}", key))
        }),
    }
}

/// Parse a QRC-20 amount arg as u64, accepting EITHER a JSON number (as_u64) OR a JSON string
/// (decimal, parsed as u64). String form kills the >2^53 JS-float precision limit so a client can
/// send the full u64 range exactly; number form stays valid for small amounts. Anything else (float,
/// bool, null, negative, overflow, non-numeric string, absent) rejects fail-loud — no silent 0.
fn parse_amount(v: Option<&serde_json::Value>) -> Result<u64, StateError> {
    match v {
        Some(serde_json::Value::Number(n)) => n.as_u64().ok_or_else(|| {
            StateError::InvalidTransaction("[REJECT][QRC20] bad_amount_arg".to_string())
        }),
        Some(serde_json::Value::String(s)) => s.parse::<u64>().map_err(|_| {
            StateError::InvalidTransaction("[REJECT][QRC20] bad_amount_arg".to_string())
        }),
        _ => Err(StateError::InvalidTransaction("[REJECT][QRC20] bad_amount_arg".to_string())),
    }
}

/// QRC-721 ownership move shared by transfer/transferFrom — the SINGLE place a token changes hands,
/// so both entry points enforce identical count/deposit/approval accounting (ownership integrity).
/// Preconditions (checked by the caller): `from` currently owns `owner_key`, and the caller is
/// authorized. Effects: set owner_key=to; dec bal:{from} (remove+refund on 0); inc bal:{to}
/// (new-entry deposit if needed); clear approved (refund if it existed). `payer` funds new-entry
/// deposits (the tx sender). ALIASING-SAFE: when from==to the dec-then-reread-inc nets to a no-op and
/// counts stay consistent, so a self-transfer can neither mint nor drop a holding.
fn nft_move_token(
    accounts: &mut HashMap<String, Account>,
    contract_addr: &str,
    payer: &str,
    from: &str,
    to: &str,
    owner_key: &str,
    approved_key: &str,
) -> Result<(), StateError> {
    let from_bal_key = format!("bal:{}", from);
    let to_bal_key = format!("bal:{}", to);

    // New recipient count entry ⇒ charge deposit (bound to contains_key BEFORE writes). Skip when
    // from==to: the entry already exists (from owns the token ⇒ its count is present), so no new key.
    let to_is_new = {
        let store = &accounts.get(contract_addr).unwrap().contract_storage;
        if from_bal_key != to_bal_key
            && store.len() >= MAX_CONTRACT_STORAGE_ENTRIES && !store.contains_key(&to_bal_key) {
            return Err(StateError::InvalidTransaction(format!(
                "[REJECT][NFT] transfer_storage_limit_reached entries={} max={}",
                store.len(), MAX_CONTRACT_STORAGE_ENTRIES)));
        }
        from_bal_key != to_bal_key && !store.contains_key(&to_bal_key)
    };
    if to_is_new {
        charge_storage_deposit(accounts, payer, 1)?;
    }

    // Ownership pointer flips first.
    accounts.get_mut(contract_addr).unwrap()
        .contract_storage.insert(owner_key.to_string(), to.to_string());

    // Decrement from's count (checked); RE-READ + increment to's count. For from==to both operate on
    // the same key: dec writes n-1, the reread sees n-1, inc writes n — a clean no-op, no special case.
    let from_bal = read_balance(
        &accounts.get(contract_addr).unwrap().contract_storage, &from_bal_key)?;
    let new_from_bal = from_bal.checked_sub(1)
        .ok_or_else(|| StateError::InvalidTransaction("[REJECT][NFT] balance_underflow".into()))?;
    accounts.get_mut(contract_addr).unwrap()
        .contract_storage.insert(from_bal_key.clone(), new_from_bal.to_string());

    let to_bal = read_balance(
        &accounts.get(contract_addr).unwrap().contract_storage, &to_bal_key)?;
    let new_to_bal = to_bal.checked_add(1)
        .ok_or_else(|| StateError::InvalidTransaction("[REJECT][NFT] balance_overflow".into()))?;
    accounts.get_mut(contract_addr).unwrap()
        .contract_storage.insert(to_bal_key.clone(), new_to_bal.to_string());

    // Drained sender count (only when NOT a self-transfer): remove the key (no "0" residue) + refund.
    if from_bal_key != to_bal_key && new_from_bal == 0 {
        accounts.get_mut(contract_addr).unwrap().contract_storage.remove(&from_bal_key);
        refund_storage_deposit(accounts, payer, 1)?;
    }

    // Clear approval on any ownership change (+refund its deposit if it existed).
    let had_approval = accounts.get(contract_addr).unwrap()
        .contract_storage.contains_key(approved_key);
    if had_approval {
        accounts.get_mut(contract_addr).unwrap().contract_storage.remove(approved_key);
        refund_storage_deposit(accounts, payer, 1)?;
    }
    Ok(())
}

/// QRC-20 transfer-to-CANONICAL_BURN_ADDR: a REAL burn (works for ANY token, even non-burnable). Debits
/// `holder`, reduces total_supply, bumps total_burned (1:1, checked), NEVER credits the burn address, and
/// emits a "burn" event (empty `to`). Returns whether the holder entry drained to 0 (caller records the
/// OwnsDelta). `payer` receives the drained-entry deposit refund (the tx sender).
fn qrc20_burn_to_sink(
    accounts: &mut HashMap<String, Account>,
    contract_addr: &str,
    holder: &str,
    payer: &str,
    amount: u128,
    tx_hash: &str,
) -> Result<bool, StateError> {
    let from_key = format!("balance:{}", holder);
    let from_bal = read_balance(&accounts.get(contract_addr).unwrap().contract_storage, &from_key)?;
    if from_bal < amount {
        return Err(StateError::InvalidTransaction(format!(
            "[REJECT][QRC20] insufficient_balance have={} need={}", from_bal, amount)));
    }
    let new_from_bal = from_bal.checked_sub(amount)
        .ok_or_else(|| StateError::InvalidTransaction("[REJECT][QRC20] balance_overflow".into()))?;
    accounts.get_mut(contract_addr).unwrap()
        .contract_storage.insert(from_key.clone(), new_from_bal.to_string());
    let drained = new_from_bal == 0;
    if drained {
        accounts.get_mut(contract_addr).unwrap().contract_storage.remove(&from_key);
        refund_storage_deposit(accounts, payer, 1)?;
    }
    // total_supply -= amt, total_burned += amt (checked; mirrors the `burn` method arm).
    let supply = read_balance(&accounts.get(contract_addr).unwrap().contract_storage, "total_supply")?;
    let new_supply = supply.checked_sub(amount)
        .ok_or_else(|| StateError::InvalidTransaction("[REJECT][QRC20] supply_underflow".into()))?;
    accounts.get_mut(contract_addr).unwrap()
        .contract_storage.insert("total_supply".to_string(), new_supply.to_string());
    let burned = read_balance(&accounts.get(contract_addr).unwrap().contract_storage, "total_burned")?;
    let new_burned = burned.checked_add(amount)
        .ok_or_else(|| StateError::InvalidTransaction("[REJECT][QRC20] burned_overflow".into()))?;
    accounts.get_mut(contract_addr).unwrap()
        .contract_storage.insert("total_burned".to_string(), new_burned.to_string());
    if is_info_log() {
        println!("[INFO][QRC20] burn from={} amount={} supply={} contract={}",
            &holder[..holder.len().min(16)], amount, new_supply,
            &contract_addr[..contract_addr.len().min(16)]);
    }
    crate::wasm_exec::push_wasm_log(tx_hash, contract_addr,
        crate::wasm_exec::encode_transfer_log("qrc20", "burn", holder, "", amount, ""));
    Ok(drained)
}

/// QRC-721 transfer-to-CANONICAL_BURN_ADDR: a REAL burn — the token ceases to exist. Removes owner:{id}
/// (refund its always-charged mint deposit), decrements bal:{from} (remove+refund on 0), clears any
/// approval (+refund), and NEVER creates bal:{burn}. Caller emits the "burn" event. Precondition (caller):
/// `from` owns the token and the caller is authorized — identical to nft_move_token.
fn nft_burn_token(
    accounts: &mut HashMap<String, Account>,
    contract_addr: &str,
    payer: &str,
    from: &str,
    owner_key: &str,
    approved_key: &str,
) -> Result<(), StateError> {
    let from_bal_key = format!("bal:{}", from);
    // Remove the ownership pointer (token destroyed) + refund the deposit charged for it at mint.
    accounts.get_mut(contract_addr).unwrap().contract_storage.remove(owner_key);
    refund_storage_deposit(accounts, payer, 1)?;
    // Decrement the holder's count (checked); remove+refund the entry when it reaches 0.
    let from_bal = read_balance(&accounts.get(contract_addr).unwrap().contract_storage, &from_bal_key)?;
    let new_from_bal = from_bal.checked_sub(1)
        .ok_or_else(|| StateError::InvalidTransaction("[REJECT][NFT] balance_underflow".into()))?;
    accounts.get_mut(contract_addr).unwrap()
        .contract_storage.insert(from_bal_key.clone(), new_from_bal.to_string());
    if new_from_bal == 0 {
        accounts.get_mut(contract_addr).unwrap().contract_storage.remove(&from_bal_key);
        refund_storage_deposit(accounts, payer, 1)?;
    }
    // Clear any approval (+refund if it existed).
    if accounts.get(contract_addr).unwrap().contract_storage.contains_key(approved_key) {
        accounts.get_mut(contract_addr).unwrap().contract_storage.remove(approved_key);
        refund_storage_deposit(accounts, payer, 1)?;
    }
    Ok(())
}

/// Move `n_entries` worth of storage-rent deposit from `payer` native balance to the reserved
/// escrow — a pure account-to-account MOVE (no mint/burn). Deterministic: bound only to the count
/// of NEW storage entries created by this op. Rejects if the payer cannot cover the deposit.
fn charge_storage_deposit(
    accounts: &mut HashMap<String, Account>,
    payer: &str,
    n_entries: u64,
) -> Result<(), StateError> {
    if n_entries == 0 { return Ok(()); }
    let total = (n_entries as u128)
        .checked_mul(STORAGE_DEPOSIT_PER_ENTRY_NANO_QNC as u128)
        .and_then(|t| u64::try_from(t).ok())
        .ok_or_else(|| StateError::InvalidTransaction("[REJECT][QRC20] deposit_overflow".into()))?;
    let payer_acct = accounts.get_mut(payer)
        .ok_or_else(|| StateError::AccountNotFound(payer.to_string()))?;
    if payer_acct.balance < total {
        return Err(StateError::InvalidTransaction(format!(
            "[REJECT][QRC20] insufficient_deposit have={} need={}", payer_acct.balance, total)));
    }
    payer_acct.balance -= total;
    let escrow = accounts.entry(STORAGE_RENT_ESCROW_ADDR.to_string())
        .or_insert_with(|| Account::new(STORAGE_RENT_ESCROW_ADDR.to_string()));
    escrow.balance = escrow.balance.checked_add(total)
        .ok_or_else(|| StateError::InvalidTransaction("[REJECT][QRC20] escrow_overflow".into()))?;
    Ok(())
}

/// Refund `n_entries` worth of deposit from escrow back to `payee` when storage entries are removed.
/// Saturating on the escrow side so it can never underflow (refund is capped at escrow holdings).
fn refund_storage_deposit(
    accounts: &mut HashMap<String, Account>,
    payee: &str,
    n_entries: u64,
) -> Result<(), StateError> {
    if n_entries == 0 { return Ok(()); }
    let want = (n_entries as u128)
        .checked_mul(STORAGE_DEPOSIT_PER_ENTRY_NANO_QNC as u128)
        .and_then(|t| u64::try_from(t).ok())
        .ok_or_else(|| StateError::InvalidTransaction("[REJECT][QRC20] refund_overflow".into()))?;
    let escrow_bal = accounts.get(STORAGE_RENT_ESCROW_ADDR).map(|a| a.balance).unwrap_or(0);
    // CONSERVATION INVARIANT: every refundable entry is charged on creation (charge_storage_deposit),
    // so the escrow ALWAYS holds at least the deposit for any entry now being removed. If this fails,
    // an entry was created without a matching charge (accounting bug) or was double-refunded — FAIL
    // LOUD and deterministically (all nodes read the same escrow balance ⇒ same reject ⇒ no fork)
    // instead of silently paying `min(want, escrow_bal)`, which masked the break and let honest
    // holders' refunds shrink to zero once the pool was under-funded.
    if escrow_bal < want {
        return Err(StateError::InvalidTransaction(format!(
            "[REJECT][QRC20] escrow_underfunded have={} need={} — storage-deposit accounting invariant violated",
            escrow_bal, want)));
    }
    if let Some(escrow) = accounts.get_mut(STORAGE_RENT_ESCROW_ADDR) {
        escrow.balance = escrow.balance.saturating_sub(want);
    }
    let payee_acct = accounts.entry(payee.to_string())
        .or_insert_with(|| Account::new(payee.to_string()));
    payee_acct.balance = payee_acct.balance.checked_add(want)
        .ok_or_else(|| StateError::InvalidTransaction("[REJECT][QRC20] refund_credit_overflow".into()))?;
    Ok(())
}

impl Transaction {
    /// Calculate transaction hash as Vec<u8>
    pub fn hash(&self) -> StateResult<Vec<u8>> {
        let data = serde_json::to_vec(self)?;
        Ok(blake3::hash(&data).as_bytes().to_vec())
    }
    
    /// Create new transaction
    pub fn new(
        from: String,
        to: Option<String>,
        amount: u64,
        nonce: u64,
        gas_price: u64,
        gas_limit: u64,
        timestamp: u64,
        signature: Option<String>,
        tx_type: TransactionType,
        data: Option<String>,
    ) -> Self {
        let mut tx = Self {
            hash: String::new(),
            from,
            to,
            amount,
            nonce,
            gas_price,
            gas_limit,
            timestamp,
            signature,
            public_key: None, // Optional: Set by client for Ed25519 verification
            tx_type,
            data,
            dilithium_signature: None, // QUANTUM v2.25: Optional post-quantum signature
            dilithium_public_key: None, // QUANTUM v2.25: Optional post-quantum pubkey
            chain_id: 0, // FIX R23-M1: Default 0 for backward compat
        };
        tx.hash = tx.calculate_hash();
        tx
    }
    
    /// QUANTUM v2.78: Set quantum signature fields after creation (HYBRID ONLY)
    /// ARCHITECTURE: For HYBRID signatures (Ed25519 + Dilithium)
    /// Pure Dilithium not supported - use Hybrid for quantum resistance
    /// v2.101: CRITICAL - Must recalculate hash after changing fields!
    pub fn with_quantum_signature(mut self, dilithium_sig: Option<String>, dilithium_pk: Option<String>) -> Self {
        self.dilithium_signature = dilithium_sig;
        self.dilithium_public_key = dilithium_pk;
        // v2.101: Recalculate hash after changing fields to pass validate()
        self.hash = self.calculate_hash();
        self
    }
    
    /// QUANTUM v2.25.2: Set public key for Ed25519 verification
    /// v2.101: CRITICAL - Must recalculate hash after changing fields!
    pub fn with_public_key(mut self, public_key: Option<String>) -> Self {
        self.public_key = public_key;
        // v2.101: Recalculate hash after changing fields to pass validate()
        self.hash = self.calculate_hash();
        self
    }
    
    /// v3.34: Get ALL addresses that will be read/written by this transaction
    /// CRITICAL for apply_transaction_lazy: must pre-load ALL accounts to prevent
    /// balance overwrites when apply_to_state creates accounts via entry().or_insert_with()
    /// Without this: BatchTransfers recipients get balance=0 (existing balance LOST!)
    pub fn get_all_affected_addresses(&self) -> Vec<String> {
        let mut addresses = vec![self.from.clone()];
        if let Some(ref to) = self.to {
            if !addresses.contains(to) {
                addresses.push(to.clone());
            }
        }
        match &self.tx_type {
            TransactionType::Transfer { from, to, .. } => {
                // Inner from/to may differ from tx.from/tx.to — ensure both loaded
                if !addresses.contains(from) { addresses.push(from.clone()); }
                if !addresses.contains(to) { addresses.push(to.clone()); }
            }
            TransactionType::BatchTransfers { transfers, .. } => {
                for transfer in transfers {
                    if !addresses.contains(&transfer.to_address) {
                        addresses.push(transfer.to_address.clone());
                    }
                }
            }
            TransactionType::BatchNodeActivations { activation_data, .. } => {
                for data in activation_data {
                    if !addresses.contains(&data.owner_address) {
                        addresses.push(data.owner_address.clone());
                    }
                }
            }
            TransactionType::Swap { from, pool_address, .. } => {
                if !addresses.contains(from) { addresses.push(from.clone()); }
                if !addresses.contains(pool_address) { addresses.push(pool_address.clone()); }
            }
            TransactionType::ContractCall => {
                // tx.to (contract address) already added above. The QRC-20 storage-rent deposit MOVES
                // native QNC to/from the reserved escrow, so it MUST be in the lazy working set — else
                // apply_transaction_lazy builds a fresh balance-0 escrow whose merge-back clobbers the
                // real one (burning accrued deposits and zeroing refunds).
                let escrow = STORAGE_RENT_ESCROW_ADDR.to_string();
                if !addresses.contains(&escrow) { addresses.push(escrow); }
                // WASM cross-contract access list (EIP-2930-style): the SIGNED tx declares the
                // contracts a call may reach, so every node pre-loads the SAME working set and the
                // VM resolves cross-calls deterministically. Harmless when the VM is gated off (the
                // extra pre-loaded accounts merge back unchanged); capped to bound pre-load work.
                if let Some(ref data) = self.data {
                    if data.contains("accessList") {
                        if let Ok(p) = serde_json::from_str::<serde_json::Value>(data) {
                            if let Some(list) = p.get("accessList").and_then(|v| v.as_array()) {
                                for it in list.iter().take(crate::wasm_exec::MAX_WASM_ACCESS_LIST) {
                                    if let Some(s) = it.as_str() {
                                        let s = s.to_string();
                                        if !addresses.contains(&s) { addresses.push(s); }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            TransactionType::ContractDeploy => {
                // Load the derived contract account so the init-once guard sees an existing contract in
                // the lazy path regardless of the caller-supplied tx.to.
                let derived = derive_contract_address(&self.from, self.nonce);
                if !addresses.contains(&derived) { addresses.push(derived); }
                // A QRC-20 deploy with initial_supply>0 charges the deployer a storage-rent deposit INTO
                // the escrow. It MUST be in the lazy working set (same as ContractCall) — else merge-back
                // clobbers the real escrow with a fresh balance-0 one, burning every accrued deposit.
                let escrow = STORAGE_RENT_ESCROW_ADDR.to_string();
                if !addresses.contains(&escrow) { addresses.push(escrow); }
            }
            _ => {} // Other types only touch tx.from / tx.to
        }
        addresses
    }
    
    /// QUANTUM v2.78: Check if transaction uses HYBRID signature (quantum-resistant)
    /// ARCHITECTURE: Two TX signature types:
    /// - Ed25519 only: Fast, classical (64 bytes, standard gas)
    /// - Hybrid (Ed25519+Dilithium): Quantum-resistant (~2.6KB, +50% gas)
    pub fn is_quantum_signed(&self) -> bool {
        self.dilithium_signature.is_some() && self.dilithium_public_key.is_some()
    }
    
    /// QUANTUM v2.78: Get effective gas price (50% higher for HYBRID TX)
    /// This compensates for larger TX size (~2.6KB vs 64 bytes) and verification cost
    pub fn effective_gas_price(&self) -> u64 {
        if self.is_quantum_signed() {
            // FIX M1: checked_add for 50% gas premium (defense-in-depth)
            self.gas_price.saturating_add(self.gas_price / 2)
        } else {
            self.gas_price
        }
    }

    /// v14.8.4: System-transaction classifier.
    ///
    /// Returns true for protocol-level transactions that MUST be acceptable
    /// with gas_price = 0. These are bootstrap/maintenance messages whose
    /// payment or authorisation is proven elsewhere:
    ///   - NodeActivation / NodeRegistration / NodeReactivation:
    ///       payment proof is an external Solana 1DEV burn TX (Phase 1)
    ///       or an on-chain QNC-to-Pool3 transfer (Phase 2), plus a valid
    ///       activation code that is deduped at state-apply time. A user
    ///       coming online for the first time has NO QNC balance yet, so
    ///       charging a mempool fee would create a hard chicken-and-egg.
    ///   - PingAttestation / PingCommitmentWithSampling / HeartbeatCommitment
    ///     / LightNodeEligibilityBitmap: validator-signed liveness messages
    ///       authorised by the sender's consensus identity; no user wallet
    ///       is charged.
    ///   - RewardDistribution: emitted by the protocol itself at macroblock
    ///       boundaries; no wallet originates it.
    ///   - KeyRotation: self-authorised by the key being rotated.
    ///
    /// DoS protection for the bypass path lives ONE LAYER ABOVE the mempool:
    ///   - Activation TXs must reference a confirmed Solana burn TX with the
    ///     correct 1DEV mint and amount (see `verify_burn_transaction_exists`).
    ///   - Each burn_tx hash / activation code is recorded on-chain and can
    ///     be used exactly once; a replay lands in a dedup set and is
    ///     rejected at apply_to_state.
    ///   - Ping/Heartbeat/Attestation TXs carry Dilithium3 sender signatures
    ///     verified pre-mempool; impostors cannot spam.
    ///
    /// Consistent with `compute_gas_used() == 0` for every variant listed
    /// below (except NodeActivation which uses `gas_limits::NODE_ACTIVATION`
    /// for metering purposes but is still a system TX).
    /// Canonical message a committee member signs to attest a Phase-1 Solana 1DEV burn backing a node
    /// registration. FIXED format (pipe-joined, node_type as a stable integer) so all signers produce
    /// identical bytes and every validator recomputes the identical message at block validation —
    /// no float / locale / map-iteration input. Binds the burn tx, beneficiary wallet, amount, node
    /// type AND the required Phase-1 cost, so a quorum signature is valid for exactly one
    /// (burn, wallet, amount, type, cost, attest_epoch) tuple. The `cost` lives INSIDE the 2f+1-signed
    /// message so every validator agrees on it by signature-verification, never by re-reading Solana.
    /// `attest_epoch` = the epoch whose committee attested (M-5): bound in so the apply-time verifier
    /// resolves the SAME committee the attestors used, closing the arm-tip/apply-height straddle.
    pub fn burn_attestation_message(burn_tx: &str, wallet: &str, amount: u64, node_type: &NodeType, cost: u64, attest_epoch: u64) -> String {
        let nt: u8 = match node_type {
            NodeType::Super => 0,
            NodeType::Light => 1,
        };
        format!("burn_attest:{}:{}:{}:{}:{}:{}", burn_tx, wallet, amount, nt, cost, attest_epoch)
    }

    /// Deterministic Phase-1 super/light activation cost in whole 1DEV, computed with INTEGER math so
    /// every node agrees (the f64 burn_percentage diverges across nodes). Mirrors the off-chain
    /// formula `max(1500 - 150*floor(burn_pct/10), 300)`: base 1500, −150 per complete 10% of the
    /// 1DEV supply burned, floored at 300. Universal Light=Super in Phase 1.
    /// `burn_pct_tenths` = burn% to one decimal; `tiers` = each complete 10% (capped at 8 → floor 300).
    /// Bucketing to 10% means members reading Solana at slightly different times still agree on the
    /// cost except exactly at a 10% boundary (there the registration just retries — a liveness hiccup,
    /// not a fork).
    pub fn phase1_activation_cost(total_burned: u64, current_supply: u64) -> u64 {
        // burn% = burned / ORIGINAL supply; original = burned + current(remaining). Denominator is their
        // SUM, not the remaining alone (else 50% burned would read as 100%). current_supply is the live
        // Solana getTokenSupply (remaining); the sum reconstructs the original cap.
        let original = total_burned.saturating_add(current_supply);
        let burn_pct_tenths = if original == 0 { 0 } else { total_burned * 1000 / original };
        let tiers = burn_pct_tenths / 100; // each complete 10%
        1500u64.saturating_sub(150 * tiers.min(8)).max(300)
    }

    pub fn is_system_tx(&self) -> bool {
        matches!(
            &self.tx_type,
            TransactionType::NodeActivation { .. }
                | TransactionType::NodeRegistration { .. }
                | TransactionType::NodeReactivation { .. }
                | TransactionType::PingAttestation { .. }
                | TransactionType::PingCommitmentWithSampling { .. }
                | TransactionType::HeartbeatCommitment { .. }
                | TransactionType::Heartbeat { .. }
                | TransactionType::LightNodeEligibilityBitmap { .. }
                | TransactionType::RewardDistribution
                | TransactionType::KeyRotation { .. }
                | TransactionType::EquivocationProof { .. }
                | TransactionType::VoteEquivocationProof { .. }
        )
    }

    /// v15.5: Returns true for the subset of system TXs that have
    /// deterministic `(identity, epoch_or_index)` semantics. For these the
    /// local mempool must enforce single-version replacement so that retries
    /// (legitimate or accidental) cannot accumulate duplicates of the same
    /// logical commitment in a single block.
    ///
    /// Non-commitment system TXs (`RewardDistribution`, `KeyRotation`,
    /// `NodeActivation`, `PingAttestation`, batch types) keep the regular
    /// hash-only dedup path because they either have unique-per-instance
    /// payload, single-shot pre-existing guards, or no retry mechanism.
    ///
    /// Designed for the multi-thousand super-node scale: callers compute the
    /// dedup key in `O(1)` and consult lock-free indices in the mempool, so
    /// the per-TX overhead is constant regardless of validator count.
    pub fn is_commitment(&self) -> bool {
        matches!(
            &self.tx_type,
            TransactionType::HeartbeatCommitment { .. }
                | TransactionType::Heartbeat { .. }
                | TransactionType::PingCommitmentWithSampling { .. }
                | TransactionType::LightNodeEligibilityBitmap { .. }
                | TransactionType::NodeRegistration { .. }
                | TransactionType::NodeReactivation { .. }
        )
    }

    /// v15.5: Compound dedup key for commitment-class TXs:
    /// `(identity, epoch_or_index, type_id)`.
    ///
    /// Two TXs sharing this key are semantically the same commitment and the
    /// mempool must keep only the most recent one. Returns `None` for any
    /// non-commitment TX, in which case the regular hash-based dedup path
    /// applies.
    ///
    /// Identity / epoch derivation MIRRORS `state.rs::check_duplicate_commitment`
    /// 1-to-1 — otherwise a TX admitted to the local mempool could later be
    /// rejected at apply time as a duplicate of one already on chain, which
    /// is exactly the failure mode this method exists to prevent.
    ///
    /// Type IDs are dense `u8` constants so the full key tuple has a small
    /// footprint and is suitable as a `DashMap` key at the
    /// thousands-of-validators scale where commitment-boundary bursts can
    /// produce millions of entries per epoch transition window.
    pub fn commitment_dedup_key(&self) -> Option<(String, u64, u8)> {
        const EPOCH_INTERVAL: u64 = 14400; // matches state.rs EMISSION_BLOCK_INTERVAL
        match &self.tx_type {
            TransactionType::HeartbeatCommitment { node_id, window_start_height, .. } => {
                Some((node_id.clone(), window_start_height / EPOCH_INTERVAL, 1))
            }
            TransactionType::Heartbeat { node_id, anchor_height, .. } => {
                // Dedup per (node, epoch, subwindow): a flood of heartbeats in one subwindow
                // collapses to a single mempool entry (apply is idempotent on the bitmask
                // regardless). 10 subwindows/epoch ⇒ key = epoch*10 + subwindow.
                let epoch = anchor_height / EPOCH_INTERVAL;
                let subwindow = (anchor_height % EPOCH_INTERVAL) / 1440;
                Some((node_id.clone(), epoch * 10 + subwindow, 7))
            }
            TransactionType::PingCommitmentWithSampling { window_start_height, .. } => {
                Some((self.from.clone(), window_start_height / EPOCH_INTERVAL, 2))
            }
            TransactionType::LightNodeEligibilityBitmap { genesis_id, epoch, .. } => {
                Some((genesis_id.clone(), *epoch, 3))
            }
            TransactionType::NodeRegistration { node_id, .. } => {
                // One-shot for the chain's lifetime. Constant `0` epoch
                // collapses any duplicate registration attempt onto the same
                // dedup key regardless of arrival time.
                Some((node_id.clone(), 0, 4))
            }
            TransactionType::NodeReactivation { node_id, last_macroblock_index, .. } => {
                Some((node_id.clone(), *last_macroblock_index, 5))
            }
            // v32.13: NodeActivation one-shot per (wallet, phase).
            // One sender cannot activate twice in same phase.
            TransactionType::NodeActivation { phase, .. } => {
                let phase_id: u64 = match phase {
                    crate::account::ActivationPhase::Phase1 => 1,
                    crate::account::ActivationPhase::Phase2 => 2,
                };
                Some((self.from.clone(), phase_id, 6))
            }
            _ => None,
        }
    }

    /// v3.36: Gas metering -- compute ACTUAL gas consumed per TX type
    /// Ethereum-style: user pays for gas_used, not gas_limit.
    /// gas_limit serves as maximum cap (out-of-gas if exceeded).
    /// For ContractDeploy/Call: includes per-byte cost for code/data.
    /// For future WASM VM: will return execution-measured gas instead of estimates.
    pub fn compute_gas_used(&self) -> u64 {
        match &self.tx_type {
            TransactionType::Transfer { .. } => gas_limits::TRANSFER,
            TransactionType::CreateAccount { .. } => gas_limits::TRANSFER,
            TransactionType::NodeActivation { .. } => gas_limits::NODE_ACTIVATION,
            TransactionType::ContractDeploy => {
                // FIX M2: checked arithmetic for per-byte gas cost (defense-in-depth)
                let code_bytes = self.data.as_ref().map(|d| d.len()).unwrap_or(0);
                gas_limits::CONTRACT_DEPLOY.saturating_add((code_bytes as u64).saturating_mul(10))
            }
            TransactionType::ContractCall => {
                // FIX M2: checked arithmetic for per-byte gas cost (defense-in-depth)
                let data_bytes = self.data.as_ref().map(|d| d.len()).unwrap_or(0);
                gas_limits::CONTRACT_CALL.saturating_add((data_bytes as u64).saturating_mul(5))
            }
            TransactionType::Swap { .. } => gas_limits::CONTRACT_CALL,
            // System transactions: free (no gas)
            TransactionType::RewardDistribution => 0,
            TransactionType::PingAttestation { .. } => 0,
            TransactionType::PingCommitmentWithSampling { .. } => 0,
            TransactionType::HeartbeatCommitment { .. } => 0,
            TransactionType::Heartbeat { .. } => 0,
            TransactionType::LightNodeEligibilityBitmap { .. } => 0,
            TransactionType::NodeRegistration { .. } => 0,
            TransactionType::NodeReactivation { .. } => 0,
            // Deprecated batch types: per-item gas based on operation type
            // FIX M2: saturating_mul prevents overflow on large batches
            TransactionType::BatchRewardClaims { node_ids, .. } => {
                gas_limits::REWARD_CLAIM.saturating_mul(node_ids.len() as u64)
            }
            TransactionType::BatchNodeActivations { activation_data, .. } => {
                gas_limits::NODE_ACTIVATION.saturating_mul(activation_data.len() as u64)
            }
            TransactionType::BatchTransfers { transfers, .. } => {
                gas_limits::TRANSFER.saturating_mul(transfers.len() as u64)
            }
            // FIX R23-K1: Key rotation is a system operation (free gas)
            TransactionType::KeyRotation { .. } => 0,
            // Equivocation slashing proofs: system TX, free (no gas, no balance effect).
            TransactionType::EquivocationProof { .. } => 0,
            TransactionType::VoteEquivocationProof { .. } => 0,
        }
    }

    /// v3.36: Compute gas refund amount (Ethereum EIP-1559 style)
    /// Returns the nanoQNC to refund to sender: (gas_limit - gas_used) * effective_gas_price
    /// IMPORTANT: Caller must credit this to sender AFTER apply_to_state() succeeds.
    /// ACTIVATION: Only apply refund for blocks >= GAS_METERING_ACTIVATION_HEIGHT
    /// to preserve consensus for historical blocks.
    pub fn compute_gas_refund(&self) -> u64 {
        let gas_used = self.compute_gas_used();
        if gas_used > 0 && self.gas_limit > gas_used {
            // FIX R24-H2: Use saturating_mul to prevent silent refund loss on overflow.
            // System TXs use gas_price=u64::MAX; checked_mul().unwrap_or(0) would lose
            // the entire refund on overflow. saturating_mul caps at u64::MAX instead.
            (self.gas_limit - gas_used).saturating_mul(self.effective_gas_price())
        } else {
            0
        }
    }

    /// WASM compute (fuel) this TX is allowed to RESERVE for the metered VM — the CPU-DoS budget
    /// unit summed against `gas_limits::BLOCK_FUEL_LIMIT` at block build and block verify.
    /// Equals the fuel budget the apply path hands the interpreter: `gas_limit - intrinsic`
    /// (the SAME `gas_limit.saturating_sub(compute_gas_used())` used to seed execute_wasm_calltree),
    /// so bounding the block's summed reserved fuel bounds its worst-case interpreter work. Only a
    /// ContractCall runs the fuel-metered VM; every other type (incl. ContractDeploy, which only
    /// validates a bounded module) reserves none. A native QRC-20 ContractCall never reaches the VM,
    /// so counting its reservation is merely conservative (safe over-count) — and it correctly
    /// rewards tight `gas_limit`s. Pure function of signed fields ⇒ identical on every node.
    pub fn reserved_fuel(&self) -> u64 {
        match &self.tx_type {
            TransactionType::ContractCall => self.gas_limit.saturating_sub(self.compute_gas_used()),
            _ => 0,
        }
    }

    /// Metered WASM-compute fee (nanoQNC) for `fuel` units this call actually burned:
    /// `fuel * effective_gas_price`. Applied ONLY at heights >= GAS_METERING_ACTIVATION_HEIGHT (where
    /// the flat gas refund would otherwise let a compute-heavy call pay the same flat intrinsic as a
    /// trivial one). It is a SYMMETRIC account MOVE — subtracted from the sender's gas refund and added
    /// to the producer's fee credit — so total supply is unchanged and conservation holds by
    /// construction. `fuel` is a wasmi instruction count (deterministic), and effective_gas_price is a
    /// pure fn of the signed tx, so every node computes the identical fee (no state_root split).
    /// Zero for fuel==0, i.e. every non-WASM tx.
    pub fn wasm_fuel_fee(&self, fuel: u64) -> u64 {
        fuel.saturating_mul(self.effective_gas_price())
    }

    /// Calculate transaction hash as hex string
    /// Get canonical serialization for hash calculation (excludes hash and signatures)
    /// PRODUCTION: Deterministic bincode serialization ensures consistent hashing
    /// NOTE: public_key/dilithium_public_key ARE included in canonical_bytes
    /// because they're set BEFORE hash calculation (client-side signing)
    pub fn canonical_bytes(&self) -> Vec<u8> {
        // Create canonical version: all fields except hash and signatures
        // public_key IS included - must be set before calculate_hash()!
        let mut canonical = self.clone();
        canonical.hash = String::new();
        canonical.signature = None;
        canonical.dilithium_signature = None;
        
        // Deterministic canonical serialization (includes tx_type, data, all fields)
        // FIX R22-S3: unwrap_or_default() silently produced empty Vec on failure,
        // causing ALL failed TXs to hash to the same SHA3-256(empty) constant.
        // bincode::serialize on an in-memory struct cannot fail (no I/O, no size overflow),
        // so expect() is safe here. If it ever did fail, a panic is far safer than
        // silent hash collision which could bypass duplicate detection.
        bincode::serialize(&canonical)
            .expect("[FATAL][TX] canonical_bytes serialization failed — struct is in-memory, this is unreachable")
    }
    
    /// NIST FIPS 202 compliant (SHA3-256) for transaction signatures
    /// Hash is calculated from canonical serialized bytes
    pub fn calculate_hash(&self) -> TxHash {
        let canonical_bytes = self.canonical_bytes();
        format!("{:x}", Sha3_256::digest(&canonical_bytes))
    }
    
    /// Get transaction value
    pub fn value(&self) -> u64 {
        self.amount
    }
    
    /// Check if transaction is valid
    pub fn validate(&self) -> Result<(), String> {
        // Basic validation
        if self.from.is_empty() {
            return Err("[REJECT][TX] empty_sender_address".to_string());
        }

        // ═══════════════════════════════════════════════════════════════════════
        // SENDER ADDRESS FORMAT VALIDATION (defense against address impersonation)
        // ═══════════════════════════════════════════════════════════════════════
        // The sender field must match one of the following well-defined formats:
        //
        //   1. Standard user address — 45 chars, "eon" marker at position 19,
        //      SHA3-256 4-byte checksum at position 37-45.
        //
        //   2. Reserved protocol identifiers — these are produced ONLY by the
        //      block-construction path (locally by the producer) and MUST NEVER
        //      arrive from external sources (mempool / P2P gossip / RPC). The
        //      `validate_and_add_network_transaction` path enforces tx_type
        //      whitelist that complements this check.
        //
        //   3. Node-binding identifiers — node_id pseudonyms used as sender
        //      for system commitments (HeartbeatCommitment, PingCommitment).
        //
        // REJECTING UNKNOWN-FORMAT SENDERS prevents attacks where an adversary
        // crafts a transaction with `from = "system"` to bypass apply-time
        // string-match authority checks (e.g. C1 SECURITY in CreateAccount).
        // The string-match logic remains for backward-compat with genesis TX
        // serialisation, but it can no longer be triggered by user-submitted
        // transactions because non-eon, non-reserved senders are rejected here.
        //
        // SCALABILITY: O(1) per TX (constant-set lookup + 45-char regex-free
        // check). Identical cost at 5 or 5000 validators.
        // ═══════════════════════════════════════════════════════════════════════
        if !is_valid_sender_format(&self.from) {
            return Err(format!(
                "[REJECT][TX] invalid_sender_format from={} (must be eon address, reserved protocol id, or node identifier)",
                &self.from[..self.from.len().min(40)]
            ));
        }

        // v2.101: Hash validation - STRICT for ALL transaction types
        // bincode serialization IS deterministic for our structures (no HashMap, no floats)
        // Previous "workaround" for system TXs was unnecessary - removed
        let calculated_hash = self.calculate_hash();
        if self.hash != calculated_hash {
            return Err(format!(
                "[REJECT][TX] invalid_hash stored={}.. calculated={}.. type={:?}",
                &self.hash[..16.min(self.hash.len())],
                &calculated_hash[..16.min(calculated_hash.len())],
                std::mem::discriminant(&self.tx_type)
            ));
        }
        
        // Type-specific validation
        match &self.tx_type {
            TransactionType::Transfer { from, amount, .. } => {
                // v3.0: Self-transfers are ALLOWED (testing, nonce increment, consolidation).
                if *amount == 0 {
                    return Err("[REJECT][TX] zero_transfer_amount".to_string());
                }
                if self.to.as_ref().map(|s| s.is_empty()).unwrap_or(true) {
                    return Err("[REJECT][TX] empty_recipient_address".to_string());
                }
                // SENDER-IDENTITY ENFORCEMENT
                // ────────────────────────────
                // The TX-level sender (`self.from`) is the wallet whose Dilithium3
                // keypair signed the canonical bytes; it is also the wallet whose
                // registered PK is checked against `self.dilithium_public_key` at
                // apply time. The payload `from` field inside `Transfer` MUST equal
                // `self.from` — without this check, a peer could craft a TX whose
                // signed canonical message names ATTACKER as sender (sig verifies
                // against attacker's PK) while the apply path mutates VICTIM's
                // account because `apply_to_state` reads `accounts[Transfer.from]`.
                // Every honest wallet client emits matching pairs; mismatch is
                // unambiguously hostile.
                if from != &self.from {
                    return Err(format!(
                        "[REJECT][TX] transfer_sender_mismatch tx_from={} payload_from={} \
                         action=reject hint=payload_from_must_equal_tx_from",
                        &self.from[..self.from.len().min(20)],
                        &from[..from.len().min(20)]
                    ));
                }
            }
            TransactionType::NodeActivation { amount, phase, .. } => {
                // Phase 1: amount = 0 (only activation record, 1DEV burned externally on Solana)
                // Phase 2: amount > 0 (QNC transferred to Pool 3 for redistribution to all nodes)
                match phase {
                    ActivationPhase::Phase1 => {
                        if *amount != 0 {
                            return Err("[REJECT][NODE-ACTIVATION] phase1_nonzero_amount".to_string());
                        }
                    }
                    ActivationPhase::Phase2 => {
                        if *amount == 0 {
                            return Err("[REJECT][NODE-ACTIVATION] phase2_zero_amount".to_string());
                        }
                    }
                }
            }
            TransactionType::ContractDeploy => {
                // No additional validation needed for ContractDeploy
            }
            TransactionType::ContractCall => {
                if self.to.as_ref().map(|s| s.is_empty()).unwrap_or(true) {
                    return Err("[REJECT][CONTRACT] empty_contract_address".to_string());
                }
            }
            TransactionType::Swap { from, token_in, token_out, amount_in, amount_out_min, pool_address, .. } => {
                if from.is_empty() {
                    return Err("[REJECT][SWAP] empty_sender_address".to_string());
                }
                if token_in.is_empty() || token_out.is_empty() {
                    return Err("[REJECT][SWAP] empty_token_identifier".to_string());
                }
                if token_in == token_out {
                    return Err("[REJECT][SWAP] same_token_swap".to_string());
                }
                if *amount_in == 0 {
                    return Err("[REJECT][SWAP] zero_swap_amount".to_string());
                }
                if pool_address.is_empty() {
                    return Err("[REJECT][SWAP] empty_pool_address".to_string());
                }
                // SENDER-IDENTITY ENFORCEMENT
                // ────────────────────────────
                // Same threat model as Transfer above: `apply_to_state` mutates
                // `accounts[Swap.from]` which carries the QNC debit and the
                // pool deposit. The signing canonical message names `self.from`,
                // not `Swap.from`, so without this gate any peer can submit a
                // Swap whose payload `from` is an arbitrary victim wallet —
                // signature still verifies against the attacker's registered
                // PK, but the apply path drains the victim's balance. Every
                // honest DEX client emits matching pairs; mismatch is hostile.
                if from != &self.from {
                    return Err(format!(
                        "[REJECT][SWAP] sender_mismatch tx_from={} payload_from={} \
                         action=reject hint=payload_from_must_equal_tx_from",
                        &self.from[..self.from.len().min(20)],
                        &from[..from.len().min(20)]
                    ));
                }
                // amount_out_min can be 0 (no slippage protection, risky but allowed)
                let _ = amount_out_min;
            }
            TransactionType::RewardDistribution => {
                // No additional validation needed for RewardDistribution
            }
            TransactionType::CreateAccount { address, initial_balance } => {
                if address.is_empty() {
                    return Err("[REJECT][CREATE-ACCOUNT] empty_address".to_string());
                }
                if *initial_balance == 0 {
                    return Err("[REJECT][CREATE-ACCOUNT] zero_initial_balance".to_string());
                }
                // C1 SECURITY: Only system/genesis accounts can mint initial balance
                if *initial_balance > 0 {
                    let sender = &self.from;
                    let is_system = sender == "system" || sender == "genesis" || sender == "system_rewards_pool";
                    let has_system_sig = self.signature.as_deref() == Some("system")
                        || self.signature.as_deref() == Some("genesis");
                    if !is_system && !has_system_sig {
                        return Err(format!(
                            "[REJECT][CREATE-ACCOUNT] sender={} not authorized to mint initial_balance={}",
                            sender, initial_balance
                        ));
                    }
                }
            }

            TransactionType::BatchRewardClaims { node_ids, .. } => {
                if node_ids.is_empty() {
                    return Err("[REJECT][BATCH-CLAIM] empty_node_ids".to_string());
                }
                // FIX H32: Enforce max batch size to prevent DoS via oversized batches
                if node_ids.len() > 1000 {
                    return Err("[REJECT][BATCH-CLAIM] batch_too_large max=1000".to_string());
                }
            }
            TransactionType::BatchNodeActivations { activation_data, .. } => {
                if activation_data.is_empty() {
                    return Err("[REJECT][BATCH-ACTIVATION] empty_activation_data".to_string());
                }
                if activation_data.len() > 500 {
                    return Err("[REJECT][BATCH-ACTIVATION] batch_too_large max=500".to_string());
                }
            }
            TransactionType::BatchTransfers { transfers, .. } => {
                if transfers.is_empty() {
                    return Err("[REJECT][BATCH-TX] empty_transfers".to_string());
                }
                if transfers.len() > 1000 {
                    return Err("[REJECT][BATCH-TX] batch_too_large max=1000".to_string());
                }
                // Validate each transfer amount
                for transfer in transfers {
                    if transfer.amount == 0 {
                        return Err("[REJECT][BATCH-TX] zero_transfer_amount".to_string());
                    }
                }
            }
            TransactionType::PingAttestation { from_node, to_node, response_time_ms, .. } => {
                if from_node.is_empty() {
                    return Err("[REJECT][TX] empty_ping_from_node".to_string());
                }
                if to_node.is_empty() {
                    return Err("[REJECT][TX] empty_ping_to_node".to_string());
                }
                if *response_time_ms > 60000 {
                    return Err(format!("[REJECT][TX] ping_response_time_exceeded value={}", response_time_ms));
                }
                // CRITICAL: Ping attestations are FREE (gas_limit must be 0)
                if self.gas_limit != gas_limits::PING {
                    return Err(format!("[REJECT][TX] ping_nonzero_gas_limit value={}", self.gas_limit));
                }
            }
            TransactionType::PingCommitmentWithSampling { 
                window_start_height, 
                window_end_height, 
                merkle_root,
                total_ping_count,
                successful_ping_count,
                sample_seed,
                ping_samples,
            } => {
                // CRITICAL: Ping commitments are FREE (system operation)
                if self.gas_limit != gas_limits::PING {
                    return Err(format!("[REJECT][TX] ping_commitment_nonzero_gas_limit value={}", self.gas_limit));
                }
                
                // Validate window heights
                if *window_end_height <= *window_start_height {
                    return Err(format!("[REJECT][TX] invalid_window_range start={} end={}", window_start_height, window_end_height));
                }

                // Validate window size (must be 4 hours = 14400 blocks)
                let expected_window = 4 * 60 * 60; // 14400 blocks
                let actual_window = window_end_height - window_start_height;
                if actual_window != expected_window {
                    return Err(format!(
                        "[REJECT][TX] invalid_window_size expected={} actual={}",
                        expected_window, actual_window
                    ));
                }

                // Validate Merkle root (must be 64 hex characters = 32 bytes)
                if merkle_root.len() != 64 {
                    return Err(format!("[REJECT][TX] invalid_merkle_root_length len={}", merkle_root.len()));
                }

                // Validate sample seed (must be 64 hex characters = 32 bytes)
                if sample_seed.len() != 64 {
                    return Err(format!("[REJECT][TX] invalid_sample_seed_length len={}", sample_seed.len()));
                }

                // Validate counts
                if *successful_ping_count > *total_ping_count {
                    return Err(format!("[REJECT][TX] successful_exceeds_total successful={} total={}", successful_ping_count, total_ping_count));
                }

                // Validate sample size: ADAPTIVE based on network size!
                // - Small network (<10K nodes): verify ALL pings (no sampling)
                // - Large network (10K+ nodes): 1% sampling for scalability
                // Formula: max(total/100, min(10000, total))
                let min_sample_size = (*total_ping_count / 100).max(10_000_u32.min(*total_ping_count));
                if ping_samples.len() < min_sample_size as usize {
                    return Err(format!(
                        "[REJECT][TX] insufficient_ping_samples got={} min={} total={}",
                        ping_samples.len(), min_sample_size, total_ping_count
                    ));
                }

                // Validate each sample has non-empty Merkle proof
                for sample in ping_samples {
                    if sample.merkle_proof.is_empty() {
                        return Err("[REJECT][TX] ping_sample_missing_merkle_proof".to_string());
                    }
                    if sample.response_time_ms > 60000 {
                        return Err(format!("[REJECT][TX] ping_sample_response_time_exceeded value={}", sample.response_time_ms));
                    }
                }
            }
            TransactionType::Heartbeat { node_id, anchor_hash, .. } => {
                // v35: structural checks only. The Dilithium sig (in dilithium_signature, over
                // node_id:anchor_height:anchor_hash) + anchor==chain-hash + recency are enforced at
                // block validation (verify_heartbeat_tx); this gate is pure (no storage/PK access).
                if node_id.is_empty() {
                    return Err("[REJECT][TX] heartbeat_empty_node_id".to_string());
                }
                if anchor_hash.len() != 64 || !anchor_hash.chars().all(|c| c.is_ascii_hexdigit()) {
                    return Err("[REJECT][TX] heartbeat_bad_anchor_hash".to_string());
                }
                if self.dilithium_signature.as_ref().map_or(true, |s| s.is_empty()) {
                    return Err("[REJECT][TX] heartbeat_missing_signature".to_string());
                }
            }
            TransactionType::HeartbeatCommitment {
                node_id,
                window_start_height,
                window_end_height,
                merkle_root,
                heartbeat_count,
                first_heartbeat_time,
                last_heartbeat_time,
                sample_seed,
                heartbeat_samples,
            } => {
                // CRITICAL: Heartbeat commitments are FREE (system operation)
                if self.gas_limit != gas_limits::PING {
                    return Err(format!("[REJECT][TX] heartbeat_nonzero_gas_limit value={}", self.gas_limit));
                }
                
                // Validate node_id format (light_*, full_*, super_*, genesis_node_*)
                if node_id.is_empty() {
                    return Err("[REJECT][TX] empty_heartbeat_node_id".to_string());
                }
                // v3.18: Full nodes removed
                if !node_id.starts_with("light_")
                    && !node_id.starts_with("super_")
                    && !node_id.starts_with("genesis_node_") {
                    return Err(format!("[REJECT][TX] invalid_heartbeat_node_id_format node_id={}", node_id));
                }
                
                // Validate window heights
                if *window_end_height <= *window_start_height {
                    return Err(format!("[REJECT][TX] invalid_heartbeat_window_range start={} end={}", window_start_height, window_end_height));
                }

                // Validate window size (must be 4 hours = 14400 blocks)
                let expected_window = 14400u64;
                let actual_window = window_end_height - window_start_height;
                if actual_window != expected_window {
                    return Err(format!(
                        "[REJECT][TX] invalid_heartbeat_window_size expected={} actual={}",
                        expected_window, actual_window
                    ));
                }
                
                // Validate Merkle root (must be 64 hex characters = 32 bytes)
                if merkle_root.len() != 64 || !merkle_root.chars().all(|c| c.is_ascii_hexdigit()) {
                    return Err(format!("[REJECT][TX] invalid_heartbeat_merkle_root len={}", merkle_root.len()));
                }

                // Validate sample seed (must be 64 hex characters = 32 bytes)
                if sample_seed.len() != 64 {
                    return Err(format!("[REJECT][TX] invalid_heartbeat_sample_seed_length len={}", sample_seed.len()));
                }

                // Validate heartbeat_count (0-10)
                if *heartbeat_count > 10 {
                    return Err(format!("[REJECT][TX] heartbeat_count_exceeded value={}", heartbeat_count));
                }

                // Validate timestamps
                if *heartbeat_count > 0 && *last_heartbeat_time < *first_heartbeat_time {
                    return Err(format!("[REJECT][TX] heartbeat_time_order_invalid first={} last={}", first_heartbeat_time, last_heartbeat_time));
                }
                
                // Validate sample size: 20-30% of heartbeat_count (minimum 1 if count > 0)
                if *heartbeat_count > 0 {
                    let min_samples = ((*heartbeat_count as usize * 20) / 100).max(1);
                    let max_samples = ((*heartbeat_count as usize * 30) / 100).max(1);
                    if heartbeat_samples.len() < min_samples || heartbeat_samples.len() > max_samples {
                        return Err(format!(
                            "[REJECT][TX] invalid_heartbeat_sample_size got={} min={} max={} count={}",
                            heartbeat_samples.len(), min_samples, max_samples, heartbeat_count
                        ));
                    }
                }
                
                // Structural sample sanity. Crypto verification (Dilithium sig
                // + merkle replay vs merkle_root) runs at the eligibility gate
                // where the chain-state handle is available; admission must
                // not whitelist signature formats — that job belongs to the
                // verify-stage dispatcher.
                for sample in heartbeat_samples {
                    if sample.heartbeat_index >= 10 {
                        return Err(format!("[REJECT][TX] invalid_heartbeat_index value={}", sample.heartbeat_index));
                    }
                    if sample.block_height < *window_start_height || sample.block_height > *window_end_height {
                        return Err(format!("[REJECT][TX] heartbeat_sample_outside_window block_height={} start={} end={}", sample.block_height, window_start_height, window_end_height));
                    }
                    // DoS-bound only: payload envelope ~5KB; cap generous.
                    if sample.signature.len() < 64 || sample.signature.len() > 32_768 {
                        return Err(format!(
                            "[REJECT][TX] heartbeat_sample_signature_size len={}",
                            sample.signature.len()
                        ));
                    }
                    if sample.merkle_proof.is_empty() {
                        return Err("[REJECT][TX] heartbeat_sample_missing_merkle_proof".to_string());
                    }
                    // 10 leaves ⇒ tree depth ≤ 4; cap at 16 for future growth.
                    if sample.merkle_proof.len() > 16 {
                        return Err(format!(
                            "[REJECT][TX] heartbeat_sample_merkle_proof_too_deep depth={}",
                            sample.merkle_proof.len()
                        ));
                    }
                    for (node_hash, _) in &sample.merkle_proof {
                        if node_hash.len() != 64 || !node_hash.chars().all(|c| c.is_ascii_hexdigit()) {
                            return Err("[REJECT][TX] heartbeat_sample_merkle_node_invalid".to_string());
                        }
                    }
                }
            }
            TransactionType::LightNodeEligibilityBitmap {
                genesis_id,
                epoch,
                total_assigned,
                eligible_count,
                bitmap_compressed,
            } => {
                // v2.89: Validate Light Node Eligibility Bitmap TX
                // This is a system TX from Genesis nodes - FREE operation
                if self.gas_limit != gas_limits::PING {
                    return Err(format!("[REJECT][TX] bitmap_nonzero_gas_limit value={}", self.gas_limit));
                }
                
                // Validate genesis_id format
                if !genesis_id.starts_with("genesis_node_") {
                    return Err(format!("[REJECT][TX] invalid_genesis_id_format genesis_id={}", genesis_id));
                }
                
                // Validate total_assigned (max 10M Light nodes per Genesis = 2M each for 5 Genesis)
                if *total_assigned == 0 || *total_assigned > 10_000_000 {
                    return Err(format!("[REJECT][TX] invalid_total_assigned value={}", total_assigned));
                }
                
                // Validate eligible_count <= total_assigned
                if *eligible_count > *total_assigned {
                    return Err(format!(
                        "[REJECT][TX] eligible_exceeds_total eligible={} total={}",
                        eligible_count, total_assigned
                    ));
                }
                
                // Validate bitmap_compressed is not empty and not too large
                // Expected: ~50KB compressed for 2M nodes, max 500KB
                if bitmap_compressed.is_empty() {
                    return Err("[REJECT][TX] empty_bitmap_compressed".to_string());
                }
                if bitmap_compressed.len() > 500_000 {
                    return Err(format!(
                        "[REJECT][TX] bitmap_compressed_too_large size={} max=500000",
                        bitmap_compressed.len()
                    ));
                }
                
                // Note: Full validation (decompression + popcount) done at MacroBlock collection
                // Here we only do basic sanity checks for TX acceptance
            }
            TransactionType::NodeRegistration { node_id, node_type, wallet_address, api_endpoint, .. } => {
                // System transaction: validate node registration data
                if node_id.is_empty() {
                    return Err("[REJECT][NODE-ACTIVATION] empty_node_id".to_string());
                }
                if wallet_address.is_empty() {
                    return Err("[REJECT][NODE-ACTIVATION] empty_wallet_address".to_string());
                }
                // SECURITY: Light nodes MUST have empty api_endpoint (privacy protection!)
                // Light nodes = mobile apps, their IP must NEVER be exposed!
                if *node_type == NodeType::Light && !api_endpoint.is_empty() {
                    return Err("[REJECT][NODE-ACTIVATION] light_node_api_endpoint_forbidden".to_string());
                }
                // Validate api_endpoint format if present (non-empty = public)
                if !api_endpoint.is_empty() {
                    if !api_endpoint.starts_with("http://") && !api_endpoint.starts_with("https://") {
                        return Err("[REJECT][NODE-ACTIVATION] invalid_api_endpoint_scheme".to_string());
                    }
                    // Block private IPs (SSRF protection)
                    // FIX M4: Comprehensive SSRF protection — block all RFC 1918 + link-local + loopback
                    let ep_lower = api_endpoint.to_lowercase();
                    if ep_lower.contains("localhost") || ep_lower.contains("127.0.0.1") ||
                       ep_lower.contains("192.168.") || ep_lower.contains("10.") ||
                       ep_lower.contains("172.16.") || ep_lower.contains("172.17.") ||
                       ep_lower.contains("172.18.") || ep_lower.contains("172.19.") ||
                       ep_lower.contains("172.20.") || ep_lower.contains("172.21.") ||
                       ep_lower.contains("172.22.") || ep_lower.contains("172.23.") ||
                       ep_lower.contains("172.24.") || ep_lower.contains("172.25.") ||
                       ep_lower.contains("172.26.") || ep_lower.contains("172.27.") ||
                       ep_lower.contains("172.28.") || ep_lower.contains("172.29.") ||
                       ep_lower.contains("172.30.") || ep_lower.contains("172.31.") ||
                       ep_lower.contains("169.254.") || ep_lower.contains("0.0.0.0") ||
                       ep_lower.contains("[::1]") || ep_lower.contains("[fc") ||
                       ep_lower.contains("[fd") || ep_lower.contains("[fe80") {
                        return Err("[REJECT][NODE-ACTIVATION] private_api_endpoint".to_string());
                    }
                }
                // Empty api_endpoint = node chose to hide IP (valid for Super nodes)
            }
            TransactionType::NodeReactivation { node_id, current_height, last_macroblock_hash, last_macroblock_index } => {
                // v9.4: Validate reactivation TX
                if node_id.is_empty() {
                    return Err("[REJECT][NODE-ACTIVATION] reactivation_empty_node_id".to_string());
                }
                if last_macroblock_hash.is_empty() {
                    return Err("[REJECT][NODE-ACTIVATION] reactivation_empty_macroblock_hash".to_string());
                }
                if *current_height == 0 {
                    return Err("[REJECT][NODE-ACTIVATION] reactivation_zero_height".to_string());
                }
                if *last_macroblock_index == 0 && *current_height > 90 {
                    return Err(format!("[REJECT][NODE-ACTIVATION] reactivation_missing_macroblock_index height={}", current_height));
                }
                // Sanity: macroblock_index should roughly match current_height / 90
                if *last_macroblock_index > 0 {
                    let expected_max_mb = (*current_height / 90) + 1;
                    if *last_macroblock_index > expected_max_mb {
                        return Err(format!(
                            "[REJECT][NODE-ACTIVATION] reactivation_inconsistent_macroblock_index mb_index={} height={}",
                            last_macroblock_index, current_height
                        ));
                    }
                }
            }

            // FIX R23-K1: Validate key rotation TX
            TransactionType::KeyRotation { node_id, new_dilithium_pk, old_key_signature, effective_height } => {
                if node_id.is_empty() {
                    return Err("[REJECT][KEY-ROTATION] empty_node_id".to_string());
                }
                // Dilithium3 public key = 1952 bytes = 3904 hex chars
                if new_dilithium_pk.len() != 3904 {
                    return Err(format!(
                        "[REJECT][KEY-ROTATION] invalid_pk_size expected=3904_hex got={}",
                        new_dilithium_pk.len()
                    ));
                }
                if hex::decode(new_dilithium_pk).is_err() {
                    return Err("[REJECT][KEY-ROTATION] invalid_pk_hex".to_string());
                }
                if old_key_signature.is_empty() {
                    return Err("[REJECT][KEY-ROTATION] empty_old_key_signature".to_string());
                }
                let _ = effective_height; // effective_height=0 means immediate
            }
            TransactionType::EquivocationProof { offender, block_a, block_b, .. } => {
                // Structural check only — the cryptographic verification (Dilithium3 over
                // the Block_Sig_v23.1 digest against the offender's registry PK) runs at the
                // integration layer, which holds the consensus PK registry.
                if offender.is_empty() {
                    return Err("[REJECT][TX] equivocation_proof empty_offender".to_string());
                }
                if block_a == block_b {
                    return Err("[REJECT][TX] equivocation_proof identical_blocks".to_string());
                }
                if block_a.signature.is_empty() || block_b.signature.is_empty() {
                    return Err("[REJECT][TX] equivocation_proof missing_signature".to_string());
                }
            }
            TransactionType::VoteEquivocationProof { offender, checkpoint_a, signature_a, checkpoint_b, signature_b } => {
                // Structural check only — the cryptographic + same-round verification (deserialize
                // both checkpoints, index_a == index_b, hashes differ, both consensus-key sigs over
                // QNET_BFT2_VOTE:<hex(hash)> valid vs the offender's registry PK) runs at the
                // integration layer, which holds the consensus PK registry + the Checkpoint type.
                if offender.is_empty() {
                    return Err("[REJECT][TX] vote_equivocation_proof empty_offender".to_string());
                }
                if checkpoint_a == checkpoint_b {
                    return Err("[REJECT][TX] vote_equivocation_proof identical_checkpoints".to_string());
                }
                if signature_a.is_empty() || signature_b.is_empty() {
                    return Err("[REJECT][TX] vote_equivocation_proof missing_signature".to_string());
                }
            }
        }

        Ok(())
    }

    /// Apply transaction to state. Non-consensus / height-agnostic callers use this
    /// (block height 0). The WASM VM's get_block_height reads the threaded height, so
    /// the consensus block-apply path calls `apply_to_state_at` with the real height.
    pub fn apply_to_state(&self, accounts: &mut HashMap<String, Account>) -> Result<(), StateError> {
        let mut owns = Vec::new();
        self.apply_to_state_at_indexed(accounts, 0, &mut owns)
    }

    /// Apply at a known block height (threaded to the WASM host). Discards owns-index deltas; the
    /// consensus persist path calls `apply_to_state_at_indexed` to capture them for the reverse index.
    pub fn apply_to_state_at(&self, accounts: &mut HashMap<String, Account>, block_height: u64) -> Result<(), StateError> {
        let mut owns = Vec::new();
        self.apply_to_state_at_indexed(accounts, block_height, &mut owns)
    }

    /// Apply at a known height, collecting QRC-20 owns-index deltas (Set/Clear on 0↔nonzero balance
    /// transitions) so the persist layer maintains the wallet→token reverse index in the SAME batch.
    /// owns is NON-consensus (never in state_root) — a stale/wrong index self-heals via boot backfill.
    pub fn apply_to_state_at_indexed(&self, accounts: &mut HashMap<String, Account>, block_height: u64, owns: &mut Vec<OwnsDelta>) -> Result<(), StateError> {
        // SECURITY: Out-of-gas check — reject TX if compute_gas_used() > gas_limit
        // System TXs (gas_limit=0, gas_used=0) are exempt
        if self.gas_limit > 0 {
            let gas_used = self.compute_gas_used();
            if gas_used > self.gas_limit {
                return Err(StateError::InvalidTransaction(format!(
                    "[REJECT][TX] out_of_gas gas_used={} gas_limit={}", gas_used, self.gas_limit
                )));
            }
        }

        // ═══════════════════════════════════════════════════════════════════════
        // POST-QUANTUM ENFORCEMENT GATE (two-stage: presence + key binding)
        // ═══════════════════════════════════════════════════════════════════════
        // STAGE 1: Presence check — if the sender account has opted into
        //   mandatory post-quantum signing (account.require_pq_signature == true),
        //   reject any non-system TX that lacks a Dilithium3 signature.
        //
        // STAGE 2: Key binding — if the sender account has a registered
        //   Dilithium3 public key (account.dilithium_public_key.is_some()),
        //   the TX's `dilithium_public_key` MUST byte-match the registered key.
        //   This prevents the "any-Dilithium3-key" bypass: an attacker with a
        //   forged Ed25519 signature cannot satisfy the gate by attaching their
        //   own Dilithium3 keypair, because the TX would fail the registered-key
        //   binding check. The attacker would need to compromise the holder's
        //   specific Dilithium3 secret key — quantum-resistant by FIPS 204.
        //
        // System TXs (NodeRegistration, RewardDistribution, KeyRotation, etc.)
        // are exempt — they are protocol-internal and authorised by other
        // on-chain proofs (Solana burn, 2f+1 macroblock votes, ping commitment
        // chain). Only user-originated TXs go through this gate.
        //
        // SCALABILITY: O(1) bool lookup + O(1) hex-string compare per TX. No
        // marginal cost for accounts that haven't opted in. At thousands of
        // validators, the only cost is one HashMap lookup per applied TX.
        //
        // The Dilithium3 signature itself is verified at ingest time (block
        // pipeline TX-sig verification and mempool admission). This gate
        // enforces presence + key binding only; signature validity is already
        // proven before apply.
        // ═══════════════════════════════════════════════════════════════════════
        // PURE DILITHIUM (F0.1): the former opt-in PQ-LOCK apply-time gate is removed.
        // Post-quantum signing is now MANDATORY for all value TX and the address itself is
        // the from<->key binding (enforced at ingest), so a per-account opt-in flag +
        // registered-key check is redundant. No apply-time PQ gate is needed.

        match &self.tx_type {
            TransactionType::Transfer { from, to, amount } => {
                // DEFENCE-IN-DEPTH: payload `from` MUST equal TX-level `self.from`.
                // The same check fires at `validate()` so this branch is
                // unreachable on a well-formed TX, but a state-apply layer
                // that trusts `validate()` exclusively breaks defence-in-depth:
                // if a future code path enters `apply_to_state` without a
                // prior validate (block replay, snapshot recovery, internal
                // construction), the wallet-impersonation route would re-open.
                // This guard makes the invariant locally provable.
                if from != &self.from {
                    return Err(StateError::InvalidTransaction(format!(
                        "[REJECT][TX] transfer_sender_mismatch_at_apply tx_from={} payload_from={}",
                        &self.from[..self.from.len().min(20)],
                        &from[..from.len().min(20)]
                    )));
                }
                // Get sender account
                let sender = accounts.get_mut(from)
                    .ok_or_else(|| StateError::AccountNotFound(from.clone()))?;

                // ═══════════════════════════════════════════════════════════════
                // IDEMPOTENT APPLY — silent skip for already-applied transactions
                // ═══════════════════════════════════════════════════════════════
                // When a node receives the same block more than once (typical during
                // batch sync, gossip duplication, or post-restart replay), every TX
                // inside that block is presented to apply_to_state again. Without
                // idempotency the strict `nonce == sender.nonce + 1` check fails
                // for every previously-applied TX, which:
                //   * pollutes logs with [REJECT][TX] invalid_nonce noise
                //   * causes block-level apply failure if any TX inside fails
                //   * cascades to state divergence between nodes that received the
                //     block once vs nodes that re-applied it multiple times
                //
                // ROOT CAUSE OF NETWORK HALT (observed at h=350):
                //   Genesis block re-delivered during catch-up sync. Sender "genesis"
                //   had nonce=100 from initial apply. Re-apply attempted nonces 1..100
                //   sequentially, all rejected. Block partially applied → state_root
                //   diverged from peers → next block (h=351) failed hash_chain_break →
                //   pipeline jammed forever.
                //
                // SAFETY: silent skip is NOT a security relaxation:
                //   * If `tx.nonce <= sender.nonce`, the operation has already taken
                //     effect on this account. Re-applying would either no-op
                //     (idempotent) or fail (current behaviour) — both leave state
                //     identical. Silent skip preserves the same final state without
                //     polluting the failure path.
                //   * Replay-attack semantics are preserved: an attacker re-broadcasting
                //     a signed TX with old nonce cannot double-spend, because the
                //     sender's balance already reflects the original deduction. The
                //     skipped TX has no incremental effect.
                //   * Strict +1 check still applies for FUTURE nonces; only stale
                //     (≤ current) nonces are silently skipped.
                //
                // SCALABILITY: O(1) per TX — single comparison. Identical cost at
                // 5 or 5000 validators. Scales to thousands of super-nodes without
                // any cross-node coordination.
                // ═══════════════════════════════════════════════════════════════
                if self.nonce <= sender.nonce {
                    // Already applied — silent no-op. Preserves idempotency under
                    // replay/re-sync without state divergence.
                    return Ok(());
                }

                // CRITICAL SECURITY: Check nonce to prevent replay attacks and double spending
                // Transaction nonce must be exactly sender.nonce + 1
                if self.nonce != sender.nonce + 1 {
                    return Err(StateError::InvalidTransaction(format!(
                        "[REJECT][TX] invalid_nonce expected={} got={}",
                        sender.nonce + 1, self.nonce
                    )));
                }
                
                // Check balance (QUANTUM v2.25: use effective_gas_price for +50% Dilithium TX)
                let fee = self.effective_gas_price().checked_mul(self.gas_limit)
                    .ok_or_else(|| StateError::InvalidTransaction("[REJECT][TX] gas_fee_overflow".into()))?;
                let total_amount = amount.checked_add(fee)
                    .ok_or_else(|| StateError::InvalidTransaction("[REJECT][TX] total_amount_overflow".into()))?;
                if sender.balance < total_amount {
                    return Err(StateError::InsufficientBalance {
                        have: sender.balance,
                        need: total_amount,
                    });
                }
                
                // Deduct from sender
                sender.balance = sender.balance.checked_sub(total_amount)
                    .ok_or_else(|| StateError::InvalidTransaction("[REJECT][TX] sender_balance_underflow".into()))?;
                sender.nonce = sender.nonce.checked_add(1)
                    .ok_or_else(|| StateError::InvalidTransaction("[REJECT][TX] nonce_overflow".into()))?;

                // Add to receiver
                let receiver = accounts.entry(to.clone())
                    .or_insert_with(|| Account::new(to.clone()));
                receiver.balance = receiver.balance.checked_add(*amount)
                    .ok_or_else(|| StateError::InvalidTransaction("[REJECT][TRANSFER] receiver_balance_overflow".into()))?;
            }
            TransactionType::CreateAccount { address, initial_balance } => {
                // IDEMPOTENT APPLY — re-creation is a no-op, not an error.
                // When genesis-style blocks are re-delivered during sync, every
                // CreateAccount in that block is re-presented. Returning Err here
                // would fail the whole block apply and corrupt subsequent state;
                // returning Ok preserves idempotency without changing semantics
                // (the account already exists with its initial balance, mint cannot
                // be repeated because the contains_key short-circuit prevents it).
                if accounts.contains_key(address) {
                    return Ok(());
                }

                // C1 SECURITY: Only system/genesis accounts can mint initial balance
                if *initial_balance > 0 {
                    let sender = &self.from;
                    let is_system = sender == "system" || sender == "genesis" || sender == "system_rewards_pool";
                    let has_system_sig = self.signature.as_deref() == Some("system")
                        || self.signature.as_deref() == Some("genesis");
                    if !is_system && !has_system_sig {
                        return Err(StateError::InvalidTransaction(format!(
                            "[REJECT][CREATE-ACCOUNT] sender={} not authorized to mint initial_balance={}",
                            sender, initial_balance
                        )));
                    }
                }

                let mut account = Account::new(address.clone());
                account.balance = *initial_balance;
                accounts.insert(address.clone(), account);

                if is_info_log() {
                    println!("[INFO][CREATE-ACCOUNT] addr={} balance={} by={}",
                        &address[..address.len().min(16)], initial_balance, &self.from[..self.from.len().min(16)]);
                }
            }

            TransactionType::NodeActivation { node_type, amount, .. } => {
                // v14.8.4: Account may not exist yet when a freshly-activated wallet
                // submits its FIRST NodeActivation TX (no prior transfers → no state
                // row). Create an empty Account rather than rejecting — the activation
                // payment is proven by the external 1DEV Solana burn (Phase 1) or by
                // the QNC-to-Pool3 transfer recorded elsewhere in the same block
                // (Phase 2). This is the on-chain counterpart of the mempool-side
                // system-TX bypass.
                if !accounts.contains_key(&self.from) {
                    accounts.insert(
                        self.from.clone(),
                        Account::new(self.from.clone()),
                    );
                }
                let sender = accounts.get_mut(&self.from)
                    .expect("account just inserted");

                // v14.8.4: SINGLE-USE ACTIVATION GUARD (with idempotent re-apply).
                // Each wallet may hold exactly one active node at a time. An
                // already-activated wallet re-presented during batch sync (same
                // block re-delivered) must be a no-op, not an error — re-apply
                // would otherwise fail the whole block and corrupt subsequent
                // state. The mempool layer prevents fresh NodeActivation TXs
                // from already-activated wallets; this code path only fires on
                // sync replay where idempotency is the correct semantic.
                if sender.is_node {
                    return Ok(());
                }

                // CRITICAL SECURITY: Check nonce to prevent replay attacks.
                // First-time wallet has sender.nonce == 0 → valid TX nonce is 1.
                // Idempotent skip for already-applied: tx.nonce ≤ sender.nonce.
                if self.nonce <= sender.nonce {
                    return Ok(());
                }
                if self.nonce != sender.nonce + 1 {
                    return Err(StateError::InvalidTransaction(format!(
                        "[REJECT][TX] invalid_nonce expected={} got={}",
                        sender.nonce + 1, self.nonce
                    )));
                }

                // v14.8.4: For SYSTEM activation TX, the fee is ALWAYS zero
                // (payment lives outside this chain). For legacy / future non-
                // system activation paths we keep the original fee arithmetic.
                let fee = if self.is_system_tx() {
                    0u64
                } else {
                    self.effective_gas_price().checked_mul(self.gas_limit)
                        .ok_or_else(|| StateError::InvalidTransaction("[REJECT][TX] gas_fee_overflow".into()))?
                };
                let total_amount = amount.checked_add(fee)
                    .ok_or_else(|| StateError::InvalidTransaction("[REJECT][TX] total_amount_overflow".into()))?;

                if sender.balance < total_amount {
                    return Err(StateError::InsufficientBalance {
                        have: sender.balance,
                        need: total_amount,
                    });
                }

                // Burn tokens (remove from balance). For Phase 1 system TXs
                // both amount and fee are zero so this is a no-op; for Phase 2
                // it deducts the QNC amount routed to Pool3.
                sender.balance = sender.balance.checked_sub(total_amount)
                    .ok_or_else(|| StateError::InvalidTransaction("[REJECT][TX] sender_balance_underflow".into()))?;
                sender.nonce = sender.nonce.checked_add(1)
                    .ok_or_else(|| StateError::InvalidTransaction("[REJECT][TX] nonce_overflow".into()))?;

                // Activate node (sets is_node=true, node_type=…; the guard above
                // ensures this transition is one-way for any given wallet).
                sender.activate_node(format!("{:?}", node_type), self.timestamp);
            }
            TransactionType::ContractDeploy => {
                // Contract deployment -- v3.40: FULL blockchain state (QRC-20 + generic WASM)
                // ALL contract/token state is stored in Account.contract_storage
                // which is part of the Merkle tree -> replicated to ALL nodes via blocks
                let sender = accounts.get_mut(&self.from)
                    .ok_or_else(|| StateError::AccountNotFound(self.from.clone()))?;

                // IDEMPOTENT APPLY — see Transfer arm for full rationale. Re-presented
                // ContractDeploy with stale nonce is a no-op (already deployed).
                if self.nonce <= sender.nonce {
                    return Ok(());
                }
                // CRITICAL SECURITY: Check nonce to prevent replay attacks
                if self.nonce != sender.nonce + 1 {
                    return Err(StateError::InvalidTransaction(format!(
                        "[REJECT][TX] invalid_nonce expected={} got={}",
                        sender.nonce + 1, self.nonce
                    )));
                }
                
                // Check balance for deployment fee (QUANTUM v2.25: +50% for Dilithium TX)
                let fee = self.effective_gas_price().checked_mul(self.gas_limit)
                    .ok_or_else(|| StateError::InvalidTransaction("[REJECT][TX] gas_fee_overflow".into()))?;
                if sender.balance < fee {
                    return Err(StateError::InsufficientBalance {
                        have: sender.balance,
                        need: fee,
                    });
                }
                
                // Deduct deployment fee
                sender.balance = sender.balance.checked_sub(fee)
                    .ok_or_else(|| StateError::InvalidTransaction("[REJECT][TX] sender_balance_underflow".into()))?;
                sender.nonce = sender.nonce.checked_add(1)
                    .ok_or_else(|| StateError::InvalidTransaction("[REJECT][TX] nonce_overflow".into()))?;

                // Address is ALWAYS derived from authenticated sender + monotonic nonce with a
                // domain separator — never caller-supplied, so a deployer cannot squat/overwrite
                // an arbitrary address (the old self.to branch let any address be named).
                let contract_address = derive_contract_address(&self.from, self.nonce);

                // Parse tx.data to determine contract type
                let data_str = self.data.as_ref().ok_or_else(|| {
                    StateError::InvalidTransaction("[REJECT][CONTRACT] missing_data_field".to_string())
                })?;
                
                // FIX M6: Parse JSON first, then check for QRC-20 via proper field access
                let is_qrc20 = serde_json::from_str::<serde_json::Value>(data_str)
                    .ok()
                    .and_then(|v| v.get("qrc20").and_then(|q| q.as_bool()))
                    .unwrap_or(false);
                // QRC-721 (NFT) is a CONTAINED standard on the SAME tx types, flagged by "qrc721": true.
                let is_qrc721 = serde_json::from_str::<serde_json::Value>(data_str)
                    .ok()
                    .and_then(|v| v.get("qrc721").and_then(|q| q.as_bool()))
                    .unwrap_or(false);
                // Generic WASM contract, flagged by "wasm": true (P3, GATED default-OFF).
                let is_wasm = serde_json::from_str::<serde_json::Value>(data_str)
                    .ok()
                    .and_then(|v| v.get("wasm").and_then(|q| q.as_bool()))
                    .unwrap_or(false);

                // Compute code hash
                let code_hash = {
                    let mut hasher = Sha3_256::new();
                    hasher.update(data_str.as_bytes());
                    hex::encode(hasher.finalize())
                };

                // INIT-ONCE: never overwrite a live deployed contract. Unreachable on honest paths
                // (nonce-derived address is unique per (sender,nonce)) but makes overwrite of an
                // existing token structurally impossible even under a nonce/address collision.
                if let Some(existing) = accounts.get(&contract_address) {
                    if existing.is_smart_contract() {
                        return Err(StateError::InvalidTransaction(format!(
                            "[REJECT][DEPLOY] address_already_deployed addr={}", contract_address)));
                    }
                }

                // Refundable storage deposits owed by the deployer for entries THIS deploy creates,
                // charged AFTER the &mut contract borrow ends (see below). QRC-20 seeds the creator's
                // balance entry, which is refundable on drain — so it must be charged on creation like
                // every other entry (transfer/mint), or its later removal drains the shared escrow it
                // never paid into.
                let mut deployer_deposit_entries: u64 = 0;
                // Create or update the contract account in blockchain state
                let contract = accounts.entry(contract_address.clone())
                    .or_insert_with(|| Account::new(contract_address.clone()));
                contract.is_contract = true;
                contract.contract_code_hash = Some(code_hash.clone());
                
                // Base metadata (all contracts)
                contract.contract_storage.insert(
                    "deployer".to_string(), self.from.clone()
                );
                contract.contract_storage.insert(
                    "deployed_at".to_string(), self.timestamp.to_string()
                );

                // v3.40: QRC-20 token initialization — FULL state in blockchain
                // This is the SINGLE SOURCE OF TRUTH for token data.
                // contract_vm.rs reads FROM this state (via StateManager/RocksDB).
                if is_qrc20 {
                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data_str) {
                        let name = parsed.get("name").and_then(|v| v.as_str()).unwrap_or("");
                        let symbol = parsed.get("symbol").and_then(|v| v.as_str()).unwrap_or("");
                        let decimals = parsed.get("decimals").and_then(|v| v.as_u64()).unwrap_or(9);
                        // Accept number OR numeric string (a large supply as a JSON number loses precision
                        // past 2^53 on JS clients; the string form is exact). Absent/malformed ⇒ 0.
                        let initial_supply = parsed.get("initial_supply")
                            .and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse::<u64>().ok())))
                            .unwrap_or(0);
                        // Supply is IMMUTABLE by default: mint/burn stay disabled unless the deployer
                        // explicitly opts in. Absent flag ⇒ false, so an unset field can never enable them.
                        let mintable = parsed.get("mintable").and_then(|v| v.as_bool()).unwrap_or(false);
                        let burnable = parsed.get("burnable").and_then(|v| v.as_bool()).unwrap_or(false);

                        // Token metadata — stored on-chain, readable by all nodes
                        contract.contract_storage.insert("type".to_string(), "qrc20".to_string());
                        contract.contract_storage.insert("name".to_string(), name.to_string());
                        contract.contract_storage.insert("symbol".to_string(), symbol.to_string());
                        contract.contract_storage.insert("decimals".to_string(), decimals.to_string());
                        // Optional token logo — an emoji or an https URL stored in on-chain token metadata,
                        // which clients render as the token icon (generated avatar fallback when unset).
                        // Sanitized so a deploy cannot smuggle a javascript:/data:/http: scheme NOR an
                        // attribute-breakout (quotes/angle-brackets/space/backtick/control chars) into an
                        // explorer/wallet <img> render, and capped so it cannot bloat the consensus
                        // storage_root. Pure string ops ⇒ every node derives the byte-identical value.
                        let logo_raw = parsed.get("logo").and_then(|v| v.as_str()).unwrap_or("").trim();
                        let logo: String = {
                            let capped: String = logo_raw.chars().take(256).collect();
                            let lower = capped.to_ascii_lowercase();
                            // Any char that could break out of an HTML attribute / inject markup.
                            let html_unsafe = capped.chars().any(|c|
                                matches!(c, '"' | '\'' | '<' | '>' | '`' | ' ') || c.is_control());
                            if capped.is_empty() {
                                String::new()
                            } else if lower.contains("://") || lower.contains("javascript:") || lower.contains("data:") {
                                // Has a scheme ⇒ accept ONLY a clean https:// URL (reject http/data/javascript/
                                // etc., and any URL carrying HTML/attribute-breaking characters).
                                if lower.starts_with("https://") && !html_unsafe { capped } else { String::new() }
                            } else if html_unsafe {
                                // No scheme but carries markup-unsafe chars ⇒ drop (never store a render hazard).
                                String::new()
                            } else {
                                // No scheme ⇒ a short label/emoji; kept as-is and rendered as text, never as a URL.
                                capped
                            }
                        };
                        if !logo.is_empty() {
                            contract.contract_storage.insert("logo".to_string(), logo);
                        }
                        // Opt-in supply-mutation flags — canonical "true"/"false" strings; the mint/burn
                        // arms gate on an exact "true" match, so any other value keeps them disabled.
                        contract.contract_storage.insert("mintable".to_string(), mintable.to_string());
                        contract.contract_storage.insert("burnable".to_string(), burnable.to_string());
                        // INVARIANT: total_supply is written ONCE here. Only future mint/burn ops may
                        // adjust it, each 1:1 with the balance delta via checked arithmetic. Conservative
                        // ops (transfer/transferFrom/approve) must NEVER write it.
                        contract.contract_storage.insert("total_supply".to_string(), initial_supply.to_string());
                        // Lifetime emission accounting: total_minted seeds at the initial supply, total_burned
                        // at 0; mint/burn advance them 1:1 ⇒ invariant total_supply == total_minted − total_burned.
                        contract.contract_storage.insert("total_minted".to_string(), initial_supply.to_string());
                        contract.contract_storage.insert("total_burned".to_string(), "0".to_string());
                        // Creator receives initial supply — ON-CHAIN balance. Materialize (and charge
                        // the refundable deposit for) the balance entry ONLY when non-zero: a zero entry
                        // is pointless, and an unbacked entry whose later removal refunds would drain the
                        // shared escrow. A creator who starts at 0 gets a charged entry on first receipt
                        // via the transfer arm, so every live entry stays backed 1:1.
                        if initial_supply > 0 {
                            contract.contract_storage.insert(
                                format!("balance:{}", self.from), initial_supply.to_string()
                            );
                            deployer_deposit_entries = 1;
                            owns.push(OwnsDelta::Set { wallet: self.from.clone(), contract: contract_address.clone() });
                        }
                        
                        if is_info_log() {
                            println!("[INFO][TOKEN] qrc20_deployed name={} symbol={} supply={} addr={} by={}",
                                name, symbol, initial_supply,
                                &contract_address[..contract_address.len().min(20)],
                                &self.from[..self.from.len().min(16)]);
                        }
                    }
                } else if is_qrc721 {
                    // QRC-721 (NFT) init — CONTAINED standard modeled on QRC-20 but with NO total_supply
                    // (NFTs are minted individually via owner-only mint). Ownership lives in per-token
                    // "owner:{token_id}" entries created at mint; the "deployer" gates mint authority.
                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data_str) {
                        let name = parsed.get("name").and_then(|v| v.as_str()).unwrap_or("");
                        let symbol = parsed.get("symbol").and_then(|v| v.as_str()).unwrap_or("");

                        contract.contract_storage.insert("type".to_string(), "qrc721".to_string());
                        contract.contract_storage.insert("name".to_string(), name.to_string());
                        contract.contract_storage.insert("symbol".to_string(), symbol.to_string());
                        // "deployer" is written by the base-metadata block above; mint gates on it.

                        if is_info_log() {
                            println!("[INFO][NFT] qrc721_deployed name={} symbol={} addr={} by={}",
                                name, symbol,
                                &contract_address[..contract_address.len().min(20)],
                                &self.from[..self.from.len().min(16)]);
                        }
                    }
                } else if is_wasm {
                    // Generic WASM contract deploy (P3, GATED default-OFF). Disabled →
                    // reject, so no type=="wasm" contract can exist and the call-side
                    // wasm path stays unreachable (whole VM path inert). When enabled:
                    // validate the module (float-free + bounded) and store the code.
                    if !crate::wasm_exec::wasm_vm_enabled() {
                        return Err(StateError::InvalidTransaction("[REJECT][VM] wasm_disabled".to_string()));
                    }
                    let code_hex = serde_json::from_str::<serde_json::Value>(data_str).ok()
                        .and_then(|v| v.get("code").and_then(|c| c.as_str().map(String::from)))
                        .ok_or_else(|| StateError::InvalidTransaction("[REJECT][VM] missing_code".to_string()))?;
                    let code = hex::decode(&code_hex)
                        .map_err(|_| StateError::InvalidTransaction("[REJECT][VM] code_not_hex".to_string()))?;
                    qnet_vm::validate_wasm_module(&code, &qnet_vm::VmLimits::default())
                        .map_err(|e| StateError::InvalidTransaction(format!("[REJECT][VM] {}", e)))?;
                    contract.contract_storage.insert("type".to_string(), "wasm".to_string());
                    contract.contract_storage.insert("code".to_string(), code_hex);
                    if is_info_log() {
                        println!("[INFO][VM] wasm_deployed addr={} code_bytes={} by={}",
                            &contract_address[..contract_address.len().min(20)], code.len(),
                            &self.from[..self.from.len().min(16)]);
                    }
                } else {
                    // Generic contract (WASM) — just store code_hash + deployer
                    if is_info_log() {
                        println!("[INFO][CONTRACT] deployed addr={} code_hash={}..{} fee={} by={}",
                            &contract_address[..contract_address.len().min(20)],
                            &code_hash[..8], &code_hash[code_hash.len()-8..],
                            fee, &self.from[..self.from.len().min(16)]);
                    }
                }

                // The &mut contract borrow is now released — charge the deployer's refundable storage
                // deposit for the balance entry created above (QRC-20 with non-zero supply). Symmetric
                // with transfer/mint (charge on create, refund on remove). On insufficient balance this
                // Err rolls back the whole deploy (lazy-apply discards the working copy), so no entry is
                // ever left unbacked. Deterministic: bound to entries created, not to wall state.
                if deployer_deposit_entries > 0 {
                    charge_storage_deposit(accounts, &self.from, deployer_deposit_entries)?;
                }
            }
            TransactionType::ContractCall => {
                // Contract interaction -- v3.40: QRC-20 token operations execute ON-CHAIN
                // transfer, approve, transferFrom all modify contract_storage in blockchain state
                let sender = accounts.get_mut(&self.from)
                    .ok_or_else(|| StateError::AccountNotFound(self.from.clone()))?;

                // IDEMPOTENT APPLY — see Transfer arm for full rationale.
                if self.nonce <= sender.nonce {
                    return Ok(());
                }
                // CRITICAL SECURITY: Check nonce to prevent replay attacks
                if self.nonce != sender.nonce + 1 {
                    return Err(StateError::InvalidTransaction(format!(
                        "[REJECT][TX] invalid_nonce expected={} got={}",
                        sender.nonce + 1, self.nonce
                    )));
                }
                
                // Check balance for call fee + value (QUANTUM v2.25: +50% for Dilithium TX)
                let fee = self.effective_gas_price().checked_mul(self.gas_limit)
                    .ok_or_else(|| StateError::InvalidTransaction("[REJECT][TX] gas_fee_overflow".into()))?;
                let total_cost = fee.checked_add(self.amount)
                    .ok_or_else(|| StateError::InvalidTransaction("[REJECT][TX] total_amount_overflow".into()))?;
                
                if sender.balance < total_cost {
                    return Err(StateError::InsufficientBalance {
                        have: sender.balance,
                        need: total_cost,
                    });
                }
                
                // Deduct fee and value
                sender.balance = sender.balance.checked_sub(total_cost)
                    .ok_or_else(|| StateError::InvalidTransaction("[REJECT][TX] sender_balance_underflow".into()))?;
                sender.nonce = sender.nonce.checked_add(1)
                    .ok_or_else(|| StateError::InvalidTransaction("[REJECT][TX] nonce_overflow".into()))?;
                let sender_addr = self.from.clone();

                // Verify target is a contract account
                let contract_addr = self.to.as_ref().ok_or_else(|| {
                    StateError::InvalidTransaction("[REJECT][CONTRACT] missing_to_address".to_string())
                })?.clone();

                // Ensure the contract account exists, then verify + credit value in a short borrow
                // scope. We deliberately do NOT hold a &mut contract across the QRC-20 dispatch:
                // the refundable storage deposit is a native-QNC MOVE between OTHER accounts (sender
                // and escrow), so each contract_storage read/write is re-acquired in its own scope.
                {
                    let contract = accounts.entry(contract_addr.clone())
                        .or_insert_with(|| Account::new(contract_addr.clone()));
                    if !contract.is_contract {
                        return Err(StateError::InvalidTransaction(format!(
                            "[REJECT][CONTRACT] not_a_contract addr={}", contract_addr
                        )));
                    }
                    if self.amount > 0 {
                        contract.balance = contract.balance.checked_add(self.amount)
                            .ok_or_else(|| StateError::InvalidTransaction("[REJECT][CONTRACT] balance_overflow".into()))?;
                    }
                }

                // v3.40: Execute QRC-20 operations ON-CHAIN (deterministic on all nodes)
                let is_qrc20 = accounts.get(&contract_addr).map(|c| c.is_qrc20()).unwrap_or(false);
                // QRC-721 (NFT) dispatch — parallel to qrc20, keyed on the same contract_storage["type"].
                let is_qrc721 = accounts.get(&contract_addr)
                    .and_then(|c| c.contract_storage.get("type"))
                    .map(|t| t == "qrc721").unwrap_or(false);
                // Generic WASM contract dispatch (P3, GATED default-OFF).
                let is_wasm = accounts.get(&contract_addr)
                    .and_then(|c| c.contract_storage.get("type"))
                    .map(|t| t == "wasm").unwrap_or(false);

                if is_qrc20 {
                    if let Some(ref data) = self.data {
                        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
                            let method = parsed.get("method").and_then(|v| v.as_str()).unwrap_or("");
                            let args = parsed.get("args");
                            
                            match method {
                                "transfer" => 'qrc20_transfer: {
                                    // QRC-20 transfer: move tokens from sender to recipient
                                    let to = args.and_then(|a| a.get(0)).and_then(|v| v.as_str())
                                        .ok_or_else(|| StateError::InvalidTransaction(
                                            "[REJECT][QRC20] transfer_missing_to_arg".to_string()))?;
                                    // amount accepted as string OR number (string kills the >2^53 limit).
                                    let amount = parse_amount(args.and_then(|a| a.get(1)))?;

                                    if amount == 0 {
                                        return Err(StateError::InvalidTransaction("[REJECT][QRC20] zero_amount_transfer".into()));
                                    }

                                    // Transfer to the canonical burn address → REAL burn (any token, even
                                    // non-burnable): destroy supply, never credit the sink. See qrc20_burn_to_sink.
                                    if to == CANONICAL_BURN_ADDR {
                                        let drained = qrc20_burn_to_sink(accounts, &contract_addr, &sender_addr, &sender_addr, amount as u128, &self.hash)?;
                                        if drained { owns.push(OwnsDelta::Clear { wallet: sender_addr.clone(), contract: contract_addr.clone() }); }
                                        break 'qrc20_transfer;
                                    }

                                    let from_key = format!("balance:{}", sender_addr);
                                    let to_key = format!("balance:{}", to);
                                    let amount = amount as u128;

                                    // ALIASING-SAFE DEBIT-THEN-CREDIT-WITH-REREAD on the single live map.
                                    // Read from_bal; debit and WRITE it first; then RE-READ to_key from the
                                    // now-updated map and write the credit. When from_key == to_key (self-
                                    // transfer) the reread sees the debited value and the credit nets to a
                                    // no-op automatically — no special case, so the alias mint bug cannot exist.
                                    let from_bal = read_balance(
                                        &accounts.get(&contract_addr).unwrap().contract_storage, &from_key)?;
                                    if from_bal < amount {
                                        return Err(StateError::InvalidTransaction(format!(
                                            "[REJECT][QRC20] insufficient_balance have={} need={}", from_bal, amount)));
                                    }
                                    let new_from_bal = from_bal.checked_sub(amount)
                                        .ok_or_else(|| StateError::InvalidTransaction("[REJECT][QRC20] balance_overflow".into()))?;

                                    // NEW-entry deposit accounting bound to `store.contains_key` BEFORE writes
                                    // (NOT value==0), so all nodes agree. Backstop cap only as anti-OOM.
                                    let to_is_new = {
                                        let store = &accounts.get(&contract_addr).unwrap().contract_storage;
                                        if store.len() >= MAX_CONTRACT_STORAGE_ENTRIES && !store.contains_key(&to_key) {
                                            return Err(StateError::InvalidTransaction(format!(
                                                "[REJECT][QRC20] storage_limit_reached entries={} max={}",
                                                store.len(), MAX_CONTRACT_STORAGE_ENTRIES)));
                                        }
                                        !store.contains_key(&to_key)
                                    };
                                    // New recipient entry ⇒ charge refundable deposit before writing it.
                                    if to_is_new {
                                        charge_storage_deposit(accounts, &sender_addr, 1)?;
                                        owns.push(OwnsDelta::Set { wallet: to.to_string(), contract: contract_addr.clone() });
                                    }

                                    // Debit from_key first.
                                    accounts.get_mut(&contract_addr).unwrap()
                                        .contract_storage.insert(from_key.clone(), new_from_bal.to_string());
                                    // Re-read to_key from the updated map, credit (always > 0 since amount > 0), write.
                                    let to_bal = read_balance(
                                        &accounts.get(&contract_addr).unwrap().contract_storage, &to_key)?;
                                    let new_to_bal = to_bal.checked_add(amount)
                                        .ok_or_else(|| StateError::InvalidTransaction("[REJECT][QRC20] balance_overflow".into()))?;
                                    accounts.get_mut(&contract_addr).unwrap()
                                        .contract_storage.insert(to_key.clone(), new_to_bal.to_string());
                                    // Sender entry drained to zero (only when NOT aliased to to_key, i.e. not a
                                    // self-transfer): remove the key (no "0" residue) and refund its deposit.
                                    if from_key != to_key && new_from_bal == 0 {
                                        accounts.get_mut(&contract_addr).unwrap().contract_storage.remove(&from_key);
                                        refund_storage_deposit(accounts, &sender_addr, 1)?;
                                        owns.push(OwnsDelta::Clear { wallet: sender_addr.clone(), contract: contract_addr.clone() });
                                    }

                                    if is_info_log() {
                                        println!("[INFO][QRC20] transfer {} -> {} amount={} contract={}",
                                            &sender_addr[..sender_addr.len().min(16)],
                                            &to[..to.len().min(16)], amount,
                                            &contract_addr[..contract_addr.len().min(16)]);
                                    }
                                    // Success-gated transfer event (effect, not calldata intent) → getLogs +
                                    // logs_root + the token-transfer index. Only reached on the Ok path.
                                    crate::wasm_exec::push_wasm_log(&self.hash, &contract_addr,
                                        crate::wasm_exec::encode_transfer_log("qrc20", "transfer", &sender_addr, to, amount, ""));
                                }
                                "approve" => {
                                    // QRC-20 approve: set allowance for spender
                                    let spender = args.and_then(|a| a.get(0)).and_then(|v| v.as_str())
                                        .ok_or_else(|| StateError::InvalidTransaction(
                                            "[REJECT][QRC20] approve_missing_spender_arg".to_string()))?;
                                    let amount = parse_amount(args.and_then(|a| a.get(1)))?;

                                    let allowance_key = format!("allowance:{}:{}", sender_addr, spender);

                                    // NEW allowance entry ⇒ charge refundable deposit (bound to contains_key).
                                    let is_new_entry = {
                                        let store = &accounts.get(&contract_addr).unwrap().contract_storage;
                                        if store.len() >= MAX_CONTRACT_STORAGE_ENTRIES && !store.contains_key(&allowance_key) {
                                            return Err(StateError::InvalidTransaction(format!(
                                                "[REJECT][QRC20] approve_storage_limit_reached entries={} max={}",
                                                store.len(), MAX_CONTRACT_STORAGE_ENTRIES)));
                                        }
                                        !store.contains_key(&allowance_key)
                                    };
                                    if is_new_entry {
                                        charge_storage_deposit(accounts, &sender_addr, 1)?;
                                    }

                                    accounts.get_mut(&contract_addr).unwrap()
                                        .contract_storage.insert(allowance_key, amount.to_string());

                                    if is_info_log() {
                                        println!("[INFO][QRC20] approve owner={} spender={} amount={}",
                                            &sender_addr[..sender_addr.len().min(16)],
                                            &spender[..spender.len().min(16)], amount);
                                    }
                                }
                                "transferFrom" | "transfer_from" => 'qrc20_transfer_from: {
                                    // QRC-20 transferFrom: spend from approved allowance
                                    let from = args.and_then(|a| a.get(0)).and_then(|v| v.as_str())
                                        .ok_or_else(|| StateError::InvalidTransaction(
                                            "[REJECT][QRC20] transfer_from_missing_from_arg".to_string()))?;
                                    let to = args.and_then(|a| a.get(1)).and_then(|v| v.as_str())
                                        .ok_or_else(|| StateError::InvalidTransaction(
                                            "[REJECT][QRC20] transfer_from_missing_to_arg".to_string()))?;
                                    let amount = parse_amount(args.and_then(|a| a.get(2)))?;

                                    if amount == 0 {
                                        return Err(StateError::InvalidTransaction("[REJECT][QRC20] zero_amount_transfer".into()));
                                    }

                                    let amount = amount as u128;

                                    // Transfer-from to the burn address → REAL burn: consume allowance exactly
                                    // like a normal transferFrom, then destroy `from`'s tokens (no sink credit).
                                    if to == CANONICAL_BURN_ADDR {
                                        let allowance_key = format!("allowance:{}:{}", from, sender_addr);
                                        let allowance = read_balance(&accounts.get(&contract_addr).unwrap().contract_storage, &allowance_key)?;
                                        if allowance < amount {
                                            return Err(StateError::InvalidTransaction(format!(
                                                "[REJECT][QRC20] insufficient_allowance have={} need={}", allowance, amount)));
                                        }
                                        let new_allowance = allowance.checked_sub(amount)
                                            .ok_or_else(|| StateError::InvalidTransaction("[REJECT][QRC20] balance_overflow".into()))?;
                                        accounts.get_mut(&contract_addr).unwrap()
                                            .contract_storage.insert(allowance_key, new_allowance.to_string());
                                        let drained = qrc20_burn_to_sink(accounts, &contract_addr, from, &sender_addr, amount, &self.hash)?;
                                        if drained { owns.push(OwnsDelta::Clear { wallet: from.to_string(), contract: contract_addr.clone() }); }
                                        break 'qrc20_transfer_from;
                                    }

                                    let allowance_key = format!("allowance:{}:{}", from, sender_addr);
                                    let from_key = format!("balance:{}", from);
                                    let to_key = format!("balance:{}", to);

                                    // TVC-4: ALL allowance + balance reads go through the fail-loud helper
                                    // (absent=0, corrupt=reject, NEVER coerce-to-0 which masked corruption).
                                    let allowance = read_balance(
                                        &accounts.get(&contract_addr).unwrap().contract_storage, &allowance_key)?;
                                    if allowance < amount {
                                        return Err(StateError::InvalidTransaction(format!(
                                            "[REJECT][QRC20] insufficient_allowance have={} need={}", allowance, amount)));
                                    }
                                    let from_bal = read_balance(
                                        &accounts.get(&contract_addr).unwrap().contract_storage, &from_key)?;
                                    if from_bal < amount {
                                        return Err(StateError::InvalidTransaction(format!(
                                            "[REJECT][QRC20] transfer_from_insufficient_balance have={} need={}", from_bal, amount)));
                                    }
                                    let new_from_bal = from_bal.checked_sub(amount)
                                        .ok_or_else(|| StateError::InvalidTransaction("[REJECT][QRC20] balance_overflow".into()))?;
                                    let new_allowance = allowance.checked_sub(amount)
                                        .ok_or_else(|| StateError::InvalidTransaction("[REJECT][QRC20] balance_overflow".into()))?;

                                    // NEW recipient entry ⇒ charge refundable deposit (bound to contains_key).
                                    // Deposit payer is the tx sender (the spender), consistent with the fee payer.
                                    let to_is_new = {
                                        let store = &accounts.get(&contract_addr).unwrap().contract_storage;
                                        if store.len() >= MAX_CONTRACT_STORAGE_ENTRIES && !store.contains_key(&to_key) {
                                            return Err(StateError::InvalidTransaction(format!(
                                                "[REJECT][QRC20] transfer_from_storage_limit_reached entries={} max={}",
                                                store.len(), MAX_CONTRACT_STORAGE_ENTRIES)));
                                        }
                                        !store.contains_key(&to_key)
                                    };
                                    if to_is_new {
                                        charge_storage_deposit(accounts, &sender_addr, 1)?;
                                        owns.push(OwnsDelta::Set { wallet: to.to_string(), contract: contract_addr.clone() });
                                    }

                                    // ALIASING-SAFE DEBIT-THEN-CREDIT-WITH-REREAD: debit from_key, then re-read
                                    // to_key from the updated map. from==to nets to a no-op with no special case.
                                    accounts.get_mut(&contract_addr).unwrap()
                                        .contract_storage.insert(from_key.clone(), new_from_bal.to_string());
                                    let to_bal = read_balance(
                                        &accounts.get(&contract_addr).unwrap().contract_storage, &to_key)?;
                                    let new_to_bal = to_bal.checked_add(amount)
                                        .ok_or_else(|| StateError::InvalidTransaction("[REJECT][QRC20] balance_overflow".into()))?;
                                    accounts.get_mut(&contract_addr).unwrap()
                                        .contract_storage.insert(to_key.clone(), new_to_bal.to_string());
                                    // Drained sender entry (not a self-transfer): remove + refund deposit.
                                    if from_key != to_key && new_from_bal == 0 {
                                        accounts.get_mut(&contract_addr).unwrap().contract_storage.remove(&from_key);
                                        refund_storage_deposit(accounts, &sender_addr, 1)?;
                                        owns.push(OwnsDelta::Clear { wallet: from.to_string(), contract: contract_addr.clone() });
                                    }
                                    // Allowance decrement (checked); allowance keys are never deposit-refunded
                                    // here — only balance entries participate in the zero→remove refund path.
                                    accounts.get_mut(&contract_addr).unwrap()
                                        .contract_storage.insert(allowance_key, new_allowance.to_string());

                                    if is_info_log() {
                                        println!("[INFO][QRC20] transferFrom {} -> {} amount={} spender={}",
                                            &from[..from.len().min(16)],
                                            &to[..to.len().min(16)], amount,
                                            &sender_addr[..sender_addr.len().min(16)]);
                                    }
                                    // Transfer effect keyed on the token holder (from), not the spender.
                                    crate::wasm_exec::push_wasm_log(&self.hash, &contract_addr,
                                        crate::wasm_exec::encode_transfer_log("qrc20", "transfer", from, to, amount, ""));
                                }
                                "mint" => {
                                    // QRC-20 mint: owner-only supply increase, ONLY on an opt-in mintable token.
                                    // Gate on exact "true"; absent/any-other value ⇒ disabled (immutable supply).
                                    let mintable = accounts.get(&contract_addr).unwrap()
                                        .contract_storage.get("mintable").map(|v| v == "true").unwrap_or(false);
                                    if !mintable {
                                        return Err(StateError::InvalidTransaction(format!(
                                            "[REJECT][QRC20] mint_disabled contract={}", contract_addr)));
                                    }
                                    // Only the recorded deployer may mint; absent deployer ⇒ reject (never mint).
                                    let deployer = accounts.get(&contract_addr).unwrap()
                                        .contract_storage.get("deployer").cloned()
                                        .ok_or_else(|| StateError::InvalidTransaction(
                                            "[REJECT][QRC20] mint_not_owner".to_string()))?;
                                    if sender_addr != deployer {
                                        return Err(StateError::InvalidTransaction(
                                            "[REJECT][QRC20] mint_not_owner".to_string()));
                                    }

                                    let to = args.and_then(|a| a.get(0)).and_then(|v| v.as_str())
                                        .ok_or_else(|| StateError::InvalidTransaction(
                                            "[REJECT][QRC20] mint_missing_to_arg".to_string()))?;
                                    // Mint-to-burn is nonsensical: it would strand credit at the sink without
                                    // counting as burned. Reject (only transfer paths burn).
                                    if to == CANONICAL_BURN_ADDR {
                                        return Err(StateError::InvalidTransaction("[REJECT][QRC20] mint_to_burn_address".into()));
                                    }
                                    let amount = parse_amount(args.and_then(|a| a.get(1)))?;
                                    if amount == 0 {
                                        return Err(StateError::InvalidTransaction("[REJECT][QRC20] zero_amount_mint".into()));
                                    }

                                    let to_key = format!("balance:{}", to);
                                    let amount = amount as u128;

                                    // NEW-entry deposit accounting bound to contains_key BEFORE the write
                                    // (same MAX guard as transfer), so all nodes agree deterministically.
                                    let to_is_new = {
                                        let store = &accounts.get(&contract_addr).unwrap().contract_storage;
                                        if store.len() >= MAX_CONTRACT_STORAGE_ENTRIES && !store.contains_key(&to_key) {
                                            return Err(StateError::InvalidTransaction(format!(
                                                "[REJECT][QRC20] mint_storage_limit_reached entries={} max={}",
                                                store.len(), MAX_CONTRACT_STORAGE_ENTRIES)));
                                        }
                                        !store.contains_key(&to_key)
                                    };
                                    if to_is_new {
                                        charge_storage_deposit(accounts, &sender_addr, 1)?;
                                        owns.push(OwnsDelta::Set { wallet: to.to_string(), contract: contract_addr.clone() });
                                    }

                                    // Aliasing-safe: re-read to_key from the live map, credit (checked), write.
                                    let to_bal = read_balance(
                                        &accounts.get(&contract_addr).unwrap().contract_storage, &to_key)?;
                                    let new_to_bal = to_bal.checked_add(amount)
                                        .ok_or_else(|| StateError::InvalidTransaction("[REJECT][QRC20] balance_overflow".into()))?;
                                    accounts.get_mut(&contract_addr).unwrap()
                                        .contract_storage.insert(to_key.clone(), new_to_bal.to_string());

                                    // total_supply 1:1 with the balance delta (checked). Mint is the only op
                                    // besides burn allowed to touch it — see the deploy-time INVARIANT.
                                    let supply = read_balance(
                                        &accounts.get(&contract_addr).unwrap().contract_storage, "total_supply")?;
                                    let new_supply = supply.checked_add(amount)
                                        .ok_or_else(|| StateError::InvalidTransaction("[REJECT][QRC20] supply_overflow".into()))?;
                                    accounts.get_mut(&contract_addr).unwrap()
                                        .contract_storage.insert("total_supply".to_string(), new_supply.to_string());
                                    // Lifetime minted counter, 1:1 with the supply delta (checked).
                                    let minted = read_balance(
                                        &accounts.get(&contract_addr).unwrap().contract_storage, "total_minted")?;
                                    let new_minted = minted.checked_add(amount)
                                        .ok_or_else(|| StateError::InvalidTransaction("[REJECT][QRC20] minted_overflow".into()))?;
                                    accounts.get_mut(&contract_addr).unwrap()
                                        .contract_storage.insert("total_minted".to_string(), new_minted.to_string());

                                    if is_info_log() {
                                        println!("[INFO][QRC20] mint to={} amount={} supply={} contract={}",
                                            &to[..to.len().min(16)], amount, new_supply,
                                            &contract_addr[..contract_addr.len().min(16)]);
                                    }
                                    // Mint = Transfer(∅ → to): empty `from` marks a supply increase.
                                    crate::wasm_exec::push_wasm_log(&self.hash, &contract_addr,
                                        crate::wasm_exec::encode_transfer_log("qrc20", "mint", "", to, amount, ""));
                                }
                                "burn" => {
                                    // QRC-20 burn: holder destroys their OWN tokens (no owner check), ONLY on
                                    // an opt-in burnable token. Gate on exact "true"; else disabled.
                                    let burnable = accounts.get(&contract_addr).unwrap()
                                        .contract_storage.get("burnable").map(|v| v == "true").unwrap_or(false);
                                    if !burnable {
                                        return Err(StateError::InvalidTransaction(format!(
                                            "[REJECT][QRC20] burn_disabled contract={}", contract_addr)));
                                    }

                                    let amount = parse_amount(args.and_then(|a| a.get(0)))?;
                                    if amount == 0 {
                                        return Err(StateError::InvalidTransaction("[REJECT][QRC20] zero_amount_burn".into()));
                                    }
                                    // Same real-burn as transfer-to-CANONICAL_BURN_ADDR — one shared helper, so
                                    // the supply invariant lives in exactly one place. The `burnable` gate above
                                    // is the only difference between the two entry points.
                                    let drained = qrc20_burn_to_sink(accounts, &contract_addr, &sender_addr, &sender_addr, amount as u128, &self.hash)?;
                                    if drained { owns.push(OwnsDelta::Clear { wallet: sender_addr.clone(), contract: contract_addr.clone() }); }
                                }
                                _ => {
                                    // Unknown method: fail-loud so a typo/unsupported call cannot silently
                                    // succeed after the fee was already charged.
                                    return Err(StateError::InvalidTransaction(format!(
                                        "[REJECT][QRC20] unknown_method method={} contract={}", method, contract_addr)));
                                }
                            }
                        }
                    }
                } else if is_qrc721 {
                    // QRC-721 (NFT) ON-CHAIN dispatch. Ownership integrity is the #1 property:
                    // no path lets a non-owner/non-approved move a token, and mint cannot overwrite
                    // an existing owner. token_id is a STRING (no numeric-precision limit); addresses
                    // are strings. Per-token ownership lives in "owner:{token_id}"; per-owner holdings
                    // count in "bal:{addr}" (via read_balance, checked); approvals in "approved:{token_id}".
                    if let Some(ref data) = self.data {
                        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
                            let method = parsed.get("method").and_then(|v| v.as_str()).unwrap_or("");
                            let args = parsed.get("args");

                            // token_id is ALWAYS a string arg — reject non-string fail-loud so a numeric
                            // (float-lossy) id can never alias a different token's key.
                            let token_id_at = |i: usize| -> Result<String, StateError> {
                                args.and_then(|a| a.get(i)).and_then(|v| v.as_str())
                                    .map(|s| s.to_string())
                                    .ok_or_else(|| StateError::InvalidTransaction(
                                        "[REJECT][NFT] bad_token_id_arg".to_string()))
                            };
                            let addr_at = |i: usize| -> Result<String, StateError> {
                                args.and_then(|a| a.get(i)).and_then(|v| v.as_str())
                                    .map(|s| s.to_string())
                                    .ok_or_else(|| StateError::InvalidTransaction(
                                        "[REJECT][NFT] bad_address_arg".to_string()))
                            };

                            match method {
                                "mint" => {
                                    // OWNER-ONLY: only the recorded deployer may mint. Absent deployer ⇒
                                    // reject (never mint), mirroring qrc20 mint's fail-loud owner gate.
                                    let deployer = accounts.get(&contract_addr).unwrap()
                                        .contract_storage.get("deployer").cloned()
                                        .ok_or_else(|| StateError::InvalidTransaction(
                                            "[REJECT][NFT] mint_not_owner".to_string()))?;
                                    if sender_addr != deployer {
                                        return Err(StateError::InvalidTransaction(
                                            "[REJECT][NFT] mint_not_owner".to_string()));
                                    }

                                    let to = addr_at(0)?;
                                    // Mint-to-burn would strand an NFT at the sink un-burned. Reject.
                                    if to == CANONICAL_BURN_ADDR {
                                        return Err(StateError::InvalidTransaction("[REJECT][NFT] mint_to_burn_address".into()));
                                    }
                                    let token_id = token_id_at(1)?;
                                    let owner_key = format!("owner:{}", token_id);
                                    let bal_key = format!("bal:{}", to);

                                    // A token may be minted ONCE: existing owner ⇒ reject (no overwrite).
                                    if accounts.get(&contract_addr).unwrap()
                                        .contract_storage.contains_key(&owner_key) {
                                        return Err(StateError::InvalidTransaction(format!(
                                            "[REJECT][NFT] already_minted token_id={}", token_id)));
                                    }

                                    // Deposit accounting bound to contains_key BEFORE writes (all nodes
                                    // agree). owner_key is ALWAYS new here; bal_key new only for a first-
                                    // time holder. MAX guard gates each new key as anti-OOM backstop.
                                    let bal_is_new = {
                                        let store = &accounts.get(&contract_addr).unwrap().contract_storage;
                                        // owner_key always new (checked above) + bal_key if absent.
                                        let new_entries = 1 + if store.contains_key(&bal_key) { 0 } else { 1 };
                                        if store.len().saturating_add(new_entries) > MAX_CONTRACT_STORAGE_ENTRIES {
                                            return Err(StateError::InvalidTransaction(format!(
                                                "[REJECT][NFT] mint_storage_limit_reached entries={} max={}",
                                                store.len(), MAX_CONTRACT_STORAGE_ENTRIES)));
                                        }
                                        !store.contains_key(&bal_key)
                                    };
                                    // Charge one deposit for owner_key (always) + one for bal_key if new.
                                    charge_storage_deposit(accounts, &sender_addr, 1)?;
                                    if bal_is_new {
                                        charge_storage_deposit(accounts, &sender_addr, 1)?;
                                    }

                                    // Owner count for `to`: read (checked_add 1), write.
                                    let bal = read_balance(
                                        &accounts.get(&contract_addr).unwrap().contract_storage, &bal_key)?;
                                    let new_bal = bal.checked_add(1)
                                        .ok_or_else(|| StateError::InvalidTransaction("[REJECT][NFT] balance_overflow".into()))?;
                                    {
                                        let store = &mut accounts.get_mut(&contract_addr).unwrap().contract_storage;
                                        store.insert(owner_key, to.clone());
                                        store.insert(bal_key, new_bal.to_string());
                                    }

                                    if is_info_log() {
                                        println!("[INFO][NFT] mint to={} token_id={} contract={}",
                                            &to[..to.len().min(16)], token_id,
                                            &contract_addr[..contract_addr.len().min(16)]);
                                    }
                                    crate::wasm_exec::push_wasm_log(&self.hash, &contract_addr,
                                        crate::wasm_exec::encode_transfer_log("qrc721", "mint", "", &to, 1, &token_id));
                                }
                                "transfer" => {
                                    // Caller must own the token. Absent owner ⇒ not_owner (fail-loud).
                                    let to = addr_at(0)?;
                                    let token_id = token_id_at(1)?;
                                    let owner_key = format!("owner:{}", token_id);
                                    let approved_key = format!("approved:{}", token_id);

                                    let cur_owner = accounts.get(&contract_addr).unwrap()
                                        .contract_storage.get(&owner_key).cloned();
                                    if cur_owner.as_deref() != Some(sender_addr.as_str()) {
                                        return Err(StateError::InvalidTransaction(format!(
                                            "[REJECT][NFT] not_owner token_id={}", token_id)));
                                    }

                                    // Transfer to the burn address → REAL burn (token destroyed); else a move.
                                    if to == CANONICAL_BURN_ADDR {
                                        nft_burn_token(accounts, &contract_addr, &sender_addr, &sender_addr, &owner_key, &approved_key)?;
                                    } else {
                                        nft_move_token(
                                            accounts, &contract_addr, &sender_addr, &sender_addr, &to,
                                            &owner_key, &approved_key)?;
                                    }

                                    if is_info_log() {
                                        println!("[INFO][NFT] transfer {} -> {} token_id={} contract={}",
                                            &sender_addr[..sender_addr.len().min(16)],
                                            &to[..to.len().min(16)], token_id,
                                            &contract_addr[..contract_addr.len().min(16)]);
                                    }
                                    crate::wasm_exec::push_wasm_log(&self.hash, &contract_addr,
                                        if to == CANONICAL_BURN_ADDR {
                                            crate::wasm_exec::encode_transfer_log("qrc721", "burn", &sender_addr, "", 1, &token_id)
                                        } else {
                                            crate::wasm_exec::encode_transfer_log("qrc721", "transfer", &sender_addr, &to, 1, &token_id)
                                        });
                                }
                                "approve" => {
                                    // Caller must own the token to approve a spender for it.
                                    let spender = addr_at(0)?;
                                    let token_id = token_id_at(1)?;
                                    let owner_key = format!("owner:{}", token_id);
                                    let approved_key = format!("approved:{}", token_id);

                                    let cur_owner = accounts.get(&contract_addr).unwrap()
                                        .contract_storage.get(&owner_key).cloned();
                                    if cur_owner.as_deref() != Some(sender_addr.as_str()) {
                                        return Err(StateError::InvalidTransaction(format!(
                                            "[REJECT][NFT] approve_not_owner token_id={}", token_id)));
                                    }

                                    // New approval entry ⇒ charge refundable deposit (bound to contains_key).
                                    let is_new_entry = {
                                        let store = &accounts.get(&contract_addr).unwrap().contract_storage;
                                        if store.len() >= MAX_CONTRACT_STORAGE_ENTRIES && !store.contains_key(&approved_key) {
                                            return Err(StateError::InvalidTransaction(format!(
                                                "[REJECT][NFT] approve_storage_limit_reached entries={} max={}",
                                                store.len(), MAX_CONTRACT_STORAGE_ENTRIES)));
                                        }
                                        !store.contains_key(&approved_key)
                                    };
                                    if is_new_entry {
                                        charge_storage_deposit(accounts, &sender_addr, 1)?;
                                    }
                                    accounts.get_mut(&contract_addr).unwrap()
                                        .contract_storage.insert(approved_key, spender.clone());

                                    if is_info_log() {
                                        println!("[INFO][NFT] approve owner={} spender={} token_id={}",
                                            &sender_addr[..sender_addr.len().min(16)],
                                            &spender[..spender.len().min(16)], token_id);
                                    }
                                }
                                "transferFrom" | "transfer_from" => {
                                    let from = addr_at(0)?;
                                    let to = addr_at(1)?;
                                    let token_id = token_id_at(2)?;
                                    let owner_key = format!("owner:{}", token_id);
                                    let approved_key = format!("approved:{}", token_id);

                                    // Token must currently be owned by `from`.
                                    let cur_owner = accounts.get(&contract_addr).unwrap()
                                        .contract_storage.get(&owner_key).cloned();
                                    if cur_owner.as_deref() != Some(from.as_str()) {
                                        return Err(StateError::InvalidTransaction(format!(
                                            "[REJECT][NFT] transfer_from_wrong_owner token_id={}", token_id)));
                                    }
                                    // Sender must be authorized: the approved spender OR the owner itself.
                                    let approved = accounts.get(&contract_addr).unwrap()
                                        .contract_storage.get(&approved_key).cloned();
                                    let authorized = approved.as_deref() == Some(sender_addr.as_str())
                                        || sender_addr == from;
                                    if !authorized {
                                        return Err(StateError::InvalidTransaction(format!(
                                            "[REJECT][NFT] transfer_from_not_approved token_id={}", token_id)));
                                    }

                                    // Transfer-from to the burn address → REAL burn (token destroyed); else a move.
                                    if to == CANONICAL_BURN_ADDR {
                                        nft_burn_token(accounts, &contract_addr, &sender_addr, &from, &owner_key, &approved_key)?;
                                    } else {
                                        nft_move_token(
                                            accounts, &contract_addr, &sender_addr, &from, &to,
                                            &owner_key, &approved_key)?;
                                    }

                                    if is_info_log() {
                                        println!("[INFO][NFT] transferFrom {} -> {} token_id={} spender={}",
                                            &from[..from.len().min(16)],
                                            &to[..to.len().min(16)], token_id,
                                            &sender_addr[..sender_addr.len().min(16)]);
                                    }
                                    crate::wasm_exec::push_wasm_log(&self.hash, &contract_addr,
                                        if to == CANONICAL_BURN_ADDR {
                                            crate::wasm_exec::encode_transfer_log("qrc721", "burn", &from, "", 1, &token_id)
                                        } else {
                                            crate::wasm_exec::encode_transfer_log("qrc721", "transfer", &from, &to, 1, &token_id)
                                        });
                                }
                                _ => {
                                    // Unknown method: fail-loud, mirroring qrc20.
                                    return Err(StateError::InvalidTransaction(format!(
                                        "[REJECT][NFT] unknown_method method={} contract={}", method, contract_addr)));
                                }
                            }
                        }
                    }
                } else if is_wasm {
                    // Generic WASM contract call (P3, GATED default-OFF). When enabled:
                    // run the (possibly cross-contract) call tree over the access-list
                    // working set, commit EACH contract's delta ONLY on a non-trap tree;
                    // a trap consumes the fee (charged above) and commits nothing
                    // (call-level atomicity; reentrancy + depth bounded inside qnet_vm).
                    //
                    // The gate Err below is defense-in-depth and unreachable on a from-genesis
                    // network while gated: reaching this branch needs a type=="wasm" contract,
                    // which the deploy path (same compile-time flag) cannot create when OFF. And
                    // even if hit, the fee charged above does NOT persist — the lazy-apply caller
                    // mutates a throwaway working copy and discards it on any Err (no leak).
                    if !crate::wasm_exec::wasm_vm_enabled() {
                        return Err(StateError::InvalidTransaction("[REJECT][VM] wasm_disabled".to_string()));
                    }
                    // Entry (method), args, and the declared access list come from the SIGNED tx
                    // data (identical on every node → deterministic resolution). Every reachable
                    // contract is already pre-loaded (get_all_affected_addresses added the list).
                    let mut entry = "run".to_string();
                    let mut args: Vec<u8> = Vec::new();
                    let mut call_set: Vec<String> = Vec::new();
                    if let Some(ref data) = self.data {
                        if let Ok(p) = serde_json::from_str::<serde_json::Value>(data) {
                            if let Some(m) = p.get("method").and_then(|v| v.as_str()) { entry = m.to_string(); }
                            if let Some(a) = p.get("args").and_then(|v| v.as_str()) {
                                if let Ok(b) = hex::decode(a) { args = b; }
                            }
                            if let Some(list) = p.get("accessList").and_then(|v| v.as_array()) {
                                for it in list.iter().take(crate::wasm_exec::MAX_WASM_ACCESS_LIST) {
                                    if let Some(s) = it.as_str() { call_set.push(s.to_string()); }
                                }
                            }
                        }
                    }
                    if !call_set.contains(&contract_addr) { call_set.push(contract_addr.clone()); }
                    // Fuel budget = gas remaining after the intrinsic. GAS MODEL: a wasm call is
                    // METERED — the sender pays the flat intrinsic PLUS fuel_consumed * price. The
                    // fuel fee is published here (set_last_tx_wasm_fuel below) and settled at apply as
                    // a SYMMETRIC account move: apply_gas_refund subtracts it from the sender's gas
                    // refund and the producer credit adds it back (both apply paths recompute the
                    // identical total), so QNC conservation holds byte-for-byte. Separately, the
                    // block's summed RESERVED fuel is bounded by BLOCK_FUEL_LIMIT (anti-DoS).
                    let exec_fuel = self.gas_limit.saturating_sub(self.compute_gas_used());
                    let result = crate::wasm_exec::execute_wasm_calltree(
                        accounts, &contract_addr, &call_set, &entry,
                        &sender_addr, self.amount, block_height, args, exec_fuel,
                    );
                    // Bill the compute: publish the fuel this call burned (trap or not — consumed work
                    // is paid) so the apply caller prices it into the metered fee (moves fuel*price from
                    // the sender's gas refund to the producer's fee credit; net supply unchanged).
                    crate::wasm_exec::set_last_tx_wasm_fuel(result.fuel_consumed);
                    // Per-contract storage-entry ceiling (anti-bloat, parity with QRC-20).
                    // If ANY touched contract would exceed it, commit NOTHING — the fee is
                    // already consumed (like a trap), and the check is deterministic on all
                    // nodes (projected size = current entries + new keys in the delta).
                    let over_cap = result.writes.iter().any(|(addr, delta)| {
                        accounts.get(addr).map(|acc| {
                            let new_keys = delta.iter()
                                .filter(|(k, _)| !acc.contract_storage.contains_key(&hex::encode(k)))
                                .count();
                            acc.contract_storage.len().saturating_add(new_keys) > MAX_CONTRACT_STORAGE_ENTRIES
                        }).unwrap_or(false)
                    });
                    if !result.trapped && !over_cap {
                        for (addr, delta) in &result.writes {
                            if let Some(acc) = accounts.get_mut(addr) {
                                for (k, v) in delta {
                                    acc.contract_storage.insert(hex::encode(k), hex::encode(v));
                                }
                            }
                        }
                        // OFF-CONSENSUS receipt capture (RPC getLogs): emit-ordered logs from the
                        // committed call tree, tagged with this tx's hash. NEVER hashed / never
                        // affects state_root — a pure side-index, only on a non-trapped committed tree.
                        for (contract, data) in &result.logs {
                            crate::wasm_exec::push_wasm_log(&self.hash, contract, data.clone());
                        }
                    } else {
                        // TRAP or storage-cap: commit NOTHING (call-level atomicity — result.writes is
                        // already empty/discarded). REVERT SEMANTICS: the msg.value credited to the
                        // target before execution must be RETURNED to the caller — value sent to a
                        // reverting call is not consumed; only the gas/fee is (pay for the work done).
                        // The VM never touches native balances (WasmTreeResult carries only storage
                        // writes), so reversing the single pre-execution credit fully restores value.
                        // Deterministic: trap/over_cap are identical on every node, and this is a plain
                        // balance move folded into the same state_root all nodes recompute.
                        if self.amount > 0 {
                            if let Some(c) = accounts.get_mut(&contract_addr) {
                                c.balance = c.balance.saturating_sub(self.amount);
                            }
                            if let Some(s) = accounts.get_mut(&sender_addr) {
                                s.balance = s.balance.saturating_add(self.amount);
                            }
                        }
                        if over_cap && is_info_log() {
                            println!("[WARN][VM] wasm_storage_cap_exceeded contract={} — commit skipped, value returned (fee consumed)",
                                &contract_addr[..contract_addr.len().min(20)]);
                        }
                    }
                    if is_info_log() {
                        println!("[INFO][VM] wasm_calltree contract={} fuel={} trapped={} contracts={} h={}",
                            &contract_addr[..contract_addr.len().min(20)], result.fuel_consumed,
                            result.trapped, result.writes.len(), block_height);
                    }
                } else {
                    // Generic contract call — record in storage (capped)
                    const MAX_CALL_RECORDS: usize = 10_000;
                    let contract = accounts.get_mut(&contract_addr).unwrap();
                    if contract.contract_storage.len() < MAX_CALL_RECORDS {
                        let call_key = format!("call:{}:{}", self.timestamp, &sender_addr[..sender_addr.len().min(16)]);
                        let call_value = format!("value={},gas={},data_len={}",
                            self.amount, fee,
                            self.data.as_ref().map(|d| d.len()).unwrap_or(0));
                        contract.contract_storage.insert(call_key, call_value);
                    }
                }

                if is_info_log() && !is_qrc20 {
                    println!("[INFO][CONTRACT-CALL] {} -> {} fee={} value={} nanoQNC",
                        &sender_addr[..sender_addr.len().min(16)],
                        &contract_addr[..contract_addr.len().min(20)],
                        fee, self.amount);
                }
            }
            TransactionType::Swap { .. } => {
                // FAIL-CLOSED (TVC-6): Swap/DEX is disabled. A priced apply MUST compute the output
                // from on-chain pool reserves (constant-product curve) — crediting a client-supplied
                // amount_out would be a pool drain. Dormant today (no RPC creates a Swap TX); the
                // priced apply logic is written together with the DEX contract. The former
                // unreachable draft was removed (no dead #[allow(unreachable_code)] block).
                return Err(StateError::InvalidTransaction("[REJECT][SWAP] disabled_no_onchain_pricing".into()));
            }
            TransactionType::RewardDistribution => {
                // System transaction for reward distribution
                // Only allowed from system accounts
                if !self.from.starts_with("system_") {
                    return Err(StateError::InvalidTransaction(format!("[REJECT][REWARDS] unauthorized_sender sender={}", self.from)));
                }
                
                // v2.99: CRITICAL - EMISSION TX vs CLAIM TX distinction
                // EMISSION TX: system_emission → system_rewards_pool (record-keeping only)
                // CLAIM TX: system_rewards_pool → user_wallet (actual claim)
                
                if self.from == "system_emission" && self.to.as_ref().map(|t| t.as_str()) == Some("system_rewards_pool") {
                    // v2.99: EMISSION TX - blockchain record ONLY!
                    // Rewards ALREADY distributed via emit_rewards() + update_pending_rewards()
                    // This TX is ONLY for transparency/auditing - DO NOT process rewards again!
                    if is_info_log() { println!("[INFO][EMISSION] emission_tx_recorded amount={} QNC", self.amount / 1_000_000_000); }
                    return Ok(()); // No account changes - already handled!
                }
                
                // v2.96: CLAIM TX - validate and process reward claim
                // This happens when user calls /api/v1/claim_rewards
                if let Some(to) = &self.to {
                    // v3 merkle-claim: the proofs were verified and balances credited in node.rs
                    // apply Phase 2b (which has storage→epoch root). Skip the legacy pending_rewards
                    // debit so a merkle claim is not double-applied here.
                    if let Some(ref d) = self.data {
                        if let Ok(p) = serde_json::from_str::<serde_json::Value>(d) {
                            if p.get("claims").is_some() {
                                return Ok(());
                            }
                        }
                    }
                    let recipient = accounts.entry(to.clone())
                        .or_insert_with(|| Account::new(to.clone()));

                    // v2.96: SECURITY - Check if recipient has sufficient pending rewards
                    if self.amount > recipient.pending_rewards {
                        return Err(StateError::InvalidTransaction(
                            format!("[REJECT][REWARDS] insufficient_pending_rewards attempted={} available={}",
                                    self.amount / 1_000_000_000,
                                    recipient.pending_rewards / 1_000_000_000)
                        ));
                    }
                    
                    // Transfer from pending_rewards to balance (claim)
                    recipient.pending_rewards = recipient.pending_rewards.checked_sub(self.amount)
                        .ok_or_else(|| StateError::InvalidTransaction("[REJECT][REWARDS] pending_rewards_underflow".into()))?;
                    recipient.balance = recipient.balance.checked_add(self.amount)
                        .ok_or_else(|| StateError::InvalidTransaction("[REJECT][REWARDS] claim_balance_overflow".into()))?;
                    
                    if is_info_log() {
                        println!("[INFO][REWARDS] reward_claimed amount={} QNC to={} pending_remaining={} QNC",
                            self.amount / 1_000_000_000,
                            &to[..to.len().min(16)],
                            recipient.pending_rewards / 1_000_000_000);
                    }
                }
            }
            TransactionType::BatchRewardClaims { node_ids, .. } => {
                // DEPRECATED: This TX type is never created in production.
                // Architecture: 1 wallet = 1 node → no batch needed.
                // handle_batch_claim_rewards() creates individual RewardDistribution TXs.
                // This code path exists only for backward-compatible processing of
                // historical blocks that might contain this TX type.
                // It only deducts the gas fee — actual claims go through RewardDistribution.
                let sender = accounts.get_mut(&self.from)
                    .ok_or_else(|| StateError::AccountNotFound(self.from.clone()))?;

                // IDEMPOTENT APPLY — see Transfer arm for full rationale.
                if self.nonce <= sender.nonce {
                    return Ok(());
                }
                // CRITICAL SECURITY: Check nonce to prevent replay attacks
                if self.nonce != sender.nonce + 1 {
                    return Err(StateError::InvalidTransaction(format!(
                        "[REJECT][TX] invalid_nonce expected={} got={}",
                        sender.nonce + 1, self.nonce
                    )));
                }

                // Calculate total fee for batch (QUANTUM v2.25: +50% for Dilithium TX)
                let per_fee = self.effective_gas_price().checked_mul(self.gas_limit)
                    .ok_or_else(|| StateError::InvalidTransaction("[REJECT][TX] gas_fee_overflow".into()))?;
                let total_fee = per_fee.checked_mul(node_ids.len() as u64)
                    .ok_or_else(|| StateError::InvalidTransaction("[REJECT][BATCH-CLAIM] total_fee_overflow".into()))?;

                if sender.balance < total_fee {
                    return Err(StateError::InsufficientBalance {
                        have: sender.balance,
                        need: total_fee,
                    });
                }

                // Deduct total fee once
                sender.balance = sender.balance.checked_sub(total_fee)
                    .ok_or_else(|| StateError::InvalidTransaction("[REJECT][BATCH-CLAIM] fee_balance_underflow".into()))?;
                sender.nonce = sender.nonce.checked_add(1)
                    .ok_or_else(|| StateError::InvalidTransaction("[REJECT][TX] nonce_overflow".into()))?;

                if is_info_log() {
                    println!("[INFO][BATCH-CLAIM-FEE] {} nodes by {} fee={} nanoQNC",
                        node_ids.len(), &self.from[..self.from.len().min(16)], total_fee);
                }
            }
            TransactionType::BatchNodeActivations { activation_data, .. } => {
                // Batch node activations - single nonce increment for the entire batch
                let sender = accounts.get_mut(&self.from)
                    .ok_or_else(|| StateError::AccountNotFound(self.from.clone()))?;

                // IDEMPOTENT APPLY — see Transfer arm for full rationale.
                if self.nonce <= sender.nonce {
                    return Ok(());
                }
                // CRITICAL SECURITY: Check nonce to prevent replay attacks
                if self.nonce != sender.nonce + 1 {
                    return Err(StateError::InvalidTransaction(format!(
                        "[REJECT][TX] invalid_nonce expected={} got={}",
                        sender.nonce + 1, self.nonce
                    )));
                }

                // Calculate total activation amount and fees (QUANTUM v2.25: +50% for Dilithium TX)
                let total_activation_amount: u64 = activation_data.iter()
                    .try_fold(0u64, |acc, d| acc.checked_add(d.activation_amount)
                        .ok_or_else(|| StateError::InvalidTransaction("[REJECT][BATCH-ACTIVATION] amount_sum_overflow".into())))?;
                let per_fee = self.effective_gas_price().checked_mul(self.gas_limit)
                    .ok_or_else(|| StateError::InvalidTransaction("[REJECT][TX] gas_fee_overflow".into()))?;
                let total_fee = per_fee.checked_mul(activation_data.len() as u64)
                    .ok_or_else(|| StateError::InvalidTransaction("[REJECT][BATCH-ACTIVATION] total_fee_overflow".into()))?;
                let total_cost = total_activation_amount.checked_add(total_fee)
                    .ok_or_else(|| StateError::InvalidTransaction("[REJECT][BATCH-ACTIVATION] total_cost_overflow".into()))?;

                if sender.balance < total_cost {
                    return Err(StateError::InsufficientBalance {
                        have: sender.balance,
                        need: total_cost,
                    });
                }

                // Deduct total cost once
                sender.balance = sender.balance.checked_sub(total_cost)
                    .ok_or_else(|| StateError::InvalidTransaction("[REJECT][BATCH-ACTIVATION] balance_underflow".into()))?;
                sender.nonce = sender.nonce.checked_add(1)
                    .ok_or_else(|| StateError::InvalidTransaction("[REJECT][TX] nonce_overflow".into()))?;

                // v3.34: Actually activate each node (previously only deducted fees)
                for data in activation_data {
                    let owner = accounts.entry(data.owner_address.clone())
                        .or_insert_with(|| Account::new(data.owner_address.clone()));
                    owner.activate_node(format!("{:?}", data.node_type), self.timestamp);
                }

                if is_info_log() {
                    println!("[INFO][BATCH-ACTIVATION] {} nodes by {} cost={} nanoQNC",
                        activation_data.len(), &self.from[..self.from.len().min(16)], total_cost);
                }
            }
            TransactionType::BatchTransfers { transfers, .. } => {
                // Batch transfers - single nonce increment for the entire batch
                let sender = accounts.get_mut(&self.from)
                    .ok_or_else(|| StateError::AccountNotFound(self.from.clone()))?;

                // IDEMPOTENT APPLY — see Transfer arm for full rationale.
                if self.nonce <= sender.nonce {
                    return Ok(());
                }
                // CRITICAL SECURITY: Check nonce to prevent replay attacks
                if self.nonce != sender.nonce + 1 {
                    return Err(StateError::InvalidTransaction(format!(
                        "[REJECT][TX] invalid_nonce expected={} got={}",
                        sender.nonce + 1, self.nonce
                    )));
                }

                // Calculate total transfer amount and fees (QUANTUM v2.25: +50% for Dilithium TX)
                // H2 SECURITY: checked arithmetic prevents overflow with large batch sizes
                let total_transfer_amount: u64 = transfers.iter().try_fold(0u64, |acc, t| {
                    acc.checked_add(t.amount).ok_or_else(|| StateError::InvalidTransaction(
                        "[REJECT][BATCH-TRANSFER] overflow: sum of transfer amounts exceeds u64::MAX".to_string()
                    ))
                })?;
                let per_tx_fee = self.effective_gas_price().checked_mul(self.gas_limit)
                    .ok_or_else(|| StateError::InvalidTransaction(
                        "[REJECT][BATCH-TRANSFER] overflow: gas_price * gas_limit exceeds u64::MAX".to_string()
                    ))?;
                let total_fee = per_tx_fee.checked_mul(transfers.len() as u64)
                    .ok_or_else(|| StateError::InvalidTransaction(
                        "[REJECT][BATCH-TRANSFER] overflow: per_tx_fee * count exceeds u64::MAX".to_string()
                    ))?;
                let total_cost = total_transfer_amount.checked_add(total_fee)
                    .ok_or_else(|| StateError::InvalidTransaction(
                        "[REJECT][BATCH-TRANSFER] overflow: total_amount + total_fee exceeds u64::MAX".to_string()
                    ))?;

                if sender.balance < total_cost {
                    return Err(StateError::InsufficientBalance {
                        have: sender.balance,
                        need: total_cost,
                    });
                }

                // Deduct total cost once
                sender.balance = sender.balance.checked_sub(total_cost)
                    .ok_or_else(|| StateError::InvalidTransaction("[REJECT][BATCH-TRANSFER] balance_underflow".into()))?;
                sender.nonce = sender.nonce.checked_add(1)
                    .ok_or_else(|| StateError::InvalidTransaction("[REJECT][TX] nonce_overflow".into()))?;

                // Process each transfer to recipients
                for transfer in transfers {
                    let recipient = accounts.entry(transfer.to_address.clone())
                        .or_insert_with(|| Account::new(transfer.to_address.clone()));
                    recipient.balance = recipient.balance.checked_add(transfer.amount)
                        .ok_or_else(|| StateError::InvalidTransaction("[REJECT][BATCH-TRANSFER] recipient_balance_overflow".into()))?;
                }

                if is_info_log() {
                    println!("[INFO][BATCH-TRANSFER] {} nanoQNC to {} recipients by {} fee={} nanoQNC",
                        total_transfer_amount, transfers.len(),
                        &self.from[..self.from.len().min(16)], total_fee);
                }
            }
            TransactionType::PingAttestation { from_node, to_node, response_time_ms, success } => {
                // Ping attestations are FREE system operations (gas = 0)
                // They don't modify account balances, only recorded on-chain for emission calculation
                // PingAttestation -- legacy type, kept for backward compat
                if is_debug_log() {
                    println!("[DEBUG][PING] on-chain attestation: {} -> {} ({}ms, success: {})",
                        from_node, to_node, response_time_ms, success);
                }
                // No state modification needed - ping history will be read from blockchain
            }
            TransactionType::PingCommitmentWithSampling { 
                window_start_height,
                window_end_height, 
                total_ping_count,
                successful_ping_count,
                ping_samples,
                .. 
            } => {
                // Ping commitments are FREE system operations (gas = 0)
                // They don't modify account balances, only provide deterministic data for emission
                if is_debug_log() {
                    println!("[DEBUG][PING-COMMITMENT] Merkle window={}-{} total={} ok={} samples={}",
                        window_start_height, window_end_height,
                        total_ping_count, successful_ping_count, ping_samples.len());
                }
                // No state modification needed - commitment will be validated during emission check
            }
            TransactionType::Heartbeat { anchor_height, .. } => {
                // v34: unforgeable liveness — set the sender's subwindow bit for the anchor's
                // epoch. Idempotent (re-applying a block sets an already-set bit → no double
                // count), so no per-TX apply dedup is needed. On a new epoch, finalize the
                // previous epoch's popcount (so the boundary reward snapshot can read it) then
                // reset the bitmask. epoch/subwindow derive from anchor_height (in the TX), so
                // apply needs no block-height context. Validity (anchor/sig) verified upstream.
                const EPOCH_BLOCKS: u64 = 14400;
                const SUBWINDOW_BLOCKS: u64 = 1440; // 10 subwindows per epoch
                let epoch = anchor_height / EPOCH_BLOCKS;
                let subwindow = ((anchor_height % EPOCH_BLOCKS) / SUBWINDOW_BLOCKS) as u16; // 0..9
                let acct = accounts
                    .entry(self.from.clone())
                    .or_insert_with(|| Account::new(self.from.clone()));
                if acct.heartbeat_epoch != epoch {
                    acct.heartbeat_final_epoch = acct.heartbeat_epoch;
                    acct.heartbeat_final_count = acct.heartbeat_slots.count_ones() as u8;
                    acct.heartbeat_epoch = epoch;
                    acct.heartbeat_slots = 0;
                }
                acct.heartbeat_slots |= 1u16 << subwindow.min(9);
            }
            TransactionType::HeartbeatCommitment {
                node_id,
                window_start_height,
                window_end_height,
                heartbeat_count,
                heartbeat_samples,
                ..
            } => {
                // Heartbeat commitments are FREE system operations (gas = 0)
                // They don't modify account balances, only provide deterministic data for emission
                if is_debug_log() {
                    println!("[DEBUG][HEARTBEAT-COMMITMENT] node={} window={}-{} count={} samples={}",
                        node_id, window_start_height, window_end_height,
                        heartbeat_count, heartbeat_samples.len());
                }
                // No state modification needed - commitment will be validated during emission check
            }
            TransactionType::LightNodeEligibilityBitmap {
                genesis_id,
                epoch,
                total_assigned,
                eligible_count,
                bitmap_compressed,
            } => {
                // v2.89: Light Node Eligibility Bitmap - FREE system operation
                // Genesis nodes submit compressed bitmaps of eligible Light nodes
                // MacroBlock will collect and merge all bitmaps for reward distribution
                if is_debug_log() {
                    println!("[DEBUG][LIGHT-BITMAP] genesis={} epoch={} eligible={}/{} compressed={} bytes",
                        genesis_id, epoch, eligible_count, total_assigned, bitmap_compressed.len());
                }
                // No state modification needed - bitmap will be read by MacroBlock
            }
            TransactionType::NodeRegistration { node_id, node_type, wallet_address, .. } => {
                // System transaction: on-chain node registration
                // No balance changes, only registers node_id -> wallet_address binding
                if is_info_log() {
                    println!("[INFO][NODE-REG] registered: {} ({:?}) -> {}",
                        node_id, node_type, &wallet_address[..20.min(wallet_address.len())]);
                }
                // Registration data is stored in blockchain for immutable lookup
            }
            TransactionType::NodeReactivation { node_id, current_height, last_macroblock_index, .. } => {
                // v9.4: System transaction: node reactivation signal
                // No balance changes — only signals that the node is back online and synced.
                // Picked up by create_eligible_producers_snapshot() Level 1 scan.
                if is_info_log() {
                    println!("[INFO][NODE-REACT] reactivated: {} h={} mb={}",
                        node_id, current_height, last_macroblock_index);
                }
            }
            TransactionType::KeyRotation { node_id, new_dilithium_pk, effective_height, .. } => {
                // FIX R23-K1: Key rotation — system operation, no balance changes.
                // The new public key is stored on-chain for future signature verification.
                // Processing: VRF registry and P2P certificate manager pick up the change.
                if is_info_log() {
                    println!("[INFO][KEY-ROTATE] node={} new_pk_prefix={}... effective_h={}",
                        node_id, &new_dilithium_pk[..16.min(new_dilithium_pk.len())], effective_height);
                }
            }

            // Equivocation slashing proofs: no account-state effect. The penalty
            // (offender → reputation 0 + ban) is applied deterministically in the
            // reputation fold from the committed proof, not in account state.
            TransactionType::EquivocationProof { .. } => {}
            TransactionType::VoteEquivocationProof { .. } => {}
        }

        Ok(())
    }

    /// Check if transaction qualifies for instant local finalization
    pub fn can_be_locally_finalized(&self, config: &LocalFinalizationConfig) -> bool {
        // Small amount transactions get instant finalization
        if self.amount <= config.max_instant_amount {
            return true;
        }
        
        // High gas price transactions (priority)
        if self.gas_price >= config.max_instant_gas_price {
            return true;
        }
        
        // Trusted senders
        if config.trusted_senders.contains(&self.from) {
            return true;
        }
        
        // Standard transactions (P2P transfers, not contracts)
        match &self.tx_type {
            TransactionType::Transfer { amount, .. } => {
                *amount <= config.max_instant_amount
            }
            _ => false, // Contracts need full consensus
        }
    }
    
    /// Get finalization requirements based on transaction type and amount
    pub fn get_finalization_requirements(&self, config: &LocalFinalizationConfig) -> FinalizationRequirements {
        if self.can_be_locally_finalized(config) {
            FinalizationRequirements::Local {
                microblock_confirmations: 1,
                timeout_seconds: 30,
            }
        } else {
            FinalizationRequirements::Global {
                macroblock_confirmations: config.min_confirmations,
                timeout_seconds: 600, // 10 minutes
            }
        }
    }
    
    /// Apply transaction with local finalization logic
    pub fn apply_with_finalization(
        &self,
        accounts: &mut HashMap<String, Account>,
        config: &LocalFinalizationConfig,
        is_microblock: bool,
    ) -> Result<FinalizationStatus, StateError> {
        // First apply the transaction
        self.apply_to_state(accounts)?;
        
        // Determine finalization status
        if is_microblock && self.can_be_locally_finalized(config) {
            Ok(FinalizationStatus::LocallyFinalized { microblock_height: 0 })
        } else {
            Ok(FinalizationStatus::Pending)
        }
    }
}

/// Finalization requirements for different transaction types
#[derive(Debug, Clone)]
pub enum FinalizationRequirements {
    /// Local finalization in microblock (fast)
    Local {
        microblock_confirmations: u64,
        timeout_seconds: u64,
    },
    /// Global finalization in macroblock (secure)
    Global {
        macroblock_confirmations: u64,
        timeout_seconds: u64,
    },
}

/// Finalization manager for tracking transaction finalization
pub struct FinalizationManager {
    config: LocalFinalizationConfig,
    /// Transaction status tracking (bounded to MAX_TRACKED_TX)
    tx_status: HashMap<String, FinalizationStatus>,
    /// Microblock to macroblock mapping
    microblock_to_macroblock: HashMap<u64, u64>,
}

/// FIX M5: Maximum tracked transactions to prevent unbounded growth
const MAX_FINALIZATION_TRACKED_TX: usize = 100_000;
const MAX_FINALIZATION_MAPPINGS: usize = 50_000;

impl FinalizationManager {
    pub fn new(config: LocalFinalizationConfig) -> Self {
        Self {
            config,
            tx_status: HashMap::new(),
            microblock_to_macroblock: HashMap::new(),
        }
    }
    
    /// Update transaction finalization status
    /// FIX M5: Evict oldest entries when exceeding MAX_FINALIZATION_TRACKED_TX
    pub fn update_transaction_status(
        &mut self,
        tx_hash: &str,
        status: FinalizationStatus,
    ) {
        // Evict ~10% oldest entries when at capacity
        if self.tx_status.len() >= MAX_FINALIZATION_TRACKED_TX && !self.tx_status.contains_key(tx_hash) {
            let evict_count = MAX_FINALIZATION_TRACKED_TX / 10;
            let keys_to_remove: Vec<String> = self.tx_status.keys().take(evict_count).cloned().collect();
            for key in keys_to_remove {
                self.tx_status.remove(&key);
            }
        }
        self.tx_status.insert(tx_hash.to_string(), status);
    }
    
    /// Check if transaction is finalized for given requirements
    pub fn is_finalized(
        &self,
        tx_hash: &str,
        requirements: &FinalizationRequirements,
        current_height: u64,
    ) -> bool {
        if let Some(status) = self.tx_status.get(tx_hash) {
            match (status, requirements) {
                (
                    FinalizationStatus::LocallyFinalized { microblock_height },
                    FinalizationRequirements::Local { microblock_confirmations, .. }
                ) => {
                    current_height >= microblock_height + microblock_confirmations
                }
                (
                    FinalizationStatus::GloballyFinalized { .. },
                    _
                ) => true,
                _ => false,
            }
        } else {
            false
        }
    }
    
    /// Promote locally finalized transactions to globally finalized
    pub fn promote_to_global_finalization(
        &mut self,
        microblock_height: u64,
        macroblock_height: u64,
    ) {
        // Update mapping
        self.microblock_to_macroblock.insert(microblock_height, macroblock_height);
        
        // Promote all locally finalized transactions from this microblock
        for (tx_hash, status) in self.tx_status.iter_mut() {
            if let FinalizationStatus::LocallyFinalized { microblock_height: mb_height } = status {
                if *mb_height == microblock_height {
                    *status = FinalizationStatus::GloballyFinalized { 
                        macroblock_height 
                    };
                }
            }
        }
    }
    
    /// Get finalization statistics
    pub fn get_stats(&self) -> FinalizationStats {
        let mut stats = FinalizationStats::default();
        
        for status in self.tx_status.values() {
            match status {
                FinalizationStatus::Pending => stats.pending += 1,
                FinalizationStatus::LocallyFinalized { .. } => stats.locally_finalized += 1,
                FinalizationStatus::GloballyFinalized { .. } => stats.globally_finalized += 1,
            }
        }
        
        stats
    }
}

/// Finalization statistics
#[derive(Debug, Default)]
pub struct FinalizationStats {
    pub pending: u64,
    pub locally_finalized: u64,
    pub globally_finalized: u64,
}

impl TransactionReceipt {
    /// Check if transaction was successful
    pub fn is_success(&self) -> bool {
        matches!(self.signature, Some(_))
    }
    
    /// Get failure reason if any
    pub fn failure_reason(&self) -> Option<&str> {
        self.signature.as_deref()
    }
}

/// Transaction processing with reward integration (v3.18: Pool 2 removed)
pub struct TransactionProcessor {
    /// Integration with reward system
    pub reward_integration: Option<Box<dyn RewardIntegrationCallback>>,
}

/// Callback trait for reward integration
pub trait RewardIntegrationCallback: Send + Sync {
    /// Process transaction fee (v3.18: Pool 2 removed - fees go directly to producer)
    fn process_transaction_fee(&mut self, tx_hash: String, amount: u64, gas_used: u64, gas_price: u64) -> Result<(), String>;
    
    /// Process node activation for Pool 3
    fn process_node_activation(&mut self, node_id: String, node_type: String, amount: u64, tx_hash: String) -> Result<(), String>;
}

impl TransactionProcessor {
    /// Create new transaction processor
    pub fn new() -> Self {
        Self {
            reward_integration: None,
        }
    }
    
    /// Set reward integration callback
    pub fn set_reward_integration(&mut self, callback: Box<dyn RewardIntegrationCallback>) {
        self.reward_integration = Some(callback);
    }
    
    /// Process transaction with proper fee handling
    pub fn process_transaction(&mut self, tx: &Transaction, accounts: &mut HashMap<String, Account>) -> Result<(), StateError> {
        // Apply transaction logic
        tx.apply_to_state(accounts)?;
        
        // v3.18: Pool 2 removed - fees go directly to block producer
        // v3.36: Use compute_gas_used() for accurate fee calculation
        // QUANTUM v2.25: Use effective_gas_price() which adds +50% for Dilithium TX
        let gas_used = tx.compute_gas_used();
        let fee_amount = match &tx.tx_type {
            TransactionType::NodeActivation { phase: ActivationPhase::Phase1, .. } => {
                0 // Phase 1 activations are completely FREE - no QNC gas fees!
            },
            // FIX M3: saturating_mul instead of unwrap_or(0) to preserve max possible fee on overflow
            _ => tx.effective_gas_price().saturating_mul(gas_used)
        };
        
        if fee_amount > 0 {
            if let Some(ref mut integration) = self.reward_integration {
                if let Err(e) = integration.process_transaction_fee(
                    tx.hash.clone(),
                    tx.amount,
                    gas_used,
                    tx.gas_price,
                ) {
                    eprintln!("[WARN][TX] fee_routing_failed err={}", e);
                }
            }
        }
        
        // Handle node activation for Pool 3
        if let TransactionType::NodeActivation { node_type, amount, .. } = &tx.tx_type {
            if let Some(ref mut integration) = self.reward_integration {
                if let Err(e) = integration.process_node_activation(
                    tx.from.clone(),
                    format!("{:?}", node_type),
                    *amount,
                    tx.hash.clone(),
                ) {
                    eprintln!("[WARN] Failed to process node activation: {}", e);
                }
            }
        }
        
        Ok(())
    }
}

/// Dynamic gas pricing system
/// FIX R14-M1: All arithmetic uses fixed-point basis points (10000 = 1.0x) for determinism
#[derive(Debug, Clone)]
pub struct DynamicGasPricing {
    /// Current mempool size
    mempool_size: usize,
    /// Target block utilization in basis points (8000 = 80%)
    target_utilization_bps: u64,
    /// Current block utilization in basis points (0-10000)
    current_utilization_bps: u64,
    /// Base gas price adjustment factor in basis points (10000 = 1.0x)
    adjustment_factor_bps: u64,
}

impl DynamicGasPricing {
    pub fn new() -> Self {
        Self {
            mempool_size: 0,
            target_utilization_bps: 8_000, // 80%
            current_utilization_bps: 0,
            adjustment_factor_bps: 10_000, // 1.0x
        }
    }

    /// Update network load metrics
    pub fn update_network_load(&mut self, mempool_size: usize, block_utilization: f64) {
        self.mempool_size = mempool_size;
        // Convert f64 utilization (0.0-1.0) to basis points (0-10000)
        self.current_utilization_bps = (block_utilization * 10_000.0).min(10_000.0).max(0.0) as u64;
        self.adjustment_factor_bps = self.calculate_adjustment_factor_bps();
    }

    /// Calculate gas price adjustment in basis points (deterministic integer math)
    fn calculate_adjustment_factor_bps(&self) -> u64 {
        // Mempool congestion factor (basis points)
        let mempool_factor_bps: u64 = match self.mempool_size {
            0..=100 => 8_000,       // 0.8x — low congestion discount
            101..=500 => 10_000,    // 1.0x — normal
            501..=1000 => 15_000,   // 1.5x — high congestion
            1001..=2000 => 20_000,  // 2.0x — very high
            _ => 30_000,            // 3.0x — extreme
        };

        // Utilization factor (basis points)
        let utilization_factor_bps: u64 = if self.current_utilization_bps > self.target_utilization_bps {
            // Above target: increase price (1.0 + delta * 2.0)
            let delta = self.current_utilization_bps.saturating_sub(self.target_utilization_bps);
            10_000u64.saturating_add(delta.saturating_mul(2))
        } else {
            // Below target: decrease price (1.0 - delta * 0.5)
            let delta = self.target_utilization_bps.saturating_sub(self.current_utilization_bps);
            10_000u64.saturating_sub(delta / 2)
        };

        // Combined: (mempool * utilization) / 10000, capped at 5x (50000), min 0.5x (5000)
        let combined = mempool_factor_bps.saturating_mul(utilization_factor_bps) / 10_000;
        combined.max(5_000).min(50_000)
    }
    
    /// Get current dynamic gas price
    pub fn get_dynamic_gas_price(&self, tier: GasTier) -> GasPrice {
        let base_price = match tier {
            GasTier::Eco => GasPrice::mobile(),
            GasTier::Standard => GasPrice::standard(),
            GasTier::Fast => GasPrice::fast(),
            GasTier::Priority => GasPrice::priority(),
        };
        
        // FIX R14-M1: Fixed-point integer arithmetic for deterministic gas pricing
        // adjustment_factor_bps is in basis points (10000 = 1.0x, 15000 = 1.5x)
        let adjusted_price = base_price.0.saturating_mul(self.adjustment_factor_bps) / 10_000;
        GasPrice(adjusted_price)
    }
    
    /// Get gas price recommendations for mobile wallets
    pub fn get_mobile_gas_recommendations(&self) -> MobileGasRecommendations {
        MobileGasRecommendations {
            eco: self.get_dynamic_gas_price(GasTier::Eco),
            standard: self.get_dynamic_gas_price(GasTier::Standard),
            fast: self.get_dynamic_gas_price(GasTier::Fast),
            priority: self.get_dynamic_gas_price(GasTier::Priority),
            network_load: self.get_network_load_status(),
            estimated_confirmation_time: self.estimate_confirmation_time(),
        }
    }
    
    /// Get human-readable network load status
    fn get_network_load_status(&self) -> NetworkLoadStatus {
        let status = match self.mempool_size {
            0..=100 => NetworkLoadStatus::Low,
            101..=500 => NetworkLoadStatus::Normal,
            501..=1000 => NetworkLoadStatus::High,
            1001..=2000 => NetworkLoadStatus::Extreme,
            _ => NetworkLoadStatus::Extreme,
        };
        status
    }
    
    /// Estimate confirmation time based on network load
    fn estimate_confirmation_time(&self) -> ConfirmationTime {
        match self.mempool_size {
            0..=100 => ConfirmationTime::Seconds(1),
            101..=500 => ConfirmationTime::Seconds(2),
            501..=1000 => ConfirmationTime::Seconds(5),
            1001..=2000 => ConfirmationTime::Seconds(10),
            _ => ConfirmationTime::Seconds(30),
        }
    }
}

/// Gas pricing tiers for mobile optimization
#[derive(Debug, Clone, Copy)]
pub enum GasTier {
    Eco,      // Slowest, cheapest
    Standard, // Normal speed and price
    Fast,     // Faster, higher price
    Priority, // Fastest, highest price
}

/// Mobile gas recommendations for wallet integration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MobileGasRecommendations {
    pub eco: GasPrice,
    pub standard: GasPrice,
    pub fast: GasPrice,
    pub priority: GasPrice,
    pub network_load: NetworkLoadStatus,
    pub estimated_confirmation_time: ConfirmationTime,
}

/// Network load status
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum NetworkLoadStatus {
    Low,
    Normal,
    High,
    Extreme,
}

/// Estimated confirmation time
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ConfirmationTime {
    Seconds(u64),
    Minutes(u64),
}

/// Dynamic gas pricing configuration (thread-safe)
static DYNAMIC_GAS_PRICING: Lazy<Arc<RwLock<Option<DynamicGasPricing>>>> = 
    Lazy::new(|| Arc::new(RwLock::new(None)));

/// Initialize dynamic gas pricing
pub fn init_dynamic_gas_pricing() {
    let pricing = DynamicGasPricing::new();
    match DYNAMIC_GAS_PRICING.write() {
        Ok(mut guard) => *guard = Some(pricing),
        Err(poisoned) => *poisoned.into_inner() = Some(pricing),
    }
}

/// Get dynamic gas pricing
pub fn get_dynamic_gas_pricing() -> Option<DynamicGasPricing> {
    match DYNAMIC_GAS_PRICING.read() {
        Ok(guard) => guard.as_ref().cloned(),
        Err(poisoned) => poisoned.into_inner().as_ref().cloned(),
    }
}

/// Update dynamic gas pricing
pub fn update_dynamic_gas_pricing(new_pricing: DynamicGasPricing) {
    match DYNAMIC_GAS_PRICING.write() {
        Ok(mut guard) => *guard = Some(new_pricing),
        Err(poisoned) => *poisoned.into_inner() = Some(new_pricing),
    }
}

// ════════════════════════════════════════════════════════════════════════════
// REGRESSION TESTS — Fix #19 (Transfer/Swap wallet impersonation)
// ════════════════════════════════════════════════════════════════════════════
// These tests pin the security invariant that the payload `from` field on
// Transfer / Swap transactions MUST equal the TX-level sender (`tx.from`).
// The original bug: the canonical signing message bound `tx.from`, but
// `apply_to_state` mutated `accounts[payload.from]`. Without this gate any
// peer could submit a TX whose signature verified against THEIR registered
// PK while debiting an arbitrary VICTIM wallet.
//
// Tests cover BOTH `validate()` (mempool / RPC ingest gate) and
// `apply_to_state()` (defence-in-depth at state mutation time).
#[cfg(test)]
mod tests_v34_heartbeat {
    use super::*;
    use crate::account::Account;
    use std::collections::HashMap;

    // Build a v34 Heartbeat TX. `from` == node_id (the account whose subwindow bitmask
    // increments). anchor_hash is a structurally-valid 64-hex placeholder (the real
    // anchor/sig check is verify_heartbeat_tx at block validation, not apply).
    fn hb(node_id: &str, anchor_height: u64) -> Transaction {
        let mut tx = Transaction {
            hash: String::new(),
            from: node_id.to_string(),
            to: None,
            amount: 0,
            nonce: 0,
            gas_price: u64::MAX,
            gas_limit: 0,
            timestamp: 1_700_000_000,
            signature: None,
            public_key: None,
            tx_type: TransactionType::Heartbeat {
                node_id: node_id.to_string(),
                anchor_height,
                anchor_hash: "a".repeat(64),
                signature: String::new(),
            },
            data: None,
            // v35: the heartbeat's single Dilithium sig lives here (over the anchor message).
            dilithium_signature: Some("deadbeef".to_string()),
            dilithium_public_key: Some(node_id.to_string()),
            chain_id: 0,
        };
        tx.hash = tx.calculate_hash();
        tx
    }

    // apply sets the bit for anchor's subwindow; same subwindow is idempotent (no double-count).
    #[test]
    fn apply_sets_subwindow_bit_and_is_idempotent() {
        let mut accts: HashMap<String, Account> = HashMap::new();
        hb("genesis_node_001", 100).apply_to_state(&mut accts).unwrap(); // epoch 0, subwindow 0
        let a = accts.get("genesis_node_001").unwrap();
        assert_eq!(a.heartbeat_epoch, 0);
        assert_eq!(a.heartbeat_slots, 0b1);
        // subwindow 3 (anchor 3*1440+5 = 4325)
        hb("genesis_node_001", 3 * 1440 + 5).apply_to_state(&mut accts).unwrap();
        assert_eq!(accts.get("genesis_node_001").unwrap().heartbeat_slots, 0b1001);
        assert_eq!(accts.get("genesis_node_001").unwrap().heartbeat_slots.count_ones(), 2);
        // re-hit subwindow 0 (anchor 200) → idempotent, still 2 bits (no inflation by spamming)
        hb("genesis_node_001", 200).apply_to_state(&mut accts).unwrap();
        assert_eq!(accts.get("genesis_node_001").unwrap().heartbeat_slots.count_ones(), 2);
    }

    // Crossing into a new epoch finalizes the previous epoch's popcount (for the reward
    // snapshot) and resets the live bitmask. Determinism-critical: feeds state_root.
    #[test]
    fn apply_epoch_rollover_finalizes_previous() {
        let mut accts: HashMap<String, Account> = HashMap::new();
        for sw in 0..3u64 { hb("super_x", sw * 1440 + 10).apply_to_state(&mut accts).unwrap(); }
        assert_eq!(accts.get("super_x").unwrap().heartbeat_slots.count_ones(), 3);
        // epoch 1 (anchor 14400+50): rollover
        hb("super_x", 14_400 + 50).apply_to_state(&mut accts).unwrap();
        let a = accts.get("super_x").unwrap();
        assert_eq!(a.heartbeat_epoch, 1);
        assert_eq!(a.heartbeat_final_epoch, 0);
        assert_eq!(a.heartbeat_final_count, 3, "prev epoch popcount finalized");
        assert_eq!(a.heartbeat_slots, 0b1, "new epoch bitmask = subwindow 0 only");
    }

    // 9 of 10 subwindows hit ⇒ popcount 9 = the reward-eligibility threshold.
    #[test]
    fn apply_nine_of_ten_reaches_threshold() {
        let mut accts: HashMap<String, Account> = HashMap::new();
        for sw in 0..9u64 { hb("super_y", sw * 1440 + 10).apply_to_state(&mut accts).unwrap(); }
        assert_eq!(accts.get("super_y").unwrap().heartbeat_slots.count_ones(), 9);
    }

    // Burn-attestation canonical message: FIXED, deterministic, type-distinct — every committee member
    // signs identical bytes and every validator recomputes the identical message, so the quorum verdict
    // is byte-identical network-wide. Drift here would split the signatures ⇒ no quorum forms.
    #[test]
    fn burn_attestation_message_is_canonical_and_type_distinct() {
        let m = Transaction::burn_attestation_message("solSig", "walletA", 1500, &NodeType::Super, 1500, 5);
        assert_eq!(m, Transaction::burn_attestation_message("solSig", "walletA", 1500, &NodeType::Super, 1500, 5), "deterministic");
        assert_eq!(m, "burn_attest:solSig:walletA:1500:0:1500:5", "fixed format, Super=0, cost+epoch suffix");
        // Every bound field (incl. node_type, cost AND attest_epoch) changes the signed message.
        assert_ne!(m, Transaction::burn_attestation_message("solSig", "walletA", 1500, &NodeType::Light, 1500, 5));
        assert_ne!(m, Transaction::burn_attestation_message("solSig", "walletA", 1501, &NodeType::Super, 1500, 5));
        assert_ne!(m, Transaction::burn_attestation_message("solSig", "walletB", 1500, &NodeType::Super, 1500, 5));
        assert_ne!(m, Transaction::burn_attestation_message("solSig2", "walletA", 1500, &NodeType::Super, 1500, 5));
        assert_ne!(m, Transaction::burn_attestation_message("solSig", "walletA", 1500, &NodeType::Super, 1350, 5), "cost is bound");
        assert_ne!(m, Transaction::burn_attestation_message("solSig", "walletA", 1500, &NodeType::Super, 1500, 6), "attest_epoch is bound");
        assert_eq!(Transaction::burn_attestation_message("x", "y", 0, &NodeType::Light, 300, 3), "burn_attest:x:y:0:1:300:3", "Light=1");
    }

    // Phase-1 cost formula: integer-deterministic, matching max(1500 - 150*floor(burn_pct/10), 300).
    #[test]
    fn phase1_activation_cost_tiers() {
        // Args are (total_burned, current_remaining) as Solana reports them; the fn reconstructs the
        // original cap = burned + remaining. Original 1DEV cap = 1B.
        let orig = 1_000_000_000u64;
        assert_eq!(Transaction::phase1_activation_cost(0, orig), 1500, "0% burned ⇒ base 1500");
        assert_eq!(Transaction::phase1_activation_cost(orig / 10, orig - orig / 10), 1350, "10% ⇒ −150");
        assert_eq!(Transaction::phase1_activation_cost(orig / 2, orig - orig / 2), 750, "50% ⇒ −750");
        assert_eq!(Transaction::phase1_activation_cost(orig * 8 / 10, orig - orig * 8 / 10), 300, "80% ⇒ floor 300");
        assert_eq!(Transaction::phase1_activation_cost(orig * 95 / 100, orig - orig * 95 / 100), 300, "95% ⇒ floored 300");
        assert_eq!(Transaction::phase1_activation_cost(0, 0), 1500, "zero original ⇒ base (no div-by-zero)");
    }

    // Structural validation (the pure part; anchor/sig are checked at block validation).
    #[test]
    fn validate_structural_accepts_valid_rejects_malformed() {
        assert!(hb("genesis_node_001", 100).validate().is_ok());
        // empty node_id
        let mut t = hb("genesis_node_001", 100);
        if let TransactionType::Heartbeat { ref mut node_id, .. } = t.tx_type { *node_id = String::new(); }
        t.hash = t.calculate_hash();
        assert!(t.validate().is_err(), "empty node_id must reject");
        // malformed anchor_hash (not 64 hex)
        let mut t = hb("genesis_node_001", 100);
        if let TransactionType::Heartbeat { ref mut anchor_hash, .. } = t.tx_type { *anchor_hash = "zz".to_string(); }
        t.hash = t.calculate_hash();
        assert!(t.validate().is_err(), "bad anchor_hash must reject");
        // v35: missing Dilithium signature (the single auth carrier) must reject
        let mut t = hb("genesis_node_001", 100);
        t.dilithium_signature = None;
        t.hash = t.calculate_hash();
        assert!(t.validate().is_err(), "missing dilithium_signature must reject");
    }
}

#[cfg(test)]
mod tests_v17_swap_sender {
    use super::*;
    use crate::account::Account;

    // The two genesis wallets below are real production EON addresses used
    // by `genesis_node_001` and `genesis_node_002` (pure-Dilithium form).
    // They satisfy `is_valid_eon_address` (45 chars, embedded "eon" marker,
    // valid SHA3 checksum). Hard-coding them here keeps the tests independent
    // of runtime checksum computation while exercising real-shaped data.
    const ATTACKER: &str = "4c83bc6f4c20906b81beon31e92ebc6ffccd7b973e10d";
    const VICTIM:   &str = "c81f26da185fd05dcaeeona499b3d9e58d7ec75304f1b";

    fn make_transfer_tx(tx_from: &str, payload_from: &str, to: &str, amount: u64) -> Transaction {
        // Construct via direct struct init so we can set `payload_from`
        // independently of `tx_from` — the very mismatch the fix forbids.
        let mut tx = Transaction {
            hash: String::new(),
            from: tx_from.to_string(),
            to: Some(to.to_string()),
            amount,
            nonce: 1,
            gas_price: 100_000,
            gas_limit: gas_limits::TRANSFER,
            timestamp: 1_700_000_000,
            signature: None,
            public_key: None,
            tx_type: TransactionType::Transfer {
                from: payload_from.to_string(),
                to: to.to_string(),
                amount,
            },
            data: None,
            dilithium_signature: None,
            dilithium_public_key: None,
            chain_id: 0,
        };
        tx.hash = tx.calculate_hash();
        tx
    }

    fn make_swap_tx(tx_from: &str, payload_from: &str) -> Transaction {
        let pool = "1234567890123456789eonabcdef0123456789ab12345678";
        let mut tx = Transaction {
            hash: String::new(),
            from: tx_from.to_string(),
            to: Some(pool.to_string()),
            amount: 0,
            nonce: 1,
            gas_price: 100_000,
            gas_limit: gas_limits::CONTRACT_CALL,
            timestamp: 1_700_000_000,
            signature: None,
            public_key: None,
            tx_type: TransactionType::Swap {
                from: payload_from.to_string(),
                token_in: "QNC".to_string(),
                token_out: "TOK".to_string(),
                amount_in: 1_000,
                amount_out_min: 0,
                amount_out: 0,
                pool_address: pool.to_string(),
            },
            data: None,
            dilithium_signature: None,
            dilithium_public_key: None,
            chain_id: 0,
        };
        tx.hash = tx.calculate_hash();
        tx
    }

    /// Fix #19 (validate, Transfer): matching `tx.from` and payload `from`
    /// MUST pass. This proves the gate does not over-fire on legitimate TXs.
    #[test]
    fn transfer_validate_accepts_matching_from() {
        let tx = make_transfer_tx(ATTACKER, ATTACKER, VICTIM, 1_000);
        // Validate may reject for unrelated reasons (signature absent), but
        // it must NOT reject with a sender_mismatch reason. We assert the
        // specific error we care about does not appear.
        match tx.validate() {
            Ok(()) => {} // acceptable — fully valid
            Err(msg) => {
                assert!(
                    !msg.contains("transfer_sender_mismatch"),
                    "matching from must not trigger sender_mismatch, got: {}", msg
                );
            }
        }
    }

    /// Fix #19 (validate, Transfer): MISMATCHED payload `from` MUST be
    /// rejected. This is the primary security invariant — a regression
    /// here directly re-opens the wallet-drain attack.
    #[test]
    fn transfer_validate_rejects_mismatched_from() {
        let tx = make_transfer_tx(ATTACKER, VICTIM, VICTIM, 1_000);
        let result = tx.validate();
        assert!(result.is_err(), "mismatched Transfer.from must be rejected");
        let msg = result.err().unwrap();
        assert!(
            msg.contains("transfer_sender_mismatch"),
            "rejection must name the specific gate, got: {}", msg
        );
    }

    /// Fix #19 (validate, Swap): matching `tx.from` and payload `from`
    /// passes the sender gate.
    #[test]
    fn swap_validate_accepts_matching_from() {
        let tx = make_swap_tx(ATTACKER, ATTACKER);
        match tx.validate() {
            Ok(()) => {}
            Err(msg) => {
                assert!(
                    !msg.contains("[REJECT][SWAP] sender_mismatch"),
                    "matching from must not trigger SWAP sender_mismatch, got: {}", msg
                );
            }
        }
    }

    /// Fix #19 (validate, Swap): mismatched `Swap.from` MUST be rejected.
    /// Same security invariant as Transfer — this is the gate against
    /// the DEX wallet-drain variant.
    #[test]
    fn swap_validate_rejects_mismatched_from() {
        let tx = make_swap_tx(ATTACKER, VICTIM);
        let result = tx.validate();
        assert!(result.is_err(), "mismatched Swap.from must be rejected");
        let msg = result.err().unwrap();
        assert!(
            msg.contains("[REJECT][SWAP] sender_mismatch"),
            "rejection must name the specific gate, got: {}", msg
        );
    }

    /// Fix #19 (apply, Transfer): defence-in-depth — even if a Transaction
    /// somehow reaches `apply_to_state` with a mismatched payload `from`
    /// (e.g. via a code path that skipped `validate()`), the apply layer
    /// MUST still reject. Locks in the second-line gate.
    #[test]
    fn transfer_apply_rejects_mismatched_from() {
        let tx = make_transfer_tx(ATTACKER, VICTIM, VICTIM, 1_000);
        let mut accounts: HashMap<String, Account> = HashMap::new();
        // Seed the victim account with balance so the only failure mode
        // we can hit is the mismatch gate, not "AccountNotFound".
        let mut victim_acct = Account::default();
        victim_acct.balance = 1_000_000;
        accounts.insert(VICTIM.to_string(), victim_acct);
        let mut attacker_acct = Account::default();
        attacker_acct.balance = 1_000_000;
        accounts.insert(ATTACKER.to_string(), attacker_acct);

        let result = tx.apply_to_state(&mut accounts);
        assert!(result.is_err(), "apply must reject mismatched Transfer.from");
        let err_str = format!("{:?}", result.err().unwrap());
        assert!(
            err_str.contains("transfer_sender_mismatch_at_apply"),
            "apply-layer rejection must name the at_apply gate, got: {}", err_str
        );

        // Critical post-condition: VICTIM's balance MUST NOT have changed.
        assert_eq!(
            accounts.get(VICTIM).map(|a| a.balance), Some(1_000_000),
            "victim balance must be untouched after rejection"
        );
    }

    /// Swap apply is fail-closed (dormant, no on-chain pricing): it rejects EVERY swap before any
    /// state change, which subsumes the per-field mismatch defence (still covered at the validate
    /// layer by `swap_validate_rejects_mismatched_from`).
    #[test]
    fn swap_apply_rejects_mismatched_from() {
        let tx = make_swap_tx(ATTACKER, VICTIM);
        let mut accounts: HashMap<String, Account> = HashMap::new();
        let mut victim_acct = Account::default();
        victim_acct.balance = 1_000_000;
        accounts.insert(VICTIM.to_string(), victim_acct);
        let mut attacker_acct = Account::default();
        attacker_acct.balance = 1_000_000;
        accounts.insert(ATTACKER.to_string(), attacker_acct);

        let result = tx.apply_to_state(&mut accounts);
        assert!(result.is_err(), "apply must reject any Swap while disabled");
        let err_str = format!("{:?}", result.err().unwrap());
        assert!(
            err_str.contains("disabled_no_onchain_pricing"),
            "apply-layer Swap must be fail-closed, got: {}", err_str
        );

        // Victim balance untouched.
        assert_eq!(
            accounts.get(VICTIM).map(|a| a.balance), Some(1_000_000),
            "victim balance must be untouched after Swap apply rejection"
        );
    }
}

#[cfg(test)]
mod tests_qrc20_self_transfer {
    // TVC-1/2: a QRC-20 self-transfer (to == from) must NEVER mint. Before the fix, from_key == to_key
    // aliased and the credit insert overwrote the debit, inflating the sender's balance by `amount`.
    use super::*;
    use crate::account::Account;
    use std::collections::HashMap;

    fn qrc20_call(sender: &str, contract: &str, method: &str, args_json: &str) -> Transaction {
        let mut tx = Transaction {
            hash: String::new(),
            from: sender.to_string(),
            to: Some(contract.to_string()),
            amount: 0,
            nonce: 1,
            timestamp: 0,
            gas_price: 1,
            gas_limit: 1_000_000, // ContractCall base gas is ~100k; give ample headroom
            data: Some(format!("{{\"method\":\"{}\",\"args\":{}}}", method, args_json)),
            signature: None,
            public_key: None,
            tx_type: TransactionType::ContractCall,
            dilithium_signature: None,
            dilithium_public_key: None,
            chain_id: 0,
        };
        tx.hash = tx.calculate_hash();
        tx
    }

    fn seed(sender: &str, contract: &str, start_bal: u64) -> HashMap<String, Account> {
        let mut accounts: HashMap<String, Account> = HashMap::new();
        let mut s = Account::default();
        s.balance = 100_000_000; // covers the gas fee (gas_price * gas_limit)
        s.nonce = 0;
        accounts.insert(sender.to_string(), s);
        let mut c = Account::default();
        c.is_contract = true;
        c.contract_storage.insert("type".to_string(), "qrc20".to_string());
        c.contract_storage.insert(format!("balance:{}", sender), start_bal.to_string());
        accounts.insert(contract.to_string(), c);
        accounts
    }

    fn bal(accounts: &HashMap<String, Account>, contract: &str, holder: &str) -> u64 {
        accounts.get(contract).unwrap().contract_storage
            .get(&format!("balance:{}", holder))
            .and_then(|s| s.parse().ok()).unwrap_or(0)
    }

    #[test]
    fn qrc20_self_transfer_does_not_mint() {
        let (sender, contract) = ("alice", "tokenX");
        let mut accounts = seed(sender, contract, 1000);
        // transfer(to = alice, 500) — a self-transfer.
        let tx = qrc20_call(sender, contract, "transfer", &format!("[\"{}\",500]", sender));
        tx.apply_to_state(&mut accounts).expect("self-transfer applies (balance no-op)");
        assert_eq!(bal(&accounts, contract, sender), 1000, "self-transfer must NOT mint (TVC-1)");
    }

    #[test]
    fn qrc20_transferfrom_self_does_not_mint() {
        let (sender, contract) = ("alice", "tokenX");
        let mut accounts = seed(sender, contract, 1000);
        // alice approves alice for 500.
        accounts.get_mut(contract).unwrap().contract_storage
            .insert(format!("allowance:{}:{}", sender, sender), "500".to_string());
        // transferFrom(from = alice, to = alice, 500) — self-transfer via allowance.
        let tx = qrc20_call(sender, contract, "transferFrom", &format!("[\"{}\",\"{}\",500]", sender, sender));
        tx.apply_to_state(&mut accounts).expect("self transferFrom applies (balance no-op)");
        assert_eq!(bal(&accounts, contract, sender), 1000, "self transferFrom must NOT mint (TVC-2)");
        let allow: u64 = accounts.get(contract).unwrap().contract_storage
            .get(&format!("allowance:{}:{}", sender, sender))
            .and_then(|s| s.parse().ok()).unwrap_or(999);
        assert_eq!(allow, 0, "allowance must still be consumed on self transferFrom");
    }

    #[test]
    fn qrc20_normal_transfer_still_moves_balance() {
        let (sender, contract, bob) = ("alice", "tokenX", "bob");
        let mut accounts = seed(sender, contract, 1000);
        let tx = qrc20_call(sender, contract, "transfer", &format!("[\"{}\",500]", bob));
        tx.apply_to_state(&mut accounts).expect("normal transfer applies");
        assert_eq!(bal(&accounts, contract, sender), 500, "sender debited");
        assert_eq!(bal(&accounts, contract, bob), 500, "recipient credited");
    }

    // Reserved escrow id must NOT be a valid user sender, so no user can own/derive it.
    #[test]
    fn storage_escrow_addr_is_not_a_user_sender() {
        assert!(!is_valid_sender_format(STORAGE_RENT_ESCROW_ADDR),
            "escrow id must be unownable by any user");
    }

    // New recipient entry ⇒ refundable deposit MOVES sender→escrow (conservation, no mint/burn).
    #[test]
    fn new_entry_charges_refundable_deposit_to_escrow() {
        let (sender, contract, bob) = ("alice", "tokenX", "bob");
        let mut accounts = seed(sender, contract, 1000);
        let native_before = accounts.get(sender).unwrap().balance;
        let tx = qrc20_call(sender, contract, "transfer", &format!("[\"{}\",500]", bob));
        tx.apply_to_state(&mut accounts).expect("transfer applies");
        let gas = 1_000_000u64; // gas_price(1) * gas_limit(1_000_000)
        let sender_native = accounts.get(sender).unwrap().balance;
        assert_eq!(sender_native, native_before - gas - STORAGE_DEPOSIT_PER_ENTRY_NANO_QNC,
            "sender pays gas + one storage deposit");
        assert_eq!(accounts.get(STORAGE_RENT_ESCROW_ADDR).unwrap().balance,
            STORAGE_DEPOSIT_PER_ENTRY_NANO_QNC, "escrow holds the deposit");
    }

    // Draining a balance to zero REMOVES the key (no "0" residue) and refunds the deposit.
    #[test]
    fn zeroed_balance_is_removed_and_deposit_refunded() {
        let (sender, contract, bob) = ("alice", "tokenX", "bob");
        let mut accounts = seed(sender, contract, 500);
        // alice sends her entire 500 to a new holder bob: alice's balance entry hits 0.
        let tx = qrc20_call(sender, contract, "transfer", &format!("[\"{}\",500]", bob));
        tx.apply_to_state(&mut accounts).expect("full-drain transfer applies");
        let store = &accounts.get(contract).unwrap().contract_storage;
        assert!(!store.contains_key(&format!("balance:{}", sender)),
            "emptied sender balance key is removed, not left as 0");
        // +1 deposit for new bob, -1 refund for emptied alice ⇒ escrow nets to zero.
        assert_eq!(accounts.get(STORAGE_RENT_ESCROW_ADDR).unwrap().balance, 0,
            "new-entry deposit and drained-entry refund cancel");
    }

    // Insufficient native balance for the deposit rejects fail-loud (no partial state write).
    #[test]
    fn insufficient_deposit_rejects() {
        let (sender, contract, bob) = ("alice", "tokenX", "bob");
        let mut accounts = seed(sender, contract, 1000);
        // Leave only enough to cover gas, not the deposit.
        accounts.get_mut(sender).unwrap().balance = 1_000_000;
        let tx = qrc20_call(sender, contract, "transfer", &format!("[\"{}\",500]", bob));
        let err = tx.apply_to_state(&mut accounts).unwrap_err();
        assert!(format!("{:?}", err).contains("insufficient_deposit"),
            "must reject with insufficient_deposit, got {:?}", err);
    }

    // apply_transaction_lazy loads only get_all_affected_addresses into its working set; the escrow
    // MUST be among them or the merge-back clobbers accrued deposits (native-QNC conservation break).
    #[test]
    fn contractcall_affected_addresses_include_escrow() {
        let tx = qrc20_call("alice", "tokenX", "transfer", "[\"bob\",500]");
        let affected = tx.get_all_affected_addresses();
        assert!(affected.iter().any(|a| a == STORAGE_RENT_ESCROW_ADDR),
            "ContractCall affected set must include the storage-rent escrow, got: {:?}", affected);
    }

    // Reproduce the lazy path (filter by affected addresses -> apply -> merge back) and prove the
    // escrow ACCUMULATES the new deposit on top of prior deposits instead of being clobbered.
    #[test]
    fn lazy_path_accumulates_escrow_not_clobbers() {
        let (sender, contract, bob) = ("alice", "tokenX", "bob");
        let mut full = seed(sender, contract, 1000);
        let prior = 3 * STORAGE_DEPOSIT_PER_ENTRY_NANO_QNC; // escrow already holds 3 earlier deposits
        let mut esc = Account::default();
        esc.balance = prior;
        full.insert(STORAGE_RENT_ESCROW_ADDR.to_string(), esc);

        let tx = qrc20_call(sender, contract, "transfer", &format!("[\"{}\",500]", bob));
        let mut working: HashMap<String, Account> = tx.get_all_affected_addresses().into_iter()
            .filter_map(|a| full.get(&a).map(|acc| (a, acc.clone()))).collect();
        tx.apply_to_state(&mut working).expect("transfer applies");
        for (a, acc) in working { full.insert(a, acc); } // merge-back, mirrors apply_transaction_lazy

        assert_eq!(full.get(STORAGE_RENT_ESCROW_ADDR).unwrap().balance,
            prior + STORAGE_DEPOSIT_PER_ENTRY_NANO_QNC,
            "escrow must accumulate the new deposit on top of prior deposits (no clobber)");
    }

    // ---- deploy-time deposit (audit #1/#6) + reserved fuel (audit #2) ----

    // Build a QRC-20 ContractDeploy tx (contract address is derived from from+nonce).
    fn qrc20_deploy(deployer: &str, initial_supply: u64) -> Transaction {
        let mut tx = Transaction {
            hash: String::new(),
            from: deployer.to_string(),
            to: None,
            amount: 0,
            nonce: 1,
            timestamp: 0,
            gas_price: 1,
            gas_limit: 1_000_000,
            data: Some(format!(
                "{{\"qrc20\":true,\"name\":\"T\",\"symbol\":\"T\",\"decimals\":9,\"initial_supply\":{}}}",
                initial_supply)),
            signature: None,
            public_key: None,
            tx_type: TransactionType::ContractDeploy,
            dilithium_signature: None,
            dilithium_public_key: None,
            chain_id: 0,
        };
        tx.hash = tx.calculate_hash();
        tx
    }

    fn seed_deployer(deployer: &str) -> HashMap<String, Account> {
        let mut accounts: HashMap<String, Account> = HashMap::new();
        let mut d = Account::default();
        d.balance = 100_000_000;
        d.nonce = 0;
        accounts.insert(deployer.to_string(), d);
        accounts
    }

    // #1 FIX: the QRC-20 deploy-time creator balance entry is now CHARGED a refundable deposit, so it
    // can never later drain the shared escrow it never paid into.
    #[test]
    fn qrc20_deploy_charges_deployer_balance_deposit() {
        let deployer = "alice";
        let mut accounts = seed_deployer(deployer);
        qrc20_deploy(deployer, 1000).apply_to_state(&mut accounts).expect("qrc20 deploy applies");
        let contract_addr = derive_contract_address(deployer, 1);
        assert_eq!(bal(&accounts, &contract_addr, deployer), 1000, "creator holds initial supply");
        assert_eq!(accounts.get(STORAGE_RENT_ESCROW_ADDR).unwrap().balance,
            STORAGE_DEPOSIT_PER_ENTRY_NANO_QNC, "deploy charges one storage deposit for the creator entry");
        assert_eq!(accounts.get(deployer).unwrap().balance,
            100_000_000 - 1_000_000 - STORAGE_DEPOSIT_PER_ENTRY_NANO_QNC,
            "deployer debited deploy fee + one storage deposit");
    }

    // ROOT GUARD: a ContractDeploy touches the escrow (deposit move), so it MUST be in the lazy
    // working set — else merge-back clobbers the real escrow, burning every other contract's deposits.
    #[test]
    fn contract_deploy_affected_set_includes_escrow() {
        let affected = qrc20_deploy("alice", 1000).get_all_affected_addresses();
        assert!(affected.iter().any(|a| a == STORAGE_RENT_ESCROW_ADDR),
            "deploy must preload the escrow so lazy merge-back cannot clobber accrued deposits");
    }

    // A zero-supply deploy creates NO balance entry and therefore charges NO deposit.
    #[test]
    fn qrc20_deploy_zero_supply_no_entry_no_charge() {
        let deployer = "alice";
        let mut accounts = seed_deployer(deployer);
        qrc20_deploy(deployer, 0).apply_to_state(&mut accounts).expect("zero-supply deploy applies");
        let contract_addr = derive_contract_address(deployer, 1);
        assert!(!accounts.get(&contract_addr).unwrap().contract_storage
            .contains_key(&format!("balance:{}", deployer)), "no balance entry for zero supply");
        assert!(accounts.get(STORAGE_RENT_ESCROW_ADDR).map(|a| a.balance).unwrap_or(0) == 0,
            "zero-supply deploy charges no deposit");
    }

    // Owns-index deltas track live holdings: Set on a 0→nonzero balance (deploy seed, new recipient),
    // Clear on a nonzero→0 drain; a partial transfer to an existing holder emits neither.
    #[test]
    fn qrc20_owns_deltas_track_live_holdings() {
        let (alice, bob) = ("alice", "bob");
        let mut accounts = seed_deployer(alice);
        let contract = derive_contract_address(alice, 1);
        let mut owns: Vec<OwnsDelta> = Vec::new();

        // Deploy seeds the creator with full supply → Set{alice}.
        qrc20_deploy(alice, 1000).apply_to_state_at_indexed(&mut accounts, 0, &mut owns).unwrap();
        match owns.last().expect("deploy emits an owns-delta") {
            OwnsDelta::Set { wallet, contract: c } => {
                assert_eq!(wallet.as_str(), alice);
                assert_eq!(c, &contract);
            }
            _ => panic!("deploy should Set the deployer"),
        }

        // Deploy consumed nonce 1; subsequent transfers use 2, 3 (else the idempotent-apply nonce gate
        // treats them as replays and no-ops). Recompute the hash after stamping the nonce.
        let mkxfer = |nonce: u64, amt: &str| {
            let mut t = qrc20_call(alice, &contract, "transfer", &format!("[\"{}\",\"{}\"]", bob, amt));
            t.nonce = nonce;
            t.hash = t.calculate_hash();
            t
        };

        // Transfer 400 alice→bob: bob is a NEW holder → exactly one Set{bob}; alice keeps 600 (no Clear).
        owns.clear();
        mkxfer(2, "400").apply_to_state_at_indexed(&mut accounts, 0, &mut owns).unwrap();
        assert_eq!(owns.len(), 1, "new-recipient transfer emits one delta");
        match &owns[0] {
            OwnsDelta::Set { wallet, .. } => assert_eq!(wallet.as_str(), bob),
            _ => panic!("new recipient should Set"),
        }

        // Transfer remaining 600 alice→bob: drains alice → exactly one Clear{alice}; bob already holds (no Set).
        owns.clear();
        mkxfer(3, "600").apply_to_state_at_indexed(&mut accounts, 0, &mut owns).unwrap();
        assert_eq!(owns.len(), 1, "drain emits one delta");
        match &owns[0] {
            OwnsDelta::Clear { wallet, .. } => assert_eq!(wallet.as_str(), alice),
            _ => panic!("drained sender should Clear"),
        }

        assert_eq!(bal(&accounts, &contract, alice), 0, "alice fully drained");
        assert_eq!(bal(&accounts, &contract, bob), 1000, "bob holds all supply");
    }

    // End-to-end conservation: deploy (1 deposit) → creator drains ALL to a NEW holder → creator entry
    // removed+refunded, new holder charged → escrow still backs exactly the one surviving entry, and
    // the drain refund NEVER trips the underfunded guard (the deploy deposit funded it).
    #[test]
    fn qrc20_deploy_then_full_drain_keeps_escrow_backed() {
        let (deployer, bob) = ("alice", "bob");
        let mut accounts = seed_deployer(deployer);
        qrc20_deploy(deployer, 1000).apply_to_state(&mut accounts).expect("deploy applies");
        let contract_addr = derive_contract_address(deployer, 1);
        assert_eq!(accounts.get(STORAGE_RENT_ESCROW_ADDR).unwrap().balance,
            STORAGE_DEPOSIT_PER_ENTRY_NANO_QNC, "deploy funded one deposit");
        // creator sends the ENTIRE supply to bob (nonce 2): creator entry drains to 0 (removed+refund),
        // bob entry is new (charge). Escrow nets to exactly one deposit — bob's surviving entry.
        let mut xfer = qrc20_call(deployer, &contract_addr, "transfer", &format!("[\"{}\",1000]", bob));
        xfer.nonce = 2; xfer.hash = xfer.calculate_hash();
        xfer.apply_to_state(&mut accounts).expect("full-drain transfer applies (refund funded)");
        assert!(!accounts.get(&contract_addr).unwrap().contract_storage
            .contains_key(&format!("balance:{}", deployer)), "drained creator entry removed");
        assert_eq!(bal(&accounts, &contract_addr, bob), 1000, "bob holds the supply");
        assert_eq!(accounts.get(STORAGE_RENT_ESCROW_ADDR).unwrap().balance,
            STORAGE_DEPOSIT_PER_ENTRY_NANO_QNC, "escrow backs exactly the one surviving entry");
    }

    // #6 FIX: refunding against an under-funded escrow is a conservation-invariant violation and must
    // fail LOUD (deterministic on every node), not silently pay less.
    #[test]
    fn refund_storage_deposit_underfunded_fails_loud() {
        let mut accounts: HashMap<String, Account> = HashMap::new();
        let err = refund_storage_deposit(&mut accounts, "bob", 1).unwrap_err();
        assert!(format!("{:?}", err).contains("escrow_underfunded"),
            "under-funded refund must fail loud, got {:?}", err);
    }

    // #2 FIX: reserved_fuel() = the fuel a metered ContractCall may burn (gas_limit - intrinsic), ZERO
    // for every non-VM type. This is the pure, per-node-identical unit the block ceiling sums.
    #[test]
    fn reserved_fuel_contractcall_is_gaslimit_minus_intrinsic() {
        let call = qrc20_call("alice", "tokenX", "transfer", "[\"bob\",1]");
        assert_eq!(call.reserved_fuel(), call.gas_limit - call.compute_gas_used(),
            "reserved fuel is gas_limit minus the intrinsic");
        assert!(call.reserved_fuel() > 0, "a headroom call reserves fuel");
    }

    #[test]
    fn reserved_fuel_zero_for_non_contractcall() {
        assert_eq!(qrc20_deploy("alice", 1000).reserved_fuel(), 0, "ContractDeploy reserves no fuel");
    }

    // METERED-FEE CONSERVATION (audit #2 economics): a WASM call is billed for the fuel it actually
    // burned. The fee is a symmetric account MOVE — the sender's gas refund drops by fuel*price and the
    // producer's credit rises by fuel*price — so what the sender pays EQUALS what the producer receives
    // (total supply unchanged), and the sender pays exactly (intrinsic + consumed fuel) * price.
    #[test]
    fn metered_fee_conservation_wasm_call() {
        let call = qrc20_call("alice", "tokenX", "run", "[]"); // ContractCall, gas_limit=1M, gas_price=1
        let fuel = 500_000u64;
        let price = call.effective_gas_price();
        let intrinsic = call.compute_gas_used();
        // Sender prepays gas_limit*price upfront; the metered refund is the flat refund minus the fuel fee.
        let metered_refund = call.compute_gas_refund().saturating_sub(call.wasm_fuel_fee(fuel));
        let sender_paid = price.saturating_mul(call.gas_limit) - metered_refund;
        // Producer receives the flat intrinsic fee + the metered fuel fee.
        let producer_credit = price.saturating_mul(intrinsic) + call.wasm_fuel_fee(fuel);
        assert_eq!(sender_paid, producer_credit,
            "metered fee: the sender pays EXACTLY what the producer receives (conservation)");
        assert_eq!(sender_paid, (intrinsic + fuel).saturating_mul(price),
            "sender pays for intrinsic + actually-consumed fuel");
    }

    // With zero fuel (every non-WASM tx, and a WASM call that burned nothing), the metered fee collapses
    // to the existing flat behaviour — no refund reduction, no extra producer credit.
    #[test]
    fn metered_fee_zero_fuel_is_flat() {
        let call = qrc20_call("alice", "tokenX", "transfer", "[\"bob\",1]");
        assert_eq!(call.wasm_fuel_fee(0), 0, "no fuel ⇒ no compute fee");
        assert_eq!(call.compute_gas_refund().saturating_sub(call.wasm_fuel_fee(0)),
            call.compute_gas_refund(), "zero-fuel refund equals the flat refund");
    }

    // ---- mint / burn / unknown-method ----

    // Extend a seeded qrc20 contract with the fields mint/burn read: deployer, total_supply,
    // and the opt-in mintable/burnable flags. `seed` gives the deployer `start_bal` tokens.
    fn seed_mintburn(
        sender: &str, contract: &str, start_bal: u64, mintable: bool, burnable: bool,
    ) -> HashMap<String, Account> {
        let mut accounts = seed(sender, contract, start_bal);
        let store = &mut accounts.get_mut(contract).unwrap().contract_storage;
        store.insert("deployer".to_string(), sender.to_string());
        store.insert("total_supply".to_string(), start_bal.to_string());
        store.insert("mintable".to_string(), mintable.to_string());
        store.insert("burnable".to_string(), burnable.to_string());
        accounts
    }

    fn total_supply(accounts: &HashMap<String, Account>, contract: &str) -> u64 {
        accounts.get(contract).unwrap().contract_storage
            .get("total_supply").and_then(|s| s.parse().ok()).unwrap_or(0)
    }

    #[test]
    fn mint_by_owner_increases_supply_and_balance() {
        let (owner, contract, bob) = ("alice", "tokenX", "bob");
        let mut accounts = seed_mintburn(owner, contract, 1000, true, false);
        let tx = qrc20_call(owner, contract, "mint", &format!("[\"{}\",250]", bob));
        tx.apply_to_state(&mut accounts).expect("owner mint applies");
        assert_eq!(bal(&accounts, contract, bob), 250, "recipient credited minted amount");
        assert_eq!(total_supply(&accounts, contract), 1250, "supply bumped 1:1 with mint");
    }

    #[test]
    fn mint_by_non_owner_rejected() {
        let (owner, contract, mallory) = ("alice", "tokenX", "mallory");
        let mut accounts = seed_mintburn(owner, contract, 1000, true, false);
        // Fund mallory so the tx passes fee/nonce checks and reaches the owner gate.
        let mut m = Account::default();
        m.balance = 100_000_000;
        accounts.insert(mallory.to_string(), m);
        let tx = qrc20_call(mallory, contract, "mint", &format!("[\"{}\",250]", mallory));
        let err = tx.apply_to_state(&mut accounts).unwrap_err();
        assert!(format!("{:?}", err).contains("mint_not_owner"),
            "non-owner mint must reject, got {:?}", err);
        assert_eq!(total_supply(&accounts, contract), 1000, "supply unchanged on rejected mint");
    }

    #[test]
    fn mint_on_non_mintable_rejected() {
        let (owner, contract, bob) = ("alice", "tokenX", "bob");
        let mut accounts = seed_mintburn(owner, contract, 1000, false, false);
        let tx = qrc20_call(owner, contract, "mint", &format!("[\"{}\",250]", bob));
        let err = tx.apply_to_state(&mut accounts).unwrap_err();
        assert!(format!("{:?}", err).contains("mint_disabled"),
            "mint on non-mintable token must reject, got {:?}", err);
        assert_eq!(total_supply(&accounts, contract), 1000, "supply unchanged on rejected mint");
    }

    #[test]
    fn burn_reduces_supply_and_balance() {
        let (owner, contract) = ("alice", "tokenX");
        let mut accounts = seed_mintburn(owner, contract, 1000, false, true);
        let tx = qrc20_call(owner, contract, "burn", "[300]");
        tx.apply_to_state(&mut accounts).expect("burn applies");
        assert_eq!(bal(&accounts, contract, owner), 700, "burner debited own balance");
        assert_eq!(total_supply(&accounts, contract), 700, "supply reduced 1:1 with burn");
    }

    #[test]
    fn burn_more_than_balance_rejected() {
        let (owner, contract) = ("alice", "tokenX");
        let mut accounts = seed_mintburn(owner, contract, 1000, false, true);
        let tx = qrc20_call(owner, contract, "burn", "[2000]");
        let err = tx.apply_to_state(&mut accounts).unwrap_err();
        assert!(format!("{:?}", err).contains("insufficient_balance"),
            "burning more than balance must reject, got {:?}", err);
        assert_eq!(total_supply(&accounts, contract), 1000, "supply unchanged on rejected burn");
    }

    #[test]
    fn burn_on_non_burnable_rejected() {
        let (owner, contract) = ("alice", "tokenX");
        let mut accounts = seed_mintburn(owner, contract, 1000, false, false);
        let tx = qrc20_call(owner, contract, "burn", "[300]");
        let err = tx.apply_to_state(&mut accounts).unwrap_err();
        assert!(format!("{:?}", err).contains("burn_disabled"),
            "burn on non-burnable token must reject, got {:?}", err);
        assert_eq!(total_supply(&accounts, contract), 1000, "supply unchanged on rejected burn");
    }

    #[test]
    fn unknown_qrc20_method_rejected() {
        let (owner, contract) = ("alice", "tokenX");
        let mut accounts = seed_mintburn(owner, contract, 1000, false, false);
        let tx = qrc20_call(owner, contract, "frobnicate", "[1]");
        let err = tx.apply_to_state(&mut accounts).unwrap_err();
        assert!(format!("{:?}", err).contains("unknown_method"),
            "unknown method must fail-loud, got {:?}", err);
    }

    // ---- QRC-20 string-amount (kill the >2^53 JS-float limit) ----

    #[test]
    fn qrc20_transfer_accepts_string_amount() {
        // A value > 2^53 that a JS number cannot represent exactly. As a STRING it round-trips.
        let (sender, contract, bob) = ("alice", "tokenX", "bob");
        let big: u64 = 10_000_000_000_000_000_000; // ~1e19, > 2^53
        let mut accounts = seed(sender, contract, 0);
        // seed writes balance as u64 string; overwrite with the big start balance exactly.
        accounts.get_mut(contract).unwrap().contract_storage
            .insert(format!("balance:{}", sender), big.to_string());
        // args amount sent as a JSON STRING.
        let tx = qrc20_call(sender, contract, "transfer", &format!("[\"{}\",\"{}\"]", bob, big));
        tx.apply_to_state(&mut accounts).expect("string amount transfer applies");
        assert_eq!(bal(&accounts, contract, bob), big, "recipient gets exact >2^53 amount");
        assert_eq!(bal(&accounts, contract, sender), 0, "sender fully debited");
    }

    #[test]
    fn qrc20_transfer_accepts_number_amount() {
        // Small amount as a JSON number stays valid (unchanged behavior).
        let (sender, contract, bob) = ("alice", "tokenX", "bob");
        let mut accounts = seed(sender, contract, 1000);
        let tx = qrc20_call(sender, contract, "transfer", &format!("[\"{}\",500]", bob));
        tx.apply_to_state(&mut accounts).expect("number amount transfer applies");
        assert_eq!(bal(&accounts, contract, bob), 500, "recipient credited");
        assert_eq!(bal(&accounts, contract, sender), 500, "sender debited");
    }

    #[test]
    fn qrc20_bad_amount_arg_rejected() {
        // A non-numeric string is neither a number nor a parseable u64 ⇒ fail-loud.
        let (sender, contract, bob) = ("alice", "tokenX", "bob");
        let mut accounts = seed(sender, contract, 1000);
        let tx = qrc20_call(sender, contract, "transfer", &format!("[\"{}\",\"notanumber\"]", bob));
        let err = tx.apply_to_state(&mut accounts).unwrap_err();
        assert!(format!("{:?}", err).contains("bad_amount_arg"),
            "non-numeric amount must reject, got {:?}", err);
        assert_eq!(bal(&accounts, contract, sender), 1000, "balance unchanged on rejected transfer");
    }

    // ---- QRC-721 (NFT) ----

    // Seed a qrc721 contract with `deployer` set + fund a caller with nonce=0 (qrc20_call sends nonce=1).
    fn seed_nft(deployer: &str, contract: &str) -> HashMap<String, Account> {
        let mut accounts: HashMap<String, Account> = HashMap::new();
        let mut d = Account::default();
        d.balance = 100_000_000;
        d.nonce = 0;
        accounts.insert(deployer.to_string(), d);
        let mut c = Account::default();
        c.is_contract = true;
        c.contract_storage.insert("type".to_string(), "qrc721".to_string());
        c.contract_storage.insert("deployer".to_string(), deployer.to_string());
        accounts.insert(contract.to_string(), c);
        accounts
    }

    fn fund(accounts: &mut HashMap<String, Account>, who: &str) {
        let mut a = Account::default();
        a.balance = 100_000_000;
        a.nonce = 0;
        accounts.insert(who.to_string(), a);
    }

    fn owner_of(accounts: &HashMap<String, Account>, contract: &str, token_id: &str) -> Option<String> {
        accounts.get(contract).unwrap().contract_storage
            .get(&format!("owner:{}", token_id)).cloned()
    }

    fn nft_count(accounts: &HashMap<String, Account>, contract: &str, holder: &str) -> u64 {
        accounts.get(contract).unwrap().contract_storage
            .get(&format!("bal:{}", holder))
            .and_then(|s| s.parse().ok()).unwrap_or(0)
    }

    #[test]
    fn nft_mint_by_owner_sets_owner() {
        let (owner, contract, bob) = ("alice", "nftX", "bob");
        let mut accounts = seed_nft(owner, contract);
        // token_id is a STRING.
        let tx = qrc20_call(owner, contract, "mint", &format!("[\"{}\",\"tok1\"]", bob));
        tx.apply_to_state(&mut accounts).expect("owner mint applies");
        assert_eq!(owner_of(&accounts, contract, "tok1").as_deref(), Some(bob), "owner set to `to`");
        assert_eq!(nft_count(&accounts, contract, bob), 1, "holder count incremented");
    }

    #[test]
    fn nft_mint_non_owner_rejected() {
        let (owner, contract, mallory) = ("alice", "nftX", "mallory");
        let mut accounts = seed_nft(owner, contract);
        fund(&mut accounts, mallory); // pass fee/nonce checks to reach the owner gate
        let tx = qrc20_call(mallory, contract, "mint", &format!("[\"{}\",\"tok1\"]", mallory));
        let err = tx.apply_to_state(&mut accounts).unwrap_err();
        assert!(format!("{:?}", err).contains("mint_not_owner"),
            "non-owner mint must reject, got {:?}", err);
        assert!(owner_of(&accounts, contract, "tok1").is_none(), "no token minted on reject");
    }

    #[test]
    fn nft_mint_duplicate_rejected() {
        let (owner, contract, bob) = ("alice", "nftX", "bob");
        let mut accounts = seed_nft(owner, contract);
        let tx1 = qrc20_call(owner, contract, "mint", &format!("[\"{}\",\"tok1\"]", bob));
        tx1.apply_to_state(&mut accounts).expect("first mint applies");
        // Second mint of the same token_id: qrc20_call uses nonce=1, so bump owner's nonce back down
        // is not needed — build a fresh tx with the next nonce.
        let mut tx2 = qrc20_call(owner, contract, "mint", &format!("[\"{}\",\"tok1\"]", "carol"));
        tx2.nonce = 2;
        tx2.hash = tx2.calculate_hash();
        let err = tx2.apply_to_state(&mut accounts).unwrap_err();
        assert!(format!("{:?}", err).contains("already_minted"),
            "re-mint of existing token_id must reject, got {:?}", err);
        assert_eq!(owner_of(&accounts, contract, "tok1").as_deref(), Some(bob),
            "original owner unchanged after rejected re-mint");
    }

    #[test]
    fn nft_transfer_by_owner_moves_and_clears_approval() {
        let (owner, contract, bob) = ("alice", "nftX", "bob");
        let mut accounts = seed_nft(owner, contract);
        // Mint tok1 to alice (the owner), approve carol, then transfer to bob.
        let m = qrc20_call(owner, contract, "mint", &format!("[\"{}\",\"tok1\"]", owner));
        m.apply_to_state(&mut accounts).expect("mint applies");
        let mut ap = qrc20_call(owner, contract, "approve", "[\"carol\",\"tok1\"]");
        ap.nonce = 2; ap.hash = ap.calculate_hash();
        ap.apply_to_state(&mut accounts).expect("approve applies");
        assert_eq!(accounts.get(contract).unwrap().contract_storage
            .get("approved:tok1").map(|s| s.as_str()), Some("carol"), "approval set");

        let mut tr = qrc20_call(owner, contract, "transfer", &format!("[\"{}\",\"tok1\"]", bob));
        tr.nonce = 3; tr.hash = tr.calculate_hash();
        tr.apply_to_state(&mut accounts).expect("transfer applies");
        assert_eq!(owner_of(&accounts, contract, "tok1").as_deref(), Some(bob), "owner moved to bob");
        assert_eq!(nft_count(&accounts, contract, owner), 0, "sender count drops to 0");
        assert_eq!(nft_count(&accounts, contract, bob), 1, "recipient count is 1");
        assert!(!accounts.get(contract).unwrap().contract_storage.contains_key("approved:tok1"),
            "approval cleared on transfer");
    }

    // ---- Canonical burn address ----

    #[test]
    fn canonical_burn_addr_is_valid_eon() {
        assert!(is_valid_eon_address(CANONICAL_BURN_ADDR),
            "burn address must be a valid checksummed EON so transfers to it are never rejected");
        assert_eq!(CANONICAL_BURN_ADDR.len(), 45);
    }

    // QRC-20 transfer to the burn address is a REAL burn even for a NON-burnable token (no "burnable"
    // flag): reduces total_supply, bumps total_burned, never credits the sink.
    #[test]
    fn qrc20_transfer_to_burn_reduces_supply() {
        let (alice, contract) = ("alice", "tokenX");
        let mut accounts = seed(alice, contract, 1000);
        {
            let cs = &mut accounts.get_mut(contract).unwrap().contract_storage;
            cs.insert("total_supply".into(), "1000".into());
            cs.insert("total_burned".into(), "0".into());
        }
        let tx = qrc20_call(alice, contract, "transfer", &format!("[\"{}\",300]", CANONICAL_BURN_ADDR));
        tx.apply_to_state(&mut accounts).expect("transfer-to-burn applies");
        assert_eq!(bal(&accounts, contract, alice), 700, "holder debited by burn");
        assert_eq!(bal(&accounts, contract, CANONICAL_BURN_ADDR), 0, "sink never credited");
        let cs = &accounts.get(contract).unwrap().contract_storage;
        assert_eq!(cs.get("total_supply").map(|s| s.as_str()), Some("700"), "supply reduced");
        assert_eq!(cs.get("total_burned").map(|s| s.as_str()), Some("300"), "burned increased");
        assert!(!cs.contains_key(&format!("balance:{}", CANONICAL_BURN_ADDR)), "no sink balance entry");
    }

    // QRC-20 transferFrom to burn consumes allowance AND reduces supply.
    #[test]
    fn qrc20_transferfrom_to_burn_consumes_allowance_and_burns() {
        let (owner, spender, contract) = ("alice", "bob", "tokenX");
        let mut accounts = seed(owner, contract, 1000);
        fund(&mut accounts, spender);
        {
            let cs = &mut accounts.get_mut(contract).unwrap().contract_storage;
            cs.insert("total_supply".into(), "1000".into());
            cs.insert("total_burned".into(), "0".into());
            cs.insert(format!("allowance:{}:{}", owner, spender), "500".into());
        }
        let tx = qrc20_call(spender, contract, "transferFrom", &format!("[\"{}\",\"{}\",300]", owner, CANONICAL_BURN_ADDR));
        tx.apply_to_state(&mut accounts).expect("transferFrom-to-burn applies");
        assert_eq!(bal(&accounts, contract, owner), 700, "owner debited");
        let cs = &accounts.get(contract).unwrap().contract_storage;
        assert_eq!(cs.get("total_supply").map(|s| s.as_str()), Some("700"), "supply reduced");
        assert_eq!(cs.get("total_burned").map(|s| s.as_str()), Some("300"), "burned increased");
        assert_eq!(cs.get(&format!("allowance:{}:{}", owner, spender)).map(|s| s.as_str()), Some("200"), "allowance consumed");
        assert!(!cs.contains_key(&format!("balance:{}", CANONICAL_BURN_ADDR)), "no sink balance entry");
    }

    // Mint-to-burn is rejected (would strand credit at the sink un-burned) — both standards.
    #[test]
    fn mint_to_burn_address_rejected() {
        let (alice, contract) = ("alice", "tokenX");
        let mut accounts = seed(alice, contract, 1000);
        {
            let cs = &mut accounts.get_mut(contract).unwrap().contract_storage;
            cs.insert("mintable".into(), "true".into());
            cs.insert("deployer".into(), alice.into());
            cs.insert("total_supply".into(), "1000".into());
        }
        let tx = qrc20_call(alice, contract, "mint", &format!("[\"{}\",100]", CANONICAL_BURN_ADDR));
        let err = tx.apply_to_state(&mut accounts).unwrap_err();
        assert!(format!("{:?}", err).contains("mint_to_burn_address"), "qrc20 mint-to-burn must reject, got {:?}", err);

        let (owner, nft) = ("bob", "nftY");
        let mut accounts = seed_nft(owner, nft);
        let m = qrc20_call(owner, nft, "mint", &format!("[\"{}\",\"tok1\"]", CANONICAL_BURN_ADDR));
        let err = m.apply_to_state(&mut accounts).unwrap_err();
        assert!(format!("{:?}", err).contains("mint_to_burn_address"), "nft mint-to-burn must reject, got {:?}", err);
        assert!(owner_of(&accounts, nft, "tok1").is_none(), "no token minted on reject");
    }

    // QRC-721 transfer to burn destroys the token (owner:{id} removed) — it can no longer move.
    #[test]
    fn nft_transfer_to_burn_destroys_token() {
        let (owner, contract) = ("alice", "nftX");
        let mut accounts = seed_nft(owner, contract);
        let m = qrc20_call(owner, contract, "mint", &format!("[\"{}\",\"tok1\"]", owner));
        m.apply_to_state(&mut accounts).expect("mint applies");
        let mut tr = qrc20_call(owner, contract, "transfer", &format!("[\"{}\",\"tok1\"]", CANONICAL_BURN_ADDR));
        tr.nonce = 2; tr.hash = tr.calculate_hash();
        tr.apply_to_state(&mut accounts).expect("transfer-to-burn applies");
        assert!(owner_of(&accounts, contract, "tok1").is_none(), "token destroyed (owner removed)");
        assert_eq!(nft_count(&accounts, contract, owner), 0, "holder count drops to 0");
        assert_eq!(nft_count(&accounts, contract, CANONICAL_BURN_ADDR), 0, "sink never holds the token");
    }

    #[test]
    fn nft_transfer_non_owner_rejected() {
        let (owner, contract, mallory, bob) = ("alice", "nftX", "mallory", "bob");
        let mut accounts = seed_nft(owner, contract);
        fund(&mut accounts, mallory);
        let m = qrc20_call(owner, contract, "mint", &format!("[\"{}\",\"tok1\"]", owner));
        m.apply_to_state(&mut accounts).expect("mint applies");
        // mallory (not the owner) tries to transfer tok1.
        let tx = qrc20_call(mallory, contract, "transfer", &format!("[\"{}\",\"tok1\"]", bob));
        let err = tx.apply_to_state(&mut accounts).unwrap_err();
        assert!(format!("{:?}", err).contains("not_owner"),
            "non-owner transfer must reject, got {:?}", err);
        assert_eq!(owner_of(&accounts, contract, "tok1").as_deref(), Some(owner),
            "owner unchanged on rejected transfer");
    }

    #[test]
    fn nft_approve_then_transfer_from_by_spender() {
        let (owner, contract, spender, bob) = ("alice", "nftX", "spender", "bob");
        let mut accounts = seed_nft(owner, contract);
        fund(&mut accounts, spender);
        let m = qrc20_call(owner, contract, "mint", &format!("[\"{}\",\"tok1\"]", owner));
        m.apply_to_state(&mut accounts).expect("mint applies");
        let mut ap = qrc20_call(owner, contract, "approve", &format!("[\"{}\",\"tok1\"]", spender));
        ap.nonce = 2; ap.hash = ap.calculate_hash();
        ap.apply_to_state(&mut accounts).expect("approve applies");
        // spender moves the token owner→bob via transferFrom.
        let tx = qrc20_call(spender, contract, "transferFrom",
            &format!("[\"{}\",\"{}\",\"tok1\"]", owner, bob));
        tx.apply_to_state(&mut accounts).expect("approved transferFrom applies");
        assert_eq!(owner_of(&accounts, contract, "tok1").as_deref(), Some(bob), "token moved to bob");
        assert_eq!(nft_count(&accounts, contract, owner), 0, "owner count drops to 0");
        assert_eq!(nft_count(&accounts, contract, bob), 1, "bob count is 1");
        assert!(!accounts.get(contract).unwrap().contract_storage.contains_key("approved:tok1"),
            "approval cleared after transferFrom");
    }

    #[test]
    fn nft_transfer_from_unapproved_rejected() {
        let (owner, contract, mallory, bob) = ("alice", "nftX", "mallory", "bob");
        let mut accounts = seed_nft(owner, contract);
        fund(&mut accounts, mallory);
        let m = qrc20_call(owner, contract, "mint", &format!("[\"{}\",\"tok1\"]", owner));
        m.apply_to_state(&mut accounts).expect("mint applies");
        // mallory is neither the owner nor approved.
        let tx = qrc20_call(mallory, contract, "transferFrom",
            &format!("[\"{}\",\"{}\",\"tok1\"]", owner, bob));
        let err = tx.apply_to_state(&mut accounts).unwrap_err();
        assert!(format!("{:?}", err).contains("transfer_from_not_approved"),
            "unapproved transferFrom must reject, got {:?}", err);
        assert_eq!(owner_of(&accounts, contract, "tok1").as_deref(), Some(owner),
            "owner unchanged on rejected transferFrom");
    }
}

// End-to-end WASM contract tests through the REAL apply_to_state path (only exercisable
// now that WASM_VM_ENABLED=true): deploy → call → cross-call, verifying committed storage.
#[cfg(test)]
mod tests_wasm_e2e {
    use super::*;

    // Deploy validator requires an EXPLICIT memory maximum (bounded deterministic memory) —
    // fixtures declare (memory 1 4) like any deployable contract.
    // Contract that writes storage key "k" = "v".
    const WRITE_KV: &str = r#"(module
        (import "env" "storage_write" (func $sw (param i32 i32 i32 i32)))
        (memory (export "memory") 1 4)
        (data (i32.const 0) "kv")
        (func (export "run") (call $sw (i32.const 0)(i32.const 1)(i32.const 1)(i32.const 1))))"#;
    // B writes "bk"="bv".
    const B_WRITES: &str = r#"(module
        (import "env" "storage_write" (func $sw (param i32 i32 i32 i32)))
        (memory (export "memory") 1 4)
        (data (i32.const 0) "bkbv")
        (func (export "run") (call $sw (i32.const 0)(i32.const 2)(i32.const 2)(i32.const 2))))"#;
    // A calls "B" then writes "ak"="av".
    const A_CALLS_B: &str = r#"(module
        (import "env" "call_contract" (func $call (param i32 i32 i32 i32 i32 i32 i64 i32 i32)(result i32)))
        (import "env" "storage_write" (func $sw (param i32 i32 i32 i32)))
        (memory (export "memory") 1 4)
        (data (i32.const 0) "Brunakav")
        (func (export "run")(local $n i32)
            (local.set $n (call $call
                (i32.const 0)(i32.const 1) (i32.const 1)(i32.const 3)
                (i32.const 0)(i32.const 0) (i64.const 0) (i32.const 64)(i32.const 32)))
            (call $sw (i32.const 4)(i32.const 2)(i32.const 6)(i32.const 2))))"#;

    fn funded(bal: u64) -> Account {
        let mut a = Account::default();
        a.balance = bal;
        a
    }
    fn wasm_contract_acc(wat: &str) -> Account {
        let code = wat::parse_str(wat).unwrap();
        let mut a = Account::default();
        a.is_contract = true;
        a.contract_storage.insert("type".to_string(), "wasm".to_string());
        a.contract_storage.insert("code".to_string(), hex::encode(&code));
        a
    }
    fn wasm_call(sender: &str, contract: &str, nonce: u64, data: &str) -> Transaction {
        let mut tx = Transaction {
            hash: String::new(), from: sender.to_string(), to: Some(contract.to_string()),
            amount: 0, nonce, timestamp: 0, gas_price: 1, gas_limit: 2_000_000,
            data: Some(data.to_string()), signature: None, public_key: None,
            tx_type: TransactionType::ContractCall,
            dilithium_signature: None, dilithium_public_key: None, chain_id: 0,
        };
        tx.hash = tx.calculate_hash();
        tx
    }
    fn wasm_deploy(sender: &str, nonce: u64, wat: &str) -> Transaction {
        let code = wat::parse_str(wat).unwrap();
        let data = format!("{{\"wasm\":true,\"code\":\"{}\"}}", hex::encode(&code));
        let mut tx = Transaction {
            hash: String::new(), from: sender.to_string(), to: None,
            amount: 0, nonce, timestamp: 0, gas_price: 1, gas_limit: 2_000_000,
            data: Some(data), signature: None, public_key: None,
            tx_type: TransactionType::ContractDeploy,
            dilithium_signature: None, dilithium_public_key: None, chain_id: 0,
        };
        tx.hash = tx.calculate_hash();
        tx
    }
    fn hexk(k: &[u8]) -> String { hex::encode(k) }
    fn stored<'a>(accounts: &'a HashMap<String, Account>, c: &str, k: &[u8]) -> Option<&'a String> {
        accounts.get(c).and_then(|a| a.contract_storage.get(&hexk(k)))
    }

    #[test]
    fn deploy_creates_wasm_contract() {
        let mut accounts = HashMap::new();
        accounts.insert("alice".to_string(), funded(100_000_000));
        wasm_deploy("alice", 1, WRITE_KV).apply_to_state(&mut accounts).expect("wasm deploy applies");
        let addr = derive_contract_address("alice", 1);
        let c = accounts.get(&addr).expect("contract account created at derived address");
        assert_eq!(c.contract_storage.get("type").map(|s| s.as_str()), Some("wasm"));
        assert!(c.contract_storage.contains_key("code"), "code blob stored");
    }

    #[test]
    fn call_executes_and_commits_storage() {
        let mut accounts = HashMap::new();
        accounts.insert("alice".to_string(), funded(100_000_000));
        accounts.insert("c".to_string(), wasm_contract_acc(WRITE_KV));
        wasm_call("alice", "c", 1, r#"{"method":"run"}"#)
            .apply_to_state(&mut accounts).expect("wasm call applies");
        assert_eq!(stored(&accounts, "c", b"k").map(|s| s.as_str()), Some(hexk(b"v").as_str()),
            "the contract's storage write committed (hex-encoded)");
    }

    #[test]
    fn cross_contract_call_commits_both_when_declared() {
        let mut accounts = HashMap::new();
        accounts.insert("alice".to_string(), funded(100_000_000));
        accounts.insert("A".to_string(), wasm_contract_acc(A_CALLS_B));
        accounts.insert("B".to_string(), wasm_contract_acc(B_WRITES));
        wasm_call("alice", "A", 1, r#"{"method":"run","accessList":["B"]}"#)
            .apply_to_state(&mut accounts).expect("cross-call applies");
        assert_eq!(stored(&accounts, "A", b"ak").map(|s| s.as_str()), Some(hexk(b"av").as_str()));
        assert_eq!(stored(&accounts, "B", b"bk").map(|s| s.as_str()), Some(hexk(b"bv").as_str()),
            "declared callee B's write committed");
    }

    #[test]
    fn undeclared_callee_is_not_reached() {
        let mut accounts = HashMap::new();
        accounts.insert("alice".to_string(), funded(100_000_000));
        accounts.insert("A".to_string(), wasm_contract_acc(A_CALLS_B));
        accounts.insert("B".to_string(), wasm_contract_acc(B_WRITES));
        // accessList omitted → A's call to B is unresolvable; A still commits its own write.
        wasm_call("alice", "A", 1, r#"{"method":"run"}"#)
            .apply_to_state(&mut accounts).expect("call applies");
        assert_eq!(stored(&accounts, "A", b"ak").map(|s| s.as_str()), Some(hexk(b"av").as_str()));
        assert!(stored(&accounts, "B", b"bk").is_none(), "undeclared B is never reached or written");
    }

    #[test]
    fn deploy_then_call_full_pipeline() {
        let mut accounts = HashMap::new();
        accounts.insert("alice".to_string(), funded(100_000_000));
        wasm_deploy("alice", 1, WRITE_KV).apply_to_state(&mut accounts).expect("deploy applies");
        let addr = derive_contract_address("alice", 1);
        wasm_call("alice", &addr, 2, r#"{"method":"run"}"#)
            .apply_to_state(&mut accounts).expect("call on freshly deployed contract applies");
        assert_eq!(stored(&accounts, &addr, b"k").map(|s| s.as_str()), Some(hexk(b"v").as_str()),
            "deploy→call end-to-end committed the contract's write");
    }
}

