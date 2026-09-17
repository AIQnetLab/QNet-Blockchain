/**
 * The history list is assembled from the explorer archive, a node and what the device already shows.
 * Rows must never duplicate, an older page must never be lost to a refresh of the first one, and a row
 * the chain no longer has must not linger inside the span the explorer vouched for.
 */
import {
  historyRowKey, splitExplorerItems, tokenRowFromEvent, mergeHistory, appendHistory, cacheableHistory, fmtTokenBaseUnits,
} from '../src/utils/txHistory';

const ME = 'aaaaaaaaaaaaaaaaaaaeonaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbbbbbbbbbeonbbbbbbbbbbbbbbbbbbbbbb';
const NOW = 1_800_000_000_000;

const row = (hash, ts, extra = {}) => ({ hash, from: OTHER, to: ME, amount: 1, status: 'confirmed', timestamp: ts, type: 'receive', fee: 0, ...extra });

describe('tx history', () => {
  it('splits explorer items into native rows and token events, only for this address', () => {
    const { native, tokenEvents } = splitExplorerItems([
      { source: 'tx', hash: 'h1', idx: 0, block: 10, timestamp: NOW - 1000, from: ME, to: OTHER, amount: '2500000000', tx_type: 'Transfer', fee: '150000' },
      { source: 'batch', hash: 'h2', idx: 7, block: 9, timestamp: NOW - 2000, from: OTHER, to: ME, amount: '1000000000', tx_type: 'BatchTransfers', fee: '0' },
      { source: 'token', hash: 'h3', idx: 1, block: 8, timestamp: NOW - 3000, from: OTHER, to: ME, amount: '5000', contract: 'c1', kind: 'transfer', std: 'qrc20', token_id: '', symbol: 'TK', decimals: 2, logo: '' },
      { source: 'tx', hash: 'h4', idx: 0, block: 7, timestamp: NOW - 4000, from: OTHER, to: OTHER, amount: '1', tx_type: 'Transfer', fee: '0' },
    ], ME.toUpperCase());
    expect(native.map(historyRowKey)).toEqual(['h1', 'h2:b7']);
    expect(native[0]).toMatchObject({ type: 'send', amount: 2.5, fee: 0.00015 });
    expect(native[1]).toMatchObject({ type: 'receive', fee: 0 });
    expect(tokenEvents).toHaveLength(1);
    const token = tokenRowFromEvent(tokenEvents[0], ME, new Map());
    expect(token).toMatchObject({ status: 'confirmed', type: 'receive', tokenAmountDisplay: '50', tokenMetaTrusted: false });
    expect(historyRowKey(token)).toBe('h3:t1');
  });

  it('takes decimals from the wallet\'s own token list over the feed', () => {
    const ev = { tx_hash: 'h', log_index: 0, contract: 'C1', from: OTHER, to: ME, amount: '123456', decimals: 0, symbol: 'FAKE', timestamp: 1 };
    const row1 = tokenRowFromEvent(ev, ME, new Map([['c1', { decimals: 3, symbol: 'REAL' }]]));
    expect(row1).toMatchObject({ tokenAmountDisplay: '123.456', tokenSymbol: 'REAL', tokenMetaTrusted: true, status: 'pending' });
  });

  it('keeps older pages across a refresh and drops rows the covered span no longer has', () => {
    const prev = [
      row('fresh-again', NOW - 60_000),
      row('reorged-away', NOW - 3_600_000),
      row('older-page', NOW - 86_400_000),
      row('just-landed', NOW - 10_000),
      { ...row('mine-pending', NOW - 5_000), status: 'pending', from: ME, type: 'send' },
    ];
    const fresh = [row('fresh-again', NOW - 60_000), row('new', NOW - 1_000)];
    const merged = mergeHistory(prev, fresh, { myAddress: ME, coveredFromMs: NOW - 7_200_000, nowMs: NOW, nodeEventsOk: true });
    expect(merged.map(t => t.hash)).toEqual(['new', 'mine-pending', 'just-landed', 'fresh-again', 'older-page']);
  });

  it('drops nothing already shown when the explorer did not answer', () => {
    const prev = [row('a', NOW - 3_600_000), row('b', NOW - 86_400_000)];
    const merged = mergeHistory(prev, [row('c', NOW - 1_000)], { myAddress: ME, coveredFromMs: Infinity, nowMs: NOW, nodeEventsOk: false });
    expect(merged.map(t => t.hash)).toEqual(['c', 'a', 'b']);
  });

  it('a confirmed pending send leaves the pending row behind', () => {
    const prev = [{ ...row('tx1', NOW - 5_000), status: 'pending', from: ME, type: 'send' }];
    const merged = mergeHistory(prev, [{ ...row('tx1', NOW - 4_000), from: ME, type: 'send' }], { myAddress: ME, coveredFromMs: 0, nowMs: NOW, nodeEventsOk: true });
    expect(merged).toHaveLength(1);
    expect(merged[0].status).toBe('confirmed');
  });

  it('a token transfer proven earlier stays proven while it comes back unproven', () => {
    const ev = { tx_hash: 'h', log_index: 2, contract: 'c', from: OTHER, to: ME, amount: '10', timestamp: (NOW - 1000) / 1000 };
    const proven = { ...tokenRowFromEvent(ev, ME, new Map()), status: 'confirmed', verified: true };
    const merged = mergeHistory([proven], [tokenRowFromEvent(ev, ME, new Map())], { myAddress: ME, coveredFromMs: 0, nowMs: NOW, nodeEventsOk: true });
    expect(merged[0]).toMatchObject({ status: 'confirmed', verified: true });
    const changed = mergeHistory([proven], [tokenRowFromEvent({ ...ev, amount: '11' }, ME, new Map())], { myAddress: ME, coveredFromMs: 0, nowMs: NOW, nodeEventsOk: true });
    expect(changed[0]).toMatchObject({ status: 'pending', verified: false });
  });

  it('an older page appends without duplicating, and only confirmed rows are cached', () => {
    const shown = [row('a', NOW - 1_000), row('b', NOW - 2_000)];
    const merged = appendHistory(shown, [row('b', NOW - 2_000), row('c', NOW - 3_000), row('b', NOW - 2_000, { batchIndex: 3 })]);
    expect(merged.map(historyRowKey)).toEqual(['a', 'b', 'b:b3', 'c']);
    expect(cacheableHistory([...merged, { ...row('p', NOW), status: 'pending' }]).map(t => t.hash)).toEqual(['a', 'b', 'b', 'c']);
  });

  it('formats base units exactly past 2^53', () => {
    expect(fmtTokenBaseUnits('18446744073709551615', 0)).toBe('18,446,744,073,709,551,615');
    expect(fmtTokenBaseUnits('1500000000', 9)).toBe('1.5');
  });
});
