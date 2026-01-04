import { NextRequest, NextResponse } from 'next/server';
import type { Block, BlockTransaction } from '@/lib/types';

// ============================================================================
// PRODUCTION v2.74: Direct Node RPC with RocksDB
// ============================================================================

// Node RPC (direct blockchain access via RocksDB)
const NODE_RPC_URL = process.env.QNET_API_URL || 'http://localhost:8001';

// Map transaction type to display name
function getTransactionType(txType: unknown): string {
  if (!txType) return 'Unknown';
  if (typeof txType === 'string') return txType;
  
  // Handle Rust enum serialization: { "Transfer": {...} } or { "NodeRegistration": {...} }
  if (typeof txType === 'object' && txType !== null) {
    const typeKey = Object.keys(txType)[0];
    const typeMap: Record<string, string> = {
      'Transfer': 'Transfer',
      'NodeRegistration': 'Registration',
      'NodeActivation': 'Node Activation',
      'RewardDistribution': 'Reward',
      'CreateAccount': 'System',
      'PingAttestation': 'System',
      'PingCommitmentWithSampling': 'System',
      'Swap': 'Swap',
      'ContractDeploy': 'Smart Contract',
      'ContractCall': 'Smart Contract',
      'BatchTransfers': 'Transfer',
      'BatchNodeActivations': 'Node Activation',
      'BatchRewardClaims': 'Reward',
    };
    return typeMap[typeKey] || typeKey || 'Unknown';
  }
  return 'Unknown';
}

// Convert byte array to hex string
function bytesToHex(bytes: unknown): string {
  if (typeof bytes === 'string') return bytes;
  if (Array.isArray(bytes)) {
    return bytes.map((b: number) => b.toString(16).padStart(2, '0')).join('');
  }
  return '0'.repeat(64);
}

// Transform backend block to frontend Block type
function transformBlock(raw: Record<string, unknown>): Block | null {
  if (raw.height === undefined) return null;
  
  const height = raw.height as number;
  const timestamp = (raw.timestamp as number) || 0;
  const transactions = (raw.transactions as unknown[]) || [];
  
  return {
    hash: (raw.hash as string) || `block_${height}`,
    height,
    timestamp: timestamp > 1e12 ? timestamp : timestamp * 1000, // Ensure ms
    previous_hash: bytesToHex(raw.previous_hash),
    merkle_root: bytesToHex(raw.merkle_root),
    block_type: 'MICROBLOCK',
    producer: (raw.producer as string) || 'unknown',
    producer_address: (raw.producer_address as string) || (raw.producer as string) || 'unknown',
    tx_count: transactions.length,
    poh_hash: bytesToHex(raw.poh_hash) || undefined,
    poh_count: (raw.poh_count as number) || 0,
    // Block signatures are always Dilithium3 (quantum-resistant)
    signature_type: (raw.signature_type as string) || 'Dilithium3',
    signature: (raw.signature as string) || undefined,
    transactions: transactions.map((tx: unknown): BlockTransaction => {
      const t = tx as Record<string, unknown>;
      return {
        hash: (t.hash as string) || '',
        type: getTransactionType(t.tx_type),
        from: (t.from as string) || '',
        to: (t.to as string) || (t.from as string) || '',
        amount: String(t.amount || 0),
        fee: t.gas_price ? String((t.gas_price as number) * (t.gas_limit as number || 1)) : undefined,
        timestamp: (t.timestamp as number) || timestamp,
        nonce: t.nonce as number | undefined,
        status: (t.status as string) || 'confirmed',
      };
    }),
  };
}

// Fetch block from Node RPC (RocksDB indexed)
async function fetchBlock(identifier: string): Promise<Block | null> {
  try {
    const isHeight = /^\d+$/.test(identifier);
    const endpoint = isHeight 
      ? `${NODE_RPC_URL}/api/v1/block/${identifier}`
      : `${NODE_RPC_URL}/api/v1/block/hash/${identifier}`;
    
    const response = await fetch(endpoint, {
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
    
    if (!response.ok) {
      console.error(`[BLOCK] Node RPC failed: ${response.status}`);
      return null;
    }
    
    const data = await response.json();
    if (data.error) return null;
    
    const block = (data.block || data) as Record<string, unknown>;
    return transformBlock(block);
  } catch (err) {
    console.error(`[BLOCK] Error:`, err);
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
    source: 'rocksdb',
    data: block,
  });
}
