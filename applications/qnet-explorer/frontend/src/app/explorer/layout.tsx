import AreaTexts from '@/i18n/area';
import { pageMetadata } from '@/i18n/server';

// The list's title; each page below names its own part of the explorer over it.
export const generateMetadata = () => pageMetadata(['hdr_explorer'], 'ex_lead');

// The explorer's texts for its pages and their loading states (src/i18n/areas.ts).
export default function Layout({ children }: { children: React.ReactNode }) {
  return <AreaTexts area="explorer">{children}</AreaTexts>;
}
