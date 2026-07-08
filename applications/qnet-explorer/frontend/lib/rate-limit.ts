// Simple in-memory rate limiter
// For production, use Redis-based rate limiting

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();
const MAX_STORE_SIZE = 10000; // Maximum entries to prevent memory leak

// Clean up old entries every 1 minute (more frequent cleanup)
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, entry] of rateLimitStore.entries()) {
    if (entry.resetTime < now) {
      rateLimitStore.delete(key);
      cleaned++;
    }
  }
  // If store is still too large, remove oldest entries
  if (rateLimitStore.size > MAX_STORE_SIZE) {
    const entries = Array.from(rateLimitStore.entries())
      .sort((a, b) => a[1].resetTime - b[1].resetTime);
    const toRemove = rateLimitStore.size - MAX_STORE_SIZE;
    for (let i = 0; i < toRemove; i++) {
      rateLimitStore.delete(entries[i][0]);
    }
  }
}, 60 * 1000); // 1 minute

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetTime: number;
}

export function rateLimit(
  identifier: string,
  maxRequests: number,
  windowMs: number
): RateLimitResult {
  // Validate inputs
  if (!identifier || typeof identifier !== 'string') {
    return { allowed: false, remaining: 0, resetTime: Date.now() + windowMs };
  }
  if (!Number.isInteger(maxRequests) || maxRequests < 1) {
    return { allowed: false, remaining: 0, resetTime: Date.now() + windowMs };
  }
  
  // Prevent memory leak: limit store size
  if (rateLimitStore.size >= MAX_STORE_SIZE && !rateLimitStore.has(identifier)) {
    // Store is full and this is a new identifier - reject to prevent memory leak
    return { allowed: false, remaining: 0, resetTime: Date.now() + windowMs };
  }
  
  const now = Date.now();
  const key = identifier;
  
  let entry = rateLimitStore.get(key);
  
  if (!entry || entry.resetTime < now) {
    // Create new window
    entry = {
      count: 1,
      resetTime: now + windowMs
    };
    rateLimitStore.set(key, entry);
    return {
      allowed: true,
      remaining: maxRequests - 1,
      resetTime: entry.resetTime
    };
  }
  
  // Increment count
  entry.count++;
  
  if (entry.count > maxRequests) {
    return {
      allowed: false,
      remaining: 0,
      resetTime: entry.resetTime
    };
  }
  
  rateLimitStore.set(key, entry);
  return {
    allowed: true,
    remaining: maxRequests - entry.count,
    resetTime: entry.resetTime
  };
}

// ---------------------------------------------------------------------------
// Shared client-IP derivation
// ---------------------------------------------------------------------------
// Next.js 15 App Router route handlers do NOT expose the socket address on the
// request object (`request.ip` was removed upstream), so the client IP can only
// be recovered from proxy-supplied headers (x-forwarded-for / x-real-ip).
//
// Those headers are forgeable, so they are trusted ONLY when the deployment
// opts in via a trusted-proxy flag (RATE_LIMIT_TRUSTED_PROXY=1, or the legacy
// FAUCET_TRUSTED_PROXY=1) — set by the edge operator who controls and
// normalises the header chain. An attacker who could rotate x-forwarded-for
// would otherwise defeat every per-IP limit.
//
// When no trusted proxy is configured there is no reliable per-request IP:
//   - On mainnet/production we FAIL CLOSED: `resolveClientIp` returns null so
//     the caller can refuse to serve rather than silently collapsing every
//     caller into one shared 'unknown' bucket (which both disables per-IP abuse
//     protection AND self-DoSes the whole network once any N requests land).
//   - On testnet/dev we degrade gracefully to a fixed dev value so local
//     testing keeps working.
// ---------------------------------------------------------------------------

const isValidIp = (ip: string): boolean =>
  /^[0-9a-fA-F:.]+$/.test(ip) && ip.length > 0 && ip.length <= 45;

// True when the deployment operator has asserted a trusted reverse proxy is in
// front of this handler (so x-forwarded-for / x-real-ip can be believed).
export function isTrustedProxy(): boolean {
  return (
    process.env.RATE_LIMIT_TRUSTED_PROXY === '1' ||
    process.env.FAUCET_TRUSTED_PROXY === '1'
  );
}

// True when this deployment must apply strict (production) rules. Mainnet is
// derived from the same server-side env the rest of the frontend uses; it is
// fixed at build/deploy time and cannot be influenced per request.
export function isMainnet(): boolean {
  const net = (process.env.FAUCET_ENV || process.env.NEXT_PUBLIC_NETWORK || '').toLowerCase();
  if (net === 'testnet' || net === 'dev' || net === 'development') return false;
  if (net === 'mainnet') return true;
  // Unset network → treat a production build as mainnet (safer default),
  // otherwise as dev.
  return process.env.NODE_ENV === 'production';
}

// Derive the real client IP from trusted proxy headers.
// Returns the first hop of x-forwarded-for (the original client) or x-real-ip
// when a trusted proxy is configured; returns null otherwise (no reliable IP).
export function resolveClientIp(request: Request): string | null {
  if (isTrustedProxy()) {
    const forwarded = request.headers.get('x-forwarded-for');
    if (forwarded) {
      const firstIp = forwarded.split(',')[0].trim();
      if (isValidIp(firstIp)) return firstIp;
    }
    const realIp = request.headers.get('x-real-ip');
    if (realIp && isValidIp(realIp.trim())) return realIp.trim();
  }
  return null;
}

// Result of client-IP derivation for a rate-limited endpoint.
//   - ok:    a usable per-IP key (real IP, or a dev fallback on testnet)
//   - fail:  mainnet is misconfigured (no trusted proxy / IP source) and the
//            endpoint MUST refuse to serve rather than key everyone under one
//            shared bucket.
export type ClientIpResolution =
  | { ok: true; ip: string }
  | { ok: false; reason: string };

// Resolve a per-IP rate-limit key, failing closed on mainnet when no IP source
// is configured. On testnet/dev, falls back to a fixed dev key so local runs
// still exercise the limiter deterministically.
export function getRateLimitKey(request: Request): ClientIpResolution {
  const ip = resolveClientIp(request);
  if (ip) return { ok: true, ip };

  if (isMainnet()) {
    return {
      ok: false,
      reason:
        'Per-IP rate limiting is misconfigured: no trusted proxy is set. ' +
        'Set RATE_LIMIT_TRUSTED_PROXY=1 (behind a reverse proxy that provides ' +
        'x-forwarded-for) so the client IP can be derived on mainnet.',
    };
  }

  // testnet / dev — degrade gracefully so local testing keeps working.
  return { ok: true, ip: 'dev-local' };
}

// Back-compat wrapper used by endpoints that key rate limiting off a plain
// string. Delegates to getRateLimitKey; on a fail-closed mainnet result it
// returns 'unmetered' rather than the old always-shared 'unknown' bucket. New
// callers should prefer getRateLimitKey and honour its { ok: false } result by
// returning a 503, so misconfiguration is surfaced instead of silently pooled.
export function getClientIdentifier(request: Request): string {
  const resolution = getRateLimitKey(request);
  return resolution.ok ? resolution.ip : 'unmetered';
}

