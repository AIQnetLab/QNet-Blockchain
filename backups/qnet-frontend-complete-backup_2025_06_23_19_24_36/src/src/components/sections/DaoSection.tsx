'use client';

import React, { useState } from 'react';

type Proposal = {
  id: number;
  title: string;
  description: string;
  forVotes: number;
  againstVotes: number;
  status: 'active' | 'passed' | 'failed';
};

const initialProposals: Proposal[] = [
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
];

const CurrentVotesTab = React.memo(function CurrentVotesTab({ proposals, onVote }: { proposals: Proposal[], onVote: (id: number, support: boolean) => void }) {
    return (
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
                        onClick={() => onVote(p.id, true)}
                        style={{ fontSize: '0.8rem', padding: '0.5rem 1rem' }}
                        >
                        Vote Yes
                        </button>
                        <button
                        className="qnet-button secondary"
                        disabled={p.status !== 'active'}
                        onClick={() => onVote(p.id, false)}
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
    );
});

const CreateProposalTab = React.memo(function CreateProposalTab({ onCreate }: { onCreate: (title: string, desc: string) => void }) {
    const [title, setTitle] = useState('');
    const [desc, setDesc] = useState('');

    const handleSubmit = () => {
        onCreate(title, desc);
        setTitle('');
        setDesc('');
    };
    
    return (
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
                value={title}
                onChange={e => setTitle(e.target.value)}
            />
            <textarea
                className="qnet-input"
                placeholder="Proposal description"
                value={desc}
                onChange={e => setDesc(e.target.value)}
            />
            <button
                className="qnet-button large"
                onClick={handleSubmit}
                disabled={true} // Kept as demo only
            >
                SUBMIT PROPOSAL (DEMO ONLY)
            </button>
            <p>
                Proposal creation is disabled in demo mode. This interface shows the full workflow.
            </p>
            </div>
        </div>
    );
});

const InfoTab = React.memo(function InfoTab() {
    return (
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
    );
});

const DaoSection = React.memo(function DaoSection() {
    const [proposals, setProposals] = useState<Proposal[]>(initialProposals);
    const [activeDaoTab, setActiveDaoTab] = useState('current');

    const handleVote = (id: number, support: boolean) => {
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

    const handleCreateProposal = (title: string, description: string) => {
        if (!title.trim() || !description.trim()) return;
        setProposals(prev => [
          ...prev,
          {
            id: prev.length + 1,
            title: title.trim(),
            description: description.trim(),
            forVotes: 0,
            againstVotes: 0,
            status: 'active',
          },
        ]);
    };

    return (
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

          {activeDaoTab === 'current' && <CurrentVotesTab proposals={proposals} onVote={handleVote} />}
          {activeDaoTab === 'create' && <CreateProposalTab onCreate={handleCreateProposal} />}
          {activeDaoTab === 'info' && <InfoTab />}
        </div>
      </section>
    );
});

export default DaoSection; 