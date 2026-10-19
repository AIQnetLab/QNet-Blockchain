/**
 * Sending right after the wallet's own send (owner, 07.10 and 18.10). A send is checked against the wallet's figure at
 * a genesis node's live tip, its proof folded, which may not hold this wallet's newest transactions yet: available =
 * that figure less the amount and fee of each of this wallet's OWN transactions above the figure's nonce (kept records,
 * settled or not); what came in counts as the figure holds it; a nonce in between that is none of this wallet's own
 * transactions (spent from another device) refuses nothing, the network decides. The same for token sends (the token
 * amounts of own transfers) and the in-app browser.
 */
jest.mock('../src/crypto/DilithiumCrypto', () => ({
  verifyDilithium: jest.fn(), isDilithiumAvailable: () => true, signDetached: jest.fn(async () => 'ab'.repeat(3309)),
}));

const fs = require('fs');
const path = require('path');
const AsyncStorage = require('@react-native-async-storage/async-storage');
const { WalletManager } = require('../src/components/WalletManager');
const Pending = require('../src/services/PendingTx');
const { spendableNano, spendableTokenBase, previewShort } = require('../src/browser/dappProvider');
const { unreadKey } = require('../src/browser/DappSheet');
const { TRANSFER_FEE_NANO, STORAGE_DEPOSIT_NANO } = require('../src/config/fees');
const lc = require('../src/crypto/QcLightClient');
const { translate } = require('../src/i18n');

const ME = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';
const TO = 'dc6e4f045e96c0bf43deon546e9f27ad8f91464e6a4f6';
const TOKEN = 'c'.repeat(64);
const QNC = 1_000_000_000;

beforeEach(async () => {
  await AsyncStorage.clear();
  WalletManager.liveFigures.clear();
  WalletManager.liveReads.clear();
  WalletManager.nonceReads.clear();
  WalletManager.lastOwnSendAt.clear();
  lc.clearQcCache();
});

// A wallet manager whose sends are signed and taken (no network), at the nonces `nonces` gives one after another.
function sender(nonces) {
  const wm = new WalletManager();
  const queue = [...nonces];
  wm.resolveNonce = jest.fn(async () => { const n = queue.shift(); return { nonce: n, replaces: null, confirmed: n - 1 }; });
  wm._sendPending = jest.fn(async () => ({ accepted: true, data: { tx_hash: 'h'.repeat(64) } }));
  wm._rememberRecipient = jest.fn(async () => {});
  wm.loadWallet = jest.fn(async () => ({
    secretKey: [1], qnetAddress: ME,
    qnetKeypair: { publicKey: Array(1952).fill(1), privateKey: Array(4032).fill(2) },
  }));
  wm._loadContractSigner = jest.fn(async () => ({ from: ME, dilPkHex: '01'.repeat(1952), dilSkHex: '02'.repeat(4032) }));
  return wm;
}

// The live figure the next send check reads: `nonce` the account nonce in that state.
function live(wm, balanceNano, nonce, blockHeight = 9000) {
  wm.liveQncFigure = jest.fn(async () => ({
    balance: Number(balanceNano) / QNC, balanceNano: String(balanceNano), nonce: String(nonce), blockHeight, figureClaimedEpoch: 0,
  }));
}

describe('what this wallet signed is remembered by nonce with the most it can take', () => {
  it('a QNC transfer: its amount and fee; a token transfer: its fee and deposit, and the tokens it moves', async () => {
    const wm = sender([6, 7, 8]);
    await wm.sendQNC(TO, 2, 'pw');
    await wm.qrc20Transfer(TOKEN, TO, '300', 'pw');
    await wm.qrc20Approve(TOKEN, TO, '999', 'pw');
    const spends = await Pending.ownSpends(ME);
    expect(spends.get(6)).toEqual({ qncNano: String(2 * QNC + TRANSFER_FEE_NANO), tokens: {}, tokenUnknown: false });
    const t = spends.get(7);
    expect(BigInt(t.qncNano)).toBeGreaterThan(BigInt(STORAGE_DEPOSIT_NANO));
    expect(t.tokens).toEqual({ [TOKEN]: '300' });
    expect(t.tokenUnknown).toBe(false);
    expect(spends.get(8).tokens).toEqual({}); // an approval moves no tokens
    expect(WalletManager.lastOwnSendAt.get(ME)).toBeGreaterThan(0);
  });

  it('what a contract does with tokens is unknown; a token call\'s effect on the sender is read from its method', () => {
    expect(WalletManager._tokenSpendOf(ME, TOKEN, 'transfer', [TO, '5'])).toEqual({ tokens: { [TOKEN]: '5' } });
    expect(WalletManager._tokenSpendOf(ME, TOKEN, 'burn', ['7'])).toEqual({ tokens: { [TOKEN]: '7' } });
    expect(WalletManager._tokenSpendOf(ME, TOKEN, 'transferFrom', [ME, TO, '9'])).toEqual({ tokens: { [TOKEN]: '9' } });
    expect(WalletManager._tokenSpendOf(ME, TOKEN, 'transferFrom', [TO, ME, '9'])).toEqual({});
    expect(WalletManager._tokenSpendOf(ME, TOKEN, 'mint', [ME, '9'])).toEqual({});
    expect(WalletManager._tokenSpendOf(ME, TOKEN, 'swap', ['1'])).toEqual({ tokenUnknown: true });
  });

  it('two signed at one nonce count as the larger; a settled one is kept an hour, an unsettled one while it can land', async () => {
    const entry = (nonce, amountNano) => ({
      from: ME, nonce, path: '/p', body: { n: nonce, a: amountNano }, summary: { kind: 'transfer', to: TO, amountNano },
      spend: { qncNano: String(amountNano + TRANSFER_FEE_NANO) }, createdAt: Date.now(),
    });
    await Pending.putSigned(entry(6, 5 * QNC));
    await Pending.putSigned(entry(6, 1 * QNC)); // the replacement is smaller: either may apply
    expect((await Pending.ownSpends(ME)).get(6).qncNano).toBe(String(5 * QNC + TRANSFER_FEE_NANO));
    await Pending.putSigned(entry(7, 1 * QNC));
    const now = Date.now();
    await Pending.settle(ME, 6, now);
    let spends = await Pending.ownSpends(ME);
    expect(spends.has(6)).toBe(true); // settled, still known
    expect(spends.has(7)).toBe(true); // unsettled, kept
    await Pending.settle(ME, 6, now + Pending.SPENT_KEEP_MS + 1);
    spends = await Pending.ownSpends(ME);
    // The settled record has gone; the recent-settled summary still knows the transfer (by its own amount).
    expect(spends.get(6)).toEqual({ qncNano: String(1 * QNC + TRANSFER_FEE_NANO), tokens: {}, tokenUnknown: false });
  });

  it('an entry an older build kept (no spend recorded) counts by its summary; a call\'s token effect is unknown', async () => {
    await AsyncStorage.setItem(Pending.PENDING_KEY, JSON.stringify({
      [ME]: [
        { from: ME, nonce: 6, state: 'open', bodyHash: 'x', summary: { kind: 'transfer', to: TO, amountNano: 3 * QNC } },
        { from: ME, nonce: 7, state: 'open', bodyHash: 'y', summary: { kind: 'call', to: TOKEN, method: 'transfer', reserveNano: 1234 } },
        { from: ME, nonce: 8, state: 'open', bodyHash: 'z', summary: { kind: 'other' } },
      ],
    }));
    const spends = await Pending.ownSpends(ME);
    expect(spends.get(6)).toEqual({ qncNano: String(3 * QNC + TRANSFER_FEE_NANO), tokens: {}, tokenUnknown: false });
    expect(spends.get(7)).toEqual({ qncNano: '1234', tokens: {}, tokenUnknown: true });
    expect(spends.get(8).qncNano).toBeNull();
  });
});

describe('the rule (services/PendingTx spendableFrom)', () => {
  const s = (entries) => new Map(entries.map(([n, q, tokens = {}, tokenUnknown = false]) => [n, { qncNano: q, tokens, tokenUnknown }]));

  it('own transactions above the figure\'s nonce come off it: applied after it, or still unsettled apart', () => {
    const r = Pending.spendableFrom({
      base: String(10 * QNC), baseNonce: 5, accountNonce: 6,
      spends: s([[5, '999'], [6, String(2 * QNC)], [7, String(QNC)]]),
    });
    expect(r).toEqual({ ok: true, balance: String(8 * QNC), pending: [{ nonce: 7, amount: String(QNC) }] });
  });

  // Before, a nonce between the certified one and the account's that was none of this wallet's refused the send ("a
  // transaction from another device is not confirmed yet"); with a live figure it is applied, and the network decides.
  it('a nonce in between that is none of this wallet\'s (another device) refuses nothing: the network decides', () => {
    expect(Pending.spendableFrom({ base: '100', baseNonce: 5, accountNonce: 7, spends: s([[6, '1']]) }))
      .toEqual({ ok: true, balance: '99', pending: [] });
  });

  it('the figure is the most there is: it never goes below 0', () => {
    const r = Pending.spendableFrom({ base: String(QNC), baseNonce: 5, accountNonce: 6, spends: s([[6, String(3 * QNC)]]) });
    expect(r).toEqual({ ok: true, balance: '0', pending: [] });
  });

  it('a transaction whose cost is not known leaves the balance unconfirmed; tokens count only token amounts', () => {
    expect(Pending.spendableFrom({ base: '100', baseNonce: 5, accountNonce: 6, spends: s([[6, null]]) }))
      .toEqual({ ok: false, reason: 'unconfirmed' });
    const spends = s([[6, String(QNC)], [7, '50', { [TOKEN]: '30' }], [8, '50', { ['d'.repeat(64)]: '9' }]]);
    expect(Pending.spendableFrom({ base: '100', baseNonce: 5, accountNonce: 7, spends, token: TOKEN }))
      .toEqual({ ok: true, balance: '70', pending: [{ nonce: 8, amount: '0' }] });
    expect(Pending.spendableFrom({ base: '100', baseNonce: 5, accountNonce: 6, spends: s([[6, '1', {}, true]]), token: TOKEN }))
      .toEqual({ ok: false, reason: 'unconfirmed' });
  });
});

describe('the send check after the wallet\'s own send', () => {
  it('the live figure holds the send already: spent from as it is', async () => {
    const wm = sender([6]);
    await wm.sendQNC(TO, 2, 'pw');
    live(wm, 8 * QNC - TRANSFER_FEE_NANO, 6);
    await expect(wm.qncForSend(ME, { nonce: 6 })).resolves.toEqual({
      ok: true, balanceNano: String(8 * QNC - TRANSFER_FEE_NANO), nonce: '6', accountNonce: 6, pending: [],
      balance: (8 * QNC - TRANSFER_FEE_NANO) / QNC, blockHeight: 9000,
    });
  });

  it('a node a block behind (its figure at nonce 5): the send the chain applied at 6 comes off it', async () => {
    const wm = sender([6]);
    await wm.sendQNC(TO, 2, 'pw');
    live(wm, 10 * QNC, 5);
    await expect(wm.qncForSend(ME, { nonce: 6 })).resolves.toMatchObject({
      ok: true, nonce: '5', accountNonce: 6, pending: [], balanceNano: String(10 * QNC - 2 * QNC - TRANSFER_FEE_NANO),
    });
  });

  it('a send still unconfirmed is counted apart, so a send in addition and a replacement are each checked right', async () => {
    const wm = sender([6, 7]);
    await wm.sendQNC(TO, 2, 'pw');
    await wm.sendQNC(TO, 3, 'pw');
    live(wm, 10 * QNC, 5);
    const r = await wm.qncForSend(ME, { nonce: 6 });
    expect(r.balanceNano).toBe(String(8 * QNC - TRANSFER_FEE_NANO));
    expect(r.pending).toEqual([{ nonce: 7, amount: String(3 * QNC + TRANSFER_FEE_NANO) }]);
    // In addition: both count; replacing nonce 7: only the settled one does (the sheet's rule, dappProvider spendableNano).
    const preview = { balanceNano: r.balanceNano, spends: r.pending, replaceNonce: 7 };
    expect(spendableNano(preview)).toBe(BigInt(5 * QNC - 2 * TRANSFER_FEE_NANO));
    expect(spendableNano(preview, 'replace')).toBe(BigInt(8 * QNC - TRANSFER_FEE_NANO));
  });

  it('another device spent at a nonce in between: no refusal, the figure less this wallet\'s own sends', async () => {
    const wm = sender([6]);
    await wm.sendQNC(TO, 2, 'pw');
    live(wm, 10 * QNC, 5);
    await expect(wm.qncForSend(ME, { nonce: 7 })).resolves.toMatchObject({
      ok: true, accountNonce: 7, balanceNano: String(8 * QNC - TRANSFER_FEE_NANO),
    });
  });

  // Before, money that came in after the last certified checkpoint was never spendable until certification caught up.
  it('money that came in counts at once: the live figure holds it', async () => {
    const wm = sender([6]);
    await wm.sendQNC(TO, 2, 'pw');
    live(wm, 12 * QNC, 6); // 1 QNC left after the send, then 11 QNC received
    await expect(wm.qncForSend(ME, { nonce: 6 })).resolves.toMatchObject({ ok: true, balanceNano: String(12 * QNC) });
  });

  it('the nonce counted up to never falls below the highest this device confirmed', async () => {
    const wm = sender([6]);
    await wm.sendQNC(TO, 2, 'pw');
    await wm._setNonceHighWater(ME, 6);
    live(wm, 10 * QNC, 5);
    // A lagging read of the account nonce (5) still counts the settled send at 6.
    await expect(wm.qncForSend(ME, { nonce: 5 })).resolves.toMatchObject({ ok: true, accountNonce: 6, balanceNano: String(8 * QNC - TRANSFER_FEE_NANO) });
  });

  it('the check never waits for a certified read, and no figure is a refusal said as no answer', async () => {
    const wm = sender([]);
    wm.getQNCBalanceWithProof = jest.fn(() => new Promise(() => {}));
    live(wm, 4 * QNC, 9);
    await expect(wm.qncForSend(ME, { nonce: 8 })).resolves.toMatchObject({ ok: true, balanceNano: String(4 * QNC), accountNonce: 9 });
    expect(wm.getQNCBalanceWithProof).not.toHaveBeenCalled();
    wm.liveQncFigure = jest.fn(async () => null);
    await expect(wm.qncForSend(ME, { nonce: 8 })).resolves.toEqual({ ok: false, balanceNano: null, nonce: null, error: 'unanswered' });
  });

  it('token sends: the live token figure less the tokens own transfers it does not hold yet', async () => {
    const wm = sender([6, 7]);
    await wm.qrc20Transfer(TOKEN, TO, '300', 'pw');
    await wm.qrc20Transfer(TOKEN, TO, '100', 'pw');
    live(wm, 10 * QNC, 5);
    wm.liveTokenFigure = jest.fn(async () => ({ balanceBase: '1000', balance: '1000', blockHeight: 9000 }));
    const r = await wm.checkedTokenBalance(TOKEN, ME, 0, { nonce: 6 });
    expect(r).toEqual({ ok: true, balanceBase: '700', pending: [{ nonce: 7, amount: '100' }], balance: '700' });
    expect(spendableTokenBase({ tokenBalanceBase: r.balanceBase, tokenSpends: r.pending, replaceNonce: 7 })).toBe(600n);
    expect(spendableTokenBase({ tokenBalanceBase: r.balanceBase, tokenSpends: r.pending, replaceNonce: 7 }, 'replace')).toBe(700n);
    // Another device's transaction in between refuses nothing: both own transfers applied, nothing pending.
    await expect(wm.checkedTokenBalance(TOKEN, ME, 0, { nonce: 8 })).resolves.toMatchObject({ ok: true, balanceBase: '600', pending: [] });
  });

  // Before, the token figure (read now) was paired with a QNC figure kept up to 15 s, of another block: a second token
  // send within 15 s of the first counted the first twice and was refused for want of tokens the wallet held.
  describe('the token figure and the holder\'s QNC figure of one block', () => {
    const PROOF = [{ sibling: '00'.repeat(32), is_right: true }];
    // The genesis nodes' live proof routes: the token's at `tokenAt()`, the account's at `qncAt()` (heights), both folding.
    const answering = (wm, { tokenAt, qncAt, tokenBase, qnc }) => {
      wm.verifyMerkleProof = jest.fn(async () => true);
      wm.verifyTokenBalanceProof = jest.fn(async () => true);
      wm._hedged = jest.fn(async (p, opts) => {
        const base = opts.nodes[0];
        const body = p.startsWith('/api/v1/token/')
          ? { token_balance: tokenBase, storage_proof: PROOF, account_proof: PROOF, state_root: 'ab', block_height: tokenAt() }
          : { balance: qnc.balanceNano, nonce: qnc.nonce, merkle_proof: PROOF, state_root: 'ab', block_height: qncAt() };
        return { ok: true, status: 200, base, data: JSON.stringify(body) };
      });
    };

    it('a figure kept from before the wallet\'s own token send is not paired with a token figure after it', async () => {
      const wm = sender([5]);
      await wm.qrc20Transfer(TOKEN, TO, '60', 'pw');
      // The Send screen's read a moment before that send: nonce 4, 100 tokens then.
      WalletManager.liveFigures.set(ME, { at: Date.now(), figure: { balance: 10, balanceNano: String(10 * QNC), nonce: '4', blockHeight: 9000, figureClaimedEpoch: 0 } });
      // Now the send is in a block: 40 tokens left, and the account at nonce 5 in that same block.
      answering(wm, { tokenAt: () => 9001, qncAt: () => 9001, tokenBase: '40', qnc: { balanceNano: 10 * QNC - 1000, nonce: 5 } });
      await expect(wm.checkedTokenBalance(TOKEN, ME, 0, { nonce: 5 })).resolves.toEqual({ ok: true, balanceBase: '40', pending: [], balance: '40' });
    });

    it('figures of two blocks are read again once, both from the node that gave the token figure; never of one: unanswered', async () => {
      const wm = sender([]);
      let qncHeight = 9000;
      answering(wm, {
        tokenAt: () => 9001, qncAt: () => { const h = qncHeight; qncHeight = 9001; return h; }, tokenBase: '40', qnc: { balanceNano: QNC, nonce: 5 },
      });
      await expect(wm.checkedTokenBalance(TOKEN, ME, 0, { nonce: 5 })).resolves.toMatchObject({ ok: true, balanceBase: '40' });
      const asked = wm._hedged.mock.calls.map(([p, o]) => [p.startsWith('/api/v1/token/') ? 'token' : 'qnc', o.nodes]);
      const first = asked[0][1][0];
      expect(asked.slice(2)).toEqual([['token', [first]], ['qnc', [first]]]);
      answering(wm, { tokenAt: () => 9001, qncAt: () => 9000, tokenBase: '40', qnc: { balanceNano: QNC, nonce: 5 } });
      await expect(wm.checkedTokenBalance(TOKEN, ME, 0, { nonce: 5 })).resolves.toMatchObject({ ok: false, balanceBase: null, error: 'unanswered' });
      expect(wm._hedged).toHaveBeenCalledTimes(4);
    });
  });

  it('a contract call of this wallet the figure does not hold leaves a token balance unconfirmed (its effect is not known)', async () => {
    const wm = sender([6]);
    await wm.callWasmContract({ contract: TO, method: 'run' }, 'pw');
    live(wm, 10 * QNC, 5);
    wm.liveTokenFigure = jest.fn(async () => ({ balanceBase: '1000', balance: '1000', blockHeight: 9000 }));
    await expect(wm.checkedTokenBalance(TOKEN, ME, 0, { nonce: 6 })).resolves.toMatchObject({ ok: false, error: 'unconfirmed' });
    // QNC is still checked: the call's most fee is known.
    await expect(wm.qncForSend(ME, { nonce: 6 })).resolves.toMatchObject({ ok: true });
  });

  it('the in-app browser\'s token check refuses a transfer the own unconfirmed ones would leave unpaid', () => {
    const d = { type: 'tokenTransfer', amountBase: '650', feeNano: '1000' };
    const p = { balanceNano: String(QNC), spends: [], tokenBalanceBase: '700', tokenSpends: [{ nonce: 7, amount: '100' }], replaceNonce: 7 };
    expect(previewShort(d, p)).toBe(true);
    expect(previewShort(d, p, 'replace')).toBe(false);
  });
});

describe('the two messages: no answer, or what a transaction takes not known yet', () => {
  it('the sheet and the Send form say which, in every language', () => {
    expect(unreadKey('transfer', { balanceProblem: 'unconfirmed' })).toBe('balance_unconfirmed');
    expect(unreadKey('transfer', { balanceProblem: 'unanswered' })).toBe('dapp_send_preview_failed');
    expect(unreadKey('tokenTransfer', { balanceProblem: null, tokenProblem: 'unconfirmed' })).toBe('balance_unconfirmed');
    for (const lang of ['en', 'zh-CN', 'ru', 'es', 'ko', 'ja', 'pt', 'fr', 'de', 'ar', 'it']) {
      for (const key of ['balance_unconfirmed', 'send_balance_unreadable']) expect(translate(lang, key)).not.toBe(key);
      expect(translate(lang, 'balance_unconfirmed')).not.toBe(translate(lang, 'send_balance_unreadable'));
      // The certified send check's texts are gone with it.
      for (const key of ['balance_foreign_pending', 'balance_verifying_steps']) expect(translate(lang, key)).toBe(key);
    }
    // The one cause left: what one of this wallet's own transactions takes is not known here (owner, 18.10).
    expect(translate('en', 'balance_unconfirmed')).toBe('What an earlier transaction from this wallet takes is not known yet. Try again in a minute.');
    for (const lang of ['ru', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'zh-CN', 'ar']) {
      expect(translate(lang, 'balance_unconfirmed')).not.toMatch(/подтвержд|confirmad|confirmé|bestätigt|confermato|確認され|확인되지|确认|يُؤكَّد/);
    }
  });

  it('the Send form refuses with the reason the check gave, for QNC and for a token, and counts own unconfirmed sends', () => {
    const ws = fs.readFileSync(path.join(__dirname, '../src/screens/WalletScreen.js'), 'utf8');
    const send = ws.slice(ws.indexOf('const handleSendTransaction = async () => {'), ws.indexOf('const pressSend = async'));
    expect(send).toMatch(/if \(isQnetSend && qncCheck\.error\) \{\s*setTxResult\(\{ success: false, title: t\('send_cannot_title'\), error: sendCheckError\(qncCheck\.error\) \}\);/);
    expect(send).toMatch(/error: sendCheckError\(held && held\.error\)/);
    expect(send).toMatch(/spendable = afterPending\(qncNano, qncCheck\.pending, replaceNonce\);/);
    expect(send).toMatch(/const tokenLeft = afterPending\(held\.balanceBase, held\.pending, replaceNonce\);/);
    expect(ws).toMatch(/const sendCheckError = \(error\) => t\(error === 'unconfirmed' \? 'balance_unconfirmed' : 'send_balance_unreadable'\);/);
  });
});
