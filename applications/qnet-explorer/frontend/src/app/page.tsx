'use client';

import React, { useState, useCallback } from 'react';

// Dynamically import sections for better code splitting and initial load performance
import dynamic from 'next/dynamic';

// --- Reusable Components ---
const MatrixRain = dynamic(() => import('../components/MatrixRain'), { ssr: false });
const Header = dynamic(() => import('../components/Header'));

// --- Section Components ---
const HomeSection = dynamic(() => import('../components/sections/HomeSection'));
const NodesSection = dynamic(() => import('../components/sections/NodesSection'));
const ExplorerSection = dynamic(() => import('../components/sections/ExplorerSection'));
const DaoSection = dynamic(() => import('../components/sections/DaoSection'));
const TestnetSection = dynamic(() => import('../components/sections/TestnetSection'));
const WalletSection = dynamic(() => import('../components/sections/WalletSection'));
const DocsSection = dynamic(() => import('../components/sections/DocsSection'));

// Mapping components to section names for easy rendering
const sectionComponents: { [key: string]: React.ComponentType<any> } = {
  home: HomeSection,
  nodes: NodesSection,
  explorer: ExplorerSection,
  dao: DaoSection,
  testnet: TestnetSection,
  wallet: WalletSection,
  docs: DocsSection,
};

// --- Main Page Component ---
export default function QNetExplorer() {
  const [activeSection, setActiveSection] = useState('home');

  // Use useCallback to prevent re-creation of this function on every render
  const handleSetActiveSection = useCallback((section: string) => {
    setActiveSection(section);
  }, []);

  const ActiveComponent = sectionComponents[activeSection];

  return (
    <div className="qnet-container">
      <MatrixRain activeSection={activeSection} />
      <Header activeSection={activeSection} onNavClick={handleSetActiveSection} />

      <main className="qnet-main">
        {ActiveComponent && <ActiveComponent key={activeSection} setActiveSection={handleSetActiveSection} />}
      </main>
    </div>
  );
}