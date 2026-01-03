//! PostgreSQL database module

use anyhow::Result;
use sqlx::postgres::{PgPool, PgPoolOptions};

/// Create PostgreSQL connection pool
pub async fn create_pool(database_url: &str) -> Result<PgPool> {
    let pool = PgPoolOptions::new()
        .max_connections(20)
        .min_connections(5)
        .acquire_timeout(std::time::Duration::from_secs(30))
        .idle_timeout(std::time::Duration::from_secs(600))
        .connect(database_url)
        .await?;
    
    Ok(pool)
}

/// Run database migrations
pub async fn run_migrations(pool: &PgPool) -> Result<()> {
    println!("[INFO][DB] migrations_running");
    
    // Create tables
    sqlx::query(r#"
        -- Blocks table
        CREATE TABLE IF NOT EXISTS blocks (
            height BIGINT PRIMARY KEY,
            hash VARCHAR(64) NOT NULL UNIQUE,
            previous_hash VARCHAR(64),
            timestamp BIGINT NOT NULL,
            producer VARCHAR(128) NOT NULL,
            tx_count INTEGER NOT NULL DEFAULT 0,
            merkle_root VARCHAR(64),
            signature TEXT,
            poh_hash VARCHAR(64),
            poh_count BIGINT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            
            -- Indices for common queries
            CONSTRAINT blocks_hash_unique UNIQUE (hash)
        );
        
        CREATE INDEX IF NOT EXISTS idx_blocks_timestamp ON blocks(timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_blocks_producer ON blocks(producer);
        
        -- Transactions table
        CREATE TABLE IF NOT EXISTS transactions (
            hash VARCHAR(64) PRIMARY KEY,
            block_height BIGINT NOT NULL REFERENCES blocks(height),
            tx_index INTEGER NOT NULL,
            tx_type VARCHAR(64) NOT NULL,
            from_address VARCHAR(128) NOT NULL,
            to_address VARCHAR(128),
            amount BIGINT NOT NULL DEFAULT 0,
            gas_price BIGINT NOT NULL DEFAULT 0,
            gas_limit BIGINT NOT NULL DEFAULT 0,
            gas_used BIGINT,
            nonce BIGINT NOT NULL DEFAULT 0,
            timestamp BIGINT NOT NULL,
            signature TEXT,
            public_key TEXT,
            dilithium_signature TEXT,
            dilithium_public_key TEXT,
            data TEXT,
            status VARCHAR(32) NOT NULL DEFAULT 'confirmed',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            
            -- Composite unique constraint
            CONSTRAINT tx_block_index_unique UNIQUE (block_height, tx_index)
        );
        
        CREATE INDEX IF NOT EXISTS idx_tx_block_height ON transactions(block_height);
        CREATE INDEX IF NOT EXISTS idx_tx_from ON transactions(from_address);
        CREATE INDEX IF NOT EXISTS idx_tx_to ON transactions(to_address);
        CREATE INDEX IF NOT EXISTS idx_tx_timestamp ON transactions(timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_tx_type ON transactions(tx_type);
        
        -- Address index for fast account queries (combines from and to)
        CREATE INDEX IF NOT EXISTS idx_tx_from_timestamp ON transactions(from_address, timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_tx_to_timestamp ON transactions(to_address, timestamp DESC);
        
        -- Accounts table (materialized view of address activity)
        CREATE TABLE IF NOT EXISTS accounts (
            address VARCHAR(128) PRIMARY KEY,
            balance BIGINT NOT NULL DEFAULT 0,
            tx_count INTEGER NOT NULL DEFAULT 0,
            first_seen BIGINT NOT NULL,
            last_active BIGINT NOT NULL,
            is_contract BOOLEAN NOT NULL DEFAULT FALSE,
            node_type VARCHAR(32),
            node_id VARCHAR(128),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        
        CREATE INDEX IF NOT EXISTS idx_accounts_balance ON accounts(balance DESC);
        CREATE INDEX IF NOT EXISTS idx_accounts_tx_count ON accounts(tx_count DESC);
        CREATE INDEX IF NOT EXISTS idx_accounts_last_active ON accounts(last_active DESC);
        
        -- Node registrations table
        CREATE TABLE IF NOT EXISTS node_registrations (
            node_id VARCHAR(128) PRIMARY KEY,
            node_type VARCHAR(32) NOT NULL,
            wallet_address VARCHAR(128) NOT NULL,
            registration_height BIGINT NOT NULL,
            registration_tx VARCHAR(64) NOT NULL REFERENCES transactions(hash),
            reputation REAL NOT NULL DEFAULT 1.0,
            status VARCHAR(32) NOT NULL DEFAULT 'active',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        
        CREATE INDEX IF NOT EXISTS idx_node_reg_wallet ON node_registrations(wallet_address);
        CREATE INDEX IF NOT EXISTS idx_node_reg_type ON node_registrations(node_type);
        
        -- Rewards table
        CREATE TABLE IF NOT EXISTS rewards (
            id SERIAL PRIMARY KEY,
            epoch INTEGER NOT NULL,
            block_height BIGINT NOT NULL,
            total_emission BIGINT NOT NULL,
            recipient_count INTEGER NOT NULL,
            emission_tx VARCHAR(64) REFERENCES transactions(hash),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            
            CONSTRAINT rewards_epoch_unique UNIQUE (epoch)
        );
        
        CREATE INDEX IF NOT EXISTS idx_rewards_epoch ON rewards(epoch DESC);
        
        -- Reward claims table
        CREATE TABLE IF NOT EXISTS reward_claims (
            id SERIAL PRIMARY KEY,
            node_id VARCHAR(128) NOT NULL,
            wallet_address VARCHAR(128) NOT NULL,
            amount BIGINT NOT NULL,
            epoch INTEGER NOT NULL,
            claim_tx VARCHAR(64) NOT NULL REFERENCES transactions(hash),
            claimed_at BIGINT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        
        CREATE INDEX IF NOT EXISTS idx_claims_wallet ON reward_claims(wallet_address);
        CREATE INDEX IF NOT EXISTS idx_claims_epoch ON reward_claims(epoch);
        
        -- Indexer state table
        CREATE TABLE IF NOT EXISTS indexer_state (
            key VARCHAR(64) PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        
        -- Stats table for dashboard
        CREATE TABLE IF NOT EXISTS network_stats (
            id SERIAL PRIMARY KEY,
            timestamp BIGINT NOT NULL,
            block_height BIGINT NOT NULL,
            total_transactions BIGINT NOT NULL,
            active_nodes INTEGER NOT NULL,
            total_accounts INTEGER NOT NULL,
            total_supply BIGINT NOT NULL,
            tps_1min REAL,
            tps_5min REAL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        
        CREATE INDEX IF NOT EXISTS idx_stats_timestamp ON network_stats(timestamp DESC);
    "#)
    .execute(pool)
    .await?;
    
    println!("[INFO][DB] tables_created");
    Ok(())
}

/// Insert a block into the database
pub async fn insert_block(
    pool: &PgPool,
    block: &crate::models::Block,
) -> Result<()> {
    sqlx::query(r#"
        INSERT INTO blocks (height, hash, previous_hash, timestamp, producer, tx_count, merkle_root, signature, poh_hash, poh_count)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (height) DO UPDATE SET
            hash = EXCLUDED.hash,
            tx_count = EXCLUDED.tx_count,
            updated_at = NOW()
    "#)
    .bind(block.height as i64)
    .bind(&block.hash)
    .bind(&block.previous_hash)
    .bind(block.timestamp as i64)
    .bind(&block.producer)
    .bind(block.tx_count as i32)
    .bind(&block.merkle_root)
    .bind(&block.signature)
    .bind(&block.poh_hash)
    .bind(block.poh_count.map(|c| c as i64))
    .execute(pool)
    .await?;
    
    Ok(())
}

/// Insert a transaction into the database
pub async fn insert_transaction(
    pool: &PgPool,
    tx: &crate::models::Transaction,
) -> Result<()> {
    sqlx::query(r#"
        INSERT INTO transactions (hash, block_height, tx_index, tx_type, from_address, to_address, amount, gas_price, gas_limit, nonce, timestamp, signature, public_key, dilithium_signature, dilithium_public_key, data, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        ON CONFLICT (hash) DO UPDATE SET
            status = EXCLUDED.status
    "#)
    .bind(&tx.hash)
    .bind(tx.block_height as i64)
    .bind(tx.tx_index as i32)
    .bind(&tx.tx_type)
    .bind(&tx.from_address)
    .bind(&tx.to_address)
    .bind(tx.amount as i64)
    .bind(tx.gas_price as i64)
    .bind(tx.gas_limit as i64)
    .bind(tx.nonce as i64)
    .bind(tx.timestamp as i64)
    .bind(&tx.signature)
    .bind(&tx.public_key)
    .bind(&tx.dilithium_signature)
    .bind(&tx.dilithium_public_key)
    .bind(&tx.data)
    .bind(&tx.status)
    .execute(pool)
    .await?;
    
    // Update account stats
    update_account_stats(pool, &tx.from_address, tx.timestamp).await?;
    if let Some(ref to) = tx.to_address {
        update_account_stats(pool, to, tx.timestamp).await?;
    }
    
    Ok(())
}

/// Update account statistics
async fn update_account_stats(pool: &PgPool, address: &str, timestamp: u64) -> Result<()> {
    sqlx::query(r#"
        INSERT INTO accounts (address, tx_count, first_seen, last_active)
        VALUES ($1, 1, $2, $2)
        ON CONFLICT (address) DO UPDATE SET
            tx_count = accounts.tx_count + 1,
            last_active = GREATEST(accounts.last_active, EXCLUDED.last_active),
            updated_at = NOW()
    "#)
    .bind(address)
    .bind(timestamp as i64)
    .execute(pool)
    .await?;
    
    Ok(())
}

/// Get the last indexed block height
pub async fn get_last_indexed_height(pool: &PgPool) -> Result<Option<u64>> {
    let result: Option<(i64,)> = sqlx::query_as(
        "SELECT COALESCE(MAX(height), -1) FROM blocks"
    )
    .fetch_optional(pool)
    .await?;
    
    Ok(result.map(|(h,)| if h < 0 { 0 } else { h as u64 }))
}

/// Get block by height
pub async fn get_block_by_height(pool: &PgPool, height: u64) -> Result<Option<crate::models::Block>> {
    let result = sqlx::query_as::<_, crate::models::BlockRow>(
        "SELECT * FROM blocks WHERE height = $1"
    )
    .bind(height as i64)
    .fetch_optional(pool)
    .await?;
    
    Ok(result.map(|r| r.into()))
}

/// Get block by hash
pub async fn get_block_by_hash(pool: &PgPool, hash: &str) -> Result<Option<crate::models::Block>> {
    let result = sqlx::query_as::<_, crate::models::BlockRow>(
        "SELECT * FROM blocks WHERE hash = $1"
    )
    .bind(hash)
    .fetch_optional(pool)
    .await?;
    
    Ok(result.map(|r| r.into()))
}

/// Get transaction by hash
pub async fn get_transaction_by_hash(pool: &PgPool, hash: &str) -> Result<Option<crate::models::Transaction>> {
    let result = sqlx::query_as::<_, crate::models::TransactionRow>(
        "SELECT * FROM transactions WHERE hash = $1"
    )
    .bind(hash)
    .fetch_optional(pool)
    .await?;
    
    Ok(result.map(|r| r.into()))
}

/// Get transactions for a block
pub async fn get_block_transactions(pool: &PgPool, height: u64) -> Result<Vec<crate::models::Transaction>> {
    let results = sqlx::query_as::<_, crate::models::TransactionRow>(
        "SELECT * FROM transactions WHERE block_height = $1 ORDER BY tx_index"
    )
    .bind(height as i64)
    .fetch_all(pool)
    .await?;
    
    Ok(results.into_iter().map(|r| r.into()).collect())
}

/// Get transactions for an address (paginated)
pub async fn get_address_transactions(
    pool: &PgPool,
    address: &str,
    page: u32,
    per_page: u32,
) -> Result<Vec<crate::models::Transaction>> {
    let offset = (page.saturating_sub(1)) * per_page;
    
    let results = sqlx::query_as::<_, crate::models::TransactionRow>(
        "SELECT * FROM transactions WHERE from_address = $1 OR to_address = $1 ORDER BY timestamp DESC LIMIT $2 OFFSET $3"
    )
    .bind(address)
    .bind(per_page as i32)
    .bind(offset as i32)
    .fetch_all(pool)
    .await?;
    
    Ok(results.into_iter().map(|r| r.into()).collect())
}

/// Get account info
pub async fn get_account(pool: &PgPool, address: &str) -> Result<Option<crate::models::Account>> {
    let result = sqlx::query_as::<_, crate::models::AccountRow>(
        "SELECT * FROM accounts WHERE address = $1"
    )
    .bind(address)
    .fetch_optional(pool)
    .await?;
    
    Ok(result.map(|r| r.into()))
}

/// Get recent blocks
pub async fn get_recent_blocks(pool: &PgPool, limit: u32) -> Result<Vec<crate::models::Block>> {
    let results = sqlx::query_as::<_, crate::models::BlockRow>(
        "SELECT * FROM blocks ORDER BY height DESC LIMIT $1"
    )
    .bind(limit as i32)
    .fetch_all(pool)
    .await?;
    
    Ok(results.into_iter().map(|r| r.into()).collect())
}

/// Get recent transactions
pub async fn get_recent_transactions(pool: &PgPool, limit: u32) -> Result<Vec<crate::models::Transaction>> {
    let results = sqlx::query_as::<_, crate::models::TransactionRow>(
        "SELECT * FROM transactions ORDER BY timestamp DESC LIMIT $1"
    )
    .bind(limit as i32)
    .fetch_all(pool)
    .await?;
    
    Ok(results.into_iter().map(|r| r.into()).collect())
}

