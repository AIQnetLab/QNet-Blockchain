import { query } from '../../../../../../lib/db';
import { activationApi } from '@/server/cabinet/activation-api';

// The node cabinet's activation registry: holds a wallet for one burn, of either node type and either way, for ten minutes,
// only with the wallet's own signed reservation (src/server/cabinet/activation-api.ts).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return activationApi((text, values) => query(text, values)).reserve(request);
}
