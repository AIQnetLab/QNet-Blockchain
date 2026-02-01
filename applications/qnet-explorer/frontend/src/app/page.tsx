import { Pool } from 'pg';
import HomeClient from './HomeClient';

// ============================================================================
// SSR: Data loaded on SERVER before page renders - NO LOADING DASHES!
// ============================================================================

interface NetworkStats {
  activeNodes: number;
  currentRound: number;
  height: number;
  blocksUntilReward: number;
  secondsUntilReward: number;
  circulatingSupply: number;
  circulatingFormatted: string;
}

// PostgreSQL connection for SSR
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

// Fetch stats on server - same logic as API
async function getNetworkStats(): Promise<NetworkStats | null> {
  try {
    const [heightResult, supplyResult, nodesResult] = await Promise.all([
      pool.query(`
        SELECT COALESCE(
          (SELECT last_height FROM sync_state WHERE id = 1),
          (SELECT MAX(height) FROM blocks),
          0
        ) as height
      `),
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
    const rewardEpoch = Math.floor(height / 14400);
    const blocksUntilReward = 14400 - (height % 14400);
    const secondsUntilReward = blocksUntilReward;
    
    const totalRewardsNano = BigInt(supplyResult.rows[0]?.total_rewards || 0);
    const circulatingSupply = Number(totalRewardsNano) / 1_000_000_000;
    // Deterministic formatting (no locale differences between server/client)
    const circulatingFormatted = circulatingSupply.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    
    // Real count from heartbeats - 0 if no activity
    const activeNodes = Number(nodesResult.rows[0]?.active_nodes || 0);
    
    return {
      activeNodes,
      currentRound: rewardEpoch,
      height,
      blocksUntilReward,
      secondsUntilReward,
      circulatingSupply: Math.floor(circulatingSupply),
      circulatingFormatted
    };
  } catch (error) {
    console.error('[SSR] Stats error:', error);
    // Return null - will show dashes (network not available)
    return null;
  }
}

// Force dynamic rendering
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function HomePage() {
  // Fetch data on server - renders IMMEDIATELY with real data
  const initialStats = await getNetworkStats();
  
  return <HomeClient initialStats={initialStats} />;
}
