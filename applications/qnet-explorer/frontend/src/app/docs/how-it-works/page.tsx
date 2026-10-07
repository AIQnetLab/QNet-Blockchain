import type { Metadata } from 'next';
import NodeGuide from '@/components/cabinet/NodeGuide';
import { phoneFlowsEnabled } from '@/server/phone-flows';
import { pageTitle, t } from '@/lib/texts';

export const metadata: Metadata = { title: pageTitle('guide_title', 'cabinet_title'), description: t('guide_lead') };

// How it works, in the header's Docs menu: readable without a wallet, every step of the three ways with pictures.
// Rendered per request, so the steps follow the running server's CABINET_PHONE_FLOWS, never the build's.
export const dynamic = 'force-dynamic';

export default function HowItWorksPage() {
  return <NodeGuide phoneFlows={phoneFlowsEnabled()} />;
}
