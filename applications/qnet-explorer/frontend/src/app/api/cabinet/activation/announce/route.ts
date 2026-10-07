import { query } from '../../../../../../lib/db';
import { activationApi } from '@/server/cabinet/activation-api';

// The node cabinet's activation registry: the QNet extension announces its burn under the wallet's reservation, with the wallet's proof, before it sends it
// (src/server/cabinet/activation-api.ts).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return activationApi((text, values) => query(text, values)).announce(request);
}
