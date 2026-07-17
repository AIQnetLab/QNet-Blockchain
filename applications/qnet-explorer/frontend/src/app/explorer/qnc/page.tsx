'use client';

import React, { useState, useCallback, useEffect } from 'react';
import Link from 'next/link';
import TokenIcon from '@/components/TokenIcon';

// ============================================================================
// Native QNC overview: supply + rich list (top holders) + recent QNC transfers.
// QNC is the NATIVE coin (no contract address, like ETH/SOL) — this is the coin's
// holders/supply/history view, not a QRC-20 token page.
//   supply + holders : /api/qnc      -> node /api/v1/richlist
//   recent transfers : /api/activity -> filtered to native QNC value txs
// ============================================================================

interface QncHolder {
  address: string;
  balance: string; // exact QNC decimal, no unit
  percent: string;
}

interface QncData {
  total_supply: string;
  circulating: string;
  burned: string;
  holder_count: number;
  holders: QncHolder[];
}

interface QncTransfer {
  hash: string;
  type: string;
  from: string;
  to: string;
  amount: string; // pre-formatted ("X QNC" for value, "0" otherwise)
  block: number | string;
  timestamp: number;
}

const truncate = (s: string, start = 6, end = 4): string =>
  !s || s.length <= start + end + 3 ? s || '' : `${s.slice(0, start)}...${s.slice(-end)}`;

const formatTimeAgo = (timestamp: number): string => {
  if (!timestamp) return '—';
  const ts = timestamp > 1e12 ? timestamp : timestamp * 1000;
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 0) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

const AddrLink = ({ addr }: { addr: string }) => {
  const isValid = addr && addr.length > 10 && addr.includes('eon');
  return isValid ? (
    <Link href={`/explorer/address/${addr}`} className="address-link">{truncate(addr)}</Link>
  ) : (
    <span className="address-link">{addr || 'N/A'}</span>
  );
};

export default function QncPage() {
  const [data, setData] = useState<QncData | null>(null);
  const [transfers, setTransfers] = useState<QncTransfer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [hasFetched, setHasFetched] = useState(false);

  const fetchQnc = useCallback(async () => {
    try {
      const res = await fetch('/api/qnc?limit=100', { cache: 'no-store' });
      const result = await res.json();
      if (result.success && Array.isArray(result.holders)) {
        setData(result);
        setError(null);
      } else if (!data) {
        setError(result.error || 'QNC data unavailable');
      }
    } catch {
      if (!data) setError('Failed to load QNC data');
    } finally {
      setHasFetched(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Recent native QNC transfers, reusing the main activity feed (value-moving types only).
  const fetchTransfers = useCallback(async () => {
    try {
      const res = await fetch('/api/activity?page=1&limit=15&types=Transfer,Reward', { cache: 'no-store' });
      const result = await res.json();
      const rows = Array.isArray(result?.data) ? result.data : [];
      setTransfers(rows.map((t: Partial<QncTransfer>) => ({
        hash: t.hash || '',
        type: t.type || 'Transfer',
        from: t.from || '',
        to: t.to || '',
        amount: t.amount || '0',
        block: t.block ?? 0,
        timestamp: t.timestamp ?? 0,
      })));
    } catch { /* keep last-known */ }
  }, []);

  useEffect(() => { fetchQnc(); fetchTransfers(); }, [fetchQnc, fetchTransfers]);
  // Auto-refresh (rich list is a fuller scan than a tx feed).
  useEffect(() => {
    const t = setInterval(() => { fetchQnc(); fetchTransfers(); }, 10000);
    return () => clearInterval(t);
  }, [fetchQnc, fetchTransfers]);

  // Pre-first-fetch: empty shell. After that always render — each card degrades on its own, so a
  // richlist/supply failure must NOT hide Recent Transfers (which has its own healthy source).
  if (!hasFetched && !data) return <div className="address-page" />;

  return (
    <div className="address-page">
      {/* Header */}
      <div className="block-header">
        <div className="block-header-top">
          <span className="block-label">NATIVE COIN</span>
          <span className="type-badge type-transfer">QNC</span>
        </div>
        <div className="block-hash-display" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <TokenIcon native size={40} />
          <h1 style={{ margin: 0 }}>QNC</h1>
        </div>
      </div>

      {/* Supply + Top Holders come from /api/qnc (node rich list); degrade to a note if it fails. */}
      {data ? (
      <>
      {/* Supply */}
      <div className="block-card">
        <h2 className="card-title">Supply</h2>
        <div className="details-grid">
          <div className="detail-row">
            <span className="detail-label">Type</span>
            <span className="detail-value">Native coin (no contract address)</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Total Supply</span>
            <span className="detail-value">
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <TokenIcon native size={16} /><span>{data.total_supply} QNC</span>
              </span>
            </span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Circulating</span>
            <span className="detail-value">
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <TokenIcon native size={16} /><span>{data.circulating} QNC</span>
              </span>
            </span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Burned</span>
            <span className="detail-value">{data.burned} QNC</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Holders</span>
            <span className="detail-value">{data.holder_count.toLocaleString('en-US')}</span>
          </div>
        </div>
      </div>

      {/* Rich list */}
      <div className="block-card">
        <h2 className="card-title">Top Holders</h2>
        {data.holders.length === 0 ? (
          <div className="detail-row"><span className="detail-value">No holders yet.</span></div>
        ) : (
          <table className="block-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Address</th>
                <th>Balance</th>
                <th>%</th>
              </tr>
            </thead>
            <tbody>
              {data.holders.map((h, idx) => (
                <tr key={h.address || idx}>
                  <td>{idx + 1}</td>
                  <td><AddrLink addr={h.address} /></td>
                  <td>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <TokenIcon native size={16} /><span>{h.balance} QNC</span>
                    </span>
                  </td>
                  <td>{h.percent}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      </>
      ) : (
        <div className="block-card">
          <div className="detail-row">
            <span className="detail-value">{error || 'QNC supply/holders unavailable — the node rich-list endpoint is not reachable yet.'}</span>
          </div>
        </div>
      )}

      {/* Recent QNC transfers */}
      <div className="block-card">
        <h2 className="card-title">Recent QNC Transfers</h2>
        {transfers.length === 0 ? (
          <div className="detail-row"><span className="detail-value">No transfers yet.</span></div>
        ) : (
          <table className="block-table">
            <thead>
              <tr>
                <th>Hash</th>
                <th>From</th>
                <th>To</th>
                <th>Amount</th>
                <th>Block</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {transfers.map((t, idx) => (
                <tr key={`${t.hash}-${idx}`}>
                  <td>
                    <Link href={`/explorer/tx/${t.hash}`} className="address-link">{truncate(t.hash)}</Link>
                  </td>
                  <td><AddrLink addr={t.from} /></td>
                  <td><AddrLink addr={t.to} /></td>
                  <td>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      {t.amount.includes('QNC') && <TokenIcon native size={16} />}
                      <span>{t.amount}</span>
                    </span>
                  </td>
                  <td>
                    <Link href={`/explorer/block/${t.block}`} className="address-link">{t.block}</Link>
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
