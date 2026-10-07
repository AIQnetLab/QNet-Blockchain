/**
 * The QNet Link `claim` sheet's Node side (src/services/NodeLinkActions.js; qnet-link-v1 section 14.7): the amount the
 * sheet shows is the app's own quorum read, the move is the wallet's ordinary claim, and its outcome becomes the
 * `claim` answer (the amount as a decimal string above 2^53, empty below 1 QNC, the network's refusal, one move at a
 * time). The claim needs no device.
 */
const { nodeLinkActions } = require('../src/services/NodeLinkActions');
const { buildPlaintext } = require('../src/services/QNetLink');
const V = require('../../../docs/protocols/light-node.vectors.json');

const W = V.wallets[0];
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
    const text = buildPlaintext({ intent: 'claim', request: { walletHash: W.walletHash } },
      { status: 'ok', qnet: W.address, nodeId: W.nodeId, ...r, stoppedAtEpoch: String(r.stoppedAtEpoch) });
    expect(JSON.parse(text)).toMatchObject({ amountNano: '12500000000000000123', stoppedAtEpoch: '160' });
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
});

describe('the wallet\'s claim keeps the quoted amount', () => {
  it('returns amountNano from the quote it signed', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/components/WalletManager.js'), 'utf8');
    expect(src).toMatch(/amount_nano: quotedNano\.toString\(\)/);
    expect(src).toMatch(/amountNano: typeof claimResult\.amount_nano === 'string' \? claimResult\.amount_nano : null/);
  });
});
