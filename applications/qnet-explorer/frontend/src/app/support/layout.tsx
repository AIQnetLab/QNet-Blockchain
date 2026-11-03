import type { Metadata } from 'next';
import AreaTexts from '@/i18n/area';
import { pageMetadata } from '@/i18n/server';

// The Support page is a client component; its title and its texts (src/i18n/areas.ts) are set here.
export async function generateMetadata(): Promise<Metadata> {
  return pageMetadata(['support_title']);
}

// React.ReactNode is the children type Next.js checks a layout against (its route types).
export default function Layout({ children }: { children: React.ReactNode }) {
  return <AreaTexts area="support">{children}</AreaTexts>;
}
