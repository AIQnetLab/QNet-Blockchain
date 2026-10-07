// The QNet Send screen's 25 / 50 / 75 % and MAX buttons. Pure functions only.

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
