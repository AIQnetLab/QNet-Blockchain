import { solanaProxy } from '@/server/cabinet/solana-proxy';

// The node cabinet: a payment address's SOL and 1DEV (src/server/cabinet/solana-proxy.ts).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ address: string }> }): Promise<Response> {
  const { address } = await params;
  return solanaProxy().payment(request, address);
}