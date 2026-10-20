'use client';

// Latest blocks (B-SPEC 6.2, owner 20.10): one strip across the top of the explorer, above All transactions. Each block
// is a card of fixed size, its lines stacked: the height (a link to the block), its age, the node that made it (a link
// to its address when the index knows it) and its transactions. A new block comes in at the left and the strip slides
// right (a transform, so nothing around it moves); older blocks are a sideways scroll inside the strip (a finger, the
// wheel sideways, or a drag with the mouse). A pointer, focus, a touch or the strip read sideways holds it, and its label
// says how many blocks wait. All blocks opens the whole history (/explorer/blocks); Hide folds the strip to its title
// line and the page keeps it folded for this visitor (src/lib/strip-pref.ts).

import { useRef, useState, useSyncExternalStore, type MouseEvent, type PointerEvent } from 'react';
import EntityLink from '@/components/ui/EntityLink';
import { HoldLabel } from '@/components/ui/Status';
import Action from '@/components/ui/Action';
import { RECENT_BLOCKS, txCountText, type RecentBlock } from '@/lib/explorer-view';
import { int } from '@/lib/format';
import { stripCookie, stripHiddenIn } from '@/lib/strip-pref';
import Ago from './Ago';
import { useLiveBlocks } from './useRecentBlocks';

// Scrolled from the newest end by more than this, the strip holds until it is back.
const AWAY_PX = 8;
// A mouse that moves this far with its button down drags the strip instead of clicking a link.
const DRAG_PX = 5;

// The visitor's Hide or Show, from the cookie the server read too; every strip on the page follows a change.
const watchers = new Set<() => void>();
const watch = (on: () => void) => {
  watchers.add(on);
  return () => { watchers.delete(on); };
};
const hiddenNow = () => stripHiddenIn(document.cookie);

// `hidden`: the visitor's choice as the server read it (the loading state has none and reads the cookie in the browser).
export default function LatestBlocks({ seed, hidden }: { seed: readonly RecentBlock[]; hidden?: boolean }) {
  const view = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const { shown, hold, near, landed } = useLiveBlocks(seed, RECENT_BLOCKS, view, list);
  const open = !useSyncExternalStore(watch, hiddenNow, () => hidden ?? false);
  const [atEnd, setAtEnd] = useState(false);
  const drag = useRef<{ x: number; left: number; moved: boolean } | null>(null);
  const toggle = () => {
    document.cookie = stripCookie(open, window.location.protocol === 'https:');
    for (const on of watchers) on();
  };
  const onScroll = () => {
    const el = view.current;
    if (!el) return;
    hold.away(el.scrollLeft > AWAY_PX);
    setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 2);
  };
  // A mouse drags the strip sideways; a drag never ends in a click on the link under it.
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    hold.handlers.onPointerDown(e);
    if (e.pointerType === 'mouse' && e.button === 0 && view.current) drag.current = { x: e.clientX, left: view.current.scrollLeft, moved: false };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const el = view.current;
    if (!d || !el) return;
    if (!d.moved && Math.abs(e.clientX - d.x) < DRAG_PX) return;
    if (!d.moved) el.setPointerCapture(e.pointerId);
    d.moved = true;
    el.scrollLeft = d.left - (e.clientX - d.x);
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    hold.handlers.onPointerUp(e);
    // A drag's own click comes right after this event; the mark goes once it has passed.
    if (drag.current?.moved) window.setTimeout(() => { drag.current = null; }, 0);
    else drag.current = null;
  };
  const onClickCapture = (e: MouseEvent<HTMLDivElement>) => {
    if (!drag.current?.moved) return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <section className="ex-chain" aria-label="Latest blocks" data-open={open}>
      <div className="ex-chain-head">
        <h2 className="label ex-chain-title">Latest blocks</h2>
        <span className="label tbl-live"><HoldLabel hold={hold} /></span>
        <Action kind="act" href="/explorer/blocks" className="ex-chain-all">All blocks</Action>
        <button type="button" className="act quiet" aria-expanded={open} aria-controls="ex-chain-cells" onClick={toggle}>
          <span className="swap">
            <span data-on={open}>Hide</span>
            <span data-on={!open}>Show</span>
          </span>
        </button>
      </div>
      <div className="ex-chain-body" id="ex-chain-cells">
        <div
          ref={view}
          className="ex-chain-view"
          data-end={atEnd || undefined}
          onScroll={onScroll}
          {...hold.handlers}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onClickCapture={onClickCapture}
        >
          {/* Each card keeps its place and takes the next block (its content keyed by height, so a block's flash plays as
              it lands): only the list's transform moves, and nothing in the layout shifts as blocks come in. A line
              not known yet stays empty at its height. */}
          <ol ref={list} className="ex-chain-list">
            {shown.map((b, i) => {
              const fresh = landed.has(String(b.height)) || undefined;
              return (
                <li key={i} className="ex-cell">
                  <div key={b.height} className="ex-cell-in" data-new={fresh}>
                    <span className="ex-cell-h flash" data-new={fresh} data-v={int(b.height)}>
                      <EntityLink kind="block" value={b.height} />
                    </span>
                    <span>{b.timestamp ? <Ago ts={b.timestamp} on={near && open} /> : null}</span>
                    <span className="ent-fit">{b.producer ? <EntityLink kind="node" value={b.producer} address={b.producerAddress} /> : null}</span>
                    <span>{b.txCount !== null ? txCountText(b.txCount) : null}</span>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </section>
  );
}
