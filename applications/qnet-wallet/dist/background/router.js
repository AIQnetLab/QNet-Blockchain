// The worker's only entry for messages (spec: Messaging; R09, EXT-SEC-06, MISS-02). Extension pages
// call runtime.sendMessage({type, id, params}); the dApp relay holds one 'qnet-provider' port per page.
// Every message is checked for who sent it and for its exact shape before a module sees it, and every
// result is checked before it leaves. Modules receive normalized params and, for dApps, the origin the
// browser reported for the port, never an origin taken from a message body.
import * as core from '../lib/qnet-core.js';
import * as activation from './activation.js';
import { U64_MAX, isPositiveAmount } from './amount.js';
import {
  AUTO_LOCK_CHOICES, DECIMALS, DEV_BUILD, LIMITS, PAYMENT_REQUEST, PROVIDER, SUPPORTED_LANGUAGES, UI_PAGES, VIEW_EVENT_CHANNEL,
  VIEW_EVENTS, isPaymentRequestMemo,
} from './config.js';
import {
  PROVIDER_ERROR_CODES, ProviderError, UNSUPPORTED_CALL_FIELDS, WalletError, toProviderError, toUiError,
} from './errors.js';
import * as keys from './keys.js';
import { log } from './log.js';
import * as nodes from './nodes.js';
import * as provider from './provider.js';
import * as qnet from './qnet.js';
import * as session from './session.js';
import * as solana from './solana.js';
import * as vault from './vault.js';

// ---------------------------------------------------------------- field schemas

const string = (options = {}) => ({ kind: 'string', min: 1, max: 256, pattern: null, check: null, ...options });
const integer = (min, max) => ({ kind: 'integer', min, max });
const boolean = () => ({ kind: 'boolean' });
const oneOf = (...values) => ({ kind: 'enum', values: Object.freeze(values) });
const optional = (spec) => ({ ...spec, optional: true });
// An array of at most `max` distinct values, each matching `item`.
const list = (item, max) => ({ kind: 'list', item, max });
const nullable = (spec) => ({ ...spec, nullable: true });

const U64_RE = /^(0|[1-9][0-9]{0,19})$/;
const DECIMAL_RE = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RESTORE_TOKEN_RE = /^[0-9a-f]{64}$/;
const CURSOR_RE = /^[\x21-\x7e]+$/;
const TYPE_RE = /^[a-z]+\.[a-zA-Z]+$/;
const TX_HASH_RE = /^[0-9A-Za-z]{16,128}$/;
const METHOD_RE = /^[A-Za-z_]{1,64}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PATTERN_RE = /^(https?):\/\/(\*|(?:\*\.)?[a-z0-9.-]+)(?::([0-9]{1,5}))?\/.*$/;
const DEFAULT_PORTS = Object.freeze({ 'https:': '443', 'http:': '80' });
// A token amount before the token's decimals are known: a canonical decimal of at most 18 fraction digits.
const TOKEN_AMOUNT_RE = /^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/;
const CONTRACT_METHOD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
// A contract call's input: hex of whole bytes (either case, taken as lowercase), at most CALL_ARGS_MAX_BYTES; '' is none.
export const CALL_ARGS_MAX_BYTES = 4096;
const CALL_ARGS_RE = new RegExp(`^(?:[0-9a-fA-F]{2}){0,${CALL_ARGS_MAX_BYTES}}$`);

/**
 * @param {unknown} value
 * @returns {boolean} a canonical decimal string of an unsigned 64-bit integer
 */
export function isU64String(value) {
  return typeof value === 'string' && U64_RE.test(value) && BigInt(value) <= U64_MAX;
}

/**
 * An origin exactly as URL.origin prints it: https, or plain HTTP on localhost / 127.0.0.1 only (the
 * same rule as qnet-core buildOffchainMessage). Whether it may connect is the manifest's decision.
 * @param {unknown} origin
 * @returns {boolean}
 */
export function isCanonicalOrigin(origin) {
  if (typeof origin !== 'string' || origin.length === 0 || origin.length > 255) return false;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin !== origin) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}

/**
 * Whether an origin may call qnet_activateNode, qnet_getActivation, qnet_claimNodeBalance and qnet_unlinkNodeDevice:
 * exactly PROVIDER.ACTIVATION_ORIGIN; the dev build also plain HTTP localhost and 127.0.0.1 on any port. Any other origin
 * a manifest names (a test or dev overlay) may connect but never ask for a burn, a move of the node balance or an unlink.
 * @param {unknown} origin
 * @param {boolean} [dev] DEV_BUILD
 * @returns {boolean}
 */
export function isActivationOrigin(origin, dev = DEV_BUILD) {
  if (origin === PROVIDER.ACTIVATION_ORIGIN) return true;
  return dev === true && isCanonicalOrigin(origin) && new URL(origin).protocol === 'http:';
}

// The full check of a dApp message is the bundle's own wrapper: protocol prefixes, hidden controls,
// lone surrogates, size and origin all fail here, before any approval window opens.
const isSignableMessage = (origin, message) => core.buildOffchainMessage(origin, message).length > 0;
const assetAmountOk = (p) => isPositiveAmount(p.amount, p.asset === 'sol' ? DECIMALS.SOL : DECIMALS.ONE_DEV);

const F = Object.freeze({
  password: string({ max: LIMITS.PASSWORD_MAX_CHARS }),
  mnemonic: string({ max: LIMITS.MNEMONIC_MAX_CHARS }),
  qnetAddress: string({ min: 45, max: 45, check: core.isValidQnetAddress }),
  solanaAddress: string({ min: 32, max: 44, check: core.isValidSolanaAddress }),
  qncAmount: string({ max: 40, check: (v) => isPositiveAmount(v, DECIMALS.QNC) }),
  assetAmount: string({ max: 40, pattern: DECIMAL_RE }),
  u64: string({ max: 20, check: isU64String }),
  nodeType: oneOf(...core.ACTIVATION_NODE_TYPES),
  price: integer(1, 1_000_000_000),
  origin: string({ max: 255, check: isCanonicalOrigin }),
  approvalId: string({ min: 36, max: 36, pattern: UUID_RE }),
  restoreToken: string({ min: 64, max: 64, pattern: RESTORE_TOKEN_RE }),
  cursor: string({ max: 512, pattern: CURSOR_RE }),
  asset: oneOf('sol', '1dev'),
  solanaSignature: string({ min: 64, max: 88, check: core.isValidSolanaSignature }),
  blockHeight: integer(0, Number.MAX_SAFE_INTEGER),
  dappMessage: string({ max: core.OFFCHAIN_MESSAGE_MAX_BYTES }),
  tokenAmount: string({ max: 40, pattern: TOKEN_AMOUNT_RE, check: (v) => /[1-9]/.test(v) }),
  contractMethod: string({ max: 64, pattern: CONTRACT_METHOD_RE }),
  callArgs: string({ min: 0, max: 2 * CALL_ARGS_MAX_BYTES, pattern: CALL_ARGS_RE }),
  gasLimit: integer(1, core.MAX_GAS_LIMIT),
  nonce: string({ max: 20, check: (v) => isU64String(v) && v !== '0' }),
});
// A payment request's parts a Solana send carries (config.PAYMENT_REQUEST).
const REQUEST_FIELDS = Object.freeze({
  references: optional(list(F.solanaAddress, PAYMENT_REQUEST.REFERENCES_MAX)),
  memo: optional(string({ max: PAYMENT_REQUEST.MEMO_MAX_BYTES, check: isPaymentRequestMemo })),
});

// qnet_sendTransaction: one shape per type; a request without `type` is a transfer, as before types existed.
const TRANSACTION_TYPES = Object.freeze({
  transfer: Object.freeze({ type: oneOf('transfer'), to: F.qnetAddress, amount: F.qncAmount }),
  tokenTransfer: Object.freeze({ type: oneOf('tokenTransfer'), token: F.qnetAddress, to: F.qnetAddress, amount: F.tokenAmount }),
  contractCall: Object.freeze({
    type: oneOf('contractCall'), contract: F.qnetAddress, method: F.contractMethod, args: F.callArgs, gasLimit: optional(F.gasLimit),
  }),
});

// A gas limit a call may carry: its intrinsic gas plus the least fuel an entry point runs on, at most MAX_GAS_LIMIT.
function callGasFits({ contract, method, args, gasLimit }) {
  if (gasLimit === undefined) return true;
  const intrinsic = core.contractCallIntrinsicGas(core.contractCallData(contract, method, args));
  return gasLimit >= intrinsic + core.WASM_MIN_FUEL && gasLimit <= core.MAX_GAS_LIMIT;
}

/**
 * The params of qnet_sendTransaction as {type, ...} of one of TRANSACTION_TYPES: legacy {to, amount} is a transfer;
 * unknown keys are refused, and a contract call that names `value` or `accessList` is UNSUPPORTED_PARAM (the network
 * accepts neither on a call today), before anything else is read. A call's input comes back lowercase.
 * @param {unknown} raw
 * @returns {object}
 * @throws {WalletError} INVALID_PARAMS (with `field`), UNSUPPORTED_PARAM (with `field`)
 */
export function normalizeTransaction(raw) {
  const input = raw === undefined ? {} : raw;
  if (!isPlainObject(input)) throw invalid();
  const type = Object.hasOwn(input, 'type') ? input.type : 'transfer';
  if (typeof type !== 'string' || !Object.hasOwn(TRANSACTION_TYPES, type)) throw invalid('type');
  if (type === 'contractCall') {
    const field = UNSUPPORTED_CALL_FIELDS.find((name) => Object.hasOwn(input, name));
    if (field !== undefined) throw new WalletError('UNSUPPORTED_PARAM', { field });
  }
  const params = validateParams(TRANSACTION_TYPES[type], { ...input, type });
  if (type !== 'contractCall') return params;
  const call = { ...params, args: params.args.toLowerCase() };
  if (!passes(callGasFits, call)) throw invalid('gasLimit');
  return call;
}

// ---------------------------------------------------------------- message tables

const POPUP = ['popup'];
const ALL_PAGES = ['popup', 'setup', 'approve'];

// The popup's view cache (decision 39): every balance, and every history page read from the newest (no cursor), is kept
// for the session (session.rememberView), and the popup draws it at once the next time while it reads again.
const firstPage = (params) => params.cursor === undefined || params.cursor === null;
const remembered = (name, handler, kept = () => true) => async (params, meta) => {
  const result = await handler(params, meta);
  if (kept(params)) await session.rememberView(name, result).catch((error) => log.warn('view not kept', error?.name));
  return result;
};

function uiEntry(pages, params, handler, { unlocked = false, activity = false, check = null } = {}) {
  return Object.freeze({ pages: Object.freeze(pages), params: Object.freeze(params), handler, unlocked, activity, check });
}

/**
 * Every type an extension page may send. pages: which ui/*.html may send it. unlocked: the router
 * calls session.requireUnlocked() first. activity: a success extends the auto-lock deadline.
 * check: a cross-field rule over the normalized params. Handlers are called as handler(params, meta)
 * with meta = {page, sender}.
 */
export const UI_MESSAGES = Object.freeze({
  'vault.status': uiEntry(ALL_PAGES, {}, vault.getStatus),
  'vault.create': uiEntry(['setup'], { mnemonic: F.mnemonic, password: F.password }, vault.createVault),
  'vault.import': uiEntry(['setup'], { mnemonic: F.mnemonic, password: F.password }, vault.importVault),
  // the wallet an earlier version of this extension kept in this browser (M-4): its password alone only checks it; with a
  // new password it becomes this version's vault, and its copy goes once that vault was read back
  'vault.migrate': uiEntry(['setup'], { password: F.password, newPassword: optional(F.password) }, vault.migrateEarlier),
  // what an earlier version kept, removed once a vault of this version exists and the user confirmed it
  'vault.removeEarlier': uiEntry(['setup', 'popup'], { confirm: oneOf('REMOVE') }, vault.removeEarlier, { unlocked: true }),
  'vault.unlock': uiEntry(['popup', 'approve'], { password: F.password }, vault.unlock),
  'vault.lock': uiEntry(['popup', 'approve'], {}, session.lockNow),
  'vault.changePassword': uiEntry(POPUP, { password: F.password, newPassword: F.password }, vault.changePassword,
    { unlocked: true, activity: true }),
  'vault.reveal': uiEntry(POPUP, { password: F.password }, vault.reveal, { unlocked: true, activity: true }),
  // the private key of one account after a fresh password check, as the phrase (owner, 06.10)
  'vault.exportKey': uiEntry(POPUP, { password: F.password, network: oneOf('qnet', 'solana') }, keys.exportPrivateKey,
    { unlocked: true, activity: true }),
  'vault.wipe': uiEntry(POPUP, { password: F.password, confirm: oneOf('DELETE') }, vault.wipe),
  // Forgot password → Reset wallet: a one-time token once the phrase and a new password are typed, a check that names
  // both wallets, then the replace.
  'vault.restoreBegin': uiEntry(POPUP, {}, vault.beginRestore),
  // confirm: the user confirmed the reset (without it the call only checks and names both wallets); replaceOther: the
  // phrase is another wallet's, as the check answered
  'vault.restore': uiEntry(POPUP, {
    token: F.restoreToken, mnemonic: F.mnemonic, password: F.password, confirm: optional(oneOf('ERASE')),
    replaceOther: optional(boolean()),
  }, vault.restoreVault),
  'wallet.addresses': uiEntry(['popup', 'approve'], {}, session.getAddresses, { unlocked: true }),
  // the balances and first history pages this session read, for the popup to draw at once (decision 39)
  'wallet.cached': uiEntry(POPUP, {}, session.cachedViews, { unlocked: true }),
  'qnet.balance': uiEntry(POPUP, {}, remembered('qnetBalance', qnet.getBalance), { unlocked: true }),
  'qnet.history': uiEntry(POPUP, {
    cursor: optional(nullable(F.cursor)),
    limit: optional(integer(1, LIMITS.HISTORY_PAGE_MAX)),
  }, remembered('qnetHistory', qnet.getHistory, firstPage), { unlocked: true }),
  // the wallet's built-in tokens (kept like a balance), and the popup's own token send, by a dApp's path (owner, 06.10)
  'qnet.tokens': uiEntry(POPUP, {}, remembered('qnetTokens', qnet.listTokens), { unlocked: true }),
  'qnet.tokenPreview': uiEntry(POPUP, { token: F.qnetAddress, to: F.qnetAddress, amount: F.tokenAmount }, qnet.tokenPreview,
    { unlocked: true }),
  'qnet.tokenSend': uiEntry(POPUP, {
    token: F.qnetAddress, to: F.qnetAddress, amount: F.tokenAmount, expectedFeeNano: F.u64, expectedDepositNano: F.u64,
    expectedNonce: optional(F.u64),
  }, qnet.tokenSend, { unlocked: true, activity: true }),
  // the History detail: whether two pinned nodes list a transaction in a block
  'qnet.txLookup': uiEntry(POPUP, { hash: string({ min: 16, max: 128, pattern: TX_HASH_RE }) }, qnet.txLookup, { unlocked: true }),
  'qnet.preview': uiEntry(POPUP, { to: F.qnetAddress, amount: F.qncAmount, replaceNonce: optional(F.u64) }, qnet.preview,
    { unlocked: true }),
  'qnet.send': uiEntry(POPUP, {
    to: F.qnetAddress, amount: F.qncAmount, expectedFeeNano: F.u64, expectedNonce: optional(F.u64), replaceNonce: optional(F.u64),
  }, qnet.send, { unlocked: true, activity: true }),
  'solana.balances': uiEntry(POPUP, {}, remembered('solanaBalances', solana.getBalances), { unlocked: true }),
  // the Solana History (decision 39): the wallet's own transactions, newest first
  'solana.history': uiEntry(POPUP, {
    cursor: optional(nullable(F.cursor)),
    limit: optional(integer(1, LIMITS.SOLANA_HISTORY_PAGE_MAX)),
  }, remembered('solanaHistory', solana.getHistory, firstPage), { unlocked: true }),
  'solana.quote': uiEntry(POPUP, { asset: F.asset, to: F.solanaAddress, amount: F.assetAmount, ...REQUEST_FIELDS }, solana.quote,
    { unlocked: true, check: assetAmountOk }),
  'solana.send': uiEntry(POPUP, {
    asset: F.asset, to: F.solanaAddress, amount: F.assetAmount, ...REQUEST_FIELDS, expectedFeeLamports: F.u64,
    expectedRentLamports: F.u64,
  }, solana.send, { unlocked: true, activity: true, check: assetAmountOk }),
  // the send form's Max, and the status of a send the popup follows after solana.send
  'solana.max': uiEntry(POPUP, { asset: F.asset, to: optional(F.solanaAddress) }, solana.maxAmount, { unlocked: true }),
  'solana.status': uiEntry(POPUP, { signature: F.solanaSignature, lastValidBlockHeight: optional(nullable(F.blockHeight)) },
    solana.transferStatus, { unlocked: true }),
  'activation.status': uiEntry(POPUP, {}, activation.getStatus, { unlocked: true }),
  // the Activate tab's view: the vault, aiqnet.io's record, the QNet network and the search of the wallet's own address
  // (decision 35); never the code
  'activation.lookup': uiEntry(POPUP, {}, activation.lookup, { unlocked: true }),
  'activation.price': uiEntry(POPUP, {}, activation.getPrice, { unlocked: true }),
  // No password for the popup's own burn, code and record (decision 33): the unlocked session confirms, as it does
  // a send; the burn keeps its acknowledgement in the page
  'activation.burn': uiEntry(POPUP, { nodeType: F.nodeType, expectedPrice: F.price }, activation.burn,
    { unlocked: true, activity: true }),
  'activation.recover': uiEntry(POPUP, {}, activation.recover, { unlocked: true, activity: true }),
  'activation.copy': uiEntry(POPUP, {}, activation.copyCode, { unlocked: true, activity: true }),
  // the light node's registration on the QNet network: Record on the network, and its state (the popup's status line,
  // the activation window after its answer)
  'activation.register': uiEntry(POPUP, {}, nodes.requestRecord, { unlocked: true, activity: true }),
  'activation.registration': uiEntry(['popup', 'approve'], {}, nodes.getRegistration, { unlocked: true }),
  // the light node's device (decision 38): what the Activate tab offers, and its Unlink (one armed press, no password)
  'node.unlinkView': uiEntry(POPUP, {}, nodes.unlinkView, { unlocked: true }),
  'node.unlink': uiEntry(POPUP, {}, nodes.unlinkForSite, { unlocked: true, activity: true }),
  'sites.list': uiEntry(POPUP, {}, provider.listSites, { unlocked: true }),
  'sites.revoke': uiEntry(POPUP, { origin: F.origin }, provider.revokeSite, { unlocked: true, activity: true }),
  'settings.get': uiEntry(ALL_PAGES, {}, session.getSettings),
  'settings.set': uiEntry(POPUP, {
    autoLockMinutes: optional(oneOf(...AUTO_LOCK_CHOICES)),
    language: optional(oneOf(...SUPPORTED_LANGUAGES)),
  }, session.setSettings, { unlocked: true, activity: true, check: (p) => Object.keys(p).length > 0 }),
  'approval.get': uiEntry(['approve'], { id: F.approvalId }, provider.getApproval),
  // No password: the unlocked session and the armed press in the approval's own window confirm (provider.js binds the
  // call to that window and that approval). revision: the ApprovalView.revision the page showed; a send, burn or claim
  // confirm needs the latest one
  'approval.resolve': uiEntry(['approve'], {
    id: F.approvalId, approved: boolean(), revision: optional(integer(0, Number.MAX_SAFE_INTEGER)),
  }, provider.resolveApproval, { activity: true }),
});

function providerEntry(params, check = null, origins = null) {
  const normalize = typeof params === 'function' ? params : null;
  return Object.freeze({ params: params === null || normalize !== null ? null : Object.freeze(params), check, origins, normalize });
}

/**
 * The provider allow-list. params null: no params (undefined, null, [] or {}); a function: the params'
 * normalizer (normalizeTransaction). origins: when set, an origin it refuses gets 4100 before the params are
 * read. All dispatch to provider.handleRequest(ctx, method, params). Solana signing is not offered to dApps.
 */
export const PROVIDER_METHODS = Object.freeze({
  qnet_requestAccounts: providerEntry(null),
  qnet_accounts: providerEntry(null),
  qnet_chainId: providerEntry(null),
  qnet_disconnect: providerEntry(null),
  qnet_signMessage: providerEntry({ message: F.dappMessage }, (p, ctx) => isSignableMessage(ctx.origin, p.message)),
  qnet_sendTransaction: providerEntry(normalizeTransaction),
  qnet_getTransactionStatus: providerEntry({ from: F.qnetAddress, nonce: F.nonce }),
  qnet_activateNode: providerEntry({ nodeType: F.nodeType }, null, isActivationOrigin),
  // the extension's knowledge of the wallet's activation, read-only, never a window, the activation origin only
  qnet_getActivation: providerEntry(null, null, isActivationOrigin),
  // Move to wallet from the cabinet: the wallet's own light node only, no params, the activation origin only
  qnet_claimNodeBalance: providerEntry(null, null, isActivationOrigin),
  // Unlink from the cabinet: the wallet key ends the wallet's own light node on its device, no params, the activation
  // origin only (decision 38)
  qnet_unlinkNodeDevice: providerEntry(null, null, isActivationOrigin),
});

/** The only provider results allowed to carry a SECRET_RESULT_KEYS name: the activation code for aiqnet.io. */
export const PROVIDER_RESULT_KEY_EXCEPTIONS = Object.freeze({
  qnet_activateNode: Object.freeze(['code']),
  qnet_getActivation: Object.freeze(['code']),
});

// Key names no response may carry at any depth (R09: never the phrase, entropy, keys or password), with
// the only documented exceptions: the password-gated reveal of the phrase and of one account's private key, and the
// activation code after burn or copy.
export const SECRET_RESULT_KEYS = Object.freeze([
  'mnemonic', 'phrase', 'entropy', 'seed', 'xi', 'secretKey', 'privateKey', 'key', 'vaultKey', 'sitesKey',
  'password', 'newPassword', 'code',
]);
export const RESULT_KEY_EXCEPTIONS = Object.freeze({
  'vault.reveal': Object.freeze(['mnemonic']),
  'vault.exportKey': Object.freeze(['privateKey']),
  'activation.burn': Object.freeze(['code']),
  'activation.copy': Object.freeze(['code']),
});
const SECRET_KEY_SET = new Set(SECRET_RESULT_KEYS);
const RESULT_MAX_DEPTH = 8;
const RESULT_MAX_NODES = 20000;

// ---------------------------------------------------------------- validation

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function passes(fn, ...args) {
  try {
    return fn(...args) === true;
  } catch {
    return false;
  }
}

function valueMatches(spec, value) {
  switch (spec.kind) {
    case 'string':
      return typeof value === 'string' && value.length >= spec.min && value.length <= spec.max
        && (spec.pattern === null || spec.pattern.test(value)) && (spec.check === null || passes(spec.check, value));
    case 'integer':
      return Number.isSafeInteger(value) && value >= spec.min && value <= spec.max;
    case 'boolean':
      return typeof value === 'boolean';
    case 'enum':
      return spec.values.includes(value);
    case 'list':
      return Array.isArray(value) && value.length <= spec.max && new Set(value).size === value.length
        && value.every((item) => valueMatches(spec.item, item));
    default:
      return false;
  }
}

const invalid = (field) => new WalletError('INVALID_PARAMS', field === undefined ? {} : { field });

/**
 * Validates params against a field table and returns a fresh object holding only those fields.
 * Unknown keys, missing required fields, wrong types, lengths, patterns and failed checks all throw.
 * @param {Record<string, object>|null} fields null: the request takes no params
 * @param {unknown} raw
 * @param {{check?: ((params: object, ctx: object|null) => boolean)|null, ctx?: object|null}} [options]
 * @returns {object}
 * @throws {WalletError} INVALID_PARAMS (with `field` when one field is at fault)
 */
export function validateParams(fields, raw, { check = null, ctx = null } = {}) {
  if (fields === null) {
    const empty = raw === undefined || raw === null || (Array.isArray(raw) && raw.length === 0)
      || (isPlainObject(raw) && Object.keys(raw).length === 0);
    if (!empty) throw invalid();
    return {};
  }
  const input = raw === undefined ? {} : raw;
  if (!isPlainObject(input)) throw invalid();
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(fields, key)) throw invalid(key);
  }
  const out = {};
  for (const [name, spec] of Object.entries(fields)) {
    const value = input[name];
    if (value === undefined) {
      if (spec.optional) continue;
      throw invalid(name);
    }
    if (value === null) {
      if (!spec.nullable) throw invalid(name);
      out[name] = null;
      continue;
    }
    if (!valueMatches(spec, value)) throw invalid(name);
    out[name] = Array.isArray(value) ? [...value] : value;
  }
  if (check !== null && !passes(check, out, ctx)) throw invalid();
  return out;
}

/**
 * Whether a handler result may leave the worker: JSON data only (null, booleans, finite numbers,
 * strings, arrays, plain objects; no undefined, bigint or bytes), at most RESULT_MAX_DEPTH deep, and no
 * key of SECRET_RESULT_KEYS at any depth unless listed in `allowedKeys`.
 * @param {unknown} value
 * @param {readonly string[]} [allowedKeys]
 * @returns {boolean}
 */
export function isSafeResult(value, allowedKeys = []) {
  let budget = RESULT_MAX_NODES;
  const walk = (node, depth) => {
    budget -= 1;
    if (budget < 0 || depth > RESULT_MAX_DEPTH) return false;
    if (node === null || typeof node === 'boolean' || typeof node === 'string') return true;
    if (typeof node === 'number') return Number.isFinite(node);
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) {
        if (!walk(node[i], depth + 1)) return false;
      }
      return true;
    }
    if (!isPlainObject(node)) return false;
    return Object.keys(node).every((name) => (!SECRET_KEY_SET.has(name) || allowedKeys.includes(name))
      && walk(node[name], depth + 1));
  };
  return walk(value, 0);
}

const isRequestId = (id) => (typeof id === 'string' && ID_RE.test(id)) || (Number.isSafeInteger(id) && id >= 0);

function jsonLength(value) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return Infinity;
  }
}

function parseRequest(message, keys, maxChars, nameKey, nameRe) {
  if (!isPlainObject(message)) throw new WalletError('INVALID_REQUEST');
  for (const key of Object.keys(message)) {
    if (!keys.includes(key)) throw new WalletError('INVALID_REQUEST');
  }
  const name = message[nameKey];
  if (typeof name !== 'string' || !nameRe.test(name) || !isRequestId(message.id)) throw new WalletError('INVALID_REQUEST');
  if (jsonLength(message) > maxChars) throw new WalletError('INVALID_REQUEST');
  return message;
}

// ---------------------------------------------------------------- senders

function extensionBase(runtime) {
  const base = new URL(runtime.getURL(''));
  return { protocol: base.protocol, host: base.host, origin: `${base.protocol}//${base.host}` };
}

function isExtensionUrl(value, base) {
  try {
    const url = new URL(value);
    return url.protocol === base.protocol && url.host === base.host;
  } catch {
    return false;
  }
}

/**
 * Which extension page sent a runtime message, or null when the sender is not one of UI_PAGES of this
 * extension: another extension, a content script (web sender.url / sender.origin / sender.tab.url), the
 * worker itself, a subframe, or any other extension path.
 * @param {object} sender chrome.runtime.MessageSender
 * @param {{id: string, getURL: (path: string) => string}} runtime
 * @returns {'popup'|'setup'|'approve'|null}
 */
export function uiPageOf(sender, runtime) {
  if (!sender || typeof sender !== 'object' || sender.id !== runtime.id || typeof sender.url !== 'string') return null;
  const base = extensionBase(runtime);
  if (!isExtensionUrl(sender.url, base)) return null;
  if (sender.origin !== undefined && sender.origin !== base.origin) return null;
  if (sender.frameId !== undefined && sender.frameId !== 0) return null;
  if (sender.tab !== undefined && sender.tab !== null && sender.tab.url !== undefined && !isExtensionUrl(sender.tab.url, base)) {
    return null;
  }
  const { pathname } = new URL(sender.url);
  const found = Object.entries(UI_PAGES).find(([, path]) => pathname === `/${path}`);
  return found ? /** @type {'popup'|'setup'|'approve'} */ (found[0]) : null;
}

/**
 * The content-script match patterns of the relay (dev overlay adds loopback ones).
 * @param {object} manifest chrome.runtime.getManifest()
 * @returns {string[]}
 */
export function relayMatchPatterns(manifest) {
  const scripts = Array.isArray(manifest?.content_scripts) ? manifest.content_scripts : [];
  return scripts
    .filter((entry) => Array.isArray(entry?.js) && entry.js.includes(PROVIDER.RELAY_SCRIPT))
    .flatMap((entry) => (Array.isArray(entry.matches) ? entry.matches.filter((m) => typeof m === 'string') : []));
}

/**
 * Chrome match-pattern test of an origin: scheme exact (http or https only), host exact or '*.' + host
 * (which also matches the bare host), port exact when the pattern names one. A pattern without a port is
 * stricter than Chrome's: an https one takes only the default port (R4-ERP-02: another service on another port
 * of the site's host never gets the provider), a plain-HTTP one (the dev overlay's loopback) any port.
 * @param {string} origin
 * @param {string} pattern
 * @returns {boolean}
 */
export function originMatchesPattern(origin, pattern) {
  const match = typeof pattern === 'string' ? PATTERN_RE.exec(pattern) : null;
  if (!match || !isCanonicalOrigin(origin)) return false;
  const url = new URL(origin);
  const [, scheme, host, port] = match;
  if (url.protocol !== `${scheme}:`) return false;
  if (port !== undefined && (url.port || DEFAULT_PORTS[url.protocol]) !== port) return false;
  if (port === undefined && scheme === 'https' && url.port !== '') return false;
  if (host === '*') return true;
  if (host.startsWith('*.')) {
    const parent = host.slice(2);
    return url.hostname === parent || url.hostname.endsWith(`.${parent}`);
  }
  return url.hostname === host;
}

/**
 * The origin a provider port may act for, or null: this extension's content script (sender.id), in a
 * tab's top frame of an active document (not prerendered or cached), whose sender.origin is canonical,
 * agrees with sender.url and matches the relay's manifest patterns.
 * @param {object} sender port.sender
 * @param {{id: string}} runtime
 * @param {string[]} patterns relayMatchPatterns(manifest)
 * @returns {string|null}
 */
export function providerOriginOf(sender, runtime, patterns) {
  if (!sender || typeof sender !== 'object' || sender.id !== runtime.id) return null;
  const tabId = sender.tab?.id;
  if (!Number.isSafeInteger(tabId) || tabId < 0 || sender.frameId !== 0) return null;
  if (sender.documentLifecycle !== undefined && sender.documentLifecycle !== 'active') return null;
  const { origin } = sender;
  if (!isCanonicalOrigin(origin) || typeof sender.url !== 'string') return null;
  try {
    if (new URL(sender.url).origin !== origin) return null;
  } catch {
    return null;
  }
  return patterns.some((pattern) => originMatchesPattern(origin, pattern)) ? origin : null;
}

// ---------------------------------------------------------------- router

const EXPECTED_ERRORS = new Set(['WalletError', 'ProviderError', 'CoreError']);
const NO_EXCEPTIONS = Object.freeze([]);
const DISCONNECT_DATA = Object.freeze(toProviderError(new ProviderError(PROVIDER_ERROR_CODES.DISCONNECTED)));

function post(port, message) {
  try {
    port.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

function disconnectQuietly(port) {
  try {
    port?.disconnect();
  } catch {
    // already gone
  }
}

/**
 * Builds the router. Defaults wire the real modules; tests inject a runtime mock and stub handlers.
 * @param {object} [options]
 * @param {object} [options.runtime] chrome.runtime (default globalThis.chrome.runtime)
 * @param {Record<string, Function>} [options.handlers] per-type overrides of UI_MESSAGES handlers
 * @param {() => Promise<unknown>} [options.requireUnlocked] default session.requireUnlocked
 * @param {() => Promise<void>} [options.touch] default session.touch
 * @param {(ctx: object, method: string, params: object) => Promise<unknown>} [options.providerRequest]
 *   default provider.handleRequest
 * @param {(ctx: object) => Promise<void>} [options.providerPortClosed] default provider.onPortClosed
 * @param {object|null} [options.tabs] chrome.tabs (default globalThis.chrome.tabs): an event reaches a page whose relay
 *   holds no open port through chrome.tabs.sendMessage
 * @returns {Readonly<{
 *   handleUiMessage: (message: unknown, sender: object) => Promise<object>,
 *   handleProviderConnect: (port: object) => void,
 *   emitProviderEvent: (origin: string, event: string, data: unknown) => number,
 *   broadcastToViews: (event: string, data?: unknown) => void,
 *   install: () => void,
 *   openPorts: () => number,
 * }>}
 */
export function createRouter(options = {}) {
  const runtime = options.runtime ?? globalThis.chrome?.runtime;
  if (!runtime) throw new Error('chrome.runtime is unavailable');
  const handlers = options.handlers ?? {};
  const requireUnlocked = options.requireUnlocked ?? session.requireUnlocked;
  const touch = options.touch ?? session.touch;
  const providerRequest = options.providerRequest ?? provider.handleRequest;
  const providerPortClosed = options.providerPortClosed ?? provider.onPortClosed;
  const tabsApi = () => (Object.hasOwn(options, 'tabs') ? options.tabs : globalThis.chrome?.tabs ?? null);

  const ports = new Map();
  let portSeq = 0;
  let patterns = null;
  const allowedPatterns = () => {
    patterns ??= Object.freeze(relayMatchPatterns(runtime.getManifest()));
    return patterns;
  };
  // The relay patterns tabs are looked up by: those a host permission names (chrome.tabs.query filters by URL only for
  // hosts the extension may access; the store build: https://aiqnet.io/*).
  let tabPatterns = null;
  const queryPatterns = () => {
    if (tabPatterns === null) {
      const hosts = runtime.getManifest()?.host_permissions;
      tabPatterns = Object.freeze(allowedPatterns().filter((pattern) => Array.isArray(hosts) && hosts.includes(pattern)));
    }
    return tabPatterns;
  };

  // An event for the pages of `origin` whose relay holds no open port (an idle worker stopped and closed it, or the page
  // has asked nothing since it loaded, EXT-F3): chrome.tabs.sendMessage to the top frame of every tab showing that exact
  // origin, which the relay forwards to its page as it forwards a port event. The message names the origin, and a relay
  // whose page is another origin by the time it arrives (the tab navigated meanwhile) drops it. Best effort, never throws.
  function notifyTabs(origin, event, payload, reached) {
    const api = tabsApi();
    const urls = queryPatterns();
    if (!api || typeof api.query !== 'function' || typeof api.sendMessage !== 'function' || urls.length === 0) return;
    Promise.resolve()
      .then(() => api.query({ url: [...urls] }))
      .then((found) => {
        for (const tab of Array.isArray(found) ? found : []) {
          if (!Number.isSafeInteger(tab?.id) || reached.has(tab.id) || typeof tab.url !== 'string') continue;
          let shown = null;
          try {
            shown = new URL(tab.url).origin;
          } catch {
            shown = null;
          }
          if (shown !== origin) continue;
          Promise.resolve()
            .then(() => api.sendMessage(tab.id, { target: PROVIDER.TAB_EVENT, origin, event, data: payload }, { frameId: 0 }))
            .catch(() => {});
        }
      })
      .catch((error) => log.warn('tab notify failed', error?.name));
  }

  /**
   * One extension-page request → {id, ok: true, result} or {id, ok: false, error: {code, message}}.
   * Never rejects.
   */
  async function handleUiMessage(message, sender) {
    const id = isPlainObject(message) && isRequestId(message.id) ? message.id : null;
    let type = null;
    try {
      const page = uiPageOf(sender, runtime);
      if (page === null) throw new WalletError('FORBIDDEN_SENDER');
      ({ type } = parseRequest(message, ['type', 'id', 'params'], LIMITS.UI_MESSAGE_MAX_CHARS, 'type', TYPE_RE));
      const entry = Object.hasOwn(UI_MESSAGES, type) ? UI_MESSAGES[type] : null;
      if (entry === null) throw new WalletError('UNKNOWN_TYPE');
      if (!entry.pages.includes(page)) throw new WalletError('FORBIDDEN_SENDER');
      const params = validateParams(entry.params, message.params, { check: entry.check });
      if (entry.unlocked) await requireUnlocked();
      const handler = Object.hasOwn(handlers, type) ? handlers[type] : entry.handler;
      const result = (await handler(params, Object.freeze({ page, sender }))) ?? null;
      if (!isSafeResult(result, RESULT_KEY_EXCEPTIONS[type] ?? NO_EXCEPTIONS)) {
        log.error('unsafe result withheld', type);
        throw new WalletError('INTERNAL');
      }
      if (entry.activity) {
        try {
          await touch();
        } catch (error) {
          log.warn('touch failed', error?.code ?? error?.name);
        }
      }
      return { id, ok: true, result };
    } catch (error) {
      if (!EXPECTED_ERRORS.has(error?.name)) log.warn('ui request failed', type, error?.name);
      return { id, ok: false, error: toUiError(error) };
    }
  }

  async function handleProviderMessage(entry, message) {
    const id = isPlainObject(message) && isRequestId(message.id) ? message.id : null;
    if (id === null) return;
    if (entry.pending >= LIMITS.PORT_MAX_PENDING) {
      post(entry.port, { id, ok: false, error: toProviderError(new ProviderError(PROVIDER_ERROR_CODES.USER_REJECTED)) });
      return;
    }
    entry.pending += 1;
    let method = null;
    try {
      ({ method } = parseRequest(message, ['id', 'method', 'params'], LIMITS.PORT_MESSAGE_MAX_CHARS, 'method', METHOD_RE));
      const spec = Object.hasOwn(PROVIDER_METHODS, method) ? PROVIDER_METHODS[method] : null;
      if (spec === null) throw new ProviderError(PROVIDER_ERROR_CODES.UNSUPPORTED_METHOD);
      if (spec.origins !== null && !spec.origins(entry.ctx.origin)) throw new ProviderError(PROVIDER_ERROR_CODES.UNAUTHORIZED);
      const params = spec.normalize !== null ? spec.normalize(message.params)
        : validateParams(spec.params, message.params, { check: spec.check, ctx: entry.ctx });
      const result = (await providerRequest(entry.ctx, method, params)) ?? null;
      if (!isSafeResult(result, PROVIDER_RESULT_KEY_EXCEPTIONS[method] ?? NO_EXCEPTIONS)) {
        log.error('unsafe provider result withheld', method);
        throw new ProviderError(PROVIDER_ERROR_CODES.INTERNAL);
      }
      post(entry.port, { id, ok: true, result });
    } catch (error) {
      if (!EXPECTED_ERRORS.has(error?.name)) log.warn('provider request failed', method, error?.name);
      post(entry.port, { id, ok: false, error: toProviderError(error) });
    } finally {
      entry.pending -= 1;
    }
  }

  /** runtime.onConnect listener: keeps only 'qnet-provider' ports of the relay on an allowed origin. */
  function handleProviderConnect(port) {
    if (!port || port.name !== PROVIDER.PORT_NAME) {
      disconnectQuietly(port);
      return;
    }
    const origin = providerOriginOf(port.sender, runtime, allowedPatterns());
    if (origin === null) {
      disconnectQuietly(port);
      return;
    }
    portSeq += 1;
    const ctx = Object.freeze({ origin, tabId: port.sender.tab.id, portId: portSeq });
    const entry = { port, ctx, pending: 0 };
    ports.set(ctx.portId, entry);
    port.onMessage.addListener((message) => {
      handleProviderMessage(entry, message);
    });
    port.onDisconnect.addListener(() => {
      ports.delete(ctx.portId);
      Promise.resolve()
        .then(() => providerPortClosed(ctx))
        .catch((error) => log.warn('port close handling failed', error?.name));
    });
  }

  /**
   * Posts {event, data} to every open port of `origin`; returns how many ports received it. The pages of `origin` no
   * port reached get it through their tab (notifyTabs). The disconnect payload is the protocol constant {code: 4900,
   * message: 'Disconnected'}, whatever `data` is.
   */
  function emitProviderEvent(origin, event, data) {
    if (!isCanonicalOrigin(origin) || !PROVIDER.EVENTS.includes(event)) return 0;
    const payload = event === 'disconnect' ? DISCONNECT_DATA : data ?? null;
    if (payload !== DISCONNECT_DATA && !isSafeResult(payload)) return 0;
    let delivered = 0;
    const reached = new Set();
    for (const { port, ctx } of ports.values()) {
      if (ctx.origin === origin && post(port, { event, data: payload })) {
        delivered += 1;
        reached.add(ctx.tabId);
      }
    }
    notifyTabs(origin, event, payload, reached);
    return delivered;
  }

  /** Worker → extension pages: {channel: VIEW_EVENT_CHANNEL, event, data}; no page open is not an error. */
  function broadcastToViews(event, data) {
    if (!VIEW_EVENTS.includes(event)) return;
    const payload = data ?? null;
    if (!isSafeResult(payload)) return;
    try {
      const sent = runtime.sendMessage({ channel: VIEW_EVENT_CHANNEL, event, data: payload });
      if (sent && typeof sent.catch === 'function') sent.catch(() => {});
    } catch {
      // no extension page is open
    }
  }

  function install() {
    runtime.onMessage.addListener((message, sender, sendResponse) => {
      handleUiMessage(message, sender).then(sendResponse, () => {
        sendResponse({ id: null, ok: false, error: toUiError(null) });
      });
      return true;
    });
    runtime.onConnect.addListener(handleProviderConnect);
  }

  return Object.freeze({
    handleUiMessage,
    handleProviderConnect,
    emitProviderEvent,
    broadcastToViews,
    install,
    openPorts: () => ports.size,
  });
}
