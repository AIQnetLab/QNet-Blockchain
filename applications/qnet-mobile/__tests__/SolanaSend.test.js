/**
 * 29.09: SOL and Solana tokens leave the wallet from the app (services/SolanaSend, screens/SolanaSend): what a send
 * reads and refuses before anything is signed, how it is signed and sent (a fresh blockhash, one retry when the network
 * lost it, an unanswered submit kept as unknown by its signature), where it stands afterwards, the History record, and
 * the flow of the Send screen: review, then the fresh check, then the signature and the submit, then pending.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text, TextInput } from 'react-native';
import nacl from 'tweetnacl';
import { PublicKey, Transaction } from '@solana/web3.js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { makeT } from '../src/i18n';
import { ONE_DEV_MINT } from '../src/config/nodes';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID, associatedTokenAddress, base58Encode,
} from '../src/crypto/SolanaTx';
import {
  SOLANA_TOKENS, heldTokenBase, loadSolanaSends, maxSendable, quoteSolanaSend, recordSolanaSend, solanaHistoryRow, solanaSendStatus,
  submitSolanaSend, updateSolanaSend,
} from '../src/services/SolanaSend';
import SolanaSendForm, { cleanAmountInput, runSolanaSend, useSolanaSends } from '../src/screens/SolanaSend';

const t = makeT('en');
const seedPair = (n) => nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(n));
const SENDER = seedPair(1);
const FROM = base58Encode(SENDER.publicKey);
const TO = base58Encode(seedPair(2).publicKey);
const HASHES = [base58Encode(new Uint8Array(32).fill(0xa1)), base58Encode(new Uint8Array(32).fill(0xa2)), base58Encode(new Uint8Array(32).fill(0xa3))];
const LAMPORTS = 1_000_000_000;
const SOURCE = associatedTokenAddress(FROM, ONE_DEV_MINT);
const DEST = associatedTokenAddress(TO, ONE_DEV_MINT);

const systemAccount = (lamports) => ({ owner: SYSTEM_PROGRAM_ID, executable: false, lamports, data: ['', 'base64'] });
const mintAccount = (decimals = 6) => ({
  owner: TOKEN_PROGRAM_ID, executable: false, lamports: 1461600,
  data: { program: 'spl-token', parsed: { type: 'mint', info: { decimals, isInitialized: true, supply: '1000000000000' } }, space: 82 },
});
const tokenAccount = (owner, amount, mint = ONE_DEV_MINT, state = 'initialized') => ({
  owner: TOKEN_PROGRAM_ID, executable: false, lamports: 2039280,
  data: { program: 'spl-token', parsed: { type: 'account', info: { mint, owner, state, tokenAmount: { amount: String(amount), decimals: 6 } } }, space: 165 },
});

// A Solana RPC endpoint in memory: the methods the wallet calls, answered from `st`.
function fakeRpc(over = {}) {
  const st = {
    balances: { [FROM]: 2 * LAMPORTS, [TO]: LAMPORTS },
    accounts: { [ONE_DEV_MINT]: mintAccount(), [TO]: systemAccount(LAMPORTS), [SOURCE]: tokenAccount(FROM, 5_000_000) },
    tokenAccounts: { [FROM]: [{ pubkey: SOURCE, account: tokenAccount(FROM, 5_000_000) }] },
    rent: { 0: 890880, 165: 2039280 },
    blockhashes: HASHES.slice(),
    lastValid: 1000,
    height: 900,
    fee: 5000,
    statuses: {},
    history: {},
    sent: [],
    onSend: null,
    down: false,
    ...over,
  };
  const calls = [];
  global.fetch = jest.fn(async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    calls.push({ url, method, params });
    if (st.down) throw new Error('Network request failed');
    const ok = (result) => ({ result });
    const ctx = (value) => ok({ context: { slot: 1 }, value });
    let reply;
    switch (method) {
      case 'getBalance': reply = ctx(st.balances[params[0]] || 0); break;
      case 'getMinimumBalanceForRentExemption': reply = ok(st.rent[params[0]]); break;
      case 'getAccountInfo': reply = ctx(st.accounts[params[0]] || null); break;
      case 'getTokenAccountsByOwner':
        reply = ctx((st.tokenAccounts[params[0]] || []).filter((a) => a.account.data.parsed.info.mint === params[1].mint));
        break;
      case 'getLatestBlockhash': reply = ctx({ blockhash: st.blockhashes.length > 1 ? st.blockhashes.shift() : st.blockhashes[0], lastValidBlockHeight: st.lastValid }); break;
      case 'getFeeForMessage': reply = ctx(st.fee); break;
      case 'sendTransaction': {
        st.sent.push(params[0]);
        reply = st.onSend ? st.onSend(params, st.sent.length) : ok('echo');
        break;
      }
      case 'getSignatureStatuses': reply = ctx([(params[1].searchTransactionHistory ? st.history : st.statuses)[params[0][0]] || null]); break;
      case 'getBlockHeight': reply = ok(st.height); break;
      default: throw new Error(`unexpected ${method}`);
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, ...reply }) };
  });
  return { st, calls };
}

const sign = jest.fn(async (message) => nacl.sign.detached(message, SENDER.secretKey));
const wire = (b64) => Transaction.from(Buffer.from(b64, 'base64'));
const coded = (code, params) => expect.objectContaining(params ? { code, params } : { code });

beforeEach(async () => {
  sign.mockClear();
  await AsyncStorage.clear();
});

describe('the quote: everything a send needs, read now, and what the network would refuse', () => {
  it('SOL: the amount in lamports and the exact fee of this very message; no account rent', async () => {
    const { calls } = fakeRpc();
    const q = await quoteSolanaSend({ from: FROM, to: ` ${TO} `, symbol: 'SOL', amount: '0.5' });
    expect(q).toMatchObject({
      symbol: 'SOL', mint: null, decimals: 9, from: FROM, to: TO, amountBase: '500000000', amountText: '0.5',
      feeLamports: '5000', rentLamports: '0', createDestination: false, balanceLamports: '2000000000',
    });
    const feeCall = calls.find((c) => c.method === 'getFeeForMessage');
    const message = Buffer.from(feeCall.params[0], 'base64');
    expect(message[0]).toBe(1); // one signer: the wallet
    expect(new PublicKey(message.subarray(4, 36)).toBase58()).toBe(FROM);
  });

  it('SOL: not enough for the amount and the fee', async () => {
    fakeRpc({ balances: { [FROM]: 500_000_000, [TO]: LAMPORTS } });
    await expect(quoteSolanaSend({ from: FROM, to: TO, symbol: 'SOL', amount: '0.5' })).rejects.toEqual(
      coded('SOL_SHORT_SOL', { need: '0.500005 SOL', fee: '0.000005 SOL', balance: '0.5 SOL' }));
  });

  it('SOL: a remainder below the minimum an account keeps is refused; all of it (MAX) is not', async () => {
    fakeRpc({ balances: { [FROM]: 500_600_000, [TO]: LAMPORTS } });
    await expect(quoteSolanaSend({ from: FROM, to: TO, symbol: 'SOL', amount: '0.5' })).rejects.toEqual(
      coded('SOL_REMAINDER', { left: '0.000595 SOL', min: '0.00089088 SOL' }));
    expect(await maxSendable(FROM, 'SOL')).toBe('0.500595');
    await expect(quoteSolanaSend({ from: FROM, to: TO, symbol: 'SOL', amount: '0.500595' })).resolves.toMatchObject({ amountBase: '500595000' });
  });

  it('SOL: a first payment to an address with no SOL must reach the minimum', async () => {
    fakeRpc({ balances: { [FROM]: 2 * LAMPORTS } });
    await expect(quoteSolanaSend({ from: FROM, to: TO, symbol: 'SOL', amount: '0.0005' })).rejects.toEqual(
      coded('SOL_NEW_ACCOUNT_MIN', { min: '0.00089088 SOL' }));
    await expect(quoteSolanaSend({ from: FROM, to: TO, symbol: 'SOL', amount: '0.01' })).resolves.toMatchObject({ amountBase: '10000000' });
  });

  it('SOL: back to the same address only the fee leaves', async () => {
    fakeRpc({ balances: { [FROM]: 1_000_000 } });
    await expect(quoteSolanaSend({ from: FROM, to: FROM, symbol: 'SOL', amount: '0.000995' })).resolves.toMatchObject({ to: FROM });
  });

  it('a token to an address that never held it: its associated account is created, the sender pays the rent', async () => {
    fakeRpc();
    const q = await quoteSolanaSend({ from: FROM, to: TO, symbol: '1DEV', amount: '2' });
    expect(q).toMatchObject({
      symbol: '1DEV', mint: ONE_DEV_MINT, decimals: 6, amountBase: '2000000', feeLamports: '5000', rentLamports: '2039280',
      createDestination: true, source: SOURCE, destination: DEST,
    });
  });

  it('a token to an address that holds it already: no account and no rent', async () => {
    const { st } = fakeRpc();
    st.accounts[DEST] = tokenAccount(TO, 7);
    const q = await quoteSolanaSend({ from: FROM, to: TO, symbol: '1DEV', amount: '2' });
    expect(q).toMatchObject({ rentLamports: '0', createDestination: false, destination: DEST });
  });

  it('a token: the fullest account pays when the associated one cannot; too little of the token is refused', async () => {
    const other = base58Encode(new Uint8Array(32).fill(0x77));
    fakeRpc({
      tokenAccounts: { [FROM]: [
        { pubkey: SOURCE, account: tokenAccount(FROM, 1_000_000) },
        { pubkey: other, account: tokenAccount(FROM, 3_000_000) },
        { pubkey: base58Encode(new Uint8Array(32).fill(0x78)), account: tokenAccount(FROM, 9_000_000, ONE_DEV_MINT, 'frozen') },
      ] },
    });
    await expect(quoteSolanaSend({ from: FROM, to: TO, symbol: '1DEV', amount: '2.5' })).resolves.toMatchObject({ source: other });
    expect(await maxSendable(FROM, '1DEV')).toBe('3');
    await expect(quoteSolanaSend({ from: FROM, to: TO, symbol: '1DEV', amount: '4' })).rejects.toEqual(
      coded('SOL_SHORT_TOKEN', { need: '4 1DEV', balance: '3 1DEV' }));
  });

  // APP-SOL-AVAIL-01: the Assets figure (and the form's Available line) is the one MAX and the send use.
  it('a token: the Assets balance, MAX and the refusal agree, whichever account the endpoint lists first', async () => {
    const { WalletManager } = require('../src/components/WalletManager');
    const wm = new WalletManager();
    const other = base58Encode(new Uint8Array(32).fill(0x79));
    const { calls } = fakeRpc({
      tokenAccounts: { [FROM]: [
        { pubkey: other, account: tokenAccount(FROM, 300_000_000) },
        { pubkey: SOURCE, account: tokenAccount(FROM, 1_500_000_000, ONE_DEV_MINT, 'frozen') },
      ] },
    });
    expect(await wm.getTokenBalance(FROM, ONE_DEV_MINT)).toBe(300);
    expect(await maxSendable(FROM, '1DEV')).toBe('300');
    await expect(quoteSolanaSend({ from: FROM, to: TO, symbol: '1DEV', amount: '1500' })).rejects.toEqual(
      coded('SOL_SHORT_TOKEN', { need: '1500 1DEV', balance: '300 1DEV' }));
    // Both balances are read at 'confirmed', as the quote reads them (getBalance reads the answer with json()).
    const rpc = global.fetch;
    global.fetch = jest.fn(async (...args) => {
      const r = await rpc(...args);
      return { ...r, json: async () => JSON.parse(await r.text()) };
    });
    expect(await wm.getBalance(FROM)).toBe(2);
    for (const c of calls.filter((x) => x.method === 'getBalance' || x.method === 'getTokenAccountsByOwner')) {
      expect([c.method, c.params[c.params.length - 1].commitment]).toEqual([c.method, 'confirmed']);
    }
    // No account at all is a real 0; an answer that is an error, or none, keeps the last figure (null).
    fakeRpc({ tokenAccounts: {} });
    expect(await wm.getTokenBalance(FROM, ONE_DEV_MINT)).toBe(0);
    global.fetch = jest.fn(async () => ({
      ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'busy' } }),
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'busy' } }),
    }));
    expect(await wm.getTokenBalance(FROM, ONE_DEV_MINT)).toBe(null);
    expect(await wm.getBalance(FROM)).toBe(null);
    fakeRpc({ down: true });
    expect(await wm.getTokenBalance(FROM, ONE_DEV_MINT)).toBe(null);
    expect(await wm.getBalance(FROM)).toBe(null);
  });

  it('a token: SOL for the fee and the new account, and a remainder the minimum allows', async () => {
    fakeRpc({ balances: { [FROM]: 1_000_000 } });
    await expect(quoteSolanaSend({ from: FROM, to: TO, symbol: '1DEV', amount: '1' })).rejects.toEqual(
      coded('SOL_SHORT_FEE_ACCOUNT', { need: '0.00204428 SOL', account: '0.00203928 SOL', balance: '0.001 SOL' }));
    const { st } = fakeRpc({ balances: { [FROM]: 3000 } });
    st.accounts[DEST] = tokenAccount(TO, 0);
    await expect(quoteSolanaSend({ from: FROM, to: TO, symbol: '1DEV', amount: '1' })).rejects.toEqual(
      coded('SOL_SHORT_FEE', { need: '0.000005 SOL', balance: '0.000003 SOL' }));
    fakeRpc({ balances: { [FROM]: 2_500_000 } });
    await expect(quoteSolanaSend({ from: FROM, to: TO, symbol: '1DEV', amount: '1' })).rejects.toEqual(
      coded('SOL_REMAINDER_FEE', { left: '0.00045572 SOL', min: '0.00089088 SOL' }));
  });

  it('a token recipient must be a wallet: not a program address, a token account or a program', async () => {
    const { calls } = fakeRpc();
    await expect(quoteSolanaSend({ from: FROM, to: DEST, symbol: '1DEV', amount: '1' })).rejects.toEqual(coded('SOL_NOT_WALLET'));
    expect(calls).toHaveLength(0); // refused before anything is read
    const tokenAcct = base58Encode(seedPair(3).publicKey);
    fakeRpc({ accounts: { [ONE_DEV_MINT]: mintAccount(), [tokenAcct]: tokenAccount(TO, 1) } });
    await expect(quoteSolanaSend({ from: FROM, to: tokenAcct, symbol: '1DEV', amount: '1' })).rejects.toEqual(coded('SOL_NOT_WALLET'));
    fakeRpc({ accounts: { [ONE_DEV_MINT]: mintAccount(), [TO]: { ...systemAccount(1), owner: 'BPFLoaderUpgradeab1e11111111111111111111111', executable: true } } });
    await expect(quoteSolanaSend({ from: FROM, to: TO, symbol: '1DEV', amount: '1' })).rejects.toEqual(coded('SOL_NOT_WALLET'));
    // A SOL payment may go to any address.
    fakeRpc();
    await expect(quoteSolanaSend({ from: FROM, to: DEST, symbol: 'SOL', amount: '1' })).resolves.toMatchObject({ to: DEST });
  });

  it('a mint that is not the one the wallet knows (other decimals, other program) is not sent', async () => {
    fakeRpc({ accounts: { [ONE_DEV_MINT]: mintAccount(9), [TO]: systemAccount(1) } });
    await expect(quoteSolanaSend({ from: FROM, to: TO, symbol: '1DEV', amount: '1' })).rejects.toEqual(coded('SOL_TOKEN_UNSUPPORTED'));
    fakeRpc({ accounts: { [ONE_DEV_MINT]: { ...mintAccount(), owner: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' } } });
    await expect(quoteSolanaSend({ from: FROM, to: TO, symbol: '1DEV', amount: '1' })).rejects.toEqual(coded('SOL_TOKEN_UNSUPPORTED'));
  });

  it('refuses a bad address, a bad amount, an unknown token; an unreachable network is said as such', async () => {
    fakeRpc();
    await expect(quoteSolanaSend({ from: FROM, to: 'not-an-address', symbol: 'SOL', amount: '1' })).rejects.toEqual(coded('SOL_ADDRESS'));
    await expect(quoteSolanaSend({ from: FROM, to: TO, symbol: 'SOL', amount: '0' })).rejects.toEqual(coded('INVALID_AMOUNT'));
    await expect(quoteSolanaSend({ from: FROM, to: TO, symbol: '1DEV', amount: '0.1234567' })).rejects.toEqual(
      coded('AMOUNT_DECIMALS', { decimals: 6 }));
    await expect(quoteSolanaSend({ from: FROM, to: TO, symbol: 'USDC', amount: '1' })).rejects.toEqual(coded('SOL_TOKEN_UNSUPPORTED'));
    fakeRpc({ down: true });
    await expect(quoteSolanaSend({ from: FROM, to: TO, symbol: 'SOL', amount: '1' })).rejects.toEqual(coded('SOL_RPC'));
  });

  // APP-SOURCE-MALFORMED: a token-account answer with no account list is a failed read, as heldTokenBase reads it,
  // never "no token accounts" with a balance of 0 in the refusal.
  it('a token-account answer with no account list is SOL_RPC, never a balance of 0', async () => {
    fakeRpc();
    const rpc = global.fetch;
    global.fetch = jest.fn(async (url, init) => {
      if (JSON.parse(init.body).method !== 'getTokenAccountsByOwner') return rpc(url, init);
      return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) };
    });
    await expect(quoteSolanaSend({ from: FROM, to: TO, symbol: '1DEV', amount: '1' })).rejects.toEqual(coded('SOL_RPC'));
    await expect(heldTokenBase(FROM, ONE_DEV_MINT)).rejects.toEqual(coded('SOL_RPC'));
  });
});

describe('the submit: a fresh blockhash, the wallet\'s signature, the network\'s answer', () => {
  const quoteOf = async (symbol, amount, rpc) => { const q = await quoteSolanaSend({ from: FROM, to: TO, symbol, amount }); rpc.calls.length = 0; return q; };

  it('sends the signed transfer at the blockhash read now; its id is the wallet\'s signature', async () => {
    const rpc = fakeRpc();
    const q = await quoteOf('1DEV', '2', rpc);
    const r = await submitSolanaSend(q, sign);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(rpc.calls.map((c) => c.method)).toEqual(['getLatestBlockhash', 'sendTransaction']);
    expect(rpc.calls[1].params[1]).toEqual({ encoding: 'base64', preflightCommitment: 'confirmed' });
    const tx = wire(rpc.st.sent[0]);
    expect(tx.verifySignatures()).toBe(true);
    expect(tx.recentBlockhash).toBe(HASHES[1]); // the quote read HASHES[0]
    expect(tx.feePayer.toBase58()).toBe(FROM);
    expect(tx.instructions.map((ix) => ix.programId.toBase58())).toEqual([ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID]);
    const transfer = tx.instructions[1];
    expect(transfer.keys.map((k) => k.pubkey.toBase58())).toEqual([SOURCE, ONE_DEV_MINT, DEST, FROM]);
    expect(Array.from(transfer.data)).toEqual([12, 0x80, 0x84, 0x1e, 0, 0, 0, 0, 0, 6]); // 2_000_000, 6 decimals
    expect(r).toEqual({ status: 'pending', signature: base58Encode(tx.signature), lastValidBlockHeight: 1000 });
  });

  it('a blockhash the network no longer knows is replaced and signed again, once', async () => {
    const rpc = fakeRpc({
      onSend: (params, n) => (n === 1
        ? { error: { code: -32002, message: 'Transaction simulation failed: Blockhash not found', data: { err: 'BlockhashNotFound' } } }
        : { result: 'x' }),
    });
    const q = await quoteOf('SOL', '0.1', rpc);
    const r = await submitSolanaSend(q, sign);
    expect(sign).toHaveBeenCalledTimes(2);
    expect(rpc.st.sent.map((w) => wire(w).recentBlockhash)).toEqual([HASHES[1], HASHES[2]]);
    expect(r.status).toBe('pending');
    expect(r.signature).toBe(base58Encode(wire(rpc.st.sent[1]).signature));
  });

  it('a refusal of the network is SOL_REFUSED with its words; nothing was sent', async () => {
    const rpc = fakeRpc({
      onSend: () => ({ error: { code: -32002, message: 'Transaction simulation failed: Attempt to debit an account but found no record of a prior credit.' } }),
    });
    const q = await quoteOf('SOL', '0.1', rpc);
    await expect(submitSolanaSend(q, sign)).rejects.toEqual(coded('SOL_REFUSED', {
      detail: 'Transaction simulation failed: Attempt to debit an account but found no record of a prior credit.',
    }));
    expect(t('err_SOL_REFUSED', { detail: 'x' })).toBe('The Solana network refused this transaction, so nothing was sent. (x)');
  });

  it('no answer to the submit is unknown, not a refusal: the signature is known and asked about later', async () => {
    const rpc = fakeRpc({ onSend: () => { throw new Error('timeout'); } });
    const q = await quoteOf('SOL', '0.1', rpc);
    rpc.st.onSend = null;
    global.fetch.mockImplementation(async (url, init) => {
      const { method } = JSON.parse(init.body);
      if (method === 'sendTransaction') throw new Error('Network request failed');
      return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: { blockhash: HASHES[2], lastValidBlockHeight: 1234 } } }) };
    });
    const r = await submitSolanaSend(q, sign);
    expect(r.status).toBe('unknown');
    expect(r.lastValidBlockHeight).toBe(1234);
    const signed = sign.mock.calls[0][0];
    expect(r.signature).toBe(base58Encode(nacl.sign.detached(signed, SENDER.secretKey)));
  });

  it('a refusal that follows an attempt nobody answered is unknown: that attempt may be in, so nothing is signed again', async () => {
    const rpc = fakeRpc({
      onSend: (params, n) => {
        if (n === 1) throw new Error('Network request failed');
        return { error: { code: -32002, message: 'Transaction simulation failed: Blockhash not found', data: { err: 'BlockhashNotFound' } } };
      },
    });
    const q = await quoteOf('SOL', '0.1', rpc);
    const r = await submitSolanaSend(q, sign);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(rpc.st.sent).toHaveLength(2);
    expect(rpc.st.sent[1]).toBe(rpc.st.sent[0]); // the same transaction sent again, never a second one
    expect(r).toEqual({ status: 'unknown', signature: base58Encode(wire(rpc.st.sent[0]).signature), lastValidBlockHeight: 1000 });
  });

  it('the network already holding this very transaction is pending, not a refusal', async () => {
    const rpc = fakeRpc({
      onSend: () => ({ error: { code: -32002, message: 'Transaction simulation failed: This transaction has already been processed', data: { err: 'AlreadyProcessed' } } }),
    });
    const q = await quoteOf('SOL', '0.1', rpc);
    const r = await submitSolanaSend(q, sign);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ status: 'pending', signature: base58Encode(wire(rpc.st.sent[0]).signature) });
  });

  it('nothing is signed when no blockhash can be read, and a bad signature is never sent', async () => {
    const rpc = fakeRpc();
    const q = await quoteOf('SOL', '0.1', rpc);
    rpc.st.down = true;
    await expect(submitSolanaSend(q, sign)).rejects.toEqual(coded('SOL_RPC'));
    expect(sign).not.toHaveBeenCalled();
    rpc.st.down = false;
    await expect(submitSolanaSend(q, async () => new Uint8Array(63))).rejects.toThrow(/signature/);
    expect(rpc.st.sent).toHaveLength(0);
  });
});

describe('where a sent transfer stands', () => {
  it('confirmed, failed, still pending, or expired once its blockhash passed unrun', async () => {
    const { st } = fakeRpc();
    st.statuses.a = { confirmationStatus: 'confirmed', err: null };
    st.statuses.b = { confirmationStatus: 'finalized', err: null };
    st.statuses.c = { confirmationStatus: 'processed', err: null };
    st.statuses.d = { confirmationStatus: 'confirmed', err: { InstructionError: [0, { Custom: 1 }] } };
    expect(await solanaSendStatus('a', 1000)).toBe('confirmed');
    expect(await solanaSendStatus('b', 1000)).toBe('confirmed');
    expect(await solanaSendStatus('c', 1000)).toBe('pending');
    expect(await solanaSendStatus('d', 1000)).toBe('failed');
    // A failed run seen only at 'processed' is not final: that fork may be dropped and the transaction land elsewhere.
    st.statuses.f = { confirmationStatus: 'processed', err: { InstructionError: [0, { Custom: 1 }] } };
    expect(await solanaSendStatus('f', 1000)).toBe('pending');
    expect(await solanaSendStatus('e', 1000)).toBe('pending'); // height 900: it may still land
    st.height = 1001;
    expect(await solanaSendStatus('e', 1000)).toBe('expired');
    st.history.e = { confirmationStatus: 'finalized', err: null }; // it landed just before and left the recent cache
    expect(await solanaSendStatus('e', 1000)).toBe('confirmed');
  });
});

describe('the sends of this device, for History', () => {
  const entry = (n, extra = {}) => ({
    signature: `sig${n}`, symbol: 'SOL', amount: '0.5', to: TO, fee: '5000', rent: '0', status: 'pending', at: 1000 + n,
    lastValidBlockHeight: 1000, ...extra,
  });

  it('records newest first, updates by signature, keeps each address apart, and drops what is not an entry', async () => {
    await recordSolanaSend(FROM, entry(1));
    await recordSolanaSend(FROM, entry(2, { symbol: '1DEV', amount: '2', rent: '2039280' }));
    await updateSolanaSend(FROM, 'sig1', { status: 'confirmed' });
    expect((await loadSolanaSends(FROM)).map((e) => [e.signature, e.status])).toEqual([['sig2', 'pending'], ['sig1', 'confirmed']]);
    expect(await loadSolanaSends(TO)).toEqual([]);
    await AsyncStorage.setItem(`qnet_solana_sends_v1:${FROM}`, JSON.stringify([entry(3), { signature: 'x' }, entry(4, { to: 'bad' }), entry(5, { fee: 'NaN' })]));
    expect((await loadSolanaSends(FROM)).map((e) => e.signature)).toEqual(['sig3']);
  });

  it('a History row names its token, its amount and its network fee as text', () => {
    expect(solanaHistoryRow(entry(1, { symbol: '1DEV', amount: '2', rent: '2039280' }), FROM)).toMatchObject({
      hash: 'sig1', chain: 'solana', from: FROM, to: TO, solSymbol: '1DEV', solAmount: '2', solFee: '0.000005',
      status: 'pending', type: 'send', amount: 0, fee: 0,
    });
    expect(solanaHistoryRow(entry(1, { to: FROM }), FROM).type).toBe('self');
  });

  // APP-SOL-HISTFEE-01: a send that expired unrun was never charged; one the network ran and failed was.
  it('a send that expired unrun shows no fee; one that failed when run keeps the fee it was charged', () => {
    expect(solanaHistoryRow(entry(1, { status: 'failed', expired: true }), FROM).solFee).toBe(null);
    expect(solanaHistoryRow(entry(1, { status: 'failed' }), FROM).solFee).toBe('0.000005');
    expect(solanaHistoryRow(entry(1, { status: 'confirmed', symbol: '1DEV', amount: '2', rent: '2039280' }), FROM).solFee).toBe('0.000005');
  });
});

describe('the Send screen flow (runSolanaSend): review, fresh check, signature, pending', () => {
  const QUOTE = {
    symbol: '1DEV', mint: ONE_DEV_MINT, decimals: 6, from: FROM, to: TO, amountBase: '2000000', amountText: '2',
    feeLamports: '5000', rentLamports: '2039280', createDestination: true, source: SOURCE, destination: DEST,
    references: [], memo: null, balanceLamports: '1000000000',
  };
  const deps = (over = {}) => ({
    t, from: FROM, to: TO, symbol: '1DEV', amount: '2',
    reviewSend: jest.fn(async () => true),
    confirmFresh: jest.fn(async () => true),
    sign,
    quote: jest.fn(async () => QUOTE),
    submit: jest.fn(async () => ({ status: 'pending', signature: 'SIG', lastValidBlockHeight: 1000 })),
    now: () => 42,
    ...over,
  });

  it('shows every detail, then asks who holds the device with the recipient, then signs and submits: pending', async () => {
    const d = deps();
    const out = await runSolanaSend(d);
    expect(d.reviewSend).toHaveBeenCalledWith({
      to: TO, network: 'Solana devnet', amount: '2 1DEV', fee: '0.000005 SOL', account: '0.00203928 SOL', memo: null,
      total: '2 1DEV + 0.00204428 SOL', warnings: { firstTime: true, lookAlike: false },
    });
    expect(d.confirmFresh).toHaveBeenCalledWith('Confirm sending 2 1DEV', null, TO);
    expect(d.reviewSend.mock.invocationCallOrder[0]).toBeLessThan(d.confirmFresh.mock.invocationCallOrder[0]);
    expect(d.confirmFresh.mock.invocationCallOrder[0]).toBeLessThan(d.submit.mock.invocationCallOrder[0]);
    expect(d.submit).toHaveBeenCalledWith(QUOTE, sign);
    expect(out).toEqual({
      outcome: 'sent',
      entry: { signature: 'SIG', symbol: '1DEV', amount: '2', to: TO, fee: '5000', rent: '2039280', status: 'pending', at: 42, lastValidBlockHeight: 1000 },
    });
  });

  it('SOL: the total is the amount and the fee; a recipient paid before gives no warning', async () => {
    const d = deps({ symbol: 'SOL', known: [TO], quote: jest.fn(async () => ({ ...QUOTE, symbol: 'SOL', mint: null, decimals: 9, amountBase: '500000000', amountText: '0.5', rentLamports: '0', createDestination: false })) });
    await runSolanaSend(d);
    expect(d.reviewSend.mock.calls[0][0]).toMatchObject({ amount: '0.5 SOL', account: null, total: '0.500005 SOL', warnings: {} });
  });

  it('Cancel on the review, or a declined fresh check, signs and sends nothing', async () => {
    let d = deps({ reviewSend: jest.fn(async () => false) });
    expect(await runSolanaSend(d)).toEqual({ outcome: 'cancelled' });
    expect(d.confirmFresh).not.toHaveBeenCalled();
    expect(d.submit).not.toHaveBeenCalled();
    d = deps({ confirmFresh: jest.fn(async () => false) });
    expect(await runSolanaSend(d)).toEqual({ outcome: 'cancelled' });
    expect(d.submit).not.toHaveBeenCalled();
  });

  it('a refusal before the review shows no review; a scanned request counts only for its own recipient', async () => {
    let d = deps({ quote: jest.fn(async () => { throw Object.assign(new Error('x'), { code: 'SOL_SHORT_FEE' }); }) });
    expect(await runSolanaSend(d)).toMatchObject({ outcome: 'refused', error: { code: 'SOL_SHORT_FEE' } });
    expect(d.reviewSend).not.toHaveBeenCalled();
    d = deps({ to: 'nope' });
    expect(await runSolanaSend(d)).toEqual({ outcome: 'refused', error: { code: 'SOL_ADDRESS' } });
    expect(d.quote).not.toHaveBeenCalled();
    const request = { address: TO, references: [FROM], memo: 'order-42' };
    d = deps({ request });
    await runSolanaSend(d);
    expect(d.quote.mock.calls[0][0].request).toBe(request);
    d = deps({ request: { ...request, address: FROM } });
    await runSolanaSend(d);
    expect(d.quote.mock.calls[0][0].request).toBe(null);
  });

  it('an unanswered submit is unknown; a refused one is a refusal after the submit', async () => {
    let d = deps({ submit: jest.fn(async () => ({ status: 'unknown', signature: 'SIG', lastValidBlockHeight: 7 })) });
    expect(await runSolanaSend(d)).toMatchObject({ outcome: 'unknown', entry: { signature: 'SIG', status: 'pending' } });
    d = deps({ submit: jest.fn(async () => { throw Object.assign(new Error('x'), { code: 'SOL_REFUSED', params: { detail: 'd' } }); }) });
    expect(await runSolanaSend(d)).toMatchObject({ outcome: 'refused', submitted: true, error: { code: 'SOL_REFUSED' } });
  });
});

describe('the Send screen itself, against the network in memory', () => {
  // The wallet screen's part: the form's values as its state.
  function Screen(props) {
    const [symbol, setSymbol] = React.useState(props.symbol || 'SOL');
    const [address, setAddress] = React.useState('');
    const [amount, setAmount] = React.useState('');
    return (
      <SolanaSendForm
        t={t} rtl={false} owner={FROM} symbol={symbol} onSymbol={setSymbol} address={address} onAddress={setAddress}
        amount={amount} onAmount={setAmount} request={null} balances={{ SOL: '2', '1DEV': '5' }} backArrow="←"
        onBack={() => {}} onScan={props.onScan || (() => {})} known={[]} {...props}
      />
    );
  }
  const texts = (tree) => tree.root.findAllByType(Text).map((n) => [].concat(n.props.children).join('')).join('\n');
  const byId = (tree, id) => tree.root.find((n) => n.props.testID === id && (typeof n.props.onPress === 'function' || n.type === TextInput));

  it('review → fresh check → the signed transfer goes out → pending; the form shows the token, fee and total', async () => {
    const rpc = fakeRpc();
    const reviewSend = jest.fn(async () => true);
    const confirmFresh = jest.fn(async () => true);
    const onSent = jest.fn();
    const onResult = jest.fn();
    let tree;
    await act(async () => {
      tree = renderer.create(<Screen reviewSend={reviewSend} confirmFresh={confirmFresh} sign={sign} onSent={onSent} onResult={onResult} />);
    });
    await act(async () => { byId(tree, 'solana-token-1DEV').props.onPress(); });
    expect(texts(tree)).toContain('Send 1DEV');
    await act(async () => { byId(tree, 'solana-send-address').props.onChangeText(TO); });
    await act(async () => { byId(tree, 'solana-send-amount').props.onChangeText('2,5000001'); });
    expect(byId(tree, 'solana-send-amount').props.value).toBe('2.500000'); // six decimals at most, a comma read as a point
    expect(texts(tree)).toContain('0.000005 SOL');
    expect(texts(tree)).toContain('2.5 1DEV + 0.000005 SOL');
    await act(async () => { await byId(tree, 'solana-send-button').props.onPress(); });
    expect(reviewSend).toHaveBeenCalledTimes(1);
    expect(reviewSend.mock.calls[0][0]).toMatchObject({ to: TO, amount: '2.5 1DEV', account: '0.00203928 SOL', total: '2.5 1DEV + 0.00204428 SOL' });
    expect(confirmFresh).toHaveBeenCalledWith('Confirm sending 2.5 1DEV', null, TO);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(rpc.st.sent).toHaveLength(1);
    expect(wire(rpc.st.sent[0]).verifySignatures()).toBe(true);
    expect(onSent).toHaveBeenCalledWith(expect.objectContaining({ symbol: '1DEV', amount: '2.5', to: TO, status: 'pending', rent: '2039280' }), 'sent');
    expect(onResult).not.toHaveBeenCalled();
    await act(async () => { tree.unmount(); });
  });

  it('MAX fills in what can leave; a refusal is shown as "Cannot send" with its reason and nothing is signed', async () => {
    fakeRpc({ balances: { [FROM]: 400_000_000, [TO]: 0 } });
    const onResult = jest.fn();
    const reviewSend = jest.fn(async () => true);
    let tree;
    await act(async () => {
      tree = renderer.create(<Screen reviewSend={reviewSend} confirmFresh={jest.fn(async () => true)} sign={sign} onSent={jest.fn()} onResult={onResult} />);
    });
    await act(async () => { await byId(tree, 'solana-send-max').props.onPress(); });
    expect(byId(tree, 'solana-send-amount').props.value).toBe('0.399995');
    await act(async () => { byId(tree, 'solana-send-address').props.onChangeText(TO); });
    await act(async () => { byId(tree, 'solana-send-amount').props.onChangeText('0.5'); });
    await act(async () => { await byId(tree, 'solana-send-button').props.onPress(); });
    expect(reviewSend).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
    expect(onResult).toHaveBeenCalledWith({
      success: false, title: 'Cannot send',
      error: 'Insufficient balance. Need 0.500005 SOL, including the 0.000005 SOL fee.\nYour balance: 0.4 SOL.',
    });
    await act(async () => { tree.unmount(); });
  });

  it('the scan icon sits in the recipient field, named for screen readers, and opens the scan', async () => {
    fakeRpc();
    const onScan = jest.fn();
    let tree;
    await act(async () => { tree = renderer.create(<Screen onScan={onScan} reviewSend={jest.fn()} confirmFresh={jest.fn()} sign={sign} onSent={jest.fn()} onResult={jest.fn()} />); });
    const scan = byId(tree, 'send-scan');
    expect(scan.props).toMatchObject({ accessibilityRole: 'button', accessibilityLabel: 'Scan a Solana address' });
    await act(async () => { scan.props.onPress(); });
    expect(onScan).toHaveBeenCalledTimes(1);
    await act(async () => { tree.unmount(); });
  });

  it('the amount field takes digits and one point, no more decimals than the token has', () => {
    expect(cleanAmountInput('1.2.3', 9)).toBe('1.23');
    expect(cleanAmountInput('abc12,3456789', 6)).toBe('12.345678');
    expect(cleanAmountInput('', 6)).toBe('');
    expect(cleanAmountInput('.5', 9)).toBe('0.5'); // a leading point gets its zero, as the QNet form reads it
    expect(cleanAmountInput(',25', 6)).toBe('0.25');
    expect(SOLANA_TOKENS.map((tk) => [tk.symbol, tk.mint, tk.decimals])).toEqual([['SOL', null, 9], ['1DEV', ONE_DEV_MINT, 6]]);
  });
});

describe('History follows a pending send until the network settles it (useSolanaSends)', () => {
  it('asks by signature and reports it confirmed once', async () => {
    const { st } = fakeRpc();
    const settled = jest.fn();
    let api;
    function Probe() { api = useSolanaSends(FROM, settled); return null; }
    let tree;
    await act(async () => { tree = renderer.create(<Probe />); });
    await act(async () => {
      await api.record({ signature: 'SIGX', symbol: 'SOL', amount: '1', to: TO, fee: '5000', rent: '0', status: 'pending', at: 1, lastValidBlockHeight: 1000 });
    });
    expect(api.sends.map((e) => e.status)).toEqual(['pending']);
    st.statuses.SIGX = { confirmationStatus: 'confirmed', err: null };
    await act(async () => { await new Promise((r) => setTimeout(r, 2600)); });
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ signature: 'SIGX', status: 'confirmed' }));
    expect(api.sends.map((e) => e.status)).toEqual(['confirmed']);
    expect((await loadSolanaSends(FROM))[0].status).toBe('confirmed');
    await act(async () => { tree.unmount(); });
  });

  it('an expired one becomes failed, marked expired', async () => {
    const { st } = fakeRpc({ height: 2000 });
    const settled = jest.fn();
    let api;
    function Probe() { api = useSolanaSends(FROM, settled); return null; }
    let tree;
    await act(async () => { tree = renderer.create(<Probe />); });
    await act(async () => {
      await api.record({ signature: 'SIGY', symbol: 'SOL', amount: '1', to: TO, fee: '5000', rent: '0', status: 'pending', at: 1, lastValidBlockHeight: 1000 });
    });
    expect(st.statuses.SIGY).toBeUndefined();
    await act(async () => { await new Promise((r) => setTimeout(r, 2600)); });
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ signature: 'SIGY', status: 'failed', expired: true }));
    expect(t('err_SOL_EXPIRED')).toMatch(/Nothing was sent/);
    await act(async () => { tree.unmount(); });
  });
});

describe('the wallet signs only its own Solana transfers (WalletManager.signSolanaMessage)', () => {
  const WalletManager = require('../src/components/WalletManager').default;
  const { transferMessage } = require('../src/crypto/SolanaTx');
  const message = (from) => transferMessage({ kind: 'sol', from, to: TO, amount: 1n }, HASHES[0]);

  it('signs a message this wallet pays for with the key its address names, and wipes the key', async () => {
    const wm = new WalletManager();
    const secretKey = Array.from(SENDER.secretKey);
    wm.loadWallet = jest.fn(async () => ({ solanaAddress: FROM, address: FROM, secretKey }));
    const m = message(FROM);
    const sig = await wm.signSolanaMessage(m, 'session');
    expect(wm.loadWallet).toHaveBeenCalledWith('session');
    expect(nacl.sign.detached.verify(m, sig, SENDER.publicKey)).toBe(true);
    expect(secretKey.every((b) => b === 0)).toBe(true);
  });

  it('refuses a message another address pays for, a key that is not the address\'s, and anything that is not a message', async () => {
    const wm = new WalletManager();
    wm.loadWallet = jest.fn(async () => ({ solanaAddress: FROM, secretKey: Array.from(SENDER.secretKey) }));
    await expect(wm.signSolanaMessage(message(TO), 's')).rejects.toThrow(/not paid by this wallet/);
    wm.loadWallet = jest.fn(async () => ({ solanaAddress: FROM, secretKey: Array.from(seedPair(5).secretKey) }));
    await expect(wm.signSolanaMessage(message(FROM), 's')).rejects.toThrow(/does not match/);
    await expect(wm.signSolanaMessage('hello', 's')).rejects.toThrow(/Not a Solana message/);
    await expect(wm.signSolanaMessage(new Uint8Array(2000), 's')).rejects.toThrow(/Not a Solana message/);
  });
});
