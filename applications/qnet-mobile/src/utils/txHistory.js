// Transaction history assembly. The explorer archive holds the whole history and pages through it; a
// node holds about a day and is the freshest source. Both feed one list, merged with what the device
// already shows. Pure functions only: no network, no storage.

export const HISTORY_PAGE = 50;
// Background refreshes ask the explorer at most this often; a user-initiated load always asks.
export const EXPLORER_REFRESH_MS = 30 * 1000;
// How many confirmed rows survive a restart.
export const HISTORY_CACHE_MAX = 500;
// Newest rows the explorer may not have indexed yet: never dropped for being absent from its page.
const INDEX_LAG_GRACE_MS = 5 * 60 * 1000;

const lc = (s) => String(s || '').toLowerCase();

/**
 * Which way a transfer moved for this wallet: out, in, or back to itself. A transfer whose sender and
 * recipient are both this wallet moves no money — only its fee leaves — so it is its own direction
 * instead of an outgoing row showing a minus in front of an amount that never left.
 *
 * Every feed decides direction here: the explorer page, the node's transactions, a block event and the
 * row a fresh send adds. One answer per transfer, whichever source delivered it.
 */
export function txDirection(from, to, myAddress) {
  const me = lc(myAddress);
  const out = lc(from) === me;
  const inbound = lc(to) === me;
  if (out && inbound) return 'self';
  return out ? 'send' : 'receive';
}

export function fmtTokenBaseUnits(base, decimals) {
  const s = String(base == null ? '0' : base).replace(/[^0-9]/g, '') || '0';
  const d = Number(decimals) || 0;
  // Thousands-group an all-digit string directly (never via Number()) so no low-order digit is lost.
  const group = (digits) => digits.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (d <= 0) return group(s);
  const padded = s.padStart(d + 1, '0');
  const intPart = padded.slice(0, padded.length - d);
  const frac = padded.slice(padded.length - d).replace(/0+$/, '');
  const intFmt = group(intPart);
  return frac ? `${intFmt}.${frac}` : intFmt;
}

/** Identity of a row: a token transfer by (hash, log index), a batch credit by (hash, recipient index). */
export function historyRowKey(t) {
  if (t.nodeEvent) return t.hash;
  if (t.tokenContract) return `${t.hash}:t${t.tokenLogIndex}`;
  if (t.batchIndex != null) return `${t.hash}:b${t.batchIndex}`;
  return t.hash;
}

/**
 * A token transfer event (node shape: tx_hash, log_index, contract, from, to, amount, kind, std, token_id,
 * symbol, decimals, logo, timestamp in seconds) as a history row. Decimals and symbol come from the
 * wallet's own added-token list when it has the contract, never from the serving source alone, so the
 * trust badge never sits next to a magnitude a node or the explorer chose. An `archived` event is
 * already on chain; any other waits for its inclusion proof.
 */
export function tokenRowFromEvent(ev, myAddress, trustedTokenMeta) {
  const tm = trustedTokenMeta.get(lc(ev.contract));
  const dec = tm ? tm.decimals : (Number(ev.decimals) || 0);
  return {
    hash: ev.tx_hash,
    tokenLogIndex: ev.log_index,
    from: ev.from,
    to: ev.to,
    amount: 0,
    status: ev.archived ? 'confirmed' : 'pending',
    verified: false,
    timestamp: (Number(ev.timestamp) || 0) * 1000,
    type: txDirection(ev.from, ev.to, myAddress),
    fee: 0,
    tokenContract: ev.contract,
    tokenSymbol: tm ? tm.symbol : ev.symbol,
    tokenLogo: ev.logo,
    tokenStd: ev.std,
    tokenId: ev.token_id,
    tokenMetaTrusted: !!tm,
    // Raw fields, verbatim, for the logs_root leaf the inclusion proof binds.
    tokenKind: ev.kind,
    tokenRawAmount: String(ev.amount == null ? '' : ev.amount),
    tokenAmountDisplay: fmtTokenBaseUnits(String(ev.amount || '0'), dec),
  };
}

/**
 * Explorer history items → native rows and token events in the node's shape (so one mapping serves
 * both feeds). Rows this address is not a party to are dropped: the explorer is a convenience, not an
 * authority over whose history this is.
 */
export function splitExplorerItems(items, myAddress) {
  const me = lc(myAddress);
  const native = [];
  const tokenEvents = [];
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || typeof it.hash !== 'string' || (lc(it.from) !== me && lc(it.to) !== me)) continue;
    if (it.source === 'token') {
      tokenEvents.push({
        tx_hash: it.hash, log_index: it.idx, contract: it.contract, from: it.from, to: it.to, amount: it.amount,
        kind: it.kind, std: it.std, token_id: it.token_id, symbol: it.symbol, decimals: it.decimals, logo: it.logo,
        timestamp: Math.floor((Number(it.timestamp) || 0) / 1000), archived: true,
      });
      continue;
    }
    const direction = txDirection(it.from, it.to, myAddress);
    const send = direction !== 'receive'; // a self-transfer pays the fee like any other outgoing one
    native.push({
      hash: it.hash,
      ...(it.source === 'batch' ? { batchIndex: Number(it.idx) } : {}),
      txType: it.tx_type || undefined,
      from: it.from,
      to: it.to,
      amount: (Number(it.amount) || 0) / 1e9,
      status: 'confirmed',
      timestamp: Number(it.timestamp) || 0,
      type: direction,
      fee: send ? (Number(it.fee) || 0) / 1e9 : 0,
    });
  }
  return { native, tokenEvents };
}

const newestFirst = (a, b) => (b.timestamp || 0) - (a.timestamp || 0);

/** Rows by key, first occurrence wins, newest first. */
function unique(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const k = historyRowKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out.sort(newestFirst);
}

/**
 * The list after a refresh. Fresh rows replace their own keys. A confirmed row already shown and absent
 * from the fresh rows stays when it is older than the span the explorer page covered (`coveredFromMs`;
 * Infinity when the explorer did not answer): inside that span its absence means the chain no longer
 * has it. Pending rows sent from this wallet stay until a fresh row carries their hash. Node lifecycle
 * rows are kept only while their feed is down.
 */
export function mergeHistory(prev, fresh, { myAddress, coveredFromMs, nowMs, nodeEventsOk }) {
  const me = lc(myAddress);
  // A token row proven on an earlier pass stays proven while the same transfer comes back unproven.
  const prevByKey = new Map(prev.map((t) => [historyRowKey(t), t]));
  fresh = fresh.map((t) => {
    if (!t.tokenContract || t.status !== 'pending') return t;
    const p = prevByKey.get(historyRowKey(t));
    const same = p && p.status === 'confirmed' && p.tokenRawAmount === t.tokenRawAmount && lc(p.from) === lc(t.from) && lc(p.to) === lc(t.to);
    return same ? { ...t, status: 'confirmed', verified: !!p.verified } : t;
  });
  const freshKeys = new Set(fresh.map(historyRowKey));
  const freshHashes = new Set(fresh.map((t) => t.hash));
  const kept = prev.filter((t) => {
    if (t.status === 'pending') return lc(t.from) === me && !freshHashes.has(t.hash);
    if (freshKeys.has(historyRowKey(t))) return false;
    if (t.nodeEvent) return !nodeEventsOk;
    const ts = t.timestamp || 0;
    return ts < coveredFromMs || ts > nowMs - INDEX_LAG_GRACE_MS;
  });
  const pending = kept.filter((t) => t.status === 'pending');
  const rest = kept.filter((t) => t.status !== 'pending');
  return unique([...pending, ...fresh, ...rest]);
}

/** An older page appended to the list: rows already shown keep their current state. */
export function appendHistory(prev, older) {
  return unique([...prev, ...older]);
}

/** What goes to the device cache: confirmed rows only (a pending row is local intent, not history). */
export function cacheableHistory(rows) {
  return rows.filter((t) => t.status === 'confirmed').slice(0, HISTORY_CACHE_MAX);
}

/**
 * Does a row belong to the selected asset filter: 'all', 'qnc' (native and node lifecycle) or a token
 * contract. Filtering is local to the rows already held — the feed itself stays one paged list.
 */
export function matchesAsset(row, asset) {
  if (!asset || asset === 'all') return true;
  if (asset === 'qnc') return !row.tokenContract;
  return lc(row.tokenContract) === lc(asset);
}
