import { query } from '../../../../../../lib/db';
import { createLastHeartbeat } from '@/server/cabinet/epoch-archive';
import { nodeProxy } from '@/server/cabinet/node-proxy';

// The node cabinet: a super node's status from the genesis nodes, when it was last seen (from the nodes, else the
// explorer archive's newest heartbeat), its heartbeats this epoch and its node balance (src/server/cabinet/node-proxy.ts).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const lastHeartbeat = createLastHeartbeat((text, values) => query(text, values));

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return nodeProxy().superStatus(request, id, lastHeartbeat);
}
