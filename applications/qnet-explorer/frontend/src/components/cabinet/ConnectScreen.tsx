'use client';

// My node before a wallet is connected: where the wallet is on its way, the ways to connect it, and how it works in
// short. The header's Connect wallet leads here (#connect) on a phone or tablet, or without the QNet extension.

import { useEffect, useRef } from 'react';
import { useActivationContent } from '@/contexts/AppContext';
import { t } from '@/lib/texts';
import { showConnectCard } from '@/lib/cabinet/connect-card';
import { CONNECT_ID } from '@/lib/cabinet/tabs';
import CabinetProgress from './CabinetProgress';
import { useCabinet } from './CabinetProvider';
import GuideSummary from './GuideSummary';
import WalletChoice from './WalletChoice';

export default function ConnectScreen() {
  const { phoneFlows } = useCabinet();
  const card = useRef<HTMLDivElement>(null);
  // The page is displayed once the wallet detection is over (src/components/InAppGuard.tsx).
  const shown = useActivationContent();
  // Arrived through the header's Connect wallet: the connect card is in view, focused and marked for a moment.
  useEffect(() => {
    if (!shown || window.location.hash !== `#${CONNECT_ID}`) return;
    if (card.current) showConnectCard(card.current, false);
  }, [shown]);
  return (
    <>
      <CabinetProgress connected={false} view={null} />
      <div className="cabinet-connect">
        <div className="activate-card cabinet-connect-card" id={CONNECT_ID} ref={card} tabIndex={-1} aria-labelledby="cabinet-connect-title">
          <h3 className="activate-step" id="cabinet-connect-title">{t('connect_title')}</h3>
          <p className="cabinet-lead">{t('connect_lead')}</p>
          <WalletChoice />
          <p className="activate-note">{t('wallet_remembered')}</p>
        </div>
        <GuideSummary phoneFlows={phoneFlows} />
      </div>
    </>
  );
}
