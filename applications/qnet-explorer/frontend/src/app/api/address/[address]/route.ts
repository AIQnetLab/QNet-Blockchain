import { NextRequest, NextResponse } from 'next/server';

// QNet Backend API URL
const QNET_API_URL = process.env.QNET_API_URL || 'http://localhost:8000';

export interface AddressData {
  address: string;
  balance: string;
  txCount: number;
  firstSeen: number;
  lastActive: number;
  nodeInfo?: {
    nodeId: string;
    nodeType: 'SUPER' | 'FULL' | 'LIGHT';
    reputation: number;
    activatedAt: number;
    isActive: boolean;
  };
  tokens: Array<{
    symbol: string;
    balance: string;
  }>;
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

// Fetch address from backend
async function fetchAddressFromBackend(address: string): Promise<AddressData | null> {
  try {
    const response = await fetch(`${QNET_API_URL}/api/v1/account/${address}`, {
      headers: { 'Content-Type': 'application/json' },
      next: { revalidate: 10 },
    });
    
    if (!response.ok) return null;
    
    const data = await response.json();
    return data.data || data;
  } catch {
    return null;
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ address: string }> }
) {
  const { address } = await params;
  
  // Validate EON address format (41 chars with 'eon' in middle)
  if (!address || address.length !== 41 || !address.includes('eon')) {
    return NextResponse.json(
      { success: false, error: 'Invalid EON address format' },
      { status: 400 }
    );
  }
  
  // Fetch from backend only
  const data = await fetchAddressFromBackend(address);
  
  if (!data) {
    return NextResponse.json({
      success: false,
      error: 'Address not found or backend unavailable',
    }, { status: 404 });
  }
  
  return NextResponse.json({
    success: true,
    data,
  });
}

