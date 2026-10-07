import { notFound } from 'next/navigation';
import InAppGuard from '@/components/InAppGuard';
import { ACTIVATION_NETWORK } from '@/lib/one-dev';

// Not part of the QNet app's view: there this page goes to the explorer (src/components/InAppGuard.tsx).
// A testnet release's page only: on a mainnet release it is not found, as the sitemap leaves it out (SITE-F14).
// React.ReactNode is the children type Next.js checks a layout against (its route types).
export default function Layout({ children }: { children: React.ReactNode }) {
  if (ACTIVATION_NETWORK !== 'testnet') notFound();
  return <InAppGuard>{children}</InAppGuard>;
}
