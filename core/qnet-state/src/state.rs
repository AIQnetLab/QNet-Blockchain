//! State management for QNet blockchain
//! v3.11: Added State Merkle Tree for Light client proofs
//! v3.26: Added atomic fee crediting protection (race condition fix)
//! v3.39: Block snapshot for state_root mismatch recovery (rare error case)

use std::collections::{HashMap, HashSet, BTreeMap};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use dashmap::DashMap;
use parking_lot::RwLock as ParkingRwLock;
use once_cell::sync::Lazy;
use crate::{Account, Block, Transaction, TransactionType, StateError, StateResult, GAS_METERING_ACTIVATION_HEIGHT};
use sha3::{Sha3_256, Digest};
use tracing::{info, debug, warn, error};

/// v7.0: Gate for including pending_rewards in Merkle hash.
/// Set to true when the first v7.0 emission TX (with `"v":2` accruals) is applied.
/// Before activation, hash_account() excludes pending_rewards for backward compat
/// with state_roots computed by pre-v7.0 code.
static PENDING_REWARDS_IN_MERKLE: AtomicBool = AtomicBool::new(false);

/// v7.0: Activate pending_rewards inclusion in Merkle hash.
/// Called ONCE when the first v7.0 emission accrual is applied to state.
/// After this point, all hash_account() calls include pending_rewards.
pub fn activate_pending_rewards_in_merkle() {
    if !PENDING_REWARDS_IN_MERKLE.load(Ordering::Acquire) {
        PENDING_REWARDS_IN_MERKLE.store(true, Ordering::Release);
        println!("[INFO][STATE] v7.0 FORK ACTIVATED: pending_rewards now included in Merkle state root");
    }
}

/// v7.0: Check if pending_rewards is included in Merkle hash.
pub fn is_pending_rewards_in_merkle() -> bool {
    PENDING_REWARDS_IN_MERKLE.load(Ordering::Acquire)
}

/// v7.0: Reset pending_rewards flag for full state replay from genesis.
/// During replay, the flag will be re-activated at the correct block via accrue_pending_rewards.
pub fn reset_pending_rewards_in_merkle() {
    PENDING_REWARDS_IN_MERKLE.store(false, Ordering::SeqCst);
}

// ═══════════════════════════════════════════════════════════════════════════════
// v3.26: ATOMIC FEE CREDITING PROTECTION
// Prevents race condition where same block's fees are credited multiple times
// when block is received from multiple peers simultaneously
// TOP L1 PATTERN: Idempotent fee crediting
// ═══════════════════════════════════════════════════════════════════════════════
static CREDITED_FEES_BLOCKS: Lazy<ParkingRwLock<HashSet<u64>>> = Lazy::new(|| {
    ParkingRwLock::new(HashSet::new())
});

/// v3.26: Check and mark block as fee-credited atomically
/// Returns true if fee should be credited (first time), false if already done
/// v3.39: Auto-cleanup blocks older than 1000 heights to prevent memory leak
pub fn should_credit_fees(block_height: u64) -> bool {
    let mut set = CREDITED_FEES_BLOCKS.write();
    if set.contains(&block_height) {
        return false; // Already credited - prevent double crediting!
    }
    set.insert(block_height);
    
    // v3.39: Cleanup old entries (keep only last 1000 blocks)
    // Prevents unbounded memory growth (86400 blocks/day = memory leak)
    if set.len() > 1000 {
        let min_keep = block_height.saturating_sub(1000);
        set.retain(|&h| h >= min_keep);
    }
    true
}

/// v3.26: Clear credited fees cache (for testing or reset)
pub fn clear_credited_fees_cache() {
    let mut set = CREDITED_FEES_BLOCKS.write();
    set.clear();
}

/// v3.26: Get count of credited blocks (for monitoring)
pub fn credited_fees_count() -> usize {
    CREDITED_FEES_BLOCKS.read().len()
}

/// Maximum supply of QNC tokens (2^32 QNC = 4.295 billion QNC)
/// NOTE: Stored in whole QNC units for readability
/// Internal operations use nanoQNC (multiply by 10^9)
pub const MAX_QNC_SUPPLY: u64 = 4_294_967_296;

/// Maximum supply in nanoQNC (smallest units)
/// Used for internal calculations and comparisons
pub const MAX_QNC_SUPPLY_NANO: u64 = MAX_QNC_SUPPLY * 1_000_000_000;

// ═══════════════════════════════════════════════════════════════════════════════
// v3.11: STATE MERKLE TREE for Light Client Balance Proofs
// Enables trustless verification without downloading full blockchain
// ═══════════════════════════════════════════════════════════════════════════════

const HASH_SIZE: usize = 32;
const TREE_DEPTH: usize = 256; // v32.14: full address bit-width — guarantees ALL leaves converge to ONE root

/// State Merkle Tree for account proofs
/// Optimized for QNet's account structure with batch operations for 100K+ TPS
/// 
/// # Performance Features
/// - Lazy root computation (dirty flag)
/// - Batch insert for block processing
/// - O(1) insert, O(n) finalize once per block
pub struct StateMerkleTree {
    /// Root hash (may be stale if dirty=true)
    root: [u8; HASH_SIZE],
    /// Stored account hashes (address_hash -> account_data_hash)
    /// v3.40: CRITICAL FIX - Changed from HashMap to BTreeMap!
    /// HashMap uses RandomState with random seed per instance
    /// This caused non-deterministic iteration order -> different state_root
    /// BTreeMap sorts keys -> deterministic iteration -> identical state_root
    pub(crate) leaves: BTreeMap<[u8; HASH_SIZE], [u8; HASH_SIZE]>,
    /// Pre-computed default hashes for each level
    default_hashes: Vec<[u8; HASH_SIZE]>,
    /// v3.39: Dirty flag for lazy root computation
    /// When true, root needs recomputation before use
    pub(crate) dirty: bool,
    /// v3.39: Pending updates count for logging
    pub(crate) pending_updates: usize,
    /// v32.14: cached non-default internal nodes keyed by (depth, parent_key).
    /// Persistent across finalize calls — enables O(k log N) incremental path
    /// updates instead of O(N log N) full rebuild. Default subtrees stay
    /// implicit (default_hashes[depth]); only branches with ≥1 populated leaf
    /// occupy this map. Bounded by 2N entries.
    pub(crate) intermediate_nodes: HashMap<(u32, [u8; HASH_SIZE]), [u8; HASH_SIZE]>,
    /// v32.14: leaf addresses changed since last finalize. Each one triggers
    /// a single path-walk in finalize. Cleared after recomputation.
    pub(crate) dirty_paths: HashSet<[u8; HASH_SIZE]>,
    /// v32.14: switch between full-rebuild and incremental. Default true.
    /// Full-rebuild kept for migration / verification of intermediate cache.
    pub(crate) incremental_enabled: bool,
}

impl StateMerkleTree {
    /// Create new empty tree
    pub fn new() -> Self {
        let mut default_hashes = Vec::with_capacity(TREE_DEPTH + 1);
        let mut current = [0u8; HASH_SIZE];
        default_hashes.push(current);
        
        let mut buffer = [0u8; HASH_SIZE * 2];
        for _ in 0..TREE_DEPTH {
            buffer[..HASH_SIZE].copy_from_slice(&current);
            buffer[HASH_SIZE..].copy_from_slice(&current);
            
            let mut hasher = Sha3_256::new();
            hasher.update(&buffer);
            let result = hasher.finalize();
            current.copy_from_slice(&result);
            default_hashes.push(current);
        }
        
        Self {
            root: default_hashes[TREE_DEPTH],
            leaves: BTreeMap::new(),  // v3.40: BTreeMap for deterministic iteration
            default_hashes,
            dirty: false,
            pending_updates: 0,
            intermediate_nodes: HashMap::new(),
            dirty_paths: HashSet::new(),
            incremental_enabled: true,
        }
    }
    
    // ═══════════════════════════════════════════════════════════════════════════════
    // v3.22: BATCH/LAZY OPERATIONS FOR 100K+ TPS
    // ═══════════════════════════════════════════════════════════════════════════════
    
    /// Insert or update account WITH immediate root recomputation
    /// Use for single updates outside block processing
    /// For block processing, use insert_lazy() + finalize()
    pub fn insert(&mut self, address: &str, account: &Account) -> [u8; HASH_SIZE] {
        let addr_hash = Self::hash_address(address);
        let account_hash = Self::hash_account(account);
        self.leaves.insert(addr_hash, account_hash);
        self.recompute_root();
        self.dirty = false;
        self.pending_updates = 0;
        self.root
    }
    
    /// v3.22: Insert or update account WITHOUT root recomputation (lazy)
    /// Use during block processing - call finalize() once after all TX applied
    /// O(1) operation - no tree traversal
    pub fn insert_lazy(&mut self, address: &str, account: &Account) {
        let addr_hash = Self::hash_address(address);
        let account_hash = Self::hash_account(account);

        // v3.40: Diagnostic log for first account (to debug state_root mismatch)
        if self.leaves.is_empty() {
            println!("[DBG][MERKLE] first_account addr={} bal={} nonce={} addr_hash={} acct_hash={}",
                     &address[..20.min(address.len())], account.balance, account.nonce,
                     hex::encode(&addr_hash[..8]), hex::encode(&account_hash[..8]));
        }

        self.leaves.insert(addr_hash, account_hash);
        self.dirty = true;
        self.pending_updates += 1;
        self.dirty_paths.insert(addr_hash); // v32.14: incremental path tracking
    }

    /// v3.22: Batch insert multiple accounts WITHOUT root recomputation
    /// Use for Genesis block or large batch operations
    /// O(m) where m = number of updates, no tree traversal
    pub fn insert_batch(&mut self, updates: &[(String, Account)]) {
        for (address, account) in updates {
            let addr_hash = Self::hash_address(address);
            let account_hash = Self::hash_account(account);
            self.leaves.insert(addr_hash, account_hash);
            self.dirty_paths.insert(addr_hash); // v32.14
        }
        self.dirty = true;
        self.pending_updates += updates.len();
    }

    /// v3.22: Finalize tree - recompute root if dirty
    /// Call once after all block transactions applied
    /// v32.14: O(k × log N) level-synchronous BFS — deterministic across nodes.
    /// Each level processes parents whose children changed; reads both children
    /// from final storage state (no cross-path stale reads). Falls back to full
    /// recompute on cold start (empty intermediate_nodes cache).
    pub fn finalize(&mut self) -> [u8; HASH_SIZE] {
        if self.dirty {
            let updates = self.pending_updates;
            let k = self.dirty_paths.len();
            let use_incremental = self.incremental_enabled
                && !self.intermediate_nodes.is_empty()
                && k > 0;
            if use_incremental {
                self.recompute_levels();
            } else {
                self.recompute_root();
                self.dirty_paths.clear();
            }
            self.dirty = false;
            self.pending_updates = 0;
            if updates > 0 {
                println!(
                    "[INFO][MERKLE] state_root_finalized updates={} leaves={} dirty={} mode={} root={}",
                    updates, self.leaves.len(), k,
                    if use_incremental { "incremental" } else { "full" },
                    hex::encode(&self.root[..8]),
                );
            }
        }
        self.root
    }
    
    /// v3.22: Check if tree needs finalization
    pub fn is_dirty(&self) -> bool {
        self.dirty
    }
    
    /// v3.22: Get pending updates count
    pub fn pending_count(&self) -> usize {
        self.pending_updates
    }
    
    /// Remove account with immediate root recomputation
    pub fn remove(&mut self, address: &str) -> [u8; HASH_SIZE] {
        let addr_hash = Self::hash_address(address);
        self.leaves.remove(&addr_hash);
        self.dirty = true;
        self.pending_updates += 1;
        self.finalize()
    }

    /// Remove account leaf WITHOUT root recomputation (lazy)
    /// O(1) amortized — used during block rollback to batch multiple removals
    /// Call finalize() once after all rollback operations complete
    pub fn remove_lazy(&mut self, address: &str) {
        let addr_hash = Self::hash_address(address);
        self.leaves.remove(&addr_hash);
        self.dirty = true;
        self.pending_updates += 1;
        self.dirty_paths.insert(addr_hash); // v32.14: path-walk needed for default-fill
    }
    
    /// Get current root (with lazy recomputation if dirty)
    /// Safe to call anytime - will finalize if needed
    pub fn root(&mut self) -> [u8; HASH_SIZE] {
        if self.dirty {
            self.finalize();
        }
        self.root
    }
    
    /// Get current root WITHOUT finalization (may be stale)
    /// Use only when you know tree is not dirty or stale root is acceptable
    pub fn root_unchecked(&self) -> [u8; HASH_SIZE] {
        self.root
    }
    
    /// v32.14: SMT inclusion proof. At each depth D the sibling is read from
    /// `leaves` (D=0) or `intermediate_nodes` (D≥1) keyed by the canonical
    /// level-D key (bits 0..D-1 of leaf address cleared, bit D flipped).
    /// Empty subtree → `default_hashes[D]`. Proof verifies against the root
    /// produced by recompute_root / recompute_levels.
    pub fn generate_proof(&self, address: &str) -> Vec<([u8; HASH_SIZE], bool)> {
        let addr_hash = Self::hash_address(address);
        let mut proof = Vec::with_capacity(TREE_DEPTH);
        let mut key = addr_hash;

        for depth in 0..TREE_DEPTH {
            let mut sibling_key = key;
            Self::flip_bit(&mut sibling_key, depth);

            let sibling_hash = if depth == 0 {
                self.leaves.get(&sibling_key).copied()
                    .unwrap_or(self.default_hashes[0])
            } else {
                self.intermediate_nodes
                    .get(&(depth as u32, sibling_key))
                    .copied()
                    .unwrap_or(self.default_hashes[depth])
            };

            let is_right = Self::get_bit(&addr_hash, depth);
            proof.push((sibling_hash, is_right));

            // ascend: clear bit at depth to reach parent's level-(D+1) key
            let byte_idx = depth / 8;
            let bit_idx = 7 - (depth % 8);
            if byte_idx < HASH_SIZE {
                key[byte_idx] &= !(1 << bit_idx);
            }
        }

        proof
    }
    
    /// Verify proof
    pub fn verify_proof(
        address: &str,
        account: &Account,
        proof: &[([u8; HASH_SIZE], bool)],
        root: &[u8; HASH_SIZE]
    ) -> bool {
        if proof.len() != TREE_DEPTH {
            return false;
        }
        
        let addr_hash = Self::hash_address(address);
        let mut current = Self::hash_account(account);
        let mut buffer = [0u8; HASH_SIZE * 2];
        
        for (depth, (sibling, is_right)) in proof.iter().enumerate() {
            let expected_bit = Self::get_bit(&addr_hash, depth);
            if *is_right != expected_bit {
                return false;
            }
            
            if *is_right {
                buffer[..HASH_SIZE].copy_from_slice(sibling);
                buffer[HASH_SIZE..].copy_from_slice(&current);
            } else {
                buffer[..HASH_SIZE].copy_from_slice(&current);
                buffer[HASH_SIZE..].copy_from_slice(sibling);
            }
            
            let mut hasher = Sha3_256::new();
            hasher.update(&buffer);
            let result = hasher.finalize();
            current.copy_from_slice(&result);
        }
        
        current == *root
    }
    
    // Internal helpers
    
    fn hash_address(address: &str) -> [u8; HASH_SIZE] {
        let mut hasher = Sha3_256::new();
        hasher.update(b"QNET_ADDR:");
        hasher.update(address.as_bytes());
        let result = hasher.finalize();
        let mut arr = [0u8; HASH_SIZE];
        arr.copy_from_slice(&result);
        arr
    }
    
    fn hash_account(account: &Account) -> [u8; HASH_SIZE] {
        let mut hasher = Sha3_256::new();
        hasher.update(b"QNET_ACCOUNT_V2:");
        // Consensus-critical fields (modified only through deterministic block processing)
        hasher.update(&account.balance.to_le_bytes());
        hasher.update(&account.nonce.to_le_bytes());
        hasher.update(account.address.as_bytes());
        // Contract state — deterministically modified through ContractCall TXs
        hasher.update(&[account.is_contract as u8]);
        if let Some(ref code_hash) = account.contract_code_hash {
            hasher.update(b"CODE:");
            hasher.update(code_hash.as_bytes());
        }
        if !account.contract_storage.is_empty() {
            hasher.update(b"STORAGE:");
            // Keys MUST be sorted — HashMap iteration is non-deterministic
            let mut sorted_keys: Vec<&String> = account.contract_storage.keys().collect();
            sorted_keys.sort();
            for key in sorted_keys {
                hasher.update(key.as_bytes());
                hasher.update(account.contract_storage[key].as_bytes());
            }
        }
        // v32.15: pending_rewards ALWAYS in leaf hash — fixed schema for chain
        // lifetime. A runtime flag here made hash_account non-deterministic:
        // accounts hashed before the flip kept a no-pending hash, so any full
        // rebuild (rollback/snapshot/restart) re-hashed them with-pending and
        // diverged from the running incremental state → consensus split.
        hasher.update(&account.pending_rewards.to_le_bytes());
        // v34: unforgeable liveness counter — ALWAYS in leaf hash (fixed schema, same rule as
        // pending_rewards above). Reward eligibility reads popcount(heartbeat_slots), so the
        // counter MUST be consensus-bound; conditional inclusion would split the chain.
        hasher.update(b"HB:");
        hasher.update(&account.heartbeat_epoch.to_le_bytes());
        hasher.update(&account.heartbeat_slots.to_le_bytes());
        hasher.update(&account.heartbeat_final_epoch.to_le_bytes());
        hasher.update(&[account.heartbeat_final_count]);
        // last_claimed_epoch: reward-claim watermark — ALWAYS in leaf hash (fixed schema,
        // same rule as pending_rewards/HB). Anti-replay for merkle claims must be
        // consensus-bound, else nodes diverge on which epochs an account already claimed.
        hasher.update(b"LCE:");
        hasher.update(&account.last_claimed_epoch.to_le_bytes());
        // EXCLUDED from hash (non-deterministic or metadata-only):
        //   - reputation: f64 is non-deterministic across platforms
        //   - is_node, node_type, created_at, updated_at: metadata only
        let result = hasher.finalize();
        let mut arr = [0u8; HASH_SIZE];
        arr.copy_from_slice(&result);
        arr
    }
    
    fn get_bit(hash: &[u8; HASH_SIZE], depth: usize) -> bool {
        let byte_idx = depth / 8;
        let bit_idx = 7 - (depth % 8);
        if byte_idx < HASH_SIZE {
            (hash[byte_idx] >> bit_idx) & 1 == 1
        } else {
            false
        }
    }
    
    fn flip_bit(hash: &mut [u8; HASH_SIZE], depth: usize) {
        let byte_idx = depth / 8;
        let bit_idx = 7 - (depth % 8);
        if byte_idx < HASH_SIZE {
            hash[byte_idx] ^= 1 << bit_idx;
        }
    }
    
    fn recompute_root(&mut self) {
        if self.leaves.is_empty() {
            self.root = self.default_hashes[TREE_DEPTH];
            self.intermediate_nodes.clear();
            return;
        }

        // v32.14: full rebuild also populates intermediate_nodes cache so
        // subsequent finalize calls use the incremental path-walk.
        self.intermediate_nodes.clear();
        let mut current_level = self.leaves.clone();
        let mut buffer = [0u8; HASH_SIZE * 2];

        for depth in 0..TREE_DEPTH {
            let default = self.default_hashes[depth];
            let mut next_level: BTreeMap<[u8; HASH_SIZE], [u8; HASH_SIZE]> = BTreeMap::new();
            let mut processed: std::collections::HashSet<[u8; HASH_SIZE]> = std::collections::HashSet::new();

            for (key, value) in current_level.iter() {
                if processed.contains(key) {
                    continue;
                }

                let is_right = Self::get_bit(key, depth);
                let mut sibling_key = *key;
                Self::flip_bit(&mut sibling_key, depth);
                let sibling = current_level.get(&sibling_key).copied().unwrap_or(default);

                if is_right {
                    buffer[..HASH_SIZE].copy_from_slice(&sibling);
                    buffer[HASH_SIZE..].copy_from_slice(value);
                } else {
                    buffer[..HASH_SIZE].copy_from_slice(value);
                    buffer[HASH_SIZE..].copy_from_slice(&sibling);
                }

                let mut hasher = Sha3_256::new();
                hasher.update(&buffer);
                let result = hasher.finalize();
                let mut parent_hash = [0u8; HASH_SIZE];
                parent_hash.copy_from_slice(&result);

                // v3.40: parent key has bit at depth CLEARED (both siblings → same parent).
                let mut actual_parent = *key;
                let byte_idx = depth / 8;
                let bit_idx = 7 - (depth % 8);
                if byte_idx < HASH_SIZE {
                    actual_parent[byte_idx] &= !(1 << bit_idx);
                }

                next_level.insert(actual_parent, parent_hash);
                // v32.14: cache parent in intermediate_nodes (keyed by level depth+1).
                // Skip storing default values to keep the map sparse.
                let parent_level = (depth + 1) as u32;
                if parent_hash != self.default_hashes[depth + 1] {
                    self.intermediate_nodes.insert((parent_level, actual_parent), parent_hash);
                }
                processed.insert(*key);
                processed.insert(sibling_key);
            }

            current_level = next_level;
            // v32.14: true SMT semantics — always walk to TREE_DEPTH so root
            // sits at a fixed depth. Prior early-exit at len<=1 produced a
            // shallower root for sparse states and broke incremental↔full
            // equivalence on edge cases. Cost is O(TREE_DEPTH × k) regardless,
            // since k = leaves typically keeps len > 1 anyway.
        }

        // TREE_DEPTH=HASH bits → all leaves converge to ONE entry at level TREE_DEPTH.
        // unwrap fallback only fires for an empty tree (already short-circuited above).
        self.root = current_level.values().next().copied()
            .unwrap_or(self.default_hashes[TREE_DEPTH]);
    }

    /// v32.14: level-synchronous BFS incremental update. Each level d reads
    /// BOTH children from final storage (leaves at d=0, intermediate_nodes
    /// at d≥1) and writes parent at d+1. Order-independent within a level
    /// via BTreeSet sorted iteration. Sibling dedup avoids double-computing
    /// shared parents. Produces identical root to recompute_root() for the
    /// same leaf set. O(k × log N) per finalize where k = changed leaves.
    fn recompute_levels(&mut self) {
        use std::collections::BTreeSet;
        let mut current_dirty: BTreeSet<[u8; HASH_SIZE]> =
            self.dirty_paths.drain().collect();

        let mut buffer = [0u8; HASH_SIZE * 2];

        for depth in 0..TREE_DEPTH {
            let mut next_dirty: BTreeSet<[u8; HASH_SIZE]> = BTreeSet::new();
            let byte_idx = depth / 8;
            let bit_idx = 7 - (depth % 8);

            for key in &current_dirty {
                // Parent key at depth+1: clear bit at depth (left child of pair).
                let mut parent_key = *key;
                if byte_idx < HASH_SIZE {
                    parent_key[byte_idx] &= !(1 << bit_idx);
                }
                if !next_dirty.insert(parent_key) {
                    // sibling already triggered this parent — skip duplicate work
                    continue;
                }

                // Both children at depth d: left = bit_d=0, right = bit_d=1.
                let left_key = parent_key;
                let mut right_key = parent_key;
                if byte_idx < HASH_SIZE {
                    right_key[byte_idx] |= 1 << bit_idx;
                }

                let left_hash = if depth == 0 {
                    self.leaves.get(&left_key).copied()
                        .unwrap_or(self.default_hashes[0])
                } else {
                    self.intermediate_nodes
                        .get(&(depth as u32, left_key))
                        .copied()
                        .unwrap_or(self.default_hashes[depth])
                };
                let right_hash = if depth == 0 {
                    self.leaves.get(&right_key).copied()
                        .unwrap_or(self.default_hashes[0])
                } else {
                    self.intermediate_nodes
                        .get(&(depth as u32, right_key))
                        .copied()
                        .unwrap_or(self.default_hashes[depth])
                };

                buffer[..HASH_SIZE].copy_from_slice(&left_hash);
                buffer[HASH_SIZE..].copy_from_slice(&right_hash);
                let mut hasher = Sha3_256::new();
                hasher.update(&buffer);
                let result = hasher.finalize();
                let mut parent_hash = [0u8; HASH_SIZE];
                parent_hash.copy_from_slice(&result);

                let parent_level = (depth + 1) as u32;
                if parent_hash == self.default_hashes[depth + 1] {
                    self.intermediate_nodes.remove(&(parent_level, parent_key));
                } else {
                    self.intermediate_nodes.insert((parent_level, parent_key), parent_hash);
                }
            }

            current_dirty = next_dirty;
        }

        // TREE_DEPTH = address bit-width → all paths converge to the all-zero
        // canonical key at the top level. Empty/default subtree → default root.
        self.root = self.intermediate_nodes
            .get(&(TREE_DEPTH as u32, [0u8; HASH_SIZE]))
            .copied()
            .unwrap_or(self.default_hashes[TREE_DEPTH]);
    }
}

impl Default for StateMerkleTree {
    fn default() -> Self {
        Self::new()
    }
}

/// Balance proof structure for Light clients
#[derive(Debug, Clone)]
pub struct BalanceProof {
    /// Address
    pub address: String,
    /// Balance in nanoQNC
    pub balance: u64,
    /// Nonce
    pub nonce: u64,
    /// FIX R23-C2: Include pending_rewards so verify_balance_proof can reconstruct
    /// the correct Account hash after v7.0 fork (PENDING_REWARDS_IN_MERKLE=true).
    /// Without this, all proofs for accounts with pending_rewards > 0 fail verification.
    pub pending_rewards: u64,
    /// Merkle proof (sibling_hash, is_right)
    pub proof: Vec<([u8; HASH_SIZE], bool)>,
    /// State root this proof is valid for
    pub state_root: [u8; HASH_SIZE],
    /// Block height at which state root was computed
    pub block_height: u64,
}

/// Chain state information
#[derive(Debug, Clone)]
pub struct ChainState {
    /// Current blockchain height
    pub height: u64,
    /// Total supply in nanoQNC (smallest units: 1 QNC = 10^9 nanoQNC)
    pub total_supply: u64,
    /// Highest emission macroblock already minted into total_supply.
    /// Monotonic watermark — makes emission idempotent across re-apply/sync.
    pub last_minted_emission_mb: u64,

    /// Current epoch
    pub epoch: u64,
    /// Last finalized block
    pub last_finalized: u64,
}

impl Default for ChainState {
    fn default() -> Self {
        Self {
            height: 0,
            total_supply: 0, // FAIR LAUNCH: starts at 0, increases only through Pool 1 Base Emission
            last_minted_emission_mb: 0,

            epoch: 0,
            last_finalized: 0,
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// v3.39: BLOCK-LEVEL SNAPSHOT for state_root mismatch recovery
// Created ONCE per block (not per TX!) - only for rare error case
// TX-level rollback NOT NEEDED - apply_transaction_lazy already atomic!
// ═══════════════════════════════════════════════════════════════════════════════

/// Block-level journal for O(k) rollback where k = modified accounts.
/// Records pre-images of accounts touched by transactions in this block.
/// On rollback, restores only those accounts instead of the entire state.
#[derive(Clone)]
pub struct BlockSnapshot {
    /// Pre-images of accounts that existed before modification
    pre_images: HashMap<String, Account>,
    /// Addresses of accounts created during this block (didn't exist before)
    created_keys: HashSet<String>,
    /// Block height for logging
    height: u64,
}

impl BlockSnapshot {
    /// Create an empty journal for the upcoming block. O(1).
    pub fn new(_accounts: &DashMap<String, Account>, height: u64) -> Self {
        Self {
            pre_images: HashMap::new(),
            created_keys: HashSet::new(),
            height,
        }
    }

    /// Record pre-images of addresses that a transaction is about to touch.
    /// Must be called BEFORE each apply_transaction_lazy in the block.
    /// Captures at most once per address (first write wins = original pre-image).
    pub fn record_pre_images(&mut self, addresses: &[String], accounts: &DashMap<String, Account>) {
        for addr in addresses {
            if self.pre_images.contains_key(addr) || self.created_keys.contains(addr) {
                continue; // already captured
            }
            match accounts.get(addr) {
                Some(entry) => {
                    self.pre_images.insert(addr.clone(), entry.value().clone());
                }
                None => {
                    self.created_keys.insert(addr.clone());
                }
            }
        }
    }

    /// Legacy accessor — returns pre-images for rollback
    pub fn accounts(&self) -> &HashMap<String, Account> {
        &self.pre_images
    }

    /// Accounts created during this block (to be removed on rollback)
    pub fn created_keys(&self) -> &HashSet<String> {
        &self.created_keys
    }

    pub fn height(&self) -> u64 {
        self.height
    }

    /// Number of accounts journaled (pre-images + created)
    pub fn journal_size(&self) -> usize {
        self.pre_images.len() + self.created_keys.len()
    }
}

/// State manager for blockchain
/// v3.11: Integrated State Merkle Tree for trustless balance proofs
/// v3.33: Removed unused ValidatorSet - using MacroBlock.eligible_producers instead
///
/// SCALE: the account map is in-RAM (~300-800 B/entry) — a HARD per-node
/// ceiling. Until the RocksDB-CF + hot-key-LRU migration lands, operators
/// MUST provision RAM for the full account set (~600 MB/1M, ~6 GB/10M).
/// Post-migration the per-block hot path stays O(touched) with an
/// LRU-bounded (~200 MB) cache; the Merkle tree stays incremental.
// v15.10: monotonic process-local logical clock for LRU timestamps
// (Relaxed ok — per-node eviction order, no cross-node coherence; ~5 ns).
static LOGICAL_CLOCK: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

#[inline]
fn next_logical_timestamp() -> u64 {
    LOGICAL_CLOCK.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

// Canonical account→shard mapping. MUST be deterministic + stateless so
// every node agrees (precondition for per-shard committees). blake3(addr)
// leading-u32 % num_shards — same hash as the sharding crate, so cross-
// crate assignments line up bit-for-bit; uniform distribution. Edge cases:
// num_shards==0 treated as 1; empty address → shard 0 (defensive).
pub fn account_shard_index(address: &str, num_shards: u32) -> u32 {
    let n = if num_shards == 0 { 1 } else { num_shards };
    if address.is_empty() {
        return 0;
    }
    let hash = blake3::hash(address.as_bytes());
    let bytes = hash.as_bytes();
    // Use first 4 bytes as u32 little-endian — no allocation, branch-free.
    let leading = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
    leading % n
}

/// v15.10 STAGE-2: trait for read-through fallback to a disk-backed account
/// store. Implemented by the integration layer's `Storage` over the RocksDB
/// `accounts` column family. The state crate stays free of any RocksDB
/// dependency — the trait carries only `Account` values across the boundary.
///
/// Concurrency: implementations MUST be `Send + Sync`. The trait is invoked
/// from inside `state.write()` critical sections during the warm-cache pass
/// at block-apply time, so `load_account` MUST be a fast, non-blocking
/// point read (single RocksDB `get_cf` on the hot CF). It MUST NOT spawn
/// futures, hold locks, or perform long-running I/O.
pub trait AccountStore: Send + Sync {
    /// Best-effort read of a single account from the persistent store.
    /// Returns `None` for genuinely-absent accounts and `None` (with a
    /// best-effort INFO log inside the implementor) on transient errors —
    /// the caller treats both identically (cache miss falls through to
    /// the canonical "account not found" path).
    fn load_account(&self, address: &str) -> Option<Account>;
}

pub struct StateManager {
    /// Accounts state — see migration note in struct doc above.
    /// v15.10 STAGE-2: this DashMap is now the LRU cache layer for an
    /// underlying RocksDB-backed account store. Cold accounts get evicted
    /// by the periodic eviction task and reloaded on demand through the
    /// `disk_store` fallback. The public surface
    /// (`get`/`apply_transaction`/`restore_accounts`) is unchanged —
    /// pre-warming at the block-apply boundary guarantees every account
    /// the block needs is resident in this DashMap before mutation.
    pub accounts: Arc<DashMap<String, Account>>,
    /// Chain state
    pub chain_state: Arc<parking_lot::RwLock<ChainState>>,
    /// State root (legacy - for backward compatibility)
    state_root: Arc<parking_lot::RwLock<[u8; 32]>>,
    /// v3.11: State Merkle Tree for Light client proofs
    merkle_tree: Arc<parking_lot::RwLock<StateMerkleTree>>,
    /// PROTOCOL: Tracks committed epochs per node_id to prevent duplicate commitment TXs
    /// Key: "commitment_type:sender_id", Value: last committed epoch
    /// Deterministic: populated from block application, identical across all nodes
    committed_epochs: Arc<DashMap<String, u64>>,
    /// PROTOCOL: Tracks registered node_ids to prevent duplicate NodeRegistration TXs
    /// Key: node_id, Value: wallet_address
    /// Deterministic: populated from block application, identical across all nodes
    registered_nodes: Arc<DashMap<String, String>>,

    // Read-through LRU cache backing `accounts` (working set, not chain
    // state): last_access drives oldest-first eviction; cache_capacity is a
    // soft cap (QNET_ACCOUNT_CACHE_CAPACITY, default 500k); disk_store is
    // the persistent-CF fallback set once at startup. Per-block warm-up
    // reads only the touched addresses, so RAM stays ~200 MB even at 100M+
    // total accounts.
    /// Last-access wall-clock seconds per cached account. Set at warm-time
    /// and on explicit touches; consulted by the eviction sweep to pick
    /// the oldest entries first.
    last_access: Arc<DashMap<String, u64>>,
    /// Soft cap on `accounts.len()`; eviction sweeps keep the map at or
    /// below this size. 0 disables eviction (legacy / tests).
    cache_capacity: Arc<std::sync::atomic::AtomicUsize>,
    /// Read-through fallback to the persistent account store. Set once
    /// at node startup by the integration layer.
    disk_store: Arc<parking_lot::RwLock<Option<Arc<dyn AccountStore>>>>,
    // Logical shard count. Default 1 = pre-shard behaviour (all addresses
    // → shard 0, global account map, no cross-shard coordination). Consumed
    // by account_shard_index (and future per-shard committees / cross-shard
    // 2PC). Deterministic across nodes — ships in chain config via
    // set_num_shards, NOT per-node ENV.
    num_shards: Arc<std::sync::atomic::AtomicU32>,
    // Lock-free cache metrics for monitoring. cache_hits/misses =
    // warm_account resolved from RAM vs needing disk_store; disk_load_hits/
    // misses = disk fallback returned Some vs None (absent address);
    // evictions_total = accounts dropped by the eviction sweep.
    // Steady-state hit ratio ≥95% indicates the cap is correctly sized.
    cache_hits: Arc<std::sync::atomic::AtomicU64>,
    cache_misses: Arc<std::sync::atomic::AtomicU64>,
    disk_load_hits: Arc<std::sync::atomic::AtomicU64>,
    disk_load_misses: Arc<std::sync::atomic::AtomicU64>,
    evictions_total: Arc<std::sync::atomic::AtomicU64>,
}

impl StateManager {
    /// Create new state manager
    pub fn new() -> Self {
        Self {
            accounts: Arc::new(DashMap::new()),
            chain_state: Arc::new(parking_lot::RwLock::new(ChainState::default())),
            state_root: Arc::new(parking_lot::RwLock::new([0u8; 32])),
            merkle_tree: Arc::new(parking_lot::RwLock::new(StateMerkleTree::new())),
            committed_epochs: Arc::new(DashMap::new()),
            registered_nodes: Arc::new(DashMap::new()),
            // v15.10 STAGE-2: cache layer initialised idle. `disk_store` is
            // unset until the integration layer calls `set_disk_store`,
            // and `cache_capacity = 0` disables eviction so legacy paths
            // (tests, tooling) keep their unbounded behaviour by default.
            last_access: Arc::new(DashMap::new()),
            cache_capacity: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            disk_store: Arc::new(parking_lot::RwLock::new(None)),
            // Production cache metrics — all start at 0.
            cache_hits: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            cache_misses: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            disk_load_hits: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            disk_load_misses: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            evictions_total: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            // v15.10 STAGE-2A: single shard by default — Stage-2A is wire
            // compatible with the pre-2A behaviour. Bumping this via
            // `set_num_shards` activates the multi-shard routing surface.
            num_shards: Arc::new(std::sync::atomic::AtomicU32::new(1)),
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    // v15.10 STAGE-2A: SHARDING — public API
    // ════════════════════════════════════════════════════════════════════════

    /// Configure the active shard count. Idempotent. `0` is rejected
    /// (treated as "no change") so the runtime invariant `num_shards ≥ 1`
    /// always holds.
    ///
    /// ⚠ At the time of writing this is FOUNDATIONAL state — bumping
    /// `num_shards > 1` does NOT yet route consensus committees or apply
    /// transactions per-shard. The full activation requires Stage-2B
    /// (per-shard committees) and Stage-2C (cross-shard 2PC) — see the
    /// roadmap in `qnet-sharding/src/lib.rs`. Using this method today
    /// only changes what `account_shard_index` returns; existing apply
    /// paths continue to mutate the global account map.
    pub fn set_num_shards(&self, n: u32) {
        if n == 0 { return; }
        self.num_shards.store(n, std::sync::atomic::Ordering::Relaxed);
    }

    /// Current configured shard count (≥ 1).
    pub fn num_shards(&self) -> u32 {
        self.num_shards.load(std::sync::atomic::Ordering::Relaxed).max(1)
    }

    /// Canonical shard assignment for an address under the currently-
    /// configured shard count. Deterministic — every honest node
    /// computes the same value for the same input.
    pub fn shard_for(&self, address: &str) -> u32 {
        account_shard_index(address, self.num_shards())
    }

    // ════════════════════════════════════════════════════════════════════════
    // v15.10 STAGE-2: LRU CACHE — public API
    // ════════════════════════════════════════════════════════════════════════

    /// Install the persistent-fallback handle. Called once by the
    /// integration layer at node startup, before any block is applied.
    pub fn set_disk_store(&self, store: Arc<dyn AccountStore>) {
        *self.disk_store.write() = Some(store);
    }

    /// Configure the soft cache cap. `0` disables eviction. Callers
    /// typically read `QNET_ACCOUNT_CACHE_CAPACITY` from the environment
    /// and pass it here at startup.
    pub fn set_cache_capacity(&self, capacity: usize) {
        self.cache_capacity.store(capacity, std::sync::atomic::Ordering::Relaxed);
    }

    /// Best-effort warm of a single account: if `address` is already in
    /// `accounts`, just refresh its last-access timestamp; otherwise try
    /// to load it from `disk_store` and insert. Returns true iff the
    /// account is now resident (whether via cache hit or disk hit).
    /// Genuinely-absent accounts (no entry on disk either) return false
    /// — they will be created lazily by the apply path when the
    /// transaction targets them.
    pub fn warm_account(&self, address: &str) -> bool {
        if self.accounts.contains_key(address) {
            self.cache_hits.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            self.touch_access(address);
            return true;
        }
        // Cache miss — record before disk fallback so the metric is
        // accurate even when the disk layer is unreachable.
        self.cache_misses.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let store_guard = self.disk_store.read();
        if let Some(ref store) = *store_guard {
            if let Some(account) = store.load_account(address) {
                self.disk_load_hits.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                // Race-tolerant insert: if another thread inserted between
                // the contains_key check above and this point, keep the
                // existing entry — both paths converge on identical bytes
                // because `load_account` is deterministic on the same
                // RocksDB state.
                self.accounts.entry(address.to_string()).or_insert(account);
                self.touch_access(address);
                return true;
            }
            self.disk_load_misses.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        false
    }

    /// Batched warm of every address in a slice. Used at block-apply time
    /// to ensure every sender / receiver / contract address the block
    /// touches is resident before the apply mutates state. Returns the
    /// count of addresses that ended up resident (cache hit + disk hit).
    pub fn warm_accounts(&self, addresses: &[String]) -> usize {
        let mut hit = 0usize;
        for addr in addresses {
            if self.warm_account(addr) {
                hit = hit.saturating_add(1);
            }
        }
        hit
    }

    /// Refresh the last-access timestamp for `address` to "now". Called
    /// by the apply path on every account touched so the eviction
    /// sweep keeps hot working-set accounts resident.
    ///
    /// RESOLUTION — MONOTONIC LOGICAL CLOCK
    /// ────────────────────────────────────────────────────────────────────
    /// We use a monotonically-incrementing process-local counter (atomic
    /// `fetch_add`) instead of wall-clock time. This guarantees that
    /// every `touch_access` call produces a distinct, strictly-greater
    /// timestamp than every previous call — even when thousands of
    /// touches happen within a single millisecond on a fast SSD. Wall-
    /// clock-based timestamps would flatten such bursts onto a single
    /// value, biasing the eviction sort against the LRU intent (every
    /// account in the burst becomes eviction-eligible simultaneously).
    ///
    /// The counter is process-local — it does NOT need to compare
    /// across nodes (cache state is not consensus-critical) — so the
    /// lack of inter-node coherence is fine. The counter wraps at
    /// 2^64 (≈ 580 years at 1 ns per touch); not a practical concern.
    pub fn touch_access(&self, address: &str) {
        let now = next_logical_timestamp();
        self.last_access.insert(address.to_string(), now);
    }

    /// Bulk-touch helper for the post-apply update of every address a
    /// block touched. Each address still gets a UNIQUE monotonic
    /// timestamp so the eviction order between addresses in the
    /// same batch is deterministic (insertion order in the slice).
    pub fn touch_accesses(&self, addresses: &[String]) {
        for addr in addresses {
            let now = next_logical_timestamp();
            self.last_access.insert(addr.clone(), now);
        }
    }

    /// Evict the oldest cached accounts until `accounts.len()` is at or
    /// below `cache_capacity`. Returns the number of evicted entries.
    /// No-op when capacity is 0 or the cache is already within bound.
    ///
    /// EVICTION POLICY
    /// ────────────────────────────────────────────────────────────────────
    /// Evicted accounts are simply removed from `accounts` and
    /// `last_access` — the canonical disk copy was already written by
    /// the Stage-1 write-through path at block-apply time, so a future
    /// read for the evicted address transparently re-loads from the
    /// `disk_store` fallback. Accounts without a recorded
    /// `last_access` timestamp (e.g. created before Stage-2 wiring)
    /// are evicted FIRST, treating "no timestamp" as "infinitely old".
    ///
    /// THREAD SAFETY
    /// ────────────────────────────────────────────────────────────────────
    /// The function is safe to call from a periodic background task
    /// while apply paths run concurrently. Apply paths that need a
    /// just-evicted account simply re-warm it through the disk store
    /// — the only observable effect is one extra point read.
    pub fn evict_cold_accounts(&self) -> usize {
        let capacity = self.cache_capacity.load(std::sync::atomic::Ordering::Relaxed);
        if capacity == 0 {
            return 0;
        }
        let current = self.accounts.len();
        if current <= capacity {
            return 0;
        }
        let target_evict = current.saturating_sub(capacity);

        // Snapshot (address, last_access) for every cached account.
        // Addresses without a timestamp get treated as `0` so they sort
        // to the front of the eviction queue.
        let mut sorted: Vec<(String, u64)> = self.accounts
            .iter()
            .map(|e| {
                let ts = self.last_access.get(e.key()).map(|v| *v).unwrap_or(0);
                (e.key().clone(), ts)
            })
            .collect();
        sorted.sort_by_key(|(_, ts)| *ts);

        let mut evicted = 0usize;
        for (addr, _) in sorted.iter().take(target_evict) {
            self.accounts.remove(addr);
            self.last_access.remove(addr);
            evicted = evicted.saturating_add(1);
        }
        if evicted > 0 {
            self.evictions_total.fetch_add(evicted as u64, std::sync::atomic::Ordering::Relaxed);
        }
        evicted
    }

    /// Helper for tests / diagnostics — current cache size.
    pub fn cache_size(&self) -> usize {
        self.accounts.len()
    }

    /// Helper for tests / diagnostics — configured capacity.
    pub fn cache_capacity_value(&self) -> usize {
        self.cache_capacity.load(std::sync::atomic::Ordering::Relaxed)
    }

    // ════════════════════════════════════════════════════════════════════════
    // v15.10 STAGE-2: cache metrics — Prometheus-friendly snapshot API
    // ────────────────────────────────────────────────────────────────────────
    // Lock-free reads of the lifetime cache counters. Returned as a tuple
    // so the integration layer (RPC `/metrics` endpoint, internal
    // diagnostics) can publish them in a single atomic-ish snapshot
    // without per-counter API churn.
    //
    // Order: (cache_hits, cache_misses, disk_load_hits, disk_load_misses, evictions_total)
    pub fn cache_metrics(&self) -> (u64, u64, u64, u64, u64) {
        (
            self.cache_hits.load(std::sync::atomic::Ordering::Relaxed),
            self.cache_misses.load(std::sync::atomic::Ordering::Relaxed),
            self.disk_load_hits.load(std::sync::atomic::Ordering::Relaxed),
            self.disk_load_misses.load(std::sync::atomic::Ordering::Relaxed),
            self.evictions_total.load(std::sync::atomic::Ordering::Relaxed),
        )
    }

    /// Computed hit ratio in basis points (0..=10000) — 10000 means
    /// every warm resolved from RAM. Used by the eviction-tuning
    /// heuristic and by alerts that fire when the working-set
    /// efficiency degrades. Returns 10000 when no warms have been
    /// recorded yet (treat empty as "no problem").
    pub fn cache_hit_ratio_bps(&self) -> u64 {
        let hits = self.cache_hits.load(std::sync::atomic::Ordering::Relaxed);
        let misses = self.cache_misses.load(std::sync::atomic::Ordering::Relaxed);
        let total = hits.saturating_add(misses);
        if total == 0 {
            return 10_000;
        }
        // Multiply BEFORE divide to keep precision without f64.
        ((hits.saturating_mul(10_000)) / total).min(10_000)
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // PROTOCOL: Commitment deduplication (prevents duplicate system TXs)
    // Deterministic: all nodes apply same blocks → same committed_epochs state
    // ═══════════════════════════════════════════════════════════════════════════
    
    /// Check if a commitment from sender_id for given epoch already exists in state
    /// Used at: mempool validation, block validation, block production
    pub fn is_epoch_committed(&self, commitment_type: &str, sender_id: &str, epoch: u64) -> bool {
        let key = format!("{}:{}", commitment_type, sender_id);
        self.committed_epochs.get(&key)
            .map(|last_epoch| *last_epoch >= epoch)
            .unwrap_or(false)
    }
    
    /// Mark a commitment as applied in state (called during block application)
    /// CRITICAL: Must be called from apply_to_state path for determinism
    pub fn mark_epoch_committed(&self, commitment_type: &str, sender_id: &str, epoch: u64) {
        let key = format!("{}:{}", commitment_type, sender_id);
        self.committed_epochs.insert(key, epoch);
    }
    
    /// Cleanup old committed_epochs entries (keep only recent 3 epochs)
    /// Called periodically to prevent unbounded growth
    pub fn cleanup_committed_epochs(&self, current_epoch: u64) {
        if current_epoch < 3 { return; }
        let min_epoch = current_epoch - 3;
        self.committed_epochs.retain(|_, epoch| *epoch >= min_epoch);
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // PROTOCOL: Node registration deduplication
    // Prevents duplicate NodeRegistration TXs for the same node_id
    // Deterministic: all nodes populate from same block history → same result
    // ═══════════════════════════════════════════════════════════════════════════

    /// Check if a node_id has already been registered (on-chain, from block application)
    pub fn is_node_registered(&self, node_id: &str) -> bool {
        self.registered_nodes.contains_key(node_id)
    }

    /// Mark a node_id as registered (called after successful NodeRegistration TX application)
    pub fn mark_node_registered(&self, node_id: &str, wallet_address: &str) {
        self.registered_nodes.insert(node_id.to_string(), wallet_address.to_string());
    }

    /// Get the wallet address for a registered node (None if not registered)
    pub fn get_node_wallet(&self, node_id: &str) -> Option<String> {
        self.registered_nodes.get(node_id).map(|v| v.clone())
    }

    /// PROTOCOL: Check if this TX is a duplicate commitment (already applied in a previous block)
    /// Returns Err if duplicate → TX will be rejected during block application
    /// This is deterministic: all nodes have same committed_epochs from same block history
    fn check_duplicate_commitment(&self, tx: &Transaction) -> StateResult<()> {
        let epoch_interval: u64 = 14400; // EMISSION_BLOCK_INTERVAL
        match &tx.tx_type {
            TransactionType::HeartbeatCommitment { node_id, window_start_height, .. } => {
                let epoch = window_start_height / epoch_interval;
                if self.is_epoch_committed("heartbeat", node_id, epoch) {
                    return Err(StateError::InvalidTransaction(format!(
                        "duplicate HeartbeatCommitment: node={} epoch={} already committed", node_id, epoch
                    )));
                }
            }
            TransactionType::PingCommitmentWithSampling { window_start_height, .. } => {
                let epoch = window_start_height / epoch_interval;
                if self.is_epoch_committed("ping", &tx.from, epoch) {
                    return Err(StateError::InvalidTransaction(format!(
                        "duplicate PingCommitment: from={} epoch={} already committed", tx.from, epoch
                    )));
                }
            }
            TransactionType::LightNodeEligibilityBitmap { genesis_id, epoch, .. } => {
                if self.is_epoch_committed("bitmap", genesis_id, *epoch) {
                    return Err(StateError::InvalidTransaction(format!(
                        "duplicate LightNodeBitmap: genesis={} epoch={} already committed", genesis_id, epoch
                    )));
                }
            }
            TransactionType::NodeRegistration { node_id, .. } => {
                if self.is_node_registered(node_id) {
                    return Err(StateError::InvalidTransaction(format!(
                        "duplicate NodeRegistration: node_id={} already registered to wallet={}",
                        node_id,
                        self.get_node_wallet(node_id).unwrap_or_default()
                    )));
                }
            }
            TransactionType::NodeReactivation { node_id, last_macroblock_index, .. } => {
                // v9.4: Deduplicate by macroblock-epoch (90 blocks).
                // A node can reactivate at most once per macroblock-epoch.
                let mb_epoch = last_macroblock_index;
                if self.is_epoch_committed("reactivation", node_id, *mb_epoch) {
                    return Err(StateError::InvalidTransaction(format!(
                        "duplicate NodeReactivation: node={} mb_epoch={} already reactivated",
                        node_id, mb_epoch
                    )));
                }
            }
            _ => {} // Non-commitment TXs — no dedup check needed
        }
        Ok(())
    }
    
    /// PROTOCOL: After successful apply_to_state, mark this commitment in committed_epochs
    fn mark_commitment_from_tx(&self, tx: &Transaction) {
        let epoch_interval: u64 = 14400; // EMISSION_BLOCK_INTERVAL
        match &tx.tx_type {
            TransactionType::HeartbeatCommitment { node_id, window_start_height, .. } => {
                let epoch = window_start_height / epoch_interval;
                self.mark_epoch_committed("heartbeat", node_id, epoch);
            }
            TransactionType::PingCommitmentWithSampling { window_start_height, .. } => {
                let epoch = window_start_height / epoch_interval;
                self.mark_epoch_committed("ping", &tx.from, epoch);
            }
            TransactionType::LightNodeEligibilityBitmap { genesis_id, epoch, .. } => {
                self.mark_epoch_committed("bitmap", genesis_id, *epoch);
            }
            TransactionType::NodeRegistration { node_id, wallet_address, .. } => {
                self.mark_node_registered(node_id, wallet_address);
            }
            TransactionType::NodeReactivation { node_id, last_macroblock_index, .. } => {
                // v9.4: Mark reactivation to prevent duplicates within same mb-epoch
                self.mark_epoch_committed("reactivation", node_id, *last_macroblock_index);
            }
            _ => {} // Non-commitment TXs — nothing to mark
        }
    }
    /// Get account
    pub fn get_account(&self, address: &str) -> Option<Account> {
        self.accounts.get(address).map(|acc| acc.clone())
    }
    
    /// Update account
    /// v3.22: Uses lazy Merkle update - call finalize_merkle() after batch updates
    pub fn update_account(&self, address: String, account: Account) {
        // v3.22: Lazy merkle update
        {
            let mut tree = self.merkle_tree.write();
            tree.insert_lazy(&address, &account);
        }
        // Update accounts map
        self.accounts.insert(address, account);
    }
    
    /// v3.22: Update account with immediate Merkle finalization
    /// Use for single updates outside block processing
    pub fn update_account_finalize(&self, address: String, account: Account) {
        {
            let mut tree = self.merkle_tree.write();
            tree.insert(&address, &account);
        }
        self.accounts.insert(address, account);
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // v3.11: LIGHT CLIENT PROOF METHODS
    // ═══════════════════════════════════════════════════════════════════════════
    
    /// Get balance with Merkle proof for Light client verification
    /// 
    /// # Returns
    /// BalanceProof that can be verified without full blockchain
    pub fn get_balance_with_proof(&self, address: &str) -> Option<BalanceProof> {
        let account = self.accounts.get(address)?;
        let mut tree = self.merkle_tree.write();
        let chain_state = self.chain_state.read();
        
        let proof = tree.generate_proof(address);
        let state_root = tree.root(); // v3.22: Finalize if dirty
        
        Some(BalanceProof {
            address: address.to_string(),
            balance: account.balance,
            nonce: account.nonce,
            pending_rewards: account.pending_rewards,  // FIX R23-C2
            proof,
            state_root,
            block_height: chain_state.height,
        })
    }
    
    /// Verify a balance proof (static method for Light clients)
    /// FIX R23-C2: Uses pending_rewards from proof (not hardcoded 0) so verification
    /// works correctly after v7.0 fork when PENDING_REWARDS_IN_MERKLE is active.
    pub fn verify_balance_proof(proof: &BalanceProof) -> bool {
        let account = Account {
            address: proof.address.clone(),
            balance: proof.balance,
            nonce: proof.nonce,
            pending_rewards: proof.pending_rewards,
            is_node: false,
            node_type: None,
            reputation: 0.70, // Default reputation
            created_at: 0,
            updated_at: 0,
            is_contract: false,
            contract_code_hash: None,
            contract_storage: std::collections::HashMap::new(),
            require_pq_signature: false,
            dilithium_public_key: None,
            heartbeat_epoch: 0,
            heartbeat_slots: 0,
            heartbeat_final_epoch: 0,
            heartbeat_final_count: 0,
            last_claimed_epoch: 0,
        };
        
        StateMerkleTree::verify_proof(
            &proof.address,
            &account,
            &proof.proof,
            &proof.state_root
        )
    }
    
    /// Get current Merkle state root (finalized)
    pub fn get_merkle_state_root(&self) -> [u8; HASH_SIZE] {
        let mut tree = self.merkle_tree.write();
        tree.root() // This will finalize if dirty
    }
    
    /// v3.22: Get Merkle state root without finalization (may be stale)
    pub fn get_merkle_state_root_unchecked(&self) -> [u8; HASH_SIZE] {
        self.merkle_tree.read().root_unchecked()
    }
    
    /// Get balance
    pub fn get_balance(&self, address: &str) -> u64 {
        self.accounts.get(address).map(|acc| acc.balance).unwrap_or(0)
    }
    
    /// v3.18: Credit block fees directly to producer's wallet
    /// v3.11: Also updates State Merkle Tree
    /// v3.22: Uses lazy Merkle update - call finalize_merkle() after block processing
    /// This is called when a block is produced/validated to give fees to the producer
    /// Fees are NOT a transaction - they are direct balance credit
    /// 
    /// WARNING: This function does NOT have race condition protection!
    /// For block processing, use credit_producer_fees_once() instead.
    pub fn credit_producer_fees(&self, producer_wallet: &str, fees: u64) -> StateResult<()> {
        if fees == 0 {
            return Ok(()); // No fees to credit
        }
        
        // Get or create producer account
        let mut account = self.accounts
            .entry(producer_wallet.to_string())
            .or_insert_with(|| Account::new(producer_wallet.to_string()))
            .clone();
        
        // Credit fees (using saturating_add to prevent overflow)
        account.balance = account.balance.saturating_add(fees);
        
        // v3.22: Lazy merkle update (finalized with block)
        {
            let mut tree = self.merkle_tree.write();
            tree.insert_lazy(producer_wallet, &account);
        }
        
        // Update account
        self.accounts.insert(producer_wallet.to_string(), account);
        
        Ok(())
    }
    
    /// v3.26: ATOMIC fee crediting with race condition protection
    /// TOP L1 PATTERN: Idempotent fee crediting - safe to call multiple times
    /// 
    /// This function ensures fees are credited EXACTLY ONCE per block,
    /// even when the same block is received from multiple peers simultaneously.
    /// 
    /// # Arguments
    /// * `block_height` - Height of block (used for idempotency check)
    /// * `producer_wallet` - Wallet address of block producer
    /// * `fees` - Total fees to credit
    /// 
    /// # Returns
    /// * `Ok(true)` - Fees were credited (first call for this block)
    /// * `Ok(false)` - Fees already credited (subsequent calls - no-op)
    /// * `Err(_)` - Error during crediting
    pub fn credit_producer_fees_once(
        &self, 
        block_height: u64,
        producer_wallet: &str, 
        fees: u64
    ) -> StateResult<bool> {
        if fees == 0 {
            return Ok(false); // No fees to credit
        }
        
        // v3.26: Atomic check-and-mark to prevent race condition
        if !should_credit_fees(block_height) {
            // Already credited by another thread - this is expected behavior
            // when block arrives from multiple peers simultaneously
            return Ok(false);
        }
        
        // Get or create producer account
        let mut account = self.accounts
            .entry(producer_wallet.to_string())
            .or_insert_with(|| Account::new(producer_wallet.to_string()))
            .clone();
        
        // Credit fees (using saturating_add to prevent overflow)
        account.balance = account.balance.saturating_add(fees);
        
        // Lazy merkle update (finalized with block)
        {
            let mut tree = self.merkle_tree.write();
            tree.insert_lazy(producer_wallet, &account);
        }
        
        // Update account
        self.accounts.insert(producer_wallet.to_string(), account);
        
        Ok(true) // Fees credited successfully
    }
    
    /// Apply transaction (with immediate Merkle update)
    /// v3.11: Also updates State Merkle Tree for all changed accounts
    /// NOTE: For block processing, use apply_transaction_lazy() + finalize_merkle()
    pub fn apply_transaction(&self, tx: &Transaction) -> StateResult<()> {
        // PROTOCOL: Check for duplicate commitment TXs before applying
        self.check_duplicate_commitment(tx)?;
        
        // v3.34: Load ALL affected accounts (same logic as apply_transaction_lazy)
        // CRITICAL: Without this, batch TX recipients lose existing balance!
        let mut accounts_map = HashMap::new();
        
        for address in tx.get_all_affected_addresses() {
            if let Some(acc) = self.accounts.get(&address) {
                accounts_map.insert(address, acc.clone());
            }
        }
        
        // Apply transaction
        tx.apply_to_state(&mut accounts_map)?;
        
        // PROTOCOL: Mark commitment as applied after successful apply_to_state
        self.mark_commitment_from_tx(tx);
        
        // v3.11: Write back changes AND update Merkle tree
        {
            let mut tree = self.merkle_tree.write();
            for (address, account) in &accounts_map {
                tree.insert(address, account);
            }
        }
        
        // Write to accounts map
        for (address, account) in accounts_map {
            self.accounts.insert(address, account);
        }
        
        Ok(())
    }
    
    // ═══════════════════════════════════════════════════════════════════════════════
    // v3.22: BATCH TRANSACTION PROCESSING FOR 100K+ TPS
    // ═══════════════════════════════════════════════════════════════════════════════
    
    /// v3.22: Apply transaction with LAZY Merkle update (no root recomputation)
    /// Use during block processing - call finalize_merkle() once after all TX applied
    /// Performance: O(1) per TX instead of O(n) per TX
    pub fn apply_transaction_lazy(&self, tx: &Transaction) -> StateResult<()> {
        // PROTOCOL: Check for duplicate commitment TXs before applying
        // Deterministic: same check on all nodes → same accept/reject decisions
        self.check_duplicate_commitment(tx)?;
        
        // v3.34: Load ALL affected accounts (not just from/to)
        // CRITICAL: Without this, BatchTransfers recipients lose existing balance!
        // apply_to_state uses accounts.entry().or_insert_with(Account::new) which
        // creates balance=0 accounts — if not pre-loaded, existing balances are overwritten
        let mut accounts_map = HashMap::new();
        
        for address in tx.get_all_affected_addresses() {
            if let Some(acc) = self.accounts.get(&address) {
                accounts_map.insert(address, acc.clone());
            }
        }
        
        // Apply transaction
        tx.apply_to_state(&mut accounts_map)?;
        
        // PROTOCOL: Mark commitment as applied after successful apply_to_state
        self.mark_commitment_from_tx(tx);
        
        // v3.22: Lazy Merkle update - no root recomputation!
        {
            let mut tree = self.merkle_tree.write();
            for (address, account) in &accounts_map {
                tree.insert_lazy(address, account);
            }
        }
        
        // Write to accounts map
        for (address, account) in accounts_map {
            self.accounts.insert(address, account);
        }
        
        Ok(())
    }
    
    /// v3.36: Apply gas refund for metered blocks (EIP-1559 style)
    /// Returns unused gas (gas_limit - gas_used) * effective_gas_price to sender.
    /// ACTIVATION: Only for blocks at height >= GAS_METERING_ACTIVATION_HEIGHT.
    /// Deterministic: compute_gas_used() is pure function of TX type → identical on all nodes.
    /// Must be called AFTER apply_transaction_lazy() for each TX.
    pub fn apply_gas_refund(&self, tx: &Transaction, block_height: u64) -> StateResult<()> {
        if block_height < GAS_METERING_ACTIVATION_HEIGHT {
            return Ok(());
        }
        let refund = tx.compute_gas_refund();
        if refund == 0 {
            return Ok(());
        }
        // Credit refund back to sender
        if let Some(mut account) = self.accounts.get_mut(&tx.from) {
            account.balance = account.balance.saturating_add(refund);
            // Lazy merkle update so finalize_merkle() picks it up
            let mut tree = self.merkle_tree.write();
            tree.insert_lazy(&tx.from, &account);
        }
        Ok(())
    }
    
    /// v3.22: Apply block with batch Merkle processing
    /// Optimized for 100K+ TPS - single Merkle finalization after all TX
    /// v3.42: Added block_height parameter for gas refund support (EIP-1559)
    /// 
    /// # Performance
    /// - O(1) per TX (lazy Merkle update)
    /// - O(n) finalization ONCE at end
    /// - NO TX-level rollback needed - apply_transaction_lazy already atomic!
    pub fn apply_block_batch(&self, transactions: &[Transaction]) -> StateResult<usize> {
        // Legacy call without block height — no gas refund (genesis / pre-activation blocks)
        self.apply_block_batch_at_height(transactions, 0)
    }
    
    /// v3.42: Apply block batch with gas refund support
    /// Same as apply_block_batch but applies EIP-1559 gas refunds for blocks >= GAS_METERING_ACTIVATION_HEIGHT
    pub fn apply_block_batch_at_height(&self, transactions: &[Transaction], block_height: u64) -> StateResult<usize> {
        let tx_count = transactions.len();
        let mut applied = 0;
        let mut failed = 0;
        
        // Apply each TX - no rollback needed, apply_transaction_lazy is atomic
        // (works with local copy, writes to state only on success)
        for tx in transactions {
            match self.apply_transaction_lazy(tx) {
                Ok(_) => {
                    applied += 1;
                    // v3.42: Gas refund for metered blocks (EIP-1559)
                    let _ = self.apply_gas_refund(tx, block_height);
                }
                Err(e) => {
                    failed += 1;
                    // Log failures (limit spam for large blocks)
                    if failed <= 10 {
                        println!("[WARN][STATE] tx_failed hash={} err={}", 
                                 &tx.hash[..16.min(tx.hash.len())], e);
                    }
                }
            }
        }
        
        // Single Merkle finalization for entire block
        self.finalize_merkle();
        
        // v3.50: Update chain_state.height so balance proofs return correct block_height
        if block_height > 0 {
            let mut chain_state = self.chain_state.write();
            if block_height > chain_state.height {
                chain_state.height = block_height;
            }
        }
        
        if tx_count > 100 || failed > 0 {
            println!("[INFO][STATE] block_batch applied={}/{} failed={}", applied, tx_count, failed);
        }
        
        Ok(applied)
    }
    
    /// v3.26: ATOMIC block processing with fee crediting - TOP L1 PATTERN
    /// This is the SINGLE POINT where fees are credited to producer
    /// Ensures idempotency: calling multiple times with same block = same result
    /// Ensures determinism: all nodes get identical state_root
    /// v3.42: Added block_height for gas refund (EIP-1559)
    /// 
    /// # Arguments
    /// * `transactions` - Block transactions to apply
    /// * `producer_wallet` - Wallet address of block producer (for fee credit)
    /// * `fees_collected` - Total fees from all transactions in block
    /// * `block_height` - Block height (for gas refund activation check)
    /// 
    /// # Returns
    /// * `(applied_count, state_root)` - Number of applied TXs and final state root
    pub fn apply_block_with_fees(
        &self,
        transactions: &[Transaction],
        producer_wallet: &str,
        fees_collected: u64,
    ) -> StateResult<(usize, [u8; HASH_SIZE])> {
        self.apply_block_with_fees_at_height(transactions, producer_wallet, fees_collected, 0)
    }
    
    /// v3.42: ATOMIC block processing with fee crediting + gas refund
    pub fn apply_block_with_fees_at_height(
        &self,
        transactions: &[Transaction],
        producer_wallet: &str,
        fees_collected: u64,
        block_height: u64,
    ) -> StateResult<(usize, [u8; HASH_SIZE])> {
        let mut applied = 0;
        
        // 1. Apply all transactions with lazy merkle updates
        for tx in transactions {
            match self.apply_transaction_lazy(tx) {
                Ok(_) => {
                    applied += 1;
                    // v3.42: Gas refund for metered blocks (EIP-1559)
                    let _ = self.apply_gas_refund(tx, block_height);
                }
                Err(e) => {
                    // Log but don't fail - some TX may be invalid
                    if applied == 0 || transactions.len() < 100 {
                        println!("[WARN][STATE] tx_apply_failed hash={} err={}", tx.hash, e);
                    }
                }
            }
        }
        
        // 2. Credit fees to producer (SINGLE POINT - atomic with TX application)
        // This replaces the separate credit_producer_fees calls in node.rs
        if fees_collected > 0 && !producer_wallet.is_empty() {
            // Get or create producer account
            let mut account = self.accounts
                .entry(producer_wallet.to_string())
                .or_insert_with(|| Account::new(producer_wallet.to_string()))
                .clone();
            
            // Credit fees (saturating to prevent overflow)
            account.balance = account.balance.saturating_add(fees_collected);
            
            // Lazy merkle update for producer balance
            {
                let mut tree = self.merkle_tree.write();
                tree.insert_lazy(producer_wallet, &account);
            }
            
            // Update account
            self.accounts.insert(producer_wallet.to_string(), account);
        }
        
        // 3. Single Merkle finalization (includes producer balance!)
        let state_root = self.finalize_merkle();
        
        // v3.50: Update chain_state.height so balance proofs return correct block_height
        if block_height > 0 {
            let mut chain_state = self.chain_state.write();
            if block_height > chain_state.height {
                chain_state.height = block_height;
            }
        }
        
        if transactions.len() > 10 || fees_collected > 0 {
            println!("[INF][STATE] block_with_fees applied={}/{} fees={} producer={}",
                     applied, transactions.len(), fees_collected,
                     if producer_wallet.len() > 16 { &producer_wallet[..16] } else { producer_wallet });
        }
        
        Ok((applied, state_root))
    }
    
    /// v3.22: Finalize Merkle tree after batch operations
    /// Must be called after apply_transaction_lazy() or apply_block_batch()
    pub fn finalize_merkle(&self) -> [u8; HASH_SIZE] {
        let mut tree = self.merkle_tree.write();
        tree.finalize()
    }
    
    /// v3.22: Check if Merkle tree needs finalization
    pub fn merkle_is_dirty(&self) -> bool {
        self.merkle_tree.read().is_dirty()
    }
    
    // ═══════════════════════════════════════════════════════════════════════════════
    // v3.39: BLOCK-LEVEL SNAPSHOT for state_root mismatch recovery
    // TX-level rollback NOT NEEDED - apply_transaction_lazy already atomic!
    // (it works with local copy, writes to state only on success)
    // ═══════════════════════════════════════════════════════════════════════════════
    
    /// v3.39: Create block snapshot (ONCE per block)
    /// Used for full block rollback ONLY when state_root doesn't match
    /// This is a rare error case (consensus failure or attack)
    pub fn create_block_snapshot(&self, height: u64) -> BlockSnapshot {
        BlockSnapshot::new(&self.accounts, height)
    }
    
    /// v5.0: O(k) block rollback using journal pre-images
    /// Only touches k modified/created accounts instead of rebuilding entire Merkle tree.
    /// Previous approach: O(n) — destroy tree + re-insert all n accounts.
    /// New approach: O(k) leaf updates + single finalize (recompute_root is O(n) but
    /// avoids n BTreeMap insertions which were O(n log n) total).
    pub fn rollback_block(&self, snapshot: &BlockSnapshot) {
        let k_removed = snapshot.created_keys().len();
        let k_restored = snapshot.accounts().len();

        // 1. Remove accounts created during this block from DashMap
        for addr in snapshot.created_keys() {
            self.accounts.remove(addr);
        }

        // 2. Restore pre-images of modified accounts into DashMap
        for (address, account) in snapshot.accounts() {
            self.accounts.insert(address.clone(), account.clone());
        }

        // 3. O(k) incremental Merkle update — only touch changed leaves
        let mut tree = self.merkle_tree.write();

        for addr in snapshot.created_keys() {
            tree.remove_lazy(addr);
        }
        for (address, account) in snapshot.accounts() {
            tree.insert_lazy(address, account);
        }

        tree.finalize();

        println!("[INFO][STATE] block_rollback h={} restored={} removed={} merkle=O(k) k={}",
                 snapshot.height(), k_restored, k_removed, k_removed + k_restored);
    }
    
    // ═══════════════════════════════════════════════════════════════════════════════
    // v3.38: TRANSACTIONAL BLOCK PROCESSING
    // Applies TX, verifies state_root, rolls back on mismatch
    // ═══════════════════════════════════════════════════════════════════════════════
    
    /// v3.38: Clear all state (for Genesis block reset or full replay from genesis)
    pub fn clear(&self) {
        self.accounts.clear();
        self.committed_epochs.clear();
        self.registered_nodes.clear();
        let mut tree = self.merkle_tree.write();
        *tree = StateMerkleTree::new();
        *self.state_root.write() = [0u8; 32];
    }
    
    /// v3.38: Get number of accounts in state
    pub fn account_count(&self) -> usize {
        self.accounts.len()
    }
    
    /// v3.39: Apply block with state_root verification
    /// For Genesis block (h=0): clears state first to ensure clean application
    /// 
    /// # Performance
    /// - Block snapshot: O(n) ONLY if block has state_root (v3.27+ blocks)
    /// - TX apply: O(1) each (atomic, no rollback needed)
    pub fn apply_block_verified(
        &self,
        transactions: &[Transaction],
        expected_state_root: [u8; 32],
        producer_wallet: &str,
        fees_collected: u64,
        block_height: u64
    ) -> StateResult<(usize, [u8; 32])> {
        let tx_count = transactions.len();
        let has_state_root = expected_state_root != [0u8; 32];
        
        // v3.39: Create snapshot ONLY if block has state_root (v3.27+ blocks)
        // For old blocks without state_root - no snapshot needed (saves ~200MB RAM)
        let block_snapshot = if has_state_root {
            Some(self.create_block_snapshot(block_height))
        } else {
            None
        };
        
        // v3.38: For Genesis block - ALWAYS start with clean state
        if block_height == 0 {
            let existing_accounts = self.accounts.len();
            if existing_accounts > 0 {
                println!("[INFO][STATE] genesis_clear existing_accounts={}", existing_accounts);
                self.clear();
            }
        }
        
        // Apply each TX - no TX-level rollback needed!
        // apply_transaction_lazy is atomic (works with local copy)
        let mut applied = 0;
        let mut failed = 0;
        for tx in transactions {
            match self.apply_transaction_lazy(tx) {
                Ok(_) => applied += 1,
                Err(e) => {
                    failed += 1;
                    if failed <= 10 {
                        println!("[WARN][STATE] tx_failed h={} hash={} err={}",
                                 block_height, &tx.hash[..16.min(tx.hash.len())], e);
                    }
                }
            }
        }
        
        // Credit fees to producer (if any)
        if fees_collected > 0 && !producer_wallet.is_empty() {
            if let Err(e) = self.credit_producer_fees_once(block_height, producer_wallet, fees_collected) {
                println!("[ERR][STATE] credit_producer_fees_failed h={} wallet={} fees={} err={:?}",
                         block_height, producer_wallet, fees_collected, e);
                return Err(e);
            }
        }
        
        // Finalize Merkle tree
        let computed_root = self.finalize_merkle();
        
        // Verify state_root (skip for blocks without state_root)
        if has_state_root && computed_root != expected_state_root {
            // STATE ROOT MISMATCH - FULL BLOCK ROLLBACK
            println!("[ERR][STATE] state_root_mismatch h={} expected={} computed={} applied={}/{}",
                     block_height,
                     hex::encode(&expected_state_root[..8]),
                     hex::encode(&computed_root[..8]),
                     applied, tx_count);
            
            // Rollback entire block using block snapshot
            if let Some(ref snapshot) = block_snapshot {
                self.rollback_block(snapshot);
            }
            
            return Err(StateError::InvalidTransaction(format!(
                "state_root_mismatch h={} expected={} computed={}", 
                block_height,
                hex::encode(&expected_state_root[..8]),
                hex::encode(&computed_root[..8])
            )));
        }
        
        // v3.50: Update chain_state.height so balance proofs return correct block_height
        {
            let mut chain_state = self.chain_state.write();
            if block_height > chain_state.height {
                chain_state.height = block_height;
            }
        }
        
        if block_height == 0 || tx_count > 100 || failed > 0 {
            println!("[INFO][STATE] block_verified h={} applied={}/{} failed={} root={}",
                     block_height, applied, tx_count, failed,
                     hex::encode(&computed_root[..8]));
        }
        
        Ok((applied, computed_root))
    }
    
    /// Apply block (legacy - uses apply_transaction which is O(n²))
    /// For new code, use apply_block_batch() instead
    pub fn apply_block(&self, block: &Block) -> StateResult<()> {
        for tx in &block.transactions {
            self.apply_transaction(tx)?;
        }
        
        // Update chain state
        let mut chain_state = self.chain_state.write();
        chain_state.height = block.height;
        
        Ok(())
    }
    
    /// Get chain state
    pub fn get_chain_state(&self) -> ChainState {
        self.chain_state.read().clone()
    }
    
    /// v2.96: Update pending rewards for a node (after emission processing)
    /// v3.11: Also updates State Merkle Tree
    /// v3.22: Uses lazy Merkle update - call finalize_merkle() after batch
    /// CRITICAL SECURITY: This ensures all nodes have same pending_rewards on-chain
    /// Prevents manipulation of local RocksDB to claim fraudulent rewards
    /// v2.100: BUGFIX - Use SET (=) not ADD (+=)!
    /// get_all_pending_rewards() returns TOTAL accumulated amount from reward_manager
    /// Using += caused DOUBLE accumulation: reward_manager accumulates + state accumulates again
    pub fn update_pending_rewards(&self, node_wallet: &str, reward_amount: u64) -> StateResult<()> {
        let mut account = self.accounts.entry(node_wallet.to_string())
            .or_insert_with(|| Account::new(node_wallet.to_string()));

        // SET not ADD — reward_amount is TOTAL accumulated from PhaseAwareRewardManager
        account.pending_rewards = reward_amount;

        // Merkle tree is NOT updated here — it will be updated deterministically
        // when the next block's apply_transaction_lazy + finalize_merkle runs.
        // Updating Merkle out-of-band causes state_root divergence between nodes
        // that process MacroBlocks at different times.

        println!("[INFO][STATE] pending_rewards_updated wallet={}... amount={} QNC",
                 &node_wallet[..node_wallet.len().min(16)],
                 reward_amount / 1_000_000_000);

        Ok(())
    }
    
    /// v7.0: Accrue pending rewards through deterministic block execution.
    /// Uses ADD semantics (+=) because the delta comes from emission TX data.
    /// Updates the Merkle tree so pending_rewards is verified by consensus.
    /// Activates the PENDING_REWARDS_IN_MERKLE fork flag on first call.
    pub fn accrue_pending_rewards(&self, node_wallet: &str, delta: u64) -> StateResult<()> {
        // Activate fork: from this point, all hash_account() calls include pending_rewards
        activate_pending_rewards_in_merkle();
        
        let mut account = self.accounts.entry(node_wallet.to_string())
            .or_insert_with(|| Account::new(node_wallet.to_string()));

        account.pending_rewards = account.pending_rewards.saturating_add(delta);

        {
            let mut tree = self.merkle_tree.write();
            tree.insert_lazy(node_wallet, &account);
        }

        println!("[INFO][STATE] pending_rewards_accrued wallet={}... delta={} total={} QNC",
                 &node_wallet[..node_wallet.len().min(16)],
                 delta / 1_000_000_000,
                 account.pending_rewards / 1_000_000_000);

        Ok(())
    }

    /// v3 merkle-claim credit: credit a proof-verified reward into the wallet's balance and
    /// advance the per-account claim watermark. Anti-replay: returns false (no-op) if the
    /// account already claimed this epoch or a later one. The merkle proof itself is verified
    /// by the caller (node.rs apply, which holds the epoch root); this enforces the watermark
    /// and applies the balance credit + Merkle update atomically under the state lock.
    pub fn claim_reward(&self, wallet: &str, epoch: u64, amount: u64) -> bool {
        let mut account = self.accounts.entry(wallet.to_string())
            .or_insert_with(|| Account::new(wallet.to_string()));
        if epoch <= account.last_claimed_epoch {
            return false;
        }
        account.balance = account.balance.saturating_add(amount);
        account.last_claimed_epoch = epoch;
        {
            let mut tree = self.merkle_tree.write();
            tree.insert_lazy(wallet, &account);
        }
        true
    }

    /// Highest reward epoch this account has already claimed (0 if never claimed).
    /// The RPC uses it to find the next unclaimed epoch to build a merkle claim for.
    pub fn get_last_claimed_epoch(&self, wallet: &str) -> u64 {
        self.accounts.get(wallet).map(|a| a.last_claimed_epoch).unwrap_or(0)
    }

    /// v2.96: Get pending rewards for an account
    pub fn get_pending_rewards(&self, wallet: &str) -> u64 {
        self.accounts.get(wallet)
            .map(|acc| acc.pending_rewards)
            .unwrap_or(0)
    }
    
    /// v2.98: Get all accounts for state snapshot (blockchain persistence)
    /// 
    /// SCALABILITY:
    /// - Snapshots saved ONLY every 160 MacroBlocks (4 hours) - not every block
    /// - DashMap provides O(1) concurrent access
    /// - Zstd-15 compression in storage layer (already implemented)
    /// - Delta snapshots for incremental changes (already implemented in storage.rs)
    /// 
    /// SIZE ESTIMATES:
    /// - 1K accounts: ~100 KB → ~20 KB compressed
    /// - 10K accounts: ~1 MB → ~200 KB compressed
    /// - 100K accounts: ~10 MB → ~2 MB compressed
    /// - 1M accounts: ~100 MB → ~20 MB compressed (5s save, once per 4h)
    /// - 10M accounts: ~1 GB → ~200 MB compressed (30s save, acceptable)
    pub fn get_all_accounts(&self) -> Vec<(String, Account)> {
        self.accounts.iter()
            .map(|entry| (entry.key().clone(), entry.value().clone()))
            .collect()
    }
    
    /// v2.98: Restore accounts from snapshot (after node restart or sync)
    /// v3.22: Optimized with batch Merkle insert for O(n) instead of O(n²)
    /// This replaces in-memory DashMap with persisted blockchain state
    /// v7.1: REMOVED premature fork activation. pending_rewards > 0 does NOT mean
    /// the fork was active — update_pending_rewards() (SET path) writes pending_rewards
    /// without activating the fork. The fork flag must ONLY be activated by
    /// accrue_pending_rewards() during deterministic block replay.
    /// This prevents state_root_mismatch on every node restart.
    pub fn restore_accounts(&self, accounts: Vec<(String, Account)>) -> StateResult<()> {
        let count = accounts.len();
        self.accounts.clear();

        // v7.1: Do NOT activate fork here. Let block replay handle it correctly.
        // The fork flag (PENDING_REWARDS_IN_MERKLE) will be activated when replay
        // encounters a block with non-empty v2 emission accruals.

        // v3.22: Rebuild merkle tree with batch inserts
        let mut tree = self.merkle_tree.write();
        *tree = StateMerkleTree::new();

        // v3.22: Use insert_lazy for O(1) per account instead of O(n)
        for (address, account) in &accounts {
            tree.insert_lazy(address, account);
            self.accounts.insert(address.clone(), account.clone());
        }
        
        // v3.22: Single finalization at the end - O(n) total instead of O(n²)
        let root = tree.finalize();
        
        println!("[INF][STATE] restored_accounts count={} merkle_root={}...", 
                 count,
                 hex::encode(&root[..8]));
        Ok(())
    }
    
    /// Calculate state root hash
    /// v3.11: Now uses Merkle tree root combined with chain state
    /// This enables trustless verification for Light clients
    pub fn calculate_state_root(&self) -> Result<[u8; 32], StateError> {
        // v3.22: Get Merkle root (finalize if dirty)
        let merkle_root = self.merkle_tree.write().root();
        
        // Combine with chain state for complete state root
        let mut hasher = Sha3_256::new();
        hasher.update(b"QNET_STATE_ROOT_V3:");
        hasher.update(&merkle_root);
        
        // Include chain state
        let chain_state = self.chain_state.read();
        hasher.update(&chain_state.height.to_le_bytes());
        hasher.update(&chain_state.total_supply.to_le_bytes());
        
        let result = hasher.finalize();
        let mut hash = [0u8; 32];
        hash.copy_from_slice(&result);
        
        // Update stored state root
        *self.state_root.write() = hash;
        
        Ok(hash)
    }
    
    /// Get current state root
    pub fn get_state_root(&self) -> [u8; 32] {
        *self.state_root.read()
    }
    
    /// Emit rewards with MAX_SUPPLY control
    /// amount: emission amount in nanoQNC (smallest units)
    /// Returns: actual emitted amount in nanoQNC (may be less if MAX_SUPPLY reached)
    /// Idempotent: mints only when `emission_mb` exceeds the watermark, so re-apply,
    /// bulk-sync, or any redundant call path can never double- or under-count supply.
    pub fn emit_rewards(&self, amount: u64, emission_mb: u64) -> StateResult<u64> {
        let mut chain_state = self.chain_state.write();

        // Watermark: each emission macroblock mints exactly once, deterministically.
        if emission_mb > 0 && emission_mb <= chain_state.last_minted_emission_mb {
            return Ok(0);
        }

        // Check if we would exceed MAX_SUPPLY (all in nanoQNC)
        let remaining_supply = MAX_QNC_SUPPLY_NANO.saturating_sub(chain_state.total_supply);
        let actual_emission = amount.min(remaining_supply);

        if actual_emission == 0 {
            println!("⚠️ MAX_SUPPLY reached: {} QNC. No more emissions possible!", MAX_QNC_SUPPLY);
            return Ok(0);
        }

        // Update total supply (in nanoQNC)
        chain_state.total_supply += actual_emission;
        if emission_mb > 0 {
            chain_state.last_minted_emission_mb = emission_mb;
        }
        
        if actual_emission < amount {
            println!("⚠️ Emission limited: requested {} QNC, emitted {} QNC (remaining: {} QNC)",
                     amount / 1_000_000_000, 
                     actual_emission / 1_000_000_000, 
                     (MAX_QNC_SUPPLY_NANO - chain_state.total_supply) / 1_000_000_000);
        }
        
        Ok(actual_emission)
    }
    
    /// Get current total supply
    pub fn get_total_supply(&self) -> u64 {
        self.chain_state.read().total_supply
    }
    
    /// Get remaining supply until MAX_SUPPLY (in nanoQNC)
    pub fn get_remaining_supply(&self) -> u64 {
        MAX_QNC_SUPPLY_NANO.saturating_sub(self.get_total_supply())
    }
    
    /// Create genesis state
    pub fn create_genesis(&self) -> StateResult<()> {
        // FAIR LAUNCH IMPLEMENTATION
        // No accounts created in genesis - everyone starts with 0 QNC
        
        // Initialize chain state with proper emission tracking
        {
            let mut chain_state = self.chain_state.write();
            chain_state.height = 0;
            chain_state.total_supply = 0; // NO PREMINE - starts at 0!
            chain_state.last_minted_emission_mb = 0; // reset watermark with supply
            chain_state.epoch = 0;
            chain_state.last_finalized = 0;
        }
        
        // Calculate initial state root (empty accounts)
        self.calculate_state_root()?;
        
        println!("🚀 Genesis state created: 0 QNC total supply, Fair Launch activated!");
        println!("📈 Pool 1 Base Emission: DYNAMIC halving system (starts 251,432.34 QNC/4h)");
        println!("💎 Maximum Supply: {} QNC (2^32)", MAX_QNC_SUPPLY);

        Ok(())
    }
}

// ════════════════════════════════════════════════════════════════════════════
// v15.10 STAGE-2: LRU CACHE TESTS
// ────────────────────────────────────────────────────────────────────────────
// Pin the cache invariants used at runtime:
//   * read-through: cold address resolves through the AccountStore fallback
//   * eviction sorts by last_access; oldest entries leave first
//   * cache_capacity = 0 disables eviction entirely (legacy mode)
//   * touch refreshes timestamp so a frequently-accessed account survives
//   * warm_account is idempotent on cache hits and updates the timestamp
// ════════════════════════════════════════════════════════════════════════════
#[cfg(test)]
mod merkle_equiv_tests {
    use super::*;
    use crate::Account;

    // Deterministic pseudo-account at index i (no rand-crate dependency).
    fn mk(i: u64) -> Account {
        let mut a = Account::new(format!("acct{:060x}", i));
        a.balance = i.wrapping_mul(1_000_003);
        a.nonce = i % 7;
        a.pending_rewards = i % 13;
        a
    }

    // Audit F#6 — load-bearing invariant: the INCREMENTAL path-walk (`recompute_levels`, used by
    // `finalize` on a warm cache — i.e. every running node each block) MUST produce the same root
    // as a FULL rebuild (`recompute_root`, used on restart / snapshot-restore / rollback). If they
    // ever diverged, a restarted node would compute a different state_root than a running peer →
    // content_ok never agrees → finality stall. Exercises the incremental path over many rounds.
    #[test]
    fn incremental_root_equals_full_rebuild() {
        let accts: Vec<Account> = (0..40u64).map(mk).collect();

        // Incremental tree: 5 finalize rounds. Round 1 (cold cache) falls back to a full rebuild
        // that warms intermediate_nodes; rounds 2-5 use the incremental recompute_levels.
        let mut inc = StateMerkleTree::new();
        for chunk in accts.chunks(8) {
            for a in chunk { inc.insert_lazy(&a.address, a); }
            inc.finalize();
        }
        let root_incremental = inc.finalize();

        // Full rebuild over the SAME leaf set.
        let mut full = StateMerkleTree::new();
        for a in &accts { full.insert_lazy(&a.address, a); }
        full.recompute_root();
        assert_eq!(root_incremental, full.root,
                   "incremental finalize must equal full recompute_root after batched inserts");

        // Update existing leaves + add new ones incrementally, then compare to a fresh full rebuild.
        let updated: Vec<Account> = (0..40u64).step_by(3).map(|i| {
            let mut a = mk(i); a.balance = a.balance.wrapping_add(999); a.nonce += 1; a
        }).collect();
        let added: Vec<Account> = (40..50u64).map(mk).collect();
        for a in updated.iter().chain(added.iter()) { inc.insert_lazy(&a.address, a); }
        let root_inc2 = inc.finalize();

        let mut full2 = StateMerkleTree::new();
        for a in &accts { full2.insert_lazy(&a.address, a); }
        for a in updated.iter().chain(added.iter()) { full2.insert_lazy(&a.address, a); }
        full2.recompute_root();
        assert_eq!(root_inc2, full2.root,
                   "incremental update+insert must equal full rebuild of the final leaf set");
    }

    #[test]
    fn empty_tree_root_is_canonical() {
        let mut a = StateMerkleTree::new();
        a.recompute_root();
        let b = StateMerkleTree::new();
        assert_eq!(a.root, b.root, "empty-tree root must be the canonical default-hash root");
    }
}

#[cfg(test)]
mod cache_tests {
    use super::*;
    use crate::Account;
    use std::collections::HashMap;

    /// Mock AccountStore backed by an in-memory HashMap. Lets tests verify
    /// the read-through cache without spinning up RocksDB.
    struct MockStore {
        data: parking_lot::RwLock<HashMap<String, Account>>,
        load_count: std::sync::atomic::AtomicUsize,
    }

    impl MockStore {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                data: parking_lot::RwLock::new(HashMap::new()),
                load_count: std::sync::atomic::AtomicUsize::new(0),
            })
        }

        fn put(&self, addr: &str, account: Account) {
            self.data.write().insert(addr.to_string(), account);
        }

        fn loads(&self) -> usize {
            self.load_count.load(std::sync::atomic::Ordering::Relaxed)
        }
    }

    impl AccountStore for MockStore {
        fn load_account(&self, address: &str) -> Option<Account> {
            self.load_count.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            self.data.read().get(address).cloned()
        }
    }

    fn make_account(balance: u64) -> Account {
        let mut a = Account::default();
        a.balance = balance;
        a
    }

    /// B cutover anti-replay: claim_reward credits once per epoch and is monotonic.
    /// last_claimed_epoch is consensus-bound (SMT leaf) so this property holds network-wide.
    #[test]
    fn claim_reward_is_replay_and_monotonic_safe() {
        let sm = StateManager::new();
        // First claim for epoch 5 credits and sets the watermark.
        assert!(sm.claim_reward("w", 5, 100), "first claim must credit");
        assert_eq!(sm.accounts.get("w").unwrap().balance, 100);
        assert_eq!(sm.accounts.get("w").unwrap().last_claimed_epoch, 5);
        // Replaying the SAME epoch must be a no-op (no double credit).
        assert!(!sm.claim_reward("w", 5, 100), "replaying the same epoch must not credit");
        assert_eq!(sm.accounts.get("w").unwrap().balance, 100);
        // An OLDER epoch must be rejected (watermark is monotonic).
        assert!(!sm.claim_reward("w", 4, 100), "older epoch must not credit");
        assert_eq!(sm.accounts.get("w").unwrap().balance, 100);
        // A NEWER epoch credits and advances the watermark.
        assert!(sm.claim_reward("w", 6, 50), "newer epoch must credit");
        assert_eq!(sm.accounts.get("w").unwrap().balance, 150);
        assert_eq!(sm.accounts.get("w").unwrap().last_claimed_epoch, 6);
    }

    #[test]
    fn test_warm_account_cache_hit() {
        let sm = StateManager::new();
        sm.accounts.insert("alice".to_string(), make_account(100));

        let store = MockStore::new();
        sm.set_disk_store(store.clone() as Arc<dyn AccountStore>);

        assert!(sm.warm_account("alice"));
        // Cache hit must NOT trigger a disk load.
        assert_eq!(store.loads(), 0);
        // Touch must populate last_access.
        assert!(sm.last_access.contains_key("alice"));
    }

    #[test]
    fn test_warm_account_disk_load_populates_cache() {
        let sm = StateManager::new();
        let store = MockStore::new();
        store.put("bob", make_account(42));
        sm.set_disk_store(store.clone() as Arc<dyn AccountStore>);

        assert!(!sm.accounts.contains_key("bob"));
        assert!(sm.warm_account("bob"));
        // Disk load happened exactly once.
        assert_eq!(store.loads(), 1);
        // Cache now resident.
        assert!(sm.accounts.contains_key("bob"));
        // Subsequent warm hits cache, no extra disk read.
        assert!(sm.warm_account("bob"));
        assert_eq!(store.loads(), 1);
    }

    #[test]
    fn test_warm_account_genuine_miss_returns_false() {
        let sm = StateManager::new();
        let store = MockStore::new();
        sm.set_disk_store(store.clone() as Arc<dyn AccountStore>);

        assert!(!sm.warm_account("ghost"));
        assert!(!sm.accounts.contains_key("ghost"));
    }

    #[test]
    fn test_warm_account_no_disk_store_falls_through() {
        let sm = StateManager::new();
        // disk_store is None — warm of non-cached address must fail
        // gracefully without panicking.
        assert!(!sm.warm_account("nobody"));
    }

    #[test]
    fn test_eviction_disabled_when_capacity_zero() {
        let sm = StateManager::new();
        sm.set_cache_capacity(0);
        for i in 0..100 {
            sm.accounts.insert(format!("u{}", i), make_account(i));
        }
        let evicted = sm.evict_cold_accounts();
        assert_eq!(evicted, 0);
        assert_eq!(sm.cache_size(), 100);
    }

    #[test]
    fn test_eviction_under_capacity_is_noop() {
        let sm = StateManager::new();
        sm.set_cache_capacity(1000);
        for i in 0..50 {
            sm.accounts.insert(format!("u{}", i), make_account(i));
        }
        let evicted = sm.evict_cold_accounts();
        assert_eq!(evicted, 0);
        assert_eq!(sm.cache_size(), 50);
    }

    #[test]
    fn test_eviction_drops_oldest_first() {
        let sm = StateManager::new();
        sm.set_cache_capacity(3);
        // Populate 5 accounts with explicit ascending timestamps so the
        // sort order is deterministic regardless of test wall-clock.
        for (i, addr) in ["a", "b", "c", "d", "e"].iter().enumerate() {
            sm.accounts.insert(addr.to_string(), make_account(0));
            sm.last_access.insert(addr.to_string(), 100 + i as u64);
        }
        let evicted = sm.evict_cold_accounts();
        // 5 - 3 = 2 oldest entries evicted.
        assert_eq!(evicted, 2);
        assert_eq!(sm.cache_size(), 3);
        // The two oldest (a, b) must be gone; c/d/e remain.
        assert!(!sm.accounts.contains_key("a"));
        assert!(!sm.accounts.contains_key("b"));
        assert!(sm.accounts.contains_key("c"));
        assert!(sm.accounts.contains_key("d"));
        assert!(sm.accounts.contains_key("e"));
    }

    #[test]
    fn test_eviction_treats_missing_timestamp_as_oldest() {
        let sm = StateManager::new();
        sm.set_cache_capacity(2);
        // a has NO timestamp (treated as 0); b/c have explicit timestamps.
        sm.accounts.insert("a".to_string(), make_account(0));
        sm.accounts.insert("b".to_string(), make_account(0));
        sm.accounts.insert("c".to_string(), make_account(0));
        sm.last_access.insert("b".to_string(), 200);
        sm.last_access.insert("c".to_string(), 300);
        let evicted = sm.evict_cold_accounts();
        assert_eq!(evicted, 1);
        // a (no timestamp) evicted first.
        assert!(!sm.accounts.contains_key("a"));
        assert!(sm.accounts.contains_key("b"));
        assert!(sm.accounts.contains_key("c"));
    }

    #[test]
    fn test_touch_access_refreshes_timestamp() {
        let sm = StateManager::new();
        sm.accounts.insert("hot".to_string(), make_account(0));
        // Pre-touch to capture the logical-clock baseline.
        sm.touch_access("hot");
        let first = *sm.last_access.get("hot").unwrap();
        // Touch again: the monotonic logical clock guarantees a strictly
        // greater value, even when the two calls happen within the same
        // wall-clock millisecond.
        sm.touch_access("hot");
        let second = *sm.last_access.get("hot").unwrap();
        assert!(second > first, "logical clock must advance: {} → {}", first, second);
    }

    #[test]
    fn test_warm_accounts_batch_returns_resident_count() {
        let sm = StateManager::new();
        let store = MockStore::new();
        store.put("on_disk_1", make_account(1));
        store.put("on_disk_2", make_account(2));
        sm.set_disk_store(store.clone() as Arc<dyn AccountStore>);
        // Already resident
        sm.accounts.insert("in_cache".to_string(), make_account(3));

        let batch: Vec<String> = vec![
            "in_cache".to_string(),
            "on_disk_1".to_string(),
            "on_disk_2".to_string(),
            "ghost".to_string(),
        ];
        let resident = sm.warm_accounts(&batch);
        // Three of the four are resident: in_cache (was already there)
        // plus on_disk_1 + on_disk_2 (loaded from disk and inserted into
        // the cache). `ghost` is genuinely absent from the disk store.
        assert_eq!(resident, 3);
        // Disk was probed three times — once for every cache miss
        // (on_disk_1, on_disk_2, ghost). The "ghost" probe still costs
        // a single point read because we cannot tell up-front whether
        // an address exists on disk; the cost is bounded and
        // benign at production address counts.
        assert_eq!(store.loads(), 3);
        // Cache must contain the two newly-loaded entries plus the
        // pre-existing one — but NOT `ghost` (genuinely absent).
        assert!(sm.accounts.contains_key("in_cache"));
        assert!(sm.accounts.contains_key("on_disk_1"));
        assert!(sm.accounts.contains_key("on_disk_2"));
        assert!(!sm.accounts.contains_key("ghost"));
    }

    #[test]
    fn test_set_cache_capacity_changes_value() {
        let sm = StateManager::new();
        assert_eq!(sm.cache_capacity_value(), 0);
        sm.set_cache_capacity(123_456);
        assert_eq!(sm.cache_capacity_value(), 123_456);
    }

    // ════════════════════════════════════════════════════════════════════════
    // v15.10 STAGE-2: METRICS COUNTERS
    // ────────────────────────────────────────────────────────────────────────
    #[test]
    fn test_metrics_initial_state() {
        let sm = StateManager::new();
        let (hits, misses, dh, dm, ev) = sm.cache_metrics();
        assert_eq!(hits, 0);
        assert_eq!(misses, 0);
        assert_eq!(dh, 0);
        assert_eq!(dm, 0);
        assert_eq!(ev, 0);
        // No traffic yet → ratio reported as 100% (no problem signal).
        assert_eq!(sm.cache_hit_ratio_bps(), 10_000);
    }

    #[test]
    fn test_metrics_track_warm_outcomes() {
        let sm = StateManager::new();
        let store = MockStore::new();
        store.put("disk_a", make_account(1));
        sm.set_disk_store(store.clone() as Arc<dyn AccountStore>);
        sm.accounts.insert("ram_a".to_string(), make_account(2));

        // Cache hit
        sm.warm_account("ram_a");
        // Disk hit (was on disk, now cached)
        sm.warm_account("disk_a");
        // Genuine miss
        sm.warm_account("ghost");

        let (hits, misses, dh, dm, _) = sm.cache_metrics();
        assert_eq!(hits, 1);     // ram_a
        assert_eq!(misses, 2);   // disk_a + ghost
        assert_eq!(dh, 1);       // disk_a found
        assert_eq!(dm, 1);       // ghost not on disk
    }

    #[test]
    fn test_metrics_evictions_counter_accumulates() {
        let sm = StateManager::new();
        sm.set_cache_capacity(2);
        for i in 0..5 {
            sm.accounts.insert(format!("u{}", i), make_account(0));
            sm.last_access.insert(format!("u{}", i), 100 + i as u64);
        }
        // First sweep: drop 3.
        let evicted_a = sm.evict_cold_accounts();
        assert_eq!(evicted_a, 3);
        // Second sweep: nothing to do.
        let evicted_b = sm.evict_cold_accounts();
        assert_eq!(evicted_b, 0);
        let (_, _, _, _, total) = sm.cache_metrics();
        assert_eq!(total, 3);
    }

    #[test]
    fn test_metrics_hit_ratio_basis_points() {
        let sm = StateManager::new();
        sm.accounts.insert("hot".to_string(), make_account(0));
        // 9 hits, 1 miss → 9000 bps
        for _ in 0..9 {
            sm.warm_account("hot");
        }
        sm.warm_account("ghost"); // genuine miss, no disk store
        assert_eq!(sm.cache_hit_ratio_bps(), 9_000);
    }

    // ════════════════════════════════════════════════════════════════════════
    // v15.10 STAGE-2: STRESS TEST AT 100 K+ ACCOUNTS
    // ────────────────────────────────────────────────────────────────────────
    // Simulates the production cache scenario with a working set vastly
    // larger than the cap. Validates that:
    //   * the cache size never exceeds the cap after eviction sweeps,
    //   * cold reads round-trip through the disk store correctly,
    //   * hit ratio approximates the working-set vs cap arithmetic,
    //   * eviction is deterministic against last_access timestamps.
    //
    // Uses a 50 K total set and a 1 K cap to keep the test bounded for
    // CI (~50 ms wall-clock); the policy under test scales identically
    // to the 100 M-vs-500 K production ratio.
    // ════════════════════════════════════════════════════════════════════════
    #[test]
    fn test_stress_eviction_keeps_size_within_cap() {
        const TOTAL_ACCOUNTS: usize = 50_000;
        const CACHE_CAP: usize = 1_000;

        let sm = StateManager::new();
        let store = MockStore::new();
        // Pre-populate the disk store with TOTAL_ACCOUNTS entries.
        for i in 0..TOTAL_ACCOUNTS {
            store.put(&format!("acc_{:06}", i), make_account(i as u64));
        }
        sm.set_disk_store(store.clone() as Arc<dyn AccountStore>);
        sm.set_cache_capacity(CACHE_CAP);

        // Walk the entire address space; each warm causes a cold load
        // and an insert. Periodically evict to keep size bounded.
        for i in 0..TOTAL_ACCOUNTS {
            assert!(sm.warm_account(&format!("acc_{:06}", i)));
            if i > 0 && i % 5_000 == 0 {
                sm.evict_cold_accounts();
                assert!(
                    sm.cache_size() <= CACHE_CAP,
                    "cache size {} exceeded cap {} at i={}", sm.cache_size(), CACHE_CAP, i,
                );
            }
        }
        // Final eviction sweep must bring the cache to exactly the cap.
        sm.evict_cold_accounts();
        assert_eq!(sm.cache_size(), CACHE_CAP);
        // Every address was on disk → every miss had a disk hit.
        let (_, misses, dh, dm, ev) = sm.cache_metrics();
        // First touch of each address is a miss.
        assert!(misses >= TOTAL_ACCOUNTS as u64);
        // Disk found everything (no genuine misses).
        assert_eq!(dh, misses);
        assert_eq!(dm, 0);
        // Many evictions.
        assert!(ev > 0);
    }

    #[test]
    fn test_stress_hot_path_stays_resident() {
        const HOT_SET_SIZE: usize = 100;
        const COLD_SET_SIZE: usize = 5_000;
        const CACHE_CAP: usize = 200;

        let sm = StateManager::new();
        let store = MockStore::new();
        // Hot accounts AND cold accounts both live on disk.
        for i in 0..HOT_SET_SIZE {
            store.put(&format!("hot_{:04}", i), make_account(i as u64));
        }
        for i in 0..COLD_SET_SIZE {
            store.put(&format!("cold_{:06}", i), make_account(1_000_000 + i as u64));
        }
        sm.set_disk_store(store.clone() as Arc<dyn AccountStore>);
        sm.set_cache_capacity(CACHE_CAP);

        // Warm hot set first — these get the OLDEST timestamps (we'll
        // touch them again later to bring them forward).
        for i in 0..HOT_SET_SIZE {
            sm.warm_account(&format!("hot_{:04}", i));
        }

        // Walk through the cold set, repeatedly re-touching the hot
        // accounts so their last_access timestamp stays fresh.
        for i in 0..COLD_SET_SIZE {
            sm.warm_account(&format!("cold_{:06}", i));
            // Every 50 cold reads, refresh every hot account.
            if i % 50 == 0 {
                for j in 0..HOT_SET_SIZE {
                    sm.warm_account(&format!("hot_{:04}", j));
                }
                sm.evict_cold_accounts();
            }
        }
        sm.evict_cold_accounts();

        // After all the churn, every hot account must still be resident:
        // the eviction sweep picks the OLDEST entries first, and the hot
        // set is kept fresh by the periodic refresh above.
        let mut hot_resident = 0usize;
        for i in 0..HOT_SET_SIZE {
            if sm.accounts.contains_key(&format!("hot_{:04}", i)) {
                hot_resident += 1;
            }
        }
        assert_eq!(
            hot_resident, HOT_SET_SIZE,
            "hot set must stay resident across cold-read churn",
        );
        // Cache size respects cap.
        assert!(sm.cache_size() <= CACHE_CAP);
    }

    // ════════════════════════════════════════════════════════════════════════
    // v15.10 STAGE-2A: STATE PARTITIONING — DETERMINISTIC ASSIGNMENT TESTS
    // ────────────────────────────────────────────────────────────────────────
    // These pin the canonical shard-assignment invariants that Stage-2B
    // and Stage-2C will rely on once the per-shard consensus path lands:
    //   * deterministic — same input always maps to the same shard,
    //   * stateless — no hidden dependencies on StateManager state,
    //   * uniform — load distribution across shards is balanced for
    //     a representative input set,
    //   * range-bounded — output is always strictly less than num_shards.
    // ════════════════════════════════════════════════════════════════════════

    #[test]
    fn test_shard_index_deterministic() {
        // Same input → same output, every time.
        let a1 = account_shard_index("alice", 16);
        let a2 = account_shard_index("alice", 16);
        let a3 = account_shard_index("alice", 16);
        assert_eq!(a1, a2);
        assert_eq!(a2, a3);
    }

    #[test]
    fn test_shard_index_within_range() {
        for n in [1u32, 2, 4, 16, 64, 256] {
            for sample in &["a", "bob", "long-account-id-for-shard-test", "0xdeadbeef"] {
                let idx = account_shard_index(sample, n);
                assert!(idx < n, "addr={} n={} idx={}", sample, n, idx);
            }
        }
    }

    #[test]
    fn test_shard_index_zero_treated_as_one() {
        // num_shards = 0 must NOT panic and must not divide-by-zero.
        // Treated identically to num_shards = 1 (single-shard fallback).
        for sample in &["alpha", "beta", "gamma"] {
            assert_eq!(account_shard_index(sample, 0), 0);
            assert_eq!(account_shard_index(sample, 1), 0);
        }
    }

    #[test]
    fn test_shard_index_empty_address_returns_zero() {
        assert_eq!(account_shard_index("", 16), 0);
        assert_eq!(account_shard_index("", 1), 0);
        assert_eq!(account_shard_index("", 256), 0);
    }

    #[test]
    fn test_shard_index_uniform_distribution_over_large_input() {
        // 10 000 distinct addresses spread across 16 shards. Per-shard
        // count should be 10000/16 = 625 with √-bounded variance. We
        // check that every shard receives at least 75 % of mean — well
        // within the law-of-large-numbers tail for Blake3.
        const N: u32 = 16;
        const TOTAL: usize = 10_000;
        let mut bucket = [0usize; 16];
        for i in 0..TOTAL {
            let addr = format!("acc_{:08}", i);
            let s = account_shard_index(&addr, N);
            bucket[s as usize] += 1;
        }
        let mean = TOTAL / N as usize;
        let floor = mean * 75 / 100;
        for (s, count) in bucket.iter().enumerate() {
            assert!(
                *count >= floor,
                "shard {} got {} samples (mean {}, floor {})",
                s, count, mean, floor,
            );
        }
    }

    #[test]
    fn test_state_manager_default_single_shard() {
        let sm = StateManager::new();
        // Default num_shards == 1 keeps Stage-2A inactive.
        assert_eq!(sm.num_shards(), 1);
        // Every address maps to shard 0 under default config.
        for addr in &["alice", "bob", "carol"] {
            assert_eq!(sm.shard_for(addr), 0);
        }
    }

    #[test]
    fn test_state_manager_set_num_shards_round_trip() {
        let sm = StateManager::new();
        sm.set_num_shards(64);
        assert_eq!(sm.num_shards(), 64);
        // shard_for now respects the new count.
        let s = sm.shard_for("alice");
        assert!(s < 64);
        // Rejecting `0` keeps the previous value.
        sm.set_num_shards(0);
        assert_eq!(sm.num_shards(), 64);
    }

    #[test]
    fn test_state_manager_shard_for_matches_account_shard_index() {
        let sm = StateManager::new();
        sm.set_num_shards(32);
        for addr in &["alice", "bob", "0xdeadbeef", "long-test-address-id"] {
            assert_eq!(
                sm.shard_for(addr),
                account_shard_index(addr, 32),
                "shard_for must match the static helper for addr={}", addr,
            );
        }
    }

    #[test]
    fn test_stress_concurrent_warms_remain_consistent() {
        use std::sync::Arc as StdArc;
        use std::thread;

        const WORKERS: usize = 8;
        const PER_WORKER: usize = 2_000;
        const CACHE_CAP: usize = 500;

        let sm = StdArc::new(StateManager::new());
        let store = MockStore::new();
        for i in 0..(WORKERS * PER_WORKER) {
            store.put(&format!("a_{:06}", i), make_account(i as u64));
        }
        sm.set_disk_store(store.clone() as Arc<dyn AccountStore>);
        sm.set_cache_capacity(CACHE_CAP);

        // Spawn workers that each walk a disjoint slice of the address
        // space. Every worker hits a unique key set so the only
        // contention is on the shared DashMap / metrics counters.
        let mut handles = Vec::new();
        for w in 0..WORKERS {
            let sm_clone = sm.clone();
            handles.push(thread::spawn(move || {
                let start = w * PER_WORKER;
                for i in start..(start + PER_WORKER) {
                    sm_clone.warm_account(&format!("a_{:06}", i));
                }
            }));
        }
        for h in handles {
            h.join().expect("worker thread panicked");
        }

        // Eviction may have run concurrently on no thread — call it now
        // so the cap invariant holds.
        sm.evict_cold_accounts();
        assert!(
            sm.cache_size() <= CACHE_CAP,
            "concurrent warm produced cache size {} > cap {}",
            sm.cache_size(), CACHE_CAP,
        );
        // Every worker contributed PER_WORKER misses (first-time loads).
        let (_, misses, dh, dm, _) = sm.cache_metrics();
        assert_eq!(misses, (WORKERS * PER_WORKER) as u64);
        assert_eq!(dh, misses); // all addresses existed on disk
        assert_eq!(dm, 0);
    }
}

// =========================================================================
// v32.14: level-synchronous SMT tests — verify incremental matches full rebuild
// =========================================================================
#[cfg(test)]
mod level_sync_tests {
    use super::*;
    use crate::Account;

    fn acct(balance: u64, nonce: u64, addr: &str) -> Account {
        let mut a = Account::default();
        a.balance = balance;
        a.nonce = nonce;
        a.address = addr.to_string();
        a
    }

    /// Full-rebuild reference: build a fresh tree with the given accounts via
    /// the cold-start path (recompute_root only).
    fn full_rebuild_root(accounts: &[(String, Account)]) -> [u8; 32] {
        let mut tree = StateMerkleTree::new();
        for (addr, acc) in accounts {
            tree.insert_lazy(addr, acc);
        }
        // Force full rebuild path by disabling incremental for this call.
        tree.incremental_enabled = false;
        let root = tree.finalize();
        tree.incremental_enabled = true;
        root
    }

    #[test]
    fn level_sync_matches_full_rebuild_two_steps() {
        let initial: Vec<(String, Account)> = (0..10)
            .map(|i| (format!("addr_{}", i), acct(100 * i, i, &format!("addr_{}", i))))
            .collect();
        let added: Vec<(String, Account)> = (10..15)
            .map(|i| (format!("addr_{}", i), acct(100 * i, i, &format!("addr_{}", i))))
            .collect();

        // Incremental path: cold start with initial → finalize (full rebuild populates
        // intermediate); then insert `added` → finalize uses level-sync incremental.
        let mut tree = StateMerkleTree::new();
        for (a, c) in &initial { tree.insert_lazy(a, c); }
        let _ = tree.finalize(); // cold-start full rebuild
        for (a, c) in &added { tree.insert_lazy(a, c); }
        let incremental_root = tree.finalize(); // level-sync path

        // Reference: full rebuild over the combined set.
        let mut combined = initial.clone();
        combined.extend(added.iter().cloned());
        let reference_root = full_rebuild_root(&combined);

        assert_eq!(incremental_root, reference_root,
            "level-sync incremental root must match full rebuild over combined leaves");
    }

    #[test]
    fn level_sync_matches_full_rebuild_many_steps() {
        let total = 50;
        let chunk = 5;
        let all: Vec<(String, Account)> = (0..total)
            .map(|i| (format!("acc_{:03}", i), acct(1_000 + i as u64, i as u64, &format!("acc_{:03}", i))))
            .collect();

        // Incremental: insert in `chunk`-sized batches with finalize between each.
        let mut tree = StateMerkleTree::new();
        for batch in all.chunks(chunk) {
            for (a, c) in batch { tree.insert_lazy(a, c); }
            let _ = tree.finalize();
        }
        let incremental_root = tree.finalize();

        let reference_root = full_rebuild_root(&all);
        assert_eq!(incremental_root, reference_root,
            "level-sync after many incremental finalize calls must match full rebuild");
    }

    #[test]
    fn level_sync_handles_remove_lazy() {
        let initial: Vec<(String, Account)> = (0..20)
            .map(|i| (format!("k_{:02}", i), acct(50 + i as u64, i as u64, &format!("k_{:02}", i))))
            .collect();

        // Build then remove a subset incrementally.
        let mut tree = StateMerkleTree::new();
        for (a, c) in &initial { tree.insert_lazy(a, c); }
        let _ = tree.finalize();
        for i in [3usize, 7, 11, 19] {
            tree.remove_lazy(&format!("k_{:02}", i));
        }
        let incremental_root = tree.finalize();

        // Reference: full rebuild with the removed entries omitted.
        let kept: Vec<(String, Account)> = initial.into_iter()
            .filter(|(a, _)| ![3usize, 7, 11, 19].iter().any(|i| a == &format!("k_{:02}", i)))
            .collect();
        let reference_root = full_rebuild_root(&kept);

        assert_eq!(incremental_root, reference_root,
            "level-sync after remove_lazy must match full rebuild over remaining leaves");
    }

    #[test]
    fn level_sync_update_existing() {
        let alice = acct(100, 0, "alice");
        let bob = acct(200, 0, "bob");
        let mut tree = StateMerkleTree::new();
        tree.insert_lazy("alice", &alice);
        tree.insert_lazy("bob", &bob);
        let _ = tree.finalize();

        // Update Alice's balance — incremental path
        let alice2 = acct(999, 1, "alice");
        tree.insert_lazy("alice", &alice2);
        let incremental_root = tree.finalize();

        // Reference: fresh build with final values
        let reference_root = full_rebuild_root(&[
            ("alice".to_string(), alice2),
            ("bob".to_string(), bob),
        ]);
        assert_eq!(incremental_root, reference_root,
            "update via incremental must match full rebuild");
    }

    #[test]
    fn level_sync_insertion_order_independent() {
        let pairs: Vec<(String, Account)> = (0..15)
            .map(|i| (format!("p_{}", i), acct(7 * i as u64, i as u64, &format!("p_{}", i))))
            .collect();

        // Order A: ascending
        let mut tree_a = StateMerkleTree::new();
        for (a, c) in &pairs { tree_a.insert_lazy(a, c); }
        let _ = tree_a.finalize();
        let root_a = tree_a.finalize();

        // Order B: reversed
        let mut tree_b = StateMerkleTree::new();
        for (a, c) in pairs.iter().rev() { tree_b.insert_lazy(a, c); }
        let _ = tree_b.finalize();
        let root_b = tree_b.finalize();

        // Order C: shuffled deterministically (rotate)
        let mut shuffled = pairs.clone();
        shuffled.rotate_left(7);
        let mut tree_c = StateMerkleTree::new();
        for (a, c) in &shuffled { tree_c.insert_lazy(a, c); }
        let _ = tree_c.finalize();
        let root_c = tree_c.finalize();

        assert_eq!(root_a, root_b, "root must be insertion-order-independent (asc vs desc)");
        assert_eq!(root_a, root_c, "root must be insertion-order-independent (rotate)");
    }

    #[test]
    fn level_sync_empty_after_remove_all() {
        let one = acct(1, 0, "only");
        let mut tree = StateMerkleTree::new();
        tree.insert_lazy("only", &one);
        let _ = tree.finalize();
        let default_root = StateMerkleTree::new().root_unchecked();
        tree.remove_lazy("only");
        let after_root = tree.finalize();
        assert_eq!(after_root, default_root,
            "tree drained of all leaves must collapse to the empty-tree default root");
    }

    #[test]
    fn level_sync_single_account_incremental() {
        let acc = acct(42, 0, "single");
        // Step 1: cold-start with one account
        let mut tree = StateMerkleTree::new();
        tree.insert_lazy("single", &acc);
        let cold_root = tree.finalize();

        // Step 2: incremental update on same single account
        let acc2 = acct(43, 1, "single");
        tree.insert_lazy("single", &acc2);
        let incremental_root = tree.finalize();

        // Reference: fresh tree with updated value
        let reference_root = full_rebuild_root(&[("single".to_string(), acc2)]);
        assert_eq!(incremental_root, reference_root,
            "single-account incremental update must match full rebuild");
        assert_ne!(cold_root, incremental_root,
            "value change must produce different root");
    }
}

#[cfg(test)]
mod proof_tests {
    use super::*;
    use crate::Account;

    fn acct(balance: u64, nonce: u64, addr: &str) -> Account {
        let mut a = Account::default();
        a.balance = balance;
        a.nonce = nonce;
        a.address = addr.to_string();
        a
    }

    /// Single-account inclusion proof must verify against the real state_root.
    #[test]
    fn proof_round_trip_single_account() {
        let alice = acct(1_000, 0, "alice");
        let mut tree = StateMerkleTree::new();
        tree.insert_lazy("alice", &alice);
        let root = tree.finalize();

        let proof = tree.generate_proof("alice");
        assert_eq!(proof.len(), TREE_DEPTH, "proof length must equal TREE_DEPTH");
        assert!(
            StateMerkleTree::verify_proof("alice", &alice, &proof, &root),
            "single-account proof must verify against real state_root"
        );
    }

    /// Multi-account inclusion proof must verify for each leaf independently.
    #[test]
    fn proof_round_trip_multi_account() {
        let pairs: Vec<(String, Account)> = (0..20)
            .map(|i| (format!("user_{:02}", i), acct(100 * i as u64, i as u64, &format!("user_{:02}", i))))
            .collect();

        let mut tree = StateMerkleTree::new();
        for (a, c) in &pairs { tree.insert_lazy(a, c); }
        let root = tree.finalize();

        for (addr, acc) in &pairs {
            let proof = tree.generate_proof(addr);
            assert!(
                StateMerkleTree::verify_proof(addr, acc, &proof, &root),
                "proof for {} must verify against multi-account state_root", addr
            );
        }
    }

    /// Wrong account data must NOT verify (forgery resistance).
    #[test]
    fn proof_rejects_wrong_data() {
        let alice = acct(100, 0, "alice");
        let mut tree = StateMerkleTree::new();
        tree.insert_lazy("alice", &alice);
        let _ = tree.finalize();
        let proof = tree.generate_proof("alice");
        let root = tree.root_unchecked();

        let forged = acct(9_999_999, 0, "alice");
        assert!(
            !StateMerkleTree::verify_proof("alice", &forged, &proof, &root),
            "proof must reject forged balance"
        );
    }

    /// Proof generated after incremental update must verify against the new root.
    #[test]
    fn proof_after_incremental_update() {
        let alice = acct(100, 0, "alice");
        let bob = acct(200, 0, "bob");
        let mut tree = StateMerkleTree::new();
        tree.insert_lazy("alice", &alice);
        tree.insert_lazy("bob", &bob);
        let _ = tree.finalize();

        let alice_v2 = acct(555, 1, "alice");
        tree.insert_lazy("alice", &alice_v2);
        let new_root = tree.finalize();

        let proof_alice = tree.generate_proof("alice");
        let proof_bob = tree.generate_proof("bob");

        assert!(
            StateMerkleTree::verify_proof("alice", &alice_v2, &proof_alice, &new_root),
            "post-update proof for updated leaf must verify"
        );
        assert!(
            StateMerkleTree::verify_proof("bob", &bob, &proof_bob, &new_root),
            "post-update proof for unchanged leaf must verify"
        );
    }

    /// Proof must reject the old account value after an incremental update.
    #[test]
    fn proof_rejects_stale_value_after_update() {
        let alice_v1 = acct(100, 0, "alice");
        let mut tree = StateMerkleTree::new();
        tree.insert_lazy("alice", &alice_v1);
        let _ = tree.finalize();

        let alice_v2 = acct(555, 1, "alice");
        tree.insert_lazy("alice", &alice_v2);
        let new_root = tree.finalize();

        let proof = tree.generate_proof("alice");
        assert!(
            !StateMerkleTree::verify_proof("alice", &alice_v1, &proof, &new_root),
            "proof must not verify against the pre-update account value"
        );
    }

    /// Production-scale shape: many accounts, prove a randomly-chosen subset.
    #[test]
    fn proof_round_trip_at_scale() {
        let n = 500;
        let accounts: Vec<(String, Account)> = (0..n)
            .map(|i| (format!("acc_{:05}", i), acct(1_000 + i as u64, i as u64, &format!("acc_{:05}", i))))
            .collect();

        let mut tree = StateMerkleTree::new();
        for (a, c) in &accounts { tree.insert_lazy(a, c); }
        let root = tree.finalize();

        // sample every 37th — covers spread without N² blowup
        for i in (0..n).step_by(37) {
            let (addr, acc) = &accounts[i];
            let proof = tree.generate_proof(addr);
            assert!(
                StateMerkleTree::verify_proof(addr, acc, &proof, &root),
                "proof for {} (i={}) must verify in 500-account tree", addr, i
            );
        }
    }

    /// Proof for address A must NOT verify against address B's leaf hash.
    #[test]
    fn proof_address_binding() {
        let alice = acct(100, 0, "alice");
        let bob = acct(200, 0, "bob");
        let mut tree = StateMerkleTree::new();
        tree.insert_lazy("alice", &alice);
        tree.insert_lazy("bob", &bob);
        let root = tree.finalize();

        let alice_proof = tree.generate_proof("alice");
        // Using alice's proof + bob's account = address-mismatched verify
        // must fail because verify_proof reconstructs the path from
        // bob's address but uses alice's siblings.
        assert!(
            !StateMerkleTree::verify_proof("bob", &bob, &alice_proof, &root),
            "alice's proof must not verify bob's account"
        );
    }
}

#[cfg(test)]
mod fork_flag_determinism_tests {
    use super::*;
    use crate::Account;

    fn acct_pr(balance: u64, pending: u64, addr: &str) -> Account {
        let mut a = Account::default();
        a.balance = balance;
        a.address = addr.to_string();
        a.pending_rewards = pending;
        a
    }

    /// Reproduces production consensus split: a zero-pending account hashes
    /// DIFFERENTLY depending on the runtime PENDING_REWARDS_IN_MERKLE flag.
    /// This non-determinism is the root cause — any full rebuild after the flag
    /// flips re-hashes genesis accounts differently from the running incremental
    /// state. Must run single-threaded (global flag).
    #[test]
    fn hash_account_must_be_flag_independent() {
        reset_pending_rewards_in_merkle();
        let a = acct_pr(1000, 0, "genesis_acct"); // pending=0
        let h_off = StateMerkleTree::hash_account(&a);
        activate_pending_rewards_in_merkle();
        let h_on = StateMerkleTree::hash_account(&a);
        reset_pending_rewards_in_merkle();
        assert_eq!(h_off, h_on,
            "zero-pending account must hash identically regardless of flag — \
             a flag-dependent hash makes merkle non-deterministic across \
             running vs rebuilt nodes");
    }

    /// End-to-end: genesis hashed flag=false, flip flag, accrue, then full
    /// rebuild with flag=true → incremental root must equal full rebuild root.
    #[test]
    fn incremental_must_equal_full_across_flag_flip() {
        reset_pending_rewards_in_merkle();
        let genesis: Vec<(String, Account)> = (0..10)
            .map(|i| (format!("g_{}", i), acct_pr(1000 + i as u64, 0, &format!("g_{}", i))))
            .collect();
        let mut tree = StateMerkleTree::new();
        for (a, c) in &genesis { tree.insert_lazy(a, c); }
        let _ = tree.finalize(); // full rebuild, flag=false

        activate_pending_rewards_in_merkle(); // emission flips flag
        let r1 = acct_pr(0, 50286, "reward_1");
        let r2 = acct_pr(0, 50286, "reward_2");
        tree.insert_lazy("reward_1", &r1);
        tree.insert_lazy("reward_2", &r2);
        let incremental_root = tree.finalize(); // incremental; 10 genesis kept flag=false hashes

        // Rollback/snapshot path: rebuild from scratch with flag=true.
        let mut combined = genesis.clone();
        combined.push(("reward_1".to_string(), r1));
        combined.push(("reward_2".to_string(), r2));
        let mut tree2 = StateMerkleTree::new();
        for (a, c) in &combined { tree2.insert_lazy(a, c); }
        tree2.incremental_enabled = false;
        let full_root = tree2.finalize(); // full rebuild, flag=true → all re-hashed

        reset_pending_rewards_in_merkle();
        assert_eq!(incremental_root, full_root,
            "running incremental root must equal post-rollback full rebuild root");
    }
}

