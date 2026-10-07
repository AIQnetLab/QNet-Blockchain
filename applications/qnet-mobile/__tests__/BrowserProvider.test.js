// The in-app browser's provider (src/browser/dappProvider.js): the extension's methods, results, error codes
// and events; per-origin grants; 4100 while locked; message refusals before any sheet; one sheet at a time,
// three per origin, and the extension's rejection cooldown (60 s after five); no Solana signing and no activation. A confirmed send goes
// through the wallet's own send path (services/PendingTx) and signs only the nonce its sheet showed.
jest.mock('../src/crypto/DilithiumCrypto', () => ({
  isDilithiumAvailable: () => true,
  signDetached: jest.fn(async (message) => `sig(${message})`),
  verifyDilithium: jest.fn(),
}));

const AsyncStorage = require('@react-native-async-storage/async-storage');
const { sha3_256 } = require('js-sha3');
const { signDetached } = require('../src/crypto/DilithiumCrypto');
const { WalletManager } = require('../src/components/WalletManager');
const { pendingFor } = require('../src/services/PendingTx');
const { GENESIS_NODES } = require('../src/config/nodes');
const {
  createDappProvider, CODES, TIMINGS, COOLDOWN_MESSAGE, parseQncAmount, isEmptyParams, pageError, METHODS,
} = require('../src/browser/dappProvider');

const eon = (seed) => {
  const body = `${seed.repeat(19).slice(0, 19)}eon${seed.repeat(15).slice(0, 15)}`;
  return body + sha3_256(body).slice(0, 8);
};
const QNET = eon('a');
const TO = eon('b');
const SOL = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
const SITE = 'https://dapp.example';

function setup(over = {}) {
  let now = 1_000_000;
  const grants = new Map();
  const views = [];
  const emitted = [];
  const state = { unlocked: true, interactive: true, accounts: { qnet: QNET, solana: SOL }, walletId: QNET };
  let current = true;
  const deps = {
    now: () => now,
    state: () => state,
    grants: {
      get: async (o) => grants.get(o) || null,
      put: async (o, walletId) => { grants.set(o, { grantedAt: now, chains: ['qnet', 'solana'], walletId }); },
      remove: async (o) => grants.delete(o),
    },
    canonicalAddress: (a) => WalletManager.canonicalAddress(a),
    feeNano: () => 150000,
    contractKind: jest.fn(async () => 'none'),
    signMessage: jest.fn(async () => ({ signature: 'ab'.repeat(8), publicKey: 'cd'.repeat(8), address: QNET })),
    prepareSend: jest.fn(async () => ({ nonce: 5, balanceNano: '10000000000', verified: true, counterparties: [] })),
    send: jest.fn(async () => ({ txHash: 'a'.repeat(64), status: 'submitted' })),
    isCurrent: () => current,
    emit: (o, e, d) => emitted.push([o, e, d]),
    onChange: (v) => views.push(v),
    ...over,
  };
  const p = createDappProvider(deps);
  const ctx = (origin = SITE) => ({ origin, binding: { origin, doc: 'd', id: 'x', nav: 1 } });
  const shown = () => views[views.length - 1];
  const grant = (origin = SITE) => grants.set(origin, { grantedAt: now, chains: ['qnet', 'solana'], walletId: QNET });
  return {
    p, deps, grants, views, emitted, state, ctx, shown, grant,
    advance: (ms) => { now += ms; }, setCurrent: (v) => { current = v; },
  };
}

const outcome = (promise) => promise.then((result) => ({ result }), (e) => ({ code: e.code, message: e.message }));
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('methods', () => {
  it('serves exactly the extension\'s allow-list; activation, Solana and anything else is 4200', async () => {
    const t = setup();
    expect([...METHODS].sort()).toEqual([
      'qnet_accounts', 'qnet_chainId', 'qnet_disconnect', 'qnet_getTransactionStatus', 'qnet_requestAccounts', 'qnet_sendTransaction',
      'qnet_signMessage',
    ]);
    for (const m of ['qnet_activateNode', 'solana_signTransaction', 'solana_signMessage', 'solana_signAndSendTransaction',
      'qnet_signTransaction', 'qnet_signAndSendTransaction', 'wallet_switchChain', 'other_sendTransaction', 'toString', '__proto__']) {
      expect([m, await outcome(t.p.request(t.ctx(), m, {}))]).toEqual([m, { code: 4200, message: '4200' }]);
    }
    expect(t.views).toEqual([]);
  });

  it('qnet_chainId and qnet_accounts need no sheet; accounts stay {} without a grant or while locked', async () => {
    const t = setup();
    expect(await t.p.request(t.ctx(), 'qnet_chainId')).toEqual({ chainId: 'q1337', network: 'testnet' });
    expect(await outcome(t.p.request(t.ctx(), 'qnet_chainId', { x: 1 }))).toMatchObject({ code: -32602 });
    expect(await t.p.request(t.ctx(), 'qnet_accounts', [])).toEqual({});
    t.grant();
    expect(await t.p.request(t.ctx(), 'qnet_accounts')).toEqual({ qnet: QNET, solana: SOL });
    expect(await t.p.request(t.ctx('https://other.example'), 'qnet_accounts')).toEqual({});
    t.state.unlocked = false;
    expect(await t.p.request(t.ctx(), 'qnet_accounts')).toEqual({});
    expect(t.views).toEqual([]);
  });

  it('a grant of another wallet does not count', async () => {
    const t = setup();
    t.grants.set(SITE, { grantedAt: 1, chains: ['qnet', 'solana'], walletId: eon('c') });
    expect(await t.p.request(t.ctx(), 'qnet_accounts')).toEqual({});
  });
});

describe('connect', () => {
  it('a locked wallet answers 4100 and shows nothing; a page not on screen gets 4001', async () => {
    const t = setup();
    t.state.unlocked = false;
    expect(await outcome(t.p.request(t.ctx(), 'qnet_requestAccounts'))).toMatchObject({ code: 4100 });
    t.state.unlocked = true;
    t.state.interactive = false;
    expect(await outcome(t.p.request(t.ctx(), 'qnet_requestAccounts'))).toMatchObject({ code: 4001 });
    expect(t.views).toEqual([]);
  });

  it('asks once; the approval stores the grant, answers both addresses and tells the page', async () => {
    const t = setup();
    const asked = t.p.request(t.ctx(), 'qnet_requestAccounts');
    await tick();
    expect(t.shown()).toMatchObject({ kind: 'connect', origin: SITE });
    expect(await t.p.approve(t.shown().id)).toMatchObject({ status: 'done' });
    expect(await asked).toEqual({ qnet: QNET, solana: SOL });
    expect(t.grants.get(SITE)).toMatchObject({ walletId: QNET, chains: ['qnet', 'solana'] });
    expect(t.emitted).toContainEqual([SITE, 'accountsChanged', { qnet: QNET, solana: SOL }]);
    expect(t.shown()).toBe(null);
    // Granted and unlocked: at once, no sheet.
    const before = t.views.length;
    expect(await t.p.request(t.ctx(), 'qnet_requestAccounts')).toEqual({ qnet: QNET, solana: SOL });
    expect(t.views.length).toBe(before);
  });

  it('qnet_disconnect removes the grant and says so to the page', async () => {
    const t = setup();
    t.grant();
    expect(await t.p.request(t.ctx(), 'qnet_disconnect')).toBe(true);
    expect(t.grants.has(SITE)).toBe(false);
    expect(t.emitted).toEqual([[SITE, 'accountsChanged', {}], [SITE, 'disconnect', { code: 4900, message: 'Disconnected' }]]);
  });
});

describe('sign a message', () => {
  it('needs a grant; protocol prefixes and hidden text are refused before any sheet', async () => {
    const t = setup();
    expect(await outcome(t.p.request(t.ctx(), 'qnet_signMessage', { message: 'hi' }))).toMatchObject({ code: 4100 });
    t.grant();
    for (const message of ['q1337|transfer:a:b:1:0:10:10000', 'ping:v2:ab:1', ' TOKEN_REFRESH:x', 'a\u202eb', '', 'x'.repeat(4097), 7,
      // Invisible text the sheet would not show, and prefixes disguised by it or by compatibility forms.
      'Log in to example.com\u{E0020}\u{E0061}\u{E0070}', 'Approve\u200b', 'a\u2060b', 'a\u00adb', 'ok\ufe0f', 'a\u3164b',
      '\u200bq1337|transfer:a:b:1:0:10:10000', 'p i n g:x', '\uff51\uff11\uff13\uff13\uff17|x']) {
      expect(await outcome(t.p.request(t.ctx(), 'qnet_signMessage', { message }))).toMatchObject({ code: -32602 });
    }
    expect(await outcome(t.p.request(t.ctx(), 'qnet_signMessage', { message: 'hi', extra: 1 }))).toMatchObject({ code: -32602 });
    expect(t.views).toEqual([]);
    expect(t.deps.signMessage).not.toHaveBeenCalled();
  });

  it('signs exactly the text shown, for the origin that asked', async () => {
    const t = setup();
    t.grant();
    const asked = t.p.request(t.ctx(), 'qnet_signMessage', { message: 'Log in to dapp.example\nNonce: 42' });
    await tick();
    expect(t.shown()).toMatchObject({ kind: 'sign', origin: SITE, details: { message: 'Log in to dapp.example\nNonce: 42', byteLength: 32 } });
    await t.p.approve(t.shown().id);
    expect(t.deps.signMessage).toHaveBeenCalledWith(SITE, 'Log in to dapp.example\nNonce: 42');
    expect(await asked).toEqual({ signature: 'ab'.repeat(8), publicKey: 'cd'.repeat(8), address: QNET });
  });

  it('a locked wallet is 4100', async () => {
    const t = setup();
    t.grant();
    t.state.unlocked = false;
    expect(await outcome(t.p.request(t.ctx(), 'qnet_signMessage', { message: 'hi' }))).toMatchObject({ code: 4100 });
  });
});

describe('send QNC', () => {
  it('validates the recipient and the amount like the extension', async () => {
    const t = setup();
    t.grant();
    const bad = [
      { to: TO }, { amount: '1' }, { to: TO, amount: '1', gas: 1 }, { to: TO.toUpperCase(), amount: '1' },
      { to: `${TO.slice(0, -1)}${TO.endsWith('0') ? '1' : '0'}`, amount: '1' }, { to: 'f'.repeat(64), amount: '1' },
      { to: TO, amount: '0' }, { to: TO, amount: '-1' }, { to: TO, amount: '1e3' }, { to: TO, amount: '.5' },
      { to: TO, amount: '1.1234567891' }, { to: TO, amount: 1 }, { to: TO, amount: '9007199254' },
      // The extension's grammar: canonical decimal text only.
      { to: TO, amount: '01' }, { to: TO, amount: '1.' }, { to: TO, amount: ' 1' }, { type: 'transfer', to: TO },
      { type: 'transfer', to: TO, amount: '1', extra: 1 }, { type: 'Transfer', to: TO, amount: '1' },
    ];
    for (const params of bad) {
      expect([params, await outcome(t.p.request(t.ctx(), 'qnet_sendTransaction', params))]).toEqual([params, { code: -32602, message: '-32602' }]);
    }
    expect(t.views).toEqual([]);
    expect(parseQncAmount('1.5')).toBe(1_500_000_000n);
    expect(parseQncAmount('0.000000001')).toBe(1n);
    expect(parseQncAmount('1.50')).toBe(1_500_000_000n);
    expect(parseQncAmount('01')).toBe(null);
  });

  it('{type: \'transfer\', to, amount} is the same request as {to, amount}', async () => {
    const t = setup();
    t.grant();
    t.p.request(t.ctx(), 'qnet_sendTransaction', { type: 'transfer', to: TO, amount: '1.50' });
    await tick();
    expect(t.shown()).toMatchObject({ kind: 'send', details: { type: 'transfer', to: TO, amountNano: '1500000000' } });
  });

  it('shows to, amount, fee, total and the nonce, and sends exactly that', async () => {
    const t = setup();
    expect(await outcome(t.p.request(t.ctx(), 'qnet_sendTransaction', { to: TO, amount: '1.5' }))).toMatchObject({ code: 4100 });
    t.grant();
    const asked = t.p.request(t.ctx(), 'qnet_sendTransaction', { to: TO, amount: '1.5' });
    await tick();
    const id = t.shown().id;
    expect(t.shown()).toMatchObject({
      kind: 'send', details: { type: 'transfer', to: TO, amountNano: '1500000000', feeNano: '150000', totalNano: '1500150000' },
      preview: null,
    });
    expect(await t.p.approve(id)).toEqual({ status: 'review' }); // nothing is sent before the nonce is shown
    await t.p.loadPreview(id);
    expect(t.shown().preview).toMatchObject({ nonce: 5, balanceNano: '10000000000', verified: true });
    expect(await t.p.approve(id)).toMatchObject({ status: 'done' });
    expect(t.deps.send).toHaveBeenCalledWith({
      type: 'transfer', to: TO, amountNano: '1500000000', feeNano: '150000', totalNano: '1500150000', destroys: false, nonce: 5, choice: null,
    });
    // The extension's result: the transaction is (from, nonce); txHash names one node's copy.
    const result = { status: 'submitted', from: QNET, to: TO, amount: '1.5', nonce: '5', txHash: 'a'.repeat(64) };
    expect(await asked).toEqual(result);
    // The sheet keeps the outcome until closed.
    expect(t.shown().outcome).toEqual(result);
    t.p.dismiss(id);
    expect(t.shown()).toBe(null);
  });

  it('a moved nonce is shown again instead of being signed', async () => {
    const t = setup();
    t.grant();
    t.deps.send.mockImplementationOnce(async () => { const e = new Error('moved'); e.code = 'NONCE_CHANGED'; throw e; });
    const asked = t.p.request(t.ctx(), 'qnet_sendTransaction', { to: TO, amount: '2' });
    await tick();
    const id = t.shown().id;
    await t.p.loadPreview(id);
    t.deps.prepareSend.mockResolvedValueOnce({ nonce: 6, balanceNano: '10000000000', verified: true, counterparties: [] });
    expect(await t.p.approve(id)).toEqual({ status: 'review' });
    await tick();
    expect(t.shown().preview.nonce).toBe(6);
    await t.p.approve(id);
    expect(t.deps.send).toHaveBeenLastCalledWith(expect.objectContaining({ to: TO, amountNano: '2000000000', nonce: 6, choice: null }));
    expect((await asked).status).toBe('submitted');
  });

  // MOBNET-R1-01: while the wallet has unconfirmed transactions, a site's send names none of them silently. A site's send
  // never goes in addition (MOB-BR-R4-02): it replaces the one at the confirmed nonce + 1, or waits.
  it('while the wallet has an unconfirmed transaction, nothing is sent until the user chooses to replace it', async () => {
    const t = setup();
    t.grant();
    const pendingPreview = {
      nonce: null, confirmed: 4, balanceNano: '10000000000', verified: true, counterparties: [],
      pending: [{ nonce: 5, state: 'accepted', kind: 'transfer', to: TO, amountNano: 2_000_000_000, ageMs: 60_000 }],
      replaceNonce: 5, replaceHash: 'h5', appendNonce: 6, recent: [],
    };
    t.deps.prepareSend.mockResolvedValue(pendingPreview);
    const asked = t.p.request(t.ctx(), 'qnet_sendTransaction', { to: TO, amount: '2' });
    await tick();
    const id = t.shown().id;
    await t.p.loadPreview(id);
    expect(t.shown().preview).toMatchObject({ nonce: null, replaceNonce: 5, appendNonce: null, inFlight: false });
    expect(t.shown().preview.pending).toHaveLength(1);
    expect(await t.p.approve(id)).toEqual({ status: 'review' }); // no choice: nothing sent
    expect(t.deps.send).not.toHaveBeenCalled();
    expect(await t.p.approve(id, 'replace')).toMatchObject({ status: 'done' });
    expect(t.deps.send).toHaveBeenCalledWith(expect.objectContaining({
      to: TO, amountNano: '2000000000', nonce: 5, choice: { mode: 'replace', nonce: 5, bodyHash: 'h5' },
    }));
    expect((await asked).status).toBe('submitted');
  });

  it('the transaction chosen to be replaced went through meanwhile: nothing is sent and the sheet says so', async () => {
    const t = setup();
    t.grant();
    t.deps.prepareSend.mockResolvedValueOnce({
      nonce: null, confirmed: 4, balanceNano: '10000000000', verified: true, counterparties: [],
      pending: [{ nonce: 5, state: 'open', kind: 'transfer', to: TO, amountNano: 1, ageMs: 1 }],
      replaceNonce: 5, replaceHash: 'h5', appendNonce: null, recent: [],
    });
    t.deps.send.mockImplementationOnce(async () => { const e = new Error('went through'); e.code = 'PENDING_SETTLED'; throw e; });
    t.p.request(t.ctx(), 'qnet_sendTransaction', { to: TO, amount: '1' });
    await tick();
    const id = t.shown().id;
    await t.p.loadPreview(id);
    expect(await t.p.approve(id, 'append')).toEqual({ status: 'review' }); // not offered: in addition over an open one
    expect(t.deps.send).not.toHaveBeenCalled();
    expect(await t.p.approve(id, 'replace')).toEqual({ status: 'review' });
    await tick();
    expect(t.shown().notice).toBe('settled');
    expect(t.shown().preview).toMatchObject({ nonce: 5 }); // read again: nothing pending now, a fresh nonce
  });
});

describe('one sheet at a time, a cap per origin, and the cooldown after a rejection', () => {
  it('queues in order and refuses a fourth request of one origin', async () => {
    const t = setup();
    const a = t.p.request(t.ctx(), 'qnet_requestAccounts');
    const b = t.p.request(t.ctx(), 'qnet_requestAccounts');
    const c = t.p.request(t.ctx(), 'qnet_requestAccounts');
    expect(await outcome(t.p.request(t.ctx(), 'qnet_requestAccounts'))).toMatchObject({ code: 4001 });
    await tick();
    expect(t.shown().queued).toBe(2);
    await t.p.approve(t.shown().id);
    // The waiting connects of the origin are answered by the one grant.
    expect(await Promise.all([a, b, c])).toEqual([{ qnet: QNET, solana: SOL }, { qnet: QNET, solana: SOL }, { qnet: QNET, solana: SOL }]);
  });

  // XC-06: the extension's cooldown since 28.09. One rejection holds nothing back (a person who declined may ask again
  // at once); the fifth within 10 minutes holds the origin back 60 s. Each sheet here is more than a minute after the
  // last, so the sheet budget (5 a minute) plays no part.
  it('a rejection is 4001 and holds nothing back; the fifth within 10 min holds the origin back 60 s', async () => {
    const t = setup();
    for (let i = 0; i < 5; i++) {
      if (i > 0) t.advance(TIMINGS.SHEET_BUDGET_SHORT_MS + 1);
      const asked = t.p.request(t.ctx(), 'qnet_requestAccounts');
      await tick();
      expect(t.shown().kind).toBe('connect');
      expect(t.p.reject(t.shown().id)).toBe(true);
      expect(await outcome(asked)).toMatchObject({ code: 4001, message: '4001' });
    }
    const held = await outcome(t.p.request(t.ctx(), 'qnet_requestAccounts'));
    expect(held).toEqual({ code: 4001, message: COOLDOWN_MESSAGE });
    expect(pageError(held)).toEqual({ code: 4001, message: COOLDOWN_MESSAGE });
    // Another origin is not held back; calls that need no sheet are served.
    expect(await t.p.request(t.ctx(), 'qnet_chainId')).toMatchObject({ chainId: 'q1337' });
    const other = t.p.request(t.ctx('https://other.example'), 'qnet_requestAccounts');
    await tick();
    expect(t.shown()).toMatchObject({ kind: 'connect', origin: 'https://other.example' });
    t.p.reject(t.shown().id);
    await outcome(other);
    t.advance(TIMINGS.COOLDOWN_LONG_MS - 1);
    expect(await outcome(t.p.request(t.ctx(), 'qnet_requestAccounts'))).toEqual({ code: 4001, message: COOLDOWN_MESSAGE });
    t.advance(1);
    const again = t.p.request(t.ctx(), 'qnet_requestAccounts');
    await tick();
    expect(t.shown().kind).toBe('connect');
    await t.p.approve(t.shown().id);
    await again;
  });

  it('a single rejection keeps the waiting requests of the origin; they end when its cooldown starts', async () => {
    const t = setup();
    const first = t.p.request(t.ctx(), 'qnet_requestAccounts');
    const second = t.p.request(t.ctx(), 'qnet_requestAccounts');
    await tick();
    t.p.reject(t.shown().id);
    expect(await outcome(first)).toMatchObject({ code: 4001, message: '4001' });
    await tick();
    expect(t.shown().kind).toBe('connect'); // the second keeps its turn
    t.p.reject(t.shown().id);
    expect(await outcome(second)).toMatchObject({ code: 4001, message: '4001' });
    for (let i = 0; i < 2; i++) {
      t.advance(TIMINGS.SHEET_BUDGET_SHORT_MS + 1);
      const asked = t.p.request(t.ctx(), 'qnet_requestAccounts');
      await tick();
      t.p.reject(t.shown().id);
      await outcome(asked);
    }
    t.advance(TIMINGS.SHEET_BUDGET_SHORT_MS + 1);
    const fifth = t.p.request(t.ctx(), 'qnet_requestAccounts');
    const waiting = t.p.request(t.ctx(), 'qnet_requestAccounts');
    await tick();
    t.p.reject(t.shown().id);
    expect(await outcome(fifth)).toMatchObject({ code: 4001 });
    expect(await outcome(waiting)).toEqual({ code: 4001, message: COOLDOWN_MESSAGE });
    expect(t.shown()).toBe(null);
  });

  it('an unanswered sheet times out as 4001 and counts nothing', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
    try {
      const t = setup();
      const asked = t.p.request(t.ctx(), 'qnet_requestAccounts');
      await flush();
      expect(t.shown().kind).toBe('connect');
      jest.advanceTimersByTime(TIMINGS.APPROVAL_TIMEOUT_MS + 1);
      expect(await outcome(asked)).toMatchObject({ code: 4001 });
      const next = t.p.request(t.ctx(), 'qnet_requestAccounts');
      await flush();
      expect(t.shown().kind).toBe('connect'); // no cooldown
      t.p.reject(t.shown().id);
      await outcome(next);
    } finally {
      jest.useRealTimers();
    }
  });
});

// MB2-04 (the extension's ES-03): a page that reloads or navigates itself away from its armed sheet has had its
// request refused; it does not get to raise a fresh full-screen sheet at once, over and over.
describe('a page that leaves its sheet behind', () => {
  const { ARM_MS, SEND_ARM_MS } = require('../src/browser/dappProvider');

  // A page that leaves its sheet this way, a minute or more apart so the sheet budget plays no part: `kind` 'send' or
  // 'connect', gone `after` ms after its sheet showed.
  const leave = async (t, kind, after) => {
    t.advance(TIMINGS.SHEET_BUDGET_SHORT_MS + 1);
    const asked = kind === 'send'
      ? t.p.request(t.ctx(), 'qnet_sendTransaction', { to: TO, amount: '1' })
      : t.p.request(t.ctx(), 'qnet_requestAccounts');
    await tick();
    expect(t.shown().kind).toBe(kind);
    t.advance(after);
    t.setCurrent(false); // location.reload()
    t.p.pageChanged();
    expect(await outcome(asked)).toMatchObject({ code: 4001 });
    t.setCurrent(true);
  };

  it('after the arm time counts as a rejection: the fifth starts the cooldown', async () => {
    const t = setup();
    for (let i = 0; i < 4; i++) {
      await leave(t, 'connect', ARM_MS + 1);
      // One rejection holds nothing back: the page asks again and gets its sheet.
      const again = t.p.request(t.ctx(), 'qnet_requestAccounts');
      await tick();
      expect(t.shown().kind).toBe('connect');
      t.p.cancelWhere(() => true, 4001); // ended without the user: no rejection
      await outcome(again);
    }
    await leave(t, 'connect', ARM_MS + 1);
    expect(await outcome(t.p.request(t.ctx(), 'qnet_requestAccounts'))).toEqual({ code: 4001, message: COOLDOWN_MESSAGE });
  });

  it('before the arm time, or when the user moved the page, counts nothing', async () => {
    const t = setup();
    const first = t.p.request(t.ctx(), 'qnet_requestAccounts');
    await tick();
    t.advance(ARM_MS - 100);
    t.setCurrent(false);
    t.p.pageChanged();
    await outcome(first);
    t.setCurrent(true);
    const second = t.p.request(t.ctx(), 'qnet_requestAccounts');
    await tick();
    expect(t.shown().kind).toBe('connect');
    t.advance(ARM_MS * 5);
    t.setCurrent(false);
    t.p.pageChanged({ userInitiated: true }); // the address bar, back, reload button
    await outcome(second);
    t.setCurrent(true);
    const third = t.p.request(t.ctx(), 'qnet_requestAccounts');
    await tick();
    expect(t.shown().kind).toBe('connect');
    t.p.reject(t.shown().id);
    await outcome(third);
  });

  it('a send sheet counts once its longer arm time has passed', async () => {
    const t = setup();
    t.grant();
    // Armed for a connect, not yet for a send: five of them count nothing.
    for (let i = 0; i < 5; i++) await leave(t, 'send', SEND_ARM_MS - 200);
    const open = t.p.request(t.ctx(), 'qnet_sendTransaction', { to: TO, amount: '1' });
    await tick();
    expect(t.shown().kind).toBe('send');
    t.p.cancelWhere(() => true, 4001);
    await outcome(open);
    for (let i = 0; i < 5; i++) await leave(t, 'send', SEND_ARM_MS + 1);
    expect(await outcome(t.p.request(t.ctx(), 'qnet_sendTransaction', { to: TO, amount: '1' })))
      .toEqual({ code: 4001, message: COOLDOWN_MESSAGE });
  });
});

describe('lock, navigation and revoke', () => {
  it('locking ends every open request with 4100 and tells granted pages', async () => {
    const t = setup();
    t.grant();
    await t.p.request(t.ctx(), 'qnet_accounts');
    const asked = t.p.request(t.ctx(), 'qnet_signMessage', { message: 'hi' });
    await tick();
    t.state.unlocked = false;
    t.p.locked();
    expect(await outcome(asked)).toMatchObject({ code: 4100 });
    expect(t.shown()).toBe(null);
    expect(t.emitted).toContainEqual([SITE, 'accountsChanged', {}]);
    // After a lock nothing counts as a rejection.
    t.state.unlocked = true;
    const again = t.p.request(t.ctx(), 'qnet_signMessage', { message: 'hi' });
    await tick();
    expect(t.shown().kind).toBe('sign');
    t.p.reject(t.shown().id);
    await outcome(again);
  });

  it('a page that went away gets nothing performed', async () => {
    const t = setup();
    t.grant();
    const asked = t.p.request(t.ctx(), 'qnet_signMessage', { message: 'hi' });
    await tick();
    t.setCurrent(false);
    expect(await t.p.approve(t.shown().id)).toMatchObject({ status: 'failed', code: 4001 });
    expect(t.deps.signMessage).not.toHaveBeenCalled();
    expect(await outcome(asked)).toMatchObject({ code: 4001 });
    // A request of the page that went away gets no sheet at all (MB-06).
    const other = outcome(t.p.request(t.ctx(), 'qnet_signMessage', { message: 'x' }));
    await tick();
    t.p.pageChanged();
    expect(await other).toMatchObject({ code: 4001 });
  });

  it('revoking from Settings disconnects the page and ends its pending signatures', async () => {
    const t = setup();
    t.grant();
    const asked = t.p.request(t.ctx(), 'qnet_signMessage', { message: 'hi' });
    await tick();
    await t.p.revoke(SITE);
    expect(await outcome(asked)).toMatchObject({ code: 4100 });
    expect(t.grants.has(SITE)).toBe(false);
    expect(t.emitted.slice(-2)).toEqual([[SITE, 'accountsChanged', {}], [SITE, 'disconnect', { code: 4900, message: 'Disconnected' }]]);
  });

  it('params without arguments are only undefined, null, [] or {}', () => {
    for (const p of [undefined, null, [], {}]) expect(isEmptyParams(p)).toBe(true);
    for (const p of [[1], { a: 1 }, 'x', 0, false]) expect(isEmptyParams(p)).toBe(false);
  });
});

describe('a confirmed send goes through the wallet\'s own send path', () => {
  let posts;
  let submit;
  const reply = (body) => Promise.resolve({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();
    WalletManager.pkBound = {};
    WalletManager.nodeHealth = {};
    posts = [];
    submit = () => ({ tx_hash: 'f'.repeat(64) });
    global.fetch = jest.fn((url, opts = {}) => {
      if (opts.method === 'POST') {
        const body = JSON.parse(opts.body);
        posts.push({ url, body });
        return reply(submit(body));
      }
      if (/\/api\/v1\/account\/[^/]+$/.test(url)) return reply({ nonce: 4, has_dilithium_pk: false });
      return reply({});
    });
  });

  function wallet() {
    const wm = new WalletManager();
    wm.loadWallet = jest.fn(async () => ({
      secretKey: new Uint8Array(64).fill(3), qnetAddress: QNET, qnetKeypair: { publicKey: Array(1952).fill(1), privateKey: Array(4032).fill(2) },
    }));
    wm.getQNCBalanceWithProof = jest.fn(async () => ({ ok: true, verified: true, nonce: '4', balanceNano: '9000000000' }));
    return wm;
  }

  // The provider's send dependency, as the browser screen wires it.
  const sendVia = (wm) => async ({ to, amountNano, nonce }) => {
    const n = Number(amountNano);
    const r = await wm.sendQNC(to, n / 1e9, 'qnet-session:t', { amountNano: n, expectNonce: nonce });
    return r && r.success ? { txHash: r.txHash, status: 'submitted' } : { txHash: null, status: 'unknown' };
  };

  it('signs the exact nano amount at the shown nonce and keeps the signed bytes (PendingTx)', async () => {
    const wm = wallet();
    const t = setup({ send: sendVia(wm), prepareSend: async () => ({ ...(await wm.resolveNonce(QNET)), balanceNano: '10000000000', counterparties: [] }) });
    t.grant();
    const asked = t.p.request(t.ctx(), 'qnet_sendTransaction', { to: TO, amount: '0.123456789' });
    await tick();
    await t.p.loadPreview(t.shown().id);
    expect(t.shown().preview.nonce).toBe(5);
    await t.p.approve(t.shown().id);
    expect(await asked).toEqual({ status: 'submitted', from: QNET, to: TO, amount: '0.123456789', nonce: '5', txHash: 'f'.repeat(64) });
    expect(signDetached).toHaveBeenCalledTimes(1);
    expect(signDetached.mock.calls[0][0])
      .toBe(`q1337|transfer:${QNET}:${TO}:123456789:5:${posts[0].body.gas_price}:${posts[0].body.gas_limit}`);
    expect(posts[0].body).toMatchObject({ from: QNET, to: TO, amount: 123456789, nonce: 5 });
    const kept = await pendingFor(QNET);
    expect(kept.map((e) => [e.nonce, e.state])).toEqual([[5, 'accepted']]);
  });

  it('signs nothing when the wallet\'s next nonce is not the one shown', async () => {
    const wm = wallet();
    await expect(wm.sendQNC(TO, 1, 't', { amountNano: 1_000_000_000, expectNonce: 9 })).rejects.toMatchObject({ code: 'NONCE_CHANGED' });
    expect(signDetached).not.toHaveBeenCalled();
    expect(posts).toEqual([]);
    expect(GENESIS_NODES.length).toBe(5);
  });

  it('a send nobody answered is "unknown" to the page, never "failed"', async () => {
    const wm = wallet();
    submit = () => ({ success: false, error: 'nonce too low' });
    const t = setup({ send: sendVia(wm), prepareSend: async () => ({ ...(await wm.resolveNonce(QNET)), balanceNano: '10000000000', counterparties: [] }) });
    t.grant();
    const asked = t.p.request(t.ctx(), 'qnet_sendTransaction', { to: TO, amount: '1' });
    await tick();
    await t.p.loadPreview(t.shown().id);
    await t.p.approve(t.shown().id);
    expect(await asked).toEqual({ status: 'unknown', from: QNET, to: TO, amount: '1', nonce: '5', txHash: null });
  });
});
