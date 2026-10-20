import { GET as tokenRoute } from '@/app/api/token/[contract]/route';
import { GET as holdersRoute } from '@/app/api/token/[contract]/holders/route';
import { TOKEN_HOLDERS_FIRST, TOKEN_TRANSFERS_FIRST, tokenHoldersPath, tokenPath } from '@/lib/explorer-reads';
import { firstAnswer, nodeAnswer } from '@/server/first-answer';
import TokenClient from './TokenClient';

// The page renders with the holders' first answer from the explorer's index and the token's record as last kept from the
// node (never waited for), so its head and tables are final from the first paint once the token was read before.
export const dynamic = 'force-dynamic';

export default async function TokenPage({ params }: { params: Promise<{ contract: string }> }) {
  const { contract } = await params;
  const token = nodeAnswer(tokenRoute, tokenPath(contract, TOKEN_TRANSFERS_FIRST), { contract });
  return <TokenClient first={{ token, holders: await firstAnswer(holdersRoute, tokenHoldersPath(contract, TOKEN_HOLDERS_FIRST), { contract }) }} />;
}
