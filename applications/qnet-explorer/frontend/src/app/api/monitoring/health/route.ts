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
  } catch (dbErr: any) {
    /* log disabled */
    status.database = 'error';
    status.databaseError = dbErr?.message || 'Unknown error';
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
  } catch (syncErr: any) {
    /* log disabled */
    status.syncService = { 
      isRunning: false,
      error: syncErr?.message || 'Unknown error',
      stack: syncErr?.stack 
    };
    status.application = 'degraded';
  }

  // Get monitoring health
  try {
    const health = getMonitoringHealth();
    status.monitoring = health;
  } catch (monErr: any) {
    /* log disabled */
    status.monitoring = { error: monErr?.message || 'Unknown error' };
  }

  // Get rate limit stats
  try {
    const rateLimitStats = await getRateLimitStats();
    status.rateLimit = rateLimitStats;
  } catch (rateErr: any) {
    /* log disabled */
    status.rateLimit = { error: rateErr?.message || 'Unknown error' };
  }

  // Always return 200, even if degraded, so we can see the status
  return NextResponse.json(status, { status: 200 });
}

