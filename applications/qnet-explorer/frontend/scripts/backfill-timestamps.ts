/**
 * Backfill timestamps for transactions that have timestamp=0 in the database.
 * Fetches real timestamps from the QNet API node.
 *
 * Usage: npx tsx scripts/backfill-timestamps.ts
 */

// All config via environment variables — no hardcoded credentials
const API_URL = process.env.QNET_API_URL;
const API_KEY = process.env.QNET_API_KEY || '';

if (!API_URL) {
  console.error('ERROR: QNET_API_URL environment variable is required');
  process.exit(1);
}

const DB_CONFIG = {
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5432'),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
};

if (!DB_CONFIG.database || !DB_CONFIG.user || !DB_CONFIG.password) {
  console.error('ERROR: PGDATABASE, PGUSER, PGPASSWORD environment variables are required');
  process.exit(1);
}

async function main() {
  const { Pool } = await import('pg');
  const pool = new Pool(DB_CONFIG);

  try {
    // Get all distinct blocks that have transactions with timestamp=0
    const { rows: blocks } = await pool.query(
      'SELECT DISTINCT block FROM transactions WHERE timestamp = 0 ORDER BY block'
    );

    console.log(`Found ${blocks.length} blocks with timestamp=0 transactions`);

    let totalUpdated = 0;

    for (const { block: height } of blocks) {
      console.log(`\nFetching block ${height} from API...`);

      try {
        const res = await fetch(`${API_URL}/api/v1/microblock/${height}`, {
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': API_KEY,
          },
          signal: AbortSignal.timeout(30000),
        });

        if (!res.ok) {
          console.error(`  Failed to fetch block ${height}: HTTP ${res.status}`);
          continue;
        }

        const data = await res.json();
        const block = data.block || data;
        const blockTimestamp = Number(block.timestamp) || 0;
        const txs = block.transactions || block.txs || [];

        console.log(`  Block timestamp: ${blockTimestamp}, ${txs.length} transactions`);

        // Build a map of tx hash -> timestamp
        const txTimestamps = new Map<string, number>();
        for (const tx of txs) {
          const hash = String(tx.hash || '');
          const txTs = Number(tx.timestamp) || 0;
          // Use TX timestamp first, block timestamp as fallback
          const ts = txTs > 0 ? txTs : blockTimestamp;
          if (hash && ts > 0) {
            // Normalize to milliseconds
            const tsMs = ts > 1e12 ? ts : ts * 1000;
            txTimestamps.set(hash, tsMs);
          }
        }

        // Update transactions in DB
        const { rows: affectedTxs } = await pool.query(
          'SELECT hash FROM transactions WHERE block = $1 AND timestamp = 0',
          [height]
        );

        for (const { hash } of affectedTxs) {
          let newTs = txTimestamps.get(hash);

          // If TX not found in API response, use block timestamp
          if (!newTs && blockTimestamp > 0) {
            newTs = blockTimestamp > 1e12 ? blockTimestamp : blockTimestamp * 1000;
          }

          if (newTs && newTs > 0) {
            await pool.query(
              'UPDATE transactions SET timestamp = $1 WHERE hash = $2 AND timestamp = 0',
              [newTs, hash]
            );
            totalUpdated++;
            console.log(`  Updated ${hash.substring(0, 16)}... → timestamp=${newTs}`);
          } else {
            console.warn(`  No timestamp found for ${hash.substring(0, 16)}...`);
          }
        }
      } catch (err) {
        console.error(`  Error processing block ${height}:`, err);
      }
    }

    console.log(`\nDone! Updated ${totalUpdated} transactions.`);

    // Verify
    const { rows: [{ count }] } = await pool.query(
      'SELECT COUNT(*) as count FROM transactions WHERE timestamp = 0'
    );
    console.log(`Remaining transactions with timestamp=0: ${count}`);

  } finally {
    await pool.end();
  }
}

main().catch(console.error);
