import type { Metadata } from 'next';
import NodeActivate from '@/components/cabinet/NodeActivate';
import { pageMetadata } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  return { ...(await pageMetadata(['activate_title', 'cabinet_title'])), robots: { index: false, follow: true } };
}

// The only route that loads the payment key (src/lib/cabinet/payment-key.ts).
export default function NodeActivatePage() {
  return <NodeActivate />;
}
