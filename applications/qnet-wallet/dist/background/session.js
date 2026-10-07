// The unlocked session (R07, R08). After unlock the worker holds only the 32-byte vault key and the
// public addresses, in memory and mirrored to chrome.storage.session (TRUSTED_CONTEXTS) with a lock
// deadline, so a restarted worker resumes until the deadline. Never the password, phrase or a private key.
// One chrome.alarms timer enforces the deadline; every privileged call re-checks it too. Auto-lock Never
// (AUTO_LOCK_NEVER) has no deadline: the session then ends on Lock, the OS screen lock, or when the browser closes and
// chrome.storage.session goes with it.
import * as core from '../lib/qnet-core.js';
import {
  AUTO_LOCK_ALARM, AUTO_LOCK_CHOICES, AUTO_LOCK_NEVER, DEFAULT_LANGUAGE, LIMITS, STORAGE_KEYS, SUPPORTED_LANGUAGES, languageForTag,
} from './config.js';
import { WalletError } from './errors.js';
import { log } from './log.js';
import * as vault from './vault.js';

/**
 * @typedef {object} SessionInfo
 * @property {string} walletId
 * @property {string} qnetAddress
 * @property {string} solanaAddress
 * @property {number|null} lockDeadline ms epoch; null for auto-lock Never
 *
 * @typedef {object} StoredSession  chrome.storage.session[STORAGE_KEYS.SESSION]
 * @property {3} v
 * @property {string} key base64 of the 32-byte vault key
 * @property {string} walletId
 * @property {string} qnetAddress
 * @property {string} solanaAddress
 * @property {5|15|30|60|'never'} autoLockMinutes copied from the vault state at unlock and on settings.set
 * @property {number|null} lockDeadline ms epoch; null exactly when autoLockMinutes is 'never'
 *
 * @typedef {object} StoredSettings  chrome.storage.local[STORAGE_KEYS.SETTINGS], validated on every read
 * @property {string} language one of SUPPORTED_LANGUAGES; absent: the browser's language (languageForTag)
 *
 * @typedef {object} Settings  result of settings.get / settings.set
 * @property {5|15|30|60|'never'|null} autoLockMinutes from the vault state; null while locked
 * @property {string} language
 *
 * @typedef {'user'|'timeout'|'idle'|'startup'|'wipe'|'error'} LockReason
 * @typedef {{locked: boolean, reason: LockReason|'unlock'}} LockChange
 */

const lockListeners = new Set();

const SESSION_VERSION = 3;
const KEY_BYTES = 32;
const MINUTE_MS = 60000;
// A deadline further ahead than the auto-lock allows means the clock went back: lock rather than trust it.
const CLOCK_SLACK_MS = 60000;
// chrome.alarms may fire a little before `when`; closer than this to the deadline counts as reached.
const ALARM_EARLY_MS = 1000;
const LOCK_REASONS = new Set(['user', 'timeout', 'idle', 'startup', 'wipe', 'error']);
const STORED_KEYS = Object.freeze(['v', 'key', 'walletId', 'qnetAddress', 'solanaAddress', 'autoLockMinutes',
  'lockDeadline']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// {vaultKey, walletId, qnetAddress, solanaAddress, autoLockMinutes, lockDeadline} or null. The unlock
// state is this object's presence, never a stored boolean.
let current = null;
// Bumped by every start and lock; an asynchronous step that sees it change has been overtaken.
let epoch = 0;
// Bumped by every lock the user or the OS asked for ('user', 'idle', 'startup'): a session whose password
// check began before one of them never starts (R3-ESM-03).
let screenLocks = 0;
const SCREEN_LOCK_REASONS = new Set(['user', 'idle', 'startup']);
// chrome.idle.queryState's detection interval (its minimum); only its 'locked' answer is used.
const IDLE_DETECTION_SECONDS = 15;
let restoring = null;
let backoffMemory = { failures: 0, until: 0 };
let backoffQueue = Promise.resolve();

const noop = () => {};
const locked = () => new WalletError('LOCKED');
const internal = () => new WalletError('INTERNAL');
const chromeApi = () => globalThis.chrome;

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasExactKeys(value, names) {
  return isPlainObject(value) && Object.keys(value).length === names.length && names.every((n) => Object.hasOwn(value, n));
}

// A chrome.* call that may throw synchronously or reject; always a promise.
function attempt(fn) {
  try {
    return Promise.resolve(fn());
  } catch (error) {
    return Promise.reject(error);
  }
}

const isSessionShape = (s) => typeof s.walletId === 'string' && UUID_RE.test(s.walletId)
  && core.isValidQnetAddress(s.qnetAddress) && core.isValidSolanaAddress(s.solanaAddress)
  && isAutoLockChoice(s.autoLockMinutes);

// The deadline of `minutes` of auto-lock counted from `now`; none for Never.
const deadlineAfter = (minutes, now) => (minutes === AUTO_LOCK_NEVER ? null : now + minutes * MINUTE_MS);

// A deadline that matches its auto-lock: none for Never, a time for every other choice.
const deadlineFits = (s) => (s.autoLockMinutes === AUTO_LOCK_NEVER
  ? s.lockDeadline === null : Number.isSafeInteger(s.lockDeadline));

const isExpired = (s, now) => s.lockDeadline !== null && (now >= s.lockDeadline
  || s.lockDeadline - now > s.autoLockMinutes * MINUTE_MS + CLOCK_SLACK_MS);

const infoOf = (s) => ({
  walletId: s.walletId, qnetAddress: s.qnetAddress, solanaAddress: s.solanaAddress, lockDeadline: s.lockDeadline,
});

function fire(change) {
  const frozen = Object.freeze({ ...change });
  for (const listener of [...lockListeners]) {
    try {
      listener(frozen);
    } catch (error) {
      log.warn('lock listener failed', error?.name);
    }
  }
}

function writeMirror(s) {
  return attempt(() => chromeApi().storage.session.set({
    [STORAGE_KEYS.SESSION]: {
      v: SESSION_VERSION,
      key: core.base64Encode(s.vaultKey),
      walletId: s.walletId,
      qnetAddress: s.qnetAddress,
      solanaAddress: s.solanaAddress,
      autoLockMinutes: s.autoLockMinutes,
      lockDeadline: s.lockDeadline,
    },
  }));
}

// No deadline (Never): no alarm either.
const armAlarm = (deadline) => attempt(() => (deadline === null
  ? chromeApi().alarms.clear(AUTO_LOCK_ALARM)
  : chromeApi().alarms.create(AUTO_LOCK_ALARM, { when: deadline })));

function parseStored(stored) {
  if (!hasExactKeys(stored, STORED_KEYS) || stored.v !== SESSION_VERSION || !isSessionShape(stored) || !deadlineFits(stored)) {
    return null;
  }
  let key;
  try {
    key = core.base64Decode(stored.key);
  } catch {
    return null;
  }
  if (key.length !== KEY_BYTES || core.base64Encode(key) !== stored.key) {
    core.zeroize(key);
    return null;
  }
  return {
    vaultKey: key,
    walletId: stored.walletId,
    qnetAddress: stored.qnetAddress,
    solanaAddress: stored.solanaAddress,
    autoLockMinutes: stored.autoLockMinutes,
    lockDeadline: stored.lockDeadline,
  };
}

// Once per worker: a mirror written before the worker stopped resumes only while its deadline is ahead.
async function restore() {
  const startEpoch = epoch;
  let stored;
  try {
    stored = (await chromeApi().storage.session.get(STORAGE_KEYS.SESSION))?.[STORAGE_KEYS.SESSION];
  } catch {
    return;
  }
  if (stored === undefined || epoch !== startEpoch) return;
  const parsed = parseStored(stored);
  if (parsed === null || isExpired(parsed, Date.now())) {
    if (parsed !== null) core.zeroize(parsed.vaultKey);
    await lock(parsed === null ? 'error' : 'timeout');
    return;
  }
  current = parsed;
  await armAlarm(parsed.lockDeadline).catch(() => log.warn('auto-lock alarm not armed'));
}

function ensureRestored() {
  restoring ??= restore().catch((error) => log.warn('session restore failed', error?.name));
  return restoring;
}

// The running session after the deadline check; a passed deadline locks with reason 'timeout'.
async function activeSession() {
  await ensureRestored();
  const s = current;
  if (s === null) return null;
  if (isExpired(s, Date.now())) {
    await lock('timeout');
    return null;
  }
  return s;
}

/**
 * Worker start: setAccessLevel TRUSTED_CONTEXTS on chrome.storage.session (and, best effort, on
 * chrome.storage.local), then restore a stored session whose deadline is still ahead (else clear it)
 * and re-arm the alarm.
 * @returns {Promise<void>}
 */
export async function initSession() {
  const storage = chromeApi()?.storage;
  await attempt(() => storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }))
    .catch(() => log.warn('storage.session access level not set'));
  await attempt(() => storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })).catch(noop);
  await ensureRestored();
}

/**
 * The count of user, idle and startup locks so far: taken before a password check (its KDF runs for about a
 * second), handed to startSession as `since`.
 * @returns {number}
 */
export function lockMark() {
  return screenLocks;
}

// Whether the OS reports the screen locked now; unknown counts as not locked (the lock event still locks).
// The callback form works on every Chrome; a build that returns a promise instead is read too.
function screenIsLocked() {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 1000);
    const done = (state) => {
      clearTimeout(timer);
      resolve(state === 'locked');
    };
    try {
      const result = chromeApi().idle.queryState(IDLE_DETECTION_SECONDS, done);
      if (result && typeof result.then === 'function') result.then(done, () => done(null));
    } catch {
      done(null);
    }
  });
}

/**
 * Starts (or replaces) the session after a successful decrypt. Takes ownership of `vaultKey` (the
 * caller must not reuse it; it is zeroized when this fails), sets the deadline to now + autoLockMinutes (none for Never),
 * mirrors to storage.session, arms the alarm, fires onLockChange {locked: false, reason: 'unlock'}.
 * With `since` (lockMark() taken before the password check began): refused when the user locked, the screen
 * locked or the browser started since, or the screen is locked now (R3-ESM-03): a lock that fired while the
 * KDF ran found no session to end, and the session must not start behind the locked screen.
 * @param {{vaultKey: Uint8Array, walletId: string, qnetAddress: string, solanaAddress: string,
 *   autoLockMinutes: 5|15|30|60|'never', since?: number}} session
 * @returns {Promise<{lockDeadline: number|null}>}
 * @throws {WalletError} INTERNAL for malformed input or an unwritable mirror (the session is then
 *   locked); LOCKED when a lock overtook the start
 */
export async function startSession(session) {
  const { vaultKey, walletId, qnetAddress, solanaAddress, autoLockMinutes, since } = session ?? {};
  const valid = vaultKey instanceof Uint8Array && vaultKey.length === KEY_BYTES
    && isSessionShape({ walletId, qnetAddress, solanaAddress, autoLockMinutes })
    && (since === undefined || Number.isSafeInteger(since));
  if (!valid) {
    if (vaultKey instanceof Uint8Array) vaultKey.fill(0);
    throw internal();
  }
  if (since !== undefined) {
    const lockedNow = await screenIsLocked();
    if (lockedNow || since !== screenLocks) {
      vaultKey.fill(0);
      throw locked();
    }
  }
  await ensureRestored();
  epoch += 1;
  const mine = epoch;
  const previous = current;
  current = {
    vaultKey, walletId, qnetAddress, solanaAddress, autoLockMinutes, lockDeadline: deadlineAfter(autoLockMinutes, Date.now()),
  };
  if (previous !== null && previous.vaultKey !== vaultKey) previous.vaultKey.fill(0);
  const started = current;
  // a new session starts with no view cache
  views = null;
  await attempt(() => chromeApi().storage.session.remove(STORAGE_KEYS.VIEW_CACHE)).catch(noop);
  try {
    await writeMirror(started);
  } catch {
    if (epoch === mine) await lock('error');
    throw internal();
  }
  if (epoch !== mine) throw locked();
  await armAlarm(started.lockDeadline).catch(() => log.warn('auto-lock alarm not armed'));
  if (epoch !== mine) throw locked();
  fire({ locked: false, reason: 'unlock' });
  return { lockDeadline: started.lockDeadline };
}

/**
 * The unlocked session, after checking the deadline (a passed deadline locks with reason 'timeout').
 * The router calls it before every type marked `unlocked`; signing paths call it again right before
 * deriving keys.
 * @returns {Promise<SessionInfo>}
 * @throws {WalletError} LOCKED
 */
export async function requireUnlocked() {
  const s = await activeSession();
  if (s === null) throw locked();
  return infoOf(s);
}

/**
 * @returns {Promise<boolean>} whether a session exists and its deadline is ahead
 */
export async function isUnlocked() {
  return (await activeSession()) !== null;
}

/**
 * The session's public part without throwing (vault.status, settings.get).
 * @returns {Promise<SessionInfo|null>} null while locked
 */
export async function peekSession() {
  const s = await activeSession();
  return s === null ? null : infoOf(s);
}

/**
 * Runs `fn` with a copy of the vault key and zeroizes the copy afterwards. Only vault.js calls it.
 * @template T
 * @param {(vaultKey: Uint8Array) => Promise<T>|T} fn
 * @returns {Promise<T>}
 * @throws {WalletError} LOCKED
 */
export async function withVaultKey(fn) {
  const s = await activeSession();
  if (s === null) throw locked();
  const copy = s.vaultKey.slice();
  try {
    return await fn(copy);
  } finally {
    copy.fill(0);
  }
}

/**
 * Swaps the session key after a password change, keeping the deadline.
 * @param {Uint8Array} vaultKey ownership passes to the session (zeroized when this fails)
 * @returns {Promise<void>}
 * @throws {WalletError} LOCKED; INTERNAL when the mirror cannot be updated (the session is then locked,
 *   since a restarted worker would otherwise resume with the old key)
 */
export async function replaceVaultKey(vaultKey) {
  if (!(vaultKey instanceof Uint8Array) || vaultKey.length !== KEY_BYTES) throw internal();
  const s = await activeSession();
  if (s === null) {
    vaultKey.fill(0);
    throw locked();
  }
  const mine = epoch;
  const old = s.vaultKey;
  s.vaultKey = vaultKey;
  old.fill(0);
  try {
    await writeMirror(s);
  } catch {
    if (epoch === mine) await lock('error');
    throw internal();
  }
}

/**
 * Pushes the deadline to now + auto-lock after a user action. The router calls it after a successful
 * request of a type marked `activity`; reads and polling never extend the session. No-op while locked and for Never.
 * @returns {Promise<void>}
 * @throws {WalletError} INTERNAL when the mirror cannot be updated (the in-memory deadline still moved;
 *   a restarted worker resumes with the earlier one)
 */
export async function touch() {
  const s = await activeSession();
  if (s === null || s.autoLockMinutes === AUTO_LOCK_NEVER) return;
  const mine = epoch;
  s.lockDeadline = deadlineAfter(s.autoLockMinutes, Date.now());
  try {
    await writeMirror(s);
  } catch {
    throw internal();
  }
  if (epoch === mine) await armAlarm(s.lockDeadline).catch(() => log.warn('auto-lock alarm not armed'));
}

/**
 * Locks: zeroizes the key, clears the session record from memory and chrome.storage.session, clears the
 * alarm, fires onLockChange {locked: true, reason} (also when already locked, so views re-sync). The
 * backoff record is kept. Never throws: a failing step does not stop the others.
 * @param {LockReason} reason
 * @returns {Promise<void>}
 */
export async function lock(reason) {
  const why = LOCK_REASONS.has(reason) ? reason : 'error';
  epoch += 1;
  if (SCREEN_LOCK_REASONS.has(why)) screenLocks += 1;
  // A lock before the restore ran leaves nothing to restore: the mirror goes below.
  restoring ??= Promise.resolve();
  const s = current;
  current = null;
  if (s !== null) s.vaultKey.fill(0);
  views = null;
  await Promise.allSettled([
    attempt(() => chromeApi().storage.session.remove(STORAGE_KEYS.SESSION)),
    attempt(() => chromeApi().storage.session.remove(STORAGE_KEYS.VIEW_CACHE)),
    attempt(() => chromeApi().alarms.clear(AUTO_LOCK_ALARM)),
  ]);
  fire({ locked: true, reason: why });
}

/**
 * Handler of `vault.lock`.
 * @returns {Promise<{locked: true}>}
 */
export async function lockNow() {
  await lock('user');
  return { locked: true };
}

/**
 * Subscribes to lock state changes (sw.js wires the view broadcast and the provider to it). startSession
 * and lock call every listener in lockListeners; a throwing listener must not stop the others.
 * @param {(change: LockChange) => void} listener
 * @returns {() => void} unsubscribe
 */
export function onLockChange(listener) {
  if (typeof listener !== 'function') throw new TypeError('listener must be a function');
  lockListeners.add(listener);
  return () => lockListeners.delete(listener);
}

// ---------------------------------------------------------------- the view cache (decision 39)

// The last balances, token list and first history pages the popup was served in this session (the router keeps every
// answer of qnet.balance, qnet.tokens, solana.balances, and qnet.history and solana.history without a cursor): the popup
// draws them at once the next time it opens or switches network, and reads again behind them. Public data only, of the
// session's wallet only, in worker memory and chrome.storage.session; every lock and every new session drop it.
const VIEW_NAMES = Object.freeze(['qnetBalance', 'qnetHistory', 'solanaBalances', 'solanaHistory', 'qnetTokens']);
// The balances outlive the session (owner, 06.10: the popup draws the last verified balance at once, also right after an
// unlock): the last verified QNet balance, the token list and the Solana balances are kept in the vault's chain cache
// (vault.updateChainCache, with its MAC), and a view of this session not read yet is drawn from there. A QNet balance
// no committee certificate verified (verification 'none') is never kept.
const PERSISTED_VIEWS = Object.freeze(['qnetBalance', 'qnetTokens', 'solanaBalances']);
const keptAcrossSessions = (name, value) => PERSISTED_VIEWS.includes(name) && isPlainObject(value)
  && (name !== 'qnetBalance' || value.verified === true);
// {walletId, values} of the session, read from storage.session once per worker
let views = null;

async function viewsOf(s) {
  if (views?.walletId === s.walletId) return views;
  let stored = null;
  try {
    stored = (await chromeApi().storage.session.get(STORAGE_KEYS.VIEW_CACHE))?.[STORAGE_KEYS.VIEW_CACHE];
  } catch {
    stored = null;
  }
  const values = isPlainObject(stored) && stored.walletId === s.walletId && isPlainObject(stored.values) ? stored.values : {};
  views = { walletId: s.walletId, values: Object.fromEntries(VIEW_NAMES.filter((name) => Object.hasOwn(values, name)).map((name) => [name, values[name]])) };
  return views;
}

/**
 * Keeps `value` (a handler result the router already guards) as the view `name` of this session, and a balance view
 * also in the vault's chain cache (keptAcrossSessions); nothing while locked. Never throws for storage: a value that
 * could not be written stays in worker memory.
 * @param {'qnetBalance'|'qnetHistory'|'solanaBalances'|'solanaHistory'|'qnetTokens'} name
 * @param {unknown} value
 * @returns {Promise<void>}
 */
export async function rememberView(name, value) {
  if (!VIEW_NAMES.includes(name)) throw new TypeError('unknown view');
  const s = await activeSession();
  if (s === null) return;
  const mine = epoch;
  const cache = await viewsOf(s);
  if (epoch !== mine) return;
  cache.values[name] = value;
  await attempt(() => chromeApi().storage.session.set({ [STORAGE_KEYS.VIEW_CACHE]: { walletId: s.walletId, values: cache.values } }))
    .catch(() => log.warn('view cache not written'));
  // a lock while it was written leaves nothing behind
  if (epoch !== mine) {
    await attempt(() => chromeApi().storage.session.remove(STORAGE_KEYS.VIEW_CACHE)).catch(noop);
    return;
  }
  if (!keptAcrossSessions(name, value)) return;
  const text = JSON.stringify(value);
  if (persisted.get(name) === `${s.walletId}:${text}`) return;
  await vault.updateChainCache((kept) => ({ ...kept, views: { ...(isPlainObject(kept.views) ? kept.views : {}), [name]: value } }))
    .then(() => persisted.set(name, `${s.walletId}:${text}`), (error) => log.warn('balance not kept', error?.code ?? error?.name));
}

// What this worker last wrote of each kept view, so an unchanged answer costs no write.
const persisted = new Map();

/**
 * Forgets the views `names` in this session and in the vault's chain cache: what the wallet read of a chain it no longer
 * follows (qnet.js). Never throws for storage.
 * @param {string[]} names VIEW_NAMES
 * @returns {Promise<void>}
 */
export async function forgetViews(names) {
  const s = await activeSession();
  if (s === null) return;
  const cache = await viewsOf(s);
  for (const name of names) {
    delete cache.values[name];
    persisted.delete(name);
  }
  await attempt(() => chromeApi().storage.session.set({ [STORAGE_KEYS.VIEW_CACHE]: { walletId: s.walletId, values: cache.values } }))
    .catch(() => log.warn('view cache not written'));
  await vault.updateChainCache((kept) => {
    const left = { ...(isPlainObject(kept.views) ? kept.views : {}) };
    for (const name of names) delete left[name];
    return { ...kept, views: left };
  }).catch((error) => log.warn('kept balances not dropped', error?.code ?? error?.name));
}

// The balances kept across sessions (keptAcrossSessions), read back from the vault's chain cache.
async function keptViews() {
  let kept = {};
  try {
    kept = await vault.readChainCache();
  } catch (error) {
    log.warn('kept balances unreadable', error?.code ?? error?.name);
  }
  // balances kept under another build's chain (core.chainIdentity) are another chain's
  if (typeof kept?.chain === 'string' && kept.chain !== core.chainIdentity()) return {};
  const stored = isPlainObject(kept?.views) ? kept.views : {};
  return Object.fromEntries(PERSISTED_VIEWS.filter((name) => keptAcrossSessions(name, stored[name])).map((name) => [name, stored[name]]));
}

/**
 * Handler of `wallet.cached`: the views this session keeps, and for a balance view not read in this session yet the one
 * kept across sessions (keptAcrossSessions); null for each one there is none of.
 * @returns {Promise<{qnetBalance: object|null, qnetHistory: object|null, solanaBalances: object|null,
 *   solanaHistory: object|null, qnetTokens: object|null}>}
 * @throws {WalletError} LOCKED
 */
export async function cachedViews() {
  const s = await activeSession();
  if (s === null) throw locked();
  const { values } = await viewsOf(s);
  const missing = PERSISTED_VIEWS.some((name) => values[name] === undefined || values[name] === null);
  const kept = missing ? await keptViews() : {};
  return Object.fromEntries(VIEW_NAMES.map((name) => [name, values[name] ?? kept[name] ?? null]));
}

/**
 * Handler of `wallet.addresses`.
 * @returns {Promise<{qnet: string, solana: string}>}
 * @throws {WalletError} LOCKED
 */
export async function getAddresses() {
  const s = await requireUnlocked();
  return { qnet: s.qnetAddress, solana: s.solanaAddress };
}

// The browser's UI language (chrome.i18n) when the UI has it, else DEFAULT_LANGUAGE.
function browserLanguage() {
  let tag = null;
  try {
    tag = chromeApi().i18n?.getUILanguage?.() ?? null;
  } catch {
    tag = null;
  }
  return languageForTag(tag) ?? DEFAULT_LANGUAGE;
}

async function readLanguage() {
  let stored;
  try {
    stored = (await chromeApi().storage.local.get(STORAGE_KEYS.SETTINGS))?.[STORAGE_KEYS.SETTINGS];
  } catch {
    return browserLanguage();
  }
  // Content scripts may be able to write storage.local: only an exact, allow-listed value counts (R22).
  const valid = hasExactKeys(stored, ['language']) && SUPPORTED_LANGUAGES.includes(stored.language);
  return valid ? stored.language : browserLanguage();
}

/**
 * Handler of `settings.get` (any page, locked or not). autoLockMinutes comes from the running session
 * (null while locked); the language from chrome.storage.local, where nothing valid means the browser's
 * language if the UI has it, else DEFAULT_LANGUAGE.
 * @returns {Promise<Settings>}
 */
export async function getSettings() {
  const s = await activeSession();
  return { autoLockMinutes: s === null ? null : s.autoLockMinutes, language: await readLanguage() };
}

/**
 * Handler of `settings.set` (unlocked). autoLockMinutes is written into the vault state
 * (vault.updateState) and applies to the running session at once (new deadline from now, none and no alarm for
 * Never); language is
 * written to chrome.storage.local.
 * @param {{autoLockMinutes?: 5|15|30|60|'never', language?: string}} patch at least one field (router-checked)
 * @returns {Promise<Settings>}
 * @throws {WalletError} LOCKED, VAULT_CORRUPT; INVALID_PARAMS for a value outside the allow-lists
 */
export async function setSettings(patch) {
  const { autoLockMinutes, language } = patch ?? {};
  if (autoLockMinutes !== undefined && !isAutoLockChoice(autoLockMinutes)) {
    throw new WalletError('INVALID_PARAMS', { field: 'autoLockMinutes' });
  }
  if (language !== undefined && !SUPPORTED_LANGUAGES.includes(language)) {
    throw new WalletError('INVALID_PARAMS', { field: 'language' });
  }
  await requireUnlocked();
  if (autoLockMinutes !== undefined) {
    await vault.updateState((state) => ({ ...state, settings: { ...state.settings, autoLockMinutes } }));
    const s = await activeSession();
    if (s === null) throw locked();
    const mine = epoch;
    s.autoLockMinutes = autoLockMinutes;
    s.lockDeadline = deadlineAfter(autoLockMinutes, Date.now());
    await writeMirror(s).catch(() => {
      throw internal();
    });
    if (epoch === mine) await armAlarm(s.lockDeadline).catch(() => log.warn('auto-lock alarm not armed'));
  }
  if (language !== undefined) {
    await attempt(() => chromeApi().storage.local.set({ [STORAGE_KEYS.SETTINGS]: { language } })).catch(() => {
      throw internal();
    });
  }
  return getSettings();
}

/**
 * chrome.alarms.onAlarm listener: AUTO_LOCK_ALARM past the deadline locks with reason 'timeout'.
 * @param {{name: string}} alarm
 * @returns {Promise<void>}
 */
export async function onAlarm(alarm) {
  if (alarm?.name !== AUTO_LOCK_ALARM) return;
  await ensureRestored();
  const s = current;
  if (s === null) return;
  if (isExpired(s, Date.now() + ALARM_EARLY_MS)) await lock('timeout');
  else await armAlarm(s.lockDeadline).catch(() => log.warn('auto-lock alarm not armed'));
}

/**
 * chrome.idle.onStateChanged listener: 'locked' locks with reason 'idle'.
 * @param {'active'|'idle'|'locked'} state
 * @returns {Promise<void>}
 */
export async function onIdleState(state) {
  if (state === 'locked') await lock('idle');
}

async function readBackoff() {
  let stored;
  try {
    stored = (await chromeApi().storage.session.get(STORAGE_KEYS.BACKOFF))?.[STORAGE_KEYS.BACKOFF];
  } catch {
    stored = undefined;
  }
  const valid = hasExactKeys(stored, ['failures', 'until'])
    && Number.isSafeInteger(stored.failures) && stored.failures >= 0
    && Number.isSafeInteger(stored.until) && stored.until >= 0;
  const failures = Math.max(valid ? stored.failures : 0, backoffMemory.failures);
  // A clock set back must not turn one delay into a lock-out: at most BACKOFF_MAX_MS from now.
  const until = Math.min(Math.max(valid ? stored.until : 0, backoffMemory.until), Date.now() + LIMITS.BACKOFF_MAX_MS);
  return { failures, until };
}

function serialBackoff(task) {
  const run = backoffQueue.then(task);
  backoffQueue = run.then(noop, noop);
  return run;
}

/**
 * Throws while a password backoff is running. Call before every password check.
 * @returns {Promise<void>}
 * @throws {WalletError} BACKOFF with retryAfterMs
 */
export async function checkBackoff() {
  const { until } = await serialBackoff(readBackoff);
  const wait = until - Date.now();
  if (wait > 0) throw new WalletError('BACKOFF', { retryAfterMs: Math.ceil(wait) });
}

/**
 * Records a failed password check (chrome.storage.session[STORAGE_KEYS.BACKOFF] = {failures, until}).
 * The count also lives in worker memory, so a failing storage write cannot reset it.
 * @returns {Promise<void>}
 */
export async function recordPasswordFailure() {
  await serialBackoff(async () => {
    const { failures: before } = await readBackoff();
    const failures = before + 1;
    const delay = backoffDelayMs(failures);
    const until = delay > 0 ? Date.now() + delay : 0;
    backoffMemory = { failures, until };
    await attempt(() => chromeApi().storage.session.set({ [STORAGE_KEYS.BACKOFF]: { failures, until } }))
      .catch(() => log.warn('backoff not stored'));
  });
}

/**
 * Resets the backoff after a successful password check.
 * @returns {Promise<void>}
 */
export async function recordPasswordSuccess() {
  await serialBackoff(async () => {
    backoffMemory = { failures: 0, until: 0 };
    await attempt(() => chromeApi().storage.session.remove(STORAGE_KEYS.BACKOFF)).catch(() => log.warn('backoff not reset'));
  });
}

/**
 * @returns {Promise<number|null>} ms epoch until which password checks are refused, or null
 */
export async function getBackoffUntil() {
  const { until } = await serialBackoff(readBackoff);
  return until > Date.now() ? until : null;
}

/**
 * Delay after the n-th consecutive failure: none for the first LIMITS.BACKOFF_FREE_ATTEMPTS, then
 * BACKOFF_BASE_MS doubling per failure, capped at BACKOFF_MAX_MS.
 * @param {number} failures consecutive failures so far (>= 0)
 * @returns {number} ms
 */
export function backoffDelayMs(failures) {
  if (!Number.isSafeInteger(failures) || failures <= LIMITS.BACKOFF_FREE_ATTEMPTS) return 0;
  const exponent = Math.min(failures - LIMITS.BACKOFF_FREE_ATTEMPTS - 1, 30);
  return Math.min(LIMITS.BACKOFF_BASE_MS * 2 ** exponent, LIMITS.BACKOFF_MAX_MS);
}

/**
 * @param {unknown} minutes
 * @returns {boolean} whether it is one of AUTO_LOCK_CHOICES
 */
export function isAutoLockChoice(minutes) {
  return AUTO_LOCK_CHOICES.includes(minutes);
}
