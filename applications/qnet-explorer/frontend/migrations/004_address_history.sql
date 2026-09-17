-- Address history pages by keyset (block, tx_index) per side of a transaction, index-ordered: a wallet
-- with thousands of rows reads one page, not the whole set plus a sort. The composite indexes serve the
-- plain address lookups too (leftmost column), so they replace the single-column ones.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';

CREATE INDEX IF NOT EXISTS idx_transactions_from_block_txindex ON transactions (from_address, block DESC, tx_index DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_to_block_txindex ON transactions (to_address, block DESC, tx_index DESC);
DROP INDEX IF EXISTS idx_transactions_from;
DROP INDEX IF EXISTS idx_transactions_to;
