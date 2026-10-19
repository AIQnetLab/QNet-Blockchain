// What one change of a text field put in, for the fields that read a paste differently from typing. No platform
// module here, so the amount field's rules (utils/sendAmount) stay pure.

/** The text one change inserted: the part of `next` between the prefix and the suffix it shares with `prev`. */
export function insertedText(prev, next) {
  const a = String(prev || '');
  const b = String(next || '');
  const max = Math.min(a.length, b.length);
  let p = 0;
  while (p < max && a[p] === b[p]) p++;
  let s = 0;
  while (s < max - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return b.slice(p, b.length - s);
}
