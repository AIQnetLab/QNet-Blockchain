import { NextRequest, NextResponse } from 'next/server';

// QNet Backend API URL
const QNET_API_URL = process.env.QNET_API_URL || 'http://localhost:8000';

export interface ActivityItem {
  hash: string;
  type: 'Transfer' | 'Node Activation' | 'Swap' | 'Reward' | 'Smart Contract' | 'Block';
  from: string;
  to: string;
  amount: string;
  block: number;
  time: string;
  timestamp: number;
}

// Fetch latest activity from QNet backend
async function fetchActivityFromBackend(limit: number): Promise<ActivityItem[] | null> {
  try {
    // Try mempool transactions first (shows pending/recent)
    const mempoolRes = await fetch(`${QNET_API_URL}/api/v1/mempool/transactions`, {
      headers: { 'Content-Type': 'application/json' },
      next: { revalidate: 3 },
    });
    
    if (mempoolRes.ok) {
      const data = await mempoolRes.json();
      const transactions = data.transactions || data.data || [];
      
      if (transactions.length > 0) {
        return transactions.slice(0, limit).map((tx: any) => ({
          hash: tx.hash || tx.id,
          type: mapTxType(tx.type || tx.tx_type),
          from: tx.from || tx.sender,
          to: tx.to || tx.recipient,
          amount: formatAmount(tx.amount),
          block: tx.block_height || tx.block || 0,
          time: formatTimeAgo(tx.timestamp || Date.now()),
          timestamp: tx.timestamp || Date.now(),
        }));
      }
    }
    
    return null;
  } catch {
    return null;
  }
}

function mapTxType(type: string | object): ActivityItem['type'] {
  // Handle Rust enum serialization - can be string or object like { "Transfer": {...} }
  const typeStr = typeof type === 'object' ? Object.keys(type)[0] : type;
  
  const map: Record<string, ActivityItem['type']> = {
    // Exact matches from Rust TransactionType enum
    'Transfer': 'Transfer',
    'NodeActivation': 'Node Activation',
    'Swap': 'Swap',
    'RewardDistribution': 'Reward',
    'ContractDeploy': 'Smart Contract',
    'ContractCall': 'Smart Contract',
    'CreateAccount': 'Transfer',
    'BatchRewardClaims': 'Reward',
    'BatchNodeActivations': 'Node Activation',
    'BatchTransfers': 'Transfer',
    'PingAttestation': 'Transfer',
    'PingCommitmentWithSampling': 'Transfer',
    // Legacy/alternate formats
    'SEND': 'Transfer',
    'send': 'Transfer',
    'transfer': 'Transfer',
    'SWAP': 'Swap',
    'swap': 'Swap',
    'NODE_ACTIVATION': 'Node Activation',
    'node_activation': 'Node Activation',
    'REWARD': 'Reward',
    'reward': 'Reward',
    'SMART_CONTRACT': 'Smart Contract',
    'smart_contract': 'Smart Contract',
  };
  return map[typeStr] || 'Transfer';
}

function formatAmount(amount: any): string {
  if (!amount) return '0 QNC';
  const num = typeof amount === 'string' ? parseFloat(amount) : amount;
  if (num >= 1e9) {
    return (num / 1e9).toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' QNC';
  }
  return num.toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' QNC';
}

function formatTimeAgo(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const limit = parseInt(searchParams.get('limit') || '50', 10);
  
  // Try backend first
  const activity = await fetchActivityFromBackend(limit);
  
  // Return real data only, or empty array if backend unavailable
  return NextResponse.json({
    success: true,
    data: activity || [],
  });
}

