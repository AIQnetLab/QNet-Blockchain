/**
 * What the user waits on has the network first (utils/userAction): while a user action holds it, the background
 * verification (the light client's downloads, certified proofs) starts no new download and goes on right after; a hold
 * never outlasts its cap, and the screens that run user actions hold it exactly while they do.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';

const fs = require('fs');
const path = require('path');
const { holdForUser, afterUserActions, useHoldForUser, USER_HOLD_MAX_MS } = require('../src/utils/userAction');
const lc = require('../src/crypto/QcLightClient');
const { WalletManager } = require('../src/components/WalletManager');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
// Whether `p` settled after the pending microtasks ran.
const settled = async (p) => {
  let done = false;
  p.then(() => { done = true; });
  await flush();
  return done;
};
const GENESIS = ['https://g1.example', 'https://g2.example', 'https://g3.example'];
// Every hold a test takes, released after it whatever it asserted, so no test waits on another's.
const taken = [];
const hold = () => {
  const release = holdForUser();
  taken.push(release);
  return release;
};

beforeEach(() => {
  lc.clearQcCache();
  global.fetch = jest.fn(async () => ({
    ok: true, status: 200, headers: { get: () => null }, text: async () => '{"proof_format":2,"newest_certified_index":7}',
    json: async () => ({}),
  }));
});
afterEach(() => {
  taken.splice(0).forEach((release) => release());
  jest.useRealTimers();
});

describe('the hold', () => {
  it('nothing held: at once; held: until every hold is released, and a second release changes nothing', async () => {
    expect(await settled(afterUserActions())).toBe(true);
    const a = hold();
    const b = hold();
    const waiting = afterUserActions();
    expect(await settled(waiting)).toBe(false);
    a();
    a();
    expect(await settled(waiting)).toBe(false);
    b();
    expect(await settled(waiting)).toBe(true);
    expect(await settled(afterUserActions())).toBe(true);
  });

  it('an action that never ends holds the network for USER_HOLD_MAX_MS at most', async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const release = hold();
    const waiting = afterUserActions();
    await jest.advanceTimersByTimeAsync(USER_HOLD_MAX_MS - 1);
    expect(await settled(waiting)).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(await settled(waiting)).toBe(true);
    expect(warn).toHaveBeenCalledWith('[WARN][NET] user_hold_expired held_ms=60000');
    warn.mockRestore();
    release();
    expect(await settled(afterUserActions())).toBe(true);
    expect(USER_HOLD_MAX_MS).toBe(60_000);
  });

  it('a screen holds it while busy and lets it go when it is not, or when it goes', async () => {
    const Busy = ({ busy }) => { useHoldForUser(busy); return null; };
    let tree;
    await act(async () => { tree = renderer.create(<Busy busy={false} />); });
    expect(await settled(afterUserActions())).toBe(true);
    await act(async () => { tree.update(<Busy busy />); });
    const waiting = afterUserActions();
    expect(await settled(waiting)).toBe(false);
    await act(async () => { tree.update(<Busy busy={false} />); });
    expect(await settled(waiting)).toBe(true);
    await act(async () => { tree.update(<Busy busy />); });
    const again = afterUserActions();
    await act(async () => { tree.unmount(); });
    expect(await settled(again)).toBe(true);
  });
});

describe('the background verification waits for it', () => {
  it('the light client starts no download while an action holds the network, and starts right after', async () => {
    const release = hold();
    const head = lc.certifiedHeadHint(() => GENESIS);
    await flush();
    expect(global.fetch).not.toHaveBeenCalled();
    release();
    expect(await head).toBe(7);
    expect(global.fetch.mock.calls.map(([url]) => url)).toEqual(GENESIS.map((g) => `${g}/api/v1/state/certified`));
  });

  it('a certified proof (a token transfer\'s inclusion, a balance) is asked for only once the action ended', async () => {
    const wm = new WalletManager();
    let release = hold();
    const check = wm.verifyTokenTransferInclusion({ tx_hash: 'ab'.repeat(32), log_index: 0 });
    await flush();
    expect(global.fetch).not.toHaveBeenCalled();
    release();
    expect(await check).toBe('pending');
    expect(global.fetch.mock.calls.some(([url]) => url.includes('/api/v1/logs/proof?tx_hash='))).toBe(true);

    global.fetch.mockClear();
    release = hold();
    const balance = wm.getQNCBalanceWithProof('02dca74ef2eae3be97feon499504db891ae0c60e364a8', false);
    await flush();
    expect(global.fetch).not.toHaveBeenCalled();
    release();
    await balance;
    expect(global.fetch.mock.calls.some(([url]) => url.includes('/balance/proof?mb='))).toBe(true);
  });

  it('downloads already under way finish under a hold that starts after them', async () => {
    const answers = [];
    global.fetch = jest.fn(() => new Promise((resolve) => { answers.push(resolve); }));
    const head = lc.certifiedHeadHint(() => GENESIS);
    await flush();
    expect(global.fetch).toHaveBeenCalledTimes(3);
    const release = hold();
    answers.forEach((answer) => answer({
      ok: true, status: 200, headers: { get: () => null }, text: async () => '{"proof_format":2,"newest_certified_index":7}',
    }));
    expect(await head).toBe(7);
    release();
  });
});

// The wallet screen's own holds are tested on the screen: a send (SessionLock.test.js), a move of a node balance
// (App1110.test.js), a Solana send (TransferLink.test.js) and Use this device (NodeTabWallets.test.js).
describe('the user actions that hold it', () => {
  it('the in-app browser: a confirmed request while it is carried out', () => {
    expect(read('src/browser/DappSheet.js')).toContain('useHoldForUser(acting || view.busy === true);');
  });

  it('the QNet Link sheet: reading the request; a decided answer while it is made and delivered, on screen or not', async () => {
    expect(read('src/screens/QNetLinkScreen.js')).toContain("useHoldForUser(phase === 'loading');");
    const { carryAnswer } = require('../src/services/LinkAnswers');
    let delivered;
    carryAnswer('c'.repeat(32), new Promise((resolve) => { delivered = resolve; }));
    expect(await settled(afterUserActions())).toBe(false);
    delivered('failed');
    expect(await settled(afterUserActions())).toBe(true);
  });
});
