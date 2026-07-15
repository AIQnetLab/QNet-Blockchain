'use client';

import React, { useEffect, useRef, useState } from 'react';

// Custom hook to manage animations with Intersection Observer
const useAnimateOnScroll = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          // Add 'in-view' class when element is visible
          entry.target.classList.toggle('in-view', entry.isIntersecting);
        });
      },
      {
        threshold: 0.1, // Trigger when 10% of the element is visible
      }
    );

    const elements = containerRef.current?.querySelectorAll('.feature-card, .tech-item');
    if (elements) {
      elements.forEach((el) => observer.observe(el));
    }

    return () => {
      if (elements) {
        elements.forEach((el) => observer.unobserve(el));
      }
    };
  }, []);

  return containerRef;
};

interface NetworkStats {
  activeNodes: number;
  activeLightNodes?: number;
  currentRound: number;
  height: number;
  blocksUntilReward: number;
  secondsUntilReward: number;
  circulatingSupply?: number;
  circulatingFormatted?: string;
}

// Helper to format time remaining
const formatTimeRemaining = (seconds: number): string => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) {
    return `~${hours}h ${minutes}m`;
  }
  return `~${minutes}m`;
};

// Memoized functional component for the Home section
const HomeSection = React.memo(function HomeSection({ setActiveSection }: { setActiveSection: (section: string) => void }) {
  const animatedContainerRef = useAnimateOnScroll();
  const [stats, setStats] = useState<NetworkStats | null>(null);
  
  useEffect(() => {
    const fetchStats = async () => {
      try {
        const res = await fetch(`/api/network/stats?t=${Date.now()}`, {
          cache: 'no-store'
        });
        if (res.ok) {
          const data = await res.json();
          if (data.success && data.data) {
            setStats(data.data);
          }
        }
      } catch (err) {
        /* log disabled */
      }
    };

    fetchStats();
    // Update every 5 seconds (same as main page)
    const interval = setInterval(fetchStats, 5000);
    return () => clearInterval(interval);
  }, []);
  
  return (
    <div ref={animatedContainerRef}>
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
              <button 
                className="qnet-button large primary"
                onClick={() => setActiveSection('wallet')}
              >
                Get Mobile App
              </button>
              <button 
                className="qnet-button secondary large"
                onClick={() => setActiveSection('explorer')}
              >
                Explore Network
              </button>
            </div>
          </div>
          
          {/* Network Statistics */}
          <div className="hero-stats">
            <div className="stat-card">
              <div className="stat-number">{stats?.activeNodes || '—'}</div>
              <div className="stat-label">ACTIVE NODES</div>
              <div className="stat-trend">{stats ? `+${(stats.activeLightNodes ?? 0).toLocaleString()} light (prev epoch)` : 'Live data'}</div>
            </div>
            <div className="stat-card">
              <div className="stat-number">~100k</div>
              <div className="stat-label">TPS PER SHARD</div>
              <div className="stat-trend">256 shards available</div>
            </div>
            <div className="stat-card">
              <div className="stat-number">{stats?.currentRound !== undefined ? stats.currentRound : '—'}</div>
              <div className="stat-label">REWARD EPOCH</div>
              <div className="stat-trend">
                {stats ? `Next: ${stats.blocksUntilReward.toLocaleString()} blocks (${formatTimeRemaining(stats.secondsUntilReward)})` : 'Loading...'}
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-number">{stats?.circulatingFormatted || '—'}</div>
              <div className="stat-label">QNC SUPPLY</div>
              <div className="stat-trend">Circulating / Max: 4.29B</div>
            </div>
            {/* GitHub Code Verification Section */}
            <div className="code-verification-banner">
              <div className="verification-text-container">
                <h3>100% Open Source Code</h3>
                <p>This website uses exactly the same<br />code that is published on GitHub</p>
              </div>
              <div className="verification-flicker-word">VERIFY</div>
              <div className="verification-right">
                <div className="verification-links">
                  <a href="https://github.com/AIQnetLab/QNet-Blockchain/tree/testnet" target="_blank" rel="noopener noreferrer" className="github-link">
                    Check source code
                  </a>
                  <a href="/api/verify-build" target="_blank" rel="noopener noreferrer" className="verify-link">
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
          {/* Feature Cards */}
          <div className="feature-card premium">
            <div className="feature-icon-wrapper">
                <div className="lock-icon">
                    <div className="lock-body">
                        <div className="keyhole"></div>
                    </div>
                    <div className="lock-shackle"></div>
                </div>
            </div>
            <h3>Post-Quantum Cryptography</h3>
            <p>
              ML-DSA-65 (NIST FIPS 204) quantum signatures. 31/31 crypto tests passed (100% perfect). 
              NIST-approved algorithms protecting against quantum computing threats.
            </p>
          </div>
          
          <div className="feature-card premium">
              <div className="feature-icon-wrapper">
                  <div className="lightning-icon"></div>
              </div>
              <h3>~100k TPS per Shard</h3>
              <p>
                  Scalable sharding architecture with 256 shards. Each shard achieves ~100k TPS. 
                  Microblock architecture with pBFT consensus for high throughput.
              </p>
          </div>
          
          <div className="feature-card premium">
              <div className="feature-icon-wrapper">
                  <div className="pool-icon">#3</div>
              </div>
              <h3>Pool #3 Innovation</h3>
              <p>
                  When users pay QNC to activate Phase 2 nodes, their QNC goes to Pool #3 
                  which redistributes rewards to ALL active nodes. Everyone benefits from network growth!
              </p>
          </div>
          
          <div className="feature-card premium">
              <div className="feature-icon-wrapper">
                  <div className="rep-icon">REP</div>
              </div>
              <h3>Reputation-Based Security</h3>
              <p>
                  No token locking or slashing! Security through reputation scoring (0-100). 
                  Full liquidity maintained while ensuring network security through behavior-based trust.
              </p>
          </div>
          
          <div className="feature-card premium">
              <div className="feature-icon-wrapper">
                  <div className="mobile-icon">📱</div>
              </div>
              <h3>Mobile-First Design</h3>
              <p>
                  NOT MINING certified! Simple ping responses every 4 hours. 
                  Battery usage like messaging apps. iOS/Android store ready with hardware security.
              </p>
          </div>
          <div className="feature-card premium">
              <div className="feature-icon-wrapper">
                  <div className="transparency-icon">100%</div>
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
            <h4>NOT Mining Certified</h4>
            <p>Simple ping responses every 4 hours. &lt;1 second processing, &lt;0.01% battery usage. No CPU/GPU mining, no device heating.</p>
          </div>
          <div className="tech-item">
            <h4>iOS App Store Ready</h4>
            <p>1.2s launch time, 23MB memory, Hardware Keychain integration. TestFlight ready for July 2025 submission.</p>
          </div>
          <div className="tech-item">
            <h4>Android Play Store Ready</h4>
            <p>1.4s launch time, 28MB memory, Target API 34 (Android 14). Doze mode optimized, AAB package ready.</p>
          </div>
          <div className="tech-item">
            <h4>Hardware-Backed Security</h4>
            <p>iOS Keychain & Android Keystore integration. Post-quantum keys stored in secure hardware enclaves.</p>
          </div>
          <div className="tech-item">
            <h4>Ping-Based Participation</h4>
            <p>Every 4 hours network ping with cryptographic proof. Rewards from two pools: Base Emission and Pool #3 activation benefits.</p>
          </div>
          <div className="tech-item">
            <h4>11 Languages Supported</h4>
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
            <h4>Phase 1: 1DEV Burn (Current)</h4>
            <p>1DEV tokens are BURNED on Solana for node activation. 1,500 1DEV burn for any node type. Price decreases with burn progress. Transition at 90% burned OR 5 years.</p>
          </div>
          <div className="tech-item">
            <h4>Phase 2: QNC to Pool #3 (Future)</h4>
            <p>QNC tokens are SENT TO POOL #3 for node activation. DYNAMIC PRICING v3.18: Light(10k-30k), Super(7.5k-22.5k) QNC based on network size → Pool #3 → redistributed to ALL active nodes!</p>
          </div>
          <div className="tech-item">
            <h4>Sharp Drop Halving Innovation</h4>
            <p>Years 0-20: Standard ÷2 every 4 years | Years 20-24: Sharp drop ÷10 | Years 24+: Resume from low base. Saves 107M QNC!</p>
          </div>
          <div className="tech-item">
            <h4>Dynamic Activation Pricing</h4>
            <p>Network size multipliers: 0-100K nodes (0.5x discount), 100K-300K (1.0x standard), 300K-1M (2.0x), 1M+ (3.0x premium). ALL fees → Pool #3!</p>
          </div>
          <div className="tech-item">
            <h4>Two Reward Pools</h4>
            <p>1. Base Emission (halving schedule) | 2. Activation Pool #3 (ALL nodes benefit)</p>
          </div>
          <div className="tech-item">
            <h4>Hybrid Post-Quantum Cryptography</h4>
            <p>Dilithium2 + Ed25519 dual-signature system. Best of both worlds: quantum-resistant + high-performance. Future-proof security architecture.</p>
          </div>
          <div className="tech-item">
            <h4>Reputation-Based Consensus</h4>
            <p>Score range 0-100. No token locking. Double-sign detection with automatic penalties. Mobile-friendly security.</p>
          </div>
          <div className="tech-item">
            <h4>Rate Limiting & DDoS Protection</h4>
            <p>Token bucket system: 30 requests/minute per peer. Real-time spam detection. Regional load balancing across 6 continents.</p>
          </div>
          <div className="tech-item">
            <h4>Cross-Chain Integration</h4>
            <p>Solana SPL token (1DEV) bridge for Phase 1 activation. Seamless transition to native QNC in Phase 2 with Pool #3 benefits.</p>
          </div>
        </div>
      </section>
    </div>
  );
});

export default HomeSection; 
