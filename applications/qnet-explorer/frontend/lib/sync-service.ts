import { getDbPool, insertTransactionsBatch, insertBatchTransferRows, updateSyncState, getSyncState, query, insertBlock, getBlockByHeight } from './db';
import type { BlockRow } from './db';
import { verifyTransactionHash, verifyTransactionIntegrity, logSecurityEvent } from './security';
import WebSocket from 'ws';

// ============================================================================
// PRODUCTION v3.19: WebSocket-based sync (replaces polling)
// - Realtime block notifications via WebSocket
// - Single REST request per block (instead of 500 parallel)
// - Automatic reconnection with exponential backoff
// - Fallback to polling if WebSocket unavailable
// ============================================================================

// Disable logging in production (set to true for debugging)
const DEBUG = process.env.SYNC_DEBUG === 'true';
const log = DEBUG ? console.log.bind(console) : () => {};
const warn = DEBUG ? console.warn.bind(console) : () => {};
const error = console.error.bind(console); // Always log errors

// API key for unlimited access (bypasses rate limits)
const API_KEY = process.env.QNET_API_KEY || '';

// Validate and sanitize NODE_RPC_URL to prevent SSRF
function getNodeRpcUrl(): string {
  const url = process.env.QNET_API_URL || 'https://162.244.25.114:8001';
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Invalid protocol');
    }
    const hostname = parsed.hostname;
    if (hostname === 'localhost' || hostname === '127.0.0.1' || 
        hostname.startsWith('192.168.') || hostname.startsWith('10.') ||
        hostname.startsWith('172.16.') || hostname.startsWith('172.17.') ||
        hostname.startsWith('172.18.') || hostname.startsWith('172.19.') ||
        hostname.startsWith('172.20.') || hostname.startsWith('172.21.') ||
        hostname.startsWith('172.22.') || hostname.startsWith('172.23.') ||
        hostname.startsWith('172.24.') || hostname.startsWith('172.25.') ||
        hostname.startsWith('172.26.') || hostname.startsWith('172.27.') ||
        hostname.startsWith('172.28.') || hostname.startsWith('172.29.') ||
        hostname.startsWith('172.30.') || hostname.startsWith('172.31.')) {
      error('[Sync] NODE_RPC_URL points to private IP, using default');
      return 'https://162.244.25.114:8001';
    }
    return url;
  } catch {
    error('[Sync] Invalid NODE_RPC_URL format, using default');
    return 'https://162.244.25.114:8001';
  }
}

// Get headers for API requests (includes API key if set)
function getApiHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (API_KEY) {
    headers['X-API-Key'] = API_KEY;
  }
  return headers;
}

// Get WebSocket URL from HTTP URL
function getNodeWsUrl(): string {
  const httpUrl = getNodeRpcUrl();
  const wsUrl = httpUrl.replace('http://', 'ws://').replace('https://', 'wss://');
  return `${wsUrl}/ws/subscribe?channels=blocks`;
}

const NODE_RPC_URL = getNodeRpcUrl();
const NODE_WS_URL = getNodeWsUrl();
const SYNC_INTERVAL = 5000; // v3.35: Fallback polling: 5 seconds (was 30s — too slow for user-facing TX)
const INTEGRITY_CHECK_INTERVAL = 600000; // 10 minutes
const RECOVERY_INTERVAL = 300000; // 5 minutes — periodic scan for missing TXs
const WS_RECONNECT_DELAY_BASE = 1000; // Initial reconnect delay: 1 second
const WS_RECONNECT_DELAY_MAX = 60000; // Max reconnect delay: 60 seconds
const WS_MAX_RECONNECT_ATTEMPTS = 50; // Circuit breaker: stop after 50 failed attempts
const WS_HEARTBEAT_INTERVAL = 30000; // Ping every 30 seconds to detect dead connections

// ── Reorg / self-heal bounds (F2 bounded rollback, F3 tail re-validation) ──────────────────
// QNet does bounded, finality-guarded reorgs (small backward height move, or an equal-height
// re-produce), so a bare `networkHeight < lastHeight` must NOT full-wipe the DB on every 1–2
// block reorg. Deletes stay bounded by the reorg point — never a full scan (except a real genesis).
const REORG_LIMIT = 5000;           // max finality-bounded reorg depth; a deeper backward move ⇒ genuine fresh genesis
const GENESIS_FLOOR = 2;            // new tip at/below this ⇒ genuine fresh genesis (full wipe, not a rollback)
const REVALIDATE_DEPTH = 64;       // F3: tail blocks hash-checked per pass (bounded, ≤ REORG_LIMIT)
const REVALIDATE_INTERVAL = 30000; // F3: min ms between tail re-validations (bounded cadence, not per-block)

// ============================================================================
// WebSocket JSON-RPC for bulk block fetching (NO HTTP overhead!)
// ============================================================================
let rpcRequestId = 1;
let rpcWs: WebSocket | null = null;
const rpcPending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void; timeout: NodeJS.Timeout }>();

// Get or create WebSocket connection for RPC
async function getRpcWebSocket(): Promise<WebSocket> {
  if (rpcWs && rpcWs.readyState === WebSocket.OPEN) {
    return rpcWs;
  }
  
  return new Promise((resolve, reject) => {
    const wsUrl = NODE_WS_URL; // Reuse same WS endpoint
    console.log('[WS-RPC] Connecting for block fetching...');
    const ws = new WebSocket(wsUrl);
    
    ws.on('open', () => {
      console.log('[WS-RPC] Connected');
      rpcWs = ws;
      resolve(ws);
    });
    
    ws.on('message', (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        // Handle JSON-RPC response (ignore NewBlock events on this connection)
        if (msg.id !== undefined && rpcPending.has(msg.id)) {
          const pending = rpcPending.get(msg.id)!;
          clearTimeout(pending.timeout);
          rpcPending.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(msg.error.message || 'RPC error'));
          } else {
            const count = Array.isArray(msg.result) ? msg.result.length : 0;
            log(`[WS-RPC] Response id=${msg.id}: ${count} blocks`);
            pending.resolve(msg.result);
          }
        }
      } catch {
        // Ignore non-JSON messages
      }
    });
    
    ws.on('error', (err: Error) => {
      console.error('[WS-RPC] Error:', err.message);
      rpcWs = null;
      reject(err);
    });
    
    ws.on('close', () => {
      console.log('[WS-RPC] Disconnected');
      rpcWs = null;
      // Reject all pending requests
      for (const [id, p] of rpcPending) {
        clearTimeout(p.timeout);
        p.reject(new Error('WebSocket closed'));
        rpcPending.delete(id);
      }
    });
    
    // Connection timeout
    setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        ws.close();
        reject(new Error('WS connection timeout'));
      }
    }, 15000);
  });
}

// Fetch blocks via WebSocket JSON-RPC (FAST - no HTTP overhead!)
async function fetchBlocksViaRpc(start: number, limit: number): Promise<BlockData[]> {
  try {
    console.log(`[WS-RPC] fetchBlocksViaRpc start=${start} limit=${limit}`);
    const ws = await getRpcWebSocket();
    const id = rpcRequestId++;
    const effectiveLimit = Math.min(limit, 20); // 20 blocks per request via WS
    
    return new Promise((resolve, reject) => {
      // Dilithium JSON makes blocks ~25KB each → 20 blocks = 500KB → needs time
      const timeoutMs = start === 0 ? 120000 : 90000;
      const timeout = setTimeout(() => {
        console.error(`[WS-RPC] TIMEOUT for id=${id} start=${start} after ${timeoutMs}ms`);
        rpcPending.delete(id);
        reject(new Error('RPC timeout'));
      }, timeoutMs);
      
      rpcPending.set(id, {
        resolve: (result) => {
          console.log(`[WS-RPC] GOT RESPONSE id=${id} blocks=${Array.isArray(result) ? result.length : 0}`);
          resolve(Array.isArray(result) ? result : []);
        },
        reject,
        timeout
      });
      
      const request = {
        jsonrpc: '2.0',
        id,
        method: 'chain_getBlocks',
        params: { start, limit: effectiveLimit }
      };
      console.log(`[WS-RPC] SENDING id=${id}: ${JSON.stringify(request)}`);
      ws.send(JSON.stringify(request));
    });
  } catch (err) {
    console.error('[WS-RPC] fetchBlocksViaRpc error:', err);
    return [];
  }
}

interface TransactionFromNode {
  hash: string;
  from: string;
  to: string | null;
  amount: number;
  nonce: number;
  block: number;
  timestamp: number;
  gas_price: number;
  gas_limit: number;
  signature: string | null;
  public_key: string | null;
  dilithium_signature: string | null;
  dilithium_public_key: string | null;
  tx_type: string | object;
  data: string | null;
  status: string;
  is_quantum_signed: boolean;
  tx_type_data?: Record<string, unknown> | null;
}

// Map transaction type to string
function mapTxType(type: string | object | undefined): string {
  if (!type) return 'Transfer';
  if (typeof type === 'string') {
    // Handle Rust Debug format: "Transfer { from: \"...\", to: \"...\", amount: 123 }"
    // Extract just the type name before the opening brace
    const braceIdx = type.indexOf(' {');
    if (braceIdx > 0) {
      const typeName = type.substring(0, braceIdx).trim();
      if (typeName.length > 0 && typeName.length <= 50) return typeName;
    }
    // Handle plain JSON object strings like '{"Transfer":{}}'
    if (type.startsWith('{')) {
      try {
        const parsed = JSON.parse(type);
        if (typeof parsed === 'object' && parsed !== null) {
          const keys = Object.keys(parsed);
          return keys[0] || 'Transfer';
        }
      } catch { /* not JSON, use as-is */ }
    }
    // Plain type name — truncate if somehow too long
    if (type.length > 50) return type.substring(0, 50);
    return type;
  }
  const keys = Object.keys(type as object);
  return keys[0] || 'Transfer';
}

// Extract small, queryable structured fields into tx_type_data. LightNodeEligibilityBitmap
// carries the per-genesis sealed light-eligible count; store {genesis_id, epoch, eligible_count}
// ONLY (never bitmap_compressed — large blob that would blow the row size cap).
function extractTxTypeData(rawType: string | object | undefined): Record<string, unknown> | null {
  if (rawType && typeof rawType === 'object') {
    const body = (rawType as Record<string, unknown>).LightNodeEligibilityBitmap as Record<string, unknown> | undefined;
    if (body && typeof body === 'object') {
      return { genesis_id: body.genesis_id, epoch: body.epoch, eligible_count: body.eligible_count };
    }
    // BatchTransfers: keep every recipient (<=1000 by consensus rule) so the tx
    // page can expand them and the side table can index per-recipient credits.
    const batch = (rawType as Record<string, unknown>).BatchTransfers as Record<string, unknown> | undefined;
    if (batch && typeof batch === 'object' && Array.isArray(batch.transfers)) {
      const transfers = batch.transfers as Array<Record<string, unknown>>;
      return {
        batch_id: batch.batch_id,
        transfer_count: transfers.length,
        recipients: transfers.map(t => ({
          to: String(t.to_address ?? ''),
          amount: String(t.amount ?? '0'),
        })),
      };
    }
  }
  return null;
}

// Transform node transaction to DB format
function transformTransaction(
  tx: Record<string, unknown>,
  blockHeight: number,
  blockTimestamp: number
): TransactionFromNode | null {
  const hash = String(tx.hash || '');
  if (!hash || hash.length < 8 || hash.length > 128) {
    console.log(`[TX] SKIP hash invalid: ${hash.substring(0, 32)}`);
    return null;
  }

  if (!Number.isInteger(blockHeight) || blockHeight < 0) {
    console.log(`[TX] SKIP invalid height: ${blockHeight}`);
    return null;
  }

  // v3.54: the canonical time of a TX is the BLOCK timestamp (consensus-bound, slot-anchored =
  // genesis_ts + height*SLOT), NOT the per-TX `timestamp`. The per-TX field is a client/bootstrap-set
  // value: genesis bootstrap TXs (CreateAccount/NodeRegistration/system) carry a config-time stamp made
  // hours before the genesis block is minted, which the old "tx-level first" rule surfaced as a wrong
  // "16h ago" on genesis (live TXs happened to match block ts, so only genesis looked wrong). Prefer the
  // block timestamp; fall back to the per-TX field only when the block timestamp is absent.
  const blockTs = blockTimestamp || 0;
  const txTs = Number(tx.timestamp) || 0;
  let rawTs = (blockTs > 0 ? blockTs : txTs);
  if (!Number.isFinite(rawTs) || rawTs < 0) {
    warn('[Sync] Invalid timestamp, fallback to 0:', rawTs);
    rawTs = 0;
  }
  const timestamp = rawTs > 1e12 ? rawTs : rawTs * 1000;

  const amount = Number(tx.amount) || 0;
  const nonce = Number(tx.nonce) || 0;

  // FIX-5: gate on the SIGNATURE only — under pk-elision dilithium_public_key is null for every tx
  // after an address's first on-chain use, so requiring it would mislabel signed txs as "Unsigned".
  const isQuantumSigned = !!(tx.is_quantum_signed || tx.dilithium_signature);

  const fromRaw = tx.from || tx.from_address;
  if (!fromRaw || (typeof fromRaw === 'string' && fromRaw.length === 0)) {
    console.log(`[TX] SKIP no from: hash=${hash.substring(0,16)}`);
    return null;
  }
  const from = String(fromRaw);
  if (from.length > 128) {
    console.log(`[TX] SKIP from too long: ${from.length}`);
    return null;
  }

  const to = tx.to ? String(tx.to) : (tx.to_address ? String(tx.to_address) : null);
  if (to && to.length > 128) {
    warn('[Sync] Invalid to address length:', to.length);
    return null;
  }

  // Hide the genesis prefund/benchmark distribution (genesis -> user address at block 0),
  // any address format. Real genesis rows use a genesis-wallet 'from' or a 'system' recipient.
  if (blockHeight === 0 && from === 'genesis' && to && !to.startsWith('system')) {
    return null;
  }

  // Skip benchmark transactions (from/to EON1benchmark* test accounts)
  // These are synthetic load-test TXs that should not appear in Explorer
  if (from.startsWith('EON1benchmark') || (to && to.startsWith('EON1benchmark'))) {
    return null;
  }

  return {
    hash,
    from,
    to,
    amount: Math.max(0, amount),
    nonce: Math.max(0, nonce),
    block: blockHeight,
    timestamp,
    gas_price: Math.max(0, Number(tx.gas_price) || 0),
    gas_limit: Math.max(0, Number(tx.gas_limit) || 0),
    signature: tx.signature ? String(tx.signature) : null,
    public_key: tx.public_key ? String(tx.public_key) : null,
    // FIX-5: node emits hex of the raw detached sig / raw pk; bytesToHex passes a hex string through
    // and also maps a serde number[] fallback → hex. pk is often null now (elided after first use).
    dilithium_signature: tx.dilithium_signature ? bytesToHex(tx.dilithium_signature) : null,
    dilithium_public_key: tx.dilithium_public_key ? bytesToHex(tx.dilithium_public_key) : null,
    tx_type: mapTxType((tx.tx_type || tx.type) as string | object | undefined),
    tx_type_data: extractTxTypeData((tx.tx_type || tx.type) as string | object | undefined),
    data: tx.data ? (String(tx.data).length > 100000 ? String(tx.data).substring(0, 100000) : String(tx.data)) : null,
    status: String(tx.status || 'confirmed'),
    is_quantum_signed: isQuantumSigned
  };
}

// Block structure interface
interface BlockData {
  hash?: string;
  height?: number;
  transactions?: unknown[];
  timestamp?: number | string;
  previous_hash?: unknown;
  merkle_root?: unknown;
  producer?: string;
  producer_address?: string;
  poh_hash?: unknown;
  poh_count?: number;
  signature_type?: string;
  signature?: string;
  cert_serial?: string;
  qrb_output?: unknown;
  consensus_data?: Record<string, unknown>;
  [key: string]: unknown;
}

// WebSocket NewBlock event
interface WsNewBlockEvent {
  type: 'NewBlock';
  data: {
    height: number;
    hash: string;
    timestamp: number;
    tx_count: number;
    producer: string;
  };
}

// Convert byte array to hex string
function bytesToHex(bytes: unknown): string {
  if (typeof bytes === 'string') return bytes;
  if (Array.isArray(bytes)) {
    return bytes.map((b: number) => b.toString(16).padStart(2, '0')).join('');
  }
  return '';
}

// Fetch single block via HTTP RPC (faster than REST for large blocks like Genesis)
async function fetchBlockViaHttpRpc(height: number): Promise<{ block: BlockData; height: number } | null> {
  try {
    const res = await fetch(`${NODE_RPC_URL}/rpc`, {
      method: 'POST',
      headers: getApiHeaders(),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'chain_getBlocks',
        params: { start: height, limit: 1 }
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.result && Array.isArray(data.result) && data.result.length > 0) {
      const block = data.result[0] as BlockData;
      return { block, height };
    }
    return null;
  } catch (err) {
    error(`[Sync] HTTP-RPC fetch block ${height} failed:`, err);
    return null;
  }
}

// Fetch single block from node (REST API)
async function fetchBlock(height: number): Promise<{ block: BlockData; height: number } | null> {
  // Genesis is ~450KB - use HTTP RPC which is 10x faster
  if (height === 0) {
    console.log('[Sync] Genesis: using HTTP RPC (fast path)');
    return fetchBlockViaHttpRpc(0);
  }
  try {
    const res = await fetch(`${NODE_RPC_URL}/api/v1/microblock/${height}`, {
      cache: 'no-store',
      headers: getApiHeaders(),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) return null;

    const contentLength = res.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > 50 * 1024 * 1024) {
      warn(`[Sync] Block ${height} response too large: ${contentLength} bytes`);
      return null;
    }

    const text = await res.text();
    if (text.length > 50 * 1024 * 1024) {
      warn(`[Sync] Block ${height} response too large: ${text.length} bytes`);
      return null;
    }

    let responseData: any;
    try {
      responseData = JSON.parse(text);
    } catch (parseErr) {
      warn(`[Sync] Failed to parse block ${height} JSON:`, parseErr);
      return null;
    }
    
    let block: BlockData;
    if (responseData.block) {
      block = responseData.block as BlockData;
    } else {
      block = responseData as BlockData;
    }
    
    if (!block || typeof block !== 'object') {
      warn(`[Sync] Invalid block structure for height ${height}`);
      return null;
    }
    
    if (!block.transactions && (block as any).txs) {
      block.transactions = (block as any).txs;
    }
    
    if (block.transactions && !Array.isArray(block.transactions)) {
      warn(`[Sync] Invalid transactions array for block ${height}`);
      block.transactions = [];
    }
    
    const MAX_TXS_PER_BLOCK = 100000;
    if (Array.isArray(block.transactions) && block.transactions.length > MAX_TXS_PER_BLOCK) {
      warn(`[Sync] Block ${height} has ${block.transactions.length} transactions, limiting to ${MAX_TXS_PER_BLOCK}`);
      block.transactions = block.transactions.slice(0, MAX_TXS_PER_BLOCK);
    }
    
    return { block, height };
  } catch (err) {
    error(`[Sync] Failed to fetch block ${height}:`, err);
    return null;
  }
}

// Process and save a single block
async function processSingleBlock(height: number): Promise<number> {
  const result = await fetchBlock(height);
  if (!result) return 0;

  const { block } = result;
  const txs = Array.isArray(block.transactions) ? block.transactions : [];
  const blockTs = Number(block.timestamp) || 0;

  // Calculate total gas used
  const U64_MAX = 18446744073709551615;
  let totalGasUsed = 0;
  for (const tx of txs as Record<string, unknown>[]) {
    const gasPrice = Number(tx.gas_price) || 0;
    const gasLimit = Number(tx.gas_limit) || 0;
    if (gasPrice >= U64_MAX - 1000 || gasPrice < 0) continue;
    const gasUsed = Number(tx.gas_used) || (gasPrice * gasLimit);
    totalGasUsed += gasUsed;
  }

  // Save block to PostgreSQL
  try {
    await insertBlock({
      height,
      hash: block.hash || `block_${height}`,
      block_type: (block.block_type as string) || 'MICROBLOCK',
      version: (block.version as number) || 1,
      timestamp: blockTs > 1e12 ? blockTs : blockTs * 1000,
      previous_hash: bytesToHex(block.previous_hash) || null,
      merkle_root: bytesToHex(block.merkle_root) || null,
      state_root: bytesToHex(block.state_root) || null,
      producer: (block.producer as string) || 'unknown',
      producer_address: (block.producer_address as string) || null,
      tx_count: txs.length,
      total_gas_used: totalGasUsed,
      poh_hash: bytesToHex(block.poh_hash) || null,
      poh_count: (block.poh_count as number) || 0,
      signature_type: (block.signature_type as string) || 'ML-DSA-65',
      signature: (block.signature as string) || null,
      cert_serial: (block.cert_serial as string) || null,
      qrb_output: bytesToHex(block.qrb_output) || null,
      size_bytes: (block.size_bytes as number) || 0,
      consensus_data: (block.consensus_data as Record<string, unknown>) || null,
      micro_blocks: Array.isArray(block.micro_blocks) ? (block.micro_blocks as string[]) : null,
    });
  } catch (err) {
    error(`[Sync] Failed to save block ${height}:`, err);
  }

  // Transform and save transactions
  const transactions: TransactionFromNode[] = [];
  for (const tx of txs as Record<string, unknown>[]) {
    const transformed = transformTransaction(tx, height, blockTs);
    if (transformed) {
      transactions.push(transformed);
    }
  }

  // Deduplicate by hash
  const seenHashes = new Set<string>();
  const uniqueTransactions: TransactionFromNode[] = [];
  for (const tx of transactions) {
    if (!seenHashes.has(tx.hash)) {
      seenHashes.add(tx.hash);
      uniqueTransactions.push(tx);
    }
  }

  // Batch insert transactions
  let insertedOk = false;
  if (uniqueTransactions.length > 0) {
    const MAX_BATCH_SIZE = 1000;
    for (let i = 0; i < uniqueTransactions.length; i += MAX_BATCH_SIZE) {
      const batch = uniqueTransactions.slice(i, i + MAX_BATCH_SIZE);
      try {
        await insertTransactionsBatch(batch.map(tx => ({
          hash: tx.hash,
          from_address: tx.from,
          to_address: tx.to,
          amount: tx.amount,
          nonce: tx.nonce,
          block: tx.block,
          timestamp: tx.timestamp,
          gas_price: tx.gas_price,
          gas_limit: tx.gas_limit,
          signature: tx.signature,
          public_key: tx.public_key,
          dilithium_signature: tx.dilithium_signature,
          dilithium_public_key: tx.dilithium_public_key,
          tx_type: typeof tx.tx_type === 'string' ? tx.tx_type : JSON.stringify(tx.tx_type),
          tx_type_data: tx.tx_type_data ?? null,
          data: tx.data,
          status: tx.status,
          is_quantum_signed: tx.is_quantum_signed
        })));
        insertedOk = true;
        // Side table: one row per inner batch recipient (address-page credits).
        const batchRows = batch.flatMap(tx => {
          const d = tx.tx_type_data as { recipients?: Array<{ to: string; amount: string }> } | null;
          if (!d?.recipients?.length) return [];
          return d.recipients.map((r, i) => ({
            tx_hash: tx.hash, tx_index: i, block: tx.block, timestamp: tx.timestamp,
            from_address: tx.from, to_address: r.to, amount: r.amount,
          }));
        });
        if (batchRows.length > 0) {
          await insertBatchTransferRows(batchRows);
        }
      } catch (err) {
        error(`[Sync] Failed to insert batch for block ${height}:`, err);
        // Return 0 so retry mechanism picks this up
        return 0;
      }
    }
  }

  // Update sync state
  await updateSyncState(height);

  // Index effect-sourced token transfers for this block (non-fatal). Only blocks
  // with TXs can carry transfers, so skip empty microblocks.
  if (txs.length > 0) {
    await ingestTokenTransfers(height, height);
  }

  return insertedOk ? uniqueTransactions.length : 0;
}

// Sync blocks using polling (fallback mode - ONLY when WebSocket is down)
async function syncBlocksPolling(): Promise<{ added: number; currentHeight: number }> {
  try {
    const heightRes = await fetch(`${NODE_RPC_URL}/api/v1/height`, {
      cache: 'no-store',
      headers: getApiHeaders(),
      signal: AbortSignal.timeout(5000),
    });

    if (!heightRes.ok) {
      log('[Sync] Failed to get height from node');
      return { added: 0, currentHeight: 0 };
    }

    const heightText = await heightRes.text();
    if (heightText.length > 1024) {
      warn('[Sync] Height response too large:', heightText.length);
      return { added: 0, currentHeight: 0 };
    }
    
    let heightData: { height?: number };
    try {
      heightData = JSON.parse(heightText) as { height?: number };
    } catch (parseErr) {
      warn('[Sync] Failed to parse height JSON:', parseErr);
      return { added: 0, currentHeight: 0 };
    }
    
    const currentHeight = heightData.height;
    if (!currentHeight || !Number.isInteger(currentHeight) || currentHeight < 0) {
      return { added: 0, currentHeight: 0 };
    }

    const syncState = await getSyncState();
    const lastHeight = typeof syncState?.last_height === 'number' ? syncState.last_height : Number(syncState?.last_height) || 0;

    // Backward height move: bounded reorg → scoped rollback; genuine fresh genesis → full wipe (F2).
    if (currentHeight < lastHeight) {
      log(`[Sync] Backward height detected: ${currentHeight} < ${lastHeight}`);
      await reconcileBackwardHeight(currentHeight, lastHeight, `polling network=${currentHeight} < local=${lastHeight}`);
      return { added: 0, currentHeight };
    }

    // Sync missing blocks (max 50 per poll to avoid rate limits)
    let totalAdded = 0;
    const maxBlocksPerPoll = 50;
    for (let h = lastHeight + 1; h <= currentHeight && h <= lastHeight + maxBlocksPerPoll; h++) {
      const added = await processSingleBlock(h);
      totalAdded += added;
      // Small delay between requests to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // F3: bounded tail re-validation catches equal-height / shallow reorgs (throttled internally).
    await maybeRevalidateChainTail();

    return { added: totalAdded, currentHeight };
  } catch (err) {
    error('[Sync] Polling error:', err);
    return { added: 0, currentHeight: 0 };
  }
}

// ============================================================================
// CATCHUP SYNC: On startup/reconnect - scan ALL blocks, save ONLY those with TX
// After catching up → NewBlock WS handles live sync at 1 block/sec
// ============================================================================
let isBackfillRunning = false;

// Self-heal: the node reports a chain SHORTER than what we've recorded, which means
// it was wiped / rolled back to a fresh genesis. Drop every indexed row and reset
// sync_state so normal forward sync repopulates from genesis. updateSyncState() only
// ever RAISES last_height (GREATEST), so reset it directly here.
async function resetChainForFreshGenesis(reason: string): Promise<void> {
  warn(`[Sync] Fresh genesis / rollback detected — wiping stale chain data: ${reason}`);
  const db = getDbPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE token_transfers, transactions, blocks');
    await client.query('UPDATE sync_state SET last_height = -1, last_sync_at = CURRENT_TIMESTAMP WHERE id = 1');
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    warn('[Sync] chain reset failed:', err);
  } finally {
    client.release();
  }
}

// F2: bounded reorg self-heal. Drop ONLY the rows strictly ABOVE the new canonical tip and lower
// sync_state to it, so forward sync re-ingests height+1.. . Deletes are bounded by the reorg point
// (indexed on block/height) — never a full-table scan. updateSyncState() is monotonic (GREATEST),
// so last_height is set directly here. Mirrors resetChainForFreshGenesis but scoped, not a wipe.
async function rollbackChainAbove(height: number, reason: string): Promise<void> {
  warn(`[Sync] Bounded reorg rollback above height ${height}: ${reason}`);
  const db = getDbPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM token_transfers WHERE block > $1', [height]);
    await client.query('DELETE FROM transactions WHERE block > $1', [height]);
    await client.query('DELETE FROM blocks WHERE height > $1', [height]);
    await client.query('UPDATE sync_state SET last_height = $1, last_sync_at = CURRENT_TIMESTAMP WHERE id = 1', [height]);
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    warn('[Sync] bounded rollback failed:', err);
  } finally {
    client.release();
  }
}

// F2: a backward tip move (observed height < recorded height). Decide between a BOUNDED reorg
// rollback (keep newHeight, drop above it) and a genuine FRESH-GENESIS full wipe. Returns the
// height sync_state now sits at: newHeight for a rollback, -1 for a full wipe.
async function reconcileBackwardHeight(newHeight: number, lastHeight: number, reason: string): Promise<number> {
  const drop = lastHeight - newHeight;
  // Genuine fresh genesis: chain reset to (near) zero, or a drop too deep to be a finality-bounded reorg.
  if (newHeight <= GENESIS_FLOOR || drop > REORG_LIMIT) {
    // CORROBORATE before the destructive TRUNCATE: a super-node that was merely wiped+re-syncing (the
    // standard testnet relaunch op) transiently reports a LOW /height while its early blocks are IDENTICAL
    // to ours. Compare an early ANCHOR block; wipe ONLY on a positive divergence (a genuinely new chain).
    // A match (node re-syncing the same chain) or an unfetchable anchor (node briefly down) keeps the DB
    // intact and retries next tick — never nuke good indexed data on a transient backward height.
    const anchorH = Math.max(1, Math.min(newHeight > 0 ? newHeight : 1, GENESIS_FLOOR + 1));
    const stored = await getBlockByHeight(anchorH).catch(() => null);
    const fetched = await fetchBlock(anchorH).catch(() => null);
    if (!(stored && fetched && blockIdentityDiverged(stored, fetched.block))) {
      warn(`[Sync] backward height (${reason}, drop=${drop}) but anchor block ${anchorH} does not positively diverge — treating as node re-sync, NOT wiping`);
      return lastHeight;
    }
    await resetChainForFreshGenesis(`${reason} (drop=${drop}, anchor ${anchorH} diverged)`);
    return -1;
  }
  // Bounded, finality-guarded reorg: scoped rollback, DB stays populated.
  await rollbackChainAbove(newHeight, `${reason} (drop=${drop})`);
  return newHeight;
}

// F3: classify our stored block at a height against the node's freshly-fetched block. The node's
// MicroBlock JSON carries NO stable `hash`, so identity = (merkle_root, previous_hash). The tip (~99%
// of blocks) is an empty WS-fast-path block stored with NULL roots, so a plain merkle compare is blind
// to it — we therefore also treat "we stored it empty but the node's block now carries txs" as a
// positive divergence (the exact equal-height tip-swap that would orphan token_transfers).
function nodeHasTransactions(nodeBlock: BlockData): boolean {
  return Array.isArray(nodeBlock.transactions) && nodeBlock.transactions.length > 0;
}
// CONFIDENT consistency: merkle present on BOTH sides and equal, with no contradicting previous_hash.
// Only a positive match anchors the fork point — an ambiguous (both-empty) height never does.
function blockIdentityMatches(stored: BlockRow, nodeBlock: BlockData): boolean {
  const nodeMerkle = bytesToHex(nodeBlock.merkle_root);
  const nodePrev = bytesToHex(nodeBlock.previous_hash);
  if (!stored.merkle_root || !nodeMerkle || stored.merkle_root !== nodeMerkle) return false;
  if (stored.previous_hash && nodePrev && stored.previous_hash !== nodePrev) return false;
  return true;
}
// POSITIVE divergence: a concrete merkle/previous_hash mismatch, OR our empty (null-roots, tx_count 0)
// block whose node counterpart now carries txs. Ambiguous (both empty) ⇒ false (never nukes good rows).
function blockIdentityDiverged(stored: BlockRow, nodeBlock: BlockData): boolean {
  const nodeMerkle = bytesToHex(nodeBlock.merkle_root);
  const nodePrev = bytesToHex(nodeBlock.previous_hash);
  if (stored.merkle_root && nodeMerkle && stored.merkle_root !== nodeMerkle) return true;
  if (stored.previous_hash && nodePrev && stored.previous_hash !== nodePrev) return true;
  if (!stored.merkle_root && (stored.tx_count || 0) === 0 && nodeHasTransactions(nodeBlock)) return true;
  return false;
}

// F3 throttle state: bound the cadence so re-validation runs O(reorg-depth) per window, never per block.
let lastRevalidateAt = 0;
let isRevalidating = false;

// F3: bounded tail re-validation for EQUAL-height / shallow reorgs. QNet can re-produce a block at an
// equal height (tip height unchanged) — forward-only sync ingests each height once, so a swapped block
// H and its orphaned token_transfers would never be re-fetched (F2 only fires on a backward move).
// Walk back from the tip (bounded by REVALIDATE_DEPTH): descend PAST ambiguous (both-empty) heights,
// stop at the first CONFIDENT match (the fork), and roll back above it ONLY if a concrete divergence
// was actually seen — so a healthy all-empty tail is left untouched while a tx-adding tip-swap (empty→
// non-empty) is caught. Forward sync then re-ingests H.. (replaceTokenTransfers' DELETE-by-range).
// O(reorg-depth), never O(chain).
async function revalidateChainTail(): Promise<void> {
  const syncState = await getSyncState();
  const tip = typeof syncState?.last_height === 'number' ? syncState.last_height : Number(syncState?.last_height) || -1;
  if (tip <= GENESIS_FLOOR) return;
  const floor = Math.max(GENESIS_FLOOR + 1, tip - REVALIDATE_DEPTH + 1);
  let fork = -1;               // highest height we can POSITIVELY confirm consistent with the node
  let sawDivergence = false;
  for (let h = tip; h >= floor; h--) {
    const stored = await getBlockByHeight(h);
    if (!stored) continue;                 // never indexed — nothing to compare
    const fetched = await fetchBlock(h);
    if (!fetched) return;                  // transient node error — abort, keep existing rows
    if (blockIdentityMatches(stored, fetched.block)) { fork = h; break; } // consistent from here down
    if (blockIdentityDiverged(stored, fetched.block)) sawDivergence = true;
    // else ambiguous (both empty) — cannot confirm; keep descending past it
  }
  // Roll back ONLY when a concrete divergence was seen: above the confirmed fork, or the bounded window
  // floor if none was found (deeper fork — the next throttled pass walks further). Never on ambiguity.
  if (sawDivergence) {
    const above = fork >= 0 ? fork : floor - 1;
    await rollbackChainAbove(above, fork >= 0
      ? `tail re-validation: fork above ${fork}`
      : `tail re-validation: divergence throughout [${floor}, ${tip}]`);
  }
}

// F3: throttled entry point. Reachable from poll/catchup AND the live WS path so an equal-height
// reorg at the tip is caught even when the height never changes; the throttle keeps it off the
// per-block hot path.
async function maybeRevalidateChainTail(): Promise<void> {
  const now = Date.now();
  if (isRevalidating || now - lastRevalidateAt < REVALIDATE_INTERVAL) return;
  lastRevalidateAt = now;
  isRevalidating = true;
  try {
    await revalidateChainTail();
  } catch (err) {
    warn('[Sync] tail re-validation error:', err);
  } finally {
    isRevalidating = false;
  }
}

async function runCatchupSync(): Promise<void> {
  try {
    const heightRes = await fetch(`${NODE_RPC_URL}/api/v1/height`, {
      cache: 'no-store',
      headers: getApiHeaders(),
      signal: AbortSignal.timeout(15000),
    });
    if (!heightRes.ok) return;
    
    const heightData = await heightRes.json();
    const networkHeight = heightData.height;
    if (!networkHeight || networkHeight < 0) return;
    
    const syncState = await getSyncState();
    let lastHeight = typeof syncState?.last_height === 'number'
      ? syncState.last_height
      : Number(syncState?.last_height) || -1;

    // Backward height move (F2): bounded reorg → scoped rollback (keeps DB populated); genuine
    // fresh genesis → full wipe. reconcile returns the reconciled tip (newHeight, or -1 on wipe).
    if (networkHeight < lastHeight) {
      lastHeight = await reconcileBackwardHeight(networkHeight, lastHeight, `catchup network=${networkHeight} < local=${lastHeight}`);
    }

    const gap = networkHeight - lastHeight - 1;
    if (gap <= 0) {
      // Height already caught up — still re-validate the tail for an equal-height reorg (F3).
      await maybeRevalidateChainTail();
      console.log('[Sync] Catchup: already synced');
      return;
    }
    
    console.log(`[Sync] Catchup: gap=${gap} blocks (local=${lastHeight}, network=${networkHeight})`);
    
    // 1) Jump last_height to live immediately so NewBlock WS can handle new blocks
    await updateSyncState(networkHeight);
    console.log(`[Sync] Catchup: jumped to live (height=${networkHeight})`);
    
    // 2) Start background backfill to scan ALL missed blocks, save ONLY those with TX
    if (!isBackfillRunning) {
      const scanFrom = Math.max(lastHeight + 1, 0);
      const scanTo = networkHeight;
      console.log(`[Sync] Backfill: starting scan ${scanFrom} → ${scanTo} (TX-only save)`);
      // Don't await - runs in background
      runBackfillScan(scanFrom, scanTo).catch(err => 
        console.error('[Sync] Backfill failed:', err)
      );
    }
  } catch (err) {
    console.error('[Sync] Catchup error:', err);
  }
}

// Fetch a batch of blocks via HTTP RPC (POST /rpc) - faster than WS for parallel
async function fetchBlocksViaHttpRpc(start: number, limit: number): Promise<BlockData[]> {
  const effectiveLimit = Math.min(limit, 10); // 10 blocks/req optimal (5→1.7s, 10→2.7s, 20→21s)
  // Retry up to 2 times on failure (TX blocks make response larger → slower)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${NODE_RPC_URL}/rpc`, {
        method: 'POST',
        headers: getApiHeaders(),
        body: JSON.stringify({
        jsonrpc: '2.0',
        id: rpcRequestId++,
        method: 'chain_getBlocks',
          params: { start, limit: effectiveLimit }
        }),
        signal: AbortSignal.timeout(120000), // 120s - TX blocks can be 500KB+
      });
      if (!res.ok) {
        console.error(`[HTTP-RPC] ${start}: HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      return Array.isArray(data.result) ? data.result : [];
    } catch (err: any) {
      console.error(`[HTTP-RPC] Batch ${start} attempt ${attempt + 1} failed: ${err.message}`);
      if (attempt === 0) await new Promise(r => setTimeout(r, 1000));
    }
  }
  return [];
}

// Background scan: PARALLEL HTTP RPC - 15 streams × 10 blocks = 150 blocks/round
async function runBackfillScan(fromHeight: number, toHeight: number): Promise<void> {
  if (isBackfillRunning) {
    console.log('[Sync] Backfill: already running');
    return;
  }
  isBackfillRunning = true;
  
  const BATCH_SIZE = 10;
  const PARALLEL = 15; // 15 parallel HTTP connections (sweet spot for throughput)
  const ROUND_SIZE = BATCH_SIZE * PARALLEL; // 150 blocks per round
  const startTime = Date.now();
  let scanned = 0;
  let txBlocksSaved = 0;
  let totalTxSaved = 0;
  let currentHeight = fromHeight;
  let failedBatchRanges: { start: number; end: number }[] = [];
  
  try {
    // Genesis first via dedicated fast path (HTTP RPC single block)
    if (currentHeight === 0) {
      console.log('[Backfill] Genesis via HTTP RPC...');
      try {
        const genesis = await fetchBlockViaHttpRpc(0);
        if (genesis) {
          const txCount = Array.isArray(genesis.block.transactions) ? genesis.block.transactions.length : 0;
          if (txCount > 0) {
            const saved = await saveBlocksBatch([{ height: 0, block: genesis.block }]);
            txBlocksSaved++;
            totalTxSaved += saved;
            console.log(`[Backfill] Genesis: ${txCount} TX, ${saved} saved`);
          }
        }
      } catch (err) {
        console.error('[Backfill] Genesis failed:', err);
      }
      currentHeight = 1;
      scanned++;
    }
    
    while (currentHeight <= toHeight) {
      // Launch PARALLEL batch requests simultaneously
      const promises: Promise<{ startH: number; blocks: BlockData[] }>[] = [];
      
      for (let p = 0; p < PARALLEL; p++) {
        const batchStart = currentHeight + p * BATCH_SIZE;
        if (batchStart > toHeight) break;
        const batchLimit = Math.min(BATCH_SIZE, toHeight - batchStart + 1);
        
        promises.push(
          fetchBlocksViaHttpRpc(batchStart, batchLimit)
            .then(blocks => ({ startH: batchStart, blocks }))
            .catch(err => {
              console.error(`[Backfill] LOST batch ${batchStart}-${batchStart + batchLimit - 1}: ${err.message}`);
              return { startH: batchStart, blocks: [] as BlockData[] };
            })
        );
      }
      
      // Wait for ALL parallel requests
      const results = await Promise.all(promises);
      
      // Process results - save only blocks with TX
      const txBlocks: { height: number; block: BlockData }[] = [];
      let maxHeightSeen = currentHeight - 1;
      
      for (const { startH, blocks } of results) {
        if (blocks.length > 0) {
          for (let i = 0; i < blocks.length; i++) {
            const block = blocks[i] as BlockData;
            // Use block.height from node if available, fall back to startH + i
            const height = typeof block.height === 'number' ? block.height : (startH + i);
            if (height > maxHeightSeen) maxHeightSeen = height;
            const txCount = Array.isArray(block.transactions) ? block.transactions.length : 0;
            if (txCount > 0) {
              txBlocks.push({ height, block });
              console.log(`[Backfill] Block ${height}: ${txCount} TX`);
            }
          }
        } else {
          // Failed batch — DON'T skip! Track highest expected height for retry
          const batchEnd = startH + BATCH_SIZE - 1;
          if (batchEnd > maxHeightSeen) maxHeightSeen = batchEnd;
          console.warn(`[Backfill] RETRY: batch ${startH}-${batchEnd} failed, will be retried`);
          // Queue failed range for immediate retry
          failedBatchRanges.push({ start: startH, end: Math.min(batchEnd, toHeight) });
        }
      }
      
      // Save TX blocks
      if (txBlocks.length > 0) {
        const saved = await saveBlocksBatch(txBlocks);
        txBlocksSaved += txBlocks.length;
        totalTxSaved += saved;
      }
      
      // Advance currentHeight based on actual max height seen
      const roundScanned = maxHeightSeen - currentHeight + 1;
      scanned += Math.max(roundScanned, 0);
      currentHeight = maxHeightSeen + 1;
      
      // Progress log every 500 blocks
      if (scanned % 500 < ROUND_SIZE) {
        const total = toHeight - fromHeight + 1;
        const pct = ((scanned / total) * 100).toFixed(1);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const speed = scanned > 0 ? (scanned / ((Date.now() - startTime) / 1000)).toFixed(1) : '0';
        console.log(`[Backfill] ${pct}% (${scanned}/${total}) ${speed} blk/s | ${txBlocksSaved} TX-blocks, ${totalTxSaved} TX | ${elapsed}s`);
      }
    }
    
    // Retry failed batches (up to 3 attempts)
    for (let retryAttempt = 0; retryAttempt < 3 && failedBatchRanges.length > 0; retryAttempt++) {
      const toRetry = [...failedBatchRanges];
      failedBatchRanges = [];
      console.log(`[Backfill] Retrying ${toRetry.length} failed batches (attempt ${retryAttempt + 1}/3)...`);
      await new Promise(r => setTimeout(r, 2000)); // Wait before retry
      
      for (const range of toRetry) {
        try {
          const blocks = await fetchBlocksViaHttpRpc(range.start, range.end - range.start + 1);
          if (blocks.length > 0) {
            const txB: { height: number; block: BlockData }[] = [];
            for (let i = 0; i < blocks.length; i++) {
              const block = blocks[i] as BlockData;
              const height = typeof block.height === 'number' ? block.height : (range.start + i);
              const txCount = Array.isArray(block.transactions) ? block.transactions.length : 0;
              if (txCount > 0) {
                txB.push({ height, block });
                console.log(`[Backfill-Retry] Block ${height}: ${txCount} TX`);
              }
            }
            if (txB.length > 0) {
              const saved = await saveBlocksBatch(txB);
              txBlocksSaved += txB.length;
              totalTxSaved += saved;
            }
          } else {
            failedBatchRanges.push(range);
          }
        } catch {
          failedBatchRanges.push(range);
        }
      }
    }
    
    // Ranges the in-run retries could not fill go to the persistent gap ledger;
    // the sweeper owns them until the blocks table has no holes. "3 attempts and
    // forget" left 854 permanently missing blocks after one node restart storm.
    if (failedBatchRanges.length > 0) {
      await recordGaps(failedBatchRanges);
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Backfill] DONE: scanned ${scanned} in ${totalTime}s | ${txBlocksSaved} TX-blocks, ${totalTxSaved} TX saved`);

  } finally {
    isBackfillRunning = false;
  }
}

// Lock to prevent multiple parallel syncs
let isSyncingBlocks = false;

// FAST BATCH: Fetch multiple blocks in parallel (HTTP only, no DB)
async function fetchBlocksBatch(heights: number[]): Promise<{ height: number; block: BlockData }[]> {
  const results = await Promise.allSettled(
    heights.map(h => fetchBlock(h))
  );
  
  const blocks: { height: number; block: BlockData }[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      const { height, block } = result.value;
      // DEBUG: Check if block has transactions
      const txCount = Array.isArray(block.transactions) ? block.transactions.length : 0;
      if (txCount > 0) {
        console.log(`[Fetch] Block ${height} fetched with ${txCount} TX`);
      }
      blocks.push({ height, block });
    }
  }
  return blocks;
}

// ============================================================================
// TOKEN TRANSFERS: effect-sourced index from the node token-transfers endpoint
// ============================================================================
const TOKEN_TRANSFER_RANGE_CAP = 10000; // node caps the height range per request
const TOKEN_TRANSFER_ROW_LIMIT = 5000;  // node's range reader hard-stops at this many rows

// One decoded transfer row as returned by the node. `amount` is a u64 base-unit
// DECIMAL STRING — kept as a string end-to-end (never Number()).
interface NodeTokenTransfer {
  contract?: string;
  from?: string;
  to?: string;
  amount?: string | number;
  kind?: string;
  std?: string;
  token_id?: string;
  tx_hash?: string;
  log_index?: number;
  height?: number;
  timestamp?: number;
}

// Replace the token_transfers rows for a height range in ONE transaction: first
// DELETE the range, then insert. This mirrors the node's clear-and-reindex on reorg,
// so re-ingesting a height fully replaces its rows (an orphaned transfer that is no
// longer re-included is correctly removed). ON CONFLICT DO NOTHING keeps the insert
// idempotent for the boundary rows a paginated re-fetch may return twice. Never throws.
async function replaceTokenTransfers(fromBlock: number, toBlock: number, list: NodeTokenTransfer[]): Promise<void> {
  const db = getDbPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM token_transfers WHERE block >= $1 AND block <= $2', [fromBlock, toBlock]);
    for (const t of list) {
      const txHash = typeof t.tx_hash === 'string' ? t.tx_hash : '';
      const logIndex = Number(t.log_index);
      const contract = typeof t.contract === 'string' ? t.contract : '';
      if (!txHash || !Number.isInteger(logIndex) || !contract) continue;
      // Keep amount as an exact base-unit digit string; reject anything non-numeric.
      const amountStr = typeof t.amount === 'string'
        ? t.amount.trim()
        : (typeof t.amount === 'number' && Number.isFinite(t.amount) ? Math.trunc(t.amount).toString() : '0');
      const amount = /^\d+$/.test(amountStr) ? amountStr : '0';
      await client.query(
        `INSERT INTO token_transfers (
           tx_hash, log_index, contract, from_address, to_address,
           amount, kind, std, token_id, block, timestamp
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (tx_hash, log_index) DO NOTHING`,
        [
          txHash,
          logIndex,
          contract,
          typeof t.from === 'string' ? t.from : '',
          typeof t.to === 'string' ? t.to : '',
          amount,
          typeof t.kind === 'string' ? t.kind : '',
          typeof t.std === 'string' ? t.std : '',
          typeof t.token_id === 'string' ? t.token_id : '',
          Number.isInteger(t.height) ? t.height : 0,
          Number.isInteger(t.timestamp) ? t.timestamp : 0,
        ]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    warn('[Sync] token-transfers replace failed:', err);
  } finally {
    client.release();
  }
}

// Drain ALL transfer rows for a single node-range window [start, end], paging past the node's
// TOKEN_TRANSFER_ROW_LIMIT hard cap via the endpoint's within-height cursor: when the node sets
// `truncated`, it returns `next_cursor` ({height}_{log_index} of the last row served) which we pass
// back as `after`, so even a single block holding > ROW_LIMIT events pages fully — no tail dropped.
// MAX_PAGES bounds a misbehaving node. Returns null on a hard fetch error so the caller can skip the
// reorg-delete and keep existing rows; [] means the window is genuinely empty.
async function fetchTokenTransfersWindow(start: number, end: number): Promise<NodeTokenTransfer[] | null> {
  const rows: NodeTokenTransfer[] = [];
  const MAX_PAGES = 4096;
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    let body: { transfers?: unknown; truncated?: boolean; next_cursor?: unknown } | null;
    try {
      const url = `${NODE_RPC_URL}/api/v1/token-transfers?from=${start}&to=${end}&limit=${TOKEN_TRANSFER_ROW_LIMIT}`
        + (after ? `&after=${after}` : '');
      const res = await fetch(url, { cache: 'no-store', headers: getApiHeaders(), signal: AbortSignal.timeout(15000) });
      if (!res.ok) {
        warn(`[Sync] token-transfers ${start}-${end}: HTTP ${res.status}`);
        return null;
      }
      body = await res.json().catch(() => null);
    } catch (err) {
      warn(`[Sync] token-transfers ${start}-${end} failed:`, err);
      return null;
    }
    const list: unknown = body?.transfers;
    rows.push(...(Array.isArray(list) ? (list as NodeTokenTransfer[]) : []));
    // More rows remain past this page ⇒ continue from the node's within-height cursor.
    if (!body?.truncated || typeof body?.next_cursor !== 'string' || !body.next_cursor) break;
    after = body.next_cursor;
    if (page === MAX_PAGES - 1) warn(`[Sync] token-transfers ${start}-${end}: hit ${MAX_PAGES}-page cap`);
  }
  return rows;
}

// Fetch + index token transfers for a saved height range. Chunks to respect the
// node's max height range, paginates WITHIN each chunk (row cap), and replaces each
// chunk's rows transactionally (reorg reconciliation). Non-fatal: a failed fetch
// skips that chunk (keeps existing rows); block sync continues regardless.
async function ingestTokenTransfers(fromHeight: number, toHeight: number): Promise<void> {
  if (!Number.isInteger(fromHeight) || !Number.isInteger(toHeight) || fromHeight < 0 || toHeight < fromHeight) return;
  for (let start = fromHeight; start <= toHeight; start += TOKEN_TRANSFER_RANGE_CAP) {
    const end = Math.min(start + TOKEN_TRANSFER_RANGE_CAP - 1, toHeight);
    const rows = await fetchTokenTransfersWindow(start, end);
    if (rows === null) continue; // transient fetch failure — leave the range untouched
    await replaceTokenTransfers(start, end, rows);
  }
}

// FAST BATCH: Save multiple blocks to DB in one batch
// ═══════════════════════════════════════════════════════════════════
// Gap ledger: completeness is an invariant (gaps table empty), not a
// best-effort. Failed fetch ranges are recorded and swept until filled;
// ranges halve on repeated failure down to single blocks, and a periodic
// hole scan over the blocks table re-enqueues anything lost elsewhere.
// ═══════════════════════════════════════════════════════════════════

async function ensureGapTable(): Promise<void> {
  await query(`CREATE TABLE IF NOT EXISTS sync_gaps (
    start_h BIGINT PRIMARY KEY,
    end_h BIGINT NOT NULL,
    tries INT NOT NULL DEFAULT 0,
    next_retry_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
}

async function recordGaps(ranges: { start: number; end: number }[]): Promise<void> {
  try {
    await ensureGapTable();
    for (const r of ranges) {
      await query(
        `INSERT INTO sync_gaps (start_h, end_h) VALUES ($1, $2)
         ON CONFLICT (start_h) DO UPDATE SET end_h = GREATEST(sync_gaps.end_h, EXCLUDED.end_h)`,
        [r.start, r.end]
      );
    }
    console.log(`[Gaps] recorded ${ranges.length} range(s)`);
  } catch (err) {
    console.error('[Gaps] record failed:', err);
  }
}

let isSweepingGaps = false;

async function sweepGaps(maxRanges: number = 4): Promise<void> {
  if (isSweepingGaps) return;
  isSweepingGaps = true;
  try {
    await ensureGapTable();

    // Re-enqueue holes the blocks table itself shows (any loss path, any era).
    const holes = await query<{ gap_start: string; gap_end: string }>(
      `WITH g AS (SELECT height, lead(height) OVER (ORDER BY height) nxt FROM blocks)
       SELECT height + 1 AS gap_start, nxt - 1 AS gap_end
       FROM g WHERE nxt - height > 1 LIMIT 20`
    );
    if (holes.rows.length > 0) {
      await recordGaps(holes.rows.map(r => ({ start: Number(r.gap_start), end: Number(r.gap_end) })));
    }

    const due = await query<{ start_h: string; end_h: string; tries: number }>(
      `SELECT start_h, end_h, tries FROM sync_gaps WHERE next_retry_at <= now()
       ORDER BY start_h LIMIT $1`, [maxRanges]
    );
    for (const row of due.rows) {
      const start = Number(row.start_h);
      const end = Number(row.end_h);
      try {
        const blocks = await fetchBlocksViaHttpRpc(start, end - start + 1);
        if (blocks.length > 0) {
          const all: { height: number; block: BlockData }[] = blocks.map((b, i) => ({
            height: typeof (b as BlockData).height === 'number' ? (b as BlockData).height as number : start + i,
            block: b as BlockData,
          }));
          await saveBlocksBatch(all);
          await query('DELETE FROM sync_gaps WHERE start_h = $1', [start]);
          console.log(`[Gaps] filled ${start}-${end} (${all.length} blocks)`);
          continue;
        }
        throw new Error('empty response');
      } catch (err) {
        if (end > start) {
          // Halve: heavy ranges pass block-by-block eventually.
          const mid = Math.floor((start + end) / 2);
          await query('DELETE FROM sync_gaps WHERE start_h = $1', [start]);
          await recordGaps([{ start, end: mid }, { start: mid + 1, end }]);
          console.warn(`[Gaps] split ${start}-${end} after failure: ${(err as Error).message}`);
        } else {
          await query(
            `UPDATE sync_gaps SET tries = tries + 1,
             next_retry_at = now() + make_interval(secs => LEAST(600, 30 * POWER(2, tries)))
             WHERE start_h = $1`, [start]
          );
          console.warn(`[Gaps] block ${start} still failing (try ${row.tries + 1}): ${(err as Error).message}`);
        }
      }
    }
  } catch (err) {
    console.error('[Gaps] sweep failed:', err);
  } finally {
    isSweepingGaps = false;
  }
}

async function saveBlocksBatch(blocks: { height: number; block: BlockData }[]): Promise<number> {
  let totalTx = 0;
  
  // Collect all transactions from all blocks
  const allTransactions: TransactionFromNode[] = [];
  
  for (const { height, block } of blocks) {
    const txs = Array.isArray(block.transactions) ? block.transactions : [];
    
    // DEBUG: Log blocks with transactions
    if (txs.length > 0) {
      console.log(`[Sync] Block ${height} has ${txs.length} TX`);
    }
    const blockTs = Number(block.timestamp) || 0;
    
    // Calculate total gas used
    const U64_MAX = 18446744073709551615;
    let totalGasUsed = 0;
    for (const tx of txs as Record<string, unknown>[]) {
      const gasPrice = Number(tx.gas_price) || 0;
      const gasLimit = Number(tx.gas_limit) || 0;
      if (gasPrice >= U64_MAX - 1000 || gasPrice < 0) continue;
      const gasUsed = Number(tx.gas_used) || (gasPrice * gasLimit);
      totalGasUsed += gasUsed;
    }

    // Save block (fire and forget for speed)
    try {
      await insertBlock({
        height,
        hash: block.hash || `block_${height}`,
        block_type: (block.block_type as string) || 'MICROBLOCK',
        version: (block.version as number) || 1,
        timestamp: blockTs > 1e12 ? blockTs : blockTs * 1000,
        previous_hash: bytesToHex(block.previous_hash) || null,
        merkle_root: bytesToHex(block.merkle_root) || null,
        state_root: bytesToHex(block.state_root) || null,
        producer: (block.producer as string) || 'unknown',
        producer_address: (block.producer_address as string) || null,
        tx_count: txs.length,
        total_gas_used: totalGasUsed,
        poh_hash: bytesToHex(block.poh_hash) || null,
        poh_count: (block.poh_count as number) || 0,
        signature_type: (block.signature_type as string) || 'ML-DSA-65',
        signature: (block.signature as string) || null,
        cert_serial: (block.cert_serial as string) || null,
        qrb_output: bytesToHex(block.qrb_output) || null,
        size_bytes: (block.size_bytes as number) || 0,
        consensus_data: (block.consensus_data as Record<string, unknown>) || null,
        micro_blocks: Array.isArray(block.micro_blocks) ? (block.micro_blocks as string[]) : null,
      });
    } catch (err) {
      // Ignore block save errors, continue with transactions
    }

    // Transform transactions
    for (const tx of txs as Record<string, unknown>[]) {
      const transformed = transformTransaction(tx, height, blockTs);
      if (transformed) {
        allTransactions.push(transformed);
        totalTx++;
      }
    }
  }

  // Deduplicate by hash
  const seenHashes = new Set<string>();
  const uniqueTransactions: TransactionFromNode[] = [];
  for (const tx of allTransactions) {
    if (!seenHashes.has(tx.hash)) {
      seenHashes.add(tx.hash);
      uniqueTransactions.push(tx);
    }
  }

  // Batch insert all transactions at once
  if (uniqueTransactions.length > 0) {
    console.log(`[Sync] Saving ${uniqueTransactions.length} transactions from ${blocks.length} blocks`);
    const MAX_BATCH_SIZE = 5000;
    for (let i = 0; i < uniqueTransactions.length; i += MAX_BATCH_SIZE) {
      const batch = uniqueTransactions.slice(i, i + MAX_BATCH_SIZE);
      try {
        await insertTransactionsBatch(batch.map(tx => ({
          hash: tx.hash,
          from_address: tx.from,
          to_address: tx.to,
          amount: tx.amount,
          nonce: tx.nonce,
          block: tx.block,
          timestamp: tx.timestamp,
          gas_price: tx.gas_price,
          gas_limit: tx.gas_limit,
          signature: tx.signature,
          public_key: tx.public_key,
          dilithium_signature: tx.dilithium_signature,
          dilithium_public_key: tx.dilithium_public_key,
          tx_type: typeof tx.tx_type === 'string' ? tx.tx_type : JSON.stringify(tx.tx_type),
          tx_type_data: tx.tx_type_data ?? null,
          data: tx.data,
          status: tx.status,
          is_quantum_signed: tx.is_quantum_signed
        })));
      } catch (err) {
        // Log batch errors for debugging
        console.error(`[Sync] TX batch insert error:`, err);
      }
    }
  }

  // Index effect-sourced token transfers across the saved height range (non-fatal).
  if (blocks.length > 0) {
    let minH = Infinity;
    let maxH = -Infinity;
    for (const { height } of blocks) {
      if (height < minH) minH = height;
      if (height > maxH) maxH = height;
    }
    if (Number.isFinite(minH) && Number.isFinite(maxH)) {
      await ingestTokenTransfers(minH, maxH);
    }
  }

  return totalTx;
}

// Process multiple blocks in parallel (limited concurrency)
async function processBlocksParallel(heights: number[]): Promise<number> {
  const results = await Promise.allSettled(
    heights.map(h => processSingleBlock(h))
  );
  
  let totalTx = 0;
  for (const result of results) {
    if (result.status === 'fulfilled') {
      totalTx += result.value;
    }
  }
  return totalTx;
}

// Recover missing transactions by scanning recent blocks from the NODE (not blocks table)
// Uses parallel scanning (like backfill) for speed
// scanDepth: 5000 at startup (full recovery), 500 for periodic checks (fast)
async function recoverMissingTransactions(scanDepth: number = 5000): Promise<void> {
  try {
    const syncState = await getSyncState();
    const lastHeight = Number(syncState?.last_height) || 0;
    if (lastHeight <= 0) return;

    const SCAN_RANGE = scanDepth;
    const fromHeight = Math.max(1, lastHeight - SCAN_RANGE);
    const BATCH_SIZE = 20;
    const PARALLEL = 10; // 10 parallel RPC streams
    let recovered = 0;
    let blocksWithMissingTx: number[] = [];

    console.log(`[Recovery] Scanning blocks ${fromHeight}→${lastHeight} for missing TXs (parallel)...`);

    // Phase 1: Parallel scan — find blocks with TXs that are missing from DB
    for (let h = fromHeight; h <= lastHeight; h += BATCH_SIZE * PARALLEL) {
      const promises: Promise<number[]>[] = [];

      for (let p = 0; p < PARALLEL; p++) {
        const batchStart = h + p * BATCH_SIZE;
        if (batchStart > lastHeight) break;
        const batchLimit = Math.min(BATCH_SIZE, lastHeight - batchStart + 1);

        promises.push(
          (async () => {
            const missing: number[] = [];
            try {
              const blocks = await fetchBlocksViaHttpRpc(batchStart, batchLimit);
              for (const block of blocks) {
                const txs = Array.isArray(block.transactions) ? block.transactions : [];
                if (txs.length === 0) continue;
                const height = (block.height as number) ?? batchStart;
                const result = await query<{ cnt: string }>(
                  'SELECT COUNT(*) AS cnt FROM transactions WHERE block = $1',
                  [height]
                );
                const actualCount = Number(result.rows[0]?.cnt) || 0;
                if (actualCount < txs.length) {
                  missing.push(height);
                }
              }
            } catch { /* skip failed batch */ }
            return missing;
          })()
        );
      }

      const results = await Promise.all(promises);
      for (const missing of results) {
        blocksWithMissingTx.push(...missing);
      }
    }

    if (blocksWithMissingTx.length === 0) {
      console.log(`[Recovery] All blocks have complete TX data`);
      return;
    }

    // Phase 2: Re-process blocks with missing TXs
    console.log(`[Recovery] Found ${blocksWithMissingTx.length} blocks with missing TXs: ${blocksWithMissingTx.join(', ')}`);

    for (const height of blocksWithMissingTx) {
      try {
        const added = await processSingleBlock(height);
        if (added > 0) {
          recovered += added;
          console.log(`[Recovery] Block ${height}: recovered ${added} TX`);
        }
      } catch (err) {
        console.error(`[Recovery] Block ${height} failed:`, err);
      }
    }

    console.log(`[Recovery] Done — recovered ${recovered} TXs from ${blocksWithMissingTx.length} blocks`);
  } catch (err) {
    console.error('[Recovery] Error during missing TX recovery:', err);
  }
}

// Initial sync: delegates to runCatchupSync which handles everything
async function runInitialSync(): Promise<void> {
  console.log('[Sync] Initial sync → delegating to catchup...');
  await runCatchupSync();

  // Wait for backfill to complete before running recovery
  // (backfill and recovery both scan blocks — running them in parallel
  //  doubles the load on the node and causes rate limiting / slowdowns)
  if (isBackfillRunning) {
    console.log('[Sync] Waiting for backfill to complete before recovery...');
    while (isBackfillRunning) {
      await new Promise(r => setTimeout(r, 5000));
    }
    console.log('[Sync] Backfill completed, starting recovery scan...');
  }

  // After catchup, recover any TXs that were lost due to previous validation bugs
  // Use FULL chain depth to catch all missing TXs (not just last 5000)
  const syncState = await getSyncState();
  const lastHeight = Number(syncState?.last_height) || 0;
  const fullDepth = Math.max(lastHeight, 5000);
  console.log(`[Sync] Initial recovery: scanning ALL ${fullDepth} blocks for missing TXs...`);
  await recoverMissingTransactions(fullDepth);
}

// Verify data integrity
let isVerifying = false;

async function verifyDataIntegrity(): Promise<void> {
  if (isVerifying) {
    log('[Integrity] Integrity check already in progress, skipping...');
    return;
  }
  
  isVerifying = true;
  
  try {
    const MAX_INTEGRITY_CHECK = 50;
    const result = await query<{ hash: string }>(
      `SELECT hash FROM transactions ORDER BY RANDOM() LIMIT ${MAX_INTEGRITY_CHECK}`
    );

    let mismatches = 0;

    for (const row of result.rows) {
      const hash = row.hash;
      
      const dbTxResult = await query(
        'SELECT * FROM transactions WHERE hash = $1',
        [hash]
      );

      if (dbTxResult.rows.length === 0) continue;
      
      const dbTx = dbTxResult.rows[0];

      const nodeRes = await fetch(`${NODE_RPC_URL}/api/v1/transaction/${hash}`, {
        cache: 'no-store',
        headers: getApiHeaders(),
        signal: AbortSignal.timeout(3000),
      });

      if (!nodeRes.ok) continue;

      const responseText = await nodeRes.text();
      if (responseText.length > 10 * 1024 * 1024) {
        warn(`[Integrity] Transaction ${hash} response too large: ${responseText.length} bytes`);
        continue;
      }
      
      let nodeData: { transaction?: Record<string, unknown> };
      try {
        nodeData = JSON.parse(responseText) as { transaction?: Record<string, unknown> };
      } catch (parseErr) {
        warn(`[Integrity] Failed to parse transaction ${hash} JSON:`, parseErr);
        continue;
      }
      
      if (!nodeData.transaction) continue;

      const nodeTx = nodeData.transaction as Record<string, unknown>;

      const verification = verifyTransactionIntegrity(
        dbTx as Record<string, unknown>, 
        nodeTx
      );

      if (!verification.valid) {
        mismatches++;
        logSecurityEvent('data_tampering', {
          hash,
          differences: verification.differences
        });

        const blockHeight = ((nodeTx.block_height as number) || (nodeTx.block as number) || (dbTx.block as number) || 0) as number;
        // Fetch block timestamp from DB (authoritative chain time, not tx signing time)
        let blockTs = 0;
        if (blockHeight > 0) {
          try {
            const blockRow = await query<{ timestamp: number }>(
              'SELECT timestamp FROM blocks WHERE height = $1',
              [blockHeight]
            );
            if (blockRow.rows.length > 0) {
              blockTs = Number(blockRow.rows[0].timestamp) || 0;
            }
          } catch { /* fallback to 0 */ }
        }

        const restored = transformTransaction(
          nodeTx as Record<string, unknown>,
          blockHeight,
          blockTs
        );

        if (restored) {
          await insertTransactionsBatch([{
            hash: restored.hash,
            from_address: restored.from,
            to_address: restored.to,
            amount: restored.amount,
            nonce: restored.nonce,
            block: restored.block,
            timestamp: restored.timestamp,
            gas_price: restored.gas_price,
            gas_limit: restored.gas_limit,
            signature: restored.signature,
            public_key: restored.public_key,
            dilithium_signature: restored.dilithium_signature,
            dilithium_public_key: restored.dilithium_public_key,
            tx_type: typeof restored.tx_type === 'string' ? restored.tx_type : JSON.stringify(restored.tx_type),
            tx_type_data: restored.tx_type_data ?? null,
            data: restored.data,
            status: restored.status,
            is_quantum_signed: restored.is_quantum_signed
          }]);

          log(`[Integrity] Restored transaction ${hash} from node`);
        }
      }
    }

    if (mismatches > 0) {
      logSecurityEvent('integrity_check_failed', {
        checked: result.rows.length,
        mismatches
      });
    } else {
      log(`[Integrity] All ${result.rows.length} transactions verified`);
    }
  } catch (err) {
    error('[Integrity] Error:', err);
  } finally {
    isVerifying = false;
  }
}

// ============================================================================
// WEBSOCKET SYNC (PRIMARY MODE)
// v3.53: PARALLEL block processing + retry for failed TX blocks
// v3.52 used serialized queue which caused 2400+ block lag (reverted)
// ============================================================================

let wsConnection: WebSocket | null = null;
let wsReconnectDelay = WS_RECONNECT_DELAY_BASE;
let wsReconnectTimeout: NodeJS.Timeout | null = null;
let wsHeartbeatInterval: NodeJS.Timeout | null = null;
let wsReconnectAttempts = 0;
let isWsConnected = false;

// v3.53: Retry queue for blocks with TX that failed to process
// If HTTP fetch fails, the TX block is retried instead of silently lost
const failedTxBlocks: Map<number, { txCount: number; retries: number; nextRetry: number }> = new Map();
const MAX_TX_RETRIES = 10;
const TX_RETRY_INTERVAL = 2000; // 2 seconds between retries
let retryTimer: NodeJS.Timeout | null = null;

// v3.53: PARALLEL block processing — each block handled independently
// Empty blocks (99%+) complete in <100ms. TX blocks run in background.
// CRITICAL FIX: The v3.52 serialized queue caused 2400+ block lag because
// one TX block (HTTP fetch 2-30s) blocked ALL subsequent empty blocks.
// With parallel processing, empty blocks are never blocked by TX fetches.
async function handleNewBlockEvent(event: WsNewBlockEvent): Promise<void> {
  const height = event.data.height;
  const txCount = event.data.tx_count || 0;

  // Check for gap (e.g. after sleep/disconnect — WS reconnected but blocks were missed)
  const syncState = await getSyncState();
  const lastHeight = typeof syncState?.last_height === 'number'
    ? syncState.last_height
    : Number(syncState?.last_height) || -1;

  // Backward height move: a single WS event below our tip may be a STALE/out-of-order delivery (handlers
  // are unserialized) rather than a real reorg — so corroborate against the node's authoritative /height
  // before any destructive rollback. Only reconcile when the node ITSELF reports a lower tip; roll back to
  // that node tip (not the possibly-stale event height). Forward sync then re-ingests.
  if (height < lastHeight) {
    let nodeTip = -1;
    try {
      const hr = await fetch(`${NODE_RPC_URL}/api/v1/height`, { cache: 'no-store', headers: getApiHeaders(), signal: AbortSignal.timeout(8000) });
      if (hr.ok) { const hj = await hr.json().catch(() => null); const h = Number(hj?.height); if (Number.isFinite(h)) nodeTip = h; }
    } catch { /* transient — treat as uncorroborated below */ }
    if (nodeTip < 0 || nodeTip >= lastHeight) return; // node still at/above our tip ⇒ stale event, ignore
    await reconcileBackwardHeight(nodeTip, lastHeight, `WS block=${height} < local=${lastHeight}, node_tip=${nodeTip}`);
    return;
  }

  const gap = height - lastHeight - 1;
  if (gap > 0) {
    // Jump sync state to just before this block so WS can continue
    await updateSyncState(height - 1);
    // Launch backfill scan for ALL missed blocks in background
    if (gap > 5 && !isBackfillRunning) {
      console.log(`[WS] Gap ${gap} blocks (${lastHeight + 1}→${height - 1}) — backfill scan started`);
      runBackfillScan(lastHeight + 1, height - 1).catch(() => {});
    }
  }

  // F3: throttled tail re-validation on the live path — catches an equal-height reorg at the tip
  // (height unchanged) during steady-state WS. Fire-and-forget; the throttle keeps it off the hot path.
  void maybeRevalidateChainTail();

  // FAST PATH: empty blocks (99%+) — save metadata from WS event, NO HTTP!
  if (txCount === 0) {
    try {
      const ts = event.data.timestamp > 1e12 ? event.data.timestamp : event.data.timestamp * 1000;
      await insertBlock({
        height,
        hash: event.data.hash || `block_${height}`,
        block_type: 'MICROBLOCK',
        version: 1,
        timestamp: ts,
        previous_hash: null,
        merkle_root: null,
        state_root: null,
        producer: event.data.producer || 'unknown',
        producer_address: null,
        tx_count: 0,
        total_gas_used: 0,
        poh_hash: null,
        poh_count: 0,
        signature_type: 'ML-DSA-65',
        signature: null,
        cert_serial: null,
        qrb_output: null,
        size_bytes: 0,
        consensus_data: null,
        micro_blocks: null,
      });
      await updateSyncState(height);
    } catch (err: any) {
      if (!err?.message?.includes('duplicate key')) {
        error(`[WS] Block ${height} save error:`, err);
      }
    }
    return;
  }

  // TX BLOCK: advance sync state first (so subsequent empty blocks aren't seen as gap)
  // then fetch full block data in background — does NOT block WS handler
  console.log(`[WS] Block ${height}: ${txCount} TX — background fetch`);
  try { await updateSyncState(height); } catch { /* non-critical */ }

  // Fire-and-forget: processSingleBlock runs in background
  processSingleBlock(height).then(added => {
    if (added > 0) {
      console.log(`[WS] Block ${height}: saved ${added} TX ✓`);
    } else {
      console.error(`[WS] Block ${height}: FAILED to fetch ${txCount} TX — queued for retry`);
      failedTxBlocks.set(height, { txCount, retries: 0, nextRetry: Date.now() + TX_RETRY_INTERVAL });
      startRetryTimer();
    }
  }).catch(err => {
    error(`[WS] Block ${height}: fetch error — queued for retry`, err);
    failedTxBlocks.set(height, { txCount, retries: 0, nextRetry: Date.now() + TX_RETRY_INTERVAL });
    startRetryTimer();
  });
}

// v3.52: Retry failed TX blocks (runs every 3 seconds until queue is empty)
function startRetryTimer(): void {
  if (retryTimer) return;
  retryTimer = setInterval(async () => {
    if (failedTxBlocks.size === 0) {
      if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
      return;
    }
    
    const now = Date.now();
    for (const [height, info] of failedTxBlocks) {
      if (now < info.nextRetry) continue;
      
      console.log(`[Retry] Block ${height}: attempt ${info.retries + 1}/${MAX_TX_RETRIES}`);
      const added = await processSingleBlock(height);
      
      if (added > 0) {
        console.log(`[Retry] Block ${height}: SUCCESS — saved ${added} TX`);
        failedTxBlocks.delete(height);
      } else {
        info.retries++;
        if (info.retries >= MAX_TX_RETRIES) {
          console.error(`[Retry] Block ${height}: GAVE UP after ${MAX_TX_RETRIES} attempts`);
          failedTxBlocks.delete(height);
        } else {
          // Exponential backoff: 3s, 6s, 12s, 24s, 48s
          info.nextRetry = now + TX_RETRY_INTERVAL * Math.pow(2, info.retries);
        }
      }
    }
    
    if (failedTxBlocks.size === 0 && retryTimer) {
      clearInterval(retryTimer);
      retryTimer = null;
    }
  }, TX_RETRY_INTERVAL);
}

function connectWebSocket(): void {
  if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
    return;
  }

  console.log(`[WS] Connecting to ${NODE_WS_URL}...`);

  try {
    wsConnection = new WebSocket(NODE_WS_URL);

    wsConnection.on('open', async () => {
      console.log('[WS] Connected to node (realtime sync enabled)');
      isWsConnected = true;
      wsReconnectDelay = WS_RECONNECT_DELAY_BASE;
      wsReconnectAttempts = 0; // Reset circuit breaker on successful connect

      // Heartbeat: ping every 30s to detect dead connections
      if (wsHeartbeatInterval) clearInterval(wsHeartbeatInterval);
      wsHeartbeatInterval = setInterval(() => {
        if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
          wsConnection.ping();
        }
      }, WS_HEARTBEAT_INTERVAL);
      
      // Only run catchup from WS if initial sync is already done
      // (otherwise initial sync handles it and WS catchup would race/override it)
      if (initialSyncDone) {
        console.log('[WS] Running catchup sync for missed blocks...');
        try {
          await runCatchupSync();
        } catch (err) {
          console.error('[WS] Catchup sync failed:', err);
        }
      } else {
        console.log('[WS] Initial sync in progress — skipping WS catchup (backfill handles it)');
      }
    });

    // v3.53: PARALLEL processing — each block handled independently
    // Empty blocks complete instantly, TX blocks run in background
    // Fire-and-forget: handler is async but NOT awaited by WS event loop
    wsConnection.on('message', (data: WebSocket.Data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === 'NewBlock') {
          handleNewBlockEvent(message as WsNewBlockEvent).catch(err =>
            error('[WS] NewBlock handler error:', err)
          );
        }
      } catch (err) {
        error('[WS] Error parsing message:', err);
      }
    });

    wsConnection.on('close', (code: number, reason: Buffer) => {
      console.log(`[WS] Disconnected (code=${code}, reason=${reason.toString()})`);
      isWsConnected = false;
      wsConnection = null;
      if (wsHeartbeatInterval) { clearInterval(wsHeartbeatInterval); wsHeartbeatInterval = null; }

      // Schedule reconnection with exponential backoff
      scheduleWsReconnect();
    });

    wsConnection.on('error', (err: Error) => {
      console.error('[WS] Connection error:', err.message);
      isWsConnected = false;
    });

  } catch (err) {
    error('[WS] Failed to create connection:', err);
    isWsConnected = false;
    scheduleWsReconnect();
  }
}

function scheduleWsReconnect(): void {
  if (wsReconnectTimeout) {
    clearTimeout(wsReconnectTimeout);
  }

  wsReconnectAttempts++;

  // Circuit breaker: after max attempts, fall back to polling permanently
  if (wsReconnectAttempts > WS_MAX_RECONNECT_ATTEMPTS) {
    console.error(`[WS] Circuit breaker: ${WS_MAX_RECONNECT_ATTEMPTS} failed attempts, falling back to polling`);
    return; // Polling fallback will keep running
  }

  console.log(`[WS] Reconnecting in ${wsReconnectDelay / 1000}s... (attempt ${wsReconnectAttempts}/${WS_MAX_RECONNECT_ATTEMPTS})`);

  wsReconnectTimeout = setTimeout(() => {
    connectWebSocket();
  }, wsReconnectDelay);

  // Exponential backoff
  wsReconnectDelay = Math.min(wsReconnectDelay * 2, WS_RECONNECT_DELAY_MAX);
}

function disconnectWebSocket(): void {
  if (wsReconnectTimeout) {
    clearTimeout(wsReconnectTimeout);
    wsReconnectTimeout = null;
  }
  if (wsHeartbeatInterval) {
    clearInterval(wsHeartbeatInterval);
    wsHeartbeatInterval = null;
  }

  if (wsConnection) {
    wsConnection.close();
    wsConnection = null;
  }

  isWsConnected = false;
}

// ============================================================================
// SYNC SERVICE LIFECYCLE
// ============================================================================

let syncInterval: NodeJS.Timeout | null = null;
let integrityInterval: NodeJS.Timeout | null = null;
let recoveryInterval: NodeJS.Timeout | null = null;
let gapSweepInterval: NodeJS.Timeout | null = null;
let isSyncing = false;

let initialSyncDone = false;

export function startSyncService(): void {
  console.log('[Sync] Starting sync service (WebSocket primary, polling fallback)...');

  // Start WebSocket for realtime sync (new blocks)
  console.log('[Sync] Starting WebSocket connection...');
  connectWebSocket();
  
  // Initial sync: catch up with ALL missing blocks from the very beginning
  // CRITICAL: This reads last_height BEFORE WS open handler can change it
  console.log('[Sync] Running initial sync to catch up with missing blocks...');
  runInitialSync()
    .then(() => { initialSyncDone = true; })
    .catch(err => { console.error('[Sync] Initial sync/recovery FAILED:', err); initialSyncDone = true; });

  // Fallback polling (runs if WebSocket is disconnected)
  syncInterval = setInterval(() => {
    // Only poll if WebSocket is not connected
    if (isWsConnected) {
      return;
    }

    if (isSyncing) {
      return;
    }
    
    isSyncing = true;
    log('[Sync] Fallback polling (WS disconnected)...');
    
    syncBlocksPolling()
      .then(({ added }) => {
        if (added > 0) {
          log(`[Sync] Polling: +${added} transactions`);
        }
      })
      .catch(err => {
        error('[Sync] Polling failed:', err);
      })
      .finally(() => {
        isSyncing = false;
      });
  }, SYNC_INTERVAL);

  // Periodic integrity check
  integrityInterval = setInterval(() => {
    verifyDataIntegrity().catch(err => {
      error('[Integrity] Error in integrity check:', err);
    });
  }, INTEGRITY_CHECK_INTERVAL);

  // v3.56: Periodic recovery — scan last 500 blocks every 5 minutes
  // Catches any blocks where fire-and-forget processSingleBlock failed
  // AND the retry mechanism gave up (e.g., node was temporarily unreachable)
  recoveryInterval = setInterval(() => {
    recoverMissingTransactions(500).catch(err => {
      error('[Recovery] Periodic recovery failed:', err);
    });
  }, RECOVERY_INTERVAL);

  // Gap sweeper: retries recorded holes until the blocks table is contiguous.
  gapSweepInterval = setInterval(() => {
    sweepGaps().catch(err => {
      error('[Gaps] Sweep error:', err);
    });
  }, 60000);

  console.log('[Sync] Sync service started (with periodic recovery every 5min)');
}

export async function stopSyncService(): Promise<void> {
  console.log('[Sync] Stopping sync service...');
  
  // Stop WebSocket
  disconnectWebSocket();
  
  // v3.52: Stop retry timer
  if (retryTimer) {
    clearInterval(retryTimer);
    retryTimer = null;
  }
  failedTxBlocks.clear();
  
  // Stop intervals
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
  if (integrityInterval) {
    clearInterval(integrityInterval);
    integrityInterval = null;
  }
  if (recoveryInterval) {
    clearInterval(recoveryInterval);
    recoveryInterval = null;
  }
  if (gapSweepInterval) {
    clearInterval(gapSweepInterval);
    gapSweepInterval = null;
  }

  // Wait for current sync to finish
  if (isSyncing) {
    log('[Sync] Waiting for current sync to finish...');
    const startWait = Date.now();
    const maxWait = 30000;
    
    while (isSyncing && (Date.now() - startWait) < maxWait) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    if (isSyncing) {
      warn('[Sync] Sync did not finish in time, forcing stop');
      isSyncing = false;
    }
  }
  
  // Wait for integrity check to finish
  if (isVerifying) {
    log('[Sync] Waiting for integrity check to finish...');
    const startWait = Date.now();
    const maxWait = 60000;
    
    while (isVerifying && (Date.now() - startWait) < maxWait) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    if (isVerifying) {
      warn('[Sync] Integrity check did not finish in time, forcing stop');
      isVerifying = false;
    }
  }
  
  console.log('[Sync] Sync service stopped');
}


export async function getSyncServiceStatus(): Promise<{
  isRunning: boolean;
  isSyncing: boolean;
  isVerifying: boolean;
  isWsConnected: boolean;
  lastHeight: number;
  lastSyncAt: string | null;
  lastError: string | null;
}> {
  try {
    const state = await getSyncState();
    return {
      isRunning: syncInterval !== null || isWsConnected,
      isSyncing,
      isVerifying,
      isWsConnected,
      lastHeight: state?.last_height || 0,
      lastSyncAt: state?.last_sync_at ? new Date(state.last_sync_at).toISOString() : null,
      lastError: null,
    };
  } catch (err) {
    error('[Sync] Error getting sync service status:', err);
    return {
      isRunning: syncInterval !== null || isWsConnected,
      isSyncing: false,
      isVerifying: false,
      isWsConnected: false,
      lastHeight: 0,
      lastSyncAt: null,
      lastError: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}
