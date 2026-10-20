// The explorer's table columns, one definition per kind of cell (B-SPEC 5.9): every list (all transactions, a block's,
// an address's, QNC transfers, holders, tokens) is put together from these, so a hash, a type, a side, an amount, a
// block or an age looks and sizes the same in each.

import type { ReactNode } from 'react';
import type { Column } from '@/components/ui/DataTable';
import EntityLink from '@/components/ui/EntityLink';
import { Dash } from '@/components/ui/Skeleton';
import { TxType } from '@/components/ui/Status';
import { int } from '@/lib/format';
import { AMOUNT_W, FROM_TO_MIN } from '@/lib/geometry';
import { txTypeLabel } from '@/lib/tx-labels';
import Ago from './Ago';
import { FromTo, Party, type FromToProps } from './cells';

type Get<T, V> = (row: T) => V;

export function hashCol<T>(get: Get<T, string>, header: ReactNode = 'Transaction', width = 136): Column<T> {
  return { key: 'hash', header, width, cell: (r) => (get(r) ? <EntityLink kind="tx" value={get(r)} /> : <Dash />) };
}

// The colour follows the chain's type; the app's view reads reward and activation by what they change.
export function typeCol<T>(get: Get<T, string>, full: boolean, width = 136): Column<T> {
  return { key: 'type', header: 'Type', width, cell: (r) => <TxType type={get(r)} label={txTypeLabel(get(r), full)} /> };
}

// The one flexible column of a transaction list: the sender and the recipient on one line. `more` adds the page's own
// address and the words for an empty side (cells.tsx FromTo).
export function fromToCol<T>(
  from: Get<T, string | null | undefined>, to: Get<T, string | null | undefined>, full: boolean, more?: Get<T, Partial<FromToProps>>,
): Column<T> {
  return { key: 'ft', header: 'From / To', min: FROM_TO_MIN, cell: (r) => <FromTo from={from(r)} to={to(r)} full={full} {...more?.(r)} /> };
}

export function partyCol<T>(key: string, header: ReactNode, get: Get<T, string | null | undefined>, full: boolean, width?: number): Column<T> {
  return { key, header, width, cell: (r) => <Party value={get(r)} full={full} /> };
}

// An exact amount: room for 20 characters, its icon and its unit (QNC to nine decimals, a sign on an address's own list).
export function amountCol<T>(cell: Get<T, ReactNode>, header: ReactNode = 'Amount', width = AMOUNT_W): Column<T> {
  return { key: 'amount', header, width, align: 'right', cell };
}

export function blockCol<T>(get: Get<T, number | string | null | undefined>, width = 100): Column<T> {
  return {
    key: 'block', header: 'Block', width, align: 'right',
    cell: (r) => {
      const h = get(r);
      return h === null || h === undefined || h === '' ? <Dash /> : <EntityLink kind="block" value={typeof h === 'string' ? Number(h) : h} />;
    },
  };
}

export function timeCol<T>(get: Get<T, number | null | undefined>, width = 80): Column<T> {
  return { key: 'time', header: 'Time', width, align: 'right', cell: (r) => <Ago ts={get(r)} /> };
}

// A list of holders (QNC's, a token's): rank, address, balance and share; a phone lays a row out on two lines (DataTable
// stack="holders").
export function holderCols<T extends { address: string; percent: string; rank: number }>(balance: Get<T, ReactNode>, full: boolean): Column<T>[] {
  return [
    textCol<T>('rank', '#', (h) => int(h.rank), 64),
    partyCol<T>('address', 'Address', (h) => h.address, full),
    amountCol<T>(balance, 'Balance'),
    textCol<T>('pct', 'Share', (h) => `${h.percent}%`, 96, 'right'),
  ];
}

// `min`: a flexible column's width in a frame that scrolls sideways, when its longest value needs more than the default.
export function textCol<T>(key: string, header: ReactNode, get: Get<T, ReactNode>, width?: number, align?: 'right', min?: number): Column<T> {
  return { key, header, width, align, min, cell: (r) => get(r) ?? <Dash /> };
}
