import { NextRequest, NextResponse } from 'next/server';
import { getRecentAlerts, getAlertStats } from '../../../../../lib/monitoring';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const limitParam = searchParams.get('limit');
    const limit = limitParam ? Math.min(parseInt(limitParam, 10) || 50, 100) : 50;
    
    const alerts = getRecentAlerts(limit);
    const stats = getAlertStats();
    
    return NextResponse.json({
      success: true,
      alerts,
      stats,
      count: alerts.length,
    });
  } catch (err) {
    console.error('[Monitoring] Get alerts error:', err);
    return NextResponse.json({
      success: false,
      error: 'Failed to get alerts',
      alerts: [],
      stats: { total: 0, bySeverity: {}, byEvent: {} },
    }, { status: 500 });
  }
}

