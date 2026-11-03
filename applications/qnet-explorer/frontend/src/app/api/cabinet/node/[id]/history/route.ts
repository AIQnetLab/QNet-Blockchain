import { query } from '../../../../../../../lib/db';
import { createEpochArchive } from '@/server/cabinet/epoch-archive';
import { movePayloads } from '@/server/cabinet/move-payload';
import { nodeProxy } from '@/server/cabinet/node-proxy';
import { sharedUpstreamBudget } from '@/server/cabinet/upstream';

// The node cabinet: a light or a super node's epochs one by one, a page at a time, counted or not, with the explorer
// archive's dates and moves to the wallet, a move it keeps cut short read whole from a genesis node
// (src/server/cabinet/node-proxy.ts, epoch-archive.ts, move-payload.ts).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const archive = createEpochArchive((text, params) => query(text, params), Date.now, movePayloads(sharedUpstreamBudget()));

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return nodeProxy().history(request, id, archive);
}
