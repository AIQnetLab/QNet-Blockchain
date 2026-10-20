import HomeClient from './HomeClient';
import InAppGuard from '@/components/InAppGuard';
import type { RecentBlock } from '@/lib/explorer-view';
import { headHub } from '@/server/head-hub';

// The home page's first values come from the process head snapshot (no per-request queries): the newest blocks for the
// live column, the head for the readouts and the emission so far for the supply. The node counts follow on the client.
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  let initialStats: React.ComponentProps<typeof HomeClient>['initialStats'] = null;
  let blocks: RecentBlock[] = [];
  try {
    const s = await headHub.snapshot();
    initialStats = { height: Math.max(s.height, 0), emissionNano: String(s.stats.emission_total || '0') };
    blocks = s.blocks;
  } catch (error) {
    console.error(`[ERR][WEB] home_ssr_failed err=${error instanceof Error ? error.message : String(error)}`);
  }
  // Not part of the QNet app's view (the tokenomics describe activation and its cost): there it goes to the explorer.
  return (
    <InAppGuard>
      <HomeClient initialStats={initialStats} blocks={blocks} />
    </InAppGuard>
  );
}
