import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
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

const TEXT_MAX = 128;
const AMOUNT_MAX = 10n ** 80n - 1n;   // token_transfers.amount is NUMERIC(80,0)

// One row as the archive will store it: every text bounded and NUL-free, every number inside its
// column, so nothing a node sends can make the window's INSERT fail.
function bounded(t: NodeTransfer, start: number, end: number): NodeTransfer | null {
  const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\u0000/g, '').slice(0, max) : '');
  const tx_hash = text(t.tx_hash, 64);
  if (!/^[0-9a-f]{64}$/.test(tx_hash)) return null;
  if (!Number.isInteger(t.log_index) || (t.log_index as number) < 0 || (t.log_index as number) > 2_147_483_647) return null;
  if (!Number.isInteger(t.height) || (t.height as number) < start || (t.height as number) > end) return null;
  const contract = text(t.contract, TEXT_MAX);
  if (!contract) return null;
  const raw = typeof t.amount === 'string' ? t.amount.trim() : (typeof t.amount === 'number' && Number.isFinite(t.amount) ? Math.trunc(t.amount).toString() : '0');
  let amount = /^\d+$/.test(raw) ? BigInt(raw) : 0n;
  if (amount > AMOUNT_MAX) amount = AMOUNT_MAX;
  return {
    tx_hash, log_index: t.log_index, contract, height: t.height,
    from: text(t.from, TEXT_MAX), to: text(t.to, TEXT_MAX), amount: amount.toString(),
    kind: text(t.kind, 32), std: text(t.std, 32), token_id: text(t.token_id, TEXT_MAX),
    timestamp: Number.isSafeInteger(t.timestamp) && (t.timestamp as number) >= 0 ? t.timestamp : 0,
  };
}

function windowDigest(rows: NodeTransfer[]): string {
  const h = createHash('sha3-256');
  for (const r of [...rows].sort((a, b) => (a.tx_hash! < b.tx_hash! ? -1 : a.tx_hash! > b.tx_hash! ? 1 : (a.log_index! - b.log_index!)))) {
    h.update(JSON.stringify([r.tx_hash, r.log_index, r.contract, r.from, r.to, r.amount, r.kind, r.std, r.token_id, r.height, r.timestamp]));
  }
  return h.digest('hex');
}

// Network half, one endpoint: the transfers for [fromHeight, toHeight] in node-sized windows. A
// window whose fetch failed is left out.
export async function fetchTokenTransfers(node: NodeClient, fromHeight: number, toHeight: number, pin?: string): Promise<TransferWindow[]> {
  if (!pin) return [];
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
    // would never be replaced again: it does not enter the archive. Every field is bounded here.
    const rows = list.map(t => bounded(t, start, end)).filter((t): t is NodeTransfer => t !== null);
    total += rows.length;
    out.push({ start, end, rows });
    if (total > MAX_ROWS) {
      log.warn('TOKENS', 'row_budget_exhausted', { from: fromHeight, to: toHeight, total, pending: pending.length });
      break;
    }
  }
  return out;
}

// The transfers for a range as `need` of the given endpoints agree on them, window by window. A window
// on which fewer than `need` agree is left out — its stored rows stay as they were — because the
// transfer index is not bound by any block hash and one endpoint's word cannot delete it.
export async function fetchTokenTransfersAgreed(node: NodeClient, fromHeight: number, toHeight: number, sources: string[], need: number): Promise<TransferWindow[]> {
  const perSource = await Promise.all(sources.map(s => fetchTokenTransfers(node, fromHeight, toHeight, s).catch(() => [] as TransferWindow[])));
  const votes = new Map<string, { w: TransferWindow; n: number }>();
  for (const windows of perSource) {
    for (const w of windows) {
      const k = `${w.start}:${w.end}:${windowDigest(w.rows)}`;
      const e = votes.get(k) ?? { w, n: 0 };
      e.n += 1; votes.set(k, e);
    }
  }
  const out: TransferWindow[] = [];
  const decided = new Set<string>();
  for (const { w, n } of votes.values()) {
    const span = `${w.start}:${w.end}`;
    if (n >= need && !decided.has(span)) { decided.add(span); out.push(w); }
  }
  const undecided = new Set([...votes.values()].map(v => `${v.w.start}:${v.w.end}`).filter(s => !decided.has(s)));
  if (undecided.size > 0) log.warn('TOKENS', 'window_unagreed', { from: fromHeight, to: toHeight, windows: undecided.size, sources: sources.length, need });
  return out;
}

// Database half: replace each window in its own transaction. Runs under the follower's write lock.
export async function replaceTokenTransfers(pool: Pool, windows: TransferWindow[]): Promise<void> {
  const amount = (t: NodeTransfer): string => (typeof t.amount === 'string' ? t.amount : '0');
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
