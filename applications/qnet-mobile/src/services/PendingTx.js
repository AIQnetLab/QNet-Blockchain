/**
 * Signed transactions of this wallet that the chain has not settled yet, and the nonce the next one takes.
 *
 * Every nonce-bound transaction (a transfer, a contract call, a deploy) is kept here from the moment it is
 * signed until the confirmed account nonce reaches it. A retry resends exactly those bytes, never a new
 * signature.
 *
 * While any transaction of ours is unsettled — refused, unanswered, or accepted by a node but not applied yet —
 * a new one is never given a nonce silently: the user chooses (planNonce `choice`). 'replace' signs at that
 * transaction's nonce, so at most one of the two can ever apply; 'append' signs at the next nonce, so both can,
 * and is offered only when every earlier one is held by a node (no nonce is signed above one nobody holds).
 * A choice made on screen is re-checked against the chain when the transaction is signed: a transaction the
 * user meant to replace that has applied meanwhile stops the send (PendingSettledError) instead of paying twice.
 *
 * Entry: { from, nonce, path, body, bodyHash, pk, summary, createdAt, state: 'open' | 'accepted', acceptedAt,
 * txHash, sends, lastSentAt }. 'accepted' = a node returned a transaction hash for it; 'open' = unanswered or
 * refused. `summary` is what the screen shows about it ({ kind, to, amountNano, method, reserveNano }).
 * One AsyncStorage value holds every wallet's entries, so no key name carries an address. Every read-modify-
 * write of it runs under one lock, and an update names the exact bytes it is about (bodyHash), so an answer
 * that arrives for a transaction since replaced changes nothing. A store that cannot be read is never taken for an
 * empty one (MOBNET-R5-04): the mutation is refused, and a value that does not parse keeps every send back until
 * nothing it may have held can still land (PENDING_UNREADABLE).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { DEPLOY_GAS_LIMIT, DEPLOY_GAS_PRICE, TRANSFER_FEE_NANO, feeNano } from '../config/fees';

export const PENDING_KEY = 'qnet_pending_txs';
export const MAX_LIVE = 4;                   // unsettled transactions one wallet may have at once
// How long a node keeps a transaction it admitted (the node's mempool lifetime, 1800 s from its own admission; a
// resend after it dropped one admits it again for as long). MOBNET-R4-02: the wallet's idea of "held" and of "can
// still go through" follows this, not a shorter guess.
export const NODE_MEMPOOL_TTL_MS = 30 * 60_000;
// A node answered "accepted" within a request timeout of admitting it, so it surely still holds it for this long.
export const HELD_MS = NODE_MEMPOOL_TTL_MS - 60_000;
// On top of the node's lifetime: a peer that took it by gossip admitted it a little later, and clocks differ.
export const LANDING_MARGIN_MS = 5 * 60_000;
// A held transaction is sent again this often while the wallet still sends it: a node that restarted lost it.
export const RESEND_HELD_MS = 10 * 60_000;
export const RECENT_MS = 30 * 60_000;        // how long a settled transaction is remembered for the repeat warning
// How long after signing the wallet sends a kept transaction again by itself (MOBNET-R3-01): the half hour the
// screens promise. After that, and at once after a refusal that waiting cannot heal, nothing goes out again unless
// the user sends anew; the entry stays listed (and keeps its nonce) until it settles or the user stops it.
export const AUTO_SEND_MS = 30 * 60_000;
const RECENT_MAX = 12;

/**
 * Whether a node's refusal can go away by waiting: a congestion floor above the fixed gas price, a nonce the chain
 * has not reached yet, a busy or restarting node. Anything else (insufficient balance, a bad signature, an amount the
 * node rejects, a text this build does not know) stays refused, so the wallet never sends it again by itself.
 */
export function refusalHeals(error) {
  const s = String(error || '');
  if (!s) return true; // unanswered: nothing was refused
  return /below current floor|invalid nonce|nonce too (high|low)|mempool (is )?full|busy|rate.?limit|too many requests|temporar|try again|unavailable|syncing|pk_unresolved|HTTP (429|5\d\d)/i.test(s);
}

/**
 * Whether the wallet may still send the kept transaction `e` again by itself: not stopped, not refused for a reason
 * waiting cannot heal, and signed less than AUTO_SEND_MS ago.
 */
export function autoSendable(e, now = Date.now()) {
  if (!e || e.stopped) return false;
  // A refusal that came while another node's copy of the request went unanswered is not final: that node may hold
  // the transaction (MOBNET-R4-02), so it is sent again like one nobody answered.
  if (e.state !== 'accepted' && e.refusal && !refusalHeals(e.refusal) && !e.refusalUncertain) return false;
  return now - (e.createdAt || 0) < AUTO_SEND_MS;
}

/**
 * Until when a kept transaction may still be in some node's mempool, and so still go through (MOBNET-R4-02): the
 * node's lifetime after the last time its bytes went out (an acceptance, a resend, or signing when no send was
 * recorded), plus the margin. Past it, with its nonce still free, no node holds it any more.
 */
export function mayLandUntil(e) {
  const lastOut = Math.max(Number(e && e.acceptedAt) || 0, Number(e && e.lastSentAt) || 0, Number(e && e.createdAt) || 0);
  return lastOut + NODE_MEMPOOL_TTL_MS + LANDING_MARGIN_MS;
}

export class TooManyPendingError extends Error {
  constructor() {
    super('Several earlier transactions from this wallet are not confirmed yet. Wait for them to confirm, then send again.');
    this.name = 'TooManyPendingError';
    this.code = 'TOO_MANY_PENDING'; // the screen says it in the user's language (i18n errorText)
  }
}

/** Unsettled transactions exist and the caller has not said whether the new one replaces one or comes in addition. */
export class PendingChoiceError extends Error {
  constructor(pending) {
    super('An earlier transaction from this wallet is not confirmed yet');
    this.name = 'PendingChoiceError';
    this.code = 'PENDING_CHOICE';
    this.pending = pending;
  }
}

/** The transaction the user chose to replace has applied meanwhile: nothing is signed. */
export class PendingSettledError extends Error {
  constructor(nonce) {
    super('The earlier transaction went through before this one was signed; nothing was sent');
    this.name = 'PendingSettledError';
    this.code = 'PENDING_SETTLED';
    this.nonce = nonce;
  }
}

/** What the chosen earlier transaction looked like changed (another one took its place): ask again. */
export class PendingChangedError extends Error {
  constructor(pending) {
    super('The unconfirmed transactions of this wallet changed; check them and send again');
    this.name = 'PendingChangedError';
    this.code = 'PENDING_CHANGED';
    this.pending = pending;
  }
}

export const bodyHashOf = (body) => bytesToHex(sha256(utf8ToBytes(JSON.stringify(body === undefined ? null : body))));

const liveOf = (confirmed, entries) => (entries || [])
  .filter((e) => e && Number.isSafeInteger(e.nonce) && e.nonce > confirmed)
  .sort((a, b) => a.nonce - b.nonce);

/** What the screen shows about an unsettled entry (no signature, no key). */
export function pendingView(e, now = Date.now()) {
  const s = (e && e.summary) || {};
  const accepted = e.state === 'accepted';
  const until = mayLandUntil(e);
  return {
    nonce: e.nonce,
    state: accepted ? 'accepted' : 'open',
    // A node took it recently enough that it surely still holds it (the node's own lifetime, MOBNET-R4-02).
    held: accepted && now - (e.acceptedAt || e.createdAt || 0) < HELD_MS,
    // Some node may still hold it, so it can still go through, until `mayLandUntil`; never "has not gone through"
    // before then.
    mayLand: now < until,
    mayLandUntil: until,
    kind: s.kind || 'other',
    to: typeof s.to === 'string' ? s.to : null,
    amountNano: Number.isSafeInteger(s.amountNano) ? s.amountNano : null,
    method: typeof s.method === 'string' ? s.method : null,
    // The most QNC a call may still take (its most fee, a token transfer's deposit); null for a transfer, or an entry
    // an older build kept (MOB-BR-R3-02).
    reserveNano: Number.isSafeInteger(s.reserveNano) && s.reserveNano >= 0 ? s.reserveNano : null,
    ageMs: Math.max(0, now - (e.createdAt || now)),
    bodyHash: e.bodyHash || null,
    // Whether the wallet still sends it again by itself, and until when (MOBNET-R3-01).
    sending: autoSendable(e, now),
    sendsUntil: (e.createdAt || now) + AUTO_SEND_MS,
    refusal: typeof e.refusal === 'string' ? e.refusal : null,
  };
}

/**
 * Whether the user may stop the kept transaction at `nonce` (MOBNET-R3-01): no node is known to hold it or any kept
 * transaction above it. Stopping means the wallet deletes its copy and never sends it again; a node that took it
 * earlier may still hold it until stopLandsUntil (MOBNET-R4-02), and the screen says so before the user decides.
 */
export function stoppable(entries, nonce, now = Date.now()) {
  const list = (entries || []).filter((e) => e && Number.isSafeInteger(e.nonce) && e.nonce >= nonce);
  return list.some((e) => e.nonce === nonce) && list.every((e) => !pendingView(e, now).held);
}

/** Until when anything a stop at `nonce` deletes may still go through (0 when nothing kept at or above it). */
export function stopLandsUntil(entries, nonce) {
  return (entries || []).filter((e) => e && Number.isSafeInteger(e.nonce) && e.nonce >= nonce)
    .reduce((m, e) => Math.max(m, mayLandUntil(e)), 0);
}

/**
 * The choice the screen offers for `entries` above `confirmed`: { live: [views], replace: view|null,
 * canAppend }. `replace` is the newest unsettled transaction; appending is allowed only when a node holds
 * every one of them and fewer than MAX_LIVE are unsettled.
 */
export function pendingChoices(confirmed, entries, now = Date.now()) {
  const live = liveOf(Number(confirmed), entries);
  const views = live.map((e) => pendingView(e, now));
  return {
    live: views,
    replace: views.length ? views[views.length - 1] : null,
    canAppend: views.length > 0 && views.length < MAX_LIVE && views.every((v) => v.held),
  };
}

/**
 * The nonce of the next transaction from the account nonce the chain confirms and this wallet's entries:
 * { nonce, replaces } where `replaces` is the entry whose place it takes, or null.
 * `choice`: null (only valid while nothing is unsettled), { mode: 'replace', nonce, bodyHash } or { mode: 'append' }.
 */
export function planNonce(accountNonce, entries, choice = null, now = Date.now()) {
  const confirmed = Number(accountNonce);
  if (!Number.isSafeInteger(confirmed) || confirmed < 0) throw new Error('No confirmed account nonce');
  const live = liveOf(confirmed, entries);
  if (choice && choice.mode === 'replace') {
    if (!Number.isSafeInteger(choice.nonce)) throw new Error('No transaction chosen to replace');
    if (choice.nonce <= confirmed) throw new PendingSettledError(choice.nonce);
    const target = live.find((e) => e.nonce === choice.nonce);
    if (!target || (choice.bodyHash && target.bodyHash && choice.bodyHash !== target.bodyHash)) {
      throw new PendingChangedError(pendingChoices(confirmed, entries, now));
    }
    return { nonce: target.nonce, replaces: target };
  }
  if (live.length === 0) return { nonce: confirmed + 1, replaces: null };
  if (!choice || choice.mode !== 'append') throw new PendingChoiceError(pendingChoices(confirmed, entries, now));
  if (live.length >= MAX_LIVE) throw new TooManyPendingError();
  if (live.some((e) => !pendingView(e, now).held)) throw new PendingChangedError(pendingChoices(confirmed, entries, now));
  let next = confirmed + 1;
  for (const e of live) {
    if (e.nonce === next) next += 1;
    else if (e.nonce > next) break;
  }
  if (next - confirmed - 1 >= MAX_LIVE) throw new TooManyPendingError();
  return { nonce: next, replaces: null };
}

// ── storage, one writer at a time ──────────────────────────────────────────────────────────────────

let lock = Promise.resolve();

/** Runs `fn` after every earlier mutation of the store has finished; mutations never interleave. */
function locked(fn) {
  const run = lock.then(fn, fn);
  lock = run.catch(() => {});
  return run;
}

/**
 * The store could not be read, or what it holds does not parse (MOBNET-R5-04): nothing is signed on it, because a
 * transaction of this wallet a node may still hold could take the nonce the next one is given. Nothing was sent.
 */
export class PendingUnreadableError extends Error {
  constructor(untilMs = null) {
    super('This wallet\'s record of unconfirmed transactions could not be read; nothing was sent');
    this.name = 'PendingUnreadableError';
    this.code = 'PENDING_UNREADABLE';
    this.until = untilMs;
  }
}

// A value that did not parse is set aside under this marker with the time it was found: what it held is unknown, so no
// transaction is signed until nothing it may have held can still land (the node's mempool lifetime and the margin).
const UNREADABLE_MARK = '~unreadable';

async function readRaw() {
  try {
    return await AsyncStorage.getItem(PENDING_KEY);
  } catch (_) {
    try { return await AsyncStorage.getItem(PENDING_KEY); } catch (e) { throw new PendingUnreadableError(); }
  }
}

// The whole store: {} only when nothing is stored. A read that fails twice throws and changes nothing; a value that
// does not parse is replaced by the marker and the read throws. Nothing is ever written from a read that failed.
async function readAll(now = Date.now()) {
  const raw = await readRaw();
  if (raw === null || raw === undefined) return {};
  let v = null;
  try { v = JSON.parse(raw); } catch (_) { v = null; }
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  const mark = { [UNREADABLE_MARK]: { at: now } };
  try { await AsyncStorage.setItem(PENDING_KEY, JSON.stringify(mark)); } catch (_) { /* found again next time */ }
  throw new PendingUnreadableError(now + NODE_MEMPOOL_TTL_MS + LANDING_MARGIN_MS);
}

// Until when the marker of a value that did not parse keeps every send back, or 0.
function unreadableUntil(all) {
  const m = all && all[UNREADABLE_MARK];
  const at = m && Number(m.at);
  return Number.isFinite(at) && at > 0 ? at + NODE_MEMPOOL_TTL_MS + LANDING_MARGIN_MS : 0;
}

async function writeAll(all, now = Date.now()) {
  const kept = {};
  for (const [from, list] of Object.entries(all)) if (Array.isArray(list) && list.length) kept[from] = list;
  if (now < unreadableUntil(all)) kept[UNREADABLE_MARK] = all[UNREADABLE_MARK];
  if (Object.keys(kept).length) await AsyncStorage.setItem(PENDING_KEY, JSON.stringify(kept));
  else await AsyncStorage.removeItem(PENDING_KEY);
}

// ── what this wallet's own transactions can take, per nonce ─────────────────────────────────────────────────────
// A send is decided by a committee-certified balance, and the certified state lags the chain by minutes: right after a
// send, the next one's nonce is above the certified nonce. So every transaction this wallet signed is remembered by
// its nonce with the most it can take (QNC: amount and most fee and deposit; a token: the amount it moves), kept while
// it is unsettled and for SPENT_KEEP_MS after it settled. Two signed at one nonce (a replacement) count as the larger
// of the two: either may be the one that applies.
const SPENT_PREFIX = '~spent:';
export const SPENT_KEEP_MS = 60 * 60_000;
export const SPENT_MAX = 64;
const DECIMAL = /^(0|[1-9]\d{0,19})$/;

/**
 * The most a transaction can take, as it is kept: { qncNano: decimal text | null (unknown), tokens: { contract:
 * base units text }, tokenUnknown: whether it may move a token by an amount not known here }.
 */
export function normalSpend(s) {
  const qnc = s && (typeof s.qncNano === 'string' || typeof s.qncNano === 'number') && DECIMAL.test(String(s.qncNano))
    ? String(s.qncNano) : null;
  const tokens = {};
  if (s && s.tokens && typeof s.tokens === 'object') {
    for (const [c, v] of Object.entries(s.tokens)) if (c && DECIMAL.test(String(v))) tokens[c] = String(v);
  }
  return { qncNano: qnc, tokens, tokenUnknown: !!(s && s.tokenUnknown) };
}

const bigMax = (a, b) => (BigInt(a) >= BigInt(b) ? String(a) : String(b));

function mergeSpend(a, b) {
  const tokens = { ...a.tokens };
  for (const [c, v] of Object.entries(b.tokens)) tokens[c] = tokens[c] === undefined ? v : bigMax(tokens[c], v);
  return {
    qncNano: a.qncNano === null || b.qncNano === null ? null : bigMax(a.qncNano, b.qncNano),
    tokens,
    tokenUnknown: a.tokenUnknown || b.tokenUnknown,
  };
}

// What an entry of an older build (kept without `spend`) can take, from its summary: a transfer its amount and fee, a
// call its reserve (a token effect not known), a deploy its most fee; anything else unknown.
function spendFromSummary(s) {
  const kind = s && s.kind;
  if (kind === 'transfer' && Number.isSafeInteger(s.amountNano)) {
    return { qncNano: String(s.amountNano + TRANSFER_FEE_NANO), tokens: {}, tokenUnknown: false };
  }
  if (kind === 'call') {
    return { qncNano: Number.isSafeInteger(s.reserveNano) ? String(s.reserveNano) : null, tokens: {}, tokenUnknown: true };
  }
  if (kind === 'deploy') return { qncNano: String(feeNano(DEPLOY_GAS_PRICE, DEPLOY_GAS_LIMIT)), tokens: {}, tokenUnknown: false };
  return { qncNano: null, tokens: {}, tokenUnknown: true };
}

const entrySpend = (e) => (e && e.spend ? normalSpend(e.spend) : spendFromSummary(e && e.summary));

function ledgerOf(all, from) {
  const list = all[SPENT_PREFIX + from];
  return Array.isArray(list) ? list.filter((r) => r && Number.isSafeInteger(r.nonce)) : [];
}

/**
 * Every transaction of `from` this wallet knows by nonce, with the most it can take: Map nonce -> spend (normalSpend).
 * The record kept when it was signed, the entry still kept, and a settled summary of an older build, the larger where
 * there are several.
 */
export async function ownSpends(from) {
  const all = await readAll();
  const out = new Map();
  const add = (nonce, spend) => {
    if (!Number.isSafeInteger(nonce)) return;
    out.set(nonce, out.has(nonce) ? mergeSpend(out.get(nonce), spend) : spend);
  };
  for (const r of ledgerOf(all, from)) add(r.nonce, normalSpend(r));
  for (const e of Array.isArray(all[from]) ? all[from] : []) add(e && e.nonce, entrySpend(e));
  for (const r of Array.isArray(all[RECENT_PREFIX + from]) ? all[RECENT_PREFIX + from] : []) {
    if (r && !out.has(r.nonce)) add(r.nonce, spendFromSummary(r));
  }
  return out;
}

/**
 * What a send may still spend on top of a committee-certified state, by this wallet's own transactions (the owner's
 * rule): `certified` the certified balance (QNC nano, or a token's base units with `token`), `certifiedNonce` the
 * account nonce in that state, `accountNonce` the nonce the chain confirms now, `spends` (ownSpends). Every nonce from
 * certifiedNonce + 1 to accountNonce must be one of this wallet's own known transactions; anything received after the
 * checkpoint never counts. { ok: true, balance: the certified figure less what this wallet's transactions settled
 * since took, pending: [{ nonce, amount }] what its unsettled ones (above accountNonce) may still take } or
 * { ok: false, reason: 'foreign' (a nonce no transaction of this wallet holds: sent from another device), nonce } or
 * { ok: false, reason: 'unconfirmed' (what one of them takes is not known here) }.
 */
export function spendableFrom({ certified, certifiedNonce, accountNonce, spends, token = null }) {
  if (!DECIMAL.test(String(certified)) || !Number.isSafeInteger(certifiedNonce) || certifiedNonce < 0) {
    return { ok: false, reason: 'unconfirmed' };
  }
  const through = Number.isSafeInteger(accountNonce) && accountNonce > certifiedNonce ? accountNonce : certifiedNonce;
  for (let n = certifiedNonce + 1; n <= through; n++) {
    if (!spends.has(n)) return { ok: false, reason: 'foreign', nonce: n };
  }
  let settled = 0n;
  const pending = [];
  for (const [nonce, s] of [...spends].sort((a, b) => a[0] - b[0])) {
    if (nonce <= certifiedNonce) continue;
    let amount;
    if (token) {
      if (s.tokenUnknown) return { ok: false, reason: 'unconfirmed' };
      amount = BigInt(s.tokens[token] || '0');
    } else {
      if (s.qncNano === null) return { ok: false, reason: 'unconfirmed' };
      amount = BigInt(s.qncNano);
    }
    if (nonce <= through) settled += amount;
    else pending.push({ nonce, amount: amount.toString() });
  }
  const base = BigInt(certified);
  return { ok: true, balance: (base > settled ? base - settled : 0n).toString(), pending };
}

const RECENT_PREFIX = '~recent:'; // settled entries (summaries only) share the value under a non-address key
// Transactions the user stopped: { nonce, bodyHash, until } for as long as a node may still hold them (MOBNET-R4-02),
// so the result screen of such a send never says it has not gone through while it still can.
const STOPPED_PREFIX = '~stopped:';

/** Until when a transaction of `from` the user stopped at `nonce` may still go through, or null. */
export async function stoppedUntil(from, nonce, now = Date.now()) {
  const all = await readAll();
  const list = Array.isArray(all[STOPPED_PREFIX + from]) ? all[STOPPED_PREFIX + from] : [];
  const hit = list.find((s) => s && s.nonce === nonce && now < s.until);
  return hit ? hit.until : null;
}

export async function pendingFor(from) {
  const all = await readAll();
  return Array.isArray(all[from]) ? all[from] : [];
}

export async function pendingEntry(from, nonce) {
  return (await pendingFor(from)).find((e) => e.nonce === nonce) || null;
}

/**
 * Summaries of this wallet's transactions settled in the last RECENT_MS (the nonce was consumed — by that
 * transaction or by one that replaced it), newest first: [{ nonce, kind, to, amountNano, method, settledAt }].
 */
export async function recentSettled(from, now = Date.now()) {
  const all = await readAll();
  const list = Array.isArray(all[RECENT_PREFIX + from]) ? all[RECENT_PREFIX + from] : [];
  return list.filter((r) => r && now - (r.settledAt || 0) < RECENT_MS).sort((a, b) => b.settledAt - a.settledAt);
}

/** Drops every entry the confirmed account nonce has reached (remembered as recent); returns what is left. */
export function settle(from, accountNonce, now = Date.now()) {
  return locked(async () => {
    const all = await readAll(now);
    // Every send settles first: none is given a nonce while what the store held is unknown.
    const until = unreadableUntil(all);
    if (now < until) throw new PendingUnreadableError(until);
    const confirmed = Number(accountNonce);
    const list = all[from] || [];
    const left = list.filter((e) => e.nonce > confirmed);
    const gone = list.filter((e) => !(e.nonce > confirmed));
    if (gone.length) {
      const key = RECENT_PREFIX + from;
      const recent = (Array.isArray(all[key]) ? all[key] : []).filter((r) => r && now - (r.settledAt || 0) < RECENT_MS);
      for (const e of gone) {
        const v = pendingView(e, now);
        recent.push({ nonce: v.nonce, kind: v.kind, to: v.to, amountNano: v.amountNano, method: v.method, settledAt: now });
      }
      all[key] = recent.slice(-RECENT_MAX);
    }
    all[from] = left;
    const stoppedKey = STOPPED_PREFIX + from;
    if (Array.isArray(all[stoppedKey])) {
      all[stoppedKey] = all[stoppedKey].filter((s) => s && s.nonce > confirmed && now < s.until);
    }
    // The spend records: a settled one is kept SPENT_KEEP_MS from when it settled; an unsettled one while the
    // transaction is kept or, stopped, may still land.
    const spentKey = SPENT_PREFIX + from;
    const ledger = ledgerOf(all, from);
    if (ledger.length) {
      const stopped = Array.isArray(all[stoppedKey]) ? all[stoppedKey] : [];
      const kept = ledger
        .map((r) => (r.nonce <= confirmed && !r.settledAt ? { ...r, settledAt: now } : r))
        .filter((r) => (r.nonce <= confirmed
          ? now - r.settledAt < SPENT_KEEP_MS
          : left.some((e) => e.nonce === r.nonce) || stopped.some((s) => s && s.nonce === r.nonce)))
        .sort((a, b) => a.nonce - b.nonce)
        .slice(-SPENT_MAX);
      all[spentKey] = kept;
    }
    await writeAll(all, now);
    return left;
  });
}

/** Keeps a signed transaction before it is sent; one entry per (from, nonce), the newest wins. */
export function putSigned(entry) {
  return locked(async () => {
    const now = Date.now();
    const all = await readAll(now);
    const until = unreadableUntil(all);
    if (now < until) throw new PendingUnreadableError(until);
    const list = (all[entry.from] || []).filter((e) => e.nonce !== entry.nonce);
    list.push({ state: 'open', sends: 0, ...entry, bodyHash: entry.bodyHash || bodyHashOf(entry.body) });
    all[entry.from] = list.sort((a, b) => a.nonce - b.nonce);
    // What it can take, merged with whatever was signed at this nonce before (either may apply).
    const spentKey = SPENT_PREFIX + entry.from;
    const ledger = ledgerOf(all, entry.from);
    const before = ledger.find((r) => r.nonce === entry.nonce);
    const spend = before ? mergeSpend(normalSpend(before), entrySpend(entry)) : entrySpend(entry);
    all[spentKey] = [...ledger.filter((r) => r.nonce !== entry.nonce), { nonce: entry.nonce, ...spend, settledAt: null }]
      .sort((a, b) => a.nonce - b.nonce)
      .slice(-SPENT_MAX);
    await writeAll(all);
  });
}

/**
 * "Stop sending" (MOBNET-R3-01): deletes the kept transaction at (from, nonce) — while it is still the one `bodyHash`
 * names — and every kept one above it, which cannot go through without it. Refused (false) while a node is known to
 * hold any of them (stoppable). The wallet never sends them again, but one a node took earlier can still go through
 * until stopLandsUntil (MOBNET-R4-02): that is remembered (stoppedUntil). The next send from this wallet takes the
 * freed nonce, so at most one transaction ever applies there. Returns true when it deleted.
 */
export function stopFrom(from, nonce, { bodyHash = null, now = Date.now() } = {}) {
  return locked(async () => {
    const all = await readAll();
    const list = all[from] || [];
    const target = list.find((e) => e.nonce === nonce);
    if (!target || (bodyHash && target.bodyHash && target.bodyHash !== bodyHash)) return false;
    if (!stoppable(list, nonce, now)) return false;
    const gone = list.filter((e) => e.nonce >= nonce);
    all[from] = list.filter((e) => e.nonce < nonce);
    const key = STOPPED_PREFIX + from;
    const stopped = (Array.isArray(all[key]) ? all[key] : [])
      .filter((s) => s && now < s.until && !gone.some((e) => e.nonce === s.nonce));
    for (const e of gone) {
      const until = mayLandUntil(e);
      if (now < until) stopped.push({ nonce: e.nonce, bodyHash: e.bodyHash || null, until });
    }
    all[key] = stopped.slice(-RECENT_MAX);
    await writeAll(all);
    return true;
  });
}

/**
 * Patches the entry at (from, nonce) — only while it is still the transaction `bodyHash` names (when given):
 * an answer for bytes that were replaced meanwhile changes nothing. Returns the entry, or null.
 */
export function updateEntry(from, nonce, patch, { bodyHash = null } = {}) {
  return locked(async () => {
    const all = await readAll();
    const list = all[from] || [];
    const i = list.findIndex((e) => e.nonce === nonce);
    if (i < 0) return null;
    if (bodyHash && list[i].bodyHash && list[i].bodyHash !== bodyHash) return null;
    list[i] = { ...list[i], ...patch };
    all[from] = list;
    await writeAll(all);
    return list[i];
  });
}
