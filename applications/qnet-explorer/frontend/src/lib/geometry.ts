// Sizes the site computes from its data instead of measuring the page, so nothing moves after it renders:
// the width a table's columns need (components/ui/DataTable.tsx, styles/base.css --tbl-min), the length of a readout's
// value in characters (components/ui/Readouts.tsx, styles/base.css --ro-len) and the lines of a picture's label.

// A flexible column's width in a sideways-scrolling frame unless it names its own: one side in its short form.
export const FLEX_MIN = 176;

// The table's mono character (12.5 px at 80 % width) and a cell's right padding, in px.
const TABLE_CH = 7.75;
const CELL_PAD = 14;

// From / To on one line in a sideways frame: both sides in their longest short form (a node id's 20 characters) and "to".
export const FROM_TO_MIN = Math.ceil((20 + 4 + 20) * TABLE_CH) + CELL_PAD;

// An exact amount's column: 20 characters ("1,234,567.123456789" and a sign), the 16 px icon, "QNC" and their gaps.
export const AMOUNT_W = Math.ceil((20 + 3) * TABLE_CH + 16 + 12) + CELL_PAD;

// A column's width kept for one view of a list (its page, sort and filter): the widest its rows needed while the reader
// stayed on it, so a long amount that leaves the live rows does not move From / To under the reader; a new view starts
// from its own rows.
export interface SteadyWidth {
  view: string;
  width: number;
}
export function steadyWidth(kept: SteadyWidth | null, view: string, width: number): SteadyWidth {
  return kept !== null && kept.view === view && kept.width >= width ? kept : { view, width };
}

// An amount column wide enough for the longest of its values with its unit (a token's exact supply can run past the 20
// characters AMOUNT_W holds), the icon and their gaps as AMOUNT_W counts them; never narrower than `least`.
export function amountWidth(amounts: readonly { value: string; unit: string }[], least: number = AMOUNT_W): number {
  return Math.max(least, Math.ceil(longestAmount(amounts) * TABLE_CH + 16 + 12) + CELL_PAD);
}
const longestAmount = (amounts: readonly { value: string; unit: string }[]): number =>
  Math.max(0, ...amounts.map((a) => a.value.length + textLength(a.unit)));

// The same longest amount in the table's characters, the icon and gaps included: where a phone gives an amount a line
// narrower than that, it is set smaller by this length (styles/base.css .tbl-amt), never cut.
export const amountChars = (amounts: readonly { value: string; unit: string }[]): number =>
  longestAmount(amounts) + (16 + 12) / TABLE_CH;

// The longest of some words in the page's language (its ages) in characters of the table's face, the bidi marks around a
// number left out: what a box that shows any of them holds.
export const wordsLength = (words: readonly string[]): number =>
  Math.max(...words.map((w) => textLength(w.replace(/[⁦-⁩]/g, ''), 0.62)));

// A column of such words: their longest in the table's characters, with the padding.
export function wordsWidth(words: readonly string[]): number {
  return Math.ceil(wordsLength(words) * TABLE_CH) + CELL_PAD;
}

// The width a table's columns need; its sideways frame never gives it less.
export function tableMinWidth(columns: readonly { width?: number; min?: number }[]): number {
  return columns.reduce((sum, c) => sum + (c.width ?? c.min ?? FLEX_MIN), 0);
}

// Chinese, Japanese and Korean characters and the full-width forms (East Asian Wide and Fullwidth) are one em wide in
// any face. Chinese breaks a line between any two of its characters, Japanese where a run of hiragana ends (a phrase
// ends with its particle), Korean only between words.
const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6\u{20000}-\u{3FFFD}]/u;
const HAN_KANA = /[\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\u{20000}-\u{3FFFD}]/u;
const KANA = /[\u3041-\u30FF\u31F0-\u31FF\uFF66-\uFF9F]/u;
const HIRAGANA = /[\u3041-\u309F]/u;
// A line never starts with closing punctuation or a small kana, and never ends with an opening bracket.
const CLOSE = /[、。，．・：；？！）」』】〕〉》〙〗〟]/u;
const NO_START = /[、。，．,.:;?!：；？！）)\]｝}」』】〕〉》〙〗〟’”ー々ゝゞヽヾぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶ・…‥〜]/u;
const NO_END = /[（(\[｛{「『【〔〈《〘〖〝‘“]/u;

// Arabic letters in the script's own faces (i18n.css --f-script) average .55 em, about what a length counts a Latin
// character at; a short value of wide letters (a reading's status, a section's datum) runs to .72 em a letter (the 95th
// percentile of the site's Arabic words of six letters or more, measured in the browser), so a value set smaller by its
// length counts each Arabic letter that much.
const ARABIC = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/u;
export const ARABIC_VALUE_EM = 0.72;

// A text's length in characters of a face whose Latin characters average `em` of its size: a wide character counts
// 1 / em of them and an Arabic letter `arabic` / em (a value set smaller by its length passes ARABIC_VALUE_EM), so a
// length says what fits a width in every script, never the count of letters.
export function textLength(text: string, em = 0.6, arabic = em): number {
  let length = 0;
  for (const ch of text) length += WIDE.test(ch) ? 1 / em : ARABIC.test(ch) ? arabic / em : 1;
  return length;
}

// A readout value's length in characters of the value's own size: a unit is half size after a gap, a mark (the live
// dot) about one and a half. The value is set smaller when this many characters would not fit the reading.
export function readoutLength(value: string, unit?: string, mark = false): number {
  return textLength(value, 0.6, ARABIC_VALUE_EM) + (unit ? 0.5 + textLength(unit) / 2 : 0) + (mark ? 1.6 : 0);
}

// An amount at a reading's size (a readout's value, My node's balance figure): the number, a space and its unit as large,
// and the token's icon, 1.25 em with its .4 em gap (styles/base.css .tok-text, .ent-unit), in characters of .6 em.
export const ICON_CH = (1.25 + 0.4) / 0.6;
export function amountLength(value: string, unit: string): number {
  return textLength(`${value} ${unit}`) + ICON_CH;
}

// Whether a line may end between `a` and `b` inside a run without spaces (`phrases`: Japanese, by its phrases).
function breaks(a: string, b: string, phrases: boolean): boolean {
  if (NO_START.test(b) || NO_END.test(a)) return false;
  const wa = HAN_KANA.test(a);
  if (wa !== HAN_KANA.test(b)) return true;
  if (!wa) return false;
  return !phrases || CLOSE.test(a) || NO_END.test(b) || (HIRAGANA.test(a) && !HIRAGANA.test(b));
}

// The pieces a line may end after: a word with the space before it, or a run of Chinese or Japanese with the
// punctuation that may not stand apart from it. QNet Blockchain, QNet Wallet and QNet Link are never broken.
function linePieces(text: string, phrases = KANA.test(text)): string[] {
  const out: string[] = [];
  text.replace(/QNet (Blockchain|Wallet|Link)/g, 'QNet\u00a0$1').split(' ').forEach((word, i) => {
    const chars = [...word];
    let piece = i > 0 ? ' ' : '';
    chars.forEach((ch, j) => {
      if (j > 0 && breaks(chars[j - 1], ch, phrases)) {
        out.push(piece);
        piece = '';
      }
      piece += ch;
    });
    out.push(piece);
  });
  return out;
}

// The lines of a picture's label that fit `width` at `size` in a face whose Latin characters average `em`, at most
// `most`: the last one kept then ends in … (taken as an em wide), giving up its last word or character for it. A piece
// longer than a line breaks between its characters, a Japanese phrase as Chinese does and any other word as a last resort.
export function fitLines(text: string, width: number, size: number, em = 0.56, most = 4): string[] {
  const max = Math.max(4, Math.floor(width / (size * em)));
  const pieces = linePieces(text).flatMap((p) => {
    if (textLength(p.trim(), em) <= max) return [p];
    const chars = linePieces(p, false).filter(Boolean);
    return chars.length > 1 ? chars : [...p];
  });
  const lines: string[] = [];
  let line = '';
  for (const piece of pieces) {
    if (line === '') line = piece.trimStart();
    else if (textLength(line + piece, em) <= max) line += piece;
    else {
      lines.push(line);
      line = piece.trimStart();
    }
  }
  if (line !== '') lines.push(line);
  if (lines.length <= most) return lines;
  const kept = lines.slice(0, most);
  let last = kept[most - 1];
  while (textLength(last, em) + 1 / em > max && [...last].length > 1) {
    const space = last.lastIndexOf(' ');
    last = space > 0 && !HAN_KANA.test(last.slice(-1)) ? last.slice(0, space) : [...last].slice(0, -1).join('');
  }
  kept[most - 1] = `${last}…`;
  return kept;
}
