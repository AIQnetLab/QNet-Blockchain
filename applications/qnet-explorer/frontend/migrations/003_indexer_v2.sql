-- Indexer v2: keyset ordering key, block identity/body flags, incremental stats, two sync cursors.
-- Applied as ONE transaction by the indexer's migration runner (src/indexer/migrate.ts).
--
-- Every ALTER here takes ACCESS EXCLUSIVE and holds it to COMMIT, so the read tier queues behind it.
-- The timeouts make that a bounded, retryable failure instead of an open-ended freeze: a migration
-- that cannot take its locks in 5 s gives up and the indexer reports it, rather than blocking the
-- explorer while every later query piles up behind the lock.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';

-- Position of a transaction inside its block: with (block) the total order the list pages over.
-- The type changes ride the same rewrite as the new column, so the table is rewritten once, and the
-- per-row updated_at trigger is off for the backfill (it would fire once per row and double the work).
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS tx_index INTEGER,
  ALTER COLUMN amount TYPE NUMERIC(20,0),
  ALTER COLUMN gas_limit TYPE NUMERIC(20,0);
ALTER TABLE transactions DISABLE TRIGGER USER;
UPDATE transactions t SET tx_index = r.rn - 1
  FROM (SELECT hash, row_number() OVER (PARTITION BY block ORDER BY timestamp, tx_type, hash) AS rn
        FROM transactions WHERE tx_index IS NULL) r
 WHERE t.hash = r.hash;
ALTER TABLE transactions ENABLE TRIGGER USER;
ALTER TABLE transactions ALTER COLUMN tx_index SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_block_txindex ON transactions (block DESC, tx_index DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_type_block_txindex ON transactions (tx_type, block DESC, tx_index DESC);
DROP INDEX IF EXISTS idx_transactions_block_timestamp;
DROP INDEX IF EXISTS idx_transactions_timestamp;
DROP INDEX IF EXISTS idx_transactions_status;
DROP INDEX IF EXISTS idx_transactions_tx_type;
DROP INDEX IF EXISTS idx_transactions_tx_type_block;

-- A block row whose body the network had already pruned carries only its hash and slot time.
-- One statement, one rewrite. body_indexed defaults TRUE because every row that exists today was
-- written from a body; a row whose transactions the heal cannot account for is corrected there.
ALTER TABLE blocks
  ALTER COLUMN tx_count DROP NOT NULL,
  ALTER COLUMN hash DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS body_indexed BOOLEAN NOT NULL DEFAULT TRUE,
  -- Transactions the indexer deliberately leaves out of a block (genesis prefund, benchmark accounts).
  ADD COLUMN IF NOT EXISTS tx_skipped INTEGER NOT NULL DEFAULT 0,
  ALTER COLUMN total_gas_used TYPE NUMERIC(30,0);
CREATE INDEX IF NOT EXISTS idx_blocks_body_pending ON blocks (height) WHERE body_indexed = FALSE;
CREATE INDEX IF NOT EXISTS idx_blocks_identity_pending ON blocks (height) WHERE hash IS NULL OR hash !~ '^[0-9a-f]{64}$';

ALTER TABLE batch_transfers ALTER COLUMN amount TYPE NUMERIC(20,0);

-- Counters the headers read in O(1); maintained in the same transaction as every block commit.
CREATE TABLE IF NOT EXISTS explorer_stats (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    tx_total BIGINT NOT NULL DEFAULT 0,
    tx_by_type JSONB NOT NULL DEFAULT '{}'::jsonb,
    blocks_total BIGINT NOT NULL DEFAULT 0,
    batch_transfers_total BIGINT NOT NULL DEFAULT 0,
    emission_total NUMERIC(30,0) NOT NULL DEFAULT 0,
    head_height BIGINT NOT NULL DEFAULT -1,
    head_hash TEXT,
    head_timestamp BIGINT NOT NULL DEFAULT 0,
    rebuilt_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO explorer_stats (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- last_height = highest indexed block (the head); indexed_prefix = every height ≤ it is stored.
ALTER TABLE sync_state ADD COLUMN IF NOT EXISTS indexed_prefix BIGINT NOT NULL DEFAULT -1;
ALTER TABLE sync_state ADD COLUMN IF NOT EXISTS node_height BIGINT NOT NULL DEFAULT 0;
ALTER TABLE sync_state ADD COLUMN IF NOT EXISTS ws_connected BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE sync_state ADD COLUMN IF NOT EXISTS node_endpoint TEXT;
ALTER TABLE sync_state ADD COLUMN IF NOT EXISTS heal_pending BIGINT NOT NULL DEFAULT 0;
-- Hash of block 1: the chain identity this archive belongs to (fresh-genesis detection).
ALTER TABLE sync_state ADD COLUMN IF NOT EXISTS genesis_hash TEXT;

CREATE TABLE IF NOT EXISTS sync_gaps (
    start_h BIGINT PRIMARY KEY,
    end_h BIGINT NOT NULL,
    tries INT NOT NULL DEFAULT 0,
    next_retry_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
