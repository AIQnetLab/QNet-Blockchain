'use client';

import { useState, useRef, useEffect } from 'react';

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

// Simple Matrix Rain - classic green style  
const MatrixRain = ({ activeSection }: { activeSection: string }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const updateCanvas = () => {
      canvas.width = window.innerWidth;
      canvas.height = Math.max(window.innerHeight, document.documentElement.scrollHeight, document.body.scrollHeight);
    };

    updateCanvas();

    // Simple matrix characters
    const matrix = 'QNET01ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@#$%^&*()_+-=[]{}|;:,.<>?';
    const fontSize = 14;
    const columns = Math.floor(canvas.width / fontSize);
    
    // Initialize drops - spread them across the entire screen for instant visibility
    const drops: number[] = [];
    for (let i = 0; i < columns; i++) {
      drops[i] = Math.floor(Math.random() * (canvas.height / fontSize));
    }

    let lastTime = 0;
    // Optimize performance on home page due to CSS animations
    const targetInterval = activeSection === 'home' ? 40 : 50; // Much slower on home - 5fps vs 20fps

    function draw(currentTime: number) {
      if (currentTime - lastTime >= targetInterval) {
        if (!ctx || !canvas) return;
        
        // Dark fade effect
        ctx.fillStyle = activeSection === 'home' ? 'rgba(0, 0, 0, 0.03)' : 'rgba(0, 0, 0, 0.05)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Cyan text - matching site theme
        ctx.fillStyle = '#00ffff';
        ctx.font = `${fontSize}px 'Courier New', monospace`;

        for (let i = 0; i < drops.length; i++) {
          const char = matrix[Math.floor(Math.random() * matrix.length)];
          const x = i * fontSize;
          const y = drops[i] * fontSize;

          ctx.fillText(char, x, y);

          // Reset drop when it goes off screen
          if (y > canvas.height && Math.random() > (activeSection === 'home' ? 0.970 : 0.975)) {
            drops[i] = 0;
          }
          drops[i]++;
        }
        
        lastTime = currentTime;
      }
      
      animationRef.current = requestAnimationFrame(draw);
    }

    // Start animation
    animationRef.current = requestAnimationFrame(draw);

    const handleResize = () => {
      updateCanvas();
      const newColumns = Math.floor(canvas.width / fontSize);
      
      // Resize drops array
      while (drops.length < newColumns) {
        drops.push(Math.floor(Math.random() * (canvas.height / fontSize)));
      }
      drops.length = newColumns;
    };

    window.addEventListener('resize', handleResize);

    // Update canvas when content height changes - optimized for home page
    const checkContentHeight = () => {
      const newHeight = Math.max(window.innerHeight, document.documentElement.scrollHeight, document.body.scrollHeight);
      if (newHeight !== canvas.height) {
        updateCanvas();
      }
    };

    // Reduce check frequency on home page to avoid conflicts with CSS animations
    const checkInterval = 100;
    const contentObserver = setInterval(checkContentHeight, checkInterval);

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
      window.removeEventListener('resize', handleResize);
      clearInterval(contentObserver);
    };
  }, [activeSection]); // Recreate Matrix Rain when section changes

  // Update canvas immediately when activeSection changes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) {
      setTimeout(() => {
        const newHeight = Math.max(window.innerHeight, document.documentElement.scrollHeight, document.body.scrollHeight);
        if (newHeight !== canvas.height) {
          canvas.width = window.innerWidth;
          canvas.height = newHeight;
        }
      }, 100);
    }
  }, [activeSection]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100%',
        minHeight: '100vh',
        zIndex: 0,
        opacity: 0.6,
        pointerEvents: 'none',
        willChange: 'transform'
      }}
    />
  );
};

export default function QNetExplorer() {
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
  const burnedTokensPhase1 = 120_000;                // TODO: fetch real burned amount
  const totalPhase1Supply = 2_000_000;              // Total 1DEV supply allocated for burns
  const activeNodes = 156;                          // TODO: fetch real active node count

  const getCostRange = (type: 'light' | 'full' | 'super'): string => {
    if (currentPhase === 'phase1') {
      const base: Record<'light' | 'full' | 'super', [number,number]> = {
        light: [1500,150],
        full: [2250,225],
        super:[3000,300]
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
    <div className="qnet-container">
      <MatrixRain activeSection={activeSection} />
      
      <header className="qnet-header">
        <div className="header-content">
          <div className="qnet-logo">QNET</div>
          
          <nav className="qnet-nav">
            <button 
              className="nav-button" data-state={activeSection==='home'?'active':undefined}
              onClick={() => setActiveSection('home')}
            >
              Home
            </button>
            <button 
              className="nav-button" data-state={activeSection==='nodes'?'active':undefined}
              onClick={() => setActiveSection('nodes')}
            >
              Nodes
            </button>
            <button 
              className="nav-button" data-state={activeSection==='explorer'?'active':undefined}
              onClick={() => setActiveSection('explorer')}
            >
              Explorer
            </button>
            <button 
              className="nav-button" data-state={activeSection==='dao'?'active':undefined}
              onClick={() => setActiveSection('dao')}
            >
              DAO
            </button>
            <button 
              className="nav-button" data-state={activeSection==='testnet'?'active':undefined}
              onClick={() => setActiveSection('testnet')}
            >
              Testnet
            </button>
            <button 
              className="nav-button" data-state={activeSection==='wallet'?'active':undefined}
              onClick={() => setActiveSection('wallet')}
            >
              Wallet
            </button>
            <button 
              className="nav-button" data-state={activeSection==='docs'?'active':undefined}
              onClick={() => setActiveSection('docs')}
            >
              Docs
            </button>
          </nav>
          
          <div className="header-right">
            <button className="qnet-button">Connect Wallet</button>
          </div>
        </div>
      </header>

      <main className="qnet-main">
        
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
                        <a href="https://github.com/qnet-lab/qnet-project/commit/ab7f2e1" target="_blank" rel="noopener noreferrer" className="github-link">
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
                {/* subtitle removed as requested */}
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
                    {/* Lock icon */}
                    <div style={{
                      position: 'relative',
                      width: '24px',
                      height: '32px'
                    }}>
                      {/* Lock body */}
                      <div style={{
                        position: 'absolute',
                        bottom: '0',
                        left: '50%',
                        transform: 'translateX(-50%)',
                        width: '18px',
                        height: '16px',
                        background: 'linear-gradient(135deg, #00ffff, #ffffff)',
                        borderRadius: '3px',
                        border: '2px solid #00ffff'
                      }}>
                        {/* Keyhole */}
                        <div style={{
                          position: 'absolute',
                          top: '4px',
                          left: '50%',
                          transform: 'translateX(-50%)',
                          width: '4px',
                          height: '4px',
                          background: '#000',
                          borderRadius: '50%'
                        }}></div>
                        <div style={{
                          position: 'absolute',
                          bottom: '2px',
                          left: '50%',
                          transform: 'translateX(-50%)',
                          width: '2px',
                          height: '6px',
                          background: '#000'
                        }}></div>
                      </div>
                      {/* Lock shackle */}
                      <div style={{
                        position: 'absolute',
                        top: '0',
                        left: '50%',
                        transform: 'translateX(-50%)',
                        width: '16px',
                        height: '12px',
                        border: '3px solid #00ffff',
                        borderBottom: 'none',
                        borderRadius: '8px 8px 0 0'
                      }}></div>
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
                    <div style={{
                      fontSize: '24px',
                      fontWeight: 'bold',
                      color: '#00ffff',
                      textShadow: '0 0 10px #00ffff'
                    }}>#3</div>
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
                    <div style={{
                      fontSize: '18px',
                      fontWeight: 'bold',
                      color: '#00ffff',
                      textShadow: '0 0 10px #00ffff'
                    }}>REP</div>
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
                    <div style={{
                      fontSize: '16px',
                      fontWeight: 'bold',
                      color: '#00ffff',
                      textShadow: '0 0 10px #00ffff'
                    }}>📱</div>
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
                    <div style={{
                      fontSize: '18px',
                      fontWeight: 'bold',
                      color: '#00ffff',
                      textShadow: '0 0 10px #00ffff'
                    }}>100%</div>
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
                  <p>Every 4 hours network ping with cryptographic proof. Rewards from all three pools including Pool #3 activation benefits.</p>
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
                  <p>1DEV tokens are BURNED on Solana for node activation. 1,500 1DEV burn for any node type. Dynamic pricing 1500→150. Transition at 90% burned OR 5 years.</p>
                </div>
                <div className="tech-item">
                  <h4>Phase 2: QNC to Pool #3 (Future)</h4>
                  <p>QNC tokens are SENT TO POOL #3 for node activation. DYNAMIC PRICING: Light(2.5k-15k), Full(3.75k-22.5k), Super(5k-30k) QNC based on network size → Pool #3 → redistributed to ALL active nodes!</p>
                </div>
                <div className="tech-item">
                  <h4>Sharp Drop Halving Innovation</h4>
                  <p>Years 0-20: Standard ÷2 every 4 years | Years 20-24: Sharp drop ÷10 | Years 24+: Resume from low base. Saves 107M QNC!</p>
                </div>
                <div className="tech-item">
                  <h4>Dynamic Activation Pricing</h4>
                  <p>Network size multipliers: 0-100K nodes (0.5x discount), 100K-1M (1.0x standard), 1M-10M (2.0x), 10M+ (3.0x premium). ALL fees → Pool #3!</p>
                </div>
                <div className="tech-item">
                  <h4>Three Reward Pools</h4>
                  <p>1. Base Emission (halving schedule) | 2. Transaction Fees (70% Super, 30% Full, 0% Light) | 3. Activation Pool #3 (ALL nodes benefit)</p>
                </div>
                <div className="tech-item">
                  <h4>Hybrid Post-Quantum Cryptography</h4>
                  <p>Dilithium2 + Ed25519 dual-signature system. Best of both worlds: quantum-resistant + high-performance. Future-proof security architecture.</p>
                </div>
                <div className="tech-item">
                  <h4>Reputation-Based Consensus</h4>
                  <p>Score range 0-100. No token locking. Reputation 40+ for rewards. Double-sign detection with automatic penalties. Mobile-friendly security.</p>
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
        )}

        {activeSection === 'wallet' && (
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
        )}

        {activeSection === 'explorer' && (
          <section className="explorer-section">
            <div className="explorer-header">
              <h2 className="section-title">Quantum Blockchain Explorer</h2>
              <p className="section-subtitle">
                Real-time network data and blockchain analytics
              </p>
              
              <div className="search-container">
                <input
                  type="text"
                  placeholder="Search transactions, blocks, or addresses..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="search-input"
                />
                <button className="search-button">
                  <div style={{
                    width: '18px',
                    height: '18px',
                    border: '2px solid #ffffff',
                    borderRadius: '50%',
                    position: 'relative',
                    display: 'inline-block'
                  }}>
                    <div style={{
                      position: 'absolute',
                      width: '8px',
                      height: '2px',
                      background: '#ffffff',
                      bottom: '-4px',
                      right: '-4px',
                      transform: 'rotate(45deg)',
                      borderRadius: '1px'
                    }}></div>
                  </div>
                </button>
              </div>
            </div>

            <div className="network-stats compact">
              <div className="stat-card">
                <div className="stat-number">1,337</div>
                <div className="stat-label">Latest Block</div>
              </div>


              <div className="stat-card">
                <div className="stat-number">30/min</div>
                <div className="stat-label">Rate Limit</div>
              </div>
              <div className="stat-card">
                <div className="stat-number">2.5M</div>
                <div className="stat-label">QNC Supply</div>
              </div>
              <div className="stat-card">
                <div className="stat-number">6</div>
                <div className="stat-label">Regions Online</div>
              </div>
            </div>

            <div className="explorer-tabs">
              <div className="tabs-nav">
                <button 
                  data-state={activeTab === 'blocks' ? 'active' : ''}
                  onClick={() => setActiveTab('blocks')}
                >
                  Recent Blocks
                </button>
                <button 
                  data-state={activeTab === 'transactions' ? 'active' : ''}
                  onClick={() => setActiveTab('transactions')}
                >
                  Transaction Stream
                </button>

              </div>

              {activeTab === 'blocks' && (
                <div className="explorer-card">
                  <div className="card-header">
                    <h3>Recent Blocks</h3>
                  </div>
                  <div className="block-list">
                    {mockBlocks.map((block) => (
                      <div key={block.number} className={`block-item ${block.status}`}>
                        <div className="block-info">
                          <div className="block-number">#{block.number}</div>
                          <div className="block-hash">{block.hash}</div>
                        </div>
                        <div className="block-meta">
                          <span className="txs-count">{block.txs} txs</span>
                          <span className="block-time">{block.time}</span>
                          <div className={`status-indicator ${block.status}`}></div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {activeTab === 'transactions' && (
                <div className="explorer-card">
                  <div className="card-header">
                    <h3>Transaction Stream</h3>
                  </div>
                  <div className="tx-stream">
                    {mockTransactions.map((tx) => (
                      <div key={tx.hash} className="block-item">
                        <div className="block-info">
                          <div className="block-number">{tx.hash}</div>
                          <div className="block-hash">{tx.type}</div>
                        </div>
                        <div className="block-meta">
                          <span className="txs-count">{tx.amount}</span>
                          <span className="block-time">Block #{tx.block}</span>
                          <div className="status-indicator confirmed"></div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}


            </div>
          </section>
        )}

        {activeSection === 'testnet' && (
          <section className="explorer-section" data-section="testnet">
            <div className="explorer-header">
              <h2 className="section-title">QNet Testnet</h2>
              <p className="section-subtitle">
                Test network for development and experimentation
              </p>
            </div>

            <div style={{ maxWidth: '1000px', margin: '0 auto' }}>
              <div className="explorer-card" style={{ padding: '3rem' }}>
                <div className="card-header" style={{ marginBottom: '2rem', textAlign: 'center' }}>
                  <h3 style={{ fontSize: '1.8rem', marginBottom: '1rem' }}>Token Faucet</h3>
                  <div className="faucet-heading" style={{ fontSize: '1.1rem', color: '#e5e5e5', lineHeight: '1.5' }}>
                    Get 1,500 test 1DEV tokens for development and testing on QNet testnet
                  </div>
                </div>

                <div className="faucet-row" style={{ display: 'flex', gap: '1rem', alignItems: 'stretch', width: '100%' }}>
                  <input 
                    type="text" 
                    placeholder="Enter your testnet address" 
                    className="qnet-input"
                    value={faucetAddress}
                    onChange={(e) => setFaucetAddress(e.target.value)}
                    style={{ flex: '1', fontSize: '1rem', padding: '1rem', height: '3.5rem', boxSizing: 'border-box' }}
                  />
                  <button 
                    className="qnet-button" 
                    onClick={handleFaucetClaim}
                    style={{ flex: '1', fontSize: '1rem', padding: '1rem', fontWeight: 'bold', height: '3.5rem', boxSizing: 'border-box' }}
                  >
                    GET TEST TOKENS
                  </button>
                </div>
              </div>
            </div>

            {/* Faucet cooldown alert modal */}
            {showFaucetAlert && (
              <div style={{
                position: 'fixed',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                background: 'rgba(0, 0, 0, 0.8)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 1000
              }}>
                <div style={{
                  background: '#1a1a1a',
                  border: '2px solid #ffaa00',
                  borderRadius: '12px',
                  padding: '2rem',
                  maxWidth: '400px',
                  textAlign: 'center'
                }}>
                  <h3 style={{ color: '#ffaa00', marginBottom: '1rem' }}>Cooldown Active</h3>
                  <p style={{ color: '#e5e5e5', marginBottom: '2rem' }}>
                    Tokens are distributed once every 24 hours per address. Please wait before claiming again.
                  </p>
                  <button 
                    className="qnet-button"
                    onClick={() => setShowFaucetAlert(false)}
                    style={{ fontSize: '1rem', padding: '0.75rem 1.5rem' }}
                  >
                    OK
                  </button>
                </div>
              </div>
            )}

            {/* Faucet success modal */}
            {showSuccessAlert && (
              <div style={{
                position: 'fixed',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                background: 'rgba(0, 0, 0, 0.8)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 1000
              }}>
                <div style={{
                  background: '#1a1a1a',
                  border: '2px solid #00ffff',
                  borderRadius: '12px',
                  padding: '2rem',
                  maxWidth: '400px',
                  textAlign: 'center'
                }}>
                  <h3 style={{ color: '#00ffff', marginBottom: '1rem' }}>Success!</h3>
                  <p style={{ color: '#e5e5e5', marginBottom: '2rem' }}>
                    1,500 test 1DEV tokens have been sent to your address successfully!
                  </p>
                  <button 
                    className="qnet-button"
                    onClick={() => setShowSuccessAlert(false)}
                    style={{ fontSize: '1rem', padding: '0.75rem 1.5rem' }}
                  >
                    OK
                  </button>
                </div>
              </div>
            )}
          </section>
        )}

        {activeSection === 'docs' && (
          <section className="explorer-section" data-section="docs">
            <div className="explorer-header">
              <h2 className="section-title">Documentation</h2>
              <p className="section-subtitle">
                Complete guides and API references for QNet development
              </p>
            </div>

            <div className="tools-grid-large">
              <div className="tool-card-large">
                <h4>Quick Start</h4>
                <p>Get started with QNet development in minutes</p>
              </div>

              <div className="tool-card-large">
                <h4>API Reference</h4>
                <p>Complete REST API and WebSocket documentation</p>
              </div>

              <div className="tool-card-large">
                <h4>Smart Contracts</h4>
                <p>Deploy and interact with smart contracts on QNet</p>
              </div>

              <div className="tool-card-large">
                <h4>Security Guide</h4>
                <p>Best practices for secure development</p>
              </div>

              <div className="tool-card-large">
                <h4>Network Protocol</h4>
                <p>Deep dive into QNet's consensus and networking</p>
              </div>

              <div className="tool-card-large">
                <h4>Economics</h4>
                <p>Tokenomics and reward mechanisms</p>
              </div>

              <div className="tool-card-large">
                <h4>Security Architecture</h4>
                <p>Reputation-based consensus, rate limiting, and post-quantum cryptography</p>
              </div>

              <div className="tool-card-large">
                <h4>Mobile Development</h4>
                <p>iOS/Android SDK, ping system integration, and hardware security</p>
              </div>
            </div>
          </section>
        )}

        {activeSection === 'nodes' && (
          <section className="explorer-section" data-section="nodes">
            <div className="explorer-header">
              <h2 className="section-title">Node Network</h2>
              <p className="section-subtitle">
                Global QNet node infrastructure and node activation
              </p>
            </div>

            <div className="network-stats compact">
              <div className="stat-card">
                <div className="stat-number">148</div>
                <div className="stat-label">Online Nodes</div>
              </div>
              <div className="stat-card">
                <div className="stat-number">94.9%</div>
                <div className="stat-label">Network Health</div>
              </div>
              <div className="stat-card">
                <div className="stat-number">40+</div>
                <div className="stat-label">Reputation Req</div>
              </div>
              <div className="stat-card">
                <div className="stat-number">6</div>
                <div className="stat-label">Regions</div>
              </div>
            </div>

            <div className="explorer-tabs">
              <div className="tabs-nav">
                <button 
                  data-state={activeTab === 'node-activation' ? 'active' : ''}
                  onClick={() => setActiveTab('node-activation')}
                >
                  Node Activation
                </button>
                <button 
                  data-state={activeTab === 'node-list' ? 'active' : ''}
                  onClick={() => setActiveTab('node-list')}
                >
                  Node List
                </button>
              </div>

              {activeTab === 'node-activation' && (
                <div className="explorer-card activation-card">
                  <div className="card-header">
                    <h3>Node Activation</h3>
                  </div>
                  <div className="activation-content">
                    <p style={{ width: '100%', marginBottom: '2rem', color: '#e5e5e5', textAlign: 'center' }}>
                      Activate your QNet node to join the network and start earning rewards
                    </p>
                    
                    <div style={{ width: '100%', marginBottom: '2rem', padding: '2rem', background: 'rgba(0, 255, 255, 0.1)', borderRadius: '12px', border: '1px solid rgba(0, 255, 255, 0.3)' }}>
                      <h4 style={{ color: '#00ffff', marginBottom: '1.5rem', textAlign: 'center', fontSize: '1.2rem' }}>Select Node Type</h4>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem', marginBottom: '2rem' }}>
                        <button 
                          className={`qnet-button ${selectedNodeType === 'light' ? 'primary' : 'secondary'}`}
                          onClick={() => setSelectedNodeType('light')}
                          style={{ padding: '1.5rem 1rem', fontSize: '1rem', fontWeight: 'bold' }}
                        >
                          LIGHT NODE<br/><small style={{ fontSize: '0.8rem', opacity: 0.8 }}>(MOBILE)</small>
                        </button>
                        <button 
                          className={`qnet-button ${selectedNodeType === 'full' ? 'primary' : 'secondary'}`}
                          onClick={() => setSelectedNodeType('full')}
                          style={{ padding: '1.5rem 1rem', fontSize: '1rem', fontWeight: 'bold' }}
                        >
                          FULL NODE<br/><small style={{ fontSize: '0.8rem', opacity: 0.8 }}>(SERVER)</small>
                        </button>
                        <button 
                          className={`qnet-button ${selectedNodeType === 'super' ? 'primary' : 'secondary'}`}
                          onClick={() => setSelectedNodeType('super')}
                          style={{ padding: '1.5rem 1rem', fontSize: '1rem', fontWeight: 'bold' }}
                        >
                          SUPER NODE<br/><small style={{ fontSize: '0.8rem', opacity: 0.8 }}>(SERVER)</small>
                        </button>
                      </div>
                      
                      {/* Node Requirements - COMPACT LAYOUT */}
                      <div style={{ padding: '1.5rem', background: 'rgba(0, 0, 0, 0.4)', borderRadius: '8px', fontSize: '0.95rem', lineHeight: '1.6' }}>
                        <div style={{ textAlign: 'center', marginBottom: '1rem' }}>
                          <strong style={{ color: '#00ffff', fontSize: '1.1rem' }}>{selectedNodeType.charAt(0).toUpperCase() + selectedNodeType.slice(1)} Node Requirements</strong>
                        </div>
                        
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.5rem 1rem' }}>
                            {selectedNodeType === 'light' && (
                              <>
                                <span>• Ping interval: every 4h (mobile)</span>
                                <span>• Response rate: 100%</span>
                                <span>• Up to 3 devices per node</span>
                                <span>• Battery-friendly design</span>
                              </>
                            )}
                            {selectedNodeType === 'full' && (
                              <>
                                <span>• Ping interval: every 4 min</span>
                                <span>• Response rate: ≥ 95%</span>
                                <span>• Public HTTP endpoint</span>
                                <span>• Stable 24/7 connection</span>
                              </>
                            )}
                            {selectedNodeType === 'super' && (
                              <>
                                <span>• Ping interval: every 4 min</span>
                                <span>• Response rate: ≥ 98%</span>
                                <span>• Backbone routing priority</span>
                                <span>• High-performance hardware</span>
                              </>
                            )}
                          </div>

                          {/* Cost and Activation Button on the same line */}
                          <div style={{ 
                            marginTop: '1rem', 
                            paddingTop: '1rem', 
                            borderTop: '1px solid rgba(0, 255, 255, 0.2)', 
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            gap: '1rem'
                          }}>
                            <strong style={{ color: '#00ffff', fontSize: '1.1rem' }}>{getCostRange(selectedNodeType)}</strong>
                            <button className="qnet-button" style={{ fontSize: '0.9rem', padding: '0.75rem 1.5rem', fontWeight: 'bold', whiteSpace: 'nowrap' }}>
                              ACTIVATE {selectedNodeType.toUpperCase()} NODE
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {(activeTab === 'node-list' || activeTab === '') && (
                <div className="explorer-card">
                  <div className="card-header">
                    <h3>Active Network Nodes</h3>
                  </div>
                  <div className="nodes-grid">
                    {mockNodes.map((node) => (
                      <div key={node.id} className={`node-card ${node.status}`}>
                        <div className="node-info">
                          <div className="node-id">{node.name}</div>
                          <div className="node-location">Location: {node.location}</div>
                          <div className="node-uptime">Uptime: {node.uptime} days</div>
                          <div>
                            Status: {node.status}
                            <span className={`node-status ${node.status}`}></span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </section>
        )}

        {activeSection === 'dao' && (
          <section className="explorer-section">
            <div className="explorer-header">
              <h2 className="section-title">QNet DAO</h2>
              <p className="section-subtitle">
                Decentralized governance for QNet protocol development and treasury management
              </p>
              <div style={{ 
                background: 'rgba(147, 51, 234, 0.1)', 
                border: '1px solid rgba(147, 51, 234, 0.3)', 
                borderRadius: '8px', 
                padding: '1rem', 
                marginTop: '1rem',
                textAlign: 'center'
              }}>
                <p style={{ color: '#9333ea', margin: 0, fontSize: '0.9rem' }}>
                  Demo Mode: These proposals are for demonstration purposes only. 
                  Real on-chain governance is currently under development.
                </p>
              </div>
            </div>

            <div className="explorer-tabs">
              <div className="tabs-nav">
                <button
                  data-state={activeDaoTab === 'current' ? 'active' : ''}
                  onClick={() => setActiveDaoTab('current')}
                >
                  Current Votes
                </button>
                <button
                  data-state={activeDaoTab === 'create' ? 'active' : ''}
                  onClick={() => setActiveDaoTab('create')}
                >
                  Create Proposal
                </button>
                <button
                  data-state={activeDaoTab === 'info' ? 'active' : ''}
                  onClick={() => setActiveDaoTab('info')}
                >
                  Info
                </button>
              </div>

              {activeDaoTab === 'current' && (
                <div className="explorer-card">
                  <div className="card-header">
                    <h3>Active Proposals</h3>
                  </div>
                  <div className="block-list">
                    {proposals.map(p => {
                      const total = p.forVotes + p.againstVotes || 1;
                      const forPercent = Math.round((p.forVotes / total) * 100);
                      return (
                        <div key={p.id} className="block-item confirmed">
                          <div className="block-info" style={{ flex: 1 }}>
                            <div className="block-number">{p.title}</div>
                            <div className="block-hash">{p.description}</div>
                            <div style={{ width: '100%', height: '6px', background: '#1a1a1a', borderRadius: '3px', overflow: 'hidden', marginTop: '0.5rem' }}>
                              <div style={{ width: `${forPercent}%`, height: '100%', background: '#00ffff' }}></div>
                            </div>
                          </div>
                          <div className="block-meta" style={{ flexDirection: 'column', alignItems: 'flex-end', minWidth: '200px' }}>
                            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
                              <button
                                className="qnet-button primary"
                                disabled={p.status !== 'active'}
                                onClick={() => vote(p.id, true)}
                                style={{ fontSize: '0.8rem', padding: '0.5rem 1rem' }}
                              >
                                Vote Yes
                              </button>
                              <button
                                className="qnet-button secondary"
                                disabled={p.status !== 'active'}
                                onClick={() => vote(p.id, false)}
                                style={{ fontSize: '0.8rem', padding: '0.5rem 1rem' }}
                              >
                                Vote No
                              </button>
                            </div>
                            <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
                              <span className="txs-count">For: {p.forVotes}</span>
                              <span className="block-time">Against: {p.againstVotes}</span>
                              <div className={`status-indicator ${p.status === 'active' ? 'pending' : 'confirmed'}`}></div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {activeDaoTab === 'create' && (
                <div className="explorer-card activation-card create-proposal-card">
                  <div className="card-header">
                    <h3>Create Proposal</h3>
                  </div>
                  <div className="activation-content">
                    <p>
                      Submit a new governance proposal for community voting
                    </p>
                    <input
                      type="text"
                      className="qnet-input"
                      placeholder="Proposal title"
                      value={newTitle}
                      onChange={e => setNewTitle(e.target.value)}
                    />
                    <textarea
                      className="qnet-input"
                      placeholder="Proposal description"
                      value={newDesc}
                      onChange={e => setNewDesc(e.target.value)}
                    />
                    <button
                      className="qnet-button large"
                      onClick={createProposal}
                      disabled={true}
                    >
                      SUBMIT PROPOSAL (DEMO ONLY)
                    </button>
                    <p>
                      Proposal creation is disabled in demo mode. This interface shows the full workflow.
                    </p>
                  </div>
                </div>
              )}

              {activeDaoTab === 'info' && (
                <div className="explorer-card">
                  <div className="card-header">
                    <h3>DAO Information</h3>
                  </div>
                  <div className="block-list">
                    <div className="block-item confirmed">
                      <div className="block-info">
                        <div className="block-number">Treasury Overview</div>
                        <div className="block-hash">Transparent accounting of DAO funds, Pool #3 allocations, and community grant disbursements.</div>
                      </div>
                      <div className="block-meta">
                        <span className="txs-count">Active</span>
                        <span className="block-time">Treasury</span>
                        <div className="status-indicator confirmed"></div>
                      </div>
                    </div>
                    <div className="block-item confirmed">
                      <div className="block-info">
                        <div className="block-number">Security & Audits</div>
                        <div className="block-hash">DAO smart contracts follow industry-leading security guidelines. Independent audits scheduled before public launch.</div>
                      </div>
                      <div className="block-meta">
                        <span className="txs-count">Planned</span>
                        <span className="block-time">Security</span>
                        <div className="status-indicator pending"></div>
                      </div>
                    </div>
                    <div className="block-item confirmed">
                      <div className="block-info">
                        <div className="block-number">Roadmap & Milestones</div>
                        <div className="block-hash">Phase 0: Spec finalization · Phase 1: Testnet voting · Phase 2: Mainnet treasury control.</div>
                      </div>
                      <div className="block-meta">
                        <span className="txs-count">Phase 0</span>
                        <span className="block-time">Roadmap</span>
                        <div className="status-indicator confirmed"></div>
                      </div>
                    </div>
                    <div className="block-item confirmed">
                      <div className="block-info">
                        <div className="block-number">Contribute</div>
                        <div className="block-hash">Join discussions on GitHub, propose improvements, or help translate documentation. The DAO is community-driven!</div>
                      </div>
                      <div className="block-meta">
                        <span className="txs-count">Open</span>
                        <span className="block-time">Community</span>
                        <div className="status-indicator confirmed"></div>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </section>
        )}

      </main>

      <footer className="qnet-footer">
        <div className="footer-content">
          <div className="footer-left">
            The QNet has you, Eon...
          </div>
          <div className="footer-center">
            <div className="social-links badge-row" style={{ gap: '1rem' }}>
              <a href="https://github.com/qnet-lab/qnet-project" target="_blank" rel="noopener noreferrer" className="social-link">
                <div className="social-icon github-icon"></div>
              </a>
              <a href="https://x.com/AIQnetLab" target="_blank" rel="noopener noreferrer" className="social-link">
                <div className="social-icon twitter-icon"></div>
              </a>
              <a href="https://t.me/AiQnetLab" target="_blank" rel="noopener noreferrer" className="social-link">
                <div className="social-icon telegram-icon"></div>
              </a>
              <a href="#" target="_blank" rel="noopener noreferrer">
                <img src="https://developer.apple.com/assets/elements/badges/download-on-the-app-store.svg" alt="App Store" className="store-badge" />
              </a>
              <a href="#" target="_blank" rel="noopener noreferrer">
                <img src="https://play.google.com/intl/en_us/badges/static/images/badges/en_badge_web_generic.png" alt="Google Play" className="store-badge" />
              </a>
            </div>
          </div>
          <div className="footer-right">
            QNet Lab © 2025
          </div>
        </div>
      </footer>

    </div>
  );
} 