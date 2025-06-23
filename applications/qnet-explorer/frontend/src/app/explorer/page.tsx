'use client';

import { useState } from 'react';

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

export default function ExplorerPage() {
  const [activeTab, setActiveTab] = useState('blocks');
  const [searchQuery, setSearchQuery] = useState('');

  return (
    <div className="page-explorer">
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
    </div>
  );
} 