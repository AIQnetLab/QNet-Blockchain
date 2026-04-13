//! Transaction types and processing

use serde::{Deserialize, Serialize};
use blake3::Hasher;
use sha3::{Sha3_256, Digest};
use crate::errors::StateResult;
use crate::StateError;
use std::collections::HashMap;
use crate::Account;
use std::collections::HashSet;
use crate::account::{NodeType, ActivationPhase};
use std::sync::{Arc, RwLock};
use std::sync::atomic::{AtomicU8, Ordering};
use once_cell::sync::Lazy;

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

/// v3.42: Maximum entries in a single contract's contract_storage HashMap.
/// Prevents unbounded growth of Account → Merkle tree for popular QRC-20 tokens.
/// At 1M entries (~80 bytes per KV pair) this is ~80 MB per contract — safe for testnet.
/// Mainnet will use sharded storage (separate trie per contract) to remove this limit.
pub const MAX_CONTRACT_STORAGE_ENTRIES: usize = 1_000_000;

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
}

/// Transaction hash type
pub type TxHash = String;

/// Transaction types
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum TransactionType {
    /// Transfer QNC between accounts
    Transfer {
        from: String,
        to: String,
        amount: u64,
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
    /// Self-attestation for Full/Super nodes (10 heartbeats per 4-hour epoch)
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
                // tx.to (contract address) is already added above
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
            TransactionType::Transfer { amount, .. } => {
                // v3.0: Self-transfers are ALLOWED (like Bitcoin, Ethereum, Solana)
                // Use cases: testing, nonce increment, consolidation
                if *amount == 0 {
                    return Err("[REJECT][TX] zero_transfer_amount".to_string());
                }
                if self.to.as_ref().map(|s| s.is_empty()).unwrap_or(true) {
                    return Err("[REJECT][TX] empty_recipient_address".to_string());
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
                // amount_out_min can be 0 (no slippage protection, risky but allowed)
                let _ = amount_out_min; // Explicitly mark as intentionally unused here
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
                
                // Validate each sample
                for sample in heartbeat_samples {
                    if sample.heartbeat_index >= 10 {
                        return Err(format!("[REJECT][TX] invalid_heartbeat_index value={}", sample.heartbeat_index));
                    }
                    if sample.block_height < *window_start_height || sample.block_height > *window_end_height {
                        return Err(format!("[REJECT][TX] heartbeat_sample_outside_window block_height={} start={} end={}", sample.block_height, window_start_height, window_end_height));
                    }
                    if sample.signature.is_empty() {
                        return Err("[REJECT][TX] empty_heartbeat_sample_signature".to_string());
                    }
                    if sample.merkle_proof.is_empty() {
                        return Err("[REJECT][TX] heartbeat_sample_missing_merkle_proof".to_string());
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
        }

        Ok(())
    }
    
    /// Apply transaction to state
    pub fn apply_to_state(&self, accounts: &mut HashMap<String, Account>) -> Result<(), StateError> {
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

        match &self.tx_type {
            TransactionType::Transfer { from, to, amount } => {
                // Get sender account
                let sender = accounts.get_mut(from)
                    .ok_or_else(|| StateError::AccountNotFound(from.clone()))?;
                
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
                if accounts.contains_key(address) {
                    return Err(StateError::InvalidTransaction("[REJECT][CREATE-ACCOUNT] account_already_exists".to_string()));
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
                let sender = accounts.get_mut(&self.from)
                    .ok_or_else(|| StateError::AccountNotFound(self.from.clone()))?;

                // CRITICAL SECURITY: Check nonce to prevent replay attacks
                if self.nonce != sender.nonce + 1 {
                    return Err(StateError::InvalidTransaction(format!(
                        "[REJECT][TX] invalid_nonce expected={} got={}",
                        sender.nonce + 1, self.nonce
                    )));
                }

                // Fee calculation (QUANTUM v2.25: use effective_gas_price for +50% Dilithium TX)
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

                // Burn tokens (remove from balance)
                sender.balance = sender.balance.checked_sub(total_amount)
                    .ok_or_else(|| StateError::InvalidTransaction("[REJECT][TX] sender_balance_underflow".into()))?;
                sender.nonce = sender.nonce.checked_add(1)
                    .ok_or_else(|| StateError::InvalidTransaction("[REJECT][TX] nonce_overflow".into()))?;

                // Activate node
                sender.activate_node(format!("{:?}", node_type), self.timestamp);
            }
            TransactionType::ContractDeploy => {
                // Contract deployment -- v3.40: FULL blockchain state (QRC-20 + generic WASM)
                // ALL contract/token state is stored in Account.contract_storage
                // which is part of the Merkle tree -> replicated to ALL nodes via blocks
                let sender = accounts.get_mut(&self.from)
                    .ok_or_else(|| StateError::AccountNotFound(self.from.clone()))?;
                
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

                // Compute contract address from deployer + nonce (deterministic)
                let contract_address = if let Some(to) = &self.to {
                    to.clone()
                } else {
                    let mut hasher = Sha3_256::new();
                    hasher.update(self.from.as_bytes());
                    hasher.update(self.nonce.to_le_bytes());
                    format!("contract_{}", hex::encode(&hasher.finalize()[..20]))
                };

                // Parse tx.data to determine contract type
                let data_str = self.data.as_ref().ok_or_else(|| {
                    StateError::InvalidTransaction("[REJECT][CONTRACT] missing_data_field".to_string())
                })?;
                
                // FIX M6: Parse JSON first, then check for QRC-20 via proper field access
                let is_qrc20 = serde_json::from_str::<serde_json::Value>(data_str)
                    .ok()
                    .and_then(|v| v.get("qrc20").and_then(|q| q.as_bool()))
                    .unwrap_or(false);
                
                // Compute code hash
                let code_hash = {
                    let mut hasher = Sha3_256::new();
                    hasher.update(data_str.as_bytes());
                    hex::encode(hasher.finalize())
                };

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
                        let initial_supply = parsed.get("initial_supply").and_then(|v| v.as_u64()).unwrap_or(0);
                        
                        // Token metadata — stored on-chain, readable by all nodes
                        contract.contract_storage.insert("type".to_string(), "qrc20".to_string());
                        contract.contract_storage.insert("name".to_string(), name.to_string());
                        contract.contract_storage.insert("symbol".to_string(), symbol.to_string());
                        contract.contract_storage.insert("decimals".to_string(), decimals.to_string());
                        contract.contract_storage.insert("total_supply".to_string(), initial_supply.to_string());
                        // Creator receives initial supply — ON-CHAIN balance
                        contract.contract_storage.insert(
                            format!("balance:{}", self.from), initial_supply.to_string()
                        );
                        
                        if is_info_log() {
                            println!("[INFO][TOKEN] qrc20_deployed name={} symbol={} supply={} addr={} by={}",
                                name, symbol, initial_supply,
                                &contract_address[..contract_address.len().min(20)],
                                &self.from[..self.from.len().min(16)]);
                        }
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
            }
            TransactionType::ContractCall => {
                // Contract interaction -- v3.40: QRC-20 token operations execute ON-CHAIN
                // transfer, approve, transferFrom all modify contract_storage in blockchain state
                let sender = accounts.get_mut(&self.from)
                    .ok_or_else(|| StateError::AccountNotFound(self.from.clone()))?;
                
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

                let contract = accounts.entry(contract_addr.clone())
                    .or_insert_with(|| Account::new(contract_addr.clone()));

                if !contract.is_contract {
                    return Err(StateError::InvalidTransaction(format!(
                        "[REJECT][CONTRACT] not_a_contract addr={}", contract_addr
                    )));
                }

                // Credit contract with sent value (if any)
                if self.amount > 0 {
                    contract.balance = contract.balance.checked_add(self.amount)
                        .ok_or_else(|| StateError::InvalidTransaction("[REJECT][CONTRACT] balance_overflow".into()))?;
                }

                // v3.40: Execute QRC-20 operations ON-CHAIN (deterministic on all nodes)
                let is_qrc20 = contract.contract_storage.get("type")
                    .map(|t| t == "qrc20").unwrap_or(false);
                
                if is_qrc20 {
                    if let Some(ref data) = self.data {
                        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
                            let method = parsed.get("method").and_then(|v| v.as_str()).unwrap_or("");
                            let args = parsed.get("args");
                            
                            match method {
                                "transfer" => {
                                    // QRC-20 transfer: move tokens from sender to recipient
                                    let to = args.and_then(|a| a.get(0)).and_then(|v| v.as_str())
                                        .ok_or_else(|| StateError::InvalidTransaction(
                                            "[REJECT][QRC20] transfer_missing_to_arg".to_string()))?;
                                    let amount = args.and_then(|a| a.get(1)).and_then(|v| v.as_u64())
                                        .ok_or_else(|| StateError::InvalidTransaction(
                                            "[REJECT][QRC20] transfer_missing_amount_arg".to_string()))?;

                                    if amount == 0 {
                                        return Err(StateError::InvalidTransaction("[REJECT][QRC20] zero_amount_transfer".into()));
                                    }

                                    let from_key = format!("balance:{}", sender_addr);
                                    // FIX R24-L1: Log corrupted contract_storage instead of silent 0.
                                    // unwrap_or(0) masked data corruption — now we detect and log it.
                                    let from_bal: u64 = match contract.contract_storage.get(&from_key) {
                                        Some(val) => match val.parse::<u64>() {
                                            Ok(b) => b,
                                            Err(_) => {
                                                println!("[ERR][QRC20] corrupted_balance key={} val={}", from_key, &val[..32.min(val.len())]);
                                                return Err(StateError::InvalidTransaction(
                                                    format!("[REJECT][QRC20] corrupted_balance key={}", from_key)));
                                            }
                                        },
                                        None => 0,
                                    };
                                    
                                    if from_bal < amount {
                                        return Err(StateError::InvalidTransaction(format!(
                                            "[REJECT][QRC20] insufficient_balance have={} need={}", from_bal, amount)));
                                    }
                                    
                                    let to_key = format!("balance:{}", to);
                                    let to_bal: u64 = match contract.contract_storage.get(&to_key) {
                                        Some(val) => match val.parse::<u64>() {
                                            Ok(b) => b,
                                            Err(_) => {
                                                println!("[ERR][QRC20] corrupted_balance key={} val={}", to_key, &val[..32.min(val.len())]);
                                                return Err(StateError::InvalidTransaction(
                                                    format!("[REJECT][QRC20] corrupted_balance key={}", to_key)));
                                            }
                                        },
                                        None => 0,
                                    };

                                    // v3.42: Cap contract_storage to prevent unbounded Merkle growth
                                    // Only reject if this is a NEW holder (existing holders can always receive)
                                    if to_bal == 0 && contract.contract_storage.len() >= MAX_CONTRACT_STORAGE_ENTRIES {
                                        return Err(StateError::InvalidTransaction(format!(
                                            "[REJECT][QRC20] storage_limit_reached entries={} max={}",
                                            contract.contract_storage.len(), MAX_CONTRACT_STORAGE_ENTRIES)));
                                    }
                                    
                                    let new_to_bal = to_bal.checked_add(amount)
                                        .ok_or_else(|| StateError::InvalidTransaction("[REJECT][QRC20] recipient_balance_overflow".into()))?;
                                    let new_from_bal = from_bal.checked_sub(amount)
                                        .ok_or_else(|| StateError::InvalidTransaction("[REJECT][QRC20] sender_balance_underflow".into()))?;
                                    contract.contract_storage.insert(from_key, new_from_bal.to_string());
                                    contract.contract_storage.insert(to_key, new_to_bal.to_string());

                                    if is_info_log() {
                                        println!("[INFO][QRC20] transfer {} -> {} amount={} contract={}",
                                            &sender_addr[..sender_addr.len().min(16)],
                                            &to[..to.len().min(16)], amount,
                                            &contract_addr[..contract_addr.len().min(16)]);
                                    }
                                }
                                "approve" => {
                                    // QRC-20 approve: set allowance for spender
                                    let spender = args.and_then(|a| a.get(0)).and_then(|v| v.as_str())
                                        .ok_or_else(|| StateError::InvalidTransaction(
                                            "[REJECT][QRC20] approve_missing_spender_arg".to_string()))?;
                                    let amount = args.and_then(|a| a.get(1)).and_then(|v| v.as_u64())
                                        .ok_or_else(|| StateError::InvalidTransaction(
                                            "[REJECT][QRC20] approve_missing_amount_arg".to_string()))?;
                                    
                                    let allowance_key = format!("allowance:{}:{}", sender_addr, spender);
                                    
                                    // v3.42: Cap contract_storage — only reject NEW allowance entries
                                    let is_new_entry = !contract.contract_storage.contains_key(&allowance_key);
                                    if is_new_entry && contract.contract_storage.len() >= MAX_CONTRACT_STORAGE_ENTRIES {
                                        return Err(StateError::InvalidTransaction(format!(
                                            "[REJECT][QRC20] approve_storage_limit_reached entries={} max={}",
                                            contract.contract_storage.len(), MAX_CONTRACT_STORAGE_ENTRIES)));
                                    }
                                    
                                    contract.contract_storage.insert(allowance_key, amount.to_string());
                                    
                                    if is_info_log() {
                                        println!("[INFO][QRC20] approve owner={} spender={} amount={}",
                                            &sender_addr[..sender_addr.len().min(16)],
                                            &spender[..spender.len().min(16)], amount);
                                    }
                                }
                                "transferFrom" | "transfer_from" => {
                                    // QRC-20 transferFrom: spend from approved allowance
                                    let from = args.and_then(|a| a.get(0)).and_then(|v| v.as_str())
                                        .ok_or_else(|| StateError::InvalidTransaction(
                                            "[REJECT][QRC20] transfer_from_missing_from_arg".to_string()))?;
                                    let to = args.and_then(|a| a.get(1)).and_then(|v| v.as_str())
                                        .ok_or_else(|| StateError::InvalidTransaction(
                                            "[REJECT][QRC20] transfer_from_missing_to_arg".to_string()))?;
                                    let amount = args.and_then(|a| a.get(2)).and_then(|v| v.as_u64())
                                        .ok_or_else(|| StateError::InvalidTransaction(
                                            "[REJECT][QRC20] transfer_from_missing_amount_arg".to_string()))?;

                                    if amount == 0 {
                                        return Err(StateError::InvalidTransaction("[REJECT][QRC20] zero_amount_transfer".into()));
                                    }

                                    // Check allowance
                                    let allowance_key = format!("allowance:{}:{}", from, sender_addr);
                                    let allowance: u64 = contract.contract_storage.get(&allowance_key)
                                        .and_then(|s| s.parse().ok()).unwrap_or(0);
                                    if allowance < amount {
                                        return Err(StateError::InvalidTransaction(format!(
                                            "[REJECT][QRC20] insufficient_allowance have={} need={}", allowance, amount)));
                                    }
                                    
                                    // Check balance of 'from'
                                    let from_key = format!("balance:{}", from);
                                    let from_bal: u64 = contract.contract_storage.get(&from_key)
                                        .and_then(|s| s.parse().ok()).unwrap_or(0);
                                    if from_bal < amount {
                                        return Err(StateError::InvalidTransaction(format!(
                                            "[REJECT][QRC20] transfer_from_insufficient_balance have={} need={}", from_bal, amount)));
                                    }
                                    
                                    // Execute transfer + deduct allowance
                                    let to_key = format!("balance:{}", to);
                                    let to_bal: u64 = match contract.contract_storage.get(&to_key) {
                                        Some(val) => match val.parse::<u64>() {
                                            Ok(b) => b,
                                            Err(_) => {
                                                println!("[ERR][QRC20] corrupted_balance key={} val={}", to_key, &val[..32.min(val.len())]);
                                                return Err(StateError::InvalidTransaction(
                                                    format!("[REJECT][QRC20] corrupted_balance key={}", to_key)));
                                            }
                                        },
                                        None => 0,
                                    };

                                    // v3.42: Cap contract_storage — only reject if NEW holder
                                    if to_bal == 0 && contract.contract_storage.len() >= MAX_CONTRACT_STORAGE_ENTRIES {
                                        return Err(StateError::InvalidTransaction(format!(
                                            "[REJECT][QRC20] transfer_from_storage_limit_reached entries={} max={}",
                                            contract.contract_storage.len(), MAX_CONTRACT_STORAGE_ENTRIES)));
                                    }
                                    
                                    let new_to_bal = to_bal.checked_add(amount)
                                        .ok_or_else(|| StateError::InvalidTransaction("[REJECT][QRC20] recipient_balance_overflow".into()))?;
                                    let new_from_bal = from_bal.checked_sub(amount)
                                        .ok_or_else(|| StateError::InvalidTransaction("[REJECT][QRC20] sender_balance_underflow".into()))?;
                                    let new_allowance = allowance.checked_sub(amount)
                                        .ok_or_else(|| StateError::InvalidTransaction("[REJECT][QRC20] allowance_underflow".into()))?;
                                    contract.contract_storage.insert(from_key, new_from_bal.to_string());
                                    contract.contract_storage.insert(to_key, new_to_bal.to_string());
                                    contract.contract_storage.insert(allowance_key, new_allowance.to_string());
                                    
                                    if is_info_log() {
                                        println!("[INFO][QRC20] transferFrom {} -> {} amount={} spender={}",
                                            &from[..from.len().min(16)],
                                            &to[..to.len().min(16)], amount,
                                            &sender_addr[..sender_addr.len().min(16)]);
                                    }
                                }
                                _ => {
                                    // Unknown QRC-20 method — record as generic call
                                    if is_debug_log() {
                                        println!("[DBG][QRC20] unknown_method={} contract={}",
                                            method, &contract_addr[..contract_addr.len().min(16)]);
                                    }
                                }
                            }
                        }
                    }
                } else {
                    // Generic contract call — record in storage (capped)
                    const MAX_CALL_RECORDS: usize = 10_000;
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
            TransactionType::Swap { from, token_in, token_out, amount_in, amount_out_min, amount_out, pool_address } => {
                // Token swap via DEX
                // v3.18: Gas fee goes directly to block producer (Pool 2 removed)
                let sender = accounts.get_mut(from)
                    .ok_or_else(|| StateError::AccountNotFound(from.clone()))?;
                
                // CRITICAL SECURITY: Check nonce to prevent replay attacks
                if self.nonce != sender.nonce + 1 {
                    return Err(StateError::InvalidTransaction(format!(
                        "[REJECT][TX] invalid_nonce expected={} got={}",
                        sender.nonce + 1, self.nonce
                    )));
                }
                
                // Calculate gas fee (QUANTUM v2.25: +50% for Dilithium TX)
                let fee = self.effective_gas_price().checked_mul(self.gas_limit)
                    .ok_or_else(|| StateError::InvalidTransaction("[REJECT][TX] gas_fee_overflow".into()))?;
                
                // For QNC swaps: check if user has enough balance (amount_in + fee)
                // For other tokens: only check fee (token balance checked by DEX contract)
                let total_cost = if token_in == "QNC" {
                    amount_in.checked_add(fee)
                        .ok_or_else(|| StateError::InvalidTransaction("[REJECT][SWAP] total_cost_overflow".into()))?
                } else {
                    fee
                };
                
                if sender.balance < total_cost {
                    return Err(StateError::InsufficientBalance {
                        have: sender.balance,
                        need: total_cost,
                    });
                }
                
                // Slippage protection: ensure amount_out >= amount_out_min
                if *amount_out < *amount_out_min {
                    return Err(StateError::InvalidTransaction(format!(
                        "[REJECT][SWAP] slippage_exceeded got={} min={} token={}",
                        amount_out, amount_out_min, token_out
                    )));
                }
                
                // Deduct fee (always in QNC)
                sender.balance = sender.balance.checked_sub(fee)
                    .ok_or_else(|| StateError::InvalidTransaction("[REJECT][SWAP] fee_balance_underflow".into()))?;

                // If swapping QNC for another token, deduct amount_in from sender
                if token_in == "QNC" {
                    sender.balance = sender.balance.checked_sub(*amount_in)
                        .ok_or_else(|| StateError::InvalidTransaction("[REJECT][SWAP] sender_balance_underflow".into()))?;
                }
                
                // If receiving QNC, add amount_out to sender
                if token_out == "QNC" {
                    sender.balance = sender.balance.checked_add(*amount_out)
                        .ok_or_else(|| StateError::InvalidTransaction("[REJECT][SWAP] sender_credit_overflow".into()))?;
                }
                
                sender.nonce = sender.nonce.checked_add(1)
                    .ok_or_else(|| StateError::InvalidTransaction("[REJECT][TX] nonce_overflow".into()))?;

                // v3.34: Update pool balance (conservation of value)
                // Without this, QNC was burned/minted instead of transferred to/from pool
                let pool = accounts.entry(pool_address.clone())
                    .or_insert_with(|| Account::new(pool_address.clone()));
                
                if token_in == "QNC" {
                    // Pool receives QNC from sender
                    pool.balance = pool.balance.checked_add(*amount_in)
                        .ok_or_else(|| StateError::InvalidTransaction("[REJECT][SWAP] pool_credit_overflow".into()))?;
                }
                if token_out == "QNC" {
                    // Pool sends QNC to sender — must have sufficient liquidity
                    if pool.balance < *amount_out {
                        return Err(StateError::InsufficientBalance {
                            have: pool.balance,
                            need: *amount_out,
                        });
                    }
                    pool.balance = pool.balance.checked_sub(*amount_out)
                        .ok_or_else(|| StateError::InvalidTransaction("[REJECT][SWAP] pool_balance_underflow".into()))?;
                }
                
                // Swap -- currently inactive (no RPC handler), logic preserved for future DEX
                if is_info_log() {
                    println!("[INFO][SWAP] {} swapped {} {} for {} {} via pool {} (fee: {} nanoQNC)",
                        &from[..from.len().min(16)], amount_in, token_in, amount_out, token_out,
                        &pool_address[..pool_address.len().min(16)], fee);
                }
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

