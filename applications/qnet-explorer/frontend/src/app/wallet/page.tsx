'use client';

import { useState } from 'react';

export default function WalletPage() {
  const [showAndroidModal, setShowAndroidModal] = useState(false);
  const [showIOSModal, setShowIOSModal] = useState(false);
  const [showExtensionModal, setShowExtensionModal] = useState(false);

  return (
    <div className="page-wallet">
      <section className="explorer-section" data-section="wallet">
        <div className="explorer-header">
          <h2 className="section-title">QNet Wallet</h2>
          <p className="section-subtitle" style={{ marginBottom: '3rem' }}>
            Multi-platform quantum-resistant wallet with complete implementation
          </p>
          
          {/* Platform Stats */}
          <div className="network-stats compact" style={{ marginBottom: '3rem' }}>
            <div className="stat-card" style={{ cursor: 'pointer' }} onClick={() => setShowExtensionModal(true)}>
              <div className="stat-number">3.2MB</div>
              <div className="stat-label">Extension Size</div>
              <div className="stat-trend">Available Now</div>
            </div>
            <div className="stat-card" style={{ cursor: 'pointer' }} onClick={() => setShowIOSModal(true)}>
              <div className="stat-number">1.2s</div>
              <div className="stat-label">iOS Launch</div>
              <div className="stat-trend">Soon</div>
            </div>
            <div className="stat-card" style={{ cursor: 'pointer' }} onClick={() => setShowAndroidModal(true)}>
              <div className="stat-number">1.4s</div>
              <div className="stat-label">Android Launch</div>
              <div className="stat-trend">Soon</div>
            </div>
            <div className="stat-card">
              <div className="stat-number">&lt;0.01%</div>
              <div className="stat-label">Battery Usage</div>
              <div className="stat-trend">Daily Average</div>
            </div>
          </div>

        </div>

        {/* Platform Download Cards */}
        <div style={{ marginBottom: '3rem' }}>
          {/* iOS App Store Card */}
          <div className="tool-card-large" style={{ 
            cursor: 'pointer',
            transition: 'all 0.3s ease',
            border: '1px solid rgba(0, 212, 255, 0.3)',
            marginBottom: '1.5rem',
            position: 'relative'
          }} 
          onClick={() => setShowIOSModal(true)}
          onMouseOver={(e) => {
            e.currentTarget.style.border = '1px solid rgba(0, 212, 255, 0.6)';
            e.currentTarget.style.backgroundColor = 'rgba(0, 212, 255, 0.02)';
          }}
          onMouseOut={(e) => {
            e.currentTarget.style.border = '1px solid rgba(0, 212, 255, 0.3)';
            e.currentTarget.style.backgroundColor = 'transparent';
          }}>
            <h4>iOS App Store - QNet Wallet for iPhone & iPad</h4>
            <p>
              QNet Wallet for iOS does not collect, store, or transmit any personal user data. All wallet information, including private keys, seed phrases, and transaction history, 
              is stored locally on your device using AES-256 encryption through Secure Enclave. Private keys are generated locally and never transmitted over the internet. 
              The application delivers enterprise-grade security with biometric authentication via Face ID or Touch ID, maintaining a 1.2s launch time with less than 0.01% daily battery consumption. 
              Requires iOS 13.0 or later. Click to view complete technical specifications and privacy compliance.
            </p>
            <div style={{ 
              position: 'absolute', 
              top: '20px', 
              right: '20px',
              padding: '4px 12px',
              backgroundColor: 'rgba(0, 255, 136, 0.1)',
              border: '1px solid #00ff88',
              borderRadius: '4px',
              fontSize: '12px',
              color: '#00ff88'
            }}>
              Ready for Submission
            </div>
          </div>

          {/* Google Play Card */}
          <div className="tool-card-large" style={{ 
            cursor: 'pointer',
            transition: 'all 0.3s ease',
            border: '1px solid rgba(0, 212, 255, 0.3)',
            marginBottom: '1.5rem',
            position: 'relative'
          }} 
          onClick={() => setShowAndroidModal(true)}
          onMouseOver={(e) => {
            e.currentTarget.style.border = '1px solid rgba(0, 212, 255, 0.6)';
            e.currentTarget.style.backgroundColor = 'rgba(0, 212, 255, 0.02)';
          }}
          onMouseOut={(e) => {
            e.currentTarget.style.border = '1px solid rgba(0, 212, 255, 0.3)';
            e.currentTarget.style.backgroundColor = 'transparent';
          }}>
            <h4>Google Play - QNet Wallet for Android</h4>
            <p>
              QNet Wallet for Android does not collect, store, or transmit any personal user data. All wallet information, including private keys, seed phrases, and transaction history, 
              is stored locally on your device using AES-256 encryption. Private keys are generated locally and never transmitted over the internet. 
              The application implements ProGuard obfuscation and hardware-backed keystore for maximum security, utilizing WorkManager for efficient background processing with full Doze mode compatibility. 
              Package size 34MB with 1.4s launch time. Click to view detailed permissions and security features.
            </p>
            <div style={{ 
              position: 'absolute', 
              top: '20px', 
              right: '20px',
              padding: '4px 12px',
              backgroundColor: 'rgba(0, 255, 136, 0.1)',
              border: '1px solid #00ff88',
              borderRadius: '4px',
              fontSize: '12px',
              color: '#00ff88'
            }}>
              AAB Ready (34MB)
            </div>
          </div>

        </div>

        {/* Browser Extension & Privacy Policy Combined Banner */}
        <div className="tool-card-large" style={{ 
          cursor: 'pointer',
          transition: 'all 0.3s ease',
          border: '1px solid rgba(0, 212, 255, 0.3)',
          marginBottom: '3rem',
          position: 'relative'
        }} 
        onClick={() => setShowExtensionModal(true)}
        onMouseOver={(e) => {
          e.currentTarget.style.border = '1px solid rgba(0, 212, 255, 0.6)';
          e.currentTarget.style.backgroundColor = 'rgba(0, 212, 255, 0.02)';
        }}
        onMouseOut={(e) => {
          e.currentTarget.style.border = '1px solid rgba(0, 212, 255, 0.3)';
          e.currentTarget.style.backgroundColor = 'transparent';
        }}>
          <h4>Browser Extension - QNet Wallet for Chrome & Edge</h4>
          <p>
            QNet Wallet browser extension does not collect, store, or transmit any personal user data. All wallet information, including private keys, seed phrases, and transaction history, 
            is stored locally in your browser with AES-256 encryption. Private keys are generated locally and never transmitted over the internet. 
            Provides seamless Web3 integration with full dApp compatibility and hardware wallet support in a lightweight 3.2MB package. 
            Compatible with Chrome 88+, Firefox 89+, Microsoft Edge, and Brave browsers. Click to view installation instructions and privacy policy.
          </p>
          <div style={{ 
            position: 'absolute', 
            top: '20px', 
            right: '20px',
            padding: '4px 12px',
            backgroundColor: 'rgba(0, 212, 255, 0.1)',
            border: '1px solid #00d4ff',
            borderRadius: '4px',
            fontSize: '12px',
            color: '#00d4ff'
          }}>
            Available Now
          </div>
        </div>
        
        <div className="tools-grid-large">
          <div className="tool-card-large">
            <h4>Hybrid Post-Quantum Security</h4>
            <p>
              Dilithium2 + Ed25519 dual-signature system. CRYSTALS-Kyber 1024 key exchange. 
              Hardware-backed storage with biometric authentication. Future-proof against quantum computers.
            </p>
          </div>
          
          <div className="tool-card-large">
            <h4>Store-Ready Applications</h4>
            <p>
              iOS App Store ready (34MB app size). Android Play Store ready (34MB AAB bundle). 
              Chrome Extension (3.2MB) and Firefox Add-on available.
            </p>
          </div>
          
          <div className="tool-card-large" style={{ 
            border: '2px solid #00ff88',
            backgroundColor: 'rgba(0, 255, 136, 0.05)'
          }}>
            <h4 style={{ color: '#00ff88' }}>✓ NOT MINING - Network Participation</h4>
            <p>
              <strong>Proof of Participation (PoP)</strong> - lightweight blockchain validation, NOT Proof of Work mining!<br/>
              • Periodic network status checks every 4 hours<br/>
              • No CPU/GPU intensive calculations<br/>
              • No device heating or fan noise<br/>
              • Battery usage: &lt;0.01% daily (less than checking email)<br/>
              • Data usage: &lt;1MB per day<br/>
              <br/>
              <em style={{ fontSize: '0.9em', opacity: 0.8 }}>
                Active network participation mechanism - NOT passive income mining. 
                Device must respond to periodic network checks to maintain node eligibility 
                and receive participation rewards for network validation.
              </em>
            </p>
          </div>
          
          <div className="tool-card-large">
            <h4>Mobile Optimization</h4>
            <p>
              Android: WorkManager + Doze mode compatibility. iOS: Background App Refresh + Low Power Mode. 
              &lt;0.01% daily battery usage. &lt;1MB daily data consumption.
            </p>
          </div>
          
          <div className="tool-card-large">
            <h4>Global Accessibility</h4>
            <p>
              11 languages: English, Chinese, Russian, Spanish, French, German, Japanese, Korean, Arabic, Hindi, Portuguese.
              Full RTL support and accessibility features.
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
          
          <div className="tool-card-large">
            <h4>Cross-Platform Sync</h4>
            <p>
              Import/export wallets between mobile and browser extension using BIP39 seed phrases.
              Seamless experience across all your devices.
            </p>
          </div>
        </div>
      </section>

      {/* Android Modal */}
      {showAndroidModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.9)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          padding: '20px'
        }} onClick={() => setShowAndroidModal(false)}>
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
              onClick={() => setShowAndroidModal(false)}
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
            
            <h2 style={{ color: '#00d4ff', marginBottom: '20px' }}>QNet Wallet for Android - Privacy Policy & Data Protection</h2>
            
            <div style={{ color: '#b0b0b0', lineHeight: '1.6' }}>
              <h3 style={{ color: '#00d4ff', marginTop: '20px' }}>Data Collection</h3>
              <p>QNet Wallet for Android does not collect, store, or transmit any personal user data. All wallet information, including private keys, seed phrases, and transaction history, is stored locally on your device using AES-256 encryption.</p>
              
              <h3 style={{ color: '#00d4ff', marginTop: '20px' }}>Local Storage</h3>
              <p>The wallet uses secure device storage to store encrypted wallet data. This data never leaves your device and is not accessible to QNet servers or third parties. Hardware-backed keystore is used when available.</p>
              
              <h3 style={{ color: '#00d4ff', marginTop: '20px' }}>Network Interactions</h3>
              <p>The wallet connects to blockchain networks (QNet and Solana) only to broadcast transactions and retrieve public blockchain data. No personal information is transmitted during these interactions.</p>
              
              <h3 style={{ color: '#00d4ff', marginTop: '20px' }}>Third-Party Services</h3>
              <p>The wallet may connect to decentralized applications (dApps) when explicitly authorized by the user. These connections are direct and do not involve QNet as an intermediary.</p>
              
              <h3 style={{ color: '#00d4ff', marginTop: '20px' }}>Security</h3>
              <p>All sensitive data is encrypted using industry-standard AES-256 encryption with ProGuard obfuscation. Private keys are generated locally and never transmitted over the internet. Hardware-backed keystore provides additional protection.</p>
              
              <h3 style={{ color: '#00d4ff', marginTop: '20px' }}>Technical Specifications</h3>
              <p><strong>App Size:</strong> 34MB (AAB bundle)<br/>
              <strong>Launch Time:</strong> 1.4 seconds<br/>
              <strong>Battery Usage:</strong> &lt;0.01% daily<br/>
              <strong>Min Android Version:</strong> 6.0 (API 23)<br/>
              <strong>Target Version:</strong> Android 14 (API 34)</p>
              
              <h3 style={{ color: '#00d4ff', marginTop: '20px' }}>Permissions Required</h3>
              <p>Camera (QR code scanning only), Internet (blockchain connectivity), Biometric (optional authentication), Storage (encrypted wallet data). No location tracking, contacts access, or background mining.</p>
              
              <h3 style={{ color: '#00d4ff', marginTop: '20px' }}>Children's Privacy</h3>
              <p>Our app is not intended for users under 18 years of age. We do not knowingly collect information from children.</p>
              
              <h3 style={{ color: '#00d4ff', marginTop: '20px' }}>Data Breach</h3>
              <p>Since we don't store your private data on our servers, a breach of our systems cannot compromise your wallet. Your device security is critical - always keep your seed phrase backed up securely offline.</p>
              
              <h3 style={{ color: '#00d4ff', marginTop: '20px' }}>Your Rights</h3>
              <ul style={{ marginLeft: '20px' }}>
                <li>Export your wallet seed phrase at any time</li>
                <li>Delete all app data by uninstalling the application</li>
                <li>Control what information is shared on the blockchain</li>
                <li>Operate your node pseudonymously</li>
              </ul>
              
              <h3 style={{ color: '#00d4ff', marginTop: '20px' }}>Compliance</h3>
              <p>This privacy policy complies with:</p>
              <ul style={{ marginLeft: '20px' }}>
                <li>GDPR (General Data Protection Regulation)</li>
                <li>CCPA (California Consumer Privacy Act)</li>
                <li>Google Play Store requirements</li>
              </ul>
              
              <h3 style={{ color: '#00d4ff', marginTop: '20px' }}>Contact</h3>
              <p>
                For privacy-related questions:<br/>
                Twitter: <a href="https://x.com/AIQnetLab" style={{ color: '#00d4ff' }}>@AIQnetLab</a><br/>
                Website: <a href="https://aiqnet.io" style={{ color: '#00d4ff' }}>https://aiqnet.io</a>
              </p>

              <div style={{ 
                marginTop: '30px', 
                padding: '20px', 
                backgroundColor: 'rgba(0, 212, 255, 0.1)',
                borderRadius: '8px',
                border: '1px solid rgba(0, 212, 255, 0.3)'
              }}>
                <p style={{ marginBottom: '15px', fontSize: '14px' }}>
                  <strong>Status:</strong> <span style={{ color: '#00ff88' }}>✓ Production Ready</span>
                </p>
                <p style={{ fontSize: '14px', marginBottom: '15px' }}>
                  AAB file prepared for Google Play Store submission. Awaiting developer account creation.
                </p>
                <button
                  style={{
                    padding: '10px 20px',
                    backgroundColor: '#00d4ff',
                    color: '#0a0a14',
                    border: 'none',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontWeight: 'bold',
                    fontSize: '16px',
                    width: '100%'
                  }}
                  onClick={() => window.open('https://play.google.com/store/apps/details?id=com.qnetmobile', '_blank')}
                >
                  Coming Soon to Google Play
                </button>
              </div>
              
              <p style={{ marginTop: '30px', fontSize: '12px', color: '#666' }}>
                Last updated: October 14, 2025
              </p>
            </div>
          </div>
        </div>
      )}

      {/* iOS Modal */}
      {showIOSModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.9)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          padding: '20px'
        }} onClick={() => setShowIOSModal(false)}>
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
              onClick={() => setShowIOSModal(false)}
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
            
            <h2 style={{ color: '#00d4ff', marginBottom: '20px' }}>QNet Wallet for iOS - Privacy Policy & Data Protection</h2>
            
            <div style={{ color: '#b0b0b0', lineHeight: '1.6' }}>
              <h3 style={{ color: '#00d4ff', marginTop: '20px' }}>Data Collection</h3>
              <p>QNet Wallet for iOS does not collect, store, or transmit any personal user data. All wallet information, including private keys, seed phrases, and transaction history, is stored locally on your device using AES-256 encryption through Secure Enclave.</p>
              
              <h3 style={{ color: '#00d4ff', marginTop: '20px' }}>Local Storage</h3>
              <p>The wallet uses Secure Enclave and Keychain Services to store encrypted wallet data. This data never leaves your device and is not accessible to QNet servers or third parties. Hardware-backed encryption provides maximum security.</p>
              
              <h3 style={{ color: '#00d4ff', marginTop: '20px' }}>Network Interactions</h3>
              <p>The wallet connects to blockchain networks (QNet and Solana) only to broadcast transactions and retrieve public blockchain data. No personal information is transmitted during these interactions.</p>
              
              <h3 style={{ color: '#00d4ff', marginTop: '20px' }}>Third-Party Services</h3>
              <p>The wallet may connect to decentralized applications (dApps) when explicitly authorized by the user. These connections are direct and do not involve QNet as an intermediary.</p>
              
              <h3 style={{ color: '#00d4ff', marginTop: '20px' }}>Security</h3>
              <p>All sensitive data is encrypted using industry-standard AES-256 encryption with Secure Enclave hardware backing. Private keys are generated locally and never transmitted over the internet. Face ID and Touch ID provide additional biometric security.</p>
              
              <h3 style={{ color: '#00d4ff', marginTop: '20px' }}>Technical Specifications</h3>
              <p><strong>App Size:</strong> ~35MB<br/>
              <strong>Launch Time:</strong> 1.2 seconds<br/>
              <strong>Battery Usage:</strong> &lt;0.01% daily<br/>
              <strong>Min iOS Version:</strong> iOS 13.0<br/>
              <strong>Optimized for:</strong> iOS 17+</p>
              
              <h3 style={{ color: '#00d4ff', marginTop: '20px' }}>Privacy Features</h3>
              <p>App Tracking Transparency compliant. No IDFA collection. No third-party analytics. All data stored locally only. Camera permission used exclusively for QR code scanning.</p>
              
              <h3 style={{ color: '#00d4ff', marginTop: '20px' }}>Children's Privacy</h3>
              <p>Our app is not intended for users under 18 years of age. We do not knowingly collect information from children.</p>
              
              <h3 style={{ color: '#00d4ff', marginTop: '20px' }}>Data Breach</h3>
              <p>Since we don't store your private data on our servers, a breach of our systems cannot compromise your wallet. Your device security is critical - always keep your seed phrase backed up securely offline.</p>
              
              <h3 style={{ color: '#00d4ff', marginTop: '20px' }}>Your Rights</h3>
              <ul style={{ marginLeft: '20px' }}>
                <li>Export your wallet seed phrase at any time</li>
                <li>Delete all app data by uninstalling the application</li>
                <li>Control what information is shared on the blockchain</li>
                <li>Operate your node pseudonymously</li>
              </ul>
              
              <h3 style={{ color: '#00d4ff', marginTop: '20px' }}>Compliance</h3>
              <p>This privacy policy complies with:</p>
              <ul style={{ marginLeft: '20px' }}>
                <li>GDPR (General Data Protection Regulation)</li>
                <li>CCPA (California Consumer Privacy Act)</li>
                <li>Apple App Store guidelines</li>
              </ul>
              
              <h3 style={{ color: '#00d4ff', marginTop: '20px' }}>Contact</h3>
              <p>
                For privacy-related questions:<br/>
                Twitter: <a href="https://x.com/AIQnetLab" style={{ color: '#00d4ff' }}>@AIQnetLab</a><br/>
                Website: <a href="https://aiqnet.io" style={{ color: '#00d4ff' }}>https://aiqnet.io</a>
              </p>

              <div style={{ 
                marginTop: '30px', 
                padding: '20px', 
                backgroundColor: 'rgba(0, 212, 255, 0.1)',
                borderRadius: '8px',
                border: '1px solid rgba(0, 212, 255, 0.3)'
              }}>
                <p style={{ marginBottom: '15px', fontSize: '14px' }}>
                  <strong>Status:</strong> <span style={{ color: '#00ff88' }}>✓ Production Ready</span>
                </p>
                <p style={{ fontSize: '14px', marginBottom: '15px' }}>
                  iOS build prepared. Awaiting Apple Developer account and TestFlight setup.
                </p>
                <button
                  style={{
                    padding: '10px 20px',
                    backgroundColor: '#00d4ff',
                    color: '#0a0a14',
                    border: 'none',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontWeight: 'bold',
                    fontSize: '16px',
                    width: '100%'
                  }}
                  onClick={() => window.open('https://apps.apple.com/app/qnet-wallet', '_blank')}
                >
                  Coming Soon to App Store
                </button>
              </div>
              
              <p style={{ marginTop: '30px', fontSize: '12px', color: '#666' }}>
                Last updated: October 14, 2025
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Browser Extension Modal */}
      {showExtensionModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.9)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          padding: '20px'
        }} onClick={() => setShowExtensionModal(false)}>
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
              onClick={() => setShowExtensionModal(false)}
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
            
            <h2 style={{ color: '#00d4ff', marginBottom: '20px' }}>Browser Extension - Privacy Policy & Data Protection</h2>
            
            <div style={{ color: '#b0b0b0', lineHeight: '1.6' }}>
              <h3 style={{ color: '#00d4ff', marginTop: '20px' }}>Data Collection</h3>
              <p>QNet Wallet browser extension does not collect, store, or transmit any personal user data. All wallet information, including private keys, seed phrases, and transaction history, is stored locally in your browser using AES-256 encryption.</p>
              
              <h3 style={{ color: '#00d4ff', marginTop: '20px' }}>Local Storage</h3>
              <p>The extension uses browser local storage to securely store encrypted wallet data. This data never leaves your device and is not accessible to QNet servers or third parties.</p>
              
              <h3 style={{ color: '#00d4ff', marginTop: '20px' }}>Network Interactions</h3>
              <p>The wallet connects to blockchain networks (QNet and Solana) only to broadcast transactions and retrieve public blockchain data. No personal information is transmitted during these interactions.</p>
              
              <h3 style={{ color: '#00d4ff', marginTop: '20px' }}>Third-Party Services</h3>
              <p>The wallet may connect to decentralized applications (dApps) when explicitly authorized by the user. These connections are direct and do not involve QNet as an intermediary.</p>
              
              <h3 style={{ color: '#00d4ff', marginTop: '20px' }}>Security</h3>
              <p>All sensitive data is encrypted using industry-standard AES-256 encryption. Private keys are generated locally and never transmitted over the internet.</p>
              
              <h3 style={{ color: '#00d4ff', marginTop: '20px' }}>Technical Specifications</h3>
              <p><strong>Extension Size:</strong> 3.2MB (630KiB)<br/>
              <strong>Version:</strong> 2.1.0<br/>
              <strong>Supported Browsers:</strong> Chrome 88+, Firefox 89+, Edge 88+, Brave<br/>
              <strong>Web3 Compatible:</strong> Yes<br/>
              <strong>Hardware Wallet Support:</strong> Ledger</p>
              
              <h3 style={{ color: '#00d4ff', marginTop: '20px' }}>Children's Privacy</h3>
              <p>Our extension is not intended for users under 18 years of age. We do not knowingly collect information from children.</p>
              
              <h3 style={{ color: '#00d4ff', marginTop: '20px' }}>Your Rights</h3>
              <ul style={{ marginLeft: '20px' }}>
                <li>Export your wallet seed phrase at any time</li>
                <li>Delete all extension data by removing the extension</li>
                <li>Control what information is shared on the blockchain</li>
                <li>Operate your node pseudonymously</li>
              </ul>
              
              <h3 style={{ color: '#00d4ff', marginTop: '20px' }}>Compliance</h3>
              <p>This privacy policy complies with:</p>
              <ul style={{ marginLeft: '20px' }}>
                <li>GDPR (General Data Protection Regulation)</li>
                <li>CCPA (California Consumer Privacy Act)</li>
                <li>Chrome Web Store requirements</li>
                <li>Firefox Add-ons policies</li>
              </ul>
              
              <h3 style={{ color: '#00d4ff', marginTop: '20px' }}>Contact</h3>
              <p>
                For privacy-related questions:<br/>
                Twitter: <a href="https://x.com/AIQnetLab" style={{ color: '#00d4ff' }}>@AIQnetLab</a><br/>
                Website: <a href="https://aiqnet.io" style={{ color: '#00d4ff' }}>https://aiqnet.io</a>
              </p>

              <div style={{ 
                marginTop: '30px', 
                padding: '20px', 
                backgroundColor: 'rgba(0, 212, 255, 0.1)',
                borderRadius: '8px',
                border: '1px solid rgba(0, 212, 255, 0.3)'
              }}>
                <p style={{ marginBottom: '15px', fontSize: '14px' }}>
                  <strong>Status:</strong> <span style={{ color: '#00ff88' }}>✓ Available Now</span>
                </p>
                <button
                  style={{
                    padding: '10px 20px',
                    backgroundColor: '#00d4ff',
                    color: '#0a0a14',
                    border: 'none',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontWeight: 'bold',
                    fontSize: '16px',
                    width: '100%'
                  }}
                  onClick={() => window.open('https://chromewebstore.google.com/detail/qnet-wallet/pahnggomgmhhjjncgfnmmofmplfhkncg', '_blank')}
                >
                  Install from Chrome Web Store
                </button>
              </div>
              
              <p style={{ marginTop: '30px', fontSize: '12px', color: '#666' }}>
                Last updated: October 14, 2025
              </p>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}