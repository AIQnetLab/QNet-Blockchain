'use client';

import { memo, useState, useEffect } from 'react';
import Link from 'next/link';

interface ActivityItem {
  hash: string;
  type: string;
  from: string;
  to: string;
  amount: string;
  block: number;
  time: string;
}

// Memoized row for performance
const ActivityRow = memo(function ActivityRow({ item }: { item: ActivityItem }) {
  const badgeClass = {
    'Transfer': 'badge-transfer',
    'Swap': 'badge-swap',
    'Node Activation': 'badge-activation',
    'Reward': 'badge-reward',
    'Smart Contract': 'badge-contract',
  }[item.type] || 'badge-default';

  return (
    <tr className="activity-row">
      <td className="col-hash">
        <Link href={`/explorer/tx/${item.hash}`} className="addr">
          {item.hash.slice(0, 8)}...{item.hash.slice(-6)}
        </Link>
        <span className={`type-badge ${badgeClass}`}>{item.type}</span>
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
      <td className="col-time">{item.time}</td>
    </tr>
  );
});

const ITEMS_PER_PAGE = 10;

export default function ExplorerPage() {
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(1);

  // Fetch activity on mount and every 5 seconds
  useEffect(() => {
    const fetchActivity = async () => {
      try {
        const res = await fetch('/api/activity?limit=50');
        const data = await res.json();
        if (data.success && data.data) {
          setActivity(data.data);
        }
      } catch (err) {
        console.error('Failed to fetch activity:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchActivity();
    const interval = setInterval(fetchActivity, 5000);
    return () => clearInterval(interval);
  }, []);
  
  const totalPages = Math.ceil(activity.length / ITEMS_PER_PAGE);
  const paginatedActivity = activity.slice((page - 1) * ITEMS_PER_PAGE, page * ITEMS_PER_PAGE);

  // Handle search
  const handleSearch = () => {
    if (!searchQuery.trim()) return;
    
    const q = searchQuery.trim();
    
    // Detect type and redirect
    if (q.length === 64 && /^[0-9A-Fa-f]+$/.test(q)) {
      // 64 hex chars = block hash or tx hash
      window.location.href = `/explorer/block/${q}`;
    } else if (q.length === 41 && q.includes('eon')) {
      // EON address
      window.location.href = `/explorer/address/${q}`;
    } else if (/^\d+$/.test(q)) {
      // Block number
      window.location.href = `/explorer/block/${q}`;
    } else {
      // General search
      window.location.href = `/explorer/search?q=${encodeURIComponent(q)}`;
    }
  };

  return (
    <div className="explorer-page">
      <div className="explorer-header">
        <h1>Quantum Blockchain Explorer</h1>
        <p>Real-time network data and blockchain analytics</p>
      </div>

      <div className="explorer-search">
        <input
          type="text"
          placeholder="Search transactions, blocks, or addresses..."
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
          <h2>Latest Activity</h2>
        </div>
        
        <div className="table-wrapper">
          {loading ? (
            <div className="loading-state">Loading...</div>
          ) : activity.length === 0 ? (
            <div className="empty-state">
              <p>No transactions yet</p>
              <span>Waiting for network activity...</span>
            </div>
          ) : (
            <table className="activity-table">
              <thead>
                <tr>
                  <th>Transaction</th>
                  <th>From → To</th>
                  <th>Amount</th>
                  <th>Block</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {paginatedActivity.map((item) => (
                  <ActivityRow key={item.hash} item={item} />
                ))}
              </tbody>
            </table>
          )}
        </div>
        
        {totalPages > 1 && (
          <div className="pagination">
            <button 
              onClick={() => setPage(p => Math.max(1, p - 1))} 
              disabled={page === 1}
              className="page-btn"
            >
              ← Prev
            </button>
            <span className="page-info">Page {page} of {totalPages}</span>
            <button 
              onClick={() => setPage(p => Math.min(totalPages, p + 1))} 
              disabled={page === totalPages}
              className="page-btn"
            >
              Next →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
