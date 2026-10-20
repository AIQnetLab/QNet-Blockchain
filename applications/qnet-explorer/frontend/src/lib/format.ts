// The site's formats in one module: numbers with comma groups and a point whatever the visitor's locale (texts.ts
// number, token-format.ts), ages, time left in words, exact times and the short forms of hashes, addresses and node ids.

import { number } from './texts.ts';
import { shortAddress } from './qnet-provider.ts';
import { formatQnc, formatTokenAmount } from './token-format.ts';

export { number, formatQnc, formatTokenAmount };

// 4,087,305
export function int(n: number | bigint): string {
  return number(typeof n === 'number' ? Math.trunc(n) : n);
}

// 17,710.39: the token's decimals, trailing zeros dropped, never rounded up.
export const amount = (raw: string | number | bigint | undefined, decimals: number): string => formatTokenAmount(raw, decimals);

// 10,478.743462: up to 9 decimals from nano QNC, trailing zeros dropped.
export const qnc = (nano: string | number | bigint | undefined): string => formatQnc(nano);

// A block or transaction time in ms, whether the record keeps seconds or ms.
export const epochMs = (ts: number): number => (ts > 1e12 ? ts : ts * 1000);

// now, 5s ago, 3m ago, 1h ago, 2d ago
export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 1) return 'now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

// A span of blocks in words, one block a second: "about 38 min", "about 3 h 12 min".
export function inWords(blocks: number): string {
  const minutes = Math.max(1, Math.round(blocks / 60));
  if (minutes < 60) return `about ${minutes} min`;
  const rest = minutes % 60;
  return `about ${Math.floor(minutes / 60)} h${rest ? ` ${rest} min` : ''}`;
}

// Ends in 2,295 blocks, about 38 min
export function endsIn(blocks: number): string {
  return `Ends in ${int(blocks)} ${blocks === 1 ? 'block' : 'blocks'}, ${inWords(blocks)}`;
}

// Exact times in the visitor's time zone, English month names, 24 hours.
const WHEN = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const CLOCK = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

// Oct 19, 2026, 04:07:12
export const when = (ts: number): string => WHEN.format(ts);

// Oct 2, 2026
export const day = (ts: number): string => DAY.format(ts);

// Oct 19, 00:07 – 04:07; across midnight Oct 18, 20:07 – Oct 19, 00:07
export function span(from: number, to: number): string {
  const start = `${DATE.format(from)}, ${CLOCK.format(from)}`;
  return DAY.format(from) === DAY.format(to) ? `${start} – ${CLOCK.format(to)}` : `${start} – ${DATE.format(to)}, ${CLOCK.format(to)}`;
}

// Oct 19, 04:07
export const at = (ts: number): string => `${DATE.format(ts)}, ${CLOCK.format(ts)}`;

// A time to come back at: 14:05 within the next twelve hours, else Oct 20, 14:05.
export function clockAt(ts: number, now: number): string {
  return ts - now < 12 * 3_600_000 ? CLOCK.format(ts) : at(ts);
}

// A time gone by: 14:05 within the last twelve hours, else Oct 18, 14:05.
export function clockAgo(ts: number, now: number): string {
  return now - ts < 12 * 3_600_000 ? CLOCK.format(ts) : at(ts);
}

export type ShortKind = 'hash' | 'address' | 'address-compact' | 'node' | 'solana';

const NODE_WHOLE = 16;

// The short forms (B-SPEC 5.7), with the one ellipsis character: a hash 8…6, an address 6…6 (4…4 in the phone header),
// a node id whole up to 16 characters, else its prefix through the last "_", "…" and its last 8.
export function short(kind: ShortKind, value: string): string {
  const cut = (head: number, tail: number) => (value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value);
  switch (kind) {
    case 'hash':
      return cut(8, 6);
    case 'address':
    case 'solana':
      return shortAddress(value);
    case 'address-compact':
      return cut(4, 4);
    case 'node': {
      if (value.length <= NODE_WHOLE) return value;
      const at = value.lastIndexOf('_');
      return at > 0 && at < value.length - 8 ? `${value.slice(0, at + 1)}…${value.slice(-8)}` : cut(8, 8);
    }
  }
}
