import { NextRequest } from 'next/server';
import { getRateLimitKey, rateLimit } from '../../../../../../lib/rate-limit';
import { fetchNode } from '@/lib/node-api';
import { sanitizeLogo } from '@/lib/sanitize-logo';
import { CONTRACT_RE, createLogoService, type LogoSource } from '@/server/logo-proxy';

export const dynamic = 'force-dynamic';

// GET /api/token/:contract/logo — the token's on-chain logo, fetched by this server and served from
// aiqnet.io, so a visitor's browser never contacts the host the deployer chose (src/server/logo-proxy.ts).
// 404 when the token has no usable logo (the page then draws its generated icon).

const RATE_LIMIT_MAX = 600;
const RATE_LIMIT_WINDOW = 60 * 1000;

// The logo the nodes report for the contract, the same value the token route shows.
const nodeLogo: LogoSource = async (contract) => {
  const res = await fetchNode(`/api/v1/token/${encodeURIComponent(contract)}`, { timeoutMs: 5_000 });
  if (!res) return 'unavailable';
  if (!res.ok) return res.status === 404 || res.status === 400 ? null : 'unavailable';
  const body = (await res.json().catch(() => null)) as { success?: unknown; token?: { logo?: unknown } } | null;
  if (!body || body.success !== true || !body.token) return null;
  const logo = sanitizeLogo(body.token.logo);
  return logo.startsWith('https://') ? logo : null;
};

// One service per process on globalThis, so every bundle shares its memory.
const SERVICE_KEY = Symbol.for('qnet.logoService');
type LogoService = ReturnType<typeof createLogoService>;

function logoService(): LogoService {
  const holder = globalThis as unknown as Record<symbol, LogoService | undefined>;
  let service = holder[SERVICE_KEY];
  if (!service) {
    service = createLogoService({ source: nodeLogo });
    holder[SERVICE_KEY] = service;
  }
  return service;
}

const plain = (status: number, headers: Record<string, string> = {}) =>
  new Response(null, { status, headers: { 'Cache-Control': 'no-store', ...headers } });

export async function GET(request: NextRequest, { params }: { params: Promise<{ contract: string }> }) {
  const { contract } = await params;
  if (typeof contract !== 'string' || !CONTRACT_RE.test(contract)) return plain(400);

  const ip = getRateLimitKey(request);
  if (!ip.ok) return plain(503);
  const rl = rateLimit(`logo:${ip.ip}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW);
  if (!rl.allowed) return plain(429, { 'Retry-After': String(Math.max(1, Math.ceil((rl.resetTime - Date.now()) / 1000))) });

  const result = await logoService().get(contract);
  if (result.kind === 'busy') return plain(503, { 'Retry-After': '30' });
  if (result.kind === 'none') return new Response(null, { status: 404, headers: { 'Cache-Control': 'public, max-age=600' } });
  return new Response(Buffer.from(result.logo.body), {
    status: 200,
    headers: {
      'Content-Type': result.logo.type,
      'Content-Length': String(result.logo.body.length),
      'Cache-Control': 'public, max-age=86400',
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
  });
}
