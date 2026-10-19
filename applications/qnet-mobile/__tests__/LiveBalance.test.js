/**
 * The wallet's figures at a genesis node's live tip (owner, 14.10 and 18.10): money that came in shows within seconds,
 * as a wallet that shows its node's answer does, instead of after the next certified checkpoint, and a send is checked
 * against them (SendAfterOwnSend, SpeedSend). Only a figure whose proof folds to the root the node served, asked of the
 * next genesis name when an answer does not fold; never verified, and reading it marks no node old. Token rows on Assets
 * take a certified figure only when it is of the same state as the live one or newer.
 */
jest.mock('../src/crypto/DilithiumCrypto', () => ({ verifyDilithium: jest.fn(), isDilithiumAvailable: () => true }));

const { WalletManager } = require('../src/components/WalletManager');
const lc = require('../src/crypto/QcLightClient');
const { mergeTokenBalances, optimisticTokenRow, tokenFigureRow } = require('../src/utils/balanceMerge');

const ME = 'dc6e4f045e96c0bf43deon546e9f27ad8f91464e6a4f6';
const TOKEN = 'c'.repeat(64);
const ROOT = 'ab'.repeat(32);
const body = (over = {}) => JSON.stringify({
  address: ME, balance: 75000000000, nonce: 4, last_claimed_epoch: 40320, merkle_proof: [{ sibling: '00', is_right: true }],
  state_root: ROOT, block_height: 3672187, ...over,
});
const tokenBody = (over = {}) => JSON.stringify({
  contract_address: TOKEN, holder: ME, token_balance: '123456789', storage_proof: [], storage_root: 'cd'.repeat(32),
  account_balance: '0', account_nonce: 0, account_proof: [], state_root: ROOT, block_height: 3672190, proof_valid: true, ...over,
});
const reply = (text) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text) });
const baseOf = (u) => u.slice(0, u.indexOf('/api'));

beforeEach(() => {
  WalletManager.liveFigures.clear();
  WalletManager.liveReads.clear();
  WalletManager.nodeHealth = {};
});

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
    expect(asked.some((u) => lc.nodeMarkedOld(baseOf(u)))).toBe(false);
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

  // Before, one answer that did not fold ended the read with nothing, though another genesis name had a good one.
  it('an answer that does not fold asks the next genesis name, each at most once', async () => {
    const wm = new WalletManager();
    let first = null;
    global.fetch = jest.fn(async (url) => {
      asked.push(url);
      if (first === null) first = baseOf(url);
      return reply(baseOf(url) === first ? body({ balance: 1 }) : body());
    });
    wm.verifyMerkleProof = jest.fn(async (address, balance) => balance === '75000000000');
    await expect(wm.liveQncFigure(ME)).resolves.toMatchObject({ balanceNano: '75000000000' });
    expect(new Set(asked.map(baseOf)).size).toBe(asked.length);
    expect(asked.length).toBeGreaterThanOrEqual(2);
  });
});

describe('liveTokenFigure', () => {
  it('both levels folded to the root the node served, from the token route without mb, scaled by its decimals', async () => {
    const asked = [];
    global.fetch = jest.fn(async (url) => { asked.push(url); return reply(tokenBody()); });
    const wm = new WalletManager();
    wm.verifyTokenBalanceProof = jest.fn(async () => true);
    // `node`: the genesis name that answered (a token send check reads the holder's QNC figure of the same block there).
    await expect(wm.liveTokenFigure(TOKEN, ME, 6)).resolves.toEqual({
      balanceBase: '123456789', balance: '123.456789', blockHeight: 3672190, node: baseOf(asked[0]),
    });
    expect(asked.every((u) => u.endsWith(`/api/v1/token/${TOKEN}/${ME}/balance/proof`))).toBe(true);
    expect(wm.verifyTokenBalanceProof.mock.calls[0].slice(1)).toEqual([TOKEN, ME]);
    expect(asked.some((u) => lc.nodeMarkedOld(baseOf(u)))).toBe(false);
  });

  it('nothing when the levels do not fold, for a certified body, or a body that names no height or an odd balance', async () => {
    const wm = new WalletManager();
    wm.verifyTokenBalanceProof = jest.fn(async () => false);
    global.fetch = jest.fn(async () => reply(tokenBody()));
    await expect(wm.liveTokenFigure(TOKEN, ME, 6)).resolves.toBeNull();
    wm.verifyTokenBalanceProof = jest.fn(async () => true);
    for (const over of [{ proof_format: 2 }, { block_height: 'x' }, { token_balance: '1.5' }, { storage_proof: null }]) {
      global.fetch = jest.fn(async () => reply(tokenBody(over)));
      await expect(wm.liveTokenFigure(TOKEN, ME, 6)).resolves.toBeNull();
    }
  });
});

describe('what Assets shows of a live figure', () => {
  // Before, a lower live figure never lowered the balance (one unverified node could be lagging); the screen now takes a
  // live figure only when it is of a newer state than the one shown, so a lower one is a spend made elsewhere.
  it('a live QNC figure lowers the balance; an unverified figure of no known state still does not', () => {
    const prev = { owner: ME, qnc: 10, sol: 0, '1dev': 0 };
    expect(mergeTokenBalances(prev, { owner: ME, qnc: 4, verified: false }).qnc).toBe(10);
    expect(mergeTokenBalances(prev, { owner: ME, qnc: 4, verified: false, live: true }).qnc).toBe(4);
  });

  // Before, a certified token proof replaced the row with no height check: after a send or a receipt the row went back
  // to the older balance, with its mark, until certification caught up.
  it('a token row takes a certified figure only of its state or newer, and never goes back to an older one', () => {
    const row = { contract: TOKEN, symbol: 'T', balance: '9', verified: false };
    const live = tokenFigureRow(row, { balance: '7', blockHeight: 3672190 });
    expect(live).toEqual({ ...row, balance: '7', figureHeight: 3672190, verified: false });
    // The certified figure of an older state (before the send) leaves the live one, and gives no mark.
    expect(tokenFigureRow(live, { balance: '9', blockHeight: 3672100, verified: true })).toBe(live);
    // Of the same state or newer: it replaces the figure, with its mark.
    expect(tokenFigureRow(live, { balance: '7', blockHeight: 3672190, verified: true })).toEqual({ ...live, verified: true });
    const newer = tokenFigureRow(live, { balance: '5', blockHeight: 3672200, verified: true });
    expect(newer).toMatchObject({ balance: '5', figureHeight: 3672200, verified: true });
    // A live figure of that same state leaves the mark; a newer live one replaces it without.
    expect(tokenFigureRow(newer, { balance: '5', blockHeight: 3672200 })).toBe(newer);
    expect(tokenFigureRow(newer, { balance: '6', blockHeight: 3672300 })).toMatchObject({ balance: '6', verified: false });
    // Nothing to apply: the same row.
    for (const f of [{ balance: 5, blockHeight: 1 }, { balance: '5', blockHeight: null }, { balance: '5', blockHeight: -1 }]) {
      expect(tokenFigureRow(newer, f)).toBe(newer);
    }
    // The optimistic figure after a send keeps the state it came from, so no older certified figure goes over it.
    const wm = { toBaseUnits: (v) => String(Math.round(Number(v))), _formatBaseUnits: (v) => String(v) };
    const sent = optimisticTokenRow(newer, TOKEN, false, '2', 0, wm);
    expect(sent).toMatchObject({ balance: '3', figureHeight: 3672200, verified: false });
    expect(tokenFigureRow(sent, { balance: '5', blockHeight: 3672190, verified: true })).toBe(sent);
  });
});
