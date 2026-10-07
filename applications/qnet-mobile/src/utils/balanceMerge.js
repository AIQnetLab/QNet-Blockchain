// Merge a balance read into what the Assets tab shows. A failed read (null) keeps the last-known value, and
// one unverified node may not lower QNC (it could be lagging) — but both rules hold only for the same
// address: balances read for another wallet start from zero, so a new wallet never shows the old one's.
// A lower figure at least two genesis nodes agree on (`agreed`) is not a lagging node: it lowers the balance, so a
// spend made elsewhere (the in-app browser, the extension, anyone holding the phrase) shows (MOBNET-R3-04).
// Nothing changed for the same address: `prev` itself, so the screen does not render again for it.
export function mergeTokenBalances(prev, { owner, sol, oneDev, qnc, verified, optimistic, agreed }) {
  const same = !!prev && prev.owner === owner;
  const base = same ? prev : { owner, qnc: 0, sol: 0, '1dev': 0 };
  const next = { ...base, owner };
  if (sol != null) next.sol = sol;
  if (oneDev != null) next['1dev'] = oneDev;
  if (qnc != null) {
    next.qnc = (same && !optimistic && !verified && !agreed && qnc < (base.qnc || 0)) ? base.qnc : qnc;
  }
  if (same && next.qnc === prev.qnc && next.sol === prev.sol && next['1dev'] === prev['1dev']) return prev;
  return next;
}

/**
 * A token row of the Assets list after this wallet sent `sentBase` base units of `contract` (not to itself): the
 * optimistic balance, current minus sent. No proof covers that figure, so the row loses its "verified" mark in the same
 * update (MOBNET-R4-03), as the QNC balance does (MOBNET-R3-04); the next token reload brings a proven one back. `wm`
 * gives the decimal conversions (WalletManager.toBaseUnits, _formatBaseUnits).
 */
export function optimisticTokenRow(row, contract, toSelf, sentBase, decimals, wm) {
  if (!row || row.contract !== contract || toSelf) return row;
  try {
    const cur = BigInt(wm.toBaseUnits(String(row.balance || '0'), decimals));
    const sent = BigInt(sentBase);
    const next = cur > sent ? (cur - sent) : 0n;
    return { ...row, balance: wm._formatBaseUnits(next.toString(), decimals), verified: false };
  } catch (_) {
    return { ...row, verified: false };
  }
}
