// My node's payment card hands the connected wallet's Solana address to the Testnet page's faucet without putting it
// in a URL: it is kept in this tab's session storage, and the Testnet page reads it once, removes it and fills in its
// field. Nothing is sent anywhere by the hand-over itself; the faucet sends only when the visitor presses its button.
// The storage may be missing or blocked: then nothing is handed over and nothing throws.
//
// The card also hands over the faucet pass the site gave for the QNet wallet it activates (src/server/faucet-pass.ts):
// asked for with the wallet's signed reservation the page holds when the visitor follows the link, kept the same way,
// and sent by the Testnet page with its claims, which then take a place of the hour's larger share kept for such claims
// (one claim of each token per wallet a day).

import { within } from './deadline.ts';
import { isSolanaAddress } from './qnet-provider.ts';
import { SITE_REQUEST_MS, siteRequest } from './site-request.ts';

export const HANDOVER_KEY = 'qnet.faucet.address';
export const PASS_HANDOVER_KEY = 'qnet.faucet.pass';
// A pass: the wallet, the Unix second it ends, and a 16-byte HMAC in base64url.
export const FAUCET_PASS_RE = /^([0-9a-z]{20,64})\.(\d{1,12})\.([A-Za-z0-9_-]{22})$/;

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function sessionStore(): Store | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function handOver(address: string, storage: Store | null = sessionStore()): void {
  if (!isSolanaAddress(address)) return;
  try {
    storage?.setItem(HANDOVER_KEY, address);
  } catch {
    // storage blocked: the Testnet page asks for the address
  }
}

// The handed address, once: it is removed as it is read. Anything but a Solana address is dropped.
export function takeHandedOver(storage: Store | null = sessionStore()): string | null {
  try {
    const value = storage?.getItem(HANDOVER_KEY) ?? null;
    storage?.removeItem(HANDOVER_KEY);
    return isSolanaAddress(value) ? value : null;
  } catch {
    return null;
  }
}

export function handOverPass(pass: string, storage: Store | null = sessionStore()): void {
  if (!FAUCET_PASS_RE.test(pass)) return;
  try {
    storage?.setItem(PASS_HANDOVER_KEY, pass);
  } catch {
    // storage blocked: the claims go without a pass
  }
}

// The handed pass, once, as the address is.
export function takeHandedPass(storage: Store | null = sessionStore()): string | null {
  try {
    const value = storage?.getItem(PASS_HANDOVER_KEY) ?? null;
    storage?.removeItem(PASS_HANDOVER_KEY);
    return typeof value === 'string' && FAUCET_PASS_RE.test(value) ? value : null;
  } catch {
    return null;
  }
}

// The wallet's signed reservation of a payment address (the activation record's hold).
export interface PassHold {
  wallet: string;
  pk: string;
  sig: string;
  time: number;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

// The site's answer for a pass: the pass, or none and until when not to ask again for the same confirmation (the
// refusal's own time past the hourly passes, never for a confirmation it refused, null when it could not be asked).
export type PassAnswer = { pass: string } | { pass: null; retryAt: number | null };

// POST /api/faucet/pass with the hold and its payment address.
export async function requestFaucetPass(hold: PassHold, burner: string, fetchFn: FetchLike = fetch, nowMs: number = Date.now()): Promise<PassAnswer> {
  try {
    const res = await fetchFn('/api/faucet/pass', siteRequest({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet: hold.wallet, burner, proof: { pk: hold.pk, sig: hold.sig, time: hold.time } }),
    }));
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (res.status === 429) return { pass: null, retryAt: retryAt(body, nowMs) ?? nowMs + PASS_RETRY_MS };
    if (res.status === 400 || res.status === 404) return { pass: null, retryAt: Infinity };
    const pass = res.status === 200 && body !== null && typeof body === 'object' ? (body as Record<string, unknown>).pass : null;
    return typeof pass === 'string' && FAUCET_PASS_RE.test(pass) ? { pass } : { pass: null, retryAt: null };
  } catch {
    return { pass: null, retryAt: null };
  }
}

// A refusal past the hourly passes that names no time is not asked again for this long.
export const PASS_RETRY_MS = 60_000;
// A pass is handed over only with this much of it left, so the claim it goes with still finds it valid.
export const PASS_MARGIN_MS = 60_000;
// How long following the link waits for a pass before it goes to the faucet without one.
export const PASS_WAIT_MS = 4_000;

export interface FaucetPasses {
  // The pass kept for this confirmation, without asking.
  ready(hold: PassHold): string | null;
  // The kept pass, else one asked for once (a second call meanwhile shares the request), at most `waitMs` waited for:
  // a pass that comes later is kept for the next time. Nothing is asked while a refusal holds.
  obtain(hold: PassHold, burner: string, waitMs?: number): Promise<string | null>;
}

// The page asks for a pass only when the visitor follows the link to the faucet, and per wallet's confirmation once
// for as long as the pass lasts or a refusal holds, in this page's memory only: the server gives few passes an hour.
export function createFaucetPasses(fetchFn: FetchLike = (url, init) => fetch(url, init), now: () => number = Date.now): FaucetPasses {
  const kept = new Map<string, { pass: string | null; until: number }>();
  const asking = new Map<string, Promise<string | null>>();
  const keyOf = (hold: PassHold) => `${hold.wallet}:${hold.time}`;
  const live = (key: string) => {
    const k = kept.get(key);
    return k !== undefined && k.until > now() ? k : null;
  };
  return {
    ready: (hold) => live(keyOf(hold))?.pass ?? null,
    obtain(hold, burner, waitMs = Infinity) {
      const key = keyOf(hold);
      const k = live(key);
      if (k) return Promise.resolve(k.pass);
      let request = asking.get(key);
      if (!request) {
        request = requestFaucetPass(hold, burner, fetchFn, now()).then((got) => {
          asking.delete(key);
          if (got.pass !== null) kept.set(key, { pass: got.pass, until: Number(FAUCET_PASS_RE.exec(got.pass)?.[2] ?? 0) * 1000 - PASS_MARGIN_MS });
          else if (got.retryAt !== null) kept.set(key, { pass: null, until: got.retryAt });
          return got.pass;
        });
        asking.set(key, request);
      }
      if (waitMs === Infinity) return request;
      return within(waitMs, request);
    },
  };
}

// The page's passes, shared by every payment card it shows.
export const faucetPasses = createFaucetPasses();

// The claim route answers at most this long after it took a claim (src/app/api/faucet/claim): a transfer not settled on
// Solana by then is answered unconfirmed, with its signature, and keeps its reservation.
export const FAUCET_CLAIM_MS = 132_000;
// The page waits for a claim that long and a read more; nginx's read timeout of the route lies between the two.
export const FAUCET_CLAIM_REQUEST_MS = FAUCET_CLAIM_MS + SITE_REQUEST_MS;

// When a refused claim may be made again, from the faucet's answer (`retryAfterS`, or `nextClaimTime` for an address or
// wallet that had its tokens today): ms since the epoch, or null when the answer names none.
export function retryAt(body: unknown, nowMs: number): number | null {
  if (body === null || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.retryAfterS === 'number' && Number.isSafeInteger(b.retryAfterS) && b.retryAfterS > 0) return nowMs + b.retryAfterS * 1000;
  if (typeof b.nextClaimTime === 'string') {
    const at = Date.parse(b.nextClaimTime);
    if (Number.isFinite(at) && at > nowMs) return at;
  }
  return null;
}
