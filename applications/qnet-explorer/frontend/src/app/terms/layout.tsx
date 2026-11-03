import AreaTexts from '@/i18n/area';
import { pageMetadata } from '@/i18n/server';

export const generateMetadata = () => pageMetadata(['support_legal_terms'], 'privacy_lead');

// The terms' texts reach the browser on this page alone (src/i18n/areas.ts).
export default function Layout({ children }: { children: React.ReactNode }) {
  return <AreaTexts area="terms">{children}</AreaTexts>;
}
