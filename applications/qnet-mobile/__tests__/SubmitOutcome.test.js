/**
 * A submit that never got an answer says nothing about the transaction: the node may hold it and only
 * the reply was lost. Reporting that as a failure is what makes a user send the same money twice, so
 * the wallet treats it as unknown and lets the chain settle it by (from, nonce).
 */
import WalletManager from '../src/components/WalletManager';

const ME = `${'1'.repeat(19)}eon${'2'.repeat(23)}`;
const TO = `${'3'.repeat(19)}eon${'4'.repeat(23)}`;

const bare = () => Object.create(WalletManager.prototype);

describe('an unanswered submit', () => {
  it('is told apart from a verdict the node actually gave', () => {
    expect(WalletManager.isUnansweredSubmit(new Error('Aborted'))).toBe(true);
    expect(WalletManager.isUnansweredSubmit({ name: 'AbortError', message: '' })).toBe(true);
    expect(WalletManager.isUnansweredSubmit(new Error('Network request failed'))).toBe(true);
    expect(WalletManager.isUnansweredSubmit(new Error('all nodes failed'))).toBe(true);
    expect(WalletManager.isUnansweredSubmit(new Error('Insufficient balance'))).toBe(false);
    expect(WalletManager.isUnansweredSubmit(new Error('nonce too low'))).toBe(false);
  });

  it('is reported in one shape, keyed by the nonce the chain settles it by', () => {
    const out = bare()._unknownOutcome(ME, 8, { to: TO, amountNano: 10, refusal: 'nonce too low' });
    expect(out).toMatchObject({ unknown: true, nonce: 8, from: ME, to: TO, refusal: 'nonce too low' });
  });

  it('stays unresolved while the account has not reached that nonce', async () => {
    const wm = bare();
    wm._hedged = jest.fn(async () => ({ ok: true, data: { nonce: 7 } }));
    await expect(wm.resolveSubmitByNonce(ME, 8, { toAddress: TO, amountNano: 10 })).resolves
      .toMatchObject({ landed: false, known: true });
  });

  it('is unresolved, not refused, when no node answers either', async () => {
    const wm = bare();
    wm._hedged = jest.fn(async () => ({ ok: false, data: null }));
    await expect(wm.resolveSubmitByNonce(ME, 8, {})).resolves.toMatchObject({ landed: false, known: false });
  });

  // The history rows the genesis nodes serve (/transactions/history), each with its nonce.
  const withHistory = (rows, accountNonce) => jest.fn(async (path) => (path.startsWith('/api/v1/transactions/history')
    ? { ok: true, data: { transactions: rows } }
    : { ok: true, data: { nonce: accountNonce } }));

  it('lands once the transaction applied at that nonce is this one, and reads back its hash', async () => {
    const wm = bare();
    wm._hedged = withHistory([
      { hash: 'older-same', from: ME, to: TO, amount: 10, nonce: 3, type: 'transfer' },
      { hash: 'applied', from: ME, to: TO, amount: 10, nonce: 8, type: 'transfer' },
      { hash: 'later', from: ME, to: TO, amount: 11, nonce: 9, type: 'transfer' },
    ], 9);
    await expect(wm.resolveSubmitByNonce(ME, 8, { toAddress: TO, amountNano: 10 })).resolves
      .toMatchObject({ landed: true, txHash: 'applied' });
    // The history is read from genesis names by address (a query of the wallet, not of a third party).
    expect(wm._hedged.mock.calls.every(([, opts]) => !opts || !opts.nodes)).toBe(true);
  });

  // MOBNET-R1-03: the nonce being used says only that SOME transaction of this key applied at it.
  it('another transaction at the nonce (a replacement, the extension with the same phrase) means it did not apply', async () => {
    const wm = bare();
    wm._hedged = withHistory([{ hash: 'carol', from: ME, to: `${'5'.repeat(19)}eon${'6'.repeat(23)}`, amount: 99, nonce: 8, type: 'transfer' }], 8);
    await expect(wm.resolveSubmitByNonce(ME, 8, { toAddress: TO, amountNano: 10 })).resolves
      .toMatchObject({ landed: false, known: true, replaced: true });
    // Same recipient, other amount: not this one either.
    wm._hedged = withHistory([{ hash: 'x', from: ME, to: TO, amount: 11, nonce: 8, type: 'transfer' }], 8);
    await expect(wm.resolveSubmitByNonce(ME, 8, { toAddress: TO, amountNano: 10 })).resolves.toMatchObject({ replaced: true });
    // A call to another contract is not this one; a call to the same contract is only a candidate (MOBNET-R2-02).
    wm._hedged = withHistory([{ hash: 'c', from: ME, to: 'c'.repeat(64), amount: 0, nonce: 8, type: 'contract_call' }], 8);
    await expect(wm.resolveSubmitByNonce(ME, 8, { kind: 'call', toAddress: 'd'.repeat(64) })).resolves.toMatchObject({ replaced: true });
    const unbound = await wm.resolveSubmitByNonce(ME, 8, { kind: 'call', toAddress: 'c'.repeat(64), method: 'mint' });
    expect(unbound).toMatchObject({ landed: false, unbound: true, txHash: 'c' });
  });

  it('stays unknown — never "sent" — while the history cannot name the transaction at that nonce', async () => {
    const wm = bare();
    wm._hedged = withHistory([], 12);
    const r = await wm.resolveSubmitByNonce(ME, 8, { toAddress: TO, amountNano: 10 });
    expect(r).toMatchObject({ landed: false, known: true, spent: true });
    expect(r.replaced).toBeUndefined();
  });

  // L-10: a history read that failed says nothing, so History never marks a landed send "Not found" on it.
  it('learns nothing when no node gives the history, unlike a history that lists no row at that nonce', async () => {
    const wm = bare();
    for (const history of [{ ok: false, data: null }, { ok: true, data: {} }, null]) {
      wm._hedged = jest.fn(async (path) => (path.startsWith('/api/v1/transactions/history') ? history : { ok: true, data: { nonce: 12 } }));
      await expect(wm.resolveSubmitByNonce(ME, 8, { toAddress: TO, amountNano: 10 })).resolves.toEqual({ landed: false, known: false });
    }
    wm._hedged = jest.fn(async (path) => {
      if (path.startsWith('/api/v1/transactions/history')) throw new Error('timeout');
      return { ok: true, data: { nonce: 12 } };
    });
    await expect(wm.resolveSubmitByNonce(ME, 8, { toAddress: TO, amountNano: 10 })).resolves.toEqual({ landed: false, known: false });
  });
});

// MOBNET-R2-02: a token transfer is bound to its own recipient and amount before it is reported sent.
describe('an unanswered token transfer', () => {
  const TOKEN = 'c'.repeat(64);
  const A = `${'5'.repeat(19)}eon${'6'.repeat(23)}`;
  const B = `${'7'.repeat(19)}eon${'8'.repeat(23)}`;
  const rig = (events) => jest.fn(async (path) => {
    if (path.startsWith('/api/v1/transactions/history')) {
      return { ok: true, data: { transactions: [{ hash: 'h8', from: ME, to: TOKEN, amount: 0, nonce: 8, type: 'contract_call' }] } };
    }
    if (path.includes('/token-transfers')) return { ok: true, data: { transfers: events } };
    return { ok: true, data: { nonce: 8 } };
  });
  const ask = (wm, to) => wm.resolveSubmitByNonce(ME, 8, { kind: 'call', toAddress: TOKEN, method: 'transfer', recipient: to, amountBase: '1000' });

  it('lands only when the call\'s transfer event names this recipient and amount', async () => {
    const wm = bare();
    wm._hedged = rig([{ tx_hash: 'h8', contract: TOKEN, from: ME, to: B, amount: '1000' }]);
    await expect(ask(wm, B)).resolves.toMatchObject({ landed: true, txHash: 'h8' });
  });

  it('the original transfer to A winning the nonce is not "sent to B"', async () => {
    const wm = bare();
    wm._hedged = rig([{ tx_hash: 'h8', contract: TOKEN, from: ME, to: A, amount: '1000' }]);
    await expect(ask(wm, B)).resolves.toMatchObject({ landed: false, replaced: true });
    wm._hedged = rig([{ tx_hash: 'h8', contract: TOKEN, from: ME, to: B, amount: '999' }]);
    await expect(ask(wm, B)).resolves.toMatchObject({ replaced: true });
  });

  it('with no event to read, or an amount JSON cannot carry exactly, it is unbound, never sent', async () => {
    const wm = bare();
    wm._hedged = rig([]);
    await expect(ask(wm, B)).resolves.toMatchObject({ landed: false, unbound: true });
    wm._hedged = rig([{ tx_hash: 'h8', contract: TOKEN, from: ME, to: B, amount: 2 ** 60 }]);
    await expect(ask(wm, B)).resolves.toMatchObject({ unbound: true });
  });

  it('a deploy is unbound: any deploy at the nonce matches its kind', async () => {
    const wm = bare();
    wm._hedged = jest.fn(async (path) => (path.startsWith('/api/v1/transactions/history')
      ? { ok: true, data: { transactions: [{ hash: 'd8', from: ME, to: '', amount: 0, nonce: 8, type: 'contract_deploy' }] } }
      : { ok: true, data: { nonce: 8 } }));
    await expect(wm.resolveSubmitByNonce(ME, 8, { kind: 'deploy' })).resolves.toMatchObject({ unbound: true, txHash: 'd8' });
  });

  it('the call carries its recipient and amount to the resolver', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/components/WalletManager.js'), 'utf8');
    expect(src).toMatch(/method === 'transfer' && argList\.length === 2 \? \{ recipient: String\(argList\[0\]\), amountBase: String\(argList\[1\]\) \}/);
    const screen = require('fs').readFileSync(require('path').join(__dirname, '../src/screens/WalletScreen.js'), 'utf8');
    expect(screen).toMatch(/method: outcome\.method \|\| null, recipient: outcome\.recipient \|\| null, amountBase: outcome\.amountBase \|\| null/);
    expect(screen).toMatch(/if \(res\.unbound\) \{/);
  });
});
