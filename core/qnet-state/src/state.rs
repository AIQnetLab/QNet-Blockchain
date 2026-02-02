//! State management for QNet blockchain
//! v3.11: Added State Merkle Tree for Light client proofs

use std::collections::HashMap;
use std::sync::Arc;
use dashmap::DashMap;
use crate::{Account, Block, Transaction, StateError, StateResult};
use sha3::{Sha3_256, Digest};

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
/// Optimized for QNet's account structure
pub struct StateMerkleTree {
    /// Root hash
    root: [u8; HASH_SIZE],
    /// Stored account hashes (address_hash -> account_data_hash)
    leaves: HashMap<[u8; HASH_SIZE], [u8; HASH_SIZE]>,
    /// Pre-computed default hashes for each level
    default_hashes: Vec<[u8; HASH_SIZE]>,
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
            leaves: HashMap::new(),
            default_hashes,
        }
    }
    
    /// Insert or update account
    pub fn insert(&mut self, address: &str, account: &Account) -> [u8; HASH_SIZE] {
        let addr_hash = Self::hash_address(address);
        let account_hash = Self::hash_account(account);
        self.leaves.insert(addr_hash, account_hash);
        self.recompute_root();
        self.root
    }
    
    /// Remove account
    pub fn remove(&mut self, address: &str) -> [u8; HASH_SIZE] {
        let addr_hash = Self::hash_address(address);
        self.leaves.remove(&addr_hash);
        self.recompute_root();
        self.root
    }
    
    /// Get current root
    pub fn root(&self) -> [u8; HASH_SIZE] {
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
            let mut next_level: HashMap<[u8; HASH_SIZE], [u8; HASH_SIZE]> = HashMap::new();
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
                
                // Clear the bit at depth to get actual parent key
                let mut actual_parent = *key;
                if is_right {
                    Self::flip_bit(&mut actual_parent, depth);
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

/// State manager for blockchain
/// v3.11: Integrated State Merkle Tree for trustless balance proofs
pub struct StateManager {
    /// Accounts state
    pub accounts: Arc<DashMap<String, Account>>,
    /// Chain state
    pub chain_state: Arc<parking_lot::RwLock<ChainState>>,
    /// State root (legacy - for backward compatibility)
    state_root: Arc<parking_lot::RwLock<[u8; 32]>>,
    /// v3.11: State Merkle Tree for Light client proofs
    merkle_tree: Arc<parking_lot::RwLock<StateMerkleTree>>,
}

impl StateManager {
    /// Create new state manager
    pub fn new() -> Self {
        Self {
            accounts: Arc::new(DashMap::new()),
            chain_state: Arc::new(parking_lot::RwLock::new(ChainState::default())),
            state_root: Arc::new(parking_lot::RwLock::new([0u8; 32])),
            merkle_tree: Arc::new(parking_lot::RwLock::new(StateMerkleTree::new())),
        }
    }
    
    /// Get account
    pub fn get_account(&self, address: &str) -> Option<Account> {
        self.accounts.get(address).map(|acc| acc.clone())
    }
    
    /// Update account
    /// v3.11: Also updates State Merkle Tree
    pub fn update_account(&self, address: String, account: Account) {
        // Update merkle tree
        {
            let mut tree = self.merkle_tree.write();
            tree.insert(&address, &account);
        }
        // Update accounts map
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
        let tree = self.merkle_tree.read();
        let chain_state = self.chain_state.read();
        
        let proof = tree.generate_proof(address);
        
        Some(BalanceProof {
            address: address.to_string(),
            balance: account.balance,
            nonce: account.nonce,
            proof,
            state_root: tree.root(),
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
    
    /// Get current Merkle state root
    pub fn get_merkle_state_root(&self) -> [u8; HASH_SIZE] {
        self.merkle_tree.read().root()
    }
    
    /// Get balance
    pub fn get_balance(&self, address: &str) -> u64 {
        self.accounts.get(address).map(|acc| acc.balance).unwrap_or(0)
    }
    
    /// v3.18: Credit block fees directly to producer's wallet
    /// v3.11: Also updates State Merkle Tree
    /// This is called when a block is produced/validated to give fees to the producer
    /// Fees are NOT a transaction - they are direct balance credit (like Ethereum coinbase)
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
        
        // v3.11: Update merkle tree
        {
            let mut tree = self.merkle_tree.write();
            tree.insert(producer_wallet, &account);
        }
        
        // Update account
        self.accounts.insert(producer_wallet.to_string(), account);
        
        Ok(())
    }
    
    /// Apply transaction
    /// v3.11: Also updates State Merkle Tree for all changed accounts
    pub fn apply_transaction(&self, tx: &Transaction) -> StateResult<()> {
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
    
    /// Apply block
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
        
        // v3.11: Update merkle tree
        {
            let account_clone = account.clone();
            let mut tree = self.merkle_tree.write();
            tree.insert(node_wallet, &account_clone);
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
    /// v3.11: Also rebuilds State Merkle Tree for proof generation
    /// This replaces in-memory DashMap with persisted blockchain state
    pub fn restore_accounts(&self, accounts: Vec<(String, Account)>) -> StateResult<()> {
        self.accounts.clear();
        
        // v3.11: Rebuild merkle tree from scratch
        let mut tree = self.merkle_tree.write();
        *tree = StateMerkleTree::new();
        
        for (address, account) in &accounts {
            tree.insert(address, account);
            self.accounts.insert(address.clone(), account.clone());
        }
        
        println!("[INFO][STATE] restored_accounts count={} merkle_root={}...", 
                 self.accounts.len(),
                 hex::encode(&tree.root()[..8]));
        Ok(())
    }
    
    /// Calculate state root hash
    /// v3.11: Now uses Merkle tree root combined with chain state
    /// This enables trustless verification for Light clients
    pub fn calculate_state_root(&self) -> Result<[u8; 32], StateError> {
        // v3.11: Get Merkle root from State Merkle Tree
        let merkle_root = self.merkle_tree.read().root();
        
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

