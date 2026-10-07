/**
 * One tap must never produce two transactions that can both apply. The next nonce comes from an account
 * nonce the wallet can stand behind (a QC-verified proof, or two genesis nodes agreeing), plus this wallet's
 * own signed-but-unsettled transactions; a node's error is "unknown", not "failed"; a retry resends the same
 * bytes; and a new transaction takes an unresolved one's nonce instead of a higher one, so a node that says
 * "error" and keeps the signed bytes gains nothing (MOB-SIGN-01/02/03).
 */
jest.mock('../src/crypto/DilithiumCrypto', () => ({
  isDilithiumAvailable: () => true,
  signDetached: jest.fn(async (message) => `sig(${message})`),
  verifyDilithium: jest.fn(),
}));

const AsyncStorage = require('@react-native-async-storage/async-storage');
const { sha3_256 } = require('js-sha3');
const { signDetached } = require('../src/crypto/DilithiumCrypto');
const { WalletManager } = require('../src/components/WalletManager');
const {
  planNonce, pendingFor, updateEntry, TooManyPendingError, HELD_MS, PendingChoiceError, PendingSettledError,
  PendingChangedError,
} = require('../src/services/PendingTx');
const { GENESIS_NODES } = require('../src/config/nodes');

const eon = (seed) => {
  const body = `${seed.repeat(19).slice(0, 19)}eon${seed.repeat(15).slice(0, 15)}`;
  return body + sha3_256(body).slice(0, 8);
};
const ME = eon('a');
const TO = eon('b');
const WALLET = {
  secretKey: new Uint8Array(64).fill(3), qnetAddress: ME,
  qnetKeypair: { publicKey: Array(1952).fill(1), privateKey: Array(4032).fill(2) },
};

let posts;       // every POST: { url, body }
let submit;      // (body, url) => reply for POST /api/v1/transaction
let accounts;    // per genesis base: the /account answer (or null = unreachable)

const reply = (body) => Promise.resolve({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  WalletManager.pkBound = {};
  WalletManager.nodeHealth = {};
  posts = [];
  accounts = Object.fromEntries(GENESIS_NODES.map((g) => [g, { nonce: 4, has_dilithium_pk: false }]));
  submit = () => ({ success: false, error: 'nonce too low' });
  global.fetch = jest.fn((url, opts = {}) => {
    const base = GENESIS_NODES.find((g) => url.startsWith(`${g}/`));
    if (opts.method === 'POST') {
      const body = JSON.parse(opts.body);
      posts.push({ url, body });
      return reply(submit(body, url));
    }
    if (/\/api\/v1\/account\/[^/]+$/.test(url)) {
      const a = base && accounts[base];
      return a ? reply(a) : Promise.reject(new TypeError('Network request failed'));
    }
    return reply({});
  });
});

function wallet({ verifiedNonce = 4 } = {}) {
  const wm = new WalletManager();
  wm.loadWallet = jest.fn(async () => WALLET);
  wm.getQNCBalanceWithProof = jest.fn(async () => (verifiedNonce == null
    ? { ok: true, verified: false, nonce: '999' }
    : { ok: true, verified: true, nonce: String(verifiedNonce) }));
  return wm;
}

const signedNonces = () => signDetached.mock.calls.map(([m]) => Number(m.split(':')[4]));

describe('planning the nonce', () => {
  const at = Date.now();
  const held = (nonce) => ({ nonce, state: 'accepted', acceptedAt: at, bodyHash: `h${nonce}` });

  it('follows the confirmed nonce; an earlier transaction below it is settled', () => {
    expect(planNonce(4, [], null, at)).toEqual({ nonce: 5, replaces: null });
    expect(planNonce(4, [{ nonce: 4, state: 'open' }], null, at).nonce).toBe(5); // settled: at or below the chain's
  });

  // MOBNET-R1-01: an unsettled transaction — refused, unanswered or accepted — never gets a nonce silently
  // placed after or over it. The user chooses, and only "replace" signs at its nonce.
  it('with any unsettled transaction of this wallet, a new one needs the user\'s choice', () => {
    for (const e of [{ nonce: 5, state: 'open' }, held(5), { nonce: 5, state: 'accepted', acceptedAt: at - HELD_MS }]) {
      expect(() => planNonce(4, [e], null, at)).toThrow(PendingChoiceError);
    }
    try { planNonce(4, [held(5)], null, at); } catch (e) {
      expect(e.code).toBe('PENDING_CHOICE');
      expect(e.pending).toMatchObject({ canAppend: true, replace: { nonce: 5, state: 'accepted', held: true } });
    }
  });

  it('replace signs at that transaction\'s nonce, and only while it is still the one the user saw', () => {
    const open = { nonce: 5, state: 'open', bodyHash: 'h5' };
    expect(planNonce(4, [open], { mode: 'replace', nonce: 5, bodyHash: 'h5' }, at)).toEqual({ nonce: 5, replaces: open });
    // It applied meanwhile: nothing is signed (the user meant one payment, not two).
    expect(() => planNonce(5, [open], { mode: 'replace', nonce: 5, bodyHash: 'h5' }, at)).toThrow(PendingSettledError);
    // Another transaction took its place meanwhile: ask again.
    expect(() => planNonce(4, [{ ...open, bodyHash: 'other' }], { mode: 'replace', nonce: 5, bodyHash: 'h5' }, at)).toThrow(PendingChangedError);
    expect(() => planNonce(4, [], { mode: 'replace', nonce: 6 }, at)).toThrow(PendingChangedError);
  });

  it('in addition signs the next nonce, only above transactions a node holds, and not endlessly', () => {
    expect(planNonce(4, [held(5)], { mode: 'append' }, at)).toEqual({ nonce: 6, replaces: null });
    // Never above one nobody holds (refused or unanswered), nor above one accepted long ago and not applied.
    expect(() => planNonce(4, [{ nonce: 5, state: 'open' }], { mode: 'append' }, at)).toThrow(PendingChangedError);
    expect(() => planNonce(4, [{ nonce: 5, state: 'accepted', acceptedAt: at - HELD_MS }], { mode: 'append' }, at))
      .toThrow(PendingChangedError);
    expect(() => planNonce(4, [5, 6, 7, 8].map(held), { mode: 'append' }, at)).toThrow(TooManyPendingError);
    expect(() => planNonce(undefined, [], null, at)).toThrow();
  });
});

describe('a node that answers an error and keeps the signed bytes', () => {
  it('gets nothing it can use: the next send asks, and replacing takes the same nonce, so only one can apply', async () => {
    const wm = wallet();
    const first = await wm.sendQNC(TO, 1, 'pw');
    expect(first).toMatchObject({ success: false, unknown: true, nonce: 5, refusal: 'nonce too low' });
    // No forced re-read and no second signature inside the first send.
    expect(signedNonces()).toEqual([5]);

    // The next send is not signed until the user has chosen what it does to the unconfirmed one.
    await expect(wm.sendQNC(TO, 1, 'pw')).rejects.toMatchObject({ code: 'PENDING_CHOICE' });
    expect(signedNonces()).toEqual([5]);
    const preview = await wm.previewSend(ME);
    expect(preview).toMatchObject({ nonce: null, canAppend: false, replace: { nonce: 5, state: 'open', kind: 'transfer', to: TO } });
    // In addition is not offered over a transaction no node holds.
    await expect(wm.sendQNC(TO, 1, 'pw', { choice: { mode: 'append' } })).rejects.toMatchObject({ code: 'PENDING_CHANGED' });

    const second = await wm.sendQNC(TO, 1, 'pw', { choice: { mode: 'replace', nonce: 5, bodyHash: preview.replace.bodyHash } });
    expect(second).toMatchObject({ unknown: true, nonce: 5, replaced: true });
    expect(signedNonces()).toEqual([5, 5]); // never 6 while 5 is unresolved
    const kept = await pendingFor(ME);
    expect(kept.map((e) => e.nonce)).toEqual([5]);
    expect(kept[0].body.dilithium_signature).toBe(posts[posts.length - 1].body.dilithium_signature);
  });

  // The R1-01 scenario: a refused send becomes accepted on a rebroadcast behind the user's back. A send that
  // replaces it still takes nonce 5 — and if 5 has applied by then, nothing is sent at all.
  it('an earlier send that became accepted meanwhile is still replaced at its nonce, never paid twice', async () => {
    const wm = wallet();
    await wm.sendQNC(TO, 1, 'pw'); // refused: open at 5
    const preview = await wm.previewSend(ME);
    await updateEntry(ME, 5, { state: 'accepted', acceptedAt: Date.now() }); // a rebroadcast got it in
    submit = () => ({ tx_hash: 'h' });
    const r = await wm.sendQNC(TO, 1, 'pw', { choice: { mode: 'replace', nonce: 5, bodyHash: preview.replace.bodyHash } });
    expect(r).toMatchObject({ success: true, nonce: 5, replaced: true });

    // Now 5 applied before the next replacement is signed: nothing is signed.
    const again = await wm.previewSend(ME);
    Object.values(accounts).forEach((a) => { a.nonce = 5; });
    wm.getQNCBalanceWithProof = jest.fn(async () => ({ ok: true, verified: true, nonce: '5' }));
    const signedBefore = signDetached.mock.calls.length;
    await expect(wm.sendQNC(TO, 1, 'pw', { choice: { mode: 'replace', nonce: 5, bodyHash: again.replace.bodyHash } }))
      .rejects.toMatchObject({ code: 'PENDING_SETTLED' });
    expect(signDetached.mock.calls.length).toBe(signedBefore);
    // And the settled one is remembered for the "same payment again" warning.
    expect(await wm.recentSettledTransactions(ME)).toEqual([expect.objectContaining({ nonce: 5, kind: 'transfer', to: TO, amountNano: 1_000_000_000 })]);
  });

  it('resends the kept transaction byte for byte; it never signs again', async () => {
    const wm = wallet();
    await wm.sendQNC(TO, 1, 'pw');
    const firstBody = JSON.stringify(posts[0].body);
    await updateEntry(ME, 5, { lastSentAt: 0 });
    posts = [];
    await wm.rebroadcastPending(ME, 5);
    expect(posts.length).toBeGreaterThan(0);
    for (const p of posts) expect(JSON.stringify(p.body)).toBe(firstBody);
    expect(signDetached).toHaveBeenCalledTimes(1);
  });

  it('asks another genesis node with the same bytes before calling it unknown', async () => {
    const wm = wallet();
    let n = 0;
    submit = () => (++n === 1 ? { success: false, error: 'Invalid nonce: expected 6, got 5' } : { success: true, tx_hash: 'h5' });
    const r = await wm.sendQNC(TO, 1, 'pw');
    expect(r).toMatchObject({ success: true, txHash: 'h5', nonce: 5 });
    expect(new Set(posts.map((p) => new URL(p.url).origin)).size).toBe(2);
    expect(new Set(posts.map((p) => JSON.stringify(p.body))).size).toBe(1);
  });

  it('answers pk_unresolved with the key attached and the same signature', async () => {
    Object.values(accounts).forEach((a) => { a.has_dilithium_pk = true; });
    const wm = wallet();
    // No node has the key yet: each one asks for it until the key rides along.
    submit = (body) => (body.dilithium_public_key ? { tx_hash: 'h' } : { success: false, error: 'pk_unresolved' });
    const r = await wm.sendQNC(TO, 1, 'pw');
    expect(r).toMatchObject({ success: true, txHash: 'h' });
    const withKey = posts.findIndex((p) => p.body.dilithium_public_key);
    expect(withKey).toBeGreaterThan(0);
    expect(posts.slice(0, withKey).every((p) => p.body.dilithium_public_key === undefined)).toBe(true);
    expect(posts[withKey].body.dilithium_public_key).toMatch(/^(01){1952}$/);
    expect(new Set(posts.map((p) => p.body.dilithium_signature)).size).toBe(1);
    expect(signDetached).toHaveBeenCalledTimes(1);
  });

  it('never re-signs a contract call in another form because a node mentions the signature', async () => {
    const wm = wallet();
    submit = () => ({ success: false, error: 'Invalid dilithium signature' });
    await expect(wm.qrc20Transfer('c'.repeat(64), TO, '5', 'pw')).rejects.toMatchObject({ unknown: { nonce: 5 } });
    expect(signDetached).toHaveBeenCalledTimes(1);
    expect(signDetached.mock.calls[0][0]).toMatch(/:5:\d+:\d+$/); // gas-bound form only
  });
});

describe('a node that lies about the nonce', () => {
  // MOBNET-R1-04: a certified state can be old (a proof from before a spend). A lower verified nonce never
  // overrides a higher one the genesis nodes agree on, and without an agreement the nonce never goes below what
  // this device already confirmed.
  it('a verified but older proof never overrides a higher nonce two genesis nodes agree on', async () => {
    const wm = wallet({ verifiedNonce: 4 });
    Object.values(accounts).forEach((a) => { a.nonce = 13; });
    submit = () => ({ tx_hash: 'h' });
    await wm.sendQNC(TO, 1, 'pw');
    expect(signedNonces()).toEqual([14]);
  });

  it('with no agreement to be had, an older certified proof cannot take the nonce back below what was confirmed', async () => {
    const wm = wallet({ verifiedNonce: 4 });
    Object.values(accounts).forEach((a) => { a.nonce = 9; });
    expect(await wm._confirmedAccountNonce(ME)).toBe(9);
    // The genesis nodes go quiet; a node serves a genuinely certified state from before those transactions.
    GENESIS_NODES.forEach((g) => { accounts[g] = null; });
    expect(await wm._confirmedAccountNonce(ME)).toBe(9);
    const plan = await wm.resolveNonce(ME);
    expect(plan.nonce).toBe(10);
    // Two genesis nodes agreeing on a lower value (a chain rolled back) are believed; one alone is not.
    accounts[GENESIS_NODES[0]] = { nonce: 2 };
    expect(await wm._confirmedAccountNonce(ME)).toBe(9);
    accounts[GENESIS_NODES[1]] = { nonce: 2 };
    expect(await wm._confirmedAccountNonce(ME)).toBe(4); // the agreement (2) and the proof (4): the higher counts
  });

  it('without a verified proof, one lying genesis node is outvoted by the others', async () => {
    const wm = wallet({ verifiedNonce: null });
    accounts[GENESIS_NODES[0]].nonce = 13;
    submit = () => ({ tx_hash: 'h' });
    await wm.sendQNC(TO, 1, 'pw');
    expect(signedNonces()).toEqual([5]);
  });

  it('with neither a proof nor two genesis nodes agreeing, nothing is signed', async () => {
    const wm = wallet({ verifiedNonce: null });
    GENESIS_NODES.forEach((g, i) => { accounts[g] = i === 0 ? { nonce: 4 } : null; });
    await expect(wm.sendQNC(TO, 1, 'pw')).rejects.toThrow(/could not confirm/);
    expect(signDetached).not.toHaveBeenCalled();
    expect(posts).toEqual([]);
  });
});

describe('sending in sequence', () => {
  it('a second payment goes in addition only when the user says so; a settled one is forgotten', async () => {
    submit = (body) => ({ tx_hash: `h${body.nonce}` });
    const wm = wallet({ verifiedNonce: 4 });
    expect((await wm.sendQNC(TO, 1, 'pw')).nonce).toBe(5);
    await expect(wm.sendQNC(TO, 2, 'pw')).rejects.toMatchObject({ code: 'PENDING_CHOICE' });
    expect((await wm.sendQNC(TO, 2, 'pw', { choice: { mode: 'append' } })).nonce).toBe(6);
    wm.getQNCBalanceWithProof = jest.fn(async () => ({ ok: true, verified: true, nonce: '6' }));
    Object.values(accounts).forEach((a) => { a.nonce = 6; });
    expect((await wm.sendQNC(TO, 1, 'pw')).nonce).toBe(7);
    expect((await pendingFor(ME)).map((e) => e.nonce)).toEqual([7]);
  });

  it('signs the recipient in the chain’s lowercase spelling, and refuses a mistyped one', async () => {
    submit = () => ({ tx_hash: 'h' });
    const wm = wallet();
    await wm.sendQNC(TO.toUpperCase(), 1, 'pw');
    expect(posts[0].body.to).toBe(TO);
    expect(signDetached.mock.calls[0][0]).toContain(`:${TO}:`);
    await expect(wm.sendQNC(`${TO.slice(0, -1)}${TO.endsWith('0') ? '1' : '0'}`, 1, 'pw')).rejects.toThrow(/checksum/);
  });
});
