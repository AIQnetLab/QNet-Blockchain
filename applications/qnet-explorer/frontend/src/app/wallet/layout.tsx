import InAppGuard from '@/components/InAppGuard';
import AreaTexts from '@/i18n/area';
import { pageMetadata } from '@/i18n/server';

export const generateMetadata = () => pageMetadata(['ui_app_name'], 'wallet_page_lead');

// Not part of the QNet app's view: there this page goes to the explorer (src/components/InAppGuard.tsx).
// React.ReactNode is the children type Next.js checks a layout against (its route types).
export default function Layout({ children }: { children: React.ReactNode }) {
  return <InAppGuard><AreaTexts area="wallet">{children}</AreaTexts></InAppGuard>;
}
