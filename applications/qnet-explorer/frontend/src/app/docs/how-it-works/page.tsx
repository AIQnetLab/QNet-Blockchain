import type { Metadata } from 'next';
import { headers } from 'next/headers';
import NodeGuide from '@/components/cabinet/NodeGuide';
import { installTarget } from '@/lib/install-target';
import { phoneFlowsEnabled } from '@/server/phone-flows';
import AreaTexts from '@/i18n/area';
import { pageMetadata } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  return pageMetadata(['guide_title', 'cabinet_title'], 'guide_lead');
}

// How it works, in the header's Docs menu: readable without a wallet, every step of the three ways with pictures.
// Rendered per request, so the steps follow the running server's CABINET_PHONE_FLOWS, never the build's, and the way
// shown first follows the device that asked (a phone or tablet: Phone only), from the first paint.
export const dynamic = 'force-dynamic';

export default async function HowItWorksPage() {
  const phone = installTarget((await headers()).get('user-agent')) !== 'desktop';
  return (
    <AreaTexts area="guide">
      <NodeGuide phoneFlows={phoneFlowsEnabled()} phone={phone} />
    </AreaTexts>
  );
}
