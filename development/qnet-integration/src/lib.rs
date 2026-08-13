// Blanket suppression directives removed.
// Remaining targeted #[allow(dead_code)] annotations are placed on specific
// items intentionally kept for future use or backwards-compatibility.
#![recursion_limit = "256"]

//! QNet Integration - Full blockchain system
//! This module integrates all QNet components into a cohesive blockchain system.

pub mod errors;
pub mod storage;
pub mod unified_p2p;
pub mod node;
pub mod rpc;
pub mod genesis;
pub mod activation_validation;
pub mod parallel_executor;
pub mod adaptive_bft;
pub mod pre_execution;
pub mod network_config;
pub mod archive_manager;
pub mod genesis_constants;
pub mod galc;              // Genesis-Anchored Live Checkpoint — live genesis-signed WS pin for cold-join
pub mod reward_sharding;
pub mod reward_epoch;      // Reward epochs: one owner for an epoch root, its total, and its serveability
pub mod registry_lthash;   // Homomorphic (incremental, O(1)) multiset hash for registry_root at scale
pub mod consensus_state;   // L1 consensus state machine (single coordinator)
pub mod consensus_v2_driver; // Consensus v2 — Checkpoint-BFT driver (engine ↔ node bridge)
pub mod consensus_v2_node;   // Consensus v2 — node runtime (verify + async effect executor + task)
pub mod block_pipeline;    // Staged block processing pipeline (ingest → decode → verify → apply)
pub mod attestation_committee;  // Deterministic attestation committee selection (per-microblock BFT layer)
pub mod genesis_config;    // File-based genesis loader (not p2p)
pub mod sync_manager;      // Block download coordinator (sequential waves, ordered buffer)
pub mod p2p_extensions;
pub mod quic_transport;    // PRODUCTION v2.19.21: QUIC transport layer
pub mod p2p_transport;     // PRODUCTION v2.19.21: P2P transport abstraction + binary protocol
pub mod preflight_checks;  // PRODUCTION v2.19.22: Pre-flight port/connectivity validation
pub mod benchmark;         // PRODUCTION v2.19.25: Real transaction benchmark system
#[cfg(test)]
mod tests;                 // PRODUCTION v2.19.25: Complete test suite (API, Stress, Network, Chaos)

// ============================================================================
// CRYPTOGRAPHY MODULE (isolated for external audit)
// ============================================================================
/// All cryptographic operations: Dilithium, VRF, Key Management
/// See: src/crypto/mod.rs for full documentation
pub mod crypto;

// Backwards compatibility re-exports (so existing imports still work)
pub use crypto::pq_crypto;
pub use crypto::quantum_crypto;
pub use crypto::vrf;
pub use crypto::key_manager;

// Core imports with correct paths
// v3.22: Use State (not StateManager) - State has optimized Merkle methods
pub use qnet_state::{State as StateManager, Account, Transaction, Block, StateDB, StateError, StateResult};
pub use qnet_mempool::{SimpleMempool, SimpleMempoolConfig};
pub use qnet_consensus::{ConsensusEngine, ConsensusConfig, NodeId};
pub use qnet_sharding::{ShardCoordinator, ParallelValidator};

// Import NetworkMessage for compilation
pub use unified_p2p::NetworkMessage;

// Re-export for external use
pub use errors::{IntegrationError, IntegrationResult};
pub use storage::PersistentStorage;
pub use node::{BlockchainNode, NodeType, Region};
pub use unified_p2p::SimplifiedP2P;

// v3.12: Re-export failover metrics for monitoring (NTP functions removed - using proper timestamp validation)
pub use node::{
    get_failover_metrics,
    get_extended_failover_metrics,
    FailoverMetrics,
};

use std::sync::atomic::{AtomicU64, Ordering};

// ============================================================================
// GLOBAL STATE FOR DYNAMIC PRICING (updated by node sync process)
// ============================================================================

/// Global 1DEV burn percentage (multiplied by 100 for precision, e.g., 4500 = 45.00%)
pub static GLOBAL_BURN_PERCENTAGE: AtomicU64 = AtomicU64::new(0);

/// Global total active nodes count (from P2P network)
pub static GLOBAL_ACTIVE_NODES: AtomicU64 = AtomicU64::new(0);

/// Global Genesis block timestamp (set once from block #0)
pub static GLOBAL_GENESIS_TIMESTAMP: AtomicU64 = AtomicU64::new(0);

/// Update global pricing state (called by node sync process)
pub fn update_global_pricing_state(burn_pct: f64, active_nodes: u64, genesis_ts: u64) {
    GLOBAL_BURN_PERCENTAGE.store((burn_pct * 100.0) as u64, Ordering::Relaxed);
    GLOBAL_ACTIVE_NODES.store(active_nodes, Ordering::Relaxed);
    if genesis_ts > 0 && GLOBAL_GENESIS_TIMESTAMP.load(Ordering::Relaxed) == 0 {
        GLOBAL_GENESIS_TIMESTAMP.store(genesis_ts, Ordering::Relaxed);
    }
}


/// Feature flags for testing
pub mod feature_flags {
    /// Performance configuration
    pub struct PerformanceConfig {
        pub enable_sharding: bool,
        pub enable_parallel_validation: bool,
        pub shard_count: u32,
        pub batch_size: usize,
        pub microblock_interval: std::time::Duration,
    }
    
    impl Default for PerformanceConfig {
        fn default() -> Self {
            Self {
                enable_sharding: true,
                enable_parallel_validation: true,
                shard_count: 100,
                batch_size: 200000, // v4.1: 200K TX/block
                microblock_interval: std::time::Duration::from_secs(1),
            }
        }
    }
}

// Re-export commonly used types
pub type BlockHash = [u8; 32];
pub type TransactionHash = [u8; 32];
pub type AccountAddress = String; 
