import { NextRequest, NextResponse } from 'next/server';
import { getTransactionByHash } from '../../../../../lib/db';
import { rateLimit, getClientIdentifier } from '../../../../../lib/rate-limit';
import { mapTxType, formatAmount } from '@/lib/tx-mapping';

// Rate limiting: 200 requests per minute per IP
const RATE_LIMIT_MAX = 200;
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute

// Validate and sanitize NODE_RPC_URL to prevent SSRF
function getNodeRpcUrl(): string {
  const url = process.env.QNET_API_URL || 'https://162.244.25.114:8001';
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Invalid protocol');
    }
    const hostname = parsed.hostname;
    if (hostname === 'localhost' || hostname === '127.0.0.1' || 
        hostname.startsWith('192.168.') || hostname.startsWith('10.') ||
        hostname.startsWith('172.16.') || hostname.startsWith('172.17.') ||
        hostname.startsWith('172.18.') || hostname.startsWith('172.19.') ||
        hostname.startsWith('172.20.') || hostname.startsWith('172.21.') ||
        hostname.startsWith('172.22.') || hostname.startsWith('172.23.') ||
        hostname.startsWith('172.24.') || hostname.startsWith('172.25.') ||
        hostname.startsWith('172.26.') || hostname.startsWith('172.27.') ||
        hostname.startsWith('172.28.') || hostname.startsWith('172.29.') ||
        hostname.startsWith('172.30.') || hostname.startsWith('172.31.')) {
      return 'https://162.244.25.114:8001';
    }
    return url;
  } catch {
    return 'https://162.244.25.114:8001';
  }
}

const NODE_RPC_URL = getNodeRpcUrl();

// Fetch TX from Node RPC (fallback if not in DB)
async function fetchTransaction(hash: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${NODE_RPC_URL}/api/v1/transaction/${hash}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    });
    
    if (!res.ok) return null;
    
    // Validate response size before parsing
    const text = await res.text();
    if (text.length > 10 * 1024 * 1024) { // 10MB max
      // console.warn('[TX] Transaction response too large:', text.length);
      return null;
    }
    
    let data: { status?: string; transaction?: Record<string, unknown> };
    try {
      data = JSON.parse(text) as { status?: string; transaction?: Record<string, unknown> };
    } catch (parseErr) {
      // console.warn('[TX] Failed to parse transaction JSON:', parseErr);
      return null;
    }
    
    if (data.status === 'found' && data.transaction) {
      return data.transaction;
    }
    return null;
  } catch {
    return null;
  }
}

// Fallback: Search in genesis and emission blocks
// Dynamically builds list up to current network height (every 14400 blocks)
async function searchInEmissionBlocks(hash: string): Promise<Record<string, unknown> | null> {
  const EPOCH_SIZE = 14400;
  // Build dynamic list: block 0 + all epoch boundaries up to epoch 20 (covers ~280K blocks)
  const emissionBlocks: number[] = [0];
  for (let epoch = 1; epoch <= 20; epoch++) {
    emissionBlocks.push(epoch * EPOCH_SIZE);
  }

  for (const height of emissionBlocks) {
    try {
      const res = await fetch(`${NODE_RPC_URL}/api/v1/block/${height}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(3000),
      });
      
      if (!res.ok) continue;
      
      // Validate response size
      const blockText = await res.text();
      if (blockText.length > 50 * 1024 * 1024) { // 50MB max
        continue;
      }
      
      let block: { transactions?: unknown[]; timestamp?: number };
      try {
        block = JSON.parse(blockText) as { transactions?: unknown[]; timestamp?: number };
      } catch {
        continue;
      }
      
      const transactions = Array.isArray(block.transactions) ? block.transactions : [];
      
      for (const tx of transactions) {
        const txObj = tx as Record<string, unknown>;
        if (txObj.hash === hash) {
          // Always use block.timestamp (authoritative chain time, not tx signing time)
          return { ...txObj, block_height: height, timestamp: block.timestamp };
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
  // Rate limiting
  const clientId = getClientIdentifier(request);
  const rateLimitResult = rateLimit(clientId, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW);
  
  if (!rateLimitResult.allowed) {
    return NextResponse.json({
      success: false,
      error: 'Rate limit exceeded',
      retryAfter: Math.ceil((rateLimitResult.resetTime - Date.now()) / 1000)
    }, { 
      status: 429,
      headers: {
        'X-RateLimit-Limit': String(RATE_LIMIT_MAX),
        'X-RateLimit-Remaining': String(rateLimitResult.remaining),
        'X-RateLimit-Reset': String(Math.ceil(rateLimitResult.resetTime / 1000)),
        'Retry-After': String(Math.ceil((rateLimitResult.resetTime - Date.now()) / 1000))
      }
    });
  }
  
  const { hash } = await params;
  
  // Validate hash
  if (!hash || typeof hash !== 'string') {
    return NextResponse.json({
      success: false,
      error: 'Transaction hash is required',
    }, { status: 400 });
  }
  
  // Validate hash format - allow hex, system transactions (qnet_*, system_*, genesis), and alphanumeric with underscores/hyphens
  const isHex = /^[a-f0-9]+$/i.test(hash);
  const isSystem = hash.startsWith('qnet_') || hash.startsWith('system_') || hash.startsWith('genesis');
  const isAlphanumeric = /^[a-zA-Z0-9_\-]+$/.test(hash);
  
  if (!isHex && !isSystem && !isAlphanumeric) {
    return NextResponse.json({
      success: false,
      error: 'Invalid transaction hash format: must be hexadecimal or system transaction hash',
    }, { status: 400 });
  }
  
  if (hash.length < 8 || hash.length > 128) {
    return NextResponse.json({
      success: false,
      error: `Invalid transaction hash length: ${hash.length} (expected 8-128)`,
    }, { status: 400 });
  }
  
  try {
    // 1. First try PostgreSQL (fastest, has all accumulated data)
    const dbTx = await getTransactionByHash(hash);
    
    if (dbTx) {
      const from = dbTx.from_address;
      const isSystemTx = from.startsWith('system_') || from === 'genesis' || dbTx.block === 0;
      const isQuantumSigned = dbTx.is_quantum_signed;
      
      // 3 signature types:
      // 1. System TX - for system transactions
      // 2. Ed25519 + Dilithium3 - hybrid quantum-resistant  
      // 3. Ed25519 - classical only
      let signatureType: string;
      if (isSystemTx) {
        signatureType = 'System TX';
      } else if (isQuantumSigned) {
        signatureType = 'Ed25519 + Dilithium3';
      } else {
        signatureType = 'Ed25519';
      }
      
      // Calculate real fee from stored gas_price and gas_limit
      const gasPrice = dbTx.gas_price || 0;
      const gasLimit = dbTx.gas_limit || 0;
      const totalFee = gasPrice * gasLimit;
      const fee = totalFee > 0 ? formatAmount(totalFee) : '0 QNC';
      
      // Get timestamp - if 0, fetch from block
      // Note: PostgreSQL BIGINT may come as string, so convert first
      let finalTimestamp = Number(dbTx.timestamp) > 0 ? Number(dbTx.timestamp) : 0;
      
      // If timestamp is 0 and block is 0, fetch block timestamp
      if (finalTimestamp === 0 && dbTx.block === 0) {
        try {
          const blockRes = await fetch(`${NODE_RPC_URL}/api/v1/block/0`, {
            cache: 'no-store',
            signal: AbortSignal.timeout(5000),
          });
          if (blockRes.ok) {
            const blockText = await blockRes.text();
            if (blockText.length < 10 * 1024 * 1024) {
              try {
                const blockData = JSON.parse(blockText);
                const block = blockData.block || blockData;
                const blockTs = block.timestamp || 0;
                // Convert to milliseconds if in seconds
                if (blockTs > 0) {
                  finalTimestamp = blockTs < 1e12 ? blockTs * 1000 : blockTs;
                }
              } catch {
                // Keep 0
              }
            }
          }
        } catch {
          // Keep 0
        }
      }
      
      // Return ALL fields from stored transaction
      return NextResponse.json({
        success: true,
        source: 'postgresql',
        data: {
          hash: dbTx.hash,
          type: mapTxType(dbTx.tx_type, dbTx.from_address),
          tx_type: dbTx.tx_type,
          status: dbTx.status || 'confirmed',
          block: dbTx.block,
          block_height: dbTx.block,
          timestamp: finalTimestamp,
          from,
          to: dbTx.to_address || 'N/A',
          amount: formatAmount(dbTx.amount),
          amount_raw: dbTx.amount,
          nonce: dbTx.nonce,
          gas_price: dbTx.gas_price,
          gas_limit: dbTx.gas_limit,
          fee,
          signature: dbTx.signature,
          public_key: dbTx.public_key,
          signature_type: signatureType,
          is_quantum_signed: isQuantumSigned,
          dilithium_signature: dbTx.dilithium_signature,
          dilithium_public_key: dbTx.dilithium_public_key,
          data: dbTx.data,
        },
      }, {
        headers: {
          'X-RateLimit-Limit': String(RATE_LIMIT_MAX),
          'X-RateLimit-Remaining': String(rateLimitResult.remaining),
          'X-RateLimit-Reset': String(Math.ceil(rateLimitResult.resetTime / 1000))
        }
      });
    }
    
    // 2. Try tx_index (RocksDB) from node
    let tx = await fetchTransaction(hash);
    
    // 3. Fallback: Search in emission blocks
    if (!tx) {
      tx = await searchInEmissionBlocks(hash);
    }
    
    if (!tx) {
      return NextResponse.json({
        success: false,
        error: 'Transaction not found',
      }, { status: 404 });
    }
    
    // Always use block.timestamp (authoritative chain time), not tx.timestamp (signing time)
    let rawTs = 0;
    const blockHeight = (tx.block_height || tx.block || 0) as number;

    // Fetch block timestamp from node API
    try {
      const blockRes = await fetch(`${NODE_RPC_URL}/api/v1/block/${blockHeight}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(2000),
      });
      if (blockRes.ok) {
        const blockText = await blockRes.text();
        if (blockText.length < 10 * 1024 * 1024) {
          try {
            const block = JSON.parse(blockText) as { timestamp?: number };
            rawTs = block.timestamp || 0;
          } catch {
            // fallback to tx.timestamp
          }
        }
      }
    } catch {
      // fallback to tx.timestamp
    }

    // Fallback to tx.timestamp if block fetch failed
    if (rawTs === 0) {
      rawTs = (tx.timestamp as number) || 0;
    }

    const ts = rawTs > 1e12 ? rawTs : rawTs * 1000;
    
    // Determine transaction signature type
    const from = (tx.from_address || tx.from || 'unknown') as string;
    const isSystemTx = from.startsWith('system_') || from === 'genesis' || blockHeight === 0;
    const isQuantumSigned = !!(tx.is_quantum_signed || 
      (tx.dilithium_signature && tx.dilithium_public_key));
    
    // 3 signature types
    let signatureType: string;
    if (isSystemTx) {
      signatureType = 'System TX';
    } else if (isQuantumSigned) {
      signatureType = 'Ed25519 + Dilithium3';
    } else {
      signatureType = 'Ed25519';
    }
    
    // Calculate fee: gas_price * gas_limit, or 0 for genesis/system transactions
    let fee: string;
    if (isSystemTx) {
      fee = '0 QNC';
    } else {
      const gasPrice = (tx.gas_price as number) || 0;
      const gasLimit = (tx.gas_limit as number) || 0;
      const totalFee = gasPrice * gasLimit;
      fee = totalFee > 0 ? formatAmount(totalFee) : '0 QNC';
    }
    
    // Return ALL fields from transaction
    return NextResponse.json({
      success: true,
      source: 'rocksdb',
      data: {
        hash: tx.hash as string,
        type: mapTxType((tx.tx_type || tx.type) as string, (tx.from_address || tx.from) as string),
        tx_type: tx.tx_type || tx.type,
        status: (tx.status as string) || 'confirmed',
        block: blockHeight,
        block_height: blockHeight,
        timestamp: ts,
        from,
        to: (tx.to_address || tx.to || 'N/A') as string,
        amount: formatAmount(tx.amount as number),
        amount_raw: tx.amount as number,
        nonce: tx.nonce as number | undefined,
        gas_price: tx.gas_price as number | undefined,
        gas_limit: tx.gas_limit as number | undefined,
        fee,
        signature: tx.signature as string | undefined,
        public_key: tx.public_key as string | undefined,
        signature_type: signatureType,
        is_quantum_signed: isQuantumSigned,
        dilithium_signature: tx.dilithium_signature as string | undefined,
        dilithium_public_key: tx.dilithium_public_key as string | undefined,
        data: tx.data as string | undefined,
      },
    }, {
      headers: {
        'X-RateLimit-Limit': String(RATE_LIMIT_MAX),
        'X-RateLimit-Remaining': String(rateLimitResult.remaining),
        'X-RateLimit-Reset': String(Math.ceil(rateLimitResult.resetTime / 1000))
      }
    });
    
  } catch {
    return NextResponse.json({
      success: false,
      error: 'Backend unavailable',
    }, { status: 503 });
  }
}
