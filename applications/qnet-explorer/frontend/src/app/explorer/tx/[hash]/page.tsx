'use client';

import React, { useState, useCallback, useEffect } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';

interface TransactionData {
  hash: string;
  type: string;
  status: 'confirmed' | 'pending';
  block: number;
  timestamp: number;
  from: string;
  to: string;
  amount: string;
  fee?: string;
  nonce?: number;
  signature_type?: string;
}

// Truncate
const truncate = (str: string, start = 8, end = 6): string => {
  if (!str || str.length <= start + end + 3) return str || '';
  return `${str.slice(0, start)}...${str.slice(-end)}`;
};

// Format time (timestamp in ms or seconds)
const formatTime = (ts: number): string => {
  if (!ts || ts === 0) return '—';
  
  // Convert seconds to ms if needed (timestamp < 1e12 means it's in seconds)
  let msTs: number;
  if (ts < 1e12) {
    msTs = ts * 1000;
  } else {
    msTs = ts;
  }
  
  // Validate timestamp (must be after 2000-01-01)
  if (msTs < 946684800000) { // Before 2000-01-01
    return '—';
  }
  
  try {
    const date = new Date(msTs);
    // Check if date is valid
    if (isNaN(date.getTime())) {
      return '—';
    }
    return date.toUTCString();
  } catch {
    return '—';
  } 
};

// Copy button
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

// Check sessionStorage for cached transaction data
function getCachedTx(hash: string): TransactionData | null {
  if (typeof window === 'undefined') return null;
  try {
    const cached = sessionStorage.getItem('qnet_explorer_cache_v3');
    if (cached) {
      const parsed = JSON.parse(cached);
      const txList = parsed.transactions || [];
      const found = txList.find((t: { hash: string }) => t.hash === hash);
      if (found) {
        return {
          hash: found.hash,
          type: found.type, // Keep original type from cache
          status: 'confirmed',
          block: typeof found.block === 'number' ? found.block : 0,
          timestamp: found.timestamp || 0,
          from: found.from || 'unknown',
          to: found.to || 'N/A',
          amount: found.amount || '0 QNC',
        };
      }
    }
  } catch { /* ignore */ }
  return null;
}

export default function TransactionPage() {
  const params = useParams();
  const hash = params.hash as string;
  
  const [tx, setTx] = useState<TransactionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasFetched, setHasFetched] = useState(false);
  
  useEffect(() => {
    if (!hash || hasFetched) return;
    
    // Try cache first (client-side only)
    const cachedTx = getCachedTx(hash);
    
    const fetchTransaction = async () => {
      try {
        // If have cached data - show it immediately, don't show loading
        if (cachedTx) {
          setTx(cachedTx);
          setLoading(false);
        }
        
        // Always fetch from API for latest data
        const res = await fetch(`/api/tx/${hash}`);
        const data = await res.json();
        
        if (data.success && data.data) {
          const newData = data.data as TransactionData;
          
          // CRITICAL: Ensure timestamp is set and valid
          // Use API timestamp if valid, otherwise try cached
          const apiTs = Number(newData.timestamp) || 0;
          let finalTimestamp = apiTs;
          
          // Check if API timestamp is valid
          if (apiTs > 0) {
            // Convert to milliseconds if needed
            const tsMs = apiTs < 1e12 ? apiTs * 1000 : apiTs;
            // If timestamp is valid (after 2000-01-01), use it
            if (tsMs >= 946684800000) {
              finalTimestamp = apiTs; // Keep original format (milliseconds)
            } else if (cachedTx && cachedTx.timestamp) {
              // API timestamp invalid, try cached
              const cachedTsMs = Number(cachedTx.timestamp) < 1e12 ? Number(cachedTx.timestamp) * 1000 : Number(cachedTx.timestamp);
              if (cachedTsMs >= 946684800000) {
                finalTimestamp = Number(cachedTx.timestamp);
              }
            }
          } else if (cachedTx && cachedTx.timestamp) {
            // No timestamp from API, use cached if valid
            const cachedTsMs = Number(cachedTx.timestamp) < 1e12 ? Number(cachedTx.timestamp) * 1000 : Number(cachedTx.timestamp);
            if (cachedTsMs >= 946684800000) {
              finalTimestamp = Number(cachedTx.timestamp);
            }
          }
          
          // Always set timestamp (formatTime will handle validation)
          newData.timestamp = finalTimestamp;
          
          setTx(newData);
          setError(null);
        } else if (!cachedTx) {
          // Only show error if we don't have cached data
          setError(data.error || 'Transaction not found');
        }
      } catch {
        if (!cachedTx) {
          setError('Transaction not found or backend unavailable');
        }
      } finally {
        setLoading(false);
        setHasFetched(true);
      }
    };
    
    fetchTransaction();
  }, [hash, hasFetched]);
  
  if (loading) {
    return (
      <div className="block-page">
        <div className="loading-state">Loading transaction...</div>
      </div>
    );
  }
  
  if (error || !tx) {
    return (
      <div className="block-page">
        <div className="error-state">{error || 'Transaction not found'}</div>
      </div>
    );
  }
  
  return (
    <div className="block-page">
      {/* Header */}
      <div className="block-header">
        <div className="block-header-top">
          <span className={`block-label`}>TRANSACTION</span>
          <span className={`type-badge type-${tx.type.toLowerCase()}`}>{tx.type}</span>
        </div>
        <div className="block-hash-display">
          <h1>{hash}</h1>
          <CopyBtn text={hash} />
        </div>
        <div className="block-timestamp">
          {tx.timestamp && tx.timestamp > 0 ? formatTime(tx.timestamp) : '—'}
        </div>
      </div>

      {/* Details */}
      <div className="block-card">
        <h2 className="card-title">Details</h2>
        <div className="details-grid">
          <div className="detail-row">
            <span className="detail-label">Status</span>
            <span className={`detail-value ${tx.status === 'confirmed' ? 'status-active' : ''}`}>
              {tx.status === 'confirmed' ? '● Confirmed' : '○ Pending'}
            </span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Block</span>
            <span className="detail-value">
              <Link href={`/explorer/block/${tx.block}`} className="address-link">
                {tx.block}
              </Link>
            </span>
          </div>
          <div className="detail-row">
            <span className="detail-label">From</span>
            <span className="detail-value">
              <Link href={`/explorer/address/${tx.from}`} className="address-link">
                {truncate(tx.from, 12, 8)}
              </Link>
              <CopyBtn text={tx.from} />
            </span>
          </div>
          <div className="detail-row">
            <span className="detail-label">To</span>
            <span className="detail-value">
              <Link href={`/explorer/address/${tx.to}`} className="address-link">
                {truncate(tx.to, 12, 8)}
              </Link>
              <CopyBtn text={tx.to} />
            </span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Amount</span>
            <span className="detail-value">{tx.amount}</span>
          </div>
          {tx.fee && (
            <div className="detail-row">
              <span className="detail-label">Fee</span>
              <span className="detail-value">{tx.fee}</span>
            </div>
          )}
          {tx.nonce !== undefined && (
            <div className="detail-row">
              <span className="detail-label">Nonce</span>
              <span className="detail-value">{tx.nonce}</span>
            </div>
          )}
          {tx.signature_type && (
            <div className="detail-row">
              <span className="detail-label">Signature</span>
              <span className="detail-value">{tx.signature_type}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

