'use client';

// A titled group that opens in place (B-SPEC 6.3): a full-width row button with the title, a count and a chevron;
// closed it is one row, so opening it moves only what is under it.

import { useId, useState, type ReactNode } from 'react';
import { int } from '@/lib/format';

export default function Disclosure({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  return (
    <section className="ex-disc">
      <h2 className="ex-disc-h">
        <button type="button" className="ex-disc-btn" aria-expanded={open} aria-controls={panel} onClick={() => setOpen((o) => !o)}>
          <span className="tbl-title">{title}</span>
          <span className="label">{int(count)}</span>
          <span className="ex-chev" aria-hidden="true" />
        </button>
      </h2>
      <div id={panel} hidden={!open}>{open && children}</div>
    </section>
  );
}
