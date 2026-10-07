// The faucet pass (SITE M-13): the node cabinet asks for one for the QNet wallet it activates, with the wallet's signed
// reservation of its payment address (shared contract C1, the record's hold), and the /testnet faucet keeps most of each
// hour's claims for claims that carry one (src/server/faucet-guard.ts): one claim of each token per wallet a day. A pass
// is the wallet and the time it ends, with an HMAC of both under the server's FAUCET_PASS_KEY (32 bytes or more in hex,
// set in .env.local; without it a key of this process, and a restart ends the passes it gave). The server keeps no list
// of the passes it gave. A QNet wallet costs nothing, so a signed reservation is no scarce thing: what makes a pass
// scarce is the few each client IP and each network block get an hour. POST /api/faucet/pass: exactly
// {wallet, burner, proof}.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { rateLimit, type ClientIpResolution, type RateLimitResult } from '../../lib/rate-limit.ts';
import { verifyReservationProof } from '../lib/cabinet/burn-record.ts';
import { FAUCET_PASS_RE } from '../lib/faucet-handover.ts';
import { isEonAddress, isSolanaAddress } from '../lib/qnet-provider.ts';
import { networkOf } from './faucet-guard.ts';
import { readJsonPost } from './request-guard.ts';

// A pass is good this long after it was given: the page asks for it when it shows the payment address.
export const FAUCET_PASS_TTL_S = 3_600;
// Requests per client IP (IPv6 by its /64): each one is a signature to check.
export const FAUCET_PASS_PER_IP = { max: 10, windowMs: 10 * 60 * 1000 } as const;
// Passes given an hour per client IP and per network block (an IPv4 /24, an IPv6 /48), counted once the reservation
// verified: with throwaway wallets, a few addresses could otherwise take every place the faucet keeps for passes.
export const FAUCET_PASSES_PER_IP = { max: 3, windowMs: 60 * 60 * 1000 } as const;
export const FAUCET_PASSES_PER_NETWORK = { max: 10, windowMs: 60 * 60 * 1000 } as const;
const PASS_CONTEXT = 'qnet.faucet.pass.v1:';
// Two base64url ML-DSA-65 values and the rest: about 7.4 KB.
const PASS_BODY_MAX_BYTES = 12 * 1024;

export function faucetPassKey(configured: string | undefined = process.env.FAUCET_PASS_KEY): Buffer {
  return typeof configured === 'string' && /^(?:[0-9a-fA-F]{2}){32,}$/.test(configured) ? Buffer.from(configured, 'hex') : randomBytes(32);
}

// The process's key, on globalThis so the pass route and the claim route share it (a key of the process included).
const KEY_HOLDER = Symbol.for('qnet.faucetPassKey');

export function sharedFaucetPassKey(): Buffer {
  const holder = globalThis as unknown as Record<symbol, Buffer | undefined>;
  const existing = holder[KEY_HOLDER];
  if (existing) return existing;
  const created = faucetPassKey();
  holder[KEY_HOLDER] = created;
  return created;
}

const macOf = (key: Uint8Array, wallet: string, until: number): string =>
  createHmac('sha256', key).update(`${PASS_CONTEXT}${wallet}:${until}`).digest().subarray(0, 16).toString('base64url');

// A pass for `wallet` from `nowMs`, ending FAUCET_PASS_TTL_S later.
export function mintFaucetPass(key: Uint8Array, wallet: string, nowMs: number): { pass: string; until: number } {
  const until = Math.floor(nowMs / 1000) + FAUCET_PASS_TTL_S;
  return { pass: `${wallet}.${until}.${macOf(key, wallet, until)}`, until };
}

// The wallet a pass was given for, while it has not ended; null for anything else.
export function checkFaucetPass(key: Uint8Array, pass: unknown, nowMs: number): string | null {
  if (typeof pass !== 'string') return null;
  const m = FAUCET_PASS_RE.exec(pass);
  if (!m) return null;
  const [, wallet, untilText, mac] = m;
  const until = Number(untilText);
  const nowS = Math.floor(nowMs / 1000);
  if (!isEonAddress(wallet) || !Number.isSafeInteger(until) || until <= nowS || until > nowS + FAUCET_PASS_TTL_S) return null;
  const expected = Buffer.from(macOf(key, wallet, until));
  const given = Buffer.from(mac);
  return expected.length === given.length && timingSafeEqual(expected, given) ? wallet : null;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const exactKeys = (v: unknown, keys: readonly string[]): v is Record<string, unknown> =>
  isObject(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(v, k));

export interface FaucetPassRouteOptions {
  now?: () => number;
  key?: Uint8Array;
  limit?: (identifier: string, maxRequests: number, windowMs: number) => RateLimitResult;
  clientKey: (request: Request) => ClientIpResolution;
  // Off testnet the faucet sends nothing, and gives no pass either.
  testnet: () => boolean;
  devOrigins?: boolean;
}

const answer = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

// The route: the body, the network, the client's limit, then the wallet's signed reservation of a payment address's
// light burn (its key is the wallet's, it signed these very fields, and its time is within the payment way's window),
// then the passes the client and its network block were given this hour.
export function createFaucetPassRoute(options: FaucetPassRouteOptions): (request: Request) => Promise<Response> {
  const now = options.now ?? Date.now;
  const key = options.key ?? sharedFaucetPassKey();
  const limit = options.limit ?? rateLimit;
  const refused = (result: RateLimitResult): Response => {
    const retryAfterS = Math.max(1, Math.ceil((result.resetTime - now()) / 1000));
    return answer(429, { error: 'rate_limited', retryAfterS }, { 'Retry-After': String(retryAfterS) });
  };
  return async (request) => {
    const read = await readJsonPost(request, PASS_BODY_MAX_BYTES, options.devOrigins);
    if (!read.ok) return answer(read.status, { error: read.error });
    if (!options.testnet()) return answer(404, { error: 'not_found' });
    const client = options.clientKey(request);
    if (!client.ok) return answer(503, { error: 'unavailable' });
    const limited = limit(`faucet-pass:${client.ip}`, FAUCET_PASS_PER_IP.max, FAUCET_PASS_PER_IP.windowMs);
    if (!limited.allowed) return refused(limited);
    const b = read.value;
    if (!exactKeys(b, ['wallet', 'burner', 'proof']) || !isEonAddress(b.wallet) || !isSolanaAddress(b.burner)) return answer(400, { error: 'invalid_request' });
    const checked = verifyReservationProof({ wallet: b.wallet, nodeType: 'light', way: 'payment', burner: b.burner }, b.proof, Math.floor(now() / 1000));
    if (checked !== 'ok') return answer(400, { error: checked === 'stale' ? 'stale_proof' : 'invalid_proof' });
    const perIp = limit(`faucet-pass-given:${client.ip}`, FAUCET_PASSES_PER_IP.max, FAUCET_PASSES_PER_IP.windowMs);
    if (!perIp.allowed) return refused(perIp);
    const perNetwork = limit(`faucet-pass-given:${networkOf(client.ip)}`, FAUCET_PASSES_PER_NETWORK.max, FAUCET_PASSES_PER_NETWORK.windowMs);
    if (!perNetwork.allowed) return refused(perNetwork);
    return answer(200, mintFaucetPass(key, b.wallet, now()));
  };
}
