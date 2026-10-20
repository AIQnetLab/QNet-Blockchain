'use client';

import { memo, useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
// One wallet control in the header row at every width; provider code runs only in the browser, after hydration.
import ConnectWalletButton, { OVERLAY_EVENT } from './wallet/connect-wallet-button';
import WalletBoundary from './wallet/WalletBoundary';
import { useActivationContent, useWallet } from '@/contexts/AppContext';
import { IN_APP_HOME, IN_APP_NAV, type NavLink } from '@/lib/activate-view';
import { ACTIVATION_NETWORK } from '@/lib/one-dev';

// The site's navigation (owner, 29.09): the logo is Home, then Explorer, My node, Wallet, Testnet (its own tab on a
// testnet release: the faucet lives there) and the Docs menu, and the wallet control. Privacy and Terms are in the
// footer's legal line; Support is in the Docs menu. Every link stays on this origin (aiqnet.io, src/lib/hosts.ts):
// another host would be another origin, where the wallet asks again to connect the site.
const MAIN_NAV: NavLink[] = [
  { href: '/explorer', label: 'Explorer' },
  { href: '/node', label: 'My node' },
  { href: '/wallet', label: 'Wallet' },
  ...(ACTIVATION_NETWORK === 'testnet' ? [{ href: '/testnet', label: 'Testnet' }] : []),
];

// The Docs menu: the documentation, How it works (the node guide), the DAO and Support.
const DOCS_MENU: NavLink[] = [
  { href: '/docs', label: 'Documentation' },
  { href: '/docs/how-it-works', label: 'How it works' },
  { href: '/dao', label: 'DAO' },
  { href: '/support', label: 'Support' },
];

// The wordmark: the name together, "Blockchain" one weight lighter.
const NAME = 'QNet Blockchain';
const [MARK, WORD] = NAME.split(' ');

// A link is current on its page and, for a section, on the pages under it (My node's tabs, the explorer's pages).
function isCurrent(pathname: string, href: string): boolean {
  const path = href.split('?')[0];
  return pathname === path || (path !== '/' && pathname.startsWith(`${path}/`));
}

// The Docs button and its list: a menu under the button on a wide screen, the same list in place inside the phone's
// menu. It closes on a link, a tap outside, Escape (focus back on the button) and a new page.
function DocsMenu({ pathname }: { pathname: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const listId = useId();

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const current = DOCS_MENU.some((link) => pathname === link.href);
  return (
    <div className="docs" data-open={open || undefined} ref={root}>
      <button
        ref={button}
        type="button"
        className="nav-link docs-btn"
        aria-expanded={open}
        aria-controls={listId}
        data-current={current || undefined}
        data-field-clear
        onClick={() => setOpen((was) => !was)}
      >
        Docs<span className="chev" aria-hidden="true" />
      </button>
      <div className="docs-menu" id={listId} hidden={!open}>
        {DOCS_MENU.map((link) => (
          <Link key={link.href} href={link.href} className="docs-link" aria-current={pathname === link.href ? 'page' : undefined}>
            {link.label}
          </Link>
        ))}
      </div>
    </div>
  );
}

const HeaderComponent = () => {
  const pathname = usePathname();
  // In the QNet app's view (its in-app browser) the header leads only to the explorer and the policies: no page about
  // the wallet, its activation, the faucet or the DAO is a tap away. The server's render and the moments before the
  // wallet is detected get the same links, kept invisible, so nothing else is reachable before the page knows where it
  // is and the bar does not move when they change.
  const inApp = !useActivationContent();
  const { providerStatus } = useWallet();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const nav = useRef<HTMLElement>(null);
  const navId = useId();

  const navLinks = inApp ? IN_APP_NAV : MAIN_NAV;

  useEffect(() => {
    setIsMenuOpen(false);
  }, [pathname]);

  // Transparent over the title band at the top of a page, Ink with a hairline once scrolled.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // The phone's menu: locks the page's scrolling, takes focus to its first item, closes on Escape (focus back on Menu)
  // and when the account sheet opens.
  useEffect(() => {
    if (!isMenuOpen) return;
    const html = document.documentElement;
    html.style.overflow = 'hidden';
    html.dataset.overlay = 'menu';
    window.dispatchEvent(new CustomEvent(OVERLAY_EVENT, { detail: 'menu' }));
    nav.current?.querySelector<HTMLElement>('a, button')?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setIsMenuOpen(false);
      menuButton.current?.focus({ preventScroll: true });
    };
    const onOverlay = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== 'menu') setIsMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    window.addEventListener(OVERLAY_EVENT, onOverlay);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener(OVERLAY_EVENT, onOverlay);
      // The page is unlocked only by the overlay that still holds it (the account sheet may have taken over).
      if (html.dataset.overlay !== 'menu') return;
      delete html.dataset.overlay;
      html.style.overflow = '';
    };
  }, [isMenuOpen]);

  return (
    <header className="hdr" data-scrolled={scrolled || undefined} data-open={isMenuOpen || undefined} data-field-fixed data-field-dim="0.25">
      <div className="wrap hdr-in">
        <Link href={inApp ? IN_APP_HOME : '/'} className="brand" aria-label={NAME} data-field-clear>
          <img src="/icon-192.png" alt="" width={28} height={28} />
          <span className="brand-name" aria-hidden="true"><b>{MARK}</b> {WORD}</span>
        </Link>

        {/* A link that stays on the page (My node's Connect wallet) closes the menu too. */}
        <nav
          ref={nav}
          id={navId}
          className="nav"
          aria-label="Main"
          data-pending={providerStatus === 'detecting' || undefined}
          onClick={(e) => {
            if ((e.target as HTMLElement).closest('a')) setIsMenuOpen(false);
          }}
        >
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="nav-link"
              aria-current={isCurrent(pathname, link.href) ? 'page' : undefined}
              data-field-clear
            >
              {link.label}
            </Link>
          ))}
          {!inApp && <DocsMenu pathname={pathname} />}
        </nav>

        <div className="hdr-acct" data-field-clear>
          <WalletBoundary><ConnectWalletButton /></WalletBoundary>
        </div>

        <button
          ref={menuButton}
          type="button"
          className="menu-btn"
          onClick={() => setIsMenuOpen((was) => !was)}
          aria-expanded={isMenuOpen}
          aria-controls={navId}
          data-field-clear
        >
          <span className="swap">
            <span data-on={!isMenuOpen}>Menu</span>
            <span data-on={isMenuOpen}>Close</span>
          </span>
        </button>
      </div>
    </header>
  );
};

const Header = memo(HeaderComponent);

export default Header;
