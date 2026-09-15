import { NextResponse } from 'next/server';
import { headHub } from '@/server/head-hub';
import { query } from '../../../../../lib/db';

export const dynamic = 'force-dynamic';

// Network stats: head/counters from the process head cache; active-node counts are per sealed epoch
// (window queries over the (tx_type, block) index) and change once an epoch, so they are cached 60 s.

const EPOCH = 14_400;
const NODE_COUNT_TTL_MS = 60_000;
let nodeCounts: { epoch: number; superNodes: number; lightNodes: number; at: number } | null = null;

async function activeNodeCounts(height: number): Promise<{ superNodes: number; lightNodes: number }> {
  const pe = Math.max(Math.floor(height / EPOCH) - 1, 0);
  const now = Date.now();
  if (nodeCounts && nodeCounts.epoch === pe && now - nodeCounts.at < NODE_COUNT_TTL_MS) {
    return { superNodes: nodeCounts.superNodes, lightNodes: nodeCounts.lightNodes };
  }
  const [sup, light] = await Promise.all([
    query<{ c: string }>(
      `SELECT count(DISTINCT from_address) AS c FROM transactions WHERE tx_type = 'Heartbeat' AND block >= $1 AND block < $2`,
      [pe * EPOCH, (pe + 1) * EPOCH]),
    query<{ c: string }>(
      `SELECT COALESCE(MAX(epoch_light), 0)::text AS c FROM (
         SELECT FLOOR(block / ${EPOCH})::bigint AS epoch, SUM((tx_type_data->>'eligible_count')::bigint) AS epoch_light
         FROM transactions WHERE tx_type = 'LightNodeEligibilityBitmap' AND block >= $1 AND block < $2
         GROUP BY FLOOR(block / ${EPOCH})) per_epoch`,
      [Math.max(pe - 2, 0) * EPOCH, (pe + 1) * EPOCH]),
  ]);
  nodeCounts = { epoch: pe, superNodes: Number(sup.rows[0]?.c || 0), lightNodes: Number(light.rows[0]?.c || 0), at: now };
  return { superNodes: nodeCounts.superNodes, lightNodes: nodeCounts.lightNodes };
}

export async function GET() {
  try {
    const s = await headHub.snapshot();
    const height = Math.max(s.height, 0);
    const nodes = await activeNodeCounts(height);
    const rewardEpoch = Math.floor(height / EPOCH);
    const blocksUntilReward = EPOCH - (height % EPOCH);
    const emissionNano = BigInt(s.stats.emission_total || '0');
    const whole = emissionNano / 1_000_000_000n;
    const frac = (emissionNano % 1_000_000_000n).toString().padStart(9, '0').slice(0, 2);
    const circulatingFormatted = `${whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`;
    return NextResponse.json({
      success: true,
      source: 'database',
      data: {
        activeNodes: nodes.superNodes,
        activeLightNodes: nodes.lightNodes,
        currentRound: rewardEpoch,
        height,
        blocksUntilReward,
        secondsUntilReward: blocksUntilReward,
        circulatingSupply: Number(whole),
        circulatingFormatted,
        totalTransactions: s.stats.tx_total,
        totalBlocks: s.stats.blocks_total,
        sync: { head: s.sync.last_height, prefix: s.sync.indexed_prefix, nodeHeight: s.sync.node_height, live: s.sync.ws_connected },
      },
    }, { headers: { 'Cache-Control': 'public, s-maxage=1, stale-while-revalidate=4' } });
  } catch (error) {
    console.error(`[ERR][API] stats_failed err=${error instanceof Error ? error.message : String(error)}`);
    return NextResponse.json({ success: false, data: null }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
