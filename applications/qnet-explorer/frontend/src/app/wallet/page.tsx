'use client';

import { useState } from 'react';

// Mock data and state can be moved to a shared context or service if needed
// For now, keeping it simple within the component.

export default function WalletPage() {
  const [showPrivacyModal, setShowPrivacyModal] = useState(false);

  return (
    <div className="page-wallet">
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

        {/* Privacy Policy Banner */}
        <div className="tool-card-large" style={{ 
          cursor: 'pointer',
          transition: 'all 0.3s ease',
          border: '1px solid rgba(0, 212, 255, 0.3)',
          marginBottom: '3rem'
        }} onClick={() => setShowPrivacyModal(true)}>
          <h4>QNet Wallet Browser Extension - Privacy Policy & Data Protection</h4>
          <p>
            QNet Wallet browser extension respects your privacy. All wallet data is stored locally on your device 
            with AES-256 encryption. No personal information is collected or transmitted to external servers. 
            Click to view our complete privacy policy.
          </p>
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

      {/* Privacy Policy Modal */}
      {showPrivacyModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.8)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          padding: '20px'
        }} onClick={() => setShowPrivacyModal(false)}>
          <div style={{
            backgroundColor: '#1a1a2e',
            border: '1px solid #00d4ff',
            borderRadius: '12px',
            padding: '30px',
            maxWidth: '800px',
            maxHeight: '80vh',
            overflow: 'auto',
            position: 'relative'
          }} onClick={(e) => e.stopPropagation()}>
            <button 
              onClick={() => setShowPrivacyModal(false)}
              style={{
                position: 'absolute',
                top: '15px',
                right: '15px',
                background: 'none',
                border: 'none',
                color: '#00d4ff',
                fontSize: '24px',
                cursor: 'pointer'
              }}
            >
              ×
            </button>
            
            <h2 style={{ color: '#00d4ff', marginBottom: '20px' }}>Privacy Policy</h2>
            
            <div style={{ color: '#b0b0b0', lineHeight: '1.6' }}>
              <h3 style={{ color: '#00d4ff', marginTop: '20px' }}>Data Collection</h3>
              <p>QNet Wallet does not collect, store, or transmit any personal user data. All wallet information, including private keys, seed phrases, and transaction history, is stored locally on your device using AES-256 encryption.</p>
              
              <h3 style={{ color: '#00d4ff', marginTop: '20px' }}>Local Storage</h3>
              <p>The extension uses browser local storage to securely store encrypted wallet data. This data never leaves your device and is not accessible to QNet servers or third parties.</p>
              
              <h3 style={{ color: '#00d4ff', marginTop: '20px' }}>Network Interactions</h3>
              <p>The wallet connects to blockchain networks (QNet and Solana) only to broadcast transactions and retrieve public blockchain data. No personal information is transmitted during these interactions.</p>
              
              <h3 style={{ color: '#00d4ff', marginTop: '20px' }}>Third-Party Services</h3>
              <p>The wallet may connect to decentralized applications (dApps) when explicitly authorized by the user. These connections are direct and do not involve QNet as an intermediary.</p>
              
              <h3 style={{ color: '#00d4ff', marginTop: '20px' }}>Security</h3>
              <p>All sensitive data is encrypted using industry-standard AES-256 encryption. Private keys are generated locally and never transmitted over the internet.</p>
              
              <p style={{ marginTop: '30px', fontSize: '12px', color: '#666' }}>
                Last updated: October 6, 2025
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}