import { NextRequest, NextResponse } from 'next/server';

// ============================================================================
// PRODUCTION v2.81: Stable Explorer API with Server-side Caching
// - SERVER CACHE: Store fetched transactions to avoid re-fetching
// - Transactions are ACCUMULATED, never lost
// - Cache survives multiple requests within TTL
// ============================================================================

const NODE_RPC_URL = process.env.QNET_API_URL || 'http://161.97.86.81:8001';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// ============================================================================
// SERVER-SIDE TRANSACTION CACHE
// Transactions once fetched are stored and never removed
// This ensures stable display even if blockchain node has intermittent issues
// ============================================================================
interface CachedTx {
  hash: string;
  type: string;
  from: string;
  to: string;
  amount: string;
  block: number;
  time: string;
  timestamp: number;
}

// Global cache (persists across requests in the same Node.js process)
// v2.82: Force cache clear on code update
const serverTxCache = new Map<string, CachedTx>();
let serverCacheHeight = 0;
let lastFetchTime = 0;
const CACHE_TTL = 5000; // 5 seconds - minimum time between full refetches
const CACHE_VERSION = 'v2.82'; // Change this to force cache clear
console.log(`[API] Activity route loaded, cache version: ${CACHE_VERSION}`);

export interface ActivityItem {
  hash: string;
  type: 'Transfer' | 'Node Activation' | 'Swap' | 'Reward' | 'Smart Contract' | 'Block' | 'System' | 'Registration';
  from: string;
  to: string;
  amount: string;
  block: number | string;
  time: string;
  timestamp: number;
}

// Primary: Use indexed API (fast, O(1) lookups)
async function fetchFromIndexedAPI(page: number, perPage: number): Promise<{ items: ActivityItem[], total: number, currentHeight: number } | null> {
  try {
    const res = await fetch(`${NODE_RPC_URL}/api/v1/transactions/recent?page=${page}&per_page=${perPage}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000), // Fast timeout - indexed should be quick
    });
    
    if (!res.ok) return null;
    
    const data = await res.json();
    if (!data.success || !data.transactions) return null;
    
    const activity: ActivityItem[] = data.transactions.map((tx: Record<string, unknown>) => ({
      hash: String(tx.hash || ''),
      type: mapTxType(tx.tx_type || tx.type || 'Transfer'),
      from: String(tx.from || 'unknown'),
      to: String(tx.to || 'N/A'),
      amount: formatAmount(tx.amount),
      block: 'indexed',
      time: formatTimeAgo(Number(tx.timestamp) || 0),
      timestamp: Number(tx.timestamp) || 0,
    }));
    
    return {
      items: activity,
      total: data.pagination?.total_count || activity.length,
      currentHeight: data.current_height || 0,
    };
  } catch {
    return null;
  }
}

// Fallback: Fetch recent blocks + emission + Genesis (optimized)
// v2.80: FIXED - Always include ALL recent blocks to capture claim TX
async function fallbackFetch(page: number, perPage: number): Promise<{ items: ActivityItem[], total: number, currentHeight: number }> {
  const activity: ActivityItem[] = [];
  const seenHashes = new Set<string>();
  
  try {
    // Get current height (fast)
    const heightRes = await fetch(`${NODE_RPC_URL}/api/v1/height`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    });
    
    if (!heightRes.ok) return { items: [], total: 0, currentHeight: 0 };
    
    const { height: currentHeight } = await heightRes.json();
    if (!currentHeight) return { items: [], total: 0, currentHeight: 0 };
    
    // Important blocks with emission transactions
    const emissionBlocks = [14400, 28800, 43200, 57600, 72000].filter(h => h <= currentHeight);
    
    // Calculate blocks to fetch - ALWAYS include recent blocks!
    const blocksToFetch: Set<number> = new Set();
    
    if (page === 1) {
      // Page 1: Recent blocks FIRST (where claim TX lives), then emission, then Genesis
      // CRITICAL: Scan last 100 blocks to find any new transactions (claims, transfers)
      for (let h = currentHeight; h > Math.max(0, currentHeight - 100); h--) {
        blocksToFetch.add(h);
      }
      // Add emission blocks (they always have TX)
      emissionBlocks.forEach(h => blocksToFetch.add(h));
    } else {
      // Other pages: historical blocks (pagination)
      const skip = (page - 1) * 50;
      for (let h = currentHeight - skip; h > Math.max(0, currentHeight - skip - 50); h--) {
        blocksToFetch.add(h);
      }
    }
    
    // Convert to array and limit to reasonable number
    const blocksArray = Array.from(blocksToFetch).slice(0, 150);
    
    // Parallel fetch with Promise.allSettled (don't fail all if one fails)
    const results = await Promise.allSettled(
      blocksArray.map(async (height) => {
        const res = await fetch(`${NODE_RPC_URL}/api/v1/block/${height}`, {
          cache: 'no-store',
          signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) throw new Error(`Block ${height} not found`);
        const block = await res.json();
        return { height, block };
      })
    );
    
    // Process successful results - collect ALL transactions with data
    const blocksWithTx: { height: number; txs: unknown[] }[] = [];
    
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const { height, block } = result.value;
      const txs = block.transactions || [];
      
      // Only include blocks that have transactions
      if (txs.length > 0) {
        blocksWithTx.push({ height, txs });
      }
    }
    
    // Sort blocks by height descending (newest first)
    blocksWithTx.sort((a, b) => b.height - a.height);
    
    // Add transactions from blocks with TX
    for (const { height, txs } of blocksWithTx) {
      // Limit per block but show more for important blocks
      const isEmission = emissionBlocks.includes(height);
      const limit = isEmission ? 50 : 20;
      
      for (const tx of (txs as Record<string, unknown>[]).slice(0, limit)) {
        const hash = String(tx.hash || `tx_${height}_${activity.length}`);
        if (seenHashes.has(hash)) continue;
        seenHashes.add(hash);
        
        activity.push({
          hash,
          type: mapTxType(tx.tx_type || tx.type || 'Transfer'),
          from: String(tx.from || 'unknown'),
          to: String(tx.to || 'N/A'),
          amount: formatAmount(tx.amount),
          block: height,
          time: formatTimeAgo(Number(tx.timestamp) || 0),
          timestamp: Number(tx.timestamp) || 0,
        });
      }
    }
    
    // Load Genesis block (NodeRegistration) - separate request with longer timeout
    if (page === 1) {
      try {
        const genesisRes = await fetch(`${NODE_RPC_URL}/api/v1/block/0`, {
          cache: 'no-store',
          signal: AbortSignal.timeout(30000), // 30 sec timeout for large Genesis block
        });
        if (genesisRes.ok) {
          const genesis = await genesisRes.json();
          const allTx = genesis.transactions || [];
          // Take first SmartContract + last 10 NodeRegistration
          const importantTx = [...allTx.slice(0, 1), ...allTx.slice(-10)];
          
          for (const tx of importantTx as Record<string, unknown>[]) {
            const hash = String(tx.hash || `tx_0_${activity.length}`);
            if (seenHashes.has(hash)) continue;
            seenHashes.add(hash);
            
            activity.push({
              hash,
              type: mapTxType(tx.tx_type || tx.type || 'Transfer'),
              from: String(tx.from || 'unknown'),
              to: String(tx.to || 'N/A'),
              amount: formatAmount(tx.amount),
              block: 0,
              time: formatTimeAgo(Number(tx.timestamp) || Number(genesis.timestamp) || 0),
              timestamp: Number(tx.timestamp) || Number(genesis.timestamp) || 0,
            });
          }
        }
      } catch {
        // Genesis failed - continue without it (it's huge)
        console.log('[API] Genesis block skipped (timeout or error)');
      }
    }
    
    return { items: activity.slice(0, perPage), total: currentHeight, currentHeight };
  } catch (e) {
    console.error('[API] Fallback error:', e);
    return { items: [], total: 0, currentHeight: 0 };
  }
}

function mapTxType(type: unknown): ActivityItem['type'] {
  // Handle different formats:
  // 1. Object: { NodeRegistration: {...} } or { "NodeRegistration": null }
  // 2. Simple string: "NodeRegistration" 
  // 3. Rust Debug format: "NodeRegistration { node_id: \"...\", ... }"
  let typeStr = '';
  
  if (typeof type === 'object' && type !== null) {
    const keys = Object.keys(type as object);
    typeStr = keys[0] || '';
  } else if (typeof type === 'string') {
    typeStr = type;
    // Handle Rust Debug format: "TypeName { field: value, ... }"
    // Extract just the type name (first word before space or brace)
    const rustDebugMatch = typeStr.match(/^(\w+)\s*\{/);
    if (rustDebugMatch) {
      typeStr = rustDebugMatch[1];
    }
  } else {
    typeStr = '';
  }
  
  // Normalize: remove underscores, lowercase for comparison
  const normalized = typeStr.toLowerCase().replace(/_/g, '');
  
  // Map all possible variations
  const map: Record<string, ActivityItem['type']> = {
    'transfer': 'Transfer',
    'nodeactivation': 'Node Activation',
    'noderegistration': 'Registration',
    'swap': 'Swap',
    'rewarddistribution': 'Reward',
    'contractdeploy': 'Smart Contract',
    'contractcall': 'Smart Contract',
    'batchtransfers': 'Transfer',
    'batchnodeactivations': 'Node Activation',
    'batchrewardclaims': 'Reward',
    'pingattestation': 'System',
    'pingcommitmentwithsampling': 'System',
    'systemreward': 'Reward',
    'systemrewards': 'Reward',
    'systememission': 'Reward',
    'emission': 'Reward',
    'createaccount': 'System',
    'registration': 'Registration',
    'reward': 'Reward',
    'system': 'System',
  };
  
  const result = map[normalized] || 'Transfer';
  
  // Debug log for unmapped types (only first 5)
  if (!map[normalized] && typeStr && serverTxCache.size < 5) {
    console.log(`[API] Unknown tx type: "${typeStr}" (normalized: "${normalized}") -> Transfer`);
  }
  
  return result;
}

function formatAmount(amount: unknown): string {
  if (!amount) return '0 QNC';
  const num = typeof amount === 'string' ? parseFloat(amount) : (amount as number);
  const qnc = num / 1e9;
  if (qnc >= 1_000_000) return (qnc / 1_000_000).toFixed(2) + 'M QNC';
  if (qnc >= 1_000) return (qnc / 1_000).toFixed(2) + 'K QNC';
  return qnc.toFixed(2) + ' QNC';
}

function formatTimeAgo(timestamp: number): string {
  // Genesis block transactions have timestamp=0
  if (!timestamp || timestamp === 0) return 'Genesis';
  
  const now = Date.now();
  const ts = timestamp > 1e12 ? timestamp : timestamp * 1000;
  const diff = now - ts;
  
  if (diff < 0) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const page = parseInt(searchParams.get('page') || '1', 10);
  const perPage = Math.min(parseInt(searchParams.get('limit') || '50', 10), 100);
  const sortOrder = searchParams.get('sort') || 'desc';
  const forceRefresh = searchParams.get('refresh') === '1';
  
  const now = Date.now();
  const shouldRefetch = now - lastFetchTime > CACHE_TTL || forceRefresh || serverTxCache.size === 0;
  
  // Force refresh clears cache
  if (forceRefresh) {
    console.log('[API] Force refresh - clearing cache');
    serverTxCache.clear();
    serverCacheHeight = 0;
    lastFetchTime = 0;
  }
  
  // Check if blockchain was reset (height decreased) - clear cache automatically
  try {
    const heightRes = await fetch(`${NODE_RPC_URL}/api/v1/height`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(2000),
    });
    if (heightRes.ok) {
      const { height: currentNetworkHeight } = await heightRes.json();
      if (currentNetworkHeight > 0 && currentNetworkHeight < serverCacheHeight) {
        console.log(`[API] Blockchain reset detected! Network height ${currentNetworkHeight} < cache height ${serverCacheHeight}. Clearing cache.`);
        serverTxCache.clear();
        serverCacheHeight = 0;
        lastFetchTime = 0;
      }
    }
  } catch {
    // Height check failed, continue with existing cache
  }
  
  // Fetch from network if cache is stale or empty
  if (shouldRefetch || serverTxCache.size === 0) {
    lastFetchTime = now;
    
    // Try indexed API first (fast), fallback to block scanning
    let result = await fetchFromIndexedAPI(page, perPage);
    if (!result) {
      result = await fallbackFetch(page, perPage);
    }
    
    // ADD new transactions to server cache
    let addedCount = 0;
    for (const tx of result.items) {
      if (tx.hash && !serverTxCache.has(tx.hash)) {
        serverTxCache.set(tx.hash, tx as CachedTx);
        addedCount++;
      }
    }
    
    if (result.currentHeight > serverCacheHeight) {
      serverCacheHeight = result.currentHeight;
    }
    
    console.log(`[API] Cache updated: +${addedCount} new, ${serverTxCache.size} total, height=${serverCacheHeight}`);
  }
  
  // Return from cache (stable, never loses data)
  const allCachedTx = Array.from(serverTxCache.values());
  
  // Sort locally
  const sorted = allCachedTx.sort((a, b) => 
    sortOrder === 'asc' ? a.timestamp - b.timestamp : b.timestamp - a.timestamp
  );
  
  // Paginate
  const start = (page - 1) * perPage;
  const pageData = sorted.slice(start, start + perPage);
  
  return NextResponse.json({
    success: true,
    source: forceRefresh ? 'refreshed' : 'cached',
    cacheSize: serverTxCache.size,
    cacheVersion: CACHE_VERSION,
    data: pageData,
    pagination: {
      page,
      perPage,
      total: serverTxCache.size,
      currentHeight: serverCacheHeight,
      hasMore: start + perPage < serverTxCache.size,
    },
  });
}
