import { getDbPool, insertTransactionsBatch, updateSyncState, getSyncState, query, insertBlock } from './db';
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
  const url = process.env.QNET_API_URL || 'http://162.244.25.114:8001';
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
      return 'http://162.244.25.114:8001';
    }
    return url;
  } catch {
    error('[Sync] Invalid NODE_RPC_URL format, using default');
    return 'http://162.244.25.114:8001';
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

  // Use tx.timestamp (client-set) for display — closer to "when user sent it"
  // Fallback to blockTimestamp if tx.timestamp is missing
  let rawTs = Number(tx.timestamp) || blockTimestamp || 0;
  if (!Number.isFinite(rawTs) || rawTs < 0) {
    warn('[Sync] Invalid timestamp, fallback to 0:', rawTs);
    rawTs = 0;
  }
  const timestamp = rawTs > 1e12 ? rawTs : rawTs * 1000;

  const amount = Number(tx.amount) || 0;
  const nonce = Number(tx.nonce) || 0;

  const isQuantumSigned = !!(tx.is_quantum_signed || 
    (tx.dilithium_signature && tx.dilithium_public_key));

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

  // Skip genesis benchmark transactions
  if (blockHeight === 0 && from === 'genesis' && to && to.startsWith('EON1be')) {
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
    dilithium_signature: tx.dilithium_signature ? String(tx.dilithium_signature) : null,
    dilithium_public_key: tx.dilithium_public_key ? String(tx.dilithium_public_key) : null,
    tx_type: mapTxType((tx.tx_type || tx.type) as string | object | undefined),
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
      signature_type: (block.signature_type as string) || 'Dilithium3',
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
          tx_type_data: typeof tx.tx_type === 'object' ? (tx.tx_type as Record<string, unknown>) : null,
          data: tx.data,
          status: tx.status,
          is_quantum_signed: tx.is_quantum_signed
        })));
        insertedOk = true;
      } catch (err) {
        error(`[Sync] Failed to insert batch for block ${height}:`, err);
        // Return 0 so retry mechanism picks this up
        return 0;
      }
    }
  }

  // Update sync state
  await updateSyncState(height);

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

    // Check for blockchain reset
    if (currentHeight < lastHeight) {
      log(`[Sync] Blockchain reset detected! ${currentHeight} < ${lastHeight}`);
      await updateSyncState(0);
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
    const lastHeight = typeof syncState?.last_height === 'number' 
      ? syncState.last_height 
      : Number(syncState?.last_height) || -1;
    
    const gap = networkHeight - lastHeight - 1;
    if (gap <= 0) {
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
  const effectiveLimit = Math.min(limit, 20);
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

// Background scan: PARALLEL HTTP RPC - 5 streams × 20 blocks = 100 blocks/round
async function runBackfillScan(fromHeight: number, toHeight: number): Promise<void> {
  if (isBackfillRunning) {
    console.log('[Sync] Backfill: already running');
    return;
  }
  isBackfillRunning = true;
  
  const BATCH_SIZE = 20;
  const PARALLEL = 10; // 10 parallel HTTP connections
  const ROUND_SIZE = BATCH_SIZE * PARALLEL; // 200 blocks per round
  const startTime = Date.now();
  let scanned = 0;
  let txBlocksSaved = 0;
  let totalTxSaved = 0;
  let currentHeight = fromHeight;
  
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
      let roundScanned = 0;
      
      for (const { startH, blocks } of results) {
        if (blocks.length > 0) {
          for (let i = 0; i < blocks.length; i++) {
            const block = blocks[i] as BlockData;
            const height = startH + i;
            const txCount = Array.isArray(block.transactions) ? block.transactions.length : 0;
            if (txCount > 0) {
              txBlocks.push({ height, block });
              console.log(`[Backfill] Block ${height}: ${txCount} TX`);
            }
          }
          roundScanned += blocks.length;
        } else {
          roundScanned += BATCH_SIZE;
        }
      }
      
      // Save TX blocks
      if (txBlocks.length > 0) {
        const saved = await saveBlocksBatch(txBlocks);
        txBlocksSaved += txBlocks.length;
        totalTxSaved += saved;
      }
      
      scanned += roundScanned;
      currentHeight += roundScanned;
      
      // Progress log every 500 blocks
      if (scanned % 500 < ROUND_SIZE) {
        const total = toHeight - fromHeight + 1;
        const pct = ((scanned / total) * 100).toFixed(1);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const speed = scanned > 0 ? (scanned / ((Date.now() - startTime) / 1000)).toFixed(1) : '0';
        console.log(`[Backfill] ${pct}% (${scanned}/${total}) ${speed} blk/s | ${txBlocksSaved} TX-blocks, ${totalTxSaved} TX | ${elapsed}s`);
      }
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

// FAST BATCH: Save multiple blocks to DB in one batch
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
        signature_type: (block.signature_type as string) || 'Dilithium3',
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
          tx_type_data: typeof tx.tx_type === 'object' ? (tx.tx_type as Record<string, unknown>) : null,
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

  // After catchup, recover any TXs that were lost due to previous validation bugs
  await recoverMissingTransactions();
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

        const restored = transformTransaction(
          nodeTx as Record<string, unknown>,
          ((nodeTx.block_height as number) || (nodeTx.block as number) || 0) as number,
          ((nodeTx.timestamp as number) || 0) as number
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
            tx_type_data: typeof restored.tx_type === 'object' ? (restored.tx_type as Record<string, unknown>) : null,
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
        signature_type: 'Dilithium3',
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
      wsReconnectDelay = WS_RECONNECT_DELAY_BASE; // Reset delay on successful connect
      
      // CRITICAL: Catchup sync on reconnect - sync any blocks missed during disconnect
      console.log('[WS] Running catchup sync for missed blocks...');
      try {
        await runCatchupSync();
      } catch (err) {
        console.error('[WS] Catchup sync failed:', err);
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

  console.log(`[WS] Reconnecting in ${wsReconnectDelay / 1000}s...`);
  
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
let isSyncing = false;

export function startSyncService(): void {
  console.log('[Sync] Starting sync service (WebSocket primary, polling fallback)...');

  // Start WebSocket IMMEDIATELY for realtime sync
  console.log('[Sync] Starting WebSocket connection...');
  connectWebSocket();
  
  // Initial sync: catch up with missing blocks (runs once at startup)
  console.log('[Sync] Running initial sync to catch up with missing blocks...');
  runInitialSync().catch(err => console.error('[Sync] Initial sync/recovery FAILED:', err));

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
