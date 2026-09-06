import type { Pool } from 'pg';
import type { NodeClient } from './node-client';
import { log, errText } from './log';

// Effect-sourced QRC token transfers from the node's token-transfers index, replaced per height range in
// one transaction (a re-ingested range drops transfers a reorg removed). Fetching and writing are split
// so the write can sit under the follower's write lock and reorg-epoch check.

const RANGE_CAP = 10_000;   // node caps the height span per request
const ROW_LIMIT = 5_000;    // node's per-page hard stop
const MAX_ROWS = 250_000;   // rows buffered per window; a fuller window is split until it fits

interface NodeTransfer {
  contract?: string; from?: string; to?: string; amount?: string | number; kind?: string; std?: string;
  token_id?: string; tx_hash?: string; log_index?: number; height?: number; timestamp?: number;
}

// Pages of one window; 'overflow' when it exceeds MAX_ROWS (the caller halves the window), null on a
// fetch failure. A single height can hold at most one block of transfers, so halving always ends.
async function fetchWindow(node: NodeClient, start: number, end: number, pin?: string): Promise<NodeTransfer[] | 'overflow' | null> {
  const rows: NodeTransfer[] = [];
  let after: string | null = null;
  for (;;) {
    let body;
    try {
      body = await node.getTokenTransfersPage(start, end, ROW_LIMIT, after, pin);
    } catch (e) {
      log.warn('TOKENS', 'fetch_failed', { start, end, err: errText(e) });
      return null;
    }
    rows.push(...(body.transfers as NodeTransfer[]));
    if (rows.length > MAX_ROWS) return start === end ? rows : 'overflow';
    if (!body.truncated || !body.next_cursor) break;
    after = body.next_cursor;
  }
  return rows;
}

export interface TransferWindow { start: number; end: number; rows: NodeTransfer[] }

// Network half: the transfers for [fromHeight, toHeight] in node-sized windows. A window whose fetch
// failed is left out, so the stored rows for it stay as they were.
export async function fetchTokenTransfers(node: NodeClient, fromHeight: number, toHeight: number, pin?: string): Promise<TransferWindow[]> {
  const out: TransferWindow[] = [];
  if (!Number.isInteger(fromHeight) || !Number.isInteger(toHeight) || fromHeight < 0 || toHeight < fromHeight) return out;
  let total = 0;
  const pending: Array<[number, number]> = [];
  for (let start = fromHeight; start <= toHeight; start += RANGE_CAP) pending.push([start, Math.min(start + RANGE_CAP - 1, toHeight)]);
  while (pending.length > 0) {
    const [start, end] = pending.shift()!;
    const list = await fetchWindow(node, start, end, pin);
    if (list === null) continue;
    if (list === 'overflow') { const mid = Math.floor((start + end) / 2); pending.unshift([start, mid], [mid + 1, end]); continue; }
    // A row is stored under the height the node reports, so a row outside the window the DELETE covers
    // would never be replaced again: it does not enter the archive.
    const rows = list.filter(t => typeof t.tx_hash === 'string' && t.tx_hash && Number.isInteger(t.log_index)
      && typeof t.contract === 'string' && t.contract && Number.isInteger(t.height) && (t.height as number) >= start && (t.height as number) <= end);
    total += rows.length;
    out.push({ start, end, rows });
    if (total > MAX_ROWS) {
      log.warn('TOKENS', 'row_budget_exhausted', { from: fromHeight, to: toHeight, total, pending: pending.length });
      break;
    }
  }
  return out;
}

// Database half: replace each window in its own transaction. Runs under the follower's write lock.
export async function replaceTokenTransfers(pool: Pool, windows: TransferWindow[]): Promise<void> {
  const amount = (t: NodeTransfer): string => {
    const s = typeof t.amount === 'string' ? t.amount.trim() : (typeof t.amount === 'number' && Number.isFinite(t.amount) ? Math.trunc(t.amount).toString() : '0');
    return /^\d+$/.test(s) ? s : '0';
  };
  for (const { start, end, rows: ok } of windows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM token_transfers WHERE block >= $1 AND block <= $2', [start, end]);
      if (ok.length > 0) {
        await client.query(
          `INSERT INTO token_transfers (tx_hash, log_index, contract, from_address, to_address, amount, kind, std, token_id, block, timestamp)
           SELECT * FROM unnest($1::text[], $2::int[], $3::text[], $4::text[], $5::text[], $6::numeric[], $7::text[], $8::text[], $9::text[], $10::bigint[], $11::bigint[])
           ON CONFLICT (tx_hash, log_index) DO NOTHING`,
          [
            ok.map(t => t.tx_hash), ok.map(t => t.log_index), ok.map(t => t.contract),
            ok.map(t => (typeof t.from === 'string' ? t.from : '')), ok.map(t => (typeof t.to === 'string' ? t.to : '')),
            ok.map(amount), ok.map(t => (typeof t.kind === 'string' ? t.kind : '')), ok.map(t => (typeof t.std === 'string' ? t.std : '')),
            ok.map(t => (typeof t.token_id === 'string' ? t.token_id : '')),
            ok.map(t => t.height as number), ok.map(t => (Number.isInteger(t.timestamp) ? t.timestamp : 0)),
          ]);
      }
      await client.query('COMMIT');
      if (ok.length > 0) log.info('TOKENS', 'replaced', { start, end, rows: ok.length });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      log.warn('TOKENS', 'replace_failed', { start, end, err: errText(e) });
    } finally {
      client.release();
    }
  }
}
