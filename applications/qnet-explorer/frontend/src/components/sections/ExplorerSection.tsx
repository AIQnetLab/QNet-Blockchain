'use client';

import React, { useState, useCallback } from 'react';
import Link from 'next/link';

// Helper function to format time ago
const formatTimeAgo = (timestamp: number): string => {
  if (!timestamp || timestamp === 0) return 'Genesis';
  
  // Handle both seconds and milliseconds timestamps
  const ts = timestamp > 1e12 ? timestamp : timestamp * 1000;
  
  // If timestamp is before year 2024 (chain launch), treat as Genesis
  if (ts < 1704067200000) return 'Genesis';
  
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 0) return 'just now';
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return `${days} days ago`;
};

// Helper to truncate address/hash
const truncateAddress = (address: string, start: number = 6, end: number = 4): string => {
  if (address.length <= start + end) return address;
  return `${address.slice(0, start)}...${address.slice(-end)}`;
};

// Mock data for transactions/activity
// QNET EON Address format: 19 chars + "eon" + 15 chars + 8 char checksum = 45 total
// Tokens: QNC (native), custom tokens via smart contracts
// v3.18+: Transaction fees go directly to block producer (Super node)
const mockActivity = [
  {
    id: '1',
    blockHash: '62FE142CE64F8A22BB43D18057AF770BD304E3774CBB9C2E43719B0B1617AA91',
    timestamp: Date.now() - 23 * 60 * 1000,
    type: 'SWAP',
    from: 'a1b2c3d4e5f6a7b8c9aeon0abcde1234567f0a1b2c3d', // 45 chars
    to: 'dex0pool01aacbddc00eonabcdef12345671234abcd',     // 45 chars - DEX pool
    amount: '100 QNC',
    swapDetails: {
      tokenIn: 'QNC',
      tokenOut: 'WQNC',
      amountIn: '100',
      amountOut: '99.5',
      poolAddress: 'dex0pool01aacbddc00eonabcdef12345671234abcd',
      gasFee: '0.001 QNC → Producer',
    },
  },
  {
    id: '2',
    blockHash: '7D804D56FF7268D7967D51F9EBAB2C22D77E1E5CFEEF4A0D93DCBECC0CF49E5A',
    timestamp: Date.now() - 22 * 60 * 1000,
    type: 'SEND',
    from: 'b2c3d4e5f6a7b8c9d0aeon0abcde1234567f1c2d3e4f', // 45 chars
    to: 'c3d4e5f6a7b8c9d0e1aeon0abcde1234567f2d3e4f5a',   // 45 chars
    amount: '0.05 QNC',
  },
  {
    id: '3',
    blockHash: '7D804D56FF7268D7967D51F9EBAB2C22D77E1E5CFEEF4A0D93DCBECC0CF49E5A',
    timestamp: Date.now() - 22 * 60 * 1000,
    type: 'SEND',
    from: 'b2c3d4e5f6a7b8c9d0aeon0abcde1234567f1c2d3e4f', // 45 chars
    to: 'c3d4e5f6a7b8c9d0e1aeon0abcde1234567f2d3e4f5a',   // 45 chars
    amount: '50.00 QNC',
  },
  {
    id: '4',
    blockHash: '6138F66C1442F08C3AC329396962D442323E66E9A9FB00B95FCB9989EB08010',
    timestamp: Date.now() - 23 * 60 * 1000,
    type: 'SEND',
    from: 'a1b2c3d4e5f6a7b8c9aeon0abcde1234567f0a1b2c3d', // 45 chars
    to: 'b2c3d4e5f6a7b8c9d0aeon0abcde1234567f1c2d3e4f',   // 45 chars
    amount: '1,000.00 QNC',
  },
  {
    id: '5',
    blockHash: '16C0ABE55E0E030E13E57B25B6D77A227FE3836B0941F9CD6A44995BB3BE3AC1',
    timestamp: Date.now() - 25 * 60 * 1000,
    type: 'NODE_ACTIVATION',
    from: 'd4e5f6a7b8c9d0e1f2aeon0abcde1234567fe4f5a6b7', // 45 chars
    to: 'pool3activation0000eon00000000000000012345678',    // 45 chars - Pool 3
    amount: '10,000 QNC → Pool #3',
  },
  {
    id: '6',
    blockHash: 'A8B9C0D1E2F3A4B5C6D7E8F9A0B1C2D3E4F5A6B7C8D9E0F1A2B3C4D5E6F7A8B9',
    timestamp: Date.now() - 26 * 60 * 1000,
    type: 'SWAP',
    from: 'e5f6a7b8c9d0e1f2a3aeon0abcde1234567fa7b8c9d0', // 45 chars
    to: 'dex0pool02aabbccdd00eonbcdef01234567891234abcd',  // 45 chars
    amount: '500 STABLE',
    swapDetails: {
      tokenIn: 'STABLE',
      tokenOut: 'QNC',
      amountIn: '500',
      amountOut: '125.5',
      poolAddress: 'dex0pool02aabbccdd00eonbcdef01234567891234abcd',
      gasFee: '0.002 QNC → Producer',
    },
  },
  {
    id: '7',
    blockHash: 'B9C0D1E2F3A4B5C6D7E8F9A0B1C2D3E4F5A6B7C8D9E0F1A2B3C4D5E6F7A8B9C0',
    timestamp: Date.now() - 35 * 60 * 1000,
    type: 'REWARD',
    from: 'pool1emission000000aeon00000000000000012345678',  // 45 chars - Pool 1
    to: 'a1b2c3d4e5f6a7b8c9aeon0abcde1234567f0a1b2c3d',    // 45 chars
    amount: '251.43 QNC',
  },
];

// CopyButton component
const CopyButton = ({ text }: { text: string }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      /* log disabled */
    }
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      className="copy-btn"
      title={copied ? 'Copied!' : 'Copy to clipboard'}
    >
      {copied ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
      )}
    </button>
  );
};

// Address link component
const AddressLink = ({ address, label }: { address: string; label?: string }) => {
  const displayText = label || truncateAddress(address);
  return (
    <span className="address-cell">
      <Link href={`/explorer/address/${address}`} className="address-link">
        {displayText}
      </Link>
      <CopyButton text={address} />
    </span>
  );
};

// Block link component
const BlockLink = ({ hash }: { hash: string }) => {
  return (
    <span className="block-cell">
      <Link href={`/explorer/block/${hash}`} className="block-link">
        {truncateAddress(hash, 4, 4)}
      </Link>
      <CopyButton text={hash} />
    </span>
  );
};

// Type badge component
const TypeBadge = ({ type }: { type: string }) => {
  const getTypeColor = (t: string) => {
    switch (t) {
      case 'SEND': return 'type-send';
      case 'RECEIVE': return 'type-receive';
      case 'SWAP': return 'type-swap';
      case 'NODE_ACTIVATION': return 'type-node';
      case 'BURN': return 'type-burn';
      case 'REWARD': return 'type-reward';
      default: return 'type-default';
    }
  };

  const getTypeLabel = (t: string) => {
    switch (t) {
      case 'NODE_ACTIVATION': return 'NODE';
      default: return t;
    }
  };

  return (
    <span className={`type-badge ${getTypeColor(type)}`}>
      {getTypeLabel(type)}
    </span>
  );
};

// Swap details type
interface SwapDetails {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
  poolAddress: string;
  gasFee: string;
}

// Amount cell component with SWAP support
const AmountCell = ({ amount, type, swapDetails }: { 
  amount: string; 
  type?: string;
  swapDetails?: SwapDetails;
}) => {
  // For SWAP transactions, show swap details
  if (type === 'SWAP' && swapDetails) {
    return (
      <span className="amount-cell swap-amount">
        <span className="swap-in">{swapDetails.amountIn} {swapDetails.tokenIn}</span>
        <span className="swap-arrow">⇄</span>
        <span className="swap-out">{swapDetails.amountOut} {swapDetails.tokenOut}</span>
      </span>
    );
  }
  return <span className="amount-cell">{amount}</span>;
};

// Search bar component
const SearchBar = ({ value, onChange }: { value: string; onChange: (v: string) => void }) => {
  return (
    <div className="explorer-search">
      <input
        type="text"
        placeholder="Search by Address, Txn ID, Block or Token"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="search-input"
      />
      <button className="search-btn">Search</button>
    </div>
  );
};

// Loading spinner
const LoadingSpinner = () => (
  <div className="loading-spinner">
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" strokeOpacity="0.25"></circle>
      <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round">
        <animateTransform
          attributeName="transform"
          type="rotate"
          from="0 12 12"
          to="360 12 12"
          dur="1s"
          repeatCount="indefinite"
        />
      </path>
    </svg>
  </div>
);

// Main Explorer Section
const ExplorerSection = React.memo(function ExplorerSection() {
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading] = useState(false);

  return (
    <section className="explorer-section-new">
      {/* Header */}
      <div className="explorer-header-new">
        <h1 className="explorer-title">QNet Network Explorer</h1>
        <SearchBar value={searchQuery} onChange={setSearchQuery} />
      </div>

      {/* Latest Activity Table */}
      <div className="activity-card">
        <div className="activity-header">
          <h2>Latest Activity</h2>
          {isLoading && <LoadingSpinner />}
        </div>

        <div className="activity-table-wrapper">
          <table className="activity-table">
            <thead>
              <tr>
                <th>Block</th>
                <th>Age</th>
                <th>Type</th>
                <th>From</th>
                <th>To</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {mockActivity.map((item) => (
                <tr key={item.id} className={item.type === 'SWAP' ? 'swap-row' : ''}>
                  <td><BlockLink hash={item.blockHash} /></td>
                  <td className="age-cell">{formatTimeAgo(item.timestamp)}</td>
                  <td><TypeBadge type={item.type} /></td>
                  <td><AddressLink address={item.from} /></td>
                  <td>
                    {item.type === 'SWAP' && item.swapDetails ? (
                      <AddressLink address={item.swapDetails.poolAddress} label="DEX Pool" />
                    ) : (
                      <AddressLink address={item.to} />
                    )}
                  </td>
                  <td>
                    <AmountCell 
                      amount={item.amount} 
                      type={item.type} 
                      swapDetails={item.swapDetails} 
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination placeholder */}
        <div className="activity-footer">
          <span className="showing-text">Showing 1-7 of 7 transactions</span>
        </div>
      </div>
    </section>
  );
});

export default ExplorerSection;
