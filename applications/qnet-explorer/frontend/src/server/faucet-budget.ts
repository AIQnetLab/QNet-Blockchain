// A budget of claims per fixed window for everyone (the faucet's global caps: src/app/api/faucet/claim/route.ts), in
// this process's memory. Windows are aligned to the epoch (a day window is a UTC
// day). It is a counter of its own, never a key of an evicting limiter store, so no flood of other keys resets it.
// A claim takes its place before it sends and gives it back only when nothing was sent; a place given back after its
// window ended changes nothing.

export interface FaucetBudget {
  // Whether the current window has no place left.
  full(): boolean;
  // A place in the current window: the window's number, to give it back with; null when full.
  take(): number | null;
  giveBack(window: number): void;
  // When the next window starts (ms since the epoch).
  resetTime(): number;
  used(): number;
}

export function createFaucetBudget({ max, windowMs, now = Date.now }: { max: number; windowMs: number; now?: () => number }): FaucetBudget {
  if (!Number.isSafeInteger(max) || max < 0) throw new RangeError('max must be a non-negative integer');
  if (!Number.isSafeInteger(windowMs) || windowMs <= 0) throw new RangeError('windowMs must be a positive integer');
  let window = -1;
  let count = 0;
  const current = (): number => {
    const w = Math.floor(now() / windowMs);
    if (w !== window) {
      window = w;
      count = 0;
    }
    return w;
  };
  return {
    full() {
      current();
      return count >= max;
    },
    take() {
      const w = current();
      if (count >= max) return null;
      count += 1;
      return w;
    },
    giveBack(w) {
      if (current() === w && count > 0) count -= 1;
    },
    resetTime: () => (current() + 1) * windowMs,
    used() {
      current();
      return count;
    },
  };
}
