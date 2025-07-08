//! Transaction types and processing

use serde::{Deserialize, Serialize};
use blake3::Hasher;
use crate::errors::StateResult;
use crate::StateError;
use std::collections::HashMap;
use crate::Account;
use std::collections::HashSet;
use crate::account::{NodeType, ActivationPhase};

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
    
    /// Node activation (token burn)
    NodeActivation {
        node_type: NodeType,
        burn_amount: u64,
        phase: ActivationPhase,
    },
    
    /// Contract deployment
    ContractDeploy,
    
    /// Contract call
    ContractCall,
    
    /// Reward distribution
    RewardDistribution,
    
    /// Create new account
    CreateAccount {
        address: String,
        initial_balance: u64,
    },
    
    /// Stake QNC
    Stake {
        from: String,
        amount: u64,
    },
    
    /// Unstake QNC
    Unstake {
        from: String,
        amount: u64,
    },
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
    
    /// Signature
    pub signature: Option<String>,
    
    /// Transaction type
    pub tx_type: TransactionType,
    
    /// Call data
    pub data: Option<String>,
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
            max_instant_amount: 1_000_000, // 1M smallest units
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
            tx_type,
            data,
        };
        tx.hash = tx.calculate_hash();
        tx
    }
    
    /// Calculate transaction hash as hex string
    pub fn calculate_hash(&self) -> TxHash {
        let mut hasher = Hasher::new();
        
        // Hash all fields except hash and signature
        hasher.update(self.from.as_bytes());
        hasher.update(self.to.as_ref().map(|s| s.as_bytes()).unwrap_or_default());
        hasher.update(&self.amount.to_le_bytes());
        hasher.update(&self.nonce.to_le_bytes());
        hasher.update(&self.gas_price.to_le_bytes());
        hasher.update(&self.gas_limit.to_le_bytes());
        hasher.update(&self.timestamp.to_le_bytes());
        
        hex::encode(hasher.finalize().as_bytes())
    }
    
    /// Get transaction value
    pub fn value(&self) -> u64 {
        self.amount
    }
    
    /// Check if transaction is valid
    pub fn validate(&self) -> Result<(), String> {
        // Basic validation
        if self.from.is_empty() {
            return Err("Empty sender address".to_string());
        }
        
        if self.hash != self.calculate_hash() {
            return Err("Invalid transaction hash".to_string());
        }
        
        // Type-specific validation
        match &self.tx_type {
            TransactionType::Transfer { from, to, amount } => {
                if from == to {
                    return Err("Cannot transfer to self".to_string());
                }
                if *amount == 0 {
                    return Err("Transfer amount must be greater than 0".to_string());
                }
                if self.to.as_ref().map(|s| s.is_empty()).unwrap_or(true) {
                    return Err("Empty recipient address".to_string());
                }
            }
            TransactionType::NodeActivation { burn_amount, .. } => {
                if *burn_amount == 0 {
                    return Err("Burn amount must be greater than 0".to_string());
                }
            }
            TransactionType::ContractDeploy => {
                // No additional validation needed for ContractDeploy
            }
            TransactionType::ContractCall => {
                if self.to.as_ref().map(|s| s.is_empty()).unwrap_or(true) {
                    return Err("Empty contract address".to_string());
                }
            }
            TransactionType::RewardDistribution => {
                // No additional validation needed for RewardDistribution
            }
            TransactionType::CreateAccount { address, initial_balance } => {
                if address.is_empty() {
                    return Err("Address cannot be empty".to_string());
                }
                if *initial_balance == 0 {
                    return Err("Initial balance must be greater than 0".to_string());
                }
            }
            TransactionType::Stake { from: _, amount } |
            TransactionType::Unstake { from: _, amount } => {
                if *amount == 0 {
                    return Err("Stake amount must be greater than 0".to_string());
                }
            }
        }
        
        Ok(())
    }
    
    /// Apply transaction to state
    pub fn apply_to_state(&self, accounts: &mut HashMap<String, Account>) -> Result<(), StateError> {
        match &self.tx_type {
            TransactionType::Transfer { from, to, amount } => {
                // Get sender account
                let sender = accounts.get_mut(from)
                    .ok_or_else(|| StateError::AccountNotFound(from.clone()))?;
                
                // Check balance
                let total_amount = amount + self.gas_price * self.gas_limit;
                if sender.balance < total_amount {
                    return Err(StateError::InsufficientBalance {
                        have: sender.balance,
                        need: total_amount,
                    });
                }
                
                // Deduct from sender
                sender.balance -= total_amount;
                sender.nonce += 1;
                
                // Add to receiver
                let receiver = accounts.entry(to.clone())
                    .or_insert_with(|| Account::new(to.clone()));
                receiver.balance += amount;
            }
            TransactionType::CreateAccount { address, initial_balance } => {
                if accounts.contains_key(address) {
                    return Err(StateError::InvalidTransaction("Account already exists".to_string()));
                }
                
                let mut account = Account::new(address.clone());
                account.balance = *initial_balance;
                accounts.insert(address.clone(), account);
            }
            TransactionType::Stake { from, amount } => {
                let account = accounts.get_mut(from)
                    .ok_or_else(|| StateError::AccountNotFound(from.clone()))?;
                
                let total_amount = amount + self.gas_price * self.gas_limit;
                if account.balance < total_amount {
                    return Err(StateError::InsufficientBalance {
                        have: account.balance,
                        need: total_amount,
                    });
                }
                
                account.balance -= total_amount;
                account.stake += amount;
                account.nonce += 1;
            }
            TransactionType::Unstake { from, amount } => {
                let account = accounts.get_mut(from)
                    .ok_or_else(|| StateError::AccountNotFound(from.clone()))?;
                
                if account.stake < *amount {
                    return Err(StateError::InsufficientBalance {
                        have: account.stake,
                        need: *amount,
                    });
                }
                
                let fee = self.gas_price * self.gas_limit;
                if account.balance < fee {
                    return Err(StateError::InsufficientBalance {
                        have: account.balance,
                        need: fee,
                    });
                }
                
                account.stake -= amount;
                account.balance += amount - fee;
                account.nonce += 1;
            }
            TransactionType::NodeActivation { node_type, burn_amount, .. } => {
                let sender = accounts.get_mut(&self.from)
                    .ok_or_else(|| StateError::AccountNotFound(self.from.clone()))?;

                // Fee calculation
                let fee = self.gas_price * self.gas_limit;
                let total_amount = burn_amount + fee;

                if sender.balance < total_amount {
                    return Err(StateError::InsufficientBalance {
                        have: sender.balance,
                        need: total_amount,
                    });
                }

                // Burn tokens (remove from balance)
                sender.balance -= total_amount;
                sender.nonce += 1;

                // Activate node
                sender.activate_node(format!("{:?}", node_type), self.timestamp);
            }
            _ => {
                // Other transaction types not implemented yet
                return Err(StateError::InvalidTransaction("Transaction type not implemented".to_string()));
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
    /// Transaction status tracking
    tx_status: HashMap<String, FinalizationStatus>,
    /// Microblock to macroblock mapping
    microblock_to_macroblock: HashMap<u64, u64>,
}

impl FinalizationManager {
    pub fn new(config: LocalFinalizationConfig) -> Self {
        Self {
            config,
            tx_status: HashMap::new(),
            microblock_to_macroblock: HashMap::new(),
        }
    }
    
    /// Update transaction finalization status
    pub fn update_transaction_status(
        &mut self,
        tx_hash: &str,
        status: FinalizationStatus,
    ) {
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

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_transaction_hash() {
        let tx1 = Transaction::new(
            "sender1".to_string(),
            Some("recipient1".to_string()),
            1000,
            1,
            10, // gas_price
            21000, // gas_limit
            1234567890,
            Some("signature1".to_string()),
            TransactionType::Transfer {
                from: "sender1".to_string(),
                to: "recipient1".to_string(),
                amount: 1000,
            },
            None,
        );
        
        let tx2 = Transaction::new(
            "sender1".to_string(),
            Some("recipient1".to_string()),
            1000,
            1,
            10, // gas_price
            21000, // gas_limit
            1234567890,
            Some("signature1".to_string()),
            TransactionType::Transfer {
                from: "sender1".to_string(),
                to: "recipient1".to_string(),
                amount: 1000,
            },
            None,
        );
        
        // Same transactions should have same hash
        assert_eq!(tx1.hash, tx2.hash);
        
        // Different nonce should produce different hash
        let tx3 = Transaction::new(
            "sender1".to_string(),
            Some("recipient1".to_string()),
            1000,
            2,
            10, // gas_price
            21000, // gas_limit
            1234567890,
            Some("signature1".to_string()),
            TransactionType::Transfer {
                from: "sender1".to_string(),
                to: "recipient1".to_string(),
                amount: 1000,
            },
            None,
        );
        
        assert_ne!(tx1.hash, tx3.hash);
    }
    
    #[test]
    fn test_transaction_validation() {
        let tx = Transaction::new(
            "sender".to_string(),
            Some("recipient".to_string()),
            1000,
            1,
            10, // gas_price
            21000, // gas_limit
            1234567890,
            Some("signature".to_string()),
            TransactionType::Transfer {
                from: "sender".to_string(),
                to: "recipient".to_string(),
                amount: 1000,
            },
            None,
        );
        
        assert!(tx.validate().is_ok());
        
        // Invalid transaction - zero amount
        let invalid_tx = Transaction::new(
            "sender".to_string(),
            Some("recipient".to_string()),
            0,
            1,
            10, // gas_price
            21000, // gas_limit
            1234567890,
            Some("signature".to_string()),
            TransactionType::Transfer {
                from: "sender".to_string(),
                to: "recipient".to_string(),
                amount: 0,
            },
            None,
        );
        
        assert!(invalid_tx.validate().is_err());
    }
} 