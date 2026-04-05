'use client';

import { memo, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import Link from 'next/link';
import { batchCache } from '@/lib/explorer-cache';

interface ActivityItem {
  hash: string;
  type: string;
  from: string;
  to: string;
  amount: string;
  block: number;
  time: string;
  timestamp: number;
}

// ============================================================================
// v2.83: Explorer with stable caching - NO double updates
// - Data loads ONCE from API (server has persistent cache)
// - Time field is preserved correctly from server
// - No client-side cache interference causing double renders
// ============================================================================

const CACHE_KEY = 'qnet_explorer_cache_v4';
const CACHE_TTL = 300000;

function getCachedData(): { transactions: Map<string, ActivityItem>, height: number, timestamp: number } | null {
  if (typeof window === 'undefined') return null;
  try {
    const cached = sessionStorage.getItem(CACHE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Date.now() - parsed.timestamp < CACHE_TTL) {
        const txMap = new Map<string, ActivityItem>();
        (parsed.transactions || []).forEach((tx: ActivityItem) => txMap.set(tx.hash, tx));
        return { transactions: txMap, height: parsed.height, timestamp: parsed.timestamp };
      }
    }
  } catch {}
  return null;
}

function saveToCache(transactions: Map<string, ActivityItem>, height: number) {
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({
      transactions: Array.from(transactions.values()),
      height,
      timestamp: Date.now()
    }));
  } catch {}
}

// v2.95.3: Unified type badges
function getBadgeClass(type: string): string {
  const normalized = type.toLowerCase().replace(/\s+/g, '-');
  return `type-${normalized}`;
}

// Calculate relative time CLIENT-SIDE from absolute timestamp
// This ensures time display is always consistent and updates naturally
function formatTimeAgo(timestamp: number, blockHeight?: number): string {
  // Genesis block or genesis transactions (block 0)
  if (blockHeight === 0) return 'Genesis';
  if (!timestamp || timestamp === 0) return 'Genesis';

  const now = Date.now();
  // Handle both seconds and milliseconds timestamps
  const ts = timestamp > 1e12 ? timestamp : timestamp * 1000;

  // If timestamp is before year 2024 (chain launch), treat as Genesis
  // 1704067200000 = 2024-01-01T00:00:00Z
  if (ts < 1704067200000) return 'Genesis';

  const diff = now - ts;

  if (diff < 0) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

const ActivityRow = memo(function ActivityRow({ item }: { item: ActivityItem }) {
  // Calculate relative time from absolute timestamp CLIENT-SIDE
  // This ensures time is STABLE and doesn't flicker on data updates
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
        {item.to && item.to.length > 10 && item.to.includes('eon') ? (
          <Link href={`/explorer/address/${item.to}`} className="addr">
            {item.to.slice(0, 6)}...{item.to.slice(-4)}
          </Link>
        ) : (
          <span className="addr">{item.to || 'N/A'}</span>
        )}
      </td>
      <td className="col-amount">{item.amount}</td>
      <td className="col-block">
        <Link href={`/explorer/block/${item.block}`}>{item.block}</Link>
      </td>
      <td className="col-time">{displayTime}</td>
    </tr>
  );
});

const ITEMS_PER_PAGE = 50;

// All available transaction types for filter
// v2.95.3: Unified types - removed "Validator", added "Contract"
const TX_TYPES = ['Transfer', 'Reward', 'Swap', 'Heartbeat', 'Registration', 'Activation', 'Contract', 'System'];

export default function ExplorerPage() {
  // Initialize state without cache to avoid hydration mismatch
  const [transactionMap, setTransactionMap] = useState<Map<string, ActivityItem>>(new Map());
  const [currentHeight, setCurrentHeight] = useState(0);
  const [loading, setLoading] = useState(true);
  const [hasFetched, setHasFetched] = useState(false); // v2.102: Track if we ever loaded data
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc');
  const [typeFilters, setTypeFilters] = useState<string[]>(['Transfer', 'Reward', 'Swap']); // Default active filters
  const [mounted, setMounted] = useState(false);
  const initialLoadDone = useRef(false);

  // Load cache ONLY on client after mount (fixes hydration)
  useEffect(() => {
    setMounted(true);
    const cached = getCachedData();
    if (cached && cached.transactions.size > 0) {
      setTransactionMap(cached.transactions);
      setCurrentHeight(cached.height);
      setLoading(false);
      setHasFetched(true); // We have data from cache
    }
  }, []);

  // Data comes pre-filtered and sorted from API — just convert to array
  const filteredAndSortedActivity = useMemo(() => {
    return Array.from(transactionMap.values());
  }, [transactionMap]);

  // Fetch activity for specific page
  const fetchActivity = useCallback(async (pageNum: number, forceRefresh: boolean = false) => {
    try {
      setLoading(true);

      const refreshParam = forceRefresh ? '&refresh=1' : '';
      const typeParam = typeFilters.length > 0 && typeFilters.length < TX_TYPES.length
        ? `&types=${encodeURIComponent(typeFilters.join(','))}`
        : '';
      const res = await fetch(`/api/activity?page=${pageNum}&limit=${ITEMS_PER_PAGE}&sort=${sortOrder}${typeParam}${refreshParam}`, {
        cache: 'no-store'
      });
      const data = await res.json();
      
      if (data.success && data.data) {
        const networkHeight = data.pagination?.currentHeight || 0;
        const total = data.pagination?.total || 0;
        const pages = Math.ceil(total / ITEMS_PER_PAGE) || 1;
        
        // Set transactions for current page only
        const newMap = new Map<string, ActivityItem>();
        for (const tx of data.data as ActivityItem[]) {
          if (tx.hash) {
            newMap.set(tx.hash, tx);
          }
        }
        
        setTransactionMap(newMap);
        setCurrentHeight(networkHeight);
        setTotalCount(total);
        setTotalPages(pages);
        saveToCache(newMap, networkHeight);
        
        // v2.101: Pre-cache transactions for instant detail page load
        const txItems = Array.from(newMap.values()).map(tx => ({
          key: tx.hash,
          data: {
            hash: tx.hash,
            type: tx.type,
            status: 'confirmed' as const,
            block: tx.block,
            timestamp: tx.timestamp,
            from: tx.from,
            to: tx.to,
            amount: tx.amount,
          }
        }));
        batchCache('tx', txItems);
      }
    } catch (err) {
      /* log disabled */
    } finally {
      setLoading(false);
      setHasFetched(true);
    }
  }, [typeFilters, sortOrder]);

  // Initial fetch after mount
  useEffect(() => {
    if (mounted && !initialLoadDone.current) {
      initialLoadDone.current = true;
      fetchActivity(1);
    }
  }, [mounted, fetchActivity]);

  // Fetch when page, filters, or sort changes
  useEffect(() => {
    if (mounted && initialLoadDone.current) {
      fetchActivity(page);
    }
  }, [page, typeFilters, sortOrder, mounted, fetchActivity]);

  // Background refresh transactions every 5 seconds (only if on page 1)
  useEffect(() => {
    if (!mounted || page !== 1) return;
    const interval = setInterval(() => fetchActivity(1), 5000);
    return () => clearInterval(interval);
  }, [mounted, page, fetchActivity]);

  // Real-time height update every 1 second (lightweight stats endpoint)
  useEffect(() => {
    if (!mounted) return;
    const fetchHeight = async () => {
      try {
        const res = await fetch(`/api/network/stats?t=${Date.now()}`, { cache: 'no-store' });
        const data = await res.json();
        if (data.success && data.data?.height) {
          setCurrentHeight(data.data.height);
        }
      } catch {}
    };
    const interval = setInterval(fetchHeight, 5000);
    return () => clearInterval(interval);
  }, [mounted]);

  const goToPage = (newPage: number) => {
    if (newPage >= 1 && newPage <= totalPages && newPage !== page) {
      setPage(newPage);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  // Generate page numbers to display
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

  // Toggle sort — triggers server-side re-fetch via useEffect
  const toggleSort = () => {
    setSortOrder(prev => prev === 'desc' ? 'asc' : 'desc');
    setPage(1);
  };

  const handleSearch = () => {
    if (!searchQuery.trim()) return;
    const q = searchQuery.trim();
    
    if (q.length === 64 && /^[0-9A-Fa-f]+$/.test(q)) {
      window.location.href = `/explorer/tx/${q}`;
    } else if (q.length >= 38 && q.includes('eon')) {
      window.location.href = `/explorer/address/${q}`;
    } else if (/^\d+$/.test(q)) {
      window.location.href = `/explorer/block/${q}`;
    } else if (q.startsWith('genesis') || q.startsWith('system') || q.startsWith('qnet_')) {
      window.location.href = `/explorer/tx/${q}`;
    } else {
      window.location.href = `/explorer/tx/${q}`;
    }
  };

  return (
    <div className="explorer-page">
      <div className="explorer-header">
        <h1>Quantum Blockchain Explorer</h1>
        {/* Show height only after mount to avoid hydration mismatch */}
        <p>All transactions from Genesis to Now • Block Height: {mounted ? (currentHeight || '...') : '...'}</p>
      </div>

      <div className="explorer-search">
        <input
          type="text"
          placeholder="Search by TX hash, block number, or EON address..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
        />
        <button className="search-btn" type="button" onClick={handleSearch}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="11" cy="11" r="7" stroke="#00e5f0" strokeWidth="2"/>
            <path d="M16.5 16.5L21 21" stroke="#00e5f0" strokeWidth="2" strokeLinecap="round"/>
          </svg>
        </button>
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
