// The way a wallet's Solana calls go: straight to the cluster's endpoint, or, once a direct call got no answer at all,
// through the site the wallet already uses, which passes the same call on to Solana; an attempt there with no usable
// answer is followed by one at the endpoint. The route is kept on the device and the direct way is tried again in the
// background, so a network that blocks the endpoint costs one wait, not one per call. It imports nothing: the
// extension's crypto bundle compiles it for its own Solana client.

/** How long the site route stands before a direct call is tried again (ms). */
export const SOLANA_DIRECT_RETRY_MS = 300_000;

/**
 * The kept route `saved` (a parsed value from storage, untrusted) as { v: 1, via: 'direct' | 'site', probeAt }: the
 * site route with the time of its last direct try (ms since the epoch), read strictly; anything else is the direct
 * route, whose probeAt is 0.
 */
export function solanaRouteOf(saved) {
  const site = !!saved && typeof saved === 'object' && !Array.isArray(saved)
    && Object.keys(saved).sort().join(',') === 'probeAt,v,via' && saved.v === 1 && saved.via === 'site'
    && Number.isSafeInteger(saved.probeAt) && saved.probeAt >= 0;
  return site ? { v: 1, via: 'site', probeAt: saved.probeAt } : { v: 1, via: 'direct', probeAt: 0 };
}

/**
 * The route after a direct try, a call's or a probe's, at `now`: one that got an answer goes direct, one that got no
 * answer at all goes through the site from `now`.
 */
export function solanaRouteAfter(answered, now) {
  if (answered) return { v: 1, via: 'direct', probeAt: 0 };
  return { v: 1, via: 'site', probeAt: Number.isSafeInteger(now) && now > 0 ? now : 0 };
}

/**
 * The step after one attempt of a call that went `via` ('direct' | 'site') and got `answer` at `now`: 'usable' (a JSON-RPC
 * result or error object), 'unusable' (an HTTP answer that is neither) or 'none' (no answer at all). { route, next }: the
 * route to keep (null: the kept one stands) and the way of an attempt after it. A usable answer of the endpoint puts the
 * calls on it and none at all puts them on the site; after the site gave no usable answer the endpoint is asked, after the
 * endpoint gave none at all the site, and after any other the same way again.
 */
export function solanaAttemptAfter(via, answer, now) {
  if (via === 'site') return { route: null, next: answer === 'usable' ? 'site' : 'direct' };
  if (answer === 'usable') return { route: solanaRouteAfter(true, now), next: 'direct' };
  if (answer === 'none') return { route: solanaRouteAfter(false, now), next: 'site' };
  return { route: null, next: 'direct' };
}

/**
 * Whether a direct try is due on `route` at `now`: on the site route only, once SOLANA_DIRECT_RETRY_MS has passed since
 * the last one, when the network changed after it (`networkAt`, ms since the epoch, 0 when unknown), or when that try is
 * dated after `now`, a clock set back, which would otherwise hold the site route until the clock caught up.
 */
export function solanaProbeDue(route, now, networkAt = 0) {
  if (!route || route.via !== 'site') return false;
  return now - route.probeAt >= SOLANA_DIRECT_RETRY_MS || networkAt > route.probeAt || route.probeAt > now;
}
