// What the site asks of each network node in a second, whatever its visitors do (SITE-R2-09). The per-client limits
// (limits.ts) bound one visitor, but many visitors together, or one with many addresses, could still send a node far
// more than it should take from one server, and the explorer server may be on the nodes' whitelist, which skips their
// own per-address limits. So each kind of call has a budget per node: a call beyond it is not made and counts as that
// node not answering (the route tries another node, or answers that the network could not be reached). The kinds are
// kept apart, so a flood of reads cannot starve a registration, a wake or a reservation's check that the wallet has no
// node: that check runs only for a reservation the wallet signed (activation-api.ts), never for an anonymous read. A
// page's reads are split by the id they are for (SITE M-12): an id the network was seen to list as registered
// (known-nodes.ts) reads on `readKnown`, any other on the small `readUnknown`, so made-up ids, which cost nothing, cannot
// starve the owners of registered nodes. Each client is also held to its own share of the reads that go upstream
// (limits.ts CLIENT_BUDGETS.upstreamMiss). Together `readKnown` and `readUnknown` ask a genesis node what `read` alone
// asked before: 20 reads a second.

import { createRateLimiter } from '../../../lib/rate-limit.ts';

export const UPSTREAM_BUDGETS = {
  // A node's public status, its balance and its history, and whether a wallet has a node, for a page (node-proxy.ts,
  // wallet-node.ts): for an id seen registered, and for any other.
  readKnown: { max: 16, windowMs: 1_000 },
  readUnknown: { max: 4, windowMs: 1_000 },
  // The same reads for a reservation the wallet signed (activation-api.ts reserve).
  reserve: { max: 10, windowMs: 1_000 },
  // A registration submit (register.ts).
  submit: { max: 2, windowMs: 1_000 },
  // "I'm back" (wake.ts).
  wake: { max: 2, windowMs: 1_000 },
} as const;
export type UpstreamKind = keyof typeof UPSTREAM_BUDGETS;

// Whether a call of `kind` to the node at `url` may go now (and counts it when it may).
export type UpstreamBudget = (kind: UpstreamKind, url: string) => boolean;

// No budget: a route built without one (the tests' own). The process's routes use sharedUpstreamBudget.
export const unbudgeted: UpstreamBudget = () => true;

export function createUpstreamBudget({ now = Date.now }: { now?: () => number } = {}): UpstreamBudget {
  // A handful of nodes times five kinds: the store never fills.
  const limiter = createRateLimiter({ maxEntries: 1_000, now });
  return (kind, url) => {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return false;
    }
    const { max, windowMs } = UPSTREAM_BUDGETS[kind];
    return limiter.limit(`${kind}:${origin}`, max, windowMs).allowed;
  };
}

// The process's budget, on globalThis so every route bundle shares it.
const GLOBAL_KEY = Symbol.for('qnet.cabinetUpstreamBudget');

export function sharedUpstreamBudget(): UpstreamBudget {
  const holder = globalThis as unknown as Record<symbol, UpstreamBudget | undefined>;
  const existing = holder[GLOBAL_KEY];
  if (existing) return existing;
  const created = createUpstreamBudget();
  holder[GLOBAL_KEY] = created;
  return created;
}
