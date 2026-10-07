// In-memory fixed-window rate limiters (one process: the site runs as a single pm2 process).
//
// A limiter holds at most `maxEntries` keys. When it is full, a new key evicts the key whose window was
// started longest ago; a new key is never refused for lack of room. Refusing would let anyone with enough
// addresses fill the store and lock every new visitor out, while eviction only hands a returning key a
// fresh window, and pushing a given key out takes `maxEntries` other keys in between.
//
// Each subsystem keeps its own limiter, so one cannot crowd out another: the explorer routes share
// `rateLimit` (keys prefixed per route), and the QNet Link relay (src/server/link-relay.ts) has its own.

import { isIP } from 'node:net';

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetTime: number;
}

export interface RateLimiter {
  limit(identifier: string, maxRequests: number, windowMs: number): RateLimitResult;
  // Drops the keys whose window has ended.
  sweep(): void;
  size(): number;
}

const SWEEP_INTERVAL_MS = 60_000;

export function createRateLimiter({ maxEntries = 50_000, now = Date.now }: { maxEntries?: number; now?: () => number } = {}): RateLimiter {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new RangeError('maxEntries must be a positive integer');
  // Insertion order is the order windows started: a key whose window restarts is moved to the end.
  const store = new Map<string, RateLimitEntry>();

  function sweep(): void {
    const t = now();
    for (const [key, entry] of store) {
      if (entry.resetTime <= t) store.delete(key);
    }
  }

  function limit(identifier: string, maxRequests: number, windowMs: number): RateLimitResult {
    const t = now();
    if (!identifier || typeof identifier !== 'string' || !Number.isInteger(maxRequests) || maxRequests < 1) {
      return { allowed: false, remaining: 0, resetTime: t + windowMs };
    }
    const entry = store.get(identifier);
    if (entry && entry.resetTime > t) {
      entry.count += 1;
      if (entry.count > maxRequests) return { allowed: false, remaining: 0, resetTime: entry.resetTime };
      return { allowed: true, remaining: maxRequests - entry.count, resetTime: entry.resetTime };
    }
    if (entry) {
      store.delete(identifier);
    } else if (store.size >= maxEntries) {
      const oldest = store.keys().next();
      if (!oldest.done) store.delete(oldest.value);
    }
    const fresh = { count: 1, resetTime: t + windowMs };
    store.set(identifier, fresh);
    return { allowed: true, remaining: maxRequests - 1, resetTime: fresh.resetTime };
  }

  return { limit, sweep, size: () => store.size };
}

// Runs a limiter's sweep every minute without keeping the process alive (unit tests import this module).
export function sweepPeriodically(limiter: RateLimiter): void {
  const timer = setInterval(() => limiter.sweep(), SWEEP_INTERVAL_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
}

// The explorer API routes' limiter, one per process on globalThis so every route bundle shares it.
const EXPLORER_KEY = Symbol.for('qnet.explorerRateLimiter');

function explorerLimiter(): RateLimiter {
  const holder = globalThis as unknown as Record<symbol, RateLimiter | undefined>;
  let limiter = holder[EXPLORER_KEY];
  if (!limiter) {
    limiter = createRateLimiter();
    sweepPeriodically(limiter);
    holder[EXPLORER_KEY] = limiter;
  }
  return limiter;
}

export function rateLimit(identifier: string, maxRequests: number, windowMs: number): RateLimitResult {
  return explorerLimiter().limit(identifier, maxRequests, windowMs);
}

// ---------------------------------------------------------------------------
// Client IP for every per-IP limit
// ---------------------------------------------------------------------------
// The app runs behind nginx on the same host (deployment/deploy-aiqnet.sh),
// which sets X-Real-IP to the address it accepted the connection from
// ($remote_addr), replacing any X-Real-IP a client sent: that is the client IP.
// X-Forwarded-For is never read as the client's: nginx appends to whatever the
// client put there, so its first entry is the client's choice, and rotating it
// would defeat every limit.
//
// A request without X-Real-IP did not pass nginx (a process on the host, or
// development), and its key is the socket address. Next.js route handlers do
// not expose the socket; Next.js records the socket address in X-Forwarded-For
// itself when the request carries none, so it is read there, as one address.
// Only a client reaching the app port could name an address in either header,
// and `npm start` binds the app to 127.0.0.1, so only processes on the host can.
// ---------------------------------------------------------------------------

// A bare IPv4 or IPv6 address, normalized (an IPv4-mapped socket address is its
// IPv4 address, IPv6 is lowercase); null for anything else, a list included.
export function normalizeIp(value: string | null): string | null {
  if (value === null) return null;
  const text = value.trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(text);
  const ip = mapped ? mapped[1] : text;
  const version = isIP(ip);
  if (version === 4) return ip;
  if (version === 6) return ip.toLowerCase();
  return null;
}

// X-Real-IP when present (a malformed one is no address, never a reason to
// look elsewhere), else the socket address.
export function resolveClientIp(request: Request): string | null {
  const realIp = request.headers.get('x-real-ip');
  if (realIp !== null) return normalizeIp(realIp);
  return normalizeIp(request.headers.get('x-forwarded-for'));
}

// The eight 16-bit groups of a valid IPv6 address (an embedded IPv4 tail is two groups).
function ipv6Groups(ip: string): number[] {
  let text = ip;
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const part = (s: string | undefined) => (s ? s.split(':').filter((g) => g !== '').map((g) => parseInt(g, 16)) : []);
  const left = part(head);
  const right = part(tail);
  const zeros = tail === undefined ? [] : new Array(8 - left.length - right.length).fill(0);
  return [...left, ...zeros, ...right];
}

// The limiter key of an address: IPv4 as is; IPv6 by its /64, the block one subscriber is given, so one
// client cannot rotate through its own addresses.
export function rateLimitKeyForIp(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  const groups = ipv6Groups(ip).slice(0, 4).map((g) => g.toString(16));
  return `${groups.join(':')}::/64`;
}

// A usable per-IP key, or a failure the endpoint answers with 503 rather than
// keying everyone under one shared bucket.
export type ClientIpResolution =
  | { ok: true; ip: string }
  | { ok: false; reason: string };

export function getRateLimitKey(request: Request): ClientIpResolution {
  const ip = resolveClientIp(request);
  if (ip) return { ok: true, ip: rateLimitKeyForIp(ip) };
  return { ok: false, reason: 'no client address (X-Real-IP or the socket address)' };
}

// Back-compat wrapper used by endpoints that key rate limiting off a plain
// string. Delegates to getRateLimitKey; without an address it returns
// 'unmetered' rather than the old always-shared 'unknown' bucket. New callers
// should prefer getRateLimitKey and honour its { ok: false } result by
// returning a 503, so misconfiguration is surfaced instead of silently pooled.
export function getClientIdentifier(request: Request): string {
  const resolution = getRateLimitKey(request);
  return resolution.ok ? resolution.ip : 'unmetered';
}
