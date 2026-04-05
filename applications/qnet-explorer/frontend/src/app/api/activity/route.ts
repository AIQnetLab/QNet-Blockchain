import { NextRequest, NextResponse } from 'next/server';
import { getTransactions } from '../../../../lib/db';
import { rateLimit, getClientIdentifier } from '../../../../lib/rate-limit';

export const dynamic = 'force-dynamic';
export const revalidate = 10; // Cache for 10 seconds

// Rate limiting: 100 requests per minute per IP
const RATE_LIMIT_MAX = 100;
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute

// Format amount from nanoQNC to QNC
// v3.52: Dynamic precision — never lose small amounts
function formatAmount(amount: number | string): string {
  const numAmount = Number(amount);
  if (!numAmount || !Number.isFinite(numAmount)) return '0.00 QNC';
  const qnc = numAmount / 1e9;
  
  if (qnc >= 0.01) {
    return qnc.toLocaleString('en-US', { 
      minimumFractionDigits: 2, 
      maximumFractionDigits: 2 
    }) + ' QNC';
  }
  
  const full = qnc.toFixed(9).replace(/0+$/, '').replace(/\.$/, '');
  return full + ' QNC';
}

// Map transaction type to display string
// v2.95.3: Unified heartbeat types, removed "Validator" category
// v3.15: Claims from system_rewards_pool show as Transfer
function mapTxType(type: string, fromAddress?: string): string {
  // Claim rewards from pool = Transfer (not Reward)
  if (fromAddress === 'system_rewards_pool') {
    return 'Transfer';
  }
  
  const normalized = type.toLowerCase().replace(/_/g, '');
  
  const map: Record<string, string> = {
    // User transactions
    'transfer': 'Transfer',
    'batchtransfers': 'Transfer',
    'swap': 'Swap',
    
    // Node lifecycle
    'nodeactivation': 'Activation',
    'batchnodeactivations': 'Activation',
    'noderegistration': 'Registration',
    'registration': 'Registration',
    
    // Rewards
    'rewarddistribution': 'Reward',
    'batchrewardclaims': 'Reward',
    'systemreward': 'Reward',
    'systemrewards': 'Reward',
    'systememission': 'Reward',
    'emission': 'Reward',
    'reward': 'Reward',
    
    // Heartbeat (ALL node activity attestations)
    'heartbeatcommitment': 'Heartbeat',           // Full/Super nodes
    'pingcommitmentwithsampling': 'Heartbeat',    // Light nodes (legacy)
    'lightnodeeligibilitybitmap': 'Heartbeat',    // Light nodes (bitmap) — Rust Serde name
    'bitmapcommitment': 'Heartbeat',              // Light nodes (bitmap) — API string name
    'pingattestation': 'Heartbeat',               // Legacy ping
    
    // Smart Contracts
    'contractdeploy': 'Contract',
    'contractcall': 'Contract',
    
    // System
    'createaccount': 'System',
    'system': 'System',
  };
  
  return map[normalized] || 'Other';
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
      displayTypes = typesParam.split(',').filter(t => /^[a-zA-Z]+$/.test(t.trim())).map(t => t.trim());
      if (displayTypes.length === 0) displayTypes = undefined;
    }

    // Get transactions from PostgreSQL
    const { transactions, total, currentHeight } = await getTransactions(page, perPage, sortOrder, typeFilter, displayTypes);

    // Map to response format - return ALL fields
    // Note: perPage is already validated to max 500, so we use all transactions
    const responseData = transactions.map((tx) => ({
      hash: tx.hash,
      type: mapTxType(tx.tx_type, tx.from_address),
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
      /* log disabled */
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
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
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
