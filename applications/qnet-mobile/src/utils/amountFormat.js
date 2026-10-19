// Amounts as the app's language writes them: the whole part grouped by three and the language's decimal mark, put
// into an exact decimal string with string operations only, so a 64- or 128-bit figure keeps every digit.

const symbolsOf = (group, decimal, groupFrom = 4) => Object.freeze({ group, decimal, groupFrom });
const COMMA_POINT = symbolsOf(',', '.');
const POINT_COMMA = symbolsOf('.', ',');

// The symbols when the platform's number formatting throws or writes other digits. `groupFrom`: the shortest whole
// part that is grouped (Spanish and Italian leave four digits as they are).
const FALLBACK = Object.freeze({
  en: COMMA_POINT, ja: COMMA_POINT, ko: COMMA_POINT, 'zh-CN': COMMA_POINT, ar: COMMA_POINT,
  ru: symbolsOf('\u00A0', ','), fr: symbolsOf('\u202F', ','),
  de: POINT_COMMA, pt: POINT_COMMA, es: symbolsOf('.', ',', 5), it: symbolsOf('.', ',', 5),
});

// The app writes figures in Latin digits in every language.
const TAGS = { ar: 'ar-u-nu-latn' };

// The language's symbols as the platform formats 1234567.5 and 1234, or null when it writes anything else.
function probe(lang) {
  try {
    const format = new Intl.NumberFormat(TAGS[lang] || lang);
    const m = /^1([^0-9])234(?:\1)567([^0-9])5$/.exec(format.format(1234567.5));
    if (!m || m[1] === m[2]) return null;
    const short = format.format(1234);
    if (short === '1234' || short === `1${m[1]}234`) return symbolsOf(m[1], m[2], short === '1234' ? 5 : 4);
  } catch (_) { /* no number formatting for this language: the table */ }
  return null;
}

const symbols = new Map();

/** { group, decimal, groupFrom } of a language, read from the platform once and kept. */
export function amountSymbols(lang) {
  const key = typeof lang === 'string' && lang ? lang : 'en';
  if (!symbols.has(key)) symbols.set(key, probe(key) || FALLBACK[key] || FALLBACK.en);
  return symbols.get(key);
}

/**
 * A canonical decimal (digits, at most one '.', an optional sign: '-2047243.4405') as `lang` writes it
 * ('-2,047,243.4405' in English, '-2 047 243,4405' in Russian); any other text comes back as it was.
 */
export function amountText(value, lang) {
  const text = value == null ? '' : String(value);
  const m = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) return text;
  const [, sign, whole, fraction] = m;
  const { group, decimal, groupFrom } = amountSymbols(lang);
  const grouped = whole.length < groupFrom ? whole : whole.replace(/\B(?=(\d{3})+$)/g, () => group);
  return `${sign}${grouped}${fraction === undefined ? '' : decimal + fraction}`;
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
 * Nano QNC as every screen shows it, exact, in the figures of `lang` with the symbol ("1,500.5 QNC"): '••••' while the
 * user hides amounts, '—' when it is not known (not read yet, or no node answered; never "0 QNC").
 */
export function qncText(nano, lang, hidden = false) {
  if (hidden) return '••••';
  const qnc = formatNano(nano);
  return qnc === '—' ? qnc : `${amountText(qnc, lang)} QNC`;
}
