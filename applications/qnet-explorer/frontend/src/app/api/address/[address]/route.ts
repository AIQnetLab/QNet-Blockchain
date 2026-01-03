import { NextRequest, NextResponse } from 'next/server';

// ============================================================================
// PRODUCTION v2.72: Use PostgreSQL Indexer with Node RPC fallback
// ============================================================================

// Indexer API (primary - fast SQL queries)
const INDEXER_API_URL = process.env.INDEXER_API_URL || 'http://localhost:9000';
const INDEXER_API_KEY = process.env.INDEXER_API_KEY || '';

// Node RPC (fallback - direct blockchain access)
const NODE_RPC_URL = process.env.QNET_API_URL || 'http://localhost:8001';

// Helper: Get headers for Indexer requests
function getIndexerHeaders(): HeadersInit {
  const headers: HeadersInit = { 'Content-Type': 'application/json' };
  if (INDEXER_API_KEY) {
    headers['X-API-Key'] = INDEXER_API_KEY;
  }
  return headers;
}

// System addresses
const SYSTEM_ADDRESSES = ['system_rewards_pool', 'system_emission', 'genesis'];

export interface AddressData {
  address: string;
  balance: string;
  txCount: number;
  firstSeen: number;
  lastActive: number;
  isSystem?: boolean;
  nodeInfo?: {
    nodeId: string;
    nodeType: 'SUPER' | 'FULL' | 'LIGHT';
    reputation: number;
    activatedAt: number;
    isActive: boolean;
  };
  tokens: Array<{ symbol: string; balance: string }>;
  transactions: Array<{
    hash: string;
    type: string;
    from: string;
    to: string;
    amount: string;
    fee?: string;
    timestamp: number;
    block: number;
    status: 'confirmed' | 'pending';
  }>;
}

// Fetch from Indexer (primary)
async function fetchFromIndexer(address: string): Promise<AddressData | null> {
  try {
    const res = await fetch(`${INDEXER_API_URL}/api/v1/addresses/${address}`, {
      headers: getIndexerHeaders(),
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    
    if (!res.ok) return null;
    
    const data = await res.json();
    
    // Transform indexer response to AddressData
    return {
      address: data.address,
      balance: data.balance || '0',
      txCount: data.tx_count || 0,
      firstSeen: data.first_seen || 0,
      lastActive: data.last_active || 0,
      tokens: [],
      transactions: (data.transactions || []).map((tx: Record<string, unknown>) => ({
        hash: tx.hash as string,
        type: tx.tx_type as string,
        from: tx.from_address as string,
        to: (tx.to_address || 'N/A') as string,
        amount: formatAmount(tx.amount as number),
        fee: formatAmount(tx.gas_price as number),
        timestamp: tx.timestamp as number,
        block: tx.block_height as number,
        status: 'confirmed' as const,
      })),
    };
  } catch {
    return null;
  }
}

// Fetch from Node RPC (fallback)
async function fetchFromNodeRPC(address: string): Promise<AddressData | null> {
  try {
    const res = await fetch(`${NODE_RPC_URL}/api/v1/account/${address}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
    
    if (!res.ok) return null;
    const data = await res.json();
    return data.data || data;
  } catch {
    return null;
  }
}

// Format amount
function formatAmount(amount: number | undefined): string {
  if (!amount) return '0';
  return (amount / 1e9).toFixed(6) + ' QNC';
}

// Create system address data
function createSystemAddressData(address: string): AddressData {
  const now = Date.now();
  return {
    address,
    balance: '∞',
    txCount: 0,
    firstSeen: now,
    lastActive: now,
    isSystem: true,
    tokens: [],
    transactions: [],
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ address: string }> }
) {
  const { address } = await params;
  
  if (!address) {
    return NextResponse.json({ success: false, error: 'Address required' }, { status: 400 });
  }
  
  // System addresses
  const isSystem = SYSTEM_ADDRESSES.includes(address) || address.startsWith('system_');
  if (isSystem) {
    return NextResponse.json({
      success: true,
      source: 'system',
      data: createSystemAddressData(address),
    });
  }
  
  // Validate EON address format
  const isValidEon = address.length >= 38 && address.includes('eon');
  if (!isValidEon) {
    return NextResponse.json({ success: false, error: 'Invalid EON address' }, { status: 400 });
  }
  
  // 1. Try Indexer first
  let data = await fetchFromIndexer(address);
  let source = 'indexer';
  
  // 2. Fallback to Node RPC
  if (!data) {
    console.warn('[ADDR] Indexer miss, falling back to Node RPC');
    data = await fetchFromNodeRPC(address);
    source = 'node_rpc';
  }
  
  if (!data) {
    // Return empty address (may exist but have no transactions)
    return NextResponse.json({
      success: true,
      source: 'empty',
      data: {
        address,
        balance: '0',
        txCount: 0,
        firstSeen: 0,
        lastActive: 0,
        tokens: [],
        transactions: [],
      },
    });
  }
  
  return NextResponse.json({
    success: true,
    source,
    data,
  });
}
