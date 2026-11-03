// The explorer's table columns, one definition per kind of cell: every list (all transactions, a block's,
// an address's, QNC transfers, holders, tokens) is put together from these, so a hash, a type, a side, an amount, a
// block or an age looks and sizes the same in each. Headers are in the page's language (`t`).

import { useRef, type CSSProperties, type ReactNode } from 'react';
import type { Column } from '@/components/ui/DataTable';
import EntityLink from '@/components/ui/EntityLink';
import { Dash } from '@/components/ui/Skeleton';
import { TxType } from '@/components/ui/Status';
import { int } from '@/lib/format';
import { ageForms, type AmountParts } from '@/lib/explorer-view';
import { AMOUNT_W, FROM_TO_MIN, amountChars, amountWidth, steadyWidth, wordsWidth, type SteadyWidth } from '@/lib/geometry';
import type { T } from '@/lib/texts';
import { txTypeLabel } from '@/lib/tx-labels';
import Ago from './Ago';
import { FromTo, Party, type FromToProps } from './cells';

type Get<T, V> = (row: T) => V;

export function hashCol<R>(t: T, get: Get<R, string>, header: ReactNode = t('col_tx'), width = 136): Column<R> {
  return { key: 'hash', header, width, cell: (r) => (get(r) ? <EntityLink kind="tx" value={get(r)} /> : <Dash />) };
}

// The colour follows the chain's type; the app's view reads reward and activation by what they change.
export function typeCol<R>(t: T, get: Get<R, string>, full: boolean, width = 136): Column<R> {
  return { key: 'type', header: t('col_type'), width, cell: (r) => <TxType type={get(r)} label={txTypeLabel(get(r), full, t)} /> };
}

// The one flexible column of a transaction list: the sender and the recipient on one line. `more` adds the page's own
// address and the words for an empty side (cells.tsx FromTo).
export function fromToCol<R>(
  t: T, from: Get<R, string | null | undefined>, to: Get<R, string | null | undefined>, full: boolean, more?: Get<R, Partial<FromToProps>>,
): Column<R> {
  return { key: 'ft', header: t('col_from_to'), min: FROM_TO_MIN, cell: (r) => <FromTo from={from(r)} to={to(r)} full={full} {...more?.(r)} /> };
}

export function partyCol<R>(key: string, header: ReactNode, get: Get<R, string | null | undefined>, full: boolean, width?: number): Column<R> {
  return { key, header, width, cell: (r) => <Party value={get(r)} full={full} /> };
}

// An exact amount: room for 20 characters, its icon and its unit (QNC to nine decimals, a sign on an address's own list),
// or `width` (amountsWidth) where a list's amounts run longer.
export function amountCol<R>(t: T, cell: Get<R, ReactNode>, header: ReactNode = t('col_amount'), width = AMOUNT_W): Column<R> {
  return { key: 'amount', header, width, align: 'right', cell };
}

// The width an amount column needs for a list's amounts (a token's run to 18 decimals), a sign before each when
// `signed`; never narrower than `least`.
export const amountsWidth = (parts: readonly (AmountParts | null)[], signed = false, least?: number): number =>
  amountWidth(parts.filter((p): p is AmountParts => p !== null).map((p) => ({ value: signed ? `+${p.value}` : p.value, unit: p.unit })), least);

// A list's amount column as wide as the widest it needed on this view of the list (geometry.ts steadyWidth), kept across
// its renders; `view` names the page, sort and filter shown.
export function useSteadyWidth(width: number, view: string): number {
  const kept = useRef<SteadyWidth | null>(null);
  kept.current = steadyWidth(kept.current, view, width);
  return kept.current.width;
}

export function blockCol<R>(t: T, get: Get<R, number | string | null | undefined>, width = 100): Column<R> {
  return {
    key: 'block', header: t('col_block'), width, align: 'right',
    cell: (r) => {
      const h = get(r);
      return h === null || h === undefined || h === '' ? <Dash /> : <EntityLink kind="block" value={typeof h === 'string' ? Number(h) : h} />;
    },
  };
}

// An age's column: `width`, or wider where the page's language writes a longer age ("il y a 59 min"), so none is cut.
export const ageWidth = (t: T, width: number): number => Math.max(width, wordsWidth(ageForms(t)));

export function timeCol<R>(t: T, get: Get<R, number | null | undefined>, width = 80): Column<R> {
  return { key: 'time', header: t('col_time'), width: ageWidth(t, width), align: 'right', cell: (r) => <Ago ts={get(r)} /> };
}

// A list of holders (QNC's, a token's): rank, address, balance (as wide as the list's longest of `amounts`, geometry.ts
// amountWidth) and share; a phone lays a row out on two lines (DataTable stack="holders"), the balance set smaller by
// that longest amount where its line is narrower (amountChars).
export function holderCols<R extends { address: string; percent: string; rank: number }>(t: T, balance: Get<R, ReactNode>, full: boolean, amounts: readonly { value: string; unit: string }[]): Column<R>[] {
  const fit = { '--amt-len': amountChars(amounts).toFixed(2) } as CSSProperties;
  return [
    textCol<R>('rank', '#', (h) => int(h.rank), 64),
    partyCol<R>('address', t('col_address'), (h) => h.address, full),
    amountCol<R>(t, (h) => <span className="tbl-amt" style={fit}>{balance(h)}</span>, t('col_balance'), amountWidth(amounts)),
    textCol<R>('pct', t('col_share'), (h) => `${h.percent}%`, 96, 'right'),
  ];
}

// `min`: a flexible column's width in a frame that scrolls sideways, when its longest value needs more than the default.
export function textCol<R>(key: string, header: ReactNode, get: Get<R, ReactNode>, width?: number, align?: 'right', min?: number): Column<R> {
  return { key, header, width, align, min, cell: (r) => get(r) ?? <Dash /> };
}
