// QNet over HTTPS to the pinned node names only (EXT-04, EXT-09): balance, nonce and send checks from a pinned node's live
// tip, checked in the background against the committee's certificate with the mobile light client, QNC sends signed with
// ML-DSA-65 over the node's exact preimage and submitted as mobile sendQNC does, history from the explorer archive.
import * as core from '../lib/qnet-core.js';
import { U64_MAX, formatUnits, parseUnits } from './amount.js';
import {
  DECIMALS, FOLLOW_ALARM, FOLLOW_ALARM_MINUTES, LIMITS, QNET, RECORD_PATH, STORAGE_KEYS, TIMINGS,
} from './config.js';
import { WalletError } from './errors.js';
import * as keys from './keys.js';
import { log } from './log.js';
import * as session from './session.js';
import * as vault from './vault.js';

/**
 * @typedef {object} QnetBalance
 * @property {string} balanceNano u64 decimal
 * @property {string} nonce u64 decimal, the account's nonce in that state
 * @property {boolean} verified the proof folds to the state root of a macroblock whose committee certificate this
 *   wallet verified
 * @property {'proof'|'live'|'none'} verification proof: verified; live: a pinned node's live tip (ownLiveRead), shown
 *   while no certified state of its height or newer was read; none: a certified answer whose certificate is not verified
 *   yet
 * @property {number|null} blockHeight the height of the state shown: the certified state's, or the node's live tip; null
 *   for the 0 of an account two pinned nodes hold none of (a new wallet)
 * @property {string|null} spendableNano the live balance less what this wallet's own transactions took since and may
 *   still take (the send rule, liveSend); null without a live figure
 * @property {number} [walkSteps] not verified yet: the walk steps still to go while the walk is long (walkSteps)
 *
 * @typedef {object} TransferPreview  what an approval or review screen shows
 * @property {string} from
 * @property {string} to
 * @property {string} amountNano
 * @property {string} feeNano
 * @property {string} totalNano amountNano + feeNano
 * @property {string} nonce the nonce the transfer will be signed with
 * @property {string} balanceNano spendable: the live balance less what this wallet's own transactions took since and may
 *   still take (liveSend)
 * @property {boolean} verified always false: a send is decided at a pinned node's live tip, and the network refuses what
 *   it does not cover
 * @property {'live'} verification
 * @property {OutstandingTransfer[]} outstanding this wallet's earlier transfers not seen applied yet, oldest
 *   first; their nonces and amounts are reserved (a new one is sent in addition, or replaces one of them)
 * @property {string|null} replacesNonce the outstanding transfer this one replaces (signed at its nonce)
 *
 * @typedef {object} OutstandingTransfer
 * @property {string} nonce
 * @property {string} to
 * @property {string} amountNano
 * @property {string} feeNano
 * @property {number} createdAt
 * @property {boolean} stale no longer resent (PENDING_TRANSFER_TTL_MS): it may still apply until its nonce is used
 *
 * @typedef {object} HistoryItem
 * @property {string} hash '' for a transfer of this wallet not seen applied yet: the hash a node returned
 *   is not the transaction's identity (another copy may be the one that lands: R2-EXTQ-06); for one the chain took
 *   (vault outcome confirmed), the hash two pinned nodes list for it, or '' when they list different ones
 * @property {'in'|'out'|'self'} direction
 * @property {string} from
 * @property {string} to
 * @property {string} amountNano
 * @property {string} feeNano '0' for incoming
 * @property {number} timestamp ms epoch
 * @property {'included'|'unverified'|'pending'|'stale'|'replaced'|'dropped'|'unknown'|'refused'} status included: an
 *   archive row two pinned nodes list alike (a token row this wallet sent: its call), a token row its logs proof
 *   verifies, or a transaction of this wallet they list at its nonce, so it is in a block, which does not say it applied
 *   (a block carries transfers skipped at apply too: R5-EXTQ-01); unverified: an archive row they do not (older than
 *   their window, or not theirs: R4-EXTQ-04), or a token row its logs proof contradicts; stale: no longer resent, may
 *   still apply; replaced: another transaction of this wallet used its
 *   nonce, so it can never apply; unknown: its nonce was used and no two pinned nodes agree yet on what applied
 *   there (R3-EXTQ-04: check History); refused: the only node sent it refused it, and it may still apply (a node's
 *   word is not the chain's: R5-EXTQ-02), so it stays listed and reserved and the next transfer takes its nonce
 * @property {string|null} nonce the nonce of a transfer of this wallet the vault keeps, else null
 */

const HEDGE_MS = 700;
const MAX_RESPONSE_CHARS = 1 << 20;
// A balance or token proof answer is a few KB: a longer one is no answer (the app's PROOF_ANSWER_MAX_BYTES).
const PROOF_ANSWER_MAX_BYTES = 64 * 1024;
const MACROBLOCK_INTERVAL = 90;
// The light client walks every other macroblock up from the nearest trusted root on the index's parity
// chain: the release's weak-subjectivity pin, a macroblock this wallet verified before (kept in the
// vault database and imported at the first read, so a restarted worker goes on from there), or a root of the genesis
// capsule when the walk from this wallet's own roots would be long (docs/protocols/galc-capsule-v2.md). One call walks
// at most the light client's WALK_STEPS_PER_CALL steps, and every step it verifies is kept at once
// (R3-EXTQ-02): a walk longer than that goes on over the next reads instead of never starting. A read waits
// for the check at most QC_VERIFY_BUDGET_MS (the walk goes on in the background); a balance it did not certify in
// that time is not verified.
const QC_VERIFY_BUDGET_MS = 20000;
// What the popup's balance read (getBalance) waits for that check once a proof's figure is read (owner, 06.10: balances
// load fast): past it the figure is shown as not verified, the walk goes on in the background, and the next read takes
// the proof from what it verified. A send's reads (transferSnapshot) wait the whole budget.
const PROOF_DISPLAY_WAIT_MS = 1500;
// A certified proof counts only when its macroblock is within this many of the certified head, below or above it
// (R2-EXTQ-01): a node may replay a genuinely certified but old answer (a balance and nonce from before a spend).
const PROOF_MAX_LAG_MACROBLOCKS = 2;
// A certified head read is taken as recent this long (the light client's HEAD_HINT_TTL_MS).
const HEAD_SEEN_MS = 60000;
// With no recent certified head read, the newest verified macroblock is asked for first while its checkpoint is at most
// this old: it is then still within PROOF_MAX_LAG_MACROBLOCKS of the head and nodes keep its view (the app's
// RECENT_VERIFIED_MS).
const RECENT_VERIFIED_MS = 4 * 60 * 1000;
// A walk longer than this many steps is a long one: a balance not certified while it runs says how far it is
// (walkSteps; the app's LONG_WALK_STEPS).
const LONG_WALK_STEPS = 2;
// After a capsule refresh that found no node with a capsule, none is asked again for this long, across worker restarts
// too (the light client's CAPSULE_MISS_TTL_MS, which it keeps in worker memory only).
const CAPSULE_QUIET_MS = 10 * 60 * 1000;
// The light hints a woken worker takes over (lightHintsRead) are written at most this often while nothing else changed.
const LIGHT_HINTS_WRITE_MS = 20000;
// For this long after this wallet's own transaction its proofs ask for the newest certified state, so the send shows
// once certified (the app's OWN_SEND_LATEST_MS).
const OWN_SEND_LATEST_MS = 10 * 60 * 1000;
// A follow tick (followTick) walks at most this many steps: once caught up one step per macroblock on one parity; while
// far behind, the walk goes on over the next ticks and reads.
const FOLLOW_STEPS_PER_TICK = 16;
// A walk of more steps than this asks the pinned nodes for the genesis capsule first (the light client's
// OWN_ROOT_WALK_STEPS: a walk from this wallet's own roots of at most that many steps is taken even when the capsule roots
// higher).
const CAPSULE_WALK_STEPS = 16;
// The longest wait a node's Retry-After is honoured for.
const RETRY_AFTER_MAX_MS = 60000;
// A spend record (vault.spends) stays this long after the chain took its transaction: the live figure of a node that far
// behind still has it counted (liveSend; the app's SPENT_KEEP_MS).
const SPENT_KEEP_MS = 60 * 60 * 1000;
// The chain this wallet follows (followChain): a head two pinned nodes report this many macroblocks below the highest one
// this wallet saw, or below a macroblock it verified, is another chain (the live network never goes back; a lagging node
// is a few blocks behind, never 900): what the wallet kept of the old one goes.
const CHAIN_REWIND_MACROBLOCKS = 10;
const HEAD_CACHE_MS = 60000;
const HEAD_TIMEOUT_MS = 3000;
const MIN_NODE_AGREEMENT = 2;
const RESUBMIT_INTERVAL_MS = 30000;
// A body a node accepted is sent again only this often: every node that takes the POST stamps its own copy with its
// own hash, so each resend can put another copy in some mempool (R5-EXTQ-03); a node that restarted meanwhile lost it
// (mobile RESEND_HELD_MS).
const RESEND_ACCEPTED_MS = 10 * 60 * 1000;
// A pending transfer the chain has not taken within this time is no longer resent. It is not forgotten:
// the signed transfer stays valid until its nonce is used, so it keeps its nonce and amount reserved and
// shows as stale until the chain decides it or the user replaces it (R2-EXTQ-02).
const PENDING_TRANSFER_TTL_MS = 60 * 60 * 1000;
// How long a node keeps a transaction it admitted (its mempool lifetime, 1800 s from its own admission), and a margin
// for a peer that took it by gossip later and for clocks (the mobile app's NODE_MEMPOOL_TTL_MS and LANDING_MARGIN_MS):
// a transaction no longer sent, past this after it last went out with its nonce still free, is held by no node, so it
// did not go through and never will by itself: History shows it as not found (dropped), the next send takes its nonce,
// and it leaves the list a day later (owner, 06.10: a pending row resolves in a bounded time).
const NODE_MEMPOOL_TTL_MS = 30 * 60 * 1000;
const LANDING_MARGIN_MS = 5 * 60 * 1000;
// A transfer another transaction replaced stays listed this long after that was seen, then it is dropped.
const REPLACED_KEEP_MS = 24 * 60 * 60 * 1000;
// A transaction the chain took is kept as confirmed until the archive page lists its row as in a block (archiveClaims),
// and at most this long after that was seen, so History shows it from the moment it is in a block.
const CONFIRMED_KEEP_MS = 60 * 60 * 1000;
const SENT_HISTORY_PAGE = 100;
// The newest rows of a node's history an archive row is checked against (the node's page limit).
const HISTORY_CHECK_PAGE = 100;
const HISTORY_DEFAULT_LIMIT = 20;

const PATH_RE = /^\/api\/v1\/[A-Za-z0-9_\-./?=&%]*$/;
const HEADER_NAME_RE = /^x-qnet-[a-z0-9-]{1,32}$/;
const HEADER_VALUE_RE = /^[\x20-\x7e]{1,256}$/;
const U64_RE = /^(0|[1-9][0-9]{0,19})$/;
const HEX_RE = /^[0-9a-f]+$/;
const TX_HASH_RE = /^[0-9A-Za-z]{16,128}$/;
const PRINTABLE_RE = /^[\x21-\x7e]{1,128}$/;
const CURSOR_RE = /^[\x21-\x7e]{1,512}$/;

// ---------------------------------------------------------------- raw JSON

/**
 * JSON.parse that keeps every number as its literal text, so a u64 balance or nonce never passes through
 * a float. Objects are plain, with own properties only (a "__proto__" key stays a key).
 * @param {string} text
 * @returns {unknown} numbers come back as strings of their literal
 * @throws {SyntaxError} on malformed JSON or nesting deeper than 64
 */
export function parseJsonLossless(text) {
  if (typeof text !== 'string') throw new SyntaxError('JSON text expected');
  let i = 0;
  const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  const skip = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i])) i++;
  };
  const fail = () => {
    throw new SyntaxError(`Bad JSON at ${i}`);
  };
  const string = () => {
    const start = i++;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    if (i >= text.length) fail();
    i++;
    return JSON.parse(text.slice(start, i));
  };
  const literal = (word, value) => {
    if (text.startsWith(word, i)) {
      i += word.length;
      return value;
    }
    return fail();
  };
  const value = (depth) => {
    if (depth > 64) fail();
    skip();
    const c = text[i];
    if (c === '"') return string();
    if (c === '{') {
      i++;
      const out = {};
      skip();
      if (text[i] === '}') {
        i++;
        return out;
      }
      for (;;) {
        skip();
        if (text[i] !== '"') fail();
        const key = string();
        skip();
        if (text[i++] !== ':') fail();
        Object.defineProperty(out, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
        skip();
        if (text[i] === ',') i++;
        else if (text[i] === '}') {
          i++;
          return out;
        } else fail();
      }
    }
    if (c === '[') {
      i++;
      const out = [];
      skip();
      if (text[i] === ']') {
        i++;
        return out;
      }
      for (;;) {
        out.push(value(depth + 1));
        skip();
        if (text[i] === ',') i++;
        else if (text[i] === ']') {
          i++;
          return out;
        } else fail();
      }
    }
    if (c === 't') return literal('true', true);
    if (c === 'f') return literal('false', false);
    if (c === 'n') return literal('null', null);
    NUMBER.lastIndex = i;
    const match = NUMBER.exec(text);
    if (!match) fail();
    i = NUMBER.lastIndex;
    return match[0];
  };
  const result = value(0);
  skip();
  if (i !== text.length) fail();
  return result;
}

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

// A checkpoint's or an archive row's timestamp, written in seconds or in milliseconds, in milliseconds.
const msOf = (timestamp) => (timestamp < 1e12 ? timestamp * 1000 : timestamp);

// A u64 field as the node wrote it (a JSON number, or its decimal string), else null.
function u64Of(value) {
  if (typeof value !== 'string' || !U64_RE.test(value)) return null;
  return BigInt(value) <= U64_MAX ? value : null;
}

function safeIntOf(value) {
  if (typeof value !== 'string' || !/^[0-9]{1,16}$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

// ---------------------------------------------------------------- transport

function shuffled(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// The wait a refusing node asks for, in ms: its Retry-After seconds, else the typed rate limit body's
// retry_after_seconds; null for anything else.
function waitAsked(response, text) {
  if (response.status !== 429 && response.status !== 503) return null;
  let seconds = null;
  const header = response.headers?.get?.('retry-after');
  if (typeof header === 'string' && /^\d{1,5}$/.test(header.trim())) seconds = Number(header.trim());
  if (seconds === null) {
    try {
      const body = JSON.parse(text);
      if (Number.isSafeInteger(body?.retry_after_seconds) && body.retry_after_seconds >= 0) seconds = body.retry_after_seconds;
    } catch {
      seconds = null;
    }
  }
  return seconds === null ? null : Math.min(RETRY_AFTER_MAX_MS, Math.max(1000, seconds * 1000));
}

// The body is read with a cap on the bytes that arrive, never whole first: a chunked or compressed answer has
// no usable length, and a small gzip body can inflate to gigabytes (R4-EXTQ-03, core.readBoundedText).
async function fetchText(url, init, timeoutMs, controller, maxBytes = MAX_RESPONSE_CHARS) {
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await core.readBoundedText(response, maxBytes);
    return { status: response.status, text, waitMs: waitAsked(response, text) };
  } finally {
    clearTimeout(timer);
  }
}

// Pinned nodes that asked to be left alone (a 429 or 503 with a wait), until when: proof reads ask them last.
const waitUntil = new Map();
const noteWait = (node, ms) => {
  if (Number.isSafeInteger(ms) && ms > 0) waitUntil.set(node, Date.now() + ms);
};
const waiting = (node, now) => (waitUntil.get(node) ?? 0) > now;

function requestInit(method, body, headers) {
  if (method !== 'GET' && method !== 'POST') throw new WalletError('INTERNAL');
  const init = {
    method, credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: {},
  };
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (!HEADER_NAME_RE.test(name) || typeof value !== 'string' || !HEADER_VALUE_RE.test(value)) {
      throw new WalletError('INTERNAL');
    }
    init.headers[name] = value;
  }
  if (method === 'POST') {
    init.headers['Content-Type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body ?? {});
  } else if (body !== undefined) {
    throw new WalletError('INTERNAL');
  }
  return init;
}

// 5xx and 429 say nothing about the request, so the next node is asked; anything else is an answer.
const isAnswer = (status) => status >= 200 && status < 500 && status !== 429;

/**
 * One request to a pinned node (QNET.NODES, https only), hedged across nodes like mobile _hedged: the
 * first node is asked, a second joins after HEDGE_MS of silence, a failing node hands over to the next,
 * and the first answer wins. A 5xx or 429 counts as no answer. u64 fields are read from the raw text
 * (parseJsonLossless), never through JSON numbers. A refusal that asks for a wait (Retry-After, or the typed rate limit
 * body) is noted: proof reads ask that node last until then.
 * @param {string} path starting with '/api/v1/'
 * @param {{method?: 'GET'|'POST', body?: object|string, headers?: Record<string, string>, timeoutMs?: number,
 *   hedgeMs?: number, nodes?: string[], maxBytes?: number}} [options] a string body is sent byte for byte; headers only
 *   x-qnet-*; nodes: a subset of QNET.NODES to ask, in order (default: all, shuffled); maxBytes: the largest answer
 *   taken (default 1 MiB)
 * @returns {Promise<{status: number, text: string, node: string, attempts: number}>} attempts: how many
 *   nodes had been sent the request when the answer came
 * @throws {WalletError} NETWORK when no node answered
 */
export async function nodeRequest(path, options = {}) {
  const {
    method = 'GET', body, headers, timeoutMs = TIMINGS.NODE_TIMEOUT_MS, hedgeMs = HEDGE_MS, nodes, maxBytes = MAX_RESPONSE_CHARS,
  } = options;
  if (typeof path !== 'string' || path.length > 1024 || !PATH_RE.test(path) || path.includes('..') || path.includes('//')) {
    throw new WalletError('INTERNAL');
  }
  const bases = nodes === undefined ? shuffled(QNET.NODES) : [...nodes];
  if (bases.length === 0 || bases.some((base) => !QNET.NODES.includes(base))) throw new WalletError('INTERNAL');
  const init = requestInit(method, body, headers);

  return new Promise((resolve, reject) => {
    const controllers = [];
    let settled = false;
    let launched = 0;
    let running = 0;
    let hedgeTimer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(hedgeTimer);
      for (const controller of controllers) controller.abort();
      fn(value);
    };
    const next = () => {
      if (settled) return;
      if (launched < bases.length) launch();
      else if (running === 0) finish(reject, new WalletError('NETWORK'));
    };
    const launch = () => {
      const base = bases[launched++];
      const controller = new AbortController();
      controllers.push(controller);
      running++;
      fetchText(base + path, init, timeoutMs, controller, maxBytes).then((reply) => {
        running--;
        if (!isAnswer(reply.status)) {
          noteWait(base, reply.waitMs);
          next();
        } else {
          finish(resolve, { status: reply.status, text: reply.text, node: base, attempts: launched });
        }
      }, () => {
        running--;
        next();
      });
    };
    launch();
    if (bases.length > 1) {
      hedgeTimer = setTimeout(() => {
        if (!settled && launched < 2) launch();
      }, hedgeMs);
    }
  });
}

// The explorer archive (QNET.EXPLORER_API): one host, no hedging; anything but a 200 is NETWORK.
async function explorerRequest(path) {
  if (typeof path !== 'string' || !path.startsWith('/api/address/') || path.length > 1024) throw new WalletError('INTERNAL');
  let reply;
  try {
    reply = await fetchText(QNET.EXPLORER_API + path, requestInit('GET'), TIMINGS.NODE_TIMEOUT_MS, new AbortController());
  } catch {
    throw new WalletError('NETWORK');
  }
  if (reply.status !== 200) throw new WalletError('NETWORK');
  return reply.text;
}

// A path of aiqnet.io's burn record API: RECORD_PATH, then letters, digits and the separators of one route and query.
const SITE_PATH_RE = /^[A-Za-z0-9/_?=&%.-]*$/;

/**
 * One request to aiqnet.io's record of this wallet's burn (QNET.EXPLORER_API, paths under RECORD_PATH only; CONTRACTS.md
 * decision 35): one host, no hedging, no credentials, JSON, TIMINGS.RECORD_TIMEOUT_MS. Every status is an answer the
 * caller reads; only no answer at all is an error.
 * @param {'GET'|'POST'} method
 * @param {string} path starting with RECORD_PATH
 * @param {object} [body] POST only
 * @returns {Promise<{status: number, body: unknown}>} body: the parsed JSON, or null when there is none or it does not parse
 * @throws {WalletError} RECORD_UNAVAILABLE when aiqnet.io did not answer; INTERNAL for a path or method not allowed
 */
export async function siteRequest(method, path, body) {
  if (typeof path !== 'string' || !path.startsWith(RECORD_PATH) || path.length > 512 || path.includes('..') || path.includes('//')
    || !SITE_PATH_RE.test(path)) {
    throw new WalletError('INTERNAL');
  }
  const init = requestInit(method, method === 'POST' ? (body ?? {}) : undefined);
  let reply;
  try {
    reply = await fetchText(QNET.EXPLORER_API + path, init, TIMINGS.RECORD_TIMEOUT_MS, new AbortController());
  } catch {
    throw new WalletError('RECORD_UNAVAILABLE');
  }
  let parsed = null;
  try {
    parsed = reply.text === '' ? null : JSON.parse(reply.text);
  } catch {
    parsed = null;
  }
  return { status: reply.status, body: parsed };
}

function parseOrNull(text) {
  try {
    return parseJsonLossless(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- account reads

// /api/v1/account/{a} answer, or null: two pinned nodes alike give the chain's nonce now (agreeingAccount), which only
// splits this wallet's own transactions into taken and still pending; no balance is ever taken from it.
function accountAnswer(reply, address) {
  if (!reply || reply.status !== 200) return null;
  const body = parseOrNull(reply.text);
  if (!isObject(body) || body.address !== address) return null;
  const balanceNano = u64Of(body.balance);
  const nonce = u64Of(body.nonce);
  if (balanceNano === null || nonce === null) return null;
  return { balanceNano, nonce, pkBound: body.has_dilithium_pk === true };
}

async function withinBudget(promise, ms) {
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

// What this module starts and does not wait for (a certified check beside a live figure, a walk past its budget, the
// chain check, a run of resubmitPending, the Send tab's reads ahead), each until it ends (backgroundReads).
const backgroundRuns = new Set();
function background(promise) {
  backgroundRuns.add(promise);
  const done = () => backgroundRuns.delete(promise);
  promise.then(done, done);
  return promise;
}

// A certified read the popup starts on every refresh runs once per key at a time, in the background: a refresh while it
// runs joins it (its walk may take QC_VERIFY_BUDGET_MS, longer than the popup's refresh). `start` never rejects.
function joinedRead(running, key, start) {
  const kept = running.get(key);
  if (kept !== undefined) return kept;
  const read = background(start());
  running.set(key, read);
  read.then(() => {
    if (running.get(key) === read) running.delete(key);
  });
  return read;
}

/**
 * Resolves once everything this module started in the background has ended, and what that started in turn. Exported for
 * tests: a test waits for its reads before the next one replaces the network.
 * @returns {Promise<void>}
 */
export async function backgroundReads() {
  while (backgroundRuns.size > 0) await Promise.allSettled([...backgroundRuns]);
}

// ---------------------------------------------------------------- verified anchors (EXT-CHAINS-04)

let anchorsLoaded = null;
// What the vault holds of the anchors (anchorsKey of what was last read or written): written again only when the
// light client's export differs.
let persistedKey = null;
// The capsule index the vault holds (0: none).
let capsuleKept = 0;

// An export of the anchors as its indices, and whether each carries its roots.
const anchorsKey = (anchors) => JSON.stringify(Object.entries(anchors).map(([j, a]) => [j, a.state_root !== undefined]).sort());

// Once per worker (again after a failed read, e.g. while locked): the macroblocks verified in earlier sessions root the
// next walks and answer at their own index, and then the kept genesis capsule, verified again in full, roots the walks
// those anchors cannot shorten.
function loadAnchors() {
  anchorsLoaded ??= (async () => {
    await lightHintsRead();
    try {
      const stored = await vault.readLightAnchors();
      if (stored !== null) core.importVerifiedAnchors(stored);
      persistedKey = anchorsKey(core.exportVerifiedAnchors());
    } catch (error) {
      anchorsLoaded = null;
      log.warn('verified anchors unreadable', error?.code ?? error?.name);
      return;
    }
    await loadCapsule();
  })();
  return anchorsLoaded;
}

// The capsule the vault keeps, taken when core.importCapsule verifies it again; one it refuses is deleted (a higher one
// held already leaves it to persistCapsule).
async function loadCapsule() {
  let record = null;
  try {
    record = await vault.readCapsule();
  } catch (error) {
    log.warn('capsule unreadable', error?.code ?? error?.name);
    return;
  }
  if (record === null) return;
  const got = await core.importCapsule(record);
  if (got.ok) {
    capsuleKept = got.index;
    return;
  }
  if (got.reason === 'stale') return;
  log.warn('kept capsule refused', got.reason);
  await forgetKeptCapsule();
}

// After a refresh took a newer capsule: keep it.
async function persistCapsule() {
  const index = core.heldCapsuleIndex();
  if (index === 0 || index === capsuleKept) return;
  const record = core.exportCapsule();
  if (record === null) return;
  try {
    await vault.writeCapsule(record);
    capsuleKept = index;
  } catch (error) {
    log.warn('capsule not kept', error?.code ?? error?.name);
  }
}

// The kept copy goes: the light client dropped the capsule (another lineage than what the walk verified) or forgot it.
async function forgetKeptCapsule() {
  capsuleKept = 0;
  await vault.writeCapsule(null).catch((error) => log.warn('kept capsule not dropped', error?.code ?? error?.name));
}

// Before a walk of more than CAPSULE_WALK_STEPS steps under the certified head `head`: the genesis capsule, asked of the
// pinned nodes (core.refreshCapsule answers 'not_needed' while the walks from this wallet's own roots are short; a node
// without one, today's 405, is not asked again for its TTL), so a fresh install or a wallet long closed walks a few steps from it instead of from the pin.
// Without one the walk goes on from the pin and the anchors exactly as before.
// After a refresh that found no node with one, none is asked for CAPSULE_QUIET_MS, also by the next worker (light hints).
async function refreshCapsule(head) {
  await lightHintsRead();
  if (Date.now() < capsuleQuietUntil) return { ok: false, reason: 'no_capsule' };
  const got = await core.refreshCapsule(() => shuffled(QNET.NODES), { headHint: head, proofNodes: () => proofOrder() })
    .catch(() => ({ ok: false, reason: 'unrooted' }));
  if (got.ok) await persistCapsule();
  else if (got.reason === 'no_capsule') {
    capsuleQuietUntil = Date.now() + CAPSULE_QUIET_MS;
    keepLightHints(true);
  }
  return got;
}

// After a walk verified macroblocks the vault does not hold yet: keep the light client's export (the highest macroblock
// of each parity, with its roots).
async function persistAnchors() {
  const anchors = core.exportVerifiedAnchors();
  const key = anchorsKey(anchors);
  if (key === persistedKey) return;
  try {
    await vault.writeLightAnchors(anchors);
    persistedKey = key;
  } catch (error) {
    log.warn('verified anchors not kept', error?.code ?? error?.name);
  }
}

// hooks.onProgress of a walk: each verified step is kept (one write at a time; steps verified during a write
// are kept by the next one), so a walk cut short by its per-call bound or the read's budget resumes there.
let persisting = null;
let persistAgain = false;
function keepWalkProgress() {
  if (persisting !== null) {
    persistAgain = true;
    return;
  }
  persisting = (async () => {
    do {
      persistAgain = false;
      await persistAnchors();
    } while (persistAgain);
  })().finally(() => {
    persisting = null;
  });
}

const pinIndex = () => core.genesisConsensus.WS_CHECKPOINT.index || 0;

/**
 * Drops every macroblock this wallet verified (in memory and kept in the vault): they belong to a chain the pinned nodes
 * no longer serve (followChain, a lineage that no longer verifies). The next walk starts from the release's pin again, or
 * from the genesis capsule, which stays (it is bound to this build's network and checked against everything verified
 * later; forgetChain forgets it); dropping costs work, never trust.
 * @returns {Promise<void>}
 */
async function dropAnchors() {
  core.clearQcCache();
  anchorsLoaded = Promise.resolve();
  headHintSeen = null;
  keepLightHints(true);
  persistedKey = anchorsKey({});
  await vault.writeLightAnchors({}).catch((error) => log.warn('kept anchors not dropped', error?.code ?? error?.name));
}

// The hooks of every walk. Each verified step is kept; when the light client finds the anchors kept from an earlier
// session to be of another lineage (the first step above one refused by two nodes for what ties it to that anchor:
// QcLightClient's onLineageReset), it drops them and walks from the pin at once, and the copy kept in the vault goes with
// them (owner, 06.10: unverifiable caches never hang the wallet); a capsule it finds of another lineage than what the
// walk verified goes the same way, from the vault too.
const walkHooks = () => ({
  onProgress: keepWalkProgress,
  onLineageReset: () => {
    log.warn('kept anchors of another lineage dropped');
    persistedKey = null;
    keepWalkProgress();
  },
  onCapsuleDropped: () => {
    log.warn('capsule of another lineage dropped');
    forgetKeptCapsule();
  },
});

// ---------------------------------------------------------------- certified state

// The certified head as the pinned nodes last reported it ({index, at}): proofPasses pins a verified index by it.
let headHintSeen = null;
// Until when no node is asked for a capsule (refreshCapsule): the last refresh found none with one.
let capsuleQuietUntil = 0;

// What a worker woken from sleep takes over from the one before it, in chrome.storage.session (STORAGE_KEYS.LIGHT_HINTS):
// the certified head last seen (headHintSeen), so its first proof read asks for the macroblock it holds at once, and
// capsuleQuietUntil, so it does not probe nodes that had no capsule again. Hints only: a proof stands only by the
// certified head read with it, and a quiet probe costs a longer walk at most. Read once per worker (loadAnchors).
let hintsRead = null;
function lightHintsRead() {
  hintsRead ??= (async () => {
    try {
      const stored = (await globalThis.chrome?.storage?.session?.get(STORAGE_KEYS.LIGHT_HINTS))?.[STORAGE_KEYS.LIGHT_HINTS];
      if (!isObject(stored)) return;
      const seen = stored.headSeen;
      if (headHintSeen === null && isObject(seen) && Number.isSafeInteger(seen.index) && seen.index >= 0
          && Number.isSafeInteger(seen.at) && seen.at <= Date.now()) {
        headHintSeen = { index: seen.index, at: seen.at };
      }
      if (Number.isSafeInteger(stored.capsuleQuietUntil)) {
        capsuleQuietUntil = Math.max(capsuleQuietUntil, Math.min(stored.capsuleQuietUntil, Date.now() + CAPSULE_QUIET_MS));
      }
    } catch {
      // none kept, or no session storage here
    }
  })();
  return hintsRead;
}

let hintsWritten = { index: null, at: 0 };
function keepLightHints(now = false) {
  const index = headHintSeen?.index ?? null;
  if (!now && index === hintsWritten.index && Date.now() - hintsWritten.at < LIGHT_HINTS_WRITE_MS) return;
  hintsWritten = { index, at: Date.now() };
  try {
    Promise.resolve(globalThis.chrome?.storage?.session?.set({
      [STORAGE_KEYS.LIGHT_HINTS]: { headSeen: headHintSeen, capsuleQuietUntil },
    })).catch(() => {});
  } catch {
    // no session storage here
  }
}

/**
 * How many walk steps still stand between what this wallet verified and a checkpoint recent enough for a proof (within
 * PROOF_MAX_LAG_MACROBLOCKS of the certified head seen last: core.stepsToVerify) when that is more than LONG_WALK_STEPS;
 * else null (no head seen, a short walk, or none possible). While it is not null a balance not certified yet shows this
 * progress (wallet-galc plan, Part 3 item 6; the app's walkSteps).
 * @returns {number|null}
 */
export function walkSteps() {
  if (headHintSeen === null) return null;
  const head = Math.max(headHintSeen.index, core.highestVerifiedIndex());
  let steps = Infinity;
  for (let index = head; index >= Math.max(1, head - PROOF_MAX_LAG_MACROBLOCKS); index--) {
    steps = Math.min(steps, core.stepsToVerify(index));
  }
  return Number.isFinite(steps) && steps > LONG_WALK_STEPS ? steps : null;
}

// What a balance not certified adds while a long walk is why: {walkSteps}, else nothing.
const walkNote = () => {
  const steps = walkSteps();
  return steps === null ? {} : { walkSteps: steps };
};

/**
 * The certified head a proof's freshness is judged by: the higher of the newest macroblock this wallet verified and the
 * second highest certified frontier of at least three pinned nodes (core.certifiedHeadHint, GET /api/v1/state/certified,
 * cached a minute), never the applied tip a node reports; null when too few answer (no proof is then fresh).
 * @returns {Promise<number|null>}
 */
async function certifiedHeadNow() {
  const hint = await core.certifiedHeadHint(() => QNET.NODES).catch(() => null);
  if (!Number.isSafeInteger(hint)) return null;
  headHintSeen = { index: hint, at: Date.now() };
  keepLightHints();
  return Math.max(core.highestVerifiedIndex(), hint);
}

/**
 * Whether a certified index may stand as the account's state (R2-EXTQ-01): within PROOF_MAX_LAG_MACROBLOCKS of the
 * certified head, below or above it (a node may replay a genuinely certified but older state; an index far above the head
 * is not walked to). No head, no proof.
 * @param {number} index
 * @param {number|null} head certifiedHeadNow
 * @returns {boolean}
 */
export function certifiedIndexStands(index, head) {
  return Number.isSafeInteger(index) && Number.isSafeInteger(head)
    && index >= head - PROOF_MAX_LAG_MACROBLOCKS && index <= head + PROOF_MAX_LAG_MACROBLOCKS;
}

// The committee-certified state root of macroblock `index` when the index stands (certifiedIndexStands): the light client
// walks up to that index only (core.certifiedStateRootAt), from the genesis capsule when that walk is long
// (refreshCapsule), within QC_VERIFY_BUDGET_MS. {ok: true, stateRoot} or {ok: false}, with `walking` when the budget ran
// out while the walk goes on.
async function certifiedRootFresh(index) {
  await loadAnchors();
  const head = await certifiedHeadNow();
  if (!certifiedIndexStands(index, head) || index < core.trustFloorIndex()) return { ok: false };
  const walk = background((async () => {
    if (core.stepsToVerify(index) > CAPSULE_WALK_STEPS) await refreshCapsule(head);
    return core.certifiedStateRootAt(index, () => shuffled(QNET.NODES), walkHooks());
  })().catch(() => ({ ok: false })));
  const got = await withinBudget(walk, QC_VERIFY_BUDGET_MS);
  if (got === false) return { ok: false, walking: true };
  if (!got?.ok) return { ok: false };
  await persistAnchors();
  return { ok: true, stateRoot: got.stateRoot };
}

// The certified index whose root an older node's live-root proof folds to (core.certifiedStateRootIndex: the macroblock
// covering its height or one of the two before it), when it is recent by the certified head; else null. Such a root is
// certified only while no account changed since that macroblock. A height far past the head is not walked to.
async function legacyIndexFresh(stateRoot, blockHeight) {
  await loadAnchors();
  const head = await certifiedHeadNow();
  if (head === null || Math.floor(blockHeight / MACROBLOCK_INTERVAL) > head + PROOF_MAX_LAG_MACROBLOCKS) return null;
  const walk = background((async () => {
    if (core.stepsToVerify(Math.floor(blockHeight / MACROBLOCK_INTERVAL)) > CAPSULE_WALK_STEPS) await refreshCapsule(head);
    return core.certifiedStateRootIndex(stateRoot, blockHeight, () => shuffled(QNET.NODES), walkHooks());
  })().catch(() => null));
  const index = await withinBudget(walk, QC_VERIFY_BUDGET_MS);
  if (!Number.isSafeInteger(index)) return null;
  await persistAnchors();
  return index >= head - PROOF_MAX_LAG_MACROBLOCKS ? index : null;
}

// When this wallet last signed a transaction from an address (OWN_SEND_LATEST_MS).
const ownSendAt = new Map();

// The newest transaction the vault keeps for `address` counts as its last send (a restarted worker forgets the map).
function noteOwnSends(address, state) {
  const newest = Math.max(0, ...(state?.pendingTransfers ?? []).map((p) => p.createdAt));
  if (newest > (ownSendAt.get(address) ?? 0)) ownSendAt.set(address, newest);
}

/**
 * The macroblocks a proof read asks for, in turn: the newest macroblock this wallet verified while it stands by the
 * certified head read last (no new committee check until it leaves the window), then 'latest'; only 'latest' for
 * OWN_SEND_LATEST_MS after this wallet's own transaction, so the send is checked once certified.
 * @param {string} address
 * @returns {string[]}
 */
function proofPasses(address) {
  const now = Date.now();
  if (now - (ownSendAt.get(address) ?? 0) < OWN_SEND_LATEST_MS) return ['latest'];
  const verified = core.highestVerifiedIndex();
  if (verified < core.trustFloorIndex()) return ['latest'];
  if (headHintSeen === null || now - headHintSeen.at >= HEAD_SEEN_MS) {
    const ms = msOf(Number(core.verifiedCheckpoint(verified)?.timestamp));
    return Number.isSafeInteger(ms) && ms > 0 && now - ms < RECENT_VERIFIED_MS ? [String(verified), 'latest'] : ['latest'];
  }
  const head = Math.max(verified, headHintSeen.index);
  return verified >= head - PROOF_MAX_LAG_MACROBLOCKS ? [String(verified), 'latest'] : ['latest'];
}

// The pinned nodes a proof is asked of, in order: those neither waiting out a Retry-After nor marked as answering with
// the older proof (core.markNodeOld, for core's OLD_NODE_MARK_MS) first, in a fresh random order, then the marked ones, the
// waiting ones last.
function proofOrder() {
  const now = Date.now();
  const list = shuffled(QNET.NODES);
  return [
    ...list.filter((node) => !waiting(node, now) && !core.nodeMarkedOld(node, now)),
    ...list.filter((node) => !waiting(node, now) && core.nodeMarkedOld(node, now)),
    ...list.filter((node) => waiting(node, now)),
  ];
}

/**
 * Proof answers from the pinned nodes, one node after another (each at most once a pass), for `path` + `?mb=` each of
 * `passes` (null: the live route, `path` alone); a later pass only when a node answered the earlier one (a pinned
 * macroblock no node holds any more is followed by 'latest'). judge(reply) reads one 200 answer: {verified} ends the read,
 * {figure} keeps the first figure whose proof folds under the root its node named. On the live route, which certifies
 * nothing, the first figure enough(figure) takes ends the read (any figure without `enough`); while none does, the next
 * node is asked and the figure of the highest block kept (a node a block or more behind answered first). Any answer
 * without a verifiable proof (an error, a rate limit, a body of another shape, a root not certified) is no answer: the
 * next node is asked; but a figure whose certificate waits only for a long walk ({walking}, walkSteps) ends the read:
 * another node's proof waits for the same walk, so one read waits one budget, never one per node.
 * @returns {Promise<{verified: object|null, figure: object|null, answered: boolean}>} answered: a node answered (a 5xx or
 *   429 is no answer)
 */
async function proofAnswers(path, passes, judge, enough = null) {
  let figure = null;
  let answered = false;
  for (const mb of passes) {
    const tried = new Set();
    let reached = false;
    for (;;) {
      const left = proofOrder().filter((node) => !tried.has(node));
      if (left.length === 0) break;
      let reply;
      try {
        reply = await nodeRequest(mb === null ? path : `${path}?mb=${mb}`, { nodes: left, maxBytes: PROOF_ANSWER_MAX_BYTES });
      } catch {
        break;
      }
      tried.add(reply.node);
      reached = true;
      answered = true;
      if (reply.status !== 200) continue;
      const got = await judge(reply).catch(() => ({}));
      if (got.verified) return { verified: got.verified, figure: null, answered };
      if (got.figure && (figure === null || (mb === null && heightOf(got.figure) > heightOf(figure)))) figure = got.figure;
      if (mb === null && figure !== null && (enough === null || enough(figure))) return { verified: null, figure, answered };
      if (got.walking && walkSteps() !== null) return { verified: null, figure, answered };
    }
    if (!reached) break;
  }
  return { verified: null, figure, answered };
}

// One proof answer read by the app's strict parse (a repeated key refuses it, a u64 past 2^53 stays exact), or null.
function strictBody(text) {
  try {
    const body = core.parseStrictJson(text);
    return isObject(body) ? body : null;
  } catch {
    return null;
  }
}

// Every leaf input of an account proof body at a node's live root (the route without `mb`, or an older node's, which
// ignores the query), or null: a field it does not carry is 0, as in the app's reading of that body.
function legacyAccountFields(body, address) {
  if (body.address !== address || !Array.isArray(body.merkle_proof) || body.merkle_proof.length === 0) return null;
  if (typeof body.state_root !== 'string' || !/^[0-9a-f]{64}$/.test(body.state_root)) return null;
  if (!Number.isSafeInteger(body.block_height) || body.block_height < 0) return null;
  const u64 = (key) => (body[key] === undefined ? '0' : core.u64Text(body[key]));
  const u16 = (key) => (body[key] === undefined ? 0 : body[key]);
  const fields = {
    address,
    balance: core.u64Text(body.balance),
    nonce: core.u64Text(body.nonce),
    lastClaimedEpoch: u64('last_claimed_epoch'),
    heartbeatEpoch: u64('heartbeat_epoch'),
    heartbeatFinalEpoch: u64('heartbeat_final_epoch'),
    bannedAtHeight: u64('banned_at_height'),
    heartbeatSlots: u16('heartbeat_slots'),
    heartbeatFinalSlots: u16('heartbeat_final_slots'),
    isNode: body.is_node === true,
  };
  const u64Keys = ['balance', 'nonce', 'lastClaimedEpoch', 'heartbeatEpoch', 'heartbeatFinalEpoch', 'bannedAtHeight'];
  if (u64Keys.some((key) => fields[key] === null)) return null;
  if ([fields.heartbeatSlots, fields.heartbeatFinalSlots].some((v) => !Number.isInteger(v) || v < 0 || v > 0xffff)) return null;
  return fields;
}

// The account in a body at a node's live root, when its proof folds to that root: {balanceNano, nonce, blockHeight}; else
// null (an absent account has no such proof).
function liveRootAccount(body, address) {
  const fields = legacyAccountFields(body, address);
  if (fields === null || !core.verifyAccountProof(fields, body.merkle_proof, body.state_root)) return null;
  return { balanceNano: fields.balance, nonce: fields.nonce, blockHeight: body.block_height };
}

/**
 * One 200 answer of the account balance proof route. A certified answer (proof_format 2) folds to the committee-certified
 * root of the macroblock it names (certifiedRootFresh); the answer of a node from before certified proofs folds to its
 * node's live root, which counts only when that root is a recent certified one (legacyIndexFresh), and marks the node old
 * when its shape says so (core.isLegacyProofBody). onFigure(figure): a figure whose proof folds under the root its node
 * named, before the walk decides.
 * @returns {Promise<{verified?: object, figure?: object|null}>} a figure: {balanceNano, nonce, index, blockHeight, exists,
 *   isContract} (isContract: the leaf's is_contract; null from an older node's body, which does not carry it)
 */
async function judgeAccount(address, reply, onFigure) {
  const body = strictBody(reply.text);
  if (body === null) return {};
  if (body.proof_format !== undefined) {
    const read = core.readCertifiedAccount(body, address);
    if (!read.ok) return {};
    const figure = {
      balanceNano: read.account.balance, nonce: read.account.nonce, index: read.index,
      blockHeight: read.index * MACROBLOCK_INTERVAL, exists: read.account.exists, isContract: read.account.is_contract === true,
    };
    const folded = typeof body.state_root === 'string' && read.fold(body.state_root);
    if (folded) onFigure?.(figure);
    const root = await certifiedRootFresh(read.index);
    if (root.ok && read.fold(root.stateRoot)) return { verified: figure };
    return { figure: folded ? figure : null, ...(root.walking ? { walking: true } : {}) };
  }
  if (core.isLegacyProofBody(body, 'account')) core.markNodeOld(reply.node);
  const live = liveRootAccount(body, address);
  if (live === null) return {};
  const figure = { ...live, index: null, exists: true, isContract: null };
  onFigure?.(figure);
  const index = await legacyIndexFresh(body.state_root, body.block_height);
  if (index === null) return { figure };
  return { verified: { ...figure, index, blockHeight: index * MACROBLOCK_INTERVAL } };
}

// The account proof of `address` (proofPasses, judgeAccount); a verified one's nonce is kept as the highest certified one
// seen.
async function accountProof(address, { onFigure = null } = {}) {
  // the macroblocks kept from before and the head last seen first (a woken worker), so the proof asks for the newest
  // verified one while it stands; the certified head it is judged by is read while the proof is fetched
  await loadAnchors();
  background(certifiedHeadNow().catch(() => null));
  const got = await proofAnswers(`/api/v1/account/${address}/balance/proof`, proofPasses(address),
    (reply) => judgeAccount(address, reply, onFigure));
  if (got.verified) noteChainNonce(address, got.verified.nonce);
  return got;
}

// A figure not certified yet carries walkSteps while a long walk is why (walkNote).
const accountView = (figure, verified) => ({
  balanceNano: figure.balanceNano,
  nonce: figure.nonce,
  verified,
  verification: verified ? 'proof' : 'none',
  blockHeight: figure.blockHeight ?? null,
  index: figure.index ?? null,
  ...(verified ? {} : walkNote()),
});

/**
 * Balance and nonce of `address` from its account proof (GET /api/v1/account/{a}/balance/proof?mb=): verified
 * ('proof') when it folds to the state root of a recent macroblock whose committee certificate the light client verified,
 * else a figure whose proof folds under the root its node named, shown as not verified ('none') and never a 0. With
 * `display` (the popup's balance) the check is waited for at most PROOF_DISPLAY_WAIT_MS once such a figure was read, and
 * goes on in the background.
 * @param {string} address EON
 * @param {{display?: boolean}} [options]
 * @returns {Promise<{balanceNano: string, nonce: string, verified: boolean, verification: 'proof'|'none',
 *   blockHeight: number|null, index: number|null}>}
 * @throws {WalletError} NETWORK when no node answered, BALANCE_UNCONFIRMED when answers came but none is certified and
 *   recent (and no figure other than a 0 can be shown), with walkSteps while a long walk is why
 */
export async function readAccount(address, { display = false } = {}) {
  if (!core.isValidQnetAddress(address)) throw new WalletError('INVALID_ADDRESS');
  let early = null;
  let arrived;
  const figureRead = new Promise((resolve) => {
    arrived = resolve;
  });
  const onFigure = (figure) => {
    if (early !== null || figure.balanceNano === '0') return;
    early = figure;
    arrived();
  };
  const read = background(accountProof(address, { onFigure }));
  const got = display ? await Promise.race([read, figureRead.then(() => withinBudget(read, PROOF_DISPLAY_WAIT_MS))]) : await read;
  if (got === false) return accountView(early, false);
  if (got.verified) return accountView(got.verified, true);
  if (got.figure && got.figure.balanceNano !== '0') return accountView(got.figure, false);
  throw new WalletError(got.answered ? 'BALANCE_UNCONFIRMED' : 'NETWORK', got.answered ? walkNote() : {});
}

// ---------------------------------------------------------------- the live tip

// The height of a live figure's state; one with none (an absent account's 0) is below every height.
const heightOf = (figure) => figure.blockHeight ?? -1;

// proofAnswers' judge on the live route: a body at a node's live root (no proof_format), read by fold(body) to a figure or
// null. No node is marked old for that body, and nothing of it is kept as certified.
const liveJudge = (fold) => async (reply) => {
  const body = strictBody(reply.text);
  return body === null || body.proof_format !== undefined ? {} : { figure: fold(body) };
};

// The node's live-route answer for an account its state does not hold (no proof can show an absence there).
const isAbsentBody = (body, address) => body.address === address && body.error === 'account not found'
  && Array.isArray(body.merkle_proof) && body.merkle_proof.length === 0 && core.u64Text(body.balance) === '0'
  && core.u64Text(body.nonce) === '0';

/**
 * The account proof route without `mb` (proofAnswers' live pass): the first figure whose proof folds under its node's root
 * and whose nonce is at least `floor` (nonceFloorOf), else the highest any node gave. With no such figure, no nonce above 0
 * known taken (a new wallet) and at least two pinned nodes giving the body a node answers for no such account (which it
 * also gives for an error reading it), its 0 at once: {balanceNano: '0', nonce: '0', blockHeight: null}; the certified
 * absence proof is the committee's word on it.
 * @param {string} address
 * @param {bigint|null} [floor]
 * @returns {Promise<{figure: object|null, answered: boolean}>}
 */
async function liveAccountRead(address, floor = null) {
  let absent = 0;
  const got = await proofAnswers(`/api/v1/account/${address}/balance/proof`, [null], liveJudge((body) => {
    const figure = liveRootAccount(body, address);
    if (figure === null && isAbsentBody(body, address)) absent += 1;
    return figure;
  }), floor === null ? null : (figure) => BigInt(figure.nonce) >= floor);
  // a nonce the chain took means the account exists: that body then is an error, never its 0
  const unused = floor === null || floor === 0n;
  if (got.figure !== null || !unused || absent < MIN_NODE_AGREEMENT) return got;
  return { ...got, figure: { balanceNano: '0', nonce: '0', blockHeight: null } };
}

/**
 * The account of `address` at a pinned node's live tip (GET /api/v1/account/{a}/balance/proof without `mb`: that node's
 * live state and a proof of the account under its root), as the owner's rule wants it (18.10): balance, incoming funds
 * and the send checks act at once on a node's answer, the committee check runs in the background, and the network refuses
 * what is invalid. {balanceNano, nonce, blockHeight} once the proof folds to the root that node served; an account two
 * pinned nodes hold none of is 0 with blockHeight null (liveAccountRead); else null (no node answered, or none with such a
 * proof). Never verified.
 * @param {string} address EON
 * @returns {Promise<{balanceNano: string, nonce: string, blockHeight: number|null}|null>}
 * @throws {WalletError} INVALID_ADDRESS
 */
export async function liveAccountFigure(address) {
  if (!core.isValidQnetAddress(address)) throw new WalletError('INVALID_ADDRESS');
  return (await liveAccountRead(address)).figure;
}

// The live figure of this wallet's own account last shown or sent from (ownLiveRead): a later answer of a node behind it
// never takes its place.
let liveShown = null;

/**
 * The live figure this wallet's own balance and sends stand on: liveAccountRead with the nonce floor (nonceFloorOf), never
 * one of a lower height than the one shown last (a node behind answered after a node ahead).
 * @param {string} address the session's QNet address
 * @param {object} state the vault state
 * @returns {Promise<{figure: object|null, answered: boolean, floor: bigint|null}>}
 */
async function ownLiveRead(address, state) {
  const floor = nonceFloorOf(address, state);
  const got = await liveAccountRead(address, floor);
  let { figure } = got;
  if (figure !== null) {
    if (liveShown?.address === address && heightOf(liveShown.figure) > heightOf(figure)) figure = liveShown.figure;
    else liveShown = { address, figure };
  }
  return { figure, answered: got.answered, floor };
}

/**
 * What a view shows of a live read and a certified read started beside it (the owner's rule, 18.10): the live figure at
 * once; the certified one waited for only without a live figure, and shown over it only when verified at a state of the
 * live one's height or newer, so a certified figure of an older state never goes over the live one.
 * @param {Promise<object|null>} liveRead a figure with blockHeight (heightOf), or null
 * @param {Promise<object|null>} certifiedRead a figure or null; never rejects
 * @param {(figure: object) => number|null} verifiedHeight a certified figure's state height when it is verified, else null
 * @returns {Promise<{live: object|null, certified: object|null, certifiedShown: boolean}>}
 */
async function liveOverCertified(liveRead, certifiedRead, verifiedHeight) {
  const live = await liveRead;
  const certified = live === null ? await certifiedRead : ((await withinBudget(certifiedRead, 0)) || null);
  const height = certified === null ? null : verifiedHeight(certified);
  return { live, certified, certifiedShown: certified !== null && (live === null || (height !== null && height >= heightOf(live))) };
}

// ---------------------------------------------------------------- the chain's nonce

let headHint = null;

// The macroblock covering the height at least two pinned nodes have reached (the second highest of their
// answers), cached for a minute; null when fewer than two answer. Every pinned node is asked at once, and the read ends
// when all answered or HEDGE_MS after the second answer, so a silent node does not hold it for its whole timeout; reads
// that overlap share one. It tells only whether the pinned nodes serve another chain (followChain), never whether a
// proof is recent (certifiedHeadNow).
let headRead = null;
function networkHeadIndex() {
  if (headHint !== null && Date.now() - headHint.at < HEAD_CACHE_MS) return Promise.resolve(headHint.index);
  headRead ??= new Promise((resolve) => {
    const heights = [];
    let settled = 0;
    let timer = null;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const sorted = heights.filter((height) => height !== null && height > 0).sort((a, b) => b - a);
      if (sorted.length < MIN_NODE_AGREEMENT) {
        resolve(null);
        return;
      }
      headHint = { index: Math.floor(sorted[MIN_NODE_AGREEMENT - 1] / MACROBLOCK_INTERVAL), at: Date.now() };
      resolve(headHint.index);
    };
    for (const node of QNET.NODES) {
      nodeRequest('/api/v1/height', { nodes: [node], timeoutMs: HEAD_TIMEOUT_MS })
        .then((reply) => (reply.status === 200 ? safeIntOf(parseOrNull(reply.text)?.height) : null), () => null)
        .then((height) => {
          settled += 1;
          heights.push(height);
          if (settled === QNET.NODES.length) finish();
          else if (timer === null && heights.filter((h) => h !== null && h > 0).length >= MIN_NODE_AGREEMENT) timer = setTimeout(finish, HEDGE_MS);
        });
    }
  }).finally(() => {
    headRead = null;
  });
  return headRead;
}

async function accountFrom(node, address) {
  try {
    return accountAnswer(await nodeRequest(`/api/v1/account/${address}`, { nodes: [node] }), address);
  } catch {
    return null;
  }
}

/**
 * The (balance, nonce) two pinned nodes report alike (agreedAccount): two nodes of `order` are asked at once; one that
 * fails, and every HEDGE_MS of silence, brings in the next, and the first agreement decides, so a silent node no longer
 * holds the read for its whole timeout. Two answers that differ bring in every remaining node, and the agreement of all
 * the answers decides (the highest nonce two of them report). Only its nonce (chainNonceOf: which of this wallet's own
 * transactions the chain took) and key binding are used; its balance never counts.
 * @param {string} address
 * @param {string[]} order the pinned nodes in the order to ask them
 * @returns {Promise<{agreed: object|null, answers: Array<object|null>}>}
 */
function agreeingAccount(address, order) {
  return new Promise((resolve) => {
    const answers = [];
    let launched = 0;
    let running = 0;
    let settled = false;
    let disagreed = false;
    let hedge = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearInterval(hedge);
      resolve({ agreed: agreedAccount(answers), answers });
    };
    const launch = () => {
      if (settled || launched >= order.length) return;
      const node = order[launched];
      launched += 1;
      running += 1;
      accountFrom(node, address).then((answer) => {
        running -= 1;
        answers.push(answer);
        const given = answers.filter(Boolean);
        if (!disagreed && agreedAccount(answers)) {
          finish();
          return;
        }
        if (given.length >= 2 && !agreedAccount(given.slice(0, 2)) && !disagreed) {
          disagreed = true;
          while (launched < order.length) launch();
        } else if (answer === null) {
          launch();
        }
        if (launched >= order.length && running === 0) finish();
      });
    };
    launch();
    launch();
    hedge = setInterval(() => {
      if (launched < order.length && !disagreed) launch();
      else clearInterval(hedge);
    }, HEDGE_MS);
  });
}

// The (balance, nonce) at least two pinned nodes report; the highest nonce wins among several.
function agreedAccount(answers) {
  const groups = new Map();
  for (const a of answers) {
    if (!a) continue;
    const key = `${a.balanceNano}:${a.nonce}`;
    const group = groups.get(key) ?? { ...a, count: 0 };
    group.count += 1;
    group.pkBound = group.pkBound && a.pkBound;
    groups.set(key, group);
  }
  let best = null;
  for (const group of groups.values()) {
    if (group.count < 2) continue;
    const better = best === null || BigInt(group.nonce) > BigInt(best.nonce)
      || (group.nonce === best.nonce && (group.count > best.count
        || (group.count === best.count && BigInt(group.balanceNano) > BigInt(best.balanceNano))));
    if (better) best = group;
  }
  return best;
}

// The highest account nonce at least two pinned nodes report (agreeingAccount's answers, by the nonce alone, as the app's
// agreed nonce), and whether two report the key bound: {nonce, pkBound}, or null without one. No balance is taken.
async function agreedAccountOf(address) {
  let answers;
  try {
    ({ answers } = await agreeingAccount(address, shuffled(QNET.NODES)));
  } catch {
    return null;
  }
  const given = answers.filter(Boolean);
  const counts = new Map();
  for (const a of given) counts.set(a.nonce, (counts.get(a.nonce) ?? 0) + 1);
  const agreed = [...counts].filter(([, count]) => count >= MIN_NODE_AGREEMENT).map(([nonce]) => BigInt(nonce));
  if (agreed.length === 0) return null;
  const nonce = agreed.reduce((top, n) => (n > top ? n : top));
  return { nonce: nonce.toString(), pkBound: given.filter((a) => a.pkBound).length >= MIN_NODE_AGREEMENT };
}

/**
 * The account nonce the chain reached for `address` as far as this wallet knows: the highest nonce two pinned nodes report
 * alike (agreedAccountOf), never below the highest certified nonce this worker saw; null with neither. Every transaction
 * of this wallet at or below it was decided by the chain (resubmitPending, transactionStatus).
 * @param {string} address
 * @param {{nonce: string}|null} agreed
 * @returns {bigint|null}
 */
function chainNonceOf(address, agreed) {
  const seen = seenNonceOf(address);
  if (agreed === null) return seen;
  const nonce = BigInt(agreed.nonce);
  return seen !== null && seen > nonce ? seen : nonce;
}

// The account nonce the chain reached for this wallet's own `address` now (chainNonceOf over agreedAccountOf), kept as
// the highest seen (noteChainNonce), so the send rule's floor holds it too; null when nothing is known.
async function chainNonceNow(address) {
  const nonce = chainNonceOf(address, await agreedAccountOf(address));
  if (nonce !== null) noteChainNonce(address, nonce);
  return nonce;
}

// ---------------------------------------------------------------- this wallet's own transactions by nonce

// The most a kept transaction can take (vault.PendingTransfer): QNC its amount (a call: the storage deposit) and most fee;
// a token transfer moves its token amount; any other contract call may move tokens by an amount not known here.
function spendOfRecord(p) {
  const qncNano = BigInt(p.amountNano) + BigInt(p.feeNano);
  if (kindOf(p) !== 'call') return { qncNano, tokens: new Map(), tokenUnknown: false };
  if (p.call.recipient === null) return { qncNano, tokens: new Map(), tokenUnknown: true };
  return { qncNano, tokens: new Map([[p.to, BigInt(p.call.amount)]]), tokenUnknown: false };
}

// A vault spend record (vault.spends) as a spend.
const spendOfRow = (r) => ({
  qncNano: BigInt(r.qncNano),
  tokens: r.token === null ? new Map() : new Map([[r.token, BigInt(r.tokenAmount)]]),
  tokenUnknown: r.tokenUnknown,
});

// Two transactions signed at one nonce count as the larger: either may be the one that applies.
function mergeSpend(a, b) {
  const tokens = new Map(a.tokens);
  for (const [token, amount] of b.tokens) tokens.set(token, amount > (tokens.get(token) ?? 0n) ? amount : tokens.get(token));
  return { qncNano: a.qncNano > b.qncNano ? a.qncNano : b.qncNano, tokens, tokenUnknown: a.tokenUnknown || b.tokenUnknown };
}

/**
 * Every transaction of this wallet it knows by nonce, with the most it can take: the vault's spend records and the
 * transactions it keeps, merged at each nonce (mergeSpend).
 * @param {object} state the vault state
 * @returns {Map<string, {qncNano: bigint, tokens: Map<string, bigint>, tokenUnknown: boolean}>} nonce (u64 decimal) -> spend
 */
function ownSpends(state) {
  const out = new Map();
  const add = (nonce, spend) => out.set(nonce, out.has(nonce) ? mergeSpend(out.get(nonce), spend) : spend);
  for (const r of state.spends ?? []) add(r.nonce, spendOfRow(r));
  for (const p of state.pendingTransfers) add(p.nonce, spendOfRecord(p));
  return out;
}

// What this wallet's own transactions from `above` + 1 to `through` took, the most each could (QNC, or the tokens of
// `token`).
function settledSpend(known, above, through, token = null) {
  let sum = 0n;
  for (const [nonce, spend] of known) {
    const n = BigInt(nonce);
    if (n <= above || n > through) continue;
    sum += token === null ? spend.qncNano : (spend.tokens.get(token) ?? 0n);
  }
  return sum;
}

// Whether a transaction of this wallet above `nonce` may have moved tokens by an amount not known here (a contract call):
// no token balance is decided until a state at or past it is read.
const tokenEffectUnknown = (known, nonce) => [...known].some(([n, spend]) => BigInt(n) > nonce && spend.tokenUnknown);

// The vault spend record (vault.spends) of a kept transaction: its nonce and the most it can take (spendOfRecord).
function spendRow(p) {
  const call = kindOf(p) === 'call';
  const token = call && p.call.recipient !== null;
  return {
    nonce: p.nonce,
    qncNano: (BigInt(p.amountNano) + BigInt(p.feeNano)).toString(),
    token: token ? p.to : null,
    tokenAmount: token ? p.call.amount : null,
    tokenUnknown: call && !token,
    settledAt: null,
  };
}

const byNonce = (a, b) => {
  const x = BigInt(a.nonce);
  const y = BigInt(b.nonce);
  return x < y ? -1 : (x > y ? 1 : 0);
};

/**
 * The state with its spend records kept current: `add` (a new transaction's record) taken in, every record at or below
 * `settledThrough` (an account nonce the chain reached by the pinned nodes' agreement) marked settled now, a settled one
 * dropped SPENT_KEEP_MS later, an unsettled one whose transaction the vault no longer keeps dropped (its nonce was not
 * used, so it took nothing), at most LIMITS.SPENDS_MAX, the lowest nonces going first.
 * @param {object} state the vault state
 * @param {{add?: object|null, settledThrough?: bigint|null, now?: number}} change
 * @returns {object} a new state
 */
function withSpends(state, { add = null, settledThrough = null, now = Date.now() }) {
  const held = new Set(state.pendingTransfers.map((p) => p.nonce));
  const settled = (r) => (r.settledAt === null && settledThrough !== null && BigInt(r.nonce) <= settledThrough
    ? { ...r, settledAt: now } : r);
  const spends = [...(state.spends ?? []), ...(add === null ? [] : [add])].map(settled)
    .filter((r) => (r.settledAt === null ? held.has(r.nonce) : now - r.settledAt <= SPENT_KEEP_MS))
    .sort(byNonce)
    .slice(-LIMITS.SPENDS_MAX);
  return { ...state, spends };
}

// The outcomes of a kept transaction whose nonce the chain used: it applied there, another one did, or no two pinned
// nodes agree yet on which (resubmitPending).
const NONCE_USED_OUTCOMES = new Set(['confirmed', 'replaced', 'passed']);

/**
 * The highest nonce of this wallet's own account it knows the chain took, the floor of the send rule: the highest
 * certified or agreed nonce this worker read (noteChainNonce), the kept transactions resubmitPending found the chain past
 * and the spend records settled since (both in the vault), so a pinned node a block or more behind never makes a send take
 * a nonce the chain used; null when nothing is known.
 * @param {string} address
 * @param {object} state the vault state
 * @returns {bigint|null}
 */
function nonceFloorOf(address, state) {
  let floor = seenNonceOf(address);
  const raise = (nonce) => {
    const n = BigInt(nonce);
    if (floor === null || n > floor) floor = n;
  };
  for (const p of state.pendingTransfers) if (NONCE_USED_OUTCOMES.has(p.outcome)) raise(p.nonce);
  for (const r of state.spends ?? []) if (r.settledAt !== null) raise(r.nonce);
  return floor;
}

// ---------------------------------------------------------------- the send rule at the live tip

/**
 * This wallet's own transactions against a live figure (ownLiveRead: the balance and nonce at a pinned node's tip, which
 * every send check stands on) and the nonce floor (nonceFloorOf): `confirmed`, the higher of the figure's nonce and the
 * floor, is the nonce the chain reached; what this wallet's own transactions above the figure's nonce up to `confirmed`
 * took (a node a block or more behind) comes off its balance, the most each could (the mobile spendableFrom); those above
 * `confirmed` that may still apply (stale and refused ones too) are outstanding and keep back, at each nonce, the largest
 * amount plus fee of the transactions there (reservedNano). spendable(except): what is left, the nonce `except` left out
 * (a new transaction takes its place).
 * @param {object} state the vault state
 * @param {{balanceNano: string, nonce: string}} live
 * @param {bigint|null} floor
 * @returns {{liveNonce: bigint, confirmed: bigint, known: Map, outstanding: object[], spendable: (except: string|null) => bigint}}
 */
function liveSend(state, live, floor) {
  const liveNonce = BigInt(live.nonce);
  const confirmed = floor !== null && floor > liveNonce ? floor : liveNonce;
  const known = ownSpends(state);
  const settled = settledSpend(known, liveNonce, confirmed);
  const outstanding = state.pendingTransfers.filter((p) => mayStillApply(p) && BigInt(p.nonce) > confirmed);
  const spendable = (except) => {
    const left = BigInt(live.balanceNano) - settled - reservedNano(outstanding, except);
    return left > 0n ? left : 0n;
  };
  return { liveNonce, confirmed, known, outstanding, spendable };
}

// The popup's certified read of an address (joinedRead). {account} or {error}.
const certifiedBalanceReads = new Map();
const certifiedBalance = (address) => joinedRead(certifiedBalanceReads, address,
  () => readAccount(address, { display: true }).then((account) => ({ account }), (error) => ({ error })));

/**
 * Handler of `qnet.balance` for the session's QNet address. The live figure (ownLiveRead) is shown at once, with what is
 * left to spend by the send rule (liveSend: its balance less what this wallet's own transactions took since and may still
 * take; a dropped one the next send takes the place of is not reserved). The certified read (readAccount with `display`)
 * runs beside it (liveOverCertified).
 * @returns {Promise<QnetBalance>}
 * @throws {WalletError} LOCKED, NETWORK, BALANCE_UNCONFIRMED (neither read gave a figure)
 */
export async function getBalance() {
  const { qnetAddress } = await session.requireUnlocked();
  // the chain this wallet follows, checked beside the read (followChain): what it kept of another chain goes
  background(followChain().catch((error) => log.warn('chain check failed', error?.code ?? error?.name)));
  const state = await vault.readState();
  noteOwnSends(qnetAddress, state);
  const certifiedRead = certifiedBalance(qnetAddress);
  const own = ownLiveRead(qnetAddress, state);
  const { live, certified: account, certifiedShown } = await liveOverCertified(own.then((read) => read.figure),
    certifiedRead.then((read) => read.account ?? null),
    (a) => (a.verified && Number.isSafeInteger(a.blockHeight) ? a.blockHeight : null));
  if (live === null && account === null) throw (await certifiedRead).error;
  let spendableNano = null;
  if (live !== null) {
    const now = Date.now();
    const { confirmed, outstanding, spendable } = liveSend(state, live, (await own).floor);
    const target = defaultReplaceNonce(outstanding, confirmed, now);
    const freed = target !== null && outstanding.some((p) => p.nonce === target && isDropped(p, confirmed, now)) ? target : null;
    spendableNano = spendable(freed).toString();
  }
  if (!certifiedShown) {
    return {
      balanceNano: live.balanceNano, spendableNano, nonce: live.nonce, verified: false, verification: 'live', blockHeight: live.blockHeight,
    };
  }
  return {
    balanceNano: account.balanceNano,
    spendableNano,
    nonce: account.nonce,
    verified: account.verified,
    verification: account.verification,
    blockHeight: account.blockHeight,
    ...(Number.isSafeInteger(account.walkSteps) ? { walkSteps: account.walkSteps } : {}),
  };
}

const isStale = (p, now) => now - p.createdAt > PENDING_TRANSFER_TTL_MS;
// Until when a kept transaction may still be in some node's mempool (the mobile app's mayLandUntil): the node's lifetime
// after it last went out, plus the margin.
const mayLandUntil = (p) => Math.max(p.createdAt, p.lastSubmitAt) + NODE_MEMPOOL_TTL_MS + LANDING_MARGIN_MS;

/**
 * Whether a kept transaction is dropped: one the wallet no longer sends (stale, or refused by the only node sent it), its
 * nonce still free on the chain (`confirmed`), and no node can hold it any more (mayLandUntil passed). It did not go
 * through and never will by itself: History shows it as not found, and the next send takes its nonce by default.
 * @param {object} p a vault PendingTransfer
 * @param {bigint} confirmed the account nonce the chain reached (liveSend's, or chainNonceNow's)
 * @param {number} now
 * @returns {boolean}
 */
function isDropped(p, confirmed, now) {
  return (p.outcome === 'refused' || (p.outcome === 'pending' && isStale(p, now)))
    && BigInt(p.nonce) > confirmed && now >= mayLandUntil(p);
}

// The highest nonce of the wallet's own account this worker read certified (readAccount) or two pinned nodes reported
// alike (chainNonceNow), with that account: History tells a dropped transaction by it, and neither chainNonceOf nor the
// send rule's floor (nonceFloorOf) goes below it. null until one was read.
let chainNonceSeen = null;
const noteChainNonce = (address, nonce) => {
  const n = BigInt(nonce);
  if (chainNonceSeen?.address !== address || n > chainNonceSeen.nonce) chainNonceSeen = { address, nonce: n };
};
const seenNonceOf = (address) => (chainNonceSeen?.address === address ? chainNonceSeen.nonce : null);

/**
 * The nonce a new transaction takes by default instead of the next one (R5-EXTQ-02, as mobile planNonce): that of the
 * oldest transaction a node refused or that is dropped (isDropped), which no transaction still being sent took since; so
 * the one it takes the place of, should it apply after all, and the new one are never both paid, and a dropped one does
 * not hold every later send behind its nonce. null when there is none.
 * @param {object[]} outstanding the kept transactions that may still apply above the live nonce
 * @param {bigint} confirmed
 * @param {number} now
 * @returns {string|null}
 */
function defaultReplaceNonce(outstanding, confirmed, now) {
  const dropped = (p) => isDropped(p, confirmed, now);
  const taken = new Set(outstanding.filter((p) => p.outcome === 'pending' && !dropped(p)).map((p) => p.nonce));
  const candidates = outstanding.filter((p) => (p.outcome === 'refused' || dropped(p)) && !taken.has(p.nonce))
    .sort((a, b) => (BigInt(a.nonce) < BigInt(b.nonce) ? -1 : 1));
  return candidates.length > 0 ? candidates[0].nonce : null;
}

// ---------------------------------------------------------------- the chain this wallet follows

// The highest network head (macroblock index) this wallet saw, as the vault's chain cache keeps it; read once per worker.
let headSeen = null;
let chainChecked = 0;

/**
 * Forgets what the wallet kept of a chain the pinned nodes no longer serve (followChain): the verified anchors and the
 * genesis capsule, its pending transactions and their spend records (signed on the old chain; none of them can be decided
 * on this one), the nonces and the live figure it saw, the cached balances, token list and history, the recipient kinds
 * and token row verdicts, and the head it saw, which becomes `head`.
 * @param {number} head
 * @returns {Promise<void>}
 */
async function forgetChain(head) {
  log.warn('the network head went back: another chain, what was kept of the old one is dropped');
  await dropAnchors();
  core.clearCapsule();
  capsuleQuietUntil = 0;
  keepLightHints(true);
  await forgetKeptCapsule();
  await vault.updateState((state) => ({ ...state, pendingTransfers: [], spends: [] }))
    .catch((error) => log.warn('pending transactions of the old chain not dropped', error?.code ?? error?.name));
  chainNonceSeen = null;
  liveShown = null;
  recipientKinds.clear();
  recipientReads.clear();
  recipientPages.clear();
  rowVerdicts.clear();
  tokenList = null;
  contractCache.clear();
  await session.forgetViews(['qnetBalance', 'qnetTokens', 'qnetHistory']);
  headSeen = head;
  await vault.updateChainCache((cache) => ({ ...cache, chain: core.chainIdentity(), headIndex: head }))
    .catch((error) => log.warn('chain head not kept', error?.code ?? error?.name));
}

/**
 * The chain check of the popup's balance read, at most once a minute (owner, 06.10: cached chain data of a chain the
 * wallet no longer follows never hangs the wallet). The head two pinned nodes report (networkHeadIndex) is compared with
 * the highest head this wallet saw (kept in the vault's chain cache with the build's chain identity, core.chainIdentity):
 * CHAIN_REWIND_MACROBLOCKS or more below it, or a cache of another chain identity, means the pinned nodes serve another
 * chain (a restarted test network; the live network never goes back), and forgetChain drops what was kept of the old one.
 * A kept anchor that far above the head is another chain's too: the anchors go. Before either drop, every pinned node is
 * asked again and the highest head any of them reports decides (highestNetworkHead), so two lagging nodes that answered
 * first never pass for another chain. The kept head moves up in steps of CHAIN_REWIND_MACROBLOCKS (no write every minute).
 * @returns {Promise<'same'|'changed'|'unknown'>}
 */
export async function followChain() {
  if (Date.now() - chainChecked < HEAD_CACHE_MS) return 'unknown';
  chainChecked = Date.now();
  let head = await networkHeadIndex();
  if (head === null) return 'unknown';
  let renamed = false;
  if (headSeen === null) {
    const cache = await vault.readChainCache().catch(() => ({}));
    headSeen = Number.isSafeInteger(cache?.headIndex) && cache.headIndex >= 0 ? cache.headIndex : 0;
    // what was kept under another build's chain (its network identity and pinned genesis identities, core.chainIdentity)
    // is another chain's; the identity of a build before it carried the network identity, over the same genesis
    // identities, is this chain's kept by an earlier build: its head stands, and the identity is written again
    renamed = cache?.chain === legacyChainIdentity();
    if (typeof cache?.chain === 'string' && cache.chain !== core.chainIdentity() && !renamed) headSeen = Number.MAX_SAFE_INTEGER;
  }
  await loadAnchors();
  const above = (index, at) => index > pinIndex() && index >= at + CHAIN_REWIND_MACROBLOCKS;
  const anchorsAbove = (at) => above(ownTopIndex(), at);
  const capsuleAbove = (at) => above(core.heldCapsuleIndex(), at);
  if (headSeen >= head + CHAIN_REWIND_MACROBLOCKS || anchorsAbove(head) || capsuleAbove(head)) {
    head = await highestNetworkHead();
    if (head === null) return 'unknown';
  }
  if (headSeen >= head + CHAIN_REWIND_MACROBLOCKS) {
    await forgetChain(head);
    return 'changed';
  }
  if (headSeen === 0 || head >= headSeen + CHAIN_REWIND_MACROBLOCKS || renamed) {
    headSeen = Math.max(headSeen, head);
    const kept = headSeen;
    await vault.updateChainCache((cache) => ({ ...cache, chain: core.chainIdentity(), headIndex: kept }))
      .catch((error) => log.warn('chain head not kept', error?.code ?? error?.name));
  }
  if (anchorsAbove(head)) {
    log.warn('kept anchors above the network head: dropped');
    await dropAnchors();
  }
  if (capsuleAbove(head)) {
    log.warn('capsule above the network head: dropped');
    core.clearCapsule();
    await forgetKeptCapsule();
  }
  return 'same';
}

// The highest macroblock this wallet verified itself (in this session or kept from an earlier one), or 0: the capsule's K
// and the pin left out.
const ownTopIndex = () => Math.max(0, ...Object.keys(core.exportVerifiedAnchors()).map(Number));

// The chain identity a build before NETWORK_ID kept its data under (the pinned genesis identities alone, the light
// client's former chainIdentity): a cache of it is this build's chain kept by an earlier build of the same genesis.
let legacyIdentity = null;
function legacyChainIdentity() {
  if (legacyIdentity === null) {
    const { GENESIS_NODE_IDS, GENESIS_CONSENSUS_PKS } = core.genesisConsensus;
    const parts = [...GENESIS_NODE_IDS].sort().map((id) => `${id}:${GENESIS_CONSENSUS_PKS[id]}`);
    legacyIdentity = core.sha3_256Hex(new TextEncoder().encode(parts.join('|'))).slice(0, 32);
  }
  return legacyIdentity;
}

// The highest macroblock any pinned node reports (each asked once, within HEAD_TIMEOUT_MS, all awaited), or null when
// fewer than two answer: followChain's check before it drops anything.
async function highestNetworkHead() {
  const heights = await Promise.all(QNET.NODES.map((node) => nodeRequest('/api/v1/height', { nodes: [node], timeoutMs: HEAD_TIMEOUT_MS })
    .then((reply) => (reply.status === 200 ? safeIntOf(parseOrNull(reply.text)?.height) : null), () => null)));
  const given = heights.filter((height) => height !== null && height > 0);
  return given.length < MIN_NODE_AGREEMENT ? null : Math.floor(Math.max(...given) / MACROBLOCK_INTERVAL);
}
// A transfer of this wallet whose nonce the chain has not decided: sent and not seen applied ('pending'), replaced
// by a transfer still being submitted ('superseded', R4-EXTQ-01), or refused by the only node it was sent to
// ('refused', R5-EXTQ-02: one node's refusal is not the chain's, and a node that refuses may still pass the body on).
// All may still apply, so all stay listed and reserved.
const mayStillApply = (p) => p.outcome === 'pending' || p.outcome === 'superseded' || p.outcome === 'refused';
// A transfer a new one may replace (sign at its nonce): one still sent, or one a node refused.
const replaceable = (p) => p.outcome === 'pending' || p.outcome === 'refused';
// A pending record is a QNC transfer or a contract call (vault PendingTransfer.kind); both share one nonce sequence.
const kindOf = (p) => (p.kind === 'call' ? 'call' : 'transfer');
const routeOf = (p) => (kindOf(p) === 'call' ? core.TX_ROUTES.call.path : core.TX_ROUTES.transfer.path);

// What the transfers that may still apply keep back from the balance: at each nonce the largest amount plus fee of
// the transfers there, since at most one transaction per nonce can apply (a replacement and the transfer it
// replaces, or a refused transfer and the one that took its place, never both); `except`: a nonce left out.
function reservedNano(transfers, except = null) {
  const perNonce = new Map();
  for (const p of transfers) {
    if (p.nonce === except) continue;
    const cost = BigInt(p.amountNano) + BigInt(p.feeNano);
    if (cost > (perNonce.get(p.nonce) ?? 0n)) perNonce.set(p.nonce, cost);
  }
  let sum = 0n;
  for (const cost of perNonce.values()) sum += cost;
  return sum;
}

/**
 * The base a send is decided by (the owner's rule, 18.10: the send checks act at once on a pinned node's answer, and the
 * network refuses what that answer does not cover): the figure of one live read (liveAccountRead, ownLiveRead), never a
 * committee check. A token balance is read at the tip too (tokenSide): a transferFrom lowers a holder's balance without
 * the holder's nonce.
 * @param {{figure: object|null, answered: boolean}} got
 * @returns {{balanceNano: string, nonce: string, blockHeight: number|null}}
 * @throws {WalletError} NETWORK when no node answered, BALANCE_UNCONFIRMED when none gave a proof of the account
 */
function liveBase(got) {
  if (got.figure === null) throw new WalletError(got.answered ? 'BALANCE_UNCONFIRMED' : 'NETWORK');
  return got.figure;
}

// The chain view a transaction is built on: the live base of this wallet's own account (ownLiveRead) and this wallet's own
// transactions against it (liveSend): those up to the nonce the chain reached counted in, those above it reserved (stale
// ones too: they may still apply); the nonce after all of them; and what is left to spend. replaceNonce: the new transfer
// takes that outstanding transfer's nonce, so at most one of the two can ever apply, and its amount is no longer reserved
// (R2-EXTQ-03). Without one, a transfer a node refused, or one dropped, is replaced by default (R5-EXTQ-02, as mobile
// planNonce): the new one takes the nonce of the oldest such one no sent transfer took since, so that one, should it apply
// after all, and the new one are never both paid.
async function transferSnapshot(address, replaceNonce = null) {
  const state = await vault.readState();
  noteOwnSends(address, state);
  const own = await ownLiveRead(address, state);
  const live = liveBase(own);
  const { liveNonce, confirmed, known, outstanding, spendable } = liveSend(state, live, own.floor);
  // only a transfer that is still sent, or one a node refused, can be replaced
  if (replaceNonce !== null && !outstanding.some((p) => replaceable(p) && p.nonce === replaceNonce)) {
    throw new WalletError('NONCE_CHANGED');
  }
  // a refused or dropped one is replaced by default (defaultReplaceNonce)
  if (replaceNonce === null) replaceNonce = defaultReplaceNonce(outstanding, confirmed, Date.now());
  let nextNonce = confirmed + 1n;
  for (const p of outstanding) {
    if (BigInt(p.nonce) >= nextNonce) nextNonce = BigInt(p.nonce) + 1n;
  }
  if (nextNonce > U64_MAX) throw new WalletError('NONCE_UNAVAILABLE');
  return {
    account: { balanceNano: live.balanceNano, nonce: live.nonce, blockHeight: live.blockHeight, verified: false, verification: 'live' },
    liveNonce,
    confirmed,
    known,
    outstanding,
    replaceNonce,
    nextNonce: replaceNonce ?? nextNonce.toString(),
    spendable: spendable(replaceNonce),
  };
}

/**
 * The next nonce for `address`, never a default on failure (EXT-04), plus whether the account's public key is already
 * bound on chain (two pinned nodes' word). For the session's own address it is the send rule's (transferSnapshot): the
 * nonce after the live one and after the wallet's own unconfirmed sends; for another address, its live nonce + 1.
 * @param {string} address
 * @returns {Promise<{nextNonce: string, pkBound: boolean}>}
 * @throws {WalletError} INVALID_ADDRESS, NETWORK, BALANCE_UNCONFIRMED, NONCE_UNAVAILABLE
 */
export async function resolveNonce(address) {
  const { qnetAddress } = await session.requireUnlocked();
  if (!core.isValidQnetAddress(address)) throw new WalletError('INVALID_ADDRESS');
  const agreedRead = agreedAccountOf(address);
  let nextNonce;
  if (address === qnetAddress) {
    ({ nextNonce } = await transferSnapshot(address));
  } else {
    const next = BigInt(liveBase(await liveAccountRead(address)).nonce) + 1n;
    if (next > U64_MAX) throw new WalletError('NONCE_UNAVAILABLE');
    nextNonce = next.toString();
  }
  return { nextNonce, pkBound: (await agreedRead)?.pkBound === true };
}

// ---------------------------------------------------------------- history

const lower = (s) => String(s).toLowerCase();

function directionOf(from, to, me) {
  const out = lower(from) === me;
  const inbound = lower(to) === me;
  if (out && inbound) return 'self';
  return out ? 'out' : 'in';
}

// A token row's token as the archive names it (its deploy record, read by the site, never by a node): shown with the
// amount, never trusted for anything else; reserved: its symbol is QNet's own, or carries a hidden or format character.
function rowToken(row) {
  if (!core.isValidQnetAddress(row.contract) || row.std !== 'qrc20') return null;
  const decimals = safeIntOf(row.decimals);
  if (decimals === null || decimals > TOKEN_DECIMALS_MAX) return null;
  return { contract: row.contract, symbol: tokenText(row.symbol), decimals, reserved: reservedName(row.symbol, '') };
}

// The archive's transaction type (the node's type name; a node's own history writes it in snake case) as a row's kind:
// a contract call or deploy, the node's registration or activation, the node balance moved into the wallet (a reward
// distribution, which only the rewards pool's claim pays to a wallet), a swap; every other type is a transfer.
const ROW_KINDS = Object.freeze({
  contractcall: 'call', contractdeploy: 'deploy', noderegistration: 'node_registration', nodeactivation: 'node_activation',
  rewarddistribution: 'reward', swap: 'swap',
});
const rowKind = (txType) => ROW_KINDS[String(txType ?? '').replace(/_/g, '').toLowerCase()] ?? 'transfer';
// Kinds a node's history lists with another `to` than the archive's, or none (a token row is the archive's reading of a
// contract call; a deploy's `to` there is the contract it creates; a registration names no recipient): their rows match
// by hash only. A deploy and a registration may come from the archive with no `to` at all.
const HASH_ONLY_KINDS = new Set(['token', 'deploy', 'node_registration']);
const NO_RECIPIENT_KINDS = new Set(['deploy', 'node_registration']);

// One explorer row as a HistoryItem, or null (rows this wallet is no party to, a token row of another standard, bad
// fields). The archive is the site's host, not a node: a row is 'unverified' until two pinned nodes list it (R4-EXTQ-04).
// A built-in token's transfer (source 'token') moves no QNC: its amount is in the token's units (amountBase, u128) and
// `token` names the token as the archive does. A node registration (this wallet registering its node) has no `to`:
// its row keeps `to: ''`, so History shows one "Node registered" row for it and never a transfer of 0 QNC.
function historyItem(row, address) {
  if (!isObject(row) || (row.source !== 'tx' && row.source !== 'batch' && row.source !== 'token')) return null;
  const me = lower(address);
  const kind = row.source === 'token' ? 'token' : rowKind(row.tx_type);
  const { hash, from } = row;
  const noRecipient = NO_RECIPIENT_KINDS.has(kind) && (row.to === null || row.to === undefined || row.to === '');
  const to = noRecipient ? '' : row.to;
  if (typeof hash !== 'string' || !TX_HASH_RE.test(hash)) return null;
  if (typeof from !== 'string' || typeof to !== 'string' || !PRINTABLE_RE.test(from) || (!noRecipient && !PRINTABLE_RE.test(to))) return null;
  if (lower(from) !== me && lower(to) !== me) return null;
  const token = row.source === 'token' ? rowToken(row) : null;
  const amountBase = token === null ? null : u128Of(row.amount);
  if (row.source === 'token' && (token === null || amountBase === null)) return null;
  const amountNano = token === null ? u64Of(row.amount) : '0';
  if (amountNano === null) return null;
  const direction = directionOf(from, to, me);
  return {
    hash,
    direction,
    from,
    to,
    amountNano,
    feeNano: direction === 'in' || token !== null ? '0' : (u64Of(row.fee) ?? '0'),
    timestamp: safeIntOf(row.timestamp) ?? 0,
    status: 'unverified',
    nonce: null,
    kind,
    block: safeIntOf(row.block),
    ...(token === null ? {} : { token, amountBase }),
  };
}

// A row's identity across the archive and the nodes: its hash, both parties and its amount; for the kinds a node lists
// with another `to` (HASH_ONLY_KINDS), its hash alone, which a node gives for its contract calls, deploys and registrations.
const rowIdentity = (hash, from, to, amountNano) => JSON.stringify([hash, lower(from), lower(to), amountNano]);
const hashIdentity = (hash) => JSON.stringify(['hash', hash]);
const HASH_LISTED_TYPES = /^(?:contract_?call|contract_?deploy|node_?registration)$/i;
const identityOf = (item) => (HASH_ONLY_KINDS.has(item.kind) ? hashIdentity(item.hash)
  : rowIdentity(item.hash, item.from, item.to, item.amountNano));

// The rows of this wallet's newest history one pinned node lists (sent and received, HISTORY_CHECK_PAGE of them),
// as rowIdentity keys and the hashes of its contract calls, deploys and registrations (hashIdentity; a registration has
// no `to`); null when that node's history could not be read.
async function nodeHistoryRows(node, address) {
  let body = null;
  try {
    const reply = await nodeRequest(
      `/api/v1/transactions/history?address=${encodeURIComponent(address)}&per_page=${HISTORY_CHECK_PAGE}`, { nodes: [node] });
    body = reply.status === 200 ? parseOrNull(reply.text) : null;
  } catch {
    body = null;
  }
  if (!isObject(body) || !Array.isArray(body.transactions)) return null;
  const rows = new Set();
  for (const row of body.transactions) {
    if (!isObject(row) || typeof row.hash !== 'string' || typeof row.from !== 'string') continue;
    if (HASH_LISTED_TYPES.test(String(row.type ?? row.tx_type ?? ''))) rows.add(hashIdentity(row.hash));
    if (typeof row.to !== 'string') continue;
    const amountNano = u64Of(row.amount);
    if (amountNano !== null) rows.add(rowIdentity(row.hash, row.from, row.to, amountNano));
  }
  return rows;
}

// The archive rows at least two pinned nodes list alike (R4-EXTQ-04, the rule of every other state read): the ones
// History shows as in a block, with the token rows a logs proof verifies. Rows older than a node's window stay
// unverified. Being listed proves inclusion, never that the transfer applied: a node lists every transfer a block
// carries, one skipped at apply (a balance too low, a nonce already used) too, and its history says nothing of the
// outcome (R5-EXTQ-01).
// Every pinned node is asked at once, and the read ends when all answered or HEDGE_MS after the second answer, so a silent
// node does not hold History for its whole timeout (a later read counts it again).
async function nodeConfirmedRows(address) {
  const answers = await new Promise((resolve) => {
    const given = [];
    let settled = 0;
    let timer = null;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve([...given]);
    };
    for (const node of QNET.NODES) {
      nodeHistoryRows(node, address).catch(() => null).then((rows) => {
        settled += 1;
        if (rows !== null && !done) given.push(rows);
        if (settled === QNET.NODES.length) finish();
        else if (timer === null && given.length >= MIN_NODE_AGREEMENT) timer = setTimeout(finish, HEDGE_MS);
      });
    }
  });
  const counts = new Map();
  for (const rows of answers) for (const key of rows) counts.set(key, (counts.get(key) ?? 0) + 1);
  return new Set([...counts].filter(([, count]) => count >= MIN_NODE_AGREEMENT).map(([key]) => key));
}

// The logs proof of an archive token row (GET /api/v1/logs/proof), checked in the background: the leaf the node proves
// must be the one this row's own fields make (core.transferLogLeaf: transaction, log index, contract and the event), it
// folds to the block's sub-root and that to the window's logs_root, and that root is the one the committee certified for
// the macroblock closing the window (core.verifyMacroblockLogsRoot, the app's verifyTokenTransferInclusion). The event is
// written only when the transfer applied. A verified row reads included; a rejected one stays unverified whatever the
// nodes list (historyOf). Verdicts are kept by row: 'verified' and 'rejected' (the node's proof is another row's or folds
// to another root) for good, 'pending' (no proof now, a window not certified yet, or a walk to its macroblock longer than
// ROW_PROOF_WALK_STEPS) is tried again after ROW_PROOF_RETRY_MS. One history read starts at most ROW_PROOF_CHECKS checks
// and waits for none: a later read finds their verdicts.
const ROW_PROOF_MAX_BYTES = 64 * 1024;
const ROW_PROOF_CHECKS = 8;
const ROW_PROOF_WALK_STEPS = 4;
const ROW_PROOF_RETRY_MS = 60 * 1000;
const ROW_VERDICTS_MAX = 256;
const rowVerdicts = new Map(); // `${hash}:${log index}` -> {verdict, at, running}

// The decoded transfer of an archive token row, as the node's event encodes it, or null.
function tokenTransferOf(row) {
  const logIndex = safeIntOf(row.idx);
  if (logIndex === null || logIndex > 0xffffffff || typeof row.kind !== 'string' || typeof row.std !== 'string') return null;
  return {
    tx_hash: row.hash, log_index: logIndex, contract: row.contract, from: row.from, to: row.to, amount: String(row.amount),
    kind: row.kind, std: row.std, token_id: row.token_id ?? null,
  };
}

// One row's verdict from its logs proof: 'verified', 'rejected' or 'pending'.
async function tokenRowVerdict(transfer, block) {
  const leaf = core.transferLogLeaf(transfer);
  if (typeof leaf !== 'string') return 'rejected';
  // a row whose macroblock this wallet cannot reach in a few steps is not fetched for
  const covering = Number.isSafeInteger(block) && block > 0 ? Math.ceil(block / MACROBLOCK_INTERVAL) : null;
  if (covering !== null && core.stepsToVerify(covering) > ROW_PROOF_WALK_STEPS) return 'pending';
  let reply;
  try {
    reply = await nodeRequest(`/api/v1/logs/proof?tx_hash=${encodeURIComponent(transfer.tx_hash)}&log_index=${transfer.log_index}`,
      { maxBytes: ROW_PROOF_MAX_BYTES });
  } catch {
    return 'pending';
  }
  const d = reply.status === 200 ? parseOrNull(reply.text) : null;
  const hex = (v) => typeof v === 'string' && /^[0-9a-fA-F]{64}$/.test(v);
  if (!isObject(d) || d.error !== undefined || !hex(d.leaf) || !Array.isArray(d.proof) || !hex(d.block_root)
    || !Array.isArray(d.window_proof) || !hex(d.logs_root)) return 'pending';
  if (d.leaf.toLowerCase() !== leaf) return 'rejected';
  if (!core.verifyLogInclusion(d.leaf, d.proof, d.block_root) || !core.verifyLogWindowInclusion(d.block_root, d.window_proof, d.logs_root)) {
    return 'rejected';
  }
  const windowEnd = safeIntOf(d.window_end);
  if (windowEnd === null || windowEnd % MACROBLOCK_INTERVAL !== 0) return 'pending';
  if (core.stepsToVerify(windowEnd / MACROBLOCK_INTERVAL) > ROW_PROOF_WALK_STEPS) return 'pending';
  const anchored = await core.verifyMacroblockLogsRoot(d.logs_root.toLowerCase(), windowEnd, () => shuffled(QNET.NODES), walkHooks());
  if (anchored === true) return 'verified';
  return anchored === 'mismatch' ? 'rejected' : 'pending';
}

// The logs-proof verdict of each token row of `entries` ({row, item}) known now, by item: 'verified', 'rejected' or
// 'pending'. The rows due a check (tokenRowVerdict) start one in the background.
function tokenRowVerdicts(entries) {
  const now = Date.now();
  const keyed = entries.map((entry) => ({ ...entry, transfer: tokenTransferOf(entry.row) }))
    .filter(({ transfer }) => transfer !== null)
    .map((entry) => ({ ...entry, key: `${entry.transfer.tx_hash}:${entry.transfer.log_index}` }));
  const due = keyed.filter(({ key }) => {
    const known = rowVerdicts.get(key);
    return known === undefined || (known.verdict === 'pending' && !known.running && now - known.at >= ROW_PROOF_RETRY_MS);
  }).slice(0, ROW_PROOF_CHECKS);
  const checks = due.map(({ key, transfer, item }) => {
    const entry = { verdict: 'pending', at: now, running: true };
    rowVerdicts.delete(key);
    rowVerdicts.set(key, entry);
    return tokenRowVerdict(transfer, item.block).catch(() => 'pending').then((verdict) => {
      Object.assign(entry, { verdict, at: Date.now(), running: false });
      if (verdict === 'rejected') log.warn('token row proof refused');
    });
  });
  while (rowVerdicts.size > ROW_VERDICTS_MAX) rowVerdicts.delete(rowVerdicts.keys().next().value);
  if (checks.length > 0) background(Promise.all(checks).then(() => persistAnchors()));
  return new Map(keyed.map(({ key, item }) => [item, rowVerdicts.get(key)?.verdict ?? 'pending']));
}

// A superseded transfer (its replacement is being submitted) may still apply: it reads as pending or stale. A dropped one
// (isDropped, against the chain's nonce last read) reads as dropped; one the chain took, as included (two pinned nodes
// list it at its nonce) until the archive lists its row.
function pendingStatus(p, address, now) {
  if (p.outcome === 'confirmed') return 'included';
  if (p.outcome === 'replaced') return 'replaced';
  // its nonce was used, and no two nodes agree yet on what applied there (R3-EXTQ-04)
  if (p.outcome === 'passed') return 'unknown';
  const confirmed = seenNonceOf(address);
  if (confirmed !== null && isDropped(p, confirmed, now)) return 'dropped';
  // one node refused it; it may still apply until its nonce is used (R5-EXTQ-02)
  if (p.outcome === 'refused') return 'refused';
  return isStale(p, now) ? 'stale' : 'pending';
}

const pendingItem = (p, address, now) => ({
  // the hash two pinned nodes list for one the chain took; a node's hash of one not in a block is no identity
  hash: p.outcome === 'confirmed' ? (p.txHash ?? '') : '',
  direction: p.to === address ? 'self' : 'out',
  from: address,
  to: p.to,
  amountNano: p.amountNano,
  feeNano: p.feeNano,
  timestamp: p.createdAt,
  status: pendingStatus(p, address, now),
  nonce: p.nonce,
  kind: kindOf(p),
  // a call's method, and a token transfer's recipient and amount (in the token's own units; `to` is the token)
  ...(kindOf(p) === 'call' ? { method: p.call.method, recipient: p.call.recipient, amountBase: p.call.amount } : {}),
});

let lastResubmitScan = 0;
// History waits this long for the run of resubmitPending it starts, so a transaction the chain took reads as confirmed
// before the page is drawn.
const RESUBMIT_WAIT_MS = 1500;

// The archive row kind of a kept transaction (vault PendingTransfer): a transfer, a token transfer, any other call.
const archiveKindOf = (p) => (kindOf(p) === 'transfer' ? 'transfer' : (p.call.recipient !== null ? 'token' : 'call'));

// Whether an archive row was sent at or after kept transaction `p` was signed (LANDING_MARGIN_MS for clocks) with its
// parties and amount: a transfer's recipient and amount, a token transfer's token, recipient and amount.
function sentAs(item, p) {
  if (item.timestamp <= 0 || msOf(item.timestamp) < p.createdAt - LANDING_MARGIN_MS) return false;
  if (item.kind === 'transfer') return lower(item.to) === lower(p.to) && item.amountNano === p.amountNano;
  return item.kind === 'token' && item.token.contract === p.to && lower(item.to) === lower(p.call.recipient)
    && item.amountBase === p.call.amount;
}

/**
 * The archive row of each kept transaction the chain took (outcome confirmed), one row to one transaction at most: the
 * row with the hash two pinned nodes list for it, of its kind (archiveKindOf) first; for one they listed under different
 * hashes, a row of its kind with its parties and amount (sentAs) whose hash no kept transaction holds.
 * @param {HistoryItem[]} items the archive page
 * @param {object[]} records the vault's pending transfers
 * @returns {Map<string, number>} a record's body → the index of its row in `items`
 */
function archiveClaims(items, records) {
  const claims = new Map();
  const taken = new Set();
  const held = new Set(records.map((p) => p.txHash).filter((hash) => hash !== null));
  const claim = (p, fits) => {
    if (claims.has(p.body)) return;
    const at = items.findIndex((item, i) => !taken.has(i) && item.direction !== 'in' && fits(item));
    if (at < 0) return;
    claims.set(p.body, at);
    taken.add(at);
  };
  const confirmed = records.filter((p) => p.outcome === 'confirmed');
  const hashed = confirmed.filter((p) => p.txHash !== null);
  for (const p of hashed) claim(p, (item) => item.hash === p.txHash && item.kind === archiveKindOf(p));
  // a token transfer that failed at apply wrote no event: the archive lists its call's row alone
  for (const p of hashed) claim(p, (item) => item.hash === p.txHash);
  for (const p of confirmed) {
    if (p.txHash === null) claim(p, (item) => item.kind === archiveKindOf(p) && !held.has(item.hash) && sentAs(item, p));
  }
  return claims;
}

// A page of the explorer archive merged with the vault's pending transfers; with `confirm` (this wallet's own History),
// each archive row two pinned nodes list alike reads 'included' (in a block, applied or not: R5-EXTQ-01), every other one
// stays 'unverified' (R4-EXTQ-04). A token row reads included by its logs proof, or, when this wallet sent it, by two
// nodes listing its call; a proof that contradicts it leaves it unverified. A transaction the chain took is listed from
// the vault until the page lists its row (archiveClaims); that row then reads included, and the record leaves the vault
// once the row does by the page's own reads: one row for it at every moment.
async function historyOf(qnetAddress, params, confirm) {
  const limit = Number.isSafeInteger(params.limit)
    ? Math.min(Math.max(params.limit, 1), LIMITS.HISTORY_PAGE_MAX)
    : HISTORY_DEFAULT_LIMIT;
  const cursor = typeof params.cursor === 'string' && CURSOR_RE.test(params.cursor) ? params.cursor : null;

  let resubmitted = null;
  if (Date.now() - lastResubmitScan >= RESUBMIT_INTERVAL_MS) {
    lastResubmitScan = Date.now();
    resubmitted = background(resubmitPending().catch((error) => log.debug('resubmit', error?.code ?? error?.name)));
  }

  const query = `limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
  const [text, state, confirmed] = await Promise.all([
    explorerRequest(`/api/address/${encodeURIComponent(qnetAddress)}/history?${query}`),
    Promise.resolve(confirm && resubmitted !== null ? withinBudget(resubmitted, RESUBMIT_WAIT_MS) : null).then(() => vault.readState()),
    confirm ? nodeConfirmedRows(qnetAddress).catch(() => new Set()) : null,
  ]);
  const body = parseOrNull(text);
  if (!isObject(body) || body.success !== true || !Array.isArray(body.items)) throw new WalletError('NETWORK');
  const mapped = body.items.map((row) => ({ row, item: historyItem(row, qnetAddress) })).filter(({ item }) => item !== null);
  const verdicts = confirm ? tokenRowVerdicts(mapped.filter(({ item }) => item.kind === 'token')) : new Map();
  const listed = (item) => {
    if (confirmed === null) return false;
    if (item.kind !== 'token') return confirmed.has(identityOf(item));
    const verdict = verdicts.get(item);
    // a node lists a contract call only under its caller: two listing it speak for a token row this wallet sent
    return verdict === 'verified' || (verdict !== 'rejected' && item.direction !== 'in' && confirmed.has(identityOf(item)));
  };
  // the light node's registration this wallet submitted names its node (the archive's row names none)
  const own = state.registration;
  const named = (item) => (item.kind === 'node_registration' && typeof own?.txHash === 'string' && own.txHash === item.hash
    ? { ...item, nodeId: own.nodeId } : item);
  const shown = mapped.map(({ item }) => named(listed(item) ? { ...item, status: 'included' } : item));
  const next = typeof body.next_cursor === 'string' && CURSOR_RE.test(body.next_cursor) ? body.next_cursor : null;
  const claims = confirm ? archiveClaims(shown, state.pendingTransfers) : new Map();
  const claimed = new Set(claims.values());
  // a row claimed by a transaction two pinned nodes listed at its nonce reads included, unless its logs proof contradicts it
  const upheld = (item, i) => claimed.has(i) && item.status !== 'included' && verdicts.get(mapped[i].item) !== 'rejected';
  const items = shown.map((item, i) => (upheld(item, i) ? { ...item, status: 'included' } : item));
  const archived = [...claims].filter(([, at]) => shown[at].status === 'included').map(([record]) => record);
  if (archived.length > 0) {
    await vault.updateState((current) => ({
      ...current, pendingTransfers: current.pendingTransfers.filter((p) => !(p.outcome === 'confirmed' && archived.includes(p.body))),
    })).catch((error) => log.warn('archived transactions not dropped', error?.code ?? error?.name));
  }
  const now = Date.now();
  const pending = [...state.pendingTransfers].reverse().filter((p) => !claims.has(p.body))
    .map((p) => pendingItem(p, qnetAddress, now));
  return { items, cursor: next, pending };
}

/**
 * Handler of `qnet.history`: explorer archive page (EXPLORER_API /api/address/{a}/history) merged with
 * the vault's pending transfers. The archive is the site's host, not a node, so its rows are not taken as
 * applied on its word: a row two pinned nodes list alike in their newest history (hash, both parties, amount; a token
 * row this wallet sent, its call's hash) or a token row its logs proof verifies in the background is 'included', any
 * other is 'unverified' (R4-EXTQ-04). Neither says the transfer applied: a block carries, and
 * every node lists, a transfer it skipped at apply too, and no node's history gives the outcome, so only the
 * balance, which the wallet verifies, shows what applied (R5-EXTQ-01). A transaction of this wallet the chain took is
 * listed from the vault ('included') until the page lists its row (historyOf). Also starts resubmitPending in the
 * background (at most every RESUBMIT_INTERVAL_MS).
 * @param {{cursor?: string|null, limit?: number}} params limit 1..LIMITS.HISTORY_PAGE_MAX, default 20
 * @returns {Promise<{items: HistoryItem[], cursor: string|null, pending: HistoryItem[]}>}
 * @throws {WalletError} LOCKED, NETWORK
 */
export async function getHistory(params = {}) {
  const { qnetAddress } = await session.requireUnlocked();
  return historyOf(qnetAddress, params ?? {}, true);
}

// The archive page the recipient check reads (recipientCheck), by address: one read shared by the reads that overlap, and
// a page read in the last RECIPIENT_PAGE_MS used again, so the Send tab can read it while the address is typed
// (sendWarm) and the review finds it read. It only ever adds warnings.
const RECIPIENT_PAGE_MS = 30 * 1000;
const recipientPages = new Map();
function recipientPage(address) {
  const kept = recipientPages.get(address);
  if (kept !== undefined && (kept.at === null || Date.now() - kept.at < RECIPIENT_PAGE_MS)) return kept.read;
  const entry = { at: null, read: null };
  entry.read = historyOf(address, { limit: LIMITS.HISTORY_PAGE_MAX }, false).then(({ items }) => {
    entry.at = Date.now();
    return items;
  }, (error) => {
    if (recipientPages.get(address) === entry) recipientPages.delete(address);
    throw error;
  });
  recipientPages.set(address, entry);
  while (recipientPages.size > 2) recipientPages.delete(recipientPages.keys().next().value);
  return entry.read;
}

// Shares the first and last four characters with a different address: what a person compares, and
// what an address-poisoning look-alike copies (the popup's kit.looksLikeKnownAddress rule).
function looksAlike(candidate, known) {
  for (const address of known) {
    if (address !== candidate && address.length === candidate.length && address.slice(0, 4) === candidate.slice(0, 4)
      && address.slice(-4) === candidate.slice(-4)) return true;
  }
  return false;
}

/**
 * How a recipient relates to this wallet, for the first-time, look-alike and address-poisoning warnings
 * of the send review and the dApp approval (MISS-03, ES-01). `known` and the look-alike base come from
 * the vault: the addresses this wallet signed transfers to (VaultState.recipients and the pending sends),
 * never an incoming sender and never a window of the explorer archive, which a dust sender or the site's
 * own host could shape. The newest archive page can only add warnings: more look-alike candidates (its
 * outgoing rows) and incomingOnly (`to` sent to this wallet there and was never paid by it).
 * @param {string} to EON
 * @returns {Promise<{known: boolean, lookalike: boolean, incomingOnly: boolean, historyRead: boolean}>} historyRead: the
 *   archive page was read (incomingOnly is only known then)
 * @throws {WalletError} LOCKED, INVALID_ADDRESS
 */
export async function recipientCheck(to) {
  const { qnetAddress } = await session.requireUnlocked();
  if (!core.isValidQnetAddress(to)) throw new WalletError('INVALID_ADDRESS');
  const state = await vault.readState();
  // a pending call's `to` is its contract; a token transfer names its recipient apart
  const sent = new Set([...state.recipients, ...state.pendingTransfers.map((p) => (kindOf(p) === 'call' ? p.call.recipient : p.to))]);
  sent.delete(null);
  sent.delete(qnetAddress);
  let items = null;
  try {
    // the archive page only adds warnings here, so its rows are not checked against the nodes
    items = await recipientPage(qnetAddress);
  } catch (error) {
    log.warn('history unavailable for the recipient check', error?.code ?? error?.name);
  }
  const paid = new Set();
  const senders = new Set();
  for (const item of items ?? []) {
    if (item.direction === 'out' && core.isValidQnetAddress(item.to)) paid.add(item.to);
    if (item.direction === 'in') senders.add(item.from);
  }
  const known = sent.has(to);
  const own = to === qnetAddress;
  return {
    known,
    lookalike: !known && !own && looksAlike(to, [...sent, ...paid]),
    incomingOnly: !known && !own && senders.has(to) && !paid.has(to),
    historyRead: items !== null,
  };
}

// ---------------------------------------------------------------- transfers

/**
 * Fee of a plain transfer from the bundle's fee table (gas price and gas limit are fixed by the
 * wallet, never taken from a caller: MISS-03).
 * @returns {string} nano, u64 decimal
 */
export function transferFeeNano() {
  return String(core.fees.TRANSFER_FEE_NANO);
}

// A send's live base (transferSnapshot) and its recipient check (assertPayableRecipient), read together; a base that
// cannot be had is the error said first.
async function baseWithRecipient(snapshotRead, recipientRead) {
  const [base, recipient] = await Promise.allSettled([snapshotRead, recipientRead]);
  if (base.status === 'rejected') throw base.reason;
  if (recipient.status === 'rejected') throw recipient.reason;
  return base.value;
}

function assertTransfer(to, amountNano) {
  if (!core.isValidQnetAddress(to)) throw new WalletError('INVALID_ADDRESS');
  if (u64Of(amountNano) === null || amountNano === '0') throw new WalletError('INVALID_AMOUNT');
}

// The parts of a preview every kind shares: the nonce, what is left to spend, how the account was verified, the
// earlier transactions not seen applied (a call names its contract in `to`), and whether one of them still holds the
// nonce before this one: the node admits a transaction only at the committed nonce + 1, so this one waits (inFlight).
function snapshotView(snapshot) {
  const now = Date.now();
  return {
    nonce: snapshot.nextNonce,
    balanceNano: snapshot.spendable.toString(),
    verified: snapshot.account.verified,
    verification: snapshot.account.verification,
    outstanding: snapshot.outstanding.map((p) => ({
      nonce: p.nonce, to: p.to, amountNano: p.amountNano, feeNano: p.feeNano, createdAt: p.createdAt, stale: isStale(p, now),
      refused: p.outcome === 'refused', kind: kindOf(p),
    })),
    replacesNonce: snapshot.replaceNonce,
    inFlight: BigInt(snapshot.nextNonce) !== snapshot.confirmed + 1n,
  };
}

function previewOf(from, to, amountNano, snapshot) {
  const feeNano = transferFeeNano();
  const total = BigInt(amountNano) + BigInt(feeNano);
  if (total > U64_MAX) throw new WalletError('INVALID_AMOUNT');
  const view = snapshotView(snapshot);
  return {
    from,
    to,
    amountNano,
    feeNano,
    totalNano: total.toString(),
    nonce: view.nonce,
    balanceNano: view.balanceNano,
    verified: view.verified,
    verification: view.verification,
    outstanding: view.outstanding,
    replacesNonce: view.replacesNonce,
    inFlight: view.inFlight,
  };
}

/**
 * Builds the preview of a transfer from the session's address: fee, total, next nonce, balance, and the
 * earlier transfers still outstanding. replaceNonce: the transfer replaces the outstanding one of that
 * nonce (signed at its nonce, so only one of the two can apply). A recipient that is a contract has no preview
 * (assertPayableRecipient).
 * @param {{to: string, amountNano: string, replaceNonce?: string|null}} transfer
 * @returns {Promise<TransferPreview>}
 * @throws {WalletError} LOCKED, NETWORK, BALANCE_UNCONFIRMED, NONCE_UNAVAILABLE, NONCE_CHANGED (nothing outstanding at
 *   replaceNonce), INVALID_ADDRESS, INVALID_AMOUNT, RECIPIENT_IS_CONTRACT, RECIPIENT_UNCHECKED
 */
export async function prepareTransfer(transfer) {
  const { to, amountNano, replaceNonce = null } = transfer ?? {};
  assertTransfer(to, amountNano);
  if (replaceNonce !== null && u64Of(replaceNonce) === null) throw new WalletError('INVALID_PARAMS');
  const { qnetAddress } = await session.requireUnlocked();
  const snapshot = await baseWithRecipient(transferSnapshot(qnetAddress, replaceNonce), assertPayableRecipient(to, qnetAddress));
  return previewOf(qnetAddress, to, amountNano, snapshot);
}

// Sends and pending-list edits run one at a time, so two sends never take the same nonce.
let queueTail = Promise.resolve();
function serialized(fn) {
  const run = queueTail.then(fn, fn);
  queueTail = run.catch(() => {});
  return run;
}

/**
 * The exact JSON text POSTed to /api/v1/transaction, as the shared builder writes it (core.transferRequestJson, the
 * mobile sendQNC field order): u64 fields are bare JSON integers written from their decimal strings; the public key is
 * always carried, which the node accepts whether or not it already holds the key.
 * @param {{from: string, to: string, amountNano: string, nonce: string, gasPrice: string, gasLimit: string,
 *   signature: Uint8Array, publicKey: Uint8Array}} signed
 * @returns {string}
 */
export function transferBody(signed) {
  const { from, to, amountNano, nonce, gasPrice, gasLimit } = signed;
  for (const v of [amountNano, nonce, gasPrice, gasLimit]) if (u64Of(v) === null) throw new WalletError('INTERNAL');
  if (!core.isValidQnetAddress(from) || !core.isValidQnetAddress(to)) throw new WalletError('INTERNAL');
  const signature = core.bytesToHex(signed.signature);
  const publicKey = core.bytesToHex(signed.publicKey);
  if (!HEX_RE.test(signature) || !HEX_RE.test(publicKey)) throw new WalletError('INTERNAL');
  return core.transferRequestJson({ from, to, amountNano, nonce, gasPrice, gasLimit }, signature, publicKey);
}

// POSTs a stored body to its route (a transfer's by default). null when no node answered. A refusal is `definitive`
// only when no other node was sent the body: with a hedged second node in flight, the transaction may have entered its
// mempool. Even a definitive refusal is one node's word: the caller keeps the transaction as 'refused' (R5-EXTQ-02).
async function submit(body, path = core.TX_ROUTES.transfer.path) {
  let reply;
  try {
    reply = await nodeRequest(path, { method: 'POST', body });
  } catch (error) {
    if (error instanceof WalletError && error.code === 'NETWORK') return null;
    throw error;
  }
  const answer = reply.status === 200 ? parseOrNull(reply.text) : null;
  const hash = isObject(answer) ? answer.tx_hash : undefined;
  const txHash = typeof hash === 'string' && TX_HASH_RE.test(hash) ? hash : null;
  const accepted = isObject(answer) && (answer.success === true || txHash !== null) && answer.success !== false;
  return { accepted, txHash, definitive: reply.attempts === 1 };
}

/**
 * Signs and submits a QNC transfer: checks the fee against expectedFeeNano (and the nonce against
 * expectedNonce when given), that the recipient is no contract (assertPayableRecipient, read again whatever the review
 * read), checks balance >= total, signs via keys.signQnetTransfer, stores a
 * PendingTransfer with the exact body before the first POST, submits, and reports submitted, never
 * confirmed. An unanswered submit is 'unknown' and stays pending for resubmitPending, and so is a
 * refusal while another node may hold the body. A refusal from the only node sent it is one node's word, and that
 * node may still have passed the body on: the record stays, listed and reserved, as 'refused' (never resent by the
 * wallet itself, decided by the chain once its nonce is used), the error says it may still apply (NODE_REJECTED),
 * and the next transfer takes its nonce by default (R5-EXTQ-02, as mobile PendingTx).
 * replaceNonce: sign at that outstanding transfer's nonce instead (whichever of the two lands first applies,
 * the other never can: R2-EXTQ-03); without it, at the nonce of a refused transfer (transferSnapshot). A replaced
 * transfer still sent is marked superseded in the write that stores the new one, and goes only once a node took
 * the new one or may hold it; a refusal from the only node sent the new one puts it back as it was, so a transfer
 * that may still apply is never dropped unseen (R4-EXTQ-01). A replaced refused one stays refused until then. A new
 * send leaves one place of LIMITS.PENDING_TRANSFERS_MAX free for such a replace. oneInFlight (a dApp request): the nonce
 * must be the committed one + 1, the only one the node admits, else NONCE_CHANGED (the approval waits and reviews again).
 * @param {{to: string, amountNano: string, expectedFeeNano: string, expectedNonce?: string|null,
 *   replaceNonce?: string|null, oneInFlight?: boolean}} transfer
 * @returns {Promise<{txHash: string|null, status: 'submitted'|'unknown', nonce: string, from: string}>} the
 *   transfer's identity is (from, nonce): at most one transaction of `from` applies at a nonce. txHash: what the
 *   answering node returned, not an identity (another node's copy of the same signed body may be the one that
 *   lands: R2-EXTQ-06, R5-EXTQ-03)
 * @throws {WalletError} LOCKED, SIGNING_DISABLED, FEE_CHANGED, NONCE_CHANGED, NONCE_UNAVAILABLE, BALANCE_UNCONFIRMED,
 *   INSUFFICIENT_FUNDS, TOO_MANY_PENDING, NODE_REJECTED, NETWORK, RECIPIENT_IS_CONTRACT, RECIPIENT_UNCHECKED
 */
export async function sendTransfer(transfer) {
  const { to, amountNano, expectedFeeNano, expectedNonce = null, replaceNonce = null, oneInFlight = false } = transfer ?? {};
  assertTransfer(to, amountNano);
  if (replaceNonce !== null && u64Of(replaceNonce) === null) throw new WalletError('INVALID_PARAMS');
  return serialized(async () => {
    const { qnetAddress: from } = await session.requireUnlocked();
    if (expectedFeeNano !== transferFeeNano()) throw new WalletError('FEE_CHANGED');
    const snapshot = await baseWithRecipient(transferSnapshot(from, replaceNonce), assertPayableRecipient(to, from));
    const preview = previewOf(from, to, amountNano, snapshot);
    checkNonce(snapshot, expectedNonce, oneInFlight);
    checkRoom(snapshot);
    if (BigInt(preview.totalNano) > snapshot.spendable) throw new WalletError('INSUFFICIENT_FUNDS');

    const gasPrice = String(core.fees.GAS_PRICE);
    const gasLimit = String(core.fees.TRANSFER_GAS_LIMIT);
    const fields = { from, to, amountNano, nonce: preview.nonce, gasPrice, gasLimit };
    const { preimage, signature, publicKey } = await keys.signQnetTransfer(fields);
    const expected = core.transferPreimage(from, to, amountNano, fields.nonce, fields.gasPrice, fields.gasLimit);
    if (preimage !== expected || !core.verifyTransferSignature(fields, signature, publicKey)) {
      throw new WalletError('SIGNATURE_SELF_CHECK_FAILED');
    }
    const body = transferBody({ ...fields, signature, publicKey });
    const record = pendingRecord({ nonce: fields.nonce, to, amountNano, feeNano: preview.feeNano, body });
    // a recipient the user signed for becomes a known one (recipientCheck)
    return storeAndSubmit(from, snapshot, record, (state) => (to === from ? state : vault.withRecipient(state, to)));
  });
}

// The nonce the reviewed transaction was shown with, and for a dApp request (oneInFlight) the committed nonce + 1: the
// node admits no other, so a request behind a transaction not in a block yet waits instead of being refused.
function checkNonce(snapshot, expectedNonce, oneInFlight) {
  if (expectedNonce !== null && expectedNonce !== snapshot.nextNonce) throw new WalletError('NONCE_CHANGED');
  if (oneInFlight && BigInt(snapshot.nextNonce) !== snapshot.confirmed + 1n) throw new WalletError('NONCE_CHANGED');
}

// One place stays free for a replace, which keeps the transaction it replaces listed until its own outcome is known:
// an explicit one, or the refused transaction a new one takes the place of (R5-EXTQ-02).
function checkRoom(snapshot) {
  if (snapshot.replaceNonce === null && snapshot.outstanding.length >= LIMITS.PENDING_TRANSFERS_MAX - 1) {
    throw new WalletError('TOO_MANY_PENDING');
  }
}

// A vault PendingTransfer for a signed body, before its first POST.
function pendingRecord({ nonce, to, amountNano, feeNano, body, call = null }) {
  const now = Date.now();
  return {
    nonce, to, amountNano, feeNano, body, txHash: null, createdAt: now, lastSubmitAt: now, outcome: 'pending',
    kind: call === null ? 'transfer' : 'call', call,
  };
}

// Stores the record of a signed transaction (a transfer or a call) with the exact body before its first POST, then
// submits it to its route; `withRecord` adds what the kind keeps beside it in the same write. The transactions it
// replaces at its nonce are not dropped before its outcome is known (R4-EXTQ-01): marked superseded (no longer
// resent, still listed, reserved and decided by the chain) until a node takes the replacement, or may hold it; a
// definitive refusal of the replacement puts them back, and the replacement stays as refused (R5-EXTQ-02).
async function storeAndSubmit(from, snapshot, record, withRecord) {
  const replacing = snapshot.replaceNonce;
  const { confirmed } = snapshot;
  const { body } = record;
  let superseded = [];
  let refusedBefore = [];
  ownSendAt.set(from, record.createdAt);
  // the next recipient check reads the archive again: this send may be on its page soon
  recipientPages.delete(from);
  await vault.updateState((state) => {
    const sentAt = (p) => p.outcome === 'pending' && p.nonce === record.nonce;
    const refusedAt = (p) => p.outcome === 'refused' && p.nonce === record.nonce;
    // a replace whose target was decided meanwhile, or a new nonce another transaction took: review again
    if ((replacing !== null) !== state.pendingTransfers.some((p) => sentAt(p) || refusedAt(p))) throw new WalletError('NONCE_CHANGED');
    superseded = replacing === null ? [] : state.pendingTransfers.filter(sentAt).map((p) => p.body);
    refusedBefore = replacing === null ? [] : state.pendingTransfers.filter(refusedAt).map((p) => p.body);
    const kept = state.pendingTransfers.map((p) => (superseded.includes(p.body) ? { ...p, outcome: 'superseded' } : p));
    // room first from what the chain already decided (its nonce passed, the history names the outcome
    // later) and from replaced ones, oldest first; never from a transaction that may still apply
    while (kept.length >= LIMITS.PENDING_TRANSFERS_MAX) {
      const index = kept.findIndex((p) => !mayStillApply(p) || BigInt(p.nonce) <= confirmed);
      if (index < 0) throw new WalletError('TOO_MANY_PENDING');
      kept.splice(index, 1);
    }
    // what it can take is kept by nonce beside it, and stays after the record goes (withSpends, liveSend)
    return withRecord(withSpends({ ...state, pendingTransfers: [...kept, record] }, { add: spendRow(record), now: record.createdAt }));
  });
  const isSuperseded = (p) => p.outcome === 'superseded' && superseded.includes(p.body);

  const outcome = await submit(body, routeOf(record));
  if (outcome !== null && !outcome.accepted && outcome.definitive) {
    // the only node sent it refused it: one node's word, and it may have passed the body on, so the transaction
    // stays listed and reserved as refused (R5-EXTQ-02); what it was to replace is sent again
    await vault.updateState((state) => ({
      ...state,
      pendingTransfers: state.pendingTransfers.map((p) => {
        if (p.body === body) return { ...p, outcome: 'refused' };
        return isSuperseded(p) ? { ...p, outcome: 'pending' } : p;
      }),
    }));
    throw new WalletError('NODE_REJECTED');
  }
  // taken, or a node may hold it: the replaced transactions are no longer resent (whichever of them lands first
  // applies, the others never can: R2-EXTQ-03), and their records go, refused ones included
  const txHash = outcome?.accepted ? outcome.txHash : null;
  const replaced = (p) => isSuperseded(p) || (p.outcome === 'refused' && refusedBefore.includes(p.body));
  if (superseded.length > 0 || refusedBefore.length > 0 || txHash !== null) {
    const withHash = (p) => (txHash !== null && p.nonce === record.nonce && p.body === body ? { ...p, txHash } : p);
    await vault.updateState((state) => ({
      ...state, pendingTransfers: state.pendingTransfers.filter((p) => !replaced(p)).map(withHash),
    })).catch((error) => log.warn('pending transfers not updated', error?.code));
  }
  if (outcome === null || !outcome.accepted) return { txHash: null, status: 'unknown', nonce: record.nonce, from };
  return { txHash, status: 'submitted', nonce: record.nonce, from };
}

// ---------------------------------------------------------------- dApp token transfers and contract calls

// The node's answers of GET /api/v1/token/{address} for a contract that is no token and for an address that holds no
// contract (development/qnet-integration/src/rpc/misc_api.rs handle_token_info).
const NOT_A_TOKEN = 'Contract exists but is not a QRC-20/QRC-721 token';
const NO_TOKEN = 'Token not found';
const TOKEN_TEXT_MAX = 64;
const U128_RE = /^(0|[1-9][0-9]{0,38})$/;
const U128_MAX = (1n << 128n) - 1n;
// What a contract is never changes once deployed: kept a minute, at most this many.
const CONTRACT_CACHE_MS = 60 * 1000;
const CONTRACT_CACHE_MAX = 64;
const CALL_KINDS = new Set(['tokenTransfer', 'contractCall']);
const METHOD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ARGS_RE = /^(?:[0-9a-f]{2})*$/;

const u128Of = (value) => (typeof value === 'string' && U128_RE.test(value) && BigInt(value) <= U128_MAX ? value : null);
// A token's name or symbol as a page shows it: every hidden or format character replaced by U+FFFD (core.tokenLabel, the
// app's rule), so none can reorder or hide what is drawn; '' for a longer text or anything else.
const tokenText = (value) => {
  const label = typeof value === 'string' && value.length <= TOKEN_TEXT_MAX ? core.tokenLabel(value) : '';
  return core.isVisibleText(label) ? label : '';
};
// Whether a token's symbol or name, as deployed, is QNet's own in any spelling a reader takes for it, or carries a hidden
// or format character (core.usesReservedName, the app's rule): such a token is never drawn as if it were QNC.
const reservedName = (symbol, name) => core.usesReservedName(typeof symbol === 'string' ? symbol : '', typeof name === 'string' ? name : '');

// Asks the nodes of `order` as agreeingAccount does: two at once, the next one for each that fails and for every HEDGE_MS
// of silence, so a silent node never holds the read for its whole timeout. After each answer, step(answers) says 'done',
// 'all' (ask every remaining node at once, then wait for all of them) or 'wait'. Resolves with the answers given (null for
// a node that said nothing usable) when step says done or every node asked has settled. read(node) resolves to an answer
// or null.
function hedgedRead(order, read, step) {
  return new Promise((resolve) => {
    const answers = [];
    let launched = 0;
    let running = 0;
    let settled = false;
    let all = false;
    let hedge = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearInterval(hedge);
      resolve(answers);
    };
    const launch = () => {
      if (settled || launched >= order.length) return;
      const node = order[launched];
      launched += 1;
      running += 1;
      Promise.resolve().then(() => read(node)).catch(() => null).then((given) => {
        running -= 1;
        if (settled) return;
        const answer = given ?? null;
        answers.push(answer);
        const next = all ? 'wait' : step(answers);
        if (next === 'done') {
          finish();
          return;
        }
        if (next === 'all') {
          all = true;
          while (launched < order.length) launch();
        } else if (answer === null && !all) {
          launch();
        }
        if (launched >= order.length && running === 0) finish();
      });
    };
    launch();
    launch();
    hedge = setInterval(() => {
      if (!all && launched < order.length) launch();
      else clearInterval(hedge);
    }, HEDGE_MS);
  });
}

// The one answer at least two pinned nodes give alike (the rule of every other state read): the first two alike of a
// hedged read (hedgedRead); two answers that differ bring in every remaining node, and all the answers decide; null
// without exactly one such answer. read(node) resolves to an answer or null.
async function agreedAnswer(read) {
  const pick = (answers) => {
    const counts = new Map();
    for (const answer of answers) {
      if (answer === null) continue;
      const key = JSON.stringify(answer);
      counts.set(key, { answer, count: (counts.get(key)?.count ?? 0) + 1 });
    }
    const agreed = [...counts.values()].filter((entry) => entry.count >= MIN_NODE_AGREEMENT);
    return agreed.length === 1 ? agreed[0].answer : null;
  };
  const answers = await hedgedRead(shuffled(QNET.NODES), read, (given) => {
    if (pick(given) !== null) return 'done';
    return given.filter((answer) => answer !== null).length >= MIN_NODE_AGREEMENT ? 'all' : 'wait';
  });
  return pick(answers);
}

// One node's answer about `address` as a contract, or null when it said nothing usable.
function contractAnswer(reply, address) {
  if (!reply || reply.status !== 200) return null;
  const body = parseOrNull(reply.text);
  if (!isObject(body)) return null;
  if (body.success === false) {
    if (body.error === NOT_A_TOKEN) return { kind: 'contract' };
    return body.error === NO_TOKEN ? { kind: 'none' } : null;
  }
  const token = body.success === true && isObject(body.token) ? body.token : null;
  if (token === null || token.contract_address !== address || (token.standard !== 'qrc20' && token.standard !== 'qrc721')) return null;
  const decimals = safeIntOf(token.decimals);
  if (decimals === null || decimals > 255) return null;
  return {
    kind: 'token', standard: token.standard, name: tokenText(token.name), symbol: tokenText(token.symbol), decimals,
    reserved: reservedName(token.symbol, token.name),
  };
}

const contractCache = new Map();

/**
 * What `address` is on chain, as two pinned nodes agree (GET /api/v1/token/{address}): a built-in token with its
 * standard, name, symbol and decimals, another contract, or none. No proof serves these fields, so a token's details
 * are two nodes' word, and the approval says so. A token or a contract is kept a minute; none is asked again.
 * @param {string} address EON
 * @returns {Promise<{kind: 'token', standard: 'qrc20'|'qrc721', name: string, symbol: string, decimals: number,
 *   reserved: boolean}|{kind: 'contract'}|{kind: 'none'}>} name and symbol as shown (tokenText: a hidden or format
 *   character replaced by U+FFFD; '' past TOKEN_TEXT_MAX); reserved: named after QNet's own coin (reservedName)
 * @throws {WalletError} INVALID_ADDRESS, NETWORK (no two nodes agree)
 */
export async function readContract(address) {
  if (!core.isValidQnetAddress(address)) throw new WalletError('INVALID_ADDRESS');
  const cached = contractCache.get(address);
  if (cached !== undefined && Date.now() - cached.at < CONTRACT_CACHE_MS) return { ...cached.answer };
  const answer = await agreedAnswer(async (node) => contractAnswer(await nodeRequest(`/api/v1/token/${address}`, { nodes: [node] }), address));
  if (answer === null) throw new WalletError('NETWORK');
  if (answer.kind !== 'none') {
    contractCache.delete(address);
    contractCache.set(address, { answer, at: Date.now() });
    while (contractCache.size > CONTRACT_CACHE_MAX) contractCache.delete(contractCache.keys().next().value);
  }
  return { ...answer };
}

// What recipients are by their certified account leaf (recipientKind), by address: {index, isContract}; and the leaf
// reads in flight, one per address (forgetChain drops both, so a read of the old chain keeps nothing).
const RECIPIENT_KINDS_MAX = 64;
const recipientKinds = new Map();
const recipientReads = new Map();

/**
 * Whether `address` is a contract account by its certified account leaf (is_contract, which the leaf hash commits to):
 * its account proof folded to the state root of a recent macroblock whose committee certificate this wallet verified
 * (judgeAccount), asked at this wallet's own verified macroblock first. An account proven absent is no contract. A leaf
 * read stands while its macroblock stands by the certified head (certifiedIndexStands); a contract stays one and refuses
 * every later recipient check at once (assertPayableRecipient). Run only in the background (that check, the Send tab's
 * read ahead), one read at a time per address.
 * @param {string} address
 * @returns {Promise<boolean|null>} null when no recent certified leaf could be had
 */
function recipientKind(address) {
  const running = recipientReads.get(address);
  if (running !== undefined) return running.read;
  const entry = {};
  entry.read = (async () => {
    const kept = recipientKinds.get(address);
    if (kept?.isContract === true) return true;
    if (kept !== undefined && certifiedIndexStands(kept.index, await certifiedHeadNow())) return false;
    const got = await proofAnswers(`/api/v1/account/${address}/balance/proof`, proofPasses(address),
      (reply) => judgeAccount(address, reply, null));
    const figure = got.verified;
    if (!figure || typeof figure.isContract !== 'boolean' || !Number.isSafeInteger(figure.index)) return null;
    if (recipientReads.get(address) !== entry) return figure.isContract;
    recipientKinds.delete(address);
    recipientKinds.set(address, { index: figure.index, isContract: figure.isContract });
    while (recipientKinds.size > RECIPIENT_KINDS_MAX) recipientKinds.delete(recipientKinds.keys().next().value);
    return figure.isContract;
  })().catch((error) => {
    log.debug('recipient leaf not read', error?.code ?? error?.name);
    return null;
  }).finally(() => {
    if (recipientReads.get(address) === entry) recipientReads.delete(address);
  });
  recipientReads.set(address, entry);
  return background(entry.read);
}

/**
 * Refuses a recipient that is a contract account (a built-in token or another contract). A contract account has no key
 * and no contract can send QNC or a built-in token on, so whatever a transfer or a token transfer credits to one stays
 * there for good, and the node's door takes such a transfer today (DEVP-R1-01: the SDK's recipient rule, with no
 * override here). Decided at once by what at least two pinned nodes report of the address at their live state
 * (readContract: a token, another contract or none), one read with the normal node timeout; a recipient no two nodes
 * agree on is not signed for. Its certified account leaf is read in the background only (recipientKind), and a contract
 * it proved is refused at once. `from`, the wallet's own address, is no contract and is not read.
 * @param {string} to EON
 * @param {string|null} [from]
 * @returns {Promise<void>}
 * @throws {WalletError} RECIPIENT_IS_CONTRACT, RECIPIENT_UNCHECKED, INVALID_ADDRESS
 */
export async function assertPayableRecipient(to, from = null) {
  if (!core.isValidQnetAddress(to)) throw new WalletError('INVALID_ADDRESS');
  if (to === from) return;
  recipientKind(to);
  if (recipientKinds.get(to)?.isContract === true) throw new WalletError('RECIPIENT_IS_CONTRACT');
  const answer = await readContract(to).catch((error) => {
    throw error?.code === 'NETWORK' ? new WalletError('RECIPIENT_UNCHECKED') : error;
  });
  if (answer.kind !== 'none') throw new WalletError('RECIPIENT_IS_CONTRACT');
}

/**
 * One 200 answer of the token balance proof route (GET /api/v1/token/{c}/{h}/balance/proof?mb=), by one strict parse. A
 * certified answer (proof_format 2) proves the contract account under the committee-certified root of the macroblock it
 * names and the holder's entry under the storage root that account commits to (a status 'absent' or 'not_contract' counts
 * only with its proof, and is a balance of 0); an older node's answer folds to its live root (liveRootToken), which counts
 * only when that root is a recent certified one. Both levels are bound to the asked contract and holder.
 * @returns {Promise<{verified?: object, figure?: object|null}>} a figure: {balanceBase, index, status}
 */
async function judgeToken(token, holder, reply) {
  const body = strictBody(reply.text);
  if (body === null) return {};
  if (body.proof_format !== undefined) {
    const read = core.readCertifiedToken(body, token, holder);
    if (!read.ok || u128Of(read.balanceBase) === null) return {};
    const figure = { balanceBase: read.balanceBase, index: read.index, status: read.status };
    const folded = typeof body.state_root === 'string' && read.fold(body.state_root);
    const root = await certifiedRootFresh(read.index);
    if (root.ok && read.fold(root.stateRoot)) return { verified: figure };
    return { figure: folded ? figure : null };
  }
  if (core.isLegacyProofBody(body, 'token')) core.markNodeOld(reply.node);
  const live = liveRootToken(body, token, holder);
  if (live === null) return {};
  const figure = { balanceBase: live.balanceBase, index: null, status: 'contract' };
  const index = await legacyIndexFresh(body.state_root, body.block_height);
  return index === null ? { figure } : { verified: { ...figure, index } };
}

// The holder's balance in a token body at a node's live root (the route without `mb`, or an older node's), when both
// levels fold to that root (core.verifyLegacyTokenProof): {balanceBase, blockHeight}; else null.
function liveRootToken(body, token, holder) {
  if (!core.verifyLegacyTokenProof(body, token, holder) || !Number.isSafeInteger(body.block_height) || body.block_height < 0) return null;
  return { balanceBase: body.token_balance === undefined ? '0' : String(body.token_balance), blockHeight: body.block_height };
}

/**
 * The certified token balance of `holder` (judgeToken): {balanceBase, index, status}, or {problem:
 * 'NETWORK'|'BALANCE_UNCONFIRMED'} (no node answered, or none certified a recent state).
 * @param {string} token
 * @param {string} holder
 * @returns {Promise<object>}
 */
async function certifiedTokenBalance(token, holder) {
  const got = await proofAnswers(`/api/v1/token/${token}/${holder}/balance/proof`, proofPasses(holder),
    (reply) => judgeToken(token, holder, reply));
  return got.verified ?? { problem: got.answered ? 'BALANCE_UNCONFIRMED' : 'NETWORK' };
}
// `${token}:${holder}` → the certified token read in flight (readTokenBalance)
const certifiedTokenReads = new Map();

/**
 * The token balance of `holder` at a pinned node's live tip (the token proof route without `mb`, liveRootToken):
 * {balanceBase, blockHeight}, or {problem: 'NETWORK'|'BALANCE_UNCONFIRMED'} (no node answered, or none with such a proof).
 * With `atLeast`, a figure of a lower block does not end the read: the next node is asked, and the highest figure kept
 * (proofAnswers). What a token send is decided by (tokenSide) and Assets shows first.
 * @param {string} token
 * @param {string} holder
 * @param {number|null} [atLeast] the block height of the QNC base a token send stands on
 * @returns {Promise<object>}
 */
async function liveTokenBalance(token, holder, atLeast = null) {
  const got = await proofAnswers(`/api/v1/token/${token}/${holder}/balance/proof`, [null],
    liveJudge((body) => liveRootToken(body, token, holder)), atLeast === null ? null : (figure) => figure.blockHeight >= atLeast);
  return got.figure ?? { problem: got.answered ? 'BALANCE_UNCONFIRMED' : 'NETWORK' };
}

/**
 * The balance of `holder` in a built-in token, in base units (u128 decimal), as Assets shows it: the live figure
 * (liveTokenBalance) with the certified one (certifiedTokenBalance, one per token and holder at a time: joinedRead)
 * beside it (liveOverCertified); null when neither can be had. A contract or entry proven absent is '0'.
 * @param {string} token
 * @param {string} holder
 * @returns {Promise<string|null>}
 * @throws {WalletError} INVALID_ADDRESS
 */
export async function readTokenBalance(token, holder) {
  if (!core.isValidQnetAddress(token) || !core.isValidQnetAddress(holder)) throw new WalletError('INVALID_ADDRESS');
  const certifiedRead = joinedRead(certifiedTokenReads, `${token}:${holder}`,
    () => certifiedTokenBalance(token, holder).then((got) => (got.problem ? null : got), () => null));
  const { live, certified, certifiedShown } = await liveOverCertified(
    liveTokenBalance(token, holder).then((got) => (got.problem ? null : got)), certifiedRead, (got) => got.index * MACROBLOCK_INTERVAL);
  return certifiedShown ? certified.balanceBase : (live?.balanceBase ?? null);
}

// ---------------------------------------------------------------- the wallet's own built-in tokens (Assets, Send)

// The decimals a built-in token may have for the wallet to send it (the router's token amount, as a dApp's token transfer).
const TOKEN_DECIMALS_MAX = 18;
// The tokens listed at most, and how long the list of contracts the nodes name as held is kept (each balance is read
// again on every list read).
const TOKEN_LIST_MAX = 20;
const TOKEN_LIST_CACHE_MS = 60 * 1000;
// {holder, at, contracts} of the last list of held contracts
let tokenList = null;

// The contracts one node lists as held by `holder` (GET /api/v1/account/{a}/tokens), or null when it said nothing usable.
async function heldContractsFrom(node, holder) {
  let body = null;
  try {
    const reply = await nodeRequest(`/api/v1/account/${holder}/tokens`, { nodes: [node] });
    body = reply.status === 200 ? parseOrNull(reply.text) : null;
  } catch {
    body = null;
  }
  if (!isObject(body) || body.success !== true || body.address !== holder || !Array.isArray(body.tokens)) return null;
  return body.tokens.filter(isObject).map((row) => row.contract_address).filter((contract) => core.isValidQnetAddress(contract));
}

// The contracts two pinned nodes list as held by `holder`, together: one node can leave a token out of the list, never put
// one in it, since listTokens reads every listed token again by two nodes. One answer is taken alone when only one node
// answers; null when none does. Asked as a hedged read (hedgedRead). Kept TOKEN_LIST_CACHE_MS.
async function heldContracts(holder) {
  if (tokenList !== null && tokenList.holder === holder && Date.now() - tokenList.at < TOKEN_LIST_CACHE_MS) return tokenList.contracts;
  const given = (lists) => lists.filter((list) => list !== null);
  const answers = given(await hedgedRead(shuffled(QNET.NODES), (node) => heldContractsFrom(node, holder),
    (lists) => (given(lists).length >= MIN_NODE_AGREEMENT ? 'done' : 'wait')));
  if (answers.length === 0) return null;
  const contracts = [...new Set(answers.flat())];
  tokenList = { holder, at: Date.now(), contracts };
  return contracts;
}

/**
 * Handler of `qnet.tokens`: the built-in QRC-20 tokens the wallet holds (owner, 06.10: any token of the QNet network can be
 * sent). The contracts two pinned nodes list as held (heldContracts), each read again: what it is, as two pinned nodes
 * name it alike (readContract: a QRC-20 token with at most TOKEN_DECIMALS_MAX decimals, else it is left out), and the
 * wallet's balance in it at a pinned node's live tip, or certified (readTokenBalance; a token whose balance neither gives
 * is listed with balanceBase null, one with a zero balance is left out). A token of a send of this wallet that History
 * still lists (a vault pending token transfer not replaced) stays listed, also at a zero balance (all of it sent): History
 * names that send's token and amount by this list, so those tokens come first and tokens sent to the wallet unasked can
 * never push them past TOKEN_LIST_MAX (L-13). At most TOKEN_LIST_MAX tokens. Each row says whether the token is named after QNet's own coin (reserved, M-5).
 * @returns {Promise<{tokens: Array<{contract: string, name: string, symbol: string, decimals: number,
 *   balanceBase: string|null, reserved: boolean}>, complete: boolean}>} complete: no QRC-20 token the nodes list as held
 *   was left out (past TOKEN_LIST_MAX, or no two nodes said what it is); a token whose balance is unread is listed
 * @throws {WalletError} LOCKED, NETWORK when no node listed the wallet's tokens
 */
export async function listTokens() {
  const { qnetAddress } = await session.requireUnlocked();
  const [held, state] = await Promise.all([heldContracts(qnetAddress), vault.readState().catch(() => null)]);
  if (held === null) throw new WalletError('NETWORK');
  const sending = new Set((state?.pendingTransfers ?? [])
    .filter((p) => kindOf(p) === 'call' && p.call?.recipient && p.outcome !== 'replaced').map((p) => p.to));
  const contracts = [...new Set([...sending, ...held])];
  let complete = contracts.length <= TOKEN_LIST_MAX;
  const rows = await Promise.all(contracts.slice(0, TOKEN_LIST_MAX).map(async (contract) => {
    let info = null;
    try {
      info = await readContract(contract);
    } catch {
      complete = false;
      return null;
    }
    if (info.kind !== 'token' || info.standard !== 'qrc20' || info.decimals > TOKEN_DECIMALS_MAX) return null;
    const balanceBase = await readTokenBalance(contract, qnetAddress).catch(() => null);
    if (balanceBase === '0' && !sending.has(contract)) return null;
    return {
      contract, name: info.name, symbol: info.symbol, decimals: info.decimals, balanceBase, reserved: info.reserved === true,
    };
  }));
  return { tokens: rows.filter(Boolean), complete };
}

// A token the wallet may send: a QRC-20 token (two pinned nodes agreeing) with at most TOKEN_DECIMALS_MAX decimals, and
// a decimal amount of it in base units (> 0, at most u64, at most its decimals).
async function sendableToken(token, amount) {
  const info = await readContract(token);
  if (info.kind !== 'token' || info.standard !== 'qrc20' || info.decimals > TOKEN_DECIMALS_MAX) {
    throw new WalletError('INVALID_PARAMS', { field: 'token' });
  }
  const amountBase = parseUnits(amount, info.decimals);
  if (amountBase <= 0n) throw new WalletError('INVALID_AMOUNT');
  return { info, amountBase: amountBase.toString() };
}

/**
 * Handler of `qnet.tokenPreview` (the popup's token send, the same path and checks as a dApp's token transfer): the
 * token's details (readContract), the amount in its decimals, then prepareCall (the shared builder's gas and maximum fee,
 * the storage deposit a new holder sets aside, the nonce, what is left to spend, the token balance a send is decided by
 * (tokenSide); a recipient that is a contract has no preview) with the recipient check of `to`, the reserved-name and
 * burn-address flags the approval window shows too.
 * @param {{token: string, to: string, amount: string}} params amount: a decimal of the token's units
 * @returns {Promise<CallPreview & {token: string, name: string, symbol: string, decimals: number, amount: string,
 *   reserved: boolean, burn: boolean, recipient: object|null}>}
 * @throws {WalletError} LOCKED, NETWORK, BALANCE_UNCONFIRMED, NONCE_UNAVAILABLE, INVALID_PARAMS (not a QRC-20 token),
 *   INVALID_AMOUNT, RECIPIENT_IS_CONTRACT, RECIPIENT_UNCHECKED
 */
export async function tokenPreview(params) {
  const { token, to, amount } = params ?? {};
  if (!core.isValidQnetAddress(token) || !core.isValidQnetAddress(to)) throw new WalletError('INVALID_ADDRESS');
  const { info, amountBase } = await sendableToken(token, amount);
  const [prepared, recipient] = await Promise.all([
    prepareCall({ kind: 'tokenTransfer', token, to, amountBase }),
    recipientCheck(to).catch((error) => {
      log.warn('recipient check failed', error?.code ?? error?.name);
      return null;
    }),
  ]);
  return {
    ...prepared, token, name: info.name, symbol: info.symbol, decimals: info.decimals, amount: formatUnits(amountBase, info.decimals),
    reserved: info.reserved === true || core.usesReservedName(info.symbol, info.name), burn: core.destroysTokens(to), recipient,
  };
}

/**
 * Handler of `qnet.tokenSend`: the token transfer the popup reviewed, signed and submitted as a dApp's is (sendCall): the
 * fee, the deposit and the nonce must be those the review showed (FEE_CHANGED, NONCE_CHANGED), the QNC balance must cover
 * fee and deposit and the token balance (tokenSide) the amount, and the recipient must be no contract.
 * @param {{token: string, to: string, amount: string, expectedFeeNano: string, expectedDepositNano: string,
 *   expectedNonce?: string}} params
 * @returns {Promise<{txHash: string|null, status: 'submitted'|'unknown', nonce: string, from: string}>}
 * @throws see sendCall; INVALID_PARAMS (not a QRC-20 token), INVALID_AMOUNT
 */
export async function tokenSend(params) {
  const { token, to, amount } = params ?? {};
  if (!core.isValidQnetAddress(token) || !core.isValidQnetAddress(to)) throw new WalletError('INVALID_ADDRESS');
  const { amountBase } = await sendableToken(token, amount);
  return sendCall({
    request: { kind: 'tokenTransfer', token, to, amountBase },
    expectedFeeNano: params.expectedFeeNano,
    expectedDepositNano: params.expectedDepositNano,
    expectedNonce: params.expectedNonce ?? null,
  });
}

/**
 * Handler of `qnet.txLookup` (the History detail): whether two pinned nodes list the transaction `hash` in a block at the
 * same height (GET /api/v1/transaction/{hash}). 'unknown' is no verdict: a node keeps no old bodies, and a row of another
 * chain is not found either.
 * @param {{hash: string}} params
 * @returns {Promise<{status: 'in_block'|'unknown', blockHeight: number|null}>}
 * @throws {WalletError} LOCKED, INVALID_PARAMS
 */
export async function txLookup(params) {
  const hash = params?.hash;
  if (typeof hash !== 'string' || !TX_HASH_RE.test(hash)) throw new WalletError('INVALID_PARAMS');
  await session.requireUnlocked();
  const blockHeight = await agreedBlockHeight(hash);
  return blockHeight === null ? { status: 'unknown', blockHeight: null } : { status: 'in_block', blockHeight };
}

/**
 * @typedef {object} CallRequest  a dApp's token transfer or contract call, as the wallet builds it
 * @property {'tokenTransfer'|'contractCall'} kind
 * @property {string} [token] tokenTransfer: the token contract
 * @property {string} [to] tokenTransfer: the recipient
 * @property {string} [amountBase] tokenTransfer: token base units, u64 decimal > 0
 * @property {string} [contract] contractCall
 * @property {string} [method] contractCall
 * @property {string} [args] contractCall: lowercase hex of the input, '' for none
 * @property {string|null} [gasLimit] contractCall: u64 decimal, or null for the default fuel
 *
 * @typedef {object} CallPreview  what the approval of a CallRequest shows and a confirm signs
 * @property {'tokenTransfer'|'contractCall'} kind
 * @property {string} from
 * @property {string} contract the token contract of a token transfer
 * @property {string} method
 * @property {string} gasLimit the shared builder's: a token transfer's intrinsic gas, a call's intrinsic gas plus fuel
 * @property {string} feeNano the most the gas limit can cost (effective price × gas limit); unused gas is refunded
 * @property {string} depositNano the refundable storage deposit a token transfer to a new holder sets aside, else '0'
 * @property {string} totalNano feeNano + depositNano: the QNC the transaction may take
 * @property {string} nonce
 * @property {string} balanceNano spendable QNC (TransferPreview.balanceNano)
 * @property {boolean} verified always false (TransferPreview.verified)
 * @property {'live'} verification
 * @property {OutstandingTransfer[]} outstanding
 * @property {string|null} replacesNonce
 * @property {boolean} inFlight an earlier transaction still holds the nonce before this one's
 * @property {string} [args] contractCall
 * @property {string} [to] tokenTransfer
 * @property {string} [amountBase] tokenTransfer
 * @property {string|null} [tokenBalance] tokenTransfer: the sender's as a send is decided by it (tokenSide), or null
 * @property {'NETWORK'|'BALANCE_UNCONFIRMED'|null} [tokenProblem] tokenTransfer: why tokenBalance is null
 */
function assertCall(request) {
  const ok = isObject(request) && CALL_KINDS.has(request.kind) && (request.kind === 'tokenTransfer'
    ? core.isValidQnetAddress(request.token) && core.isValidQnetAddress(request.to) && u64Of(request.amountBase) !== null
      && request.amountBase !== '0'
    : core.isValidQnetAddress(request.contract) && typeof request.method === 'string' && METHOD_RE.test(request.method)
      && typeof request.args === 'string' && ARGS_RE.test(request.args)
      && (request.gasLimit === null || u64Of(request.gasLimit) !== null));
  if (!ok) throw new WalletError('INVALID_PARAMS');
}

// The shared builder's transaction for a request of `from` at `nonce` (core.buildTokenTransfer / buildContractCall):
// calldata, gas limit, maximum fee and preimage all come from there.
function buildCall(request, from, nonce) {
  if (request.kind === 'tokenTransfer') {
    return core.buildTokenTransfer({ from, token: request.token, to: request.to, amount: request.amountBase, nonce });
  }
  return core.buildContractCall({
    from, contract: request.contract, method: request.method, args: request.args, nonce, gasLimit: request.gasLimit,
  });
}

/**
 * A token transfer's reads, at a pinned node's live tip (liveTokenBalance), of the QNC base's block or later where a node
 * has one. The sender's token balance a send is decided by: its live figure less the tokens this wallet's own token
 * transfers took after the QNC base's nonce up to the nonce the chain reached (liveSend) and may still move above it (the
 * one a replacement signs over left out); a contract call of this wallet above the QNC base's nonce may move tokens by an
 * amount not known here, so no token balance is decided until a base past it is read. And whether the recipient holds the
 * token already (its live figure): a new balance entry sets aside the refundable storage deposit, and a recipient whose
 * balance cannot be read counts as new, so the check stays on the safe side (as the mobile app's qrc20TransferQncNeedNano).
 * @returns {Promise<{tokenBalance: string|null, tokenProblem: 'NETWORK'|'BALANCE_UNCONFIRMED'|null, depositNano: string}>}
 */
async function tokenSide(request, from, snapshot) {
  const [mine, theirs] = await Promise.all([
    liveTokenBalance(request.token, from, snapshot.account.blockHeight),
    request.to === from ? null : liveTokenBalance(request.token, request.to),
  ]);
  const held = request.to === from ? mine : theirs;
  const depositNano = held.problem === undefined && held.balanceBase !== '0' ? '0' : String(core.fees.STORAGE_DEPOSIT_NANO);
  if (mine.problem) return { tokenBalance: null, tokenProblem: mine.problem, depositNano };
  if (tokenEffectUnknown(snapshot.known, snapshot.liveNonce)) return { tokenBalance: null, tokenProblem: 'BALANCE_UNCONFIRMED', depositNano };
  const perNonce = new Map();
  for (const p of snapshot.outstanding) {
    if (p.nonce === snapshot.replaceNonce || kindOf(p) !== 'call' || p.to !== request.token) continue;
    const amount = BigInt(p.call.amount);
    if (amount > (perNonce.get(p.nonce) ?? 0n)) perNonce.set(p.nonce, amount);
  }
  let left = BigInt(mine.balanceBase) - settledSpend(snapshot.known, snapshot.liveNonce, snapshot.confirmed, request.token);
  for (const amount of perNonce.values()) left -= amount;
  return { tokenBalance: (left > 0n ? left : 0n).toString(), tokenProblem: null, depositNano };
}

function callPreviewOf(from, tx, snapshot, token) {
  const depositNano = token?.depositNano ?? '0';
  const total = BigInt(tx.maxFeeNano) + BigInt(depositNano);
  if (total > U64_MAX) throw new WalletError('INVALID_AMOUNT');
  const preview = {
    kind: tx.kind, from, contract: tx.contract, method: tx.method, gasLimit: tx.gasLimit, feeNano: tx.maxFeeNano, depositNano,
    totalNano: total.toString(), ...snapshotView(snapshot),
  };
  if (token === null) return { ...preview, args: tx.args };
  return { ...preview, to: tx.to, amountBase: tx.amount, tokenBalance: token.tokenBalance, tokenProblem: token.tokenProblem };
}

// A token transfer's recipient must be no contract (assertPayableRecipient); a call's target is one by design.
const recipientOfCall = (request, from) => (request.kind === 'tokenTransfer' ? assertPayableRecipient(request.to, from) : null);

/**
 * The preview of a dApp's token transfer or contract call from the session's address: the shared builder's gas limit
 * and maximum fee, the storage deposit a token transfer to a new holder sets aside, the nonce, what is left to spend,
 * and a token transfer's token balance. Nonce, outstanding and replace rules are a transfer's (transferSnapshot): one
 * nonce sequence covers every kind. A token transfer to a contract has no preview (assertPayableRecipient).
 * @param {CallRequest} request
 * @returns {Promise<CallPreview>}
 * @throws {WalletError} LOCKED, NETWORK, BALANCE_UNCONFIRMED, NONCE_UNAVAILABLE, INVALID_PARAMS, INVALID_AMOUNT,
 *   RECIPIENT_IS_CONTRACT, RECIPIENT_UNCHECKED; CoreError of the builder
 */
export async function prepareCall(request) {
  assertCall(request);
  const { qnetAddress: from } = await session.requireUnlocked();
  const snapshot = await baseWithRecipient(transferSnapshot(from), recipientOfCall(request, from));
  const tx = buildCall(request, from, snapshot.nextNonce);
  const token = request.kind === 'tokenTransfer' ? await tokenSide(request, from, snapshot) : null;
  return callPreviewOf(from, tx, snapshot, token);
}

// Whether `signed` (keys.signQnet*) is the reviewed transaction under this wallet's key, byte for byte.
async function signedAsBuilt(signed, tx, from) {
  try {
    return signed?.preimage === tx.preimage && signed.tx?.callData === tx.callData && signed.tx?.gasLimit === tx.gasLimit
      && core.qnetAddressFromPublicKey(signed.publicKey) === from
      && await core.verifyConsensusSignature(tx.preimage, core.bytesToHex(signed.signature), core.bytesToHex(signed.publicKey));
  } catch {
    return false;
  }
}

/**
 * Signs and submits a dApp's token transfer or contract call. The fee, the deposit and the nonce must be those the
 * approval showed (FEE_CHANGED, NONCE_CHANGED), and with oneInFlight the nonce the committed one + 1; the QNC balance
 * must cover fee and deposit, and a token transfer's token balance (tokenSide) its amount (INSUFFICIENT_FUNDS; NETWORK
 * or BALANCE_UNCONFIRMED when it cannot be had): the node's door checks neither, and a transfer skipped at
 * apply would hold its nonce. A token transfer's recipient must be no contract (assertPayableRecipient), which the
 * door does not check either. Signed with keys.signQnetTokenTransfer / signQnetContractCall, checked against the
 * shared builder's preimage, sent as core.contractCallRequestJson to /api/v1/contract/call, and kept like a transfer
 * (storeAndSubmit): pending, refused, replaced and resent by the same rules. Reports submitted, never succeeded: the
 * node records no outcome of a call.
 * @param {{request: CallRequest, expectedFeeNano: string, expectedDepositNano: string, expectedNonce?: string|null,
 *   oneInFlight?: boolean}} call
 * @returns {Promise<{txHash: string|null, status: 'submitted'|'unknown', nonce: string, from: string}>}
 * @throws {WalletError} LOCKED, SIGNING_DISABLED, FEE_CHANGED, NONCE_CHANGED, NONCE_UNAVAILABLE, BALANCE_UNCONFIRMED,
 *   INSUFFICIENT_FUNDS, TOO_MANY_PENDING, NODE_REJECTED, NETWORK, SIGNATURE_SELF_CHECK_FAILED, RECIPIENT_IS_CONTRACT,
 *   RECIPIENT_UNCHECKED
 */
export async function sendCall(call) {
  const { request, expectedFeeNano, expectedDepositNano, expectedNonce = null, oneInFlight = false } = call ?? {};
  assertCall(request);
  return serialized(async () => {
    const { qnetAddress: from } = await session.requireUnlocked();
    const snapshot = await baseWithRecipient(transferSnapshot(from), recipientOfCall(request, from));
    const tx = buildCall(request, from, snapshot.nextNonce);
    if (tx.maxFeeNano !== expectedFeeNano) throw new WalletError('FEE_CHANGED');
    checkNonce(snapshot, expectedNonce, oneInFlight);
    checkRoom(snapshot);
    const token = request.kind === 'tokenTransfer' ? await tokenSide(request, from, snapshot) : null;
    const depositNano = token?.depositNano ?? '0';
    if (depositNano !== expectedDepositNano) throw new WalletError('FEE_CHANGED');
    if (token !== null && token.tokenBalance === null) throw new WalletError(token.tokenProblem ?? 'BALANCE_UNCONFIRMED');
    if (token !== null && BigInt(token.tokenBalance) < BigInt(tx.amount)) throw new WalletError('INSUFFICIENT_FUNDS');
    if (BigInt(tx.maxFeeNano) + BigInt(depositNano) > snapshot.spendable) throw new WalletError('INSUFFICIENT_FUNDS');

    const signed = request.kind === 'tokenTransfer'
      ? await keys.signQnetTokenTransfer({ from, token: tx.contract, to: tx.to, amount: tx.amount, nonce: tx.nonce })
      : await keys.signQnetContractCall({
        from, contract: tx.contract, method: tx.method, args: tx.args, nonce: tx.nonce, gasLimit: tx.gasLimit,
      });
    if (!(await signedAsBuilt(signed, tx, from))) throw new WalletError('SIGNATURE_SELF_CHECK_FAILED');
    const body = core.contractCallRequestJson(tx, core.bytesToHex(signed.signature), core.bytesToHex(signed.publicKey));
    const record = pendingRecord({
      nonce: tx.nonce, to: tx.contract, amountNano: depositNano, feeNano: tx.maxFeeNano, body,
      call: { method: tx.method, recipient: token === null ? null : tx.to, amount: token === null ? null : tx.amount },
    });
    // a token recipient the user signed for becomes a known one (recipientCheck)
    return storeAndSubmit(from, snapshot, record, (state) => (token === null || tx.to === from ? state : vault.withRecipient(state, tx.to)));
  });
}

// The height two pinned nodes report alike for a stored transaction (GET /api/v1/transaction/{hash}), or null.
async function agreedBlockHeight(hash) {
  const heights = await Promise.all(shuffled(QNET.NODES).slice(0, MIN_NODE_AGREEMENT).map(async (node) => {
    try {
      const reply = await nodeRequest(`/api/v1/transaction/${hash}`, { nodes: [node] });
      const body = reply.status === 200 ? parseOrNull(reply.text) : null;
      const tx = isObject(body) && body.status === 'found' && isObject(body.transaction) ? body.transaction : null;
      return tx !== null && tx.hash === hash && tx.status === 'confirmed' ? safeIntOf(tx.block_height) : null;
    } catch {
      return null;
    }
  }));
  return heights[0] !== null && heights.every((height) => height === heights[0]) ? heights[0] : null;
}

/**
 * What the chain shows at (from, nonce) for this wallet's own `from`, by the pinned nodes' live word: null when no two of
 * them agree on the account's nonce and none was seen (chainNonceNow); {passed: false} while that nonce is below `nonce`;
 * else {passed: true, row, view}: the one transaction of `from` two pinned nodes list alike at it, or null, read with the
 * rows at every nonce the chain passed of the transactions the vault keeps (passedRows: the same requests), which a run of
 * resubmitPending decides by without reading them again.
 * @param {string} from
 * @param {string} nonce
 * @param {object} state the vault state
 * @returns {Promise<{passed: boolean, row?: object|null, view?: object}|null>}
 */
async function liveNonceState(from, nonce, state) {
  const chainNonce = await chainNonceNow(from);
  if (chainNonce === null) return null;
  if (BigInt(nonce) > chainNonce) return { passed: false };
  const view = await passedRows(from, state, chainNonce, [nonce]);
  return { passed: true, row: view.rows.get(nonce) ?? null, view };
}

/**
 * qnet_getTransactionStatus for the session's own account: what the chain shows at (from, nonce), a transaction's
 * identity, by the pinned nodes' live word (liveNonceState). 'pending': the account nonce two pinned nodes report is
 * below it and this wallet still sends a transaction there (pending or superseded; a refused one it no longer sends);
 * 'in_block': the nonce is used and at least two pinned nodes list the same one transaction of `from` at it, with the hash
 * they list and the block height two nodes report alike, when they do; 'unknown' in every other case: an account no two
 * nodes agree on, a nonce this wallet sent nothing at, a history the nodes do not serve (older than their newest 100
 * sends) or disagree on. In a block never means applied: the node keeps no outcome of a transfer skipped at apply or of a
 * call that trapped.
 * @param {{from: string, nonce: string}} query
 * @returns {Promise<{status: 'pending'|'in_block'|'unknown', from: string, nonce: string, txHash: string|null,
 *   blockHeight: number|null}>}
 * @throws {WalletError} LOCKED, UNAUTHORIZED (another account), INVALID_PARAMS
 */
export async function transactionStatus(query) {
  const { from, nonce } = query ?? {};
  if (!core.isValidQnetAddress(from) || u64Of(nonce) === null || nonce === '0') throw new WalletError('INVALID_PARAMS');
  const { qnetAddress } = await session.requireUnlocked();
  if (from !== qnetAddress) throw new WalletError('UNAUTHORIZED');
  const answer = (status, txHash = null, blockHeight = null) => ({ status, from, nonce, txHash, blockHeight });
  const state = await vault.readState();
  const at = await liveNonceState(from, nonce, state).catch(() => null);
  if (at === null) return answer('unknown');
  if (!at.passed) {
    const sent = state.pendingTransfers.some((p) => p.nonce === nonce && (p.outcome === 'pending' || p.outcome === 'superseded'));
    return answer(sent ? 'pending' : 'unknown');
  }
  if (at.row === null) return answer('unknown');
  return answer('in_block', at.row.hash, at.row.hash === null ? null : await agreedBlockHeight(at.row.hash));
}

/**
 * Handler of `qnet.sentStatus` (the popup's sent screen of a QNC or token transfer): where this wallet's transaction at
 * `nonce` stands by the pinned nodes' live word (liveNonceState). 'pending' while the nonce is free; 'in_block' once two
 * pinned nodes list at it the transaction this wallet kept there (rowIsTransfer; with no record left at the nonce,
 * resubmitPending already found it so); 'replaced' when they list another one; 'unknown' while no two of them agree. Once
 * decided, the pending list is decided from the same reads (resubmitPending), so History lists the transaction as
 * confirmed until the archive lists its row.
 * @param {{nonce: string}} params
 * @returns {Promise<{status: 'pending'|'in_block'|'replaced'|'unknown'}>}
 * @throws {WalletError} LOCKED, INVALID_PARAMS
 */
export async function sentStatus(params) {
  const nonce = params?.nonce;
  if (u64Of(nonce) === null || nonce === '0') throw new WalletError('INVALID_PARAMS');
  const { qnetAddress } = await session.requireUnlocked();
  const state = await vault.readState();
  const at = await liveNonceState(qnetAddress, nonce, state).catch(() => null);
  if (at === null || (at.passed && at.row === null)) return { status: 'unknown' };
  if (!at.passed) return { status: 'pending' };
  const kept = state.pendingTransfers.filter((p) => p.nonce === nonce);
  const status = kept.length === 0 || kept.some((p) => rowIsTransfer(at.row, p)) ? 'in_block' : 'replaced';
  background(resubmitWith(at.view).catch((error) => log.debug('resubmit', error?.code ?? error?.name)));
  return { status };
}

function amountNanoOf(amount) {
  const nano = parseUnits(amount, DECIMALS.QNC);
  if (nano <= 0n) throw new WalletError('INVALID_AMOUNT');
  return nano.toString();
}

/**
 * Handler of `qnet.preview` (popup review screen): parses the decimal QNC amount to nano, then
 * prepareTransfer, with the recipientCheck of `to` for the review's warnings.
 * @param {{to: string, amount: string, replaceNonce?: string}} params replaceNonce: review a transfer that
 *   replaces the outstanding one of that nonce
 * @returns {Promise<TransferPreview & {recipient: {known: boolean, lookalike: boolean, incomingOnly: boolean,
 *   historyRead: boolean}|null}>} recipient null when it could not be checked
 * @throws {WalletError} LOCKED, NETWORK, BALANCE_UNCONFIRMED, NONCE_UNAVAILABLE, NONCE_CHANGED, INVALID_AMOUNT,
 *   RECIPIENT_IS_CONTRACT (the review is never drawn: a contract keeps what reaches it for good), RECIPIENT_UNCHECKED
 */
export async function preview(params) {
  const amountNano = amountNanoOf(params.amount);
  const [prepared, recipient] = await Promise.all([
    prepareTransfer({ to: params.to, amountNano, replaceNonce: params.replaceNonce ?? null }),
    recipientCheck(params.to).catch((error) => {
      log.warn('recipient check failed', error?.code ?? error?.name);
      return null;
    }),
  ]);
  return { ...prepared, recipient };
}

/**
 * Handler of `qnet.send` (popup): parses the decimal QNC amount to nano, then sendTransfer with the fee
 * (and nonce, when given) the user reviewed, replacing the outstanding transfer of replaceNonce when given.
 * @param {{to: string, amount: string, expectedFeeNano: string, expectedNonce?: string, replaceNonce?: string}} params
 * @returns {Promise<{txHash: string|null, status: 'submitted'|'unknown', nonce: string}>}
 * @throws see sendTransfer
 */
export async function send(params) {
  return sendTransfer({
    to: params.to,
    amountNano: amountNanoOf(params.amount),
    expectedFeeNano: params.expectedFeeNano,
    expectedNonce: params.expectedNonce ?? null,
    replaceNonce: params.replaceNonce ?? null,
  });
}

// This wallet's applied sends as one pinned node's history lists them (newest SENT_HISTORY_PAGE), each with
// its nonce; null when that node's history could not be read.
async function sentRowsFrom(node, address) {
  let body = null;
  try {
    const reply = await nodeRequest(
      `/api/v1/transactions/history?address=${encodeURIComponent(address)}&direction=sent&per_page=${SENT_HISTORY_PAGE}`, { nodes: [node] });
    body = reply.status === 200 ? parseOrNull(reply.text) : null;
  } catch {
    body = null;
  }
  if (!isObject(body) || !Array.isArray(body.transactions)) return null;
  const me = lower(address);
  return body.transactions.filter((row) => isObject(row) && typeof row.from === 'string' && lower(row.from) === me
    && u64Of(row.nonce) !== null).map((row) => ({
    nonce: u64Of(row.nonce),
    type: typeof row.type === 'string' ? row.type : null,
    to: typeof row.to === 'string' ? row.to : null,
    amountNano: u64Of(row.amount),
    hash: typeof row.hash === 'string' && TX_HASH_RE.test(row.hash) ? row.hash : null,
  }));
}

const rowKey = (row) => JSON.stringify([row.type, row.to === null ? null : lower(row.to), row.amountNano]);

// The row at each of `nonces` that at least two pinned nodes list alike (R3-EXTQ-04: the verdict on a transfer needs
// two agreeing nodes; the history serves no proof): nonce → row, whose `hash` is the one those nodes list for it (null
// when they list different ones). A nonce without such a pair
// (no row, or rows that differ) is not in the map, and neither is one at which any answering node lists more than
// one transaction: a block may carry a transfer at a nonce already used, skipped at apply as a no-op, and the
// history does not say which of the rows at the nonce applied (R5-EXTQ-01).
async function agreedSentRows(address, nonces) {
  const answers = (await Promise.all(QNET.NODES.map((node) => sentRowsFrom(node, address)))).filter((rows) => rows !== null);
  const agreed = new Map();
  for (const nonce of nonces) {
    const counts = new Map();
    const listed = answers.map((rows) => rows.filter((r) => r.nonce === nonce));
    if (listed.some((atNonce) => new Set(atNonce.map(rowKey)).size > 1)) continue;
    for (const atNonce of listed) {
      const row = atNonce[0];
      if (!row) continue;
      const key = rowKey(row);
      const entry = counts.get(key) ?? { row, count: 0, hashes: new Set() };
      entry.count += 1;
      entry.hashes.add(row.hash);
      counts.set(key, entry);
    }
    const winners = [...counts.values()].filter((entry) => entry.count >= MIN_NODE_AGREEMENT);
    if (winners.length === 1) {
      const [winner] = winners;
      agreed.set(nonce, { ...winner.row, hash: winner.hashes.size === 1 ? [...winner.hashes][0] : null });
    }
  }
  return agreed;
}

// Whether an applied history row is this transaction: a plain transfer to its recipient of its amount, or a contract
// call (no QNC value) to its contract. A call's outcome is no part of the row: in a block is all it says.
const rowIsTransfer = (row, p) => (kindOf(p) === 'call'
  ? row.type === 'contract_call' && row.to !== null && lower(row.to) === lower(p.to) && row.amountNano === '0'
  : row.type === 'transfer' && row.to !== null && lower(row.to) === lower(p.to) && row.amountNano === p.amountNano);

// The kept transactions whose nonce the chain passed (`chainNonce`): those marked passed, and every one that may still
// apply at or below it. resubmitPending decides each by the row at its nonce.
const passedOf = (state, chainNonce) => state.pendingTransfers.filter((p) => p.outcome === 'passed'
  || (mayStillApply(p) && chainNonce !== null && BigInt(p.nonce) <= chainNonce));

// What a run of resubmitPending decides by: the account nonce the chain reached (`chainNonce`), and the row two pinned
// nodes list alike at each nonce it passed of the kept transactions (passedOf) and of `extra` (agreedSentRows: one request
// per node, whatever the number of nonces).
async function passedRows(address, state, chainNonce, extra = []) {
  const asked = [...new Set([...passedOf(state, chainNonce).map((p) => p.nonce), ...extra])];
  return { chainNonce, asked, rows: asked.length > 0 ? await agreedSentRows(address, asked) : new Map() };
}

/**
 * Resends every pending transfer's identical body (at most once per RESUBMIT_INTERVAL_MS each, once per
 * RESEND_ACCEPTED_MS when a node accepted it, and not once it is PENDING_TRANSFER_TTL_MS old: it is then stale,
 * still reserved and listed, never dropped unseen); a refused one is never resent, and decided like the others. A
 * transfer whose nonce the chain passed, by the pinned nodes' live word (chainNonceNow: the account nonce two of them
 * report alike), is decided by its own identity (R2-EXTQ-02, as mobile MOBNET-R1-03), from the row at that nonce that two
 * pinned nodes list alike (R3-EXTQ-04): this transfer (recipient and amount) → confirmed, with the hash they list: no
 * longer resent or reserved, listed until the archive lists its row (historyOf), CONFIRMED_KEEP_MS at most; another
 * transaction → replaced (it can never apply; listed REPLACED_KEEP_MS more). Without such a row (a node's short history
 * window, nodes that disagree, or a node listing two transactions at the nonce, of which the history cannot say which
 * applied: R5-EXTQ-01) it is marked passed: its nonce is used, it is no longer resent or reserved, and History says its
 * outcome is unknown until a later run decides it (listed REPLACED_KEEP_MS from when it was seen). The spend records up to
 * that nonce are marked settled (withSpends). The nodes are read before the send queue is entered (serialized), so a send
 * never waits behind these reads. Called after unlock, when History is read and when the sent screen finds its
 * transaction decided (sentStatus, with the rows it read).
 * @returns {Promise<{resubmitted: number, confirmed: number, replaced: number, passed: number}>}
 * @throws {WalletError} LOCKED
 */
export function resubmitPending() {
  return resubmitWith(null);
}

// resubmitPending, deciding by `view` (passedRows) when the caller read it, else by a read of its own.
async function resubmitWith(view) {
  const none = { resubmitted: 0, confirmed: 0, replaced: 0, passed: 0 };
  const { qnetAddress } = await session.requireUnlocked();
  const before = await vault.readState();
  if (before.pendingTransfers.length === 0) return none;
  const { chainNonce, asked, rows } = view ?? await passedRows(qnetAddress, before, await chainNonceNow(qnetAddress));
  return serialized(async () => {
    const state = await vault.readState();
    if (state.pendingTransfers.length === 0) return none;
    const now = Date.now();
    const open = state.pendingTransfers.filter((p) => mayStillApply(p) || p.outcome === 'passed');
    // a nonce whose rows were not read (passed after the read) is decided by the next run
    const passed = passedOf(state, chainNonce).filter((p) => asked.includes(p.nonce));
    // body → 'confirmed' | 'replaced' | 'passed' | 'pending' (a superseded transfer whose replacement is gone:
    // sent again, as the replace's refusal would have left it: R4-EXTQ-01)
    const verdicts = new Map();
    for (const p of passed) {
      const row = rows.get(p.nonce) ?? null;
      if (row !== null) verdicts.set(p.body, rowIsTransfer(row, p) ? 'confirmed' : 'replaced');
      else if (mayStillApply(p)) verdicts.set(p.body, 'passed');
    }
    for (const p of open) {
      if (p.outcome === 'superseded' && !passed.includes(p)
        && !state.pendingTransfers.some((q) => q.outcome === 'pending' && q.nonce === p.nonce)) verdicts.set(p.body, 'pending');
    }
    // a body a node accepted goes out again only every RESEND_ACCEPTED_MS: each POST may add another copy with
    // another hash (R5-EXTQ-03); a refused one never goes out again by itself (R5-EXTQ-02)
    const due = open.filter((p) => p.outcome === 'pending' && !passed.includes(p) && !isStale(p, now)
      && now - p.lastSubmitAt >= (p.txHash !== null ? RESEND_ACCEPTED_MS : RESUBMIT_INTERVAL_MS));
    const results = new Map();
    for (const p of due) {
      const outcome = await submit(p.body, routeOf(p)).catch(() => null);
      results.set(p.body, outcome?.txHash ?? null);
    }
    // a confirmed, replaced or passed transfer's lastSubmitAt is when it was seen so; a dropped one (no node can hold it,
    // its nonce still free) leaves the list REPLACED_KEEP_MS after it was dropped (owner, 06.10: a pending row resolves)
    const expired = (p) => verdicts.get(p.body) !== 'confirmed' && verdicts.get(p.body) !== 'replaced'
      && ((p.outcome === 'confirmed' && now - p.lastSubmitAt > CONFIRMED_KEEP_MS)
        || ((p.outcome === 'replaced' || p.outcome === 'passed') && now - p.lastSubmitAt > REPLACED_KEEP_MS)
        || (chainNonce !== null && isDropped(p, chainNonce, now) && now - mayLandUntil(p) > REPLACED_KEEP_MS));
    const unsettled = chainNonce !== null && (state.spends ?? []).some((r) => r.settledAt === null && BigInt(r.nonce) <= chainNonce);
    if (verdicts.size > 0 || results.size > 0 || unsettled || state.pendingTransfers.some(expired)) {
      await vault.updateState((current) => withSpends({
        ...current,
        pendingTransfers: current.pendingTransfers
          .filter((p) => !expired(p))
          .map((p) => {
            if (p.outcome === 'replaced' || p.outcome === 'confirmed') return p;
            const verdict = verdicts.get(p.body);
            if (verdict === 'confirmed') return { ...p, outcome: 'confirmed', txHash: rows.get(p.nonce).hash, lastSubmitAt: now };
            if (verdict === 'replaced') return { ...p, outcome: 'replaced', lastSubmitAt: now };
            if (verdict === 'passed') return { ...p, outcome: 'passed', lastSubmitAt: now };
            if (verdict === 'pending' && p.outcome === 'superseded') return { ...p, outcome: 'pending' };
            if (p.outcome === 'pending' && results.has(p.body)) return { ...p, lastSubmitAt: now, txHash: p.txHash ?? results.get(p.body) };
            return p;
          }),
      }, { settledThrough: chainNonce, now }));
    }
    const count = (verdict) => [...verdicts.values()].filter((v) => v === verdict).length;
    return { resubmitted: results.size, confirmed: count('confirmed'), replaced: count('replaced'), passed: count('passed') };
  });
}

// ---------------------------------------------------------------- follow and the Send tab's reads ahead

// The macroblock a follow tick walks to: the certified head, or the one before it when that is closer to what this wallet
// verified, so once caught up one parity is followed (one step per two macroblocks; a proof stands within
// PROOF_MAX_LAG_MACROBLOCKS of the head).
const followTarget = (head) => (core.stepsToVerify(head - 1) < core.stepsToVerify(head) ? head - 1 : head);

let following = null;

/**
 * One tick of the follow (the FOLLOW_ALARM, every FOLLOW_ALARM_MINUTES while the session is unlocked): the certified head,
 * the genesis capsule when the walk to it is long (refreshCapsule), then one walk call of at most FOLLOW_STEPS_PER_TICK
 * steps toward it (followTarget; both newest macroblocks for OWN_SEND_LATEST_MS after this wallet's own transaction, so
 * that send is checked once certified), and the anchors kept: the committee checks in the background (the balance's
 * verified mark, a recipient's certified leaf) then find the head verified. Ticks never overlap; a locked session ends
 * one at once.
 * @returns {Promise<{ok: true, head: number, verified: boolean}|{ok: false, reason: 'locked'|'no_head'}>}
 */
export function followTick() {
  following ??= followOnce().finally(() => {
    following = null;
  });
  return following;
}

async function followOnce() {
  let address;
  try {
    ({ qnetAddress: address } = await session.requireUnlocked());
  } catch {
    return { ok: false, reason: 'locked' };
  }
  await loadAnchors();
  const head = await certifiedHeadNow();
  if (head === null) return { ok: false, reason: 'no_head' };
  const state = await vault.readState().catch(() => null);
  if (state !== null) noteOwnSends(address, state);
  const both = Date.now() - (ownSendAt.get(address) ?? 0) < OWN_SEND_LATEST_MS;
  const floor = core.trustFloorIndex();
  const targets = (both ? [head, head - 1] : [followTarget(head)]).filter((index) => index >= floor);
  if (targets.some((index) => core.stepsToVerify(index) > CAPSULE_WALK_STEPS)) await refreshCapsule(head);
  for (const index of targets) {
    if (core.stepsToVerify(index) === 0) continue;
    await core.certifiedStateRootAt(index, () => shuffled(QNET.NODES), { ...walkHooks(), maxSteps: FOLLOW_STEPS_PER_TICK })
      .catch(() => null);
  }
  await persistAnchors();
  const verified = targets.filter((index) => core.stepsToVerify(index) === 0);
  return { ok: true, head, verified: verified.length === targets.length && targets.length > 0 };
}

/**
 * Starts the follow alarm (FOLLOW_ALARM, every FOLLOW_ALARM_MINUTES) when it is not running: sw.js on every unlock. It
 * runs while the session is unlocked, and only then.
 * @returns {Promise<void>}
 */
export async function startFollow() {
  const alarms = globalThis.chrome?.alarms;
  if (!alarms) return;
  try {
    if (!(await alarms.get(FOLLOW_ALARM))) await alarms.create(FOLLOW_ALARM, { periodInMinutes: FOLLOW_ALARM_MINUTES });
  } catch (error) {
    log.warn('follow alarm', error?.name);
  }
}

/**
 * Stops the follow alarm: sw.js on every lock.
 * @returns {Promise<void>}
 */
export async function stopFollow() {
  const alarms = globalThis.chrome?.alarms;
  if (!alarms) return;
  try {
    await alarms.clear(FOLLOW_ALARM);
  } catch (error) {
    log.warn('follow alarm', error?.name);
  }
}

/**
 * sw.js alarm listener: the FOLLOW_ALARM runs a follow tick (followTick), and stops itself when it finds the session
 * locked; any other alarm is not this module's.
 * @param {{name: string}} alarm
 * @returns {Promise<void>}
 */
export async function onAlarm(alarm) {
  if (alarm?.name !== FOLLOW_ALARM) return;
  const tick = await followTick();
  if (!tick.ok && tick.reason === 'locked') await stopFollow();
}

/**
 * Handler of `qnet.sendWarm` (the popup's Send tab): starts, without waiting for them, the reads a QNC review makes beside
 * its one live read, so they are done or under way when it asks. When the tab opens: the certified head (certifiedHeadNow,
 * kept a minute), which a recipient's certified leaf is judged by. With `to`, once an address is typed: that recipient's
 * certified account leaf (recipientKind, background only; the review's check joins it) and the archive page the recipient
 * warnings read (recipientPage). A read that fails here is made again by the review.
 * @param {{to?: string}} [params]
 * @returns {Promise<{started: true}>}
 * @throws {WalletError} LOCKED, INVALID_ADDRESS
 */
export async function sendWarm(params = {}) {
  const { qnetAddress } = await session.requireUnlocked();
  const to = params?.to ?? null;
  if (to !== null && !core.isValidQnetAddress(to)) throw new WalletError('INVALID_ADDRESS');
  background(loadAnchors().then(() => certifiedHeadNow()).catch((error) => log.debug('send read ahead', error?.code ?? error?.name)));
  if (to !== null && to !== qnetAddress) {
    recipientKind(to);
    background(recipientPage(qnetAddress).catch((error) => log.debug('recipient page read ahead', error?.code ?? error?.name)));
  }
  return { started: true };
}
