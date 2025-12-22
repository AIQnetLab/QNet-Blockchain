import { type NextRequest, NextResponse } from 'next/server';

// SWAP Quote API - DEX not yet available
// When launched: Gas fees go to Pool 2 (70% Super nodes, 30% Full nodes)

const QNET_API_URL = process.env.QNET_API_URL || 'http://localhost:8000';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const tokenIn = searchParams.get('tokenIn');
    const tokenOut = searchParams.get('tokenOut');
    const amountIn = searchParams.get('amountIn');
    const pool = searchParams.get('pool');

    if (!tokenIn || !tokenOut || !amountIn) {
      return NextResponse.json({
        success: false,
        error: 'Missing required parameters: tokenIn, tokenOut, amountIn',
      }, { status: 400 });
    }

    // Try backend
    const res = await fetch(
      `${QNET_API_URL}/api/v1/dex/quote?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${amountIn}&pool=${pool || ''}`,
      { next: { revalidate: 5 } }
    );
    
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






