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
    nodeType: 'SUPER' | 'LIGHT';  // v3.18: FULL removed
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
// v3.52: Full precision, no zero-padding — 1,234.56 not 1,234.56000
function formatAmount(amount: number | string): string {
  const numAmount = Number(amount);
  if (!numAmount || !Number.isFinite(numAmount)) return '0 QNC';
  const qnc = numAmount / 1e9;
  
  // Up to 9 decimals (nanoQNC precision), trim trailing zeros
  const fixed = qnc.toFixed(9);
  const trimmed = fixed.replace(/\.?0+$/, '');
  
  // Add thousand separators to integer part
  const [intPart, decPart] = trimmed.split('.');
  const intFormatted = Number(intPart).toLocaleString('en-US');
  return decPart ? intFormatted + '.' + decPart + ' QNC' : intFormatted + ' QNC';
}

// Map transaction type to display string
// v3.15: Claims from system_rewards_pool show as Transfer
function mapTxType(type: string, fromAddress?: string): string {
  if (!type) return 'Transfer';
  
  // Claim rewards from pool = Transfer (not Reward)
  if (fromAddress === 'system_rewards_pool') {
    return 'Transfer';
  }
  
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
    'heartbeatcommitment': 'Heartbeat',
    'heartbeat': 'Heartbeat',
    'lightnodeeligibilitybitmap': 'Heartbeat',
    'bitmapcommitment': 'Heartbeat',
    'pingcommitmentwithsampling': 'System',
    'pingattestation': 'System',
  };
  
  if (map[normalized]) return map[normalized];
  if (normalized.includes('heartbeat') || normalized.includes('bitmap')) return 'Heartbeat';
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
    // v3.50: Fetch REAL balance from node API (single source of truth)
    // Previous approach: calculating balance from TX history was WRONG because:
    // 1. PostgreSQL BIGINT → JS string → "balance += string" = string concatenation → -Infinity
    // 2. Failed TXs (e.g. duplicate reward claims) are in blocks but didn't change state
    // 3. Gas fees not accounted for properly
    // NOW: Use node API for balance, PostgreSQL only for TX history
    const NODE_API = process.env.QNET_API_URL || 'https://162.244.25.114:8001';
    const API_KEY = process.env.QNET_API_KEY || '';
    const nodeHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
    if (API_KEY) nodeHeaders['X-API-Key'] = API_KEY;
    
    // Parallel: fetch balance from node + TX history from PostgreSQL
    const [accountResponse, txResult] = await Promise.all([
      fetch(`${NODE_API}/api/v1/account/${address}`, {
        headers: nodeHeaders,
        signal: AbortSignal.timeout(10000),
      }).then(r => r.ok ? r.json() : null).catch(() => null),
      getTransactionsByAddress(address, 1, 100),
    ]);
    
    const { transactions, total } = txResult;
    
    // Balance from node (nanoQNC) — authoritative source
    let balance = 0;
    if (accountResponse && typeof accountResponse.balance === 'number') {
      balance = accountResponse.balance;
    } else if (accountResponse && accountResponse.balance) {
      balance = Number(accountResponse.balance) || 0;
    }
    
    // Calculate first seen, last active from transactions
    let firstSeen = 0;
    let lastActive = 0;
    
    if (transactions.length > 0) {
      for (const tx of transactions) {
        // Track timestamps (handle both seconds and milliseconds)
        let txTsMs = Number(tx.timestamp) || 0;
        if (txTsMs > 0 && txTsMs < 1e12) {
          txTsMs = txTsMs * 1000; // Convert seconds to milliseconds
        }
        
        // Only use valid timestamps (after 2000-01-01)
        if (txTsMs > 946684800000) {
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
      type: mapTxType(tx.tx_type, tx.from_address),
      from: tx.from_address,
      to: tx.to_address || 'N/A',
      amount: formatAmount(Number(tx.amount) || 0),
      // Convert timestamp to milliseconds if needed, and ensure it's valid
      timestamp: (() => {
        let ts = Number(tx.timestamp) || 0;
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
      source: 'node+postgresql',
      data: {
        address,
        balance: formatAmount(balance),
        txCount: total,
        firstSeen: firstSeen,
        lastActive: lastActive,
        tokens: [],
        transactions: txData,
      },
    });
  } catch (err) {
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
