import { type NextRequest, NextResponse } from 'next/server';

// SWAP History API - DEX not yet available
// When launched: Shows user's swap history

const QNET_API_URL = process.env.QNET_API_URL || 'http://localhost:8000';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const address = searchParams.get('address');
    const page = searchParams.get('page') || '1';
    const perPage = searchParams.get('per_page') || '20';

    if (!address) {
      return NextResponse.json({
        success: false,
        error: 'Missing required parameter: address',
      }, { status: 400 });
    }

    // Try backend
    const res = await fetch(
      `${QNET_API_URL}/api/v1/dex/history?address=${address}&page=${page}&per_page=${perPage}`,
      { next: { revalidate: 10 } }
    );
    
    if (res.ok) {
      const data = await res.json();
      return NextResponse.json({ success: true, ...data });
    }

    return NextResponse.json({
      success: false,
      error: 'DEX not available yet',
      items: [],
      total: 0,
    }, { status: 503 });
    
  } catch {
    return NextResponse.json({
      success: false,
      error: 'DEX not available yet',
      items: [],
      total: 0,
    }, { status: 503 });
  }
}
