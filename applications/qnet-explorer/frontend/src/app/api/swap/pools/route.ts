import { NextResponse } from 'next/server';

// ============================================================================
// SWAP Pools API - DEX Module
// v3.18+: Transaction fees go directly to block producer (Super nodes only)
// Status: Planned for Phase 3
// ============================================================================

const QNET_API_URL = process.env.QNET_API_URL || 'http://localhost:8001';

export async function GET() {
  try {
    // Try to fetch from backend DEX module
    const res = await fetch(`${QNET_API_URL}/api/v1/dex/pools`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    
    if (res.ok) {
      const data = await res.json();
      return NextResponse.json({
        success: true,
        pools: data.pools || [],
        totalTvl: data.total_tvl || '0',
      });
    }
    
    // DEX module not deployed yet
    return NextResponse.json({
      success: false,
      error: 'DEX_NOT_DEPLOYED',
      message: 'Decentralized Exchange is scheduled for Phase 3',
      pools: [],
      totalTvl: '0',
    }, { status: 501 }); // 501 Not Implemented
    
  } catch {
    return NextResponse.json({
      success: false,
      error: 'DEX_UNAVAILABLE',
      message: 'DEX service is not available',
      pools: [],
      totalTvl: '0',
    }, { status: 503 });
  }
}
