import { GET as txRoute } from '@/app/api/tx/[hash]/route';
import { txPath } from '@/lib/explorer-reads';
import { firstAnswer } from '@/server/first-answer';
import TransactionClient from './TransactionClient';

// The page renders with the transaction route's answer, so the record's groups are there from the first paint.
export const dynamic = 'force-dynamic';

export default async function TransactionPage({ params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;
  return <TransactionClient first={await firstAnswer(txRoute, txPath(hash), { hash })} />;
}
