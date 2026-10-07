// The node activation price, as the network's nodes state it (GET /api/v1/activation/price?type=,
// development/qnet-integration/src/rpc/registration_api.rs handle_activation_price). No fallback
// numbers anywhere: a missing or malformed answer is "unavailable". Shared by /api/activation/price
// and the /activate page, which checks the route's answer again.

import { readCappedBytes } from './capped-body.ts';
import { GENESIS_NODES } from './genesis-nodes.ts';
import { BURN_AMOUNT_MAX, type NodeType } from './qnet-link.ts';

// Phase 1 burns a whole number of 1DEV; phase 2 (QNC) has no burn activation.
export type PriceQuote = { phase: 1; cost: number } | { phase: 2 };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isCost = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= BURN_AMOUNT_MAX;

// A node's answer: {phase: 1, node_type, cost, currency: '1DEV', ...} or {phase: 2, ...}.
export function parseNodePrice(body: unknown, type: NodeType): PriceQuote | null {
  if (!isPlainObject(body) || body.error !== undefined) return null;
  if (body.node_type !== undefined && body.node_type !== type) return null;
  if (body.phase === 2) return { phase: 2 };
  if (body.phase !== 1 || body.currency !== '1DEV' || !isCost(body.cost)) return null;
  return { phase: 1, cost: body.cost };
}

// The site route's answer: {type, phase: 1, cost, currency: '1DEV'} or {type, phase: 2}.
export function parseSitePrice(body: unknown, type: NodeType): PriceQuote | null {
  if (!isPlainObject(body) || body.type !== type) return null;
  if (body.phase === 2) return Object.keys(body).length === 2 ? { phase: 2 } : null;
  if (body.phase !== 1 || body.currency !== '1DEV' || !isCost(body.cost) || Object.keys(body).length !== 4) return null;
  return { phase: 1, cost: body.cost };
}

export function sitePriceBody(type: NodeType, quote: PriceQuote): Record<string, unknown> {
  return quote.phase === 1 ? { type, phase: 1, cost: quote.cost, currency: '1DEV' } : { type, phase: 2 };
}

// The nodes the wallets pin (HTTPS only), asked in random order until one gives a valid quote.
export const PRICE_NODES = GENESIS_NODES;
const NODE_TIMEOUT_MS = 4_000;
const NODE_BODY_MAX_BYTES = 8 * 1024;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

function shuffled(nodes: readonly string[], random: () => number): string[] {
  const order = [...nodes];
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

// One node's quote, or null (unreachable, timed out, not JSON, malformed).
async function nodeQuote(base: string, type: NodeType, fetchFn: FetchLike): Promise<PriceQuote | null> {
  try {
    const res = await fetchFn(`${base}/api/v1/activation/price?type=${type}`, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(NODE_TIMEOUT_MS),
    });
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    // At most the cap is ever held: a node that streams more (a compromised or misrouted host) costs this
    // process no memory beyond it, and its stream is cancelled.
    const bytes = await readCappedBytes(res, NODE_BODY_MAX_BYTES);
    if (!bytes) return null;
    return parseNodePrice(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), type);
  } catch {
    return null;
  }
}

export async function quoteFromNodes(type: NodeType, fetchFn: FetchLike = fetch, nodes: readonly string[] = PRICE_NODES): Promise<PriceQuote | null> {
  for (const base of shuffled(nodes, Math.random)) {
    const quote = await nodeQuote(base, type, fetchFn);
    if (quote) return quote;
  }
  return null;
}

export const sameQuote = (a: PriceQuote, b: PriceQuote): boolean => a.phase === b.phase && (a.phase === 2 || a.cost === (b as { cost: number }).cost);

// The quote two nodes give alike, for a page that burns by it (the node cabinet): asked two at a time in random
// order, then one more at a time, until two answers agree; null when none do.
export async function agreedQuote(
  type: NodeType,
  fetchFn: FetchLike = fetch,
  nodes: readonly string[] = PRICE_NODES,
  random: () => number = Math.random,
): Promise<PriceQuote | null> {
  const order = shuffled(nodes, random);
  const seen: PriceQuote[] = [];
  while (order.length > 0) {
    const wave = order.splice(0, seen.length === 0 ? 2 : 1);
    for (const quote of await Promise.all(wave.map((base) => nodeQuote(base, type, fetchFn)))) {
      if (!quote) continue;
      if (seen.some((q) => sameQuote(q, quote))) return quote;
      seen.push(quote);
    }
  }
  return null;
}
