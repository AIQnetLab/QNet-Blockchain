'use client';

// A value that flashes Ember when it changes (never on first paint): an Ember copy over it fades by opacity, so the
// flash costs no layout and no repaint of its neighbours.

import { useEffect, useRef, useState } from 'react';

export default function Flash({ value }: { value: string }) {
  const first = useRef(value);
  const [changed, setChanged] = useState(false);
  useEffect(() => {
    if (value !== first.current) setChanged(true);
  }, [value]);
  return (
    <span key={changed ? value : 'first'} className="flash" data-new={changed || undefined} data-v={value}>
      {value}
    </span>
  );
}
