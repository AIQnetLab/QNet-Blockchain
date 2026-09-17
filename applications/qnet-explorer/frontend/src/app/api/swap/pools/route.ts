import { NextResponse } from 'next/server';
import { fetchNode } from '@/lib/node-api';

// ============================================================================
// SWAP Pools API - DEX Module
// v3.18+: Transaction fees go directly to block producer (Super nodes only)
// Status: Planned for Phase 3
// ============================================================================

export async function GET() {
  try {
    // Try to fetch from backend DEX module
    const res = await fetchNode('/api/v1/dex/pools', { cache: 'no-store', timeoutMs: 5000 });

    if (res && res.ok) {
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
