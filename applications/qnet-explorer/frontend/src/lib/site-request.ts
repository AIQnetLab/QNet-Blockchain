// The page's requests to the site's own routes: never cached, no cookies, no redirect, and ended after `ms`, so a
// request on a connection that stopped answering fails into the caller's retry instead of waiting for ever. A caller's
// own signal (a page left, a newer search) still ends it first.
export const SITE_REQUEST_MS = 20_000;

export function siteRequest(init: RequestInit = {}, ms: number = SITE_REQUEST_MS): RequestInit {
  const timeout = AbortSignal.timeout(ms);
  return { cache: 'no-store', credentials: 'omit', redirect: 'error', ...init, signal: init.signal ? either(init.signal, timeout) : timeout };
}

// AbortSignal.any where the browser has it; browsers from before 2024 do not.
function either(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b]);
  const both = new AbortController();
  for (const s of [a, b]) {
    if (s.aborted) {
      both.abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => both.abort(s.reason), { once: true });
  }
  return both.signal;
}
