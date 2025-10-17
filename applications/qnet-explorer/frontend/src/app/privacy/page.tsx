'use client';

export default function PrivacyPage() {
  return (
    <div className="page-privacy">
      <section className="explorer-section" data-section="privacy">
        <div className="explorer-header">
          <h2 className="section-title">Privacy Policy</h2>
          <p className="section-subtitle">
            QNet Wallet for Android - Privacy Policy & Data Protection
          </p>
        </div>

        <div className="content-card" style={{ maxWidth: '900px', margin: '0 auto' }}>
          
          <div className="privacy-section">
            <h3>Data Collection</h3>
            <p>
              QNet Wallet for Android does not collect, store, or transmit any personal user data. 
              All wallet information, including private keys, seed phrases, and transaction history, 
              is stored locally on your device using AES-256 encryption.
            </p>
          </div>

          <div className="privacy-section">
            <h3>Local Storage</h3>
            <p>
              The wallet uses secure device storage to store encrypted wallet data. This data never 
              leaves your device and is not accessible to QNet servers or third parties. Hardware-backed 
              keystore is used when available.
            </p>
          </div>

          <div className="privacy-section">
            <h3>Network Interactions</h3>
            <p>
              The wallet connects to blockchain networks (QNet and Solana) only to broadcast transactions 
              and retrieve public blockchain data. No personal information is transmitted during these interactions.
            </p>
          </div>

          <div className="privacy-section">
            <h3>Third-Party Services</h3>
            <p>
              The wallet may connect to decentralized applications (dApps) when explicitly authorized by 
              the user. These connections are direct and do not involve QNet as an intermediary.
            </p>
          </div>

          <div className="privacy-section">
            <h3>Security</h3>
            <p>
              All sensitive data is encrypted using industry-standard AES-256 encryption with ProGuard 
              obfuscation. Private keys are generated locally and never transmitted over the internet. 
              Hardware-backed keystore provides additional protection.
            </p>
          </div>

          <div className="privacy-section">
            <h3>Technical Specifications</h3>
            <ul>
              <li><strong>App Size:</strong> 34MB (AAB bundle)</li>
              <li><strong>Launch Time:</strong> 1.4 seconds</li>
              <li><strong>Battery Usage:</strong> &lt;0.01% daily</li>
              <li><strong>Min Android Version:</strong> 6.0 (API 23)</li>
              <li><strong>Target Version:</strong> Android 14 (API 34)</li>
            </ul>
          </div>

          <div className="privacy-section">
            <h3>Permissions Required</h3>
            <p>
              Camera (QR code scanning only), Internet (blockchain connectivity), Biometric (optional authentication), 
              Storage (encrypted wallet data). No location tracking, contacts access, or background mining.
            </p>
          </div>

          <div className="privacy-section">
            <h3>Children's Privacy</h3>
            <p>
              Our app is not intended for users under 18 years of age. We do not knowingly collect information from children.
            </p>
          </div>

          <div className="privacy-section">
            <h3>Data Breach</h3>
            <p>
              Since we don't store your private data on our servers, a breach of our systems cannot compromise 
              your wallet. Your device security is critical - always keep your seed phrase backed up securely offline.
            </p>
          </div>

          <div className="privacy-section">
            <h3>Your Rights</h3>
            <ul>
              <li>Export your wallet seed phrase at any time</li>
              <li>Delete all app data by uninstalling the application</li>
              <li>Control what information is shared on the blockchain</li>
              <li>Operate your node pseudonymously</li>
            </ul>
          </div>

          <div className="privacy-section">
            <h3>Compliance</h3>
            <p>This privacy policy complies with:</p>
            <ul>
              <li>GDPR (General Data Protection Regulation)</li>
              <li>CCPA (California Consumer Privacy Act)</li>
              <li>Google Play Store requirements</li>
            </ul>
          </div>

          <div className="privacy-section">
            <h3>Contact</h3>
            <p>For privacy-related questions:</p>
            <ul>
              <li><strong>Twitter:</strong> <a href="https://twitter.com/AIQnetLab" target="_blank" rel="noopener noreferrer">@AIQnetLab</a></li>
              <li><strong>Website:</strong> <a href="https://aiqnet.io" target="_blank" rel="noopener noreferrer">https://aiqnet.io</a></li>
            </ul>
          </div>

          <div className="privacy-section" style={{ 
            textAlign: 'center', 
            marginTop: '3rem',
            paddingTop: '2rem',
            borderTop: '1px solid rgba(0, 255, 136, 0.2)'
          }}>
            <p style={{ fontSize: '0.9rem', opacity: 0.7 }}>
              Last updated: October 17, 2025
            </p>
          </div>

        </div>
      </section>
    </div>
  );
}

