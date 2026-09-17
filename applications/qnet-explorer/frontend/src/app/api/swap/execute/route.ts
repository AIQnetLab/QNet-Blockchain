import { NextRequest, NextResponse } from 'next/server';
import { fetchNode } from '@/lib/node-api';

// ============================================================================
// SWAP Execute API - DEX Module
// Status: Planned for Phase 3
// ============================================================================

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    
    // Try to execute swap via backend DEX
    // A swap is a write: one node only, never retried on another.
    const res = await fetchNode('/api/v1/dex/swap', {
      method: 'POST', body: JSON.stringify(body), timeoutMs: 30000, failover: false,
    });

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
