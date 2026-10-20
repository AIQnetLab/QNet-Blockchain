// Readouts, the instrument panel (B-SPEC 5.11): each reading a short top rule, a label, a value in light mono and one
// line under it. A value with a page is a link; an unknown value is "—" in Fog at full height, so nothing moves when it
// arrives. A value is never cut and never wraps: a long one is set smaller by its length (styles/base.css .ro-v).

import IntentLink from './IntentLink';
import type { CSSProperties, ReactNode } from 'react';
import { readoutLength } from '@/lib/geometry';
import Flash from './Flash';
import { AmountUnit, unitText, type AmountToken } from './EntityLink';

// A named group, so the name is announced (a plain div's aria-label is not).
export function Readouts({ cols = 4, size, label, children }: { cols?: number; size?: 'tool'; label?: string; children: ReactNode }) {
  return (
    <div className="readouts" role={label ? 'group' : undefined} data-size={size} aria-label={label} style={{ '--ro-cols': cols } as CSSProperties}>
      {children}
    </div>
  );
}

interface ReadoutProps {
  // Text, or text with an entity in it (My node's "Epoch 283").
  label: ReactNode;
  // null or undefined: not known yet ("—").
  value: string | null | undefined;
  unit?: string;
  href?: string;
  // A unit with a page that is not a token's (none today); an amount takes `amount`.
  unitHref?: string;
  // An amount: its unit is the token's icon and symbol at the number's size, linked to its page (AmountUnit); `link`
  // false on that token's own page.
  amount?: AmountToken & { link?: boolean };
  sub?: ReactNode;
  subTone?: 'needs';
  // A 0..1 progress line under the value (the epoch's blocks done).
  progress?: number | null;
  // The value flashes Ember when it changes (the newest block height).
  flash?: boolean;
  // Spans both columns on a phone.
  wide?: boolean;
  // A mark before a known value (the live dot of a node that runs).
  mark?: ReactNode;
  // A reading drawn rather than written (My node's last epochs): shown in place of the value.
  children?: ReactNode;
}

export function Readout({ label, value, unit, href, unitHref, amount, sub, subTone, progress, flash, wide, mark, children }: ReadoutProps) {
  const known = value !== null && value !== undefined && value !== '';
  // An amount's unit is as large as its number, with its icon (about one character): it counts in full.
  const len = !known ? 1 : (amount ? readoutLength(`${value} ${unitText(amount)}`, undefined, true) + (mark ? 1.6 : 0)
    : readoutLength(value, unit, Boolean(mark)));
  const length = { '--ro-len': len } as CSSProperties;
  const inner = known ? (flash ? <Flash value={value} /> : value) : <span className="dash">—</span>;
  const shown = (
    <>
      {known && mark}
      {inner}
      {known && amount && <>{' '}<AmountUnit {...amount} link={amount.link !== false && !href} /></>}
      {known && !amount && unit && (unitHref && !href ? <IntentLink className="unit" href={unitHref}>{unit}</IntentLink> : <span className="unit">{unit}</span>)}
    </>
  );
  return (
    <div className="ro" data-wide={wide || undefined}>
      <span className="label">{label}</span>
      {children ?? (known && href ? (
        <IntentLink className="ro-v" href={href} title={value} style={length}>{shown}</IntentLink>
      ) : (
        <span className="ro-v" title={known ? value : undefined} style={length}>{shown}</span>
      ))}
      <p className="ro-s" data-tone={subTone}>{sub ?? ' '}</p>
      {progress !== undefined && (
        <span className="ro-bar" aria-hidden="true">
          <i style={{ transform: `scaleX(${Math.min(1, Math.max(0, progress ?? 0)).toFixed(4)})` }} />
        </span>
      )}
    </div>
  );
}
