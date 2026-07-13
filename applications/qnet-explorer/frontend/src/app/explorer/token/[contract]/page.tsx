'use client';

import React, { useState, useCallback, useEffect } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';

interface TokenTransfer {
  hash: string;
  from: string;
  to: string;
  amount: string;
  amountRaw: string;
  method: string;
  block: number;
  timestamp: number;
  status: string;
  fee: string;
}

interface TokenHolder {
  address: string;
  balance: string;
  balance_raw: string;
  percent: string;
}

interface TokenData {
  contract_address: string;
  name: string;
  symbol: string;
  decimals: number;
  total_supply: string;
  total_supply_raw: string;
  total_minted: string;
  total_burned: string;
  deployer: string;
  deployed_at: string;
  transfers: TokenTransfer[];
}

// Truncate
const truncate = (str: string, start = 8, end = 6): string => {
  if (!str || str.length <= start + end + 3) return str || '';
  return `${str.slice(0, start)}...${str.slice(-end)}`;
};

// Format time ago (handles seconds and milliseconds)
const formatTimeAgo = (timestamp: number): string => {
  if (!timestamp || timestamp === 0) return 'Genesis';
  const ts = timestamp > 1e12 ? timestamp : timestamp * 1000;
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

// Copy button (matches address/tx pages)
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
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
};

// Render an address as a link if it looks like an EON address.
const AddrLink = ({ addr }: { addr: string }) => {
  const isValid = addr && addr.length > 10 && addr.includes('eon');
  return isValid ? (
    <Link href={`/explorer/address/${addr}`} className="address-link">
      {truncate(addr, 6, 4)}
    </Link>
  ) : (
    <span className="address-link">{addr || 'N/A'}</span>
  );
};

export default function TokenPage() {
  const params = useParams();
  const contract = params.contract as string;

  const [data, setData] = useState<TokenData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasFetched, setHasFetched] = useState(false);
  const [holders, setHolders] = useState<TokenHolder[]>([]);
  const [holderCount, setHolderCount] = useState<number | null>(null);
  const [holdersTruncated, setHoldersTruncated] = useState(false);

  const fetchToken = useCallback(async () => {
    if (!contract) return;
    try {
      const res = await fetch(`/api/token/${contract}`);
      const result = await res.json();
      if (result.success && result.data) {
        setData(result.data);
        setError(null);
      } else {
        if (!data) setError(result.error || 'Token not found');
      }
    } catch {
      if (!data) setError('Failed to load token');
    } finally {
      setHasFetched(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contract]);

  useEffect(() => {
    fetchToken();
  }, [fetchToken]);

  // Auto-refresh every 5s so new transfers appear (mirrors address page).
  useEffect(() => {
    if (!contract) return;
    const interval = setInterval(fetchToken, 5000);
    return () => clearInterval(interval);
  }, [contract, fetchToken]);

  // Holders (off-chain, from the PG tx index). Fetched once — a heavier replay than transfers.
  useEffect(() => {
    if (!contract) return;
    (async () => {
      try {
        const res = await fetch(`/api/token/${contract}/holders?limit=100`);
        const result = await res.json();
        if (result.success && result.data) {
          setHolders(result.data.holders || []);
          setHolderCount(typeof result.data.holder_count === 'number' ? result.data.holder_count : null);
          setHoldersTruncated(result.data.truncated === true);
        }
      } catch { /* keep last-known */ }
    })();
  }, [contract]);

  if (hasFetched && (error || !data)) {
    return (
      <div className="address-page">
        <div className="error-state">{error || 'Token not found'}</div>
      </div>
    );
  }

  if (!data) {
    return <div className="address-page" />;
  }

  return (
    <div className="address-page">
      {/* Header */}
      <div className="block-header">
        <div className="block-header-top">
          <span className="block-label">TOKEN</span>
          {data.symbol ? <span className="type-badge type-transfer">{data.symbol}</span> : null}
        </div>
        <div className="block-hash-display">
          <h1>{data.name || data.symbol || contract}</h1>
          <CopyBtn text={contract} />
        </div>
      </div>

      {/* Token details */}
      <div className="block-card">
        <h2 className="card-title">Token</h2>
        <div className="details-grid">
          <div className="detail-row">
            <span className="detail-label">Name</span>
            <span className="detail-value">{data.name || 'N/A'}</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Symbol</span>
            <span className="detail-value">{data.symbol || 'N/A'}</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Contract</span>
            <span className="detail-value">
              <span className="address-link">{truncate(contract, 12, 8)}</span>
              <CopyBtn text={contract} />
            </span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Decimals</span>
            <span className="detail-value">{data.decimals}</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Circulating Supply</span>
            <span className="detail-value">
              {data.total_supply}{data.symbol ? ` ${data.symbol}` : ''}
            </span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Total Issued</span>
            <span className="detail-value">
              {data.total_minted}{data.symbol ? ` ${data.symbol}` : ''}
            </span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Total Burned</span>
            <span className="detail-value">
              {data.total_burned}{data.symbol ? ` ${data.symbol}` : ''}
            </span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Deployer</span>
            <span className="detail-value">
              <AddrLink addr={data.deployer} />
            </span>
          </div>
        </div>
      </div>

      {/* Holders (off-chain, from the PG tx index) */}
      <div className="block-card">
        <h2 className="card-title">Holders{holderCount !== null ? ` (${holderCount})` : ''}</h2>
        {holdersTruncated && (
          <div className="detail-row">
            <span className="detail-value" style={{ opacity: 0.7, fontSize: '0.85em' }}>
              Derived from the most recent transfers only — balances may be approximate for very high-activity tokens.
            </span>
          </div>
        )}
        {holders.length === 0 ? (
          <div className="detail-row">
            <span className="detail-value">No holders indexed yet.</span>
          </div>
        ) : (
          <table className="block-table">
            <thead>
              <tr>
                <th>Address</th>
                <th>Balance</th>
                <th>%</th>
              </tr>
            </thead>
            <tbody>
              {holders.map((h, idx) => (
                <tr key={h.address || idx}>
                  <td><AddrLink addr={h.address} /></td>
                  <td>{h.balance}{data.symbol ? ` ${data.symbol}` : ''}</td>
                  <td>{h.percent}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Recent transfers */}
      <div className="block-card">
        <h2 className="card-title">Recent Transfers ({data.transfers.length})</h2>
        {data.transfers.length === 0 ? (
          <div className="detail-row">
            <span className="detail-value">No transfers indexed yet.</span>
          </div>
        ) : (
          <table className="block-table">
            <thead>
              <tr>
                <th>Hash</th>
                <th>Method</th>
                <th>From</th>
                <th>To</th>
                <th>Amount</th>
                <th>Fee</th>
                <th>Block</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {data.transfers.map((t, idx) => (
                <tr key={t.hash || idx}>
                  <td>
                    <Link href={`/explorer/tx/${t.hash}`} className="address-link">
                      {truncate(t.hash, 6, 4)}
                    </Link>
                  </td>
                  <td>
                    <span className={`type-badge type-${t.method.toLowerCase()}`}>{t.method}</span>
                  </td>
                  <td><AddrLink addr={t.from} /></td>
                  <td>{t.to ? <AddrLink addr={t.to} /> : <span className="address-link">—</span>}</td>
                  <td>{t.amount}{data.symbol ? ` ${data.symbol}` : ''}</td>
                  <td>{t.fee}</td>
                  <td>
                    <Link href={`/explorer/block/${t.block}`} className="address-link">
                      {t.block}
                    </Link>
                  </td>
                  <td>{formatTimeAgo(t.timestamp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
