'use client';

// Header wallet control. Outside the QNet app's view it connects the way My node (/node) does: on a computer with the
// QNet extension, Connect wallet asks the extension at once (its approval window opens, as with the connect card's
// "QNet extension on this computer") and My node keeps that wallet and opens; on a phone or tablet, or without the
// extension, it leads to My node's connect card (on a page that shows the card it brings the card into view and marks
// it). Once My node remembers a wallet the control shows that wallet and leads to it. In the app's view the app's own
// provider connects here as before, and no page about the wallet, its activation or an install is offered. Addresses
// reach this component only after validation, and every value is rendered as text.

import { useEffect, useId, useRef, useState, type MouseEvent } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useActivationContent, useWallet } from '@/contexts/AppContext';
import { chooseWallet, useHeldWallet } from '@/components/cabinet/CabinetProvider';
import { useDeviceKind } from '@/hooks/useDeviceKind';
import { showConnectCard } from '@/lib/cabinet/connect-card';
import { CONNECT_ID, isNodePath } from '@/lib/cabinet/tabs';
import { shortAddress, type AddressView } from '@/lib/qnet-provider';

const VIEWS: { key: AddressView; label: string }[] = [
  { key: 'qnet', label: 'QNet' },
  { key: 'solana', label: 'Solana' },
];

// On a page that shows My node's connect card it is already there: brought into view and marked instead of navigating.
function toConnect(event: MouseEvent<HTMLAnchorElement>) {
  const card = document.getElementById(CONNECT_ID);
  if (!card) return;
  event.preventDefault();
  showConnectCard(card, true);
}

export default function ConnectWalletButton() {
  const { providerStatus, providerChannel, accounts, view, connecting, error, connect, disconnect, setView, clearError } = useWallet();
  // False in the QNet app's view (src/lib/activate-view.ts), where no page about the wallet may be offered.
  const fullView = useActivationContent();
  const held = useHeldWallet();
  const device = useDeviceKind();
  const router = useRouter();
  const pathname = usePathname();
  // Outside the app's view, a computer with the QNet extension connects from here at once.
  const direct = fullView && providerStatus === 'available' && providerChannel === 'extension' && device !== null && !device.phone;
  const [asked, setAsked] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!accounts) setMenuOpen(false);
    setCopied(false);
    setCopyFailed(false);
  }, [accounts, view]);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(t);
  }, [copied]);

  // A wallet error goes away by itself after a few seconds; the x still closes it at once (owner, 28.09).
  useEffect(() => {
    if (!error) return;
    const t = window.setTimeout(() => clearError(), 6000);
    return () => window.clearTimeout(t);
  }, [error, clearError]);

  // The extension shared its wallet after this control asked: My node keeps it as a wallet connected with a tap, and
  // opens unless this is one of its pages already.
  useEffect(() => {
    if (!asked || !accounts) return;
    setAsked(false);
    chooseWallet({ qnet: accounts.qnet, source: 'extension', solana: accounts.solana });
    if (!isNodePath(pathname)) router.push('/node');
  }, [asked, accounts, pathname, router]);

  // Declined, or not answered: the ask ends with the wallet's error shown below.
  useEffect(() => {
    if (asked && !connecting && error) setAsked(false);
  }, [asked, connecting, error]);

  const connectExtension = () => {
    setAsked(true);
    if (!accounts) void connect();
  };

  const address = accounts ? accounts[view] : null;

  const copy = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopyFailed(false);
      setCopied(true);
    } catch {
      setCopyFailed(true);
    }
  };

  const errorNote = error ? (
    <div className="wallet-error" role="alert">
      <span>{error}</span>
      <button type="button" className="wallet-error-close" onClick={clearError} aria-label="Dismiss">
        ×
      </button>
    </div>
  ) : null;

  if (providerStatus === 'detecting') {
    return (
      <div className="wallet-widget">
        <button type="button" className="qnet-button wallet-button" disabled>
          Connect wallet
        </button>
      </div>
    );
  }

  if (fullView) {
    return (
      <div className="wallet-widget">
        {held ? (
          <Link href="/node" className="qnet-button wallet-button wallet-held" title={held}>
            {shortAddress(held)}
          </Link>
        ) : direct ? (
          <button type="button" className="qnet-button wallet-button" onClick={connectExtension} disabled={connecting} aria-busy={connecting}>
            {connecting ? 'Approve in wallet…' : 'Connect wallet'}
          </button>
        ) : (
          <Link href={`/node#${CONNECT_ID}`} className="qnet-button wallet-button" onClick={toConnect}>
            Connect wallet
          </Link>
        )}
        {errorNote}
      </div>
    );
  }

  // The app's view from here on. A page the app opened (?from=app) in a browser without a wallet shows no control.
  if (providerStatus === 'missing') return null;

  if (!accounts || !address) {
    return (
      <div className="wallet-widget">
        <button
          type="button"
          className="qnet-button wallet-button"
          onClick={() => void connect()}
          disabled={connecting}
          aria-busy={connecting}
        >
          {connecting ? 'Approve in wallet…' : 'Connect wallet'}
        </button>
        {errorNote}
      </div>
    );
  }

  return (
    <div className="wallet-widget wallet-connected" ref={rootRef}>
      <div className="wallet-switch" role="group" aria-label="Address shown">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            type="button"
            className={view === v.key ? 'active' : undefined}
            aria-pressed={view === v.key}
            onClick={() => setView(v.key)}
          >
            {v.label}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="wallet-address"
        title={address}
        aria-expanded={menuOpen}
        aria-controls={menuId}
        onClick={() => setMenuOpen((open) => !open)}
      >
        {shortAddress(address)}
      </button>
      {menuOpen && (
        <div className="wallet-menu" id={menuId}>
          <div className="wallet-menu-label">{view === 'qnet' ? 'QNet address' : 'Solana address'}</div>
          <div className="wallet-menu-address">{address}</div>
          <div className="wallet-menu-actions">
            <button type="button" className="qnet-button secondary" onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy address'}
            </button>
            <button
              type="button"
              className="qnet-button secondary"
              onClick={() => {
                setMenuOpen(false);
                void disconnect();
              }}
            >
              Disconnect
            </button>
          </div>
          {copyFailed && <p className="wallet-menu-note">The browser blocked copying; select the address above instead.</p>}
        </div>
      )}
      {errorNote}
    </div>
  );
}
