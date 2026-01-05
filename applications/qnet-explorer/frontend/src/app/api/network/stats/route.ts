import { NextResponse } from 'next/server';

// ============================================================================
// PRODUCTION v2.74: Direct Node RPC with RocksDB
// ============================================================================

// Node RPC for real-time data
const NODE_RPC_URL = process.env.QNET_API_URL || 'http://154.38.160.39:8001';

// Disable ALL caching
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

export async function GET() {
  try {
    // Fetch height and stats from Node RPC
    const [heightRes, statsRes] = await Promise.all([
      fetch(`${NODE_RPC_URL}/api/v1/height?t=${Date.now()}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      }),
      fetch(`${NODE_RPC_URL}/api/v1/public/stats?t=${Date.now()}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      }).catch(() => null),
    ]);
    
    if (heightRes.ok) {
      const heightData = await heightRes.json();
      const statsData = statsRes?.ok ? await statsRes.json() : {};
      
      const height = heightData.height || 0;
      // Reward epoch = 1-based (epoch 1 starts at block 0)
      const rewardEpoch = Math.floor(height / 14400) + 1;
      // Blocks until next reward
      const blocksUntilReward = 14400 - (height % 14400);
      // Time until reward in seconds (1 block = 1 second)
      const secondsUntilReward = blocksUntilReward;
      
      const response = NextResponse.json({
        success: true,
        source: 'rocksdb',
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
