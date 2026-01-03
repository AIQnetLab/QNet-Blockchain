import { NextRequest, NextResponse } from 'next/server';

// ============================================================================
// PRODUCTION v2.74: Direct Node RPC with RocksDB
// ============================================================================

// Node RPC (direct blockchain access via RocksDB)
const NODE_RPC_URL = process.env.QNET_API_URL || 'http://localhost:8001';

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

// Fetch address data from Node RPC
async function fetchAddressData(address: string): Promise<AddressData | null> {
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
  
  // Fetch from Node RPC
  const data = await fetchAddressData(address);
  
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
    source: 'rocksdb',
    data,
  });
}
