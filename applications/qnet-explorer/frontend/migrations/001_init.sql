-- QNet Explorer Database Schema
-- Version: 1.1.0
-- Created: 2025-01-05
-- Updated: 2025-01-23 - Added blocks table

-- Blocks table (L1 Blockchain structure)
CREATE TABLE IF NOT EXISTS blocks (
    height BIGINT PRIMARY KEY,
    hash TEXT NOT NULL,
    block_type TEXT NOT NULL DEFAULT 'MICROBLOCK',
    version INTEGER NOT NULL DEFAULT 1,
    timestamp BIGINT NOT NULL,
    previous_hash TEXT,
    merkle_root TEXT,
    state_root TEXT,
    producer TEXT NOT NULL,
    producer_address TEXT,
    tx_count INTEGER NOT NULL DEFAULT 0,
    total_gas_used BIGINT DEFAULT 0,
    poh_hash TEXT,
    poh_count BIGINT DEFAULT 0,
    signature_type TEXT DEFAULT 'ML-DSA-65',
    signature TEXT,
    cert_serial TEXT,
    qrb_output TEXT,
    size_bytes BIGINT DEFAULT 0,
    consensus_data JSONB,
    micro_blocks TEXT[],
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for blocks
CREATE INDEX IF NOT EXISTS idx_blocks_hash ON blocks(hash);
CREATE INDEX IF NOT EXISTS idx_blocks_timestamp ON blocks(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_blocks_producer ON blocks(producer);
CREATE INDEX IF NOT EXISTS idx_blocks_block_type ON blocks(block_type);

-- Transactions table
CREATE TABLE IF NOT EXISTS transactions (
    hash TEXT PRIMARY KEY,
    from_address TEXT NOT NULL,
    to_address TEXT,
    amount BIGINT NOT NULL,
    nonce NUMERIC(20,0) NOT NULL,
    block BIGINT NOT NULL,
    timestamp BIGINT NOT NULL,
    gas_price NUMERIC(20,0) NOT NULL DEFAULT 0,
    gas_limit BIGINT NOT NULL DEFAULT 0,
    signature TEXT,
    public_key TEXT,
    dilithium_signature TEXT,
    dilithium_public_key TEXT,
    tx_type TEXT NOT NULL,
    tx_type_data JSONB,
    data TEXT,
    status TEXT DEFAULT 'confirmed',
    is_quantum_signed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for fast queries
CREATE INDEX IF NOT EXISTS idx_transactions_block ON transactions(block);
CREATE INDEX IF NOT EXISTS idx_transactions_timestamp ON transactions(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_from ON transactions(from_address);
CREATE INDEX IF NOT EXISTS idx_transactions_to ON transactions(to_address);
CREATE INDEX IF NOT EXISTS idx_transactions_block_timestamp ON transactions(block DESC, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_tx_type ON transactions(tx_type);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
-- Active-node stats: per-epoch windowed scan over a single tx_type (Heartbeat / LightNodeEligibilityBitmap).
CREATE INDEX IF NOT EXISTS idx_transactions_tx_type_block ON transactions(tx_type, block);
-- NOTE (search-suggest scale): the free-text token search issues a leading-wildcard `data ILIKE '%needle%'`
-- (lib/db.ts) that no b-tree serves; it stays bounded by the tx_type='ContractDeploy' btree pre-filter +
-- a min-length(2) guard + LIMIT. A pg_trgm GIN index (`CREATE EXTENSION pg_trgm; CREATE INDEX ... USING gin
-- (data gin_trgm_ops) WHERE tx_type='ContractDeploy'`) makes it index-served at large token counts — but the
-- migration runner splits on ';' and cannot run a DO/EXTENSION block, so this is a manual DBA step, not an
-- auto-migration. Left out of the migration to avoid breaking `npm run db:migrate`.

-- Token transfers table (decoded, effect-sourced index from the node token-transfers endpoint)
-- One row per transfer log (tx_hash + log_index). amount is u64 base units (exact numeric, never float).
CREATE TABLE IF NOT EXISTS token_transfers (
    tx_hash TEXT NOT NULL,
    log_index INTEGER NOT NULL,
    contract TEXT NOT NULL,
    from_address TEXT NOT NULL DEFAULT '',
    to_address TEXT NOT NULL DEFAULT '',
    amount NUMERIC(80,0) NOT NULL DEFAULT 0,
    kind TEXT NOT NULL,
    std TEXT NOT NULL,
    token_id TEXT NOT NULL DEFAULT '',
    block BIGINT NOT NULL,
    timestamp BIGINT NOT NULL,
    PRIMARY KEY (tx_hash, log_index)
);

-- Indexes for token_transfers (address history, per-token history, block ordering). The address/contract
-- indexes carry (block DESC, log_index DESC) so an address/token page is an index-ordered scan bounded
-- near the LIMIT (no full-set fetch + sort) even for a hot exchange address with millions of rows. The
-- leftmost prefix (from_address / to_address / contract) still serves plain equality lookups.
CREATE INDEX IF NOT EXISTS idx_token_transfers_from_block ON token_transfers(from_address, block DESC, log_index DESC);
CREATE INDEX IF NOT EXISTS idx_token_transfers_to_block ON token_transfers(to_address, block DESC, log_index DESC);
CREATE INDEX IF NOT EXISTS idx_token_transfers_contract_block ON token_transfers(contract, block DESC, log_index DESC);
CREATE INDEX IF NOT EXISTS idx_token_transfers_block ON token_transfers(block DESC);

-- Sync state table
CREATE TABLE IF NOT EXISTS sync_state (
    id INTEGER PRIMARY KEY DEFAULT 1,
    last_height BIGINT NOT NULL DEFAULT 0,
    last_sync_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT single_row CHECK (id = 1)
);

-- Insert initial sync state
INSERT INTO sync_state (id, last_height, last_sync_at) 
VALUES (1, 0, CURRENT_TIMESTAMP)
ON CONFLICT (id) DO NOTHING;

-- Note: Users should be created manually with proper passwords
-- Example:
-- CREATE USER explorer_readonly WITH PASSWORD 'your_secure_password';
-- GRANT SELECT ON transactions TO explorer_readonly;
-- GRANT SELECT ON sync_state TO explorer_readonly;
--
-- CREATE USER explorer_sync WITH PASSWORD 'your_secure_password';
-- GRANT SELECT, INSERT, UPDATE ON transactions TO explorer_sync;
-- GRANT SELECT, UPDATE ON sync_state TO explorer_sync;

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger for transactions
CREATE TRIGGER update_transactions_updated_at 
    BEFORE UPDATE ON transactions 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Trigger for sync_state
CREATE TRIGGER update_sync_state_updated_at 
    BEFORE UPDATE ON sync_state 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Trigger for blocks
CREATE TRIGGER update_blocks_updated_at 
    BEFORE UPDATE ON blocks 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

