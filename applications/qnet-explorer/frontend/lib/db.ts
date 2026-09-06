import { Pool, QueryResult, QueryResultRow } from 'pg';

// Read side of the explorer database. The indexer process (src/indexer) is the only writer; nothing in
// here mutates chain tables. Lists page by keyset on (block, tx_index); counters come from explorer_stats.

let pool: Pool | null = null;

export function getDbPool(): Pool {
  if (!pool) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL environment variable is not set');
    let useSSL = process.env.DB_SSL === 'true';
    try {
      const url = new URL(databaseUrl);
      if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === 'host.docker.internal') useSSL = false;
    } catch { /* pg validates the string */ }
    pool = new Pool({
      connectionString: databaseUrl,
      max: 16,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 3000,
      statement_timeout: 15000,
      ssl: useSSL ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' } : false,
    });
    pool.on('error', () => { /* a broken idle client is replaced on next checkout */ });
  }
  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>> {
  if (!text || typeof text !== 'string') throw new Error('Query text must be a non-empty string');
  const db = getDbPool();
  let retries = 0;
  for (;;) {
    try {
      return await db.query<T>(text, params);
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if ((code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ENOTFOUND') && retries < 2) {
        retries++;
        await new Promise(r => setTimeout(r, 500 * retries));
        continue;
      }
      throw err;
    }
  }
}

export async function closePool(): Promise<void> {
  if (pool) { await pool.end(); pool = null; }
}

// ── rows ────────────────────────────────────────────────────────────────────────────────────────────

export interface TransactionRow {
  hash: string;
  from_address: string;
  to_address: string | null;
  amount: string;               // NUMERIC → exact digit string
  nonce: string;
  block: number;
  tx_index: number;
  timestamp: number;
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
  created_at: Date;
  updated_at: Date;
}

export interface BlockRow {
  height: number;
  hash: string;
  block_type: string;
  version: number;
  timestamp: number;
  previous_hash: string | null;
  merkle_root: string | null;
  state_root: string | null;
  producer: string;
  producer_address: string | null;
  tx_count: number | null;      // null: body pruned by the network before it was indexed
  total_gas_used: string;
  poh_hash: string | null;
  poh_count: number;
  signature_type: string | null;
  signature: string | null;
  cert_serial: string | null;
  qrb_output: string | null;
  size_bytes: number;
  consensus_data: Record<string, unknown> | null;
  micro_blocks: string[] | null;
  body_indexed: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface BatchTransferRow {
  tx_hash: string;
  tx_index: number;
  block: number;
  timestamp: number;
  from_address: string;
  to_address: string;
  amount: string;
}

export interface ExplorerStats {
  tx_total: number;
  tx_by_type: Record<string, number>;
  blocks_total: number;
  batch_transfers_total: number;
  emission_total: string;
  head_height: number;
  head_hash: string | null;
  head_timestamp: number;
  updated_at: Date;
}

export interface SyncStatus {
  last_height: number;
  indexed_prefix: number;
  node_height: number;
  ws_connected: boolean;
  node_endpoint: string | null;
  heal_pending: number;
  last_sync_at: Date | null;
}

// ── validation ──────────────────────────────────────────────────────────────────────────────────────

function validateHash(hash: string): void {
  if (!hash || typeof hash !== 'string') throw new Error('Transaction hash is required');
  if (!/^[a-f0-9_\-]+$/i.test(hash) && !hash.startsWith('qnet_') && !hash.startsWith('system_') && !hash.startsWith('genesis')) {
    throw new Error('Invalid transaction hash format: must be hexadecimal or system transaction hash');
  }
  if (hash.length < 8 || hash.length > 128) throw new Error(`Invalid transaction hash length: ${hash.length} (expected 8-128)`);
}

function validateAddress(address: string): void {
  if (!address || typeof address !== 'string') throw new Error('Address is required');
  if (address.length < 20 || address.length > 128) throw new Error(`Invalid address length: ${address.length} (expected 20-128)`);
  if (!/^[a-zA-Z0-9_-]+$/.test(address)) throw new Error('Invalid address format');
}

// ── stats / sync ────────────────────────────────────────────────────────────────────────────────────

export async function getExplorerStats(): Promise<ExplorerStats> {
  const r = await query<{ tx_total: string; tx_by_type: Record<string, number>; blocks_total: string; batch_transfers_total: string; emission_total: string; head_height: string; head_hash: string | null; head_timestamp: string; updated_at: Date }>(
    'SELECT tx_total::text, tx_by_type, blocks_total::text, batch_transfers_total::text, emission_total::text, head_height::text, head_hash, head_timestamp::text, updated_at FROM explorer_stats WHERE id = 1');
  const s = r.rows[0];
  if (!s) return { tx_total: 0, tx_by_type: {}, blocks_total: 0, batch_transfers_total: 0, emission_total: '0', head_height: -1, head_hash: null, head_timestamp: 0, updated_at: new Date(0) };
  return {
    tx_total: Number(s.tx_total), tx_by_type: s.tx_by_type || {}, blocks_total: Number(s.blocks_total),
    batch_transfers_total: Number(s.batch_transfers_total), emission_total: s.emission_total,
    head_height: Number(s.head_height), head_hash: s.head_hash, head_timestamp: Number(s.head_timestamp), updated_at: s.updated_at,
  };
}

export async function getSyncStatus(): Promise<SyncStatus> {
  const r = await query<{ last_height: string; indexed_prefix: string; node_height: string; ws_connected: boolean; node_endpoint: string | null; heal_pending: string; last_sync_at: Date | null }>(
    'SELECT last_height::text, indexed_prefix::text, node_height::text, ws_connected, node_endpoint, heal_pending::text, last_sync_at FROM sync_state WHERE id = 1');
  const s = r.rows[0];
  if (!s) return { last_height: -1, indexed_prefix: -1, node_height: 0, ws_connected: false, node_endpoint: null, heal_pending: 0, last_sync_at: null };
  return { last_height: Number(s.last_height), indexed_prefix: Number(s.indexed_prefix), node_height: Number(s.node_height), ws_connected: s.ws_connected, node_endpoint: s.node_endpoint, heal_pending: Number(s.heal_pending), last_sync_at: s.last_sync_at };
}

// ── transaction list: keyset pagination ─────────────────────────────────────────────────────────────

// Display categories → stored tx_type values.
export const DISPLAY_TYPE_TO_DB: Record<string, string[]> = {
  'Transfer': ['Transfer', 'BatchTransfers'],
  'Reward': ['RewardDistribution', 'BatchRewardClaims', 'SystemReward', 'SystemRewards', 'SystemEmission', 'Emission', 'Reward'],
  'Swap': ['Swap'],
  'Heartbeat': ['Heartbeat', 'HeartbeatCommitment'],
  'Light Eligibility': ['LightNodeEligibilityBitmap', 'BitmapCommitment', 'PingAttestation', 'PingCommitmentWithSampling'],
  'Registration': ['NodeRegistration', 'Registration'],
  'Activation': ['NodeActivation', 'BatchNodeActivations'],
  'Contract': ['ContractDeploy', 'ContractCall'],
  'System': ['CreateAccount', 'System'],
};

export interface ListCursor { block: number; tx_index: number }

export function encodeCursor(c: ListCursor): string {
  return Buffer.from(`${c.block}:${c.tx_index}`, 'utf8').toString('base64url');
}

export function decodeCursor(s: string | null | undefined): ListCursor | null {
  if (!s || s.length > 64) return null;
  let text: string;
  try { text = Buffer.from(s, 'base64url').toString('utf8'); } catch { return null; }
  const m = /^(\d{1,15}):(\d{1,9})$/.exec(text);
  if (!m) return null;
  return { block: Number(m[1]), tx_index: Number(m[2]) };
}

export const MAX_OFFSET_PAGE = 200;   // deeper than 10 000 rows only by cursor

export interface ListParams {
  limit: number;
  sort: 'asc' | 'desc';
  direction: 'next' | 'prev';
  cursor?: ListCursor | null;
  displayTypes?: string[];
  page?: number;                 // numbered jump, 1..MAX_OFFSET_PAGE; ignored when a cursor is given
}

export interface ListResult {
  transactions: TransactionRow[];
  nextCursor: string | null;
  prevCursor: string | null;
  total: number;
  currentHeight: number;
}

const LIST_COLS = `hash, tx_type, from_address, to_address, amount::text AS amount, block, tx_index, timestamp,
                   nonce::text AS nonce, gas_price::text AS gas_price, gas_limit::text AS gas_limit, signature, public_key,
                   is_quantum_signed, dilithium_signature, dilithium_public_key, data, status`;

function dbTypesFor(displayTypes?: string[]): string[] | null {
  if (!displayTypes || displayTypes.length === 0) return null;
  const out: string[] = [];
  for (const d of displayTypes) { const m = DISPLAY_TYPE_TO_DB[d]; if (m) out.push(...m); }
  return out.length > 0 ? out : null;
}

// One index-ordered branch per tx_type (an IN-list cannot drive an ordered scan), merged and cut outside.
function buildListSql(types: string[] | null, scanOrder: 'ASC' | 'DESC', cursor: ListCursor | null, limit: number, offset: number): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const p = (v: unknown) => { values.push(v); return `$${values.length}`; };
  const cmp = scanOrder === 'DESC' ? '<' : '>';
  const cur = cursor ? `(block, tx_index) ${cmp} (${p(cursor.block)}, ${p(cursor.tx_index)})` : null;
  const lim = p(limit + offset);
  const branch = (t: string | null) => {
    const conds: string[] = [];
    if (t !== null) conds.push(`tx_type = ${p(t)}`);
    if (cur) conds.push(cur);
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    return `(SELECT ${LIST_COLS} FROM transactions ${where} ORDER BY block ${scanOrder}, tx_index ${scanOrder} LIMIT ${lim})`;
  };
  const inner = types ? types.map(branch).join(' UNION ALL ') : branch(null);
  const text = `SELECT * FROM (${inner}) u ORDER BY block ${scanOrder}, tx_index ${scanOrder} LIMIT ${p(limit)} OFFSET ${p(offset)}`;
  return { text, values };
}

export async function listTransactions(params: ListParams): Promise<ListResult> {
  const limit = Math.min(Math.max(Math.trunc(params.limit) || 50, 1), 200);
  const types = dbTypesFor(params.displayTypes);
  const cursor = params.cursor ?? null;
  const page = cursor ? 1 : Math.min(Math.max(Math.trunc(params.page || 1), 1), MAX_OFFSET_PAGE);
  const offset = (page - 1) * limit;
  const displayOrder: 'ASC' | 'DESC' = params.sort === 'asc' ? 'ASC' : 'DESC';
  const scanOrder: 'ASC' | 'DESC' = params.direction === 'prev' ? (displayOrder === 'ASC' ? 'DESC' : 'ASC') : displayOrder;

  const sql = buildListSql(types, scanOrder, cursor, limit + 1, offset);
  const [res, stats] = await Promise.all([query<TransactionRow>(sql.text, sql.values), getExplorerStats()]);
  let rows = res.rows;
  const more = rows.length > limit;
  if (more) rows = rows.slice(0, limit);
  if (params.direction === 'prev') rows = rows.reverse();

  const first = rows[0], last = rows[rows.length - 1];
  const nextCursor = last && (params.direction === 'next' ? more : true) ? encodeCursor({ block: last.block, tx_index: last.tx_index }) : null;
  const prevCursor = first && (params.direction === 'prev' ? more : (cursor !== null || page > 1)) ? encodeCursor({ block: first.block, tx_index: first.tx_index }) : null;

  let total = stats.tx_total;
  if (types) total = types.reduce((s, t) => s + (stats.tx_by_type[t] || 0), 0);
  return { transactions: rows, nextCursor, prevCursor, total, currentHeight: stats.head_height };
}

// ── point reads ─────────────────────────────────────────────────────────────────────────────────────

export async function getTransactionByHash(hash: string): Promise<TransactionRow | null> {
  validateHash(hash);
  const result = await query<TransactionRow>(
    `SELECT hash, from_address, to_address, amount::text AS amount, nonce::text AS nonce, block, tx_index, timestamp,
            gas_price::text AS gas_price, gas_limit::text AS gas_limit, signature, public_key, dilithium_signature,
            dilithium_public_key, tx_type, tx_type_data, data, status, is_quantum_signed, created_at, updated_at
     FROM transactions WHERE hash = $1`, [hash]);
  return result.rows[0] || null;
}

// Recipients of a batch envelope, in envelope order (≤1000 by consensus rule).
export async function getBatchRecipients(txHash: string, limit: number = 1000): Promise<BatchTransferRow[]> {
  validateHash(txHash);
  const res = await query<BatchTransferRow>(
    `SELECT tx_hash, tx_index, block, timestamp, from_address, to_address, amount::text AS amount
     FROM batch_transfers WHERE tx_hash = $1 ORDER BY tx_index LIMIT $2`, [txHash, Math.min(Math.max(limit, 1), 1000)]);
  return res.rows;
}

export async function getBatchCreditsByAddress(address: string, limit: number = 100): Promise<BatchTransferRow[]> {
  validateAddress(address);
  const res = await query<BatchTransferRow>(
    `SELECT tx_hash, tx_index, block, timestamp, from_address, to_address, amount::text AS amount
     FROM batch_transfers WHERE to_address = $1 ORDER BY block DESC LIMIT $2`, [address, Math.min(Math.max(limit, 1), 500)]);
  return res.rows;
}

// Address history: index-ordered per side, merged; the count is capped so a hot address never scans.
export const ADDRESS_COUNT_CAP = 10_000;

export async function getTransactionsByAddress(address: string, page: number = 1, perPage: number = 50): Promise<{ transactions: TransactionRow[]; total: number; totalCapped: boolean }> {
  validateAddress(address);
  if (!Number.isInteger(page) || page < 1) throw new Error('Invalid page number: must be positive integer');
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 500) throw new Error('Invalid perPage: must be between 1 and 500');
  const offset = (page - 1) * perPage;
  const span = perPage + offset;
  const [txRes, countRes] = await Promise.all([
    query<TransactionRow>(
      `SELECT * FROM (
         (SELECT ${LIST_COLS} FROM transactions WHERE from_address = $1 ORDER BY block DESC, tx_index DESC LIMIT $2)
         UNION
         (SELECT ${LIST_COLS} FROM transactions WHERE to_address = $1 ORDER BY block DESC, tx_index DESC LIMIT $2)
       ) u ORDER BY block DESC, tx_index DESC LIMIT $3 OFFSET $4`,
      [address, span, perPage, offset]),
    query<{ c: string }>(
      `SELECT count(*) AS c FROM (SELECT 1 FROM transactions WHERE from_address = $1 OR to_address = $1 LIMIT $2) t`,
      [address, ADDRESS_COUNT_CAP + 1]),
  ]);
  const c = Number(countRes.rows[0]?.c || 0);
  return { transactions: txRes.rows, total: Math.min(c, ADDRESS_COUNT_CAP), totalCapped: c > ADDRESS_COUNT_CAP };
}

export interface ContractDeployRow {
  hash: string;
  from_address: string;
  to_address: string | null;
  block: number;
  timestamp: number;
  data: string | null;
}

export async function getContractDeploys(limit: number = 1000): Promise<ContractDeployRow[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new Error('Invalid limit: must be between 1 and 5000');
  const result = await query<ContractDeployRow>(
    `SELECT hash, from_address, to_address, block, timestamp, data FROM transactions
     WHERE tx_type = 'ContractDeploy' ORDER BY block DESC, tx_index DESC LIMIT $1`, [limit]);
  return result.rows;
}

export async function getContractDeployByAddress(contract: string): Promise<ContractDeployRow | null> {
  validateAddress(contract);
  const result = await query<ContractDeployRow>(
    `SELECT hash, from_address, to_address, block, timestamp, data FROM transactions
     WHERE tx_type = 'ContractDeploy' AND to_address = $1 ORDER BY block ASC, tx_index ASC LIMIT 1`, [contract]);
  return result.rows[0] || null;
}

// Bounded text search over QRC-20 deploy metadata (wildcards escaped; the caller confirms the match).
export async function searchQrc20DeploysByText(needle: string, limit: number = 25): Promise<ContractDeployRow[]> {
  const clean = needle.trim();
  if (!clean) return [];
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) limit = 25;
  const esc = clean.replace(/[\\%_]/g, (c) => '\\' + c);
  const result = await query<ContractDeployRow>(
    `SELECT hash, from_address, to_address, block, timestamp, data FROM transactions
     WHERE tx_type = 'ContractDeploy' AND data ILIKE '%qrc20%' AND data ILIKE $1 ESCAPE '\\'
     ORDER BY block DESC, tx_index DESC LIMIT $2`, [`%${esc}%`, limit]);
  return result.rows;
}

// ── token transfers (effect-sourced) ────────────────────────────────────────────────────────────────

export interface TokenTransferRow {
  tx_hash: string;
  log_index: number;
  contract: string;
  from_address: string;
  to_address: string;
  amount: string;
  kind: string;
  std: string;
  token_id: string;
  block: number;
  timestamp: number;
}

export async function getAddressTokenTransfers(address: string, limit: number = 50): Promise<TokenTransferRow[]> {
  validateAddress(address);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) limit = 50;
  const result = await query<TokenTransferRow>(
    `SELECT * FROM (
       (SELECT * FROM token_transfers WHERE from_address = $1 ORDER BY block DESC, log_index DESC LIMIT $2)
       UNION
       (SELECT * FROM token_transfers WHERE to_address = $1 ORDER BY block DESC, log_index DESC LIMIT $2)
     ) u ORDER BY block DESC, log_index DESC LIMIT $2`, [address, limit]);
  return result.rows;
}

export async function getContractTokenTransfers(contract: string, limit: number = 50): Promise<TokenTransferRow[]> {
  validateAddress(contract);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) limit = 50;
  const result = await query<TokenTransferRow>(
    `SELECT * FROM token_transfers WHERE contract = $1 ORDER BY block DESC, log_index DESC LIMIT $2`, [contract, limit]);
  return result.rows;
}

// ── blocks ──────────────────────────────────────────────────────────────────────────────────────────

export async function getBlockByHeight(height: number): Promise<BlockRow | null> {
  if (!Number.isInteger(height) || height < 0) throw new Error('Invalid block height');
  const result = await query<BlockRow>('SELECT * FROM blocks WHERE height = $1', [height]);
  return result.rows[0] || null;
}

export async function getBlockByHash(hash: string): Promise<BlockRow | null> {
  if (!hash || typeof hash !== 'string' || hash.length < 8 || hash.length > 128) throw new Error('Invalid block hash');
  const result = await query<BlockRow>('SELECT * FROM blocks WHERE hash = $1', [hash]);
  return result.rows[0] || null;
}

export async function getTransactionsByBlock(blockHeight: number): Promise<TransactionRow[]> {
  if (!Number.isInteger(blockHeight) || blockHeight < 0) throw new Error('Invalid block height');
  const result = await query<TransactionRow>(
    `SELECT ${LIST_COLS} FROM transactions WHERE block = $1 ORDER BY tx_index ASC`, [blockHeight]);
  return result.rows;
}

// Latest blocks for a block feed, newest first.
export async function getLatestBlocks(limit: number = 20): Promise<BlockRow[]> {
  const n = Math.min(Math.max(Math.trunc(limit) || 20, 1), 100);
  const result = await query<BlockRow>('SELECT * FROM blocks ORDER BY height DESC LIMIT $1', [n]);
  return result.rows;
}
