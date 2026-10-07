'use client';

// The frame of every My node page: the title; without a wallet the connect screen; with one, the wallet (its full
// address, how it was connected, Disconnect), the way to a running node, the sections and the section itself.

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useWallet } from '@/contexts/AppContext';
import { usePaymentRecords } from '@/hooks/usePaymentRecords';
import { t, type MessageKey } from '@/lib/texts';
import { isUnfinished, pinnedWallet } from '@/lib/cabinet/flow';
import { TAB_HREF, visibleTabs, type Tab } from '@/lib/cabinet/tabs';
import type { WalletSource } from '@/lib/cabinet/wallet-choice';
import CabinetProgress from './CabinetProgress';
import { useCabinet } from './CabinetProvider';
import ConnectScreen from './ConnectScreen';

const TAB_LABEL: Record<Tab, MessageKey> = {
  overview: 'nav_overview',
  activate: 'nav_activate',
  device: 'nav_device',
  history: 'nav_history',
};

const SOURCE_TEXT: Record<WalletSource, MessageKey> = {
  extension: 'wallet_source_extension',
  app: 'wallet_source_app',
  'app-qr': 'wallet_source_app_qr',
  entered: 'wallet_source_entered',
};

// The connected wallet: its whole address, which a tap copies, how it was connected, and Disconnect.
function WalletCard() {
  const { choice, forget } = useCabinet();
  const { accounts, disconnect } = useWallet();
  const [copy, setCopy] = useState<'idle' | 'copied' | 'blocked'>('idle');
  useEffect(() => {
    if (copy !== 'copied') return;
    const timer = window.setTimeout(() => setCopy('idle'), 2_500);
    return () => window.clearTimeout(timer);
  }, [copy]);
  if (!choice) return null;
  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(choice.qnet);
      setCopy('copied');
    } catch {
      setCopy('blocked');
    }
  };
  // Disconnecting the extension's wallet also ends the extension's connection to this site.
  const leave = () => {
    if (choice.source === 'extension' && accounts?.qnet === choice.qnet) void disconnect();
    forget();
  };
  return (
    <div className="activate-card cabinet-wallet-card">
      <p className="cabinet-kicker">{t('wallet_label')}</p>
      <button type="button" className="cabinet-address" onClick={() => void copyAddress()} title={t('wallet_copy_label')}>
        {choice.qnet}
      </button>
      <p className={copy === 'copied' ? 'activate-result cabinet-copy-note' : 'activate-note'} aria-live="polite">
        {t(copy === 'copied' ? 'copied' : copy === 'blocked' ? 'copy_blocked' : 'wallet_copy_hint')}
      </p>
      <div className="cabinet-wallet-foot">
        <p>{t(SOURCE_TEXT[choice.source])}</p>
        <button type="button" className="qnet-button secondary" onClick={leave}>{t('wallet_disconnect')}</button>
      </div>
      {choice.source === 'app-qr' && <p className="activate-note">{t('wallet_from_qr')}</p>}
    </div>
  );
}

function Dashboard({ tab, children }: { tab: Tab; children: ReactNode }) {
  const { choice, view } = useCabinet();
  // An activation of this browser for this wallet (or for none yet) that is not finished keeps Activate in reach.
  const records = usePaymentRecords();
  const openActivation = (records ?? []).some((r) => isUnfinished(r) && (pinnedWallet(r) === null || pinnedWallet(r) === choice?.qnet));
  return (
    <>
      <CabinetProgress connected view={view} />
      <WalletCard />
      <nav className="cabinet-nav" aria-label={t('nav_label')}>
        {visibleTabs(view.state, openActivation, tab).map((key) => (
          <Link key={key} href={TAB_HREF[key]} className="cabinet-nav-link" aria-current={key === tab ? 'page' : undefined}>
            {t(TAB_LABEL[key])}
          </Link>
        ))}
      </nav>
      {children}
    </>
  );
}

// `open`: the section shows without a wallet too (an unfinished activation of this browser); null while the page is still
// finding that out.
export default function CabinetFrame({ tab, open = false, children }: { tab: Tab; open?: boolean | null; children?: ReactNode }) {
  const { ready, choice } = useCabinet();
  let body: ReactNode = null;
  if (ready && choice) body = <Dashboard tab={tab}>{children}</Dashboard>;
  else if (ready && open) body = children;
  else if (ready && open === false) body = <ConnectScreen />;
  return (
    <div className="page-activate">
      <section className="explorer-section activate-page cabinet" data-section="node">
        <div className="explorer-header">
          <h2 className="section-title">{t('cabinet_title')}</h2>
          {ready && !choice && <p className="section-subtitle">{t('eligibility')}</p>}
        </div>
        {body}
      </section>
    </div>
  );
}
