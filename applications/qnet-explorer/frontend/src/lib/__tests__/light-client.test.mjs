// The site's balance check (src/server/light): a balance counts as verified only when its proof folds to the state root
// of a macroblock whose committee certificate the site verified itself, walking up from the wallets' pin; the certified
// form (?mb=) first, the legacy live-root proof of an old node only when its root is a certified one; never node
// agreement, never an answer without a proof. Run: npm run test:wallet
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ATTACKER, IDS, NODES, accountLeaf, addressKey, buildTree, coBucket, core, network, pinAt, plainAccount, proofFor, read,
  sha3Hex, smtFold,
} from './light-helpers.mjs';
import {
  checkpointHash, checkpointQuorum, decodeEligibleNodeIds, epochCommitment, parseDilithiumSig, quorumSize, recomputeRegistryRoot,
  recomputeRegistryRootYielding, sampleCommittee,
} from '../../server/light/checkpoint.ts';
import {
  accountKey, accountLeafHash, storageKey, storageLeaf, verifyAbsence, verifyAbsenceInBucket, verifyInclusion,
} from '../../server/light/smt.ts';
import { parseStrictJson, u64Text } from '../../server/light/strict-json.ts';
import { createLightClient } from '../../server/light/lineage.ts';
import { createBalanceProver, isLegacyBody } from '../../server/light/balance-proof.ts';
import { WS_CHECKPOINT } from '../../server/light/pin.ts';

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

test('the site walks from the wallets\' release pin, the same block of the same file', () => {
  const marked = (text) => /\/\/ <ws-pin>[\s\S]*?\/\/ <\/ws-pin>/.exec(text)[0];
  assert.equal(marked(read('applications/qnet-explorer/frontend/src/server/light/pin.ts')), marked(read('applications/qnet-mobile/src/config/genesisConsensus.js')));
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
