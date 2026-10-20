'use client';

// The explorer (B-SPEC 6.2): the title band with the search and the readouts, the Latest blocks strip, then All
// transactions across the full width, the page's main content. First paint comes from the server's head snapshot; the
// head stream keeps it live with no timers: the readouts and the blocks follow each head, the first page of
// transactions is read again at most every 1.5 s, other pages move by cursor and numbered jumps stay within the offset
// cap. Each part renders again only for its own data.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import ExplorerSearch from '@/components/explorer/ExplorerSearch';
import OnHead from '@/components/explorer/OnHead';
import LatestBlocks from '@/components/explorer/LatestBlocks';
import NetworkReadouts, { type HeadFacts } from '@/components/explorer/NetworkReadouts';
import { TxAmount } from '@/components/explorer/cells';
import { amountCol, blockCol, fromToCol, hashCol, timeCol, typeCol } from '@/components/explorer/columns';
import Action from '@/components/ui/Action';
import DataTable, { type Column } from '@/components/ui/DataTable';
import PageHead from '@/components/ui/PageHead';
import Pager from '@/components/ui/Pager';
import { useActivationContent, useWallet } from '@/contexts/AppContext';
import { batchCache, getListCache, noteChainHeight, setListCache } from '@/lib/explorer-cache';
import { emptyListText, listSummary, rowAmount, type RecentBlock } from '@/lib/explorer-view';
import { txTypeLabel } from '@/lib/tx-labels';

// A row of /api/activity (src/lib/enrich-activity.ts): amounts raw, written exactly by rowAmount.
interface ActivityItem {
  hash: string;
  type: string;
  from: string;
  to: string;
  amount_raw: string;
  block: number;
  txIndex?: number;
  timestamp: number;
  tokenContract?: string;
  tokenSymbol?: string;
  tokenLogo?: string;
  tokenAmountRaw?: string;
  tokenDecimals?: number;
}

export interface ExplorerInitial extends HeadFacts {
  rows: ActivityItem[];
  total: number;
  hash: string | null;
}

interface Pagination {
  total: number;
  nextCursor: string | null;
  prevCursor: string | null;
  maxPage: number;
}

interface Position {
  page: number;
  cursor: string | null;
  dir: 'next' | 'prev';
}

const ITEMS_PER_PAGE = 50;
const TX_TYPES = ['Transfer', 'Reward', 'Swap', 'Heartbeat', 'Light Eligibility', 'Registration', 'Activation', 'Contract', 'System'];
const LIVE_REFRESH_MIN_MS = 1500;
const FIRST: Position = { page: 1, cursor: null, dir: 'next' };

// The transaction page starts from a listed row: the QNC it moved, raw like the page's own read (a token row's
// amount waits for that read, which carries the call).
const cacheRows = (rows: ActivityItem[]) => batchCache('tx', rows.map((tx) => ({
  key: tx.hash, data: { hash: tx.hash, type: tx.type, status: 'confirmed' as const, block: tx.block, timestamp: tx.timestamp, from: tx.from, to: tx.to, amount_raw: tx.amount_raw },
})));

// The list's columns, the loading page's too. Fixed columns of 657 px; From / To takes the rest of the width, its sides
// as whole as the cell allows. `block` is the Block header's sort control and the order it shows.
export function listColumns(full: boolean, block?: { header: ReactNode; sort: 'ascending' | 'descending' }): Column<ActivityItem>[] {
  return [
    hashCol<ActivityItem>((r) => r.hash),
    typeCol<ActivityItem>((r) => r.type, full),
    fromToCol<ActivityItem>((r) => r.from, (r) => r.to, full),
    amountCol<ActivityItem>((r) => <TxAmount parts={rowAmount(r)} logo={r.tokenLogo} />),
    { ...blockCol<ActivityItem>((r) => r.block, 92), ...block },
    timeCol<ActivityItem>((r) => r.timestamp, 72),
  ];
}

function Transactions({ initial }: { initial: ExplorerInitial }) {
  const full = useActivationContent();
  const { providerStatus } = useWallet();
  const [rows, setRows] = useState<ActivityItem[] | null>(initial.rows.length > 0 ? initial.rows : null);
  const [pagination, setPagination] = useState<Pagination>({
    total: initial.total, nextCursor: null, prevCursor: null, maxPage: Math.max(1, Math.min(200, Math.ceil(initial.total / ITEMS_PER_PAGE))),
  });
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc');
  const [typeFilters, setTypeFilters] = useState<string[]>([]);
  const [pos, setPos] = useState<Position>(FIRST);
  const fetchSeq = useRef(0);
  const settled = useRef(false);
  const section = useRef<HTMLElement>(null);

  useEffect(() => {
    if (initial.rows.length === 0) return;
    setListCache('desc||1', initial.rows, initial.total, initial.height);
    noteChainHeight(initial.height);
    cacheRows(initial.rows);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const isLiveView = pos.page === 1 && pos.cursor === null && sortOrder === 'desc' && typeFilters.length === 0;

  const fetchList = useCallback(async (target: Position, silent: boolean) => {
    const seq = ++fetchSeq.current;
    const filterKey = [...typeFilters].sort().join(',');
    const cacheKey = `${sortOrder}|${filterKey}|${target.cursor ?? `p${target.page}`}`;
    const cached = !silent ? getListCache(cacheKey) : null;
    if (cached) {
      setRows(cached.data as ActivityItem[]);
      setPagination((p) => ({ ...p, total: cached.total }));
    } else if (!silent) {
      setLoading(true);
    }
    try {
      const params = new URLSearchParams({ limit: String(ITEMS_PER_PAGE), sort: sortOrder });
      if (typeFilters.length > 0 && typeFilters.length < TX_TYPES.length) params.set('types', typeFilters.join(','));
      if (target.cursor) {
        params.set('cursor', target.cursor);
        params.set('dir', target.dir);
      } else if (target.page > 1) params.set('page', String(target.page));
      const res = await fetch(`/api/activity?${params.toString()}`, { cache: 'no-store' });
      const data = await res.json();
      if (seq !== fetchSeq.current) return;
      if (!data.success || !Array.isArray(data.data)) throw new Error(data.error || 'list read failed');
      const pg = data.pagination || {};
      noteChainHeight(pg.currentHeight || 0);
      setRows(data.data as ActivityItem[]);
      setPagination({ total: pg.total || 0, nextCursor: pg.nextCursor ?? null, prevCursor: pg.prevCursor ?? null, maxPage: pg.maxPage || 1 });
      setListCache(cacheKey, data.data, pg.total || 0, pg.currentHeight || 0);
      cacheRows(data.data as ActivityItem[]);
      setFailed(false);
    } catch {
      // What is shown stays; the line above the table says the read failed.
      if (seq === fetchSeq.current) {
        setFailed(true);
        setRows((r) => r ?? []);
      }
    } finally {
      if (seq === fetchSeq.current) setLoading(false);
    }
  }, [sortOrder, typeFilters]);

  // Position, sort or filter changed: read that page. The first render shows the server's page as it is, unless the
  // server had none.
  useEffect(() => {
    if (!settled.current) {
      settled.current = true;
      if (initial.rows.length > 0) return;
    }
    const t = setTimeout(() => void fetchList(pos, false), rows === null ? 0 : 150);
    return () => clearTimeout(t);
  }, [pos, sortOrder, typeFilters, fetchList]); // eslint-disable-line react-hooks/exhaustive-deps

  // A new head: the live first page is read again (at most every 1.5 s); another page keeps what it shows.
  const onHead = useCallback(() => {
    if (isLiveView) void fetchList(FIRST, true);
  }, [isLiveView, fetchList]);

  // A new page starts at the list's top, scrolled there only when the reader is below it.
  const move = (next: Position) => {
    setPos(next);
    const el = section.current;
    if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView({ block: 'start' });
  };
  const onPage = (n: number) => {
    if (n === pos.page + 1 && pagination.nextCursor) return move({ page: n, cursor: pagination.nextCursor, dir: 'next' });
    if (n === pos.page - 1) {
      if (n <= 1) return move(FIRST);
      if (pagination.prevCursor) return move({ page: n, cursor: pagination.prevCursor, dir: 'prev' });
    }
    if (n >= 1 && n <= pagination.maxPage && !(n === pos.page && !pos.cursor)) move({ page: n, cursor: null, dir: 'next' });
  };
  const toggleType = (type: string | null) => {
    setTypeFilters((prev) => (type === null ? [] : prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]));
    setPos(FIRST);
  };
  const toggleSort = () => {
    setSortOrder((prev) => (prev === 'desc' ? 'asc' : 'desc'));
    setPos(FIRST);
  };

  const labels = typeFilters.map((type) => txTypeLabel(type, full));
  // The order in words is the list's datum ("· oldest first") and the sort button's name.
  const columns = useMemo(() => listColumns(full, {
    sort: sortOrder === 'desc' ? 'descending' : 'ascending',
    header: (
      <button type="button" className="ex-sort" onClick={toggleSort} aria-label={sortOrder === 'desc' ? 'Block, newest first. Show the oldest first' : 'Block, oldest first. Show the newest first'}>
        Block
      </button>
    ),
  }), [full, sortOrder]); // eslint-disable-line react-hooks/exhaustive-deps

  const filters = (
    // The app's view names reward and activation by what they change (src/lib/tx-labels.ts): until the wallet check ends
    // the names are laid out but not shown, as the header's links are, and then each name is its own width.
    <div className="ex-filters" role="group" aria-label="Filter by type" data-pending={providerStatus === 'detecting' || undefined}>
      <button type="button" className="ex-filter" aria-pressed={typeFilters.length === 0} onClick={() => toggleType(null)}>All</button>
      {TX_TYPES.map((type) => (
        <button key={type} type="button" className="ex-filter" aria-pressed={typeFilters.includes(type)} onClick={() => toggleType(type)}>
          {txTypeLabel(type, full)}
        </button>
      ))}
    </div>
  );

  const retry = <Action kind="act" onClick={() => void fetchList(pos, false)}>Try again</Action>;
  const error = failed && rows && rows.length > 0
    ? (isLiveView ? 'Could not read the latest transactions. Trying again with the next block.' : <>Could not read this page. {retry}</>)
    : null;
  const empty = failed ? <>Could not read the transactions. {retry}</> : emptyListText(labels);
  const pages = Math.max(1, Math.ceil(pagination.total / ITEMS_PER_PAGE));

  // The table renders again only when its own data changes, never for a head that brings nothing to it.
  const table = useMemo(() => (
    <DataTable
      className="ex-txs-tbl"
      title="All transactions"
      caption={`All transactions, ${sortOrder === 'desc' ? 'newest' : 'oldest'} first`}
      meta={isLiveView ? undefined : <span className="label">{listSummary(labels, sortOrder === 'asc', pos.page)}</span>}
      tools={filters}
      columns={columns}
      rows={rows}
      rowKey={(r) => r.hash}
      live={isLiveView}
      loadingRows={ITEMS_PER_PAGE}
      empty={empty}
      error={error}
    />
  ), [rows, columns, isLiveView, failed, typeFilters, sortOrder, pos, full, fetchList]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section ref={section} className="ex-txs" aria-busy={loading || undefined}>
      <OnHead every={LIVE_REFRESH_MIN_MS} onHead={onHead} />
      {table}
      {pagination.total > 0 && <Pager page={pos.page} pages={pages} total={pagination.total} onPage={onPage} maxJump={pagination.maxPage} />}
    </section>
  );
}

export default function ExplorerClient({ initial, blocks, blocksHidden }: { initial: ExplorerInitial; blocks: RecentBlock[]; blocksHidden: boolean }) {
  return (
    <div className="ex ex-list">
      <PageHead title="QNet Blockchain Explorer" lead="All transactions from Genesis to Now" strength={0.55} more={<NetworkReadouts initial={initial} />}>
        <ExplorerSearch />
      </PageHead>
      <div className="wrap ex-main">
        <LatestBlocks seed={blocks} hidden={blocksHidden} />
        <Transactions initial={initial} />
      </div>
    </div>
  );
}
