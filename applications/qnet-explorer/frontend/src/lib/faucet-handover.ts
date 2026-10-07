// My node's payment card hands the connected wallet's Solana address to the Testnet page's faucet without putting it
// in a URL: it is kept in this tab's session storage, and the Testnet page reads it once, removes it and fills in its
// field. Nothing is sent anywhere by the hand-over itself; the faucet sends only when the visitor presses its button.
// The storage may be missing or blocked: then nothing is handed over and nothing throws.
//
// The card also hands over the faucet pass the site gave for the QNet wallet it activates (src/server/faucet-pass.ts,
// SITE M-13): asked for with the wallet's signed reservation the page holds, kept the same way, and sent by the Testnet
// page with its claims, which then take a place of the hour's larger share kept for such claims (one claim of each token
// per wallet a day).

import { isSolanaAddress } from './qnet-provider.ts';

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

// The wallet's signed reservation of a payment address (the activation record's hold, C1).
export interface PassHold {
  wallet: string;
  pk: string;
  sig: string;
  time: number;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

// POST /api/faucet/pass with the hold and its payment address: the pass, or null when the site gave none.
export async function requestFaucetPass(hold: PassHold, burner: string, fetchFn: FetchLike = fetch): Promise<string | null> {
  try {
    const res = await fetchFn('/api/faucet/pass', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet: hold.wallet, burner, proof: { pk: hold.pk, sig: hold.sig, time: hold.time } }),
    });
    if (res.status !== 200) return null;
    const body: unknown = await res.json();
    const pass = body !== null && typeof body === 'object' ? (body as Record<string, unknown>).pass : null;
    return typeof pass === 'string' && FAUCET_PASS_RE.test(pass) ? pass : null;
  } catch {
    return null;
  }
}

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
