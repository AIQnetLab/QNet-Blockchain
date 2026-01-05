'use client';

import { memo, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import Link from 'next/link';

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

function getBadgeClass(type: string): string {
  const classes: Record<string, string> = {
    'Transfer': 'badge-transfer',
    'Swap': 'badge-swap',
    'Node Activation': 'badge-activation',
    'Reward': 'badge-reward',
    'Smart Contract': 'badge-contract',
    'System': 'badge-system',
    'Registration': 'badge-registration',
  };
  return classes[type] || 'badge-default';
}

// Calculate relative time CLIENT-SIDE from absolute timestamp
// This ensures time display is always consistent and updates naturally
function formatTimeAgo(timestamp: number): string {
  if (!timestamp || timestamp === 0) return 'Genesis';
  
  const now = Date.now();
  // Handle both seconds and milliseconds timestamps
  const ts = timestamp > 1e12 ? timestamp : timestamp * 1000;
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
  const displayTime = formatTimeAgo(item.timestamp);
  
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
        <Link href={`/explorer/address/${item.from}`} className="addr">
          {item.from.slice(0, 6)}...{item.from.slice(-4)}
        </Link>
        <span className="arr">→</span>
        <Link href={`/explorer/address/${item.to}`} className="addr">
          {item.to.slice(0, 6)}...{item.to.slice(-4)}
        </Link>
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
const TX_TYPES = ['All', 'Transfer', 'Reward', 'Registration', 'Node Activation', 'Smart Contract', 'System', 'Swap'];

export default function ExplorerPage() {
  // Initialize state without cache to avoid hydration mismatch
  const [transactionMap, setTransactionMap] = useState<Map<string, ActivityItem>>(new Map());
  const [currentHeight, setCurrentHeight] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc');
  const [typeFilter, setTypeFilter] = useState('All');
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
    }
  }, []);

  // Filter and sort locally
  const filteredAndSortedActivity = useMemo(() => {
    let items = Array.from(transactionMap.values());
    
    // Filter by type
    if (typeFilter !== 'All') {
      items = items.filter(tx => tx.type === typeFilter);
    }
    
    // Sort by TIME (timestamp)
    const sorted = [...items].sort((a, b) => {
      // Convert to number (handle both number and string timestamps)
      let tsA = typeof a.timestamp === 'number' ? a.timestamp : Number(a.timestamp) || 0;
      let tsB = typeof b.timestamp === 'number' ? b.timestamp : Number(b.timestamp) || 0;
      
      // Normalize to milliseconds: if timestamp < 1e12, it's in seconds
      if (tsA > 0 && tsA < 1e12) {
        tsA = tsA * 1000;
      }
      if (tsB > 0 && tsB < 1e12) {
        tsB = tsB * 1000;
      }
      
      return sortOrder === 'desc' ? (tsB - tsA) : (tsA - tsB);
    });
    
    return sorted;
  }, [transactionMap, sortOrder, typeFilter]);

  // Fetch activity - STABLE: preserves good data, only adds/updates
  const fetchActivity = useCallback(async (pageNum: number, isLoadMore: boolean = false, forceRefresh: boolean = false) => {
    try {
      if (isLoadMore) setLoadingMore(true);
      // Only show loading on very first load (no data at all)
      else if (transactionMap.size === 0) setLoading(true);
      
      const refreshParam = forceRefresh ? '&refresh=1' : '';
      const res = await fetch(`/api/activity?page=${pageNum}&limit=${ITEMS_PER_PAGE}&sort=desc${refreshParam}`, {
        cache: 'no-store'
      });
      const data = await res.json();
      
      if (data.success && data.data) {
        const networkHeight = data.pagination?.currentHeight || 0;
        
        // Detect blockchain reset: network height < our cached height
        if (networkHeight > 0 && networkHeight < currentHeight) {
          console.log(`[Explorer] Blockchain reset detected! Network ${networkHeight} < cached ${currentHeight}. Clearing cache.`);
          sessionStorage.removeItem(CACHE_KEY);
          setTransactionMap(new Map());
          setCurrentHeight(networkHeight);
        }
        
        if (data.data.length > 0) {
          setTransactionMap(prev => {
            // If blockchain was reset, start fresh
            const newMap = (networkHeight > 0 && networkHeight < currentHeight) ? new Map() : new Map(prev);
            let addedCount = 0;
            let updatedCount = 0;
            
            for (const tx of data.data as ActivityItem[]) {
              if (!tx.hash) continue;
              
              const existing = newMap.get(tx.hash);
              if (!existing) {
                // New transaction - add it
                newMap.set(tx.hash, tx);
                addedCount++;
              } else {
                // Existing transaction - merge carefully
                // CRITICAL: Preserve good timestamp, don't replace with bad one
                const mergedTx: ActivityItem = { ...tx };
                
                // If existing has good timestamp but new doesn't, keep existing
                if (existing.timestamp > 0 && (!tx.timestamp || tx.timestamp === 0)) {
                  mergedTx.timestamp = existing.timestamp;
                  mergedTx.time = existing.time;
                }
                
                // Only update if there's actually something better
                if (mergedTx.timestamp !== existing.timestamp || 
                    mergedTx.block !== existing.block) {
                  newMap.set(tx.hash, mergedTx);
                  updatedCount++;
                }
              }
            }
            
            if (addedCount > 0 || updatedCount > 0) {
              console.log(`[Explorer] Page ${pageNum}: +${addedCount} new, ~${updatedCount} updated`);
              saveToCache(newMap, networkHeight || currentHeight);
            }
            return newMap;
          });
        }
        
        if (networkHeight) {
          setCurrentHeight(networkHeight);
        }
        setHasMore(data.pagination?.hasMore ?? false);
      }
    } catch (err) {
      console.error('[Explorer] Fetch error:', err);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [transactionMap.size, currentHeight]);

  // Initial fetch after mount
  useEffect(() => {
    if (mounted && !initialLoadDone.current) {
      initialLoadDone.current = true;
      fetchActivity(1);
    }
  }, [mounted, fetchActivity]);

  // Background refresh every 10 seconds
  useEffect(() => {
    if (!mounted) return;
    const interval = setInterval(() => fetchActivity(1), 10000);
    return () => clearInterval(interval);
  }, [mounted, fetchActivity]);

  const loadMore = () => {
    if (!hasMore || loadingMore) return;
    const nextPage = page + 1;
    setPage(nextPage);
    fetchActivity(nextPage, true);
  };

  // Toggle sort by clicking TIME header
  const toggleSort = () => {
    setSortOrder(prev => prev === 'desc' ? 'asc' : 'desc');
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
            <select 
              className="type-filter"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
            >
              {TX_TYPES.map(type => (
                <option key={type} value={type}>{type}</option>
              ))}
            </select>
            <span className="tx-count">
              {filteredAndSortedActivity.length} transactions
              {typeFilter !== 'All' && ` (${typeFilter})`}
            </span>
          </div>
        </div>
        
        <div className="table-wrapper">
          {loading && filteredAndSortedActivity.length === 0 ? (
            <div className="loading-state">Loading transactions...</div>
          ) : filteredAndSortedActivity.length === 0 ? (
            <div className="empty-state">
              <p>No transactions found</p>
              <span>{typeFilter !== 'All' ? `No ${typeFilter} transactions yet` : 'Waiting for network activity...'}</span>
            </div>
          ) : (
            <table className="activity-table">
              <thead>
                <tr>
                  <th>TRANSACTION</th>
                  <th>TYPE</th>
                  <th>FROM → TO</th>
                  <th>AMOUNT</th>
                  <th>BLOCK</th>
                  <th 
                    className="sortable-header"
                    onClick={toggleSort}
                    title="Click to sort"
                  >
                    TIME {sortOrder === 'desc' ? '↓' : '↑'}
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredAndSortedActivity.map((item, idx) => (
                  <ActivityRow key={`${item.hash}-${idx}`} item={item} />
                ))}
              </tbody>
            </table>
          )}
        </div>
        
        {hasMore && typeFilter === 'All' && (
          <div className="load-more">
            <button 
              onClick={loadMore}
              disabled={loadingMore}
              className="load-more-btn"
            >
              {loadingMore ? 'Loading...' : `Load More Transactions`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
