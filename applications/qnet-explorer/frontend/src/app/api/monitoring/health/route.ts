import { NextResponse } from 'next/server';
import { getDbPool, getSyncStatus } from '../../../../../lib/db';
import { getMonitoringHealth } from '../../../../../lib/monitoring';
import { getRateLimitStats } from '../../../../../lib/rate-limit-redis';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  const status: Record<string, unknown> = {
    application: 'ok',
    timestamp: new Date().toISOString(),
  };

  // Check Database connection
  try {
    const dbPool = getDbPool();
    await dbPool.query('SELECT 1');
    status.database = 'ok';
  } catch {
    // Do not leak internal error details to clients; log server-side only.
    status.database = 'error';
    status.application = 'degraded';
  }

  // Indexer state as published by the qnet-indexer process.
  try {
    const sync = await getSyncStatus();
    const lag = sync.node_height - sync.indexed_prefix;
    const stale = !sync.last_sync_at || Date.now() - new Date(sync.last_sync_at).getTime() > 120_000;
    status.indexer = { head: sync.last_height, indexedPrefix: sync.indexed_prefix, nodeHeight: sync.node_height, lag, live: sync.ws_connected, stale };
    if (stale || lag > 600) status.application = 'degraded';
  } catch {
    status.indexer = { error: 'unavailable' };
    status.application = 'degraded';
  }

  // Get monitoring health
  try {
    const health = getMonitoringHealth();
    status.monitoring = health;
  } catch {
    status.monitoring = { error: 'unavailable' };
  }

  // Get rate limit stats
  try {
    const rateLimitStats = await getRateLimitStats();
    status.rateLimit = rateLimitStats;
  } catch {
    status.rateLimit = { error: 'unavailable' };
  }

  // Always return 200, even if degraded, so we can see the status
  return NextResponse.json(status, { status: 200 });
}

