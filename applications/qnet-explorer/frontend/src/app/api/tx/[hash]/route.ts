import { NextRequest, NextResponse } from 'next/server';
import { getTransactionByHash, getBatchRecipients } from '../../../../../lib/db';
import { rateLimit, getClientIdentifier } from '../../../../../lib/rate-limit';
import { mapTxType, formatAmount } from '@/lib/tx-mapping';
import { chainFeeNano, chainFeeNanoBig } from '@/lib/fee';
import { fetchNode, nodeConfigError } from '@/lib/node-api';

// Rate limiting: 200 requests per minute per IP
const RATE_LIMIT_MAX = 200;
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute

// Normalize type-specific public data (JSONB object or JSON string) → object|null; null if empty.
function parseTxTypeData(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null;
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return null; }
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  return Object.keys(obj).length > 0 ? (obj as Record<string, unknown>) : null;
}

// Fetch TX from Node RPC (fallback if not in DB)
async function fetchTransaction(hash: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetchNode(`/api/v1/transaction/${encodeURIComponent(hash)}`, { cache: 'no-store', timeoutMs: 3000 });
    if (!res || !res.ok) return null;
    
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
      const res = await fetchNode(`/api/v1/block/${height}`, { cache: 'no-store', timeoutMs: 3000 });
      if (!res || !res.ok) continue;
      
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
  
  // Fail loudly on node misconfiguration instead of silently 404ing every tx
  // that is not already in the local DB.
  const nodeError = nodeConfigError();
  if (nodeError) {
    return NextResponse.json({ success: false, error: `Node RPC misconfigured: ${nodeError}` }, { status: 503 });
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
      
      // Signature types (Ed25519 removed from consensus; user/consensus TXs are pure ML-DSA-65):
      // 1. System TX  2. ML-DSA-65 (quantum-signed)  3. Unsigned (legacy / no PQ sig)
      let signatureType: string;
      if (isSystemTx) {
        signatureType = 'System TX';
      } else if (isQuantumSigned) {
        signatureType = 'ML-DSA-65';
      } else {
        signatureType = 'Unsigned';
      }
      
      // The fee the chain debits, exact (NUMERIC columns arrive as digit strings): every non-system TX on
      // chain is ML-DSA signed and pays 1.5x the gas price; genesis/system TXs pay nothing.
      const sender = String(from || '');
      const totalFee = sender.startsWith('system_') || sender === 'genesis'
        ? BigInt(0)
        : chainFeeNanoBig(BigInt(dbTx.gas_price || '0'), BigInt(dbTx.gas_limit || '0'), true);
      const fee = totalFee > 0n ? formatAmount(totalFee.toString()) : '0';
      // Recipients of a batch envelope live in batch_transfers; the page expands them from tx_type_data.
      let typeData = parseTxTypeData(dbTx.tx_type_data);
      if (dbTx.tx_type === 'BatchTransfers') {
        const recipients = await getBatchRecipients(dbTx.hash).catch(() => []);
        if (recipients.length > 0) typeData = { ...(typeData || {}), recipients: recipients.map(r => ({ to: r.to_address, amount: r.amount })) };
      }
      
      // Get timestamp - if 0, fetch from block
      // Note: PostgreSQL BIGINT may come as string, so convert first
      let finalTimestamp = Number(dbTx.timestamp) > 0 ? Number(dbTx.timestamp) : 0;
      
      // If timestamp is 0 and block is 0, fetch block timestamp
      if (finalTimestamp === 0 && dbTx.block === 0) {
        try {
          const blockRes = await fetchNode('/api/v1/block/0', { cache: 'no-store', timeoutMs: 5000 });
          if (blockRes && blockRes.ok) {
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
          type: mapTxType(dbTx.tx_type, dbTx.from_address, dbTx.data),
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
          tx_type_data: typeData,
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
      const blockRes = await fetchNode(`/api/v1/block/${blockHeight}`, { cache: 'no-store', timeoutMs: 2000 });
      if (blockRes && blockRes.ok) {
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
    // FIX-5: sig-only (pk elided after first use → requiring it would mislabel signed txs Unsigned)
    const isQuantumSigned = !!(tx.is_quantum_signed || tx.dilithium_signature);
    
    // 3 signature types
    let signatureType: string;
    if (isSystemTx) {
      signatureType = 'System TX';
    } else if (isQuantumSigned) {
      signatureType = 'ML-DSA-65';
    } else {
      signatureType = 'Unsigned';
    }
    
    // The fee the chain debits: ML-DSA-signed TXs pay 1.5x the gas price; genesis/system TXs pay nothing.
    let fee: string;
    if (isSystemTx) {
      fee = '0';
    } else {
      const gasPrice = (tx.gas_price as number) || 0;
      const gasLimit = (tx.gas_limit as number) || 0;
      const totalFee = chainFeeNano(gasPrice, gasLimit, isQuantumSigned);
      fee = totalFee > 0 ? formatAmount(totalFee) : '0';
    }
    
    // Return ALL fields from transaction
    return NextResponse.json({
      success: true,
      source: 'rocksdb',
      data: {
        hash: tx.hash as string,
        type: mapTxType((tx.tx_type || tx.type) as string, (tx.from_address || tx.from) as string, tx.data),
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
        tx_type_data: parseTxTypeData(tx.tx_type_data),
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
