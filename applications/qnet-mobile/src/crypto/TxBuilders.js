/**
 * Wallet transactions the node accepts, built from typed fields: the calldata and deploy payload the node rebuilds,
 * the bytes each transaction signs (WalletIdentity), the gas it needs and the exact JSON of its request. The one copy:
 * the app imports it, the extension's qnet-core bundle and the SDK compile it. Pure JS, no native module.
 * Known answers: __vectors__/tx-vectors.json. Formats pinned against the node source: __tests__/TxSourcePin.test.js.
 */
import { sha3_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { GAS_PRICE, TRANSFER_GAS_LIMIT, contractCallGasLimit } from '../config/fees.js';
import {
  contractCallPreimage, contractDeployPreimage, isValidQnetAddress, transferPreimage,
} from './WalletIdentity.js';

// gas_limits::MAX_GAS_LIMIT: the most gas one transaction may carry.
export const MAX_GAS_LIMIT = 1_000_000;
// gas_limits::CONTRACT_DEPLOY, plus this much per byte of the deploy payload.
export const DEPLOY_BASE_GAS = 500_000;
export const DEPLOY_GAS_PER_BYTE = 10;
// {"code":"","code_hash":"<64 hex>","wasm":true}: a deploy payload is 2N + 102 bytes for an N-byte module.
const DEPLOY_DATA_OVERHEAD = 102;
// The largest module a deploy can carry within MAX_GAS_LIMIT (24,949 bytes).
export const MAX_WASM_CODE_BYTES = Math.floor(((MAX_GAS_LIMIT - DEPLOY_BASE_GAS) / DEPLOY_GAS_PER_BYTE - DEPLOY_DATA_OVERHEAD) / 2);
// A WASM call runs on gas_limit - intrinsic gas of fuel, and fuel it does not use is refunded. The default budget
// covers a call that writes storage and emits a few events; below the minimum no entry point can run.
export const WASM_DEFAULT_FUEL = 200_000;
export const WASM_MIN_FUEL = 10_000;
// A built-in token transfer to this address destroys the tokens.
export const CANONICAL_BURN_ADDRESS = '0000000000000000000eon00000000000000036877022';

// Where each kind is submitted, and the largest body the route reads.
export const TX_ROUTES = Object.freeze({
  transfer: Object.freeze({ path: '/api/v1/transaction', maxBodyBytes: 64 * 1024 }),
  call: Object.freeze({ path: '/api/v1/contract/call', maxBodyBytes: 128 * 1024 }),
  deploy: Object.freeze({ path: '/api/v1/contract/deploy', maxBodyBytes: 2 * 1024 * 1024 }),
});

// Wire sizes of the signature and public key in hex, for the body size check before signing.
const SIGNATURE_HEX_CHARS = 3309 * 2;
const PUBLIC_KEY_HEX_CHARS = 1952 * 2;

const METHOD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const HEX_RE = /^(?:[0-9a-fA-F]{2})*$/;
const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?:^|[^\ud800-\udbff])[\udc00-\udfff]/;
const U64_MAX = (1n << 64n) - 1n;
const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];

/** Every failure carries a stable code and nothing else: no address, amount or key is placed in an error. */
export class TxBuildError extends Error {
  constructor(code) {
    super(code);
    this.name = 'TxBuildError';
    this.code = code;
  }
}

const fail = (code) => {
  throw new TxBuildError(code);
};

/** Canonical decimal string of an unsigned 64-bit integer given as bigint, safe integer or digits. */
export function toU64String(value) {
  let n;
  if (typeof value === 'bigint') n = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) n = BigInt(value);
  else if (typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value)) n = BigInt(value);
  else return fail('INVALID_INTEGER');
  if (n < 0n || n > U64_MAX) fail('INVALID_INTEGER');
  return n.toString();
}

const utf8Length = (text) => utf8ToBytes(text).length;

// Arguments serde_json writes back byte for byte as JSON.stringify does: null, a string, or a list of strings and
// safe integers. Objects (serde sorts their keys), floats and lone surrogates would not round-trip.
function checkArgs(args) {
  const plain = (v) => (typeof v === 'string' && !LONE_SURROGATE_RE.test(v)) || Number.isSafeInteger(v);
  if (args === null || (typeof args === 'string' && plain(args))) return args;
  if (Array.isArray(args) && args.every(plain)) return args;
  return fail('INVALID_ARGS');
}

/**
 * The calldata the node builds for POST /api/v1/contract/call: json!({contract, method, args}) written by serde_json,
 * whose keys come out sorted. The signature binds its SHA3-256.
 */
export function contractCallData(contract, method, args) {
  if (typeof contract !== 'string' || typeof method !== 'string' || contract === '' || method === '') fail('INVALID_CALL');
  return JSON.stringify({ args: checkArgs(args === undefined ? null : args), contract, method });
}

/** Intrinsic gas of a contract call: CONTRACT_CALL plus 5 per byte of its calldata. */
export const contractCallIntrinsicGas = (callData) => contractCallGasLimit(utf8Length(callData));

/** SHA3-256 of a WASM module: the code_hash its deploy signs. */
export const wasmCodeHash = (code) => bytesToHex(sha3_256(code));

/** The deploy payload the node builds from the module: {"code","code_hash","wasm":true}. */
export function contractDeployData(code) {
  return JSON.stringify({ code: bytesToHex(code), code_hash: wasmCodeHash(code), wasm: true });
}

/** Intrinsic gas of a contract deploy: CONTRACT_DEPLOY plus 10 per byte of its payload. */
export const contractDeployIntrinsicGas = (deployData) => DEPLOY_BASE_GAS + DEPLOY_GAS_PER_BYTE * utf8Length(deployData);

/** The address a deploy from `from` at `nonce` gets: the chain derives it, the deployer cannot choose it. */
export function deriveContractAddress(from, nonce) {
  let n = BigInt(toU64String(nonce));
  const le = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    le[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  const h = bytesToHex(sha3_256(concatBytes(utf8ToBytes('qnet_contract_v1'), utf8ToBytes(from), le)));
  const body = `${h.slice(0, 19)}eon${h.slice(19, 34)}`;
  return body + bytesToHex(sha3_256(utf8ToBytes(body))).slice(0, 8);
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += BASE64[(n >> 18) & 63] + BASE64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? BASE64[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? BASE64[n & 63] : '=';
  }
  return out;
}

// ---- typed builders: every field checked, the preimage built here ----

const address = (value) => (isValidQnetAddress(value) ? value : fail('INVALID_ADDRESS'));

function positive(value, code) {
  const s = toU64String(value);
  return s === '0' ? fail(code) : s;
}

// The node takes nonce = committed + 1, so never 0; and no gas price below the chain minimum.
const nonceOf = (value) => positive(value, 'INVALID_NONCE');

function gasPriceOf(value) {
  const s = toU64String(value);
  return BigInt(s) < BigInt(GAS_PRICE) ? fail('INVALID_GAS_PRICE') : s;
}

function gasLimitOf(value, min) {
  const s = toU64String(value);
  const n = BigInt(s);
  return n < BigInt(min) || n > BigInt(MAX_GAS_LIMIT) ? fail('INVALID_GAS_LIMIT') : s;
}

// Every ML-DSA-signed transaction pays gas_price + gas_price/2 per gas; this is what gas_limit can cost at most.
function maxFeeNano(gasPrice, gasLimit) {
  const p = BigInt(gasPrice);
  return ((p + p / 2n) * BigInt(gasLimit)).toString();
}

// A call's gas limit: at least its intrinsic gas plus `minFuel`, at most MAX_GAS_LIMIT; by default exactly that least.
function callLimits(callData, gasLimit, minFuel) {
  const intrinsic = contractCallIntrinsicGas(callData);
  if (intrinsic + minFuel > MAX_GAS_LIMIT) fail('INVALID_GAS_LIMIT');
  const limit = gasLimitOf(gasLimit ?? intrinsic + minFuel, intrinsic + minFuel);
  return { intrinsicGas: String(intrinsic), gasLimit: limit, fuel: String(Number(limit) - intrinsic) };
}

// A call body must fit its route with a full signature and public key on it.
function callFits(tx) {
  contractCallRequestJson(tx, 'f'.repeat(SIGNATURE_HEX_CHARS), 'f'.repeat(PUBLIC_KEY_HEX_CHARS));
}

/**
 * A QNC transfer (POST /api/v1/transaction). `amountNano` in nano-QNC (1 QNC = 10^9).
 * @returns {Readonly<{kind: 'transfer', path: string, from: string, to: string, amountNano: string, nonce: string,
 *   gasPrice: string, gasLimit: string, maxFeeNano: string, preimage: string}>}
 */
export function buildTransfer({ from, to, amountNano, nonce, gasPrice = GAS_PRICE, gasLimit = TRANSFER_GAS_LIMIT } = {}) {
  const tx = {
    kind: 'transfer',
    path: TX_ROUTES.transfer.path,
    from: address(from),
    to: address(to),
    amountNano: positive(amountNano, 'INVALID_AMOUNT'),
    nonce: nonceOf(nonce),
    gasPrice: gasPriceOf(gasPrice),
    gasLimit: gasLimitOf(gasLimit, TRANSFER_GAS_LIMIT),
  };
  tx.maxFeeNano = maxFeeNano(tx.gasPrice, tx.gasLimit);
  tx.preimage = transferPreimage(tx.from, tx.to, tx.amountNano, tx.nonce, tx.gasPrice, tx.gasLimit);
  return Object.freeze(tx);
}

/**
 * A built-in token transfer: a contract call of "transfer" with args [to, amount], `amount` in the token's base units
 * (u64). It runs no WASM, so its gas limit defaults to the intrinsic gas. Sending to CANONICAL_BURN_ADDRESS burns.
 * The QNC it needs is the fee plus a refundable deposit when `to` holds none of the token (read that from the chain).
 */
export function buildTokenTransfer({ from, token, to, amount, nonce, gasPrice = GAS_PRICE, gasLimit = null } = {}) {
  const args = Object.freeze([address(to), positive(amount, 'INVALID_AMOUNT')]);
  const tx = {
    kind: 'tokenTransfer',
    path: TX_ROUTES.call.path,
    from: address(from),
    contract: address(token),
    method: 'transfer',
    args,
    to: args[0],
    amount: args[1],
    nonce: nonceOf(nonce),
    gasPrice: gasPriceOf(gasPrice),
  };
  tx.callData = contractCallData(tx.contract, tx.method, tx.args);
  const { intrinsicGas, gasLimit: limit } = callLimits(tx.callData, gasLimit, 0);
  Object.assign(tx, { intrinsicGas, gasLimit: limit, maxFeeNano: maxFeeNano(tx.gasPrice, limit) });
  tx.preimage = contractCallPreimage(tx.from, tx.callData, tx.nonce, tx.gasPrice, tx.gasLimit);
  return Object.freeze(tx);
}

/**
 * A call of a WASM contract: `args` is the call input as hex (null for none). The gas limit is the intrinsic gas plus
 * `fuel` (default WASM_DEFAULT_FUEL, at least WASM_MIN_FUEL), or an explicit `gasLimit` (not both) that leaves at
 * least WASM_MIN_FUEL; either way at most MAX_GAS_LIMIT. A call carries no QNC.
 */
export function buildContractCall({
  from, contract, method, args = null, nonce, gasPrice = GAS_PRICE, gasLimit = null, fuel = null,
} = {}) {
  if (typeof method !== 'string' || !METHOD_RE.test(method)) fail('INVALID_METHOD');
  if (args !== null && (typeof args !== 'string' || !HEX_RE.test(args))) fail('INVALID_ARGS');
  if (gasLimit !== null && fuel !== null) fail('INVALID_FUEL');
  const tx = {
    kind: 'contractCall',
    path: TX_ROUTES.call.path,
    from: address(from),
    contract: address(contract),
    method,
    args: args === null ? null : args.toLowerCase(),
    nonce: nonceOf(nonce),
    gasPrice: gasPriceOf(gasPrice),
  };
  tx.callData = contractCallData(tx.contract, tx.method, tx.args);
  const intrinsic = contractCallIntrinsicGas(tx.callData);
  let limit = gasLimit;
  if (limit === null) {
    if (fuel === null) limit = intrinsic + Math.min(WASM_DEFAULT_FUEL, MAX_GAS_LIMIT - intrinsic);
    else if (Number.isSafeInteger(fuel) && fuel >= WASM_MIN_FUEL && intrinsic + fuel <= MAX_GAS_LIMIT) limit = intrinsic + fuel;
    else fail('INVALID_FUEL');
  }
  Object.assign(tx, callLimits(tx.callData, limit, WASM_MIN_FUEL));
  tx.maxFeeNano = maxFeeNano(tx.gasPrice, tx.gasLimit);
  callFits(tx);
  tx.preimage = contractCallPreimage(tx.from, tx.callData, tx.nonce, tx.gasPrice, tx.gasLimit);
  return Object.freeze(tx);
}

/**
 * A WASM contract deploy (POST /api/v1/contract/deploy): the module travels base64, the payload the node builds
 * carries it as hex with its SHA3-256, and the gas limit defaults to the intrinsic gas (a deploy runs no code).
 * Only the magic number is checked here: the node's module rules are the deploy tool's to mirror.
 */
export function buildContractDeploy({ from, code, nonce, gasPrice = GAS_PRICE, gasLimit = null } = {}) {
  if (!(code instanceof Uint8Array) || code.length < 8 || WASM_MAGIC.some((b, i) => code[i] !== b)) fail('INVALID_CODE');
  if (code.length > MAX_WASM_CODE_BYTES) fail('CODE_TOO_LARGE');
  const tx = {
    kind: 'contractDeploy',
    path: TX_ROUTES.deploy.path,
    from: address(from),
    codeSize: String(code.length),
    codeHash: wasmCodeHash(code),
    codeBase64: base64(code),
    deployData: contractDeployData(code),
    nonce: nonceOf(nonce),
    gasPrice: gasPriceOf(gasPrice),
  };
  const intrinsic = contractDeployIntrinsicGas(tx.deployData);
  tx.intrinsicGas = String(intrinsic);
  tx.gasLimit = gasLimitOf(gasLimit ?? intrinsic, intrinsic);
  tx.maxFeeNano = maxFeeNano(tx.gasPrice, tx.gasLimit);
  tx.contractAddress = deriveContractAddress(tx.from, tx.nonce);
  tx.preimage = contractDeployPreimage(tx.from, tx.codeHash, tx.nonce, tx.gasPrice, tx.gasLimit);
  return Object.freeze(tx);
}

// ---- request bodies: the exact JSON text, u64 fields as bare integers written from their digits ----

const str = (value, code) => (typeof value === 'string' && value !== '' ? JSON.stringify(value) : fail(code));

function requestJson(route, entries) {
  const text = `{${entries.map(([key, value]) => `"${key}":${value}`).join(',')}}`;
  return utf8Length(text) > route.maxBodyBytes ? fail('REQUEST_TOO_LARGE') : text;
}

/**
 * Body of POST /api/v1/transaction for transfer fields { from, to, amountNano, nonce, gasPrice, gasLimit } and the
 * signature over their preimage (hex). The public key rides along until the chain holds it (null leaves it out).
 */
export function transferRequestJson(tx, signatureHex, publicKeyHex = null) {
  const entries = [
    ['from', str(tx.from, 'INVALID_ADDRESS')],
    ['to', str(tx.to, 'INVALID_ADDRESS')],
    ['amount', toU64String(tx.amountNano)],
    ['dilithium_signature', str(signatureHex, 'INVALID_SIGNATURE')],
    ['gas_price', toU64String(tx.gasPrice)],
    ['gas_limit', toU64String(tx.gasLimit)],
    ['nonce', toU64String(tx.nonce)],
  ];
  if (publicKeyHex !== null && publicKeyHex !== undefined) entries.push(['dilithium_public_key', str(publicKeyHex, 'INVALID_PUBLIC_KEY')]);
  return requestJson(TX_ROUTES.transfer, entries);
}

/** Body of POST /api/v1/contract/call for call fields { from, contract, method, args, nonce, gasPrice, gasLimit }. */
export function contractCallRequestJson(tx, signatureHex, publicKeyHex = null) {
  const entries = [
    ['from', str(tx.from, 'INVALID_ADDRESS')],
    ['contract_address', str(tx.contract, 'INVALID_ADDRESS')],
    ['method', str(tx.method, 'INVALID_METHOD')],
    ['args', JSON.stringify(checkArgs(tx.args === undefined ? null : tx.args))],
    ['gas_price', toU64String(tx.gasPrice)],
    ['gas_limit', toU64String(tx.gasLimit)],
    ['nonce', toU64String(tx.nonce)],
    ['dilithium_signature', str(signatureHex, 'INVALID_SIGNATURE')],
  ];
  if (publicKeyHex !== null && publicKeyHex !== undefined) entries.push(['dilithium_public_key', str(publicKeyHex, 'INVALID_PUBLIC_KEY')]);
  return requestJson(TX_ROUTES.call, entries);
}

/** Body of POST /api/v1/contract/deploy for a buildContractDeploy result. The route always needs the public key. */
export function contractDeployRequestJson(tx, signatureHex, publicKeyHex) {
  return requestJson(TX_ROUTES.deploy, [
    ['from', str(tx.from, 'INVALID_ADDRESS')],
    ['code', str(tx.codeBase64, 'INVALID_CODE')],
    ['constructor_args', 'null'],
    ['gas_limit', toU64String(tx.gasLimit)],
    ['gas_price', toU64String(tx.gasPrice)],
    ['nonce', toU64String(tx.nonce)],
    ['dilithium_signature', str(signatureHex, 'INVALID_SIGNATURE')],
    ['dilithium_public_key', str(publicKeyHex, 'INVALID_PUBLIC_KEY')],
  ]);
}
