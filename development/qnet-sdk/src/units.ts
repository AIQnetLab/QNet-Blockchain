// Decimal amounts and base units, exact: BigInt and strings only, never floating point.
import { QNetError } from './errors.js';

/** Decimal places of QNC: 1 QNC = 10^9 nano-QNC. */
export const QNC_DECIMALS = 9;
const U64_MAX = (1n << 64n) - 1n;

/**
 * Base units of a decimal amount: "1.5" with 9 decimals is 1500000000n. Refuses a sign, an exponent, a fraction
 * longer than `decimals`, and anything above u64 (INVALID_AMOUNT). Zero is refused unless `allowZero`.
 */
export function parseUnits(amount: string, decimals: number = QNC_DECIMALS, { allowZero = false } = {}): bigint {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 38) throw new QNetError('INVALID_AMOUNT');
  const m = typeof amount === 'string' ? /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(amount) : null;
  if (!m || (m[2] !== undefined && m[2].length > decimals)) throw new QNetError('INVALID_AMOUNT');
  const value = BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt((m[2] ?? '').padEnd(decimals, '0') || '0');
  if (value > U64_MAX || (value === 0n && !allowZero)) throw new QNetError('INVALID_AMOUNT');
  return value;
}

/** The decimal text of `units` base units, trailing fraction zeros trimmed: 1500000000n with 9 decimals is "1.5". */
export function formatUnits(units: bigint | string, decimals: number = QNC_DECIMALS): string {
  const n = typeof units === 'bigint' ? units : /^(0|[1-9][0-9]*)$/.test(units) ? BigInt(units) : null;
  if (n === null || n < 0n || !Number.isSafeInteger(decimals) || decimals < 0 || decimals > 38) {
    throw new QNetError('INVALID_AMOUNT');
  }
  if (decimals === 0) return n.toString();
  const base = 10n ** BigInt(decimals);
  const fraction = (n % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction === '' ? (n / base).toString() : `${n / base}.${fraction}`;
}
