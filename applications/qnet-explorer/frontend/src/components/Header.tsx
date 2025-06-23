'use client';

import { memo } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const HeaderComponent = () => {
  const pathname = usePathname();

  const navLinks = [
    { href: '/', label: 'Home' },
    { href: '/nodes', label: 'Nodes' },
    { href: '/explorer', label: 'Explorer' },
    { href: '/dao', label: 'DAO' },
    { href: '/testnet', label: 'Testnet' },
    { href: '/wallet', label: 'Wallet' },
    { href: '/docs', label: 'Docs' },
  ];

  return (
    <header className="qnet-header">
      <div className="header-content">
        <Link href="/" className="qnet-logo">QNET</Link>
        
        <nav className="qnet-nav">
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
        </nav>
        
        <div className="header-right">
          <button className="qnet-button">Connect Wallet</button>
        </div>
      </div>
    </header>
  );
};

const Header = memo(HeaderComponent);

export default Header; 