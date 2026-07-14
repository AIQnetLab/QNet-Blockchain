// ============================================================================
// Shared QRC-20 token amount formatting
// ============================================================================
// Token amounts are u64 base units on-chain. Each token declares its OWN
// `decimals`, so scaling MUST use that token's decimals — never the hardcoded
// QNC 1e9 formatter and never float math (u64 exceeds 2^53). All scaling here
// is exact BigInt/string math.

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

// Format `<amount> <SYMBOL>` in one shot.
export function formatTokenAmountWithSymbol(
  raw: string | number | bigint | undefined,
  decimals: number,
  symbol: string
): string {
  const amount = formatTokenAmount(raw, decimals);
  return symbol ? `${amount} ${symbol}` : amount;
}

// Group the integer part with thousands separators (works on arbitrarily long
// integer strings — no Number() round-trip).
function groupInteger(intStr: string): string {
  const neg = intStr.startsWith('-');
  const digits = neg ? intStr.slice(1) : intStr;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return neg ? `-${grouped}` : grouped;
}
