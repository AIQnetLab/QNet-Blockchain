// The network's eligible set: the super nodes its consensus admits, as the newest certified macroblock commits them (its
// eligible producers, development/qnet-integration/src/node/committee.rs create_eligible_producers_snapshot). A genesis
// node names that macroblock (GET /api/v1/state/certified), and the macroblock's proof carries the set as `eligible_raw`
// (GET /api/v1/macroblock/{index}/proof; ../light/checkpoint.ts decodes it). A registered super node outside the set is
// registered and waiting for the network to admit it (owner, 11.10). One genesis node is asked, the next when it gives
// no usable answer; the set is kept a few minutes for every reader (it changes at most once a macroblock, 90 blocks) and
// read at most once at a time. Every value is public chain data; nothing of a visitor is sent.

import { readCappedBytes } from '../../lib/capped-body.ts';
import { GENESIS_NODES } from '../../lib/genesis-nodes.ts';
import { decodeEligibleNodeIds } from '../light/checkpoint.ts';
import { unbudgeted, type UpstreamBudget } from './upstream.ts';

export const ELIGIBLE_CACHE_MS = 300_000;
// A failed read is tried again after this long, not on every status read.
export const ELIGIBLE_RETRY_MS = 30_000;
// Past ELIGIBLE_CACHE_MS the last set read is still served at once while one read refreshes it behind, and while
// refreshes fail, up to this age: a slow or failed refresh then never turns a waiting node's status unknown for a poll.
// An admitted node leaves the set only after a missed heartbeat window (about 24 minutes), so this is no staler than
// the set itself.
export const ELIGIBLE_STALE_MS = 1_800_000;
const HEAD_MAX_BYTES = 64 * 1024;
// The proof grows with the committee's keys and signatures (about 8 KB a member); past this the set reads as unknown.
export const PROOF_MAX_BYTES = 8 * 1024 * 1024;
const NODE_TIMEOUT_MS = 8_000;
const HEX_RE = /^(?:[0-9a-f]{2})*$/;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface EligibleOptions {
  fetchFn?: FetchLike;
  nodes?: readonly string[];
  random?: () => number;
  now?: () => number;
  budget?: UpstreamBudget;
}

// The ids in the eligible set, or null when no node gave a usable answer.
export type EligibleSet = () => Promise<ReadonlySet<string> | null>;

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

// The macroblock a node holds certified newest: `newest_certified_index` of a certified-state answer (proof_format 2).
export function certifiedIndex(body: unknown): number | null {
  if (!isObject(body) || body.proof_format !== 2 || !isCount(body.newest_certified_index)) return null;
  return body.newest_certified_index;
}

// The eligible ids a macroblock proof carries for `index`; null for a proof of another index, or none.
export function eligibleOf(body: unknown, index: number): Set<string> | null {
  if (!isObject(body) || body.index !== index || typeof body.eligible_raw !== 'string' || !HEX_RE.test(body.eligible_raw)) return null;
  const ids = decodeEligibleNodeIds(Buffer.from(body.eligible_raw, 'hex'));
  return ids.length > 0 ? new Set(ids) : null;
}

export function createEligibleSet(options: EligibleOptions = {}): EligibleSet {
  const fetchFn = options.fetchFn ?? fetch;
  const nodes = options.nodes ?? GENESIS_NODES;
  const random = options.random ?? Math.random;
  const budget = options.budget ?? unbudgeted;
  const now = options.now ?? Date.now;
  let kept: { set: ReadonlySet<string>; at: number } | null = null;
  let failedAt: number | null = null;
  let pending: Promise<ReadonlySet<string> | null> | null = null;

  async function read(url: string, max: number): Promise<unknown> {
    if (!budget('readKnown', url)) return null;
    try {
      const res = await fetchFn(url, { headers: { Accept: 'application/json' }, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(NODE_TIMEOUT_MS) });
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => undefined);
        return null;
      }
      const bytes = await readCappedBytes(res, max);
      return bytes ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) : null;
    } catch {
      return null;
    }
  }

  async function load(): Promise<ReadonlySet<string> | null> {
    const order = [...nodes];
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (const base of order) {
      const index = certifiedIndex(await read(`${base}/api/v1/state/certified`, HEAD_MAX_BYTES));
      if (index === null) continue;
      const set = eligibleOf(await read(`${base}/api/v1/macroblock/${index}/proof`, PROOF_MAX_BYTES), index);
      if (set) return set;
    }
    return null;
  }

  // One read at a time; a good set is kept, a failure noted for the retry.
  function refresh(): Promise<ReadonlySet<string> | null> {
    pending ??= load().catch(() => null).then((set) => {
      if (set) {
        kept = { set, at: now() };
        failedAt = null;
      } else {
        failedAt = now();
      }
      return set;
    }).finally(() => {
      pending = null;
    });
    return pending;
  }

  return async () => {
    const age = kept === null ? Infinity : now() - kept.at;
    if (kept !== null && age < ELIGIBLE_CACHE_MS) return kept.set;
    const due = pending === null && (failedAt === null || now() - failedAt >= ELIGIBLE_RETRY_MS);
    const read = due ? refresh() : pending;
    if (kept !== null && age < ELIGIBLE_STALE_MS) return kept.set;
    return read ?? null;
  };
}
