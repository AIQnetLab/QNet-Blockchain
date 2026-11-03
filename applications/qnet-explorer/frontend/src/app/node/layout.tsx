import InAppGuard from '@/components/InAppGuard';
import { CabinetProvider } from '@/components/cabinet/CabinetProvider';
import PageHead from '@/components/ui/PageHead';
import { phoneFlowsEnabled } from '@/server/phone-flows';
import AreaTexts from '@/i18n/area';
import { getI18n } from '@/i18n/server';

// The node cabinet (aiqnet.io/node). Not part of the QNet app's view: there it goes to the explorer
// (src/components/InAppGuard.tsx), so the app's own browser never shows a cabinet page. The wallet the pages show,
// and whether they send QNet Wallet requests yet (src/server/phone-flows.ts), are shared by CabinetProvider.
// Rendered per request, so CABINET_PHONE_FLOWS is the running server's, never the build's.
export const dynamic = 'force-dynamic';

// React.ReactNode is the children type Next.js checks a layout against (its route types). The title band is the
// layout's, so moving between the sections keeps it and its field running; the sections get My node's texts.
export default async function Layout({ children }: { children: React.ReactNode }) {
  const { t } = await getI18n();
  return (
    <InAppGuard>
      <CabinetProvider phoneFlows={phoneFlowsEnabled()}>
        <PageHead title={t('cabinet_title')} strength={0.32} kind="cabinet" opacity={0.7} />
        <AreaTexts area="node">{children}</AreaTexts>
      </CabinetProvider>
    </InAppGuard>
  );
}
