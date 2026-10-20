import { NextResponse } from 'next/server';
import { headEvent, headHub } from '@/server/head-hub';

export const dynamic = 'force-dynamic';

// The current head snapshot as JSON — the polling fallback for clients without a working event stream.
// Served from process memory; cacheable for a second at any edge in front.
export async function GET() {
  try {
    const s = await headHub.snapshot();
    return NextResponse.json({ success: true, data: headEvent(s) }, { headers: { 'Cache-Control': 'public, s-maxage=1, stale-while-revalidate=4' } });
  } catch {
    return NextResponse.json({ success: false, error: 'Service temporarily unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
