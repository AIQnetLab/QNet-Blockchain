import { quoteFromNodes, sitePriceBody, type PriceQuote } from '@/lib/activation-price';
import type { NodeType } from '@/lib/qnet-link';

// GET /api/activation/price?type=light|super: the nodes' current activation price for the extension's path on
// /node/activate (the page's CSP lets it call only this origin). A quote is reused for a few seconds and concurrent
// misses share one upstream round, so the route cannot be used to flood the nodes. The wallets fetch
// the price again themselves before they burn.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CACHE_MS = 15_000;
const cache = new Map<NodeType, { at: number; quote: PriceQuote }>();
const inFlight = new Map<NodeType, Promise<PriceQuote | null>>();

const HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Type': 'application/json' };

function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}

async function quote(type: NodeType): Promise<PriceQuote | null> {
  const hit = cache.get(type);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.quote;
  let pending = inFlight.get(type);
  if (!pending) {
    pending = quoteFromNodes(type).finally(() => inFlight.delete(type));
    inFlight.set(type, pending);
  }
  const fresh = await pending;
  if (fresh) cache.set(type, { at: Date.now(), quote: fresh });
  return fresh;
}

export async function GET(request: Request): Promise<Response> {
  const type = new URL(request.url).searchParams.get('type');
  if (type !== 'light' && type !== 'super') return answer(400, { error: 'invalid_request' });
  const q = await quote(type);
  return q ? answer(200, sitePriceBody(type, q)) : answer(503, { error: 'unavailable' });
}
