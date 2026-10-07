// The page side: finding the wallet by its announcement, the exact requests each call sends, what the SDK accepts
// back, error codes, events, and a sign-in the server accepts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import * as sdk from '../dist/index.js';
import { V, vector } from './helpers.mjs';

const QNET = V.wallet.address;
const SOLANA = '11111111111111111111111111111111';
const TO = vector('transfer').input.to;
const TOKEN = vector('tokenTransfer').input.token;
const ORIGIN = 'https://games.aiqnet.io';

// A wallet that records requests and answers from `answers[method]` (a value or a function of the params).
function fakeWallet(answers = {}) {
  const calls = [];
  const listeners = new Map();
  const provider = {
    isQNet: true,
    async request({ method, params }) {
      calls.push({ method, params });
      const a = answers[method];
      if (a instanceof Error || (a && typeof a === 'object' && 'code' in a && !('qnet' in a))) throw a;
      return typeof a === 'function' ? a(params) : a;
    },
    on(event, fn) {
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      return provider;
    },
    removeListener(event, fn) {
      listeners.set(event, (listeners.get(event) ?? []).filter((f) => f !== fn));
      return provider;
    },
    emit(event, data) {
      for (const fn of listeners.get(event) ?? []) fn(data);
    },
  };
  return { provider, calls, wallet: new sdk.QNetWallet(provider) };
}

function announcingPage(detail) {
  const page = new EventTarget();
  page.addEventListener('qnet:requestProvider', () => {
    page.dispatchEvent(new CustomEvent('qnet:announceProvider', { detail }));
  });
  return page;
}

async function refusal(promise) {
  try {
    await promise;
  } catch (error) {
    return error instanceof sdk.QNetError ? error.code : `not a QNetError: ${error}`;
  }
  return 'no error';
}

const sent = { status: 'submitted', from: QNET, to: TO, amount: '1.5', nonce: 7, txHash: 'ab'.repeat(32) };

describe('wallet on a page', () => {
  it('is found by its announcement', async () => {
    const { provider } = fakeWallet();
    const page = announcingPage({ info: { uuid: 'u1', name: 'QNet Wallet', rdns: 'io.aiqnet.wallet', channel: 'mobile' }, provider });
    const wallet = await sdk.findWallet({ target: page });
    assert.equal(wallet.provider, provider);
    assert.equal(wallet.channel, 'mobile');
  });

  it('ignores other announcements, and takes window.qnet only when none came', async () => {
    const { provider } = fakeWallet();
    const page = announcingPage({ info: { uuid: 'u1', rdns: 'com.example.other' }, provider });
    assert.equal(await sdk.findWallet({ target: page, timeoutMs: 50 }), null);
    const withAlias = new EventTarget();
    withAlias.qnet = provider;
    const wallet = await sdk.findWallet({ target: withAlias, timeoutMs: 50 });
    assert.equal(wallet.provider, provider);
    assert.equal(wallet.channel, 'extension');
  });

  it('connects and reads the approved accounts', async () => {
    const { wallet, calls } = fakeWallet({ qnet_requestAccounts: { qnet: QNET, solana: SOLANA }, qnet_accounts: {} });
    assert.deepEqual(await wallet.connect(), { qnet: QNET, solana: SOLANA });
    assert.equal(await wallet.accounts(), null);
    assert.deepEqual(calls.map((c) => c.method), ['qnet_requestAccounts', 'qnet_accounts']);
    const bad = fakeWallet({ qnet_requestAccounts: { qnet: QNET.toUpperCase(), solana: SOLANA } });
    assert.equal(await refusal(bad.wallet.connect()), 'INVALID_RESPONSE');
  });

  it('turns wallet refusals into provider errors', async () => {
    const cooldown = Object.assign(new Error('Too many rejected requests from this site, try again later'), { code: 4001 });
    const { wallet } = fakeWallet({ qnet_requestAccounts: cooldown, qnet_accounts: { code: 4100, message: 'Unauthorized' } });
    const e = await wallet.connect().catch((x) => x);
    assert.ok(e instanceof sdk.QNetProviderError);
    assert.deepEqual([e.code, e.providerCode, e.cooldown], ['USER_REJECTED', 4001, true]);
    const u = await wallet.accounts().catch((x) => x);
    assert.deepEqual([u.code, u.providerCode, u.cooldown], ['UNAUTHORIZED', 4100, false]);
  });

  it('sends each transaction kind with exactly its parameters', async () => {
    const { wallet, calls } = fakeWallet({ qnet_sendTransaction: sent });
    assert.deepEqual(await wallet.sendTransfer({ to: TO, amount: '1.5' }), { status: 'submitted', from: QNET, nonce: '7', txHash: 'ab'.repeat(32) });
    await wallet.sendTokenTransfer({ token: TOKEN, to: TO, amount: '0.25' });
    await wallet.callContract({ contract: TOKEN, method: 'mint', args: 'ABCD', gasLimit: 300000 });
    await wallet.callContract({ contract: TOKEN, method: 'run' });
    assert.deepEqual(calls.map((c) => c.params), [
      { type: 'transfer', to: TO, amount: '1.5' },
      { type: 'tokenTransfer', token: TOKEN, to: TO, amount: '0.25' },
      { type: 'contractCall', contract: TOKEN, method: 'mint', args: 'abcd', gasLimit: 300000 },
      { type: 'contractCall', contract: TOKEN, method: 'run', args: '' },
    ]);
  });

  it('refuses bad parameters before asking the wallet', async () => {
    const { wallet, calls } = fakeWallet({ qnet_sendTransaction: sent });
    assert.equal(await refusal(wallet.sendTransfer({ to: 'nope', amount: '1' })), 'INVALID_ADDRESS');
    assert.equal(await refusal(wallet.sendTransfer({ to: TO, amount: '0' })), 'INVALID_AMOUNT');
    assert.equal(await refusal(wallet.sendTransfer({ to: TO, amount: '1e3' })), 'INVALID_AMOUNT');
    assert.equal(await refusal(wallet.callContract({ contract: TOKEN, method: 'x-y' })), 'INVALID_METHOD');
    assert.equal(await refusal(wallet.callContract({ contract: TOKEN, method: 'run', args: 'abc' })), 'INVALID_ARGS');
    assert.equal(await refusal(wallet.callContract({ contract: TOKEN, method: 'run', args: '00'.repeat(4097) })), 'INVALID_ARGS');
    assert.equal(await refusal(wallet.callContract({ contract: TOKEN, method: 'run', gasLimit: 1.5 })), 'INVALID_GAS_LIMIT');
    assert.equal(await refusal(wallet.callContract({ contract: TOKEN, method: 'run', gasLimit: 1_000_001 })), 'INVALID_GAS_LIMIT');
    assert.equal(calls.length, 0);
  });

  it('checks what the wallet answers a send', async () => {
    for (const bad of [{ ...sent, txHash: 'xyz' }, { ...sent, from: 'someone' }, { ...sent, nonce: 0 }, null]) {
      const { wallet } = fakeWallet({ qnet_sendTransaction: bad });
      assert.equal(await refusal(wallet.sendTransfer({ to: TO, amount: '1' })), 'INVALID_RESPONSE');
    }
    const { wallet } = fakeWallet({ qnet_sendTransaction: { ...sent, status: 'unknown', txHash: null } });
    assert.equal((await wallet.sendTransfer({ to: TO, amount: '1' })).txHash, null);
  });

  it('asks where a transaction stands by its sender and nonce', async () => {
    const answer = (p) => (p.nonce === '7'
      ? { status: 'in_block', from: QNET, nonce: '7', txHash: 'cd'.repeat(32), blockHeight: 2210001 }
      : { status: 'pending', from: QNET, nonce: p.nonce, txHash: null, blockHeight: null });
    const { wallet, calls } = fakeWallet({ qnet_getTransactionStatus: answer });
    assert.deepEqual(await wallet.getTransactionStatus({ from: QNET, nonce: 7 }), { status: 'in_block', blockHeight: 2210001, txHash: 'cd'.repeat(32) });
    assert.deepEqual(await wallet.getTransactionStatus({ from: QNET, nonce: '8' }), { status: 'pending', blockHeight: null, txHash: null });
    assert.equal(await refusal(wallet.getTransactionStatus({ from: QNET, nonce: 0 })), 'INVALID_NONCE');
    assert.deepEqual(calls[0].params, { from: QNET, nonce: '7' });
    const odd = fakeWallet({ qnet_getTransactionStatus: { status: 'confirmed' } });
    assert.equal(await refusal(odd.wallet.getTransactionStatus({ from: QNET, nonce: 1 })), 'INVALID_RESPONSE');
  });

  it('passes account changes on, and stops when unsubscribed', () => {
    const { wallet, provider } = fakeWallet();
    const seen = [];
    const off = wallet.on('accountsChanged', (a) => seen.push(a));
    provider.emit('accountsChanged', { qnet: QNET, solana: SOLANA });
    provider.emit('accountsChanged', {});
    off();
    provider.emit('accountsChanged', {});
    assert.deepEqual(seen, [{ qnet: QNET, solana: SOLANA }, null]);
  });

  it('signs in: the page\'s text, the wallet\'s signature, the server\'s check', async () => {
    const keys = sdk.keypairFromRecoveryPhrase(V.wallet.mnemonic);
    const signMessage = ({ message }) => {
      const body = utf8ToBytes(message);
      const bytes = utf8ToBytes(`QNet Signed Message:\n${ORIGIN}\n${body.length}\n${message}`);
      const signature = ml_dsa65.sign(bytes, keys.secretKey, { context: utf8ToBytes('QNET_OFFCHAIN_MSG_v1') });
      return { signature: bytesToHex(signature), publicKey: bytesToHex(keys.publicKey), address: keys.address };
    };
    const { wallet } = fakeWallet({
      qnet_requestAccounts: { qnet: QNET, solana: SOLANA },
      qnet_chainId: { chainId: 'q1337', network: 'testnet' },
      qnet_signMessage: signMessage,
    });
    const store = sdk.createNonceStore();
    const session = 'c'.repeat(32);
    const signed = await wallet.signIn({ nonce: store.issue(session), statement: 'Sign in to play', origin: ORIGIN });
    const fields = await sdk.verifySignIn(signed, { origin: ORIGIN, consumeNonce: (n) => store.consume(n, session) });
    assert.equal(fields.address, QNET);
    assert.equal(fields.statement, 'Sign in to play');
  });
});
