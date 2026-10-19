import HomeClient from './HomeClient';
import InAppGuard from '@/components/InAppGuard';
import { headHub } from '@/server/head-hub';
import { formatQncTruncated } from '@/lib/token-format';

// Home statistics come from the process head snapshot (no per-request queries).
export const dynamic = 'force-dynamic';

const EPOCH = 14_400;

export default async function HomePage() {
  let initialStats: React.ComponentProps<typeof HomeClient>['initialStats'] = null;
  try {
    const s = await headHub.snapshot();
    const height = Math.max(s.height, 0);
    const emissionNano = BigInt(s.stats.emission_total || '0');
    const blocksUntilReward = EPOCH - (height % EPOCH);
    initialStats = {
      activeNodes: 0,
      currentRound: Math.floor(height / EPOCH),
      height,
      blocksUntilReward,
      secondsUntilReward: blocksUntilReward,
      circulatingSupply: Number(emissionNano / 1_000_000_000n),
      circulatingFormatted: formatQncTruncated(emissionNano, 2),
    };
  } catch (error) {
    console.error(`[ERR][WEB] home_ssr_failed err=${error instanceof Error ? error.message : String(error)}`);
  }
  // Not part of the QNet app's view (the tokenomics describe activation and its cost): there it goes to the explorer.
  return (
    <InAppGuard>
      <HomeClient initialStats={initialStats} />
    </InAppGuard>
  );
}
