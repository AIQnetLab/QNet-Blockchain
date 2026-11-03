// The whole payload of a move of a node balance whose copy the explorer's archive keeps cut short (epoch-archive.ts
// completeMoves): read from a genesis node's microblock at the move's height, the transaction of the move's hash, and
// taken only when its listed amounts add up to the move's own total, as the chain binds them. A move in a block never
// changes, so a payload read is kept for the process's life (a bounded number of them, without their proofs); a read
// that gets none is asked again after MOVE_RETRY_MS. Every value is public chain data; nothing of a visitor is sent.

import { readCappedBytes } from '../../lib/capped-body.ts';
import { GENESIS_NODES } from '../../lib/genesis-nodes.ts';
import { memo } from './cache.ts';
import { PROOFS_RE, wholeEntries, type WholeMove } from './epoch-archive.ts';
import { unbudgeted, type UpstreamBudget } from './upstream.ts';

// A microblock with many transactions beside the move; past this its read gives none.
export const MOVE_BLOCK_MAX_BYTES = 8 * 1024 * 1024;
export const MOVE_RETRY_MS = 120_000;
export const MOVES_KEPT = 500;
// Nodes asked for one payload, in a random order.
export const MOVE_NODES_ASKED = 2;
const NODE_TIMEOUT_MS = 8_000;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface MovePayloadOptions {
  fetchFn?: FetchLike;
  nodes?: readonly string[];
  random?: () => number;
  now?: () => number;
  budget?: UpstreamBudget;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

// The move's payload, proofs left out, from a microblock answer: its transaction of `hash`, when its listed amounts are
// the move's whole `amount`; null for anything else.
export function payloadFrom(body: unknown, hash: string, amount: string): string | null {
  if (!isObject(body) || !Array.isArray(body.transactions)) return null;
  const tx = body.transactions.find((t) => isObject(t) && t.hash === hash);
  if (!isObject(tx) || typeof tx.data !== 'string') return null;
  const data = tx.data.replace(PROOFS_RE, '');
  return wholeEntries({ amount, data }) === null ? null : data;
}

export function createMovePayloads(options: MovePayloadOptions = {}): WholeMove {
  const fetchFn = options.fetchFn ?? fetch;
  const nodes = options.nodes ?? GENESIS_NODES;
  const random = options.random ?? Math.random;
  const budget = options.budget ?? unbudgeted;
  const kept = memo<string | null>((v) => (v === null ? MOVE_RETRY_MS : Number.POSITIVE_INFINITY), options.now ?? Date.now, MOVES_KEPT);

  async function read(url: string): Promise<unknown> {
    if (!budget('readKnown', url)) return null;
    try {
      const res = await fetchFn(url, { headers: { Accept: 'application/json' }, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(NODE_TIMEOUT_MS) });
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => undefined);
        return null;
      }
      const bytes = await readCappedBytes(res, MOVE_BLOCK_MAX_BYTES);
      return bytes ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) : null;
    } catch {
      return null;
    }
  }

  async function load(hash: string, height: number, amount: string): Promise<string | null> {
    const order = [...nodes];
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    // No line is logged: it would tie a wallet's move to the moment a visitor read its page. The page says the total
    // could not be read.
    for (const base of order.slice(0, MOVE_NODES_ASKED)) {
      const data = payloadFrom(await read(`${base}/api/v1/microblock/${height}`), hash, amount);
      if (data !== null) return data;
    }
    return null;
  }

  const key = (hash: string, amount: string) => `${hash}:${amount}`;
  return Object.assign((hash: string, height: number, amount: string) => kept(key(hash, amount), () => load(hash, height, amount), () => true),
    { has: (hash: string, amount: string) => kept.has(key(hash, amount)) });
}

// The process's reader, on globalThis so every route bundle shares one store, on the cabinet's upstream budget.
const GLOBAL_KEY = Symbol.for('qnet.cabinetMovePayloads');

export function movePayloads(budget: UpstreamBudget): WholeMove {
  const holder = globalThis as unknown as Record<symbol, WholeMove | undefined>;
  const existing = holder[GLOBAL_KEY];
  if (existing) return existing;
  const created = createMovePayloads({ budget });
  holder[GLOBAL_KEY] = created;
  return created;
}
