// Solana for the wallet's own account on the build's cluster (SOLANA.CLUSTER, never a setting):
// balances, the history, sends of SOL and the listed SPL tokens (1DEV), the activation burn transaction, and the burn
// matcher.
// Transactions are legacy-format, built here from typed fields, signed through keys.signSolanaMessage.
import * as core from '../lib/qnet-core.js';
import { U64_MAX, formatUnits, parseUnits } from './amount.js';
import { DECIMALS, LIMITS, PAYMENT_REQUEST, SOLANA, TIMINGS, isPaymentRequestMemo } from './config.js';
import { WalletError } from './errors.js';
import * as keys from './keys.js';
import * as session from './session.js';
import * as vault from './vault.js';

/**
 * @typedef {object} AccountMeta
 * @property {string} pubkey base58
 * @property {boolean} isSigner
 * @property {boolean} isWritable
 *
 * @typedef {object} Instruction
 * @property {string} programId base58
 * @property {AccountMeta[]} keys in the program's account order
 * @property {Uint8Array} data
 *
 * @typedef {object} SolanaBalances
 * @property {string} address the wallet's Solana address
 * @property {string} lamports u64 decimal
 * @property {{mint: string, ata: string, exists: boolean, raw: string, decimals: 6}} oneDev raw is u64 decimal
 *
 * @typedef {object} SolanaQuote
 * @property {'sol'|'1dev'} asset
 * @property {string} to
 * @property {string|null} mint the SPL token's mint; null for SOL
 * @property {number} decimals SOL 9; a token's decimals as its mint reports them
 * @property {string} amountRaw lamports or token base units, u64 decimal
 * @property {string} feeLamports network fee of the transaction
 * @property {boolean} createsRecipientAccount SPL only: the recipient's associated token account is created
 * @property {string} rentLamports rent the wallet pays for that account, '0' otherwise
 * @property {string} totalLamports feeLamports + rentLamports (+ amountRaw for SOL)
 * @property {string} balanceLamports the wallet's SOL at confirmed commitment
 * @property {string|null} tokenRaw SPL only: the wallet's token balance at confirmed commitment
 * @property {string} rentFloorLamports the least a plain account holds unless it is empty (rent exemption of 0 bytes)
 * @property {'INSUFFICIENT_SOL'|'INSUFFICIENT_TOKENS'|'AMOUNT_BELOW_RENT'|'SOL_BELOW_RENT'|null} shortfall why the send
 *   would fail as reviewed (what `send` refuses with), null when it can go
 * @property {string[]} references a payment request's reference keys the transfer carries, in its order ([] for none)
 * @property {string|null} memo a payment request's memo the transaction carries, null for none
 * @property {{known: boolean, lookalike: boolean}|null} recipient how the recipient relates to this wallet
 *   (recipientCheck); null when the vault could not be read
 *
 * @typedef {object} BurnMatch
 * @property {string} signature
 * @property {'light'|'super'} nodeType
 * @property {number} amount whole 1DEV
 * @property {number|null} slot
 * @property {number|null} blockTime
 * @property {boolean} finalized true for a burn of the finalized history, false for one in flight (confirmed only)
 */

const { SYSTEM, TOKEN, ASSOCIATED_TOKEN, MEMO } = core.SOLANA_PROGRAMS;
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const MEMO_PROGRAMS = [MEMO, SOLANA.MEMO_V1_PROGRAM];
const NODE_TYPE_MEMO_PREFIX = 'QNET_NODE_TYPE:';
const MEMO_NODE_TYPES = Object.freeze({ [SOLANA.NODE_TYPE_MEMO.light]: 'light', [SOLANA.NODE_TYPE_MEMO.super]: 'super' });
const TOKEN_ACCOUNT_SPACE = 165;
// A plain wallet account holds no data: its rent floor is the exemption of 0 bytes.
const SYSTEM_ACCOUNT_SPACE = 0;
const RPC_ATTEMPTS = 3;
const RPC_BACKOFF_MS = 500;
// JSON-RPC errors that describe the RPC node's state, not the request: worth another attempt.
const RETRYABLE_RPC_CODES = new Set([-32004, -32005, -32007, -32009, -32014, -32016, -32603]);
// sendTransaction refusals that mean the transaction was rejected before it was forwarded.
const PREFLIGHT_RPC_CODES = new Set([-32002, -32003]);
const MAX_RPC_RESPONSE_CHARS = 8 << 20;
const POLL_MS = 2000;
// A send reads its status once after it went out; the popup follows it from there (solana.status).
const SEND_CONFIRM_TIMEOUT_MS = 0;
const SCAN_SPACING_MS = 150;
const MAX_WHOLE_BURN = 1_000_000_000;

// The reference Solana client's legacy message compiler orders same-class keys with this collation, so a message
// compiled in its order ('client': the burn) is byte-identical to one built there.
const PUBKEY_ORDER = new Intl.Collator('en', {
  usage: 'sort', sensitivity: 'variant', ignorePunctuation: false, numeric: false, caseFirst: 'lower',
});

const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

function unavailable(rpcCode) {
  const error = new WalletError('SOLANA_UNAVAILABLE');
  if (Number.isSafeInteger(rpcCode)) error.rpcCode = rpcCode;
  return error;
}

// ---------------------------------------------------------------- RPC

async function post(url, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
    // read with a cap on the bytes that arrive, never whole first (R4-EXTQ-03)
    const text = await core.readBoundedText(response, MAX_RPC_RESPONSE_CHARS);
    return { status: response.status, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * JSON-RPC call to SOLANA.RPC_URLS with timeout, backoff on 429/5xx and endpoint rotation.
 * @param {string} method
 * @param {unknown[]} params
 * @param {{timeoutMs?: number, attempts?: number, backoffMs?: number, retryRpcErrors?: boolean}} [options]
 *   retryRpcErrors false: a JSON-RPC error answer is returned at once (sendTransaction)
 * @returns {Promise<unknown>} the `result` member
 * @throws {WalletError} SOLANA_UNAVAILABLE; `rpcCode` carries the JSON-RPC error code when there was one
 */
export async function rpc(method, params, options = {}) {
  const {
    timeoutMs = TIMINGS.SOLANA_TIMEOUT_MS, attempts = RPC_ATTEMPTS, backoffMs = RPC_BACKOFF_MS, retryRpcErrors = true,
  } = options;
  if (typeof method !== 'string' || !/^[A-Za-z]{1,64}$/.test(method) || !Array.isArray(params)) {
    throw new WalletError('INTERNAL');
  }
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(backoffMs * 2 ** (attempt - 1));
    const url = SOLANA.RPC_URLS[attempt % SOLANA.RPC_URLS.length];
    let reply;
    try {
      reply = await post(url, body, timeoutMs);
    } catch {
      last = unavailable();
      continue;
    }
    if (reply.status === 429 || reply.status >= 500) {
      last = unavailable();
      continue;
    }
    if (reply.status !== 200) throw unavailable();
    let parsed;
    try {
      parsed = JSON.parse(reply.text);
    } catch {
      last = unavailable();
      continue;
    }
    if (parsed && typeof parsed === 'object' && parsed.error) {
      const error = unavailable(parsed.error.code);
      if (retryRpcErrors && RETRYABLE_RPC_CODES.has(parsed.error.code)) {
        last = error;
        continue;
      }
      throw error;
    }
    if (!parsed || typeof parsed !== 'object' || !('result' in parsed)) {
      last = unavailable();
      continue;
    }
    return parsed.result;
  }
  throw last ?? unavailable();
}

const safeInt = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);

async function lamportsOf(address, commitment = 'finalized') {
  const result = await rpc('getBalance', [address, { commitment }]);
  const lamports = safeInt(result?.value);
  if (lamports === null) throw unavailable();
  return String(lamports);
}

const decimalsCache = new WeakMap();

// The mint's real decimals (getTokenSupply, once per worker): the whole-1DEV rule, the burn amount and
// TransferChecked all depend on them, so a mint that does not report the channel's 6 stops everything.
async function mintDecimals(call = rpc) {
  if (decimalsCache.has(call)) return decimalsCache.get(call);
  const supply = await call('getTokenSupply', [SOLANA.ONE_DEV_MINT, { commitment: 'finalized' }]);
  if (supply?.value?.decimals !== DECIMALS.ONE_DEV) throw unavailable();
  decimalsCache.set(call, DECIMALS.ONE_DEV);
  return DECIMALS.ONE_DEV;
}

async function accountInfo(address, commitment = 'confirmed') {
  const result = await rpc('getAccountInfo', [address, { encoding: 'jsonParsed', commitment }]);
  if (!result || typeof result !== 'object' || !('value' in result)) throw unavailable();
  return result.value;
}

// The token account of `mint` (1DEV by default) at `address` for `owner`: null when it does not exist; anything else
// there is refused rather than read as a balance.
async function tokenAccount(address, owner, commitment = 'finalized', mint = SOLANA.ONE_DEV_MINT) {
  const value = await accountInfo(address, commitment);
  if (value === null) return null;
  const info = value?.data?.parsed?.info;
  const amount = info?.tokenAmount?.amount;
  if (value.owner !== TOKEN || value?.data?.parsed?.type !== 'account' || info?.mint !== mint
    || info?.owner !== owner || typeof amount !== 'string' || !/^[0-9]{1,20}$/.test(amount) || BigInt(amount) > U64_MAX) {
    throw unavailable();
  }
  return { amount, state: info.state };
}

/**
 * Handler of `solana.balances` (finalized commitment). The 1DEV decimals are asserted to be 6 with
 * getTokenSupply.
 * @returns {Promise<SolanaBalances>}
 * @throws {WalletError} LOCKED, SOLANA_UNAVAILABLE
 */
export async function getBalances() {
  const { solanaAddress: owner } = await session.requireUnlocked();
  const mint = SOLANA.ONE_DEV_MINT;
  const ata = core.associatedTokenAddress(owner, mint);
  const [lamports, decimals, token] = await Promise.all([lamportsOf(owner), mintDecimals(), tokenAccount(ata, owner)]);
  return { address: owner, lamports, oneDev: { mint, ata, exists: token !== null, raw: token?.amount ?? '0', decimals } };
}

/**
 * The newest blockhash at confirmed commitment.
 * @returns {Promise<{blockhash: string, lastValidBlockHeight: number|null}>}
 * @throws {WalletError} SOLANA_UNAVAILABLE
 */
export async function latestBlockhash() {
  const result = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const blockhash = result?.value?.blockhash;
  if (!core.isValidSolanaAddress(blockhash)) throw unavailable();
  return { blockhash, lastValidBlockHeight: safeInt(result.value.lastValidBlockHeight) };
}

/**
 * The cluster's block height at `commitment` (getBlockHeight): a transaction whose blockhash's
 * lastValidBlockHeight is below the finalized height can never land.
 * @param {'finalized'|'confirmed'} [commitment]
 * @returns {Promise<number>}
 * @throws {WalletError} SOLANA_UNAVAILABLE
 */
export async function blockHeight(commitment = 'finalized') {
  const height = safeInt(await rpc('getBlockHeight', [{ commitment }]));
  if (height === null) throw unavailable();
  return height;
}

async function messageFee(message) {
  const result = await rpc('getFeeForMessage', [core.base64Encode(message), { commitment: 'confirmed' }]);
  const fee = safeInt(result?.value);
  if (fee === null) throw unavailable();
  return String(fee);
}

async function rentExemptLamports(space) {
  const rent = safeInt(await rpc('getMinimumBalanceForRentExemption', [space, { commitment: 'confirmed' }]));
  if (rent === null) throw unavailable();
  return String(rent);
}

// ---------------------------------------------------------------- transaction bytes

function compactU16(n) {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new WalletError('INTERNAL');
  const out = [];
  let rest = n;
  for (;;) {
    const low = rest & 0x7f;
    rest >>= 7;
    if (rest === 0) {
      out.push(low);
      return out;
    }
    out.push(low | 0x80);
  }
}

function u64le(value) {
  if (typeof value !== 'bigint' || value < 0n || value > U64_MAX) throw new WalletError('INTERNAL');
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

function assertAddress(address) {
  if (!core.isValidSolanaAddress(address)) throw new WalletError('INVALID_ADDRESS');
  return address;
}

function assertInstruction(ix) {
  assertAddress(ix?.programId);
  if (!Array.isArray(ix.keys) || !(ix.data instanceof Uint8Array)) throw new WalletError('INTERNAL');
  for (const meta of ix.keys) {
    assertAddress(meta?.pubkey);
    if (typeof meta.isSigner !== 'boolean' || typeof meta.isWritable !== 'boolean') throw new WalletError('INTERNAL');
  }
}

/**
 * Serialized legacy transaction message (header, compact account list ordered signer-writable,
 * signer-readonly, writable, readonly with the fee payer first, blockhash, compiled instructions).
 * Key order within each class: `order` 'client' (the default; the burn) follows the reference Solana client's legacy
 * message compiler exactly; 'listed' (a send) keeps the order the instructions name the keys in, program ids after every
 * instruction's accounts, as the app's SolanaTx compiles a transfer, so one send is the same bytes in both wallets.
 * @param {{feePayer: string, recentBlockhash: string, instructions: Instruction[], order?: 'client'|'listed'}} parts
 * @returns {Uint8Array}
 */
export function compileLegacyMessage(parts) {
  const { feePayer, recentBlockhash, instructions, order = 'client' } = parts ?? {};
  assertAddress(feePayer);
  const blockhash = core.solanaAddressToBytes(recentBlockhash);
  if (!Array.isArray(instructions) || instructions.length === 0 || (order !== 'client' && order !== 'listed')) {
    throw new WalletError('INTERNAL');
  }
  instructions.forEach(assertInstruction);

  const metas = [];
  const programs = [];
  for (const ix of instructions) {
    for (const meta of ix.keys) metas.push({ ...meta });
    if (!programs.includes(ix.programId)) programs.push(ix.programId);
  }
  for (const programId of programs) metas.push({ pubkey: programId, isSigner: false, isWritable: false });
  const unique = [];
  for (const meta of metas) {
    const seen = unique.find((m) => m.pubkey === meta.pubkey);
    if (seen) {
      seen.isSigner = seen.isSigner || meta.isSigner;
      seen.isWritable = seen.isWritable || meta.isWritable;
    } else {
      unique.push(meta);
    }
  }
  // the sort is stable: with 'listed' a class keeps the order the keys were first named in
  unique.sort((x, y) => {
    if (x.isSigner !== y.isSigner) return x.isSigner ? -1 : 1;
    if (x.isWritable !== y.isWritable) return x.isWritable ? -1 : 1;
    return order === 'client' ? PUBKEY_ORDER.compare(x.pubkey, y.pubkey) : 0;
  });
  const payerIndex = unique.findIndex((m) => m.pubkey === feePayer);
  if (payerIndex >= 0) unique.splice(payerIndex, 1);
  unique.unshift({ pubkey: feePayer, isSigner: true, isWritable: true });

  const keys = unique.map((m) => m.pubkey);
  if (keys.length > 256) throw new WalletError('INTERNAL');
  const header = [
    unique.filter((m) => m.isSigner).length,
    unique.filter((m) => m.isSigner && !m.isWritable).length,
    unique.filter((m) => !m.isSigner && !m.isWritable).length,
  ];
  const out = [...header, ...compactU16(keys.length)];
  for (const key of keys) out.push(...core.solanaAddressToBytes(key));
  out.push(...blockhash, ...compactU16(instructions.length));
  for (const ix of instructions) {
    out.push(keys.indexOf(ix.programId), ...compactU16(ix.keys.length));
    for (const meta of ix.keys) out.push(keys.indexOf(meta.pubkey));
    out.push(...compactU16(ix.data.length), ...ix.data);
  }
  return Uint8Array.from(out);
}

/**
 * Wire transaction: compact-u16 signature count, the signatures, then the message.
 * @param {Uint8Array} message
 * @param {Uint8Array[]} signatures 64 bytes each, in signer order
 * @returns {Uint8Array}
 */
export function serializeTransaction(message, signatures) {
  if (!(message instanceof Uint8Array) || !Array.isArray(signatures) || signatures.length !== message[0]) {
    throw new WalletError('INTERNAL');
  }
  for (const s of signatures) core.assertBytes(s, 64);
  return core.concatBytes(Uint8Array.from(compactU16(signatures.length)), ...signatures, message);
}

// First signature of a wire transaction (its id) and the message it signs.
function splitTransaction(transaction) {
  if (!(transaction instanceof Uint8Array) || transaction.length < 66 || transaction[0] < 1 || transaction[0] > 0x7f) {
    throw new WalletError('INTERNAL');
  }
  const count = transaction[0];
  return {
    signature: core.base58Encode(transaction.subarray(1, 65)),
    message: transaction.subarray(1 + 64 * count),
  };
}

// A payment request's reference keys: read-only, unsigned accounts after the transfer's own, in the request's order.
// Transfer, and TransferChecked with a key as owner, read no account past their own; the payee finds the transfer by them.
function referenceMetas(references) {
  if (!Array.isArray(references)) throw new WalletError('INTERNAL');
  return references.map((pubkey) => ({ pubkey: assertAddress(pubkey), isSigner: false, isWritable: false }));
}

/**
 * System program Transfer (instruction 2): [from (signer, writable), to (writable)], then any reference keys.
 * @param {{from: string, to: string, lamports: bigint, references?: string[]}} fields
 * @returns {Instruction}
 */
export function systemTransferInstruction(fields) {
  const { from, to, lamports, references = [] } = fields ?? {};
  return {
    programId: SYSTEM,
    keys: [
      { pubkey: assertAddress(from), isSigner: true, isWritable: true },
      { pubkey: assertAddress(to), isSigner: false, isWritable: true },
      ...referenceMetas(references),
    ],
    data: core.concatBytes(Uint8Array.of(2, 0, 0, 0), u64le(lamports)),
  };
}

/**
 * SPL Token TransferChecked (instruction 12): [source, mint, destination, owner(signer)], then any reference keys.
 * @param {{source: string, mint: string, destination: string, owner: string, amount: bigint, decimals: number,
 *   references?: string[]}} fields
 * @returns {Instruction}
 */
export function transferCheckedInstruction(fields) {
  const { source, mint, destination, owner, amount, decimals, references = [] } = fields ?? {};
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new WalletError('INTERNAL');
  return {
    programId: TOKEN,
    keys: [
      { pubkey: assertAddress(source), isSigner: false, isWritable: true },
      { pubkey: assertAddress(mint), isSigner: false, isWritable: false },
      { pubkey: assertAddress(destination), isSigner: false, isWritable: true },
      { pubkey: assertAddress(owner), isSigner: true, isWritable: false },
      ...referenceMetas(references),
    ],
    data: core.concatBytes(Uint8Array.of(12), u64le(amount), Uint8Array.of(decimals)),
  };
}

/**
 * Associated Token Account CreateIdempotent (instruction 1).
 * @param {{payer: string, ata: string, owner: string, mint: string}} fields
 * @returns {Instruction}
 */
export function createAtaIdempotentInstruction(fields) {
  const { payer, ata, owner, mint } = fields ?? {};
  return {
    programId: ASSOCIATED_TOKEN,
    keys: [
      { pubkey: assertAddress(payer), isSigner: true, isWritable: true },
      { pubkey: assertAddress(ata), isSigner: false, isWritable: true },
      { pubkey: assertAddress(owner), isSigner: false, isWritable: false },
      { pubkey: assertAddress(mint), isSigner: false, isWritable: false },
      { pubkey: SYSTEM, isSigner: false, isWritable: false },
      { pubkey: TOKEN, isSigner: false, isWritable: false },
    ],
    data: Uint8Array.of(1),
  };
}

/**
 * SPL Token Burn (instruction 8, NOT BurnChecked): [account(w), mint(w), authority(signer)], data
 * [8, amount u64 LE].
 * @param {{account: string, mint: string, authority: string, amount: bigint}} fields amount in base units
 * @returns {Instruction}
 */
export function burnInstruction(fields) {
  const { account, mint, authority, amount } = fields ?? {};
  if (typeof amount !== 'bigint' || amount <= 0n) throw new WalletError('INVALID_AMOUNT');
  return {
    programId: TOKEN,
    keys: [
      { pubkey: assertAddress(account), isSigner: false, isWritable: true },
      { pubkey: assertAddress(mint), isSigner: false, isWritable: true },
      { pubkey: assertAddress(authority), isSigner: true, isWritable: false },
    ],
    data: core.concatBytes(Uint8Array.of(8), u64le(amount)),
  };
}

/**
 * SPL Memo with the signer listed (so the memo is bound to the wallet).
 * @param {{text: string, signer: string}} fields
 * @returns {Instruction}
 */
export function memoInstruction(fields) {
  const { text, signer } = fields ?? {};
  if (typeof text !== 'string' || text.length === 0 || text.length > 256) throw new WalletError('INTERNAL');
  return {
    programId: MEMO,
    keys: [{ pubkey: assertAddress(signer), isSigner: true, isWritable: false }],
    data: core.utf8Encode(text),
  };
}

/**
 * The memo a payment request has a send carry: SPL Memo with no account listed, as the app writes it, its data the
 * memo's UTF-8.
 * @param {string} text config.isPaymentRequestMemo
 * @returns {Instruction}
 * @throws {WalletError} INVALID_PARAMS
 */
export function requestMemoInstruction(text) {
  if (!isPaymentRequestMemo(text)) throw new WalletError('INVALID_PARAMS');
  return { programId: MEMO, keys: [], data: core.utf8Encode(text) };
}

function burnMessage(owner, fields) {
  const { nodeType, amountWhole, recentBlockhash } = fields ?? {};
  const memo = Object.hasOwn(SOLANA.NODE_TYPE_MEMO, nodeType) ? SOLANA.NODE_TYPE_MEMO[nodeType] : null;
  if (memo === null) throw new WalletError('INVALID_NODE_TYPE');
  if (!Number.isSafeInteger(amountWhole) || amountWhole < 1 || amountWhole > MAX_WHOLE_BURN) {
    throw new WalletError('INVALID_AMOUNT');
  }
  const mint = SOLANA.ONE_DEV_MINT;
  const amount = BigInt(amountWhole) * 10n ** BigInt(DECIMALS.ONE_DEV);
  return compileLegacyMessage({
    feePayer: owner,
    recentBlockhash,
    instructions: [
      burnInstruction({ account: core.associatedTokenAddress(owner, mint), mint, authority: owner, amount }),
      memoInstruction({ text: memo, signer: owner }),
    ],
  });
}

// Signs a message built here with the session's Solana key and returns the wire transaction.
async function signMessage(owner, message) {
  const { signature, publicKey } = await keys.signSolanaMessage(message);
  if (core.solanaAddressFromPublicKey(publicKey) !== owner) throw new WalletError('ADDRESS_MISMATCH');
  if (!core.verifySolanaSignature(signature, message, publicKey)) throw new WalletError('SIGNATURE_SELF_CHECK_FAILED');
  return { transaction: serializeTransaction(message, [signature]), signature: core.base58Encode(signature) };
}

/**
 * Network fee of the activation burn transaction for these fields (getFeeForMessage).
 * @param {{nodeType: 'light'|'super', amountWhole: number, recentBlockhash: string}} fields
 * @returns {Promise<string>} lamports, u64 decimal
 * @throws {WalletError} LOCKED, SOLANA_UNAVAILABLE
 */
export async function burnFee(fields) {
  const { solanaAddress: owner } = await session.requireUnlocked();
  return messageFee(burnMessage(owner, fields));
}

/**
 * The activation burn transaction of the wallet: Burn of price * 10^6 from the wallet's 1DEV ATA,
 * authority and fee payer = wallet, plus Memo SOLANA.NODE_TYPE_MEMO[nodeType]; signed.
 * @param {{nodeType: 'light'|'super', amountWhole: number, recentBlockhash: string}} fields
 * @returns {Promise<{transaction: Uint8Array, signature: string}>} signature is the base58 tx id
 * @throws {WalletError} LOCKED, SIGNING_DISABLED
 */
export async function buildBurnTransaction(fields) {
  const { solanaAddress: owner } = await session.requireUnlocked();
  return signMessage(owner, burnMessage(owner, fields));
}

// The error simulateTransaction reports for a signed transaction (sigVerify true, replaceRecentBlockhash false), null
// when it ran clean.
async function simulationError(transaction) {
  splitTransaction(transaction);
  const result = await rpc('simulateTransaction', [core.base64Encode(transaction), {
    encoding: 'base64', sigVerify: true, replaceRecentBlockhash: false, commitment: 'confirmed',
  }]);
  const value = result?.value;
  if (!value || typeof value !== 'object') throw unavailable();
  return value.err ?? null;
}

/**
 * simulateTransaction with sigVerify true and replaceRecentBlockhash false.
 * @param {Uint8Array} transaction
 * @returns {Promise<void>}
 * @throws {WalletError} SIMULATION_FAILED, SOLANA_UNAVAILABLE
 */
export async function simulate(transaction) {
  if (await simulationError(transaction) !== null) throw new WalletError('SIMULATION_FAILED');
}

async function statusOf(signature, searchTransactionHistory) {
  const result = await rpc('getSignatureStatuses', [[signature], { searchTransactionHistory }]);
  if (!result || !Array.isArray(result.value)) throw unavailable();
  return result.value[0] ?? null;
}

const reached = (status, commitment) => status === 'finalized' || (commitment === 'confirmed' && status === 'confirmed');
const hasError = (status) => status.err !== null && status.err !== undefined;
// A failure counts only once a supermajority confirmed it: an error at 'processed' comes from a fork that
// may be dropped, while the same transaction can still land on the chain that wins (XP-R3-04, as mobile
// NodeBurn MOBLINK-R2-01).
const failedForGood = (status) => hasError(status)
  && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized');

/**
 * sendTransaction (skipPreflight false) then polls getSignatureStatuses for the transaction's own
 * signature until `commitment` or timeout. Throws only when the transaction cannot land (refused before
 * forwarding, or failed on chain at confirmed or finalized; an error at 'processed' is polled on, since
 * that fork may be dropped); a send nobody answered is polled like any other and ends 'pending'.
 * @param {Uint8Array} transaction
 * @param {{commitment?: 'confirmed'|'finalized', timeoutMs?: number}} [options]
 * @returns {Promise<{signature: string, status: 'finalized'|'confirmed'|'pending'}>} pending on timeout
 * @throws {WalletError} TX_FAILED when the chain reports an error, SIMULATION_FAILED when preflight
 *   refused it, SOLANA_UNAVAILABLE when the RPC refused it otherwise
 */
export async function sendAndConfirm(transaction, options = {}) {
  const { commitment = 'finalized', timeoutMs = TIMINGS.BURN_FINALIZE_TIMEOUT_MS } = options;
  const { signature } = splitTransaction(transaction);
  const deadline = Date.now() + timeoutMs;
  const wire = core.base64Encode(transaction);
  // An attempt whose answer was lost may have forwarded the transaction, so only a refusal of a clean
  // first attempt, for a signature the chain has not seen, means it cannot land.
  let uncertain = false;
  let refusal = null;
  for (let attempt = 0; attempt < RPC_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(RPC_BACKOFF_MS * 2 ** (attempt - 1));
    try {
      await rpc('sendTransaction', [wire, {
        encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 5,
      }], { attempts: 1, retryRpcErrors: false });
      break;
    } catch (error) {
      if (error instanceof WalletError && error.rpcCode !== undefined) {
        refusal = error;
        break;
      }
      uncertain = true;
    }
  }
  if (refusal && !uncertain) {
    const seen = await statusOf(signature, true).catch(() => null);
    if (!seen) {
      throw new WalletError(PREFLIGHT_RPC_CODES.has(refusal.rpcCode) ? 'SIMULATION_FAILED' : 'SOLANA_UNAVAILABLE');
    }
  }
  for (;;) {
    const status = await statusOf(signature, false).catch(() => null);
    if (status) {
      if (failedForGood(status)) throw new WalletError('TX_FAILED');
      if (!hasError(status) && reached(status.confirmationStatus, commitment)) {
        return { signature, status: status.confirmationStatus === 'finalized' ? 'finalized' : 'confirmed' };
      }
    }
    const left = deadline - Date.now();
    if (left <= 0) return { signature, status: 'pending' };
    await sleep(Math.min(POLL_MS, left));
  }
}

/**
 * Status of one signature (for a pending burn), searching the ledger history. 'failed' only for an error
 * at confirmed or finalized; an error at 'processed' reads as 'processed' (XP-R3-04).
 * @param {string} signature
 * @returns {Promise<'finalized'|'confirmed'|'processed'|'failed'|'unknown'>}
 * @throws {WalletError} SOLANA_UNAVAILABLE
 */
export async function signatureStatus(signature) {
  if (!core.isValidSolanaSignature(signature)) throw new WalletError('INVALID_BURN_TX');
  const status = await statusOf(signature, true);
  if (!status) return 'unknown';
  if (failedForGood(status)) return 'failed';
  if (hasError(status)) return 'processed';
  const known = ['finalized', 'confirmed', 'processed'];
  return known.includes(status.confirmationStatus) ? status.confirmationStatus : 'unknown';
}

// ---------------------------------------------------------------- sends: SOL and the listed SPL tokens

// The SPL tokens a send offers besides SOL, by the send's asset name: the tokens this wallet lists. TransferChecked
// carries the decimals the mint reports on chain (mintDecimals).
const SEND_TOKENS = Object.freeze({ '1dev': Object.freeze({ mint: SOLANA.ONE_DEV_MINT }) });

// What a send may hold: one System Transfer, or one TransferChecked after the recipient's associated account is created
// idempotently, with a payment request's memo right before the transfer. Anything else, a burn first of all, never goes
// out as a send, whatever built the list.
const isSystemTransfer = (ix) => ix.programId === SYSTEM && ix.data.length === 12 && ix.data[0] === 2
  && ix.data[1] === 0 && ix.data[2] === 0 && ix.data[3] === 0;
const isCreateIdempotent = (ix) => ix.programId === ASSOCIATED_TOKEN && ix.data.length === 1 && ix.data[0] === 1;
const isTransferChecked = (ix) => ix.programId === TOKEN && ix.data.length === 10 && ix.data[0] === 12;
// A payment request's parts as a send takes them: distinct Solana addresses, at most PAYMENT_REQUEST.REFERENCES_MAX, and
// a memo of config.isPaymentRequestMemo, or null.
const isReferenceList = (list) => Array.isArray(list) && list.length <= PAYMENT_REQUEST.REFERENCES_MAX
  && new Set(list).size === list.length && list.every((address) => core.isValidSolanaAddress(address));
const isMemoOrNone = (memo) => memo === null || isPaymentRequestMemo(memo);
const sameBytes = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i]);

// The transfer's own `own` accounts, then exactly the request's references, read-only and unsigned, in its order.
function carriesReferences(ix, own, references) {
  return ix.keys.length === own + references.length && references.every((pubkey, i) => {
    const meta = ix.keys[own + i];
    return meta.pubkey === pubkey && !meta.isSigner && !meta.isWritable;
  });
}

/**
 * Refuses an instruction list that is not a send of this payment request: [System Transfer], [TransferChecked] or
 * [CreateIdempotent, TransferChecked], each checked by program id and instruction data, with the transfer's own accounts
 * followed by exactly the request's `references` (read-only, unsigned, in its order) and, when the request has a `memo`,
 * one SPL Memo right before the transfer that lists no account and holds exactly that memo's UTF-8 (the app's layout).
 * A burn (SPL Burn 8, BurnChecked 15), an approval, a memo the request did not ask for or a second one, a reference it
 * did not name, or any other program never passes.
 * @param {Instruction[]} instructions
 * @param {{references?: string[], memo?: string|null}} [request] none by default
 * @returns {void}
 * @throws {WalletError} INTERNAL
 */
export function assertSendInstructions(instructions, request = {}) {
  const { references = [], memo = null } = request ?? {};
  if (!Array.isArray(instructions) || !isReferenceList(references) || !isMemoOrNone(memo)) throw new WalletError('INTERNAL');
  instructions.forEach(assertInstruction);
  const transfer = instructions.at(-1);
  const before = instructions.slice(0, -1);
  let at = 0;
  const create = at < before.length && isCreateIdempotent(before[at]) ? before[at++] : null;
  const memoIx = at < before.length && before[at].programId === MEMO ? before[at++] : null;
  const ok = transfer !== undefined && at === before.length
    && (isSystemTransfer(transfer) ? create === null && carriesReferences(transfer, 2, references)
      : isTransferChecked(transfer) && carriesReferences(transfer, 4, references))
    && (memo === null ? memoIx === null
      : memoIx !== null && memoIx.keys.length === 0 && sameBytes(memoIx.data, core.utf8Encode(memo)));
  if (!ok) throw new WalletError('INTERNAL');
}

/**
 * Refuses a one-signer message whose wire transaction (the signature count, the signature, the message) would be larger
 * than a Solana node accepts (SOLANA.TRANSACTION_MAX_BYTES).
 * @param {Uint8Array} message
 * @returns {void}
 * @throws {WalletError} TX_TOO_LARGE
 */
export function assertTransactionSize(message) {
  if (!(message instanceof Uint8Array) || 1 + 64 + message.length > SOLANA.TRANSACTION_MAX_BYTES) {
    throw new WalletError('TX_TOO_LARGE');
  }
}

/**
 * The legacy message of a send, fee payer and only signer the owner, its keys in the order its instructions name them
 * (compileLegacyMessage 'listed': the app's layout, so one send is the same bytes in both wallets). SOL: one System
 * Transfer to `to`. An SPL token: TransferChecked of `amountRaw` at `decimals` from the owner's associated token account
 * of `mint` to the recipient's, preceded by CreateIdempotent of that account (the owner pays its rent) when
 * `createAccount`. A payment request's `references` are read-only accounts of the transfer, and its `memo` one SPL Memo
 * right before the transfer, after the create. Never anything else (assertSendInstructions), and never larger than a
 * node accepts (assertTransactionSize).
 * @param {{owner: string, to: string, mint?: string|null, amountRaw: bigint, decimals: number, createAccount?: boolean,
 *   references?: string[], memo?: string|null, recentBlockhash: string}} fields
 * @returns {Uint8Array}
 * @throws {WalletError} INVALID_ADDRESS, INVALID_PARAMS, TX_TOO_LARGE, INTERNAL
 */
export function transferMessage(fields) {
  const {
    owner, to, mint = null, amountRaw, decimals, createAccount = false, references = [], memo = null, recentBlockhash,
  } = fields ?? {};
  const memoIx = memo === null ? [] : [requestMemoInstruction(memo)];
  const instructions = [];
  if (mint === null) {
    instructions.push(...memoIx, systemTransferInstruction({ from: owner, to, lamports: amountRaw, references }));
  } else {
    const source = core.associatedTokenAddress(assertAddress(owner), assertAddress(mint));
    const destination = core.associatedTokenAddress(assertAddress(to), mint);
    if (createAccount) instructions.push(createAtaIdempotentInstruction({ payer: owner, ata: destination, owner: to, mint }));
    instructions.push(...memoIx,
      transferCheckedInstruction({ source, mint, destination, owner, amount: amountRaw, decimals, references }));
  }
  assertSendInstructions(instructions, { references, memo });
  const message = compileLegacyMessage({ feePayer: owner, recentBlockhash, instructions, order: 'listed' });
  assertTransactionSize(message);
  return message;
}

// Why a send cannot go as planned, or null (SolanaQuote.shortfall). The chain refuses a transaction that leaves a
// funded account below its rent floor without emptying it, checked once the fee is taken and again at the end; and a
// new plain account only comes to exist with at least that floor.
function shortfallOf({ asset, to, owner, amountRaw, fee, rent, lamports, tokenRaw, floor, recipientExists }) {
  const outgoing = asset === 'sol' ? amountRaw : 0n;
  if (lamports < fee + rent + outgoing) return 'INSUFFICIENT_SOL';
  if (tokenRaw !== null && tokenRaw < amountRaw) return 'INSUFFICIENT_TOKENS';
  if (asset === 'sol' && !recipientExists && to !== owner && amountRaw < floor) return 'AMOUNT_BELOW_RENT';
  const afterFee = lamports - fee;
  const kept = lamports - fee - rent - (to === owner ? 0n : outgoing);
  const belowFloor = (value) => value > 0n && value < floor;
  if (lamports >= floor && (belowFloor(afterFee) || belowFloor(kept))) return 'SOL_BELOW_RENT';
  return null;
}

async function planTransfer(params, owner) {
  const { asset, to, amount, references = [], memo = null } = params ?? {};
  if (asset !== 'sol' && !Object.hasOwn(SEND_TOKENS, asset)) throw new WalletError('INVALID_PARAMS');
  if (!isReferenceList(references) || !isMemoOrNone(memo)) throw new WalletError('INVALID_PARAMS');
  assertAddress(to);
  const amountRaw = parseUnits(amount, asset === 'sol' ? DECIMALS.SOL : DECIMALS.ONE_DEV);
  if (amountRaw <= 0n) throw new WalletError('INVALID_AMOUNT');

  const [recipient, lamports, floor] = await Promise.all([
    accountInfo(to), lamportsOf(owner, 'confirmed'), rentExemptLamports(SYSTEM_ACCOUNT_SPACE),
  ]);
  // A token account or mint pasted as the recipient would strand what is sent: refuse it.
  if (recipient !== null && (recipient.owner === TOKEN || recipient.owner === TOKEN_2022)) {
    throw new WalletError('INVALID_ADDRESS');
  }

  let mint = null;
  let decimals = DECIMALS.SOL;
  let createsRecipientAccount = false;
  let rentLamports = '0';
  let tokenRaw = null;
  if (asset !== 'sol') {
    // A token goes to a wallet's associated account: the recipient must be a plain wallet address, a key on the curve
    // whatever the account holds. A system-owned program address (a PDA) could pass as a wallet but nothing may be
    // able to sign for its token account (EXT-CHAINS-05).
    if (!core.isOnEd25519Curve(core.solanaAddressToBytes(to)) || (recipient !== null && recipient.owner !== SYSTEM)) {
      throw new WalletError('INVALID_ADDRESS');
    }
    ({ mint } = SEND_TOKENS[asset]);
    const source = core.associatedTokenAddress(owner, mint);
    const destination = core.associatedTokenAddress(to, mint);
    const [chainDecimals, own, existing] = await Promise.all([
      mintDecimals(),
      tokenAccount(source, owner, 'confirmed', mint),
      destination === source ? null : tokenAccount(destination, to, 'confirmed', mint),
    ]);
    decimals = chainDecimals;
    tokenRaw = own?.amount ?? '0';
    if (destination !== source && existing === null) {
      createsRecipientAccount = true;
      rentLamports = await rentExemptLamports(TOKEN_ACCOUNT_SPACE);
    }
  }
  const { blockhash, lastValidBlockHeight } = await latestBlockhash();
  const message = transferMessage({
    owner, to, mint, amountRaw, decimals, createAccount: createsRecipientAccount, references, memo, recentBlockhash: blockhash,
  });
  const feeLamports = await messageFee(message);
  const total = BigInt(feeLamports) + BigInt(rentLamports) + (asset === 'sol' ? amountRaw : 0n);
  const shortfall = shortfallOf({
    asset, to, owner, amountRaw, fee: BigInt(feeLamports), rent: BigInt(rentLamports), lamports: BigInt(lamports),
    tokenRaw: tokenRaw === null ? null : BigInt(tokenRaw), floor: BigInt(floor), recipientExists: recipient !== null,
  });
  return {
    quote: {
      asset,
      to,
      mint,
      decimals,
      amountRaw: amountRaw.toString(),
      feeLamports,
      createsRecipientAccount,
      rentLamports,
      totalLamports: total.toString(),
      balanceLamports: lamports,
      tokenRaw,
      rentFloorLamports: floor,
      shortfall,
      references: [...references],
      memo,
    },
    message,
    lastValidBlockHeight,
    recipientExists: recipient !== null,
  };
}

// Shares the first and last four characters with a different address: what a person compares, and what an
// address-poisoning look-alike copies (qnet.js looksAlike, kit.looksLikeKnownAddress).
function looksAlike(candidate, known) {
  return known.some((address) => address !== candidate && address.length === candidate.length
    && address.slice(0, 4) === candidate.slice(0, 4) && address.slice(-4) === candidate.slice(-4));
}

/**
 * How a Solana recipient relates to this wallet, for the first-time and look-alike warnings of the send review
 * (R3-EXT-UI-03, the Solana side of ES-01): `known` from the vault's record of the addresses this wallet signed
 * SOL or token transfers to, never from incoming transfers or an explorer page; `lookalike` against those and
 * the wallet's own address.
 * @param {string} to
 * @returns {Promise<{known: boolean, lookalike: boolean}>}
 * @throws {WalletError} LOCKED, INVALID_ADDRESS
 */
export async function recipientCheck(to) {
  const { solanaAddress: owner } = await session.requireUnlocked();
  assertAddress(to);
  const { solanaRecipients } = await vault.readState();
  const known = solanaRecipients.includes(to);
  return { known, lookalike: !known && to !== owner && looksAlike(to, [...solanaRecipients, owner]) };
}

/**
 * Handler of `solana.quote`: the review screen's numbers for a send (fee, rent, totals, the balances they are checked
 * against, and `shortfall` when the send would fail as reviewed), with the recipient check, and the payment request's
 * references and memo the transaction carries, which the review shows.
 * @param {{asset: 'sol'|'1dev', to: string, amount: string, references?: string[], memo?: string}} params amount is
 *   decimal SOL or token units; references and memo: a payment request's (PAYMENT_REQUEST)
 * @returns {Promise<SolanaQuote>}
 * @throws {WalletError} LOCKED, SOLANA_UNAVAILABLE, INVALID_AMOUNT, INVALID_ADDRESS, INVALID_PARAMS, TX_TOO_LARGE
 */
export async function quote(params) {
  const { solanaAddress: owner } = await session.requireUnlocked();
  const [planned, recipient] = await Promise.all([
    planTransfer(params, owner),
    recipientCheck(params?.to).catch((error) => {
      if (error instanceof WalletError && error.code === 'LOCKED') throw error;
      return null;
    }),
  ]);
  return { ...planned.quote, recipient };
}

/**
 * Handler of `solana.max` (the send form's Max): the largest amount of `asset` a send can carry now. SOL: the balance
 * at confirmed less the fee of this very transfer, which leaves the account empty; an SPL token: its whole balance (the
 * fee and any rent are SOL, which the review checks).
 * @param {{asset: 'sol'|'1dev', to?: string}} params to: the recipient typed so far (a new account needs its rent floor)
 * @returns {Promise<{amount: string, amountRaw: string}>} amount: the canonical decimal the form shows
 * @throws {WalletError} LOCKED, SOLANA_UNAVAILABLE, INVALID_ADDRESS, INVALID_PARAMS, INSUFFICIENT_SOL (nothing left after
 *   the fee), INSUFFICIENT_TOKENS (no tokens), SOL_BELOW_RENT (what the fee leaves is below the rent floor, so nothing can
 *   go), AMOUNT_BELOW_RENT (all of it is less than a new recipient account needs)
 */
export async function maxAmount(params) {
  const { solanaAddress: owner } = await session.requireUnlocked();
  const { asset, to = owner } = params ?? {};
  assertAddress(to);
  if (asset === 'sol') {
    // the fee does not depend on the amount: one lamport plans the same message
    const plan = await planTransfer({ asset, to, amount: '0.000000001' }, owner);
    const lamports = BigInt(plan.quote.balanceLamports);
    const floor = BigInt(plan.quote.rentFloorLamports);
    const max = lamports - BigInt(plan.quote.feeLamports);
    if (max <= 0n) throw new WalletError('INSUFFICIENT_SOL');
    if (lamports >= floor && max < floor) throw new WalletError('SOL_BELOW_RENT');
    if (!plan.recipientExists && to !== owner && max < floor) throw new WalletError('AMOUNT_BELOW_RENT');
    return { amount: formatUnits(max, DECIMALS.SOL), amountRaw: max.toString() };
  }
  if (!Object.hasOwn(SEND_TOKENS, asset)) throw new WalletError('INVALID_PARAMS');
  const { mint } = SEND_TOKENS[asset];
  const [decimals, own] = await Promise.all([
    mintDecimals(), tokenAccount(core.associatedTokenAddress(owner, mint), owner, 'confirmed', mint),
  ]);
  const raw = BigInt(own?.amount ?? '0');
  if (raw === 0n) throw new WalletError('INSUFFICIENT_TOKENS');
  return { amount: formatUnits(raw, decimals), amountRaw: raw.toString() };
}

/**
 * Handler of `solana.send`: SOL (System Transfer) or a listed SPL token (TransferChecked at the mint's decimals, the
 * recipient's associated account created idempotently when missing), with a payment request's references and memo.
 * Plans again from the quote's fields, references and memo included (transferMessage binds the signed instructions to
 * exactly them), and refuses with FEE_CHANGED when the fee or the rent differs from what the user reviewed, and with the
 * quote's shortfall; signs, simulates (sigVerify true; a blockhash the cluster no longer knows is BLOCKHASH_EXPIRED:
 * nothing sent, review again), records the recipient, sends, and reads the status once. The popup follows a
 * 'submitted' send with `solana.status`.
 * @param {{asset: 'sol'|'1dev', to: string, amount: string, references?: string[], memo?: string,
 *   expectedFeeLamports: string, expectedRentLamports: string}} params the quote's params; the two expectations are
 *   SolanaQuote.feeLamports / rentLamports
 * @returns {Promise<{signature: string, status: 'finalized'|'confirmed'|'submitted', lastValidBlockHeight: number|null}>}
 *   lastValidBlockHeight: of the transaction's blockhash, for `solana.status`
 * @throws {WalletError} LOCKED, SIGNING_DISABLED, FEE_CHANGED, INSUFFICIENT_SOL, INSUFFICIENT_TOKENS, AMOUNT_BELOW_RENT,
 *   SOL_BELOW_RENT, BLOCKHASH_EXPIRED, SIMULATION_FAILED, TX_FAILED, SOLANA_UNAVAILABLE, INVALID_PARAMS, TX_TOO_LARGE
 */
export async function send(params) {
  const { solanaAddress: owner } = await session.requireUnlocked();
  const plan = await planTransfer(params, owner);
  const { quote: q } = plan;
  if (q.feeLamports !== params.expectedFeeLamports || q.rentLamports !== params.expectedRentLamports) {
    throw new WalletError('FEE_CHANGED');
  }
  if (q.shortfall !== null) throw new WalletError(q.shortfall);
  const { transaction } = await signMessage(owner, plan.message);
  const simulated = await simulationError(transaction);
  if (simulated === 'BlockhashNotFound') throw new WalletError('BLOCKHASH_EXPIRED');
  if (simulated !== null) throw new WalletError('SIMULATION_FAILED');
  // a recipient the user signed for becomes a known one (recipientCheck), before the transaction leaves
  if (q.to !== owner) await vault.updateState((state) => vault.withSolanaRecipient(state, q.to));
  const sent = await sendAndConfirm(transaction, { commitment: 'confirmed', timeoutMs: SEND_CONFIRM_TIMEOUT_MS });
  return {
    signature: sent.signature,
    status: sent.status === 'pending' ? 'submitted' : sent.status,
    lastValidBlockHeight: plan.lastValidBlockHeight,
  };
}

/**
 * Handler of `solana.status`: where a send stands, for the popup that follows it. 'failed': an error at confirmed or
 * finalized (signatureStatus); 'expired': the ledger has no trace of it and the finalized block height passed its
 * blockhash's lastValidBlockHeight, looked up again after that height was read (as a pending burn is), so it can never
 * land and nothing was spent; anything else not confirmed yet is 'pending'.
 * @param {{signature: string, lastValidBlockHeight?: number|null}} params from `solana.send`
 * @returns {Promise<{status: 'pending'|'confirmed'|'finalized'|'failed'|'expired'}>}
 * @throws {WalletError} LOCKED, SOLANA_UNAVAILABLE
 */
export async function transferStatus(params) {
  await session.requireUnlocked();
  const { signature, lastValidBlockHeight = null } = params ?? {};
  let status = await signatureStatus(signature);
  if (status === 'unknown' && Number.isSafeInteger(lastValidBlockHeight) && (await blockHeight('finalized')) > lastValidBlockHeight) {
    status = await signatureStatus(signature);
    if (status === 'unknown') return { status: 'expired' };
  }
  return { status: ['finalized', 'confirmed', 'failed'].includes(status) ? status : 'pending' };
}

// ---------------------------------------------------------------- history (the popup's Solana History)

/**
 * @typedef {object} SolanaHistoryItem  one transaction of the wallet's Solana account, as History lists it
 * @property {string} signature
 * @property {'sol'|'1dev'} asset what moved for the wallet: 1DEV when its 1DEV balance changed (or it burned 1DEV), else SOL
 * @property {'in'|'out'|'self'} direction self: nothing moved for the wallet but the fee it paid
 * @property {string|null} counterparty the other side's Solana address (a token account's owner), null when not known
 * @property {string} amountRaw what moved, in lamports or 1DEV base units (u64 decimal); a failed transaction's is what it
 *   asked to move
 * @property {string|null} feeLamports the network fee, when the wallet paid it
 * @property {number|null} timestamp ms
 * @property {'confirmed'|'failed'} status
 * @property {boolean} burn the wallet burned 1DEV in it
 */

// A cursor names where each of the two listings goes on: the owner's address, then its 1DEV account, each a signature,
// '-' (from the newest) or '~' (nothing older).
const CURSOR_FROM_NEWEST = '-';
const CURSOR_DONE = '~';
// Transactions read at once, within what a public RPC allows one address (as the burn search).
const HISTORY_CONCURRENCY = 2;
// Rows of transactions read already: a transaction at confirmed does not change, so a refresh reads only new ones.
const HISTORY_ROWS_MAX = 500;
const historyRows = new Map();

function historyCursor(cursor) {
  if (cursor === null || cursor === undefined) return [CURSOR_FROM_NEWEST, CURSOR_FROM_NEWEST];
  const parts = typeof cursor === 'string' ? cursor.split('.') : [];
  const valid = (part) => part === CURSOR_FROM_NEWEST || part === CURSOR_DONE || core.isValidSolanaSignature(part);
  if (parts.length !== 2 || !parts.every(valid)) throw new WalletError('INVALID_PARAMS', { field: 'cursor' });
  return parts;
}

// One listing of `address` at confirmed, newest first, older than `before`: [{signature, slot, index}].
async function listSignatures(address, before, limit) {
  if (before === CURSOR_DONE) return [];
  const query = { limit, commitment: 'confirmed', ...(before === CURSOR_FROM_NEWEST ? {} : { before }) };
  const listed = await rpc('getSignaturesForAddress', [address, query]);
  if (!Array.isArray(listed)) throw unavailable();
  return listed.filter(isListed).map((entry, index) => ({ signature: entry.signature, slot: numberOrNull(entry.slot) ?? 0, index }));
}

// Where a listing goes on after `page`: its last entry the page took, in its own order (a later entry of the same slot
// the merge took first is listed again, never skipped); done when it gave all it had and the page took it all.
function nextBefore(list, before, page, limit) {
  const taken = new Set(page.map((entry) => entry.signature));
  let last = null;
  for (const entry of list) {
    if (!taken.has(entry.signature)) break;
    last = entry.signature;
  }
  if (list.length === 0 || (list.length < limit && last === list.at(-1).signature)) return CURSOR_DONE;
  return last ?? before;
}

const lamportsAt = (list, index) => {
  const value = Array.isArray(list) ? list[index] : null;
  return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
};

// The owner's 1DEV in a transaction's token balances (pre or post), summed over its accounts of the mint.
function oneDevOf(balances, owner) {
  let sum = 0n;
  for (const entry of Array.isArray(balances) ? balances : []) {
    const amount = entry?.uiTokenAmount?.amount;
    if (entry?.owner === owner && entry.mint === SOLANA.ONE_DEV_MINT && typeof amount === 'string' && /^[0-9]{1,20}$/.test(amount)) {
      sum += BigInt(amount);
    }
  }
  return sum;
}

// The owner of a token account a transaction's token balances name, else the account itself.
function tokenOwner(tx, keys, account) {
  const index = keys.indexOf(account);
  const entry = [...(tx.meta.postTokenBalances ?? []), ...(tx.meta.preTokenBalances ?? [])]
    .find((balance) => balance?.accountIndex === index && core.isValidSolanaAddress(balance.owner));
  return entry ? entry.owner : account;
}

// The wallet's own transfer in a transaction, as its parsed instructions show it: {asset, out, counterparty, amount}.
function ownTransfer(tx, keys, owner, ata) {
  const outer = Array.isArray(tx.transaction.message.instructions) ? tx.transaction.message.instructions : [];
  for (const ix of outer) {
    const info = ix?.parsed?.info;
    if (!info || typeof info !== 'object') continue;
    if (ix.program === 'system' && ix.parsed.type === 'transfer' && (info.source === owner || info.destination === owner)) {
      const out = info.source === owner;
      return { asset: 'sol', out, counterparty: out ? info.destination : info.source, amount: lamportsAt([info.lamports], 0) };
    }
    const token = TOKEN_PROGRAM_NAMES.includes(ix.program) && (ix.parsed.type === 'transfer' || ix.parsed.type === 'transferChecked');
    if (token && (info.source === ata || info.destination === ata)) {
      const out = info.source === ata;
      const raw = ix.parsed.type === 'transferChecked' ? info.tokenAmount?.amount : info.amount;
      return {
        asset: '1dev', out, counterparty: tokenOwner(tx, keys, out ? info.destination : info.source),
        amount: typeof raw === 'string' && /^[0-9]{1,20}$/.test(raw) ? BigInt(raw) : null,
      };
    }
  }
  return null;
}

/**
 * One transaction (getTransaction, jsonParsed) as a History row for `owner`: what its balances say moved for the wallet,
 * 1DEV first; a failed one shows what its own transfer asked to move. null for one that moved nothing for the wallet
 * and that it did not pay for (someone else's transaction that only names it), or one that does not read.
 * @param {string} signature
 * @param {object} tx
 * @param {string} owner
 * @param {string} ata the owner's 1DEV associated token account
 * @param {number|null} blockTime from the listing, when the transaction has none
 * @returns {SolanaHistoryItem|null}
 */
export function historyItem(signature, tx, owner, ata, blockTime = null) {
  const message = tx?.transaction?.message;
  if (!tx?.meta || !message || !Array.isArray(message.accountKeys)) return null;
  const keys = message.accountKeys.map((key) => (typeof key === 'string' ? key : key?.pubkey));
  const index = keys.indexOf(owner);
  const paid = keys[0] === owner;
  const fee = paid ? lamportsAt([tx.meta.fee], 0) : 0n;
  const pre = index >= 0 ? lamportsAt(tx.meta.preBalances, index) : 0n;
  const post = index >= 0 ? lamportsAt(tx.meta.postBalances, index) : 0n;
  if (fee === null || pre === null || post === null) return null;
  const failed = tx.meta.err !== null && tx.meta.err !== undefined;
  const outer = Array.isArray(message.instructions) ? message.instructions : [];
  const inner = (Array.isArray(tx.meta.innerInstructions) ? tx.meta.innerInstructions : [])
    .flatMap((group) => (Array.isArray(group?.instructions) ? group.instructions : []));
  const burn = !failed && outer.concat(inner)
    .some((ix) => isTokenBurn(ix) && ix.parsed.info?.mint === SOLANA.ONE_DEV_MINT && ix.parsed.info?.authority === owner);
  const tokens = oneDevOf(tx.meta.postTokenBalances, owner) - oneDevOf(tx.meta.preTokenBalances, owner);
  const lamports = post - pre + fee;
  const transfer = ownTransfer(tx, keys, owner, ata);
  let asset = tokens !== 0n || burn ? '1dev' : 'sol';
  const moved = asset === '1dev' ? tokens : lamports;
  let amount = moved < 0n ? -moved : moved;
  let direction = moved > 0n ? 'in' : 'out';
  if (moved === 0n) {
    // nothing moved for the wallet (a failed transaction, or one to itself): its own transfer says what it asked to move
    if (!paid) return null;
    direction = failed ? 'out' : 'self';
    if (transfer !== null && transfer.amount !== null) {
      asset = transfer.asset;
      amount = transfer.amount;
      if (failed && !transfer.out) direction = 'in';
    }
  }
  const counterparty = direction !== 'self' && !burn && transfer?.asset === asset && core.isValidSolanaAddress(transfer.counterparty)
    && transfer.counterparty !== owner ? transfer.counterparty : null;
  const time = numberOrNull(tx.blockTime) ?? blockTime;
  return {
    signature, asset, direction, counterparty, amountRaw: String(amount), feeLamports: paid ? String(fee) : null,
    timestamp: time === null || time <= 0 ? null : time * 1000, status: failed ? 'failed' : 'confirmed', burn,
  };
}

function keepRow(signature, row) {
  historyRows.delete(signature);
  historyRows.set(signature, row);
  while (historyRows.size > HISTORY_ROWS_MAX) historyRows.delete(historyRows.keys().next().value);
}

/**
 * Handler of `solana.history`: the wallet's Solana transactions, newest first, at confirmed: the listings of its own
 * address (SOL, and every transaction it signed) and of its 1DEV account (1DEV it received), merged by slot, each read
 * once (getTransaction; kept in worker memory, and seeded from the rows the session's view cache holds). `cursor`
 * from a previous page goes on below it.
 * @param {{cursor?: string|null, limit?: number}} [params] limit: 1..LIMITS.SOLANA_HISTORY_PAGE_MAX, default 10
 * @returns {Promise<{items: SolanaHistoryItem[], cursor: string|null}>}
 * @throws {WalletError} LOCKED, SOLANA_UNAVAILABLE, INVALID_PARAMS
 */
export async function getHistory(params = {}) {
  const { solanaAddress: owner } = await session.requireUnlocked();
  const limit = params?.limit ?? 10;
  const [ownerBefore, ataBefore] = historyCursor(params?.cursor ?? null);
  const ata = core.associatedTokenAddress(owner, SOLANA.ONE_DEV_MINT);
  for (const item of (await session.cachedViews())?.solanaHistory?.items ?? []) {
    if (!historyRows.has(item?.signature) && typeof item?.signature === 'string') keepRow(item.signature, item);
  }
  const [own, token] = await Promise.all([listSignatures(owner, ownerBefore, limit), listSignatures(ata, ataBefore, limit)]);
  const merged = new Map();
  for (const entry of [...own, ...token]) if (!merged.has(entry.signature)) merged.set(entry.signature, entry);
  const page = [...merged.values()].sort((a, b) => b.slot - a.slot).slice(0, limit);
  const unread = page.filter((entry) => !historyRows.has(entry.signature));
  for (let i = 0; i < unread.length; i += HISTORY_CONCURRENCY) {
    const batch = unread.slice(i, i + HISTORY_CONCURRENCY);
    const txs = await Promise.all(batch.map((entry) => rpc('getTransaction', [entry.signature,
      { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }])));
    for (const [j, entry] of batch.entries()) {
      // listed at confirmed and not readable yet: left out of this page, read again next time
      if (!txs[j]) continue;
      keepRow(entry.signature, historyItem(entry.signature, txs[j], owner, ata));
    }
  }
  const items = page.map((entry) => historyRows.get(entry.signature)).filter((row) => row !== undefined && row !== null);
  const next = [nextBefore(own, ownerBefore, page, limit), nextBefore(token, ataBefore, page, limit)];
  return { items, cursor: next.every((part) => part === CURSOR_DONE) ? null : next.join('.') };
}

// ---------------------------------------------------------------- burn matcher

// Token-2022 burns are counted too, so a transaction pairing one with a classic burn is not "one burn".
const TOKEN_PROGRAM_NAMES = ['spl-token', 'spl-token-2022'];
const isMemo = (ix) => ix && (ix.program === 'spl-memo' || MEMO_PROGRAMS.includes(ix.programId));
const isTokenBurn = (ix) => ix && ix.parsed && typeof ix.parsed === 'object'
  && (ix.parsed.type === 'burn' || ix.parsed.type === 'burnChecked')
  && (TOKEN_PROGRAM_NAMES.includes(ix.program) || ix.programId === TOKEN || ix.programId === TOKEN_2022);

/**
 * Port of mobile BurnMatcher.validateBurnTx: a jsonParsed finalized transaction is a node-activation
 * burn of `owner` only if meta.err is null, the wallet is fee payer and signer, there is exactly one
 * burn/burnChecked (classic Token program) of `mint` from the wallet's ATA with authority = wallet,
 * exactly one QNET_NODE_TYPE memo naming a node type, and a whole, positive 1DEV amount at the mint's
 * real decimals.
 * @param {object} tx getTransaction result (jsonParsed)
 * @param {{owner: string, signature?: string, mint?: string, ata?: string, decimals?: number}} expected
 *   mint defaults to SOLANA.ONE_DEV_MINT, ata to the owner's ATA of it, decimals to DECIMALS.ONE_DEV
 * @returns {{nodeType: 'light'|'super', amount: number}|null}
 */
export function validateBurnTx(tx, expected) {
  const { owner, signature, mint = SOLANA.ONE_DEV_MINT, decimals = DECIMALS.ONE_DEV } = expected ?? {};
  if (!core.isValidSolanaAddress(owner) || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) return null;
  if (!tx || !tx.meta || tx.meta.err !== null || !tx.transaction || !tx.transaction.message) return null;
  const { message } = tx.transaction;
  if (signature && !(Array.isArray(tx.transaction.signatures) && tx.transaction.signatures[0] === signature)) return null;

  const accounts = Array.isArray(message.accountKeys) ? message.accountKeys : [];
  const payer = accounts[0];
  if (!payer || payer.pubkey !== owner || payer.signer !== true) return null;

  const outer = Array.isArray(message.instructions) ? message.instructions : [];
  const inner = (Array.isArray(tx.meta.innerInstructions) ? tx.meta.innerInstructions : [])
    .flatMap((g) => (g && Array.isArray(g.instructions) ? g.instructions : []));
  const all = outer.concat(inner);

  const burns = all.filter(isTokenBurn);
  if (burns.length !== 1) return null;
  const [burn] = burns;
  const info = burn.parsed.info || {};
  if (burn.programId !== TOKEN) return null;
  if (info.mint !== mint || info.authority !== owner || info.multisigAuthority) return null;
  let ata = expected.ata;
  if (ata === undefined) {
    try {
      ata = core.associatedTokenAddress(owner, mint);
    } catch {
      return null;
    }
  }
  if (info.account !== ata) return null;

  let raw;
  if (burn.parsed.type === 'burnChecked') {
    const amount = info.tokenAmount || {};
    if (Number(amount.decimals) !== decimals) return null;
    raw = amount.amount;
  } else {
    raw = info.amount;
  }
  if (typeof raw !== 'string' || !/^[0-9]{1,20}$/.test(raw)) return null;
  const units = BigInt(raw);
  const one = 10n ** BigInt(decimals);
  if (units <= 0n || units % one !== 0n) return null;
  const whole = units / one;
  if (whole > BigInt(Number.MAX_SAFE_INTEGER)) return null;

  const memos = all.filter(isMemo).map((ix) => (typeof ix.parsed === 'string' ? ix.parsed : null));
  const typed = memos.filter((m) => m !== null && m.includes(NODE_TYPE_MEMO_PREFIX));
  if (typed.length !== 1 || !Object.hasOwn(MEMO_NODE_TYPES, typed[0])) return null;
  return { nodeType: MEMO_NODE_TYPES[typed[0]], amount: Number(whole) };
}

/**
 * Whether a jsonParsed transaction is a 1DEV burn of `owner` in any form (R4-ESA-01): it succeeded, the wallet is
 * fee payer and signer, and a Token-program burn of `mint` has the wallet as its authority, whatever its memo says
 * (such as 'QNET_NODE_TYPE:FULL') and from whichever token account of the wallet. The node counts such a burn for an
 * activation, as it
 * reads neither the memo nor the source account, so the one-activation guard counts it too, even where no Light or
 * Super code derives from it (validateBurnTx, the strict check a code needs).
 * @param {object} tx getTransaction result (jsonParsed)
 * @param {string} owner
 * @param {string} [mint] SOLANA.ONE_DEV_MINT
 * @returns {boolean}
 */
export function isOwnBurn(tx, owner, mint = SOLANA.ONE_DEV_MINT) {
  if (!tx || !tx.meta || tx.meta.err !== null || !tx.transaction || !tx.transaction.message) return false;
  const { message } = tx.transaction;
  const payer = Array.isArray(message.accountKeys) ? message.accountKeys[0] : null;
  if (!payer || payer.pubkey !== owner || payer.signer !== true) return false;
  const outer = Array.isArray(message.instructions) ? message.instructions : [];
  const inner = (Array.isArray(tx.meta.innerInstructions) ? tx.meta.innerInstructions : [])
    .flatMap((g) => (g && Array.isArray(g.instructions) ? g.instructions : []));
  return outer.concat(inner).some((ix) => isTokenBurn(ix) && ix.parsed.info?.mint === mint && ix.parsed.info?.authority === owner);
}

const numberOrNull = (value) => {
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isSafeInteger(n) ? n : null;
};

// ---------------------------------------------------------------- the search (port of mobile BurnMatcher)

// Version 3: the wallet's burns that yield no code are kept too (R4-ESA-01); a search of an earlier version dropped
// them as "not a burn", so it is listed again. (Version 2 made the range above the kept head resumable: R3-ESA-02.)
const SCAN_VERSION = 3;
// Candidates checked at once: fewer round trips per call, within what a public RPC allows one address (R4-ESA-03).
const CHECK_CONCURRENCY = 2;
const SIGNATURE_MAX_CHARS = 128;
// The seq space one range above the kept head may use: its entries are numbered from its base upwards as
// they are listed (newest first), all below every seq the search kept before (the mobile rule).
const RANGE_SEQ_SPAN = 1_000_000_000;
// The in-flight check at 'confirmed' (step 4): pages it may list before it fails closed, and its own time
// budget (it runs after steps 1-3 spent theirs).
const IN_FLIGHT_MAX_PAGES = 20;
const IN_FLIGHT_DEADLINE_MS = 30000;

const isCandidate = (s) => !!s && s.err == null && typeof s.memo === 'string' && s.memo.includes(NODE_TYPE_MEMO_PREFIX)
  && typeof s.signature === 'string' && s.signature.length > 0 && s.signature.length <= SIGNATURE_MAX_CHARS;
const isListed = (s) => !!s && typeof s.signature === 'string' && s.signature.length > 0 && s.signature.length <= SIGNATURE_MAX_CHARS;

// A listed entry as the search keeps it. `seq` is its place on one line over every listing of the search:
// the part below the kept tail counts up, a range above the kept head counts from its base (below every seq
// kept before) upwards as it lists, so a larger seq is always listed later, which within one slot means
// executed earlier (the listing runs newest first).
const candidateOf = (s, seq) => ({
  signature: s.signature, slot: numberOrNull(s.slot) ?? 0, seq, blockTime: numberOrNull(s.blockTime),
});

// Oldest first: by slot, then the listing order inside the slot (the later listed is the older). The
// RPC gives no position inside a slot (getSignaturesForAddress has no transactionIndex), and this order
// does not depend on whether a search was fresh or resumed (R2-ESA-03).
const oldestFirst = (a, b) => (a.slot - b.slot) || (b.seq - a.seq);

function freshScan(owner, mint, ata) {
  return {
    v: SCAN_VERSION, owner, mint, ata, head: null, tail: null, reachedStart: false, headSeq: 0, tailSeq: 0, range: null,
    unchecked: [], found: [], unusable: [],
  };
}

const isSeq = (value) => Number.isSafeInteger(value);
const isSignatureOrNull = (value) => value === null || (typeof value === 'string' && value.length > 0 && value.length <= SIGNATURE_MAX_CHARS);
const isKeptCandidate = (c) => c && typeof c === 'object' && typeof c.signature === 'string' && c.signature.length <= SIGNATURE_MAX_CHARS
  && Number.isSafeInteger(c.slot) && c.slot >= 0 && isSeq(c.seq) && (c.blockTime === null || Number.isSafeInteger(c.blockTime));

// A range above the kept head that is being listed: {top, before, base, count}: the newest signature when it
// started, the cursor to go on from, and the seq numbering of what it listed so far.
const isRange = (r) => r === null || (!!r && typeof r === 'object' && isSignatureOrNull(r.top) && isSignatureOrNull(r.before)
  && isSeq(r.base) && Number.isSafeInteger(r.count) && r.count >= 0 && r.count < RANGE_SEQ_SPAN);

// A kept search for exactly this (owner, mint, listed address), or null. The listed address (kept as `ata`) is the
// owner's 1DEV associated account, or for a search of the transactions it signed the owner itself. The listing never
// keeps more than LIMITS.BURN_SCAN_MAX_UNCHECKED candidates waiting (it pauses mid-page), so a longer list is not ours.
function validScan(s, owner, mint, ata) {
  if (!s || typeof s !== 'object' || s.v !== SCAN_VERSION || s.owner !== owner || s.mint !== mint || s.ata !== ata) return null;
  if (typeof s.reachedStart !== 'boolean' || !isSeq(s.headSeq) || !isSeq(s.tailSeq) || s.headSeq > 0 || s.tailSeq < 0) return null;
  if (!isSignatureOrNull(s.head) || !isSignatureOrNull(s.tail) || !isRange(s.range)) return null;
  if (!Array.isArray(s.unchecked) || s.unchecked.length > LIMITS.BURN_SCAN_MAX_UNCHECKED || !s.unchecked.every(isKeptCandidate)) return null;
  if (!Array.isArray(s.found) || s.found.length > LIMITS.BURN_SCAN_MAX_UNCHECKED || !s.found.every((b) => isKeptCandidate(b)
    && core.ACTIVATION_NODE_TYPES.includes(b.nodeType) && Number.isSafeInteger(b.amount) && b.amount > 0)) return null;
  if (!Array.isArray(s.unusable) || s.unusable.length > LIMITS.BURN_SCAN_MAX_UNCHECKED || !s.unusable.every(isKeptCandidate)) return null;
  return s;
}

/**
 * This wallet's node-activation burns, found in the history of its 1DEV associated token account (every
 * genuine burn writes to it, so its set of genuine burns is the wallet's; the wallet's SOL traffic and dust
 * sent to it are not listed). Port of mobile BurnMatcher.findWalletBurns (R2-ESA-02, R3-ESA-01..03): no fixed
 * page or candidate cap decides the answer. One call lists and checks within LIMITS.BURN_SCAN_DEADLINE_MS and
 * LIMITS.BURN_SCAN_MAX_PAGES; given a `store` it keeps what it listed and checked (the finalized part of a
 * history never changes) and the next call resumes there: the range added above the kept head since the last
 * call is listed resumably (its top, cursor and candidates are kept), and the listing pauses mid-page, never
 * skips, while LIMITS.BURN_SCAN_MAX_UNCHECKED candidates wait. `canonical` is the OLDEST valid burn, set only
 * once the listing reached the start of the history and no candidate older than it is still unchecked (a
 * burn inside an open range above the head is never canonical); `complete`: every candidate of the whole
 * history was listed and checked (then no burn exists when `burns` is empty); `listingComplete`: the whole
 * history was listed; `exhausted`: the budget ended the search before either was known (HISTORY_TOO_LONG for
 * the caller, apart from a Solana that could not be read). With `confirmed`, `inFlight` lists the valid burns
 * this search's finalized snapshot does not hold: the listing at 'confirmed' is paged newest first down to the
 * kept head (or the open range's top), and every valid burn there that the snapshot has not found is in
 * flight, confirmed but not final or finalized after the snapshot was listed; a check that cannot reach that
 * point fails closed (XP-R3-01, as mobile XP-R2-04). `unusable`: the wallet's own 1DEV burns among the candidates
 * that yield no Light or Super code (isOwnBurn: another memo such as 'QNET_NODE_TYPE:FULL'), finalized or in
 * flight; the node counts them for an activation, so every caller refuses a new burn on them (R4-ESA-01).
 * Candidates are checked CHECK_CONCURRENCY at a time (R4-ESA-03). With `signed` (findSignedBurns) the history listed
 * is the owner's own address instead: see there.
 * @param {string} owner
 * @param {{rpc?: typeof rpc, now?: () => number, spacingMs?: number, store?: {load: () => Promise<object|null>,
 *   save: (state: object) => Promise<void>}|null, confirmed?: boolean, maxPages?: number, deadlineMs?: number,
 *   maxUnchecked?: number, inFlightMaxPages?: number, inFlightDeadlineMs?: number, pageSize?: number,
 *   signed?: boolean}} [options] rpc, now, spacingMs, the limits and the page size are injectable for tests
 * @returns {Promise<{burns: BurnMatch[], canonical: BurnMatch|null, complete: boolean, listingComplete: boolean,
 *   exhausted: boolean, reachedStart: boolean, oldestUnchecked: {slot: number}|null, inFlight: BurnMatch[],
 *   unusable: Array<{signature: string, slot: number|null, blockTime: number|null, finalized: boolean}>}>}
 * @throws {WalletError} SOLANA_UNAVAILABLE (history unreadable, or the in-flight check could not read far
 *   enough: never reported as "no burn"); HISTORY_TOO_LONG when the in-flight check ran out of time;
 *   INVALID_ADDRESS
 */
export async function findWalletBurns(owner, options = {}) {
  const {
    rpc: call = rpc, now = Date.now, spacingMs = SCAN_SPACING_MS, store = null, confirmed = false,
    maxPages = LIMITS.BURN_SCAN_MAX_PAGES, deadlineMs = LIMITS.BURN_SCAN_DEADLINE_MS,
    maxUnchecked = LIMITS.BURN_SCAN_MAX_UNCHECKED, inFlightMaxPages = IN_FLIGHT_MAX_PAGES,
    inFlightDeadlineMs = IN_FLIGHT_DEADLINE_MS, pageSize = LIMITS.BURN_SCAN_PAGE_SIZE, signed = false,
  } = options;
  assertAddress(owner);
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > LIMITS.BURN_SCAN_PAGE_SIZE) throw new WalletError('INTERNAL');
  const deadline = now() + deadlineMs;
  const mint = SOLANA.ONE_DEV_MINT;
  const decimals = await mintDecimals(call);
  const ata = core.associatedTokenAddress(owner, mint);
  // the address whose history is listed: the 1DEV associated account, or the owner for the burns it signed
  const listedAddress = signed === true ? owner : ata;

  let state = null;
  if (store) {
    try {
      state = validScan(await store.load(), owner, mint, listedAddress);
    } catch (error) {
      if (error instanceof WalletError && error.code === 'LOCKED') throw error;
      state = null;
    }
  }
  if (state === null) state = freshScan(owner, mint, listedAddress);
  const save = async () => {
    if (!store) return;
    try {
      await store.save(structuredClone(state));
    } catch {
      // the next call lists again from what was kept before
    }
  };

  let pages = 0;
  let exhausted = false;
  const budgetLeft = () => {
    if (pages >= maxPages || now() >= deadline) {
      exhausted = true;
      return false;
    }
    return true;
  };
  const list = async (query) => {
    pages += 1;
    const listed = await call('getSignaturesForAddress', [listedAddress, { limit: pageSize, commitment: 'finalized', ...query }]);
    if (!Array.isArray(listed)) throw unavailable();
    return listed;
  };
  // Whether one more candidate may wait; the listing pauses before the entry that does not fit (R3-ESA-01).
  const room = () => state.unchecked.length < maxUnchecked;

  // 1. What was added above the kept head since the last call (R3-ESA-02, as mobile MOBACT-R2-01): listed newest
  // first from the top down to the head, resumably. The range's top, its cursor and the candidates it listed are
  // kept, so a range longer than one call's budget goes on where it stopped instead of starting again from the
  // newest signature. Its candidates join `unchecked` as they are listed; the head moves to the range's top only
  // once the range reached it.
  if (state.head !== null || state.reachedStart) {
    state.range ??= { top: null, before: null, base: state.headSeq - RANGE_SEQ_SPAN, count: 0 };
    const r = state.range;
    let reachedHead = false;
    let paused = false;
    while (!paused && room() && budgetLeft()) {
      const query = {};
      if (state.head !== null) query.until = state.head;
      if (r.before !== null) query.before = r.before;
      const listed = await list(query);
      if (r.top === null) r.top = isListed(listed[0]) ? listed[0].signature : state.head;
      for (const s of listed) {
        if (!isListed(s)) throw unavailable();
        if (isCandidate(s)) {
          if (!room()) {
            paused = true;
            break;
          }
          r.count += 1;
          state.unchecked.push(candidateOf(s, r.base + r.count));
        }
        r.before = s.signature;
      }
      if (!paused && listed.length < pageSize) {
        reachedHead = true;
        break;
      }
      await save();
    }
    if (reachedHead) {
      // closed: everything between the old head and the range's top is kept; the next range numbers below it
      // (a range that took in nothing leaves the numbering where it was)
      if (r.top !== null) state.head = r.top;
      if (r.count > 0) state.headSeq = r.base;
      state.range = null;
    } else {
      exhausted = true;
      // nothing of it was taken in yet: the next call starts it again from the newest signature
      if (r.before === null) state.range = null;
    }
    await save();
  }
  const rangeOpen = state.range !== null;

  // 2. Older history below the kept tail, back to the start, while there is room to keep what it lists; it
  // pauses mid-page at the candidate that does not fit, so the tail is always the last entry taken in.
  let tailPaused = false;
  while (!state.reachedStart && !tailPaused && room() && budgetLeft()) {
    const listed = await list(state.tail !== null ? { before: state.tail } : {});
    if (state.head === null) state.head = isListed(listed[0]) ? listed[0].signature : null;
    for (const s of listed) {
      if (!isListed(s)) throw unavailable();
      if (isCandidate(s)) {
        if (!room()) {
          tailPaused = true;
          break;
        }
        state.tailSeq += 1;
        state.unchecked.push(candidateOf(s, state.tailSeq));
      }
      state.tail = s.signature;
    }
    if (!tailPaused && listed.length < pageSize) state.reachedStart = true;
    await save();
  }
  if (!state.reachedStart && !room()) exhausted = true;

  // 3. Candidates, oldest first, CHECK_CONCURRENCY at a time. A listed, finalized transaction the RPC cannot serve
  // is unknown, not invalid: skipping it could elect a newer burn as the wallet's first. The wallet's own burns that
  // yield no code are kept apart (R4-ESA-01).
  state.unchecked.sort(oldestFirst);
  let checked = 0;
  let batches = 0;
  while (state.unchecked.length > 0) {
    if (now() >= deadline) {
      exhausted = true;
      break;
    }
    if (batches > 0 && spacingMs > 0) await sleep(spacingMs);
    batches += 1;
    const batch = state.unchecked.slice(0, CHECK_CONCURRENCY);
    const txs = await Promise.all(batch.map((candidate) => call('getTransaction', [candidate.signature,
      { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 }])));
    for (const [i, candidate] of batch.entries()) {
      const tx = txs[i];
      if (!tx) {
        await save();
        throw unavailable();
      }
      checked += 1;
      const kept = {
        signature: candidate.signature,
        slot: numberOrNull(tx.slot) ?? candidate.slot,
        seq: candidate.seq,
        blockTime: numberOrNull(tx.blockTime) ?? candidate.blockTime,
      };
      const match = validateBurnTx(tx, { owner, signature: candidate.signature, mint, ata, decimals });
      if (match) state.found.push({ ...kept, nodeType: match.nodeType, amount: match.amount });
      else if (tx.transaction?.signatures?.[0] === candidate.signature && isOwnBurn(tx, owner, mint)) state.unusable.push(kept);
      state.unchecked.shift();
      if (checked % 25 === 0) await save();
    }
  }
  await save();

  const found = [...state.found].sort(oldestFirst);
  const burns = found.map((b) => ({
    signature: b.signature, nodeType: b.nodeType, amount: b.amount, slot: b.slot, blockTime: b.blockTime, finalized: true,
  }));
  const listingComplete = state.reachedStart && !rangeOpen;
  const complete = listingComplete && state.unchecked.length === 0;
  // While a range above the head is open, what it has not listed yet lies between its cursor and the head, so
  // only a burn below the head (numbered above the range) can be the first.
  const oldest = found[0] ?? null;
  const inOpenRange = (b) => rangeOpen && b.seq > state.range.base && b.seq <= state.range.base + state.range.count;
  const canonical = state.reachedStart && oldest !== null && !inOpenRange(oldest)
    && !state.unchecked.some((c) => oldestFirst(c, oldest) < 0) ? burns[0] : null;
  const oldestUnchecked = state.unchecked.length === 0 ? null : { slot: state.unchecked[0].slot };
  const unusable = [...state.unusable].sort(oldestFirst)
    .map((b) => ({ signature: b.signature, slot: b.slot, blockTime: b.blockTime, finalized: true }));

  // 4. A burn this finalized snapshot does not hold yet: the listing at 'confirmed', newest first, down to the
  // kept head (below it everything is in the snapshot), or to the open range's top (below it the search is
  // incomplete, and every caller refuses a burn on an incomplete search anyway). Every valid burn there that
  // the snapshot has not found or queued is in flight, whatever its confirmationStatus: a burn that finalized
  // after steps 1-3 read the finalized history is counted too. When the search is complete, a check that cannot
  // reach that point fails closed; when it is not, what the check did read is answered (the caller refuses a
  // burn either way, and a burn seen in flight still says `pending`).
  const inFlight = [];
  if (confirmed) {
    const stop = rangeOpen && state.range.top !== null ? state.range.top : state.head;
    const known = new Set([...found.map((b) => b.signature), ...state.unusable.map((b) => b.signature),
      ...state.unchecked.map((c) => c.signature)]);
    const inFlightDeadline = now() + inFlightDeadlineMs;
    let before = null;
    let reachedStop = false;
    let outOfTime = false;
    for (let page = 0; page < inFlightMaxPages && !reachedStop && !outOfTime; page++) {
      const recent = await call('getSignaturesForAddress', [listedAddress, { limit: pageSize, commitment: 'confirmed', ...(before !== null ? { before } : {}) }]);
      if (!Array.isArray(recent)) throw unavailable();
      for (const s of recent) {
        if (!isListed(s)) throw unavailable();
        if (stop !== null && s.signature === stop) {
          reachedStop = true;
          break;
        }
        before = s.signature;
        if (!isCandidate(s) || known.has(s.signature)) continue;
        if (now() >= inFlightDeadline) {
          if (complete) throw new WalletError('HISTORY_TOO_LONG');
          outOfTime = true;
          break;
        }
        const tx = await call('getTransaction', [s.signature,
          { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
        if (!tx) throw unavailable();
        const match = validateBurnTx(tx, { owner, signature: s.signature, mint, ata, decimals });
        const slot = numberOrNull(tx.slot) ?? numberOrNull(s.slot);
        const blockTime = numberOrNull(tx.blockTime) ?? numberOrNull(s.blockTime);
        if (match) {
          inFlight.push({ signature: s.signature, nodeType: match.nodeType, amount: match.amount, slot, blockTime, finalized: false });
        } else if (tx.transaction?.signatures?.[0] === s.signature && isOwnBurn(tx, owner, mint)) {
          unusable.push({ signature: s.signature, slot, blockTime, finalized: false });
        }
      }
      // the start of the history
      if (!reachedStop && !outOfTime && recent.length < pageSize) reachedStop = true;
    }
    if (!reachedStop && complete) throw unavailable();
  }

  return {
    burns,
    canonical,
    complete,
    listingComplete,
    exhausted: exhausted && canonical === null && !complete,
    reachedStart: state.reachedStart,
    oldestUnchecked,
    inFlight,
    unusable,
  };
}

/**
 * The wallet's own 1DEV burns in any form and from any of its token accounts (R4-ESA-01, R5-ESA-01), found through
 * the transactions it signed: isOwnBurn needs the wallet as fee payer, signer and burn authority, so every such
 * transaction lists in the history of the owner's own address, whichever token account it burned from (a closed one
 * too), and nobody else can put a transaction there the wallet signed. Anyone can add token accounts the owner field
 * names, or transactions that merely mention the address, so this lists no token accounts and caps no count: it is
 * findWalletBurns over the owner's own address, with the same kept, resumable search and time budget (its own store,
 * vault kind 'signed'), and a flood slows it without stopping it: every call goes on where the last one stopped, and
 * only entries tagged with a node-type memo are fetched at all. `unusable` holds the burns no Light or Super code
 * derives from ('QNET_NODE_TYPE:FULL', or a burn from an account other than the associated one); the node
 * counts them for an activation, so a caller refuses a new burn on one, and on a search not complete yet.
 * @param {string} owner
 * @param {object} [options] as findWalletBurns
 * @returns {ReturnType<typeof findWalletBurns>}
 * @throws {WalletError} as findWalletBurns
 */
export function findSignedBurns(owner, options = {}) {
  return findWalletBurns(owner, { ...options, signed: true });
}
