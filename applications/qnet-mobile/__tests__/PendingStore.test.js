// MOBNET-R1-08: the store of signed-but-unsettled transactions is rewritten by a send, by the resolver's
// rebroadcast and by the in-app browser's preview at the same time. Every rewrite runs under one lock, and an
// update names the exact bytes it is about, so an answer for a transaction the user replaced changes nothing and
// the kept bytes are always the ones the user last signed.
jest.mock('../src/crypto/DilithiumCrypto', () => ({
  isDilithiumAvailable: () => true,
  signDetached: jest.fn(async (message) => `sig(${message})`),
  verifyDilithium: jest.fn(),
}));

const AsyncStorage = require('@react-native-async-storage/async-storage');
const {
  putSigned, updateEntry, settle, pendingFor, pendingEntry, bodyHashOf, recentSettled,
} = require('../src/services/PendingTx');
const { WalletManager } = require('../src/components/WalletManager');
const { GENESIS_NODES } = require('../src/config/nodes');

const ME = 'me';
const entry = (nonce, body) => ({ from: ME, nonce, path: '/api/v1/transaction', body, pk: null, createdAt: Date.now() });

beforeEach(async () => { await AsyncStorage.clear(); });

it('concurrent writes never lose one another', async () => {
  await Promise.all(Array.from({ length: 20 }, (_, i) => putSigned(entry(i + 1, { n: i + 1 }))));
  expect((await pendingFor(ME)).map((e) => e.nonce)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  await Promise.all([
    settle(ME, 5),
    ...Array.from({ length: 10 }, (_, i) => updateEntry(ME, 10 + i, { sends: 1 })),
  ]);
  const left = await pendingFor(ME);
  expect(left.map((e) => e.nonce)).toEqual(Array.from({ length: 15 }, (_, i) => i + 6));
  expect(left.filter((e) => e.sends === 1).map((e) => e.nonce)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  expect((await recentSettled(ME)).map((r) => r.nonce).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
});

it('an answer for bytes the user replaced does not touch the replacement', async () => {
  const X = { to: 'alice', n: 1 };
  const Y = { to: 'bob', n: 2 };
  await putSigned(entry(5, X));
  await putSigned(entry(5, Y)); // the user replaced X
  const r = await updateEntry(ME, 5, { state: 'accepted', txHash: 'hash-of-X' }, { bodyHash: bodyHashOf(X) });
  expect(r).toBeNull();
  const kept = await pendingEntry(ME, 5);
  expect(kept.body).toEqual(Y);
  expect(kept.state).toBe('open');
  expect(kept.txHash).toBeUndefined();
  expect(kept.bodyHash).toBe(bodyHashOf(Y));
  // The same update naming Y applies.
  expect(await updateEntry(ME, 5, { state: 'accepted' }, { bodyHash: bodyHashOf(Y) })).toMatchObject({ state: 'accepted' });
});

it('a rebroadcast that was in flight when the user replaced the transaction cannot mark the replacement', async () => {
  const posts = [];
  let releaseFirst;
  const firstAnswer = new Promise((r) => { releaseFirst = r; });
  let n = 0;
  global.fetch = jest.fn(async (url, opts = {}) => {
    if (opts.method === 'POST') {
      const body = JSON.parse(opts.body);
      posts.push(body);
      n += 1;
      if (n === 1) { await firstAnswer; return { ok: true, status: 200, json: async () => ({ tx_hash: 'hash-of-X' }) }; }
      return { ok: true, status: 200, json: async () => ({ success: false, error: 'queue full' }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
  const wm = new WalletManager();
  wm.getTrustedNodes = () => [GENESIS_NODES[0]];
  const X = { from: ME, to: 'alice', nonce: 5 };
  const Y = { from: ME, to: 'bob', nonce: 5 };
  await putSigned({ ...entry(5, X), lastSentAt: 0 });
  const rebroadcast = wm.rebroadcastPending(ME, 5); // X goes out and waits for its answer
  await new Promise((r) => setTimeout(r, 10));
  await putSigned(entry(5, Y)); // meanwhile the user replaces X with Y
  releaseFirst();
  await rebroadcast;
  const kept = await pendingEntry(ME, 5);
  expect(kept.body).toEqual(Y);
  expect(kept.state).toBe('open'); // X's acceptance was not written onto Y
  expect(kept.txHash).toBeUndefined();
  // The next rebroadcast sends Y's bytes, never X's again.
  await updateEntry(ME, 5, { lastSentAt: 0 });
  posts.length = 0;
  await wm.rebroadcastPending(ME, 5);
  expect(posts.map((p) => p.to)).toEqual(['bob']);
});

// MOBNET-R2-04: a transaction signed "in addition" is refused until the one before it applies; the sweep that runs
// with every balance refresh sends it again then, with no fixed cap, and never before.
describe('the pending sweep', () => {
  function rig(accountNonce) {
    const posts = [];
    const state = { nonce: accountNonce };
    global.fetch = jest.fn(async (url, opts = {}) => {
      if (opts.method === 'POST') {
        posts.push(JSON.parse(opts.body));
        return { ok: true, status: 200, json: async () => ({ tx_hash: 'h' }) };
      }
      return { ok: true, status: 200, json: async () => ({ nonce: state.nonce }) };
    });
    const wm = new WalletManager();
    wm.getTrustedNodes = () => [GENESIS_NODES[0]];
    wm._getJson = async () => ({ nonce: state.nonce });
    return { wm, posts, state };
  }

  it('sends the entry at the account\'s next nonce, and nothing above it', async () => {
    const { wm, posts, state } = rig(4);
    await putSigned({ ...entry(5, { n: 5 }), state: 'accepted', acceptedAt: Date.now(), lastSentAt: Date.now() });
    await putSigned({ ...entry(6, { n: 6 }), sends: 9, lastSentAt: 0 }); // appended, refused every time so far
    expect(await wm.sendDuePending(ME)).toBe(false); // 5 is held by a node; 6 is not admissible yet
    expect(posts).toEqual([]);
    state.nonce = 5; // 5 applied
    expect(await wm.sendDuePending(ME)).toBe(true);
    expect(posts.map((p) => p.n)).toEqual([6]); // no six-send cap while the nonce is free
    expect((await pendingFor(ME)).map((e) => e.nonce)).toEqual([6]); // 5 settled
    expect(await wm.sendDuePending(ME)).toBe(false); // accepted now: held
  });

  it('an accepted entry older than the mempool hold is sent again (a mempool may have dropped it)', async () => {
    const { wm, posts } = rig(4);
    await putSigned({ ...entry(5, { n: 5 }), state: 'accepted', acceptedAt: Date.now() - 11 * 60_000, lastSentAt: 0 });
    expect(await wm.sendDuePending(ME)).toBe(true);
    expect(posts.map((p) => p.n)).toEqual([5]);
  });

  it('the resolver says whether any node holds it, so the card never calls a refused one queued', async () => {
    const { wm } = rig(4);
    wm._hedged = async (path) => ({ ok: true, data: { nonce: 4 } });
    await putSigned({ ...entry(6, { n: 6 }), lastSentAt: Date.now() });
    await expect(wm.resolveSubmitByNonce(ME, 6, {})).resolves.toMatchObject({ landed: false, known: true, held: false });
    await updateEntry(ME, 6, { state: 'accepted', acceptedAt: Date.now() });
    await expect(wm.resolveSubmitByNonce(ME, 6, {})).resolves.toMatchObject({ held: true });
  });
});
