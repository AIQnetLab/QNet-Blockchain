'use client';

import React from 'react';

const navItems = ['home', 'nodes', 'explorer', 'dao', 'testnet', 'wallet', 'docs'];

const Header = React.memo(function Header({ activeSection, onNavClick }: { activeSection: string, onNavClick: (section: string) => void }) {
  return (
    <header className="qnet-header">
      <div className="header-content">
        <div className="qnet-logo">QNET</div>
        
        <nav className="qnet-nav">
          {navItems.map(item => (
            <button 
              key={item}
              className="nav-button" 
              data-state={activeSection === item ? 'active' : undefined}
              onClick={() => onNavClick(item)}
            >
              {item.charAt(0).toUpperCase() + item.slice(1)}
            </button>
          ))}
        </nav>
        
        <div className="header-right">
          <button className="qnet-button">Connect Wallet</button>
        </div>
      </div>
    </header>
  );
});

export default Header; 