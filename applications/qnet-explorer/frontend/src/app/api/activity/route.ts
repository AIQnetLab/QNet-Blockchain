import { NextRequest, NextResponse } from 'next/server';
import { listTransactions, decodeCursor, encodeCursor, DISPLAY_TYPE_TO_DB, MAX_OFFSET_PAGE } from '../../../../lib/db';
import { rateLimit, getClientIdentifier } from '../../../../lib/rate-limit';
import { enrichActivityRows } from '@/lib/enrich-activity';
import { headHub } from '@/server/head-hub';

export const dynamic = 'force-dynamic';

// Transaction list. Keyset paging: `cursor` + `dir=next|prev`; numbered jumps `page=N` up to
// MAX_OFFSET_PAGE. The default first page is served from the process head cache (no query).

const RATE_LIMIT_MAX = 600;
const RATE_LIMIT_WINDOW = 60 * 1000;
const DISPLAY_TYPES = new Set(Object.keys(DISPLAY_TYPE_TO_DB));

export async function GET(request: NextRequest) {
  const clientId = getClientIdentifier(request);
  const rl = rateLimit(clientId, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW);
  const rlHeaders = {
    'X-RateLimit-Limit': String(RATE_LIMIT_MAX),
    'X-RateLimit-Remaining': String(rl.remaining),
    'X-RateLimit-Reset': String(Math.ceil(rl.resetTime / 1000)),
  };
  if (!rl.allowed) {
    return NextResponse.json({ success: false, error: 'Rate limit exceeded' }, { status: 429, headers: { ...rlHeaders, 'Retry-After': String(Math.ceil((rl.resetTime - Date.now()) / 1000)) } });
  }

  const q = new URL(request.url).searchParams;
  const limitRaw = q.get('limit');
  const limit = limitRaw === null ? 50 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) return bad('limit must be an integer between 1 and 200');
  const sortRaw = q.get('sort') || 'desc';
  if (sortRaw !== 'asc' && sortRaw !== 'desc') return bad('sort must be asc or desc');
  const dirRaw = q.get('dir') || 'next';
  if (dirRaw !== 'next' && dirRaw !== 'prev') return bad('dir must be next or prev');
  const cursorRaw = q.get('cursor');
  const cursor = cursorRaw ? decodeCursor(cursorRaw) : null;
  if (cursorRaw && !cursor) return bad('cursor is not valid');
  let page = 1;
  if (!cursor && q.get('page') !== null) {
    page = Number(q.get('page'));
    if (!Number.isInteger(page) || page < 1) return bad('page must be a positive integer');
    if (page > MAX_OFFSET_PAGE) return bad(`page jumps are limited to ${MAX_OFFSET_PAGE}; continue with cursor`);
  }
  let displayTypes: string[] | undefined;
  const typesRaw = q.get('types');
  if (typesRaw) {
    const list = typesRaw.split(',').map(t => t.trim()).filter(Boolean);
    if (list.length > 20 || list.some(t => !DISPLAY_TYPES.has(t))) return bad('types contains an unknown value');
    displayTypes = list;
  }

  try {
    // Default view, first page: the cached head snapshot (one query per block per process).
    if (!cursor && page === 1 && !displayTypes && sortRaw === 'desc' && limit <= 50) {
      const s = await headHub.snapshot();
      const rows = s.rows.slice(0, limit);
      const last = rows[rows.length - 1];
      return NextResponse.json({
        success: true,
        data: rows,
        pagination: {
          limit, total: s.stats.tx_total, currentHeight: s.height, page: 1,
          nextCursor: last && s.stats.tx_total > rows.length ? encodeCursor({ block: last.block, tx_index: last.txIndex }) : null,
          prevCursor: null,
          maxPage: Math.min(MAX_OFFSET_PAGE, Math.max(1, Math.ceil(s.stats.tx_total / limit))),
          v: s.version,
        },
      }, { headers: { ...rlHeaders, 'Cache-Control': 'public, s-maxage=1, stale-while-revalidate=4' } });
    }

    const res = await listTransactions({ limit, sort: sortRaw, direction: dirRaw, cursor, displayTypes, page });
    const data = await enrichActivityRows(res.transactions);
    return NextResponse.json({
      success: true,
      data,
      pagination: {
        limit, total: res.total, currentHeight: res.currentHeight, page: cursor ? null : page,
        nextCursor: res.nextCursor, prevCursor: res.prevCursor,
        maxPage: Math.min(MAX_OFFSET_PAGE, Math.max(1, Math.ceil(res.total / limit))),
      },
    }, { headers: { ...rlHeaders, 'Cache-Control': 'public, s-maxage=2, stale-while-revalidate=8' } });
  } catch (err) {
    console.error(`[ERR][API] activity_failed err=${JSON.stringify(err instanceof Error ? err.message : String(err))}`);
    return NextResponse.json({ success: false, error: 'Service temporarily unavailable', data: [], pagination: { limit, total: 0 } }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}

function bad(message: string) {
  return NextResponse.json({ success: false, error: message }, { status: 400 });
}

