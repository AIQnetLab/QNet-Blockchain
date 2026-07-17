'use client';

import React, { useState, useCallback, useEffect } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { setCache } from '@/lib/explorer-cache';
import { formatTokenAmount } from '@/lib/token-format';
import TokenIcon from '@/components/TokenIcon';

// Decoded QRC-20 ContractCall: the contract is the tx `to`, the method + args
// live in the tx `data` JSON ({"method","args":[...]}). Decimals must be
// resolved from the token itself (each token has its OWN decimals) — never the
// QNC 1e9 formatter.
interface DecodedTokenCall {
  method: string;
  contract: string;   // the token contract (tx.to)
  to: string;         // transfer recipient
  amountRaw: string;  // u64 base units (string; may exceed 2^53)
}

// Parse tx.data for QRC-20 value-moving methods. Returns null for non-token or
// undecodable calls so the caller falls back to the generic data card.
function decodeTokenCall(dataStr: string | null | undefined, contract: string): DecodedTokenCall | null {
  if (!dataStr) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(dataStr); } catch { return null; }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as { method?: unknown; args?: unknown };
  const method = typeof obj.method === 'string' ? obj.method : '';
  const args = Array.isArray(obj.args) ? obj.args : [];
  const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

  if (method === 'transfer') {          // [to, amount]
    return { method, contract, to: str(args[0]), amountRaw: str(args[1]) };
  }
  if (method === 'transferFrom') {      // [from, to, amount]
    return { method, contract, to: str(args[1]), amountRaw: str(args[2]) };
  }
  return null;
}

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
  tx_type_data?: Record<string, unknown> | null;
  data?: string | null;
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

// snake_case/genesis_id → "Genesis Id" for the data card labels
const humanizeKey = (key: string): string =>
  key.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

// Build a single, valid CSS modifier class from a display type. Display types
// like "Token Transfer" / "Contract Call" / "Light Eligibility" contain spaces,
// so a naive `type-${type.toLowerCase()}` would emit TWO classes (e.g.
// "type-token transfer"). Collapse every run of non-alphanumerics to a single
// '-' so the result is one class matching the CSS (e.g. "type-token-transfer").
const typeBadgeClass = (type: string): string =>
  `type-${(type || 'other').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;

// Render any tx_type_data value as a string (objects/arrays → JSON)
const formatDataValue = (val: unknown): string => {
  if (val === null || val === undefined) return 'N/A';
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
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

// Render a decoded QRC-20 transfer as a human row:
// "Transferred X SYMBOL to <addr>", resolving decimals + symbol from the token
// contract. Falls back to base-unit display if the token lookup fails.
const TokenTransferCard = ({ call }: { call: DecodedTokenCall }) => {
  const [meta, setMeta] = useState<{ symbol: string; decimals: number; logo: string } | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch(`/api/token/${call.contract}`);
        const result = await res.json();
        if (active && result?.success && result.data) {
          setMeta({
            symbol: result.data.symbol || '',
            decimals: typeof result.data.decimals === 'number' ? result.data.decimals : 9,
            logo: result.data.logo || '',
          });
        }
      } catch {
        // leave meta null → base-unit fallback
      }
    })();
    return () => { active = false; };
  }, [call.contract]);

  // Until decimals are known, show raw base units (still exact, no float).
  const decimals = meta ? meta.decimals : 0;
  const symbol = meta ? meta.symbol : '';
  const logo = meta ? meta.logo : '';
  const amount = formatTokenAmount(call.amountRaw, decimals);

  const addrLink = (addr: string) => {
    const isValid = addr && addr.length > 10 && addr.includes('eon');
    return isValid ? (
      <Link href={`/explorer/address/${addr}`} className="address-link">{truncate(addr, 12, 8)}</Link>
    ) : (
      <span className="address-link">{addr || 'N/A'}</span>
    );
  };

  return (
    <div className="block-card">
      <h2 className="card-title">Token Transfer</h2>
      <div className="details-grid">
        <div className="detail-row">
          <span className="detail-label">Action</span>
          <span className="detail-value">
            Transferred {amount}{symbol ? ` ${symbol}` : ''} to {addrLink(call.to)}
          </span>
        </div>
        <div className="detail-row">
          <span className="detail-label">Amount</span>
          <span className="detail-value">
            <Link href={`/explorer/token/${call.contract}`} className="token-amount-link" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <TokenIcon logo={logo} symbol={symbol} address={call.contract} size={16} />
              <span>{amount}{symbol ? ` ${symbol}` : ''}</span>
            </Link>
          </span>
        </div>
        <div className="detail-row">
          <span className="detail-label">Recipient</span>
          <span className="detail-value">{addrLink(call.to)}</span>
        </div>
        <div className="detail-row">
          <span className="detail-label">Token</span>
          <span className="detail-value">
            <Link href={`/explorer/token/${call.contract}`} className="address-link">
              {symbol || truncate(call.contract, 12, 8)}
            </Link>
            <CopyBtn text={call.contract} />
          </span>
        </div>
        <div className="detail-row">
          <span className="detail-label">Method</span>
          <span className="detail-value">{call.method}</span>
        </div>
      </div>
    </div>
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
          <span className={`type-badge ${typeBadgeClass(tx.type)}`}>{tx.type}</span>
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
            <span className="detail-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {(tx.amount || '0').includes('QNC') ? (
                <Link href="/explorer/qnc" className="token-amount-link" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <TokenIcon native size={16} />
                  <span>{tx.amount || '0'}</span>
                </Link>
              ) : (
                <span>{tx.amount || '0'}</span>
              )}
            </span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Fee</span>
            <span className="detail-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {(tx.fee || '0').includes('QNC') && <TokenIcon native size={16} />}
              <span>{tx.fee || '0'}</span>
            </span>
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

      {/* QRC-20 transfer: render a human "Transferred X SYMBOL to <addr>" row
          (decimals resolved from the token) instead of dumping raw JSON. */}
      {(() => {
        const call = decodeTokenCall(tx.data, tx.to);
        if (call) return <TokenTransferCard call={call} />;

        // Fallback: type-specific public data (bitmap epoch/eligible_count,
        // reward pool, etc.) for non-token transactions.
        return tx.tx_type_data && Object.keys(tx.tx_type_data).length > 0 ? (
          <div className="block-card">
            <h2 className="card-title">Transaction Data</h2>
            <div className="details-grid">
              {Object.entries(tx.tx_type_data).map(([key, value]) => (
                <div className="detail-row" key={key}>
                  <span className="detail-label">{humanizeKey(key)}</span>
                  <span className="detail-value">{formatDataValue(value)}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null;
      })()}
    </div>
  );
}

