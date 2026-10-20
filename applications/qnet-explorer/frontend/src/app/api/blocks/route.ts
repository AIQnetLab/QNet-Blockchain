import { NextRequest, NextResponse } from 'next/server';
import { rateLimit, getClientIdentifier } from '../../../../lib/rate-limit';
import { getLatestBlocks } from '../../../../lib/db';
import { BLOCKS_PER_PAGE, RECENT_BLOCKS, heightOf, recentBlock } from '@/lib/explorer-view';
import { headHub } from '@/server/head-hub';

export const dynamic = 'force-dynamic';

// GET /api/blocks?latest=N: the newest blocks (height, hash, time, producer, transaction count) from the head snapshot,
// which Latest blocks and the home page's live column read to complete the rows the head stream left without them; no
// query of its own. GET /api/blocks?at=H: the page of the block history that starts at height H, one read of at most
// BLOCKS_PER_PAGE rows. A live list asks at most every 2 s and a history page on a click; the limit leaves four times that.
const RATE_LIMIT_MAX = 120;
const RATE_LIMIT_WINDOW = 60 * 1000;

export async function GET(request: NextRequest) {
  const rl = rateLimit(`blocks:${getClientIdentifier(request)}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW);
  if (!rl.allowed) {
    return NextResponse.json({ success: false, error: 'Rate limit exceeded' }, { status: 429, headers: { 'Retry-After': String(Math.ceil((rl.resetTime - Date.now()) / 1000)) } });
  }
  const params = request.nextUrl.searchParams;
  const atText = params.get('at');
  try {
    if (atText !== null) {
      const at = heightOf(atText);
      if (at === null) return NextResponse.json({ success: false, error: 'Invalid block height' }, { status: 400 });
      const rows = await getLatestBlocks(BLOCKS_PER_PAGE, at);
      return NextResponse.json({ success: true, data: rows.map(recentBlock) }, { headers: { 'Cache-Control': 'public, s-maxage=2, stale-while-revalidate=10' } });
    }
    const asked = Math.trunc(Number(params.get('latest')));
    const n = Math.min(Math.max(Number.isFinite(asked) && asked > 0 ? asked : 12, 1), RECENT_BLOCKS);
    const { blocks } = await headHub.snapshot();
    return NextResponse.json({ success: true, data: blocks.slice(0, n) }, { headers: { 'Cache-Control': 'public, s-maxage=1, stale-while-revalidate=4' } });
  } catch (err) {
    console.error(`[ERR][WEB] blocks_read_failed at=${atText ?? '-'} err=${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json({ success: false, error: 'Service temporarily unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
