// QNet Link relay (docs/protocols/qnet-link-v1.md sections 5 and 14.5): carries one end-to-end encrypted answer
// from the QNet app to the page that asked. It sees ephemeral public keys, the intent, the request (a burn
// transaction, a wallet hash, a flag) and ciphertext; never an address or a secret. Sessions live in this
// process's memory only (one pm2 process), bounded in number, per creating address and in time. Nothing a
// request carries is logged.

import {
  createRateLimiter,
  getRateLimitKey,
  sweepPeriodically,
  type ClientIpResolution,
  type RateLimitResult,
  type RateLimiter,
} from '../../lib/rate-limit.ts';
import { isJsonRequest, originAllowed, readBody } from './request-guard.ts';
import { phoneFlowsEnabled } from './phone-flows.ts';
import {
  CAPS,
  INTENTS,
  SESSION_BODY_MAX_BYTES,
  SESSION_TTL_S,
  isSessionId,
  validateResponseRequest,
  validateSessionRequest,
  type LinkIntent,
  type LinkRequest,
  type RelayAnswerBody,
} from '../lib/qnet-link.ts';

// A session with its answer is under 2 KB (a `link` or `reserve` one under 16 KB, and those are capped apart), so the full
// store stays under 300 MB. Every session in the store holds a place of the address that created it until it is
// dropped, so filling the store takes MAX_SESSIONS / MAX_LIVE_PER_IP addresses at once, whatever LIMITS.create
// allows one address over time (SITE-R1-01).
export const MAX_SESSIONS = 100_000;
// Live sessions one address may hold. A page makes one per request and a new one after a failure, and
// sessions end after SESSION_TTL_S, so this leaves room for many people behind one carrier NAT address. A session
// whose page read the answer ends READ_GRACE_S later, and one its page released ends at once (SITE-8), so a finished
// request gives its address's place back within that grace instead of holding it until the TTL.
export const MAX_LIVE_PER_IP = 60;
// `link` and `reserve` sessions carry an answer up to 12 KB: at most this many live, and this many per address, the same
// way.
export const MAX_LINK_SESSIONS = 5_000;
export const MAX_LINK_PER_IP = 10;
// The intents whose answer carries an ML-DSA-65 key and signature: capped apart (MAX_LINK_SESSIONS).
const LARGE: ReadonlySet<LinkIntent> = new Set<LinkIntent>(['link', 'reserve']);
// After the creating address read the answer, the session stays this long for the app's retry of a POST whose reply
// was lost (the app retries after 2, 4, 8, 16 and 30 s), then ends.
export const READ_GRACE_S = 120;
// The relay's own limiter store: the explorer's traffic never takes its room.
export const LIMITER_ENTRIES = 100_000;
const PURGE_INTERVAL_MS = 60_000;
// Per address and route. Carrier NAT puts many phones, and office NAT many computers, behind one address;
// nginx already caps each address at 10 requests a second for /api/link/, in a zone of the relay's own. A
// page polls every 2 s (30 a minute). Only requests that pass the origin checks are counted (gate).
export const LIMITS = {
  create: { max: 120, windowMs: 10 * 60_000 },
  session: { max: 120, windowMs: 60_000 },
  answer: { max: 60, windowMs: 60_000 },
  poll: { max: 600, windowMs: 60_000 },
  release: { max: 120, windowMs: 60_000 },
} as const;
type Route = keyof typeof LIMITS;

interface StoredSession {
  sitePub: string;
  intent: LinkIntent;
  // Null for `connect`.
  request: LinkRequest | null;
  reqHash: string | null;
  createdAt: number;
  // The limiter key of the address that created it, for the per-address caps; memory only, never sent.
  owner: string;
  response: RelayAnswerBody | null;
  // When the creating address first read the answer; the session ends READ_GRACE_S later. Null before.
  readAt: number | null;
}

export interface LinkRelayOptions {
  now?: () => number;
  maxSessions?: number;
  maxLivePerIp?: number;
  maxLinkSessions?: number;
  maxLinkPerIp?: number;
  clientKey?: (request: Request) => ClientIpResolution;
  limit?: (identifier: string, maxRequests: number, windowMs: number) => RateLimitResult;
  // Rate-limit key prefix; tests give each relay its own.
  scope?: string;
  // Accept http://localhost and http://127.0.0.1 origins from any host (development builds).
  devOrigins?: boolean;
  // The intents it opens sessions for; another is refused (404 not_available). All by default.
  intents?: readonly LinkIntent[];
}

export interface LinkRelay {
  createSession(request: Request): Promise<Response>;
  getSession(request: Request, id: string): Promise<Response>;
  postAnswer(request: Request, id: string): Promise<Response>;
  getAnswer(request: Request, id: string): Promise<Response>;
  releaseSession(request: Request, id: string): Promise<Response>;
  purge(): void;
  size(): number;
  liveFor(owner: string): number;
  linkLiveFor(owner: string): number;
}

const HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...HEADERS, 'Content-Type': 'application/json', ...extra } });
}

const fail = (status: number, error: string, extra?: Record<string, string>): Response => json(status, { error }, extra);

function countDown(map: Map<string, number>, key: string): void {
  const n = (map.get(key) ?? 1) - 1;
  if (n > 0) map.set(key, n);
  else map.delete(key);
}

export function createLinkRelay(options: LinkRelayOptions = {}): LinkRelay {
  const now = options.now ?? Date.now;
  const maxSessions = options.maxSessions ?? MAX_SESSIONS;
  const maxLivePerIp = options.maxLivePerIp ?? MAX_LIVE_PER_IP;
  const maxLinkSessions = options.maxLinkSessions ?? MAX_LINK_SESSIONS;
  const maxLinkPerIp = options.maxLinkPerIp ?? MAX_LINK_PER_IP;
  const clientKey = options.clientKey ?? getRateLimitKey;
  let limiter: RateLimiter | null = null;
  const limit = options.limit ?? ((id: string, max: number, windowMs: number) => {
    if (!limiter) {
      limiter = createRateLimiter({ maxEntries: LIMITER_ENTRIES, now });
      sweepPeriodically(limiter);
    }
    return limiter.limit(id, max, windowMs);
  });
  const scope = options.scope ?? 'link';
  const devOrigins = options.devOrigins ?? process.env.NODE_ENV !== 'production';
  const intents = options.intents ?? INTENTS;
  const sessions = new Map<string, StoredSession>();
  // The sessions whose answer their address read, in the order it was read; they share one grace.
  const read = new Map<StoredSession, string>();
  const liveByOwner = new Map<string, number>();
  const linkByOwner = new Map<string, number>();
  let linkLive = 0;
  let warnedNoIp = false;

  const ttlEnd = (s: StoredSession) => s.createdAt + SESSION_TTL_S * 1000;
  const graceEnd = (s: StoredSession) => (s.readAt === null ? Infinity : s.readAt + READ_GRACE_S * 1000);
  const expiresAt = (s: StoredSession) => Math.min(ttlEnd(s), graceEnd(s));

  // The only way out of the store: the session gives its address's place and its store places back together.
  function drop(id: string, s: StoredSession): void {
    if (sessions.get(id) === s) sessions.delete(id);
    read.delete(s);
    countDown(liveByOwner, s.owner);
    if (LARGE.has(s.intent)) {
      countDown(linkByOwner, s.owner);
      linkLive -= 1;
    }
  }

  // Sessions are kept in creation order and share one TTL, and read ones in read order with one grace, so the
  // expired ones of each are a prefix.
  function purge(): void {
    const t = now();
    for (const [id, s] of sessions) {
      if (ttlEnd(s) > t) break;
      drop(id, s);
    }
    for (const [s, id] of read) {
      if (graceEnd(s) > t) break;
      drop(id, s);
    }
  }

  function live(id: string): StoredSession | null {
    purge();
    const s = sessions.get(id);
    if (!s) return null;
    if (expiresAt(s) <= now()) {
      drop(id, s);
      return null;
    }
    return s;
  }

  // The request's gate: origin, then the per-IP limit of its route. Returns the client's key to go on. The
  // origin check comes first, so a request another page makes from a visitor's browser (a GET by <img> or
  // a frame has no Origin, but has Sec-Fetch-Site) never spends that visitor's limits (R4-SRA-01).
  function gate(request: Request, route: Route): Response | { key: string } {
    if (!originAllowed(request, devOrigins)) return fail(403, 'forbidden_origin');
    const key = clientKey(request);
    if (!key.ok) {
      if (!warnedNoIp) {
        warnedNoIp = true;
        console.warn('[WARN][LINK] relay_unavailable reason=no_client_ip');
      }
      return fail(503, 'unavailable');
    }
    const { max, windowMs } = LIMITS[route];
    const result = limit(`${scope}:${route}:${key.ip}`, max, windowMs);
    if (result.allowed) return { key: key.ip };
    const retryAfter = Math.max(1, Math.ceil((result.resetTime - now()) / 1000));
    return fail(429, 'rate_limited', { 'Retry-After': String(retryAfter) });
  }

  async function readJson(request: Request, max: number): Promise<string | Response> {
    if (!isJsonRequest(request)) return fail(415, 'unsupported_media_type');
    const text = await readBody(request, max);
    if (text === 413) return fail(413, 'payload_too_large');
    if (text === 400) return fail(400, 'invalid_request');
    return text;
  }

  return {
    // POST /api/link/sessions (the site)
    async createSession(request) {
      const gated = gate(request, 'create');
      if (gated instanceof Response) return gated;
      const text = await readJson(request, SESSION_BODY_MAX_BYTES);
      if (typeof text !== 'string') return text;
      const body = validateSessionRequest(text);
      if (!body) return fail(400, 'invalid_request');
      if (!intents.includes(body.intent)) return fail(404, 'not_available');
      if (live(body.id)) return fail(409, 'conflict');
      const owned = liveByOwner.get(gated.key) ?? 0;
      const ownedLinks = linkByOwner.get(gated.key) ?? 0;
      const isLink = LARGE.has(body.intent);
      // At a cap, this address's oldest session ends within the TTL; the hint is a minute.
      if (owned >= maxLivePerIp || (isLink && ownedLinks >= maxLinkPerIp)) return fail(429, 'rate_limited', { 'Retry-After': '60' });
      if (sessions.size >= maxSessions || (isLink && linkLive >= maxLinkSessions)) return fail(503, 'unavailable');
      sessions.set(body.id, {
        sitePub: body.sitePub,
        intent: body.intent,
        request: body.request ?? null,
        reqHash: body.reqHash ?? null,
        createdAt: now(),
        owner: gated.key,
        response: null,
        readAt: null,
      });
      liveByOwner.set(gated.key, owned + 1);
      if (isLink) {
        linkLive += 1;
        linkByOwner.set(gated.key, ownedLinks + 1);
      }
      return json(201, { expiresIn: SESSION_TTL_S });
    },

    // GET /api/link/sessions/:id (the app)
    async getSession(request, id) {
      const gated = gate(request, 'session');
      if (gated instanceof Response) return gated;
      if (!isSessionId(id)) return fail(400, 'invalid_request');
      const s = live(id);
      if (!s) return fail(404, 'not_found');
      const expiresIn = Math.max(0, Math.floor((expiresAt(s) - now()) / 1000));
      return json(200, {
        id,
        sitePub: s.sitePub,
        intent: s.intent,
        ...(s.request === null ? {} : { request: s.request, reqHash: s.reqHash }),
        answered: s.response !== null,
        expiresIn,
      });
    },

    // POST /api/link/sessions/:id/response (the app): the first answer wins; the same bytes again
    // are a retry after a lost reply. The caps are the session's intent's.
    async postAnswer(request, id) {
      const gated = gate(request, 'answer');
      if (gated instanceof Response) return gated;
      if (!isSessionId(id)) return fail(400, 'invalid_request');
      if (!isJsonRequest(request)) return fail(415, 'unsupported_media_type');
      const found = live(id);
      if (!found) return fail(404, 'not_found');
      const text = await readJson(request, CAPS[found.intent].body);
      if (typeof text !== 'string') return text;
      const body = validateResponseRequest(text, found.intent);
      if (!body) return fail(400, 'invalid_request');
      // The session may have ended while the body was read.
      const s = live(id);
      if (!s) return fail(404, 'not_found');
      if (s.response === null) {
        s.response = body;
        return json(201, { ok: true });
      }
      const same = s.response.appPub === body.appPub && s.response.iv === body.iv && s.response.ct === body.ct;
      return same ? json(200, { ok: true }) : fail(409, 'conflict');
    },

    // GET /api/link/sessions/:id/response (the site's poll)
    async getAnswer(request, id) {
      const gated = gate(request, 'poll');
      if (gated instanceof Response) return gated;
      if (!isSessionId(id)) return fail(400, 'invalid_request');
      const s = live(id);
      if (!s) return fail(404, 'not_found');
      if (s.response === null) return new Response(null, { status: 204, headers: HEADERS });
      // Read by the address that asked: the session stays READ_GRACE_S more for the app's retry, then ends and gives its
      // places back. It holds its address's place until then, so reading answers never lets one address hold more.
      if (gated.key === s.owner && s.readAt === null) {
        s.readAt = now();
        read.set(s, id);
      }
      return json(200, s.response);
    },

    // DELETE /api/link/sessions/:id (the site): the page that made the session ends it (cancelled, or replaced by a
    // new request). Only its own address may, and any other gets the answer an unknown id gets.
    async releaseSession(request, id) {
      const gated = gate(request, 'release');
      if (gated instanceof Response) return gated;
      if (!isSessionId(id)) return fail(400, 'invalid_request');
      const s = live(id);
      if (!s || s.owner !== gated.key) return fail(404, 'not_found');
      drop(id, s);
      return new Response(null, { status: 204, headers: HEADERS });
    },

    purge,
    size: () => sessions.size,
    liveFor: (owner) => liveByOwner.get(owner) ?? 0,
    linkLiveFor: (owner) => linkByOwner.get(owner) ?? 0,
  };
}

// The process's relay, on globalThis so every route bundle shares one store, with an unref'd sweep. It opens `link`,
// `claim` and `reserve` sessions only while the cabinet's phone flows are on (phone-flows.ts).
const GLOBAL_KEY = Symbol.for('qnet.linkRelay');

export function linkRelay(): LinkRelay {
  const holder = globalThis as unknown as Record<symbol, LinkRelay | undefined>;
  let relay = holder[GLOBAL_KEY];
  if (!relay) {
    const created = createLinkRelay({ intents: phoneFlowsEnabled() ? INTENTS : ['connect'] });
    const sweep = setInterval(() => created.purge(), PURGE_INTERVAL_MS);
    (sweep as unknown as { unref?: () => void }).unref?.();
    holder[GLOBAL_KEY] = created;
    relay = created;
  }
  return relay;
}
