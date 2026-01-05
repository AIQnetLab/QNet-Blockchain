import { NextRequest, NextResponse } from 'next/server';
import { getTransactions } from '../../../../lib/db';
import { rateLimit, getClientIdentifier } from '../../../../lib/rate-limit';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Rate limiting: 100 requests per minute per IP
const RATE_LIMIT_MAX = 100;
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute

// Format amount from nanoQNC to QNC
function formatAmount(amount: number): string {
  if (!amount) return '0 QNC';
  const qnc = amount / 1e9;
  if (qnc >= 1_000_000) return (qnc / 1_000_000).toFixed(2) + 'M QNC';
  if (qnc >= 1_000) return (qnc / 1_000).toFixed(2) + 'K QNC';
  return qnc.toFixed(2) + ' QNC';
}

// Map transaction type to display string
function mapTxType(type: string): string {
  const normalized = type.toLowerCase().replace(/_/g, '');
  
  const map: Record<string, string> = {
    'transfer': 'Transfer',
    'nodeactivation': 'Node Activation',
    'noderegistration': 'Registration',
    'swap': 'Swap',
    'rewarddistribution': 'Reward',
    'contractdeploy': 'Smart Contract',
    'contractcall': 'Smart Contract',
    'batchtransfers': 'Transfer',
    'batchnodeactivations': 'Node Activation',
    'batchrewardclaims': 'Reward',
    'pingattestation': 'System',
    'pingcommitmentwithsampling': 'System',
    'systemreward': 'Reward',
    'systemrewards': 'Reward',
    'systememission': 'Reward',
    'emission': 'Reward',
    'createaccount': 'System',
    'registration': 'Registration',
    'reward': 'Reward',
    'system': 'System',
  };
  
  return map[normalized] || 'Transfer';
}

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
    
    // Validate type filter
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

    // Get transactions from PostgreSQL
    const { transactions, total, currentHeight } = await getTransactions(page, perPage, sortOrder, typeFilter);

    // Map to response format - return ALL fields
    // Note: perPage is already validated to max 500, so we use all transactions
    const responseData = transactions.map((tx) => ({
      hash: tx.hash,
      type: mapTxType(tx.tx_type),
      from: tx.from_address,
      to: tx.to_address || 'N/A',
      amount: formatAmount(tx.amount),
      amount_raw: tx.amount,
      block: tx.block,
      timestamp: tx.timestamp,
      time: '', // Client computes relative time from timestamp
      nonce: tx.nonce,
      gas_price: tx.gas_price,
      gas_limit: tx.gas_limit,
      signature: tx.signature,
      public_key: tx.public_key,
      is_quantum_signed: tx.is_quantum_signed,
      dilithium_signature: tx.dilithium_signature,
      dilithium_public_key: tx.dilithium_public_key,
      tx_type: tx.tx_type,
      data: tx.data,
      status: tx.status || 'confirmed',
      block_height: tx.block,
    }));

    // Limit JSON response size (max 10MB)
    const jsonString = JSON.stringify({
      success: true,
      version: 'v4.0-postgresql',
      totalStored: total,
      data: responseData,
      pagination: {
        page,
        perPage,
        total,
        hasMore: (page * perPage) < total,
        currentHeight,
      },
    });
    
    if (jsonString.length > 10 * 1024 * 1024) {
      console.warn('[API] Response too large, truncating data');
      return NextResponse.json({
        success: true,
        version: 'v4.0-postgresql',
        totalStored: total,
        data: [],
        pagination: {
          page,
          perPage,
          total,
          hasMore: true,
        },
        error: 'Response too large, please use pagination',
      }, {
        status: 413,
      });
    }
  
  return NextResponse.json({
    success: true,
      version: 'v4.0-postgresql',
      totalStored: total,
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
    console.error('[API] Activity route error:', err);
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error('[API] Error details:', {
      message: errorMessage,
      stack: err instanceof Error ? err.stack : undefined,
      DATABASE_URL: process.env.DATABASE_URL ? 'set' : 'not set',
    });
    return NextResponse.json({
      success: false,
      error: `Database error: ${errorMessage}`,
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
