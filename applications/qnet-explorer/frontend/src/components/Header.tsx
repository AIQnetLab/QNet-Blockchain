'use client';

import { memo, useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
// Both header instances (desktop, mobile menu) read one wallet context; provider code runs only in
// the browser, after hydration.
import ConnectWalletButton from './wallet/connect-wallet-button';
import WalletBoundary from './wallet/WalletBoundary';
import { useActivationContent, useWallet } from '@/contexts/AppContext';
import { IN_APP_HOME, IN_APP_NAV, keepFromApp, type NavLink } from '@/lib/activate-view';
import { ACTIVATION_NETWORK } from '@/lib/one-dev';

// The site's navigation (owner, 29.09): the logo is Home, then Explorer, My node, Wallet, Testnet (its own tab on a
// testnet release: the faucet lives there) and the Docs menu, and the wallet control. Privacy, Terms and Support are in
// the footer; Support is in the Docs menu too. Every link stays on this origin (aiqnet.io, src/lib/hosts.ts): another
// host would be another origin, where the wallet asks again to connect the site. Tokens are reachable through the
// explorer's search box, so there is no Tokens entry.
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

// A link is current on its page and, for a section, on the pages under it (My node's tabs, the explorer's pages).
function isCurrent(pathname: string, href: string): boolean {
  const path = href.split('?')[0];
  return pathname === path || (path !== '/' && pathname.startsWith(`${path}/`));
}

// The Docs button and its list: a list under the button on a wide screen, and the same list in place inside the
// phone's menu. It closes on a link, a tap outside, Escape, and a new page.
function DocsMenu({ pathname }: { pathname: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
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
      if (e.key === 'Escape') setOpen(false);
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
    <div className={`nav-menu${open ? ' open' : ''}`} ref={root}>
      <button
        type="button"
        className="nav-button nav-menu-button"
        aria-expanded={open}
        aria-controls={listId}
        data-state={current ? 'active' : undefined}
        onClick={() => setOpen((was) => !was)}
      >
        Docs <span className="nav-menu-caret" aria-hidden="true">▾</span>
      </button>
      <div className="nav-menu-list" id={listId} hidden={!open}>
        {DOCS_MENU.map((link) => (
          <Link key={link.href} href={link.href} className="nav-menu-link" aria-current={pathname === link.href ? 'page' : undefined}>
            {link.label}
          </Link>
        ))}
      </div>
    </div>
  );
}

const HeaderComponent = () => {
  const pathname = usePathname();
  // In the QNet app's view (its in-app browser, or a page it opened with ?from=app) the header leads only
  // to the explorer and the policies: no page about the wallet, its activation, the faucet or the DAO is a
  // tap away. The server's render and the moments before the wallet is detected get the same header, so
  // nothing else is reachable before the page knows where it is.
  const inApp = !useActivationContent();
  const { fromApp } = useWallet();
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  const navLinks = inApp
    ? IN_APP_NAV.map((link) => ({ ...link, href: keepFromApp(link.href, fromApp) }))
    : MAIN_NAV;

  useEffect(() => {
    // Close menu on route change
    setIsMenuOpen(false);
  }, [pathname]);

  const toggleMenu = () => {
    setIsMenuOpen(!isMenuOpen);
  };

  return (
    <header className="qnet-header">
      <div className="header-content">
        <Link href={inApp ? keepFromApp(IN_APP_HOME, fromApp) : '/'} className="qnet-logo">QNET</Link>

        {/* A link that stays on the page (My node's Connect wallet) closes the menu too. */}
        <nav className={`qnet-nav ${isMenuOpen ? 'active' : ''}`} onClick={(e) => {
          if ((e.target as HTMLElement).closest('a')) setIsMenuOpen(false);
        }}>
          {navLinks.map(link => (
            <Link
              key={link.href}
              href={link.href}
              className="nav-button"
              data-state={isCurrent(pathname, link.href) ? 'active' : undefined}
            >
              {link.label}
            </Link>
          ))}
          {!inApp && <DocsMenu pathname={pathname} />}
          <div className="header-right-mobile">
            <WalletBoundary><ConnectWalletButton /></WalletBoundary>
          </div>
        </nav>

        <div className="header-right-desktop">
          <WalletBoundary><ConnectWalletButton /></WalletBoundary>
        </div>

        <button className="mobile-menu-button" onClick={toggleMenu} aria-label="Toggle menu" aria-expanded={isMenuOpen}>
          {isMenuOpen ? '✕' : '☰'}
        </button>
      </div>
    </header>
  );
};

const Header = memo(HeaderComponent);

export default Header;
