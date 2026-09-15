import { Client } from 'pg';
import { getExplorerStats, getSyncStatus, listTransactions, type ExplorerStats, type SyncStatus } from '../../lib/db';
import { enrichActivityRows, type EnrichedActivityRow } from '@/lib/enrich-activity';

// One LISTEN connection per web process. Every new head the indexer commits refreshes a process-wide
// snapshot (stats, sync state, the default first page) exactly once; page renders, /api/head, /api/activity
// page 1 and every SSE subscriber read that snapshot. N viewers cost one query per block, not N.

export interface HeadSnapshot {
  version: number;
  height: number;
  hash: string | null;
  timestamp: number;
  stats: ExplorerStats;
  sync: SyncStatus;
  rows: EnrichedActivityRow[];
  updatedAt: number;
}

type Listener = (snap: HeadSnapshot) => void;

const CHANNEL = 'explorer_head';
const FALLBACK_POLL_MS = 5_000;
const MAX_ROWS = 50;

class HeadHub {
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
    if (!url) return;
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
        const [stats, sync, page] = await Promise.all([
          getExplorerStats(),
          getSyncStatus(),
          listTransactions({ limit: MAX_ROWS, sort: 'desc', direction: 'next' }),
        ]);
        const rows = await enrichActivityRows(page.transactions);
        this.version += 1;
        this.snap = { version: this.version, height: stats.head_height, hash: stats.head_hash, timestamp: stats.head_timestamp, stats, sync, rows, updatedAt: Date.now() };
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

// Survives Next.js module re-evaluation in dev; one instance per process in production.
const g = globalThis as unknown as { __qnetHeadHub?: HeadHub };
export const headHub: HeadHub = g.__qnetHeadHub ?? (g.__qnetHeadHub = new HeadHub());
