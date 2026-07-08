import { NextResponse } from 'next/server';
import { getDbPool } from '../../../../../lib/db';
import { getSyncServiceStatus } from '../../../../../lib/sync-service';
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

  // Check Sync Service status
  try {
    const syncStatus = await getSyncServiceStatus();
    status.syncService = syncStatus;
    if (!syncStatus.isRunning) {
      status.application = 'degraded';
    }
    if (syncStatus.lastError) {
      status.application = 'degraded';
    }
  } catch {
    // Do not leak internal error details/stack to clients; log server-side only.
    status.syncService = { isRunning: false, error: 'unavailable' };
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

