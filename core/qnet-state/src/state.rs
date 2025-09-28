//! State management for QNet blockchain

use std::collections::HashMap;
use std::sync::Arc;
use dashmap::DashMap;
use crate::{Account, Block, Transaction, StateError, StateResult};
use sha3::{Sha3_256, Digest};

/// Maximum supply of QNC tokens (2^32)
pub const MAX_QNC_SUPPLY: u64 = 4_294_967_296;

/// Chain state information
#[derive(Debug, Clone)]
pub struct ChainState {
    /// Current blockchain height
    pub height: u64,
    /// Total supply of QNC
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
    pub fn emit_rewards(&self, amount: u64) -> StateResult<u64> {
        let mut chain_state = self.chain_state.write();
        
        // Check if we would exceed MAX_SUPPLY
        let remaining_supply = MAX_QNC_SUPPLY.saturating_sub(chain_state.total_supply);
        let actual_emission = amount.min(remaining_supply);
        
        if actual_emission == 0 {
            println!("⚠️ MAX_SUPPLY reached: {} QNC. No more emissions possible!", MAX_QNC_SUPPLY);
            return Ok(0);
        }
        
        // Update total supply
        chain_state.total_supply += actual_emission;
        
        if actual_emission < amount {
            println!("⚠️ Emission limited: requested {} QNC, emitted {} QNC (remaining: {} QNC)",
                     amount, actual_emission, MAX_QNC_SUPPLY - chain_state.total_supply);
        }
        
        Ok(actual_emission)
    }
    
    /// Get current total supply
    pub fn get_total_supply(&self) -> u64 {
        self.chain_state.read().total_supply
    }
    
    /// Get remaining supply until MAX_SUPPLY
    pub fn get_remaining_supply(&self) -> u64 {
        MAX_QNC_SUPPLY.saturating_sub(self.get_total_supply())
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

