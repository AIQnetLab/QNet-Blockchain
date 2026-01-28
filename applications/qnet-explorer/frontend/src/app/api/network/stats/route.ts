import { NextResponse } from 'next/server';
import { Pool } from 'pg';

// ============================================================================
// PRODUCTION v2.74: Direct Node RPC with RocksDB
// ============================================================================

// Node RPC for real-time data
const NODE_RPC_URL = process.env.QNET_API_URL || 'http://154.38.160.39:8001';

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

// Disable ALL caching
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

export async function GET() {
  try {
    // Fetch height and stats from Node RPC
    const [heightRes, statsRes] = await Promise.all([
      fetch(`${NODE_RPC_URL}/api/v1/height?t=${Date.now()}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      }),
      fetch(`${NODE_RPC_URL}/api/v1/public/stats?t=${Date.now()}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      }).catch(() => null),
    ]);
    
    if (heightRes.ok) {
      const heightData = await heightRes.json();
      const statsData = statsRes?.ok ? await statsRes.json() : {};
      
      const height = heightData.height || 0;
      // Reward epoch = 0-based (epoch 0 starts at block 0)
      const rewardEpoch = Math.floor(height / 14400);
      // Blocks until next reward
      const blocksUntilReward = 14400 - (height % 14400);
      // Time until reward in seconds (1 block = 1 second)
      const secondsUntilReward = blocksUntilReward;
      
      // Calculate actual circulating supply from EMISSION transactions only
      // v3.0: Filter by from_address = 'system_emission' to exclude claim transactions
      // - system_emission → system_rewards_pool = REAL EMISSION (counts)
      // - system_rewards_pool → user_wallet = CLAIM (does NOT count - just moves existing QNC)
      let circulatingSupply = 0;
      let circulatingFormatted = '0';
      try {
        const result = await pool.query(
          `SELECT COALESCE(SUM(amount), 0) as total_rewards 
           FROM transactions 
           WHERE tx_type = 'RewardDistribution' 
             AND from_address = 'system_emission'`
        );
        // amount is in nanoQNC, convert to QNC
        const totalRewardsNano = BigInt(result.rows[0]?.total_rewards || 0);
        circulatingSupply = Number(totalRewardsNano) / 1_000_000_000;
        
        // v3.0: Format for display - full numbers with thousand separators (no K/M)
        circulatingFormatted = circulatingSupply.toLocaleString('en-US', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2
        });
      } catch (dbError) {
        /* log disabled */
      }
      
      const response = NextResponse.json({
        success: true,
        source: 'rocksdb',
        data: {
          activeNodes: statsData.active_nodes || 5,
          currentRound: rewardEpoch,
          height: height,
          blocksUntilReward: blocksUntilReward,
          secondsUntilReward: secondsUntilReward,
          circulatingSupply: Math.floor(circulatingSupply),
          circulatingFormatted: circulatingFormatted
        }
      });
      
      // Force no caching in response headers
      response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      response.headers.set('Pragma', 'no-cache');
      response.headers.set('Expires', '0');
      
      return response;
    }
    throw new Error('Backend unavailable');
  } catch {
    const response = NextResponse.json({
      success: false,
      data: null
    });
    response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    return response;
  }
}
