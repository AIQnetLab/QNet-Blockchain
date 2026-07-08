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
    nodeType: 'SUPER' | 'LIGHT';  // v3.18: FULL removed
    reputation: number;
    activatedAt: number;
    isActive: boolean;
  };
  tokens: Array<{
    symbol: string;
    name: string;
    contract_address: string;
    decimals: number;
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

// v3.11: Balance proof verification result
interface BalanceProofResult {
  verified: boolean;
  balance: number;
  blockHeight: number;
  stateRoot: string;
  proofSize: number;
  verificationTime: number;
  error?: string;
}

// v3.11: Balance Verification Component
const BalanceVerification = ({ address }: { address: string }) => {
  const [verifying, setVerifying] = useState(false);
  const [result, setResult] = useState<BalanceProofResult | null>(null);
  const [expanded, setExpanded] = useState(false);
  
  const verifyBalance = async () => {
    setVerifying(true);
    setResult(null);
    
    const startTime = performance.now();
    
    try {
      // Fetch balance with Merkle proof
      const response = await fetch(`/api/address/${address}/balance-proof`);
      const data = await response.json();
      
      if (data.success && data.verified !== undefined) {
        setResult({
          verified: data.verified,
          balance: data.balance || 0,
          blockHeight: data.blockHeight || 0,
          stateRoot: data.stateRoot || '',
          proofSize: data.nodesAgreed || data.proofSize || 0,
          verificationTime: Math.round(performance.now() - startTime),
        });
      } else {
        setResult({
          verified: false,
          balance: 0,
          blockHeight: 0,
          stateRoot: '',
          proofSize: 0,
          verificationTime: Math.round(performance.now() - startTime),
          error: data.error || 'Verification failed',
        });
      }
    } catch (err) {
      setResult({
        verified: false,
        balance: 0,
        blockHeight: 0,
        stateRoot: '',
        proofSize: 0,
        verificationTime: Math.round(performance.now() - startTime),
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      setVerifying(false);
    }
  };
  
  return (
    <div className="verification-section">
      <div className="verification-header">
        <button 
          onClick={verifyBalance} 
          disabled={verifying}
          className={`verify-btn ${result?.verified ? 'verified' : ''}`}
        >
          {verifying ? (
            <>
              <span className="spinner" /> Verifying...
            </>
          ) : result?.verified ? (
            <>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                <polyline points="22 4 12 14.01 9 11.01"/>
              </svg>
              Verified (Multi-Node Consensus)
            </>
          ) : (
            <>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
              </svg>
              Verify Balance
            </>
          )}
        </button>
        
        {result && (
          <button 
            onClick={() => setExpanded(!expanded)} 
            className="details-toggle"
          >
            {expanded ? 'Hide Details' : 'Show Details'}
          </button>
        )}
      </div>
      
      {result && expanded && (
        <div className={`verification-details ${result.verified ? 'verified' : 'failed'}`}>
          <div className="detail-row">
            <span className="detail-label">Status</span>
            <span className={`detail-value ${result.verified ? 'text-success' : 'text-error'}`}>
              {result.verified ? 'Cryptographically Verified' : (result.error || 'Verification Failed')}
            </span>
          </div>
          {result.verified && (
            <>
              <div className="detail-row">
                <span className="detail-label">Block Height</span>
                <span className="detail-value">{result.blockHeight.toLocaleString()}</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">State Root</span>
                <span className="detail-value mono">{result.stateRoot.slice(0, 16)}...</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Nodes Agreed</span>
                <span className="detail-value">{result.proofSize} / 5 nodes</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Verification Time</span>
                <span className="detail-value">{result.verificationTime}ms</span>
              </div>
            </>
          )}
          <div className="verification-note">
            Multi-node consensus verification ensures your balance is authentic without trusting any single node.
          </div>
        </div>
      )}
    </div>
  );
};

// Other Tokens collapsible component — lists this address's QRC-20 holdings.
// Each symbol links to the token detail page (/explorer/token/{contract}).
const OtherTokens = ({
  tokens,
}: {
  tokens: Array<{ symbol: string; name: string; contract_address: string; decimals: number; balance: string }>;
}) => {
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
            <div key={token.contract_address || idx} className="token-row-expanded">
              <span className="token-symbol">
                {token.contract_address ? (
                  <Link href={`/explorer/token/${token.contract_address}`} className="address-link">
                    {token.symbol || truncate(token.contract_address, 6, 4)}
                  </Link>
                ) : (
                  token.symbol
                )}
                {token.name ? <span className="token-name">{token.name}</span> : null}
              </span>
              <span className="token-balance">
                {token.balance}{token.symbol ? ` ${token.symbol}` : ''}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// Format time ago
const formatTimeAgo = (timestamp: number): string => {
  if (!timestamp || timestamp === 0) return 'Genesis';
  
  // Handle both seconds and milliseconds timestamps
  const ts = timestamp > 1e12 ? timestamp : timestamp * 1000;
  
  // If timestamp is before year 2024 (chain launch), treat as Genesis
  if (ts < 1704067200000) return 'Genesis';
  
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 0) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
};

// Format date → dd.mm.yyyy, HH:MM:SS (handle both seconds and milliseconds)
const formatDate = (timestamp: number | string | undefined): string => {
  const tsNum = typeof timestamp === 'string' ? Number(timestamp) : timestamp;
  if (!tsNum || tsNum === 0 || !Number.isFinite(tsNum)) return 'Genesis';
  
  const msTs = tsNum < 1e12 ? tsNum * 1000 : tsNum;
  // Before 2024 (chain launch) = Genesis
  if (msTs < 1704067200000) return 'Genesis';
  
  try {
    const date = new Date(msTs);
    if (isNaN(date.getTime())) return 'N/A';
    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const yyyy = date.getFullYear();
    const hh = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    const ss = String(date.getSeconds()).padStart(2, '0');
    return `${dd}.${mm}.${yyyy}, ${hh}:${min}:${ss}`;
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
  
  // v3.52: Show cached data instantly, but ALWAYS fetch fresh data + auto-refresh
  const cachedData = address ? getCache<AddressData>('address', address) : null;
  
  const [data, setData] = useState<AddressData | null>(cachedData);
  const [error, setError] = useState<string | null>(null);
  const [hasFetched, setHasFetched] = useState(!!cachedData);
  const [txPage, setTxPage] = useState(1);
  const TX_PER_PAGE = 10;
  
  // v3.52: Reusable fetch — used on mount + polling interval
  const fetchAddress = useCallback(async () => {
    if (!address) return;
    try {
      const res = await fetch(`/api/address/${address}`);
      const result = await res.json();
      
      if (result.success && result.data) {
        setData(result.data);
        setCache('address', address, result.data);
        setError(null);
      } else {
        // Only set error on first load, don't wipe data on poll failure
        if (!data) setError(result.error || 'Address not found');
      }
    } catch {
      if (!data) setError('Failed to load address');
    } finally {
      setHasFetched(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);
  
  // v3.52: Initial fetch — ALWAYS fetch fresh data (cache is only for instant display)
  useEffect(() => {
    fetchAddress();
  }, [fetchAddress]);
  
  // v3.52: Auto-refresh every 5 seconds (like main explorer page)
  // Ensures new transactions appear within 5s of block inclusion
  useEffect(() => {
    if (!address) return;
    const interval = setInterval(fetchAddress, 5000);
    return () => clearInterval(interval);
  }, [address, fetchAddress]);
  
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
        {/* v3.11: Merkle proof verification — temporarily hidden
        <BalanceVerification address={address} />
        */}
      </div>

      {/* Other Tokens (collapsible) — render only when there is at least one
          non-QNC token after filtering (fixes the old tokens.length>1 off-by-one,
          which hid a single token and could show an empty card). */}
      {(() => {
        const otherTokens = data.tokens.filter(t => t.symbol !== 'QNC');
        return otherTokens.length > 0 ? <OtherTokens tokens={otherTokens} /> : null;
      })()}

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
                        {(() => {
                          const addr = isSend ? tx.to : tx.from;
                          const isValid = addr && addr.length > 10 && addr.includes('eon');
                          return isValid ? (
                            <Link href={`/explorer/address/${addr}`} className="address-link">
                              {truncate(addr, 6, 4)}
                            </Link>
                          ) : (
                            <span className="address-link">{addr || 'N/A'}</span>
                          );
                        })()}
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
