'use client';

export default function DocsPage() {
  return (
    <div className="page-docs">
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
    </div>
  );
} 