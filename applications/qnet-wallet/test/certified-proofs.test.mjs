// Certified state proofs (proof_format 2) through the bundle: the shared verifier the app also runs (mobile SmtFold.js:
// every leaf field, the three proof kinds, strict reading, the golden vectors of the node's golden_vectors_for_clients),
// the older live-root token body, and the light client's root of a named macroblock and certified head over a network
// whose committee signs for real (helpers/certified-net.mjs).
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../dist/lib/qnet-core.js';
import { QNET } from '../dist/background/config.js';
import { installFetch } from './helpers/chains-activation-env.mjs';
import {
  FIRST_INDEX, NOBLE_INSTALLED, ZERO, accountFields, accountAnswer, certifiedNet, jsonText, legacyTokenAnswer, stateTree, tokenAnswer,
} from './helpers/certified-net.mjs';

const skip = NOBLE_INSTALLED ? {} : { skip: 'run npm run bundle:install' };
const addrKey = (address) => core.accountKeyHash(address);
const leafOf = (address, fields) => core.certifiedAccountLeafHash(address, fields);

// The golden accounts of the node's golden_vectors_for_clients, and the hex the app's verifier gives for them
// (applications/qnet-mobile/__tests__/CertifiedProofs.test.js GOLDEN): one verifier, so the same hex here.
const PLAIN = 'eon_golden_plain';
const CONTRACT = 'eon_golden_contract';
const plainFields = accountFields({ balance: '5000000000', nonce: '3', heartbeat_epoch: '12', heartbeat_slots: 0x01ff, last_claimed_epoch: '10' });
const storage = stateTree([
  [core.storageKeyHash(`balance:${PLAIN}`), core.storageLeafValue('250')],
  [core.storageKeyHash('total_supply'), core.storageLeafValue('1000')],
]);
const contractFields = accountFields({ is_contract: true, contract_code_hash: 'c0de'.repeat(16), storage_root: storage.root });
const state = stateTree([[addrKey(PLAIN), leafOf(PLAIN, plainFields)], [addrKey(CONTRACT), leafOf(CONTRACT, contractFields)]]);
const stepDigest = (steps) => core.sha3_256Hex(core.concatBytes(...steps.flatMap((s) => [core.hexToBytes(s.sibling), Uint8Array.of(s.is_right ? 1 : 0)])));
const coBucket = (key) => key.slice(0, 62) + (parseInt(key.slice(62), 16) ^ 1).toString(16).padStart(2, '0');
const GOLDEN = {
  plain_leaf: '47f4cd00ad826f7c9691e514a4fed334c47500ac6ef6348f940e870aab861143',
  contract_leaf: '91853f19011f659eb002d4607613af2de14f0eff5a76cdec958e1d767096ebfd',
  storage_leaf: 'c6865e0b2be779fead42ae16e784ef8e8aa35faf3f73a8d759ae43adbb97c126',
  root: '466262ba15c449ca1c068c5ecf5a003ca64dba74a9e079787ac869531fba149b',
  inclusion_steps: 'b02f32942a77a887a4950860e47c2d1031104b6e9379f0a2f9468bd165513947',
  absence_steps: 'f0870bc01ff5aa768bd7cfda24cbae6bd995a47e55c8656ff23db36b1133a8f1',
  absence_in_bucket_steps: 'b02f32942a77a887a4950860e47c2d1031104b6e9379f0a2f9468bd165513947',
};

describe('certified proofs: the shared verifier', () => {
  it('golden vectors: fixed inputs give the app\'s hex (the node\'s golden_vectors_for_clients inputs)', () => {
    const inc = state.prove(addrKey(PLAIN));
    const abs = state.prove(addrKey('eon_golden_absent'));
    const aib = state.prove(coBucket(addrKey(PLAIN)));
    assert.equal(abs.kind, 'absence');
    assert.equal(aib.kind, 'absence_in_bucket');
    assert.deepEqual({
      plain_leaf: leafOf(PLAIN, plainFields),
      contract_leaf: leafOf(CONTRACT, contractFields),
      storage_leaf: core.storageLeafValue('250'),
      root: state.root,
      inclusion_steps: stepDigest(inc.steps),
      absence_steps: stepDigest(abs.steps),
      absence_in_bucket_steps: stepDigest(aib.steps),
    }, GOLDEN);
  });

  it('the account leaf covers every field: none is hardcoded to zero, and a wallet leaf is the full one', () => {
    const base = leafOf(PLAIN, plainFields);
    for (const [key, value] of [['heartbeat_epoch', '13'], ['heartbeat_slots', 1], ['heartbeat_final_epoch', '1'],
      ['heartbeat_final_slots', 2], ['last_claimed_epoch', '11'], ['banned_at_height', '9'], ['is_node', true], ['contract_code_hash', '']]) {
      assert.notEqual(leafOf(PLAIN, { ...plainFields, [key]: value }), base, key);
    }
    // the extension's wallet leaf takes every field the proof carries
    assert.equal(core.accountLeafHash({
      address: PLAIN, balance: '5000000000', nonce: '3', heartbeatEpoch: '12', heartbeatSlots: 0x01ff, lastClaimedEpoch: '10',
    }), base);
    assert.notEqual(core.accountLeafHash({ address: PLAIN, balance: '5000000000', nonce: '3', lastClaimedEpoch: '10' }), base);
  });

  it('inclusion, absence and absence in a shared bucket each fold exactly, and refuse what they do not prove', () => {
    const inc = state.prove(addrKey(PLAIN));
    assert.equal(core.verifyInclusion(addrKey(PLAIN), leafOf(PLAIN, plainFields), inc.steps, state.root), true);
    assert.equal(core.verifyInclusion(addrKey(PLAIN), ZERO, inc.steps, state.root), false);
    const absKey = addrKey('eon_golden_absent');
    const abs = state.prove(absKey);
    assert.equal(core.verifyAbsence(absKey, abs.steps, state.root), true);
    assert.equal(core.verifyAbsence(absKey, abs.steps.slice(1), state.root), false);
    assert.equal(core.verifyAbsence(addrKey(PLAIN), inc.steps, state.root), false, 'an included key is no absence');
    const key = coBucket(addrKey(PLAIN));
    const aib = state.prove(key);
    const entries = aib.entries.map((e) => [e.key, e.leaf]);
    assert.equal(core.verifyAbsenceInBucket(key, entries, aib.steps, state.root), true);
    assert.equal(core.verifyAbsence(key, aib.steps, state.root), false, 'a plain absence over a crowded bucket proves nothing');
    assert.equal(core.verifyAbsenceInBucket(key, [], aib.steps, state.root), false);
    assert.equal(core.verifyAbsenceInBucket(addrKey(PLAIN), entries, aib.steps, state.root), false, 'the key among the entries');
    assert.equal(core.verifyAbsenceInBucket(key, entries, aib.steps.slice(1), state.root), false);
  });

  it('reads a certified account answer strictly and folds it only under the root it is given', () => {
    const net = { index: 7, root: state.root, tree: state, fieldsOf: new Map([[PLAIN, plainFields], [CONTRACT, contractFields]]) };
    const body = accountAnswer(net, PLAIN);
    const read = core.readCertifiedAccount(body, PLAIN);
    assert.equal(read.ok, true);
    assert.equal(read.index, 7);
    assert.deepEqual([read.account.balance, read.account.nonce, read.account.exists], ['5000000000', '3', true]);
    assert.equal(read.fold(state.root), true);
    assert.equal(read.fold('ab'.repeat(32)), false, 'never the root the node served: the one the caller verified');
    assert.equal(core.readCertifiedAccount(body, CONTRACT).ok, false, 'bound to the asked address');
    assert.equal(core.readCertifiedAccount({ ...body, balance: '5000000001' }, PLAIN).fold(state.root), false);
    assert.equal(core.readCertifiedAccount({ ...body, state_height: String(8 * 90) }, PLAIN).ok, false, 'the height of its index');
    assert.equal(core.readCertifiedAccount({ ...body, heartbeat_slots: '511' }, PLAIN).ok, false, 'typed strictly');
    const absent = core.readCertifiedAccount(accountAnswer(net, 'eon_golden_absent'), 'eon_golden_absent');
    assert.equal(absent.ok, true);
    assert.deepEqual([absent.account.exists, absent.account.balance], [false, '0']);
    assert.equal(absent.fold(state.root), true, 'an absence counts with its proof');
    assert.equal(core.readCertifiedAccount({ ...accountAnswer(net, 'eon_golden_absent'), balance: '5' }, 'eon_golden_absent').ok, false);
  });

  it('a token answer proves the contract under the root and the holder under the storage root it commits', () => {
    const net = {
      index: 7, root: state.root, tree: state, fieldsOf: new Map([[PLAIN, plainFields], [CONTRACT, contractFields]]),
      storage: new Map([[CONTRACT, { tree: storage, holders: { [PLAIN]: '250' } }]]),
    };
    const read = core.readCertifiedToken(tokenAnswer(net, CONTRACT, PLAIN), CONTRACT, PLAIN);
    assert.deepEqual([read.ok, read.status, read.balanceBase], [true, 'contract', '250']);
    assert.equal(read.fold(state.root), true);
    assert.equal(core.readCertifiedToken({ ...tokenAnswer(net, CONTRACT, PLAIN), token_balance: '251' }, CONTRACT, PLAIN).fold(state.root), false);
    const drained = core.readCertifiedToken(tokenAnswer(net, CONTRACT, 'eon_golden_absent'), CONTRACT, 'eon_golden_absent');
    assert.deepEqual([drained.ok, drained.balanceBase, drained.fold(state.root)], [true, '0', true]);
    const notContract = core.readCertifiedToken(tokenAnswer(net, PLAIN, PLAIN), PLAIN, PLAIN);
    assert.deepEqual([notContract.ok, notContract.status, notContract.balanceBase, notContract.fold(state.root)], [true, 'not_contract', '0', true]);
    const absent = core.readCertifiedToken(tokenAnswer(net, 'eon_golden_absent', PLAIN), 'eon_golden_absent', PLAIN);
    assert.deepEqual([absent.ok, absent.status, absent.fold(state.root)], [true, 'absent', true]);
    assert.equal(core.readCertifiedToken({ ...tokenAnswer(net, PLAIN, PLAIN), contract_status: 'absent' }, PLAIN, PLAIN).ok, false,
      'a status counts only with its level-1 proof');
    assert.equal(core.readCertifiedToken(tokenAnswer(net, CONTRACT, PLAIN), CONTRACT, CONTRACT).ok, false, 'bound to the asked holder');
  });

  it('an older node\'s token body folds both levels to the root it names, bound to the contract and holder', () => {
    const net = {
      index: 7, root: state.root, tree: state, fieldsOf: new Map([[PLAIN, plainFields], [CONTRACT, contractFields]]),
      storage: new Map([[CONTRACT, { tree: storage, holders: { [PLAIN]: '250' } }]]),
    };
    const body = core.parseStrictJson(jsonText(legacyTokenAnswer(net, CONTRACT, PLAIN, 7 * 90 + 45)));
    assert.equal(core.isLegacyProofBody(body, 'token'), true);
    assert.equal(core.verifyLegacyTokenProof(body, CONTRACT, PLAIN), true);
    assert.equal(core.verifyLegacyTokenProof({ ...body, token_balance: '251' }, CONTRACT, PLAIN), false);
    assert.equal(core.verifyLegacyTokenProof(body, CONTRACT, CONTRACT), false);
    assert.equal(core.verifyLegacyTokenProof({ ...body, state_root: 'ab'.repeat(32) }, CONTRACT, PLAIN), false);
    const drained = core.parseStrictJson(jsonText(legacyTokenAnswer(net, CONTRACT, 'eon_golden_absent', 7 * 90)));
    assert.equal(core.verifyLegacyTokenProof(drained, CONTRACT, 'eon_golden_absent'), true, 'a drained entry is the empty leaf');
    // the legacy shape is recognised positively only: a rate limit, an error or a certified body is not it
    assert.equal(core.isLegacyProofBody({ error: 'Rate limit exceeded', retry_after_seconds: 5 }), false);
    assert.equal(core.isLegacyProofBody({ proof_format: 2, error: 'rate_limited' }), false);
    assert.equal(core.isLegacyProofBody({ ...body, proof_format: 2 }, 'token'), false);
  });

  it('parses proof answers strictly: a repeated key refuses the answer, a u64 past 2^53 stays exact', () => {
    assert.throws(() => core.parseStrictJson('{"balance":"1","balance":"2"}'));
    assert.deepEqual(core.parseStrictJson('{"a":18446744073709551615,"b":7}'), { a: '18446744073709551615', b: 7 });
    assert.equal(core.u64Text(18446744073709551616n.toString()), null);
    assert.equal(core.u64Text('18446744073709551615'), '18446744073709551615');
  });
});

describe('certified proofs: the light client over a committee that signs', () => {
  let net;
  beforeEach(() => {
    if (!NOBLE_INSTALLED) return;
    net = certifiedNet({ accounts: { [PLAIN]: { balance: '5' } } }).install();
    net.certify({ [PLAIN]: { balance: '6' } });
    installFetch(net.route);
  });

  it('certifiedStateRootAt walks up to the named macroblock only and gives its certified state root', skip, async () => {
    const target = net.stateAt(FIRST_INDEX);
    const got = await core.certifiedStateRootAt(FIRST_INDEX, () => QNET.NODES);
    assert.deepEqual(got, { ok: true, index: FIRST_INDEX, stateRoot: target.root });
    assert.ok(!net.requests.some((r) => r.endsWith(`/macroblock/${FIRST_INDEX + 1}/proof`)), 'never past the index');
    assert.deepEqual(await core.certifiedStateRootAt(core.trustFloorIndex() - 1, () => QNET.NODES), { ok: false, reason: 'below_floor' });
    // a macroblock no node holds yet is not certified, and no node is blamed for it
    const failures = [];
    const ahead = await core.certifiedStateRootAt(FIRST_INDEX + 3, () => QNET.NODES, { onNodeFailure: (base, why) => failures.push(why) });
    assert.equal(ahead.ok, false);
    assert.deepEqual(failures, []);
  });

  it('certifiedHeadHint is the second highest frontier of at least three nodes; one node claiming far ahead moves nothing', skip, async () => {
    net.frontier.set(QNET.NODES[0], FIRST_INDEX + 500);
    assert.equal(await core.certifiedHeadHint(() => QNET.NODES), FIRST_INDEX + 1);
    assert.equal(await core.certifiedHead(() => QNET.NODES), FIRST_INDEX + 1);
    core.clearQcCache();
    for (const node of QNET.NODES.slice(2)) net.down.add(node);
    assert.equal(await core.certifiedHeadHint(() => QNET.NODES), null, 'two answers are too few');
    assert.equal(await core.certifiedHead(() => QNET.NODES), null);
  });

  it('a node from before certified proofs reports its sealed-macroblock count instead', skip, async () => {
    for (const node of QNET.NODES) net.old.add(node);
    assert.equal(await core.certifiedHeadHint(() => QNET.NODES), FIRST_INDEX + 1);
    assert.ok(net.requests.some((r) => r.endsWith('/api/v1/debug/consensus-position')));
  });
});
