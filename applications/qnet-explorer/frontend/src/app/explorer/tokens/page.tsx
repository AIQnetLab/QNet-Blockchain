import { GET as tokensRoute } from '@/app/api/tokens/route';
import { tokensPath } from '@/lib/explorer-reads';
import { firstAnswer } from '@/server/first-answer';
import TokensClient from './TokensClient';

// The page renders with the directory's first page, so its rows and count are final from the first paint.
export const dynamic = 'force-dynamic';

export default async function TokensPage() {
  return <TokensClient first={await firstAnswer(tokensRoute, tokensPath(1))} />;
}
