// ============================================================================
// Exact amount formatting: QRC-20 tokens and QNC
// ============================================================================
// Amounts are integer base units on chain (u64, past 2^53), so all scaling here
// is BigInt/string math, never a float. A token is scaled by its own `decimals`,
// QNC by QNC_DECIMALS (formatQnc; the cabinet re-exports it). The whole part is
// grouped as English writes it.

// Format a raw base-unit amount (u64) into a human decimal string using the
// token's own `decimals`. Trailing zeros in the fractional part are trimmed;
// the integer part is grouped with thousands separators.
//
//   formatTokenAmount('1500000000', 9) -> '1.5'
//   formatTokenAmount('1000000', 6)    -> '1'
//   formatTokenAmount('123', 0)        -> '123'
export function formatTokenAmount(raw: string | number | bigint | undefined, decimals: number): string {
  if (raw === undefined || raw === null) return '0';

  let value: bigint;
  try {
    // Accept string (authoritative for >2^53), number, or bigint. For a number,
    // route through a trimmed integer string so we never introduce float error.
    if (typeof raw === 'bigint') {
      value = raw;
    } else if (typeof raw === 'number') {
      if (!Number.isFinite(raw)) return '0';
      value = BigInt(Math.trunc(raw));
    } else {
      const trimmed = raw.trim();
      if (trimmed === '') return '0';
      // Strip a decimal tail if the source ever provided one (base units are integers).
      value = BigInt(trimmed.split('.')[0]);
    }
  } catch {
    return '0';
  }

  // BigInt literals (0n/10n) require ES2020; this app targets ES2017, so all
  // BigInt constants use the BigInt() constructor (valid on the ES2017 lib).
  const ZERO = BigInt(0);
  if (value < ZERO) value = -value; // balances are non-negative; guard anyway

  const dec = Number.isInteger(decimals) && decimals >= 0 && decimals <= 30 ? decimals : 9;

  if (dec === 0) {
    return groupInteger(value.toString());
  }

  const base = BigInt(10) ** BigInt(dec);
  const intPart = value / base;
  const fracPart = value % base;

  const intStr = groupInteger(intPart.toString());
  if (fracPart === ZERO) return intStr;

  // Left-pad fractional to `dec` digits, then trim trailing zeros.
  let fracStr = fracPart.toString().padStart(dec, '0').replace(/0+$/, '');
  return fracStr ? `${intStr}.${fracStr}` : intStr;
}

// QNC's base unit is the nano QNC.
export const QNC_DECIMALS = 9;

// Nano QNC as exact QNC: formatQnc('12345678901234') -> '12,345.678901234'.
export function formatQnc(nano: string | number | bigint | undefined): string {
  return formatTokenAmount(nano, QNC_DECIMALS);
}

// The same, cut (never rounded) to exactly `places` decimals: formatQncTruncated('12345600000000', 2) -> '12,345.60'.
export function formatQncTruncated(nano: string | number | bigint | undefined, places: number): string {
  const [whole, fraction = ''] = formatQnc(nano).split('.');
  return places > 0 ? `${whole}.${fraction.padEnd(places, '0').slice(0, places)}` : whole;
}

// Group the integer part with thousands separators (works on arbitrarily long
// integer strings — no Number() round-trip).
function groupInteger(intStr: string): string {
  const neg = intStr.startsWith('-');
  const digits = neg ? intStr.slice(1) : intStr;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return neg ? `-${grouped}` : grouped;
}
