'use client';

// Something to do when the chain head moves (the head stream), without rendering the page for each head: a list read
// again, a record not read yet asked for again. At most once every `every` ms, only once the head reaches `from`, and
// `max` times at most (a record that may never come is not asked for forever).

import { useEffect, useRef } from 'react';
import { useChainHead } from '@/hooks/useChainHead';

interface OnHeadProps {
  onHead: () => void;
  every?: number;
  from?: number;
  max?: number;
}

export default function OnHead({ onHead, every = 0, from = 0, max = Infinity }: OnHeadProps) {
  const head = useChainHead();
  const call = useRef(onHead);
  call.current = onHead;
  const calls = useRef(0);
  // Counted from the mount: the page has just read what it shows.
  const last = useRef(Date.now());
  useEffect(() => {
    if (!head.height || head.height < from || calls.current >= max) return;
    if (document.visibilityState === 'hidden' || Date.now() - last.current < every) return;
    last.current = Date.now();
    calls.current += 1;
    call.current();
  }, [head.v, head.height, from, max, every]);
  return null;
}
