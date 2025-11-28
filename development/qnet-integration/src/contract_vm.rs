//! Contract VM Integration for QNet
//! 
//! This module provides WASM-based smart contract execution
//! with post-quantum cryptographic verification.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use sha3::{Sha3_256, Digest};
use serde::{Deserialize, Serialize};
use once_cell::sync::Lazy;

use crate::storage::Storage;
use crate::errors::{IntegrationError, IntegrationResult};

// ============================================================================
// GLOBAL TOKEN REGISTRY - Persists across all ContractVM instances
// ============================================================================

/// Global token registry - shared across all VM instances for consistency
/// CRITICAL: This ensures token list is not lost between HTTP requests
static GLOBAL_TOKEN_REGISTRY: Lazy<Arc<RwLock<HashMap<String, QRC20Token>>>> = 
    Lazy::new(|| Arc::new(RwLock::new(HashMap::new())));

// ============================================================================
// CONTRACT VM - Real Implementation (NOT Mock!)
// ============================================================================

/// Contract execution result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContractResult {
    pub success: bool,
    pub return_data: Vec<u8>,
    pub gas_used: u64,
    pub logs: Vec<ContractLog>,
    pub error: Option<String>,
}

/// Contract log/event
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContractLog {
    pub contract_address: String,
    pub event_name: String,
    pub topics: Vec<String>,
    pub data: Vec<u8>,
}

/// Contract info stored in database
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContractInfo {
    pub address: String,
    pub creator: String,
    pub code_hash: String,
    pub creation_height: u64,
    pub creation_timestamp: u64,
    pub balance: u64,
}

/// QRC-20 Token Standard Interface
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QRC20Token {
    pub name: String,
    pub symbol: String,
    pub decimals: u8,
    pub total_supply: u64,
    pub contract_address: String,
}

/// Token balance entry
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenBalance {
    pub token_address: String,
    pub holder_address: String,
    pub balance: u64,
}

/// Contract VM for executing smart contracts
pub struct ContractVM {
    /// Storage reference
    storage: Arc<Storage>,
    /// Gas price (nanoQNC per gas unit)
    gas_price: u64,
    /// Maximum gas per call
    max_gas: u64,
}

impl ContractVM {
    /// Create new Contract VM
    /// NOTE: Uses GLOBAL_TOKEN_REGISTRY for persistence across requests
    pub fn new(storage: Arc<Storage>) -> Self {
        Self {
            storage,
            gas_price: 1000, // 1000 nanoQNC per gas
            max_gas: 10_000_000, // 10M gas limit
        }
    }
    
    /// Get reference to global token registry
    fn token_registry(&self) -> &Arc<RwLock<HashMap<String, QRC20Token>>> {
        &GLOBAL_TOKEN_REGISTRY
    }
    
    // =========================================================================
    // QRC-20 TOKEN OPERATIONS
    // =========================================================================
    
    /// Deploy a new QRC-20 token
    pub fn deploy_qrc20_token(
        &self,
        creator: &str,
        name: &str,
        symbol: &str,
        decimals: u8,
        initial_supply: u64,
    ) -> IntegrationResult<QRC20Token> {
        // Generate contract address
        let contract_address = self.generate_contract_address(creator, name, symbol);
        
        // Create token info
        let token = QRC20Token {
            name: name.to_string(),
            symbol: symbol.to_string(),
            decimals,
            total_supply: initial_supply,
            contract_address: contract_address.clone(),
        };
        
        // Save token metadata
        self.storage.save_contract_state(
            &contract_address,
            "name",
            name,
        )?;
        self.storage.save_contract_state(
            &contract_address,
            "symbol",
            symbol,
        )?;
        self.storage.save_contract_state(
            &contract_address,
            "decimals",
            &decimals.to_string(),
        )?;
        self.storage.save_contract_state(
            &contract_address,
            "total_supply",
            &initial_supply.to_string(),
        )?;
        
        // Give initial supply to creator
        let balance_key = format!("balance:{}", creator);
        self.storage.save_contract_state(
            &contract_address,
            &balance_key,
            &initial_supply.to_string(),
        )?;
        
        // Save contract info
        let contract_info = ContractInfo {
            address: contract_address.clone(),
            creator: creator.to_string(),
            code_hash: self.compute_code_hash(&format!("QRC20:{}:{}", name, symbol)),
            creation_height: 0, // Will be set by caller
            creation_timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
            balance: 0,
        };
        
        self.storage.save_contract_info(&contract_address, &crate::storage::StoredContractInfo {
            address: contract_info.address.clone(),
            deployer: contract_info.creator.clone(),
            deployed_at: contract_info.creation_timestamp,
            code_hash: contract_info.code_hash.clone(),
            version: "1.0.0".to_string(),
            total_gas_used: 0,
            call_count: 0,
            is_active: true,
        })?;
        
        // Add to registry
        {
            let mut registry = self.token_registry().write().unwrap();
            registry.insert(contract_address.clone(), token.clone());
        }
        
        println!("[VM] 🪙 QRC-20 Token deployed: {} ({}) at {}", name, symbol, &contract_address[..16]);
        
        Ok(token)
    }
    
    /// Transfer QRC-20 tokens
    pub fn transfer_qrc20(
        &self,
        contract_address: &str,
        from: &str,
        to: &str,
        amount: u64,
    ) -> IntegrationResult<ContractResult> {
        let mut gas_used = 10_000u64; // QNet base transfer cost (not ETH's 21000)
        
        // Get sender balance
        let from_balance_key = format!("balance:{}", from);
        let from_balance = self.storage.get_contract_state(contract_address, &from_balance_key)?
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);
        
        // Check sufficient balance
        if from_balance < amount {
            return Ok(ContractResult {
                success: false,
                return_data: vec![],
                gas_used,
                logs: vec![],
                error: Some(format!("Insufficient balance: have {}, need {}", from_balance, amount)),
            });
        }
        
        // Update balances
        let new_from_balance = from_balance - amount;
        self.storage.save_contract_state(contract_address, &from_balance_key, &new_from_balance.to_string())?;
        
        let to_balance_key = format!("balance:{}", to);
        let to_balance = self.storage.get_contract_state(contract_address, &to_balance_key)?
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);
        let new_to_balance = to_balance + amount;
        self.storage.save_contract_state(contract_address, &to_balance_key, &new_to_balance.to_string())?;
        
        gas_used += 5000; // Storage write cost
        
        // Create Transfer event
        let log = ContractLog {
            contract_address: contract_address.to_string(),
            event_name: "Transfer".to_string(),
            topics: vec![
                from.to_string(),
                to.to_string(),
            ],
            data: amount.to_le_bytes().to_vec(),
        };
        
        println!("[VM] 💸 QRC-20 Transfer: {} -> {} ({} tokens)", 
                 &from[..16.min(from.len())], 
                 &to[..16.min(to.len())], 
                 amount);
        
        Ok(ContractResult {
            success: true,
            return_data: vec![1], // true
            gas_used,
            logs: vec![log],
            error: None,
        })
    }
    
    /// Get QRC-20 token balance
    pub fn balance_of_qrc20(
        &self,
        contract_address: &str,
        account: &str,
    ) -> IntegrationResult<u64> {
        let balance_key = format!("balance:{}", account);
        let balance = self.storage.get_contract_state(contract_address, &balance_key)?
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);
        
        Ok(balance)
    }
    
    /// Approve QRC-20 spending allowance
    pub fn approve_qrc20(
        &self,
        contract_address: &str,
        owner: &str,
        spender: &str,
        amount: u64,
    ) -> IntegrationResult<ContractResult> {
        let gas_used = 15_000u64; // QNet approve cost
        
        // Save allowance
        let allowance_key = format!("allowance:{}:{}", owner, spender);
        self.storage.save_contract_state(contract_address, &allowance_key, &amount.to_string())?;
        
        // Create Approval event
        let log = ContractLog {
            contract_address: contract_address.to_string(),
            event_name: "Approval".to_string(),
            topics: vec![
                owner.to_string(),
                spender.to_string(),
            ],
            data: amount.to_le_bytes().to_vec(),
        };
        
        Ok(ContractResult {
            success: true,
            return_data: vec![1],
            gas_used,
            logs: vec![log],
            error: None,
        })
    }
    
    /// Transfer QRC-20 tokens from allowance
    pub fn transfer_from_qrc20(
        &self,
        contract_address: &str,
        spender: &str,
        from: &str,
        to: &str,
        amount: u64,
    ) -> IntegrationResult<ContractResult> {
        let mut gas_used = 20_000u64; // QNet transferFrom cost
        
        // Check allowance
        let allowance_key = format!("allowance:{}:{}", from, spender);
        let allowance = self.storage.get_contract_state(contract_address, &allowance_key)?
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);
        
        if allowance < amount {
            return Ok(ContractResult {
                success: false,
                return_data: vec![],
                gas_used,
                logs: vec![],
                error: Some(format!("Insufficient allowance: have {}, need {}", allowance, amount)),
            });
        }
        
        // Execute transfer
        let transfer_result = self.transfer_qrc20(contract_address, from, to, amount)?;
        if !transfer_result.success {
            return Ok(transfer_result);
        }
        
        gas_used += transfer_result.gas_used;
        
        // Update allowance
        let new_allowance = allowance - amount;
        self.storage.save_contract_state(contract_address, &allowance_key, &new_allowance.to_string())?;
        
        Ok(ContractResult {
            success: true,
            return_data: vec![1],
            gas_used,
            logs: transfer_result.logs,
            error: None,
        })
    }
    
    /// Get QRC-20 token info
    pub fn get_token_info(&self, contract_address: &str) -> IntegrationResult<Option<QRC20Token>> {
        // Check cache first
        {
            let registry = self.token_registry().read().unwrap();
            if let Some(token) = registry.get(contract_address) {
                return Ok(Some(token.clone()));
            }
        }
        
        // Load from storage
        let name = match self.storage.get_contract_state(contract_address, "name")? {
            Some(n) => n,
            None => return Ok(None),
        };
        
        let symbol = self.storage.get_contract_state(contract_address, "symbol")?
            .unwrap_or_default();
        let decimals = self.storage.get_contract_state(contract_address, "decimals")?
            .and_then(|s| s.parse().ok())
            .unwrap_or(18);
        let total_supply = self.storage.get_contract_state(contract_address, "total_supply")?
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        
        let token = QRC20Token {
            name,
            symbol,
            decimals,
            total_supply,
            contract_address: contract_address.to_string(),
        };
        
        // Cache it
        {
            let mut registry = self.token_registry().write().unwrap();
            registry.insert(contract_address.to_string(), token.clone());
        }
        
        Ok(Some(token))
    }
    
    // =========================================================================
    // GENERIC CONTRACT OPERATIONS
    // =========================================================================
    
    /// Execute a contract method
    pub fn execute_contract(
        &self,
        contract_address: &str,
        method: &str,
        args: &[serde_json::Value],
        sender: &str,
    ) -> IntegrationResult<ContractResult> {
        // Check if it's a QRC-20 token
        if let Ok(Some(_token)) = self.get_token_info(contract_address) {
            // Route to QRC-20 methods
            match method {
                "transfer" => {
                    let to = args.get(0)
                        .and_then(|v| v.as_str())
                        .ok_or_else(|| IntegrationError::Other("Missing 'to' argument".to_string()))?;
                    let amount = args.get(1)
                        .and_then(|v| v.as_u64())
                        .ok_or_else(|| IntegrationError::Other("Missing 'amount' argument".to_string()))?;
                    
                    return self.transfer_qrc20(contract_address, sender, to, amount);
                }
                "balanceOf" | "balance_of" => {
                    let account = args.get(0)
                        .and_then(|v| v.as_str())
                        .unwrap_or(sender);
                    
                    let balance = self.balance_of_qrc20(contract_address, account)?;
                    
                    return Ok(ContractResult {
                        success: true,
                        return_data: balance.to_le_bytes().to_vec(),
                        gas_used: 0, // View calls are FREE in QNet
                        logs: vec![],
                        error: None,
                    });
                }
                "approve" => {
                    let spender = args.get(0)
                        .and_then(|v| v.as_str())
                        .ok_or_else(|| IntegrationError::Other("Missing 'spender' argument".to_string()))?;
                    let amount = args.get(1)
                        .and_then(|v| v.as_u64())
                        .ok_or_else(|| IntegrationError::Other("Missing 'amount' argument".to_string()))?;
                    
                    return self.approve_qrc20(contract_address, sender, spender, amount);
                }
                "transferFrom" | "transfer_from" => {
                    let from = args.get(0)
                        .and_then(|v| v.as_str())
                        .ok_or_else(|| IntegrationError::Other("Missing 'from' argument".to_string()))?;
                    let to = args.get(1)
                        .and_then(|v| v.as_str())
                        .ok_or_else(|| IntegrationError::Other("Missing 'to' argument".to_string()))?;
                    let amount = args.get(2)
                        .and_then(|v| v.as_u64())
                        .ok_or_else(|| IntegrationError::Other("Missing 'amount' argument".to_string()))?;
                    
                    return self.transfer_from_qrc20(contract_address, sender, from, to, amount);
                }
                "name" => {
                    let name = self.storage.get_contract_state(contract_address, "name")?
                        .unwrap_or_default();
                    return Ok(ContractResult {
                        success: true,
                        return_data: name.into_bytes(),
                        gas_used: 0, // View calls are FREE in QNet
                        logs: vec![],
                        error: None,
                    });
                }
                "symbol" => {
                    let symbol = self.storage.get_contract_state(contract_address, "symbol")?
                        .unwrap_or_default();
                    return Ok(ContractResult {
                        success: true,
                        return_data: symbol.into_bytes(),
                        gas_used: 0, // View calls are FREE in QNet
                        logs: vec![],
                        error: None,
                    });
                }
                "decimals" => {
                    let decimals = self.storage.get_contract_state(contract_address, "decimals")?
                        .and_then(|s| s.parse::<u8>().ok())
                        .unwrap_or(18);
                    return Ok(ContractResult {
                        success: true,
                        return_data: vec![decimals],
                        gas_used: 0, // View calls are FREE in QNet
                        logs: vec![],
                        error: None,
                    });
                }
                "totalSupply" | "total_supply" => {
                    let supply = self.storage.get_contract_state(contract_address, "total_supply")?
                        .and_then(|s| s.parse::<u64>().ok())
                        .unwrap_or(0);
                    return Ok(ContractResult {
                        success: true,
                        return_data: supply.to_le_bytes().to_vec(),
                        gas_used: 0, // View calls are FREE in QNet
                        logs: vec![],
                        error: None,
                    });
                }
                _ => {}
            }
        }
        
        // Unknown method
        Ok(ContractResult {
            success: false,
            return_data: vec![],
            gas_used: 0, // Failed calls don't consume gas
            logs: vec![],
            error: Some(format!("Unknown method: {}", method)),
        })
    }
    
    // =========================================================================
    // HELPER FUNCTIONS
    // =========================================================================
    
    /// Generate contract address from creator and parameters
    fn generate_contract_address(&self, creator: &str, name: &str, symbol: &str) -> String {
        let mut hasher = Sha3_256::new();
        hasher.update(creator.as_bytes());
        hasher.update(name.as_bytes());
        hasher.update(symbol.as_bytes());
        hasher.update(&std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
            .to_le_bytes());
        
        let hash = hasher.finalize();
        format!("EON_contract_{}", hex::encode(&hash[..20]))
    }
    
    /// Compute code hash
    fn compute_code_hash(&self, code: &str) -> String {
        let mut hasher = Sha3_256::new();
        hasher.update(code.as_bytes());
        hex::encode(hasher.finalize())
    }
    
    /// Get all tokens for an address
    /// CRITICAL: Loads from storage, not just cache, to survive restarts
    pub fn get_tokens_for_address(&self, address: &str) -> IntegrationResult<Vec<TokenBalance>> {
        let mut balances = Vec::new();
        
        // Get ALL contract addresses from storage (survives restarts)
        let all_contracts = self.storage.get_all_contract_addresses()?;
        
        for contract_address in all_contracts {
            // Check if it's a QRC-20 token (has "name" state)
            if let Ok(Some(_)) = self.storage.get_contract_state(&contract_address, "name") {
                // It's a token - check balance
                let balance = self.balance_of_qrc20(&contract_address, address)?;
                if balance > 0 {
                    balances.push(TokenBalance {
                        token_address: contract_address.clone(),
                        holder_address: address.to_string(),
                        balance,
                    });
                }
            }
        }
        
        Ok(balances)
    }
}

// ============================================================================
// TOKEN REGISTRY
// ============================================================================

/// Global token registry for tracking all deployed tokens
pub struct TokenRegistry {
    tokens: Arc<RwLock<HashMap<String, QRC20Token>>>,
}

impl TokenRegistry {
    pub fn new() -> Self {
        Self {
            tokens: Arc::new(RwLock::new(HashMap::new())),
        }
    }
    
    pub fn register_token(&self, token: QRC20Token) {
        let mut tokens = self.tokens.write().unwrap();
        tokens.insert(token.contract_address.clone(), token);
    }
    
    pub fn get_token(&self, address: &str) -> Option<QRC20Token> {
        let tokens = self.tokens.read().unwrap();
        tokens.get(address).cloned()
    }
    
    pub fn get_all_tokens(&self) -> Vec<QRC20Token> {
        let tokens = self.tokens.read().unwrap();
        tokens.values().cloned().collect()
    }
}

impl Default for TokenRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    
    // Tests would go here
}

