'use client';

// The frame of every My node page under its title band (app/node/layout.tsx): without a wallet the connect screen; with
// one, the sections (CabinetNav: a rail on a computer, a bar under the thumb on a phone) and the section itself. The
// wallet's address, Copy and Disconnect are the header's account menu. An address only viewed is no connection: the rail
// says it is viewed read only, with Stop viewing, and no Activate section is offered. Until the wallet is known the area
// keeps its room, so nothing below it moves when it fills in.

import type { ReactNode } from 'react';
import { usePaymentRecords } from '@/hooks/usePaymentRecords';
import { t } from '@/lib/texts';
import { isUnfinished, pinnedWallet } from '@/lib/cabinet/flow';
import { showJourney, type Tab } from '@/lib/cabinet/tabs';
import type { WalletChoice } from '@/lib/cabinet/wallet-choice';
import CabinetNav from './CabinetNav';
import CabinetProgress from './CabinetProgress';
import { useCabinet } from './CabinetProvider';
import ConnectScreen from './ConnectScreen';

function Dashboard({ choice, tab, children }: { choice: WalletChoice; tab: Tab; children: ReactNode }) {
  const { view, viewOnly } = useCabinet();
  // An activation of this browser for this wallet (or for none yet) that is not finished keeps Activate in reach.
  const records = usePaymentRecords();
  const openActivation = (records ?? []).some((r) => isUnfinished(r) && (pinnedWallet(r) === null || pinnedWallet(r) === choice.qnet));
  return (
    <>
      <CabinetNav tab={tab} openActivation={openActivation} />
      <div className="cab-main">
        {viewOnly && <p className="note cab-lead-note">{t('view_note')}</p>}
        {choice.source === 'app-qr' && <p className="note cab-lead-note">{t('wallet_from_qr')}</p>}
        {!viewOnly && showJourney(tab, true, view) && <CabinetProgress connected view={view} />}
        <div className="cab-view">{children}</div>
      </div>
    </>
  );
}

// `open`: the section shows without a wallet too (an unfinished activation of this browser); null while the page is still
// finding that out.
export default function CabinetFrame({ tab, open = false, children }: { tab: Tab; open?: boolean | null; children?: ReactNode }) {
  const { ready, choice } = useCabinet();
  let body: ReactNode = null;
  if (ready && choice) body = <Dashboard choice={choice} tab={tab}>{children}</Dashboard>;
  else if (ready && open) body = <div className="cab-main cab-wide">{children}</div>;
  else if (ready && open === false) body = <div className="cab-main cab-wide"><ConnectScreen /></div>;
  return <div className="wrap cab" data-section="node" data-nav={ready && choice ? '' : undefined}>{body}</div>;
}
