// The gate in front of every /api/cabinet route: the origin checks, then a per-client limit of the route's own.
// The explorer server may be on the nodes' whitelist, where its requests skip their per-address limits, so
// every cabinet route that reaches a node meters the real client here (the visitor's IP from nginx's
// X-Real-IP, IPv6 by its /64). The cabinet has a limiter store of its own, apart from the explorer's and the
// relay's.

import {
  createRateLimiter,
  getRateLimitKey,
  sweepPeriodically,
  type ClientIpResolution,
  type RateLimitResult,
  type RateLimiter,
} from '../../../lib/rate-limit.ts';
import { activationOriginAllowed, originAllowed } from '../request-guard.ts';

export const CABINET_LIMITS = {
  // Node status and history: a page reads on load, on return and every half minute while shown.
  node: { max: 120, windowMs: 60_000 },
  price: { max: 60, windowMs: 60_000 },
  // A payment address's balance, polled every 3 s while the page is shown.
  payment: { max: 120, windowMs: 60_000 },
  blockhash: { max: 60, windowMs: 60_000 },
  send: { max: 10, windowMs: 60_000 },
  tx: { max: 120, windowMs: 60_000 },
  // Reads of a signature the page holds no read pass for (solana-proxy.ts): each client's share of the server's small
  // budget, so that no one client holds all of it (SITE-R3-01).
  txOther: { max: 12, windowMs: 60_000 },
  // A registration is a few submits (retries back off); sized for several activations behind one carrier NAT
  // address, each node also held to its own KEYED_LIMITS budget once its signatures verify (SITE-8).
  register: { max: 30, windowMs: 600_000 },
  registration: { max: 30, windowMs: 60_000 },
  // "I'm back": a silent push to someone's device, so few per client.
  wake: { max: 3, windowMs: 600_000 },
  // A wallet's activation record (activation-api.ts): read on load and while a burn is on its way; the search of its
  // Solana address, which costs the server Solana reads, far fewer; a reservation, an announce, a release, a record.
  activation: { max: 60, windowMs: 60_000 },
  activationScan: { max: 10, windowMs: 600_000 },
  activationWrite: { max: 20, windowMs: 600_000 },
  // A super node's status and a wallet's node on the network, read as a light node's status is.
  super: { max: 120, windowMs: 60_000 },
  walletNode: { max: 60, windowMs: 60_000 },
} as const;
export type CabinetRoute = keyof typeof CABINET_LIMITS;
// The routes the QNet extension calls too: their origin rule is request-guard.ts activationOriginAllowed.
const ACTIVATION_ROUTES: ReadonlySet<string> = new Set(['activation', 'activationScan', 'activationWrite']);

// Limits on a key of the request's own (a payment address, a node), across every client. A wake proves nothing about
// who asks (a node id is public), so its one per window counts only the pushes the network sent (wake.ts, SITE-R2-07).
export const KEYED_LIMITS = {
  send: { max: 5, windowMs: 600_000 },
  register: { max: 6, windowMs: 600_000 },
  wake: { max: 1, windowMs: 600_000 },
  // A record of a wallet's burn, counted only once its proof verified.
  activationRecord: { max: 10, windowMs: 600_000 },
} as const;
export type KeyedRoute = keyof typeof KEYED_LIMITS;

// Budgets of each client across routes. `upstreamMiss`: the reads of the node, super and wallet-node routes that miss
// the cache and go to the genesis nodes (SITE M-12): a page reads three every half minute, and a made-up id always
// misses, so one client cannot hold the server's whole read budget (upstream.ts).
export const CLIENT_BUDGETS = {
  upstreamMiss: { max: 30, windowMs: 60_000 },
} as const;
export type ClientBudget = keyof typeof CLIENT_BUDGETS;

const LIMITER_ENTRIES = 50_000;
export const HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

export function cabinetJson(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...HEADERS, 'Content-Type': 'application/json', ...extra } });
}

export interface GateOptions {
  now?: () => number;
  clientKey?: (request: Request) => ClientIpResolution;
  limit?: (identifier: string, maxRequests: number, windowMs: number) => RateLimitResult;
  scope?: string;
  devOrigins?: boolean;
}

// The origin checks and the client's limit of `route`; with `keyed`, also the limit on that key of the request.
// `keyed` alone counts only the key's limit: a route whose key is someone else's until a signature proves it (a
// payment address, a node) calls it after that check, so nobody spends another's budget with junk (SITE-2). `client`:
// the request's client key as the limits count it (`ip:` and the IP, IPv6 by its /64), for a route that charges a
// budget of its own to the client (burn-scan.ts); null without a client address. `spend`: one of the client's
// CLIENT_BUDGETS, counted when the route is about to spend the server's (429 past it).
export interface Gate {
  (request: Request, route: CabinetRoute, keyed?: { route: KeyedRoute; key: string }): Response | null;
  keyed(route: KeyedRoute, key: string): Response | null;
  client(request: Request): string | null;
  spend(request: Request, budget: ClientBudget): Response | null;
}

export function createGate(options: GateOptions = {}): Gate {
  const now = options.now ?? Date.now;
  const clientKey = options.clientKey ?? getRateLimitKey;
  let limiter: RateLimiter | null = null;
  const limit = options.limit ?? ((id: string, max: number, windowMs: number) => {
    if (!limiter) {
      limiter = createRateLimiter({ maxEntries: LIMITER_ENTRIES, now });
      sweepPeriodically(limiter);
    }
    return limiter.limit(id, max, windowMs);
  });
  const scope = options.scope ?? 'cabinet';
  const devOrigins = options.devOrigins ?? process.env.NODE_ENV !== 'production';
  const refused = (result: RateLimitResult): Response => {
    const retryAfter = Math.max(1, Math.ceil((result.resetTime - now()) / 1000));
    return cabinetJson(429, { error: 'rate_limited' }, { 'Retry-After': String(retryAfter) });
  };
  const byKey = (route: KeyedRoute, key: string): Response | null => {
    const k = KEYED_LIMITS[route];
    const result = limit(`${scope}:${route}#:${key}`, k.max, k.windowMs);
    return result.allowed ? null : refused(result);
  };
  const gate = (request: Request, route: CabinetRoute, keyed?: { route: KeyedRoute; key: string }): Response | null => {
    // Before any limit counts it, so another page cannot spend a visitor's limits.
    const allowed = ACTIVATION_ROUTES.has(route) ? activationOriginAllowed(request, devOrigins) : originAllowed(request, devOrigins);
    if (!allowed) return cabinetJson(403, { error: 'forbidden_origin' });
    const key = clientKey(request);
    if (!key.ok) return cabinetJson(503, { error: 'unavailable' });
    const { max, windowMs } = CABINET_LIMITS[route];
    const result = limit(`${scope}:${route}:${key.ip}`, max, windowMs);
    if (!result.allowed) return refused(result);
    return keyed ? byKey(keyed.route, keyed.key) : null;
  };
  const client = (request: Request): string | null => {
    const key = clientKey(request);
    return key.ok ? `ip:${key.ip}` : null;
  };
  const spend = (request: Request, budget: ClientBudget): Response | null => {
    const key = clientKey(request);
    if (!key.ok) return cabinetJson(503, { error: 'unavailable' });
    const { max, windowMs } = CLIENT_BUDGETS[budget];
    const result = limit(`${scope}:${budget}$:${key.ip}`, max, windowMs);
    return result.allowed ? null : refused(result);
  };
  return Object.assign(gate, { keyed: byKey, client, spend });
}

// The process's gate, on globalThis so every cabinet route bundle shares one limiter.
const GLOBAL_KEY = Symbol.for('qnet.cabinetGate');

export function cabinetGate(): Gate {
  const holder = globalThis as unknown as Record<symbol, Gate | undefined>;
  const existing = holder[GLOBAL_KEY];
  if (existing) return existing;
  const created = createGate();
  holder[GLOBAL_KEY] = created;
  return created;
}
