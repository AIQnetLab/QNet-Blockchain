'use client';

import { useState, useEffect } from 'react';

const mockNodes = [
  { id: 1, name: 'Node Alpha', location: 'North America', uptime: 247, status: 'online' },
  { id: 2, name: 'Node Beta', location: 'Europe', uptime: 186, status: 'online' },
  { id: 3, name: 'Node Gamma', location: 'Asia Pacific', uptime: 321, status: 'online' },
  { id: 4, name: 'Node Delta', location: 'South America', uptime: 92, status: 'offline' },
];

export default function NodesPage() {
  const [activeTab, setActiveTab] = useState('node-activation');
  const [selectedNodeType, setSelectedNodeType] = useState<'light' | 'full' | 'super'>('light');
  
  // Dynamic data from API
  const [burnedTokensPhase1, setBurnedTokensPhase1] = useState(0);
  const [currentPricing, setCurrentPricing] = useState({
    light: [1500, 150],
    full: [1500, 150], 
    super: [1500, 150]
  });
  
  // Fetch real-time data on component mount
  useEffect(() => {
    fetch('/api/node/activate')
      .then(response => response.json())
      .then(data => {
        if (data.dynamicPricing && data.dynamicPricing.enabled) {
          const currentPrice = data.nodeTypes.light.burnAmount;
          setCurrentPricing({
            light: [currentPrice, 150],
            full: [currentPrice, 150],
            super: [currentPrice, 150]
          });
          
          if (data.dynamicPricing.burnPercentage !== undefined) {
            const totalPhase1Supply = 1_000_000_000;
            const burnedAmount = Math.floor((data.dynamicPricing.burnPercentage / 100) * totalPhase1Supply);
            setBurnedTokensPhase1(burnedAmount);
          }
        }
      })
      .catch(error => console.error('Failed to fetch pricing data:', error));
  }, []);

  const getCostRange = (type: 'light' | 'full' | 'super'): string => {
    const currentPhase: 'phase1' | 'phase2' = 'phase1';
    const totalPhase1Supply = 1_000_000_000; // 1 billion 1DEV total supply (pump.fun standard)
    const activeNodes = 156;

    if (currentPhase === 'phase1') {
      // Use dynamic pricing data from API
      const [currentPrice, minPrice] = currentPricing[type];
      return `Activation Cost: ${currentPrice.toLocaleString()} 1DEV (burn)`;
    }

    const baseRange: Record<typeof type, [number, number]> = {
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

  return (
    <div className="page-nodes">
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
              <div className="activation-content" style={{ padding: '0.5rem 1.5rem 1rem' }}>
                <h3 style={{ fontSize: '1.4rem', marginBottom: '1rem', textAlign: 'center' }}>Node Activation</h3>
                <p style={{ width: '100%', marginBottom: '1.5rem', color: '#e5e5e5', textAlign: 'center', fontSize: '0.9rem' }}>
                  Activate your QNet node to join the network and start earning rewards
                </p>
                
                <div style={{ width: '100%', padding: '1rem', background: 'rgba(0, 255, 255, 0.05)', borderRadius: '10px', border: '1px solid rgba(0, 255, 255, 0.2)' }}>
                  <h4 style={{ color: '#00ffff', marginBottom: '1rem', textAlign: 'center', fontSize: '1rem' }}>Select Node Type</h4>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.75rem', marginBottom: '1rem' }}>
                    <button 
                      className={`qnet-button ${selectedNodeType === 'light' ? 'primary' : 'secondary'}`}
                      onClick={() => setSelectedNodeType('light')}
                      style={{ padding: '0.75rem 0.5rem', fontSize: '0.8rem', fontWeight: 'bold' }}
                    >
                      LIGHT NODE<br/><small style={{ fontSize: '0.7rem', opacity: 0.8 }}>(MOBILE)</small>
                    </button>
                    <button 
                      className={`qnet-button ${selectedNodeType === 'full' ? 'primary' : 'secondary'}`}
                      onClick={() => setSelectedNodeType('full')}
                      style={{ padding: '0.75rem 0.5rem', fontSize: '0.8rem', fontWeight: 'bold' }}
                    >
                      FULL NODE<br/><small style={{ fontSize: '0.7rem', opacity: 0.8 }}>(SERVER)</small>
                    </button>
                    <button 
                      className={`qnet-button ${selectedNodeType === 'super' ? 'primary' : 'secondary'}`}
                      onClick={() => setSelectedNodeType('super')}
                      style={{ padding: '0.75rem 0.5rem', fontSize: '0.8rem', fontWeight: 'bold' }}
                    >
                      SUPER NODE<br/><small style={{ fontSize: '0.7rem', opacity: 0.8 }}>(SERVER)</small>
                    </button>
                  </div>
                  
                  <div style={{ padding: '1rem', background: 'rgba(0, 0, 0, 0.3)', borderRadius: '8px', fontSize: '0.85rem', lineHeight: '1.4' }}>
                    <div style={{ textAlign: 'center', marginBottom: '0.75rem' }}>
                      <strong style={{ color: '#00ffff', fontSize: '0.9rem' }}>{selectedNodeType.charAt(0).toUpperCase() + selectedNodeType.slice(1)} Node Requirements</strong>
                    </div>
                    
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                      <div style={{ fontSize: '0.85rem', lineHeight: '1.4', whiteSpace: 'nowrap', textAlign: 'center' }}>
                        {selectedNodeType === 'light' && '• Ping: 4h • Uptime: 99% • Devices: ≤3 • Low Power'}
                        {selectedNodeType === 'full' && '• Ping: 4min • Uptime: ≥95% • Public IP • 24/7 Online'}
                        {selectedNodeType === 'super' && '• Ping: 4min • Uptime: ≥98% • Backbone • High Perf'}
                      </div>

                      <div style={{ 
                        marginTop: '1rem', 
                        paddingTop: '0.75rem', 
                        borderTop: '1px solid rgba(0, 255, 255, 0.15)', 
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: '1rem'
                      }}>
                        <strong style={{ color: '#00ffff', fontSize: '0.9rem', whiteSpace: 'nowrap' }}>{getCostRange(selectedNodeType)}</strong>
                        <button className="qnet-button" style={{ fontSize: '0.8rem', padding: '0.6rem 1rem', fontWeight: 'bold', whiteSpace: 'nowrap' }}>
                          ACTIVATE {selectedNodeType.toUpperCase()}
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
    </div>
  );
}