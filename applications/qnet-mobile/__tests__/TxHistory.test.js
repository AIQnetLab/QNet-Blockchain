/**
 * The history list is assembled from the explorer archive, a node and what the device already shows.
 * Rows must never duplicate, an older page must never be lost to a refresh of the first one, and a row
 * the chain no longer has must not linger inside the span the explorer vouched for.
 */
import {
  historyRowKey, splitExplorerItems, tokenRowFromEvent, mergeHistory, appendHistory, cacheableHistory, fmtTokenBaseUnits,
  txDirection, nodeNativeRow, withListing, listingKey, listingKeysOfNodeRow, checkedCachedRows, historyBadge, historyEntries,
  markInBlock, nodeEventRow, withNodeEvents, TX_INDEX_RETENTION_BLOCKS, MICROBLOCK_BODY_RETENTION_BLOCKS, HISTORY_LOOKUP_ROWS,
  rowsToLookUp, lookupListingKeys, tokenRowsToProve, withProofVerdicts, lookupLedger, txTypeName,
} from '../src/utils/txHistory';

const ME = 'aaaaaaaaaaaaaaaaaaaeonaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbbbbbbbbbeonbbbbbbbbbbbbbbbbbbbbbb';
const NOW = 1_800_000_000_000;

const row = (hash, ts, extra = {}) => ({ hash, from: OTHER, to: ME, amount: 1, status: 'confirmed', timestamp: ts, type: 'receive', fee: 0, ...extra });
const opts = (extra = {}) => ({ myAddress: ME, coveredFromMs: Infinity, nowMs: NOW, nodeEventsOk: true, ...extra });

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
    // The archive's word alone: unverified until two genesis nodes list a native row, or a logs proof a token transfer.
    expect(native.map((r) => r.status)).toEqual(['unverified', 'unverified']);
    expect(native.map((r) => r.amountNano)).toEqual(['2500000000', '1000000000']);
    expect(token).toMatchObject({ status: 'unverified', type: 'receive', tokenAmountDisplay: '50', tokenMetaTrusted: false });
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

  it('reads a transfer back to the same wallet as its own direction, in every feed', () => {
    expect(txDirection(ME, OTHER, ME)).toBe('send');
    expect(txDirection(OTHER, ME, ME)).toBe('receive');
    expect(txDirection(ME, ME, ME)).toBe('self');
    expect(txDirection(ME.toUpperCase(), ME, ME)).toBe('self');

    // The explorer page: a self transfer is not a receipt, and it still paid its fee.
    const { native } = splitExplorerItems(
      [{ source: 'tx', hash: 'h9', idx: 0, timestamp: NOW, from: ME, to: ME, amount: '10000000000', tx_type: 'Transfer', fee: '150000' }], ME);
    expect(native[0]).toMatchObject({ type: 'self', amount: 10, fee: 0.00015 });

    // A token transfer reads the same way.
    const token = tokenRowFromEvent(
      { tx_hash: 'h10', log_index: 0, contract: 'c1', from: ME, to: ME, amount: '500', decimals: 2, symbol: 'TK', timestamp: NOW / 1000 },
      ME, new Map());
    expect(token.type).toBe('self');
  });

  // A row a genesis node reports in a block never reads Unverified, whatever the archive lists.
  it("a node's row is reported and in a block; the archive's row of it takes that, and a node never downgrades an archived row", () => {
    const nodeRow = nodeNativeRow({ hash: 'h1', from: OTHER, to: ME, amount: 2_500_000_000, fee: 150_000, status: 'confirmed', timestamp: (NOW - 5_000) / 1000 }, ME);
    expect(nodeRow).toMatchObject({ status: 'reported', inBlock: true, type: 'receive', amount: 2.5, fee: 0.00015 });
    expect(historyBadge(nodeRow)).toBe('confirmed');
    expect(cacheableHistory([nodeRow])).toEqual([nodeRow]);
    // A row of the node's index that does not say it is in a block (no status, or another word) is the node's word alone.
    for (const status of [undefined, 'pending', 'failed']) {
      const other = nodeNativeRow({ hash: 'h0', from: OTHER, to: ME, amount: 1, status, timestamp: 1 }, ME);
      expect([status, other.inBlock, historyBadge(other)]).toEqual([status, undefined, 'pending']);
    }
    expect(nodeNativeRow({ hash: 'h0', from: ME, to: ME, amount: 0, status: 'no_effect', timestamp: 1 }, ME).inBlock).toBe(true);

    // The explorer's row for the same transaction comes first in a refresh and wins, in a block as the node said.
    const archived = row('h1', NOW - 5_000, { status: 'unverified' });
    expect(historyBadge(archived)).toBe('unverified');
    const both = mergeHistory([], [archived, nodeRow], { myAddress: ME, coveredFromMs: 0, nowMs: NOW, nodeEventsOk: true });
    expect(both).toEqual([{ ...archived, inBlock: true }]);
    expect(historyBadge(both[0])).toBe('confirmed');

    // A later refresh that did not ask the explorer brings only the node's row: the archived one stays, still in a block.
    const later = mergeHistory(both, [nodeRow], { myAddress: ME, coveredFromMs: Infinity, nowMs: NOW, nodeEventsOk: true });
    expect(later).toEqual([{ ...archived, inBlock: true }]);
    // The node's window passed: the archive alone returns it, and it keeps the flag.
    expect(mergeHistory(later, [archived], { myAddress: ME, coveredFromMs: 0, nowMs: NOW, nodeEventsOk: true }).map(historyBadge))
      .toEqual(['confirmed']);
    // A batch credit's archive row (hash:bN) kept from before takes it from the node's bare-hash row.
    const credit = { ...archived, hash: 'hb', batchIndex: 0 };
    const kept = mergeHistory([credit], [{ ...nodeRow, hash: 'hb' }], { myAddress: ME, coveredFromMs: Infinity, nowMs: NOW, nodeEventsOk: true });
    expect(kept.map((r) => [historyRowKey(r), historyBadge(r)])).toEqual([['hb:b0', 'confirmed']]);

    // Only a node knows it so far: shown as reported, confirmed at once.
    const only = mergeHistory([], [nodeRow], { myAddress: ME, coveredFromMs: Infinity, nowMs: NOW, nodeEventsOk: true });
    expect([only[0].status, historyBadge(only[0])]).toEqual(['reported', 'confirmed']);
  });

  it('formats base units exactly past 2^53', () => {
    expect(fmtTokenBaseUnits('18446744073709551615', 0)).toBe('18,446,744,073,709,551,615');
    expect(fmtTokenBaseUnits('1500000000', 9)).toBe('1.5');
  });
});

describe('a node\'s transaction lookup (MOBNET-R2-01)', () => {
  const { txLookupState } = require('../src/utils/txHistory');
  const H = 'ab'.repeat(32);
  it('"found" in a mempool is pending, never included', () => {
    const mempool = { tx_hash: H, status: 'found', transaction: { hash: H, status: 'pending', block_height: null } };
    expect(txLookupState(mempool, H)).toBe('pending');
  });
  it('included only with a block height and the stored status', () => {
    expect(txLookupState({ status: 'found', transaction: { hash: H, status: 'confirmed', block_height: 1234 } }, H)).toBe('included');
    expect(txLookupState({ status: 'found', transaction: { hash: H, status: 'confirmed', block_height: null } }, H)).toBe('unknown');
    expect(txLookupState({ status: 'found', transaction: { hash: H, status: 'confirmed', block_height: '12' } }, H)).toBe('unknown');
    expect(txLookupState({ status: 'found', transaction: { hash: 'cd'.repeat(32), status: 'confirmed', block_height: 5 } }, H)).toBe('unknown');
  });
  it('absent and malformed answers', () => {
    expect(txLookupState({ status: 'not_found', transaction: null }, H)).toBe('absent');
    expect(txLookupState(null, H)).toBe('unknown');
    expect(txLookupState({ status: 'error' }, H)).toBe('unknown');
  });
  it('the result card polls with this rule, not with "found"', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/screens/WalletScreen.js'), 'utf8');
    expect(src).toMatch(/return txLookupState\(txData, txHash\) === 'included' \? txData\.transaction\.block_height : null;/);
    expect(src).not.toMatch(/txData\.status !== 'not_found'/);
  });
});

// A send of this wallet ends only by the chain (CLAUDE.md section 3): a block holds it, another transaction took its nonce,
// or the chain's height passed the last height a V2 send signed; the time since it was sent ends nothing.
describe('a send of this wallet ends only by the chain, never by a clock', () => {
  const { rowsToSettle, nonceAnswer, withNonceAnswer } = require('../src/utils/txHistory');
  const sent = (hash, ts, extra = {}) => ({
    ...row(hash, ts), from: ME, to: OTHER, type: 'send', status: 'pending',
    settle: { from: ME, nonce: 7, kind: 'transfer', to: OTHER, amountNano: '1000000000' }, ...extra,
  });
  const DAY = 86_400_000;

  it('a confirmed or reported row with its hash replaces a pending or expired row, on an older page too', () => {
    const expired = sent('h-landed', NOW - DAY, { status: 'expired' });
    const pending = sent('h-pending', NOW - 1_000);
    // Scrolled to the page that holds them: the archive's rows come after the rows already shown, and still win.
    const out = appendHistory([expired, pending], [row('h-landed', NOW - DAY, { from: ME, to: OTHER, type: 'send' })]);
    expect(out.filter((r) => r.hash === 'h-landed')).toHaveLength(1);
    expect(historyBadge(out.find((r) => r.hash === 'h-landed'))).toBe('confirmed');
    const reported = appendHistory([pending], [{ ...row('h-pending', NOW - 900), from: ME, to: OTHER, type: 'send', status: 'reported' }]);
    expect(reported).toHaveLength(1);
    expect(reported[0].status).toBe('reported');
    // A row of another hash stays as it is.
    expect(appendHistory([expired], [row('other', NOW - 5_000)]).map((r) => r.status).sort()).toEqual(['confirmed', 'expired']);
    // A send that ran and failed is "Failed".
    const failed = appendHistory([expired], [row('h-landed', NOW - DAY, { from: ME, to: OTHER, type: 'send', status: 'failed' })]);
    expect(failed.map((r) => historyBadge(r))).toEqual(['failed']);
  });

  it('a send no source lists stays Pending however long ago it was sent, until the chain answers', () => {
    const old = [sent('a-day', NOW - DAY), sent('a-week', NOW - 7 * DAY)];
    const out = mergeHistory(old, [], opts());
    expect(out.map((r) => [r.hash, r.status, historyBadge(r)])).toEqual([['a-day', 'pending', 'pending'], ['a-week', 'pending', 'pending']]);
    expect(mergeHistory(old, [], opts({ nowMs: NOW + 365 * DAY })).map(historyBadge)).toEqual(['pending', 'pending']);
    expect(withNonceAnswer(old, 'a-week', null)).toBe(old);
  });

  it('every History read names each pending send of this wallet no source carries, oldest first, at most HISTORY_LOOKUP_ROWS', () => {
    const young = sent('young', NOW - 1_000);
    const old = sent('old', NOW - DAY);
    const carried = sent('carried', NOW - 5);
    const notMine = { ...sent('theirs', NOW - 5), from: OTHER };
    const expired = sent('expired', NOW - 5, { status: 'expired' });
    const inBlock = sent('in-block', NOW - 5, { inBlock: true });
    const noNonce = sent('no-nonce', NOW - 5, { settle: undefined });
    expect(rowsToSettle([young, carried, notMine, expired, inBlock, noNonce, old], [row('carried', NOW - 10)], { myAddress: ME })
      .map((r) => r.hash)).toEqual(['old', 'young']);
    const many = Array.from({ length: HISTORY_LOOKUP_ROWS + 3 }, (_, i) => sent(`h${i}`, NOW - i * 1000));
    expect(rowsToSettle(many, [], { myAddress: ME }).map((r) => r.hash)).toEqual(many.slice(3).reverse().map((r) => r.hash));
  });

  it('the chain\'s answer by nonce decides: in a block (its own hash or a copy under another), its nonce taken, or its last height passed', () => {
    expect(nonceAnswer({ landed: true, known: true, txHash: 'copy' }, 'h')).toEqual({ landed: true, txHash: 'copy' });
    expect(nonceAnswer({ landed: true, known: true, txHash: null }, 'h')).toEqual({ landed: true, txHash: 'h' });
    expect(nonceAnswer({ landed: false, known: true, expired: true }, 'h')).toEqual({ expired: true });
    expect(nonceAnswer({ landed: false, known: true, replaced: true }, 'h')).toEqual({ gone: true });
    expect(nonceAnswer({ landed: false, known: true, unbound: true, txHash: 'x' }, 'h')).toEqual({ gone: true });
    // Nothing decided: no answer, its nonce still free (held, sent again or no longer sent), or spent with no row to bind it.
    for (const res of [null, { landed: false, known: false }, { landed: false, known: true, held: true, sending: true, mayLandUntil: NOW },
      { landed: false, known: true, held: false, sending: false, mayLandUntil: null }, { landed: false, known: true, spent: true }]) {
      expect(nonceAnswer(res, 'h')).toBe(null);
    }
    const at = NOW - DAY;
    const prev = [sent('landed', at), sent('copy', at - 1), sent('gone', at - 2), sent('expired', at - 3), sent('silent', at - 4)];
    const answers = [
      ['landed', { landed: true, txHash: 'landed' }],
      ['copy', { landed: true, txHash: 'hedged-copy' }],
      ['gone', { gone: true }],
      ['expired', { expired: true }],
    ];
    // Each answer on its row as History's read puts it there once its rows are on screen, then the next read's merge.
    const out = mergeHistory(answers.reduce((rows, [hash, answer]) => withNonceAnswer(rows, hash, answer), prev), [], opts());
    const by = (h) => out.find((r) => r.hash === h);
    expect([by('landed').inBlock, historyBadge(by('landed'))]).toEqual([true, 'confirmed']);
    expect([by('hedged-copy').inBlock, historyBadge(by('hedged-copy'))]).toEqual([true, 'confirmed']);
    expect(by('copy')).toBeUndefined();
    expect(by('gone')).toBeUndefined();
    expect([by('expired').status, historyBadge(by('expired'))]).toEqual(['expired', 'expired']);
    expect([by('silent').status, historyBadge(by('silent'))]).toEqual(['pending', 'pending']);
    // In a block it is kept on the device; Pending and Expired are not.
    expect(cacheableHistory(out).map((r) => r.hash).sort()).toEqual(['hedged-copy', 'landed']);
    // Only a pending one is asked again; the archive's row of the copy that landed replaces it, in a block as well.
    expect(rowsToSettle(out, [], { myAddress: ME }).map((r) => r.hash)).toEqual(['silent']);
    const later = mergeHistory(out, [{ ...row('hedged-copy', at), from: ME, to: OTHER, type: 'send', status: 'unverified' }], opts({ coveredFromMs: 0 }));
    expect(later.filter((r) => r.hash === 'hedged-copy').map((r) => [r.status, historyBadge(r)])).toEqual([['unverified', 'confirmed']]);
    // A source that lists the expired one after all is its record.
    const listed = mergeHistory(out, [{ ...row('expired', at - 3), from: ME, to: OTHER, type: 'send' }], opts({ coveredFromMs: 0 }));
    expect(listed.filter((r) => r.hash === 'expired').map(historyBadge)).toEqual(['confirmed']);
  });

  it('the result card and History apply one answer the same way; a row that does not change stays the same object', () => {
    const other = row('other', NOW - 6_000);
    const rows = [sent('h-sent', NOW - 5_000), other];
    const own = withNonceAnswer(rows, 'H-SENT', { landed: true, txHash: 'h-sent' });
    expect([own[0].hash, own[0].status, own[0].inBlock, own[1] === other]).toEqual(['h-sent', 'pending', true, true]);
    // A copy under another hash: the row takes it, or goes when a row of that hash is listed already, that row in a block.
    expect(withNonceAnswer(rows, 'h-sent', { landed: true, txHash: 'h-copy' })[0]).toMatchObject({ hash: 'h-copy', inBlock: true });
    const withCopy = [...rows, row('h-copy', NOW - 4_000, { status: 'unverified' })];
    expect(withNonceAnswer(withCopy, 'h-sent', { landed: true, txHash: 'h-copy' }).map((r) => [r.hash, !!r.inBlock]))
      .toEqual([['other', false], ['h-copy', true]]);
    // A block is the stronger fact: an Expired row of that hash is Confirmed once an answer by nonce or the result card's
    // lookup by hash finds it in one.
    expect(historyBadge(withNonceAnswer([sent('h-x', NOW, { status: 'expired' })], 'h-x', { landed: true, txHash: 'h-x' })[0])).toBe('confirmed');
    expect(historyBadge(markInBlock([sent('h-y', NOW, { status: 'expired' })], 'h-y')[0])).toBe('confirmed');
    expect(withNonceAnswer(rows, 'h-sent', { gone: true })).toEqual([other]);
    expect(withNonceAnswer(rows, 'h-sent', { expired: true }).map((r) => r.status)).toEqual(['expired', 'confirmed']);
    expect(withNonceAnswer(rows, 'h-sent', null)).toBe(rows);
    expect(withNonceAnswer(rows, 'nope', { gone: true })).toBe(rows);
    // A row a block holds is never made Expired.
    const held = markInBlock(rows, 'h-sent');
    expect(withNonceAnswer(held, 'h-sent', { expired: true })[0]).toBe(held[0]);
  });

  // Before, a send the result card saw in a block went back to "Pending" in History (one node's 'reported' row) until two
  // genesis nodes listed it, and the archive's row said "Unverified" over it (owner, 18.10).
  it('a send the result card saw in a block is confirmed at once, and every later row of its hash stays so', () => {
    const shown = markInBlock([sent('h-sent', NOW - 5_000), row('other', NOW - 6_000)], 'H-SENT', 4043400);
    expect(shown[0]).toMatchObject({ status: 'pending', inBlock: true, block: 4043400 });
    expect(shown[1]).toBe(markInBlock(shown, 'h-sent')[1]); // other rows are the same objects
    expect(shown.map(historyBadge)).toEqual(['confirmed', 'confirmed']);
    expect(markInBlock(shown, 'h-sent')[0]).toBe(shown[0]);
    // One node's row of it, then the archive's: confirmed, not Pending or Unverified.
    const node = { ...nodeNativeRow({ hash: 'h-sent', from: ME, to: OTHER, amount: 1e9, timestamp: (NOW - 4_000) / 1000 }, ME) };
    const merged = mergeHistory(shown, [node], opts());
    expect(merged.filter((r) => r.hash === 'h-sent').map((r) => [r.status, r.inBlock, historyBadge(r)])).toEqual([['reported', true, 'confirmed']]);
    const archive = splitExplorerItems([{ source: 'tx', hash: 'h-sent', idx: 0, block: 4043400, timestamp: NOW - 4_000, from: ME, to: OTHER,
      amount: '1000000000', tx_type: 'Transfer', fee: '150000' }], ME).native;
    const later = mergeHistory(merged, archive, opts({ coveredFromMs: 0 }));
    expect(later.filter((r) => r.hash === 'h-sent').map((r) => [r.status, historyBadge(r)])).toEqual([['unverified', 'confirmed']]);
    // In a block however long no source lists it, never asked again, and kept on the device.
    const old = markInBlock([sent('h-old', NOW - DAY)], 'h-old');
    expect(rowsToSettle(old, [], { myAddress: ME })).toEqual([]);
    expect(mergeHistory(old, [], opts())[0].status).toBe('pending');
    expect(historyBadge(mergeHistory(old, [], opts())[0])).toBe('confirmed');
    expect(cacheableHistory(old).map((r) => r.hash)).toEqual(['h-old']);
  });

  it('a token transfer a genesis node reports is confirmed at once; a logs proof adds the mark and is kept', () => {
    const ev = { tx_hash: 'ht', log_index: 0, contract: 'c', from: OTHER, to: ME, amount: '10', timestamp: (NOW - 1000) / 1000 };
    const reported = tokenRowFromEvent({ ...ev, reported: true }, ME, new Map());
    expect([reported.status, reported.inBlock, reported.verified, historyBadge(reported)]).toEqual(['confirmed', true, false, 'confirmed']);
    // The archive's word alone stays unverified.
    expect(tokenRowFromEvent({ ...ev, archived: true }, ME, new Map()).status).toBe('unverified');
    // Proven on an earlier pass: the mark stays while the node reports it again without it.
    const proven = { ...reported, verified: true };
    expect(mergeHistory([proven], [reported], opts())[0]).toMatchObject({ status: 'confirmed', verified: true, inBlock: true });
    // Reported once: the archive's row of it later (the node's window passed) stays confirmed.
    expect(mergeHistory([reported], [tokenRowFromEvent({ ...ev, archived: true }, ME, new Map())], opts())[0])
      .toMatchObject({ status: 'confirmed', inBlock: true });
  });

  it('the result card marks the row in a block where it sees the send included', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/screens/WalletScreen.js'), 'utf8');
    const poll = src.slice(src.indexOf('const startTxConfirmationPolling ='), src.indexOf('const startUnknownOutcomeResolution ='));
    expect(poll).toMatch(/setTxHistory\(prev => markInBlock\(prev, txHash, block\)\);/);
    expect(poll).not.toMatch(/updateTxStatus\(txHash, 'reported'\)/);
  });

  // A nonce read takes seconds (an account read, a send again, a history read): the read's rows, its live figure and its
  // single flight never wait for it (App1110.test.js runs it on the screen).
  it('every History read asks by nonce once its rows are on screen, and the result card applies the same answer; no clock is in the rule', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/screens/WalletScreen.js'), 'utf8');
    const load = src.slice(src.indexOf('const loadTxHistory = async'), src.indexOf('const loadOlderHistory = async'));
    const shown = load.indexOf('rowsShown();\n      settleSentRows(address, unsettled);');
    expect(load.indexOf('const unsettled = rowsToSettle(txHistoryRef.current, freshRows, { myAddress });')).toBeGreaterThan(0);
    expect(shown).toBeGreaterThan(load.indexOf('mergeHistory(prev, freshRows'));
    expect(load.indexOf('readLiveFigure(address);')).toBeLessThan(shown);
    expect(load).not.toMatch(/resolveSubmitByNonce|await settleSentRows|nonceAnswer/);
    const settleRows = src.slice(src.indexOf('const settleSentRows = '), src.indexOf('const lookUpOlderRows = async'));
    expect(settleRows).toMatch(/if \(settlingRef\.current\.has\(key\)\) return;/);
    expect(settleRows).toMatch(/const res = await walletManager\.resolveSubmitByNonce\(s\.from, s\.nonce, \{/);
    expect(settleRows).toMatch(/const answer = nonceAnswer\(res, r\.hash\);/);
    expect(settleRows).toMatch(/const next = withNonceAnswer\(prev, r\.hash, answer\);/);
    expect(src).toMatch(/addPendingTxToHistory\(result\.txHash, sendAddress, amount, TRANSFER_FEE_QNC, null, settle\);/);
    expect(src).toMatch(/\}, settle\);/);
    const poll = src.slice(src.indexOf('const settleByNonce = async'), src.indexOf('const settleLater = '));
    expect(poll).toMatch(/const answer = nonceAnswer\(res, txHash\);/);
    expect(poll).toMatch(/setTxHistory\(prev => withNonceAnswer\(prev, txHash, answer\)\);/);
    const lib = require('fs').readFileSync(require('path').join(__dirname, '../src/utils/txHistory.js'), 'utf8');
    for (const text of [src, lib]) expect(text).not.toMatch(/PENDING_ROW_MAX_MS|rowsDueToDrop|'dropped'/);
  });
});

// Receive labels (wallet-galc plan, P1; the extension's rule): the archive's row is unverified, a row two genesis nodes
// list alike is in a block, and received QNC is in the balance once the wallet's live figure covers its block.
describe('receive labels', () => {
  const [sent, received] = splitExplorerItems([
    { source: 'tx', hash: 'h1', idx: 0, block: 900, timestamp: NOW - 1000, from: ME, to: OTHER, amount: '2500000000', tx_type: 'Transfer', fee: '150000' },
    { source: 'tx', hash: 'h2', idx: 0, block: 1800, timestamp: NOW - 2000, from: OTHER, to: ME, amount: '1000000000', tx_type: 'Transfer', fee: '0' },
  ], ME).native;
  // As a genesis node's history lists them (GET /api/v1/transactions/history).
  const listedBy = (...rows) => new Set(rows.flatMap((r) => listingKeysOfNodeRow(r)));
  const nodeRow = (r, over = {}) => ({ hash: r.hash, from: r.from, to: r.to, amount: Number(r.amountNano), type: 'transfer', ...over });

  it('an archive row is unverified; listed alike it is confirmed, received QNC once the figure read last covers it', () => {
    expect([sent, received].map(historyBadge)).toEqual(['unverified', 'unverified']);
    const listed = listedBy(nodeRow(sent), nodeRow(received));
    const below = withListing([sent, received], listed, 1799);
    expect(below.map((r) => [r.status, r.listed])).toEqual([['confirmed', true], ['included', true]]);
    expect(below.map(historyBadge)).toEqual(['confirmed', 'included']);
    // The live figure covers its block: credited, and it stays so whatever comes after.
    const covered = withListing(below, null, 1800);
    expect(covered.map((r) => r.status)).toEqual(['confirmed', 'confirmed']);
    expect(withListing(covered, null, null)[1].status).toBe('confirmed');
    // Unchanged rows are the same objects (the screen does not render again).
    expect(withListing(covered, null, 1800).every((r, i) => r === covered[i])).toBe(true);
    // Not listed, or listed with another amount or party: unverified as before; a token row is never listed this way.
    expect(withListing([sent, received], listedBy(nodeRow(received, { amount: 999 })), 5000).map((r) => r.status)).toEqual(['unverified', 'unverified']);
    expect(withListing([sent, received], null, 5000).map((r) => r.status)).toEqual(['unverified', 'unverified']);
    const token = tokenRowFromEvent({ tx_hash: 'h3', log_index: 0, contract: 'C1', from: OTHER, to: ME, amount: '5', archived: true }, ME, new Map());
    expect(listingKey(token)).toBe(null);
    expect(withListing([token], listedBy(nodeRow({ hash: 'h3', from: OTHER, to: ME, amountNano: '0' })), 5000)[0].status).toBe('unverified');
  });

  it('a reported row of one node is settled the same way; a contract call matches by its hash', () => {
    const reported = nodeNativeRow({ hash: 'h4', tx_type: 'Transfer', from: OTHER, to: ME, amount: 7, timestamp: 1, block_height: 50 }, ME);
    expect(reported.status).toBe('reported');
    expect(withListing([reported], listedBy(nodeRow(reported)), 90)[0].status).toBe('confirmed');
    const call = { hash: 'h5', txType: 'ContractCall', from: ME, to: 'c'.repeat(64), amountNano: '0', status: 'unverified', type: 'send' };
    expect(withListing([call], listedBy({ hash: 'h5', from: ME, to: null, amount: 0, type: 'contract_call' }), null)[0].status).toBe('confirmed');
  });

  it('a refresh keeps what was listed while the archive returns the row unverified; the cache keeps every archive row', () => {
    const listed = withListing([sent, received], listedBy(nodeRow(sent), nodeRow(received)), 5000);
    const merged = mergeHistory(listed, [sent, received], { myAddress: ME, coveredFromMs: 0, nowMs: NOW, nodeEventsOk: true });
    expect(merged.map((r) => [r.hash, r.status])).toEqual([['h1', 'confirmed'], ['h2', 'confirmed']]);
    // Another amount under the same hash is another row's word: not kept.
    const changed = mergeHistory(listed, [{ ...sent, amountNano: '1' }], { myAddress: ME, coveredFromMs: 0, nowMs: NOW, nodeEventsOk: true });
    expect(changed.find((r) => r.hash === 'h1').status).toBe('unverified');
    expect(cacheableHistory([...listed, { ...sent, hash: 'h9' }, { hash: 'p', status: 'pending' }]).map((r) => r.hash)).toEqual(['h1', 'h2', 'h9']);
    // A node's reported row goes beside the archive's row for it, unverified or not.
    const reported = { ...nodeNativeRow({ hash: 'h2', from: OTHER, to: ME, amount: 1000000000, timestamp: 1 }, ME) };
    expect(mergeHistory([], [sent, received, reported], { myAddress: ME, coveredFromMs: 0, nowMs: NOW, nodeEventsOk: true })
      .filter((r) => r.hash === 'h2').map((r) => r.status)).toEqual(['unverified']);
  });

  it('a row an older build cached as confirmed on the word of the archive reads as unverified; proven rows stay', () => {
    const rows = checkedCachedRows([
      { hash: 'a', status: 'confirmed', type: 'receive' },
      { hash: 'b', status: 'confirmed', type: 'receive', listed: true },
      { hash: 'c', status: 'confirmed', tokenContract: 'C1', verified: false },
      { hash: 'd', status: 'confirmed', tokenContract: 'C1', verified: true },
      { hash: 'node:x', status: 'confirmed', nodeEvent: true },
      { hash: 'e', status: 'pending' },
    ]);
    expect(rows.map((r) => r.status)).toEqual(['unverified', 'confirmed', 'unverified', 'confirmed', 'confirmed', 'pending']);
  });

  it('a row a genesis node reported in a block or applied keeps that through the cache', () => {
    const rows = checkedCachedRows([
      { hash: 'f', status: 'confirmed', type: 'send', inBlock: true },
      { hash: 'g', status: 'confirmed', tokenContract: 'C1', verified: false, inBlock: true },
    ]);
    expect(rows.map((r) => r.status)).toEqual(['confirmed', 'confirmed']);
  });

  it('a registration the registry holds is settled, the unverified row of the archive too', () => {
    const reg = { hash: 'r1', txType: 'NodeRegistration', from: ME, to: '', amount: 0, status: 'unverified', timestamp: NOW, type: 'send', block: 7 };
    const ev = { hash: 'node:n1', nodeEvent: true, nodeId: 'n1', nodeType: 'light', height: 7, status: 'confirmed', timestamp: NOW };
    expect(historyEntries([reg, ev])).toEqual([expect.objectContaining({ hash: 'r1', nodeRegistration: true, status: 'confirmed' })]);
  });
});

// A genesis node keeps the newest TX_INDEX_RETENTION_BLOCKS blocks of its transaction index, so the archive's row of an
// older block, QNC or token, is in a block by the newest figure's height and never reads "Unverified" (no node can list,
// report or prove it any more); inside the window a genesis node's word decides.
describe('the archive row of a block the nodes\' index no longer reaches', () => {
  const B = 4_000_000;
  const PAST = B + TX_INDEX_RETENTION_BLOCKS;
  const ago = (days) => NOW - days * 86_400_000;
  const { native, tokenEvents } = splitExplorerItems([
    { source: 'tx', hash: 'h-old', idx: 0, block: B, timestamp: ago(3), from: OTHER, to: ME, amount: '1000000000', tx_type: 'Transfer', fee: '0' },
    { source: 'tx', hash: 'h-new', idx: 0, block: B + 1, timestamp: ago(2), from: ME, to: OTHER, amount: '2000000000', tx_type: 'Transfer', fee: '150000' },
    { source: 'token', hash: 'h-tok', idx: 0, block: B, timestamp: ago(3), from: OTHER, to: ME, amount: '5', contract: 'c1', kind: 'transfer', std: 'qrc20', token_id: '', symbol: 'TK', decimals: 0, logo: '' },
  ], ME);
  const rows = [...native, tokenRowFromEvent(tokenEvents[0], ME, new Map())];
  const by = (list) => Object.fromEntries(list.map((r) => [r.hash, historyBadge(r)]));

  it('one TX_INDEX_RETENTION_BLOCKS or more below the newest figure is in a block at once; one above stays as it was', () => {
    expect(TX_INDEX_RETENTION_BLOCKS).toBe(100_000);
    expect(by(rows)).toEqual({ 'h-old': 'unverified', 'h-new': 'unverified', 'h-tok': 'unverified' });
    const judged = withListing(rows, null, PAST);
    expect(by(judged)).toEqual({ 'h-old': 'confirmed', 'h-new': 'unverified', 'h-tok': 'confirmed' });
    expect(judged[0]).toEqual({ ...rows[0], inBlock: true });
    expect(judged[1]).toBe(rows[1]); // inside the window: the same object
    // One block short, or no figure read: nothing changes, but for the token row, whose logs the nodes keep a shorter
    // span (MICROBLOCK_BODY_RETENTION_BLOCKS); a row that names no block, or a Solana row, is never judged so.
    expect(withListing(rows, null, null).every((r, i) => r === rows[i])).toBe(true);
    expect(withListing(rows, null, PAST - 1).map((r, i) => r === rows[i])).toEqual([true, true, false]);
    expect(withListing(rows, null, B + MICROBLOCK_BODY_RETENTION_BLOCKS - 1).every((r, i) => r === rows[i])).toBe(true);
    const { block, ...unnamed } = rows[0];
    expect(block).toBe(B);
    expect(withListing([unnamed, { ...rows[0], chain: 'solana' }], null, PAST).map(historyBadge)).toEqual(['unverified', 'unverified']);
    // Inside the window two genesis nodes listing a row still decide it.
    const listed = new Set(listingKeysOfNodeRow({ hash: 'h-new', from: ME, to: OTHER, amount: 2000000000, type: 'transfer' }));
    expect(by(withListing(rows, listed, PAST))).toEqual({ 'h-old': 'confirmed', 'h-new': 'confirmed', 'h-tok': 'confirmed' });
  });

  it('fresh and kept rows, an older page and the cache: one rule, and a row once in a block stays so', () => {
    // Shown by a read before any figure came, then kept by a refresh that does not bring them again.
    const before = mergeHistory([], rows, opts({ coveredFromMs: 0 }));
    expect(Object.values(by(before))).toEqual(['unverified', 'unverified', 'unverified']);
    const kept = withListing(mergeHistory(before, [], opts()), null, PAST);
    expect(by(kept)).toEqual({ 'h-old': 'confirmed', 'h-new': 'unverified', 'h-tok': 'confirmed' });
    // An older page under the newest rows.
    const paged = withListing(appendHistory([row('h-top', NOW - 1_000)], rows), null, PAST);
    expect(by(paged)).toEqual({ 'h-top': 'confirmed', 'h-old': 'confirmed', 'h-new': 'unverified', 'h-tok': 'confirmed' });
    // Read back from the device cache before any figure: in a block at once; the archive's rows a later read brings
    // again, unverified and with no figure read yet, take the flag from the kept ones.
    const reloaded = withListing(checkedCachedRows(JSON.parse(JSON.stringify(cacheableHistory(kept)))), null, null);
    expect(by(reloaded)).toEqual({ 'h-old': 'confirmed', 'h-new': 'unverified', 'h-tok': 'confirmed' });
    const again = withListing(mergeHistory(reloaded, rows, opts({ coveredFromMs: 0 })), null, null);
    expect(by(again)).toEqual({ 'h-old': 'confirmed', 'h-new': 'unverified', 'h-tok': 'confirmed' });
    // A row an older build cached as confirmed on the archive's word alone: unverified, then in a block by the figure.
    const older = checkedCachedRows([{ ...rows[0], status: 'confirmed' }]);
    expect([historyBadge(older[0]), historyBadge(withListing(older, null, PAST)[0])]).toEqual(['unverified', 'confirmed']);
  });

  it('the screen judges every row it holds: a read\'s fresh and kept rows, an older page, the cache and each new figure', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/screens/WalletScreen.js'), 'utf8');
    const read = src.slice(src.indexOf('const readTxHistory = async'), src.indexOf('const loadOlderHistory = async'));
    expect(read).toMatch(/const freshRows = withListing\(\[\.\.\.nativeTxs, \.\.\.tokenTxs, \.\.\.nodeEventTxs\], listed, covered, logsFloorRef\.current\);/);
    expect(read).toMatch(/const coveredNow = coveredHeight\(address\);\s+setTxHistory\(prev => \{\s+const merged = withListing\(mergeHistory\(prev, freshRows, \{[^}]*\}\), null, coveredNow, logsFloorRef\.current\);/);
    const older = src.slice(src.indexOf('const loadOlderHistory = async'), src.indexOf('const addPendingTxToHistory ='));
    expect(older).toMatch(/const covered = coveredHeight\(address\);\s+setTxHistory\(prev => \{\s+const merged = withListing\(appendHistory\(prev, rows\), null, covered, logsFloorRef\.current\);/);
    expect(src).toMatch(/const covered = coveredHeight\(owner\);\s+if \(cached\.length\) setTxHistory\(prev => \(prev\.length \? prev : withListing\(checkedCachedRows\(cached\), null, covered, logsFloorRef\.current\)\)\);/);
    const note = src.slice(src.indexOf('const noteCovered = '), src.indexOf('const notePause = '));
    expect(note).toMatch(/const next = withListing\(prev, null, covered, logsFloorRef\.current\);/);
    const lookup = src.slice(src.indexOf('const lookUpOlderRows = async'), src.indexOf('const loadTxHistory = async'));
    expect(lookup).toMatch(/const next = withListing\(prev, found\.listed, coveredHeight\(address\), logsFloorRef\.current\);/);
    // On a read: this wallet's sends are asked about by nonce and the rows past the listing are looked up once its rows
    // are shown, the token proofs are chosen by block (no clock), and their final verdicts are kept on the rows.
    expect(read).toMatch(/rowsShown\(\);\s+settleSentRows\(address, unsettled\);\s+lookUpOlderRows\(address, listed, coveredNow\);/);
    expect(read).toMatch(/const provable = tokenRowsToProve\(tokenTxs, txHistoryRef\.current, coveredNow, logsFloorRef\.current\);/);
    expect(read).toMatch(/const next = withProofVerdicts\(prev, verdicts\);/);
    expect(read).not.toMatch(/24 \* 3600/);
    // The floor a genesis node reported, the highest of the session.
    expect(read).toMatch(/const reportedFloor = tokenFeed \? tokenFeed\.oldestAvailable : null;/);
  });
});

// A genesis node keeps token transfers, their logs and so their proofs for its newest
// MICROBLOCK_BODY_RETENTION_BLOCKS blocks only, pruned below the floor it reports (`oldest_available`). The archive's
// token row of a block at or below that floor is in a block: no node can report or prove it any more.
describe('a token row of a block whose logs no genesis node keeps', () => {
  const TIP = 4_000_000;
  const FLOOR = TIP - 86_400 - 7_000;
  const token = (hash, block, extra = {}) => ({
    ...tokenRowFromEvent({ tx_hash: hash, log_index: 0, contract: 'c1', from: OTHER, to: ME, amount: '5', archived: true, block }, ME, new Map()),
    ...extra,
  });
  const qnc = (hash, block) => splitExplorerItems([{ source: 'tx', hash, idx: 0, block, timestamp: NOW, from: OTHER, to: ME,
    amount: '1000000000', tx_type: 'Transfer', fee: '0' }], ME).native[0];

  it('at or below the floor a genesis node reported it is in a block; above it, or a QNC row, stays as it was', () => {
    expect(MICROBLOCK_BODY_RETENTION_BLOCKS).toBe(86_400);
    const rows = [token('t-floor', FLOOR), token('t-above', FLOOR + 1), qnc('q-floor', FLOOR)];
    const judged = withListing(rows, null, TIP, FLOOR);
    expect(judged.map((r) => [r.hash, historyBadge(r), !!r.inBlock])).toEqual([
      ['t-floor', 'confirmed', true], ['t-above', 'unverified', false], ['q-floor', 'unverified', false],
    ]);
    expect(judged[0]).toEqual({ ...rows[0], inBlock: true });
    expect(judged[1]).toBe(rows[1]);
    expect(judged[2]).toBe(rows[2]);
  });

  it('with no floor reported, MICROBLOCK_BODY_RETENTION_BLOCKS below the tip stands in; a floor above that is clamped', () => {
    const at = token('t-at', TIP - 86_400);
    const inside = token('t-in', TIP - 86_399);
    expect(withListing([at, inside], null, TIP, null).map(historyBadge)).toEqual(['confirmed', 'unverified']);
    // A floor no honest node reports (its own tip): never more than 86,400 below the tip counts.
    expect(withListing([inside], null, TIP, TIP)[0]).toBe(inside);
    // A floor of 0 (the node keeps every block's logs): only the index window judges.
    expect(withListing([at], null, TIP, 0)[0]).toBe(at);
    // No tip: nothing is judged, whatever the floor.
    expect(withListing([at, inside], null, null, FLOOR).every((r, i) => r === [at, inside][i])).toBe(true);
  });

  it('a node\'s feed row names its block as `height`', () => {
    const r = tokenRowFromEvent({ tx_hash: 'h', log_index: 1, contract: 'c1', from: OTHER, to: ME, amount: '5', reported: true, height: 1234 }, ME, new Map());
    expect(r.block).toBe(1234);
  });
});

// The logs proofs are asked for by block, not by a clock: the rows the nodes still keep the logs of.
describe('the token rows whose proof is asked', () => {
  const TIP = 4_000_000;
  const FLOOR = TIP - 90_000;
  const ev = (hash, extra = {}) => ({ tx_hash: hash, log_index: 0, contract: 'c1', from: OTHER, to: ME, amount: '5', ...extra });
  const archive = (hash, block, extra = {}) => tokenRowFromEvent(ev(hash, { archived: true, block, ...extra }), ME, new Map());

  it('inside the logs window by block, whatever its time; never one past it or one with a final verdict for that transfer', () => {
    const old = archive('t-old', FLOOR + 1, { timestamp: (NOW - 3 * 86_400_000) / 1000 });
    const node = tokenRowFromEvent(ev('t-node', { reported: true }), ME, new Map());
    const atFloor = archive('t-floor', FLOOR, { timestamp: NOW / 1000 });
    const pastIndex = archive('t-past', TIP - TX_INDEX_RETENTION_BLOCKS);
    const proven = archive('t-proven', FLOOR + 5);
    const contradicted = archive('t-bad', FLOOR + 6);
    const otherAmount = archive('t-other', FLOOR + 7);
    const shown = [
      { ...proven, status: 'confirmed', verified: true },
      { ...contradicted, proofRejected: true },
      { ...otherAmount, tokenRawAmount: '6', proofRejected: true },
    ];
    const asked = tokenRowsToProve([old, node, atFloor, pastIndex, proven, contradicted, otherAmount], shown, TIP, FLOOR);
    expect(asked.map((r) => r.hash)).toEqual(['t-old', 't-node', 't-other']);
    // No tip: inside the window. A QNC row has no logs proof.
    expect(tokenRowsToProve([atFloor], [], null, FLOOR).map((r) => r.hash)).toEqual(['t-floor']);
    expect(tokenRowsToProve([row('q1', NOW, { block: FLOOR + 1 })], [], TIP, FLOOR)).toEqual([]);
  });
});

// A token row whose logs proof contradicted the archive keeps that verdict: it never turns Confirmed, inside the
// window or past it, through merges and the cache.
describe('a token row its logs proof contradicted', () => {
  const TIP = 4_000_000;
  const B = TIP - 50_000;
  const ev = { tx_hash: 'ht', log_index: 0, contract: 'c1', from: OTHER, to: ME, amount: '10', archived: true, block: B, timestamp: (NOW - 1000) / 1000 };
  const t = tokenRowFromEvent(ev, ME, new Map());
  const verdict = (v, r = t) => new Map([[historyRowKey(r), { verdict: v, row: r }]]);

  it('keeps the verdict on the row; past both windows it still reads unverified', () => {
    const [bad] = withProofVerdicts([t], verdict('rejected'));
    expect(bad).toEqual({ ...t, proofRejected: true });
    expect(historyBadge(bad)).toBe('unverified');
    const far = TIP + TX_INDEX_RETENTION_BLOCKS + 1;
    expect(historyBadge(withListing([bad], null, far, null)[0])).toBe('unverified');
    expect(withListing([t], null, far, null)[0].inBlock).toBe(true); // without the verdict it would be Confirmed
    // An unchanged row is the same object; another row is untouched.
    expect(withProofVerdicts([bad], verdict('rejected'))[0]).toBe(bad);
    const other = row('h-other', NOW);
    expect(withProofVerdicts([other], verdict('rejected'))[0]).toBe(other);
  });

  it('survives a merge with the same transfer from the archive, and the device cache', () => {
    const [bad] = withProofVerdicts([t], verdict('rejected'));
    // A node's row of the same hash in a block (another leg): the archive row it marks would be in a block.
    const leg = tokenRowFromEvent({ ...ev, log_index: 1, archived: false, reported: true }, ME, new Map());
    const merged = mergeHistory([bad], [t, leg], opts({ coveredFromMs: 0 }));
    const again = merged.find((r) => historyRowKey(r) === historyRowKey(t));
    expect([again.proofRejected, again.inBlock, historyBadge(again)]).toEqual([true, undefined, 'unverified']);
    // Its entry with the other leg: in a block only when every leg is.
    const [entry] = historyEntries(merged);
    expect([entry.legs.length, historyBadge(entry)]).toEqual([2, 'unverified']);
    const reloaded = checkedCachedRows(JSON.parse(JSON.stringify(cacheableHistory(merged))));
    const cached = reloaded.find((r) => historyRowKey(r) === historyRowKey(t));
    expect([cached.proofRejected, historyBadge(cached)]).toEqual([true, 'unverified']);
    expect(historyBadge(withListing([cached], null, TIP + TX_INDEX_RETENTION_BLOCKS, null)[0])).toBe('unverified');
    // The result card's mark of its hash does not lift it.
    expect(historyBadge(markInBlock([cached], 'ht', 99)[0])).toBe('unverified');
  });

  it('another amount under the same key does not inherit it; a proof that verified wins; a row a node reported stays confirmed', () => {
    const [bad] = withProofVerdicts([t], verdict('rejected'));
    const changed = tokenRowFromEvent({ ...ev, amount: '11' }, ME, new Map());
    expect(mergeHistory([bad], [changed], opts({ coveredFromMs: 0 }))[0].proofRejected).toBeUndefined();
    expect(withProofVerdicts([changed], verdict('rejected'))[0]).toBe(changed);
    const [good] = withProofVerdicts([bad], verdict('verified'));
    expect([good.status, good.verified, good.proofRejected]).toEqual(['confirmed', true, undefined]);
    expect(withProofVerdicts([good], verdict('rejected'))[0]).toBe(good);
    const reported = tokenRowFromEvent({ ...ev, archived: false, reported: true }, ME, new Map());
    const [kept] = withProofVerdicts([reported], verdict('rejected', reported));
    expect([kept.proofRejected, kept.inBlock, historyBadge(kept)]).toEqual([true, true, 'confirmed']);
  });
});

// Rows inside the nodes' window but past the newest 100 the listing reads are looked up by their hash on the genesis
// nodes (WalletManager.lookedUpHistoryRows); two that report the row at its block list it.
describe('rows past the listing, looked up by hash', () => {
  const TIP = 4_000_000;
  const at = (i) => splitExplorerItems([{ source: 'tx', hash: `h${i}`, idx: 0, block: TIP - 1000 - i, timestamp: NOW - i * 1000,
    from: OTHER, to: ME, amount: String(1e9 + i), tx_type: 'Transfer', fee: '0' }], ME).native[0];

  it('the newest rows no listing settled, HISTORY_LOOKUP_ROWS at most, none asked before', () => {
    expect(HISTORY_LOOKUP_ROWS).toBe(8);
    const fresh = Array.from({ length: 11 }, (_, i) => at(i));
    const thisRead = at(20);
    const listed = new Set([listingKey(thisRead)]);
    const rows = [
      thisRead, { ...at(21), listed: true, status: 'confirmed' }, { ...at(22), inBlock: true },
      tokenRowFromEvent({ tx_hash: 'tk', log_index: 0, contract: 'c1', from: OTHER, to: ME, amount: '5', archived: true, block: TIP - 5 }, ME, new Map()),
      { ...at(23), hash: 'hb', batchIndex: 1 }, { ...at(24), block: TIP - TX_INDEX_RETENTION_BLOCKS }, ...fresh,
    ];
    const skip = new Set([listingKey(fresh[0])]);
    expect(rowsToLookUp(rows, { listed, tip: TIP, skip }).map((r) => r.hash)).toEqual(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7', 'h8']);
  });

  it('in one session a row two nodes answered for is not asked again, one in flight not twice, any other again', () => {
    const rows = [at(1), at(2), at(3)];
    const keys = rows.map(listingKey);
    const ledger = lookupLedger(ME);
    expect(ledger.owner).toBe(ME);
    expect(ledger.due(rows, { tip: TIP }).map((r) => r.hash)).toEqual(['h1', 'h2', 'h3']);
    ledger.asking(keys);
    expect(ledger.due(rows, { tip: TIP })).toEqual([]);
    // h1 and h3 answered by two nodes, h2 by fewer
    ledger.ended(keys, [keys[0], keys[2]]);
    expect(ledger.due(rows, { tip: TIP }).map((r) => r.hash)).toEqual(['h2']);
    // a lookup that failed answers for none: asked again
    ledger.asking([keys[1]]);
    ledger.ended([keys[1]], []);
    expect(ledger.due(rows, { tip: TIP }).map((r) => r.hash)).toEqual(['h2']);
    // another wallet's session asks its own rows afresh
    expect(lookupLedger(OTHER).due(rows, { tip: TIP })).toHaveLength(3);
  });

  it('the screen keeps one ledger per wallet and ends each lookup in it, failed or not', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/screens/WalletScreen.js'), 'utf8');
    const lookup = src.slice(src.indexOf('const lookUpOlderRows = async'), src.indexOf('const loadTxHistory = async'));
    expect(lookup).toMatch(/if \(!lookupsRef\.current \|\| lookupsRef\.current\.owner !== address\) lookupsRef\.current = lookupLedger\(address\);/);
    expect(lookup).toMatch(/const rows = ledger\.due\(txHistoryRef\.current, \{ listed, tip \}\);/);
    expect(lookup).toMatch(/ledger\.asking\(keys\);\s+const found = await walletManager\.lookedUpHistoryRows\(address, rows\);\s+answered = \[\.\.\.found\.answered\];/);
    expect(lookup).toMatch(/\} finally \{\s+ledger\.ended\(keys, answered\);\s+\}/);
  });

  it('a lookup gives the row\'s key only for an included transaction; a key by hash alone only for this wallet\'s own', () => {
    const r = at(3);
    const found = (tx, status = 'found') => ({ status, transaction: { hash: 'h3', status: 'confirmed', block_height: r.block, ...tx } });
    expect(lookupListingKeys(found({ from: OTHER, to: ME, amount: 1e9 + 3, tx_type: 'Transfer' }), 'h3', ME)).toEqual([listingKey(r)]);
    const reg = { hash: 'h3', txType: 'NodeRegistration', from: ME, to: '', amountNano: '0', status: 'unverified' };
    const debug = 'NodeRegistration { node_id: "light_x", phone: "" }';
    expect(lookupListingKeys(found({ from: ME, to: null, amount: 0, tx_type: debug }), 'h3', ME)).toEqual([listingKey(reg)]);
    expect(lookupListingKeys(found({ from: OTHER, to: null, amount: 0, tx_type: debug }), 'h3', ME)).toEqual([]);
    expect(listingKeysOfNodeRow({ hash: 'h3', from: ME, tx_type: debug })).toEqual([listingKey(reg)]);
    // one reader of a type's name for both sources: the debug form's word, a history row's snake case
    expect([txTypeName(debug), txTypeName('contract_call'), txTypeName(' ContractCall')]).toEqual(['NodeRegistration', 'contract_call', 'ContractCall']);
    expect(listingKeysOfNodeRow({ hash: 'h3', from: ME, type: 'node_registration' })).toEqual([listingKey(reg)]);
    for (const answer of [found({ from: OTHER, to: ME, amount: 1e9 + 3, status: 'pending', block_height: null }), { status: 'not_found' },
      found({ hash: 'other', from: OTHER, to: ME, amount: 1e9 + 3 })]) {
      expect(lookupListingKeys(answer, 'h3', ME)).toEqual([]);
    }
  });

  it('the keys looked up list the rows as a listing does: received QNC included until the figure covers it', () => {
    const r = at(3);
    const sent = { ...at(4), from: ME, to: OTHER, type: 'send' };
    const keys = new Set([listingKey(r), listingKey(sent)]);
    expect(withListing([r, sent], keys, r.block - 1).map((x) => [x.status, x.listed])).toEqual([['included', true], ['confirmed', true]]);
    expect(withListing([r], keys, r.block)[0].status).toBe('confirmed');
  });
});
