// The one encrypted vault (R01-R05, R20): a single record in extension-origin IndexedDB, owned by the
// worker. Plaintext is the recovery-phrase entropy plus wallet state; nothing derived from it is ever persisted.
// Password verification is a successful AES-GCM decrypt, nothing else.
import * as core from '../lib/qnet-core.js';
import { U64_MAX } from './amount.js';
import { AUTO_LOCK_CHOICES, DEFAULT_AUTO_LOCK_MINUTES, LIMITS, STORAGE_KEYS, TIMINGS, VAULT_DB } from './config.js';
import { WalletError } from './errors.js';
import * as keys from './keys.js';
import * as earlier from './earlier.js';
import { log } from './log.js';
import * as session from './session.js';

/**
 * @typedef {{alg: 'argon2id', m: number, t: number, p: number, salt: string}
 *   | {alg: 'pbkdf2-sha256', iterations: number, salt: string}} KdfParams
 * salt: base64 of 16..32 random bytes, fresh on every password set or change. Argon2id m is KiB.
 *
 * @typedef {object} VaultAad
 * @property {3} v
 * @property {KdfParams} kdf identical to VaultRecord.kdf
 * @property {string} walletId crypto.randomUUID() at creation, kept across password changes
 * @property {string} qnetAddress EON address derived at creation
 * @property {string} solanaAddress base58 address derived at creation
 * @property {number} createdAt ms epoch at creation, kept across password changes
 * @property {null|'light'|'super'} activationNodeType nodeType of VaultState.activation (R15)
 * @property {null} legacy always null, a key of the record format; a record of an earlier 3.0.0 build has no
 *   such key until its next write (unlock rewrites it)
 *
 * @typedef {object} VaultRecord  stored at IndexedDB VAULT_DB.NAME / VAULT_DB.STORE / VAULT_DB.KEY
 * @property {3} v
 * @property {KdfParams} kdf
 * @property {string} iv base64 of 12 random bytes, fresh on every write
 * @property {string} ct base64 of AES-256-GCM ciphertext with its 16-byte tag
 * @property {VaultAad} aad authenticated as UTF-8(canonicalJson(aad))
 * @property {string} sitesKey base64 of 32 random bytes made with the record and kept across password
 *   changes: the HMAC key of the site grants in chrome.storage.local. Not a wallet secret (it opens
 *   nothing), but only extension-origin code can read IndexedDB, so a content script cannot forge a grant.
 *
 * @typedef {object} Activation  the single activation of this wallet
 * @property {string} code QNET-Xxxxxx-xxxxxx-xxxxxx
 * @property {'light'|'super'} nodeType
 * @property {string} burnTx base58 Solana signature
 * @property {number} burnAmount whole 1DEV burned
 * @property {string} solanaAddress the burner, equal to the wallet's Solana address
 * @property {string} cluster SOLANA.CLUSTER at burn time
 * @property {number} createdAt ms epoch
 *
 * @typedef {object} PendingBurn  a sent burn not yet seen finalized
 * @property {string} burnTx
 * @property {'light'|'super'} nodeType
 * @property {number} burnAmount
 * @property {string} solanaAddress
 * @property {string} cluster
 * @property {number} createdAt
 * @property {number|null} lastValidBlockHeight the block height after which the burn can no longer land
 *   (its blockhash's lastValidBlockHeight); null only for a record written before it was kept
 *
 * @typedef {object} PendingTransfer  a signed transaction of this wallet not yet seen applied: a QNC transfer or a
 *   contract call (a token transfer is a call); one nonce sequence covers both
 * @property {string} nonce u64 decimal
 * @property {string} to the recipient of a transfer, the contract of a call
 * @property {string} amountNano u64 decimal: the QNC it moves besides the fee (a call: the refundable storage deposit a
 *   token transfer to a new holder sets aside, else '0')
 * @property {string} feeNano u64 decimal: what the gas limit may cost at most
 * @property {string} body the exact JSON text POSTed to /api/v1/transaction (a transfer) or /api/v1/contract/call (a
 *   call); a retry resends it unchanged
 * @property {string|null} txHash
 * @property {number} createdAt
 * @property {number} lastSubmitAt
 * @property {'pending'|'replaced'|'passed'|'superseded'|'refused'} outcome replaced: another transaction took its
 *   nonce; passed: the chain's nonce passed it and no two pinned nodes agree yet on what applied there (R3-EXTQ-04);
 *   superseded: a replacement at its nonce is being submitted, so it is no longer resent but still listed and
 *   reserved until that replacement's outcome is known (R4-EXTQ-01); refused: the only node sent it refused it, which
 *   is one node's word: never resent by the wallet, still listed and reserved until its nonce is used, and the next
 *   transfer takes its nonce (R5-EXTQ-02)
 * @property {'transfer'|'call'} kind
 * @property {{method: string, recipient: string|null, amount: string|null}|null} call null for a transfer; for a call
 *   its method, and for a token transfer its recipient and the token base units it moves (u64 decimal)
 *
 * @typedef {object} SpendRecord  the most one transaction this wallet signed can take, kept by nonce from its signing
 *   until its transaction is gone unused, or for an hour after the chain's nonce reached it: what a send counts above a
 *   certified state, whose nonce may be below it (qnet.withSpends)
 * @property {string} nonce u64 decimal
 * @property {string} qncNano u64 decimal: its amount (a call: the storage deposit) and its most fee
 * @property {string|null} token the token contract a token transfer moves, else null
 * @property {string|null} tokenAmount u64 decimal: the token base units it moves, with `token`
 * @property {boolean} tokenUnknown a contract call that may move tokens by an amount not known here
 * @property {number|null} settledAt when the chain's nonce reached it, null before
 *
 * @typedef {object} RecentTransfer  a QNC transfer this wallet signed, kept RECENT_TRANSFER_MS for the
 *   double-payment warning whatever became of it (R3-EXTQ-01)
 * @property {string} to
 * @property {string} amountNano
 * @property {number} createdAt
 *
 * @typedef {object} VaultSettings  security settings live in the ciphertext, not in chrome.storage.local
 * @property {5|15|30|60|'never'} autoLockMinutes default DEFAULT_AUTO_LOCK_MINUTES (AUTO_LOCK_CHOICES)
 *
 * @typedef {object} VaultState  the non-entropy part of the plaintext
 * @property {Activation|null} activation
 * @property {PendingBurn|null} pendingBurn
 * @property {PendingTransfer[]} pendingTransfers at most LIMITS.PENDING_TRANSFERS_MAX, oldest first
 * @property {VaultSettings} settings
 * @property {string[]} recipients the QNet addresses this wallet signed transfers to, oldest first, at most
 *   RECIPIENTS_MAX: the known recipients of the first-time and look-alike warnings (ES-01)
 * @property {null} legacy always null, a key of the state format
 * @property {string[]} solanaRecipients the Solana addresses this wallet signed SOL or 1DEV transfers to,
 *   oldest first, at most RECIPIENTS_MAX: the same warnings for a Solana send (R3-EXT-UI-03)
 * @property {RecentTransfer[]} recentTransfers oldest first, at most RECENT_TRANSFERS_MAX, none older than
 *   RECENT_TRANSFER_MS
 * @property {boolean} exposedAdvice a key of the state format that nothing reads; false in every vault written now
 * @property {SupersededBurn|null} supersededBurn this wallet's own finalized burn that another device of the phrase
 *   beat to it: the activation is that older burn, and this one gives no code of its own (XP-R5-03)
 * @property {PendingRegistration|null} registration the recording of this wallet's light node on the QNet network
 *   (nodes.js), written with the light activation it records; null for an activation of an earlier build
 * @property {SpendRecord[]} spends at most LIMITS.SPENDS_MAX, lowest nonce first
 *
 * @typedef {object} PendingRegistration  public values only: every attempt signs afresh
 * @property {string} nodeId the wallet's light node id (core.lightNodeId of the vault's QNet address)
 * @property {string} burnTx the activation's burn
 * @property {string} burner the Solana address that burned: the activation's
 * @property {'queued'|'admitted'|'onchain'|'other_burn'|'refused'|'clock'} state other_burn: the chain lists the node
 *   with a registration of another burn (nodes.js whoseBurn)
 * @property {number} attempts submits made since it was queued
 * @property {number} nextAt ms epoch of the next automatic attempt
 * @property {string|null} txHash the registration a node admitted
 * @property {number|null} admittedAt
 * @property {string|null} lastError the short code of the last refusal or failure (never shown, never a text)
 * @property {number} updatedAt
 *
 * @typedef {object} SupersededBurn  a burn this device sent and Solana finalized after an older burn of the phrase
 * @property {string} burnTx
 * @property {'light'|'super'} nodeType
 * @property {number} burnAmount
 * @property {string} solanaAddress the wallet's own Solana address
 * @property {string} cluster
 * @property {number} createdAt
 */

/** State of a new vault. */
export function emptyState() {
  return {
    activation: null, pendingBurn: null, pendingTransfers: [], settings: { autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES },
    recipients: [], legacy: null, solanaRecipients: [], recentTransfers: [], exposedAdvice: false, supersededBurn: null,
    registration: null, spends: [],
  };
}

// Recipients kept for the send warnings; the oldest drop out first.
export const RECIPIENTS_MAX = 128;
// Signed QNC transfers kept for the double-payment warning, and for how long (R3-EXTQ-01).
export const RECENT_TRANSFERS_MAX = 64;
export const RECENT_TRANSFER_MS = 30 * 60 * 1000;

/**
 * The state with `address` as the newest known recipient (moved to the end when it is already there).
 * @param {VaultState} state
 * @param {string} address a valid EON
 * @returns {VaultState} a new state object; `state` is not changed
 */
export function withRecipient(state, address) {
  const recipients = [...state.recipients.filter((known) => known !== address), address].slice(-RECIPIENTS_MAX);
  return { ...state, recipients };
}

/**
 * The state with `address` as the newest known Solana recipient (R3-EXT-UI-03).
 * @param {VaultState} state
 * @param {string} address a valid Solana address
 * @returns {VaultState}
 */
export function withSolanaRecipient(state, address) {
  const solanaRecipients = [...state.solanaRecipients.filter((known) => known !== address), address].slice(-RECIPIENTS_MAX);
  return { ...state, solanaRecipients };
}

/**
 * The state with a signed transfer of `amountNano` to `to` recorded for the double-payment warning; entries
 * older than RECENT_TRANSFER_MS go (R3-EXTQ-01).
 * @param {VaultState} state
 * @param {{to: string, amountNano: string, createdAt: number}} transfer
 * @returns {VaultState}
 */
export function withRecentTransfer(state, transfer) {
  const since = transfer.createdAt - RECENT_TRANSFER_MS;
  const recentTransfers = [...liveRecentTransfers(state, since), { to: transfer.to, amountNano: transfer.amountNano, createdAt: transfer.createdAt }]
    .slice(-RECENT_TRANSFERS_MAX);
  return { ...state, recentTransfers };
}

/**
 * The recorded transfers created at or after `since`.
 * @param {VaultState} state
 * @param {number} since ms epoch
 * @returns {RecentTransfer[]}
 */
export function liveRecentTransfers(state, since) {
  return state.recentTransfers.filter((r) => r.createdAt >= since);
}

// The default is the R04 floor itself. A cheaper m=32 MiB/t=4 was measured to save only ~40% and is below
// that floor, so it is not used; PBKDF2 stays a fallback record format that new vaults never get.
export const KDF_DEFAULT = Object.freeze({ alg: 'argon2id', m: 65536, t: 3, p: 1 });
// Every unlock refuses a record below these (R04).
export const KDF_FLOOR = Object.freeze({
  argon2id: Object.freeze({ m: 65536, t: 3, p: 1 }),
  'pbkdf2-sha256': Object.freeze({ iterations: 600000 }),
});
export const PLAINTEXT_VERSION = 3;
export { VAULT_DB };

const RECORD_VERSION = 3;
// Stored KDF parameters above these are treated as corruption, never run.
const KDF_CEILING = Object.freeze({ m: 1048576, t: 64, p: 16, iterations: 10000000 });
const SALT_BYTES = 16;
const SALT_RANGE = Object.freeze({ min: 16, max: 32 });
const IV_BYTES = 12;
const KEY_BYTES = 32;
const SITES_KEY_BYTES = 32;
const TAG_BYTES = 16;
const STATE_MAX_BYTES = 1 << 20;
const CT_RANGE = Object.freeze({ min: 2 + 16 + 2 + TAG_BYTES, max: 2 + 32 + STATE_MAX_BYTES + TAG_BYTES });
const PENDING_BODY_MAX_CHARS = 65536;
const BURN_AMOUNT_MAX = 1000000000;
const DELETE_WAIT_MS = 10000;
const RESTORE_TOKEN_BYTES = 32;
// Sent with the one vault.restore call that may replace the vault, once the user confirmed the reset (popup: the wallet
// being replaced named, one checkbox). A call without it only checks the phrase and names both wallets.
const RESTORE_CONFIRM = 'ERASE';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const U64_RE = /^(0|[1-9][0-9]{0,19})$/;
const TX_HASH_RE = /^[\x21-\x7e]{1,256}$/;
const CLUSTER_RE = /^[a-z][a-z0-9-]{0,31}$/;
const RECORD_KEYS = Object.freeze(['v', 'kdf', 'iv', 'ct', 'aad', 'sitesKey']);
const AAD_KEYS = Object.freeze(['v', 'kdf', 'walletId', 'qnetAddress', 'solanaAddress', 'createdAt', 'activationNodeType',
  'legacy']);
// The AAD of a record an earlier 3.0.0 build wrote: without the key `legacy`.
const AAD_KEYS_BEFORE = Object.freeze(AAD_KEYS.filter((key) => key !== 'legacy'));
const STATE_KEYS = Object.freeze(['activation', 'pendingBurn', 'pendingTransfers', 'settings', 'recipients', 'legacy',
  'solanaRecipients', 'recentTransfers', 'exposedAdvice', 'supersededBurn', 'registration', 'spends']);
// What every stored state has; the other STATE_KEYS came later and read as empty when absent.
const STATE_BASE_KEYS = Object.freeze(['activation', 'pendingBurn', 'pendingTransfers', 'settings']);
const STATE_DEFAULTS = Object.freeze({
  recipients: [], legacy: null, solanaRecipients: [], recentTransfers: [], exposedAdvice: false, supersededBurn: null,
  registration: null, spends: [],
});
const RECENT_TRANSFER_KEYS = Object.freeze(['to', 'amountNano', 'createdAt']);
const SPEND_KEYS = Object.freeze(['nonce', 'qncNano', 'token', 'tokenAmount', 'tokenUnknown', 'settledAt']);
const ACTIVATION_KEYS = Object.freeze(['code', 'nodeType', 'burnTx', 'burnAmount', 'solanaAddress', 'cluster', 'createdAt']);
const PENDING_BURN_KEYS = Object.freeze(['burnTx', 'nodeType', 'burnAmount', 'solanaAddress', 'cluster', 'createdAt',
  'lastValidBlockHeight']);
const PENDING_TRANSFER_KEYS = Object.freeze(['nonce', 'to', 'amountNano', 'feeNano', 'body', 'txHash', 'createdAt',
  'lastSubmitAt', 'outcome', 'kind', 'call']);
// A record written before calls were kept is a QNC transfer; one written before its outcome was kept is still pending.
const PENDING_TRANSFER_KEYS_BEFORE_CALLS = Object.freeze(PENDING_TRANSFER_KEYS.filter((key) => key !== 'kind' && key !== 'call'));
const PENDING_TRANSFER_KEYS_BEFORE = Object.freeze(PENDING_TRANSFER_KEYS_BEFORE_CALLS.filter((key) => key !== 'outcome'));
export const PENDING_OUTCOMES = Object.freeze(['pending', 'replaced', 'passed', 'superseded', 'refused']);
export const PENDING_KINDS = Object.freeze(['transfer', 'call']);
const PENDING_CALL_KEYS = Object.freeze(['method', 'recipient', 'amount']);
const METHOD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const SUPERSEDED_BURN_KEYS = Object.freeze(['burnTx', 'nodeType', 'burnAmount', 'solanaAddress', 'cluster', 'createdAt']);
const REGISTRATION_KEYS = Object.freeze(['nodeId', 'burnTx', 'burner', 'state', 'attempts', 'nextAt', 'txHash', 'admittedAt',
  'lastError', 'updatedAt']);
export const REGISTRATION_STATES = Object.freeze(['queued', 'admitted', 'onchain', 'other_burn', 'refused', 'clock']);
const NODE_ID_RE = /^light_mobile_[0-9a-f]{16}$/;
const REGISTRATION_ERROR_RE = /^[a-z0-9_]{1,32}$/;
// A pending burn written before its block height was kept reads with lastValidBlockHeight null.
const PENDING_BURN_KEYS_BEFORE = Object.freeze(PENDING_BURN_KEYS.filter((key) => key !== 'lastValidBlockHeight'));
// The new record of a forgot-password restore, written and read back before the old vault is replaced.
const RESTORE_STAGING_KEY = 'restoreStaging';
// The light client's verified anchors (qnet.js, EXT-CHAINS-04): chain data next to the record, with a MAC.
const LIGHT_ANCHORS_KEY = 'lightAnchors';
const LIGHT_ANCHORS_LABEL = 'qnet-light-anchors-v1';
const LIGHT_ANCHOR_IDS_MAX = 4096;
// What the wallet last read of the QNet chain and of its balances (vault.updateChainCache): public data next to the
// record, with a MAC, so the next popup draws the last verified balances at once and a chain the wallet no longer follows
// is noticed (qnet.js).
const CHAIN_CACHE_KEY = 'chainCache';
const CHAIN_CACHE_LABEL = 'qnet-chain-cache-v1';
const CHAIN_CACHE_MAX_CHARS = 64 << 10;
// What the burn searches of each owner already listed and checked (solana.findWalletBurns over its 1DEV associated
// account, and solana.findSignedBurns over the transactions it signed: R5-ESA-01), with a MAC, so a search a long
// history cut short resumes where it stopped (R2-ESA-02).
const BURN_SCANS_KEY = 'burnScans';
const BURN_SCANS_LABEL = 'qnet-burn-scans-v1';
const BURN_SCAN_KINDS = Object.freeze({ account: '', signed: ':signed' });
// the wallet's two kinds
const BURN_SCAN_OWNERS_MAX = 2;
const BURN_SCANS_MAX_CHARS = 4 << 20;

const utf8 = new TextEncoder();
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const noop = () => {};
const corrupt = () => new WalletError('VAULT_CORRUPT');
const internal = () => new WalletError('INTERNAL');

// ---------------------------------------------------------------- pure helpers

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasExactKeys(value, names) {
  return isPlainObject(value) && Object.keys(value).length === names.length && names.every((n) => Object.hasOwn(value, n));
}

const isCount = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
const isEntropy = (value) => value instanceof Uint8Array && (value.length === 16 || value.length === 32);
const isU64 = (value) => typeof value === 'string' && U64_RE.test(value) && BigInt(value) <= U64_MAX;

function decodeBase64(text, { min, max }) {
  if (typeof text !== 'string') return null;
  let bytes;
  try {
    bytes = core.base64Decode(text);
  } catch {
    return null;
  }
  if (bytes.length < min || bytes.length > max || core.base64Encode(bytes) !== text) return null;
  return bytes;
}

const randomBytes = (length) => crypto.getRandomValues(new Uint8Array(length));
const sameJson = (a, b) => canonicalJson(a) === canonicalJson(b);

/**
 * Canonical JSON used for the AAD and the state part of the plaintext: object keys sorted by UTF-16
 * code unit, no whitespace, only null, booleans, strings, safe integers, arrays and plain objects.
 * @param {unknown} value
 * @returns {string}
 * @throws {WalletError} INTERNAL for any other value (float, bigint, undefined, function, cycle)
 */
export function canonicalJson(value, seen = new Set()) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value !== 'object' || seen.has(value)) throw new WalletError('INTERNAL');
  seen.add(value);
  let out;
  if (Array.isArray(value)) {
    out = `[${value.map((item) => canonicalJson(item, seen)).join(',')}]`;
  } else {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new WalletError('INTERNAL');
    const keys = Object.keys(value).sort();
    out = `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], seen)}`).join(',')}}`;
  }
  seen.delete(value);
  return out;
}

/**
 * NFKC form of the password of an existing vault. Only normalized, never checked against the new-password rule, so
 * a vault keeps opening with whatever password it was made with.
 * @param {string} password
 * @returns {string}
 * @throws {WalletError} BAD_PASSWORD
 */
export function normalizePassword(password) {
  if (typeof password !== 'string' || password.length === 0 || password.length > LIMITS.PASSWORD_MAX_CHARS) {
    throw new WalletError('BAD_PASSWORD');
  }
  return password.normalize('NFKC');
}

/**
 * NFKC form of a new vault password under the rule of both wallets: at least core.PASSWORD_MIN_LENGTH characters as
 * typed (core.passwordTooShort, the one copy the app uses too), nothing else. The pages check that it was typed
 * twice. Every path that sets a vault password (create, import, restore, change) goes through it.
 * @param {string} password
 * @returns {string}
 * @throws {WalletError} WEAK_PASSWORD
 */
export function normalizeNewPassword(password) {
  if (typeof password !== 'string' || password.length > LIMITS.PASSWORD_MAX_CHARS || core.passwordTooShort(password)) {
    throw new WalletError('WEAK_PASSWORD');
  }
  return password.normalize('NFKC');
}

/**
 * Refuses KDF parameters below KDF_FLOOR or of an unknown algorithm.
 * @param {KdfParams} kdf
 * @throws {WalletError} KDF_BELOW_FLOOR
 */
export function assertKdfFloor(kdf) {
  const ok = kdf && typeof kdf === 'object' && typeof kdf.salt === 'string' && (
    (kdf.alg === 'argon2id' && Number.isSafeInteger(kdf.m) && kdf.m >= KDF_FLOOR.argon2id.m
      && Number.isSafeInteger(kdf.t) && kdf.t >= KDF_FLOOR.argon2id.t && kdf.p === KDF_FLOOR.argon2id.p)
    || (kdf.alg === 'pbkdf2-sha256' && Number.isSafeInteger(kdf.iterations)
      && kdf.iterations >= KDF_FLOOR['pbkdf2-sha256'].iterations));
  if (!ok) throw new WalletError('KDF_BELOW_FLOOR');
}

// Shape and ceiling only; the floor is assertKdfFloor's job, so a weak record reports KDF_BELOW_FLOOR.
function isWellFormedKdf(kdf) {
  if (!isPlainObject(kdf) || decodeBase64(kdf.salt, SALT_RANGE) === null) return false;
  if (kdf.alg === 'argon2id') {
    return hasExactKeys(kdf, ['alg', 'm', 't', 'p', 'salt'])
      && isCount(kdf.m, 8) && kdf.m <= KDF_CEILING.m && isCount(kdf.t, 1) && kdf.t <= KDF_CEILING.t
      && isCount(kdf.p, 1) && kdf.p <= KDF_CEILING.p;
  }
  return kdf.alg === 'pbkdf2-sha256' && hasExactKeys(kdf, ['alg', 'iterations', 'salt'])
    && isCount(kdf.iterations, 1) && kdf.iterations <= KDF_CEILING.iterations;
}

const freshKdf = () => ({ ...KDF_DEFAULT, salt: core.base64Encode(randomBytes(SALT_BYTES)) });

// ---------------------------------------------------------------- state shape

const isCluster = (value) => typeof value === 'string' && CLUSTER_RE.test(value);
const isBurnAmount = (value) => Number.isSafeInteger(value) && value >= 1 && value <= BURN_AMOUNT_MAX;

function isValidActivation(a) {
  return hasExactKeys(a, ACTIVATION_KEYS)
    && typeof a.code === 'string' && core.ACTIVATION_CODE_RE.test(a.code)
    && core.ACTIVATION_NODE_TYPES.includes(a.nodeType) && core.isValidSolanaSignature(a.burnTx)
    && isBurnAmount(a.burnAmount) && core.isValidSolanaAddress(a.solanaAddress) && isCluster(a.cluster)
    && isCount(a.createdAt)
    // the stored code must be the one this burn yields, never a code from elsewhere (R15); a light code that names the
    // wallet instead of the burner is checked against the wallet in isConsistentState (isPaidOnSite)
    && (core.activationCodeMatches(a.code, a.nodeType, a.solanaAddress, a.burnTx, a.burnAmount)
      || (a.nodeType === 'light' && a.code.startsWith('QNET-L')));
}

// A light burn aiqnet.io's one-time payment key made for this wallet (activation.js storeRegisteredBurn): the burner is
// none of the phrase's addresses, the code is this wallet's (core.walletActivationCode), and the node's registration
// record named it, so its registration is on chain.
function isPaidOnSite(activation, registration, qnetAddress, burners) {
  if (activation.nodeType !== 'light' || burners.includes(activation.solanaAddress) || registration?.state !== 'onchain') return false;
  try {
    return core.walletActivationCode(qnetAddress, activation.burnTx, activation.burnAmount) === activation.code;
  } catch {
    return false;
  }
}

function isValidPendingBurn(b) {
  return hasExactKeys(b, PENDING_BURN_KEYS) && core.isValidSolanaSignature(b.burnTx)
    && core.ACTIVATION_NODE_TYPES.includes(b.nodeType) && isBurnAmount(b.burnAmount)
    && core.isValidSolanaAddress(b.solanaAddress) && isCluster(b.cluster) && isCount(b.createdAt)
    && (b.lastValidBlockHeight === null || isCount(b.lastValidBlockHeight));
}

function isValidSupersededBurn(b) {
  return hasExactKeys(b, SUPERSEDED_BURN_KEYS) && core.isValidSolanaSignature(b.burnTx)
    && core.ACTIVATION_NODE_TYPES.includes(b.nodeType) && isBurnAmount(b.burnAmount)
    && core.isValidSolanaAddress(b.solanaAddress) && isCluster(b.cluster) && isCount(b.createdAt);
}

function isValidRegistration(r) {
  return hasExactKeys(r, REGISTRATION_KEYS) && typeof r.nodeId === 'string' && NODE_ID_RE.test(r.nodeId)
    && core.isValidSolanaSignature(r.burnTx) && core.isValidSolanaAddress(r.burner) && REGISTRATION_STATES.includes(r.state)
    && isCount(r.attempts) && isCount(r.nextAt) && isCount(r.updatedAt)
    && (r.txHash === null || (typeof r.txHash === 'string' && TX_HASH_RE.test(r.txHash)))
    && (r.admittedAt === null || isCount(r.admittedAt))
    && (r.lastError === null || (typeof r.lastError === 'string' && REGISTRATION_ERROR_RE.test(r.lastError)));
}

function isValidRecipients(list, isAddress = core.isValidQnetAddress) {
  return Array.isArray(list) && list.length <= RECIPIENTS_MAX && list.every((address) => isAddress(address))
    && new Set(list).size === list.length;
}

function isValidSpends(list) {
  return Array.isArray(list) && list.length <= LIMITS.SPENDS_MAX
    && list.every((r) => hasExactKeys(r, SPEND_KEYS) && isU64(r.nonce) && isU64(r.qncNano)
      && ((r.token === null && r.tokenAmount === null) || (core.isValidQnetAddress(r.token) && isU64(r.tokenAmount)))
      && typeof r.tokenUnknown === 'boolean' && !(r.tokenUnknown && r.token !== null)
      && (r.settledAt === null || isCount(r.settledAt)));
}

function isValidRecentTransfers(list) {
  return Array.isArray(list) && list.length <= RECENT_TRANSFERS_MAX
    && list.every((r) => hasExactKeys(r, RECENT_TRANSFER_KEYS) && core.isValidQnetAddress(r.to) && isU64(r.amountNano)
      && isCount(r.createdAt));
}

// A contract call's own part: its method, and for a token transfer the recipient and the base units it moves.
function isValidPendingCall(c) {
  return hasExactKeys(c, PENDING_CALL_KEYS) && typeof c.method === 'string' && METHOD_RE.test(c.method)
    && ((c.recipient === null && c.amount === null)
      || (core.isValidQnetAddress(c.recipient) && isU64(c.amount) && c.amount !== '0'));
}

function isValidPendingTransfer(p) {
  return hasExactKeys(p, PENDING_TRANSFER_KEYS) && isU64(p.nonce) && core.isValidQnetAddress(p.to)
    && isU64(p.amountNano) && isU64(p.feeNano)
    && typeof p.body === 'string' && p.body.length >= 2 && p.body.length <= PENDING_BODY_MAX_CHARS
    && (p.txHash === null || (typeof p.txHash === 'string' && TX_HASH_RE.test(p.txHash)))
    && isCount(p.createdAt) && isCount(p.lastSubmitAt) && PENDING_OUTCOMES.includes(p.outcome)
    && (p.kind === 'transfer' ? p.call === null : p.kind === 'call' && isValidPendingCall(p.call));
}

function isValidState(state) {
  return hasExactKeys(state, STATE_KEYS)
    && (state.activation === null || isValidActivation(state.activation))
    && (state.pendingBurn === null || isValidPendingBurn(state.pendingBurn))
    && Array.isArray(state.pendingTransfers) && state.pendingTransfers.length <= LIMITS.PENDING_TRANSFERS_MAX
    && state.pendingTransfers.every(isValidPendingTransfer)
    && hasExactKeys(state.settings, ['autoLockMinutes']) && AUTO_LOCK_CHOICES.includes(state.settings.autoLockMinutes)
    && isValidRecipients(state.recipients) && state.legacy === null
    && isValidRecipients(state.solanaRecipients, core.isValidSolanaAddress) && isValidRecentTransfers(state.recentTransfers)
    && typeof state.exposedAdvice === 'boolean'
    && (state.supersededBurn === null || isValidSupersededBurn(state.supersededBurn))
    && (state.registration === null || isValidRegistration(state.registration))
    && isValidSpends(state.spends);
}

// A state as an earlier 3.0.0 build wrote it, read as the current shape: the keys added since read as empty
// (anything else is left as is and judged by isValidState).
function currentShape(stored) {
  let state = stored;
  if (isPlainObject(state) && STATE_BASE_KEYS.every((key) => Object.hasOwn(state, key))
    && Object.keys(state).every((key) => STATE_KEYS.includes(key))) {
    const missing = Object.fromEntries(STATE_KEYS.filter((key) => !Object.hasOwn(state, key))
      .map((key) => [key, structuredClone(STATE_DEFAULTS[key])]));
    state = { ...state, ...missing };
  }
  if (isPlainObject(state) && hasExactKeys(state.pendingBurn, PENDING_BURN_KEYS_BEFORE)) {
    state = { ...state, pendingBurn: { ...state.pendingBurn, lastValidBlockHeight: null } };
  }
  if (isPlainObject(state) && Array.isArray(state.pendingTransfers)
    && state.pendingTransfers.some((p) => hasExactKeys(p, PENDING_TRANSFER_KEYS_BEFORE) || hasExactKeys(p, PENDING_TRANSFER_KEYS_BEFORE_CALLS))) {
    const pendingTransfers = state.pendingTransfers.map((p) => {
      if (hasExactKeys(p, PENDING_TRANSFER_KEYS_BEFORE)) return { ...p, outcome: 'pending', kind: 'transfer', call: null };
      return hasExactKeys(p, PENDING_TRANSFER_KEYS_BEFORE_CALLS) ? { ...p, kind: 'transfer', call: null } : p;
    });
    state = { ...state, pendingTransfers };
  }
  return state;
}

// The state belongs to the wallet named by the AAD: one activation, burned by this wallet's Solana key, with the
// burner's code, or a light burn aiqnet.io paid for this wallet, with the wallet's code (isPaidOnSite).
function isConsistentState(state, aad) {
  const { activation, pendingBurn } = state;
  const burners = [aad.solanaAddress];
  return (activation?.nodeType ?? null) === aad.activationNodeType
    && !(activation !== null && pendingBurn !== null)
    && (activation === null || (burners.includes(activation.solanaAddress)
      && core.activationCodeMatches(activation.code, activation.nodeType, activation.solanaAddress, activation.burnTx, activation.burnAmount))
      || isPaidOnSite(activation, state.registration, aad.qnetAddress, burners))
    && (pendingBurn === null || pendingBurn.solanaAddress === aad.solanaAddress)
    && (state.supersededBurn === null || (state.supersededBurn.solanaAddress === aad.solanaAddress
      && state.supersededBurn.burnTx !== activation?.burnTx))
    // a registration records the light activation of this wallet's own light node
    && (state.registration === null || (activation?.nodeType === 'light' && state.registration.burnTx === activation.burnTx
      && state.registration.burner === activation.solanaAddress && state.registration.nodeId === core.lightNodeId(aad.qnetAddress)))
    && !state.recipients.includes(aad.qnetAddress) && !state.solanaRecipients.includes(aad.solanaAddress);
}


// An AAD of an earlier 3.0.0 build, without the key `legacy`: the next unlock rewrites the record.
const aadIsOutdated = (aad) => !Object.hasOwn(aad, 'legacy');

// R15: the first activation is final (never replaced or removed short of a wipe), and a sent burn is
// never swapped for another one.
function transitionRefusal(previous, next) {
  if (previous.activation !== null && !sameJson(previous.activation, next.activation)) return 'ALREADY_ACTIVATED';
  if (next.activation !== null && next.pendingBurn !== null) return 'ALREADY_ACTIVATED';
  if (previous.pendingBurn !== null && next.pendingBurn !== null && !sameJson(previous.pendingBurn, next.pendingBurn)) {
    return 'BURN_IN_PROGRESS';
  }
  return null;
}

/**
 * Plaintext bytes: [PLAINTEXT_VERSION][entropy length (16|32)][entropy][UTF-8 canonicalJson(state)].
 * Keeps the entropy out of JS strings so it can be zeroized.
 * @param {Uint8Array} entropy 16 or 32 bytes
 * @param {VaultState} state
 * @returns {Uint8Array} the caller zeroizes it after encryption
 * @throws {WalletError} INTERNAL on a malformed input
 */
export function encodePlaintext(entropy, state) {
  if (!(entropy instanceof Uint8Array) || (entropy.length !== 16 && entropy.length !== 32) || !isValidState(state)) {
    throw internal();
  }
  const json = utf8.encode(canonicalJson(state));
  if (json.length > STATE_MAX_BYTES) throw internal();
  const out = new Uint8Array(2 + entropy.length + json.length);
  out[0] = PLAINTEXT_VERSION;
  out[1] = entropy.length;
  out.set(entropy, 2);
  out.set(json, 2 + entropy.length);
  return out;
}

/**
 * Inverse of encodePlaintext, with a strict shape check of the state.
 * @param {Uint8Array} bytes
 * @returns {{entropy: Uint8Array, state: VaultState}} entropy is a copy the caller zeroizes
 * @throws {WalletError} VAULT_CORRUPT
 */
export function decodePlaintext(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4 || bytes[0] !== PLAINTEXT_VERSION) throw corrupt();
  const length = bytes[1];
  if ((length !== 16 && length !== 32) || bytes.length < 2 + length + 2) throw corrupt();
  let state;
  try {
    const text = strictUtf8.decode(bytes.subarray(2 + length));
    const stored = JSON.parse(text);
    state = canonicalJson(stored) === text ? currentShape(stored) : null;
    if (!isValidState(state)) state = null;
  } catch {
    state = null;
  }
  if (state === null) throw corrupt();
  return { entropy: bytes.slice(2, 2 + length), state };
}

// ---------------------------------------------------------------- keys and records

/**
 * 32-byte AES key from a normalized password: Argon2id (core.argon2idAsync, the bundle's WebAssembly
 * build, dkLen 32) or PBKDF2-SHA256.
 * @param {string} normalizedPassword output of normalizePassword
 * @param {KdfParams} kdf checked with assertKdfFloor first
 * @returns {Promise<Uint8Array>} the caller zeroizes it
 * @throws {WalletError} KDF_BELOW_FLOOR; VAULT_CORRUPT for parameters above the sane ceiling
 */
export async function deriveVaultKey(normalizedPassword, kdf) {
  assertKdfFloor(kdf);
  if (!isWellFormedKdf(kdf)) throw corrupt();
  if (typeof normalizedPassword !== 'string' || normalizedPassword.length === 0) throw new WalletError('BAD_PASSWORD');
  const salt = decodeBase64(kdf.salt, SALT_RANGE);
  const password = utf8.encode(normalizedPassword);
  try {
    let key;
    if (kdf.alg === 'argon2id') {
      key = await core.argon2idAsync(password, salt, { m: kdf.m, t: kdf.t, p: kdf.p, dkLen: KEY_BYTES });
    } else {
      const base = await crypto.subtle.importKey('raw', password, 'PBKDF2', false, ['deriveBits']);
      const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: kdf.iterations }, base, KEY_BYTES * 8,
      );
      key = new Uint8Array(bits);
    }
    if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) throw internal();
    return key;
  } finally {
    core.zeroize(password, salt);
  }
}

function aesKey(vaultKey, usage) {
  if (!(vaultKey instanceof Uint8Array) || vaultKey.length !== KEY_BYTES) throw internal();
  return crypto.subtle.importKey('raw', vaultKey, { name: 'AES-GCM' }, false, [usage]);
}

const aadBytes = (aad) => utf8.encode(canonicalJson(aad));

function isValidAad(aad) {
  return (hasExactKeys(aad, AAD_KEYS) || hasExactKeys(aad, AAD_KEYS_BEFORE)) && aad.v === RECORD_VERSION
    && isWellFormedKdf(aad.kdf) && typeof aad.walletId === 'string' && UUID_RE.test(aad.walletId)
    && core.isValidQnetAddress(aad.qnetAddress) && core.isValidSolanaAddress(aad.solanaAddress)
    && isCount(aad.createdAt)
    && (aad.activationNodeType === null || core.ACTIVATION_NODE_TYPES.includes(aad.activationNodeType))
    && (!Object.hasOwn(aad, 'legacy') || aad.legacy === null);
}

/**
 * Strict shape check of a stored record; the bytes it carries, decoded. Exported for tests.
 * @param {unknown} raw
 * @returns {{raw: VaultRecord, kdf: KdfParams, aad: VaultAad, iv: Uint8Array, ct: Uint8Array, sitesKey: Uint8Array}}
 * @throws {WalletError} VAULT_CORRUPT
 */
export function parseRecord(raw) {
  if (!hasExactKeys(raw, RECORD_KEYS) || raw.v !== RECORD_VERSION || !isWellFormedKdf(raw.kdf)) throw corrupt();
  const { aad } = raw;
  if (!isValidAad(aad) || !sameJson(aad.kdf, raw.kdf)) throw corrupt();
  const iv = decodeBase64(raw.iv, { min: IV_BYTES, max: IV_BYTES });
  const ct = decodeBase64(raw.ct, CT_RANGE);
  const sitesKey = decodeBase64(raw.sitesKey, { min: SITES_KEY_BYTES, max: SITES_KEY_BYTES });
  if (iv === null || ct === null || sitesKey === null) throw corrupt();
  return { raw, kdf: raw.kdf, aad, iv, ct, sitesKey };
}

/**
 * Encrypts entropy and state into a new record under `vaultKey` (fresh IV; the AAD carries the
 * metadata and state.activation's node type). Exported for tests.
 * @param {Uint8Array} vaultKey 32 bytes, not zeroized here
 * @param {{kdf: KdfParams, walletId: string, qnetAddress: string, solanaAddress: string, createdAt: number,
 *   sitesKey: string}} meta
 * @param {Uint8Array} entropy
 * @param {VaultState} state
 * @returns {Promise<VaultRecord>}
 * @throws {WalletError} INTERNAL on malformed input
 */
export async function sealRecord(vaultKey, meta, entropy, state) {
  const plaintext = encodePlaintext(entropy, state);
  try {
    const aad = {
      v: RECORD_VERSION,
      kdf: { ...meta.kdf },
      walletId: meta.walletId,
      qnetAddress: meta.qnetAddress,
      solanaAddress: meta.solanaAddress,
      createdAt: meta.createdAt,
      activationNodeType: state.activation?.nodeType ?? null,
      legacy: null,
    };
    if (!isValidAad(aad) || !isConsistentState(state, aad)
      || decodeBase64(meta.sitesKey, { min: SITES_KEY_BYTES, max: SITES_KEY_BYTES }) === null) {
      throw internal();
    }
    const iv = randomBytes(IV_BYTES);
    const key = await aesKey(vaultKey, 'encrypt');
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aadBytes(aad), tagLength: 128 }, key,
      plaintext);
    return {
      v: RECORD_VERSION, kdf: { ...meta.kdf }, iv: core.base64Encode(iv), ct: core.base64Encode(new Uint8Array(ct)), aad,
      sitesKey: meta.sitesKey,
    };
  } finally {
    core.zeroize(plaintext);
  }
}

// null when AES-GCM authentication fails: wrong key, or anything in iv, ct or aad changed.
async function decryptParsed(parsed, vaultKey) {
  const key = await aesKey(vaultKey, 'decrypt');
  let plaintext;
  try {
    const buffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: parsed.iv, additionalData: aadBytes(parsed.aad), tagLength: 128 }, key, parsed.ct,
    );
    plaintext = new Uint8Array(buffer);
  } catch (error) {
    if (error?.name === 'OperationError') return null;
    throw internal();
  }
  try {
    const opened = decodePlaintext(plaintext);
    if (!isConsistentState(opened.state, parsed.aad)) {
      core.zeroize(opened.entropy);
      throw corrupt();
    }
    return opened;
  } finally {
    core.zeroize(plaintext);
  }
}

/**
 * Decrypts a stored record with `vaultKey`. Exported for tests.
 * @param {VaultRecord} record
 * @param {Uint8Array} vaultKey
 * @returns {Promise<{entropy: Uint8Array, state: VaultState}|null>} null when authentication fails
 * @throws {WalletError} VAULT_CORRUPT for a malformed record or plaintext
 */
export async function openRecord(record, vaultKey) {
  return decryptParsed(parseRecord(record), vaultKey);
}

const metaOf = (parsed) => ({
  kdf: parsed.kdf,
  walletId: parsed.aad.walletId,
  qnetAddress: parsed.aad.qnetAddress,
  solanaAddress: parsed.aad.solanaAddress,
  createdAt: parsed.aad.createdAt,
  sitesKey: parsed.raw.sitesKey,
});

// ---------------------------------------------------------------- IndexedDB

const openConnections = new Set();

function indexedDb() {
  const factory = globalThis.indexedDB;
  if (!factory || typeof factory.open !== 'function') throw internal();
  return factory;
}

function closeQuietly(db) {
  openConnections.delete(db);
  try {
    db.close();
  } catch {
    // already closed
  }
}

// create=false never creates the database: the upgrade from version 0 is aborted, which leaves nothing
// behind, and the open resolves null ("no vault"). Every path settles (EXT-SEC-21).
function openVaultDb(create) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, value) => {
      if (!settled) {
        settled = true;
        fn(value);
      }
    };
    let request;
    try {
      request = indexedDb().open(VAULT_DB.NAME, VAULT_DB.VERSION);
    } catch {
      reject(internal());
      return;
    }
    request.onupgradeneeded = (event) => {
      if (!create && event.oldVersion === 0) {
        request.transaction.abort();
        return;
      }
      const db = request.result;
      if (!db.objectStoreNames.contains(VAULT_DB.STORE)) db.createObjectStore(VAULT_DB.STORE);
    };
    request.onblocked = () => settle(reject, internal());
    request.onerror = () => {
      const name = request.error?.name;
      if (!create && name === 'AbortError') settle(resolve, null);
      else settle(reject, name === 'VersionError' ? corrupt() : internal());
    };
    request.onsuccess = () => {
      const db = request.result;
      if (settled) {
        db.close();
        return;
      }
      db.onversionchange = () => closeQuietly(db);
      openConnections.add(db);
      settle(resolve, db);
    };
  });
}

// Every write commits with 'strict' durability: `complete` fires only once the data is flushed to disk, not
// when it reached the OS buffer (Chrome's 'relaxed' default since 121): a write reported done survives a crash
// right after it (EXT-VAULT-R2-03).
const WRITE_OPTIONS = Object.freeze({ durability: 'strict' });

function transact(db, mode, operate) {
  return new Promise((resolve, reject) => {
    let result;
    let tx;
    try {
      tx = mode === 'readwrite' ? db.transaction(VAULT_DB.STORE, mode, WRITE_OPTIONS) : db.transaction(VAULT_DB.STORE, mode);
      const request = operate(tx.objectStore(VAULT_DB.STORE));
      request.onsuccess = () => {
        result = request.result;
      };
    } catch {
      try {
        tx?.abort();
      } catch {
        // not started
      }
      reject(internal());
      return;
    }
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error?.name === 'ConstraintError' ? new WalletError('VAULT_EXISTS') : internal());
  });
}

async function withDb(create, fn) {
  const db = await openVaultDb(create);
  if (db === null) return fn(null);
  try {
    return await fn(db);
  } finally {
    closeQuietly(db);
  }
}

const hasStore = (db) => db !== null && db.objectStoreNames.contains(VAULT_DB.STORE);

async function readRawValue(key) {
  return withDb(false, async (db) => {
    if (!hasStore(db)) return null;
    const value = await transact(db, 'readonly', (store) => store.get(key));
    return value === undefined ? null : value;
  });
}

const readRawRecord = () => readRawValue(VAULT_DB.KEY);

// add, not put: two racing creations can never both succeed (ConstraintError → VAULT_EXISTS).
const addRecord = (record) => withDb(true, (db) => transact(db, 'readwrite', (store) => store.add(record, VAULT_DB.KEY)));

const putRecord = (record) => withDb(false, (db) => {
  if (!hasStore(db)) throw internal();
  return transact(db, 'readwrite', (store) => store.put(record, VAULT_DB.KEY));
});

const removeRecord = () => withDb(false, (db) => (hasStore(db)
  ? transact(db, 'readwrite', (store) => store.delete(VAULT_DB.KEY)) : undefined));

async function loadParsedRecord() {
  const raw = await readRawRecord();
  return raw === null ? null : parseRecord(raw);
}

// Every read and write of the record runs one at a time: a password change, a state update and a
// decrypt with the session key can never interleave. Mutators and callers inside must not re-enter.
let queue = Promise.resolve();
function exclusive(task) {
  const run = queue.then(task);
  queue = run.then(noop, noop);
  return run;
}

// ---------------------------------------------------------------- password and session paths

// Floor, backoff, KDF and decrypt; counts the attempt. The caller zeroizes key and entropy.
async function openWithPassword(parsed, password) {
  assertKdfFloor(parsed.kdf);
  await session.checkBackoff();
  const key = await deriveVaultKey(normalizePassword(password), parsed.kdf);
  let opened;
  try {
    opened = await decryptParsed(parsed, key);
  } catch (error) {
    core.zeroize(key);
    throw error;
  }
  if (opened === null) {
    core.zeroize(key);
    await session.recordPasswordFailure();
    throw new WalletError('BAD_PASSWORD');
  }
  await session.recordPasswordSuccess();
  return { key, entropy: opened.entropy, state: opened.state };
}

async function lockOnDoubt(error) {
  if (error?.code === 'VAULT_CORRUPT' || error?.code === 'ADDRESS_MISMATCH') await session.lock('error');
  throw error;
}

// The record of the running session. A missing, corrupt or foreign record locks the session.
async function sessionRecord() {
  const info = await session.requireUnlocked();
  const parsed = await loadParsedRecord().catch(lockOnDoubt);
  if (parsed === null) {
    await session.lock('error');
    throw new WalletError('LOCKED');
  }
  if (parsed.aad.walletId !== info.walletId) {
    await session.lock('error');
    throw corrupt();
  }
  return parsed;
}

async function decryptWithSession(parsed, vaultKey) {
  const opened = await decryptParsed(parsed, vaultKey).catch(lockOnDoubt);
  if (opened === null) {
    await session.lock('error');
    throw corrupt();
  }
  return opened;
}

function assertAddresses(entropy, aad) {
  const derived = keys.deriveAddresses(entropy);
  if (derived.qnetAddress !== aad.qnetAddress || derived.solanaAddress !== aad.solanaAddress) {
    throw new WalletError('ADDRESS_MISMATCH');
  }
}

// Read back what was just written: the same record, decryptable with the key, holding the same entropy,
// whose addresses re-derive to the AAD's (EXT-SEC-M2).
async function confirmWritten(record, vaultKey, entropy, storeKey = VAULT_DB.KEY) {
  const back = await readRawValue(storeKey);
  if (back === null) throw corrupt();
  const parsed = parseRecord(back);
  if (canonicalJson(back) !== canonicalJson(record)) throw corrupt();
  const opened = await decryptParsed(parsed, vaultKey);
  if (opened === null) throw corrupt();
  try {
    if (!core.equalBytes(opened.entropy, entropy)) throw corrupt();
    assertAddresses(opened.entropy, parsed.aad);
  } finally {
    core.zeroize(opened.entropy);
  }
}

// `keep`: keys that may be written again meanwhile and hold nothing of the wallet.
async function clearArea(area, keep = []) {
  await area.clear();
  const left = Object.keys((await area.get(null)) ?? {}).filter((key) => !keep.includes(key));
  if (left.length > 0) throw internal();
}

// The staged record of a restore that did not finish (R5-ESM-03): it holds the typed phrase's entropy under the
// restore password, and outside a running restore it is never valid, so it goes whenever one is found. Callers
// hold the record lock (exclusive).
const dropRestoreStaging = () => withDb(false, (db) => (hasStore(db)
  ? transact(db, 'readwrite', (store) => store.delete(RESTORE_STAGING_KEY)) : undefined));

// A forgot-password restore replaces the vault by writing before it deletes (EXT-VAULT-R3-04): the new
// record is staged next to the old one and read back; then one transaction clears the store and puts the new
// record under the vault key, so either the old vault or the new one is there whatever
// fails or crashes; the session ends as a wipe ends it; the final record is read back; the old wallet's
// entries in chrome.storage go last (they open nothing of the new wallet: its grants need its sitesKey). When
// anything before that transaction commits fails, the staged copy is deleted again (R5-ESM-03); one a stopped
// worker left goes at the next start or unlock (discardRestoreStaging).
async function replaceVault({ vaultKey, record }, entropy) {
  let replaced = false;
  try {
    await withDb(false, (db) => {
      if (!hasStore(db)) throw internal();
      return transact(db, 'readwrite', (store) => store.put(record, RESTORE_STAGING_KEY));
    });
    await confirmWritten(record, vaultKey, entropy, RESTORE_STAGING_KEY);
    await withDb(false, (db) => {
      if (!hasStore(db)) throw internal();
      return transact(db, 'readwrite', (store) => {
        store.clear();
        return store.put(record, VAULT_DB.KEY);
      });
    });
    replaced = true;
  } finally {
    if (!replaced) await dropRestoreStaging().catch((error) => log.error('restore staging not deleted', error?.code ?? error?.name));
  }
  await session.lock('wipe');
  await confirmWritten(record, vaultKey, entropy);
  // failed attempts on the replaced vault must not delay the next one (a restore checks no password)
  await session.recordPasswordSuccess();
  const storage = globalThis.chrome?.storage;
  try {
    if (!storage?.local || !storage?.session) throw internal();
    await clearArea(storage.local);
    await clearArea(storage.session, [STORAGE_KEYS.SELF_TEST]);
  } catch (error) {
    log.error('storage of the replaced vault not cleared', error?.code ?? error?.name);
  }
  // the earlier version's pages' copy goes with its record, which the clear above removed
  await earlier.deleteEarlierDatabase().catch((error) => log.error('earlier database not deleted', error?.code ?? error?.name));
}

// Lock (reason 'wipe'), delete the database, clear chrome.storage.local (and the earlier version's database) and
// session, check nothing is left.
async function eraseAll() {
  await session.lock('wipe');
  await deleteVaultDatabase();
  // Failed attempts on the deleted vault must not delay the next one (a restore checks no password);
  // the backoff also lives in session memory, which the storage clear below does not reach.
  await session.recordPasswordSuccess();
  const storage = globalThis.chrome?.storage;
  if (!storage?.local || !storage?.session) throw internal();
  await clearArea(storage.local);
  // the earlier version's pages' copy goes with its record, which the clear above removed
  await earlier.deleteEarlierDatabase().catch((error) => log.error('earlier database not deleted', error?.code ?? error?.name));
  // The crypto self-test pass (keys.startKeys) is not wallet data and may land after the clear.
  await clearArea(storage.session, [STORAGE_KEYS.SELF_TEST]);
  if ((await readRawRecord()) !== null) throw internal();
}

// ---------------------------------------------------------------- API

/**
 * Worker start: deletes the staged record of a forgot-password restore that a stopped worker (browser closed,
 * extension reloaded or updated) left between its write and the replacing transaction (R5-ESM-03). Unlock does
 * the same. Never touches the vault record itself.
 * @returns {Promise<void>}
 */
export async function discardRestoreStaging() {
  return exclusive(() => dropRestoreStaging());
}

/**
 * Whether a v3 vault record exists. Resolves false (never hangs) when the DB or record is missing
 * (EXT-SEC-21); asking never creates the database (its onupgradeneeded aborts a creation from version 0).
 * @returns {Promise<boolean>}
 */
export async function vaultExists() {
  return exclusive(async () => (await readRawRecord()) !== null);
}

/**
 * Handler of `vault.status`. Never needs the password.
 * @returns {Promise<{exists: boolean, unlocked: boolean, lockDeadline: number|null,
 *   addresses: {qnet: string, solana: string}|null, signingEnabled: boolean, backoffUntil: number|null, earlier: boolean}>}
 *   addresses only while unlocked (from the session, which took them from the authenticated record); earlier: the wallet
 *   an earlier version of this extension kept is still in this browser (earlier.js)
 */
export async function getStatus() {
  const raw = await exclusive(() => readRawRecord());
  const exists = raw !== null;
  let info = await session.peekSession();
  if (info !== null && !exists) {
    await session.lock('error');
    info = null;
  }
  return {
    exists,
    unlocked: info !== null,
    lockDeadline: info?.lockDeadline ?? null,
    addresses: info === null ? null : { qnet: info.qnetAddress, solana: info.solanaAddress },
    signingEnabled: await keys.startKeys(),
    backoffUntil: await session.getBackoffUntil(),
    earlier: (await earlier.readEarlierWallet()) !== null,
  };
}

async function createFromPhrase(canonical, password) {
  const entropy = core.mnemonicToEntropy(canonical);
  let result;
  try {
    result = await writeNewVault(entropy, password);
  } finally {
    core.zeroize(entropy);
  }
  // what an earlier version left with no wallet record it can open opens nothing: it goes with the new vault
  try {
    if ((await earlier.readEarlierWallet()) === null && await earlier.hasEarlierData()) await earlier.removeEarlierData();
  } catch (error) {
    log.warn('earlier version data not removed', error?.code ?? error?.name);
  }
  return result;
}

/**
 * Handler of `vault.create`: a new vault from a phrase the setup page generated and the user verified.
 * Refuses when a vault exists. Writes the record, reads it back, decrypts it with the password, re-derives
 * and compares both addresses before reporting success (EXT-SEC-M2), then starts the session.
 * @param {{mnemonic: string, password: string}} params mnemonic must already be canonical, 12 or 24 words
 * @returns {Promise<{qnet: string, solana: string, lockDeadline: number}>}
 * @throws {WalletError} VAULT_EXISTS, WEAK_PASSWORD, VAULT_CORRUPT, ADDRESS_MISMATCH; CoreError INVALID_MNEMONIC
 */
export async function createVault(params) {
  const { mnemonic, password } = params ?? {};
  if (await vaultExists()) throw new WalletError('VAULT_EXISTS');
  normalizeNewPassword(password);
  const canonical = core.parseMnemonic(mnemonic);
  if (canonical !== mnemonic) throw new WalletError('INVALID_MNEMONIC');
  return createFromPhrase(canonical, password);
}


/**
 * Handler of `vault.import`: as createVault, but the phrase is canonicalized first (R06). Twelve or 24 words
 * and a new password, nothing else.
 * @param {{mnemonic: string, password: string}} params
 * @returns {Promise<{qnet: string, solana: string, lockDeadline: number}>}
 * @throws {WalletError} VAULT_EXISTS, WEAK_PASSWORD, VAULT_CORRUPT, ADDRESS_MISMATCH; CoreError INVALID_MNEMONIC
 */
export async function importVault(params) {
  const { mnemonic, password } = params ?? {};
  if (await vaultExists()) throw new WalletError('VAULT_EXISTS');
  normalizeNewPassword(password);
  return createFromPhrase(core.parseMnemonic(mnemonic), password);
}

/**
 * Handler of `vault.migrate` (setup only, M-4): moves the wallet an earlier version of this extension kept in this
 * browser (earlier.js: its record, then its pages' copy, which alone follows a password change made in 2.x) into a new
 * vault. Without newPassword it only checks the earlier password, with the backoff of unlock, and writes nothing. With
 * it, the earlier wallet is opened again, only its recovery phrase is kept, and a new vault is written from that phrase
 * under the new password as vault.import writes one (read back, both addresses re-derived, the session started);
 * everything the earlier version left is removed only once that vault was read back. A wrong password removes nothing.
 * @param {{password: string, newPassword?: string}} params password: the earlier version's, as typed
 * @returns {Promise<{checked: true}|{qnet: string, solana: string, lockDeadline: number|null}>}
 * @throws {WalletError} VAULT_EXISTS, NO_VAULT (no earlier wallet), WEAK_PASSWORD, BACKOFF, BAD_PASSWORD, VAULT_CORRUPT
 *   (it opens but holds no valid recovery phrase)
 */
export async function migrateEarlier(params) {
  const { password, newPassword } = params ?? {};
  if (newPassword !== undefined) normalizeNewPassword(newPassword);
  if (await vaultExists()) throw new WalletError('VAULT_EXISTS');
  const parsed = await earlier.readEarlierWallet();
  if (parsed === null) throw new WalletError('NO_VAULT');
  await session.checkBackoff();
  let entropy;
  try {
    entropy = await earlier.openEarlierWallet(parsed, password);
  } catch (error) {
    // it opened, so the password was right
    if (error?.code === 'VAULT_CORRUPT') await session.recordPasswordSuccess();
    throw error;
  }
  if (entropy === null) {
    await session.recordPasswordFailure();
    throw new WalletError('BAD_PASSWORD');
  }
  await session.recordPasswordSuccess();
  try {
    if (newPassword === undefined) return { checked: true };
    const result = await writeNewVault(entropy, newPassword);
    // writeNewVault read the new vault back before it answered
    await earlier.removeEarlierData().catch((error) => log.error('earlier wallet not removed', error?.code ?? error?.name));
    return result;
  } finally {
    core.zeroize(entropy);
  }
}

/**
 * Handler of `vault.removeEarlier` (setup and popup, unlocked; the router required confirm === 'REMOVE'): removes what an
 * earlier version of this extension kept in this browser (its keys and its pages' database, both copies of its encrypted
 * wallet among them), once the user confirmed it. Only while a vault of this version exists.
 * @returns {Promise<{removed: true}>}
 * @throws {WalletError} NO_VAULT, INTERNAL when something stays
 */
export async function removeEarlier() {
  if (!(await vaultExists())) throw new WalletError('NO_VAULT');
  await earlier.removeEarlierData();
  return { removed: true };
}

/**
 * Handler of `vault.unlock`. Always decrypts, even when already unlocked (EXT-SEC-M3). Enforces the KDF
 * floor, checks record.v/kdf against aad, re-derives both addresses and compares them with the AAD
 * (R20), then starts the session with state.settings.autoLockMinutes. Failures count toward the shared
 * backoff; success resets it. Afterwards qnet.resubmitPending runs in the background (sw.js wiring).
 * @param {{password: string}} params
 * @returns {Promise<{qnet: string, solana: string, lockDeadline: number|null}>} lockDeadline null for auto-lock Never
 * @throws {WalletError} NO_VAULT, BACKOFF, BAD_PASSWORD, KDF_BELOW_FLOOR, VAULT_CORRUPT, ADDRESS_MISMATCH
 */
export async function unlock(params) {
  return exclusive(async () => {
    const parsed = await loadParsedRecord().catch(lockOnDoubt);
    if (parsed === null) throw new WalletError('NO_VAULT');
    // no restore runs while this holds the record lock: a staged record here is one a stopped worker left (R5-ESM-03)
    await dropRestoreStaging().catch((error) => log.warn('restore staging not deleted', error?.code ?? error?.name));
    // a screen lock while the KDF runs keeps the session from starting behind it (R3-ESM-03)
    const since = session.lockMark();
    const { key, entropy, state } = await openWithPassword(parsed, params?.password).catch(lockOnDoubt);
    let handedOver = false;
    try {
      try {
        assertAddresses(entropy, parsed.aad);
      } catch (error) {
        await lockOnDoubt(error);
      }
      // A record of an earlier 3.0.0 build: its AAD gains the key `legacy` now.
      if (aadIsOutdated(parsed.aad)) {
        await sealRecord(key, metaOf(parsed), entropy, state).then(putRecord)
          .catch((error) => log.warn('vault record not brought up to date', error?.code ?? error?.name));
      }
      handedOver = true;
      const { aad } = parsed;
      const { lockDeadline } = await session.startSession({
        vaultKey: key,
        walletId: aad.walletId,
        qnetAddress: aad.qnetAddress,
        solanaAddress: aad.solanaAddress,
        autoLockMinutes: state.settings.autoLockMinutes,
        since,
      });
      return { qnet: aad.qnetAddress, solana: aad.solanaAddress, lockDeadline };
    } finally {
      core.zeroize(entropy);
      if (!handedOver) core.zeroize(key);
    }
  });
}

/**
 * Checks a password by decrypting the record (with backoff), without changing the session. Used by the
 * handlers that re-prompt: reveal, wipe, changePassword, activation.burn, activation.copy.
 * @param {string} password
 * @returns {Promise<void>}
 * @throws {WalletError} NO_VAULT, BACKOFF, BAD_PASSWORD, KDF_BELOW_FLOOR, VAULT_CORRUPT
 */
export async function verifyPassword(password) {
  return exclusive(async () => {
    const parsed = await loadParsedRecord();
    if (parsed === null) throw new WalletError('NO_VAULT');
    const info = await session.peekSession();
    if (info !== null && info.walletId !== parsed.aad.walletId) {
      await session.lock('error');
      throw corrupt();
    }
    const opened = await openWithPassword(parsed, password);
    core.zeroize(opened.key, opened.entropy);
  });
}

/**
 * Handler of `vault.changePassword`: decrypt with the old password, re-encrypt everything with a fresh
 * salt, key and IV in one IndexedDB write (walletId, addresses, createdAt and sitesKey unchanged), then
 * swap the session key (R03, EXT-SEC-18). The record is read back before the swap; a bad write is undone.
 * @param {{password: string, newPassword: string}} params
 * @returns {Promise<{changed: true}>}
 * @throws {WalletError} LOCKED, BACKOFF, BAD_PASSWORD, WEAK_PASSWORD
 */
export async function changePassword(params) {
  const newNormalized = normalizeNewPassword(params?.newPassword);
  return exclusive(async () => {
    const parsed = await sessionRecord();
    const opened = await openWithPassword(parsed, params?.password);
    let newKey = null;
    try {
      const kdf = freshKdf();
      newKey = await deriveVaultKey(newNormalized, kdf);
      const record = await sealRecord(newKey, { ...metaOf(parsed), kdf }, opened.entropy, opened.state);
      await putRecord(record);
      try {
        await confirmWritten(record, newKey, opened.entropy);
      } catch (error) {
        await putRecord(parsed.raw).catch(() => log.error('vault restore after a failed password change failed'));
        throw error;
      }
      const handover = newKey;
      newKey = null;
      await session.replaceVaultKey(handover).catch((error) => {
        // Locked meanwhile: the new password is in place, the next unlock uses it.
        if (error?.code !== 'LOCKED') throw error;
      });
      return { changed: true };
    } finally {
      core.zeroize(opened.key, opened.entropy, newKey);
    }
  });
}

/**
 * Handler of `vault.reveal` (popup only): the recovery phrase after a fresh password decrypt. The only
 * response that ever carries it.
 * @param {{password: string}} params
 * @returns {Promise<{mnemonic: string}>}
 * @throws {WalletError} LOCKED, BACKOFF, BAD_PASSWORD
 */
export async function reveal(params) {
  return exclusive(async () => {
    const parsed = await sessionRecord();
    const opened = await openWithPassword(parsed, params?.password);
    core.zeroize(opened.key);
    try {
      return { mnemonic: core.entropyToMnemonic(opened.entropy) };
    } finally {
      core.zeroize(opened.entropy);
    }
  });
}

/**
 * Handler of `vault.wipe` (R16): password check, then lock (reason 'wipe'), close every connection,
 * await deleteDatabase (success, blocked, error handled), clear chrome.storage.local and session,
 * verify the vault is gone. The router already required confirm === 'DELETE'.
 * @param {{password: string, confirm: 'DELETE'}} params
 * @returns {Promise<{wiped: true}>}
 * @throws {WalletError} NO_VAULT, BACKOFF, BAD_PASSWORD, INTERNAL when the database could not be deleted
 */
export async function wipe(params) {
  return exclusive(async () => {
    const parsed = await loadParsedRecord();
    if (parsed === null) throw new WalletError('NO_VAULT');
    const opened = await openWithPassword(parsed, params?.password);
    core.zeroize(opened.key, opened.entropy);
    await eraseAll();
    return { wiped: true };
  });
}

// ---------------------------------------------------------------- forgot password: restore

// {token, expiresAt, holder} of the one restore the popup started; worker memory only.
let restoreGrant = null;

// The page a restore token belongs to: the popup's own document (its documentId when Chrome reports it).
function restoreHolder(meta) {
  const sender = meta?.sender;
  if (meta?.page !== 'popup' || typeof sender?.url !== 'string') return null;
  const documentId = typeof sender.documentId === 'string' ? sender.documentId : '';
  const tabId = Number.isSafeInteger(sender.tab?.id) ? sender.tab.id : '';
  return `${sender.url}\n${documentId}\n${tabId}`;
}

// One use: whatever the outcome, the token is gone after this, except that a restore which only checks the phrase
// and asks for the user's confirmation (nothing erased) hands it back (keepRestoreToken).
function takeRestoreToken(token, meta) {
  const grant = restoreGrant;
  restoreGrant = null;
  const valid = grant !== null && typeof token === 'string' && token.length === grant.token.length
    && core.equalBytes(core.utf8Encode(token), core.utf8Encode(grant.token))
    && Date.now() < grant.expiresAt && restoreHolder(meta) === grant.holder;
  if (!valid) throw new WalletError('RESTORE_EXPIRED');
  return grant;
}

// A newer token issued meanwhile wins; the kept one still expires at its own time.
function keepRestoreToken(grant) {
  if (restoreGrant === null) restoreGrant = grant;
}

const pairOf = (qnet, solana) => ({ qnet, solana });

/**
 * Handler of `vault.restoreBegin` (popup, Reset wallet: the phrase and a new password were typed): issues the one-time
 * token vault.restore requires, bound to the sending popup document, valid for TIMINGS.RESTORE_TOKEN_TTL_MS. A new
 * token replaces an earlier one. Nothing is erased here.
 * @param {{}} _params
 * @param {{page: string, sender: object}} meta the router's sender info
 * @returns {Promise<{token: string, expiresAt: number}>} token: 64 lowercase hex characters
 * @throws {WalletError} NO_VAULT; FORBIDDEN_SENDER when the sender is not the popup
 */
export async function beginRestore(_params, meta) {
  const holder = restoreHolder(meta);
  if (holder === null) throw new WalletError('FORBIDDEN_SENDER');
  if (!(await vaultExists())) throw new WalletError('NO_VAULT');
  const token = core.bytesToHex(randomBytes(RESTORE_TOKEN_BYTES));
  const expiresAt = Date.now() + TIMINGS.RESTORE_TOKEN_TTL_MS;
  restoreGrant = { token, expiresAt, holder };
  return { token, expiresAt };
}

/**
 * Handler of `vault.restore` (popup, "Forgot password?" → Reset wallet): replaces the vault of this browser with the
 * one of a recovery phrase and a new password. Order: consume the token; check the new password and the phrase
 * (canonicalized, validated) and derive its addresses; compare them with the replaced record's AAD (readable without
 * the password). A call without `confirm` (RESTORE_CONFIRM) answers `confirm` naming both wallets and erases nothing:
 * the popup shows them for the one confirmation. A phrase of another wallet (EXT-VAULT-R2-04) also needs `replaceOther`
 * on the confirmed call, else it answers `confirm` again. Every `confirm` answer hands the token back for the confirmed
 * call. Then the key and sealed record, which is written and read back BEFORE the old vault goes (EXT-VAULT-R3-04:
 * staged, then one transaction replaces everything; the old activation record goes with it, and Recover finds the burn
 * again); the final record is read back, decrypted and its addresses compared (EXT-SEC-M2); then the session starts,
 * unless the screen locked meanwhile (R3-ESM-03: lockDeadline null, the vault stays locked). Any failure before the
 * replace leaves the old vault as it was. A record that does not parse cannot be opened or compared (`erased` null) and
 * is replaced once confirmed (R2-ESM-05).
 * @param {{token: string, mnemonic: string, password: string, confirm?: 'ERASE', replaceOther?: boolean}} params
 * @param {{page: string, sender: object}} meta
 * @returns {Promise<{status: 'restored', qnet: string, solana: string, lockDeadline: number|null}
 *   | {status: 'confirm', erased: {qnet: string, solana: string}|null, restored: {qnet: string, solana: string},
 *   otherWallet: boolean}>} confirm: the stored wallet the replace would erase (null: its record does not parse), the
 *   typed phrase's wallet, and whether they differ
 * @throws {WalletError} RESTORE_EXPIRED, WEAK_PASSWORD, NO_VAULT, SIGNING_DISABLED, VAULT_CORRUPT, ADDRESS_MISMATCH,
 *   INTERNAL; CoreError INVALID_MNEMONIC
 */
export async function restoreVault(params, meta) {
  const grant = takeRestoreToken(params?.token, meta);
  const normalized = normalizeNewPassword(params?.password);
  const entropy = core.mnemonicToEntropy(core.parseMnemonic(params?.mnemonic));
  try {
    return await exclusive(async () => {
      const raw = await readRawRecord();
      if (raw === null) throw new WalletError('NO_VAULT');
      let replaced = null;
      try {
        replaced = parseRecord(raw);
      } catch {
        replaced = null;
      }
      const typed = keys.deriveAddresses(entropy);
      const erased = replaced === null ? null : pairOf(replaced.aad.qnetAddress, replaced.aad.solanaAddress);
      const otherWallet = erased !== null && (erased.qnet !== typed.qnetAddress || erased.solana !== typed.solanaAddress);
      if (params?.confirm !== RESTORE_CONFIRM || (otherWallet && params?.replaceOther !== true)) {
        keepRestoreToken(grant);
        return { status: 'confirm', erased, restored: pairOf(typed.qnetAddress, typed.solanaAddress), otherWallet };
      }
      const since = session.lockMark();
      const sealed = await sealNewVault(entropy, normalized, emptyState());
      try {
        await replaceVault(sealed, entropy);
      } catch (error) {
        core.zeroize(sealed.vaultKey);
        throw error;
      }
      const restored = await startNewSession(sealed, since);
      return { status: 'restored', ...restored };
    });
  } finally {
    core.zeroize(entropy);
  }
}

/**
 * The wallet's recovery-phrase entropy, decrypted with the session key. Only keys.js calls it.
 * @returns {Promise<Uint8Array>} 16 or 32 bytes; the caller zeroizes it
 * @throws {WalletError} LOCKED, VAULT_CORRUPT
 */
export async function readEntropy() {
  return exclusive(async () => {
    const parsed = await sessionRecord();
    const opened = await session.withVaultKey((key) => decryptWithSession(parsed, key));
    return opened.entropy;
  });
}

/**
 * The decrypted non-secret state.
 * @returns {Promise<VaultState>}
 * @throws {WalletError} LOCKED, VAULT_CORRUPT
 */
export async function readState() {
  return exclusive(async () => {
    const parsed = await sessionRecord();
    const opened = await session.withVaultKey((key) => decryptWithSession(parsed, key));
    core.zeroize(opened.entropy);
    return opened.state;
  });
}

/**
 * Atomic read-modify-write of the state: decrypt, apply `mutator` to a copy, validate, re-encrypt with a
 * fresh IV and the updated aad.activationNodeType, write. Serialized: concurrent calls run one by one.
 * Invariants (R15): an activation, once stored, is never replaced or removed (ALREADY_ACTIVATED), none
 * is stored next to a pending burn (ALREADY_ACTIVATED), and a pending burn is never swapped for another
 * (BURN_IN_PROGRESS); both must name this wallet's Solana address.
 * @param {(state: VaultState) => VaultState|Promise<VaultState>} mutator must not touch the entropy and
 *   must not call back into vault.js or keys.js (they wait for this update to finish)
 * @returns {Promise<VaultState>} the stored state
 * @throws {WalletError} LOCKED, VAULT_CORRUPT, ALREADY_ACTIVATED, BURN_IN_PROGRESS, INTERNAL for an
 *   invalid new state; whatever the mutator throws
 */
export async function updateState(mutator) {
  if (typeof mutator !== 'function') throw internal();
  return exclusive(async () => {
    const parsed = await sessionRecord();
    return session.withVaultKey(async (key) => {
      const opened = await decryptWithSession(parsed, key);
      try {
        const next = await mutator(structuredClone(opened.state));
        if (!isValidState(next)) throw internal();
        const refusal = transitionRefusal(opened.state, next);
        if (refusal !== null) throw new WalletError(refusal);
        const nodeType = next.activation?.nodeType ?? null;
        if (!isConsistentState(next, { ...parsed.aad, activationNodeType: nodeType })) throw internal();
        if (!sameJson(next, opened.state)) {
          await putRecord(await sealRecord(key, metaOf(parsed), opened.entropy, next));
        }
        return structuredClone(next);
      } finally {
        core.zeroize(opened.entropy);
      }
    });
  });
}

/**
 * Writes a brand-new vault from entropy; shared by createVault and importVault. New walletId, createdAt, salt,
 * IV and sitesKey; state = emptyState(). Verifies by reading the record back and decrypting it (with the key
 * derived from `password` under the stored KDF parameters) before starting the session; a record that fails
 * the check is removed again.
 * @param {Uint8Array} entropy 16 or 32 bytes (not zeroized here)
 * @param {string} password raw password; normalized by normalizeNewPassword
 * @returns {Promise<{qnet: string, solana: string, lockDeadline: number}>}
 * @throws {WalletError} VAULT_EXISTS, WEAK_PASSWORD, VAULT_CORRUPT, ADDRESS_MISMATCH
 */
export async function writeNewVault(entropy, password) {
  const normalized = normalizeNewPassword(password);
  if (!isEntropy(entropy)) throw internal();
  return exclusive(async () => {
    if ((await readRawRecord()) !== null) throw new WalletError('VAULT_EXISTS');
    const since = session.lockMark();
    return commitNewVault(await sealNewVault(entropy, normalized, emptyState()), entropy, since);
  });
}

// Everything a new vault needs before anything is written: both addresses, a fresh KDF, the key and the
// sealed record with a new walletId, createdAt, salt, IV and sitesKey. The caller owns vaultKey.
async function sealNewVault(entropy, normalizedPassword, state) {
  if (!isEntropy(entropy)) throw internal();
  const { qnetAddress, solanaAddress } = keys.deriveAddresses(entropy);
  const kdf = freshKdf();
  const vaultKey = await deriveVaultKey(normalizedPassword, kdf);
  try {
    const meta = {
      kdf,
      walletId: crypto.randomUUID(),
      qnetAddress,
      solanaAddress,
      createdAt: Date.now(),
      sitesKey: core.base64Encode(randomBytes(SITES_KEY_BYTES)),
    };
    return { meta, vaultKey, record: await sealRecord(vaultKey, meta, entropy, state) };
  } catch (error) {
    core.zeroize(vaultKey);
    throw error;
  }
}

// Adds the sealed record, reads it back and checks it (a record that fails is removed again), then starts the
// session. Takes ownership of vaultKey: it goes to the session or is zeroized.
async function commitNewVault({ meta, vaultKey, record }, entropy, since) {
  try {
    await addRecord(record);
    try {
      await confirmWritten(record, vaultKey, entropy);
    } catch (error) {
      await removeRecord().catch(() => log.error('vault removal after a failed write check failed'));
      throw error;
    }
  } catch (error) {
    core.zeroize(vaultKey);
    throw error;
  }
  return startNewSession({ meta, vaultKey }, since);
}

// The session of a vault just written. `since`: session.lockMark() from before its KDF ran; a screen lock
// since then (or a screen locked now) leaves the new vault locked, lockDeadline null (R3-ESM-03).
async function startNewSession({ meta, vaultKey }, since) {
  let lockDeadline = null;
  try {
    ({ lockDeadline } = await session.startSession({
      vaultKey,
      walletId: meta.walletId,
      qnetAddress: meta.qnetAddress,
      solanaAddress: meta.solanaAddress,
      autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES,
      since,
    }));
  } catch (error) {
    if (!(error instanceof WalletError) || error.code !== 'LOCKED') throw error;
  }
  return { qnet: meta.qnetAddress, solana: meta.solanaAddress, lockDeadline };
}

/**
 * What provider.js needs to MAC and check site grants, readable while locked: the record's walletId and
 * sitesKey. Grants are bound to the wallet, so a new wallet never inherits the old one's sites.
 * @returns {Promise<{walletId: string, sitesKey: Uint8Array}|null>} null when no vault exists
 * @throws {WalletError} VAULT_CORRUPT when the record is malformed
 */
export async function readSiteBinding() {
  const raw = await readRawRecord();
  if (raw === null) return null;
  const parsed = parseRecord(raw);
  return { walletId: parsed.aad.walletId, sitesKey: parsed.sitesKey };
}

/**
 * Replaces the record's sitesKey with fresh random bytes, so no grant MAC made before stays valid: a
 * revoked grant written back into chrome.storage.local is refused (R22). Works while locked, since the
 * key sits outside the ciphertext; the rest of the record is kept byte for byte and read back.
 * @returns {Promise<{walletId: string, sitesKey: Uint8Array}|null>} the new binding; null when no vault exists
 * @throws {WalletError} VAULT_CORRUPT when the record is malformed or did not read back; INTERNAL
 */
export async function rotateSitesKey() {
  return exclusive(async () => {
    const raw = await readRawRecord();
    if (raw === null) return null;
    const parsed = parseRecord(raw);
    const sitesKey = randomBytes(SITES_KEY_BYTES);
    const record = { ...parsed.raw, sitesKey: core.base64Encode(sitesKey) };
    await putRecord(record);
    const back = await readRawRecord();
    if (back === null || canonicalJson(back) !== canonicalJson(record)) throw corrupt();
    return { walletId: parsed.aad.walletId, sitesKey };
  });
}

const isAnchors = (anchors) => isPlainObject(anchors) && Object.keys(anchors).length <= 2
  && Object.values(anchors).every((a) => hasExactKeys(a, ['eligible_ids', 'beacon', 'registry_root'])
    && Array.isArray(a.eligible_ids) && a.eligible_ids.length <= LIGHT_ANCHOR_IDS_MAX
    && a.eligible_ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 256)
    && typeof a.beacon === 'string' && typeof a.registry_root === 'string');

// HMAC-SHA256 of the anchors under a key derived from the session's vault key: without the password
// nobody, not even a program that can write this profile's database, can make a walk start elsewhere.
async function anchorsMac(parsed, anchors) {
  return session.withVaultKey((vaultKey) => {
    const key = core.hmac(core.sha256, vaultKey, utf8.encode(`${LIGHT_ANCHORS_LABEL}:${parsed.aad.walletId}`));
    try {
      return core.hmac(core.sha256, key, utf8.encode(canonicalJson(anchors)));
    } finally {
      core.zeroize(key);
    }
  });
}

/**
 * The light client's verified anchors kept by writeLightAnchors (core.exportVerifiedAnchors shape), or
 * null when there are none or their MAC does not verify under this session's vault key (after a password
 * change the next walk starts from the pin again). core.importVerifiedAnchors checks the shape again.
 * @returns {Promise<Record<string, {eligible_ids: string[], beacon: string, registry_root: string}>|null>}
 * @throws {WalletError} LOCKED
 */
export async function readLightAnchors() {
  return exclusive(async () => {
    const parsed = await sessionRecord();
    const value = await readRawValue(LIGHT_ANCHORS_KEY);
    if (!hasExactKeys(value, ['v', 'anchors', 'mac']) || value.v !== 1 || !isAnchors(value.anchors)) return null;
    const stored = decodeBase64(value.mac, { min: 32, max: 32 });
    if (stored === null || !core.equalBytes(stored, await anchorsMac(parsed, value.anchors))) return null;
    return structuredClone(value.anchors);
  });
}

/**
 * Keeps the light client's verified anchors (core.exportVerifiedAnchors) next to the record with their
 * MAC (anchorsMac), so a new worker walks on from them (EXT-CHAINS-04). Needs the session; a wipe deletes
 * them.
 * @param {Record<string, {eligible_ids: string[], beacon: string, registry_root: string}>} anchors
 * @returns {Promise<void>}
 * @throws {WalletError} LOCKED; INTERNAL for another shape
 */
export async function writeLightAnchors(anchors) {
  if (!isAnchors(anchors)) throw internal();
  const copy = structuredClone(anchors);
  await exclusive(async () => {
    const parsed = await sessionRecord();
    const mac = core.base64Encode(await anchorsMac(parsed, copy));
    return withDb(false, (db) => {
      if (!hasStore(db)) throw internal();
      return transact(db, 'readwrite', (store) => store.put({ v: 1, anchors: copy, mac }, LIGHT_ANCHORS_KEY));
    });
  });
}

// HMAC-SHA256 of the chain cache under a key derived from the vault key, as the anchors'.
function chainCacheMac(parsed, cache) {
  return session.withVaultKey((vaultKey) => {
    const key = core.hmac(core.sha256, vaultKey, utf8.encode(`${CHAIN_CACHE_LABEL}:${parsed.aad.walletId}`));
    try {
      return core.hmac(core.sha256, key, utf8.encode(canonicalJson(cache)));
    } finally {
      core.zeroize(key);
    }
  });
}

function isChainCache(cache) {
  try {
    return isPlainObject(cache) && canonicalJson(cache).length <= CHAIN_CACHE_MAX_CHARS;
  } catch {
    return false;
  }
}

// The record of the running session for the chain cache, or null when it cannot be read or is another wallet's: public
// data that never decides anything, so its read or write never locks the session (the vault's own reads do that).
async function chainRecord() {
  const info = await session.requireUnlocked();
  const parsed = await loadParsedRecord().catch(() => null);
  return parsed !== null && parsed.aad.walletId === info.walletId ? parsed : null;
}

// The stored chain cache whose MAC verifies under this session's key, else {} (none yet, a password change, or a write
// made without this vault's key). Callers hold the record lock (exclusive).
async function verifiedChainCache(parsed) {
  const value = await readRawValue(CHAIN_CACHE_KEY);
  if (!hasExactKeys(value, ['v', 'cache', 'mac']) || value.v !== 1 || !isChainCache(value.cache)) return {};
  const stored = decodeBase64(value.mac, { min: 32, max: 32 });
  return stored !== null && core.equalBytes(stored, await chainCacheMac(parsed, value.cache)) ? value.cache : {};
}

/**
 * The chain cache kept by updateChainCache: what the wallet last read of the QNet chain and of its balances, for the next
 * popup to draw at once and for qnet.js to tell a chain it no longer follows (CONTRACTS.md section 7). {} when there is
 * none or its MAC does not verify under this session's vault key. Public data only; qnet.js and session.js check its
 * fields again.
 * @returns {Promise<object>}
 * @throws {WalletError} LOCKED
 */
export async function readChainCache() {
  return exclusive(async () => {
    const parsed = await chainRecord();
    return parsed === null ? {} : structuredClone(await verifiedChainCache(parsed));
  });
}

/**
 * Read-modify-write of the chain cache under the record lock, with its MAC (chainCacheMac): `mutator` gets a copy and
 * returns the next cache (a plain JSON object of at most 64 KiB as canonical JSON); nothing is written when it is
 * unchanged, or when the session's record cannot be read (nothing is locked for it). Needs the session; a wipe and a
 * restore delete it.
 * @param {(cache: object) => object} mutator
 * @returns {Promise<object>} the stored cache
 * @throws {WalletError} LOCKED; INTERNAL for another shape
 */
export async function updateChainCache(mutator) {
  if (typeof mutator !== 'function') throw internal();
  return exclusive(async () => {
    const parsed = await chainRecord();
    if (parsed === null) return {};
    const current = await verifiedChainCache(parsed);
    const next = mutator(structuredClone(current));
    if (!isChainCache(next)) throw internal();
    if (sameJson(next, current)) return structuredClone(current);
    const cache = structuredClone(next);
    const mac = core.base64Encode(await chainCacheMac(parsed, cache));
    await withDb(false, (db) => {
      if (!hasStore(db)) throw internal();
      return transact(db, 'readwrite', (store) => store.put({ v: 1, cache, mac }, CHAIN_CACHE_KEY));
    });
    return structuredClone(cache);
  });
}

// HMAC-SHA256 of the burn searches under a key derived from the vault key: a program that can write this
// profile's database cannot make a search skip a candidate or forget a burn it found.
function burnScansMacWith(vaultKey, parsed, scans) {
  const key = core.hmac(core.sha256, vaultKey, utf8.encode(`${BURN_SCANS_LABEL}:${parsed.aad.walletId}`));
  try {
    return core.hmac(core.sha256, key, utf8.encode(canonicalJson(scans)));
  } finally {
    core.zeroize(key);
  }
}

const burnScansMac = (parsed, scans) => session.withVaultKey((vaultKey) => burnScansMacWith(vaultKey, parsed, scans));

// The stored burn searches, or null when there are none or they have another shape.
async function storedBurnScans() {
  const value = await readRawValue(BURN_SCANS_KEY);
  if (!hasExactKeys(value, ['v', 'scans', 'mac']) || value.v !== 1 || !isPlainObject(value.scans)
    || Object.keys(value.scans).length > BURN_SCAN_OWNERS_MAX) return null;
  return value;
}

// The stored searches whose MAC verifies under this session's key, else {} (a password change or a
// foreign write starts every search again from the chain).
async function verifiedBurnScans(parsed) {
  const value = await storedBurnScans();
  if (value === null) return {};
  const stored = decodeBase64(value.mac, { min: 32, max: 32 });
  let mac;
  try {
    mac = await burnScansMac(parsed, value.scans);
  } catch (error) {
    if (error?.code === 'LOCKED') throw error;
    return {};
  }
  return stored !== null && core.equalBytes(stored, mac) ? value.scans : {};
}

// The key a burn search of `owner` is kept under: its associated-account search, or its signed-transactions one.
function burnScanKey(owner, kind) {
  if (!core.isValidSolanaAddress(owner) || !Object.hasOwn(BURN_SCAN_KINDS, kind)) throw internal();
  return owner + BURN_SCAN_KINDS[kind];
}

/**
 * The burn search solana.js kept for `owner` (writeBurnScan), or null when there is none or its MAC does not verify
 * under this session's vault key. solana.js checks its shape again.
 * @param {string} owner the wallet's Solana address
 * @param {'account'|'signed'} [kind] account: findWalletBurns over its 1DEV associated account; signed:
 *   findSignedBurns over the transactions it signed (R5-ESA-01)
 * @returns {Promise<object|null>}
 * @throws {WalletError} LOCKED
 */
export async function readBurnScan(owner, kind = 'account') {
  const key = burnScanKey(owner, kind);
  return exclusive(async () => {
    const parsed = await sessionRecord();
    const scans = await verifiedBurnScans(parsed);
    return Object.hasOwn(scans, key) ? structuredClone(scans[key]) : null;
  });
}

/**
 * Keeps a burn search of `owner` next to the record with a MAC under the vault key (at most its two kinds; another
 * owner replaces the oldest). Needs the session; a wipe deletes it.
 * @param {string} owner
 * @param {object} scan JSON data (solana.findWalletBurns' state), at most 4 MiB as canonical JSON with the others
 * @param {'account'|'signed'} [kind]
 * @returns {Promise<void>}
 * @throws {WalletError} LOCKED; INTERNAL for another shape
 */
export async function writeBurnScan(owner, scan, kind = 'account') {
  const key = burnScanKey(owner, kind);
  if (!isPlainObject(scan)) throw internal();
  const copy = structuredClone(scan);
  await exclusive(async () => {
    const parsed = await sessionRecord();
    const scans = { ...(await verifiedBurnScans(parsed)) };
    delete scans[key];
    scans[key] = copy;
    for (const other of Object.keys(scans)) {
      if (Object.keys(scans).length <= BURN_SCAN_OWNERS_MAX) break;
      if (other !== key) delete scans[other];
    }
    if (canonicalJson(scans).length > BURN_SCANS_MAX_CHARS) throw internal();
    const mac = core.base64Encode(await burnScansMac(parsed, scans));
    return withDb(false, (db) => {
      if (!hasStore(db)) throw internal();
      return transact(db, 'readwrite', (store) => store.put({ v: 1, scans, mac }, BURN_SCANS_KEY));
    });
  });
}

/**
 * Closes every open connection and deletes the vault database. Used by wipe. A delete blocked by a
 * connection elsewhere is awaited for a bounded time.
 * @returns {Promise<void>}
 * @throws {WalletError} INTERNAL when the deletion stays blocked or fails
 */
export async function deleteVaultDatabase() {
  for (const db of [...openConnections]) closeQuietly(db);
  await new Promise((resolve, reject) => {
    let request;
    try {
      request = indexedDb().deleteDatabase(VAULT_DB.NAME);
    } catch {
      reject(internal());
      return;
    }
    const timer = setTimeout(() => reject(internal()), DELETE_WAIT_MS);
    request.onsuccess = () => {
      clearTimeout(timer);
      resolve();
    };
    request.onerror = () => {
      clearTimeout(timer);
      reject(internal());
    };
    request.onblocked = () => log.warn('vault delete blocked');
  });
}
