import { query } from '../../../../../../lib/db';
import { activationApi } from '@/server/cabinet/activation-api';

// The node cabinet's activation registry: gives up a reservation without a burn, or a payment burn nobody consented to
// (src/server/cabinet/activation-api.ts).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return activationApi((text, values) => query(text, values)).release(request);
}
