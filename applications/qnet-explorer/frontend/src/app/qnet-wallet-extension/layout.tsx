import InAppGuard from '@/components/InAppGuard';
import { pageMetadata } from '@/i18n/server';

export const generateMetadata = () => pageMetadata(['xp_title'], 'xp_lead');

// Not part of the QNet app's view: there this page goes to the explorer (src/components/InAppGuard.tsx).
// React.ReactNode is the children type Next.js checks a layout against (its route types).
export default function Layout({ children }: { children: React.ReactNode }) {
  return <InAppGuard>{children}</InAppGuard>;
}
