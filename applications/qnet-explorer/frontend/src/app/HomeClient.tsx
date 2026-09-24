'use client';

import { useState, useEffect, useRef } from 'react';
import { useChainHead } from '@/hooks/useChainHead';
import Link from 'next/link';

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

interface HomeClientProps {
  initialStats: NetworkStats | null;
}

export default function HomeClient({ initialStats }: HomeClientProps) {
  // Use SSR data as initial state - NO LOADING DASHES if data exists!
  const [stats, setStats] = useState<NetworkStats | null>(initialStats);

  // Helper to format time remaining
  const formatTimeRemaining = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) {
      return `~${hours}h ${minutes}m`;
    }
    return `~${minutes}m`;
  };

  const fetchStats = async () => {
      try {
        // Add timestamp to bypass browser cache
        const res = await fetch(`/api/network/stats?t=${Date.now()}`, {
          cache: 'no-store'
        });
        const data = await res.json();
        if (data.success && data.data) {
          setStats(data.data);
        }
      } catch (err) {
        /* log disabled */
      }
  };

  // Stats follow the chain head: refetch on a new block, at most every 10 s, only while visible.
  const head = useChainHead();
  const lastStats = useRef(0);
  useEffect(() => {
    if (!head.height) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const now = Date.now();
    if (now - lastStats.current < 10_000) return;
    lastStats.current = now;
    void fetchStats();
  }, [head.height]); // eslint-disable-line react-hooks/exhaustive-deps
  
  return (
    <div className="page-home">
      <section className="hero-section">
        <div className="hero-content">
          <div className="hero-text">
            <h1 className="hero-title">
              <span className="title-main">Quantum Network</span>
              <span className="subtitle">An experimental blockchain designed by one person and built with AI assistance</span>
            </h1>

            <div className="hero-description">
              <p>
                No funding. No team. No corporate backing. The architecture and every protocol decision are one
                person&apos;s; the code is written with AI tools under that direction — to prove that a single
                developer can build a quantum-resistant blockchain that challenges the entire industry.
              </p>
            </div>
            
            <div className="action-buttons">
              <Link href="/wallet" className="qnet-button large secondary">Get Mobile App</Link>
              <Link href="/explorer" className="qnet-button secondary large">Explore Network</Link>
            </div>
          </div>
          
          <div className="hero-stats">
            <div className="stat-card">
              <div className="stat-number">{stats?.activeNodes !== undefined ? stats.activeNodes : '—'}</div>
              <div className="stat-label">ACTIVE NODES</div>
              <div className="stat-trend">{stats?.activeLightNodes !== undefined ? `${stats.activeLightNodes} light node${stats.activeLightNodes === 1 ? '' : 's'}` : 'Live data'}</div>
            </div>
            <div className="stat-card">
              <div className="stat-number">13k</div>
              <div className="stat-label">TRANSFERS/SEC</div>
              <div className="stat-trend">measured E2E · 40-80k on validator hardware</div>
            </div>
            <div className="stat-card">
              <div className="stat-number">{stats?.currentRound !== undefined ? stats.currentRound : '—'}</div>
              <div className="stat-label">REWARD EPOCH</div>
              <div className="stat-trend">
                {stats ? `Next: ${String(stats.blocksUntilReward).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} blocks (${formatTimeRemaining(stats.secondsUntilReward)})` : 'Loading...'}
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-number">{stats?.circulatingFormatted || '—'}</div>
              <div className="stat-label">QNC SUPPLY</div>
              <div className="stat-trend">Circulating / Max: 4.29B</div>
            </div>
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
                  <a href="https://github.com/AIQnetLab/QNet-Blockchain/actions" target="_blank" rel="noopener noreferrer" className="verify-link">
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
              ML-DSA-65 (NIST FIPS 204) signatures on every transaction and consensus message, ML-KEM-768
              (FIPS 203) key exchange between nodes. NIST-standardised algorithms against quantum computing threats.
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
            <h3>13,000 Transfers/sec Measured</h3>
            <p>
              13,000 finalized transfers per second measured end-to-end on a 5-node testnet
              with 1-second blocks and post-quantum signatures. Validator-grade hardware
              projects to 40-80k.
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
            <h3>Pool #3</h3>
            <p>
              In Phase 2 the QNC spent on activation goes to Pool #3, which is shared among all
              active nodes. None of it goes to the publisher.
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
              No token locking, no slashing of funds. A node that signs two conflicting blocks is proven on
              chain and excluded from consensus; everyone else keeps full liquidity and an equal say.
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
              A phone runs a light node by signing a periodic status request — nothing is computed, and battery use
              is that of a messaging app. Keys live in the hardware-backed keystore on iOS and Android.
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
              Every line of code is public on GitHub: the wallet apps and the explorer under Apache-2.0, the node
              under the Business Source License 1.1. Verifiable builds ensure the live version matches public code.
            </p>
          </div>
        </div>
      </section>

      <section className="technology-section">
        <div className="section-header">
          <h2 className="section-title">Mobile-First Blockchain</h2>
          <p className="section-subtitle">
            A blockchain designed for phones: participation is a signed answer, not computation
          </p>
        </div>

        <div className="technology-grid expanded">
          <div className="tech-item">
            <h4 className="tech-title">Presence, Not Computation</h4>
            <p>A light node answers a signed status request from the network a few times per four-hour epoch. Between requests the app only sends one signed attestation per epoch; nothing is computed, the device stays cool and the battery barely notices.</p>
          </div>
          <div className="tech-item">
            <h4 className="tech-title">iOS</h4>
            <p>Keys in the Keychain, Face ID or Touch ID unlock, silent push wake-ups for status requests. App Store listing in preparation.</p>
          </div>
          <div className="tech-item">
            <h4 className="tech-title">Android</h4>
            <p>Keys in the Android Keystore, biometric unlock, background wake-ups that survive Doze. Google Play listing in preparation.</p>
          </div>
          <div className="tech-item">
            <h4 className="tech-title">Hardware-Backed Security</h4>
            <p>iOS Keychain & Android Keystore integration. Post-quantum keys stored in secure hardware enclaves.</p>
          </div>
          <div className="tech-item">
            <h4 className="tech-title">Rewards for Answering</h4>
            <p>Each epoch&apos;s answers are recorded on chain. That epoch&apos;s emission is shared by the nodes that answered — three quarters among light nodes, one quarter among super nodes — and claimed from the app.</p>
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
            <p>1DEV tokens are BURNED on Solana for node activation. 1,500 1DEV burn for any node type; the amount decreases as the supply burns. The tokens are destroyed and nobody receives them. Transition at 90% burned OR 5 years.</p>
          </div>
          <div className="tech-item">
            <h4 className="tech-title">Phase 2: QNC to Pool #3 (Future)</h4>
            <p>Activation spends QNC, which goes to Pool #3 and is redistributed to all active nodes. The amount scales with network size; the exact schedule is set before Phase 2 opens.</p>
          </div>
          <div className="tech-item">
            <h4 className="tech-title">Sharp Drop Halving Innovation</h4>
            <p>Years 0-20: Standard ÷2 every 4 years | Years 20-24: Sharp drop ÷10 | Years 24+: Resume from low base. Saves 107M QNC!</p>
          </div>
          <div className="tech-item">
            <h4 className="tech-title">Activation Amount by Network Size</h4>
            <p>Network size multipliers: 0-100K nodes 0.5x, 100K-300K 1.0x, 300K-1M 2.0x, 1M+ 3.0x. Every Phase 2 activation goes to Pool #3.</p>
          </div>
          <div className="tech-item">
            <h4 className="tech-title">Two Reward Pools</h4>
            <p>1. Base emission on the halving schedule, split each epoch among the nodes that answered | 2. Pool #3, fed by Phase 2 activations and shared by all active nodes. Transaction fees go to the block producer.</p>
          </div>
          <div className="tech-item">
            <h4 className="tech-title">Post-Quantum Throughout</h4>
            <p>Signatures: ML-DSA-65 only — for wallets, nodes and consensus alike. Transport between nodes: TLS 1.3 over QUIC with hybrid X25519 + ML-KEM-768 key exchange, authenticated with ML-DSA-65.</p>
          </div>
          <div className="tech-item">
            <h4 className="tech-title">Equivocation Is Final</h4>
            <p>No token locking. Producers and committees are drawn by verifiable randomness from all eligible nodes; a signed proof of double-signing, recorded on chain, removes the offender from every future draw.</p>
          </div>
          <div className="tech-item">
            <h4 className="tech-title">Rate Limiting</h4>
            <p>Per-address limits by request class — 100 transactions and 300 reads a minute, 5 activations an hour — and a bounded pool for signature verification, so a flood of requests cannot starve consensus.</p>
          </div>
          <div className="tech-item">
            <h4 className="tech-title">Phase 1 on Solana</h4>
            <p>Activation burns 1DEV, an SPL token, on Solana; QNet nodes verify the burn transaction themselves. No bridge and no wrapped assets — Phase 2 moves activation to native QNC.</p>
          </div>
        </div>
      </section>
    </div>
  );
}

