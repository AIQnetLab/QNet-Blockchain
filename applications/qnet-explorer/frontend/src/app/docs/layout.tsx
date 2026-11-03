import InAppGuard from '@/components/InAppGuard';
import { pageMetadata } from '@/i18n/server';

// How it works below sets its own title over this one.
export const generateMetadata = () => pageMetadata(['docs_title'], 'docs_lead');

// Not part of the QNet app's view: there this page goes to the explorer (src/components/InAppGuard.tsx).
// React.ReactNode is the children type Next.js checks a layout against (its route types).
export default function Layout({ children }: { children: React.ReactNode }) {
  return <InAppGuard>{children}</InAppGuard>;
}
