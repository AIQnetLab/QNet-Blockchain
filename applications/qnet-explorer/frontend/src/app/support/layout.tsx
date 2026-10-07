import type { Metadata } from 'next';
import { pageTitle } from '@/lib/texts';

// The Support page is a client component; its title is set here.
export const metadata: Metadata = { title: pageTitle('support_title') };

// React.ReactNode is the children type Next.js checks a layout against (its route types).
export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
