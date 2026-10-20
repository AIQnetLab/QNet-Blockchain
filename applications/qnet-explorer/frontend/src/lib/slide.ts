// How a live list of blocks takes new blocks at its start (the home page's column, the explorer's strip): the list
// starts as far back as the new items take (up in a column, left in a row) and eases to its place with a transform.
// The items already shown stay where they were in the frame that adds the new ones, so nothing moves under the reader
// and no layout shifts, however many arrive at once. A slide is never cut short: a list holds what comes during one
// (components/ui/useHold.ts settle) and shows it when the slide ends, since a new start over a running slide is a jump.

// How many items the list slides in by: the new heights above the old top; 0 for the first list or no new top.
export function slideCount(wasTop: number, top: number): number {
  return wasTop && top > wasTop ? top - wasTop : 0;
}

// The slide's length in ms from the --t-slide token ("500ms", "0.5s").
export function slideMs(token: string): number {
  const m = /^\s*([\d.]+)(ms|s)\s*$/.exec(token);
  return m ? Number(m[1]) * (m[2] === 's' ? 1000 : 1) : 0;
}

// The slide itself: `count` items back (each the first item's size plus the list's gap, at most the items there are),
// then to its place. Returns how long it runs (ms), 0 when nothing slides.
export function slideIn(el: HTMLElement, count: number): number {
  const first = el.firstElementChild as HTMLElement | null;
  const n = Math.min(count, el.childElementCount);
  if (!first || n < 1 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return 0;
  const style = window.getComputedStyle(el);
  const row = style.flexDirection === 'row';
  const gap = parseFloat(row ? style.columnGap : style.rowGap) || 0;
  const size = n * ((row ? first.offsetWidth : first.offsetHeight) + gap);
  el.style.transition = 'none';
  el.style.transform = row ? `translateX(${-size}px)` : `translateY(${-size}px)`;
  void el.offsetWidth;
  el.style.transition = 'transform var(--t-slide) var(--ease-out)';
  el.style.transform = 'none';
  return slideMs(style.getPropertyValue('--t-slide'));
}
