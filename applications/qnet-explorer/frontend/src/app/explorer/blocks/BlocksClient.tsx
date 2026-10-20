'use client';

// The block history (/explorer/blocks): every block of QNet Blockchain, newest first, BLOCKS_PER_PAGE a page, from the
// explorer's index (/api/blocks?at=H). Pages count down from page 1's first height (the anchor), so they stay where
// they are while the chain grows; a line says how many blocks are newer than page 1 and shows them on a press. A height
// typed in the band opens the page that starts at it. The address bar keeps the page (?at=H) for a reload or a link.

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import Ago from '@/components/explorer/Ago';
import { textCol } from '@/components/explorer/columns';
import Action from '@/components/ui/Action';
import DataTable from '@/components/ui/DataTable';
import EntityLink from '@/components/ui/EntityLink';
import PageHead from '@/components/ui/PageHead';
import Pager from '@/components/ui/Pager';
import { useChainHead } from '@/hooks/useChainHead';
import { blocksPath } from '@/lib/explorer-reads';
import {
  BLOCKS_PER_PAGE, blockWindow, blocksAnchor, blocksPage, blocksPageTop, heightOf, txCountText, type RecentBlock,
} from '@/lib/explorer-view';
import { int } from '@/lib/format';
import type { FirstAnswer } from '@/server/first-answer';

interface Place {
  anchor: number;
  top: number;
}

const UNREADABLE = 'Could not read these blocks.';

const readRows = (top: number, ok: boolean, body: unknown): RecentBlock[] | null => {
  const result = body as { success?: boolean; data?: unknown } | null;
  return ok && result?.success && Array.isArray(result.data) ? blockWindow(top, result.data as RecentBlock[]) : null;
};

// A height the index does not hold yet has no hash: its row shows the height alone.
const COLUMNS = [
  textCol<RecentBlock>('block', 'Block', (b) => <EntityLink kind="block" value={b.height} />, 112),
  textCol<RecentBlock>('time', 'Time', (b) => (b.hash !== null ? <Ago ts={b.timestamp} /> : null), 88),
  textCol<RecentBlock>('producer', 'Producer', (b) => (b.producer ? <EntityLink kind="node" value={b.producer} address={b.producerAddress} /> : null)),
  textCol<RecentBlock>('txs', 'Transactions', (b) => (b.txCount === null ? null : txCountText(b.txCount)), 120, 'right'),
  // The height is the row's link; its hash is a second view of the same block.
  textCol<RecentBlock>('hash', 'Hash', (b) => (b.hash ? <EntityLink kind="block" value={b.hash} link={false} /> : null), 136),
];

// How many blocks are newer than page 1, and Show newest: the only part that renders for each head.
function NewerBlocks({ anchor, onHead, onNewest }: { anchor: number | null; onHead: (height: number) => void; onNewest: (height: number) => void }) {
  const { height } = useChainHead();
  useEffect(() => {
    if (height > 0) onHead(height);
  }, [height, onHead]);
  const newer = anchor === null ? 0 : Math.max(0, height - anchor);
  return (
    <p className="ex-newer" data-on={newer > 0}>
      <span className="num">{newer > 0 ? `${int(newer)} newer ${newer === 1 ? 'block' : 'blocks'}` : '\u00a0'}</span>
      <Action kind="act" onClick={() => onNewest(height)} disabled={newer === 0}>Show newest</Action>
    </p>
  );
}

// `first` is the server's read of the page starting at `top`, placed in the pages from `anchor` (null: the server had no
// head, the page places itself on the first head); absent while the route loads (loading.tsx): the page's shape, no reads.
export default function BlocksClient({ first, top, anchor }: { first?: FirstAnswer | null; top?: number; anchor?: number }) {
  const [place, setPlace] = useState<Place | null>(top !== undefined && anchor !== undefined ? { anchor, top } : null);
  const [rows, setRows] = useState<RecentBlock[] | null>(() => (first && top !== undefined ? readRows(top, first.status < 400, first.body) : null));
  // The first height of the rows on screen.
  const shownTop = useRef<number | null>(rows && top !== undefined ? top : null);
  const [listError, setListError] = useState<string | null>(first && !rows ? UNREADABLE : null);
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const tried = useRef(0);
  const [asked, setAsked] = useState('');
  const [askError, setAskError] = useState<string | null>(null);
  const section = useRef<HTMLElement>(null);
  // The newest height known: the head stream's, or page 1's first.
  const head = useRef(anchor ?? 0);
  const placeRef = useRef(place);
  placeRef.current = place;

  useEffect(() => {
    // The loading state reads nothing, and rows already shown are read again only for Try again.
    if (first === undefined || !place) return;
    const again = retry !== tried.current;
    tried.current = retry;
    if (place.top === shownTop.current && !again) return;
    const at = place.top;
    const controller = new AbortController();
    setLoading(true);
    void (async () => {
      try {
        const res = await fetch(blocksPath(at), { signal: controller.signal });
        const read = readRows(at, res.ok, await res.json().catch(() => null));
        if (controller.signal.aborted) return;
        if (read) shownTop.current = at;
        setRows((shown) => read ?? shown ?? []);
        setListError(read ? null : UNREADABLE);
      } catch (err) {
        if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
        setRows((shown) => shown ?? []);
        setListError(UNREADABLE);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [place, retry, first]);

  // A new page starts at the list's top, scrolled there only when the reader is below it; the address bar keeps it.
  const go = useCallback((next: Place, newest = false) => {
    setPlace(next);
    window.history.replaceState(null, '', newest ? '/explorer/blocks' : `/explorer/blocks?at=${next.top}`);
    const el = section.current;
    if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView({ block: 'start' });
  }, []);

  const onHead = useCallback((height: number) => {
    head.current = Math.max(head.current, height);
    // The server had no head: the page starts at the first one.
    if (!placeRef.current && first !== undefined) setPlace({ anchor: height, top: height });
  }, [first]);
  const onNewest = useCallback((height: number) => go({ anchor: height, top: height }, true), [go]);

  const ask = (e: FormEvent) => {
    e.preventDefault();
    // Nothing to place a height in until the page knows the head.
    if (!place) return;
    const h = heightOf(asked);
    const newest = Math.max(head.current, place.anchor);
    if (h === null) return setAskError('Enter a block height, a whole number such as 17,500.');
    if (h > newest) return setAskError(`Block ${int(h)} is not on QNet Blockchain yet. The newest is ${int(newest)}.`);
    setAskError(null);
    go({ anchor: blocksAnchor(h, newest), top: h });
  };

  const at = place ? blocksPage(place.anchor, place.top) : null;
  const onPage = (n: number) => {
    if (!place || !at) return;
    const page = Math.min(Math.max(1, n), at.pages);
    if (page !== at.page) go({ anchor: place.anchor, top: blocksPageTop(place.anchor, page) });
  };

  const shownRange = rows && rows.length > 0 ? `${int(rows[0].height)} to ${int(rows[rows.length - 1].height)}` : '—';
  const failed = listError ? <>{listError} <Action kind="act" onClick={() => setRetry((n) => n + 1)}>Try again</Action></> : null;
  const error = rows && rows.length > 0 ? failed : null;
  const empty = failed ?? 'No blocks here yet.';

  // The table renders again only for its own rows, never for a head.
  const table = useMemo(() => (
    <DataTable
      className="ex-blocks-tbl"
      title="Blocks"
      meta={<span className="label num">{shownRange}</span>}
      tools={<NewerBlocks anchor={place?.anchor ?? null} onHead={onHead} onNewest={onNewest} />}
      caption="Blocks of QNet Blockchain, newest first"
      columns={COLUMNS}
      rows={rows}
      rowKey={(b) => String(b.height)}
      loadingRows={BLOCKS_PER_PAGE}
      empty={empty}
      error={error}
    />
  ), [rows, shownRange, place?.anchor, listError, onHead, onNewest]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="ex ex-detail">
      <PageHead kicker="Blocks" title="All blocks" lead="Every block of QNet Blockchain from the newest to Genesis. Each height opens its block.">
        <form className="ex-lookup" onSubmit={ask} data-field-clear>
          <label className="label form-label" htmlFor="blocks-at">Go to a block height</label>
          <div className="form-row">
            <input
              id="blocks-at"
              className="field"
              type="text"
              inputMode="numeric"
              enterKeyHint="go"
              value={asked}
              onChange={(e) => setAsked(e.target.value)}
              placeholder="Block height"
              spellCheck={false}
              autoComplete="off"
              aria-invalid={askError ? true : undefined}
              aria-describedby={askError ? 'blocks-at-error' : undefined}
            />
            <button type="submit" className="btn btn-solid">Show</button>
          </div>
          <p id="blocks-at-error" className="ex-error form-note" role="alert">{askError ?? '\u00a0'}</p>
        </form>
      </PageHead>

      <div className="wrap ex-body">
        <section ref={section} className="ex-group" aria-busy={loading || undefined}>
          {table}
          {at && <Pager page={at.page} pages={at.pages} total={at.total} onPage={onPage} />}
        </section>
      </div>
    </div>
  );
}
