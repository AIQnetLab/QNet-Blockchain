import { NextRequest, NextResponse } from 'next/server';

// QNet Backend API URL
const QNET_API_URL = process.env.QNET_API_URL || 'http://localhost:8000';

// Disable caching for real-time activity data
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export interface ActivityItem {
  hash: string;
  type: 'Transfer' | 'Node Activation' | 'Swap' | 'Reward' | 'Smart Contract' | 'Block' | 'System';
  from: string;
  to: string;
  amount: string;
  block: number;
  time: string;
  timestamp: number;
}

// Fetch transactions from recent blocks
async function fetchBlockTransactions(limit: number): Promise<ActivityItem[]> {
  const activity: ActivityItem[] = [];
  
  try {
    // Get current height
    const heightRes = await fetch(`${QNET_API_URL}/api/v1/height`, {
      cache: 'no-store',
    });
    
    if (!heightRes.ok) return activity;
    
    const heightData = await heightRes.json();
    const currentHeight = heightData.height || 0;
    
    // Fetch last 20 blocks to find transactions
    const blocksToCheck = Math.min(20, currentHeight);
    
    for (let i = 0; i < blocksToCheck && activity.length < limit; i++) {
      const blockHeight = currentHeight - i;
      if (blockHeight < 0) break;
      
      try {
        const blockRes = await fetch(`${QNET_API_URL}/api/v1/block/${blockHeight}`, {
          cache: 'no-store',
        });
        
        if (blockRes.ok) {
          const block = await blockRes.json();
          const transactions = block.transactions || block.txs || [];
          
          for (const tx of transactions) {
            if (activity.length >= limit) break;
            
            // Detect system/emission transactions
            const isSystemTx = tx.from?.startsWith('system_') || 
                               tx.to === 'system_rewards_pool' ||
                               tx.tx_type === 'RewardDistribution' ||
                               tx.type === 'RewardDistribution';
            
            activity.push({
              hash: tx.hash || tx.id || `block_${blockHeight}_tx_${activity.length}`,
              type: isSystemTx ? 'Reward' : mapTxType(tx.type || tx.tx_type),
              from: tx.from || tx.sender || 'system_emission',
              to: tx.to || tx.recipient || 'system_rewards_pool',
              amount: formatAmount(tx.amount),
              block: blockHeight,
              time: formatTimeAgo(tx.timestamp || block.timestamp || Date.now()),
              timestamp: tx.timestamp || block.timestamp || Date.now(),
            });
          }
        }
      } catch {
        // Skip failed block fetch
      }
    }
  } catch {
    // Return what we have
  }
  
  return activity;
}

// Fetch latest activity from QNet backend (mempool)
async function fetchActivityFromBackend(limit: number): Promise<ActivityItem[] | null> {
  try {
    // Try mempool transactions first (shows pending/recent)
    const mempoolRes = await fetch(`${QNET_API_URL}/api/v1/mempool/transactions`, {
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
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
    // System transactions
    'SystemEmission': 'Reward',
    'Emission': 'Reward',
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
  // Amount is in smallest units (like wei), convert to QNC (divide by 1e9)
  const qnc = num / 1e9;
  if (qnc >= 1000000) {
    return (qnc / 1000000).toLocaleString('en-US', { maximumFractionDigits: 2 }) + 'M QNC';
  }
  if (qnc >= 1000) {
    return (qnc / 1000).toLocaleString('en-US', { maximumFractionDigits: 2 }) + 'K QNC';
  }
  return qnc.toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' QNC';
}

function formatTimeAgo(timestamp: number): string {
  const now = Date.now();
  // Handle both seconds and milliseconds timestamps
  const ts = timestamp > 1e12 ? timestamp : timestamp * 1000;
  const diff = now - ts;
  
  if (diff < 0) return 'just now';
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const limit = parseInt(searchParams.get('limit') || '50', 10);
  
  // Try mempool first
  const mempoolActivity = await fetchActivityFromBackend(limit);
  
  // Also fetch from recent blocks (includes system transactions)
  const blockActivity = await fetchBlockTransactions(limit);
  
  // Merge and deduplicate by hash
  const allActivity: ActivityItem[] = [];
  const seenHashes = new Set<string>();
  
  // Add mempool transactions first (pending)
  if (mempoolActivity) {
    for (const item of mempoolActivity) {
      if (!seenHashes.has(item.hash)) {
        seenHashes.add(item.hash);
        allActivity.push(item);
      }
    }
  }
  
  // Add block transactions
  for (const item of blockActivity) {
    if (!seenHashes.has(item.hash)) {
      seenHashes.add(item.hash);
      allActivity.push(item);
    }
  }
  
  // Sort by timestamp (newest first)
  allActivity.sort((a, b) => b.timestamp - a.timestamp);
  
  // Return limited results
  return NextResponse.json({
    success: true,
    data: allActivity.slice(0, limit),
  });
}
