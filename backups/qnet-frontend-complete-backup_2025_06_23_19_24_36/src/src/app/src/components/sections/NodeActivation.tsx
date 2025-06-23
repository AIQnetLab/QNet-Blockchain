'use client';

import React from 'react';

// Force update - 2025-01-17 timestamp

type NodeActivationProps = {
  selectedNodeType: 'light' | 'full' | 'super';
  setSelectedNodeType: (type: 'light' | 'full' | 'super') => void;
  getCostRange: (type: 'light' | 'full' | 'super') => string;
};

const NodeActivation = ({ selectedNodeType, setSelectedNodeType, getCostRange }: NodeActivationProps) => {
  return (
    <div className="explorer-card activation-card" style={{ maxWidth: '1200px', margin: '0 auto' }}>
      <div className="card-header">
        <h3>Node Activation</h3>
      </div>
      <div className="activation-content" style={{ padding: '0.75rem' }}>
        <p style={{ width: '100%', marginBottom: '0.75rem', color: '#e5e5e5', textAlign: 'center', fontSize: '1.1rem' }}>
          Activate your QNet node to join the network and start earning rewards
        </p>
        
        <div style={{ 
          width: '100%', 
          marginBottom: '0.75rem', 
          padding: '0.75rem', 
          background: 'rgba(0, 255, 255, 0.1)', 
          borderRadius: '12px', 
          border: '1px solid rgba(0, 255, 255, 0.3)' 
        }}>
          <h4 style={{ color: '#00ffff', marginBottom: '0.5rem', textAlign: 'center', fontSize: '1.2rem' }}>Select Node Type</h4>
          
          {/* Node Type Buttons */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem', marginBottom: '0.75rem' }}>
            <button 
              className={`qnet-button ${selectedNodeType === 'light' ? 'primary' : 'secondary'}`}
              onClick={() => setSelectedNodeType('light')}
              style={{ padding: '0.6rem 0.4rem', fontSize: '0.85rem', fontWeight: 'bold' }}
            >
              LIGHT NODE<br/><small style={{ fontSize: '0.7rem', opacity: 0.8 }}>(MOBILE)</small>
            </button>
            <button 
              className={`qnet-button ${selectedNodeType === 'full' ? 'primary' : 'secondary'}`}
              onClick={() => setSelectedNodeType('full')}
              style={{ padding: '0.6rem 0.4rem', fontSize: '0.85rem', fontWeight: 'bold' }}
            >
              FULL NODE<br/><small style={{ fontSize: '0.7rem', opacity: 0.8 }}>(SERVER)</small>
            </button>
            <button 
              className={`qnet-button ${selectedNodeType === 'super' ? 'primary' : 'secondary'}`}
              onClick={() => setSelectedNodeType('super')}
              style={{ padding: '0.6rem 0.4rem', fontSize: '0.85rem', fontWeight: 'bold' }}
            >
              SUPER NODE<br/><small style={{ fontSize: '0.7rem', opacity: 0.8 }}>(SERVER)</small>
            </button>
          </div>
          
          {/* Requirements and Cost */}
          <div style={{ 
            display: 'grid', 
            gridTemplateColumns: '3fr 1fr', 
            gap: '0.75rem', 
            padding: '0.6rem', 
            background: 'rgba(0, 0, 0, 0.4)', 
            borderRadius: '8px' 
          }}>
            {/* Requirements Column */}
            <div>
              <div style={{ marginBottom: '0.4rem' }}>
                <strong style={{ color: '#00ffff', fontSize: '0.95rem' }}>
                  {selectedNodeType.charAt(0).toUpperCase() + selectedNodeType.slice(1)} Node Requirements
                </strong>
              </div>
              
              {/* Single-line requirements for all node types */}
              <div style={{ fontSize: '0.85rem', lineHeight: '1.3', whiteSpace: 'nowrap' }}>
                {selectedNodeType === 'light' && '• Ping: 4h • Response: 100% • Up to 3 devices • Battery friendly'}
                {selectedNodeType === 'full' && '• Ping: 4min • Uptime: ≥95% • Public HTTP • 24/7 connection'}
                {selectedNodeType === 'super' && '• Ping: 4min • Uptime: ≥98% • Backbone • High Perf'}
              </div>
            </div>

            {/* Cost and Activation Column */}
            <div style={{ 
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              alignItems: 'center',
              gap: '0.5rem',
              paddingLeft: '0.75rem',
              borderLeft: '1px solid rgba(0, 255, 255, 0.2)'
            }}>
              <strong style={{ color: '#00ffff', fontSize: '1rem', textAlign: 'center' }}>
                {getCostRange(selectedNodeType)}
              </strong>
              <button className="qnet-button" style={{ 
                fontSize: '0.8rem', 
                padding: '0.5rem 0.8rem', 
                fontWeight: 'bold', 
                whiteSpace: 'nowrap' 
              }}>
                ACTIVATE {selectedNodeType.toUpperCase()} NODE
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default NodeActivation; 