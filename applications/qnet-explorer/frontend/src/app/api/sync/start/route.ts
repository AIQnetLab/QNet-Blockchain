import { NextResponse } from 'next/server';
import { getSyncStatus, getExplorerStats } from '../../../../../lib/db';

export const dynamic = 'force-dynamic';

// Indexing runs in the qnet-indexer process; the web tier reports its published state.
export async function GET() {
  try {
    const [sync, stats] = await Promise.all([getSyncStatus(), getExplorerStats()]);
    const lag = sync.node_height - sync.indexed_prefix;
    return NextResponse.json({
      success: true,
      status: {
        head: sync.last_height,
        indexedPrefix: sync.indexed_prefix,
        nodeHeight: sync.node_height,
        lag,
        live: sync.ws_connected,
        nodeEndpoint: sync.node_endpoint,
        healPending: sync.heal_pending,
        lastSyncAt: sync.last_sync_at ? new Date(sync.last_sync_at).toISOString() : null,
        txTotal: stats.tx_total,
        blocksTotal: stats.blocks_total,
        healthy: lag <= 600 && sync.last_sync_at !== null && Date.now() - new Date(sync.last_sync_at).getTime() < 120_000,
      },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ success: false, error: 'Failed to get sync status' }, { status: 503 });
  }
}

export async function POST() {
  return NextResponse.json({ success: false, error: 'Indexing is owned by the qnet-indexer process' }, { status: 410 });
}
