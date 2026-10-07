// Transaction history assembly. The explorer archive holds the whole history and pages through it; a
// node holds about a day and is the freshest source. Both feed one list, merged with what the device
// already shows. Pure functions only: no network, no storage.

export const HISTORY_PAGE = 50;
// How many confirmed rows survive a restart.
export const HISTORY_CACHE_MAX = 500;
// Newest rows the explorer may not have indexed yet: never dropped for being absent from its page.
const INDEX_LAG_GRACE_MS = 5 * 60 * 1000;
// How long a transaction sent from this wallet stays Pending without any source reporting it: as long as a node may
// still hold it (services/PendingTx mayLandUntil): the wallet sends it again by itself for up to AUTO_SEND_MS (30 min)
// after signing, and a node keeps each copy for NODE_MEMPOOL_TTL_MS (30 min), plus LANDING_MARGIN_MS (5 min). Past it,
// a row still absent from every fresh answer is not found: no node holds it any more. (This file imports nothing; the
// sum is checked against PendingTx in __tests__/App0610.test.js.)
export const PENDING_ROW_MAX_MS = (30 + 30 + 5) * 60 * 1000;

const lc = (s) => String(s || '').toLowerCase();
// The block a source names for a row (a whole number), shown on the transaction's detail screen; null otherwise.
const blockOf = (v) => (Number.isSafeInteger(Number(v)) && Number(v) >= 0 && v !== null && v !== '' && v !== undefined ? Number(v) : null);

/**
 * What a node's answer to GET /api/v1/transaction/{hash} says about that transaction (MOBNET-R2-01):
 * 'included' only when a block holds it (a block height and a status that is not the mempool's 'pending'),
 * 'pending' while it only sits in a mempool, 'absent' when the node does not know it, 'unknown' otherwise.
 * A node looks in its mempool first, so "found" alone never means "in a block".
 */
export function txLookupState(answer, txHash) {
  if (!answer || typeof answer !== 'object') return 'unknown';
  if (answer.status === 'not_found') return 'absent';
  const tx = answer.transaction;
  if (answer.status !== 'found' || !tx || typeof tx !== 'object') return 'unknown';
  if (txHash && tx.hash && lc(tx.hash) !== lc(txHash)) return 'unknown';
  const height = tx.block_height;
  const inBlock = typeof height === 'number' && Number.isSafeInteger(height) && height >= 0;
  if (tx.status === 'pending' || !inBlock) return tx.status === 'pending' ? 'pending' : 'unknown';
  return tx.status === 'confirmed' ? 'included' : 'unknown';
}

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
    ...(blockOf(ev.block) !== null ? { block: blockOf(ev.block) } : {}),
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
        timestamp: Math.floor((Number(it.timestamp) || 0) / 1000), archived: true, block: it.block,
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
      ...(blockOf(it.block) !== null ? { block: blockOf(it.block) } : {}),
    });
  }
  return { native, tokenEvents };
}

/**
 * A native transfer as one node reports it (node shape: hash, tx_type, from/to, amount and fee in nanoQNC,
 * timestamp in seconds). Nothing proves a node's history row, so it is 'reported', not 'confirmed': the
 * explorer archive's row for the same transaction replaces it once indexed (its row comes first in a merge).
 */
export function nodeNativeRow(tx, myAddress) {
  const from = tx.from || tx.sender;
  const to = tx.to || tx.recipient;
  return {
    hash: tx.hash || tx.tx_hash,
    txType: tx.tx_type,
    from,
    to,
    amount: (Number(tx.amount) || 0) / 1e9,
    status: 'reported',
    timestamp: (Number(tx.timestamp) || 0) * 1000,
    type: txDirection(from, to, myAddress),
    fee: (Number(tx.fee || tx.gas_used) || 0) / 1e9,
    ...(blockOf(tx.block_height) !== null ? { block: blockOf(tx.block_height) } : {}),
  };
}

const newestFirst = (a, b) => (b.timestamp || 0) - (a.timestamp || 0);

/**
 * Rows by key, first occurrence wins, newest first. A node's 'reported' row goes whenever a confirmed row carries the
 * same hash under any key: a batch payment's archive row is `hash:bN` and the node's is the bare hash, the same payment
 * (M11). A row sent from here that is still pending or was not found goes whenever a confirmed, failed or reported row
 * carries its hash (L-10): an older page that holds the send, scrolled to after it was marked not found, settles it.
 */
function unique(rows) {
  const confirmed = new Set(rows.filter((r) => r.status === 'confirmed').map((r) => lc(r.hash)));
  const known = new Set(rows.filter((r) => r.hash && (r.status === 'confirmed' || r.status === 'failed' || r.status === 'reported'))
    .map((r) => lc(r.hash)));
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const k = historyRowKey(r);
    if (seen.has(k) || (r.status === 'reported' && confirmed.has(lc(r.hash)))) continue;
    if ((r.status === 'pending' || r.status === 'dropped') && known.has(lc(r.hash))) continue;
    seen.add(k);
    out.push(r);
  }
  return out.sort(newestFirst);
}

/**
 * The rows sent from here that a merge of `fresh` at `nowMs` would mark not found: still pending PENDING_ROW_MAX_MS
 * after they were sent, with no fresh row carrying their hash. The screen asks the chain about each by its nonce first
 * (L-10): fifty newer rows can push a send that landed off every fresh page, and a hedged copy can land under another
 * hash; mergeHistory then takes the answers as `settled`.
 */
export function rowsDueToDrop(prev, fresh, { myAddress, nowMs }) {
  const me = lc(myAddress);
  const freshHashes = new Set((fresh || []).map((t) => t.hash));
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  return (prev || []).filter((t) => t.status === 'pending' && lc(t.from) === me && !freshHashes.has(t.hash)
    && now - (t.timestamp || 0) >= PENDING_ROW_MAX_MS);
}

/**
 * The list after a refresh. Fresh rows replace their own keys. A confirmed row already shown and absent
 * from the fresh rows stays when it is older than the span the explorer page covered (`coveredFromMs`;
 * Infinity when the explorer did not answer): inside that span its absence means the chain no longer
 * has it. Pending rows sent from this wallet stay until a fresh row carries their hash; one that no fresh row carried
 * for PENDING_ROW_MAX_MS after it was sent becomes 'dropped' (not found: no node can hold it any more) instead of
 * staying Pending for ever, and a fresh row with its hash still replaces it. Node lifecycle rows are kept only while
 * their feed is down. A node's 'reported' row never replaces the archive's confirmed row for the same transaction (a
 * refresh that did not ask the explorer would otherwise).
 *
 * `settled` (L-10): what the chain answered by nonce about rows rowsDueToDrop named, by lowercase hash. `landed` (with
 * the hash that landed, a hedged copy's included) makes the row a node's 'reported' row under that hash, which the
 * archive's row replaces once it is listed; `gone` (another transaction took its nonce) removes it; `unread` (no answer)
 * keeps it pending until a later refresh can ask. A row with no answer at all is marked not found as before.
 */
export function mergeHistory(prev, fresh, { myAddress, coveredFromMs, nowMs, nodeEventsOk, settled = null }) {
  const me = lc(myAddress);
  const answerOf = (t) => (settled && (t.status === 'pending' || t.status === 'dropped') ? settled.get(lc(t.hash)) : null);
  prev = prev.filter((t) => { const a = answerOf(t); return !(a && a.gone); }).map((t) => {
    const a = answerOf(t);
    return a && a.landed ? { ...t, status: 'reported', hash: a.txHash || t.hash } : t;
  });
  // A token row proven on an earlier pass stays proven while the same transfer comes back unproven.
  const prevByKey = new Map(prev.map((t) => [historyRowKey(t), t]));
  fresh = fresh.map((t) => {
    if (t.status === 'reported') {
      const p = prevByKey.get(historyRowKey(t));
      return p && p.status === 'confirmed' ? p : t;
    }
    if (!t.tokenContract || t.status !== 'pending') return t;
    const p = prevByKey.get(historyRowKey(t));
    const same = p && p.status === 'confirmed' && p.tokenRawAmount === t.tokenRawAmount && lc(p.from) === lc(t.from) && lc(p.to) === lc(t.to);
    return same ? { ...t, status: 'confirmed', verified: !!p.verified } : t;
  });
  const freshKeys = new Set(fresh.map(historyRowKey));
  const freshHashes = new Set(fresh.map((t) => t.hash));
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const kept = prev.filter((t) => {
    if (t.status === 'pending' || t.status === 'dropped') return lc(t.from) === me && !freshHashes.has(t.hash);
    if (freshKeys.has(historyRowKey(t))) return false;
    if (t.nodeEvent) return !nodeEventsOk;
    const ts = t.timestamp || 0;
    return ts < coveredFromMs || ts > nowMs - INDEX_LAG_GRACE_MS;
  });
  const pending = kept.filter((t) => t.status === 'pending' || t.status === 'dropped')
    .map((t) => (t.status === 'pending' && now - (t.timestamp || 0) >= PENDING_ROW_MAX_MS && !(answerOf(t) || {}).unread
      ? { ...t, status: 'dropped' } : t));
  const rest = kept.filter((t) => t.status !== 'pending' && t.status !== 'dropped');
  return unique([...pending, ...fresh, ...rest]);
}

/** An older page appended to the list: rows already shown keep their current state. */
export function appendHistory(prev, older) {
  return unique([...prev, ...older]);
}

/**
 * What goes to the device cache: confirmed rows only (a pending row is local intent, a reported one only a
 * node's word).
 */
export function cacheableHistory(rows) {
  return rows.filter((t) => t.status === 'confirmed').slice(0, HISTORY_CACHE_MAX);
}

/**
 * Does a row belong to the selected asset filter: 'all', 'qnc' (native and node lifecycle), a token
 * contract, or 'solana:<symbol>' (a Solana send of that token, `chain: 'solana'`). Filtering is local to
 * the rows already held — the feed itself stays one paged list.
 */
export function matchesAsset(row, asset) {
  if (!asset || asset === 'all') return true;
  if (row.chain === 'solana') return asset === `solana:${row.solSymbol}`;
  if (String(asset).startsWith('solana:')) return false;
  if (asset === 'qnc') return !row.tokenContract;
  return lc(row.tokenContract) === lc(asset);
}

/**
 * The status a history row shows: 'confirmed' once the archive holds it, 'failed' for a failed one, 'dropped' for one
 * sent from here that no source reported within PENDING_ROW_MAX_MS (not found), and 'pending' for anything else (sent
 * from here and not in a block yet, or only one node's word so far).
 */
export function historyBadge(row) {
  if (row && row.status === 'failed') return 'failed';
  if (row && row.status === 'dropped') return 'dropped';
  return row && row.status === 'confirmed' ? 'confirmed' : 'pending';
}

/**
 * A transaction type's name as either source writes it: the explorer gives the bare name ('NodeRegistration'), a node
 * its debug form ('NodeRegistration { node_id: "light_…", … }'). '' for a row without one.
 */
export function txTypeName(txType) {
  const m = /^[A-Za-z]+/.exec(typeof txType === 'string' ? txType.trim() : '');
  return m ? m[0] : '';
}

/**
 * The node a node transaction names (a registration, a check-in), read from a node's debug form of its type; null
 * otherwise (the explorer's row names none).
 */
export function txNodeId(txType) {
  const m = /\bnode_id: "([^"]{1,128})"/.exec(typeof txType === 'string' ? txType : '');
  return m ? m[1] : null;
}

const isRegistration = (r) => !r.nodeEvent && !r.tokenContract && r.chain !== 'solana' && txTypeName(r.txType) === 'NodeRegistration';
// One transaction per network and hash, whatever key each of its rows has.
const txKey = (r) => (typeof r.hash === 'string' && r.hash ? `${r.chain === 'solana' ? 's' : 'q'}:${r.hash.toLowerCase()}` : null);
const STATUS_WEIGHT = { failed: 4, dropped: 3, pending: 2, reported: 1, confirmed: 0 };

/**
 * The rows as History lists them: one entry per transaction, in the order given.
 * - A node's registration is one transaction however many feeds report it: the registry's node event (kept for the
 *   life of the chain, no transaction hash) and the registration transaction itself (the explorer's row, or a node's
 *   for about a day) become one entry carrying both, matched by the node the transaction names or the block it is in.
 *   A node event with no registration row beside it stays an entry of its own.
 * - The value rows of one transaction (its token transfers by log index, a batch's credits) become one entry whose
 *   `legs` are those rows (a swap pays one token and receives another), with the least settled status among them.
 */
export function historyEntries(rows) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  const regs = list.filter(isRegistration);
  const eventOf = new Map();
  const folded = new Set();
  // A transaction that names its node matches that node's event only; one that names none (the explorer's row) matches
  // the event of its block. Matches by the node come first, so a block's row never takes another node's event.
  const events = list.filter((r) => r.nodeEvent);
  const claim = (matches) => {
    for (const ev of events) {
      if (folded.has(ev)) continue;
      const reg = regs.find((r) => !eventOf.has(r) && matches(r, ev));
      if (reg) { eventOf.set(reg, ev); folded.add(ev); }
    }
  };
  claim((r, ev) => txNodeId(r.txType) === ev.nodeId);
  claim((r, ev) => txNodeId(r.txType) === null && Number.isSafeInteger(r.block) && r.block === ev.height);
  const groups = new Map();
  for (const r of list) {
    const k = r.nodeEvent || isRegistration(r) ? null : txKey(r);
    if (k) groups.set(k, [...(groups.get(k) || []), r]);
  }
  const out = [];
  const placed = new Set();
  for (const r of list) {
    if (r.nodeEvent) {
      if (!folded.has(r)) out.push(r);
    } else if (isRegistration(r)) {
      const ev = eventOf.get(r);
      // The registry holds the node only once its registration is in a block: a node's 'reported' row of it is settled.
      out.push(ev ? {
        ...r, nodeRegistration: true, nodeId: ev.nodeId, nodeType: ev.nodeType, height: ev.height,
        timestamp: r.timestamp || ev.timestamp, status: r.status === 'reported' ? 'confirmed' : r.status,
      } : { ...r, nodeRegistration: true });
    } else {
      const k = txKey(r);
      const group = k ? groups.get(k) : null;
      if (!group || group.length < 2) out.push(r);
      else if (!placed.has(k)) {
        placed.add(k);
        const status = group.reduce((s, g) => ((STATUS_WEIGHT[g.status] || 0) > (STATUS_WEIGHT[s] || 0) ? g.status : s), 'confirmed');
        out.push({ ...group[0], status, legs: group });
      }
    }
  }
  return out;
}

/** Midnight of the local day `ms` falls in. */
const dayStart = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

/**
 * The list History draws: entries newest first, each day's under one header item `{ dayHeader: true, key, day, at }`:
 * day 'today', 'yesterday', 'date' (the local day starting at `at`), or 'earlier' for rows without a real time (genesis
 * rows, a node event whose block the nodes no longer keep), which come last.
 */
export function historySections(entries, nowMs = Date.now()) {
  const known = (e) => (Number(e.timestamp) || 0) >= 1000000;
  const sorted = (Array.isArray(entries) ? entries : []).map((e, i) => [e, i])
    .sort(([a, ia], [b, ib]) => (known(b) - known(a)) || ((known(a) ? b.timestamp - a.timestamp : 0) || ia - ib))
    .map(([e]) => e);
  const today = dayStart(nowMs);
  const yesterdayDate = new Date(today);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterday = yesterdayDate.getTime();
  const out = [];
  let last = null;
  for (const e of sorted) {
    const at = known(e) ? dayStart(e.timestamp) : null;
    const key = at === null ? 'day:earlier' : `day:${at}`;
    if (key !== last) {
      const day = at === null ? 'earlier' : at === today ? 'today' : at === yesterday ? 'yesterday' : 'date';
      out.push({ dayHeader: true, key, day, at });
      last = key;
    }
    out.push(e);
  }
  return out;
}
