// The site's balance check (src/server/light): a balance counts as verified only when its proof folds to the state root
// of a macroblock whose committee certificate the site verified itself, walking up from the wallets' pin or from a GALC
// v2 capsule four genesis keys signed (galc.ts: the shared vectors, a capsule as a faster root that never replaces what
// the site verified, today's 405 falling back to the pin); the certified form (?mb=) first, the legacy live-root proof
// of an old node only when its root is a certified one; never node agreement, never an answer without a proof.
// Run: npm run test:wallet
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import {
  ATTACKER, CAPSULE_OPTIONS, GALC_V, IDS, NODES, TEST_GENESIS_KEYS, accountLeaf, addressKey, buildTree, capsuleAt, capsuleText, coBucket, core,
  network, pinAt, plainAccount, proofFor, read, sha3Hex, smtFold,
} from './light-helpers.mjs';
import {
  checkpointHash, checkpointQuorum, decodeEligibleNodeIds, epochCommitment, parseDilithiumSig, quorumSize, recomputeRegistryRoot,
  recomputeRegistryRootYielding, sampleCommittee,
} from '../../server/light/checkpoint.ts';
import {
  accountKey, accountLeafHash, storageKey, storageLeaf, verifyAbsence, verifyAbsenceInBucket, verifyInclusion,
} from '../../server/light/smt.ts';
import { parseStrictJson, u64Text } from '../../server/light/strict-json.ts';
import { LINEAGE_REFUSALS, createLightClient } from '../../server/light/lineage.ts';
import { createBalanceProver, isLegacyBody } from '../../server/light/balance-proof.ts';
import { GALC_V2_MINT_INTERVAL, NETWORK_ID, WS_CHECKPOINT } from '../../server/light/pin.ts';
import {
  CAPSULE_MISS_TTL_MS, CAPSULE_PATH, CAPSULE_ROOT_NODES, OWN_ROOT_WALK_STEPS, capsuleEtag, capsulePreimage, capsuleProblem, capsuleRootOf,
  capsuleSigned, capsuleSigners,
} from '../../server/light/galc.ts';
import { GENESIS_CONSENSUS_PKS } from '../../server/light/genesis-keys.ts';

const SRC = new URL('../../', import.meta.url);

// ------------------------------------------------------------------------------------------------ the checkpoint

test('the checkpoint hash is the node\'s, byte for byte (the Rust vectors of checkpoint_bft.rs)', () => {
  const KAT = {
    index: 4, parent_qc: { index: 3, checkpoint_hash: '02'.repeat(32) }, window_head_height: 120, window_mb_hashes: ['01'.repeat(32)],
    state_root: '03'.repeat(32), beacon: '04'.repeat(32), epoch_commitment: '05'.repeat(32), reward_root: '00'.repeat(32),
    registry_root: '00'.repeat(32), logs_root: '00'.repeat(32), dilithium_pk_root: '00'.repeat(32), reward_epoch_root: '00'.repeat(32),
    total_supply: 7, timestamp: 11, proposer: 'n1', recovery_anchor: null,
  };
  assert.equal(checkpointHash(KAT), '13fe6687b356572863ca25a3d0c225a30b904a03f5fed4a8574b22a80bf29be7');
  assert.equal(checkpointHash({ ...KAT, recovery_anchor: [2, '08'.repeat(32)] }), 'acc2f0a5102a91fc013b9e6f023ba77aa4843a2f056a2d97aa57ea1302993474');
  assert.equal(checkpointHash({ ...KAT, recovery_anchor: [0, '00'.repeat(32)] }), '8a463e680bb577b1ffb0569f2f4576bae6d23d7a1b2a92fa7e5e6c9428bf14f7');
  // A supply past 2^53 folds exactly from its decimal text.
  const big = { ...KAT, total_supply: '12000000000000000001' };
  assert.notEqual(checkpointHash(big), checkpointHash({ ...KAT, total_supply: '12000000000000000000' }));
  assert.equal(checkpointHash(big), core.checkpointHash(big));
});

test('the committee, registry and epoch checks agree with the wallets\' light client on every input', async () => {
  const ids = Array.from({ length: 1205 }, (_, i) => `node_${String(i).padStart(5, '0')}`);
  for (const [n, window, seed] of [[5, 7, 'aa'], [1000, 9, 'bb'], [1001, 10, 'cc'], [1205, 31999, 'dd']]) {
    const list = ids.slice(0, n).sort();
    assert.deepEqual(sampleCommittee(list, window, seed.repeat(32)), core.sampleCommittee(list, window, seed.repeat(32)), `${n}`);
  }
  for (const n of [0, 1, 3, 4, 5, 7, 100, 1000]) assert.equal(quorumSize(n), core.quorumSize(n));
  const cp = proofFor(30, 'ab'.repeat(32)).checkpoint;
  assert.equal(checkpointHash(cp), core.checkpointHash(cp));
  assert.equal(checkpointQuorum(cp, IDS), core.checkpointQuorum(cp, IDS));
  assert.equal(checkpointQuorum({ ...cp, recovery_anchor: [3, '00'.repeat(32)] }, IDS), null);
  const entries = IDS.map((id, i) => ({ node_id: id, wallet: `w${i}`, reg_height: String(90 * i), reg_index: i, node_type: i % 2 ? 'light' : 'super', burn: i ? `b${i}` : '', vrf_pk_sha3: i === 2 ? '' : sha3Hex(Buffer.from(id)) }));
  assert.equal(recomputeRegistryRoot(entries), core.recomputeRegistryRoot(entries));
  assert.equal(await recomputeRegistryRootYielding(entries), core.recomputeRegistryRoot(entries));
  const raw = Buffer.from(proofFor(30, 'ab'.repeat(32)).eligible_raw, 'hex');
  assert.deepEqual(decodeEligibleNodeIds(raw), core.decodeEligibleNodeIds(raw));
  assert.deepEqual(decodeEligibleNodeIds(raw.subarray(0, raw.length - 1)), []);
  assert.equal(epochCommitment(raw, IDS, ['x', 'a']), core.epochCommitment(raw, IDS, ['x', 'a']));
  const sig = proofFor(30, 'ab'.repeat(32)).qc.sigs[0];
  assert.equal(parseDilithiumSig(sig), core.parseDilithiumSig(sig));
  for (const bad of ['', 'dilithium_sig_', 'dilithium_sig_x_AAAA', 42]) assert.equal(parseDilithiumSig(bad), null);
});

test('the site walks from the wallets\' release pin, or from one proven from it or from the pin it was proven from', () => {
  const marked = (text) => /\/\/ <ws-pin>[\s\S]*?\/\/ <\/ws-pin>/.exec(text)[0];
  const site = marked(read('applications/qnet-explorer/frontend/src/server/light/pin.ts'));
  const app = marked(read('applications/qnet-mobile/src/config/genesisConsensus.js'));
  // Either refreshes its pin on its own (scripts/light-pin.mjs --write-pin here, the app's scripts/ws-pin.js there):
  // one lineage means the same block, one pin naming the other as the pin it was proven from, or both naming one pin.
  const pinOf = (block) => ({
    at: `${/^\s*index: (\d+),$/m.exec(block)[1]}:${/^\s*hash: '([0-9a-f]{64})',$/m.exec(block)[1]}`,
    from: (/^\s*provenFrom: \{ index: (\d+), hash: '([0-9a-f]{64})' \},$/m.exec(block) ?? []).slice(1).join(':') || null,
  });
  const [s, a] = [pinOf(site), pinOf(app)];
  assert.ok(site === app || s.at === a.at || s.from === a.at || a.from === s.at || (s.from !== null && s.from === a.from), `site ${JSON.stringify(s)}, app ${JSON.stringify(a)}`);
  // The same macroblock: the same committee anchors of K and K-1.
  const anchorsOf = (block) => [...block.matchAll(/^\s*(\d+): \{\r?\n\s*eligible_raw: '([0-9a-f]+)',\r?\n\s*beacon: '([0-9a-f]{64})',\r?\n\s*registry_root: '([0-9a-f]{64})',/gm)]
    .map((m) => m.slice(1).join('|'));
  assert.equal(anchorsOf(site).length, 2);
  if (s.at === a.at) assert.deepEqual(anchorsOf(app), anchorsOf(site));
  // One chain: block 0's hash and the capsule cadence, as the app's block has them, in the same lines.
  const tail = (block) => block.slice(block.indexOf('\n};\n') + 3);
  assert.equal(tail(site), tail(app));
  assert.match(site, /\nexport const NETWORK_ID = '([0-9a-f]{64})';\n/);
  assert.equal(NETWORK_ID, /export const NETWORK_ID = '([0-9a-f]{64})';/.exec(app)[1]);
  assert.equal(GALC_V2_MINT_INTERVAL, Number(/export const GALC_V2_MINT_INTERVAL = (\d+);/.exec(app)[1]));
  assert.equal(pinOf(site).at, `${WS_CHECKPOINT.index}:${WS_CHECKPOINT.hash}`);
  assert.ok(WS_CHECKPOINT.index > 2);
  assert.ok(createLightClient({ nodes: () => NODES, fetchText: async () => { throw new Error('no network'); } }).trustFloorIndex() === WS_CHECKPOINT.index + 1);
});

// ------------------------------------------------------------------------------------------------ the state tree

const ADDR = 'f00dbabe00f00dbabe0eonf00dbabe00f00dbabe0012345678';
function world() {
  const accounts = Array.from({ length: 40 }, (_, i) => [`acct_${i}_eon_${'x'.repeat(30)}`, plainAccount({ balance: String(1000 + i), nonce: String(i % 5) })]);
  const mine = plainAccount({ balance: '18000000000000000000', nonce: '7', heartbeat_epoch: '12', heartbeat_slots: 0x1ff, heartbeat_final_epoch: '11',
    heartbeat_final_slots: 3, last_claimed_epoch: '10', banned_at_height: '0', is_node: true });
  const contract = plainAccount({ balance: '5', is_contract: true, contract_code_hash: 'c0de'.repeat(16), storage_root: 'ee'.repeat(32) });
  accounts.push([ADDR, mine], ['contract_eon_' + 'y'.repeat(30), contract]);
  const entries = accounts.map(([a, f]) => ({ key: addressKey(a), leaf: accountLeaf(a, f) }));
  // A raw key in the bucket of an address no account holds: its absence is proven with the bucket's entries.
  const crowded = 'crowded_eon_' + 'z'.repeat(30);
  entries.push({ key: coBucket(addressKey(crowded)), leaf: 'cd'.repeat(32) });
  return { accounts: new Map(accounts), tree: buildTree(entries), crowded };
}
const W = world();
const fieldsOf = (f) => ({ balance: f.balance, nonce: f.nonce, isContract: f.is_contract, contractCodeHash: f.contract_code_hash, storageRoot: f.storage_root,
  heartbeatEpoch: f.heartbeat_epoch, heartbeatSlots: f.heartbeat_slots, heartbeatFinalEpoch: f.heartbeat_final_epoch, heartbeatFinalSlots: f.heartbeat_final_slots,
  lastClaimedEpoch: f.last_claimed_epoch, bannedAtHeight: f.banned_at_height, isNode: f.is_node });

test('the account leaf hashes every field the node hashes: a plain one as the wallets build it, a contract with its code and storage root', () => {
  for (const [address, f] of W.accounts) assert.equal(accountLeafHash(address, fieldsOf(f)), accountLeaf(address, f), address);
  assert.equal(accountKey(ADDR), addressKey(ADDR));
  const plain = plainAccount({ balance: '77', nonce: '3', last_claimed_epoch: '4', is_node: true });
  assert.equal(accountLeafHash(ADDR, fieldsOf(plain)), core.accountLeafHash({ address: ADDR, balance: '77', nonce: '3', lastClaimedEpoch: '4', isNode: true }));
  // Some("") is a code hash too; a contract without a storage root, or a value out of range, is refused.
  assert.notEqual(accountLeafHash(ADDR, fieldsOf({ ...plain, contract_code_hash: '' })), accountLeafHash(ADDR, fieldsOf(plain)));
  assert.throws(() => accountLeafHash(ADDR, fieldsOf({ ...plain, is_contract: true })));
  assert.throws(() => accountLeafHash(ADDR, fieldsOf({ ...plain, balance: '18446744073709551616' })));
  assert.throws(() => accountLeafHash(ADDR, fieldsOf({ ...plain, heartbeat_slots: 65536 })));
});

test('inclusion and absence fold as the wallets\' fold does; absence in a shared bucket needs every entry, sorted, in the bucket', () => {
  const { tree } = W;
  for (const [address, f] of W.accounts) {
    const p = tree.prove(addressKey(address));
    assert.equal(p.kind, 'inclusion');
    assert.equal(smtFold(p.leaf, addressKey(address), p.steps, tree.root, sha3Hex), true, 'the fixture tree is the wallets\' tree');
    assert.equal(verifyInclusion(addressKey(address), accountLeaf(address, f), p.steps, tree.root), true, address);
    assert.equal(verifyInclusion(addressKey(address), accountLeaf(address, { ...f, balance: '1' }), p.steps, tree.root), false);
  }
  const unknown = addressKey('nobody_eon_' + 'q'.repeat(30));
  const abs = tree.prove(unknown);
  assert.equal(abs.kind, 'absence');
  assert.equal(smtFold('0'.repeat(64), unknown, abs.steps, tree.root, sha3Hex), true);
  assert.equal(verifyAbsence(unknown, abs.steps, tree.root), true);
  assert.equal(verifyAbsence(unknown, [...abs.steps, abs.steps[0]], tree.root), false, '41 steps');
  assert.equal(verifyInclusion(unknown, '0'.repeat(64), abs.steps, tree.root), false, 'a zero inclusion leaf');
  const flipped = abs.steps.map((s, i) => (i === 39 ? { ...s, is_right: !s.is_right } : s));
  assert.equal(verifyAbsence(unknown, flipped, tree.root), false, 'a flag that is not the key\'s bit');

  const key = addressKey(W.crowded);
  const aib = tree.prove(key);
  assert.equal(aib.kind, 'absence_in_bucket');
  assert.equal(verifyAbsenceInBucket(key, aib.entries, aib.steps, tree.root), true);
  assert.equal(verifyAbsence(key, aib.steps, tree.root), false, 'plain absence over a crowded bucket');
  const e = aib.entries;
  const extra = { key: coBucket(key, 2), leaf: 'ef'.repeat(32) };
  for (const [why, entries, steps] of [
    ['the key among the entries', [...e, { key, leaf: '01'.repeat(32) }].sort((a, b) => (a.key < b.key ? -1 : 1)), aib.steps],
    ['unsorted', [extra, ...e], aib.steps],
    ['an entry outside the bucket', [{ key: `8${e[0].key.slice(1)}`, leaf: e[0].leaf }], aib.steps],
    ['a dropped entry', [], aib.steps],
    ['a zero leaf', e.map((x) => ({ ...x, leaf: '0'.repeat(64) })), aib.steps],
    ['65 entries', Array.from({ length: 65 }, (_, i) => ({ key: key.slice(0, 60) + (0x1000 + i).toString(16).slice(-4), leaf: 'ab'.repeat(32) })), aib.steps],
    ['39 steps', e, aib.steps.slice(1)],
    ['41 steps', e, [...aib.steps, aib.steps[0]]],
    ['a foreign entry added', [...e, extra].sort((a, b) => (a.key < b.key ? -1 : 1)), aib.steps],
  ]) assert.equal(verifyAbsenceInBucket(key, entries, steps, tree.root), false, why);
});

test('the leaves, the root and the three proof kinds give the node\'s golden vectors (tree_proof.rs golden_vectors_for_clients)', () => {
  const golden = Object.fromEntries([.../const GOLDEN: \[\(&str, &str\); \d+\] = \[([\s\S]*?)\];/.exec(read('core/qnet-state/src/tree_proof.rs'))[1]
    .matchAll(/\("(\w+)", "([0-9a-f]{64})"\)/g)].map((m) => [m[1], m[2]]));
  assert.equal(Object.keys(golden).length, 8);
  const plain = 'eon_golden_plain';
  const plainLeaf = accountLeafHash(plain, fieldsOf(plainAccount({ balance: '5000000000', nonce: '3', heartbeat_epoch: '12', heartbeat_slots: 0x1ff,
    last_claimed_epoch: '10' })));
  const storage = buildTree([{ key: storageKey(`balance:${plain}`), leaf: storageLeaf('250') }, { key: storageKey('total_supply'), leaf: storageLeaf('1000') }]);
  const contractLeaf = accountLeafHash('eon_golden_contract', fieldsOf(plainAccount({ is_contract: true, contract_code_hash: 'c0de'.repeat(16),
    storage_root: storage.root })));
  const tree = buildTree([{ key: accountKey(plain), leaf: plainLeaf }, { key: accountKey('eon_golden_contract'), leaf: contractLeaf }]);
  const digest = (steps) => sha3Hex(Buffer.concat(steps.flatMap((s) => [Buffer.from(s.sibling, 'hex'), Buffer.from([s.is_right ? 1 : 0])])));
  const absent = accountKey('eon_golden_absent');
  const shared = coBucket(accountKey(plain));
  const [inc, abs, aib] = [tree.prove(accountKey(plain)), tree.prove(absent), tree.prove(shared)];
  assert.deepEqual([inc.kind, abs.kind, aib.kind], ['inclusion', 'absence', 'absence_in_bucket']);
  assert.deepEqual({
    plain_leaf: plainLeaf,
    plain_bucket_leaf: sha3Hex(Buffer.concat([Buffer.from([0xb5]), Buffer.from(accountKey(plain), 'hex'), Buffer.from(plainLeaf, 'hex')])),
    contract_leaf: contractLeaf, storage_leaf: storageLeaf('250'), root: tree.root,
    inclusion_steps: digest(inc.steps), absence_steps: digest(abs.steps), absence_in_bucket_steps: digest(aib.steps),
  }, golden);
  assert.equal(verifyInclusion(accountKey(plain), plainLeaf, inc.steps, golden.root), true);
  assert.equal(verifyAbsence(absent, abs.steps, golden.root), true);
  assert.equal(verifyAbsenceInBucket(shared, aib.entries, aib.steps, golden.root), true);
});

test('the strict reader refuses a repeated key and keeps a u64 exact', () => {
  assert.throws(() => parseStrictJson('{"balance":"1","balance":"2"}'));
  assert.throws(() => parseStrictJson('{"a":{"b":1,"b":2}}'));
  assert.deepEqual(parseStrictJson('{"n":18446744073709551615,"s":9007199254740991}'), { n: '18446744073709551615', s: 9007199254740991 });
  assert.throws(() => parseStrictJson('{"a":1} x'));
  assert.equal(u64Text('18446744073709551616'), null);
  assert.equal(u64Text('01'), null);
  assert.equal(u64Text(-1), null);
});

// ------------------------------------------------------------------------------------------------ the light client

const K = 100;
const TOP = 112;
const ROOT = W.tree.root;
const rootOf = () => ROOT;
const light = (net, extra = {}) => createLightClient({ nodes: () => NODES, fetchText: net.fetchText, pin: pinAt(K), ...extra });
const proofRequests = (net) => net.asked.filter(([, p]) => /\/macroblock\/\d+\/proof$/.test(p)).map(([, p]) => Number(/(\d+)\/proof$/.exec(p)[1]));

test('the walk starts at the pin, verifies each certificate and hands out the certified root', async () => {
  const net = network({ nodes: NODES, top: TOP, stateRootOf: rootOf });
  const lc = light(net);
  assert.deepEqual(await lc.certifiedRootAt(K, 1000), { unprovable: 'below_floor' }, 'the pin carries no state root');
  assert.deepEqual(await lc.certifiedRootAt(TOP, 20_000), { root: ROOT });
  assert.deepEqual([...new Set(proofRequests(net))].sort((a, b) => a - b), [102, 104, 106, 108, 110, 112]);
  assert.equal(lc.highestVerifiedIndex(), TOP);
  assert.deepEqual(await lc.certifiedRootAt(TOP - 1, 20_000), { root: ROOT });
  assert.equal(await lc.certifiedHead(), TOP);
});

test('a forged checkpoint, an attacker\'s keys, a recovery anchor or garbage is that node\'s failure; the next node serves the step', async () => {
  const forged = (path, honest) => {
    const m = /\/macroblock\/(\d+)\/proof$/.exec(path);
    if (!m) return honest(path);
    const j = Number(m[1]);
    if (j === 104) return { body: proofFor(j, ROOT, { edit: (p) => { p.checkpoint.state_root = 'ff'.repeat(32); } }) };
    if (j === 106) return { body: proofFor(j, 'ff'.repeat(32), { signWith: ATTACKER }) };
    if (j === 108) return { body: proofFor(j, 'ff'.repeat(32), { anchor: [5, 'aa'.repeat(32)] }) };
    if (j === 110) return { status: 200, text: '{"index":110,"checkpoint":', retryAfterS: null };
    return honest(path);
  };
  const handlers = Object.fromEntries(NODES.map((n) => [n, forged]));
  handlers[NODES[3]] = undefined;
  const net = network({ nodes: NODES, top: TOP, stateRootOf: rootOf, handlers });
  const lc = light(net);
  assert.deepEqual(await lc.certifiedRootAt(110, 30_000), { root: ROOT });
  // Only the one honest node could serve the forged steps.
  for (const j of [104, 106, 108, 110]) {
    const servedBy = net.asked.filter(([, p]) => p === `/api/v1/macroblock/${j}/proof`).map(([b]) => b);
    assert.ok(servedBy.includes(NODES[3]), `${j}`);
  }
  // With no honest node at all, nothing counts.
  const allBad = network({ nodes: NODES, top: TOP, stateRootOf: rootOf, handlers: Object.fromEntries(NODES.map((n) => [n, forged])) });
  assert.deepEqual(await light(allBad).certifiedRootAt(104, 30_000), { unprovable: 'unavailable' });
});

test('"not found" for the target passes to the next node; three of them end the step as not certified yet', async () => {
  const lying = (path, honest) => (path.endsWith('/macroblock/112/proof') ? { body: { error: 'macroblock_not_found' } } : honest(path));
  const one = network({ nodes: NODES, top: TOP, stateRootOf: rootOf, handlers: { [NODES[112 % 5]]: lying } });
  assert.deepEqual(await light(one).certifiedRootAt(112, 20_000), { root: ROOT });
  const net = network({ nodes: NODES, top: 110, stateRootOf: rootOf });
  assert.deepEqual(await light(net).certifiedRootAt(112, 20_000), { unprovable: 'not_certified' });
  assert.equal(net.asked.filter(([, p]) => p.endsWith('/macroblock/112/proof')).length, 3);
});

test('a walk past the head, or a registry no node could serve, holds no node against the macroblock it stopped at', async () => {
  // A node names an index far ahead: the walk stops at the first macroblock not certified yet, and once it is
  // certified the next request verifies it at once instead of finding every node marked failed for it.
  let sealed = false;
  const unsealed = (path, honest) => {
    const m = /\/macroblock\/(\d+)\/proof$/.exec(path);
    return m && !sealed && Number(m[1]) >= TOP ? { body: { error: 'macroblock_not_found' } } : honest(path);
  };
  const ahead = network({ nodes: NODES, top: TOP + 20, stateRootOf: rootOf, handlers: Object.fromEntries(NODES.map((n) => [n, unsealed])) });
  const lc = light(ahead);
  assert.deepEqual(await lc.certifiedRootAt(TOP + 8, 20_000), { unprovable: 'not_certified' });
  assert.equal(lc.highestVerifiedIndex(), TOP - 2);
  sealed = true;
  assert.deepEqual(await lc.certifiedRootAt(TOP, 20_000), { root: ROOT });
  // The registry snapshot could not be had: pending, and served as soon as it can be.
  let registryDown = true;
  const reg = network({ nodes: NODES, top: TOP, stateRootOf: rootOf, handlers: Object.fromEntries(NODES.map((n) => [n, (path, honest) =>
    (registryDown && path.startsWith('/api/v1/registry/') ? 'throw' : honest(path))])) });
  const lr = light(reg);
  assert.deepEqual(await lr.certifiedRootAt(104, 20_000), { pending: true });
  registryDown = false;
  assert.deepEqual(await lr.certifiedRootAt(104, 20_000), { root: ROOT });
});

test('a node\'s rate limit is left alone for the time it asks, never charged; a walk not done in time is pending, then verified', async () => {
  let slow = true;
  const handlers = Object.fromEntries(NODES.map((n, i) => [n, async (path, honest) => {
    if (i < 2 && path.includes('/macroblock/')) return { body: { error: 'Rate limit exceeded', retry_after_seconds: 30 } };
    if (slow && path.endsWith('/macroblock/106/proof')) await new Promise((r) => setTimeout(r, 400));
    return honest(path);
  }]));
  const net = network({ nodes: NODES, top: TOP, stateRootOf: rootOf, handlers });
  const lc = light(net);
  assert.deepEqual(await lc.certifiedRootAt(110, 50), { pending: true });
  slow = false;
  assert.deepEqual(await lc.certifiedRootAt(110, 20_000), { root: ROOT });
  const limitedAsks = net.asked.filter(([b, p]) => (b === NODES[0] || b === NODES[1]) && p.includes('/macroblock/')).length;
  assert.ok(limitedAsks <= 2, `a rate-limited node is not asked again while it waits (${limitedAsks})`);
});

test('the certified head is the second highest node answer; old nodes give their applied tip\'s macroblock instead', async () => {
  const head = (values) => Object.fromEntries(NODES.map((n, i) => [n, (path, honest) => (path === '/api/v1/state/certified'
    ? (values[i] === null ? { status: 404, body: { error: 'x' } } : { body: { proof_format: 2, newest_certified_index: values[i] } }) : honest(path))]));
  // One liar cannot raise it, nor lower it.
  assert.equal(await light(network({ nodes: NODES, top: TOP, stateRootOf: rootOf, handlers: head([TOP, TOP, TOP, 9999, TOP]) })).certifiedHead(), TOP);
  assert.equal(await light(network({ nodes: NODES, top: TOP, stateRootOf: rootOf, handlers: head([TOP, 1, TOP, TOP, TOP]) })).certifiedHead(), TOP);
  // Fewer than three certified answers: the legacy heights, second highest of at least two.
  const old = network({ nodes: NODES, top: TOP, stateRootOf: rootOf, legacyHeads: true });
  assert.equal(await light(old).certifiedHead(), Math.floor((TOP * 90 + 60) / 90));
  // Two heights only: one of them could lower the head, so there is none.
  const two = network({ nodes: NODES, top: TOP, stateRootOf: rootOf, legacyHeads: true, handlers: Object.fromEntries(NODES.map((n, i) => [n, (path, honest) =>
    (path === '/api/v1/height' ? (i < 3 ? 'throw' : { body: { height: i === 3 ? 90 * (K + 1) : TOP * 90 + 60 } }) : honest(path))])) });
  assert.equal(await light(two).certifiedHead(), null);
  const none = network({ nodes: NODES, top: TOP, stateRootOf: rootOf, handlers: Object.fromEntries(NODES.map((n) => [n, () => 'throw'])) });
  assert.equal(await light(none).certifiedHead(), null);
});

// ------------------------------------------------------------------------------------------------ GALC v2 capsules

const testVerify = (message, sigHex, pkHex) => {
  try {
    return ml_dsa65.verify(Buffer.from(sigHex, 'hex'), new TextEncoder().encode(message), Buffer.from(pkHex, 'hex'));
  } catch {
    return false;
  }
};
const wireOf = (c) => ({ ...c, sigs: c.sigs.map(([id, name]) => [id, GALC_V.signatures[name]]) });
// The vectors' K (38960) sits above the pin the release pin was proven from (38944) and below the release pin itself, which
// refuses it as below_pin: the vector tests judge it against a pin at that older index.
const VECTOR_PIN = pinAt(WS_CHECKPOINT.provenFrom.index);
const VECTOR_RULES = { networkId: GALC_V.networkId, interval: GALC_V.constants.mintInterval, pinIndex: VECTOR_PIN.index, keys: TEST_GENESIS_KEYS };

test('the genesis keys are the node\'s and the wallets\', byte for byte', () => {
  const app = Object.fromEntries([.../export const GENESIS_CONSENSUS_PKS = \{([\s\S]*?)\};/.exec(read('applications/qnet-mobile/src/config/genesisConsensus.js'))[1]
    .matchAll(/(genesis_node_\d{3}): '([0-9a-f]+)'/g)].map((m) => [m[1], m[2]]));
  const node = Object.fromEntries([.../pub const GENESIS_CONSENSUS_PKS: &\[\(&str, &str\)\] = &\[([\s\S]*?)\];/.exec(read('development/qnet-integration/src/genesis_constants.rs'))[1]
    .matchAll(/\("(genesis_node_\d{3})", "([0-9a-f]+)"\)/g)].map((m) => [m[1], m[2]]));
  assert.equal(Object.keys(GENESIS_CONSENSUS_PKS).length, 5);
  assert.deepEqual({ ...GENESIS_CONSENSUS_PKS }, app);
  assert.deepEqual({ ...GENESIS_CONSENSUS_PKS }, node);
  for (const pk of Object.values(GENESIS_CONSENSUS_PKS)) assert.equal(pk.length, 1952 * 2);
});

test('the shared vectors: the preimage, the hashes, and every capsule accepted or refused for the reason the spec names', async () => {
  assert.match(GALC_V.testKeys, /^TEST KEYS\./);
  for (const k of GALC_V.keys) assert.ok(!Object.values(GENESIS_CONSENSUS_PKS).includes(k.publicKey), `${k.id} is a test key`);
  for (const { fields, preimage } of GALC_V.preimages) {
    assert.equal(capsulePreimage(fields), preimage);
    assert.equal(capsuleText(fields), preimage);
  }
  for (const j of Object.keys(GALC_V.roots)) {
    const root = GALC_V.roots[j];
    assert.equal(checkpointHash(root.checkpoint), GALC_V.checkpointHashes[j]);
    assert.equal(epochCommitment(Buffer.from(root.eligible_raw, 'hex'), root.committee, root.banned), GALC_V.epochCommitments[j]);
  }
  assert.deepEqual(wireOf(GALC_V.cases[0].capsule), GALC_V.capsule);
  const judge = async (c, headHint, roots) => {
    const problem = capsuleProblem(c, VECTOR_RULES, headHint);
    if (problem) return problem;
    if (!(await capsuleSigned(c, TEST_GENESIS_KEYS, testVerify))) return 'signatures';
    for (const [j, cpHash] of [[c.mb_index, c.cp_hash_anchor], [c.mb_index - 1, c.cp_hash_pred]]) {
      const r = capsuleRootOf(j, roots[j], cpHash);
      if ('problem' in r) return r.problem;
    }
    return 'accepted';
  };
  assert.equal(GALC_V.cases.length, 23);
  for (const c of GALC_V.cases) assert.equal(await judge(wireOf(c.capsule), c.headHint, c.roots ?? GALC_V.roots), c.expect, c.name);
  // The refusals of the cheap checks the vectors leave out: the pin, and anything not a capsule.
  assert.equal(capsuleProblem(GALC_V.capsule, { ...VECTOR_RULES, pinIndex: GALC_V.capsule.mb_index }, null), 'below_pin');
  assert.equal(capsuleProblem(GALC_V.capsule, { ...VECTOR_RULES, pinIndex: WS_CHECKPOINT.index }, null), 'below_pin');
  for (const bad of [null, [], 'x', 7]) assert.equal(capsuleProblem(bad, VECTOR_RULES, null), 'shape');
  assert.equal(capsuleProblem({ ...GALC_V.capsule, sigs: [...GALC_V.capsule.sigs.slice(0, 3), ['genesis_node_005', 5]] }, VECTOR_RULES, null), 'shape');
  // Five valid signatures stop at the quorum; a signature over the right preimage by the wrong key counts for no one.
  assert.deepEqual((await capsuleSigners(GALC_V.capsule, TEST_GENESIS_KEYS, testVerify)).length, 4);
  assert.equal(await capsuleSigned(GALC_V.capsule, GENESIS_CONSENSUS_PKS, testVerify), false, 'the embedded keys sign no test capsule');
  assert.equal(capsuleEtag(38960, GALC_V.capsule.cp_hash_anchor), `"2-38960-${GALC_V.capsule.cp_hash_anchor.slice(0, 8)}"`);
});

// Scripted nodes serving the vectors' capsule above VECTOR_PIN (38944), with the vectors' proofs of K and K-1.
function vectorNetwork(capsuleBody, roots = GALC_V.roots, head = GALC_V.headHint) {
  const proofs = Object.fromEntries(Object.entries(roots).map(([j, r]) => [`/api/v1/macroblock/${j}/proof`, r]));
  const handler = (path, honest) => {
    if (path === CAPSULE_PATH) return { body: capsuleBody };
    if (proofs[path]) return { body: proofs[path] };
    if (path === '/api/v1/state/certified') return { body: { proof_format: 2, newest_certified_index: head } };
    return honest(path);
  };
  return network({ nodes: NODES, top: head, stateRootOf: () => 'ab'.repeat(32), handlers: Object.fromEntries(NODES.map((n) => [n, handler])) });
}
const vectorClient = (net, extra = {}) => createLightClient({
  nodes: () => NODES, fetchText: net.fetchText, pin: VECTOR_PIN, ...CAPSULE_OPTIONS, verifySignature: testVerify, ...extra,
});

test('a capsule the vectors accept roots K and K-1 above the pin: their roots answer, the trust floor stays at the pin', async () => {
  const net = vectorNetwork(GALC_V.capsule);
  const lc = vectorClient(net);
  // Its own walk from the pin is 10 steps at most: no capsule is asked for unless forced.
  assert.deepEqual(await lc.refreshCapsule(), { ok: false, reason: 'not_needed' });
  assert.equal(net.asked.filter(([, p]) => p === CAPSULE_PATH).length, 0);
  assert.deepEqual(await lc.refreshCapsule({ force: true }), { ok: true, index: 38960 });
  assert.equal(lc.heldCapsuleIndex(), 38960);
  assert.equal(net.asked.filter(([, p]) => p === CAPSULE_PATH).length, CAPSULE_ROOT_NODES, 'two nodes asked at once');
  // Each root confirmed by two nodes.
  for (const j of [38960, 38959]) assert.equal(net.asked.filter(([, p]) => p === `/api/v1/macroblock/${j}/proof`).length, 2, `${j}`);
  for (const j of [38960, 38959]) {
    assert.deepEqual(await lc.certifiedRootAt(j, 1000), { root: GALC_V.roots[j].checkpoint.state_root });
    assert.equal(lc.verifiedCheckpoint(j).checkpointHash, GALC_V.checkpointHashes[j]);
  }
  assert.equal(lc.highestVerifiedIndex(), 38960);
  assert.equal(lc.highestVerifiedIndex(1), 38959);
  assert.equal(lc.trustFloorIndex(), VECTOR_PIN.index + 1);
  // Held: the same capsule again is no newer (and no request is made while no newer one can exist).
  const before = net.asked.length;
  assert.deepEqual(await lc.refreshCapsule({ force: true }), { ok: false, reason: 'current' });
  assert.equal(net.asked.length, before);
});

test('refused capsules are no root and blame no node: the network, the head, the signatures, the roots, a lineage verified here', async () => {
  const caseNamed = (name) => GALC_V.cases.find((c) => c.name === name);
  const refusedFor = async (name, reason) => {
    const c = caseNamed(name);
    const lc = vectorClient(vectorNetwork(wireOf(c.capsule), c.roots ?? GALC_V.roots));
    assert.deepEqual(await lc.refreshCapsule({ force: true }), { ok: false, reason }, name);
    assert.equal(lc.heldCapsuleIndex(), 0, name);
  };
  await refusedFor('another network', 'invalid');
  await refusedFor('K not a multiple of the interval', 'invalid');
  await refusedFor('a signer that is no genesis node', 'invalid');
  await refusedFor('the id in the signature string differs from the listed one', 'invalid');
  // Two nodes whose proofs of K hash to another checkpoint than the signed one: a conflict, the capsule dropped.
  await refusedFor('the proof of K hashes to another checkpoint', 'conflict');
  await refusedFor('the signed checkpoint of K carries a recovery anchor', 'invalid');
  // Proofs that do not bind (another eligible set): unrooted for now.
  await refusedFor('the eligible set of K-1 does not match its epoch commitment', 'unrooted');
  // K more than two above the head the nodes report.
  const high = vectorClient(vectorNetwork(GALC_V.capsule, GALC_V.roots, GALC_V.capsule.mb_index - 3));
  assert.deepEqual(await high.refreshCapsule({ force: true }), { ok: false, reason: 'invalid' });
  // The embedded keys sign no test capsule: the site's own rules refuse the vectors.
  const real = createLightClient({ nodes: () => NODES, fetchText: vectorNetwork(GALC_V.capsule).fetchText, pin: VECTOR_PIN, networkId: GALC_V.networkId, capsuleInterval: 10 });
  assert.deepEqual(await real.refreshCapsule({ force: true }), { ok: false, reason: 'invalid' });
});

// The synthetic chain (light-helpers.mjs) rooted at pinAt(K = 100), its proofs signed by its committee; a capsule of it at
// KC, signed by the vectors' test genesis keys.
const KC = 140;
const CAP_TOP = KC + 11;
function capsuleNet({ top = CAP_TOP, capsule = capsuleAt(KC, rootOf), handlers = {} } = {}) {
  const serve = (path, honest, headers) => {
    if (path === CAPSULE_PATH) return typeof capsule === 'function' ? capsule(headers) : { body: capsule };
    return honest(path);
  };
  const all = Object.fromEntries(NODES.map((n) => [n, handlers[n] ? (path, honest, headers) => handlers[n](path, (p) => serve(p, honest, headers), headers) : serve]));
  return network({ nodes: NODES, top, stateRootOf: rootOf, handlers: all });
}
const capsuleLight = (net, extra = {}) => light(net, { ...CAPSULE_OPTIONS, ...extra });

test('from a capsule the walk to the head takes at most ceil(interval / 2) + 1 steps a parity, and every step is verified', async () => {
  const net = capsuleNet();
  const lc = capsuleLight(net);
  assert.ok((CAP_TOP - (K - 1)) / 2 > OWN_ROOT_WALK_STEPS, 'the walk from the pin is long');
  assert.deepEqual(await lc.refreshCapsule(), { ok: true, index: KC });
  const confirming = new Set(proofRequests(net));
  assert.deepEqual([...confirming].sort((a, b) => a - b), [KC - 1, KC]);
  assert.deepEqual(await lc.certifiedRootAt(CAP_TOP, 20_000), { root: ROOT });
  assert.deepEqual(await lc.certifiedRootAt(CAP_TOP - 1, 20_000), { root: ROOT });
  const steps = [...new Set(proofRequests(net))].filter((j) => !confirming.has(j)).sort((a, b) => a - b);
  assert.deepEqual(steps, [141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151]);
  assert.ok(steps.filter((j) => j % 2 === 1).length <= Math.ceil(GALC_V.constants.mintInterval / 2) + 1);
  // Below K the walk still goes from the pin, as before: the trust floor stays at the pin.
  assert.equal(lc.trustFloorIndex(), K + 1);
  assert.deepEqual(await lc.certifiedRootAt(K + 4, 20_000), { root: ROOT });
  assert.ok(proofRequests(net).includes(K + 2), 'walked up from the pin');
});

test('a long walk from the pin jumps to a capsule held while it runs, and goes on from its root', async () => {
  // Slow proofs below the capsule: the walk from the pin is still low when the capsule is rooted.
  const slow = (path, honest) => (/\/macroblock\/1[0-2]\d\/proof$/.test(path) ? new Promise((r) => setTimeout(() => r(honest(path)), 60)) : honest(path));
  const net = capsuleNet({ handlers: Object.fromEntries(NODES.map((n) => [n, slow])) });
  const lc = capsuleLight(net);
  const walking = lc.certifiedRootAt(CAP_TOP, 30_000);
  assert.deepEqual(await lc.refreshCapsule(), { ok: true, index: KC });
  assert.deepEqual(await walking, { root: ROOT });
  const asked = new Set(proofRequests(net));
  assert.ok(asked.has(K + 1), 'it started from the pin');
  assert.ok(!asked.has(KC - 3) && !asked.has(KC - 5), 'and did not walk on to the capsule\'s root');
  for (const j of [141, 143, 145, 147, 149, 151]) assert.ok(asked.has(j), `${j}`);
});

test('nodes of today answer 405: the walk is the pin\'s, each node probed once per ten minutes, never more', async () => {
  let t = 5_000_000;
  const net = network({ nodes: NODES, top: CAP_TOP, stateRootOf: rootOf });
  const lc = light(net, { ...CAPSULE_OPTIONS, now: () => t });
  const probes = () => net.asked.filter(([, p]) => p === CAPSULE_PATH).map(([b]) => b);
  assert.deepEqual(await lc.refreshCapsule(), { ok: false, reason: 'no_capsule' });
  assert.deepEqual(probes(), NODES.slice(0, 2));
  assert.deepEqual(await lc.refreshCapsule(), { ok: false, reason: 'no_capsule' });
  assert.deepEqual(await lc.refreshCapsule(), { ok: false, reason: 'no_capsule' });
  assert.deepEqual(await lc.refreshCapsule(), { ok: false, reason: 'no_capsule' });
  assert.deepEqual(probes().sort(), [...NODES].sort(), 'each node once');
  t += CAPSULE_MISS_TTL_MS;
  await lc.refreshCapsule();
  assert.equal(probes().length, NODES.length + 2, 'asked again after the TTL');
  assert.equal(lc.heldCapsuleIndex(), 0);
  assert.deepEqual(await lc.certifiedRootAt(CAP_TOP, 20_000), { root: ROOT });
  assert.ok(proofRequests(net).includes(K + 1), 'walked up from the pin');
  // A 404 is the same: no capsule on that node yet.
  const none = capsuleLight(capsuleNet({ capsule: () => ({ status: 404, body: { error: 'no_capsule' } }) }));
  assert.deepEqual(await none.refreshCapsule(), { ok: false, reason: 'no_capsule' });
  // Capsules off (a new pin's walk): nothing is asked at all.
  const off = network({ nodes: NODES, top: CAP_TOP, stateRootOf: rootOf });
  assert.deepEqual(await light(off, { ...CAPSULE_OPTIONS, capsules: false }).refreshCapsule({ force: true }), { ok: false, reason: 'disabled' });
  assert.equal(off.asked.length, 0);
});

test('a capsule is a faster root, never a replacement: a walk from the site\'s own anchor near the head, a checkpoint verified here', async () => {
  // A capsule naming another checkpoint at K than the one the site verified is refused before its roots are asked for.
  const forged = capsuleAt(KC, rootOf, { cpOf: (j) => (j === KC ? 'cd'.repeat(32) : core.checkpointHash(proofFor(j, rootOf(j)).checkpoint)) });
  const net = capsuleNet({ capsule: forged });
  const other = capsuleLight(net, { pin: pinAt(130) });
  assert.deepEqual(await other.certifiedRootAt(KC, 20_000), { root: ROOT });
  const asked = proofRequests(net).length;
  assert.deepEqual(await other.refreshCapsule({ force: true }), { ok: false, reason: 'conflict' });
  assert.equal(proofRequests(net).length, asked, 'no root asked for');
  // Another checkpoint of K the nodes served while the capsule was rooted (same state, another time), then a walk from
  // the site's own anchor (within OWN_ROOT_WALK_STEPS) verifies the honest K: the capsule goes, the verified data stays.
  let forging = true;
  const otherCp = (j) => proofFor(j, rootOf(j), { edit: (p) => { p.checkpoint.timestamp = 1_800_000_000; } });
  const lying = (path, honest) => (forging && path === `/api/v1/macroblock/${KC}/proof` ? { body: otherCp(KC) } : honest(path));
  const swapped = capsuleNet({
    capsule: capsuleAt(KC, rootOf, { cpOf: (j) => core.checkpointHash((j === KC ? otherCp(j) : proofFor(j, rootOf(j))).checkpoint) }),
    handlers: Object.fromEntries(NODES.map((n) => [n, lying])),
  });
  const lw = capsuleLight(swapped, { pin: pinAt(130) });
  assert.deepEqual(await lw.refreshCapsule({ force: true }), { ok: true, index: KC });
  forging = false;
  assert.deepEqual(await lw.certifiedRootAt(KC + 10, 20_000), { root: ROOT });
  assert.ok(proofRequests(swapped).filter((j) => j === 132).length > 0, 'walked from the pin 130, 10 steps');
  assert.equal(lw.heldCapsuleIndex(), 0, 'the capsule of another checkpoint is dropped');
  assert.deepEqual(await lw.refreshCapsule({ force: true }), { ok: false, reason: 'conflict' }, 'and not taken again soon');
});

test('a capsule whose root the nodes\' next step refuses is dropped, no node blamed, and the walk roots at the pin at once', async () => {
  // K's checkpoint as the nodes served it while the capsule was rooted names a registry root no node holds: the first
  // step above it cannot bind its committee's keys at any node.
  let forging = true;
  const otherRegistry = (j) => {
    const p = proofFor(j, rootOf(j), { edit: (x) => { x.checkpoint.registry_root = 'ee'.repeat(32); } });
    return p;
  };
  const lying = (path, honest) => (forging && path === `/api/v1/macroblock/${KC}/proof` ? { body: otherRegistry(KC) } : honest(path));
  const net = capsuleNet({
    capsule: capsuleAt(KC, rootOf, { cpOf: (j) => core.checkpointHash((j === KC ? otherRegistry(j) : proofFor(j, rootOf(j))).checkpoint) }),
    handlers: Object.fromEntries(NODES.map((n) => [n, lying])),
  });
  const lc = capsuleLight(net);
  assert.deepEqual(await lc.refreshCapsule(), { ok: true, index: KC });
  forging = false;
  assert.ok(LINEAGE_REFUSALS <= NODES.length);
  assert.deepEqual(await lc.certifiedRootAt(KC + 2, 30_000), { root: ROOT });
  assert.equal(lc.heldCapsuleIndex(), 0);
  assert.ok(proofRequests(net).includes(K + 2), 'rooted at the pin');
  // K-1 stays as verified from the pin now, and the odd chain was never touched by the drop.
  assert.deepEqual(await lc.certifiedRootAt(KC + 1, 30_000), { root: ROOT });
});

test('If-None-Match: a node holding the same capsule answers 304, and is not asked again for ten minutes', async () => {
  const capsule = capsuleAt(KC, rootOf);
  const tag = capsuleEtag(KC, capsule.cp_hash_anchor);
  const net = capsuleNet({ capsule: (headers) => (headers['If-None-Match'] === tag ? { status: 304, text: '', retryAfterS: null } : { body: capsule }) });
  const lc = capsuleLight(net);
  assert.deepEqual(await lc.refreshCapsule(), { ok: true, index: KC });
  assert.deepEqual(net.asked.filter(([, p]) => p === CAPSULE_PATH).map(([, , h]) => h['If-None-Match'] ?? null), [null, null]);
  assert.deepEqual(await lc.refreshCapsule({ force: true }), { ok: false, reason: 'stale' });
  assert.deepEqual(net.asked.filter(([, p]) => p === CAPSULE_PATH).slice(2).map(([, , h]) => h['If-None-Match']), [tag, tag]);
  assert.equal(lc.heldCapsuleIndex(), KC);
});

// ------------------------------------------------------------------------------------------------ the balance check

const mine = W.accounts.get(ADDR);
function certifiedBody(address, j = TOP, over = {}) {
  const p = W.tree.prove(addressKey(address));
  const f = W.accounts.get(address) ?? plainAccount();
  const body = {
    proof_format: 2, address, macroblock_index: j, state_height: j * 90, state_root: ROOT, exists: p.kind === 'inclusion', proof_kind: p.kind,
    balance: f.balance, nonce: f.nonce, heartbeat_epoch: f.heartbeat_epoch, heartbeat_slots: f.heartbeat_slots, heartbeat_final_epoch: f.heartbeat_final_epoch,
    heartbeat_final_slots: f.heartbeat_final_slots, last_claimed_epoch: f.last_claimed_epoch, banned_at_height: f.banned_at_height,
    is_contract: f.is_contract, is_node: f.is_node, contract_code_hash: f.contract_code_hash, storage_root: f.storage_root,
    merkle_proof: p.steps, servable: [j - 2, j - 1, j],
  };
  if (p.kind === 'absence_in_bucket') body.bucket_entries = p.entries;
  return { ...body, ...over };
}
function legacyBody(address, height) {
  const p = W.tree.prove(addressKey(address));
  const f = W.accounts.get(address);
  return { address, balance: Number(f.balance) <= Number.MAX_SAFE_INTEGER ? Number(f.balance) : f.balance, nonce: Number(f.nonce),
    heartbeat_epoch: Number(f.heartbeat_epoch), heartbeat_slots: f.heartbeat_slots, heartbeat_final_epoch: Number(f.heartbeat_final_epoch),
    heartbeat_final_slots: f.heartbeat_final_slots, last_claimed_epoch: Number(f.last_claimed_epoch), banned_at_height: 0, is_node: f.is_node,
    merkle_proof: p.steps, state_root: ROOT, block_height: height, proof_valid: true };
}
const raw = (status, text, retryAfterS = null) => ({ status, text, retryAfterS });
const proofPath = (address) => `/api/v1/account/${encodeURIComponent(address)}/balance/proof?mb=latest`;

function prover(answer, extra = {}) {
  const handlers = Object.fromEntries(NODES.map((n, i) => [n, (path, honest) => {
    if (path.includes('/balance/proof')) return answer(i, path);
    return honest(path);
  }]));
  const net = network({ nodes: NODES, top: TOP, stateRootOf: rootOf, handlers, ...extra });
  const lc = light(net);
  return { net, lc, p: createBalanceProver({ light: lc, nodes: () => NODES, fetchText: net.fetchText, waitMs: 30_000 }) };
}

test('a certified answer counts once its proof folds to the root the site verified, never the root the node served', async () => {
  const { p, net } = prover((i, path) => {
    assert.equal(path, proofPath(ADDR), 'the certified form is asked for');
    return { body: certifiedBody(ADDR, TOP, { state_root: '11'.repeat(32) }) };
  });
  assert.deepEqual(await p.provenBalance(ADDR), { verified: true, exists: true, balanceNano: '18000000000000000000', nonce: '7', macroblockIndex: TOP,
    stateHeight: TOP * 90, stateRoot: ROOT, form: 'certified' });
  assert.ok(net.asked.some(([, path]) => path === '/api/v1/macroblock/112/proof'), 'the named macroblock was verified');
  // An account no one holds: proven absent, a verified zero.
  const nobody = 'nobody_eon_' + 'q'.repeat(30);
  const abs = prover(() => ({ body: certifiedBody(nobody) }));
  assert.deepEqual(await abs.p.provenBalance(nobody), { verified: true, exists: false, balanceNano: '0', nonce: '0', macroblockIndex: TOP, stateHeight: TOP * 90, stateRoot: ROOT, form: 'certified' });
  const crowded = prover(() => ({ body: certifiedBody(W.crowded) }));
  assert.equal((await crowded.p.provenBalance(W.crowded)).verified, true, 'absence in a shared bucket');
});

test('a hostile node\'s answer is no answer: the next node is asked, and none is shown as a balance', async () => {
  const other = buildTree([{ key: addressKey(ADDR), leaf: accountLeaf(ADDR, { ...mine, balance: '1' }) }]);
  const hostile = [
    { body: certifiedBody(ADDR, TOP, { balance: '1', merkle_proof: other.prove(addressKey(ADDR)).steps, state_root: other.root }) },
    { body: certifiedBody(ADDR, TOP, { address: 'someone_else_eon_' + 'p'.repeat(30) }) },
    { body: certifiedBody(ADDR, TOP, { state_height: TOP * 90 - 1 }) },
    { body: certifiedBody(ADDR, TOP, { exists: false }) },
  ];
  for (const bad of hostile) {
    const { p } = prover((i) => (i === 4 ? { body: certifiedBody(ADDR) } : bad));
    const r = await p.provenBalance(ADDR);
    assert.equal(r.verified, true);
    assert.equal(r.balanceNano, '18000000000000000000');
  }
  // An absence with a balance, a repeated key, a typed 429, a 503 and a rate-limit body: nothing counts.
  const nobody = 'nobody_eon_' + 'q'.repeat(30);
  const answers = [
    { body: certifiedBody(nobody, TOP, { balance: '5' }) },
    raw(200, JSON.stringify(certifiedBody(ADDR)).replace('"balance":', '"balance":"1","balance":')),
    raw(429, JSON.stringify({ proof_format: 2, error: 'rate_limited', retry_after_seconds: 5 }), 5),
    raw(503, JSON.stringify({ proof_format: 2, error: 'busy' }), 1),
    { body: { error: 'Rate limit exceeded', retry_after_seconds: 3 } },
  ];
  const none = prover((i) => answers[i]);
  assert.deepEqual(await none.p.provenBalance(nobody), { verified: false, reason: 'network_unavailable' });
  const down = prover(() => 'throw');
  assert.deepEqual(await down.p.provenBalance(ADDR), { verified: false, reason: 'network_unavailable' });
});

test('a certified but old macroblock does not count, nor does one the site cannot verify yet', async () => {
  const stale = prover(() => ({ body: certifiedBody(ADDR, TOP - 3) }));
  assert.deepEqual(await stale.p.provenBalance(ADDR), { verified: false, reason: 'not_confirmed_yet' });
  const ahead = prover(() => ({ body: certifiedBody(ADDR, TOP + 1) }));
  assert.deepEqual(await ahead.p.provenBalance(ADDR), { verified: false, reason: 'not_confirmed_yet' });
  // Five nodes naming a macroblock the walk is slow to reach cost one wait, not five (fixtures made beforehand, so
  // only the prover's own time is measured).
  const ready = certifiedBody(ADDR);
  for (let j = K + 1; j <= TOP; j++) proofFor(j, ROOT);
  const slowWalk = network({ nodes: NODES, top: TOP, stateRootOf: rootOf, handlers: Object.fromEntries(NODES.map((n) => [n, async (path, honest) => {
    if (path.includes('/balance/proof')) return { body: ready };
    if (path.includes('/macroblock/')) await new Promise((r) => setTimeout(r, 1500));
    return honest(path);
  }])) });
  const once = createBalanceProver({ light: light(slowWalk), nodes: () => NODES, fetchText: slowWalk.fetchText, waitMs: 300 });
  const started = Date.now();
  assert.deepEqual(await once.provenBalance(ADDR), { verified: false, reason: 'not_confirmed_yet' });
  assert.ok(Date.now() - started < 1200, `one wait (${Date.now() - started} ms)`);
  assert.equal(slowWalk.asked.filter(([, p]) => p.includes('/balance/proof')).length, 5);
  // Without a head to judge recency nothing is verified, and no proof is even asked for.
  const headless = network({ nodes: NODES, top: TOP, stateRootOf: rootOf, handlers: Object.fromEntries(NODES.map((n) => [n, (path, honest) => {
    if (path === '/api/v1/state/certified' || path === '/api/v1/height') return 'throw';
    return path.includes('/balance/proof') ? { body: certifiedBody(ADDR) } : honest(path);
  }])) });
  const noHead = createBalanceProver({ light: light(headless), nodes: () => NODES, fetchText: headless.fetchText, waitMs: 30_000 });
  assert.deepEqual(await noHead.provenBalance(ADDR), { verified: false, reason: 'network_unavailable' });
  assert.ok(!headless.asked.some(([, path]) => path.includes('/balance/proof')));
});

test('an old node\'s legacy proof counts only against a certified root; it is recognised by its shape and asked last for ten minutes', async () => {
  assert.equal(isLegacyBody(legacyBody(ADDR, TOP * 90 + 40)), true);
  assert.equal(isLegacyBody({ error: 'Rate limit exceeded', retry_after_seconds: 5 }), false, 'a rate limit is no old node');
  assert.equal(isLegacyBody(certifiedBody(ADDR)), false);
  let t = 1_000_000;
  const asked = [];
  const handlers = Object.fromEntries(NODES.map((n, i) => [n, (path, honest) => {
    if (!path.includes('/balance/proof')) return honest(path);
    asked.push(i);
    return i === 0 ? { body: legacyBody(ADDR, TOP * 90 + 40) } : 'throw';
  }]));
  const net = network({ nodes: NODES, top: TOP, stateRootOf: rootOf, handlers });
  const lc = light(net);
  const p = createBalanceProver({ light: lc, nodes: () => NODES, fetchText: net.fetchText, now: () => t, waitMs: 30_000 });
  const r = await p.provenBalance(ADDR);
  assert.deepEqual(r, { verified: true, exists: true, balanceNano: '18000000000000000000', nonce: '7', macroblockIndex: TOP, stateHeight: TOP * 90, stateRoot: ROOT, form: 'legacy' });
  asked.length = 0;
  await p.provenBalance(ADDR);
  assert.equal(asked.at(-1), 0, 'the old node is asked last');
  t += 10 * 60_000 + 1;
  asked.length = 0;
  await p.provenBalance(ADDR);
  assert.ok(asked.indexOf(0) >= 0 && asked.length >= 1);
  // A live root no certified checkpoint holds, and a legacy "not found" without a proof, are not answers.
  const moved = buildTree([{ key: addressKey(ADDR), leaf: accountLeaf(ADDR, mine) }]);
  const unc = prover(() => ({ body: { ...legacyBody(ADDR, TOP * 90 + 40), merkle_proof: moved.prove(addressKey(ADDR)).steps, state_root: moved.root } }));
  assert.deepEqual(await unc.p.provenBalance(ADDR), { verified: false, reason: 'not_confirmed_yet' });
  const nf = prover(() => ({ body: { address: ADDR, balance: 0, nonce: 0, merkle_proof: [], state_root: '', block_height: 0, error: 'account not found', proof_valid: false } }));
  assert.deepEqual(await nf.p.provenBalance(ADDR), { verified: false, reason: 'not_confirmed_yet' });
});

// ------------------------------------------------------------------------------------------------ the route, the page, the doc

test('the route, the page and explorer.md describe the committee check, and nothing reads node agreement as verified', () => {
  const route = readFileSync(new URL('app/api/address/[address]/balance-proof/route.ts', SRC), 'utf8');
  assert.match(route, /import \{ sharedBalanceProver, type BalanceResult \} from '@\/server\/light\/balance-proof';/);
  assert.doesNotMatch(route, /validators\/proof|\/api\/v1\/account\/\$\{address\}`|consensus|nodesAgreed|CONSENSUS_RATIO/);
  assert.match(route, /if \(!r\.verified\) return \{ success: true, verified: false, reason: r\.reason, error: MESSAGES\[r\.reason\] \};/);
  assert.match(route, /verificationMethod: 'committee-certificate',/);
  const page = readFileSync(new URL('app/explorer/address/[address]/page.tsx', SRC), 'utf8');
  assert.doesNotMatch(page, /Multi-Node Consensus|Nodes Agreed|Multi-node consensus|Cryptographically Verified/);
  assert.match(page, /Verified by the committee certificate/);
  assert.match(page, /if \(data\.success && data\.verified === true && typeof data\.stateRoot === 'string' && typeof data\.balance === 'string'\) \{/);
  // A second request for an address under check shares that check; the page's block stays hidden, and the doc says so.
  assert.match(route, /let running = inflight\.get\(address\);\s*if \(!running\) \{\s*running = sharedBalanceProver\(\)\.provenBalance\(address\)\.then\(/);
  assert.match(route, /\}\)\.finally\(\(\) => inflight\.delete\(address\)\);\s*inflight\.set\(address, running\);/);
  assert.match(page, /\{\/\* v3\.11: Merkle proof verification — temporarily hidden\s*<BalanceVerification address=\{address\} \/>\s*\*\/\}/);
  const balanceProof = readFileSync(new URL('server/light/balance-proof.ts', SRC), 'utf8');
  assert.match(balanceProof, /\?mb=latest`/);
  assert.match(balanceProof, /const nodes = \(\) => GENESIS_NODES;/);
  const doc = read('docs/applications/explorer.md').replace(/\s+/g, ' ');
  assert.doesNotMatch(doc, /Balance agreement check|two thirds of the responders agree|Multi-node balance agreement/);
  assert.match(doc, /\| `GET \/api\/address\/\[address\]\/balance-proof` \| The balance verified against a committee certificate/);
  assert.match(doc, /### Balance check/);
  assert.match(doc, /a request for an address whose check is already running waits for that check\. The address page's Verify Balance, which shows the proven balance with its checkpoint, the block its state is at and the state root, is hidden at present\./);
});
