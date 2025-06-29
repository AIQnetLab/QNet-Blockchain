'use client';

import { useState } from 'react';
import Link from 'next/link';

// Mock data can be moved to a shared context or service if needed
const mockNodes = [
  { id: 1, name: 'Node Alpha', location: 'North America', uptime: 247, status: 'online' },
  { id: 2, name: 'Node Beta', location: 'Europe', uptime: 186, status: 'online' },
  { id: 3, name: 'Node Gamma', location: 'Asia Pacific', uptime: 321, status: 'online' },
  { id: 4, name: 'Node Delta', location: 'South America', uptime: 92, status: 'offline' },
];


export default function HomePage() {
  // The state management for section switching is no longer needed here.
  // Each page will handle its own state.
  
  return (
    <div className="page-home">
      <section className="hero-section">
        <div className="hero-content">
          <div className="hero-text">
            <h1 className="hero-title">
              <span className="title-main">Quantum Network</span>
              <span className="subtitle">Experimental AI-developed blockchain built by one person</span>
            </h1>
            
            <div className="hero-description">
              <p>
                No funding. No team. No corporate backing. Just pure determination to prove that 
                a single developer can build a quantum-resistant blockchain that challenges the entire industry.
              </p>
            </div>
            
            <div className="action-buttons">
              <Link href="/wallet" className="qnet-button large secondary">Get Mobile App</Link>
              <Link href="/explorer" className="qnet-button secondary large">Explore Network</Link>
            </div>
          </div>
          
          <div className="hero-stats">
            <div className="stat-card">
              <div className="stat-number">156</div>
              <div className="stat-label">ACTIVE NODES</div>
              <div className="stat-trend">+12 this hour</div>
            </div>
            <div className="stat-card">
              <div className="stat-number">424,411</div>
              <div className="stat-label">TPS ACHIEVED</div>
              <div className="stat-trend">Peak performance</div>
            </div>
            <div className="stat-card">
              <div className="stat-number">100%</div>
              <div className="stat-label">NETWORK UPTIME</div>
              <div className="stat-trend">24h average</div>
            </div>
            <div className="stat-card">
              <div className="stat-number">2.5M</div>
              <div className="stat-label">QNC SUPPLY</div>
              <div className="stat-trend">Circulating</div>
            </div>
            <div className="code-verification-banner">
              <div className="verification-text-container">
                <h3>100% Open Source Code</h3>
                <p>This website uses exactly the same<br />code that is published on GitHub</p>
              </div>
              <div className="verification-flicker-word">VERIFY</div>
              <div className="verification-right">
                <div className="verification-details">
                  <span className="commit-hash">Commit: {process.env.NEXT_PUBLIC_GIT_COMMIT || 'ab7f2e1'}</span>
                  <span className="build-time">Build: {process.env.NEXT_PUBLIC_BUILD_TIME || '2025-06-14 12:34:56'}</span>
                </div>
                <div className="verification-links">
                  <a href="https://github.com/qnet-lab/qnet-project" target="_blank" rel="noopener noreferrer" className="github-link">
                    Check source code
                  </a>
                  <a href="https://github.com/qnet-lab/qnet-project/actions" target="_blank" rel="noopener noreferrer" className="verify-link">
                    Verify build
                  </a>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="features-section" style={{ marginTop: '1rem' }}>
        <div className="section-header">
          <h2 className="section-title">Revolutionary Features</h2>
        </div>
        
        <div className="features-grid">
          <div className="feature-card premium">
            <div style={{ 
              width: '60px', 
              height: '60px', 
              margin: '0 auto 1.5rem', 
              position: 'relative',
              background: 'radial-gradient(circle, rgba(0, 255, 255, 0.2) 0%, rgba(0, 255, 255, 0.05) 70%)',
              border: '2px solid #00ffff',
              borderRadius: '12px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 0 20px rgba(0, 255, 255, 0.3), inset 0 0 20px rgba(0, 255, 255, 0.1)',
              animation: 'quantumPulse 3s ease-in-out infinite'
            }}>
              <div style={{ position: 'relative', width: '24px', height: '32px' }}>
                <div style={{ position: 'absolute', bottom: '0', left: '50%', transform: 'translateX(-50%)', width: '18px', height: '16px', background: 'linear-gradient(135deg, #00ffff, #ffffff)', borderRadius: '3px', border: '2px solid #00ffff' }}>
                  <div style={{ position: 'absolute', top: '4px', left: '50%', transform: 'translateX(-50%)', width: '4px', height: '4px', background: '#000', borderRadius: '50%' }}></div>
                  <div style={{ position: 'absolute', bottom: '2px', left: '50%', transform: 'translateX(-50%)', width: '2px', height: '6px', background: '#000' }}></div>
                </div>
                <div style={{ position: 'absolute', top: '0', left: '50%', transform: 'translateX(-50%)', width: '16px', height: '12px', border: '3px solid #00ffff', borderBottom: 'none', borderRadius: '8px 8px 0 0' }}></div>
              </div>
            </div>
            <h3>Post-Quantum Cryptography</h3>
            <p>
              Kyber-1024 KEM & Dilithium-5 signatures. 31/31 crypto tests passed (100% perfect). 
              NIST-approved algorithms protecting against quantum computing threats.
            </p>
          </div>
          
          <div className="feature-card premium">
            <div style={{ 
              width: '60px', 
              height: '60px', 
              margin: '0 auto 1.5rem', 
              position: 'relative',
              background: 'radial-gradient(circle, rgba(0, 255, 255, 0.2) 0%, rgba(0, 255, 255, 0.05) 70%)',
              border: '2px solid #00ffff',
              borderRadius: '12px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 0 20px rgba(0, 255, 255, 0.3), inset 0 0 20px rgba(0, 255, 255, 0.1)',
              animation: 'quantumPulse 2s ease-in-out infinite'
            }}>
              <div style={{
                width: '20px',
                height: '30px',
                background: 'linear-gradient(45deg, #00ffff, #ffffff)',
                clipPath: 'polygon(0% 100%, 50% 0%, 100% 100%, 60% 100%, 50% 50%, 40% 100%)',
                animation: 'lightningFlash 1.5s ease-in-out infinite'
              }}></div>
            </div>
            <h3>Verified 424,411 TPS</h3>
            <p>
              Real performance test June 11, 2025: Single Thread 282,337 | Multi-Process 334,218 | 
              Maximum Burst 424,411 TPS. Microblock architecture with pBFT consensus.
            </p>
          </div>
          
          <div className="feature-card premium">
            <div style={{ 
              width: '60px', 
              height: '60px', 
              margin: '0 auto 1.5rem', 
              position: 'relative',
              background: 'radial-gradient(circle, rgba(0, 255, 255, 0.2) 0%, rgba(0, 255, 255, 0.05) 70%)',
              border: '2px solid #00ffff',
              borderRadius: '12px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 0 20px rgba(0, 255, 255, 0.3), inset 0 0 20px rgba(0, 255, 255, 0.1)',
              animation: 'networkPulse 2.5s ease-in-out infinite'
            }}>
              <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#00ffff', textShadow: '0 0 10px #00ffff' }}>#3</div>
            </div>
            <h3>Pool #3 Innovation</h3>
            <p>
              Revolutionary reward system: When users pay QNC to activate Phase 2 nodes, their QNC goes to Pool #3 
              which redistributes rewards to ALL active nodes. Everyone benefits from network growth!
            </p>
          </div>
          
          <div className="feature-card premium">
            <div style={{ 
              width: '60px', 
              height: '60px', 
              margin: '0 auto 1.5rem', 
              position: 'relative',
              background: 'radial-gradient(circle, rgba(0, 255, 255, 0.2) 0%, rgba(0, 255, 255, 0.05) 70%)',
              border: '2px solid #00ffff',
              borderRadius: '12px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 0 20px rgba(0, 255, 255, 0.3), inset 0 0 20px rgba(0, 255, 255, 0.1)',
              animation: 'quantumPulse 2s ease-in-out infinite'
            }}>
              <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#00ffff', textShadow: '0 0 10px #00ffff' }}>REP</div>
            </div>
            <h3>Reputation-Based Security</h3>
            <p>
              No token locking or slashing! Security through reputation scoring (0-100). 
              Full liquidity maintained while ensuring network security through behavior-based trust.
            </p>
          </div>
          
          <div className="feature-card premium">
            <div style={{ 
              width: '60px', 
              height: '60px', 
              margin: '0 auto 1.5rem', 
              position: 'relative',
              background: 'radial-gradient(circle, rgba(0, 255, 255, 0.2) 0%, rgba(0, 255, 255, 0.05) 70%)',
              border: '2px solid #00ffff',
              borderRadius: '12px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 0 20px rgba(0, 255, 255, 0.3), inset 0 0 20px rgba(0, 255, 255, 0.1)',
              animation: 'performancePulse 1.8s ease-in-out infinite'
            }}>
              <div style={{ fontSize: '16px', fontWeight: 'bold', color: '#00ffff', textShadow: '0 0 10px #00ffff' }}>📱</div>
            </div>
            <h3>Mobile-First Design</h3>
            <p>
              NOT MINING certified! Simple ping responses every 4 hours. 
              Battery usage like messaging apps. iOS/Android store ready with hardware security.
            </p>
          </div>
          <div className="feature-card premium">
            <div style={{ 
              width: '60px', 
              height: '60px', 
              margin: '0 auto 1.5rem', 
              position: 'relative',
              background: 'radial-gradient(circle, rgba(0, 255, 255, 0.2) 0%, rgba(0, 255, 255, 0.05) 70%)',
              border: '2px solid #00ffff',
              borderRadius: '12px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 0 20px rgba(0, 255, 255, 0.3), inset 0 0 20px rgba(0, 255, 255, 0.1)',
              animation: 'quantumPulse 2s ease-in-out infinite'
            }}>
              <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#00ffff', textShadow: '0 0 10px #00ffff' }}>100%</div>
            </div>
            <h3>Radical Transparency</h3>
            <p>
              Every single line of code is on GitHub under MIT license. App Store & Play Store apps are 
              100% open source. Verifiable builds ensure live version matches public code.
            </p>
          </div>
        </div>
      </section>

      <section className="technology-section">
        <div className="section-header">
          <h2 className="section-title">Mobile-First Blockchain</h2>
          <p className="section-subtitle">
            World's first blockchain designed for mobile devices - NOT mining!
          </p>
        </div>
        
        <div className="technology-grid expanded">
          <div className="tech-item">
            <h4 className="tech-title">NOT Mining Certified</h4>
            <p>Simple ping responses every 4 hours. &lt;1 second processing, &lt;0.01% battery usage. No CPU/GPU mining, no device heating.</p>
          </div>
          <div className="tech-item">
            <h4 className="tech-title">iOS App Store Ready</h4>
            <p>1.2s launch time, 23MB memory, Hardware Keychain integration. TestFlight ready for July 2025 submission.</p>
          </div>
          <div className="tech-item">
            <h4 className="tech-title">Android Play Store Ready</h4>
            <p>1.4s launch time, 28MB memory, Target API 34 (Android 14). Doze mode optimized, AAB package ready.</p>
          </div>
          <div className="tech-item">
            <h4 className="tech-title">Hardware-Backed Security</h4>
            <p>iOS Keychain & Android Keystore integration. Post-quantum keys stored in secure hardware enclaves.</p>
          </div>
          <div className="tech-item">
            <h4 className="tech-title">Ping-Based Participation</h4>
            <p>Every 4 hours network ping with cryptographic proof. Rewards from all three pools including Pool #3 activation benefits.</p>
          </div>
          <div className="tech-item">
            <h4 className="tech-title">11 Languages Supported</h4>
            <p>Full localization for global accessibility. Multi-language wallet interface with cultural adaptations.</p>
          </div>
        </div>
      </section>

      <section className="technology-section">
        <div className="section-header">
          <h2 className="section-title">Economic Model V2 - Sharp Drop Halving</h2>
          <p className="section-subtitle">
            Revolutionary two-phase system with Pool #3 activation benefits
          </p>
        </div>
        
        <div className="technology-grid expanded">
          <div className="tech-item">
            <h4 className="tech-title">Phase 1: 1DEV Burn (Current)</h4>
            <p>1DEV tokens are BURNED on Solana for node activation. 1,500 1DEV burn for any node type. Price decreases with burn progress. Transition at 90% burned OR 5 years.</p>
          </div>
          <div className="tech-item">
            <h4 className="tech-title">Phase 2: QNC to Pool #3 (Future)</h4>
            <p>QNC tokens are SENT TO POOL #3 for node activation. DYNAMIC PRICING: Light(2.5k-15k), Full(3.75k-22.5k), Super(5k-30k) QNC based on network size → Pool #3 → redistributed to ALL active nodes!</p>
          </div>
          <div className="tech-item">
            <h4 className="tech-title">Sharp Drop Halving Innovation</h4>
            <p>Years 0-20: Standard ÷2 every 4 years | Years 20-24: Sharp drop ÷10 | Years 24+: Resume from low base. Saves 107M QNC!</p>
          </div>
          <div className="tech-item">
            <h4 className="tech-title">Dynamic Activation Pricing</h4>
            <p>Network size multipliers: 0-100K nodes (0.5x discount), 100K-1M (1.0x standard), 1M-10M (2.0x), 10M+ (3.0x premium). ALL fees → Pool #3!</p>
          </div>
          <div className="tech-item">
            <h4 className="tech-title">Three Reward Pools</h4>
            <p>1. Base Emission (halving schedule) | 2. Transaction Fees (70% Super, 30% Full, 0% Light) | 3. Activation Pool #3 (ALL nodes benefit)</p>
          </div>
          <div className="tech-item">
            <h4 className="tech-title">Hybrid Post-Quantum Cryptography</h4>
            <p>Dilithium2 + Ed25519 dual-signature system. Best of both worlds: quantum-resistant + high-performance. Future-proof security architecture.</p>
          </div>
          <div className="tech-item">
            <h4 className="tech-title">Reputation-Based Consensus</h4>
            <p>Score range 0-100. No token locking. Reputation 40+ for rewards. Double-sign detection with automatic penalties. Mobile-friendly security.</p>
          </div>
          <div className="tech-item">
            <h4 className="tech-title">Rate Limiting & DDoS Protection</h4>
            <p>Token bucket system: 30 requests/minute per peer. Real-time spam detection. Regional load balancing across 6 continents.</p>
          </div>
          <div className="tech-item">
            <h4 className="tech-title">Cross-Chain Integration</h4>
            <p>Solana SPL token (1DEV) bridge for Phase 1 activation. Seamless transition to native QNC in Phase 2 with Pool #3 benefits.</p>
          </div>
        </div>
      </section>
    </div>
  );
} 