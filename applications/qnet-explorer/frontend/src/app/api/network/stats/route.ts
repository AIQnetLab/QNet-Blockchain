import { NextResponse } from 'next/server';
import { headHub } from '@/server/head-hub';
import { sharedEligibleSet } from '@/server/cabinet/eligible-set';
import { EPOCH_BLOCKS, createNodeCounts } from '@/server/node-counts';
import { formatQncTruncated } from '@/lib/token-format';
import { query } from '../../../../../lib/db';

export const dynamic = 'force-dynamic';

// Network stats: head/counters from the process head cache; the last settled epoch's node counts, the super nodes only
// those the network admits (src/server/node-counts.ts).

const activeNodeCounts = createNodeCounts((text, params) => query<{ c: string }>(text, params), sharedEligibleSet());

export async function GET() {
  try {
    const s = await headHub.snapshot();
    const height = Math.max(s.height, 0);
    const nodes = await activeNodeCounts(height);
    const rewardEpoch = Math.floor(height / EPOCH_BLOCKS);
    const blocksUntilReward = EPOCH_BLOCKS - (height % EPOCH_BLOCKS);
    const emissionNano = BigInt(s.stats.emission_total || '0');
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
        circulatingSupply: Number(emissionNano / 1_000_000_000n),
        circulatingFormatted: formatQncTruncated(emissionNano, 2),
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
