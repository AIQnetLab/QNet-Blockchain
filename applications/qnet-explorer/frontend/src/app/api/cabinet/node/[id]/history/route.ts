import { query } from '../../../../../../../lib/db';
import { createEpochArchive } from '@/server/cabinet/epoch-archive';
import { nodeProxy } from '@/server/cabinet/node-proxy';

// The node cabinet: a light node's epochs one by one, counted or not, with the explorer archive's dates and moves to
// the wallet (src/server/cabinet/node-proxy.ts, epoch-archive.ts).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const archive = createEpochArchive((text, params) => query(text, params));

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return nodeProxy().history(request, id, archive);
}
