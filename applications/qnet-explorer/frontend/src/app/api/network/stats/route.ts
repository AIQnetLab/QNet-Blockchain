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
    // Active-node counts use the PREVIOUS sealed epoch (the current epoch is partial → flickers).
    // prevEpoch = floor(height/14400) - 1; window = [pe*14400, pe*14400+14400).
    const prevEpochCte = `
      WITH h AS (
        SELECT COALESCE(
          (SELECT last_height FROM sync_state WHERE id = 1),
          (SELECT MAX(height) FROM blocks),
          0
        ) AS height
      ),
      ep AS (SELECT GREATEST(FLOOR(height / 14400)::bigint - 1, 0) AS pe FROM h)`;

    const [heightResult, supplyResult, superNodesResult, lightNodesResult] = await Promise.all([
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
      
      // Active SERVER/super nodes = distinct senders of the v35 'Heartbeat' TX in the previous sealed epoch.
      pool.query(`${prevEpochCte}
        SELECT COUNT(DISTINCT t.from_address) AS active_super
        FROM transactions t, ep
        WHERE t.tx_type = 'Heartbeat'
          AND t.block >= ep.pe * 14400 AND t.block < ep.pe * 14400 + 14400
      `),

      // Active LIGHT nodes = sealed eligible_count summed over the per-genesis bitmaps of the previous epoch.
      pool.query(`${prevEpochCte}
        SELECT COALESCE(SUM((t.tx_type_data->>'eligible_count')::bigint), 0) AS active_light
        FROM transactions t, ep
        WHERE t.tx_type = 'LightNodeEligibilityBitmap'
          AND t.block >= ep.pe * 14400 AND t.block < ep.pe * 14400 + 14400
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
    
    // Server (super/genesis) nodes active in the previous sealed epoch; light nodes counted separately.
    const activeNodes = Number(superNodesResult.rows[0]?.active_super || 0);
    const activeLightNodes = Number(lightNodesResult.rows[0]?.active_light || 0);
    
    const response = NextResponse.json({
      success: true,
      source: 'database',
      data: {
        activeNodes: activeNodes,
        activeLightNodes: activeLightNodes,
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
