/**
 * The QNet Link `claim` sheet's Node side (src/services/NodeLinkActions.js; qnet-link-v1 section 14.7): the amount the
 * sheet shows is the app's own quorum read, the move is the wallet's ordinary claim for the node the request names (its
 * light or super node), and its outcome becomes the `claim` answer (the amount as a decimal string above 2^53, empty
 * below 1 QNC, the network's refusal, one move at a time, whichever node). The claim needs no device.
 */
const { nodeLinkActions } = require('../src/services/NodeLinkActions');
const { buildPlaintext } = require('../src/services/QNetLink');
const { superNodeId } = require('../src/crypto/NodePreimages');
const V = require('../../../docs/protocols/light-node.vectors.json');

const W = V.wallets[0];
const S = superNodeId(W.address);
const TX = 'cd'.repeat(32);
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
    const a = nodeLinkActions({ walletManager: m, credential: 'secret' });
    const r = await a.claim({ nodeId: W.nodeId, qnet: W.address, amountNano: 12_500_000_000 });
    expect(m.claimRewards).toHaveBeenCalledWith('light', W.address, 'secret', 12_500_000_000, W.nodeId);
    expect(r).toEqual({ status: 'ok', amountNano: '12500000000000000123', txHash: TX, stoppedAtEpoch: 160 });
    const text = buildPlaintext({ intent: 'claim', request: { walletHash: W.walletHash, nodeId: W.nodeId } },
      { status: 'ok', qnet: W.address, nodeId: W.nodeId, ...r, stoppedAtEpoch: String(r.stoppedAtEpoch) });
    expect(JSON.parse(text)).toMatchObject({ amountNano: '12500000000000000123', stoppedAtEpoch: '160' });
  });

  it('the move of the super node\'s balance is the wallet\'s claim for its super node, under that id', async () => {
    const m = wm(async () => ({ success: true, amount: 48, amountNano: '48000000000', txHash: TX, stoppedAtEpoch: null }));
    const a = nodeLinkActions({ walletManager: m, credential: 'secret' });
    expect(await a.claim({ nodeId: S, qnet: W.address, amountNano: 48_000_000_000 }))
      .toEqual({ status: 'ok', amountNano: '48000000000', txHash: TX, stoppedAtEpoch: null });
    expect(m.claimRewards).toHaveBeenCalledWith('super', W.address, 'secret', 48_000_000_000, S);
  });

  it('a node of another wallet is never moved: WALLET_MISMATCH before anything is signed', async () => {
    const other = V.wallets[1];
    const m = wm(async () => ({ success: true, amount: 1, amountNano: '1000000000', txHash: TX, stoppedAtEpoch: null }));
    const a = nodeLinkActions({ walletManager: m, credential: 'c' });
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
    const a = nodeLinkActions({ walletManager: wm(async () => ({ success: true, amount: 2.25, amountNano: null, txHash: TX, stoppedAtEpoch: null })), credential: 'c' });
    expect(await a.claim({ nodeId: W.nodeId, qnet: W.address, amountNano: 2_250_000_000 }))
      .toEqual({ status: 'ok', amountNano: '2250000000', txHash: TX, stoppedAtEpoch: null });
  });

  it('nothing to move is `empty`; a refusal is CLAIM_REFUSED; no answer in time is NETWORK', async () => {
    for (const [result, want] of [
      [{ success: false, code: 'NO_REWARDS' }, { status: 'empty' }],
      [{ success: false, code: 'MIN_CLAIM' }, { status: 'empty' }],
      [{ success: false, message: 'refused' }, { status: 'error', error: 'CLAIM_REFUSED' }],
    ]) {
      const a = nodeLinkActions({ walletManager: wm(async () => result), credential: 'c' });
      expect(await a.claim({ nodeId: W.nodeId, qnet: W.address, amountNano: 1 })).toEqual(want);
    }
    const thrown = nodeLinkActions({ walletManager: wm(async () => { throw Object.assign(new Error('late'), { unknown: true }); }), credential: 'c' });
    // NETWORK on the wire; `unknown` tells this device's screen the move may have gone through (MN-R4-05).
    expect(await thrown.claim({ nodeId: W.nodeId, qnet: W.address, amountNano: 1 })).toEqual({ status: 'error', error: 'NETWORK', unknown: true });
    const failed = nodeLinkActions({ walletManager: wm(async () => { throw new Error('quote refused'); }), credential: 'c' });
    expect(await failed.claim({ nodeId: W.nodeId, qnet: W.address, amountNano: 1 })).toEqual({ status: 'error', error: 'CLAIM_REFUSED' });
  });

  it('one move at a time: while the Node tab or this sheet moves the balance, another is CLAIM_BUSY', async () => {
    let finish;
    const m = wm(() => new Promise((r) => { finish = r; }));
    const a = nodeLinkActions({ walletManager: m, credential: 'c' });
    const first = a.claim({ nodeId: W.nodeId, qnet: W.address, amountNano: 1 });
    expect(a.claimBusy()).toBe(true);
    expect(await a.claim({ nodeId: W.nodeId, qnet: W.address, amountNano: 1 })).toEqual({ status: 'error', error: 'CLAIM_BUSY' });
    finish({ success: true, amount: 1, amountNano: '1000000000', txHash: TX, stoppedAtEpoch: null });
    await first;
    expect(a.claimBusy()).toBe(false);
    const tab = nodeLinkActions({ walletManager: m, credential: 'c', claimBusy: () => true });
    expect(tab.claimBusy()).toBe(true);
    expect(await tab.claim({ nodeId: W.nodeId, qnet: W.address, amountNano: 1 })).toEqual({ status: 'error', error: 'CLAIM_BUSY' });
  });

  it('the node balance is the wallet\'s: a move of the super node\'s holds one of the light node\'s, and the reverse', async () => {
    for (const [first, second] of [[S, W.nodeId], [W.nodeId, S]]) {
      let finish;
      const m = wm(() => new Promise((r) => { finish = r; }));
      const a = nodeLinkActions({ walletManager: m, credential: 'c' });
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
    const a = nodeLinkActions({ walletManager: m, credential: 'c', claimBusy: () => transitTotal(state) > 0 });
    expect(await a.claim({ nodeId: W.nodeId, qnet: W.address, amountNano: 1 })).toEqual({ status: 'error', error: 'CLAIM_BUSY' });
    expect(m.claimRewards).not.toHaveBeenCalled();
  });

  it('a move the network took is handed to the screen with the id it named, kept as the wallet\'s move in transit', async () => {
    const result = { success: true, amount: 48, amountNano: '48000000000', txHash: TX, stoppedAtEpoch: null, prevWatermark: 4, lastEpoch: 9 };
    const onClaimed = jest.fn();
    const a = nodeLinkActions({ walletManager: wm(async () => result), credential: 'c', onClaimed });
    await a.claim({ nodeId: S, qnet: W.address, amountNano: 50_000_000_000 });
    expect(onClaimed).toHaveBeenCalledWith(S, result, 50_000_000_000);
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
