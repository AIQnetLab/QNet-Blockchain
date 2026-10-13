// Read-only checks of the bundle against the live networks (npm run test:live). Nothing is signed or sent.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../../dist/lib/qnet-core.js';

const SOLANA_DEVNET = 'https://api.devnet.solana.com';
const DEVNET_1DEV_MINT = '62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ';
const NODES = [1, 2, 3, 4, 5].map((i) => `https://node${i}.aiqnet.io`);
const KAT_BURN = core.KAT.activation;

async function getJson(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  assert.equal(response.ok, true, `${url} -> HTTP ${response.status}`);
  return response.json();
}

async function solanaRpc(method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const reply = await getJson(SOLANA_DEVNET, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  assert.equal(reply.error, undefined, JSON.stringify(reply.error));
  return reply.result;
}

async function fromAnyNode(pathname) {
  let last;
  for (const node of NODES) {
    try {
      return await getJson(node + pathname);
    } catch (error) {
      last = error;
    }
  }
  throw last;
}

describe('Solana devnet (read-only)', () => {
  it('the 1DEV mint has 6 decimals', async () => {
    const supply = await solanaRpc('getTokenSupply', [DEVNET_1DEV_MINT, { commitment: 'finalized' }]);
    assert.equal(supply.value.decimals, 6);
  });

  it('the KAT burn is final, burns the right amount from the derived ATA, and yields the KAT code', async () => {
    const tx = await solanaRpc('getTransaction', [KAT_BURN.burnTx,
      { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]);
    assert.equal(tx.meta.err, null);
    const [feePayer] = tx.transaction.message.accountKeys;
    assert.equal(feePayer.pubkey, KAT_BURN.solanaAddress);
    assert.equal(feePayer.signer, true);
    const burn = tx.transaction.message.instructions.find((ix) => ix.parsed?.type === 'burn');
    assert.equal(burn.parsed.info.mint, DEVNET_1DEV_MINT);
    assert.equal(burn.parsed.info.authority, KAT_BURN.solanaAddress);
    assert.equal(burn.parsed.info.amount, String(BigInt(KAT_BURN.burnAmount) * 10n ** 6n));
    assert.equal(burn.parsed.info.account, core.associatedTokenAddress(KAT_BURN.solanaAddress, DEVNET_1DEV_MINT));
    const memo = tx.transaction.message.instructions.find((ix) => ix.programId === core.SOLANA_PROGRAMS.MEMO);
    assert.equal(memo.parsed, 'QNET_NODE_TYPE:LIGHT');
    assert.equal(core.generateActivationCode('light', feePayer.pubkey, tx.transaction.signatures[0], KAT_BURN.burnAmount),
      KAT_BURN.code);
  });
});

describe('QNet nodes (read-only)', () => {
  it('a recent macroblock QC verifies with ML-DSA-65 against its certified anchor', async () => {
    const { height } = await fromAnyNode('/api/v1/height');
    const j = Math.floor(height / 90) - 2;
    const proof = await fromAnyNode(`/api/v1/macroblock/${j}/proof`);
    const anchor = await fromAnyNode(`/api/v1/macroblock/${j - 2}/proof`);
    const registry = await fromAnyNode(`/api/v1/registry/height/${(j - 2) * 90}`);
    const cp = proof.checkpoint;
    const eligible = core.decodeEligibleNodeIds(core.hexToBytes(anchor.eligible_raw));
    const committee = core.sampleCommittee([...eligible].sort(), j, anchor.checkpoint.beacon);
    const quorum = core.checkpointQuorum(cp, committee);
    assert.notEqual(quorum, null);
    const pubkeys = await core.resolvePubkeys(committee, anchor.checkpoint.registry_root, (j - 2) * 90,
      proof.committee_pubkeys, async () => registry, quorum);
    assert.ok(pubkeys);
    const vote = `QNET_BFT2_VOTE:${core.checkpointHash(cp)}`;
    const valid = new Set();
    for (let i = 0; i < proof.qc.signers.length; i++) {
      const signer = proof.qc.signers[i];
      const sig = core.parseDilithiumSig(proof.qc.sigs[i]);
      if (pubkeys[signer] && sig && await core.verifyConsensusSignature(vote, sig, pubkeys[signer])) valid.add(signer);
    }
    assert.ok(valid.size >= quorum, `valid=${valid.size} quorum=${quorum}`);
    assert.equal(core.epochCommitment(core.hexToBytes(proof.eligible_raw), committee, proof.banned), cp.epoch_commitment);
  });
});

describe('the light client pin of this build (R2-EXTQ-04)', () => {
  it('lags the live head by no more than the walk bound, so a fresh install can QC-check a balance', async () => {
    const { height } = await fromAnyNode('/api/v1/height');
    const head = Math.floor(Number(height) / 90);
    const pin = core.genesisConsensus.WS_CHECKPOINT.index;
    const steps = Math.ceil((head - pin) / 2);
    // qnet.js MAX_QC_WALK_STEPS: the pin lives in qnet-mobile/src/config/genesisConsensus.js; bump it and
    // rebuild the bundle (npm run build) before a release
    assert.ok(steps <= 32, `WS_CHECKPOINT ${pin} is ${steps} walk steps behind the head ${head}`);
  });
});
