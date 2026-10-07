// The testnet faucet's per-(address, token) cooldown (src/app/api/faucet/claim/route.ts): the time of the
// last claim, kept in this process's memory only and for no longer than the cooldown, as the privacy
// policy says. A claim's slot is taken before its transfer is sent and released only when the transfer
// cannot land, so two concurrent claims for the same address and token never both send.
//
// Bounded: an entry is dropped once its cooldown has passed (on access, and by a sweep every minute), and
// at most `maxEntries` are held; a full store evicts the claim made longest ago (the one closest to the end
// of its cooldown) rather than refusing, so a crowd of addresses cannot shut the faucet.

export interface FaucetCooldowns {
  // Whether `key` may claim now; if not, when it may.
  check(key: string): { allowed: true } | { allowed: false; nextClaimTime: number };
  // Takes the slot of `key` from now.
  reserve(key: string): void;
  // Gives the slot back (the transfer was not sent, or cannot land).
  release(key: string): void;
  sweep(): void;
  size(): number;
}

export function createFaucetCooldowns({
  cooldownMs,
  maxEntries = 100_000,
  now = Date.now,
}: {
  cooldownMs: number;
  maxEntries?: number;
  now?: () => number;
}): FaucetCooldowns {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new RangeError('maxEntries must be a positive integer');
  if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) throw new RangeError('cooldownMs must be positive');
  // key -> time of the claim; insertion order is claim order (a new claim of a key moves it to the end).
  const claims = new Map<string, number>();

  const expired = (at: number, t: number) => t - at >= cooldownMs;

  function sweep(): void {
    const t = now();
    for (const [key, at] of claims) {
      if (expired(at, t)) claims.delete(key);
    }
  }

  function check(key: string): { allowed: true } | { allowed: false; nextClaimTime: number } {
    const t = now();
    const at = claims.get(key);
    if (at === undefined) return { allowed: true };
    if (expired(at, t)) {
      claims.delete(key);
      return { allowed: true };
    }
    return { allowed: false, nextClaimTime: at + cooldownMs };
  }

  function reserve(key: string): void {
    claims.delete(key);
    if (claims.size >= maxEntries) {
      sweep();
      if (claims.size >= maxEntries) {
        const oldest = claims.keys().next();
        if (!oldest.done) claims.delete(oldest.value);
      }
    }
    claims.set(key, now());
  }

  return { check, reserve, release: (key) => void claims.delete(key), sweep, size: () => claims.size };
}

// Runs the sweep every minute without keeping the process alive (unit tests import this module).
export function sweepCooldownsPeriodically(cooldowns: FaucetCooldowns, intervalMs = 60_000): void {
  const timer = setInterval(() => cooldowns.sweep(), intervalMs);
  (timer as unknown as { unref?: () => void }).unref?.();
}
