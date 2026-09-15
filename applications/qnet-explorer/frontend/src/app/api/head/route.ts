import { NextResponse } from 'next/server';
import { headHub } from '@/server/head-hub';

export const dynamic = 'force-dynamic';

// The current head snapshot as JSON — the polling fallback for clients without a working event stream.
// Served from process memory; cacheable for a second at any edge in front.
export async function GET() {
  try {
    const s = await headHub.snapshot();
    return NextResponse.json({
      success: true,
      data: {
        v: s.version,
        height: s.height,
        hash: s.hash,
        timestamp: s.timestamp,
        txTotal: s.stats.tx_total,
        txByType: s.stats.tx_by_type,
        blocksTotal: s.stats.blocks_total,
        emissionTotal: s.stats.emission_total,
        sync: { head: s.sync.last_height, prefix: s.sync.indexed_prefix, nodeHeight: s.sync.node_height, live: s.sync.ws_connected, healPending: s.sync.heal_pending },
      },
    }, { headers: { 'Cache-Control': 'public, s-maxage=1, stale-while-revalidate=4' } });
  } catch {
    return NextResponse.json({ success: false, error: 'Service temporarily unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
