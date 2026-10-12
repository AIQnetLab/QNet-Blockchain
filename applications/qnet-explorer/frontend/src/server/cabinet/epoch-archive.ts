// What the explorer's archive of the chain adds to a page of a node's epochs (src/server/cabinet/node-proxy.ts history):
// where the wallet's epochs start, its first node's registration (the epochs are the wallet's, so a light and a super
// node of one wallet share them), and its super node's (NodeRegistration rows, sent from the wallet for a light and a
// super node alike; a row from before the indexer kept its fields, src/indexer/transform.ts, by its memo
// `client_node_reg:<node id>:<wallet>:`, a genesis node's `node_registration:<node id>:<wallet>`), the wallet's moves of
// the node balance that can hold the page's epochs (RewardDistribution rows from system_rewards_pool to the wallet from
// the end of the page's oldest epoch on, whose payload lists the epochs and amounts each moved) and the times of the
// blocks the page's epochs began and ended with. Three indexed reads per page, the registrations kept once found; every
// row is public on the chain. The nodes' own per-epoch history stays the source of what was counted. Also a super
// node's newest heartbeat, when it was last seen.

import { epochOfKey } from '../../lib/cabinet/epochs.ts';
import { isSuperNodeId, lightNodeId, superNodeId } from '../../lib/qnet-link.ts';
import { memo } from './cache.ts';

// A wallet's registrations, oldest first: its first node's, then its other node's, and a few sent again.
export const REGISTRATION_ROWS = 4;
// A wallet's registrations once found are kept a day when they include its super node's (nothing sent later changes
// them), a few minutes while they do not (the wallet may still register one).
export const REGISTRATION_CACHE_MS = 86_400_000;
export const REGISTRATION_RECHECK_MS = 300_000;
// Each move takes every settled epoch not moved before it, so the first move after the page's oldest epoch ended holds
// it (or, before that epoch settled, older ones), and at most one more per epoch of the page follows.
export const CLAIM_ROWS = 32;

// Ordered by the column, not the text it is read as (a bare `block` in ORDER BY names the output column).
export const REGISTRATION_SQL = `SELECT block::text AS block, tx_type_data AS data, left(data, 200) AS memo FROM transactions
 WHERE from_address = $1 AND tx_type = 'NodeRegistration' ORDER BY transactions.block ASC, tx_index ASC LIMIT ${REGISTRATION_ROWS}`;
export const CLAIMS_SQL = `SELECT hash, block::text AS block, data FROM transactions
 WHERE to_address = $1 AND tx_type = 'RewardDistribution' AND from_address = 'system_rewards_pool' AND transactions.block >= $2
 ORDER BY transactions.block ASC, tx_index ASC LIMIT ${CLAIM_ROWS}`;
export const TIMES_SQL = 'SELECT height::text AS height, timestamp::text AS ts FROM blocks WHERE height = ANY($1::bigint[])';
// A super node's newest heartbeat, sent from the node's id, with its block's time: when the node was last seen by the
// chain. None while the archive is behind (it wrote nothing for 120 s, the health route's rule): its newest heartbeat
// would read as a stale last-seen time beside the network's own Online.
export const LAST_HEARTBEAT_SQL = `SELECT b.timestamp::text AS ts FROM transactions t JOIN blocks b ON b.height = t.block
 WHERE t.from_address = $1 AND t.tx_type IN ('HeartbeatCommitment', 'Heartbeat')
 AND EXISTS (SELECT 1 FROM sync_state s WHERE s.id = 1 AND s.last_sync_at > CURRENT_TIMESTAMP - interval '120 seconds')
 ORDER BY t.block DESC, t.tx_index DESC LIMIT 1`;

export interface ArchiveFacts {
  // The block of the wallet's first node's registration, where its epochs start; null when the archive holds no row
  // that names one of its nodes.
  registeredHeight: number | null;
  // The block of the wallet's super node's registration; null when none is read.
  superHeight: number | null;
  // Epoch key -> the move that took it to the wallet, with the amount it moved (nano QNC, decimal) when readable.
  claims: Map<number, { tx: string; amountNano: string | null }>;
  // Block height -> its time (ms).
  times: Map<number, number>;
}

// The archive's facts for a wallet's node, given the epoch keys of the page the network reported for it.
export type EpochArchive = (wallet: string, nodeId: string, keys: number[]) => Promise<ArchiveFacts>;

type Row = Record<string, unknown>;
export type ArchiveQuery = (text: string, params: unknown[]) => Promise<{ rows: Row[] }>;

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const TX_RE = /^[A-Za-z0-9_-]{8,128}$/;

function wholeNumber(v: unknown): number | null {
  const n = typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

const MEMO_RE = /^(?:client_node_reg|node_registration):([^:]{1,64}):/;
const typeOf = (id: string) => (isSuperNodeId(id) ? 'super' : 'light');

export interface Registrations {
  // The block of the first row that names one of the wallet's nodes, and of the first that names a super node of it.
  first: number | null;
  superAt: number | null;
}

// The wallet's registrations among `rows` (REGISTRATION_SQL): its nodes are the light and the super id it derives and
// `nodeId`, the id asked for, which the network resolves to the wallet (a genesis node's derives from nothing). A row
// names a node by its kept fields of the node's type, or, for a row from before the indexer kept them, by its memo. The
// lowest block wins, whatever the rows' order, so a registration sent again moves nothing.
export function walletRegistrations(wallet: string, nodeId: string, rows: Row[]): Registrations {
  const nodes = new Map([[lightNodeId(wallet), 'light'], [superNodeId(wallet), 'super'], [nodeId, typeOf(nodeId)]]);
  let first: number | null = null;
  let superAt: number | null = null;
  for (const row of rows) {
    const d = isObject(row.data) ? row.data : null;
    const memo = typeof row.memo === 'string' ? MEMO_RE.exec(row.memo) : null;
    const named = d !== null && typeof d.node_id === 'string' && typeof d.node_type === 'string'
      ? { id: d.node_id, type: d.node_type.toLowerCase() }
      : memo ? { id: memo[1], type: typeOf(memo[1]) } : null;
    const height = wholeNumber(row.block);
    if (named === null || height === null || nodes.get(named.id) !== named.type) continue;
    if (first === null || height < first) first = height;
    if (named.type === 'super' && (superAt === null || height < superAt)) superAt = height;
  }
  return { first, superAt };
}

// The epochs and amounts a move's payload lists: `{"claims": [{"epoch": K, "amount": A, "proof": [...]}, ...]}`,
// read entry by entry so a payload the archive cut short still gives its whole entries; amounts stay exact digits.
export function movedEpochs(data: unknown): { key: number; amountNano: string | null }[] {
  if (typeof data !== 'string') return [];
  const out: { key: number; amountNano: string | null }[] = [];
  for (const [entry] of data.matchAll(/\{[^{}]*\}/g)) {
    const epoch = /"epoch"\s*:\s*(\d{1,15})\b/.exec(entry);
    if (!epoch) continue;
    const amount = /"amount"\s*:\s*(\d{1,20})\b/.exec(entry);
    out.push({ key: Number(epoch[1]), amountNano: amount ? amount[1].replace(/^0+(?=\d)/, '') : null });
  }
  return out;
}

// The moves as epoch key -> move; the first row that lists an epoch keeps it (the chain moves an epoch once).
export function claimsFrom(rows: Row[]): Map<number, { tx: string; amountNano: string | null }> {
  const out = new Map<number, { tx: string; amountNano: string | null }>();
  for (const row of rows) {
    if (typeof row.hash !== 'string' || !TX_RE.test(row.hash)) continue;
    for (const { key, amountNano } of movedEpochs(row.data)) {
      if (epochOfKey(key) && !out.has(key)) out.set(key, { tx: row.hash, amountNano });
    }
  }
  return out;
}

export function timesFrom(rows: Row[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const row of rows) {
    const height = wholeNumber(row.height);
    const ts = wholeNumber(row.ts);
    if (height !== null && ts !== null && ts > 0) out.set(height, ts);
  }
  return out;
}

// The newest heartbeat's block time (ms), or null.
export function lastHeartbeatFrom(rows: Row[]): number | null {
  const ts = rows[0] ? wholeNumber(rows[0].ts) : null;
  return ts !== null && ts > 0 ? ts : null;
}

export function createLastHeartbeat(query: ArchiveQuery): (nodeId: string) => Promise<number | null> {
  return async (nodeId) => lastHeartbeatFrom((await query(LAST_HEARTBEAT_SQL, [nodeId])).rows);
}

// The page's reads: the wallet's registrations (kept once found), and, for the page's epochs, the moves from the end of
// its oldest epoch on and the times of its epochs' first blocks and their successors.
export function createEpochArchive(query: ArchiveQuery, now: () => number = Date.now): EpochArchive {
  const registrations = memo<Registrations>((r) => (r.superAt !== null ? REGISTRATION_CACHE_MS : REGISTRATION_RECHECK_MS), now);
  return async (wallet, nodeId, keys) => {
    const spans = keys.map(epochOfKey).filter((s) => s !== null);
    const oldest = spans.length > 0 ? Math.min(...spans.map((s) => s.end)) : null;
    const heights = [...new Set(spans.flatMap((s) => [s.start, s.end]))];
    const [registered, moves, times] = await Promise.all([
      registrations(`${wallet}:${nodeId}`, async () => walletRegistrations(wallet, nodeId, (await query(REGISTRATION_SQL, [wallet])).rows), (r) => r.first !== null),
      oldest === null ? null : query(CLAIMS_SQL, [wallet, oldest]),
      heights.length === 0 ? null : query(TIMES_SQL, [heights]),
    ]);
    return {
      registeredHeight: registered.first, superHeight: registered.superAt,
      claims: moves ? claimsFrom(moves.rows) : new Map(), times: times ? timesFrom(times.rows) : new Map(),
    };
  };
}
