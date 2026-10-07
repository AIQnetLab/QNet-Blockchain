// Decimal strings and integer base units. Amounts never pass through floating point: a typed amount is
// parsed to a bigint of base units and formatted back from one.
import { DECIMALS } from './config.js';
import { WalletError } from './errors.js';

export { DECIMALS };
export const U64_MAX = (1n << 64n) - 1n;

const DECIMAL_RE = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

/**
 * Base units of a canonical decimal string ("12", "0.5", "1.000000001"; no sign, exponent, leading
 * zeros, bare dot or grouping).
 * @param {string} text
 * @param {number} decimals 0..18
 * @returns {bigint}
 * @throws {WalletError} INVALID_AMOUNT when malformed, more fraction digits than `decimals`, or above u64
 */
export function parseUnits(text, decimals) {
  if (typeof text !== 'string' || text.length > 40 || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new WalletError('INVALID_AMOUNT');
  }
  const match = DECIMAL_RE.exec(text);
  if (!match) throw new WalletError('INVALID_AMOUNT');
  const fraction = match[2] ?? '';
  if (fraction.length > decimals) throw new WalletError('INVALID_AMOUNT');
  const value = BigInt(match[1] + fraction.padEnd(decimals, '0'));
  if (value > U64_MAX) throw new WalletError('INVALID_AMOUNT');
  return value;
}

/**
 * Whether `text` parses with parseUnits and is greater than zero.
 * @param {string} text
 * @param {number} decimals
 * @returns {boolean}
 */
export function isPositiveAmount(text, decimals) {
  try {
    return parseUnits(text, decimals) > 0n;
  } catch {
    return false;
  }
}

/**
 * Canonical decimal string of base units, trailing fraction zeros dropped ("1.5", "0.00015", "0").
 * @param {bigint|string} value non-negative bigint or decimal digit string
 * @param {number} decimals 0..18
 * @returns {string}
 * @throws {WalletError} INVALID_AMOUNT for a negative, non-integer or malformed value
 */
export function formatUnits(value, decimals) {
  let n;
  if (typeof value === 'bigint') n = value;
  else if (typeof value === 'string' && /^[0-9]{1,40}$/.test(value)) n = BigInt(value);
  else throw new WalletError('INVALID_AMOUNT');
  if (n < 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new WalletError('INVALID_AMOUNT');
  const digits = n.toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}
