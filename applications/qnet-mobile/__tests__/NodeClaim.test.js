/**
 * The QNet Link `claim` sheet's Node side (src/services/NodeLinkActions.js; qnet-link-v1 section 14.7): the amount the
 * sheet shows is the app's own quorum read, the move is the Node tab's run of Move to wallet for the node the request
 * names (its light or super node: services/MoveRun through the screen's startMove, here test-support/moveRun), and the
 * run becomes the one `claim` answer (the total as a decimal string above 2^53, the last claim's hash, where the last
 * claim stopped unless the whole balance moved; empty below 1 QNC, the network's refusal, one move at a time, whichever
 * node). The claim needs no device.
 */
const { nodeLinkActions } = require('../src/services/NodeLinkActions');
const { buildPlaintext } = require('../src/services/QNetLink');
const { superNodeId } = require('../src/crypto/NodePreimages');
const { H1, H2, H3, part, sheetMove } = require('../test-support/moveRun');
const V = require('../../../docs/protocols/light-node.vectors.json');

const W = V.wallets[0];
const S = superNodeId(W.address);
const TX = 'cd'.repeat(32);
// The sheet's actions over the screen's run of `walletManager` (one claim a run unless `opts` follow the parts).
const actionsOver = (walletManager, opts = {}, extra = {}) => {
  const { move, claimBusy } = sheetMove(walletManager, { walletAddress: W.address, credential: 'secret', ...opts });
  return nodeLinkActions({ walletManager, credential: 'secret', move, claimBusy, ...extra });
};
// The answer's wire keys: `run` is for this device's screen only.
const wire = ({ run: _run, ...rest }) => rest;
let calls;
let pending;

beforeEach(() => {
  calls = [];
  pending = [5_000_000_000, 12_500_000_000, 7_000_000_000];
  let n = 0;
  global.fetch = jest.fn((url) => {
    calls.push(url);
    if (url.includes('/rewards/pending/')) {
      const v = pending[n++ % pending.length];
      return Promise.resolve(v === null ? { ok: false, status: 503 } : { ok: true, json: async () => ({ pending_rewards_nano: v }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  });
});

const wm = (claimRewards) => ({ claimRewards: jest.fn(claimRewards) });

describe('the amount on the sheet', () => {
  it('is the largest of three genesis answers for this wallet\'s node, and none when no one answers', async () => {
    const a = nodeLinkActions({ walletManager: wm(), credential: 'c' });
    expect(await a.balance(W.nodeId)).toBe(12_500_000_000);
    expect(calls.filter((u) => u.endsWith(`/api/v1/rewards/pending/${W.nodeId}`))).toHaveLength(3);
    pending = [null];
    expect(await a.balance(W.nodeId)).toBeNull();
  });
});

describe('the move', () => {
  it('is the wallet\'s own claim for its light node; its quoted amount goes into the answer as a decimal string', async () => {
    const m = wm(async () => ({ success: true, amount: 12.5, amountNano: '12500000000000000123', txHash: TX, stoppedAtEpoch: 160 }));
    const a = actionsOver(m);
    const r = await a.claim({ nodeId: W.nodeId, qnet: W.address, amountNano: 12_500_000_000 });
    expect(m.claimRewards).toHaveBeenCalledWith('light', W.address, 'secret', 12_500_000_000, W.nodeId, { after: null });
    expect(wire(r)).toEqual({ status: 'ok', amountNano: '12500000000000000123', txHash: TX, stoppedAtEpoch: 160 });
    const text = buildPlaintext({ intent: 'claim', request: { walletHash: W.walletHash, nodeId: W.nodeId } },
      { status: 'ok', qnet: W.address, nodeId: W.nodeId, ...r, stoppedAtEpoch: String(r.stoppedAtEpoch) });
    expect(JSON.parse(text)).toMatchObject({ amountNano: '12500000000000000123', stoppedAtEpoch: '160' });
    // The run's parts never reach the website: the plaintext carries the row's keys alone.
    expect(Object.keys(JSON.parse(text))).toEqual(['v', 'intent', 'status', 'qnet', 'nodeId', 'amountNano', 'txHash', 'stoppedAtEpoch']);
  });

  it('the move of the super node\'s balance is the wallet\'s claim for its super node, under that id', async () => {
    const m = wm(async () => ({ success: true, amount: 48, amountNano: '48000000000', txHash: TX, stoppedAtEpoch: null }));
    const a = actionsOver(m);
    expect(wire(await a.claim({ nodeId: S, qnet: W.address, amountNano: 48_000_000_000 })))
      .toEqual({ status: 'ok', amountNano: '48000000000', txHash: TX, stoppedAtEpoch: null });
    expect(m.claimRewards).toHaveBeenCalledWith('super', W.address, 'secret', 48_000_000_000, S, { after: null });
  });

  it('a node of another wallet is never moved: WALLET_MISMATCH before anything is signed', async () => {
    const other = V.wallets[1];
    const m = wm(async () => ({ success: true, amount: 1, amountNano: '1000000000', txHash: TX, stoppedAtEpoch: null }));
    const a = actionsOver(m);
    for (const nodeId of [superNodeId(other.address), other.nodeId, 'genesis_node_001']) {
      expect([nodeId, await a.claim({ nodeId, qnet: W.address, amountNano: 1_000_000_000 })])
        .toEqual([nodeId, { status: 'error', error: 'WALLET_MISMATCH' }]);
    }
    expect(m.claimRewards).not.toHaveBeenCalled();
  });

  it('whether the chain lists the super node: two genesis nodes alike, by GET /api/v1/node/status for that node', async () => {
    const answers = [];
    global.fetch = jest.fn((url) => {
      calls.push(url);
      const a = answers.shift();
      return Promise.resolve(a === undefined ? { ok: false, status: 503, json: async () => ({}) } : { ok: true, status: 200, json: async () => a });
    });
    const a = nodeLinkActions({ walletManager: wm(), credential: 'c' });
    const listed = (v, over = {}) => ({ success: true, node_id: S, onchain_registered: v, ...over });
    answers.push(listed(true), listed(true), listed(false));
    expect(await a.serverListed(S)).toBe(true);
    expect(calls.filter((u) => u.endsWith(`/api/v1/node/status?node_id=${S}`))).toHaveLength(5);
    answers.push(listed(false), listed(false), listed(true));
    expect(await a.serverListed(S)).toBe(false);
    // `registered` when the node has no `onchain_registered`; an answer naming no node counts, one naming another does not.
    answers.push({ success: true, node_id: null, registered: true }, listed(true, { onchain_registered: undefined, registered: true }));
    expect(await a.serverListed(S)).toBe(true);
    answers.push(listed(true, { node_id: 'super_node_0000000000000000' }), listed(true, { success: false }), listed(true));
    expect(await a.serverListed(S)).toBe(null);
    answers.push(listed(true), listed(true), listed(false), listed(false));
    expect(await a.serverListed(S)).toBe(null);
    global.fetch = jest.fn(async () => { throw new TypeError('Network request failed'); });
    expect(await a.serverListed(S)).toBe(null);
  });

  it('an older node\'s answer without the quoted amount is converted from QNC', async () => {
    const a = actionsOver(wm(async () => ({ success: true, amount: 2.25, amountNano: null, txHash: TX, stoppedAtEpoch: null })));
    expect(wire(await a.claim({ nodeId: W.nodeId, qnet: W.address, amountNano: 2_250_000_000 })))
      .toEqual({ status: 'ok', amountNano: '2250000000', txHash: TX, stoppedAtEpoch: null });
  });

  it('nothing to move is `empty`; a refusal is CLAIM_REFUSED; no answer in time is NETWORK', async () => {
    for (const [result, want] of [
      [{ success: false, code: 'NO_REWARDS' }, { status: 'empty' }],
      [{ success: false, code: 'MIN_CLAIM' }, { status: 'empty' }],
      [{ success: false, message: 'refused' }, { status: 'error', error: 'CLAIM_REFUSED' }],
    ]) {
      const a = actionsOver(wm(async () => result));
      expect(await a.claim({ nodeId: W.nodeId, qnet: W.address, amountNano: 1 })).toEqual(want);
    }
    const thrown = actionsOver(wm(async () => { throw Object.assign(new Error('late'), { unknown: true }); }));
    // NETWORK on the wire; `unknown` tells this device's screen the move may have gone through (MN-R4-05).
    expect(await thrown.claim({ nodeId: W.nodeId, qnet: W.address, amountNano: 1 })).toEqual({ status: 'error', error: 'NETWORK', unknown: true });
    const failed = actionsOver(wm(async () => { throw new Error('quote refused'); }));
    expect(await failed.claim({ nodeId: W.nodeId, qnet: W.address, amountNano: 1 })).toEqual({ status: 'error', error: 'CLAIM_REFUSED' });
    // The screen's run not started (another move took the press first), or no run to start at all.
    const m = wm(async () => ({ success: true }));
    expect(await nodeLinkActions({ walletManager: m, credential: 'c', move: async () => null }).claim({ nodeId: W.nodeId, qnet: W.address, amountNano: 1 }))
      .toEqual({ status: 'error', error: 'CLAIM_BUSY' });
    expect(await nodeLinkActions({ walletManager: m, credential: 'c' }).claim({ nodeId: W.nodeId, qnet: W.address, amountNano: 1 }))
      .toEqual({ status: 'error', error: 'INTERNAL' });
    expect(m.claimRewards).not.toHaveBeenCalled();
  });

  it('one move at a time: while the Node tab or this sheet moves the balance, another is CLAIM_BUSY', async () => {
    let finish;
    const m = wm(() => new Promise((r) => { finish = r; }));
    const a = actionsOver(m);
    const first = a.claim({ nodeId: W.nodeId, qnet: W.address, amountNano: 1 });
    expect(a.claimBusy()).toBe(true);
    expect(await a.claim({ nodeId: W.nodeId, qnet: W.address, amountNano: 1 })).toEqual({ status: 'error', error: 'CLAIM_BUSY' });
    finish({ success: true, amount: 1, amountNano: '1000000000', txHash: TX, stoppedAtEpoch: null });
    await first;
    expect(a.claimBusy()).toBe(false);
    const tab = actionsOver(m, {}, { claimBusy: () => true });
    expect(tab.claimBusy()).toBe(true);
    expect(await tab.claim({ nodeId: W.nodeId, qnet: W.address, amountNano: 1 })).toEqual({ status: 'error', error: 'CLAIM_BUSY' });
  });

  it('the node balance is the wallet\'s: a move of the super node\'s holds one of the light node\'s, and the reverse', async () => {
    for (const [first, second] of [[S, W.nodeId], [W.nodeId, S]]) {
      let finish;
      const m = wm(() => new Promise((r) => { finish = r; }));
      const a = actionsOver(m);
      const running = a.claim({ nodeId: first, qnet: W.address, amountNano: 1 });
      expect(await a.claim({ nodeId: second, qnet: W.address, amountNano: 1 })).toEqual({ status: 'error', error: 'CLAIM_BUSY' });
      finish({ success: true, amount: 1, amountNano: '1000000000', txHash: TX, stoppedAtEpoch: null });
      await running;
      expect(m.claimRewards).toHaveBeenCalledTimes(1);
    }
    // A move in transit is the wallet's (services/ClaimTransit): the screen's claimBusy holds either node's move.
    const { transitRecord, addMove, emptyTransit, heldMove, transitTotal } = require('../src/services/ClaimTransit');
    const move = transitRecord({ nodeId: S, result: { success: true, amountNano: '2000000000', prevWatermark: 4, lastEpoch: 6, txHash: TX }, balanceNano: 3_000_000_000 });
    const state = addMove(emptyTransit(W.address), move);
    expect(heldMove(state)).toMatchObject({ amountNano: '2000000000', restNano: 1_000_000_000 });
    const m = wm(async () => ({ success: true }));
    const a = actionsOver(m, {}, { claimBusy: () => transitTotal(state) > 0 });
    expect(await a.claim({ nodeId: W.nodeId, qnet: W.address, amountNano: 1 })).toEqual({ status: 'error', error: 'CLAIM_BUSY' });
    expect(m.claimRewards).not.toHaveBeenCalled();
  });

  it('the run the sheet starts is the screen\'s: the node, its type, the balance shown, the deadline; the screen reads the node after', async () => {
    const run = { parts: [{ txHash: TX, amountNano: '48000000000', lastEpoch: 9, stoppedAtEpoch: null }], movedNano: 48000000000n,
      whole: true, stop: null, settled: null, live: true, refused: null };
    const move = jest.fn(async () => run);
    const onMoved = jest.fn();
    const onPart = () => {};
    const a = nodeLinkActions({ walletManager: wm(), credential: 'c', move, onMoved });
    expect(wire(await a.claim({ nodeId: S, qnet: W.address, amountNano: 50_000_000_000, until: 1_800_000_000_000, onPart })))
      .toEqual({ status: 'ok', amountNano: '48000000000', txHash: TX, stoppedAtEpoch: null });
    expect(move).toHaveBeenCalledWith({ nodeType: 'super', nodeId: S, balanceNano: 50_000_000_000, until: 1_800_000_000_000, onPart });
    expect(onMoved).toHaveBeenCalledTimes(1);
    // A refusal moved nothing: the node is not read for it.
    move.mockResolvedValueOnce({ ...run, parts: [], movedNano: 0n, refused: { success: false, code: 'NO_REWARDS' } });
    expect(await a.claim({ nodeId: S, qnet: W.address, amountNano: 1 })).toEqual({ status: 'empty' });
    expect(onMoved).toHaveBeenCalledTimes(1);
  });
});

// Move to wallet from aiqnet.io moves the whole balance shown with one approval, as the Node tab does; the
// answer keeps its keys and names the run's total, its last claim, and where that one stopped only when the run ended
// short. An older site still shows a true total; an older app still answers one claim.
describe('a sheet\'s move in parts answers once', () => {
  // claimRewards answering `answers` in turn (an Error is thrown).
  const seq = (answers) => wm(async () => { const next = answers.shift(); if (next instanceof Error) throw next; return next; });
  const view = { intent: 'claim', request: { walletHash: W.walletHash, nodeId: W.nodeId } };
  const sent = (r) => JSON.parse(buildPlaintext(view, { status: 'ok', qnet: W.address, nodeId: W.nodeId, ...wire(r),
    stoppedAtEpoch: r.stoppedAtEpoch === null ? null : String(r.stoppedAtEpoch) }));
  const done = { result: 'done', appliedNano: 0 };
  const follow = { record: () => true, settled: async () => done };

  it('three parts: the total, the last claim, and no stop', async () => {
    const m = seq([part('3000000000', 100, 612, H1, 'batch_full'), part('3000000000', 612, 1124, H2, 'rebuild_budget'), part('2500000000', 1124, 1300, H3)]);
    const r = await actionsOver(m, follow).claim({ nodeId: W.nodeId, qnet: W.address, amountNano: 8_500_000_000 });
    expect(wire(r)).toEqual({ status: 'ok', amountNano: '8500000000', txHash: H3, stoppedAtEpoch: null });
    expect(m.claimRewards.mock.calls.map((c) => c[5].after)).toEqual([null, 612, 1124]);
    expect(r.run.parts.map((p) => p.txHash)).toEqual([H1, H2, H3]);
    expect(sent(r)).toMatchObject({ amountNano: '8500000000', txHash: H3, stoppedAtEpoch: null });
  });

  it('ended short by a lock, a refusal or the request\'s time: the total so far and where its last claim stopped', async () => {
    const two = () => [part('3000000000', 100, 612, H1, 'batch_full'), part('3000000000', 612, 1124, H2, 'batch_full'), part('1', 1124, 1125, H3)];
    let session = 'secret';
    const locked = await actionsOver(seq(two()), {
      credential: () => session, record: () => true, settled: async (h) => { if (h === H2) session = null; return done; },
    }).claim({ nodeId: W.nodeId, qnet: W.address, amountNano: 9e9 });
    expect([wire(locked), locked.run.stop]).toEqual([{ status: 'ok', amountNano: '6000000000', txHash: H2, stoppedAtEpoch: 1125 }, { ended: true }]);
    const refused = await actionsOver(seq([part('3000000000', 100, 612, H1, 'batch_full'), Object.assign(new Error('x'), { code: 'RATE_LIMITED' })]), follow)
      .claim({ nodeId: W.nodeId, qnet: W.address, amountNano: 9e9 });
    expect([wire(refused), refused.run.stop]).toEqual([{ status: 'ok', amountNano: '3000000000', txHash: H1, stoppedAtEpoch: 613 }, { code: 'RATE_LIMITED' }]);
    const late = await actionsOver(seq(two()), { record: () => true, settled: async () => null })
      .claim({ nodeId: W.nodeId, qnet: W.address, amountNano: 9e9, until: 1 });
    expect(wire(late)).toEqual({ status: 'ok', amountNano: '3000000000', txHash: H1, stoppedAtEpoch: 613 });
    for (const r of [locked, refused, late]) expect(sent(r).stoppedAtEpoch).toBe(String(r.stoppedAtEpoch));
  });

  it('a whole run below 1 QNC names its last claim\'s stop, never none, so the site takes it', async () => {
    const m = seq([part('400000000', 100, 612, H1, 'batch_full'), Object.assign(new Error('x'), { code: 'NO_REWARDS' })]);
    const r = await actionsOver(m, follow).claim({ nodeId: W.nodeId, qnet: W.address, amountNano: 2e9 });
    expect([r.run.stop, wire(r)]).toEqual([null, { status: 'ok', amountNano: '400000000', txHash: H1, stoppedAtEpoch: 613 }]);
    expect(sent(r)).toMatchObject({ amountNano: '400000000', stoppedAtEpoch: '613' });
    // At 1 QNC or more it is the whole balance moved.
    const whole = await actionsOver(seq([part('1000000000', 100, 612, H1, 'batch_full'), Object.assign(new Error('x'), { code: 'NO_REWARDS' })]), follow)
      .claim({ nodeId: W.nodeId, qnet: W.address, amountNano: 2e9 });
    expect(whole.stoppedAtEpoch).toBe(null);
    // The sheet's own note speaks of no rest either way.
    expect([r.run.whole, whole.run.whole]).toEqual([true, true]);
  });

  it('a last claim its record shows taken in part counts its share, one that expired nothing', async () => {
    // the second claim's epochs: 613, 700 and 1124 of 1 QNC each; its record shows 2 QNC of it applied
    const second = { ...part('3000000000', 612, 1124, H2, 'batch_full'), parts: [[613, '1000000000'], [700, '1000000000'], [1124, '1000000000']] };
    const fates = (fate) => ({ record: () => true, settled: async (h) => (h === H2 ? fate : done) });
    const three = () => [part('3000000000', 100, 612, H1, 'batch_full'), second, part('1', 1124, 1125, H3)];
    const partial = await actionsOver(seq(three()), fates({ result: 'partial', appliedNano: 2000000000 }))
      .claim({ nodeId: W.nodeId, qnet: W.address, amountNano: 9e9 });
    expect(wire(partial)).toEqual({ status: 'ok', amountNano: '5000000000', txHash: H2, stoppedAtEpoch: 1124 });
    expect(sent(partial)).toMatchObject({ amountNano: '5000000000', stoppedAtEpoch: '1124' });
    const expired = await actionsOver(seq(three()), fates({ result: 'expired', appliedNano: 0 }))
      .claim({ nodeId: W.nodeId, qnet: W.address, amountNano: 9e9 });
    expect(wire(expired)).toEqual({ status: 'ok', amountNano: '3000000000', txHash: H1, stoppedAtEpoch: 613 });
    // The screen keeps every claim it sent, the last one's record saying what became of it.
    expect(expired.run.parts.map((p) => p.txHash)).toEqual([H1, H2]);
    // Its only claim expired: nothing was done.
    const none = await actionsOver(seq(three()), { record: () => true, settled: async () => ({ result: 'expired', appliedNano: 0 }) })
      .claim({ nodeId: W.nodeId, qnet: W.address, amountNano: 9e9 });
    expect(none).toEqual({ status: 'error', error: 'CLAIM_REFUSED' });
  });
});

describe('the wallet\'s claim keeps the quoted amount', () => {
  it('returns amountNano from the quote it signed', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/components/WalletManager.js'), 'utf8');
    // The sum of the batch signed (checkedClaimQuote: the quoted total must equal it, else nothing is signed).
    expect(src).toMatch(/amount_nano: checked\.amountNano/);
    expect(src).toMatch(/amountNano: sum\.toString\(\)/);
    expect(src).toMatch(/amountNano: typeof claimResult\.amount_nano === 'string' \? claimResult\.amount_nano : null/);
  });
});
