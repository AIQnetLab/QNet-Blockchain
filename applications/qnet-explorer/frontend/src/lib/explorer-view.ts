// The explorer's presentation rules that are not markup, kept apart so they can be tested: the latest blocks as heads
// arrive, the parts of a list amount, the one name of the signature scheme, what a transaction's side is, how a type
// filter is described and how a search suggestion is written.

import { isAddressShape } from './entity.ts';
import { ago, amount, epochMs, int, qnc, short } from './format.ts';

// ---------------------------------------------------------------- latest blocks

// Blocks of the home page's live column and of the explorer's Latest blocks strip; the head snapshot keeps as many of
// the newest blocks, so every list starts full.
export const RECENT_BLOCKS = 14;

export interface RecentBlock {
  height: number;
  // Unknown for a height the head stream skipped, until a read of the newest blocks fills it (fillBlocks); its row
  // links to the block by height meanwhile.
  hash: string | null;
  timestamp: number | null;
  // The node that made it, null until known; its QNet Blockchain address when the index has it (its link).
  producer: string | null;
  producerAddress: string | null;
  // Its transactions; null while not known, or when the network pruned the body before the index read it.
  txCount: number | null;
}

// A height the stream named and nothing else of it yet.
const bare = (height: number): RecentBlock => ({ height, hash: null, timestamp: null, producer: null, producerAddress: null, txCount: null });

// The list after a new head: the head at the top, any heights it skipped under it, the oldest rows out, so the list
// keeps its length; an empty list (the server could not read the blocks) fills with the heights under the head. A head
// that is not newer changes nothing (it only completes a row the list has without its hash).
export function nextBlocks(current: readonly RecentBlock[], head: RecentBlock, limit: number): RecentBlock[] {
  const top = current[0];
  if (top && head.height <= top.height) {
    if (head.height === top.height && !complete(top) && complete(head)) return [{ ...top, ...head }, ...current.slice(1)];
    return current as RecentBlock[];
  }
  const skipped: RecentBlock[] = [];
  const lowest = top ? Math.max(top.height + 1, head.height - limit + 1) : Math.max(0, head.height - limit + 1);
  for (let h = head.height - 1; h >= lowest; h--) skipped.push(bare(h));
  return [head, ...skipped, ...current].slice(0, limit);
}

// A row of the index's blocks table as the lists keep it (the 64-bit columns can arrive as digit strings).
export function recentBlock(row: {
  height: number | string; hash: string; timestamp: number | string | null; producer?: string | null; producer_address?: string | null; tx_count?: number | string | null;
}): RecentBlock {
  return {
    height: Number(row.height),
    hash: row.hash || null,
    timestamp: Number(row.timestamp) || null,
    producer: row.producer ?? null,
    producerAddress: row.producer_address || null,
    txCount: row.tx_count === null || row.tx_count === undefined ? null : Number(row.tx_count),
  };
}

// The head block's producer, its address when known, and its transaction count, as the head event names them.
export interface HeadBlockFacts {
  producer: string;
  producerAddress: string | null;
  txCount: number | null;
}

// The head stream's block: its height, hash and time, and the producer and transaction count when the event names them.
export function headBlock(head: { height: number; hash: string | null; timestamp: number; block?: HeadBlockFacts | null }): RecentBlock {
  return { ...bare(head.height), hash: head.hash, timestamp: head.timestamp || null, ...(head.block ?? {}) };
}

// A block's transaction count as the live lists write it: "1 tx", "3 txs", "—" while not known.
export function txCountText(count: number | null): string {
  return count === null ? '—' : `${int(count)} ${count === 1 ? 'tx' : 'txs'}`;
}

// A row a read of the newest blocks can still complete: its hash or its producer is not known yet.
const complete = (b: RecentBlock): boolean => b.hash !== null && b.producer !== null;

// The list still lacks something a read of the newest blocks can give: a row it cannot complete alone, or fewer rows
// than its length (the server's list did not come).
export function blocksMissing(list: readonly RecentBlock[], limit: number): boolean {
  return list.length > 0 && (list.length < limit || list.some((b) => !complete(b)));
}

// The newest blocks a read returned, merged into the list by height: a row it cannot complete alone takes the read's,
// a list shorter than its length fills down from its top. The head stream keeps deciding the top, so a read never moves
// it and never adds a row above it; the same list comes back when the read adds nothing.
export function fillBlocks(current: readonly RecentBlock[], read: readonly RecentBlock[], limit: number): RecentBlock[] {
  if (current.length === 0) return current as RecentBlock[];
  const theirs = new Map(read.filter(complete).map((b) => [b.height, b]));
  const mine = new Map(current.map((b) => [b.height, b]));
  const top = current[0].height;
  const out: RecentBlock[] = [];
  for (let h = top; h >= 0 && h > top - limit; h--) {
    const own = mine.get(h);
    const row = own && complete(own) ? own : theirs.get(h) ?? own;
    if (row) out.push(row);
  }
  const same = out.length === current.length && out.every((b, i) => b === current[i]);
  return same ? (current as RecentBlock[]) : out;
}

// ---------------------------------------------------------------- block history (/explorer/blocks)

// Heights a page of the block history shows.
export const BLOCKS_PER_PAGE = 50;

// A block height as people type it ("17,500", "17 500"); null for anything else.
export function heightOf(text: string): number | null {
  const v = text.replace(/[\s,]/g, '');
  if (!/^\d{1,16}$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

// The page that starts at `top`: every height from it down, BLOCKS_PER_PAGE of them (fewer at Genesis), each the read's
// row or, for a height the index does not hold yet, the height alone (it still links to its block).
export function blockWindow(top: number, read: readonly RecentBlock[]): RecentBlock[] {
  const byHeight = new Map(read.map((b) => [b.height, b]));
  const out: RecentBlock[] = [];
  for (let h = top; h >= 0 && h > top - BLOCKS_PER_PAGE; h--) out.push(byHeight.get(h) ?? bare(h));
  return out;
}

// The history's pages count down from `anchor`, the top of page 1, in steps of BLOCKS_PER_PAGE: the anchor for a page
// starting at `top` with the chain at `head` is the highest such top at or under the head, so `top` is a page's first
// row and page 1 is never more than a page behind the head.
export function blocksAnchor(top: number, head: number): number {
  const t = Math.min(Math.max(top, 0), Math.max(head, 0));
  return t + BLOCKS_PER_PAGE * Math.floor((Math.max(head, 0) - t) / BLOCKS_PER_PAGE);
}

// Where `top` sits in the pages counted from `anchor`, how many there are and how many blocks they hold (Genesis is 0).
export function blocksPage(anchor: number, top: number): { page: number; pages: number; total: number } {
  return { page: Math.floor((anchor - top) / BLOCKS_PER_PAGE) + 1, pages: Math.floor(anchor / BLOCKS_PER_PAGE) + 1, total: anchor + 1 };
}

// The first height of page `page` counted from `anchor`.
export const blocksPageTop = (anchor: number, page: number): number => anchor - (page - 1) * BLOCKS_PER_PAGE;

// ---------------------------------------------------------------- ages

// Before this the chain did not exist: a record without a real time is the genesis.
const CHAIN_START_MS = 1_704_067_200_000;

// "now", "5s ago", "3m ago", "2d ago"; "Genesis" for a record without a real time. The index's 64-bit columns can
// arrive as digit strings.
export function ageText(ts: number | string | null | undefined, now: number): string {
  const n = Number(ts);
  if (!n) return 'Genesis';
  const ms = epochMs(n);
  return ms < CHAIN_START_MS ? 'Genesis' : ago(now - ms);
}

// ---------------------------------------------------------------- amounts and names

// An amount as a list writes it: the exact number, its unit, and the token whose page the unit links to (none: QNC).
export interface AmountParts {
  value: string;
  unit: string;
  token?: string | null;
}

// An amount written as text ("12.5 QUSD") split into its number and its unit; one that moves nothing ("0") has none.
export function splitAmount(text: string | null | undefined): AmountParts | null {
  const parts = /^(.*\S)\s+(\S+)$/.exec((text ?? '').trim());
  if (!parts || /^0(\.0+)?$/.test(parts[1])) return null;
  return { value: parts[1], unit: parts[2] };
}

// A list row's amount from its raw values, exact like every other amount on the site (format.ts): a token transfer's
// in the token's decimals with its symbol, else the QNC moved; none for a transaction that moves nothing.
export function rowAmount(row: { amount_raw?: string | null; tokenContract?: string | null; tokenSymbol?: string | null; tokenAmountRaw?: string | null; tokenDecimals?: number | null }): AmountParts | null {
  if (row.tokenContract && row.tokenAmountRaw) {
    const value = amount(row.tokenAmountRaw, row.tokenDecimals ?? 9);
    return value === '0' ? null : { value, unit: row.tokenSymbol || 'Token', token: row.tokenContract };
  }
  const value = qnc(row.amount_raw ?? '0');
  return value === '0' ? null : { value, unit: 'QNC' };
}

// One name for the chain's signature scheme, whatever an older record or node calls it.
const SIGNATURE_NAMES: Record<string, string> = { 'ml-dsa-65': 'ML-DSA-65', mldsa65: 'ML-DSA-65', dilithium3: 'ML-DSA-65', dilithium: 'ML-DSA-65' };

export function signatureName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return SIGNATURE_NAMES[raw.trim().toLowerCase()] ?? raw;
}

export type PartyKind = 'none' | 'address' | 'batch' | 'system' | 'node';

// What a transaction's side is: an address (its page), the batch marker, a system account, or a node id or other name.
export function partyKind(value: string | null | undefined): PartyKind {
  if (!value || value === 'N/A') return 'none';
  if (isAddressShape(value as unknown)) return 'address';
  if (value === 'batch_transfers') return 'batch';
  if (value.startsWith('system_') || value === 'genesis') return 'system';
  return 'node';
}

// A transaction's status as its page writes it, only once its record is read: a record still loading is no pending one.
export function txStatusView(status: string | null | undefined, read: boolean): { value: string; sub: string; done: boolean } | null {
  if (!read) return null;
  return status === 'confirmed' ? { value: 'Confirmed', sub: 'In a block', done: true } : { value: 'Pending', sub: 'Waiting for a block', done: false };
}

// ---------------------------------------------------------------- the list's filter and sort

// The datum beside "All transactions" when the list is not the live first page: what it shows and in which order.
export function listSummary(labels: readonly string[], ascending: boolean, page: number): string {
  const order = ascending ? 'oldest first' : 'newest first';
  const what = labels.length > 0 ? labels.join(', ') : page > 1 ? `Page ${int(page)}` : 'All types';
  return `${what} · ${order}`;
}

// The empty list's sentence.
export function emptyListText(labels: readonly string[]): string {
  return labels.length > 0 ? `No ${labels.join(' or ')} transactions yet` : 'Waiting for activity on QNet Blockchain…';
}

// ---------------------------------------------------------------- search suggestions

export interface Suggestion {
  type: string;
  label: string;
  sublabel?: string;
  href: string;
  symbol?: string;
  address?: string;
  logo?: string;
}

// The entity a suggestion's page names. The server echoes the visitor's query unencoded, so a stray '%' must not throw
// during render: the raw segment stands then.
function hrefEntity(href: string): string {
  const raw = href.split('/').pop() ?? '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// A suggestion as the list writes it: its kind, the entity in its short form (from the page it opens) and a note.
export function suggestionView(s: Suggestion): { kind: string; value: string; note: string } {
  const id = hrefEntity(s.href);
  switch (s.type) {
    case 'block':
      return { kind: 'Block', value: /^\d+$/.test(id) ? int(Number(id)) : short('hash', id), note: /hash/i.test(s.sublabel ?? '') ? 'Found by its hash' : 'Block height' };
    case 'tx':
      return { kind: 'TX', value: short('hash', id), note: /not yet indexed/i.test(s.sublabel ?? '') ? 'Not in the index yet' : 'Transaction' };
    case 'address':
      return { kind: 'Address', value: short('address', id), note: 'Address' };
    case 'token':
      // The note without the contract the server shortens after the name; the token page shows it whole.
      return { kind: 'Token', value: s.symbol || s.label || 'Token', note: (s.sublabel ?? '').replace(/\s*·\s*\S+(…|\.\.\.)\S+$/, '') || 'QRC-20 token' };
    default:
      return { kind: s.type, value: s.label, note: s.sublabel ?? '' };
  }
}
