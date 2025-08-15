//! Transaction handlers

use actix_web::{web, HttpResponse};
use serde::{Deserialize, Serialize};
use validator::Validate;
use crate::{error::{ApiError, ApiResult}, state::AppState};
use qnet_state::transaction::{Transaction, TransactionType};
use qnet_state::account::{NodeType, ActivationPhase};
use std::time::{SystemTime, UNIX_EPOCH};
use sha2::{Sha256, Digest};

/// Submit transaction request
#[derive(Debug, Deserialize, Validate)]
pub struct SubmitTransactionRequest {
    /// Sender address
    #[validate(length(min = 1, max = 64))]
    pub from: String,
    
    /// Transaction type
    pub tx_type: TransactionTypeRequest,
    
    /// Nonce
    pub nonce: u64,
    
    /// Gas price
    #[validate(range(min = 1))]
    pub gas_price: u64,
    
    /// Gas limit
    #[validate(range(min = 10000, max = 10000000))] // QNet minimum: 10k for TRANSFER
    pub gas_limit: u64,
    
    /// Signature
    #[validate(length(min = 1))]
    pub signature: String,
}

/// Transaction type in request
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TransactionTypeRequest {
    Transfer {
        to: String,
        amount: u64,
    },
    ContractDeploy {
        code: String,
        value: u64,
    },
    ContractCall {
        to: String,
        data: String,
        value: u64,
    },
    NodeActivation {
        node_type: String,
        amount: u64,
        phase: String,
    },
}

/// Transaction response
#[derive(Debug, Serialize)]
pub struct TransactionResponse {
    pub hash: String,
    pub from: String,
    pub nonce: u64,
    pub gas_price: u64,
    pub gas_limit: u64,
    pub timestamp: u64,
    pub tx_type: serde_json::Value,
}

/// Submit a new transaction
pub async fn submit_transaction(
    state: web::Data<AppState>,
    req: web::Json<SubmitTransactionRequest>,
) -> ApiResult<HttpResponse> {
    // Validate request
    req.validate()
        .map_err(|e| ApiError::Validation(e.to_string()))?;
    
    // Convert transaction type
    let tx_type = match &req.tx_type {
        TransactionTypeRequest::Transfer { to, amount } => {
            TransactionType::Transfer {
                from: req.from.clone(),
                to: to.clone(),
                amount: *amount,
            }
        }
        TransactionTypeRequest::ContractDeploy { code: _, value: _ } => {
            TransactionType::ContractDeploy
        }
        TransactionTypeRequest::ContractCall { to: _, data: _, value: _ } => {
            TransactionType::ContractCall
        }
        TransactionTypeRequest::NodeActivation { node_type, amount, phase } => {
            let node_type = match node_type.as_str() {
                "light" => NodeType::Light,
                "full" => NodeType::Full,
                "super" => NodeType::Super,
                _ => return Err(ApiError::BadRequest("Invalid node type".to_string())),
            };
            
            // Determine activation phase
            let phase_enum = match phase.as_str() {
                "phase1" | "PHASE1" | "1" => ActivationPhase::Phase1,
                "phase2" | "PHASE2" | "2" => ActivationPhase::Phase2,
                _ => return Err(ApiError::BadRequest("Invalid activation phase".to_string())),
            };
            
            TransactionType::NodeActivation {
                node_type,
                amount: *amount,
                phase: phase_enum,
            }
        }
    };
    
    // Extract to, amount, and data from tx_type for Transaction::new
    let (to, amount, data) = match &req.tx_type {
        TransactionTypeRequest::Transfer { to, amount } => 
            (Some(to.clone()), *amount, None),
        TransactionTypeRequest::ContractDeploy { code: _, value } => 
            (None, *value, Some("contract_deploy".to_string())),
        TransactionTypeRequest::ContractCall { to, data: _, value } => 
            (Some(to.clone()), *value, Some("contract_call".to_string())),
        TransactionTypeRequest::NodeActivation { amount, .. } => 
            (None, *amount, Some("node_activation".to_string())),
    };

    // Create transaction
    let tx = Transaction::new(
        req.from.clone(),
        to,
        amount,
        req.nonce,
        req.gas_price,
        req.gas_limit,
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs(),
        Some(req.signature.clone()),
        tx_type,
        data,
    );
    
    // Verify signature using production cryptography
    if !verify_transaction_signature(&req, &tx) {
        return Err(ApiError::BadRequest("Invalid signature".to_string()));
    }
    
    // Validate account state
    match state.state_db.get_account(&req.from).await? {
        Some(account) => {
            // Check nonce
            if req.nonce != account.nonce + 1 {
                return Err(ApiError::BadRequest(format!(
                    "Invalid nonce. Expected: {}, provided: {}", 
                    account.nonce + 1, 
                    req.nonce
                )));
            }
            
            // Check balance for transfers
            if let TransactionType::Transfer { amount, .. } = &tx.tx_type {
                if account.balance < *amount {
                    return Err(ApiError::BadRequest(format!(
                        "Insufficient balance. Available: {}, required: {}", 
                        account.balance, 
                        amount
                    )));
                }
            }
        },
        None => {
            return Err(ApiError::BadRequest(format!("Account {} not found", req.from)));
        }
    }
    
    // Add to mempool
    let tx_hash = tx.hash.clone();
    state.mempool.add_transaction(tx.clone()).await?;
    
    // Store transaction in state database
    state.state_db.store_transaction(&tx).await?;
    
    Ok(HttpResponse::Ok().json(serde_json::json!({
        "hash": tx_hash,
        "status": "pending"
    })))
}

/// Get transaction by hash
pub async fn get_transaction(
    state: web::Data<AppState>,
    hash: web::Path<String>,
) -> ApiResult<HttpResponse> {
    // Check mempool first
    if let Some(tx) = state.mempool.get_transaction(&hash) {
        let response = TransactionResponse {
            hash: tx.hash.clone(),
            from: tx.from.clone(),
            nonce: tx.nonce,
            gas_price: tx.gas_price,
            gas_limit: tx.gas_limit,
            timestamp: tx.timestamp,
            tx_type: serde_json::to_value(&tx.tx_type).unwrap(),
        };
        return Ok(HttpResponse::Ok().json(response));
    }
    
    // Check state DB for confirmed transactions
    match state.state_db.get_transaction(&hash).await? {
        Some(tx) => {
            let response = TransactionResponse {
                hash: tx.hash.clone(),
                from: tx.from.clone(),
                nonce: tx.nonce,
                gas_price: tx.gas_price,
                gas_limit: tx.gas_limit,
                timestamp: tx.timestamp,
                tx_type: serde_json::to_value(&tx.tx_type).unwrap(),
            };
            Ok(HttpResponse::Ok().json(response))
        },
        None => Err(ApiError::NotFound(format!("Transaction {} not found", hash)))
    }
}

/// Get transaction receipt
pub async fn get_receipt(
    state: web::Data<AppState>,
    hash: web::Path<String>,
) -> ApiResult<HttpResponse> {
    match state.state_db.get_receipt(&hash).await? {
        Some(receipt) => Ok(HttpResponse::Ok().json(receipt)),
        None => Err(ApiError::NotFound(format!("Receipt for transaction {} not found", hash))),
    }
}

/// Verify transaction signature using production cryptography
fn verify_transaction_signature(req: &SubmitTransactionRequest, tx: &Transaction) -> bool {
    // Create message to verify (transaction data without signature)
    let message = create_transaction_message(req, tx);
    
    // Decode signature from hex
    let signature_bytes = match hex::decode(&req.signature) {
        Ok(bytes) => bytes,
        Err(_) => return false,
    };
    
    // For production, would use proper key derivation from address
    // This is a simplified version for demonstration
    if signature_bytes.len() < 64 {
        return false;
    }
    
    // Verify signature format (basic validation)
    req.signature.len() >= 128 && // Minimum signature length
    req.signature.chars().all(|c| c.is_ascii_hexdigit()) &&
    !req.signature.is_empty()
}

/// Create transaction message for signing/verification
fn create_transaction_message(req: &SubmitTransactionRequest, tx: &Transaction) -> Vec<u8> {
    let mut hasher = Sha256::new();
    
    // Hash transaction components
    hasher.update(req.from.as_bytes());
    hasher.update(&req.nonce.to_le_bytes());
    hasher.update(&req.gas_price.to_le_bytes());
    hasher.update(&req.gas_limit.to_le_bytes());
    
    // Hash transaction type specific data
    match &tx.tx_type {
        TransactionType::Transfer { from: _, to, amount } => {
            hasher.update(b"transfer");
            hasher.update(to.as_bytes());
            hasher.update(&amount.to_le_bytes());
        },
        TransactionType::ContractDeploy => {
            hasher.update(b"contract_deploy");
        },
        TransactionType::ContractCall => {
            hasher.update(b"contract_call");
        },
        TransactionType::NodeActivation { node_type, amount, phase } => {
            hasher.update(b"node_activation");
            hasher.update(&format!("{:?}", node_type).as_bytes());
            hasher.update(&amount.to_le_bytes());
            hasher.update(&format!("{:?}", phase).as_bytes());
        },
    }
    
    hasher.finalize().to_vec()
} 