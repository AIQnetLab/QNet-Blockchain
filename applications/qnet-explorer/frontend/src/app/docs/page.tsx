'use client';

// The documentation is kept in the repository next to the code it describes; every card opens the
// current version of one document there.

const DOCS = 'https://github.com/AIQnetLab/QNet-Blockchain/blob/testnet/docs';

const SECTIONS: { title: string; items: { name: string; path: string; what: string }[] }[] = [
  {
    title: 'Architecture',
    items: [
      { name: 'Overview', path: 'architecture/overview.md', what: 'What the network is made of and how the pieces fit.' },
      { name: 'Consensus', path: 'architecture/consensus.md', what: 'Microblocks, checkpoints, committees and quorum certificates.' },
      { name: 'Cryptography', path: 'architecture/cryptography.md', what: 'ML-DSA-65 signatures, hashes and the address format.' },
      { name: 'Networking', path: 'architecture/networking.md', what: 'Transport, gossip and the post-quantum handshake between nodes.' },
      { name: 'State', path: 'architecture/state.md', what: 'Accounts, the state commitment and proofs against it.' },
    ],
  },
  {
    title: 'Developers',
    items: [
      { name: 'RPC API', path: 'developers/rpc-api.md', what: 'Every endpoint a wallet, an explorer or a script can call.' },
      { name: 'Smart contracts', path: 'developers/smart-contracts.md', what: 'Deploying and calling contracts, gas and events.' },
      { name: 'SDK', path: 'developers/sdk.md', what: 'Signing and sending transactions from your own code.' },
      { name: '1DEV burn contract', path: 'developers/1dev-burn-contract.md', what: 'The Solana side of Phase 1 activation.' },
    ],
  },
  {
    title: 'Economics',
    items: [
      { name: 'Overview', path: 'economics/overview.md', what: 'Emission, the halving schedule and how rewards are split.' },
      { name: 'Node activation', path: 'economics/node-activation.md', what: 'What activation costs in each phase and why.' },
      { name: '1DEV', path: 'economics/tokenomics-1dev.md', what: 'The Phase 1 token and its burn.' },
    ],
  },
  {
    title: 'Operators',
    items: [
      { name: 'Running a node', path: 'operators/running-a-node.md', what: 'From a server to a node on the network.' },
      { name: 'Configuration', path: 'operators/configuration.md', what: 'Every setting a node reads.' },
      { name: 'Maintenance', path: 'operators/maintenance.md', what: 'Monitoring, logs, upgrades, backups and recovery.' },
    ],
  },
  {
    title: 'Applications',
    items: [
      { name: 'Mobile wallet', path: 'applications/mobile-wallet.md', what: 'The iOS and Android app and the light node it runs.' },
      { name: 'Browser wallet', path: 'applications/browser-wallet.md', what: 'The browser extension.' },
      { name: 'Explorer', path: 'applications/explorer.md', what: 'This website: what it indexes and what it serves.' },
      { name: 'CLI', path: 'applications/cli.md', what: 'The command-line tools.' },
    ],
  },
];

export default function DocsPage() {
  return (
    <div className="page-docs">
      <section className="explorer-section" data-section="docs">
        <div className="explorer-header">
          <h2 className="section-title">Documentation</h2>
          <p className="section-subtitle">
            Kept in the repository next to the code it describes — each card opens the current version
          </p>
        </div>

        {SECTIONS.map((s) => (
          <div key={s.title} style={{ marginBottom: '2.5rem' }}>
            <h3 style={{ color: '#00ffff', marginBottom: '1rem' }}>{s.title}</h3>
            <div className="tools-grid-large">
              {s.items.map((d) => (
                <a
                  key={d.path}
                  className="tool-card-large"
                  href={`${DOCS}/${d.path}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ display: 'block', textDecoration: 'none' }}
                >
                  <h4>{d.name}</h4>
                  <p>{d.what}</p>
                </a>
              ))}
            </div>
          </div>
        ))}

        <p style={{ textAlign: 'center', opacity: 0.7, fontSize: '0.9rem' }}>
          The whitepaper is at the repository root: <a href="https://github.com/AIQnetLab/QNet-Blockchain/blob/testnet/QNet_Whitepaper.md" target="_blank" rel="noopener noreferrer">QNet_Whitepaper.md</a>
        </p>
      </section>
    </div>
  );
}
