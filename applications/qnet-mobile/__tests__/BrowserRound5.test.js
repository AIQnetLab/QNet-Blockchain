/**
 * Final audit, mobile fixer round 3, the wallet's sends (MOB-BR-R3-01 … MOB-BR-R3-03): a transfer or token transfer to a
 * contract (the token itself included) is refused before any sheet or review and read again before signing, as the
 * extension refuses it; what an unconfirmed call or token transfer may still take is kept out of the spendable balance;
 * and whether a token transfer owes the new-holder deposit is decided by a committee-certified balance, not by one answer.
 */
const fs = require('fs');
const path = require('path');
const { sha3_256 } = require('js-sha3');
const AsyncStorage = require('@react-native-async-storage/async-storage');
const { createDappProvider, CODES, previewShort, spendableNano } = require('../src/browser/dappProvider');
const { WalletManager } = require('../src/components/WalletManager');
const { pendingView } = require('../src/services/PendingTx');
const T = require('../src/crypto/TxBuilders');
const { STORAGE_DEPOSIT_NANO } = require('../src/config/fees');

const eon = (seed) => {
  const body = `${seed.repeat(19).slice(0, 19)}eon${seed.repeat(15).slice(0, 15)}`;
  return body + sha3_256(body).slice(0, 8);
};
const QNET = eon('a');
const TO = eon('b');
const TOKEN = eon('c');
const WASM = eon('d');
const SOL = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
const SITE = 'https://shop.example';
const QNC = 1_000_000_000n;
const tick = () => new Promise((r) => setTimeout(r, 0));
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

beforeEach(async () => { await AsyncStorage.clear(); });

function setup(over = {}) {
  const views = [];
  const grants = new Map([[SITE, { grantedAt: 1, chains: ['qnet', 'solana'], walletId: QNET }]]);
  const deps = {
    now: () => Date.now(),
    state: () => ({ unlocked: true, interactive: true, accounts: { qnet: QNET, solana: SOL }, walletId: QNET }),
    grants: { get: async (o) => grants.get(o) || null, put: async () => {}, remove: async () => {} },
    feeNano: () => 150000,
    signMessage: jest.fn(),
    tokenInfo: jest.fn(async () => ({ standard: 'qrc20', name: 'Game Gold', symbol: 'GOLD', decimals: 6 })),
    contractKind: jest.fn(async (a) => (a === WASM ? 'contract' : a === TOKEN ? 'token' : 'none')),
    prepareSend: jest.fn(async () => ({
      nonce: 5, balanceNano: String(10n * QNC), verified: true, counterparties: [TO],
      tokenBalanceBase: '9000000', tokenVerified: true, depositNano: '10000000', listed: true,
    })),
    recheckSend: jest.fn(async () => ({ balanceNano: String(10n * QNC), tokenBalanceBase: '9000000', depositNano: '10000000' })),
    send: jest.fn(async () => ({ txHash: 'a'.repeat(64), status: 'submitted', nonce: 5 })),
    transactionStatus: jest.fn(),
    isCurrent: () => true,
    emit: () => {},
    onChange: (v) => views.push(v),
    ...over,
  };
  const p = createDappProvider(deps);
  const ctx = { origin: SITE, binding: { origin: SITE, doc: 'd', id: 'x', nav: 1 } };
  return { p, deps, ctx, views, shown: () => views[views.length - 1] };
}
const payTo = (s, to) => s.p.request(s.ctx, 'qnet_sendTransaction', { to, amount: '5' });
const tokenTo = (s, to) => s.p.request(s.ctx, 'qnet_sendTransaction', { type: 'tokenTransfer', token: TOKEN, to, amount: '2.5' });
const sheets = (s) => s.views.filter(Boolean).length;

describe('MOB-BR-R3-01: a contract is never paid', () => {
  it('a site\'s QNC transfer to a contract or a token is -32602 before any sheet; an unread recipient is -32603', async () => {
    for (const [kind, code] of [['contract', CODES.INVALID], ['token', CODES.INVALID]]) {
      const s = setup();
      s.deps.contractKind.mockResolvedValue(kind);
      await expect(payTo(s, TO)).rejects.toMatchObject({ code });
      expect(sheets(s)).toBe(0);
    }
    const s = setup();
    s.deps.contractKind.mockRejectedValue(Object.assign(new Error('x'), { code: 'TOKEN_UNAVAILABLE' }));
    await expect(payTo(s, TO)).rejects.toMatchObject({ code: CODES.INTERNAL });
    expect(sheets(s)).toBe(0);
  });

  it('a transfer to an account gets its sheet, and the wallet\'s own address is not read', async () => {
    const s = setup();
    payTo(s, TO).catch(() => {});
    await tick();
    expect(s.deps.contractKind).toHaveBeenCalledWith(TO);
    expect(s.shown()).toMatchObject({ kind: 'send', details: { type: 'transfer', to: TO } });
    const own = setup();
    payTo(own, QNET).catch(() => {});
    await tick();
    expect(own.deps.contractKind).not.toHaveBeenCalled();
    expect(own.shown()).toMatchObject({ kind: 'send' });
  });

  it('a token transfer to the token itself, or to another contract, is -32602 before any sheet', async () => {
    for (const to of [TOKEN, WASM]) {
      const s = setup();
      await expect(tokenTo(s, to)).rejects.toMatchObject({ code: CODES.INVALID });
      expect(sheets(s)).toBe(0);
      expect(s.deps.contractKind).toHaveBeenCalledWith(to);
    }
    const s = setup();
    s.deps.contractKind.mockImplementation(async (a) => { if (a === TO) throw new Error('busy'); return 'token'; });
    await expect(tokenTo(s, TO)).rejects.toMatchObject({ code: CODES.INTERNAL });
  });

  it('the recipient is read again at the approval: a contract now ends the request, an unread one is reviewed', async () => {
    for (const ask of [payTo, tokenTo]) {
      const s = setup();
      ask(s, TO).catch(() => {});
      await tick();
      await s.p.loadPreview(s.shown().id);
      s.deps.contractKind.mockRejectedValueOnce(new Error('busy'));
      expect(await s.p.approve(s.shown().id)).toEqual({ status: 'review' });
      expect(s.deps.send).not.toHaveBeenCalled();
      await s.p.loadPreview(s.shown().id);
      s.deps.contractKind.mockResolvedValueOnce('contract');
      expect(await s.p.approve(s.shown().id)).toEqual({ status: 'failed', code: CODES.INVALID });
      expect(s.deps.send).not.toHaveBeenCalled();
      expect(s.shown().outcome).toMatchObject({ error: CODES.INVALID, recipient: 'contract' }); // the sheet says why
    }
    const s = setup();
    payTo(s, TO).catch(() => {});
    await tick();
    await s.p.loadPreview(s.shown().id);
    expect((await s.p.approve(s.shown().id)).status).toBe('done');
    expect(s.deps.send).toHaveBeenCalledTimes(1);
  });

  it('the wallet\'s rule: two nodes agreeing on no contract, the own address unread, anything else refused', async () => {
    const wm = new WalletManager();
    const kind = jest.spyOn(wm, 'agreedContractKind');
    kind.mockResolvedValue('none');
    expect(await wm.payableRecipientProblem(TO, QNET)).toBe(null);
    expect(kind).toHaveBeenCalledWith(TO);
    for (const k of ['contract', 'token']) {
      kind.mockResolvedValueOnce(k);
      expect(await wm.payableRecipientProblem(TO.toUpperCase(), QNET)).toBe('contract');
    }
    kind.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'TOKEN_UNAVAILABLE' }));
    expect(await wm.payableRecipientProblem(TO, QNET)).toBe('unchecked');
    kind.mockClear();
    expect(await wm.payableRecipientProblem(QNET, QNET)).toBe(null);
    expect(kind).not.toHaveBeenCalled();
    expect(await wm.payableRecipientProblem('ab'.repeat(32), QNET)).toBe('contract');
  });

  it('the Send form refuses it before the review and reads it again just before signing, with its own texts', () => {
    const ws = read('src/screens/WalletScreen.js');
    const body = ws.slice(ws.indexOf('const handleSendTransaction = async'), ws.indexOf('// Move to wallet: the node balance'));
    expect(body).toMatch(/walletManager\.payableRecipientProblem\(sendAddress, myQnetAddress\)/);
    // Before the review it is read with the balance, at once (recipientProblem); just before signing, read again.
    expect(body).toMatch(/isQnetSend \? walletManager\.payableRecipientProblem\(sendAddress, myQnetAddress\)\.catch\(\(\) => 'unchecked'\) : null,/);
    const first = body.indexOf('if (await recipientRefused(recipientProblem)) return;');
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(body.indexOf('await reviewSend('));
    expect(body).toMatch(/const problem = known !== undefined \? known : await walletManager\.payableRecipientProblem\(sendAddress, myQnetAddress\);/);
    const again = body.indexOf('if (await recipientRefused()) return;', first + 1);
    expect(again).toBeGreaterThan(body.indexOf('setSendingTransaction(true);'));
    expect(again).toBeLessThan(body.indexOf('walletManager.qrc20Transfer('));
    expect(again).toBeLessThan(body.indexOf('walletManager.sendTransaction('));
    for (const loc of ['en', 'ru', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'zh-CN', 'ar']) {
      const table = require(`../src/i18n/locales/${loc}`).default;
      expect(typeof table.send_recipient_contract).toBe('string');
      expect(typeof table.send_recipient_unchecked).toBe('string');
    }
  });
});

describe('MOB-BR-R3-02: what an unconfirmed call or token transfer may take is not spendable', () => {
  it('each live entry keeps its reserve out; the replaced one excepted; an older entry without one as before', () => {
    const preview = {
      balanceNano: String(1n * QNC), transferFeeNano: '150000', replaceNonce: 8,
      pending: [
        { nonce: 6, kind: 'call', amountNano: null, reserveNano: 11_500_000 }, // a token transfer: fee + deposit
        { nonce: 7, kind: 'call', amountNano: null, reserveNano: 1_500_000 },
        { nonce: 8, kind: 'transfer', amountNano: 100_000_000 },
        { nonce: 9, kind: 'call', amountNano: null }, // kept by an older build
      ],
    };
    expect(spendableNano(preview)).toBe(1n * QNC - 11_500_000n - 1_500_000n - 100_150_000n);
    expect(spendableNano(preview, 'replace')).toBe(1n * QNC - 13_000_000n);
    // A QNC transfer "in addition" sized to the whole balance less its fee does not fit next to them.
    const d = { type: 'transfer', amountNano: String(1n * QNC - 150000n), feeNano: '150000' };
    expect(previewShort(d, { ...preview, pending: preview.pending.slice(0, 1) }, 'append')).toBe(true);
    expect(previewShort(d, { ...preview, pending: [] })).toBe(false);
  });

  it('a kept call carries its most fee, a token transfer the deposit too, and the view and the sheet keep it', async () => {
    const wm = new WalletManager();
    wm._loadContractSigner = async () => ({ from: QNET, dilPkHex: 'ab', dilSkHex: 'cd' });
    const extras = [];
    wm._signAndSubmit = jest.fn(async (from, sign, extra) => { extras.push(extra); return { accepted: true, data: {}, nonce: 5 }; });
    await wm.qrc20Transfer(TOKEN, TO, '2500000', 'pw');
    expect(extras[0].reserveNano).toBe(wm.qrc20TransferFeeNano(TOKEN, TO, '2500000') + STORAGE_DEPOSIT_NANO);
    await wm.qrc20Approve(TOKEN, TO, '1', 'pw');
    // An approval: its fee alone, no deposit.
    expect(extras[1].reserveNano).toBeGreaterThan(0);
    expect(extras[1].reserveNano).toBeLessThan(STORAGE_DEPOSIT_NANO);
    await wm.callWasmContract({ contract: WASM, method: 'play', args: null }, 'pw');
    expect(extras[2].reserveNano).toBe(Number(T.buildContractCall({ from: QNET, contract: WASM, method: 'play', args: null, nonce: 1 }).maxFeeNano));
    const view = pendingView({ nonce: 6, state: 'accepted', createdAt: Date.now(), summary: { kind: 'call', to: TOKEN, amountNano: null, method: 'transfer', reserveNano: 11_500_000 } });
    expect(view.reserveNano).toBe(11_500_000);
    expect(pendingView({ nonce: 6, createdAt: Date.now(), summary: { kind: 'call' } }).reserveNano).toBe(null);

    const s = setup();
    s.deps.prepareSend.mockResolvedValue({
      nonce: null, confirmed: 5, balanceNano: String(1n * QNC), verified: true, counterparties: [TO], replaceNonce: 6, replaceHash: 'h', appendNonce: 7,
      pending: [{ nonce: 6, state: 'accepted', kind: 'call', to: TOKEN, amountNano: null, method: 'transfer', reserveNano: 11_500_000, ageMs: 1 }],
    });
    s.p.request(s.ctx, 'qnet_sendTransaction', { to: TO, amount: '0.99' }).catch(() => {});
    await tick();
    await s.p.loadPreview(s.shown().id);
    expect(s.shown().preview.pending[0].reserveNano).toBe(11_500_000);
    // A site's send never goes in addition (MOB-BR-R4-02): nothing is signed.
    expect(await s.p.approve(s.shown().id, 'append')).toEqual({ status: 'review' });
    expect(s.deps.send).not.toHaveBeenCalled();
    s.p.reject(s.shown().id);
  });
});

describe('MOB-BR-R3-03: the new-holder deposit is decided by a committee-certified balance', () => {
  it('only a checked non-zero balance spares the deposit; one node\'s word is never asked', async () => {
    const wm = new WalletManager();
    const one = jest.spyOn(wm, 'getTokenBalanceOf');
    const checked = jest.spyOn(wm, 'checkedTokenBalance');
    const fee = wm.qrc20TransferFeeNano(TOKEN, TO, '1');
    for (const [answer, deposit] of [
      [{ ok: true, balanceBase: '5', verified: true }, 0],
      [{ ok: true, balanceBase: '5', verified: false }, STORAGE_DEPOSIT_NANO], // an unverified figure spares nothing
      [{ ok: true, balanceBase: '0', verified: true }, STORAGE_DEPOSIT_NANO],
      [{ ok: false, balanceBase: null }, STORAGE_DEPOSIT_NANO],
    ]) {
      checked.mockResolvedValueOnce(answer);
      expect(await wm.qrc20TransferQncNeedNano(TOKEN, TO, '1')).toEqual({ feeNano: fee, depositNano: deposit, needNano: fee + deposit });
    }
    checked.mockRejectedValueOnce(new Error('network'));
    expect((await wm.qrc20TransferQncNeedNano(TOKEN, TO, '1')).depositNano).toBe(STORAGE_DEPOSIT_NANO);
    // The recipient's account nonce is not the send's: no proof read earlier stands in for a fresh one.
    expect(checked).toHaveBeenCalledWith(TOKEN, TO, null, { nonce: null });
    expect(one).not.toHaveBeenCalled();
  });
});
