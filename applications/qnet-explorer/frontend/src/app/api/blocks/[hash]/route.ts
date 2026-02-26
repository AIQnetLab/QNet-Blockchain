import { NextRequest, NextResponse } from 'next/server';
import { getBlockByHeight, getBlockByHash, getTransactionsByBlock, BlockRow } from '../../../../../lib/db';
import type { Block, BlockTransaction } from '@/lib/types';

// ============================================================================
// PRODUCTION v2.97: PostgreSQL-first with Node RPC fallback
// ============================================================================

// Node RPC (fallback for real-time data)
const NODE_RPC_URL = process.env.QNET_API_URL || 'https://162.244.25.114:8001';

// Map transaction type to display name
// v3.15: Claims from system_rewards_pool show as Transfer
function getTransactionType(txType: unknown, fromAddress?: string): string {
  if (!txType) return 'Unknown';
  
  // Claim rewards from pool = Transfer (not Reward)
  if (fromAddress === 'system_rewards_pool') {
    return 'Transfer';
  }
  
  if (typeof txType === 'string') return txType;
  
  // Handle Rust enum serialization: { "Transfer": {...} } or { "NodeRegistration": {...} }
  if (typeof txType === 'object' && txType !== null) {
    const typeKey = Object.keys(txType)[0];
    const typeMap: Record<string, string> = {
      'Transfer': 'Transfer',
      'NodeRegistration': 'Registration',
      'NodeActivation': 'Activation',
      'RewardDistribution': 'Reward',
      'CreateAccount': 'System',
      'PingAttestation': 'Heartbeat',
      'PingCommitmentWithSampling': 'Heartbeat',
      'HeartbeatCommitment': 'Heartbeat',
      'LightNodeEligibilityBitmap': 'Heartbeat',
      'Swap': 'Swap',
      'ContractDeploy': 'Contract',
      'ContractCall': 'Contract',
      'BatchTransfers': 'Transfer',
      'BatchNodeActivations': 'Activation',
      'BatchRewardClaims': 'Transfer',
    };
    return typeMap[typeKey] || typeKey || 'Unknown';
  }
  return 'Unknown';
}

// Convert byte array to hex string
// Returns empty string if input is not valid (undefined/null/not array)
function bytesToHex(bytes: unknown): string {
  if (typeof bytes === 'string') return bytes;
  if (Array.isArray(bytes) && bytes.length > 0) {
    return bytes.map((b: number) => b.toString(16).padStart(2, '0')).join('');
  }
  return ''; // Return empty string, not zeros - let caller handle default
}

// Transform DB block + transactions to frontend Block type
function transformDbBlock(dbBlock: BlockRow, transactions: BlockTransaction[]): Block {
  // IMPORTANT: PostgreSQL BIGINT returns as string, must convert to number
  const timestamp = Number(dbBlock.timestamp) || 0;
  
  return {
    hash: dbBlock.hash,
    height: Number(dbBlock.height),
    timestamp: timestamp > 0 ? timestamp : Date.now(), // Fallback to now for genesis if 0
    previous_hash: dbBlock.previous_hash || '0'.repeat(64),
    merkle_root: dbBlock.merkle_root || '0'.repeat(64),
    block_type: dbBlock.block_type as 'MICROBLOCK' | 'MACROBLOCK',
    version: dbBlock.version || 1,
    producer: dbBlock.producer,
    producer_address: dbBlock.producer_address || dbBlock.producer,
    tx_count: dbBlock.tx_count,
    total_gas_used: dbBlock.total_gas_used || 0,
    poh_hash: dbBlock.poh_hash || undefined,
    poh_count: dbBlock.poh_count,
    state_root: dbBlock.state_root || undefined,
    signature_type: dbBlock.signature_type || 'Dilithium3',
    signature: dbBlock.signature || undefined,
    cert_serial: dbBlock.cert_serial || undefined,
    qrb_output: dbBlock.qrb_output || undefined,
    size_bytes: dbBlock.size_bytes || 0,
    consensus_data: dbBlock.consensus_data ? {
      commits_count: (dbBlock.consensus_data.commits_count as number) || 0,
      reveals_count: (dbBlock.consensus_data.reveals_count as number) || 0,
      next_leader: (dbBlock.consensus_data.next_leader as string) || '',
      eligible_nodes_count: (dbBlock.consensus_data.eligible_nodes_count as number) || 0,
      fees_collected: dbBlock.consensus_data.fees_collected as number | undefined,
      pool3_total_activations: dbBlock.consensus_data.pool3_total_activations as number | undefined,
      heartbeat_entries: (dbBlock.consensus_data.heartbeat_entries as any[]) || [],
    } : undefined,
    micro_blocks: dbBlock.micro_blocks || undefined,
    transactions,
  };
}

// Transform backend block to frontend Block type (for RPC fallback)
function transformRpcBlock(raw: Record<string, unknown>): Block | null {
  if (raw.height === undefined) return null;
  
  const height = raw.height as number;
  const timestamp = (raw.timestamp as number) || 0;
  const transactions = (raw.transactions as unknown[]) || [];
  
  // Calculate total gas used
  // NOTE: HeartbeatCommitment txs have gas_price=u64::MAX as sentinel "no gas" value
  const U64_MAX = 18446744073709551615;
  let totalGasUsed = 0;
  for (const tx of transactions) {
    const t = tx as Record<string, unknown>;
    const gasPrice = Number(t.gas_price) || 0;
    const gasLimit = Number(t.gas_limit) || 0;
    // Skip if gas_price is u64::MAX (sentinel for "no gas" transactions)
    if (gasPrice >= U64_MAX - 1000 || gasPrice < 0) continue;
    totalGasUsed += Number(t.gas_used) || (gasPrice * gasLimit);
  }
  
  return {
    hash: (raw.hash as string) || `block_${height}`,
    height,
    timestamp: timestamp > 1e12 ? timestamp : timestamp * 1000,
    previous_hash: bytesToHex(raw.previous_hash) || '0'.repeat(64),
    merkle_root: bytesToHex(raw.merkle_root) || '0'.repeat(64),
    block_type: (raw.block_type as 'MICROBLOCK' | 'MACROBLOCK') || 'MICROBLOCK',
    version: (raw.version as number) || 1,
    producer: (raw.producer as string) || 'unknown',
    producer_address: (raw.producer_address as string) || (raw.producer as string) || 'unknown',
    tx_count: transactions.length,
    total_gas_used: totalGasUsed,
    poh_hash: bytesToHex(raw.poh_hash) || undefined,
    poh_count: (raw.poh_count as number) || 0,
    state_root: bytesToHex(raw.state_root) || undefined,
    signature_type: (raw.signature_type as string) || 'Dilithium3',
    signature: (raw.signature as string) || undefined,
    size_bytes: (raw.size_bytes as number) || 0,
    micro_blocks: Array.isArray(raw.micro_blocks) ? (raw.micro_blocks as string[]) : undefined,
    transactions: transactions.map((tx: unknown): BlockTransaction => {
      const t = tx as Record<string, unknown>;
      return {
        hash: (t.hash as string) || '',
        type: getTransactionType(t.tx_type, (t.from as string)),
        from: (t.from as string) || '',
        to: (t.to as string) || (t.from as string) || '',
        amount: String(t.amount || 0),
        fee: (t.gas_price && Number(t.gas_price) < U64_MAX - 1000) ? String((t.gas_price as number) * (t.gas_limit as number)) : undefined,
        timestamp: (t.timestamp as number) || timestamp,
        nonce: t.nonce as number | undefined,
        status: (t.status as string) || 'confirmed',
      };
    }),
  };
}

// Fetch block from PostgreSQL first, then fallback to Node RPC
async function fetchBlock(identifier: string): Promise<Block | null> {
  const isHeight = /^\d+$/.test(identifier);
  
  // 1. Try PostgreSQL first
  try {
    let dbBlock: BlockRow | null = null;
    
    if (isHeight) {
      dbBlock = await getBlockByHeight(parseInt(identifier, 10));
    } else {
      dbBlock = await getBlockByHash(identifier);
    }
    
    if (dbBlock) {
      // Get transactions for this block (ensure height is a number)
      const blockHeight = Number(dbBlock.height);
      const dbTransactions = await getTransactionsByBlock(blockHeight);
      
      const transactions: BlockTransaction[] = dbTransactions.map(tx => ({
        hash: tx.hash,
        type: getTransactionType(tx.tx_type, tx.from_address),
        from: tx.from_address,
        to: tx.to_address || tx.from_address,
        amount: String(tx.amount || 0),
        fee: tx.gas_price ? String(tx.gas_price * tx.gas_limit) : undefined,
        timestamp: tx.timestamp,
        nonce: tx.nonce,
        status: tx.status || 'confirmed',
      }));
      
      return transformDbBlock(dbBlock, transactions);
    }
  } catch {
    // Continue to RPC fallback
  }
  
  // 2. Fallback to Node RPC
  try {
    const endpoint = isHeight 
      ? `${NODE_RPC_URL}/api/v1/block/${identifier}`
      : `${NODE_RPC_URL}/api/v1/block/hash/${identifier}`;
    
    const response = await fetch(endpoint, {
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
    
    if (!response.ok) {
      return null;
    }
    
    const data = await response.json();
    if (data.error) return null;
    
    const block = (data.block || data) as Record<string, unknown>;
    return transformRpcBlock(block);
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
    return NextResponse.json(
      { success: false, error: 'Block identifier required' },
      { status: 400 }
    );
  }
  
  const block = await fetchBlock(hash);
  
  if (!block) {
    return NextResponse.json({
      success: false,
      error: 'Block not found',
    }, { status: 404 });
  }
  
  return NextResponse.json({
    success: true,
    source: 'postgresql',
    data: block,
  });
}
