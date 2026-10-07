// The address page's balance check: the balance verified against the network's committee certificate, never against
// node agreement. The pinned genesis nodes answer with a state proof that names a certified macroblock; the site's light
// client verifies that macroblock's committee signatures itself, walking up from the pinned checkpoint, and the proof
// must fold to the state root it verified (src/server/light/balance-proof.ts). An answer that does not verify is not a
// balance: the route then reports why (not confirmed yet, or the network did not answer) and no figure.
import { NextRequest, NextResponse } from 'next/server';
import { getRateLimitKey, rateLimit } from '../../../../../../lib/rate-limit';
import { sharedBalanceProver, type BalanceResult } from '@/server/light/balance-proof';

const RATE_LIMIT_WINDOW = 60_000; // 1 minute
// A read-only check that many wallets behind one NAT may share: 2 a second per IP, while the result cache below
// absorbs repeated lookups of one address. The count lives in the explorer routes' shared limiter (lib/rate-limit.ts):
// X-Real-IP from nginx, else the socket address, never a client's X-Forwarded-For; without an address it fails closed.
const RATE_LIMIT_MAX = 120;

// A verified answer is kept 30 s per address; one that could not be verified only 5 s, so a retry soon gets a fresh try.
const VERIFIED_TTL_MS = 30_000;
const UNVERIFIED_TTL_MS = 5_000;
const MAX_CACHE_SIZE = 10_000;
const cache = new Map<string, { body: Record<string, unknown>; until: number }>();
const inflight = new Map<string, Promise<Record<string, unknown>>>();

const MESSAGES: Record<'not_confirmed_yet' | 'network_unavailable', string> = {
  not_confirmed_yet: 'The balance is not confirmed yet: the newest checkpoint is still being verified. Try again in a minute.',
  network_unavailable: 'The network did not answer. Try again later.',
};

// Nano QNC as an exact decimal QNC string.
function qncText(nano: string): string {
  const v = BigInt(nano);
  const frac = (v % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return frac ? `${v / 1_000_000_000n}.${frac}` : `${v / 1_000_000_000n}`;
}

function bodyOf(r: BalanceResult): Record<string, unknown> {
  if (!r.verified) return { success: true, verified: false, reason: r.reason, error: MESSAGES[r.reason] };
  return {
    success: true,
    verified: true,
    exists: r.exists,
    balance: qncText(r.balanceNano),
    balanceNano: r.balanceNano,
    nonce: r.nonce,
    macroblockIndex: r.macroblockIndex,
    stateHeight: r.stateHeight,
    stateRoot: r.stateRoot,
    verificationMethod: 'committee-certificate',
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ address: string }> }
) {
  try {
    const { address } = await params;
    if (!address || address.length > 64 || address.length < 20 || !/^[\x21-\x7e]+$/.test(address)) {
      return NextResponse.json({ success: false, error: 'Invalid address' }, { status: 400 });
    }

    const ipKey = getRateLimitKey(request);
    if (!ipKey.ok) {
      return NextResponse.json({ success: false, error: `Service misconfigured: ${ipKey.reason}` }, { status: 503 });
    }
    if (!rateLimit(`balance-proof:${ipKey.ip}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW).allowed) {
      return NextResponse.json({
        success: false,
        error: `Rate limited. Max ${RATE_LIMIT_MAX} verifications per minute.`,
      }, { status: 429 });
    }

    const now = Date.now();
    const kept = cache.get(address);
    if (kept && kept.until > now) return NextResponse.json({ ...kept.body, cached: true });

    // A second press, or a second tab, while the check of this address runs waits for that check instead of asking
    // the nodes again.
    let running = inflight.get(address);
    if (!running) {
      running = sharedBalanceProver().provenBalance(address).then((r) => {
        const body = bodyOf(r);
        if (cache.size >= MAX_CACHE_SIZE) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        cache.delete(address);
        cache.set(address, { body, until: Date.now() + (body.verified ? VERIFIED_TTL_MS : UNVERIFIED_TTL_MS) });
        return body;
      }).finally(() => inflight.delete(address));
      inflight.set(address, running);
    }
    return NextResponse.json(await running);
  } catch (err) {
    console.error(`[ERR][BALANCE-PROOF] failed err=${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json({ success: false, verified: false, error: 'Failed to verify the balance' }, { status: 500 });
  }
}
