// The Solana RPC endpoint of the site's server: the node cabinet's reads and sends and the testnet faucet (SITE-6). Every
// activating page reads Solana through this one server, so the endpoint is a server setting, SOLANA_RPC_URL: a
// dedicated provider of the cluster the QNet network verifies burns on (BURN_CLUSTER, devnet), else that cluster's
// public endpoint, which limits one address to a few requests a second. The URL may carry a provider's key: it is read
// on the server only, never sent to a page and never written to a log. The process shares one client, which backs off
// when the endpoint answers 429, and the cabinet's balance reads go out together as one getMultipleAccounts.

import { solanaRpc, type Rpc } from './solana-rpc.ts';

export const PUBLIC_RPC_URL = 'https://api.devnet.solana.com';
// After a 429: no call for this long, doubling on each further 429 up to the maximum.
export const BACKOFF_START_MS = 2_000;
export const BACKOFF_MAX_MS = 30_000;
// Balance reads that arrive within this window go out as one call (at most this many accounts per call).
export const BATCH_WINDOW_MS = 250;
export const BATCH_MAX_ACCOUNTS = 100;

let warnedUrl = false;

// SOLANA_RPC_URL when it is an https URL (http only for a node on this machine) without user info; the public
// endpoint otherwise.
export function solanaRpcUrl(env: Record<string, string | undefined> = process.env): string {
  const raw = env.SOLANA_RPC_URL?.trim();
  if (!raw) {
    // A deployment without its own endpoint: every visitor's reads share the public endpoint's few requests a second.
    if (!warnedUrl && env.NODE_ENV === 'production') {
      warnedUrl = true;
      console.warn('[WARN][SOLANA] rpc_url_unset fallback=public');
    }
    return PUBLIC_RPC_URL;
  }
  try {
    const u = new URL(raw);
    const local = u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    if ((u.protocol === 'https:' || local) && !u.username && !u.password) return u.toString();
  } catch {
    // not a URL
  }
  if (!warnedUrl) {
    warnedUrl = true;
    console.warn('[WARN][SOLANA] rpc_url_invalid fallback=public');
  }
  return PUBLIC_RPC_URL;
}

export class RpcBackoff extends Error {
  constructor() {
    super('rpc_backoff');
    this.name = 'RpcBackoff';
  }
}

// The calls that send (a burn, a refund, a faucet claim) and the blockhash they are signed with. They back off apart
// from the reads, so a flood of reads that makes the endpoint answer 429 never stops a send (SITE-R2-08).
export const SEND_METHODS: ReadonlySet<string> = new Set(['sendTransaction', 'getLatestBlockhash']);
export type RpcLane = 'send' | 'read';
export const laneOf = (method: string): RpcLane => (SEND_METHODS.has(method) ? 'send' : 'read');

// `rpc` that stops calling for a while after the endpoint answers 429 (solanaRpc throws `rpc_http_429`): a call of the
// same lane then fails at once instead of adding to the endpoint's count. Each back-off is logged once, without the URL.
export function withBackoff(rpc: Rpc, { now = Date.now, log = (line: string) => console.warn(line) }: { now?: () => number; log?: (line: string) => void } = {}): Rpc {
  const lanes: Record<RpcLane, { until: number; step: number }> = { send: { until: 0, step: 0 }, read: { until: 0, step: 0 } };
  return async (method, params) => {
    const name = laneOf(method);
    const lane = lanes[name];
    if (now() < lane.until) throw new RpcBackoff();
    try {
      const result = await rpc(method, params);
      lane.step = 0;
      return result;
    } catch (err) {
      if (err instanceof Error && err.message === 'rpc_http_429') {
        const wait = Math.min(BACKOFF_START_MS * 2 ** lane.step, BACKOFF_MAX_MS);
        lane.step = Math.min(lane.step + 1, 8);
        lane.until = now() + wait;
        log(`[WARN][SOLANA] rpc_rate_limited lane=${name} backoff_ms=${wait}`);
      }
      throw err;
    }
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export type AccountsReader = (keys: string[]) => Promise<unknown[]>;

// getMultipleAccounts of many callers as one call: the keys that arrive within `windowMs` are asked together, at most
// `maxAccounts` per call and never one caller's keys split; each caller gets its own accounts, in its order.
export function accountBatcher(
  rpc: Rpc,
  { windowMs = BATCH_WINDOW_MS, maxAccounts = BATCH_MAX_ACCOUNTS }: { windowMs?: number; maxAccounts?: number } = {},
): AccountsReader {
  type Item = { keys: string[]; resolve: (value: unknown[]) => void; reject: (err: unknown) => void };
  let queue: Item[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function ask(items: Item[]): Promise<void> {
    const keys = items.flatMap((i) => i.keys);
    try {
      const result = await rpc('getMultipleAccounts', [keys, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
      const value = isObject(result) && Array.isArray(result.value) && result.value.length === keys.length ? result.value : null;
      if (!value) throw new Error('rpc_malformed_accounts');
      let at = 0;
      for (const i of items) {
        i.resolve(value.slice(at, at + i.keys.length));
        at += i.keys.length;
      }
    } catch (err) {
      for (const i of items) i.reject(err);
    }
  }

  function flush(): void {
    timer = null;
    const pending = queue;
    queue = [];
    let chunk: Item[] = [];
    let count = 0;
    for (const item of pending) {
      if (chunk.length > 0 && count + item.keys.length > maxAccounts) {
        void ask(chunk);
        chunk = [];
        count = 0;
      }
      chunk.push(item);
      count += item.keys.length;
    }
    if (chunk.length > 0) void ask(chunk);
  }

  return (keys) => new Promise<unknown[]>((resolve, reject) => {
    if (keys.length === 0 || keys.length > maxAccounts) {
      reject(new Error('rpc_accounts_count'));
      return;
    }
    queue.push({ keys, resolve, reject });
    if (!timer) timer = setTimeout(flush, windowMs);
  });
}

// The process's client, on globalThis so every route bundle shares its back-off.
const GLOBAL_KEY = Symbol.for('qnet.solanaRpc');

export function sharedSolanaRpc(): Rpc {
  const holder = globalThis as unknown as Record<symbol, Rpc | undefined>;
  const existing = holder[GLOBAL_KEY];
  if (existing) return existing;
  const created = withBackoff(solanaRpc(solanaRpcUrl(), { timeoutMs: 8_000 }));
  holder[GLOBAL_KEY] = created;
  return created;
}
