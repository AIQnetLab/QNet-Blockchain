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
  const [isExplorerDomain, setIsExplorerDomain] = useState(false);
  const [isLocalDev, setIsLocalDev] = useState(false);

  // Check if we're on explorer subdomain or localhost
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const hostname = window.location.hostname;
      setIsExplorerDomain(hostname === 'explorer.aiqnet.io');
      setIsLocalDev(hostname === 'localhost' || hostname === '127.0.0.1');
    }
  }, []);

  // Get explorer URL based on environment
  const getExplorerUrl = () => {
    if (isLocalDev) {
      return '/explorer'; // Local development - use relative path
    }
    return 'https://explorer.aiqnet.io/explorer'; // Production - full URL
  };

  // Main site navigation
  const mainNavLinks = [
    { href: '/', label: 'Home' },
    { href: getExplorerUrl(), label: 'Explorer', external: !isLocalDev },
    { href: '/dao', label: 'DAO' },
    { href: '/testnet', label: 'Testnet' },
    { href: '/wallet', label: 'Wallet' },
    { href: '/docs', label: 'Docs' },
    { href: '/privacy', label: 'Privacy' },
  ];

  // Explorer subdomain navigation (minimal)
  const explorerNavLinks = [
    { href: isLocalDev ? '/' : 'https://aiqnet.io', label: 'Home', external: !isLocalDev },
    { href: '/explorer', label: 'Explorer' },
  ];

  const navLinks = isExplorerDomain ? explorerNavLinks : mainNavLinks;

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
        {isExplorerDomain ? (
          <a href="https://aiqnet.io" className="qnet-logo">QNET</a>
        ) : (
          <Link href="/" className="qnet-logo">QNET</Link>
        )}
        
        <nav className={`qnet-nav ${isMenuOpen ? 'active' : ''}`}>
          {navLinks.map(link => (
            link.external ? (
              <a 
                key={link.href}
                href={link.href}
                className="nav-button"
              >
                {link.label}
              </a>
            ) : (
              <Link 
                key={link.href}
                href={link.href}
                className="nav-button" 
                data-state={pathname === link.href ? 'active' : undefined}
              >
                {link.label}
              </Link>
            )
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
