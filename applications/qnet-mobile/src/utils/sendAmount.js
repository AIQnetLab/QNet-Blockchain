// The QNet Send screen's 25 / 50 / 75 % and MAX buttons, and what the amount field of both Send forms keeps.
// Pure functions only.
import { amountSymbols } from './amountFormat';
import { insertedText } from './textEdit';

const QNC_DECIMALS = 9;
const QNC_SHOWN = 5;
const TOKEN_SHOWN_MAX = 6;

// A non-negative decimal figure as whole base units of `decimals`, digits past them cut; null when it is not one.
function baseUnits(text, decimals) {
  const s = String(text == null ? '' : text).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [int, frac = ''] = s.split('.');
  return BigInt(int + frac.slice(0, decimals).padEnd(decimals, '0'));
}

// The figure on screen as a decimal string (a float never goes through BigInt itself).
const numberText = (n, decimals) => (Number.isFinite(n) && n > 0 ? n.toFixed(Math.min(decimals, 20)) : '0');

function fixed(units, dp) {
  const s = units.toString().padStart(dp + 1, '0');
  return dp === 0 ? s : `${s.slice(0, s.length - dp)}.${s.slice(-dp)}`;
}

/**
 * What a percentage button puts in the amount field (L-9): `percentage` of what may be sent, floored, written with as
 * many decimals as the asset takes. A QNet token: at most six and never more than its own decimals, so a token of 2
 * decimals gets 2 and one of 0 a whole number (a token refuses an amount with more: WalletManager.toBaseUnits); QNC:
 * five, after its fee (`feeNano`). Worked out in whole base units with BigInt, from the token's exact balance
 * (`balanceText`, a decimal string) when the screen has it, so no digit of a large balance is lost.
 */
export function amountShare({ contract = null, decimals = 0, balanceText = null, balance = 0, feeNano = 0, percentage }) {
  const pct = BigInt(Math.max(0, Math.min(100, Math.floor(Number(percentage) || 0))));
  if (contract) {
    const d = Math.max(0, Math.floor(Number(decimals) || 0));
    const dp = Math.min(TOKEN_SHOWN_MAX, d);
    const held = baseUnits(balanceText, d) ?? baseUnits(numberText(Number(balance), d), d) ?? 0n;
    return fixed((held * pct / 100n) / 10n ** BigInt(d - dp), dp);
  }
  const held = baseUnits(numberText(Number(balance), QNC_DECIMALS), QNC_DECIMALS) ?? 0n;
  const fee = BigInt(Math.max(0, Math.floor(Number(feeNano) || 0)));
  const spendable = held > fee ? held - fee : 0n;
  return fixed((spendable * pct / 100n) / 10n ** BigInt(QNC_DECIMALS - QNC_SHOWN), QNC_SHOWN);
}

// What separates thousands without being a separator the field keeps: spaces of every width (a no-break space
// included), apostrophes and the Arabic thousands separator.
const GROUPING_MARKS = /[\s'\u2019\u02BC\u066C]/g;
// Arabic-Indic digits of both forms and the Arabic decimal separator, read as Latin digits and '.'.
const ARABIC_FIGURES = /[\u0660-\u0669\u06F0-\u06F9\u066B]/g;
const latinFigure = (ch) => {
  if (ch === '\u066B') return '.';
  const code = ch.charCodeAt(0);
  return String(code - (code >= 0x06F0 ? 0x06F0 : 0x0660));
};
const THOUSANDS = { ',': /^\d{1,3}(,\d{3})+$/, '.': /^\d{1,3}(\.\d{3})+$/ };
const groupsOfThree = (text, mark) => THOUSANDS[mark].test(text);
const count = (text, ch) => text.split(ch).length - 1;

/**
 * The amount field's text as both Send forms keep it: digits and at most one decimal point, no more than `decimals`
 * places, a leading point given its zero; or null when the text is refused and the field keeps what it had. Spaces,
 * apostrophes and anything but digits (Arabic-Indic ones read as digits), ',' and '.' go. A single ',' is the decimal
 * separator. When ',' and '.' both appear, the last one is the decimal separator and the other may only group thousands
 * (one to three digits, then groups of exactly three); several of one separator alone may only group thousands too.
 * Anything else is refused rather than read as another figure: 1,000.50 is 1000.50 and never 1.00050.
 * A paste over `previous` (the field's text; more than one character put in) is read as `lang` writes figures: its
 * group symbol once, after one to three digits (no leading zero) and before exactly three, groups them, so a copied
 * "1,000" in English or "1.000" in German is 1000. Typed text keeps the rule above, so "1,000" typed is 1.000.
 */
export function amountInput(text, decimals, { previous = null, lang } = {}) {
  const raw = String(text == null ? '' : text);
  const pasted = typeof previous === 'string' && insertedText(previous, raw).length > 1;
  let s = raw.replace(ARABIC_FIGURES, latinFigure).replace(GROUPING_MARKS, '').replace(/[^0-9.,]/g, '');
  const commas = count(s, ',');
  const dots = count(s, '.');
  const single = commas + dots === 1 ? (commas ? ',' : '.') : null;
  if (single && pasted && single === amountSymbols(lang).group && s[0] !== '0' && groupsOfThree(s, single)) {
    s = s.replace(single, '');
  } else if (commas > 0 && dots > 0) {
    const at = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'));
    const point = s[at];
    const mark = point === '.' ? ',' : '.';
    // The decimal separator once, with a figure after it (a separator typed at the end of an amount is no grouping).
    if (count(s, point) > 1 || at === s.length - 1) return null;
    const whole = s.slice(0, at);
    if (!groupsOfThree(whole, mark)) return null;
    s = `${whole.split(mark).join('')}.${s.slice(at + 1)}`;
  } else if (commas > 1 || dots > 1) {
    const mark = commas > 1 ? ',' : '.';
    if (!groupsOfThree(s, mark)) return null;
    s = s.split(mark).join('');
  } else if (commas === 1) {
    s = s.replace(',', '.');
  }
  if (s.startsWith('.')) s = `0${s}`;
  const dot = s.indexOf('.');
  const places = Math.max(0, Math.floor(Number(decimals) || 0));
  if (dot >= 0) s = `${s.slice(0, dot + 1)}${s.slice(dot + 1, dot + 1 + places)}`;
  return s.slice(0, 32);
}
