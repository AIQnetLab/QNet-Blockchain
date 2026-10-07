/**
 * The parameters a site may pass to qnet_sendTransaction and qnet_getTransactionStatus, checked as the browser
 * extension checks them (applications/qnet-wallet CONTRACTS.md section 4): exactly the keys of each form, addresses
 * exactly as the chain spells them, amounts as canonical decimal text, call input as hex. Pure JS with no React Native
 * import, so the extension's bundle can compile the same file.
 *
 * - { to, amount } or { type: 'transfer', to, amount }: QNC, `amount` in QNC.
 * - { type: 'tokenTransfer', token, to, amount }: a built-in token, `amount` in the token's own units (its decimals are
 *   read from the chain before the sheet shows).
 * - { type: 'contractCall', contract, method, args, gasLimit? }: a WASM contract, `args` its input as hex. A call
 *   carries no QNC and no access list today: `value` and `accessList` are refused as UNSUPPORTED_PARAM.
 */
import { isValidQnetAddress } from '../crypto/WalletIdentity';

export const QNC_DECIMALS = 9;
// The most decimals a token may have for the wallet to scale an amount (the node stores them as a u8).
export const TOKEN_DECIMALS_MAX = 18;
// The most call input a site may pass, in bytes: the sheet shows all of it.
export const CALL_ARGS_MAX_BYTES = 4096;
export const U64_MAX = (1n << 64n) - 1n;
export const UNSUPPORTED_PARAM = 'UNSUPPORTED_PARAM';

const AMOUNT_MAX_CHARS = 40;
const DECIMAL_RE = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;
const METHOD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const HEX_RE = /^(?:[0-9a-fA-F]{2})*$/;
const NONCE_RE = /^[1-9][0-9]{0,19}$/;
const UNSUPPORTED_KEYS = ['value', 'accessList'];

/** A refused request: `reason` is 'INVALID' or UNSUPPORTED_PARAM (both -32602 to the page). */
export class RequestError extends Error {
  constructor(reason = 'INVALID') {
    super(reason);
    this.name = 'RequestError';
    this.reason = reason;
  }
}

const refuse = (reason) => {
  throw new RequestError(reason);
};

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

function hasExactKeys(obj, keys) {
  const have = Object.keys(obj);
  return have.length === keys.length && keys.every((k) => hasOwn(obj, k));
}

/** Base units of a canonical decimal ("12", "0.5"; no sign, exponent, leading zeros or bare dot) up to u64, or null. */
export function parseUnits(text, decimals) {
  if (typeof text !== 'string' || text.length > AMOUNT_MAX_CHARS) return null;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > TOKEN_DECIMALS_MAX) return null;
  const m = DECIMAL_RE.exec(text);
  if (!m) return null;
  const fraction = m[2] || '';
  if (fraction.length > decimals) return null;
  const value = BigInt(m[1] + fraction.padEnd(decimals, '0'));
  return value > U64_MAX ? null : value;
}

/** Base units as canonical decimal text, trailing fraction zeros dropped ("1.5", "0.00015", "0"). */
export function formatUnits(value, decimals) {
  const digits = BigInt(value).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

const address = (value) => (isValidQnetAddress(value) ? value : refuse());

/**
 * One qnet_sendTransaction request, normalised: { type: 'transfer', to, amountNano } |
 * { type: 'tokenTransfer', token, to, amount } | { type: 'contractCall', contract, method, args, gasLimit }.
 * Throws RequestError. A token amount is checked against the token's decimals, and a call's gas limit against its
 * intrinsic gas, once those are known (crypto/TxBuilders).
 */
export function parseSendParams(params) {
  if (!isPlainObject(params)) refuse();
  const type = hasOwn(params, 'type') ? params.type : 'transfer';
  if (type === 'transfer') {
    if (!hasExactKeys(params, hasOwn(params, 'type') ? ['type', 'to', 'amount'] : ['to', 'amount'])) refuse();
    const to = address(params.to);
    const amountNano = parseUnits(params.amount, QNC_DECIMALS);
    if (amountNano === null || amountNano <= 0n) refuse();
    return { type, to, amountNano };
  }
  if (type === 'tokenTransfer') {
    if (!hasExactKeys(params, ['type', 'token', 'to', 'amount'])) refuse();
    const token = address(params.token);
    const to = address(params.to);
    const { amount } = params;
    if (typeof amount !== 'string' || amount.length > AMOUNT_MAX_CHARS || !DECIMAL_RE.test(amount)) refuse();
    return { type, token, to, amount };
  }
  if (type === 'contractCall') {
    if (UNSUPPORTED_KEYS.some((k) => hasOwn(params, k))) refuse(UNSUPPORTED_PARAM);
    if (!hasExactKeys(params, ['type', 'contract', 'method', 'args', ...(hasOwn(params, 'gasLimit') ? ['gasLimit'] : [])])) refuse();
    const contract = address(params.contract);
    const { method, args } = params;
    if (typeof method !== 'string' || !METHOD_RE.test(method)) refuse();
    if (typeof args !== 'string' || !HEX_RE.test(args) || args.length / 2 > CALL_ARGS_MAX_BYTES) refuse();
    const gasLimit = hasOwn(params, 'gasLimit') ? params.gasLimit : null;
    if (gasLimit !== null && (!Number.isSafeInteger(gasLimit) || gasLimit <= 0)) refuse();
    return { type, contract, method, args: args.toLowerCase(), gasLimit };
  }
  return refuse();
}

/** One qnet_getTransactionStatus request: { from, nonce } with the nonce as decimal text, as a send's result gives it. */
export function parseStatusParams(params) {
  if (!isPlainObject(params) || !hasExactKeys(params, ['from', 'nonce'])) refuse();
  const from = address(params.from);
  const { nonce } = params;
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce) || BigInt(nonce) > U64_MAX) refuse();
  return { from, nonce };
}
