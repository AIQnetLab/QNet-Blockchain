'use client';

import React from 'react';

const WalletSection = React.memo(function WalletSection() {
  return (
    <section className="explorer-section" data-section="wallet">
      <div className="explorer-header">
        <h2 className="section-title">QNet Wallet</h2>
        <p className="section-subtitle" style={{ marginBottom: '3rem' }}>
          Multi-platform quantum-resistant wallet with complete implementation
        </p>
        
        <div className="network-stats compact" style={{ marginBottom: '3rem' }}>
          <div className="stat-card">
            <div className="stat-number">1.2s</div>
            <div className="stat-label">iOS Launch</div>
            <div className="stat-trend">Store Ready</div>
          </div>
          <div className="stat-card">
            <div className="stat-number">1.4s</div>
            <div className="stat-label">Android Launch</div>
            <div className="stat-trend">Store Ready</div>
          </div>
          <div className="stat-card">
            <div className="stat-number">&lt;0.01%</div>
            <div className="stat-label">Battery Usage</div>
            <div className="stat-trend">Daily</div>
          </div>
          <div className="stat-card">
            <div className="stat-number">11</div>
            <div className="stat-label">Languages</div>
            <div className="stat-trend">Supported</div>
          </div>
        </div>
      </div>
      
      <div className="tools-grid-large">
        <div className="tool-card-large">
          <h4>Hybrid Post-Quantum Security</h4>
          <p>
            Dilithium2 + Ed25519 dual-signature system. CRYSTALS-KYBER key exchange. 
            Hardware-backed storage with biometric authentication. Future-proof against quantum computers.
          </p>
        </div>
        
        <div className="tool-card-large">
          <h4>Store-Ready Applications</h4>
          <p>
            iOS App Store ready (1.2s launch, 23MB memory). Android Play Store ready (1.4s launch, 28MB memory). 
            Chrome Extension and Firefox Add-on available.
          </p>
        </div>
        
        <div className="tool-card-large">
          <h4>NOT MINING Certification</h4>
          <p>
            Simple ping responses every 4 hours. No CPU/GPU intensive operations. 
            No device heating. Battery usage equivalent to messaging apps.
          </p>
        </div>
        
        <div className="tool-card-large">
          <h4>Mobile Optimization</h4>
          <p>
            Android: WorkManager + Doze mode compatibility. iOS: Background App Refresh + Low Power Mode. 
            &lt;0.5% daily battery usage. &lt;1MB daily data consumption.
          </p>
        </div>
        
        <div className="tool-card-large">
          <h4>Global Accessibility</h4>
          <p>
            11 languages supported with multi-language UI, cultural adaptations, 
            accessibility features, and regional compliance.
          </p>
        </div>
        
        <div className="tool-card-large">
          <h4>Economic Model Integration</h4>
          <p>
            1DEV burn mechanism (Phase 1), QNC activation with Pool #3 (Phase 2), 
            cross-chain bridge (Solana ↔ QNet), all node types supported.
          </p>
        </div>
        
        <div className="tool-card-large">
          <h4>Pool #3 Integration</h4>
          <p>
            sendQNCToPool3() function, activation fee redistribution, 
            rewards to ALL active nodes. Network growth benefits everyone.
          </p>
        </div>
      </div>
    </section>
  );
});

export default WalletSection; 