// The dApp side of the wallet: per-origin grants, one approval window at a time, and the eleven provider
// methods. The origin always comes from the router, which took it from the port's sender; nothing a
// page sends can name another origin. Results and events are JSON data (bytes as lowercase hex). Every
// change of the approval queue calls events.notifyViews('approval'), and every confirmed action that ran calls
// events.notifyViews('balance'). An approval is confirmed with the unlocked session, never a password: the press
// of the armed Confirm in the approval's own window (approvalForPage binds the call to that window and approval).
import * as core from '../lib/qnet-core.js';
import * as activation from './activation.js';
import { U64_MAX, formatUnits, parseUnits } from './amount.js';
import { CLAIM_MIN_NANO, DECIMALS, LIMITS, QNET, SOLANA, STORAGE_KEYS, TIMINGS, UI_PAGES } from './config.js';
import { ERROR_MESSAGES, PROVIDER_ERROR_CODES, ProviderError, WalletError } from './errors.js';
import { notifyViews } from './events.js';
import * as keys from './keys.js';
import { log } from './log.js';
import * as nodes from './nodes.js';
import * as qnet from './qnet.js';
// router.js imports this module too; only its function declarations are used, and only at call time.
import {
  isActivationOrigin, isCanonicalOrigin, isU64String, originMatchesPattern, relayMatchPatterns,
} from './router.js';
import * as session from './session.js';
import * as vault from './vault.js';

/**
 * @typedef {object} ProviderContext  built by the router per accepted port, frozen
 * @property {string} origin
 * @property {number} tabId
 * @property {number} portId
 *
 * @typedef {object} SiteGrant  chrome.storage.local[STORAGE_KEYS.SITES][origin]
 * @property {number} grantedAt ms epoch
 * @property {Array<'qnet'|'solana'>} chains always ['qnet', 'solana'] today
 * @property {string} walletId the vault's walletId when granted
 * @property {string} mac base64 HMAC-SHA256(sitesKey, UTF-8(canonicalJson({origin, grantedAt, chains,
 *   walletId}))) with vault.readSiteBinding().sitesKey
 *
 * @typedef {object} Accounts  what a granted, unlocked origin sees
 * @property {string} qnet EON address
 * @property {string} solana base58 address
 *
 * @typedef {object} ApprovalView  result of approval.get
 * @property {string} id UUID
 * @property {'connect'|'signMessage'|'sendTransaction'|'tokenTransfer'|'contractCall'|'activateNode'|'claimNodeBalance'
 *   |'unlinkNodeDevice'} kind
 * @property {string} origin as the browser reported it (punycode host)
 * @property {string} originDisplay Unicode host for display
 * @property {boolean} idn true when the host has an xn-- label: the window shows a warning
 * @property {boolean} locked the window shows unlock first
 * @property {number} queued other approvals waiting behind this one
 * @property {number} createdAt
 * @property {object} details connect: {alreadyGranted: boolean};
 *   signMessage: {message: string, byteLength: number};
 *   sendTransaction: {to, amountNano, feeNano, totalNano, nonce: string|null, balanceNano: string|null,
 *   verified: boolean, verification: 'proof'|'none', balanceProblem, recipient: {known, lookalike, incomingOnly,
 *   historyRead}|null, outstanding, duplicate, replaces, inFlight} (nonce and balance are null until unlocked and until a
 *   committee-certified balance was read; u64 decimals; verification 'proof': balance and nonce from a proof folded to a
 *   committee-certified state root; balanceProblem: why no balance was read yet, 'NETWORK' (no node answered),
 *   'BALANCE_UNCONFIRMED' (none certified a recent state) or 'BALANCE_FOREIGN_PENDING' (a transaction from another device
 *   is not confirmed yet), else null; recipient: qnet.recipientCheck(to) for the first-time, look-alike and poisoning
 *   warnings, null while locked or when it could not be read; inFlight: an earlier transaction of this wallet still holds
 *   the nonce before this one's, so confirm waits);
 *   tokenTransfer: {token, to, amount, amountBase, name, symbol, decimals, reserved, burn, gasLimit, feeNano,
 *   depositNano, totalNano, nonce, balanceNano, verified, verification, balanceProblem, tokenBalance, tokenProblem,
 *   outstanding, duplicate, replaces, inFlight, recipient} (name, symbol and decimals two nodes' word; tokenBalance the
 *   committee-certified one less this wallet's own token transfers since, null with tokenProblem 'NETWORK' or
 *   'BALANCE_UNCONFIRMED' when it cannot be had; reserved: named after QNet's own coin; burn: `to` destroys tokens; the
 *   preview fields null until read);
 *   contractCall: {contract, method, args, argsBytes, argsText, gasLimit, feeNano, totalNano, nonce, balanceNano,
 *   verified, verification, balanceProblem, outstanding, replaces, inFlight} (args lowercase hex, '' for none; argsText
 *   the input as UTF-8 when the window draws it exactly, else null);
 *   activateNode: {nodeType, mode: 'burn'|'exists'|'pending'|'unavailable'|'checking'|null, reason, cost, activation,
 *   pending, balances, recorded, otherBurn, solanaAddress, mint, tokenProgram, cluster} (activation.siteView, the last
 *   one read; mode and the rest null while locked; recorded: the QNet network lists the light activation's node with
 *   its registration of this burn, otherBurn: with a registration of another burn (nodes.js whoseBurn), the only parts
 *   of its registration the window draws);
 *   claimNodeBalance: {mode: 'claim'|'empty'|'unavailable'|null, reason, nodeId, wallet, amountNano} (nodes.claimView,
 *   read again on every approval.get while not busy; null while locked);
 *   unlinkNodeDevice: {mode: 'confirm'|'unavailable'|null, reason, nodeId, wallet, platform, linkedSince}
 *   (nodes.unlinkView, read again on every approval.get while not busy; null while locked)
 *
 * @typedef {object} SiteActivationResult  qnet_activateNode result (QNet Link v1 section 10)
 * @property {'ok'|'exists'|'pending'|'error'} status
 * @property {string} [qnet] ok, exists, pending
 * @property {string} [solana] ok, exists, pending
 * @property {'light'|'super'} [nodeType] ok, exists (the wallet's own type, which may differ), pending
 * @property {string} [burnTx] ok, exists, pending
 * @property {number} [burnAmount] ok, exists, pending
 * @property {string} [code] ok, exists
 * @property {string} [supersededBurnTx] exists: the burn this device sent that another device's older burn of the
 *   phrase beat (section 7.1)
 * @property {string} [error] error: a SITE_ERRORS code
 *
 * @typedef {import('./activation.js').SiteActivation
 *   | {status: 'no_wallet'} | {status: 'locked'} | {status: 'not_connected'}} SiteActivationRead  qnet_getActivation result
 *   (CONTRACTS.md decision 35)
 *
 * @typedef {object} SiteClaimResult  qnet_claimNodeBalance result (QNet Link v1 section 14.10: the claim answer of
 *   section 14.7 without v and intent)
 * @property {'ok'|'empty'|'error'} status
 * @property {string} [qnet] ok, empty
 * @property {string} [nodeId] ok, empty
 * @property {string} [amountNano] ok: decimal nano, at least CLAIM_MIN_NANO, or above zero for a part of the balance
 *   (stoppedAtEpoch set)
 * @property {string} [txHash] ok: 64 lowercase hex
 * @property {string|null} [stoppedAtEpoch] ok: the epoch the node's quote stopped at (a partial move), else null
 * @property {string} [error] error: a CLAIM_ERRORS code
 *
 * @typedef {object} SiteUnlinkResult  qnet_unlinkNodeDevice result (CONTRACTS.md decision 38: the `unlink` answer of QNet
 *   Link v1 section 14.7 without v and intent)
 * @property {'ok'|'error'} status
 * @property {string} [qnet] ok
 * @property {string} [nodeId] ok
 * @property {true} [unbound] ok: the network took the wallet key's unbind
 * @property {string} [error] error: an UNLINK_ERRORS code
 */

const CODES = PROVIDER_ERROR_CODES;
const CHAINS = Object.freeze(['qnet', 'solana']);
const GRANT_FIELDS = 'chains,grantedAt,mac,walletId';
const MAC_BYTES = 32;
const SITES_KEY_BYTES = 32;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TX_HASH_RE = /^[0-9A-Za-z_-]{1,128}$/;
const APPROVAL_WINDOW = Object.freeze({ type: 'popup', focused: true, width: 400, height: 640 });
// The approval's gap from the browser window's right edge and top: under the toolbar, where the extension icon is.
const APPROVAL_EDGE = Object.freeze({ right: 16, top: 72 });
// Across all origins; the per-origin cap is LIMITS.APPROVAL_QUEUE_PER_ORIGIN.
const QUEUE_MAX_TOTAL = 12;
// A window whose approved action failed, or whose activation finished, stays this long so the user can
// read the outcome, then closes.
const ERROR_LINGER_MS = 30000;
// Raised before anything is signed: the approval stays open for a fresh review (a balance the send rule could not have
// certified yet is read again by it, and the window says why meanwhile).
const REVIEW_AGAIN = new Set(['FEE_CHANGED', 'NONCE_CHANGED', 'NONCE_UNAVAILABLE', 'BALANCE_UNCONFIRMED', 'BALANCE_FOREIGN_PENDING']);
// An activation confirm that failed on these stays open: an unlock, or (PRICE_CHANGED) a fresh review of the burn.
const RETRY_IN_WINDOW = new Set(['LOCKED', 'PRICE_CHANGED']);
// The error codes a qnet_activateNode result may carry (QNet Link v1 section 7); anything else is INTERNAL.
// HISTORY_TOO_LONG: a burn search its budget cut short, which resumes on the next request (SRA-R2-02). BURN_UNUSABLE:
// the wallet already burned in a form no code derives from, its one activation (R4-ESA-01, XP-R5-01).
const SITE_ERRORS = new Set([
  'PRICE_UNAVAILABLE', 'PHASE_UNSUPPORTED', 'PRICE_CHANGED', 'INSUFFICIENT_SOL', 'INSUFFICIENT_TOKENS',
  'SIMULATION_FAILED', 'TX_FAILED', 'SOLANA_UNAVAILABLE', 'HISTORY_TOO_LONG', 'NODE_EXISTS', 'BURN_UNUSABLE',
  'BURN_IN_PROGRESS', 'NO_WALLET', 'INTERNAL',
]);
/** The QNet Link v1 section 7 error codes a qnet_activateNode result may carry, for the shared-vectors test. */
export const SITE_ERROR_CODES = Object.freeze([...SITE_ERRORS]);
const SITE_VIEW_MODES = new Set(['burn', 'exists', 'pending', 'unavailable', 'checking']);
// The codes of aiqnet.io's record of the wallet's burn (decision 35) reach the site as the section 7 codes they mean: a
// burn it holds as NODE_EXISTS, one starting elsewhere as BURN_IN_PROGRESS, no answer as INTERNAL.
const SITE_CODE_OF = Object.freeze({
  ACTIVATION_RECORDED: 'NODE_EXISTS', ACTIVATION_RESERVED: 'BURN_IN_PROGRESS', RECORD_UNAVAILABLE: 'INTERNAL',
});
const siteCode = (code) => (Object.hasOwn(SITE_CODE_OF, code) ? SITE_CODE_OF[code] : code);
const siteError = (code) => ({ status: 'error', error: SITE_ERRORS.has(siteCode(code)) ? siteCode(code) : 'INTERNAL' });
// qnet_getActivation (decision 35): the statuses of activation.siteActivation and the reasons of 'unknown'.
const READ_STATUSES = new Set(['searching', 'none', 'unusable', 'unknown', 'pending', 'exists']);
const READ_REASONS = new Set(['SOLANA_UNAVAILABLE', 'HISTORY_TOO_LONG']);
const READ_WINDOW_MS = 60000;
// The error codes a qnet_claimNodeBalance result may carry (QNet Link v1 section 14.7, claim); anything else is INTERNAL.
const CLAIM_ERRORS = new Set(['NO_WALLET', 'NO_NODE', 'NETWORK', 'CLAIM_REFUSED', 'CLAIM_BUSY', 'INTERNAL']);
/** The error codes a qnet_claimNodeBalance result may carry, for the shared-vectors test. */
export const CLAIM_ERROR_CODES = Object.freeze([...CLAIM_ERRORS]);
const claimError = (code) => ({ status: 'error', error: CLAIM_ERRORS.has(code) ? code : 'INTERNAL' });
const CLAIM_VIEW_MODES = new Set(['claim', 'empty', 'unavailable']);
const CLAIM_VIEW_REASONS = new Set(['NO_NODE', 'NETWORK', 'SIGNING_DISABLED']);
// The error codes a qnet_unlinkNodeDevice result may carry (decision 38); anything else is INTERNAL (UNSUPPORTED and
// SIGNING_DISABLED among them).
const UNLINK_ERRORS = new Set(['NO_WALLET', 'NOT_LINKED', 'NETWORK', 'UNLINK_REFUSED', 'INTERNAL']);
/** The error codes a qnet_unlinkNodeDevice result may carry, for the shared-vectors test. */
export const UNLINK_ERROR_CODES = Object.freeze([...UNLINK_ERRORS]);
const unlinkError = (code) => ({ status: 'error', error: UNLINK_ERRORS.has(code) ? code : 'INTERNAL' });
const UNLINK_VIEW_REASONS = new Set(['NOT_LINKED', 'UNSUPPORTED', 'NETWORK', 'SIGNING_DISABLED']);
const DEVICE_PLATFORMS = new Set(['android', 'ios', 'unknown']);
const REGISTRATION_STATES = new Set(['queued', 'admitted', 'onchain', 'other_burn', 'refused', 'clock']);
const HASH_HEX_RE = /^[0-9a-f]{64}$/;
// The approvals of qnet_sendTransaction, one kind per request type; each signs and sends a transaction.
const TX_KINDS = new Set(['sendTransaction', 'tokenTransfer', 'contractCall']);
// Kinds whose confirm moves value: the confirm must name the revision of the view the page showed.
const REVISIONED = new Set([...TX_KINDS, 'activateNode', 'claimNodeBalance', 'unlinkNodeDevice']);
const U128_RE = /^(0|[1-9][0-9]{0,38})$/;
// Why no balance a send is decided by could be had (qnet's send rule), as the approval window names it.
const BALANCE_PROBLEMS = new Set(['NETWORK', 'BALANCE_UNCONFIRMED', 'BALANCE_FOREIGN_PENDING']);
// The most decimals a token amount converts with (amount.parseUnits).
const TOKEN_DECIMALS_MAX = 18;
const STATUSES = new Set(['pending', 'in_block', 'unknown']);
// qnet_getTransactionStatus, as the mobile in-app browser: one origin's answer for a (from, nonce) is given again for
// STATUS_FRESH_MS without a read, and one origin starts at most STATUS_READS_PER_MINUTE reads a minute (more: 4001).
const STATUS_FRESH_MS = 3000;
const STATUS_READS_PER_MINUTE = 20;
const STATUS_WINDOW_MS = 60000;
const STATUS_ORIGINS_MAX = 64;
const STATUS_ANSWERS_MAX = 8;
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const notFound = () => new WalletError('NOT_FOUND');
const accountsOf = (current) => ({ qnet: current.qnetAddress, solana: current.solanaAddress });

// ---------------------------------------------------------------- origin display

const PUNYCODE = Object.freeze({ BASE: 36, T_MIN: 1, T_MAX: 26, SKEW: 38, DAMP: 700, BIAS: 72, N: 128 });
const MAX_INT = 0x7fffffff;
// A decoded label is shown only if it has nothing that hides, reorders or fakes a separator.
const UNSAFE_LABEL = /[\s\p{C}.。．｡/\\⁄∕⧸／@:#?%]/u;

function punycodeDigit(code) {
  if (code >= 0x30 && code <= 0x39) return code - 22;
  if (code >= 0x61 && code <= 0x7a) return code - 0x61;
  return PUNYCODE.BASE;
}

function adaptBias(delta, points, first) {
  const { BASE, T_MIN, T_MAX, SKEW, DAMP } = PUNYCODE;
  let d = first ? Math.floor(delta / DAMP) : Math.floor(delta / 2);
  d += Math.floor(d / points);
  let k = 0;
  while (d > ((BASE - T_MIN) * T_MAX) >> 1) {
    d = Math.floor(d / (BASE - T_MIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - T_MIN + 1) * d) / (d + SKEW));
}

// RFC 3492 decoding of the part after "xn--" (URL.hostname is already lowercase ASCII).
function decodePunycode(input) {
  const { BASE, T_MIN, T_MAX } = PUNYCODE;
  if (!/^[a-z0-9-]{1,59}$/.test(input)) throw new RangeError('punycode');
  const delimiter = input.lastIndexOf('-');
  const output = [];
  for (let j = 0; j < Math.max(delimiter, 0); j += 1) output.push(input.charCodeAt(j));
  let n = PUNYCODE.N;
  let bias = PUNYCODE.BIAS;
  let i = 0;
  let index = delimiter > 0 ? delimiter + 1 : 0;
  while (index < input.length) {
    const start = i;
    let w = 1;
    for (let k = BASE; ; k += BASE) {
      if (index >= input.length) throw new RangeError('punycode');
      const digit = punycodeDigit(input.charCodeAt(index));
      index += 1;
      if (digit >= BASE || digit > Math.floor((MAX_INT - i) / w)) throw new RangeError('punycode');
      i += digit * w;
      const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
      if (digit < t) break;
      if (w > Math.floor(MAX_INT / (BASE - t))) throw new RangeError('punycode');
      w *= BASE - t;
    }
    const length = output.length + 1;
    bias = adaptBias(i - start, length, start === 0);
    n += Math.floor(i / length);
    i %= length;
    if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) throw new RangeError('punycode');
    output.splice(i, 0, n);
    i += 1;
  }
  return String.fromCodePoint(...output);
}

/**
 * How an origin is shown: the Unicode form of its host (punycode decoded label by label, a label that
 * fails to decode stays as is) and whether it is an IDN.
 * @param {string} origin
 * @returns {{text: string, idn: boolean}}
 */
export function displayOrigin(origin) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    return { text: String(origin), idn: /xn--/i.test(String(origin)) };
  }
  let idn = false;
  const labels = url.hostname.split('.').map((label) => {
    if (!label.startsWith('xn--')) return label;
    idn = true;
    try {
      const decoded = decodePunycode(label.slice(4));
      return decoded.length > 0 && !UNSAFE_LABEL.test(decoded) ? decoded : label;
    } catch {
      return label;
    }
  });
  const port = url.port ? `:${url.port}` : '';
  return { text: `${url.protocol}//${labels.join('.')}${port}`, idn };
}

// ---------------------------------------------------------------- service

/**
 * The provider state machine with its collaborators injected. The module functions below delegate to
 * one instance wired to the real modules; tests build their own with fakes.
 * @param {object} [options]
 * @param {object} [options.chrome] chrome.* (default globalThis.chrome, read at call time)
 * @param {{isUnlocked: Function, requireUnlocked: Function}} [options.session]
 * @param {{readSiteBinding: Function, rotateSitesKey: Function, vaultExists: Function}} [options.vault]
 * @param {{signOffchain: Function}} [options.keys]
 * @param {{prepareTransfer: Function, sendTransfer: Function, transferFeeNano: Function,
 *   recipientCheck: Function, readContract: Function, assertPayableRecipient: Function, prepareCall: Function,
 *   sendCall: Function, transactionStatus: Function}} [options.qnet]
 * @param {{siteView: Function, activateForSite: Function, siteActivation: Function}} [options.activation]
 * @param {{claimView: Function, claimForSite: Function, getRegistration: Function, unlinkView: Function,
 *   unlinkForSite: Function}} [options.nodes]
 * @param {(origin: string, event: string, data: unknown) => number} [options.emit] default: the sink set
 *   by setEventSink
 * @param {(event: string) => void} [options.notifyViews]
 * @param {() => number} [options.now]
 * @param {(fn: () => void, ms: number) => unknown} [options.setTimer]
 * @param {(handle: unknown) => void} [options.clearTimer]
 * @param {() => string} [options.randomUUID]
 * @returns {Readonly<{handleRequest: Function, onPortClosed: Function, onWindowRemoved: Function,
 *   notifyLockChanged: Function, listSites: Function, revokeSite: Function, getApproval: Function,
 *   resolveApproval: Function, readSites: Function, snapshot: () => {queued: number, windowId: number|null}}>}
 */
export function createProviderService(options = {}) {
  const d = Object.freeze({
    chrome: () => options.chrome ?? globalThis.chrome,
    session: options.session ?? session,
    vault: options.vault ?? vault,
    keys: options.keys ?? keys,
    qnet: options.qnet ?? qnet,
    activation: options.activation ?? activation,
    nodes: options.nodes ?? nodes,
    emit: options.emit ?? ((origin, event, data) => (emitEvent === null ? 0 : emitEvent(origin, event, data))),
    notifyViews: options.notifyViews ?? notifyViews,
    now: options.now ?? (() => Date.now()),
    setTimer: options.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
    clearTimer: options.clearTimer ?? ((handle) => clearTimeout(handle)),
    randomUUID: options.randomUUID ?? (() => crypto.randomUUID()),
  });

  const queue = []; // unsettled approvals, FIFO across origins
  let slot = null; // {approval, windowId, opened}: the one approval window
  const closedWhileOpening = new Set();
  const livePorts = new Map(); // portId → origin, ports that made a request
  const grantedCache = new Set(); // origins of the last grant read, for wipe
  // origin → {rejections: ms[] within the window, until: ms}; mirrored to storage.session
  const cooldowns = new Map();
  let cooldownsLoaded = null;
  let cooldownWrites = Promise.resolve();
  // origin → {reads: ms[] within the last minute, answers: Map(`${from}:${nonce}` → {at, answer})}: qnet_getTransactionStatus
  const statusReads = new Map();
  // origin → ms[] of its qnet_getActivation reads within the last minute
  const activationReads = new Map();
  let patterns = null;
  let sitesChain = Promise.resolve();
  let windowsClosed = Promise.resolve();
  let pumping = null;
  let pumpAgain = false;

  const emit = (origin, event, data) => {
    try {
      return d.emit(origin, event, data);
    } catch (error) {
      log.warn('provider event failed', error?.name);
      return 0;
    }
  };

  const queueChanged = () => {
    try {
      d.notifyViews('approval');
    } catch {
      // no page is listening
    }
  };

  // A confirmed action ran (sent, burned, claimed, or failed on the way): the pages read balances and history again.
  const balanceChanged = () => {
    try {
      d.notifyViews('balance');
    } catch {
      // no page is listening
    }
  };

  // -------------------------------------------------------------- grants

  function allowedOrigin(origin) {
    if (!isCanonicalOrigin(origin)) return false;
    patterns ??= Object.freeze(relayMatchPatterns(d.chrome()?.runtime?.getManifest?.() ?? {}));
    return patterns.some((pattern) => originMatchesPattern(origin, pattern));
  }

  function grantMac(sitesKey, origin, grant) {
    const text = vault.canonicalJson({ origin, grantedAt: grant.grantedAt, chains: [...grant.chains], walletId: grant.walletId });
    return core.hmac(core.sha256, sitesKey, core.utf8Encode(text));
  }

  function isValidGrant(origin, grant, binding) {
    if (!allowedOrigin(origin) || !isPlainObject(grant) || Object.keys(grant).sort().join(',') !== GRANT_FIELDS) return false;
    const { grantedAt, chains, walletId, mac } = grant;
    if (!Number.isSafeInteger(grantedAt) || grantedAt <= 0 || walletId !== binding.walletId) return false;
    if (!Array.isArray(chains) || chains.length !== CHAINS.length || chains.some((c, i) => c !== CHAINS[i])) return false;
    if (typeof mac !== 'string' || mac.length === 0 || mac.length > 64) return false;
    let stored;
    try {
      stored = core.base64Decode(mac);
    } catch {
      return false;
    }
    return stored.length === MAC_BYTES && core.equalBytes(stored, grantMac(binding.sitesKey, origin, grant));
  }

  function checkedBinding(binding) {
    if (binding === null) return null;
    const ok = isPlainObject(binding) && typeof binding.walletId === 'string' && binding.walletId.length > 0
      && binding.sitesKey instanceof Uint8Array && binding.sitesKey.length === SITES_KEY_BYTES;
    if (!ok) throw new WalletError('VAULT_CORRUPT');
    return binding;
  }

  const readBinding = async () => checkedBinding(await d.vault.readSiteBinding());

  async function loadGrants(binding) {
    const stored = (await d.chrome().storage.local.get(STORAGE_KEYS.SITES))?.[STORAGE_KEYS.SITES];
    const sites = {};
    let pruned = stored !== undefined && !isPlainObject(stored);
    if (isPlainObject(stored)) {
      for (const [origin, grant] of Object.entries(stored)) {
        if (binding !== null && isValidGrant(origin, grant, binding)) {
          sites[origin] = { grantedAt: grant.grantedAt, chains: [...CHAINS], walletId: grant.walletId, mac: grant.mac };
        } else {
          pruned = true;
        }
      }
    }
    return { sites, pruned };
  }

  function remember(sites) {
    grantedCache.clear();
    for (const origin of Object.keys(sites)) grantedCache.add(origin);
  }

  async function storeGrants(sites) {
    const storage = d.chrome().storage.local;
    if (Object.keys(sites).length === 0) await storage.remove(STORAGE_KEYS.SITES);
    else await storage.set({ [STORAGE_KEYS.SITES]: sites });
    remember(sites);
  }

  // Grant reads and writes run one at a time, so a prune never races a new grant.
  function withGrants(fn) {
    const run = sitesChain.then(async () => fn(await readBinding()));
    sitesChain = run.then(() => undefined, () => undefined);
    return run;
  }

  function readSites() {
    return withGrants(async (binding) => {
      const { sites, pruned } = await loadGrants(binding);
      if (pruned) {
        try {
          await storeGrants(sites);
        } catch (error) {
          log.warn('grant prune failed', error?.name);
        }
      } else {
        remember(sites);
      }
      return sites;
    });
  }

  function signedGrant(sitesKey, origin, grantedAt, walletId) {
    const grant = { grantedAt, chains: [...CHAINS], walletId };
    return { ...grant, mac: core.base64Encode(grantMac(sitesKey, origin, grant)) };
  }

  function writeGrant(origin, walletId) {
    return withGrants(async (binding) => {
      if (binding === null || binding.walletId !== walletId) throw new WalletError('VAULT_CORRUPT');
      const { sites } = await loadGrants(binding);
      sites[origin] = signedGrant(binding.sitesKey, origin, d.now(), walletId);
      await storeGrants(sites);
    });
  }

  // A revoke rotates the MAC key before anything is stored, so the revoked grant can never be written
  // back into storage.local; the remaining grants are signed again with the new key. A failure after the
  // rotation leaves every old grant invalid, which only asks the user to connect again.
  function removeGrant(origin) {
    return withGrants(async (binding) => {
      const { sites, pruned } = await loadGrants(binding);
      const had = Object.hasOwn(sites, origin);
      delete sites[origin];
      if (!had) {
        if (pruned) await storeGrants(sites);
        else remember(sites);
        return false;
      }
      const fresh = checkedBinding(await d.vault.rotateSitesKey());
      const kept = {};
      if (fresh !== null && fresh.walletId === binding.walletId) {
        for (const [site, { grantedAt, walletId }] of Object.entries(sites)) {
          kept[site] = signedGrant(fresh.sitesKey, site, grantedAt, walletId);
        }
      }
      await storeGrants(kept);
      return true;
    });
  }

  async function grantOf(origin) {
    const sites = await readSites();
    return Object.hasOwn(sites, origin) ? sites[origin] : null;
  }

  async function unlockedSession() {
    try {
      return await d.session.requireUnlocked();
    } catch (error) {
      if (error?.code === 'LOCKED') return null;
      throw error;
    }
  }

  // Accounts for a granted origin while unlocked; null in every other case (never an error).
  async function accountsFor(origin) {
    try {
      const current = await unlockedSession();
      if (current === null) return null;
      const grant = await grantOf(origin);
      return grant !== null && grant.walletId === current.walletId ? accountsOf(current) : null;
    } catch (error) {
      log.warn('accounts lookup failed', error?.code ?? error?.name);
      return null;
    }
  }

  // -------------------------------------------------------------- approval cooldown

  // A clock set back must not turn a cooldown into a lock-out: never more than the long cooldown ahead.
  // windows: when each approval window of the origin that ended without an approved action opened (R2-ERP-01).
  function liveCooldown(entry, now) {
    const recent = (at) => at <= now && now - at < TIMINGS.APPROVAL_COOLDOWN_WINDOW_MS;
    const rejections = entry.rejections.filter(recent);
    const windows = (entry.windows ?? []).filter(recent).slice(-LIMITS.APPROVAL_BUDGET_LONG);
    const until = Math.min(entry.until, now + TIMINGS.APPROVAL_COOLDOWN_LONG_MS);
    return rejections.length === 0 && windows.length === 0 && until <= now ? null : { rejections, until, windows };
  }

  function parseCooldown(origin, entry, now) {
    const keys = isPlainObject(entry) ? Object.keys(entry).sort().join(',') : '';
    const ok = isCanonicalOrigin(origin) && (keys === 'rejections,until' || keys === 'rejections,until,windows')
      && Number.isSafeInteger(entry.until) && Array.isArray(entry.rejections)
      && entry.rejections.length <= LIMITS.APPROVAL_COOLDOWN_REJECTIONS && entry.rejections.every(Number.isSafeInteger)
      && (entry.windows === undefined || (Array.isArray(entry.windows) && entry.windows.length <= LIMITS.APPROVAL_BUDGET_LONG
        && entry.windows.every(Number.isSafeInteger)));
    return ok ? liveCooldown({ windows: [], ...entry }, now) : null;
  }

  // Once per worker: cooldowns of a previous worker (the MV3 worker stops after 30 s idle) come back.
  function loadCooldowns() {
    cooldownsLoaded ??= (async () => {
      let stored;
      try {
        stored = (await d.chrome().storage.session.get(STORAGE_KEYS.APPROVAL_COOLDOWN))?.[STORAGE_KEYS.APPROVAL_COOLDOWN];
      } catch (error) {
        log.warn('approval cooldowns unreadable', error?.name);
        return;
      }
      if (!isPlainObject(stored)) return;
      const now = d.now();
      for (const [origin, entry] of Object.entries(stored).slice(0, LIMITS.APPROVAL_COOLDOWN_ORIGINS_MAX)) {
        const parsed = parseCooldown(origin, entry, now);
        if (parsed !== null && !cooldowns.has(origin)) cooldowns.set(origin, parsed);
      }
    })();
    return cooldownsLoaded;
  }

  function saveCooldowns() {
    const now = d.now();
    for (const [origin, entry] of [...cooldowns]) {
      const live = liveCooldown(entry, now);
      if (live === null) cooldowns.delete(origin);
      else cooldowns.set(origin, live);
    }
    const data = Object.fromEntries([...cooldowns].map(([origin, { rejections, until, windows }]) => [origin,
      { rejections: [...rejections], until, windows: [...windows] }]));
    cooldownWrites = cooldownWrites.then(async () => {
      const area = d.chrome().storage.session;
      if (Object.keys(data).length === 0) await area.remove(STORAGE_KEYS.APPROVAL_COOLDOWN);
      else await area.set({ [STORAGE_KEYS.APPROVAL_COOLDOWN]: data });
    }).catch((error) => log.warn('approval cooldowns not stored', error?.name));
  }

  function inCooldown(origin) {
    const entry = cooldowns.get(origin);
    if (entry === undefined) return false;
    const now = d.now();
    // the clock went back: the cooldown ends at most the long cooldown from now
    if (entry.until - now > TIMINGS.APPROVAL_COOLDOWN_LONG_MS) entry.until = now + TIMINGS.APPROVAL_COOLDOWN_LONG_MS;
    return entry.until > now;
  }

  // The user rejected or closed an approval of `origin`: no approval of it opens for APPROVAL_COOLDOWN_MS,
  // or APPROVAL_COOLDOWN_LONG_MS after APPROVAL_COOLDOWN_REJECTIONS within the window; those still waiting
  // end now.
  function recordRejection(origin) {
    const now = d.now();
    const previous = cooldowns.has(origin) ? liveCooldown(cooldowns.get(origin), now) : null;
    const rejections = [...(previous?.rejections ?? []), now].slice(-LIMITS.APPROVAL_COOLDOWN_REJECTIONS);
    const long = rejections.length >= LIMITS.APPROVAL_COOLDOWN_REJECTIONS;
    const until = Math.max(previous?.until ?? 0, now + (long ? TIMINGS.APPROVAL_COOLDOWN_LONG_MS : TIMINGS.APPROVAL_COOLDOWN_MS));
    cooldowns.delete(origin);
    cooldowns.set(origin, { rejections, until, windows: previous?.windows ?? [] });
    while (cooldowns.size > LIMITS.APPROVAL_COOLDOWN_ORIGINS_MAX) cooldowns.delete(cooldowns.keys().next().value);
    // Only a cooldown that is really on ends the origin's other waiting approvals: a single rejection brings none
    // (APPROVAL_COOLDOWN_MS 0, owner 28.09), so its other requests keep their turn.
    if (until > now) rejectWhere((a) => a.ctx.origin === origin && slot?.approval !== a, new WalletError('APPROVAL_COOLDOWN'));
    saveCooldowns();
  }

  function clearCooldown(origin) {
    if (cooldowns.delete(origin)) saveCooldowns();
  }

  // The origin's windows that ended without an approved action within the last `ms`.
  function windowsWithin(origin, ms) {
    const entry = cooldowns.get(origin);
    const now = d.now();
    return entry === undefined ? 0 : entry.windows.filter((at) => at <= now && now - at < ms).length;
  }

  // Every approval window counts against its origin's budget from the moment it opens, however it ends,
  // until an approved action takes it off (R2-ERP-01): a page cannot open focused windows back to back,
  // whatever it does with them (reload before the confirm arms, a Close of an unavailable activation).
  function budgetSpent(origin) {
    return windowsWithin(origin, TIMINGS.APPROVAL_BUDGET_SHORT_MS) >= LIMITS.APPROVAL_BUDGET_SHORT
      || windowsWithin(origin, TIMINGS.APPROVAL_COOLDOWN_WINDOW_MS) >= LIMITS.APPROVAL_BUDGET_LONG;
  }

  function recordWindow(approval) {
    const now = d.now();
    const { origin } = approval.ctx;
    const previous = cooldowns.has(origin) ? liveCooldown(cooldowns.get(origin), now) : null;
    const entry = previous ?? { rejections: [], until: 0, windows: [] };
    entry.windows = [...entry.windows, now].slice(-LIMITS.APPROVAL_BUDGET_LONG);
    cooldowns.delete(origin);
    cooldowns.set(origin, entry);
    while (cooldowns.size > LIMITS.APPROVAL_COOLDOWN_ORIGINS_MAX) cooldowns.delete(cooldowns.keys().next().value);
    approval.windowAt = now;
    saveCooldowns();
  }

  // -------------------------------------------------------------- approval queue

  function arm(approval, ms, onFire) {
    disarm(approval);
    approval.timer = d.setTimer(() => {
      approval.timer = null;
      onFire();
    }, ms);
  }

  function disarm(approval) {
    if (approval.timer === null) return;
    d.clearTimer(approval.timer);
    approval.timer = null;
  }

  function settle(approval, error, result = null) {
    if (approval.settled) return false;
    approval.settled = true;
    disarm(approval);
    const index = queue.indexOf(approval);
    if (index !== -1) queue.splice(index, 1);
    if (error) approval.reject(error);
    else approval.resolve(result);
    queueChanged();
    return true;
  }

  // The next approval window opens only after this one is gone (fillSlot awaits windowsClosed).
  function closeWindow(windowId) {
    const closed = Promise.resolve()
      .then(() => d.chrome().windows.remove(windowId))
      .catch(() => {});
    windowsClosed = Promise.all([windowsClosed, closed]);
  }

  // The approval leaves the window slot: its window closes and the next approval opens.
  function release(approval) {
    if (slot === null || slot.approval !== approval) return;
    const { windowId } = slot;
    slot = null;
    disarm(approval);
    if (windowId !== null) closeWindow(windowId);
    pump();
  }

  function expire(approval) {
    if (approval.busy) return; // an approved action is running; it closes the window itself
    settle(approval, new ProviderError(CODES.USER_REJECTED));
    release(approval);
  }

  // A uniform random integer in [0, n).
  function randomBelow(n) {
    if (!Number.isSafeInteger(n) || n <= 1) return 0;
    const sample = new Uint32Array(1);
    const limit = Math.floor(0x100000000 / n) * n;
    do {
      crypto.getRandomValues(sample);
    } while (sample[0] >= limit);
    return sample[0] % n;
  }

  // The bounds of a window, when all are readable.
  function boxOf(w) {
    if (![w?.left, w?.top, w?.width, w?.height].every(Number.isSafeInteger) || w.width <= 0 || w.height <= 0) return null;
    return { left: w.left, top: w.top, width: w.width, height: w.height };
  }

  // Where the approval window opens: under the extension's toolbar icon, the top-right corner of one of the user's
  // browser windows (owner, 30.09; decision 37). A page still cannot aim a click lure at Confirm (R2-ERP-02): the
  // approve page draws a random gap above its actions with every view, and Confirm arms only after its delay. The area
  // is a normal browser window, which no page can create, size or place: a page can open itself in a popup window of
  // any size and place, and a corner taken from that window would let it choose the spot (R4-ERP-01). One window, never the
  // box around several: with displays of other sizes or offsets that box spans space no display covers, where Chrome
  // refuses the bounds or leaves Confirm off screen (ERP-R5-01); a window lies on a display, so the approval, kept
  // wholly inside it, does too. The focused normal window when there is one, else one of them at random. Only when
  // no normal window can be read, the requesting window if it is a normal one; else Chrome's default placement.
  async function placement(ctx) {
    try {
      const api = d.chrome();
      let area = null;
      try {
        const listed = await api.windows.getAll({ windowTypes: ['normal'] });
        const normal = (Array.isArray(listed) ? listed : []).filter((w) => w?.type === 'normal' && w.state !== 'minimized' && boxOf(w) !== null);
        const chosen = normal.find((w) => w.focused === true) ?? normal[randomBelow(normal.length)];
        area = chosen === undefined ? null : boxOf(chosen);
      } catch {
        area = null;
      }
      if (area === null) {
        const tab = await api.tabs.get(ctx.tabId);
        const win = await api.windows.get(tab.windowId);
        if (win?.type === undefined || win.type === 'normal') area = boxOf(win);
      }
      if (area === null) return {};
      // Under the extension's toolbar icon: the top-right corner of that window (owner, 30.09; decision 37).
      return {
        left: area.left + Math.max(0, area.width - APPROVAL_WINDOW.width - APPROVAL_EDGE.right),
        top: area.top + Math.min(APPROVAL_EDGE.top, Math.max(0, area.height - APPROVAL_WINDOW.height)),
      };
    } catch {
      return {};
    }
  }

  async function openWindow(approval) {
    let markOpened;
    const entry = { approval, windowId: null, opened: new Promise((resolve) => { markOpened = resolve; }) };
    slot = entry;
    closedWhileOpening.clear();
    arm(approval, TIMINGS.APPROVAL_TIMEOUT_MS, () => expire(approval));
    let windowId = null;
    try {
      const api = d.chrome();
      const url = api.runtime.getURL(`${UI_PAGES.approve}?id=${approval.id}`);
      const where = await placement(approval.ctx);
      let created;
      try {
        created = await api.windows.create({ url, ...APPROVAL_WINDOW, ...where });
      } catch (error) {
        if (!Object.hasOwn(where, 'left')) throw error;
        // bounds Chrome refuses (less than half on a display): its own default placement, not a failed request (ERP-R5-01)
        log.warn('approval window place refused', error?.name);
        created = await api.windows.create({ url, ...APPROVAL_WINDOW });
      }
      if (Number.isSafeInteger(created?.id)) windowId = created.id;
    } catch (error) {
      log.warn('approval window failed', error?.name);
    }
    if (windowId !== null && slot === entry && !closedWhileOpening.has(windowId)) {
      entry.windowId = windowId;
      recordWindow(approval);
      queueChanged();
    } else {
      if (windowId !== null) {
        // the window opened and took the focus, even if its approval ended while it was being created (its
        // page went away meanwhile): it counts against the origin's budget like any other (R3-ERP-01)
        recordWindow(approval);
        closeWindow(windowId);
      }
      if (slot === entry) {
        slot = null;
        settle(approval, new ProviderError(windowId === null ? CODES.INTERNAL : CODES.USER_REJECTED));
      }
    }
    markOpened();
  }

  async function fillSlot() {
    while (slot === null) {
      await windowsClosed;
      if (slot !== null) return;
      const next = queue.find((approval) => !approval.busy);
      if (next === undefined) return;
      // an approval that waited while its origin spent its window budget opens none
      if (budgetSpent(next.ctx.origin)) {
        settle(next, new WalletError('APPROVAL_COOLDOWN'));
        continue;
      }
      if (next.kind === 'connect') {
        // granted meanwhile (another window, or an unlock): no window needed
        const accounts = await accountsFor(next.ctx.origin);
        if (next.settled || slot !== null) continue;
        if (accounts !== null) {
          settle(next, null, accounts);
          continue;
        }
      }
      await openWindow(next);
    }
  }

  function pump() {
    if (pumping !== null) {
      pumpAgain = true;
      return pumping;
    }
    pumping = (async () => {
      try {
        do {
          pumpAgain = false;
          await fillSlot();
        } while (pumpAgain);
      } catch (error) {
        log.warn('approval queue failed', error?.name);
      } finally {
        pumping = null;
      }
    })();
    return pumping;
  }

  function enqueue(ctx, kind, payload) {
    // the port may have closed while this request awaited its grant check: nobody is left to ask for
    if (!livePorts.has(ctx.portId)) throw new ProviderError(CODES.USER_REJECTED);
    if (inCooldown(ctx.origin) || budgetSpent(ctx.origin)) throw new WalletError('APPROVAL_COOLDOWN');
    const sameOrigin = queue.filter((approval) => approval.ctx.origin === ctx.origin).length;
    if (sameOrigin >= LIMITS.APPROVAL_QUEUE_PER_ORIGIN || queue.length >= QUEUE_MAX_TOTAL) {
      throw new ProviderError(CODES.USER_REJECTED);
    }
    const id = d.randomUUID();
    if (typeof id !== 'string' || !UUID_RE.test(id) || queue.some((approval) => approval.id === id)) {
      throw new WalletError('INTERNAL');
    }
    return new Promise((resolve, reject) => {
      queue.push({
        id, kind, ctx, payload, createdAt: d.now(), settled: false, busy: false, timer: null, preview: null, balanceProblem: null,
        recipient: null, view: null, cost: null, nodeChecked: false, shownAt: null, windowAt: null, windowClosed: false,
        // revision: bumped whenever the details served to the page change; readGen: the latest read started
        revision: 0, detailsKey: null, readGen: 0, resolve, reject,
      });
      queueChanged();
      pump();
    });
  }

  // The approval shown in the sender's window, or NOT_FOUND: pages act only on their own approval. With the router's
  // check that the sender is this extension's ui/approve.html in a top frame, this is what binds a confirm to the one
  // window the worker opened for that one request: its random id, which only that window's URL carries, and the
  // window's id, which Chrome reports for the sender and no page sets. A settled approval is NOT_FOUND, so an id
  // confirms once.
  async function approvalForPage(id, meta) {
    const entry = slot;
    if (entry === null || entry.approval.id !== id) throw notFound();
    if (entry.windowId === null) await entry.opened;
    const windowId = meta?.sender?.tab?.windowId;
    if (slot !== entry || entry.approval.settled || entry.windowId === null || windowId !== entry.windowId) {
      throw notFound();
    }
    return entry.approval;
  }

  function rejectWhere(predicate, error) {
    for (const approval of [...queue]) {
      if (approval.busy || !predicate(approval)) continue;
      settle(approval, error);
      release(approval);
    }
  }

  async function disconnectOrigin(origin, notifyAlways) {
    const revoked = await removeGrant(origin);
    // sign and send need the grant; a connect asks for one and an activation never uses one
    rejectWhere((a) => a.ctx.origin === origin && (a.kind === 'signMessage' || TX_KINDS.has(a.kind)),
      new WalletError('UNAUTHORIZED'));
    if (revoked || notifyAlways) {
      emit(origin, 'accountsChanged', {});
      emit(origin, 'disconnect', null);
    }
    return revoked;
  }

  // -------------------------------------------------------------- previews and actions

  // The account part of every transaction preview, checked: whether balance and nonce come from a committee-certified
  // proof, the earlier transactions not seen applied, the refused one this takes the place of, and whether one still
  // holds the nonce.
  function accountView(preview) {
    // only a proof folded to a committee-certified root verifies a balance (EXT-CHAINS-04)
    const verified = preview.verified === true && preview.verification === 'proof';
    const verification = verified ? 'proof' : 'none';
    // earlier transactions of this wallet not seen applied: the window names them (R2-EXTQ-03)
    const outstanding = Array.isArray(preview.outstanding) ? preview.outstanding.filter(isPlainObject) : [];
    // a transaction a node refused, which this one takes the place of at its nonce (R5-EXTQ-02): the window names it
    const target = typeof preview.replacesNonce === 'string'
      ? outstanding.find((p) => p.nonce === preview.replacesNonce && p.refused === true) : undefined;
    const replaces = target !== undefined && core.isValidQnetAddress(target.to) && isU64String(target.amountNano)
      && target.nonce === preview.nonce ? Object.freeze({
        nonce: target.nonce, to: target.to, amountNano: target.amountNano, kind: target.kind === 'call' ? 'call' : 'transfer',
      }) : null;
    // the node admits only the committed nonce + 1: behind a transaction not in a block yet, confirm waits
    return { verified, verification, outstanding, replaces, inFlight: preview.inFlight === true };
  }

  function checkedPreview(preview, { to, amountNano }) {
    const ok = isPlainObject(preview) && preview.to === to && preview.amountNano === amountNano
      && ['feeNano', 'totalNano', 'nonce', 'balanceNano'].every((name) => isU64String(preview[name]))
      && BigInt(preview.totalNano) === BigInt(amountNano) + BigInt(preview.feeNano);
    if (!ok) throw new WalletError('INTERNAL');
    const { verified, verification, outstanding, replaces, inFlight } = accountView(preview);
    return Object.freeze({
      feeNano: preview.feeNano,
      totalNano: preview.totalNano,
      nonce: preview.nonce,
      balanceNano: preview.balanceNano,
      verified,
      verification,
      outstanding: outstanding.length,
      // qnet.prepareTransfer's own records: outstanding or signed in the last 30 minutes (R3-EXTQ-01)
      duplicate: preview.duplicate === true || outstanding.some((p) => p.kind !== 'call' && p.to === to && p.amountNano === amountNano),
      replaces,
      inFlight,
    });
  }

  // qnet.prepareCall's answer for a tokenTransfer or contractCall approval, checked against its request.
  function checkedCallPreview(preview, approval) {
    const { kind, payload } = approval;
    const token = kind === 'tokenTransfer';
    const ok = isPlainObject(preview) && preview.kind === kind && preview.contract === (token ? payload.token : payload.contract)
      && ['gasLimit', 'feeNano', 'depositNano', 'totalNano', 'nonce', 'balanceNano'].every((name) => isU64String(preview[name]))
      && BigInt(preview.totalNano) === BigInt(preview.feeNano) + BigInt(preview.depositNano)
      && (token
        ? preview.to === payload.to && preview.amountBase === payload.amountBase
          && (preview.tokenBalance === null || (typeof preview.tokenBalance === 'string' && U128_RE.test(preview.tokenBalance)))
          && (preview.tokenBalance === null ? BALANCE_PROBLEMS.has(preview.tokenProblem) : preview.tokenProblem === null)
        : preview.method === payload.method && preview.args === payload.args && preview.depositNano === '0');
    if (!ok) throw new WalletError('INTERNAL');
    const { verified, verification, outstanding, replaces, inFlight } = accountView(preview);
    const common = {
      gasLimit: preview.gasLimit,
      feeNano: preview.feeNano,
      totalNano: preview.totalNano,
      nonce: preview.nonce,
      balanceNano: preview.balanceNano,
      verified,
      verification,
      outstanding: outstanding.length,
      replaces,
      inFlight,
    };
    if (!token) return Object.freeze(common);
    return Object.freeze({
      ...common, depositNano: preview.depositNano, tokenBalance: preview.tokenBalance, tokenProblem: preview.tokenProblem,
      duplicate: preview.duplicate === true,
    });
  }

  const RECIPIENT_FLAGS = Object.freeze(['known', 'lookalike', 'incomingOnly', 'historyRead', 'recentSame']);

  // Why a preview found no balance to decide by, as the window says it: no node answered, none certified a recent state,
  // or a transaction from another device is not confirmed yet; null for any other failure.
  const balanceProblemOf = (error) => (error instanceof WalletError && BALANCE_PROBLEMS.has(error.code) ? error.code : null);

  // Read once per approval; a failed read is tried again on the next approval.get.
  async function loadRecipient(approval) {
    if (approval.recipient !== null) return;
    try {
      // a QNC amount names a same-amount payment; a token amount is in other units
      const check = await d.qnet.recipientCheck(approval.payload.to, approval.payload.amountNano ?? null);
      const ok = isPlainObject(check) && RECIPIENT_FLAGS.slice(0, 4).every((name) => typeof check[name] === 'boolean');
      if (!ok) throw new WalletError('INTERNAL');
      const { known, lookalike, incomingOnly, historyRead } = check;
      approval.recipient = Object.freeze({ known, lookalike, incomingOnly, historyRead, recentSame: check.recentSame === true });
    } catch (error) {
      log.warn('recipient check unavailable', error?.code ?? error?.name);
    }
  }

  // A read of this approval's details may be stored only while it is the latest one started and no confirm
  // is running or done: a read that finishes after a confirm never changes what that confirm uses
  // (R2-EXT-UI-03).
  const stillCurrent = (approval, generation) => generation === approval.readGen && !approval.busy && !approval.settled;

  async function transferDetails(approval, current) {
    const { to, amountNano } = approval.payload;
    if (current === null) {
      approval.preview = null;
    } else if (!approval.busy) {
      approval.readGen += 1;
      const generation = approval.readGen;
      const [prepared] = await Promise.allSettled([
        Promise.resolve().then(() => d.qnet.prepareTransfer({ to, amountNano }))
          .then((preview) => checkedPreview(preview, approval.payload)),
        loadRecipient(approval),
      ]);
      // on failure the last preview served (if any) stays the one a confirm signs
      if (prepared.status === 'fulfilled') {
        if (stillCurrent(approval, generation)) {
          approval.preview = prepared.value;
          approval.balanceProblem = null;
        }
      } else {
        log.warn('transfer preview failed', prepared.reason?.code ?? prepared.reason?.name);
        if (stillCurrent(approval, generation)) approval.balanceProblem = balanceProblemOf(prepared.reason);
      }
    }
    const recipient = current === null || approval.recipient === null ? null : { ...approval.recipient };
    const { preview } = approval;
    if (preview === null) {
      const feeNano = String(d.qnet.transferFeeNano());
      const totalNano = (BigInt(amountNano) + BigInt(feeNano)).toString();
      return {
        to, amountNano, feeNano, totalNano, nonce: null, balanceNano: null, verified: false, verification: 'none',
        balanceProblem: current === null ? null : approval.balanceProblem ?? null, outstanding: 0, duplicate: false, replaces: null,
        inFlight: false, recipient,
      };
    }
    return { to, amountNano, ...preview, balanceProblem: null, recipient };
  }

  // The request's own part of a token transfer or contract call view, fixed for the approval's life.
  function callBase(approval) {
    const { payload } = approval;
    if (approval.kind === 'tokenTransfer') {
      const { name, symbol, decimals, reserved } = payload.info;
      return {
        token: payload.token, to: payload.to, amount: payload.amount, amountBase: payload.amountBase, name, symbol, decimals,
        reserved: reserved === true || core.usesReservedName(symbol, name), burn: core.destroysTokens(payload.to),
      };
    }
    return {
      contract: payload.contract, method: payload.method, args: payload.args, argsBytes: payload.args.length / 2, argsText: payload.argsText,
    };
  }

  // What qnet.prepareCall builds for this approval.
  function callRequest(approval) {
    const { payload } = approval;
    if (approval.kind === 'tokenTransfer') {
      return { kind: 'tokenTransfer', token: payload.token, to: payload.to, amountBase: payload.amountBase };
    }
    return { kind: 'contractCall', contract: payload.contract, method: payload.method, args: payload.args, gasLimit: payload.gasLimit };
  }

  // A token transfer or contract call view: read again on every approval.get while not busy, as a transfer's; until
  // a preview was read its fee, nonce and balances are null.
  async function callDetails(approval, current) {
    const token = approval.kind === 'tokenTransfer';
    if (current === null) {
      approval.preview = null;
    } else if (!approval.busy) {
      approval.readGen += 1;
      const generation = approval.readGen;
      const [prepared] = await Promise.allSettled([
        Promise.resolve().then(() => d.qnet.prepareCall(callRequest(approval))).then((preview) => checkedCallPreview(preview, approval)),
        token ? loadRecipient(approval) : null,
      ]);
      if (prepared.status === 'fulfilled') {
        if (stillCurrent(approval, generation)) {
          approval.preview = prepared.value;
          approval.balanceProblem = null;
        }
      } else {
        log.warn('call preview failed', prepared.reason?.code ?? prepared.reason?.name);
        if (stillCurrent(approval, generation)) approval.balanceProblem = balanceProblemOf(prepared.reason);
      }
    }
    const unread = {
      gasLimit: null, feeNano: null, totalNano: null, nonce: null, balanceNano: null, verified: false, verification: 'none',
      balanceProblem: current === null ? null : approval.balanceProblem ?? null, outstanding: 0, replaces: null, inFlight: false,
      ...(token ? { depositNano: null, tokenBalance: null, tokenProblem: null, duplicate: false } : {}),
    };
    const details = { ...callBase(approval), ...(approval.preview === null ? unread : { ...approval.preview, balanceProblem: null }) };
    if (!token) return details;
    return { ...details, recipient: current === null || approval.recipient === null ? null : { ...approval.recipient } };
  }

  const knownCode = (code) => (typeof code === 'string' && Object.hasOwn(ERROR_MESSAGES, code) ? code : null);

  // A registration view (nodes.publicRegistration) as a window may show it, or null.
  function checkedRegistration(registration) {
    if (registration === null || registration === undefined) return null;
    const ok = isPlainObject(registration) && /^light_mobile_[0-9a-f]{16}$/.test(registration.nodeId)
      && REGISTRATION_STATES.has(registration.state) && Number.isSafeInteger(registration.attempts) && registration.attempts >= 0
      && typeof registration.automatic === 'boolean';
    if (!ok) throw new WalletError('INTERNAL');
    return Object.freeze({
      nodeId: registration.nodeId, state: registration.state, automatic: registration.automatic, deferred: registration.deferred === true,
    });
  }

  // activation.siteView's answer, shape-checked, as the window may show it.
  function checkedSiteView(view) {
    const balancesOk = view?.balances === null
      || (isPlainObject(view?.balances) && isU64String(view.balances.lamports) && isU64String(view.balances.oneDevRaw));
    const ok = isPlainObject(view) && SITE_VIEW_MODES.has(view.mode)
      && (view.reason === null || knownCode(view.reason) !== null) && (view.mode === 'unavailable') === (view.reason !== null)
      && (view.cost === null || (Number.isSafeInteger(view.cost) && view.cost > 0))
      && (view.mode !== 'burn' || view.cost !== null)
      && (view.activation === null || isPlainObject(view.activation)) && (view.mode !== 'exists' || view.activation !== null)
      && (view.pending === null || isPlainObject(view.pending)) && (view.mode !== 'pending' || view.pending !== null)
      && balancesOk && typeof view.nodeChecked === 'boolean';
    if (!ok) throw new WalletError('INTERNAL');
    const { mode, reason, cost, activation: shown, pending, balances } = view;
    // the window draws only whether the chain lists the light node: a registration's other steps (queued, admitted,
    // deferred) never change what it reviews, so they never bump the revision nor redraw it (EXT-FA1-02)
    const registration = checkedRegistration(view.registration);
    return Object.freeze({
      mode, reason, cost, nodeChecked: view.nodeChecked,
      activation: shown === null ? null : { ...shown },
      pending: pending === null ? null : { ...pending },
      balances: balances === null ? null : { lamports: balances.lamports, oneDevRaw: balances.oneDevRaw },
      recorded: registration !== null && registration.state === 'onchain',
      otherBurn: registration !== null && registration.state === 'other_burn',
    });
  }

  // Read again on every approval.get while not busy; a failed read keeps the last view (if any).
  async function activationDetails(approval, current) {
    const { nodeType } = approval.payload;
    const base = {
      nodeType,
      solanaAddress: current === null ? null : current.solanaAddress,
      mint: SOLANA.ONE_DEV_MINT,
      tokenProgram: core.SOLANA_PROGRAMS.TOKEN,
      cluster: SOLANA.CLUSTER,
    };
    if (current === null) {
      return { ...base, mode: null, reason: null, cost: null, activation: null, pending: null, balances: null, recorded: null, otherBurn: null };
    }
    if (!approval.busy) {
      approval.readGen += 1;
      const generation = approval.readGen;
      try {
        const view = checkedSiteView(await d.activation.siteView(nodeType, { cost: approval.cost, nodeChecked: approval.nodeChecked }));
        if (stillCurrent(approval, generation)) {
          approval.view = view;
          approval.nodeChecked = view.nodeChecked;
          // the price a burn view showed stays the one confirmed for this approval (the burn re-checks it)
          if (view.mode === 'burn') approval.cost = view.cost;
        }
      } catch (error) {
        log.warn('activation view failed', error?.code ?? error?.name);
      }
    }
    const { view } = approval;
    if (view === null) {
      return { ...base, mode: null, reason: null, cost: null, activation: null, pending: null, balances: null, recorded: null, otherBurn: null };
    }
    const { mode, reason, cost, activation: shown, pending, balances, recorded, otherBurn } = view;
    return {
      ...base, mode, reason, cost,
      activation: shown === null ? null : { ...shown },
      pending: pending === null ? null : { ...pending },
      balances: balances === null ? null : { ...balances },
      recorded,
      otherBurn,
    };
  }

  // nodes.claimView's answer, shape-checked against this wallet's own light node.
  function checkedClaimView(view, current) {
    const ok = isPlainObject(view) && CLAIM_VIEW_MODES.has(view.mode)
      && (view.mode === 'unavailable' ? CLAIM_VIEW_REASONS.has(view.reason) : view.reason === null)
      && view.nodeId === core.lightNodeId(current.qnetAddress)
      && (view.mode === 'unavailable' ? view.amountNano === null : isU64String(view.amountNano))
      && (view.mode !== 'claim' || BigInt(view.amountNano) >= BigInt(CLAIM_MIN_NANO));
    if (!ok) throw new WalletError('INTERNAL');
    return Object.freeze({
      mode: view.mode, reason: view.reason, nodeId: view.nodeId, wallet: current.qnetAddress, amountNano: view.amountNano,
    });
  }

  // The claim window's view: read again on every approval.get while not busy; a failed read keeps the last one.
  async function claimDetails(approval, current) {
    const none = { mode: null, reason: null, nodeId: null, wallet: null, amountNano: null };
    if (current === null) {
      approval.view = null;
      return none;
    }
    if (!approval.busy) {
      approval.readGen += 1;
      const generation = approval.readGen;
      try {
        const view = checkedClaimView(await d.nodes.claimView(), current);
        if (stillCurrent(approval, generation)) approval.view = view;
      } catch (error) {
        log.warn('claim view failed', error?.code ?? error?.name);
      }
    }
    return approval.view === null ? none : { ...approval.view };
  }

  // nodes.unlinkView's answer, shape-checked against this wallet's own light node.
  function checkedUnlinkView(view, current) {
    const confirm = isPlainObject(view) && view.mode === 'confirm';
    const ok = isPlainObject(view) && (confirm || view.mode === 'unavailable')
      && (confirm ? view.reason === null : UNLINK_VIEW_REASONS.has(view.reason))
      && view.nodeId === core.lightNodeId(current.qnetAddress)
      && (confirm ? DEVICE_PLATFORMS.has(view.platform) : view.platform === null)
      && (view.linkedSince === null || (confirm && Number.isSafeInteger(view.linkedSince) && view.linkedSince > 0));
    if (!ok) throw new WalletError('INTERNAL');
    return Object.freeze({
      mode: view.mode, reason: view.reason, nodeId: view.nodeId, wallet: current.qnetAddress, platform: view.platform,
      linkedSince: view.linkedSince,
    });
  }

  // The unlink window's view: read again on every approval.get while not busy; a failed read keeps the last one.
  async function unlinkDetails(approval, current) {
    const none = { mode: null, reason: null, nodeId: null, wallet: null, platform: null, linkedSince: null };
    if (current === null) {
      approval.view = null;
      return none;
    }
    if (!approval.busy) {
      approval.readGen += 1;
      const generation = approval.readGen;
      try {
        const view = checkedUnlinkView(await d.nodes.unlinkView(), current);
        if (stillCurrent(approval, generation)) approval.view = view;
      } catch (error) {
        log.warn('unlink view failed', error?.code ?? error?.name);
      }
    }
    return approval.view === null ? none : { ...approval.view };
  }

  async function approvalDetails(approval, current) {
    if (approval.kind === 'connect') {
      const grant = await grantOf(approval.ctx.origin).catch(() => null);
      return { alreadyGranted: grant !== null };
    }
    if (approval.kind === 'signMessage') {
      return { message: approval.payload.message, byteLength: approval.payload.byteLength };
    }
    if (approval.kind === 'activateNode') return activationDetails(approval, current);
    if (approval.kind === 'claimNodeBalance') return claimDetails(approval, current);
    if (approval.kind === 'unlinkNodeDevice') return unlinkDetails(approval, current);
    if (approval.kind === 'tokenTransfer' || approval.kind === 'contractCall') return callDetails(approval, current);
    return transferDetails(approval, current);
  }

  function keyMatches(publicKey, address) {
    try {
      return core.qnetAddressFromPublicKey(publicKey) === address;
    } catch {
      return false;
    }
  }

  async function signMessage(origin, message, current) {
    const signed = await d.keys.signOffchain(origin, message);
    // The signature must cover exactly this origin's wrapped message under this wallet's key.
    const ok = isPlainObject(signed) && signed.address === current.qnetAddress
      && keyMatches(signed.publicKey, current.qnetAddress)
      && core.verifyOffchainMessage(origin, message, signed.signature, signed.publicKey);
    if (!ok) throw new WalletError('INTERNAL');
    return {
      signature: core.bytesToHex(signed.signature),
      publicKey: core.bytesToHex(signed.publicKey),
      address: signed.address,
    };
  }

  // The dApp's result: the transfer's identity is (from, nonce), at most one transaction of `from` applies at a nonce;
  // txHash is the hash one node gave its own copy, and another node's copy (another hash) may be the one that lands
  // (R2-EXTQ-06, R5-EXTQ-03): a dApp matches the payment by from and nonce.
  async function submitTransfer(approval, current) {
    const { preview } = approval;
    if (preview === null) throw new WalletError('NONCE_UNAVAILABLE');
    const { to, amountNano } = approval.payload;
    const sent = await d.qnet.sendTransfer({
      to, amountNano, expectedFeeNano: preview.feeNano, expectedNonce: preview.nonce, oneInFlight: true,
    });
    const txHash = typeof sent?.txHash === 'string' && TX_HASH_RE.test(sent.txHash) ? sent.txHash : null;
    return {
      // submitted: a node took it and named its copy (the mobile in-app browser's rule)
      status: sent?.status === 'submitted' && txHash !== null ? 'submitted' : 'unknown',
      from: current.qnetAddress,
      to,
      amount: formatUnits(BigInt(amountNano), DECIMALS.QNC),
      nonce: isU64String(sent?.nonce) ? sent.nonce : preview.nonce,
      txHash,
    };
  }

  // A token transfer's or contract call's result, as a transfer's: (from, nonce) is its identity and txHash one node's
  // copy. It says submitted, never succeeded: the node keeps no outcome of a call.
  async function submitCall(approval, current) {
    const { preview, payload } = approval;
    if (preview === null) throw new WalletError('NONCE_UNAVAILABLE');
    const sent = await d.qnet.sendCall({
      request: callRequest(approval), expectedFeeNano: preview.feeNano, expectedDepositNano: preview.depositNano ?? '0',
      expectedNonce: preview.nonce, oneInFlight: true,
    });
    const nonce = isU64String(sent?.nonce) ? sent.nonce : preview.nonce;
    const txHash = typeof sent?.txHash === 'string' && TX_HASH_RE.test(sent.txHash) ? sent.txHash : null;
    const status = sent?.status === 'submitted' && txHash !== null ? 'submitted' : 'unknown';
    if (approval.kind === 'tokenTransfer') {
      return { status, from: current.qnetAddress, token: payload.token, to: payload.to, amount: payload.amount, nonce, txHash };
    }
    return { status, from: current.qnetAddress, contract: payload.contract, method: payload.method, nonce, txHash };
  }

  async function perform(approval, current) {
    const { origin } = approval.ctx;
    if (approval.kind === 'connect') {
      await writeGrant(origin, current.walletId);
      return accountsOf(current);
    }
    const grant = await grantOf(origin);
    if (grant === null || grant.walletId !== current.walletId) throw new WalletError('UNAUTHORIZED');
    if (approval.kind === 'signMessage') return signMessage(origin, approval.payload.message, current);
    if (approval.kind === 'tokenTransfer' || approval.kind === 'contractCall') return submitCall(approval, current);
    return submitTransfer(approval, current);
  }

  // The dApp result of an activation outcome (activation.activateForSite), checked once more: the
  // wallet's own addresses, a well-formed burn, and for a code the node's derivation of that burn.
  // `solana` names the address that burned, so the site derives the code from it: the wallet's. A `pending` burn
  // may be another device's, Solana-confirmed and not final yet (QNet Link v1 section 7, XP-R2-05).
  function siteResult(outcome, current, requestedType) {
    const burnOk = (b) => isPlainObject(b) && core.ACTIVATION_NODE_TYPES.includes(b.nodeType)
      && core.isValidSolanaSignature(b.burnTx) && Number.isSafeInteger(b.burnAmount) && b.burnAmount > 0
      && b.solanaAddress === current.solanaAddress;
    if (outcome?.status === 'pending' && burnOk(outcome.pending)) {
      const { nodeType, burnTx, burnAmount, solanaAddress } = outcome.pending;
      return { status: 'pending', qnet: current.qnetAddress, solana: solanaAddress, nodeType, burnTx, burnAmount };
    }
    const a = outcome?.activation;
    const ok = (outcome?.status === 'exists' || (outcome?.status === 'ok' && a?.nodeType === requestedType)) && burnOk(a)
      && typeof a.code === 'string' && core.ACTIVATION_CODE_RE.test(a.code)
      && core.generateActivationCode(a.nodeType, a.solanaAddress, a.burnTx, a.burnAmount) === a.code;
    if (!ok) throw new WalletError('INTERNAL');
    const result = {
      status: outcome.status, qnet: current.qnetAddress, solana: a.solanaAddress, nodeType: a.nodeType, burnTx: a.burnTx,
      burnAmount: a.burnAmount, code: a.code,
    };
    if (outcome.status !== 'exists') return result;
    // the burn this device sent from the wallet's own address, final and beaten by another device's older burn of the
    // phrase: the answer names it (section 7.1)
    const own = outcome.superseded;
    const superseded = isPlainObject(own) && core.isValidSolanaSignature(own.burnTx) && own.burnTx !== a.burnTx
      && own.solanaAddress === current.solanaAddress && a.solanaAddress === current.solanaAddress;
    return superseded ? { ...result, supersededBurnTx: own.burnTx } : result;
  }

  // A confirm whose window the user closed while it ran and that ended without an outcome (a retry the window
  // would have offered: review again, an unlock): the request ends as a closed window
  // ends it, 4001 and a counted rejection, instead of waiting in the queue with no window and no timer to pop
  // up again for another origin's request (R3-ERP-02). true when it ended here.
  function endIfWindowClosed(approval) {
    if (!approval.windowClosed || approval.settled) return false;
    if (settle(approval, new ProviderError(CODES.USER_REJECTED)) && (offered(approval) || repeated(approval.ctx.origin))) {
      recordRejection(approval.ctx.origin);
    }
    pump();
    return true;
  }

  // Ends an activation or claim approval with a dApp result (never an error) and keeps its window on the outcome.
  function finishActivation(approval, result, lingerMs = ERROR_LINGER_MS) {
    if (settle(approval, null, result) && slot?.approval === approval) arm(approval, lingerMs, () => release(approval));
  }

  // The registration of the wallet's light node after an activation answer, for its window; null when there is none
  // or it cannot be read now.
  async function registrationAfter(result) {
    if (result.status !== 'ok' && result.status !== 'exists') return null;
    try {
      return checkedRegistration((await d.nodes.getRegistration())?.registration ?? null);
    } catch (error) {
      log.warn('registration unreadable', error?.code ?? error?.name);
      return null;
    }
  }

  // approval.resolve of an activateNode approval. A window that could not offer the action (mode
  // 'unavailable') answers the dApp with its reason and counts no rejection; a reject is a reject; a
  // confirm (the armed press, with the burn's acknowledgement, in the approval's own window; no password) runs
  // activation.activateForSite with, for a burn, the price the window showed.
  async function resolveActivation(approval, params) {
    const mode = approval.view?.mode ?? null;
    if (mode === 'unavailable') {
      const { reason } = approval.view;
      settle(approval, null, siteError(reason));
      if (repeated(approval.ctx.origin)) recordRejection(approval.ctx.origin);
      release(approval);
      return { resolved: true, status: 'error', error: reason };
    }
    if (params.approved !== true) {
      settle(approval, new ProviderError(CODES.USER_REJECTED));
      recordRejection(approval.ctx.origin);
      release(approval);
      return { resolved: true };
    }
    approval.busy = true;
    let current;
    let outcome;
    try {
      current = await d.session.requireUnlocked();
      // nothing reviewed yet (the view could not be read, or the wallet is still being checked), or the page confirmed a
      // view other than the last one served (R2-ERP-04: a heartbeat turned 'pending' into 'burn' before the page drew
      // it): review first
      if (mode === null || mode === 'checking' || params.revision !== approval.revision) throw new WalletError('PRICE_CHANGED');
      outcome = await d.activation.activateForSite({
        nodeType: approval.payload.nodeType,
        expectedPrice: mode === 'burn' ? approval.cost : null,
      });
    } catch (error) {
      approval.busy = false;
      const code = knownCode(error?.code) ?? 'INTERNAL';
      if (RETRY_IN_WINDOW.has(code) && !approval.settled) {
        if (endIfWindowClosed(approval)) throw error;
        if (code === 'PRICE_CHANGED') {
          approval.cost = null;
          approval.view = null;
          queueChanged();
        }
        throw error;
      }
      finishActivation(approval, siteError(code));
      balanceChanged();
      return { resolved: true, status: 'error', error: code };
    }
    approval.busy = false;
    let result;
    try {
      result = siteResult(outcome, current, approval.payload.nodeType);
    } catch (error) {
      log.error('activation result refused', error?.code ?? error?.name);
      result = siteError('INTERNAL');
    }
    // a light node being recorded on the QNet network: the window shows it up to REGISTRATION_WINDOW_MS
    const registration = await registrationAfter(result);
    finishActivation(approval, result, registration?.automatic && !registration.deferred ? TIMINGS.REGISTRATION_WINDOW_MS : ERROR_LINGER_MS);
    if (result.status !== 'error') clearCooldown(approval.ctx.origin);
    balanceChanged();
    // the window names the burn it sent when another device's older burn of the phrase is the activation (XP-R5-03), as
    // the site's answer does in supersededBurnTx (siteResult)
    const own = outcome?.superseded;
    const superseded = result.status === 'exists' && isPlainObject(own) && core.isValidSolanaSignature(own.burnTx)
      && core.ACTIVATION_NODE_TYPES.includes(own.nodeType) && Number.isSafeInteger(own.burnAmount) && own.burnAmount > 0
      && own.solanaAddress === current.solanaAddress
      ? { burnTx: own.burnTx, nodeType: own.nodeType, burnAmount: own.burnAmount } : null;
    // the node type of the code the site received: the window adds the server's next step for a Super code (decision 36)
    const coded = result.status === 'ok' || result.status === 'exists';
    return {
      resolved: true, status: result.status, error: result.status === 'error' ? result.error : null, ...(superseded ? { superseded } : {}),
      ...(coded ? { nodeType: result.nodeType } : {}), ...(registration ? { registration } : {}),
    };
  }

  // The dApp result of a claim outcome (nodes.claimForSite), checked once more: this wallet's own node, a move with a
  // transaction hash of at least CLAIM_MIN_NANO (a full batch) or above zero (a part of the balance, with the epoch its
  // quote stopped at: EXT-R1-03), or an empty balance.
  function claimResult(outcome, current) {
    const nodeId = core.lightNodeId(current.qnetAddress);
    if (outcome?.status === 'empty' && outcome.qnet === current.qnetAddress && outcome.nodeId === nodeId) {
      return { status: 'empty', qnet: current.qnetAddress, nodeId };
    }
    const partial = isU64String(outcome?.stoppedAtEpoch);
    const ok = outcome?.status === 'ok' && outcome.qnet === current.qnetAddress && outcome.nodeId === nodeId
      && (outcome.stoppedAtEpoch === null || partial)
      && isU64String(outcome.amountNano) && BigInt(outcome.amountNano) >= (partial ? 1n : BigInt(CLAIM_MIN_NANO))
      && typeof outcome.txHash === 'string' && HASH_HEX_RE.test(outcome.txHash);
    if (!ok) throw new WalletError('INTERNAL');
    return {
      status: 'ok', qnet: current.qnetAddress, nodeId, amountNano: outcome.amountNano, txHash: outcome.txHash,
      stoppedAtEpoch: outcome.stoppedAtEpoch,
    };
  }

  // approval.resolve of a claimNodeBalance approval. A window that could not offer the move (unavailable, or a balance
  // below the minimum) answers the dApp with that and counts no rejection; a reject is a reject; a confirm of the view
  // the page drew runs nodes.claimForSite.
  async function resolveClaim(approval, params) {
    const view = approval.view;
    if (view?.mode === 'unavailable' || view?.mode === 'empty') {
      const result = view.mode === 'empty' ? { status: 'empty', qnet: view.wallet, nodeId: view.nodeId } : claimError(view.reason);
      settle(approval, null, result);
      if (repeated(approval.ctx.origin)) recordRejection(approval.ctx.origin);
      release(approval);
      return { resolved: true, status: result.status, error: result.error ?? null };
    }
    if (params.approved !== true) {
      settle(approval, new ProviderError(CODES.USER_REJECTED));
      recordRejection(approval.ctx.origin);
      release(approval);
      return { resolved: true };
    }
    // nothing reviewed yet, or not the view the page drew: review again
    if (view === null || params.revision !== approval.revision) throw new WalletError('NONCE_CHANGED');
    approval.busy = true;
    let current;
    let result;
    try {
      current = await d.session.requireUnlocked();
      result = claimResult(await d.nodes.claimForSite(), current);
    } catch (error) {
      approval.busy = false;
      const code = knownCode(error?.code) ?? 'INTERNAL';
      if (code === 'LOCKED' && !approval.settled) {
        endIfWindowClosed(approval);
        throw error;
      }
      finishActivation(approval, claimError(code));
      balanceChanged();
      return { resolved: true, status: 'error', error: claimError(code).error };
    }
    approval.busy = false;
    finishActivation(approval, result);
    clearCooldown(approval.ctx.origin);
    balanceChanged();
    return {
      resolved: true, status: result.status, error: null, amountNano: result.amountNano ?? null,
      partial: typeof result.stoppedAtEpoch === 'string',
    };
  }

  // The dApp result of an unlink (nodes.unlinkForSite), checked once more: this wallet's own node, taken by the network.
  function unlinkResult(outcome, current) {
    const nodeId = core.lightNodeId(current.qnetAddress);
    const ok = outcome?.status === 'ok' && outcome.qnet === current.qnetAddress && outcome.nodeId === nodeId && outcome.unbound === true;
    if (!ok) throw new WalletError('INTERNAL');
    return { status: 'ok', qnet: current.qnetAddress, nodeId, unbound: true };
  }

  // approval.resolve of an unlinkNodeDevice approval (decision 38). A window that could not offer the unlink answers the
  // dApp with its reason and counts no rejection the first time; a reject is a reject; a confirm of the view the page
  // drew runs nodes.unlinkForSite.
  async function resolveUnlink(approval, params) {
    const view = approval.view;
    if (view?.mode === 'unavailable') {
      const result = unlinkError(view.reason);
      settle(approval, null, result);
      if (repeated(approval.ctx.origin)) recordRejection(approval.ctx.origin);
      release(approval);
      return { resolved: true, status: result.status, error: result.error };
    }
    if (params.approved !== true) {
      settle(approval, new ProviderError(CODES.USER_REJECTED));
      recordRejection(approval.ctx.origin);
      release(approval);
      return { resolved: true };
    }
    if (view === null || params.revision !== approval.revision) throw new WalletError('NONCE_CHANGED');
    approval.busy = true;
    let result;
    try {
      const current = await d.session.requireUnlocked();
      result = unlinkResult(await d.nodes.unlinkForSite(), current);
    } catch (error) {
      approval.busy = false;
      const code = knownCode(error?.code) ?? 'INTERNAL';
      if (code === 'LOCKED' && !approval.settled) {
        endIfWindowClosed(approval);
        throw error;
      }
      finishActivation(approval, unlinkError(code));
      // the window names the wallet's own reason (UNSUPPORTED is no wallet code: the view gave it)
      return { resolved: true, status: 'error', error: code };
    }
    approval.busy = false;
    finishActivation(approval, result);
    clearCooldown(approval.ctx.origin);
    return { resolved: true, status: 'ok', error: null };
  }

  function afterConnect(origin, accounts) {
    emit(origin, 'accountsChanged', { ...accounts });
    for (const other of [...queue]) {
      if (other.kind === 'connect' && other.ctx.origin === origin && !other.busy && slot?.approval !== other) {
        settle(other, null, { ...accounts });
      }
    }
  }

  // -------------------------------------------------------------- entry points

  async function requestSignature(ctx, params) {
    if ((await grantOf(ctx.origin)) === null) throw new ProviderError(CODES.UNAUTHORIZED);
    const message = params?.message;
    core.buildOffchainMessage(ctx.origin, message); // CoreError → -32602, before any window
    return enqueue(ctx, 'signMessage', { message, byteLength: core.utf8Encode(message).length });
  }

  // The checks enqueue makes, before a request reads the network for its window: a site in its cooldown or past
  // its window budget costs no node reads.
  function mayEnqueue(ctx) {
    if (!livePorts.has(ctx.portId)) throw new ProviderError(CODES.USER_REJECTED);
    if (inCooldown(ctx.origin) || budgetSpent(ctx.origin)) throw new WalletError('APPROVAL_COOLDOWN');
  }

  // A transfer's recipient, before any window: a contract (two nodes agreeing) would keep the QNC or tokens for good,
  // so the site learns -32602 (RECIPIENT_IS_CONTRACT); a recipient no two nodes agree on is -32603
  // (qnet.assertPayableRecipient, read again at the confirm).
  async function requestTransfer(ctx, params) {
    const to = params?.to;
    if (!core.isValidQnetAddress(to)) throw new WalletError('INVALID_ADDRESS');
    const amountNano = parseUnits(params?.amount, DECIMALS.QNC);
    if (amountNano <= 0n || amountNano + BigInt(d.qnet.transferFeeNano()) > U64_MAX) throw new WalletError('INVALID_AMOUNT');
    mayEnqueue(ctx);
    await d.qnet.assertPayableRecipient(to);
    return enqueue(ctx, 'sendTransaction', { to, amountNano: amountNano.toString() });
  }

  // A built-in token's transfer: the token's decimals (two nodes agreeing) turn the decimal amount into base units
  // exactly, before any window; a contract that is no QRC-20 token, or an amount with more decimals than the token
  // has, is invalid input, and so is a recipient that is a contract (the token itself included), as for a transfer.
  async function requestTokenTransfer(ctx, params) {
    const { token, to } = params ?? {};
    if (!core.isValidQnetAddress(token) || !core.isValidQnetAddress(to)) throw new WalletError('INVALID_ADDRESS');
    mayEnqueue(ctx);
    const info = await d.qnet.readContract(token);
    if (info?.kind !== 'token' || info.standard !== 'qrc20' || !Number.isSafeInteger(info.decimals) || info.decimals > TOKEN_DECIMALS_MAX) {
      throw new WalletError('INVALID_PARAMS', { field: 'token' });
    }
    await d.qnet.assertPayableRecipient(to);
    const amountBase = parseUnits(params.amount, info.decimals);
    if (amountBase <= 0n) throw new WalletError('INVALID_AMOUNT');
    const text = (value) => (typeof value === 'string' && value.length <= 64 && core.isVisibleText(value) ? value : '');
    return enqueue(ctx, 'tokenTransfer', {
      token, to, amountBase: amountBase.toString(), amount: formatUnits(amountBase, info.decimals),
      // reserved: named after QNet's own coin as deployed, before its name was made safe to show (qnet.readContract)
      info: Object.freeze({ name: text(info.name), symbol: text(info.symbol), decimals: info.decimals, reserved: info.reserved === true }),
    });
  }

  // A call of a WASM contract: the address must hold a contract that is no built-in token (a token moves with
  // tokenTransfer), as two nodes agree, before any window. The input ('' for none) is shown as UTF-8 too when it reads
  // as text.
  async function requestContractCall(ctx, params) {
    const { contract, method, args, gasLimit } = params ?? {};
    if (!core.isValidQnetAddress(contract)) throw new WalletError('INVALID_ADDRESS');
    if (typeof method !== 'string' || typeof args !== 'string' || (gasLimit !== undefined && !Number.isSafeInteger(gasLimit))) {
      throw new WalletError('INVALID_PARAMS');
    }
    mayEnqueue(ctx);
    const target = await d.qnet.readContract(contract);
    if (target?.kind !== 'contract') throw new WalletError('INVALID_PARAMS', { field: 'contract' });
    let argsText = null;
    if (args !== '') {
      try {
        const text = strictUtf8.decode(core.hexToBytes(args));
        argsText = core.isVisibleText(text) ? text : null;
      } catch {
        argsText = null;
      }
    }
    return enqueue(ctx, 'contractCall', {
      contract, method, args, argsText, gasLimit: gasLimit === undefined ? null : String(gasLimit),
    });
  }

  // qnet_sendTransaction: the router normalized the params to one type (a request without one is a transfer).
  async function requestTransaction(ctx, params) {
    if ((await grantOf(ctx.origin)) === null) throw new ProviderError(CODES.UNAUTHORIZED);
    const type = params?.type ?? 'transfer';
    if (type === 'transfer') return requestTransfer(ctx, params);
    if (type === 'tokenTransfer') return requestTokenTransfer(ctx, params);
    if (type === 'contractCall') return requestContractCall(ctx, params);
    throw new WalletError('INVALID_PARAMS', { field: 'type' });
  }

  // The origin's status reads: when each read of the last minute started, and the answers still given again.
  function statusEntry(origin, now) {
    let entry = statusReads.get(origin);
    if (entry === undefined) {
      entry = { reads: [], answers: new Map() };
      statusReads.set(origin, entry);
      while (statusReads.size > STATUS_ORIGINS_MAX) statusReads.delete(statusReads.keys().next().value);
    }
    // a clock set back never makes a read count longer than the window
    entry.reads = entry.reads.filter((at) => at <= now && now - at < STATUS_WINDOW_MS);
    return entry;
  }

  // qnet.transactionStatus's answer as the site may see it: a hash and a height only for a transaction in a block, and
  // 'unknown' for a failed read or an answer that is not about this (from, nonce), as the mobile in-app browser answers.
  function statusAnswer(answer, from, nonce) {
    const ok = isPlainObject(answer) && STATUSES.has(answer.status) && answer.from === from && answer.nonce === nonce;
    const status = ok ? answer.status : 'unknown';
    const inBlock = status === 'in_block';
    return {
      status,
      blockHeight: inBlock && Number.isSafeInteger(answer.blockHeight) && answer.blockHeight >= 0 ? answer.blockHeight : null,
      txHash: inBlock && typeof answer.txHash === 'string' && TX_HASH_RE.test(answer.txHash) ? answer.txHash : null,
    };
  }

  // qnet_getTransactionStatus: the connected account's own transactions only, no window; rate-limited per origin.
  async function requestStatus(ctx, params) {
    const accounts = await accountsFor(ctx.origin);
    const { from, nonce } = params ?? {};
    if (accounts === null || from !== accounts.qnet) throw new ProviderError(CODES.UNAUTHORIZED);
    const now = d.now();
    const entry = statusEntry(ctx.origin, now);
    const key = `${from}:${nonce}`;
    const known = entry.answers.get(key);
    if (known !== undefined && known.at <= now && now - known.at < STATUS_FRESH_MS) return known.answer;
    if (entry.reads.length >= STATUS_READS_PER_MINUTE) throw new ProviderError(CODES.USER_REJECTED);
    entry.reads.push(now);
    const answer = Promise.resolve()
      .then(() => d.qnet.transactionStatus({ from, nonce }))
      .then((read) => statusAnswer(read, from, nonce), (error) => {
        log.warn('transaction status unavailable', error?.code ?? error?.name);
        return statusAnswer(null, from, nonce);
      });
    entry.answers.delete(key);
    entry.answers.set(key, { at: now, answer });
    while (entry.answers.size > STATUS_ANSWERS_MAX) entry.answers.delete(entry.answers.keys().next().value);
    return answer;
  }

  // activation.siteActivation's answer, checked once more before it leaves (decision 35): the wallet's own addresses, a
  // known status with exactly its keys, a well-formed burn, and a code that is the node's derivation of that burn (the
  // wallet's own Solana address, or for a burn aiqnet.io paid its QNet address). Anything else is INTERNAL (-32603).
  function checkedRead(read, current) {
    const own = isPlainObject(read) && read.qnet === current.qnetAddress && read.solana === current.solanaAddress
      && READ_STATUSES.has(read.status);
    const keysOk = (...extra) => own && Object.keys(read).sort().join(',') === ['qnet', 'solana', 'status', ...extra].sort().join(',');
    const burnOk = () => core.ACTIVATION_NODE_TYPES.includes(read.nodeType) && core.isValidSolanaSignature(read.burnTx)
      && Number.isSafeInteger(read.burnAmount) && read.burnAmount > 0;
    let ok = false;
    if (read?.status === 'unknown') ok = keysOk('reason') && READ_REASONS.has(read.reason);
    else if (read?.status === 'pending') ok = keysOk('nodeType', 'burnTx', 'burnAmount') && burnOk();
    else if (read?.status === 'exists') {
      ok = keysOk('nodeType', 'burnTx', 'burnAmount', 'code', 'paidOnSite') && burnOk() && typeof read.paidOnSite === 'boolean'
        && typeof read.code === 'string' && core.ACTIVATION_CODE_RE.test(read.code)
        && (read.paidOnSite
          ? read.nodeType === 'light' && core.walletActivationCode(current.qnetAddress, read.burnTx, read.burnAmount) === read.code
          : core.generateActivationCode(read.nodeType, current.solanaAddress, read.burnTx, read.burnAmount) === read.code);
    } else ok = keysOk();
    if (!ok) throw new WalletError('INTERNAL');
    return { ...read };
  }

  // qnet_getActivation (decision 35): the extension's knowledge of the wallet's activation for aiqnet.io, read-only and
  // never a window (no queue, budget, cooldown, grant or event). The router already refused every other origin (checked
  // again); one origin makes at most LIMITS.ACTIVATION_READS_PER_MINUTE reads a minute (more: 4001).
  async function requestReadActivation(ctx) {
    if (!isActivationOrigin(ctx.origin)) throw new ProviderError(CODES.UNAUTHORIZED);
    const now = d.now();
    const reads = (activationReads.get(ctx.origin) ?? []).filter((at) => at <= now && now - at < READ_WINDOW_MS);
    if (reads.length >= LIMITS.ACTIVATION_READS_PER_MINUTE) {
      activationReads.set(ctx.origin, reads);
      throw new ProviderError(CODES.USER_REJECTED);
    }
    activationReads.set(ctx.origin, [...reads, now]);
    while (activationReads.size > STATUS_ORIGINS_MAX) activationReads.delete(activationReads.keys().next().value);
    if (!(await d.vault.vaultExists())) return { status: 'no_wallet' };
    const current = await unlockedSession();
    if (current === null) return { status: 'locked' };
    if ((await accountsFor(ctx.origin)) === null) return { status: 'not_connected' };
    let read;
    try {
      read = await d.activation.siteActivation();
    } catch (error) {
      if (error?.code === 'LOCKED') return { status: 'locked' };
      throw error;
    }
    return checkedRead(read, current);
  }

  // No grant is read, created or needed; the router already refused every other origin (checked again).
  async function requestActivation(ctx, params) {
    if (!isActivationOrigin(ctx.origin)) throw new ProviderError(CODES.UNAUTHORIZED);
    const nodeType = params?.nodeType;
    if (!core.ACTIVATION_NODE_TYPES.includes(nodeType)) throw new WalletError('INVALID_PARAMS', { field: 'nodeType' });
    if (!(await d.vault.vaultExists())) return siteError('NO_WALLET');
    return enqueue(ctx, 'activateNode', { nodeType });
  }

  // Move to wallet from the cabinet: the activation origin only (the router refused every other), no grant, no params.
  async function requestClaim(ctx) {
    if (!isActivationOrigin(ctx.origin)) throw new ProviderError(CODES.UNAUTHORIZED);
    if (!(await d.vault.vaultExists())) return claimError('NO_WALLET');
    return enqueue(ctx, 'claimNodeBalance', {});
  }

  // Unlink the light node's device from the cabinet (decision 38): the activation origin only, no grant, no params.
  async function requestUnlink(ctx) {
    if (!isActivationOrigin(ctx.origin)) throw new ProviderError(CODES.UNAUTHORIZED);
    if (!(await d.vault.vaultExists())) return unlinkError('NO_WALLET');
    return enqueue(ctx, 'unlinkNodeDevice', {});
  }

  async function handleRequest(ctx, method, params) {
    if (!ctx || !isCanonicalOrigin(ctx.origin) || !Number.isSafeInteger(ctx.portId)) throw new WalletError('INTERNAL');
    livePorts.set(ctx.portId, ctx.origin);
    await loadCooldowns();
    switch (method) {
      case 'qnet_chainId':
        return { chainId: QNET.CHAIN_ID, network: QNET.NETWORK };
      case 'qnet_accounts':
        return (await accountsFor(ctx.origin)) ?? {};
      case 'qnet_requestAccounts':
        return (await accountsFor(ctx.origin)) ?? enqueue(ctx, 'connect', {});
      case 'qnet_disconnect':
        await disconnectOrigin(ctx.origin, true);
        return true;
      case 'qnet_signMessage':
        return requestSignature(ctx, params);
      case 'qnet_sendTransaction':
        return requestTransaction(ctx, params);
      case 'qnet_getTransactionStatus':
        return requestStatus(ctx, params);
      case 'qnet_activateNode':
        return requestActivation(ctx, params);
      case 'qnet_getActivation':
        return requestReadActivation(ctx);
      case 'qnet_claimNodeBalance':
        return requestClaim(ctx);
      case 'qnet_unlinkNodeDevice':
        return requestUnlink(ctx);
      default:
        throw new ProviderError(CODES.UNSUPPORTED_METHOD);
    }
  }

  // Ending a window that could not offer its action (or had not yet: the wallet still being checked) is no rejection of
  // the site, the first time.
  const offered = (approval) => !(approval.kind === 'activateNode' && ['unavailable', 'checking'].includes(approval.view?.mode))
    && !(approval.kind === 'claimNodeBalance' && (approval.view?.mode === 'unavailable' || approval.view?.mode === 'empty'))
    && !(approval.kind === 'unlinkNodeDevice' && approval.view?.mode === 'unavailable');
  // The origin already had another window within the short budget period: a second window it lets end
  // unused (its page gone before the confirm armed, or an unavailable activation closed) counts (R2-ERP-01).
  const repeated = (origin) => windowsWithin(origin, TIMINGS.APPROVAL_BUDGET_SHORT_MS) >= 2;

  async function onPortClosed(ctx) {
    if (!ctx) return;
    livePorts.delete(ctx.portId);
    // A page that goes away while its approval has been on screen for the confirm delay counts as a
    // rejection (ES-03): a page reloading itself to open window after focused window meets the cooldown.
    // So does one that goes away sooner, from its second window on.
    const shown = slot?.approval ?? null;
    const counts = shown !== null && shown.ctx.portId === ctx.portId && !shown.busy && !shown.settled
      && shown.windowAt !== null && (repeated(ctx.origin)
        || (shown.shownAt !== null && d.now() - shown.shownAt >= TIMINGS.CONFIRM_ARM_MS && offered(shown)));
    rejectWhere((a) => a.ctx.portId === ctx.portId, new ProviderError(CODES.USER_REJECTED));
    if (counts) recordRejection(ctx.origin);
  }

  async function onWindowRemoved(windowId) {
    if (slot === null) return;
    if (slot.windowId === null) {
      closedWhileOpening.add(windowId);
      return;
    }
    if (slot.windowId !== windowId) return;
    const { approval } = slot;
    slot = null;
    disarm(approval);
    // a confirm is running: its outcome ends the request; one that ends in a retry ends it as closed (R3-ERP-02)
    if (approval.busy) approval.windowClosed = true;
    else if (settle(approval, new ProviderError(CODES.USER_REJECTED)) && (offered(approval) || repeated(approval.ctx.origin))) {
      recordRejection(approval.ctx.origin);
    }
    pump();
  }

  function onWipe() {
    const origins = new Set([...grantedCache, ...livePorts.values()]);
    grantedCache.clear();
    // storage.session is cleared by the wipe; memory follows
    cooldowns.clear();
    for (const approval of [...queue]) settle(approval, new ProviderError(CODES.DISCONNECTED));
    if (slot !== null) release(slot.approval);
    for (const origin of origins) {
      emit(origin, 'accountsChanged', {});
      emit(origin, 'disconnect', null);
    }
  }

  async function notifyLockChanged(change) {
    if (!change || typeof change.locked !== 'boolean') return;
    if (change.reason === 'wipe') {
      onWipe();
      return;
    }
    if (change.locked) {
      let origins;
      try {
        origins = Object.keys(await readSites());
      } catch {
        origins = [...grantedCache];
      }
      for (const origin of origins) emit(origin, 'accountsChanged', {});
    } else {
      const current = await unlockedSession().catch(() => null);
      if (current === null) return;
      const sites = await readSites().catch(() => ({}));
      for (const [origin, grant] of Object.entries(sites)) {
        if (grant.walletId !== current.walletId) continue;
        emit(origin, 'accountsChanged', accountsOf(current));
        for (const approval of [...queue]) {
          if (approval.kind === 'connect' && approval.ctx.origin === origin && !approval.busy && slot?.approval !== approval) {
            settle(approval, null, accountsOf(current));
          }
        }
      }
    }
    queueChanged();
  }

  async function listSites() {
    const sites = await readSites();
    const list = Object.entries(sites).map(([origin, grant]) => {
      const shown = displayOrigin(origin);
      return { origin, originDisplay: shown.text, idn: shown.idn, grantedAt: grant.grantedAt, chains: [...grant.chains] };
    });
    list.sort((a, b) => b.grantedAt - a.grantedAt || (a.origin < b.origin ? -1 : 1));
    return { sites: list };
  }

  async function revokeSite(params) {
    const origin = params?.origin;
    if (!isCanonicalOrigin(origin)) throw new WalletError('INVALID_PARAMS', { field: 'origin' });
    return { revoked: await disconnectOrigin(origin, false) };
  }

  async function getApproval(params, meta) {
    const approval = await approvalForPage(params?.id, meta);
    const current = await unlockedSession().catch(() => null);
    const details = await approvalDetails(approval, current);
    if (approval.settled || slot?.approval !== approval) throw notFound();
    // the page has what it draws from now: the confirm delay and a closed port count from here
    approval.shownAt ??= d.now();
    const key = JSON.stringify([current === null, details]);
    if (key !== approval.detailsKey) {
      approval.detailsKey = key;
      approval.revision += 1;
    }
    const shown = displayOrigin(approval.ctx.origin);
    return {
      id: approval.id,
      kind: approval.kind,
      origin: approval.ctx.origin,
      originDisplay: shown.text,
      idn: shown.idn,
      locked: current === null,
      queued: queue.filter((other) => other !== approval).length,
      createdAt: approval.createdAt,
      revision: approval.revision,
      details,
    };
  }

  async function resolveApproval(params, meta) {
    const approval = await approvalForPage(params?.id, meta);
    if (approval.busy) throw notFound();
    // the unlocked session confirms: no approval takes a password
    if (params.password !== undefined) throw new WalletError('INVALID_PARAMS', { field: 'password' });
    if (approval.kind === 'activateNode') return resolveActivation(approval, params);
    if (approval.kind === 'claimNodeBalance') return resolveClaim(approval, params);
    if (approval.kind === 'unlinkNodeDevice') return resolveUnlink(approval, params);
    if (params.approved !== true) {
      settle(approval, new ProviderError(CODES.USER_REJECTED));
      recordRejection(approval.ctx.origin);
      release(approval);
      return { resolved: true };
    }
    // A send confirms exactly the preview the page showed: the revision of the last one served (R2-EXT-UI-03).
    if (REVISIONED.has(approval.kind) && params.revision !== approval.revision) throw new WalletError('NONCE_CHANGED');
    approval.busy = true;
    let current;
    try {
      current = await d.session.requireUnlocked();
    } catch (error) {
      // LOCKED: the window unlocks and the user confirms again
      approval.busy = false;
      endIfWindowClosed(approval);
      throw error;
    }
    let result;
    try {
      result = await perform(approval, current);
    } catch (error) {
      approval.busy = false;
      if (REVIEW_AGAIN.has(error?.code) && !approval.settled) {
        if (endIfWindowClosed(approval)) throw error;
        approval.preview = null;
        queueChanged();
        throw error;
      }
      if (settle(approval, error) && slot?.approval === approval) arm(approval, ERROR_LINGER_MS, () => release(approval));
      if (TX_KINDS.has(approval.kind)) balanceChanged();
      throw error;
    }
    approval.busy = false;
    settle(approval, null, result);
    clearCooldown(approval.ctx.origin);
    release(approval);
    if (approval.kind === 'connect') afterConnect(approval.ctx.origin, result);
    if (TX_KINDS.has(approval.kind)) balanceChanged();
    return { resolved: true };
  }

  return Object.freeze({
    handleRequest,
    onPortClosed,
    onWindowRemoved,
    notifyLockChanged,
    listSites,
    revokeSite,
    getApproval,
    resolveApproval,
    readSites,
    snapshot: () => ({ queued: queue.length, windowId: slot?.windowId ?? null }),
  });
}

// ---------------------------------------------------------------- module API (sw.js and the router)

let emitEvent = null;
let defaultService = null;

function service() {
  defaultService ??= createProviderService();
  return defaultService;
}

/**
 * sw.js wiring: the router's port emitter. Events go to one origin's open ports only; the router fixes
 * the disconnect payload to {code: 4900, message: 'Disconnected'} and drops unsafe accountsChanged data.
 * @param {(origin: string, event: 'accountsChanged'|'disconnect', data?: unknown) => number} emit
 *   returns how many ports received the event
 * @returns {void}
 */
export function setEventSink(emit) {
  if (typeof emit !== 'function') throw new TypeError('emit must be a function');
  emitEvent = emit;
}

/**
 * The emitter set by setEventSink, or null before sw.js wired it.
 * @returns {((origin: string, event: 'accountsChanged'|'disconnect', data: unknown) => number)|null}
 */
export function eventSink() {
  return emitEvent;
}

/**
 * Router dispatch of a validated provider request (params already normalized by the router).
 *   qnet_requestAccounts {}: granted and unlocked → Accounts at once; otherwise a 'connect' approval
 *     (unlock first when locked) → Accounts, and the grant is stored.
 *   qnet_accounts {}: Accounts when granted and unlocked, else {} (never opens a window).
 *   qnet_chainId {}: {chainId: 'q1337', network: QNET.NETWORK}.
 *   qnet_disconnect {}: removes this origin's grant, emits accountsChanged {} and disconnect to it; true.
 *   qnet_signMessage {message}: requires a grant (else 4100); 'signMessage' approval showing the exact
 *     text → keys.signOffchain(ctx.origin, message) → {signature, publicKey, address} (hex, hex, EON).
 *   qnet_sendTransaction (router.normalizeTransaction; requires a grant; the wallet sets gas price, gas limit and
 *     nonce, MISS-03; the confirm waits while an earlier transaction holds the nonce before its own):
 *     {type: 'transfer', to, amount}: amount decimal QNC → nano; 'sendTransaction' approval → qnet.sendTransfer →
 *       {status: 'submitted'|'unknown', from, to, amount, nonce, txHash: string|null};
 *     {type: 'tokenTransfer', token, to, amount}: a QRC-20 token (qnet.readContract, two nodes; else -32602), amount
 *       decimal in its decimals → base units; 'tokenTransfer' approval → qnet.sendCall →
 *       {status, from, token, to, amount, nonce, txHash};
 *     {type: 'contractCall', contract, method, args, gasLimit?}: a contract that is no token (else -32602);
 *       'contractCall' approval → qnet.sendCall → {status, from, contract, method, nonce, txHash}.
 *     A transaction's identity is (from, nonce); txHash is one node's copy; status is 'submitted' only with one.
 *   qnet_getTransactionStatus {from, nonce}: the connected, unlocked account only (else 4100), no window;
 *     qnet.transactionStatus → {status: 'pending'|'in_block'|'unknown', blockHeight, txHash} (height and hash only in a
 *     block; a failed read is 'unknown'); an answer is given again for STATUS_FRESH_MS, and an origin starts at most
 *     STATUS_READS_PER_MINUTE reads a minute (more: 4001).
 *   qnet_activateNode {nodeType}: router.isActivationOrigin only (else 4100), no grant; no vault →
 *     {status: 'error', error: 'NO_WALLET'} at once; otherwise an 'activateNode' approval showing
 *     activation.siteView (the burn with its price, or this wallet's activation, pending burn, or why
 *     neither is possible); its armed confirm (no password) runs activation.activateForSite →
 *     SiteActivationResult (ok, exists, pending, or error with a SITE_ERRORS code; 4001 on reject). After a light
 *     answer the window shows the node's registration on the QNet network up to TIMINGS.REGISTRATION_WINDOW_MS.
 *   qnet_getActivation {}: router.isActivationOrigin only (else 4100), never a window (decision 35); at most
 *     LIMITS.ACTIVATION_READS_PER_MINUTE a minute per origin (more: 4001); {status: 'no_wallet'}, {status: 'locked'},
 *     {status: 'not_connected'} (no grant of this wallet), else activation.siteActivation checked (SiteActivationRead).
 *   qnet_claimNodeBalance {}: router.isActivationOrigin only (else 4100), no grant; no vault → {status: 'error', error:
 *     'NO_WALLET'} at once; otherwise a 'claimNodeBalance' approval showing nodes.claimView (the balance of the wallet's
 *     own light node two pinned nodes agree on, or why nothing can move); its armed confirm (no password) runs
 *     nodes.claimForSite → SiteClaimResult (ok, empty, or error with a CLAIM_ERRORS code; 4001 on reject).
 *   qnet_unlinkNodeDevice {}: router.isActivationOrigin only (else 4100), no grant; no vault → {status: 'error', error:
 *     'NO_WALLET'} at once; otherwise an 'unlinkNodeDevice' approval showing nodes.unlinkView (the device the public
 *     status names for the wallet's own light node, or why nothing can be unlinked); its armed confirm (no password)
 *     runs nodes.unlinkForSite → SiteUnlinkResult (ok, or error with an UNLINK_ERRORS code; 4001 on reject).
 * Approvals: at most LIMITS.APPROVAL_QUEUE_PER_ORIGIN open per origin, shown or waiting (more → 4001 at
 * once); one window at a time, FIFO across origins (chrome.windows.create type 'popup', focused,
 * ui/approve.html?id=<uuid>); closed window or TIMINGS.APPROVAL_TIMEOUT_MS → 4001. A granted origin
 * asking while locked gets the window with unlock first, not an error; a grant revoked while its
 * approval waits → 4100. Cooldown: after the user rejects or closes an approval, its origin opens no
 * other for TIMINGS.APPROVAL_COOLDOWN_MS (TIMINGS.APPROVAL_COOLDOWN_LONG_MS after
 * LIMITS.APPROVAL_COOLDOWN_REJECTIONS within TIMINGS.APPROVAL_COOLDOWN_WINDOW_MS): a request that would
 * need one, and every approval of it still waiting, fails at once with 4001 and the fixed
 * APPROVAL_COOLDOWN text. An approved and performed approval clears the origin's cooldown. The state
 * lives in worker memory and chrome.storage.session[STORAGE_KEYS.APPROVAL_COOLDOWN].
 * @param {ProviderContext} ctx
 * @param {string} method
 * @param {object} params
 * @returns {Promise<unknown>}
 * @throws {ProviderError} 4001 rejected, closed or queue full; 4100 no grant or locked at signing;
 *   4200 unknown method; -32602 invalid; -32603 internal. WalletError/CoreError are mapped by the router
 *   (APPROVAL_COOLDOWN → 4001 with its own text).
 */
export async function handleRequest(ctx, method, params) {
  return service().handleRequest(ctx, method, params);
}

/**
 * The relay's port closed (tab navigated or closed, worker restart): rejects and removes this port's
 * queued approvals, and closes the window of its current one, so nothing is approved for a page that
 * is gone. When that window had offered its action for at least TIMINGS.CONFIRM_ARM_MS, the origin's
 * approval cooldown counts it as a rejection (ES-03).
 * @param {ProviderContext} ctx
 * @returns {Promise<void>}
 */
export async function onPortClosed(ctx) {
  return service().onPortClosed(ctx);
}

/**
 * chrome.windows.onRemoved listener: closing the approval window rejects its request with 4001 and
 * opens the next queued approval.
 * @param {number} windowId
 * @returns {Promise<void>}
 */
export async function onWindowRemoved(windowId) {
  return service().onWindowRemoved(windowId);
}

/**
 * Lock or unlock: accountsChanged to every granted origin with open ports ({} when locked, Accounts when
 * unlocked). reason 'wipe': disconnect as well, and every queued approval is rejected with 4900.
 * @param {import('./session.js').LockChange} change
 * @returns {Promise<void>}
 */
export async function notifyLockChanged(change) {
  return service().notifyLockChanged(change);
}

/**
 * Handler of `sites.list`: the valid grants of this wallet, newest first.
 * @returns {Promise<{sites: Array<{origin: string, originDisplay: string, idn: boolean, grantedAt: number,
 *   chains: string[]}>}>}
 */
export async function listSites() {
  return service().listSites();
}

/**
 * Handler of `sites.revoke`: removes the grant, emits accountsChanged {} and disconnect to the origin.
 * The vault's sites key is rotated and the remaining grants signed again, so the revoked entry cannot
 * be written back (the same happens for qnet_disconnect).
 * @param {{origin: string}} params
 * @returns {Promise<{revoked: boolean}>} false when there was no grant
 */
export async function revokeSite(params) {
  return service().revokeSite(params);
}

/**
 * Handler of `approval.get` (approve page; also its heartbeat every TIMINGS.APPROVAL_HEARTBEAT_MS). For a
 * sendTransaction approval viewed while unlocked, fills nonce, balance and verified via
 * qnet.prepareTransfer; the stored preview is what approval.resolve signs.
 * @param {{id: string}} params
 * @param {{page: string, sender: object}} meta the router's sender info
 * @returns {Promise<ApprovalView>}
 * @throws {WalletError} NOT_FOUND (unknown id, or the sender is not the approval's own window)
 */
export async function getApproval(params, meta) {
  return service().getApproval(params, meta);
}

/**
 * Handler of `approval.resolve` (approve page only; the sender's window must be the approval's window, and
 * the id the one the worker opened it with). No password is taken for any kind (INVALID_PARAMS): the unlocked
 * session and the armed press in that window confirm. approved false rejects with 4001 (works while locked).
 * approved true requires the wallet unlocked and performs the action: store the grant, keys.signOffchain, or
 * qnet.sendTransfer with the previewed fee and nonce (NONCE_UNAVAILABLE when no unlocked preview was served); the
 * dApp receives the result. On an action error the dApp receives the mapped error and the page gets the
 * WalletError. Then the window closes and the next approval opens. activateNode: LOCKED and PRICE_CHANGED keep
 * the approval open; every other outcome, failures included, is a dApp result, and the window stays on it until
 * closed (at most 30 s). A view that could not offer the action resolves either way with its reason, as no
 * rejection. A confirmed send, token transfer, contract call, activation or claim that ran tells the pages
 * ('balance').
 * @param {{id: string, approved: boolean, revision?: number}} params
 * @param {{page: string, sender: object}} meta
 * @returns {Promise<{resolved: true, status?: 'ok'|'exists'|'pending'|'error', error?: string|null}>}
 *   status and error for activateNode (error: the wallet's code, for the window's own text)
 * @throws {WalletError} NOT_FOUND, LOCKED, INVALID_PARAMS, and the errors of the performed action
 */
export async function resolveApproval(params, meta) {
  return service().resolveApproval(params, meta);
}

/**
 * Valid grants from chrome.storage.local (R22): an entry is used only when its origin is canonical and
 * allowed by the relay's manifest matches, its fields are well formed, walletId equals the vault's, and
 * its mac verifies. Anything else is dropped (and pruned from storage). No vault → {}.
 * @returns {Promise<Record<string, SiteGrant>>}
 */
export async function readSites() {
  return service().readSites();
}
