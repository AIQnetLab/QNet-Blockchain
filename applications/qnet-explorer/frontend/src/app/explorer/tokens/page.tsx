import { GET as tokensRoute } from '@/app/api/tokens/route';
import { tokensPath } from '@/lib/explorer-reads';
import { pageMetadata } from '@/i18n/server';
import { firstAnswer } from '@/server/first-answer';
import TokensClient from './TokensClient';

export const generateMetadata = () => pageMetadata(['tokens_title', 'hdr_explorer'], 'tokens_lead');

// The page renders with the directory's first page, so its rows and count are final from the first paint.
export const dynamic = 'force-dynamic';

export default async function TokensPage() {
  return <TokensClient first={await firstAnswer(tokensRoute, tokensPath(1))} />;
}
