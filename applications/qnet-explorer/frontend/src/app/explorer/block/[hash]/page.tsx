'use client';

import React, { useState, useCallback, useEffect } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { Block, BlockTransaction, HeartbeatEntry } from '@/lib/types';
import { getCache, setCache, isCacheStale } from '@/lib/explorer-cache';

// Helper to truncate
const truncate = (str: string, start = 8, end = 6): string => {
  if (!str || str.length <= start + end + 3) return str || '';
  return `${str.slice(0, start)}...${str.slice(-end)}`;
};

// Format amount from nanoQNC to QNC
const formatAmount = (nanoQNC: string): string => {
  const num = BigInt(nanoQNC);
  const qnc = Number(num) / 1e9;
  return qnc.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 }) + ' QNC';
};

// Format timestamp
const formatTime = (ts: number | string | undefined): string => {
  // Ensure ts is a valid number (PostgreSQL BIGINT may come as string)
  const timestamp = Number(ts);
  if (!timestamp || !Number.isFinite(timestamp) || timestamp <= 0) {
    return 'Genesis Block';
  }
  // Convert to milliseconds if in seconds
  const ms = timestamp > 1e12 ? timestamp : timestamp * 1000;
  const date = new Date(ms);
  if (isNaN(date.getTime())) {
    return 'Invalid Date';
  }
  return date.toUTCString();
};

// Copy button (Keeta style)
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

export default function BlockPage() {
  const params = useParams();
  const hash = params.hash as string;
  
  // v2.102: Sync cache read for instant display
  const cachedBlock = hash ? getCache<Block>('block', hash) : null;
  
  const [block, setBlock] = useState<Block | null>(cachedBlock);
  const [error, setError] = useState<string | null>(null);
  const [hasFetched, setHasFetched] = useState(!!cachedBlock); // true if we have cache
  const [showValidators, setShowValidators] = useState(false);
  const [showRelated, setShowRelated] = useState(false);
  
  useEffect(() => {
    if (!hash) return;
    
    // If we have fresh cache, skip fetch
    if (cachedBlock && !isCacheStale('block', hash)) {
      setHasFetched(true);
      return;
    }
    
    const fetchBlock = async () => {
      try {
        const res = await fetch(`/api/blocks/${hash}`);
        const data = await res.json();
        
        if (data.success && data.data) {
          setBlock(data.data);
          setCache('block', hash, data.data);
          setError(null);
        } else {
          setError(data.error || 'Block not found');
        }
      } catch {
        setError('Failed to load block');
      } finally {
        setHasFetched(true);
      }
    };
    
    fetchBlock();
  }, [hash, cachedBlock]);
  
  // Show error ONLY after fetch attempt
  if (hasFetched && (error || !block)) {
    return (
      <div className="block-page">
        <div className="error-state">{error || 'Block not found'}</div>
      </div>
    );
  }
  
  // Still loading - show empty shell (no flicker)
  if (!block) {
    return <div className="block-page" />;
  }
  
  const isMacro = block.block_type === 'MACROBLOCK';
  
  return (
    <div className="block-page">
      {/* Header */}
      <div className="block-header">
        <div className="block-header-top">
          <span className={`block-label ${isMacro ? 'macro' : 'micro'}`}>
            # {block.block_type}
          </span>
        </div>
        <div className="block-hash-display">
          <h1>{block.hash}</h1>
        </div>
        <div className="block-timestamp">{formatTime(block.timestamp)}</div>
      </div>

      {/* Details */}
      <div className="block-card">
        <h2 className="card-title">Details</h2>
        <div className="details-grid">
          <div className="detail-row">
            <span className="detail-label">Height</span>
            <span className="detail-value">{block.height.toLocaleString()}</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Type</span>
            <span className="detail-value">{block.block_type}</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Version</span>
            <span className="detail-value">{block.version || 1}</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Producer</span>
            <span className="detail-value">{block.producer}</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Transactions</span>
            <span className="detail-value">{block.tx_count}</span>
          </div>
          {block.total_gas_used !== undefined && block.total_gas_used > 0 && (
            <div className="detail-row">
              <span className="detail-label">Gas Used</span>
              <span className="detail-value">{block.total_gas_used.toLocaleString()}</span>
            </div>
          )}
          {block.size_bytes !== undefined && block.size_bytes > 0 && (
            <div className="detail-row">
              <span className="detail-label">Block Size</span>
              <span className="detail-value">{(block.size_bytes / 1024).toFixed(2)} KB</span>
            </div>
          )}
          <div className="detail-row">
            <span className="detail-label">Previous Hash</span>
            <span className="detail-value">
              {block.height > 0 ? (
                <>
                  <Link href={`/explorer/block/${block.height - 1}`} className="address-link">
                    {truncate(block.previous_hash)}
                  </Link>
                  <CopyBtn text={block.previous_hash} />
                </>
              ) : (
                <span className="mono">Genesis Block</span>
              )}
            </span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Merkle Root</span>
            <span className="detail-value mono">
              {truncate(block.merkle_root, 12, 12)}
              <CopyBtn text={block.merkle_root} />
            </span>
          </div>
          {block.state_root && (
            <div className="detail-row">
              <span className="detail-label">State Root</span>
              <span className="detail-value mono">
                {truncate(block.state_root, 12, 12)}
                <CopyBtn text={block.state_root} />
              </span>
            </div>
          )}
          {block.poh_hash && (
            <div className="detail-row">
              <span className="detail-label">VTS Hash</span>
              <span className="detail-value mono">
                {truncate(block.poh_hash, 12, 12)}
                <CopyBtn text={block.poh_hash} />
              </span>
            </div>
          )}
          <div className="detail-row">
            <span className="detail-label">VTS Counter</span>
            <span className="detail-value">{block.poh_count.toLocaleString()}</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Signature Type</span>
            <span className="detail-value">{block.signature_type}</span>
          </div>
          {block.signature && (
            <div className="detail-row">
              <span className="detail-label">Signature</span>
              <span className="detail-value mono">
                {truncate(block.signature, 16, 16)}
                <CopyBtn text={block.signature} />
              </span>
            </div>
          )}
          {block.cert_serial && (
            <div className="detail-row">
              <span className="detail-label">Certificate</span>
              <span className="detail-value mono">{block.cert_serial}</span>
            </div>
          )}
          {block.qrb_output && (
            <div className="detail-row">
              <span className="detail-label">QRB Output</span>
              <span className="detail-value mono">
                {truncate(block.qrb_output, 16, 16)}
                <CopyBtn text={block.qrb_output} />
              </span>
            </div>
          )}
        </div>
      </div>

      {/* MacroBlock Consensus Data */}
      {isMacro && block.consensus_data && (
        <div className="block-card">
          <h2 className="card-title">Consensus Data (Emission Window)</h2>
          <div className="details-grid">
            <div className="detail-row">
              <span className="detail-label">Commits</span>
              <span className="detail-value">{block.consensus_data.commits_count}</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Reveals</span>
              <span className="detail-value">{block.consensus_data.reveals_count}</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Next Leader</span>
              <span className="detail-value">{block.consensus_data.next_leader}</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Eligible Nodes</span>
              <span className="detail-value">{block.consensus_data.eligible_nodes_count}</span>
            </div>
            {block.consensus_data.pool2_total_fees !== undefined && (
              <div className="detail-row highlight">
                <span className="detail-label">Pool 2 Fees</span>
                <span className="detail-value">{formatAmount(block.consensus_data.pool2_total_fees.toString())}</span>
              </div>
            )}
            {block.consensus_data.pool3_total_activations !== undefined && (
              <div className="detail-row highlight">
                <span className="detail-label">Pool 3 Activations</span>
                <span className="detail-value">{formatAmount(block.consensus_data.pool3_total_activations.toString())}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Transactions */}
      <div className="block-card">
        <h2 className="card-title">Transactions ({block.transactions.length})</h2>
        <table className="block-table">
          <thead>
            <tr>
              <th>Hash</th>
              <th>Type</th>
              <th>From → To</th>
              <th>Amount</th>
            </tr>
          </thead>
          <tbody>
            {block.transactions.map((tx, idx) => (
              <tr key={idx}>
                <td>
                  {tx.hash ? (
                    <Link href={`/explorer/tx/${tx.hash}`} className="address-link">
                      {truncate(tx.hash, 6, 4)}
                    </Link>
                  ) : (
                    <span className="mono">{idx + 1}</span>
                  )}
                </td>
                <td>
                  <span className={`type-badge type-${tx.type.toLowerCase()}`}>{tx.type}</span>
                </td>
                <td>
                  {tx.from && tx.from.length > 10 && tx.from.includes('eon') ? (
                    <Link href={`/explorer/address/${tx.from}`} className="address-link">
                      {truncate(tx.from, 6, 4)}
                    </Link>
                  ) : (
                    <span className="address-link">{tx.from || 'N/A'}</span>
                  )}
                  <span className="tx-arrow">→</span>
                  {tx.to && tx.to.length > 10 && tx.to.includes('eon') ? (
                    <Link href={`/explorer/address/${tx.to}`} className="address-link">
                      {truncate(tx.to, 6, 4)}
                    </Link>
                  ) : (
                    <span className="address-link">{tx.to || 'N/A'}</span>
                  )}
                </td>
                <td>{formatAmount(tx.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Validators (MacroBlock) */}
      {isMacro && block.consensus_data?.heartbeat_entries && block.consensus_data.heartbeat_entries.length > 0 && (
        <div className="block-card collapsible">
          <div className="card-header-collapsible" onClick={() => setShowValidators(!showValidators)}>
            <h2 className="card-title">Validators ({block.consensus_data.heartbeat_entries.length})</h2>
            <span className={`collapse-icon ${showValidators ? 'open' : ''}`}>▼</span>
          </div>
          {showValidators && (
            <table className="block-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Node</th>
                  <th>Address</th>
                  <th>Type</th>
                  <th>Reputation</th>
                </tr>
              </thead>
              <tbody>
                {block.consensus_data.heartbeat_entries.map((entry, idx) => (
                  <tr key={idx}>
                    <td>{formatTime(entry.timestamp)}</td>
                    <td>{entry.node_id}</td>
                    <td>
                      <Link href={`/explorer/address/${entry.node_address}`} className="address-link">
                        {truncate(entry.node_address, 6, 4)}
                      </Link>
                    </td>
                    <td>
                      <span className={`node-type-badge ${entry.node_type.toLowerCase()}`}>
                        {entry.node_type}
                      </span>
                    </td>
                    <td>{entry.reputation}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Related Microblocks (MacroBlock) */}
      {isMacro && block.micro_blocks && block.micro_blocks.length > 0 && (
        <div className="block-card collapsible">
          <div className="card-header-collapsible" onClick={() => setShowRelated(!showRelated)}>
            <h2 className="card-title">Included Microblocks ({block.micro_blocks.length})</h2>
            <span className={`collapse-icon ${showRelated ? 'open' : ''}`}>▼</span>
          </div>
          {showRelated && (
            <div className="related-blocks-list">
              {block.micro_blocks.map((mbHash, idx) => (
                <div key={idx} className="related-block-row">
                  <span className="related-label">#{idx + 1}</span>
                  <Link href={`/explorer/block/${mbHash}`} className="block-link">
                    {truncate(mbHash, 12, 12)}
                  </Link>
                  <CopyBtn text={mbHash} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

