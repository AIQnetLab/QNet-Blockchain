import { NextRequest, NextResponse } from 'next/server';
import { getTransactionsByAddress } from '../../../../../lib/db';

// ============================================================================
// PRODUCTION v3.0: PostgreSQL-based address data
// ============================================================================

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

// Format amount from nanoQNC to QNC
function formatAmount(amount: number): string {
  if (!amount) return '0.00 QNC';
  const qnc = amount / 1e9;
  // v3.0: Show FULL numbers with thousand separators (like Etherscan)
  return qnc.toLocaleString('en-US', { 
    minimumFractionDigits: 2, 
    maximumFractionDigits: 2 
  }) + ' QNC';
}

// Map transaction type to display string
function mapTxType(type: string): string {
  if (!type) return 'Transfer';
  const normalized = type.toLowerCase().replace(/_/g, '').replace(/-/g, '');
  
  const map: Record<string, string> = {
    'transfer': 'Transfer',
    'nodeactivation': 'Node Activation',
    'noderegistration': 'Registration',
    'swap': 'Swap',
    'rewarddistribution': 'Reward',
    'contractdeploy': 'Smart Contract',
    'contractcall': 'Smart Contract',
    'registration': 'Registration',
    'reward': 'Reward',
  };
  
  if (map[normalized]) return map[normalized];
  if (normalized.includes('reward') || normalized.includes('emission')) return 'Reward';
  return 'Transfer';
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
  
  try {
    // Fetch transactions from PostgreSQL
    const { transactions, total } = await getTransactionsByAddress(address, 1, 100);
    
    // Calculate balance, first seen, last active from transactions
    let balance = 0;
    let firstSeen = 0;
    let lastActive = 0;
    
    if (transactions.length > 0) {
      // Calculate balance (simplified: sum of received - sum of sent)
      for (const tx of transactions) {
        if (tx.to_address === address) {
          balance += tx.amount;
        } else if (tx.from_address === address) {
          balance -= tx.amount;
        }
        
        // Track timestamps (handle both seconds and milliseconds)
        // Convert to milliseconds for comparison if needed
        let txTsMs = tx.timestamp;
        if (txTsMs > 0 && txTsMs < 1e12) {
          txTsMs = txTsMs * 1000; // Convert seconds to milliseconds
        }
        
        // Only use valid timestamps (after 2000-01-01)
        if (txTsMs > 946684800000) { // After 2000-01-01 in milliseconds
          // Use milliseconds format for firstSeen and lastActive
          if (firstSeen === 0 || txTsMs < firstSeen) {
            firstSeen = txTsMs;
          }
          if (txTsMs > lastActive) {
            lastActive = txTsMs;
          }
        }
      }
    }
    
    // Map transactions to response format
    const txData = transactions.map(tx => ({
      hash: tx.hash,
      type: mapTxType(tx.tx_type),
      from: tx.from_address,
      to: tx.to_address || 'N/A',
      amount: formatAmount(tx.amount),
      // Convert timestamp to milliseconds if needed, and ensure it's valid
      timestamp: (() => {
        let ts = tx.timestamp;
        if (ts > 0 && ts < 1e12) {
          ts = ts * 1000; // Convert seconds to milliseconds
        }
        // Only return valid timestamps (after 2000-01-01)
        return ts > 946684800000 ? ts : 0;
      })(),
      block: tx.block,
      status: tx.status || 'confirmed',
    }));
    
    return NextResponse.json({
      success: true,
      source: 'postgresql',
      data: {
        address,
        balance: formatAmount(balance),
        txCount: total,
        firstSeen: firstSeen, // Already validated in loop (after 2000-01-01 in ms)
        lastActive: lastActive, // Already validated in loop (after 2000-01-01 in ms)
        tokens: [],
        transactions: txData,
      },
    });
  } catch {
    return NextResponse.json({
      success: false,
      error: err instanceof Error ? err.message : 'Database error',
      data: {
        address,
        balance: '0',
        txCount: 0,
        firstSeen: 0,
        lastActive: 0,
        tokens: [],
        transactions: [],
      },
    }, { status: 500 });
  }
}
