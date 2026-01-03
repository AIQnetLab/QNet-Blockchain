import { NextRequest, NextResponse } from 'next/server';

// ============================================================================
// SWAP Execute API - DEX Module
// Status: Planned for Phase 3
// ============================================================================

const QNET_API_URL = process.env.QNET_API_URL || 'http://localhost:8001';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    
    // Try to execute swap via backend DEX
    const res = await fetch(`${QNET_API_URL}/api/v1/dex/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000), // 30s for tx execution
    });
    
    if (res.ok) {
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
