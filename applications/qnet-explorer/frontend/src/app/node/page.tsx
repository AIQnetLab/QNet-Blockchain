import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import NodeHome from '@/components/cabinet/NodeHome';
import { tabRoute } from '@/lib/cabinet/tabs';
import { pageTitle, t } from '@/lib/texts';

export const metadata: Metadata = { title: pageTitle('cabinet_title'), description: t('cabinet_description') };

// /node?tab=<section> opens that section's page, with the rest of the query (the app's ?from=app marker, the guide's
// ?way=) carried along (LD-07); ?tab=overview keeps the Overview even for a wallet without a node, which a bare /node
// sends to Activate.
export default async function NodePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { tab, ...rest } = await searchParams;
  const route = tabRoute(tab);
  if (route) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(rest)) for (const one of [value].flat()) if (typeof one === 'string') query.append(key, one);
    const kept = query.toString();
    redirect(kept ? `${route}${route.includes('?') ? '&' : '?'}${kept}` : route);
  }
  return <NodeHome explicit={tab === 'overview'} />;
}
