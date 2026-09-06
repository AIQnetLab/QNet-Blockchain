import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { quoteBigInts, uintString, transformTransaction, batchRowsOf, shapeBlock, blockRowFromHeader, toMs, merkleRootOf } from '../transform';
import { insertBatchTransfers, insertTransactions, insertBlocks, deltaOf, negate, mergeDelta } from '../sql';
import { ranges, dedupeHeaders, flushGroups, FLUSH_BLOCKS, FLUSH_BATCH_ROWS } from '../chain';
import { pickNetworkHeight, HEIGHT_SLACK } from '../node-client';

// A u64 amount above 2^53 survives the JSON hop exactly: quoted before parse, kept as a digit string.
test('wide integers never pass through a double', () => {
  const raw = '{"amount":18446744073709551615,"gas_price":80,"nonce":12345678901234567}';
  const v = JSON.parse(quoteBigInts(raw));
  assert.equal(uintString(v.amount), '18446744073709551615');
  assert.equal(uintString(v.gas_price), '80');
  assert.equal(uintString(v.nonce), '12345678901234567');
  assert.equal(uintString(-5), '0');
  assert.equal(uintString('abc'), '0');
  assert.equal(uintString(2 ** 64), '18446744073709551615', 'a rounded u64::MAX clamps instead of overflowing');
});

// A block whose genesis fan-out and benchmark rows are left out records how many it skipped, so the
// heal pass compares against the rows it could ever hold.
test('skipped transactions are counted on the block row', () => {
  const b = shapeBlock({ height: 0, timestamp: 1, transactions: [
    { hash: 'c'.repeat(64), from: 'genesis', to: 'eon_user_1', amount: 1, nonce: 0, gas_price: 0, gas_limit: 0, tx_type: 'Transfer' },
    { hash: 'd'.repeat(64), from: 'genesis', to: 'system_pool', amount: 1, nonce: 1, gas_price: 0, gas_limit: 0, tx_type: 'Transfer' },
    { hash: 'e'.repeat(64), from: 'EON1benchmark_x', to: 'eon_user_2', amount: 1, nonce: 0, gas_price: 0, gas_limit: 0, tx_type: 'Transfer' },
  ] });
  assert.equal(b.block.tx_count, 3);
  assert.equal(b.block.tx_skipped, 2);
  assert.equal(b.txs.length, 1);
});

// A batch envelope becomes one tx row (recipients not embedded) plus one recipient row per transfer,
// in block order, with the block time.
test('batch envelope shapes into envelope row and recipient rows', () => {
  const transfers = Array.from({ length: 1000 }, (_, i) => ({ to_address: `r${i}`, amount: i + 1 }));
  const tx = { hash: 'a'.repeat(64), from: 'sender_eon', to: 'batch_transfers', amount: 500500, nonce: 3, gas_price: 80, gas_limit: 10_000_000,
    timestamp: 1, tx_type: { BatchTransfers: { transfers, batch_id: 'b1' } }, dilithium_signature: [1, 2, 3] };
  const row = transformTransaction(tx, 10, 1_788_000_010_000, 4)!;
  assert.equal(row.tx_type, 'BatchTransfers');
  assert.equal(row.tx_index, 4);
  assert.equal(row.timestamp, 1_788_000_010_000);
  assert.deepEqual(row.tx_type_data, { batch_id: 'b1', transfer_count: 1000 });
  assert.equal(row.dilithium_signature, '010203');
  const rows = batchRowsOf(tx, row);
  assert.equal(rows.length, 1000);
  assert.deepEqual(rows[999], { tx_hash: row.hash, tx_index: 999, block: 10, timestamp: row.timestamp, from_address: 'sender_eon', to_address: 'r999', amount: '1000' });
});

// The bulk statements keep a fixed parameter count however many rows they carry (the 65 535 cap).
test('bulk statements have a constant parameter count', () => {
  const big = Array.from({ length: 30_000 }, (_, i) => ({ tx_hash: 'h', tx_index: i, block: 1, timestamp: 1, from_address: 'f', to_address: 't', amount: '1' }));
  const st = insertBatchTransfers(big);
  assert.equal(st.values.length, 7);
  assert.equal((st.values[1] as unknown[]).length, 30_000);
  const txs = Array.from({ length: 5 }, (_, i) => transformTransaction({ hash: 'b'.repeat(64), from: 'x', to: 'y', amount: 1, nonce: i, gas_price: 1, gas_limit: 1, tx_type: 'Transfer' }, 1, 1000, i)!);
  assert.equal(insertTransactions(txs).values.length, 19);
  assert.equal(insertBlocks([shapeBlock({ height: 1, timestamp: 1, transactions: [] }).block]).values.length, 11);
});

// Stats deltas count only what the database reported as inserted, and a rollback is the exact negation.
test('stats delta follows inserted rows and negates cleanly', () => {
  const d = deltaOf(3, [
    { hash: 'h1', tx_type: 'Transfer', from_address: 'a', amount: '1', inserted: true },
    { hash: 'h2', tx_type: 'Transfer', from_address: 'a', amount: '1', inserted: false },
    { hash: 'h3', tx_type: 'RewardDistribution', from_address: 'system_emission', amount: '700', inserted: true },
  ], 12);
  assert.deepEqual({ ...d, emission_total: d.emission_total.toString() }, { tx_total: 2, blocks_total: 3, batch_transfers_total: 12, emission_total: '700', tx_by_type: { Transfer: 1, RewardDistribution: 1 } });
  const z = mergeDelta(d, negate(d));
  assert.equal(z.tx_total, 0);
  assert.equal(z.emission_total, 0n);
  assert.deepEqual(z.tx_by_type, { Transfer: 0, RewardDistribution: 0 });
});

// Header rows: an empty body keeps the node's fields; a pruned body is identity-only with the slot time.
test('header rows distinguish empty blocks from pruned bodies', () => {
  const genesis = 1_788_150_283_000;
  const empty = blockRowFromHeader({ height: 5, hash: 'c'.repeat(64), body: true, tx_count: 0, timestamp: 1_788_150_288, producer: 'p', previous_hash: 'd'.repeat(64), merkle_root: '0'.repeat(64) }, genesis);
  assert.equal(empty.body_indexed, true);
  assert.equal(empty.tx_count, 0);
  assert.equal(empty.timestamp, toMs(1_788_150_288));
  assert.equal(empty.previous_hash, 'd'.repeat(64));
  const pruned = blockRowFromHeader({ height: 5, hash: 'c'.repeat(64), body: false }, genesis);
  assert.equal(pruned.body_indexed, false);
  assert.equal(pruned.tx_count, null);
  assert.equal(pruned.timestamp, genesis + 5000);
  assert.equal(pruned.producer, 'unknown');
});

// Sorted heights collapse into inclusive ranges; duplicates and singletons are handled.
test('ranges', () => {
  assert.deepEqual(ranges([1, 2, 3, 7, 9, 10, 10]), [[1, 3], [7, 7], [9, 10]]);
  assert.deepEqual(ranges([]), []);
});

// No minority can inflate the agreed height and no lagging node can deflate it.
test('network height is the quorum-th highest answer', () => {
  assert.equal(pickNetworkHeight([100, 5000, 101, 99, 100], 3), 100, 'two liars at the top decide nothing');
  assert.equal(pickNetworkHeight([900, 900, 900, 100, 100], 3), 900, 'a quorum at the tip carries it');
  assert.equal(pickNetworkHeight([100, 3, 101], 2), 100);
  assert.equal(pickNetworkHeight([777], 3), 777, 'fewer answers than the quorum: the lowest of them');
  assert.equal(pickNetworkHeight([1e300, 42, Number.NaN, -1], 2), 42);
  assert.equal(pickNetworkHeight([], 3), -1);
  assert.ok(HEIGHT_SLACK > 0);
});

// The root the node commits to in every block header, reproduced from the transaction hashes alone.
test('the transaction merkle root reproduces the node rule', () => {
  const h1 = 'a2b16290a473d9a9d9de0ee3435a22744444ae535c37fa11312c75e1ffecbe87';
  // block 460800 on the live chain: one transaction, this root in its header.
  assert.equal(merkleRootOf([h1]), 'e62c87f34c8a586a20b1c5bbb95dc16102bbb8bb7eab5ae70c75b247938c11e6');
  assert.equal(merkleRootOf([]), 'a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a', 'an empty block commits to H("")');
  assert.equal(merkleRootOf([h1, h1]), merkleRootOf([h1, h1]));
  assert.notEqual(merkleRootOf([h1, h1]), merkleRootOf([h1]), 'the odd node is duplicated, not dropped');
  assert.equal(merkleRootOf(['nothex']), null);
});

// A body whose transactions do not rebuild the header's root is not that block's body.
test('a block body is bound to its merkle root', () => {
  const tx = (h: string) => ({ hash: h, from: 'q', to: 'w', amount: '1', nonce: 1, gas_price: '1', gas_limit: '1', signature: 'x', public_key: 'y', type: 'Transfer' });
  const real = 'a2b16290a473d9a9d9de0ee3435a22744444ae535c37fa11312c75e1ffecbe87';
  const root = merkleRootOf([real]) as string;
  const good = shapeBlock({ height: 7, hash: 'b'.repeat(64), timestamp: 1_788_150_290, merkle_root: root, transactions: [tx(real)] });
  assert.equal(merkleRootOf(good.txHashes), root, 'the served body rebuilds the header root');
  const forged = shapeBlock({ height: 7, hash: 'b'.repeat(64), timestamp: 1_788_150_290, merkle_root: root, transactions: [tx('c'.repeat(64))] });
  assert.notEqual(merkleRootOf(forged.txHashes), root, 'a substituted transaction set cannot');
  assert.deepEqual(good.txHashes, [real], 'the hashes are exposed in block order for the check');
});

// A NUL cannot reach a text or jsonb column: Postgres refuses it and the height would never commit.
test('text from a node is stored without NUL', () => {
  const tx = transformTransaction({
    hash: 'd'.repeat(64), from: 'q', to: 'w', amount: '1', nonce: 1, gas_price: '1', gas_limit: '1',
    signature: 'sig', public_key: 'pk', status: 'con\u0000firmed',
    tx_type: { BatchTransfers: { batch_id: 'b\u0000ad', transfers: [{ to: 'x', amount: '1' }] } },
  }, 5, 1_000, 0);
  assert.ok(tx);
  assert.equal(tx!.status, 'confirmed');
  assert.equal((tx!.tx_type_data as Record<string, unknown>).batch_id, 'bad');
  assert.ok(!JSON.stringify(tx).includes('\u0000'));
});

// A page repeating a height is taken once; flush groups respect both the block and the row bound.
test('header pages dedupe and split into bounded flush groups', () => {
  const hdr = (height: number, tx_count = 0, body = true) => ({ height, hash: 'a'.repeat(64), body, tx_count });
  assert.deepEqual(dedupeHeaders([hdr(3), hdr(1), hdr(3), hdr(2)]).map(h => h.height), [1, 2, 3]);
  const many = Array.from({ length: 450 }, (_, i) => hdr(i));
  assert.deepEqual(flushGroups(many).map(g => g.length), [FLUSH_BLOCKS, FLUSH_BLOCKS, 50]);
  const heavy = [hdr(1, 100), hdr(2, 100), hdr(3, 1), hdr(4, 0, false)];
  const groups = flushGroups(heavy);
  assert.deepEqual(groups.map(g => g.map(h => h.height)), [[1], [2, 3, 4]]);
  assert.ok(100 * 1000 * 2 > FLUSH_BATCH_ROWS);
  assert.deepEqual(flushGroups([]), []);
});

// Gas price × limit can reach 2^128 per transaction; the block total is clamped to its column.
test('block gas total never overflows its column', () => {
  const big = '9223372036854775807';
  const block = shapeBlock({ height: 9, hash: 'b'.repeat(64), timestamp: 1_788_150_292, transactions: [
    { hash: 'e'.repeat(64), from: 'q', to: 'w', amount: '1', nonce: 1, gas_price: big, gas_limit: big, signature: 'x', public_key: 'y', type: 'Transfer' },
    { hash: 'f'.repeat(64), from: 'q', to: 'w', amount: '1', nonce: 2, gas_price: big, gas_limit: big, signature: 'x', public_key: 'y', type: 'Transfer' },
  ] });
  assert.equal(block.block.total_gas_used, '9'.repeat(30));
  assert.equal(block.block.total_gas_used.length, 30);
});
