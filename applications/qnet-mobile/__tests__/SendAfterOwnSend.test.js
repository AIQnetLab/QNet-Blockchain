/**
 * Sending right after the wallet's own send (owner, 07.10). The certified state a send is decided by lags the chain by
 * minutes, so the next send's nonce is above the certified nonce. The decision stays on the certified base only:
 * available = the certified balance less the amount and fee of each of this wallet's OWN transactions from the
 * certified nonce up to the next nonce (kept records, settled or not); anything received after the checkpoint never
 * counts; a nonce in that range that is none of this wallet's own transactions (spent from another device) refuses the
 * send with its own message. The same for token sends (the token amounts of own transfers) and the in-app browser.
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
const ROOT = 'ab'.repeat(32);

beforeEach(async () => {
  await AsyncStorage.clear();
  WalletManager.sendProofs.clear();
  WalletManager.sendReads.clear();
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

// The certified QNC proof the next send check reads: `nonce` the account nonce in the certified state.
function certified(wm, balanceNano, nonce, index = 40) {
  wm.getQNCBalanceWithProof = jest.fn(async () => ({
    ok: true, verified: true, balanceNano: String(balanceNano), nonce: String(nonce), balance: Number(balanceNano) / QNC,
    index, stateRoot: ROOT,
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

  it('own transactions from the certified nonce on are counted: settled ones from the balance, unsettled ones apart', () => {
    const r = Pending.spendableFrom({
      certified: String(10 * QNC), certifiedNonce: 5, accountNonce: 6,
      spends: s([[5, '999'], [6, String(2 * QNC)], [7, String(QNC)]]),
    });
    expect(r).toEqual({ ok: true, balance: String(8 * QNC), pending: [{ nonce: 7, amount: String(QNC) }] });
  });

  it('a nonce between the certified one and the account\'s that is none of this wallet\'s: another device, refused', () => {
    expect(Pending.spendableFrom({ certified: '100', certifiedNonce: 5, accountNonce: 7, spends: s([[6, '1']]) }))
      .toEqual({ ok: false, reason: 'foreign', nonce: 7 });
  });

  it('nothing received after the checkpoint is counted: the certified figure is the most there is', () => {
    const r = Pending.spendableFrom({ certified: String(QNC), certifiedNonce: 5, accountNonce: 6, spends: s([[6, String(3 * QNC)]]) });
    expect(r).toEqual({ ok: true, balance: '0', pending: [] });
  });

  it('a transaction whose cost is not known leaves the balance unconfirmed; tokens count only token amounts', () => {
    expect(Pending.spendableFrom({ certified: '100', certifiedNonce: 5, accountNonce: 6, spends: s([[6, null]]) }))
      .toEqual({ ok: false, reason: 'unconfirmed' });
    const spends = s([[6, String(QNC)], [7, '50', { [TOKEN]: '30' }], [8, '50', { ['d'.repeat(64)]: '9' }]]);
    expect(Pending.spendableFrom({ certified: '100', certifiedNonce: 5, accountNonce: 7, spends, token: TOKEN }))
      .toEqual({ ok: true, balance: '70', pending: [{ nonce: 8, amount: '0' }] });
    expect(Pending.spendableFrom({ certified: '100', certifiedNonce: 5, accountNonce: 6, spends: s([[6, '1', {}, true]]), token: TOKEN }))
      .toEqual({ ok: false, reason: 'unconfirmed' });
  });
});

describe('the send check after the wallet\'s own send', () => {
  it('the next send right after one: allowed on the certified base less that send', async () => {
    const wm = sender([6]);
    await wm.sendQNC(TO, 2, 'pw');
    // The chain confirms nonce 6; the certified state is still at 5 with 10 QNC.
    certified(wm, 10 * QNC, 5);
    const r = await wm.certifiedQncForSend(ME, { nonce: 6 });
    expect(r).toMatchObject({
      ok: true, verified: true, certifiedNano: String(10 * QNC), nonce: '5', accountNonce: 6, pending: [],
      balanceNano: String(10 * QNC - 2 * QNC - TRANSFER_FEE_NANO),
    });
  });

  it('a send still unconfirmed is counted apart, so a send in addition and a replacement are each checked right', async () => {
    const wm = sender([6, 7]);
    await wm.sendQNC(TO, 2, 'pw');
    await wm.sendQNC(TO, 3, 'pw');
    certified(wm, 10 * QNC, 5);
    const r = await wm.certifiedQncForSend(ME, { nonce: 6 });
    expect(r.balanceNano).toBe(String(8 * QNC - TRANSFER_FEE_NANO));
    expect(r.pending).toEqual([{ nonce: 7, amount: String(3 * QNC + TRANSFER_FEE_NANO) }]);
    // In addition: both count; replacing nonce 7: only the settled one does (the sheet's rule, dappProvider spendableNano).
    const preview = { balanceNano: r.balanceNano, spends: r.pending, replaceNonce: 7 };
    expect(spendableNano(preview)).toBe(BigInt(5 * QNC - 2 * TRANSFER_FEE_NANO));
    expect(spendableNano(preview, 'replace')).toBe(BigInt(8 * QNC - TRANSFER_FEE_NANO));
  });

  it('a nonce no transaction of this wallet holds (sent from another device) refuses the send, said as such', async () => {
    const wm = sender([6]);
    await wm.sendQNC(TO, 2, 'pw');
    certified(wm, 10 * QNC, 5);
    await expect(wm.certifiedQncForSend(ME, { nonce: 7 })).resolves.toMatchObject({ ok: false, balanceNano: null, error: 'foreign', foreignNonce: 7 });
    // With nothing of its own since the checkpoint, any newer nonce is another device's.
    await AsyncStorage.clear();
    const other = sender([]);
    certified(other, 10 * QNC, 5);
    await expect(other.certifiedQncForSend(ME, { nonce: 6 })).resolves.toMatchObject({ ok: false, error: 'foreign' });
  });

  it('incoming funds after the checkpoint never count: only the certified figure is spent from', async () => {
    const wm = sender([6]);
    await wm.sendQNC(TO, 2, 'pw');
    // The certified state holds 1 QNC; whatever arrived since (the send could only pay from it) is not counted.
    certified(wm, 1 * QNC, 5);
    await expect(wm.certifiedQncForSend(ME, { nonce: 6 })).resolves.toMatchObject({ ok: true, balanceNano: '0' });
  });

  it('a certified proof newer than the account nonce needs nothing of the wallet\'s records', async () => {
    const wm = sender([]);
    certified(wm, 4 * QNC, 9);
    await expect(wm.certifiedQncForSend(ME, { nonce: 8 })).resolves.toMatchObject({ ok: true, balanceNano: String(4 * QNC), accountNonce: 9 });
  });

  it('the nonce counted up to never falls below the highest this device confirmed', async () => {
    const wm = sender([6]);
    await wm.sendQNC(TO, 2, 'pw');
    await wm._setNonceHighWater(ME, 6);
    certified(wm, 10 * QNC, 5);
    // A lagging read of the account nonce (5) still counts the settled send at 6.
    await expect(wm.certifiedQncForSend(ME, { nonce: 5 })).resolves.toMatchObject({ ok: true, accountNonce: 6, balanceNano: String(8 * QNC - TRANSFER_FEE_NANO) });
  });

  it('token sends: the certified token balance of the same state, less the tokens own transfers moved', async () => {
    const wm = sender([6, 7]);
    await wm.qrc20Transfer(TOKEN, TO, '300', 'pw');
    await wm.qrc20Transfer(TOKEN, TO, '100', 'pw');
    certified(wm, 10 * QNC, 5, 40);
    wm.getTokenBalanceWithProof = jest.fn(async (contract, holder, decimals, verify, opts) => ({
      ok: true, verified: true, balanceBase: '1000', stateRoot: ROOT, index: opts && opts.index,
    }));
    const r = await wm.checkedTokenBalance(TOKEN, ME, 0, { nonce: 6 });
    expect(r).toMatchObject({ ok: true, verified: true, certifiedBase: '1000', balanceBase: '700', pending: [{ nonce: 7, amount: '100' }] });
    expect(wm.getTokenBalanceWithProof.mock.calls[0][4]).toEqual({ index: 40 }); // paired with the QNC proof's macroblock
    expect(spendableTokenBase({ tokenBalanceBase: r.balanceBase, tokenSpends: r.pending, replaceNonce: 7 })).toBe(600n);
    expect(spendableTokenBase({ tokenBalanceBase: r.balanceBase, tokenSpends: r.pending, replaceNonce: 7 }, 'replace')).toBe(700n);
    // Another device's transaction in between refuses the token send too.
    await expect(wm.checkedTokenBalance(TOKEN, ME, 0, { nonce: 8 })).resolves.toMatchObject({ ok: false, error: 'foreign' });
  });

  it('a contract call of this wallet since the checkpoint leaves a token balance unconfirmed (its effect is not known)', async () => {
    const wm = sender([6]);
    await wm.callWasmContract({ contract: TO, method: 'run' }, 'pw');
    certified(wm, 10 * QNC, 5, 40);
    wm.getTokenBalanceWithProof = jest.fn(async (c, h, d, v, opts) => ({ ok: true, verified: true, balanceBase: '1000', stateRoot: ROOT, index: opts.index }));
    await expect(wm.checkedTokenBalance(TOKEN, ME, 0, { nonce: 6 })).resolves.toMatchObject({ ok: false, error: 'unconfirmed' });
    // QNC is still decided: the call's most fee is known.
    await expect(wm.certifiedQncForSend(ME, { nonce: 6 })).resolves.toMatchObject({ ok: true });
  });

  it('the in-app browser\'s token check refuses a transfer the own unconfirmed ones would leave unpaid', () => {
    const d = { type: 'tokenTransfer', amountBase: '650', feeNano: '1000' };
    const p = { balanceNano: String(QNC), spends: [], tokenBalanceBase: '700', tokenSpends: [{ nonce: 7, amount: '100' }], replaceNonce: 7 };
    expect(previewShort(d, p)).toBe(true);
    expect(previewShort(d, p, 'replace')).toBe(false);
  });
});

describe('the two messages: no answer, or not confirmed yet', () => {
  it('the sheet and the Send form say which, in every language', () => {
    expect(unreadKey('transfer', { balanceProblem: 'foreign' })).toBe('balance_foreign_pending');
    expect(unreadKey('transfer', { balanceProblem: 'unconfirmed' })).toBe('balance_unconfirmed');
    expect(unreadKey('transfer', { balanceProblem: 'unanswered' })).toBe('dapp_send_preview_failed');
    expect(unreadKey('tokenTransfer', { balanceProblem: null, tokenProblem: 'foreign' })).toBe('balance_foreign_pending');
    for (const lang of ['en', 'zh-CN', 'ru', 'es', 'ko', 'ja', 'pt', 'fr', 'de', 'ar', 'it']) {
      for (const key of ['balance_unconfirmed', 'balance_foreign_pending', 'send_balance_unreadable']) {
        expect(translate(lang, key)).not.toBe(key);
      }
      expect(translate(lang, 'balance_unconfirmed')).not.toBe(translate(lang, 'send_balance_unreadable'));
    }
    expect(translate('en', 'balance_foreign_pending')).toMatch(/another device is not confirmed yet/);
    expect(translate('en', 'balance_unconfirmed')).toMatch(/not confirmed yet\. Try again in a minute/);
  });

  it('the Send form refuses with the reason the check gave, for QNC and for a token, and counts own unconfirmed sends', () => {
    const ws = fs.readFileSync(path.join(__dirname, '../src/screens/WalletScreen.js'), 'utf8');
    const send = ws.slice(ws.indexOf('const handleSendTransaction = async () => {'), ws.indexOf('const pressSend = async'));
    expect(send).toMatch(/if \(isQnetSend && qncCheck\.error\) \{\s*setTxResult\(\{ success: false, title: t\('send_cannot_title'\), error: sendCheckError\(qncCheck\.error\) \}\);/);
    expect(send).toMatch(/error: sendCheckError\(held && held\.error\)/);
    expect(send).toMatch(/spendable = afterPending\(qncNano, qncCheck\.pending, replaceNonce\);/);
    expect(send).toMatch(/const tokenLeft = afterPending\(held\.balanceBase, held\.pending, replaceNonce\);/);
    expect(ws).toMatch(/const sendCheckError = \(error\) => t\(error === 'foreign' \? 'balance_foreign_pending'\s*: error === 'unconfirmed' \? 'balance_unconfirmed' : 'send_balance_unreadable'\);/);
  });
});
