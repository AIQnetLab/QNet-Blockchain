import { NextResponse } from 'next/server';

const QNET_API_URL = process.env.QNET_API_URL || 'http://localhost:8000';

export async function GET() {
  try {
    // Fetch from correct backend endpoint
    const res = await fetch(`${QNET_API_URL}/api/v1/public/stats`, {
      next: { revalidate: 5 }
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

