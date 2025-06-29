'use client';

import React, { useState } from 'react';

// Mock data, assuming it might be fetched or passed as props in a real app
const mockNodes = [
  { id: 1, name: 'Node Alpha', location: 'North America', uptime: 247, status: 'online' },
  { id: 2, name: 'Node Beta', location: 'Europe', uptime: 186, status: 'online' },
  { id: 3, name: 'Node Gamma', location: 'Asia Pacific', uptime: 321, status: 'online' },
  { id: 4, name: 'Node Delta', location: 'South America', uptime: 92, status: 'offline' },
];


const NodeActivation = React.memo(function NodeActivation() {
    const [selectedNodeType, setSelectedNodeType] = useState<'light' | 'full' | 'super'>('light');
    
    // This logic should ideally be a pure function or a hook if it's more complex
    const getCostRange = (type: 'light' | 'full' | 'super'): string => {
        // Hardcoded for demo as in the original file
        const currentPhase: 'phase1' | 'phase2' = 'phase1';
        const burnedTokensPhase1 = 150_000_000; // 150 million burned (15% of 1B supply)
        const totalPhase1Supply = 1_000_000_000; // 1 billion 1DEV total supply (pump.fun standard)
        const activeNodes = 156;
      
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
    
        const baseRange: Record<'light' | 'full' | 'super', [number, number]> = { light: [2500, 15000], full: [3750, 22500], super: [5000, 30000] };
        let netMultiplier = activeNodes >= 10_000_000 ? 3.0 : activeNodes >= 1_000_000 ? 2.0 : activeNodes >= 100_000 ? 1.0 : 0.5;
        const [low, high] = baseRange[type];
        const [calcLow, calcHigh] = [low, high].map(v => Math.round(v * netMultiplier));
        return `Activation Cost: ${calcLow.toLocaleString()} - ${calcHigh.toLocaleString()} QNC (dynamic)`;
    };

    return (
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
    );
});


const NodeList = React.memo(function NodeList() {
    return (
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
    );
});

const NodesSection = React.memo(function NodesSection() {
  const [activeTab, setActiveTab] = useState('node-activation');

  return (
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

        {activeTab === 'node-activation' && <NodeActivation />}
        {activeTab === 'node-list' && <NodeList />}
      </div>
    </section>
  );
});

export default NodesSection; 