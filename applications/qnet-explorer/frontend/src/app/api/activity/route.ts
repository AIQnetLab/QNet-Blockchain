import { NextRequest, NextResponse } from 'next/server';

// ============================================================================
// PRODUCTION v2.74: Direct Node RPC with RocksDB
// ============================================================================

// Node RPC URL (direct blockchain access via RocksDB)
const NODE_RPC_URL = process.env.QNET_API_URL || 'http://localhost:8001';

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

// Fetch transactions from Node RPC (RocksDB indexed)
async function fetchActivity(limit: number): Promise<ActivityItem[]> {
  const activity: ActivityItem[] = [];
  
  try {
    // Get current height
    const heightRes = await fetch(`${NODE_RPC_URL}/api/v1/height`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    
    if (!heightRes.ok) return activity;
    
    const heightData = await heightRes.json();
    const currentHeight = heightData.height || 0;
    
    // Fetch last 20 blocks in parallel (fast with RocksDB)
    const blocksToFetch = Math.min(20, currentHeight);
    const blockHeights = Array.from({ length: blocksToFetch }, (_, i) => currentHeight - i);
    
    const blockPromises = blockHeights.map(async (height) => {
      try {
        const res = await fetch(`${NODE_RPC_URL}/api/v1/block/${height}`, {
          cache: 'no-store',
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return null;
        return { height, block: await res.json() };
      } catch {
        return null;
      }
    });
    
    const blockResults = await Promise.all(blockPromises);
    
    for (const result of blockResults) {
      if (!result || activity.length >= limit) continue;
      
      const { height, block } = result;
      const transactions = block.transactions || [];
      
      for (const tx of transactions) {
        if (activity.length >= limit) break;
        
        activity.push({
          hash: tx.hash || `tx_${height}_${activity.length}`,
          type: mapTxType(tx.tx_type || tx.type),
          from: tx.from || 'unknown',
          to: tx.to || 'N/A',
          amount: formatAmount(tx.amount),
          block: height,
          time: formatTimeAgo(tx.timestamp || block.timestamp),
          timestamp: tx.timestamp || block.timestamp || Date.now() / 1000,
        });
      }
    }
    
    // Also check emission blocks for reward transactions
    const emissionBlocks = [14400, 28800, 43200].filter(h => h <= currentHeight);
    for (const emissionHeight of emissionBlocks) {
      if (activity.length >= limit) break;
      if (blockHeights.includes(emissionHeight)) continue; // Already fetched
      
      try {
        const res = await fetch(`${NODE_RPC_URL}/api/v1/block/${emissionHeight}`, {
          cache: 'no-store',
          signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) continue;
        
        const block = await res.json();
        const transactions = block.transactions || [];
        
        for (const tx of transactions) {
          if (activity.length >= limit) break;
          
          activity.push({
            hash: tx.hash || `emission_${emissionHeight}`,
            type: 'Reward',
            from: tx.from || 'system_emission',
            to: tx.to || 'system_rewards_pool',
            amount: formatAmount(tx.amount),
            block: emissionHeight,
            time: formatTimeAgo(tx.timestamp || block.timestamp),
            timestamp: tx.timestamp || block.timestamp || Date.now() / 1000,
          });
        }
      } catch {
        // Skip failed emission block fetch
      }
    }
  } catch (e) {
    console.error('[API] Node RPC error:', e);
  }
  
  return activity;
}

function mapTxType(type: string | object): ActivityItem['type'] {
  const typeStr = typeof type === 'object' ? Object.keys(type)[0] : (type || 'Transfer');
  
  const map: Record<string, ActivityItem['type']> = {
    'Transfer': 'Transfer',
    'NodeActivation': 'Node Activation',
    'NodeRegistration': 'System',
    'Swap': 'Swap',
    'RewardDistribution': 'Reward',
    'ContractDeploy': 'Smart Contract',
    'ContractCall': 'Smart Contract',
    'BatchTransfers': 'Transfer',
    'BatchNodeActivations': 'Node Activation',
    'BatchRewardClaims': 'Reward',
    'PingAttestation': 'System',
    'PingCommitmentWithSampling': 'System',
    'SystemEmission': 'Reward',
    'Emission': 'Reward',
  };
  return map[typeStr] || 'Transfer';
}

function formatAmount(amount: any): string {
  if (!amount) return '0 QNC';
  const num = typeof amount === 'string' ? parseFloat(amount) : amount;
  const qnc = num / 1e9;
  if (qnc >= 1_000_000) return (qnc / 1_000_000).toFixed(2) + 'M QNC';
  if (qnc >= 1_000) return (qnc / 1_000).toFixed(2) + 'K QNC';
  return qnc.toFixed(2) + ' QNC';
}

function formatTimeAgo(timestamp: number): string {
  const now = Date.now();
  const ts = timestamp > 1e12 ? timestamp : timestamp * 1000;
  const diff = now - ts;
  
  if (diff < 0) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const limit = parseInt(searchParams.get('limit') || '50', 10);
  
  const activity = await fetchActivity(limit);
  
  return NextResponse.json({
    success: true,
    source: 'rocksdb',
    data: activity.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit),
  });
}
