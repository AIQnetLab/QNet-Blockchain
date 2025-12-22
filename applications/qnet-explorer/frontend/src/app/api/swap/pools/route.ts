import { NextResponse } from 'next/server';

// SWAP Pools API - DEX not yet available
// When launched: Fees from swaps go to Pool 2 (70% Super nodes, 30% Full nodes)

const QNET_API_URL = process.env.QNET_API_URL || 'http://localhost:8000';

export async function GET() {
  try {
    // Try to fetch from backend
    const res = await fetch(`${QNET_API_URL}/api/v1/dex/pools`, {
      next: { revalidate: 30 }
    });
    
    if (res.ok) {
      const data = await res.json();
      return NextResponse.json({
        success: true,
        pools: data.pools || [],
        totalTvl: data.total_tvl || '0',
        pool2Balance: data.pool2_balance || '0',
      });
    }
    
    // DEX not available
    return NextResponse.json({
      success: false,
      error: 'DEX not available yet',
      pools: [],
      totalTvl: '0',
      pool2Balance: '0',
    }, { status: 503 });
    
  } catch {
    return NextResponse.json({
      success: false,
      error: 'DEX not available yet',
      pools: [],
      totalTvl: '0',
      pool2Balance: '0',
    }, { status: 503 });
  }
}






