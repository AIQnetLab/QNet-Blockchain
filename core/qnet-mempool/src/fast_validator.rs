//! Fast validator for performance testing

use crate::errors::MempoolResult;
use crate::validation::{TxValidator, ValidationResult};
use qnet_state::transaction::Transaction;
use async_trait::async_trait;

/// Ultra-fast validator that skips all checks for performance testing
pub struct FastValidator;

impl FastValidator {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl TxValidator for FastValidator {
    async fn validate(&self, _tx: &Transaction) -> MempoolResult<ValidationResult> {
        // Skip all validation for maximum performance
        Ok(ValidationResult::success())
    }
    
    fn validate_basic(&self, _tx: &Transaction) -> ValidationResult {
        // Skip all validation
        ValidationResult::success()
    }
} 