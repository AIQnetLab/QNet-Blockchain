// The site's formats in one module: numbers with comma groups and a point in every language and whatever the visitor's
// locale (texts.ts number, token-format.ts), ages, time left in words, exact times with the page language's month names,
// and the short forms of hashes, addresses and node ids.

import { dateLocale, type Locale } from './languages.ts';
import { number, type T } from './texts.ts';
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
export function ago(ms: number, t: T): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 1) return t('ago_now');
  if (s < 60) return t('ago_s', { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t('ago_m', { n: m });
  const h = Math.floor(m / 60);
  return h < 24 ? t('ago_h', { n: h }) : t('ago_d', { n: Math.floor(h / 24) });
}

// A span of blocks in words, one block a second: "about 38 min", "about 3 h 12 min".
export function inWords(blocks: number, t: T): string {
  const minutes = Math.max(1, Math.round(blocks / 60));
  if (minutes < 60) return t('about_min', { m: minutes });
  const rest = minutes % 60;
  return rest ? t('about_h_min', { h: Math.floor(minutes / 60), m: rest }) : t('about_h', { h: Math.floor(minutes / 60) });
}

// Ends in 2,295 blocks, about 38 min
export function endsIn(blocks: number, t: T): string {
  return t(blocks === 1 ? 'ends_in_one' : 'ends_in', { blocks: int(blocks), time: inWords(blocks, t) });
}

// Exact times in the visitor's time zone, the page language's month names, Latin digits, 24 hours; one set of
// formatters per language.
interface Dates { when: Intl.DateTimeFormat; day: Intl.DateTimeFormat; dayUtc: Intl.DateTimeFormat; date: Intl.DateTimeFormat; clock: Intl.DateTimeFormat }
const DATES = new Map<Locale, Dates>();

function dates(locale: Locale): Dates {
  let d = DATES.get(locale);
  if (!d) {
    const tag = dateLocale(locale);
    d = {
      when: new Intl.DateTimeFormat(tag, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }),
      day: new Intl.DateTimeFormat(tag, { month: 'short', day: 'numeric', year: 'numeric' }),
      dayUtc: new Intl.DateTimeFormat(tag, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }),
      date: new Intl.DateTimeFormat(tag, { month: 'short', day: 'numeric' }),
      clock: new Intl.DateTimeFormat(tag, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
    };
    DATES.set(locale, d);
  }
  return d;
}

// Oct 19, 2026, 04:07:12
export const when = (ts: number, t: T): string => dates(t.locale).when.format(ts);

// Oct 2, 2026
export const day = (ts: number, t: T): string => dates(t.locale).day.format(ts);

// Oct 2, 2026 as a UTC day: the day a record names, the same for every visitor.
export const dayUtc = (ts: number, t: T): string => dates(t.locale).dayUtc.format(ts);

// Oct 19, 00:07 – 04:07; across midnight Oct 18, 20:07 – Oct 19, 00:07. Each time is held whole by no-break spaces, so a
// narrow column breaks the line only after the dash.
export function span(from: number, to: number, t: T): string {
  const d = dates(t.locale);
  const whole = (s: string) => s.replace(/ /g, ' ');
  const start = whole(at(from, t));
  return `${start} – ${whole(d.day.format(from) === d.day.format(to) ? d.clock.format(to) : at(to, t))}`;
}

// Oct 19, 04:07
export const at = (ts: number, t: T): string => t('date_time', { date: dates(t.locale).date.format(ts), time: dates(t.locale).clock.format(ts) });

// A time to come back at: 14:05 within the next twelve hours, else Oct 20, 14:05.
export function clockAt(ts: number, now: number, t: T): string {
  return ts - now < 12 * 3_600_000 ? dates(t.locale).clock.format(ts) : at(ts, t);
}

// A time gone by: 14:05 within the last twelve hours, else Oct 18, 14:05.
export function clockAgo(ts: number, now: number, t: T): string {
  return now - ts < 12 * 3_600_000 ? dates(t.locale).clock.format(ts) : at(ts, t);
}

export type ShortKind = 'hash' | 'address' | 'address-compact' | 'node' | 'solana';

const NODE_WHOLE = 16;

// The short forms, with the one ellipsis character: a hash 8…6, an address 6…6 (4…4 in the phone header),
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
