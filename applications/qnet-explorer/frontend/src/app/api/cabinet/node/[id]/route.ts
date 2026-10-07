import { nodeProxy } from '@/server/cabinet/node-proxy';

// The node cabinet: a light node's public status from two genesis nodes, and its node balance
// (src/server/cabinet/node-proxy.ts). Per-request, on Node.js; the cache is this process's memory.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return nodeProxy().status(request, id);
}