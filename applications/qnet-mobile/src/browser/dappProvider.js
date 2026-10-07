/**
 * The in-app browser's provider: the extension's dApp protocol (applications/qnet-wallet CONTRACTS.md
 * section 4) served by the app. Methods, parameters, results, error codes and events are the extension's; the
 * approvals are native sheets. No Solana signing and no node activation here: anything outside the allow-list is 4200.
 *
 * Every request carries the origin the WebView reported (services/bridge). Grants are per origin and sealed
 * under the vault's data key (browser/grants). One sheet at a time, at most 3 waiting per origin, and after a
 * rejection the origin waits 30 s (10 min after the third within 10 min) before it may ask again.
 *
 * A transaction (a QNC transfer, a built-in token transfer, a WASM contract call: browser/dappRequests) is one sheet
 * kind, 'send', whose details name the type. Its result is { status, from, nonce, txHash, ...what was asked }: the
 * transaction's identity is (from, nonce), and txHash is the hash one node gave its copy (another node's copy, with
 * another hash, may be the one that lands).
 *
 * deps: {
 *   now(): ms,
 *   state(binding?): { unlocked, interactive, accounts: {qnet, solana} | null, walletId } — `interactive` for the page
 *     `binding` came from (the browser tab that asked; without one, the tab in front),
 *   grants: { get(origin), put(origin, walletId), remove(origin) }  (async, need an unlocked wallet),
 *   feeNano(): transfer fee in nano QNC,
 *   signMessage(origin, message): { signature, publicKey, address } (hex, hex, EON),
 *   tokenInfo(contract): { standard, name, symbol, decimals } as the network reports it (no proof covers it), null
 *     when the contract is no token; throws when it cannot be read,
 *   contractKind(address): 'token' | 'contract' | 'none' as two genesis nodes agree (a built-in token, another
 *     contract, or nothing there); throws when it cannot be read. A contract call's target must be 'contract'; a
 *     transfer's or token transfer's recipient must be 'none' (MOB-BR-R3-01),
 *   prepareSend(details): { nonce, confirmed, balanceNano, verified, counterparties (the recipients this wallet signed
 *     transfers to), paid and senders (warnings only, from the cached history), pending, replaceNonce, replaceHash,
 *     recent } — `confirmed` the account nonce the chain confirms; `nonce` is null while this wallet has unconfirmed
 *     transactions (`pending`). A site's send signs only at `confirmed` + 1, as the extension's (one transaction in
 *     flight): while an earlier transaction holds that nonce the sheet waits for it, re-reading the preview every
 *     IN_FLIGHT_RECHECK_MS, and the user may only replace the one unconfirmed transaction at `confirmed` + 1
 *     (`replaceNonce`); nothing is ever sent in addition. `balanceNano` is the committee-certified balance less what
 *     this wallet's transactions settled since its checkpoint took, `spends` ([{ nonce, amount }]) what its unsettled
 *     ones may still take, `balanceProblem` why no balance could be read ('foreign', 'unconfirmed', 'unanswered'). A
 *     token transfer adds tokenBalanceBase, tokenSpends, tokenProblem, tokenVerified, depositNano and listed (in the
 *     user's token list),
 *   recheckSend(details): { balanceNano, tokenBalanceBase, depositNano, spends, tokenSpends, balanceProblem, tokenProblem }
 *     read again just before any send is signed (null where a balance cannot be read; every balance only as the
 *     committee certified it, less what this wallet's own transactions since took),
 *   send({ ...details, nonce, choice }): { txHash, status: 'submitted' | 'unknown', nonce, refusal, refusalFinal },
 *     signed only at the confirmed nonce + 1 (NONCE_CHANGED otherwise):
 *     `refusal` the text a node refused it with (null when none did), `refusalFinal` when every node it went to answered
 *     and waiting cannot change the refusal (the wallet never sends it again); throws code NONCE_CHANGED /
 *     PENDING_CHANGED / PENDING_CHOICE when the wallet's next nonce is no longer the one shown, PENDING_SETTLED when the
 *     transaction the user chose to replace went through meanwhile (nothing is sent),
 *   transactionStatus({ from, nonce }): { status: 'pending' | 'in_block' | 'unknown', blockHeight, txHash },
 *   isCurrent(binding): the page that asked is still the one on screen,
 *   emit(origin, event, data),
 *   onChange(view | null): the sheet to show,
 * }
 */
import { buildOffchainMessage, hasHiddenCharacter, utf8Bytes } from '../crypto/OffchainMessage';
import { buildContractCall, buildTokenTransfer } from '../crypto/TxBuilders';
import { destroysTokens, usesReservedName } from '../utils/tokenSafety';
import {
  parseSendParams, parseStatusParams, parseUnits, formatUnits, RequestError, UNSUPPORTED_PARAM, QNC_DECIMALS,
  TOKEN_DECIMALS_MAX,
} from './dappRequests';
import { UNSUPPORTED_PARAM_MESSAGE } from './providerScript';

export const CODES = Object.freeze({
  USER_REJECTED: 4001, UNAUTHORIZED: 4100, UNSUPPORTED: 4200, DISCONNECTED: 4900, INVALID: -32602, INTERNAL: -32603,
});
export const CHAIN = Object.freeze({ chainId: 'q1337', network: 'testnet' });
// SHEET_BUDGET_*: sheets one origin may have shown within SHEET_BUDGET_SHORT_MS / COOLDOWN_WINDOW_MS, however they
// ended, until an approval clears it (MB3-03). COOLDOWN_REJECTIONS rejections within COOLDOWN_WINDOW_MS hold the origin
// back COOLDOWN_LONG_MS; a single one holds it back COOLDOWN_MS, which is none: a person who declined once may ask again
// at once. The extension's approval budget and cooldown, number for number (R2-ERP-01, owner 28.09): 5 a minute, 20 in
// ten, 60 s after 5 rejections.
// STATUS_READS_PER_MINUTE: network reads qnet_getTransactionStatus may start for one origin a minute; an answer read
// less than STATUS_CACHE_MS ago is given again without a read.
export const LIMITS = Object.freeze({
  QUEUE_PER_ORIGIN: 3, QUEUE_TOTAL: 16, COOLDOWN_REJECTIONS: 5, COOLDOWN_ORIGINS_MAX: 64, SHEET_BUDGET_SHORT: 5, SHEET_BUDGET_LONG: 20,
  STATUS_READS_PER_MINUTE: 20, STATUS_CACHE_MAX: 64,
});
export const TIMINGS = Object.freeze({
  APPROVAL_TIMEOUT_MS: 600_000, COOLDOWN_MS: 0, COOLDOWN_LONG_MS: 60_000, COOLDOWN_WINDOW_MS: 600_000,
  SHEET_BUDGET_SHORT_MS: 60_000, STATUS_CACHE_MS: 3_000, IN_FLIGHT_RECHECK_MS: 4_000,
});
export const COOLDOWN_MESSAGE = 'Too many rejected requests from this site, try again later';
// How long a sheet stays on screen untouched before its confirm arms (browser/DappSheet); a send moves money, so it
// waits longer. The same times decide when a page that goes away under its sheet counts as a rejection (MB2-04).
export const ARM_MS = 1000;
export const SEND_ARM_MS = 1500;
export const armDelayFor = (kind) => (kind === 'send' ? SEND_ARM_MS : ARM_MS);
export const METHODS = Object.freeze([
  'qnet_requestAccounts', 'qnet_accounts', 'qnet_chainId', 'qnet_disconnect', 'qnet_signMessage', 'qnet_sendTransaction',
  'qnet_getTransactionStatus',
]);
export const TX_STATUSES = Object.freeze(['pending', 'in_block', 'unknown']);

// The app keeps a signed transfer as a JSON object (services/PendingTx), whose numbers are exact up to 2^53 - 1: a
// site's transfer and its fee stay within that (the extension takes the whole u64 range).
export const SAFE_AMOUNT_NANO = BigInt(Number.MAX_SAFE_INTEGER);

const DISCONNECT_DATA = Object.freeze({ code: 4900, message: 'Disconnected' });
const TX_HASH_RE = /^[0-9a-fA-F]{16,128}$/;
// Token names and symbols are the deployer's text: shown with their hidden characters replaced, and cut.
const TOKEN_SYMBOL_MAX = 32;
const TOKEN_NAME_MAX = 64;

export class ProviderError extends Error {
  constructor(code, message, reason = null) {
    super(message || String(code));
    this.name = 'ProviderError';
    this.code = code;
    if (reason) this.reason = reason;
  }
}

const err = (code, message) => new ProviderError(code, message);
// A parameter check that failed (browser/dappRequests): -32602, with the UNSUPPORTED_PARAM reason when it says so.
const refusal = (e) => new ProviderError(CODES.INVALID, undefined,
  e instanceof RequestError && e.reason === UNSUPPORTED_PARAM ? UNSUPPORTED_PARAM : null);

/** Text from a token's deployer as the sheet may show it: hidden characters replaced, at most `max` characters. */
export function visibleLabel(text, max) {
  const chars = Array.from(typeof text === 'string' ? text : '').slice(0, max);
  return chars.map((ch) => (hasHiddenCharacter(ch) ? '\uFFFD' : ch)).join('');
}

// Strict UTF-8: null for overlong forms, surrogates, code points above U+10FFFF and cut sequences.
function utf8Text(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i];
    const n = b < 0x80 ? 0 : b >= 0xc2 && b <= 0xdf ? 1 : b >= 0xe0 && b <= 0xef ? 2 : b >= 0xf0 && b <= 0xf4 ? 3 : -1;
    if (n < 0 || i + n > bytes.length - 1) return null;
    let cp = n === 0 ? b : b & (0x3f >> n);
    for (let k = 1; k <= n; k++) {
      const c = bytes[i + k];
      if ((c & 0xc0) !== 0x80) return null;
      cp = (cp << 6) | (c & 0x3f);
    }
    if ((n === 2 && (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff))) || (n === 3 && (cp < 0x10000 || cp > 0x10ffff))) return null;
    out += String.fromCodePoint(cp);
    i += n + 1;
  }
  return out;
}

/** What the sheet shows of a call's input: its size, and the text it spells when that is visible UTF-8, else null. */
export function describeCallArgs(hex) {
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  const text = bytes.length > 0 ? utf8Text(bytes) : null;
  return { byteLength: bytes.length, text: text !== null && !hasHiddenCharacter(text) ? text : null };
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

/** undefined, null, [] or {} — the only params the methods without arguments accept. */
export function isEmptyParams(params) {
  if (params === undefined || params === null) return true;
  if (Array.isArray(params)) return params.length === 0;
  return isPlainObject(params) && Object.keys(params).length === 0;
}

/** A canonical decimal QNC amount ("1.5", at most 9 decimals) as nano QNC (BigInt), or null: the extension's rule. */
export const parseQncAmount = (text) => parseUnits(text, QNC_DECIMALS);

/**
 * The error the page receives: { code, message } with the extension's texts; a parameter the network does not accept
 * adds data { reason: 'UNSUPPORTED_PARAM' }.
 */
export function pageError(error) {
  const code = error && Object.values(CODES).includes(error.code) ? error.code : CODES.INTERNAL;
  if (code === CODES.USER_REJECTED && error.message === COOLDOWN_MESSAGE) return { code, message: COOLDOWN_MESSAGE };
  if (code === CODES.INVALID && error.reason === UNSUPPORTED_PARAM) {
    return { code, message: UNSUPPORTED_PARAM_MESSAGE, data: { reason: UNSUPPORTED_PARAM } };
  }
  const text = {
    4001: 'User rejected the request', 4100: 'Unauthorized', 4200: 'Unsupported method', 4900: 'Disconnected',
    [-32602]: 'Invalid params', [-32603]: 'Internal error',
  }[code];
  return { code, message: text };
}

let nextId = 1;

const decimal = (v) => /^\d+$/.test(String(v));

// What `spends` ([{ nonce, amount }]) take of `balance`, the nonce a 'replace' signs over excepted.
function leftAfter(balance, spends, replaced) {
  let left = BigInt(balance);
  for (const e of spends) if (e && e.nonce !== replaced && decimal(e.amount)) left -= BigInt(e.amount);
  return left > 0n ? left : 0n;
}

/**
 * The QNC a send can still spend (nano, BigInt), the extension's spendable balance: the balance the preview read less
 * what the wallet's unconfirmed transactions may still take, the one a 'replace' `pick` signs over excepted (at most
 * one of the two can apply). That is `spends`, the most each can take as kept when it was signed (the amount and most
 * fee of a transfer, the most fee and a new holder's deposit of a call, MOB-BR-R3-02); a preview without it counts
 * `pending` (a transfer's amount and `transferFeeNano`, a call's `reserveNano`). null when no balance was read.
 */
export function spendableNano(p, pick = null) {
  if (!p || !decimal(p.balanceNano)) return null;
  const replaced = pick === 'replace' ? p.replaceNonce : null;
  if (Array.isArray(p.spends)) return leftAfter(p.balanceNano, p.spends, replaced);
  const fee = decimal(p.transferFeeNano) ? BigInt(p.transferFeeNano) : 0n;
  let reserved = 0n;
  for (const e of Array.isArray(p.pending) ? p.pending : []) {
    if (!e || e.nonce === replaced) continue;
    if (e.reserveNano !== null && e.reserveNano !== undefined && decimal(e.reserveNano)) reserved += BigInt(e.reserveNano);
    else if (e.kind === 'transfer' && decimal(e.amountNano)) reserved += BigInt(e.amountNano) + fee;
  }
  const balance = BigInt(p.balanceNano);
  return balance > reserved ? balance - reserved : 0n;
}

/** The tokens a token transfer can still move (base units, BigInt): the token balance less `tokenSpends`; null unread. */
export function spendableTokenBase(p, pick = null) {
  if (!p || !decimal(p.tokenBalanceBase)) return null;
  const replaced = pick === 'replace' ? p.replaceNonce : null;
  return leftAfter(p.tokenBalanceBase, Array.isArray(p.tokenSpends) ? p.tokenSpends : [], replaced);
}

/**
 * Whether the preview could not read a balance the send `d` is checked against: the QNC balance for every send, and the
 * token balance for a token transfer, each only as the committee certified it (verified through the light client).
 * Such a send is never offered or signed (the extension's NETWORK).
 */
export function previewUnread(d, p) {
  if (!d || !p) return false;
  return !decimal(p.balanceNano) || (d.type === 'tokenTransfer' && !decimal(p.tokenBalanceBase));
}

/**
 * Whether the preview shows the wallet cannot pay for the send `d` with the choice `pick` about its unconfirmed
 * transactions, or could not read what it is checked against (previewUnread): a QNC transfer's amount and fee, a token
 * transfer's tokens and its fee and deposit, a call's fee, each against the spendable QNC (spendableNano). The same rule
 * for the sheet (browser/DappSheet) and for the approval: a send the chain would refuse for its balance is never signed
 * and kept, where it would hold the wallet's nonce and could go out after a later top-up (the extension's
 * INSUFFICIENT_FUNDS; the app's Send form, MOBNET-R3-04).
 */
export function previewShort(d, p, pick = null) {
  if (!d || !p) return false;
  if (previewUnread(d, p)) return true;
  const spendable = spendableNano(p, pick);
  const below = (need) => spendable < BigInt(need);
  if (d.type === 'tokenTransfer') {
    const deposit = decimal(p.depositNano) ? BigInt(p.depositNano) : 0n;
    return spendableTokenBase(p, pick) < BigInt(d.amountBase) || below(BigInt(d.feeNano) + deposit);
  }
  if (d.type === 'contractCall') return below(d.feeNano);
  return below(BigInt(d.amountNano) + BigInt(d.feeNano));
}

// What a send's balances read again just before signing say against the preview on screen: null (sign), or why not:
// 'unreadable' (a balance could not be read), 'changed' (a token transfer's deposit changed, so the total shown is not
// the total any more) or 'short' (too little of the token or of QNC now).
function recheckProblem(d, preview, fresh, pick) {
  if (!fresh || typeof fresh !== 'object') return 'unreadable';
  if (!decimal(fresh.balanceNano) || (d.type === 'tokenTransfer' && !decimal(fresh.tokenBalanceBase))) return 'unreadable';
  if (d.type === 'tokenTransfer' && String(fresh.depositNano) !== String(preview.depositNano)) return 'changed';
  return previewShort(d, { ...preview, ...fresh }, pick) ? 'short' : null;
}

export function createDappProvider(deps) {
  const queue = [];
  let slot = null;
  const cooldowns = new Map(); // origin → { rejections: ms[], until }
  const granted = new Set(); // origins seen granted while unlocked (for the lock event)
  const statusReads = new Map(); // origin → ms[] of the status reads it started
  const statusAnswers = new Map(); // origin|from|nonce → { at, answer (a promise) }

  const now = () => deps.now();

  // ── cooldown ──
  function inCooldown(origin) {
    const c = cooldowns.get(origin);
    return !!c && c.until > now();
  }

  // Sheets this origin has had on screen within `ms` (MB3-03).
  function sheetsWithin(origin, ms) {
    const c = cooldowns.get(origin);
    const t = now();
    return c && Array.isArray(c.sheets) ? c.sheets.filter((at) => at <= t && t - at < ms).length : 0;
  }

  // Every sheet counts against its origin's budget from the moment it is shown, however it ends, until an approval
  // clears it: a page cannot raise sheets back to back by ending each before its confirm arms (MB3-03).
  function budgetSpent(origin) {
    return sheetsWithin(origin, TIMINGS.SHEET_BUDGET_SHORT_MS) >= LIMITS.SHEET_BUDGET_SHORT
      || sheetsWithin(origin, TIMINGS.COOLDOWN_WINDOW_MS) >= LIMITS.SHEET_BUDGET_LONG;
  }

  function entryOf(origin) {
    const c = cooldowns.get(origin) || { rejections: [], until: 0, sheets: [] };
    if (!Array.isArray(c.sheets)) c.sheets = [];
    cooldowns.delete(origin);
    cooldowns.set(origin, c);
    while (cooldowns.size > LIMITS.COOLDOWN_ORIGINS_MAX) cooldowns.delete(cooldowns.keys().next().value);
    return c;
  }

  function recordSheet(origin) {
    const t = now();
    const c = entryOf(origin);
    c.sheets = [...c.sheets.filter((at) => at <= t && t - at < TIMINGS.COOLDOWN_WINDOW_MS), t].slice(-LIMITS.SHEET_BUDGET_LONG);
  }

  function recordRejection(origin) {
    const t = now();
    const c = entryOf(origin);
    c.rejections = [...c.rejections.filter((r) => t - r < TIMINGS.COOLDOWN_WINDOW_MS), t].slice(-LIMITS.COOLDOWN_REJECTIONS);
    const long = c.rejections.length >= LIMITS.COOLDOWN_REJECTIONS;
    c.until = Math.max(c.until, t + (long ? TIMINGS.COOLDOWN_LONG_MS : TIMINGS.COOLDOWN_MS));
    // Only a cooldown that is really on ends the origin's other approvals: a single rejection holds nothing back, so
    // its other requests keep their turn.
    if (c.until <= t) return;
    for (const a of [...queue]) {
      if (a.origin === origin && !a.busy) settle(a, err(CODES.USER_REJECTED, COOLDOWN_MESSAGE));
    }
  }

  const clearCooldown = (origin) => cooldowns.delete(origin);

  // ── the sheet queue ──
  function view(a) {
    if (!a) return null;
    return Object.freeze({
      id: a.id, kind: a.kind, origin: a.origin, createdAt: a.createdAt, busy: a.busy, queued: queue.length - 1,
      details: { ...a.payload }, preview: a.preview, previewError: a.previewError || null, outcome: a.outcome,
      notice: a.notice || null,
    });
  }

  const changed = () => deps.onChange(view(slot));

  function pump() {
    while (slot === null) {
      const next = queue.find((a) => !a.settled) || null;
      if (!next) break;
      // An approval that waited while its origin spent its sheet budget shows none (MB3-03).
      if (budgetSpent(next.origin)) {
        next.settled = true;
        const i = queue.indexOf(next);
        if (i >= 0) queue.splice(i, 1);
        next.reject(err(CODES.USER_REJECTED, COOLDOWN_MESSAGE));
        continue;
      }
      slot = next;
      next.shownAt = now();
      recordSheet(next.origin);
      next.timer = setTimeout(() => expire(next), TIMINGS.APPROVAL_TIMEOUT_MS);
    }
    changed();
  }

  // The approval's time ran out: it ends as rejected, unless an approved action is running (signing, sending), which
  // settles it with its own result (the extension's expire). One that goes back to the sheet afterwards without being
  // settled (a review, a refusal that signed nothing) ends then (timedOut).
  function expire(a) {
    if (!a || a.settled) return;
    if (a.busy) {
      a.timedOut = true;
      return;
    }
    settle(a, err(CODES.USER_REJECTED));
  }

  // Ends an approval for the page (error or result). `hold` keeps the sheet on its outcome until dismissed.
  function settle(a, error, result, { hold = false } = {}) {
    if (!a || a.settled) return false;
    a.settled = true;
    clearTimeout(a.timer);
    clearTimeout(a.previewTimer);
    const i = queue.indexOf(a);
    if (i >= 0) queue.splice(i, 1);
    if (error) a.reject(error);
    else a.resolve(result);
    if (slot === a && !hold) slot = null;
    pump();
    return true;
  }

  // Whether `ctx` may get a sheet now; throws the page's error when not.
  function admit(ctx) {
    const s = deps.state(ctx.binding);
    if (!s.unlocked) throw err(CODES.UNAUTHORIZED);
    // A page the user is not looking at (a browser tab not in front, another wallet tab, the app in the background) gets
    // no sheet.
    if (!s.interactive) throw err(CODES.USER_REJECTED);
    if (inCooldown(ctx.origin) || budgetSpent(ctx.origin)) throw err(CODES.USER_REJECTED, COOLDOWN_MESSAGE);
    const sameOrigin = queue.filter((a) => a.origin === ctx.origin).length;
    if (sameOrigin >= LIMITS.QUEUE_PER_ORIGIN || queue.length >= LIMITS.QUEUE_TOTAL) throw err(CODES.USER_REJECTED);
  }

  function enqueue(ctx, kind, payload) {
    admit(ctx);
    // A request whose page went away while it was being read (a grant, a token, the target of a call) gets no sheet over
    // the page now on screen: it ends as rejected, and counts against its origin's budget as a sheet would (MB-06; the
    // extension closes such a late window at once).
    if (ctx.binding !== undefined && !deps.isCurrent(ctx.binding)) {
      recordSheet(ctx.origin);
      throw err(CODES.USER_REJECTED);
    }
    return new Promise((resolve, reject) => {
      queue.push({
        id: `a${nextId++}`, kind, origin: ctx.origin, binding: ctx.binding, payload, createdAt: now(),
        settled: false, busy: false, preview: null, outcome: null, timer: null, previewTimer: null, resolve, reject,
      });
      pump();
    });
  }

  // ── grants ──
  async function grantOf(origin) {
    const s = deps.state();
    if (!s.unlocked || !s.accounts) return null;
    let g = null;
    try {
      g = await deps.grants.get(origin);
    } catch (_) {
      return null;
    }
    if (!g || g.walletId !== s.walletId) return null;
    granted.add(origin);
    return g;
  }

  async function accountsFor(origin) {
    const s = deps.state();
    if (!s.unlocked || !s.accounts) return null;
    return (await grantOf(origin)) ? { qnet: s.accounts.qnet, solana: s.accounts.solana } : null;
  }

  async function disconnect(origin) {
    try { await deps.grants.remove(origin); } catch (_) { /* nothing stored, or locked */ }
    granted.delete(origin);
    for (const a of [...queue]) {
      if (a.origin === origin && (a.kind === 'sign' || a.kind === 'send') && !a.busy) settle(a, err(CODES.UNAUTHORIZED));
    }
    deps.emit(origin, 'accountsChanged', {});
    deps.emit(origin, 'disconnect', DISCONNECT_DATA);
  }

  // ── requests ──
  async function requestSignature(ctx, params) {
    if (!isPlainObject(params) || Object.keys(params).some((k) => k !== 'message')) throw err(CODES.INVALID);
    const { message } = params;
    try {
      buildOffchainMessage(ctx.origin, message);
    } catch (_) {
      throw err(CODES.INVALID); // before any sheet: protocol prefixes, hidden controls, empty, > 4 KiB
    }
    if (!(await grantOf(ctx.origin))) throw err(CODES.UNAUTHORIZED);
    return enqueue(ctx, 'sign', { message, byteLength: utf8Bytes(message).length });
  }

  // A token transfer's sheet details: the token read from the chain (a built-in fungible token), the amount scaled by
  // its decimals, and the gas and fee of the call it becomes (crypto/TxBuilders; neither depends on the nonce).
  async function tokenDetails(req, from) {
    let info;
    try {
      info = await deps.tokenInfo(req.token);
    } catch (_) {
      throw err(CODES.INTERNAL);
    }
    if (!info || info.standard !== 'qrc20' || !Number.isInteger(info.decimals) || info.decimals > TOKEN_DECIMALS_MAX) {
      throw err(CODES.INVALID);
    }
    const amountBase = parseUnits(req.amount, info.decimals);
    if (amountBase === null || amountBase <= 0n) throw err(CODES.INVALID);
    let tx;
    try {
      tx = buildTokenTransfer({ from, token: req.token, to: req.to, amount: amountBase, nonce: 1 });
    } catch (_) {
      throw err(CODES.INVALID);
    }
    const symbol = visibleLabel(info.symbol, TOKEN_SYMBOL_MAX);
    const name = visibleLabel(info.name, TOKEN_NAME_MAX);
    return {
      type: 'tokenTransfer', token: req.token, to: req.to, amount: formatUnits(amountBase, info.decimals),
      amountBase: amountBase.toString(), symbol, name, decimals: info.decimals, gasLimit: tx.gasLimit, feeNano: tx.maxFeeNano,
      destroys: destroysTokens(req.to), reservedName: usesReservedName(info.symbol, info.name),
    };
  }

  // A contract call's sheet details: its gas limit (the site's, or the intrinsic gas plus the default fuel) and its most
  // fee, checked by crypto/TxBuilders as the call is signed later.
  function callDetails(req, from) {
    let tx;
    try {
      tx = buildContractCall({
        from, contract: req.contract, method: req.method, args: req.args, nonce: 1, gasLimit: req.gasLimit,
      });
    } catch (_) {
      throw err(CODES.INVALID);
    }
    const input = describeCallArgs(tx.args);
    return {
      type: 'contractCall', contract: req.contract, method: req.method, args: tx.args, argsBytes: input.byteLength,
      argsText: input.text, gasLimit: tx.gasLimit, feeNano: tx.maxFeeNano, totalNano: tx.maxFeeNano,
    };
  }

  // What a transfer's or token transfer's recipient is (contractKind), 'none' for the wallet's own address, or null when
  // no two genesis nodes agree.
  async function recipientKind(to, own) {
    if (to === own) return 'none';
    try {
      return await deps.contractKind(to);
    } catch (_) {
      return null;
    }
  }

  // The extension's assertPayableRecipient, before any sheet (MOB-BR-R3-01): a contract account (a built-in token, the
  // token being sent included, or another contract) has no key and no contract sends QNC or a token on, so what it is
  // paid stays there for good: -32602. A recipient no two genesis nodes agree on is not paid either: -32603.
  async function assertPayable(to, own) {
    const kind = await recipientKind(to, own);
    if (kind === null) throw err(CODES.INTERNAL);
    if (kind !== 'none') throw err(CODES.INVALID);
  }

  async function requestTransaction(ctx, params) {
    let req;
    try {
      req = parseSendParams(params);
    } catch (e) {
      throw refusal(e);
    }
    if (req.type === 'transfer') {
      const feeNano = BigInt(deps.feeNano());
      if (req.amountNano + feeNano > SAFE_AMOUNT_NANO) throw err(CODES.INVALID);
      const granted = await grantOf(ctx.origin);
      const own = deps.state().accounts;
      if (!granted || !own) throw err(CODES.UNAUTHORIZED);
      admit(ctx); // before the network is read
      await assertPayable(req.to, own.qnet);
      // QNC sent to the chain's canonical burn address is gone for good: the sheet says so, as for a token (destroys).
      return enqueue(ctx, 'send', {
        type: 'transfer', to: req.to, amountNano: req.amountNano.toString(), feeNano: feeNano.toString(),
        totalNano: (req.amountNano + feeNano).toString(), destroys: destroysTokens(req.to),
      });
    }
    const grant = await grantOf(ctx.origin);
    const s = deps.state();
    if (!grant || !s.accounts) throw err(CODES.UNAUTHORIZED);
    admit(ctx); // before the network is read
    if (req.type === 'contractCall') {
      const details = callDetails(req, s.accounts.qnet);
      // The extension's rule: a call goes only to a contract that is no built-in token (a token cannot run a call's
      // input, and nothing is there at a plain account); such a call would be skipped at apply and hold the wallet's
      // nonce (MB-02).
      let kind;
      try {
        kind = await deps.contractKind(req.contract);
      } catch (_) {
        throw err(CODES.INTERNAL);
      }
      if (kind !== 'contract') throw err(CODES.INVALID);
      return enqueue(ctx, 'send', details);
    }
    const details = await tokenDetails(req, s.accounts.qnet);
    await assertPayable(req.to, s.accounts.qnet);
    return enqueue(ctx, 'send', details);
  }

  const statusAnswer = (a) => {
    const status = a && TX_STATUSES.includes(a.status) ? a.status : 'unknown';
    const inBlock = status === 'in_block';
    return {
      status,
      blockHeight: inBlock && Number.isSafeInteger(a.blockHeight) && a.blockHeight >= 0 ? a.blockHeight : null,
      txHash: inBlock && typeof a.txHash === 'string' && TX_HASH_RE.test(a.txHash) ? a.txHash : null,
    };
  };

  // qnet_getTransactionStatus: no sheet; the connected account only; an answer is reused for STATUS_CACHE_MS and one
  // origin starts at most STATUS_READS_PER_MINUTE reads a minute.
  async function transactionStatus(ctx, params) {
    let req;
    try {
      req = parseStatusParams(params);
    } catch (e) {
      throw refusal(e);
    }
    const accounts = await accountsFor(ctx.origin);
    if (!accounts || accounts.qnet !== req.from) throw err(CODES.UNAUTHORIZED);
    const key = `${ctx.origin}|${req.from}|${req.nonce}`;
    const t = now();
    const kept = statusAnswers.get(key);
    if (kept && t - kept.at < TIMINGS.STATUS_CACHE_MS) return kept.answer;
    const reads = (statusReads.get(ctx.origin) || []).filter((at) => at <= t && t - at < 60_000);
    if (reads.length >= LIMITS.STATUS_READS_PER_MINUTE) throw err(CODES.USER_REJECTED);
    statusReads.delete(ctx.origin);
    statusReads.set(ctx.origin, [...reads, t]);
    while (statusReads.size > LIMITS.COOLDOWN_ORIGINS_MAX) statusReads.delete(statusReads.keys().next().value);
    const answer = Promise.resolve()
      .then(() => deps.transactionStatus({ from: req.from, nonce: req.nonce }))
      .then(statusAnswer, () => statusAnswer(null));
    statusAnswers.delete(key);
    statusAnswers.set(key, { at: t, answer });
    while (statusAnswers.size > LIMITS.STATUS_CACHE_MAX) statusAnswers.delete(statusAnswers.keys().next().value);
    return answer;
  }

  /** One request from the page. Resolves with the result or rejects with a ProviderError. */
  async function request(ctx, method, params) {
    if (!METHODS.includes(method)) throw err(CODES.UNSUPPORTED);
    switch (method) {
      case 'qnet_chainId':
        if (!isEmptyParams(params)) throw err(CODES.INVALID);
        return { ...CHAIN };
      case 'qnet_accounts':
        if (!isEmptyParams(params)) throw err(CODES.INVALID);
        return (await accountsFor(ctx.origin)) || {};
      case 'qnet_requestAccounts': {
        if (!isEmptyParams(params)) throw err(CODES.INVALID);
        const accounts = await accountsFor(ctx.origin);
        return accounts || enqueue(ctx, 'connect', {});
      }
      case 'qnet_disconnect':
        if (!isEmptyParams(params)) throw err(CODES.INVALID);
        await disconnect(ctx.origin);
        return true;
      case 'qnet_signMessage':
        return requestSignature(ctx, params);
      case 'qnet_sendTransaction':
        return requestTransaction(ctx, params);
      case 'qnet_getTransactionStatus':
        return transactionStatus(ctx, params);
      default:
        throw err(CODES.UNSUPPORTED);
    }
  }

  // ── the sheet's actions ──
  function current(id) {
    return slot && slot.id === id && !slot.settled ? slot : null;
  }

  // What unsettled transactions may still take, as the preview keeps it; why a balance went unread.
  function spendsOf(list) {
    return Object.freeze((Array.isArray(list) ? list.slice(0, 64) : [])
      .filter((e) => e && Number.isSafeInteger(e.nonce) && decimal(e.amount))
      .map((e) => Object.freeze({ nonce: e.nonce, amount: String(e.amount) })));
  }
  const problemOf = (v) => (v === 'foreign' || v === 'unconfirmed' || v === 'unanswered' ? v : null);

  // What a token transfer's or a call's preview adds, as the sheet may show it.
  function typePreview(type, p) {
    const digits = (v) => (/^\d+$/.test(String(v)) ? String(v) : null);
    if (type === 'tokenTransfer') {
      return {
        tokenBalanceBase: digits(p.tokenBalanceBase), tokenVerified: p.tokenVerified === true,
        tokenSpends: spendsOf(p.tokenSpends), tokenProblem: problemOf(p.tokenProblem),
        depositNano: digits(p.depositNano), listed: p.listed === true,
      };
    }
    return {};
  }

  /** Reads the transaction preview (nonce, balances, recipients) for the sheet on screen. */
  async function loadPreview(id) {
    const a = current(id);
    if (!a || a.kind !== 'send' || a.busy) return;
    try {
      const p = await deps.prepareSend({ ...a.payload });
      if (current(id) !== a) return;
      const nonceOrNull = (n) => (Number.isSafeInteger(n) && n > 0 ? n : null);
      const summaries = (list, keys) => (Array.isArray(list) ? list.slice(0, 16) : []).filter((e) => e && typeof e === 'object')
        .map((e) => Object.freeze(Object.fromEntries(keys.map((k) => [k, e[k] === undefined ? null : e[k]]))));
      const pending = summaries(p.pending, ['nonce', 'state', 'kind', 'to', 'amountNano', 'method', 'reserveNano', 'ageMs']);
      const confirmed = Number.isSafeInteger(p.confirmed) && p.confirmed >= 0 ? p.confirmed : null;
      // A site's send signs only at the confirmed nonce + 1 (the extension's one transaction in flight): it may take the
      // place of the one unconfirmed transaction there, never go in addition to it or replace one above it.
      const replaceNonce = pending.length && confirmed !== null && nonceOrNull(p.replaceNonce) === confirmed + 1
        ? confirmed + 1 : null;
      a.preview = Object.freeze({
        nonce: pending.length ? null : nonceOrNull(p.nonce),
        confirmed,
        balanceNano: /^\d+$/.test(String(p.balanceNano)) ? String(p.balanceNano) : null,
        verified: p.verified === true,
        counterparties: Array.isArray(p.counterparties) ? p.counterparties.slice(0, 200) : [],
        paid: Array.isArray(p.paid) ? p.paid.slice(0, 500) : [],
        senders: Array.isArray(p.senders) ? p.senders.slice(0, 500) : [],
        pending: Object.freeze(pending),
        replaceNonce,
        replaceHash: replaceNonce !== null && typeof p.replaceHash === 'string' ? p.replaceHash : null,
        appendNonce: null,
        // An earlier transaction holds the nonce this send would need, and none can be replaced: Confirm stays off.
        inFlight: pending.length > 0 && replaceNonce === null,
        recent: Object.freeze(summaries(p.recent, ['nonce', 'kind', 'to', 'amountNano', 'settledAt'])),
        // What each unconfirmed transaction may still take (spendableNano), and why no balance could be read.
        transferFeeNano: String(deps.feeNano()),
        spends: spendsOf(p.spends),
        balanceProblem: problemOf(p.balanceProblem),
        ...typePreview(a.payload.type, p),
      });
      a.previewError = null;
      // While an earlier transaction is unconfirmed the preview is read again every few seconds, so the sheet offers the
      // send as soon as that one is in a block (the extension's schedulePreviewRetry).
      if (pending.length > 0) recheckLater(id, a);
    } catch (e) {
      if (current(id) !== a) return;
      a.preview = null;
      a.previewError = (e && e.code) || 'UNAVAILABLE';
    }
    changed();
  }

  // The next read of `a`'s preview, IN_FLIGHT_RECHECK_MS from now; an approval running at that time waits for the next.
  function recheckLater(id, a) {
    clearTimeout(a.previewTimer);
    a.previewTimer = setTimeout(() => {
      if (current(id) !== a) return;
      if (a.busy) recheckLater(id, a);
      else loadPreview(id);
    }, TIMINGS.IN_FLIGHT_RECHECK_MS);
  }

  /** The user rejected (or closed) the sheet. */
  function reject(id) {
    const a = current(id);
    if (!a || a.busy) return false;
    settle(a, err(CODES.USER_REJECTED));
    recordRejection(a.origin);
    return true;
  }

  // The page's result, the extension's shape: { status, from, ...what was asked, nonce, txHash }, nonce as decimal text.
  function sendResult(d, from, sent, signedNonce) {
    const txHash = sent && typeof sent.txHash === 'string' && TX_HASH_RE.test(sent.txHash) ? sent.txHash : null;
    const status = sent && sent.status === 'submitted' && txHash ? 'submitted' : 'unknown';
    const nonce = String(sent && Number.isSafeInteger(sent.nonce) && sent.nonce > 0 ? sent.nonce : signedNonce);
    if (d.type === 'tokenTransfer') return { status, from, token: d.token, to: d.to, amount: d.amount, nonce, txHash };
    if (d.type === 'contractCall') return { status, from, contract: d.contract, method: d.method, nonce, txHash };
    return { status, from, to: d.to, amount: formatUnits(BigInt(d.amountNano), QNC_DECIMALS), nonce, txHash };
  }

  /**
   * The nonce and wallet choice a send signs with, from the preview on screen and what the user picked about the
   * wallet's unconfirmed transactions ('replace'); null when the sheet has nothing valid to send yet. A site's send signs
   * only at the confirmed nonce + 1: with nothing unconfirmed, or in place of the one unconfirmed transaction there.
   * Nothing goes in addition to an earlier transaction, whatever `pick` says (the extension's one transaction in flight).
   */
  function sendPlan(preview, pick) {
    if (!preview) return null;
    if (!preview.pending || preview.pending.length === 0) {
      return preview.nonce === null ? null : { nonce: preview.nonce, choice: null };
    }
    const atNext = preview.replaceNonce !== null && Number.isSafeInteger(preview.confirmed)
      && preview.replaceNonce === preview.confirmed + 1;
    if (pick === 'replace' && atNext) {
      return { nonce: preview.replaceNonce, choice: { mode: 'replace', nonce: preview.replaceNonce, bodyHash: preview.replaceHash } };
    }
    return null;
  }

  /**
   * The user confirmed and passed the password / device authentication. Performs exactly what the sheet showed.
   * `pick` is what the user chose about this wallet's unconfirmed transactions (a send while there are any).
   * { status: 'done', result } | { status: 'review' } (the nonce moved: the sheet shows the new preview) |
   * { status: 'failed', code }.
   */
  async function approve(id, pick = null) {
    const a = current(id);
    if (!a || a.busy) return { status: 'failed', code: CODES.INTERNAL };
    const s = deps.state(a.binding);
    // Only while the browser is what the user is looking at: not under aiqnet.io's QNet Link screen, not from the
    // background (MOBLINK-R2-03). The sheet stays; nothing is signed.
    if (s.unlocked && s.accounts && !s.interactive) return { status: 'failed', code: CODES.USER_REJECTED };
    if (!s.unlocked || !s.accounts) {
      settle(a, err(CODES.UNAUTHORIZED));
      return { status: 'failed', code: CODES.UNAUTHORIZED };
    }
    if (!deps.isCurrent(a.binding)) {
      settle(a, err(CODES.USER_REJECTED));
      return { status: 'failed', code: CODES.USER_REJECTED };
    }
    const plan = a.kind === 'send' ? sendPlan(a.preview, pick) : null;
    if (a.kind === 'send' && !plan) return { status: 'review' };
    // What the sheet showed it cannot pay for is not sent, whatever pressed Confirm (MB-08).
    if (a.kind === 'send' && previewShort(a.payload, a.preview, pick)) return { status: 'failed', code: CODES.USER_REJECTED };
    a.busy = true;
    a.notice = null;
    changed();
    // Every send reads its balances (and a token transfer its deposit) again before anything is signed, as the
    // extension's confirm does: the sheet may have stood for minutes, and the same phrase may have spent meanwhile. A
    // balance that cannot be read, is too low now, or a deposit that changed signs nothing: the sheet shows the new
    // preview, and the user reviews it again. A transfer's recipient is read again too (MOB-BR-R3-01): one that is a
    // contract now ends the request (-32602), one no two nodes agree on is reviewed again.
    const pays = a.kind === 'send' && (a.payload.type === 'transfer' || a.payload.type === 'tokenTransfer');
    if (a.kind === 'send' && (deps.recheckSend || pays)) {
      const [fresh, recipient] = await Promise.all([
        deps.recheckSend ? Promise.resolve().then(() => deps.recheckSend({ ...a.payload })).catch(() => null) : null,
        pays ? recipientKind(a.payload.to, s.accounts.qnet) : 'none',
      ]);
      a.busy = false;
      if (current(id) !== a) return { status: 'failed', code: CODES.USER_REJECTED };
      // The page left while the balances were read (a busy sheet outlives pageChanged), or the approval's time ran out
      // meanwhile: nothing was signed, and it ends as rejected.
      if (!deps.isCurrent(a.binding) || a.timedOut) {
        settle(a, err(CODES.USER_REJECTED));
        return { status: 'failed', code: CODES.USER_REJECTED };
      }
      if (recipient !== null && recipient !== 'none') {
        a.outcome = { error: CODES.INVALID, recipient: 'contract' };
        settle(a, err(CODES.INVALID), undefined, { hold: true });
        return { status: 'failed', code: CODES.INVALID };
      }
      if (recipient === null || (deps.recheckSend && recheckProblem(a.payload, a.preview, fresh, pick))) {
        a.preview = null;
        a.notice = 'recheck';
        changed();
        loadPreview(id);
        return { status: 'review' };
      }
      if (!deps.state(a.binding).interactive) {
        changed();
        return { status: 'failed', code: CODES.USER_REJECTED };
      }
      a.busy = true;
    }
    try {
      let result;
      let refusal = null;
      if (a.kind === 'connect') {
        await deps.grants.put(a.origin, s.walletId);
        granted.add(a.origin);
        result = { qnet: s.accounts.qnet, solana: s.accounts.solana };
      } else {
        if (!(await grantOf(a.origin))) throw err(CODES.UNAUTHORIZED);
        if (a.kind === 'sign') {
          const signed = await deps.signMessage(a.origin, a.payload.message);
          if (!signed || signed.address !== s.accounts.qnet || !/^[0-9a-f]+$/.test(signed.signature)
            || !/^[0-9a-f]+$/.test(signed.publicKey)) throw err(CODES.INTERNAL);
          result = { signature: signed.signature, publicKey: signed.publicKey, address: signed.address };
        } else {
          const sent = await deps.send({ ...a.payload, nonce: plan.nonce, choice: plan.choice });
          refusal = sent && typeof sent.refusal === 'string' && sent.refusal ? sent.refusal.slice(0, 300) : null;
          if (refusal && sent.refusalFinal === true) {
            // Every node it went to refused it for good: the page gets the extension's answer to that (NODE_REJECTED,
            // -32603), and the sheet says why. The wallet keeps it listed under Assets and never sends it again.
            clearCooldown(a.origin);
            a.busy = false;
            a.outcome = { error: CODES.INTERNAL, refusal, final: true };
            settle(a, err(CODES.INTERNAL), undefined, { hold: true });
            return { status: 'failed', code: CODES.INTERNAL };
          }
          result = sendResult(a.payload, s.accounts.qnet, sent, plan.nonce);
        }
      }
      clearCooldown(a.origin);
      a.busy = false;
      // A refusal that waiting may heal goes to the sheet only: the page's result is the extension's `unknown`.
      if (a.kind === 'send') a.outcome = refusal ? { ...result, refusal } : { ...result };
      settle(a, null, result, { hold: a.kind === 'send' });
      if (a.kind === 'connect') {
        deps.emit(a.origin, 'accountsChanged', { ...result });
        for (const other of [...queue]) {
          if (other.kind === 'connect' && other.origin === a.origin && !other.busy) settle(other, null, { ...result });
        }
      }
      return { status: 'done', result };
    } catch (e) {
      a.busy = false;
      // The wallet's unconfirmed transactions or next nonce changed since the sheet was read: nothing was signed;
      // the sheet reads them again. When the one the user chose to replace went through meanwhile, it says so. One
      // whose time ran out meanwhile ends as rejected instead.
      const moved = ['NONCE_CHANGED', 'PENDING_CHANGED', 'PENDING_CHOICE', 'PENDING_SETTLED'];
      if (e && moved.includes(e.code) && current(id) === a && a.timedOut) {
        settle(a, err(CODES.USER_REJECTED));
        return { status: 'failed', code: CODES.USER_REJECTED };
      }
      if (e && moved.includes(e.code) && current(id) === a) {
        a.preview = null;
        a.notice = e.code === 'PENDING_SETTLED' ? 'settled' : 'changed';
        changed();
        loadPreview(id);
        return { status: 'review' };
      }
      const code = e instanceof ProviderError ? e.code : CODES.INTERNAL;
      a.outcome = { error: code };
      settle(a, err(code), undefined, { hold: a.kind === 'send' });
      return { status: 'failed', code };
    }
  }

  /** Closes a sheet that shows an outcome. */
  function dismiss(id) {
    if (slot && slot.id === id && slot.settled) {
      slot = null;
      pump();
    }
  }

  /** Ends every approval `predicate` selects (the page went away, the wallet locked). No cooldown is counted. */
  function cancelWhere(predicate, code) {
    for (const a of [...queue]) if (predicate(a) && !a.busy) settle(a, err(code));
    if (slot && slot.settled && predicate(slot)) {
      slot = null;
      pump();
    }
  }

  /**
   * The page on screen changed: approvals for any other page end. A page that went away by itself (a reload, a
   * redirect, a new document) after its sheet had offered the action for the arm time counts as a rejection, as
   * the extension counts it (ES-03, MB2-04); so does one that ended its sheet sooner when its origin already had
   * another sheet within the last minute (MB3-03, the extension's R2-ERP-01), and every sheet counts against the
   * origin's budget either way: a page cannot raise a fresh full-screen sheet in a loop by reloading, however fast.
   * A navigation the user started (address bar, back, forward, reload, home) counts nothing.
   */
  function pageChanged({ userInitiated = false } = {}) {
    const left = slot && !slot.settled && !slot.busy && !deps.isCurrent(slot.binding) && Number.isFinite(slot.shownAt)
      ? slot : null;
    const counts = left && (now() - left.shownAt >= armDelayFor(left.kind)
      || sheetsWithin(left.origin, TIMINGS.SHEET_BUDGET_SHORT_MS) >= 2);
    cancelWhere((a) => !deps.isCurrent(a.binding), CODES.USER_REJECTED);
    if (counts && !userInitiated) recordRejection(left.origin);
  }

  /** The wallet locked: every approval ends with 4100 and granted pages see no accounts any more. */
  function locked() {
    cancelWhere(() => true, CODES.UNAUTHORIZED);
    for (const origin of granted) deps.emit(origin, 'accountsChanged', {});
    granted.clear();
  }

  /** The wallet unlocked: a granted page on screen sees its accounts again. */
  async function unlocked(origin) {
    if (!origin) return;
    const accounts = await accountsFor(origin);
    if (accounts) deps.emit(origin, 'accountsChanged', accounts);
  }

  /** Settings → Connected sites → Revoke (or a page's qnet_disconnect). */
  const revoke = (origin) => disconnect(origin);

  return {
    request, loadPreview, approve, reject, dismiss, cancelWhere, pageChanged, locked, unlocked, revoke,
    current: () => view(slot),
  };
}
