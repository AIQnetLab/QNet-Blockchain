'use client';

import { memo, useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import dynamic from 'next/dynamic';

const WalletConnectButton = dynamic(() => import('./wallet/wallet-connect-button'), {
  ssr: false,
  loading: () => <button className="qnet-button" disabled>Loading...</button>
});

const HeaderComponent = () => {
  const pathname = usePathname();
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  const navLinks = [
    { href: '/', label: 'Home' },
    { href: '/nodes', label: 'Nodes' },
    { href: '/explorer', label: 'Explorer' },
    { href: '/dao', label: 'DAO' },
    { href: '/testnet', label: 'Testnet' },
    { href: '/wallet', label: 'Wallet' },
    { href: '/docs', label: 'Docs' },
    { href: '/privacy', label: 'Privacy' },
  ];

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
        <Link href="/" className="qnet-logo">QNET</Link>
        
        <nav className={`qnet-nav ${isMenuOpen ? 'active' : ''}`}>
          {navLinks.map(link => (
            <Link 
              key={link.href}
              href={link.href}
              className="nav-button" 
              data-state={pathname === link.href ? 'active' : undefined}
            >
              {link.label}
            </Link>
          ))}
          <div className="header-right-mobile">
            <WalletConnectButton />
          </div>
        </nav>
        
        <div className="header-right-desktop">
          <WalletConnectButton />
        </div>

        <button className="mobile-menu-button" onClick={toggleMenu} aria-label="Toggle menu">
          {isMenuOpen ? '✕' : '☰'}
        </button>
      </div>
    </header>
  );
};

const Header = memo(HeaderComponent);

export default Header; 