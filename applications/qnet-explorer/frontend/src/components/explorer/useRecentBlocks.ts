'use client';

// The newest blocks for the explorer's Latest blocks strip (B-SPEC 6.2) and the home page's live column: the server's
// list at first paint (the head snapshot's newest blocks), then each new head from the head stream at the top with its
// producer and transaction count, the oldest row out (src/lib/explorer-view.ts nextBlocks), so the list keeps its
// length. Rows the stream left incomplete (a height it skipped, a head whose event did not name its block) and a list
// shorter than its length are filled in place by height from one read of the newest blocks (fillBlocks).

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useHold, useLanded, type Hold } from '@/components/ui/useHold';
import { useChainHead } from '@/hooks/useChainHead';
import { useIntersectionObserver } from '@/hooks/useIntersectionObserver';
import { blocksMissing, fillBlocks, headBlock, nextBlocks, type RecentBlock } from '@/lib/explorer-view';
import { slideCount, slideIn } from '@/lib/slide';

// At most one read every 2 s while something is missing; after a read that filled nothing (the index behind the
// stream), the next waits 15 s.
const READ_MS = 2_000;
const IDLE_MS = 15_000;

export function useRecentBlocks(seed: readonly RecentBlock[], limit: number): RecentBlock[] {
  const [blocks, setBlocks] = useState<RecentBlock[]>(() => seed.slice(0, limit));
  const head = useChainHead();
  useEffect(() => {
    if (!head.height) return;
    setBlocks((cur) => nextBlocks(cur, headBlock(head), limit));
  }, [head.height, head.hash, head.timestamp, head.block, limit]); // eslint-disable-line react-hooks/exhaustive-deps

  const current = useRef(blocks);
  current.current = blocks;
  const busy = useRef(false);
  const nextAt = useRef(0);
  const missing = blocksMissing(blocks, limit);
  const top = blocks[0]?.height ?? 0;
  useEffect(() => {
    if (!missing || busy.current || Date.now() < nextAt.current || document.visibilityState === 'hidden') return;
    busy.current = true;
    let filled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/blocks?latest=${limit}`, { cache: 'no-store' });
        const body = await res.json();
        if (body?.success && Array.isArray(body.data)) {
          const read = body.data as RecentBlock[];
          filled = fillBlocks(current.current, read, limit) !== current.current;
          if (filled) setBlocks((cur) => fillBlocks(cur, read, limit));
        }
      } catch {
        // The rows keep their heights and links; the next head asks again.
      } finally {
        busy.current = false;
        nextAt.current = Date.now() + (filled ? READ_MS : IDLE_MS);
      }
    })();
  }, [missing, top, limit]);
  return blocks;
}

const blockKey = (b: RecentBlock) => String(b.height);

export interface LiveBlocks {
  // What the list shows: the newest blocks unless it is held (useHold); out of view, what it showed last.
  shown: readonly RecentBlock[];
  hold: Hold<readonly RecentBlock[] | null>;
  // The list is on screen or near it: its ages tick only then.
  near: boolean;
  // The heights (as keys) that landed with the list shown now; their heights flash.
  landed: ReadonlySet<string>;
}

// A live list of the newest blocks, the home page's column and the explorer's strip: `box` holds it (pointer, focus,
// a touch, its own scroll) and keeps it current while near the screen; `list` slides when blocks come in at its start
// (src/lib/slide.ts). Out of view it does no DOM work and on return shows the latest at once, without the slide.
export function useLiveBlocks(seed: readonly RecentBlock[], limit: number, box: RefObject<HTMLElement | null>, list: RefObject<HTMLElement | null>): LiveBlocks {
  const blocks = useRecentBlocks(seed, limit);
  // Both lists sit at the top of their page: near until the first observation says otherwise.
  const near = useIntersectionObserver(box as RefObject<Element>, { rootMargin: '80px 0px', initial: true });
  const hold = useHold(blocks, box, blockKey);
  const kept = useRef(hold.shown ?? []);
  if (near) kept.current = hold.shown ?? [];
  const shown = kept.current;
  // The first blocks a list gets (an empty list filling) land without a flash.
  const landed = useLanded(shown.length > 0 ? shown : null, blockKey);

  const top = shown[0]?.height ?? 0;
  const prevTop = useRef(top);
  const wasNear = useRef(near);
  const ending = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const was = prevTop.current;
    const returned = near && !wasNear.current;
    prevTop.current = top;
    wasNear.current = near;
    const el = list.current;
    if (!el || returned) return;
    const ms = slideIn(el, slideCount(was, top));
    if (!ms) return;
    // What comes during the slide shows once it has ended (its transitionend; the timer if the tab hid it): a slide
    // cut short is a jump.
    ending.current?.();
    hold.settle(true);
    const onEnd = (e: TransitionEvent) => { if (e.target === el && e.propertyName === 'transform') end(); };
    const timer = window.setTimeout(() => end(), ms + 250);
    const end = () => {
      el.removeEventListener('transitionend', onEnd);
      window.clearTimeout(timer);
      ending.current = null;
      hold.settle(false);
    };
    el.addEventListener('transitionend', onEnd);
    ending.current = end;
  }, [top, near]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => ending.current?.(), []);
  return { shown, hold, near, landed };
}
