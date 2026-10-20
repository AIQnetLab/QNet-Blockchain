import { cookies } from 'next/headers';
import ExplorerClient from './ExplorerClient';
import { headBlockFacts, headHub } from '@/server/head-hub';
import type { RecentBlock } from '@/lib/explorer-view';
import { STRIP_COOKIE, stripHidden } from '@/lib/strip-pref';

// The list page renders from the process head snapshot, with no query of its own: the HTML already carries the newest
// transactions, the readouts and the latest blocks (folded when the visitor hid them), and the client keeps them live
// over the head stream.
export const dynamic = 'force-dynamic';

export default async function ExplorerPage() {
  let initial: React.ComponentProps<typeof ExplorerClient>['initial'] = { rows: [], height: 0, total: 0, hash: null, timestamp: 0, emissionNano: '0', block: null };
  let blocks: RecentBlock[] = [];
  try {
    const s = await headHub.snapshot();
    blocks = s.blocks;
    initial = {
      rows: s.rows, height: Math.max(s.height, 0), total: s.stats.tx_total, hash: s.hash, timestamp: s.timestamp, emissionNano: String(s.stats.emission_total || '0'),
      block: headBlockFacts(s),
    };
  } catch (error) {
    console.error(`[ERR][WEB] explorer_ssr_failed err=${error instanceof Error ? error.message : String(error)}`);
  }
  const hidden = stripHidden((await cookies()).get(STRIP_COOKIE)?.value);
  return <ExplorerClient initial={initial} blocks={blocks} blocksHidden={hidden} />;
}
