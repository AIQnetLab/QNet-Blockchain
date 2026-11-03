import { notFound } from 'next/navigation';
import InAppGuard from '@/components/InAppGuard';
import AreaTexts from '@/i18n/area';
import { pageMetadata } from '@/i18n/server';
import { ACTIVATION_NETWORK } from '@/lib/one-dev';

export const generateMetadata = () => pageMetadata(['hdr_testnet'], 'testnet_lead');

// Not part of the QNet app's view: there this page goes to the explorer (src/components/InAppGuard.tsx).
// A testnet release's page only: on a mainnet release it is not found, as the sitemap leaves it out.
// React.ReactNode is the children type Next.js checks a layout against (its route types).
export default function Layout({ children }: { children: React.ReactNode }) {
  if (ACTIVATION_NETWORK !== 'testnet') notFound();
  return <InAppGuard><AreaTexts area="testnet">{children}</AreaTexts></InAppGuard>;
}
