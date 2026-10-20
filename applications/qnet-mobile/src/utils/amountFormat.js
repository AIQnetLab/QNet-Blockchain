// Amounts in one format in every language: the whole part grouped by three with ',' and the decimals after '.'
// (42,578.81988), put into an exact decimal string with string operations only, so a 64- or 128-bit figure keeps every
// digit. Never a language's own marks: an amount is read, copied and compared across languages, and the amount field
// takes the same point. The extension bundles this module (its crypto bundle's amounts.js).

/** The thousands mark and the decimal mark of every amount. */
export const AMOUNT_GROUP = ',';
const AMOUNT_POINT = '.';

/**
 * A canonical decimal (digits, at most one '.', an optional sign: '-2047243.4405') as every screen writes it
 * ('-2,047,243.4405'); any other text comes back as it was.
 */
export function amountText(value) {
  const text = value == null ? '' : String(value);
  const m = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) return text;
  const [, sign, whole, fraction] = m;
  const grouped = whole.replace(/\B(?=(\d{3})+$)/g, AMOUNT_GROUP);
  return `${sign}${grouped}${fraction === undefined ? '' : AMOUNT_POINT + fraction}`;
}

/** Nano QNC (decimal text or a safe whole number) as an exact QNC decimal, "1500000000" → "1.5"; else '—'. */
export function formatNano(nano) {
  const text = Number.isSafeInteger(nano) && nano >= 0 ? String(nano) : nano;
  if (typeof text !== 'string' || !/^\d+$/.test(text)) return '—';
  const v = BigInt(text);
  const frac = (v % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return frac ? `${v / 1_000_000_000n}.${frac}` : (v / 1_000_000_000n).toString();
}

/**
 * Nano QNC as every screen shows it, exact, with the symbol ("1,500.5 QNC"): '••••' while the user hides amounts, '—'
 * when it is not known (not read yet, or no node answered; never "0 QNC").
 */
export function qncText(nano, hidden = false) {
  if (hidden) return '••••';
  const qnc = formatNano(nano);
  return qnc === '—' ? qnc : `${amountText(qnc)} QNC`;
}
