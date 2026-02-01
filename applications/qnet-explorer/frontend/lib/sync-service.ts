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

// Get WebSocket URL from HTTP URL
function getNodeWsUrl(): string {
  const httpUrl = getNodeRpcUrl();
  const wsUrl = httpUrl.replace('http://', 'ws://').replace('https://', 'wss://');
  return `${wsUrl}/ws/subscribe?channels=blocks`;
}

const NODE_RPC_URL = getNodeRpcUrl();
const NODE_WS_URL = getNodeWsUrl();
const SYNC_INTERVAL = 30000; // Fallback polling: 30 seconds (less aggressive)
const INTEGRITY_CHECK_INTERVAL = 600000; // 10 minutes
const WS_RECONNECT_DELAY_BASE = 1000; // Initial reconnect delay: 1 second
const WS_RECONNECT_DELAY_MAX = 60000; // Max reconnect delay: 60 seconds

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
  if (typeof type === 'string') return type;
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
    warn('[Sync] Invalid transaction hash length, skipping:', hash.substring(0, 32));
    return null;
  }

  if (!Number.isInteger(blockHeight) || blockHeight < 0) {
    warn('[Sync] Invalid block height:', blockHeight);
    return null;
  }

  let rawTs = Number(tx.timestamp) || 0;
  if (rawTs === 0) rawTs = blockTimestamp;
  if (!Number.isFinite(rawTs) || rawTs < 0) {
    warn('[Sync] Invalid timestamp, using block timestamp:', rawTs);
    rawTs = blockTimestamp;
  }
  const timestamp = rawTs > 1e12 ? rawTs : rawTs * 1000;

  const amount = Number(tx.amount) || 0;
  const nonce = Number(tx.nonce) || 0;

  const isQuantumSigned = !!(tx.is_quantum_signed || 
    (tx.dilithium_signature && tx.dilithium_public_key));

  const fromRaw = tx.from || tx.from_address;
  if (!fromRaw || (typeof fromRaw === 'string' && fromRaw.length === 0)) {
    return null;
  }
  const from = String(fromRaw);
  if (from.length > 128) {
    warn('[Sync] Invalid from address length:', from.length);
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

// Fetch single block from node
async function fetchBlock(height: number): Promise<{ block: BlockData; height: number } | null> {
  try {
    const res = await fetch(`${NODE_RPC_URL}/api/v1/block/${height}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(30000), // 30 seconds timeout
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
      } catch (err) {
        error(`[Sync] Failed to insert batch:`, err);
      }
    }
  }

  // Update sync state
  await updateSyncState(height);

  return uniqueTransactions.length;
}

// Sync blocks using polling (fallback mode - ONLY when WebSocket is down)
async function syncBlocksPolling(): Promise<{ added: number; currentHeight: number }> {
  try {
    const heightRes = await fetch(`${NODE_RPC_URL}/api/v1/height`, {
      cache: 'no-store',
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
// ============================================================================

let wsConnection: WebSocket | null = null;
let wsReconnectDelay = WS_RECONNECT_DELAY_BASE;
let wsReconnectTimeout: NodeJS.Timeout | null = null;
let isWsConnected = false;

function connectWebSocket(): void {
  if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
    return;
  }

  console.log(`[WS] Connecting to ${NODE_WS_URL}...`);

  try {
    wsConnection = new WebSocket(NODE_WS_URL);

    wsConnection.on('open', () => {
      console.log('[WS] Connected to node (realtime sync enabled)');
      isWsConnected = true;
      wsReconnectDelay = WS_RECONNECT_DELAY_BASE; // Reset delay on successful connect
    });

    wsConnection.on('message', async (data: WebSocket.Data) => {
      try {
        const message = JSON.parse(data.toString());
        
        if (message.type === 'NewBlock') {
          const event = message as WsNewBlockEvent;
          const height = event.data.height;
          
          log(`[WS] NewBlock received: height=${height}, txs=${event.data.tx_count}`);
          
          // Fetch and process the full block
          const added = await processSingleBlock(height);
          
          if (added > 0) {
            log(`[WS] Block ${height}: +${added} transactions`);
          }
        }
      } catch (err) {
        error('[WS] Error processing message:', err);
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
let isSyncing = false;

export function startSyncService(): void {
  console.log('[Sync] Starting sync service (WebSocket primary, polling fallback)...');

  // Start WebSocket IMMEDIATELY for realtime sync
  // NOTE: For initial sync from zero, use database snapshot (pg_dump/pg_restore)
  // WebSocket will catch up with any new blocks after snapshot
  console.log('[Sync] Starting WebSocket connection...');
  connectWebSocket();

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

  console.log('[Sync] Sync service started');
}

export async function stopSyncService(): Promise<void> {
  console.log('[Sync] Stopping sync service...');
  
  // Stop WebSocket
  disconnectWebSocket();
  
  // Stop intervals
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
  if (integrityInterval) {
    clearInterval(integrityInterval);
    integrityInterval = null;
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
