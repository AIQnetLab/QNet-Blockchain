// The final geometry while a value loads (B-SPEC 3.13): a box of the content's size with a faint line, no shimmer and
// no spinner, so nothing moves when the content arrives. Hidden from screen readers; the page says what it waits for.

import type { CSSProperties } from 'react';

interface SkeletonProps {
  // The content's width and line height, as CSS lengths ("12ch", "100%").
  width?: string;
  lines?: number;
  block?: boolean;
}

export default function Skeleton({ width = '10ch', lines = 1, block = false }: SkeletonProps) {
  const style: CSSProperties = { width, height: `${lines * 1.4}em` };
  return (
    <span className={`skel${block ? ' skel-block' : ''}`} style={style} aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => <i key={i} />)}
    </span>
  );
}

// An empty value: "—" in Fog, where a value will stand.
export function Dash() {
  return <span className="dash" aria-label="Not known">—</span>;
}
