-- The node cabinet's activation registry (src/server/cabinet/activation-registry.ts): one row per QNet wallet, so that
-- a wallet gets one activation burn and one code, for a light or a super node, whichever browser, device or client
-- starts it. A row is a reservation (one outstanding burn per wallet, for ten minutes, made only with the wallet's own
-- signed reservation), a burn on its way, or the verified record of the wallet's burn, which is permanent. The site's web
-- tier writes only this table; no IP address is stored.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS cabinet_activations (
  wallet TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'sending', 'recorded')),
  node_type TEXT NOT NULL CHECK (node_type IN ('light', 'super')),
  way TEXT NOT NULL CHECK (way IN ('extension', 'payment')),
  burner TEXT NOT NULL,
  burn_amount BIGINT NOT NULL CHECK (burn_amount > 0),
  reservation TEXT,
  reserved_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  burn_tx TEXT UNIQUE,
  announced_at TIMESTAMPTZ,
  burn_slot BIGINT,
  burned_at TIMESTAMPTZ,
  recorded_at TIMESTAMPTZ,
  -- reserved: the wallet's signed reservation {pk, sig, time}; extension burn: {pk, sig, solanaSig};
  -- payment burn: {pk, sig, time, ownerSig} (the signed reservation and the payment key's owner bind)
  proof JSONB
);

-- The sweep reads the reservations that end by the clock.
CREATE INDEX IF NOT EXISTS idx_cabinet_activations_expires ON cabinet_activations (expires_at) WHERE state <> 'recorded';

-- The web tier's role, when it connects as a read-only one of this name, writes this table and no other.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'explorer_reader') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON cabinet_activations TO explorer_reader;
  END IF;
END
$$;
