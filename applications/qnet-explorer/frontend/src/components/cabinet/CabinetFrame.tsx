'use client';

// The frame of every My node page: the title; without a wallet the connect screen; with one, the wallet (its full
// address, how it was connected, Disconnect), the way to a running node, the sections and the section itself. An
// address only viewed is no connection: in place of the wallet and the way, the line that it is viewed read only, with
// Stop viewing, and no Activate section.

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useWallet } from '@/contexts/AppContext';
import { usePaymentRecords } from '@/hooks/usePaymentRecords';
import { t, type MessageKey } from '@/lib/texts';
import { isUnfinished, pinnedWallet } from '@/lib/cabinet/flow';
import { TAB_HREF, visibleTabs, type Tab } from '@/lib/cabinet/tabs';
import type { WalletChoice, WalletSource } from '@/lib/cabinet/wallet-choice';
import { shortAddress } from '@/lib/qnet-provider';
import CabinetProgress from './CabinetProgress';
import { useCabinet } from './CabinetProvider';
import ConnectScreen from './ConnectScreen';

const TAB_LABEL: Record<Tab, MessageKey> = {
  overview: 'nav_overview',
  activate: 'nav_activate',
  device: 'nav_device',
  history: 'nav_history',
};

const SOURCE_TEXT: Record<Exclude<WalletSource, 'entered'>, MessageKey> = {
  extension: 'wallet_source_extension',
  app: 'wallet_source_app',
  'app-qr': 'wallet_source_app_qr',
};

// The whole address, which a tap copies.
function useCopy(address: string) {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'blocked'>('idle');
  useEffect(() => {
    if (copy !== 'copied') return;
    const timer = window.setTimeout(() => setCopy('idle'), 2_500);
    return () => window.clearTimeout(timer);
  }, [copy]);
  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopy('copied');
    } catch {
      setCopy('blocked');
    }
  };
  return { copy, copyAddress };
}

function CopyNote({ copy }: { copy: 'idle' | 'copied' | 'blocked' }) {
  return (
    <p className={copy === 'copied' ? 'activate-result cabinet-copy-note' : 'activate-note'} aria-live="polite">
      {t(copy === 'copied' ? 'copied' : copy === 'blocked' ? 'copy_blocked' : 'wallet_copy_hint')}
    </p>
  );
}

// The connected wallet: its whole address, which a tap copies, how it was connected, and Disconnect.
function WalletCard({ choice }: { choice: WalletChoice }) {
  const { forget } = useCabinet();
  const { accounts, disconnect } = useWallet();
  const { copy, copyAddress } = useCopy(choice.qnet);
  if (choice.source === 'entered') return null;
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
      <CopyNote copy={copy} />
      <div className="cabinet-wallet-foot">
        <p>{t(SOURCE_TEXT[choice.source])}</p>
        <button type="button" className="qnet-button secondary" onClick={leave}>{t('wallet_disconnect')}</button>
      </div>
      {choice.source === 'app-qr' && <p className="activate-note">{t('wallet_from_qr')}</p>}
    </div>
  );
}

// An address only viewed: that it is viewed read only, its whole address, and Stop viewing (back to the connect screen).
function ViewingCard({ qnet }: { qnet: string }) {
  const { stopViewing } = useCabinet();
  const { copy, copyAddress } = useCopy(qnet);
  return (
    <div className="activate-card cabinet-wallet-card">
      <p className="cabinet-kicker" role="status">{t('view_line', { wallet: shortAddress(qnet) })}</p>
      <button type="button" className="cabinet-address" onClick={() => void copyAddress()} title={t('wallet_copy_label')}>
        {qnet}
      </button>
      <CopyNote copy={copy} />
      <div className="cabinet-wallet-foot">
        <p>{t('view_note')}</p>
        <button type="button" className="qnet-button secondary" onClick={stopViewing}>{t('view_stop')}</button>
      </div>
    </div>
  );
}

function Dashboard({ choice, tab, children }: { choice: WalletChoice; tab: Tab; children: ReactNode }) {
  const { view, viewOnly } = useCabinet();
  // An activation of this browser for this wallet (or for none yet) that is not finished keeps Activate in reach.
  const records = usePaymentRecords();
  const openActivation = (records ?? []).some((r) => isUnfinished(r) && (pinnedWallet(r) === null || pinnedWallet(r) === choice.qnet));
  return (
    <>
      {viewOnly ? <ViewingCard qnet={choice.qnet} /> : (
        <>
          <CabinetProgress connected view={view} />
          <WalletCard choice={choice} />
        </>
      )}
      <nav className="cabinet-nav" aria-label={t('nav_label')}>
        {visibleTabs(view.state, openActivation, tab, viewOnly).map((key) => (
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
  if (ready && choice) body = <Dashboard choice={choice} tab={tab}>{children}</Dashboard>;
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
