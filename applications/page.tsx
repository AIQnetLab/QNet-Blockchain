'use client'

import React, { useState } from 'react'
import './globals.css'

export default function Page() {
  const [activeSection, setActiveSection] = useState('home')

  return (
    <div className="qnet-container">
      <header className="qnet-header">
        <div className="header-content">
          <div className="qnet-logo">QNet</div>
          <nav className="qnet-nav">
            <button 
              className={`nav-button ${activeSection === 'home' ? 'active' : ''}`}
              onClick={() => setActiveSection('home')}
            >
              Home
            </button>
            <button 
              className={`nav-button ${activeSection === 'explorer' ? 'active' : ''}`}
              onClick={() => setActiveSection('explorer')}
            >
              Explorer
            </button>
            <button 
              className={`nav-button ${activeSection === 'testnet' ? 'active' : ''}`}
              onClick={() => setActiveSection('testnet')}
            >
              Testnet
            </button>
            <button 
              className={`nav-button ${activeSection === 'wallet' ? 'active' : ''}`}
              onClick={() => setActiveSection('wallet')}
            >
              Wallet
            </button>
            <button 
              className={`nav-button ${activeSection === 'nodes' ? 'active' : ''}`}
              onClick={() => setActiveSection('nodes')}
            >
              Nodes
            </button>
            <button 
              className={`nav-button ${activeSection === 'docs' ? 'active' : ''}`}
              onClick={() => setActiveSection('docs')}
            >
              Docs
            </button>
          </nav>
          <div className="header-right">
            <div className="status-dot"></div>
          </div>
        </div>
      </header>

      <main className="qnet-main">
        {activeSection === 'home' && (
          <section className="hero-section">
            <div className="hero-content">
              <div className="hero-text">
                <div className="hero-title">
                  <span className="title-main">QNet Explorer</span>
                  <span className="subtitle">World's First Mobile-First Quantum-Resistant Experimental Blockchain</span>
                </div>
                <div className="hero-description">
                  <p>
                    AI-designed post-quantum cryptography with 424,411 TPS verified performance. 
                    Revolutionary Pool #3 system where activation fees benefit all active nodes. 
                    This is an experimental blockchain - no guarantees provided.
                  </p>
                </div>
                <div className="action-buttons">
                  <button className="qnet-button large" onClick={() => setActiveSection('explorer')}>
                    EXPLORE NETWORK
                  </button>
                  <button className="qnet-button large secondary" onClick={() => setActiveSection('testnet')}>
                    TESTNET ACCESS
                  </button>
                </div>
              </div>
              <div className="network-stats">
                <div className="stat-card">
                  <div className="stat-number">424,411</div>
                  <div className="stat-label">Max TPS</div>
                  <div className="stat-trend">Verified Performance</div>
                </div>
                <div className="stat-card">
                  <div className="stat-number">31/31</div>
                  <div className="stat-label">Crypto Tests</div>
                  <div className="stat-trend">All Passed</div>
                </div>
                <div className="stat-card">
                  <div className="stat-number">Post-Quantum</div>
                  <div className="stat-label">Security</div>
                  <div className="stat-trend">Kyber + Dilithium</div>
                </div>
                <div className="stat-card">
                  <div className="stat-number">Mobile-First</div>
                  <div className="stat-label">Design</div>
                  <div className="stat-trend">AI-Designed</div>
                </div>
              </div>
            </div>
          </section>
        )}

        {activeSection === 'explorer' && (
          <section className="explorer-section">
            <div className="section-header">
              <h2 className="section-title">Network Explorer</h2>
              <p className="section-subtitle">Real-time blockchain monitoring and analysis</p>
            </div>
            
            <div className="features-grid">
              <div className="feature-card">
                <h3>Blockchain Data</h3>
                <p>Explore blocks, transactions, and network statistics</p>
              </div>
              <div className="feature-card">
                <h3>Node Status</h3>
                <p>Monitor active nodes and network health</p>
              </div>
              <div className="feature-card">
                <h3>Performance Metrics</h3>
                <p>Real-time TPS and network performance data</p>
              </div>
            </div>
          </section>
        )}

        {activeSection === 'testnet' && (
          <section className="testnet-section">
            <div className="section-header">
              <h2 className="section-title">QNet Testnet</h2>
              <p className="section-subtitle">Experimental network for testing and development</p>
            </div>
            
            <div className="testnet-content">
              <div className="feature-card premium">
                <h3>Testnet Access</h3>
                <p>
                  Join our experimental testnet to explore QNet's capabilities. 
                  Test transactions, smart contracts, and node operations in a safe environment.
                </p>
                <button className="qnet-button primary large">
                  ACCESS TESTNET
                </button>
              </div>
              
              <div className="features-grid">
                <div className="tech-item">
                  <h4>Test Network Features</h4>
                  <p>Full blockchain functionality with test tokens</p>
                </div>
                <div className="tech-item">
                  <h4>Node Testing</h4>
                  <p>Test node activation and Pool #3 mechanics</p>
                </div>
              </div>
            </div>
          </section>
        )}

        {activeSection === 'wallet' && (
          <section className="wallet-section">
            <div className="section-header">
              <h2 className="section-title">QNet Wallet</h2>
              <p className="section-subtitle">Mobile-first quantum-resistant wallet apps</p>
            </div>

            <div className="wallet-status">
              <div className="status-banner">
                <h3>Mobile Apps - July 2025 Launch</h3>
                <p>QNet Wallet apps for iOS and Android launching in July 2025</p>
              </div>
            </div>

            <div className="download-section">
              <div className="download-grid">
                <div className="download-card">
                  <div className="app-logo">
                    <img src="https://developer.apple.com/assets/elements/badges/download-on-the-app-store.svg" alt="Download on App Store" style={{width: '120px', height: 'auto'}} />
                  </div>
                  <h3>iOS App</h3>
                  <p>iPhone and iPad compatible wallet with biometric security</p>
                  <div className="download-status">July 2025</div>
                  <button className="qnet-button disabled">
                    COMING SOON
                  </button>
                </div>
                
                <div className="download-card">
                  <div className="app-logo">
                    <img src="https://play.google.com/intl/en_us/badges/static/images/badges/en_badge_web_generic.png" alt="Get it on Google Play" style={{width: '120px', height: 'auto'}} />
                  </div>
                  <h3>Android App</h3>
                  <p>Full-featured wallet with hardware security module support</p>
                  <div className="download-status">July 2025</div>
                  <button className="qnet-button disabled">
                    COMING SOON
                  </button>
                </div>
              </div>
            </div>
          </section>
        )}

        {activeSection === 'nodes' && (
          <section className="nodes-section">
            <div className="section-header">
              <h2 className="section-title">QNet Nodes</h2>
              <p className="section-subtitle">Join the quantum-resistant network</p>
            </div>
            
            <div className="features-grid">
              <div className="feature-card">
                <h3>Light Node</h3>
                <p>Minimal resource usage, perfect for mobile devices</p>
                <button className="qnet-button">LEARN MORE</button>
              </div>
              <div className="feature-card">
                <h3>Full Node</h3>
                <p>Complete blockchain validation and storage</p>
                <button className="qnet-button">LEARN MORE</button>
              </div>
              <div className="feature-card">
                <h3>Super Node</h3>
                <p>High-performance nodes for maximum rewards</p>
                <button className="qnet-button primary">LEARN MORE</button>
              </div>
            </div>
          </section>
        )}

        {activeSection === 'docs' && (
          <section className="docs-section">
            <div className="section-header">
              <h2 className="section-title">Documentation</h2>
              <p className="section-subtitle">Technical guides and API references</p>
            </div>
            
            <div className="features-grid">
              <div className="feature-card">
                <h3>Getting Started</h3>
                <p>Quick setup guide for developers and users</p>
                <button className="qnet-button">VIEW GUIDE</button>
              </div>
              <div className="feature-card">
                <h3>API Reference</h3>
                <p>Complete REST API and WebSocket documentation</p>
                <button className="qnet-button">VIEW DOCS</button>
              </div>
              <div className="feature-card">
                <h3>Technical Papers</h3>
                <p>Cryptographic proofs and network architecture</p>
                <button className="qnet-button secondary">READ MORE</button>
              </div>
            </div>
          </section>
        )}
      </main>

      <footer className="qnet-footer">
        <div className="footer-content">
          <div className="footer-left">
            <div className="qnet-logo">QNet</div>
            <p>Experimental AI-designed blockchain</p>
            <p>31/31 cryptographic tests passed</p>
          </div>
          <div className="footer-center">
            <div className="footer-links">
              <a href="#home">Home</a>
              <a href="#explorer">Explorer</a>
              <a href="#testnet">Testnet</a>
              <a href="#docs">Documentation</a>
            </div>
          </div>
          <div className="footer-right">
            <div style={{marginBottom: '1rem'}}>
              <img src="https://developer.apple.com/assets/elements/badges/download-on-the-app-store.svg" alt="App Store" style={{width: '100px', marginRight: '10px'}} />
              <img src="https://play.google.com/intl/en_us/badges/static/images/badges/en_badge_web_generic.png" alt="Google Play" style={{width: '100px'}} />
            </div>
            <p style={{fontSize: '0.8rem'}}>July 2025 Launch</p>
          </div>
        </div>
      </footer>
    </div>
  )
} 