//! State management for QNet blockchain

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
pub struct StateManager {
    /// Accounts state
    pub accounts: Arc<DashMap<String, Account>>,
    /// Chain state
    pub chain_state: Arc<parking_lot::RwLock<ChainState>>,
    /// State root
    state_root: Arc<parking_lot::RwLock<[u8; 32]>>,
}

impl StateManager {
    /// Create new state manager
    pub fn new() -> Self {
        Self {
            accounts: Arc::new(DashMap::new()),
            chain_state: Arc::new(parking_lot::RwLock::new(ChainState::default())),
            state_root: Arc::new(parking_lot::RwLock::new([0u8; 32])),
        }
    }
    
    /// Get account
    pub fn get_account(&self, address: &str) -> Option<Account> {
        self.accounts.get(address).map(|acc| acc.clone())
    }
    
    /// Update account
    pub fn update_account(&self, address: String, account: Account) {
        self.accounts.insert(address, account);
    }
    
    /// Get balance
    pub fn get_balance(&self, address: &str) -> u64 {
        self.accounts.get(address).map(|acc| acc.balance).unwrap_or(0)
    }
    
    /// v3.18: Credit block fees directly to producer's wallet
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
        
        // Update account
        self.accounts.insert(producer_wallet.to_string(), account);
        
        Ok(())
    }
    
    /// Apply transaction
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
        
        // Write back changes
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
        
        println!("[STATE] pending_rewards_updated wallet={} amount={} QNC total={} QNC",
                 &node_wallet[..node_wallet.len().min(16)],
                 reward_amount / 1_000_000_000,
                 account.pending_rewards / 1_000_000_000);
        
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
    /// This replaces in-memory DashMap with persisted blockchain state
    pub fn restore_accounts(&self, accounts: Vec<(String, Account)>) -> StateResult<()> {
        self.accounts.clear();
        for (address, account) in accounts {
            self.accounts.insert(address, account);
        }
        println!("[STATE] restored_accounts count={}", self.accounts.len());
        Ok(())
    }
    
    /// Calculate state root hash
    pub fn calculate_state_root(&self) -> Result<[u8; 32], StateError> {
        let mut hasher = Sha3_256::new();
        
        // Get all accounts sorted by address
        let mut accounts: Vec<_> = self.accounts.iter()
            .map(|entry| (entry.key().clone(), entry.value().clone()))
            .collect();
        accounts.sort_by(|a, b| a.0.cmp(&b.0));
        
        // Hash each account
        for (address, account) in accounts {
            hasher.update(address.as_bytes());
            hasher.update(&account.balance.to_le_bytes());

            hasher.update(&account.nonce.to_le_bytes());
        }
        
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

