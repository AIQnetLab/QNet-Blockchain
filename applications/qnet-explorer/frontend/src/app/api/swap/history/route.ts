import { NextRequest, NextResponse } from 'next/server';
import { fetchNode } from '@/lib/node-api';

// ============================================================================
// SWAP History API - DEX Module
// Status: Planned for Phase 3
// ============================================================================

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get('address');
  
  if (!address) {
    return NextResponse.json({
      success: false,
      error: 'ADDRESS_REQUIRED',
      message: 'Wallet address is required',
    }, { status: 400 });
  }
  
  try {
    // Try to fetch swap history from backend DEX
    const res = await fetchNode(`/api/v1/dex/history?address=${encodeURIComponent(address)}`, { cache: 'no-store', timeoutMs: 5000 });

    if (res && res.ok) {
      const data = await res.json();
      return NextResponse.json({
        success: true,
        swaps: data.swaps || [],
      });
    }
    
    return NextResponse.json({
      success: false,
      error: 'DEX_NOT_DEPLOYED',
      message: 'Decentralized Exchange is scheduled for Phase 3',
      swaps: [],
    }, { status: 501 });
    
  } catch {
    return NextResponse.json({
      success: false,
      error: 'DEX_UNAVAILABLE',
      message: 'DEX service is not available',
      swaps: [],
    }, { status: 503 });
  }
}
