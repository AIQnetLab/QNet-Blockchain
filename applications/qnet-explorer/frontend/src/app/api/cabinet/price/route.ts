import { solanaProxy } from '@/server/cabinet/solana-proxy';

// The node cabinet: the light activation price two genesis nodes agree on (src/server/cabinet/solana-proxy.ts).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return solanaProxy().price(request);
}