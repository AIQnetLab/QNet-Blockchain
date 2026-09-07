import WebSocket from 'ws';
import { log, errText } from './log';
import { quoteBigInts } from './transform';

// Node JSON as the indexer consumes it. Signatures/hashes arrive as byte arrays or hex; see transform.ts.
export interface NodeBlock {
  height: number;
  hash?: string | null;
  timestamp: number;
  previous_hash?: unknown;
  merkle_root?: unknown;
  producer?: string;
  transactions?: Record<string, unknown>[];
  [k: string]: unknown;
}

export interface NodeHeader {
  height: number;
  hash: string | null;
  body: boolean;
  timestamp?: number;
  producer?: string;
  tx_count?: number;
  previous_hash?: string;
  merkle_root?: string;
  error?: string;
}

export interface HeadersPage {
  from: number;
  next: number;
  head: number;
  items: NodeHeader[];
}

/// Headers every admitted endpoint was asked for, reduced to the identity a quorum of them names.
export interface QuorumHeaders {
  items: NodeHeader[];                    // quorum-agreed identity, ascending
  bodySources: Map<number, string[]>;     // endpoints that report holding the body at that height
  head: number;
  endpoints: number;
  quorum: number;
}

export interface NewBlockEvent {
  height: number;
  hash: string;
  timestamp: number;
  tx_count: number;
  producer: string;
  endpoint: string;
}

const MAX_BLOCK_BYTES = 64 * 1024 * 1024;
const MAX_SMALL_BYTES = 4 * 1024 * 1024;
const ENDPOINT_COOLDOWN_MS = 15_000;
const WS_FRESH_MS = 10_000;          // the WS endpoint is preferred only while it delivers TIP blocks
const WS_EVENT_SILENCE_MS = 45_000;  // no tip block for this long ⇒ the socket is dropped and rotated
const WS_MAX_EVENTS_PER_SEC = 500;   // a socket streaming faster than any replay is torn down
const FANOUT_GRACE_MS = 6_000;       // after a quorum answered, how long the rest may take
export const HEIGHT_SLACK = 600;     // a single source may lead the agreed network height by this much

// The network height from per-endpoint answers: the quorum-th highest, so no minority can inflate it
// and a lagging node cannot deflate it. Below a quorum of answers there is nothing to lean on and the
// lowest answer is taken — an understated height only delays work, an overstated one misjudges finality.
export function pickNetworkHeight(values: number[], quorum: number): number {
  const ok = values.filter(h => Number.isSafeInteger(h) && h >= 0).sort((a, b) => b - a);
  if (ok.length === 0) return -1;
  return ok[Math.min(Math.max(quorum, 1), ok.length) - 1];
}

// The body up to `maxBytes`, aborting the stream past it; Content-Length is a claim, not a bound.
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel().catch(() => undefined); throw new Error(`response too large >${maxBytes}`); }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

function parseEndpoints(): string[] {
  const raw = process.env.QNET_API_URLS || process.env.QNET_API_URL || '';
  const list = raw.split(',').map(s => s.trim()).filter(Boolean).map(s => s.replace(/\/+$/, ''));
  for (const u of list) {
    const p = new URL(u);
    if (p.protocol !== 'http:' && p.protocol !== 'https:') throw new Error(`bad node url ${u}`);
  }
  if (list.length === 0) throw new Error('QNET_API_URLS is empty');
  return Array.from(new Set(list));
}

// Reads for one logical operation go to ONE endpoint (its `pin`) so headers and bodies describe the
// same node's chain. Two penalties: a transient failure (15 s cooldown) and a quarantine (chain
// disagreement); a quarantined endpoint never serves, votes or anchors until the penalty lapses.
// Network height is the maximum over the healthy endpoints; a lagging node never reads as a shorter
// network, and a node replaying history is not "live" — liveness is measured by blocks at the tip.
export class NodeClient {
  private readonly endpoints: string[];
  private readonly failedUntil = new Map<string, number>();
  private readonly quarantinedUntil = new Map<string, number>();
  private rr = 0;
  private wsEndpoint: string | null = null;
  private wsSocket: WebSocket | null = null;
  private lastTipEventAt = 0;
  private maxSeen = 0;
  private agreed = 0;            // last height a quorum of endpoints answered; the slack is relative to it
  private readonly headers: Record<string, string>;

  constructor() {
    this.endpoints = parseEndpoints();
    this.headers = { 'Content-Type': 'application/json' };
    const key = process.env.QNET_API_KEY || '';
    if (key) this.headers['X-API-Key'] = key;
  }

  get endpointCount(): number { return this.endpoints.length; }
  get allEndpoints(): string[] { return [...this.endpoints]; }
  get quorum(): number { return Math.floor(this.endpoints.length / 2) + 1; }
  get admittedCount(): number { return this.admitted().length; }
  // The smallest number of agreeing endpoints that must include an honest one: at most
  // endpoints − quorum of them can be wrong, so one more than that is enough to believe a value.
  get honestOne(): number { return Math.max(1, this.endpoints.length - this.quorum + 1); }
  get networkHeight(): number { return this.maxSeen; }
  get agreedHeight(): number { return this.agreed; }

  isQuarantined(endpoint: string): boolean { return (this.quarantinedUntil.get(endpoint) || 0) > Date.now(); }
  isHealthy(endpoint: string): boolean {
    return !this.isQuarantined(endpoint) && (this.failedUntil.get(endpoint) || 0) <= Date.now();
  }
  // Delivering tip blocks right now (a wedged or replaying node is not).
  isLive(endpoint: string): boolean {
    return this.wsEndpoint === endpoint && Date.now() - this.lastTipEventAt < WS_FRESH_MS;
  }

  private admitted(exclude?: string): string[] { return this.endpoints.filter(e => e !== exclude && !this.isQuarantined(e)); }
  private healthy(exclude?: string): string[] { return this.endpoints.filter(e => e !== exclude && this.isHealthy(e)); }

  // The endpoint an operation pins: the WS source while it delivers tip blocks, else round-robin over
  // the healthy endpoints, else any admitted one. Never a quarantined endpoint.
  pin(opts?: { exclude?: string }): string {
    const ex = opts?.exclude;
    if (this.wsEndpoint && this.wsEndpoint !== ex && this.isHealthy(this.wsEndpoint) && this.isLive(this.wsEndpoint)) return this.wsEndpoint;
    const pool = this.healthy(ex);
    const admitted = this.admitted(ex);
    const list = pool.length > 0 ? pool : (admitted.length > 0 ? admitted : this.admitted());
    if (list.length === 0) throw new Error('every endpoint is quarantined');
    return list[this.rr++ % list.length];
  }

  private order(pin?: string): string[] {
    const usable = (e: string) => !this.isQuarantined(e);
    const warm = this.endpoints.filter(e => e !== pin && this.isHealthy(e));
    const cold = this.endpoints.filter(e => e !== pin && usable(e) && !this.isHealthy(e));
    const pinned = pin && this.isHealthy(pin) ? [pin] : [];
    const pinCold = pin && usable(pin) && !this.isHealthy(pin) ? [pin] : [];
    return [...pinned, ...warm, ...cold, ...pinCold];
  }

  /// A transient fault: the endpoint sits out a short cooldown. Public so the follower can charge one
  /// for a claim it did not honour — serving nothing is a fault the transport layer never sees.
  markFailed(endpoint: string, why: string): void {
    this.failedUntil.set(endpoint, Date.now() + ENDPOINT_COOLDOWN_MS);
    log.warn('NODE', 'endpoint_failed', { endpoint, why });
  }

  // An endpoint whose chain disagrees with the archive beyond what finality allows sits out; if it is
  // the WS source, the socket is dropped so the subscription rotates.
  // A fresh genesis is the one event that lowers the agreed height.
  forgetAgreedHeight(): void { this.agreed = 0; this.maxSeen = 0; }

  quarantine(endpoint: string, ms: number, why: string): void {
    if (this.admitted().length - 1 < this.quorum) {
      log.warn('NODE', 'quarantine_refused', { endpoint, why, admitted: this.admitted().length, quorum: this.quorum });
      this.markFailed(endpoint, why);   // a short cooldown instead: the set must stay decidable
      return;
    }
    this.quarantinedUntil.set(endpoint, Date.now() + ms);
    log.err('NODE', 'endpoint_quarantined', { endpoint, ms, why });
    if (this.wsEndpoint === endpoint && this.wsSocket) { try { this.wsSocket.terminate(); } catch { /* closing */ } }
  }

  // A single source may lead the last AGREED height by HEIGHT_SLACK, never ratchet past it one answer
  // at a time; the height poll sets both outright.
  noteHeight(h: number, agreed = false): void {
    if (!Number.isSafeInteger(h) || h < 0) return;
    // The agreed height never falls on its own: a poll answered by too few endpoints, or by lagging
    // ones, must not drag the archive's view of the chain backwards. A reset clears it explicitly.
    if (agreed) { if (h > this.agreed) { this.agreed = h; this.maxSeen = h; } return; }
    if (h > this.maxSeen && h <= this.agreed + HEIGHT_SLACK) this.maxSeen = h;
  }

  private async fetchOne<T>(endpoint: string, path: string, init: RequestInit, maxBytes: number, timeoutMs: number): Promise<T> {
    const res = await fetch(`${endpoint}${path}`, { ...init, headers: this.headers, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 404) {
      // An error body is read under the same cap as a good one: a stream without an end is not a 404.
      const body = await readCapped(res, 4096).catch(() => '');
      throw new NotFoundError(`404 ${path} ${body.slice(0, 120)}`);
    }
    if (!res.ok) throw new Error(`http ${res.status} ${path}`);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > maxBytes) throw new Error(`response too large ${len}`);
    const text = await readCapped(res, maxBytes).catch(e => {
      log.err('NODE', 'response_over_cap', { path, endpoint, max: maxBytes });
      throw e;
    });
    return JSON.parse(quoteBigInts(text)) as T;
  }

  // Pinned endpoint first (when healthy), then the others; the one that answered comes back too.
  private async fetchJson<T>(path: string, init: RequestInit, maxBytes: number, timeoutMs: number, pin?: string): Promise<{ value: T; endpoint: string }> {
    let lastErr: unknown = new Error('no admitted endpoint');
    for (const endpoint of this.order(pin)) {
      try {
        return { value: await this.fetchOne<T>(endpoint, path, init, maxBytes, timeoutMs), endpoint };
      } catch (e) {
        if (e instanceof NotFoundError) throw e;
        lastErr = e;
        this.markFailed(endpoint, errText(e));
      }
    }
    throw lastErr;
  }

  // Network height over the healthy endpoints (admitted ones when none is): see pickNetworkHeight.
  async getHeight(): Promise<number> {
    const pool = this.healthy().length > 0 ? this.healthy() : this.admitted();
    if (pool.length === 0) throw new Error('every endpoint is quarantined');
    const results = await Promise.allSettled(pool.map(e => this.fetchOne<{ height?: number }>(e, '/api/v1/height', { method: 'GET' }, 4096, 8_000)));
    const heights: number[] = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') heights.push(Number(r.value.height));
      else this.markFailed(pool[i], errText(r.reason));
    });
    const best = pickNetworkHeight(heights, this.quorum);
    if (best < 0) throw new Error('no endpoint answered /height');
    // Only a quorum of ANSWERS sets the agreed anchor. Fewer than that still schedules work, but a
    // lone endpoint must not define the height everything else is measured against.
    this.noteHeight(best, heights.length >= this.quorum);
    if (heights.length < this.quorum) log.warn('NODE', 'height_below_quorum', { answers: heights.length, quorum: this.quorum, best });
    return best;
  }

  // Compact headers [from, from+limit) from the pinned endpoint (fallback: any healthy one).
  async getHeaders(from: number, limit: number, pin?: string): Promise<HeadersPage & { endpoint: string }> {
    const r = await this.fetchJson<HeadersPage>(
      `/api/v1/blocks/headers?from=${from}&limit=${Math.min(Math.max(limit, 1), 1000)}`,
      { method: 'GET' }, MAX_SMALL_BYTES, 20_000, pin,
    );
    if (!Array.isArray(r.value.items)) throw new Error('headers: items missing');
    this.noteHeight(Number(r.value.head));
    return { ...r.value, endpoint: r.endpoint };
  }

  // The same header page from every ADMITTED endpoint: chain-identity decisions need agreement.
  // Every admitted endpoint is asked at once. The read returns when all have answered, or when a
  // quorum has and the rest have had FANOUT_GRACE_MS: one silent endpoint must not put its whole
  // timeout under every decision. An endpoint that fails or is left behind takes a cooldown.
  async getHeadersFromAll(from: number, limit: number): Promise<Array<{ endpoint: string; page: HeadersPage }>> {
    const path = `/api/v1/blocks/headers?from=${from}&limit=${Math.min(Math.max(limit, 1), 1000)}`;
    const pool = this.admitted();
    const out: Array<{ endpoint: string; page: HeadersPage }> = [];
    const done = new Set<string>();
    let settled = 0;
    await new Promise<void>(resolve => {
      let finished = false;
      const finish = () => { if (!finished) { finished = true; clearTimeout(grace); resolve(); } };
      const grace = setTimeout(() => { if (out.length >= this.quorum) finish(); }, FANOUT_GRACE_MS);
      for (const e of pool) {
        this.fetchOne<HeadersPage>(e, path, { method: 'GET' }, MAX_SMALL_BYTES, 20_000)
          .then(v => { if (Array.isArray(v.items)) out.push({ endpoint: e, page: v }); })
          .catch(err => { this.markFailed(e, `headers: ${errText(err)}`); })
          .finally(() => {
            done.add(e); settled += 1;
            if (settled === pool.length) finish();
            else if (out.length >= this.quorum && settled >= pool.length - 1) finish();
          });
      }
      if (pool.length === 0) finish();
    });
    for (const e of pool) if (!done.has(e)) this.markFailed(e, 'headers: left behind the quorum');
    return out;
  }

  // Headers [from, from+limit) from every admitted endpoint, reduced to what a quorum names.
  async getQuorumHeaders(from: number, limit: number): Promise<QuorumHeaders> {
    const views = await this.getHeadersFromAll(from, limit);
    const out = reduceHeaderViews(views, this.quorum, this.honestOne);
    // A page a quorum answered carries a quorum-th head: as good an anchor as the height poll.
    if (out.head > 0) this.noteHeight(out.head, views.length >= this.quorum);
    const bodyless = out.items.filter(i => !i.body).length;
    if (bodyless > 0 && limit > 1) log.info('NODE', 'headers_without_body', { from, count: bodyless, need: this.honestOne });
    return out;
  }

  async getBlock(height: number, pin?: string): Promise<NodeBlock | null> {
    return (await this.getBlockFrom(height, pin))?.block ?? null;
  }

  // The block and the endpoint that actually answered — the pin may have been down and the read
  // fallen through to another, and a fault in the body belongs to whoever sent it.
  async getBlockFrom(height: number, pin?: string): Promise<{ block: NodeBlock; endpoint: string } | null> {
    try {
      const r = await this.fetchJson<NodeBlock & { block?: NodeBlock; error?: string }>(
        `/api/v1/microblock/${height}`, { method: 'GET' }, MAX_BLOCK_BYTES, 30_000, pin,
      );
      const b = (r.value.block ?? r.value) as NodeBlock;
      if (r.value.error || typeof b.height !== 'number') return null;
      if (b.height !== height) throw new Error(`block height mismatch want=${height} got=${b.height}`);
      return { block: b, endpoint: r.endpoint };
    } catch (e) {
      if (e instanceof NotFoundError) return null;
      throw e;
    }
  }

  async getTokenTransfersPage(from: number, to: number, limit: number, after: string | null, pin?: string): Promise<{ transfers: unknown[]; truncated: boolean; next_cursor: string | null }> {
    const q = `/api/v1/token-transfers?from=${from}&to=${to}&limit=${limit}` + (after ? `&after=${encodeURIComponent(after)}` : '');
    const r = await this.fetchJson<{ transfers?: unknown[]; truncated?: boolean; next_cursor?: unknown }>(q, { method: 'GET' }, MAX_SMALL_BYTES, 15_000, pin);
    return {
      transfers: Array.isArray(r.value.transfers) ? r.value.transfers : [],
      truncated: !!r.value.truncated,
      next_cursor: typeof r.value.next_cursor === 'string' && r.value.next_cursor ? r.value.next_cursor : null,
    };
  }

  // Block subscription: one socket at a time, exponential reconnect, and a watchdog that drops a
  // socket delivering no TIP block for WS_EVENT_SILENCE_MS — a wedged node still answers pings and a
  // replaying node streams old heights — so the subscription rotates to the next endpoint.
  subscribe(onBlock: (ev: NewBlockEvent) => void, onState: (connected: boolean, endpoint: string) => void): () => void {
    let stopped = false;
    let delay = 1_000;
    let idx = 0;
    let hb: NodeJS.Timeout | null = null;
    let reconnectTimer: NodeJS.Timeout | null = null;

    const clearHb = () => { if (hb) { clearInterval(hb); hb = null; } };
    const scheduleReconnect = (why: string) => {
      if (stopped || reconnectTimer) return;
      log.warn('NODE', 'ws_reconnect', { in_ms: delay, why });
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
      delay = Math.min(delay * 2, 30_000);
    };
    const connect = () => {
      if (stopped) return;
      const candidates = this.healthy().length > 0 ? this.healthy() : (this.admitted().length > 0 ? this.admitted() : this.endpoints);
      const endpoint = candidates[idx++ % candidates.length];
      const url = endpoint.replace(/^http/, 'ws') + '/ws/subscribe?channels=blocks';
      let sock: WebSocket;
      try { sock = new WebSocket(url, { headers: this.headers }); } catch (e) { scheduleReconnect(errText(e)); return; }
      this.wsSocket = sock;
      const opened = Date.now();
      let windowStart = opened;
      let windowEvents = 0;
      sock.on('open', () => {
        delay = 1_000;
        this.wsEndpoint = endpoint;
        this.lastTipEventAt = 0;
        onState(true, endpoint);
        log.info('NODE', 'ws_connected', { endpoint });
        clearHb();
        hb = setInterval(() => {
          if (sock.readyState !== WebSocket.OPEN) return;
          const last = Math.max(this.lastTipEventAt, opened);
          if (Date.now() - last > WS_EVENT_SILENCE_MS) { log.warn('NODE', 'ws_no_tip_blocks', { endpoint, silent_ms: Date.now() - last }); sock.terminate(); return; }
          sock.ping();
        }, 15_000);
      });
      sock.on('message', (data: WebSocket.Data) => {
        const text = data.toString();
        if (text.length > 65_536) return;
        let msg: { type?: string; data?: Partial<NewBlockEvent> };
        try { msg = JSON.parse(text); } catch { return; }
        if (msg.type !== 'NewBlock' || !msg.data) return;
        const d = msg.data;
        const height = Number(d.height);
        if (!Number.isSafeInteger(height) || height < 0 || typeof d.hash !== 'string' || !/^[0-9a-f]{64}$/.test(d.hash)) return;
        // A height the network cannot have yet is not a block; a socket flooding events is not a node.
        if (height > this.maxSeen + HEIGHT_SLACK) return;
        const now = Date.now();
        if (now - windowStart >= 1_000) { windowStart = now; windowEvents = 0; }
        if (++windowEvents > WS_MAX_EVENTS_PER_SEC) {
          log.warn('NODE', 'ws_event_flood', { endpoint, per_sec: windowEvents });
          this.markFailed(endpoint, 'ws event flood');
          sock.terminate();
          return;
        }
        // Only a block at the network tip proves the source is live; a replay of old heights does not.
        if (height >= this.maxSeen - 1) this.lastTipEventAt = now;
        this.noteHeight(height);
        onBlock({ height, hash: d.hash, timestamp: Number(d.timestamp) || 0, tx_count: Number(d.tx_count) || 0, producer: String(d.producer || ''), endpoint });
      });
      sock.on('close', (code: number) => {
        clearHb();
        if (this.wsSocket === sock) this.wsSocket = null;
        if (this.wsEndpoint === endpoint) this.wsEndpoint = null;
        onState(false, endpoint);
        scheduleReconnect(`close code=${code}`);
      });
      sock.on('error', (e: Error) => { log.warn('NODE', 'ws_error', { endpoint, err: errText(e) }); });
    };
    connect();
    return () => {
      stopped = true;
      clearHb();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (this.wsSocket) { try { this.wsSocket.close(); } catch { /* closing */ } }
    };
  }
}

// One header page per endpoint, reduced to what the endpoints agree on:
//  • a height exists with the hash at least `quorum` of them name;
//  • a field the hash does not carry (merkle root, transaction count, producer, time) is taken only
//    when at least `honestOne` of those endpoints name the same value — the smallest agreement that
//    must contain an honest endpoint. A body fewer than that claim is a pruned row: its transactions
//    would rest on a minority's word.
//  • the page head is the quorum-th highest claim, so one endpoint cannot invent a range.
export function reduceHeaderViews(
  views: Array<{ endpoint: string; page: HeadersPage }>, quorum: number, honestOne: number,
): QuorumHeaders {
  const byHeight = new Map<number, Map<string, Set<string>>>();
  const detail = new Map<string, NodeHeader[]>();
  const bodySources = new Map<number, string[]>();
  const head = Math.max(0, pickNetworkHeight(views.map(v => Number(v.page.head)), quorum));
  for (const v of views) {
    const seen = new Set<number>();
    for (const it of v.page.items) {
      if (it.error || !Number.isSafeInteger(it.height) || seen.has(it.height)) continue;
      seen.add(it.height);
      if (!/^[0-9a-f]{64}$/.test(it.hash || '')) continue;
      const perHash = byHeight.get(it.height) ?? new Map<string, Set<string>>();
      (perHash.get(it.hash as string) ?? perHash.set(it.hash as string, new Set()).get(it.hash as string)!).add(v.endpoint);
      byHeight.set(it.height, perHash);
      const key = `${it.height}:${it.hash}`;
      (detail.get(key) ?? detail.set(key, []).get(key)!).push(it);
      if (it.body) (bodySources.get(it.height) ?? bodySources.set(it.height, []).get(it.height)!).push(v.endpoint);
    }
  }
  const items: NodeHeader[] = [];
  for (const [height, perHash] of byHeight) {
    const agreed = [...perHash.entries()].find(([, eps]) => eps.size >= quorum);
    if (!agreed) { bodySources.delete(height); continue; }
    const [hash] = agreed;
    const headers = detail.get(`${height}:${hash}`) ?? [];
    const pick = <T>(get: (h: NodeHeader) => T | undefined): T | undefined => {
      const tal = new Map<string, { v: T; n: number }>();
      for (const h of headers) {
        const v = get(h);
        if (v === undefined || v === null) continue;
        const k = String(v);
        const e = tal.get(k) ?? { v, n: 0 };
        e.n += 1; tal.set(k, e);
      }
      const best = [...tal.values()].sort((a, b) => b.n - a.n)[0];
      return best && best.n >= honestOne ? best.v : undefined;
    };
    const root = pick(h => (h.body ? h.merkle_root : undefined));
    const count = pick(h => (h.body ? h.tx_count : undefined));
    const hasBody = headers.filter(h => h.body).length >= honestOne && root !== undefined && count !== undefined;
    if (!hasBody) bodySources.delete(height);
    items.push({
      height, hash, body: hasBody,
      merkle_root: hasBody ? root : undefined,
      tx_count: hasBody ? count : undefined,
      producer: hasBody ? pick(h => (h.body ? h.producer : undefined)) : undefined,
      previous_hash: pick(h => h.previous_hash),
      timestamp: hasBody ? pick(h => (h.body ? h.timestamp : undefined)) : undefined,
    });
  }
  items.sort((a, b) => a.height - b.height);
  return { items, bodySources, head, endpoints: views.length, quorum };
}

export class NotFoundError extends Error {}
