import { NextRequest, NextResponse } from 'next/server';

// ============================================================================
// SWAP Quote API - DEX Module
// Status: Planned for Phase 3
// ============================================================================

const QNET_API_URL = process.env.QNET_API_URL || 'http://localhost:8001';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    
    // Try to get quote from backend DEX
    const res = await fetch(`${QNET_API_URL}/api/v1/dex/quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
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
