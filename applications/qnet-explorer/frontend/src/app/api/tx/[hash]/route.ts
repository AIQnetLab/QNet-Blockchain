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

// Map Rust TransactionType enum to display string
function mapTxType(type: string | object | undefined): string {
  if (!type) return 'Transfer';
  const typeStr = typeof type === 'object' ? Object.keys(type)[0] : type;
  
  const map: Record<string, string> = {
    'Transfer': 'SEND',
    'NodeActivation': 'NODE_ACTIVATION',
    'NodeRegistration': 'REGISTRATION',
    'Swap': 'SWAP',
    'RewardDistribution': 'REWARD',
    'ContractDeploy': 'CONTRACT_DEPLOY',
    'ContractCall': 'CONTRACT_CALL',
    'CreateAccount': 'CREATE_ACCOUNT',
    'BatchRewardClaims': 'BATCH_REWARD',
    'BatchNodeActivations': 'BATCH_ACTIVATION',
    'BatchTransfers': 'BATCH_TRANSFER',
    'PingAttestation': 'PING',
    'PingCommitmentWithSampling': 'PING_COMMITMENT',
  };
  return map[typeStr] || 'SEND';
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

// Fetch from Indexer (primary - O(1) SQL query)
async function fetchFromIndexer(hash: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${INDEXER_API_URL}/api/v1/transactions/${hash}`, {
      headers: getIndexerHeaders(),
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Fetch from Node RPC (fallback)
async function fetchFromNodeRPC(hash: string): Promise<Record<string, unknown> | null> {
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
    // 1. Try Indexer first (fast SQL query)
    let tx = await fetchFromIndexer(hash);
    let source = 'indexer';
    
    // 2. Fallback to Node RPC
    if (!tx) {
      console.warn('[TX] Indexer miss, falling back to Node RPC');
      tx = await fetchFromNodeRPC(hash);
      source = 'node_rpc';
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
      source,
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
