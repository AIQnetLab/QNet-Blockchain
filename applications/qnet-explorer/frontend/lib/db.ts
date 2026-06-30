import { Pool, QueryResult, QueryResultRow } from 'pg';

// Database connection pool
let pool: Pool | null = null;

// Cached sync_state height (avoids extra DB query on every /api/activity request)
let cachedSyncHeight: { value: number; expires: number } | null = null;
const SYNC_HEIGHT_CACHE_TTL = 5000; // 5 seconds

export function getDbPool(): Pool {
  if (!pool) {
    const databaseUrl = process.env.DATABASE_URL;
    
    if (!databaseUrl) {
      throw new Error('DATABASE_URL environment variable is not set');
    }

    // Parse connection string for SSL configuration (with error handling)
    let useSSL = process.env.DB_SSL === 'true'; // Only enable if explicitly set to 'true'
    try {
      const url = new URL(databaseUrl);
      // Auto-disable SSL for localhost connections
      if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === 'host.docker.internal') {
        useSSL = false;
      }
    } catch {
      // Invalid URL format - continue (pg will handle connection string validation)
    }

    pool = new Pool({
      connectionString: databaseUrl,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
      ssl: useSSL ? {
        rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false',
      } : false,
    });

    pool.on('error', () => {
      // Silent - allow retry
    });
  }

  return pool;
}

export interface TransactionRow {
  hash: string;
  from_address: string;
  to_address: string | null;
  amount: number;
  nonce: number;
  block: number;
  timestamp: number;
  gas_price: number;
  gas_limit: number;
  signature: string | null;
  public_key: string | null;
  dilithium_signature: string | null;
  dilithium_public_key: string | null;
  tx_type: string;
  tx_type_data: Record<string, unknown> | null;
  data: string | null;
  status: string;
  is_quantum_signed: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface SyncState {
  last_height: number;
  last_sync_at: Date;
  updated_at: Date;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  // Validate query text
  if (!text || typeof text !== 'string') {
    throw new Error('Query text must be a non-empty string');
  }
  
  let db: Pool;
  try {
    db = getDbPool();
  } catch (poolErr) {
    // console.error('[DB] Failed to get pool:', poolErr);
    throw new Error(`Database connection pool error: ${poolErr instanceof Error ? poolErr.message : 'Unknown error'}`);
  }
  
  const start = Date.now();
  let retries = 0;
  const maxRetries = 3;
  
  while (retries < maxRetries) {
    try {
      const res = await db.query<T>(text, params);
      const duration = Date.now() - start;
      
      // Slow query detection disabled
      
      return res;
    } catch (err: unknown) {
      // Retry on connection errors
      const error = err as { code?: string; message?: string };
      if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
        retries++;
        if (retries < maxRetries) {
          // console.warn(`[DB] Connection error, retrying (${retries}/${maxRetries}):`, error.code);
          await new Promise(resolve => setTimeout(resolve, 1000 * retries));
          continue;
        }
      }
      
      // Error logging disabled
      throw err;
    }
  }
  
  throw new Error('Database connection failed after retries');
}

// Validate transaction hash format
// Allow alphanumeric, underscores, and hyphens for system transactions (e.g., qnet_activation_...)
function validateHash(hash: string): void {
  if (!hash || typeof hash !== 'string') {
    throw new Error('Transaction hash is required');
  }
  // Allow:
  // 1. Hex hashes (a-f0-9)
  // 2. System transaction hashes (qnet_activation_..., system_..., etc.)
  // 3. Alphanumeric with underscores and hyphens
  if (!/^[a-f0-9_\-]+$/i.test(hash) && !hash.startsWith('qnet_') && !hash.startsWith('system_') && !hash.startsWith('genesis')) {
    throw new Error('Invalid transaction hash format: must be hexadecimal or system transaction hash');
  }
  if (hash.length < 8 || hash.length > 128) {
    throw new Error(`Invalid transaction hash length: ${hash.length} (expected 8-128)`);
  }
}

export async function getTransactionByHash(hash: string): Promise<TransactionRow | null> {
  validateHash(hash);
  
  const result = await query<TransactionRow>(
    'SELECT * FROM transactions WHERE hash = $1',
    [hash]
  );
  return result.rows[0] || null;
}

// Map display type names back to raw DB tx_type values
const DISPLAY_TYPE_TO_DB: Record<string, string[]> = {
  'Transfer': ['Transfer', 'BatchTransfers'],
  'Reward': ['RewardDistribution', 'BatchRewardClaims', 'SystemReward', 'SystemRewards', 'SystemEmission', 'Emission', 'Reward'],
  'Swap': ['Swap'],
  'Heartbeat': ['Heartbeat', 'HeartbeatCommitment'],
  'Light Eligibility': ['LightNodeEligibilityBitmap', 'BitmapCommitment', 'PingAttestation', 'PingCommitmentWithSampling'],
  'Registration': ['NodeRegistration', 'Registration'],
  'Activation': ['NodeActivation', 'BatchNodeActivations'],
  'Contract': ['ContractDeploy', 'ContractCall'],
  'System': ['CreateAccount', 'System'],
};

export async function getTransactions(
  page: number = 1,
  perPage: number = 50,
  sortOrder: 'asc' | 'desc' = 'desc',
  typeFilter?: string,
  displayTypes?: string[]
): Promise<{ transactions: TransactionRow[]; total: number; currentHeight: number }> {
  // Validate and sanitize inputs
  if (!Number.isInteger(page) || page < 1) {
    throw new Error('Invalid page number: must be positive integer');
  }
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 500) {
    throw new Error('Invalid perPage: must be between 1 and 500');
  }
  if (sortOrder !== 'asc' && sortOrder !== 'desc') {
    throw new Error('Invalid sortOrder: must be "asc" or "desc"');
  }

  const offset = (page - 1) * perPage;
  let whereClauseMain = '';
  let whereClauseCount = '';
  const filterValues: unknown[] = [];

  if (typeFilter && typeFilter !== 'All') {
    if (!/^[a-zA-Z0-9_\s-]+$/.test(typeFilter)) {
      throw new Error('Invalid typeFilter format');
    }
    filterValues.push(typeFilter);
    whereClauseMain = `WHERE tx_type = $3`;
    whereClauseCount = `WHERE tx_type = $1`;
  } else if (displayTypes && displayTypes.length > 0) {
    const dbTypes: string[] = [];
    for (const dt of displayTypes) {
      const mapped = DISPLAY_TYPE_TO_DB[dt];
      if (mapped) dbTypes.push(...mapped);
    }
    if (dbTypes.length > 0) {
      filterValues.push(...dbTypes);
      const mainPlaceholders = dbTypes.map((_, i) => `$${3 + i}`).join(', ');
      const countPlaceholders = dbTypes.map((_, i) => `$${1 + i}`).join(', ');
      whereClauseMain = `WHERE tx_type IN (${mainPlaceholders})`;
      whereClauseCount = `WHERE tx_type IN (${countPlaceholders})`;
    }
  }

  const orderBy = sortOrder === 'desc' ? 'DESC' : 'ASC';

  const transactionsQuery = `
    SELECT hash, tx_type, from_address, to_address, amount, block, timestamp,
           nonce, gas_price, gas_limit, signature, public_key,
           is_quantum_signed, dilithium_signature, dilithium_public_key, data, status
    FROM transactions
    ${whereClauseMain}
    ORDER BY block ${orderBy}, timestamp ${orderBy}, tx_type ${orderBy}, hash ${orderBy}
    LIMIT $1 OFFSET $2
  `;

  const countQuery = `
    SELECT COUNT(*) as total FROM transactions
    ${whereClauseCount}
  `;

  const mainParams = [perPage, offset, ...filterValues];
  const countParams = [...filterValues];

  // Use cached sync height if fresh (saves 1 DB query per request)
  let currentHeight = 0;
  const now = Date.now();
  if (cachedSyncHeight && now < cachedSyncHeight.expires) {
    currentHeight = cachedSyncHeight.value;
  }

  const queries: Promise<any>[] = [
    query<TransactionRow>(transactionsQuery, mainParams),
    query<{ total: string }>(countQuery, countParams.length > 0 ? countParams : undefined),
  ];
  if (!currentHeight) {
    queries.push(query<{ last_height: string | null }>('SELECT last_height FROM sync_state ORDER BY updated_at DESC LIMIT 1'));
  }

  const results = await Promise.all(queries);
  const transactions = results[0].rows;
  const total = parseInt(results[1].rows[0]?.total || '0', 10);
  if (!currentHeight && results[2]) {
    currentHeight = parseInt(results[2].rows[0]?.last_height || '0', 10);
    cachedSyncHeight = { value: currentHeight, expires: now + SYNC_HEIGHT_CACHE_TTL };
  }

  return { transactions, total, currentHeight };
}

export async function insertTransaction(tx: Omit<TransactionRow, 'created_at' | 'updated_at'>): Promise<void> {
  // Validate transaction data before insert
  validateHash(tx.hash);
  if (!tx.from_address || typeof tx.from_address !== 'string' || tx.from_address.length > 128) {
    throw new Error('Invalid from_address');
  }
  if (tx.to_address && (typeof tx.to_address !== 'string' || tx.to_address.length > 128)) {
    throw new Error('Invalid to_address');
  }
  if (!Number.isInteger(tx.amount) || tx.amount < 0) {
    throw new Error('Invalid amount: must be non-negative integer');
  }
  if (!Number.isInteger(tx.nonce) || tx.nonce < 0) {
    throw new Error('Invalid nonce: must be non-negative integer');
  }
  if (!Number.isInteger(tx.block) || tx.block < 0) {
    throw new Error('Invalid block: must be non-negative integer');
  }
  if (!Number.isInteger(tx.timestamp) || tx.timestamp < 0) {
    throw new Error('Invalid timestamp: must be non-negative integer');
  }
  if (!Number.isInteger(tx.gas_price) || tx.gas_price < 0) {
    throw new Error('Invalid gas_price: must be non-negative integer');
  }
  if (!Number.isInteger(tx.gas_limit) || tx.gas_limit < 0) {
    throw new Error('Invalid gas_limit: must be non-negative integer');
  }
  if (!tx.tx_type || typeof tx.tx_type !== 'string' || tx.tx_type.length > 100) {
    throw new Error('Invalid tx_type');
  }
  if (tx.data && (typeof tx.data !== 'string' || tx.data.length > 100000)) {
    throw new Error('Invalid data: must be string with max length 100000');
  }
  
  await query(
    `INSERT INTO transactions (
      hash, from_address, to_address, amount, nonce, block, timestamp,
      gas_price, gas_limit, signature, public_key, dilithium_signature,
      dilithium_public_key, tx_type, tx_type_data, data, status, is_quantum_signed
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
    ON CONFLICT (hash) DO UPDATE SET
      block = EXCLUDED.block,
      timestamp = EXCLUDED.timestamp,
      status = EXCLUDED.status,
      updated_at = CURRENT_TIMESTAMP`,
    [
      tx.hash,
      tx.from_address,
      tx.to_address,
      tx.amount,
      tx.nonce,
      tx.block,
      tx.timestamp,
      tx.gas_price,
      tx.gas_limit,
      tx.signature,
      tx.public_key,
      tx.dilithium_signature,
      tx.dilithium_public_key,
      tx.tx_type,
      tx.tx_type_data ? (() => {
        try {
          // Limit JSON size and prevent circular references
          const json = JSON.stringify(tx.tx_type_data);
          if (json.length > 100000) { // 100KB max
            // console.warn('[DB] tx_type_data too large, truncating');
            return json.substring(0, 100000);
          }
          return json;
        } catch (err) {
          // console.warn('[DB] Failed to stringify tx_type_data:', err);
          return null;
        }
      })() : null,
      tx.data,
      tx.status,
      tx.is_quantum_signed
    ]
  );
}

// Lock for batch insert to prevent race conditions
let isBatchInserting = false;

export async function insertTransactionsBatch(transactions: Omit<TransactionRow, 'created_at' | 'updated_at'>[]): Promise<void> {
  if (transactions.length === 0) return;
  
  // Limit batch size to prevent memory issues
  const MAX_BATCH_SIZE = 1000;
  if (transactions.length > MAX_BATCH_SIZE) {
    throw new Error(`Batch size ${transactions.length} exceeds maximum ${MAX_BATCH_SIZE}`);
  }

  // Wait if another batch insert is in progress (with timeout)
  const maxWait = 60000; // 60 seconds (increased for large batches)
  const startWait = Date.now();
  while (isBatchInserting && (Date.now() - startWait) < maxWait) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  if (isBatchInserting) {
    // console.warn('[DB] Batch insert timeout, forcing reset of lock');
    isBatchInserting = false; // Force reset the lock
  }

  isBatchInserting = true;

  // Validate transactions before insert — skip invalid ones instead of failing the entire batch
  const validTransactions: typeof transactions = [];
  for (const tx of transactions) {
    try {
      validateHash(tx.hash);
      if (!tx.from_address || typeof tx.from_address !== 'string' || tx.from_address.length > 128) {
        throw new Error(`Invalid from_address in transaction ${tx.hash.substring(0, 16)}`);
      }
      if (tx.to_address && (typeof tx.to_address !== 'string' || tx.to_address.length > 128)) {
        throw new Error(`Invalid to_address in transaction ${tx.hash.substring(0, 16)}`);
      }
      if (!Number.isInteger(tx.amount) || tx.amount < 0) {
        throw new Error(`Invalid amount in transaction ${tx.hash.substring(0, 16)}`);
      }
      if (!Number.isInteger(tx.nonce) || tx.nonce < 0) {
        throw new Error(`Invalid nonce in transaction ${tx.hash.substring(0, 16)}`);
      }
      if (!Number.isInteger(tx.block) || tx.block < 0) {
        throw new Error(`Invalid block in transaction ${tx.hash.substring(0, 16)}`);
      }
      if (!Number.isInteger(tx.timestamp) || tx.timestamp < 0) {
        throw new Error(`Invalid timestamp in transaction ${tx.hash.substring(0, 16)}`);
      }
      if (!Number.isInteger(tx.gas_price) || tx.gas_price < 0) {
        throw new Error(`Invalid gas_price in transaction ${tx.hash.substring(0, 16)}`);
      }
      if (!Number.isInteger(tx.gas_limit) || tx.gas_limit < 0) {
        throw new Error(`Invalid gas_limit in transaction ${tx.hash.substring(0, 16)}`);
      }
      if (!tx.tx_type || typeof tx.tx_type !== 'string' || tx.tx_type.length > 100) {
        throw new Error(`Invalid tx_type '${String(tx.tx_type).substring(0, 40)}...' in transaction ${tx.hash.substring(0, 16)}`);
      }
      if (tx.data && (typeof tx.data !== 'string' || tx.data.length > 100000)) {
        throw new Error(`Invalid data size in transaction ${tx.hash.substring(0, 16)}`);
      }
      validTransactions.push(tx);
    } catch (validationErr) {
      console.error(`[DB] Skipping invalid TX ${tx.hash?.substring(0, 16)}: ${validationErr}`);
    }
  }

  if (validTransactions.length === 0) {
    isBatchInserting = false;
    return;
  }

  const db = getDbPool();
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    for (const tx of validTransactions) {
      await client.query(
        `INSERT INTO transactions (
          hash, from_address, to_address, amount, nonce, block, timestamp,
          gas_price, gas_limit, signature, public_key, dilithium_signature,
          dilithium_public_key, tx_type, tx_type_data, data, status, is_quantum_signed
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
        ON CONFLICT (hash) DO UPDATE SET
          block = EXCLUDED.block,
          timestamp = EXCLUDED.timestamp,
          status = EXCLUDED.status,
          updated_at = CURRENT_TIMESTAMP`,
        [
          tx.hash,
          tx.from_address,
          tx.to_address,
          tx.amount,
          tx.nonce,
          tx.block,
          tx.timestamp,
          tx.gas_price,
          tx.gas_limit,
          tx.signature,
          tx.public_key,
          tx.dilithium_signature,
          tx.dilithium_public_key,
          tx.tx_type,
          tx.tx_type_data ? (() => {
            try {
              // Limit JSON size and prevent circular references
              const json = JSON.stringify(tx.tx_type_data);
              if (json.length > 100000) { // 100KB max
                // console.warn('[DB] tx_type_data too large, truncating');
                return json.substring(0, 100000);
              }
              return json;
            } catch (err) {
              // console.warn('[DB] Failed to stringify tx_type_data:', err);
              return null;
            }
          })() : null,
          tx.data,
          tx.status,
          tx.is_quantum_signed
        ]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    isBatchInserting = false;
  }
}

export async function getSyncState(): Promise<SyncState | null> {
  const result = await query<SyncState>(
    'SELECT * FROM sync_state WHERE id = 1'
  );
  return result.rows[0] || null;
}

export async function updateSyncState(height: number): Promise<void> {
  // ONLY update if new height is GREATER than current (prevents jumps from out-of-order blocks)
  await query(
    'UPDATE sync_state SET last_height = GREATEST(last_height, $1), last_sync_at = CURRENT_TIMESTAMP WHERE id = 1',
    [height]
  );
}

// Validate address format
function validateAddress(address: string): void {
  if (!address || typeof address !== 'string') {
    throw new Error('Address is required');
  }
  if (address.length < 20 || address.length > 128) {
    throw new Error(`Invalid address length: ${address.length} (expected 20-128)`);
  }
  // Allow alphanumeric and common address characters
  if (!/^[a-zA-Z0-9_-]+$/.test(address)) {
    throw new Error('Invalid address format');
  }
}

export async function getTransactionsByAddress(
  address: string,
  page: number = 1,
  perPage: number = 50
): Promise<{ transactions: TransactionRow[]; total: number }> {
  validateAddress(address);
  
  // Validate pagination
  if (!Number.isInteger(page) || page < 1) {
    throw new Error('Invalid page number: must be positive integer');
  }
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 500) {
    throw new Error('Invalid perPage: must be between 1 and 500');
  }
  
  const offset = (page - 1) * perPage;

  const transactionsQuery = `
    SELECT * FROM transactions 
    WHERE from_address = $1 OR to_address = $1
    ORDER BY block DESC, timestamp DESC
    LIMIT $2 OFFSET $3
  `;

  const countQuery = `
    SELECT COUNT(*) as total FROM transactions 
    WHERE from_address = $1 OR to_address = $1
  `;

  const [transactionsResult, countResult] = await Promise.all([
    query<TransactionRow>(transactionsQuery, [address, perPage, offset]),
    query<{ total: string }>(countQuery, [address])
  ]);

  return {
    transactions: transactionsResult.rows,
    total: parseInt(countResult.rows[0].total, 10)
  };
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// ============================================================================
// BLOCKS
// ============================================================================

export interface BlockRow {
  height: number;
  hash: string;
  block_type: string;
  version: number;
  timestamp: number;
  previous_hash: string | null;
  merkle_root: string | null;
  state_root: string | null;
  producer: string;
  producer_address: string | null;
  tx_count: number;
  total_gas_used: number;
  poh_hash: string | null;
  poh_count: number;
  signature_type: string | null;
  signature: string | null;
  cert_serial: string | null;
  qrb_output: string | null;
  size_bytes: number;
  consensus_data: Record<string, unknown> | null;
  micro_blocks: string[] | null;
  created_at: Date;
  updated_at: Date;
}

export async function getBlockByHeight(height: number): Promise<BlockRow | null> {
  if (!Number.isInteger(height) || height < 0) {
    throw new Error('Invalid block height');
  }
  
  const result = await query<BlockRow>(
    'SELECT * FROM blocks WHERE height = $1',
    [height]
  );
  return result.rows[0] || null;
}

export async function getBlockByHash(hash: string): Promise<BlockRow | null> {
  if (!hash || typeof hash !== 'string' || hash.length < 8) {
    throw new Error('Invalid block hash');
  }
  
  const result = await query<BlockRow>(
    'SELECT * FROM blocks WHERE hash = $1',
    [hash]
  );
  return result.rows[0] || null;
}

export async function insertBlock(block: Omit<BlockRow, 'created_at' | 'updated_at'>): Promise<void> {
  await query(
    `INSERT INTO blocks (
      height, hash, block_type, version, timestamp, previous_hash, merkle_root, state_root,
      producer, producer_address, tx_count, total_gas_used, poh_hash, poh_count,
      signature_type, signature, cert_serial, qrb_output, size_bytes, consensus_data, micro_blocks
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
    ON CONFLICT (height) DO UPDATE SET
      hash = EXCLUDED.hash,
      block_type = EXCLUDED.block_type,
      version = EXCLUDED.version,
      timestamp = EXCLUDED.timestamp,
      previous_hash = EXCLUDED.previous_hash,
      merkle_root = EXCLUDED.merkle_root,
      state_root = EXCLUDED.state_root,
      producer = EXCLUDED.producer,
      producer_address = EXCLUDED.producer_address,
      tx_count = EXCLUDED.tx_count,
      total_gas_used = EXCLUDED.total_gas_used,
      poh_hash = EXCLUDED.poh_hash,
      poh_count = EXCLUDED.poh_count,
      signature_type = EXCLUDED.signature_type,
      signature = EXCLUDED.signature,
      cert_serial = EXCLUDED.cert_serial,
      qrb_output = EXCLUDED.qrb_output,
      size_bytes = EXCLUDED.size_bytes,
      consensus_data = EXCLUDED.consensus_data,
      micro_blocks = EXCLUDED.micro_blocks,
      updated_at = CURRENT_TIMESTAMP`,
    [
      block.height,
      block.hash,
      block.block_type,
      block.version,
      block.timestamp,
      block.previous_hash,
      block.merkle_root,
      block.state_root,
      block.producer,
      block.producer_address,
      block.tx_count,
      block.total_gas_used,
      block.poh_hash,
      block.poh_count,
      block.signature_type,
      block.signature,
      block.cert_serial,
      block.qrb_output,
      block.size_bytes,
      block.consensus_data ? JSON.stringify(block.consensus_data) : null,
      block.micro_blocks
    ]
  );
}

export async function getTransactionsByBlock(blockHeight: number): Promise<TransactionRow[]> {
  if (!Number.isInteger(blockHeight) || blockHeight < 0) {
    throw new Error('Invalid block height');
  }
  
  const result = await query<TransactionRow>(
    'SELECT * FROM transactions WHERE block = $1 ORDER BY timestamp ASC',
    [blockHeight]
  );
  return result.rows;
}

