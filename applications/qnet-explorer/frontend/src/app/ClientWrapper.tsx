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

  // ---- Dynamic Activation pricing logic ----
  const currentPhase: 'phase1' | 'phase2' = 'phase1';
  const [burnedTokensPhase1, setBurnedTokensPhase1] = useState(0);
  const [currentPricing, setCurrentPricing] = useState({
    light: [1500, 150],
    full: [1500, 150], 
    super: [1500, 150]
  });
  const totalPhase1Supply = 1_000_000_000;        // 1 billion 1DEV total supply (pump.fun standard)
  const activeNodes = 156;                          // TODO: fetch real active node count
  
  // Fetch real-time pricing data
  useEffect(() => {
    fetch('/api/node/activate')
      .then(response => response.json())
      .then(data => {
        if (data.dynamicPricing && data.dynamicPricing.enabled) {
          const currentPrice = data.nodeTypes.light.burnAmount;
          setCurrentPricing({
            light: [currentPrice, 300],
            full: [currentPrice, 300],
            super: [currentPrice, 300]
          });
          
          if (data.dynamicPricing.burnPercentage !== undefined) {
            const burnedAmount = Math.floor((data.dynamicPricing.burnPercentage / 100) * totalPhase1Supply);
            setBurnedTokensPhase1(burnedAmount);
          }
        }
      })
      .catch(error => console.error('Failed to fetch pricing data:', error));
  }, []);

  const getCostRange = (type: 'light' | 'full' | 'super'): string => {
    if (currentPhase === 'phase1') {
      // Use dynamic pricing data from API
      const [currentPrice, minPrice] = currentPricing[type];
      return `Activation Cost: ${currentPrice.toLocaleString()} 1DEV (burn)`;
    }

    // Phase 2 dynamic QNC pricing - CORRECT implementation
    const basePrices: Record<'light' | 'full' | 'super', number> = {
      light: 5000,   // Base price for Light node
      full: 7500,    // Base price for Full node
      super: 10000,  // Base price for Super node
    };

    let netMultiplier = 0.5;   // 0-100k nodes
    if (activeNodes >= 10_000_000) netMultiplier = 3.0;      // 10M+ nodes
    else if (activeNodes >= 1_000_000) netMultiplier = 2.0;  // 1M-10M nodes
    else if (activeNodes >= 100_000) netMultiplier = 1.0;    // 100k-1M nodes

    const basePrice = basePrices[type];
    const currentPrice = Math.round(basePrice * netMultiplier);
    const minPrice = Math.round(basePrice * 0.5);
    const maxPrice = Math.round(basePrice * 3.0);
    
    return `Current: ${currentPrice.toLocaleString()} QNC (${netMultiplier}x), Range: ${minPrice.toLocaleString()}-${maxPrice.toLocaleString()}`;
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
      <Header />
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
                      <div className="stat-number">4.29B</div>
                      <div className="stat-label">QNC SUPPLY</div>
                      <div className="stat-trend">Max Supply</div>
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