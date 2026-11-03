// Transaction history assembly. The explorer archive holds the whole history and pages through it; a
// node holds about a day and is the freshest source. Both feed one list, merged with what the device
// already shows. Pure functions only: no network, no storage.

export const HISTORY_PAGE = 50;
// How many confirmed rows survive a restart.
export const HISTORY_CACHE_MAX = 500;
// Newest rows the explorer may not have indexed yet: never dropped for being absent from its page.
const INDEX_LAG_GRACE_MS = 5 * 60 * 1000;
// A genesis node keeps at least the newest TX_INDEX_RETENTION_BLOCKS blocks of its transaction index (the node's constant
// of that name): below them no node lists, looks up or proves a transaction, and the archive's row is its only record.
export const TX_INDEX_RETENTION_BLOCKS = 100_000;
// A genesis node keeps the logs of its newest MICROBLOCK_BODY_RETENTION_BLOCKS blocks at least (the node's constant of
// that name), and with them its token transfers and their proofs; none at or below the floor it reports (`oldest_available`).
export const MICROBLOCK_BODY_RETENTION_BLOCKS = 86_400;
// How many rows one History read asks genesis nodes about: looked up by hash (rowsToLookUp), and this wallet's own
// sends by their nonce (rowsToSettle).
export const HISTORY_LOOKUP_ROWS = 8;

const lc = (s) => String(s || '').toLowerCase();
// The block a source names for a row (a whole number), shown on the transaction's detail screen; null otherwise.
const blockOf = (v) => (Number.isSafeInteger(Number(v)) && Number(v) >= 0 && v !== null && v !== '' && v !== undefined ? Number(v) : null);
// An amount a source gives in nanoQNC as exact decimal text (a JSON number past 2^53 is not exact: null), or null.
const nanoText = (v) => {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? String(v) : null;
  return typeof v === 'string' && /^\d{1,20}$/.test(v) ? v.replace(/^0+(?=\d)/, '') : null;
};

// The statuses of a row an archive or node listed (receive labels, wallet-galc plan P1; the extension's rule):
// 'unverified' while only the explorer archive (the site's host, not a node) or one node lists it; 'included' for a
// received QNC transfer two genesis nodes list alike, or report at its block when looked up by its hash, whose block the
// wallet's live figure does not cover yet (in a block, not in the balance yet); 'confirmed' once it does (and for every
// other row two genesis nodes list or report so, or a token transfer a genesis node reports applied). A row flagged
// `inBlock` (a genesis node reported it in a block: this wallet's send its result card saw included, a token transfer a
// node reported, a row of a node's transaction index; or the archive's row of a block that index no longer reaches, or a
// token row of a block whose logs no genesis node keeps, withListing) shows as confirmed whatever else holds. A token row
// its logs proof contradicted (`proofRejected`) never takes that flag.
const LISTED_RANK = { unverified: 0, included: 1, confirmed: 2 };
const archived = (status) => Object.prototype.hasOwnProperty.call(LISTED_RANK, status);

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
 * trust badge never sits next to a magnitude a node or the explorer chose. An event a genesis node `reported` (its
 * token-transfer feed decodes only transactions that applied) is 'confirmed' and `inBlock`; an `archived` one only the
 * archive holds is its word ('unverified'). A committee-certified logs root that proves it adds `verified`.
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
    status: ev.reported ? 'confirmed' : (ev.archived ? 'unverified' : 'pending'),
    verified: false,
    ...(ev.reported ? { inBlock: true } : {}),
    timestamp: (Number(ev.timestamp) || 0) * 1000,
    type: txDirection(ev.from, ev.to, myAddress),
    fee: 0,
    // A node's feed names the block `height`.
    ...(blockOf(ev.block ?? ev.height) !== null ? { block: blockOf(ev.block ?? ev.height) } : {}),
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
 * authority over whose history this is, nor over what is on chain: its rows are 'unverified' until two genesis
 * nodes list them alike or report them at their block when looked up, or until no node keeps their block any more
 * (withListing).
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
      amountNano: nanoText(it.amount),
      status: 'unverified',
      timestamp: Number(it.timestamp) || 0,
      type: direction,
      fee: send ? (Number(it.fee) || 0) / 1e9 : 0,
      ...(blockOf(it.block) !== null ? { block: blockOf(it.block) } : {}),
    });
  }
  return { native, tokenEvents };
}

// What a genesis node's own transaction index says of a row it lists (GET /api/v1/account/{address}/transactions): every
// row of it is in a block (the index keys it by block height); 'no_effect' is a node balance move that moved nothing.
const IN_BLOCK_STATES = new Set(['confirmed', 'no_effect']);

/**
 * A native transfer as one genesis node reports it (node shape: hash, tx_type, from/to, amount and fee in nanoQNC,
 * status, timestamp in seconds). Its row is 'reported': the explorer archive's row for the same transaction replaces it
 * once indexed (its row comes first in a merge), and two genesis nodes listing it alike settle its status
 * (withListing). The node's answer that it is in a block marks it `inBlock`, which every row of its hash takes over
 * (mergeHistory): it shows as confirmed at once, never Pending or Unverified.
 */
export function nodeNativeRow(tx, myAddress) {
  const from = tx.from || tx.sender;
  const to = tx.to || tx.recipient;
  return {
    ...(IN_BLOCK_STATES.has(tx.status) ? { inBlock: true } : {}),
    hash: tx.hash || tx.tx_hash,
    txType: tx.tx_type,
    from,
    to,
    amount: (Number(tx.amount) || 0) / 1e9,
    amountNano: nanoText(tx.amount),
    status: 'reported',
    timestamp: (Number(tx.timestamp) || 0) * 1000,
    type: txDirection(from, to, myAddress),
    fee: (Number(tx.fee || tx.gas_used) || 0) / 1e9,
    ...(blockOf(tx.block_height) !== null ? { block: blockOf(tx.block_height) } : {}),
  };
}

// The kinds a node lists with another `to` than the archive's, or none (a call's `to` is its contract, a deploy's the
// contract it creates, a registration names no recipient): matched by hash alone (the extension's HASH_ONLY_KINDS).
const HASH_ONLY_TYPES = new Set(['ContractCall', 'ContractDeploy', 'NodeRegistration']);
const HASH_LISTED_NODE_TYPES = /^(?:contract_?call|contract_?deploy|node_?registration)$/i;
const hashKey = (hash) => JSON.stringify(['hash', lc(hash)]);
const rowKey = (hash, from, to, amountNano) => JSON.stringify([lc(hash), lc(from), lc(to), amountNano]);

// A QNet value or action row of this wallet's history that genesis nodes can list: no token transfer (its inclusion is
// proven by a logs proof), no node event, no Solana row.
const listable = (r) => !!r && typeof r.hash === 'string' && r.hash !== '' && !r.tokenContract && !r.nodeEvent && r.chain !== 'solana';

/**
 * The key a row is compared by with what genesis nodes list (listingKeysOfNodeRow): its hash, both parties and its
 * amount in nanoQNC; a contract call, deploy or registration by its hash alone. null for a row no node lists that way.
 */
export function listingKey(r) {
  if (!listable(r)) return null;
  if (HASH_ONLY_TYPES.has(txTypeName(r.txType))) return hashKey(r.hash);
  if (typeof r.from !== 'string' || typeof r.to !== 'string' || typeof r.amountNano !== 'string') return null;
  return rowKey(r.hash, r.from, r.to, r.amountNano);
}

/**
 * The keys one node's history row (GET /api/v1/transactions/history: hash, from, to, amount in nanoQNC, type), or a
 * lookup's transaction (its type in the node's debug form), is listed under, as listingKey writes them: [] for a row that
 * names too little.
 */
export function listingKeysOfNodeRow(row) {
  if (!row || typeof row !== 'object' || typeof row.hash !== 'string' || typeof row.from !== 'string') return [];
  const keys = [];
  if (HASH_LISTED_NODE_TYPES.test(txTypeName(String(row.type ?? row.tx_type ?? '')))) keys.push(hashKey(row.hash));
  const amountNano = nanoText(row.amount);
  if (typeof row.to === 'string' && amountNano !== null) keys.push(rowKey(row.hash, row.from, row.to, amountNano));
  return keys;
}

/**
 * The listing keys one genesis node's lookup answer (GET /api/v1/transaction/{hash}) gives an included transaction. A key
 * by hash alone counts only for a transaction this wallet sent: a lookup, unlike a listing, is not read under its address.
 */
export function lookupListingKeys(answer, hash, myAddress) {
  if (txLookupState(answer, hash) !== 'included') return [];
  const tx = answer.transaction;
  const keys = listingKeysOfNodeRow(tx);
  return lc(tx.from) === lc(myAddress) ? keys : keys.filter((k) => k !== hashKey(tx.hash));
}

// A listed row's status: received QNC is credited ('confirmed') once the wallet's live figure covers its block
// (`coveredHeight`: the height of the newest figure read, live or certified), 'included' before; every other listed row
// is 'confirmed'. A row already credited stays so.
const listedStatus = (r, coveredHeight) => {
  if (r.status === 'confirmed' && r.listed) return 'confirmed';
  if (r.type !== 'receive') return 'confirmed';
  return Number.isSafeInteger(coveredHeight) && Number.isSafeInteger(r.block) && r.block <= coveredHeight ? 'confirmed' : 'included';
};

// The logs floor at `tip`: the floor a genesis node reported, never above MICROBLOCK_BODY_RETENTION_BLOCKS below `tip`,
// which stands in while none was reported.
const logsFloorAt = (tip, reported) => Math.min(Number.isSafeInteger(reported) && reported >= 0 ? reported : Infinity,
  tip - MICROBLOCK_BODY_RETENTION_BLOCKS);
// A row of a block no genesis node at `tip` can list, report or prove any more: their transaction index ends
// TX_INDEX_RETENTION_BLOCKS below it, a token row's logs at the logs floor.
const beyondNodes = (r, tip, logsFloor) => Number.isSafeInteger(r.block) && Number.isSafeInteger(tip)
  && (r.block + TX_INDEX_RETENTION_BLOCKS <= tip || (!!r.tokenContract && r.block <= logsFloorAt(tip, logsFloor)));
// A row only the archive holds (a QNC or a token row) of such a block: the archive's record is the chain's only one.
// Never a token row its logs proof contradicted.
const pastIndex = (r, tip, logsFloor) => !!r && r.status === 'unverified' && !r.inBlock && r.chain !== 'solana'
  && !r.proofRejected && beyondNodes(r, tip, logsFloor);

/**
 * The rows with what genesis nodes answer applied (receive labels): a row whose listingKey is in
 * `listed` (keys at least two genesis nodes list alike, WalletManager.agreedHistoryRows, or report alike at the row's
 * block, lookedUpHistoryRows; null: none read now), or that was listed before (`listed: true`), is 'included' or
 * 'confirmed' by listedStatus; a row only the archive holds whose block the nodes' index no longer reaches at
 * `coveredHeight`, or a token row at or below the logs floor (`logsFloor`: the highest one a genesis node reported, null
 * for none; pastIndex), is in a block (`inBlock`), the archive's record being the chain's only one; every other row keeps
 * its status (the archive's rows stay 'unverified', one node's 'reported'). Being listed proves a block carries the
 * transaction, never that it applied: the balance shows that. A row that does not change is the same object.
 */
export function withListing(rows, listed, coveredHeight = null, logsFloor = null) {
  return (Array.isArray(rows) ? rows : []).map((r) => {
    if (pastIndex(r, coveredHeight, logsFloor)) return { ...r, inBlock: true };
    if (!listable(r) || !(archived(r.status) || r.status === 'reported')) return r;
    const key = r.listed ? null : listingKey(r);
    if (!r.listed && !(key && listed && listed.has(key))) return r;
    const status = listedStatus(r, coveredHeight);
    return status === r.status && r.listed ? r : { ...r, status, listed: true };
  });
}

/**
 * The rows History looks up by hash (WalletManager.lookedUpHistoryRows), in list order (newest first), at most
 * HISTORY_LOOKUP_ROWS: QNet rows only the archive holds, of a block the nodes' index still reaches at `tip`, that no
 * listing settled (`listed`: this read's listing keys) and that were not looked up already (`skip`, by listing key). A
 * batch credit is the listing's alone: a lookup names the batch, not this wallet's credit.
 */
export function rowsToLookUp(rows, { listed = null, tip = null, skip = null } = {}) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (out.length >= HISTORY_LOOKUP_ROWS) break;
    if (!listable(r) || r.status !== 'unverified' || r.listed || r.inBlock || r.batchIndex != null) continue;
    const key = listingKey(r);
    if (key === null || (listed && listed.has(key)) || (skip && skip.has(key)) || beyondNodes(r, tip, null)) continue;
    out.push(r);
  }
  return out;
}

/**
 * History's lookups by hash in one session for `owner` (WalletScreen lookUpOlderRows), by listing key: `due(rows, { listed,
 * tip })` the rows to ask now (rowsToLookUp, past those answered or in flight), `asking(keys)` once asked, `ended(keys,
 * answered)` once done. A row at least two genesis nodes answered for is not asked again; any other is, by a later read.
 */
export function lookupLedger(owner) {
  const done = new Set();
  const running = new Set();
  return {
    owner,
    due: (rows, { listed = null, tip = null } = {}) => rowsToLookUp(rows, { listed, tip, skip: new Set([...done, ...running]) }),
    asking: (keys) => keys.forEach((k) => running.add(k)),
    ended: (keys, answered) => {
      keys.forEach((k) => running.delete(k));
      answered.forEach((k) => done.add(k));
    },
  };
}

// Whether two token rows name the same transfer: its amount and both parties (the fields a logs proof binds with the
// row's key).
const sameTransfer = (a, b) => a.tokenRawAmount === b.tokenRawAmount && lc(a.from) === lc(b.from) && lc(a.to) === lc(b.to);
// A token row its logs proof contradicted: on the archive's word alone it is in no block.
const refuted = (r) => {
  const { inBlock: _inBlock, ...rest } = r;
  return { ...(r.status === 'unverified' ? rest : r), proofRejected: true };
};

/**
 * The token rows of a read (`fresh`) whose logs proof History asks for: those of a block whose logs the genesis nodes
 * still keep at `tip` (a row with no block, or with no tip, counts as such; below the floor no proof is left to fetch),
 * less those `shown` already holds with a final verdict for the same transfer (verified, or proofRejected).
 */
export function tokenRowsToProve(fresh, shown, tip, logsFloor) {
  const final = new Map((Array.isArray(shown) ? shown : [])
    .filter((r) => r && r.tokenContract && (r.verified || r.proofRejected)).map((r) => [historyRowKey(r), r]));
  return (Array.isArray(fresh) ? fresh : []).filter((r) => {
    if (!r || !r.tokenContract || beyondNodes(r, tip, logsFloor)) return false;
    const done = final.get(historyRowKey(r));
    return !(done && sameTransfer(done, r));
  });
}

/**
 * The rows with the final verdicts of logs proofs (`verdicts`: historyRowKey → { verdict, row: the row as proven }), each
 * on the token row of the same transfer only: 'verified' confirms it with the mark, and wins over a rejection;
 * 'rejected' keeps the verdict on the row (`proofRejected`: the window rule and other rows of its hash never put it in a
 * block, through merges and the cache). A row that does not change is the same object.
 */
export function withProofVerdicts(rows, verdicts) {
  return (Array.isArray(rows) ? rows : []).map((r) => {
    const v = r && r.tokenContract && verdicts ? verdicts.get(historyRowKey(r)) : null;
    if (!v || !v.row || !sameTransfer(v.row, r)) return r;
    if (v.verdict === 'verified') {
      if (r.status === 'confirmed' && r.verified && !r.proofRejected) return r;
      const { proofRejected: _rejected, ...rest } = r;
      return { ...rest, status: 'confirmed', verified: true };
    }
    return v.verdict === 'rejected' && !r.verified && !r.proofRejected ? refuted(r) : r;
  });
}

/**
 * Rows read back from the device cache: one kept 'confirmed' by an older build on the explorer archive's word alone
 * (not listed, not reported in a block by a genesis node, or a token row no logs proof verified) is 'unverified' again
 * until genesis nodes list it or their index no longer reaches its block, or, a token row, its block is at or below the
 * logs floor (withListing).
 */
export function checkedCachedRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((r) => {
    if (!r || r.status !== 'confirmed' || r.nodeEvent || r.chain === 'solana' || r.inBlock) return r;
    if (r.tokenContract) return r.verified ? r : { ...r, status: 'unverified' };
    return r.listed ? r : { ...r, status: 'unverified' };
  });
}

/**
 * The rows with the transaction `hash` marked as a genesis node reported it to this wallet's send result card: in a block
 * (at `block` when it names one). Every row of that hash but a token row its logs proof contradicted; a row that does not
 * change is the same object.
 */
export function markInBlock(rows, hash, block = null) {
  const h = lc(hash);
  const at = blockOf(block);
  return (Array.isArray(rows) ? rows : []).map((r) => (r && h && lc(r.hash) === h && !r.inBlock && !r.proofRejected
    ? { ...r, inBlock: true, ...(at !== null ? { block: at } : {}) } : r));
}

// A row of a send from here that no source lists yet: pending, or expired by the chain's height.
const unsettled = (r) => !!r && (r.status === 'pending' || r.status === 'expired');

/**
 * What the chain's answer by nonce about a send of this wallet (WalletManager.resolveSubmitByNonce, `res`) does to its
 * row: { landed, txHash } once a block holds it (under the hash that landed, a hedged copy's included, else `hash`),
 * { expired } once the chain's height passed the last height a V2 send signed with its nonce still free, { gone } once
 * another transaction took its nonce (or a call applied there that nothing binds to this one); null while the chain
 * decided nothing (no answer, its nonce still free, or spent with no row to bind it). No clock decides any of these.
 */
export function nonceAnswer(res, hash) {
  if (!res || !res.known) return null;
  if (res.landed) return { landed: true, txHash: res.txHash || hash };
  if (res.expired) return { expired: true };
  if (res.replaced || res.unbound) return { gone: true };
  return null;
}

/**
 * The rows with the chain's `answer` (nonceAnswer) about this wallet's send `hash`, the one rule for the result card
 * and History: landed, its row is in a block under the hash that landed, or goes when a row of that hash is listed
 * already; gone, it goes, the transaction that took its nonce being listed in its place; expired, a pending one is
 * Expired. A row that does not change is the same object.
 */
export function withNonceAnswer(rows, hash, answer) {
  const list = Array.isArray(rows) ? rows : [];
  const h = lc(hash);
  if (!answer || !h) return list;
  const handed = (r) => unsettled(r) && lc(r.hash) === h;
  if (answer.landed) {
    const landed = answer.txHash || hash;
    const listed = lc(landed) !== h && list.some((r) => r && lc(r.hash) === lc(landed));
    return markInBlock(listed ? list.filter((r) => !handed(r))
      : list.map((r) => (handed(r) ? { ...r, status: 'pending', hash: landed } : r)), landed);
  }
  if (answer.gone) return list.some(handed) ? list.filter((r) => !handed(r)) : list;
  if (answer.expired) {
    const due = (r) => !!r && r.status === 'pending' && !r.inBlock && lc(r.hash) === h;
    return list.map((r) => (due(r) ? { ...r, status: 'expired' } : r));
  }
  return list;
}

const newestFirst = (a, b) => (b.timestamp || 0) - (a.timestamp || 0);

/**
 * Rows by key, first occurrence wins, newest first. A node's 'reported' row goes whenever an archive row (confirmed,
 * included or unverified) carries the same hash under any key: a batch payment's archive row is `hash:bN` and the node's
 * is the bare hash, the same payment. A row sent from here that is still pending or expired goes whenever an archive,
 * failed or reported row carries its hash: an older page that holds the send settles it.
 */
function unique(rows) {
  const confirmed = new Set(rows.filter((r) => archived(r.status)).map((r) => lc(r.hash)));
  const known = new Set(rows.filter((r) => r.hash && (archived(r.status) || r.status === 'failed' || r.status === 'reported'))
    .map((r) => lc(r.hash)));
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const k = historyRowKey(r);
    if (seen.has(k) || (r.status === 'reported' && confirmed.has(lc(r.hash)))) continue;
    if (unsettled(r) && known.has(lc(r.hash))) continue;
    seen.add(k);
    out.push(r);
  }
  return out.sort(newestFirst);
}

/**
 * The rows sent from here that a History read asks the chain about by their nonce: pending, in no block, carried by no
 * fresh row, sent with a (from, nonce) to ask by (`settle`), oldest first, at most HISTORY_LOOKUP_ROWS. Fifty newer rows
 * can push a send that landed off every fresh page, and a hedged copy can land under another hash; each answer goes on
 * its row through withNonceAnswer. Such a row stays Pending, however long, until a source lists its hash or the chain
 * answers (nonceAnswer): no clock ends it.
 */
export function rowsToSettle(prev, fresh, { myAddress }) {
  const me = lc(myAddress);
  const freshHashes = new Set((fresh || []).map((t) => t.hash));
  const out = [];
  for (const t of [...(prev || [])].reverse()) {
    if (out.length >= HISTORY_LOOKUP_ROWS) break;
    const s = t && t.settle;
    if (!t || t.status !== 'pending' || t.inBlock || lc(t.from) !== me || freshHashes.has(t.hash)) continue;
    if (s && Number.isSafeInteger(s.nonce) && s.from) out.push(t);
  }
  return out;
}

/**
 * The list after a refresh. Fresh rows replace their own keys. A confirmed row already shown and absent
 * from the fresh rows stays when it is older than the span the explorer page covered (`coveredFromMs`;
 * Infinity when the explorer did not answer): inside that span its absence means the chain no longer
 * has it. A row sent from this wallet that no source lists yet (pending, or expired) stays until a fresh row carries
 * its hash; only the chain's answer by nonce ends it otherwise (withNonceAnswer), never the time since it was sent. Node
 * lifecycle rows are kept only while their feed is down. A node's 'reported' row never replaces the archive's confirmed
 * row for the same transaction (a refresh that did not ask the explorer would otherwise).
 *
 * A row in a block (`inBlock`: the result card or the chain's answer by nonce, its token feed or its transaction index
 * said so, or that index no longer reaches its block) passes the flag to every row of its hash, fresh or kept, so the
 * node's or the archive's row of the same transaction never shows it as pending or unverified again; a token row its
 * logs proof contradicted (`proofRejected`) takes it from none, and keeps that verdict while the same transfer comes back.
 */
export function mergeHistory(prev, fresh, { myAddress, coveredFromMs, nowMs, nodeEventsOk }) {
  const me = lc(myAddress);
  // A token row proven or reported applied on an earlier pass stays so while the same transfer comes back without it,
  // and a row two genesis nodes listed stays listed while the archive returns it unverified (a node keeps about a day of
  // history).
  const prevByKey = new Map(prev.map((t) => [historyRowKey(t), t]));
  // A hash in a block, on this pass or an earlier one: every row of it takes the flag.
  const inBlock = new Set([...prev, ...fresh].filter((t) => t.inBlock && t.hash).map((t) => lc(t.hash)));
  const marked = (t) => (t.hash && inBlock.has(lc(t.hash)) && !t.inBlock && !t.proofRejected ? { ...t, inBlock: true } : t);
  fresh = fresh.map(marked).map((t) => {
    const p = prevByKey.get(historyRowKey(t));
    if (t.status === 'reported') return p && archived(p.status) ? marked(p) : t;
    if (t.tokenContract) {
      const same = !!p && sameTransfer(p, t);
      const kept = same && p.status === 'confirmed' && (p.verified || p.inBlock)
        ? { ...t, status: 'confirmed', verified: !!(t.verified || p.verified), ...(p.inBlock ? { inBlock: true } : {}) } : t;
      return same && p.proofRejected && !kept.verified ? refuted(kept) : kept;
    }
    const kept = p && p.listed && archived(p.status) && archived(t.status) && LISTED_RANK[p.status] > LISTED_RANK[t.status]
      && listingKey(p) === listingKey(t);
    return kept ? { ...t, status: p.status, listed: true } : t;
  });
  const freshKeys = new Set(fresh.map(historyRowKey));
  const freshHashes = new Set(fresh.map((t) => t.hash));
  const kept = prev.filter((t) => {
    if (unsettled(t)) return lc(t.from) === me && !freshHashes.has(t.hash);
    if (freshKeys.has(historyRowKey(t))) return false;
    if (t.nodeEvent) return !nodeEventsOk;
    const ts = t.timestamp || 0;
    return ts < coveredFromMs || ts > nowMs - INDEX_LAG_GRACE_MS;
  });
  const rest = kept.filter((t) => !unsettled(t)).map(marked);
  return unique([...kept.filter(unsettled), ...fresh, ...rest]);
}

/**
 * A node of this wallet as a genesis node's answer records it, as a history row (`node:<id>`, one per node): the
 * registry's node event (GET /api/v1/account/{address}/node-events), or the light node's status two genesis nodes give
 * alike with its registration height. `timestamp` in seconds (0 once the block's body is pruned). It settles the
 * registration transaction of its node or its block (historyEntries).
 */
export function nodeEventRow({ nodeId, nodeType, height, timestamp = 0 }, myAddress) {
  return {
    hash: `node:${nodeId}`,
    nodeEvent: true,
    nodeId,
    nodeType,
    height,
    from: lc(myAddress),
    to: null,
    amount: 0,
    fee: 0,
    status: 'confirmed',
    timestamp: (Number(timestamp) || 0) * 1000,
    type: 'receive',
  };
}

/** The rows with each node event of `events` whose node no row records yet; `rows` itself when none is new. */
export function withNodeEvents(rows, events) {
  const list = Array.isArray(rows) ? rows : [];
  const keys = new Set(list.map(historyRowKey));
  const added = (Array.isArray(events) ? events : []).filter((e) => e && e.nodeEvent && !keys.has(historyRowKey(e)));
  return added.length ? [...list, ...added] : list;
}

/** An older page appended to the list: rows already shown keep their current state. */
export function appendHistory(prev, older) {
  return unique([...prev, ...older]);
}

/**
 * What goes to the device cache: the archive's and the listed rows, with their status, and the rows a genesis node
 * reported in a block (otherwise a pending row is local intent).
 */
export function cacheableHistory(rows) {
  return rows.filter((t) => archived(t.status) || t.inBlock).slice(0, HISTORY_CACHE_MAX);
}

/** The asset a row moves: 'qnc' (native, and node lifecycle), a token contract (lowercase) or 'solana:<symbol>'. */
export function assetOf(row) {
  if (row.chain === 'solana') return `solana:${row.solSymbol}`;
  return row.tokenContract ? lc(row.tokenContract) : 'qnc';
}

/**
 * Does a row belong to the selected asset filter: 'all', or an asset as assetOf names it (a contract in any case).
 * Filtering is local to the rows already held — the feed itself stays one paged list.
 */
export function matchesAsset(row, asset) {
  if (!asset || asset === 'all') return true;
  return assetOf(row) === (String(asset).startsWith('solana:') ? String(asset) : lc(asset));
}

/**
 * The status a history row shows: 'confirmed' once it is in a block (`inBlock`: this wallet's send its result card or
 * the chain's answer by its nonce saw included, a token transfer a node reported applied, a row of a node's transaction
 * index, the archive's row of a block that index no longer reaches, a token row at or below the logs floor) or two
 * genesis nodes list it, or report it at its block when looked up by its hash (received QNC: once the wallet's live
 * figure covers it too), 'included' for received QNC listed and not in the balance yet, 'unverified' for a row only the
 * explorer archive holds of a block the nodes still keep, and for a token row its logs proof contradicted, 'failed' for
 * a failed one, 'expired' for one sent from here whose last height the chain's height passed with no block taking it
 * (nonceAnswer; a block that holds it after all wins), and 'pending' for anything else (sent from here and not in a
 * block yet, however long ago, or a node's row that does not say it is in one).
 */
export function historyBadge(row) {
  const s = row && row.status;
  if (s === 'failed') return s;
  if ((row && row.inBlock) || s === 'confirmed') return 'confirmed';
  return archived(s) || s === 'expired' ? s : 'pending';
}

/**
 * A transaction type's name as either source writes it: the explorer gives the bare name ('NodeRegistration'), a node
 * its debug form ('NodeRegistration { node_id: "light_…", … }') or, in its history rows, a snake-case one
 * ('contract_call'). '' for a row without one.
 */
export function txTypeName(txType) {
  const m = /^[A-Za-z_]+/.exec(typeof txType === 'string' ? txType.trim() : '');
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
const STATUS_WEIGHT = { failed: 6, expired: 5, pending: 4, reported: 3, unverified: 2, included: 1, confirmed: 0 };

/**
 * The rows as History lists them: one entry per transaction, in the order given.
 * - A node's registration is one transaction however many feeds report it: the registry's node event (kept for the
 *   life of the chain, no transaction hash) and the registration transaction itself (the explorer's row, or a node's
 *   for about a day) become one entry carrying both, matched by the node the transaction names or the block it is in.
 *   A node event with no registration row beside it stays an entry of its own.
 * - The value rows of one transaction (its token transfers by log index, a batch's credits) become one entry whose
 *   `legs` are those rows (a swap pays one token and receives another), with the least settled status among them; it is
 *   in a block only when every leg is, so a leg its logs proof contradicted holds the entry back.
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
      // The registry holds the node only once its registration is in a block: a node's 'reported' row of it, and the
      // archive's, is settled.
      out.push(ev ? {
        ...r, nodeRegistration: true, nodeId: ev.nodeId, nodeType: ev.nodeType, height: ev.height,
        timestamp: r.timestamp || ev.timestamp, status: r.status === 'reported' || archived(r.status) ? 'confirmed' : r.status,
      } : { ...r, nodeRegistration: true });
    } else {
      const k = txKey(r);
      const group = k ? groups.get(k) : null;
      if (!group || group.length < 2) out.push(r);
      else if (!placed.has(k)) {
        placed.add(k);
        const status = group.reduce((s, g) => ((STATUS_WEIGHT[g.status] || 0) > (STATUS_WEIGHT[s] || 0) ? g.status : s), 'confirmed');
        out.push({ ...group[0], status, inBlock: group.every((g) => g.inBlock) || undefined, legs: group });
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
