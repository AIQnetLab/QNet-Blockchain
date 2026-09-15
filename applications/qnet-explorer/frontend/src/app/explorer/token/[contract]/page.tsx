'use client';

import React, { useState, useCallback, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import TokenIcon from '@/components/TokenIcon';

interface TokenTransfer {
  hash: string;
  from: string;
  to: string;
  std: string;        // qrc20 | qrc721
  token_id: string;   // NFT id (qrc721); '' for qrc20
  amount: string;     // qrc20: decimal amount; qrc721: "#<token_id>"
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
  standard?: string;   // 'qrc20' | 'qrc721' — authoritative token standard from node state
  name: string;
  symbol: string;
  logo?: string;
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
  // Latest loaded data, readable inside the polling closure without re-creating it — so a transient
  // poll failure never blanks an already-rendered page into the full error state.
  const dataRef = useRef<TokenData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasFetched, setHasFetched] = useState(false);
  const [holders, setHolders] = useState<TokenHolder[]>([]);
  const [holderCount, setHolderCount] = useState<number | null>(null);
  const [holdersTruncated, setHoldersTruncated] = useState(false);
  const [txLimit, setTxLimit] = useState(50);        // Load-more: recent transfers page size
  const [holderLimit, setHolderLimit] = useState(100); // Load-more: holders page size
  const [tab, setTab] = useState<'transfers' | 'holders' | 'contract'>('transfers');

  const fetchToken = useCallback(async () => {
    if (!contract) return;
    try {
      const res = await fetch(`/api/token/${contract}?tx=${txLimit}`);
      const result = await res.json();
      if (result.success && result.data) {
        dataRef.current = result.data;
        setData(result.data);
        setError(null);
      } else {
        // Only surface an error if nothing has loaded yet — a transient poll blip keeps last-known.
        if (!dataRef.current) setError(result.error || 'Token not found');
      }
    } catch {
      if (!dataRef.current) setError('Failed to load token');
    } finally {
      setHasFetched(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contract, txLimit]);

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
        const res = await fetch(`/api/token/${contract}/holders?limit=${holderLimit}`);
        const result = await res.json();
        if (result.success && result.data) {
          setHolders(result.data.holders || []);
          setHolderCount(typeof result.data.holder_count === 'number' ? result.data.holder_count : null);
          setHoldersTruncated(result.data.truncated === true);
        }
      } catch { /* keep last-known */ }
    })();
  }, [contract, holderLimit]);

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

  // Token standard, derived from transfer effects (any qrc721 row ⇒ NFT collection). Defaults to
  // QRC-20 for a token with no transfers yet; can be made node-authoritative later.
  // Authoritative standard from node state; fall back to transfer-derived for older nodes.
  const tokenStd = (data.standard === 'qrc721' || data.transfers.some((t) => t.std === 'qrc721')) ? 'QRC-721' : 'QRC-20';

  // Canonical QRC method surface — the token's ABI. Protocol-guaranteed (native standard
  // logic), not custom bytecode, so it is the same for every token of a given standard.
  const tokenIface = tokenStd === 'QRC-721'
    ? [
        { kind: 'read',  sig: 'ownerOf(tokenId)',               desc: 'Owner of an NFT id' },
        { kind: 'read',  sig: 'balanceOf(address)',             desc: 'Number of NFTs held' },
        { kind: 'write', sig: 'transfer(to, tokenId)',          desc: 'Send an NFT' },
        { kind: 'write', sig: 'approve(spender, tokenId)',      desc: 'Authorize a spender for one NFT' },
        { kind: 'write', sig: 'transferFrom(from, to, tokenId)', desc: 'Move an approved NFT' },
        { kind: 'write', sig: 'mint(to, tokenId)',              desc: 'Issue a new NFT (owner)' },
      ]
    : [
        { kind: 'read',  sig: 'balanceOf(address)',             desc: 'Token balance of an address' },
        { kind: 'read',  sig: 'totalSupply()',                  desc: 'Total tokens in circulation' },
        { kind: 'read',  sig: 'allowance(owner, spender)',      desc: 'Remaining approved amount' },
        { kind: 'write', sig: 'transfer(to, amount)',           desc: 'Send tokens' },
        { kind: 'write', sig: 'approve(spender, amount)',       desc: 'Authorize a spender' },
        { kind: 'write', sig: 'transferFrom(from, to, amount)', desc: 'Move approved tokens' },
        { kind: 'write', sig: 'mint(to, amount)',               desc: 'Issue tokens (if mintable, owner)' },
        { kind: 'write', sig: 'burn(amount)',                   desc: 'Destroy tokens (if burnable)' },
      ];

  return (
    <div className="address-page">
      {/* Header */}
      <div className="block-header">
        <div className="block-header-top">
          <span className="block-label">TOKEN</span>
          <span className="type-badge type-contract-call">{tokenStd}</span>
          {data.symbol ? <span className="type-badge type-transfer">{data.symbol}</span> : null}
        </div>
        <div className="block-hash-display" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <TokenIcon logo={data.logo} symbol={data.symbol} address={contract} size={40} />
          <h1 style={{ margin: 0 }}>{data.name || data.symbol || contract}</h1>
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
            <span className="detail-label">Standard</span>
            <span className="detail-value">{tokenStd}</span>
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
          {/* Fungible supply figures only. QRC-721 collections keep no on-chain total_supply/minted/burned
              counter (deliberately — an NFT standard tracks per-token ownership, not a divisible balance),
              so the node returns 0/0/0; suppress the rows rather than misrepresent a collection as 0 supply. */}
          {tokenStd !== 'QRC-721' && (
            <>
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
            </>
          )}
          <div className="detail-row">
            <span className="detail-label">Deployer</span>
            <span className="detail-value">
              <AddrLink addr={data.deployer} />
            </span>
          </div>
        </div>
      </div>

      {/* Tabs (top-L1 token-page layout): Transfers | Holders | Contract */}
      <div className="token-tabs">
        <button className={`token-tab ${tab === 'transfers' ? 'active' : ''}`} onClick={() => setTab('transfers')}>Transfers</button>
        <button className={`token-tab ${tab === 'holders' ? 'active' : ''}`} onClick={() => setTab('holders')}>
          Holders{holderCount !== null ? ` (${holderCount})` : ''}
        </button>
        <button className={`token-tab ${tab === 'contract' ? 'active' : ''}`} onClick={() => setTab('contract')}>Contract</button>
      </div>

      {/* Holders (off-chain, from the PG tx index) */}
      {tab === 'holders' && (
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
        {holders.length >= holderLimit && holderLimit < 500 && (
          <div style={{ textAlign: 'center', marginTop: 12 }}>
            <button
              onClick={() => setHolderLimit((l) => Math.min(l + 100, 500))}
              style={{ padding: '6px 18px', borderRadius: 6, border: '1px solid rgba(0,229,240,0.4)',
                       background: 'transparent', color: '#00e5f0', cursor: 'pointer', fontSize: 13 }}
            >Load more</button>
          </div>
        )}
      </div>
      )}

      {/* Recent transfers */}
      {tab === 'transfers' && (
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
                <tr key={`${t.hash}-${idx}`}>
                  <td>
                    <Link href={`/explorer/tx/${t.hash}`} className="address-link">
                      {truncate(t.hash, 6, 4)}
                    </Link>
                  </td>
                  <td>
                    <span className={`type-badge type-${t.method.toLowerCase()}`}>{t.method}</span>
                  </td>
                  <td><AddrLink addr={t.from} /></td>
                  <td>{t.to ? <AddrLink addr={t.to} /> : <span className="address-link">🔥 Burn</span>}</td>
                  <td>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <TokenIcon logo={data.logo} symbol={data.symbol} address={contract} size={16} />
                      <span>{t.amount}{data.symbol ? ` ${data.symbol}` : ''}</span>
                    </span>
                  </td>
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
        {data.transfers.length >= txLimit && txLimit < 500 && (
          <div style={{ textAlign: 'center', marginTop: 12 }}>
            <button
              onClick={() => setTxLimit((l) => Math.min(l + 50, 500))}
              style={{ padding: '6px 18px', borderRadius: 6, border: '1px solid rgba(0,229,240,0.4)',
                       background: 'transparent', color: '#00e5f0', cursor: 'pointer', fontSize: 13 }}
            >Load more</button>
          </div>
        )}
      </div>
      )}

      {/* Contract: verification + standard interface. QRC-20/721 are native-standard
          contracts (canonical protocol token logic, no custom bytecode) — hence a
          Standard-Contract attestation, not a source recompile. */}
      {tab === 'contract' && (
      <div className="block-card">
        <h2 className="card-title">Contract</h2>
        <div className="details-grid">
          <div className="detail-row">
            <span className="detail-label">Verification</span>
            <span className="detail-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span className="type-badge type-transfer">✓ Standard Contract</span>
              <span style={{ opacity: 0.85 }}>{tokenStd}</span>
            </span>
          </div>
          <div className="detail-row">
            <span className="detail-label" />
            <span className="detail-value" style={{ opacity: 0.8, fontSize: '0.9em', lineHeight: 1.55 }}>
              Native QNet {tokenStd} token — it runs the protocol&apos;s canonical token logic,
              not custom bytecode. Its behavior is defined by the QNet protocol, so no
              per-contract source verification is required.
            </span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Standard</span>
            <span className="detail-value">{tokenStd}</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Contract</span>
            <span className="detail-value">
              <span className="address-link">{truncate(contract, 12, 8)}</span>
              <CopyBtn text={contract} />
            </span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Deployer</span>
            <span className="detail-value"><AddrLink addr={data.deployer} /></span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Deployed</span>
            <span className="detail-value">{data.deployed_at || '—'}</span>
          </div>
        </div>

        <h3 style={{ margin: '18px 0 8px', fontSize: '0.95rem', opacity: 0.9 }}>Standard Interface</h3>
        <table className="block-table">
          <thead>
            <tr><th>Kind</th><th>Method</th><th>Description</th></tr>
          </thead>
          <tbody>
            {tokenIface.map((m, i) => (
              <tr key={i}>
                <td><span className={`type-badge type-${m.kind === 'read' ? 'transfer' : 'contract-call'}`}>{m.kind}</span></td>
                <td style={{ fontFamily: 'monospace' }}>{m.sig}</td>
                <td style={{ opacity: 0.85 }}>{m.desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}
    </div>
  );
}
