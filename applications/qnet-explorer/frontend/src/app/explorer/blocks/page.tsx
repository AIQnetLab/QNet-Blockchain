import { GET as blocksRoute } from '@/app/api/blocks/route';
import { blocksPath } from '@/lib/explorer-reads';
import { blocksAnchor, heightOf } from '@/lib/explorer-view';
import { firstAnswer } from '@/server/first-answer';
import { headHub } from '@/server/head-hub';
import BlocksClient from './BlocksClient';

// The block history renders with its page's rows: the newest blocks, or with ?at=H the page that starts at height H,
// placed in the pages counted from the head (src/lib/explorer-view.ts blocksAnchor).
export const dynamic = 'force-dynamic';

export default async function BlocksPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { at } = await searchParams;
  let head: number | null = null;
  try {
    const s = await headHub.snapshot();
    if (s.height >= 0) head = s.height;
  } catch (error) {
    console.error(`[ERR][WEB] blocks_ssr_head_failed err=${error instanceof Error ? error.message : String(error)}`);
  }
  // Without the head the client places the page once the head stream names it.
  if (head === null) return <BlocksClient first={null} />;
  const asked = typeof at === 'string' ? heightOf(at) : null;
  const top = Math.min(asked ?? head, head);
  return <BlocksClient first={await firstAnswer(blocksRoute, blocksPath(top))} top={top} anchor={blocksAnchor(top, head)} />;
}
