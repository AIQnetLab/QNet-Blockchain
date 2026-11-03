import { query } from '../../../../../lib/db';
import { activationApi } from '@/server/cabinet/activation-api';
import { solanaProxy } from '@/server/cabinet/solana-proxy';

// QNet Wallet's and the QNet extension's Solana calls when their Solana endpoint gives them no answer: one JSON-RPC
// request of the wallets' methods, a transaction only in a shape the wallets build, the extension's activation burn only
// once announced in the activation registry (src/server/cabinet/solana-relay.ts).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const api = activationApi((text, values) => query(text, values));
  return solanaProxy().relay(request, (burnTx) => api.announcedBurn(burnTx));
}
