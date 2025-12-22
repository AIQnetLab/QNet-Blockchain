import { type NextRequest, NextResponse } from 'next/server';

// SWAP Execute API - DEX not yet available
// When launched: Gas fees go to Pool 2 (70% Super nodes, 30% Full nodes)

const QNET_API_URL = process.env.QNET_API_URL || 'http://localhost:8000';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    
    // Forward to backend
    const res = await fetch(`${QNET_API_URL}/api/v1/dex/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    
    if (res.ok) {
      const data = await res.json();
      return NextResponse.json({ success: true, ...data });
    }

    return NextResponse.json({
      success: false,
      error: 'DEX not available yet',
    }, { status: 503 });
    
  } catch {
    return NextResponse.json({
      success: false,
      error: 'DEX not available yet',
    }, { status: 503 });
  }
}






