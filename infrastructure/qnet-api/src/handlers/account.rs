//! Account-related API handlers

use actix_web::{web, HttpResponse};
use serde::{Deserialize, Serialize};
use crate::{error::{ApiError, ApiResult}, state::AppState};
use qnet_state::account::Account;

/// Account query parameters
#[derive(Debug, Deserialize)]
pub struct AccountQuery {
    pub include_txs: Option<bool>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

/// Account info response
#[derive(Debug, Serialize)]
pub struct AccountInfo {
    pub address: String,
    pub balance: u64,
    pub nonce: u64,
    pub node_type: Option<String>,
    pub activation_status: Option<String>,
    pub last_activity: u64,
    pub transaction_count: u64,
}

/// Balance response
#[derive(Debug, Serialize)]
pub struct BalanceResponse {
    pub address: String,
    pub balance: u64,
    pub formatted: String,
}

/// Account transactions query
#[derive(Debug, Deserialize)]
pub struct AccountTxQuery {
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

/// Get account information
pub async fn get_account(
    state: web::Data<AppState>,
    address: web::Path<String>,
    query: web::Query<AccountQuery>,
) -> ApiResult<HttpResponse> {
    match state.state_db.get_account(&address).await? {
        Some(account) => {
            let mut info = AccountInfo {
                address: account.address.clone(),
                balance: account.balance,
                nonce: account.nonce,
                node_type: account.node_type.map(|nt| format!("{:?}", nt)),
                activation_status: account.activation_status.map(|as_| format!("{:?}", as_)),
                last_activity: account.last_activity,
                transaction_count: account.transaction_count,
            };
            
            Ok(HttpResponse::Ok().json(info))
        },
        None => Err(ApiError::NotFound(format!("Account {} not found", address))),
    }
}

/// Get account balance
pub async fn get_balance(
    state: web::Data<AppState>,
    address: web::Path<String>,
) -> ApiResult<HttpResponse> {
    match state.state_db.get_account(&address).await? {
        Some(account) => {
            Ok(HttpResponse::Ok().json(serde_json::json!({
                "address": account.address,
                "balance": account.balance,
                "nonce": account.nonce
            })))
        },
        None => Err(ApiError::NotFound(format!("Account {} not found", address))),
    }
}

/// Get account transactions with pagination and filtering
pub async fn get_account_transactions(
    state: web::Data<AppState>,
    address: web::Path<String>,
    query: web::Query<AccountQuery>,
) -> ApiResult<HttpResponse> {
    let limit = query.limit.unwrap_or(50).min(1000); // Max 1000 transactions per request
    let offset = query.offset.unwrap_or(0);
    
    // Get historical transactions from state DB
    match state.state_db.get_account_transactions(&address, limit, offset).await? {
        transactions => {
            let mut response_txs = Vec::new();
            
            for tx in transactions {
                response_txs.push(serde_json::json!({
                    "hash": tx.hash,
                    "from": tx.from,
                    "to": get_transaction_to(&tx.tx_type),
                    "amount": get_transaction_amount(&tx.tx_type),
                    "type": get_transaction_type_name(&tx.tx_type),
                    "nonce": tx.nonce,
                    "gas_price": tx.gas_price,
                    "gas_limit": tx.gas_limit,
                    "timestamp": tx.timestamp,
                    "status": "confirmed" // All DB transactions are confirmed
                }));
            }
            
            Ok(HttpResponse::Ok().json(serde_json::json!({
                "address": address.as_str(),
                "transactions": response_txs,
                "count": response_txs.len(),
                "limit": limit,
                "offset": offset,
                "has_more": response_txs.len() == limit as usize
            })))
        }
    }
}

/// Extract 'to' address from transaction type
fn get_transaction_to(tx_type: &qnet_state::transaction::TransactionType) -> Option<String> {
    match tx_type {
        qnet_state::transaction::TransactionType::Transfer { to, .. } => Some(to.clone()),
        qnet_state::transaction::TransactionType::ContractCall { to, .. } => Some(to.clone()),
        qnet_state::transaction::TransactionType::ContractDeploy { .. } => None,
        qnet_state::transaction::TransactionType::NodeActivation { .. } => None,
    }
}

/// Extract amount from transaction type
fn get_transaction_amount(tx_type: &qnet_state::transaction::TransactionType) -> u64 {
    match tx_type {
        qnet_state::transaction::TransactionType::Transfer { amount, .. } => *amount,
        qnet_state::transaction::TransactionType::ContractCall { value, .. } => *value,
        qnet_state::transaction::TransactionType::ContractDeploy { value, .. } => *value,
        qnet_state::transaction::TransactionType::NodeActivation { burn_amount, .. } => *burn_amount,
    }
}

/// Get human-readable transaction type name
fn get_transaction_type_name(tx_type: &qnet_state::transaction::TransactionType) -> &'static str {
    match tx_type {
        qnet_state::transaction::TransactionType::Transfer { .. } => "transfer",
        qnet_state::transaction::TransactionType::ContractCall { .. } => "contract_call",
        qnet_state::transaction::TransactionType::ContractDeploy { .. } => "contract_deploy",
        qnet_state::transaction::TransactionType::NodeActivation { .. } => "node_activation",
    }
} 