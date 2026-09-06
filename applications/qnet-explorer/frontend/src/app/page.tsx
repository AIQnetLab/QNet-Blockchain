import HomeClient from './HomeClient';
import { headHub } from '@/server/head-hub';

// Home statistics come from the process head snapshot (no per-request queries).
export const dynamic = 'force-dynamic';

const EPOCH = 14_400;

export default async function HomePage() {
  let initialStats: React.ComponentProps<typeof HomeClient>['initialStats'] = null;
  try {
    const s = await headHub.snapshot();
    const height = Math.max(s.height, 0);
    const emissionNano = BigInt(s.stats.emission_total || '0');
    const whole = emissionNano / 1_000_000_000n;
    const frac = (emissionNano % 1_000_000_000n).toString().padStart(9, '0').slice(0, 2);
    const blocksUntilReward = EPOCH - (height % EPOCH);
    initialStats = {
      activeNodes: 0,
      currentRound: Math.floor(height / EPOCH),
      height,
      blocksUntilReward,
      secondsUntilReward: blocksUntilReward,
      circulatingSupply: Number(whole),
      circulatingFormatted: `${whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`,
    };
  } catch (error) {
    console.error(`[ERR][WEB] home_ssr_failed err=${error instanceof Error ? error.message : String(error)}`);
  }
  return <HomeClient initialStats={initialStats} />;
}
