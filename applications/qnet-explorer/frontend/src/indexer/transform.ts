import type { NodeBlock, NodeHeader } from './node-client';

// Pure node-JSON → row shaping. No I/O, unit-tested.

export const SLOT_MS = 1000;
export const ZERO_HASH = '0'.repeat(64);

export interface BlockRow {
  height: number;
  hash: string | null;
  timestamp: number;            // ms
  previous_hash: string | null;
  merkle_root: string | null;
  producer: string;
  tx_count: number | null;      // null = body pruned on the network before it was indexed
  tx_skipped: number;           // transactions deliberately not indexed (see transformTransaction)
  total_gas_used: string;
  size_bytes: number;
  body_indexed: boolean;
}

export interface TxRow {
  hash: string;
  from_address: string;
  to_address: string | null;
  amount: string;
  nonce: string;
  block: number;
  tx_index: number;
  timestamp: number;            // ms
  gas_price: string;
  gas_limit: string;
  signature: string | null;
  public_key: string | null;
  dilithium_signature: string | null;
  dilithium_public_key: string | null;
  tx_type: string;
  tx_type_data: Record<string, unknown> | null;
  data: string | null;
  status: string;
  is_quantum_signed: boolean;
}

export interface BatchRow {
  tx_hash: string;
  tx_index: number;
  block: number;
  timestamp: number;
  from_address: string;
  to_address: string;
  amount: string;
}

import { createHash } from 'node:crypto';

const U64_MAX = 18446744073709551615n;
const GAS_COLUMN_MAX = 10n ** 30n - 1n;   // blocks.total_gas_used is NUMERIC(30,0)
const HEX64 = /^[0-9a-f]{64}$/;

export function isHex64(s: unknown): s is string {
  return typeof s === 'string' && HEX64.test(s);
}

export function bytesToHex(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((b: number) => (b & 0xff).toString(16).padStart(2, '0')).join('');
  return '';
}

// Unsigned integer from a JSON number or a digit string (big values arrive quoted, see quoteBigInts).
export function uintString(v: unknown, max: bigint = U64_MAX): string {
  if (typeof v === 'bigint') return v < 0n ? '0' : (v > max ? max.toString() : v.toString());
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return '0';
    const b = BigInt(Math.trunc(v));
    return b > max ? max.toString() : b.toString();
  }
  if (typeof v === 'string' && /^\d+$/.test(v)) {
    const b = BigInt(v);
    return b > max ? max.toString() : b.toString();
  }
  return '0';
}

export function toMs(ts: unknown): number {
  const n = Number(ts) || 0;
  if (n <= 0) return 0;
  return n > 1e12 ? Math.trunc(n) : Math.trunc(n * 1000);
}

// Quote wide integers in the node's JSON before JSON.parse so u64 amounts never pass through a double.
export function quoteBigInts(text: string): string {
  return text.replace(/"(amount|gas_price|gas_limit|nonce|fees_collected|total_gas_used|balance)":\s*(\d{16,})/g, '"$1":"$2"');
}

export function slotTimestampMs(genesisTsMs: number, height: number): number {
  return genesisTsMs + height * SLOT_MS;
}

export function mapTxType(type: unknown): string {
  if (!type) return 'Transfer';
  if (typeof type === 'string') {
    const brace = type.indexOf(' {');
    if (brace > 0) {
      const name = type.substring(0, brace).trim();
      if (name.length > 0 && name.length <= 50) return name;
    }
    if (type.startsWith('{')) {
      try {
        const parsed = JSON.parse(type);
        if (parsed && typeof parsed === 'object') return Object.keys(parsed)[0] || 'Transfer';
      } catch { /* plain string */ }
    }
    return type.length > 50 ? type.substring(0, 50) : type;
  }
  if (typeof type === 'object') return Object.keys(type as object)[0] || 'Transfer';
  return 'Transfer';
}

// Small queryable facts per type. Batch recipients live in batch_transfers, never in the envelope row.
// Only the few fields the explorer shows, each bounded: this object becomes a jsonb column, so an
// unbounded or NUL-bearing value from a node would either bloat the row or fail its commit.
export function extractTxTypeData(rawType: unknown): Record<string, unknown> | null {
  if (!rawType || typeof rawType !== 'object') return null;
  const t = rawType as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const bitmap = t.LightNodeEligibilityBitmap as Record<string, unknown> | undefined;
  if (bitmap && typeof bitmap === 'object') {
    return { genesis_id: clip(bitmap.genesis_id, 128), epoch: num(bitmap.epoch), eligible_count: num(bitmap.eligible_count) };
  }
  const batch = t.BatchTransfers as Record<string, unknown> | undefined;
  if (batch && typeof batch === 'object' && Array.isArray(batch.transfers)) {
    return { batch_id: clip(batch.batch_id, 128), transfer_count: batch.transfers.length };
  }
  return null;
}

// Text bound for a column. A NUL is not storable in Postgres text or jsonb (22P05) and would fail
// the block's commit for good, so it is dropped rather than allowed to wedge the height.
function clip(v: unknown, max: number): string | null {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).replace(/\u0000/g, '');
  if (s === '') return null;
  return s.length > max ? s.substring(0, max) : s;
}

// Everything a body contributes to the archive, in order, under one digest. Two endpoints serving the
// same block produce the same digest; one that altered a field the merkle root does not bind (the
// root covers transaction hashes, not their content) produces another.
export function shapedDigest(s: { txs: TxRow[]; batch: BatchRow[]; txHashes: string[] }): string {
  const h = createHash('sha3-256');
  h.update(JSON.stringify(s.txHashes));
  for (const t of s.txs) h.update(JSON.stringify([t.hash, t.from_address, t.to_address, t.amount, t.nonce, t.gas_price, t.gas_limit, t.tx_type, t.tx_type_data, t.data, t.signature, t.public_key, t.dilithium_signature, t.dilithium_public_key, t.is_quantum_signed]));
  for (const r of s.batch) h.update(JSON.stringify([r.tx_hash, r.tx_index, r.from_address, r.to_address, r.amount]));
  return h.digest('hex');
}

// The node's transaction merkle root: leaf H(0x00||hash), internal H(0x01||left||right) over SHA3-256,
// an odd node duplicated, and H("") for an empty block. The root is inside the block hash, so a body
// that reproduces it is the body that hash names.
export function merkleRootOf(txHashes: string[]): string | null {
  if (txHashes.length === 0) return createHash('sha3-256').digest('hex');
  let level: Buffer[] = [];
  for (const h of txHashes) {
    if (!/^[0-9a-f]{64}$/.test(h)) return null;
    level.push(createHash('sha3-256').update(Buffer.concat([Buffer.from([0]), Buffer.from(h, 'hex')])).digest());
  }
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const l = level[i], r = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(createHash('sha3-256').update(Buffer.concat([Buffer.from([1]), l, r])).digest());
    }
    level = next;
  }
  return level[0].toString('hex');
}

// One node transaction → a row. null = deliberately not indexed (genesis prefund fan-out, benchmark
// accounts) or unusable. The row time is the block time: slot-anchored and consensus-bound.
export function transformTransaction(tx: Record<string, unknown>, blockHeight: number, blockTsMs: number, txIndex: number): TxRow | null {
  const hash = String(tx.hash || '');
  if (hash.length < 8 || hash.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(hash)) return null;
  const fromRaw = tx.from ?? tx.from_address;
  if (typeof fromRaw !== 'string' || fromRaw.length === 0 || fromRaw.length > 128) return null;
  const from = fromRaw;
  const toRaw = tx.to ?? tx.to_address;
  const to = typeof toRaw === 'string' && toRaw.length > 0 ? toRaw : null;
  if (to && to.length > 128) return null;
  if (blockHeight === 0 && from === 'genesis' && to && !to.startsWith('system')) return null;
  if (from.startsWith('EON1benchmark') || (to && to.startsWith('EON1benchmark'))) return null;

  const rawType = tx.tx_type ?? tx.type;
  const timestamp = blockTsMs > 0 ? blockTsMs : toMs(tx.timestamp);
  return {
    hash,
    from_address: from,
    to_address: to,
    amount: uintString(tx.amount),
    nonce: uintString(tx.nonce),
    block: blockHeight,
    tx_index: txIndex,
    timestamp,
    gas_price: uintString(tx.gas_price),
    gas_limit: uintString(tx.gas_limit),
    signature: clip(tx.signature, 20_000),
    public_key: clip(tx.public_key, 20_000),
    dilithium_signature: clip(tx.dilithium_signature ? bytesToHex(tx.dilithium_signature) : null, 20_000),
    dilithium_public_key: clip(tx.dilithium_public_key ? bytesToHex(tx.dilithium_public_key) : null, 20_000),
    tx_type: mapTxType(rawType),
    tx_type_data: extractTxTypeData(rawType),
    data: clip(tx.data, 100_000),
    status: clip(tx.status, 32) || 'confirmed',
    is_quantum_signed: !!(tx.is_quantum_signed || tx.dilithium_signature),
  };
}

// Recipient rows of a BatchTransfers envelope (≤1000 by consensus rule).
export function batchRowsOf(tx: Record<string, unknown>, row: TxRow): BatchRow[] {
  const rawType = (tx.tx_type ?? tx.type) as Record<string, unknown> | undefined;
  const batch = rawType && typeof rawType === 'object' ? (rawType.BatchTransfers as Record<string, unknown> | undefined) : undefined;
  if (!batch || !Array.isArray(batch.transfers)) return [];
  const out: BatchRow[] = [];
  const transfers = batch.transfers as Record<string, unknown>[];
  for (let i = 0; i < transfers.length && i < 1000; i++) {
    const t = transfers[i];
    const to = String(t?.to_address ?? t?.to ?? '');
    if (!to || to.length > 128) continue;
    out.push({ tx_hash: row.hash, tx_index: i, block: row.block, timestamp: row.timestamp, from_address: row.from_address, to_address: to, amount: uintString(t.amount) });
  }
  return out;
}

export interface ShapedBlock {
  block: BlockRow;
  txs: TxRow[];
  batch: BatchRow[];
  txHashes: string[];        // every transaction hash in block order, for the merkle check
}

// A full node block → block row + tx rows (in block order) + recipient rows. Gas used is summed with
// the u64::MAX "no gas" sentinel skipped and clamped to the column (price × limit is up to 2^128).
export function shapeBlock(b: NodeBlock, slotTsMs = 0): ShapedBlock {
  const txsRaw = Array.isArray(b.transactions) ? b.transactions : [];
  // The block's time is the slot's, never the body's: every row it produces carries it.
  const blockTs = slotTsMs > 0 ? slotTsMs : toMs(b.timestamp);
  const txs: TxRow[] = [];
  const batch: BatchRow[] = [];
  const seen = new Set<string>();
  let gas = 0n;
  txsRaw.forEach((raw, i) => {
    const gp = BigInt(uintString(raw.gas_price));
    const gl = BigInt(uintString(raw.gas_limit));
    if (gp < U64_MAX - 1000n) {
      const used = raw.gas_used !== undefined ? BigInt(uintString(raw.gas_used)) : gp * gl;
      gas += used;
    }
    const row = transformTransaction(raw, b.height, blockTs, i);
    if (!row || seen.has(row.hash)) return;
    seen.add(row.hash);
    txs.push(row);
    batch.push(...batchRowsOf(raw, row));
  });
  const hash = isHex64(b.hash) ? b.hash : null;
  const prev = bytesToHex(b.previous_hash);
  const merkle = bytesToHex(b.merkle_root);
  return {
    txHashes: txsRaw.map(t => String(t.hash ?? '')),
    block: {
      height: b.height,
      hash,
      timestamp: blockTs,
      previous_hash: isHex64(prev) ? prev : null,
      merkle_root: isHex64(merkle) ? merkle : null,
      producer: clip(b.producer, 128) || 'unknown',
      tx_count: txsRaw.length,
      tx_skipped: txsRaw.length - txs.length,
      total_gas_used: uintString(gas, GAS_COLUMN_MAX),
      size_bytes: 0,
      body_indexed: true,
    },
    txs,
    batch,
  };
}

// A header with a body → an empty-block row (tx_count must be 0: a header with transactions needs the
// full block). A header without a body → identity-only row with the slot-derived time.
export function blockRowFromHeader(h: NodeHeader, genesisTsMs: number): BlockRow {
  if (h.body && (h.tx_count || 0) === 0) {
    return {
      height: h.height, hash: isHex64(h.hash) ? h.hash : null, timestamp: toMs(h.timestamp),
      previous_hash: isHex64(h.previous_hash) ? h.previous_hash : null,
      merkle_root: isHex64(h.merkle_root) ? h.merkle_root : null,
      producer: clip(h.producer, 128) || 'unknown', tx_count: 0, tx_skipped: 0, total_gas_used: '0', size_bytes: 0, body_indexed: true,
    };
  }
  return {
    height: h.height, hash: isHex64(h.hash) ? h.hash : null, timestamp: slotTimestampMs(genesisTsMs, h.height),
    previous_hash: null, merkle_root: null, producer: 'unknown', tx_count: null, tx_skipped: 0, total_gas_used: '0', size_bytes: 0, body_indexed: false,
  };
}
