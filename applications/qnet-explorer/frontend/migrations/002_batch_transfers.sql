-- Inner transfers of BatchTransfers envelopes, one row per recipient.
-- Feeds the recipient's address page; the envelope row stays in transactions.
CREATE TABLE IF NOT EXISTS batch_transfers (
    tx_hash TEXT NOT NULL,
    tx_index INTEGER NOT NULL,
    block BIGINT NOT NULL,
    timestamp BIGINT NOT NULL,
    from_address TEXT NOT NULL,
    to_address TEXT NOT NULL,
    amount BIGINT NOT NULL,
    PRIMARY KEY (tx_hash, tx_index)
);

CREATE INDEX IF NOT EXISTS idx_batch_transfers_to ON batch_transfers(to_address, block DESC);
CREATE INDEX IF NOT EXISTS idx_batch_transfers_block ON batch_transfers(block);
