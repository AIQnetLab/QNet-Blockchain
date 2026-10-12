// The QC check of the light client the bundle compiles from the mobile source (R5-EXTQ-04): a QC that lists a
// committee member more than once, or more signers than the committee has, is refused before any ML-DSA-65 verify.
// Each verify is synchronous (about 10 ms) and the MV3 worker answers nothing while it runs, so a proof that listed one
// member hundreds of times with well-formed invalid signatures once froze the worker for about 20 s per walk step.
// Runs real walk steps through the bundle, with a fetch that serves the proof and a registry bound to its anchor; the
// committee signs for real, so a QC that passes is told from one that is refused by where the step fails next.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const NOBLE = new URL('../tools/crypto-bundle/node_modules/@noble/post-quantum/ml-dsa.js', import.meta.url);
const installed = existsSync(NOBLE);
const skip = installed ? {} : { skip: 'run npm run bundle:install' };
const { ml_dsa65: mlDsa } = installed ? await import(NOBLE.href) : {};
const core = await import('../dist/lib/qnet-core.js');

// Above the release's weak-subjectivity pin, whichever it is, on the odd parity chain.
const J = 2 * Math.floor((core.trustFloorIndex() + 1000) / 2) + 1;
const NODE = 'https://node-a.test';
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

// Five committee members with real ML-DSA-65 keys, registered in the anchor's registry.
const ids = ['node_a', 'node_b', 'node_c', 'node_d', 'node_e'];
const keys = Object.fromEntries(ids.map((id, i) => [id, core.deriveQnetKeypair(new Uint8Array(64).fill(i + 1))]));
const entries = ids.map((id, i) => ({
  node_id: id, wallet: null, reg_height: 0, reg_index: i, burn: null, node_type: 'super', vrf_pk_sha3: core.sha3_256Hex(keys[id].publicKey),
}));
const registryRoot = core.recomputeRegistryRoot(entries);
const beacon = '11'.repeat(32);

const checkpoint = {
  index: J, window_head_height: J * 90, window_mb_hashes: [], state_root: 'ab'.repeat(32), beacon: '22'.repeat(32),
  epoch_commitment: '33'.repeat(32), reward_root: '00'.repeat(32), registry_root: '00'.repeat(32), logs_root: '00'.repeat(32),
  dilithium_pk_root: '00'.repeat(32), reward_epoch_root: '00'.repeat(32), total_supply: 0, timestamp: 0, proposer: 'node_a',
  recovery_anchor: null,
};
const vote = new TextEncoder().encode(`QNET_BFT2_VOTE:${core.checkpointHash(checkpoint)}`);

// A QC signature string as nodes serve it: "dilithium_sig_<id>_" + base64([u32LE len][detached sig][msg]).
function qcSig(id, valid) {
  const detached = valid ? mlDsa.sign(vote, keys[id].secretKey) : new Uint8Array(3309).fill(7);
  const payload = new Uint8Array(4 + detached.length + vote.length);
  new DataView(payload.buffer).setUint32(0, detached.length + vote.length, true);
  payload.set(detached, 4);
  payload.set(vote, 4 + detached.length);
  return `dilithium_sig_${id}_${Buffer.from(payload).toString('base64')}`;
}

// A proof of J whose QC lists `signers`, each with a real signature of the vote (`valid`) or a well-formed invalid one.
// Its epoch commitment is left wrong on purpose: a step whose QC passes fails right after, on that commitment.
function proofWith(signers, valid) {
  return {
    index: J,
    checkpoint,
    eligible_raw: '',
    banned: [],
    committee_pubkeys: Object.fromEntries(ids.map((id) => [id, hex(keys[id].publicKey)])),
    qc: { signers, sigs: signers.map((id) => qcSig(id, valid && ids.includes(id))) },
  };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  core.clearQcCache();
  core.clearCapsule();
});

// One walk step of macroblock J rooted at an imported anchor at J - 2: why the node's proof failed.
async function failureOf(proof) {
  core.importVerifiedAnchors({ [J - 2]: { eligible_ids: ids, beacon, registry_root: registryRoot } });
  globalThis.fetch = async (url) => {
    const { pathname } = new URL(url);
    if (pathname === `/api/v1/macroblock/${J}/proof`) return new Response(JSON.stringify(proof), { status: 200 });
    if (pathname === `/api/v1/registry/height/${(J - 2) * 90}`) return new Response(JSON.stringify({ entries }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  const failures = [];
  const certified = await core.verifyMacroblockStateRoot('ab'.repeat(32), J * 90, () => [NODE], {
    onNodeFailure: (base, reason) => failures.push([base, reason]),
  });
  assert.equal(certified, false);
  assert.equal(failures.length, 1, JSON.stringify(failures));
  return failures[0][1];
}

describe('light client QC: repeated or surplus signers (R5-EXTQ-04)', () => {
  it('a QC of the committee signing once each passes (the step then fails on its epoch commitment)', skip, async () => {
    assert.equal(await failureOf(proofWith([...ids], true)), 'epoch_commitment_mismatch');
  });

  it('refuses a QC that lists a member twice, even with a valid quorum around it', skip, async () => {
    assert.equal(await failureOf(proofWith([...ids, 'node_a'], true)), 'qc_invalid');
  });

  it('refuses a QC with more signers than the committee, even with a valid quorum among them', skip, async () => {
    const signers = [...ids, ...Array.from({ length: 200 }, (_, i) => `outsider_${i}`)];
    assert.equal(await failureOf(proofWith(signers, true)), 'qc_invalid');
  });

  it('refuses one member listed hundreds of times with invalid signatures (the frozen-worker proof)', skip, async () => {
    assert.equal(await failureOf(proofWith(Array.from({ length: 600 }, () => 'node_a'), false)), 'qc_invalid');
  });
});

// GALC v2 capsules through the bundle (docs/protocols/galc-capsule-v2.md): today's nodes answer 405 and the walks go on
// from the pin as before, each node asked once per TTL; a capsule not signed by the embedded genesis keys, or one of
// another network, is refused before it roots anything.
describe('light client capsule (GALC v2)', () => {
  const pin = core.genesisConsensus.WS_CHECKPOINT.index;
  const interval = core.genesisConsensus.GALC_V2_MINT_INTERVAL;
  const head = pin + 1000;
  const K = Math.floor(head / interval) * interval;
  const NODES = ['https://node-a.test', 'https://node-b.test', 'https://node-c.test'];

  // Answers 405 to capsule requests (or `capsule`, when given) and records every path asked.
  function serveCapsule(capsule = null) {
    const asked = [];
    globalThis.fetch = async (url) => {
      const { origin, pathname } = new URL(url);
      asked.push(`${origin}${pathname}`);
      if (pathname === '/api/v1/galc/capsule') {
        return capsule ? new Response(JSON.stringify(capsule), { status: 200 }) : new Response('HTTP method not allowed', { status: 405 });
      }
      return new Response('{}', { status: 404 });
    };
    return asked;
  }

  it('the build carries the network identity and the capsule cadence', () => {
    assert.match(core.genesisConsensus.NETWORK_ID, /^[0-9a-f]{64}$/);
    assert.equal(interval, 10);
  });

  it('405 from every node: no capsule, each node asked once per TTL, nothing held', async () => {
    const asked = serveCapsule();
    assert.deepEqual(await core.refreshCapsule(() => NODES, { headHint: head }), { ok: false, reason: 'no_capsule' });
    assert.deepEqual(await core.refreshCapsule(() => NODES, { headHint: head }), { ok: false, reason: 'no_capsule' });
    assert.deepEqual(await core.refreshCapsule(() => NODES, { headHint: head }), { ok: false, reason: 'no_capsule' });
    assert.deepEqual(asked, NODES.map((n) => `${n}/api/v1/galc/capsule`));
    assert.equal(core.heldCapsuleIndex(), 0);
    assert.equal(core.exportCapsule(), null);
  });

  it('refuses a capsule signed by keys that are not the embedded genesis keys, with no proof fetched', skip, async () => {
    const fields = {
      version: 2, network_id: core.genesisConsensus.NETWORK_ID, mb_index: K, mb_hash: '01'.repeat(32),
      committee_digest_anchor: '02'.repeat(32), committee_digest_pred: '03'.repeat(32), minted_at_height: K * 90,
      cp_hash_anchor: '04'.repeat(32), cp_hash_pred: '05'.repeat(32),
    };
    const text = new TextEncoder().encode(core.capsulePreimage(fields));
    const sigs = ['genesis_node_001', 'genesis_node_002', 'genesis_node_003', 'genesis_node_004'].map((id, i) => {
      const k = core.deriveQnetKeypair(new Uint8Array(64).fill(40 + i));
      const detached = mlDsa.sign(text, k.secretKey);
      const payload = new Uint8Array(4 + detached.length + text.length);
      new DataView(payload.buffer).setUint32(0, detached.length + text.length, true);
      payload.set(detached, 4);
      payload.set(text, 4 + detached.length);
      return [id, `dilithium_sig_${id}_${Buffer.from(payload).toString('base64')}`];
    });
    const asked = serveCapsule({ ...fields, sigs });
    assert.deepEqual(await core.refreshCapsule(() => NODES, { headHint: head }), { ok: false, reason: 'invalid' });
    assert.equal(asked.some((p) => p.includes('/macroblock/')), false);
    assert.equal(core.heldCapsuleIndex(), 0);
  });

  it('refuses the shared vectors\' capsule: another network, test keys', async () => {
    const vectors = JSON.parse(readFileSync(new URL('../../../docs/protocols/galc-capsule-v2.vectors.json', import.meta.url), 'utf8'));
    assert.deepEqual(await core.importCapsule({ capsule: vectors.capsule, roots: vectors.roots }), { ok: false, reason: 'network_id' });
    const ours = { ...vectors.capsule, network_id: core.genesisConsensus.NETWORK_ID };
    assert.equal(core.capsulePreimage(ours).split(':')[2], core.genesisConsensus.NETWORK_ID);
    // a K at or below this build's pin is refused before its signatures are read
    const reason = vectors.capsule.mb_index <= pin ? 'below_pin' : 'signatures';
    assert.deepEqual(await core.importCapsule({ capsule: ours, roots: vectors.roots }), { ok: false, reason });
  });
});
