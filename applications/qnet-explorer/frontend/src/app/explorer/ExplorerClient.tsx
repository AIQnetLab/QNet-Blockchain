'use client';

import { memo, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import Link from 'next/link';
import { batchCache, getListCache, setListCache, noteChainHeight } from '@/lib/explorer-cache';
import { useChainHead } from '@/hooks/useChainHead';
import TokenIcon from '@/components/TokenIcon';

// Transaction list. First paint comes from SSR (the server's head snapshot); afterwards the head stream
// drives refreshes (no timers), pages move by cursor, numbered jumps stay within the offset cap.

interface ActivityItem {
  hash: string;
  type: string;
  from: string;
  to: string;
  amount: string;
  block: number;
  txIndex?: number;
  time: string;
  timestamp: number;
  tokenContract?: string;
  tokenSymbol?: string;
  tokenLogo?: string;
}

export interface ExplorerClientProps {
  initialData: ActivityItem[];
  initialHeight: number;
  initialTotal: number;
}

interface Pagination {
  total: number;
  currentHeight: number;
  nextCursor: string | null;
  prevCursor: string | null;
  maxPage: number;
  page: number | null;
}

function getBadgeClass(type: string): string {
  return `type-${type.toLowerCase().replace(/\s+/g, '-')}`;
}

function formatTimeAgo(timestamp: number, blockHeight?: number): string {
  if (blockHeight === 0) return 'Genesis';
  if (!timestamp || timestamp === 0) return 'Genesis';
  const ts = timestamp > 1e12 ? timestamp : timestamp * 1000;
  if (ts < 1704067200000) return 'Genesis';
  const diff = Date.now() - ts;
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
          <Link href={`/explorer/address/${item.from}`} className="addr">{item.from.slice(0, 6)}...{item.from.slice(-4)}</Link>
        ) : (
          <span className="addr">{item.from || 'N/A'}</span>
        )}
        <span className="arr">→</span>
        {item.to === 'batch_transfers' ? (
          <span className="addr">batch recipients</span>
        ) : item.to && item.to.length > 10 && item.to.includes('eon') ? (
          <Link href={`/explorer/address/${item.to}`} className="addr">{item.to.slice(0, 6)}...{item.to.slice(-4)}</Link>
        ) : (
          <span className="addr">{item.to || 'N/A'}</span>
        )}
      </td>
      <td className="col-amount">
        {(() => {
          const href = item.tokenContract ? `/explorer/token/${item.tokenContract}` : item.amount.includes('QNC') ? '/explorer/qnc' : null;
          const chip = (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {item.tokenContract
                ? <TokenIcon logo={item.tokenLogo} symbol={item.tokenSymbol} address={item.tokenContract} size={16} />
                : item.amount.includes('QNC') && <TokenIcon native size={16} />}
              <span>{item.amount}</span>
            </span>
          );
          return href ? <Link href={href} className="token-amount-link">{chip}</Link> : chip;
        })()}
      </td>
      <td className="col-block"><Link href={`/explorer/block/${item.block}`}>{item.block}</Link></td>
      <td className="col-time" suppressHydrationWarning>{displayTime}</td>
    </tr>
  );
});

const ITEMS_PER_PAGE = 50;
const TX_TYPES = ['Transfer', 'Reward', 'Swap', 'Heartbeat', 'Light Eligibility', 'Registration', 'Activation', 'Contract', 'System'];
const LIVE_REFRESH_MIN_MS = 1500;

export default function ExplorerClient({ initialData, initialHeight, initialTotal }: ExplorerClientProps) {
  const [rows, setRows] = useState<ActivityItem[]>(initialData);
  const [pagination, setPagination] = useState<Pagination>({
    total: initialTotal, currentHeight: initialHeight, nextCursor: null, prevCursor: null,
    maxPage: Math.max(1, Math.min(200, Math.ceil(initialTotal / ITEMS_PER_PAGE))), page: 1,
  });
  const [loading, setLoading] = useState(false);
  const [hasFetched, setHasFetched] = useState(initialData.length > 0);
  const [searchQuery, setSearchQuery] = useState('');
  const [suggestions, setSuggestions] = useState<{ type: string; label: string; sublabel?: string; href: string; symbol?: string; address?: string; logo?: string }[]>([]);
  const [showSuggest, setShowSuggest] = useState(false);
  const [activeSuggest, setActiveSuggest] = useState(-1);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const suggestTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suggestAbort = useRef<AbortController | null>(null);
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc');
  const [typeFilters, setTypeFilters] = useState<string[]>([]);
  // Where the visible page sits: numbered (offset) or cursor-addressed.
  const [pos, setPos] = useState<{ page: number; cursor: string | null; dir: 'next' | 'prev' }>({ page: 1, cursor: null, dir: 'next' });
  const [mounted, setMounted] = useState(false);
  const head = useChainHead();
  const lastLiveRefresh = useRef(0);
  const fetchSeq = useRef(0);
  const isFirstRender = useRef(true);

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    if (initialData.length > 0) {
      setListCache(`desc||1`, initialData, initialTotal, initialHeight);
      noteChainHeight(initialHeight);
      batchCache('tx', initialData.map(tx => ({ key: tx.hash, data: { hash: tx.hash, type: tx.type, status: 'confirmed' as const, block: tx.block, timestamp: tx.timestamp, from: tx.from, to: tx.to, amount: tx.amount } })));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const isLiveView = pos.page === 1 && pos.cursor === null && sortOrder === 'desc' && typeFilters.length === 0;

  const fetchList = useCallback(async (target: { page: number; cursor: string | null; dir: 'next' | 'prev' }, silent: boolean) => {
    const seq = ++fetchSeq.current;
    const filterKey = [...typeFilters].sort().join(',');
    const cacheKey = `${sortOrder}|${filterKey}|${target.cursor ?? `p${target.page}`}`;
    const cached = !silent ? getListCache(cacheKey) : null;
    if (cached) {
      setRows(cached.data as ActivityItem[]);
      setPagination(p => ({ ...p, total: cached.total, currentHeight: cached.height || p.currentHeight }));
      setHasFetched(true);
    } else if (!silent) {
      setLoading(true);
    }
    try {
      const params = new URLSearchParams({ limit: String(ITEMS_PER_PAGE), sort: sortOrder });
      if (typeFilters.length > 0 && typeFilters.length < TX_TYPES.length) params.set('types', typeFilters.join(','));
      if (target.cursor) { params.set('cursor', target.cursor); params.set('dir', target.dir); }
      else if (target.page > 1) params.set('page', String(target.page));
      const res = await fetch(`/api/activity?${params.toString()}`, { cache: 'no-store' });
      const data = await res.json();
      if (seq !== fetchSeq.current) return;
      if (data.success && Array.isArray(data.data)) {
        const pg = data.pagination || {};
        noteChainHeight(pg.currentHeight || 0);
        setRows(data.data as ActivityItem[]);
        setPagination({
          total: pg.total || 0, currentHeight: pg.currentHeight || 0, nextCursor: pg.nextCursor ?? null, prevCursor: pg.prevCursor ?? null,
          maxPage: pg.maxPage || 1, page: typeof pg.page === 'number' ? pg.page : null,
        });
        setListCache(cacheKey, data.data, pg.total || 0, pg.currentHeight || 0);
        batchCache('tx', (data.data as ActivityItem[]).map(tx => ({ key: tx.hash, data: { hash: tx.hash, type: tx.type, status: 'confirmed' as const, block: tx.block, timestamp: tx.timestamp, from: tx.from, to: tx.to, amount: tx.amount } })));
      }
    } catch {
      /* keep what is shown */
    } finally {
      if (seq === fetchSeq.current) { setLoading(false); setHasFetched(true); }
    }
  }, [sortOrder, typeFilters]);

  // Position, sort or filter changed: fetch that page.
  useEffect(() => {
    if (!mounted) return;
    if (isFirstRender.current) { isFirstRender.current = false; return; }
    const t = setTimeout(() => { void fetchList(pos, false); }, 150);
    return () => clearTimeout(t);
  }, [pos, sortOrder, typeFilters, mounted, fetchList]);

  // A new head: the live view refreshes (throttled); other pages only update the height/total.
  useEffect(() => {
    if (!mounted || !head.height) return;
    setPagination(p => ({ ...p, currentHeight: head.height, total: typeFilters.length === 0 ? head.txTotal || p.total : p.total }));
    if (!isLiveView) return;
    const now = Date.now();
    if (now - lastLiveRefresh.current < LIVE_REFRESH_MIN_MS) return;
    lastLiveRefresh.current = now;
    void fetchList(pos, true);
  }, [head.v]); // eslint-disable-line react-hooks/exhaustive-deps

  const goNext = () => { if (pagination.nextCursor) { setPos(p => ({ page: (p.page || 1) + 1, cursor: pagination.nextCursor, dir: 'next' })); window.scrollTo({ top: 0, behavior: 'smooth' }); } };
  const goPrev = () => {
    if (pos.page <= 2) { setPos({ page: 1, cursor: null, dir: 'next' }); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    if (pagination.prevCursor) { setPos(p => ({ page: Math.max(1, (p.page || 2) - 1), cursor: pagination.prevCursor, dir: 'prev' })); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  };
  const goToPage = (n: number) => {
    if (n < 1 || n > pagination.maxPage || (n === pos.page && !pos.cursor)) return;
    setPos({ page: n, cursor: null, dir: 'next' });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const shownPage = pos.page;
  const totalPagesAll = Math.max(1, Math.ceil(pagination.total / ITEMS_PER_PAGE));
  const pageNumbers = useMemo(() => {
    const maxJump = pagination.maxPage;
    const out: (number | string)[] = [];
    if (maxJump <= 7) { for (let i = 1; i <= maxJump; i++) out.push(i); return out; }
    out.push(1);
    if (shownPage > 3) out.push('...');
    for (let i = Math.max(2, shownPage - 1); i <= Math.min(maxJump - 1, shownPage + 1); i++) out.push(i);
    if (shownPage < maxJump - 2) out.push('...');
    out.push(maxJump);
    return out;
  }, [pagination.maxPage, shownPage]);

  const toggleSort = () => { setSortOrder(prev => (prev === 'desc' ? 'asc' : 'desc')); setPos({ page: 1, cursor: null, dir: 'next' }); };
  const goToResult = (href: string) => { window.location.href = href; };

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
        if (!ac.signal.aborted) { setSuggestions(Array.isArray(data?.results) ? data.results : []); setShowSuggest(true); setActiveSuggest(-1); }
      } catch {
        if (!ac.signal.aborted) { setSuggestions([]); setShowSuggest(true); }
      } finally {
        if (!ac.signal.aborted) setSuggestLoading(false);
      }
    }, 250);
    return () => { if (suggestTimer.current) clearTimeout(suggestTimer.current); };
  }, [searchQuery]);

  const handleSearch = () => {
    const pick = activeSuggest >= 0 ? suggestions[activeSuggest] : suggestions[0];
    if (pick) { goToResult(pick.href); return; }
    const q = searchQuery.trim();
    if (!q) return;
    if (/^\d+$/.test(q)) goToResult(`/explorer/block/${q}`);
    else if (q.length === 64 && /^[0-9A-Fa-f]+$/.test(q)) goToResult(`/explorer/tx/${q}`);
    else if (q.length >= 38 && q.toLowerCase().includes('eon')) goToResult(`/explorer/address/${q}`);
  };

  const heightLabel = pagination.currentHeight || head.height || 0;

  return (
    <div className="explorer-page">
      <div className="explorer-header">
        <h1>Quantum Blockchain Explorer</h1>
        <p suppressHydrationWarning>
          All transactions from Genesis to Now • Block Height: {heightLabel || '...'}
          {mounted && (
            <span className={`live-dot ${head.connected ? 'on' : 'off'}`} title={head.connected ? 'live' : 'reconnecting'} style={{ marginLeft: 8, display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: head.connected ? '#7CFFB2' : '#7fa8b0', verticalAlign: 'middle' }} />
          )}
        </p>
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
          <div style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0, zIndex: 50, background: 'rgba(8, 20, 28, 0.98)', border: '1px solid rgba(0, 229, 240, 0.35)', borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.55)', overflow: 'hidden', maxHeight: 360, overflowY: 'auto', textAlign: 'left' }}>
            {suggestLoading && suggestions.length === 0 && <div style={{ padding: '12px 16px', color: '#7fa8b0', fontSize: 14 }}>Searching…</div>}
            {!suggestLoading && suggestions.length === 0 && <div style={{ padding: '12px 16px', color: '#7fa8b0', fontSize: 14 }}>Nothing found</div>}
            {suggestions.map((s, i) => (
              <div key={`${s.type}-${s.href}-${i}`} onMouseDown={(e) => { e.preventDefault(); goToResult(s.href); }} onMouseEnter={() => setActiveSuggest(i)}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', cursor: 'pointer', background: i === activeSuggest ? 'rgba(0, 229, 240, 0.12)' : 'transparent', borderTop: i === 0 ? 'none' : '1px solid rgba(255,255,255,0.05)' }}>
                {s.type === 'token' ? (
                  <TokenIcon logo={s.logo} symbol={s.symbol} address={s.address} size={24} />
                ) : (
                  <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 700, padding: '2px 7px', borderRadius: 5, color: '#04141a', flexShrink: 0, background: s.type === 'tx' ? '#8b9dff' : s.type === 'block' ? '#7CFFB2' : '#ffd166' }}>{s.type}</span>
                )}
                <span style={{ color: '#e6f7fa', fontWeight: 600, fontSize: 14 }}>{s.label}</span>
                {s.sublabel && <span style={{ color: '#7fa8b0', fontSize: 12, marginLeft: 'auto', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '55%' }}>{s.sublabel}</span>}
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
                  <button key={type} className={`filter-chip ${typeFilters.includes(type) ? 'active' : ''}`}
                    onClick={() => { setTypeFilters(prev => (prev.includes(type) ? prev.filter(t => t !== type) : [...prev, type])); setPos({ page: 1, cursor: null, dir: 'next' }); }}>
                    {type}
                  </button>
                ))}
              </div>
            </div>
            <span className="tx-count">{pagination.total.toLocaleString('en-US')} transactions</span>
          </div>
        </div>

        <div className="table-wrapper">
          {rows.length === 0 && hasFetched ? (
            <div className="empty-state">
              <p>No transactions found</p>
              <span>{typeFilters.length > 0 ? `No ${typeFilters.join('/')} transactions yet` : 'Waiting for network activity...'}</span>
            </div>
          ) : rows.length === 0 ? (
            <div className="table-placeholder" />
          ) : (
            <table className="activity-table">
              <thead>
                <tr>
                  <th>TRANSACTION</th>
                  <th>TYPE</th>
                  <th>FROM → TO</th>
                  <th style={{ textAlign: 'right' }}>AMOUNT</th>
                  <th className="sortable-header" onClick={toggleSort} title="Click to sort by block height">BLOCK {sortOrder === 'desc' ? '↓' : '↑'}</th>
                  <th>TIME</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((item) => <ActivityRow key={item.hash} item={item} />)}
              </tbody>
            </table>
          )}

          {totalPagesAll > 1 && (
            <div className="pagination-controls">
              <button className="page-btn page-arrow" onClick={goPrev} disabled={(shownPage <= 1 && !pos.cursor) || loading}>←</button>
              {pageNumbers.map((p, idx) => (
                typeof p === 'number'
                  ? <button key={idx} className={`page-btn ${p === shownPage && !pos.cursor ? 'active' : ''}`} onClick={() => goToPage(p)} disabled={loading}>{p}</button>
                  : <span key={idx} className="page-ellipsis">...</span>
              ))}
              <button className="page-btn page-arrow" onClick={goNext} disabled={!pagination.nextCursor || loading}>→</button>
              <span className="page-info">
                Page {shownPage} of {totalPagesAll.toLocaleString('en-US')} ({pagination.total.toLocaleString('en-US')} total)
              </span>
            </div>
          )}

          {totalPagesAll <= 1 && rows.length > 0 && (
            <div className="pagination-info">{pagination.total.toLocaleString('en-US')} transactions</div>
          )}
        </div>
      </div>
    </div>
  );
}
