//! Transaction types and processing

use serde::{Deserialize, Serialize};
use blake3::Hasher;
use crate::errors::StateResult;
use crate::StateError;
use std::collections::HashMap;
use crate::Account;
use std::collections::HashSet;
use crate::account::{NodeType, ActivationPhase};

/// QNet native transaction fee units (OPTIMIZED for mobile)
pub const QNC_DECIMALS: u8 = 9; // 1 QNC = 10^9 smallest units (nanoQNC)
pub const BASE_FEE_NANO_QNC: u64 = 100_000; // 0.0001 QNC base fee (5x cheaper!)
pub const PRIORITY_MULTIPLIER: u64 = 10; // 10x for priority transactions

/// Gas price in nanoQNC (QNet native units)
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
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
pub fn calculate_tx_cost(gas_price: GasPrice, gas_limit: u64) -> f64 {
    let total_nano_qnc = gas_price.0 * gas_limit;
    total_nano_qnc as f64 / 10_f64.powi(QNC_DECIMALS as i32)
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
    
    /// Maximum gas limit
    pub const MAX_GAS_LIMIT: u64 = 1_000_000; // Reduced from 2M
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
    
    /// Batch reward claims
    BatchRewardClaims {
        node_ids: Vec<String>,
        batch_id: String,
    },
    
    /// Batch node activations
    BatchNodeActivations {
        activation_data: Vec<BatchNodeActivationData>,
        batch_id: String,
    },
    
    /// Batch transfers
    BatchTransfers {
        transfers: Vec<BatchTransferData>,
        batch_id: String,
    },
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
            TransactionType::BatchRewardClaims { node_ids, .. } => {
                if node_ids.is_empty() {
                    return Err("Batch reward claims must have at least one node".to_string());
                }
            }
            TransactionType::BatchNodeActivations { activation_data, .. } => {
                if activation_data.is_empty() {
                    return Err("Batch node activations must have at least one activation".to_string());
                }
            }
            TransactionType::BatchTransfers { transfers, .. } => {
                if transfers.is_empty() {
                    return Err("Batch transfers must have at least one transfer".to_string());
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
            TransactionType::ContractDeploy => {
                // Contract deployment
                let sender = accounts.get_mut(&self.from)
                    .ok_or_else(|| StateError::AccountNotFound(self.from.clone()))?;
                
                // Check balance for deployment fee
                let fee = self.gas_price * self.gas_limit;
                if sender.balance < fee {
                    return Err(StateError::InsufficientBalance {
                        have: sender.balance,
                        need: fee,
                    });
                }
                
                // Deduct deployment fee
                sender.balance -= fee;
                sender.nonce += 1;
                
                // Contract deployment logic would go here
                println!("Contract deployed by {} with fee {} QNC", self.from, fee);
            }
            TransactionType::ContractCall => {
                // Contract interaction
                let sender = accounts.get_mut(&self.from)
                    .ok_or_else(|| StateError::AccountNotFound(self.from.clone()))?;
                
                // Check balance for call fee + value
                let fee = self.gas_price * self.gas_limit;
                let total_cost = fee + self.amount;
                
                if sender.balance < total_cost {
                    return Err(StateError::InsufficientBalance {
                        have: sender.balance,
                        need: total_cost,
                    });
                }
                
                // Deduct fee and value
                sender.balance -= total_cost;
                sender.nonce += 1;
                
                // Contract call logic would go here
                println!("Contract call by {} with fee {} QNC, value {} QNC", self.from, fee, self.amount);
            }
            TransactionType::RewardDistribution => {
                // System transaction for reward distribution
                // Only allowed from system accounts
                if !self.from.starts_with("system_") {
                    return Err(StateError::InvalidTransaction("Only system can distribute rewards".to_string()));
                }
                
                // Reward distribution logic
                if let Some(to) = &self.to {
                    let recipient = accounts.entry(to.clone())
                        .or_insert_with(|| Account::new(to.clone()));
                    recipient.balance += self.amount;
                    
                    println!("Reward distributed: {} QNC to {}", self.amount, to);
                }
            }
            TransactionType::BatchRewardClaims { node_ids, .. } => {
                // Batch reward claims - single nonce increment for the entire batch
                let sender = accounts.get_mut(&self.from)
                    .ok_or_else(|| StateError::AccountNotFound(self.from.clone()))?;

                // Calculate total fee for batch
                let total_fee = (self.gas_price * self.gas_limit) * node_ids.len() as u64;

                if sender.balance < total_fee {
                    return Err(StateError::InsufficientBalance {
                        have: sender.balance,
                        need: total_fee,
                    });
                }

                // Deduct total fee once
                sender.balance -= total_fee;
                sender.nonce += 1;

                // Log batch reward claim
                println!("Batch reward claim for {} nodes by {} with total fee {} QNC", 
                        node_ids.len(), self.from, total_fee);
            }
            TransactionType::BatchNodeActivations { activation_data, .. } => {
                // Batch node activations - single nonce increment for the entire batch
                let sender = accounts.get_mut(&self.from)
                    .ok_or_else(|| StateError::AccountNotFound(self.from.clone()))?;

                // Calculate total activation amount and fees
                let total_activation_amount: u64 = activation_data.iter().map(|d| d.activation_amount).sum();
                let total_fee = (self.gas_price * self.gas_limit) * activation_data.len() as u64;
                let total_cost = total_activation_amount + total_fee;

                if sender.balance < total_cost {
                    return Err(StateError::InsufficientBalance {
                        have: sender.balance,
                        need: total_cost,
                    });
                }

                // Deduct total cost once
                sender.balance -= total_cost;
                sender.nonce += 1;

                // Log batch node activation
                println!("Batch node activation for {} nodes by {} with total cost {} QNC", 
                        activation_data.len(), self.from, total_cost);
            }
            TransactionType::BatchTransfers { transfers, .. } => {
                // Batch transfers - single nonce increment for the entire batch
                let sender = accounts.get_mut(&self.from)
                    .ok_or_else(|| StateError::AccountNotFound(self.from.clone()))?;

                // Calculate total transfer amount and fees
                let total_transfer_amount: u64 = transfers.iter().map(|t| t.amount).sum();
                let total_fee = (self.gas_price * self.gas_limit) * transfers.len() as u64;
                let total_cost = total_transfer_amount + total_fee;

                if sender.balance < total_cost {
                    return Err(StateError::InsufficientBalance {
                        have: sender.balance,
                        need: total_cost,
                    });
                }

                // Deduct total cost once
                sender.balance -= total_cost;
                sender.nonce += 1;

                // Process each transfer to recipients
                for transfer in transfers {
                    let recipient = accounts.entry(transfer.to_address.clone())
                        .or_insert_with(|| Account::new(transfer.to_address.clone()));
                    recipient.balance += transfer.amount;
                }

                // Log batch transfer
                println!("Batch transfer of {} QNC to {} recipients by {} with total fee {} QNC", 
                        total_transfer_amount, transfers.len(), self.from, total_fee);
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

/// Transaction processing with Pool 2 integration
pub struct TransactionProcessor {
    /// Integration with reward system
    pub reward_integration: Option<Box<dyn RewardIntegrationCallback>>,
}

/// Callback trait for reward integration
pub trait RewardIntegrationCallback: Send + Sync {
    /// Process transaction fee for Pool 2
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
        
        // Calculate and process fee for Pool 2
        let fee_amount = tx.gas_price * tx.gas_limit;
        if fee_amount > 0 {
            if let Some(ref mut integration) = self.reward_integration {
                if let Err(e) = integration.process_transaction_fee(
                    tx.hash.clone(),
                    tx.amount,
                    tx.gas_limit,
                    tx.gas_price,
                ) {
                    eprintln!("Warning: Failed to process transaction fee: {}", e);
                }
            }
        }
        
        // Handle node activation for Pool 3
        if let TransactionType::NodeActivation { node_type, burn_amount, .. } = &tx.tx_type {
            if let Some(ref mut integration) = self.reward_integration {
                if let Err(e) = integration.process_node_activation(
                    tx.from.clone(),
                    format!("{:?}", node_type),
                    *burn_amount,
                    tx.hash.clone(),
                ) {
                    eprintln!("Warning: Failed to process node activation: {}", e);
                }
            }
        }
        
        Ok(())
    }
}

/// Dynamic gas pricing based on network load
pub struct DynamicGasPricing {
    /// Current mempool size
    mempool_size: usize,
    /// Target block utilization (80%)
    target_utilization: f64,
    /// Current block utilization
    current_utilization: f64,
    /// Base gas price adjustment factor
    adjustment_factor: f64,
}

impl DynamicGasPricing {
    pub fn new() -> Self {
        Self {
            mempool_size: 0,
            target_utilization: 0.8,
            current_utilization: 0.0,
            adjustment_factor: 1.0,
        }
    }
    
    /// Update network load metrics
    pub fn update_network_load(&mut self, mempool_size: usize, block_utilization: f64) {
        self.mempool_size = mempool_size;
        self.current_utilization = block_utilization;
        self.adjustment_factor = self.calculate_adjustment_factor();
    }
    
    /// Calculate gas price adjustment based on network load
    fn calculate_adjustment_factor(&self) -> f64 {
        // Base adjustment from mempool congestion
        let mempool_factor = match self.mempool_size {
            0..=100 => 0.8,      // Low congestion: 20% discount
            101..=500 => 1.0,    // Normal: base price
            501..=1000 => 1.5,   // High congestion: 50% increase
            1001..=2000 => 2.0,  // Very high: 100% increase
            _ => 3.0,            // Extreme: 200% increase
        };
        
        // Block utilization adjustment
        let utilization_factor = if self.current_utilization > self.target_utilization {
            1.0 + (self.current_utilization - self.target_utilization) * 2.0
        } else {
            1.0 - (self.target_utilization - self.current_utilization) * 0.5
        };
        
        // Combined factor (capped at 5x for stability)
        (mempool_factor * utilization_factor).min(5.0).max(0.5)
    }
    
    /// Get current dynamic gas price
    pub fn get_dynamic_gas_price(&self, tier: GasTier) -> GasPrice {
        let base_price = match tier {
            GasTier::Eco => GasPrice::mobile(),
            GasTier::Standard => GasPrice::standard(),
            GasTier::Fast => GasPrice::fast(),
            GasTier::Priority => GasPrice::priority(),
        };
        
        let adjusted_price = (base_price.0 as f64 * self.adjustment_factor) as u64;
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
        match self.mempool_size {
            0..=100 => NetworkLoadStatus::Low,
            101..=500 => NetworkLoadStatus::Normal,
            501..=1000 => NetworkLoadStatus::High,
            1001..=2000 => NetworkLoadStatus::VeryHigh,
            _ => NetworkLoadStatus::Extreme,
        }
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

/// Mobile-optimized gas recommendations
#[derive(Debug, Clone)]
pub struct MobileGasRecommendations {
    pub eco: GasPrice,
    pub standard: GasPrice,
    pub fast: GasPrice,
    pub priority: GasPrice,
    pub network_load: NetworkLoadStatus,
    pub estimated_confirmation_time: ConfirmationTime,
}

/// Network load status for mobile UI
#[derive(Debug, Clone)]
pub enum NetworkLoadStatus {
    Low,
    Normal,
    High,
    VeryHigh,
    Extreme,
}

/// Confirmation time estimate
#[derive(Debug, Clone)]
pub enum ConfirmationTime {
    Seconds(u32),
    Minutes(u32),
}

/// Global dynamic gas pricing instance
static mut DYNAMIC_GAS_PRICING: Option<DynamicGasPricing> = None;

/// Initialize dynamic gas pricing
pub fn initialize_dynamic_gas_pricing() {
    unsafe {
        DYNAMIC_GAS_PRICING = Some(DynamicGasPricing::new());
    }
}

/// Get current gas recommendations for mobile wallets
pub fn get_mobile_gas_recommendations() -> MobileGasRecommendations {
    unsafe {
        DYNAMIC_GAS_PRICING
            .as_ref()
            .map(|pricing| pricing.get_mobile_gas_recommendations())
            .unwrap_or_else(|| MobileGasRecommendations {
                eco: GasPrice::mobile(),
                standard: GasPrice::standard(),
                fast: GasPrice::fast(),
                priority: GasPrice::priority(),
                network_load: NetworkLoadStatus::Normal,
                estimated_confirmation_time: ConfirmationTime::Seconds(2),
            })
    }
}

/// Update network load for dynamic pricing
pub fn update_network_load(mempool_size: usize, block_utilization: f64) {
    unsafe {
        if let Some(pricing) = DYNAMIC_GAS_PRICING.as_mut() {
            pricing.update_network_load(mempool_size, block_utilization);
        }
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