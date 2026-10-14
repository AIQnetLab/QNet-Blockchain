/**
 * The open wallet's QNC figure at a genesis node's live tip (owner, 14.10): money that came in shows within seconds, as
 * a wallet that shows its node's answer does, instead of after the next certified checkpoint. Only a figure whose proof
 * folds to the root the node served; never a send's base, never verified, and reading it marks no node old.
 */
jest.mock('../src/crypto/DilithiumCrypto', () => ({ verifyDilithium: jest.fn(), isDilithiumAvailable: () => true }));

const { WalletManager } = require('../src/components/WalletManager');
const lc = require('../src/crypto/QcLightClient');

const ME = 'dc6e4f045e96c0bf43deon546e9f27ad8f91464e6a4f6';
const ROOT = 'ab'.repeat(32);
const body = (over = {}) => JSON.stringify({
  address: ME, balance: 75000000000, nonce: 4, last_claimed_epoch: 40320, merkle_proof: [{ sibling: '00', is_right: true }],
  state_root: ROOT, block_height: 3672187, ...over,
});
const reply = (text) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text) });

describe('liveQncFigure', () => {
  let asked;
  beforeEach(() => {
    asked = [];
    global.fetch = jest.fn(async (url) => { asked.push(url); return reply(body()); });
  });

  it('a figure whose proof folds to the root its node served, from the route without mb', async () => {
    const wm = new WalletManager();
    wm.verifyMerkleProof = jest.fn(async () => true);
    await expect(wm.liveQncFigure(ME)).resolves.toEqual({
      balance: 75, balanceNano: '75000000000', nonce: '4', blockHeight: 3672187, figureClaimedEpoch: 40320,
    });
    expect(asked.every((u) => u.endsWith(`/api/v1/account/${ME}/balance/proof`))).toBe(true);
    expect(wm.verifyMerkleProof.mock.calls[0][4]).toBe(ROOT);
    expect(asked.some((u) => lc.nodeMarkedOld(u.slice(0, u.indexOf('/api'))))).toBe(false);
  });

  it('nothing when the proof does not fold, when the answer is a certified body, or when it names no height', async () => {
    const wm = new WalletManager();
    wm.verifyMerkleProof = jest.fn(async () => false);
    await expect(wm.liveQncFigure(ME)).resolves.toBeNull();
    wm.verifyMerkleProof = jest.fn(async () => true);
    global.fetch = jest.fn(async () => reply(body({ proof_format: 2 })));
    await expect(wm.liveQncFigure(ME)).resolves.toBeNull();
    global.fetch = jest.fn(async () => reply(body({ block_height: null })));
    await expect(wm.liveQncFigure(ME)).resolves.toBeNull();
  });
});
