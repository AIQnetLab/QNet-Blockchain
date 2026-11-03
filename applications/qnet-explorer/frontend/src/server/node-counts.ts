// The node counts of the last settled epoch the explorer shows (GET /api/network/stats): the super nodes the network
// admits that sent a heartbeat in it, admitted as the network's eligible set lists them (cabinet/eligible-set.ts, the
// newest certified macroblock's), so a node the network does not admit is counted nowhere; and the light nodes as the
// network's own bitmaps count them, the largest per-epoch sum of the last three. Read once an epoch and kept a minute;
// while the eligible set cannot be read the super nodes are not known (null), never counted without it.

import { within } from '../lib/deadline.ts';
import type { EligibleSet } from './cabinet/eligible-set.ts';

export const EPOCH_BLOCKS = 14_400;
export const NODE_COUNT_TTL_MS = 60_000;
// Counts without the admitted set are kept this long: the super nodes are asked again soon.
export const UNKNOWN_COUNT_TTL_MS = 5_000;
// The eligible set's read is waited for this long; a slower one serves the next read.
export const ELIGIBLE_COUNT_WAIT_MS = 3_000;

// Over the (tx_type, block) index, within the admitted ids.
export const ADMITTED_SUPERS_SQL = `SELECT count(DISTINCT from_address)::text AS c FROM transactions
 WHERE tx_type = 'Heartbeat' AND block >= $1 AND block < $2 AND from_address = ANY($3::text[])`;
export const LIGHT_NODES_SQL = `SELECT COALESCE(MAX(epoch_light), 0)::text AS c FROM (
 SELECT FLOOR(block / ${EPOCH_BLOCKS})::bigint AS epoch, SUM((tx_type_data->>'eligible_count')::bigint) AS epoch_light
 FROM transactions WHERE tx_type = 'LightNodeEligibilityBitmap' AND block >= $1 AND block < $2
 GROUP BY FLOOR(block / ${EPOCH_BLOCKS})) per_epoch`;

export interface NodeCounts {
  superNodes: number | null;
  lightNodes: number;
}

type Query = (text: string, params: unknown[]) => Promise<{ rows: { c: string }[] }>;

export function createNodeCounts(query: Query, eligible: EligibleSet, now: () => number = Date.now): (height: number) => Promise<NodeCounts> {
  let kept: { epoch: number; until: number; counts: NodeCounts } | null = null;
  return async (height) => {
    const epoch = Math.max(Math.floor(height / EPOCH_BLOCKS) - 1, 0);
    if (kept && kept.epoch === epoch && now() < kept.until) return kept.counts;
    const from = epoch * EPOCH_BLOCKS;
    const to = (epoch + 1) * EPOCH_BLOCKS;
    const admitted = await within(ELIGIBLE_COUNT_WAIT_MS, eligible().catch(() => null));
    const [supers, light] = await Promise.all([
      admitted === null ? null : query(ADMITTED_SUPERS_SQL, [from, to, [...admitted]]),
      query(LIGHT_NODES_SQL, [Math.max(epoch - 2, 0) * EPOCH_BLOCKS, to]),
    ]);
    const counts = { superNodes: supers === null ? null : Number(supers.rows[0]?.c ?? 0), lightNodes: Number(light.rows[0]?.c ?? 0) };
    kept = { epoch, until: now() + (counts.superNodes === null ? UNKNOWN_COUNT_TTL_MS : NODE_COUNT_TTL_MS), counts };
    return counts;
  };
}
