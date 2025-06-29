'use client';

import { useState, useRef, useEffect } from 'react';
import Header from '@/components/Header';
import Footer from '@/components/Footer';

// Mock data
const mockBlocks = [
  { number: 1337, hash: '0xab3d...8f2e', txs: 45, time: '2s ago', status: 'confirmed' },
  { number: 1336, hash: '0x7c9a...4b1d', txs: 38, time: '14s ago', status: 'confirmed' },
  { number: 1335, hash: '0x9e5f...7a8c', txs: 52, time: '26s ago', status: 'confirmed' },
  { number: 1334, hash: '0x2d8b...1f9e', txs: 41, time: '38s ago', status: 'pending' },
];

const mockTransactions = [
  { hash: '0xa7c3...9d2e', type: 'Transfer', amount: '125.5 QNC', block: 1337 },
  { hash: '0x8f1b...4a7c', type: 'Node Activation', amount: '7,500 QNC → Pool #3 (Dynamic)', block: 1337 },
  { hash: '0x5e9d...3c8f', type: 'Smart Contract', amount: '89.2 QNC', block: 1336 },
  { hash: '0x2a6f...7e1d', type: '1DEV Burn', amount: '1,500 1DEV', block: 1336 },
];

const mockNodes = [
  { id: 1, name: 'Node Alpha', location: 'North America', uptime: 247, status: 'online' },
  { id: 2, name: 'Node Beta', location: 'Europe', uptime: 186, status: 'online' },
  { id: 3, name: 'Node Gamma', location: 'Asia Pacific', uptime: 321, status: 'online' },
  { id: 4, name: 'Node Delta', location: 'South America', uptime: 92, status: 'offline' },
];

export default function ClientWrapper({
  children,
}: {
  children: React.ReactNode;
}) {
  const [activeSection, setActiveSection] = useState('home');
  const [activeTab, setActiveTab] = useState('blocks'); // Default tab for explorer
  const [searchQuery, setSearchQuery] = useState('');

  // DAO voting emulation ------------------------------------------
  type Proposal = {
    id: number;
    title: string;
    description: string;
    forVotes: number;
    againstVotes: number;
    status: 'active' | 'passed' | 'failed';
  };

  const [proposals, setProposals] = useState<Proposal[]>([
    {
      id: 1,
      title: 'Activate Pool #4 Rewards',
      description: 'Introduce a new reward pool distributing 5% of transaction fees to early contributors.',
      forVotes: 42,
      againstVotes: 8,
      status: 'active',
    },
    {
      id: 2,
      title: 'Reduce Node Activation Cost',
      description: 'Lower QNC required for Light Nodes from 5,000 to 4,000 (dynamic pricing based on network size) to incentivize growth.',
      forVotes: 61,
      againstVotes: 12,
      status: 'active',
    },
  ]);

  // proposal creation form state
  const [newTitle, setNewTitle] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [selectedNodeType, setSelectedNodeType] = useState<'light' | 'full' | 'super'>('light');

  // faucet state - track last claim time and input address
  const [lastFaucetClaim, setLastFaucetClaim] = useState<number | null>(null);
  const [faucetAddress, setFaucetAddress] = useState('');
  const [showFaucetAlert, setShowFaucetAlert] = useState(false);
  const [showSuccessAlert, setShowSuccessAlert] = useState(false);

  // ---- Activation pricing logic ----
  // Forcing Phase 1 as requested by user. Contract/API will drive this later.
  const currentPhase: 'phase1' | 'phase2' = 'phase1';
  const burnedTokensPhase1 = 150_000_000;        // 150 million 1DEV burned (15% of 1B supply)
  const totalPhase1Supply = 1_000_000_000;        // 1 billion 1DEV total supply (pump.fun standard)
  const activeNodes = 156;                          // TODO: fetch real active node count

  const getCostRange = (type: 'light' | 'full' | 'super'): string => {
    if (currentPhase === 'phase1') {
      const base: Record<'light' | 'full' | 'super', [number,number]> = {
        light: [1500,150],
        full: [1500,150],
        super: [1500,150]
      };
      const burnedPercent = Math.min(1, burnedTokensPhase1 / totalPhase1Supply);
      const [start,end] = base[type];
      const cost= Math.round(start - (start-end)*burnedPercent);
      return `Activation Cost: ${cost.toLocaleString()} 1DEV (burn)`;
    }

    // Phase 2 dynamic QNC pricing
    const baseRange: Record<'light' | 'full' | 'super', [number, number]> = {
      light: [2500, 15000],
      full: [3750, 22500],
      super: [5000, 30000],
    };

    let netMultiplier = 0.5;
    if (activeNodes >= 10_000_000) netMultiplier = 3.0;
    else if (activeNodes >= 1_000_000) netMultiplier = 2.0;
    else if (activeNodes >= 100_000) netMultiplier = 1.0;

    const [low, high] = baseRange[type];
    const [calcLow, calcHigh] = [low, high].map(v => Math.round(v * netMultiplier));
    return `Activation Cost: ${calcLow.toLocaleString()} - ${calcHigh.toLocaleString()} QNC (dynamic)`;
  };

  const createProposal = () => {
    if (!newTitle.trim() || !newDesc.trim()) return;
    setProposals(prev => [
      ...prev,
      {
        id: prev.length + 1,
        title: newTitle.trim(),
        description: newDesc.trim(),
        forVotes: 0,
        againstVotes: 0,
        status: 'active',
      },
    ]);
    setNewTitle('');
    setNewDesc('');
  };

  const vote = (id: number, support: boolean) => {
    setProposals(prev =>
      prev.map(p => {
        if (p.id !== id || p.status !== 'active') return p;
        const updated = {
          ...p,
          forVotes: p.forVotes + (support ? 1 : 0),
          againstVotes: p.againstVotes + (!support ? 1 : 0),
        };
        const total = updated.forVotes + updated.againstVotes;
        if (total >= 100) {
          updated.status = updated.forVotes > updated.againstVotes ? 'passed' : 'failed';
        }
        return updated;
      }),
    );
  };

  // DAO tab navigation state
  const [activeDaoTab, setActiveDaoTab] = useState('current');

  // handle faucet claim with 24h cooldown
  const handleFaucetClaim = () => {
    if (!faucetAddress.trim()) {
      alert('Please enter a valid testnet address');
      return;
    }

    const now = Date.now();
    const cooldownPeriod = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

    // check if user already claimed within 24 hours
    if (lastFaucetClaim && (now - lastFaucetClaim) < cooldownPeriod) {
      setShowFaucetAlert(true);
      return;
    }

    // simulate successful token claim
    setLastFaucetClaim(now);
    setShowSuccessAlert(true);
    setFaucetAddress('');
  };

  // Set correct default tab when section changes
  useEffect(() => {
    if (activeSection === 'explorer') {
      setActiveTab('blocks');
    } else if (activeSection === 'nodes') {
      setActiveTab('node-activation');
    }
  }, [activeSection]);

  return (
    <div className="app-wrapper">
      <Header activeSection={activeSection} setActiveSection={setActiveSection} />
      <main className="qnet-main">
        <div className="qnet-container">
          
          {activeSection === 'home' && (
            <div>
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
                      <div className="stat-number">99.9%</div>
                      <div className="stat-label">NETWORK UPTIME</div>
                      <div className="stat-trend">24h average</div>
                    </div>
                    <div className="stat-card">
                      <div className="stat-number">2.5M</div>
                      <div className="stat-label">QNC SUPPLY</div>
                      <div className="stat-trend">Circulating</div>
                    </div>
                    {/* GitHub Code Verification Section */}
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
                          <a href="/api/verify-build" target="_blank" rel="noopener noreferrer" className="verify-link">
                            Verify build
                          </a>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </section>

              {/* Continue with all other sections... */}
            </div>
          )}

          {/* Render children only if activeSection is 'home' or not handled by SPA */}
          {activeSection === 'home' ? null : children}
        </div>
      </main>
      <Footer />
    </div>
  );
} 