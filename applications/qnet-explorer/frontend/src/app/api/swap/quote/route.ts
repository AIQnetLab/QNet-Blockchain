import { NextRequest, NextResponse } from 'next/server';
import { fetchNode } from '@/lib/node-api';

// ============================================================================
// SWAP Quote API - DEX Module
// Status: Planned for Phase 3
// ============================================================================

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    
    // Try to get quote from backend DEX
    // A quote changes nothing, so another node may answer it.
    const res = await fetchNode('/api/v1/dex/quote', { method: 'POST', body: JSON.stringify(body), timeoutMs: 5000 });

    if (res && res.ok) {
      const data = await res.json();
      return NextResponse.json({
        success: true,
        ...data,
      });
    }
    
    return NextResponse.json({
      success: false,
      error: 'DEX_NOT_DEPLOYED',
      message: 'Decentralized Exchange is scheduled for Phase 3',
    }, { status: 501 });
    
  } catch {
    return NextResponse.json({
      success: false,
      error: 'DEX_UNAVAILABLE',
      message: 'DEX service is not available',
    }, { status: 503 });
  }
}
