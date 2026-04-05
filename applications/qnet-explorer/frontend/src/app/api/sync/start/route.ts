import { NextResponse } from 'next/server';
import { startSyncService, getSyncServiceStatus } from '../../../../../lib/sync-service';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST() {
  try {
    let status;
    try {
      status = await getSyncServiceStatus();
    } catch {
      status = { isRunning: false } as any;
    }
    
    if (status.isRunning) {
      return NextResponse.json({
        success: true,
        message: 'Sync service is already running',
        status,
      });
    }
    
    startSyncService();
    
    // Wait a bit for it to initialize
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    let newStatus;
    try {
      newStatus = await getSyncServiceStatus();
    } catch {
      newStatus = { isRunning: true, lastHeight: 0, lastSyncAt: null } as any;
    }
    
    return NextResponse.json({
      success: true,
      message: 'Sync service started',
      status: newStatus,
    });
  } catch (err) {
    return NextResponse.json({
      success: false,
      error: 'Sync service error',
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
      error: 'Failed to get sync status',
    }, { status: 500 });
  }
}

