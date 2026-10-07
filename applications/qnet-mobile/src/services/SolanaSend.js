/**
 * Sending SOL and the Solana tokens the wallet lists, from the wallet's Solana address (the key of the same recovery
 * phrase on m/44'/501'/0'/0'). Reads go to the Solana RPC endpoint the balances use (config/nodes); the transaction is
 * built in crypto/SolanaTx and signed by WalletManager.signSolanaMessage, after the review and the fresh check the
 * screen asks for.
 *
 * quoteSolanaSend reads what the send needs and refuses, with a code the screen says in the user's language, anything
 * the network would refuse: an amount the wallet does not hold, too little SOL for the network fee (and for the
 * recipient's token account, which the sender pays when a token goes to an address that never held it), a remainder
 * below the minimum an account keeps, a first payment below that minimum to an address with no SOL, a token recipient
 * that is not a wallet address. submitSolanaSend takes a fresh blockhash, has the message signed and sends it; a
 * blockhash the network no longer knows is replaced and signed once more, unless an attempt before went unanswered. A
 * send nobody answered is not a refusal: its signature is known before it is sent, so its outcome is read by that
 * signature until its blockhash expires, after which it can never land.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Buffer } from 'buffer';
import { getSolanaRpcUrl, rotateSolanaRpc, ONE_DEV_MINT } from '../config/nodes';
import { parseStrictJson } from '../utils/strictJson';
import {
  SOL_DECIMALS, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_ACCOUNT_SIZE,
  associatedTokenAddress, base58Encode, decodeKey, fromBaseUnits, isOnCurve, serializeTransaction, toBaseUnits,
  transferMessage,
} from '../crypto/SolanaTx';

/** The Solana side of the wallet: SOL and the token rows the Assets list shows. A mint's decimals never change. */
export const SOLANA_TOKENS = Object.freeze([
  Object.freeze({ symbol: 'SOL', mint: null, decimals: SOL_DECIMALS }),
  Object.freeze({ symbol: '1DEV', mint: ONE_DEV_MINT, decimals: 6 }),
]);

export const solanaToken = (symbol) => SOLANA_TOKENS.find((tk) => tk.symbol === symbol) || null;

// The fee of a one-signature transaction with no priority fee, shown on the form before the exact one is read.
export const BASE_FEE_LAMPORTS = 5000n;

const MAX_ANSWER_CHARS = 512 * 1024;
const RPC_TIMEOUT_MS = 8000;

const fail = (code, params) => Object.assign(new Error(code), { code, params });
const sol = (lamports) => `${fromBaseUnits(BigInt(lamports), SOL_DECIMALS)} SOL`;

// ── RPC ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One JSON-RPC call. An error the endpoint answered is thrown with `rpcError` (it saw the request and refused it), and
 * with `afterUnanswered` when an attempt before it got no answer (that attempt may still have been taken); no answer, a
 * rate limit or an unreadable body are tried once more on the next endpoint and then thrown as SOL_RPC with
 * `unanswered`. Integers above 2^53 come back as their decimal text (utils/strictJson).
 */
export async function solanaRpc(method, params) {
  let last = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const url = attempt === 0 ? getSolanaRpcUrl() : rotateSolanaRpc();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: controller.signal,
      });
      const text = await resp.text();
      if (text.length > MAX_ANSWER_CHARS) throw new Error('answer too large');
      const body = resp.status === 429 ? null : parseStrictJson(text);
      if (body && body.error && typeof body.error === 'object') {
        const message = typeof body.error.message === 'string' ? body.error.message : 'error';
        throw Object.assign(new Error(message), {
          rpcError: true, rpcCode: body.error.code, data: body.error.data, afterUnanswered: last !== null,
        });
      }
      if (!resp.ok || !body || !('result' in body)) throw new Error(`HTTP ${resp.status}`);
      return body.result;
    } catch (e) {
      if (e && e.rpcError) throw e;
      last = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw Object.assign(new Error((last && last.message) || 'Solana RPC unavailable'), { code: 'SOL_RPC', unanswered: true });
}

// Every read below: a refusal or no answer both mean nothing can be decided, so nothing is signed.
const read = (method, params) => solanaRpc(method, params).catch((e) => {
  throw Object.assign(fail('SOL_RPC'), { cause: e });
});

const lamportsOf = (v) => {
  const s = String(v == null ? '' : v);
  if (!/^\d{1,20}$/.test(s)) throw fail('SOL_RPC');
  return BigInt(s);
};

async function balanceOf(address) {
  const r = await read('getBalance', [address, { commitment: 'confirmed' }]);
  return lamportsOf(r && r.value);
}

async function rentExempt(size) {
  return lamportsOf(await read('getMinimumBalanceForRentExemption', [size, { commitment: 'confirmed' }]));
}

async function accountInfo(address) {
  const r = await read('getAccountInfo', [address, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  if (!r || typeof r !== 'object' || !('value' in r)) throw fail('SOL_RPC');
  return r.value || null;
}

async function latestBlockhash() {
  const r = await read('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const v = r && r.value;
  const height = v ? Number(v.lastValidBlockHeight) : NaN;
  if (!v || !decodeKey(v.blockhash) || !Number.isSafeInteger(height)) throw fail('SOL_RPC');
  return { blockhash: v.blockhash, lastValidBlockHeight: height };
}

const parsedInfo = (account, type) => {
  const parsed = account && account.data && typeof account.data === 'object' ? account.data.parsed : null;
  return parsed && parsed.type === type && parsed.info && typeof parsed.info === 'object' ? parsed.info : null;
};

/**
 * The token account of `owner` for `mint` a transfer spends from, picked from a getTokenAccountsByOwner list: its
 * associated account when that holds `need`, else the fullest initialized account the Token program keeps for this
 * owner and mint. { address, amount } or null. The Assets figure, MAX and the send all use this one rule.
 */
export function heldTokenAccount(list, owner, mint, need) {
  const ata = associatedTokenAddress(owner, mint);
  const accounts = [];
  for (const entry of Array.isArray(list) ? list : []) {
    const info = parsedInfo(entry && entry.account, 'account');
    const amount = info && info.tokenAmount && info.tokenAmount.amount;
    if (!info || entry.account.owner !== TOKEN_PROGRAM_ID || !decodeKey(entry.pubkey) || info.mint !== mint
      || info.owner !== owner || info.state !== 'initialized' || !/^\d{1,20}$/.test(String(amount))) continue;
    accounts.push({ address: entry.pubkey, amount: BigInt(amount) });
  }
  const own = accounts.find((a) => a.address === ata);
  if (own && need !== null && own.amount >= need) return own;
  return accounts.reduce((best, a) => (!best || a.amount > best.amount ? a : best), null);
}

const tokenAccountsOf = (owner, mint) => read('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);

// A result with no account list is a read that failed (SOL_RPC), never "no token accounts": heldTokenBase reads it the
// same way, so a refusal never states a balance the Assets figure does not show.
async function sourceAccount(owner, mint, need) {
  const r = await tokenAccountsOf(owner, mint);
  if (!r || typeof r !== 'object' || !Array.isArray(r.value)) throw fail('SOL_RPC');
  return heldTokenAccount(r.value, owner, mint, need);
}

/**
 * How much of `mint` a send from `owner` can move now, in base units (a BigInt): the account heldTokenAccount picks
 * with no amount in mind, read at 'confirmed' like the quote. 0n when no account qualifies; throws SOL_RPC or
 * SOL_ADDRESS when it cannot be read, so a caller keeps the figure it had.
 */
export async function heldTokenBase(owner, mint) {
  if (!decodeKey(owner) || !decodeKey(mint)) throw fail('SOL_ADDRESS');
  const r = await tokenAccountsOf(owner, mint);
  if (!r || typeof r !== 'object' || !Array.isArray(r.value)) throw fail('SOL_RPC');
  const held = heldTokenAccount(r.value, owner, mint, null);
  return held ? held.amount : 0n;
}

// ── Quote ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Everything one send needs, read now: { symbol, mint, decimals, from, to, amountBase, amountText, feeLamports,
 * rentLamports, createDestination, source, destination, references, memo, balanceLamports } (amounts as decimal text).
 * Throws a coded error (err_<code> in the tables) when the network would refuse it or when it cannot be read.
 * `request`: what a scanned payment request asks the transfer to hold for this recipient ({ references, memo }).
 */
export async function quoteSolanaSend({ from, to, symbol, amount, request = null }) {
  const token = solanaToken(symbol);
  if (!token) throw fail('SOL_TOKEN_UNSUPPORTED');
  if (!decodeKey(from)) throw fail('SOL_ADDRESS');
  const recipient = String(to || '').trim();
  const recipientKey = decodeKey(recipient);
  if (!recipientKey) throw fail('SOL_ADDRESS');
  const amountBase = toBaseUnits(amount, token.decimals); // INVALID_AMOUNT / AMOUNT_DECIMALS
  const references = request && Array.isArray(request.references) ? request.references.filter((r) => decodeKey(r)) : [];
  const memo = request && typeof request.memo === 'string' && request.memo ? request.memo : null;

  const base = {
    symbol: token.symbol, mint: token.mint, decimals: token.decimals, from, to: recipient,
    amountBase: amountBase.toString(), amountText: fromBaseUnits(amountBase, token.decimals), references, memo,
  };

  let plan;
  let rent = 0n;
  let checks;
  if (!token.mint) {
    const [balance, recipientBalance, minimum] = await Promise.all([balanceOf(from), balanceOf(recipient), rentExempt(0)]);
    plan = { kind: 'sol', from, to: recipient, amount: amountBase, references, memo };
    checks = { balance, minimum, recipientBalance };
  } else {
    // A token goes to the recipient's associated account: the recipient must be a wallet address (a key's point on
    // the curve), and not an account of a token program or a program itself, whose associated account nobody could
    // ever spend from.
    if (!isOnCurve(recipientKey)) throw fail('SOL_NOT_WALLET');
    const destination = associatedTokenAddress(recipient, token.mint);
    const [mintInfo, recipientInfo, destinationInfo, source, balance, minimum, accountRent] = await Promise.all([
      accountInfo(token.mint), accountInfo(recipient), accountInfo(destination), sourceAccount(from, token.mint, amountBase),
      balanceOf(from), rentExempt(0), rentExempt(TOKEN_ACCOUNT_SIZE),
    ]);
    const mint = parsedInfo(mintInfo, 'mint');
    if (!mintInfo || mintInfo.owner !== TOKEN_PROGRAM_ID || !mint || Number(mint.decimals) !== token.decimals) {
      throw fail('SOL_TOKEN_UNSUPPORTED');
    }
    if (recipientInfo && (recipientInfo.executable === true
      || [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].includes(recipientInfo.owner))) throw fail('SOL_NOT_WALLET');
    if (destinationInfo) {
      const held = parsedInfo(destinationInfo, 'account');
      if (destinationInfo.owner !== TOKEN_PROGRAM_ID || !held || held.mint !== token.mint || held.owner !== recipient) {
        throw fail('SOL_NOT_WALLET');
      }
    }
    const heldBase = source ? source.amount : 0n;
    if (!source || heldBase < amountBase) {
      throw fail('SOL_SHORT_TOKEN', {
        need: `${base.amountText} ${token.symbol}`, balance: `${fromBaseUnits(heldBase, token.decimals)} ${token.symbol}`,
      });
    }
    rent = destinationInfo ? 0n : accountRent;
    plan = {
      kind: 'token', from, to: recipient, mint: token.mint, decimals: token.decimals, amount: amountBase,
      source: source.address, destination, createDestination: !destinationInfo, references, memo,
    };
    checks = { balance, minimum };
  }

  // The exact fee of this very message, as the network charges it.
  const { blockhash } = await latestBlockhash();
  const message = transferMessage(plan, blockhash);
  const feeAnswer = await read('getFeeForMessage', [Buffer.from(message).toString('base64'), { commitment: 'confirmed' }]);
  const fee = feeAnswer && feeAnswer.value !== null && feeAnswer.value !== undefined ? lamportsOf(feeAnswer.value) : BASE_FEE_LAMPORTS;

  // What must be there before it runs, and what stays after it: a transfer back to the same address moves nothing.
  const spent = (plan.kind === 'sol' ? amountBase : 0n) + fee + rent;
  const self = recipient === from;
  const left = checks.balance - spent + (plan.kind === 'sol' && self ? amountBase : 0n);
  if (checks.balance < spent) {
    if (plan.kind === 'sol') throw fail('SOL_SHORT_SOL', { need: sol(spent), fee: sol(fee), balance: sol(checks.balance) });
    if (rent > 0n) throw fail('SOL_SHORT_FEE_ACCOUNT', { need: sol(spent), account: sol(rent), balance: sol(checks.balance) });
    throw fail('SOL_SHORT_FEE', { need: sol(spent), balance: sol(checks.balance) });
  }
  // An account keeps at least the rent-exempt minimum, or nothing at all.
  if (left > 0n && left < checks.minimum) {
    throw fail(plan.kind === 'sol' ? 'SOL_REMAINDER' : 'SOL_REMAINDER_FEE', { left: sol(left), min: sol(checks.minimum) });
  }
  if (plan.kind === 'sol' && !self && checks.recipientBalance === 0n && amountBase < checks.minimum) {
    throw fail('SOL_NEW_ACCOUNT_MIN', { min: sol(checks.minimum) });
  }

  return {
    ...base,
    feeLamports: fee.toString(),
    rentLamports: rent.toString(),
    createDestination: plan.kind === 'token' ? plan.createDestination : false,
    source: plan.kind === 'token' ? plan.source : null,
    destination: plan.kind === 'token' ? plan.destination : null,
    balanceLamports: checks.balance.toString(),
  };
}

/** The transfer plan (crypto/SolanaTx transferInstructions) of a quote. */
export function planOf(quote) {
  if (!quote.mint) {
    return { kind: 'sol', from: quote.from, to: quote.to, amount: BigInt(quote.amountBase), references: quote.references, memo: quote.memo };
  }
  return {
    kind: 'token', from: quote.from, to: quote.to, mint: quote.mint, decimals: quote.decimals, amount: BigInt(quote.amountBase),
    source: quote.source, destination: quote.destination, createDestination: quote.createDestination,
    references: quote.references, memo: quote.memo,
  };
}

/** The most the form's MAX may put in for `symbol`, as decimal text, read now: all SOL but the fee, or the token held. */
export async function maxSendable(owner, symbol) {
  const token = solanaToken(symbol);
  if (!token) return null;
  if (!token.mint) {
    const balance = await balanceOf(owner);
    return fromBaseUnits(balance > BASE_FEE_LAMPORTS ? balance - BASE_FEE_LAMPORTS : 0n, SOL_DECIMALS);
  }
  return fromBaseUnits(await heldTokenBase(owner, token.mint), token.decimals);
}

// ── Submit and outcome ──────────────────────────────────────────────────────────────────────────────────────────────

const blockhashGone = (e) => {
  const err = e && e.data && e.data.err;
  return err === 'BlockhashNotFound' || /blockhash not found/i.test(String((e && e.message) || ''));
};

// The endpoint already holds this very transaction (the same signature): it is on its way, not refused.
const alreadyProcessed = (e) => {
  const err = e && e.data && e.data.err;
  return err === 'AlreadyProcessed' || /already been processed/i.test(String((e && e.message) || ''));
};

// The endpoint's own words about a refusal, short.
const refusalDetail = (e) => String((e && e.message) || '').replace(/\s+/g, ' ').trim().slice(0, 160);

/**
 * Signs and sends a quoted transfer. `sign(message)` resolves with the 64-byte signature of the message (the wallet
 * signs only after the review and the fresh check). Resolves { status: 'pending' | 'unknown', signature,
 * lastValidBlockHeight }: 'unknown' when no endpoint answered, so the send may or may not have reached the network, and
 * also when a refusal came only after an attempt nobody answered: that attempt may have been taken, so the transfer is
 * never signed again then, and its signature settles it. Throws SOL_RPC when nothing was signed (no blockhash could be
 * read) and SOL_REFUSED when the network refused it.
 */
export async function submitSolanaSend(quote, sign) {
  const plan = planOf(quote);
  for (let attempt = 0; attempt < 2; attempt++) {
    const { blockhash, lastValidBlockHeight } = await latestBlockhash();
    const message = transferMessage(plan, blockhash);
    const signature = await sign(message);
    if (!(signature instanceof Uint8Array) || signature.length !== 64) throw new Error('The Solana signature is invalid');
    const wire = serializeTransaction(signature, message);
    const id = base58Encode(signature);
    try {
      await solanaRpc('sendTransaction', [Buffer.from(wire).toString('base64'), {
        encoding: 'base64', preflightCommitment: 'confirmed',
      }]);
      // A transaction's id is its first signature: the one computed here, whatever the endpoint echoed.
      return { status: 'pending', signature: id, lastValidBlockHeight };
    } catch (e) {
      if (!e || !e.rpcError) return { status: 'unknown', signature: id, lastValidBlockHeight };
      if (alreadyProcessed(e)) return { status: 'pending', signature: id, lastValidBlockHeight };
      if (e.afterUnanswered) return { status: 'unknown', signature: id, lastValidBlockHeight };
      if (blockhashGone(e) && attempt === 0) continue;
      throw fail('SOL_REFUSED', { detail: refusalDetail(e) });
    }
  }
  throw fail('SOL_REFUSED', { detail: 'Blockhash not found' });
}

/**
 * Where a sent transfer stands: 'confirmed', 'failed' (the network ran it and it failed), 'expired' (its blockhash is
 * past and the network never ran it: it never will), or 'pending'. Throws when the endpoint cannot be read.
 */
export async function solanaSendStatus(signature, lastValidBlockHeight) {
  const statusOf = async (history) => {
    const r = await solanaRpc('getSignatureStatuses', [[signature], { searchTransactionHistory: history }]);
    return r && Array.isArray(r.value) ? r.value[0] || null : null;
  };
  // Only a confirmed outcome is final: a run seen at 'processed' may belong to a fork that is dropped, and the
  // transaction can still land, with another result, on the one that stays.
  const verdict = (s) => {
    if (!s) return null;
    if (s.confirmationStatus !== 'confirmed' && s.confirmationStatus !== 'finalized') return 'pending';
    return s.err ? 'failed' : 'confirmed';
  };
  const recent = verdict(await statusOf(false));
  if (recent) return recent;
  if (!Number.isSafeInteger(lastValidBlockHeight)) return 'pending';
  const height = Number(await solanaRpc('getBlockHeight', [{ commitment: 'confirmed' }]));
  if (!Number.isSafeInteger(height) || height <= lastValidBlockHeight) return 'pending';
  // Past its last valid block: the full history is asked once, in case it landed just before and left the recent cache.
  return verdict(await statusOf(true)) || 'expired';
}

// ── The sends this device made, for History ─────────────────────────────────────────────────────────────────────────

const HISTORY_MAX = 100;
const historyKey = (owner) => `qnet_solana_sends_v1:${owner}`;
const queues = new Map();

const validEntry = (e) => !!e && typeof e === 'object' && typeof e.signature === 'string' && e.signature.length <= 100
  && !!solanaToken(e.symbol) && typeof e.amount === 'string' && /^\d+(\.\d+)?$/.test(e.amount) && !!decodeKey(e.to)
  && /^\d{1,20}$/.test(String(e.fee)) && ['pending', 'confirmed', 'failed'].includes(e.status) && Number.isFinite(e.at)
  && Number.isSafeInteger(e.lastValidBlockHeight);

/** This address's Solana sends made on this device, newest first. */
export async function loadSolanaSends(owner) {
  if (!owner) return [];
  try {
    const list = JSON.parse((await AsyncStorage.getItem(historyKey(owner))) || '[]');
    return Array.isArray(list) ? list.filter(validEntry) : [];
  } catch (_) {
    return [];
  }
}

// One change at a time per address, each on the list the one before left.
function change(owner, fn) {
  const run = (queues.get(owner) || Promise.resolve()).then(async () => {
    const next = fn(await loadSolanaSends(owner)).filter(validEntry).slice(0, HISTORY_MAX);
    await AsyncStorage.setItem(historyKey(owner), JSON.stringify(next));
    return next;
  });
  queues.set(owner, run.catch(() => {}));
  return run;
}

/** Adds a send (or replaces the one with its signature); resolves with the new list. */
export const recordSolanaSend = (owner, entry) => change(owner, (list) => [entry, ...list.filter((e) => e.signature !== entry.signature)]);

/** Changes one send's fields; resolves with the new list. */
export const updateSolanaSend = (owner, signature, patch) => change(owner, (list) => list.map((e) => (e.signature === signature ? { ...e, ...patch } : e)));

/**
 * A send as a History row (screens/WalletScreen TxRow): marked `chain: 'solana'`, amounts as display text. `solFee` is
 * the network fee only (a new recipient account's rent is not a fee), and null for a send that expired unrun: nobody
 * charged it. A send the network ran and failed keeps its fee, which was charged.
 */
export function solanaHistoryRow(entry, owner) {
  const self = entry.to === owner;
  return {
    hash: entry.signature,
    chain: 'solana',
    from: owner,
    to: entry.to,
    amount: 0,
    fee: 0,
    solSymbol: entry.symbol,
    solAmount: entry.amount,
    solFee: entry.status === 'failed' && entry.expired === true ? null : fromBaseUnits(BigInt(entry.fee), SOL_DECIMALS),
    status: entry.status,
    timestamp: entry.at,
    type: self ? 'self' : 'send',
  };
}
