'use client';

import React, { useState, useCallback, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

// ============================================================================
// Token directory
// ============================================================================
// Two ways in:
//   1. Contract lookup — paste a QRC-20 contract address to open its page
//      (validated against the real /api/token/{contract} route first).
//   2. Browse-all list — every deployed QRC-20 token, built from the explorer's
//      OWN PostgreSQL tx index (the ContractDeploy transactions it already
//      ingests). See /api/tokens. Searchable + paginated; each row links to
//      /explorer/token/{contract}. No node round-trip, no hardcoded list.

interface TokenListEntry {
  contract_address: string;
  name: string;
  symbol: string;
  decimals: number;
  deployer: string;
  total_supply: string;
  total_supply_raw: string;
  deployed_block: number;
  deployed_at: number;
  deploy_hash: string;
}

const PER_PAGE = 25;

// Truncate long hashes/addresses for table cells.
const truncate = (str: string, start = 8, end = 6): string => {
  if (!str || str.length <= start + end + 3) return str || '';
  return `${str.slice(0, start)}...${str.slice(-end)}`;
};

// Format a deploy timestamp (ms epoch) as a short date, or a Genesis fallback.
const formatDeployed = (ts: number): string => {
  if (!ts || ts < 946684800000) return 'Genesis';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '—';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
};

export default function TokensDirectoryPage() {
  const router = useRouter();

  // --- Contract lookup (existing behavior) ---
  const [contract, setContract] = useState('');
  const [checking, setChecking] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const lookup = useCallback(async () => {
    const value = contract.trim();
    if (!value) {
      setLookupError('Enter a token contract address.');
      return;
    }
    setChecking(true);
    setLookupError(null);
    try {
      // Validate against the real token route before navigating.
      const res = await fetch(`/api/token/${encodeURIComponent(value)}`);
      const result = await res.json().catch(() => null);
      if (res.ok && result?.success) {
        router.push(`/explorer/token/${value}`);
      } else {
        setLookupError(result?.error || 'No QRC-20 token found at that contract address.');
      }
    } catch {
      setLookupError('Failed to reach the token service. Try again.');
    } finally {
      setChecking(false);
    }
  }, [contract, router]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') lookup();
  };

  // --- Browse-all list (real data from the tx index) ---
  const [tokens, setTokens] = useState<TokenListEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [hasFetched, setHasFetched] = useState(false);

  // Fetch the token list whenever page or the (debounced) search term changes.
  useEffect(() => {
    let active = true;
    const controller = new AbortController();

    const load = async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({
          page: String(page),
          perPage: String(PER_PAGE),
        });
        if (search.trim()) params.set('search', search.trim());

        const res = await fetch(`/api/tokens?${params.toString()}`, { signal: controller.signal });
        const result = await res.json().catch(() => null);
        if (!active) return;

        if (res.ok && result?.success && result.data) {
          setTokens(Array.isArray(result.data.tokens) ? result.data.tokens : []);
          setTotal(Number(result.data.total) || 0);
          setListError(null);
        } else {
          setTokens([]);
          setTotal(0);
          setListError(result?.error || 'Failed to load tokens.');
        }
      } catch (err) {
        if (!active || (err instanceof DOMException && err.name === 'AbortError')) return;
        setTokens([]);
        setTotal(0);
        setListError('Failed to reach the token directory.');
      } finally {
        if (active) {
          setLoading(false);
          setHasFetched(true);
        }
      }
    };

    // Small debounce so typing in the search box doesn't spam the API.
    const timer = setTimeout(load, search ? 300 : 0);
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [page, search]);

  // Reset to page 1 whenever the search term changes.
  const onSearchChange = (value: string) => {
    setSearch(value);
    setPage(1);
  };

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));

  return (
    <div className="address-page">
      <div className="block-header">
        <div className="block-header-top">
          <span className="block-label">TOKENS</span>
        </div>
        <div className="block-hash-display">
          <h1>Token Directory</h1>
        </div>
      </div>

      {/* Contract lookup */}
      <div className="block-card">
        <h2 className="card-title">Look up a QRC-20 token</h2>
        <div className="details-grid">
          <div className="detail-row">
            <input
              type="text"
              value={contract}
              onChange={e => setContract(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Token contract address (…eon…)"
              className="token-lookup-input"
              disabled={checking}
              spellCheck={false}
              autoComplete="off"
            />
            <button className="page-btn" onClick={lookup} disabled={checking}>
              {checking ? 'Checking…' : 'Open'}
            </button>
          </div>
          {lookupError && (
            <div className="detail-row">
              <span className="detail-value text-error">{lookupError}</span>
            </div>
          )}
        </div>
      </div>

      {/* Browse-all list */}
      <div className="block-card">
        <h2 className="card-title">All Tokens ({total})</h2>

        <div className="details-grid">
          <div className="detail-row">
            <input
              type="text"
              value={search}
              onChange={e => onSearchChange(e.target.value)}
              placeholder="Search by symbol, name, or contract address"
              className="token-lookup-input"
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        </div>

        {loading && !hasFetched ? (
          <div className="detail-row">
            <span className="detail-value">Loading tokens…</span>
          </div>
        ) : listError ? (
          <div className="detail-row">
            <span className="detail-value text-error">{listError}</span>
          </div>
        ) : tokens.length === 0 ? (
          <div className="detail-row">
            <span className="detail-value">
              {search.trim()
                ? 'No tokens match your search.'
                : 'No QRC-20 tokens have been deployed yet.'}
            </span>
          </div>
        ) : (
          <>
            <table className="block-table">
              <thead>
                <tr>
                  <th>Token</th>
                  <th>Symbol</th>
                  <th>Contract</th>
                  <th>Total Supply</th>
                  <th>Deployer</th>
                  <th>Deployed</th>
                </tr>
              </thead>
              <tbody>
                {tokens.map((t, idx) => (
                  <tr key={t.contract_address || idx}>
                    <td>
                      <Link href={`/explorer/token/${t.contract_address}`} className="address-link">
                        {t.name || t.symbol || truncate(t.contract_address, 6, 4)}
                      </Link>
                    </td>
                    <td>
                      {t.symbol ? (
                        <span className="type-badge type-token-transfer">{t.symbol}</span>
                      ) : (
                        <span className="address-link">—</span>
                      )}
                    </td>
                    <td>
                      <Link href={`/explorer/token/${t.contract_address}`} className="address-link">
                        {truncate(t.contract_address, 6, 4)}
                      </Link>
                    </td>
                    <td>
                      {t.total_supply}
                      {t.symbol ? ` ${t.symbol}` : ''}
                    </td>
                    <td>
                      {t.deployer && t.deployer.length > 10 && t.deployer.includes('eon') ? (
                        <Link href={`/explorer/address/${t.deployer}`} className="address-link">
                          {truncate(t.deployer, 6, 4)}
                        </Link>
                      ) : (
                        <span className="address-link">{t.deployer || '—'}</span>
                      )}
                    </td>
                    <td>{formatDeployed(t.deployed_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {totalPages > 1 && (
              <div className="details-grid">
                <div className="detail-row">
                  <button
                    className="page-btn"
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                    disabled={page <= 1 || loading}
                  >
                    Prev
                  </button>
                  <span className="detail-value">
                    Page {page} of {totalPages}
                  </span>
                  <button
                    className="page-btn"
                    onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                    disabled={page >= totalPages || loading}
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        <p className="token-directory-note">
          This list is built from the explorer&apos;s own transaction index (every QRC-20
          ContractDeploy). Tokens also appear under &quot;Other Tokens&quot; on any holder&apos;s
          address page.
        </p>
      </div>
    </div>
  );
}
