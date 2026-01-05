import { getDbPool, insertTransactionsBatch, updateSyncState, getSyncState, query } from './db';
import { verifyTransactionHash, verifyTransactionIntegrity, logSecurityEvent } from './security';

// Validate and sanitize NODE_RPC_URL to prevent SSRF
function getNodeRpcUrl(): string {
  const url = process.env.QNET_API_URL || 'http://161.97.86.81:8001';
  try {
    const parsed = new URL(url);
    // Only allow http/https
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Invalid protocol');
    }
    // Block private/internal IPs (SSRF protection)
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
      console.error('[Sync] NODE_RPC_URL points to private IP, using default');
      return 'http://161.97.86.81:8001';
    }
    return url;
  } catch {
    console.error('[Sync] Invalid NODE_RPC_URL format, using default');
    return 'http://161.97.86.81:8001';
  }
}

const NODE_RPC_URL = getNodeRpcUrl();
const SYNC_INTERVAL = 10000; // 10 seconds
const INTEGRITY_CHECK_INTERVAL = 600000; // 10 minutes

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
  // Validate hash - allow alphanumeric and underscores (system transactions may have non-hex hashes)
  const hash = String(tx.hash || '');
  if (!hash || hash.length < 8 || hash.length > 128) {
    console.warn('[Sync] Invalid transaction hash length, skipping:', hash.substring(0, 32));
    return null;
  }

  // Validate block height
  if (!Number.isInteger(blockHeight) || blockHeight < 0) {
    console.warn('[Sync] Invalid block height:', blockHeight);
    return null;
  }

  // Get timestamp with validation
  let rawTs = Number(tx.timestamp) || 0;
  if (rawTs === 0) rawTs = blockTimestamp;
  if (!Number.isFinite(rawTs) || rawTs < 0) {
    console.warn('[Sync] Invalid timestamp, using block timestamp:', rawTs);
    rawTs = blockTimestamp;
  }
  const timestamp = rawTs > 1e12 ? rawTs : rawTs * 1000;

  // Validate amount
  const amount = Number(tx.amount) || 0;
  if (!Number.isFinite(amount) || amount < 0) {
    console.warn('[Sync] Invalid amount, using 0:', amount);
  }

  // Validate nonce
  const nonce = Number(tx.nonce) || 0;
  if (!Number.isInteger(nonce) || nonce < 0) {
    console.warn('[Sync] Invalid nonce, using 0:', nonce);
  }

  // Determine quantum signature
  const isQuantumSigned = !!(tx.is_quantum_signed || 
    (tx.dilithium_signature && tx.dilithium_public_key));

  // Validate addresses - filter out entries without proper from address (likely system/meta data)
  // Real transactions must have a 'from' or 'from_address' field
  // Allow system addresses like 'system_emission' for reward transactions
  const fromRaw = tx.from || tx.from_address;
  if (!fromRaw || (typeof fromRaw === 'string' && fromRaw.length === 0)) {
    // Skip entries without from address - these are likely system metadata, not real transactions
    // This filters out garbage entries that are not actual transactions
    return null;
  }
  const from = String(fromRaw);
  if (from.length > 128) {
    console.warn('[Sync] Invalid from address length:', from.length);
    return null;
  }
  
  // Allow system addresses for reward/emission transactions
  const isSystemAddress = from.startsWith('system_') || from === 'system_emission' || from === 'system_rewards_pool';
  const txType = String(tx.tx_type || tx.type || '').toLowerCase();
  const isRewardTx = txType.includes('reward') || txType.includes('emission');
  
  // For reward transactions, allow system addresses; for others, require valid address format
  if (!isSystemAddress && !isRewardTx && !/^[a-f0-9]{40,}$/i.test(from)) {
    // Not a system address and not a reward transaction - validate it's a proper hex address
    // But don't filter it out - just log a warning
    console.warn(`[Sync] Non-standard from address: ${from.substring(0, 32)} (tx_type: ${txType})`);
  }

  const to = tx.to ? String(tx.to) : (tx.to_address ? String(tx.to_address) : null);
  if (to && to.length > 128) {
    console.warn('[Sync] Invalid to address length:', to.length);
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
  transactions?: unknown[];
  timestamp?: number | string;
  [key: string]: unknown;
}

// Fetch block from node with validation
async function fetchBlock(height: number): Promise<{ block: BlockData; height: number } | null> {
  try {
    const res = await fetch(`${NODE_RPC_URL}/api/v1/block/${height}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return null;

    // Check response size before parsing (limit to 50MB)
    const contentLength = res.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > 50 * 1024 * 1024) {
      console.warn(`[Sync] Block ${height} response too large: ${contentLength} bytes`);
      return null;
    }

    // Parse with size limit
    const text = await res.text();
    if (text.length > 50 * 1024 * 1024) {
      console.warn(`[Sync] Block ${height} response too large: ${text.length} bytes`);
      return null;
    }

    let responseData: any;
    try {
      responseData = JSON.parse(text);
    } catch (parseErr) {
      console.warn(`[Sync] Failed to parse block ${height} JSON:`, parseErr);
      return null;
    }
    
    // Handle different response structures:
    // 1. { block: { transactions: [...] } } - nested structure
    // 2. { transactions: [...] } - flat structure (block 0)
    let block: BlockData;
    if (responseData.block) {
      block = responseData.block as BlockData;
      console.log(`[Sync] Block ${height} using nested structure, transactions: ${Array.isArray(block.transactions) ? block.transactions.length : 0}`);
    } else if (responseData.transactions) {
      // Flat structure with transactions at top level
      block = {
        transactions: responseData.transactions,
        timestamp: responseData.timestamp,
      } as BlockData;
      console.log(`[Sync] Block ${height} using flat structure, transactions: ${Array.isArray(block.transactions) ? block.transactions.length : 0}`);
    } else {
      // Fallback - use responseData as block
      block = responseData as BlockData;
      console.warn(`[Sync] Block ${height} no transactions found, using responseData as block`);
    }
    
    // Validate block structure
    if (!block || typeof block !== 'object') {
      console.warn(`[Sync] Invalid block structure for height ${height}`);
      return null;
    }
    
    // Handle transactions array - check both 'transactions' and 'txs' fields
    if (!block.transactions && (block as any).txs) {
      block.transactions = (block as any).txs;
    }
    
    // Validate transactions array
    if (block.transactions && !Array.isArray(block.transactions)) {
      console.warn(`[Sync] Invalid transactions array for block ${height}`);
      block.transactions = [];
    }
    
    // Limit transactions per block to prevent memory issues (100k max as per requirement)
    const MAX_TXS_PER_BLOCK = 100000;
    if (Array.isArray(block.transactions) && block.transactions.length > MAX_TXS_PER_BLOCK) {
      console.warn(`[Sync] Block ${height} has ${block.transactions.length} transactions, limiting to ${MAX_TXS_PER_BLOCK}`);
      block.transactions = block.transactions.slice(0, MAX_TXS_PER_BLOCK);
    }
    
    // Log transaction count for debugging
    if (Array.isArray(block.transactions) && block.transactions.length > 0) {
      console.log(`[Sync] Block ${height} has ${block.transactions.length} transactions`);
    }
    
    // Validate timestamp
    if (block.timestamp && (!Number.isFinite(Number(block.timestamp)) || Number(block.timestamp) < 0)) {
      console.warn(`[Sync] Invalid timestamp for block ${height}, using 0`);
      block.timestamp = 0;
    }
    
    return { block, height };
  } catch (err) {
    console.error(`[Sync] Failed to fetch block ${height}:`, err);
    return null;
  }
}

// Sync new blocks
async function syncBlocks(): Promise<{ added: number; currentHeight: number }> {
  try {
    // Get current height from node
    const heightRes = await fetch(`${NODE_RPC_URL}/api/v1/height`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });

    if (!heightRes.ok) {
      console.log('[Sync] Failed to get height from node');
      return { added: 0, currentHeight: 0 };
    }

    // Validate response size before parsing
    const heightText = await heightRes.text();
    if (heightText.length > 1024) {
      console.warn('[Sync] Height response too large:', heightText.length);
      return { added: 0, currentHeight: 0 };
    }
    
    let heightData: { height?: number };
    try {
      heightData = JSON.parse(heightText) as { height?: number };
    } catch (parseErr) {
      console.warn('[Sync] Failed to parse height JSON:', parseErr);
      return { added: 0, currentHeight: 0 };
    }
    
    const currentHeight = heightData.height;
    if (!currentHeight || !Number.isInteger(currentHeight) || currentHeight < 0) {
      return { added: 0, currentHeight: 0 };
    }

    // Get last synced height (ensure it's a number)
    const syncState = await getSyncState();
    const lastHeight = typeof syncState?.last_height === 'number' ? syncState.last_height : Number(syncState?.last_height) || 0;

    // Check for blockchain reset
    if (currentHeight < lastHeight) {
      console.log(`[Sync] Blockchain reset detected! ${currentHeight} < ${lastHeight}`);
      await updateSyncState(0);
      return { added: 0, currentHeight };
    }

    // Fetch new blocks (limit to 100 per sync to avoid timeout)
    const blocksToFetch: number[] = [];
    // Start from block 0 if lastHeight is -1 or 0, otherwise re-fetch last 10 for reorgs
    const startBlock = lastHeight < 0 ? 0 : Math.max(0, lastHeight - 10);

    // If lastHeight is -1, start from 0. Otherwise start from lastHeight + 1
    const firstBlock = lastHeight < 0 ? 0 : Math.max(startBlock, lastHeight + 1);
    
    // Debug: verify calculations
    console.log(`[Sync] Height calc: lastHeight=${lastHeight} (${typeof lastHeight}), startBlock=${startBlock}, firstBlock=${firstBlock}, currentHeight=${currentHeight}`);
    
    for (let h = firstBlock; h <= currentHeight && blocksToFetch.length < 100; h++) {
      blocksToFetch.push(h);
    }
    
    if (blocksToFetch.length > 0) {
      console.log(`[Sync] Will fetch ${blocksToFetch.length} blocks: ${blocksToFetch[0]} to ${blocksToFetch[blocksToFetch.length - 1]}`);
    } else {
      console.log(`[Sync] No blocks to fetch (firstBlock: ${firstBlock}, currentHeight: ${currentHeight})`);
    }

    if (blocksToFetch.length === 0) {
      return { added: 0, currentHeight };
    }

    console.log(`[Sync] Fetching blocks ${blocksToFetch[0]}-${blocksToFetch[blocksToFetch.length - 1]} (${blocksToFetch.length} blocks)`);

    // Limit parallel fetches to prevent DoS (max 50 concurrent for production)
    const MAX_PARALLEL_FETCHES = 50;
    // IMPORTANT: Only process blocks we actually fetch!
    const blocksToProcess = blocksToFetch.slice(0, MAX_PARALLEL_FETCHES);
    const fetchPromises = blocksToProcess.map(height => fetchBlock(height));
    
    if (blocksToFetch.length > MAX_PARALLEL_FETCHES) {
      console.log(`[Sync] Processing ${MAX_PARALLEL_FETCHES} blocks this round, ${blocksToFetch.length - MAX_PARALLEL_FETCHES} blocks will be fetched in next cycle`);
    }
    
    // Add timeout wrapper to prevent hanging (increased timeout for large blocks)
    const timeoutMs = 120000; // 120 seconds for blocks with up to 100k transactions
    const timeoutPromise = Promise.race([
      Promise.allSettled(fetchPromises),
      new Promise<PromiseSettledResult<{ block: BlockData; height: number } | null>[]>((_, reject) => {
        setTimeout(() => reject(new Error('Sync timeout')), timeoutMs);
      })
    ]);
    
    const results = await timeoutPromise.catch(() => {
      console.error('[Sync] Sync operation timed out');
      return fetchPromises.map(() => ({ status: 'rejected' as const, reason: new Error('Timeout') }));
    });

    // Process transactions with memory protection
    const transactionsToInsert: TransactionFromNode[] = [];
    let maxHeight = lastHeight;
    const MAX_TOTAL_TXS_PER_SYNC = 50000; // Limit total transactions per sync to prevent memory issues

    for (const result of results) {
      if (result.status !== 'fulfilled' || !result.value) continue;

      const { block, height } = result.value;
      const txs = Array.isArray(block.transactions) ? block.transactions : [];
      const blockTs = Number(block.timestamp) || 0;

      // Check if we're approaching memory limit
      if (transactionsToInsert.length + txs.length > MAX_TOTAL_TXS_PER_SYNC) {
        console.warn(`[Sync] Approaching memory limit, processing ${txs.length} transactions from block ${height} would exceed limit`);
        // Process only what fits
        const remaining = MAX_TOTAL_TXS_PER_SYNC - transactionsToInsert.length;
        const txsToProcess = txs.slice(0, remaining);
        
        for (const tx of txsToProcess as Record<string, unknown>[]) {
          const transformed = transformTransaction(tx, height, blockTs);
          if (transformed) {
            transactionsToInsert.push(transformed);
          }
        }
        
        console.warn(`[Sync] Processed ${remaining} transactions from block ${height}, skipped ${txs.length - remaining}`);
        break; // Stop processing more blocks
      }

      let transformedCount = 0;
      let skippedCount = 0;
      for (const tx of txs as Record<string, unknown>[]) {
        const transformed = transformTransaction(tx, height, blockTs);
        if (transformed) {
          transactionsToInsert.push(transformed);
          transformedCount++;
        } else {
          skippedCount++;
        }
      }

      if (txs.length > 0) {
        console.log(`[Sync] Block ${height}: ${txs.length} total, ${transformedCount} transformed, ${skippedCount} skipped`);
        if (transformedCount === 0 && txs.length > 0) {
          console.warn(`[Sync] Block ${height} has ${txs.length} transactions but none were transformed successfully`);
          // Log first failed transaction for debugging
          if (txs.length > 0) {
            const firstTx = txs[0] as Record<string, unknown>;
            console.warn(`[Sync] First TX sample: hash=${String(firstTx.hash || '').substring(0, 32)}, type=${firstTx.tx_type || firstTx.type || 'unknown'}`);
          }
        }
      }

      maxHeight = Math.max(maxHeight, height);
    }

    console.log(`[Sync] Processed ${results.length} blocks, extracted ${transactionsToInsert.length} transactions`);

    // Deduplicate transactions by hash (filter out duplicates from genesis block)
    const seenHashes = new Set<string>();
    const uniqueTransactions: TransactionFromNode[] = [];
    let duplicateCount = 0;
    for (const tx of transactionsToInsert) {
      if (seenHashes.has(tx.hash)) {
        duplicateCount++;
        continue;
      }
      seenHashes.add(tx.hash);
      uniqueTransactions.push(tx);
    }
    if (duplicateCount > 0) {
      console.log(`[Sync] Filtered out ${duplicateCount} duplicate transactions`);
    }

    // Batch insert transactions (limit batch size to prevent memory issues)
    const MAX_BATCH_SIZE = 1000;
    if (uniqueTransactions.length > 0) {
      // Split into smaller batches if needed
      const batches: TransactionFromNode[][] = [];
      for (let i = 0; i < uniqueTransactions.length; i += MAX_BATCH_SIZE) {
        batches.push(uniqueTransactions.slice(i, i + MAX_BATCH_SIZE));
      }
      
      for (const batch of batches) {
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
        tx_type_data: typeof tx.tx_type === 'object' ? (() => {
          try {
            // Validate and limit object size
            const obj = tx.tx_type as Record<string, unknown>;
            const json = JSON.stringify(obj);
            if (json.length > 100000) { // 100KB max
              console.warn('[Sync] tx_type_data too large, truncating');
              return JSON.parse(json.substring(0, 100000)) as Record<string, unknown>;
            }
            return obj;
          } catch {
            return null;
          }
        })() : null,
        data: tx.data,
        status: tx.status,
          is_quantum_signed: tx.is_quantum_signed
        })));
      }

      console.log(`[Sync] Inserted ${uniqueTransactions.length} transactions in ${batches.length} batch(es)`);
    }

    // Update sync state - use the highest block we actually processed
    // CRITICAL: Use only blocks we actually fetched, not all blocksToFetch!
    const highestFetchedBlock = blocksToProcess.length > 0 ? Math.max(...blocksToProcess) : lastHeight;
    const finalHeight = Math.max(maxHeight, highestFetchedBlock);
    
    if (finalHeight > lastHeight) {
      await updateSyncState(finalHeight);
      console.log(`[Sync] Updated sync state: ${lastHeight} -> ${finalHeight}`);
    } else {
      console.log(`[Sync] No height update needed (finalHeight: ${finalHeight}, lastHeight: ${lastHeight})`);
    }

    return { added: transactionsToInsert.length, currentHeight: finalHeight };
  } catch (err) {
    console.error('[Sync] Error:', err);
    return { added: 0, currentHeight: 0 };
  }
}

// Verify data integrity by comparing random transactions with node
let isVerifying = false; // Lock to prevent concurrent integrity checks

async function verifyDataIntegrity(): Promise<void> {
  if (isVerifying) {
    console.log('[Integrity] Integrity check already in progress, skipping...');
    return;
  }
  
  isVerifying = true;
  
  try {
    console.log('[Integrity] Starting integrity check...');

    // Limit integrity check to prevent DoS (max 50 transactions per check)
    const MAX_INTEGRITY_CHECK = 50;
    const result = await query<{ hash: string }>(
      `SELECT hash FROM transactions ORDER BY RANDOM() LIMIT ${MAX_INTEGRITY_CHECK}`
    );

    let mismatches = 0;

    for (const row of result.rows) {
      const hash = row.hash;
      
      // Get from DB
      const dbTxResult = await query(
        'SELECT * FROM transactions WHERE hash = $1',
        [hash]
      );

      if (dbTxResult.rows.length === 0) continue;
      
      const dbTx = dbTxResult.rows[0];

      // Get from node (source of truth)
      const nodeRes = await fetch(`${NODE_RPC_URL}/api/v1/transaction/${hash}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(3000),
      });

      if (!nodeRes.ok) continue;

      // Validate response size
      const responseText = await nodeRes.text();
      if (responseText.length > 10 * 1024 * 1024) {
        console.warn(`[Integrity] Transaction ${hash} response too large: ${responseText.length} bytes`);
        continue;
      }
      
      let nodeData: { transaction?: Record<string, unknown> };
      try {
        nodeData = JSON.parse(responseText) as { transaction?: Record<string, unknown> };
      } catch (parseErr) {
        console.warn(`[Integrity] Failed to parse transaction ${hash} JSON:`, parseErr);
        continue;
      }
      
      if (!nodeData.transaction) continue;

      const nodeTx = nodeData.transaction as Record<string, unknown>;

      // Verify integrity
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

        // Restore from node
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

          console.log(`[Integrity] Restored transaction ${hash} from node`);
        }
      }
    }

    if (mismatches > 0) {
      logSecurityEvent('integrity_check_failed', {
        checked: result.rows.length,
        mismatches
      });
    } else {
      console.log(`[Integrity] ✅ All ${result.rows.length} transactions verified`);
    }
  } catch (err) {
    console.error('[Integrity] Error:', err);
  } finally {
    isVerifying = false;
  }
}

// Start sync service
let syncInterval: NodeJS.Timeout | null = null;
let integrityInterval: NodeJS.Timeout | null = null;
let isSyncing = false; // Lock to prevent concurrent syncs

export function startSyncService(): void {
  console.log('[Sync] Starting sync service...');
  console.log('[Sync] NODE_RPC_URL:', NODE_RPC_URL);
  console.log('[Sync] SYNC_INTERVAL:', SYNC_INTERVAL);

  // Initial sync
  console.log('[Sync] Starting initial sync...');
  syncBlocks()
    .then(({ added, currentHeight }) => {
      console.log(`[Sync] Initial sync complete, added ${added} transactions, current height: ${currentHeight}`);
    })
    .catch(err => {
      console.error('[Sync] Initial sync failed:', err);
      if (err instanceof Error) {
        console.error('[Sync] Error message:', err.message);
        console.error('[Sync] Error stack:', err.stack);
      }
    });

  // Periodic sync with lock
  syncInterval = setInterval(() => {
    if (isSyncing) {
      console.log('[Sync] Sync already in progress, skipping...');
      return;
    }
    
    isSyncing = true;
    syncBlocks()
      .then(({ added }) => {
        if (added > 0) {
          console.log(`[Sync] Synced ${added} new transactions`);
        }
      })
      .catch(err => {
        console.error('[Sync] Error in periodic sync:', err);
      })
      .finally(() => {
        isSyncing = false;
      });
  }, SYNC_INTERVAL);

  // Periodic integrity check
  integrityInterval = setInterval(() => {
    verifyDataIntegrity().catch(err => {
      console.error('[Integrity] Error in integrity check:', err);
    });
  }, INTEGRITY_CHECK_INTERVAL);

  console.log('[Sync] Sync service started');
}

export async function stopSyncService(): Promise<void> {
  console.log('[Sync] Stopping sync service...');
  
  // Stop intervals
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
  if (integrityInterval) {
    clearInterval(integrityInterval);
    integrityInterval = null;
  }
  
  // Wait for current sync to finish (with timeout)
  if (isSyncing) {
    console.log('[Sync] Waiting for current sync to finish...');
    const startWait = Date.now();
    const maxWait = 30000; // 30 seconds
    
    while (isSyncing && (Date.now() - startWait) < maxWait) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    if (isSyncing) {
      console.warn('[Sync] Sync did not finish in time, forcing stop');
      isSyncing = false;
    }
  }
  
  // Wait for integrity check to finish
  if (isVerifying) {
    console.log('[Sync] Waiting for integrity check to finish...');
    const startWait = Date.now();
    const maxWait = 60000; // 60 seconds
    
    while (isVerifying && (Date.now() - startWait) < maxWait) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    if (isVerifying) {
      console.warn('[Sync] Integrity check did not finish in time, forcing stop');
      isVerifying = false;
    }
  }
  
  console.log('[Sync] Sync service stopped');
}

export async function getSyncServiceStatus(): Promise<{
  isRunning: boolean;
  isSyncing: boolean;
  isVerifying: boolean;
  lastHeight: number;
  lastSyncAt: string | null;
  lastError: string | null;
}> {
  try {
    const state = await getSyncState();
    return {
      isRunning: syncInterval !== null,
      isSyncing,
      isVerifying,
      lastHeight: state?.last_height || 0,
      lastSyncAt: state?.last_sync_at ? new Date(state.last_sync_at).toISOString() : null,
      lastError: null, // Could be enhanced to track last error
    };
  } catch (err) {
    console.error('[Sync] Error getting sync service status:', err);
    return {
      isRunning: syncInterval !== null,
      isSyncing: false,
      isVerifying: false,
      lastHeight: 0,
      lastSyncAt: null,
      lastError: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

