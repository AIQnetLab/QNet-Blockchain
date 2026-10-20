import { Client } from 'pg';
import { getExplorerStats, getLatestBlocks, getSyncStatus, listTransactions, type ExplorerStats, type SyncStatus } from '../../lib/db';
import { enrichActivityRows, type EnrichedActivityRow } from '@/lib/enrich-activity';
import { RECENT_BLOCKS, recentBlock, type HeadBlockFacts, type RecentBlock } from '@/lib/explorer-view';

// One LISTEN connection per web process. Every new head the indexer commits refreshes a process-wide
// snapshot (stats, sync state, the default first page, the newest blocks) exactly once; page renders, /api/head,
// /api/activity page 1, /api/blocks and every SSE subscriber read that snapshot. N viewers cost one query per block, not N.

export interface HeadSnapshot {
  version: number;
  height: number;
  hash: string | null;
  timestamp: number;
  stats: ExplorerStats;
  sync: SyncStatus;
  rows: EnrichedActivityRow[];
  // The newest RECENT_BLOCKS blocks, newest first, with producer and transaction count.
  blocks: RecentBlock[];
  updatedAt: number;
}

type Listener = (snap: HeadSnapshot) => void;

const CHANNEL = 'explorer_head';
const FALLBACK_POLL_MS = 5_000;
const MAX_ROWS = 50;
// The snapshot's shape: a module reload in dev that changes it replaces the running hub instead of reusing it.
const SHAPE = 2;

class HeadHub {
  readonly shape = SHAPE;
  private stopped = false;
  private snap: HeadSnapshot | null = null;
  private listeners = new Set<Listener>();
  private client: Client | null = null;
  private started = false;
  private refreshing: Promise<void> | null = null;
  private dirty = false;
  private version = 0;
  private fallback: NodeJS.Timeout | null = null;
  private reconnectDelay = 1_000;

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.refresh();
    void this.listen();
    this.fallback = setInterval(() => { if (!this.client) void this.refresh(); }, FALLBACK_POLL_MS);
  }

  // Ends the LISTEN connection and the fallback poll for good (a hub of an older shape, in dev).
  stop(): void {
    this.stopped = true;
    if (this.fallback) clearInterval(this.fallback);
    const c = this.client;
    this.client = null;
    c?.end().catch(() => undefined);
  }

  async snapshot(): Promise<HeadSnapshot> {
    this.start();
    if (this.snap) return this.snap;
    await this.refresh();
    if (!this.snap) throw new Error('head snapshot unavailable');
    return this.snap;
  }

  current(): HeadSnapshot | null { this.start(); return this.snap; }

  subscribe(l: Listener): () => void {
    this.start();
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  }

  get subscriberCount(): number { return this.listeners.size; }

  private async listen(): Promise<void> {
    const url = process.env.DATABASE_URL;
    if (!url || this.stopped) return;
    const c = new Client({ connectionString: url, ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' } : false });
    c.on('error', () => { this.dropListener(c); });
    c.on('end', () => { this.dropListener(c); });
    c.on('notification', () => { void this.refresh(); });
    try {
      await c.connect();
      await c.query(`LISTEN ${CHANNEL}`);
      this.client = c;
      this.reconnectDelay = 1_000;
      console.log(`[INFO][HEADHUB] listening channel=${CHANNEL}`);
      void this.refresh();
    } catch (e) {
      console.warn(`[WARN][HEADHUB] listen_failed err=${JSON.stringify(e instanceof Error ? e.message : String(e))} retry_ms=${this.reconnectDelay}`);
      setTimeout(() => void this.listen(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
    }
  }

  private dropListener(c: Client): void {
    if (this.client !== c) return;
    this.client = null;
    c.end().catch(() => undefined);
    setTimeout(() => void this.listen(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
  }

  // Coalesced: a notification during a refresh schedules exactly one more.
  private refresh(): Promise<void> {
    if (this.refreshing) { this.dirty = true; return this.refreshing; }
    this.refreshing = (async () => {
      try {
        const [stats, sync, page, latest] = await Promise.all([
          getExplorerStats(),
          getSyncStatus(),
          listTransactions({ limit: MAX_ROWS, sort: 'desc', direction: 'next' }),
          getLatestBlocks(RECENT_BLOCKS),
        ]);
        const rows = await enrichActivityRows(page.transactions);
        this.version += 1;
        this.snap = {
          version: this.version, height: stats.head_height, hash: stats.head_hash, timestamp: stats.head_timestamp, stats, sync, rows,
          blocks: latest.map(recentBlock), updatedAt: Date.now(),
        };
        for (const l of this.listeners) { try { l(this.snap); } catch { /* listener owns its errors */ } }
      } catch (e) {
        console.warn(`[WARN][HEADHUB] refresh_failed err=${JSON.stringify(e instanceof Error ? e.message : String(e))}`);
      } finally {
        this.refreshing = null;
        if (this.dirty) { this.dirty = false; void this.refresh(); }
      }
    })();
    return this.refreshing;
  }
}

// The head block's producer and transaction count, when the snapshot's newest block is the head (a refresh's reads can
// see different commits; a list then completes that row from /api/blocks).
export function headBlockFacts(s: HeadSnapshot): HeadBlockFacts | null {
  const b = s.blocks[0];
  return b && b.height === s.height && b.producer !== null ? { producer: b.producer, producerAddress: b.producerAddress, txCount: b.txCount } : null;
}

// The head event of /api/stream and the answer of /api/head, one shape: the head and its block's facts, the counters
// and the sync state.
export function headEvent(s: HeadSnapshot) {
  return {
    v: s.version,
    height: s.height,
    hash: s.hash,
    timestamp: s.timestamp,
    block: headBlockFacts(s),
    txTotal: s.stats.tx_total,
    txByType: s.stats.tx_by_type,
    blocksTotal: s.stats.blocks_total,
    emissionTotal: s.stats.emission_total,
    sync: { head: s.sync.last_height, prefix: s.sync.indexed_prefix, nodeHeight: s.sync.node_height, live: s.sync.ws_connected, healPending: s.sync.heal_pending },
  };
}

// Survives Next.js module re-evaluation in dev while its shape is this one; one instance per process in production.
const g = globalThis as unknown as { __qnetHeadHub?: { shape?: number; stop?: () => void } };
const kept = g.__qnetHeadHub;
if (kept && kept.shape !== SHAPE) kept.stop?.();
export const headHub: HeadHub = kept?.shape === SHAPE ? (kept as HeadHub) : (g.__qnetHeadHub = new HeadHub());
