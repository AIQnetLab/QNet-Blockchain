import { NextResponse } from 'next/server';
import { startSyncService, getSyncServiceStatus } from '../../../../../lib/sync-service';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST() {
  try {
    let status;
    try {
      status = await getSyncServiceStatus();
    } catch (statusErr) {
      console.warn('[API] Could not get initial status, starting anyway:', statusErr);
      status = { isRunning: false } as any;
    }
    
    if (status.isRunning) {
      return NextResponse.json({
        success: true,
        message: 'Sync service is already running',
        status,
      });
    }
    
    console.log('[API] Manually starting sync service...');
    startSyncService();
    
    // Wait a bit for it to initialize
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    let newStatus;
    try {
      newStatus = await getSyncServiceStatus();
    } catch (statusErr) {
      console.warn('[API] Could not get new status after start:', statusErr);
      newStatus = { isRunning: true, lastHeight: 0, lastSyncAt: null } as any;
    }
    
    return NextResponse.json({
      success: true,
      message: 'Sync service started',
      status: newStatus,
    });
  } catch (err) {
    console.error('[API] Failed to start sync service:', err);
    return NextResponse.json({
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
      stack: err instanceof Error ? err.stack : undefined,
    }, { status: 500 });
  }
}

export async function GET() {
  try {
    const status = await getSyncServiceStatus();
    return NextResponse.json({
      success: true,
      status,
    });
  } catch (err) {
    return NextResponse.json({
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    }, { status: 500 });
  }
}

