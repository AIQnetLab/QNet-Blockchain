-- Every payment send and every announce finds its row by the reservation alone (src/server/cabinet/activation-registry.ts
-- SQL.byReservation and SQL.announce), and the table keeps one row per wallet for good: without an index each of them
-- reads the whole table. A reservation id is random and names one row, so the index is unique; rows without one (none
-- today) stay out of it.
SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX IF NOT EXISTS idx_cabinet_activations_reservation ON cabinet_activations (reservation) WHERE reservation IS NOT NULL;
