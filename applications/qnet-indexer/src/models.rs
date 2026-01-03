//! Data models for the indexer

use serde::{Deserialize, Serialize};
use sqlx::FromRow;

/// Block model
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Block {
    pub height: u64,
    pub hash: String,
    pub previous_hash: Option<String>,
    pub timestamp: u64,
    pub producer: String,
    pub tx_count: usize,
    pub merkle_root: Option<String>,
    pub signature: Option<String>,
    pub poh_hash: Option<String>,
    pub poh_count: Option<u64>,
}

/// Block row from database
#[derive(Debug, FromRow)]
pub struct BlockRow {
    pub height: i64,
    pub hash: String,
    pub previous_hash: Option<String>,
    pub timestamp: i64,
    pub producer: String,
    pub tx_count: i32,
    pub merkle_root: Option<String>,
    pub signature: Option<String>,
    pub poh_hash: Option<String>,
    pub poh_count: Option<i64>,
}

impl From<BlockRow> for Block {
    fn from(row: BlockRow) -> Self {
        Self {
            height: row.height as u64,
            hash: row.hash,
            previous_hash: row.previous_hash,
            timestamp: row.timestamp as u64,
            producer: row.producer,
            tx_count: row.tx_count as usize,
            merkle_root: row.merkle_root,
            signature: row.signature,
            poh_hash: row.poh_hash,
            poh_count: row.poh_count.map(|c| c as u64),
        }
    }
}

/// Transaction model
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Transaction {
    pub hash: String,
    pub block_height: u64,
    pub tx_index: usize,
    pub tx_type: String,
    pub from_address: String,
    pub to_address: Option<String>,
    pub amount: u64,
    pub gas_price: u64,
    pub gas_limit: u64,
    pub gas_used: Option<u64>,
    pub nonce: u64,
    pub timestamp: u64,
    pub signature: Option<String>,
    pub public_key: Option<String>,
    pub dilithium_signature: Option<String>,
    pub dilithium_public_key: Option<String>,
    pub data: Option<String>,
    pub status: String,
}

/// Transaction row from database
#[derive(Debug, FromRow)]
pub struct TransactionRow {
    pub hash: String,
    pub block_height: i64,
    pub tx_index: i32,
    pub tx_type: String,
    pub from_address: String,
    pub to_address: Option<String>,
    pub amount: i64,
    pub gas_price: i64,
    pub gas_limit: i64,
    pub gas_used: Option<i64>,
    pub nonce: i64,
    pub timestamp: i64,
    pub signature: Option<String>,
    pub public_key: Option<String>,
    pub dilithium_signature: Option<String>,
    pub dilithium_public_key: Option<String>,
    pub data: Option<String>,
    pub status: String,
}

impl From<TransactionRow> for Transaction {
    fn from(row: TransactionRow) -> Self {
        Self {
            hash: row.hash,
            block_height: row.block_height as u64,
            tx_index: row.tx_index as usize,
            tx_type: row.tx_type,
            from_address: row.from_address,
            to_address: row.to_address,
            amount: row.amount as u64,
            gas_price: row.gas_price as u64,
            gas_limit: row.gas_limit as u64,
            gas_used: row.gas_used.map(|g| g as u64),
            nonce: row.nonce as u64,
            timestamp: row.timestamp as u64,
            signature: row.signature,
            public_key: row.public_key,
            dilithium_signature: row.dilithium_signature,
            dilithium_public_key: row.dilithium_public_key,
            data: row.data,
            status: row.status,
        }
    }
}

/// Account model
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Account {
    pub address: String,
    pub balance: u64,
    pub tx_count: usize,
    pub first_seen: u64,
    pub last_active: u64,
    pub is_contract: bool,
    pub node_type: Option<String>,
    pub node_id: Option<String>,
}

/// Account row from database
#[derive(Debug, FromRow)]
pub struct AccountRow {
    pub address: String,
    pub balance: i64,
    pub tx_count: i32,
    pub first_seen: i64,
    pub last_active: i64,
    pub is_contract: bool,
    pub node_type: Option<String>,
    pub node_id: Option<String>,
}

impl From<AccountRow> for Account {
    fn from(row: AccountRow) -> Self {
        Self {
            address: row.address,
            balance: row.balance as u64,
            tx_count: row.tx_count as usize,
            first_seen: row.first_seen as u64,
            last_active: row.last_active as u64,
            is_contract: row.is_contract,
            node_type: row.node_type,
            node_id: row.node_id,
        }
    }
}

/// WebSocket event from QNet node
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum WsEvent {
    #[serde(rename = "new_block")]
    NewBlock {
        height: u64,
        hash: String,
        timestamp: u64,
        tx_count: usize,
        producer: String,
    },
    #[serde(rename = "pending_tx")]
    PendingTx {
        hash: String,
        from: String,
        to: Option<String>,
        amount: u64,
        gas_price: u64,
    },
    #[serde(rename = "reward_claimed")]
    RewardClaimed {
        node_id: String,
        wallet_address: String,
        amount_qnc: f64,
        tx_hash: String,
        epoch: u64,
    },
    #[serde(rename = "connected")]
    Connected {
        message: String,
        subscribed_channels: usize,
        timestamp: u64,
    },
}

/// API response for blocks list
#[derive(Debug, Serialize)]
pub struct BlocksResponse {
    pub blocks: Vec<Block>,
    pub total: u64,
    pub page: u32,
    pub per_page: u32,
}

/// API response for transactions list
#[derive(Debug, Serialize)]
pub struct TransactionsResponse {
    pub transactions: Vec<Transaction>,
    pub total: u64,
    pub page: u32,
    pub per_page: u32,
}

/// API response for address info
#[derive(Debug, Serialize)]
pub struct AddressResponse {
    pub address: String,
    pub balance: String,
    pub tx_count: usize,
    pub first_seen: u64,
    pub last_active: u64,
    pub transactions: Vec<Transaction>,
}

/// Network stats response
#[derive(Debug, Serialize)]
pub struct NetworkStatsResponse {
    pub height: u64,
    pub total_transactions: u64,
    pub total_accounts: u64,
    pub tps_1min: f64,
    pub tps_5min: f64,
    pub last_block_time: u64,
}

