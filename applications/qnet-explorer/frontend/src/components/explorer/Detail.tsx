// The parts of a detail page (B-SPEC 5.14, 5.7): label and value rows, a long value in its short form with Copy, and a
// whole value under the title that holds its place before it is known (an invisible stand-in of the same length and the
// same Copy control), so nothing moves when the record arrives.

import type { ReactNode } from 'react';
import Copy from '@/components/ui/Copy';
import { Dash } from '@/components/ui/Skeleton';
import { short } from '@/lib/format';

// The rows as a named group (a list of terms takes no name of its own).
export function Rows({ label, children }: { label: string; children: ReactNode }) {
  return <div role="group" aria-label={label}><dl className="kv">{children}</dl></div>;
}

// A row; no value reads "—".
export function Row({ label, children }: { label: ReactNode; children?: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children === null || children === undefined || children === '' ? <Dash /> : children}</dd>
    </div>
  );
}

// A row holding a hash, a root or a signature: 8…6 with a Copy named by the row.
export function HashRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <Row label={label}>
      {value ? (
        <span className="ex-val">
          <span title={value}>{short('hash', value)}</span>
          <Copy value={value} ariaLabel={`Copy ${label}`} />
        </span>
      ) : null}
    </Row>
  );
}

// The whole value under a title with Copy, `name` saying what it copies; until it is known, a stand-in of `length`
// characters keeps its lines.
export function Whole({ value, name, length = 64, children }: { value: string | null | undefined; name: string; length?: number; children?: ReactNode }) {
  if (!value) {
    return (
      <span className="ex-whole" aria-hidden="true" style={{ visibility: 'hidden' }}>
        <span className="ent-full">{'0'.repeat(length)}</span>
        <Copy value="" />
      </span>
    );
  }
  return (
    <span className="ex-whole">
      <span className="ent-full">{children ?? value}</span>
      <Copy value={value} ariaLabel={`Copy ${name}`} />
    </span>
  );
}
