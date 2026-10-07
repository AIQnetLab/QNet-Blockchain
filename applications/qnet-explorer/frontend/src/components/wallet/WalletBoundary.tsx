'use client';

// The wallet widget talks to code the site does not control (a browser extension's provider). Whatever
// that code throws stays inside this boundary: the header keeps working and shows a plain button.

import { Component, type ReactNode } from 'react';

export default class WalletBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="wallet-widget">
        <button type="button" className="qnet-button wallet-button" onClick={() => window.location.reload()}>
          Connect wallet
        </button>
      </div>
    );
  }
}
