// Node reads for the web tier. Every configured node is asked in turn (QNET_API_URLS, else the single
// QNET_API_URL), so one node restarting in a roll, saturated by a load test or down does not take the
// explorer's balances and lookups with it. A node that fails sits out a short cooldown.

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
// Dev only: no production host is baked into source.
const DEV_FALLBACK = 'http://127.0.0.1:8001';
const COOLDOWN_MS = 15_000;

const failedUntil = new Map<string, number>();

// Private, loopback, link-local or CGNAT: never a node a production web tier may call (SSRF guard).
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '::' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127 || a === 0 || a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  return false;
}

// The node list, resolved once. Production takes only http(s) URLs with a public host and reports the
// ones it dropped; development falls back to a local node.
function resolveEndpoints(): { endpoints: string[]; error: string | null } {
  const raw = process.env.QNET_API_URLS || process.env.QNET_API_URL || '';
  const listed = Array.from(new Set(raw.split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean)));
  const usable: string[] = [];
  const rejected: string[] = [];
  for (const u of listed) {
    let parsed: URL;
    try { parsed = new URL(u); } catch { rejected.push(u); continue; }
    const httpish = parsed.protocol === 'http:' || parsed.protocol === 'https:';
    if (!httpish || (IS_PRODUCTION && isBlockedHost(parsed.hostname))) { rejected.push(u); continue; }
    usable.push(u);
  }
  if (usable.length > 0) return { endpoints: usable, error: null };
  if (!IS_PRODUCTION) return { endpoints: [DEV_FALLBACK], error: null };
  return {
    endpoints: [],
    error: listed.length === 0
      ? 'QNET_API_URLS / QNET_API_URL is not set: a production build needs public node RPC endpoints'
      : `no usable node endpoint (rejected: ${rejected.join(', ')})`,
  };
}

const RESOLVED = resolveEndpoints();

export function nodeConfigError(): string | null {
  return RESOLVED.error;
}

export function nodeHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (process.env.QNET_API_KEY) h['X-API-Key'] = process.env.QNET_API_KEY;
  return h;
}

export interface NodeFetchOptions extends Omit<RequestInit, 'signal'> {
  timeoutMs?: number;
  /** False for a request that must not reach two nodes (a write): only the first healthy node is asked. */
  failover?: boolean;
}

// The first answer to `path` that is neither a transport failure nor a 5xx; null when no node gives one.
// Nodes in cooldown are asked only when every node is in cooldown, so a caller that loops over many
// reads pays for a dead node once per cooldown, not once per read.
export async function fetchNode(path: string, opts: NodeFetchOptions = {}): Promise<Response | null> {
  const { timeoutMs = 10_000, failover = true, headers, ...init } = opts;
  const now = Date.now();
  const all = RESOLVED.endpoints;
  const healthy = all.filter(e => (failedUntil.get(e) || 0) <= now);
  const candidates = healthy.length > 0 ? healthy : all;
  for (const base of failover ? candidates : candidates.slice(0, 1)) {
    try {
      const res = await fetch(`${base}${path}`, { ...init, headers: headers ?? nodeHeaders(), signal: AbortSignal.timeout(timeoutMs) });
      if (res.status < 500) {
        failedUntil.delete(base);
        return res;
      }
    } catch {
      // unreachable or timed out: the next node is asked
    }
    failedUntil.set(base, Date.now() + COOLDOWN_MS);
  }
  return null;
}

export function nodeEndpoints(): string[] {
  return [...RESOLVED.endpoints];
}
