import type { Pool } from 'pg';
import { log } from './log';

// explorer_stats is maintained incrementally by every commit. A full rebuild runs once (rebuilt_at is
// null) and whenever an operator clears rebuilt_at; it is the only place that scans the tables.
export async function rebuildStatsIfNeeded(pool: Pool): Promise<void> {
  const row = await pool.query<{ rebuilt_at: Date | null }>('SELECT rebuilt_at FROM explorer_stats WHERE id = 1');
  if (row.rows[0]?.rebuilt_at) return;
  const t0 = Date.now();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT 1 FROM sync_state WHERE id = 1 FOR UPDATE');
    const tx = await client.query<{ tx_type: string; c: string; e: string }>(
      `SELECT tx_type, count(*) AS c,
              COALESCE(SUM(CASE WHEN tx_type = 'RewardDistribution' AND from_address = 'system_emission' THEN amount ELSE 0 END), 0)::text AS e
       FROM transactions GROUP BY tx_type`);
    const byType: Record<string, number> = {};
    let total = 0;
    let emission = 0n;
    for (const r of tx.rows) { byType[r.tx_type] = Number(r.c); total += Number(r.c); emission += BigInt(r.e); }
    const blocks = Number((await client.query<{ c: string }>('SELECT count(*) AS c FROM blocks')).rows[0].c);
    const batch = Number((await client.query<{ c: string }>('SELECT count(*) AS c FROM batch_transfers')).rows[0].c);
    const head = (await client.query<{ height: string; hash: string | null; timestamp: string }>(
      'SELECT height::text, hash, timestamp::text FROM blocks ORDER BY height DESC LIMIT 1')).rows[0];
    await client.query(
      `UPDATE explorer_stats SET tx_total = $1, tx_by_type = $2::jsonb, blocks_total = $3, batch_transfers_total = $4,
         emission_total = $5::numeric, head_height = $6, head_hash = $7, head_timestamp = $8, rebuilt_at = now(), updated_at = now()
       WHERE id = 1`,
      [total, JSON.stringify(byType), blocks, batch, emission.toString(), head ? Number(head.height) : -1, head?.hash ?? null, head ? Number(head.timestamp) : 0]);
    await client.query('COMMIT');
    log.info('STATS', 'rebuilt', { tx_total: total, blocks, batch, ms: Date.now() - t0 });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

// Daily audit under one snapshot: the incremental counters against a real count. It should never fire
// (single writer, same transaction) — it is the alarm; a drift schedules a rebuild at the next boot.
export async function auditStats(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const s = await client.query<{ tx_total: string; blocks_total: string; batch_transfers_total: string }>(
      'SELECT tx_total::text, blocks_total::text, batch_transfers_total::text FROM explorer_stats WHERE id = 1');
    const real = await client.query<{ t: string; b: string; r: string }>(
      'SELECT (SELECT count(*) FROM transactions)::text AS t, (SELECT count(*) FROM blocks)::text AS b, (SELECT count(*) FROM batch_transfers)::text AS r');
    await client.query('COMMIT');
    const st = s.rows[0], rl = real.rows[0];
    if (!st || !rl) return;
    if (st.tx_total !== rl.t || st.blocks_total !== rl.b || st.batch_transfers_total !== rl.r) {
      log.err('STATS', 'drift', { tx: `${st.tx_total}/${rl.t}`, blocks: `${st.blocks_total}/${rl.b}`, batch: `${st.batch_transfers_total}/${rl.r}` });
      await pool.query('UPDATE explorer_stats SET rebuilt_at = NULL WHERE id = 1');
    } else {
      log.info('STATS', 'audit_ok', { tx: rl.t, blocks: rl.b, batch: rl.r });
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
