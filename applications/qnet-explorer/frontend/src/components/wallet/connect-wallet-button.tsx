'use client';

// The header's account control, one component on every page and every width (B-SPEC 5.2). Outside the QNet app's view
// its Connect wallet is My node's own (useConnectWallet): on a computer with the QNet extension it asks the extension at
// once and My node keeps that wallet and opens; on a computer without it, it opens the extension's store page; on a phone
// or tablet it leads to My node's connect card and starts QNet Wallet's request there (on a page that shows the card it
// brings the card into view and marks it). Nothing is offered while the wallet is being detected. Once My node remembers
// a wallet the control shows that wallet: its node's state and short address, opening the account menu (the whole
// address with Copy, how it is connected, My node's sections with one datum each, Disconnect): a panel under the button
// on a computer, a sheet from the bottom edge on a phone. An address My node only views is no wallet, so the control
// still offers Connect wallet. In the app's view the app's own provider connects here as before, and no page about the
// wallet, its activation or an install is offered. Addresses reach this component only after validation, and every
// value is rendered as text.

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useActivationContent, useWallet } from '@/contexts/AppContext';
import { forgetWallet, useHeldChoice } from '@/components/cabinet/CabinetProvider';
import Copy from '@/components/ui/Copy';
import { AddressParts } from '@/components/ui/EntityLink';
import { LiveDot, Ring } from '@/components/ui/Status';
import { useAccountReads } from '@/hooks/useAccountReads';
import { accountRows, nodeOnline } from '@/lib/account-menu';
import { showConnectCard } from '@/lib/cabinet/connect-card';
import { CONNECT_ID, isNodePath } from '@/lib/cabinet/tabs';
import type { WalletSource } from '@/lib/cabinet/wallet-choice';
import { short } from '@/lib/format';
import type { AddressView } from '@/lib/qnet-provider';
import { t, type MessageKey } from '@/lib/texts';
import { useConnectWallet } from './useConnectWallet';

const VIEWS: { key: AddressView; label: string }[] = [
  { key: 'qnet', label: 'QNet Blockchain' },
  { key: 'solana', label: 'Solana' },
];

const SOURCE_TEXT: Record<Exclude<WalletSource, 'entered'>, MessageKey> = {
  extension: 'wallet_source_extension',
  app: 'wallet_source_app',
  'app-qr': 'wallet_source_app_qr',
};

const PHONE = '(max-width: 860px)';

// A phone's Connect wallet (`run` starts QNet Wallet's request on the connect card and ends a view of an address). On a
// page that shows the card it is already there: brought into view and marked instead of navigating; a view that hid the
// card ends, and the card shows (ConnectScreen marks it).
function toConnect(event: MouseEvent<HTMLAnchorElement>, run: () => void) {
  run();
  const card = document.getElementById(CONNECT_ID);
  if (!card) return;
  event.preventDefault();
  showConnectCard(card, true);
}

// Connect wallet and its waiting label in one grid cell, so the control keeps its width (B-SPEC 3.7); a phone's header
// shows the short words of both, so the row fits 360 px with the menu button inside the gutter.
function ConnectLabel({ waiting = false }: { waiting?: boolean }) {
  return (
    <span className="swap">
      <span data-on={!waiting}>Connect<span className="c-long"> wallet</span></span>
      <span data-on={waiting}>Approve<span className="c-long"> in wallet</span>…</span>
    </span>
  );
}

// A wallet's node as last read in this tab: whether it runs (the button's mark, nothing until the first read) and its
// words for the button's accessible name.
interface NodeShown {
  online: boolean;
  words: string;
}
const knownNodes = new Map<string, NodeShown>();
// The account sheet and the phone's menu are never open together: each tells the other when it opens.
export const OVERLAY_EVENT = 'qnet-overlay';

// `active`: the menu is open or about to open; until then the rows stand in place with dashes and nothing is asked. The
// reads are My node's shared ones (useAccountReads), so none is asked twice.
function NodeRows({ wallet, active, onNode }: { wallet: string; active: boolean; onNode: (node: NodeShown) => void }) {
  const reads = useAccountReads(active ? wallet : null);
  const rows = accountRows(reads);
  const online = nodeOnline(reads);
  const words = rows[0].datum ? rows[0].datum.replace(' · ', ' ').toLowerCase() : null;
  useEffect(() => {
    if (online !== null && words !== null) onNode({ online, words });
  }, [online, words, onNode]);
  return (
    <nav className="acct-links" aria-label={t('account_node')}>
      {rows.map((row) => (
        <Link key={row.key} href={row.href}>
          <span className="acct-k">{row.label}</span>
          <span className="acct-d" data-tone={row.tone ?? undefined}>
            {row.mark === 'live' ? <LiveDot /> : row.mark === 'ring' ? <Ring /> : null}
            {row.datum ?? <span className="dash">—</span>}
          </span>
        </Link>
      ))}
    </nav>
  );
}

// The account menu around its button: a panel under it on a computer, a sheet from the bottom edge on a phone over a
// dimmed page. Escape, a tap on the dimmed page, Close and any link close it; focus moves in on open, stays inside while
// open, and returns to the button. Only the phone's sheet locks the page's scrolling.
// The menu's content is laid out from the start (hidden while closed), so opening it moves nothing inside it.
function AccountMenu({ address, mark, label, children }: { address: string; mark: ReactNode; label: string; children: (close: () => void, active: boolean) => ReactNode }) {
  const [open, setOpen] = useState(false);
  // A pointer over the button or focus on it starts the menu's reads, so its rows are usually in by the click.
  const [primed, setPrimed] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const panelId = useId();

  const close = useCallback((focusBack = false) => {
    setOpen(false);
    setPrimed(false);
    if (focusBack) button.current?.focus({ preventScroll: true });
  }, []);

  // A new page closes it; switching the address shown (the app's view) keeps it open.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const html = document.documentElement;
    const phone = window.matchMedia(PHONE).matches;
    if (phone) html.style.overflow = 'hidden';
    html.dataset.overlay = 'account';
    window.dispatchEvent(new CustomEvent(OVERLAY_EVENT, { detail: 'account' }));
    panel.current?.focus({ preventScroll: true });
    const onPointer = (e: PointerEvent) => {
      if (!phone && root.current && !root.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(true);
    };
    const onOverlay = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== 'account') close();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    window.addEventListener(OVERLAY_EVENT, onOverlay);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener(OVERLAY_EVENT, onOverlay);
      // The page is unlocked only by the overlay that still holds it (the phone's menu may have taken over).
      if (html.dataset.overlay !== 'account') return;
      delete html.dataset.overlay;
      if (phone) html.style.overflow = '';
    };
  }, [open, close]);

  // Tab stays inside the open menu.
  const trap = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !panel.current) return;
    const items = [...panel.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')].filter((el) => el.getClientRects().length > 0);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="acct" data-open={open || undefined} ref={root}>
      <button
        ref={button}
        type="button"
        className="acct-btn"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={panelId}
        aria-label={label}
        title={address}
        onClick={() => setOpen((was) => !was)}
        onPointerEnter={() => setPrimed(true)}
        onFocus={() => setPrimed(true)}
      >
        {mark}
        <span className="acct-a">
          <span className="a-long">{short('address', address)}</span>
          <span className="a-short">{short('address-compact', address)}</span>
        </span>
        <span className="chev" aria-hidden="true" />
      </button>
      <div className="acct-scrim" aria-hidden="true" onClick={() => close(true)} />
      <div
        ref={panel}
        className="acct-menu"
        id={panelId}
        role="dialog"
        aria-label={t('wallet_label')}
        aria-modal={open || undefined}
        tabIndex={-1}
        onKeyDown={trap}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('a')) close();
        }}
      >
        <div className="acct-top">
          <p className="label">{t('wallet_label')}</p>
          <button type="button" className="act quiet acct-close" onClick={() => close(true)}>Close</button>
        </div>
        {children(() => close(true), open || primed)}
      </div>
    </div>
  );
}

export default function ConnectWalletButton() {
  const { providerStatus, accounts, view, connecting, error, connect, disconnect, setView, clearError } = useWallet();
  // False in the QNet app's view (src/lib/activate-view.ts), where no page about the wallet may be offered.
  const fullView = useActivationContent();
  const choice = useHeldChoice();
  const held = choice?.qnet ?? null;
  const router = useRouter();
  const pathname = usePathname();
  // The extension shared its wallet after this control asked: My node opens unless this is one of its pages already.
  const { way, run } = useConnectWallet(() => {
    if (!isNodePath(pathname)) router.push('/node');
  });
  const [node, setNode] = useState<NodeShown | null>(null);

  useEffect(() => {
    setNode(held === null ? null : knownNodes.get(held) ?? null);
  }, [held]);
  const onNode = useCallback((value: NodeShown) => {
    if (held === null) return;
    knownNodes.set(held, value);
    setNode(value);
  }, [held]);

  // A wallet error goes away by itself after a few seconds; the x still closes it at once (owner, 28.09).
  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => clearError(), 6000);
    return () => window.clearTimeout(timer);
  }, [error, clearError]);

  // Disconnecting the extension's wallet also ends the extension's connection to this site.
  const leave = () => {
    if (choice?.source === 'extension' && accounts?.qnet === choice.qnet) void disconnect();
    forgetWallet();
  };

  const address = accounts ? accounts[view] : null;

  const errorNote = error ? (
    <div className="wallet-error" role="alert">
      <span>{error}</span>
      <button type="button" className="act quiet wallet-error-close" onClick={clearError} aria-label="Dismiss">×</button>
    </div>
  ) : null;

  if (providerStatus === 'detecting') {
    return (
      <div className="wallet-widget">
        <button key="detecting" type="button" className="connect" disabled>
          <ConnectLabel />
        </button>
      </div>
    );
  }

  if (fullView) {
    // Connect wallet by the way of this device: the extension's ask, its store page in a new tab, or My node's connect
    // card with QNet Wallet's request; nothing until the device is known.
    let connectControl: ReactNode;
    if (way.kind === 'extension') {
      connectControl = (
        <button key="extension" type="button" className="connect" onClick={run} disabled={connecting} aria-busy={connecting}>
          <ConnectLabel waiting={connecting} />
        </button>
      );
    } else if (way.kind === 'install') {
      connectControl = way.store ? (
        <a key="store" className="connect" href={way.href} target="_blank" rel="noopener noreferrer"><ConnectLabel /></a>
      ) : (
        <Link key="install" className="connect" href={way.href}><ConnectLabel /></Link>
      );
    } else if (way.kind === 'app') {
      connectControl = (
        <Link key="app" href={`/node#${CONNECT_ID}`} className="connect" onClick={(event) => toConnect(event, run)}>
          <ConnectLabel />
        </Link>
      );
    } else {
      connectControl = <button key="wait" type="button" className="connect" disabled><ConnectLabel /></button>;
    }
    return (
      <div className="wallet-widget">
        {held && choice ? (
          <AccountMenu
            key="account"
            address={held}
            mark={node === null ? null : node.online ? <LiveDot /> : <Ring />}
            label={node === null ? t('account_button', { address: short('address', held) }) : t('account_button_node', { address: short('address', held), node: node.words })}
          >
            {(close, active) => (
              <>
                <p className="acct-addr mono"><AddressParts value={held} /></p>
                <Copy value={held} label={t('account_copy')} />
                {choice.source !== 'entered' && <p className="acct-src">{t(SOURCE_TEXT[choice.source])}</p>}
                <NodeRows wallet={held} active={active} onNode={onNode} />
                <button
                  type="button"
                  className="acct-out"
                  onClick={() => {
                    close();
                    leave();
                  }}
                >
                  {t('wallet_disconnect')}
                </button>
              </>
            )}
          </AccountMenu>
        ) : connectControl}
        {errorNote}
      </div>
    );
  }

  // The app's in-app browser from here on: its own provider connects.
  if (!accounts || !address) {
    return (
      <div className="wallet-widget">
        <button key="app" type="button" className="connect" onClick={() => void connect()} disabled={connecting} aria-busy={connecting}>
          <ConnectLabel waiting={connecting} />
        </button>
        {errorNote}
      </div>
    );
  }

  return (
    <div className="wallet-widget">
      <AccountMenu key="app-account" address={address} mark={null} label={t('account_button', { address: short('address', address) })}>
        {(close) => (
          <>
            <div className="acct-views" role="tablist" aria-label="Address shown">
              {VIEWS.map((v) => (
                <button key={v.key} type="button" role="tab" aria-selected={view === v.key} className="acct-view" onClick={() => setView(v.key)}>
                  {v.label}
                </button>
              ))}
            </div>
            <p className="acct-addr mono">{view === 'qnet' ? <AddressParts value={address} /> : address}</p>
            <Copy value={address} label={t('account_copy')} />
            <button
              type="button"
              className="acct-out"
              onClick={() => {
                close();
                void disconnect();
              }}
            >
              {t('wallet_disconnect')}
            </button>
          </>
        )}
      </AccountMenu>
      {errorNote}
    </div>
  );
}
