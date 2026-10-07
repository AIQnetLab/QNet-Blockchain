// POST /api/cabinet/wake: "I'm back" (unified plan R8, SITE-7). The site asks the owners of the node's light shard,
// in rank order, the genesis node's wake route for a registered light node; the owner sends the linked device one
// silent push (a backup hands it to the owners ranked above it first, light_push.rs wake_plan) and answers a reason,
// which the site passes on. An owner that cannot be reached, answers other than 200 (one behind the network answers
// 503) or gives no reply the site reads is passed over for the next. Unauthenticated, like the node's route: the most
// a caller can cause is one extra silent push to that node's own device. The explorer server may be on the nodes'
// whitelist, so the client is metered here (limits.ts), each node gets at most one push through the site per window,
// and each genesis node a bounded number of wakes a second (upstream.ts); the node keeps its own caps.

import { readCappedBytes } from '../../lib/capped-body.ts';
import { GENESIS_NODES } from '../../lib/genesis-nodes.ts';
import { WAKE_BODY_MAX_BYTES, WAKE_PATH, checkWakeRequest, parseNodeWake, wakeView, type WakeAnswer } from '../../lib/cabinet/wake.ts';
import { readJsonPost } from '../request-guard.ts';
import { KEYED_LIMITS, cabinetGate, cabinetJson, createGate, type Gate, type GateOptions } from './limits.ts';
import { lightShardOwners } from './node-proxy.ts';
import { sharedUpstreamBudget, unbudgeted, type UpstreamBudget } from './upstream.ts';

// How long the owner of rank r is given: NODE_TIMEOUT_MS to send, and HANDOFF_MS for each owner ranked above it,
// which it asks first (light_push.rs forward_wake: WAKE_FORWARD_SECS, 2 s over TLS, for one it cannot reach). All of
// it within WAKE_TOTAL_MS, under the proxy's 60 s.
export const NODE_TIMEOUT_MS = 8_000;
export const HANDOFF_MS = 4_000;
export const WAKE_TOTAL_MS = 40_000;
const NODE_BODY_MAX_BYTES = 4 * 1024;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface WakeOptions extends GateOptions {
  gate?: Gate;
  fetchFn?: FetchLike;
  nodes?: readonly string[];
  random?: () => number;
  budget?: UpstreamBudget;
}

export interface Wake {
  wake(request: Request): Promise<Response>;
}

// How many nodes' holds the site remembers.
const HELD_KEPT = 50_000;

// The genesis nodes a wake is asked of, in order: the owners of the node's light shard by rank (the one that wakes
// its device, then its two backups), each only when the one before gave no answer. A list other than the five genesis
// nodes: up to three of it, from a random one on.
export function wakeOrder(nodeId: string, nodes: readonly string[], random: () => number): string[] {
  if (nodes.length === 5) return lightShardOwners(nodeId).map((i) => nodes[i]);
  const first = Math.floor(random() * nodes.length);
  return Array.from({ length: Math.min(3, nodes.length) }, (_, k) => nodes[(first + k) % nodes.length]);
}

export function createWake(options: WakeOptions = {}): Wake {
  const gate = options.gate ?? createGate(options);
  const fetchFn = options.fetchFn ?? fetch;
  const nodes = options.nodes ?? GENESIS_NODES;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const budget = options.budget ?? unbudgeted;
  // Until when the network takes no wake of each node from this site: a window after a push it sent through this site
  // (the node answered `sent`), or the wait a node's `cooldown` named. A node id is public, so a request proves
  // nothing: only a push counts against the node's one wake per window, and a request within a hold is answered
  // `cooldown` (the node's own answer then) without asking the network (SITE-R2-07). A request that sent nothing
  // spends nothing of the node's.
  const held = new Map<string, number>();
  const heldFor = (nodeId: string): number | null => {
    const until = held.get(nodeId);
    if (until === undefined) return null;
    if (now() < until) return until - now();
    held.delete(nodeId);
    return null;
  };
  const hold = (nodeId: string, ms: number): void => {
    const until = Math.max(now() + ms, held.get(nodeId) ?? 0);
    held.delete(nodeId);
    if (held.size >= HELD_KEPT) held.delete(held.keys().next().value as string);
    held.set(nodeId, until);
  };

  // One owner's answer, or null when it could not be reached in `timeoutMs` or gave no answer (a node before the
  // route, an answer about another node).
  async function ask(base: string, nodeId: string, timeoutMs: number): Promise<WakeAnswer | null> {
    try {
      const res = await fetchFn(`${base}${WAKE_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ node_id: nodeId }),
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => undefined);
        return null;
      }
      const bytes = await readCappedBytes(res, NODE_BODY_MAX_BYTES);
      return bytes ? parseNodeWake(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), nodeId) : null;
    } catch {
      return null;
    }
  }

  return {
    async wake(request) {
      const read = await readJsonPost(request, WAKE_BODY_MAX_BYTES);
      if (!read.ok) return cabinetJson(read.status, { error: read.error });
      const nodeId = checkWakeRequest(read.value);
      const refused = gate(request, 'wake');
      if (refused) return refused;
      if (!nodeId) return cabinetJson(400, { error: 'invalid_request' });
      const heldMs = heldFor(nodeId);
      if (heldMs !== null) return cabinetJson(200, wakeView({ result: 'cooldown', retryAfterSeconds: Math.ceil(heldMs / 1000) }));
      // The owners in rank order, the next only when one gave no answer: any owner answers the same as the highest one
      // it reaches, and the node's cooldown makes a repeat harmless. An owner whose wake budget this second is spent is
      // not asked (upstream.ts).
      const started = Date.now();
      for (const [rank, base] of wakeOrder(nodeId, nodes, random).entries()) {
        const remaining = WAKE_TOTAL_MS - (Date.now() - started);
        if (remaining <= 0) break;
        if (!budget('wake', base)) continue;
        const answer = await ask(base, nodeId, Math.min(NODE_TIMEOUT_MS + rank * HANDOFF_MS, remaining));
        if (!answer) continue;
        if (answer.result === 'sent') hold(nodeId, KEYED_LIMITS.wake.windowMs);
        else if (answer.result === 'cooldown' && answer.retryAfterSeconds) hold(nodeId, answer.retryAfterSeconds * 1000);
        return cabinetJson(200, wakeView(answer));
      }
      return cabinetJson(503, { error: 'unavailable' });
    },
  };
}

const GLOBAL_KEY = Symbol.for('qnet.cabinetWake');

export function cabinetWake(): Wake {
  const holder = globalThis as unknown as Record<symbol, Wake | undefined>;
  const existing = holder[GLOBAL_KEY];
  if (existing) return existing;
  const created = createWake({ gate: cabinetGate(), budget: sharedUpstreamBudget() });
  holder[GLOBAL_KEY] = created;
  return created;
}
