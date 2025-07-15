//! State database implementation

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use crate::{Account, Block, Transaction, StateError, StateResult};

/// State database for blockchain
pub struct StateDB {
    accounts: Arc<RwLock<HashMap<String, Account>>>,
    blocks: Arc<RwLock<HashMap<u64, Block>>>,
    state_root: Arc<RwLock<String>>,
}

impl StateDB {
    /// Create new StateDB instance
    pub async fn new(_path: &str, _cache_size: Option<usize>) -> StateResult<Self> {
        Ok(Self {
            accounts: Arc::new(RwLock::new(HashMap::new())),
            blocks: Arc::new(RwLock::new(HashMap::new())),
            state_root: Arc::new(RwLock::new(String::from("genesis"))),
        })
    }
    
    /// Get account by address
    pub async fn get_account(&self, address: &str) -> StateResult<Option<Account>> {
        let accounts = self.accounts.read().await;
        Ok(accounts.get(address).cloned())
    }
    
    /// Get account balance
    pub async fn get_balance(&self, address: &str) -> StateResult<u64> {
        let accounts = self.accounts.read().await;
        Ok(accounts.get(address).map(|a| a.balance).unwrap_or(0))
    }
    
    /// Update account
    pub async fn update_account(&self, address: &str, account: Account) -> StateResult<()> {
        let mut accounts = self.accounts.write().await;
        accounts.insert(address.to_string(), account);
        Ok(())
    }
    
    /// Get block by height
    pub async fn get_block(&self, height: u64) -> StateResult<Option<Block>> {
        let blocks = self.blocks.read().await;
        Ok(blocks.get(&height).cloned())
    }
    
    /// Get latest block
    pub async fn get_latest_block(&self) -> StateResult<Option<Block>> {
        let blocks = self.blocks.read().await;
        let max_height = blocks.keys().max().copied();
        Ok(max_height.and_then(|h| blocks.get(&h).cloned()))
    }
    
    /// Execute transaction
    pub async fn execute_transaction(&self, tx: Transaction) -> StateResult<String> {
        // TODO: Replace with production blockchain integration
        // This should connect to real QNet blockchain state
        let tx_hash = format!("qnet{}", hex::encode(&tx.hash()?)[..14]);
        
        if let Some(to) = &tx.to {
            let mut accounts = self.accounts.write().await;
            
            // Deduct from sender
            let sender = accounts.entry(tx.from.clone()).or_insert_with(|| Account {
                address: tx.from.clone(),
                balance: 1000000, // TODO: Get real balance from blockchain
                nonce: 0,
                is_node: false,
                node_type: None,
                stake: 0,
                reputation: 0.0,
                created_at: 0,
                updated_at: 0,
            });
            
            if sender.balance < tx.amount {
                return Err(StateError::InsufficientBalance {
                    have: sender.balance,
                    need: tx.amount,
                });
            }
            
            sender.balance -= tx.amount;
            sender.nonce += 1;
            
            // Add to recipient
            let recipient = accounts.entry(to.clone()).or_insert_with(|| Account {
                address: to.clone(),
                balance: 0,
                nonce: 0,
                is_node: false,
                node_type: None,
                stake: 0,
                reputation: 0.0,
                created_at: 0,
                updated_at: 0,
            });
            
            recipient.balance += tx.amount;
        }
        
        Ok(tx_hash)
    }
    
    /// Process block
    pub async fn process_block(&self, block: Block) -> StateResult<()> {
        let mut blocks = self.blocks.write().await;
        blocks.insert(block.height, block);
        Ok(())
    }
    
    /// Get state root
    pub async fn get_state_root(&self) -> StateResult<String> {
        let state_root = self.state_root.read().await;
        Ok(state_root.clone())
    }
    
    /// Get blockchain height
    pub fn get_height(&self) -> u64 {
        // This is a simplified version - in real implementation would be async
        0
    }
    
    /// Store block
    pub fn store_block(&self, _block: Block) -> bool {
        // Simplified version
        true
    }
    
    /// Get block by hash
    pub fn get_block_by_hash(&self, _hash: &str) -> Option<Block> {
        // Simplified version
        None
    }
} 