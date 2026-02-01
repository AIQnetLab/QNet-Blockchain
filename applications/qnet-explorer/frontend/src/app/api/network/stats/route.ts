import { NextResponse } from 'next/server';
import { Pool } from 'pg';

// ============================================================================
// PRODUCTION v3.19: ALL DATA FROM DATABASE (no node requests)
// - Removes load from node
// - Faster response times
// - Data consistency with explorer
// ============================================================================

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
    // ALL DATA FROM DATABASE - no node requests!
    const [heightResult, supplyResult, nodesResult] = await Promise.all([
      // Get current height from sync_state or blocks table
      pool.query(`
        SELECT COALESCE(
          (SELECT last_height FROM sync_state WHERE id = 1),
          (SELECT MAX(height) FROM blocks),
          0
        ) as height
      `),
      
      // Get circulating supply from emission transactions
      pool.query(`
        SELECT COALESCE(SUM(amount), 0) as total_rewards 
        FROM transactions 
        WHERE tx_type = 'RewardDistribution' 
          AND from_address = 'system_emission'
      `),
      
      // Count ACTIVE nodes - those who sent heartbeats in last epoch (14400 blocks)
      pool.query(`
        SELECT COUNT(DISTINCT from_address) as active_nodes
        FROM transactions 
        WHERE tx_type IN ('HeartbeatCommitment', 'PingCommitmentWithSampling', 'PingAttestation')
          AND block >= (SELECT COALESCE(MAX(height), 0) - 14400 FROM blocks)
      `)
    ]);
    
    const height = Number(heightResult.rows[0]?.height || 0);
    
    // Reward epoch = 0-based (epoch 0 starts at block 0)
    const rewardEpoch = Math.floor(height / 14400);
    // Blocks until next reward
    const blocksUntilReward = 14400 - (height % 14400);
    // Time until reward in seconds (1 block = 1 second)
    const secondsUntilReward = blocksUntilReward;
    
    // Circulating supply from emissions
    const totalRewardsNano = BigInt(supplyResult.rows[0]?.total_rewards || 0);
    const circulatingSupply = Number(totalRewardsNano) / 1_000_000_000;
    // Deterministic formatting (no locale differences)
    const circulatingFormatted = circulatingSupply.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    
    // Real count from heartbeats - 0 if no activity
    const activeNodes = Number(nodesResult.rows[0]?.active_nodes || 0);
    
    const response = NextResponse.json({
      success: true,
      source: 'database',
      data: {
        activeNodes: activeNodes,
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
  } catch (error) {
    console.error('[STATS] Database error:', error);
    const response = NextResponse.json({
      success: false,
      data: null
    });
    response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    return response;
  }
}
