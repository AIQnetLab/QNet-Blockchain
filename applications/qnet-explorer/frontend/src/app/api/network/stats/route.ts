import { NextResponse } from 'next/server';

// ============================================================================
// PRODUCTION v2.72: Hybrid approach - Node RPC for live height, Indexer for stats
// ============================================================================

// Node RPC for real-time height (must be live)
const NODE_RPC_URL = process.env.QNET_API_URL || 'http://154.38.160.39:8001';

// Indexer for aggregated stats (optional, faster)
const INDEXER_API_URL = process.env.INDEXER_API_URL || 'http://localhost:9000';
const INDEXER_API_KEY = process.env.INDEXER_API_KEY || '';

// Helper: Get headers for Indexer requests
function getIndexerHeaders(): HeadersInit {
  const headers: HeadersInit = { 'Content-Type': 'application/json' };
  if (INDEXER_API_KEY) {
    headers['X-API-Key'] = INDEXER_API_KEY;
  }
  return headers;
}

// Disable ALL caching
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

export async function GET() {
  try {
    // Fetch height from Node RPC (must be real-time)
    // Fetch stats from Indexer if available, fallback to Node RPC
    const [heightRes, indexerStatsRes, nodeStatsRes] = await Promise.all([
      fetch(`${NODE_RPC_URL}/api/v1/height?t=${Date.now()}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      }),
      fetch(`${INDEXER_API_URL}/api/v1/stats`, {
        headers: getIndexerHeaders(),
        cache: 'no-store',
        signal: AbortSignal.timeout(3000),
      }).catch(() => null),
      fetch(`${NODE_RPC_URL}/api/v1/public/stats?t=${Date.now()}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      }).catch(() => null),
    ]);
    
    // Use Indexer stats if available, else Node RPC
    const statsRes = indexerStatsRes?.ok ? indexerStatsRes : nodeStatsRes;
    
    if (heightRes.ok) {
      const heightData = await heightRes.json();
      const statsData = statsRes.ok ? await statsRes.json() : {};
      
      const height = heightData.height || 0;
      // Reward epoch = 1-based (epoch 1 starts at block 0)
      const rewardEpoch = Math.floor(height / 14400) + 1;
      // Blocks until next reward
      const blocksUntilReward = 14400 - (height % 14400);
      // Time until reward in seconds (1 block = 1 second)
      const secondsUntilReward = blocksUntilReward;
      
      const response = NextResponse.json({
        success: true,
        data: {
          activeNodes: statsData.active_nodes || 5,
          currentRound: rewardEpoch,
          height: height,
          blocksUntilReward: blocksUntilReward,
          secondsUntilReward: secondsUntilReward
        }
      });
      
      // Force no caching in response headers
      response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      response.headers.set('Pragma', 'no-cache');
      response.headers.set('Expires', '0');
      
      return response;
    }
    throw new Error('Backend unavailable');
  } catch {
    const response = NextResponse.json({
      success: false,
      data: null
    });
    response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    return response;
  }
}

