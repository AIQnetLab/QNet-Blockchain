// The server's Solana reads of activation burns (shared contracts C3.1 and C3.6): one burn checked by its signature
// (final, valid for its burner, node type and amount), and the search of a wallet's own Solana address for the burns it
// made, filtered by their memo and then by who paid for them. Both go through the site's one Solana client
// (src/server/solana-endpoint.ts); a search is kept for SCAN_CACHE_MS per address. Each lane (the page's anonymous
// reads, `public`, and the signed requests, `reserve`: a reservation and an own-burn registration) has budgets of its
// own, so that no flood of reads starves a reservation. A search is charged to the clients the route names (the
// visitor's IP, and for a registration also its node) before it takes anything of the server's: each client at most
// CLIENT_SCANS_PER_MINUTE searches a lane, and of them at most CLIENT_FULL_SCANS_PER_MINUTE that read past the first page
// of signatures (SITE H-5: a QNet wallet costs nothing, so a signed request is no scarce thing). The first page of
// signatures counts against the lane's LIST_PER_MINUTE; only a search that reads further pages or the transactions with
// an activation memo takes one of the lane's SCANS_PER_MINUTE, so an address with no such history (a throwaway one)
// drains nothing scarce. Past any budget a search answers "not complete", which offers no burn.

import { SCAN_BURNS_MAX, SCAN_CACHE_MS, type ScanBurn, type ScanView } from '../../lib/cabinet/burn-record.ts';
import type { NodeType } from '../../lib/qnet-link.ts';
import { createRateLimiter, sweepPeriodically, type RateLimiter } from '../../../lib/rate-limit.ts';
import { statusOf, type Rpc } from '../solana-rpc.ts';
import { holdsOwnBurn, parseBurn, type ActivationBurn } from './burn-parse.ts';

// One page of getSignaturesForAddress, and how many pages a search reads (older pages with `before`).
export const SIGNATURES_MAX = 1000;
export const SIGNATURE_PAGES_MAX = 4;
// The transactions with an activation memo a search reads at most. A transaction someone else paid for (anyone can send
// the address one with such a memo) costs a read but never counts toward SCAN_BURNS_MAX, the address's own.
export const SCAN_READS_MAX = 30;
// Per lane, for the whole server: searches past their first page of signatures, and first pages.
export const SCANS_PER_MINUTE = 30;
export const LIST_PER_MINUTE = 120;
// Per lane, for each client the route names (an IP, IPv6 by its /64; a node).
export const CLIENT_SCANS_PER_MINUTE = 3;
export const CLIENT_FULL_SCANS_PER_MINUTE = 1;
export const SCAN_LANES = ['public', 'reserve'] as const;
export type ScanLane = (typeof SCAN_LANES)[number];
const SCAN_ENTRIES = 5_000;
const MEMO_MARK = 'QNET_NODE_TYPE:';

// final: a finalized, valid burn of the burner; invalid: finalized but no such burn (another payer, memo, mint or
// amount); failed: it failed on chain; pending: seen, not finalized yet; missing: Solana knows no such transaction.
export type BurnCheck =
  | { kind: 'final'; burn: ActivationBurn }
  | { kind: 'invalid' }
  | { kind: 'failed' }
  | { kind: 'pending' }
  | { kind: 'missing' };

export interface BurnExpectation {
  burner: string;
  nodeType?: NodeType;
  amount?: number;
}

const getTx = (rpc: Rpc, signature: string) =>
  rpc('getTransaction', [signature, { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]);

// C3.6: the burn by its signature; null when Solana could not be read.
export async function checkBurn(rpc: Rpc, burnTx: string, expect: BurnExpectation): Promise<BurnCheck | null> {
  try {
    const status = await statusOf(rpc, burnTx);
    if (status === null) return { kind: 'missing' };
    if (status.err) return { kind: 'failed' };
    if (status.confirmationStatus !== 'finalized') return { kind: 'pending' };
    const tx = await getTx(rpc, burnTx);
    if (tx === null) return { kind: 'pending' };
    const burn = parseBurn(tx, expect.nodeType ?? null);
    if (!burn || burn.payer !== expect.burner || (expect.amount !== undefined && burn.amount !== expect.amount)) return { kind: 'invalid' };
    return { kind: 'final', burn };
  } catch {
    return null;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

// The memos of a signature as getSignaturesForAddress lists them ("[20] QNET_NODE_TYPE:LIGHT; [4] note"): whether one
// is an activation memo.
export function carriesActivationMemo(memo: unknown): boolean {
  return typeof memo === 'string' && memo.includes(MEMO_MARK);
}

// The fee payer of a transaction as getTransaction (jsonParsed) gives it.
function feePayerOf(tx: unknown): string | null {
  const message = isObject(tx) && isObject(tx.transaction) && isObject(tx.transaction.message) ? tx.transaction.message : null;
  const first = message && Array.isArray(message.accountKeys) ? message.accountKeys[0] : undefined;
  return typeof first === 'string' ? first : isObject(first) && typeof first.pubkey === 'string' ? first.pubkey : null;
}

// The search of `address` (C3.1): its signatures, newest first in pages of SIGNATURES_MAX (older ones with `before`) up
// to SIGNATURE_PAGES_MAX pages, those with an activation memo that did not fail, read oldest first. Only a transaction
// `address` paid for counts (anyone can send it one with such a memo): the fee payer is checked first, so another
// payer's transactions never fill SCAN_BURNS_MAX, and at most SCAN_READS_MAX are read. `complete` only when every page
// was read to its end and every marked transaction was read. `unusable`: a 1DEV burn of its own (holdsOwnBurn) whose
// memo is no Light or Super one, or that is no valid burn otherwise. A transaction it paid for that burned no 1DEV (a
// transfer a payment request gave such a memo) is no burn and stops nothing, as in the QNet extension's search.
// `further`: asked once, before the search reads past its first page of signatures (a further page, or the first marked
// transaction); false ends it "not complete". Without it the search reads on.
export async function scanAddress(rpc: Rpc, address: string, further: () => boolean = () => true): Promise<ScanView> {
  const incomplete: ScanView = { complete: false, unusable: false, burns: [] };
  const marked: string[] = [];
  let complete = false;
  let before: string | null = null;
  let charged: boolean | null = null;
  const goOn = (): boolean => {
    if (charged === null) charged = further();
    return charged;
  };
  for (let page = 0; page < SIGNATURE_PAGES_MAX; page += 1) {
    if (page > 0 && !goOn()) return incomplete;
    let listed: unknown;
    try {
      const options = before === null ? { limit: SIGNATURES_MAX, commitment: 'finalized' } : { limit: SIGNATURES_MAX, commitment: 'finalized', before };
      listed = await rpc('getSignaturesForAddress', [address, options]);
    } catch {
      return incomplete;
    }
    if (!Array.isArray(listed)) return incomplete;
    for (const s of listed) {
      if (isObject(s) && typeof s.signature === 'string' && s.err === null && carriesActivationMemo(s.memo)) marked.push(s.signature);
    }
    if (listed.length < SIGNATURES_MAX) {
      complete = true;
      break;
    }
    const last: unknown = listed[listed.length - 1];
    if (!isObject(last) || typeof last.signature !== 'string') return incomplete;
    before = last.signature;
  }
  marked.reverse();
  if (marked.length > 0 && !goOn()) return incomplete;
  const burns: ScanBurn[] = [];
  let unusable = false;
  let own = 0;
  let reads = 0;
  for (const signature of marked) {
    if (own >= SCAN_BURNS_MAX || reads >= SCAN_READS_MAX) {
      complete = false;
      break;
    }
    reads += 1;
    let tx: unknown;
    try {
      tx = await getTx(rpc, signature);
    } catch {
      return { complete: false, unusable, burns };
    }
    if (tx === null) {
      complete = false;
      continue;
    }
    if (feePayerOf(tx) !== address) continue;
    own += 1;
    const burn = parseBurn(tx);
    if (!burn || burn.payer !== address) {
      if (holdsOwnBurn(tx, address)) unusable = true;
      continue;
    }
    burns.push({ burnTx: signature, nodeType: burn.nodeType, burnAmount: burn.amount });
  }
  return { complete, unusable, burns };
}

export interface BurnScannerOptions {
  rpc: Rpc;
  now?: () => number;
  cacheMs?: number;
  // SCANS_PER_MINUTE, LIST_PER_MINUTE, CLIENT_SCANS_PER_MINUTE and CLIENT_FULL_SCANS_PER_MINUTE.
  perMinute?: number;
  listPerMinute?: number;
  clientPerMinute?: number;
  clientFullPerMinute?: number;
}

// `scan(address, maxAgeMs, lane, clients)`: a search no older than `maxAgeMs` (the cache's by default), one in flight per
// address whichever lane asked; a search past a budget, or one that did not finish, is not kept. Both lanes share the
// cache, so a reservation's finished search also answers the page, and the page's answers a reservation. `clients`: the
// keys a new search is charged to, each its share of the lane; a search that joins one in flight costs nothing.
export type BurnScanner = (address: string, maxAgeMs?: number, lane?: ScanLane, clients?: readonly string[]) => Promise<ScanView>;

const MINUTE_MS = 60_000;
const CLIENT_ENTRIES = 50_000;

export function createBurnScanner({
  rpc, now = Date.now, cacheMs = SCAN_CACHE_MS, perMinute = SCANS_PER_MINUTE, listPerMinute = LIST_PER_MINUTE,
  clientPerMinute = CLIENT_SCANS_PER_MINUTE, clientFullPerMinute = CLIENT_FULL_SCANS_PER_MINUTE,
}: BurnScannerOptions): BurnScanner {
  const done = new Map<string, { at: number; view: ScanView }>();
  const pending = new Map<string, Promise<ScanView>>();
  // The server's windows: a counter per lane and kind, never a key of an evicting store, so no flood resets one.
  const windows = new Map<string, { start: number; count: number }>();
  const allowed = (key: string, max: number): boolean => {
    const t = now();
    let window = windows.get(key);
    if (!window || t - window.start >= MINUTE_MS) {
      window = { start: t, count: 0 };
      windows.set(key, window);
    }
    window.count += 1;
    return window.count <= max;
  };
  let limiter: RateLimiter | null = null;
  const clientAllowed = (key: string, max: number): boolean => {
    if (!limiter) {
      limiter = createRateLimiter({ maxEntries: CLIENT_ENTRIES, now });
      sweepPeriodically(limiter);
    }
    return limiter.limit(key, max, MINUTE_MS).allowed;
  };
  // Every client's share of the lane (each one counted), then the server's.
  const shared = (kind: 'list' | 'full', lane: ScanLane, clients: readonly string[], clientMax: number, max: number): boolean => {
    const each = clients.map((c) => clientAllowed(`${kind}:${lane}:${c}`, clientMax));
    return each.every(Boolean) && allowed(`${kind}:${lane}`, max);
  };
  return async (address, maxAgeMs = cacheMs, lane = 'public', clients = []) => {
    const hit = done.get(address);
    if (hit && now() - hit.at < Math.min(maxAgeMs, cacheMs)) return hit.view;
    let p = pending.get(address);
    if (!p) {
      if (!shared('list', lane, clients, clientPerMinute, listPerMinute)) return { complete: false, unusable: false, burns: [] };
      const further = () => shared('full', lane, clients, clientFullPerMinute, perMinute);
      p = scanAddress(rpc, address, further).finally(() => pending.delete(address));
      pending.set(address, p);
    }
    const view = await p;
    if (view.complete) {
      done.delete(address);
      if (done.size >= SCAN_ENTRIES) done.delete(done.keys().next().value as string);
      done.set(address, { at: now(), view });
    }
    return view;
  };
}
