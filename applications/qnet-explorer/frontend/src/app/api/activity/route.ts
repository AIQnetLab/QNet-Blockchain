import { NextRequest, NextResponse } from 'next/server';
import { getTransactions } from '../../../../lib/db';
import { rateLimit, getClientIdentifier } from '../../../../lib/rate-limit';
import { enrichActivityRows } from '@/lib/enrich-activity';

export const dynamic = 'force-dynamic';
export const revalidate = 10; // Cache for 10 seconds

// Rate limiting: 100 requests per minute per IP
const RATE_LIMIT_MAX = 100;
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute

export async function GET(request: NextRequest) {
  try {
    // Rate limiting
    const clientId = getClientIdentifier(request);
    const rateLimitResult = rateLimit(clientId, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW);
    
    if (!rateLimitResult.allowed) {
      return NextResponse.json({
        success: false,
        error: 'Rate limit exceeded',
        retryAfter: Math.ceil((rateLimitResult.resetTime - Date.now()) / 1000)
      }, { 
        status: 429,
        headers: {
          'X-RateLimit-Limit': String(RATE_LIMIT_MAX),
          'X-RateLimit-Remaining': String(rateLimitResult.remaining),
          'X-RateLimit-Reset': String(Math.ceil(rateLimitResult.resetTime / 1000)),
          'Retry-After': String(Math.ceil((rateLimitResult.resetTime - Date.now()) / 1000))
        }
      });
    }
    
    // Validate and parse query parameters
    const { searchParams } = new URL(request.url);
    const pageParam = searchParams.get('page');
    const limitParam = searchParams.get('limit');
    const sortParam = searchParams.get('sort');
    const typeParam = searchParams.get('type');
    
    // Validate page
    let page = 1;
    if (pageParam) {
      const parsed = parseInt(pageParam, 10);
      if (isNaN(parsed) || parsed < 1) {
        return NextResponse.json({
          success: false,
          error: 'Invalid page parameter: must be positive integer'
        }, { status: 400 });
      }
      page = parsed;
    }
    
    // Validate limit
    let perPage = 50;
    if (limitParam) {
      const parsed = parseInt(limitParam, 10);
      if (isNaN(parsed) || parsed < 1 || parsed > 500) {
        return NextResponse.json({
          success: false,
          error: 'Invalid limit parameter: must be between 1 and 500'
        }, { status: 400 });
      }
      perPage = parsed;
    }
    
    // Validate sort
    let sortOrder: 'asc' | 'desc' = 'desc';
    if (sortParam) {
      if (sortParam !== 'asc' && sortParam !== 'desc') {
        return NextResponse.json({
          success: false,
          error: 'Invalid sort parameter: must be "asc" or "desc"'
        }, { status: 400 });
      }
      sortOrder = sortParam as 'asc' | 'desc';
    }
    
    // Validate type filter (single type, raw DB name)
    let typeFilter: string | undefined = undefined;
    if (typeParam) {
      if (!/^[a-zA-Z0-9_\s-]+$/.test(typeParam)) {
        return NextResponse.json({
          success: false,
          error: 'Invalid type parameter format'
        }, { status: 400 });
      }
      typeFilter = typeParam;
    }

    // Support multiple display-type filters (e.g. types=Transfer,Reward)
    const typesParam = searchParams.get('types');
    let displayTypes: string[] | undefined = undefined;
    if (typesParam) {
      displayTypes = typesParam.split(',').map(t => t.trim()).filter(t => /^[a-zA-Z ]+$/.test(t));
      if (displayTypes.length === 0) displayTypes = undefined;
    }

    // Get transactions from PostgreSQL
    const { transactions, total, currentHeight } = await getTransactions(page, perPage, sortOrder, typeFilter, displayTypes);

    // Lightweight response for list view — no signatures/keys (saves ~80% bandwidth).
    // Enriched via the SAME helper as SSR so token rows keep their icon/symbol/amount/
    // click-through across polls + pagination. status/is_quantum_signed zipped by position.
    const enriched = await enrichActivityRows(transactions);
    const responseData = enriched.map((r, i) => ({
      ...r,
      status: transactions[i].status || 'confirmed',
      is_quantum_signed: transactions[i].is_quantum_signed,
    }));

  return NextResponse.json({
    success: true,
    data: responseData,
    pagination: {
      page,
      perPage,
        total,
        hasMore: (page * perPage) < total,
        currentHeight,
      },
    }, {
      headers: {
        'X-RateLimit-Limit': String(RATE_LIMIT_MAX),
        'X-RateLimit-Remaining': String(rateLimitResult.remaining),
        'X-RateLimit-Reset': String(Math.ceil(rateLimitResult.resetTime / 1000))
      }
    });
  } catch (err) {
    console.error('[API /activity] Error:', err instanceof Error ? err.message : err);
    return NextResponse.json({
      success: false,
      error: 'Service temporarily unavailable',
      data: [],
      pagination: {
        page: 1,
        perPage: 50,
        total: 0,
        hasMore: false,
      },
    }, { status: 503 });
  }
}
