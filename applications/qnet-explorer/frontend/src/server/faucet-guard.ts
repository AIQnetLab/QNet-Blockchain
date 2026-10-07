// The admission of a claim on the /testnet faucet (src/app/api/faucet/claim/route.ts), the same on every network: one
// claim of each token per address a day, windows of each token per client IP and per network block (an IPv4 /24, an
// IPv6 /48), and an hourly budget per token for everyone. The budget caps what this faucet can move out of the faucet
// wallet in an hour, so it never crowds the shared Solana client's send lane (SITE-R1-02). Most of it is kept for claims
// that carry a faucet pass (src/server/faucet-pass.ts: the node cabinet asks for one with the QNet wallet's signed
// reservation, a few a client and a network block an hour), each wallet one claim of each token a day, so that a few
// addresses scripting claims at the start of an hour cannot shut the faucet to the people activating a node (SITE M-13).
// The places kept for passes are kept pro rata through the hour: those that claims with a pass have not taken by their
// share of the hour so far open to any claim, so the hour is not left unused while no one activates, and a claim with a
// pass later in the hour still finds its part. A claim with a pass may take any free place. A claim's places are taken
// before its transfer is sent and given back only when it cannot land. A refusal names when to try again.

import { rateLimit, type ClientIpResolution, type RateLimitResult } from '../../lib/rate-limit.ts';
import { createFaucetBudget, type FaucetBudget } from './faucet-budget.ts';
import { createFaucetCooldowns, sweepCooldownsPeriodically, type FaucetCooldowns } from './faucet-cooldown.ts';

// One claim of each token per address a day, and per wallet with a pass (the privacy policy states it).
export const LEGACY_COOLDOWN_MS = 24 * 60 * 60 * 1000;
// Per client IP (nginx's X-Real-IP, IPv6 by its /64), each token apart: a claim is a pair (1DEV and SOL), so five
// people an hour.
export const LEGACY_PER_IP = { max: 5, windowMs: 60 * 60 * 1000 } as const;
// Per network block, each token apart: a few households or an office behind one block.
export const PER_NETWORK = { max: 15, windowMs: 60 * 60 * 1000 } as const;
// Claims of each token an hour, for everyone: at most 45,000 1DEV and, with the testnet's 0.01 SOL a claim, 0.3 SOL.
export const LEGACY_HOURLY: Readonly<Record<string, number>> = Object.freeze({ '1DEV': 30, SOL: 30 });
// The share of each hour's claims kept for claims with a faucet pass at its start, pro rata through the hour; the rest is
// open to any claim.
export const PASS_SHARE = 0.8;
const HOUR_MS = 60 * 60 * 1000;

export type Admission =
  | { ok: true; release: () => void }
  | { ok: false; status: 429 | 503; error: string; nextClaimTime?: number; retryAfterS?: number };

export interface LegacyFaucetGuard {
  // `wallet`: the QNet wallet of the claim's faucet pass, checked by the route; null without one.
  admit(address: string, token: string, client: ClientIpResolution, wallet?: string | null): Admission;
}

export interface LegacyFaucetGuardOptions {
  now?: () => number;
  cooldowns?: FaucetCooldowns;
  limit?: (identifier: string, maxRequests: number, windowMs: number) => RateLimitResult;
  hourly?: Readonly<Record<string, number>>;
}

// A token's hour: one budget of places for every claim, its size, the places kept for claims with a pass at the start
// of the hour, and how many claims with a pass took a place in `window`.
interface TokenHour {
  budget: FaucetBudget;
  total: number;
  pass: number;
  window: number;
  passTaken: number;
}

// The places of a token's hour kept for claims with a pass at its start, and those open to any claim (at least one).
export function passPlaces(total: number): { pass: number; open: number } {
  const pass = Math.min(Math.floor(total * PASS_SHARE), Math.max(0, total - 1));
  return { pass, open: total - pass };
}

// The network block of a client key (rate-limit.ts rateLimitKeyForIp): an IPv4 /24, an IPv6 /48.
export function networkOf(ip: string): string {
  const v4 = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/.exec(ip);
  if (v4) return `${v4[1]}.0/24`;
  return `${ip.split(':').slice(0, 3).join(':')}::/48`;
}

export function createLegacyFaucetGuard(options: LegacyFaucetGuardOptions = {}): LegacyFaucetGuard {
  const now = options.now ?? Date.now;
  const limit = options.limit ?? rateLimit;
  const hourly = options.hourly ?? LEGACY_HOURLY;
  let cooldowns = options.cooldowns ?? null;
  const cooldownStore = (): FaucetCooldowns => {
    if (!cooldowns) {
      cooldowns = createFaucetCooldowns({ cooldownMs: LEGACY_COOLDOWN_MS, now });
      sweepCooldownsPeriodically(cooldowns);
    }
    return cooldowns;
  };
  const hours = new Map<string, TokenHour>();
  const hourOf = (token: string): TokenHour | null => {
    const max = Object.prototype.hasOwnProperty.call(hourly, token) ? hourly[token] : undefined;
    if (max === undefined) return null;
    let h = hours.get(token);
    if (!h) {
      h = { budget: createFaucetBudget({ max, windowMs: HOUR_MS, now }), total: max, pass: passPlaces(max).pass, window: -1, passTaken: 0 };
      hours.set(token, h);
    }
    return h;
  };
  // The hour a token's count of claims with a pass belongs to (the budget's own windows).
  const sync = (h: TokenHour): number => {
    const w = Math.floor(now() / HOUR_MS);
    if (h.window !== w) {
      h.window = w;
      h.passTaken = 0;
    }
    return w;
  };
  // The places still kept for claims with a pass now: their share of the rest of the hour, no more than they have not
  // taken yet.
  const kept = (h: TokenHour): number => {
    const left = ((sync(h) + 1) * HOUR_MS - now()) / HOUR_MS;
    return Math.max(0, Math.min(h.pass - h.passTaken, Math.ceil(h.pass * left)));
  };
  // When a claim without a pass finds a place again: once the places kept fall to the free ones less one, else the next
  // hour.
  const openAt = (h: TokenHour): number => {
    const end = h.budget.resetTime();
    const free = h.total - h.budget.used() - 1;
    return free <= 0 || h.pass === 0 ? end : end - Math.floor((free * HOUR_MS) / h.pass);
  };
  const retryAfter = (at: number): number => Math.max(1, Math.ceil((at - now()) / 1000));
  const spent = (h: TokenHour): Admission => ({
    ok: false, status: 503, error: 'The faucet has sent all it sends this hour. Please try again later.', retryAfterS: retryAfter(h.budget.resetTime()),
  });
  const keptForPasses = (h: TokenHour): Admission => ({
    ok: false, status: 503, error: 'The faucet keeps its other places this hour for people activating a node. Please try again later.',
    retryAfterS: retryAfter(openAt(h)),
  });
  // Whether the claim finds a place now, or the refusal: a claim with a pass any free place, any other claim one the
  // passes do not keep.
  const refusal = (h: TokenHour, withPass: boolean): Admission | null => {
    if (h.budget.full()) return spent(h);
    return withPass || h.budget.used() + kept(h) < h.total ? null : keptForPasses(h);
  };

  return {
    admit(address, token, client, wallet = null) {
      const key = `${address}:${token}`;
      const walletKey = wallet === null ? null : `wallet:${wallet}:${token}`;
      const store = cooldownStore();
      const cooldown = store.check(key);
      if (!cooldown.allowed) return { ok: false, status: 429, error: 'Please wait 24 hours between claims.', nextClaimTime: cooldown.nextClaimTime };
      if (walletKey !== null) {
        const used = store.check(walletKey);
        if (!used.allowed) return { ok: false, status: 429, error: 'This wallet has had its test tokens today.', nextClaimTime: used.nextClaimTime };
      }
      // Without the client's address this fails closed instead of putting every caller in one shared bucket.
      if (!client.ok) return { ok: false, status: 503, error: `Service misconfigured: ${client.reason}` };
      const h = hourOf(token);
      if (!h) return { ok: false, status: 503, error: 'Unsupported token type' };
      const withPass = walletKey !== null;
      const noPlace = refusal(h, withPass);
      if (noPlace) return noPlace;
      const perIp = limit(`faucet:${token}:${client.ip}`, LEGACY_PER_IP.max, LEGACY_PER_IP.windowMs);
      if (!perIp.allowed) return { ok: false, status: 429, error: 'Too many requests. Please try again later.', retryAfterS: retryAfter(perIp.resetTime) };
      const perNetwork = limit(`faucet:${token}:${networkOf(client.ip)}`, PER_NETWORK.max, PER_NETWORK.windowMs);
      if (!perNetwork.allowed) return { ok: false, status: 429, error: 'Too many requests from this network. Please try again later.', retryAfterS: retryAfter(perNetwork.resetTime) };
      // Taken together, before the transfer is sent (it waits for confirmation for seconds): two concurrent claims for
      // one address and token never both pass, and claims in flight count against the hour.
      const window = h.budget.take();
      if (window === null) return spent(h);
      if (withPass && sync(h) === window) h.passTaken += 1;
      store.reserve(key);
      if (walletKey !== null) store.reserve(walletKey);
      return {
        ok: true,
        release: () => {
          store.release(key);
          if (walletKey !== null) store.release(walletKey);
          h.budget.giveBack(window);
          if (withPass && sync(h) === window && h.passTaken > 0) h.passTaken -= 1;
        },
      };
    },
  };
}

// The process's guard, on globalThis so every route bundle shares one.
const GLOBAL_KEY = Symbol.for('qnet.legacyFaucetGuard');

export function legacyFaucetGuard(): LegacyFaucetGuard {
  const holder = globalThis as unknown as Record<symbol, LegacyFaucetGuard | undefined>;
  let guard = holder[GLOBAL_KEY];
  if (!guard) {
    guard = createLegacyFaucetGuard();
    holder[GLOBAL_KEY] = guard;
  }
  return guard;
}
