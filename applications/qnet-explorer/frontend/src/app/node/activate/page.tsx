import type { Metadata } from 'next';
import NodeActivate from '@/components/cabinet/NodeActivate';
import { pageTitle } from '@/lib/texts';

export const metadata: Metadata = { title: pageTitle('activate_title', 'cabinet_title'), robots: { index: false, follow: true } };

// The only route that loads the payment key (src/lib/cabinet/payment-key.ts).
export default function NodeActivatePage() {
  return <NodeActivate />;
}
