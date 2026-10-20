// My node's two pictures of the latest epochs (B-SPEC 5.19): the last 12 settled epochs as a strip of cells, and what
// each of the latest 16 added to the node balance, as bars with a marker at the newest one moved to the wallet. The rows
// are the history's, newest first. Pure.

import type { HistoryResult, HistoryRow } from './node-view.ts';

export const STRIP_EPOCHS = 12;
export const BAR_EPOCHS = 16;

// Counted (moved or not), not counted, or the network's own (not checked, not admitted, the registration's epoch, not
// readable): drawn as an outline.
export type CellTone = 'counted' | 'missed' | 'quiet';

export interface StripCell {
  epoch: number;
  result: HistoryResult;
  tone: CellTone;
}

const toneOf = (result: HistoryResult): CellTone => (result === 'counted' || result === 'moved' ? 'counted' : result === 'missed' ? 'missed' : 'quiet');

// The newest `count` epochs, oldest first.
export function lastEpochs(rows: readonly HistoryRow[], count = STRIP_EPOCHS): StripCell[] {
  return rows.slice(0, count).reverse().map((r) => ({ epoch: r.epoch, result: r.result, tone: toneOf(r.result) }));
}

// The cell the line under the strip names at rest: the newest epoch not counted, else the newest one; null with none.
export function stripRest(cells: readonly StripCell[]): StripCell | null {
  for (let i = cells.length - 1; i >= 0; i--) if (cells[i].tone === 'missed') return cells[i];
  return cells.length > 0 ? cells[cells.length - 1] : null;
}

// In the node balance, moved to the wallet, not counted (a low Ember tick), not checked (a low outline), or nothing.
export type BarKind = 'balance' | 'moved' | 'missed' | 'quiet' | 'none';

export interface Bar {
  epoch: number;
  kind: BarKind;
  amount: number | null;
  // 0..1 of the tallest bar.
  height: number;
}

export interface Bars {
  bars: Bar[];
  max: number;
  // The bar the marker stands after: the newest one moved to the wallet; null when none was.
  marker: number | null;
}

// The newest `count` epochs as bars, oldest first; null when none of them added anything (no picture to draw).
export function perEpochBars(rows: readonly HistoryRow[], count = BAR_EPOCHS): Bars | null {
  const shown = rows.slice(0, count).reverse();
  const max = shown.reduce((m, r) => Math.max(m, r.amountQnc ?? 0), 0);
  if (!(max > 0)) return null;
  const bars = shown.map((r): Bar => {
    const amount = r.amountQnc !== null && r.amountQnc > 0 ? r.amountQnc : null;
    const kind: BarKind = amount !== null ? (r.result === 'moved' ? 'moved' : 'balance')
      : r.result === 'missed' ? 'missed' : r.result === 'unchecked' || r.result === 'not_admitted' ? 'quiet' : 'none';
    return { epoch: r.epoch, kind, amount, height: amount === null ? 0 : amount / max };
  });
  let marker: number | null = null;
  bars.forEach((b, i) => {
    if (b.kind === 'moved') marker = i;
  });
  return { bars, max, marker };
}
