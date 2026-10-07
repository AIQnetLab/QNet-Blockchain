import { solanaProxy } from '@/server/cabinet/solana-proxy';

// The node cabinet: a recent Solana blockhash for the payment key's transactions (src/server/cabinet/solana-proxy.ts).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return solanaProxy().blockhash(request);
}