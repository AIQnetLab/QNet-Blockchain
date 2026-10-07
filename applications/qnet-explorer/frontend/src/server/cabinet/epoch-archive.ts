// What the explorer's archive of the chain adds to a node's epochs (src/server/cabinet/node-proxy.ts history): the
// height of the node's registration (its NodeRegistration row, src/indexer/transform.ts: a light node's is sent from its
// wallet, a super node's from the node's own id), the wallet's moves of the node balance (RewardDistribution rows from
// system_rewards_pool to the wallet, whose payload lists the epochs and amounts it moved) and the time of the block each
// epoch ended with. Three indexed reads per node, cached with the history; every row is public on the chain. The nodes'
// own per-epoch history stays the source of what was counted. Also a super node's newest heartbeat, when it was last seen.

import { epochOfKey } from '../../lib/cabinet/epochs.ts';
import { isSuperNodeId } from '../../lib/qnet-link.ts';
import { RECORD_SQL } from './registration-record.ts';

// A few moves cover a node's epochs for weeks: each move takes every epoch not moved before it.
export const CLAIM_ROWS = 32;
// The block times read at most per node: the network's epochs (up to 400, node-proxy.ts) and the archive's moved ones.
export const TIME_ROWS = 600;

export const CLAIMS_SQL = `SELECT hash, block::text AS block, data FROM transactions
 WHERE to_address = $1 AND tx_type = 'RewardDistribution' AND from_address = 'system_rewards_pool'
 ORDER BY block DESC, tx_index DESC LIMIT ${CLAIM_ROWS}`;
export const TIMES_SQL = 'SELECT height::text AS height, timestamp::text AS ts FROM blocks WHERE height = ANY($1::bigint[])';
// A super node's newest heartbeat, sent from the node's id, with its block's time: when the node was last seen by the
// chain.
export const LAST_HEARTBEAT_SQL = `SELECT b.timestamp::text AS ts FROM transactions t JOIN blocks b ON b.height = t.block
 WHERE t.from_address = $1 AND t.tx_type IN ('HeartbeatCommitment', 'Heartbeat') ORDER BY t.block DESC, t.tx_index DESC LIMIT 1`;

export interface ArchiveFacts {
  // The block of the node's registration; null when the archive holds no row of it that names the node.
  registeredHeight: number | null;
  // Epoch key -> the move that took it to the wallet, with the amount it moved (nano QNC, decimal) when readable.
  claims: Map<number, { tx: string; amountNano: string | null }>;
  // Block height -> its time (ms).
  times: Map<number, number>;
}

// The archive's facts for a wallet's node, given the epoch keys the network reported for it.
export type EpochArchive = (wallet: string, nodeId: string, keys: number[]) => Promise<ArchiveFacts>;

type Row = Record<string, unknown>;
export type ArchiveQuery = (text: string, params: unknown[]) => Promise<{ rows: Row[] }>;

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const TX_RE = /^[A-Za-z0-9_-]{8,128}$/;

function wholeNumber(v: unknown): number | null {
  const n = typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

// The newest registration row (RECORD_SQL, newest first) that names this node, of its type.
export function registrationHeight(nodeId: string, rows: Row[]): number | null {
  const type = isSuperNodeId(nodeId) ? 'super' : 'light';
  for (const row of rows) {
    const d = isObject(row.data) ? row.data : null;
    if (!d || d.node_id !== nodeId || typeof d.node_type !== 'string' || d.node_type.toLowerCase() !== type) continue;
    const height = wholeNumber(row.block);
    if (height !== null) return height;
  }
  return null;
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

// The moves, newest first, as epoch key -> move; an epoch listed twice keeps its newest move.
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

export function createEpochArchive(query: ArchiveQuery): EpochArchive {
  return async (wallet, nodeId, keys) => {
    const from = isSuperNodeId(nodeId) ? nodeId : wallet;
    const [registrations, moves] = await Promise.all([query(RECORD_SQL, [from]), query(CLAIMS_SQL, [wallet])]);
    const claims = claimsFrom(moves.rows);
    const ends = new Set<number>();
    for (const key of [...keys, ...claims.keys()]) {
      const span = epochOfKey(key);
      if (span && ends.size < TIME_ROWS) ends.add(span.end);
    }
    const times = ends.size > 0 ? timesFrom((await query(TIMES_SQL, [[...ends]])).rows) : new Map<number, number>();
    return { registeredHeight: registrationHeight(nodeId, registrations.rows), claims, times };
  };
}
