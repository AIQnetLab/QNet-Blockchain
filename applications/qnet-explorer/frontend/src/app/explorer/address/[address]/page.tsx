'use client';

import React, { useState, useCallback, useEffect } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { getCache, setCache, isCacheStale } from '@/lib/explorer-cache';

interface AddressData {
  address: string;
  balance: string;
  txCount: number;
  firstSeen: number;
  lastActive: number;
  nodeInfo?: {
    nodeId: string;
    nodeType: 'SUPER' | 'FULL' | 'LIGHT';
    reputation: number;
    activatedAt: number;
    isActive: boolean;
  };
  tokens: Array<{
    symbol: string;
    balance: string;
  }>;
  transactions: Array<{
    hash: string;
    type: string;
    from: string;
    to: string;
    amount: string;
    fee?: string;
    timestamp: number;
    block: number;
    status: 'confirmed' | 'pending';
  }>;
}

// Other Tokens collapsible component
const OtherTokens = ({ tokens }: { tokens: Array<{ symbol: string; balance: string }> }) => {
  const [expanded, setExpanded] = useState(false);
  
  if (tokens.length === 0) return null;
  
  return (
    <div className="block-card collapsible">
      <div className="card-header-collapsible" onClick={() => setExpanded(!expanded)}>
        <h2 className="card-title">Other Tokens ({tokens.length})</h2>
        <span className={`collapse-icon ${expanded ? 'open' : ''}`}>▼</span>
      </div>
      {expanded && (
        <div className="tokens-list-expanded">
          {tokens.map((token, idx) => (
            <div key={idx} className="token-row-expanded">
              <span className="token-symbol">{token.symbol}</span>
              <span className="token-balance">{token.balance}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// Format time ago
const formatTimeAgo = (timestamp: number): string => {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
};

// Format date (handle both seconds and milliseconds)
const formatDate = (timestamp: number | string | undefined): string => {
  // Convert to number if string
  const tsNum = typeof timestamp === 'string' ? Number(timestamp) : timestamp;
  
  if (!tsNum || tsNum === 0 || !Number.isFinite(tsNum)) return 'N/A';
  
  // Convert to milliseconds if needed
  let msTs: number;
  if (tsNum < 1e12) {
    msTs = tsNum * 1000;
  } else {
    msTs = tsNum;
  }
  
  // Validate timestamp (must be after 2000-01-01)
  if (msTs < 946684800000) { // Before 2000-01-01
    return 'N/A';
  }
  
  try {
    const date = new Date(msTs);
    if (isNaN(date.getTime())) {
      return 'N/A';
    }
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return 'N/A';
  }
};

// Truncate
const truncate = (str: string, start = 8, end = 6): string => {
  if (!str || str.length <= start + end + 3) return str || '';
  return `${str.slice(0, start)}...${str.slice(-end)}`;
};

// Copy button (Keeta style)
const CopyBtn = ({ text }: { text: string }) => {
  const [copied, setCopied] = useState(false);
  
  const copy = useCallback(async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [text]);
  
  return (
    <button onClick={copy} className="copy-btn" title={copied ? 'Copied!' : 'Copy'}>
      {copied ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>
      )}
    </button>
  );
};

export default function AddressPage() {
  const params = useParams();
  const address = params.address as string;
  
  // v2.102: Sync cache read for instant display
  const cachedData = address ? getCache<AddressData>('address', address) : null;
  
  const [data, setData] = useState<AddressData | null>(cachedData);
  const [error, setError] = useState<string | null>(null);
  const [hasFetched, setHasFetched] = useState(!!cachedData);
  const [txPage, setTxPage] = useState(1);
  const TX_PER_PAGE = 10;
  
  useEffect(() => {
    if (!address) return;
    
    // If we have fresh cache, skip fetch
    if (cachedData && !isCacheStale('address', address)) {
      setHasFetched(true);
      return;
    }
    
    const fetchAddress = async () => {
      try {
        const res = await fetch(`/api/address/${address}`);
        const result = await res.json();
        
        if (result.success && result.data) {
          setData(result.data);
          setCache('address', address, result.data);
          setError(null);
        } else {
          setError(result.error || 'Address not found');
        }
      } catch {
        setError('Failed to load address');
      } finally {
        setHasFetched(true);
      }
    };
    
    fetchAddress();
  }, [address, cachedData]);
  
  // Show error ONLY after fetch attempt
  if (hasFetched && (error || !data)) {
    return (
      <div className="address-page">
        <div className="error-state">{error || 'Address not found'}</div>
      </div>
    );
  }
  
  // Still loading - show empty shell
  if (!data) {
    return <div className="address-page" />;
  }
  
  return (
    <div className="address-page">
      {/* Header */}
      <div className="block-header">
        <div className="block-header-top">
          <span className="block-label">ADDRESS</span>
        </div>
        <div className="block-hash-display">
          <h1>{address}</h1>
          <CopyBtn text={address} />
        </div>
      </div>

      {/* Balance Card */}
      <div className="block-card">
        <h2 className="card-title">Balance</h2>
        <div className="balance-display">
          <div className="main-balance">{data.balance}</div>
        </div>
      </div>

      {/* Other Tokens (collapsible) */}
      {data.tokens.length > 1 && (
        <OtherTokens tokens={data.tokens.filter(t => t.symbol !== 'QNC')} />
      )}

      {/* Details */}
      <div className="block-card">
        <h2 className="card-title">Details</h2>
        <div className="details-grid">
          <div className="detail-row">
            <span className="detail-label">Total Transactions</span>
            <span className="detail-value">{data.txCount.toLocaleString()}</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">First Seen</span>
            <span className="detail-value">{formatDate(data.firstSeen)}</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Last Active</span>
            <span className="detail-value">{formatTimeAgo(data.lastActive)}</span>
          </div>
        </div>
      </div>

      {/* Transactions */}
      {(() => {
        const totalPages = Math.ceil(data.transactions.length / TX_PER_PAGE);
        const startIdx = (txPage - 1) * TX_PER_PAGE;
        const paginatedTx = data.transactions.slice(startIdx, startIdx + TX_PER_PAGE);
        
        return (
          <div className="block-card">
            <h2 className="card-title">Transactions ({data.transactions.length})</h2>
            <table className="block-table">
              <thead>
                <tr>
                  <th>Hash</th>
                  <th>Type</th>
                  <th>From / To</th>
                  <th>Amount</th>
                  <th>Block</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {paginatedTx.map((tx, idx) => {
                  const isSend = tx.from === address;
                  return (
                    <tr key={idx}>
                      <td>
                        <Link href={`/explorer/tx/${tx.hash}`} className="address-link">
                          {truncate(tx.hash, 6, 4)}
                        </Link>
                      </td>
                      <td>
                        <span className={`type-badge type-${tx.type.toLowerCase()}`}>{tx.type}</span>
                      </td>
                      <td>
                        <span className={isSend ? 'tx-out' : 'tx-in'}>
                          {isSend ? 'To: ' : 'From: '}
                        </span>
                        <Link href={`/explorer/address/${isSend ? tx.to : tx.from}`} className="address-link">
                          {truncate(isSend ? tx.to : tx.from, 6, 4)}
                        </Link>
                      </td>
                      <td className={isSend ? 'amount-out' : 'amount-in'}>
                        {isSend ? '-' : '+'}{tx.amount}
                      </td>
                      <td>
                        <Link href={`/explorer/block/${tx.block}`} className="address-link">
                          {tx.block}
                        </Link>
                      </td>
                      <td>{formatTimeAgo(tx.timestamp)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            
            {totalPages > 1 && (
              <div className="pagination">
                <button 
                  onClick={() => setTxPage(p => Math.max(1, p - 1))} 
                  disabled={txPage === 1}
                  className="page-btn"
                >
                  ← Prev
                </button>
                <span className="page-info">Page {txPage} of {totalPages}</span>
                <button 
                  onClick={() => setTxPage(p => Math.min(totalPages, p + 1))} 
                  disabled={txPage === totalPages}
                  className="page-btn"
                >
                  Next →
                </button>
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}
