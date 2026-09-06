import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { insertBlocks, insertTransactions, insertBatchTransfers, deltaOf, negate, mergeDelta, applyStatsDelta, emptyDelta, type StatsDelta, type InsertedTx } from './sql';
import type { ShapedBlock, BlockRow, TxRow } from './transform';
import { log } from './log';

// The only writer. One transaction per commit, opened by locking the sync_state row (a database-level
// mutex that also covers a second process): rows, stats delta, cursors, NOTIFY. The stats move by what
// the INSERTs report as new minus what the DELETEs report as removed, so they stay exact.

export const HEAD_CHANNEL = 'explorer_head';
const MAX_ROWS_PER_STATEMENT = 20_000;

export interface CommitInput {
  full: ShapedBlock[];        // blocks with bodies: their tx and recipient rows replace the stored ones
  headersOnly: BlockRow[];    // rows without bodies (pruned on the network) or empty blocks from headers
}

export interface CommitResult { blocks: number; txs: number; batch: number; maxHeight: number; head: number; changed: number }

async function run<R extends QueryResultRow, T>(client: PoolClient, rows: T[], build: (part: T[]) => { text: string; values: unknown[] }): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < rows.length; i += MAX_ROWS_PER_STATEMENT) {
    const st = build(rows.slice(i, i + MAX_ROWS_PER_STATEMENT));
    const res = await client.query<R>(st.text, st.values);
    out.push(...res.rows);
  }
  return out;
}

async function lockHead(client: PoolClient): Promise<number> {
  const cur = await client.query<{ last_height: string }>('SELECT last_height FROM sync_state WHERE id = 1 FOR UPDATE');
  return Number(cur.rows[0]?.last_height ?? -1);
}

// Delete tx and recipient rows by predicate; the delta is exactly what the DELETEs returned.
async function deleteRows(client: PoolClient, where: string, params: unknown[]): Promise<StatsDelta> {
  const d = emptyDelta();
  const batch = await client.query<{ n: string }>(`WITH d AS (DELETE FROM batch_transfers WHERE ${where} RETURNING 1) SELECT count(*)::text AS n FROM d`, params);
  d.batch_transfers_total = Number(batch.rows[0]?.n || 0);
  const txs = await client.query<{ tx_type: string; c: string; e: string }>(
    `WITH d AS (DELETE FROM transactions WHERE ${where} RETURNING tx_type, from_address, amount)
     SELECT tx_type, count(*)::text AS c,
            COALESCE(SUM(CASE WHEN tx_type = 'RewardDistribution' AND from_address = 'system_emission' THEN amount ELSE 0 END), 0)::text AS e
     FROM d GROUP BY tx_type`, params);
  for (const r of txs.rows) {
    const c = Number(r.c);
    d.tx_by_type[r.tx_type] = c;
    d.tx_total += c;
    d.emission_total += BigInt(r.e);
  }
  return d;
}

// One row per tx hash across the batch: a hash that recurs keeps its lowest height; the later block
// counts it as skipped so the heal pass does not chase it.
function dedupAcrossBatch(full: ShapedBlock[]): { txs: TxRow[]; skippedByHeight: Map<number, number> } {
  const seen = new Set<string>();
  const out: TxRow[] = [];
  const skippedByHeight = new Map<number, number>();
  for (const f of [...full].sort((a, b) => a.block.height - b.block.height)) {
    for (const t of f.txs) {
      if (seen.has(t.hash)) { skippedByHeight.set(f.block.height, (skippedByHeight.get(f.block.height) || 0) + 1); continue; }
      seen.add(t.hash);
      out.push(t);
    }
  }
  return { txs: out, skippedByHeight };
}

export class Writer {
  constructor(private readonly pool: Pool) {}

  // Commit a set of blocks. `full` heights and empty blocks confirmed by header have their stored tx and
  // recipient rows replaced; block rows upsert. sync_state.last_height only rises here.
  async commit(input: CommitInput): Promise<CommitResult> {
    const blockRows: BlockRow[] = [...input.headersOnly, ...input.full.map(f => f.block)];
    if (blockRows.length === 0) return { blocks: 0, txs: 0, batch: 0, maxHeight: -1, head: -1, changed: 0 };
    const { txs, skippedByHeight } = dedupAcrossBatch(input.full);
    for (const b of blockRows) { const k = skippedByHeight.get(b.height); if (k) b.tx_skipped += k; }
    const kept = new Set(txs.map(t => t.hash));
    const batch = input.full.flatMap(f => f.batch).filter(b => kept.has(b.tx_hash));
    const client = await this.pool.connect();
    const t0 = Date.now();
    try {
      await client.query('BEGIN');
      const prevHead = await lockHead(client);
      // Rows whose transaction set this commit supplies in full. An empty-block header qualifies only
      // when the archive does not already hold a body there: one endpoint calling a stored block empty
      // must never delete its transactions (the network may have pruned them long ago).
      const emptyClaims = input.headersOnly.filter(r => r.body_indexed && r.tx_count === 0).map(r => r.height);
      const heldBodies = emptyClaims.length === 0 ? new Set<number>() : new Set(
        (await client.query<{ height: string }>(
          'SELECT height::text FROM blocks WHERE height = ANY($1::bigint[]) AND body_indexed AND coalesce(tx_count, 0) > 0', [emptyClaims])
        ).rows.map(r => Number(r.height)));
      if (heldBodies.size > 0) log.warn('INDEXER', 'empty_claim_over_stored_body', { heights: heldBodies.size, first: Math.min(...heldBodies) });
      const replaced = [
        ...input.full.map(f => f.block.height),
        ...emptyClaims.filter(h => !heldBodies.has(h)),
      ];
      const removed = replaced.length > 0 ? await deleteRows(client, 'block = ANY($1::bigint[])', [replaced]) : emptyDelta();
      const blocksIns = await run<{ inserted: boolean }, BlockRow>(client, blockRows, insertBlocks);
      const txIns = txs.length > 0 ? await run<InsertedTx, TxRow>(client, txs, insertTransactions) : [];
      const batchIns = batch.length > 0 ? await run<{ inserted: number }, typeof batch[number]>(client, batch, insertBatchTransfers) : [];
      // A hash already stored under ANOTHER block is left where it is (the INSERT returned no row for
      // it); this block counts it as skipped so its row set is complete by construction.
      const returned = new Set(txIns.map(r => r.hash));
      const crossDup = new Map<number, number>();
      for (const t of txs) if (!returned.has(t.hash)) crossDup.set(t.block, (crossDup.get(t.block) || 0) + 1);
      for (const [h, k] of crossDup) await client.query('UPDATE blocks SET tx_skipped = tx_skipped + $2 WHERE height = $1', [h, k]);
      if (crossDup.size > 0) log.warn('INDEXER', 'tx_hash_held_by_other_block', { blocks: crossDup.size, txs: [...crossDup.values()].reduce((a, b) => a + b, 0) });
      const delta = mergeDelta(deltaOf(blocksIns.filter(r => r.inserted).length, txIns, batchIns.length), negate(removed));

      const maxHeight = Math.max(...blockRows.map(b => b.height));
      const headRow = blockRows.find(b => b.height === maxHeight)!;
      const newHead = Math.max(prevHead, maxHeight);
      const head = newHead === maxHeight ? { height: maxHeight, hash: headRow.hash, timestamp: headRow.timestamp } : null;
      const st = applyStatsDelta(delta, head);
      await client.query(st.text, st.values);
      await client.query('UPDATE sync_state SET last_height = $1, last_sync_at = CURRENT_TIMESTAMP WHERE id = 1', [newHead]);
      if (head) await client.query('SELECT pg_notify($1, $2)', [HEAD_CHANNEL, JSON.stringify(head)]);
      await client.query('COMMIT');
      const changed = blocksIns.filter(r => r.inserted).length + txIns.filter(r => r.inserted).length + batchIns.length + removed.tx_total;
      log.info('INDEXER', 'committed', { blocks: blockRows.length, txs: txs.length, batch: batch.length, head: newHead, ms: Date.now() - t0 });
      return { blocks: blockRows.length, txs: txs.length, batch: batch.length, maxHeight, head: newHead, changed };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  // Remove everything strictly above `height`; both cursors and the stats move back with it. Returns
  // the head the table holds afterwards.
  async rollbackAbove(height: number, why: string): Promise<number> {
    return this.remove('block > $1', 'height > $1', [height], height, true, why);
  }

  // Remove exactly the heights [lo, hi] (rows a quarantined endpoint supplied); the prefix drops below
  // the range, gaps above the tip are kept. Returns the head the table holds afterwards.
  async deleteRange(lo: number, hi: number, why: string): Promise<number> {
    return this.remove('block >= $1 AND block <= $2', 'height >= $1 AND height <= $2', [lo, hi], lo - 1, false, why);
  }

  private async remove(txWhere: string, blockWhere: string, params: unknown[], newTop: number, tipRollback: boolean, why: string): Promise<number> {
    const client = await this.pool.connect();
    const t0 = Date.now();
    try {
      await client.query('BEGIN');
      const prevHead = await lockHead(client);
      await client.query(`DELETE FROM token_transfers WHERE ${txWhere}`, params);
      const removed = await deleteRows(client, txWhere, params);
      const blocks = await client.query<{ n: string }>(`WITH d AS (DELETE FROM blocks WHERE ${blockWhere} RETURNING 1) SELECT count(*)::text AS n FROM d`, params);
      removed.blocks_total = Number(blocks.rows[0]?.n || 0);
      const top = (await client.query<{ height: string; hash: string | null; timestamp: string }>(
        'SELECT height::text, hash, timestamp::text FROM blocks ORDER BY height DESC LIMIT 1')).rows[0];
      const headHeight = top ? Number(top.height) : -1;
      const head = { height: headHeight, hash: top?.hash ?? null, timestamp: top ? Number(top.timestamp) : 0 };
      const st = applyStatsDelta(negate(removed), head);
      await client.query(st.text, st.values);
      if (tipRollback) {
        await client.query('DELETE FROM sync_gaps WHERE start_h > $1', [headHeight]);
        await client.query('UPDATE sync_gaps SET end_h = $1 WHERE end_h > $1', [headHeight]);
      }
      await client.query(
        'UPDATE sync_state SET last_height = $1, indexed_prefix = LEAST(indexed_prefix, $2), last_sync_at = CURRENT_TIMESTAMP WHERE id = 1',
        [headHeight, newTop]);
      if (headHeight !== prevHead) await client.query('SELECT pg_notify($1, $2)', [HEAD_CHANNEL, JSON.stringify({ ...head, rollback: true })]);
      await client.query('COMMIT');
      log.warn('INDEXER', 'rows_removed', { where: blockWhere.replace(/\$\d/g, m => String(params[Number(m.slice(1)) - 1])), blocks: removed.blocks_total, txs: removed.tx_total, head: headHeight, why, ms: Date.now() - t0 });
      return headHeight;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  // Fresh genesis: the archive restarts from nothing.
  async resetAll(why: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockHead(client);
      await client.query('TRUNCATE token_transfers, batch_transfers, transactions, blocks, sync_gaps');
      await client.query(`UPDATE explorer_stats SET tx_total = 0, tx_by_type = '{}'::jsonb, blocks_total = 0, batch_transfers_total = 0,
                          emission_total = 0, head_height = -1, head_hash = NULL, head_timestamp = 0, updated_at = now() WHERE id = 1`);
      await client.query('UPDATE sync_state SET last_height = -1, indexed_prefix = -1, genesis_hash = NULL, last_sync_at = CURRENT_TIMESTAMP WHERE id = 1');
      await client.query('SELECT pg_notify($1, $2)', [HEAD_CHANNEL, JSON.stringify({ height: -1, hash: null, timestamp: 0, reset: true })]);
      await client.query('COMMIT');
      log.err('INDEXER', 'archive_reset', { why });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  // The head is what the tables hold: re-derive cursors and the stats head from the highest block row.
  async syncHeadFromTable(): Promise<{ head: number; prefix: number }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockHead(client);
      const top = (await client.query<{ height: string; hash: string | null; timestamp: string }>(
        'SELECT height::text, hash, timestamp::text FROM blocks ORDER BY height DESC LIMIT 1')).rows[0];
      const head = top ? Number(top.height) : -1;
      await client.query('UPDATE sync_state SET last_height = $1, indexed_prefix = LEAST(indexed_prefix, $1) WHERE id = 1', [head]);
      await client.query('UPDATE explorer_stats SET head_height = $1, head_hash = $2, head_timestamp = $3, updated_at = now() WHERE id = 1',
        [head, top?.hash ?? null, top ? Number(top.timestamp) : 0]);
      const st = await client.query<{ indexed_prefix: string }>('SELECT indexed_prefix::text FROM sync_state WHERE id = 1');
      await client.query('COMMIT');
      return { head, prefix: Number(st.rows[0]?.indexed_prefix ?? -1) };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async setIndexedPrefix(prefix: number): Promise<void> {
    await this.pool.query('UPDATE sync_state SET indexed_prefix = $1 WHERE id = 1', [prefix]);
  }

  async setGenesisHash(hash: string): Promise<void> {
    await this.pool.query('UPDATE sync_state SET genesis_hash = $1 WHERE id = 1 AND genesis_hash IS DISTINCT FROM $1', [hash]);
  }

  async setNodeState(nodeHeight: number, wsConnected: boolean, endpoint: string | null, healPending: number): Promise<void> {
    await this.pool.query(
      'UPDATE sync_state SET node_height = $1, ws_connected = $2, node_endpoint = $3, heal_pending = $4 WHERE id = 1',
      [nodeHeight, wsConnected, endpoint, healPending]);
  }
}
