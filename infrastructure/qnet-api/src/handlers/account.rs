//! Account-related API handlers

use actix_web::{web, HttpResponse};
use serde::{Deserialize, Serialize};
use crate::{error::{ApiError, ApiResult}, state::AppState};


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
    pub reputation: f64,
    pub created_at: u64,
    pub updated_at: u64,
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
                // PRODUCTION: Compute activation status from account state
                activation_status: Some(if account.is_node {
                    "Active".to_string()
                } else {
                    "NotActivated".to_string()
                }),
                // PRODUCTION: Use updated_at as last activity
                last_activity: account.updated_at,
                // PRODUCTION: Transaction count not implemented yet (would require indexing)
                transaction_count: 0,
                reputation: account.reputation,
                created_at: account.created_at,
                updated_at: account.updated_at,
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
    
    // PRODUCTION: Account transaction indexing not implemented yet
    // This would require separate transaction index by account
    let response_txs: Vec<serde_json::Value> = vec![]; // Return empty array until indexing is implemented
    
    Ok(HttpResponse::Ok().json(serde_json::json!({
        "address": address.as_str(),
        "transactions": response_txs,
        "count": response_txs.len(),
        "limit": limit,
        "offset": offset,
        "has_more": response_txs.len() == limit as usize
    })))
}

/// Extract 'to' address from transaction type
fn get_transaction_to(tx_type: &qnet_state::transaction::TransactionType) -> Option<String> {
    match tx_type {
        qnet_state::transaction::TransactionType::Transfer { to, .. } => Some(to.clone()),
        qnet_state::transaction::TransactionType::CreateAccount { address, .. } => Some(address.clone()),
        qnet_state::transaction::TransactionType::ContractDeploy => None,
        qnet_state::transaction::TransactionType::ContractCall => None,
        qnet_state::transaction::TransactionType::NodeActivation { .. } => None,
        qnet_state::transaction::TransactionType::RewardDistribution => None,
        qnet_state::transaction::TransactionType::BatchRewardClaims { .. } => None,
        qnet_state::transaction::TransactionType::BatchNodeActivations { .. } => None,
        qnet_state::transaction::TransactionType::BatchTransfers { .. } => None,
    }
}

/// Extract amount from transaction type
fn get_transaction_amount(tx_type: &qnet_state::transaction::TransactionType) -> u64 {
    match tx_type {
        qnet_state::transaction::TransactionType::Transfer { amount, .. } => *amount,
        qnet_state::transaction::TransactionType::CreateAccount { initial_balance, .. } => *initial_balance,
        qnet_state::transaction::TransactionType::NodeActivation { amount, .. } => *amount,
        qnet_state::transaction::TransactionType::ContractDeploy => 0,
        qnet_state::transaction::TransactionType::ContractCall => 0,
        qnet_state::transaction::TransactionType::RewardDistribution => 0,
        qnet_state::transaction::TransactionType::BatchRewardClaims { .. } => 0, // Batch amount varies
        qnet_state::transaction::TransactionType::BatchNodeActivations { .. } => 0, // Batch amount varies
        qnet_state::transaction::TransactionType::BatchTransfers { .. } => 0, // Batch amount varies
    }
}

/// Get human-readable transaction type name
fn get_transaction_type_name(tx_type: &qnet_state::transaction::TransactionType) -> &'static str {
    match tx_type {
        qnet_state::transaction::TransactionType::Transfer { .. } => "transfer",
        qnet_state::transaction::TransactionType::CreateAccount { .. } => "create_account",
        qnet_state::transaction::TransactionType::NodeActivation { .. } => "node_activation",
        qnet_state::transaction::TransactionType::ContractDeploy => "contract_deploy",
        qnet_state::transaction::TransactionType::ContractCall => "contract_call",
        qnet_state::transaction::TransactionType::RewardDistribution => "reward_distribution",
        qnet_state::transaction::TransactionType::BatchRewardClaims { .. } => "batch_reward_claims",
        qnet_state::transaction::TransactionType::BatchNodeActivations { .. } => "batch_node_activations",
        qnet_state::transaction::TransactionType::BatchTransfers { .. } => "batch_transfers",
    }
} 