// Sizes the site computes from its data instead of measuring the page, so nothing moves after it renders (B-SPEC 3):
// the width a table's columns need (components/ui/DataTable.tsx, styles/base.css --tbl-min) and the length of a readout's
// value in characters (components/ui/Readouts.tsx, styles/base.css --ro-len).

// A flexible column's width in a sideways-scrolling frame unless it names its own: one side in its short form.
export const FLEX_MIN = 176;

// The table's mono character (12.5 px at 80 % width) and a cell's right padding, in px.
const TABLE_CH = 7.75;
const CELL_PAD = 14;

// From / To on one line in a sideways frame: both sides in their longest short form (a node id's 20 characters) and "to".
export const FROM_TO_MIN = Math.ceil((20 + 4 + 20) * TABLE_CH) + CELL_PAD;

// An exact amount's column: 20 characters ("1,234,567.123456789" and a sign), the 16 px icon, "QNC" and their gaps.
export const AMOUNT_W = Math.ceil((20 + 3) * TABLE_CH + 16 + 12) + CELL_PAD;

// The width a table's columns need; its sideways frame never gives it less.
export function tableMinWidth(columns: readonly { width?: number; min?: number }[]): number {
  return columns.reduce((sum, c) => sum + (c.width ?? c.min ?? FLEX_MIN), 0);
}

// A readout value's length in characters of the value's own size: a unit is half size after a gap, a mark (the live
// dot) about one and a half. The value is set smaller when this many characters would not fit the reading.
export function readoutLength(value: string, unit?: string, mark = false): number {
  return value.length + (unit ? 0.5 + unit.length / 2 : 0) + (mark ? 1.6 : 0);
}
