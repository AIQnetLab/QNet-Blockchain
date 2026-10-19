/**
 * The history list is assembled from the explorer archive, a node and what the device already shows.
 * Rows must never duplicate, an older page must never be lost to a refresh of the first one, and a row
 * the chain no longer has must not linger inside the span the explorer vouched for.
 */
import {
  historyRowKey, splitExplorerItems, tokenRowFromEvent, mergeHistory, appendHistory, cacheableHistory, fmtTokenBaseUnits,
  txDirection, nodeNativeRow, withListing, listingKey, listingKeysOfNodeRow, checkedCachedRows, historyBadge, historyEntries,
  markInBlock,
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

  it("a node's row is only reported: the archive's row confirms it, and a node never downgrades an archived row", () => {
    const nodeRow = nodeNativeRow({ hash: 'h1', from: OTHER, to: ME, amount: 2_500_000_000, fee: 150_000, timestamp: (NOW - 5_000) / 1000 }, ME);
    expect(nodeRow).toMatchObject({ status: 'reported', type: 'receive', amount: 2.5, fee: 0.00015 });
    expect(cacheableHistory([nodeRow])).toEqual([]);

    // The explorer's row for the same transaction comes first in a refresh and wins.
    const archived = row('h1', NOW - 5_000);
    const both = mergeHistory([], [archived, nodeRow], { myAddress: ME, coveredFromMs: 0, nowMs: NOW, nodeEventsOk: true });
    expect(both).toEqual([archived]);

    // A later refresh that did not ask the explorer brings only the node's row: the archived one stays.
    const later = mergeHistory(both, [nodeRow], { myAddress: ME, coveredFromMs: Infinity, nowMs: NOW, nodeEventsOk: true });
    expect(later).toEqual([archived]);

    // Only a node knows it so far: shown as reported.
    const only = mergeHistory([], [nodeRow], { myAddress: ME, coveredFromMs: Infinity, nowMs: NOW, nodeEventsOk: true });
    expect(only[0].status).toBe('reported');
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

describe('a landed send is never left "Not found" (L-10)', () => {
  const { rowsDueToDrop, PENDING_ROW_MAX_MS, historyBadge } = require('../src/utils/txHistory');
  const sent = (hash, ts, extra = {}) => ({ ...row(hash, ts), from: ME, to: OTHER, type: 'send', status: 'pending', ...extra });
  const opts = (extra = {}) => ({ myAddress: ME, coveredFromMs: Infinity, nowMs: NOW, nodeEventsOk: true, ...extra });

  it('a confirmed or reported row with its hash replaces a pending or not-found row, on an older page too', () => {
    const dropped = sent('h-landed', NOW - PENDING_ROW_MAX_MS - 1, { status: 'dropped' });
    const pending = sent('h-pending', NOW - 1_000);
    // Scrolled to the page that holds them: the archive's rows come after the rows already shown, and still win.
    const out = appendHistory([dropped, pending], [row('h-landed', NOW - PENDING_ROW_MAX_MS - 1, { from: ME, to: OTHER, type: 'send' })]);
    expect(out.filter((r) => r.hash === 'h-landed')).toHaveLength(1);
    expect(historyBadge(out.find((r) => r.hash === 'h-landed'))).toBe('confirmed');
    const reported = appendHistory([pending], [{ ...row('h-pending', NOW - 900), from: ME, to: OTHER, type: 'send', status: 'reported' }]);
    expect(reported).toHaveLength(1);
    expect(reported[0].status).toBe('reported');
    // A row of another hash stays as it is.
    expect(appendHistory([dropped], [row('other', NOW - 5_000)]).map((r) => r.status).sort()).toEqual(['confirmed', 'dropped']);
    // A send that ran and failed is "Failed", not "Not found".
    const failed = appendHistory([dropped], [row('h-landed', NOW - PENDING_ROW_MAX_MS - 1, { from: ME, to: OTHER, type: 'send', status: 'failed' })]);
    expect(failed.map((r) => historyBadge(r))).toEqual(['failed']);
  });

  it('names the rows a merge would mark not found, and only those', () => {
    const due = sent('due', NOW - PENDING_ROW_MAX_MS);
    const young = sent('young', NOW - PENDING_ROW_MAX_MS + 1);
    const carried = sent('carried', NOW - PENDING_ROW_MAX_MS - 5);
    const notMine = { ...sent('theirs', NOW - PENDING_ROW_MAX_MS - 5), from: OTHER };
    const already = sent('already', NOW - PENDING_ROW_MAX_MS - 5, { status: 'dropped' });
    expect(rowsDueToDrop([due, young, carried, notMine, already], [row('carried', NOW - 10)], { myAddress: ME, nowMs: NOW }).map((r) => r.hash))
      .toEqual(['due']);
  });

  it('the chain\'s answer by nonce decides before "Not found": landed, taken by another, or not read yet', () => {
    const at = NOW - PENDING_ROW_MAX_MS - 1;
    const prev = [sent('landed', at), sent('copy', at - 1), sent('gone', at - 2), sent('unread', at - 3), sent('silent', at - 4)];
    const settled = new Map([
      ['landed', { landed: true, txHash: 'landed' }],
      ['copy', { landed: true, txHash: 'hedged-copy' }],
      ['gone', { gone: true }],
      ['unread', { unread: true }],
    ]);
    const out = mergeHistory(prev, [], opts({ settled }));
    const by = (h) => out.find((r) => r.hash === h);
    expect(by('landed').status).toBe('reported');
    expect(by('hedged-copy').status).toBe('reported');
    expect(by('copy')).toBeUndefined();
    expect(by('gone')).toBeUndefined();
    expect(by('unread').status).toBe('pending');
    expect(by('silent').status).toBe('dropped');
    // The archive's row of the copy that landed replaces the reported one once it is listed.
    const later = mergeHistory(out, [{ ...row('hedged-copy', at), from: ME, to: OTHER, type: 'send' }], opts({ coveredFromMs: 0 }));
    expect(later.filter((r) => r.hash === 'hedged-copy').map((r) => r.status)).toEqual(['confirmed']);
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
    // Never Not found, however long no source lists it, and kept on the device.
    const old = markInBlock([sent('h-old', NOW - PENDING_ROW_MAX_MS - 1)], 'h-old');
    expect(rowsDueToDrop(old, [], { myAddress: ME, nowMs: NOW })).toEqual([]);
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
    expect(poll).toMatch(/return markInBlock\(rows, landedHash\);/);
    expect(poll).not.toMatch(/updateTxStatus\(txHash, 'reported'\)/);
  });

  it('the screen asks by nonce before marking, and the result card\'s settle removes a not-found row too', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/screens/WalletScreen.js'), 'utf8');
    const load = src.slice(src.indexOf('const loadTxHistory = async'), src.indexOf('const loadOlderHistory = async'));
    expect(load.indexOf('rowsDueToDrop(txHistoryRef.current, freshRows')).toBeGreaterThan(0);
    expect(load.indexOf('walletManager.resolveSubmitByNonce(s.from, s.nonce')).toBeGreaterThan(load.indexOf('rowsDueToDrop('));
    expect(load.indexOf('mergeHistory(prev, freshRows')).toBeGreaterThan(load.indexOf('walletManager.resolveSubmitByNonce('));
    expect(load).toMatch(/nodeEventsOk: !!nodeEventsData, settled,/);
    expect(src).toMatch(/addPendingTxToHistory\(result\.txHash, sendAddress, amount, TRANSFER_FEE_QNC, null, settle\);/);
    expect(src).toMatch(/\}, settle\);/);
    const poll = src.slice(src.indexOf('const settleByNonce = async'), src.indexOf('const settleLater = '));
    expect(poll.match(/unsettledRow\(r\) && r\.hash === txHash/g)).toHaveLength(2);
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
