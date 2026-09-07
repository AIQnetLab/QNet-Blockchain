import type { BlockRow, TxRow, BatchRow } from './transform';

// Bulk statements over unnest'ed arrays: one statement per table per batch with a fixed parameter
// count, however many rows it carries (the wire protocol caps a statement at 65 535 parameters).
// A stored real identity (hash, previous_hash, merkle_root) is never replaced by an upsert: a reorg
// deletes the row first, so a differing identity here is a defect upstream, not new information. A
// stored body is never demoted by an upsert either: a header-only row landing on a body row keeps the
// body's count, producer and flag (the caller already keeps its transaction rows).

export interface Statement { text: string; values: unknown[] }

function column<T, K extends keyof T>(rows: T[], k: K): T[K][] {
  return rows.map(r => r[k]);
}

export function insertBlocks(rows: BlockRow[]): Statement {
  return {
    text: `INSERT INTO blocks (height, hash, block_type, version, timestamp, previous_hash, merkle_root, producer,
                               tx_count, tx_skipped, total_gas_used, size_bytes, body_indexed)
           SELECT u.height, u.hash, 'MICROBLOCK', 1, u.ts, u.prev, u.merkle, u.producer, u.tx_count, u.skipped, u.gas, u.size, u.body
           FROM unnest($1::bigint[], $2::text[], $3::bigint[], $4::text[], $5::text[], $6::text[], $7::int[], $8::int[], $9::numeric[], $10::bigint[], $11::boolean[])
                AS u(height, hash, ts, prev, merkle, producer, tx_count, skipped, gas, size, body)
           ON CONFLICT (height) DO UPDATE SET
             hash = CASE WHEN blocks.hash ~ '^[0-9a-f]{64}$' THEN blocks.hash ELSE EXCLUDED.hash END,
             timestamp = EXCLUDED.timestamp,
             previous_hash = CASE WHEN blocks.previous_hash ~ '^[0-9a-f]{64}$' THEN blocks.previous_hash ELSE EXCLUDED.previous_hash END,
             merkle_root = CASE WHEN blocks.merkle_root ~ '^[0-9a-f]{64}$' THEN blocks.merkle_root ELSE EXCLUDED.merkle_root END,
             producer = CASE WHEN blocks.body_indexed AND coalesce(blocks.tx_count, 0) > 0 AND NOT EXCLUDED.body_indexed THEN blocks.producer ELSE EXCLUDED.producer END,
             tx_count = CASE WHEN blocks.body_indexed AND coalesce(blocks.tx_count, 0) > 0 AND NOT EXCLUDED.body_indexed THEN blocks.tx_count ELSE EXCLUDED.tx_count END,
             tx_skipped = CASE WHEN blocks.body_indexed AND coalesce(blocks.tx_count, 0) > 0 AND NOT EXCLUDED.body_indexed THEN blocks.tx_skipped ELSE EXCLUDED.tx_skipped END,
             total_gas_used = CASE WHEN blocks.body_indexed AND coalesce(blocks.tx_count, 0) > 0 AND NOT EXCLUDED.body_indexed THEN blocks.total_gas_used ELSE EXCLUDED.total_gas_used END,
             size_bytes = CASE WHEN blocks.body_indexed AND coalesce(blocks.tx_count, 0) > 0 AND NOT EXCLUDED.body_indexed THEN blocks.size_bytes ELSE EXCLUDED.size_bytes END,
             body_indexed = blocks.body_indexed OR EXCLUDED.body_indexed, updated_at = CURRENT_TIMESTAMP
           RETURNING (xmax = 0) AS inserted`,
    values: [
      column(rows, 'height'), column(rows, 'hash'), column(rows, 'timestamp'), column(rows, 'previous_hash'),
      column(rows, 'merkle_root'), column(rows, 'producer'), column(rows, 'tx_count'), column(rows, 'tx_skipped'),
      column(rows, 'total_gas_used'), column(rows, 'size_bytes'), column(rows, 'body_indexed'),
    ],
  };
}

export function insertTransactions(rows: TxRow[]): Statement {
  return {
    text: `INSERT INTO transactions (hash, from_address, to_address, amount, nonce, block, tx_index, timestamp,
                                     gas_price, gas_limit, signature, public_key, dilithium_signature,
                                     dilithium_public_key, tx_type, tx_type_data, data, status, is_quantum_signed)
           SELECT u.hash, u.f, u.t, u.amount, u.nonce, u.block, u.idx, u.ts, u.gp, u.gl, u.sig, u.pk, u.dsig, u.dpk,
                  u.tt, u.ttd::jsonb, u.data, u.status, u.qs
           FROM unnest($1::text[], $2::text[], $3::text[], $4::numeric[], $5::numeric[], $6::bigint[], $7::int[], $8::bigint[],
                       $9::numeric[], $10::numeric[], $11::text[], $12::text[], $13::text[], $14::text[], $15::text[],
                       $16::text[], $17::text[], $18::text[], $19::boolean[])
                AS u(hash, f, t, amount, nonce, block, idx, ts, gp, gl, sig, pk, dsig, dpk, tt, ttd, data, status, qs)
           ON CONFLICT (hash) DO UPDATE SET
             tx_index = EXCLUDED.tx_index, timestamp = EXCLUDED.timestamp,
             status = EXCLUDED.status, updated_at = CURRENT_TIMESTAMP
           WHERE transactions.block = EXCLUDED.block
           RETURNING hash, tx_type, from_address, amount::text AS amount, (xmax = 0) AS inserted`,
    values: [
      column(rows, 'hash'), column(rows, 'from_address'), column(rows, 'to_address'), column(rows, 'amount'),
      column(rows, 'nonce'), column(rows, 'block'), column(rows, 'tx_index'), column(rows, 'timestamp'),
      column(rows, 'gas_price'), column(rows, 'gas_limit'), column(rows, 'signature'), column(rows, 'public_key'),
      column(rows, 'dilithium_signature'), column(rows, 'dilithium_public_key'), column(rows, 'tx_type'),
      rows.map(r => (r.tx_type_data ? JSON.stringify(r.tx_type_data) : null)),
      column(rows, 'data'), column(rows, 'status'), column(rows, 'is_quantum_signed'),
    ],
  };
}

export function insertBatchTransfers(rows: BatchRow[]): Statement {
  return {
    text: `INSERT INTO batch_transfers (tx_hash, tx_index, block, timestamp, from_address, to_address, amount)
           SELECT * FROM unnest($1::text[], $2::int[], $3::bigint[], $4::bigint[], $5::text[], $6::text[], $7::numeric[])
           ON CONFLICT (tx_hash, tx_index) DO NOTHING
           RETURNING 1 AS inserted`,
    values: [
      column(rows, 'tx_hash'), column(rows, 'tx_index'), column(rows, 'block'), column(rows, 'timestamp'),
      column(rows, 'from_address'), column(rows, 'to_address'), column(rows, 'amount'),
    ],
  };
}

// Aggregates a batch of rows contributes to explorer_stats; the same shape is subtracted on a rollback.
export interface StatsDelta {
  tx_total: number;
  blocks_total: number;
  batch_transfers_total: number;
  emission_total: bigint;
  tx_by_type: Record<string, number>;
}

export function emptyDelta(): StatsDelta {
  return { tx_total: 0, blocks_total: 0, batch_transfers_total: 0, emission_total: 0n, tx_by_type: {} };
}

export type InsertedTx = { hash: string; tx_type: string; from_address: string; amount: string; inserted: boolean };

// What a commit actually added: rows the INSERTs reported as new (a conflict-updated row was already counted).
export function deltaOf(blocksInserted: number, txs: InsertedTx[], batchInserted: number): StatsDelta {
  const d = emptyDelta();
  d.blocks_total = blocksInserted;
  d.batch_transfers_total = batchInserted;
  for (const t of txs) {
    if (!t.inserted) continue;
    d.tx_total += 1;
    d.tx_by_type[t.tx_type] = (d.tx_by_type[t.tx_type] || 0) + 1;
    if (t.tx_type === 'RewardDistribution' && t.from_address === 'system_emission') d.emission_total += BigInt(t.amount);
  }
  return d;
}

export function mergeDelta(a: StatsDelta, b: StatsDelta): StatsDelta {
  const by = { ...a.tx_by_type };
  for (const [k, v] of Object.entries(b.tx_by_type)) by[k] = (by[k] || 0) + v;
  return {
    tx_total: a.tx_total + b.tx_total, blocks_total: a.blocks_total + b.blocks_total,
    batch_transfers_total: a.batch_transfers_total + b.batch_transfers_total,
    emission_total: a.emission_total + b.emission_total, tx_by_type: by,
  };
}

export function negate(d: StatsDelta): StatsDelta {
  const by: Record<string, number> = {};
  for (const [k, v] of Object.entries(d.tx_by_type)) by[k] = -v;
  return { tx_total: -d.tx_total, blocks_total: -d.blocks_total, batch_transfers_total: -d.batch_transfers_total, emission_total: -d.emission_total, tx_by_type: by };
}

// Merges the per-type map inside the row: keys whose count reaches zero are dropped.
export function applyStatsDelta(d: StatsDelta, head: { height: number; hash: string | null; timestamp: number } | null): Statement {
  return {
    text: `UPDATE explorer_stats SET
             tx_total = tx_total + $1,
             blocks_total = blocks_total + $2,
             batch_transfers_total = batch_transfers_total + $3,
             emission_total = emission_total + $4::numeric,
             tx_by_type = COALESCE((
               SELECT jsonb_object_agg(k, v) FROM (
                 SELECT k, SUM(v) AS v FROM (
                   SELECT key AS k, value::bigint AS v FROM jsonb_each_text(tx_by_type)
                   UNION ALL
                   SELECT key, value::bigint FROM jsonb_each_text($5::jsonb)
                 ) s GROUP BY k HAVING SUM(v) <> 0
               ) m), '{}'::jsonb),
             head_height = COALESCE($6, head_height),
             head_hash = CASE WHEN $6::bigint IS NULL THEN head_hash ELSE $7 END,
             head_timestamp = COALESCE($8, head_timestamp),
             updated_at = now()
           WHERE id = 1`,
    values: [
      d.tx_total, d.blocks_total, d.batch_transfers_total, d.emission_total.toString(), JSON.stringify(d.tx_by_type),
      head ? head.height : null, head ? head.hash : null, head ? head.timestamp : null,
    ],
  };
}
