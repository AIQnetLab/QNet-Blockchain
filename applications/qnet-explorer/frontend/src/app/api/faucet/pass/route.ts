import { getRateLimitKey } from '../../../../../lib/rate-limit';
import { faucetEnvironment } from '@/server/faucet-config';
import { createFaucetPassRoute } from '@/server/faucet-pass';

// The faucet pass for the QNet wallet the node cabinet activates (src/server/faucet-pass.ts): the /testnet faucet keeps
// most of each hour's claims for claims that carry one.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const route = createFaucetPassRoute({ clientKey: getRateLimitKey, testnet: () => faucetEnvironment() === 'testnet' });

export async function POST(request: Request): Promise<Response> {
  return route(request);
}
