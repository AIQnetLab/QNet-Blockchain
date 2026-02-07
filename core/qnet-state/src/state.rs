//! State management for QNet blockchain
//! v3.11: Added State Merkle Tree for Light client proofs
//! v3.26: Added atomic fee crediting protection (race condition fix)
//! v3.39: Block snapshot for state_root mismatch recovery (rare error case)

use std::collections::{HashMap, HashSet, BTreeMap};
use std::sync::Arc;
use dashmap::DashMap;
use parking_lot::RwLock as ParkingRwLock;
use once_cell::sync::Lazy;
use crate::{Account, Block, Transaction, TransactionType, StateError, StateResult};
use sha3::{Sha3_256, Digest};

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
const TREE_DEPTH: usize = 160; // Use 160-bit depth (enough for billions of accounts)

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
    }
    
    /// v3.22: Batch insert multiple accounts WITHOUT root recomputation
    /// Use for Genesis block or large batch operations
    /// O(m) where m = number of updates, no tree traversal
    pub fn insert_batch(&mut self, updates: &[(String, Account)]) {
        for (address, account) in updates {
            let addr_hash = Self::hash_address(address);
            let account_hash = Self::hash_account(account);
            self.leaves.insert(addr_hash, account_hash);
        }
        self.dirty = true;
        self.pending_updates += updates.len();
    }
    
    /// v3.22: Finalize tree - recompute root if dirty
    /// Call once after all block transactions applied
    /// O(n) where n = total leaves, but called only ONCE per block
    pub fn finalize(&mut self) -> [u8; HASH_SIZE] {
        if self.dirty {
            let updates = self.pending_updates;
            self.recompute_root();
            self.dirty = false;
            self.pending_updates = 0;
            if updates > 0 {
                println!("[INF][MERKLE] state_root_finalized updates={} leaves={} root={}", 
                         updates, self.leaves.len(), hex::encode(&self.root[..8]));
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
    
    /// Remove account
    pub fn remove(&mut self, address: &str) -> [u8; HASH_SIZE] {
        let addr_hash = Self::hash_address(address);
        self.leaves.remove(&addr_hash);
        self.dirty = true;
        self.pending_updates += 1;
        // For remove, we recompute immediately (rare operation)
        self.finalize()
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
    
    /// Generate proof for address
    pub fn generate_proof(&self, address: &str) -> Vec<([u8; HASH_SIZE], bool)> {
        let addr_hash = Self::hash_address(address);
        let mut proof = Vec::with_capacity(TREE_DEPTH);
        
        for depth in 0..TREE_DEPTH {
            let bit = Self::get_bit(&addr_hash, depth);
            let mut sibling_key = addr_hash;
            Self::flip_bit(&mut sibling_key, depth);
            
            let sibling_hash = self.leaves.get(&sibling_key)
                .copied()
                .unwrap_or(self.default_hashes[0]);
            
            proof.push((sibling_hash, bit));
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
        hasher.update(b"QNET_ACCOUNT:");
        hasher.update(&account.balance.to_le_bytes());
        hasher.update(&account.nonce.to_le_bytes());
        hasher.update(&account.pending_rewards.to_le_bytes());
        hasher.update(account.address.as_bytes());
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
            return;
        }
        
        // For sparse tree, compute path from each leaf to root
        // Then combine at common ancestors
        let mut current_level = self.leaves.clone();
        let mut buffer = [0u8; HASH_SIZE * 2];
        
        for depth in 0..TREE_DEPTH {
            let default = self.default_hashes[depth];
            // v3.40: BTreeMap for deterministic iteration order
            let mut next_level: BTreeMap<[u8; HASH_SIZE], [u8; HASH_SIZE]> = BTreeMap::new();
            let mut processed: std::collections::HashSet<[u8; HASH_SIZE]> = std::collections::HashSet::new();
            
            for (key, value) in current_level.iter() {
                if processed.contains(key) {
                    continue;
                }
                
                // Get parent key
                let mut parent_key = *key;
                Self::flip_bit(&mut parent_key, depth);
                let is_right = Self::get_bit(key, depth);
                
                // Get sibling
                let mut sibling_key = *key;
                Self::flip_bit(&mut sibling_key, depth);
                let sibling = current_level.get(&sibling_key).copied().unwrap_or(default);
                
                // Compute parent hash
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
                
                // v3.40: CRITICAL FIX - Parent key must have bit CLEARED (set to 0)
                // NOT flipped! Both siblings must map to SAME parent.
                // Old code: only flipped for is_right, causing inconsistent parent keys
                let mut actual_parent = *key;
                let byte_idx = depth / 8;
                let bit_idx = 7 - (depth % 8);
                if byte_idx < HASH_SIZE {
                    actual_parent[byte_idx] &= !(1 << bit_idx);  // CLEAR bit, not flip!
                }
                
                next_level.insert(actual_parent, parent_hash);
                processed.insert(*key);
                processed.insert(sibling_key);
            }
            
            current_level = next_level;
            if current_level.len() <= 1 {
                break;
            }
        }
        
        self.root = current_level.values().next().copied()
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

/// Block-level snapshot for full block rollback on state_root mismatch
/// Created ONCE per block - used only when state_root verification fails
/// Memory: O(n) where n = accounts, but happens once per 1-second block
#[derive(Clone)]
pub struct BlockSnapshot {
    /// Full accounts snapshot
    accounts: HashMap<String, Account>,
    /// Block height
    height: u64,
}

impl BlockSnapshot {
    /// Create snapshot of current state (O(n) but ONCE per block)
    pub fn new(accounts: &DashMap<String, Account>, height: u64) -> Self {
        Self {
            accounts: accounts.iter().map(|e| (e.key().clone(), e.value().clone())).collect(),
            height,
        }
    }
    
    /// Get accounts for restore
    pub fn accounts(&self) -> &HashMap<String, Account> {
        &self.accounts
    }
    
    /// Get snapshot height
    pub fn height(&self) -> u64 {
        self.height
    }
}

/// State manager for blockchain
/// v3.11: Integrated State Merkle Tree for trustless balance proofs
/// v3.33: Removed unused ValidatorSet - using MacroBlock.eligible_producers instead
pub struct StateManager {
    /// Accounts state
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
        }
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
            proof,
            state_root,
            block_height: chain_state.height,
        })
    }
    
    /// Verify a balance proof (static method for Light clients)
    pub fn verify_balance_proof(proof: &BalanceProof) -> bool {
        // Reconstruct account from proof data
        // Note: Only balance/nonce are verified, other fields use defaults
        let account = Account {
            address: proof.address.clone(),
            balance: proof.balance,
            nonce: proof.nonce,
            pending_rewards: 0,
            is_node: false,
            node_type: None,
            reputation: 0.70, // Default reputation
            created_at: 0,
            updated_at: 0,
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
        
        // Get mutable access to accounts
        let mut accounts_map = HashMap::new();
        
        // Copy relevant accounts
        if let Some(acc) = self.accounts.get(&tx.from) {
            accounts_map.insert(tx.from.clone(), acc.clone());
        }
        
        if let Some(to) = &tx.to {
            if let Some(acc) = self.accounts.get(to) {
                accounts_map.insert(to.clone(), acc.clone());
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
        
        // Get mutable access to accounts
        let mut accounts_map = HashMap::new();
        
        // Copy relevant accounts
        if let Some(acc) = self.accounts.get(&tx.from) {
            accounts_map.insert(tx.from.clone(), acc.clone());
        }
        
        if let Some(to) = &tx.to {
            if let Some(acc) = self.accounts.get(to) {
                accounts_map.insert(to.clone(), acc.clone());
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
    
    /// v3.22: Apply block with batch Merkle processing
    /// Optimized for 100K+ TPS - single Merkle finalization after all TX
    /// 
    /// # Performance
    /// - O(1) per TX (lazy Merkle update)
    /// - O(n) finalization ONCE at end
    /// - NO TX-level rollback needed - apply_transaction_lazy already atomic!
    pub fn apply_block_batch(&self, transactions: &[Transaction]) -> StateResult<usize> {
        let tx_count = transactions.len();
        let mut applied = 0;
        let mut failed = 0;
        
        // Apply each TX - no rollback needed, apply_transaction_lazy is atomic
        // (works with local copy, writes to state only on success)
        for tx in transactions {
            match self.apply_transaction_lazy(tx) {
                Ok(_) => applied += 1,
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
        
        if tx_count > 100 || failed > 0 {
            println!("[INFO][STATE] block_batch applied={}/{} failed={}", applied, tx_count, failed);
        }
        
        Ok(applied)
    }
    
    /// v3.26: ATOMIC block processing with fee crediting - TOP L1 PATTERN
    /// This is the SINGLE POINT where fees are credited to producer
    /// Ensures idempotency: calling multiple times with same block = same result
    /// Ensures determinism: all nodes get identical state_root
    /// 
    /// # Arguments
    /// * `transactions` - Block transactions to apply
    /// * `producer_wallet` - Wallet address of block producer (for fee credit)
    /// * `fees_collected` - Total fees from all transactions in block
    /// 
    /// # Returns
    /// * `(applied_count, state_root)` - Number of applied TXs and final state root
    pub fn apply_block_with_fees(
        &self,
        transactions: &[Transaction],
        producer_wallet: &str,
        fees_collected: u64,
    ) -> StateResult<(usize, [u8; HASH_SIZE])> {
        let mut applied = 0;
        
        // 1. Apply all transactions with lazy merkle updates
        for tx in transactions {
            match self.apply_transaction_lazy(tx) {
                Ok(_) => applied += 1,
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
    
    /// v3.39: Rollback entire block using snapshot
    /// Used ONLY when state_root verification fails after all TXs applied
    /// CRITICAL: Must also reset Merkle tree to match snapshot accounts!
    pub fn rollback_block(&self, snapshot: &BlockSnapshot) {
        // 1. Clear and restore accounts
        self.accounts.clear();
        for (address, account) in snapshot.accounts() {
            self.accounts.insert(address.clone(), account.clone());
        }
        
        // 2. CRITICAL FIX: Reset Merkle tree completely and rebuild from snapshot
        // Without this, leaves from failed attempt would corrupt future calculations!
        let mut tree = self.merkle_tree.write();
        *tree = StateMerkleTree::new();  // Reset to empty tree
        
        // 3. Rebuild Merkle tree from snapshot accounts
        for (address, account) in snapshot.accounts() {
            tree.insert_lazy(address, account);
        }
        // Tree is now dirty and will be finalized on next finalize_merkle() call
        
        println!("[INFO][STATE] block_rollback h={} accounts={} merkle_reset=true", 
                 snapshot.height(), snapshot.accounts().len());
    }
    
    // ═══════════════════════════════════════════════════════════════════════════════
    // v3.38: TRANSACTIONAL BLOCK PROCESSING
    // Applies TX, verifies state_root, rolls back on mismatch
    // ═══════════════════════════════════════════════════════════════════════════════
    
    /// v3.38: Clear all state (for Genesis block reset)
    /// WARNING: Only use for Genesis block initialization!
    pub fn clear(&self) {
        self.accounts.clear();
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
            let _ = self.credit_producer_fees_once(block_height, producer_wallet, fees_collected);
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
        
        // v2.100: CRITICAL FIX - SET not ADD!
        // reward_amount is already the TOTAL accumulated from PhaseAwareRewardManager
        account.pending_rewards = reward_amount;
        
        // v3.22: Lazy merkle update (finalized with block)
        {
            let account_clone = account.clone();
            let mut tree = self.merkle_tree.write();
            tree.insert_lazy(node_wallet, &account_clone);
        }
        
        println!("[INFO][STATE] pending_rewards_updated wallet={}... amount={} QNC",
                 &node_wallet[..node_wallet.len().min(16)],
                 reward_amount / 1_000_000_000);
        
        Ok(())
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
    pub fn restore_accounts(&self, accounts: Vec<(String, Account)>) -> StateResult<()> {
        let count = accounts.len();
        self.accounts.clear();
        
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
    pub fn emit_rewards(&self, amount: u64) -> StateResult<u64> {
        let mut chain_state = self.chain_state.write();
        
        // Check if we would exceed MAX_SUPPLY (all in nanoQNC)
        let remaining_supply = MAX_QNC_SUPPLY_NANO.saturating_sub(chain_state.total_supply);
        let actual_emission = amount.min(remaining_supply);
        
        if actual_emission == 0 {
            println!("⚠️ MAX_SUPPLY reached: {} QNC. No more emissions possible!", MAX_QNC_SUPPLY);
            return Ok(0);
        }
        
        // Update total supply (in nanoQNC)
        chain_state.total_supply += actual_emission;
        
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

