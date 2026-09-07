import type { Pool } from 'pg';
import { NodeClient, HEIGHT_SLACK, type NewBlockEvent, type NodeHeader, type QuorumHeaders } from './node-client';
import { Writer } from './writer';
import { shapeBlock, shapedDigest, blockRowFromHeader, isHex64, toMs, merkleRootOf, type BlockRow, type ShapedBlock } from './transform';
import { fetchTokenTransfersAgreed, replaceTokenTransfers } from './token-transfers';
import { log, errText } from './log';

// Chain follower. head = highest stored block, prefix = every height ≤ it is stored, every other hole is
// a sync_gaps range. Nothing enters the archive that a quorum of endpoints does not name: identity comes
// from a header page every admitted endpoint answers, and a body only from one of them that reports
// holding it, accepted only when its transaction hashes rebuild the merkle root that quorum named. A
// stored identity changes only where the quorum contradicts it. One write mutex; a rollback bumps the
// epoch so a commit whose fetch predates it is dropped.

export const REORG_LIMIT = 5_000;
export const RETENTION_BLOCKS = 6 * 14_400;        // MICROBLOCK_BODY_RETENTION_BLOCKS on the node
export const FLUSH_BLOCKS = 200;                    // blocks per transaction
export const FLUSH_BATCH_ROWS = 150_000;            // estimated recipient rows per transaction
const CHUNK = 1_000;                                // headers per request
const FULL_FETCH_CONCURRENCY = 4;
const POLL_MS = 2_000;                              // height poll while the subscription is down
const POLL_SILENT_MS = 10_000;                      // height poll while it is up but quiet
const HEIGHT_REFRESH_MS = 30_000;                   // agreed height refresh even when blocks flow
const WS_SILENCE_MS = 10_000;
const HEAD_QUEUE_MAX = 64;                          // pending head jobs; catch-up covers what is dropped
const HEAL_INTERVAL_MS = 60_000;
const HEAL_IDLE_MS = 600_000;
const HEAL_CANDIDATES = 2_000;
const SHORT_SCAN_WINDOW = 20_000;       // heights per pass for the short-body scan
const SAMPLE_INTERVAL_MS = 600_000;
const ANCHOR_RECHECK_MS = 1_800_000;    // the chain under the archive can be replaced without a contradiction
const SAMPLE_SIZE = 32;
const QUARANTINE_MS = 1_800_000;
const LAG_WARN = 3_600;
const PREFIX_RECHECK = 5_000;

interface StoredLink { height: number; hash: string | null; previous_hash: string | null; merkle_root: string | null; body_indexed: boolean; tx_count: number | null }
interface Vote { endpoint: string; hash: string }

export class Chain {
  private head = -1;
  private prefix = -1;
  private nodeHeight = 0;
  private genesisTsMs = 0;
  private genesisTsUnconfirmed = false;
  private genesisKnown = false;
  private wsConnected = false;
  private endpoint: string | null = null;
  private lastWsEvent = 0;
  private lastPoll = 0;
  private lastHeightRefresh = 0;
  private headQueue: Promise<void> = Promise.resolve();
  private headPending = 0;
  private writeLock: Promise<void> = Promise.resolve();
  private epoch = 0;
  private stopped = false;
  private catchUpRunning = false;
  private healRunning = false;
  private healIdleUntil = 0;
  private halted: string | null = null;
  private timers: NodeJS.Timeout[] = [];
  private unsubscribe: (() => void) | null = null;
  private healPending = 0;
  private shortScanFrom = 0;
  private emptyQuorumPages = 0;
  private readonly pendingGaps: Array<[number, number, number]> = [];   // ranges owed to the gap ledger
  private lastBehindLog = 0;
  private lastLagLog = 0;
  private lastQueueLog = 0;

  constructor(private readonly node: NodeClient, private readonly writer: Writer, private readonly pool: Pool) {}

  status() {
    return { head: this.head, prefix: this.prefix, nodeHeight: this.nodeHeight, wsConnected: this.wsConnected, endpoint: this.endpoint, halted: this.halted, healPending: this.healPending };
  }

  async start(): Promise<void> {
    const synced = await this.writer.syncHeadFromTable();
    this.head = synced.head;
    this.prefix = synced.prefix;
    const g = await this.pool.query<{ genesis_hash: string | null }>('SELECT genesis_hash FROM sync_state WHERE id = 1');
    this.genesisKnown = isHex64(g.rows[0]?.genesis_hash);
    try {
      this.nodeHeight = await this.node.getHeight();
      this.lastHeightRefresh = Date.now();
    } catch (e) {
      // A moment with no endpoint answering is not a reason to die: the poll supplies the height.
      log.warn('INDEXER', 'boot_height_unavailable', { err: errText(e) });
    }
    await this.confirmGenesisAnchor();
    await this.loadGenesisTs();
    await this.rederiveGaps();
    log.info('INDEXER', 'start', { head: this.head, prefix: this.prefix, node_height: this.nodeHeight, endpoints: this.node.endpointCount, genesis_ts: this.genesisTsMs });
    if (this.nodeHeight > this.head) await this.recordGap(this.head + 1, this.nodeHeight);

    this.unsubscribe = this.node.subscribe(
      ev => {
        if (ev.height > this.nodeHeight + HEIGHT_SLACK) return;
        // Only a block above the archive head proves the source is live; a replay of history does not.
        if (ev.height > this.head) this.lastWsEvent = Date.now();
        if (ev.height < this.head - REORG_LIMIT) return;
        if (this.headPending >= HEAD_QUEUE_MAX) {
          if (Date.now() - this.lastQueueLog > 60_000) { this.lastQueueLog = Date.now(); log.warn('INDEXER', 'head_queue_full', { pending: this.headPending, endpoint: ev.endpoint }); }
          return;
        }
        void this.enqueueHead(() => this.onNewBlock(ev));
      },
      (connected, endpoint) => { this.wsConnected = connected; this.endpoint = endpoint; },
    );
    this.timers.push(setInterval(() => void this.pollTick(), POLL_MS));
    this.timers.push(setInterval(() => void this.catchUpTick(), 1_000));
    this.timers.push(setInterval(() => void this.healTick(), HEAL_INTERVAL_MS));
    this.timers.push(setInterval(() => void this.publishState(), 5_000));
    this.timers.push(setInterval(() => void this.enqueueHead(() => this.sampleTick()), SAMPLE_INTERVAL_MS));
    // A relaunch replaces the chain under the archive without contradicting any height it holds, so
    // the anchor is re-asked periodically, not only when it has never been confirmed.
    this.timers.push(setInterval(() => void this.enqueueHead(async () => { await this.anchorSaysFreshGenesis(); }), ANCHOR_RECHECK_MS));
    setTimeout(() => void this.healTick(), 10_000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    if (this.unsubscribe) this.unsubscribe();
    await this.headQueue.catch(() => undefined);
    await this.writeLock.catch(() => undefined);
  }

  // ── serialization ───────────────────────────────────────────────────────────────────────────────

  private enqueueHead(job: () => Promise<void>): Promise<void> {
    this.headPending++;
    const next = this.headQueue
      .then(job)
      .catch(e => log.err('INDEXER', 'head_job_failed', { err: errText(e) }))
      .finally(() => { this.headPending--; });
    this.headQueue = next;
    return next;
  }

  // Every database write runs here, one at a time. Not re-entrant: callers never nest it.
  private withWrite<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeLock.then(fn, fn);
    this.writeLock = run.then(() => undefined, () => undefined);
    return run;
  }

  // Any page that reduced is proof the endpoints still agree on something: it lifts a halt, and it is
  // recorded before the halt can gate the caller, so the state is never terminal.
  private noteQuorumProgress(): void {
    if (this.halted) log.warn('INDEXER', 'halt_lifted', { was: this.halted });
    this.emptyQuorumPages = 0;
    this.halted = null;
  }

  // A single source moves the local view only within HEIGHT_SLACK of the last AGREED height, so no
  // endpoint can walk it upward one answer at a time.
  private bumpHeight(h: number): void {
    if (!Number.isSafeInteger(h) || h <= this.nodeHeight) return;
    if (h <= this.node.agreedHeight + HEIGHT_SLACK) this.nodeHeight = h;
  }

  // ── head path ───────────────────────────────────────────────────────────────────────────────────

  private async onNewBlock(ev: NewBlockEvent): Promise<void> {
    if (this.stopped || this.halted || !this.node.isHealthy(ev.endpoint)) return;
    this.bumpHeight(ev.height);
    if (ev.height <= this.head) {
      const s = (await this.storedLinks([ev.height])).get(ev.height);
      if (s && s.hash === ev.hash) return;                       // duplicate delivery
      if (s && s.hash && s.hash !== ev.hash) {
        // One frame is one endpoint's claim. A single-height vote is five small requests; the repair
        // walk is thousands, so the cheap evidence comes first.
        const votes = await this.votesAt(ev.height);
        const against = votes.filter(v => v.hash !== s.hash).length;
        if (against >= this.node.quorum) await this.repairContradictedRun(ev.height, `a quorum names another block at ${ev.height}`);
        else {
          // The announcement did not survive one vote round. It costs the announcer a cooldown, so a
          // stream of them cannot keep the head queue busy.
          this.node.markFailed(ev.endpoint, `announced an unconfirmed hash at ${ev.height}`);
          log.warn('INDEXER', 'event_hash_unconfirmed', { h: ev.height, against, votes: votes.length, endpoint: ev.endpoint });
        }
        return;
      }
      if (!s) await this.recordGap(ev.height, ev.height);       // a hole announced itself
      return;
    }
    if (ev.height > this.head + 1) await this.recordGap(this.head + 1, ev.height - 1);
    const missing = await this.ingestRange(ev.height, ev.height, 'head');
    for (const r of ranges(missing)) await this.recordGap(r[0], r[1]);
  }

  private async pollTick(): Promise<void> {
    if (this.stopped) return;
    if (this.halted) {
      // Halted means the endpoints disagreed about everything. Keep asking: the moment one page
      // reduces again the halt lifts, and nothing else in the follower can do that.
      try {
        const probe = await this.node.getQuorumHeaders(Math.max(0, this.head), 1);
        if (probe.items.length > 0) this.noteQuorumProgress();
      } catch (e) {
        log.warn('INDEXER', 'halt_probe_failed', { err: errText(e) });
      }
      return;
    }
    const now = Date.now();
    const quiet = this.wsConnected && now - this.lastWsEvent < WS_SILENCE_MS;
    const due = quiet ? now - this.lastHeightRefresh >= HEIGHT_REFRESH_MS
      : now - this.lastPoll >= (this.wsConnected ? POLL_SILENT_MS : POLL_MS);
    if (!due) return;
    this.lastPoll = now;
    let h: number;
    try { h = await this.node.getHeight(); } catch (e) { log.warn('INDEXER', 'poll_height_failed', { err: errText(e) }); return; }
    this.lastHeightRefresh = Date.now();
    this.nodeHeight = h;
    if (this.genesisTsMs === 0 || this.genesisTsUnconfirmed) await this.loadGenesisTs();
    if (quiet) return;
    if (h > this.head) {
      await this.enqueueHead(async () => {
        if (h > this.head + 1) await this.recordGap(this.head + 1, h - 1);
        if (h > this.head) {
          const missing = await this.ingestRange(h, h, 'poll');
          for (const r of ranges(missing)) await this.recordGap(r[0], r[1]);
        }
      });
    } else if (h < this.head && now - this.lastBehindLog > 60_000) {
      // The agreed height is below the archive: nodes catching up, or a rollback. A rollback shows
      // itself as a different hash at a height they hold; a lower height alone never touches the archive.
      this.lastBehindLog = now;
      log.warn('INDEXER', 'network_below_archive', { node_height: h, head: this.head });
    }
  }

  // ── ingest ──────────────────────────────────────────────────────────────────────────────────────

  // Fetch [a, b] from one endpoint (headers for identity, full blocks where there are transactions),
  // commit under the write lock, then verify linkage against the stored neighbours. Returns heights
  // that are still missing: not held by the node, dropped by an epoch change, or withdrawn because the
  // seam they created could not be settled in the endpoint's favour.
  private async ingestRange(a: number, b: number, source: string, prefetched?: QuorumHeaders, epochAt?: number): Promise<number[]> {
    const all = () => Array.from({ length: b - a + 1 }, (_, i) => a + i);
    const epoch0 = epochAt ?? this.epoch;
    const page = prefetched ?? await this.node.getQuorumHeaders(a, b - a + 1);
    this.bumpHeight(page.head);
    // Only heights a quorum of endpoints names identically are here; the rest stay gaps.
    let items = page.items.filter(h => h.height >= a && h.height <= b);
    if (items.length > 0) this.noteQuorumProgress();
    if (items.length === 0 && b <= page.head && page.endpoints >= this.node.quorum) {
      // The endpoints answered about a range they say exists and agreed on nothing: they are on
      // different chains, or every row here is unreadable. Said out loud after a long streak, and
      // taken back the moment any page reduces again.
      this.emptyQuorumPages += 1;
      if (this.emptyQuorumPages >= 20 && !this.halted) {
        this.halted = `no quorum on any height in ${a}..${b}: endpoints=${page.endpoints} quorum=${this.node.quorum}`;
        log.err('INDEXER', 'halted', { why: this.halted });
      } else {
        log.warn('INDEXER', 'quorum_page_empty', { a, b, endpoints: page.endpoints, quorum: this.node.quorum, streak: this.emptyQuorumPages });
      }
      return all();
    }

    // Slot times are exact (genesis + height·1 s). A header that disagrees loses its own height; the
    // rest of the page is unaffected, so one bad answer cannot stop the archive.
    if (this.genesisTsMs > 0) {
      const before = items.length;
      items = items.filter(i => !i.body || toMs(i.timestamp) === this.genesisTsMs + i.height * 1000);
      if (items.length !== before) log.warn('INDEXER', 'header_off_slot', { dropped: before - items.length, a, b });
    }
    const have = new Set(items.map(i => i.height));
    const missing: number[] = [];
    for (let h = a; h <= b; h++) if (!have.has(h)) missing.push(h);

    // A break inside the quorum-agreed page cannot be a fork: it is a bad page. Nothing is stored.
    for (let i = 1; i < items.length; i++) {
      const prev = items[i - 1], cur = items[i];
      if (cur.height === prev.height + 1 && cur.previous_hash && prev.hash && cur.previous_hash !== prev.hash) {
        log.warn('INDEXER', 'quorum_page_unlinked', { h: cur.height, source, endpoints: page.endpoints });
        return all();
      }
    }

    const stored = await this.storedLinks(items.map(i => i.height));
    // A stored identity the node contradicts is a reorg question, never a silent overwrite.
    for (const it of items) {
      const s = stored.get(it.height);
      if (s?.hash && it.hash && s.hash !== it.hash) {
        // A quorum names another block here: the archive's row is the one that has to go.
        await this.repairContradictedRun(it.height, `a quorum names another block at ${it.height}`);
        return all();
      }
    }
    const needFull = items.filter(i => i.body && (i.tx_count || 0) > 0);
    const fetched = await this.fetchFull(needFull, page.bodySources);
    const full = fetched.blocks;
    const haveBody = new Set(full.map(f => f.block.height));
    for (const it of needFull) if (!haveBody.has(it.height)) missing.push(it.height);
    const headersOnly: BlockRow[] = [];
    const hashFixes: Array<[number, string]> = [];
    for (const it of items) {
      if (it.body && (it.tx_count || 0) > 0) continue;
      const s = stored.get(it.height);
      // A stored body is never demoted by a header calling the height empty: the transactions it
      // holds may be older than anything the network still serves.
      if (s?.body_indexed && (s.tx_count ?? 0) > 0) {
        if (!s.hash && isHex64(it.hash)) hashFixes.push([it.height, it.hash as string]);
        continue;
      }
      if (!it.body) {
        // A stored row keeps what it has and can only gain a missing hash; a new pruned row needs the
        // genesis time for its slot timestamp and an identity a quorum names.
        if (s) { if (!s.hash && isHex64(it.hash)) hashFixes.push([it.height, it.hash as string]); continue; }
        if (this.genesisTsMs === 0) { missing.push(it.height); continue; }
      }
      headersOnly.push(blockRowFromHeader(it, this.genesisTsMs));
    }
    if (full.length === 0 && headersOnly.length === 0 && hashFixes.length === 0) return missing.sort((x, y) => x - y);

    const committed = await this.withWrite(async () => {
      if (this.epoch !== epoch0) return false;
      for (const [h, hash] of hashFixes) await this.fixHash(h, hash);
      if (full.length > 0 || headersOnly.length > 0) {
        const res = await this.writer.commit({ full, headersOnly });
        if (res.head > this.head) this.head = res.head;
      }
      return true;
    });
    if (!committed) { log.info('INDEXER', 'commit_dropped_epoch_changed', { a, b, source }); return all(); }

    if (full.length > 0) {
      // The transfer index is bound by nothing a block carries, so a window is replaced only when the
      // endpoints whose rows were the agreed ones for these blocks agree on it too.
      const hs = full.map(f => f.block.height);
      const agreeing = [...new Set(hs.flatMap(h => fetched.served.get(h) ?? []))];
      const windows = agreeing.length >= this.node.honestOne
        ? await fetchTokenTransfersAgreed(this.node, Math.min(...hs), Math.max(...hs), agreeing, this.node.honestOne)
        : [];
      if (windows.length > 0) await this.withWrite(async () => { if (this.epoch === epoch0) await replaceTokenTransfers(this.pool, windows); });
    }
    if (items.length > 0) await this.verifyNeighbours(items[0].height, items[items.length - 1].height);
    return missing.sort((x, y) => x - y);
  }

  // Linkage with whatever is stored right now below `lo` and above `hi`. The stored range came from a
  // quorum, so a break means an OLDER stored row is the odd one: the quorum repair decides which.
  private async verifyNeighbours(lo: number, hi: number): Promise<void> {
    const s = await this.storedLinks([lo - 1, lo, hi, hi + 1].filter(h => h >= 0));
    const below = s.get(lo - 1), first = s.get(lo), last = s.get(hi), above = s.get(hi + 1);
    if (below?.hash && first?.previous_hash && below.hash !== first.previous_hash) {
      await this.repairContradictedRun(lo - 1, `previous_hash of ${lo} != stored ${lo - 1}`);
    } else if (last?.hash && above?.previous_hash && above.previous_hash !== last.hash) {
      await this.repairContradictedRun(hi + 1, `stored ${hi + 1} does not link to ${hi}`);
    }
  }

  // Bodies come from an endpoint that reports holding them; identity and the merkle root are the
  // quorum's, so a body only enters when it rebuilds the root the quorum named.
  // A body enters the archive only when `honestOne` independent endpoints serve the same rows. The
  // merkle root binds the transaction HASHES; their content — the fields the explorer stores — is bound
  // only by agreement, since the node's transaction hash is not reproducible here. Identity, previous
  // hash, root, producer and time all come from the quorum header; the body supplies rows and nothing
  // else. Returns the accepted bodies and, per height, the endpoints whose rows were the agreed ones.
  private async fetchFull(headers: NodeHeader[], bodySources: Map<number, string[]>): Promise<{ blocks: ShapedBlock[]; served: Map<number, string[]> }> {
    const out: ShapedBlock[] = [];
    const served = new Map<number, string[]>();
    if (this.genesisTsMs === 0) return { blocks: out, served };   // rows need the slot time; the heights stay gaps
    const need = this.node.honestOne;
    let i = 0;
    const worker = async () => {
      while (i < headers.length) {
        const h = headers[i++];
        const root = isHex64(h.merkle_root) ? (h.merkle_root as string) : null;
        if (!root) { log.warn('INDEXER', 'body_unverifiable_no_root', { h: h.height }); continue; }
        const sources = (bodySources.get(h.height) ?? []).filter(e => !this.node.isQuarantined(e));
        const ordered = [...sources.filter(e => this.node.isHealthy(e)), ...sources.filter(e => !this.node.isHealthy(e))];
        const byDigest = new Map<string, { shaped: ShapedBlock; from: string[] }>();
        let winner: { shaped: ShapedBlock; from: string[] } | null = null;
        for (const src of ordered) {
          let got;
          try {
            got = await this.node.getBlockFrom(h.height, src);
          } catch (e) {
            log.warn('INDEXER', 'block_fetch_failed', { h: h.height, endpoint: src, err: errText(e) });
            continue;
          }
          if (!got || got.endpoint !== src) { this.node.markFailed(src, `claimed the body at ${h.height} and did not serve it`); continue; }
          const shaped = shapeBlock(got.block, this.genesisTsMs + h.height * 1000);
          if (merkleRootOf(shaped.txHashes) !== root) {
            this.node.quarantine(src, QUARANTINE_MS, `body does not match the quorum merkle root at ${h.height}`);
            continue;
          }
          shaped.block.hash = h.hash ?? shaped.block.hash;
          shaped.block.previous_hash = isHex64(h.previous_hash) ? (h.previous_hash as string) : null;
          shaped.block.merkle_root = root;
          shaped.block.producer = h.producer || 'unknown';
          if (h.tx_count !== undefined) shaped.block.tx_skipped = Math.max(0, h.tx_count - shaped.txs.length);
          const d = shapedDigest(shaped);
          const e = byDigest.get(d) ?? { shaped, from: [] };
          e.from.push(src); byDigest.set(d, e);
          if (e.from.length >= need) { winner = e; break; }
          // Enough left to reach agreement? Otherwise stop asking.
          const remaining = ordered.length - ordered.indexOf(src) - 1;
          if (Math.max(...[...byDigest.values()].map(v => v.from.length)) + remaining < need) break;
        }
        if (!winner) {
          log.warn('INDEXER', 'body_unagreed', { h: h.height, sources: sources.length, need, distinct: byDigest.size });
          continue;
        }
        // Whoever served different rows for the same block served rows the block does not have.
        for (const [d, e] of byDigest) if (e !== winner) for (const src of e.from) this.node.markFailed(src, `served different rows at ${h.height} (${d.slice(0, 8)})`);
        out.push(winner.shaped);
        served.set(h.height, winner.from);
      }
    };
    await Promise.all(Array.from({ length: Math.min(FULL_FETCH_CONCURRENCY, headers.length) }, worker));
    return { blocks: out.sort((x, y) => x.block.height - y.block.height), served };
  }

  // A real hash is written only where none is stored and never over a present one. Callers pass a hash
  // from the quorum page, so the identity is already agreed and no second round of votes is needed
  // (this runs under the write lock — network round-trips do not belong here).
  private async fixHash(height: number, hash: string): Promise<void> {
    await this.pool.query(`UPDATE blocks SET hash = $2 WHERE height = $1 AND (hash IS NULL OR hash !~ '^[0-9a-f]{64}$')`, [height, hash]);
  }

  // Delete [lo, hi] and queue it for a refill. The range is owed from before the delete, so a failed
  // gap write cannot leave a hole the prefix walks over.
  private async dropRange(lo: number, hi: number, why: string): Promise<void> {
    this.pendingGaps.push([lo, hi, 0]);
    await this.withWrite(async () => {
      this.epoch += 1;
      this.head = await this.writer.deleteRange(lo, hi, why);
      this.prefix = Math.min(this.prefix, lo - 1);
    });
    await this.recordGap(lo, hi);
    this.owe(lo, hi, -1);
  }

  // ── reorg ───────────────────────────────────────────────────────────────────────────────────────

  private async votesAt(height: number): Promise<Vote[]> {
    const views = await this.node.getHeadersFromAll(height, 1);
    const out: Vote[] = [];
    for (const v of views) {
      const hash = v.page.items.find(i => i.height === height)?.hash;
      if (isHex64(hash)) out.push({ endpoint: v.endpoint, hash: hash as string });
    }
    return out;
  }

  // Our rows around `at` disagree with the network's identity. Every height in the contiguous run is
  // decided by a quorum of endpoints, never by one page: where a quorum names another body the row is
  // dropped and refilled (the network's body, or an identity-only row where it has pruned it); where a
  // quorum names ours, or no quorum names anything, the walk stops and nothing is touched.
  private async repairContradictedRun(at: number, why: string): Promise<void> {
    // A whole new chain is not repaired block by block: if a quorum names another block at the
    // archive's anchor, the network the archive followed no longer exists.
    if (await this.anchorSaysFreshGenesis()) return;
    const lo = Math.max(0, at - CHUNK);
    const views = [...await this.node.getHeadersFromAll(at, CHUNK), ...(lo < at ? await this.node.getHeadersFromAll(lo, at - lo) : [])];
    // One vote per (endpoint, height): the two pages an endpoint answers must not count twice.
    const tally = new Map<number, Map<string, Set<string>>>();
    for (const v of views) {
      for (const it of dedupeHeaders(v.page.items)) {
        if (it.error || !isHex64(it.hash)) continue;
        const m = tally.get(it.height) ?? new Map<string, Set<string>>();
        (m.get(it.hash as string) ?? m.set(it.hash as string, new Set()).get(it.hash as string)!).add(v.endpoint);
        tally.set(it.height, m);
      }
    }
    const quorumHash = (h: number): string | null => {
      for (const [hash, s] of tally.get(h) ?? []) if (s.size >= this.node.quorum) return hash;
      return null;
    };
    const ours = await this.storedLinks(Array.from({ length: at + CHUNK - lo }, (_, i) => lo + i));
    const drop: number[] = [];
    const judge = (h: number): boolean => {
      const s = ours.get(h);
      const q = quorumHash(h);
      if (!s?.hash || !q || s.hash === q) return false;
      drop.push(h);
      return true;
    };
    for (let h = at; h < at + CHUNK && judge(h); h++) { /* upward */ }
    for (let h = at - 1; h >= lo && judge(h); h--) { /* downward */ }
    drop.sort((x, y) => x - y);
    for (const r of ranges(drop)) await this.dropRange(r[0], r[1], `${why}; a quorum names another block`);
    log.warn('INDEXER', 'contradiction_repaired', { at, dropped: drop.length, endpoints: views.length, quorum: this.node.quorum, why });
  }

  // The identity the archive is anchored to: sync_state.genesis_hash (block 1), else the LOWEST stored
  // block with a real hash. A fresh genesis changes the chain's first blocks, while a fork remnant sits
  // in the middle of history — anchoring deep in the middle would read one stale row as a new network.
  private async genesisAnchor(): Promise<{ height: number; hash: string } | null> {
    const g = await this.pool.query<{ genesis_hash: string | null }>('SELECT genesis_hash FROM sync_state WHERE id = 1');
    if (isHex64(g.rows[0]?.genesis_hash)) return { height: 1, hash: g.rows[0].genesis_hash as string };
    const r = (await this.pool.query<{ height: string; hash: string }>(
      `SELECT height::text, hash FROM blocks WHERE hash ~ '^[0-9a-f]{64}$' ORDER BY height LIMIT 1`)).rows[0];
    return r ? { height: Number(r.height), hash: r.hash } : null;
  }

  // True when a quorum of endpoints names one hash at the anchor and it is not the archive's: the
  // network the archive followed no longer exists, so the archive is rebuilt. Dissenters sit out.
  private async anchorSaysFreshGenesis(): Promise<boolean> {
    const anchor = await this.genesisAnchor();
    if (!anchor) return false;
    const views = await this.votesAt(anchor.height);
    const tal = new Map<string, number>();
    for (const v of views) tal.set(v.hash, (tal.get(v.hash) || 0) + 1);
    const top = [...tal.entries()].sort((x, y) => y[1] - x[1])[0];
    if (!top || top[1] < this.node.quorum || top[0] === anchor.hash) return false;
    for (const v of views) if (v.hash !== top[0]) this.node.quarantine(v.endpoint, QUARANTINE_MS, `minority at the anchor ${anchor.height}`);
    await this.resetForFreshGenesis(`anchor h=${anchor.height} stored=${anchor.hash.slice(0, 12)} network=${top[0].slice(0, 12)} agree=${top[1]}/${views.length}`);
    return true;
  }

  // Block 1's hash, once a quorum of endpoints names the same one. A stored block 1 that the quorum
  // contradicts is a fresh genesis, not a fork: the archive is rebuilt rather than patched.
  private async confirmGenesisAnchor(): Promise<void> {
    if (this.genesisKnown || this.stopped || this.halted) return;
    let votes: Vote[];
    try { votes = await this.votesAt(1); } catch (e) { log.warn('INDEXER', 'genesis_anchor_lookup_failed', { err: errText(e) }); return; }
    const tal = new Map<string, number>();
    for (const v of votes) tal.set(v.hash, (tal.get(v.hash) || 0) + 1);
    const top = [...tal.entries()].sort((x, y) => y[1] - x[1])[0];
    if (!top || top[1] < this.node.quorum) { log.warn('INDEXER', 'genesis_anchor_unconfirmed', { votes: votes.length, quorum: this.node.quorum }); return; }
    const stored = (await this.storedLinks([1])).get(1)?.hash ?? null;
    if (stored && stored !== top[0]) {
      await this.resetForFreshGenesis(`block 1 stored=${stored.slice(0, 12)} network=${top[0].slice(0, 12)} agree=${top[1]}/${votes.length}`);
    }
    await this.writer.setGenesisHash(top[0]);
    this.genesisKnown = true;
    log.info('INDEXER', 'genesis_anchor_set', { hash: top[0].slice(0, 12), agree: top[1], votes: votes.length });
  }

  private async resetForFreshGenesis(why: string): Promise<void> {
    await this.withWrite(async () => {
      this.epoch += 1;
      await this.writer.resetAll(why);
      this.head = -1;
      this.prefix = -1;
      this.genesisTsMs = 0;
      this.genesisKnown = false;
      this.pendingGaps.length = 0;
      this.shortScanFrom = 0;
      this.node.forgetAgreedHeight();
    });
    try { this.nodeHeight = await this.node.getHeight(); } catch { /* the next poll refreshes it */ }
    await this.confirmGenesisAnchor();
    await this.loadGenesisTs();
    await this.recordGap(0, Math.max(0, this.nodeHeight));
  }

  // ── catch-up (gaps) ─────────────────────────────────────────────────────────────────────────────

  // One due gap per tick: the row is claimed (deleted) first, the remainder beyond this chunk goes
  // straight back as due, the chunk is ingested from one endpoint, and whatever is still missing is
  // re-queued with a backoff. A claimed range whose re-queue fails (database error) is owed in memory
  // and written back before anything else is claimed; the prefix never passes an owed range. A crash
  // between claim and re-queue leaves a hole above the prefix, which the boot re-derivation finds.
  private async catchUpTick(): Promise<void> {
    if (this.stopped || this.halted || this.catchUpRunning) return;
    this.catchUpRunning = true;
    try {
      await this.settleOwedGaps();
      // Two claims a tick: the lowest due range moves the prefix; the highest due range still inside the
      // retention window saves bodies before the network drops them, instead of waiting behind history.
      const edge = Math.max(0, this.nodeHeight - RETENTION_BLOCKS);
      const due = await this.pool.query<{ start_h: string; end_h: string; tries: number }>(
        `(SELECT start_h, end_h, tries FROM sync_gaps WHERE next_retry_at <= now() ORDER BY start_h LIMIT 1)
         UNION
         (SELECT start_h, end_h, tries FROM sync_gaps WHERE next_retry_at <= now() AND end_h >= $1 ORDER BY end_h DESC LIMIT 1)`, [edge]);
      if (due.rows.length === 0) { await this.advancePrefix(); return; }
      for (const g of due.rows) await this.drainGap(Number(g.start_h), Number(g.end_h), g.tries);
      await this.advancePrefix();
    } catch (e) {
      log.err('INDEXER', 'catchup_failed', { err: errText(e) });
    } finally {
      this.catchUpRunning = false;
    }
  }

  // One claimed range: its first chunk is ingested, the remainder goes straight back, what is still
  // missing is re-queued with a backoff, and the claim stays owed until every piece is in the ledger.
  private async drainGap(start: number, end: number, tries: number): Promise<void> {
    {
      const g = { tries };
      const claimed = await this.pool.query('DELETE FROM sync_gaps WHERE start_h = $1 AND end_h = $2', [start, end]);
      if (claimed.rowCount !== 1) return;
      const chunkEnd = Math.min(end, start + CHUNK - 1);
      this.pendingGaps.push([start, chunkEnd, g.tries]);
      if (chunkEnd < end) {
        this.pendingGaps.push([chunkEnd + 1, end, 0]);
        await this.requeue(chunkEnd + 1, end, 0, true);
        this.owe(chunkEnd + 1, end, -1);
      }
      let missing: number[];
      try {
        missing = await this.ingestChunk(start, chunkEnd, g.tries);
      } catch (e) {
        log.warn('INDEXER', 'gap_chunk_failed', { start, end: chunkEnd, tries: g.tries + 1, err: errText(e) });
        this.owe(start, chunkEnd, g.tries + 1);
        await this.settleOwedGaps();
        return;
      }
      // Heights no endpoint holds yet (above every tip, or a body every node dropped) wait with a
      // backoff; the claimed chunk stays owed until every one of them is in the ledger.
      for (const r of ranges(missing.sort((x, y) => x - y))) await this.requeue(r[0], r[1], g.tries + 1);
      this.owe(start, chunkEnd, -1);
    }
  }

  // The claimed chunk's in-memory debt: tries ≥ 0 rewrites it as owed with that backoff, −1 clears it.
  private owe(start: number, end: number, tries: number): void {
    const i = this.pendingGaps.findIndex(p => p[0] === start && p[1] === end);
    if (i >= 0) this.pendingGaps.splice(i, 1);
    if (tries >= 0) this.pendingGaps.push([start, end, tries]);
  }

  private async settleOwedGaps(): Promise<void> {
    while (this.pendingGaps.length > 0) {
      const [start, end, tries] = this.pendingGaps[0];
      await this.requeue(start, end, tries);          // throws → stays owed, retried next tick
      this.pendingGaps.shift();
    }
  }

  private async requeue(start: number, end: number, tries: number, immediate = false): Promise<void> {
    await this.pool.query(
      `INSERT INTO sync_gaps (start_h, end_h, tries, next_retry_at)
       VALUES ($1, $2, $3, CASE WHEN $4 THEN now() ELSE now() + make_interval(secs => LEAST(600, 15 * POWER(2, LEAST($3, 6)))) END)
       ON CONFLICT (start_h) DO UPDATE SET end_h = GREATEST(sync_gaps.end_h, EXCLUDED.end_h), tries = EXCLUDED.tries, next_retry_at = EXCLUDED.next_retry_at`,
      [start, end, tries, immediate]);
  }

  // A chunk of a gap from one endpoint: headers per CHUNK, bodies and commits per flush group. Odd
  // retries rotate off the subscription source, even ones come back to it, so a row only one endpoint
  // can serve is reached whichever endpoint that is. Returns the heights still missing, including
  // everything not reached when the follower stops or halts.
  private async ingestChunk(a: number, b: number, _tries: number): Promise<number[]> {
    const missing: number[] = [];
    for (let lo = a; lo <= b; lo += CHUNK) {
      const hi = Math.min(b, lo + CHUNK - 1);
      if (this.halted || this.stopped) { for (let h = lo; h <= hi; h++) missing.push(h); continue; }
      const epoch0 = this.epoch;
      const page = await this.node.getQuorumHeaders(lo, hi - lo + 1);
      const items = page.items.filter(h => h.height >= lo && h.height <= hi);
      const have = new Set(items.map(i => i.height));
      for (let h = lo; h <= hi; h++) if (!have.has(h)) missing.push(h);
      for (const group of flushGroups(items)) {
        if (this.halted || this.stopped) { missing.push(...group.map(i => i.height)); continue; }
        const part: QuorumHeaders = { ...page, items: group };
        missing.push(...await this.ingestRange(group[0].height, group[group.length - 1].height, 'catchup', part, epoch0));
      }
    }
    return missing;
  }

  // The prefix is the last height below the first remaining gap (owed ranges included); written under
  // the write lock so a rollback in flight cannot be overtaken by a stale advance.
  private async advancePrefix(): Promise<void> {
    await this.withWrite(async () => {
      const nextGap = await this.pool.query<{ s: string | null }>('SELECT min(start_h) AS s FROM sync_gaps');
      const s = nextGap.rows[0]?.s;
      const owed = this.pendingGaps.reduce((m, p) => Math.min(m, p[0]), Number.MAX_SAFE_INTEGER);
      const first = Math.min(s === null || s === undefined ? Number.MAX_SAFE_INTEGER : Number(s), owed);
      const candidate = first === Number.MAX_SAFE_INTEGER ? this.head : Math.min(this.head, first - 1);
      if (candidate !== this.prefix) {
        this.prefix = candidate;
        await this.writer.setIndexedPrefix(candidate);
      }
    });
  }

  private async recordGap(start: number, end: number): Promise<void> {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start || start < 0) return;
    // Never owe a range the network has not claimed: one inflated answer would otherwise write
    // millions of heights into the ledger and the catch-up would chase them for good.
    const ceiling = Math.max(this.head, this.node.agreedHeight + HEIGHT_SLACK);
    if (start > ceiling) return;
    end = Math.min(end, ceiling);
    await this.pool.query(
      `INSERT INTO sync_gaps (start_h, end_h) VALUES ($1, $2)
       ON CONFLICT (start_h) DO UPDATE SET end_h = GREATEST(sync_gaps.end_h, EXCLUDED.end_h), next_retry_at = now()`,
      [start, end]);
    if (start <= this.prefix) {
      this.prefix = start - 1;
      await this.pool.query('UPDATE sync_state SET indexed_prefix = $1 WHERE id = 1', [this.prefix]);
    }
  }

  // Holes become gap rows: windowed anti-join from a little below the prefix (an asynchronous commit
  // lost to a crash can leave the prefix ahead of the rows) up to the head.
  private async rederiveGaps(): Promise<void> {
    const WINDOW = 50_000;
    let n = 0;
    const from = Math.max(0, this.prefix - PREFIX_RECHECK);
    for (let lo = from; lo <= this.head; lo += WINDOW) {
      const hi = Math.min(this.head, lo + WINDOW - 1);
      const holes = await this.pool.query<{ h: string }>(
        `SELECT g.h::text AS h FROM generate_series($1::bigint, $2::bigint) g(h) LEFT JOIN blocks b ON b.height = g.h WHERE b.height IS NULL ORDER BY g.h`,
        [lo, hi]);
      for (const r of ranges(holes.rows.map(x => Number(x.h)))) { await this.recordGap(r[0], r[1]); n++; }
    }
    await this.advancePrefix();
    if (n > 0) log.info('INDEXER', 'gaps_rederived', { ranges: n, prefix: this.prefix, head: this.head });
  }

  // ── heal: legacy rows without identity, bodies indexed short, pruned rows back in retention ─────

  private async healTick(): Promise<void> {
    if (this.stopped || this.halted || this.healRunning || Date.now() < this.healIdleUntil) return;
    this.healRunning = true;
    const t0 = Date.now();
    try {
      const inRetention = Math.max(0, this.nodeHeight - RETENTION_BLOCKS + 100);
      const cand = await this.pool.query<{ height: string; reason: string }>(
        `SELECT height::text, reason FROM (
           SELECT height, 'identity' AS reason FROM blocks WHERE hash IS NULL OR hash !~ '^[0-9a-f]{64}$'
           UNION ALL
           SELECT b.height, 'short' FROM blocks b
            WHERE b.height >= $3 AND b.height < $3 + $4 AND b.height >= $1 AND b.body_indexed AND b.tx_count > b.tx_skipped
              AND (SELECT count(*) FROM transactions t WHERE t.block = b.height) < b.tx_count - b.tx_skipped
           UNION ALL
           SELECT height, 'pruned' FROM blocks WHERE NOT body_indexed AND height >= $1
         ) c ORDER BY height DESC LIMIT $2`,
        [inRetention, HEAL_CANDIDATES, Math.max(this.shortScanFrom, inRetention), SHORT_SCAN_WINDOW]);
      // The short-body scan counts transaction rows per block, so it walks the retention window in
      // slices instead of costing a full correlated count every pass.
      this.shortScanFrom = this.shortScanFrom + SHORT_SCAN_WINDOW > this.nodeHeight
        ? inRetention : this.shortScanFrom + SHORT_SCAN_WINDOW;
      this.healPending = cand.rows.length;
      if (cand.rows.length === 0) { this.healIdleUntil = Date.now() + HEAL_IDLE_MS; return; }
      const reason = new Map(cand.rows.map(r => [Number(r.height), r.reason] as const));
      const byReason: Record<string, number> = {};
      for (const r of cand.rows) byReason[r.reason] = (byReason[r.reason] || 0) + 1;
      let changed = 0, unrecoverable = 0;
      for (const r of ranges([...reason.keys()].sort((x, y) => x - y))) {
        for (let lo = r[0]; lo <= r[1] && !this.halted && !this.stopped; lo += CHUNK) {
          const hi = Math.min(r[1], lo + CHUNK - 1);
          const epoch0 = this.epoch;
          // The same quorum page the ingest path uses: a repair must not take one endpoint's word
          // for an identity the archive will then keep forever.
          const page = await this.node.getQuorumHeaders(lo, hi - lo + 1);
          let items = page.items.filter(i => i.height >= lo && i.height <= hi);
          if (this.genesisTsMs > 0) {
            const before = items.length;
            items = items.filter(i => !i.body || toMs(i.timestamp) === this.genesisTsMs + i.height * 1000);
            if (items.length !== before) log.warn('INDEXER', 'heal_header_off_slot', { dropped: before - items.length });
          }
          const stored = await this.storedLinks(items.map(i => i.height));
          const disputed = items.find(it => { const s = stored.get(it.height); return s?.hash && it.hash && s.hash !== it.hash; });
          if (disputed) { await this.repairContradictedRun(disputed.height, `heal: a quorum names another block at ${disputed.height}`); return; }
          for (const group of flushGroups(items)) {
            if (this.halted || this.stopped) break;
            const full = (await this.fetchFull(group.filter(i => i.body && (i.tx_count || 0) > 0), page.bodySources)).blocks;
            const headersOnly: BlockRow[] = [];
            const hashFixes: Array<[number, string]> = [];
            for (const it of group) {
              if (it.body && (it.tx_count || 0) > 0) continue;
              const s = stored.get(it.height);
              if (s?.body_indexed && (s.tx_count ?? 0) > 0) {
                if (!s.hash && isHex64(it.hash)) hashFixes.push([it.height, it.hash as string]);
                continue;
              }
              if (!it.body) {
                // No body on the network: a stored row keeps what it has and gains a missing hash; a row
                // that never existed is recorded as pruned. An identical pruned row is left alone.
                if (s) { if (!s.hash && it.hash) hashFixes.push([it.height, it.hash]); }
                else if (this.genesisTsMs > 0) { headersOnly.push(blockRowFromHeader(it, this.genesisTsMs)); }
                if (s && (s.tx_count ?? 0) > 0 && !s.body_indexed) unrecoverable++;
                continue;
              }
              headersOnly.push(blockRowFromHeader(it, this.genesisTsMs));
            }
            const ok = await this.withWrite(async () => {
              if (this.epoch !== epoch0) return false;
              for (const [h, hash] of hashFixes) await this.fixHash(h, hash);
              changed += hashFixes.length;
              if (full.length > 0 || headersOnly.length > 0) {
                const res = await this.writer.commit({ full, headersOnly });
                if (res.head > this.head) this.head = res.head;
                changed += res.changed;
              }
              return true;
            });
            if (ok && !this.genesisKnown) await this.confirmGenesisAnchor();
          }
        }
      }
      if (changed === 0) this.healIdleUntil = Date.now() + HEAL_IDLE_MS;
      log.info('INDEXER', 'heal_pass', { candidates: cand.rows.length, identity: byReason.identity || 0, short: byReason.short || 0, pruned: byReason.pruned || 0, changed, unrecoverable, ms: Date.now() - t0 });
    } catch (e) {
      log.err('INDEXER', 'heal_failed', { err: errText(e) });
    } finally {
      this.healRunning = false;
    }
  }

  // ── spot check: stored identities against an endpoint other than the live source ────────────────

  // The hash index outlives bodies, so any stored row can be checked, not only the retained window.
  private async sampleTick(): Promise<void> {
    if (this.stopped || this.halted || this.head < 0) return;
    // Random heights, then primary-key probes: independent of how large the archive is.
    const guesses = Array.from({ length: SAMPLE_SIZE * 2 }, () => Math.floor(Math.random() * (this.head + 1)));
    const picks = await this.pool.query<{ height: string; hash: string }>(
      `SELECT height::text, hash FROM blocks WHERE height = ANY($1::bigint[]) AND hash ~ '^[0-9a-f]{64}$' LIMIT $2`,
      [guesses, SAMPLE_SIZE]);
    let checked = 0;
    for (const r of picks.rows) {
      const h = Number(r.height);
      const page = await this.node.getQuorumHeaders(h, 1);
      const it = page.items.find(i => i.height === h);
      if (!isHex64(it?.hash)) continue;
      checked++;
      if (it!.hash !== r.hash) {
        log.warn('INDEXER', 'sample_mismatch', { h, stored: r.hash.slice(0, 12), network: (it!.hash as string).slice(0, 12), endpoints: page.endpoints });
        await this.repairContradictedRun(h, `sample mismatch at ${h}`);
        return;
      }
    }
    log.info('INDEXER', 'sample_ok', { checked });
  }

  // ── helpers ─────────────────────────────────────────────────────────────────────────────────────

  private async storedLinks(heights: number[]): Promise<Map<number, StoredLink>> {
    const m = new Map<number, StoredLink>();
    if (heights.length === 0) return m;
    const res = await this.pool.query<{ height: string; hash: string | null; previous_hash: string | null; merkle_root: string | null; body_indexed: boolean; tx_count: number | null }>(
      'SELECT height::text, hash, previous_hash, merkle_root, body_indexed, tx_count FROM blocks WHERE height = ANY($1::bigint[])', [heights]);
    for (const r of res.rows) {
      m.set(Number(r.height), {
        height: Number(r.height), hash: isHex64(r.hash) ? r.hash : null, previous_hash: isHex64(r.previous_hash) ? r.previous_hash : null,
        merkle_root: isHex64(r.merkle_root) ? r.merkle_root : null, body_indexed: r.body_indexed, tx_count: r.tx_count,
      });
    }
    return m;
  }

  // Slot times are exact, so one height every endpoint holds fixes the archive's clock — but only a
  // value a quorum derives identically is taken, or one endpoint would set every pruned row's time.
  private async loadGenesisTs(): Promise<void> {
    const g = await this.pool.query<{ timestamp: string }>('SELECT timestamp FROM blocks WHERE height = 0');
    const stored = toMs(g.rows[0]?.timestamp);
    const at = Math.max(1, this.nodeHeight - 10);
    const tal = new Map<number, number>();
    try {
      for (const v of await this.node.getHeadersFromAll(at, 1)) {
        const it = v.page.items.find(i => i.height === at);
        const ts = it?.body ? toMs(it.timestamp) : 0;
        if (ts > 0) { const gts = ts - at * 1000; tal.set(gts, (tal.get(gts) || 0) + 1); }
      }
    } catch (e) {
      log.warn('INDEXER', 'genesis_time_lookup_failed', { err: errText(e) });
    }
    for (const [gts, n] of tal) {
      if (n < this.node.quorum) continue;
      // The stored block-0 row is only believed when the network agrees with it: a wrong value there
      // would reject every header against the slot rule and stop the archive dead.
      if (stored > 0 && stored !== gts) log.warn('INDEXER', 'genesis_time_row_disagrees', { stored, network: gts, at });
      this.genesisTsMs = gts;
      this.genesisTsUnconfirmed = false;
      log.info('INDEXER', 'genesis_time_learned', { from_height: at, genesis_ts: gts, agree: n });
      return;
    }
    if (stored > 0) {
      // Usable, but not believed: the poll keeps asking until a quorum names a value.
      this.genesisTsMs = stored;
      this.genesisTsUnconfirmed = true;
      log.warn('INDEXER', 'genesis_time_from_row_unconfirmed', { stored });
      return;
    }
    log.warn('INDEXER', 'genesis_time_unknown', { node_height: this.nodeHeight, answers: tal.size });
  }

  private async publishState(): Promise<void> {
    try {
      await this.writer.setNodeState(this.nodeHeight, this.wsConnected, this.endpoint, this.healPending);
    } catch (e) {
      log.warn('INDEXER', 'state_publish_failed', { err: errText(e) });
    }
    const lag = this.nodeHeight - this.prefix;
    if (lag <= LAG_WARN || Date.now() - this.lastLagLog < 60_000) return;
    this.lastLagLog = Date.now();
    // What matters is not how far the prefix trails but which bodies are about to be lost: gap heights
    // in the older half of the retention window are the ones the network will drop next.
    const lo = Math.max(0, this.nodeHeight - RETENTION_BLOCKS), hi = Math.max(0, this.nodeHeight - RETENTION_BLOCKS / 2);
    let atRisk = 0;
    try {
      const r = await this.pool.query<{ n: string }>(
        'SELECT coalesce(sum(LEAST(end_h, $2::bigint) - GREATEST(start_h, $1::bigint) + 1), 0)::text AS n FROM sync_gaps WHERE end_h >= $1 AND start_h <= $2', [lo, hi]);
      atRisk = Number(r.rows[0]?.n || 0);
    } catch { /* the warning below still says what is known */ }
    if (atRisk > 0) log.err('INDEXER', 'bodies_at_risk', { at_risk: atRisk, from: lo, to: hi, lag, prefix: this.prefix, node_height: this.nodeHeight });
    else log.warn('INDEXER', 'lag', { lag, prefix: this.prefix, head: this.head, node_height: this.nodeHeight });
  }
}

// Sorted heights → inclusive ranges.
export function ranges(sorted: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const h of sorted) {
    const last = out[out.length - 1];
    if (last && h === last[1] + 1) last[1] = h;
    else if (!last || h > last[1]) out.push([h, h]);
  }
  return out;
}

// One header per height, ascending; a page repeating a height is taken at its first occurrence.
export function dedupeHeaders(items: NodeHeader[]): NodeHeader[] {
  const m = new Map<number, NodeHeader>();
  for (const it of items) if (Number.isSafeInteger(it.height) && !m.has(it.height)) m.set(it.height, it);
  return [...m.values()].sort((x, y) => x.height - y.height);
}

// Consecutive groups bounded by FLUSH_BLOCKS blocks and FLUSH_BATCH_ROWS estimated recipient rows
// (a batch envelope fans out to ≤1000 rows per transaction): one commit each.
export function flushGroups(items: NodeHeader[]): NodeHeader[][] {
  const out: NodeHeader[][] = [];
  let cur: NodeHeader[] = [];
  let rows = 0;
  for (const it of items) {
    const w = it.body ? (it.tx_count || 0) * 1000 : 0;
    if (cur.length > 0 && (cur.length >= FLUSH_BLOCKS || rows + w > FLUSH_BATCH_ROWS)) { out.push(cur); cur = []; rows = 0; }
    cur.push(it);
    rows += w;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}
