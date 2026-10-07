import { query } from '../../../../../../lib/db';
import { activationApi } from '@/server/cabinet/activation-api';

// The node cabinet: a QNet wallet's activation as the server records it, from any browser or device, with the search of
// the wallet's own Solana address when ?solana= names it (src/server/cabinet/activation-api.ts).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ wallet: string }> }): Promise<Response> {
  const { wallet } = await params;
  return activationApi((text, values) => query(text, values)).get(request, wallet);
}
