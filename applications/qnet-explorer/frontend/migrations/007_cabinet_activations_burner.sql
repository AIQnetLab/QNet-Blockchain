-- A refund sent through the cabinet earns a read pass only when its payer is a payment address a reservation of this site
-- named (src/server/cabinet/activation-registry.ts SQL.paymentBurner, solana-proxy.ts send). Without an index each such
-- send reads the whole table, which keeps one row per wallet for good. Only payment rows are in it.
SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS idx_cabinet_activations_payment_burner ON cabinet_activations (burner) WHERE way = 'payment';
