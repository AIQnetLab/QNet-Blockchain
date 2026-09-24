// Merge a balance read into what the Assets tab shows. A failed read (null) keeps the last-known value, and
// an unverified node may not lower QNC (it could be lagging) — but both rules hold only for the same
// address: balances read for another wallet start from zero, so a new wallet never shows the old one's.
export function mergeTokenBalances(prev, { owner, sol, oneDev, qnc, verified, optimistic }) {
  const same = !!prev && prev.owner === owner;
  const base = same ? prev : { owner, qnc: 0, sol: 0, '1dev': 0 };
  const next = { ...base, owner };
  if (sol != null) next.sol = sol;
  if (oneDev != null) next['1dev'] = oneDev;
  if (qnc != null) {
    next.qnc = (same && !optimistic && !verified && qnc < (base.qnc || 0)) ? base.qnc : qnc;
  }
  return next;
}
