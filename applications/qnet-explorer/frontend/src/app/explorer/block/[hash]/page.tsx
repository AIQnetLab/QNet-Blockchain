import { GET as blockRoute } from '@/app/api/blocks/[hash]/route';
import { blockPath } from '@/lib/explorer-reads';
import { firstAnswer } from '@/server/first-answer';
import BlockClient from './BlockClient';

// The page renders with the block route's answer, so the block's transactions and groups are there from the first paint.
export const dynamic = 'force-dynamic';

export default async function BlockPage({ params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;
  return <BlockClient first={await firstAnswer(blockRoute, blockPath(hash), { hash })} />;
}
