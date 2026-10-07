// The in-app browser's transactions beyond a QNC transfer, with the extension's parameters, results and error codes:
// a built-in token transfer (decimals from the chain, the amount scaled exactly, the deposit a new holder costs), a
// WASM contract call (hex input, a fuel budget on top of the intrinsic gas, no value and no access list), and
// qnet_getTransactionStatus by (from, nonce). Every one is signed with the shared builders (crypto/TxBuilders) through
// the wallet's own send path, at the nonce its sheet showed.
jest.mock('../src/crypto/DilithiumCrypto', () => {
  const { ml_dsa65 } = require('@noble/post-quantum/ml-dsa.js');
  return {
    isDilithiumAvailable: () => true,
    // FIPS 204's deterministic mode, as the shared vectors were signed
    signDetached: jest.fn(async (message, skHex) => Buffer.from(ml_dsa65.sign(new TextEncoder().encode(message),
      Uint8Array.from(Buffer.from(skHex, 'hex')), { extraEntropy: false })).toString('hex')),
  };
});

import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text, TouchableOpacity } from 'react-native';

const AsyncStorage = require('@react-native-async-storage/async-storage');
const { sha3_256, shake256 } = require('js-sha3');
const { ml_dsa65 } = require('@noble/post-quantum/ml-dsa.js');
const V = require('../src/crypto/__vectors__/tx-vectors.json');
const kat = require('./fixtures/wallet_kat.json');
const T = require('../src/crypto/TxBuilders');
const { WalletManager } = require('../src/components/WalletManager');
const { pendingFor, putSigned } = require('../src/services/PendingTx');
const { GENESIS_NODES } = require('../src/config/nodes');
const R = require('../src/browser/dappRequests');
const {
  createDappProvider, CODES, LIMITS, TIMINGS, pageError, describeCallArgs, visibleLabel, SAFE_AMOUNT_NANO,
} = require('../src/browser/dappProvider');
const { contractSend } = require('../src/browser/BrowserScreen');
const DappSheet = require('../src/browser/DappSheet').default;
const { formatTokenUnits, SEND_ARM_MS } = require('../src/browser/DappSheet');
const { navigationDecision } = require('../src/browser/url');
const t = require('../src/i18n').makeT('en');

const eon = (seed) => {
  const body = `${seed.repeat(19).slice(0, 19)}eon${seed.repeat(15).slice(0, 15)}`;
  return body + sha3_256(body).slice(0, 8);
};
const QNET = eon('a');
const TO = eon('b');
const TOKEN = eon('c');
const WASM = eon('d');
const SOL = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
const SITE = 'https://games.aiqnet.io';
const DESTROY = T.CANONICAL_BURN_ADDRESS;
const vector = (name) => V.vectors.find((v) => v.name === name);

const outcome = (promise) => promise.then((result) => ({ result }), (e) => ({ code: e.code, reason: e.reason || null }));
const tick = () => new Promise((r) => setTimeout(r, 0));
const reasonOf = (fn) => {
  try {
    fn();
  } catch (e) {
    return e instanceof R.RequestError ? e.reason : `not a RequestError: ${e}`;
  }
  return 'accepted';
};

function setup(over = {}) {
  let now = 1_000_000;
  const grants = new Map();
  const views = [];
  const state = { unlocked: true, interactive: true, accounts: { qnet: QNET, solana: SOL }, walletId: QNET };
  const deps = {
    now: () => now,
    state: () => state,
    grants: {
      get: async (o) => grants.get(o) || null,
      put: async (o, walletId) => { grants.set(o, { grantedAt: now, chains: ['qnet', 'solana'], walletId }); },
      remove: async (o) => grants.delete(o),
    },
    feeNano: () => 150000,
    signMessage: jest.fn(),
    tokenInfo: jest.fn(async () => ({ standard: 'qrc20', name: 'Game Gold', symbol: 'GOLD', decimals: 6 })),
    contractKind: jest.fn(async (a) => (a === WASM ? 'contract' : a === TOKEN ? 'token' : 'none')),
    prepareSend: jest.fn(async () => ({ nonce: 5, balanceNano: '10000000000', verified: true, counterparties: [] })),
    send: jest.fn(async () => ({ txHash: 'a'.repeat(64), status: 'submitted', nonce: 5 })),
    transactionStatus: jest.fn(async () => ({ status: 'in_block', blockHeight: 42, txHash: 'b'.repeat(64) })),
    isCurrent: () => true,
    emit: () => {},
    onChange: (v) => views.push(v),
    ...over,
  };
  const p = createDappProvider(deps);
  const ctx = (origin = SITE) => ({ origin, binding: { origin, doc: 'd', id: 'x', nav: 1 } });
  const grant = (origin = SITE) => grants.set(origin, { grantedAt: now, chains: ['qnet', 'solana'], walletId: QNET });
  return { p, deps, state, ctx, grant, shown: () => views[views.length - 1], views, advance: (ms) => { now += ms; } };
}

describe('the parameters: the extension\'s forms, nothing else', () => {
  it('a transfer, legacy or typed, in canonical decimal QNC', () => {
    expect(R.parseSendParams({ to: TO, amount: '1.5' })).toEqual({ type: 'transfer', to: TO, amountNano: 1_500_000_000n });
    expect(R.parseSendParams({ type: 'transfer', to: TO, amount: '0.000000001' })).toMatchObject({ amountNano: 1n });
    for (const p of [{ to: TO, amount: '0' }, { to: TO, amount: '01' }, { to: TO.toUpperCase(), amount: '1' }, { to: TO },
      { type: 'transfer', to: TO, amount: '1', memo: 'x' }, { type: 'transfer', to: TO, amount: 1 }, null, [], 'x']) {
      expect([p, reasonOf(() => R.parseSendParams(p))]).toEqual([p, 'INVALID']);
    }
  });

  it('a token transfer: token and recipient as the chain spells them, the amount as text', () => {
    expect(R.parseSendParams({ type: 'tokenTransfer', token: TOKEN, to: TO, amount: '2.5' }))
      .toEqual({ type: 'tokenTransfer', token: TOKEN, to: TO, amount: '2.5' });
    for (const p of [
      { type: 'tokenTransfer', token: TOKEN, to: TO }, { type: 'tokenTransfer', token: 'c'.repeat(64), to: TO, amount: '1' },
      { type: 'tokenTransfer', token: TOKEN, to: TO, amount: '1e3' }, { type: 'tokenTransfer', token: TOKEN, to: TO, amount: 1 },
      { type: 'tokenTransfer', token: TOKEN, to: TO, amount: '1', decimals: 6 },
    ]) {
      expect([p, reasonOf(() => R.parseSendParams(p))]).toEqual([p, 'INVALID']);
    }
  });

  it('a contract call: method, hex input within its cap, an optional integer gas limit; value and accessList are UNSUPPORTED_PARAM', () => {
    expect(R.parseSendParams({ type: 'contractCall', contract: WASM, method: 'mint', args: '0A0b' }))
      .toEqual({ type: 'contractCall', contract: WASM, method: 'mint', args: '0a0b', gasLimit: null });
    expect(R.parseSendParams({ type: 'contractCall', contract: WASM, method: 'run', args: '', gasLimit: 200000 }))
      .toMatchObject({ args: '', gasLimit: 200000 });
    expect(reasonOf(() => R.parseSendParams({ type: 'contractCall', contract: WASM, method: 'run', args: '', value: '0' })))
      .toBe(R.UNSUPPORTED_PARAM);
    expect(reasonOf(() => R.parseSendParams({ type: 'contractCall', contract: WASM, method: 'run', args: '', accessList: [] })))
      .toBe(R.UNSUPPORTED_PARAM);
    const cap = 'ab'.repeat(R.CALL_ARGS_MAX_BYTES);
    expect(R.parseSendParams({ type: 'contractCall', contract: WASM, method: 'run', args: cap }).args).toBe(cap);
    for (const p of [
      { type: 'contractCall', contract: WASM, method: 'run' }, { type: 'contractCall', contract: WASM, method: 'run', args: 'abc' },
      { type: 'contractCall', contract: WASM, method: 'run', args: 'zz' }, { type: 'contractCall', contract: WASM, method: '1x', args: '' },
      { type: 'contractCall', contract: WASM, method: 'a'.repeat(65), args: '' }, { type: 'contractCall', contract: WASM, method: 'run', args: 7 },
      { type: 'contractCall', contract: WASM, method: 'run', args: `${cap}00` },
      { type: 'contractCall', contract: WASM, method: 'run', args: '', gasLimit: '200000' },
      { type: 'contractCall', contract: WASM, method: 'run', args: '', gasLimit: 1.5 },
      { type: 'contractCall', contract: WASM, method: 'run', args: '', deposit: 1 }, { type: 'contractDeploy', code: '00' },
    ]) {
      expect([p, reasonOf(() => R.parseSendParams(p))]).toEqual([p, 'INVALID']);
    }
  });

  it('a status request: the account and the nonce as the send\'s result gives it', () => {
    expect(R.parseStatusParams({ from: QNET, nonce: '5' })).toEqual({ from: QNET, nonce: '5' });
    for (const p of [{ from: QNET, nonce: 5 }, { from: QNET, nonce: '0' }, { from: QNET, nonce: '05' }, { from: QNET },
      { from: QNET, nonce: '18446744073709551616' }, { from: QNET, nonce: '1', txHash: 'a' }, { nonce: '1' }]) {
      expect([p, reasonOf(() => R.parseStatusParams(p))]).toEqual([p, 'INVALID']);
    }
  });

  it('units: exact, canonical, within u64', () => {
    expect(R.parseUnits('1.000001', 6)).toBe(1_000_001n);
    expect(R.parseUnits('18446744073709.551615', 6)).toBe(R.U64_MAX);
    expect(R.parseUnits('18446744073709.551616', 6)).toBe(null);
    expect(R.parseUnits('1.0000001', 6)).toBe(null);
    expect(R.parseUnits('1', 19)).toBe(null);
    expect(R.formatUnits(1_500_000n, 6)).toBe('1.5');
    expect(R.formatUnits(0n, 9)).toBe('0');
  });
});

describe('a token transfer', () => {
  it('reads the token from the chain, scales the amount by its decimals and shows what it costs', async () => {
    const s = setup();
    s.grant();
    const asked = s.p.request(s.ctx(), 'qnet_sendTransaction', { type: 'tokenTransfer', token: TOKEN, to: TO, amount: '2.50' });
    await tick();
    const tx = T.buildTokenTransfer({ from: QNET, token: TOKEN, to: TO, amount: '2500000', nonce: 1 });
    expect(s.deps.tokenInfo).toHaveBeenCalledWith(TOKEN);
    expect(s.shown()).toMatchObject({
      kind: 'send',
      details: {
        type: 'tokenTransfer', token: TOKEN, to: TO, amount: '2.5', amountBase: '2500000', symbol: 'GOLD', name: 'Game Gold',
        decimals: 6, gasLimit: tx.gasLimit, feeNano: tx.maxFeeNano, destroys: false, reservedName: false,
      },
    });
    s.deps.prepareSend.mockResolvedValueOnce({
      nonce: 5, balanceNano: '10000000000', verified: true, counterparties: [TO],
      tokenBalanceBase: '9000000', tokenVerified: true, depositNano: '10000000', listed: false,
    });
    await s.p.loadPreview(s.shown().id);
    expect(s.deps.prepareSend).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'tokenTransfer', amountBase: '2500000' }));
    expect(s.shown().preview).toMatchObject({ nonce: 5, tokenBalanceBase: '9000000', tokenVerified: true, depositNano: '10000000', listed: false });
    await s.p.approve(s.shown().id);
    expect(s.deps.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'tokenTransfer', token: TOKEN, to: TO, amountBase: '2500000', nonce: 5, choice: null }));
    expect(await asked).toEqual({ status: 'submitted', from: QNET, token: TOKEN, to: TO, amount: '2.5', nonce: '5', txHash: 'a'.repeat(64) });
  });

  it('refuses what the token cannot carry before any sheet: not a fungible token, too many decimals, a finer amount', async () => {
    const s = setup();
    s.grant();
    const ask = (amount) => outcome(s.p.request(s.ctx(), 'qnet_sendTransaction', { type: 'tokenTransfer', token: TOKEN, to: TO, amount }));
    for (const info of [null, { standard: 'qrc721', name: 'N', symbol: 'N', decimals: 0 }, { standard: 'qrc20', name: 'X', symbol: 'X', decimals: 19 }]) {
      s.deps.tokenInfo.mockResolvedValueOnce(info);
      expect(await ask('1')).toMatchObject({ code: CODES.INVALID });
    }
    for (const amount of ['1.0000001', '0', '0.000000', '18446744073710']) expect([amount, await ask(amount)]).toEqual([amount, { code: CODES.INVALID, reason: null }]);
    s.deps.tokenInfo.mockRejectedValueOnce(new Error('network'));
    expect(await ask('1')).toMatchObject({ code: CODES.INTERNAL });
    expect(s.views.filter(Boolean)).toEqual([]);
    // Without a grant the chain is not even read.
    const other = setup();
    expect(await outcome(other.p.request(other.ctx(), 'qnet_sendTransaction', { type: 'tokenTransfer', token: TOKEN, to: TO, amount: '1' })))
      .toMatchObject({ code: CODES.UNAUTHORIZED });
    expect(other.deps.tokenInfo).not.toHaveBeenCalled();
  });

  it('marks tokens sent to the destruction address, a token named after QNC, and shows the deployer\'s text without hidden characters', async () => {
    const s = setup();
    s.grant();
    s.deps.tokenInfo.mockResolvedValueOnce({ standard: 'qrc20', name: 'Q​N‮C Coin', symbol: 'QNC', decimals: 0 });
    s.p.request(s.ctx(), 'qnet_sendTransaction', { type: 'tokenTransfer', token: TOKEN, to: DESTROY, amount: '7' });
    await tick();
    expect(s.shown().details).toMatchObject({ amount: '7', amountBase: '7', destroys: true, reservedName: true, name: 'Q�N�C Coin' });
    expect(visibleLabel('x'.repeat(100), 64)).toHaveLength(64);
  });
});

describe('a contract call', () => {
  it('gives the call the intrinsic gas plus the default fuel, shows its input, and returns the extension\'s result', async () => {
    const s = setup();
    s.grant();
    const args = Buffer.from('level-up', 'utf8').toString('hex');
    const asked = s.p.request(s.ctx(), 'qnet_sendTransaction', { type: 'contractCall', contract: WASM, method: 'play', args });
    await tick();
    const tx = T.buildContractCall({ from: QNET, contract: WASM, method: 'play', args, nonce: 1 });
    expect(Number(tx.fuel)).toBe(T.WASM_DEFAULT_FUEL);
    expect(s.shown().details).toEqual({
      type: 'contractCall', contract: WASM, method: 'play', args, argsBytes: 8, argsText: 'level-up',
      gasLimit: tx.gasLimit, feeNano: tx.maxFeeNano, totalNano: tx.maxFeeNano,
    });
    // A preview never names a token for a call: the target is a contract that is no token (MB-02).
    s.deps.prepareSend.mockResolvedValueOnce({ nonce: 5, balanceNano: '10000000000', verified: true, counterparties: [], knownToken: { symbol: 'G', name: 'x' } });
    await s.p.loadPreview(s.shown().id);
    expect(s.shown().preview).not.toHaveProperty('knownToken');
    expect(s.deps.contractKind).toHaveBeenCalledWith(WASM);
    await s.p.approve(s.shown().id);
    expect(await asked).toEqual({ status: 'submitted', from: QNET, contract: WASM, method: 'play', nonce: '5', txHash: 'a'.repeat(64) });
  });

  it('takes the site\'s gas limit only within the intrinsic gas plus the least fuel and the network\'s cap', async () => {
    const s = setup();
    s.grant();
    const intrinsic = T.contractCallIntrinsicGas(T.contractCallData(WASM, 'run', ''));
    const ask = (gasLimit) => outcome(s.p.request(s.ctx(), 'qnet_sendTransaction', { type: 'contractCall', contract: WASM, method: 'run', args: '', gasLimit }));
    expect(await ask(intrinsic + T.WASM_MIN_FUEL - 1)).toMatchObject({ code: CODES.INVALID });
    expect(await ask(T.MAX_GAS_LIMIT + 1)).toMatchObject({ code: CODES.INVALID });
    ask(T.MAX_GAS_LIMIT);
    await tick();
    expect(s.shown().details).toMatchObject({ gasLimit: String(T.MAX_GAS_LIMIT), feeNano: String(15 * T.MAX_GAS_LIMIT) });
  });

  it('value and accessList: -32602 with the UNSUPPORTED_PARAM reason the page sees', async () => {
    const s = setup();
    s.grant();
    for (const extra of [{ value: '1' }, { value: '0' }, { accessList: [WASM] }]) {
      const r = await outcome(s.p.request(s.ctx(), 'qnet_sendTransaction', { type: 'contractCall', contract: WASM, method: 'run', args: '', ...extra }));
      expect(r).toEqual({ code: CODES.INVALID, reason: R.UNSUPPORTED_PARAM });
    }
    const e = await s.p.request(s.ctx(), 'qnet_sendTransaction', { type: 'contractCall', contract: WASM, method: 'run', args: '', value: '1' }).catch((x) => x);
    expect(pageError(e)).toEqual({ code: -32602, message: 'Unsupported parameter', data: { reason: 'UNSUPPORTED_PARAM' } });
    expect(pageError({ code: -32602 })).toEqual({ code: -32602, message: 'Invalid params' });
  });

  it('input text is shown only when it is visible UTF-8', () => {
    const hex = (s) => Buffer.from(s, 'utf8').toString('hex');
    expect(describeCallArgs(hex('héllo 😀'))).toEqual({ byteLength: 11, text: 'héllo 😀' });
    expect(describeCallArgs('00010203')).toEqual({ byteLength: 4, text: null });
    expect(describeCallArgs(hex('a‮b'))).toMatchObject({ text: null });
    expect(describeCallArgs('c0af')).toMatchObject({ text: null }); // overlong
    expect(describeCallArgs('eda080')).toMatchObject({ text: null }); // a surrogate
    expect(describeCallArgs('e282')).toMatchObject({ text: null }); // cut
    expect(describeCallArgs('')).toEqual({ byteLength: 0, text: null });
  });
});

describe('a QNC transfer', () => {
  it('stays within what the app keeps exactly (2^53 - 1 nano-QNC with its fee)', async () => {
    const s = setup();
    s.grant();
    const max = SAFE_AMOUNT_NANO - 150000n;
    const text = R.formatUnits(max, 9);
    const first = outcome(s.p.request(s.ctx(), 'qnet_sendTransaction', { to: TO, amount: text }));
    await tick();
    expect(s.shown().details.amountNano).toBe(max.toString());
    s.p.reject(s.shown().id);
    expect(await first).toMatchObject({ code: CODES.USER_REJECTED });
    s.advance(TIMINGS.COOLDOWN_LONG_MS);
    expect(await outcome(s.p.request(s.ctx(), 'qnet_sendTransaction', { to: TO, amount: R.formatUnits(max + 1n, 9) })))
      .toMatchObject({ code: CODES.INVALID });
  });
});

describe('qnet_getTransactionStatus', () => {
  it('answers for the connected account only, without a sheet', async () => {
    const s = setup();
    expect(await outcome(s.p.request(s.ctx(), 'qnet_getTransactionStatus', { from: QNET, nonce: '5' }))).toMatchObject({ code: CODES.UNAUTHORIZED });
    s.grant();
    expect(await outcome(s.p.request(s.ctx(), 'qnet_getTransactionStatus', { from: TO, nonce: '5' }))).toMatchObject({ code: CODES.UNAUTHORIZED });
    expect(await outcome(s.p.request(s.ctx(), 'qnet_getTransactionStatus', { from: QNET, nonce: 5 }))).toMatchObject({ code: CODES.INVALID });
    expect(await s.p.request(s.ctx(), 'qnet_getTransactionStatus', { from: QNET, nonce: '5' }))
      .toEqual({ status: 'in_block', blockHeight: 42, txHash: 'b'.repeat(64) });
    expect(s.deps.transactionStatus).toHaveBeenCalledWith({ from: QNET, nonce: '5' });
    s.state.unlocked = false;
    expect(await outcome(s.p.request(s.ctx(), 'qnet_getTransactionStatus', { from: QNET, nonce: '5' }))).toMatchObject({ code: CODES.UNAUTHORIZED });
    expect(s.views).toEqual([]);
  });

  it('reuses an answer for a few seconds, limits the reads of an origin, and says no more than the three states', async () => {
    const s = setup();
    s.grant();
    const ask = (nonce) => s.p.request(s.ctx(), 'qnet_getTransactionStatus', { from: QNET, nonce: String(nonce) });
    await ask(1);
    await ask(1);
    expect(s.deps.transactionStatus).toHaveBeenCalledTimes(1);
    s.advance(TIMINGS.STATUS_CACHE_MS);
    await ask(1);
    expect(s.deps.transactionStatus).toHaveBeenCalledTimes(2);
    for (let n = 2; n < LIMITS.STATUS_READS_PER_MINUTE; n++) await ask(n); // two reads so far, then up to the limit
    expect(await outcome(ask(999))).toMatchObject({ code: CODES.USER_REJECTED });
    expect(await ask(1)).toMatchObject({ status: 'in_block' }); // an answer still kept costs no read
    s.advance(60_000);
    s.deps.transactionStatus.mockResolvedValueOnce({ status: 'applied', blockHeight: 1, txHash: 'c'.repeat(64) });
    expect(await ask(1000)).toEqual({ status: 'unknown', blockHeight: null, txHash: null });
    s.deps.transactionStatus.mockResolvedValueOnce({ status: 'pending', blockHeight: 9, txHash: 'c'.repeat(64) });
    expect(await ask(1001)).toEqual({ status: 'pending', blockHeight: null, txHash: null });
    s.deps.transactionStatus.mockRejectedValueOnce(new Error('offline'));
    expect(await ask(1002)).toEqual({ status: 'unknown', blockHeight: null, txHash: null });
  });
});

// ---------------------------------------------------------------- the wallet's side

const reply = (body, ok = true) => Promise.resolve({ ok, status: ok ? 200 : 500, json: async () => body, text: async () => JSON.stringify(body) });

describe('the wallet signs what the sheet showed, through its own send path', () => {
  const FROM = V.wallet.address;
  let posts;
  let routes;

  function wallet() {
    const { secretKey, publicKey } = ml_dsa65.keygen(Uint8Array.from(Buffer.from(shake256(kat.seed_string, 256), 'hex')));
    const wm = new WalletManager();
    wm.loadWallet = jest.fn(async () => ({
      secretKey: new Uint8Array(64), qnetAddress: FROM, qnetKeypair: { publicKey: [...publicKey], privateKey: [...secretKey] },
    }));
    wm.getQNCBalanceWithProof = jest.fn(async () => ({ ok: true, verified: true, nonce: '3', balanceNano: '9000000000' }));
    return wm;
  }

  beforeEach(async () => {
    await AsyncStorage.clear();
    WalletManager.pkBound = { [FROM]: true };
    WalletManager.nodeHealth = {};
    posts = [];
    routes = [];
    global.fetch = jest.fn((url, opts = {}) => {
      if (opts.method === 'POST') {
        posts.push({ url, body: opts.body });
        return reply({ success: true, tx_hash: 'e'.repeat(64) });
      }
      for (const [re, answer] of routes) if (re.test(url)) return answer(url);
      if (/\/api\/v1\/account\/[^/]+$/.test(url)) return reply({ nonce: 3, has_dilithium_pk: true });
      return reply({});
    });
  });

  it('a WASM call: the shared vector\'s body, at the nonce shown, kept as a call', async () => {
    const v = vector('contractCall');
    const wm = wallet();
    // Another nonce than the one shown signs nothing.
    await expect(wm.callWasmContract({ contract: v.input.contract, method: 'run', args: '' }, 'pw', { expectNonce: 9 }))
      .rejects.toMatchObject({ code: 'NONCE_CHANGED' });
    expect(posts).toEqual([]);
    const r = await wm.callWasmContract({ contract: v.input.contract, method: v.input.method, args: v.input.args, gasLimit: Number(v.gasLimit) },
      'pw', { expectNonce: 4 });
    expect(r.submitNonce).toBe(4);
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toMatch(new RegExp(`${v.requestPath}$`));
    expect(posts[0].body).toBe(v.requestJson);
    const kept = await pendingFor(FROM);
    expect(kept.map((e) => [e.nonce, e.summary.kind, e.summary.to, e.summary.method])).toEqual([[4, 'call', v.input.contract, 'run']]);
  });

  it('a token transfer from a site: the vector\'s body through the app\'s token path, the nonce checked', async () => {
    const v = vector('tokenTransfer');
    routes.push([/\/api\/v1\/account\/[^/]+$/, () => reply({ nonce: 1, has_dilithium_pk: true })]);
    const wm = wallet();
    wm.getQNCBalanceWithProof = jest.fn(async () => ({ ok: true, verified: true, nonce: '1', balanceNano: '9000000000' }));
    await expect(contractSend(wm, { type: 'tokenTransfer', token: v.input.token, to: v.input.to, amountBase: v.input.amount }, 'pw',
      { expectNonce: 3, choice: null })).rejects.toMatchObject({ code: 'NONCE_CHANGED' });
    const r = await contractSend(wm, { type: 'tokenTransfer', token: v.input.token, to: v.input.to, amountBase: v.input.amount }, 'pw',
      { expectNonce: 2, choice: null });
    expect(r).toEqual({ success: true, txHash: 'e'.repeat(64), nonce: 2 });
    expect(posts.map((p) => p.body)).toEqual([v.requestJson]);
  });

  it('an unanswered call is unknown to the page, with the nonce it was signed at', async () => {
    const wm = wallet();
    global.fetch.mockImplementation((url, opts = {}) => {
      if (opts.method === 'POST') return Promise.reject(new Error('Network request failed'));
      return /\/api\/v1\/account\//.test(url) ? reply({ nonce: 3, has_dilithium_pk: true }) : reply({});
    });
    const r = await contractSend(wm, { type: 'contractCall', contract: WASM, method: 'run', args: '', gasLimit: '300000' }, 'pw',
      { expectNonce: 4, choice: null });
    expect(r).toEqual({ success: false, nonce: 4, refusal: null, refusalUncertain: false });
  });

  it('a token is described by what two genesis nodes agree on; a token read nested under `token`', async () => {
    const body = (over = {}) => ({
      success: true, source: 'blockchain_state',
      token: { contract_address: TOKEN, standard: 'qrc20', name: 'Game Gold', symbol: 'GOLD', decimals: 6, logo: '', total_supply: '1000', ...over },
    });
    let answers = [body(), body(), body({ decimals: 9 }), null, null];
    routes.push([/\/api\/v1\/token\//, (url) => {
      const a = answers[GENESIS_NODES.findIndex((b) => url.startsWith(b))];
      return a ? reply(a) : Promise.reject(new Error('offline'));
    }]);
    const wm = wallet();
    WalletManager.agreedTokens.clear();
    expect(await wm.agreedTokenInfo(TOKEN)).toMatchObject({ contract: TOKEN, standard: 'qrc20', symbol: 'GOLD', decimals: 6 });
    // kept for a few minutes
    answers = [null, null, null, null, null];
    expect(await wm.agreedTokenInfo(TOKEN)).toMatchObject({ decimals: 6 });
    WalletManager.agreedTokens.clear();
    await expect(wm.agreedTokenInfo(TOKEN)).rejects.toMatchObject({ code: 'TOKEN_UNAVAILABLE' });
    answers = [body(), body({ decimals: 9 }), body({ symbol: 'G0LD' }), null, null];
    await expect(wm.agreedTokenInfo(TOKEN)).rejects.toMatchObject({ code: 'TOKEN_UNAVAILABLE' });
    const miss = { success: false, error: 'Token not found', contract_address: TOKEN };
    answers = [miss, miss, body(), null, null];
    expect(await wm.agreedTokenInfo(TOKEN)).toBe(null);
    // The Add-Token read takes the nested answer, and refuses another contract's.
    answers = [body(), body(), body(), body(), body()];
    expect(await wm.getTokenInfo(TOKEN)).toMatchObject({ contract: TOKEN, name: 'Game Gold', symbol: 'GOLD', decimals: 6 });
    answers = Array(5).fill(body({ contract_address: WASM }));
    expect(await wm.getTokenInfo(TOKEN)).toBe(null);
  });

  describe('where a transaction at (from, nonce) stands', () => {
    const H = '7'.repeat(64);
    const row = (over = {}) => ({ hash: H, from: FROM, to: TO, amount: 1500000000, nonce: 4, type: 'transfer', ...over });
    const setRoutes = ({ nonce = 4, lists = [[row()], [row()], [row()]], tx = { status: 'found', transaction: { hash: H, status: 'confirmed', block_height: 777 } } } = {}) => {
      let served = 0;
      routes.push([/\/api\/v1\/account\/[^/]+$/, () => reply({ nonce, has_dilithium_pk: true })]);
      routes.push([/\/transactions\/history/, () => reply({ transactions: lists[served++] || [] })]);
      routes.push([/\/api\/v1\/transaction\//, () => reply(tx)]);
    };
    const entry = (over = {}) => ({
      from: FROM, nonce: 5, path: '/api/v1/transaction', body: { n: 5 }, pk: null,
      summary: { kind: 'transfer', to: TO, amountNano: 1500000000, method: null }, createdAt: Date.now(), ...over,
    });

    it('pending while the account has not reached it and the wallet keeps it; unknown when it keeps nothing', async () => {
      setRoutes();
      const wm = wallet();
      expect(await wm.transactionStatusAt(FROM, 5)).toEqual({ status: 'unknown', blockHeight: null, txHash: null });
      await putSigned(entry());
      expect(await wm.transactionStatusAt(FROM, 5)).toEqual({ status: 'pending', blockHeight: null, txHash: null });
    });

    it('in a block once two genesis nodes list the same transaction there, with its height', async () => {
      setRoutes({ lists: [[row()], [row(), row({ hash: '8'.repeat(64), nonce: 3 })], []] });
      const wm = wallet();
      expect(await wm.transactionStatusAt(FROM, 4)).toEqual({ status: 'in_block', blockHeight: 777, txHash: H });
    });

    it('unknown when only one node lists it, or the one listed is not what this wallet signed there', async () => {
      setRoutes({ lists: [[row()], [], []] });
      const wm = wallet();
      expect(await wm.transactionStatusAt(FROM, 4)).toMatchObject({ status: 'unknown' });
      routes.length = 0;
      setRoutes();
      await putSigned(entry({ nonce: 4, summary: { kind: 'transfer', to: TOKEN, amountNano: 1, method: null } }));
      expect(await wm.transactionStatusAt(FROM, 4)).toMatchObject({ status: 'unknown' });
    });

    it('a height the node does not give stays null', async () => {
      setRoutes({ tx: { status: 'found', transaction: { hash: H, status: 'pending', block_height: null } } });
      expect(await wallet().transactionStatusAt(FROM, 4)).toEqual({ status: 'in_block', blockHeight: null, txHash: H });
    });
  });
});

// ---------------------------------------------------------------- the sheet

describe('the sheet of a token transfer and of a contract call', () => {
  const texts = (tree) => tree.root.findAllByType(Text).map((n) => [].concat(n.props.children).filter((c) => typeof c === 'string' || typeof c === 'number').join('')).join('\n');
  const button = (tree, label) => tree.root.findAllByType(TouchableOpacity)
    .find((b) => b.findAllByType(Text).map((n) => [].concat(n.props.children).join('')).join('') === label);
  const wait = (ms) => act(() => new Promise((r) => { setTimeout(r, ms); }));
  const mounted = [];
  afterEach(async () => { await act(async () => { while (mounted.length) mounted.pop().unmount(); }); });

  async function mount(view) {
    const props = {
      view, t, accounts: { qnet: QNET, solana: SOL }, authenticate: jest.fn(async () => true),
      actions: { approve: jest.fn(async () => ({ status: 'done' })), reject: jest.fn(), dismiss: jest.fn(), loadPreview: jest.fn() },
    };
    let tree;
    await act(async () => { tree = renderer.create(<DappSheet {...props} />); });
    mounted.push(tree);
    return { tree, props };
  }
  const base = { id: 't1', kind: 'send', origin: SITE, busy: false, queued: 0, outcome: null };
  const token = {
    type: 'tokenTransfer', token: TOKEN, to: TO, amount: '2.5', amountBase: '2500000', symbol: 'GOLD', name: 'Game Gold', decimals: 6,
    gasLimit: '100750', feeNano: '1511250', destroys: false, reservedName: false,
  };

  it('a token: its name and contract, the amount in its units and base units, the fee, the deposit, both balances', async () => {
    const preview = {
      nonce: 5, balanceNano: '1000000', verified: true, counterparties: [], tokenBalanceBase: '2000000', tokenVerified: true,
      depositNano: '10000000', listed: false,
    };
    const { tree, props } = await mount({ ...base, details: token, preview });
    const shown = texts(tree);
    for (const s of ['Send a token', 'GOLD · Game Gold', TOKEN, TO, '2.5 GOLD', '2500000', '0.00151125 QNC',
      '0.01 QNC', '0.01151125 QNC', t('dapp_token_unlisted'), t('dapp_token_balance'), '2 GOLD',
      t('dapp_token_insufficient'), t('dapp_send_insufficient'), t('dapp_send_first_time')]) {
      expect([s, shown.includes(s)]).toEqual([s, true]);
    }
    expect(shown).not.toContain(t('dapp_token_destroyed'));
    // No line on where the token's details come from, what the deposit is, or whether a balance was proven.
    expect(shown).not.toMatch(/no proof covers|refundable deposit for the new balance|(verified)|Transaction number/);
    // Too little of the token and of QNC: the send is not offered (MB-08).
    await wait(SEND_ARM_MS + 100);
    expect(button(tree, 'Send').props.disabled).toBe(true);
    const enough = await mount({ ...base, id: 't1b', details: token, preview: { ...preview, balanceNano: '1000000000', tokenBalanceBase: '9000000' } });
    await wait(SEND_ARM_MS + 100);
    const confirm = button(enough.tree, 'Send').props;
    expect(confirm.disabled).toBe(false);
    await act(async () => { confirm.onPressIn(); await confirm.onPress(); });
    expect(enough.props.authenticate).toHaveBeenCalledWith('Send 2.5 GOLD', null, TO);
    expect(enough.props.actions.approve).toHaveBeenCalledWith('t1b', null);
    expect(props.actions.approve).not.toHaveBeenCalled();
  });

  it('a token sent to the destruction address or named after QNC says so; decimals the token list records otherwise stop it', async () => {
    const { tree } = await mount({ ...base, details: { ...token, to: DESTROY, destroys: true, reservedName: true },
      preview: { nonce: 5, balanceNano: '1000000000', verified: false, counterparties: [], tokenBalanceBase: null, depositNano: '0', listed: true } });
    const shown = texts(tree);
    expect(shown).toContain(t('dapp_token_destroyed'));
    expect(shown).toContain(t('tok_reserved_warning'));
    expect(shown).not.toContain(t('dapp_token_unlisted'));
    expect(shown).not.toContain(t('dapp_token_deposit'));
    const stopped = await mount({ ...base, id: 't2', details: token, preview: null, previewError: 'TOKEN_DECIMALS' });
    expect(texts(stopped.tree)).toContain(t('dapp_token_decimals_differ'));
    expect(formatTokenUnits('1', 6)).toBe('0.000001');
    expect(formatTokenUnits(null, 6)).toBe('—');
  });

  it('a call: the contract (always "unknown"), the method, the input with its size and text, the gas and the most it costs', async () => {
    const call = {
      type: 'contractCall', contract: WASM, method: 'play', args: '6c6576656c2d7570', argsBytes: 8, argsText: 'level-up',
      gasLimit: '300490', feeNano: '4507350', totalNano: '4507350',
    };
    const { tree, props } = await mount({ ...base, details: call, preview: { nonce: 5, balanceNano: '9000000000', verified: true, counterparties: [] } });
    const shown = texts(tree);
    for (const s of ['Call a contract', WASM, t('dapp_call_unknown'), 'play', 'Input (8 bytes, hex)', '6c6576656c2d7570', 'level-up', '300490',
      '0.00450735 QNC']) {
      expect([s, shown.includes(s)]).toEqual([s, true]);
    }
    expect(shown).not.toMatch(/gas the call does not use/);
    await wait(SEND_ARM_MS + 100);
    const confirm = button(tree, 'Confirm call').props;
    await act(async () => { confirm.onPressIn(); await confirm.onPress(); });
    expect(props.authenticate).toHaveBeenCalledWith(`Call play for ${new URL(SITE).host}`, null, WASM);
    // Too little QNC for its fee: the call is not offered (MB-08), and no preview ever calms the target down (MB-02).
    const short = await mount({ ...base, id: 't3', details: call, preview: { nonce: 5, balanceNano: '1', verified: true, counterparties: [], knownToken: { symbol: 'GOLD', name: 'Game Gold' } } });
    expect(texts(short.tree)).toContain(t('dapp_call_unknown'));
    expect(texts(short.tree)).toContain(t('dapp_send_insufficient'));
    await wait(SEND_ARM_MS + 100);
    expect(button(short.tree, 'Confirm call').props.disabled).toBe(true);
  });
});

describe('games.aiqnet.io', () => {
  it('opens in the in-app browser like any https site; the provider needs no list of sites', () => {
    expect(navigationDecision('https://games.aiqnet.io/', { topFrame: true })).toMatchObject({ allow: true });
    expect(navigationDecision('https://games.aiqnet.io/play/1?x=2', { topFrame: true })).toMatchObject({ allow: true });
  });
});
