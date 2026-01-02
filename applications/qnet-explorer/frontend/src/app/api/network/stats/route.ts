import { NextResponse } from 'next/server';

// PRODUCTION: Use Genesis Node 001 as primary API source
const QNET_API_URL = process.env.QNET_API_URL || 'http://154.38.160.39:8001';

// Disable ALL caching
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

export async function GET() {
  try {
    // Use /height endpoint for real-time data (no caching)
    const [heightRes, statsRes] = await Promise.all([
      fetch(`${QNET_API_URL}/api/v1/height?t=${Date.now()}`, {
        cache: 'no-store',
        next: { revalidate: 0 }
      }),
      fetch(`${QNET_API_URL}/api/v1/public/stats?t=${Date.now()}`, {
        cache: 'no-store',
        next: { revalidate: 0 }
      })
    ]);
    
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

