import { walletNode } from '@/server/cabinet/wallet-node';

// The node cabinet: whether a QNet wallet has a node on the network, of either type (src/server/cabinet/wallet-node.ts).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ wallet: string }> }): Promise<Response> {
  const { wallet } = await params;
  return walletNode().route(request, wallet);
}
