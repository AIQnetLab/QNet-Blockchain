// Sign-in: the page's text, the wallet's signature over it for the page's origin (built here independently from the
// protocol: header, origin, byte length, text, FIPS 204 context QNET_OFFCHAIN_MSG_v1) and the server's verifySignIn.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import * as sdk from '../dist/index.js';
import { V } from './helpers.mjs';

const ORIGIN = 'https://games.aiqnet.io';
const golden = sdk.keypairFromRecoveryPhrase(V.wallet.mnemonic);
const other = sdk.keypairFromEntropy(new Uint8Array(16).fill(3));
const ISSUED = new Date('2026-09-26T10:00:00Z');
// The id of the visitor's session the nonce was issued in, and another visitor's.
const SESSION = 's'.repeat(32);
const ELSEWHERE = 'e'.repeat(32);

function walletSign(origin, message, keys = golden) {
  const body = utf8ToBytes(message);
  const bytes = utf8ToBytes(`QNet Signed Message:\n${origin}\n${body.length}\n${message}`);
  const signature = ml_dsa65.sign(bytes, keys.secretKey, { context: utf8ToBytes('QNET_OFFCHAIN_MSG_v1') });
  return { message, signature: bytesToHex(signature), publicKey: bytesToHex(keys.publicKey), address: sdk.addressFromPublicKey(keys.publicKey) };
}

function setup({ address = golden.address, statement, ttlMs, origin = ORIGIN, issuedAt = ISSUED } = {}) {
  const store = sdk.createNonceStore({ now: () => ISSUED.getTime() + 1000 });
  const nonce = store.issue(SESSION);
  const message = sdk.createSignInMessage({ origin, address, nonce, statement, ttlMs, issuedAt });
  return { store, nonce, message };
}

const options = (store, extra = {}, session = SESSION) => ({ origin: ORIGIN, consumeNonce: (n) => store.consume(n, session), now: ISSUED.getTime() + 5000, ...extra });

async function refusal(promise) {
  try {
    await promise;
  } catch (error) {
    return error instanceof sdk.QNetError ? error.code : `not a QNetError: ${error}`;
  }
  return 'no error';
}

describe('sign-in', () => {
  it('writes the text the wallet shows', () => {
    const { message, nonce } = setup({ statement: 'Sign in to play' });
    assert.equal(message, [
      'Sign in to games.aiqnet.io',
      'Sign in to play',
      '',
      `Account: ${golden.address}`,
      'Chain: q1337',
      `Nonce: ${nonce}`,
      'Issued at: 2026-09-26T10:00:00Z',
      'Expires at: 2026-09-26T10:10:00Z',
    ].join('\n'));
    assert.deepEqual(sdk.parseSignInMessage(message).statement, 'Sign in to play');
  });

  it('accepts a valid sign-in once', async () => {
    const { store, message, nonce } = setup();
    const fields = await sdk.verifySignIn(walletSign(ORIGIN, message), options(store));
    assert.equal(fields.address, golden.address);
    assert.equal(fields.nonce, nonce);
    assert.equal(fields.domain, 'games.aiqnet.io');
  });

  it('refuses a replay of the same signed text', async () => {
    const { store, message } = setup();
    const signed = walletSign(ORIGIN, message);
    await sdk.verifySignIn(signed, options(store));
    assert.equal(await refusal(sdk.verifySignIn(signed, options(store))), 'SIGNIN_REPLAYED');
  });

  it('refuses a nonce the server never issued', async () => {
    const store = sdk.createNonceStore();
    const message = sdk.createSignInMessage({ origin: ORIGIN, address: golden.address, nonce: 'a'.repeat(32), issuedAt: ISSUED });
    assert.equal(await refusal(sdk.verifySignIn(walletSign(ORIGIN, message), options(store))), 'SIGNIN_REPLAYED');
  });

  it('refuses a text that names another site', async () => {
    const { store, message } = setup({ origin: 'https://evil.example' });
    assert.equal(await refusal(sdk.verifySignIn(walletSign('https://evil.example', message), options(store))), 'SIGNIN_WRONG_DOMAIN');
  });

  it('refuses a signature the wallet made for another origin', async () => {
    const { store, message } = setup();
    // The text names this site, but the wallet signed it on another page.
    assert.equal(await refusal(sdk.verifySignIn(walletSign('https://evil.example', message), options(store))), 'SIGNIN_BAD_SIGNATURE');
  });

  it('refuses an expired text and one not valid yet', async () => {
    const { store, message } = setup();
    const signed = walletSign(ORIGIN, message);
    assert.equal(await refusal(sdk.verifySignIn(signed, options(store, { now: ISSUED.getTime() + 10 * 60 * 1000 }))), 'SIGNIN_EXPIRED');
    assert.equal(await refusal(sdk.verifySignIn(signed, options(store, { now: ISSUED.getTime() - 5 * 60 * 1000 }))), 'SIGNIN_NOT_YET_VALID');
    // Neither refusal used the nonce up.
    assert.equal((await sdk.verifySignIn(signed, options(store))).address, golden.address);
  });

  it('refuses a key that is not the named account\'s', async () => {
    const { store, message } = setup();
    assert.equal(await refusal(sdk.verifySignIn(walletSign(ORIGIN, message, other), options(store))), 'SIGNIN_WRONG_ADDRESS');
    const signed = walletSign(ORIGIN, message);
    assert.equal(await refusal(sdk.verifySignIn({ ...signed, address: other.address }, options(store))), 'SIGNIN_WRONG_ADDRESS');
  });

  it('refuses a changed text, a changed signature and another network', async () => {
    const { store, message } = setup();
    const signed = walletSign(ORIGIN, message);
    const changed = message.replace('Expires at: 2026-09-26T10:10:00Z', 'Expires at: 2026-09-26T10:11:00Z');
    assert.equal(await refusal(sdk.verifySignIn({ ...signed, message: changed }, options(store))), 'SIGNIN_BAD_SIGNATURE');
    const sig = `${signed.signature.slice(0, 10)}${signed.signature[10] === '0' ? '1' : '0'}${signed.signature.slice(11)}`;
    assert.equal(await refusal(sdk.verifySignIn({ ...signed, signature: sig }, options(store))), 'SIGNIN_BAD_SIGNATURE');
    assert.equal(await refusal(sdk.verifySignIn(signed, options(store, { chainId: 'q7' }))), 'SIGNIN_WRONG_CHAIN');
  });

  it('refuses a text valid for longer than the server allows', async () => {
    const { store, message } = setup({ ttlMs: 60 * 60 * 1000 });
    assert.equal(await refusal(sdk.verifySignIn(walletSign(ORIGIN, message), options(store, { maxValidityMs: 15 * 60 * 1000 }))),
      'SIGNIN_TOO_LONG_LIVED');
  });

  it('parses only the exact text it writes', () => {
    const { message } = setup();
    for (const bad of [
      `${message}\n`,
      message.replace(/\n/g, '\r\n'),
      message.replace('Sign in to games.aiqnet.io', 'Sign in to GAMES.aiqnet.io'),
      message.replace('Chain: q1337', 'Chain:  q1337'),
      message.replace('Sign in to games.aiqnet.io\n', 'Sign in to games.aiqnet.io\n‮evil\n'),
      message.replace('Issued at: 2026-09-26T10:00:00Z', 'Issued at: 2026-09-26T10:00:00.000Z'),
      `Please sign\n${message}`,
    ]) {
      assert.throws(() => sdk.parseSignInMessage(bad), (e) => e.code === 'SIGNIN_MALFORMED', JSON.stringify(bad.slice(0, 60)));
    }
  });

  it('refuses to write a text with a bad field', () => {
    const base = { origin: ORIGIN, address: golden.address, nonce: 'a'.repeat(32) };
    for (const bad of [{ address: 'x' }, { nonce: 'short' }, { statement: 'two\nlines' }, { statement: 'hidden​char' },
      { origin: 'https://games.aiqnet.io/path' }, { ttlMs: 25 * 60 * 60 * 1000 }]) {
      assert.throws(() => sdk.createSignInMessage({ ...base, ...bad }), (e) => e.code === 'SIGNIN_MALFORMED', JSON.stringify(bad));
    }
  });

  it('keeps a nonce only until it is used or expires', () => {
    let t = 0;
    const store = sdk.createNonceStore({ ttlMs: 1000, now: () => t });
    const a = store.issue(SESSION);
    const b = store.issue(SESSION);
    assert.notEqual(a, b);
    assert.equal(store.consume(a, SESSION), true);
    assert.equal(store.consume(a, SESSION), false);
    t = 1000;
    assert.equal(store.consume(b, SESSION), false);
    assert.equal(store.consume('never-issued', SESSION), false);
  });

  // DEVP-R1-04: anyone can ask a site for nonces; a full store drops its oldest instead of refusing everyone.
  it('drops the oldest nonce when full instead of refusing to issue', () => {
    const t = 0;
    const store = sdk.createNonceStore({ ttlMs: 1000, max: 3, now: () => t });
    const issued = Array.from({ length: 5 }, () => store.issue(SESSION));
    assert.equal(new Set(issued).size, 5);
    assert.deepEqual(issued.map((n) => store.consume(n, SESSION)), [false, false, true, true, true]);
    const flood = sdk.createNonceStore({ max: 100 });
    for (let i = 0; i < 1000; i += 1) flood.issue(SESSION);
    const mine = flood.issue(SESSION);
    assert.equal(flood.consume(mine, SESSION), true);
    for (const max of [0, -1, 1.5, Number.NaN]) {
      assert.throws(() => sdk.createNonceStore({ max }), (e) => e.code === 'INVALID_INTEGER', String(max));
    }
  });

  // DEVP-R2-02: a full store used to sweep every live nonce on each issue (about 15 ms at the default 100,000), so a
  // flood that kept it full held the server's event loop. The sweep now stops at the first nonce that has not expired.
  it('issues as fast from a full store as from an empty one, and still drops the expired first', () => {
    let t = 0;
    const max = 20_000;
    const store = sdk.createNonceStore({ ttlMs: 60_000, max, now: () => t });
    const time = (n) => {
      const start = process.hrtime.bigint();
      for (let i = 0; i < n; i += 1) store.issue(SESSION);
      return Number(process.hrtime.bigint() - start) / 1e6;
    };
    const empty = time(2_000);
    time(max);
    const full = time(2_000);
    // A full sweep of 20,000 entries per issue would take seconds for these 2,000; the bounded one takes about as long
    // as issuing from an emptier store.
    assert.ok(full < Math.max(1_000, empty * 10), `2,000 issues from a full store took ${full.toFixed(0)} ms (from an emptier one ${empty.toFixed(0)} ms)`);
    // The expired ones go first, before the store drops a live one.
    const soon = sdk.createNonceStore({ ttlMs: 1000, max: 3, now: () => t });
    const old = [soon.issue(SESSION), soon.issue(SESSION)];
    t += 1000;
    const fresh = [soon.issue(SESSION), soon.issue(SESSION), soon.issue(SESSION)];
    assert.deepEqual([...old, ...fresh].map((n) => soon.consume(n, SESSION)), [false, false, true, true, true]);
  });

  // DEVP-R4-04: a sign-in someone made with his own wallet for this site and replays into another visitor's browser
  // (a cross-site post of his signed text) carries a nonce issued to his session: it is refused there, and stays
  // usable in the session it was issued to.
  it('accepts a nonce only from the session it was issued to', async () => {
    const { store, message } = setup();
    const signed = walletSign(ORIGIN, message);
    assert.equal(await refusal(sdk.verifySignIn(signed, options(store, {}, ELSEWHERE))), 'SIGNIN_REPLAYED');
    for (const missing of [undefined, '', 'short', 7]) {
      const bare = { ...options(store), consumeNonce: (n) => store.consume(n, missing) };
      assert.equal(await refusal(sdk.verifySignIn(signed, bare)), 'SIGNIN_REPLAYED', String(missing));
    }
    assert.equal((await sdk.verifySignIn(signed, options(store))).address, golden.address);
    assert.equal(await refusal(sdk.verifySignIn(signed, options(store))), 'SIGNIN_REPLAYED');
    // No nonce without a binding a server could have taken from its own session.
    const bare = sdk.createNonceStore();
    for (const bad of [undefined, '', 'x'.repeat(sdk.NONCE_BINDING_MIN_CHARS - 1), 'x'.repeat(sdk.NONCE_BINDING_MAX_CHARS + 1), 12345678901234567]) {
      assert.throws(() => bare.issue(bad), (e) => e.code === 'INVALID_BINDING', String(bad));
    }
    const mine = bare.issue(SESSION);
    assert.equal(bare.consume(mine, ELSEWHERE), false);
    assert.equal(bare.consume(mine), false);
    assert.equal(bare.consume(mine, SESSION), true);
    assert.equal(bare.consume(mine, SESSION), false);
  });

  it('requires a nonce check', async () => {
    const { message } = setup();
    assert.equal(await refusal(sdk.verifySignIn(walletSign(ORIGIN, message), { origin: ORIGIN })), 'SIGNIN_REPLAYED');
  });
});
