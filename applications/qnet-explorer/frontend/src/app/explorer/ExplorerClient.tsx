'use client';

import { memo, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import Link from 'next/link';
import { batchCache, getListCache, setListCache, noteChainHeight } from '@/lib/explorer-cache';
import TokenIcon from '@/components/TokenIcon';

// ============================================================================
// v4.0: SSR-powered Explorer Client
// - Receives pre-fetched data from Server Component (instant first paint)
// - Client handles: polling, filters, pagination, search
// - Debounced filter changes (batch rapid clicks into one request)
// ============================================================================

interface ActivityItem {
  hash: string;
  type: string;
  from: string;
  to: string;
  amount: string;
  block: number;
  time: string;
  timestamp: number;
  // Set on QRC-20 token-interaction rows so the row shows the token's icon (SSR-resolved).
  tokenContract?: string;
  tokenSymbol?: string;
  tokenLogo?: string;
}

export interface ExplorerClientProps {
  initialData: ActivityItem[];
  initialHeight: number;
  initialTotal: number;
}

function getBadgeClass(type: string): string {
  const normalized = type.toLowerCase().replace(/\s+/g, '-');
  return `type-${normalized}`;
}

function formatTimeAgo(timestamp: number, blockHeight?: number): string {
  // Genesis block or genesis transactions (block 0)
  if (blockHeight === 0) return 'Genesis';
  if (!timestamp || timestamp === 0) return 'Genesis';

  const now = Date.now();
  const ts = timestamp > 1e12 ? timestamp : timestamp * 1000;

  // If timestamp is before year 2024 (chain launch), treat as Genesis
  if (ts < 1704067200000) return 'Genesis';

  const diff = now - ts;

  if (diff < 0) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

const ActivityRow = memo(function ActivityRow({ item }: { item: ActivityItem }) {
  const displayTime = formatTimeAgo(item.timestamp, item.block);

  return (
    <tr className="activity-row">
      <td className="col-hash">
        <Link href={`/explorer/tx/${item.hash}`} className="addr">
          {item.hash.slice(0, 8)}...{item.hash.slice(-6)}
        </Link>
      </td>
      <td className="col-type">
        <span className={`type-badge ${getBadgeClass(item.type)}`}>{item.type}</span>
      </td>
      <td className="col-addresses">
        {item.from && item.from.length > 10 && item.from.includes('eon') ? (
          <Link href={`/explorer/address/${item.from}`} className="addr">
            {item.from.slice(0, 6)}...{item.from.slice(-4)}
          </Link>
        ) : (
          <span className="addr">{item.from || 'N/A'}</span>
        )}
        <span className="arr">→</span>
        {item.to === 'batch_transfers' ? (
          <span className="addr">batch recipients</span>
        ) : item.to && item.to.length > 10 && item.to.includes('eon') ? (
          <Link href={`/explorer/address/${item.to}`} className="addr">
            {item.to.slice(0, 6)}...{item.to.slice(-4)}
          </Link>
        ) : (
          <span className="addr">{item.to || 'N/A'}</span>
        )}
      </td>
      <td className="col-amount">
        {(() => {
          // Token label click-through: QRC-20 → its contract page, native value → the QNC coin page.
          const href = item.tokenContract
            ? `/explorer/token/${item.tokenContract}`
            : item.amount.includes('QNC') ? '/explorer/qnc' : null;
          const chip = (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {item.tokenContract
                ? <TokenIcon logo={item.tokenLogo} symbol={item.tokenSymbol} address={item.tokenContract} size={16} />
                : item.amount.includes('QNC') && <TokenIcon native size={16} />}
              <span>{item.amount}</span>
            </span>
          );
          return href
            ? <Link href={href} className="token-amount-link">{chip}</Link>
            : chip;
        })()}
      </td>
      <td className="col-block">
        <Link href={`/explorer/block/${item.block}`}>{item.block}</Link>
      </td>
      <td className="col-time" suppressHydrationWarning>{displayTime}</td>
    </tr>
  );
});

const ITEMS_PER_PAGE = 50;
const TX_TYPES = ['Transfer', 'Reward', 'Swap', 'Heartbeat', 'Light Eligibility', 'Registration', 'Activation', 'Contract', 'System'];

export default function ExplorerClient({ initialData, initialHeight, initialTotal }: ExplorerClientProps) {
  // ========== STATE: initialized from SSR data — table renders INSTANTLY ==========
  const [transactionMap, setTransactionMap] = useState<Map<string, ActivityItem>>(() => {
    const map = new Map<string, ActivityItem>();
    initialData.forEach(tx => map.set(tx.hash, tx));
    return map;
  });
  const [currentHeight, setCurrentHeight] = useState(initialHeight);
  const [loading, setLoading] = useState(false); // SSR data ready — no loading spinner
  const [hasFetched, setHasFetched] = useState(initialData.length > 0);
  const [searchQuery, setSearchQuery] = useState('');
  // Live search dropdown (top-L1 unified search): debounced suggestions as you type.
  const [suggestions, setSuggestions] = useState<{ type: string; label: string; sublabel?: string; href: string; symbol?: string; address?: string; logo?: string }[]>([]);
  const [showSuggest, setShowSuggest] = useState(false);
  const [activeSuggest, setActiveSuggest] = useState(-1);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const suggestTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suggestAbort = useRef<AbortController | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(Math.ceil(initialTotal / ITEMS_PER_PAGE) || 1);
  const [totalCount, setTotalCount] = useState(initialTotal);
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc');
  const [typeFilters, setTypeFilters] = useState<string[]>([]);
  const [mounted, setMounted] = useState(false);

  const fetchDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const isFirstRender = useRef(true);

  useEffect(() => { setMounted(true); }, []);

  // Pre-cache SSR data: instant TX-detail loads + instant list re-display on filter/nav-back
  useEffect(() => {
    if (initialData.length > 0) {
      const defaultKey = `${sortOrder}|${[...typeFilters].sort().join(',')}|1`;
      setListCache(defaultKey, initialData, initialTotal, initialHeight);
      noteChainHeight(initialHeight);
      batchCache('tx', initialData.map(tx => ({
        key: tx.hash,
        data: {
          hash: tx.hash, type: tx.type, status: 'confirmed' as const,
          block: tx.block, timestamp: tx.timestamp, from: tx.from, to: tx.to, amount: tx.amount,
        }
      })));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const filteredAndSortedActivity = useMemo(() => {
    return Array.from(transactionMap.values());
  }, [transactionMap]);

  // ========== FETCH: client-side for filter/pagination/polling ==========
  const fetchActivity = useCallback(async (pageNum: number) => {
    const cacheKey = `${sortOrder}|${[...typeFilters].sort().join(',')}|${pageNum}`;

    // Stale-while-revalidate: render cached rows INSTANTLY (no spinner), then refresh.
    const cached = getListCache(cacheKey);
    if (cached) {
      const m = new Map<string, ActivityItem>();
      for (const tx of cached.data as ActivityItem[]) if (tx.hash) m.set(tx.hash, tx);
      setTransactionMap(m);
      setTotalCount(cached.total);
      setTotalPages(Math.ceil(cached.total / ITEMS_PER_PAGE) || 1);
      if (cached.height) setCurrentHeight(cached.height);
      setHasFetched(true);
    } else {
      setLoading(true);
    }

    try {
      const typeParam = typeFilters.length > 0 && typeFilters.length < TX_TYPES.length
        ? `&types=${encodeURIComponent(typeFilters.join(','))}`
        : '';
      const res = await fetch(`/api/activity?page=${pageNum}&limit=${ITEMS_PER_PAGE}&sort=${sortOrder}${typeParam}`, {
        cache: 'no-store'
      });
      const data = await res.json();

      if (data.success && data.data) {
        const networkHeight = data.pagination?.currentHeight || 0;
        noteChainHeight(networkHeight); // wipe stale caches if the chain was reset to 0
        const total = data.pagination?.total || 0;
        const pages = Math.ceil(total / ITEMS_PER_PAGE) || 1;

        const newMap = new Map<string, ActivityItem>();
        for (const tx of data.data as ActivityItem[]) {
          if (tx.hash) newMap.set(tx.hash, tx);
        }

        setTransactionMap(newMap);
        setCurrentHeight(networkHeight);
        setTotalCount(total);
        setTotalPages(pages);

        // Cache this list page (instant filter/nav re-display) + seed TX-detail cache
        setListCache(cacheKey, data.data, total, networkHeight);
        batchCache('tx', Array.from(newMap.values()).map(tx => ({
          key: tx.hash,
          data: {
            hash: tx.hash, type: tx.type, status: 'confirmed' as const,
            block: tx.block, timestamp: tx.timestamp, from: tx.from, to: tx.to, amount: tx.amount,
          }
        })));
      }
    } catch {
      /* network error — keep current data */
    } finally {
      setLoading(false);
      setHasFetched(true);
    }
  }, [typeFilters, sortOrder]);

  // ========== EFFECTS ==========

  // Debounced fetch on filter/sort/page changes
  useEffect(() => {
    if (!mounted) return;

    // Skip first render — SSR data is already displayed
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }

    // Debounce: batch rapid filter clicks into one API call
    if (fetchDebounceRef.current) clearTimeout(fetchDebounceRef.current);
    fetchDebounceRef.current = setTimeout(() => {
      fetchActivity(page);
    }, 200);

    return () => {
      if (fetchDebounceRef.current) clearTimeout(fetchDebounceRef.current);
    };
  }, [page, typeFilters, sortOrder, mounted, fetchActivity]);

  // Real-time: refresh transactions every 5 seconds (page 1 only)
  useEffect(() => {
    if (!mounted || page !== 1) return;
    const interval = setInterval(() => fetchActivity(1), 5000);
    return () => clearInterval(interval);
  }, [mounted, page, fetchActivity]);

  // Real-time: poll block height every 5 seconds
  useEffect(() => {
    if (!mounted) return;
    const fetchHeight = async () => {
      try {
        const res = await fetch(`/api/network/stats?t=${Date.now()}`, { cache: 'no-store' });
        const data = await res.json();
        if (data.success && data.data?.height) {
          noteChainHeight(data.data.height); // detect chain reset → wipe stale caches
          setCurrentHeight(data.data.height);
        }
      } catch {}
    };
    const interval = setInterval(fetchHeight, 5000);
    return () => clearInterval(interval);
  }, [mounted]);

  // ========== HANDLERS ==========

  const goToPage = (newPage: number) => {
    if (newPage >= 1 && newPage <= totalPages && newPage !== page) {
      setPage(newPage);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const getPageNumbers = () => {
    const pages: (number | string)[] = [];
    const maxVisible = 7;
    if (totalPages <= maxVisible) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      pages.push(1);
      if (page > 3) pages.push('...');
      const start = Math.max(2, page - 1);
      const end = Math.min(totalPages - 1, page + 1);
      for (let i = start; i <= end; i++) pages.push(i);
      if (page < totalPages - 2) pages.push('...');
      pages.push(totalPages);
    }
    return pages;
  };

  const toggleSort = () => {
    setSortOrder(prev => prev === 'desc' ? 'asc' : 'desc');
    setPage(1);
  };

  const goToResult = (href: string) => { window.location.href = href; };

  // Debounced live suggestions: fetch /api/search/suggest as the user types; abort
  // stale requests so a fast typist never lands on an out-of-order response.
  useEffect(() => {
    const q = searchQuery.trim();
    if (suggestTimer.current) clearTimeout(suggestTimer.current);
    if (!q) { setSuggestions([]); setShowSuggest(false); setSuggestLoading(false); return; }
    setSuggestLoading(true);
    suggestTimer.current = setTimeout(async () => {
      suggestAbort.current?.abort();
      const ac = new AbortController();
      suggestAbort.current = ac;
      try {
        const res = await fetch(`/api/search/suggest?q=${encodeURIComponent(q)}`, { signal: ac.signal });
        const data = await res.json();
        if (!ac.signal.aborted) {
          setSuggestions(Array.isArray(data?.results) ? data.results : []);
          setShowSuggest(true);
          setActiveSuggest(-1);
        }
      } catch {
        if (!ac.signal.aborted) { setSuggestions([]); setShowSuggest(true); }
      } finally {
        if (!ac.signal.aborted) setSuggestLoading(false);
      }
    }, 250);
    return () => { if (suggestTimer.current) clearTimeout(suggestTimer.current); };
  }, [searchQuery]);

  // Enter / search-button: go to the highlighted (or first) suggestion. With no
  // suggestion yet, resolve ONLY unambiguous shapes directly — free text with no
  // token match stays on the "Nothing found" dropdown instead of a broken /tx/{q}.
  const handleSearch = () => {
    const pick = activeSuggest >= 0 ? suggestions[activeSuggest] : suggestions[0];
    if (pick) { goToResult(pick.href); return; }
    const q = searchQuery.trim();
    if (!q) return;
    if (/^\d+$/.test(q)) goToResult(`/explorer/block/${q}`);
    else if (q.length === 64 && /^[0-9A-Fa-f]+$/.test(q)) goToResult(`/explorer/tx/${q}`);
    else if (q.length >= 38 && q.toLowerCase().includes('eon')) goToResult(`/explorer/address/${q}`);
    // else: free text, no token match → keep the dropdown ("Nothing found").
  };

  // ========== RENDER ==========

  return (
    <div className="explorer-page">
      <div className="explorer-header">
        <h1>Quantum Blockchain Explorer</h1>
        <p suppressHydrationWarning>All transactions from Genesis to Now • Block Height: {currentHeight || '...'}</p>
      </div>

      <div className="explorer-search" style={{ position: 'relative' }}>
        <input
          type="text"
          placeholder="Search by token, TX hash, block, or address..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onFocus={() => { if (searchQuery.trim() && suggestions.length) setShowSuggest(true); }}
          onBlur={() => setTimeout(() => setShowSuggest(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setShowSuggest(true); setActiveSuggest((i) => Math.min(i + 1, suggestions.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveSuggest((i) => Math.max(i - 1, 0)); }
            else if (e.key === 'Enter') { handleSearch(); }
            else if (e.key === 'Escape') { setShowSuggest(false); }
          }}
          autoComplete="off"
          spellCheck={false}
        />
        <button className="search-btn" type="button" onClick={handleSearch}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="11" cy="11" r="7" stroke="#00e5f0" strokeWidth="2"/>
            <path d="M16.5 16.5L21 21" stroke="#00e5f0" strokeWidth="2" strokeLinecap="round"/>
          </svg>
        </button>
        {showSuggest && searchQuery.trim() && (
          <div style={{
            position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0, zIndex: 50,
            background: 'rgba(8, 20, 28, 0.98)', border: '1px solid rgba(0, 229, 240, 0.35)',
            borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.55)',
            overflow: 'hidden', maxHeight: 360, overflowY: 'auto', textAlign: 'left',
          }}>
            {suggestLoading && suggestions.length === 0 && (
              <div style={{ padding: '12px 16px', color: '#7fa8b0', fontSize: 14 }}>Searching…</div>
            )}
            {!suggestLoading && suggestions.length === 0 && (
              <div style={{ padding: '12px 16px', color: '#7fa8b0', fontSize: 14 }}>Nothing found</div>
            )}
            {suggestions.map((s, i) => (
              <div
                key={`${s.type}-${s.href}-${i}`}
                onMouseDown={(e) => { e.preventDefault(); goToResult(s.href); }}
                onMouseEnter={() => setActiveSuggest(i)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', cursor: 'pointer',
                  background: i === activeSuggest ? 'rgba(0, 229, 240, 0.12)' : 'transparent',
                  borderTop: i === 0 ? 'none' : '1px solid rgba(255,255,255,0.05)',
                }}
              >
                {s.type === 'token' ? (
                  <TokenIcon logo={s.logo} symbol={s.symbol} address={s.address} size={24} />
                ) : (
                  <span style={{
                    fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 700,
                    padding: '2px 7px', borderRadius: 5, color: '#04141a', flexShrink: 0,
                    background: s.type === 'tx' ? '#8b9dff' : s.type === 'block' ? '#7CFFB2' : '#ffd166',
                  }}>{s.type}</span>
                )}
                <span style={{ color: '#e6f7fa', fontWeight: 600, fontSize: 14 }}>{s.label}</span>
                {s.sublabel && (
                  <span style={{ color: '#7fa8b0', fontSize: 12, marginLeft: 'auto', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '55%' }}>{s.sublabel}</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="explorer-activity">
        <div className="activity-header">
          <h2>All Transactions</h2>
          <div className="activity-controls">
            <div className="type-filter-multi">
              <div className="filter-chips">
                {TX_TYPES.map(type => (
                  <button
                    key={type}
                    className={`filter-chip ${typeFilters.includes(type) ? 'active' : ''}`}
                    onClick={() => {
                      setTypeFilters(prev =>
                        prev.includes(type)
                          ? prev.filter(t => t !== type)
                          : [...prev, type]
                      );
                      setPage(1);
                    }}
                  >
                    {type}
                  </button>
                ))}
              </div>
            </div>
            <span className="tx-count">
              {totalCount} transactions
            </span>
          </div>
        </div>

        <div className="table-wrapper">
          {filteredAndSortedActivity.length === 0 && hasFetched ? (
            <div className="empty-state">
              <p>No transactions found</p>
              <span>{typeFilters.length > 0 ? `No ${typeFilters.join('/')} transactions yet` : 'Waiting for network activity...'}</span>
            </div>
          ) : filteredAndSortedActivity.length === 0 ? (
            <div className="table-placeholder" />
          ) : (
            <table className="activity-table">
              <thead>
                <tr>
                  <th>TRANSACTION</th>
                  <th>TYPE</th>
                  <th>FROM → TO</th>
                  <th style={{ textAlign: 'right' }}>AMOUNT</th>
                  <th
                    className="sortable-header"
                    onClick={toggleSort}
                    title="Click to sort by block height"
                  >
                    BLOCK {sortOrder === 'desc' ? '↓' : '↑'}
                  </th>
                  <th>TIME</th>
                </tr>
              </thead>
              <tbody>
                {filteredAndSortedActivity.map((item, idx) => (
                  <ActivityRow key={`${item.hash}-${idx}`} item={item} />
                ))}
              </tbody>
            </table>
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="pagination-controls">
              <button
                className="page-btn page-arrow"
                onClick={() => goToPage(page - 1)}
                disabled={page === 1 || loading}
              >
                ←
              </button>

              {getPageNumbers().map((p, idx) => (
                typeof p === 'number' ? (
                  <button
                    key={idx}
                    className={`page-btn ${p === page ? 'active' : ''}`}
                    onClick={() => goToPage(p)}
                    disabled={loading}
                  >
                    {p}
                  </button>
                ) : (
                  <span key={idx} className="page-ellipsis">...</span>
                )
              ))}

              <button
                className="page-btn page-arrow"
                onClick={() => goToPage(page + 1)}
                disabled={page === totalPages || loading}
              >
                →
              </button>

              <span className="page-info">
                Page {page} of {totalPages} ({totalCount} total)
              </span>
            </div>
          )}

          {totalPages <= 1 && filteredAndSortedActivity.length > 0 && (
            <div className="pagination-info">
              {totalCount} transactions
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
