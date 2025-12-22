import { NextRequest, NextResponse } from 'next/server';

// QNet Backend API URL
const QNET_API_URL = process.env.QNET_API_URL || 'http://localhost:8000';

// Map Rust TransactionType enum to display string
function mapTxType(type: string | object | undefined): string {
  if (!type) return 'Transfer';
  const typeStr = typeof type === 'object' ? Object.keys(type)[0] : type;
  
  const map: Record<string, string> = {
    'Transfer': 'SEND',
    'NodeActivation': 'NODE_ACTIVATION',
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

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ hash: string }> }
) {
  const { hash } = await params;
  
  if (!hash || hash.length !== 64) {
    return NextResponse.json({
      success: false,
      error: 'Invalid transaction hash',
    }, { status: 400 });
  }
  
  try {
    const res = await fetch(`${QNET_API_URL}/api/v1/transaction/${hash}`, {
      headers: { 'Content-Type': 'application/json' },
      next: { revalidate: 10 },
    });
    
    if (res.ok) {
      const data = await res.json();
      
      // Backend returns { tx_hash, transaction, status }
      if (data.status === 'found' && data.transaction) {
        return NextResponse.json({
          success: true,
          data: {
            hash: data.transaction.hash,
            type: mapTxType(data.transaction.tx_type),
            status: data.transaction.status === 'confirmed' ? 'confirmed' : 'pending',
            block: data.transaction.block_height || 0,
            timestamp: data.transaction.timestamp,
            from: data.transaction.from,
            to: data.transaction.to,
            amount: formatAmount(data.transaction.amount),
            fee: formatAmount(data.transaction.effective_gas_cost || 0),
            nonce: data.transaction.nonce,
            signature_type: data.transaction.signature_type,
          },
        });
      }
      
      return NextResponse.json({
        success: false,
        error: 'Transaction not found',
      }, { status: 404 });
    }
    
    return NextResponse.json({
      success: false,
      error: 'Transaction not found or backend unavailable',
    }, { status: 404 });
    
  } catch {
    return NextResponse.json({
      success: false,
      error: 'Transaction not found or backend unavailable',
    }, { status: 404 });
  }
}

