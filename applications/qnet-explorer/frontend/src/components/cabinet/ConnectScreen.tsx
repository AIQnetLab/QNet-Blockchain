'use client';

// My node before a wallet is connected: the connect card with its one main action and the other ways (WalletChoice),
// and apart from it, quieter, View by address and How it works in short. The header's Connect wallet leads here
// (#connect) on a phone or tablet and starts QNet Wallet's request on the card.

import { useEffect, useRef } from 'react';
import { useActivationContent } from '@/contexts/AppContext';
import { t } from '@/lib/texts';
import { showConnectCard } from '@/lib/cabinet/connect-card';
import { CONNECT_ID } from '@/lib/cabinet/tabs';
import { useCabinet } from './CabinetProvider';
import GuideSummary from './GuideSummary';
import WalletChoice, { ViewByAddress } from './WalletChoice';

export default function ConnectScreen() {
  const { phoneFlows } = useCabinet();
  const card = useRef<HTMLElement>(null);
  // The page is displayed once the wallet detection is over (src/components/InAppGuard.tsx).
  const shown = useActivationContent();
  // Arrived through the header's Connect wallet: the connect card is in view, focused and marked for a moment.
  useEffect(() => {
    if (!shown || window.location.hash !== `#${CONNECT_ID}`) return;
    if (card.current) showConnectCard(card.current, false);
  }, [shown]);
  return (
    <div className="cab-connect">
      <section className="cab-connect-ways" id={CONNECT_ID} ref={card} tabIndex={-1} aria-labelledby="cabinet-connect-title">
        <h2 className="sr-only" id="cabinet-connect-title">{t('connect_title')}</h2>
        <p className="lead">{t('connect_lead')}</p>
        <WalletChoice />
        <p className="note">{t('wallet_remembered')}</p>
      </section>
      <div className="cab-connect-more">
        <ViewByAddress />
        <GuideSummary phoneFlows={phoneFlows} />
      </div>
    </div>
  );
}
