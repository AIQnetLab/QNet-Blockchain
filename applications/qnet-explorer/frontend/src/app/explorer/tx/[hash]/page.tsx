'use client';

import React, { useState, useCallback, useEffect } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { setCache } from '@/lib/explorer-cache';

interface TransactionData {
  hash: string;
  type: string;
  tx_type?: string;
  status: 'confirmed' | 'pending';
  block: number | string;
  block_height?: number | string;
  timestamp: number;
  from: string;
  to: string;
  amount: string;
  amount_raw?: string;
  fee?: string;
  nonce?: number | string;
  gas_price?: string;
  gas_limit?: string;
  signature?: string;
  public_key?: string;
  signature_type?: string;
  is_quantum_signed?: boolean;
  dilithium_signature?: string;
  dilithium_public_key?: string;
}

// Truncate
const truncate = (str: string, start = 8, end = 6): string => {
  if (!str || str.length <= start + end + 3) return str || '';
  return `${str.slice(0, start)}...${str.slice(-end)}`;
};

// Format timestamp → dd.mm.yyyy, HH:MM:SS
const formatTime = (ts: number | string | undefined): string => {
  const timestamp = Number(ts);
  if (!timestamp || !Number.isFinite(timestamp) || timestamp <= 0) {
    return 'Genesis Transaction';
  }
  const ms = timestamp > 1e12 ? timestamp : timestamp * 1000;
  const date = new Date(ms);
  if (isNaN(date.getTime())) return 'Invalid Date';
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${dd}.${mm}.${yyyy}, ${hh}:${min}:${ss}`;
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

export default function TransactionPage() {
  const params = useParams();
  const hash = params.hash as string;
  
  // v2.103: Initialize with null to avoid hydration mismatch (localStorage not available on server)
  const [tx, setTx] = useState<TransactionData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasFetched, setHasFetched] = useState(false);
  
  useEffect(() => {
    if (!hash) return;
    
    // v2.104: Always fetch fresh data, cache only for initial display
    const fetchTransaction = async () => {
      try {
        const res = await fetch(`/api/tx/${hash}`);
        const data = await res.json();
        
        if (data.success && data.data) {
          const newData = data.data as TransactionData;
          
          // Handle timestamp validation
          const apiTs = Number(newData.timestamp) || 0;
          if (apiTs > 0) {
            const tsMs = apiTs < 1e12 ? apiTs * 1000 : apiTs;
            if (tsMs >= 946684800000) {
              newData.timestamp = apiTs;
            }
          }
          
          setTx(newData);
          setCache('tx', hash, newData);
          setError(null);
        } else {
          setError(data.error || 'Transaction not found');
        }
      } catch {
        setError('Transaction not found or backend unavailable');
      } finally {
        setHasFetched(true);
      }
    };
    
    fetchTransaction();
  }, [hash]);
  
  // Show error ONLY after fetch attempt
  if (hasFetched && (error || !tx)) {
    return (
      <div className="block-page">
        <div className="error-state">{error || 'Transaction not found'}</div>
      </div>
    );
  }
  
  // Still loading - show empty shell
  if (!tx) {
    return <div className="block-page" />;
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
        <div className="block-timestamp" suppressHydrationWarning>
          {formatTime(tx.timestamp)}
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
              {tx.from && tx.from.length > 10 && tx.from.includes('eon') ? (
                <Link href={`/explorer/address/${tx.from}`} className="address-link">
                  {truncate(tx.from, 12, 8)}
                </Link>
              ) : (
                <span className="address-link">{tx.from || 'N/A'}</span>
              )}
              <CopyBtn text={tx.from} />
            </span>
          </div>
          <div className="detail-row">
            <span className="detail-label">To</span>
            <span className="detail-value">
              {tx.to && tx.to.length > 10 && tx.to.includes('eon') ? (
                <Link href={`/explorer/address/${tx.to}`} className="address-link">
                  {truncate(tx.to, 12, 8)}
                </Link>
              ) : (
                <span className="address-link">{tx.to || 'N/A'}</span>
              )}
              <CopyBtn text={tx.to} />
            </span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Amount</span>
            <span className="detail-value">{tx.amount || '0 QNC'}</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Fee</span>
            <span className="detail-value">{tx.fee || '0 QNC'}</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Nonce</span>
            <span className="detail-value">{tx.nonce ?? 'N/A'}</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Signature</span>
            <span className="detail-value">{tx.signature_type || (tx.signature ? 'Ed25519' : 'System TX')}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

