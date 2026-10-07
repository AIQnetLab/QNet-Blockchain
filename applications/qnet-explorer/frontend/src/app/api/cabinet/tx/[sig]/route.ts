import { solanaProxy } from '@/server/cabinet/solana-proxy';

// The node cabinet: a Solana transaction's state and, once final, the light burn it holds
// (src/server/cabinet/solana-proxy.ts). `lvh`: the last block height its blockhash is valid for; `pass`: the read pass
// /api/cabinet/send gave for it.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ sig: string }> }): Promise<Response> {
  const { sig } = await params;
  const query = new URL(request.url).searchParams;
  return solanaProxy().tx(request, sig, query.get('lvh'), query.get('pass'));
}
