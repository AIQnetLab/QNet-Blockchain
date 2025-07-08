//! Transaction validation for mempool

use crate::errors::{MempoolError, MempoolResult};
use qnet_state::{StateDB, transaction::Transaction};
use async_trait::async_trait;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Validation result
#[derive(Debug, Clone)]
pub struct ValidationResult {
    /// Whether transaction is valid
    pub is_valid: bool,
    
    /// Validation errors if any
    pub errors: Vec<String>,
    
    /// Expected account nonce
    pub expected_nonce: Option<u64>,
    
    /// Account balance
    pub account_balance: Option<u64>,
}

impl ValidationResult {
    /// Create successful validation
    pub fn success() -> Self {
        Self {
            is_valid: true,
            errors: vec![],
            expected_nonce: None,
            account_balance: None,
        }
    }
    
    /// Create failed validation
    pub fn failure(error: String) -> Self {
        Self {
            is_valid: false,
            errors: vec![error],
            expected_nonce: None,
            account_balance: None,
        }
    }
    
    /// Add error
    pub fn add_error(&mut self, error: String) {
        self.is_valid = false;
        self.errors.push(error);
    }
}

/// Transaction validator trait
#[async_trait]
pub trait TxValidator: Send + Sync {
    /// Validate transaction
    async fn validate(&self, tx: &Transaction) -> MempoolResult<ValidationResult>;
    
    /// Quick validation (without state checks)
    fn validate_basic(&self, tx: &Transaction) -> ValidationResult;
}

/// Default transaction validator
pub struct DefaultValidator {
    /// State database
    state_db: Arc<StateDB>,
    
    /// Minimum gas price
    min_gas_price: u64,
    
    /// Maximum transaction age
    max_tx_age: Duration,
    
    /// Maximum transaction size
    max_tx_size: usize,
}

impl DefaultValidator {
    /// Create new validator
    pub fn new(state_db: Arc<StateDB>, min_gas_price: u64) -> Self {
        Self {
            state_db,
            min_gas_price,
            max_tx_age: Duration::from_secs(3600), // 1 hour
            max_tx_size: 128 * 1024, // 128 KB
        }
    }
}

#[async_trait]
impl TxValidator for DefaultValidator {
    async fn validate(&self, tx: &Transaction) -> MempoolResult<ValidationResult> {
        let mut result = self.validate_basic(tx);
        
        if !result.is_valid {
            return Ok(result);
        }
        
        // Get account state
        let account_state = match self.state_db.get_account(&tx.from).await? {
            Some(state) => state,
            None => {
                // New account - check if it's a valid first transaction
                if tx.nonce != 0 {
                    result.add_error(format!("New account must start with nonce 0, got {}", tx.nonce));
                    result.expected_nonce = Some(0);
                    return Ok(result);
                }
                
                // Check if transaction can pay for itself
                let total_cost = tx.value() + (tx.gas_price * tx.gas_limit);
                if total_cost > 0 {
                    result.add_error("New account has insufficient balance".to_string());
                    result.account_balance = Some(0);
                    return Ok(result);
                }
                
                return Ok(result);
            }
        };
        
        result.expected_nonce = Some(account_state.nonce);
        result.account_balance = Some(account_state.balance);
        
        // Check nonce
        if tx.nonce < account_state.nonce {
            return Err(MempoolError::NonceTooLow {
                expected: account_state.nonce,
                got: tx.nonce,
            });
        }
        
        // Check balance
        let total_cost = tx.value() + (tx.gas_price * tx.gas_limit);
        if account_state.balance < total_cost {
            result.add_error(format!(
                "Insufficient balance: need {}, have {}",
                total_cost, account_state.balance
            ));
            return Ok(result);
        }
        
        // Additional checks based on transaction type
        use qnet_state::transaction::TransactionType;
        match &tx.tx_type {
            TransactionType::NodeActivation { node_type: _, burn_amount: _, phase: _ } => {
                if account_state.is_node {
                    result.add_error("Account already activated as node".to_string());
                }
            }
            TransactionType::ContractDeploy => {
                if let Some(data) = &tx.data {
                    if data.len() > 24_576 { // 24KB max contract size
                        result.add_error("Contract code too large".to_string());
                    }
                }
            }
            _ => {}
        }
        
        Ok(result)
    }
    
    fn validate_basic(&self, tx: &Transaction) -> ValidationResult {
        let mut result = ValidationResult::success();
        
        // Check transaction structure
        if let Err(e) = tx.validate() {
            result.add_error(e);
            return result;
        }
        
        // Check gas price
        if tx.gas_price < self.min_gas_price {
            result.add_error(format!(
                "Gas price too low: minimum {}, got {}",
                self.min_gas_price, tx.gas_price
            ));
        }
        
        // Check gas limit
        if tx.gas_limit < 21000 {
            result.add_error("Gas limit too low".to_string());
        } else if tx.gas_limit > 10_000_000 {
            result.add_error("Gas limit too high".to_string());
        }
        
        // Check transaction size
        let tx_size = bincode::serialize(tx).unwrap().len();
        if tx_size > self.max_tx_size {
            result.add_error(format!(
                "Transaction too large: {} bytes > {} bytes",
                tx_size, self.max_tx_size
            ));
        }
        
        // Check timestamp
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        
        if tx.timestamp > now + 300 {
            result.add_error("Transaction timestamp too far in future".to_string());
        } else if now > tx.timestamp && Duration::from_secs(now - tx.timestamp) > self.max_tx_age {
            result.add_error("Transaction too old".to_string());
        }
        
        result
    }
}

/// Simple validator for Python bindings (no StateDB)
pub struct SimpleValidator {
    min_gas_price: u64,
}

impl SimpleValidator {
    pub fn new(min_gas_price: u64) -> Self {
        Self { min_gas_price }
    }
}

#[async_trait]
impl TxValidator for SimpleValidator {
    async fn validate(&self, tx: &Transaction) -> MempoolResult<ValidationResult> {
        Ok(self.validate_basic(tx))
    }
    
    fn validate_basic(&self, tx: &Transaction) -> ValidationResult {
        let mut result = ValidationResult::success();
        
        // Basic checks only
        if tx.gas_price < self.min_gas_price {
            result.add_error(format!(
                "Gas price too low: minimum {}, got {}",
                self.min_gas_price, tx.gas_price
            ));
        }
        
        if tx.gas_limit < 21000 {
            result.add_error("Gas limit too low".to_string());
        }
        
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use qnet_state::transaction::TransactionType;
    
    #[test]
    fn test_basic_validation() {
        let state_db = Arc::new(StateDB::new(Arc::new(MockBackend)));
        let validator = DefaultValidator::new(state_db, 10);
        
        let tx = Transaction::new(
            "sender".to_string(),
            TransactionType::Transfer {
                to: "recipient".to_string(),
                amount: 100,
            },
            1,
            10,
            21000,
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs(),
        );
        
        let result = validator.validate_basic(&tx);
        assert!(result.is_valid);
    }
    
    #[test]
    fn test_low_gas_price() {
        let state_db = Arc::new(StateDB::new(Arc::new(MockBackend)));
        let validator = DefaultValidator::new(state_db, 10);
        
        let tx = Transaction::new(
            "sender".to_string(),
            TransactionType::Transfer {
                to: "recipient".to_string(),
                amount: 100,
            },
            1,
            5, // Too low
            21000,
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs(),
        );
        
        let result = validator.validate_basic(&tx);
        assert!(!result.is_valid);
        assert!(result.errors[0].contains("Gas price too low"));
    }
    
    // Mock backend for tests
    struct MockBackend;
    
    #[async_trait]
    impl qnet_state::StateBackend for MockBackend {
        async fn get_account(&self, _address: &qnet_state::account::Address) -> qnet_state::StateResult<Option<qnet_state::AccountState>> {
            Ok(None)
        }
        
        async fn set_account(&self, _address: &qnet_state::account::Address, _state: &qnet_state::AccountState) -> qnet_state::StateResult<()> {
            Ok(())
        }
        
        async fn get_block(&self, _height: u64) -> qnet_state::StateResult<Option<qnet_state::Block>> {
            Ok(None)
        }
        
        async fn get_block_by_hash(&self, _hash: &qnet_state::block::BlockHash) -> qnet_state::StateResult<Option<qnet_state::Block>> {
            Ok(None)
        }
        
        async fn store_block(&self, _block: &qnet_state::Block) -> qnet_state::StateResult<()> {
            Ok(())
        }
        
        async fn get_receipt(&self, _tx_hash: &qnet_state::transaction::TxHash) -> qnet_state::StateResult<Option<qnet_state::TransactionReceipt>> {
            Ok(None)
        }
        
        async fn store_receipt(&self, _receipt: &qnet_state::TransactionReceipt) -> qnet_state::StateResult<()> {
            Ok(())
        }
        
        async fn get_height(&self) -> qnet_state::StateResult<u64> {
            Ok(0)
        }
        
        async fn begin_batch(&self) -> qnet_state::StateResult<()> {
            Ok(())
        }
        
        async fn commit_batch(&self) -> qnet_state::StateResult<()> {
            Ok(())
        }
        
        async fn rollback_batch(&self) -> qnet_state::StateResult<()> {
            Ok(())
        }
    }
} 