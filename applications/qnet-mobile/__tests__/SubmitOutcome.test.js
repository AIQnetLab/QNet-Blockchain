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
  afterEach(() => { delete WalletManager.nonceCache[ME]; });

  it('is told apart from a verdict the node actually gave', () => {
    expect(WalletManager.isUnansweredSubmit(new Error('Aborted'))).toBe(true);
    expect(WalletManager.isUnansweredSubmit({ name: 'AbortError', message: '' })).toBe(true);
    expect(WalletManager.isUnansweredSubmit(new Error('Network request failed'))).toBe(true);
    expect(WalletManager.isUnansweredSubmit(new Error('all nodes failed'))).toBe(true);
    expect(WalletManager.isUnansweredSubmit(new Error('Insufficient balance'))).toBe(false);
    expect(WalletManager.isUnansweredSubmit(new Error('nonce too low'))).toBe(false);
  });

  it('drops the local nonce, so a retry reuses the slot instead of paying twice', () => {
    WalletManager.nonceCache[ME] = { next: 9, at: Date.now(), pkBound: true };
    const out = bare()._unknownOutcome(ME, 8, { to: TO, amountNano: 10 });
    expect(out).toMatchObject({ unknown: true, nonce: 8, from: ME, to: TO });
    expect(WalletManager.nonceCache[ME]).toBeUndefined();
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

  it('lands once the account reaches the nonce, and reads back the copy that applied', async () => {
    const wm = bare();
    wm._hedged = jest.fn(async (path) => (path.endsWith('/transactions')
      ? { ok: true, data: { transactions: [
          { hash: 'older', from: ME, to: TO, amount: 10, timestamp: 100 },
          { hash: 'applied', from: ME, to: TO, amount: 10, timestamp: 900 },
          { hash: 'other-amount', from: ME, to: TO, amount: 11, timestamp: 950 },
        ] } }
      : { ok: true, data: { nonce: 8 } }));
    await expect(wm.resolveSubmitByNonce(ME, 8, { toAddress: TO, amountNano: 10 })).resolves
      .toMatchObject({ landed: true, txHash: 'applied' });
  });

  it('lands without a hash when the account history cannot name the copy', async () => {
    const wm = bare();
    wm._hedged = jest.fn(async (path) => (path.endsWith('/transactions')
      ? { ok: true, data: { transactions: [] } }
      : { ok: true, data: { nonce: 12 } }));
    await expect(wm.resolveSubmitByNonce(ME, 8, { toAddress: TO, amountNano: 10 })).resolves
      .toMatchObject({ landed: true, txHash: null });
  });
});
