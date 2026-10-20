'use client';

// One table for every list (B-SPEC 5.9): fixed columns from a <colgroup>, fixed row heights, cells that never wrap, so a
// row arriving or a value changing moves nothing. A live table holds new rows while the pointer or focus is inside it,
// and on a touch screen from a press on it until 3 s after the last touch or scroll (useHold), saying how many wait;
// it tints each new row as it lands. Up to a tablet's width the table keeps its columns in a frame that
// scrolls sideways when they need more room than it has, its first column sticky; the page itself never scrolls sideways.
// A list of holders (`stack`) instead lays each row out in place, at one fixed height, below that width.

import { Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { tableMinWidth } from '@/lib/geometry';
import { HoldLabel } from './Status';
import { useHold, useLanded } from './useHold';

export interface Column<T> {
  key: string;
  header: ReactNode;
  // Width in px; a column without one takes the rest, and in it an entity shows whole where the cell has room.
  width?: number;
  // A flexible column's width in a frame that scrolls sideways: room for its longest short value (lib/geometry.ts).
  min?: number;
  align?: 'right';
  // The order the rows follow, when this column sets it (the header's control says how to change it).
  sort?: 'ascending' | 'descending';
  cell: (row: T) => ReactNode;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  // null while the first answer is on its way: `loadingRows` empty rows at the final height.
  rows: readonly T[] | null;
  rowKey: (row: T) => string;
  // Two-line rows (a block's height over its hash, From over To).
  tall?: boolean;
  loadingRows?: number;
  // What is absent, in the visitor's words; the header stays.
  empty?: ReactNode;
  // A failed read: a line above the table; the rows shown stay.
  error?: ReactNode;
  caption: string;
  title?: ReactNode;
  // The datum at the right of the title (a count, a filter); a live table shows Live here.
  meta?: ReactNode;
  // Controls between the title and the table (the explorer's type filters).
  tools?: ReactNode;
  live?: boolean;
  // The phone's sideways frame (off for a table that fits 358 px).
  scroll?: boolean;
  // Below a computer's width each row is laid out in place at one height, read without scrolling sideways, its cells
  // placed by column key (styles/base.css): 'holders' a list of holders. Transactions and blocks stay tables.
  stack?: 'holders';
  // A name for the area's own rules (the explorer's column widths on a phone, the rows a phone shows).
  className?: string;
  // A line under a row that needs one (why an epoch was not counted), across the table and free to wrap; only in a table
  // that is not live.
  detail?: (row: T) => ReactNode | null;
}

export default function DataTable<T>({
  columns, rows, rowKey, tall = false, loadingRows = 10, empty, error, caption, title, meta, tools, live = false, scroll = true, stack, className,
  detail,
}: DataTableProps<T>) {
  const frame = useRef<HTMLDivElement>(null);
  const hold = useHold(rows, frame, rowKey, live);
  const shown = live ? hold.shown : rows;

  // Rows whose key was not in the previous list are new: tinted as they land (never on the first list).
  const fresh = useLanded(shown, rowKey, live);

  // The fade on the frame's right edge and the sticky column's edge show that more columns follow, only while they do.
  const [atEnd, setAtEnd] = useState(false);
  const [over, setOver] = useState(false);
  useEffect(() => {
    const el = frame.current;
    if (!el || !scroll) return;
    const check = () => {
      setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 2);
      setOver(el.scrollWidth > el.clientWidth + 1);
    };
    check();
    el.addEventListener('scroll', check, { passive: true });
    window.addEventListener('resize', check, { passive: true });
    return () => {
      el.removeEventListener('scroll', check);
      window.removeEventListener('resize', check);
    };
  }, [scroll, shown]);

  // While held, what waits instead of a moving list.
  const liveMeta = live ? <span className="label tbl-live"><HoldLabel hold={hold} /></span> : null;
  // A stacked row is laid out by CSS, which can drop a table's own semantics: the roles keep them.
  const role = (r: string) => (stack ? r : undefined);

  return (
    <div className={`tbl-block${className ? ` ${className}` : ''}`}>
      {(title || meta || liveMeta) && (
        <div className="tbl-head">
          {title ? <h2 className="tbl-title">{title}</h2> : <span />}
          {meta ?? liveMeta}
        </div>
      )}
      {tools}
      {error && <p className="tbl-error" role="alert">{error}</p>}
      <div
        ref={frame}
        className="tbl-frame"
        data-scroll={scroll || undefined}
        data-stack={stack}
        data-end={atEnd || undefined}
        data-over={over || undefined}
        {...(live ? hold.handlers : {})}
      >
        <table className="tbl" role={role('table')} style={{ '--tbl-min': `${tableMinWidth(columns)}px` } as CSSProperties}>
          <caption className="sr-only">{caption}</caption>
          <colgroup>
            {columns.map((c) => <col key={c.key} style={c.width ? { width: c.width } : undefined} />)}
          </colgroup>
          <thead role={role('rowgroup')}>
            <tr role={role('row')}>
              {columns.map((c) => <th key={c.key} scope="col" role={role('columnheader')} data-k={c.key} data-align={c.align} aria-sort={c.sort}>{c.header}</th>)}
            </tr>
          </thead>
          <tbody role={role('rowgroup')}>
            {shown === null
              ? Array.from({ length: loadingRows }, (_, i) => (
                <tr key={`pad-${i}`} className="tbl-pad" data-h={tall ? 2 : undefined} aria-hidden="true">
                  {columns.map((c) => <td key={c.key} data-k={c.key}>{' '}</td>)}
                </tr>
              ))
              : shown.length === 0
                ? (
                  <tr role={role('row')}>
                    <td className="tbl-empty" role={role('cell')} colSpan={columns.length}>{empty ?? 'Nothing here yet.'}</td>
                  </tr>
                )
                : shown.map((row, i) => {
                  const key = rowKey(row);
                  // A live table keeps each row element in its place and gives it the new content (cells keyed by the
                  // record), so a record arriving at the top moves no element: nothing shifts under the reader.
                  const more = detail?.(row) ?? null;
                  return (
                    <Fragment key={live ? `slot-${i}` : key}>
                      <tr role={role('row')} data-h={tall ? 2 : undefined} data-new={fresh.has(key) || undefined} data-more={more ? '' : undefined}>
                        {columns.map((c) => (
                          <td key={live ? `${key}:${c.key}` : c.key} role={role('cell')} data-k={c.key} data-align={c.align}>
                            {c.width ? c.cell(row) : <div className="tbl-fit">{c.cell(row)}</div>}
                          </td>
                        ))}
                      </tr>
                      {more && (
                        <tr className="tbl-detail">
                          <td colSpan={columns.length}><div className="tbl-detail-in">{more}</div></td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
