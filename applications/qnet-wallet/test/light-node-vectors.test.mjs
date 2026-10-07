// The shared light node vectors (docs/protocols/light-node.vectors.json), the extension's side: the same phrase gives
// the extension the app's wallet key, address and light node id; the bundle's node builders (compiled from the app's
// NodePreimages.js) rebuild the consent, owner bind and claim messages; every vector signature verifies in the node's
// form (ML-DSA-65, empty context), never under the extension's off-chain message context.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as core from '../dist/lib/qnet-core.js';

const V = JSON.parse(readFileSync(new URL('../../../docs/protocols/light-node.vectors.json', import.meta.url), 'utf8'));
const NOBLE = new URL('../tools/crypto-bundle/node_modules/@noble/post-quantum/ml-dsa.js', import.meta.url);
const noble = existsSync(NOBLE) ? await import(NOBLE.href) : null;
const needsNoble = noble ? {} : { skip: 'run npm run bundle:install' };

const { bytesToHex: hex, hexToBytes } = core;
const utf8 = (s) => new TextEncoder().encode(s);
const walletOf = (name) => V.wallets.find((w) => w.name === name);
// The messages the extension builds; the ping-key and device messages belong to the app.
const BUILT = {
  consent: (i) => core.consentPreimage(i.nodeId, i.wallet, i.proof, i.ts),
  ownerBind: (i, w) => core.ownerBindPreimage(i.nodeId, i.wallet, i.proof, i.ts, w.publicKey, i.burnTx),
  claimRewards: (i) => core.claimQuotePreimage(i.nodeId, i.wallet),
  claimPayload: (i) => core.claimPayloadPreimage(i.wallet, i.ts, i.claimsData),
  // the signed status request Recover makes for the burn the registration record names
  statusByWalletKey: (i) => core.statusPreimage(i.nodeId, i.ts),
  // the wallet key's unbind of the node's device (decision 38)
  walletUnbind: (i) => core.walletUnbindPreimage(i.nodeId, i.seq, i.ts),
};

describe('light node vectors: identity', () => {
  for (const w of V.wallets) {
    it(`${w.name}: seed, xi, the full public key, address and light node id`, () => {
      const seed = core.mnemonicToSeed(w.mnemonic);
      assert.equal(hex(seed), w.phraseSeedHex);
      assert.equal(hex(core.walletXi(seed)), w.xi);
      const keys = core.deriveQnetKeypair(seed);
      assert.equal(hex(keys.publicKey), w.publicKey);
      assert.equal(keys.address, w.address);
      assert.equal(core.publicKeySha3(w.publicKey), w.publicKeySha3);
      assert.equal(core.lightNodeId(keys.address), w.nodeId);
      assert.equal(core.sha3_256Hex(utf8(`${V.constants.link.walletHashPrefix}${w.address}`)).slice(0, 16), w.walletHash);
    });
  }

  it('the self-tested KAT wallet is the vectors\' first wallet', () => {
    assert.equal(core.KAT.mnemonic, walletOf('kat-12').mnemonic);
    assert.equal(core.KAT.qnetAddress, walletOf('kat-12').address);
  });
});

describe('light node vectors: the messages the extension builds', () => {
  for (const n of V.node) {
    const w = walletOf(n.wallet);
    it(`${n.wallet}: the proof and every consent, owner bind and claim preimage`, () => {
      assert.equal(core.registrationProof(n.burnTx, n.nodeId, w.address), n.proof);
      assert.equal(hex(core.blake3(utf8(`${n.burnTx}:${n.nodeId}:${w.address}`))).slice(0, 32), n.proof);
      for (const [name, build] of Object.entries(BUILT)) {
        const m = n.messages.find((x) => x.name === name);
        assert.equal(build(m.inputs, w), m.preimage, name);
        assert.equal(core.sha3_256Hex(utf8(m.preimage)), m.preimageSha3, name);
      }
    });

    it(`${n.wallet}: the owner bind verifies under the burner key (Ed25519)`, () => {
      const m = n.messages.find((x) => x.name === 'ownerBind');
      assert.equal(m.inputs.walletPublicKeySha3, w.publicKeySha3);
      assert.equal(core.verifySolanaSignature(hexToBytes(m.signature), utf8(m.preimage), hexToBytes(V.burner.publicKey)), true);
    });

    it(`${n.wallet}: every wallet and ping signature verifies with the empty context only`, needsNoble, () => {
      for (const m of n.messages.filter((x) => x.signer !== 'burner')) {
        const pk = hexToBytes(m.signer === 'wallet' ? w.publicKey : V.pingKey.publicKey);
        const sig = hexToBytes(m.signature);
        assert.equal(noble.ml_dsa65.verify(sig, utf8(m.preimage), pk), true, m.name);
        assert.equal(noble.ml_dsa65.verify(sig, utf8(m.preimage), pk, { context: utf8('QNET_OFFCHAIN_MSG_v1') }), false, m.name);
      }
    });
  }

  it('a signature of the extension\'s own key over the consent verifies as the node checks it', needsNoble, () => {
    const w = walletOf('phrase-24');
    const consent = V.node.find((n) => n.wallet === w.name).messages.find((m) => m.name === 'consent');
    const keys = core.deriveQnetKeypair(core.mnemonicToSeed(w.mnemonic));
    try {
      const sig = noble.ml_dsa65.sign(utf8(consent.preimage), keys.secretKey, { extraEntropy: false });
      assert.equal(hex(sig), consent.signature);
    } finally {
      core.zeroize(keys.secretKey);
    }
  });

  it('the self-test knows the KAT wallet\'s light node id', () => {
    assert.equal(core.KAT.nodeId, walletOf('kat-12').nodeId);
    assert.equal(core.selfTest(), true);
  });

  // The signers keys.js calls: the node id and proof computed inside from the wallet and the burn, the message built by
  // the same builders, the ML-DSA-65 signature in the node's form and the owner bind byte for byte (Ed25519 is
  // deterministic).
  for (const n of V.node) {
    const w = walletOf(n.wallet);
    it(`${n.wallet}: the extension's signers make what the node verifies`, needsNoble, () => {
      const keys = core.deriveQnetKeypair(core.mnemonicToSeed(w.mnemonic));
      const input = (name) => n.messages.find((m) => m.name === name);
      try {
        const consent = input('consent');
        const signed = core.signNodeConsent({ nodeId: n.nodeId, wallet: w.address, burnTx: n.burnTx, ts: consent.inputs.ts }, keys.secretKey, keys.publicKey);
        assert.equal(signed.preimage, consent.preimage);
        assert.equal(signed.proof, n.proof);
        assert.equal(noble.ml_dsa65.verify(signed.signature, utf8(consent.preimage), keys.publicKey), true);
        assert.equal(noble.ml_dsa65.verify(signed.signature, utf8(consent.preimage), keys.publicKey, { context: utf8('QNET_OFFCHAIN_MSG_v1') }), false);

        const bind = input('ownerBind');
        const owner = core.signOwnerBind({ nodeId: n.nodeId, wallet: w.address, burnTx: n.burnTx, ts: bind.inputs.ts }, keys.publicKey,
          hexToBytes(V.burner.seedHex), hexToBytes(V.burner.publicKey));
        assert.equal(owner.preimage, bind.preimage);
        assert.equal(hex(owner.signature), bind.signature);

        const quote = input('claimRewards');
        const q = core.signClaimQuote({ nodeId: n.nodeId, wallet: w.address }, keys.secretKey, keys.publicKey);
        assert.equal(q.preimage, quote.preimage);
        assert.equal(noble.ml_dsa65.verify(q.signature, utf8(quote.preimage), keys.publicKey), true);
        const payload = input('claimPayload');
        const p = core.signClaimPayload({ wallet: w.address, ts: payload.inputs.ts, claimsData: payload.inputs.claimsData }, keys.secretKey, keys.publicKey);
        assert.equal(p.preimage, payload.preimage);
        assert.equal(noble.ml_dsa65.verify(p.signature, utf8(payload.preimage), keys.publicKey), true);

        const status = input('statusByWalletKey');
        const s = core.signNodeStatus({ nodeId: n.nodeId, wallet: w.address, ts: status.inputs.ts }, keys.secretKey, keys.publicKey);
        assert.equal(s.preimage, status.preimage);
        assert.equal(noble.ml_dsa65.verify(s.signature, utf8(status.preimage), keys.publicKey), true);
        assert.equal(noble.ml_dsa65.verify(s.signature, utf8(status.preimage), keys.publicKey, { context: utf8('QNET_OFFCHAIN_MSG_v1') }), false);

        const unbind = input('walletUnbind');
        const u = core.signNodeUnbind({ nodeId: n.nodeId, wallet: w.address, seq: unbind.inputs.seq, ts: unbind.inputs.ts }, keys.secretKey, keys.publicKey);
        assert.equal(u.preimage, unbind.preimage);
        assert.equal(noble.ml_dsa65.verify(u.signature, utf8(unbind.preimage), keys.publicKey), true);
        // the deterministic signature is the vectors' own
        assert.equal(hex(noble.ml_dsa65.sign(utf8(unbind.preimage), keys.secretKey, { extraEntropy: false })), unbind.signature);
        // never the ping form's message, which the device's own key signs
        assert.notEqual(unbind.preimage, n.messages.find((m) => m.name === 'unbind').preimage);
      } finally {
        core.zeroize(keys.secretKey);
      }
    });
  }

  it('the signers refuse another node id, another wallet\'s key and a malformed burn', () => {
    const w = walletOf('kat-12');
    const other = walletOf('phrase-24');
    const n = V.node.find((x) => x.wallet === w.name);
    const keys = core.deriveQnetKeypair(core.mnemonicToSeed(w.mnemonic));
    const code = (fn) => {
      try {
        fn();
      } catch (error) {
        return error.code;
      }
      return 'no error';
    };
    try {
      const message = { nodeId: n.nodeId, wallet: w.address, burnTx: n.burnTx, ts: 1 };
      assert.equal(code(() => core.signNodeConsent({ ...message, nodeId: other.nodeId }, keys.secretKey, keys.publicKey)), 'INVALID_NODE_MESSAGE');
      assert.equal(code(() => core.signNodeConsent({ ...message, burnTx: 'x' }, keys.secretKey, keys.publicKey)), 'INVALID_NODE_MESSAGE');
      assert.equal(code(() => core.signNodeConsent({ ...message, wallet: other.address, nodeId: other.nodeId }, keys.secretKey, keys.publicKey)),
        'KEY_ADDRESS_MISMATCH');
      assert.equal(code(() => core.signClaimQuote({ nodeId: other.nodeId, wallet: w.address }, keys.secretKey, keys.publicKey)), 'INVALID_NODE_MESSAGE');
      assert.equal(code(() => core.signClaimPayload({ wallet: w.address, ts: 1, claimsData: '' }, keys.secretKey, keys.publicKey)), 'INVALID_NODE_MESSAGE');
      assert.equal(code(() => core.signNodeStatus({ nodeId: other.nodeId, wallet: w.address, ts: 1 }, keys.secretKey, keys.publicKey)), 'INVALID_NODE_MESSAGE');
      assert.equal(code(() => core.signNodeStatus({ nodeId: other.nodeId, wallet: other.address, ts: 1 }, keys.secretKey, keys.publicKey)),
        'KEY_ADDRESS_MISMATCH');
      assert.equal(code(() => core.signOwnerBind({ ...message, wallet: other.address, nodeId: other.nodeId }, keys.publicKey,
        hexToBytes(V.burner.seedHex), hexToBytes(V.burner.publicKey))), 'KEY_ADDRESS_MISMATCH');
      // the wallet key's unbind: this wallet's own node, a u64 sequence and time, its own key
      assert.equal(code(() => core.signNodeUnbind({ nodeId: other.nodeId, wallet: w.address, seq: '1', ts: 1 }, keys.secretKey, keys.publicKey)),
        'INVALID_NODE_MESSAGE');
      assert.equal(code(() => core.signNodeUnbind({ nodeId: n.nodeId, wallet: w.address, seq: '-1', ts: 1 }, keys.secretKey, keys.publicKey)),
        'INVALID_NODE_MESSAGE');
      assert.equal(code(() => core.signNodeUnbind({ nodeId: other.nodeId, wallet: other.address, seq: '1', ts: 1 }, keys.secretKey, keys.publicKey)),
        'KEY_ADDRESS_MISMATCH');
    } finally {
      core.zeroize(keys.secretKey);
    }
  });

  it('the builders refuse fields the message does not name', () => {
    const w = walletOf('kat-12');
    const n = V.node[0];
    assert.throws(() => core.consentPreimage(`${n.nodeId}:x`, w.address, n.proof, 1), TypeError);
    assert.throws(() => core.consentPreimage(n.nodeId, w.address, n.proof.slice(1), 1), TypeError);
    assert.throws(() => core.ownerBindPreimage(n.nodeId, w.address, n.proof, 1, w.publicKey, 'not-a-burn'), TypeError);
    assert.throws(() => core.lightNodeId('not an address'), TypeError);
  });
});

// Decision 36, read only when the vectors carry them: QNet Wallet's signed answer to a reserve request verifies through
// the extension's site-record verifier over the reservation text (the envelope the extension's own reservation request
// signs, with the way and burner of the payment address), and neither it nor the payment key's v2 owner bind is a text a
// page's qnet_signMessage can have the wallet sign.
describe('light node vectors: the reserve answer and the v2 owner bind (decision 36)', () => {
  const reserve = (V.link?.cases ?? []).find((c) => c.intent === 'reserve' && JSON.parse(c.plaintext).status === 'ok');
  const bind = V.node.map((n) => n.messages.find((m) => m.name === 'ownerBindV2')).filter(Boolean);

  it('a reserve answer is the wallet\'s signature of the reservation through the payment address', reserve ? {} : { skip: 'no reserve vector' }, () => {
    const answer = JSON.parse(reserve.plaintext);
    assert.deepEqual(Object.keys(answer), ['v', 'intent', 'status', 'qnet', 'time', 'pk', 'sig']);
    assert.equal(V.constants.siteRecord.origin, 'https://aiqnet.io');
    const pk = new Uint8Array(Buffer.from(answer.pk, 'base64url'));
    const sig = new Uint8Array(Buffer.from(answer.sig, 'base64url'));
    assert.equal(core.qnetAddressFromPublicKey(pk), answer.qnet);
    const text = (fields) => ['QNet node reservation v1', `wallet: ${answer.qnet}`, 'node: light', 'way: payment',
      `burner: ${reserve.request.burner}`, `time: ${answer.time}`, 'cluster: devnet', ...fields].join('\n');
    assert.equal(core.verifySiteRecord('https://aiqnet.io', text([]), sig, pk), true);
    assert.equal(core.verifySiteRecord('https://aiqnet.io', text([]).replace('way: payment', 'way: extension'), sig, pk), false);
    assert.equal(core.verifyOffchainMessage('https://aiqnet.io', text([]), sig, pk), false);
    assert.equal(core.hasProtocolPrefix(text([])), true);
  });

  it('the v2 owner bind is a protocol preimage the extension never signs for a page', bind.length > 0 ? {} : { skip: 'no v2 owner bind vector' }, () => {
    for (const m of bind) {
      assert.ok(m.preimage.startsWith('qnet_burn_owner_v2:'), m.preimage);
      assert.equal(core.hasProtocolPrefix(m.preimage), true);
      assert.throws(() => core.buildOffchainMessage('https://aiqnet.io', m.preimage), { code: 'PROTOCOL_PREFIX' });
      assert.throws(() => core.buildSiteRecord('https://aiqnet.io', m.preimage), { code: 'INVALID_MESSAGE' });
      assert.equal(core.verifySolanaSignature(hexToBytes(m.signature), utf8(m.preimage), hexToBytes(V.burner.publicKey)), true);
    }
  });
});
