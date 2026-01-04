import { NextRequest, NextResponse } from 'next/server';

// ============================================================================
// PRODUCTION v2.74: Direct Node RPC with RocksDB
// ============================================================================

// Node RPC (direct blockchain access via RocksDB)
const NODE_RPC_URL = process.env.QNET_API_URL || 'http://localhost:8001';

// Map Rust TransactionType enum to display string
function mapTxType(type: string | object | undefined): string {
  if (!type) return 'Transfer';
  const typeStr = typeof type === 'object' ? Object.keys(type)[0] : type;
  
  const map: Record<string, string> = {
    'Transfer': 'Transfer',
    'NodeActivation': 'Node Activation',
    'NodeRegistration': 'Registration',
    'Swap': 'Swap',
    'RewardDistribution': 'Reward',
    'ContractDeploy': 'Smart Contract',
    'ContractCall': 'Smart Contract',
    'CreateAccount': 'System',
    'BatchRewardClaims': 'Reward',
    'BatchNodeActivations': 'Node Activation',
    'BatchTransfers': 'Transfer',
    'PingAttestation': 'System',
    'PingCommitmentWithSampling': 'System',
  };
  return map[typeStr] || 'Transfer';
}

// Format amount from nanoQNC to QNC
function formatAmount(amount: number | string | undefined): string {
  if (!amount) return '0 QNC';
  const num = typeof amount === 'string' ? parseFloat(amount) : amount;
  if (num >= 1e9) {
    return (num / 1e9).toLocaleString('en-US', { maximumFractionDigits: 6 }) + ' QNC';
  }
  return num.toLocaleString('en-US', { maximumFractionDigits: 6 }) + ' QNC';
}

// Fetch TX from Node RPC (tx_index in RocksDB)
async function fetchTransaction(hash: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${NODE_RPC_URL}/api/v1/transaction/${hash}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
    
    if (!res.ok) return null;
    
    const data = await res.json();
    if (data.status === 'found' && data.transaction) {
      return data.transaction;
    }
    return null;
  } catch {
    return null;
  }
}

// Fallback: Search in emission blocks if TX not in index
async function searchInEmissionBlocks(hash: string): Promise<Record<string, unknown> | null> {
  const emissionBlocks = [14400, 28800, 43200, 57600, 72000];
  
  for (const height of emissionBlocks) {
    try {
      const res = await fetch(`${NODE_RPC_URL}/api/v1/block/${height}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(3000),
      });
      
      if (!res.ok) continue;
      
      const block = await res.json();
      const transactions = block.transactions || [];
      
      for (const tx of transactions) {
        if (tx.hash === hash) {
          return { ...tx, block_height: height, timestamp: tx.timestamp || block.timestamp };
        }
      }
    } catch {
      // Skip failed block fetch
    }
  }
  
  return null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ hash: string }> }
) {
  const { hash } = await params;
  
  if (!hash) {
    return NextResponse.json({
      success: false,
      error: 'Transaction hash required',
    }, { status: 400 });
  }
  
  try {
    // 1. Try tx_index (RocksDB)
    let tx = await fetchTransaction(hash);
    
    // 2. Fallback: Search in emission blocks
    if (!tx) {
      tx = await searchInEmissionBlocks(hash);
    }
    
    if (!tx) {
      return NextResponse.json({
        success: false,
        error: 'Transaction not found',
      }, { status: 404 });
    }
    
    // Normalize timestamp to ms
    const rawTs = (tx.timestamp as number) || 0;
    const ts = rawTs > 1e12 ? rawTs : rawTs * 1000;
    
    // Determine if system TX
    const from = (tx.from_address || tx.from || 'unknown') as string;
    const isSystemTx = from.startsWith('system_');
    
    return NextResponse.json({
      success: true,
      source: 'rocksdb',
      data: {
        hash: tx.hash as string,
        type: mapTxType((tx.tx_type || tx.type) as string),
        status: (tx.status as string) || 'confirmed',
        block: (tx.block_height || tx.block || 0) as number,
        timestamp: ts,
        from,
        to: (tx.to_address || tx.to || 'N/A') as string,
        amount: formatAmount(tx.amount as number),
        fee: isSystemTx ? '0 QNC' : formatAmount(tx.gas_price as number),
        nonce: tx.nonce as number | undefined,
        signature_type: isSystemTx 
          ? 'System TX' 
          : (tx.dilithium_signature ? 'Ed25519 + Dilithium3' : 'Ed25519'),
        is_quantum_signed: !!(tx.dilithium_signature || tx.is_quantum_signed),
      },
    });
    
  } catch (err) {
    console.error('[TX] Error:', err);
    return NextResponse.json({
      success: false,
      error: 'Backend unavailable',
    }, { status: 503 });
  }
}
