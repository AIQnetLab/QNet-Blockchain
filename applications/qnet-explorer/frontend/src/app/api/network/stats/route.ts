import { NextResponse } from 'next/server';

// PRODUCTION: Use Genesis Node 001 as primary API source
// Fallback to localhost for local development
const QNET_API_URL = process.env.QNET_API_URL || 'http://154.38.160.39:8001';

// Disable caching for real-time data
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  try {
    // Fetch from correct backend endpoint - NO CACHE for real-time data
    const res = await fetch(`${QNET_API_URL}/api/v1/public/stats`, {
      cache: 'no-store'
    });
    
    if (res.ok) {
      const data = await res.json();
      const height = data.height || 0;
      // Reward round = every 14400 blocks (4 hours × 3600 sec = 14400 blocks at 1 block/sec)
      const rewardRound = Math.floor(height / 14400);
      
      return NextResponse.json({
        success: true,
        data: {
          activeNodes: data.active_nodes || 0,
          currentRound: rewardRound,
          height: height
        }
      });
    }
    throw new Error('Backend unavailable');
  } catch {
    // Return zeros when backend is unavailable
    return NextResponse.json({
      success: true,
      data: {
        activeNodes: 0,
        currentRound: 0,
        height: 0
      }
    });
  }
}

