import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import NodeHome from '@/components/cabinet/NodeHome';
import { tabRoute } from '@/lib/cabinet/tabs';
import { getI18n, pageMetadata } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  return pageMetadata(['cabinet_title'], 'cabinet_description');
}

// /node?tab=<section> opens that section's page in the page's language (an address that names English keeps /en/), with
// the rest of the query (the guide's ?way=) carried along; ?tab=overview keeps the Overview even for a wallet without a
// node, which a bare /node sends to Activate.
export default async function NodePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { tab, ...rest } = await searchParams;
  const route = tabRoute(tab);
  if (route) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(rest)) for (const one of [value].flat()) if (typeof one === 'string') query.append(key, one);
    const kept = query.toString();
    redirect((await getI18n()).href(kept ? `${route}${route.includes('?') ? '&' : '?'}${kept}` : route));
  }
  return <NodeHome explicit={tab === 'overview'} />;
}
